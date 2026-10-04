use axum::{
    Json,
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
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
    ocr::MAX_AMOUNT,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BossInput {
    display_name: String,
    game_id: String,
    game_name: String,
    notes: String,
}

#[derive(Serialize, FromRow)]
pub struct Boss {
    id: Uuid,
    display_name: String,
    game_id: String,
    game_name: String,
    notes: String,
    #[sqlx(default)]
    active_order_count: i64,
    #[sqlx(default)]
    remaining_minutes: i64,
    #[sqlx(default)]
    remaining_amount: i64,
    #[sqlx(default)]
    pending_single_round_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct Items<T> {
    items: Vec<T>,
}

fn text(value: String, min: usize, max: usize, multiline: bool) -> Result<String, ApiError> {
    let value = value.trim();
    if !(min..=max).contains(&value.chars().count())
        || value
            .chars()
            .any(|c| c.is_control() && !(multiline && (c == '\n' || c == '\t')))
    {
        return Err(ApiError::validation("文字长度不正确或包含特殊控制字符"));
    }
    Ok(value.to_owned())
}
fn clean_boss(input: BossInput) -> Result<BossInput, ApiError> {
    Ok(BossInput {
        display_name: text(input.display_name, 1, 80, false)?,
        game_id: text(input.game_id, 0, 80, false)?,
        game_name: text(input.game_name, 0, 80, false)?,
        notes: text(input.notes, 0, 2000, true)?,
    })
}
fn missing() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "LEDGER_NOT_FOUND",
        "这项记录不存在或你无权访问",
    )
}
fn invalid_query() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "INVALID_QUERY", "查询参数不正确")
}
fn path_id(path: Result<Path<Uuid>, PathRejection>) -> Result<Uuid, ApiError> {
    path.map(|Path(id)| id).map_err(|_| invalid_query())
}
const BOSS_COLUMNS: &str = "id, display_name, game_id, game_name, notes, created_at, updated_at";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BossQuery {
    #[serde(default)]
    q: String,
}

pub async fn list_bosses(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    query: Result<Query<BossQuery>, QueryRejection>,
) -> Result<Json<Items<Boss>>, ApiError> {
    let Query(query) = query.map_err(|_| invalid_query())?;
    let search = text(query.q, 0, 120, false)?;
    let sql = format!(
        "SELECT {BOSS_COLUMNS} FROM bosses WHERE user_id=$1 AND ($2='' OR position(lower($2) in lower(display_name || ' ' || game_id || ' ' || game_name || ' ' || notes)) > 0) ORDER BY updated_at DESC,id DESC"
    );
    let mut items: Vec<Boss> = sqlx::query_as(&sql)
        .bind(session.user.id)
        .bind(search)
        .fetch_all(&state.pool)
        .await
        .map_err(|_| ApiError::internal("boss listing failed"))?;
    let orders = fetch_orders(&state, session.user.id, None, None).await?;
    for boss in &mut items {
        populate_boss(boss, &orders)?;
    }
    Ok(Json(Items { items }))
}

fn populate_boss(boss: &mut Boss, orders: &[ServiceOrder]) -> Result<(), ApiError> {
    let mut minutes = 0_i128;
    let mut amount = 0_i128;
    for order in orders.iter().filter(|order| order.boss_id == boss.id) {
        if order.status == "active" {
            boss.active_order_count += 1;
        }
        if order.kind == "hourly" {
            minutes += i128::from(order.remaining_quantity);
        } else if order.kind == "escort" {
            amount += i128::from(order.remaining_quantity);
        } else if order.kind == "single_round" && order.status == "active" {
            boss.pending_single_round_count += 1;
        }
    }
    boss.remaining_minutes = safe_quantity(minutes)?;
    boss.remaining_amount = safe_quantity(amount)?;
    Ok(())
}

