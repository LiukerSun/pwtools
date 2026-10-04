#include "clipboard_image.hpp"
#include "api_bridge.hpp"
#include <wincodec.h>
#include <wrl.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <string>

using Microsoft::WRL::ComPtr;
namespace pwtools {
namespace {
constexpr size_t MaxPngBytes = 12 * 1024 * 1024;
constexpr UINT MaxSide = 16000;
constexpr uint64_t MaxPixels = 40000000;
constexpr size_t MaxDibBytes = static_cast<size_t>(MaxPixels * 4 + 16384);

[[noreturn]] void InvalidImage() { throw ApiFailure("INVALID_IMAGE", "剪贴板图片无法读取，请重新复制截图。"); }
[[noreturn]] void ImageTooLarge() { throw ApiFailure("IMAGE_TOO_LARGE", "截图不能超过 12 MiB，单边不能超过 16000 像素，总像素不能超过 4000 万。"); }
void ImageCheck(HRESULT result) { if (FAILED(result)) InvalidImage(); }
void CheckDimensions(UINT width, UINT height) {
  if (!width || !height) InvalidImage();
  if (width > MaxSide || height > MaxSide || static_cast<uint64_t>(width) * height > MaxPixels) ImageTooLarge();
}

// WIC stops encoding at the file limit instead of allocating an oversized PNG
// first. All allocations and the stream belong to this conversion operation.
class BoundedStream final : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IStream> {
 public:
  std::vector<BYTE> bytes;
  size_t position = 0;
  bool limitReached = false;
  STDMETHODIMP Read(void* buffer, ULONG count, ULONG* copied) override {
    if (!buffer && count) return STG_E_INVALIDPOINTER;
    const auto size = std::min<size_t>(count, position < bytes.size() ? bytes.size() - position : 0);
    if (size) std::memcpy(buffer, bytes.data() + position, size);
    position += size;
    if (copied) *copied = static_cast<ULONG>(size);
    return size == count ? S_OK : S_FALSE;
  }
  STDMETHODIMP Write(const void* buffer, ULONG count, ULONG* copied) override {
    if (copied) *copied = 0;
    if (!buffer && count) return STG_E_INVALIDPOINTER;
    if (count > MaxPngBytes - position) { limitReached = true; return STG_E_MEDIUMFULL; }
    try {
      if (position + count > bytes.size()) bytes.resize(position + count);
      if (count) std::memcpy(bytes.data() + position, buffer, count);
      position += count;
      if (copied) *copied = count;
      return S_OK;
    } catch (...) { return E_OUTOFMEMORY; }
  }
  STDMETHODIMP Seek(LARGE_INTEGER offset, DWORD origin, ULARGE_INTEGER* result) override {
    int64_t base = 0;
    if (origin == STREAM_SEEK_CUR) base = static_cast<int64_t>(position);
    else if (origin == STREAM_SEEK_END) base = static_cast<int64_t>(bytes.size());
    else if (origin != STREAM_SEEK_SET) return STG_E_INVALIDFUNCTION;
    if (offset.QuadPart < -base) return STG_E_INVALIDFUNCTION;
    if (offset.QuadPart > static_cast<int64_t>(MaxPngBytes) - base) { limitReached = true; return STG_E_MEDIUMFULL; }
    position = static_cast<size_t>(base + offset.QuadPart);
    if (result) result->QuadPart = position;
    return S_OK;
  }
  STDMETHODIMP SetSize(ULARGE_INTEGER size) override {
    if (size.QuadPart > MaxPngBytes) { limitReached = true; return STG_E_MEDIUMFULL; }
    try { bytes.resize(static_cast<size_t>(size.QuadPart)); return S_OK; }
    catch (...) { return E_OUTOFMEMORY; }
  }
  STDMETHODIMP CopyTo(IStream*, ULARGE_INTEGER, ULARGE_INTEGER*, ULARGE_INTEGER*) override { return E_NOTIMPL; }
  STDMETHODIMP Commit(DWORD) override { return S_OK; }
  STDMETHODIMP Revert() override { return E_NOTIMPL; }
  STDMETHODIMP LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  STDMETHODIMP UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  STDMETHODIMP Stat(STATSTG* stat, DWORD) override {
    if (!stat) return STG_E_INVALIDPOINTER;
    *stat = {}; stat->type = STGTY_STREAM; stat->cbSize.QuadPart = bytes.size(); stat->grfMode = STGM_READWRITE;
    return S_OK;
  }
  STDMETHODIMP Clone(IStream**) override { return E_NOTIMPL; }
};

ComPtr<IWICImagingFactory> Factory() {
  ComPtr<IWICImagingFactory> factory;
  ImageCheck(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
  return factory;
}

std::vector<BYTE> EncodePng(IWICImagingFactory* factory, IWICBitmapSource* source) {
  UINT width = 0, height = 0;
  ImageCheck(source->GetSize(&width, &height));
  CheckDimensions(width, height);
  ComPtr<IWICFormatConverter> converter;
  ImageCheck(factory->CreateFormatConverter(&converter));
  ImageCheck(converter->Initialize(source, GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  auto stream = Microsoft::WRL::Make<BoundedStream>();
  if (!stream) throw ApiFailure("INTERNAL_ERROR", "读取剪贴板图片失败，请稍后重试。");
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  ComPtr<IPropertyBag2> properties;
  ImageCheck(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder));
  ImageCheck(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache));
  ImageCheck(encoder->CreateNewFrame(&frame, &properties));
  ImageCheck(frame->Initialize(properties.Get()));
  ImageCheck(frame->SetSize(width, height));
  auto format = GUID_WICPixelFormat32bppBGRA;
  ImageCheck(frame->SetPixelFormat(&format));
  HRESULT result = frame->WriteSource(converter.Get(), nullptr);
  if (SUCCEEDED(result)) result = frame->Commit();
  if (SUCCEEDED(result)) result = encoder->Commit();
  if (FAILED(result) && stream->limitReached) ImageTooLarge();
  ImageCheck(result);
  if (stream->bytes.empty() || stream->bytes.size() > MaxPngBytes) ImageTooLarge();
  return std::move(stream->bytes);
}

std::vector<BYTE> DecodeToPng(std::vector<BYTE>& bytes, const GUID& expectedFormat) {
  auto factory = Factory();
  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapDecoder> decoder;
  ComPtr<IWICBitmapFrameDecode> frame;
  ImageCheck(factory->CreateStream(&stream));
  ImageCheck(stream->InitializeFromMemory(bytes.data(), static_cast<DWORD>(bytes.size())));
  ImageCheck(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand, &decoder));
  GUID format{};
  ImageCheck(decoder->GetContainerFormat(&format));
  if (format != expectedFormat) InvalidImage();
  ImageCheck(decoder->GetFrame(0, &frame));
  return EncodePng(factory.Get(), frame.Get());
}

void ValidatePng(std::vector<BYTE>& bytes) {
  auto factory = Factory();
  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapDecoder> decoder;
  ComPtr<IWICBitmapFrameDecode> frame;
  ComPtr<IWICFormatConverter> converter;
  ImageCheck(factory->CreateStream(&stream));
  ImageCheck(stream->InitializeFromMemory(bytes.data(), static_cast<DWORD>(bytes.size())));
  ImageCheck(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand, &decoder));
  GUID format{};
  ImageCheck(decoder->GetContainerFormat(&format));
  if (format != GUID_ContainerFormatPng) InvalidImage();
  ImageCheck(decoder->GetFrame(0, &frame));
  UINT width = 0, height = 0;
  ImageCheck(frame->GetSize(&width, &height));
  CheckDimensions(width, height);
  ImageCheck(factory->CreateFormatConverter(&converter));
  ImageCheck(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  const UINT stride = width * 4;
  const UINT rows = std::min<UINT>(64, height);
  std::vector<BYTE> buffer(static_cast<size_t>(stride) * rows);
  for (UINT top = 0; top < height; top += rows) {
    WICRect bounds{0, static_cast<INT>(top), static_cast<INT>(width), static_cast<INT>(std::min(rows, height - top))};
    ImageCheck(converter->CopyPixels(&bounds, stride, static_cast<UINT>(buffer.size()), buffer.data()));
  }
}

std::vector<BYTE> DibToBmp(const std::vector<BYTE>& dib) {
  if (dib.size() > MaxDibBytes) ImageTooLarge();
  if (dib.size() < sizeof(BITMAPINFOHEADER)) InvalidImage();
  BITMAPINFOHEADER header{};
  std::memcpy(&header, dib.data(), sizeof(header));
  if (header.biSize != 40 && header.biSize != 52 && header.biSize != 56 && header.biSize != 108 && header.biSize != 124) InvalidImage();
  if (dib.size() < header.biSize || header.biWidth <= 0 || !header.biHeight || header.biHeight == std::numeric_limits<LONG>::min() || header.biPlanes != 1) InvalidImage();
  const auto height = static_cast<UINT>(header.biHeight < 0 ? -header.biHeight : header.biHeight);
  CheckDimensions(static_cast<UINT>(header.biWidth), height);
  if (header.biBitCount != 1 && header.biBitCount != 4 && header.biBitCount != 8 && header.biBitCount != 16 && header.biBitCount != 24 && header.biBitCount != 32) InvalidImage();
  constexpr DWORD AlphaBitfields = 6;
  if (header.biCompression != BI_RGB && header.biCompression != BI_BITFIELDS && header.biCompression != AlphaBitfields) InvalidImage();
  if (header.biCompression != BI_RGB && header.biBitCount != 16 && header.biBitCount != 32) InvalidImage();
  if (header.biClrUsed > 256 || (header.biBitCount <= 8 && header.biClrUsed > (1u << header.biBitCount))) InvalidImage();
  const auto colors = header.biClrUsed ? header.biClrUsed : (header.biBitCount <= 8 ? 1u << header.biBitCount : 0u);
  size_t offset = header.biSize + static_cast<size_t>(colors) * sizeof(RGBQUAD);
  if (header.biSize == 40 && header.biCompression != BI_RGB) offset += (header.biCompression == AlphaBitfields ? 4u : 3u) * sizeof(DWORD);
  const uint64_t stride = ((static_cast<uint64_t>(header.biWidth) * header.biBitCount + 31) / 32) * 4;
  const auto pixels = static_cast<size_t>(stride * height);
  if (offset > dib.size() || pixels > dib.size() - offset || (header.biSizeImage && header.biSizeImage < pixels)) InvalidImage();
  std::vector<BYTE> bmp(sizeof(BITMAPFILEHEADER) + offset + pixels);
  BITMAPFILEHEADER file{};
  file.bfType = 0x4d42; file.bfSize = static_cast<DWORD>(bmp.size()); file.bfOffBits = static_cast<DWORD>(sizeof(file) + offset);
  std::memcpy(bmp.data(), &file, sizeof(file));
  std::memcpy(bmp.data() + sizeof(file), dib.data(), offset + pixels);
  // Do not let an untrusted declared image size influence decoder allocations.
  header.biSizeImage = static_cast<DWORD>(pixels);
  std::memcpy(bmp.data() + sizeof(file), &header, sizeof(header));
  if (header.biSize == sizeof(BITMAPV5HEADER)) {
    // Packed clipboard DIB profiles follow the pixels. Strip profile metadata,
    // including linked filenames, rather than accessing files during decoding.
    BITMAPV5HEADER v5{};
    std::memcpy(&v5, bmp.data() + sizeof(file), sizeof(v5));
    v5.bV5CSType = LCS_sRGB; v5.bV5ProfileData = 0; v5.bV5ProfileSize = 0;
    std::memcpy(bmp.data() + sizeof(file), &v5, sizeof(v5));
  }
  return bmp;
}

std::vector<BYTE> CopyClipboardBytes(UINT format, size_t limit) {
  HANDLE handle = GetClipboardData(format);
  if (!handle) InvalidImage();
  const auto size = GlobalSize(handle);
  if (!size) InvalidImage();
  if (size > limit) ImageTooLarge();
  const void* memory = GlobalLock(handle);
  if (!memory) InvalidImage();
  std::vector<BYTE> bytes;
  try { bytes.assign(static_cast<const BYTE*>(memory), static_cast<const BYTE*>(memory) + size); }
  catch (...) { GlobalUnlock(handle); throw; }
  GlobalUnlock(handle);
  return bytes;
}
} // namespace

std::vector<BYTE> NormalizeClipboardImage(ClipboardImageFormat format, const std::vector<BYTE>& bytes) {
  if (bytes.empty()) InvalidImage();
  if (format == ClipboardImageFormat::Png) {
    if (bytes.size() > MaxPngBytes) ImageTooLarge();
    auto input = bytes;
    ValidatePng(input);
    // Keep the original screenshot identity, matching ordinary Ctrl+V uploads.
    return bytes;
  }
  auto input = DibToBmp(bytes);
  return DecodeToPng(input, GUID_ContainerFormatBmp);
}

std::optional<std::vector<BYTE>> ReadClipboardImage(HWND owner) {
  if (!OpenClipboard(owner)) throw ApiFailure("CLIPBOARD_BUSY", "剪贴板正在被其他程序使用，请稍后重试。");
  struct Close { ~Close() { CloseClipboard(); } } close;
  const UINT png = RegisterClipboardFormatW(L"PNG");
  if (png && IsClipboardFormatAvailable(png)) return NormalizeClipboardImage(ClipboardImageFormat::Png, CopyClipboardBytes(png, MaxPngBytes));
  if (IsClipboardFormatAvailable(CF_DIBV5)) return NormalizeClipboardImage(ClipboardImageFormat::Dib, CopyClipboardBytes(CF_DIBV5, MaxDibBytes));
  if (IsClipboardFormatAvailable(CF_DIB)) return NormalizeClipboardImage(ClipboardImageFormat::Dib, CopyClipboardBytes(CF_DIB, MaxDibBytes));
  if (!IsClipboardFormatAvailable(CF_BITMAP)) return std::nullopt;
  auto bitmap = static_cast<HBITMAP>(GetClipboardData(CF_BITMAP));
  BITMAP info{};
  if (!bitmap || !GetObjectW(bitmap, sizeof(info), &info) || info.bmWidth <= 0 || info.bmHeight <= 0) InvalidImage();
  CheckDimensions(static_cast<UINT>(info.bmWidth), static_cast<UINT>(info.bmHeight));
  auto factory = Factory();
  ComPtr<IWICBitmap> source;
  ImageCheck(factory->CreateBitmapFromHBITMAP(bitmap, nullptr, WICBitmapIgnoreAlpha, &source));
  return EncodePng(factory.Get(), source.Get());
}
} // namespace pwtools
