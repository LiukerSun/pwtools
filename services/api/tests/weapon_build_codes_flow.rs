use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, Query},
    http::{Request, StatusCode, header},
    routing::get,
};
use http_body_util::BodyExt;
use pwtools_api::{AppState, MIGRATOR, router, weapon_build_codes::BuildCodeProvider};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgConnectOptions};
use std::{
    collections::HashMap,
    net::SocketAddr,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
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
    let bytes = body.map_or_else(String::new, |value| {
        builder = std::mem::replace(&mut builder, Request::builder())
            .header(header::CONTENT_TYPE, "application/json");
        value.to_string()
    });
    let mut request = builder.body(Body::from(bytes)).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        SocketAddr::from_str("127.0.0.25:41020").unwrap(),
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
fn input(code: &str) -> Value {
    json!({"code":code,"weapon_name":"汤姆逊冲锋枪","mode":"烽火地带","note":"近战方案"})
}

#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission"]
async fn private_codes_match_provider_cache_and_survive_failures() {
    let options =
        PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL")).unwrap();
    let admin = PgPool::connect_with(options.clone()).await.unwrap();
    let database = format!("pwtools_build_codes_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {database}"))
        .execute(&admin)
        .await
        .unwrap();
    let pool = PgPool::connect_with(options.database(&database))
        .await
        .unwrap();
    let result = tokio::task::LocalSet::new()
        .run_until(async { tokio::task::spawn_local(run(pool.clone())).await })
        .await;
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {database} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
    result.expect("build code flow must pass");
}
async fn run(pool: PgPool) {
    MIGRATOR.run(&pool).await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let broken = Arc::new(AtomicBool::new(false));
    let counted = calls.clone();
    let failure = broken.clone();
    let provider_app = Router::new().route("/catalog",get(move |Query(query): Query<HashMap<String,String>>| {
        let calls = counted.clone(); let broken = failure.clone();
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(query["token"],"test-provider-token");
            assert_eq!(query["n"],"汤姆逊冲锋枪");
            if broken.load(Ordering::SeqCst) { return Json(json!({"code":401,"msg":"not echoed"})); }
            let core = if query["p"] == "1" { "OTHER123" } else { "6L79CCC0BK4JN1CPUVQAH" };
            Json(json!({"code":0,"count":2,"data":[{"id":926,"objectName":"汤姆逊冲锋枪","solutionCode":core,"solutionType":query["solutionType"],"price":219453,"zb":999,"properties_data":[{"name":"射程","value":25,"change":"+5"}]}]}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, provider_app).await.unwrap() });
    let state = AppState::with_ocr_url(pool.clone(), "http://127.0.0.1:9609")
        .await
        .unwrap()
        .with_build_code_provider(
            BuildCodeProvider::new(
                "test-provider-token".into(),
                format!("http://{address}/catalog"),
            )
            .unwrap(),
        );
    let app = router(state, vec![]);
    let a = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"code-a@example.test","password":"long-build-code-password"})),
        None,
    )
    .await;
    let b = call(
        &app,
        "POST",
        "/api/auth/register",
        Some(json!({"email":"code-b@example.test","password":"long-build-code-password"})),
        None,
    )
    .await;
    assert_eq!(a.0, StatusCode::CREATED);
    assert_eq!(b.0, StatusCode::CREATED);
    let token = a.1["token"].as_str().unwrap();
    let other = b.1["token"].as_str().unwrap();
    assert_eq!(
        call(&app, "GET", "/api/weapon-build-codes", None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let created = call(
        &app,
        "POST",
        "/api/weapon-build-codes",
        Some(input("6L79CCC0BK4JN1CPUVQAH")),
        Some(token),
    )
    .await;
    assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    assert_eq!(created.1["lookup_status"], "matched");
    assert_eq!(created.1["attributes"]["properties"][0]["value"], 25.0);
    assert!(created.1["attributes"].get("zb").is_none());
    assert!(created.1.get("user_id").is_none());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "pagination must load later match"
    );
    let lookup = call(
        &app,
        "POST",
        "/api/weapon-build-codes/lookup",
        Some(input("6L79CCC0BK4JN1CPUVQAH")),
        Some(other),
    )
    .await;
    assert_eq!(lookup.1["status"], "matched");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "public cache shared between users"
    );
    assert_eq!(
        lookup.1["attributes"]["fetched_at"],
        created.1["attributes"]["fetched_at"]
    );
    let path = format!(
        "/api/weapon-build-codes/{}",
        created.1["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&app, "PATCH", &path, Some(input("ABCDEFGH")), Some(other))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "DELETE", &path, None, Some(other)).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, "GET", "/api/weapon-build-codes", None, Some(other))
            .await
            .1["items"],
        json!([])
    );
    assert_eq!(
        call(&app, "PATCH", &path, Some(input("bad%code")), Some(token))
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let list = call(&app, "GET", "/api/weapon-build-codes", None, Some(token)).await;
    assert_eq!(list.1["items"][0]["code"], "6L79CCC0BK4JN1CPUVQAH");
    let mut changed = input("ABCDEFGH");
    changed["note"] = json!("更新备注");
    assert_eq!(
        call(&app, "PATCH", &path, Some(changed), Some(token))
            .await
            .1["lookup_status"],
        "unmatched"
    );
    let mut another_mode = input("6L79CCC0BK4JN1CPUVQAH");
    another_mode["mode"] = json!("全面战场");
    let mode_record = call(
        &app,
        "POST",
        "/api/weapon-build-codes",
        Some(another_mode.clone()),
        Some(token),
    )
    .await
    .1;
    assert_eq!(mode_record["lookup_status"], "matched");
    assert_eq!(calls.load(Ordering::SeqCst), 4, "mode cache isolated");
    run_attributes(&app, &pool, token, other).await;
    run_attribute_preview(&pool, token).await;
    sqlx::query("UPDATE weapon_build_code_catalog SET fetched_at=now()-interval '7 hours'")
        .execute(&pool)
        .await
        .unwrap();
    broken.store(true, Ordering::SeqCst);
    another_mode["note"] = json!("上游故障时更新备注");
    let mode_path = format!(
        "/api/weapon-build-codes/{}",
        mode_record["id"].as_str().unwrap()
    );
    let preserved = call(&app, "PATCH", &mode_path, Some(another_mode), Some(token)).await;
    assert_eq!(preserved.0, StatusCode::OK);
    assert_eq!(preserved.1["lookup_status"], "matched");
    assert_eq!(preserved.1["attributes"], mode_record["attributes"]);
    assert_eq!(preserved.1["note"], "上游故障时更新备注");
    let failed = call(
        &app,
        "POST",
        "/api/weapon-build-codes",
        Some(input("ABCDEFGH")),
        Some(token),
    )
    .await;
    assert_eq!(failed.0, StatusCode::CREATED);
    assert_eq!(failed.1["lookup_status"], "unavailable");
    assert!(failed.1["attributes"].is_null());
    assert!(!failed.1.to_string().contains("test-provider-token"));
    let unconfigured = router(
        AppState::with_ocr_url(pool.clone(), "http://127.0.0.1:9609")
            .await
            .unwrap(),
        vec![],
    );
    assert_eq!(
        call(
            &unconfigured,
            "POST",
            "/api/weapon-build-codes",
            Some(input("ABCDEFGH")),
            Some(token)
        )
        .await
        .1["lookup_status"],
        "not_configured"
    );
    assert_eq!(
        call(&app, "DELETE", &path, None, Some(token)).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&app, "DELETE", &path, None, Some(token)).await.0,
        StatusCode::NOT_FOUND
    );
    server.abort();
}

