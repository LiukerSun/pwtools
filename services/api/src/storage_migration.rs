//! Database-scoped migration and durable exact-object operations. Never enumerate the bucket.
use crate::{
    error::ApiError,
    storage::{self, Storage, StorageError},
};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection, PgPool, types::Json};
use uuid::Uuid;

pub(crate) fn api_storage_error(error: StorageError) -> ApiError {
    match error {
        StorageError::Integrity | StorageError::InvalidKey => ApiError::new(
            StatusCode::BAD_GATEWAY,
            "IMAGE_INTEGRITY_ERROR",
            "原图完整性校验未通过，请稍后重试",
        ),
        _ => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "IMAGE_STORAGE_UNAVAILABLE",
            "原图存储暂时不可用，原有记录不会被清空，请稍后重试",
        ),
    }
}
pub(crate) async fn stage_original(
    pool: &PgPool,
    owner: Uuid,
    id: Uuid,
    key: &str,
) -> Result<(), ApiError> {
    storage::checked_record_key(key, owner, id).map_err(api_storage_error)?;
    // A cancelled upload can leave an object; delay cleanup until the upload lease expires.
    sqlx::query("INSERT INTO object_storage_jobs(object_key,user_id,match_id,operation,available_at) VALUES($1,$2,$3,'delete',now()+interval '10 minutes') ON CONFLICT(object_key) DO NOTHING")
        .bind(key).bind(owner).bind(id).execute(pool).await.map_err(|_|ApiError::internal("original upload cleanup reservation failed"))?;
    Ok(())
}
pub(crate) async fn retain_original(
    connection: &mut PgConnection,
    key: &str,
) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM object_storage_jobs WHERE object_key=$1 AND operation='delete'")
        .bind(key)
        .execute(connection)
        .await
        .map_err(|_| ApiError::internal("original upload cleanup cancellation failed"))?;
    Ok(())
}
pub(crate) async fn enqueue_snapshot<T: Serialize>(
    connection: &mut PgConnection,
    owner: Uuid,
    id: Uuid,
    image_key: Option<&str>,
    record: &T,
) -> Result<(), ApiError> {
    let Some(image_key) = image_key else {
        return Ok(());
    };
    storage::checked_record_key(image_key, owner, id).map_err(api_storage_error)?;
    let key = storage::snapshot_key(image_key).map_err(api_storage_error)?;
    let payload = serde_json::json!({"schema_version":1,"record":record});
    sqlx::query("INSERT INTO object_storage_jobs(object_key,user_id,match_id,operation,payload) VALUES($1,$2,$3,'snapshot',$4) ON CONFLICT(object_key) DO UPDATE SET operation='snapshot',payload=EXCLUDED.payload,available_at=now(),attempts=0,revision=object_storage_jobs.revision+1,updated_at=now()")
        .bind(key).bind(owner).bind(id).bind(Json(payload)).execute(connection).await.map_err(|_|ApiError::internal("record snapshot scheduling failed"))?;
    Ok(())
}
pub(crate) async fn enqueue_delete(
    connection: &mut PgConnection,
    owner: Uuid,
    id: Uuid,
    key: &str,
) -> Result<(), ApiError> {
    storage::checked_record_key(key, owner, id).map_err(api_storage_error)?;
    sqlx::query("INSERT INTO object_storage_jobs(object_key,user_id,match_id,operation) VALUES($1,$2,$3,'delete') ON CONFLICT(object_key) DO UPDATE SET operation='delete',payload=NULL,available_at=now(),attempts=0,revision=object_storage_jobs.revision+1,updated_at=now()")
        .bind(key).bind(owner).bind(id).execute(connection).await.map_err(|_|ApiError::internal("record object deletion scheduling failed"))?;
    Ok(())
}

#[derive(Default, Serialize)]
pub struct JobReport {
    pub completed: i64,
    pub failed: i64,
}
#[derive(FromRow)]
struct Job {
    object_key: String,
    user_id: Uuid,
    match_id: Uuid,
    operation: String,
    payload: Option<Json<serde_json::Value>>,
    revision: i64,
}
pub async fn drain_jobs(pool: &PgPool, storage: &Storage, limit: i64) -> anyhow::Result<JobReport> {
    anyhow::ensure!(
        (1..=5000).contains(&limit),
        "storage job limit must be between 1 and 5000"
    );
    if !storage.is_oss() {
        return Ok(JobReport::default());
    }
    let mut report = JobReport::default();
    for _ in 0..limit {
        let lease = Uuid::new_v4();
        let Some(job)=sqlx::query_as::<_,Job>("UPDATE object_storage_jobs SET lease_token=$1,lease_until=now()+interval '60 seconds' WHERE object_key=(SELECT object_key FROM object_storage_jobs WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,object_key LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING object_key,user_id,match_id,operation,payload,revision")
            .bind(lease).fetch_optional(pool).await.map_err(|_|anyhow::anyhow!("unable to claim pending object job"))? else{break;};
        let result =
            if storage::checked_record_key(&job.object_key, job.user_id, job.match_id).is_err() {
                Err(StorageError::InvalidKey)
            } else if job.operation == "snapshot" {
                let exists = sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM matches WHERE user_id=$1 AND id=$2)",
                )
                .bind(job.user_id)
                .bind(job.match_id)
                .fetch_one(pool)
                .await
                .map_err(|_| anyhow::anyhow!("unable to verify snapshot record"))?;
                if !exists {
                    Ok(())
                } else if let Some(payload) = &job.payload {
                    storage.put_json(&job.object_key, &payload.0).await
                } else {
                    Err(StorageError::Integrity)
                }
            } else {
                let referenced = sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS(SELECT 1 FROM matches WHERE image_object_key=$1)",
                )
                .bind(&job.object_key)
                .fetch_one(pool)
                .await
                .map_err(|_| anyhow::anyhow!("unable to verify original reference"))?;
                if referenced {
                    Ok(())
                } else {
                    storage.delete_private(&job.object_key).await
                }
            };
        if result.is_ok() {
            sqlx::query("DELETE FROM object_storage_jobs WHERE object_key=$1 AND revision=$2 AND lease_token=$3").bind(&job.object_key).bind(job.revision).bind(lease).execute(pool).await.map_err(|_|anyhow::anyhow!("unable to finish object job"))?;
            report.completed += 1;
        } else {
            sqlx::query("UPDATE object_storage_jobs SET attempts=LEAST(attempts+1,1000000),available_at=now()+interval '30 seconds' WHERE object_key=$1 AND revision=$2 AND lease_token=$3").bind(&job.object_key).bind(job.revision).bind(lease).execute(pool).await.map_err(|_|anyhow::anyhow!("unable to defer object job"))?;
            report.failed += 1;
        }
        // Newer edits retain their job. Release the old lease without postponing the new revision.
        sqlx::query("UPDATE object_storage_jobs SET lease_token=NULL,lease_until=NULL WHERE object_key=$1 AND lease_token=$2").bind(&job.object_key).bind(lease).execute(pool).await.map_err(|_|anyhow::anyhow!("unable to release object job lease"))?;
    }
    Ok(report)
}

