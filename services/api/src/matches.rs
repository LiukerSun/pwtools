use axum::{
    Json,
    body::Bytes,
    extract::{
        FromRequestParts, Path, Query, State,
        rejection::{BytesRejection, QueryRejection},
    },
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, types::Json as DbJson};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthenticatedUser,
    error::{ApiError, ApiJson},
    ledger,
    ocr::{OcrPlayer, OcrResponse, Outcome, Recognition},
    storage,
    storage_migration::{self, api_storage_error},
};

const RECORD_COLUMNS: &str = "id, order_id, failure_extra_amount, boss_id, boss_player_name, original_name, image_content_type, image_sha256, image_width, image_height, image_size, image_object_key, players, raw_text, warnings, ocr_status, player_name, outcome, amount, fake_amount, net_amount, credited_amount, item_obtained, manual_result_edited, failure_default_snapshot, confirmed, played_at, note, created_at, updated_at";
const LIST_SCOPE: &str = "user_id=$1 AND (($3::uuid IS NOT NULL AND order_id=$3) OR ($3::uuid IS NULL AND boss_id=$2 AND order_id IS NULL)) AND ($4::boolean IS NULL OR confirmed=$4)";

#[derive(Serialize, FromRow)]
pub struct MatchRecord {
    pub id: Uuid,
    pub order_id: Option<Uuid>,
    pub failure_extra_amount: i64,
    pub boss_id: String,
    pub boss_player_name: String,
    pub original_name: String,
    pub image_content_type: String,
    pub image_sha256: String,
    pub image_width: i32,
    pub image_height: i32,
    pub image_size: i32,
    #[serde(skip_serializing)]
    pub(crate) image_object_key: Option<String>,
    pub players: DbJson<Vec<OcrPlayer>>,
    pub raw_text: String,
    pub warnings: DbJson<Vec<String>>,
    pub ocr_status: String,
    pub player_name: String,
    pub outcome: String,
    pub amount: Option<i64>,
    pub fake_amount: Option<i64>,
    pub net_amount: Option<i64>,
    pub credited_amount: Option<i64>,
    // Legacy evidence is retained in raw archives and existing OSS record snapshots.
    pub item_obtained: Option<bool>,
    #[serde(skip_serializing)]
    manual_result_edited: bool,
    #[serde(skip_serializing)]
    failure_default_snapshot: Option<i64>,
    pub confirmed: bool,
    pub played_at: Option<DateTime<Utc>>,
    pub note: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct UploadResponse {
    record: MatchRecord,
    duplicate: bool,
}

#[derive(Deserialize, Serialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct MatchSettings {
    pub boss_id: String,
    pub boss_player_name: String,
}

