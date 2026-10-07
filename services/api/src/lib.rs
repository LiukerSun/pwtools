pub mod account_archive;
mod auth;
mod build_attributes;
mod error;
mod ledger;
mod matches;
mod model;
mod ocr;
mod order_templates;
mod rate_limit;
mod rentals;
mod retired_fields;
mod settlements;
pub mod storage;
pub mod storage_migration;
mod transfers;
mod validation;
pub mod weapon_build_codes;

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::Semaphore;
use tower_http::{cors::CorsLayer, limit::RequestBodyLimitLayer, trace::TraceLayer};

use crate::{error::ApiError, ocr::OcrService, rate_limit::AuthRateLimiter};

pub const MAX_BODY_BYTES: usize = 16 * 1024;
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Clone)]
pub struct AppState {
    pool: PgPool,
    password_workers: Arc<Semaphore>,
    dummy_password_hash: Arc<str>,
    auth_rate_limiter: AuthRateLimiter,
    ocr: OcrService,
    storage: storage::Storage,
    build_code_provider: weapon_build_codes::BuildCodeProvider,
}

impl AppState {
    pub async fn new(pool: PgPool) -> anyhow::Result<Self> {
        let ocr_url = std::env::var("OCR_URL").unwrap_or_else(|_| "http://ocr:8090".into());
        let proxies = std::env::var("TRUSTED_PROXY_IPS").unwrap_or_default();
        let auth_rate_limiter = AuthRateLimiter::with_trusted_proxy_ips(&proxies)?;
        let mut state = Self::with_services(pool, &ocr_url, storage::Storage::from_env()?).await?;
        state.auth_rate_limiter = auth_rate_limiter;
        state.build_code_provider = weapon_build_codes::BuildCodeProvider::from_env()?;
        Ok(state)
    }

    pub async fn with_ocr_url(pool: PgPool, ocr_url: &str) -> anyhow::Result<Self> {
        Self::with_services(pool, ocr_url, storage::Storage::database()).await
    }

    pub fn storage(&self) -> storage::Storage {
        self.storage.clone()
    }

    pub fn with_build_code_provider(
        mut self,
        provider: weapon_build_codes::BuildCodeProvider,
    ) -> Self {
        self.build_code_provider = provider;
        self
    }

    pub async fn with_services(
        pool: PgPool,
        ocr_url: &str,
        storage: storage::Storage,
    ) -> anyhow::Result<Self> {
        let password_workers = Arc::new(Semaphore::new(4));
        let dummy_password_hash = auth::hash_password(
            "dummy-account-timing-protection".to_owned(),
            password_workers.clone(),
        )
        .await
        .map_err(|_| anyhow::anyhow!("unable to initialize password verifier"))?;
        Ok(Self {
            pool,
            password_workers,
            dummy_password_hash: dummy_password_hash.into(),
            auth_rate_limiter: AuthRateLimiter::default(),
            ocr: OcrService::new(ocr_url)?,
            storage,
            build_code_provider: weapon_build_codes::BuildCodeProvider::disabled()?,
        })
    }
}

