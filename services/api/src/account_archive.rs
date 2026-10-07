use std::time::Duration;

use serde_json::Value;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::storage::Storage;

const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;

#[derive(FromRow)]
struct Claim {
    user_id: Uuid,
    revision: i64,
    failures: i32,
}

/// One SQL statement gives every relation the same PostgreSQL snapshot.
/// Authentication secrets are deliberately never selected from users/sessions.
pub async fn load_snapshot(
    pool: &PgPool,
    user_id: Uuid,
    revision: i64,
) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT jsonb_build_object(
            'schema_version', 1,
            'revision', $2::bigint,
            'exported_at', now(),
            'account', jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at),
            'bosses', COALESCE((SELECT jsonb_agg(to_jsonb(b) - 'user_id' ORDER BY b.created_at, b.id) FROM bosses b WHERE b.user_id = u.id), '[]'::jsonb),
            'orders', COALESCE((SELECT jsonb_agg(to_jsonb(o) - 'user_id' ORDER BY o.created_at, o.id) FROM service_orders o WHERE o.user_id = u.id), '[]'::jsonb),
            'rental_accounts', COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'user_id' ORDER BY a.created_at, a.id) FROM rental_accounts a WHERE a.user_id = u.id), '[]'::jsonb),
            'rental_sessions', COALESCE((SELECT jsonb_agg(to_jsonb(s) - 'user_id' ORDER BY s.created_at, s.id) FROM rental_sessions s WHERE s.user_id = u.id), '[]'::jsonb),
            'order_templates', COALESCE((SELECT jsonb_agg(to_jsonb(t) - 'user_id' ORDER BY t.created_at, t.id) FROM order_templates t WHERE t.user_id = u.id), '[]'::jsonb),
            'entries', COALESCE((SELECT jsonb_agg(to_jsonb(e) - 'user_id' ORDER BY e.created_at, e.id) FROM ledger_entries e WHERE e.user_id = u.id), '[]'::jsonb),
            'matches', COALESCE((SELECT jsonb_agg(to_jsonb(m) - 'user_id' - 'image_bytes' ORDER BY m.created_at, m.id) FROM matches m WHERE m.user_id = u.id AND m.confirmed), '[]'::jsonb),
            'match_settings', (SELECT to_jsonb(s) - 'user_id' FROM match_settings s WHERE s.user_id = u.id)
        ) FROM users u WHERE u.id = $1
          AND EXISTS (SELECT 1 FROM account_oss_archives a WHERE a.user_id=u.id AND a.revision=$2)"#,
    )
    .bind(user_id)
    .bind(revision)
    .fetch_optional(pool)
    .await
}

/// Claim and commit before network I/O: taking an archive never blocks new ledger writes.
/// Revisions changed while uploading remain pending for the next pass.
pub async fn drain(pool: &PgPool, storage: &Storage, limit: usize) -> anyhow::Result<usize> {
    if !storage.is_oss() {
        return Ok(0);
    }
    let mut uploaded = 0;
    for _ in 0..limit {
        let lease = Uuid::new_v4();
        let claim = sqlx::query_as::<_, Claim>(
            r#"UPDATE account_oss_archives SET lease_token = $1, leased_until = now() + interval '120 seconds'
            WHERE user_id = (SELECT user_id FROM account_oss_archives
                WHERE uploaded_revision < revision AND next_attempt_at <= now()
                AND (leased_until IS NULL OR leased_until < now())
                ORDER BY next_attempt_at, user_id FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING user_id, revision, failures"#,
        )
        .bind(lease)
        .fetch_optional(pool)
        .await?;
        let Some(claim) = claim else { break };
        let result = async {
            let snapshot = load_snapshot(pool, claim.user_id, claim.revision)
                .await?
                .ok_or_else(|| anyhow::anyhow!("archive account no longer exists"))?;
            anyhow::ensure!(
                serde_json::to_vec(&snapshot)?.len() <= MAX_SNAPSHOT_BYTES,
                "account archive exceeds size limit"
            );
            // A revision contains one committed snapshot. Omit the changing export timestamp
            // from its immutable copy so a retry can verify the same already-saved revision.
            let mut immutable = snapshot.clone();
            immutable
                .as_object_mut()
                .expect("snapshot object")
                .remove("exported_at");
            let revision_key = format!(
                "pwtools/users/{}/archives/ledger-{}.json",
                claim.user_id, claim.revision
            );
            let bytes = serde_json::to_vec(&immutable)?;
            let key = format!("pwtools/users/{}/ledger.json", claim.user_id);
            tokio::time::timeout(Duration::from_secs(90), async {
                storage
                    .put_verified(
                        &revision_key,
                        "application/json; charset=utf-8",
                        &bytes,
                        true,
                    )
                    .await?;
                storage.put_json(&key, &snapshot).await
            })
            .await
            .map_err(|_| anyhow::anyhow!("account archive upload timed out"))??;
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if result.is_ok() {
            sqlx::query("UPDATE account_oss_archives SET uploaded_revision = GREATEST(uploaded_revision, $2), failures = 0, lease_token = NULL, leased_until = NULL, last_uploaded_at = now() WHERE user_id = $1 AND lease_token = $3")
                .bind(claim.user_id).bind(claim.revision).bind(lease).execute(pool).await?;
            uploaded += 1;
        } else {
            let seconds = (15 * 2_i64.pow(claim.failures.clamp(0, 8) as u32)).min(3600);
            sqlx::query("UPDATE account_oss_archives SET failures = CASE WHEN revision=$4 THEN LEAST(failures + 1, 1000) ELSE 0 END, lease_token = NULL, leased_until = NULL, next_attempt_at = CASE WHEN revision=$4 THEN now() + make_interval(secs => $2::double precision) ELSE now() END WHERE user_id = $1 AND lease_token = $3")
                .bind(claim.user_id).bind(seconds as f64).bind(lease).bind(claim.revision).execute(pool).await?;
            tracing::warn!("private account archive upload will be retried");
        }
    }
    Ok(uploaded)
}
