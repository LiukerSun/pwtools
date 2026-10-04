"""Conservative Delta Force scoreboard extraction from OCR text and geometry."""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class OCRLine:
    box: list[list[float]]
    text: str
    confidence: float

    @property
    def x0(self) -> float:
        return min(point[0] for point in self.box)

    @property
    def x1(self) -> float:
        return max(point[0] for point in self.box)

    @property
    def y0(self) -> float:
        return min(point[1] for point in self.box)

    @property
    def y1(self) -> float:
        return max(point[1] for point in self.box)

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def height(self) -> float:
        return max(1, self.y1 - self.y0)


VALUE_HEADERS = {"带出价值", "带出总价值", "撤离金额", "带出金额", "撤离价值"}
OTHER_HEADERS = ("击败", "敌方", "救助", "复活", "生存", "成就", "淘汰", "伤害")


def compact(text: str) -> str:
    return re.sub(r"[\s|｜:：]", "", text)


def status(text: str) -> str:
    normalized = compact(text)
    success = "撤离成功" in normalized
    failed = "撤离失败" in normalized or "撤离失敗" in normalized
    if success != failed:
        return "success" if success else "failed"
    return "unknown"


def money(text: str) -> int | None:
    # Accept only a whole monetary cell; do not turn time, ratios, kills or rank into money.
    normalized = text.strip().replace("，", ",").replace(" ", "")
    normalized = re.sub(r"^[¥￥]", "", normalized)
    if not re.fullmatch(r"(?:\d{1,3}(?:,\d{3})+|\d{1,10})", normalized):
        return None
    result = int(normalized.replace(",", ""))
    return result if result <= 9_999_999_999 else None


def value_column(lines: list[OCRLine], width: int) -> tuple[OCRLine, float, float] | None:
    headers = [line for line in lines if compact(line.text) in VALUE_HEADERS and line.confidence >= 0.5]
    if len(headers) != 1:
        return None
    header = headers[0]
    neighbors = [line for line in lines if abs(line.cy - header.cy) <= max(line.height, header.height) * 1.2
                 and line.cx > header.cx and any(word in compact(line.text) for word in OTHER_HEADERS)]
    if not neighbors:
        # A table value column needs an independently identified next column boundary.
        return None
    neighbor = min(neighbors, key=lambda line: line.cx)
    padding = max((header.x1 - header.x0) * 0.8, width * 0.025)
    # Missing the nearest stats header must not expand the monetary column into
    # the kills column. A distant detected header is only an outer boundary.
    right = min((header.cx + neighbor.cx) / 2, header.x1 + padding)
    left = max(0, header.x0 - padding)
    return header, left, right


