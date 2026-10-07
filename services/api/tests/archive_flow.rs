use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use base64::{Engine, engine::general_purpose::STANDARD};
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
async fn archive_refunds_preview_and_cleanup_preserve_real_rounds() {
    let options =
        PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL")).unwrap();
    let admin = PgPool::connect_with(options.clone()).await.unwrap();
    let database = format!("pwtools_archive_test_{}", Uuid::new_v4().simple());
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
    let account_user = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"archive@example.test","password":"long-test-password"})),
        None,
    )
    .await
    .1;
    let token = account_user["token"].as_str().unwrap();
    let other_user = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"other@example.test","password":"long-test-password"})),
        None,
    )
    .await
    .1;
    let other = other_user["token"].as_str().unwrap();
    let boss = ok(
        &app,
        "POST",
        "/api/bosses",
        Some(json!({"display_name":"归档老板","game_name":"测试老板","game_id":"","notes":""})),
        token,
    )
    .await;
    let account = ok(
        &app,
        "POST",
        "/api/rental-accounts",
        Some(json!({"id":Uuid::new_v4(),"name":"测试号","note":""})),
        token,
    )
    .await;
    let rental = ok(
        &app,
        "POST",
        "/api/rental-sessions",
        Some(rental_input(&account)),
        token,
    )
    .await;
    let order = ok(
        &app,
        "POST",
        &format!("/api/bosses/{}/orders", id(&boss)),
        Some(order_input("hourly", 600)),
        token,
    )
    .await;
    let path = format!("/api/orders/{}", id(&order));
    let entries = format!("{path}/entries");
    let first = ok(
        &app,
        "POST",
        &entries,
        Some(entry(30, Some(id(&rental)))),
        token,
    )
    .await;
    ok(
        &app,
        "POST",
        &entries,
        Some(entry(30, Some(id(&rental)))),
        token,
    )
    .await;
    ok(&app, "POST", &entries, Some(entry(30, None)), token).await;
    ok(
        &app,
        "PATCH",
        &format!("/api/rental-sessions/{}/return", id(&rental)),
        Some(json!({"final_cost_cents":15000})),
        token,
    )
    .await;
    let report_path = format!("/api/rental-sessions/{}/analysis", id(&rental));
    let pending = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(pending["round_count"], 2);
    assert!(pending["profit_cents"].is_null());
    let mut archive = json!({"id":Uuid::new_v4(),"mode":"refund","final_income_cents":19960,"note":"提前结束，退一半","expected_updated_at":order["updated_at"]});
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/archive"),
            Some(archive.clone()),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT,
        "stale order rejected"
    );
    let latest = ok(&app, "GET", &path, None, token).await;
    archive["expected_updated_at"] = latest["updated_at"].clone();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/archive"),
            Some(archive.clone()),
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let closed = ok(
        &app,
        "POST",
        &format!("{path}/archive"),
        Some(archive.clone()),
        token,
    )
    .await;
    assert_eq!(closed["status"], "archived");
    assert_eq!(closed["completed_quantity"], 90);
    assert_eq!(closed["remaining_quantity"], 510);
    assert_eq!(
        ok(
            &app,
            "POST",
            &format!("{path}/archive"),
            Some(archive.clone()),
            token
        )
        .await["settlement_history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let report = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(report["income_cents"], 13307);
    assert_eq!(report["profit_cents"], -1693);
    assert_eq!(report["original_income_cents"], 26613);
    assert_eq!(report["lost_income_cents"], 13306);
    assert_eq!(report["affected_order_count"], 1);
    assert_eq!(report["affected_round_count"], 2);
    assert_eq!(report["original_profit_cents"], 11613);
    let summary = ok(
        &app,
        "GET",
        &format!("/api/bosses/{}", id(&boss)),
        None,
        token,
    )
    .await;
    assert_eq!(summary["remaining_minutes"], 0);
    assert_eq!(summary["active_order_count"], 0);
    assert_eq!(
        call(&app, "POST", &entries, Some(entry(1, None)), Some(token))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "DELETE",
            &format!("{entries}/{}", id(&first)),
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
            Some(order_input("hourly", 600)),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let restore = json!({"settlement_id":archive["id"]});
    let reopened = ok(
        &app,
        "POST",
        &format!("{path}/restore"),
        Some(restore.clone()),
        token,
    )
    .await;
    assert_eq!(reopened["status"], "active");
    assert!(!reopened["settlement_history"][0]["restored_at"].is_null());
    ok(
        &app,
        "POST",
        &format!("{path}/restore"),
        Some(restore),
        token,
    )
    .await;
    let report = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(report["income_cents"], 0);
    assert_eq!(report["pending_order_count"], 1);
    assert_eq!(report["round_count"], 2);
    // Fulfillment can reach 100% after restore, but income still awaits explicit reconfirmation.
    ok(&app, "POST", &entries, Some(entry(510, None)), token).await;
    let latest = ok(&app, "GET", &path, None, token).await;
    assert_eq!(latest["remaining_quantity"], 0);
    assert_eq!(latest["status"], "active");
    assert!(
        ok(&app, "GET", &report_path, None, token).await["orders"][0]["income_cents"].is_null()
    );
    archive = json!({"id":Uuid::new_v4(),"mode":"waiver","final_income_cents":0,"note":"免单","expected_updated_at":latest["updated_at"]});
    let waived = ok(
        &app,
        "POST",
        &format!("{path}/archive"),
        Some(archive),
        token,
    )
    .await;
    assert_eq!(waived["settlement_history"].as_array().unwrap().len(), 2);
    let report = ok(&app, "GET", &report_path, None, token).await;
    assert_eq!(report["income_cents"], 0);
    assert_eq!(report["profit_cents"], -15000);
    assert_eq!(report["round_count"], 2);
    // A new screenshot only lives in the preview response until an atomic confirmation.
    let order = ok(
        &app,
        "POST",
        &format!("/api/bosses/{}/orders", id(&boss)),
        Some(order_input("escort", 10000)),
        token,
    )
    .await;
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::new(2, 2))
        .write_to(&mut png, ImageFormat::Png)
        .unwrap();
    let mut image = json!({"name":"preview.png","content_type":"image/png","data_base64":STANDARD.encode(png.into_inner()),"order_id":order["id"],"recognition":{"outcome":"success","players":[{"player_name":"测试老板","outcome":"success","amount":100,"confidence":1}],"raw_text":"测试","warnings":[]}});
    for _ in 0..2 {
        let preview = ok(
            &app,
            "POST",
            "/api/matches/preview-local",
            Some(image.clone()),
            token,
        )
        .await;
        assert_eq!(preview["record"]["amount"], 100);
        assert_eq!(preview["record"]["confirmed"], false);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM matches")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM object_storage_jobs")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    image["input"] = json!({"confirmed":true,"order_id":order["id"],"player_name":"测试老板","outcome":"success","amount":100,"fake_amount":101,"note":"","played_at":null,"failure_extra_amount":0});
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/matches/confirm",
            Some(image.clone()),
            Some(token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM matches")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    image["input"]["fake_amount"] = json!(0);
    let (saved, retry) = tokio::join!(
        ok(
            &app,
            "POST",
            "/api/matches/confirm",
            Some(image.clone()),
            token
        ),
        ok(
            &app,
            "POST",
            "/api/matches/confirm",
            Some(image.clone()),
            token
        )
    );
    assert_eq!(saved["record"]["id"], retry["record"]["id"]);
    assert_eq!(saved["record"]["confirmed"], true);
    assert_eq!(saved["record"]["raw_text"], "测试");
    let photo_path = format!("/api/matches/{}", saved["record"]["id"].as_str().unwrap());
    assert_eq!(
        call(
            &app,
            "PATCH",
            &photo_path,
            Some(json!({"confirmed":false})),
            Some(token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let duplicate = ok(
        &app,
        "POST",
        "/api/matches/preview-local",
        Some(image.clone()),
        token,
    )
    .await;
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["record"]["confirmed"], true);
    let current = ok(
        &app,
        "GET",
        &format!("/api/orders/{}", id(&order)),
        None,
        token,
    )
    .await;
    ok(&app,"POST",&format!("/api/orders/{}/archive",id(&order)),Some(json!({"id":Uuid::new_v4(),"mode":"waiver","final_income_cents":0,"note":"","expected_updated_at":current["updated_at"]})),token).await;
    assert_eq!(
        call(&app, "DELETE", &photo_path, None, Some(token)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "PATCH",
            &photo_path,
            Some(json!({"note":"改动"})),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{photo_path}/local-recognition"),
            Some(json!({"image_sha256":saved["record"]["image_sha256"],"recognition":null})),
            Some(token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // A lost confirmation response can still be verified even after another client archived the order.
    assert_eq!(
        ok(&app, "POST", "/api/matches/confirm", Some(image), token).await["record"]["id"],
        saved["record"]["id"]
    );
    let owner = Uuid::parse_str(account_user["user"]["id"].as_str().unwrap()).unwrap();
    // Simulate old-client abandoned previews; cleanup must preserve the confirmed image.
    sqlx::query("INSERT INTO matches(id,user_id,boss_id,boss_player_name,original_name,image_content_type,image_bytes,image_sha256,image_width,image_height,image_size,ocr_status) VALUES($1,$2,'old','测试老板','old.png','image/png',$3,repeat('a',64),1,1,1,'failed')")
        .bind(Uuid::new_v4()).bind(owner).bind(vec![1u8]).execute(&pool).await.unwrap();
    assert_eq!(
        pwtools_api::storage_migration::cleanup_unconfirmed(&pool, true, 100)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        pwtools_api::storage_migration::cleanup_unconfirmed(&pool, false, 100)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM matches WHERE confirmed")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    let revision =
        sqlx::query_scalar::<_, i64>("SELECT revision FROM account_oss_archives WHERE user_id=$1")
            .bind(owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    let snapshot = load_snapshot(&pool, owner, revision)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot["matches"].as_array().unwrap().len(), 1);
    assert_eq!(
        snapshot["orders"][0]["settlement_history"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
