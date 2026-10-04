#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <wrl.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include <nlohmann/json.hpp>
#include "api_bridge.hpp"
#include "config.hpp"
#include <algorithm>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {
constexpr UINT ReplyMessage = WM_APP + 1;
constexpr UINT ForceCloseMessage = WM_APP + 2;
constexpr wchar_t WindowClass[] = L"PWToolsWebView2";
constexpr wchar_t ProductionUrl[] = L"https://pwtools.local/index.html";
constexpr wchar_t ContentSecurityPolicy[] = L"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-src 'none'";

std::wstring Wide(const std::string& value) {
  if (value.empty()) return {};
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (!size) throw std::runtime_error("invalid UTF-8");
  std::wstring result(size, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size);
  return result;
}

std::string Utf8(const std::wstring& value) {
  if (value.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (!size) throw std::runtime_error("invalid UTF-16");
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}

std::wstring Environment(const wchar_t* name) {
  DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
  if (!size) return {};
  std::wstring result(size, L'\0');
  DWORD copied = GetEnvironmentVariableW(name, result.data(), size);
  if (!copied || copied >= size) return {};
  result.resize(copied);
  return result;
}

fs::path ExecutableDirectory() {
  std::wstring path(32768, L'\0');
  DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (!size || size >= path.size()) throw std::runtime_error("executable path");
  path.resize(size);
  return fs::path(path).parent_path();
}

fs::path DataDirectory() {
  const auto overridePath = Environment(L"PWTOOLS_DATA_DIR");
  if (!overridePath.empty()) return fs::absolute(overridePath);
  PWSTR path = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, KF_FLAG_CREATE, nullptr, &path))) throw std::runtime_error("application data");
  fs::path result = fs::path(path) / L"PWTools";
  CoTaskMemFree(path);
  return result;
}

void Check(HRESULT result) {
  if (FAILED(result)) throw std::runtime_error("WebView2 operation failed");
}

RECT CenteredWindowBounds(const RECT& workArea, UINT dpi) {
  const int workWidth = workArea.right - workArea.left;
  const int workHeight = workArea.bottom - workArea.top;
  const int width = std::min(MulDiv(1320, dpi, 96), workWidth);
  const int height = std::min(MulDiv(880, dpi, 96), workHeight);
  const int left = workArea.left + (workWidth - width) / 2;
  const int top = workArea.top + (workHeight - height) / 2;
  return {left, top, left + width, top + height};
}

class Host {
 public:
  HWND window = nullptr;
  bool forceClose = false;
  bool ready = false;
  bool debug = false;
  ComPtr<ICoreWebView2Environment> environment;
  ComPtr<ICoreWebView2Controller> controller;
  ComPtr<ICoreWebView2> view;
  std::shared_ptr<pwtools::ApiBridge> api;
  std::shared_ptr<std::atomic<unsigned>> requests = std::make_shared<std::atomic<unsigned>>(0);
  std::wstring pageUrl = ProductionUrl;
  fs::path dataDir;
  fs::path rendererDir;

  void Resize() {
    if (!controller) return;
    RECT bounds{};
    GetClientRect(window, &bounds);
    controller->put_Bounds(bounds);
  }

  void Post(const json& value) {
    if (view) view->PostWebMessageAsJson(Wide(value.dump()).c_str());
  }

  void CloseRequested() {
    if (forceClose || !ready || !view) { DestroyWindow(window); return; }
    Post({{"event", "close-requested"}});
  }

