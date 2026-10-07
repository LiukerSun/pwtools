# 三角洲战绩 OCR

Windows 桌面版从 0.9.13 起使用原生 C++ 在用户电脑上识别：`apps/desktop/native/src/local_ocr.cpp` 用 Windows WIC 在内存中解码图片，调用 ONNX Runtime C++ API，`scoreboard.cpp` 解析战绩表。客户端构建及运行均不需要 Python、NumPy、OpenCV 或系统 OCR 语言包。模型和原生推理 DLL 由 `scripts/native-ocr-prepare.ps1` 从校验过 SHA-256 的官方发行物提取到 `ocr/` 目录，只分发所需的三个模型与五个 DLL。模型按需加载，识别结束释放；没有后台模型进程、HTTP 端口或原图临时文件。每台电脑独立处理，不进入服务端推理队列。

导入时本地识别与原图保存并行，随后向 API 提交绑定原图 SHA-256 的结果。重新识别从需登录的原图端点读取图片，再在本机推理。模型异常或超时后释放任务，已保存原图与人工校对仍保留。桌面端一次调用含排队、解码、加载和推理的总预算为 45 秒，超时会请求中断推理；模型加载及图片解码本身为同步操作。仅用两个 CPU 线程，禁用空闲自旋与推理内存池，检测长边最多 1600 像素，文字裁片来自长边最多 2000 像素的图片。原图上传和结果保存仍需要连接服务端。`native/tests/local_ocr_test.cpp` 是无窗口的原生样例检查；设置 `PWTOOLS_OCR_SAMPLE` 可启用真实截图验证。