async fn run_attribute_preview(pool: &PgPool, token: &str) {
    use axum::routing::post;
    let count = Arc::new(AtomicUsize::new(0));
    let called = count.clone();
    let mock=Router::new().route("/recognize-build-attributes",post(move || {
        let called=called.clone();async move {called.fetch_add(1,Ordering::SeqCst);
        Json(json!({"status":"completed","weapon_name":"M7战斗步枪","values":{"damage":39},"confidences":{"damage":0.99},"warnings":[],"missing":["handling"]}))}
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let oss_calls = Arc::new(AtomicUsize::new(0));
    let observed = oss_calls.clone();
    let oss_mock = Router::new().fallback(move || {
        let observed = observed.clone();
        async move {
            observed.fetch_add(1, Ordering::SeqCst);
            StatusCode::INTERNAL_SERVER_ERROR
        }
    });
    let oss_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let oss_url = format!("http://{}", oss_listener.local_addr().unwrap());
    let oss_server =
        tokio::spawn(async move { axum::serve(oss_listener, oss_mock).await.unwrap() });
    let storage = pwtools_api::storage::Storage::from_oss(
        pwtools_api::storage::OssConfig::new(
            &oss_url,
            "fixture-bucket",
            "cn-beijing",
            "fixturekey".into(),
            "fixturesecret".into(),
            None,
        )
        .unwrap(),
    )
    .unwrap();
    let app = router(
        AppState::with_services(pool.clone(), &url, storage)
            .await
            .unwrap(),
        vec![],
    );
    let counts = "SELECT jsonb_build_array((SELECT count(*) FROM weapon_build_codes),(SELECT count(*) FROM matches),(SELECT count(*) FROM object_storage_jobs),(SELECT count(*) FROM account_oss_archives))";
    let before: Value = sqlx::query_scalar(counts).fetch_one(pool).await.unwrap();
    let input = json!({"name":"panel.png","content_type":"image/png","data_base64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC"});
    let path = "/api/weapon-build-codes/recognize-attributes";
    assert_eq!(
        call(&app, "POST", path, Some(input.clone()), None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let response = call(&app, "POST", path, Some(input.clone()), Some(token)).await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.1);
    assert_eq!(response.1["values"]["damage"], 39);
    assert!(response.1.get("raw_text").is_none());
    let mut invalid = input.clone();
    invalid["content_type"] = json!("image/gif");
    assert_eq!(
        call(&app, "POST", path, Some(invalid), Some(token)).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut invalid = input.clone();
    invalid["data_base64"] = json!("broken");
    assert_eq!(
        call(&app, "POST", path, Some(invalid), Some(token)).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    use base64::Engine;
    use image::ImageEncoder;
    let mut oversized_pixels = Vec::new();
    image::codecs::png::PngEncoder::new(&mut oversized_pixels)
        .write_image(
            &vec![0; 8001 * 5000],
            8001,
            5000,
            image::ExtendedColorType::L8,
        )
        .unwrap();
    let mut invalid = input.clone();
    invalid["data_base64"] =
        json!(base64::engine::general_purpose::STANDARD.encode(oversized_pixels));
    assert_eq!(
        call(&app, "POST", path, Some(invalid), Some(token)).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut invalid = input;
    invalid["data_base64"] = json!("A".repeat(12 * 1024 * 1024 * 4 / 3 + 8));
    assert_eq!(
        call(&app, "POST", path, Some(invalid), Some(token)).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "invalid images must not enter inference"
    );
    let after: Value = sqlx::query_scalar(counts).fetch_one(pool).await.unwrap();
    assert_eq!(
        before, after,
        "attribute preview must not write records or queues"
    );
    assert_eq!(
        oss_calls.load(Ordering::SeqCst),
        0,
        "attribute preview must never call OSS"
    );
    oss_server.abort();
    server.abort();
}

async fn run_attributes(app: &Router, pool: &PgPool, token: &str, other: &str) {
    let mut payload = input("ABCDEFGH");
    let manual = json!({"identity":{"weapon_name":"汤姆逊冲锋枪","mode":"烽火地带","core_code":"ABCDEFGH"},"values":{"damage":0,"handling":38,"capacity":30,"fire_modes":["全自动","单发"],"price":852355},"source":"manual","recognized_at":null,"confirmed":true});
    payload["manual_attributes"] = manual.clone();
    let created = call(
        app,
        "POST",
        "/api/weapon-build-codes",
        Some(payload.clone()),
        Some(token),
    )
    .await;
    assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    assert_eq!(created.1["attributes"]["properties"][0]["value"], 0);
    assert!(created.1["provider_attributes"].is_null());
    let saved = created.1["manual_attributes"].clone();
    let id = created.1["id"].as_str().unwrap();
    let path = format!("/api/weapon-build-codes/{id}");
    assert_eq!(
        call(app, "PATCH", &path, Some(payload.clone()), Some(other))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(app, "DELETE", &path, None, Some(other)).await.0,
        StatusCode::NOT_FOUND
    );
    let login = call(
        app,
        "POST",
        "/api/auth/login",
        Some(json!({"email":"code-a@example.test","password":"long-build-code-password"})),
        None,
    )
    .await;
    let reloaded = call(
        app,
        "GET",
        "/api/weapon-build-codes",
        None,
        login.1["token"].as_str(),
    )
    .await;
    assert_eq!(
        reloaded.1["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == id)
            .unwrap()["manual_attributes"],
        saved
    );
    let mut note = input("汤姆逊冲锋枪-烽火地带-ABCDEFGH");
    note["note"] = json!("仅改备注");
    let updated = call(app, "PATCH", &path, Some(note.clone()), Some(token)).await;
    assert_eq!(updated.1["manual_attributes"], saved);
    for invalid in [
        json!({}),
        json!({"price":100}),
        json!({"damage":-1}),
        json!({"damage":39,"capacity":1.5}),
        json!({"damage":39,"fire_modes":["unknown"]}),
        json!({"damage":39,"hidden":1}),
    ] {
        let mut wrong = payload.clone();
        wrong["manual_attributes"]["values"] = invalid;
        assert_eq!(
            call(app, "PATCH", &path, Some(wrong), Some(token)).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    let mut wrong = payload.clone();
    wrong["manual_attributes"]["identity"]["core_code"] = json!("OTHER123");
    assert_eq!(
        call(app, "PATCH", &path, Some(wrong), Some(token)).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut wrong = payload.clone();
    wrong["manual_attributes"]["confirmed"] = json!(false);
    assert_eq!(
        call(app, "PATCH", &path, Some(wrong), Some(token)).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let provider = call(
        app,
        "POST",
        "/api/weapon-build-codes",
        Some(input("6L79CCC0BK4JN1CPUVQAH")),
        Some(token),
    )
    .await
    .1;
    let provider_path = format!(
        "/api/weapon-build-codes/{}",
        provider["id"].as_str().unwrap()
    );
    let mut attached = input("6L79CCC0BK4JN1CPUVQAH");
    attached["manual_attributes"] = manual;
    attached["manual_attributes"]["identity"]["core_code"] = json!("6L79CCC0BK4JN1CPUVQAH");
    let attached = call(app, "PATCH", &provider_path, Some(attached), Some(token))
        .await
        .1;
    assert_eq!(attached["attributes"]["properties"][0]["value"], 0);
    assert_eq!(attached["provider_attributes"], provider["attributes"]);
    let mut query = input("6L79CCC0BK4JN1CPUVQAH");
    query["record_id"] = provider["id"].clone();
    assert_eq!(
        call(
            app,
            "POST",
            "/api/weapon-build-codes/lookup",
            Some(query.clone()),
            Some(other)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            app,
            "POST",
            "/api/weapon-build-codes/lookup",
            Some(query),
            Some(token)
        )
        .await
        .1["status"],
        "matched"
    );
    let mut clear = input("6L79CCC0BK4JN1CPUVQAH");
    clear["manual_attributes"] = Value::Null;
    let cleared = call(app, "PATCH", &provider_path, Some(clear), Some(token))
        .await
        .1;
    assert!(cleared["manual_attributes"].is_null());
    assert_eq!(cleared["attributes"], provider["attributes"]);
    let changed = call(app, "PATCH", &path, Some(input("OTHER123")), Some(token)).await;
    assert!(changed.1["manual_attributes"].is_null());
    let restored = call(app, "PATCH", &path, Some(payload), Some(token))
        .await
        .1;
    assert!(!restored["manual_attributes"].is_null());
    for (weapon, mode) in [("其他武器", "烽火地带"), ("汤姆逊冲锋枪", "全面战场")]
    {
        let mut changed = input("ABCDEFGH");
        changed["weapon_name"] = json!(weapon);
        changed["mode"] = json!(mode);
        assert!(
            call(app, "PATCH", &path, Some(changed), Some(token))
                .await
                .1["manual_attributes"]
                .is_null()
        );
        let mut restore = input("ABCDEFGH");
        restore["manual_attributes"] = json!({"identity":saved["identity"],"values":saved["values"],"source":"manual","confirmed":true});
        assert!(
            !call(app, "PATCH", &path, Some(restore), Some(token))
                .await
                .1["manual_attributes"]
                .is_null()
        );
    }
    // An older API may edit identity while leaving the new column untouched.
    sqlx::query("UPDATE weapon_build_codes SET code='OTHER123',core_code='OTHER123' WHERE id=$1")
        .bind(Uuid::parse_str(id).unwrap())
        .execute(pool)
        .await
        .unwrap();
    let list = call(app, "GET", "/api/weapon-build-codes", None, Some(token))
        .await
        .1;
    assert!(
        list["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == id)
            .unwrap()["manual_attributes"]
            .is_null()
    );
    assert_eq!(
        call(app, "DELETE", &path, None, Some(token)).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(app, "DELETE", &provider_path, None, Some(token))
            .await
            .0,
        StatusCode::NO_CONTENT
    );
}