pub async fn get_boss(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<Boss>, ApiError> {
    Ok(Json(
        boss_detail(&state, session.user.id, path_id(path)?).await?,
    ))
}
async fn boss_detail(state: &AppState, owner: Uuid, id: Uuid) -> Result<Boss, ApiError> {
    let sql = format!("SELECT {BOSS_COLUMNS} FROM bosses WHERE user_id=$1 AND id=$2");
    let mut boss = sqlx::query_as::<_, Boss>(&sql)
        .bind(owner)
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError::internal("boss lookup failed"))?
        .ok_or_else(missing)?;
    let orders = fetch_orders(state, owner, Some(id), None).await?;
    populate_boss(&mut boss, &orders)?;
    Ok(boss)
}
pub async fn create_boss(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    ApiJson(input): ApiJson<BossInput>,
) -> Result<(StatusCode, Json<Boss>), ApiError> {
    let input = clean_boss(input)?;
    let id = Uuid::new_v4();
    let sql = format!(
        "INSERT INTO bosses(id,user_id,boss_key,display_name,game_id,game_name,notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING {BOSS_COLUMNS}"
    );
    let boss = sqlx::query_as(&sql)
        .bind(id)
        .bind(session.user.id)
        .bind(id.to_string())
        .bind(input.display_name)
        .bind(input.game_id)
        .bind(input.game_name)
        .bind(input.notes)
        .fetch_one(&state.pool)
        .await
        .map_err(|_| ApiError::internal("boss creation failed"))?;
    Ok((StatusCode::CREATED, Json(boss)))
}
pub async fn update_boss(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<BossInput>,
) -> Result<Json<Boss>, ApiError> {
    let id = path_id(path)?;
    let input = clean_boss(input)?;
    let sql = format!(
        "UPDATE bosses SET display_name=$3,game_id=$4,game_name=$5,notes=$6,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING {BOSS_COLUMNS}"
    );
    let mut boss: Boss = sqlx::query_as(&sql)
        .bind(session.user.id)
        .bind(id)
        .bind(input.display_name)
        .bind(input.game_id)
        .bind(input.game_name)
        .bind(input.notes)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError::internal("boss update failed"))?
        .ok_or_else(missing)?;
    populate_boss(
        &mut boss,
        &fetch_orders(&state, session.user.id, Some(id), None).await?,
    )?;
    Ok(Json(boss))
}

#[derive(Clone, Deserialize, Serialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct OrderInput {
    pub(crate) title: String,
    pub(crate) kind: String,
    pub(crate) target_quantity: i64,
    pub(crate) failure_default_quantity: i64,
    pub(crate) note: String,
    #[serde(default = "failed_trigger")]
    pub(crate) failure_trigger: String,
    #[serde(default)]
    pub(crate) failure_standard_quantity: i64,
    #[serde(default = "manual_mode")]
    pub(crate) failure_mode: String,
    // Released clients include neutral legacy fields. Never read or write retired columns.
    #[serde(default, rename = "wager_item_id", skip_serializing)]
    #[sqlx(skip)]
    retired_item_id: Option<String>,
    #[serde(default, rename = "wager_item_name", skip_serializing)]
    #[sqlx(skip)]
    retired_item_name: String,
    #[serde(
        default = "crate::retired_fields::obtained",
        rename = "wager_expected",
        skip_serializing
    )]
    #[sqlx(skip)]
    retired_expected: String,
    #[serde(
        default = "crate::retired_fields::appearance",
        rename = "wager_condition",
        skip_serializing
    )]
    #[sqlx(skip)]
    retired_condition: String,
}
fn failed_trigger() -> String {
    "failed".into()
}
fn manual_mode() -> String {
    "manual".into()
}
#[derive(Serialize)]
pub struct ServiceOrder {
    id: Uuid,
    boss_id: Uuid,
    boss_name: String,
    boss_game_name: String,
    title: String,
    kind: String,
    target_quantity: i64,
    failure_default_quantity: i64,
    note: String,
    failure_trigger: String,
    failure_standard_quantity: i64,
    failure_mode: String,
    configuration_locked: bool,
    best_round_quantity: i64,
    completed_quantity: i64,
    failure_quantity: i64,
    adjustment_quantity: i64,
    total_quantity: i64,
    remaining_quantity: i64,
    excess_quantity: i64,
    status: &'static str,
    record_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}
