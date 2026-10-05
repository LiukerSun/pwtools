#include <windows.h>
#include <wincodec.h>
#include <wrl.h>
#define ORT_API_MANUAL_INIT
#include <onnxruntime_cxx_api.h>
#include "local_ocr.hpp"
#include "api_bridge.hpp"
#include "scoreboard.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <thread>

namespace pwtools {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
using Microsoft::WRL::ComPtr;
constexpr std::size_t kMaxImage = 12 * 1024 * 1024;
constexpr unsigned kMaxSide = 16000, kInferenceSide = 2000;
constexpr std::uint64_t kMaxPixels = 40000000;

[[noreturn]] void Unavailable() { throw ApiFailure("LOCAL_OCR_UNAVAILABLE", "本地识别暂时不可用，请重新安装客户端或手动填写。"); }
[[noreturn]] void InvalidImage() { throw ApiFailure("INVALID_IMAGE", "图片无法读取，请选择 PNG、JPEG 或 WebP 截图。"); }
[[noreturn]] void Timeout() { throw ApiFailure("LOCAL_OCR_TIMEOUT", "本地识别超时，请裁剪战绩区域后重试，或手动填写。"); }
void Check(HRESULT result) { if (FAILED(result)) InvalidImage(); }
void CheckDeadline(Clock::time_point deadline) { if (Clock::now() >= deadline) Timeout(); }

std::filesystem::path DefaultDirectory() {
  std::wstring module(32768, L'\0');
  const auto size = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  if (!size || size == module.size()) Unavailable();
  module.resize(size);
  return std::filesystem::path(module).parent_path() / L"ocr";
}
void LoadRuntime(const std::filesystem::path& directory) {
  static std::once_flag once;
  std::call_once(once, [&] {
    // Load only from the application payload and System32, not the working directory.
    const auto library = LoadLibraryExW((directory / L"onnxruntime.dll").c_str(), nullptr,
                                       LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!library) Unavailable();
    using GetApiBase = const OrtApiBase* (ORT_API_CALL*)();
    const auto get_api = reinterpret_cast<GetApiBase>(GetProcAddress(library, "OrtGetApiBase"));
    const auto api = get_api ? get_api()->GetApi(ORT_API_VERSION) : nullptr;
    if (!api) { FreeLibrary(library); Unavailable(); }
    // The DLL remains mapped until application exit; no models or threads stay alive.
    Ort::InitApi(api);
  });
}

struct Apartment {
  HRESULT status = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  Apartment() { if (FAILED(status) && status != RPC_E_CHANGED_MODE) Unavailable(); }
  ~Apartment() { if (SUCCEEDED(status)) CoUninitialize(); }
};
struct Image { unsigned width, height; std::vector<unsigned char> bgr; };
Image Decode(const std::vector<unsigned char>& bytes, const std::string& mime) {
  ComPtr<IWICImagingFactory> factory;
  Check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
  ComPtr<IWICStream> stream; Check(factory->CreateStream(&stream));
  Check(stream->InitializeFromMemory(const_cast<BYTE*>(bytes.data()), static_cast<DWORD>(bytes.size())));
  ComPtr<IWICBitmapDecoder> decoder;
  Check(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand, &decoder));
  GUID format{}; Check(decoder->GetContainerFormat(&format));
  const auto expected = mime == "image/png" ? GUID_ContainerFormatPng : (mime == "image/jpeg" ? GUID_ContainerFormatJpeg : GUID_ContainerFormatWebp);
  if (format != expected) InvalidImage();
  UINT frames = 0; Check(decoder->GetFrameCount(&frames));
  if (frames != 1) InvalidImage();
  ComPtr<IWICBitmapFrameDecode> frame; Check(decoder->GetFrame(0, &frame));
  UINT width = 0, height = 0; Check(frame->GetSize(&width, &height));
  if (!width || !height) InvalidImage();
  if (width > kMaxSide || height > kMaxSide || std::uint64_t(width) * height > kMaxPixels)
    throw ApiFailure("IMAGE_TOO_LARGE", "截图单边不能超过 16000 像素，总像素不能超过 4000 万。");
  ComPtr<IWICBitmapSource> source; Check(frame.As(&source));
  ComPtr<IWICMetadataQueryReader> metadata;
  if (SUCCEEDED(frame->GetMetadataQueryReader(&metadata))) {
    PROPVARIANT orientation{};
    for (auto query : {L"/app1/ifd/{ushort=274}", L"/ifd/{ushort=274}"}) {
      if (SUCCEEDED(metadata->GetMetadataByName(query, &orientation))) break;
    }
    if (orientation.vt == VT_UI2 && orientation.uiVal >= 2 && orientation.uiVal <= 8) {
      constexpr WICBitmapTransformOptions transforms[] = {WICBitmapTransformRotate0, WICBitmapTransformFlipHorizontal,
        WICBitmapTransformRotate180, WICBitmapTransformFlipVertical,
        static_cast<WICBitmapTransformOptions>(WICBitmapTransformRotate90 | WICBitmapTransformFlipHorizontal),
        WICBitmapTransformRotate90, static_cast<WICBitmapTransformOptions>(WICBitmapTransformRotate90 | WICBitmapTransformFlipVertical),
        WICBitmapTransformRotate270};
      ComPtr<IWICBitmapFlipRotator> rotated; Check(factory->CreateBitmapFlipRotator(&rotated));
      Check(rotated->Initialize(source.Get(), transforms[orientation.uiVal - 1]));
      Check(rotated.As(&source));
    }
    PropVariantClear(&orientation);
  }
  Check(source->GetSize(&width, &height));
  if (std::max(width, height) > kInferenceSide) {
    const auto scale = double(kInferenceSide) / std::max(width, height);
    width = std::max(1u, static_cast<unsigned>(std::lround(width * scale)));
    height = std::max(1u, static_cast<unsigned>(std::lround(height * scale)));
    ComPtr<IWICBitmapScaler> resized; Check(factory->CreateBitmapScaler(&resized));
    Check(resized->Initialize(source.Get(), width, height, WICBitmapInterpolationModeFant));
    Check(resized.As(&source));
  }
  ComPtr<IWICFormatConverter> converter; Check(factory->CreateFormatConverter(&converter));
  Check(converter->Initialize(source.Get(), GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
  Image result{width, height, std::vector<unsigned char>(std::size_t(width) * height * 3)};
  Check(converter->CopyPixels(nullptr, width * 3, static_cast<UINT>(result.bgr.size()), result.bgr.data()));
  return result;
}

struct Point { double x, y; };
Point operator+(Point a, Point b) { return {a.x + b.x, a.y + b.y}; }
Point operator*(Point a, double factor) { return {a.x * factor, a.y * factor}; }
double Cross(Point a, Point b, Point c) { return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x); }
struct Box {
  Point origin, u, v;
  double width, height;
  Point At(double x, double y) const { return origin + u * x + v * y; }
};
std::optional<Box> Bounds(std::vector<Point> points) {
  if (points.size() < 3) return {};
  std::sort(points.begin(), points.end(), [](Point a, Point b) { return a.x == b.x ? a.y < b.y : a.x < b.x; });
  points.erase(std::unique(points.begin(), points.end(), [](Point a, Point b) { return a.x == b.x && a.y == b.y; }), points.end());
  std::vector<Point> hull;
  for (Point point : points) {
    while (hull.size() > 1 && Cross(hull[hull.size()-2], hull.back(), point) <= 0) hull.pop_back();
    hull.push_back(point);
  }
  const auto lower = hull.size();
  for (auto it = points.rbegin() + 1; it != points.rend(); ++it) {
    while (hull.size() > lower && Cross(hull[hull.size()-2], hull.back(), *it) <= 0) hull.pop_back();
    hull.push_back(*it);
  }
  hull.pop_back();
  if (hull.size() < 3) return {};
  double best = std::numeric_limits<double>::max(); Box box{};
  for (std::size_t i = 0; i < hull.size(); ++i) {
    const auto a = hull[i], b = hull[(i + 1) % hull.size()];
    const auto length = std::hypot(b.x - a.x, b.y - a.y);
    Point u{(b.x-a.x)/length, (b.y-a.y)/length}, v{-u.y, u.x};
    double min_u = std::numeric_limits<double>::max(), min_v = min_u, max_u = -min_u, max_v = -min_u;
    for (Point point : hull) {
      const auto pu = point.x*u.x + point.y*u.y, pv = point.x*v.x + point.y*v.y;
      min_u = std::min(min_u, pu); max_u = std::max(max_u, pu); min_v = std::min(min_v, pv); max_v = std::max(max_v, pv);
    }
    const auto w = max_u - min_u, h = max_v - min_v;
    if (w*h >= best) continue;
    best = w*h; box = {u*min_u + v*min_v, u, v, w, h};
  }
  // Select the orientation closest to an upright horizontal text line.
  if (std::abs(box.u.x) < std::abs(box.v.x)) {
    box.origin = box.At(box.width, 0); const auto old_u = box.u;
    box.u = box.v; box.v = old_u * -1; std::swap(box.width, box.height);
  }
  if (box.u.x < 0) { box.origin = box.At(box.width, box.height); box.u = box.u * -1; box.v = box.v * -1; }
  if (std::min(box.width, box.height) < 3) return {};
  return box;
}
float Pixel(const Image& image, double x, double y, unsigned channel) {
  x = std::clamp(x, 0.0, double(image.width-1)); y = std::clamp(y, 0.0, double(image.height-1));
  const auto x0 = static_cast<unsigned>(x), y0 = static_cast<unsigned>(y);
  const auto x1 = std::min(x0+1, image.width-1), y1 = std::min(y0+1, image.height-1);
  const auto dx = x-x0, dy = y-y0;
  const auto at = [&](unsigned px, unsigned py) { return image.bgr[(std::size_t(py)*image.width+px)*3+channel]; };
  return static_cast<float>(((1-dx)*at(x0,y0)+dx*at(x1,y0))*(1-dy)+((1-dx)*at(x0,y1)+dx*at(x1,y1))*dy);
}
std::vector<float> Tensor(const Image& image, const Box& box, unsigned width, unsigned height, unsigned padded, bool flip = false) {
  std::vector<float> data(std::size_t(padded) * height * 3, 0);
  for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
    const auto sx = (x+0.5)*box.width/width-0.5, sy = (y+0.5)*box.height/height-0.5;
    const auto point = flip ? box.At(box.width-1-sx, box.height-1-sy) : box.At(sx, sy);
    for (unsigned c = 0; c < 3; ++c) data[(std::size_t(c)*height+y)*padded+x] = Pixel(image, point.x, point.y, c)/127.5f-1.0f;
  }
  return data;
}