  void Message(ICoreWebView2WebMessageReceivedEventArgs* event) {
    LPWSTR source = nullptr;
    if (FAILED(event->get_Source(&source))) return;
    const bool trusted = source && pageUrl == source;
    CoTaskMemFree(source);
    if (!trusted) return;
    LPWSTR raw = nullptr;
    if (FAILED(event->get_WebMessageAsJson(&raw))) return;
    std::wstring encoded = raw ? raw : L"";
    CoTaskMemFree(raw);
    if (encoded.size() > 18 * 1024 * 1024) return;
    std::string id;
    try {
      const auto request = json::parse(Utf8(encoded));
      if (!request.is_object() || !request.contains("id") || !request["id"].is_string()) return;
      id = request["id"].get<std::string>();
      if (id.empty() || id.size() > 128 || !request.contains("method") || !request["method"].is_string() || !request.contains("args") || !request["args"].is_array() || request["args"].size() > 8) return;
      const std::string method = request["method"].get<std::string>();
      const json args = request["args"];
      if (method == "appInfo") {
        Post({{"id", id}, {"ok", true}, {"data", {{"version", PWTOOLS_VERSION}, {"apiUrl", api->ApiUrl()}, {"persistentSession", api->PersistentSession()}, {"runtime", "webview2"}}}});
        return;
      }
      if (method == "windowControl") {
        if (args.size() != 1 || !args[0].is_string()) throw pwtools::ApiFailure("INVALID_INPUT", "窗口操作不正确。");
        const auto action = args[0].get<std::string>();
        if (action == "minimize") ShowWindow(window, SW_MINIMIZE);
        else if (action == "maximize") ShowWindow(window, IsZoomed(window) ? SW_RESTORE : SW_MAXIMIZE);
        else if (action == "close") { forceClose = true; PostMessageW(window, ForceCloseMessage, 0, 0); }
        else throw pwtools::ApiFailure("INVALID_INPUT", "窗口操作不正确。");
        Post({{"id", id}, {"ok", true}, {"data", nullptr}});
        return;
      }
      if (method == "windowDrag") {
        Post({{"id", id}, {"ok", true}, {"data", nullptr}});
        ReleaseCapture();
        SendMessageW(window, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        return;
      }
      if (debug && method == "test:request-close") {
        PostMessageW(window, WM_CLOSE, 0, 0);
        Post({{"id", id}, {"ok", true}, {"data", nullptr}});
        return;
      }
      if (debug && method == "test:window-size") {
        if (args.size() != 2 || !args[0].is_number_integer() || !args[1].is_number_integer()) throw pwtools::ApiFailure("INVALID_INPUT", "窗口尺寸不正确。");
        const int width = args[0].get<int>(), height = args[1].get<int>();
        if (width < 960 || height < 640 || width > 3840 || height > 2160) throw pwtools::ApiFailure("INVALID_INPUT", "窗口尺寸不正确。");
        const auto dpi = GetDpiForWindow(window);
        SetWindowPos(window, nullptr, 0, 0, MulDiv(width, dpi, 96), MulDiv(height, dpi, 96), SWP_NOMOVE | SWP_NOZORDER);
        Post({{"id", id}, {"ok", true}, {"data", nullptr}});
        return;
      }
      if (requests->fetch_add(1) >= 12) {
        --*requests;
        throw pwtools::ApiFailure("BUSY", "操作较多，请稍后重试。");
      }
      auto target = window;
      auto module = api;
      auto active = requests;
      std::thread([target, module, active, id, method, args] {
        json response;
        try { response = {{"id", id}, {"ok", true}, {"data", module->Execute(method, args)}}; }
        catch (const pwtools::ApiFailure& failure) { response = {{"id", id}, {"ok", false}, {"error", {{"code", failure.code}, {"message", failure.what()}}}}; }
        catch (...) { response = {{"id", id}, {"ok", false}, {"error", {{"code", "INTERNAL_ERROR"}, {"message", "操作未完成，请稍后重试。"}}}}; }
        --*active;
        auto reply = std::make_unique<std::string>(response.dump());
        if (PostMessageW(target, ReplyMessage, 0, reinterpret_cast<LPARAM>(reply.get()))) reply.release();
      }).detach();
    } catch (const pwtools::ApiFailure& failure) {
      if (!id.empty()) Post({{"id", id}, {"ok", false}, {"error", {{"code", failure.code}, {"message", failure.what()}}}});
    } catch (...) {
      if (!id.empty()) Post({{"id", id}, {"ok", false}, {"error", {{"code", "INVALID_INPUT"}, {"message", "请求参数不正确。"}}}});
    }
  }

  void Configure() {
    ComPtr<ICoreWebView2Settings> settings;
    Check(view->get_Settings(&settings));
    settings->put_AreHostObjectsAllowed(FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreDefaultContextMenusEnabled(FALSE);
    settings->put_AreDevToolsEnabled(debug || pageUrl != ProductionUrl);
    settings->put_IsZoomControlEnabled(FALSE);
    settings->put_AreDefaultScriptDialogsEnabled(FALSE);
    ComPtr<ICoreWebView2Settings3> settings3;
    if (SUCCEEDED(settings.As(&settings3))) settings3->put_AreBrowserAcceleratorKeysEnabled(pageUrl == ProductionUrl ? FALSE : TRUE);
    ComPtr<ICoreWebView2Settings4> settings4;
    if (SUCCEEDED(settings.As(&settings4))) {
      settings4->put_IsGeneralAutofillEnabled(FALSE);
      settings4->put_IsPasswordAutosaveEnabled(FALSE);
    }
    ComPtr<ICoreWebView2Controller2> controller2;
    if (SUCCEEDED(controller.As(&controller2))) controller2->put_DefaultBackgroundColor({255, 13, 22, 33});
    Check(controller->put_IsVisible(IsIconic(window) ? FALSE : TRUE));
    EventRegistrationToken registration{};
    Check(view->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>([this](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
      COREWEBVIEW2_PROCESS_FAILED_KIND kind{};
      if (SUCCEEDED(args->get_ProcessFailedKind(&kind)) &&
          (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED)) {
        ready = false;
      }
      return S_OK;
    }).Get(), &registration));
    Check(view->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT { Message(args); return S_OK; }).Get(), &registration));
    Check(view->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([this](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
      LPWSTR uri = nullptr;
      args->get_Uri(&uri);
      if (!uri || pageUrl != uri) args->put_Cancel(TRUE);
      CoTaskMemFree(uri);
      return S_OK;
    }).Get(), &registration));
    Check(view->add_FrameNavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT { args->put_Cancel(TRUE); return S_OK; }).Get(), &registration));
    Check(view->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT { args->put_Handled(TRUE); return S_OK; }).Get(), &registration));
    Check(view->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
      args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);
      return S_OK;
    }).Get(), &registration));
    ComPtr<ICoreWebView2_4> view4;
    if (SUCCEEDED(view.As(&view4))) view4->add_DownloadStarting(Callback<ICoreWebView2DownloadStartingEventHandler>([](ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) -> HRESULT { args->put_Cancel(TRUE); return S_OK; }).Get(), &registration);
    Check(view->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>([this](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT {
      BOOL success = FALSE;
      args->get_IsSuccess(&success);
      if (success) { ready = true; }
      else if (!ready) { MessageBoxW(window, L"界面未能载入，请重新安装 PWTools。", L"PWTools", MB_ICONERROR); forceClose = true; PostMessageW(window, WM_CLOSE, 0, 0); }
      return S_OK;
    }).Get(), &registration));
    if (pageUrl == ProductionUrl) {
      ComPtr<ICoreWebView2_3> view3;
      Check(view.As(&view3));
      Check(view3->SetVirtualHostNameToFolderMapping(L"pwtools.local", rendererDir.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS));
      Check(view->AddWebResourceRequestedFilter(ProductionUrl, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT));
      Check(view->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>([this](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
        std::ifstream input(rendererDir / L"index.html", std::ios::binary);
        std::string body((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        if (body.empty() || body.size() > 1024 * 1024) return E_FAIL;
        ComPtr<IStream> stream;
        stream.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(body.data()), static_cast<UINT>(body.size())));
        if (!stream) return E_OUTOFMEMORY;
        ComPtr<ICoreWebView2WebResourceResponse> response;
        std::wstring headers = L"Content-Type: text/html; charset=utf-8\r\nContent-Security-Policy: ";
        headers += ContentSecurityPolicy;
        headers += L"\r\nX-Content-Type-Options: nosniff\r\n";
        const auto result = environment->CreateWebResourceResponse(stream.Get(), 200, L"OK", headers.c_str(), &response);
        if (FAILED(result)) return result;
        return args->put_Response(response.Get());
      }).Get(), &registration));
    }
    Resize();
    Check(view->Navigate(pageUrl.c_str()));
  }

  void Start() {
    rendererDir = ExecutableDirectory() / L"renderer";
    dataDir = DataDirectory();
    fs::create_directories(dataDir);
    const auto configuredApi = Environment(L"PWTOOLS_API_URL");
    api = std::make_shared<pwtools::ApiBridge>(configuredApi.empty() ? PWTOOLS_DEFAULT_API_URL : Utf8(configuredApi), dataDir);
    const auto dev = Environment(L"PWTOOLS_DEV_URL");
    if (!dev.empty()) {
      if (dev != L"http://localhost:5173" && dev != L"http://localhost:5173/" && dev != L"http://127.0.0.1:5173" && dev != L"http://127.0.0.1:5173/") throw std::runtime_error("invalid development URL");
      pageUrl = dev.back() == L'/' ? dev : dev + L'/';
    } else if (!fs::is_regular_file(rendererDir / L"index.html")) throw std::runtime_error("missing renderer");
    auto options = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
    const auto port = Environment(L"PWTOOLS_DEBUG_PORT");
    if (!port.empty() && port.size() <= 5 && port.find_first_not_of(L"0123456789") == std::wstring::npos && std::stoi(port) >= 1024 && std::stoi(port) <= 65535) {
      debug = true;
      Check(options->put_AdditionalBrowserArguments((L"--remote-debugging-port=" + port).c_str()));
    }
    Check(options->put_Language(L"zh-CN"));
    auto cache = dataDir / L"WebView2";
    Check(CreateCoreWebView2EnvironmentWithOptions(nullptr, cache.c_str(), options.Get(), Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([this](HRESULT result, ICoreWebView2Environment* created) -> HRESULT {
      if (FAILED(result) || !created) { FailRuntime(); return S_OK; }
      environment = created;
      HRESULT controllerResult = environment->CreateCoreWebView2Controller(window, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([this](HRESULT controllerStatus, ICoreWebView2Controller* createdController) -> HRESULT {
        if (FAILED(controllerStatus) || !createdController) { FailRuntime(); return S_OK; }
        controller = createdController;
        try { Check(controller->get_CoreWebView2(&view)); Configure(); }
        catch (...) { FailRuntime(); }
        return S_OK;
      }).Get());
      if (FAILED(controllerResult)) FailRuntime();
      return S_OK;
    }).Get()));
  }

  void FailRuntime() {
    MessageBoxW(window, L"无法启动 WebView2。请重新运行 PWTools 安装程序，检查或安装运行时。", L"PWTools", MB_ICONERROR);
    forceClose = true;
    PostMessageW(window, WM_CLOSE, 0, 0);
  }
};

