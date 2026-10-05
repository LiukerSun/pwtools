#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "updater.hpp"
#include "api_bridge.hpp"
#include <windows.h>
#include <winhttp.h>
#include <bcrypt.h>
#include <array>
#include <chrono>
#include <charconv>
#include <mutex>
#include <thread>
#include <vector>
#include <atomic>

namespace pwtools {
namespace {
namespace fs = std::filesystem;
using json = nlohmann::json;
constexpr uint64_t MaxInstallerBytes = 256ull * 1024 * 1024;
constexpr size_t MaxManifestBytes = 32 * 1024;

[[noreturn]] void InvalidManifest() { throw ApiFailure("UPDATE_INVALID", "更新信息不完整，请稍后重新检查。"); }
[[noreturn]] void NetworkFailure() { throw ApiFailure("UPDATE_NETWORK", "暂时无法获取更新，请检查网络后重试。"); }
[[noreturn]] void FileFailure() { throw ApiFailure("UPDATE_STORAGE", "无法保存更新文件，请检查磁盘空间后重试。"); }
[[noreturn]] void IntegrityFailure() { throw ApiFailure("UPDATE_INTEGRITY", "更新包校验未通过，请重新下载。"); }

std::array<unsigned, 3> Version(const std::string& value) {
  std::array<unsigned, 3> parts{};
  size_t begin = 0;
  if (value.empty() || value.size() > 17) InvalidManifest();
  for (size_t i = 0; i < parts.size(); ++i) {
    const auto end = i == 2 ? value.size() : value.find('.', begin);
    if (end == std::string::npos || end <= begin || end - begin > 5 || (end - begin > 1 && value[begin] == '0')) InvalidManifest();
    const auto parsed = std::from_chars(value.data() + begin, value.data() + end, parts[i]);
    if (parsed.ec != std::errc() || parsed.ptr != value.data() + end || parts[i] > 65535) InvalidManifest();
    begin = end + 1;
  }
  return parts;
}

std::wstring Wide(const std::string& value) {
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (!size) InvalidManifest();
  std::wstring result(size, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
  return result;
}

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE handle) : value(handle) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
struct Internet {
  HINTERNET value;
  explicit Internet(HINTERNET handle) : value(handle) { if (!value) NetworkFailure(); }
  ~Internet() { WinHttpCloseHandle(value); }
  Internet(const Internet&) = delete;
  Internet& operator=(const Internet&) = delete;
};

class Sha256 {
 public:
  Sha256() {
    if (BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) IntegrityFailure();
    if (BCryptCreateHash(algorithm_, &hash_, nullptr, 0, nullptr, 0, 0) < 0) { BCryptCloseAlgorithmProvider(algorithm_, 0); IntegrityFailure(); }
  }
  ~Sha256() { BCryptDestroyHash(hash_); BCryptCloseAlgorithmProvider(algorithm_, 0); }
  void Add(const unsigned char* bytes, DWORD count) { if (BCryptHashData(hash_, const_cast<PUCHAR>(bytes), count, 0) < 0) IntegrityFailure(); }
  std::string Finish() {
    std::array<unsigned char, 32> bytes{};
    if (BCryptFinishHash(hash_, bytes.data(), static_cast<ULONG>(bytes.size()), 0) < 0) IntegrityFailure();
    static constexpr char Hex[] = "0123456789abcdef";
    std::string result;
    for (const auto byte : bytes) { result += Hex[byte >> 4]; result += Hex[byte & 15]; }
    return result;
  }
 private:
  BCRYPT_ALG_HANDLE algorithm_ = nullptr;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
};

void RegularHandle(HANDLE file, uint64_t expectedSize) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  LARGE_INTEGER size{};
  if (file == INVALID_HANDLE_VALUE || !GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      (attributes.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || !GetFileSizeEx(file, &size) ||
      static_cast<uint64_t>(size.QuadPart) != expectedSize) IntegrityFailure();
}

void Verify(HANDLE file, uint64_t size, const std::string& expected) {
  RegularHandle(file, size);
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) IntegrityFailure();
  Sha256 hash;
  std::array<unsigned char, 64 * 1024> buffer{};
  DWORD read = 0;
  uint64_t total = 0;
  for (;;) {
    if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) IntegrityFailure();
    if (!read) break;
    if (!total && (read < 2 || buffer[0] != 'M' || buffer[1] != 'Z')) IntegrityFailure();
    total += read;
    if (total > size) IntegrityFailure();
    hash.Add(buffer.data(), read);
  }
  if (total != size || hash.Finish() != expected) IntegrityFailure();
}

