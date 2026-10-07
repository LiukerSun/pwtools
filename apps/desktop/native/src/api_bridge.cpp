#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winhttp.h>
#include <wincrypt.h>
#include <bcrypt.h>
#include "api_bridge.hpp"
#include "local_ocr.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <future>
#include <limits>
#include <mutex>
#include <string_view>
#include <utility>
#include <vector>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "bcrypt.lib")

namespace pwtools {
namespace {
using Json = nlohmann::json;
using Bytes = std::vector<unsigned char>;
constexpr std::size_t kMaxImage = 12 * 1024 * 1024;
constexpr std::size_t kMaxImageJsonRequest = 18 * 1024 * 1024;
constexpr std::size_t kMaxJsonResponse = 32 * 1024 * 1024;
constexpr std::int64_t kMaxQuantity = 9000000000000LL;
constexpr std::int64_t kMaxSafeInteger = 9007199254740991LL;

[[noreturn]] void Invalid(const char* message = "输入参数不正确。") {
  throw ApiFailure("INVALID_INPUT", message);
}
[[noreturn]] void Network(DWORD error) {
  if (error == ERROR_WINHTTP_TIMEOUT) throw ApiFailure("TIMEOUT", "连接超时，请稍后重试。");
  throw ApiFailure("NETWORK_ERROR", "无法连接服务，请检查网络并确认后端已启动。");
}

std::wstring Wide(std::string_view text) {
  if (text.find('\0') != std::string_view::npos || text.size() > static_cast<std::size_t>(INT_MAX)) Invalid();
  if (text.empty()) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (!length) Invalid("文字编码不正确。");
  std::wstring result(static_cast<std::size_t>(length), L'\0');
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), length)) Invalid();
  return result;
}
std::string Utf8(std::wstring_view text) {
  if (text.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (!length) Invalid();
  std::string result(static_cast<std::size_t>(length), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), length, nullptr, nullptr)) Invalid();
  return result;
}
void Erase(std::string& value) noexcept {
  if (!value.empty()) SecureZeroMemory(value.data(), value.size());
  value.clear();
}
std::string Text(const Json& value, std::size_t maximum) {
  if (!value.is_string()) Invalid();
  const auto& result = value.get_ref<const std::string&>();
  if (Wide(result).size() > maximum) Invalid("填写内容超过长度限制。");
  return result;
}
bool Missing(const Json& value) { return value.is_null(); }
const Json& Arg(const Json& args, std::size_t position) {
  static const Json absent;
  return position < args.size() ? args[position] : absent;
}
void Arguments(const Json& args, std::size_t minimum, std::size_t maximum) {
  if (!args.is_array() || args.size() < minimum || args.size() > maximum) Invalid();
}
std::int64_t Integer(const Json& value, std::int64_t minimum, std::int64_t maximum) {
  if (value.is_number_unsigned()) {
    const auto number = value.get<std::uint64_t>();
    if (number > static_cast<std::uint64_t>(maximum) || (minimum > 0 && number < static_cast<std::uint64_t>(minimum))) Invalid("数量超出允许范围。");
    return static_cast<std::int64_t>(number);
  }
  if (!value.is_number_integer()) Invalid("数量需要填写整数。");
  const auto number = value.get<std::int64_t>();
  if (number < minimum || number > maximum) Invalid("数量超出允许范围。");
  return number;
}
std::string Uuid(const Json& value) {
  const auto id = Text(value, 36);
  if (id.size() != 36) Invalid("记录编号不正确。");
  for (std::size_t i = 0; i < id.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') Invalid("记录编号不正确。"); }
    else if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f') || (id[i] >= 'A' && id[i] <= 'F'))) Invalid("记录编号不正确。");
  }
  return id;
}
std::string Encode(std::string_view value) {
  constexpr char hex[] = "0123456789ABCDEF";
  std::string result;
  for (const unsigned char byte : value) {
    if ((byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') || (byte >= '0' && byte <= '9') || byte == '-' || byte == '_' || byte == '.' || byte == '~') result.push_back(static_cast<char>(byte));
    else { result.push_back('%'); result.push_back(hex[byte >> 4]); result.push_back(hex[byte & 15]); }
  }
  return result;
}
std::string OptionalId(const Json& value) {
  if (Missing(value) || (value.is_string() && value.get_ref<const std::string&>().empty())) return {};
  return Uuid(value);
}
std::string Pages(const Json& page, const Json& size, int default_size) {
  const auto first = Missing(page) ? 1 : Integer(page, 1, kMaxSafeInteger);
  const auto count = Missing(size) ? default_size : Integer(size, 1, 100);
  return "page=" + std::to_string(first) + "&page_size=" + std::to_string(count);
}
void Object(const Json& value, std::size_t maximum = 128 * 1024) {
  if (!value.is_object() || value.dump().size() > maximum) Invalid();
}
void StringField(const Json& value, const char* key, std::size_t maximum, bool optional = false, bool nullable = false) {
  if (!value.contains(key)) { if (!optional) Invalid(); return; }
  if (nullable && value[key].is_null()) return;
  static_cast<void>(Text(value[key], maximum));
}
void NumberField(const Json& value, const char* key, std::int64_t minimum, bool optional = false, bool nullable = false) {
  if (!value.contains(key)) { if (!optional) Invalid(); return; }
  if (nullable && value[key].is_null()) return;
  static_cast<void>(Integer(value[key], minimum, kMaxQuantity));
}
void BooleanField(const Json& value, const char* key, bool optional = false, bool nullable = false) {
  if (!value.contains(key)) { if (!optional) Invalid(); return; }
  if (!(value[key].is_boolean() || (nullable && value[key].is_null()))) Invalid();
}
void Choice(const Json& value, const char* key, std::initializer_list<const char*> choices, bool optional = false) {
  if (!value.contains(key)) { if (!optional) Invalid(); return; }
  const auto choice = Text(value[key], 40);
  if (std::none_of(choices.begin(), choices.end(), [&](const auto item) { return choice == item; })) Invalid();
}
void OrderBody(const Json& value, bool is_template = false) {
  Object(value);
  StringField(value, "title", 120); StringField(value, "note", 2000);
  Choice(value, "kind", {"hourly", "escort", "single_round"});
  NumberField(value, "target_quantity", 1); NumberField(value, "failure_default_quantity", 0);
  Choice(value, "failure_trigger", {"failed", "failed_below_standard", "below_standard"}, true);
  Choice(value, "failure_mode", {"manual", "fixed", "shortfall"}, true);
  NumberField(value, "failure_standard_quantity", 0, true);
  NumberField(value, "price_cents", 0, true, true);
  if (value.contains("participant_count") && !value["participant_count"].is_null()) Integer(value["participant_count"], 1, 100);
  if (value.contains("commission_bps") && !value["commission_bps"].is_null()) Integer(value["commission_bps"], 0, 10000);
  if (value.contains("default_rental_session_id")) OptionalId(value["default_rental_session_id"]);
  if (is_template) StringField(value, "name", 80);
}
void BossBody(const Json& value) {
  Object(value); StringField(value, "display_name", 80); StringField(value, "game_id", 80);
  StringField(value, "game_name", 80); StringField(value, "notes", 4000);
}
void MatchBody(const Json& value) {
  Object(value); StringField(value, "player_name", 80); StringField(value, "note", 1000);
  Choice(value, "outcome", {"success", "failed", "unknown"}); BooleanField(value, "confirmed");
  NumberField(value, "amount", 0, false, true); NumberField(value, "fake_amount", 0, true, true);
  NumberField(value, "failure_extra_amount", 0, true);
  StringField(value, "played_at", 128, false, true);
  if (value.contains("order_id")) static_cast<void>(Uuid(value["order_id"]));
  if (value.contains("rental_session_id")) OptionalId(value["rental_session_id"]);
}
void EntryBody(const Json& value) {
  Object(value); Choice(value, "kind", {"progress", "failure", "adjustment"});
  NumberField(value, "quantity", -kMaxQuantity); StringField(value, "note", 1000);
  StringField(value, "occurred_at", 128, false, true);
  if (!value.contains("idempotency_key")) Invalid();
  static_cast<void>(Uuid(value["idempotency_key"]));
  NumberField(value, "amount", 0, true, true); NumberField(value, "fake_amount", 0, true, true);
  NumberField(value, "failure_extra_amount", 0, true);
  Choice(value, "outcome", {"success", "failed"}, true);
  if (value.contains("rental_session_id")) OptionalId(value["rental_session_id"]);
}

struct InternetHandle {
  HINTERNET value = nullptr;
  explicit InternetHandle(HINTERNET handle = nullptr) : value(handle) {}
  ~InternetHandle() { if (value) WinHttpCloseHandle(value); }
  InternetHandle(const InternetHandle&) = delete;
  InternetHandle& operator=(const InternetHandle&) = delete;
};
struct FileHandle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit FileHandle(HANDLE handle) : value(handle) {}
  ~FileHandle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
Bytes Hash(std::string_view value) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) throw ApiFailure("INTERNAL_ERROR", "无法初始化会话存储。");
  Bytes digest(32);
  const auto status = BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0);
  if (status < 0) { BCryptCloseAlgorithmProvider(algorithm, 0); throw ApiFailure("INTERNAL_ERROR", "无法初始化会话存储。"); }
  const auto hashed = BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(value.data())), static_cast<ULONG>(value.size()), 0);
  const auto finished = hashed < 0 ? hashed : BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0);
  BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0);
  if (finished < 0) throw ApiFailure("INTERNAL_ERROR", "无法初始化会话存储。");
  return digest;
}
std::string Hex(const Bytes& value) {
  constexpr char hex[] = "0123456789abcdef";
  std::string result;
  for (const auto byte : value) { result.push_back(hex[byte >> 4]); result.push_back(hex[byte & 15]); }
  return result;
}
bool ValidToken(std::string_view value) {
  return !value.empty() && value.size() <= 16384 && std::all_of(value.begin(), value.end(), [](unsigned char c) { return c >= 33 && c <= 126; });
}
bool Protect(std::string_view value, const Bytes& entropy, Bytes& encrypted) {
  DATA_BLOB input{static_cast<DWORD>(value.size()), reinterpret_cast<BYTE*>(const_cast<char*>(value.data()))};
  DATA_BLOB salt{static_cast<DWORD>(entropy.size()), const_cast<BYTE*>(entropy.data())}, output{};
  if (!CryptProtectData(&input, L"PWTools native session", &salt, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) return false;
  encrypted.assign(output.pbData, output.pbData + output.cbData);
  SecureZeroMemory(output.pbData, output.cbData); LocalFree(output.pbData); return true;
}
bool Unprotect(const Bytes& encrypted, const Bytes& entropy, std::string& plain) {
  DATA_BLOB input{static_cast<DWORD>(encrypted.size()), const_cast<BYTE*>(encrypted.data())};
  DATA_BLOB salt{static_cast<DWORD>(entropy.size()), const_cast<BYTE*>(entropy.data())}, output{};
  if (!CryptUnprotectData(&input, nullptr, &salt, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) return false;
  plain.assign(reinterpret_cast<const char*>(output.pbData), output.cbData);
  SecureZeroMemory(output.pbData, output.cbData); LocalFree(output.pbData); return true;
}
Bytes ReadEncrypted(const std::filesystem::path& path) {
  FileHandle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (file.value == INVALID_HANDLE_VALUE) return {};
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file.value, &size) || size.QuadPart <= 0 || size.QuadPart > 65536) return {};
  Bytes result(static_cast<std::size_t>(size.QuadPart)); DWORD read = 0;
  if (!ReadFile(file.value, result.data(), static_cast<DWORD>(result.size()), &read, nullptr) || read != result.size()) return {};
  return result;
}
bool WriteEncrypted(const std::filesystem::path& path, const Bytes& bytes) {
  static std::atomic<unsigned long> sequence{0};
  const auto temporary = std::filesystem::path(path.native() + L".tmp-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(sequence.fetch_add(1)));
  bool written = false;
  {
    FileHandle file(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (file.value == INVALID_HANDLE_VALUE) return false;
    DWORD count = 0;
    written = WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count == bytes.size() && FlushFileBuffers(file.value);
  }
  if (written) written = MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE;
  if (!written) DeleteFileW(temporary.c_str());
  return written;
}

int Base64Digit(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A'; if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52; if (c == '+') return 62; if (c == '/') return 63;
  return -1;
}
Bytes DecodeImage(const Json& value) {
  if (!value.is_string()) throw ApiFailure("INVALID_IMAGE", "截图数据不正确。");
  const auto& text = value.get_ref<const std::string&>();
  if (text.empty() || text.size() > ((kMaxImage + 2) / 3) * 4 || text.size() % 4) throw ApiFailure("INVALID_IMAGE", "请选择不超过 12 MB 的 PNG、JPEG 或 WebP 截图。");
  const auto padding = text.ends_with("==") ? 2u : text.ends_with("=") ? 1u : 0u;
  const auto size = text.size() / 4 * 3 - padding;
  if (!size || size > kMaxImage) throw ApiFailure("INVALID_IMAGE", "截图超过大小限制。");
  Bytes bytes; bytes.reserve(size);
  for (std::size_t i = 0; i < text.size(); i += 4) {
    int digits[4]{};
    for (std::size_t j = 0; j < 4; ++j) {
      if (text[i + j] == '=' && i + j >= text.size() - padding) digits[j] = 0;
      else { digits[j] = Base64Digit(static_cast<unsigned char>(text[i + j])); if (digits[j] < 0) throw ApiFailure("INVALID_IMAGE", "截图数据不正确。"); }
    }
    const auto group = (digits[0] << 18) | (digits[1] << 12) | (digits[2] << 6) | digits[3];
    bytes.push_back(static_cast<unsigned char>(group >> 16));
    if (bytes.size() < size) bytes.push_back(static_cast<unsigned char>(group >> 8));
    if (bytes.size() < size) bytes.push_back(static_cast<unsigned char>(group));
    if (i + 4 == text.size() && ((padding == 2 && (digits[1] & 15)) || (padding == 1 && (digits[2] & 3)))) throw ApiFailure("INVALID_IMAGE", "截图数据不正确。");
  }
  return bytes;
}
std::string EncodeImage(const Bytes& bytes) {
  constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string text; text.reserve((bytes.size() + 2) / 3 * 4);
  for (std::size_t i = 0; i < bytes.size(); i += 3) {
    const unsigned a = bytes[i], b = i + 1 < bytes.size() ? bytes[i + 1] : 0, c = i + 2 < bytes.size() ? bytes[i + 2] : 0;
    text.push_back(alphabet[a >> 2]); text.push_back(alphabet[((a & 3) << 4) | (b >> 4)]);
    text.push_back(i + 1 < bytes.size() ? alphabet[((b & 15) << 2) | (c >> 6)] : '=');
    text.push_back(i + 2 < bytes.size() ? alphabet[c & 63] : '=');
  }
  return text;
}

struct ParsedUrl { std::string canonical; std::wstring host, path; INTERNET_PORT port{}; bool secure{}; };
ParsedUrl ParseUrl(const std::string& value) {
  if (value.empty() || value.size() > 4096 || value.find_first_of("?#\\") != std::string::npos || std::any_of(value.begin(), value.end(), [](unsigned char c) { return c <= 32 || c == 127; })) throw ApiFailure("INVALID_CONFIG", "服务地址须为 HTTPS，或本机 HTTP 地址。");
  const auto url = Wide(value);
  URL_COMPONENTS parts{}; parts.dwStructSize = sizeof(parts);
  parts.dwSchemeLength = parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwExtraInfoLength = parts.dwUserNameLength = parts.dwPasswordLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts) || !parts.dwHostNameLength || parts.dwUserNameLength || parts.dwPasswordLength || parts.dwExtraInfoLength || (parts.nScheme != INTERNET_SCHEME_HTTP && parts.nScheme != INTERNET_SCHEME_HTTPS)) throw ApiFailure("INVALID_CONFIG", "服务地址不正确。");
  ParsedUrl result; result.host.assign(parts.lpszHostName, parts.dwHostNameLength);
  std::transform(result.host.begin(), result.host.end(), result.host.begin(), [](wchar_t c) { return c >= L'A' && c <= L'Z' ? static_cast<wchar_t>(c + 32) : c; });
  result.secure = parts.nScheme == INTERNET_SCHEME_HTTPS; result.port = parts.nPort;
  if (!result.secure && result.host != L"localhost" && result.host != L"127.0.0.1" && result.host != L"::1" && result.host != L"[::1]") throw ApiFailure("INVALID_CONFIG", "远程服务地址须使用 HTTPS。");
  if (parts.dwUrlPathLength) result.path.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
  while (!result.path.empty() && result.path.back() == L'/') result.path.pop_back();
  auto display_host = Utf8(result.host);
  if (display_host.find(':') != std::string::npos && display_host.front() != '[') display_host = '[' + display_host + ']';
  result.canonical = std::string(result.secure ? "https://" : "http://") + display_host;
  if (result.port != (result.secure ? INTERNET_DEFAULT_HTTPS_PORT : INTERNET_DEFAULT_HTTP_PORT)) result.canonical += ':' + std::to_string(result.port);
  result.canonical += Utf8(result.path);
  return result;
}

