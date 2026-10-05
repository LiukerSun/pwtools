use std::{io::Cursor, net::SocketAddr, str::FromStr};

use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use image::{DynamicImage, ImageFormat, RgbImage};
use pwtools_api::{AppState, MIGRATOR, router};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgConnectOptions};
use tower::ServiceExt;
use uuid::Uuid;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    bytes: Vec<u8>,
    mime: &str,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, mime);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let mut request = builder.body(Body::from(bytes)).expect("request");
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 21], 41111))));
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (status, serde_json::from_slice(&bytes).expect("JSON"))
}

async fn json_request(
    app: &Router,
    method: &str,
    path: &str,
    data: Value,
    token: Option<&str>,
) -> (StatusCode, Value) {
    request(
        app,
        method,
        path,
        serde_json::to_vec(&data).expect("serialize"),
        "application/json",
        token,
    )
    .await
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission"]
async fn local_ocr_saves_without_server_inference_and_preserves_manual_results() {
    let options = PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
        .expect("options");
    let admin = PgPool::connect_with(options.clone()).await.expect("admin");
    let database = format!("pwtools_local_ocr_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {database}"))
        .execute(&admin)
        .await
        .expect("create isolated database");
    let pool = PgPool::connect_with(options.database(&database))
        .await
        .expect("test database");
    MIGRATOR.run(&pool).await.expect("migrations");
    // No OCR server exists at this endpoint. Local uploads and result submissions
    // must still complete; any accidental server inference would mark the draft failed.
    let app = router(
        AppState::with_ocr_url(pool.clone(), "http://127.0.0.1:1")
            .await
            .expect("state"),
        vec![],
    );
    let result = tokio::spawn(flow(app.clone())).await;
    drop(app);
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {database} WITH (FORCE)"))
        .execute(&admin)
        .await
        .expect("drop test database");
    admin.close().await;
    result.expect("local OCR flow");
}

async fn flow(app: Router) {
    let mut tokens = Vec::new();
    for email in ["local-owner@example.test", "local-other@example.test"] {
        let (status, user) = json_request(
            &app,
            "POST",
            "/api/auth/register",
            json!({"email":email,"password":"local-ocr-test-password"}),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        tokens.push(user["token"].as_str().expect("token").to_owned());
    }
    let token = Some(tokens[0].as_str());
    assert_eq!(
        json_request(
            &app,
            "PATCH",
            "/api/matches/settings",
            json!({"boss_id":"local-boss","boss_player_name":"老板昵称"}),
            token
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut encoded = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::new(16, 16))
        .write_to(&mut encoded, ImageFormat::Png)
        .expect("PNG");
    let png = encoded.into_inner();
    let (status, upload) = request(
        &app,
        "POST",
        "/api/matches/local",
        png.clone(),
        "image/png",
        token,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(upload["duplicate"], false);
    assert_eq!(upload["record"]["ocr_status"], "failed");
    assert!(
        upload["record"]["warnings"][0]
            .as_str()
            .unwrap()
            .starts_with("本地识别尚未完成"),
        "local upload must not call remote OCR"
    );
    let id = upload["record"]["id"].as_str().unwrap();
    let hash = upload["record"]["image_sha256"].as_str().unwrap();
    let path = format!("/api/matches/{id}");
    let local_path = format!("{path}/local-recognition");
    let mut payload = json!({"image_sha256":hash,"recognition":{
        "outcome":"unknown", "players":[
            {"player_name":"其他队员","outcome":"success","amount":999,"confidence":0.99},
            {"player_name":"老板昵称","outcome":"success","amount":123456,"confidence":0.96}
        ], "raw_text":"本地识别文本", "warnings":[]
    }});
    assert_eq!(
        json_request(&app, "POST", &local_path, payload.clone(), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        json_request(&app, "POST", &local_path, payload.clone(), Some(&tokens[1]))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let mut wrong_hash = payload.clone();
    wrong_hash["image_sha256"] = json!("0".repeat(64));
    assert_eq!(
        json_request(&app, "POST", &local_path, wrong_hash, token)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (status, record) = json_request(&app, "POST", &local_path, payload.clone(), token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(record["amount"], 123456);
    assert_eq!(record["player_name"], "老板昵称");
    assert_eq!(record["ocr_status"], "completed");
    assert_eq!(record["confirmed"], false);
    assert!(record["credited_amount"].is_null());
    let duplicate = request(&app, "POST", "/api/matches/local", png, "image/png", token).await;
    assert_eq!(duplicate.0, StatusCode::OK);
    assert_eq!(duplicate.1["duplicate"], true);
    assert_eq!(duplicate.1["record"]["id"], id);
    assert_eq!(duplicate.1["record"]["amount"], 123456);

    // Successful and failed local retries both retain a user's explicit edits.
    assert_eq!(json_request(&app, "PATCH", &path, json!({"player_name":"人工昵称","outcome":"success","amount":654,"fake_amount":0,"confirmed":false,"note":"人工校对"}), token).await.0, StatusCode::OK);
    payload["recognition"]["players"][1]["amount"] = json!(777);
    payload["recognition"]["raw_text"] = json!("x".repeat(20_000));
    let (_, retried) = json_request(&app, "POST", &local_path, payload.clone(), token).await;
    assert_eq!(retried["amount"], 654);
    assert_eq!(retried["player_name"], "人工昵称");
    assert_eq!(retried["players"][1]["amount"], 777);
    assert_eq!(retried["raw_text"].as_str().unwrap().len(), 20_000);
    let (status, failed) = json_request(
        &app,
        "POST",
        &local_path,
        json!({"image_sha256":hash,"recognition":null}),
        token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(failed["ocr_status"], "failed");
    assert_eq!(failed["amount"], 654);
    assert_eq!(failed["players"], retried["players"]);
    assert_eq!(failed["raw_text"], retried["raw_text"]);
    payload["recognition"]["raw_text"] = json!("x".repeat(100_001));
    assert_eq!(
        json_request(&app, "POST", &local_path, payload, token)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        json_request(
            &app,
            "POST",
            &local_path,
            json!({"image_sha256":hash,"recognition":null,"confirmed":true}),
            token
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