async fn current_settings(state: &AppState, user_id: Uuid) -> Result<MatchSettings, ApiError> {
    Ok(
        sqlx::query_as("SELECT boss_id, boss_player_name FROM match_settings WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|_| ApiError::internal("match settings lookup failed"))?
            .unwrap_or(MatchSettings {
                boss_id: String::new(),
                boss_player_name: String::new(),
            }),
    )
}

pub async fn get_settings(
    State(state): State<AppState>,
    session: AuthenticatedUser,
) -> Result<Json<MatchSettings>, ApiError> {
    Ok(Json(current_settings(&state, session.user.id).await?))
}

pub async fn set_settings(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    ApiJson(input): ApiJson<MatchSettings>,
) -> Result<Json<MatchSettings>, ApiError> {
    let normalize = |value: String| -> Result<String, ApiError> {
        let value = value.trim();
        if !(1..=80).contains(&value.chars().count()) || value.chars().any(char::is_control) {
            return Err(ApiError::validation(
                "老板标识和截图昵称需要包含 1 至 80 个字符，且不能包含控制字符",
            ));
        }
        Ok(value.to_owned())
    };
    let boss_id = normalize(input.boss_id)?;
    let boss_player_name = normalize(input.boss_player_name)?;
    let settings = sqlx::query_as("INSERT INTO match_settings (user_id, boss_id, boss_player_name) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET boss_id = EXCLUDED.boss_id, boss_player_name = EXCLUDED.boss_player_name, updated_at = now() RETURNING boss_id, boss_player_name")
        .bind(session.user.id).bind(&boss_id).bind(&boss_player_name).fetch_one(&state.pool).await
        .map_err(|_| ApiError::internal("match settings update failed"))?;
    sqlx::query("INSERT INTO bosses(id,user_id,boss_key,display_name,game_id,game_name) VALUES($1,$2,$3,$4,$3,$4) ON CONFLICT(user_id,boss_key) DO NOTHING")
        .bind(Uuid::new_v4()).bind(session.user.id).bind(boss_id).bind(boss_player_name).execute(&state.pool).await.map_err(|_| ApiError::internal("legacy boss profile creation failed"))?;
    Ok(Json(settings))
}

#[derive(Serialize)]
pub struct MatchPage {
    items: Vec<MatchRecord>,
    total: i64,
    page: i64,
    page_size: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    #[serde(default = "default_page")]
    page: i64,
    #[serde(default = "default_page_size")]
    page_size: i64,
    order_id: Option<Uuid>,
    confirmed: Option<bool>,
}
fn default_page() -> i64 {
    1
}
fn default_page_size() -> i64 {
    20
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchPatch {
    order_id: Option<Uuid>,
    failure_extra_amount: Option<i64>,
    player_name: Option<String>,
    outcome: Option<Outcome>,
    #[serde(default, deserialize_with = "nullable_patch")]
    amount: Option<Option<i64>>,
    #[serde(default, deserialize_with = "nullable_patch")]
    fake_amount: Option<Option<i64>>,
    #[serde(default, rename = "item_obtained", deserialize_with = "nullable_patch")]
    retired_item_result: Option<Option<bool>>,
    confirmed: Option<bool>,
    #[serde(default, deserialize_with = "nullable_patch")]
    played_at: Option<Option<DateTime<Utc>>>,
    note: Option<String>,
}

fn nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

pub struct RecordId(Uuid);

impl FromRequestParts<AppState> for RecordId {
    type Rejection = ApiError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let Path(value) = Path::<String>::from_request_parts(parts, state)
            .await
            .map_err(|_| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "INVALID_RECORD_ID",
                    "战绩编号不正确",
                )
            })?;
        Uuid::parse_str(&value).map(Self).map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_RECORD_ID",
                "战绩编号不正确",
            )
        })
    }
}

fn not_found() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "MATCH_NOT_FOUND",
        "这条战绩不存在或你无权访问",
    )
}

fn original_name(headers: &HeaderMap) -> Result<String, ApiError> {
    let encoded = headers
        .get("x-file-name")
        .map_or(Ok("screenshot"), |value| value.to_str())
        .map_err(|_| ApiError::validation("文件名格式不正确"))?;
    let name = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| ApiError::validation("文件名编码不正确"))?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 255 || name.chars().any(char::is_control) {
        return Err(ApiError::validation(
            "文件名需要包含 1 至 255 个字符，且不能包含控制字符",
        ));
    }
    Ok(name.to_owned())
}

async fn find(state: &AppState, user_id: Uuid, id: Uuid) -> Result<MatchRecord, ApiError> {
    let query = format!("SELECT {RECORD_COLUMNS} FROM matches WHERE user_id = $1 AND id = $2");
    sqlx::query_as(&query)
        .bind(user_id)
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError::internal("match lookup failed"))?
        .ok_or_else(not_found)
}

async fn find_duplicate(
    state: &AppState,
    user_id: Uuid,
    digest: &str,
    boss_id: &str,
) -> Result<Option<MatchRecord>, ApiError> {
    let query = format!(
        "SELECT {RECORD_COLUMNS} FROM matches WHERE user_id = $1 AND image_sha256 = $2 AND boss_id = $3"
    );
    sqlx::query_as(&query)
        .bind(user_id)
        .bind(digest)
        .bind(boss_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| ApiError::internal("duplicate match lookup failed"))
}

async fn validate_record_order(
    state: &AppState,
    owner: Uuid,
    record: &MatchRecord,
) -> Result<(), ApiError> {
    if let Some(order_id) = record.order_id {
        ledger::binding(state, owner, order_id).await?;
    }
    Ok(())
}

