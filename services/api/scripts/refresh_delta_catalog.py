"""Refresh public Delta Force tables without executing JavaScript or downloading icons.

Initial import:
  python services/api/scripts/refresh_delta_catalog.py --dddj-catalog <archived JSON>
Later refreshes retain the clearly labelled historical rows from the bundled snapshot.
Only the fixed official public static tables below are fetched; no login API is used.
"""

from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

OFFICIAL_ROOT = "https://www.playdeltaforce.com/basic_info/"
OFFICIAL_PAGE = "https://www.playdeltaforce.com/events/officialwiki/"
TABLES = (
    ("collections", "prop_id", "collection", ""),
    ("medicines", "medicine_id", "consume", "药品"),
    ("injections", "injection_id", "consume", "针剂"),
    ("repair_kits", "repair_kit_id", "consume", "维修套件"),
    ("door_cards", "item_id", "key", ""),
    ("mandel_bricks", "item_id", "mandel", ""),
    ("guns", "gun_id", "gun", ""),
    ("attachments", "attachment_id", "acc", ""),
    ("bullets", "bullet_id", "ammo", ""),
    ("helmets", "helmet_id", "protect", "头盔"),
    ("armors", "armor_id", "protect", "护甲"),
    ("rigs", "rig_id", "protect", "胸挂与背包"),
)
CATEGORIES = {
    "collection": "收集品", "consume": "消耗品", "key": "钥匙卡",
    "mandel": "曼德尔砖", "gun": "枪械", "acc": "配件", "ammo": "弹药",
    "protect": "装备", "props": "其他物资", "weapon_skin": "武器外观",
    "vehicle_skin": "载具外观", "operator": "干员头像",
}
ICON_HOSTS = {"www.playdeltaforce.com", "playerhub.df.qq.com", "game.gtimg.cn"}
MAX_SOURCE_BYTES = 8 * 1024 * 1024


class OfficialRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith(OFFICIAL_ROOT):
            raise ValueError("refusing a redirect outside the official static catalog")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def safe_icon(value):
    if not value:
        return None
    parsed = urlparse(value)
    if (parsed.scheme != "https" or parsed.hostname not in ICON_HOSTS
            or parsed.username is not None or parsed.password is not None
            or parsed.port not in (None, 443)):
        return None
    return value


def label(value):
    if isinstance(value, dict):
        value = value.get("zh-TW") or value.get("zh-CN") or next(iter(value.values()), "")
    return str(value or "").strip()


def local_item(row):
    item_id = str(row["objectID"])
    name = label(row.get("objectName"))
    if not re.fullmatch(r"[0-9]+", item_id) or not name or "\ufffd" in name:
        raise ValueError("historical catalog contains an invalid identifier or name")
    primary = row.get("primaryClass")
    second = (row.get("secondClass") or "").strip()
    category = "acc" if primary == "attachment" else primary
    if category == "props" and second in {"collection", "consume", "key", "mandel"}:
        category = second
    if category not in CATEGORIES:
        raise ValueError(f"unmapped historical category: {category}")
    subcategory = label(row.get("secondClassCN"))
    details = row.get("propsDetail") or {}
    if category == "collection":
        subcategory = label(details.get("type"))
    elif category == "consume":
        subcategory = label(row.get("thirdClassCN"))
    elif category == "key":
        subcategory = label(details.get("useMap"))
    elif category == "mandel":
        subcategory = ""
    return {
        "id": item_id, "name": name, "category_id": category,
        "category": CATEGORIES[category], "subcategory": subcategory,
        "icon_url": safe_icon(row.get("pic")), "aliases": [],
        "source_url": row.get("metadata_source") or row.get("source_page") or "",
        "source_version": row.get("metadata_date"), "source_kind": "dddj_snapshot",
        "official_source_url": None, "official_name": None,
    }


def fetch_table(table):
    name, id_key, category, subcategory = table
    url = f"{OFFICIAL_ROOT}{name}_zh-TW.js"
    opener = build_opener(OfficialRedirects())
    raw = None
    for attempt in range(3):
        try:
            with opener.open(Request(url, headers={"User-Agent": "PWTools-Catalog/1.0"}), timeout=25) as response:
                raw = response.read(MAX_SOURCE_BYTES + 1)
            break
        except (HTTPError, URLError, TimeoutError) as error:
            if isinstance(error, HTTPError) and error.code < 500:
                raise
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    if raw is None or len(raw) > MAX_SOURCE_BYTES:
        raise ValueError("official catalog response exceeds the accepted size")
    text = raw.decode("utf-8-sig")
    match = re.fullmatch(r"\s*var\s+basic_info_[a-z_]+\s*=\s*(\[.*\]|\{.*\})\s*;?\s*", text, re.S)
    if not match:
        raise ValueError(f"unexpected static table format: {name}")
    parsed = json.loads(match[1])
    category_map = {}
    if name == "guns" and isinstance(parsed, dict):
        rows = parsed["guns"]
        category_map = parsed.get("guncategory_map", {})
    else:
        rows = parsed
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"empty official table: {name}")
    ids = set()
    for row in rows:
        item_id = str(row[id_key])
        name_value = label(row.get("language") or row.get("name"))
        if not re.fullmatch(r"[0-9]+", item_id) or item_id in ids or "\ufffd" in name_value:
            raise ValueError(f"invalid or duplicate official entry in {name}")
        ids.add(item_id)
    return table, rows, {
        "url": url, "kind": "official_public_static", "locale": "zh-TW",
        "item_count": len(rows), "sha256": hashlib.sha256(raw).hexdigest(),
        "category_map": category_map,
    }