void SafeDirectory(const fs::path& directory) {
  fs::create_directories(directory);
  // Reject a redirected cache before writing executable content.
  auto current = directory;
  while (!current.empty() && current != current.root_path()) {
    const auto attributes = GetFileAttributesW(current.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) FileFailure();
    current = current.parent_path();
  }
}

void PruneInstalledCache(const fs::path& directory, const std::string& currentVersion) {
  if (!fs::exists(directory)) return;
  SafeDirectory(directory);
  for (const auto& item : fs::directory_iterator(directory)) {
    if (!fs::is_regular_file(item.symlink_status())) continue;
    const auto name = item.path().filename().string();
    if (!name.starts_with("PWTools-Setup-")) continue;
    const auto separator = name.find('-', 14);
    const auto suffix = name.ends_with(".exe.part") ? 9u : name.ends_with(".exe") ? 4u : 0u;
    if (!suffix || separator == std::string::npos || name.size() != separator + 1 + 16 + suffix) continue;
    const auto hash = name.substr(separator + 1, 16);
    if (hash.find_first_not_of("0123456789abcdef") != std::string::npos) continue;
    try {
      if (!IsNewerVersion(name.substr(14, separator - 14), currentVersion) || suffix == 9) {
        std::error_code ignored; fs::remove(item.path(), ignored);
      }
    } catch (const ApiFailure&) { /* Preserve unrecognized files. */ }
  }
}

struct Endpoint {
  std::wstring host, prefix;
  INTERNET_PORT port;
  bool secure;
  explicit Endpoint(const std::string& api) {
    const auto url = Wide(api);
    URL_COMPONENTS parts{sizeof(parts)};
    parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwUserNameLength = parts.dwPasswordLength = parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts) || !parts.dwHostNameLength || parts.dwUserNameLength || parts.dwPasswordLength || parts.dwExtraInfoLength) InvalidManifest();
    host.assign(parts.lpszHostName, parts.dwHostNameLength);
    port = parts.nPort;
    secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
    if (!secure && !(parts.nScheme == INTERNET_SCHEME_HTTP && (host == L"127.0.0.1" || host == L"localhost" || host == L"[::1]"))) InvalidManifest();
    prefix.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
    while (!prefix.empty() && prefix.back() == L'/') prefix.pop_back();
    prefix += L"/updates/windows-x64/";
  }
};

template <class Consume>
void Download(const Endpoint& endpoint, const std::wstring& name, uint64_t limit, const std::atomic<bool>& stopped, Consume consume) {
  Internet session(WinHttpOpen(L"PWTools-Updater", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
  if (!WinHttpSetTimeouts(session.value, 10000, 10000, 15000, 15000)) NetworkFailure();
  Internet connection(WinHttpConnect(session.value, endpoint.host.c_str(), endpoint.port, 0));
  Internet request(WinHttpOpenRequest(connection.value, L"GET", (endpoint.prefix + name).c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, endpoint.secure ? WINHTTP_FLAG_SECURE : 0));
  DWORD disable = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
  if (!WinHttpSetOption(request.value, WINHTTP_OPTION_DISABLE_FEATURE, &disable, sizeof(disable))) NetworkFailure();
  if (!WinHttpSendRequest(request.value, L"Cache-Control: no-cache\r\n", static_cast<DWORD>(-1), nullptr, 0, 0, 0) || !WinHttpReceiveResponse(request.value, nullptr)) NetworkFailure();
  DWORD status = 0, length = sizeof(status);
  if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &status, &length, nullptr) || status != 200) NetworkFailure();
  std::array<unsigned char, 64 * 1024> buffer{};
  uint64_t total = 0;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(5);
  for (;;) {
    if (stopped || std::chrono::steady_clock::now() > deadline) NetworkFailure();
    DWORD read = 0;
    if (!WinHttpReadData(request.value, buffer.data(), static_cast<DWORD>(buffer.size()), &read)) NetworkFailure();
    if (!read) break;
    total += read;
    if (total > limit) IntegrityFailure();
    consume(buffer.data(), read);
  }
}

void VerifyInstallerVersion(const fs::path& installer, const std::string& version) {
  DWORD unused = 0;
  const DWORD length = GetFileVersionInfoSizeW(installer.c_str(), &unused);
  if (!length || length > 1024 * 1024) IntegrityFailure();
  std::vector<unsigned char> info(length);
  if (!GetFileVersionInfoW(installer.c_str(), 0, length, info.data())) IntegrityFailure();
  VS_FIXEDFILEINFO* fixed = nullptr;
  UINT size = 0;
  if (!VerQueryValueW(info.data(), L"\\", reinterpret_cast<void**>(&fixed), &size) || size < sizeof(VS_FIXEDFILEINFO)) IntegrityFailure();
  const auto expected = Version(version);
  if (fixed->dwSignature != 0xfeef04bd || HIWORD(fixed->dwFileVersionMS) != expected[0] || LOWORD(fixed->dwFileVersionMS) != expected[1] || HIWORD(fixed->dwFileVersionLS) != expected[2] || LOWORD(fixed->dwFileVersionLS) != 0) IntegrityFailure();
}
} // namespace

