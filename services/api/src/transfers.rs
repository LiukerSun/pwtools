//! Transfer estimates, personal earnings, and confirmed cash movements are separate facts.
use crate::{
    AppState,
    auth::AuthenticatedUser,
    error::{ApiError, ApiJson},
    ledger,
};
use axum::{
    Json,
    extract::{Path, State, rejection::PathRejection},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::types::Json as DbJson;
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
pub struct CashEvent {
    pub id: Uuid,
    pub kind: String,
    pub direction: String,
    pub amount_cents: i64,
    pub note: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Event {
    pub id: Uuid,
    pub action: String,
    pub amount_cents: Option<i64>,
    pub final_income_cents: Option<i64>,
    pub mode: Option<String>,
    pub note: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Transfer {
    pub id: Uuid,
    pub prepaid: bool,
    pub progress_bps: Option<i32>,
    pub progress_numerator: i64,
    pub progress_denominator: i64,
    pub original_income_cents: i64,
    pub expected_income_cents: i64,
    pub expected_cash_cents: i64,
    pub agreed_income_cents: i64,
    pub amount_due_cents: i64,
    pub final_income_cents: Option<i64>,
    pub pending_refund_cents: i64,
    pub status: String,
    pub refund_mode: Option<String>,
    pub note: String,
    pub created_at: DateTime<Utc>,
    pub settled_at: Option<DateTime<Utc>>,
    pub cancelled_at: Option<DateTime<Utc>>,
    pub cash_events: Vec<CashEvent>,
    pub events: Vec<Event>,
    pub original_order: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    id: Uuid,
    prepaid: bool,
    progress_bps: Option<i32>,
    note: String,
    expected_updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionInput {
    id: Uuid,
    transfer_id: Uuid,
    action: String,
    amount_cents: Option<i64>,
    final_income_cents: Option<i64>,
    mode: Option<String>,
    note: String,
    expected_updated_at: DateTime<Utc>,
}

fn conflict(message: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "ORDER_TRANSFER_CONFLICT", message)
}

fn path_id(path: Result<Path<Uuid>, PathRejection>) -> Result<Uuid, ApiError> {
    path.map(|Path(id)| id)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "INVALID_ID", "订单编号不正确"))
}

fn validate_note(note: &str) -> Result<(), ApiError> {
    if note.chars().count() > 1000
        || note
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(ApiError::validation("转单说明最多 1000 个字符"));
    }
    Ok(())
}

fn ratio(kind: &str, completed: i64, total: i64, bps: Option<i32>) -> Result<(i64, i64), ApiError> {
    match bps {
        Some(value) if (0..=10_000).contains(&value) => Ok((i64::from(value), 10_000)),
        Some(_) => Err(ApiError::validation("协商结算进度应在 0% 到 100% 之间")),
        None if kind == "single_round" => Ok((0, 1)),
        None if total == 0 => Ok((1, 1)),
        None => Ok((completed.min(total), total)),
    }
}

fn earned_cents(original: i64, numerator: i64, denominator: i64) -> i64 {
    let denominator = i128::from(denominator);
    ((i128::from(original) * i128::from(numerator) + denominator / 2) / denominator) as i64
}

