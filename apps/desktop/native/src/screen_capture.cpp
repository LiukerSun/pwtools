#include "screen_capture.hpp"
#include "api_bridge.hpp"
#include "clipboard_image.hpp"
#include <dwmapi.h>
#include <wincrypt.h>
#include <shlwapi.h>
#include <wincodec.h>
#include <wrl.h>
#include <WebView2.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <exception>
#include <fstream>
#include <limits>
#include <utility>
#include <unordered_set>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using json = nlohmann::json;

namespace pwtools {
namespace {
constexpr wchar_t OverlayClass[] = L"PWToolsScreenCapture";
constexpr wchar_t OverlayUrl[] = L"https://pwtools.local/capture.html";
constexpr wchar_t ContentSecurityPolicy[] = L"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-src 'none'";
constexpr UINT_PTR StartTimer = 1;
constexpr UINT_PTR ExpiryTimer = 2;
constexpr UINT CompleteMessage = WM_APP + 51;
constexpr UINT CaptureDelayMs = 180;
constexpr UINT CaptureTimeoutMs = 300000;
constexpr uint64_t MaxSnapshotPixels = 80000000;
constexpr LONG MaxSnapshotSide = 32000;
constexpr size_t MaxSnapshotPngBytes = 64 * 1024 * 1024;
constexpr size_t MaxImageBytes = 12 * 1024 * 1024;

[[noreturn]] void CaptureFailure() { throw ApiFailure("CAPTURE_FAILED", "无法截取当前屏幕，请稍后重试。"); }
[[noreturn]] void ImageTooLarge() { throw ApiFailure("IMAGE_TOO_LARGE", "截图不能超过 12 MiB，单边不能超过 16000 像素，总像素不能超过 4000 万。"); }
void CaptureCheck(HRESULT result) { if (FAILED(result)) CaptureFailure(); }
bool ValidBounds(const RECT& bounds, LONG side, uint64_t pixels) {
  const int64_t width = static_cast<int64_t>(bounds.right) - bounds.left;
  const int64_t height = static_cast<int64_t>(bounds.bottom) - bounds.top;
  return width > 0 && height > 0 && width <= side && height <= side && static_cast<uint64_t>(width * height) <= pixels;
}
std::wstring Wide(const std::string& value) {
  if (value.empty()) return {};
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (!count) CaptureFailure();
  std::wstring result(count, L'\0');
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), count)) CaptureFailure();
  return result;
}
std::string Utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (!count) CaptureFailure();
  std::string result(count, '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), count, nullptr, nullptr)) CaptureFailure();
  return result;
}
std::string Base64(const std::vector<BYTE>& bytes) {
  DWORD count = 0;
  if (!CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &count)) CaptureFailure();
  std::string result(count, '\0');
  if (!CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, result.data(), &count)) CaptureFailure();
  result.resize(count);
  if (!result.empty() && result.back() == '\0') result.pop_back();
  return result;
}
std::vector<BYTE> DecodeImage(const std::string& value) {
  const auto invalid = [] { throw ApiFailure("INVALID_IMAGE", "截图图片无法读取，请重新框选。"); };
  if (value.empty()) throw ApiFailure("INVALID_IMAGE", "截图图片无法读取，请重新框选。");
  if (value.size() > ((MaxImageBytes + 2) / 3) * 4) ImageTooLarge();
  // Accept canonical base64 only, with no whitespace or trailing data.
  if (value.size() % 4 || value.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=") != std::string::npos) {
    throw ApiFailure("INVALID_IMAGE", "截图图片无法读取，请重新框选。");
  }
  const auto padding = value.find('=');
  if (padding != std::string::npos && (padding < value.size() - 2 || value.find_first_not_of('=', padding) != std::string::npos)) {
    throw ApiFailure("INVALID_IMAGE", "截图图片无法读取，请重新框选。");
  }
  DWORD count = 0;
  if (!CryptStringToBinaryA(value.data(), static_cast<DWORD>(value.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, nullptr, &count, nullptr, nullptr)) invalid();
  if (!count) invalid();
  if (count > MaxImageBytes) ImageTooLarge();
  std::vector<BYTE> bytes(count);
  if (!CryptStringToBinaryA(value.data(), static_cast<DWORD>(value.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, bytes.data(), &count, nullptr, nullptr)) invalid();
  bytes.resize(count);
  return bytes;
}

// The frozen desktop can exceed the final screenshot's file limit. Keep that
// temporary background bounded separately, and discard it after its one reply.
class SnapshotStream final : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IStream> {
 public:
  std::vector<BYTE> bytes;
  size_t position = 0;
  bool limitReached = false;
  STDMETHODIMP Read(void* output, ULONG count, ULONG* copied) override {
    if (!output && count) return STG_E_INVALIDPOINTER;
    const auto size = std::min<size_t>(count, position < bytes.size() ? bytes.size() - position : 0);
    if (size) std::memcpy(output, bytes.data() + position, size);
    position += size; if (copied) *copied = static_cast<ULONG>(size);
    return size == count ? S_OK : S_FALSE;
  }
  STDMETHODIMP Write(const void* input, ULONG count, ULONG* copied) override {
    if (copied) *copied = 0;
    if (!input && count) return STG_E_INVALIDPOINTER;
    if (count > MaxSnapshotPngBytes - position) { limitReached = true; return STG_E_MEDIUMFULL; }
    try {
      if (position + count > bytes.size()) bytes.resize(position + count);
      if (count) std::memcpy(bytes.data() + position, input, count);
      position += count; if (copied) *copied = count; return S_OK;
    } catch (...) { return E_OUTOFMEMORY; }
  }
  STDMETHODIMP Seek(LARGE_INTEGER offset, DWORD origin, ULARGE_INTEGER* result) override {
    int64_t base = 0;
    if (origin == STREAM_SEEK_CUR) base = static_cast<int64_t>(position);
    else if (origin == STREAM_SEEK_END) base = static_cast<int64_t>(bytes.size());
    else if (origin != STREAM_SEEK_SET) return STG_E_INVALIDFUNCTION;
    if (offset.QuadPart < -base) return STG_E_INVALIDFUNCTION;
    if (offset.QuadPart > static_cast<int64_t>(MaxSnapshotPngBytes) - base) { limitReached = true; return STG_E_MEDIUMFULL; }
    position = static_cast<size_t>(base + offset.QuadPart);
    if (result) result->QuadPart = position;
    return S_OK;
  }
  STDMETHODIMP SetSize(ULARGE_INTEGER size) override {
    if (size.QuadPart > MaxSnapshotPngBytes) { limitReached = true; return STG_E_MEDIUMFULL; }
    try { bytes.resize(static_cast<size_t>(size.QuadPart)); return S_OK; } catch (...) { return E_OUTOFMEMORY; }
  }
  STDMETHODIMP CopyTo(IStream*, ULARGE_INTEGER, ULARGE_INTEGER*, ULARGE_INTEGER*) override { return E_NOTIMPL; }
  STDMETHODIMP Commit(DWORD) override { return S_OK; }
  STDMETHODIMP Revert() override { return E_NOTIMPL; }
  STDMETHODIMP LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  STDMETHODIMP UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  STDMETHODIMP Stat(STATSTG* stat, DWORD) override {
    if (!stat) return STG_E_INVALIDPOINTER;
    *stat = {}; stat->type = STGTY_STREAM; stat->cbSize.QuadPart = bytes.size(); stat->grfMode = STGM_READWRITE; return S_OK;
  }
  STDMETHODIMP Clone(IStream**) override { return E_NOTIMPL; }
};

std::vector<BYTE> EncodeSnapshot(HBITMAP bitmap) {
  ComPtr<IWICImagingFactory> factory;
  ComPtr<IWICBitmap> image;
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> properties;
  CaptureCheck(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
  CaptureCheck(factory->CreateBitmapFromHBITMAP(bitmap, nullptr, WICBitmapIgnoreAlpha, &image));
  auto stream = Microsoft::WRL::Make<SnapshotStream>();
  if (!stream) CaptureFailure();
  CaptureCheck(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder));
  CaptureCheck(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache));
  CaptureCheck(encoder->CreateNewFrame(&frame, &properties));
  CaptureCheck(frame->Initialize(properties.Get()));
  UINT width = 0, height = 0; CaptureCheck(image->GetSize(&width, &height));
  CaptureCheck(frame->SetSize(width, height));
  auto format = GUID_WICPixelFormat32bppBGRA; CaptureCheck(frame->SetPixelFormat(&format));
  HRESULT status = frame->WriteSource(image.Get(), nullptr);
  if (SUCCEEDED(status)) status = frame->Commit();
  if (SUCCEEDED(status)) status = encoder->Commit();
  if (FAILED(status) && stream->limitReached) throw ApiFailure("CAPTURE_UNAVAILABLE", "当前桌面图片过大，请减少显示内容或调整显示器布局后重试。");
  CaptureCheck(status);
  if (stream->bytes.empty()) CaptureFailure();
  return std::move(stream->bytes);
}

std::vector<BYTE> FreezeDesktop(const RECT& desktop, bool pattern) {
  const int width = desktop.right - desktop.left, height = desktop.bottom - desktop.top;
  HDC screen = GetDC(nullptr);
  if (!screen) CaptureFailure();
  struct ScreenDc { HDC value; ~ScreenDc() { ReleaseDC(nullptr, value); } } releaseScreen{screen};
  HDC memory = CreateCompatibleDC(screen);
  if (!memory) CaptureFailure();
  struct MemoryDc { HDC value; ~MemoryDc() { DeleteDC(value); } } releaseMemory{memory};
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height; info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
  void* pixels = nullptr;
  HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
  if (!bitmap || !pixels) { if (bitmap) DeleteObject(bitmap); CaptureFailure(); }
  struct Bitmap { HBITMAP value; ~Bitmap() { DeleteObject(value); } } releaseBitmap{bitmap};
  const auto previous = SelectObject(memory, bitmap);
  if (!previous || previous == HGDI_ERROR) CaptureFailure();
  struct Selection { HDC dc; HGDIOBJ value; ~Selection() { SelectObject(dc, value); } } restoreSelection{memory, previous};
  if (pattern) {
    // Only explicit debug profiles take this path. No desktop pixels are read.
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
      BYTE* pixel = static_cast<BYTE*>(pixels) + (static_cast<size_t>(y) * width + x) * 4;
      pixel[0] = static_cast<BYTE>((y / 16) % 200 + 20); pixel[1] = static_cast<BYTE>((x / 16) % 200 + 20);
      pixel[2] = 48; pixel[3] = 255;
    }
  } else if (!BitBlt(memory, 0, 0, width, height, screen, desktop.left, desktop.top, SRCCOPY | CAPTUREBLT)) CaptureFailure();
  auto encoded = EncodeCaptureBackground(bitmap);
  // The GDI bitmap and raw pixels die before base64/JSON copies are allocated.
  return encoded;
}

