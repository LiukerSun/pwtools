use pwtools_api::{
    connect_database,
    storage::Storage,
    storage_migration::{cleanup_unconfirmed, drain_jobs, migrate_legacy_images},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".into());
    if command == "help" {
        println!("pwtools-storage migrate|drain|status|cleanup-unconfirmed [--limit N]");
        return Ok(());
    }
    let mut limit = 1000_i64;
    if let Some(flag) = args.next() {
        anyhow::ensure!(flag == "--limit", "expected --limit N");
        limit = args
            .next()
            .ok_or_else(|| anyhow::anyhow!("missing limit"))?
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid limit"))?;
    }
    anyhow::ensure!(args.next().is_none(), "unexpected arguments");
    let storage = Storage::from_env()?;
    anyhow::ensure!(
        storage.is_oss(),
        "OSS must be configured for storage administration"
    );
    let database_url =
        std::env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
    let pool = connect_database(&database_url)
        .await
        .map_err(|_| anyhow::anyhow!("unable to initialize storage database"))?;
    let success = match command.as_str() {
        "cleanup-unconfirmed" => {
            let count = cleanup_unconfirmed(&pool, false, limit.min(5000)).await?;
            println!("removed_unconfirmed={count}");
            true
        }
        "migrate" => {
            let report = migrate_legacy_images(&pool, &storage, limit).await?;
            println!("{}", serde_json::to_string(&report)?);
            report.failed == 0
        }
        "drain" => {
            let report = drain_jobs(&pool, &storage, limit.min(5000)).await?;
            println!("{}", serde_json::to_string(&report)?);
            report.failed == 0
        }
        "status" => {
            let counts:(i64,i64,i64)=sqlx::query_as("SELECT count(*) FILTER(WHERE image_bytes IS NOT NULL),count(*) FILTER(WHERE image_object_key IS NOT NULL),(SELECT count(*) FROM object_storage_jobs) FROM matches").fetch_one(&pool).await.map_err(|_|anyhow::anyhow!("unable to read storage status"))?;
            println!(
                "legacy_images={} oss_images={} pending_object_jobs={}",
                counts.0, counts.1, counts.2
            );
            true
        }
        _ => anyhow::bail!("unknown storage command"),
    };
    pool.close().await;
    anyhow::ensure!(
        success,
        "some private object operations failed; original data or retry jobs are retained"
    );
    Ok(())
}