fn check_duplicate_order(record: &MatchRecord, requested: Option<Uuid>) -> Result<(), ApiError> {
    if record
        .order_id
        .zip(requested)
        .is_some_and(|(existing, requested)| existing != requested)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ORDER_IMAGE_CONFLICT",
            "这张截图已关联同一老板的另一笔订单，不能重复记账",
        ));
    }
    Ok(())
}

pub async fn upload(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<(StatusCode, Json<UploadResponse>), ApiError> {
    upload_inner(state, session, headers, body, false).await
}

pub async fn upload_local(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Result<(StatusCode, Json<UploadResponse>), ApiError> {
    upload_inner(state, session, headers, body, true).await
}

async fn upload_inner(
    state: AppState,
    session: AuthenticatedUser,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
    local: bool,
) -> Result<(StatusCode, Json<UploadResponse>), ApiError> {
    // Take a settings snapshot before image validation or awaiting the external OCR service.
    let order_id = headers
        .get("x-order-id")
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| ApiError::validation("订单编号不正确"))
        })
        .transpose()?;
    let (settings, failure_default) = if let Some(order_id) = order_id {
        let order = ledger::binding(&state, session.user.id, order_id).await?;
        if order.kind == "hourly" {
            return Err(ApiError::validation(
                "小时单请记录服务时长；战绩截图请关联场次订单",
            ));
        }
        if order.game_name.is_empty() {
            return Err(ApiError::validation("请先填写老板的截图昵称"));
        }
        (
            MatchSettings {
                boss_id: order.boss_key,
                boss_player_name: order.game_name,
            },
            order.failure_default_quantity,
        )
    } else {
        (current_settings(&state, session.user.id).await?, 0)
    };
    if settings.boss_id.is_empty() {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "BOSS_REQUIRED",
            "请先设置要记录的老板标识和截图昵称",
        ));
    }
    let bytes = body.map_err(|rejection| {
        ApiError::new(
            rejection.status(),
            "INVALID_IMAGE_BODY",
            "无法读取图片，请重新上传",
        )
    })?;
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !matches!(content_type, "image/png" | "image/jpeg" | "image/webp") {
        return Err(ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_IMAGE",
            "请上传 PNG、JPEG 或 WebP 图片",
        ));
    }
    let original_name = original_name(&headers)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if let Some(record) =
        find_duplicate(&state, session.user.id, &digest, &settings.boss_id).await?
    {
        validate_record_order(&state, session.user.id, &record).await?;
        check_duplicate_order(&record, order_id)?;
        if record.image_content_type != content_type {
            return Err(ApiError::validation("图片真实格式与声明的文件类型不一致"));
        }
        return Ok((
            StatusCode::OK,
            Json(UploadResponse {
                record,
                duplicate: true,
            }),
        ));
    }
    let (width, height) = state
        .ocr
        .validate_image(bytes.clone(), content_type)
        .await?;
    let id = Uuid::new_v4();
    let image_object_key = if state.storage.is_oss() {
        let key = storage::image_key(
            session.user.id,
            &settings.boss_id,
            order_id,
            id,
            content_type,
        );
        storage_migration::stage_original(&state.pool, session.user.id, id, &key).await?;
        state
            .storage
            .put_verified(&key, content_type, &bytes, true)
            .await
            .map_err(api_storage_error)?;
        Some(key)
    } else {
        None
    };
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("match upload transaction failed"))?;
    // Recheck after remote storage without keeping order locks during network I/O.
    let failure_default = if let Some(order_id) = order_id {
        let order = ledger::lock_order(&mut transaction, session.user.id, order_id).await?;
        if order.kind == "hourly"
            || order.boss_key != settings.boss_id
            || order.game_name != settings.boss_player_name
        {
            return Err(ApiError::validation(
                "订单配置在上传期间发生变化，请重新上传",
            ));
        }
        order.failure_default_quantity
    } else {
        failure_default
    };
    // Avoid taking an existing match lock after the order lock on a racing duplicate.
    if let Some(record) =
        find_duplicate(&state, session.user.id, &digest, &settings.boss_id).await?
    {
        validate_record_order(&state, session.user.id, &record).await?;
        check_duplicate_order(&record, order_id)?;
        transaction
            .rollback()
            .await
            .map_err(|_| ApiError::internal("duplicate upload rollback failed"))?;
        return Ok((
            StatusCode::OK,
            Json(UploadResponse {
                record,
                duplicate: true,
            }),
        ));
    }
    // A new OSS reference is committed only after read-back verification; legacy mode retains BYTEA.
    let query = format!(
        "INSERT INTO matches (id, user_id, original_name, image_content_type, image_bytes, image_sha256, image_width, image_height, image_size, ocr_status, warnings, boss_id, boss_player_name, order_id, failure_extra_amount, image_object_key,failure_default_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'failed',$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (user_id, boss_id, image_sha256) DO NOTHING RETURNING {RECORD_COLUMNS}"
    );
    let inserted = sqlx::query_as::<_, MatchRecord>(&query)
        .bind(id)
        .bind(session.user.id)
        .bind(original_name)
        .bind(content_type)
        .bind(if image_object_key.is_none() {
            Some(bytes.as_ref())
        } else {
            None
        })
        .bind(&digest)
        .bind(width)
        .bind(height)
        .bind(bytes.len() as i32)
        .bind(DbJson(vec![if local {
            "本地识别尚未完成；原图已保存，可稍后重新识别。".to_owned()
        } else {
            "自动识别尚未完成；原图已保存，可稍后重新识别。".to_owned()
        }]))
        .bind(&settings.boss_id)
        .bind(&settings.boss_player_name)
        .bind(order_id)
        .bind(failure_default)
        .bind(&image_object_key)
        .bind(order_id.map(|_| failure_default))
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| ApiError::internal("match upload persistence failed"))?;
    if let Some(inserted) = inserted {
        if let Some(key) = &image_object_key {
            storage_migration::retain_original(&mut transaction, key).await?;
        }
        storage_migration::enqueue_snapshot(
            &mut transaction,
            session.user.id,
            id,
            image_object_key.as_deref(),
            &inserted,
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(|_| ApiError::internal("match upload commit failed"))?;
    } else {
        transaction
            .rollback()
            .await
            .map_err(|_| ApiError::internal("duplicate upload rollback failed"))?;
        let record = find_duplicate(&state, session.user.id, &digest, &settings.boss_id)
            .await?
            .ok_or_else(not_found)?;
        validate_record_order(&state, session.user.id, &record).await?;
        check_duplicate_order(&record, order_id)?;
        return Ok((
            StatusCode::OK,
            Json(UploadResponse {
                record,
                duplicate: true,
            }),
        ));
    }
    if local {
        return Ok((
            StatusCode::CREATED,
            Json(UploadResponse {
                record: find(&state, session.user.id, id).await?,
                duplicate: false,
            }),
        ));
    }
    let recognition = state.ocr.recognize(bytes, content_type).await;
    let record = update_recognition(
        &state,
        session.user.id,
        id,
        &settings.boss_player_name,
        recognition,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(UploadResponse {
            record,
            duplicate: false,
        }),
    ))
}

