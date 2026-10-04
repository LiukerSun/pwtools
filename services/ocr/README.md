# 三角洲战绩本地 OCR

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

每个队员状态独立解析。大字「撤离成功」标题不会覆盖失败或未知队员；混合状态的整体 `outcome` 为 `unknown` 并附提示。价值列缺失、金额模糊、状态缺失或未找到队员行时保留 `null` / `unknown` 和人工确认提示。没有可靠相邻列边界的单独金额截图也按未知处理。解析适用于战绩详情表，不保证其他游戏页面或改变后的布局。

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
