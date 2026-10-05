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

}

int wmain(int argc, wchar_t** argv) {
  try {
    Check(argc == 2, "local OCR runtime directory required");
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
