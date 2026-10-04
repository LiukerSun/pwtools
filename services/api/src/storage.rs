//! Private OSS V4 object transport. No credential, signature, or object URL is exposed by API models.
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use hmac::{Hmac, Mac};
use md5::Md5;
use reqwest::{
    Client, Method, Url,
    header::{HeaderMap, HeaderValue},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt, sync::Arc, time::Duration};
use uuid::Uuid;

const PREFIX: &str = "pwtools/";
#[derive(Clone)]
pub struct Storage {
    oss: Option<Arc<Oss>>,
}
struct Oss {
    config: OssConfig,
    client: Client,
}
// Deliberately no Debug: the configuration contains credentials.
pub struct OssConfig {
    endpoint: Url,
    bucket: String,
    region: String,
    access_key: String,
    secret: String,
    token: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageError {
    Unavailable,
    Missing,
    Integrity,
    InvalidKey,
    NotConfigured,
}
impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "private object storage unavailable",
            Self::Missing => "private object missing",
            Self::Integrity => "private object integrity mismatch",
            Self::InvalidKey => "private object key invalid",
            Self::NotConfigured => "private object storage not configured",
        })
    }
}
impl std::error::Error for StorageError {}

impl OssConfig {
    pub fn new(
        endpoint: &str,
        bucket: &str,
        region: &str,
        access_key: String,
        secret: String,
        token: Option<String>,
    ) -> anyhow::Result<Self> {
        let endpoint = Url::parse(if endpoint.contains("://") {
            endpoint
        } else {
            return Self::new(
                &format!("https://{endpoint}"),
                bucket,
                region,
                access_key,
                secret,
                token,
            );
        })
        .map_err(|_| anyhow::anyhow!("OSS_ENDPOINT is invalid"))?;
        let host = endpoint.host_str().unwrap_or("");
        let local = matches!(host, "127.0.0.1" | "localhost" | "[::1]");
        anyhow::ensure!(
            (endpoint.scheme() == "https" && host.ends_with(".aliyuncs.com"))
                || (endpoint.scheme() == "http" && local),
            "OSS_ENDPOINT must use HTTPS on an Alibaba Cloud endpoint"
        );
        anyhow::ensure!(
            endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.query().is_none()
                && endpoint.fragment().is_none()
                && endpoint.path() == "/",
            "OSS_ENDPOINT must be a service endpoint"
        );
        anyhow::ensure!(
            (3..=63).contains(&bucket.len())
                && bucket
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && !bucket.starts_with('-')
                && !bucket.ends_with('-'),
            "OSS_BUCKET is invalid"
        );
        anyhow::ensure!(
            !region.is_empty()
                && region
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'),
            "OSS_REGION is invalid"
        );
        anyhow::ensure!(
            !access_key.is_empty() && access_key.bytes().all(|c| c.is_ascii_alphanumeric()),
            "OSS_ACCESS_KEY_ID is invalid"
        );
        anyhow::ensure!(
            !secret.is_empty() && !secret.chars().any(char::is_control),
            "OSS_ACCESS_KEY_SECRET is invalid"
        );
        if let Some(value) = &token {
            anyhow::ensure!(
                HeaderValue::from_str(value).is_ok(),
                "OSS_SECURITY_TOKEN is invalid"
            );
        }
        Ok(Self {
            endpoint,
            bucket: bucket.to_owned(),
            region: region.to_owned(),
            access_key,
            secret,
            token,
        })
    }
}
impl Storage {
    pub fn database() -> Self {
        Self { oss: None }
    }
    pub fn is_oss(&self) -> bool {
        self.oss.is_some()
    }
    pub fn from_oss(config: OssConfig) -> anyhow::Result<Self> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| anyhow::anyhow!("unable to initialize private object client"))?;
        Ok(Self {
            oss: Some(Arc::new(Oss { config, client })),
        })
    }
    pub fn from_env() -> anyhow::Result<Self> {
        let names = [
            "OSS_ENDPOINT",
            "OSS_BUCKET",
            "OSS_REGION",
            "OSS_ACCESS_KEY_ID",
            "OSS_ACCESS_KEY_SECRET",
        ];
        if !names
            .iter()
            .any(|name| std::env::var(name).is_ok_and(|v| !v.trim().is_empty()))
        {
            return Ok(Self::database());
        }
        let mut values = Vec::new();
        for name in names {
            values.push(
                std::env::var(name)
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .ok_or_else(|| anyhow::anyhow!("{name} is required when OSS is enabled"))?,
            );
        }
        anyhow::ensure!(
            std::env::var("OSS_PREFIX")
                .unwrap_or_else(|_| PREFIX.into())
                .trim()
                .trim_end_matches('/')
                == "pwtools",
            "OSS_PREFIX must be pwtools/"
        );
        Self::from_oss(OssConfig::new(
            &values[0],
            &values[1],
            &values[2],
            values[3].clone(),
            values[4].clone(),
            std::env::var("OSS_SECURITY_TOKEN")
                .ok()
                .filter(|v| !v.is_empty()),
        )?)
    }
    pub async fn put_verified(
        &self,
        key: &str,
        content_type: &str,
        bytes: &[u8],
        immutable: bool,
    ) -> Result<(), StorageError> {
        checked_key(key)?;
        let oss = self.oss.as_ref().ok_or(StorageError::NotConfigured)?;
        let mut headers = BTreeMap::from([
            ("content-type".to_owned(), content_type.to_owned()),
            (
                "content-md5".to_owned(),
                STANDARD.encode(Md5::digest(bytes)),
            ),
            ("x-oss-object-acl".to_owned(), "private".to_owned()),
            ("x-oss-meta-sha256".to_owned(), digest(bytes)),
        ]);
        if immutable {
            headers.insert("x-oss-forbid-overwrite".into(), "true".into());
        }
        let response = oss
            .send(Method::PUT, key, headers, Some(bytes.to_vec()))
            .await?;
        if !response.status().is_success()
            && !(immutable && response.status() == reqwest::StatusCode::CONFLICT)
        {
            return Err(StorageError::Unavailable);
        }
        let stored = self.get_private(key, bytes.len()).await?;
        if stored.len() != bytes.len() || digest(&stored) != digest(bytes) {
            return Err(StorageError::Integrity);
        }
        Ok(())
    }
    pub async fn put_json(&self, key: &str, value: &serde_json::Value) -> Result<(), StorageError> {
        let bytes = serde_json::to_vec(value).map_err(|_| StorageError::Integrity)?;
        self.put_verified(key, "application/json; charset=utf-8", &bytes, false)
            .await
    }
    pub async fn get_private(&self, key: &str, max_bytes: usize) -> Result<Vec<u8>, StorageError> {
        checked_key(key)?;
        let oss = self.oss.as_ref().ok_or(StorageError::NotConfigured)?;
        let mut response = oss.send(Method::GET, key, BTreeMap::new(), None).await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(StorageError::Missing);
        }
        if !response.status().is_success() {
            return Err(StorageError::Unavailable);
        }
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes as u64)
        {
            return Err(StorageError::Integrity);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| StorageError::Unavailable)?
        {
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|size| size > max_bytes)
            {
                return Err(StorageError::Integrity);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub async fn delete_private(&self, key: &str) -> Result<(), StorageError> {
        checked_key(key)?;
        let oss = self.oss.as_ref().ok_or(StorageError::NotConfigured)?;
        let response = oss.send(Method::DELETE, key, BTreeMap::new(), None).await?;
        if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(StorageError::Unavailable)
        }
    }
}
impl Oss {
    async fn send(
        &self,
        method: Method,
        key: &str,
        mut headers: BTreeMap<String, String>,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, StorageError> {
        headers.insert(
            "x-oss-date".into(),
            Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
        );
        headers.insert("x-oss-content-sha256".into(), "UNSIGNED-PAYLOAD".into());
        if let Some(token) = &self.config.token {
            headers.insert("x-oss-security-token".into(), token.clone());
        }
        let authorization = sign(&self.config, method.as_str(), key, &headers, "");
        let mut map = HeaderMap::new();
        for (name, value) in headers {
            map.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| StorageError::Unavailable)?,
                HeaderValue::from_str(&value).map_err(|_| StorageError::Unavailable)?,
            );
        }
        let mut authorization =
            HeaderValue::from_str(&authorization).map_err(|_| StorageError::Unavailable)?;
        authorization.set_sensitive(true);
        map.insert(reqwest::header::AUTHORIZATION, authorization);
        let mut url = self.config.endpoint.clone();
        let host = url.host_str().ok_or(StorageError::Unavailable)?;
        if matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
            url.set_path(&format!("/{}/{key}", self.config.bucket));
        } else {
            url.set_host(Some(&format!("{}.{}", self.config.bucket, host)))
                .map_err(|_| StorageError::Unavailable)?;
            url.set_path(&format!("/{key}"));
        }
        let mut request = self.client.request(method, url).headers(map);
        if let Some(body) = body {
            request = request.body(body);
        }
        request.send().await.map_err(|_| StorageError::Unavailable)
    }
}
fn uri(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~/".contains(&byte) {
            result.push(char::from(byte));
        } else {
            use std::fmt::Write;
            let _ = write!(result, "%{byte:02X}");
        }
    }
    result
}
fn hmac(key: &[u8], message: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    mac.finalize().into_bytes().to_vec()
}
fn sign(
    config: &OssConfig,
    method: &str,
    key: &str,
    headers: &BTreeMap<String, String>,
    additional: &str,
) -> String {
    let date = &headers["x-oss-date"];
    let scope = format!("{}/{}/oss/aliyun_v4_request", &date[..8], config.region);
    let canonical_headers = headers
        .iter()
        .filter(|(name, _)| {
            name.starts_with("x-oss-")
                || name.as_str() == "content-type"
                || name.as_str() == "content-md5"
                || additional.split(';').any(|header| header == name.as_str())
        })
        .map(|(name, value)| format!("{name}:{}\n", value.trim()))
        .collect::<String>();
    let canonical = format!(
        "{method}\n{}\n\n{canonical_headers}\n{additional}\nUNSIGNED-PAYLOAD",
        uri(&format!("/{}/{key}", config.bucket))
    );
    let to_sign = format!(
        "OSS4-HMAC-SHA256\n{date}\n{scope}\n{}",
        digest(canonical.as_bytes())
    );
    let key = hmac(format!("aliyun_v4{}", config.secret).as_bytes(), &date[..8]);
    let key = hmac(&key, &config.region);
    let key = hmac(&key, "oss");
    let key = hmac(&key, "aliyun_v4_request");
    let signature = hmac(&key, &to_sign)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let additional = if additional.is_empty() {
        String::new()
    } else {
        format!(", AdditionalHeaders={additional}")
    };
    format!(
        "OSS4-HMAC-SHA256 Credential={}/{scope}{additional}, Signature={signature}",
        config.access_key
    )
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn image_key(
    owner: Uuid,
    boss_key: &str,
    order: Option<Uuid>,
    id: Uuid,
    content_type: &str,
) -> String {
    let ext = match content_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        _ => "webp",
    };
    format!(
        "pwtools/users/{owner}/bosses/{}/orders/{}/matches/{id}/original.{ext}",
        digest(boss_key.as_bytes()),
        order.map_or_else(|| "unassigned".into(), |id| id.to_string())
    )
}
pub fn snapshot_key(image_key: &str) -> Result<String, StorageError> {
    checked_key(image_key)?;
    let (folder, _) = image_key.rsplit_once('/').ok_or(StorageError::InvalidKey)?;
    Ok(format!("{folder}/record.json"))
}
pub fn checked_record_key(key: &str, owner: Uuid, id: Uuid) -> Result<(), StorageError> {
    checked_key(key)?;
    let parts: Vec<_> = key.split('/').collect();
    if parts.len() != 10
        || parts[2] != owner.to_string()
        || parts[3] != "bosses"
        || parts[4].len() != 64
        || !parts[4].bytes().all(|c| c.is_ascii_hexdigit())
        || parts[5] != "orders"
        || (parts[6] != "unassigned" && Uuid::parse_str(parts[6]).is_err())
        || parts[7] != "matches"
        || parts[8] != id.to_string()
        || !matches!(
            parts[9],
            "original.png" | "original.jpg" | "original.webp" | "record.json"
        )
    {
        return Err(StorageError::InvalidKey);
    }
    Ok(())
}
fn checked_key(key: &str) -> Result<(), StorageError> {
    let parts: Vec<_> = key.split('/').collect();
    if key.len() > 1024
        || parts.len() < 4
        || parts[0] != "pwtools"
        || parts[1] != "users"
        || Uuid::parse_str(parts[2]).is_err()
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..")
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/-_.".contains(&byte))
    {
        return Err(StorageError::InvalidKey);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Bytes,
        extract::{Path, State},
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::any,
    };
    use std::collections::HashMap;
    use tokio::sync::Mutex;
    #[derive(Clone, Default)]
    struct Objects {
        bytes: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        requests: Arc<Mutex<Vec<(Method, String)>>>,
        corrupt: Arc<std::sync::atomic::AtomicBool>,
    }
    async fn object(
        State(objects): State<Objects>,
        Path((bucket, key)): Path<(String, String)>,
        method: Method,
        headers: HeaderMap,
        bytes: Bytes,
    ) -> Response {
        assert_eq!(bucket, "test-bucket");
        objects
            .requests
            .lock()
            .await
            .push((method.clone(), key.clone()));
        let authorization = headers[reqwest::header::AUTHORIZATION]
            .to_str()
            .expect("V4 auth");
        assert!(authorization.starts_with("OSS4-HMAC-SHA256 Credential=DemoAccessKey/"));
        assert!(authorization.contains("/cn-beijing/oss/aliyun_v4_request"));
        assert_eq!(headers["x-oss-content-sha256"], "UNSIGNED-PAYLOAD");
        assert_eq!(headers["x-oss-date"].to_str().expect("UTC date").len(), 16);
        let mut stored = objects.bytes.lock().await;
        match method {
            Method::PUT => {
                assert_eq!(headers["x-oss-object-acl"], "private");
                assert_eq!(
                    headers["x-oss-meta-sha256"].to_str().expect("SHA"),
                    digest(&bytes)
                );
                assert_eq!(
                    headers["content-md5"].to_str().expect("MD5"),
                    STANDARD.encode(Md5::digest(&bytes))
                );
                if headers.get("x-oss-forbid-overwrite").is_some() && stored.contains_key(&key) {
                    return StatusCode::CONFLICT.into_response();
                }
                stored.insert(key, bytes.to_vec());
                StatusCode::OK.into_response()
            }
            Method::GET => match stored.get(&key) {
                Some(bytes) => {
                    let mut bytes = bytes.clone();
                    if objects.corrupt.load(std::sync::atomic::Ordering::SeqCst) {
                        bytes.push(0);
                    }
                    (StatusCode::OK, bytes).into_response()
                }
                None => StatusCode::NOT_FOUND.into_response(),
            },
            Method::DELETE => {
                stored.remove(&key);
                StatusCode::NO_CONTENT.into_response()
            }
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    }
    #[tokio::test]
    async fn private_http_contract_preserves_images_and_confines_exact_deletion() {
        let objects = Objects::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let endpoint = format!("http://{}", listener.local_addr().expect("address"));
        let mock = Router::new()
            .route("/{bucket}/{*key}", any(object))
            .with_state(objects.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, mock).await.expect("mock OSS");
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
        let owner = Uuid::new_v4();
        let id = Uuid::new_v4();
        let key = image_key(owner, "老板", None, id, "image/png");
        let mut cursor = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(64, 64)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .expect("PNG");
        let bytes = cursor.into_inner();
        storage
            .put_verified(&key, "image/png", &bytes, true)
            .await
            .expect("private verified PUT");
        assert_eq!(
            storage
                .get_private(&key, bytes.len())
                .await
                .expect("private read"),
            bytes
        );
        storage
            .put_verified(&key, "image/png", &bytes, true)
            .await
            .expect("idempotent original");
        assert_eq!(
            storage
                .put_verified(&key, "image/png", b"different", true)
                .await,
            Err(StorageError::Integrity)
        );
        assert_eq!(
            storage.get_private(&key, 1).await,
            Err(StorageError::Integrity)
        );
        let manifest = format!("pwtools/users/{owner}/ledger.json");
        storage
            .put_json(&manifest, &serde_json::json!({"revision":1}))
            .await
            .expect("private manifest");
        storage
            .put_json(&manifest, &serde_json::json!({"revision":2}))
            .await
            .expect("replace manifest");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &storage.get_private(&manifest, 100).await.expect("manifest")
            )
            .expect("JSON")["revision"],
            2
        );
        objects
            .bytes
            .lock()
            .await
            .insert("bjxzp/untouched.png".into(), vec![7]);
        assert_eq!(
            storage.delete_private("bjxzp/untouched.png").await,
            Err(StorageError::InvalidKey)
        );
        objects
            .corrupt
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            storage.put_verified(&key, "image/png", &bytes, true).await,
            Err(StorageError::Integrity)
        );
        objects
            .corrupt
            .store(false, std::sync::atomic::Ordering::SeqCst);
        storage
            .delete_private(&key)
            .await
            .expect("exact private deletion");
        assert_eq!(
            storage.get_private(&key, bytes.len()).await,
            Err(StorageError::Missing)
        );
        assert_eq!(
            objects.bytes.lock().await.get("bjxzp/untouched.png"),
            Some(&vec![7])
        );
        assert!(
            !objects
                .requests
                .lock()
                .await
                .iter()
                .any(|(_, key)| key.starts_with("bjxzp/"))
        );
        server.abort();
    }
    #[test]
    fn namespaces_exclude_other_projects_and_owners() {
        let owner = Uuid::new_v4();
        let id = Uuid::new_v4();
        let key = image_key(owner, "团团", None, id, "image/png");
        assert!(checked_record_key(&key, owner, id).is_ok());
        assert!(checked_record_key(&key, Uuid::new_v4(), id).is_err());
        for key in [
            "bjxzp/picture.png",
            "pwtools/",
            "pwtools/users/not-an-owner/ledger.json",
            &format!("pwtools/users/{owner}/../ledger.json"),
        ] {
            assert!(checked_key(key).is_err());
        }
        assert!(checked_key(&format!("pwtools/users/{owner}/ledger.json")).is_ok());
    }
    #[test]
    fn official_v4_canonical_example_is_reproduced() {
        let headers = BTreeMap::from([
            ("content-disposition".into(), "attachment".into()),
            ("content-length".into(), "3".into()),
            ("content-md5".into(), "ICy5YqxZB1uWSwcVLSNLcA==".into()),
            ("content-type".into(), "text/plain".into()),
            ("x-oss-content-sha256".into(), "UNSIGNED-PAYLOAD".into()),
            ("x-oss-date".into(), "20250411T064124Z".into()),
        ]);
        let config = OssConfig::new(
            "oss-cn-hangzhou.aliyuncs.com",
            "examplebucket",
            "cn-hangzhou",
            "LTAIexample".into(),
            "yourAccessKeySecret".into(),
            None,
        )
        .expect("public example config");
        let result = sign(
            &config,
            "PUT",
            "exampleobject",
            &headers,
            "content-disposition;content-length",
        );
        // The public documentation uses a placeholder secret; the literal placeholder's
        // signature is independently calculated with Python hashlib/hmac.
        assert!(result.ends_with(
            "Signature=d3694c2dfc5371ee6acd35e88c4871ac95a7ba01d3a2f476768fe61218590097"
        ));
        assert_eq!(
            uri("/bucket/中文 +.png"),
            "/bucket/%E4%B8%AD%E6%96%87%20%2B.png"
        );
    }
}