#[derive(FromRow)]
struct OrderRow {
    id: Uuid,
    boss_id: Uuid,
    boss_name: String,
    boss_game_name: String,
    title: String,
    kind: String,
    target_quantity: i64,
    failure_default_quantity: i64,
    note: String,
    failure_trigger: String,
    failure_standard_quantity: i64,
    failure_mode: String,
    configuration_locked: bool,
    best: i64,
    progress: String,
    failure: String,
    adjustment: String,
    record_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

// Confirmed screenshots are a projection into the ledger, never a second stored entry.
const ORDER_QUERY: &str = r#"SELECT o.id,o.boss_id,b.display_name AS boss_name,b.game_name AS boss_game_name,o.title,o.kind,o.target_quantity,o.failure_default_quantity,o.note,
o.failure_trigger,o.failure_standard_quantity,o.failure_mode,
(EXISTS(SELECT 1 FROM ledger_entries WHERE user_id=o.user_id AND order_id=o.id) OR EXISTS(SELECT 1 FROM matches WHERE user_id=o.user_id AND order_id=o.id)) AS configuration_locked,
tot.progress::text AS progress,tot.failure::text AS failure,tot.adjustment::text AS adjustment,tot.best,tot.record_count,o.created_at,GREATEST(o.updated_at,COALESCE(tot.latest,o.updated_at)) AS updated_at
FROM service_orders o JOIN bosses b ON b.user_id=o.user_id AND b.id=o.boss_id CROSS JOIN LATERAL (
 SELECT COALESCE(sum(credit),0) AS progress,COALESCE(sum(extra),0) AS failure,COALESCE(sum(adjustment),0) AS adjustment,COALESCE(max(credit),0) AS best,
 count(*) AS record_count,max(updated_at) AS latest FROM (
 SELECT CASE WHEN o.kind='hourly' AND kind='progress' THEN quantity ELSE COALESCE(credited_amount,0) END AS credit,
 failure_extra_amount AS extra,CASE WHEN kind='adjustment' THEN quantity ELSE 0 END AS adjustment,created_at AS updated_at
 FROM ledger_entries WHERE user_id=o.user_id AND order_id=o.id
 UNION ALL SELECT COALESCE(credited_amount,0),failure_extra_amount,0,updated_at FROM matches WHERE user_id=o.user_id AND order_id=o.id AND confirmed
 ) events) tot"#;

/// Retired rows stay in the database and raw account archives, never in active business logic.
pub(crate) fn supported_kind(kind: &str) -> Result<(), ApiError> {
    if matches!(kind, "hourly" | "escort" | "single_round") {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "ORDER_TYPE_UNSUPPORTED",
            "该订单类型已停用，历史数据保留在账户归档中",
        ))
    }
}