// The WinHTTP handle holds a reference until HANDLE_CLOSING, including timed-out I/O.
// This keeps request/receive buffers alive without blocking the caller past its deadline.
struct AsyncState {
  std::atomic<unsigned> references{1};
  std::mutex mutex; std::condition_variable changed;
  DWORD completed = 0, error = 0, available = 0, read = 0;
  Bytes request_body, read_buffer = Bytes(32768);
  std::wstring headers;
  ~AsyncState() {
    if (!request_body.empty()) SecureZeroMemory(request_body.data(), request_body.size());
    if (!headers.empty()) SecureZeroMemory(headers.data(), headers.size() * sizeof(wchar_t));
  }
  void AddRef() noexcept { references.fetch_add(1, std::memory_order_relaxed); }
  void Release() noexcept { if (references.fetch_sub(1, std::memory_order_acq_rel) == 1) delete this; }
  void Prepare() { std::lock_guard lock(mutex); completed = error = available = read = 0; }
  void Await(DWORD expected, std::chrono::steady_clock::time_point deadline) {
    std::unique_lock lock(mutex);
    if (!changed.wait_until(lock, deadline, [&] { return error || completed == expected; })) Network(ERROR_WINHTTP_TIMEOUT);
    if (error) Network(error);
  }
};
void CALLBACK StatusCallback(HINTERNET, DWORD_PTR context, DWORD status, void* information, DWORD length) noexcept {
  if (!context) return;
  auto* state = reinterpret_cast<AsyncState*>(context);
  if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) { state->Release(); return; }
  try {
    std::lock_guard lock(state->mutex);
    if (status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR) state->error = information && length >= sizeof(WINHTTP_ASYNC_RESULT) ? static_cast<WINHTTP_ASYNC_RESULT*>(information)->dwError : ERROR_WINHTTP_INTERNAL_ERROR;
    else if (status == WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE || status == WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE || status == WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE || status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE) {
      state->completed = status;
      if (status == WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE && information && length >= sizeof(DWORD)) state->available = *static_cast<DWORD*>(information);
      if (status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE) state->read = length;
    } else return;
    state->changed.notify_all();
  } catch (...) { /* Never propagate a C++ exception through a WinHTTP callback. */ }
}
void Started(BOOL result) { if (!result) { const auto error = GetLastError(); if (error != ERROR_IO_PENDING) Network(error); } }
std::string ContentType(HINTERNET request) {
  DWORD size = 0;
  WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX, nullptr, &size, WINHTTP_NO_HEADER_INDEX);
  if (!size || size > 8192) return {};
  std::wstring value(size / sizeof(wchar_t), L'\0');
  if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX, value.data(), &size, WINHTTP_NO_HEADER_INDEX)) return {};
  while (!value.empty() && value.back() == L'\0') value.pop_back();
  return Utf8(value);
}
struct HttpResponse {
  DWORD status = 0; std::string content_type; Bytes body;
  ~HttpResponse() { if (!body.empty()) SecureZeroMemory(body.data(), body.size()); }
};
} // namespace

