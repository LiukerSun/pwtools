//! Explicit live acceptance check, using backend-only environment credentials.
//! Reads only known database object keys and never lists or clears an OSS prefix.
use anyhow::Context;
use pwtools_api::{
    account_archive,
    storage::{Storage, digest, snapshot_key},
};
use sqlx::{PgPool, types::Json};
use uuid::Uuid;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let storage = Storage::from_env()?;
    anyhow::ensure!(
        storage.is_oss(),
        "OSS is required for this explicit acceptance check"
    );
    let pool = PgPool::connect(&std::env::var("DATABASE_URL").context("DATABASE_URL required")?)
        .await
        .context("database unavailable")?;
    let images: Vec<(String, String, i32, Json<serde_json::Value>)> = sqlx::query_as(
        "SELECT image_object_key,image_sha256,image_size,to_jsonb(m)-'image_bytes'-'user_id' FROM matches m WHERE image_object_key IS NOT NULL ORDER BY created_at DESC LIMIT 3"
    ).fetch_all(&pool).await?;
    anyhow::ensure!(
        !images.is_empty(),
        "upload or migrate an image before acceptance"
    );
    for (key, expected, length, metadata) in &images {
        let bytes = storage.get_private(key, *length as usize).await?;
        anyhow::ensure!(
            bytes.len() == *length as usize && digest(&bytes) == *expected,
            "original image integrity check failed"
        );
        let endpoint = std::env::var("OSS_ENDPOINT")?;
        let endpoint = endpoint.trim_start_matches("https://");
        let bucket = std::env::var("OSS_BUCKET")?;
        let status = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?
            .get(format!("https://{bucket}.{endpoint}/{key}"))
            .send()
            .await?
            .status();
        anyhow::ensure!(
            status == reqwest::StatusCode::FORBIDDEN,
            "original image must reject anonymous access"
        );
        let snapshot_bytes = storage
            .get_private(&snapshot_key(key)?, 32 * 1024 * 1024)
            .await?;
        let snapshot: serde_json::Value = serde_json::from_slice(&snapshot_bytes)?;
        anyhow::ensure!(
            snapshot["schema_version"] == 1,
            "record snapshot schema differs"
        );
        for field in [
            "id",
            "order_id",
            "failure_extra_amount",
            "boss_id",
            "boss_player_name",
            "image_sha256",
            "image_size",
            "players",
            "raw_text",
            "warnings",
            "ocr_status",
            "player_name",
            "outcome",
            "amount",
            "fake_amount",
            "net_amount",
            "credited_amount",
            "item_obtained",
            "confirmed",
            "note",
        ] {
            anyhow::ensure!(
                snapshot["record"][field] == metadata.0[field],
                "record snapshot differs from committed metadata"
            );
        }
    }
    let accounts: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT a.user_id,a.uploaded_revision FROM account_oss_archives a WHERE a.uploaded_revision=a.revision AND EXISTS(SELECT 1 FROM service_orders o WHERE o.user_id=a.user_id) ORDER BY EXISTS(SELECT 1 FROM order_templates t WHERE t.user_id=a.user_id) DESC, a.last_uploaded_at DESC LIMIT 3"
    ).fetch_all(&pool).await?;
    anyhow::ensure!(
        !accounts.is_empty(),
        "wait for the private ledger archive worker"
    );
    let mut verified_templates = 0;
    for (user, revision) in &accounts {
        let bytes = storage
            .get_private(
                &format!("pwtools/users/{user}/ledger.json"),
                32 * 1024 * 1024,
            )
            .await?;
        let mut actual: serde_json::Value = serde_json::from_slice(&bytes)?;
        let mut expected = account_archive::load_snapshot(&pool, *user, *revision)
            .await?
            .context("account missing")?;
        actual
            .as_object_mut()
            .context("archive shape")?
            .remove("exported_at");
        let version = storage
            .get_private(
                &format!("pwtools/users/{user}/archives/ledger-{revision}.json"),
                32 * 1024 * 1024,
            )
            .await?;
        let immutable: serde_json::Value = serde_json::from_slice(&version)?;
        anyhow::ensure!(
            immutable == actual,
            "immutable ledger revision differs from current archive"
        );
        expected
            .as_object_mut()
            .context("expected archive shape")?
            .remove("exported_at");
        anyhow::ensure!(
            actual == expected,
            "private ledger archive differs from its committed revision"
        );
        verified_templates += actual["order_templates"]
            .as_array()
            .context("personal templates missing from account archive")?
            .len();
        let text = actual.to_string();
        anyhow::ensure!(
            !text.contains("password_hash")
                && !text.contains("token_hash")
                && !text.contains("image_bytes"),
            "archive contains authentication or binary data"
        );
    }
    let jobs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM object_storage_jobs WHERE operation='snapshot'")
            .fetch_one(&pool)
            .await?;
    println!(
        "verified_private_originals={} verified_record_snapshots={} verified_ledger_archives={} verified_immutable_revisions={} verified_personal_templates={verified_templates} pending_record_snapshots={jobs}",
        images.len(),
        images.len(),
        accounts.len(),
        accounts.len()
    );
    pool.close().await;
    Ok(())
}