C++ 标准库没有 OCR。Windows 自带的 `Windows.Media.Ocr` [官方支持要求应用拥有 MSIX 包身份](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr)，当前客户端使用 Win32 / NSIS，因此选择独立原生推理库，避免依赖系统语言包和变更安装方式。模型与服务端相同，使用 [ONNX Runtime 官方 C++ 接口](https://onnxruntime.ai/docs/get-started/with-cpp.html)。

以下 HTTP 服务继续支持浏览器预览与旧客户端。

内部 Python 3.12 HTTP 服务，采用 RapidOCR 3.9.2 的 PP-OCRv6 small 检测/识别模型和 ONNX Runtime 1.23.2 CPU 推理。模型包含在 RapidOCR wheel 中，构建镜像时检查并初始化；运行时显式使用本地模型路径，不依赖首个请求下载，不调用云端 OCR。

官方资料：[RapidOCR 安装与维护版本说明](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/install/)、[模型与 Python 接口](https://rapidai.github.io/RapidOCRDocs/main/en/install_usage/rapidocr/usage/)、[ONNX Runtime CPU 安装](https://onnxruntime.ai/docs/install/)。旧 `rapidocr_onnxruntime` 包逐步退役，因此选择维护中的 `rapidocr`。

## 接口

服务监听容器内 `8090`。供 Rust API 调用 `http://ocr:8090`，Compose 中仅通过服务名访问，不映射宿主机或公网端口。

- `GET /health`：模型初始化完成后返回 `{"status":"ready","engine":"rapidocr-onnx-cpu","busy":false}`。
- `POST /recognize`：原始图片二进制请求体，`Content-Type` 必须为 `image/png`、`image/jpeg` 或 `image/webp`，不使用 multipart。

成功响应：

```json
{
  "outcome": "success",
  "players": [
    {"player_name": "队员昵称", "outcome": "success", "amount": 3314221, "confidence": 0.9962}
  ],
  "raw_text": "带出价值\n撤离成功\n3,314,221\n队员昵称",
  "warnings": []
}
```

`outcome` 为 `success`、`failed` 或 `unknown`。`amount` 为整数或 `null`；失败行金额固定为 `0`，原始 OCR 文本仍保留。`confidence` 是相关 OCR 文字识别分数的保守最小值，范围 0–1，不表示统计上校准的正确概率。

OCR 返回所有可靠识别的队员行。老板 ID 匹配、仅保存匹配行，以及用户原图持久化均由 Rust API 负责；此服务不猜测老板身份，不将原图写入文件或数据库。

## 识别规则

根据「带出价值」「撤离金额」等表头及相邻列的 bounding boxes 定位价值列，按队员的撤离标签和名字所在横行匹配金额。金额仅接受价值列内完整的数字/千分位数字，上限为 9,999,999,999，超限保留 `null`；击败数量、救助比例、生存分钟、段位和其他位置的数字不会替代金额。

每个队员状态独立解析。监狱地图的「越狱成功」「越狱失败」分别等同「撤离成功」「撤离失败」，失败行金额同样为 `0`，原始 OCR 文本保留。大字成功标题不会覆盖失败或未知队员；混合状态的整体 `outcome` 为 `unknown` 并附提示，同一标签含互相矛盾的成功和失败文字时也保留 `unknown`。价值列缺失、金额模糊、状态缺失或未找到队员行时保留 `null` / `unknown` 和人工确认提示。没有可靠相邻列边界的单独金额截图也按未知处理。解析适用于战绩详情表，不保证其他游戏页面或改变后的布局。

当前真实图片验证只有用户提供的成功截图：三位队员识别金额为 **3314221、1867449、97593**，对应行状态均为 `success`。CPU 完整初始化和识别约 5.24 秒（本机测试，仅作观测值）。失败/混合/未知结构使用合成文字与坐标测试，没有真实失败截图验证。昵称仍应人工核对，OCR 不保证所有名字准确。

最终 `pwtools-ocr:latest` 镜像也已用独立 `--network none`、只读文件系统、无端口映射、非 root 用户容器验证：离线启动返回 `ready`，真实图片 HTTP 识别为上述三个金额，耗时 3.27 秒，`warnings=[]`；非法图片返回 `422`。原图通过只读挂载读取，验证结束删除临时容器，没有复制到仓库。

## 资源与隐私约束

- 请求流式限制为 12 MiB；支持的图片必须真正解码成功，实际格式应与请求类型相符。
- 解码前检查至多 4000 万像素，拒绝动画或多帧图片；推理长边缩至最多 2560 像素。
- 一个推理线程、零等待队列；忙时 `503` 并提供 `Retry-After: 2`。
- 读取请求体和推理各设 30 秒超时。推理超时返回 `504`；原生线程完成之前仍占用唯一任务槽，后续请求不会无限排队。
- 关闭 HTTP 访问日志；不记录原图、OCR 文本、base64 或模型异常详情。
- Docker 以非 root 用户运行，启动单个 Uvicorn worker。接口没有认证，须保持仅内部网络可达。

错误状态包括 `400`（错误长度）、`413`（体积/像素超限）、`415`（类型/格式/多帧不支持）、`422`（空内容或解码失败）、`503`（忙或推理失败）和 `504`（超时），响应为 `{"detail":"中文说明"}`。

## 开发与验证

在仓库根目录：

```powershell
python -m venv services/ocr/.venv
services/ocr/.venv/Scripts/python.exe -m pip install -r services/ocr/requirements-dev.txt
services/ocr/.venv/Scripts/python.exe -m pytest services/ocr/tests -q
```

真实图片测试不提交截图 fixture，通过本机路径显式启用：

```powershell
$env:OCR_SAMPLE_IMAGE = 'C:\path\to\success-scoreboard.png'
services/ocr/.venv/Scripts/python.exe -m pytest services/ocr/tests/test_real_sample.py -q
```

该真实样例测试断言上述三个金额，仅适用于对应样例。普通测试使用必要的文字/坐标结构，并将队员名字替换为泛化名称。不要把用户截图复制到仓库。

单独构建镜像：

```powershell
docker build -t pwtools-ocr:local services/ocr
```

本机调试可在 `services/ocr` 工作目录执行 `.venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8090 --workers 1 --no-access-log`；正式使用通过根 Compose 内部网络连接。
