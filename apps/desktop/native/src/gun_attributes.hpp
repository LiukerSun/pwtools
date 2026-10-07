#pragma once
#include "scoreboard.hpp"
namespace pwtools {
nlohmann::json ParseGunAttributes(const std::vector<OcrLine>& lines, double width, double height);
}