struct ApiBridge::Impl {
  struct Snapshot {
    std::string token; std::uint64_t revision = 0;
    ~Snapshot() { Erase(token); }
  };
  ParsedUrl url;
  std::filesystem::path session_path;
  Bytes entropy;
  mutable std::mutex session_mutex;
  std::string token;
  std::uint64_t revision = 0, auth_intent = 0;
  std::atomic<bool> persistent{false};
  LocalRecognizer local_recognizer;
  LocalRecognizer attribute_recognizer;

  Impl(std::string value, const std::filesystem::path& directory, LocalRecognizer recognizer, LocalRecognizer attributes)
      : url(ParseUrl(value)), entropy(Hash(url.canonical)), local_recognizer(std::move(recognizer)), attribute_recognizer(std::move(attributes)) {
    if (!local_recognizer || !attribute_recognizer) {
      auto local = std::make_shared<LocalOcr>();
      if(!local_recognizer) local_recognizer = [local](const Bytes& image, const std::string& mime) { return local->Recognize(image, mime); };
      if(!attribute_recognizer) attribute_recognizer = [local](const Bytes& image, const std::string& mime) { return local->RecognizeBuildAttributes(image, mime); };
    }
    session_path = directory / ("session-native-" + Hex(entropy).substr(0, 16) + ".bin");
    std::error_code error;
    std::filesystem::create_directories(directory, error);
    Bytes probe;
    persistent.store(!error && Protect("PWTools native session availability", entropy, probe));
    if (!persistent.load()) return;
    const auto encrypted = ReadEncrypted(session_path);
    if (encrypted.empty()) return;
    if (Unprotect(encrypted, entropy, token) && ValidToken(token)) revision = 1;
    else { Erase(token); DeleteFileW(session_path.c_str()); }
  }
  ~Impl() { Erase(token); }
  Snapshot Current() const { std::lock_guard lock(session_mutex); return {token, revision}; }
  void ClearIf(const Snapshot& current) {
    std::lock_guard lock(session_mutex);
    if (current.revision != revision || current.token != token) return;
    Erase(token); ++revision; DeleteFileW(session_path.c_str());
  }
  std::uint64_t BeginLogin() { std::lock_guard lock(session_mutex); return ++auth_intent; }
  void SaveToken(std::string value, std::uint64_t intent) {
    std::lock_guard lock(session_mutex);
    if (intent != auth_intent) { Erase(value); throw ApiFailure("AUTH_CHANGED", "登录操作已被新的请求替换，请重试。"); }
    Erase(token); token = std::move(value); ++revision;
    if (!persistent.load()) return;
    Bytes encrypted;
    if (!Protect(token, entropy, encrypted) || !WriteEncrypted(session_path, encrypted)) { persistent.store(false); DeleteFileW(session_path.c_str()); }
  }

