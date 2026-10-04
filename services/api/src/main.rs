use std::{net::SocketAddr, time::Duration};

use anyhow::Context;
use axum::http::HeaderValue;
use pwtools_api::{AppState, connect_database, router};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("pwtools_api=info,tower_http=info")),
        )
        .init();
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let host = std::env::var("API_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let port: u16 = std::env::var("API_PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse()
        .context("API_PORT must be a number between 1 and 65535")?;
    let origins =
        std::env::var("ALLOWED_ORIGINS").unwrap_or_else(|_| "http://localhost:5173".into());
    let origins = origins
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| -> anyhow::Result<HeaderValue> {
            anyhow::ensure!(
                (value.starts_with("http://")
                    || value.starts_with("https://")
                    || value.starts_with("app://"))
                    && value != "*",
                "ALLOWED_ORIGINS must contain explicit origins"
            );
            HeaderValue::from_str(value).context("ALLOWED_ORIGINS contains an invalid header value")
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        !origins.is_empty(),
        "ALLOWED_ORIGINS requires at least one origin"
    );
    let pool = connect_database(&database_url)
        .await
        .context("unable to initialize PostgreSQL")?;
    let state = AppState::new(pool.clone()).await?;
    let storage = state.storage();
    let archive_pool = pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if pwtools_api::storage_migration::drain_jobs(&archive_pool, &storage, 50)
                .await
                .is_err()
            {
                tracing::warn!("private screenshot synchronization will be retried");
            }
            if pwtools_api::account_archive::drain(&archive_pool, &storage, 20)
                .await
                .is_err()
            {
                tracing::warn!("private ledger synchronization will be retried");
            }
        }
    });
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600));
        loop {
            interval.tick().await;
            if sqlx::query("DELETE FROM sessions WHERE expires_at <= now()")
                .execute(&pool)
                .await
                .is_err()
            {
                tracing::warn!("expired session cleanup failed");
            }
        }
    });
    let address: SocketAddr = format!("{host}:{port}")
        .parse()
        .context("API_HOST must be an IP address")?;
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .context("unable to bind API address")?;
    tracing::info!(%address, "API is ready");
    axum::serve(
        listener,
        router(state, origins).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let terminate = async {
            if let Ok(mut signal) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                signal.recv().await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    tracing::info!("API is shutting down");
}
