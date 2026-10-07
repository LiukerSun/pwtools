use crate::error::ApiError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};

pub const MAIN: &[(&str, &str, &str)] = &[
    ("damage", "肉伤", ""),
    ("armor_damage", "甲伤", ""),
    ("range_m", "射程", "米"),
    ("recoil_control", "后座", ""),
    ("handling", "操控", ""),
    ("stability", "稳定性", ""),
    ("hip_fire", "腰射", ""),
    ("fire_rate_rpm", "射速", "发/分"),
];
const EXTRA: &[&str] = &[
    "capacity",
    "fire_modes",
    "muzzle_velocity_mps",
    "sound_distance_m",
    "price",
];

#[derive(Default)]
pub enum AttributeChange {
    #[default]
    Missing,
    Present(Value),
}
pub fn attribute_change<'de, D: Deserializer<'de>>(d: D) -> Result<AttributeChange, D::Error> {
    Value::deserialize(d).map(AttributeChange::Present)
}

pub fn validate_values(values: &Value, require_main: bool) -> Result<(), ApiError> {
    let object = values
        .as_object()
        .ok_or_else(|| ApiError::validation("属性必须是字段对象"))?;
    for (key, value) in object {
        if !MAIN.iter().any(|(k, _, _)| k == key) && !EXTRA.contains(&key.as_str()) {
            return Err(ApiError::validation("包含不支持的属性字段"));
        }
        if value.is_null() {
            continue;
        }
        if key == "fire_modes" {
            let modes = value
                .as_array()
                .ok_or_else(|| ApiError::validation("开火模式格式不正确"))?;
            let mut seen = Vec::new();
            for mode in modes {
                let mode = mode
                    .as_str()
                    .filter(|m| ["全自动", "单发", "点射"].contains(m))
                    .ok_or_else(|| ApiError::validation("不支持的开火模式"))?;
                if seen.contains(&mode) {
                    return Err(ApiError::validation("开火模式不能重复"));
                }
                seen.push(mode);
            }
        } else {
            let number = value
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| ApiError::validation("属性必须是有效数值"))?;
            let max = if key == "price" {
                9_000_000_000_000.0
            } else {
                1_000_000.0
            };
            if !(0.0..=max).contains(&number)
                || (["price", "capacity", "fire_rate_rpm"].contains(&key.as_str())
                    && number.fract() != 0.0)
            {
                return Err(ApiError::validation("属性超出范围或整数格式不正确"));
            }
        }
    }
    if require_main
        && !MAIN
            .iter()
            .any(|(key, _, _)| object.get(*key).is_some_and(|v| !v.is_null()))
    {
        return Err(ApiError::validation("请至少填写一项主要枪支属性"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManualInput {
    identity: Value,
    values: Value,
    source: String,
    confirmed: bool,
    #[serde(default)]
    recognized_at: Option<DateTime<Utc>>,
}
pub fn identity(weapon: &str, mode: &str, core: &str) -> Value {
    json!({"weapon_name":weapon, "mode":mode, "core_code":core})
}
pub fn snapshot(value: &Value, identity: &Value) -> Result<Value, ApiError> {
    let input: ManualInput = serde_json::from_value(value.clone())
        .map_err(|_| ApiError::validation("个人属性格式不正确"))?;
    if !input.confirmed || input.identity != *identity {
        return Err(ApiError::validation("请确认属性与当前改枪码对应"));
    }
    if !["manual", "ocr_confirmed"].contains(&input.source.as_str())
        || (input.source == "ocr_confirmed" && input.recognized_at.is_none())
    {
        return Err(ApiError::validation("属性来源或识别时间不正确"));
    }
    if input
        .recognized_at
        .is_some_and(|t| t > Utc::now() + chrono::Duration::minutes(5))
    {
        return Err(ApiError::validation("识别时间不能晚于当前时间"));
    }
    validate_values(&input.values, true)?;
    Ok(
        json!({"identity":identity, "values":input.values, "source":input.source,
        "recognized_at":input.recognized_at, "confirmed_at":Utc::now()}),
    )
}
pub fn effective(snapshot: &Value) -> Value {
    let values = &snapshot["values"];
    let properties: Vec<Value> = MAIN
        .iter()
        .filter_map(|(key, name, unit)| {
            let value = values.get(*key).filter(|v| !v.is_null())?;
            Some(json!({"name":name,"value":value,"change":"","unit":unit}))
        })
        .collect();
    json!({"source":if snapshot["source"] == "ocr_confirmed" {"个人截图校对"} else {"个人手工录入"},
        "snapshot_source":snapshot["source"],"fetched_at":snapshot["confirmed_at"],"recognized_at":snapshot["recognized_at"],
        "provider_id":null,"price":values["price"],"properties":properties,"details":values})
}

pub fn sanitize_candidate(value: Value) -> Result<Value, ApiError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Candidate {
        status: String,
        weapon_name: Option<String>,
        values: Value,
        confidences: std::collections::BTreeMap<String, f64>,
        warnings: Vec<String>,
        missing: Vec<String>,
    }
    let candidate: Candidate = serde_json::from_value(value)
        .map_err(|_| ApiError::validation("识别服务返回格式不正确"))?;
    validate_values(&candidate.values, false)?;
    if !["completed", "no_text", "no_fields"].contains(&candidate.status.as_str())
        || candidate
            .weapon_name
            .as_ref()
            .is_some_and(|s| s.chars().count() > 100 || s.chars().any(char::is_control))
        || candidate.warnings.len() > 20
        || candidate.warnings.iter().any(|s| s.chars().count() > 200)
        || candidate.confidences.len() > 13
        || candidate.confidences.iter().any(|(k, v)| {
            candidate.values.get(k).is_none() || !v.is_finite() || !(0.0..=1.0).contains(v)
        })
        || candidate.missing.len() > 8
        || candidate
            .missing
            .iter()
            .any(|k| !MAIN.iter().any(|(key, _, _)| key == k))
    {
        return Err(ApiError::validation("识别服务返回内容不正确"));
    }
    Ok(
        json!({"status":candidate.status,"weapon_name":candidate.weapon_name,"values":candidate.values,
        "confidences":candidate.confidences,"warnings":candidate.warnings,"missing":candidate.missing}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn values_require_real_stats_and_distinguish_zero() {
        assert!(validate_values(&json!({"damage":0}), true).is_ok());
        for value in [
            json!({"price":100}),
            json!({"damage":null}),
            json!({"damage":-1}),
            json!({"capacity":1.5,"damage":39}),
            json!({"damage":39,"unknown":5}),
        ] {
            assert!(validate_values(&value, true).is_err());
        }
    }
    #[test]
    fn snapshot_is_bound_and_server_timed() {
        let id = identity("M7战斗步枪", "烽火地带", "ABCDEFGH");
        let mut input =
            json!({"identity":id,"values":{"damage":39},"source":"manual","confirmed":true});
        let saved = snapshot(&input, &id).ok().unwrap();
        assert!(saved["confirmed_at"].is_string());
        assert_eq!(effective(&saved)["properties"][0]["value"], 39);
        input["confirmed_at"] = json!("2026-01-01");
        assert!(snapshot(&input, &id).is_err());
    }
}
