use axum::{
    Router,
    body::{Body, Bytes},
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
    routing::post,
};
use http_body_util::BodyExt;
use image::{DynamicImage, ImageFormat, RgbImage};
use pwtools_api::{AppState, MIGRATOR, router};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgConnectOptions};
use std::{io::Cursor, net::SocketAddr, str::FromStr};
use tower::ServiceExt;
use uuid::Uuid;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Vec<u8>,
    content: Option<&str>,
    token: Option<&str>,
    order: Option<&str>,
) -> (StatusCode, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(content) = content {
        builder = builder.header(header::CONTENT_TYPE, content);
    }
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if let Some(order) = order {
        builder = builder.header("x-order-id", order);
    }
    let mut request = builder.body(Body::from(body)).expect("request");
    request.extensions_mut().insert(ConnectInfo(
        SocketAddr::from_str("127.0.0.10:41002").expect("peer"),
    ));
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    (status, bytes)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let (status, bytes) = request(
        app,
        method,
        path,
        body.as_ref()
            .map_or_else(Vec::new, |v| v.to_string().into_bytes()),
        body.as_ref().map(|_| "application/json"),
        token,
        None,
    )
    .await;
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).expect("JSON")
        },
    )
}
async fn mock_ocr(bytes: Bytes) -> axum::Json<Value> {
    assert!(!bytes.is_empty());
    if bytes.as_ref() == image(3) {
        return axum::Json(
            json!({"outcome":"failed","players":[{"player_name":"团团吃大饼","outcome":"failed","amount":null,"confidence":0.99}],"raw_text":"撤离失败","warnings":[]}),
        );
    }
    axum::Json(
        json!({"outcome":"success","players":[{"player_name":"团团吃大饼","outcome":"success","amount":3314221,"confidence":0.99},{"player_name":"另一位老板","outcome":"success","amount":100,"confidence":0.98}],"raw_text":"撤离成功 带出价值 3,314,221","warnings":[]}),
    )
}
fn image(seed: u8) -> Vec<u8> {
    let rgb = RgbImage::from_fn(64, 64, |x, y| image::Rgb([seed, x as u8, y as u8]));
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(rgb)
        .write_to(&mut out, ImageFormat::Png)
        .expect("PNG");
    out.into_inner()
}
async fn upload(app: &Router, token: &str, order: Option<&str>, seed: u8) -> (StatusCode, Value) {
    let (status, body) = request(
        app,
        "POST",
        "/api/matches",
        image(seed),
        Some("image/png"),
        Some(token),
        order,
    )
    .await;
    (status, serde_json::from_slice(&body).expect("upload JSON"))
}
fn id(value: &Value) -> &str {
    value["id"].as_str().expect("ID")
}
async fn order(
    app: &Router,
    token: &str,
    boss: &str,
    kind: &str,
    target: i64,
    failure: i64,
) -> Value {
    let response=call(app,"POST",&format!("/api/bosses/{boss}/orders"),Some(json!({"title":"测试订单","kind":kind,"target_quantity":target,"failure_default_quantity":failure,"note":"约定"})),Some(token)).await;
    assert_eq!(response.0, StatusCode::CREATED, "{}", response.1);
    response.1
}
async fn balance(app: &Router, token: &str, order: &str) -> Value {
    let response = call(
        app,
        "GET",
        &format!("/api/orders/{order}"),
        None,
        Some(token),
    )
    .await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.1);
    response.1
}
async fn entry(
    app: &Router,
    token: &str,
    order: &str,
    kind: &str,
    quantity: i64,
) -> (StatusCode, Value) {
    call(app,"POST",&format!("/api/orders/{order}/entries"),Some(json!({"kind":kind,"quantity":quantity,"fake_amount":0,"occurred_at":null,"note":"手工记账","idempotency_key":Uuid::new_v4()})),Some(token)).await
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission"]
async fn boss_orders_derive_balances_from_manual_entries_and_confirmed_screenshots() {
    let options = PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
        .expect("URL");
    let admin = PgPool::connect_with(options.clone())
        .await
        .expect("admin database");
    let name = format!("pwtools_ledger_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .expect("isolated database");
    let pool = PgPool::connect_with(options.database(&name))
        .await
        .expect("test database");
    MIGRATOR.run(&pool).await.expect("migrations");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("OCR listener");
    let url = format!("http://{}", listener.local_addr().expect("OCR address"));
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/recognize", post(mock_ocr)))
            .await
            .expect("OCR server");
    });
    let app = router(
        AppState::with_ocr_url(pool.clone(), &url)
            .await
            .expect("state"),
        vec![],
    );
    let outcome = tokio::task::LocalSet::new()
        .run_until(async { tokio::task::spawn_local(run_flow(app.clone(), pool.clone())).await })
        .await;
    drop(app);
    server.abort();
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .expect("remove test database");
    admin.close().await;
    outcome.expect("ledger flow must pass");
}