pub async fn list(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<MatchPage>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_PAGINATION",
            "分页参数不正确",
        )
    })?;
    if query.page < 1 || !(1..=100).contains(&query.page_size) {
        return Err(ApiError::validation("页码至少为 1，每页最多 100 条"));
    }
    let offset = (query.page - 1)
        .checked_mul(query.page_size)
        .ok_or_else(|| ApiError::validation("页码过大"))?;
    let settings = current_settings(&state, session.user.id).await?;
    if let Some(order_id) = query.order_id {
        ledger::binding(&state, session.user.id, order_id).await?;
    }
    if query.order_id.is_none() && settings.boss_id.is_empty() {
        return Ok(Json(MatchPage {
            items: vec![],
            total: 0,
            page: query.page,
            page_size: query.page_size,
        }));
    }
    let total =
        sqlx::query_scalar::<_, i64>(&format!("SELECT count(*) FROM matches WHERE {LIST_SCOPE}"))
            .bind(session.user.id)
            .bind(&settings.boss_id)
            .bind(query.order_id)
            .bind(query.confirmed)
            .fetch_one(&state.pool)
            .await
            .map_err(|_| ApiError::internal("match count failed"))?;
    let sql = format!(
        "SELECT {RECORD_COLUMNS} FROM matches WHERE {LIST_SCOPE} ORDER BY created_at DESC, id DESC LIMIT $5 OFFSET $6"
    );
    let items = sqlx::query_as(&sql)
        .bind(session.user.id)
        .bind(&settings.boss_id)
        .bind(query.order_id)
        .bind(query.confirmed)
        .bind(query.page_size)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
        .map_err(|_| ApiError::internal("match pagination failed"))?;
    Ok(Json(MatchPage {
        items,
        total,
        page: query.page,
        page_size: query.page_size,
    }))
}