def parse_scoreboard(lines: list[OCRLine], width: int, height: int) -> dict:
    ordered = sorted(lines, key=lambda line: (line.cy, line.x0))
    raw_text = "\n".join(line.text for line in ordered)
    warnings: list[str] = []
    column = value_column(lines, width)
    if column is None:
        warnings.append("未可靠定位带出价值列，金额需要人工填写。")
    header = column[0] if column else None
    # The title is much larger and above the table. It must never become a player row.
    anchors = [line for line in ordered if status(line.text) != "unknown"
               and line.confidence >= 0.5
               and line.height < (max(header.height * 2.0, height * 0.06) if header else min(width * 0.04, height * 0.12))
               and (line.cy > header.cy + header.height if header else line.cy > height * 0.25)
               and (line.x1 < column[1] if column else line.cx < width * 0.4)]
    # Duplicate detections at the same location do not create duplicate players.
    unique: list[OCRLine] = []
    for line in anchors:
        if not unique or abs(line.cy - unique[-1].cy) > max(line.height, unique[-1].height) * 1.5:
            unique.append(line)
        elif line.confidence > unique[-1].confidence:
            unique[-1] = line
    anchors = unique
    # A reliable value cell plus a nearby name can establish a row even when the
    # status label is absent. Its outcome remains unknown; the title is never used.
    if column:
        for cell in ordered:
            if cell.cy <= header.cy + header.height or not column[1] <= cell.cx <= column[2]:
                continue
            if money(cell.text) is None or cell.confidence < 0.65:
                continue
            if any(-anchor.height <= cell.cy - anchor.cy <= anchor.height * 4 for anchor in anchors):
                continue
            nearby_names = [line for line in ordered if column[1] - width * 0.17 <= line.x0 < column[1]
                            and line.x1 < column[1] and abs(line.cy - cell.cy) <= header.height * 1.8
                            and status(line.text) == "unknown"
                            and 1 <= len(line.text.strip()) <= 40 and line.confidence >= 0.65]
            if nearby_names:
                name = min(nearby_names, key=lambda line: abs(line.cy - cell.cy))
                anchors.append(OCRLine([[name.x0, cell.cy - name.height / 2], [name.x1, cell.cy - name.height / 2],
                                        [name.x1, cell.cy + name.height / 2], [name.x0, cell.cy + name.height / 2]],
                                       name.text, name.confidence))
    anchors = sorted(anchors, key=lambda line: line.cy)[:4]
    players: list[dict] = []
    for index, anchor in enumerate(anchors):
        next_y = anchors[index + 1].cy if index + 1 < len(anchors) else None
        prev_y = anchors[index - 1].cy if index else None
        gap = min([value for value in (next_y - anchor.cy if next_y else None,
                                       anchor.cy - prev_y if prev_y else None) if value is not None],
                  default=anchor.height * 7)
        top = anchor.cy - anchor.height * 0.8
        bottom = anchor.cy + min(gap * 0.65, anchor.height * 5)
        row = [line for line in ordered if top <= line.cy <= bottom]
        name_lines = [line for line in row if status(line.text) == "unknown"
                      and line.cy > anchor.cy + anchor.height * 0.2
                      and abs(line.x0 - anchor.x0) <= width * 0.05
                      and (line.x1 < column[1] if column else line.x1 < width * 0.4)
                      and not any(word in compact(line.text) for word in OTHER_HEADERS)
                      and len(line.text.strip()) <= 40]
        player_name = min(name_lines, key=lambda line: line.cy).text.strip() if name_lines else (
            anchor.text.strip() if status(anchor.text) == "unknown" else "")
        row_status = status(anchor.text)
        amount = 0 if row_status == "failed" else None
        confidence = anchor.confidence if row_status == "failed" else None
        if column and row_status != "failed":
            candidates = [line for line in row if column[1] <= line.cx <= column[2]
                          and line.x0 >= column[1] - width * 0.015
                          and line.x1 <= column[2] + width * 0.015
                          and money(line.text) is not None and line.confidence >= 0.65]
            if len(candidates) == 1:
                amount = money(candidates[0].text)
                confidence = min(anchor.confidence, candidates[0].confidence)
            else:
                warnings.append(f"第 {index + 1} 位队员的带出金额未可靠识别，需要人工填写。")
        if not player_name:
            warnings.append(f"第 {index + 1} 位队员的名字未可靠识别。")
        players.append({"player_name": player_name, "outcome": row_status,
                        "amount": amount, "confidence": round(confidence, 4) if confidence is not None else None})
        if row_status == "unknown":
            warnings.append(f"第 {index + 1} 位队员的撤离状态未识别，需要人工确认。")
    if not players:
        # No guessed row or guessed amount from the large title or miscellaneous numbers.
        warnings.append("未可靠识别队员行，结果需要人工确认。")
    outcomes = {player["outcome"] for player in players}
    outcome = next(iter(outcomes)) if len(outcomes) == 1 else "unknown"
    if len(outcomes) > 1:
        warnings.append("队员撤离状态不一致，请逐行确认；整体状态不代表每位队员。")
    return {"outcome": outcome, "players": players, "raw_text": raw_text, "warnings": warnings}