pub async fn create(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<CreateInput>,
) -> Result<Json<ledger::ServiceOrder>, ApiError> {
    let id = path_id(path)?;
    validate_note(input.note.trim())?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("transfer transaction failed"))?;
    let mut order = ledger::locked_projection(&mut tx, session.user.id, id).await?;
    if let Some(previous) = order
        .transfer_history
        .iter()
        .find(|transfer| transfer.id == input.id)
    {
        // Retrying an old, cancelled request never starts a new transfer.
        if previous.prepaid == input.prepaid
            && previous.progress_bps == input.progress_bps
            && previous.note == input.note.trim()
        {
            return Ok(Json(order));
        }
        return Err(conflict("这次转单已处理，请刷新订单后重试"));
    }
    if order
        .transfer_history
        .iter()
        .any(|transfer| transfer.events.iter().any(|event| event.id == input.id))
    {
        return Err(conflict("请求编号已用于其他转单操作，请刷新后重试"));
    }
    if order.status == "archived" || order.current_transfer().is_some() {
        return Err(conflict("订单已归档或转出，不能重复转单"));
    }
    if order.updated_at != input.expected_updated_at {
        return Err(conflict("订单已发生变化，请刷新后重新核对转单金额"));
    }
    let original = order
        .original_income()
        .ok_or_else(|| ApiError::validation("请先补齐订单总价、人数和抽成，再计算转单"))?;
    let (numerator, denominator) = ratio(
        &order.kind,
        order.completed_quantity,
        order.total_quantity,
        input.progress_bps,
    )?;
    let expected = earned_cents(original, numerator, denominator);
    let cash = if input.prepaid {
        original - expected
    } else {
        expected
    };
    let mut snapshot =
        serde_json::to_value(&order).map_err(|_| ApiError::internal("transfer snapshot failed"))?;
    let snapshot_object = snapshot.as_object_mut().unwrap();
    snapshot_object.remove("settlement_history");
    snapshot_object.remove("transfer_history");
    let now = Utc::now();
    order.transfer_history.push(Transfer {
        id: input.id,
        prepaid: input.prepaid,
        progress_bps: input.progress_bps,
        progress_numerator: numerator,
        progress_denominator: denominator,
        original_income_cents: original,
        expected_income_cents: expected,
        expected_cash_cents: cash,
        agreed_income_cents: expected,
        amount_due_cents: cash,
        final_income_cents: None,
        pending_refund_cents: 0,
        status: "pending".into(),
        refund_mode: None,
        note: input.note.trim().into(),
        created_at: now,
        settled_at: None,
        cancelled_at: None,
        cash_events: vec![],
        events: vec![],
        original_order: snapshot,
    });
    sqlx::query("UPDATE service_orders SET archived_at=$3,settlement_required=true,transfer_history=$4,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2")
        .bind(session.user.id).bind(id).bind(now).bind(DbJson(&order.transfer_history))
        .execute(&mut *tx).await.map_err(|_| ApiError::internal("order transfer failed"))?;
    let result = ledger::projection_in(&mut tx, session.user.id, id).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("transfer commit failed"))?;
    Ok(Json(result))
}

impl Transfer {
    fn refunded_cents(&self) -> i64 {
        self.cash_events
            .iter()
            .filter(|event| event.kind == "refund")
            .map(|event| event.amount_cents)
            .sum()
    }

    fn matches_event(&self, input: &ActionInput, event: &Event) -> bool {
        self.id == input.transfer_id
            && event.action == input.action
            && event.amount_cents == input.amount_cents
            && event.final_income_cents == input.final_income_cents
            && event.mode == input.mode
            && event.note == input.note.trim()
    }

    fn cash(
        &mut self,
        input: &ActionInput,
        kind: &str,
        direction: &str,
        amount: i64,
        now: DateTime<Utc>,
    ) {
        self.cash_events.push(CashEvent {
            id: input.id,
            kind: kind.into(),
            direction: direction.into(),
            amount_cents: amount,
            note: input.note.trim().into(),
            created_at: now,
        });
    }