pub async fn get(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    RecordId(id): RecordId,
) -> Result<Json<MatchRecord>, ApiError> {
    let record = find(&state, session.user.id, id).await?;
    validate_record_order(&state, session.user.id, &record).await?;
    Ok(Json(record))
}

pub async fn update(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    RecordId(id): RecordId,
    ApiJson(input): ApiJson<MatchPatch>,
) -> Result<Json<MatchRecord>, ApiError> {
    crate::retired_fields::item_result(input.retired_item_result.flatten())?;
    let mut transaction = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("match update transaction failed"))?;
    let query =
        format!("SELECT {RECORD_COLUMNS} FROM matches WHERE user_id = $1 AND id = $2 FOR UPDATE");
    let mut row = sqlx::query_as::<_, MatchRecord>(&query)
        .bind(session.user.id)
        .bind(id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| ApiError::internal("match update lookup failed"))?
        .ok_or_else(not_found)?;
    let previous_money = (
        row.outcome.clone(),
        row.amount,
        row.fake_amount,
        row.order_id,
    );
    let was_confirmed = row.confirmed;
    row.manual_result_edited |= input.player_name.is_some()
        || input.outcome.is_some()
        || input.amount.is_some()
        || input.fake_amount.is_some();
    if let Some(order_id) = input.order_id {
        check_duplicate_order(&row, Some(order_id))?;
        row.order_id = Some(order_id);
    }
    let order_binding = if let Some(order_id) = row.order_id {
        let mut order = ledger::lock_order(&mut transaction, session.user.id, order_id).await?;
        if order.kind == "hourly" || order.boss_key != row.boss_id {
            return Err(ApiError::validation("截图只能关联同一老板的场次订单"));
        }
        order.failure_default_quantity = *row
            .failure_default_snapshot
            .get_or_insert(order.failure_default_quantity);
        Some(order)
    } else {
        None
    };
    if let Some(name) = input.player_name {
        let name = name.trim();
        if name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err(ApiError::validation(
                "玩家名称最多 80 个字符，且不能包含控制字符",
            ));
        }
        row.player_name = name.to_owned();
    }
    if let Some(outcome) = input.outcome {
        row.outcome = outcome.as_str().to_owned();
    }
    if let Some(amount) = input.amount {
        row.amount = amount;
    }
    if let Some(fake) = input.fake_amount {
        row.fake_amount = fake;
    }
    if let Some(confirmed) = input.confirmed {
        row.confirmed = confirmed;
    }
    if let Some(played_at) = input.played_at {
        row.played_at = played_at;
    }
    if let Some(note) = input.note {
        let note = note.trim();
        if note.chars().count() > 1000
            || note
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
        {
            return Err(ApiError::validation(
                "备注最多 1000 个字符，且不能包含特殊控制字符",
            ));
        }
        row.note = note.to_owned();
    }
    let net = ledger::money(row.amount, row.fake_amount, row.confirmed)?;
    if let Some(order) = &order_binding {
        let changed = previous_money
            != (
                row.outcome.clone(),
                row.amount,
                row.fake_amount,
                row.order_id,
            );
        if !was_confirmed || changed || input.failure_extra_amount.is_some() {
            let manual = if input.failure_extra_amount.is_some() {
                input.failure_extra_amount
            } else if was_confirmed || !row.confirmed {
                Some(row.failure_extra_amount)
            } else {
                None
            };
            row.failure_extra_amount =
                ledger::additional(order, &row.outcome, net, manual, row.confirmed)?;
        }
    } else {
        if input.failure_extra_amount.unwrap_or(0) != 0 {
            return Err(ApiError::validation("请先关联护航订单再记录追加任务"));
        }
        row.failure_extra_amount = 0;
    }
    if row.confirmed {
        if row.player_name.is_empty() || row.outcome == "unknown" {
            return Err(ApiError::validation(
                "确认战绩前，请填写玩家名称并选择成功或失败",
            ));
        }
        if row.player_name != row.boss_player_name {
            return Err(ApiError::validation(
                "只能确认此记录绑定的老板昵称，请核对玩家名称",
            ));
        }
    }
    let query = format!(
        "UPDATE matches SET player_name = $3, outcome = $4, amount = $5, confirmed = $6, played_at = $7, note = $8, order_id=$9, failure_extra_amount=$10, fake_amount=$11,manual_result_edited=$12,failure_default_snapshot=$13,updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING {RECORD_COLUMNS}"
    );
    let updated = sqlx::query_as::<_, MatchRecord>(&query)
        .bind(session.user.id)
        .bind(id)
        .bind(row.player_name)
        .bind(row.outcome)
        .bind(row.amount)
        .bind(row.confirmed)
        .bind(row.played_at)
        .bind(row.note)
        .bind(row.order_id)
        .bind(row.failure_extra_amount)
        .bind(row.fake_amount)
        .bind(row.manual_result_edited)
        .bind(row.failure_default_snapshot)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|_| ApiError::internal("match update failed"))?;
    if let Some(order_id) = row.order_id {
        ledger::validate_order(&mut transaction, session.user.id, order_id).await?;
    }
    storage_migration::enqueue_snapshot(
        &mut transaction,
        session.user.id,
        id,
        updated.image_object_key.as_deref(),
        &updated,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|_| ApiError::internal("match update commit failed"))?;
    Ok(Json(updated))
}