struct Budget {
  Ort::RunOptions options;
  Clock::time_point deadline;
  std::mutex mutex;
  std::condition_variable changed;
  bool finished = false;
  std::jthread watchdog;
  explicit Budget(Clock::time_point end) : deadline(end), watchdog([this] {
    std::unique_lock lock(mutex);
    if (!changed.wait_until(lock, deadline, [&] { return finished; })) { try { options.SetTerminate(); } catch (...) {} }
  }) {}
  ~Budget() { { std::lock_guard lock(mutex); finished = true; } changed.notify_one(); if (watchdog.joinable()) watchdog.join(); }
};
Ort::SessionOptions SessionOptions() {
  Ort::SessionOptions options;
  options.SetIntraOpNumThreads(2); options.SetInterOpNumThreads(1); options.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
  options.DisableCpuMemArena(); options.DisableMemPattern();
  options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
  options.SetLogSeverityLevel(ORT_LOGGING_LEVEL_ERROR);
  options.AddConfigEntry("session.intra_op.allow_spinning", "0");
  return options;
}
struct Model {
  Ort::Session session;
  Ort::AllocatorWithDefaultOptions allocator;
  Ort::AllocatedStringPtr input, output;
  Model(Ort::Env& env, const std::filesystem::path& file) : session(env, file.c_str(), SessionOptions()),
      input(session.GetInputNameAllocated(0, allocator)), output(session.GetOutputNameAllocated(0, allocator)) {}
  Ort::Value Run(std::vector<float>& data, unsigned width, unsigned height, Budget& budget) {
    CheckDeadline(budget.deadline);
    const std::array<std::int64_t, 4> shape{1, 3, height, width};
    auto memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    auto tensor = Ort::Value::CreateTensor<float>(memory, data.data(), data.size(), shape.data(), shape.size());
    const char* inputs[] = {input.get()}; const char* outputs[] = {output.get()};
    auto result = session.Run(budget.options, inputs, &tensor, 1, outputs, 1);
    CheckDeadline(budget.deadline);
    return std::move(result[0]);
  }
};

