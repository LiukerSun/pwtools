use std::{
    io::Cursor,
    net::SocketAddr,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{ConnectInfo, State},
    http::{HeaderMap, Request, StatusCode, header},
    response::IntoResponse,
    routing::post,
};
use http_body_util::BodyExt;
use image::{DynamicImage, ImageFormat, RgbImage};
use pwtools_api::{AppState, MIGRATOR, router};
use rand::{RngCore, SeedableRng, rngs::StdRng};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgConnectOptions};
use tower::ServiceExt;
use uuid::Uuid;

async fn mock_ocr(
    State(mode): State<Arc<AtomicU8>>,
    headers: HeaderMap,
    bytes: Bytes,
) -> axum::response::Response {
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("image/png")
    );
    assert!(!bytes.is_empty());
    if mode.load(Ordering::SeqCst) == 1 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let players = if mode.load(Ordering::SeqCst) == 2 {
        json!([{"player_name":"识别的新玩家","outcome":"success","amount":999,"confidence":0.91},{"player_name":"识别玩家","outcome":"success","amount":777,"confidence":0.9}])
    } else {
        json!([{"player_name":"识别玩家","outcome":"success","amount":130,"confidence":0.91},{"player_name":"另一位玩家","outcome":"failed","amount":null,"confidence":0.8}])
    };
    axum::Json(json!({"outcome":"success","players":players,"raw_text":"真实图片已传给 mock OCR","warnings":[]})).into_response()
}

