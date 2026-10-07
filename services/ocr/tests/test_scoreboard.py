import pytest

from scoreboard import OCRLine, money, parse_scoreboard


def line(text, x, y, width=110, height=30, confidence=0.99):
    return OCRLine([[x, y], [x + width, y], [x + width, y + height], [x, y + height]], text, confidence)


def sample_lines(outcome="撤离成功"):
    # Necessary measured detection geometry only; no screenshot fixture or personal names.
    lines = [line(outcome, 100, 170, 450, 138), line("带出价值", 485, 498, 115, 41),
             line("击败干员", 752, 499, 115, 40), line("其他敌方", 1019, 498),
             line("救助/复活", 1286, 499), line("生存时长", 1554, 496)]
    for index, (amount, y) in enumerate((("3,314,221", 598), ("1,867,449", 742), ("97,593", 885))):
        lines.extend([line(outcome, 261, y - 15, 92, 31), line(f"队员{index + 1}", 261, y + 17),
                      line(amount, 488, y, 150, 39), line("2", 757, y),
                      line("9", 1028, y), line("0/1", 1290, y), line("29.6分钟", 1557, y)])
    return lines


def test_measured_sample_geometry_extracts_only_value_column():
    result = parse_scoreboard(sample_lines(), 2560, 1440)
    assert result["outcome"] == "success"
    assert [player["amount"] for player in result["players"]] == [3314221, 1867449, 97593]
    assert [player["player_name"] for player in result["players"]] == ["队员1", "队员2", "队员3"]
    assert result["warnings"] == []


def test_mixed_rows_do_not_inherit_banner_and_failed_amount_is_zero():
    lines = sample_lines()
    lines[13] = line("撤离失败", 261, 727, 92, 31)
    result = parse_scoreboard(lines, 2560, 1440)
    assert result["outcome"] == "unknown"
    assert result["players"][1]["outcome"] == "failed"
    assert result["players"][1]["amount"] == 0
    assert "1,867,449" in result["raw_text"]


@pytest.mark.parametrize(("label", "outcome"), [
    ("越狱成功", "success"),
    ("越 狱 成 功", "success"),
    ("越狱失败", "failed"),
    ("越 狱 失 败", "failed"),
    ("越狱失敗", "failed"),
])
def test_prison_outcomes_follow_extraction_rules(label, outcome):
    result = parse_scoreboard(sample_lines(label), 2560, 1440)
    assert result["outcome"] == outcome
    assert [player["outcome"] for player in result["players"]] == [outcome] * 3
    assert [player["amount"] for player in result["players"]] == (
        [3314221, 1867449, 97593] if outcome == "success" else [0, 0, 0])
    assert [player["player_name"] for player in result["players"]] == ["队员1", "队员2", "队员3"]
    assert label in result["raw_text"]
    assert "1,867,449" in result["raw_text"]
    assert result["warnings"] == []


def test_mixed_prison_rows_do_not_inherit_success_banner():
    lines = sample_lines("越狱成功")
    lines[13] = line("越狱失败", 261, 727, 92, 31)
    result = parse_scoreboard(lines, 2560, 1440)
    assert result["outcome"] == "unknown"
    assert [player["outcome"] for player in result["players"]] == ["success", "failed", "success"]
    assert [player["amount"] for player in result["players"]] == [3314221, 0, 97593]
    assert "越狱失败" in result["raw_text"]
    assert "1,867,449" in result["raw_text"]


@pytest.mark.parametrize("label", [
    "越狱成功 越狱失败",
    "撤离成功 越狱失败",
    "越狱成功 撤离失败",
])
def test_conflicting_prison_outcomes_remain_unknown(label):
    lines = sample_lines()
    lines[6] = line(label, 261, 583, 92, 31)
    result = parse_scoreboard(lines, 2560, 1440)
    assert result["outcome"] == "unknown"
    assert len(result["players"]) == 3
    assert result["players"][0]["outcome"] == "unknown"
    assert result["players"][0]["amount"] == 3314221
    assert label in result["raw_text"]


def test_missing_header_never_uses_kills_or_survival_as_money():
    lines = [item for item in sample_lines() if item.text != "带出价值"]
    result = parse_scoreboard(lines, 2560, 1440)
    assert len(result["players"]) == 3
    assert all(player["amount"] is None for player in result["players"])


def test_missing_nearest_stats_header_cannot_expand_value_into_kills():
    lines = [item for item in sample_lines() if item.text not in ("击败干员", "3,314,221")]
    result = parse_scoreboard(lines, 2560, 1440)
    assert result["players"][0]["amount"] is None
    assert result["players"][1]["amount"] == 1867449


def test_status_missing_keeps_unknown_even_with_success_banner():
    lines = [item for item in sample_lines() if not (item.text == "撤离成功" and 700 < item.cy < 800)]
    result = parse_scoreboard(lines, 2560, 1440)
    assert len(result["players"]) == 3
    assert result["players"][1]["outcome"] == "unknown"
    assert result["players"][1]["amount"] == 1867449
    assert result["outcome"] == "unknown"


def test_low_confidence_amount_and_duplicate_header_are_not_guessed():
    lines = [line(item.text, item.x0, item.y0, item.x1 - item.x0, item.height,
                  0.4 if item.text == "3,314,221" else item.confidence) for item in sample_lines()]
    assert parse_scoreboard(lines, 2560, 1440)["players"][0]["amount"] is None
    lines.append(line("撤离金额", 480, 510))
    assert all(player["amount"] is None for player in parse_scoreboard(lines, 2560, 1440)["players"])


def test_unrelated_image_has_no_fabricated_players():
    result = parse_scoreboard([line("今天收入", 10, 10), line("123456", 20, 200)], 2560, 1440)
    assert result["outcome"] == "unknown"
    assert result["players"] == []


def test_money_rejects_non_monetary_numeric_shapes():
    assert money("29.6分钟") is None
    assert money("0/1") is None
    assert money("4223(+75)") is None
    assert money("¥ 3,314,221") == 3314221


def test_cropped_scoreboard_and_numeric_player_id_are_supported():
    cropped = [OCRLine([[point[0], point[1] - 450] for point in item.box],
                       "12345678" if item.text == "队员1" else item.text, item.confidence)
               for item in sample_lines() if item.y0 >= 450]
    result = parse_scoreboard(cropped, 2560, 520)
    assert [player["amount"] for player in result["players"]] == [3314221, 1867449, 97593]
    assert result["players"][0]["player_name"] == "12345678"