pub async fn original_image(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    RecordId(id): RecordId,
) -> Result<Response, ApiError> {
    let record = find(&state, session.user.id, id).await?;
    validate_record_order(&state, session.user.id, &record).await?;
    let (content_type, bytes, _) = stored_image(&state, session.user.id, id).await?;
    let extension = match content_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        _ => "webp",
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .map_err(|_| ApiError::internal("stored image content type invalid"))?,
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"match-{id}.{extension}\""))
            .map_err(|_| ApiError::internal("download header invalid"))?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    Ok((headers, bytes).into_response())
}

#[derive(FromRow)]
struct StoredImage {
    image_content_type: String,
    image_bytes: Option<Vec<u8>>,
    image_object_key: Option<String>,
    image_sha256: String,
    image_size: i32,
    boss_player_name: String,
}
async fn stored_image(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
) -> Result<(String, Vec<u8>, String), ApiError> {
    let row=sqlx::query_as::<_,StoredImage>("SELECT image_content_type,image_bytes,image_object_key,image_sha256,image_size,boss_player_name FROM matches WHERE user_id=$1 AND id=$2")
        .bind(user_id).bind(id).fetch_optional(&state.pool).await.map_err(|_|ApiError::internal("original image lookup failed"))?.ok_or_else(not_found)?;
    let bytes = if let Some(bytes) = row.image_bytes {
        bytes
    } else {
        let key = row
            .image_object_key
            .ok_or_else(|| ApiError::internal("original image reference missing"))?;
        storage::checked_record_key(&key, user_id, id).map_err(api_storage_error)?;
        state
            .storage
            .get_private(&key, row.image_size as usize)
            .await
            .map_err(api_storage_error)?
    };
    if bytes.len() != row.image_size as usize || storage::digest(&bytes) != row.image_sha256 {
        return Err(api_storage_error(storage::StorageError::Integrity));
    }
    Ok((row.image_content_type, bytes, row.boss_player_name))
}

