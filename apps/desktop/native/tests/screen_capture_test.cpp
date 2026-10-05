#include <windows.h>
#include <wincrypt.h>
#include <wincodec.h>
#include <wrl.h>
#include "screen_capture.hpp"
#include "api_bridge.hpp"
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace {
void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
void Check(HRESULT result) { Require(SUCCEEDED(result), "WIC fixture operation failed"); }
class Bitmap {
 public:
  HBITMAP handle = nullptr;
  BYTE* pixels = nullptr;
  Bitmap(LONG width, LONG height, bool noise = false) {
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER); info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    void* buffer = nullptr; handle = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &buffer, nullptr, 0);
    Require(handle && buffer, "fixture bitmap creation failed"); pixels = static_cast<BYTE*>(buffer);
    DWORD state = 0x624329ba;
    for (size_t index = 0; index < static_cast<size_t>(width) * height; ++index) {
      BYTE* pixel = pixels + index * 4;
      for (size_t channel = 0; channel < 3; ++channel) {
        state ^= state << 13; state ^= state >> 17; state ^= state << 5;
        pixel[channel] = noise ? static_cast<BYTE>(state) : static_cast<BYTE>(30 - channel * 10);
      }
      pixel[3] = 0; // A GDI desktop capture's alpha is unspecified and must be ignored.
    }
  }
  ~Bitmap() { if (handle) DeleteObject(handle); }
  Bitmap(const Bitmap&) = delete;
  Bitmap& operator=(const Bitmap&) = delete;
};
std::string Base64(const std::vector<BYTE>& bytes) {
  DWORD count = 0;
  Require(CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &count) != FALSE, "base64 sizing failed");
  std::string output(count, '\0');
  Require(CryptBinaryToStringA(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, output.data(), &count) != FALSE, "base64 encoding failed");
  output.resize(count); if (!output.empty() && output.back() == '\0') output.pop_back(); return output;
}
void AssertPng(const std::vector<BYTE>& bytes, UINT expectedWidth, UINT expectedHeight) {
  ComPtr<IWICImagingFactory> factory;
  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapDecoder> decoder;
  ComPtr<IWICBitmapFrameDecode> frame;
  ComPtr<IWICFormatConverter> converter;
  Check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
  Check(factory->CreateStream(&stream)); auto copy = bytes;
  Check(stream->InitializeFromMemory(copy.data(), static_cast<DWORD>(copy.size())));
  Check(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand, &decoder));
  GUID format{}; Check(decoder->GetContainerFormat(&format)); Require(format == GUID_ContainerFormatPng, "background must be PNG");
  Check(decoder->GetFrame(0, &frame)); UINT width = 0, height = 0; Check(frame->GetSize(&width, &height));
  Require(width == expectedWidth && height == expectedHeight, "background dimensions changed");
  Check(factory->CreateFormatConverter(&converter));
  Check(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  BYTE pixel[4]{}; WICRect first{0, 0, 1, 1}; Check(converter->CopyPixels(&first, 4, sizeof(pixel), pixel));
  Require(pixel[0] == 10 && pixel[1] == 20 && pixel[2] == 30 && pixel[3] == 255, "background must preserve opaque colors");
}
template<class Function> void Failure(const char* code, Function&& function) {
  try { function(); }
  catch (const pwtools::ApiFailure& error) {
    Require(error.code == code, "unexpected capture error code");
    Require(std::string(error.what()).find("剪贴板") == std::string::npos, "capture errors must not mention clipboard"); return;
  }
  throw std::runtime_error("invalid capture accepted");
}
} // namespace

int main() {
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
  try {
    const RECT desktop{-1600, -200, 1920, 1080};
    const auto clipped = pwtools::ClipCaptureWindowBounds({-1700, -300, -600, 600}, desktop);
    Require(clipped && clipped->left == 0 && clipped->top == 0 && clipped->right == 1000 && clipped->bottom == 800,
            "window snapping must clip and translate negative monitor coordinates");
    const auto spanning = pwtools::ClipCaptureWindowBounds({-100, 100, 900, 700}, desktop);
    Require(spanning && spanning->left == 1500 && spanning->top == 300 && spanning->right == 2500 && spanning->bottom == 900,
            "window snapping must retain windows across monitor boundaries");
    Require(!pwtools::ClipCaptureWindowBounds({1920, 0, 2000, 100}, desktop), "off-screen windows must not snap");
    Bitmap sample(4, 3);
    const auto png = pwtools::EncodeCaptureBackground(sample.handle);
    AssertPng(png, 4, 3);
    Require(pwtools::ValidateCaptureReply(Base64(png)) == png, "final capture bytes must preserve their original identity");
    for (const std::string value : {"", "A", "AA%=" , "AAA=\r\n", "A===", "AA=A", "AAAA"}) {
      Failure("INVALID_IMAGE", [&] { pwtools::ValidateCaptureReply(value); });
    }
    auto broken = png; broken.resize(png.size() / 2);
    Failure("INVALID_IMAGE", [&] { pwtools::ValidateCaptureReply(Base64(broken)); });
    Failure("IMAGE_TOO_LARGE", [] { pwtools::ValidateCaptureReply(std::string((12 * 1024 * 1024 / 3) * 4 + 4, 'A')); });
    Failure("CAPTURE_FAILED", [] { pwtools::EncodeCaptureBackground(nullptr); });
    Bitmap tooWide(32001, 1);
    Failure("CAPTURE_UNAVAILABLE", [&] { pwtools::EncodeCaptureBackground(tooWide.handle); });
    Bitmap allowedBackground(16001, 1);
    const auto wide = pwtools::EncodeCaptureBackground(allowedBackground.handle);
    AssertPng(wide, 16001, 1);
    Failure("IMAGE_TOO_LARGE", [&] { pwtools::ValidateCaptureReply(Base64(wide)); });
    // A detailed multi-monitor background may exceed the final file budget,
    // while users can still select a small region within it.
    Bitmap detailedBackground(3000, 2000, true);
    const auto detailed = pwtools::EncodeCaptureBackground(detailedBackground.handle);
    Require(detailed.size() > 12 * 1024 * 1024 && detailed.size() < 64 * 1024 * 1024, "background must use its separate encoding budget");
    Failure("IMAGE_TOO_LARGE", [&] { pwtools::ValidateCaptureReply(Base64(detailed)); });
    std::cout << "screen capture fixtures passed: opaque BGRA background, bounded PNG, independent background/final budgets, canonical base64, original PNG identity (no screen or clipboard access)\n";
    CoUninitialize(); return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; CoUninitialize(); return 1;
  }
}
