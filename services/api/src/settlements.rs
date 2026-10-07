//! An archive closes fulfillment and freezes the agreed personal income, without deleting rounds.
use crate::{
    AppState,
    auth::AuthenticatedUser,
    error::{ApiError, ApiJson},
    ledger,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::types::Json as DbJson;
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
pub struct Settlement {
    pub id: Uuid,
    pub mode: String,
    pub original_income_cents: i64,
    pub final_income_cents: i64,
    pub note: String,
    pub archived_at: DateTime<Utc>,
    pub restored_at: Option<DateTime<Utc>>,
    pub original_order: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveInput {
    id: Uuid,
    mode: String,
    final_income_cents: i64,
    note: String,
    expected_updated_at: DateTime<Utc>,
}

fn conflict(message: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "ORDER_SETTLEMENT_CONFLICT", message)
}

pub async fn archive(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    Path(id): Path<Uuid>,
    ApiJson(input): ApiJson<ArchiveInput>,
) -> Result<Json<ledger::ServiceOrder>, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("archive transaction failed"))?;
    // Every round writer takes this same order lock before committing.
    let mut order = ledger::locked_projection(&mut tx, session.user.id, id).await?;
    if order.current_transfer().is_some() {
        return Err(conflict("订单已转出，请在转单记录中结账、退款或撤销"));
    }
    if let Some(previous) = order.settlement_history.iter().find(|s| s.id == input.id) {
        if previous.restored_at.is_none()
            && previous.mode == input.mode
            && previous.final_income_cents == input.final_income_cents
            && previous.note == input.note.trim()
        {
            return Ok(Json(order));
        }
        return Err(conflict("这次结算已处理，请刷新订单后重试"));
    }
    if order.status == "archived" {
        return Err(conflict("订单已归档，请先恢复后再修改结算"));
    }
    if order.updated_at != input.expected_updated_at {
        return Err(conflict("订单已发生变化，请刷新后核对收入再归档"));
    }
    let original = order
        .original_income()
        .ok_or_else(|| ApiError::validation("请先补齐订单总价、人数和抽成，再确认最终收入"))?;
    if !matches!(input.mode.as_str(), "waiver" | "refund" | "completed")
        || !(0..=original).contains(&input.final_income_cents)
        || (input.mode == "waiver" && input.final_income_cents != 0)
        || (input.mode == "refund" && (original == 0 || input.final_income_cents >= original))
        || (input.mode == "completed"
            && (order.remaining_quantity != 0 || input.final_income_cents != original))
    {
        return Err(ApiError::validation(
            "请核对结算方式和最终本人收入；未履约完成的订单请选择免单或部分退款",
        ));
    }
    let note = input.note.trim();
    if note.chars().count() > 1000
        || note
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(ApiError::validation("结算说明最多 1000 个字符"));
    }
    // Avoid recursively copying the old settlement history into every new snapshot.
    let mut snapshot = serde_json::to_value(&order)
        .map_err(|_| ApiError::internal("settlement snapshot failed"))?;
    snapshot
        .as_object_mut()
        .unwrap()
        .remove("settlement_history");
    snapshot.as_object_mut().unwrap().remove("transfer_history");
    let now = Utc::now();
    order.settlement_history.push(Settlement {
        id: input.id,
        mode: input.mode,
        original_income_cents: original,
        final_income_cents: input.final_income_cents,
        note: note.into(),
        archived_at: now,
        restored_at: None,
        original_order: snapshot,
    });
    sqlx::query("UPDATE service_orders SET archived_at=$3,settlement_required=true,settlement_history=$4,updated_at=now() WHERE user_id=$1 AND id=$2")
        .bind(session.user.id).bind(id).bind(now).bind(DbJson(&order.settlement_history)).execute(&mut *tx).await
        .map_err(|_| ApiError::internal("order archive failed"))?;
    let result = ledger::projection_in(&mut tx, session.user.id, id).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("archive commit failed"))?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestoreInput {
    settlement_id: Uuid,
}

pub async fn restore(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    Path(id): Path<Uuid>,
    ApiJson(input): ApiJson<RestoreInput>,
) -> Result<Json<ledger::ServiceOrder>, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("restore transaction failed"))?;
    let mut order = ledger::locked_projection(&mut tx, session.user.id, id).await?;
    if order.current_transfer().is_some() {
        return Err(conflict("订单已转出，只能在未结账时撤销转单"));
    }
    let last = order
        .settlement_history
        .last_mut()
        .ok_or_else(|| conflict("这笔订单没有可恢复的结算"))?;
    if last.id != input.settlement_id {
        return Err(conflict("结算历史已变化，请刷新后重试"));
    }
    if last.restored_at.is_some() {
        return Ok(Json(order));
    }
    last.restored_at = Some(Utc::now());
    sqlx::query("UPDATE service_orders SET archived_at=NULL,settlement_required=true,settlement_history=$3,updated_at=now() WHERE user_id=$1 AND id=$2")
        .bind(session.user.id).bind(id).bind(DbJson(&order.settlement_history)).execute(&mut *tx).await
        .map_err(|_| ApiError::internal("order restore failed"))?;
    let result = ledger::projection_in(&mut tx, session.user.id, id).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("restore commit failed"))?;
    Ok(Json(result))
}