async fn update_recognition(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
    boss_player_name: &str,
    mut recognition: Recognition,
) -> Result<MatchRecord, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("recognition update transaction failed"))?;
    if !recognition.completed {
        // An unavailable OCR service provides no replacement data. Keep both manual
        // corrections and the last successful OCR reference, even on an unconfirmed draft.
        let query = format!(
            "UPDATE matches SET ocr_status = 'failed', warnings = $3, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING {RECORD_COLUMNS}"
        );
        let record = sqlx::query_as::<_, MatchRecord>(&query)
            .bind(user_id)
            .bind(id)
            .bind(DbJson(recognition.warnings))
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| ApiError::internal("recognition failure status update failed"))?
            .ok_or_else(not_found)?;
        storage_migration::enqueue_snapshot(
            &mut tx,
            user_id,
            id,
            record.image_object_key.as_deref(),
            &record,
        )
        .await?;
        tx.commit()
            .await
            .map_err(|_| ApiError::internal("recognition failure commit failed"))?;
        return Ok(record);
    }
    let matched = recognition.matching_player(boss_player_name);
    if matched.is_none() {
        recognition.warnings.push(format!(
            "未识别到老板昵称「{boss_player_name}」，请人工核对；不会记录其他队员的结果。"
        ));
    }
    let (name, outcome, amount) = matched.unwrap_or((String::new(), Outcome::Unknown, None));
    // The CASE expressions preserve confirmed manual fields even when confirmation races OCR.
    let query = format!(
        "UPDATE matches SET players = $3, raw_text = $4, warnings = $5, ocr_status = $6, player_name = CASE WHEN confirmed OR manual_result_edited THEN player_name ELSE $7 END, outcome = CASE WHEN confirmed OR manual_result_edited THEN outcome ELSE $8 END, amount = CASE WHEN confirmed OR manual_result_edited THEN amount ELSE $9 END, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING {RECORD_COLUMNS}"
    );
    let record = sqlx::query_as::<_, MatchRecord>(&query)
        .bind(user_id)
        .bind(id)
        .bind(DbJson(recognition.players))
        .bind(recognition.raw_text)
        .bind(DbJson(recognition.warnings))
        .bind("completed")
        .bind(name)
        .bind(outcome.as_str())
        .bind(amount)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| ApiError::internal("recognition update failed"))?
        .ok_or_else(not_found)?;
    storage_migration::enqueue_snapshot(
        &mut tx,
        user_id,
        id,
        record.image_object_key.as_deref(),
        &record,
    )
    .await?;
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("recognition commit failed"))?;
    Ok(record)
}

