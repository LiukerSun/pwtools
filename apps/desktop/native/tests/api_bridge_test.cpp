#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include "api_bridge.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <future>
#include <iostream>
#include <iterator>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ws2_32.lib")

namespace {
using Json = nlohmann::json;
using pwtools::ApiBridge;
using pwtools::ApiFailure;
const std::string id = "00000000-0000-4000-8000-000000000001";
const std::string other_id = "00000000-0000-4000-8000-000000000002";

void Check(bool result, const char* message) { if (!result) throw std::runtime_error(message); }
template<class Action> void Reject(Action action, const char* code) {
  try { action(); }
  catch (const ApiFailure& failure) { Check(failure.code == code, "unexpected API error code"); return; }
  throw std::runtime_error("operation should have failed");
}
struct Request { std::string method, path, body; std::map<std::string, std::string> headers; };

class Fixture {
public:
  Fixture() {
    WSADATA data{}; Check(WSAStartup(MAKEWORD(2, 2), &data) == 0, "Winsock initialization failed");
    listener_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP); Check(listener_ != INVALID_SOCKET, "fixture socket failed");
    sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    Check(bind(listener_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0, "fixture bind failed");
    int size = sizeof(address); Check(getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &size) == 0, "fixture address failed");
    url_ = "http://127.0.0.1:" + std::to_string(ntohs(address.sin_port)) + "/api";
    Check(listen(listener_, 16) == 0, "fixture listen failed");
    accept_ = std::thread([this] {
      while (!stopped_.load()) {
        const auto client = accept(listener_, nullptr, nullptr);
        if (client == INVALID_SOCKET) break;
        workers_.emplace_back([this, client] {
          try { Handle(client); } catch (...) { failures_.fetch_add(1); }
          shutdown(client, SD_BOTH); closesocket(client);
        });
      }
    });
  }
  ~Fixture() {
    stopped_.store(true); ReleaseMe();
    shutdown(listener_, SD_BOTH); closesocket(listener_);
    if (accept_.joinable()) accept_.join();
    for (auto& worker : workers_) if (worker.joinable()) worker.join();
    WSACleanup();
  }
  const std::string& Url() const { return url_; }
  Request Last() { std::lock_guard lock(mutex_); return last_; }
  Request Upload() { std::lock_guard lock(mutex_); return upload_; }
  unsigned LocalWrites() const { return local_writes_.load(); }
  void CompletedDuplicateNext() { duplicate_.store(true); }
  void RejectLocalNext() { reject_local_.store(true); }
  int Failures() const { return failures_.load(); }
  void HoldMe() { std::lock_guard lock(mutex_); hold_me_ = true; held_ = released_ = false; }
  void WaitForHeldMe() {
    std::unique_lock lock(mutex_);
    Check(changed_.wait_for(lock, std::chrono::seconds(10), [&] { return held_; }), "fixture did not receive delayed request");
  }
  void ReleaseMe() { std::lock_guard lock(mutex_); released_ = true; changed_.notify_all(); }
  void RedirectNext() { redirect_.store(true); }
  void ErrorNext() { error_.store(true); }
private:
  SOCKET listener_ = INVALID_SOCKET;
  std::string url_, current_token_, current_email_;
  std::atomic<bool> stopped_{false}, redirect_{false}, error_{false};
  std::atomic<int> failures_{0};
  std::atomic<unsigned> local_writes_{0};
  std::atomic<bool> duplicate_{false}, reject_local_{false};
  std::thread accept_; std::vector<std::thread> workers_;
  std::mutex mutex_; std::condition_variable changed_; Request last_, upload_;
  bool hold_me_ = false, held_ = false, released_ = false;
  unsigned login_number_ = 0;

