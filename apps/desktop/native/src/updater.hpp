#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include <nlohmann/json.hpp>

namespace pwtools {

// The host owns the endpoint, cache and executable path. No URL or command is
// accepted from the renderer, and only a verified newer installer can run.
class Updater {
 public:
  Updater(std::string api_url, std::string current_version,
          std::filesystem::path data_directory, std::filesystem::path install_directory);
  ~Updater();
  Updater(const Updater&) = delete;
  Updater& operator=(const Updater&) = delete;
  nlohmann::json State() const;
  void Check();
  void DownloadUpdate();
  void Install();

 private:
  struct Impl;
  std::shared_ptr<Impl> impl_;
};

// Shared validation seam used by the downloader and its fixtures.
bool IsNewerVersion(const std::string& candidate, const std::string& current);
nlohmann::json ValidateUpdateManifest(const nlohmann::json& value);

} // namespace pwtools