pub async fn connect_database(url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(url)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

pub fn router(state: AppState, allowed_origins: Vec<HeaderValue>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-file-name"),
            header::HeaderName::from_static("x-order-id"),
        ]);
    let auth_routes = Router::new()
        .route("/api/auth/register", post(auth::register))
        .route("/api/auth/login", post(auth::login))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit::middleware,
        ));
    let normal_routes = Router::new()
        .merge(auth_routes)
        .route("/api/health", get(health))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        .route(
            "/api/weapon-build-codes",
            get(weapon_build_codes::list).post(weapon_build_codes::create),
        )
        .route(
            "/api/weapon-build-codes/lookup",
            post(weapon_build_codes::lookup),
        )
        .route(
            "/api/weapon-build-codes/{id}",
            axum::routing::patch(weapon_build_codes::update).delete(weapon_build_codes::delete),
        )
        .route(
            "/api/rental-accounts",
            get(rentals::list_accounts).post(rentals::create_account),
        )
        .route(
            "/api/rental-sessions",
            get(rentals::list_sessions).post(rentals::create_session),
        )
        .route(
            "/api/rental-sessions/{id}/return",
            axum::routing::patch(rentals::return_session),
        )
        .route("/api/rental-sessions/{id}/analysis", get(rentals::analysis))
        .route(
            "/api/order-templates",
            get(order_templates::list).post(order_templates::create),
        )
        .route(
            "/api/order-templates/{id}",
            axum::routing::patch(order_templates::update).delete(order_templates::delete),
        )
        .route(
            "/api/bosses",
            get(ledger::list_bosses).post(ledger::create_boss),
        )
        .route(
            "/api/bosses/{id}",
            get(ledger::get_boss).patch(ledger::update_boss),
        )
        .route("/api/bosses/{id}/orders", post(ledger::create_order))
        .route("/api/orders", get(ledger::list_orders))
        .route("/api/orders/{id}/archive", post(settlements::archive))
        .route("/api/orders/{id}/restore", post(settlements::restore))
        .route("/api/orders/{id}/transfer", post(transfers::create))
        .route("/api/orders/{id}/transfer-action", post(transfers::action))
        .route(
            "/api/orders/{id}",
            get(ledger::get_order).patch(ledger::update_order),
        )
        .route(
            "/api/orders/{id}/entries",
            get(ledger::list_entries).post(ledger::add_entry),
        )
        .route(
            "/api/orders/{order_id}/entries/{entry_id}",
            axum::routing::delete(ledger::delete_entry),
        )
        .route("/api/matches", get(matches::list))
        .route("/api/matches/stats", get(matches::stats))
        .route(
            "/api/matches/settings",
            get(matches::get_settings).patch(matches::set_settings),
        )
        .route(
            "/api/matches/{id}",
            get(matches::get)
                .patch(matches::update)
                .delete(matches::delete),
        )
        .route("/api/matches/{id}/image", get(matches::original_image))
        .route("/api/matches/{id}/thumbnail", get(matches::thumbnail_image))
        .route("/api/matches/{id}/recognize", post(matches::recognize))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES));
    let local_recognition_routes = Router::new()
        .route(
            "/api/matches/{id}/local-recognition",
            post(matches::local_recognition),
        )
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(RequestBodyLimitLayer::new(1024 * 1024));
    let image_json_routes = Router::new()
        .route(
            "/api/weapon-build-codes/recognize-attributes",
            post(weapon_build_codes::recognize_attributes),
        )
        .route("/api/matches/preview-local", post(matches::preview_local))
        .route("/api/matches/confirm", post(matches::confirm_image))
        .layer(DefaultBodyLimit::max(18 * 1024 * 1024))
        .layer(RequestBodyLimitLayer::new(18 * 1024 * 1024));
    let upload_routes = Router::new()
        .route("/api/matches/preview", post(matches::preview))
        .route("/api/matches", post(matches::upload))
        .route("/api/matches/local", post(matches::upload_local))
        .layer(DefaultBodyLimit::max(ocr::MAX_IMAGE_BYTES))
        .layer(RequestBodyLimitLayer::new(ocr::MAX_IMAGE_BYTES));
    normal_routes.merge(upload_routes).merge(local_recognition_routes).merge(image_json_routes)
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "接口不存在") })
        .method_not_allowed_fallback(|| async { ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED", "此接口不支持该请求方式") })
        .layer(middleware::from_fn(normalize_body_limit))
        .layer(cors)
        .layer(middleware::from_fn(no_store))
        // The default trace span includes method and URI, never headers or bodies.
        .layer(TraceLayer::new_for_http().make_span_with(|request: &Request| {
            // Avoid query strings because a caller could put credentials in them.
            tracing::info_span!("http_request", method = %request.method(), path = request.uri().path())
        }))
        .with_state(state)
}

async fn normalize_body_limit(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    if response.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
            "请求内容过大，请缩短后再试",
        )
        .into_response();
    }
    response
}

async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn health(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "DATABASE_UNAVAILABLE",
                "数据库暂时不可用",
            )
        })?;
    Ok(Json(json!({ "status": "ok", "database": "connected" })))
}
