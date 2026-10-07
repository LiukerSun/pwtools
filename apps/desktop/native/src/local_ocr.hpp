#pragma once

#include <chrono>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace pwtools {

// Native, on-demand inference. The Windows decoder and ONNX Runtime consume
// images in memory; model sessions are released after each recognition.
class LocalOcr {
public:
  explicit LocalOcr(std::filesystem::path runtime_directory = {},
                    std::chrono::milliseconds timeout = std::chrono::seconds(45));
  ~LocalOcr();
  LocalOcr(const LocalOcr&) = delete;
  LocalOcr& operator=(const LocalOcr&) = delete;
  nlohmann::json Recognize(const std::vector<unsigned char>& image, const std::string& mime);
  nlohmann::json RecognizeBuildAttributes(const std::vector<unsigned char>& image, const std::string& mime);
  nlohmann::json Classify(const std::vector<unsigned char>& image, const std::string& mime);

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace pwtools
