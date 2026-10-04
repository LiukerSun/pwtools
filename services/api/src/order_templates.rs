use axum::{
    Json,
    extract::{Path, State, rejection::PathRejection},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{self, MapAccess, Visitor},
};
use serde_json::{Map, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedUser,
    error::{ApiError, ApiJson},
    ledger::{OrderInput, clean_configuration},
};

// A flat wire format reuses the strict order DTO without serde flatten/deny-unknown ambiguity.
pub struct TemplateInput {
    name: String,
    configuration: OrderInput,
}
impl<'de> Deserialize<'de> for TemplateInput {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct InputVisitor;
        impl<'de> Visitor<'de> for InputVisitor {
            type Value = TemplateInput;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a template name and complete flat order configuration")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut fields = Map::new();
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    if fields.insert(key, value).is_some() {
                        return Err(de::Error::custom("duplicate template field"));
                    }
                }
                let name = fields
                    .remove("name")
                    .ok_or_else(|| de::Error::missing_field("name"))?;
                let name = serde_json::from_value(name).map_err(de::Error::custom)?;
                let configuration =
                    serde_json::from_value(Value::Object(fields)).map_err(de::Error::custom)?;
                Ok(TemplateInput {
                    name,
                    configuration,
                })
            }
        }
        deserializer.deserialize_map(InputVisitor)
    }
}

#[derive(Serialize, FromRow)]
pub struct OrderTemplate {
    id: Uuid,
    name: String,
    #[serde(flatten)]
    #[sqlx(flatten)]
    configuration: OrderInput,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
#[derive(Serialize)]
pub struct TemplateList {
    items: Vec<OrderTemplate>,
}
const COLUMNS: &str = "id,name,title,kind,target_quantity,failure_default_quantity,note,failure_trigger,failure_standard_quantity,failure_mode,wager_item_id,wager_item_name,wager_expected,wager_condition,created_at,updated_at";
fn missing() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "ORDER_TEMPLATE_NOT_FOUND",
        "这个模板不存在或你无权访问",
    )
}
fn path_id(path: Result<Path<Uuid>, PathRejection>) -> Result<Uuid, ApiError> {
    path.map(|Path(id)| id).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_TEMPLATE_ID",
            "模板编号不正确",
        )
    })
}
fn clean_name(name: String) -> Result<String, ApiError> {
    let name = name.trim();
    if !(1..=80).contains(&name.chars().count()) || name.chars().any(char::is_control) {
        return Err(ApiError::validation(
            "模板名称需要1至80个字符，不能包含控制字符",
        ));
    }
    Ok(name.to_owned())
}

pub async fn list(
    State(state): State<AppState>,
    session: AuthenticatedUser,
) -> Result<Json<TemplateList>, ApiError> {
    let items = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM order_templates WHERE user_id=$1 ORDER BY updated_at DESC,id DESC"
    ))
    .bind(session.user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| ApiError::internal("order template listing failed"))?;
    Ok(Json(TemplateList { items }))
}
pub async fn create(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    ApiJson(input): ApiJson<TemplateInput>,
) -> Result<(StatusCode, Json<OrderTemplate>), ApiError> {
    let name = clean_name(input.name)?;
    let c = clean_configuration(input.configuration, None)?;
    let template=sqlx::query_as(&format!("INSERT INTO order_templates(id,user_id,name,title,kind,target_quantity,failure_default_quantity,note,failure_trigger,failure_standard_quantity,failure_mode,wager_item_id,wager_item_name,wager_expected,wager_condition) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING {COLUMNS}"))
        .bind(Uuid::new_v4()).bind(session.user.id).bind(name).bind(c.title).bind(c.kind).bind(c.target_quantity).bind(c.failure_default_quantity).bind(c.note)
        .bind(c.failure_trigger).bind(c.failure_standard_quantity).bind(c.failure_mode).bind(c.wager_item_id).bind(c.wager_item_name).bind(c.wager_expected).bind(c.wager_condition)
        .fetch_one(&state.pool).await.map_err(|_|ApiError::internal("order template creation failed"))?;
    Ok((StatusCode::CREATED, Json(template)))
}
pub async fn update(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<TemplateInput>,
) -> Result<Json<OrderTemplate>, ApiError> {
    let id = path_id(path)?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("order template transaction failed"))?;
    let old = sqlx::query_as::<_, OrderTemplate>(&format!(
        "SELECT {COLUMNS} FROM order_templates WHERE user_id=$1 AND id=$2 FOR UPDATE"
    ))
    .bind(session.user.id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| ApiError::internal("order template lookup failed"))?
    .ok_or_else(missing)?;
    let name = clean_name(input.name)?;
    let old_config = &old.configuration;
    let c = clean_configuration(
        input.configuration,
        Some((
            old_config.kind.as_str(),
            old_config.wager_item_id.as_deref(),
            old_config.wager_item_name.as_str(),
        )),
    )?;
    let template=sqlx::query_as(&format!("UPDATE order_templates SET name=$3,title=$4,kind=$5,target_quantity=$6,failure_default_quantity=$7,note=$8,failure_trigger=$9,failure_standard_quantity=$10,failure_mode=$11,wager_item_id=$12,wager_item_name=$13,wager_expected=$14,wager_condition=$15,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING {COLUMNS}"))
        .bind(session.user.id).bind(id).bind(name).bind(c.title).bind(c.kind).bind(c.target_quantity).bind(c.failure_default_quantity).bind(c.note)
        .bind(c.failure_trigger).bind(c.failure_standard_quantity).bind(c.failure_mode).bind(c.wager_item_id).bind(c.wager_item_name).bind(c.wager_expected).bind(c.wager_condition)
        .fetch_one(&mut *tx).await.map_err(|_|ApiError::internal("order template update failed"))?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("order template commit failed"))?;
    Ok(Json(template))
}
pub async fn delete(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<StatusCode, ApiError> {
    let id = path_id(path)?;
    let result = sqlx::query("DELETE FROM order_templates WHERE user_id=$1 AND id=$2")
        .bind(session.user.id)
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|_| ApiError::internal("order template deletion failed"))?;
    if result.rows_affected() == 0 {
        return Err(missing());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn flat_input_is_strict_and_configuration_does_not_need_a_boss() {
        let input = json!({"name":"  常用小时  ","title":"  两小时  ","kind":"hourly","target_quantity":120,"failure_default_quantity":0,"note":"  约定  "});
        let parsed: TemplateInput = serde_json::from_value(input.clone()).expect("flat DTO");
        assert_eq!(
            clean_name(parsed.name).unwrap_or_else(|_| panic!("valid name")),
            "常用小时"
        );
        let config = clean_configuration(parsed.configuration, None)
            .unwrap_or_else(|_| panic!("no boss needed"));
        assert_eq!(config.title, "两小时");
        assert_eq!(config.note, "约定");
        assert_eq!(config.failure_trigger, "failed");
        let mut unknown = input;
        unknown["boss_id"] = json!(Uuid::new_v4());
        assert!(serde_json::from_value::<TemplateInput>(unknown).is_err());
        assert!(serde_json::from_str::<TemplateInput>(r#"{"name":"a","name":"b"}"#).is_err());
        assert!(clean_name(" ".into()).is_err());
        assert!(clean_name("x".repeat(81)).is_err());
        assert!(clean_name("bad\nname".into()).is_err());
    }
}