pub async fn recognize(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    RecordId(id): RecordId,
) -> Result<Json<MatchRecord>, ApiError> {
    let record = find(&state, session.user.id, id).await?;
    validate_record_order(&state, session.user.id, &record).await?;
    let (content_type, bytes, boss_player_name) = stored_image(&state, session.user.id, id).await?;
    let recognition = state.ocr.recognize(Bytes::from(bytes), &content_type).await;
    Ok(Json(
        update_recognition(&state, session.user.id, id, &boss_player_name, recognition).await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalRecognitionInput {
    image_sha256: String,
    recognition: Option<OcrResponse>,
}

pub async fn local_recognition(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    RecordId(id): RecordId,
    ApiJson(input): ApiJson<LocalRecognitionInput>,
) -> Result<Json<MatchRecord>, ApiError> {
    let record = find(&state, session.user.id, id).await?;
    validate_record_order(&state, session.user.id, &record).await?;
    if input.image_sha256 != record.image_sha256 {
        return Err(ApiError::validation("识别结果与原图不一致，请重新识别"));
    }
    let recognition = match input.recognition {
        Some(raw) => Recognition::from_response(raw).map_err(ApiError::validation)?,
        None => {
            Recognition::failure("本地识别暂时不可用，原图已保存；你可以手动填写或稍后重新识别。")
        }
    };
    Ok(Json(
        update_recognition(
            &state,
            session.user.id,
            id,
            &record.boss_player_name,
            recognition,
        )
        .await?,
    ))
}

#[derive(Serialize)]
pub struct MatchStats {
    confirmed_count: i64,
    success_count: i64,
    failed_count: i64,
    draft_count: i64,
    total_amount: i64,
    success_rate: f64,
}

#[derive(FromRow)]
struct StatsRow {
    confirmed_count: i64,
    success_count: i64,
    failed_count: i64,
    draft_count: i64,
    total_amount: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatsQuery {
    order_id: Option<Uuid>,
}

pub async fn stats(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    query: Result<Query<StatsQuery>, QueryRejection>,
) -> Result<Json<MatchStats>, ApiError> {
    let Query(query) = query.map_err(|_| ApiError::validation("订单查询参数不正确"))?;
    let settings = current_settings(&state, session.user.id).await?;
    if let Some(order_id) = query.order_id {
        ledger::binding(&state, session.user.id, order_id).await?;
    }
    if query.order_id.is_none() && settings.boss_id.is_empty() {
        return Ok(Json(MatchStats {
            confirmed_count: 0,
            success_count: 0,
            failed_count: 0,
            draft_count: 0,
            total_amount: 0,
            success_rate: 0.0,
        }));
    }
    let row = sqlx::query_as::<_, StatsRow>("SELECT count(*) FILTER (WHERE confirmed) AS confirmed_count, count(*) FILTER (WHERE confirmed AND outcome = 'success') AS success_count, count(*) FILTER (WHERE confirmed AND outcome = 'failed') AS failed_count, count(*) FILTER (WHERE NOT confirmed) AS draft_count, COALESCE(sum(credited_amount) FILTER (WHERE confirmed),0)::text AS total_amount FROM matches WHERE user_id = $1 AND (($3::uuid IS NOT NULL AND order_id=$3) OR ($3::uuid IS NULL AND boss_id=$2 AND order_id IS NULL))")
        .bind(session.user.id).bind(&settings.boss_id).bind(query.order_id).fetch_one(&state.pool).await.map_err(|_| ApiError::internal("match statistics failed"))?;
    let total_amount = row
        .total_amount
        .parse::<i64>()
        .ok()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "TOTAL_AMOUNT_TOO_LARGE",
                "总金额已超过客户端安全整数范围，暂时无法展示统计",
            )
        })?;
    let success_rate = if row.confirmed_count == 0 {
        0.0
    } else {
        row.success_count as f64 / row.confirmed_count as f64 * 100.0
    };
    Ok(Json(MatchStats {
        confirmed_count: row.confirmed_count,
        success_count: row.success_count,
        failed_count: row.failed_count,
        draft_count: row.draft_count,
        total_amount,
        success_rate,
    }))
}

pub async fn delete(
    State(state): State<AppState>,
    session: AuthenticatedUser,
    RecordId(id): RecordId,
) -> Result<StatusCode, ApiError> {
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|_| ApiError::internal("match deletion transaction failed"))?;
    let row = sqlx::query_as::<_, (Option<Uuid>, Option<String>)>(
        "SELECT order_id,image_object_key FROM matches WHERE user_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(session.user.id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| ApiError::internal("match deletion lookup failed"))?
    .ok_or_else(not_found)?;
    if let Some(order_id) = row.0 {
        ledger::lock_order(&mut tx, session.user.id, order_id).await?;
    }
    let result = sqlx::query("DELETE FROM matches WHERE user_id = $1 AND id = $2")
        .bind(session.user.id)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|_| ApiError::internal("match deletion failed"))?;
    if result.rows_affected() == 0 {
        return Err(not_found());
    }
    if let Some(order_id) = row.0 {
        ledger::validate_order(&mut tx, session.user.id, order_id).await?;
    }
    if let Some(key) = row.1 {
        storage_migration::enqueue_delete(&mut tx, session.user.id, id, &key).await?;
        let snapshot = storage::snapshot_key(&key).map_err(api_storage_error)?;
        storage_migration::enqueue_delete(&mut tx, session.user.id, id, &snapshot).await?;
    }
    tx.commit()
        .await
        .map_err(|_| ApiError::internal("match deletion commit failed"))?;
    Ok(StatusCode::NO_CONTENT)
}
