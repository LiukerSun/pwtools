use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use pwtools_api::{AppState, MIGRATOR, account_archive::load_snapshot, router};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgConnectOptions};
use std::{net::SocketAddr, str::FromStr};
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let bytes = if let Some(value) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        value.to_string()
    } else {
        String::new()
    };
    let mut request = builder.body(Body::from(bytes)).expect("request");
    request.extensions_mut().insert(ConnectInfo(
        SocketAddr::from_str("127.0.0.22:41020").expect("test peer"),
    ));
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("JSON")
        },
    )
}
fn input(name: &str, kind: &str, target: i64) -> Value {
    json!({"name":name,"title":"  默认订单标题  ","kind":kind,"target_quantity":target,"failure_default_quantity":0,"note":"  默认备注  ","wager_item_id":null,"wager_item_name":"","wager_expected":"obtained","wager_condition":"appearance"})
}
fn configuration(template: &Value) -> Value {
    let mut result = template.clone();
    for key in ["id", "name", "created_at", "updated_at"] {
        result.as_object_mut().expect("template DTO").remove(key);
    }
    result
}
async fn revision(pool: &PgPool, user: Uuid) -> i64 {
    sqlx::query_scalar("SELECT revision FROM account_oss_archives WHERE user_id=$1")
        .bind(user)
        .fetch_one(pool)
        .await
        .expect("archive revision")
}
async fn create(app: &Router, token: &str, body: Value) -> Value {
    let response = call(app, "POST", "/api/order-templates", Some(body), Some(token)).await;
    assert_eq!(response.0, StatusCode::CREATED, "{}", response.1);
    response.1
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission"]
async fn private_templates_are_complete_isolated_copied_and_archived() {
    let options = PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
        .expect("database configuration");
    let admin = PgPool::connect_with(options.clone()).await.expect("admin");
    let database = format!("pwtools_templates_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {database}"))
        .execute(&admin)
        .await
        .expect("isolated database");
    let pool = PgPool::connect_with(options.database(&database))
        .await
        .expect("isolated pool");
    let result = tokio::task::LocalSet::new()
        .run_until(async { tokio::task::spawn_local(run(pool.clone())).await })
        .await;
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {database} WITH (FORCE)"))
        .execute(&admin)
        .await
        .expect("cleanup isolated database");
    admin.close().await;
    result.expect("template flow must pass");
}
async fn run(pool: PgPool) {
    upgrade(&pool).await;
    // Let the migrator see an already-upgraded released database, as real deployment does.
    MIGRATOR.run(&pool).await.expect("migration metadata");
    let app = router(
        AppState::with_ocr_url(pool.clone(), "http://127.0.0.1:9609")
            .await
            .expect("test state"),
        vec![],
    );
    let a = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"templates-a@example.test","password":"long-template-password"})),
        None,
    )
    .await;
    let b = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"templates-b@example.test","password":"long-template-password"})),
        None,
    )
    .await;
    assert_eq!(a.0, StatusCode::CREATED);
    assert_eq!(b.0, StatusCode::CREATED);
    let token = a.1["token"].as_str().expect("token A");
    let other = b.1["token"].as_str().expect("token B");
    let owner = Uuid::parse_str(a.1["user"]["id"].as_str().expect("owner")).expect("UUID");
    assert_eq!(
        call(&app, "GET", "/api/order-templates", None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let hourly = create(&app, token, input("  常用两小时  ", "hourly", 120)).await;
    assert_eq!(hourly["name"], "常用两小时");
    assert_eq!(hourly["title"], "默认订单标题");
    assert_eq!(hourly["note"], "默认备注");
    assert_eq!(hourly["failure_mode"], "manual");
    assert!(hourly.get("wager_item_id").is_none());
    assert!(hourly.get("boss_id").is_none());
    assert!(hourly.get("user_id").is_none());
    assert!(hourly.get("remaining_quantity").is_none());
    let mut escort = input("低标准补差", "escort", 10_000_000);
    escort["failure_trigger"] = json!("below_standard");
    escort["failure_standard_quantity"] = json!(1_000_000);
    escort["failure_mode"] = json!("shortfall");
    let escort = create(&app, token, escort).await;
    assert_eq!(escort["failure_standard_quantity"], 1_000_000);
    create(&app, token, input("单局五百万", "single_round", 5_000_000)).await;
    assert_eq!(
        call(&app, "GET", "/api/order-templates", None, Some(token))
            .await
            .1["items"]
            .as_array()
            .expect("own list")
            .len(),
        3
    );
    assert_eq!(
        call(&app, "GET", "/api/order-templates", None, Some(other))
            .await
            .1["items"],
        json!([])
    );
    let id = hourly["id"].as_str().expect("template id");
    let path = format!("/api/order-templates/{id}");
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(input("其他账号不能改", "hourly", 240)),
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "DELETE", &path, None, Some(other)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            "/api/order-templates/not-a-uuid",
            Some(input("名称", "hourly", 60)),
            Some(token)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut unknown = input("错误字段", "hourly", 60);
    unknown["boss_id"] = json!(Uuid::new_v4());
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/order-templates",
            Some(unknown),
            Some(token)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for invalid in [
        input(" ", "hourly", 60),
        input(&"名".repeat(81), "hourly", 60),
        input("无目标", "hourly", 0),
        input("缺少物品", "wager", 1),
        input("超范围", "escort", 9_000_000_000_001),
        input("错误类型", "bad-kind", 60),
    ] {
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/order-templates",
                Some(invalid),
                Some(token)
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let mut invalid = input("小时不能补量", "hourly", 60);
    invalid["failure_default_quantity"] = json!(100);
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/order-templates",
            Some(invalid),
            Some(token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for (field, value) in [
        ("wager_item_id", json!("retired-item")),
        ("wager_item_name", json!("不再支持物品")),
        ("wager_expected", json!("not_obtained")),
        ("wager_condition", json!("extracted")),
    ] {
        let mut nonneutral = input("旧物品字段", "hourly", 60);
        nonneutral[field] = value;
        let rejected = call(
            &app,
            "POST",
            "/api/order-templates",
            Some(nonneutral),
            Some(token),
        )
        .await;
        assert_eq!(rejected.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(rejected.1["error"]["code"], "VALIDATION_ERROR");
    }
    let mut incomplete = input("完整PATCH", "hourly", 60);
    incomplete.as_object_mut().expect("object").remove("title");
    assert_eq!(
        call(&app, "PATCH", &path, Some(incomplete), Some(token))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );

    // Opening an order copies configuration; no template FK can rewrite it afterwards.
    let boss = call(
        &app,
        "POST",
        "/api/bosses",
        Some(json!({"display_name":"模板老板","game_id":"","game_name":"","notes":""})),
        Some(token),
    )
    .await;
    assert_eq!(boss.0, StatusCode::CREATED);
    let boss_id = boss.1["id"].as_str().expect("boss");
    let copied = call(
        &app,
        "POST",
        &format!("/api/bosses/{boss_id}/orders"),
        Some(configuration(&hourly)),
        Some(token),
    )
    .await;
    assert_eq!(copied.0, StatusCode::CREATED);
    let order_id = copied.1["id"].as_str().expect("order");
    assert_eq!(call(&app,"POST",&format!("/api/orders/{order_id}/entries"),Some(json!({"kind":"progress","quantity":45,"note":"已服务45分钟","idempotency_key":Uuid::new_v4()})),Some(token)).await.0,StatusCode::CREATED);
    // Template validation is independent, but opening a monetary order still needs a nickname.
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/bosses/{boss_id}/orders"),
            Some(configuration(&escort)),
            Some(token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let before = revision(&pool, owner).await;
    let changed = call(
        &app,
        "PATCH",
        &path,
        Some(input("以后四小时", "hourly", 240)),
        Some(token),
    )
    .await;
    assert_eq!(changed.0, StatusCode::OK);
    assert_eq!(changed.1["target_quantity"], 240);
    assert_eq!(revision(&pool, owner).await, before + 1);
    let unchanged = call(
        &app,
        "GET",
        &format!("/api/orders/{order_id}"),
        None,
        Some(token),
    )
    .await;
    assert_eq!(unchanged.1["target_quantity"], 120);
    assert_eq!(unchanged.1["remaining_quantity"], 75);
    let snapshot = load_snapshot(&pool, owner, before + 1)
        .await
        .expect("snapshot")
        .expect("owner snapshot");
    assert_eq!(
        snapshot["order_templates"]
            .as_array()
            .expect("templates")
            .len(),
        3
    );
    assert!(
        snapshot["order_templates"]
            .as_array()
            .expect("templates")
            .iter()
            .any(|t| t["name"] == "以后四小时" && t["target_quantity"] == 240)
    );
    assert!(!snapshot.to_string().contains("password_hash"));
    assert!(!snapshot.to_string().contains("templates-b@example.test"));
    assert!(
        snapshot["order_templates"]
            .as_array()
            .expect("templates")
            .iter()
            .all(|t| t.get("user_id").is_none() && t.get("boss_id").is_none())
    );
    let mut aborted = pool.begin().await.expect("aborted transaction");
    sqlx::query("UPDATE order_templates SET name='rolled-back-template' WHERE id=$1")
        .bind(Uuid::parse_str(id).expect("UUID"))
        .execute(&mut *aborted)
        .await
        .expect("uncommitted template");
    aborted.rollback().await.expect("rollback");
    assert_eq!(revision(&pool, owner).await, before + 1);
    assert_eq!(
        call(&app, "DELETE", &path, None, Some(token)).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(revision(&pool, owner).await, before + 2);
    assert_eq!(
        call(&app, "DELETE", &path, None, Some(token)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/orders/{order_id}"),
            None,
            Some(token)
        )
        .await
        .1["remaining_quantity"],
        75
    );
    assert!(
        load_snapshot(&pool, owner, before + 1)
            .await
            .expect("stale revision")
            .is_none()
    );
    let after = load_snapshot(&pool, owner, before + 2)
        .await
        .expect("deleted archive")
        .expect("owner");
    assert_eq!(
        after["order_templates"]
            .as_array()
            .expect("templates")
            .len(),
        2
    );
    retired_templates_are_hidden_and_preserved(&app, &pool, token, owner).await;
}

async fn retired_templates_are_hidden_and_preserved(
    app: &Router,
    pool: &PgPool,
    token: &str,
    owner: Uuid,
) {
    assert_eq!(
        call(app, "GET", "/api/catalog/items", None, Some(token))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO order_templates(id,user_id,name,title,kind,target_quantity,wager_item_id,wager_item_name,wager_expected,wager_condition) VALUES($1,$2,'历史模板','历史订单','wager',1,'retired-item','历史名称','not_obtained','extracted')")
        .bind(id).bind(owner).execute(pool).await.expect("released template fixture");
    let before: Value = sqlx::query_scalar("SELECT to_jsonb(t) FROM order_templates t WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("raw historical template");
    let list = call(app, "GET", "/api/order-templates", None, Some(token)).await;
    assert_eq!(list.0, StatusCode::OK);
    assert!(
        list.1["items"]
            .as_array()
            .expect("visible templates")
            .iter()
            .all(|item| item["kind"] != "wager")
    );
    let path = format!("/api/order-templates/{id}");
    for (method, body) in [
        ("PATCH", Some(input("不能改成小时", "hourly", 60))),
        ("DELETE", None),
    ] {
        let result = call(app, method, &path, body, Some(token)).await;
        assert_eq!(result.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(result.1["error"]["code"], "ORDER_TYPE_UNSUPPORTED");
    }
    let after: Value = sqlx::query_scalar("SELECT to_jsonb(t) FROM order_templates t WHERE id=$1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("unchanged historical template");
    assert_eq!(after, before);
    let current = revision(pool, owner).await;
    let snapshot = load_snapshot(pool, owner, current)
        .await
        .expect("private archive")
        .expect("owner");
    let historical = snapshot["order_templates"]
        .as_array()
        .expect("templates")
        .iter()
        .find(|item| item["id"] == id.to_string())
        .expect("retired template remains archived");
    assert_eq!(historical["kind"], "wager");
    assert_eq!(historical["wager_item_id"], "retired-item");
    assert_eq!(historical["wager_item_name"], "历史名称");
    assert_eq!(historical["wager_expected"], "not_obtained");
    assert_eq!(historical["wager_condition"], "extracted");
}

async fn upgrade(pool: &PgPool) {
    // Apply the actual released schema using migrator metadata, then migrate a real account.
    let mut released = sqlx::migrate::Migrator {
        migrations: MIGRATOR
            .migrations
            .iter()
            .filter(|m| m.version < 202610040008)
            .cloned()
            .collect::<Vec<_>>()
            .into(),
        ..sqlx::migrate::Migrator::DEFAULT
    };
    released.set_locking(true);
    released.run(pool).await.expect("released migrations");
    let owner = Uuid::new_v4();
    let boss = Uuid::new_v4();
    let order = Uuid::new_v4();
    let lease = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,'pre-template@example.test','private-sentinel')").bind(owner).execute(pool).await.expect("old account");
    sqlx::query("INSERT INTO bosses(id,user_id,boss_key,display_name) VALUES($1,$2,$3,'旧老板')")
        .bind(boss)
        .bind(owner)
        .bind(boss.to_string())
        .execute(pool)
        .await
        .expect("old boss");
    sqlx::query("INSERT INTO service_orders(id,user_id,boss_id,title,kind,target_quantity) VALUES($1,$2,$3,'旧两小时','hourly',120)").bind(order).bind(owner).bind(boss).execute(pool).await.expect("old order");
    sqlx::query("INSERT INTO ledger_entries(id,user_id,order_id,kind,quantity,idempotency_key) VALUES($1,$2,$3,'progress',45,$4)").bind(Uuid::new_v4()).bind(owner).bind(order).bind(Uuid::new_v4()).execute(pool).await.expect("old event");
    let before = revision(pool, owner).await;
    sqlx::query("UPDATE account_oss_archives SET uploaded_revision=revision,lease_token=$2,leased_until=now()+interval '1 minute' WHERE user_id=$1").bind(owner).bind(lease).execute(pool).await.expect("active old immutable archive");
    MIGRATOR.run(pool).await.expect("008 upgrade");
    assert_eq!(revision(pool, owner).await, before + 1);
    let preserved: (i64, Option<Uuid>) = sqlx::query_as(
        "SELECT uploaded_revision,lease_token FROM account_oss_archives WHERE user_id=$1",
    )
    .bind(owner)
    .fetch_one(pool)
    .await
    .expect("archive lease");
    assert_eq!(preserved, (before, Some(lease)));
    assert!(
        load_snapshot(pool, owner, before)
            .await
            .expect("stale immutable revision")
            .is_none()
    );
    let snapshot = load_snapshot(pool, owner, before + 1)
        .await
        .expect("new shape")
        .expect("old owner");
    assert_eq!(snapshot["order_templates"], json!([]));
    assert_eq!(snapshot["orders"][0]["target_quantity"], 120);
    assert_eq!(snapshot["entries"][0]["quantity"], 45);
    assert!(!snapshot.to_string().contains("private-sentinel"));
}
