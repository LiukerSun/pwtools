use crate::{
    AppState,
    auth::AuthenticatedUser,
    error::{ApiError, ApiJson},
};
use axum::{
    Json,
    extract::{Path, State, rejection::PathRejection},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;
use uuid::Uuid;

const COLUMNS: &str =
    "id,weapon_name,mode,code,note,attributes,lookup_status,created_at,updated_at";
const PROVIDER_URL: &str = "https://orzice.com/workApi/v1/sjz_api/gun_gqm_v2";

#[derive(Clone)]
pub struct BuildCodeProvider {
    token: Arc<str>,
    url: Arc<str>,
    client: reqwest::Client,
    gate: Arc<Mutex<()>>,
}
impl BuildCodeProvider {
    pub fn new(token: String, url: String) -> anyhow::Result<Self> {
        Ok(Self {
            token: token.into(),
            url: url.into(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(8))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            gate: Arc::new(Mutex::new(())),
        })
    }
    pub fn from_env() -> anyhow::Result<Self> {
        Self::new(
            std::env::var("BUILD_CODE_API_TOKEN")
                .unwrap_or_default()
                .trim()
                .to_owned(),
            PROVIDER_URL.to_owned(),
        )
    }
    pub fn disabled() -> anyhow::Result<Self> {
        Self::new(String::new(), PROVIDER_URL.to_owned())
    }

    async fn catalog(
        &self,
        pool: &sqlx::PgPool,
        weapon: &str,
        mode: &str,
    ) -> Result<(Value, DateTime<Utc>), ()> {
        // Hold a process-wide gate, then recheck PostgreSQL so concurrent saves share a request.
        let _guard = self.gate.lock().await;
        let cached: Option<(Value, DateTime<Utc>)> = sqlx::query_as("SELECT items,fetched_at FROM weapon_build_code_catalog WHERE mode=$1 AND weapon_name=$2 AND fetched_at > now()-interval '6 hours'")
            .bind(mode).bind(weapon).fetch_optional(pool).await.map_err(|_| ())?;
        if let Some(items) = cached {
            return Ok(items);
        }
        let mut items = Vec::new();
        let mut page = 1;
        loop {
            let mut response = self
                .client
                .get(self.url.as_ref())
                .query(&[
                    ("token", self.token.as_ref()),
                    ("key1", "全部"),
                    ("key2", "全部"),
                    (
                        "solutionType",
                        if mode == "烽火地带" {
                            "gun"
                        } else {
                            "operator"
                        },
                    ),
                    ("n", weapon),
                    ("p", &page.to_string()),
                ])
                .send()
                .await
                .map_err(|_| ())?;
            if !response.status().is_success()
                || response
                    .content_length()
                    .is_some_and(|size| size > 2_000_000)
            {
                return Err(());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
                if bytes.len() + chunk.len() > 2_000_000 {
                    return Err(());
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
            if body["code"] != 0 {
                return Err(());
            }
            let records = body["data"].as_array().ok_or(())?;
            let count = body["count"].as_u64().ok_or(())? as usize;
            if count > 1200 {
                return Err(());
            }
            if records.is_empty() {
                if items.len() < count {
                    return Err(());
                }
                break;
            }
            items.extend(records.iter().cloned());
            if items.len() >= count {
                break;
            }
            page += 1;
            if page > 100 {
                return Err(());
            }
        }
        let items = Value::Array(items);
        let fetched_at = Utc::now();
        let fetched_at: DateTime<Utc> = sqlx::query_scalar("INSERT INTO weapon_build_code_catalog(mode,weapon_name,items,fetched_at) VALUES($1,$2,$3,$4) ON CONFLICT(mode,weapon_name) DO UPDATE SET items=excluded.items,fetched_at=excluded.fetched_at RETURNING fetched_at")
            .bind(mode).bind(weapon).bind(&items).bind(fetched_at).fetch_one(pool).await.map_err(|_| ())?;
        Ok((items, fetched_at))
    }
    async fn lookup(&self, pool: &sqlx::PgPool, input: &CleanInput) -> Lookup {
        if self.token.is_empty() {
            return Lookup {
                status: "not_configured".into(),
                attributes: None,
            };
        }
        // A whole lookup, including queue wait and pagination, fits desktop/browser timeouts.
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            self.catalog(pool, &input.weapon_name, &input.mode),
        )
        .await;
        match result {
            Ok(Ok((items, fetched_at))) => match matching_attributes(&items, input, fetched_at) {
                Some(attributes) => Lookup {
                    status: "matched".into(),
                    attributes: Some(attributes),
                },
                None => Lookup {
                    status: "unmatched".into(),
                    attributes: None,
                },
            },
            _ => Lookup {
                status: "unavailable".into(),
                attributes: None,
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildCodeInput {
    code: String,
    #[serde(default)]
    weapon_name: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    note: String,
}
struct CleanInput {
    code: String,
    core_code: String,
    weapon_name: String,
    mode: String,
    note: String,
}
fn valid_core(code: &str) -> bool {
    (8..=64).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric())
}
fn clean(input: BuildCodeInput) -> Result<CleanInput, ApiError> {
    let code = input.code.trim();
    if code.len() > 768 || code.chars().count() > 256 || code.chars().any(char::is_control) {
        return Err(ApiError::validation("改枪码过长或包含控制字符"));
    }
    let (weapon, mode, core) = if valid_core(code) {
        (input.weapon_name.trim(), input.mode.trim(), code)
    } else {
        let mut parts = code.rsplitn(3, '-');
        let core = parts.next().unwrap_or("").trim();
        let mode = parts.next().unwrap_or("").trim();
        let weapon = parts.next().unwrap_or("").trim();
        (weapon, mode, core)
    };
    if !valid_core(core) {
        return Err(ApiError::validation("编码段需要8至64位字母或数字"));
    }
    if !(1..=100).contains(&weapon.chars().count()) || weapon.chars().any(char::is_control) {
        return Err(ApiError::validation("请填写武器名称（最多100字）"));
    }
    if !["烽火地带", "全面战场"].contains(&mode) {
        return Err(ApiError::validation("请选择烽火地带或全面战场"));
    }
    let note = input.note.trim();
    if note.chars().count() > 2000
        || note
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(ApiError::validation("备注最多2000字，不能包含异常控制字符"));
    }
    Ok(CleanInput {
        code: code.into(),
        core_code: core.into(),
        weapon_name: weapon.into(),
        mode: mode.into(),
        note: note.into(),
    })
}

fn matching_attributes(
    items: &Value,
    input: &CleanInput,
    fetched_at: DateTime<Utc>,
) -> Option<Value> {
    let item = items.as_array()?.iter().find(|item| {
        let core = item["solutionCode"]
            .as_str()
            .unwrap_or("")
            .rsplit('-')
            .next()
            .unwrap_or("")
            .trim();
        core == input.core_code
            && item["objectName"].as_str() == Some(&input.weapon_name)
            && item["solutionType"].as_str()
                == Some(if input.mode == "烽火地带" {
                    "gun"
                } else {
                    "operator"
                })
    })?;
    let properties: Vec<Value> = item["properties_data"]
        .as_array()?
        .iter()
        .filter_map(|p| {
            let name = p["name"].as_str()?;
            let value = p["value"].as_f64()?;
            if ![
                "肉伤",
                "甲伤",
                "射速",
                "射程",
                "后座",
                "操控",
                "稳定性",
                "腰射",
            ]
            .contains(&name)
                || !value.is_finite()
            {
                return None;
            }
            let change = p["change"]
                .as_str()
                .unwrap_or("-")
                .chars()
                .take(24)
                .collect::<String>();
            Some(json!({"name":name,"value":value,"change":change}))
        })
        .collect();
    if properties.is_empty() {
        return None;
    }
    Some(
        json!({"source":"三角洲数据帝","fetched_at":fetched_at,"provider_id":item["id"].as_i64(),"price":item["price"].as_i64().filter(|n| *n >= 0),"properties":properties}),
    )
}

#[derive(Serialize)]
pub struct Lookup {
    status: String,
    attributes: Option<Value>,
}
#[derive(Serialize, FromRow)]
pub struct BuildCode {
    id: Uuid,
    weapon_name: String,
    mode: String,
    code: String,
    note: String,
    attributes: Option<Value>,
    lookup_status: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
#[derive(Serialize)]
pub struct BuildCodeList {
    items: Vec<BuildCode>,
}
fn missing() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "BUILD_CODE_NOT_FOUND",
        "改枪码不存在或你无权访问",
    )
}
fn path_id(path: Result<Path<Uuid>, PathRejection>) -> Result<Uuid, ApiError> {
    path.map(|Path(id)| id)
        .map_err(|_| ApiError::validation("改枪码编号不正确"))
}

pub async fn list(
    State(state): State<AppState>,
    session: AuthenticatedUser,
) -> Result<Json<BuildCodeList>, ApiError> {
    let items = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM weapon_build_codes WHERE user_id=$1 ORDER BY updated_at DESC,id DESC"
    ))
    .bind(session.user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| ApiError::internal("build code listing failed"))?;
    Ok(Json(BuildCodeList { items }))
}
pub async fn lookup(
    State(state): State<AppState>,
    _session: AuthenticatedUser,
    ApiJson(input): ApiJson<BuildCodeInput>,
) -> Result<Json<Lookup>, ApiError> {
    let input = clean(input)?;
    Ok(Json(
        state.build_code_provider.lookup(&state.pool, &input).await,
    ))
}
pub async fn create(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    ApiJson(input): ApiJson<BuildCodeInput>,
) -> Result<(StatusCode, Json<BuildCode>), ApiError> {
    let input = clean(input)?;
    let found = state.build_code_provider.lookup(&state.pool, &input).await;
    let result = sqlx::query_as(&format!("INSERT INTO weapon_build_codes(id,user_id,weapon_name,mode,code,core_code,note,attributes,lookup_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING {COLUMNS}"))
        .bind(Uuid::new_v4()).bind(session.user.id).bind(input.weapon_name).bind(input.mode).bind(input.code).bind(input.core_code).bind(input.note).bind(found.attributes).bind(found.status)
        .fetch_one(&state.pool).await.map_err(|_| ApiError::internal("build code creation failed"))?;
    Ok((StatusCode::CREATED, Json(result)))
}
pub async fn update(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<BuildCodeInput>,
) -> Result<Json<BuildCode>, ApiError> {
    let id = path_id(path)?;
    let previous = sqlx::query_as::<_, BuildCode>(&format!(
        "SELECT {COLUMNS} FROM weapon_build_codes WHERE user_id=$1 AND id=$2"
    ))
    .bind(session.user.id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| ApiError::internal("build code lookup failed"))?
    .ok_or_else(missing)?;
    let input = clean(input)?;
    let mut found = state.build_code_provider.lookup(&state.pool, &input).await;
    // A provider outage must not erase a previously fetched snapshot when only notes change.
    if matches!(found.status.as_str(), "unavailable" | "not_configured")
        && previous.weapon_name == input.weapon_name
        && previous.mode == input.mode
        && previous.code.rsplit('-').next().unwrap_or("").trim() == input.core_code
        && previous.attributes.is_some()
    {
        found.attributes = previous.attributes;
        found.status = previous.lookup_status;
    }
    let result = sqlx::query_as(&format!("UPDATE weapon_build_codes SET weapon_name=$3,mode=$4,code=$5,core_code=$6,note=$7,attributes=$8,lookup_status=$9,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING {COLUMNS}"))
        .bind(session.user.id).bind(id).bind(input.weapon_name).bind(input.mode).bind(input.code).bind(input.core_code).bind(input.note).bind(found.attributes).bind(found.status)
        .fetch_optional(&state.pool).await.map_err(|_| ApiError::internal("build code update failed"))?.ok_or_else(missing)?;
    Ok(Json(result))
}
pub async fn delete(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<StatusCode, ApiError> {
    let result = sqlx::query("DELETE FROM weapon_build_codes WHERE user_id=$1 AND id=$2")
        .bind(session.user.id)
        .bind(path_id(path)?)
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError::internal("build code deletion failed"))?;
    if result.rows_affected() == 0 {
        return Err(missing());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(code: &str) -> BuildCodeInput {
        BuildCodeInput {
            code: code.into(),
            weapon_name: "汤姆逊冲锋枪".into(),
            mode: "烽火地带".into(),
            note: String::new(),
        }
    }
    #[test]
    fn parses_hyphens_and_core() {
        let parsed = clean(input(" PTR-32突击步枪-全面战场-6EIAKTC02U9HU6AC38CQJ "))
            .ok()
            .unwrap();
        assert_eq!(parsed.weapon_name, "PTR-32突击步枪");
        assert_eq!(parsed.mode, "全面战场");
        assert_eq!(
            clean(input("6L79CCC0BK4JN1CPUVQAH"))
                .ok()
                .unwrap()
                .weapon_name,
            "汤姆逊冲锋枪"
        );
        for code in [
            "bad",
            "武器-错误模式-ABCDEFGH",
            "武器-烽火地带-ABCD%EFGH",
            "武器-烽火地带-ABCDEFGH\nX",
        ] {
            assert!(clean(input(code)).is_err());
        }
    }
    #[test]
    fn matches_exact_weapon_mode_and_core() {
        let parsed = clean(input("6L79CCC0BK4JN1CPUVQAH")).ok().unwrap();
        let item = json!({"solutionCode":parsed.code,"objectName":parsed.weapon_name,"solutionType":"gun","properties_data":[{"name":"射程","value":25,"change":"+5"}],"price":219453,"zb":999});
        let attrs = matching_attributes(&json!([item.clone()]), &parsed, Utc::now()).unwrap();
        assert!(attrs.get("zb").is_none());
        assert_eq!(attrs["properties"][0]["value"], 25.0);
        let mut other = item;
        other["objectName"] = json!("其他武器");
        assert!(matching_attributes(&json!([other]), &parsed, Utc::now()).is_none());
    }
}
