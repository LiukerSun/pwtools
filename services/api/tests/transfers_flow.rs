use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use chrono::{Duration, Utc};
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
        SocketAddr::from_str("127.0.0.41:41900").unwrap(),
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
    let (status, value) = call(app, method, path, body, Some(token)).await;
    assert!(status.is_success(), "{method} {path}: {status} {value}");
    value
}

fn id(value: &Value) -> &str {
    value["id"].as_str().unwrap()
}
fn transfer(order: &Value) -> &Value {
    order["transfer_history"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
}
fn order_input(kind: &str) -> Value {
    json!({"title":"转单测试","kind":kind,"target_quantity":1000,"failure_default_quantity":0,"note":"", "price_cents":99800,"participant_count":2,"commission_bps":2000})
}
fn entry(kind: &str, quantity: i64, rental: Option<&str>) -> Value {
    json!({"kind":kind,"quantity":quantity,"amount":if kind == "progress" { quantity } else { 0 },"fake_amount":0,"occurred_at":null,"note":"", "idempotency_key":Uuid::new_v4(),"rental_session_id":rental})
}
fn create_input(order: &Value, prepaid: bool, bps: Option<i32>) -> Value {
    json!({"id":Uuid::new_v4(),"prepaid":prepaid,"progress_bps":bps,"note":"转出快照", "expected_updated_at":order["updated_at"]})
}
fn action_input(order: &Value, action: &str) -> Value {
    json!({"id":Uuid::new_v4(),"transfer_id":transfer(order)["id"],"action":action,"note":"", "expected_updated_at":order["updated_at"]})
}
async fn act(app: &Router, order: &Value, action: &str, extra: Value, token: &str) -> Value {
    let mut body = action_input(order, action);
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    ok(
        app,
        "POST",
        &format!("/api/orders/{}/transfer-action", id(order)),
        Some(body),
        token,
    )
    .await
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission"]
async fn transfer_cash_refunds_locking_idempotency_and_archives() {
    let options =
        PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL")).unwrap();
    let admin = PgPool::connect_with(options.clone()).await.unwrap();
    let database = format!("pwtools_transfers_test_{}", Uuid::new_v4().simple());
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
    result.expect("transfer flow");
}

async fn run(pool: PgPool) {
    let app = router(
        AppState::with_ocr_url(pool.clone(), "http://127.0.0.1:9609")
            .await
            .unwrap(),
        vec![],
    );
    let account = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"transfer@example.test","password":"long-transfer-password"})),
        None,
    )
    .await
    .1;
    let other = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"transfer-other@example.test","password":"long-transfer-password"})),
        None,
    )
    .await
    .1;
    let token = account["token"].as_str().unwrap();
    let other = other["token"].as_str().unwrap();
    let owner = Uuid::parse_str(account["user"]["id"].as_str().unwrap()).unwrap();
    let boss = ok(
        &app,
        "POST",
        "/api/bosses",
        Some(json!({"display_name":"转单老板","game_id":"","game_name":"转单老板","notes":""})),
        token,
    )
    .await;
    let orders = format!("/api/bosses/{}/orders", id(&boss));
    let rental_account = ok(
        &app,
        "POST",
        "/api/rental-accounts",
        Some(json!({"id":Uuid::new_v4(),"name":"转单租号","note":""})),
        token,
    )
    .await;
    let rental = ok(&app, "POST", "/api/rental-sessions", Some(json!({"id":Uuid::new_v4(),"account_id":id(&rental_account),"coin_per_yuan":500000,"aw_price":300000,"helmet_price":200000,"armor_price":600000,"initial_coins":100000000,"deposit_cents":20000,"started_at":(Utc::now()-Duration::hours(1)).to_rfc3339(),"note":""})), token).await;
    let report = format!("/api/rental-sessions/{}/analysis", id(&rental));
    let order = ok(&app, "POST", &orders, Some(order_input("escort")), token).await;
    let path = format!("/api/orders/{}", id(&order));
    let create_path = format!("{path}/transfer");
    let action_path = format!("{path}/transfer-action");
    let stale_create = create_input(&order, false, None);
    let round = ok(
        &app,
        "POST",
        &format!("{path}/entries"),
        Some(entry("progress", 600, Some(id(&rental)))),
        token,
    )
    .await;
    ok(
        &app,
        "POST",
        &format!("{path}/entries"),
        Some(entry("failure", 200, Some(id(&rental)))),
        token,
    )
    .await;
    assert_eq!(
        call(&app, "POST", &create_path, Some(stale_create), Some(token))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let order = ok(&app, "GET", &path, None, token).await;
    assert_eq!(order["total_quantity"], 1200);
    let create_body = create_input(&order, false, None);
    assert_eq!(
        call(&app, "POST", &create_path, Some(create_body.clone()), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &create_path,
            Some(create_body.clone()),
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/orders/invalid/transfer",
            Some(create_body.clone()),
            Some(token)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let transferred = ok(&app, "POST", &create_path, Some(create_body.clone()), token).await;
    assert_eq!(transferred["status"], "archived");
    assert_eq!(transfer(&transferred)["progress_numerator"], 600);
    assert_eq!(transfer(&transferred)["progress_denominator"], 1200);
    assert_eq!(transfer(&transferred)["original_income_cents"], 39920);
    assert_eq!(transfer(&transferred)["expected_income_cents"], 19960);
    assert!(transfer(&transferred)["final_income_cents"].is_null());
    let again = ok(&app, "POST", &create_path, Some(create_body.clone()), token).await;
    assert_eq!(again["transfer_history"].as_array().unwrap().len(), 1);
    let mut changed = create_body;
    changed["prepaid"] = json!(true);
    assert_eq!(
        call(&app, "POST", &create_path, Some(changed), Some(token))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/entries"),
            Some(entry("progress", 10, None)),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("{path}/entries/{}", id(&round)),
            None,
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(order_input("escort")),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(call(&app, "POST", &format!("{path}/archive"), Some(json!({"id":Uuid::new_v4(),"mode":"waiver","final_income_cents":0,"note":"","expected_updated_at":transferred["updated_at"]})), Some(token)).await.0, StatusCode::CONFLICT);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/restore"),
            Some(json!({"settlement_id":Uuid::new_v4()})),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let summary = ok(
        &app,
        "GET",
        &format!("/api/bosses/{}", id(&boss)),
        None,
        token,
    )
    .await;
    assert_eq!(summary["active_order_count"], 0);
    let analysis = ok(&app, "GET", &report, None, token).await;
    assert_eq!(analysis["income_cents"], 0);
    assert_eq!(analysis["pending_order_count"], 1);
    assert_eq!(analysis["orders"][0]["settlement_mode"], "transfer");

    let mut settle = action_input(&transferred, "settle");
    settle["amount_cents"] = json!(19000);
    assert_eq!(
        call(
            &app,
            "POST",
            &action_path,
            Some(settle.clone()),
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let settled = ok(&app, "POST", &action_path, Some(settle.clone()), token).await;
    let replay = ok(&app, "POST", &action_path, Some(settle.clone()), token).await;
    assert_eq!(
        transfer(&replay)["cash_events"].as_array().unwrap().len(),
        1
    );
    settle["amount_cents"] = json!(18000);
    assert_eq!(
        call(&app, "POST", &action_path, Some(settle), Some(token))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(transfer(&settled)["final_income_cents"], 19000);
    let analysis = ok(&app, "GET", &report, None, token).await;
    assert_eq!(analysis["income_cents"], 19000);
    assert_eq!(analysis["original_income_cents"], 19960);
    assert_eq!(analysis["lost_income_cents"], 960);
    assert_eq!(analysis["affected_order_count"], 1);
    let refunded = act(
        &app,
        &settled,
        "refund",
        json!({"mode":"refund","final_income_cents":15000}),
        token,
    )
    .await;
    assert_eq!(transfer(&refunded)["pending_refund_cents"], 4000);
    assert_eq!(
        transfer(&refunded)["cash_events"].as_array().unwrap().len(),
        1
    );
    let analysis = ok(&app, "GET", &report, None, token).await;
    assert_eq!(analysis["income_cents"], 15000);
    assert_eq!(analysis["affected_order_count"], 1);
    let confirm = action_input(&refunded, "confirm_refund");
    let confirmed = ok(&app, "POST", &action_path, Some(confirm.clone()), token).await;
    let replay = ok(&app, "POST", &action_path, Some(confirm), token).await;
    assert_eq!(
        transfer(&replay)["cash_events"].as_array().unwrap().len(),
        2
    );
    let waived = act(
        &app,
        &confirmed,
        "refund",
        json!({"mode":"waiver","final_income_cents":0}),
        token,
    )
    .await;
    assert_eq!(transfer(&waived)["pending_refund_cents"], 15000);
    assert_eq!(transfer(&waived)["final_income_cents"], 0);
    let complete = act(&app, &waived, "confirm_refund", json!({}), token).await;
    assert_eq!(
        transfer(&complete)["cash_events"].as_array().unwrap().len(),
        3
    );
    let analysis = ok(&app, "GET", &report, None, token).await;
    assert_eq!(analysis["income_cents"], 0);
    assert_eq!(analysis["lost_income_cents"], 19960);
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM account_oss_archives WHERE user_id=$1")
            .bind(owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    let backup = load_snapshot(&pool, owner, revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        backup["orders"][0]["transfer_history"],
        complete["transfer_history"]
    );

    // Single-round progress defaults to zero; cancelling keeps the history without resurrecting it on retry.
    let order = ok(
        &app,
        "POST",
        &orders,
        Some(order_input("single_round")),
        token,
    )
    .await;
    let path = format!("/api/orders/{}/transfer", id(&order));
    let body = create_input(&order, true, None);
    let pending = ok(&app, "POST", &path, Some(body.clone()), token).await;
    assert_eq!(transfer(&pending)["expected_income_cents"], 0);
    assert_eq!(transfer(&pending)["amount_due_cents"], 39920);
    let cancelled = act(&app, &pending, "cancel", json!({}), token).await;
    assert_eq!(cancelled["status"], "active");
    assert_eq!(cancelled["settlement_required"], false);
    let replay = ok(&app, "POST", &path, Some(body), token).await;
    assert_eq!(replay["status"], "active");
    assert_eq!(transfer(&replay)["status"], "cancelled");
    let body = create_input(&cancelled, true, Some(5000));
    let pending = ok(&app, "POST", &path, Some(body), token).await;
    let reduced = act(
        &app,
        &pending,
        "refund",
        json!({"mode":"refund","final_income_cents":15000}),
        token,
    )
    .await;
    assert_eq!(transfer(&reduced)["amount_due_cents"], 19960);
    assert_eq!(transfer(&reduced)["pending_refund_cents"], 4960);
    let early_refund = act(&app, &reduced, "confirm_refund", json!({}), token).await;
    let cancel = action_input(&early_refund, "cancel");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/orders/{}/transfer-action", id(&early_refund)),
            Some(cancel),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let waived = act(
        &app,
        &early_refund,
        "refund",
        json!({"mode":"waiver","final_income_cents":0}),
        token,
    )
    .await;
    assert_eq!(transfer(&waived)["pending_refund_cents"], 34960);
    let complete = act(&app, &waived, "confirm_refund", json!({}), token).await;
    assert_eq!(
        transfer(&complete)["cash_events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["amount_cents"].as_i64().unwrap())
            .sum::<i64>(),
        39920
    );

    // Prepaid outgoing cash is distinct from the person's positive income.
    let order = ok(&app, "POST", &orders, Some(order_input("hourly")), token).await;
    let body = create_input(&order, true, Some(5000));
    let pending = ok(
        &app,
        "POST",
        &format!("/api/orders/{}/transfer", id(&order)),
        Some(body),
        token,
    )
    .await;
    let reduced = act(
        &app,
        &pending,
        "refund",
        json!({"mode":"refund","final_income_cents":15000}),
        token,
    )
    .await;
    let settled = act(
        &app,
        &reduced,
        "settle",
        json!({"amount_cents":19960}),
        token,
    )
    .await;
    assert_eq!(transfer(&settled)["final_income_cents"], 15000);
    assert_eq!(transfer(&settled)["cash_events"][0]["direction"], "payment");
    let waived = act(
        &app,
        &settled,
        "refund",
        json!({"mode":"waiver","final_income_cents":0}),
        token,
    )
    .await;
    assert_eq!(transfer(&waived)["pending_refund_cents"], 19960);

    // Cancellation restores a previously restored settlement's pending state exactly.
    let order = ok(&app, "POST", &orders, Some(order_input("hourly")), token).await;
    let archive_id = Uuid::new_v4();
    ok(&app, "POST", &format!("/api/orders/{}/archive", id(&order)), Some(json!({"id":archive_id,"mode":"waiver","final_income_cents":0,"note":"","expected_updated_at":order["updated_at"]})), token).await;
    let restored = ok(
        &app,
        "POST",
        &format!("/api/orders/{}/restore", id(&order)),
        Some(json!({"settlement_id":archive_id})),
        token,
    )
    .await;
    let pending = ok(
        &app,
        "POST",
        &format!("/api/orders/{}/transfer", id(&order)),
        Some(create_input(&restored, false, Some(5000))),
        token,
    )
    .await;
    let waived = act(
        &app,
        &pending,
        "refund",
        json!({"mode":"waiver","final_income_cents":0}),
        token,
    )
    .await;
    let cancelled = act(&app, &waived, "cancel", json!({}), token).await;
    assert_eq!(cancelled["settlement_required"], true);
    assert_eq!(cancelled["status"], "active");

    // Two actions from the same screen cannot both commit under the row lock.
    let pending = ok(
        &app,
        "POST",
        &format!("/api/orders/{}/transfer", id(&order)),
        Some(create_input(&cancelled, false, Some(5000))),
        token,
    )
    .await;
    let cancel = action_input(&pending, "cancel");
    let mut settle = action_input(&pending, "settle");
    settle["amount_cents"] = json!(19960);
    let action_path = format!("/api/orders/{}/transfer-action", id(&order));
    let (a, b) = tokio::join!(
        call(&app, "POST", &action_path, Some(cancel), Some(token)),
        call(&app, "POST", &action_path, Some(settle), Some(token))
    );
    assert!(matches!(
        (a.0, b.0),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
}
