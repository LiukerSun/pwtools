use std::sync::OnceLock;

use axum::{
    Json,
    extract::{Query, State, rejection::QueryRejection},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use crate::{AppState, auth::AuthenticatedUser, error::ApiError};

#[derive(Clone, Deserialize, Serialize)]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    pub category_id: String,
    pub category: String,
    pub subcategory: String,
    pub icon_url: Option<String>,
    pub aliases: Vec<String>,
    pub source_url: String,
    pub source_version: Option<String>,
    pub source_kind: String,
    pub official_source_url: Option<String>,
    pub official_name: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct CatalogCategory {
    pub id: String,
    pub name: String,
    pub count: usize,
}

#[derive(Deserialize)]
struct CatalogSnapshot {
    source_url: String,
    fetched_at: String,
    scope: String,
    categories: Vec<CatalogCategory>,
    items: Vec<CatalogItem>,
}

#[derive(Default, Deserialize)]
pub struct CatalogQuery {
    q: Option<String>,
    category: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
}

#[derive(Serialize)]
pub struct CatalogResponse {
    pub source_url: &'static str,
    pub fetched_at: &'static str,
    pub scope: &'static str,
    pub snapshot_total: usize,
    pub total: usize,
    pub page: u32,
    pub page_size: u32,
    pub categories: &'static [CatalogCategory],
    pub items: Vec<&'static CatalogItem>,
}

fn snapshot() -> &'static CatalogSnapshot {
    static SNAPSHOT: OnceLock<CatalogSnapshot> = OnceLock::new();
    SNAPSHOT.get_or_init(|| {
        serde_json::from_str(include_str!("../data/delta_items.json"))
            .expect("embedded catalog validated before release")
    })
}

/// Validate a selected object ID and retain this server-side name on the order.
/// Historical and international-only entries preserve their source metadata.
pub fn lookup_item(id: &str) -> Option<&'static CatalogItem> {
    snapshot().items.iter().find(|item| item.id == id)
}

pub async fn list_catalog(
    State(_state): State<AppState>,
    _session: AuthenticatedUser,
    query: Result<Query<CatalogQuery>, QueryRejection>,
) -> Result<Json<CatalogResponse>, ApiError> {
    let Query(query) = query.map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "物品目录查询格式不正确",
        )
    })?;
    Ok(Json(search(query)?))
}

fn search(query: CatalogQuery) -> Result<CatalogResponse, ApiError> {
    let catalog = snapshot();
    let page = query.page.unwrap_or(1);
    let page_size = query.page_size.unwrap_or(40);
    if page == 0 || !(1..=100).contains(&page_size) {
        return Err(ApiError::validation("页码至少为 1，每页最多 100 个物品"));
    }
    let needle = query.q.as_deref().unwrap_or("").trim();
    let category = query.category.as_deref().unwrap_or("").trim();
    if needle.chars().count() > 100 || needle.chars().any(char::is_control) {
        return Err(ApiError::validation("物品搜索最多 100 个字符"));
    }
    if !category.is_empty() && !catalog.categories.iter().any(|item| item.id == category) {
        return Err(ApiError::validation("物品分类不存在，请重新选择"));
    }
    let terms: Vec<_> = needle
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let offset = (u64::from(page) - 1) * u64::from(page_size);
    let mut total = 0;
    let mut items = Vec::new();
    for item in &catalog.items {
        if !category.is_empty() && item.category_id != category {
            continue;
        }
        if !terms.is_empty() {
            let search_text = format!(
                "{} {} {} {} {}",
                item.id,
                item.name,
                item.category,
                item.subcategory,
                item.aliases.join(" ")
            )
            .to_lowercase();
            if !terms.iter().all(|term| search_text.contains(term)) {
                continue;
            }
        }
        let index = total as u64;
        total += 1;
        if index >= offset && items.len() < page_size as usize {
            items.push(item);
        }
    }
    Ok(CatalogResponse {
        source_url: &catalog.source_url,
        fetched_at: &catalog.fetched_at,
        scope: &catalog.scope,
        snapshot_total: catalog.items.len(),
        total,
        page,
        page_size,
        categories: &catalog.categories,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn embedded_catalog_preserves_sources_and_unique_identifiers() {
        let catalog = snapshot();
        assert!(catalog.items.len() > 2000);
        assert!(chrono::DateTime::parse_from_rfc3339(&catalog.fetched_at).is_ok());
        let mut seen = HashSet::new();
        let mut counts = HashMap::new();
        for item in &catalog.items {
            assert!(seen.insert(&item.id), "one object ID has exactly one entry");
            assert!(!item.name.trim().is_empty());
            assert!(!item.name.contains('\u{fffd}'));
            assert!(!item.source_url.is_empty());
            assert!(item.source_version.is_some());
            assert!(item.id.bytes().all(|byte| byte.is_ascii_digit()));
            if let Some(url) = &item.icon_url {
                let url = reqwest::Url::parse(url).expect("public icon URL");
                assert_eq!(url.scheme(), "https");
                assert!(matches!(
                    url.host_str(),
                    Some("www.playdeltaforce.com" | "playerhub.df.qq.com" | "game.gtimg.cn")
                ));
            }
            *counts.entry(item.category_id.as_str()).or_insert(0_usize) += 1;
        }
        for category in &catalog.categories {
            assert_eq!(counts.get(category.id.as_str()), Some(&category.count));
        }
    }

    #[test]
    fn search_supports_chinese_names_identifiers_filters_and_disjoint_pages() {
        let item = snapshot()
            .items
            .iter()
            .find(|item| item.name.contains("海洋之泪"))
            .expect("known collectible");
        let exact = search(CatalogQuery {
            q: Some(item.id.clone()),
            ..Default::default()
        })
        .unwrap_or_else(|_| panic!("search"));
        assert_eq!(exact.items.len(), 1);
        assert_eq!(exact.items[0].name, item.name);
        assert_eq!(
            lookup_item(&item.id).map(|item| item.name.as_str()),
            Some(item.name.as_str())
        );
        let chinese = search(CatalogQuery {
            q: Some("海洋之泪".into()),
            category: Some("collection".into()),
            ..Default::default()
        })
        .unwrap_or_else(|_| panic!("Chinese search"));
        assert!(chinese.items.iter().any(|row| row.id == item.id));
        let first = search(CatalogQuery {
            page_size: Some(5),
            ..Default::default()
        })
        .unwrap_or_else(|_| panic!("first page"));
        let second = search(CatalogQuery {
            page: Some(2),
            page_size: Some(5),
            ..Default::default()
        })
        .unwrap_or_else(|_| panic!("second page"));
        assert_eq!(first.total, second.total);
        assert_eq!(first.items.len(), 5);
        assert_eq!(second.items.len(), 5);
        assert!(
            first
                .items
                .iter()
                .all(|row| second.items.iter().all(|other| row.id != other.id))
        );
        assert!(
            search(CatalogQuery {
                page: Some(0),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            search(CatalogQuery {
                page_size: Some(101),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            search(CatalogQuery {
                category: Some("unknown".into()),
                ..Default::default()
            })
            .is_err()
        );
        let empty = search(CatalogQuery {
            page: Some(u32::MAX),
            ..Default::default()
        })
        .unwrap_or_else(|_| panic!("large valid page"));
        assert!(empty.items.is_empty());
    }
}