def refresh(seed, output):
    fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    if seed is not None:
        raw = json.loads(seed.read_text(encoding="utf-8-sig"))
        if not isinstance(raw, list):
            raise ValueError("DDDJ input must be the archived merged item array")
        historical = [local_item(row) for row in raw]
    else:
        previous = json.loads(output.read_text(encoding="utf-8"))
        historical = [dict(row) for row in previous["items"] if row["source_kind"] == "dddj_snapshot"]
        # Do not retain previous official enrichment if a later official table removes an ID.
        for row in historical:
            row["aliases"] = [alias for alias in row["aliases"] if alias != row.get("official_name")]
            row["official_source_url"] = None
            row["official_name"] = None
    by_id = {row["id"]: row for row in historical}
    if len(by_id) != len(historical):
        raise ValueError("duplicate identifier in the historical snapshot")
    with ThreadPoolExecutor(max_workers=3) as executor:
        tables = list(executor.map(fetch_table, TABLES))
    official_ids = set()
    official_duplicates = set()
    sources = []
    unresolved = []
    for (table, rows, source) in tables:
        table_name, id_key, category, subcategory = table
        sources.append({**source, "fetched_at": fetched_at})
        for raw in rows:
            item_id = str(raw[id_key])
            if item_id in official_ids:
                # The official collection table also contains some keycards and
                # consumables. Later dedicated tables provide their precise type.
                official_duplicates.add(item_id)
            official_ids.add(item_id)
            name = label(raw.get("language") or raw.get("name"))
            if not name:
                unresolved.append({"id": item_id, "source_url": source["url"], "reason": "official name field is empty; diagnostic label only"})
            official_subcategory = subcategory
            if table_name == "attachments":
                official_subcategory = label(raw.get("category"))
            elif table_name == "guns":
                official_subcategory = label(source["category_map"].get(str(raw.get("category"))))
            elif table_name == "door_cards":
                official_subcategory = label(raw.get("usage_location_i18n") or raw.get("usage_location"))
            item = by_id.get(item_id)
            if item is None:
                item = {
                    "id": item_id, "name": name or f"名称未提供 · {item_id}", "category_id": category,
                    "category": CATEGORIES[category], "subcategory": official_subcategory,
                    "icon_url": None, "aliases": [], "source_url": source["url"],
                    "source_version": fetched_at, "source_kind": "official_public_static",
                    "official_source_url": None, "official_name": None,
                }
                by_id[item_id] = item
            elif item["source_kind"] == "official_public_static" and category != "collection":
                item["category_id"] = category
                item["category"] = CATEGORIES[category]
                item["subcategory"] = official_subcategory
                item["source_url"] = source["url"]
                if name and name != item["name"]:
                    item["aliases"].append(item["name"])
                    item["name"] = name
            if name and name != item["name"] and name not in item["aliases"]:
                item["aliases"].append(name)
            item["official_name"] = name or None
            item["official_source_url"] = source["url"]
            item["icon_url"] = safe_icon(raw.get("image_url")) or item["icon_url"]
            if not item["subcategory"] and official_subcategory:
                item["subcategory"] = official_subcategory
    items = sorted(by_id.values(), key=lambda row: (list(CATEGORIES).index(row["category_id"]), row["name"], row["id"]))
    counts = Counter(row["category_id"] for row in items)
    payload = {
        "schema_version": 1, "source_url": OFFICIAL_PAGE, "fetched_at": fetched_at,
        "scope": "DDDJ 2026-09-21 简体社区历史目录，按同一物品 ID 合并本次官方国际服繁体公开静态表；不代表国服最新全量或全部 CDN 资源。",
        "historical_snapshot": {"captured_at": "2026-09-21", "item_count": len(historical), "origin": "DDDJ archived public metadata; per-item source_url/source_version retain actual source dates"},
        "sources": sources,
        "official_entry_count": sum(source["item_count"] for source in sources),
        "official_unique_count": len(official_ids),
        "official_duplicate_ids": sorted(official_duplicates),
        "unresolved_items": unresolved,
        "categories": [{"id": key, "name": name, "count": counts[key]} for key, name in CATEGORIES.items() if counts[key]],
        "items": items,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output)
    print(json.dumps({"path": str(output), "historical_items": len(historical), "official_items": len(official_ids), "merged_items": len(items), "categories": len(payload["categories"]), "sources": len(sources), "unresolved_items": len(unresolved), "fetched_at": fetched_at}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dddj-catalog", type=Path, help="initial archived merged JSON array; no other DDDJ files are read")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data/delta_items.json")
    args = parser.parse_args()
    refresh(args.dddj_catalog, args.output)


if __name__ == "__main__":
    main()