std::vector<RECT> SnapshotWindowBounds(const RECT& desktop) {
  std::vector<RECT> bounds;
  std::unordered_set<HWND> visited;
  // Cache top-level windows in front-to-back order before showing the overlay.
  // No titles, process names or child controls are read or passed to the page.
  for (HWND window = GetTopWindow(nullptr); window && visited.size() < 4096 && bounds.size() < 512;
       window = GetWindow(window, GW_HWNDNEXT)) {
    if (!visited.insert(window).second) break;
    if (!IsWindowVisible(window) || IsIconic(window)) continue;
    DWORD process = 0;
    GetWindowThreadProcessId(window, &process);
    if (!process || process == GetCurrentProcessId()) continue;
    const auto styles = GetWindowLongPtrW(window, GWL_EXSTYLE);
    if (styles & WS_EX_TRANSPARENT) continue;
    DWORD cloaked = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) continue;
    std::array<wchar_t, 256> className{};
    if (GetClassNameW(window, className.data(), static_cast<int>(className.size()))) {
      const std::wstring name(className.data());
      if (name == L"Progman" || name == L"WorkerW" || name == L"Shell_TrayWnd"
          || name == L"Shell_SecondaryTrayWnd" || name == L"tooltips_class32") continue;
    }
    RECT frame{};
    if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &frame, sizeof(frame)))
        && !GetWindowRect(window, &frame)) continue;
    if (auto clipped = ClipCaptureWindowBounds(frame, desktop)) bounds.push_back(*clipped);
  }
  return bounds;
}
} // namespace

