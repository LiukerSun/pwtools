#pragma once

#include <algorithm>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace pwtools {
struct OcrLine {
  double x0, y0, x1, y1;
  std::string text;
  double confidence;
  double Cx() const { return (x0 + x1) / 2; }
  double Cy() const { return (y0 + y1) / 2; }
  double Height() const { return std::max(1.0, y1 - y0); }
};

// Amounts are accepted only inside an independently identified value column.
// Row outcomes and names never inherit the large match banner.
nlohmann::json ParseScoreboard(std::vector<OcrLine> lines, double width, double height);
} // namespace pwtools
