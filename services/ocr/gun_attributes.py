"""Gun panel text/geometry extraction. No images or raw OCR text are retained."""
import re
from scoreboard import OCRLine

FIELDS = {
    "damage": ("基础伤害", "肉伤"), "armor_damage": ("护甲伤害", "甲伤"),
    "range_m": ("优势射程", "射程"), "recoil_control": ("后坐力控制", "后座"),
    "handling": ("操控速度", "操控"), "stability": ("据枪稳定性", "稳定性"),
    "hip_fire": ("腰际射击精度", "腰射"), "fire_rate_rpm": ("射速",),
    "capacity": ("容量",), "fire_modes": ("开火模式",),
    "muzzle_velocity_mps": ("枪口初速",), "sound_distance_m": ("枪声传播距离",),
    "price": ("价格",),
}
MAIN = tuple(FIELDS)[:8]
MODES = ("全自动", "单发", "点射")

def compact(text):
    return re.sub(r"\s+", "", text).replace("，", ",").replace("／", "/")

def parse_value(key, text):
    text = compact(text)
    if key == "fire_modes":
        values = text.split("/")
        return list(dict.fromkeys(values)) if values and all(v in MODES for v in values) else None
    units = {"range_m": "米", "fire_rate_rpm": "发/分", "muzzle_velocity_mps": "米/秒", "sound_distance_m": "米"}
    unit = units.get(key)
    if unit and text.endswith(unit):
        text = text[:-len(unit)]
    if not re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", text):
        return None
    value = float(text.replace(",", ""))
    if value > (9_000_000_000_000 if key == "price" else 1_000_000):
        return None
    if key in ("capacity", "price", "fire_rate_rpm") and not value.is_integer():
        return None
    return int(value) if value.is_integer() else value

def parse_gun_attributes(lines: list[OCRLine], width: float, height: float) -> dict:
    values, confidences, warnings = {}, {}, []
    weapon = None
    for line in lines:
        text = compact(line.text)
        if re.fullmatch(r".{1,95}(?:步枪|冲锋枪|机枪|霰弹枪|手枪|狙击枪)", text):
            if weapon and weapon != text:
                weapon = None
                warnings.append("识别到多个枪名，请核对武器名称。")
                break
            weapon = text
    for key, labels in FIELDS.items():
        candidates = []
        for line in lines:
            text = compact(line.text)
            label = next((label for label in labels if text.startswith(label)), None)
            if not label:
                continue
            tail = text[len(label):].lstrip(":：")
            if tail:
                value = parse_value(key, tail)
                if value is not None:
                    candidates.append((value, line.confidence))
                continue
            cy = (line.y0 + line.y1) / 2
            for right in lines:
                if right is line or right.x0 < line.x1 - 4:
                    continue
                if abs((right.y0 + right.y1) / 2 - cy) > max(line.y1-line.y0, right.y1-right.y0, 1) * .55:
                    continue
                value = parse_value(key, right.text)
                if value is not None:
                    candidates.append((value, min(line.confidence, right.confidence)))
        if len(candidates) == 1:
            values[key], confidences[key] = candidates[0]
            if candidates[0][1] < .8:
                warnings.append(f"{labels[0]}识别置信度较低，请核对。")
        elif len(candidates) > 1:
            warnings.append(f"{labels[0]}存在重复或冲突值，请手工填写。")
    status = "no_text" if not lines else "completed" if any(k in values for k in MAIN) else "no_fields"
    return dict(status=status, weapon_name=weapon, values=values, confidences=confidences,
                warnings=warnings, missing=[key for key in MAIN if key not in values])
