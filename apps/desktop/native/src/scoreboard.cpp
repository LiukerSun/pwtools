#include "scoreboard.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <optional>
#include <set>
#include <string_view>

namespace pwtools {
namespace {
using Json = nlohmann::json;
constexpr std::array<std::string_view, 5> kValueHeaders{"带出价值", "带出总价值", "撤离金额", "带出金额", "撤离价值"};
constexpr std::array<std::string_view, 8> kOtherHeaders{"击败", "敌方", "救助", "复活", "生存", "成就", "淘汰", "伤害"};

void Remove(std::string& text, std::string_view value) {
  for (auto position = text.find(value); position != std::string::npos; position = text.find(value, position)) text.erase(position, value.size());
}
std::string Trim(std::string text) {
  const auto start = text.find_first_not_of(" \t\r\n\v\f");
  if (start == std::string::npos) return {};
  return text.substr(start, text.find_last_not_of(" \t\r\n\v\f") - start + 1);
}
std::string Compact(std::string text) {
  for (auto token : {" ", "\t", "\r", "\n", "\v", "\f", "|", "｜", ":", "："}) Remove(text, token);
  return text;
}
std::size_t Length(std::string_view text) {
  return static_cast<std::size_t>(std::count_if(text.begin(), text.end(), [](unsigned char c) { return (c & 0xc0) != 0x80; }));
}
std::string Status(const std::string& text) {
  const auto value = Compact(text);
  const bool success = value.find("撤离成功") != std::string::npos || value.find("越狱成功") != std::string::npos;
  const bool failed = value.find("撤离失败") != std::string::npos || value.find("撤离失敗") != std::string::npos
      || value.find("越狱失败") != std::string::npos || value.find("越狱失敗") != std::string::npos;
  return success != failed ? (success ? "success" : "failed") : "unknown";
}
bool OtherHeader(const std::string& text) {
  const auto value = Compact(text);
  return std::any_of(kOtherHeaders.begin(), kOtherHeaders.end(), [&](auto word) { return value.find(word) != std::string::npos; });
}
std::optional<std::int64_t> Money(std::string text) {
  text = Trim(std::move(text)); Remove(text, " ");
  for (auto position = text.find("，"); position != std::string::npos; position = text.find("，", position)) text.replace(position, 3, ",");
  for (auto currency : {std::string_view("¥"), std::string_view("￥")}) if (text.starts_with(currency)) { text.erase(0, currency.size()); break; }
  if (text.empty()) return {};
  const bool grouped = text.find(',') != std::string::npos;
  std::size_t group = 0, digits = 0; bool first = true;
  for (const char c : text) {
    if (c >= '0' && c <= '9') { ++group; ++digits; }
    else if (c == ',' && group && (first ? group <= 3 : group == 3)) { group = 0; first = false; }
    else return {};
  }
  if (!group || digits > 10 || (grouped && group != 3)) return {};
  Remove(text, ",");
  std::int64_t result = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), result);
  if (parsed.ec != std::errc{} || result > 9999999999LL) return {};
  return result;
}
struct Column { OcrLine header; double left, right; };
std::optional<Column> ValueColumn(const std::vector<OcrLine>& lines, double width) {
  const OcrLine* header = nullptr;
  for (const auto& line : lines) {
    const auto text = Compact(line.text);
    if (line.confidence < 0.5 || std::find(kValueHeaders.begin(), kValueHeaders.end(), text) == kValueHeaders.end()) continue;
    if (header) return {};
    header = &line;
  }
  if (!header) return {};
  const OcrLine* neighbor = nullptr;
  for (const auto& line : lines) {
    if (std::abs(line.Cy() - header->Cy()) > std::max(line.Height(), header->Height()) * 1.2 || line.Cx() <= header->Cx() || !OtherHeader(line.text)) continue;
    if (!neighbor || line.Cx() < neighbor->Cx()) neighbor = &line;
  }
  if (!neighbor) return {};
  const auto padding = std::max((header->x1 - header->x0) * 0.8, width * 0.025);
  return Column{*header, std::max(0.0, header->x0 - padding), std::min((header->Cx() + neighbor->Cx()) / 2, header->x1 + padding)};
}
} // namespace

