#pragma once

#include <windows.h>
#include <functional>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

struct ICoreWebView2Environment;

namespace pwtools {

// These production seams can be exercised with synthetic pixels, without
// reading the desktop, accessing the clipboard or opening a capture window.
std::vector<BYTE> EncodeCaptureBackground(HBITMAP bitmap);
std::vector<BYTE> ValidateCaptureReply(const std::string& base64);
// Convert physical screen coordinates to the frozen desktop's local pixels.
std::optional<RECT> ClipCaptureWindowBounds(const RECT& window, const RECT& desktop);

struct ScreenCaptureResult {
  std::optional<std::vector<BYTE>> png;
  std::string errorCode;
  std::string errorMessage;
};

class ScreenCapture final {
 public:
  using Completion = std::function<void(ScreenCaptureResult)>;
  using Restore = std::function<void()>;

  ScreenCapture(HWND mainWindow, ICoreWebView2Environment* environment,
                const std::filesystem::path& rendererDirectory, bool testPattern, Restore restore);
  ~ScreenCapture();
  ScreenCapture(const ScreenCapture&) = delete;
  ScreenCapture& operator=(const ScreenCapture&) = delete;

  // Starts an asynchronous selection. Completion runs on the owning UI thread.
  // A second start fails with BUSY. Cancel tears down without calling completion.
  void Start(Completion completion);
  void Cancel();
  bool Active() const;
  HWND Overlay() const;
  RECT DesktopBounds() const;
  bool OriginalIconic() const;
  bool TestPattern() const;
  bool Shown() const;
  bool Ready() const;

 private:
  class State;
  std::shared_ptr<State> state_;
};

} // namespace pwtools