  HttpResponse Send(const std::string& path, const wchar_t* verb, const Bytes& body, const std::string& content_type,
                    const std::string& extra_headers, bool authenticated, int milliseconds, std::size_t maximum,
                    const Snapshot* given = nullptr) {
    const auto current = given ? Snapshot{given->token, given->revision} : Current();
    if (authenticated && current.token.empty()) throw ApiFailure("UNAUTHORIZED", "请登录后继续。");
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(milliseconds);
    InternetHandle session(WinHttpOpen(L"PWTools/Native", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC));
    if (!session.value) Network(GetLastError());
    if (!WinHttpSetTimeouts(session.value, milliseconds, milliseconds, milliseconds, milliseconds)) Network(GetLastError());
    InternetHandle connection(WinHttpConnect(session.value, url.host.c_str(), url.port, 0));
    if (!connection.value) Network(GetLastError());
    const auto target = url.path + Wide(path);
    InternetHandle request(WinHttpOpenRequest(connection.value, verb, target.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, url.secure ? WINHTTP_FLAG_SECURE : 0));
    if (!request.value) Network(GetLastError());
    DWORD disable = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
    if (!WinHttpSetOption(request.value, WINHTTP_OPTION_DISABLE_FEATURE, &disable, sizeof(disable))) Network(GetLastError());
    auto state = std::unique_ptr<AsyncState, void(*)(AsyncState*)>(new AsyncState, [](AsyncState* item) { item->Release(); });
    DWORD_PTR context = reinterpret_cast<DWORD_PTR>(state.get());
    if (!WinHttpSetOption(request.value, WINHTTP_OPTION_CONTEXT_VALUE, &context, sizeof(context))) Network(GetLastError());
    if (WinHttpSetStatusCallback(request.value, StatusCallback, WINHTTP_CALLBACK_FLAG_ALL_NOTIFICATIONS, 0) == WINHTTP_INVALID_STATUS_CALLBACK) Network(GetLastError());
    state->AddRef();
    state->request_body = body;
    state->headers = L"Accept: application/json\r\n";
    if (authenticated) state->headers += L"Authorization: Bearer " + Wide(current.token) + L"\r\n";
    if (!content_type.empty()) state->headers += L"Content-Type: " + Wide(content_type) + L"\r\n";
    if (!extra_headers.empty()) state->headers += Wide(extra_headers);
    state->Prepare();
    Started(WinHttpSendRequest(request.value, state->headers.c_str(), static_cast<DWORD>(state->headers.size()), state->request_body.empty() ? WINHTTP_NO_REQUEST_DATA : state->request_body.data(), static_cast<DWORD>(state->request_body.size()), static_cast<DWORD>(state->request_body.size()), context));
    state->Await(WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE, deadline);
    state->Prepare(); Started(WinHttpReceiveResponse(request.value, nullptr));
    state->Await(WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE, deadline);
    HttpResponse response;
    DWORD status_size = sizeof(response.status);
    if (!WinHttpQueryHeaders(request.value, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &response.status, &status_size, WINHTTP_NO_HEADER_INDEX)) Network(GetLastError());
    if (response.status >= 300 && response.status < 400) throw ApiFailure("NETWORK_ERROR", "服务地址发生跳转，请检查配置。");
    if (response.status == 401 && authenticated) ClearIf(current);
    response.content_type = ContentType(request.value);
    for (;;) {
      state->Prepare(); Started(WinHttpQueryDataAvailable(request.value, nullptr));
      state->Await(WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE, deadline);
      if (!state->available) break;
      if (state->available > maximum - response.body.size()) throw ApiFailure("RESPONSE_TOO_LARGE", "服务返回的数据超过大小限制。");
      state->Prepare(); Started(WinHttpReadData(request.value, state->read_buffer.data(), static_cast<DWORD>(state->read_buffer.size()), nullptr));
      state->Await(WINHTTP_CALLBACK_STATUS_READ_COMPLETE, deadline);
      if (!state->read) break;
      if (state->read > maximum - response.body.size()) throw ApiFailure("RESPONSE_TOO_LARGE", "服务返回的数据超过大小限制。");
      response.body.insert(response.body.end(), state->read_buffer.begin(), state->read_buffer.begin() + state->read);
    }
    if (response.status < 200 || response.status >= 300) {
      const auto parsed = Json::parse(response.body.begin(), response.body.end(), nullptr, false);
      std::string code = "API_ERROR", message = "服务请求失败，请稍后重试。";
      if (parsed.is_object() && parsed.contains("error") && parsed["error"].is_object()) {
        const auto& error = parsed["error"];
        if (error.contains("code") && error["code"].is_string()) code = error["code"].get<std::string>();
        if (error.contains("message") && error["message"].is_string()) message = error["message"].get<std::string>();
      }
      throw ApiFailure(std::move(code), std::move(message));
    }
    return response;
  }
  Json Request(const std::string& path, const wchar_t* verb = L"GET", const Json* body = nullptr, bool authenticated = true, int timeout = 15000, const Snapshot* snapshot = nullptr) {
    std::string serialized = body ? body->dump() : std::string{};
    Bytes bytes(serialized.begin(), serialized.end()); Erase(serialized);
    struct ClearBody {
      Bytes& value;
      ~ClearBody() { if (!value.empty()) SecureZeroMemory(value.data(), value.size()); }
    } clear{bytes};
    const auto response = Send(path, verb, bytes, body ? "application/json" : "", "", authenticated, timeout, kMaxJsonResponse, snapshot);
    if (response.status == 204) return nullptr;
    auto result = Json::parse(response.body.begin(), response.body.end(), nullptr, false);
    if (result.is_discarded()) throw ApiFailure("INVALID_RESPONSE", "服务返回的数据格式不正确。");
    return result;
  }