Json ParseScoreboard(std::vector<OcrLine> lines, double width, double height) {
  std::stable_sort(lines.begin(), lines.end(), [](const auto& a, const auto& b) { return a.Cy() == b.Cy() ? a.x0 < b.x0 : a.Cy() < b.Cy(); });
  std::string raw;
  for (const auto& line : lines) { if (!raw.empty()) raw += '\n'; raw += line.text; }
  Json warnings = Json::array(), players = Json::array();
  const auto column = ValueColumn(lines, width);
  if (!column) warnings.push_back("未可靠定位带出价值列，金额需要人工填写。");
  std::vector<OcrLine> anchors;
  for (const auto& line : lines) {
    if (Status(line.text) == "unknown" || line.confidence < 0.5
        || line.Height() >= (column ? std::max(column->header.Height() * 2.0, height * 0.06) : std::min(width * 0.04, height * 0.12))
        || line.Cy() <= (column ? column->header.Cy() + column->header.Height() : height * 0.25)
        || (column ? line.x1 >= column->left : line.Cx() >= width * 0.4)) continue;
    if (anchors.empty() || std::abs(line.Cy() - anchors.back().Cy()) > std::max(line.Height(), anchors.back().Height()) * 1.5) anchors.push_back(line);
    else if (line.confidence > anchors.back().confidence) anchors.back() = line;
  }
  if (column) {
    for (const auto& cell : lines) {
      if (cell.Cy() <= column->header.Cy() + column->header.Height() || cell.Cx() < column->left || cell.Cx() > column->right || !Money(cell.text) || cell.confidence < 0.65) continue;
      if (std::any_of(anchors.begin(), anchors.end(), [&](const auto& anchor) { const auto dy = cell.Cy() - anchor.Cy(); return dy >= -anchor.Height() && dy <= anchor.Height() * 4; })) continue;
      const OcrLine* name = nullptr;
      for (const auto& line : lines) {
        if (line.x0 < column->left - width * 0.17 || line.x0 >= column->left || line.x1 >= column->left
            || std::abs(line.Cy() - cell.Cy()) > column->header.Height() * 1.8 || Status(line.text) != "unknown"
            || Length(Trim(line.text)) < 1 || Length(Trim(line.text)) > 40 || line.confidence < 0.65) continue;
        if (!name || std::abs(line.Cy() - cell.Cy()) < std::abs(name->Cy() - cell.Cy())) name = &line;
      }
      if (name) anchors.push_back({name->x0, cell.Cy() - name->Height() / 2, name->x1, cell.Cy() + name->Height() / 2, name->text, name->confidence});
    }
  }
  std::stable_sort(anchors.begin(), anchors.end(), [](const auto& a, const auto& b) { return a.Cy() < b.Cy(); });
  if (anchors.size() > 4) anchors.resize(4);
  std::set<std::string> outcomes;
  for (std::size_t index = 0; index < anchors.size(); ++index) {
    const auto& anchor = anchors[index]; double gap = anchor.Height() * 7;
    if (anchors.size() > 1) { gap = index ? anchor.Cy() - anchors[index - 1].Cy() : anchors[1].Cy() - anchor.Cy(); if (index + 1 < anchors.size()) gap = std::min(gap, anchors[index + 1].Cy() - anchor.Cy()); }
    const auto top = anchor.Cy() - anchor.Height() * 0.8, bottom = anchor.Cy() + std::min(gap * 0.65, anchor.Height() * 5);
    const OcrLine* name = nullptr; std::vector<const OcrLine*> amounts;
    for (const auto& line : lines) {
      if (line.Cy() < top || line.Cy() > bottom) continue;
      if (Status(line.text) == "unknown" && line.Cy() > anchor.Cy() + anchor.Height() * 0.2 && std::abs(line.x0 - anchor.x0) <= width * 0.05
          && line.x1 < (column ? column->left : width * 0.4) && !OtherHeader(line.text) && Length(Trim(line.text)) <= 40 && (!name || line.Cy() < name->Cy())) name = &line;
      if (column && line.Cx() >= column->left && line.Cx() <= column->right && line.x0 >= column->left - width * 0.015
          && line.x1 <= column->right + width * 0.015 && Money(line.text) && line.confidence >= 0.65) amounts.push_back(&line);
    }
    const auto outcome = Status(anchor.text);
    const auto player_name = name ? Trim(name->text) : (outcome == "unknown" ? Trim(anchor.text) : "");
    Json amount = nullptr, confidence = nullptr;
    if (outcome == "failed") { amount = 0; confidence = anchor.confidence; }
    else if (column && amounts.size() == 1) { amount = *Money(amounts[0]->text); confidence = std::min(anchor.confidence, amounts[0]->confidence); }
    else if (column) warnings.push_back("第 " + std::to_string(index + 1) + " 位队员的带出金额未可靠识别，需要人工填写。");
    if (player_name.empty()) warnings.push_back("第 " + std::to_string(index + 1) + " 位队员的名字未可靠识别。");
    if (!confidence.is_null()) confidence = std::round(confidence.get<double>() * 10000) / 10000;
    players.push_back({{"player_name", player_name}, {"outcome", outcome}, {"amount", amount}, {"confidence", confidence}});
    if (outcome == "unknown") warnings.push_back("第 " + std::to_string(index + 1) + " 位队员的撤离状态未识别，需要人工确认。");
    outcomes.insert(outcome);
  }
  if (players.empty()) warnings.push_back("未可靠识别队员行，结果需要人工确认。");
  if (outcomes.size() > 1) warnings.push_back("队员撤离状态不一致，请逐行确认；整体状态不代表每位队员。");
  return {{"outcome", outcomes.size() == 1 ? *outcomes.begin() : "unknown"}, {"players", players}, {"raw_text", raw}, {"warnings", warnings}};
}
} // namespace pwtools