bool IsNewerVersion(const std::string& candidate, const std::string& current) { return Version(candidate) > Version(current); }

nlohmann::json ValidateUpdateManifest(const nlohmann::json& value) {
  if (!value.is_object() || value.value("schema_version", 0) != 1 || value.value("platform", "") != "windows-x64" ||
      !value.contains("version") || !value["version"].is_string() || !value.contains("size") || !value["size"].is_number_unsigned() ||
      !value.contains("sha256") || !value["sha256"].is_string() || !value.contains("notes") || !value["notes"].is_string() ||
      !value.contains("published_at") || !value["published_at"].is_string()) InvalidManifest();
  Version(value["version"].get<std::string>());
  const auto size = value["size"].get<uint64_t>();
  const auto sha = value["sha256"].get<std::string>();
  if (size < 2 || size > MaxInstallerBytes || sha.size() != 64 || sha.find_first_not_of("0123456789abcdef") != std::string::npos ||
      value["notes"].get_ref<const std::string&>().size() > 6000 || value["published_at"].get_ref<const std::string&>().size() > 40) InvalidManifest();
  return value;
}

struct Updater::Impl : std::enable_shared_from_this<Impl> {
  std::string api, current;
  fs::path cache, install, installer;
  mutable std::mutex mutex;
  std::atomic<bool> stopped{false};
  bool busy = false;
  json manifest;
  json state;
  Impl(std::string url, std::string version, fs::path data, fs::path destination)
      : api(std::move(url)), current(std::move(version)), cache(std::move(data) / L"Updates"), install(std::move(destination)),
        state{{"phase", "idle"}, {"currentVersion", current}, {"latestVersion", nullptr}, {"downloadedBytes", 0}, {"totalBytes", 0}, {"notes", ""}, {"publishedAt", ""}, {"error", ""}} {}