std::vector<Box> Detect(Model& detector, const Image& image, Budget& budget) {
  // The detector expects multiples of 32, normalized BGR with mean/std 0.5.
  // Keep the sharper 2000px image for recognition crops, but bound the more
  // memory-intensive detection pass to 1600px.
  const auto scale = std::min(1600.0 / std::max(image.width, image.height),
                              std::max(1.0, 736.0 / std::min(image.width, image.height)));
  const auto width = std::max(32u, static_cast<unsigned>(std::lround(image.width*scale/32))*32);
  const auto height = std::max(32u, static_cast<unsigned>(std::lround(image.height*scale/32))*32);
  // Extreme aspect ratios cannot cause unbounded detector allocations.
  if (std::uint64_t(width)*height > 4500000) InvalidImage();
  const Box full{{0,0},{1,0},{0,1},double(image.width),double(image.height)};
  auto input = Tensor(image, full, width, height, width);
  auto prediction = detector.Run(input, width, height, budget);
  const auto shape = prediction.GetTensorTypeAndShapeInfo().GetShape();
  if (shape.size() != 4 || shape[0] != 1 || shape[1] != 1 || shape[2] <= 0 || shape[3] <= 0 || shape[2]*shape[3] > 4500000) Unavailable();
  const auto rows = static_cast<unsigned>(shape[2]), cols = static_cast<unsigned>(shape[3]);
  const auto count = std::size_t(rows)*cols; const float* scores = prediction.GetTensorData<float>();
  std::vector<unsigned char> mask(count, 0);
  // Equivalent 2x2 dilation connects the detector's text strokes, not table cells.
  for (unsigned y = 0; y < rows; ++y) for (unsigned x = 0; x < cols; ++x) {
    if (scores[std::size_t(y)*cols+x] <= 0.3f) continue;
    for (unsigned dy = 0; dy < 2 && y+dy < rows; ++dy) for (unsigned dx = 0; dx < 2 && x+dx < cols; ++dx) mask[std::size_t(y+dy)*cols+x+dx] = 1;
  }
  std::vector<Box> boxes; std::vector<unsigned> queue; std::vector<Point> boundary; unsigned components = 0;
  for (unsigned start = 0; start < count; ++start) {
    if (mask[start] != 1) continue;
    CheckDeadline(budget.deadline);
    if (++components > 1000) break;
    queue.clear(); boundary.clear(); queue.push_back(start); mask[start] = 2;
    for (std::size_t head = 0; head < queue.size(); ++head) {
      const auto index = queue[head]; const auto x = static_cast<int>(index % cols), y = static_cast<int>(index / cols);
      bool edge = false;
      for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
        if (!dx && !dy) continue;
        const int nx = x+dx, ny = y+dy;
        if (nx < 0 || ny < 0 || nx >= static_cast<int>(cols) || ny >= static_cast<int>(rows)) { edge = true; continue; }
        const auto next = static_cast<unsigned>(ny)*cols+static_cast<unsigned>(nx);
        if (!mask[next]) edge = true;
        else if (mask[next] == 1) { mask[next] = 2; queue.push_back(next); }
      }
      if (edge) boundary.push_back({double(x),double(y)});
    }
    auto box = Bounds(std::move(boundary));
    if (!box) continue;
    double sum = 0; std::size_t cells = 0;
    // Mean score inside the rotated bounding rectangle, matching DB scoring.
    const auto corners = std::array{box->At(0,0),box->At(box->width,0),box->At(0,box->height),box->At(box->width,box->height)};
    double min_x = cols, min_y = rows, max_x = 0, max_y = 0;
    for (auto point : corners) { min_x=std::min(min_x,point.x); min_y=std::min(min_y,point.y); max_x=std::max(max_x,point.x); max_y=std::max(max_y,point.y); }
    for (int y = std::max(0,static_cast<int>(std::floor(min_y))); y <= std::min(static_cast<int>(rows)-1,static_cast<int>(std::ceil(max_y))); ++y) {
      for (int x = std::max(0,static_cast<int>(std::floor(min_x))); x <= std::min(static_cast<int>(cols)-1,static_cast<int>(std::ceil(max_x))); ++x) {
        const auto px=x-box->origin.x, py=y-box->origin.y;
        const auto u=px*box->u.x+py*box->u.y, v=px*box->v.x+py*box->v.y;
        if (u < -0.5 || u > box->width+0.5 || v < -0.5 || v > box->height+0.5) continue;
        sum += scores[std::size_t(y)*cols+static_cast<unsigned>(x)]; ++cells;
      }
    }
    if (!cells || sum/cells < 0.5) continue;
    const auto padding = box->width*box->height*1.6/(2*(box->width+box->height));
    box->origin = box->At(-padding,-padding); box->width += padding*2; box->height += padding*2;
    const auto sx=double(image.width)/cols, sy=double(image.height)/rows;
    box->origin = {box->origin.x*sx,box->origin.y*sy}; box->u = {box->u.x*sx,box->u.y*sy}; box->v = {box->v.x*sx,box->v.y*sy};
    const auto su=std::hypot(box->u.x,box->u.y), sv=std::hypot(box->v.x,box->v.y);
    box->u=box->u*(1/su); box->v=box->v*(1/sv); box->width*=su; box->height*=sv;
    if (box->width > 3 && box->height > 3) boxes.push_back(*box);
  }
  return boxes;
}
std::vector<std::string> Dictionary(Model& recognizer) {
  const auto metadata = recognizer.session.GetModelMetadata();
  const auto characters = metadata.LookupCustomMetadataMapAllocated("character", recognizer.allocator);
  if (!characters) Unavailable();
  std::istringstream stream(characters.get()); std::vector<std::string> result{ "" };
  for (std::string line; std::getline(stream, line);) { if (!line.empty() && line.back() == '\r') line.pop_back(); result.push_back(std::move(line)); }
  result.push_back(" "); return result;
}
OcrLine ReadLine(Model& recognizer, Model& classifier, const Image& image, Box box, const std::vector<std::string>& dictionary, Budget& budget) {
  const auto corners = std::array{box.At(0,0),box.At(box.width,0),box.At(0,box.height),box.At(box.width,box.height)};
  OcrLine line{double(image.width),double(image.height),0,0,"",0};
  for (auto point : corners) { line.x0=std::min(line.x0,point.x); line.y0=std::min(line.y0,point.y); line.x1=std::max(line.x1,point.x); line.y1=std::max(line.y1,point.y); }
  if (box.height >= box.width*1.5) { box.origin=box.At(box.width,0); const auto old_u=box.u; box.u=box.v; box.v=old_u*-1; std::swap(box.width,box.height); }
  auto classification = Tensor(image,box,std::max(1u,std::min(192u,static_cast<unsigned>(std::ceil(48*box.width/box.height)))),48,192);
  auto orientation = classifier.Run(classification,192,48,budget);
  bool flip = false;
  if (orientation.GetTensorTypeAndShapeInfo().GetElementCount() == 2) { const auto score=orientation.GetTensorData<float>(); flip=score[1]>score[0] && score[1]>0.9f; }
  const auto resized = std::max(1u,static_cast<unsigned>(std::ceil(48*box.width/box.height))), padded = std::max(320u,resized);
  if (padded > 4096) return line;
  auto input = Tensor(image,box,resized,48,padded,flip); auto output = recognizer.Run(input,padded,48,budget);
  const auto shape = output.GetTensorTypeAndShapeInfo().GetShape();
  if (shape.size()!=3 || shape[0]!=1 || shape[1]<=0 || shape[2]!=static_cast<std::int64_t>(dictionary.size())) Unavailable();
  const auto scores=output.GetTensorData<float>(); const auto classes=dictionary.size();
  std::size_t previous=0, letters=0; double confidence=0;
  for (std::int64_t step=0; step<shape[1]; ++step) {
    const auto begin=scores+static_cast<std::size_t>(step)*classes; const auto highest=std::max_element(begin,begin+classes);
    const auto token=static_cast<std::size_t>(highest-begin);
    if (token && token!=previous) { line.text+=dictionary[token]; confidence+=*highest; ++letters; }
    previous=token;
  }
  line.confidence=letters ? confidence/letters : 0; return line;
}
} // namespace

