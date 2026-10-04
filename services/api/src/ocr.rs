use std::{io::Cursor, sync::Arc, time::Duration};

use axum::body::Bytes;
use image::{ImageFormat, ImageReader, Limits};
use reqwest::{Client, StatusCode, Url, header::RETRY_AFTER};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::error::ApiError;

pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
pub const MAX_AMOUNT: i64 = 9_000_000_000_000;
const MAX_OCR_BODY: usize = 1024 * 1024;
const MAX_QUEUE_WAIT: Duration = Duration::from_secs(35);
const MAX_RECOGNITION_TIME: Duration = Duration::from_secs(35);
const MAX_BUSY_RETRIES: u8 = 4;

#[derive(Clone, Copy)]
enum OcrError {
    Busy(Duration),
    Timeout,
    Unavailable,
}

impl OcrError {
    fn recognition(self) -> Recognition {
        Recognition::failure(match self {
            Self::Busy(_) => "识别服务正忙，原图已保存；请稍后点击“重新识别”。",
            Self::Timeout => "识别耗时过长，原图已保存；请稍后重新识别，或根据原图手动填写。",
            Self::Unavailable => "自动识别暂时不可用，原图已保存；你可以手动填写或稍后重新识别。",
        })
    }

    fn from_request(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::Timeout
        } else {
            Self::Unavailable
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Failed,
    Unknown,
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use axum::{
        Json, Router,
        extract::State,
        http::StatusCode,
        response::{IntoResponse, Response},
        routing::post,
    };
    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct SingleWorker {
        busy: AtomicBool,
        rejected: AtomicUsize,
    }

    async fn single_worker(State(worker): State<Arc<SingleWorker>>, bytes: Bytes) -> Response {
        assert!(!bytes.is_empty());
        if worker
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            worker.rejected.fetch_add(1, Ordering::SeqCst);
            return (StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "2")]).into_response();
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        worker.busy.store(false, Ordering::SeqCst);
        recognition_response()
    }

    fn recognition_response() -> Response {
        Json(json!({
            "outcome": "success",
            "players": [{"player_name":"老板","outcome":"success","amount":123,"confidence":0.9}],
            "raw_text": "老板 撤离成功 123",
            "warnings": []
        }))
        .into_response()
    }

    async fn serve(app: Router) -> (OcrService, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("OCR listener");
        let url = format!("http://{}", listener.local_addr().expect("address"));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("OCR test server");
        });
        (OcrService::new(&url).expect("OCR client"), server)
    }

    #[tokio::test]
    async fn parallel_requests_are_queued_for_single_ocr_worker() {
        let worker = Arc::new(SingleWorker::default());
        let app = Router::new()
            .route("/recognize", post(single_worker))
            .with_state(worker.clone());
        let (service, server) = serve(app).await;
        // Two independent uploads reach the same OcrService, just like two desktop instances.
        let bytes =
            Bytes::from_static(b"screenshot contents already validated by the upload route");
        let (first, second) = tokio::join!(
            service.recognize(bytes.clone(), "image/png"),
            service.recognize(bytes, "image/png")
        );
        server.abort();
        assert!(
            first.completed && second.completed,
            "both queued uploads must recognize players"
        );
        for result in [first, second] {
            assert_eq!(
                result.matching_player("老板"),
                Some(("老板".into(), Outcome::Success, Some(123)))
            );
        }
        assert_eq!(
            worker.rejected.load(Ordering::SeqCst),
            0,
            "the API must send only one job at a time"
        );
    }

    struct ScriptedWorker {
        calls: AtomicUsize,
        fail_count: usize,
        status: StatusCode,
        retry_after: Option<&'static str>,
    }

    async fn scripted_worker(State(worker): State<Arc<ScriptedWorker>>) -> Response {
        if worker.calls.fetch_add(1, Ordering::SeqCst) < worker.fail_count {
            return match worker.retry_after {
                Some(delay) => (worker.status, [("retry-after", delay)]).into_response(),
                None => worker.status.into_response(),
            };
        }
        recognition_response()
    }

    async fn scripted_service(
        worker: Arc<ScriptedWorker>,
    ) -> (OcrService, tokio::task::JoinHandle<()>) {
        serve(
            Router::new()
                .route("/recognize", post(scripted_worker))
                .with_state(worker),
        )
        .await
    }

    #[tokio::test]
    async fn explicit_busy_retry_after_recovers_from_another_api_worker() {
        let worker = Arc::new(ScriptedWorker {
            calls: AtomicUsize::new(0),
            fail_count: 2,
            status: StatusCode::SERVICE_UNAVAILABLE,
            retry_after: Some("1"),
        });
        let (service, server) = scripted_service(worker.clone()).await;
        let result = service
            .recognize(Bytes::from_static(b"validated screenshot"), "image/png")
            .await;
        server.abort();
        assert!(result.completed);
        assert_eq!(
            result.matching_player("老板"),
            Some(("老板".into(), Outcome::Success, Some(123)))
        );
        assert_eq!(worker.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn busy_retries_are_finite_and_keep_the_busy_failure_reason() {
        let worker = Arc::new(ScriptedWorker {
            calls: AtomicUsize::new(0),
            fail_count: usize::MAX,
            status: StatusCode::SERVICE_UNAVAILABLE,
            retry_after: Some("1"),
        });
        let (service, server) = scripted_service(worker.clone()).await;
        let result = service
            .recognize(Bytes::from_static(b"validated screenshot"), "image/png")
            .await;
        server.abort();
        assert!(!result.completed);
        assert!(result.warnings[0].starts_with("识别服务正忙"));
        assert_eq!(
            worker.calls.load(Ordering::SeqCst),
            usize::from(MAX_BUSY_RETRIES) + 1
        );
    }

    #[tokio::test]
    async fn unrelated_errors_are_not_retried_and_timeouts_are_distinct() {
        for (status, retry_after, expected_warning) in [
            (StatusCode::SERVICE_UNAVAILABLE, None, "自动识别暂时不可用"),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Some("invalid"),
                "自动识别暂时不可用",
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Some("99999999"),
                "识别服务正忙",
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Some("1"),
                "自动识别暂时不可用",
            ),
            (StatusCode::GATEWAY_TIMEOUT, Some("1"), "识别耗时过长"),
        ] {
            let worker = Arc::new(ScriptedWorker {
                calls: AtomicUsize::new(0),
                fail_count: usize::MAX,
                status,
                retry_after,
            });
            let (service, server) = scripted_service(worker.clone()).await;
            let result = service
                .recognize(Bytes::from_static(b"validated screenshot"), "image/png")
                .await;
            server.abort();
            assert!(!result.completed);
            assert!(result.warnings[0].starts_with(expected_warning));
            assert_eq!(worker.calls.load(Ordering::SeqCst), 1);
        }
    }
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct OcrPlayer {
    pub player_name: String,
    pub outcome: Outcome,
    pub amount: Option<i64>,
    pub confidence: Option<f64>,
}

#[derive(Deserialize)]
struct RawOcrPlayer {
    player_name: String,
    outcome: Outcome,
    amount: Option<serde_json::Number>,
    confidence: Option<f64>,
}

#[derive(Deserialize)]
struct OcrResponse {
    outcome: Outcome,
    players: Vec<RawOcrPlayer>,
    raw_text: String,
    warnings: Vec<String>,
}

pub(crate) struct Recognition {
    pub players: Vec<OcrPlayer>,
    pub raw_text: String,
    pub warnings: Vec<String>,
    pub completed: bool,
}

impl Recognition {
    pub fn failure(message: &str) -> Self {
        Self {
            players: vec![],
            raw_text: String::new(),
            warnings: vec![message.to_owned()],
            completed: false,
        }
    }

    pub fn matching_player(&self, name: &str) -> Option<(String, Outcome, Option<i64>)> {
        self.players
            .iter()
            .find(|player| player.player_name == name)
            .map(|player| {
                (
                    player.player_name.clone(),
                    player.outcome,
                    if player.outcome == Outcome::Failed {
                        Some(player.amount.unwrap_or(0))
                    } else {
                        player.amount
                    },
                )
            })
    }
}

#[derive(Clone)]
pub(crate) struct OcrService {
    client: Client,
    url: Url,
    workers: Arc<Semaphore>,
    image_workers: Arc<Semaphore>,
}

impl OcrService {
    pub fn new(value: &str) -> anyhow::Result<Self> {
        let mut url = Url::parse(value)?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "OCR_URL must be a configured HTTP service URL without credentials or query parameters"
        );
        url.set_path(&format!("{}/recognize", url.path().trim_end_matches('/')));
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(MAX_RECOGNITION_TIME)
            .build()?;
        Ok(Self {
            client,
            url,
            // The CPU OCR service has one inference worker. Queue uploads here instead
            // of sending concurrent jobs which the service correctly rejects as busy.
            workers: Arc::new(Semaphore::new(1)),
            image_workers: Arc::new(Semaphore::new(2)),
        })
    }

    pub async fn validate_image(
        &self,
        bytes: Bytes,
        content_type: &str,
    ) -> Result<(i32, i32), ApiError> {
        let format = match content_type {
            "image/png" => ImageFormat::Png,
            "image/jpeg" => ImageFormat::Jpeg,
            "image/webp" => ImageFormat::WebP,
            _ => return Err(ApiError::validation("仅支持 PNG、JPEG 和 WebP 图片")),
        };
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(ApiError::validation(
                "图片为空或超过 12 MiB，请选择较小的原图",
            ));
        }
        let permit = self
            .image_workers
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ApiError::internal("image workers unavailable"))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if image::guess_format(&bytes).ok() != Some(format) {
                return Err(ApiError::validation("图片真实格式与声明的文件类型不一致"));
            }
            let make_reader = || {
                let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
                let mut limits = Limits::default();
                limits.max_image_width = Some(16_000);
                limits.max_image_height = Some(16_000);
                limits.max_alloc = Some(200 * 1024 * 1024);
                reader.limits(limits);
                reader
            };
            let (width, height) = make_reader()
                .into_dimensions()
                .map_err(|_| ApiError::validation("无法读取图片尺寸，文件可能已损坏"))?;
            if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 {
                return Err(ApiError::validation(
                    "图片最多允许 4000 万像素，单边不超过 16000 像素",
                ));
            }
            make_reader()
                .decode()
                .map_err(|_| ApiError::validation("无法解码图片，文件可能已损坏或尺寸过大"))?;
            Ok((width as i32, height as i32))
        })
        .await
        .map_err(|_| ApiError::internal("image decoder interrupted"))?
    }

    pub async fn recognize(&self, bytes: Bytes, content_type: &str) -> Recognition {
        let permit = match tokio::time::timeout(
            MAX_QUEUE_WAIT,
            self.workers.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => permit,
            Ok(Err(_)) => return OcrError::Unavailable.recognition(),
            Err(_) => return OcrError::Busy(Duration::ZERO).recognition(),
        };
        let _permit = permit;
        // One bounded budget covers HTTP calls and any Retry-After delays. Combined
        // with queueing this stays below the desktop bridge's 100-second timeout.
        match tokio::time::timeout(
            MAX_RECOGNITION_TIME,
            self.call_with_busy_retry(bytes, content_type),
        )
        .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => error.recognition(),
            Err(_) => OcrError::Timeout.recognition(),
        }
    }

    async fn call_with_busy_retry(
        &self,
        bytes: Bytes,
        content_type: &str,
    ) -> Result<Recognition, OcrError> {
        // A second API process or a native job surviving a cancelled request can
        // still hold the OCR worker. Only the explicit busy response is retriable.
        for attempt in 0..=MAX_BUSY_RETRIES {
            match self.call(bytes.clone(), content_type).await {
                Err(OcrError::Busy(delay))
                    if attempt < MAX_BUSY_RETRIES && delay <= Duration::from_secs(5) =>
                {
                    tokio::time::sleep(delay).await;
                }
                result => return result,
            }
        }
        unreachable!("the final attempt always returns");
    }

    async fn call(&self, bytes: Bytes, content_type: &str) -> Result<Recognition, OcrError> {
        let mut response = self
            .client
            .post(self.url.clone())
            .header("content-type", content_type)
            .body(bytes)
            .send()
            .await
            .map_err(OcrError::from_request)?;
        if response.status() == StatusCode::GATEWAY_TIMEOUT {
            return Err(OcrError::Timeout);
        }
        if response.status() == StatusCode::SERVICE_UNAVAILABLE
            && let Some(delay) = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
        {
            return Err(OcrError::Busy(Duration::from_secs(delay.max(1))));
        }
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > MAX_OCR_BODY as u64)
        {
            return Err(OcrError::Unavailable);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(OcrError::from_request)? {
            if body.len() + chunk.len() > MAX_OCR_BODY {
                return Err(OcrError::Unavailable);
            }
            body.extend_from_slice(&chunk);
        }
        let raw: OcrResponse = serde_json::from_slice(&body).map_err(|_| OcrError::Unavailable)?;
        if raw.players.len() > 100
            || raw.raw_text.chars().count() > 100_000
            || raw.warnings.len() > 100
        {
            return Err(OcrError::Unavailable);
        }
        let mut warnings = raw
            .warnings
            .into_iter()
            .map(|value| value.chars().take(1000).collect())
            .collect::<Vec<String>>();
        let mut players = Vec::with_capacity(raw.players.len());
        for player in raw.players {
            let amount = player
                .amount
                .as_ref()
                .and_then(|value| {
                    value.as_i64().or_else(|| {
                        value
                            .as_f64()
                            .filter(|value| {
                                value.fract() == 0.0 && (0.0..=MAX_AMOUNT as f64).contains(value)
                            })
                            .map(|value| value as i64)
                    })
                })
                .filter(|value| (0..=MAX_AMOUNT).contains(value));
            if player.amount.is_some() && amount.is_none() {
                warnings.push("部分识别金额不是有效的非负整数，请人工确认。".into());
            }
            let player_name: String = player
                .player_name
                .trim()
                .chars()
                .filter(|character| !character.is_control())
                .take(80)
                .collect();
            players.push(OcrPlayer {
                player_name,
                outcome: player.outcome,
                amount,
                confidence: player.confidence.filter(|value| value.is_finite()),
            });
        }
        if players.is_empty() && raw.outcome != Outcome::Unknown {
            warnings.push("识别到了结果，但未定位玩家名称；请人工填写。".into());
        }
        Ok(Recognition {
            players,
            raw_text: raw.raw_text,
            warnings,
            completed: true,
        })
    }
}