  void Run(bool downloadApproved) {
    fs::path partial;
    try {
      const Endpoint endpoint(api);
      json release;
      if (!downloadApproved) {
        std::string body;
        Download(endpoint, L"latest.json", MaxManifestBytes, stopped, [&body](const unsigned char* bytes, DWORD count) { body.append(reinterpret_cast<const char*>(bytes), count); });
        release = ValidateUpdateManifest(json::parse(body));
        PruneInstalledCache(cache, current);
        std::lock_guard lock(mutex);
        manifest = release;
        state["latestVersion"] = release["version"];
        state["notes"] = release["notes"];
        state["publishedAt"] = release["published_at"];
        state["totalBytes"] = release["size"];
        state["phase"] = IsNewerVersion(release["version"].get<std::string>(), current) ? "available" : "up-to-date";
        busy = false;
        return; // A check never requests installer bytes; the user chooses first.
      }
      {
        std::lock_guard lock(mutex);
        release = manifest; // Download exactly the release the user was offered.
      }
      const auto version = release["version"].get<std::string>();
      const auto size = release["size"].get<uint64_t>();
      const auto hash = release["sha256"].get<std::string>();
      SafeDirectory(cache);
      const auto name = "PWTools-Setup-" + version + ".exe";
      const auto destination = cache / Wide("PWTools-Setup-" + version + "-" + hash.substr(0, 16) + ".exe");
      bool cached = false;
      if (fs::exists(destination)) {
        try {
          Handle file(CreateFileW(destination.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
          Verify(file.value, size, hash); VerifyInstallerVersion(destination, version); cached = true;
        } catch (...) { if (fs::is_symlink(fs::symlink_status(destination))) FileFailure(); fs::remove(destination); }
      }
      if (!cached) {
        partial = destination; partial += L".part";
        {
          Handle file(CreateFileW(partial.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
          RegularHandle(file.value, 0);
          uint64_t received = 0;
          Download(endpoint, Wide(name), size, stopped, [&](const unsigned char* bytes, DWORD count) {
            DWORD written = 0;
            if (!WriteFile(file.value, bytes, count, &written, nullptr) || written != count) FileFailure();
            received += count;
            std::lock_guard lock(mutex); state["downloadedBytes"] = received;
          });
          if (!FlushFileBuffers(file.value)) FileFailure();
        }
        {
          // Version APIs open their own read handle. Close the writer first so
          // their share mode cannot conflict with a writable download handle.
          Handle file(CreateFileW(partial.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
          Verify(file.value, size, hash);
          VerifyInstallerVersion(partial, version);
        }
        if (!MoveFileExW(partial.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) FileFailure();
        partial.clear();
      }
      std::lock_guard lock(mutex);
      manifest = release; installer = destination;
      state["downloadedBytes"] = size; state["phase"] = "ready"; busy = false;
    } catch (const ApiFailure& error) {
      if (!partial.empty()) { std::error_code ignored; fs::remove(partial, ignored); }
      std::lock_guard lock(mutex); state["phase"] = downloadApproved ? "download-error" : "error"; state["error"] = error.what(); busy = false;
    } catch (...) {
      if (!partial.empty()) { std::error_code ignored; fs::remove(partial, ignored); }
      std::lock_guard lock(mutex); state["phase"] = downloadApproved ? "download-error" : "error"; state["error"] = downloadApproved ? "更新下载未完成，请稍后重试。" : "更新检查未完成，请稍后重试。"; busy = false;
    }
  }
};

Updater::Updater(std::string api, std::string version, fs::path data, fs::path destination)
    : impl_(std::make_shared<Impl>(std::move(api), std::move(version), std::move(data), std::move(destination))) {}
Updater::~Updater() { impl_->stopped = true; }
nlohmann::json Updater::State() const { std::lock_guard lock(impl_->mutex); return impl_->state; }
void Updater::Check() {
  std::lock_guard lock(impl_->mutex);
  if (impl_->busy || impl_->stopped) return;
  impl_->busy = true; impl_->state["phase"] = "checking"; impl_->state["error"] = ""; impl_->state["downloadedBytes"] = 0;
  impl_->manifest = nullptr; impl_->installer.clear();
  impl_->state["latestVersion"] = nullptr; impl_->state["notes"] = ""; impl_->state["totalBytes"] = 0;
  try { std::thread([module = impl_] { module->Run(false); }).detach(); }
  catch (...) { impl_->busy = false; impl_->state["phase"] = "error"; impl_->state["error"] = "更新检查未能启动，请稍后重试。"; }
}
void Updater::DownloadUpdate() {
  std::lock_guard lock(impl_->mutex);
  if (impl_->busy || impl_->stopped || impl_->state["phase"] == "ready") return;
  if ((impl_->state["phase"] != "available" && impl_->state["phase"] != "download-error") ||
      !impl_->manifest.is_object() || !IsNewerVersion(impl_->manifest["version"].get<std::string>(), impl_->current)) {
    throw ApiFailure("UPDATE_NOT_AVAILABLE", "请先检查是否有可用的新版本。");
  }
  impl_->busy = true; impl_->state["phase"] = "downloading"; impl_->state["error"] = ""; impl_->state["downloadedBytes"] = 0;
  try { std::thread([module = impl_] { module->Run(true); }).detach(); }
  catch (...) { impl_->busy = false; impl_->state["phase"] = "download-error"; impl_->state["error"] = "更新下载未能启动，请稍后重试。"; }
}
void Updater::Install() {
  std::lock_guard lock(impl_->mutex);
  if (impl_->busy || impl_->state["phase"] != "ready" || impl_->installer.empty()) throw ApiFailure("UPDATE_NOT_READY", "更新尚未准备好，请先完成下载。");
  try {
    SafeDirectory(impl_->cache);
    Handle file(CreateFileW(impl_->installer.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Verify(file.value, impl_->manifest["size"].get<uint64_t>(), impl_->manifest["sha256"].get<std::string>());
    VerifyInstallerVersion(impl_->installer, impl_->manifest["version"].get<std::string>());
    // /D must be last and unquoted in NSIS. It comes from GetModuleFileName,
    // never from manifest/renderer input; the installer waits for this PID.
    if (impl_->install.wstring().find_first_of(L"\r\n\"") != std::wstring::npos) FileFailure();
    auto command = L"\"" + impl_->installer.wstring() + L"\" /UPDATEPID=" + std::to_wstring(GetCurrentProcessId()) + L" /D=" + impl_->install.wstring();
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(impl_->installer.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, impl_->cache.c_str(), &startup, &child)) throw ApiFailure("UPDATE_INSTALL", "无法启动更新安装程序，请稍后重试。");
    CloseHandle(child.hThread); CloseHandle(child.hProcess);
    impl_->busy = true; impl_->state["phase"] = "installing";
  } catch (const ApiFailure& failure) {
    impl_->state["phase"] = "download-error"; impl_->state["error"] = failure.what(); throw;
  }
}
} // namespace pwtools
