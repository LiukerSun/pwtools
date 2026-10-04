use crate::error::ApiError;

pub fn email(value: String) -> Result<String, ApiError> {
    let normalized = value.trim().to_ascii_lowercase();
    let Some((local, domain)) = normalized.split_once('@') else {
        return Err(ApiError::validation("请输入有效的邮箱地址"));
    };
    if normalized.len() > 254
        || local.is_empty()
        || local.len() > 64
        || !normalized.is_ascii()
        || normalized
            .bytes()
            .any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains('@')
    {
        return Err(ApiError::validation("请输入有效的邮箱地址"));
    }
    Ok(normalized)
}

pub fn password(value: &str) -> Result<(), ApiError> {
    if !(10..=128).contains(&value.chars().count()) {
        return Err(ApiError::validation("密码需要包含 10 至 128 个字符"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_email_and_enforces_password_limits() {
        assert_eq!(
            email(" HELLO@Example.com ".into()).ok().as_deref(),
            Some("hello@example.com")
        );
        assert!(email("hello@example.com@other.com".into()).is_err());
        assert!(password("too-short").is_err());
        assert!(password(&"界".repeat(128)).is_ok());
        assert!(password(&"界".repeat(129)).is_err());
        assert!(email("user@例子.com".into()).is_err());
    }
}
