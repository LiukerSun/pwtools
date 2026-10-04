use std::{net::SocketAddr, str::FromStr};

use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{HeaderValue, Request, StatusCode, header},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use http_body_util::BodyExt;
use pwtools_api::{AppState, MAX_BODY_BYTES, MIGRATOR, router};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgConnectOptions};
use tower::ServiceExt;
use uuid::Uuid;

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
    peer: &str,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    if body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    let mut request = builder
        .body(Body::from(
            body.map_or_else(String::new, |body| body.to_string()),
        ))
        .expect("request");
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::from_str(peer).expect("peer")));
    let response = app.clone().oneshot(request).await.expect("response");
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL),
        Some(&HeaderValue::from_static("no-store"))
    );
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("JSON response")
    };
    (status, body)
}

/// Creates and drops an isolated database; never truncates or mutates the database from DATABASE_URL.
#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission; run cargo test --test auth_flow -- --ignored"]
async fn private_accounts_and_legacy_upgrade_are_real_database_operations() {
    let url = std::env::var("DATABASE_URL")
        .expect("set DATABASE_URL to a local PostgreSQL administrator connection");
    let options = PgConnectOptions::from_str(&url).expect("database URL");
    let admin = PgPool::connect_with(options.clone())
        .await
        .expect("admin database");
    let database_name = format!("pwtools_test_{}", Uuid::new_v4().simple());
    // The identifier is generated internally from a fixed prefix and hexadecimal UUID.
    sqlx::query(&format!("CREATE DATABASE {database_name}"))
        .execute(&admin)
        .await
        .expect("isolated database");
    let pool = PgPool::connect_with(options.database(&database_name))
        .await
        .expect("test database");
    MIGRATOR.run(&pool).await.expect("migrations");
    let app = router(
        AppState::new(pool.clone()).await.expect("state"),
        vec![HeaderValue::from_static("http://localhost:5173")],
    );

    // SQLx historical schema replay borrows a connection across await; keep that
    // test future local while retaining panic capture for database cleanup.
    let test_result = tokio::task::LocalSet::new()
        .run_until(async { tokio::task::spawn_local(run_flow(app.clone(), pool.clone())).await })
        .await;
    drop(app);
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {database_name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .expect("clean isolated database");
    admin.close().await;
    test_result.expect("authentication flow must pass");
}

async fn run_flow(app: Router, pool: PgPool) {
    let peer = "127.0.0.1:41000";
    let (status, health) = request(&app, "GET", "/api/health", None, None, peer).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["database"], "connected");
    assert_eq!(
        request(&app, "GET", "/api/me", None, None, peer).await.0,
        StatusCode::UNAUTHORIZED
    );

    let short_password = json!({"email":"alice@example.com","password":"short"});
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/auth/register",
            Some(short_password),
            None,
            peer
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let credentials = json!({"email":" ALICE@Example.com ","password":"a-long-safe-password"});
    let (status, registered) = request(
        &app,
        "POST",
        "/api/auth/register",
        Some(credentials.clone()),
        None,
        peer,
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(registered["user"]["email"], "alice@example.com");
    assert_account(&registered["user"], "alice@example.com");
    let registration_token = registered["token"].as_str().expect("token");
    assert_eq!(
        URL_SAFE_NO_PAD
            .decode(registration_token)
            .expect("random token")
            .len(),
        32
    );
    let (hash, session_hash): (String, Vec<u8>) = sqlx::query_as("SELECT u.password_hash, s.token_hash FROM users u JOIN sessions s ON s.user_id = u.id WHERE u.email = 'alice@example.com'").fetch_one(&pool).await.expect("persisted authentication");
    assert!(hash.starts_with("$argon2id$"));
    assert!(!hash.contains("a-long-safe-password"));
    assert_eq!(
        session_hash,
        Sha256::digest(URL_SAFE_NO_PAD.decode(registration_token).expect("decode")).to_vec()
    );
    let duplicate = request(
        &app,
        "POST",
        "/api/auth/register",
        Some(credentials),
        None,
        peer,
    )
    .await;
    assert_eq!(duplicate.0, StatusCode::CONFLICT);
    assert_eq!(duplicate.1["error"]["code"], "EMAIL_EXISTS");
    let failed_login = request(
        &app,
        "POST",
        "/api/auth/login",
        Some(json!({"email":"alice@example.com","password":"wrong-password-here"})),
        None,
        peer,
    )
    .await;
    let unknown_login = request(
        &app,
        "POST",
        "/api/auth/login",
        Some(json!({"email":"nobody@example.com","password":"wrong-password-here"})),
        None,
        peer,
    )
    .await;
    assert_eq!(failed_login.0, StatusCode::UNAUTHORIZED);
    assert_eq!(failed_login, unknown_login);
    let (status, logged_in) = request(
        &app,
        "POST",
        "/api/auth/login",
        Some(json!({"email":"alice@example.com","password":"a-long-safe-password"})),
        None,
        peer,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(logged_in["user"]["id"], registered["user"]["id"]);
    let token = logged_in["token"].as_str().expect("login token");
    assert!(
        token != registration_token,
        "login creates an independent session"
    );
    assert_eq!(logged_in["user"], registered["user"]);

    let (status, bob) = request(&app,"POST","/api/auth/register",Some(json!({"email":"bob@example.com","password":"another-long-password","display_name":"Bob"})),None,"127.0.0.2:41000").await;
    assert_eq!(status, StatusCode::CREATED);
    assert_account(&bob["user"], "bob@example.com");
    assert_eq!(
        request(&app, "GET", "/api/me", None, Some(token), peer)
            .await
            .1,
        registered["user"]
    );
    assert_eq!(
        request(&app, "GET", "/api/me", None, bob["token"].as_str(), peer)
            .await
            .1["email"],
        "bob@example.com"
    );
    assert_eq!(
        request(
            &app,
            "PATCH",
            "/api/me",
            Some(json!({"email":"hijack@example.com"})),
            Some(token),
            peer
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        request(
            &app,
            "PATCH",
            "/api/me",
            Some(json!({"avatar_color":"red"})),
            Some(token),
            peer
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        request(
            &app,
            "PATCH",
            "/api/me",
            Some(json!({"availability":"invalid"})),
            Some(token),
            peer
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        request(
            &app,
            "PATCH",
            "/api/me",
            Some(json!({"game_tags":vec!["x"; 9]})),
            Some(token),
            peer
        )
        .await
        .0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        request(&app, "POST", "/api/auth/logout", None, Some(token), peer)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, "GET", "/api/me", None, Some(token), peer)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, "GET", "/api/me", None, Some(registration_token), peer)
            .await
            .0,
        StatusCode::OK
    );
    let digest =
        Sha256::digest(URL_SAFE_NO_PAD.decode(registration_token).expect("decode")).to_vec();
    sqlx::query(
        "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
    )
    .bind(digest)
    .execute(&pool)
    .await
    .expect("expire session");
    assert_eq!(
        request(&app, "GET", "/api/me", None, Some(registration_token), peer)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );

    let too_large = json!({"email":"large@example.test","password":"x".repeat(MAX_BODY_BYTES + 1)});
    let (status, body) = request(
        &app,
        "POST",
        "/api/auth/register",
        Some(too_large),
        bob["token"].as_str(),
        "127.0.0.4:41000",
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["error"]["code"], "PAYLOAD_TOO_LARGE");
    assert_eq!(
        request(&app, "GET", "/missing", None, None, peer).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, "DELETE", "/api/me", None, None, peer).await.0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    for _ in 0..10 {
        assert_eq!(
            request(
                &app,
                "POST",
                "/api/auth/login",
                Some(json!({})),
                None,
                "127.0.0.3:41000"
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, body) = request(
        &app,
        "POST",
        "/api/auth/login",
        Some(json!({})),
        None,
        "127.0.0.3:41000",
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "RATE_LIMITED");

    let preflight = Request::builder()
        .method("OPTIONS")
        .uri("/api/me")
        .header(header::ORIGIN, "http://localhost:5173")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization,content-type",
        )
        .body(Body::empty())
        .expect("preflight");
    let response = app
        .clone()
        .oneshot(preflight)
        .await
        .expect("preflight response");
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&HeaderValue::from_static("http://localhost:5173"))
    );
    let blocked_origin = Request::builder()
        .uri("/api/health")
        .header(header::ORIGIN, "https://untrusted.example")
        .body(Body::empty())
        .expect("origin request");
    let response = app
        .clone()
        .oneshot(blocked_origin)
        .await
        .expect("origin response");
    assert!(
        !response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    );
    legacy_account_removal_preserves_login_and_owned_data(&app, &pool, &hash).await;
}

fn assert_account(account: &Value, email: &str) {
    assert_eq!(account["email"], email);
    assert!(Uuid::parse_str(account["id"].as_str().expect("account UUID")).is_ok());
    assert!(
        chrono::DateTime::parse_from_rfc3339(
            account["created_at"].as_str().expect("created timestamp")
        )
        .is_ok()
    );
    assert_eq!(account.as_object().expect("account object").len(), 3);
    assert!(account.get("password_hash").is_none());
}

async fn legacy_account_removal_preserves_login_and_owned_data(
    app: &Router,
    pool: &PgPool,
    password_hash: &str,
) {
    let mut tx = pool.begin().await.expect("legacy account transaction");
    sqlx::raw_sql(
        "CREATE SCHEMA legacy_account_fixture; SET LOCAL search_path TO legacy_account_fixture",
    )
    .execute(&mut *tx)
    .await
    .expect("isolated migration schema");
    for source in [
        include_str!("../migrations/202610030001_initial.sql"),
        include_str!("../migrations/202610040001_matches.sql"),
        include_str!("../migrations/202610040002_boss_settings.sql"),
        include_str!("../migrations/202610040003_ledger.sql"),
    ] {
        sqlx::raw_sql(source)
            .execute(&mut *tx)
            .await
            .expect("released schema");
    }
    let owner = Uuid::new_v4();
    let boss_id = Uuid::new_v4();
    let order_id = Uuid::new_v4();
    let match_id = Uuid::new_v4();
    let secret = [7_u8; 32];
    let session_hash = Sha256::digest(secret).to_vec();
    let email = "legacy-account@example.test";
    sqlx::query("INSERT INTO users(id,email,password_hash,display_name,bio,avatar_color,game_tags,availability) VALUES($1,$2,$3,'旧版昵称','旧版个人简介','#aa66ff',ARRAY['旧版游戏'],'available')")
        .bind(owner).bind(email).bind(password_hash).execute(&mut *tx).await.expect("legacy account");
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
    )
    .bind(&session_hash)
    .bind(owner)
    .execute(&mut *tx)
    .await
    .expect("legacy session");
    sqlx::query("INSERT INTO bosses(id,user_id,boss_key,display_name,game_id,game_name,notes) VALUES($1,$2,'legacy-boss','老板称呼','game-001','截图老板','保留老板备注')")
        .bind(boss_id).bind(owner).execute(&mut *tx).await.expect("owned boss");
    sqlx::query("INSERT INTO service_orders(id,user_id,boss_id,title,kind,target_quantity) VALUES($1,$2,$3,'旧版订单','hourly',120)")
        .bind(order_id).bind(owner).bind(boss_id).execute(&mut *tx).await.expect("owned order");
    sqlx::query("INSERT INTO ledger_entries(id,user_id,order_id,kind,quantity,idempotency_key) VALUES($1,$2,$3,'progress',60,$4)")
        .bind(Uuid::new_v4()).bind(owner).bind(order_id).bind(Uuid::new_v4()).execute(&mut *tx).await.expect("owned progress");
    let original = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqucAAAAASUVORK5CYII=").expect("original fixture");
    sqlx::query("INSERT INTO matches(id,user_id,boss_id,boss_player_name,original_name,image_content_type,image_bytes,image_sha256,image_width,image_height,image_size,ocr_status) VALUES($1,$2,'legacy-boss','截图老板','legacy.png','image/png',$3,$4,1,1,$5,'failed')")
        .bind(match_id).bind(owner).bind(&original).bind(format!("{:x}",Sha256::digest(&original))).bind(original.len() as i32).execute(&mut *tx).await.expect("owned original");
    sqlx::raw_sql(include_str!(
        "../migrations/202610040004_private_account.sql"
    ))
    .execute(&mut *tx)
    .await
    .expect("account profile removal");
    let columns: Vec<String> = sqlx::query_scalar("SELECT column_name FROM information_schema.columns WHERE table_schema='legacy_account_fixture' AND table_name='users' ORDER BY ordinal_position")
        .fetch_all(&mut *tx).await.expect("account columns");
    assert_eq!(columns, ["id", "email", "password_hash", "created_at"]);
    let preserved: (Uuid, String, String, chrono::DateTime<chrono::Utc>) =
        sqlx::query_as("SELECT id,email,password_hash,created_at FROM users WHERE id=$1")
            .bind(owner)
            .fetch_one(&mut *tx)
            .await
            .expect("preserved credentials");
    assert_eq!(preserved.0, owner);
    assert_eq!(preserved.1, email);
    assert!(
        preserved.2 == password_hash,
        "stored password hash must not change"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sessions WHERE user_id=$1")
            .bind(owner)
            .fetch_one(&mut *tx)
            .await
            .expect("sessions"),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT notes FROM bosses WHERE id=$1")
            .bind(boss_id)
            .fetch_one(&mut *tx)
            .await
            .expect("boss notes"),
        "保留老板备注"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT target_quantity FROM service_orders WHERE id=$1")
            .bind(order_id)
            .fetch_one(&mut *tx)
            .await
            .expect("order target"),
        120
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT quantity FROM ledger_entries WHERE order_id=$1")
            .bind(order_id)
            .fetch_one(&mut *tx)
            .await
            .expect("progress"),
        60
    );
    assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>("SELECT image_bytes FROM matches WHERE id=$1")
            .bind(match_id)
            .fetch_one(&mut *tx)
            .await
            .expect("original bytes"),
        original
    );
    tx.rollback().await.expect("remove migration fixtures");

    // Exercise the actual current login and session extractors with credentials retained by the upgrade.
    sqlx::query("INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,$3,$4)")
        .bind(preserved.0)
        .bind(&preserved.1)
        .bind(preserved.2)
        .bind(preserved.3)
        .execute(pool)
        .await
        .expect("retained account fixture");
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
    )
    .bind(session_hash)
    .bind(owner)
    .execute(pool)
    .await
    .expect("retained session fixture");
    let legacy_token = URL_SAFE_NO_PAD.encode(secret);
    let peer = "127.0.0.5:41000";
    let (status, current) = request(app, "GET", "/api/me", None, Some(&legacy_token), peer).await;
    assert_eq!(status, StatusCode::OK);
    assert_account(&current, email);
    assert_eq!(current["id"], owner.to_string());
    let (status, login) = request(
        app,
        "POST",
        "/api/auth/login",
        Some(json!({"email":email,"password":"a-long-safe-password"})),
        None,
        peer,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(login["user"], current);
}
