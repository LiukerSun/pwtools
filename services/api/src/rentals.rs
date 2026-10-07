use axum::{
    Json,
    extract::{Path, State, rejection::PathRejection},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedUser,
    error::{ApiError, ApiJson},
    ledger,
    ocr::MAX_AMOUNT,
};

pub(crate) const MAX_CENTS: i64 = 1_000_000_000_000;

fn missing() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "RENTAL_NOT_FOUND",
        "租号记录不存在或你无权访问",
    )
}
fn path_id(path: Result<Path<Uuid>, PathRejection>) -> Result<Uuid, ApiError> {
    path.map(|Path(id)| id)
        .map_err(|_| ApiError::validation("租号记录编号不正确"))
}
fn clean_text(value: &str, max: usize, required: bool) -> Result<String, ApiError> {
    let value = value.trim();
    if (required && value.is_empty())
        || value.chars().count() > max
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(ApiError::validation("账号名称或备注长度不正确"));
    }
    Ok(value.to_owned())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountInput {
    id: Uuid,
    name: String,
    note: String,
}
#[derive(Serialize, FromRow)]
pub struct RentalAccount {
    id: Uuid,
    name: String,
    note: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
const ACCOUNT_COLUMNS: &str = "id,name,note,created_at,updated_at";

pub async fn list_accounts(
    State(state): State<AppState>,
    session: AuthenticatedUser,
) -> Result<Json<ledger::Items<RentalAccount>>, ApiError> {
    let items = sqlx::query_as(&format!(
        "SELECT {ACCOUNT_COLUMNS} FROM rental_accounts WHERE user_id=$1 ORDER BY created_at DESC,id"
    ))
    .bind(session.user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| ApiError::internal("rental accounts lookup failed"))?;
    Ok(Json(ledger::Items { items }))
}
pub async fn create_account(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    ApiJson(input): ApiJson<AccountInput>,
) -> Result<(StatusCode, Json<RentalAccount>), ApiError> {
    let name = clean_text(&input.name, 80, true)?;
    let note = clean_text(&input.note, 2000, false)?;
    sqlx::query("INSERT INTO rental_accounts(id,user_id,name,note) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(input.id).bind(session.user.id).bind(&name).bind(&note).execute(&state.pool).await.map_err(|_| ApiError::internal("rental account creation failed"))?;
    let result: RentalAccount = sqlx::query_as(&format!(
        "SELECT {ACCOUNT_COLUMNS} FROM rental_accounts WHERE user_id=$1 AND id=$2"
    ))
    .bind(session.user.id)
    .bind(input.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| ApiError::internal("rental account lookup failed"))?
    .ok_or_else(missing)?;
    if result.name != name || result.note != note {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "IDEMPOTENCY_CONFLICT",
            "这次添加已保存其他内容，请重新打开表单",
        ));
    }
    Ok((StatusCode::CREATED, Json(result)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionInput {
    id: Uuid,
    account_id: Uuid,
    coin_per_yuan: i64,
    aw_price: i64,
    helmet_price: i64,
    armor_price: i64,
    initial_coins: i64,
    deposit_cents: i64,
    started_at: DateTime<Utc>,
    note: String,
}
#[derive(Serialize, FromRow)]
pub struct RentalSession {
    id: Uuid,
    account_id: Uuid,
    account_name: String,
    coin_per_yuan: i64,
    aw_price: i64,
    helmet_price: i64,
    armor_price: i64,
    initial_coins: i64,
    deposit_cents: i64,
    final_cost_cents: Option<i64>,
    started_at: DateTime<Utc>,
    returned_at: Option<DateTime<Utc>>,
    note: String,
    round_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
const SESSION_QUERY: &str = "SELECT s.id,s.account_id,a.name AS account_name,s.coin_per_yuan,s.aw_price,s.helmet_price,s.armor_price,s.initial_coins,s.deposit_cents,s.final_cost_cents,s.started_at,s.returned_at,s.note,s.created_at,s.updated_at,(SELECT count(*) FROM rental_rounds r WHERE r.user_id=s.user_id AND r.rental_session_id=s.id) AS round_count FROM rental_sessions s JOIN rental_accounts a ON a.user_id=s.user_id AND a.id=s.account_id";

pub async fn list_sessions(
    State(state): State<AppState>,
    session: AuthenticatedUser,
) -> Result<Json<ledger::Items<RentalSession>>, ApiError> {
    let items = sqlx::query_as(&format!(
        "{SESSION_QUERY} WHERE s.user_id=$1 ORDER BY s.started_at DESC,s.id"
    ))
    .bind(session.user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| ApiError::internal("rental sessions lookup failed"))?;
    Ok(Json(ledger::Items { items }))
}
pub async fn create_session(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    ApiJson(input): ApiJson<SessionInput>,
) -> Result<(StatusCode, Json<RentalSession>), ApiError> {
    if !(1..=MAX_AMOUNT).contains(&input.coin_per_yuan)
        || [
            input.aw_price,
            input.helmet_price,
            input.armor_price,
            input.initial_coins,
        ]
        .iter()
        .any(|v| !(0..=MAX_AMOUNT).contains(v))
        || !(0..=MAX_CENTS).contains(&input.deposit_cents)
        || input.started_at > Utc::now() + chrono::Duration::minutes(5)
    {
        return Err(ApiError::validation("租号比例、报价、押金或开始时间不正确"));
    }
    let note = clean_text(&input.note, 2000, false)?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("rental creation transaction failed"))?;
    let exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM rental_accounts WHERE user_id=$1 AND id=$2 FOR UPDATE")
            .bind(session.user.id)
            .bind(input.account_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| ApiError::internal("rental account lock failed"))?;
    if exists.is_none() {
        return Err(missing());
    }
    let existing: Option<RentalSession> =
        sqlx::query_as(&format!("{SESSION_QUERY} WHERE s.user_id=$1 AND s.id=$2"))
            .bind(session.user.id)
            .bind(input.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| ApiError::internal("rental idempotency lookup failed"))?;
    if let Some(row) = existing {
        if row.account_id != input.account_id
            || row.coin_per_yuan != input.coin_per_yuan
            || row.aw_price != input.aw_price
            || row.helmet_price != input.helmet_price
            || row.armor_price != input.armor_price
            || row.initial_coins != input.initial_coins
            || row.deposit_cents != input.deposit_cents
            || row.started_at.timestamp_micros() != input.started_at.timestamp_micros()
            || row.note != note
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "这次租用已保存其他内容，请重新打开表单",
            ));
        }
        return Ok((StatusCode::OK, Json(row)));
    }
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM rental_sessions WHERE user_id=$1 AND account_id=$2 AND returned_at IS NULL)")
        .bind(session.user.id).bind(input.account_id).fetch_one(&mut *tx).await.map_err(|_| ApiError::internal("active rental lookup failed"))?;
    if active {
        return Err(ApiError::validation(
            "这个账号正在租用，请先还号后再开始下一次租用",
        ));
    }
    sqlx::query("INSERT INTO rental_sessions(id,user_id,account_id,coin_per_yuan,aw_price,helmet_price,armor_price,initial_coins,deposit_cents,started_at,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(input.id).bind(session.user.id).bind(input.account_id).bind(input.coin_per_yuan).bind(input.aw_price).bind(input.helmet_price).bind(input.armor_price).bind(input.initial_coins).bind(input.deposit_cents).bind(input.started_at).bind(note)
        .execute(&mut *tx).await.map_err(|_| ApiError::internal("rental session creation failed"))?;
    let result = sqlx::query_as(&format!("{SESSION_QUERY} WHERE s.user_id=$1 AND s.id=$2"))
        .bind(session.user.id)
        .bind(input.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| ApiError::internal("rental session lookup failed"))?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("rental creation commit failed"))?;
    Ok((StatusCode::CREATED, Json(result)))
}

