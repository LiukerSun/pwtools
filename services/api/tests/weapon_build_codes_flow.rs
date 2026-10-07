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
