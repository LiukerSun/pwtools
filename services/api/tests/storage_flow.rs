use axum::{
    Router,
    body::{Body, Bytes},
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, Method, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, post},
};
use http_body_util::BodyExt;
use image::{DynamicImage, ImageFormat, RgbImage};
use pwtools_api::{
    AppState, MIGRATOR, router,
    storage::{self, OssConfig, Storage},
    storage_migration::{drain_jobs, migrate_legacy_images},
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgConnectOptions};
use std::{
    collections::HashMap,
    io::Cursor,
    net::SocketAddr,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::Mutex;
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Clone, Default)]
struct Objects {
    bytes: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    fail_put: Arc<AtomicBool>,
    fail_delete: Arc<AtomicBool>,
    corrupt_read: Arc<AtomicBool>,
    gets: Arc<AtomicUsize>,
}
async fn object(
    State(objects): State<Objects>,
    Path((bucket, key)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    assert_eq!(bucket, "test-bucket");
    assert!(key.starts_with("pwtools/users/"));
    assert!(
        headers[header::AUTHORIZATION]
            .to_str()
            .expect("signature")
            .starts_with("OSS4-HMAC-SHA256 Credential=DemoAccessKey/")
    );
    match method {
        Method::PUT => {
            assert_eq!(headers["x-oss-object-acl"], "private");
            if objects.fail_put.load(Ordering::SeqCst) {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
            let mut stored = objects.bytes.lock().await;
            if headers.get("x-oss-forbid-overwrite").is_some() && stored.contains_key(&key) {
                return StatusCode::CONFLICT.into_response();
            }
            stored.insert(key, bytes.to_vec());
            StatusCode::OK.into_response()
        }
        Method::GET => {
            objects.gets.fetch_add(1, Ordering::SeqCst);
            match objects.bytes.lock().await.get(&key) {
                Some(bytes) => {
                    let mut bytes = bytes.clone();
                    if objects.corrupt_read.load(Ordering::SeqCst) {
                        bytes.push(0);
                    }
                    bytes.into_response()
                }
                None => StatusCode::NOT_FOUND.into_response(),
            }
        }
        Method::DELETE => {
            if objects.fail_delete.load(Ordering::SeqCst) {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            }
            objects.bytes.lock().await.remove(&key);
            StatusCode::NO_CONTENT.into_response()
        }
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}
async fn ocr(bytes: Bytes) -> axum::Json<Value> {
    assert!(!bytes.is_empty());
    axum::Json(
        json!({"outcome":"success","players":[{"player_name":"识别玩家","outcome":"success","amount":130,"confidence":0.99}],"raw_text":"撤离成功 带出价值130","warnings":[]}),
    )
}
fn image(seed: u8) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(RgbImage::from_fn(64, 64, |x, y| {
        image::Rgb([seed, x as u8, y as u8])
    }))
    .write_to(&mut bytes, ImageFormat::Png)
    .expect("PNG");
    bytes.into_inner()
}
async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Vec<u8>,
    content: Option<&str>,
    token: Option<&str>,
) -> (StatusCode, Vec<u8>) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(content) = content {
        builder = builder.header(header::CONTENT_TYPE, content);
    }
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let mut request = builder.body(Body::from(body)).expect("request");
    request.extensions_mut().insert(ConnectInfo(
        SocketAddr::from_str("127.0.0.12:41010").expect("peer"),
    ));
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    (
        status,
        response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes()
            .to_vec(),
    )
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
async fn upload(app: &Router, token: &str, seed: u8) -> (StatusCode, Value) {
    let (status, bytes) = request(
        app,
        "POST",
        "/api/matches",
        image(seed),
        Some("image/png"),
        Some(token),
    )
    .await;
    (status, serde_json::from_slice(&bytes).expect("upload JSON"))
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission"]
async fn private_objects_and_migration_are_owner_scoped_and_failure_safe() {
    let options = PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
        .expect("URL");
    let admin = PgPool::connect_with(options.clone())
        .await
        .expect("admin database");
    let name = format!("pwtools_storage_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .expect("isolated database");
    let pool = PgPool::connect_with(options.database(&name))
        .await
        .expect("test database");
    MIGRATOR.run(&pool).await.expect("migrations");
    let objects = Objects::default();
    objects
        .bytes
        .lock()
        .await
        .insert("bjxzp/keep.png".into(), vec![7]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("storage listener");
    let endpoint = format!("http://{}", listener.local_addr().expect("address"));
    let mock = Router::new()
        .route("/{bucket}/{*key}", any(object))
        .with_state(objects.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, mock).await.expect("mock storage");
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("OCR listener");
    let ocr_url = format!("http://{}", listener.local_addr().expect("address"));
    let ocr_server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/recognize", post(ocr)))
            .await
            .expect("mock OCR");
    });
    let storage = Storage::from_oss(
        OssConfig::new(
            &endpoint,
            "test-bucket",
            "cn-beijing",
            "DemoAccessKey".into(),
            "public-test-secret".into(),
            None,
        )
        .expect("mock config"),
    )
    .expect("storage");
    let app = router(
        AppState::with_services(pool.clone(), &ocr_url, storage.clone())
            .await
            .expect("OSS state"),
        vec![],
    );
    let legacy = router(
        AppState::with_ocr_url(pool.clone(), &ocr_url)
            .await
            .expect("legacy state"),
        vec![],
    );
    let outcome = tokio::spawn(flow(
        app.clone(),
        legacy.clone(),
        pool.clone(),
        storage,
        objects,
    ))
    .await;
    drop(app);
    drop(legacy);
    server.abort();
    ocr_server.abort();
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .expect("remove test database");
    admin.close().await;
    outcome.expect("storage flow must pass");
}
async fn flow(app: Router, legacy: Router, pool: PgPool, storage: Storage, objects: Objects) {
    let alice = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"storage-alice@example.test","password":"long-test-password"})),
        None,
    )
    .await;
    let bob = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"storage-bob@example.test","password":"long-test-password"})),
        None,
    )
    .await;
    assert_eq!(alice.0, StatusCode::CREATED);
    assert_eq!(bob.0, StatusCode::CREATED);
    let token = alice.1["token"].as_str().expect("Alice session");
    let other = bob.1["token"].as_str().expect("Bob session");
    let settings = call(
        &app,
        "PATCH",
        "/api/matches/settings",
        Some(json!({"boss_id":"storage-boss","boss_player_name":"识别玩家"})),
        Some(token),
    )
    .await;
    assert_eq!(settings.0, StatusCode::OK);
    let uploaded = upload(&app, token, 1).await;
    assert_eq!(uploaded.0, StatusCode::CREATED);
    let id = Uuid::parse_str(uploaded.1["record"]["id"].as_str().expect("ID")).expect("UUID");
    let path = format!("/api/matches/{id}");
    assert!(uploaded.1["record"].get("image_object_key").is_none());
    assert!(uploaded.1["record"].get("user_id").is_none());
    let row: (Option<Vec<u8>>, String) =
        sqlx::query_as("SELECT image_bytes,image_object_key FROM matches WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("private metadata");
    assert!(row.0.is_none());
    assert_eq!(objects.bytes.lock().await.get(&row.1), Some(&image(1)));
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("{path}/image"),
            vec![],
            None,
            Some(token)
        )
        .await
        .1,
        image(1)
    );
    let reads = objects.gets.load(Ordering::SeqCst);
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("{path}/image"),
            vec![],
            None,
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        objects.gets.load(Ordering::SeqCst),
        reads,
        "owner validation precedes private object access"
    );
    assert_eq!(upload(&app, token, 1).await.1["duplicate"], true);
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            Some(json!({"fake_amount":0,"confirmed":true,"amount":150,"note":"人工校正保留"})),
            Some(token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/recognize"),
            None,
            Some(token)
        )
        .await
        .1["amount"],
        150
    );
    drain_jobs(&pool, &storage, 100)
        .await
        .expect("record snapshot");
    let snapshot = storage::snapshot_key(&row.1).expect("snapshot key");
    let json: Value = serde_json::from_slice(
        objects
            .bytes
            .lock()
            .await
            .get(&snapshot)
            .expect("snapshot bytes"),
    )
    .expect("snapshot JSON");
    assert_eq!(json["record"]["note"], "人工校正保留");
    assert_eq!(json["record"]["amount"], 150);
    assert!(json["record"].get("image_object_key").is_none());
    objects.fail_put.store(true, Ordering::SeqCst);
    assert_eq!(
        upload(&app, token, 2).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM matches")
        .fetch_one(&pool)
        .await
        .expect("saved count");
    assert_eq!(
        count, 1,
        "failed object writes do not create successful records"
    );
    objects.fail_put.store(false, Ordering::SeqCst);
    objects.corrupt_read.store(true, Ordering::SeqCst);
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("{path}/image"),
            vec![],
            None,
            Some(token)
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY
    );
    assert_eq!(upload(&app, token, 3).await.0, StatusCode::BAD_GATEWAY);
    objects.corrupt_read.store(false, Ordering::SeqCst);

    // Migration cannot clear old bytes until a new private object is verified.
    let old = upload(&legacy, token, 4).await;
    assert_eq!(old.0, StatusCode::CREATED);
    let old_id = Uuid::parse_str(old.1["record"]["id"].as_str().expect("legacy ID")).expect("UUID");
    objects.fail_put.store(true, Ordering::SeqCst);
    let failed = migrate_legacy_images(&pool, &storage, 100)
        .await
        .expect("safe migration failure");
    assert_eq!(failed.failed, 1);
    assert_eq!(failed.remaining, 1);
    let old_bytes: Vec<u8> = sqlx::query_scalar("SELECT image_bytes FROM matches WHERE id=$1")
        .bind(old_id)
        .fetch_one(&pool)
        .await
        .expect("old bytes retained");
    assert_eq!(old_bytes, image(4));
    objects.fail_put.store(false, Ordering::SeqCst);
    let migrated = migrate_legacy_images(&pool, &storage, 100)
        .await
        .expect("verified migration");
    assert_eq!(migrated.migrated, 1);
    assert_eq!(migrated.remaining, 0);
    assert_eq!(
        migrate_legacy_images(&pool, &storage, 100)
            .await
            .expect("repeat migration")
            .migrated,
        0
    );
    let old_key: String = sqlx::query_scalar(
        "SELECT image_object_key FROM matches WHERE id=$1 AND image_bytes IS NULL",
    )
    .bind(old_id)
    .fetch_one(&pool)
    .await
    .expect("legacy pointer");
    assert_eq!(objects.bytes.lock().await.get(&old_key), Some(&image(4)));
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/matches/{old_id}/image"),
            vec![],
            None,
            Some(token)
        )
        .await
        .1,
        image(4)
    );

    // DB deletion succeeds while object deletion is offline; its exact retry jobs persist.
    assert_eq!(
        call(&app, "DELETE", &path, None, Some(other)).await.0,
        StatusCode::NOT_FOUND
    );
    objects.fail_delete.store(true, Ordering::SeqCst);
    assert_eq!(
        call(&app, "DELETE", &path, None, Some(token)).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "GET", &path, None, Some(token)).await.0,
        StatusCode::NOT_FOUND
    );
    let failed = drain_jobs(&pool, &storage, 100)
        .await
        .expect("deferred object deletion");
    assert!(failed.failed >= 2);
    assert!(objects.bytes.lock().await.contains_key(&row.1));
    objects.fail_delete.store(false, Ordering::SeqCst);
    sqlx::query("UPDATE object_storage_jobs SET available_at=now()")
        .execute(&pool)
        .await
        .expect("make isolated retry jobs ready");
    drain_jobs(&pool, &storage, 100)
        .await
        .expect("recover deletions");
    let stored = objects.bytes.lock().await;
    assert!(!stored.contains_key(&row.1));
    assert!(!stored.contains_key(&snapshot));
    assert!(stored.contains_key(&old_key));
    assert_eq!(stored.get("bjxzp/keep.png"), Some(&vec![7]));
    assert_eq!(
        storage::digest(stored.get(&old_key).expect("legacy original")),
        storage::digest(&image(4))
    );
}