fn overflow() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "ORDER_QUANTITY_INVALID",
        "订单累计数量超出安全范围，或调整后任务总量小于零",
    )
}
fn safe_quantity(value: i128) -> Result<i64, ApiError> {
    if !(0..=i128::from(MAX_AMOUNT)).contains(&value) {
        return Err(overflow());
    }
    Ok(value as i64)
}
fn projection(row: OrderRow) -> Result<ServiceOrder, ApiError> {
    supported_kind(&row.kind)?;
    let progress = row.progress.parse::<i128>().map_err(|_| overflow())?;
    let failure = row.failure.parse::<i128>().map_err(|_| overflow())?;
    let adjustment = row.adjustment.parse::<i128>().map_err(|_| overflow())?;
    if adjustment.abs() > i128::from(MAX_AMOUNT) {
        return Err(overflow());
    }
    let progress = if row.kind == "single_round" {
        i128::from(row.best)
    } else {
        progress
    };
    let total = i128::from(row.target_quantity) + failure + adjustment;
    let completed_quantity = safe_quantity(progress)?;
    let failure_quantity = safe_quantity(failure)?;
    let total_quantity = safe_quantity(total)?;
    let remaining_quantity = if row.kind == "single_round" && progress < total {
        row.target_quantity
    } else {
        safe_quantity((total - progress).max(0))?
    };
    let excess_quantity = safe_quantity((progress - total).max(0))?;
    let best_round_quantity = if row.kind == "single_round" {
        row.best
    } else {
        0
    };
    Ok(ServiceOrder {
        id: row.id,
        boss_id: row.boss_id,
        boss_name: row.boss_name,
        boss_game_name: row.boss_game_name,
        title: row.title,
        kind: row.kind,
        target_quantity: row.target_quantity,
        failure_default_quantity: row.failure_default_quantity,
        note: row.note,
        failure_trigger: row.failure_trigger,
        failure_standard_quantity: row.failure_standard_quantity,
        failure_mode: row.failure_mode,
        configuration_locked: row.configuration_locked,
        best_round_quantity,
        completed_quantity,
        failure_quantity,
        adjustment_quantity: adjustment as i64,
        total_quantity,
        remaining_quantity,
        excess_quantity,
        status: if remaining_quantity == 0 {
            "completed"
        } else {
            "active"
        },
        record_count: row.record_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}
async fn fetch_orders(
    state: &AppState,
    owner: Uuid,
    boss: Option<Uuid>,
    order: Option<Uuid>,
) -> Result<Vec<ServiceOrder>, ApiError> {
    let sql = format!(
        "{ORDER_QUERY} WHERE o.user_id=$1 AND o.kind IN ('hourly','escort','single_round') AND ($2::uuid IS NULL OR o.boss_id=$2) AND ($3::uuid IS NULL OR o.id=$3) ORDER BY o.created_at DESC,o.id DESC"
    );
    sqlx::query_as::<_, OrderRow>(&sql)
        .bind(owner)
        .bind(boss)
        .bind(order)
        .fetch_all(&state.pool)
        .await
        .map_err(|_| ApiError::internal("orders lookup failed"))?
        .into_iter()
        .map(projection)
        .collect()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrdersQuery {
    boss_id: Option<Uuid>,
}
pub async fn list_orders(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    query: Result<Query<OrdersQuery>, QueryRejection>,
) -> Result<Json<Items<ServiceOrder>>, ApiError> {
    let Query(query) = query.map_err(|_| invalid_query())?;
    if let Some(boss) = query.boss_id {
        boss_detail(&state, session.user.id, boss).await?;
    }
    Ok(Json(Items {
        items: fetch_orders(&state, session.user.id, query.boss_id, None).await?,
    }))
}
pub async fn get_order(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
) -> Result<Json<ServiceOrder>, ApiError> {
    let id = path_id(path)?;
    binding(&state, session.user.id, id).await?;
    Ok(Json(
        fetch_orders(&state, session.user.id, None, Some(id))
            .await?
            .into_iter()
            .next()
            .ok_or_else(missing)?,
    ))
}
pub async fn create_order(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<OrderInput>,
) -> Result<(StatusCode, Json<ServiceOrder>), ApiError> {
    let boss_id = path_id(path)?;
    let boss = boss_detail(&state, session.user.id, boss_id).await?;
    let input = clean_order(input, &boss.game_name)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO service_orders(id,user_id,boss_id,title,kind,target_quantity,failure_default_quantity,note,failure_trigger,failure_standard_quantity,failure_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(id).bind(session.user.id).bind(boss_id).bind(input.title).bind(input.kind).bind(input.target_quantity).bind(input.failure_default_quantity).bind(input.note)
        .bind(input.failure_trigger).bind(input.failure_standard_quantity).bind(input.failure_mode)
        .execute(&state.pool).await.map_err(|_| ApiError::internal("order creation failed"))?;
    Ok((
        StatusCode::CREATED,
        Json(
            fetch_orders(&state, session.user.id, None, Some(id))
                .await?
                .into_iter()
                .next()
                .ok_or_else(missing)?,
        ),
    ))
}

fn clean_order(input: OrderInput, game_name: &str) -> Result<OrderInput, ApiError> {
    let input = clean_configuration(input)?;
    if matches!(input.kind.as_str(), "escort" | "single_round") && game_name.is_empty() {
        return Err(ApiError::validation(
            "创建金额订单前，请先填写老板的截图昵称",
        ));
    }
    Ok(input)
}

/// Validate reusable configuration independently of the boss selected when opening an order.
pub(crate) fn clean_configuration(mut input: OrderInput) -> Result<OrderInput, ApiError> {
    supported_kind(&input.kind)?;
    crate::retired_fields::configuration(
        input.retired_item_id.as_deref(),
        &input.retired_item_name,
        &input.retired_expected,
        &input.retired_condition,
    )?;
    if !(1..=MAX_AMOUNT).contains(&input.target_quantity)
        || !(0..=MAX_AMOUNT).contains(&input.failure_default_quantity)
        || !(0..=MAX_AMOUNT).contains(&input.failure_standard_quantity)
        || !matches!(
            input.failure_trigger.as_str(),
            "failed" | "failed_below_standard" | "below_standard"
        )
        || !matches!(
            input.failure_mode.as_str(),
            "manual" | "fixed" | "shortfall"
        )
    {
        return Err(ApiError::validation("订单类型、目标数量或规则不正确"));
    }
    if input.kind != "escort"
        && (input.failure_default_quantity != 0
            || input.failure_standard_quantity != 0
            || input.failure_trigger != "failed"
            || input.failure_mode != "manual")
    {
        return Err(ApiError::validation("只有护航单可以配置追加任务规则"));
    }
    input.title = text(input.title, 1, 120, false)?;
    input.note = text(input.note, 0, 2000, true)?;
    Ok(input)
}

pub async fn update_order(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<OrderInput>,
) -> Result<Json<ServiceOrder>, ApiError> {
    let id = path_id(path)?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("order update transaction failed"))?;
    let old = lock_order(&mut tx, session.user.id, id).await?;
    let input = clean_order(input, &old.game_name)?;
    let locked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM ledger_entries WHERE user_id=$1 AND order_id=$2) OR EXISTS(SELECT 1 FROM matches WHERE user_id=$1 AND order_id=$2)")
        .bind(session.user.id).bind(id).fetch_one(&mut *tx).await.map_err(|_|ApiError::internal("order configuration lookup failed"))?;
    if locked
        && (old.kind != input.kind
            || old.target_quantity != input.target_quantity
            || old.failure_trigger != input.failure_trigger
            || old.failure_standard_quantity != input.failure_standard_quantity
            || old.failure_mode != input.failure_mode)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ORDER_CONFIGURATION_LOCKED",
            "订单已有记录，类型和核心规则不能修改；名称、备注及未来默认补量仍可修改",
        ));
    }
    sqlx::query("UPDATE service_orders SET title=$3,kind=$4,target_quantity=$5,failure_default_quantity=$6,note=$7,failure_trigger=$8,failure_standard_quantity=$9,failure_mode=$10,updated_at=now() WHERE user_id=$1 AND id=$2")
        .bind(session.user.id).bind(id).bind(input.title).bind(input.kind).bind(input.target_quantity).bind(input.failure_default_quantity).bind(input.note)
        .bind(input.failure_trigger).bind(input.failure_standard_quantity).bind(input.failure_mode)
        .execute(&mut *tx).await.map_err(|_|ApiError::internal("order update failed"))?;
    validate_order(&mut tx, session.user.id, id).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("order update commit failed"))?;
    Ok(Json(
        fetch_orders(&state, session.user.id, None, Some(id))
            .await?
            .into_iter()
            .next()
            .ok_or_else(missing)?,
    ))
}

