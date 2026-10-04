use std::{collections::HashMap, str::FromStr, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use pwtools_api::{
    MIGRATOR,
    account_archive::drain,
    storage::{OssConfig, Storage},
};
use serde_json::Value;
use sqlx::{FromRow, PgPool, postgres::PgConnectOptions};
use tokio::{
    sync::{Mutex, oneshot},
    time::timeout,
};
use uuid::Uuid;

const WAIT: Duration = Duration::from_secs(5);

struct PutGate {
    key: String,
    entered: oneshot::Sender<()>,
    release: oneshot::Receiver<StatusCode>,
}

#[derive(Clone, Default)]
struct Objects {
    bytes: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    next_gate: Arc<Mutex<Option<PutGate>>>,
}

impl Objects {
    async fn pause_put(&self, key: &str) -> (oneshot::Receiver<()>, oneshot::Sender<StatusCode>) {
        let (entered, waiting) = oneshot::channel();
        let (release, resumed) = oneshot::channel();
        let mut gate = self.next_gate.lock().await;
        assert!(
            gate.is_none(),
            "only one controlled PUT is needed at a time"
        );
        *gate = Some(PutGate {
            key: key.to_owned(),
            entered,
            release: resumed,
        });
        (waiting, release)
    }

    async fn read(&self, key: &str) -> Value {
        let stored = self.bytes.lock().await;
        serde_json::from_slice(stored.get(key).expect("uploaded JSON object"))
            .expect("private archive JSON")
    }
}

async fn object(
    State(objects): State<Objects>,
    Path((bucket, key)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    assert_eq!(bucket, "test-bucket");
    assert!(
        headers[header::AUTHORIZATION]
            .to_str()
            .expect("OSS authorization")
            .starts_with("OSS4-HMAC-SHA256 Credential=DemoAccessKey/")
    );
    match method {
        Method::PUT => {
            assert_eq!(headers["x-oss-object-acl"], "private");
            let immutable = key.contains("/archives/ledger-");
            assert_eq!(headers.contains_key("x-oss-forbid-overwrite"), immutable);
            let gate = {
                let mut next = objects.next_gate.lock().await;
                if next.as_ref().is_some_and(|gate| gate.key == key) {
                    next.take()
                } else {
                    None
                }
            };
            if let Some(gate) = gate {
                gate.entered.send(()).expect("test observes blocked PUT");
                let status = timeout(WAIT, gate.release)
                    .await
                    .expect("test releases PUT promptly")
                    .expect("controlled PUT status");
                if status != StatusCode::OK {
                    return status.into_response();
                }
            }
            let mut stored = objects.bytes.lock().await;
            if immutable && stored.contains_key(&key) {
                return StatusCode::CONFLICT.into_response();
            }
            stored.insert(key, bytes.to_vec());
            StatusCode::OK.into_response()
        }
        Method::GET => match objects.bytes.lock().await.get(&key) {
            Some(bytes) => bytes.clone().into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }
}

#[derive(FromRow)]
struct ArchiveState {
    revision: i64,
    uploaded_revision: i64,
    failures: i32,
    lease_token: Option<Uuid>,
    ready: bool,
}

async fn queue(pool: &PgPool, owner: Uuid) -> ArchiveState {
    sqlx::query_as("SELECT revision,uploaded_revision,failures,lease_token,next_attempt_at<=now() AS ready FROM account_oss_archives WHERE user_id=$1")
        .bind(owner).fetch_one(pool).await.expect("archive queue")
}

async fn edit(pool: &PgPool, boss: Uuid, note: &str) {
    timeout(
        WAIT,
        sqlx::query("UPDATE bosses SET notes=$2 WHERE id=$1")
            .bind(boss)
            .bind(note)
            .execute(pool),
    )
    .await
    .expect("network upload must not hold a lock that blocks ledger edits")
    .expect("committed boss edit");
}

fn assert_private(snapshot: &Value, owner: Uuid, revision: i64, note: &str) {
    assert_eq!(snapshot["revision"], revision);
    assert_eq!(snapshot["account"]["id"], owner.to_string());
    assert_eq!(snapshot["account"].as_object().expect("account").len(), 3);
    assert_eq!(snapshot["bosses"][0]["notes"], note);
    let text = snapshot.to_string();
    for excluded in [
        "password_hash",
        "private-password-sentinel",
        "sessions",
        "token_hash",
        "image_bytes",
    ] {
        assert!(!text.contains(excluded), "archive excludes {excluded}");
    }
}

/// All fixtures live in a disposable database and use a local OSS transport.
#[tokio::test]
#[ignore = "requires DATABASE_URL and PostgreSQL CREATE DATABASE permission"]
async fn archive_worker_preserves_revisions_during_concurrent_edits_and_failed_uploads() {
    let options = PgConnectOptions::from_str(&std::env::var("DATABASE_URL").expect("DATABASE_URL"))
        .expect("database configuration");
    let admin = PgPool::connect_with(options.clone()).await.expect("admin");
    let database = format!("pwtools_archive_worker_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {database}"))
        .execute(&admin)
        .await
        .expect("isolated database");
    let pool = PgPool::connect_with(options.database(&database))
        .await
        .expect("test database");
    MIGRATOR.run(&pool).await.expect("migrations");

    let objects = Objects::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("local OSS listener");
    let endpoint = format!("http://{}", listener.local_addr().expect("address"));
    let mock = Router::new()
        .route("/{bucket}/{*key}", any(object))
        .with_state(objects.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, mock).await.expect("local OSS server");
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
        .expect("local OSS config"),
    )
    .expect("storage");
    let outcome = tokio::spawn(check_worker(pool.clone(), storage, objects)).await;
    server.abort();
    pool.close().await;
    sqlx::query(&format!("DROP DATABASE {database} WITH (FORCE)"))
        .execute(&admin)
        .await
        .expect("remove test database");
    admin.close().await;
    outcome.expect("archive worker regression");
}

async fn check_worker(pool: PgPool, storage: Storage, objects: Objects) {
    let owner = Uuid::new_v4();
    let boss = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,'worker@example.test','private-password-sentinel')")
        .bind(owner).execute(&pool).await.expect("account");
    sqlx::query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
    )
    .bind(vec![7_u8; 32])
    .bind(owner)
    .execute(&pool)
    .await
    .expect("private session");
    sqlx::query("INSERT INTO bosses(id,user_id,boss_key,display_name,notes) VALUES($1,$2,'worker-boss','老板','最初备注')")
        .bind(boss).bind(owner).execute(&pool).await.expect("boss");
    let key = |revision| format!("pwtools/users/{owner}/archives/ledger-{revision}.json");
    let mirror = format!("pwtools/users/{owner}/ledger.json");
    assert_eq!(queue(&pool, owner).await.revision, 2);

    assert_eq!(drain(&pool, &storage, 1).await.expect("initial archive"), 1);
    let initial = objects.read(&key(2)).await;
    assert_private(&initial, owner, 2, "最初备注");
    assert!(initial.get("exported_at").is_none());
    let mirrored = objects.read(&mirror).await;
    assert_private(&mirrored, owner, 2, "最初备注");
    assert!(mirrored.get("exported_at").is_some());

    // An edit commits while the old immutable PUT is waiting; a second worker
    // cannot steal that active lease, and old success cannot clear the new work.
    edit(&pool, boss, "开始旧版上传").await;
    let (entered, release) = objects.pause_put(&key(3)).await;
    let worker_pool = pool.clone();
    let worker_storage = storage.clone();
    let worker = tokio::spawn(async move { drain(&worker_pool, &worker_storage, 1).await });
    timeout(WAIT, entered)
        .await
        .expect("PUT starts")
        .expect("PUT gate");
    assert!(queue(&pool, owner).await.lease_token.is_some());
    assert_eq!(
        drain(&pool, &storage, 1).await.expect("concurrent claim"),
        0
    );
    edit(&pool, boss, "上传期间的新备注").await;
    release
        .send(StatusCode::OK)
        .expect("release successful PUT");
    assert_eq!(
        timeout(WAIT, worker)
            .await
            .expect("worker completes")
            .expect("worker task")
            .expect("archive drain"),
        1
    );
    let pending = queue(&pool, owner).await;
    assert_eq!((pending.revision, pending.uploaded_revision), (4, 3));
    assert!(pending.lease_token.is_none() && pending.ready);
    let old = objects.read(&key(3)).await;
    assert_private(&old, owner, 3, "开始旧版上传");
    assert_eq!(drain(&pool, &storage, 1).await.expect("newer archive"), 1);
    assert_private(&objects.read(&key(4)).await, owner, 4, "上传期间的新备注");
    assert_private(&objects.read(&mirror).await, owner, 4, "上传期间的新备注");
    assert_eq!(objects.read(&key(3)).await, old);

    // An old revision with a high retry count fails after another edit commits.
    // The fresh revision stays immediately available instead of waiting an hour.
    edit(&pool, boss, "失败请求之前").await;
    sqlx::query(
        "UPDATE account_oss_archives SET failures=8,next_attempt_at=now() WHERE user_id=$1",
    )
    .bind(owner)
    .execute(&pool)
    .await
    .expect("retry history");
    let (entered, release) = objects.pause_put(&key(5)).await;
    let worker_pool = pool.clone();
    let worker_storage = storage.clone();
    let worker = tokio::spawn(async move { drain(&worker_pool, &worker_storage, 1).await });
    timeout(WAIT, entered)
        .await
        .expect("failed PUT starts")
        .expect("PUT gate");
    edit(&pool, boss, "失败期间保存的最新备注").await;
    release
        .send(StatusCode::SERVICE_UNAVAILABLE)
        .expect("release failed PUT");
    assert_eq!(
        timeout(WAIT, worker)
            .await
            .expect("failed worker completes")
            .expect("worker task")
            .expect("failed archive drain"),
        0
    );
    let pending = queue(&pool, owner).await;
    assert_eq!(
        (
            pending.revision,
            pending.uploaded_revision,
            pending.failures
        ),
        (6, 4, 0)
    );
    assert!(pending.ready && pending.lease_token.is_none());
    assert!(!objects.bytes.lock().await.contains_key(&key(5)));
    assert_eq!(
        drain(&pool, &storage, 1)
            .await
            .expect("immediate fresh archive"),
        1
    );
    let latest = objects.read(&key(6)).await;
    assert_private(&latest, owner, 6, "失败期间保存的最新备注");
    assert_private(
        &objects.read(&mirror).await,
        owner,
        6,
        "失败期间保存的最新备注",
    );

    // Model a lost database acknowledgement after OSS succeeded. Reuploading
    // the same revision verifies its immutable bytes without an export-time mismatch.
    sqlx::query("UPDATE account_oss_archives SET uploaded_revision=4 WHERE user_id=$1")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("lost acknowledgement fixture");
    assert_eq!(
        drain(&pool, &storage, 1)
            .await
            .expect("idempotent revision retry"),
        1
    );
    assert_eq!(objects.read(&key(6)).await, latest);
    assert_eq!(objects.read(&key(2)).await, initial);
    let complete = queue(&pool, owner).await;
    assert_eq!(
        (
            complete.revision,
            complete.uploaded_revision,
            complete.failures
        ),
        (6, 6, 0)
    );
    assert!(complete.lease_token.is_none());
}
