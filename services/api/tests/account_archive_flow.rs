use std::str::FromStr;

use pwtools_api::{MIGRATOR, account_archive::load_snapshot};
use sqlx::{PgPool, postgres::PgConnectOptions};
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission"]
async fn private_ledger_archive_tracks_committed_changes_and_excludes_authentication() {
    let options = PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
        .expect("database configuration");
    let admin = PgPool::connect_with(options.clone()).await.expect("admin");
    let database = format!("pwtools_archive_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {database}"))
        .execute(&admin)
        .await
        .expect("create isolated database");
    let pool = PgPool::connect_with(options.database(&database))
        .await
        .expect("isolated database");
    MIGRATOR.run(&pool).await.expect("migrations");
    let outcome = tokio::spawn(check_archive(pool.clone())).await;
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {database} WITH (FORCE)"))
        .execute(&admin)
        .await
        .expect("remove isolated database");
    admin.close().await;
    outcome.expect("archive regression");
}

async fn revision(pool: &PgPool, user: Uuid) -> i64 {
    sqlx::query_scalar("SELECT revision FROM account_oss_archives WHERE user_id = $1")
        .bind(user)
        .fetch_one(pool)
        .await
        .expect("archive revision")
}

async fn check_archive(pool: PgPool) {
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    for (owner, email) in [(a, "archive-a@example.test"), (b, "archive-b@example.test")] {
        sqlx::query(
            "INSERT INTO users(id,email,password_hash) VALUES($1,$2,'private-password-sentinel')",
        )
        .bind(owner)
        .bind(email)
        .execute(&pool)
        .await
        .expect("account");
    }
    assert_eq!(revision(&pool, a).await, 1);
    let boss_a = Uuid::new_v4();
    let boss_b = Uuid::new_v4();
    for (owner, boss, name) in [(a, boss_a, "A 的老板"), (b, boss_b, "B 的老板")] {
        sqlx::query("INSERT INTO bosses(id,user_id,boss_key,display_name,notes) VALUES($1,$2,$3,$4,'长期备注')")
            .bind(boss).bind(owner).bind(boss.to_string()).bind(name)
            .execute(&pool).await.expect("boss");
    }
    let order = Uuid::new_v4();
    sqlx::query("INSERT INTO service_orders(id,user_id,boss_id,title,kind,target_quantity) VALUES($1,$2,$3,'两小时','hourly',120)")
        .bind(order).bind(a).bind(boss_a).execute(&pool).await.expect("order");
    let entry = Uuid::new_v4();
    sqlx::query("INSERT INTO ledger_entries(id,user_id,order_id,kind,quantity,idempotency_key) VALUES($1,$2,$3,'progress',45,$4)")
        .bind(entry).bind(a).bind(order).bind(Uuid::new_v4())
        .execute(&pool).await.expect("progress");
    let current = revision(&pool, a).await;
    assert_eq!(current, 4);
    let mut aborted = pool.begin().await.expect("transaction");
    sqlx::query("UPDATE bosses SET notes='rolled-back-sentinel' WHERE id=$1")
        .bind(boss_a)
        .execute(&mut *aborted)
        .await
        .expect("uncommitted change");
    aborted.rollback().await.expect("rollback");
    assert_eq!(revision(&pool, a).await, current);

    let snapshot = load_snapshot(&pool, a, current)
        .await
        .expect("snapshot")
        .expect("owner");
    assert_eq!(snapshot["account"]["id"], a.to_string());
    assert_eq!(
        snapshot["account"]
            .as_object()
            .expect("account shape")
            .len(),
        3
    );
    assert_eq!(snapshot["bosses"].as_array().expect("bosses").len(), 1);
    assert_eq!(snapshot["bosses"][0]["notes"], "长期备注");
    assert_eq!(snapshot["orders"][0]["target_quantity"], 120);
    assert_eq!(snapshot["entries"][0]["quantity"], 45);
    let text = snapshot.to_string();
    for excluded in [
        "password_hash",
        "private-password-sentinel",
        "sessions",
        "token",
        "image_bytes",
        "archive-b@example.test",
        "B 的老板",
        "rolled-back-sentinel",
    ] {
        assert!(
            !text.contains(excluded),
            "private archive must exclude {excluded}"
        );
    }
    sqlx::query("DELETE FROM ledger_entries WHERE id=$1")
        .bind(entry)
        .execute(&pool)
        .await
        .expect("delete mistaken progress");
    assert_eq!(revision(&pool, a).await, current + 1);
    assert_eq!(revision(&pool, b).await, 2);
    assert!(
        load_snapshot(&pool, a, current)
            .await
            .expect("stale revision")
            .is_none()
    );
    let snapshot = load_snapshot(&pool, a, current + 1)
        .await
        .expect("updated archive")
        .expect("owner");
    assert!(snapshot["entries"].as_array().expect("entries").is_empty());
    assert!(
        load_snapshot(&pool, Uuid::new_v4(), 1)
            .await
            .expect("missing account")
            .is_none()
    );
}