std::optional<RECT> ClipCaptureWindowBounds(const RECT& window, const RECT& desktop) {
  const LONG left = std::max(window.left, desktop.left), top = std::max(window.top, desktop.top);
  const LONG right = std::min(window.right, desktop.right), bottom = std::min(window.bottom, desktop.bottom);
  if (right <= left || bottom <= top) return {};
  return RECT{left - desktop.left, top - desktop.top, right - desktop.left, bottom - desktop.top};
}

std::vector<BYTE> EncodeCaptureBackground(HBITMAP bitmap) {
  BITMAP image{};
  if (!bitmap || !GetObjectW(bitmap, sizeof(image), &image) || image.bmWidth <= 0 || image.bmHeight <= 0) CaptureFailure();
  const RECT bounds{0, 0, image.bmWidth, image.bmHeight};
  if (!ValidBounds(bounds, MaxSnapshotSide, MaxSnapshotPixels)) {
    throw ApiFailure("CAPTURE_UNAVAILABLE", "当前桌面尺寸过大，请调整显示器布局后重试。");
  }
  return EncodeSnapshot(bitmap);
}

std::vector<BYTE> ValidateCaptureReply(const std::string& base64) {
  auto png = DecodeImage(base64);
  try { return NormalizeClipboardImage(ClipboardImageFormat::Png, png); }
  catch (const ApiFailure& failure) {
    if (failure.code == "IMAGE_TOO_LARGE") ImageTooLarge();
    throw ApiFailure("INVALID_IMAGE", "截图图片无法读取，请重新框选。");
  }
}