    fn apply(&mut self, input: &ActionInput, now: DateTime<Utc>) -> Result<(), ApiError> {
        match input.action.as_str() {
            "settle" => {
                if self.status != "pending" {
                    return Err(conflict("这次转单已结束，请刷新后核对结账结果"));
                }
                if input.final_income_cents.is_some() || input.mode.is_some() {
                    return Err(ApiError::validation("结账仅填写本次实际收付金额"));
                }
                let amount = input
                    .amount_cents
                    .ok_or_else(|| ApiError::validation("请填写实际收付金额"))?;
                let available = if self.prepaid {
                    self.original_income_cents - self.refunded_cents() - self.pending_refund_cents
                } else {
                    self.original_income_cents
                };
                if !(0..=available).contains(&amount) {
                    return Err(ApiError::validation("实际收付金额超出本人整单份额"));
                }
                let income = if self.prepaid {
                    available - amount
                } else {
                    amount
                };
                if income > self.agreed_income_cents {
                    return Err(ApiError::validation(
                        "本人实际收益不能高于转单时预计或已调减的收益",
                    ));
                }
                self.agreed_income_cents = income;
                self.final_income_cents = Some(income);
                self.amount_due_cents = 0;
                self.status = "settled".into();
                self.settled_at = Some(now);
                self.cash(
                    input,
                    "settlement",
                    if self.prepaid { "payment" } else { "receipt" },
                    amount,
                    now,
                );
            }
            "cancel" => {
                if input.amount_cents.is_some()
                    || input.final_income_cents.is_some()
                    || input.mode.is_some()
                {
                    return Err(ApiError::validation("撤销转单无需填写金额"));
                }
                if !matches!(self.status.as_str(), "pending" | "waived")
                    || self.settled_at.is_some()
                    || !self.cash_events.is_empty()
                {
                    return Err(conflict("已确认收付的转单不能撤销，请通过退款处理"));
                }
                self.status = "cancelled".into();
                self.cancelled_at = Some(now);
                self.amount_due_cents = 0;
            }
            "refund" => {
                if input.amount_cents.is_some()
                    || !matches!(input.mode.as_deref(), Some("refund" | "waiver"))
                {
                    return Err(ApiError::validation("请填写退款方式和最终本人保留收入"));
                }
                if !matches!(self.status.as_str(), "pending" | "settled") {
                    return Err(conflict("这次转单已取消或免单，不能再次调整收入"));
                }
                let final_income = input
                    .final_income_cents
                    .ok_or_else(|| ApiError::validation("请填写最终本人保留收入"))?;
                let waiver = input.mode.as_deref() == Some("waiver");
                let before = self.final_income_cents.unwrap_or(self.agreed_income_cents);
                if !(0..=before).contains(&final_income)
                    || (waiver && final_income != 0)
                    || (!waiver && final_income >= before)
                {
                    return Err(ApiError::validation(
                        "退款后保留收入必须降低，免单后保留收入必须为 0",
                    ));
                }
                if self.status == "settled" {
                    self.pending_refund_cents += before - final_income;
                    self.final_income_cents = Some(final_income);
                } else if waiver {
                    // Nothing was sent to the next team: the prepaid original share is still held.
                    self.pending_refund_cents = if self.prepaid {
                        self.original_income_cents - self.refunded_cents()
                    } else {
                        0
                    };
                    self.final_income_cents = Some(0);
                } else if self.prepaid {
                    // Money retained for the original payer must never be added to the next team's fee.
                    self.pending_refund_cents += before - final_income;
                } else {
                    self.amount_due_cents = final_income;
                }
                self.agreed_income_cents = final_income;
                self.refund_mode = input.mode.clone();
                if waiver {
                    self.status = "waived".into();
                    self.amount_due_cents = 0;
                }
            }
            "confirm_refund" => {
                if input.amount_cents.is_some()
                    || input.final_income_cents.is_some()
                    || input.mode.is_some()
                {
                    return Err(ApiError::validation("确认退款无需重复填写金额"));
                }
                if self.pending_refund_cents <= 0
                    || !matches!(self.status.as_str(), "pending" | "settled" | "waived")
                {
                    return Err(conflict("没有待确认的退款支出"));
                }
                self.cash(input, "refund", "payment", self.pending_refund_cents, now);
                self.pending_refund_cents = 0;
            }
            _ => return Err(ApiError::validation("不支持的转单操作")),
        }
        self.events.push(Event {
            id: input.id,
            action: input.action.clone(),
            amount_cents: input.amount_cents,
            final_income_cents: input.final_income_cents,
            mode: input.mode.clone(),
            note: input.note.trim().into(),
            created_at: now,
        });
        Ok(())
    }
}

