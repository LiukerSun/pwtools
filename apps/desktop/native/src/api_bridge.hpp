#pragma once

#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <nlohmann/json.hpp>

namespace pwtools {

class ApiFailure : public std::runtime_error {
public:
  ApiFailure(std::string error_code, std::string message)
      : std::runtime_error(std::move(message)), code(std::move(error_code)) {}
  const std::string code;
};

// Execute runs on the caller's worker thread. Multiple callers may share one bridge.
// Images cross the host seam as base64; the bearer token never leaves this module.
class ApiBridge {
public:
  ApiBridge(std::string api_url, std::filesystem::path data_directory);
  ~ApiBridge();
  ApiBridge(const ApiBridge&) = delete;
  ApiBridge& operator=(const ApiBridge&) = delete;

  nlohmann::json Execute(const std::string& method, const nlohmann::json& args);
  bool PersistentSession() const noexcept;
  const std::string& ApiUrl() const noexcept;

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

} // namespace pwtools
