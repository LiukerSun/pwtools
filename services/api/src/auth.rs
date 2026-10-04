use std::sync::Arc;

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString, rand_core::OsRng},
};
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{StatusCode, header::AUTHORIZATION, request::Parts},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiJson},
    model::{USER_COLUMNS, User, UserRow},
    validation,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterRequest {
    email: String,
    password: String,
    // Released clients may still send this field. Consume it without retaining profile data.
    #[serde(default, rename = "display_name")]
    _legacy_display_name: Option<serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    token: String,
    user: User,
}

#[derive(FromRow)]
struct LoginRow {
    password_hash: String,
    #[sqlx(flatten)]
    user: UserRow,
}

pub async fn hash_password(password: String, workers: Arc<Semaphore>) -> Result<String, ApiError> {
    let permit = workers
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal("password worker unavailable"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| ApiError::internal("password hashing failed"))
    })
    .await
    .map_err(|_| ApiError::internal("password worker interrupted"))?
}

async fn verify_password(
    password: String,
    hash: String,
    workers: Arc<Semaphore>,
) -> Result<bool, ApiError> {
    let permit = workers
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal("password worker unavailable"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let hash = PasswordHash::new(&hash)
            .map_err(|_| ApiError::internal("invalid stored password hash"))?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok())
    })
    .await
    .map_err(|_| ApiError::internal("password worker interrupted"))?
}

fn new_token() -> (String, Vec<u8>) {
    let mut secret = [0u8; 32];
    OsRng.fill_bytes(&mut secret);
    (
        URL_SAFE_NO_PAD.encode(secret),
        Sha256::digest(secret).to_vec(),
    )
}

async fn create_session(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<String, ApiError> {
    let (token, hash) = new_token();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')")
        .bind(hash).bind(user_id).execute(&mut **transaction).await
        .map_err(|_| ApiError::internal("session creation failed"))?;
    Ok(token)
}

pub async fn register(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<RegisterRequest>,
) -> Result<(StatusCode, Json<AuthResponse>), ApiError> {
    let email = validation::email(input.email)?;
    validation::password(&input.password)?;
    let password_hash = hash_password(input.password, state.password_workers.clone()).await?;
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("register transaction failed"))?;
    let query = format!(
        "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) RETURNING {USER_COLUMNS}"
    );
    let row = sqlx::query_as::<_, UserRow>(&query)
        .bind(Uuid::new_v4())
        .bind(email)
        .bind(password_hash)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| {
            if error
                .as_database_error()
                .is_some_and(|database| database.is_unique_violation())
            {
                ApiError::new(
                    StatusCode::CONFLICT,
                    "EMAIL_EXISTS",
                    "这个邮箱已经注册，请直接登录",
                )
            } else {
                ApiError::internal("user registration failed")
            }
        })?;
    let token = create_session(&mut transaction, row.id).await?;
    let user = User::from(row);
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::internal("registration commit failed"))?;
    Ok((StatusCode::CREATED, Json(AuthResponse { token, user })))
}

pub async fn login(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<LoginRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    let email = validation::email(input.email)?;
    validation::password(&input.password)?;
    let query = format!("SELECT {USER_COLUMNS}, password_hash FROM users WHERE email = $1");
    let row = sqlx::query_as::<_, LoginRow>(&query)
        .bind(email)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError::internal("login lookup failed"))?;
    // Unknown accounts still verify against an Argon2 hash to avoid a fast timing oracle.
    let hash = row.as_ref().map_or_else(
        || state.dummy_password_hash.to_string(),
        |row| row.password_hash.clone(),
    );
    let valid = verify_password(input.password, hash, state.password_workers.clone()).await?;
    if !valid || row.is_none() {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_CREDENTIALS",
            "邮箱或密码不正确，请重新输入",
        ));
    }
    let row = row.ok_or_else(ApiError::unauthorized)?;
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("login transaction failed"))?;
    let token = create_session(&mut transaction, row.user.id).await?;
    let user = User::from(row.user);
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::internal("login commit failed"))?;
    Ok(Json(AuthResponse { token, user }))
}

pub struct AuthenticatedUser {
    pub user: User,
    token_hash: Vec<u8>,
}

impl FromRequestParts<AppState> for AuthenticatedUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let secret = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| value.len() == 43)
            .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
            .filter(|value| value.len() == 32)
            .ok_or_else(ApiError::unauthorized)?;
        let token_hash = Sha256::digest(secret).to_vec();
        let query = format!(
            "SELECT {USER_COLUMNS} FROM users WHERE id = (SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now())"
        );
        let row = sqlx::query_as::<_, UserRow>(&query)
            .bind(&token_hash)
            .fetch_optional(&state.pool)
            .await
            .map_err(|_| ApiError::internal("session lookup failed"))?
            .ok_or_else(ApiError::unauthorized)?;
        Ok(Self {
            user: row.into(),
            token_hash,
        })
    }
}

pub async fn me(session: AuthenticatedUser) -> Json<User> {
    Json(session.user)
}

pub async fn logout(
    State(state): State<AppState>,
    session: AuthenticatedUser,
) -> Result<StatusCode, ApiError> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
        .bind(session.token_hash)
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError::internal("session revocation failed"))?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::RegisterRequest;
    use serde_json::json;

    #[test]
    fn registration_needs_only_credentials_and_ignores_released_display_name() {
        for legacy_name in [
            None,
            Some(json!("旧版昵称")),
            Some(json!({"ignored": true})),
        ] {
            let mut body = json!({"email":"account@example.test","password":"long-test-password"});
            if let Some(name) = legacy_name {
                body["display_name"] = name;
            }
            let input: RegisterRequest =
                serde_json::from_value(body).expect("credentials accepted");
            assert_eq!(input.email, "account@example.test");
            assert_eq!(input.password, "long-test-password");
        }
        assert!(serde_json::from_value::<RegisterRequest>(json!({"email":"account@example.test","password":"long-test-password","bio":"not supported"})).is_err());
    }
}