#[derive(FromRow)]
pub(crate) struct OrderBinding {
    pub kind: String,
    pub boss_key: String,
    pub game_name: String,
    pub failure_default_quantity: i64,
    pub target_quantity: i64,
    pub failure_trigger: String,
    pub failure_standard_quantity: i64,
    pub failure_mode: String,
}
const BINDING_QUERY: &str = "SELECT o.kind,b.boss_key,b.game_name,o.failure_default_quantity,o.target_quantity,o.failure_trigger,o.failure_standard_quantity,o.failure_mode FROM service_orders o JOIN bosses b ON b.user_id=o.user_id AND b.id=o.boss_id WHERE o.user_id=$1 AND o.id=$2";

pub(crate) fn money(
    amount: Option<i64>,
    fake: Option<i64>,
    required: bool,
) -> Result<Option<i64>, ApiError> {
    if amount.is_some_and(|v| !(0..=MAX_AMOUNT).contains(&v))
        || fake.is_some_and(|v| !(0..=MAX_AMOUNT).contains(&v))
        || matches!((amount,fake),(Some(a),Some(f)) if f>a)
    {
        return Err(ApiError::validation(
            "金额与假账扣除必须是安全范围内的非负整数，扣除不能超过毛额",
        ));
    }
    match (amount, fake) {
        (Some(a), Some(f)) => Ok(Some(a - f)),
        _ if required => Err(ApiError::validation(
            "请明确填写本场金额和假账扣除（没有扣除请填写0）",
        )),
        _ => Ok(None),
    }
}
pub(crate) fn additional(
    order: &OrderBinding,
    outcome: &str,
    net: Option<i64>,
    manual: Option<i64>,
    required: bool,
) -> Result<i64, ApiError> {
    if manual.is_some_and(|v| !(0..=MAX_AMOUNT).contains(&v)) {
        return Err(ApiError::validation("追加任务金额超出安全范围"));
    }
    if order.kind != "escort" {
        if manual.unwrap_or(0) != 0 {
            return Err(ApiError::validation("只有护航单允许追加任务金额"));
        }
        return Ok(0);
    }
    let low = net.is_some_and(|v| v < order.failure_standard_quantity);
    let trigger = match order.failure_trigger.as_str() {
        "failed" => outcome == "failed",
        "failed_below_standard" => outcome == "failed" && low,
        "below_standard" => matches!(outcome, "success" | "failed") && low,
        _ => false,
    };
    if !trigger {
        return Ok(0);
    }
    match order.failure_mode.as_str() {
        "fixed" => Ok(order.failure_default_quantity),
        "shortfall" => Ok((order.failure_standard_quantity - net.unwrap_or(0)).max(0)),
        _ => manual
            .ok_or_else(|| {
                ApiError::validation("本场触发追加规则，请明确填写追加任务金额（可填写0）")
            })
            .or_else(|e| if required { Err(e) } else { Ok(0) }),
    }
}
pub(crate) async fn binding(
    state: &AppState,
    owner: Uuid,
    id: Uuid,
) -> Result<OrderBinding, ApiError> {
    let order: OrderBinding = sqlx::query_as(BINDING_QUERY)
        .bind(owner)
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError::internal("order binding lookup failed"))?
        .ok_or_else(missing)?;
    supported_kind(&order.kind)?;
    Ok(order)
}
pub(crate) async fn lock_order(
    connection: &mut PgConnection,
    owner: Uuid,
    id: Uuid,
) -> Result<OrderBinding, ApiError> {
    let order: OrderBinding = sqlx::query_as(&format!("{BINDING_QUERY} FOR UPDATE OF o"))
        .bind(owner)
        .bind(id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|_| ApiError::internal("order lock failed"))?
        .ok_or_else(missing)?;
    supported_kind(&order.kind)?;
    Ok(order)
}
pub(crate) async fn validate_order(
    connection: &mut PgConnection,
    owner: Uuid,
    id: Uuid,
) -> Result<(), ApiError> {
    let row =
        sqlx::query_as::<_, OrderRow>(&format!("{ORDER_QUERY} WHERE o.user_id=$1 AND o.id=$2"))
            .bind(owner)
            .bind(id)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|_| ApiError::internal("order balance validation failed"))?
            .ok_or_else(missing)?;
    projection(row)?;
    sqlx::query("UPDATE service_orders SET updated_at=now() WHERE user_id=$1 AND id=$2")
        .bind(owner)
        .bind(id)
        .execute(connection)
        .await
        .map_err(|_| ApiError::internal("order timestamp update failed"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntryInput {
    kind: String,
    quantity: i64,
    occurred_at: Option<DateTime<Utc>>,
    note: String,
    idempotency_key: Uuid,
    amount: Option<i64>,
    fake_amount: Option<i64>,
    outcome: Option<String>,
    #[serde(default, rename = "item_obtained")]
    retired_item_result: Option<bool>,
    failure_extra_amount: Option<i64>,
}
#[derive(Serialize, FromRow)]
pub struct LedgerEntry {
    id: Uuid,
    order_id: Uuid,
    kind: String,
    quantity: i64,
    occurred_at: DateTime<Utc>,
    note: String,
    source: String,
    match_id: Option<Uuid>,
    amount: Option<i64>,
    fake_amount: Option<i64>,
    net_amount: Option<i64>,
    credited_amount: Option<i64>,
    outcome: Option<String>,
    failure_extra_amount: i64,
}
const ENTRY_COLUMNS: &str = "id,order_id,kind,quantity,occurred_at,note,'manual'::text AS source,NULL::uuid AS match_id,amount,fake_amount,net_amount,credited_amount,outcome,failure_extra_amount";
const EVENTS: &str = "SELECT id,order_id,kind,quantity,occurred_at,note,'manual'::text AS source,NULL::uuid AS match_id,amount,fake_amount,net_amount,credited_amount,outcome,failure_extra_amount FROM ledger_entries WHERE user_id=$1 AND order_id=$2 UNION ALL SELECT id,order_id,CASE WHEN outcome='success' THEN 'progress' ELSE 'failure' END,CASE WHEN outcome='success' THEN COALESCE(credited_amount,0) ELSE failure_extra_amount END,COALESCE(played_at,created_at),note,'screenshot'::text,id,amount,fake_amount,net_amount,credited_amount,outcome,failure_extra_amount FROM matches WHERE user_id=$1 AND order_id=$2 AND confirmed";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageQuery {
    #[serde(default = "page_one")]
    page: i64,
    #[serde(default = "page_size")]
    page_size: i64,
}
fn page_one() -> i64 {
    1
}
fn page_size() -> i64 {
    20
}
#[derive(Serialize)]
pub struct LedgerPage {
    items: Vec<LedgerEntry>,
    total: i64,
    page: i64,
    page_size: i64,
}
pub async fn list_entries(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    query: Result<Query<PageQuery>, QueryRejection>,
) -> Result<Json<LedgerPage>, ApiError> {
    let id = path_id(path)?;
    binding(&state, session.user.id, id).await?;
    let Query(query) = query.map_err(|_| invalid_query())?;
    if query.page < 1 || !(1..=100).contains(&query.page_size) {
        return Err(ApiError::validation("页码至少为 1，每页最多 100 条"));
    }
    let offset = (query.page - 1)
        .checked_mul(query.page_size)
        .ok_or_else(invalid_query)?;
    let total = sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM ({EVENTS}) events"))
        .bind(session.user.id)
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .map_err(|_| ApiError::internal("ledger count failed"))?;
    let items = sqlx::query_as(&format!(
        "SELECT * FROM ({EVENTS}) events ORDER BY occurred_at DESC,id DESC LIMIT $3 OFFSET $4"
    ))
    .bind(session.user.id)
    .bind(id)
    .bind(query.page_size)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| ApiError::internal("ledger pagination failed"))?;
    Ok(Json(LedgerPage {
        items,
        total,
        page: query.page,
        page_size: query.page_size,
    }))
}
pub async fn add_entry(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<EntryInput>,
) -> Result<(StatusCode, Json<LedgerEntry>), ApiError> {
    let id = path_id(path)?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("ledger transaction failed"))?;
    let mut order = lock_order(&mut tx, session.user.id, id).await?;
    let existing=sqlx::query_as::<_,LedgerEntry>(&format!("SELECT {ENTRY_COLUMNS} FROM ledger_entries WHERE user_id=$1 AND order_id=$2 AND idempotency_key=$3")).bind(session.user.id).bind(id).bind(input.idempotency_key).fetch_optional(&mut *tx).await.map_err(|_|ApiError::internal("ledger idempotency lookup failed"))?;
    if order.failure_mode == "fixed"
        && let Some(existing) = &existing
    {
        order.failure_default_quantity = existing.failure_extra_amount;
    }
    let input = normalize_entry(input, &order)?;
    if let Some(existing) = existing {
        if existing.kind != input.kind
            || existing.quantity != input.quantity
            || existing.note != input.note
            || existing.amount != input.amount
            || existing.fake_amount != input.fake_amount
            || existing.outcome != input.outcome
            || existing.failure_extra_amount != input.failure_extra_amount.unwrap_or(0)
            || input
                .occurred_at
                .is_some_and(|value| value != existing.occurred_at)
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "本次记账标识已用于不同内容，请刷新后重新提交",
            ));
        }
        return Ok((StatusCode::OK, Json(existing)));
    }
    let entry=sqlx::query_as(&format!("INSERT INTO ledger_entries(id,user_id,order_id,kind,quantity,occurred_at,note,idempotency_key,amount,fake_amount,outcome,failure_extra_amount) VALUES($1,$2,$3,$4,$5,COALESCE($6,now()),$7,$8,$9,$10,$11,$12) RETURNING {ENTRY_COLUMNS}"))
        .bind(Uuid::new_v4()).bind(session.user.id).bind(id).bind(input.kind).bind(input.quantity).bind(input.occurred_at).bind(input.note).bind(input.idempotency_key)
        .bind(input.amount).bind(input.fake_amount).bind(input.outcome).bind(input.failure_extra_amount.unwrap_or(0))
        .fetch_one(&mut *tx).await.map_err(|_|ApiError::internal("ledger insertion failed"))?;
    validate_order(&mut tx, session.user.id, id).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("ledger commit failed"))?;
    Ok((StatusCode::CREATED, Json(entry)))
}
fn normalize_entry(mut input: EntryInput, order: &OrderBinding) -> Result<EntryInput, ApiError> {
    crate::retired_fields::item_result(input.retired_item_result)?;
    input.note = text(input.note, 0, 2000, true)?;
    if !(-MAX_AMOUNT..=MAX_AMOUNT).contains(&input.quantity)
        || input
            .outcome
            .as_ref()
            .is_some_and(|v| !matches!(v.as_str(), "success" | "failed"))
    {
        return Err(ApiError::validation("记账数量或撤离状态不正确"));
    }
    if input.kind == "adjustment" || order.kind == "hourly" {
        if order.kind == "single_round"
            || !matches!(input.kind.as_str(), "progress" | "adjustment")
            || (input.kind == "progress" && input.quantity <= 0)
            || (input.kind == "adjustment" && input.quantity == 0)
            || input.amount.is_some()
            || input.fake_amount.unwrap_or(0) != 0
            || input.failure_extra_amount.unwrap_or(0) != 0
        {
            return Err(ApiError::validation("此订单不支持该记账方式"));
        }
        input.amount = None;
        input.fake_amount = None;
        input.outcome = None;
        input.failure_extra_amount = Some(0);
        return Ok(input);
    }
    if !matches!(input.kind.as_str(), "progress" | "failure")
        || input.quantity < 0
        || (input.kind == "failure" && order.kind != "escort")
    {
        return Err(ApiError::validation("此订单不支持该场次类型"));
    }
    let gross = if input.kind == "progress" {
        if input.amount.is_some_and(|a| a != input.quantity) {
            return Err(ApiError::validation("场次毛额和数量不一致"));
        }
        input.quantity
    } else {
        input.amount.unwrap_or(0)
    };
    input.amount = Some(gross);
    input.outcome = Some(input.outcome.unwrap_or_else(|| {
        if input.kind == "failure" {
            "failed".into()
        } else {
            "success".into()
        }
    }));
    let net = money(input.amount, input.fake_amount, true)?;
    let extra = if input.kind == "failure" {
        if input
            .failure_extra_amount
            .is_some_and(|v| v != input.quantity)
        {
            return Err(ApiError::validation("追加数量不一致"));
        }
        Some(input.quantity)
    } else {
        input.failure_extra_amount
    };
    let additional = additional(
        order,
        input.outcome.as_deref().unwrap_or("success"),
        net,
        extra,
        true,
    )?;
    input.failure_extra_amount = Some(additional);
    input.quantity = if input.kind == "failure" {
        additional
    } else {
        net.unwrap_or(0)
    };
    Ok(input)
}
pub async fn delete_entry(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
) -> Result<StatusCode, ApiError> {
    let Path((order_id, entry_id)) = path.map_err(|_| invalid_query())?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("ledger deletion transaction failed"))?;
    lock_order(&mut tx, session.user.id, order_id).await?;
    let result =
        sqlx::query("DELETE FROM ledger_entries WHERE user_id=$1 AND order_id=$2 AND id=$3")
            .bind(session.user.id)
            .bind(order_id)
            .bind(entry_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| ApiError::internal("ledger deletion failed"))?;
    if result.rows_affected() == 0 {
        return Err(missing());
    }
    validate_order(&mut tx, session.user.id, order_id).await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("ledger deletion commit failed"))?;
    Ok(StatusCode::NO_CONTENT)
}
