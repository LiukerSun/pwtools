#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include "updater.hpp"
#include "api_bridge.hpp"
#include "config.hpp"
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>

namespace {
namespace fs = std::filesystem;
using json = nlohmann::json;
void Require(bool okay, const char* message) { if (!okay) throw std::runtime_error(message); }
std::string Read(const fs::path& path) { std::ifstream file(path, std::ios::binary); Require(file.good(), "fixture file missing"); return {std::istreambuf_iterator<char>(file), {}}; }
std::string ProbeUrl(const wchar_t* value) { std::string result; for (; *value; ++value) { Require(*value < 128, "probe URL must use ASCII/punycode"); result += static_cast<char>(*value); } return result; }
template <class Action> void Reject(Action action) { try { action(); } catch (const std::exception&) { return; } throw std::runtime_error("invalid update was accepted"); }

json Finished(pwtools::Updater& updater) {
  for (int attempt = 0; attempt < 2400; ++attempt) {
    const auto state = updater.State();
    if (state["phase"] != "checking" && state["phase"] != "downloading" && state["phase"] != "idle") return state;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  throw std::runtime_error("update fixture timed out");
}

void CheckAndDownload(pwtools::Updater& updater) {
  updater.Check(); Require(Finished(updater)["phase"] == "available", "probe did not offer an update");
  updater.DownloadUpdate(); Require(Finished(updater)["phase"] == "ready", "probe download did not become ready");
}

class Fixture {
 public:
  std::atomic<unsigned> manifests{0}, downloads{0};
  Fixture(std::string manifest, const std::string& installer, int status = 200, size_t trim = 0)
      : manifest_(std::move(manifest)), installer_(installer), status_(status), trim_(trim) {
    listener_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    Require(listener_ != INVALID_SOCKET, "socket failed");
    sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    Require(bind(listener_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0, "bind failed");
    int size = sizeof(address); Require(getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &size) == 0, "address failed");
    url = "http://127.0.0.1:" + std::to_string(ntohs(address.sin_port)) + "/api";
    Require(listen(listener_, 4) == 0, "listen failed");
    worker_ = std::thread([this] {
      for (;;) {
        auto client = accept(listener_, nullptr, nullptr);
        if (client == INVALID_SOCKET) return;
        DWORD timeout = 5000;
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
        std::string request;
        char buffer[2048];
        while (request.find("\r\n\r\n") == std::string::npos && request.size() < 8192) {
          int count = recv(client, buffer, sizeof(buffer), 0);
          if (count <= 0) break;
          request.append(buffer, count);
        }
        const bool metadata = request.starts_with("GET /api/updates/windows-x64/latest.json ");
        const bool binary = request.starts_with("GET /api/updates/windows-x64/PWTools-Setup-");
        const int status = metadata ? status_ : binary ? 200 : 404;
        if (metadata) ++manifests;
        else if (binary) ++downloads;
        const std::string& body = metadata ? manifest_ : installer_;
        const auto bytes = body.size() - (metadata ? 0 : trim_);
        const auto header = "HTTP/1.1 " + std::to_string(status) + " Fixture\r\nContent-Length: " + std::to_string(bytes) + "\r\nConnection: close\r\nLocation: http://127.0.0.1:1/not-allowed\r\n\r\n";
        Send(client, header.data(), header.size());
        if (binary) std::this_thread::sleep_for(std::chrono::milliseconds(30));
        Send(client, body.data(), bytes);
        shutdown(client, SD_BOTH); closesocket(client);
      }
    });
  }
  ~Fixture() { shutdown(listener_, SD_BOTH); closesocket(listener_); worker_.join(); }
  std::string url;
 private:
  static void Send(SOCKET client, const char* data, size_t size) {
    while (size) {
      const int sent = send(client, data, static_cast<int>(std::min<size_t>(size, 64 * 1024)), 0);
      if (sent <= 0) return;
      data += sent; size -= sent;
    }
  }
  SOCKET listener_ = INVALID_SOCKET;
  std::thread worker_;
  std::string manifest_;
  const std::string& installer_;
  int status_;
  size_t trim_;
};
} // namespace

int wmain(int argc, wchar_t** argv) {
  fs::path owned;
  WSADATA sockets{};
  try {
    Require(WSAStartup(MAKEWORD(2, 2), &sockets) == 0, "Winsock failed");
    if (argc == 6 && std::wstring(argv[1]) == L"--install-local-probe") {
      const fs::path target = fs::weakly_canonical(argv[4]);
      Require(target.parent_path().filename() == ".artifacts" && target.filename().string().starts_with("native-installer-qa-") && fs::is_regular_file(target / "PWTools.exe"), "probe requires an owned installer QA stage");
      const auto binary = Read(argv[2]);
      Fixture server(Read(argv[3]), binary);
      pwtools::Updater updater(server.url, "0.0.1", fs::path(argv[5]), target);
      CheckAndDownload(updater);
      updater.Install(); std::cout << "Installer handoff started\n";
      return 0;
    }
    if (argc == 5 && std::wstring(argv[1]) == L"--install-probe") {
      const fs::path target = fs::weakly_canonical(argv[3]);
      Require(target.parent_path().filename() == ".artifacts" && target.filename().string().starts_with("native-installer-qa-") && fs::is_regular_file(target / "PWTools.exe"), "probe requires an owned installer QA stage");
      pwtools::Updater updater(ProbeUrl(argv[2]), "0.0.1", fs::path(argv[4]), target);
      CheckAndDownload(updater);
      updater.Install(); std::cout << "Installer handoff started\n";
      return 0; // The installer must wait for this exact process to terminate.
    }
    owned = fs::temp_directory_path() / ("pwtools-updater-test-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64()));
    fs::create_directory(owned);
    if (argc == 3 && std::wstring(argv[1]) == L"--download-probe") {
      pwtools::Updater updater(ProbeUrl(argv[2]), "0.0.1", owned, owned);
      CheckAndDownload(updater); const auto state = updater.State();
      std::cout << state.dump() << '\n'; Require(state["phase"] == "ready", "public download failed");
    } else {
      Require(argc == 3, "pass installer and generated manifest paths");
      const auto binary = Read(argv[1]);
      const auto release = json::parse(Read(argv[2]));
      Require(pwtools::IsNewerVersion("0.9.16", "0.9.9"), "version comparison must be numeric");
      Require(!pwtools::IsNewerVersion("0.9.15", "0.9.16") && !pwtools::IsNewerVersion("1.0.0", "1.0.0"), "downgrade or equal version accepted");
      for (const auto& value : {"1.2", "1.2.3.4", "01.2.3", "1.-1.3", "1.2.3-beta", "65536.0.0", "../1.2.3"}) Reject([&] { pwtools::IsNewerVersion(value, "0.0.1"); });
      for (const auto& value : {json(nullptr), json::object(), json{{"schema_version", "1"}}}) Reject([&] { pwtools::ValidateUpdateManifest(value); });
      auto invalid = release; invalid["size"] = 256ull * 1024 * 1024 + 1; Reject([&] { pwtools::ValidateUpdateManifest(invalid); });
      invalid = release; invalid["sha256"] = "not-a-digest"; Reject([&] { pwtools::ValidateUpdateManifest(invalid); });

      const auto expectError = [&](json manifest, const char* label, int status = 200, size_t trim = 0) {
        Fixture server(manifest.dump(), binary, status, trim);
        pwtools::Updater updater(server.url, "0.0.1", owned / label, owned);
        updater.Check();
        const auto checked = Finished(updater);
        if (checked["phase"] == "available") updater.DownloadUpdate();
        Require(Finished(updater)["phase"] == (checked["phase"] == "available" ? "download-error" : "error"), label);
        Reject([&] { updater.Install(); });
        const auto cache = owned / label / "Updates";
        if (fs::exists(cache)) for (const auto& entry : fs::directory_iterator(cache)) Require(entry.path().extension() != ".part", "failed download was not removed");
      };
      expectError(release, "redirect rejected", 302);
      expectError(release, "server failure rejected", 503);
      invalid = release; invalid["sha256"] = std::string(64, '0'); expectError(invalid, "hash mismatch rejected");
      invalid = release; invalid["size"] = binary.size() - 1; expectError(invalid, "oversized body rejected");
      expectError(release, "truncated download rejected", 200, 1000);
      invalid = release; invalid["version"] = "65535.0.0"; expectError(invalid, "installer version mismatch rejected");

      Fixture server(release.dump(), binary);
      const auto data = owned / "valid";
      {
        pwtools::Updater deferred(server.url, "0.0.1", data, owned);
        Reject([&] { deferred.DownloadUpdate(); });
        deferred.Check(); Require(Finished(deferred)["phase"] == "available", "new version was not offered");
        Require(server.downloads == 0 && !fs::exists(data / "Updates"), "checking downloaded bytes without consent");
        Reject([&] { deferred.Install(); });
        // Closing without approving a download models choosing Not now.
      }
      {
        pwtools::Updater updater(server.url, "0.0.1", data, owned);
        updater.Check(); for (int i = 0; i < 12; ++i) updater.Check();
        Require(Finished(updater)["phase"] == "available", "postponed release was not offered on restart");
        Require(server.manifests == 2 && server.downloads == 0, "restart downloaded without consent or duplicate checks did not coalesce");
        updater.DownloadUpdate(); for (int i = 0; i < 12; ++i) updater.DownloadUpdate();
        const auto first = Finished(updater);
        if (first["phase"] != "ready") throw std::runtime_error("valid package not ready: " + first.dump());
        Require(server.manifests == 2 && server.downloads == 1, "download repeated or changed the offered manifest");
        CheckAndDownload(updater); Require(server.downloads == 1, "verified cache not reused");
        const auto path = data / "Updates" / ("PWTools-Setup-" + release["version"].get<std::string>() + "-" + release["sha256"].get<std::string>().substr(0, 16) + ".exe");
        { std::fstream file(path, std::ios::binary | std::ios::in | std::ios::out); file.put('X'); }
        Reject([&] { updater.Install(); });
        Require(updater.State()["phase"] == "download-error", "tampered cached package could be installed");
        updater.DownloadUpdate(); Require(Finished(updater)["phase"] == "ready" && server.downloads == 2, "tampered package was not re-downloaded");
      }
      { std::ofstream keep(data / "Updates" / "keep.txt"); keep << "unrelated"; }
      {
        pwtools::Updater updater(server.url, release["version"].get<std::string>(), data, owned);
        updater.Check(); Require(Finished(updater)["phase"] == "up-to-date" && server.downloads == 2, "same version should not download");
        Reject([&] { updater.DownloadUpdate(); });
        Require(std::distance(fs::directory_iterator(data / "Updates"), fs::directory_iterator{}) == 1 && fs::exists(data / "Updates" / "keep.txt"), "installed cache cleanup affected unrelated files");
      }
      {
        pwtools::Updater updater("http://example.com/api", "0.0.1", owned / "http", owned);
        updater.Check(); Require(Finished(updater)["phase"] == "error", "non-local plaintext update endpoint accepted");
      }
      std::cout << "Updater fixtures passed: consent before download, restart after deferral, coalescing, versions, manifest validation, redirects, limits, truncation, SHA-256, installer identity, cache reuse, tamper rejection and cleanup (no installer launched).\n";
    }
    Require(fs::weakly_canonical(owned.parent_path()) == fs::weakly_canonical(fs::temp_directory_path()) && owned.filename().string().starts_with("pwtools-updater-test-"), "unsafe cleanup path");
    fs::remove_all(owned); WSACleanup(); return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    if (!owned.empty() && fs::weakly_canonical(owned.parent_path()) == fs::weakly_canonical(fs::temp_directory_path()) && owned.filename().string().starts_with("pwtools-updater-test-")) { std::error_code ignored; fs::remove_all(owned, ignored); }
    WSACleanup(); return 1;
  }
}