struct LocalOcr::Impl {
  std::filesystem::path directory;
  std::chrono::milliseconds timeout;
  std::timed_mutex mutex;
  Impl(std::filesystem::path location, std::chrono::milliseconds budget) : directory(location.empty() ? DefaultDirectory() : std::filesystem::absolute(location)), timeout(budget) {}
  Json Recognize(const std::vector<unsigned char>& bytes, const std::string& mime) {
    if (bytes.empty() || bytes.size()>kMaxImage || (mime!="image/png" && mime!="image/jpeg" && mime!="image/webp")) InvalidImage();
    const auto deadline=Clock::now()+timeout;
    std::unique_lock lock(mutex,std::defer_lock);
    if (!lock.try_lock_until(deadline)) Timeout();
    try {
      Apartment apartment; const auto image=Decode(bytes,mime); LoadRuntime(directory);
      Ort::Env env(ORT_LOGGING_LEVEL_ERROR,"PWTools"); Budget budget(deadline);
      std::vector<Box> boxes;
      { Model detector(env,directory/L"PP-OCRv6_det_small.onnx"); boxes=Detect(detector,image,budget); }
      std::vector<OcrLine> lines;
      if (!boxes.empty()) {
        Model recognizer(env,directory/L"PP-OCRv6_rec_small.onnx"), classifier(env,directory/L"ch_ppocr_mobile_v2.0_cls_mobile.onnx");
        const auto dictionary=Dictionary(recognizer);
        for (auto box : boxes) { auto line=ReadLine(recognizer,classifier,image,box,dictionary,budget); if (line.confidence>=0.5 && !line.text.empty()) lines.push_back(std::move(line)); }
      }
      CheckDeadline(deadline); return ParseScoreboard(std::move(lines),image.width,image.height);
    } catch (const Ort::Exception&) { CheckDeadline(deadline); Unavailable(); }
  }
};
LocalOcr::LocalOcr(std::filesystem::path directory, std::chrono::milliseconds timeout) : impl_(std::make_unique<Impl>(std::move(directory),timeout)) {}
LocalOcr::~LocalOcr() = default;
Json LocalOcr::Recognize(const std::vector<unsigned char>& image, const std::string& mime) { return impl_->Recognize(image,mime); }
} // namespace pwtools
