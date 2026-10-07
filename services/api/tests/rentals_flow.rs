use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use image::{DynamicImage, ImageFormat, RgbImage};
use pwtools_api::{AppState, MIGRATOR, account_archive::load_snapshot, router};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgConnectOptions};
use std::{io::Cursor, net::SocketAddr, str::FromStr};
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if body.is_some() {
        request = request.header(header::CONTENT_TYPE, "application/json");
    }
    let mut request = request
        .body(Body::from(
            body.map_or(String::new(), |body| body.to_string()),
        ))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        SocketAddr::from_str("127.0.0.29:41900").unwrap(),
    ));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}
async fn ok(app: &Router, method: &str, path: &str, body: Option<Value>, token: &str) -> Value {
    let (status, result) = call(app, method, path, body, Some(token)).await;
    assert!(status.is_success(), "{method} {path}: {status} {result}");
    result
}
fn id(value: &Value) -> &str {
    value["id"].as_str().unwrap()
}
fn rental_input(account: &Value) -> Value {
    json!({"id":Uuid::new_v4(),"account_id":id(account),"coin_per_yuan":500000,"aw_price":300000,"helmet_price":200000,"armor_price":600000,"initial_coins":100000000,"deposit_cents":20000,"started_at":(Utc::now()-Duration::hours(1)).to_rfc3339(),"note":"租前记录"})
}
fn order_input(kind: &str, target: i64) -> Value {
    json!({"title":"租号统计订单","kind":kind,"target_quantity":target,"failure_default_quantity":0,"note":"","price_cents":99800,"participant_count":2,"commission_bps":2000})
}
fn entry(quantity: i64, rental: Option<&str>) -> Value {
    json!({"kind":"progress","quantity":quantity,"occurred_at":null,"note":"实际一局","idempotency_key":Uuid::new_v4(),"rental_session_id":rental})
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission"]
async fn rental_costs_and_round_income_are_independent_private_and_recomputed() {
    let options =
        PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL")).unwrap();
    let admin = PgPool::connect_with(options.clone()).await.unwrap();
    let database = format!("pwtools_rentals_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {database}"))
        .execute(&admin)
        .await
        .unwrap();
    let pool = PgPool::connect_with(options.database(&database))
        .await
        .unwrap();
    MIGRATOR.run(&pool).await.unwrap();
    let result = tokio::task::LocalSet::new()
        .run_until(async { tokio::task::spawn_local(run(pool.clone())).await })
        .await;
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {database} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
    result.expect("rental flow");
}

