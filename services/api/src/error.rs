use axum::{
    Json,
    extract::{FromRequest, Request, rejection::JsonRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::de::DeserializeOwned;
use serde_json::json;

pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
}

impl ApiError {
    pub const fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }

    pub const fn validation(message: &'static str) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_ERROR",
            message,
        )
    }

    pub const fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "登录已失效，请重新登录",
        )
    }

    pub fn internal(context: &'static str) -> Self {
        // Never log a request body, token, password hash, or database error values.
        tracing::error!(context, "request failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "服务暂时无法处理请求，请稍后重试",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

/// Converts Axum JSON rejections into the same public error contract as handlers.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|rejection: JsonRejection| match rejection.status() {
                StatusCode::PAYLOAD_TOO_LARGE => ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "PAYLOAD_TOO_LARGE",
                    "请求内容过大，请缩短后再试",
                ),
                StatusCode::UNSUPPORTED_MEDIA_TYPE => ApiError::new(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "UNSUPPORTED_MEDIA_TYPE",
                    "请使用 JSON 格式提交请求",
                ),
                _ => ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "INVALID_JSON",
                    "请求格式不正确，请检查填写内容",
                ),
            })
    }
}