  static void Send(SOCKET client, int status, std::string body, const std::string& type = "application/json", const std::string& extra = "") {
    std::string response = "HTTP/1.1 " + std::to_string(status) + " Fixture\r\nContent-Type: " + type + "\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n" + extra + "\r\n" + body;
    std::size_t sent = 0;
    while (sent < response.size()) {
      const auto count = send(client, response.data() + sent, static_cast<int>(response.size() - sent), 0);
      Check(count > 0, "fixture send failed"); sent += static_cast<std::size_t>(count);
    }
  }
  static Request Read(SOCKET client) {
    DWORD timeout = 10000; setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
    std::string bytes; char buffer[4096];
    auto append = [&] { const auto count = recv(client, buffer, sizeof(buffer), 0); Check(count > 0, "fixture request ended early"); bytes.append(buffer, static_cast<std::size_t>(count)); Check(bytes.size() < 20 * 1024 * 1024, "fixture request too large"); };
    while (bytes.find("\r\n\r\n") == std::string::npos) append();
    const auto end = bytes.find("\r\n\r\n"), first = bytes.find("\r\n");
    const auto split = bytes.find(' '), path_end = bytes.find(' ', split + 1);
    Request request; request.method = bytes.substr(0, split); request.path = bytes.substr(split + 1, path_end - split - 1);
    for (auto start = first + 2; start < end;) {
      const auto stop = bytes.find("\r\n", start), colon = bytes.find(':', start);
      Check(colon < stop, "fixture header invalid");
      auto key = bytes.substr(start, colon - start);
      for (auto& c : key) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + 32);
      auto value_start = colon + 1; while (value_start < stop && bytes[value_start] == ' ') ++value_start;
      request.headers[key] = bytes.substr(value_start, stop - value_start); start = stop + 2;
    }
    const auto length = request.headers.contains("content-length") ? std::stoull(request.headers.at("content-length")) : 0;
    while (bytes.size() - end - 4 < length) append();
    request.body = bytes.substr(end + 4, static_cast<std::size_t>(length)); return request;
  }
  void Handle(SOCKET client) {
    auto request = Read(client);
    { std::lock_guard lock(mutex_); last_ = request; last_.headers.erase("authorization"); }
    if (redirect_.exchange(false)) { Send(client, 302, "", "application/json", "Location: " + url_ + "/health\r\n"); return; }
    if (error_.exchange(false)) { Send(client, 403, Json{{"error", {{"code", "FORBIDDEN"}, {"message", "无权执行此操作。"}}}}.dump()); return; }
    if (request.path == "/api/auth/login" || request.path == "/api/auth/register") {
      const auto body = Json::parse(request.body);
      Json response;
      {
        std::lock_guard lock(mutex_); current_email_ = body.at("email").get<std::string>();
        current_token_ = "native-test-session-" + std::to_string(++login_number_);
        response = {{"token", current_token_}, {"user", {{"id", id}, {"email", current_email_}, {"created_at", "2026-10-04T00:00:00Z"}}}};
      }
      Send(client, 200, response.dump()); return;
    }
    if (request.path == "/api/me") {
      std::unique_lock lock(mutex_);
      if (hold_me_) {
        hold_me_ = false; held_ = true; changed_.notify_all();
        changed_.wait(lock, [&] { return released_; }); lock.unlock();
        Send(client, 401, Json{{"error", {{"code", "UNAUTHORIZED"}, {"message", "登录已过期。"}}}}.dump()); return;
      }
      const bool authorized = !current_token_.empty() && request.headers["authorization"] == "Bearer " + current_token_;
      const auto email = current_email_; lock.unlock();
      if (!authorized) Send(client, 401, Json{{"error", {{"code", "UNAUTHORIZED"}, {"message", "请登录。"}}}}.dump());
      else Send(client, 200, Json{{"id", id}, {"email", email}, {"created_at", "2026-10-04T00:00:00Z"}}.dump());
      return;
    }
    if (request.path == "/api/auth/logout") {
      { std::lock_guard lock(mutex_); current_token_.clear(); }
      Send(client, 204, ""); return;
    }
    if (request.path.ends_with("/thumbnail")) { Send(client, 200, std::string("\4\5\6", 3), "image/webp"); return; }
    if (request.path.ends_with("/image")) { Send(client, 200, std::string("\1\2\3", 3), "image/png"); return; }
    if (request.path == "/api/matches/preview-local") {
      { std::lock_guard lock(mutex_); upload_ = request; }
      const auto duplicate = duplicate_.exchange(false);
      const auto preview = Json::parse(request.body);
      Check(preview.at("data_base64") == "AQID" && preview.at("order_id") == id, "preview original changed");
      Send(client, duplicate ? 200 : 201, Json{{"duplicate", duplicate}, {"record", {
        {"id", id}, {"ocr_status", duplicate || !preview.at("recognition").is_null() ? "completed" : "failed"}, {"amount", nullptr}, {"warnings", Json::array()}
      }}}.dump()); return;
    }
    if (request.path.ends_with("/local-recognition")) {
      ++local_writes_;
      if (reject_local_.exchange(false)) {
        Send(client, 503, Json{{"error", {{"code", "UNAVAILABLE"}, {"message", "保存暂时不可用"}}}}.dump()); return;
      }
      const auto payload = Json::parse(request.body);
      Check(payload.at("image_sha256") == "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", "local result is not bound to original bytes");
      const auto failed = payload.at("recognition").is_null();
      Send(client, 200, Json{{"id", id}, {"ocr_status", failed ? "failed" : "completed"},
                            {"warnings", Json::array()}, {"amount", nullptr}}.dump()); return;
    }
    Check(!request.path.ends_with("/recognize"), "desktop must not invoke server OCR");
    if (request.method == "DELETE") { Send(client, 204, ""); return; }
    Send(client, 200, Json{{"method", request.method}, {"path", request.path}}.dump());
  }
};