async fn run_flow(app: Router, pool: PgPool) {
    migration_preserves_historical_originals(&pool).await;
    let alice=call(&app,"POST","/api/auth/register",Some(json!({"email":"ledger-alice@example.test","password":"long-test-password","display_name":"Alice"})),None).await;
    let bob=call(&app,"POST","/api/auth/register",Some(json!({"email":"ledger-bob@example.test","password":"long-test-password","display_name":"Bob"})),None).await;
    assert_eq!(alice.0, StatusCode::CREATED);
    assert_eq!(bob.0, StatusCode::CREATED);
    let token = alice.1["token"].as_str().expect("Alice token");
    let other = bob.1["token"].as_str().expect("Bob token");
    assert_eq!(
        call(&app, "GET", "/api/bosses", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let boss=call(&app,"POST","/api/bosses",Some(json!({"display_name":"团团老板","game_id":"game-001","game_name":"团团吃大饼","notes":"晚上有空，勿忘补量"})),Some(token)).await;
    assert_eq!(boss.0, StatusCode::CREATED);
    let boss_id = id(&boss.1);
    let hourly_boss=call(&app,"POST","/api/bosses",Some(json!({"display_name":"小时单老板","game_id":"","game_name":"","notes":"可不填写截图昵称"})),Some(token)).await;
    assert_eq!(hourly_boss.0, StatusCode::CREATED);
    let hourly_boss_id = id(&hourly_boss.1);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/bosses/{boss_id}"),
            None,
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", "/api/bosses", None, Some(other)).await.1["items"],
        json!([])
    );
    assert_eq!(
        call(&app, "GET", "/api/bosses?q=补量", None, Some(token))
            .await
            .1["items"]
            .as_array()
            .expect("search")
            .len(),
        1
    );
    let edited=call(&app,"PATCH",&format!("/api/bosses/{boss_id}"),Some(json!({"display_name":"团团老板","game_id":"game-001","game_name":"团团吃大饼","notes":"熟客，喜欢航天基地"})),Some(token)).await;
    assert_eq!(edited.1["notes"], "熟客，喜欢航天基地");
    let missing_nickname=call(&app,"POST",&format!("/api/bosses/{hourly_boss_id}/orders"),Some(json!({"title":"护航","kind":"escort","target_quantity":100,"failure_default_quantity":0,"note":""})),Some(token)).await;
    assert_eq!(missing_nickname.0, StatusCode::UNPROCESSABLE_ENTITY);
    let hourly = order(&app, token, hourly_boss_id, "hourly", 120, 0).await;
    let hourly_id = id(&hourly);
    let work = entry(&app, token, hourly_id, "progress", 45).await;
    assert_eq!(work.0, StatusCode::CREATED);
    assert_eq!(
        balance(&app, token, hourly_id).await["remaining_quantity"],
        75
    );
    assert_eq!(
        entry(&app, token, hourly_id, "failure", 1).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        upload(&app, token, Some(hourly_id), 1).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("/api/orders/{hourly_id}/entries/{}", id(&work.1)),
            None,
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Retry keys preserve one event, and a key cannot silently change its quantity.
    let retry = json!({"kind":"progress","quantity":5,"occurred_at":null,"note":"重试","idempotency_key":Uuid::new_v4()});
    let first = call(
        &app,
        "POST",
        &format!("/api/orders/{hourly_id}/entries"),
        Some(retry.clone()),
        Some(token),
    )
    .await;
    let second = call(
        &app,
        "POST",
        &format!("/api/orders/{hourly_id}/entries"),
        Some(retry.clone()),
        Some(token),
    )
    .await;
    assert_eq!(first.0, StatusCode::CREATED);
    assert_eq!(second.0, StatusCode::OK);
    assert_eq!(first.1["id"], second.1["id"]);
    let mut changed = retry;
    changed["quantity"] = json!(6);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/orders/{hourly_id}/entries"),
            Some(changed),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        balance(&app, token, hourly_id).await["remaining_quantity"],
        70
    );
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("/api/orders/{hourly_id}/entries/{}", id(&first.1)),
            None,
            Some(token)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        balance(&app, token, hourly_id).await["remaining_quantity"],
        75
    );

    let escort = order(&app, token, boss_id, "escort", 10_000_000, 1_000_000).await;
    let escort_id = id(&escort);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/orders/{escort_id}"),
            None,
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/orders?boss_id={boss_id}"),
            None,
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for route in [
        format!("/api/orders/{escort_id}/entries"),
        format!("/api/matches?order_id={escort_id}"),
        format!("/api/matches/stats?order_id={escort_id}"),
    ] {
        assert_eq!(
            call(&app, "GET", &route, None, Some(other)).await.0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        upload(&app, other, Some(escort_id), 2).await.0,
        StatusCode::NOT_FOUND
    );
    let success = upload(&app, token, Some(escort_id), 2).await;
    assert_eq!(success.0, StatusCode::CREATED);
    let success_id = id(&success.1["record"]);
    let success_path = format!("/api/matches/{success_id}");
    assert_eq!(success.1["record"]["boss_id"], boss_id);
    assert_eq!(
        balance(&app, token, escort_id).await["completed_quantity"],
        0,
        "drafts do not count"
    );
    let confirmed = call(
        &app,
        "PATCH",
        &success_path,
        Some(json!({"fake_amount":0,"confirmed":true})),
        Some(token),
    )
    .await;
    assert_eq!(confirmed.0, StatusCode::OK);
    assert_eq!(confirmed.1["amount"], 3314221);
    assert_eq!(
        call(
            &app,
            "PATCH",
            &success_path,
            Some(json!({"fake_amount":0,"confirmed":true})),
            Some(token)
        )
        .await
        .0,
        StatusCode::OK
    );
    let failed = upload(&app, token, Some(escort_id), 3).await;
    let failed_id = id(&failed.1["record"]);
    let failed_path = format!("/api/matches/{failed_id}");
    assert_eq!(failed.1["record"]["outcome"], "failed");
    assert_eq!(
        failed.1["record"]["failure_extra_amount"], 1_000_000,
        "a new OCR failure draft keeps the order default"
    );
    assert_eq!(failed.1["record"]["confirmed"], false);
    assert_eq!(
        balance(&app, token, escort_id).await["failure_quantity"],
        0,
        "draft defaults do not increase the debt"
    );
    let explicit_zero = call(
        &app,
        "PATCH",
        &failed_path,
        Some(json!({"outcome":"failed","failure_extra_amount":0,"confirmed":false})),
        Some(token),
    )
    .await;
    assert_eq!(explicit_zero.0, StatusCode::OK);
    assert_eq!(explicit_zero.1["failure_extra_amount"], 0);
    assert_eq!(
        call(&app, "GET", &failed_path, None, Some(token)).await.1["failure_extra_amount"],
        0
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{failed_path}/recognize"),
            None,
            Some(token)
        )
        .await
        .1["failure_extra_amount"],
        0,
        "OCR must not replace an explicit zero draft with the default"
    );
    let zero_confirmation = call(
        &app,
        "PATCH",
        &failed_path,
        Some(json!({"amount":0,"failure_extra_amount":0,"fake_amount":0,"confirmed":true})),
        Some(token),
    )
    .await;
    assert_eq!(zero_confirmation.0, StatusCode::OK);
    assert_eq!(zero_confirmation.1["failure_extra_amount"], 0);
    assert_eq!(
        balance(&app, token, escort_id).await["remaining_quantity"],
        6_685_779
    );
    let failure = call(
        &app,
        "PATCH",
        &failed_path,
        Some(json!({"player_name":"团团吃大饼","outcome":"failed","amount":0,"failure_extra_amount":1_000_000,"fake_amount":0,"confirmed":true})),
        Some(token),
    )
    .await;
    assert_eq!(failure.0, StatusCode::OK);
    assert_eq!(failure.1["failure_extra_amount"], 1_000_000);
    let current = balance(&app, token, escort_id).await;
    assert_eq!(current["remaining_quantity"], 7_685_779);
    assert_eq!(current["completed_quantity"], 3_314_221);
    assert_eq!(current["failure_quantity"], 1_000_000);
    assert_eq!(current["record_count"], 2);
    let events = call(
        &app,
        "GET",
        &format!("/api/orders/{escort_id}/entries?page=1&page_size=1"),
        None,
        Some(token),
    )
    .await;
    assert_eq!(events.1["total"], 2);
    assert_eq!(events.1["items"][0]["source"], "screenshot");
    assert!(events.1["items"][0]["match_id"].is_string());
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("/api/orders/{escort_id}/entries/{success_id}"),
            None,
            Some(token)
        )
        .await
        .0,
        StatusCode::NOT_FOUND,
        "screenshots must be edited via their record"
    );
    assert_eq!(
        upload(&app, token, Some(escort_id), 2).await.1["duplicate"],
        true
    );
    assert_eq!(
        balance(&app, token, escort_id).await["remaining_quantity"],
        7_685_779
    );
    let another = order(&app, token, boss_id, "escort", 500, 0).await;
    let another_id = id(&another);
    assert_eq!(
        upload(&app, token, Some(another_id), 2).await.1["error"]["code"],
        "ORDER_IMAGE_CONFLICT"
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &success_path,
            Some(json!({"order_id":another_id})),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("{success_path}/image"),
            vec![],
            None,
            Some(token),
            None
        )
        .await
        .1,
        image(2)
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &success_path,
            Some(json!({"amount":3_000_000})),
            Some(token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        balance(&app, token, escort_id).await["remaining_quantity"],
        8_000_000
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &success_path,
            Some(json!({"confirmed":false})),
            Some(token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        balance(&app, token, escort_id).await["remaining_quantity"],
        11_000_000
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &success_path,
            Some(json!({"fake_amount":0,"confirmed":true})),
            Some(token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "DELETE", &failed_path, None, Some(token))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        balance(&app, token, escort_id).await["remaining_quantity"],
        7_000_000
    );
    let adjustment = entry(&app, token, escort_id, "adjustment", -1_000_000).await;
    assert_eq!(adjustment.0, StatusCode::CREATED);
    assert_eq!(
        balance(&app, token, escort_id).await["remaining_quantity"],
        6_000_000
    );
    assert_eq!(
        entry(&app, token, escort_id, "adjustment", -10_000_000)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        balance(&app, token, escort_id).await["total_quantity"],
        9_000_000
    );
    assert_eq!(
        entry(&app, token, escort_id, "progress", 6_000_100).await.0,
        StatusCode::CREATED
    );
    let finished = balance(&app, token, escort_id).await;
    assert_eq!(finished["remaining_quantity"], 0);
    assert_eq!(finished["excess_quantity"], 100);
    assert_eq!(finished["status"], "completed");

    // Legacy originals are visible until an explicit patch assigns a matching boss order.
    assert_eq!(
        call(
            &app,
            "PATCH",
            "/api/matches/settings",
            Some(json!({"boss_id":"old-boss","boss_player_name":"团团吃大饼"})),
            Some(token)
        )
        .await
        .0,
        StatusCode::OK
    );
    let old = upload(&app, token, None, 4).await;
    assert_eq!(old.0, StatusCode::CREATED);
    let old_id = id(&old.1["record"]);
    let legacy = call(&app, "GET", "/api/bosses?q=old-boss", None, Some(token))
        .await
        .1;
    assert_eq!(legacy["items"].as_array().expect("legacy boss").len(), 1);
    let legacy_boss = id(&legacy["items"][0]);
    let legacy_order = order(&app, token, legacy_boss, "escort", 500, 0).await;
    let legacy_order_id = id(&legacy_order);
    let duplicate = upload(&app, token, Some(legacy_order_id), 4).await;
    assert_eq!(duplicate.0, StatusCode::OK);
    assert_eq!(duplicate.1["record"]["order_id"], Value::Null);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/matches?order_id={legacy_order_id}"),
            None,
            Some(token)
        )
        .await
        .1["total"],
        0
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &format!("/api/matches/{old_id}"),
            Some(json!({"order_id":escort_id})),
            Some(token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &format!("/api/matches/{old_id}"),
            Some(json!({"order_id":legacy_order_id,"fake_amount":0,"confirmed":true})),
            Some(token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", "/api/matches", None, Some(token)).await.1["total"],
        0
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/matches?order_id={legacy_order_id}"),
            None,
            Some(token)
        )
        .await
        .1["total"],
        1
    );
    assert_eq!(
        call(&app, "GET", "/api/matches/stats", None, Some(token))
            .await
            .1["confirmed_count"],
        0
    );

    // Aggregate boundaries are checked after a per-order lock, so racing writes cannot cross them.
    let limit = order(&app, token, boss_id, "escort", 1, 0).await;
    let limit_id = id(&limit);
    let (large, small) = tokio::join!(
        entry(&app, token, limit_id, "progress", 9_000_000_000_000),
        entry(&app, token, limit_id, "progress", 1)
    );
    assert!(matches!(
        (large.0, small.0),
        (StatusCode::CREATED, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::CREATED)
    ));
    assert_eq!(
        entry(&app, token, limit_id, "progress", i64::MIN).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        entry(&app, token, limit_id, "progress", 0).await.0,
        StatusCode::CREATED
    );
    let capped = order(&app, token, boss_id, "escort", 9_000_000_000_000, 0).await;
    let capped_id = id(&capped);
    assert_eq!(
        entry(&app, token, capped_id, "failure", 1).await.0,
        StatusCode::CONFLICT
    );
    let cap_image = upload(&app, token, Some(capped_id), 5).await;
    let cap_path = format!("/api/matches/{}", id(&cap_image.1["record"]));
    assert_eq!(
        call(
            &app,
            "PATCH",
            &cap_path,
            Some(json!({"outcome":"failed","amount":0,"fake_amount":0,"confirmed":true,"failure_extra_amount":1})),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "GET", &cap_path, None, Some(token)).await.1["confirmed"],
        false,
        "invalid confirmation rolls back atomically"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM ledger_entries WHERE order_id=$1")
        .bind(Uuid::parse_str(limit_id).expect("order UUID"))
        .fetch_one(&pool)
        .await
        .expect("stored events");
    assert_eq!(count, 2, "a net-zero monetary round remains a stored event");
    let new_boss=call(&app,"POST","/api/bosses",Some(json!({"display_name":"四类型老板","game_id":"new-types","game_name":"团团吃大饼","notes":"独立规则验收"})),Some(token)).await;
    assert_eq!(new_boss.0, StatusCode::CREATED);
    current_order_types(&app, &pool, token, other, hourly_boss_id, id(&new_boss.1)).await;
}