LRESULT CALLBACK WindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  auto* host = reinterpret_cast<Host*>(GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    host = static_cast<Host*>(reinterpret_cast<CREATESTRUCTW*>(lParam)->lpCreateParams);
    host->window = window;
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(host));
  }
  if (!host) return DefWindowProcW(window, message, wParam, lParam);
  switch (message) {
    case WM_NCCALCSIZE: return 0;
    case WM_NCHITTEST: {
      if (IsZoomed(window)) break;
      RECT bounds{};
      GetWindowRect(window, &bounds);
      const int border = MulDiv(7, GetDpiForWindow(window), 96);
      const int x = GET_X_LPARAM(lParam), y = GET_Y_LPARAM(lParam);
      const bool left = x < bounds.left + border, right = x >= bounds.right - border;
      const bool top = y < bounds.top + border, bottom = y >= bounds.bottom - border;
      if (top && left) return HTTOPLEFT;
      if (top && right) return HTTOPRIGHT;
      if (bottom && left) return HTBOTTOMLEFT;
      if (bottom && right) return HTBOTTOMRIGHT;
      if (left) return HTLEFT;
      if (right) return HTRIGHT;
      if (top) return HTTOP;
      if (bottom) return HTBOTTOM;
      break;
    }
    case WM_SIZE:
      if (host->controller) host->controller->put_IsVisible(wParam == SIZE_MINIMIZED ? FALSE : TRUE);
      if (wParam != SIZE_MINIMIZED) host->Resize();
      return 0;
    case WM_DPICHANGED: {
      const RECT* bounds = reinterpret_cast<RECT*>(lParam);
      SetWindowPos(window, nullptr, bounds->left, bounds->top, bounds->right - bounds->left, bounds->bottom - bounds->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_GETMINMAXINFO: {
      auto* limits = reinterpret_cast<MINMAXINFO*>(lParam);
      const UINT dpi = GetDpiForWindow(window);
      limits->ptMinTrackSize = {MulDiv(960, dpi, 96), MulDiv(640, dpi, 96)};
      MONITORINFO monitor{sizeof(MONITORINFO)};
      if (GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor)) {
        // Small work areas must also fit at launch, even at a high DPI scale.
        limits->ptMinTrackSize.x = std::min(limits->ptMinTrackSize.x, monitor.rcWork.right - monitor.rcWork.left);
        limits->ptMinTrackSize.y = std::min(limits->ptMinTrackSize.y, monitor.rcWork.bottom - monitor.rcWork.top);
        limits->ptMaxPosition = {monitor.rcWork.left - monitor.rcMonitor.left, monitor.rcWork.top - monitor.rcMonitor.top};
        limits->ptMaxSize = {monitor.rcWork.right - monitor.rcWork.left, monitor.rcWork.bottom - monitor.rcWork.top};
      }
      return 0;
    }
    case WM_CLOSE: host->CloseRequested(); return 0;
    case ForceCloseMessage: host->forceClose = true; DestroyWindow(window); return 0;
    case ReplyMessage: {
      std::unique_ptr<std::string> reply(reinterpret_cast<std::string*>(lParam));
      if (host->view) host->view->PostWebMessageAsJson(Wide(*reply).c_str());
      return 0;
    }
    case WM_DESTROY:
      if (host->controller) host->controller->Close();
      host->view.Reset(); host->controller.Reset(); host->environment.Reset();
      PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
  HANDLE mutex = nullptr;
  int result = 1;
  try {
    // Independent test profiles remain independent; normal launches focus the existing window.
    const auto data = DataDirectory().wstring();
    const auto mutexName = L"Local\\PWToolsNative-" + std::to_wstring(std::hash<std::wstring>{}(data));
    mutex = CreateMutexW(nullptr, FALSE, mutexName.c_str());
    if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
      HWND existing = FindWindowW(WindowClass, nullptr);
      if (existing) { ShowWindow(existing, IsIconic(existing) ? SW_RESTORE : SW_SHOW); SetForegroundWindow(existing); }
      CloseHandle(mutex); CoUninitialize(); return 0;
    }
    WNDCLASSEXW registration{sizeof(WNDCLASSEXW)};
    registration.lpfnWndProc = WindowProcedure;
    registration.hInstance = instance;
    registration.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    registration.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
    registration.hIconSm = registration.hIcon;
    registration.hbrBackground = CreateSolidBrush(RGB(13, 22, 33));
    registration.lpszClassName = WindowClass;
    Check(RegisterClassExW(&registration) ? S_OK : E_FAIL);
    Host host;
    POINT cursor{};
    const HMONITOR startupMonitor = GetCursorPos(&cursor)
        ? MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST)
        : MonitorFromWindow(nullptr, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO monitor{sizeof(MONITORINFO)};
    if (!GetMonitorInfoW(startupMonitor, &monitor)) throw std::runtime_error("startup monitor");
    auto bounds = CenteredWindowBounds(monitor.rcWork, GetDpiForSystem());
    HWND window = CreateWindowExW(0, WindowClass, L"PWTools · 老板账本", WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_CLIPCHILDREN, bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, nullptr, nullptr, instance, &host);
    if (!window) throw std::runtime_error("window creation");
    // Query this monitor's DPI after creation, while the window is still hidden.
    // Its first visible frame is centered and sized within the taskbar work area.
    bounds = CenteredWindowBounds(monitor.rcWork, GetDpiForWindow(window));
    if (!SetWindowPos(window, nullptr, bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top, SWP_NOZORDER | SWP_NOACTIVATE)) throw std::runtime_error("startup window placement");
    const DWORD corner = 2;
    DwmSetWindowAttribute(window, 33, &corner, sizeof(corner));
    // Create WebView2 in a visible parent. Navigating in a hidden parent and
    // showing it only at NavigationCompleted can leave the native surface blank.
    ShowWindow(window, showCommand);
    UpdateWindow(window);
    host.Start();
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    result = 0;
  } catch (...) {
    MessageBoxW(nullptr, L"PWTools 未能启动，请检查安装文件和后端地址后重试。", L"PWTools", MB_ICONERROR);
  }
  if (mutex) CloseHandle(mutex);
  CoUninitialize();
  return result;
}