pub async fn action(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<ActionInput>,
) -> Result<Json<ledger::ServiceOrder>, ApiError> {
    let id = path_id(path)?;
    validate_note(input.note.trim())?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("transfer action transaction failed"))?;
    let mut order = ledger::locked_projection(&mut tx, session.user.id, id).await?;
    for transfer in &order.transfer_history {
        if let Some(event) = transfer.events.iter().find(|event| event.id == input.id) {
            if transfer.matches_event(&input, event) {
                return Ok(Json(order));
            }
            return Err(conflict("这次转单操作已处理，请刷新后重试"));
        }
        if transfer.id == input.id {
            return Err(conflict("请求编号已用于创建转单，请刷新后重试"));
        }
    }
    if order.updated_at != input.expected_updated_at {
        return Err(conflict("订单已发生变化，请刷新后核对转单记录"));
    }
    let transfer = order
        .transfer_history
        .last_mut()
        .filter(|transfer| transfer.id == input.transfer_id && transfer.cancelled_at.is_none())
        .ok_or_else(|| conflict("当前转单已变化，请刷新订单后重试"))?;
    transfer.apply(&input, Utc::now())?;
    let archived_at = if transfer.cancelled_at.is_some() {
        None
    } else {
        Some(transfer.created_at)
    };
    let settlement_required = if transfer.cancelled_at.is_some() {
        transfer.original_order["settlement_required"]
            .as_bool()
            .unwrap_or(false)
    } else {
        true
    };
    sqlx::query("UPDATE service_orders SET archived_at=$3,settlement_required=$4,transfer_history=$5,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2")
        .bind(session.user.id).bind(id).bind(archived_at).bind(settlement_required).bind(DbJson(&order.transfer_history))
        .execute(&mut *tx).await.map_err(|_| ApiError::internal("transfer action failed"))?;
    let result = ledger::projection_in(&mut tx, session.user.id, id).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("transfer action commit failed"))?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transfer(prepaid: bool) -> Transfer {
        Transfer {
            id: Uuid::new_v4(),
            prepaid,
            progress_bps: None,
            progress_numerator: 1,
            progress_denominator: 2,
            original_income_cents: 39_920,
            expected_income_cents: 19_960,
            expected_cash_cents: 19_960,
            agreed_income_cents: 19_960,
            amount_due_cents: 19_960,
            final_income_cents: None,
            pending_refund_cents: 0,
            status: "pending".into(),
            refund_mode: None,
            note: String::new(),
            created_at: Utc::now(),
            settled_at: None,
            cancelled_at: None,
            cash_events: vec![],
            events: vec![],
            original_order: serde_json::json!({"settlement_required":false}),
        }
    }

    fn action(
        transfer: &Transfer,
        action: &str,
        amount: Option<i64>,
        retained: Option<i64>,
        mode: Option<&str>,
    ) -> ActionInput {
        ActionInput {
            id: Uuid::new_v4(),
            transfer_id: transfer.id,
            action: action.into(),
            amount_cents: amount,
            final_income_cents: retained,
            mode: mode.map(str::to_owned),
            note: String::new(),
            expected_updated_at: Utc::now(),
        }
    }

    fn apply(transfer: &mut Transfer, action: ActionInput) {
        assert!(transfer.apply(&action, Utc::now()).is_ok());
    }

    #[test]
    fn transfer_progress_uses_exact_ratio_and_single_round_requires_negotiation() {
        let (n, d) = ratio("escort", 1, 3, None).ok().unwrap();
        assert_eq!(earned_cents(39_920, n, d), 13_307);
        assert_eq!(ratio("single_round", 500, 1000, None).ok(), Some((0, 1)));
        assert_eq!(
            ratio("single_round", 500, 1000, Some(5000)).ok(),
            Some((5000, 10_000))
        );
        assert_eq!(ratio("escort", 2000, 1000, None).ok(), Some((1000, 1000)));
        assert_eq!(ratio("hourly", 10, 0, None).ok(), Some((1, 1)));
        assert!(ratio("hourly", 1, 2, Some(10_001)).is_err());
        assert_eq!(
            earned_cents(1_000_000_000_000, 8_999_999_999_999, 9_000_000_000_000),
            1_000_000_000_000
        );
    }

    #[test]
    fn both_cash_directions_recognize_only_the_persons_earned_share() {
        for prepaid in [false, true] {
            let mut transfer = transfer(prepaid);
            let amount = if prepaid { 21_920 } else { 18_000 };
            let input = action(&transfer, "settle", Some(amount), None, None);
            apply(&mut transfer, input);
            assert_eq!(transfer.final_income_cents, Some(18_000));
            assert_eq!(transfer.cash_events[0].amount_cents, amount);
            assert_eq!(
                transfer.cash_events[0].direction,
                if prepaid { "payment" } else { "receipt" }
            );
            let input = action(&transfer, "cancel", None, None, None);
            assert!(transfer.apply(&input, Utc::now()).is_err());
        }
    }

    #[test]
    fn settlement_cannot_increase_earnings_or_produce_negative_earnings() {
        for (prepaid, amounts) in [(false, [19_961, -1]), (true, [19_959, 39_921])] {
            for amount in amounts {
                let mut transfer = transfer(prepaid);
                let input = action(&transfer, "settle", Some(amount), None, None);
                assert!(transfer.apply(&input, Utc::now()).is_err());
                assert!(transfer.cash_events.is_empty());
                assert!(transfer.final_income_cents.is_none());
            }
        }
    }

    #[test]
    fn unsettled_waiver_cancels_receivable_or_refunds_whole_prepaid_share() {
        for prepaid in [false, true] {
            let mut transfer = transfer(prepaid);
            let input = action(&transfer, "refund", None, Some(0), Some("waiver"));
            apply(&mut transfer, input);
            assert_eq!(transfer.final_income_cents, Some(0));
            assert_eq!(transfer.amount_due_cents, 0);
            assert_eq!(
                transfer.pending_refund_cents,
                if prepaid { 39_920 } else { 0 }
            );
            assert!(transfer.cash_events.is_empty());
            if prepaid {
                let input = action(&transfer, "confirm_refund", None, None, None);
                apply(&mut transfer, input);
                assert_eq!(transfer.cash_events[0].amount_cents, 39_920);
                assert_eq!(transfer.pending_refund_cents, 0);
                assert_eq!(transfer.final_income_cents, Some(0));
            }
        }
    }

    #[test]
    fn successive_refunds_reduce_income_once_and_only_confirmed_refunds_are_cash() {
        for prepaid in [false, true] {
            let mut transfer = transfer(prepaid);
            let input = action(&transfer, "settle", Some(19_960), None, None);
            apply(&mut transfer, input);
            for retained in [15_000, 12_000] {
                let input = action(&transfer, "refund", None, Some(retained), Some("refund"));
                apply(&mut transfer, input);
            }
            assert_eq!(transfer.pending_refund_cents, 7_960);
            assert_eq!(transfer.cash_events.len(), 1);
            let input = action(&transfer, "confirm_refund", None, None, None);
            apply(&mut transfer, input);
            assert_eq!(transfer.cash_events[1].amount_cents, 7_960);
            assert_eq!(transfer.final_income_cents, Some(12_000));
            let input = action(&transfer, "refund", None, Some(0), Some("waiver"));
            apply(&mut transfer, input);
            assert_eq!(transfer.pending_refund_cents, 12_000);
            assert_eq!(transfer.final_income_cents, Some(0));
            assert_eq!(transfer.cash_events.len(), 2);
        }
    }

    #[test]
    fn pending_refund_changes_estimate_and_remains_cancellable() {
        for prepaid in [false, true] {
            let mut transfer = transfer(prepaid);
            let input = action(&transfer, "refund", None, Some(10_000), Some("refund"));
            apply(&mut transfer, input);
            assert_eq!(transfer.expected_income_cents, 19_960);
            assert_eq!(
                transfer.amount_due_cents,
                if prepaid { 19_960 } else { 10_000 }
            );
            assert_eq!(transfer.final_income_cents, None);
            assert_eq!(
                transfer.pending_refund_cents,
                if prepaid { 9_960 } else { 0 }
            );
            let input = action(&transfer, "cancel", None, None, None);
            apply(&mut transfer, input);
            assert!(transfer.cancelled_at.is_some());
            assert!(transfer.cash_events.is_empty());
        }
    }

    #[test]
    fn prepaid_refund_before_settlement_does_not_increase_next_teams_fee() {
        for confirm_first in [false, true] {
            let mut transfer = transfer(true);
            let input = action(&transfer, "refund", None, Some(15_000), Some("refund"));
            apply(&mut transfer, input);
            assert_eq!(transfer.amount_due_cents, 19_960);
            assert_eq!(transfer.pending_refund_cents, 4_960);
            assert_eq!(transfer.final_income_cents, None);
            if confirm_first {
                let input = action(&transfer, "confirm_refund", None, None, None);
                apply(&mut transfer, input);
            }
            let input = action(&transfer, "settle", Some(19_960), None, None);
            apply(&mut transfer, input);
            assert_eq!(transfer.final_income_cents, Some(15_000));
            let input = action(&transfer, "refund", None, Some(0), Some("waiver"));
            apply(&mut transfer, input);
            assert_eq!(
                transfer.pending_refund_cents,
                if confirm_first { 15_000 } else { 19_960 }
            );
        }
    }

    #[test]
    fn waiver_after_early_refund_returns_only_money_still_held() {
        let mut transfer = transfer(true);
        let input = action(&transfer, "refund", None, Some(15_000), Some("refund"));
        apply(&mut transfer, input);
        let input = action(&transfer, "confirm_refund", None, None, None);
        apply(&mut transfer, input);
        let input = action(&transfer, "cancel", None, None, None);
        assert!(transfer.apply(&input, Utc::now()).is_err());
        let input = action(&transfer, "refund", None, Some(0), Some("waiver"));
        apply(&mut transfer, input);
        assert_eq!(transfer.pending_refund_cents, 34_960);
        let input = action(&transfer, "confirm_refund", None, None, None);
        apply(&mut transfer, input);
        assert_eq!(transfer.refunded_cents(), 39_920);
        assert_eq!(transfer.final_income_cents, Some(0));
    }

    #[test]
    fn waiver_can_be_cancelled_until_any_cash_confirmation() {
        for prepaid in [false, true] {
            let mut transfer = transfer(prepaid);
            let input = action(&transfer, "refund", None, Some(0), Some("waiver"));
            apply(&mut transfer, input);
            let input = action(&transfer, "cancel", None, None, None);
            apply(&mut transfer, input);
            assert!(transfer.cancelled_at.is_some());
        }
    }
}