class ScreenCapture::State final : public std::enable_shared_from_this<State> {
 public:
  HWND mainWindow, overlay = nullptr;
  ComPtr<ICoreWebView2Environment> environment;
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> view;
  std::filesystem::path rendererDirectory;
  bool testPattern;
  Restore restore;
  Completion completion;
  RECT desktop{};
  bool originalIconic = false, active = false, finishing = false, shown = false, ready = false, backgroundServed = false;
  uint64_t generation = 0;
  std::vector<BYTE> background;
  std::vector<RECT> windowBounds;
  std::optional<ScreenCaptureResult> pendingResult;

  State(HWND window, ICoreWebView2Environment* webEnvironment, const std::filesystem::path& renderer,
        bool pattern, Restore restoreWindow)
      : mainWindow(window), environment(webEnvironment), rendererDirectory(renderer), testPattern(pattern), restore(std::move(restoreWindow)) {}
  ~State() { Stop(false, {}); }

  void Start(Completion callback) {
    if (active) throw ApiFailure("BUSY", "正在截图，请先完成或取消当前框选。");
    if (!environment || !std::filesystem::is_regular_file(rendererDirectory / L"capture.html")) {
      throw ApiFailure("CAPTURE_UNAVAILABLE", "截图界面未能载入，请重新安装 PWTools 后重试。");
    }
    desktop = {GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), 0, 0};
    const int width = GetSystemMetrics(SM_CXVIRTUALSCREEN), height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    const int64_t right = static_cast<int64_t>(desktop.left) + width, bottom = static_cast<int64_t>(desktop.top) + height;
    if (right > std::numeric_limits<LONG>::max() || bottom > std::numeric_limits<LONG>::max() || width <= 0 || height <= 0) CaptureFailure();
    desktop.right = static_cast<LONG>(right); desktop.bottom = static_cast<LONG>(bottom);
    if (!ValidBounds(desktop, MaxSnapshotSide, MaxSnapshotPixels)) {
      throw ApiFailure("CAPTURE_UNAVAILABLE", "当前桌面尺寸过大，请调整显示器布局后重试。");
    }
    WNDCLASSEXW registration{sizeof(registration)};
    registration.lpfnWndProc = Procedure; registration.hInstance = GetModuleHandleW(nullptr);
    registration.hCursor = LoadCursorW(nullptr, IDC_CROSS); registration.lpszClassName = OverlayClass;
    if (!RegisterClassExW(&registration) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) CaptureFailure();
    originalIconic = IsIconic(mainWindow) != FALSE;
    completion = std::move(callback); active = true; finishing = false; shown = false; ready = false; backgroundServed = false;
    pendingResult.reset(); ++generation;
    try {
      overlay = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, OverlayClass, L"PWTools · 战绩截图",
                                WS_POPUP, desktop.left, desktop.top, width, height, nullptr, nullptr,
                                registration.hInstance, this);
      if (!overlay) CaptureFailure();
      if (!originalIconic) ShowWindow(mainWindow, SW_MINIMIZE);
      DwmFlush();
      if (!SetTimer(overlay, StartTimer, CaptureDelayMs, nullptr) || !SetTimer(overlay, ExpiryTimer, CaptureTimeoutMs, nullptr)) CaptureFailure();
    } catch (...) {
      auto error = std::current_exception(); Stop(false, {});
      if (!originalIconic && IsWindow(mainWindow) && restore) restore();
      std::rethrow_exception(error);
    }
  }

  void Resize() {
    if (!controller || !overlay) return;
    RECT client{}; GetClientRect(overlay, &client); CaptureCheck(controller->put_Bounds(client));
  }
  void Post(const json& response) {
    if (view) CaptureCheck(view->PostWebMessageAsJson(Wide(response.dump()).c_str()));
  }
  void QueueCompletion(ScreenCaptureResult result) {
    if (!active || pendingResult) return;
    pendingResult = std::move(result);
    if (!PostMessageW(overlay, CompleteMessage, 0, 0)) Stop(true, std::move(*pendingResult));
  }
  void Stop(bool notify, ScreenCaptureResult result) {
    if (!active && !overlay) return;
    finishing = true; active = false; ++generation;
    auto callback = std::move(completion);
    pendingResult.reset(); std::vector<BYTE>().swap(background); windowBounds.clear();
    if (overlay) { KillTimer(overlay, StartTimer); KillTimer(overlay, ExpiryTimer); }
    if (controller) controller->Close(); view.Reset(); controller.Reset();
    if (overlay) { HWND target = std::exchange(overlay, nullptr); DestroyWindow(target); }
    shown = ready = backgroundServed = false;
    if (notify && IsWindow(mainWindow)) {
      if ((result.png || !originalIconic) && restore) restore();
      if (callback) callback(std::move(result));
    }
  }
  void Fail() { QueueCompletion({std::nullopt, "CAPTURE_FAILED", "截图界面未能载入，请稍后重试。"}); }

  void Message(ICoreWebView2WebMessageReceivedEventArgs* event) {
    LPWSTR source = nullptr; if (FAILED(event->get_Source(&source))) return;
    const bool trusted = source && std::wstring(source) == OverlayUrl; CoTaskMemFree(source);
    if (!trusted || !active || pendingResult) return;
    LPWSTR raw = nullptr; if (FAILED(event->get_WebMessageAsJson(&raw))) return;
    std::wstring encoded = raw ? raw : L""; CoTaskMemFree(raw);
    if (encoded.size() > 18 * 1024 * 1024) return;
    std::string id;
    try {
      const auto request = json::parse(Utf8(encoded));
      if (!request.is_object() || !request.contains("id") || !request["id"].is_string()) return;
      id = request["id"].get<std::string>();
      if (id.empty() || id.size() > 128 || !request.contains("method") || !request["method"].is_string() ||
          !request.contains("args") || !request["args"].is_array()) return;
      const auto method = request["method"].get<std::string>(); const auto& args = request["args"];
      if (method == "captureOverlayReady") {
        if (!args.empty() || backgroundServed || background.empty()) throw ApiFailure("INVALID_INPUT", "截图初始化参数不正确。");
        auto image = Base64(background); std::vector<BYTE>().swap(background); backgroundServed = true;
        auto targets = json::array();
        for (const auto& bounds : windowBounds) targets.push_back({{"x", bounds.left}, {"y", bounds.top},
          {"width", bounds.right - bounds.left}, {"height", bounds.bottom - bounds.top}});
        windowBounds.clear();
        POINT cursor{};
        json pointer = nullptr;
        if (GetCursorPos(&cursor)) pointer = {{"x", cursor.x - desktop.left}, {"y", cursor.y - desktop.top}};
        Post({{"id", id}, {"ok", true}, {"data", {{"content_type", "image/png"}, {"data_base64", std::move(image)},
              {"width", desktop.right - desktop.left}, {"height", desktop.bottom - desktop.top},
              {"windows", std::move(targets)}, {"cursor", std::move(pointer)}}}});
        return;
      }
      if (method == "captureOverlayShow") {
        if (!args.empty() || !backgroundServed || !ready) throw ApiFailure("INVALID_INPUT", "截图界面尚未就绪。");
        shown = true; ShowWindow(overlay, SW_SHOW);
        SetWindowPos(overlay, HWND_TOPMOST, desktop.left, desktop.top, desktop.right - desktop.left, desktop.bottom - desktop.top, SWP_SHOWWINDOW);
        CaptureCheck(controller->put_IsVisible(TRUE)); Resize();
        SetForegroundWindow(overlay); SetFocus(overlay); controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        UpdateWindow(overlay);
        Post({{"id", id}, {"ok", true}, {"data", nullptr}}); return;
      }
      if (method == "captureOverlayCancel") {
        if (!args.empty()) throw ApiFailure("INVALID_INPUT", "截图取消参数不正确。");
        Post({{"id", id}, {"ok", true}, {"data", nullptr}}); QueueCompletion({}); return;
      }
      if (method == "captureOverlayFinish") {
        if (!shown || args.size() != 1 || !args[0].is_object() || args[0].size() != 1 ||
            !args[0].contains("data_base64") || !args[0]["data_base64"].is_string()) throw ApiFailure("INVALID_INPUT", "截图数据不正确。");
        auto png = ValidateCaptureReply(args[0]["data_base64"].get<std::string>());
        Post({{"id", id}, {"ok", true}, {"data", nullptr}});
        QueueCompletion({std::move(png), {}, {}}); return;
      }
      throw ApiFailure("INVALID_INPUT", "截图操作不正确。");
    } catch (const ApiFailure& failure) {
      if (!id.empty()) Post({{"id", id}, {"ok", false}, {"error", {{"code", failure.code}, {"message", failure.what()}}}});
    } catch (...) {
      if (!id.empty()) Post({{"id", id}, {"ok", false}, {"error", {{"code", "CAPTURE_FAILED"}, {"message", "截图未能完成，请重新框选。"}}}});
    }
  }

  void Configure() {
    CaptureCheck(controller->get_CoreWebView2(&view));
    ComPtr<ICoreWebView2Settings> settings; CaptureCheck(view->get_Settings(&settings));
    settings->put_AreHostObjectsAllowed(FALSE); settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreDefaultContextMenusEnabled(FALSE); settings->put_AreDevToolsEnabled(FALSE);
    settings->put_IsZoomControlEnabled(FALSE); settings->put_AreDefaultScriptDialogsEnabled(FALSE);
    ComPtr<ICoreWebView2Settings3> settings3;
    if (SUCCEEDED(settings.As(&settings3))) settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
    ComPtr<ICoreWebView2Controller2> controller2;
    if (SUCCEEDED(controller.As(&controller2))) controller2->put_DefaultBackgroundColor({255, 13, 22, 33});
    // An overlay spanning monitors uses one physical pixel per CSS pixel. It
    // does not change scale when its origin happens to be on another monitor.
    ComPtr<ICoreWebView2Controller3> controller3; CaptureCheck(controller.As(&controller3));
    CaptureCheck(controller3->put_ShouldDetectMonitorScaleChanges(FALSE));
    CaptureCheck(controller3->put_RasterizationScale(1.0)); CaptureCheck(controller->put_ZoomFactor(1.0));
    CaptureCheck(controller->put_IsVisible(TRUE)); Resize();
    const auto weak = weak_from_this(); const auto token = generation;
    EventRegistrationToken registration{};
    CaptureCheck(view->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([weak, token](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
      if (auto state = weak.lock(); state && state->active && state->generation == token) { try { state->Message(args); } catch (...) { state->Fail(); } }
      return S_OK;
    }).Get(), &registration));
    CaptureCheck(view->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
      LPWSTR uri = nullptr; args->get_Uri(&uri); if (!uri || std::wstring(uri) != OverlayUrl) args->put_Cancel(TRUE); CoTaskMemFree(uri); return S_OK;
    }).Get(), &registration));
    CaptureCheck(view->add_FrameNavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT { args->put_Cancel(TRUE); return S_OK; }).Get(), &registration));
    CaptureCheck(view->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT { args->put_Handled(TRUE); return S_OK; }).Get(), &registration));
    CaptureCheck(view->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT { args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY); return S_OK; }).Get(), &registration));
    ComPtr<ICoreWebView2_4> view4;
    if (SUCCEEDED(view.As(&view4))) view4->add_DownloadStarting(Callback<ICoreWebView2DownloadStartingEventHandler>([](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) -> HRESULT { args->put_Cancel(TRUE); return S_OK; }).Get(), &registration);
    CaptureCheck(view->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>([weak, token](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
      if (auto state = weak.lock(); state && state->active && state->generation == token) {
        BOOL success = FALSE; args->get_IsSuccess(&success); if (success) state->ready = true; else state->Fail();
      }
      return S_OK;
    }).Get(), &registration));
    CaptureCheck(view->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>([weak, token](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*) -> HRESULT {
      if (auto state = weak.lock(); state && state->active && state->generation == token) state->Fail(); return S_OK;
    }).Get(), &registration));
    ComPtr<ICoreWebView2_3> view3; CaptureCheck(view.As(&view3));
    CaptureCheck(view3->SetVirtualHostNameToFolderMapping(L"pwtools.local", rendererDirectory.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS));
    CaptureCheck(view->AddWebResourceRequestedFilter(OverlayUrl, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT));
    CaptureCheck(view->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>([weak, token](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
      auto state = weak.lock(); if (!state || !state->active || state->generation != token) return E_ABORT;
      try {
        std::ifstream input(state->rendererDirectory / L"capture.html", std::ios::binary);
        std::string body((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        if (body.empty() || body.size() > 1024 * 1024) return E_FAIL;
        ComPtr<IStream> stream; stream.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(body.data()), static_cast<UINT>(body.size())));
        if (!stream) return E_OUTOFMEMORY;
        ComPtr<ICoreWebView2WebResourceResponse> response;
        std::wstring headers = L"Content-Type: text/html; charset=utf-8\r\nContent-Security-Policy: "; headers += ContentSecurityPolicy;
        headers += L"\r\nX-Content-Type-Options: nosniff\r\n";
        const HRESULT status = state->environment->CreateWebResourceResponse(stream.Get(), 200, L"OK", headers.c_str(), &response);
        if (FAILED(status)) return status; return args->put_Response(response.Get());
      } catch (...) { return E_FAIL; }
    }).Get(), &registration));
    CaptureCheck(view->Navigate(OverlayUrl));
  }

  void Initialize() {
    DwmFlush();
    windowBounds = testPattern ? std::vector<RECT>{} : SnapshotWindowBounds(desktop);
    background = FreezeDesktop(desktop, testPattern);
    const auto weak = weak_from_this(); const auto token = generation;
    const HRESULT status = environment->CreateCoreWebView2Controller(overlay,
        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([weak, token](HRESULT result, ICoreWebView2Controller* created) -> HRESULT {
          auto state = weak.lock();
          if (!state || !state->active || state->generation != token) { if (created) created->Close(); return S_OK; }
          if (FAILED(result) || !created) { state->Fail(); return S_OK; }
          state->controller = created;
          try { state->Configure(); } catch (...) { state->Fail(); }
          return S_OK;
        }).Get());
    if (FAILED(status)) Fail();
  }

  static LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    auto* state = reinterpret_cast<State*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_NCCREATE) {
      state = static_cast<State*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams);
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(state));
    }
    if (!state) return DefWindowProcW(window, message, wParam, lParam);
    // A completion callback may release the module. Keep this dispatch alive.
    const auto lifetime = state->shared_from_this();
    switch (message) {
      case WM_TIMER:
        if (wParam == ExpiryTimer) { state->QueueCompletion({}); return 0; }
        if (wParam == StartTimer) {
          KillTimer(window, StartTimer);
          try { state->Initialize(); }
          catch (const ApiFailure& failure) { state->QueueCompletion({std::nullopt, failure.code, failure.what()}); }
          catch (...) { state->QueueCompletion({std::nullopt, "CAPTURE_FAILED", "无法截取当前屏幕，请稍后重试。"}); }
          return 0;
        }
        break;
      case CompleteMessage:
        if (state->pendingResult) { auto result = std::move(*state->pendingResult); state->Stop(true, std::move(result)); }
        return 0;
      case WM_SIZE: try { state->Resize(); } catch (...) { state->Fail(); } return 0;
      case WM_DPICHANGED: return 0;
      case WM_DISPLAYCHANGE: if (state->active) state->QueueCompletion({}); return 0;
      case WM_KEYDOWN:
      case WM_SYSKEYDOWN: if (wParam == VK_ESCAPE) { state->QueueCompletion({}); return 0; } break;
      case WM_ACTIVATE:
        if (LOWORD(wParam) == WA_INACTIVE && state->shown && !state->finishing) state->QueueCompletion({});
        return 0;
      case WM_CLOSE: state->QueueCompletion({}); return 0;
      case WM_DESTROY:
        if (!state->finishing && state->overlay == window) { state->overlay = nullptr; state->Stop(true, {}); }
        return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
  }
};

ScreenCapture::ScreenCapture(HWND mainWindow, ICoreWebView2Environment* environment, const std::filesystem::path& rendererDirectory,
                             bool testPattern, Restore restore)
    : state_(std::make_shared<State>(mainWindow, environment, rendererDirectory, testPattern, std::move(restore))) {}
ScreenCapture::~ScreenCapture() { state_->Stop(false, {}); }
void ScreenCapture::Start(Completion completion) { state_->Start(std::move(completion)); }
void ScreenCapture::Cancel() { state_->Stop(false, {}); }
bool ScreenCapture::Active() const { return state_->active; }
HWND ScreenCapture::Overlay() const { return state_->overlay; }
RECT ScreenCapture::DesktopBounds() const { return state_->desktop; }
bool ScreenCapture::OriginalIconic() const { return state_->originalIconic; }
bool ScreenCapture::TestPattern() const { return state_->testPattern; }
bool ScreenCapture::Shown() const { return state_->shown; }
bool ScreenCapture::Ready() const { return state_->ready; }

} // namespace pwtools