  Json LocalResult(const Bytes& bytes, const std::string& mime) {
    try { return local_recognizer(bytes, mime); }
    catch (...) { return nullptr; } // The saved original remains available for manual entry or retry.
  }
  Json SaveLocalResult(const std::string& path, const Bytes& bytes, Json recognition, const Snapshot& snapshot) {
    const auto hash = Hex(Hash(std::string_view(reinterpret_cast<const char*>(bytes.data()), bytes.size())));
    const Json payload{{"image_sha256", hash}, {"recognition", std::move(recognition)}};
    return Request(path + "/local-recognition", L"POST", &payload, true, 15000, &snapshot);
  }

  Json Execute(const std::string& method, const Json& args) {
    if (!args.is_array()) Invalid();
    const auto& first = Arg(args, 0); const auto& second = Arg(args, 1);
    if (method == "health") { Arguments(args, 0, 0); return Request("/health", L"GET", nullptr, false); }
    if (method == "login" || method == "register") {
      Arguments(args, 1, 1); Object(first); StringField(first, "email", 320); StringField(first, "password", 1024);
      const auto intent = BeginLogin();
      auto result = Request(method == "login" ? "/auth/login" : "/auth/register", L"POST", &first, false);
      if (!result.is_object() || !result.contains("token") || !result["token"].is_string() || !result.contains("user") || !result["user"].is_object()) throw ApiFailure("INVALID_RESPONSE", "登录结果格式不正确。");
      auto next_token = result["token"].get<std::string>();
      auto& response_token = result["token"].get_ref<std::string&>(); Erase(response_token);
      if (!ValidToken(next_token)) { Erase(next_token); throw ApiFailure("INVALID_RESPONSE", "登录结果格式不正确。"); }
      SaveToken(std::move(next_token), intent);
      return result["user"];
    }
    if (method == "me") { Arguments(args, 0, 0); return Request("/me"); }
    if (method == "logout") {
      Arguments(args, 0, 0);
      Snapshot current;
      { std::lock_guard lock(session_mutex); ++auth_intent; current.token = token; current.revision = revision; }
      if (!current.token.empty()) static_cast<void>(Request("/auth/logout", L"POST", nullptr, true, 15000, &current));
      ClearIf(current); return nullptr;
    }
    if (method == "recognizeBuildCodeAttributes") {
      Arguments(args,1,1); Object(first,kMaxImageJsonRequest); StringField(first,"name",255); StringField(first,"content_type",30);
      const auto type=first["content_type"].get<std::string>();
      if(type!="image/png" && type!="image/jpeg" && type!="image/webp")throw ApiFailure("INVALID_IMAGE","只支持 PNG、JPEG 和 WebP 图片。");
      const auto bytes=DecodeImage(first["data_base64"]);
      const auto snapshot=Current();
      static_cast<void>(Request("/me",L"GET",nullptr,true,15000,&snapshot));
      const auto result=attribute_recognizer(bytes,type);
      const auto current=Current();
      if(current.revision!=snapshot.revision || current.token!=snapshot.token)throw ApiFailure("UNAUTHORIZED","登录状态已改变，请重新打开属性面板。");
      return result;
    }
    if (method == "uploadMatch") {
      Arguments(args, 1, 1); if (!first.is_object() || !first.contains("name") || !first.contains("content_type") || !first.contains("data_base64")) throw ApiFailure("INVALID_IMAGE", "截图数据不正确。");
      std::string name, type;
      try { name = Text(first["name"], 255); type = Text(first["content_type"], 30); }
      catch (const ApiFailure&) { throw ApiFailure("INVALID_IMAGE", "截图名称或格式不正确。"); }
      if (type != "image/png" && type != "image/jpeg" && type != "image/webp") throw ApiFailure("INVALID_IMAGE", "只支持 PNG、JPEG 和 WebP 图片。");
      const auto bytes = DecodeImage(first["data_base64"]);
      const auto order_id = first.contains("order_id") ? OptionalId(first["order_id"]) : std::string{};
      if (order_id.empty()) Invalid();
      const auto snapshot = Current();
      Json payload = first;
      payload["recognition"] = LocalResult(bytes, type);
      return Request("/matches/preview-local", L"POST", &payload, true, 70000, &snapshot);
    }
    if (method == "confirmMatch") {
      // Base64 originals use the same envelope limit as /matches/confirm; fields retain their own bounds.
      Arguments(args, 1, 1); Object(first, kMaxImageJsonRequest); StringField(first, "name", 255); StringField(first, "content_type", 30);
      static_cast<void>(DecodeImage(first.at("data_base64"))); Uuid(first.at("order_id")); MatchBody(first.at("input"));
      return Request("/matches/confirm", L"POST", &first, true, 70000);
    }
    if (method == "listMatches") {
      Arguments(args, 0, 4); auto query = Pages(first, second, 20);
      const auto order_id = OptionalId(Arg(args, 2)); if (!order_id.empty()) query += "&order_id=" + Encode(order_id);
      const auto& confirmed = Arg(args, 3); if (!Missing(confirmed)) { if (!confirmed.is_boolean()) Invalid(); query += confirmed.get<bool>() ? "&confirmed=true" : "&confirmed=false"; }
      return Request("/matches?" + query);
    }
    if (method == "matchStats") { Arguments(args, 0, 1); const auto id = OptionalId(first); return Request("/matches/stats" + (id.empty() ? std::string{} : "?order_id=" + Encode(id))); }
    if (method == "matchSettings") { Arguments(args, 0, 0); return Request("/matches/settings"); }
    if (method == "updateMatchSettings") {
      Arguments(args, 1, 1); Object(first); StringField(first, "boss_id", 80); StringField(first, "boss_player_name", 80);
      return Request("/matches/settings", L"PATCH", &first);
    }
    if (method == "getMatch" || method == "deleteMatch" || method == "recognizeMatch" || method == "matchImage" || method == "matchThumbnail") {
      Arguments(args, 1, 1); const auto path = "/matches/" + Uuid(first);
      if (method == "getMatch") return Request(path);
      if (method == "deleteMatch") return Request(path, L"DELETE");
      const auto snapshot = Current();
      const auto thumbnail = method == "matchThumbnail";
      const auto response = Send(path + (thumbnail ? "/thumbnail" : "/image"), L"GET", {}, "", "", true, method == "recognizeMatch" ? 20000 : 15000, thumbnail ? 256 * 1024 : kMaxImage, &snapshot);
      const auto type = response.content_type.empty() ? "image/png" : response.content_type;
      if (type != "image/png" && type != "image/jpeg" && type != "image/webp") throw ApiFailure("INVALID_IMAGE", "服务返回的截图格式不正确。");
      if (method == "recognizeMatch") return SaveLocalResult(path, response.body, LocalResult(response.body, type), snapshot);
      return Json{{"content_type", type}, {"data_base64", EncodeImage(response.body)}};
    }
    if (method == "updateMatch") { Arguments(args, 2, 2); const auto id = Uuid(first); MatchBody(second); return Request("/matches/" + id, L"PATCH", &second); }
    if (method == "listRentalAccounts") { Arguments(args, 0, 0); return Request("/rental-accounts"); }
    if (method == "listBuildCodes") { Arguments(args, 0, 0); return Request("/weapon-build-codes"); }
    if (method == "deleteBuildCode") { Arguments(args, 1, 1); return Request("/weapon-build-codes/" + Uuid(first), L"DELETE"); }
    if (method == "createBuildCode" || method == "lookupBuildCode" || method == "updateBuildCode") {
      const bool updating = method == "updateBuildCode";
      Arguments(args, updating ? 2 : 1, updating ? 2 : 1);
      const auto& body = updating ? second : first;
      Object(body); StringField(body, "code", 768); StringField(body, "weapon_name", 300); StringField(body, "note", 6000);
      Choice(body, "mode", {"烽火地带", "全面战场"});
      const auto path = updating ? "/weapon-build-codes/" + Uuid(first) : method == "lookupBuildCode" ? "/weapon-build-codes/lookup" : "/weapon-build-codes";
      return Request(path, updating ? L"PATCH" : L"POST", &body);
    }
    if (method == "listRentalSessions") { Arguments(args, 0, 0); return Request("/rental-sessions"); }
    if (method == "rentalAnalysis") { Arguments(args, 1, 1); return Request("/rental-sessions/" + Uuid(first) + "/analysis"); }
    if (method == "createRentalAccount") {
      Arguments(args, 1, 1); Object(first); Uuid(first.at("id")); StringField(first, "name", 80); StringField(first, "note", 2000);
      return Request("/rental-accounts", L"POST", &first);
    }
    if (method == "createRentalSession") {
      Arguments(args, 1, 1); Object(first); Uuid(first.at("id")); Uuid(first.at("account_id"));
      NumberField(first, "coin_per_yuan", 1);
      for (const auto key : {"aw_price", "helmet_price", "armor_price", "initial_coins", "deposit_cents"}) NumberField(first, key, 0);
      StringField(first, "started_at", 128); StringField(first, "note", 2000);
      return Request("/rental-sessions", L"POST", &first);
    }
    if (method == "returnRentalSession") {
      Arguments(args, 2, 2); const auto id = Uuid(first); Object(second); NumberField(second, "final_cost_cents", 0); StringField(second, "returned_at", 128, true, true);
      return Request("/rental-sessions/" + id + "/return", L"PATCH", &second);
    }
    if (method == "listBosses") { Arguments(args, 0, 1); const auto search = Missing(first) ? std::string{} : Text(first, 200); return Request("/bosses?q=" + Encode(search)); }
    if (method == "getBoss") { Arguments(args, 1, 1); return Request("/bosses/" + Uuid(first)); }
    if (method == "createBoss") { Arguments(args, 1, 1); BossBody(first); return Request("/bosses", L"POST", &first); }
    if (method == "updateBoss") { Arguments(args, 2, 2); const auto id = Uuid(first); BossBody(second); return Request("/bosses/" + id, L"PATCH", &second); }
    if (method == "listOrders") { Arguments(args, 0, 1); const auto id = OptionalId(first); return Request("/orders" + (id.empty() ? std::string{} : "?boss_id=" + Encode(id))); }
    if (method == "getOrder") { Arguments(args, 1, 1); return Request("/orders/" + Uuid(first)); }
    if (method == "createOrder") { Arguments(args, 2, 2); const auto id = Uuid(first); OrderBody(second); return Request("/bosses/" + id + "/orders", L"POST", &second); }
    if (method == "archiveOrder") {
      Arguments(args, 2, 2); const auto id = Uuid(first); Object(second); Uuid(second.at("id"));
      Choice(second, "mode", {"waiver", "refund", "completed"}); NumberField(second, "final_income_cents", 0);
      StringField(second, "note", 1000); StringField(second, "expected_updated_at", 128);
      return Request("/orders/" + id + "/archive", L"POST", &second);
    }
    if (method == "transferOrder") {
      Arguments(args, 2, 2); const auto id = Uuid(first); Object(second); Uuid(second.at("id"));
      BooleanField(second, "prepaid");
      if (second.contains("progress_bps") && !second["progress_bps"].is_null()) Integer(second["progress_bps"], 0, 10000);
      StringField(second, "note", 1000); StringField(second, "expected_updated_at", 128);
      return Request("/orders/" + id + "/transfer", L"POST", &second);
    }
    if (method == "transferOrderAction") {
      Arguments(args, 2, 2); const auto id = Uuid(first); Object(second); Uuid(second.at("id")); Uuid(second.at("transfer_id"));
      Choice(second, "action", {"settle", "cancel", "refund", "confirm_refund"});
      if (second["action"] == "settle") NumberField(second, "amount_cents", 0);
      if (second["action"] == "refund") {
        NumberField(second, "final_income_cents", 0); Choice(second, "mode", {"refund", "waiver"});
      }
      StringField(second, "note", 1000); StringField(second, "expected_updated_at", 128);
      return Request("/orders/" + id + "/transfer-action", L"POST", &second);
    }
    if (method == "restoreOrder") {
      Arguments(args, 2, 2); const auto id = Uuid(first); Object(second); Uuid(second.at("settlement_id"));
      return Request("/orders/" + id + "/restore", L"POST", &second);
    }
    if (method == "updateOrder") { Arguments(args, 2, 2); const auto id = Uuid(first); OrderBody(second); return Request("/orders/" + id, L"PATCH", &second); }
    if (method == "listOrderTemplates") { Arguments(args, 0, 0); return Request("/order-templates"); }
    if (method == "createOrderTemplate") { Arguments(args, 1, 1); OrderBody(first, true); return Request("/order-templates", L"POST", &first); }
    if (method == "updateOrderTemplate") { Arguments(args, 2, 2); const auto id = Uuid(first); OrderBody(second, true); return Request("/order-templates/" + id, L"PATCH", &second); }
    if (method == "deleteOrderTemplate") { Arguments(args, 1, 1); return Request("/order-templates/" + Uuid(first), L"DELETE"); }
    if (method == "listLedgerEntries") { Arguments(args, 1, 3); return Request("/orders/" + Uuid(first) + "/entries?" + Pages(second, Arg(args, 2), 20)); }
    if (method == "addLedgerEntry") { Arguments(args, 2, 2); const auto id = Uuid(first); EntryBody(second); return Request("/orders/" + id + "/entries", L"POST", &second); }
    if (method == "deleteLedgerEntry") { Arguments(args, 2, 2); return Request("/orders/" + Uuid(first) + "/entries/" + Uuid(second), L"DELETE"); }
    throw ApiFailure("INVALID_METHOD", "不支持此操作。");
  }
};

ApiBridge::ApiBridge(std::string api_url, std::filesystem::path data_directory, LocalRecognizer recognizer, LocalRecognizer attributes)
    : impl_(std::make_unique<Impl>(std::move(api_url), data_directory, std::move(recognizer), std::move(attributes))) {}
ApiBridge::~ApiBridge() = default;
Json ApiBridge::Execute(const std::string& method, const Json& args) {
  try { return impl_->Execute(method, args); }
  catch (const ApiFailure&) { throw; }
  catch (const Json::exception&) { throw ApiFailure("INVALID_INPUT", "输入参数不正确。"); }
}
bool ApiBridge::PersistentSession() const noexcept { return impl_->persistent.load(); }
const std::string& ApiBridge::ApiUrl() const noexcept { return impl_->url.canonical; }

} // namespace pwtools