void Run(const std::filesystem::path& directory) {
  Fixture fixture;
  bool fail_local = false;
  bool expire_attributes = false;
  unsigned local_calls=0;
  ApiBridge* active_bridge = nullptr;
  ApiBridge bridge(fixture.Url() + "/", directory, [&](const std::vector<unsigned char>& bytes, const std::string& mime) {
    ++local_calls;
    Check(bytes == std::vector<unsigned char>({1, 2, 3}) && mime == "image/png", "local OCR image bytes changed");
    if (fail_local) throw ApiFailure("LOCAL_OCR_UNAVAILABLE", "fixture model unavailable");
    return Json{{"outcome", "unknown"}, {"players", Json::array()}, {"raw_text", "本地识别"}, {"warnings", Json::array()}};
  }, [&](const std::vector<unsigned char>& bytes, const std::string& mime) {
    Check(bytes == std::vector<unsigned char>({1, 2, 3}) && mime == "image/png", "attribute OCR image bytes changed");
    if (expire_attributes) active_bridge->Execute("logout", Json::array());
    return Json{{"status", "completed"}, {"values", Json{{"damage", 39}}}};
  }, [&](const std::vector<unsigned char>&, const std::string&) {
    if (expire_attributes) active_bridge->Execute("logout", Json::array());
    return Json{{"kind","match"},{"attributes",Json::object()},{"match",Json{{"outcome","unknown"},{"players",Json::array()},{"raw_text","cached"},{"warnings",Json::array()}}}};
  });
  active_bridge = &bridge;
  Check(bridge.ApiUrl() == fixture.Url(), "API URL normalization failed");
  Check(bridge.PersistentSession(), "DPAPI availability check failed");
  for (const auto url : {"http://example.com/api", "https://name:password@example.com/api", "https://example.com/api?x=1", "https://example.com/api#fragment", "file:///api"}) Reject([&] { ApiBridge rejected(url, directory); }, "INVALID_CONFIG");
  Reject([&] { bridge.Execute("me", Json::array()); }, "UNAUTHORIZED");
  const Json credentials = {{"email", "native-a@example.test"}, {"password", "native-test-password"}};
  Check(bridge.Execute("login", Json::array({credentials}))["email"] == credentials["email"], "login did not return user");
  const Json attribute_image{{"name", "panel.png"}, {"content_type", "image/png"}, {"data_base64", "AQID"}};
  Check(bridge.Execute("recognizeBuildCodeAttributes", Json::array({attribute_image}))["values"]["damage"] == 39, "attribute OCR result changed");
  Check(fixture.Last().method == "GET" && fixture.Last().path == "/api/me" && fixture.Last().body.empty(), "native attribute recognition uploaded an image");
  auto invalid_attribute_image = attribute_image;
  invalid_attribute_image["content_type"] = "image/svg+xml";
  Reject([&] { bridge.Execute("recognizeBuildCodeAttributes", Json::array({invalid_attribute_image})); }, "INVALID_IMAGE");
  invalid_attribute_image = attribute_image; invalid_attribute_image["data_base64"] = "AR==";
  Reject([&] { bridge.Execute("recognizeBuildCodeAttributes", Json::array({invalid_attribute_image})); }, "INVALID_IMAGE");
  {
    ApiBridge restored(fixture.Url(), directory);
    Check(restored.Execute("me", Json::array())["email"] == credentials["email"], "encrypted session did not restore");
    ApiBridge isolated(fixture.Url() + "/different", directory);
    Reject([&] { isolated.Execute("me", Json::array()); }, "UNAUTHORIZED");
  }
  for (const auto& file : std::filesystem::directory_iterator(directory)) {
    if (!file.is_regular_file()) continue;
    std::ifstream input(file.path(), std::ios::binary);
    const std::string bytes((std::istreambuf_iterator<char>(input)), {});
    Check(bytes.find("native-test-session-") == std::string::npos, "session file contains plaintext");
  }

  fixture.HoldMe();
  auto expired = std::async(std::launch::async, [&] { Reject([&] { bridge.Execute("me", Json::array()); }, "UNAUTHORIZED"); });
  const Json later = {{"email", "native-b@example.test"}, {"password", "native-test-password"}};
  try {
    fixture.WaitForHeldMe();
    bridge.Execute("login", Json::array({later}));
  } catch (...) {
    fixture.ReleaseMe();
    throw;
  }
  fixture.ReleaseMe(); expired.get();
  Check(bridge.Execute("me", Json::array())["email"] == later["email"], "old 401 removed a newer login");
  ApiBridge restored(fixture.Url(), directory);
  Check(restored.Execute("me", Json::array())["email"] == later["email"], "new login was not persisted");

  const Json boss = {{"display_name", "测试老板"}, {"game_id", "boss-001"}, {"game_name", "小桃知晚"}, {"notes", "长期备注"}};
  const Json order = {{"title", "护航单"}, {"kind", "escort"}, {"target_quantity", 1000000}, {"failure_default_quantity", 0}, {"note", ""}};
  Json order_template = order; order_template["name"] = "模板";
  const Json match = {{"player_name", "小桃知晚"}, {"outcome", "success"}, {"amount", 1000000}, {"fake_amount", 0}, {"confirmed", true}, {"played_at", nullptr}, {"note", ""}};
  const Json entry = {{"kind", "progress"}, {"quantity", 75}, {"occurred_at", nullptr}, {"note", ""}, {"idempotency_key", other_id}};
  struct Case { const char* method; Json args; std::string verb, path; };
  const std::vector<Case> cases = {
    {"listBuildCodes", Json::array(), "GET", "/api/weapon-build-codes"},
    {"createBuildCode", Json::array({Json{{"code", "ABCDEFGH"}, {"weapon_name", "M7"}, {"mode", "烽火地带"}, {"note", ""}}}), "POST", "/api/weapon-build-codes"},
    {"lookupBuildCode", Json::array({Json{{"code", "ABCDEFGH"}, {"weapon_name", "M7"}, {"mode", "烽火地带"}, {"note", ""}}}), "POST", "/api/weapon-build-codes/lookup"},
    {"updateBuildCode", Json::array({id, Json{{"code", "ABCDEFGH"}, {"weapon_name", "M7"}, {"mode", "烽火地带"}, {"note", ""}}}), "PATCH", "/api/weapon-build-codes/" + id},
    {"deleteBuildCode", Json::array({id}), "DELETE", "/api/weapon-build-codes/" + id},
    {"listRentalAccounts", Json::array(), "GET", "/api/rental-accounts"},
    {"createRentalAccount", Json::array({Json{{"id", id}, {"name", "测试租号"}, {"note", ""}}}), "POST", "/api/rental-accounts"},
    {"listRentalSessions", Json::array(), "GET", "/api/rental-sessions"},
    {"createRentalSession", Json::array({Json{{"id", id}, {"account_id", other_id}, {"coin_per_yuan", 500000}, {"aw_price", 100000}, {"helmet_price", 200000}, {"armor_price", 300000}, {"initial_coins", 10000000}, {"deposit_cents", 20000}, {"started_at", "2026-10-06T00:00:00Z"}, {"note", ""}}}), "POST", "/api/rental-sessions"},
    {"returnRentalSession", Json::array({id, Json{{"final_cost_cents", 13500}}}), "PATCH", "/api/rental-sessions/" + id + "/return"},
    {"rentalAnalysis", Json::array({id}), "GET", "/api/rental-sessions/" + id + "/analysis"},
    {"health", Json::array(), "GET", "/api/health"},
    {"listMatches", Json::array({nullptr, nullptr, id, false}), "GET", "/api/matches?page=1&page_size=20&order_id=" + id + "&confirmed=false"},
    {"listMatches", Json::array({nullptr, nullptr, nullptr, nullptr}), "GET", "/api/matches?page=1&page_size=20"},
    {"matchStats", Json::array({id}), "GET", "/api/matches/stats?order_id=" + id},
    {"matchSettings", Json::array(), "GET", "/api/matches/settings"},
    {"updateMatchSettings", Json::array({Json{{"boss_id", "legacy-game-id"}, {"boss_player_name", "小桃知晚"}}}), "PATCH", "/api/matches/settings"},
    {"getMatch", Json::array({id}), "GET", "/api/matches/" + id},
    {"updateMatch", Json::array({id, match}), "PATCH", "/api/matches/" + id},
    {"recognizeMatch", Json::array({id}), "POST", "/api/matches/" + id + "/local-recognition"},
    {"deleteMatch", Json::array({id}), "DELETE", "/api/matches/" + id},
    {"listBosses", Json::array({"老板"}), "GET", "/api/bosses?q=%E8%80%81%E6%9D%BF"},
    {"getBoss", Json::array({id}), "GET", "/api/bosses/" + id},
    {"createBoss", Json::array({boss}), "POST", "/api/bosses"},
    {"updateBoss", Json::array({id, boss}), "PATCH", "/api/bosses/" + id},
    {"listOrders", Json::array({id}), "GET", "/api/orders?boss_id=" + id},
    {"getOrder", Json::array({id}), "GET", "/api/orders/" + id},
    {"createOrder", Json::array({id, order}), "POST", "/api/bosses/" + id + "/orders"},
    {"updateOrder", Json::array({id, order}), "PATCH", "/api/orders/" + id},
    {"archiveOrder", Json::array({id, Json{{"id", other_id}, {"mode", "refund"}, {"final_income_cents", 12345}, {"note", "提前结束"}, {"expected_updated_at", "2026-10-06T00:00:00Z"}}}), "POST", "/api/orders/" + id + "/archive"},
    {"restoreOrder", Json::array({id, Json{{"settlement_id", other_id}}}), "POST", "/api/orders/" + id + "/restore"},
    {"transferOrder", Json::array({id, Json{{"id", other_id}, {"prepaid", false}, {"progress_bps", nullptr}, {"note", "转出"}, {"expected_updated_at", "2026-10-07T00:00:00Z"}}}), "POST", "/api/orders/" + id + "/transfer"},
    {"transferOrder", Json::array({id, Json{{"id", other_id}, {"prepaid", true}, {"progress_bps", 5000}, {"note", "协商进度"}, {"expected_updated_at", "2026-10-07T00:00:00Z"}}}), "POST", "/api/orders/" + id + "/transfer"},
    {"transferOrderAction", Json::array({id, Json{{"id", other_id}, {"transfer_id", id}, {"action", "settle"}, {"amount_cents", 19960}, {"note", ""}, {"expected_updated_at", "2026-10-07T00:00:00Z"}}}), "POST", "/api/orders/" + id + "/transfer-action"},
    {"transferOrderAction", Json::array({id, Json{{"id", other_id}, {"transfer_id", id}, {"action", "refund"}, {"mode", "waiver"}, {"final_income_cents", 0}, {"note", "免单"}, {"expected_updated_at", "2026-10-07T00:00:00Z"}}}), "POST", "/api/orders/" + id + "/transfer-action"},
    {"transferOrderAction", Json::array({id, Json{{"id", other_id}, {"transfer_id", id}, {"action", "confirm_refund"}, {"note", "已退回"}, {"expected_updated_at", "2026-10-07T00:00:00Z"}}}), "POST", "/api/orders/" + id + "/transfer-action"},
    {"transferOrderAction", Json::array({id, Json{{"id", other_id}, {"transfer_id", id}, {"action", "cancel"}, {"note", "撤销转出"}, {"expected_updated_at", "2026-10-07T00:00:00Z"}}}), "POST", "/api/orders/" + id + "/transfer-action"},
    {"confirmMatch", Json::array({Json{{"name", "截图.png"}, {"content_type", "image/png"}, {"data_base64", "AQID"}, {"order_id", id}, {"input", match}, {"recognition", nullptr}}}), "POST", "/api/matches/confirm"},
    {"listOrderTemplates", Json::array(), "GET", "/api/order-templates"},
    {"createOrderTemplate", Json::array({order_template}), "POST", "/api/order-templates"},
    {"updateOrderTemplate", Json::array({id, order_template}), "PATCH", "/api/order-templates/" + id},
    {"deleteOrderTemplate", Json::array({id}), "DELETE", "/api/order-templates/" + id},
    {"listLedgerEntries", Json::array({id}), "GET", "/api/orders/" + id + "/entries?page=1&page_size=20"},
    {"addLedgerEntry", Json::array({id, entry}), "POST", "/api/orders/" + id + "/entries"},
    {"deleteLedgerEntry", Json::array({id, other_id}), "DELETE", "/api/orders/" + id + "/entries/" + other_id},
  };
  for (const auto& item : cases) {
    bridge.Execute(item.method, item.args);
    const auto request = fixture.Last(); Check(request.method == item.verb && request.path == item.path, "HTTP method or route mapping mismatch");
  }
  // Confirm the screenshot payload at the real native boundary, not just a tiny RPC fixture.
  Json screenshot_confirmation{{"name", "战绩.png"}, {"content_type", "image/png"},
    {"data_base64", "AQID"}, {"order_id", id}, {"input", match}, {"recognition", nullptr}};
  screenshot_confirmation["input"]["order_id"] = id;
  for (const std::size_t image_size : {3 * 1024, 96 * 1024, 3 * 1024 * 1024, 12 * 1024 * 1024}) {
    screenshot_confirmation["data_base64"] = std::string(image_size / 3 * 4, 'A');
    bridge.Execute("confirmMatch", Json::array({screenshot_confirmation}));
    Check(fixture.Last().path == "/api/matches/confirm", "screenshot confirmation did not reach the API");
    Check(Json::parse(fixture.Last().body) == screenshot_confirmation, "screenshot confirmation changed image bytes or corrected result");
  }
  screenshot_confirmation["data_base64"].get_ref<std::string&>().append("AAAA");
  Reject([&] { bridge.Execute("confirmMatch", Json::array({screenshot_confirmation})); }, "INVALID_IMAGE");
  screenshot_confirmation["data_base64"] = "AR==";
  Reject([&] { bridge.Execute("confirmMatch", Json::array({screenshot_confirmation})); }, "INVALID_IMAGE");
  Json oversized_order = order;
  oversized_order["extra"] = std::string(128 * 1024, 'x');
  Reject([&] { bridge.Execute("createOrder", Json::array({id, oversized_order})); }, "INVALID_INPUT");
  bridge.Execute("uploadMatch", Json::array({Json{{"name", "截图.png"}, {"content_type", "image/png"}, {"data_base64", "AQID"}, {"order_id", id}}}));
  const auto upload = fixture.Upload();
  Check(upload.path == "/api/matches/preview-local", "desktop must use memory-only preview route");
  const auto preview_payload = Json::parse(upload.body);
  Check(preview_payload.at("data_base64") == "AQID" && preview_payload.at("order_id") == id && preview_payload.at("name") == "截图.png", "preview metadata or bytes changed");
  Check(!preview_payload.at("recognition").is_null(), "local recognition not included in preview");
  const auto image = bridge.Execute("matchImage", Json::array({id}));
  Check(image["content_type"] == "image/png" && image["data_base64"] == "AQID", "image bytes did not roundtrip");
  const auto thumbnail = bridge.Execute("matchThumbnail", Json::array({id}));
  Check(thumbnail["content_type"] == "image/webp" && thumbnail["data_base64"] == "BAUG", "thumbnail must use its own endpoint and bytes");
  const auto upload_args = Json::array({Json{{"name", "截图.png"}, {"content_type", "image/png"}, {"data_base64", "AQID"}, {"order_id", id}}});
  fail_local = true;
  Check(bridge.Execute("uploadMatch", upload_args)["record"]["ocr_status"] == "failed", "model failure must return a temporary preview");
  fail_local = false;
  const auto calls_before=local_calls;
  const auto classification=bridge.Execute("classifyScreenshot",Json::array({attribute_image}));
  Check(classification["kind"]=="match" && !classification.contains("match"),"classification must not expose scoreboard text");
  Check(fixture.Last().path=="/api/me" && fixture.Last().body.empty(),"classification must not upload the image");
  bridge.Execute("uploadMatch",upload_args);
  Check(local_calls==calls_before && Json::parse(fixture.Last().body)["recognition"]["raw_text"]=="cached","classified screenshot must reuse OCR once");
  bridge.Execute("uploadMatch",upload_args);
  Check(local_calls==calls_before+1,"consumed classification result must not leak into subsequent uploads");
  fixture.CompletedDuplicateNext();
  const auto writes = fixture.LocalWrites();
  Check(bridge.Execute("uploadMatch", upload_args)["duplicate"] == true && fixture.LocalWrites() == writes,
        "completed duplicate must retain existing results");
  Check(fixture.LocalWrites() == writes, "preview must never persist local recognition to a match");

  Reject([&] { bridge.Execute("getMatch", Json::array({"../me"})); }, "INVALID_INPUT");
  Reject([&] { bridge.Execute("listMatches", Json::parse("[0,20]")); }, "INVALID_INPUT");
  Reject([&] { bridge.Execute("listMatches", Json::array({1, 101})); }, "INVALID_INPUT");
  Reject([&] { bridge.Execute("listMatches", Json::array({1, 20, nullptr, "false"})); }, "INVALID_INPUT");
  Reject([&] { bridge.Execute("listBosses", Json::array({std::string(201, 'x')})); }, "INVALID_INPUT");
  Reject([&] { bridge.Execute("createBoss", Json::array({Json::array()})); }, "INVALID_INPUT");
  Reject([&] { bridge.Execute("createOrder", Json::array({id, Json{{"title", "x"}}})); }, "INVALID_INPUT");
  Json invalid_transfer{{"id", other_id}, {"prepaid", false}, {"progress_bps", 10001}, {"note", ""}, {"expected_updated_at", "2026-10-07T00:00:00Z"}};
  Reject([&] { bridge.Execute("transferOrder", Json::array({id, invalid_transfer})); }, "INVALID_INPUT");
  invalid_transfer["progress_bps"] = 5000; invalid_transfer["prepaid"] = "false";
  Reject([&] { bridge.Execute("transferOrder", Json::array({id, invalid_transfer})); }, "INVALID_INPUT");
  Json invalid_transfer_action{{"id", other_id}, {"transfer_id", id}, {"action", "settle"}, {"amount_cents", -1}, {"note", ""}, {"expected_updated_at", "2026-10-07T00:00:00Z"}};
  Reject([&] { bridge.Execute("transferOrderAction", Json::array({id, invalid_transfer_action})); }, "INVALID_INPUT");
  invalid_transfer_action["amount_cents"] = 199.60;
  Reject([&] { bridge.Execute("transferOrderAction", Json::array({id, invalid_transfer_action})); }, "INVALID_INPUT");
  Json retired_order = order; retired_order["kind"] = "wager";
  Reject([&] { bridge.Execute("createOrder", Json::array({id, retired_order})); }, "INVALID_INPUT");
  retired_order["name"] = "旧类型模板";
  Reject([&] { bridge.Execute("createOrderTemplate", Json::array({retired_order})); }, "INVALID_INPUT");
  Json retired_entry = entry; retired_entry["kind"] = "item_result";
  Reject([&] { bridge.Execute("addLedgerEntry", Json::array({id, retired_entry})); }, "INVALID_INPUT");
  Reject([&] { bridge.Execute("listCatalog", Json::array()); }, "INVALID_METHOD");
  for (const auto malformed : {"", "A===", "AAAA=", "AR==", "!!!="}) Reject([&] { bridge.Execute("uploadMatch", Json::array({Json{{"name", "x.png"}, {"content_type", "image/png"}, {"data_base64", malformed}}})); }, "INVALID_IMAGE");
  Reject([&] { bridge.Execute("uploadMatch", Json::array({Json{{"name", "x.svg"}, {"content_type", "image/svg+xml"}, {"data_base64", "AQID"}}})); }, "INVALID_IMAGE");
  fixture.RedirectNext(); Reject([&] { bridge.Execute("health", Json::array()); }, "NETWORK_ERROR");
  fixture.ErrorNext(); Reject([&] { bridge.Execute("getOrder", Json::array({id})); }, "FORBIDDEN");
  expire_attributes = true;
  Reject([&] { bridge.Execute("classifyScreenshot", Json::array({attribute_image})); }, "UNAUTHORIZED");
  bridge.Execute("login",Json::array({credentials}));
  Reject([&] { bridge.Execute("recognizeBuildCodeAttributes", Json::array({attribute_image})); }, "UNAUTHORIZED");
  bridge.Execute("logout", Json::array());
  Reject([&] { bridge.Execute("me", Json::array()); }, "UNAUTHORIZED");
  ApiBridge logged_out(fixture.Url(), directory); Reject([&] { logged_out.Execute("me", Json::array()); }, "UNAUTHORIZED");
  Check(fixture.Failures() == 0, "local HTTP fixture failed");
}
} // namespace

int main() {
  const auto root = std::filesystem::temp_directory_path();
  const auto directory = root / ("pwtools-native-api-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64()));
  int result = 0;
  try { Run(directory); std::cout << "API bridge fixtures passed\n"; }
  catch (const ApiFailure& failure) { std::cerr << "API bridge fixture failed: " << failure.code << " " << failure.what() << '\n'; result = 1; }
  catch (const std::exception& failure) { std::cerr << "API bridge fixture failed: " << failure.what() << '\n'; result = 1; }
  // Delete only this test's verified direct child, never a configured user directory.
  if (directory.parent_path().lexically_normal() == root.lexically_normal() && directory.filename().string().starts_with("pwtools-native-api-")) {
    std::error_code error; std::filesystem::remove_all(directory, error);
  }
  return result;
}