pub(crate) async fn validate_reference(
    connection: &mut PgConnection,
    owner: Uuid,
    id: Option<Uuid>,
    at: Option<DateTime<Utc>>,
) -> Result<(), ApiError> {
    let Some(id) = id else {
        return Ok(());
    };
    let (start, end): (DateTime<Utc>, Option<DateTime<Utc>>) = sqlx::query_as(
        "SELECT started_at,returned_at FROM rental_sessions WHERE user_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|_| ApiError::internal("rental reference lookup failed"))?
    .ok_or_else(missing)?;
    if let Some(at) = at
        && (at < start || end.is_some_and(|end| at > end))
    {
        return Err(ApiError::validation(
            "本场时间不在所选租用期间，请核对时间或选择实际使用的账号",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReturnInput {
    final_cost_cents: i64,
    returned_at: Option<DateTime<Utc>>,
}
pub async fn return_session(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<ReturnInput>,
) -> Result<Json<RentalSession>, ApiError> {
    let id = path_id(path)?;
    if !(0..=MAX_CENTS).contains(&input.final_cost_cents) {
        return Err(ApiError::validation("最终租号成本必须为非负金额"));
    }
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("rental return transaction failed"))?;
    let (start, old_end): (DateTime<Utc>, Option<DateTime<Utc>>) = sqlx::query_as(
        "SELECT started_at,returned_at FROM rental_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(session.user.id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| ApiError::internal("rental return lock failed"))?
    .ok_or_else(missing)?;
    let end = input.returned_at.or(old_end).unwrap_or_else(Utc::now);
    if end < start || end > Utc::now() + chrono::Duration::minutes(5) {
        return Err(ApiError::validation(
            "还号时间须在开始租用之后，且不能是未来时间",
        ));
    }
    let latest: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT max(occurred_at) FROM rental_rounds WHERE user_id=$1 AND rental_session_id=$2",
    )
    .bind(session.user.id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| ApiError::internal("rental latest round lookup failed"))?;
    if latest.is_some_and(|at| at > end) {
        return Err(ApiError::validation("还号时间不能早于该次租用的最后一局"));
    }
    sqlx::query("UPDATE rental_sessions SET final_cost_cents=$3,returned_at=$4,updated_at=now() WHERE user_id=$1 AND id=$2")
        .bind(session.user.id).bind(id).bind(input.final_cost_cents).bind(end).execute(&mut *tx).await.map_err(|_| ApiError::internal("rental return failed"))?;
    let result = sqlx::query_as(&format!("{SESSION_QUERY} WHERE s.user_id=$1 AND s.id=$2"))
        .bind(session.user.id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| ApiError::internal("returned rental lookup failed"))?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("rental return commit failed"))?;
    Ok(Json(result))
}

#[derive(FromRow)]
struct RoundCount {
    order_id: Uuid,
    rental_session_id: Option<Uuid>,
    rounds: i64,
}
#[derive(Serialize)]
pub struct RentalOrderAnalysis {
    original_income_cents: Option<i64>,
    lost_income_cents: Option<i64>,
    settlement_mode: Option<String>,
    order_id: Uuid,
    title: String,
    boss_name: String,
    order_status: &'static str,
    rental_rounds: i64,
    total_rounds: i64,
    order_income_cents: Option<i64>,
    income_cents: Option<i64>,
    income_status: &'static str,
}
#[derive(Serialize)]
pub struct RentalAnalysis {
    original_income_cents: i64,
    lost_income_cents: i64,
    affected_order_count: usize,
    affected_round_count: i64,
    original_profit_cents: Option<i64>,
    session: RentalSession,
    orders: Vec<RentalOrderAnalysis>,
    round_count: i64,
    order_count: usize,
    pending_order_count: usize,
    income_cents: i64,
    profit_cents: Option<i64>,
    refund_cents: Option<i64>,
    supplement_cents: Option<i64>,
}

/// Round the person's net fee once, in cents. Intermediate products use i128.
pub(crate) fn net_income(price: i64, people: i32, commission: i32) -> i64 {
    let denominator = i128::from(people) * 10_000;
    ((i128::from(price) * i128::from(10_000 - commission) + denominator / 2) / denominator) as i64
}
/// Largest remainders conserve every cent across all rentals AND the user's own account.
fn allocate(income: i64, counts: &[(Option<Uuid>, i64)], target: Uuid) -> i64 {
    let total: i128 = counts.iter().map(|(_, n)| i128::from(*n)).sum();
    if total == 0 {
        return 0;
    }
    let mut shares: Vec<_> = counts
        .iter()
        .map(|(id, n)| {
            let product = i128::from(income) * i128::from(*n);
            (*id, (product / total) as i64, product % total)
        })
        .collect();
    let remainder = income - shares.iter().map(|(_, cents, _)| cents).sum::<i64>();
    shares.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
    for share in shares.iter_mut().take(remainder as usize) {
        share.1 += 1;
    }
    shares
        .iter()
        .find(|(id, _, _)| *id == Some(target))
        .map_or(0, |(_, cents, _)| *cents)
}

pub async fn analysis(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<RentalAnalysis>, ApiError> {
    let id = path_id(path)?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("rental analysis transaction failed"))?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await
        .map_err(|_| ApiError::internal("rental analysis snapshot failed"))?;
    let rental: RentalSession =
        sqlx::query_as(&format!("{SESSION_QUERY} WHERE s.user_id=$1 AND s.id=$2"))
            .bind(session.user.id)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| ApiError::internal("rental analysis lookup failed"))?
            .ok_or_else(missing)?;
    let orders = ledger::orders_for_rental(&mut tx, session.user.id, id).await?;
    let counts: Vec<RoundCount> = sqlx::query_as("SELECT order_id,rental_session_id,count(*) AS rounds FROM rental_rounds WHERE user_id=$1 AND order_id IN (SELECT order_id FROM rental_rounds WHERE user_id=$1 AND rental_session_id=$2) GROUP BY order_id,rental_session_id")
        .bind(session.user.id).bind(id).fetch_all(&mut *tx).await.map_err(|_| ApiError::internal("rental round counts failed"))?;
    let mut items = Vec::new();
    for order in orders {
        let groups: Vec<_> = counts
            .iter()
            .filter(|c| c.order_id == order.id)
            .map(|c| (c.rental_session_id, c.rounds))
            .collect();
        let rental_rounds = groups
            .iter()
            .filter(|(r, _)| *r == Some(id))
            .map(|(_, n)| *n)
            .sum();
        let total_rounds = groups.iter().map(|(_, n)| *n).sum();
        let net = order.settled_income();
        let original = order.reference_income();
        let status = if net.is_some() {
            "settled"
        } else if order.status == "completed" {
            "missing_finance"
        } else {
            "pending"
        };
        let income = net.map(|net| allocate(net, &groups, id));
        let original_share = original
            .filter(|_| income.is_some())
            .map(|n| allocate(n, &groups, id));
        let lost = original_share
            .zip(income)
            .map(|(before, after)| before - after);
        let mode = if let Some(transfer) = order.current_transfer() {
            transfer.refund_mode.clone().or_else(|| Some("transfer".into()))
        } else if order.status == "archived" {
            order.settlement_history.last().map(|s| s.mode.clone())
        } else {
            None
        };
        items.push(RentalOrderAnalysis {
            original_income_cents: original_share,
            lost_income_cents: lost,
            settlement_mode: mode,
            order_id: order.id,
            title: order.title,
            boss_name: order.boss_name,
            order_status: order.status,
            rental_rounds,
            total_rounds,
            order_income_cents: net,
            income_cents: income,
            income_status: status,
        });
    }
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("rental analysis commit failed"))?;
    let income_cents = items.iter().filter_map(|item| item.income_cents).sum();
    let pending_order_count = items
        .iter()
        .filter(|item| item.income_cents.is_none())
        .count();
    let profit_cents = rental
        .final_cost_cents
        .filter(|_| pending_order_count == 0)
        .map(|cost| income_cents - cost);
    let refund_cents = rental
        .final_cost_cents
        .map(|cost| (rental.deposit_cents - cost).max(0));
    let supplement_cents = rental
        .final_cost_cents
        .map(|cost| (cost - rental.deposit_cents).max(0));
    let original_income_cents = items
        .iter()
        .filter_map(|i| i.original_income_cents)
        .sum::<i64>();
    let lost_income_cents = original_income_cents - income_cents;
    let affected = |item: &&RentalOrderAnalysis| {
        matches!(item.settlement_mode.as_deref(), Some("waiver" | "refund"))
            || (item.settlement_mode.as_deref() == Some("transfer")
                && item.lost_income_cents.is_some_and(|lost| lost > 0))
    };
    let affected_order_count = items.iter().filter(affected).count();
    let affected_round_count = items.iter().filter(affected).map(|i| i.rental_rounds).sum();
    let original_profit_cents = rental
        .final_cost_cents
        .filter(|_| pending_order_count == 0)
        .map(|c| original_income_cents - c);
    Ok(Json(RentalAnalysis {
        original_income_cents,
        lost_income_cents,
        affected_order_count,
        affected_round_count,
        original_profit_cents,
        round_count: rental.round_count,
        order_count: items.len(),
        session: rental,
        orders: items,
        pending_order_count,
        income_cents,
        profit_cents,
        refund_cents,
        supplement_cents,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_then_commission_and_round_once() {
        assert_eq!(net_income(99_800, 2, 2_000), 39_920);
        assert_eq!(net_income(100, 3, 0), 33);
        assert_eq!(net_income(MAX_CENTS, 100, 10_000), 0);
    }
    #[test]
    fn allocations_include_own_rounds_and_conserve_cents() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        assert_eq!(allocate(40_000, &[(Some(a), 4), (None, 6)], a), 16_000);
        assert_eq!(allocate(100, &[(Some(a), 1), (Some(b), 2)], a), 33);
        assert_eq!(allocate(100, &[(Some(a), 1), (Some(b), 2)], b), 67);
        assert_eq!(
            allocate(1, &[(Some(a), 1), (Some(b), 1)], a)
                + allocate(1, &[(Some(a), 1), (Some(b), 1)], b),
            1
        );
    }
}
