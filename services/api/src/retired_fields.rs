//! Accept neutral fields sent by released clients without restoring retired features.

use crate::error::ApiError;

pub(crate) fn obtained() -> String {
    "obtained".into()
}

pub(crate) fn appearance() -> String {
    "appearance".into()
}

pub(crate) fn configuration(
    item_id: Option<&str>,
    item_name: &str,
    expected: &str,
    condition: &str,
) -> Result<(), ApiError> {
    if item_id.is_some()
        || !item_name.is_empty()
        || expected != "obtained"
        || condition != "appearance"
    {
        return Err(ApiError::validation("物品配置已停用，请更新客户端"));
    }
    Ok(())
}

pub(crate) fn item_result(value: Option<bool>) -> Result<(), ApiError> {
    if value.is_some() {
        return Err(ApiError::validation("物品结果已停用，请更新客户端"));
    }
    Ok(())
}
