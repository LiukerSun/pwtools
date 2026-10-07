#include "local_ocr.hpp"
#include "api_bridge.hpp"
#include "scoreboard.hpp"
#include <windows.h>
#include <psapi.h>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <vector>

namespace {
using Json = nlohmann::json;
void Check(bool result, const char* message) { if (!result) throw std::runtime_error(message); }
std::vector<unsigned char> Read(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  Check(input.good(), "sample could not be read");
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

pwtools::OcrLine Line(std::string text, double x, double y, double width = 110, double height = 30) {
  return {x, y, x + width, y + height, std::move(text), 0.99};
}

void CheckScoreboardOutcomes() {
  const auto parse = [](const std::string& first, const std::string& second) {
    // Measured table geometry, with generic player names and no screenshot data.
    return pwtools::ParseScoreboard({
      Line("越狱成功", 100, 170, 450, 138),
      Line("带出价值", 485, 498, 115, 41), Line("击败干员", 752, 499, 115, 40),
      Line(first, 261, 583, 92, 31), Line("队员1", 261, 615), Line("3,314,221", 488, 598, 150, 39),
      Line(second, 261, 727, 92, 31), Line("队员2", 261, 759), Line("1,867,449", 488, 742, 150, 39),
    }, 2560, 1440);
  };
  for (const auto success : {"撤离成功", "越狱成功", "越 狱 成 功"}) {
    const auto result = parse(success, success);
    Check(result["outcome"] == "success" && result["players"].size() == 2,
          "successful prison escape must be recognized as successful extraction");
    Check(result["players"][0]["player_name"] == "队员1" && result["players"][1]["player_name"] == "队员2",
          "escape status must not replace player names");
    Check(result["players"][0]["amount"] == 3314221 && result["players"][1]["amount"] == 1867449,
          "successful escape must preserve value-column amounts");
    Check(result["warnings"].empty(), "recognized escape rows must not require status correction");
  }
  for (const auto failed : {"撤离失败", "撤离失敗", "越狱失败", "越狱失敗", "越 狱 失 败"}) {
    const auto result = parse(failed, failed);
    Check(result["outcome"] == "failed" && result["players"].size() == 2,
          "failed prison escape must be recognized despite the success banner");
    Check(result["players"][0]["amount"] == 0 && result["players"][1]["amount"] == 0,
          "failed escape must use the same zero-amount rule as failed extraction");
    Check(result["raw_text"].get<std::string>().find(failed) != std::string::npos
          && result["raw_text"].get<std::string>().find("1,867,449") != std::string::npos,
          "escape parsing must preserve original OCR text");
  }
  for (const auto failed : {"撤离失败", "越狱失败"}) {
    const auto mixed = parse("越狱成功", failed);
    Check(mixed["outcome"] == "unknown" && mixed["players"][0]["outcome"] == "success"
          && mixed["players"][1]["outcome"] == "failed" && mixed["players"][1]["amount"] == 0,
          "mixed escape outcomes must remain independent of the banner and each other");
  }
  for (const auto unknown : {"", "越狱成功 越狱失败", "撤离成功 越狱失败", "越狱成功 撤离失败"}) {
    const auto result = parse("越狱成功", unknown);
    Check(result["outcome"] == "unknown" && result["players"].size() == 2
          && result["players"][1]["outcome"] == "unknown" && result["players"][1]["amount"] == 1867449,
          "missing or conflicting escape status must remain unknown");
  }
}

}

int wmain(int argc, wchar_t** argv) {
  try {
    Check(argc == 2, "local OCR runtime directory required");
    CheckScoreboardOutcomes();
    pwtools::LocalOcr ocr(argv[1]);
    // Exercise the actual native decoder and inference without opening a window.
    const std::vector<unsigned char> png{
      137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,2,0,0,0,144,119,83,222,
      0,0,0,12,73,68,65,84,120,156,99,96,96,96,0,0,0,4,0,1,246,23,56,85,
      0,0,0,0,73,69,78,68,174,66,96,130
    };
    for (unsigned i = 0; i != 1; ++i) {
      const auto result = ocr.Recognize(png, "image/png");
      Check(result["outcome"] == "unknown" && result["players"].empty(), "blank image must remain unknown");
    }
    bool failed = false;
    try { ocr.Recognize({1,2,3}, "image/png"); }
    catch (const pwtools::ApiFailure&) { failed = true; }
    Check(failed, "invalid images must fail");
    Check(ocr.Recognize(png, "image/png")["outcome"] == "unknown", "recognizer must recover after failure");
    wchar_t* sample = nullptr;
    std::size_t sample_size = 0;
    _wdupenv_s(&sample, &sample_size, L"PWTOOLS_OCR_SAMPLE");
    std::unique_ptr<wchar_t, decltype(&std::free)> sample_owner(sample, &std::free);
    if (sample) {
      const auto bytes = Read(sample);
      for (unsigned i = 0; i != 1; ++i) {
        const auto started = std::chrono::steady_clock::now();
        const auto result = ocr.Recognize(bytes, "image/png");
        std::vector<std::int64_t> amounts;
        for (const auto& player : result.at("players")) amounts.push_back(player.at("amount").get<std::int64_t>());
        Check(amounts == std::vector<std::int64_t>({3314221,1867449,97593}), "real scoreboard amounts changed");
        std::cout << "real OCR seconds: " << std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count() << '\n';
        PROCESS_MEMORY_COUNTERS counters{};
        if (GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters)))
          std::cout << "released / peak working set MiB: " << counters.WorkingSetSize / (1024*1024) << " / " << counters.PeakWorkingSetSize / (1024*1024) << '\n';
      }
    }
    std::cout << "Native local OCR, image validation and recovery passed.\n";
    return 0;
  } catch (const std::exception& failure) {
    std::cerr << failure.what() << '\n';
    return 1;
  }
}