#[derive(Default, Serialize, Deserialize)]
pub struct MigrationReport {
    pub migrated: i64,
    pub failed: i64,
    pub remaining: i64,
}
#[derive(FromRow)]
struct LegacyImage {
    id: Uuid,
    user_id: Uuid,
    boss_id: String,
    order_id: Option<Uuid>,
    image_bytes: Vec<u8>,
    image_content_type: String,
    image_sha256: String,
    image_size: i32,
    image_object_key: Option<String>,
}
pub async fn migrate_legacy_images(
    pool: &PgPool,
    storage: &Storage,
    limit: i64,
) -> anyhow::Result<MigrationReport> {
    anyhow::ensure!(storage.is_oss(), "OSS must be configured before migration");
    anyhow::ensure!(
        (1..=1000000).contains(&limit),
        "migration limit must be between 1 and 1000000"
    );
    let mut report = MigrationReport::default();
    let ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM matches WHERE image_bytes IS NOT NULL ORDER BY id LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|_| anyhow::anyhow!("unable to list legacy images"))?;
    for id in ids {
        let mut tx = pool
            .begin()
            .await
            .map_err(|_| anyhow::anyhow!("unable to open image migration transaction"))?;
        let row=sqlx::query_as::<_,LegacyImage>("SELECT id,user_id,boss_id,order_id,image_bytes,image_content_type,image_sha256,image_size,image_object_key FROM matches WHERE id=$1 AND image_bytes IS NOT NULL FOR UPDATE")
            .bind(id).fetch_optional(&mut *tx).await.map_err(|_|anyhow::anyhow!("unable to lock legacy image"))?;
        let Some(row) = row else {
            continue;
        };
        let key = row.image_object_key.clone().unwrap_or_else(|| {
            storage::image_key(
                row.user_id,
                &row.boss_id,
                row.order_id,
                row.id,
                &row.image_content_type,
            )
        });
        let verified = storage::checked_record_key(&key, row.user_id, row.id).is_ok()
            && row.image_bytes.len() == row.image_size as usize
            && storage::digest(&row.image_bytes) == row.image_sha256;
        if !verified {
            report.failed += 1;
            continue;
        }
        // Original bytes remain locked and intact until an immutable private object is read back.
        if storage
            .put_verified(&key, &row.image_content_type, &row.image_bytes, true)
            .await
            .is_err()
        {
            report.failed += 1;
            continue;
        }
        sqlx::query("UPDATE matches SET image_object_key=$2,image_bytes=NULL WHERE id=$1")
            .bind(id)
            .bind(&key)
            .execute(&mut *tx)
            .await
            .map_err(|_| anyhow::anyhow!("unable to commit migrated image reference"))?;
        retain_original(&mut tx, &key)
            .await
            .map_err(|_| anyhow::anyhow!("unable to retain migrated image"))?;
        let record:Json<serde_json::Value>=sqlx::query_scalar("SELECT to_jsonb(m)-'user_id'-'image_bytes'-'image_object_key' FROM matches m WHERE id=$1").bind(id).fetch_one(&mut *tx).await.map_err(|_|anyhow::anyhow!("unable to read migrated record metadata"))?;
        enqueue_snapshot(&mut tx, row.user_id, id, Some(&key), &record.0)
            .await
            .map_err(|_| anyhow::anyhow!("unable to schedule migrated record snapshot"))?;
        tx.commit()
            .await
            .map_err(|_| anyhow::anyhow!("unable to finish migrated image"))?;
        report.migrated += 1;
    }
    report.remaining =
        sqlx::query_scalar("SELECT count(*) FROM matches WHERE image_bytes IS NOT NULL")
            .fetch_one(pool)
            .await
            .map_err(|_| anyhow::anyhow!("unable to count remaining legacy images"))?;
    Ok(report)
}