fn png(seed: u64, width: u32, height: u32) -> Vec<u8> {
    let mut data = vec![0; (width * height * 3) as usize];
    StdRng::seed_from_u64(seed).fill_bytes(&mut data);
    let image = DynamicImage::ImageRgb8(RgbImage::from_raw(width, height, data).expect("pixels"));
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .expect("encode actual PNG");
    output.into_inner()
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Vec<u8>,
    content_type: Option<&str>,
    token: Option<&str>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if content_type.is_some_and(|value| value.starts_with("image/")) {
        builder = builder.header("x-file-name", "%E6%88%98%E7%BB%A9%20%231.png");
    }
    let mut request = builder.body(Body::from(body)).expect("request");
    request.extensions_mut().insert(ConnectInfo(
        SocketAddr::from_str("127.0.0.9:41001").expect("peer"),
    ));
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

async fn json_call(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let (status, _, bytes) = call(
        app,
        method,
        path,
        body.as_ref()
            .map_or_else(Vec::new, |value| value.to_string().into_bytes()),
        body.as_ref().map(|_| "application/json"),
        token,
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

async fn upload(app: &Router, image: &[u8], token: &str) -> (StatusCode, Value) {
    let (status, _, body) = call(
        app,
        "POST",
        "/api/matches",
        image.to_vec(),
        Some("image/png"),
        Some(token),
    )
    .await;
    (
        status,
        serde_json::from_slice(&body).expect("upload response"),
    )
}

async fn upload_to_order(
    app: &Router,
    image: &[u8],
    token: &str,
    order_id: &str,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/matches")
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header("x-order-id", order_id)
        .header("x-file-name", "filtered.png")
        .body(Body::from(image.to_vec()))
        .expect("order upload request");
    request.extensions_mut().insert(ConnectInfo(
        SocketAddr::from_str("127.0.0.9:41001").expect("peer"),
    ));
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("upload body")
        .to_bytes();
    (status, serde_json::from_slice(&bytes).expect("upload JSON"))
}

async fn filtered_page(
    app: &Router,
    token: &str,
    order_id: Option<&str>,
    confirmed: Option<bool>,
    page: u32,
    page_size: u32,
) -> Value {
    let mut path = format!("/api/matches?page={page}&page_size={page_size}");
    if let Some(order_id) = order_id {
        path.push_str(&format!("&order_id={order_id}"));
    }
    if let Some(confirmed) = confirmed {
        path.push_str(&format!("&confirmed={confirmed}"));
    }
    let (status, result) = json_call(app, "GET", &path, None, Some(token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["page"], page);
    assert_eq!(result["page_size"], page_size);
    result
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission; run cargo test --test matches_flow -- --ignored"]
async fn screenshot_records_are_persistent_isolated_and_confirmed_explicitly() {
    let options = PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
        .expect("URL");
    let admin = PgPool::connect_with(options.clone())
        .await
        .expect("admin database");
    let database_name = format!("pwtools_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {database_name}"))
        .execute(&admin)
        .await
        .expect("isolated database");
    let pool = PgPool::connect_with(options.database(&database_name))
        .await
        .expect("test database");
    MIGRATOR.run(&pool).await.expect("migrations");
    let mode = Arc::new(AtomicU8::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("OCR listener");
    let ocr_url = format!("http://{}", listener.local_addr().expect("address"));
    let mock = Router::new()
        .route("/recognize", post(mock_ocr))
        .with_state(mode.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, mock).await.expect("mock server");
    });
    let app = router(
        AppState::with_ocr_url(pool.clone(), &ocr_url)
            .await
            .expect("state"),
        vec![],
    );
    let outcome = tokio::spawn(run_flow(app.clone(), pool.clone(), mode)).await;
    drop(app);
    server.abort();
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {database_name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .expect("remove isolated database");
    admin.close().await;
    outcome.expect("match flow must pass");
}

async fn run_flow(app: Router, pool: PgPool, mode: Arc<AtomicU8>) {
    let alice = json_call(&app,"POST","/api/auth/register",Some(json!({"email":"alice@example.com","password":"long-test-password","display_name":"Alice"})),None).await;
    let bob = json_call(
        &app,
        "POST",
        "/api/auth/register",
        Some(
            json!({"email":"bob@example.com","password":"long-test-password","display_name":"Bob"}),
        ),
        None,
    )
    .await;
    assert_eq!(alice.0, StatusCode::CREATED);
    assert_eq!(bob.0, StatusCode::CREATED);
    let alice_token = alice.1["token"].as_str().expect("Alice token");
    let bob_token = bob.1["token"].as_str().expect("Bob token");
    let image = png(1, 128, 128);
    let settings = json!({"boss_id":"boss-a","boss_player_name":"识别玩家"});
    assert_eq!(
        json_call(
            &app,
            "GET",
            "/api/matches/settings",
            None,
            Some(alice_token)
        )
        .await
        .1,
        json!({"boss_id":"","boss_player_name":""})
    );
    assert_eq!(
        upload(&app, &image, alice_token).await.1["error"]["code"],
        "BOSS_REQUIRED"
    );
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            "/api/matches/settings",
            Some(settings.clone()),
            Some(alice_token)
        )
        .await
        .1,
        settings
    );
    assert_eq!(
        json_call(&app, "GET", "/api/matches/settings", None, Some(bob_token))
            .await
            .1["boss_id"],
        ""
    );
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            "/api/matches/settings",
            Some(settings.clone()),
            Some(bob_token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        image.len() > 16 * 1024,
        "upload route must allow images larger than JSON body limit"
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/matches",
            image.clone(),
            Some("image/png"),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let first = upload(&app, &image, alice_token).await;
    assert_eq!(first.0, StatusCode::CREATED);
    let record = &first.1["record"];
    let first_id = record["id"].as_str().expect("id").to_owned();
    let first_path = format!("/api/matches/{first_id}");
    assert_eq!(first.1["duplicate"], false);
    assert_eq!(record["original_name"], "战绩 #1.png");
    assert_eq!(record["boss_id"], "boss-a");
    assert_eq!(record["boss_player_name"], "识别玩家");
    assert_eq!(record["image_width"], 128);
    assert_eq!(record["image_height"], 128);
    assert_eq!(record["image_size"], image.len());
    assert_eq!(record["ocr_status"], "completed");
    assert_eq!(record["player_name"], "识别玩家");
    assert_eq!(record["amount"], 130);
    assert_eq!(record["confirmed"], false);
    assert_eq!(record["players"].as_array().expect("players").len(), 2);
    assert!(record.get("image_bytes").is_none() && record.get("user_id").is_none());
    let duplicate = upload(&app, &image, alice_token).await;
    assert_eq!(duplicate.0, StatusCode::OK);
    assert_eq!(duplicate.1["duplicate"], true);
    assert_eq!(duplicate.1["record"]["id"], first_id);
    assert_eq!(
        json_call(&app, "GET", "/api/matches/stats", None, Some(alice_token))
            .await
            .1["draft_count"],
        1
    );
    let bob_upload = upload(&app, &image, bob_token).await;
    assert_eq!(bob_upload.0, StatusCode::CREATED);
    assert_ne!(bob_upload.1["record"]["id"], first_id);

    let (status, headers, stored_image) = call(
        &app,
        "GET",
        &format!("{first_path}/image"),
        vec![],
        None,
        Some(alice_token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored_image, image);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
        Some("image/png")
    );
    assert_eq!(
        headers
            .get(header::CACHE_CONTROL)
            .and_then(|value| value.to_str().ok()),
        Some("private, no-store")
    );
    assert!(
        headers
            .get(header::CONTENT_DISPOSITION)
            .expect("safe disposition")
            .to_str()
            .expect("header")
            .starts_with("attachment; filename=\"match-")
    );
    let stored: Vec<u8> = sqlx::query_scalar("SELECT image_bytes FROM matches WHERE id = $1")
        .bind(Uuid::parse_str(&first_id).expect("UUID"))
        .fetch_one(&pool)
        .await
        .expect("stored blob");
    assert_eq!(stored, image);
    for suffix in ["", "/image", "/recognize"] {
        let method = if suffix == "/recognize" {
            "POST"
        } else {
            "GET"
        };
        assert_eq!(
            call(
                &app,
                method,
                &format!("{first_path}{suffix}"),
                vec![],
                None,
                Some(bob_token)
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            &first_path,
            Some(json!({"note":"cannot edit"})),
            Some(bob_token)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        json_call(&app, "DELETE", &first_path, None, Some(bob_token))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (status,confirmed) = json_call(&app,"PATCH",&first_path,Some(json!({"player_name":"识别玩家","outcome":"success","amount":150,"fake_amount":0,"confirmed":true,"played_at":"2026-10-04T02:00:00Z","note":"人工核对"})),Some(alice_token)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(confirmed["confirmed"], true);
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            &first_path,
            Some(json!({"player_name":"其他队员"})),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert!(confirmed["played_at"].is_string());
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            &first_path,
            Some(json!({"amount":-1})),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            &first_path,
            Some(json!({"amount":9_000_000_000_001_i64})),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            &first_path,
            Some(json!({"image_sha256":"hack"})),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            &first_path,
            Some(json!({"amount":null})),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            &first_path,
            Some(json!({"played_at":null})),
            Some(alice_token)
        )
        .await
        .1["played_at"],
        Value::Null
    );

    let second = upload(&app, &png(2, 128, 128), alice_token).await;
    assert_eq!(second.0, StatusCode::CREATED);
    let second_path = format!(
        "/api/matches/{}",
        second.1["record"]["id"].as_str().expect("second id")
    );
    let (status, failed_record) = json_call(
        &app,
        "PATCH",
        &second_path,
        Some(json!({"player_name":"识别玩家","outcome":"failed","amount":0,"fake_amount":0,"confirmed":true})),
        Some(alice_token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(failed_record["amount"], 0);
    // A reference amount on a failed record must not contribute to total success income.
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            &second_path,
            Some(json!({"amount":5000})),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::OK
    );
    mode.store(1, Ordering::SeqCst);
    let third_image = png(3, 128, 128);
    let third = upload(&app, &third_image, alice_token).await;
    assert_eq!(third.0, StatusCode::CREATED);
    assert_eq!(third.1["record"]["ocr_status"], "failed");
    assert_eq!(third.1["record"]["confirmed"], false);
    assert_eq!(third.1["record"]["player_name"], "");
    assert_eq!(third.1["record"]["outcome"], "unknown");
    assert_eq!(third.1["record"]["amount"], Value::Null);
    assert_eq!(third.1["record"]["players"], json!([]));
    assert_eq!(third.1["record"]["raw_text"], "");
    assert!(
        !third.1["record"]["warnings"]
            .as_array()
            .expect("warnings")
            .is_empty()
    );
    let third_path = format!(
        "/api/matches/{}",
        third.1["record"]["id"].as_str().expect("third id")
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("{third_path}/image"),
            vec![],
            None,
            Some(alice_token)
        )
        .await
        .2,
        third_image
    );
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            &third_path,
            Some(json!({"fake_amount":0,"confirmed":true})),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let statistics = json_call(&app, "GET", "/api/matches/stats", None, Some(alice_token)).await;
    assert_eq!(statistics.0, StatusCode::OK);
    assert_eq!(
        statistics.1,
        json!({"confirmed_count":2,"success_count":1,"failed_count":1,"draft_count":1,"total_amount":150,"success_rate":50.0})
    );
    let page1 = json_call(
        &app,
        "GET",
        "/api/matches?page=1&page_size=1",
        None,
        Some(alice_token),
    )
    .await;
    let page2 = json_call(
        &app,
        "GET",
        "/api/matches?page=2&page_size=1",
        None,
        Some(alice_token),
    )
    .await;
    assert_eq!(page1.1["total"], 3);
    assert_eq!(page1.1["items"].as_array().expect("items").len(), 1);
    assert_ne!(page1.1["items"][0]["id"], page2.1["items"][0]["id"]);
    assert_eq!(
        json_call(
            &app,
            "GET",
            "/api/matches?page_size=101",
            None,
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        json_call(
            &app,
            "GET",
            "/api/matches?page=nope",
            None,
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        json_call(&app, "GET", "/api/matches", None, Some(bob_token))
            .await
            .1["total"],
        1
    );

    mode.store(2, Ordering::SeqCst);
    let retry = json_call(
        &app,
        "POST",
        &format!("{first_path}/recognize"),
        None,
        Some(alice_token),
    )
    .await;
    assert_eq!(retry.0, StatusCode::OK);
    assert_eq!(retry.1["player_name"], "识别玩家");
    assert_eq!(retry.1["amount"], 150);
    assert_eq!(retry.1["note"], "人工核对");
    assert_eq!(retry.1["players"][0]["player_name"], "识别的新玩家");
    let retry = json_call(
        &app,
        "POST",
        &format!("{third_path}/recognize"),
        None,
        Some(alice_token),
    )
    .await;
    assert_eq!(retry.1["ocr_status"], "completed");
    assert_eq!(retry.1["player_name"], "识别玩家");
    assert_eq!(retry.1["amount"], 777);
    assert_eq!(retry.1["confirmed"], false);
    // A failed retry must not erase saved draft corrections or prior successful OCR references.
    let saved_draft = json_call(&app,"PATCH",&third_path,Some(json!({"player_name":"识别玩家","outcome":"success","amount":4321,"confirmed":false,"note":"已人工核对的草稿"})),Some(alice_token)).await;
    assert_eq!(saved_draft.0, StatusCode::OK);
    let confirmed_before_failure = json_call(&app, "GET", &first_path, None, Some(alice_token))
        .await
        .1;
    mode.store(1, Ordering::SeqCst);
    let failed_retry = json_call(
        &app,
        "POST",
        &format!("{third_path}/recognize"),
        None,
        Some(alice_token),
    )
    .await;
    assert_eq!(failed_retry.0, StatusCode::OK);
    assert_eq!(failed_retry.1["ocr_status"], "failed");
    for field in [
        "player_name",
        "outcome",
        "amount",
        "confirmed",
        "note",
        "players",
        "raw_text",
    ] {
        assert_eq!(
            failed_retry.1[field], saved_draft.1[field],
            "failed OCR must preserve saved draft {field}"
        );
    }
    assert!(
        !failed_retry.1["warnings"]
            .as_array()
            .expect("failure warning")
            .is_empty()
    );
    let confirmed_failed_retry = json_call(
        &app,
        "POST",
        &format!("{first_path}/recognize"),
        None,
        Some(alice_token),
    )
    .await;
    assert_eq!(confirmed_failed_retry.0, StatusCode::OK);
    assert_eq!(confirmed_failed_retry.1["ocr_status"], "failed");
    for field in [
        "player_name",
        "outcome",
        "amount",
        "confirmed",
        "note",
        "players",
        "raw_text",
    ] {
        assert_eq!(
            confirmed_failed_retry.1[field], confirmed_before_failure[field],
            "failed OCR must preserve confirmed {field}"
        );
    }
    mode.store(2, Ordering::SeqCst);
    let successful_retry = json_call(
        &app,
        "POST",
        &format!("{third_path}/recognize"),
        None,
        Some(alice_token),
    )
    .await;
    assert_eq!(successful_retry.0, StatusCode::OK);
    assert_eq!(successful_retry.1["ocr_status"], "completed");
    assert_eq!(
        successful_retry.1["amount"], 4321,
        "successful OCR preserves manually corrected draft results"
    );
    assert_eq!(successful_retry.1["note"], "已人工核对的草稿");
    assert_eq!(successful_retry.1["confirmed"], false);
    assert_eq!(
        upload(&app, &image, alice_token).await.1["record"]["amount"],
        150
    );
    let fourth_image = png(4, 128, 128);
    let (race1, race2) = tokio::join!(
        upload(&app, &fourth_image, alice_token),
        upload(&app, &fourth_image, alice_token)
    );
    assert!(matches!(
        (race1.0, race2.0),
        (StatusCode::CREATED, StatusCode::OK) | (StatusCode::OK, StatusCode::CREATED)
    ));
    assert_eq!(race1.1["record"]["id"], race2.1["record"]["id"]);
    assert_eq!(
        json_call(&app, "GET", "/api/matches", None, Some(alice_token))
            .await
            .1["total"],
        4
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/matches",
            vec![1, 2, 3],
            Some("image/png"),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/matches",
            image.clone(),
            Some("image/jpeg"),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/matches",
            vec![0; 12 * 1024 * 1024 + 1],
            Some("image/png"),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        upload(&app, &png(5, 16001, 1), alice_token).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // Boss settings scope both statistics and deduplication, while previous originals remain available.
    let boss_b = json!({"boss_id":"boss-b","boss_player_name":"另一老板"});
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            "/api/matches/settings",
            Some(boss_b),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::OK
    );
    let other_boss = upload(&app, &image, alice_token).await;
    assert_eq!(other_boss.0, StatusCode::CREATED);
    assert_ne!(other_boss.1["record"]["id"], first_id);
    assert_eq!(other_boss.1["record"]["boss_id"], "boss-b");
    assert_eq!(other_boss.1["record"]["player_name"], "");
    assert_eq!(other_boss.1["record"]["outcome"], "unknown");
    assert_eq!(other_boss.1["record"]["amount"], Value::Null);
    assert_eq!(other_boss.1["record"]["confirmed"], false);
    assert!(
        !other_boss.1["record"]["warnings"]
            .as_array()
            .expect("no-match warning")
            .is_empty()
    );
    assert_eq!(upload(&app, &image, alice_token).await.0, StatusCode::OK);
    assert_eq!(
        json_call(&app, "GET", "/api/matches", None, Some(alice_token))
            .await
            .1["total"],
        1
    );
    assert_eq!(
        json_call(&app, "GET", "/api/matches/stats", None, Some(alice_token))
            .await
            .1["total_amount"],
        0
    );
    assert_eq!(
        json_call(&app, "GET", &first_path, None, Some(alice_token))
            .await
            .1["boss_id"],
        "boss-a"
    );
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            "/api/matches/settings",
            Some(settings.clone()),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        json_call(&app, "GET", "/api/matches", None, Some(alice_token))
            .await
            .1["total"],
        4
    );
    assert_eq!(
        json_call(&app, "GET", "/api/matches/stats", None, Some(alice_token))
            .await
            .1["total_amount"],
        150
    );
    assert_eq!(
        json_call(&app, "DELETE", &first_path, None, Some(alice_token))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        json_call(&app, "GET", &first_path, None, Some(alice_token))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("{first_path}/image"),
            vec![],
            None,
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        json_call(&app, "GET", "/api/matches/stats", None, Some(alice_token))
            .await
            .1["total_amount"],
        0
    );
    // NUMERIC aggregation must return a clear error before crossing JavaScript's integer precision.
    let tiny_image = png(10, 1, 1);
    let alice_id = Uuid::parse_str(alice.1["user"]["id"].as_str().expect("user ID")).expect("UUID");
    sqlx::query("INSERT INTO matches (id,user_id,original_name,image_content_type,image_bytes,image_sha256,image_width,image_height,image_size,ocr_status,player_name,outcome,amount,fake_amount,confirmed,boss_id,boss_player_name) SELECT gen_random_uuid(),$1,'stats.png','image/png',$2,lpad(n::text,64,'0'),1,1,$3,'completed','统计老板','success',9000000000000,0,true,'large-stats','统计老板' FROM generate_series(1,1001) n")
        .bind(alice_id).bind(&tiny_image).bind(tiny_image.len() as i32).execute(&pool).await.expect("safe amount boundary fixtures");
    assert_eq!(
        json_call(
            &app,
            "PATCH",
            "/api/matches/settings",
            Some(json!({"boss_id":"large-stats","boss_player_name":"统计老板"})),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::OK
    );
    let overflow = json_call(&app, "GET", "/api/matches/stats", None, Some(alice_token)).await;
    assert_eq!(overflow.0, StatusCode::CONFLICT);
    assert_eq!(overflow.1["error"]["code"], "TOTAL_AMOUNT_TOO_LARGE");

    confirmation_filter_flow(&app, alice_token, bob_token).await;
}

async fn confirmation_filter_flow(app: &Router, alice_token: &str, bob_token: &str) {
    let boss_input = json!({
        "display_name":"筛选测试老板", "game_id":"filter-boss", "game_name":"识别玩家", "notes":""
    });
    let (status, alice_boss) = json_call(
        app,
        "POST",
        "/api/bosses",
        Some(boss_input.clone()),
        Some(alice_token),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, bob_boss) = json_call(
        app,
        "POST",
        "/api/bosses",
        Some(boss_input),
        Some(bob_token),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let mut orders = Vec::new();
    for (token, boss, title) in [
        (alice_token, &alice_boss, "草稿恢复护航"),
        (alice_token, &alice_boss, "同老板另一订单"),
        (bob_token, &bob_boss, "另一账号护航"),
    ] {
        let boss_id = boss["id"].as_str().expect("boss id");
        let (status, order) = json_call(
            app,
            "POST",
            &format!("/api/bosses/{boss_id}/orders"),
            Some(json!({
                "title":title, "kind":"escort", "target_quantity":10000,
                "failure_default_quantity":0, "note":""
            })),
            Some(token),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        orders.push(order["id"].as_str().expect("order id").to_owned());
    }
    let alpha = &orders[0];
    let beta = &orders[1];
    let bob_order = &orders[2];
    let mut draft_ids = Vec::new();
    for seed in 30..33 {
        let (status, uploaded) = upload_to_order(app, &png(seed, 64, 64), alice_token, alpha).await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(uploaded["record"]["confirmed"], false);
        draft_ids.push(
            uploaded["record"]["id"]
                .as_str()
                .expect("draft id")
                .to_owned(),
        );
    }
    let (status, other_order) = upload_to_order(app, &png(33, 64, 64), alice_token, beta).await;
    assert_eq!(status, StatusCode::CREATED);
    // Same image remains private to its account, with an independent draft record.
    let (status, other_account) =
        upload_to_order(app, &png(30, 64, 64), bob_token, bob_order).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_ne!(other_account["record"]["id"], draft_ids[0]);

    let all = filtered_page(app, alice_token, Some(alpha), None, 1, 20).await;
    assert_eq!(all["total"], 3);
    assert_eq!(all["items"].as_array().expect("all order records").len(), 3);
    let page1 = filtered_page(app, alice_token, Some(alpha), Some(false), 1, 1).await;
    let page2 = filtered_page(app, alice_token, Some(alpha), Some(false), 2, 1).await;
    assert_ne!(page1["items"][0]["id"], page2["items"][0]["id"]);
    for result in [&page1, &page2] {
        assert_eq!(result["total"], 3);
        assert_eq!(result["items"].as_array().expect("filtered page").len(), 1);
        assert_eq!(result["items"][0]["order_id"], *alpha);
        assert_eq!(result["items"][0]["confirmed"], false);
        assert!(draft_ids.contains(&result["items"][0]["id"].as_str().expect("id").to_owned()));
    }
    let past_last = filtered_page(app, alice_token, Some(alpha), Some(false), 4, 1).await;
    assert_eq!(past_last["total"], 3);
    assert_eq!(past_last["items"], json!([]));
    assert_eq!(
        filtered_page(app, alice_token, Some(alpha), Some(true), 1, 1).await["total"],
        0
    );

    let first_path = format!("/api/matches/{}", draft_ids[0]);
    let (status, confirmed) = json_call(
        app,
        "PATCH",
        &first_path,
        Some(json!({"fake_amount":0,"confirmed":true})),
        Some(alice_token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(confirmed["confirmed"], true);
    let remaining = filtered_page(app, alice_token, Some(alpha), Some(false), 1, 20).await;
    assert_eq!(remaining["total"], 2);
    assert_eq!(
        remaining["items"]
            .as_array()
            .expect("remaining drafts")
            .len(),
        2
    );
    assert!(
        remaining["items"]
            .as_array()
            .expect("drafts")
            .iter()
            .all(|row| {
                row["confirmed"] == false && row["id"] != draft_ids[0] && row["order_id"] == *alpha
            })
    );
    let confirmed_page = filtered_page(app, alice_token, Some(alpha), Some(true), 1, 1).await;
    assert_eq!(confirmed_page["total"], 1);
    assert_eq!(confirmed_page["items"][0]["id"], draft_ids[0]);
    assert_eq!(confirmed_page["items"][0]["confirmed"], true);
    assert_eq!(
        filtered_page(app, alice_token, Some(alpha), None, 1, 20).await["total"],
        3,
        "omitting confirmed retains both drafts and confirmed records"
    );
    let (status, entries) = json_call(
        app,
        "GET",
        &format!("/api/orders/{alpha}/entries"),
        None,
        Some(alice_token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(entries["total"], 1);
    assert_eq!(entries["items"][0]["match_id"], draft_ids[0]);
    assert_eq!(
        json_call(
            app,
            "PATCH",
            &first_path,
            Some(json!({"confirmed":false})),
            Some(alice_token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        filtered_page(app, alice_token, Some(alpha), Some(false), 1, 20).await["total"],
        3,
        "withdrawing confirmation restores the same draft"
    );
    assert_eq!(
        filtered_page(app, alice_token, Some(alpha), Some(true), 1, 20).await["total"],
        0
    );
    let scoped = filtered_page(app, alice_token, Some(beta), Some(false), 1, 1).await;
    assert_eq!(scoped["total"], 1);
    assert_eq!(scoped["items"][0]["id"], other_order["record"]["id"]);
    let private = filtered_page(app, bob_token, Some(bob_order), Some(false), 1, 1).await;
    assert_eq!(private["total"], 1);
    assert_eq!(private["items"][0]["id"], other_account["record"]["id"]);
    for confirmed in [true, false] {
        for (token, forbidden) in [(bob_token, alpha), (alice_token, bob_order)] {
            assert_eq!(
                json_call(
                    app,
                    "GET",
                    &format!("/api/matches?order_id={forbidden}&confirmed={confirmed}&page_size=1"),
                    None,
                    Some(token)
                )
                .await
                .0,
                StatusCode::NOT_FOUND,
                "even an empty filtered scope must validate ownership"
            );
        }
    }
    assert_eq!(
        filtered_page(app, alice_token, None, Some(false), 1, 20).await["total"],
        0,
        "legacy scope excludes assigned order drafts"
    );
    assert_eq!(
        filtered_page(app, alice_token, None, Some(true), 1, 1).await["total"],
        1001,
        "legacy scope retains only current settings boss and unassigned records"
    );
    assert_eq!(
        filtered_page(app, bob_token, None, Some(false), 1, 1).await["total"],
        1,
        "legacy drafts also remain private to the requesting account"
    );
    for invalid in ["yes", "1", ""] {
        assert_eq!(
            json_call(
                app,
                "GET",
                &format!("/api/matches?order_id={alpha}&confirmed={invalid}"),
                None,
                Some(alice_token)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        json_call(
            app,
            "GET",
            &format!("/api/matches?order_id={alpha}&confirmed=false"),
            None,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
