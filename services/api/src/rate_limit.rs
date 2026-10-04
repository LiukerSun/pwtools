use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header::RETRY_AFTER},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::{AppState, error::ApiError};

const WINDOW: Duration = Duration::from_secs(60);
const MAX_ATTEMPTS: u32 = 10;
const MAX_TRACKED_IPS: usize = 10_000;

#[derive(Clone, Default)]
pub(crate) struct AuthRateLimiter {
    entries: Arc<Mutex<HashMap<IpAddr, Window>>>,
    trusted_proxy_ips: Arc<HashSet<IpAddr>>,
}

struct Window {
    starts_at: Instant,
    count: u32,
}

impl AuthRateLimiter {
    pub(crate) fn with_trusted_proxy_ips(value: &str) -> anyhow::Result<Self> {
        let trusted_proxy_ips = value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                value.parse::<IpAddr>().map_err(|_| {
                    anyhow::anyhow!(
                        "TRUSTED_PROXY_IPS must be a comma-separated list of exact IP addresses"
                    )
                })
            })
            .collect::<anyhow::Result<HashSet<_>>>()?;
        Ok(Self {
            trusted_proxy_ips: Arc::new(trusted_proxy_ips),
            ..Self::default()
        })
    }

    fn client_ip(&self, peer: IpAddr, headers: &HeaderMap) -> IpAddr {
        if !self.trusted_proxy_ips.contains(&peer) {
            return peer;
        }
        // The configured proxy must replace this header. Forwarded, X-Forwarded-For
        // and Cloudflare headers are not trusted directly by the API.
        let mut values = headers.get_all("x-real-ip").iter();
        let client = values
            .next()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<IpAddr>().ok());
        if values.next().is_some() {
            return peer;
        }
        client.unwrap_or(peer)
    }

    fn request_ip(&self, request: &Request) -> IpAddr {
        request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map_or(IpAddr::V4(Ipv4Addr::LOCALHOST), |peer| {
                self.client_ip(peer.0.ip(), request.headers())
            })
    }

    fn check(&self, ip: IpAddr) -> Result<(), u64> {
        let now = Instant::now();
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.retain(|_, entry| now.duration_since(entry.starts_at) < WINDOW);
        if !entries.contains_key(&ip) && entries.len() >= MAX_TRACKED_IPS {
            return Err(WINDOW.as_secs());
        }
        let entry = entries.entry(ip).or_insert(Window {
            starts_at: now,
            count: 0,
        });
        if entry.count >= MAX_ATTEMPTS {
            return Err(WINDOW
                .saturating_sub(now.duration_since(entry.starts_at))
                .as_secs()
                .max(1));
        }
        entry.count += 1;
        Ok(())
    }
}

pub(crate) async fn middleware(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let ip = state.auth_rate_limiter.request_ip(&request);
    if let Err(seconds) = state.auth_rate_limiter.check(ip) {
        let mut response = ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "操作过于频繁，请稍后再试",
        )
        .into_response();
        if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
            response.headers_mut().insert(RETRY_AFTER, value);
        }
        return response;
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> IpAddr {
        value.parse().expect("test IP address")
    }

    fn real_ip(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", value.parse().expect("test header"));
        headers
    }

    #[test]
    fn direct_and_untrusted_clients_cannot_spoof_the_rate_limit_source() {
        let peer = ip("192.0.2.10");
        let mut headers = real_ip("198.51.100.20");
        headers.insert("x-forwarded-for", "203.0.113.30".parse().unwrap());
        headers.insert("cf-connecting-ip", "203.0.113.40".parse().unwrap());
        headers.insert("forwarded", "for=203.0.113.50".parse().unwrap());
        assert_eq!(AuthRateLimiter::default().client_ip(peer, &headers), peer);
        let limiter = AuthRateLimiter::with_trusted_proxy_ips("192.0.2.11").unwrap();
        assert_eq!(limiter.client_ip(peer, &headers), peer);
        for _ in 0..MAX_ATTEMPTS {
            assert!(limiter.check(limiter.client_ip(peer, &headers)).is_ok());
        }
        assert!(
            limiter
                .check(limiter.client_ip(peer, &real_ip("198.51.100.21")))
                .is_err()
        );
    }

    #[test]
    fn exact_trusted_proxies_use_valid_ipv4_and_ipv6_client_addresses() {
        let limiter = AuthRateLimiter::with_trusted_proxy_ips(" 192.0.2.10, 2001:db8::10 ")
            .expect("exact proxy list");
        for peer in [ip("192.0.2.10"), ip("2001:db8::10")] {
            for client in ["198.51.100.20", "2001:db8::20"] {
                assert_eq!(limiter.client_ip(peer, &real_ip(client)), ip(client));
            }
        }
    }

    #[test]
    fn trusted_proxy_clients_have_independent_attempt_budgets() {
        let peer = ip("192.0.2.10");
        let limiter = AuthRateLimiter::with_trusted_proxy_ips("192.0.2.10").unwrap();
        for client in ["198.51.100.20", "198.51.100.21"] {
            let source = limiter.client_ip(peer, &real_ip(client));
            for _ in 0..MAX_ATTEMPTS {
                assert!(limiter.check(source).is_ok());
            }
            assert!(limiter.check(source).is_err());
        }
    }

    #[test]
    fn missing_invalid_or_ambiguous_proxy_headers_fall_back_to_peer() {
        let peer = ip("192.0.2.10");
        let limiter = AuthRateLimiter::with_trusted_proxy_ips("192.0.2.10").unwrap();
        assert_eq!(limiter.client_ip(peer, &HeaderMap::new()), peer);
        for value in [
            "",
            "not-an-ip",
            "198.51.100.20, 198.51.100.21",
            "198.51.100.20:8080",
            "198.51.100.0/24",
        ] {
            assert_eq!(limiter.client_ip(peer, &real_ip(value)), peer);
        }
        let mut headers = real_ip("198.51.100.20");
        headers.append("x-real-ip", "198.51.100.21".parse().unwrap());
        assert_eq!(limiter.client_ip(peer, &headers), peer);
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", HeaderValue::from_bytes(b"\xff").unwrap());
        assert_eq!(limiter.client_ip(peer, &headers), peer);
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.20".parse().unwrap());
        assert_eq!(limiter.client_ip(peer, &headers), peer);
    }

    #[test]
    fn missing_tcp_peer_cannot_authorize_a_forwarded_header() {
        let limiter = AuthRateLimiter::with_trusted_proxy_ips("127.0.0.1").unwrap();
        let request = Request::builder()
            .header("x-real-ip", "198.51.100.20")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(limiter.request_ip(&request), ip("127.0.0.1"));
    }

    #[test]
    fn proxy_configuration_accepts_only_exact_addresses_and_defaults_to_none() {
        for value in ["", "  "] {
            assert!(
                AuthRateLimiter::with_trusted_proxy_ips(value)
                    .unwrap()
                    .trusted_proxy_ips
                    .is_empty()
            );
        }
        for value in [
            "*",
            "localhost",
            "192.0.2.0/24",
            "[2001:db8::10]",
            "192.0.2.10:8080",
            "192.0.2.10,invalid",
        ] {
            assert!(AuthRateLimiter::with_trusted_proxy_ips(value).is_err());
        }
    }
}
