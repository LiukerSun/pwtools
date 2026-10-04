#include <windows.h>
#include <wincodec.h>
#include <wrl.h>
#include "clipboard_image.hpp"
#include "api_bridge.hpp"
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace {
void Require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
void Check(HRESULT result) { Require(SUCCEEDED(result), "WIC fixture operation failed"); }
std::vector<BYTE> Dib(LONG width, LONG height, bool v5 = false) {
  const size_t stride = (static_cast<size_t>(width) * 3 + 3) & ~size_t(3);
  const auto headerSize = v5 ? sizeof(BITMAPV5HEADER) : sizeof(BITMAPINFOHEADER);
  std::vector<BYTE> bytes(headerSize + stride * static_cast<size_t>(height < 0 ? -height : height));
  BITMAPV5HEADER header{};
  header.bV5Size = static_cast<DWORD>(headerSize); header.bV5Width = width; header.bV5Height = height;
  header.bV5Planes = 1; header.bV5BitCount = 24; header.bV5Compression = BI_RGB; header.bV5CSType = LCS_sRGB;
  std::memcpy(bytes.data(), &header, headerSize);
  for (size_t index = headerSize; index < bytes.size(); ++index) bytes[index] = static_cast<BYTE>((index - headerSize) % 3 == 0 ? 30 : ((index - headerSize) % 3 == 1 ? 20 : 10));
  return bytes;
}
void AssertPng(const std::vector<BYTE>& bytes, UINT width, UINT height) {
  Require(bytes.size() >= 8 && bytes[0] == 137 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G', "output must be PNG");
  ComPtr<IWICImagingFactory> factory;
  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapDecoder> decoder;
  ComPtr<IWICBitmapFrameDecode> frame;
  ComPtr<IWICFormatConverter> converter;
  Check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
  Check(factory->CreateStream(&stream));
  auto copy = bytes;
  Check(stream->InitializeFromMemory(copy.data(), static_cast<DWORD>(copy.size())));
  Check(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand, &decoder));
  Check(decoder->GetFrame(0, &frame));
  UINT decodedWidth = 0, decodedHeight = 0;
  Check(frame->GetSize(&decodedWidth, &decodedHeight));
  Require(decodedWidth == width && decodedHeight == height, "PNG dimensions changed");
  Check(factory->CreateFormatConverter(&converter));
  Check(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  WICRect first{0, 0, 1, 1};
  BYTE pixel[4]{};
  Check(converter->CopyPixels(&first, 4, sizeof(pixel), pixel));
  Require(pixel[0] == 10 && pixel[1] == 20 && pixel[2] == 30 && pixel[3] == 255, "PNG colors changed");
}
template<class Function> void Failure(const char* code, Function&& function) {
  try { function(); }
  catch (const pwtools::ApiFailure& error) { Require(error.code == code, "unexpected image error code"); return; }
  throw std::runtime_error("malformed/oversized image accepted");
}
void HeaderField(std::vector<BYTE>& bytes, size_t offset, DWORD value) { std::memcpy(bytes.data() + offset, &value, sizeof(value)); }
} // namespace

int main() {
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
  try {
    auto rgb = Dib(4, 3);
    auto png = pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, rgb);
    AssertPng(png, 4, 3);
    const auto unchanged = pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Png, png);
    Require(unchanged == png, "a valid PNG must preserve its original bytes and identity");
    AssertPng(unchanged, 4, 3);
    AssertPng(pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, Dib(4, -3, true)), 4, 3);
    // A common 4K clipboard DIB is larger than the compressed 12 MiB file limit.
    auto fourK = Dib(3840, 2160);
    Require(fourK.size() > 12 * 1024 * 1024, "4K fixture must exceed encoded file budget");
    AssertPng(pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, fourK), 3840, 2160);
    Failure("INVALID_IMAGE", [] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, {1, 2, 3}); });
    Failure("INVALID_IMAGE", [] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Png, {1, 2, 3}); });
    auto brokenPng = png; brokenPng.resize(brokenPng.size() / 2);
    Failure("INVALID_IMAGE", [&] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Png, brokenPng); });
    auto truncated = rgb; truncated.pop_back();
    Failure("INVALID_IMAGE", [&] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, truncated); });
    auto invalid = rgb; HeaderField(invalid, offsetof(BITMAPINFOHEADER, biHeight), 0);
    Failure("INVALID_IMAGE", [&] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, invalid); });
    invalid = rgb; HeaderField(invalid, offsetof(BITMAPINFOHEADER, biCompression), BI_RLE8);
    Failure("INVALID_IMAGE", [&] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, invalid); });
    invalid = rgb; HeaderField(invalid, offsetof(BITMAPINFOHEADER, biClrUsed), 0xffffffff);
    Failure("INVALID_IMAGE", [&] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, invalid); });
    invalid = rgb; HeaderField(invalid, offsetof(BITMAPINFOHEADER, biWidth), 16001);
    Failure("IMAGE_TOO_LARGE", [&] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, invalid); });
    invalid = rgb; HeaderField(invalid, offsetof(BITMAPINFOHEADER, biWidth), 10000); HeaderField(invalid, offsetof(BITMAPINFOHEADER, biHeight), 5000);
    Failure("IMAGE_TOO_LARGE", [&] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, invalid); });
    Failure("IMAGE_TOO_LARGE", [] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Png, std::vector<BYTE>(12 * 1024 * 1024 + 1)); });
    auto noisy = Dib(3000, 2000);
    DWORD state = 0x139b1245;
    for (size_t index = sizeof(BITMAPINFOHEADER); index < noisy.size(); ++index) { state ^= state << 13; state ^= state >> 17; state ^= state << 5; noisy[index] = static_cast<BYTE>(state); }
    Failure("IMAGE_TOO_LARGE", [&] { pwtools::NormalizeClipboardImage(pwtools::ClipboardImageFormat::Dib, noisy); });
    std::cout << "clipboard image fixtures passed: PNG, DIB, DIBV5, 4K, malformed inputs, dimensions and bounded output (no clipboard writes)\n";
    CoUninitialize(); return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; CoUninitialize(); return 1;
  }
}