async fn run(pool: PgPool) {
    let app = router(
        AppState::with_ocr_url(pool.clone(), "http://127.0.0.1:9609")
            .await
            .unwrap(),
        vec![],
    );
    let a = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"rental-a@example.test","password":"long-rental-password"})),
        None,
    )
    .await
    .1;
    let b = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"rental-b@example.test","password":"long-rental-password"})),
        None,
    )
    .await
    .1;
    let token = a["token"].as_str().unwrap();
    let other = b["token"].as_str().unwrap();
    let owner = Uuid::parse_str(a["user"]["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        call(&app, "GET", "/api/rental-accounts", None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let account_body = json!({"id":Uuid::new_v4(),"name":"常租游戏账号","note":""});
    let account = ok(
        &app,
        "POST",
        "/api/rental-accounts",
        Some(account_body.clone()),
        token,
    )
    .await;
    assert_eq!(
        ok(
            &app,
            "POST",
            "/api/rental-accounts",
            Some(account_body),
            token
        )
        .await["id"],
        account["id"]
    );
    let rent_body = rental_input(&account);
    let rental = ok(
        &app,
        "POST",
        "/api/rental-sessions",
        Some(rent_body.clone()),
        token,
    )
    .await;
    assert_eq!(
        ok(
            &app,
            "POST",
            "/api/rental-sessions",
            Some(rent_body.clone()),
            token
        )
        .await["id"],
        rental["id"]
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/rental-sessions",
            Some(rental_input(&account)),
            Some(token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/rental-sessions",
            Some(rental_input(&account)),
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let report_path = format!("/api/rental-sessions/{}/analysis", id(&rental));
    assert_eq!(
        call(&app, "GET", &report_path, None, Some(other)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        ok(&app, "GET", "/api/rental-sessions", None, other).await["items"],
        json!([])
    );
    let boss = ok(
        &app,
        "POST",
        "/api/bosses",
        Some(json!({"display_name":"测试老板","game_id":"boss","game_name":"测试老板","notes":""})),
        token,
    )
    .await;
    let orders_path = format!("/api/bosses/{}/orders", id(&boss));
    let mut input = order_input("hourly", 100);
    input["default_rental_session_id"] = rental["id"].clone();
    let order = ok(&app, "POST", &orders_path, Some(input.clone()), token).await;
    assert_eq!(order["price_cents"], 99800);
    assert_eq!(order["default_rental_session_id"], rental["id"]);
    let entries_path = format!("/api/orders/{}/entries", id(&order));
    let first = entry(1, Some(id(&rental)));
    ok(&app, "POST", &entries_path, Some(first.clone()), token).await;
    ok(&app, "POST", &entries_path, Some(first.clone()), token).await;
    let mut changed = first.clone();
    changed["rental_session_id"] = Value::Null;
    assert_eq!(
        call(&app, "POST", &entries_path, Some(changed), Some(token))
            .await
            .0,
        StatusCode::CONFLICT
    );
    for _ in 0..3 {
        ok(
            &app,
            "POST",
            &entries_path,
            Some(entry(1, Some(id(&rental)))),
            token,
        )
        .await;
    }
    let report = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(report["round_count"], 4);
    assert_eq!(report["pending_order_count"], 1);
    assert_eq!(report["income_cents"], 0);
    assert!(report["profit_cents"].is_null());
    let return_path = format!("/api/rental-sessions/{}/return", id(&rental));
    ok(
        &app,
        "PATCH",
        &return_path,
        Some(json!({"final_cost_cents":13500})),
        token,
    )
    .await;
    let report = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(report["refund_cents"], 6500);
    assert_eq!(report["pending_order_count"], 1);
    assert!(report["profit_cents"].is_null());
    assert_eq!(
        call(
            &app,
            "POST",
            &entries_path,
            Some(entry(1, Some(id(&rental)))),
            Some(token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut again = rental_input(&account);
    again["started_at"] = json!(Utc::now().to_rfc3339());
    again["coin_per_yuan"] = json!(600000);
    let second = ok(&app, "POST", "/api/rental-sessions", Some(again), token).await;
    for _ in 0..4 {
        ok(
            &app,
            "POST",
            &entries_path,
            Some(entry(16, Some(id(&second)))),
            token,
        )
        .await;
    }
    for _ in 0..2 {
        ok(&app, "POST", &entries_path, Some(entry(16, None)), token).await;
    }
    let report = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(report["orders"][0]["total_rounds"], 10);
    assert_eq!(report["orders"][0]["rental_rounds"], 4);
    assert_eq!(report["income_cents"], 15968);
    assert_eq!(report["profit_cents"], 2468);
    assert_eq!(report["pending_order_count"], 0);
    let report2 = ok(
        &app,
        "GET",
        &format!("/api/rental-sessions/{}/analysis", id(&second)),
        None,
        token,
    )
    .await;
    assert_eq!(report2["income_cents"], 15968);
    assert_eq!(report2["round_count"], 4);
    // An adjustment changes completion, but is not an extra game.
    let adjustment = ok(&app,"POST",&entries_path,Some(json!({"kind":"adjustment","quantity":10,"occurred_at":null,"note":"加时","idempotency_key":Uuid::new_v4()})),token).await;
    let report = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(report["round_count"], 4);
    assert_eq!(report["orders"][0]["total_rounds"], 10);
    assert_eq!(report["pending_order_count"], 1);
    ok(
        &app,
        "DELETE",
        &format!("{entries_path}/{}", id(&adjustment)),
        None,
        token,
    )
    .await;
    // Editing finance is allowed after play and automatically updates closed rental reports.
    input["price_cents"] = json!(100000);
    ok(
        &app,
        "PATCH",
        &format!("/api/orders/{}", id(&order)),
        Some(input.clone()),
        token,
    )
    .await;
    assert_eq!(
        ok(&app, "GET", &report_path, None, token).await["income_cents"],
        16000
    );
    for field in ["price_cents", "participant_count", "commission_bps"] {
        let mut invalid = input.clone();
        invalid[field] = json!(-1);
        assert_eq!(
            call(
                &app,
                "PATCH",
                &format!("/api/orders/{}", id(&order)),
                Some(invalid),
                Some(token)
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let other_boss = ok(
        &app,
        "POST",
        "/api/bosses",
        Some(json!({"display_name":"另一用户老板","game_id":"","game_name":"","notes":""})),
        other,
    )
    .await;
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/bosses/{}/orders", id(&other_boss)),
            Some(input),
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let other_order = ok(
        &app,
        "POST",
        &format!("/api/bosses/{}/orders", id(&other_boss)),
        Some(order_input("hourly", 10)),
        other,
    )
    .await;
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/orders/{}/entries", id(&other_order)),
            Some(entry(1, Some(id(&rental)))),
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    // A confirmed failed screenshot is one round; a draft or repeat confirmation isn't another round.
    let mut escort_input = order_input("escort", 100);
    escort_input["price_cents"] = json!(5000);
    escort_input["participant_count"] = json!(1);
    escort_input["commission_bps"] = json!(0);
    let escort = ok(&app, "POST", &orders_path, Some(escort_input), token).await;
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::new(64, 64))
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
    let upload = Request::builder()
        .method("POST")
        .uri("/api/matches/local")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "image/png")
        .header("x-order-id", id(&escort))
        .body(Body::from(png.into_inner()))
        .unwrap();
    let response = app.clone().oneshot(upload).await.unwrap();
    assert!(response.status().is_success());
    let photo: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let photo_path = format!("/api/matches/{}", id(&photo["record"]));
    let played = (Utc::now() - Duration::minutes(30)).to_rfc3339();
    let mut patch = json!({"confirmed":false,"rental_session_id":rental["id"],"played_at":played,"player_name":"测试老板","outcome":"failed","amount":0,"fake_amount":0,"failure_extra_amount":0});
    assert_eq!(
        call(&app, "PATCH", &photo_path, Some(patch.clone()), Some(token))
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        ok(&app, "GET", &report_path, None, token).await["round_count"],
        4
    );
    patch["confirmed"] = json!(true);
    ok(&app, "PATCH", &photo_path, Some(patch.clone()), token).await;
    ok(&app, "PATCH", &photo_path, Some(patch.clone()), token).await;
    let mut success = entry(100, None);
    success["amount"] = json!(100);
    success["fake_amount"] = json!(0);
    success["outcome"] = json!("success");
    success["failure_extra_amount"] = json!(0);
    ok(
        &app,
        "POST",
        &format!("/api/orders/{}/entries", id(&escort)),
        Some(success),
        token,
    )
    .await;
    let report = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(report["round_count"], 5);
    assert_eq!(report["order_count"], 2);
    assert_eq!(report["income_cents"], 18500);
    patch["confirmed"] = json!(false);
    assert_eq!(
        call(&app, "PATCH", &photo_path, Some(patch), Some(token))
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    ok(&app, "DELETE", &photo_path, None, token).await;
    assert_eq!(
        ok(&app, "GET", &report_path, None, token).await["income_cents"],
        16000
    );
    // Legacy orders stay unpriced, and old clients cannot erase existing finances.
    let mut legacy = order_input("hourly", 1);
    for key in ["price_cents", "participant_count", "commission_bps"] {
        legacy.as_object_mut().unwrap().remove(key);
    }
    let old = ok(&app, "POST", &orders_path, Some(legacy), token).await;
    assert!(old["price_cents"].is_null());
    let old_entry = ok(
        &app,
        "POST",
        &format!("/api/orders/{}/entries", id(&old)),
        Some(entry(1, None)),
        token,
    )
    .await;
    assert!(old_entry["rental_session_id"].is_null());
    ok(
        &app,
        "PATCH",
        &return_path,
        Some(json!({"final_cost_cents":25000})),
        token,
    )
    .await;
    let report = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(report["supplement_cents"], 5000);
    assert_eq!(report["profit_cents"], -9000);
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM account_oss_archives WHERE user_id=$1")
            .bind(owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    let snapshot = load_snapshot(&pool, owner, revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot["rental_accounts"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["rental_sessions"].as_array().unwrap().len(), 2);
    assert!(snapshot.get("sessions").is_none());
    assert!(!snapshot.to_string().contains("rental-b@example.test"));
}