async fn new_order(app: &Router, token: &str, boss: &str, kind: &str, extra: Value) -> Value {
    let mut body = json!({"title":"新类型订单","kind":kind,"target_quantity":1000,"failure_default_quantity":0,"note":"","wager_item_id":null,"wager_item_name":"","wager_expected":"obtained","wager_condition":"appearance"});
    for (key, value) in extra.as_object().expect("order options") {
        body[key] = value.clone();
    }
    let response = call(
        app,
        "POST",
        &format!("/api/bosses/{boss}/orders"),
        Some(body),
        Some(token),
    )
    .await;
    assert_eq!(response.0, StatusCode::CREATED, "{}", response.1);
    response.1
}
async fn round(
    app: &Router,
    token: &str,
    order: &str,
    gross: i64,
    fake: Option<i64>,
    outcome: &str,
    extra: Option<i64>,
) -> (StatusCode, Value) {
    call(app,"POST",&format!("/api/orders/{order}/entries"),Some(json!({"kind":"progress","quantity":gross,"amount":gross,"fake_amount":fake,"outcome":outcome,"failure_extra_amount":extra,"note":"一场","idempotency_key":Uuid::new_v4()})),Some(token)).await
}
async fn current_order_types(
    app: &Router,
    pool: &PgPool,
    token: &str,
    other: &str,
    no_nickname: &str,
    boss: &str,
) {
    // Monetary events require an explicit deduction, including zero; failed gross is retained.
    let escort=new_order(app,token,boss,"escort",json!({"failure_trigger":"below_standard","failure_standard_quantity":500,"failure_mode":"fixed","failure_default_quantity":100})).await;
    let order_id = id(&escort);
    assert_eq!(
        round(app, token, order_id, 400, None, "success", None)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        round(app, token, order_id, 400, Some(401), "success", None)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let retry_body = json!({"kind":"progress","quantity":400,"amount":400,"fake_amount":100,"outcome":"success","note":"可安全重试的场次","idempotency_key":Uuid::new_v4(),"item_obtained":null});
    let credited = call(
        app,
        "POST",
        &format!("/api/orders/{order_id}/entries"),
        Some(retry_body.clone()),
        Some(token),
    )
    .await;
    assert_eq!(credited.0, StatusCode::CREATED, "{}", credited.1);
    assert_eq!(credited.1["amount"], 400);
    assert_eq!(credited.1["fake_amount"], 100);
    assert_eq!(credited.1["net_amount"], 300);
    assert_eq!(credited.1["quantity"], 300);
    assert_eq!(credited.1["credited_amount"], 300);
    assert_eq!(credited.1["failure_extra_amount"], 100);
    for item_result in [true, false] {
        let mut retired = retry_body.clone();
        retired["idempotency_key"] = json!(Uuid::new_v4());
        retired["item_obtained"] = json!(item_result);
        assert_eq!(
            call(
                app,
                "POST",
                &format!("/api/orders/{order_id}/entries"),
                Some(retired),
                Some(token)
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let failed = round(app, token, order_id, 700, Some(250), "failed", None).await;
    assert_eq!(failed.0, StatusCode::CREATED);
    assert_eq!(failed.1["amount"], 700);
    assert_eq!(failed.1["net_amount"], 450);
    assert_eq!(failed.1["credited_amount"], 0);
    let current = balance(app, token, order_id).await;
    assert_eq!(current["remaining_quantity"], 900);
    assert_eq!(current["record_count"], 2);
    // Only future fixed defaults change. Existing events are not reinterpreted.
    let mut body = json!({"title":"可以改名字","kind":"escort","target_quantity":1000,"failure_default_quantity":200,"note":"新默认","failure_trigger":"below_standard","failure_standard_quantity":500,"failure_mode":"fixed"});
    let edited = call(
        app,
        "PATCH",
        &format!("/api/orders/{order_id}"),
        Some(body.clone()),
        Some(token),
    )
    .await;
    assert_eq!(edited.0, StatusCode::OK, "{}", edited.1);
    assert_eq!(edited.1["failure_quantity"], 200);
    assert_eq!(edited.1["configuration_locked"], true);
    let replay = call(
        app,
        "POST",
        &format!("/api/orders/{order_id}/entries"),
        Some(retry_body.clone()),
        Some(token),
    )
    .await;
    assert_eq!(
        replay.0,
        StatusCode::OK,
        "default changes do not change an idempotent request"
    );
    assert_eq!(replay.1["failure_extra_amount"], 100);
    let mut changed_retry = retry_body;
    changed_retry["note"] = json!("同标识但不同备注");
    assert_eq!(
        call(
            app,
            "POST",
            &format!("/api/orders/{order_id}/entries"),
            Some(changed_retry),
            Some(token)
        )
        .await
        .1["error"]["code"],
        "IDEMPOTENCY_CONFLICT"
    );
    body["failure_standard_quantity"] = json!(600);
    assert_eq!(
        call(
            app,
            "PATCH",
            &format!("/api/orders/{order_id}"),
            Some(body),
            Some(token)
        )
        .await
        .1["error"]["code"],
        "ORDER_CONFIGURATION_LOCKED"
    );
    assert_eq!(
        round(app, token, order_id, 300, Some(0), "success", None)
            .await
            .1["failure_extra_amount"],
        200
    );

    let old_fixed = upload(app, token, Some(order_id), 155).await;
    let fixed_path = format!("/api/matches/{}", id(&old_fixed.1["record"]));
    let fixed_confirmed = call(
        app,
        "PATCH",
        &fixed_path,
        Some(json!({"amount":400,"fake_amount":100,"outcome":"success","confirmed":true})),
        Some(token),
    )
    .await;
    assert_eq!(fixed_confirmed.0, StatusCode::OK);
    assert_eq!(fixed_confirmed.1["failure_extra_amount"], 200);
    let newer_default = json!({"title":"新默认300","kind":"escort","target_quantity":1000,"failure_default_quantity":300,"note":"","failure_trigger":"below_standard","failure_standard_quantity":500,"failure_mode":"fixed"});
    assert_eq!(
        call(
            app,
            "PATCH",
            &format!("/api/orders/{order_id}"),
            Some(newer_default),
            Some(token)
        )
        .await
        .0,
        StatusCode::OK
    );
    let saved_note=call(app,"PATCH",&fixed_path,Some(json!({"amount":400,"fake_amount":100,"outcome":"success","confirmed":true,"failure_extra_amount":200,"note":"只改备注，保留本场补量"})),Some(token)).await;
    assert_eq!(saved_note.0, StatusCode::OK);
    assert_eq!(saved_note.1["failure_extra_amount"], 200);
    assert_eq!(
        call(
            app,
            "PATCH",
            &fixed_path,
            Some(json!({"amount":350})),
            Some(token)
        )
        .await
        .1["failure_extra_amount"],
        200,
        "correcting a historical fixed round uses its original default"
    );
    let shortfall=new_order(app,token,boss,"escort",json!({"failure_trigger":"failed_below_standard","failure_standard_quantity":500,"failure_mode":"shortfall"})).await;
    let sid = id(&shortfall);
    assert_eq!(
        round(app, token, sid, 400, Some(50), "success", None)
            .await
            .1["failure_extra_amount"],
        0
    );
    assert_eq!(
        round(app, token, sid, 400, Some(100), "failed", None)
            .await
            .1["failure_extra_amount"],
        200
    );
    assert_eq!(
        round(app, token, sid, 600, Some(0), "failed", None).await.1["failure_extra_amount"],
        0
    );
    let manual = new_order(app, token, boss, "escort", json!({})).await;
    let mid = id(&manual);
    assert_eq!(
        round(app, token, mid, 600, Some(0), "failed", None).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        round(app, token, mid, 600, Some(0), "failed", Some(0))
            .await
            .0,
        StatusCode::CREATED
    );

    // Two sub-threshold rounds cannot fulfil one single-round guarantee.
    let single = new_order(app, token, boss, "single_round", json!({})).await;
    let single_id = id(&single);
    assert_eq!(
        round(app, token, single_id, 700, Some(100), "success", Some(0))
            .await
            .0,
        StatusCode::CREATED
    );
    assert_eq!(
        round(app, token, single_id, 600, Some(0), "success", Some(0))
            .await
            .0,
        StatusCode::CREATED
    );
    let two = balance(app, token, single_id).await;
    assert_eq!(two["completed_quantity"], 600);
    assert_eq!(two["best_round_quantity"], 600);
    assert_eq!(two["remaining_quantity"], 1000);
    assert_eq!(two["status"], "active");
    assert_eq!(
        entry(app, token, single_id, "adjustment", 1).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        entry(app, token, single_id, "failure", 1).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        round(app, token, single_id, 1200, Some(0), "failed", Some(0))
            .await
            .1["credited_amount"],
        0
    );
    let best = round(app, token, single_id, 1200, Some(100), "success", Some(0)).await;
    assert_eq!(best.0, StatusCode::CREATED);
    assert_eq!(balance(app, token, single_id).await["status"], "completed");
    assert_eq!(
        call(
            app,
            "DELETE",
            &format!("/api/orders/{single_id}/entries/{}", id(&best.1)),
            None,
            Some(token)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(balance(app, token, single_id).await["status"], "active");

    // Screenshots preserve gross/fake/manual results across OCR, and settle exactly once.
    let screenshot = upload(app, token, Some(single_id), 151).await;
    assert_eq!(screenshot.0, StatusCode::CREATED);
    let path = format!("/api/matches/{}", id(&screenshot.1["record"]));
    assert_eq!(screenshot.1["record"]["fake_amount"], Value::Null);
    assert_eq!(
        call(
            app,
            "PATCH",
            &path,
            Some(json!({"confirmed":true})),
            Some(token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let corrected = call(
        app,
        "PATCH",
        &path,
        Some(json!({"amount":900,"fake_amount":100,"outcome":"success","confirmed":false,"item_obtained":null})),
        Some(token),
    )
    .await;
    assert_eq!(corrected.0, StatusCode::OK);
    assert_eq!(corrected.1["net_amount"], 800);
    for result in [true, false] {
        assert_eq!(
            call(
                app,
                "PATCH",
                &path,
                Some(json!({"item_obtained":result,"confirmed":true})),
                Some(token)
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    assert_eq!(
        call(app, "POST", &format!("{path}/recognize"), None, Some(token))
            .await
            .1["amount"],
        900
    );
    let confirmed = call(
        app,
        "PATCH",
        &path,
        Some(json!({"confirmed":true,"item_obtained":null})),
        Some(token),
    )
    .await;
    assert_eq!(confirmed.0, StatusCode::OK);
    assert_eq!(
        balance(app, token, single_id).await["best_round_quantity"],
        800
    );
    assert_eq!(
        call(
            app,
            "PATCH",
            &path,
            Some(json!({"failure_extra_amount":1})),
            Some(token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let draft_locked = new_order(app, token, boss, "single_round", json!({})).await;
    let lid = id(&draft_locked);
    upload(app, token, Some(lid), 152).await;
    let change = json!({"title":"草稿也锁规则","kind":"escort","target_quantity":1000,"failure_default_quantity":0,"note":""});
    assert_eq!(
        call(
            app,
            "PATCH",
            &format!("/api/orders/{lid}"),
            Some(change),
            Some(token)
        )
        .await
        .1["error"]["code"],
        "ORDER_CONFIGURATION_LOCKED"
    );
    let totals = call(
        app,
        "GET",
        &format!("/api/bosses/{boss}"),
        None,
        Some(token),
    )
    .await;
    assert_eq!(totals.0, StatusCode::OK);
    assert_eq!(
        totals.1["remaining_amount"], 2600,
        "only escort orders are currency debt"
    );
    assert_eq!(totals.1["pending_single_round_count"], 2);
    assert!(totals.1.get("pending_wager_count").is_none());
    retired_orders_are_hidden_and_preserved(app, pool, token, other, no_nickname).await;
}

async fn retired_orders_are_hidden_and_preserved(
    app: &Router,
    pool: &PgPool,
    token: &str,
    other: &str,
    boss: &str,
) {
    let owner: Uuid = sqlx::query_scalar("SELECT user_id FROM bosses WHERE id=$1")
        .bind(Uuid::parse_str(boss).expect("boss UUID"))
        .fetch_one(pool)
        .await
        .expect("fixture owner");
    let before = call(
        app,
        "GET",
        &format!("/api/bosses/{boss}"),
        None,
        Some(token),
    )
    .await
    .1;
    let order_id = Uuid::new_v4();
    let entry_id = Uuid::new_v4();
    let match_id = Uuid::new_v4();
    let historical_image = image(156);
    sqlx::query("INSERT INTO service_orders(id,user_id,boss_id,title,kind,target_quantity,wager_item_id,wager_item_name,wager_expected,wager_condition) VALUES($1,$2,$3,'历史结果订单','wager',1,'retired-item','历史物品名','not_obtained','extracted')")
        .bind(order_id).bind(owner).bind(Uuid::parse_str(boss).expect("boss UUID")).execute(pool).await.expect("released order fixture");
    sqlx::query("INSERT INTO ledger_entries(id,user_id,order_id,kind,quantity,idempotency_key,item_obtained,outcome,note) VALUES($1,$2,$3,'item_result',0,$4,false,'failed','历史结果')")
        .bind(entry_id).bind(owner).bind(order_id).bind(Uuid::new_v4()).execute(pool).await.expect("released item result");
    sqlx::query("INSERT INTO matches(id,user_id,boss_id,boss_player_name,order_id,original_name,image_content_type,image_bytes,image_sha256,image_width,image_height,image_size,item_obtained,ocr_status) VALUES($1,$2,$3,'历史昵称',$4,'historical.png','image/png',$5,$6,64,64,$7,true,'failed')")
        .bind(match_id).bind(owner).bind(boss).bind(order_id).bind(&historical_image).bind(format!("{:x}", Sha256::digest(&historical_image))).bind(i32::try_from(historical_image.len()).expect("fixture image size")).execute(pool).await.expect("released evidence fixture");
    let original: Value =
        sqlx::query_scalar("SELECT to_jsonb(o) FROM service_orders o WHERE id=$1")
            .bind(order_id)
            .fetch_one(pool)
            .await
            .expect("raw order");
    let after = call(
        app,
        "GET",
        &format!("/api/bosses/{boss}"),
        None,
        Some(token),
    )
    .await
    .1;
    for field in [
        "active_order_count",
        "remaining_minutes",
        "remaining_amount",
        "pending_single_round_count",
    ] {
        assert_eq!(
            before[field], after[field],
            "retired orders never change {field}"
        );
    }
    let orders = call(
        app,
        "GET",
        &format!("/api/orders?boss_id={boss}"),
        None,
        Some(token),
    )
    .await;
    assert_eq!(orders.0, StatusCode::OK);
    assert!(
        orders.1["items"]
            .as_array()
            .expect("visible orders")
            .iter()
            .all(|item| item["kind"] != "wager")
    );
    for (field, value) in [
        ("wager_item_id", json!("retired-item")),
        ("wager_item_name", json!("不再支持物品")),
        ("wager_expected", json!("not_obtained")),
        ("wager_condition", json!("extracted")),
    ] {
        let mut legacy = json!({"title":"旧客户端","kind":"hourly","target_quantity":60,"failure_default_quantity":0,"note":"","wager_item_id":null,"wager_item_name":"","wager_expected":"obtained","wager_condition":"appearance"});
        legacy[field] = value;
        let rejected = call(
            app,
            "POST",
            &format!("/api/bosses/{boss}/orders"),
            Some(legacy),
            Some(token),
        )
        .await;
        assert_eq!(rejected.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(rejected.1["error"]["code"], "VALIDATION_ERROR");
    }
    let body = json!({"title":"retired","kind":"wager","target_quantity":1,"failure_default_quantity":0,"note":""});
    let new = call(
        app,
        "POST",
        &format!("/api/bosses/{boss}/orders"),
        Some(body),
        Some(token),
    )
    .await;
    assert_eq!(new.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(new.1["error"]["code"], "ORDER_TYPE_UNSUPPORTED");
    let replacement = json!({"title":"不能改成金额","kind":"escort","target_quantity":1000,"failure_default_quantity":0,"note":""});
    let paths = [
        ("GET", format!("/api/orders/{order_id}"), None),
        (
            "PATCH",
            format!("/api/orders/{order_id}"),
            Some(replacement),
        ),
        ("GET", format!("/api/orders/{order_id}/entries"), None),
        (
            "POST",
            format!("/api/orders/{order_id}/entries"),
            Some(
                json!({"kind":"progress","quantity":1,"note":"","idempotency_key":Uuid::new_v4()}),
            ),
        ),
        (
            "DELETE",
            format!("/api/orders/{order_id}/entries/{entry_id}"),
            None,
        ),
        ("GET", format!("/api/matches?order_id={order_id}"), None),
        (
            "GET",
            format!("/api/matches/stats?order_id={order_id}"),
            None,
        ),
        ("GET", format!("/api/matches/{match_id}"), None),
        ("GET", format!("/api/matches/{match_id}/image"), None),
        (
            "PATCH",
            format!("/api/matches/{match_id}"),
            Some(json!({"note":"禁止修改"})),
        ),
        ("POST", format!("/api/matches/{match_id}/recognize"), None),
        ("DELETE", format!("/api/matches/{match_id}"), None),
    ];
    for (method, path, body) in paths {
        let result = call(app, method, &path, body, Some(token)).await;
        assert_eq!(
            result.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{method} {path}: {}",
            result.1
        );
        assert_eq!(result.1["error"]["code"], "ORDER_TYPE_UNSUPPORTED");
    }
    assert_eq!(
        call(
            app,
            "GET",
            &format!("/api/orders/{order_id}"),
            None,
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        upload(app, token, Some(&order_id.to_string()), 150).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            app,
            "PATCH",
            "/api/matches/settings",
            Some(json!({"boss_id":boss,"boss_player_name":"历史昵称"})),
            Some(token)
        )
        .await
        .0,
        StatusCode::OK
    );
    let records_before: i64 = sqlx::query_scalar("SELECT count(*) FROM matches WHERE user_id=$1")
        .bind(owner)
        .fetch_one(pool)
        .await
        .expect("records before duplicate");
    let duplicate = upload(app, token, None, 156).await;
    assert_eq!(duplicate.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(duplicate.1["error"]["code"], "ORDER_TYPE_UNSUPPORTED");
    let records_after: i64 = sqlx::query_scalar("SELECT count(*) FROM matches WHERE user_id=$1")
        .bind(owner)
        .fetch_one(pool)
        .await
        .expect("records after duplicate");
    assert_eq!(
        records_after, records_before,
        "retired duplicate never creates another record"
    );
    assert_eq!(
        call(
            app,
            "GET",
            &format!("/api/matches/{match_id}/image"),
            None,
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let unchanged: Value =
        sqlx::query_scalar("SELECT to_jsonb(o) FROM service_orders o WHERE id=$1")
            .bind(order_id)
            .fetch_one(pool)
            .await
            .expect("unchanged raw order");
    assert_eq!(unchanged, original);
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM account_oss_archives WHERE user_id=$1")
            .bind(owner)
            .fetch_one(pool)
            .await
            .expect("archive revision");
    let snapshot = pwtools_api::account_archive::load_snapshot(pool, owner, revision)
        .await
        .expect("archive")
        .expect("owner");
    let orders = snapshot["orders"].as_array().expect("raw orders");
    let old = orders
        .iter()
        .find(|item| item["id"] == order_id.to_string())
        .expect("retired order archived");
    assert_eq!(old["kind"], "wager");
    assert_eq!(old["wager_item_name"], "历史物品名");
    assert_eq!(old["wager_expected"], "not_obtained");
    assert_eq!(old["wager_condition"], "extracted");
    assert!(
        snapshot["entries"]
            .as_array()
            .expect("raw entries")
            .iter()
            .any(|item| item["id"] == entry_id.to_string() && item["item_obtained"] == false)
    );
    assert!(
        snapshot["matches"]
            .as_array()
            .expect("raw evidence")
            .iter()
            .any(|item| item["id"] == match_id.to_string() && item["item_obtained"] == true)
    );
    let original_bytes: Vec<u8> = sqlx::query_scalar("SELECT image_bytes FROM matches WHERE id=$1")
        .bind(match_id)
        .fetch_one(pool)
        .await
        .expect("original evidence retained");
    assert_eq!(original_bytes, historical_image);
}

async fn migration_preserves_historical_originals(pool: &PgPool) {
    // Replay the released schema in a separate transactional schema before the upgrade.
    let mut tx = pool.begin().await.expect("migration fixture transaction");
    sqlx::raw_sql(
        "CREATE SCHEMA legacy_ledger_fixture; SET LOCAL search_path TO legacy_ledger_fixture",
    )
    .execute(&mut *tx)
    .await
    .expect("fixture schema");
    for source in [
        include_str!("../migrations/202610030001_initial.sql"),
        include_str!("../migrations/202610040001_matches.sql"),
        include_str!("../migrations/202610040002_boss_settings.sql"),
    ] {
        sqlx::raw_sql(source)
            .execute(&mut *tx)
            .await
            .expect("released schema");
    }
    let alice = Uuid::new_v4();
    let bob = Uuid::new_v4();
    for (owner, email) in [
        (alice, "migration-alice@example.test"),
        (bob, "migration-bob@example.test"),
    ] {
        sqlx::query("INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,'fixture-hash','Fixture')")
            .bind(owner).bind(email).execute(&mut *tx).await.expect("migration user");
    }
    sqlx::query("INSERT INTO match_settings(user_id,boss_id,boss_player_name) VALUES($1,'shared-old-key','最新昵称')")
        .bind(alice).execute(&mut *tx).await.expect("migration settings");
    let original = image(90);
    for (owner, key, name, digest) in [
        (alice, "shared-old-key", "旧昵称", "1"),
        (bob, "shared-old-key", "其他用户昵称", "2"),
        (alice, "history-only-key", "只有截图的老板", "3"),
        (alice, "", "", "4"),
    ] {
        sqlx::query("INSERT INTO matches(id,user_id,boss_id,boss_player_name,original_name,image_content_type,image_bytes,image_sha256,image_width,image_height,image_size,ocr_status) VALUES($1,$2,$3,$4,'original.png','image/png',$5,lpad($6,64,'0'),64,64,$7,'failed')")
            .bind(Uuid::new_v4()).bind(owner).bind(key).bind(name).bind(&original).bind(digest).bind(original.len() as i32)
            .execute(&mut *tx).await.expect("legacy original");
    }
    sqlx::raw_sql(include_str!("../migrations/202610040003_ledger.sql"))
        .execute(&mut *tx)
        .await
        .expect("ledger upgrade");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM bosses")
        .fetch_one(&mut *tx)
        .await
        .expect("migrated bosses");
    assert_eq!(
        count, 3,
        "owner keys stay isolated; empty legacy snapshots are retained without inventing a boss"
    );
    let name: String = sqlx::query_scalar(
        "SELECT game_name FROM bosses WHERE user_id=$1 AND boss_key='shared-old-key'",
    )
    .bind(alice)
    .fetch_one(&mut *tx)
    .await
    .expect("latest nickname");
    assert_eq!(name, "最新昵称");
    let images: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT image_bytes FROM matches WHERE order_id IS NULL AND failure_extra_amount=0",
    )
    .fetch_all(&mut *tx)
    .await
    .expect("originals retained");
    assert_eq!(images.len(), 4);
    assert!(images.iter().all(|bytes| bytes == &original));
    // Upgrade a released ledger, with a leased private JSON write, through the new types.
    let old_boss: Uuid =
        sqlx::query_scalar("SELECT id FROM bosses WHERE user_id=$1 AND boss_key='shared-old-key'")
            .bind(alice)
            .fetch_one(&mut *tx)
            .await
            .expect("old boss");
    let old_order = Uuid::new_v4();
    sqlx::query("INSERT INTO service_orders(id,user_id,boss_id,title,kind,target_quantity,failure_default_quantity) VALUES($1,$2,$3,'旧护航','escort',1000,100)")
        .bind(old_order).bind(alice).bind(old_boss).execute(&mut *tx).await.expect("released order");
    for (kind, qty) in [("progress", 300), ("failure", 100), ("adjustment", -50)] {
        sqlx::query("INSERT INTO ledger_entries(id,user_id,order_id,kind,quantity,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(Uuid::new_v4()).bind(alice).bind(old_order).bind(kind).bind(qty).bind(Uuid::new_v4()).execute(&mut *tx).await.expect("released event");
    }
    let old_match: Uuid =
        sqlx::query_scalar("SELECT id FROM matches WHERE user_id=$1 AND boss_id='shared-old-key'")
            .bind(alice)
            .fetch_one(&mut *tx)
            .await
            .expect("released match");
    sqlx::query("UPDATE matches SET order_id=$2,confirmed=true,player_name='旧昵称',outcome='success',amount=250 WHERE id=$1")
        .bind(old_match).bind(old_order).execute(&mut *tx).await.expect("released confirmation");
    for source in [
        include_str!("../migrations/202610040004_private_account.sql"),
        include_str!("../migrations/202610040005_oss_storage.sql"),
        include_str!("../migrations/202610040006_account_oss_archive.sql"),
    ] {
        sqlx::raw_sql(source)
            .execute(&mut *tx)
            .await
            .expect("released storage migrations");
    }
    let original_key = pwtools_api::storage::image_key(
        alice,
        "shared-old-key",
        Some(old_order),
        old_match,
        "image/png",
    );
    let json_key = pwtools_api::storage::snapshot_key(&original_key).expect("record key");
    sqlx::query("UPDATE matches SET image_object_key=$2 WHERE id=$1")
        .bind(old_match)
        .bind(&original_key)
        .execute(&mut *tx)
        .await
        .expect("released OSS reference");
    let lease = Uuid::new_v4();
    sqlx::query("INSERT INTO object_storage_jobs(object_key,user_id,match_id,operation,payload,revision,lease_token,lease_until) VALUES($1,$2,$3,'snapshot','{}',4,$4,now()+interval '1 minute')")
        .bind(&json_key).bind(alice).bind(old_match).bind(lease).execute(&mut *tx).await.expect("old leased snapshot");
    let before: i64 =
        sqlx::query_scalar("SELECT revision FROM account_oss_archives WHERE user_id=$1")
            .bind(alice)
            .fetch_one(&mut *tx)
            .await
            .expect("archive revision");
    sqlx::raw_sql(include_str!("../migrations/202610040007_order_types.sql"))
        .execute(&mut *tx)
        .await
        .expect("four type upgrade");
    let migrated: Value =
        sqlx::query_scalar("SELECT to_jsonb(m)-'image_bytes' FROM matches m WHERE id=$1")
            .bind(old_match)
            .fetch_one(&mut *tx)
            .await
            .expect("upgraded match");
    assert_eq!(migrated["amount"], 250);
    assert_eq!(migrated["fake_amount"], 0);
    assert_eq!(migrated["net_amount"], 250);
    assert_eq!(migrated["credited_amount"], 250);
    assert_eq!(migrated["confirmed"], true);
    assert_eq!(migrated["image_object_key"], original_key);
    assert_eq!(migrated["failure_default_snapshot"], 100);
    let unchanged: Vec<u8> = sqlx::query_scalar("SELECT image_bytes FROM matches WHERE id=$1")
        .bind(old_match)
        .fetch_one(&mut *tx)
        .await
        .expect("retained original");
    assert_eq!(unchanged, original);
    let remaining:i64=sqlx::query_scalar("SELECT (target_quantity+(SELECT sum(failure_extra_amount) FROM ledger_entries WHERE order_id=$1)+(SELECT sum(quantity) FROM ledger_entries WHERE order_id=$1 AND kind='adjustment')-(SELECT sum(credited_amount) FROM ledger_entries WHERE order_id=$1)-(SELECT sum(credited_amount) FROM matches WHERE order_id=$1 AND confirmed))::bigint FROM service_orders WHERE id=$1")
        .bind(old_order).fetch_one(&mut *tx).await.expect("unchanged released balance");
    assert_eq!(remaining, 500);
    let job: Value =
        sqlx::query_scalar("SELECT to_jsonb(j) FROM object_storage_jobs j WHERE object_key=$1")
            .bind(&json_key)
            .fetch_one(&mut *tx)
            .await
            .expect("updated JSON job");
    assert_eq!(job["revision"], 5);
    assert_eq!(job["lease_token"], lease.to_string());
    assert_eq!(job["payload"]["record"]["fake_amount"], 0);
    assert_eq!(job["payload"]["record"]["credited_amount"], 250);
    assert!(job["payload"]["record"].get("image_bytes").is_none());
    let after: i64 =
        sqlx::query_scalar("SELECT revision FROM account_oss_archives WHERE user_id=$1")
            .bind(alice)
            .fetch_one(&mut *tx)
            .await
            .expect("fresh archive revision");
    assert!(after > before);
    tx.rollback().await.expect("remove migration fixtures");
}
