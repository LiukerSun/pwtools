# PWTools · 私人老板账本

面向陪玩从业者的 C++ / WebView2 桌面账本：记住每位老板的备注、每笔订单已经完成多少和还欠多少。所有记录供登录账户自己管理。先支持 Windows 桌面客户端，后续再扩展移动端。Rust API、PostgreSQL 与本地 CPU OCR 服务通过 Docker Compose 启动，截图与账本自动归档至私有 OSS。

## 已有功能与范围

- 邮箱和密码注册、登录；注册界面确认密码，账户仅保留基本登录信息。
- 老板账本首页展示所有老板的累计完成、还欠与关键备注；点击老板进入其独立订单页，时长、护航金额和待结算单数分别汇总。
- 订单以紧凑列表呈现，进行中优先、已结束折叠；主操作只有「记一场」，配置、调整、模板和场次历史放在次级入口。
- 创建订单先选四种基础模板或账号自己的个人模板，再改本次数值。个人模板保存完整默认约定，可编辑或删除；模板变化不影响已经建立的订单。
- 每位老板可建多笔单局单、护航单、小时单和对赌单；通过「订单配置」保存本单的目标、判定条件和追加规则。
- 小时单累计整数分钟；护航单累计成功撤离的净值；单局单必须某一场净值达标，不能把多场相加；对赌单按指定物品的人工判断记录赢输。
- 金额场次分别保存带出原值、假账扣除和净值；扣除需明确填写，没有假账也需填 0。原图长期保留，识别值不会直接扣账。
- 每场可手动记录进度、失败追加或调整约定，保存本场备注。各订单独立核算剩余量，超额单独显示，不自动转到其他订单。
- 导航只有老板账本和设置。截图上传与金额识别属于订单的「记一场」，设置仅保留主题、账户邮箱、退出登录和版本信息。
- 界面以老板、订单进度和操作为主，去掉页面旁白、重复状态与底部说明；规则和连接信息按需展开，错误和删除影响只在相关操作时提示。
- 原生自定义标题栏、平滑折叠侧边栏、深浅色界面。
- 页面切换、导航选中、展开、悬停、拖入截图、确认保存和图片缩放均有交互动效；遵循系统减少动态效果设置。折叠和主题偏好在当前设备保存。
- 订单内「记一场」默认导入截图，可切换手工填写，始终共用同一份结果。截图导入后改为手填仍校对同一张图，不再生成重复流水；核对假账或物品结果后入账，仍停在原订单。
- 原图长期保存到私有 OSS；所有 OCR 行、识别文本、人工校对结果和订单账本保存到 PostgreSQL，并自动归档到 OSS，按账号隔离。可查看原图、重新识别、改正记录和手动删除。

账号、老板资料及备注、订单、个人模板和每场记录通过 API 保存于服务端数据库，等待保存成功后才更新界面；同一账号在独立客户端重新登录后可查看。本地只保留外观偏好与登录会话。0.9.4 正式安装包连接 `https://pwtools.liukersun.com/api`，开发环境默认使用本机服务。邮箱仅作为登录标识，当前没有邮箱验证、找回密码或支付流程。

## 技术选型

| 层 | 技术 |
| --- | --- |
| 桌面应用 | Win32 C++20、WebView2 Evergreen、React 19、TypeScript |
| UI | Mantine 9、Mantine Form / Notifications、Lucide 图标 |
| 构建与安装包 | MSVC、CMake、Vite 7、Windows NSIS |
| API | Rust、Axum 0.8、Tokio、SQLx 0.8 |
| 数据库 | PostgreSQL 18，SQL 迁移随 API 启动执行 |
| 原图与自动归档 | 阿里云 OSS 私有对象，由 Rust 后端签名访问 |
| OCR | RapidOCR 3.9.2、ONNX Runtime CPU，模型随镜像安装 |
| 部署 | Docker Compose，独立 `api`、`postgres`、`ocr` 服务 |

界面统一使用 [Mantine](https://mantine.dev/) 的表单、通知、弹窗和主题组件，并通过 Styles API 定制桌面布局。

## 目录

```text
pwtools/
├── apps/desktop/
│   ├── native/src/         # C++ 宿主：WebView2 窗口、WinHTTP 请求与 DPAPI 会话
│   ├── native/tests/       # 本地 HTTP fixture 与 DPAPI 回归
│   ├── native/resources/   # Windows 清单、图标、运行时安装脚本
│   ├── native/installer.nsi
│   ├── src/renderer/       # 私人账本、截图、设置与浏览器预览适配
│   ├── src/shared/         # 桌面端接口类型
│   ├── vite.native.config.ts
│   ├── vite.web.config.ts
│   └── release/            # Windows 打包产物（生成后出现）
├── services/api/
│   ├── src/               # 认证、老板、订单账本、战绩截图与私有 OSS 归档
│   ├── migrations/        # 用户、老板、订单、手动流水与原图迁移
│   ├── Cargo.toml
│   └── Dockerfile
├── services/ocr/          # 本地识别、战绩表几何解析及测试
├── compose.yaml
├── .env.example
├── scripts/native-*.ps1   # SDK 准备、原生构建、开发与安装包
└── package.json           # npm workspace 和常用命令
```

## 源码提交与本地清理

提交源码时保留以下文件；根 `.gitignore` 已排除依赖、构建产物、私有配置、数据库备份和测试资料。

| 内容 | 提交范围 |
| --- | --- |
| 桌面客户端 | `apps/desktop/src/`、`native/` 源码、Vite / TypeScript 配置、`build/icon.ico`、`icon.svg` 和 `icon.png` |
| API 与 OCR | `services/api/`、`services/ocr/` 源码、Dockerfile、依赖清单与测试 |
| 数据库和公开目录 | 全部 SQL 迁移、`services/api/data/delta_items.json`、来源说明与刷新脚本；物品目录是公开静态数据 |
| 构建与部署 | `scripts/`、`deploy/`、Compose、Playwright 配置和 `tests/` |
| 项目配置与说明 | `package.json`、`package-lock.json`、`Cargo.lock`、`.env.example`、忽略规则、README 与 `CONTEXT.md` |

真实 `.env`、访问密钥、私钥、数据库备份、业务截图、录像和 `.artifacts/` 只保留在本地或受控备份中。安装包与 `native-win-x64/` 属于发布产物，不提交进源码仓库；保留最新安装包和对应 SHA-256 以便验收及交付。

可清理的目录按用途区分：

| 内容 | 清理后的影响 |
| --- | --- |
| `services/api/target/`、`apps/desktop/native/.build/`、`apps/desktop/out/` | 下次需要重新编译；`out/renderer/` 是原生构建使用的前端产物 |
| `node_modules/`、`services/ocr/.venv/`、`apps/desktop/native/.deps/` | 下次需要重新安装依赖或下载 SDK |
| `.pytest_cache/`、`__pycache__/`、`test-results/`、`playwright-report/` | 下次运行测试或 Python 程序时重新生成 |
| `release/win-unpacked/`、旧 Electron 安装包与下载缓存 | 已由原生版替代；按回退需求保留旧安装包 |
| `.artifacts/` 内历史录屏、日志与部署镜像包 | 先保留需要的验收或回退资料，再按用途清理；其中私有数据库备份应单独保留 |

不要整体删除 `apps/desktop/build/`：这里的图标是编译与安装器使用的源资产。清理编译缓存与旧包无需操作数据库卷、OSS 对象或服务器。

## 快速启动

开发客户端需要 64 位 Windows 10 或更新版本、Node.js 22.12 或更新版本，以及 Visual Studio 2022 Build Tools 的「使用 C++ 的桌面开发」、Windows SDK 和 CMake。运行已打包客户端只需要 WebView2 Evergreen；安装包会检查运行时，缺失时从微软下载并验证签名后安装。

后端需要运行 Linux 容器的 Docker Desktop / Docker Compose；通过 Docker 启动后端不需要本机安装 Rust 或 PostgreSQL。以下命令在项目根目录执行。

1. 初始化根目录环境配置：

   ```powershell
   Copy-Item .env.example .env
   ```

   将 `.env` 中的 `POSTGRES_PASSWORD` 替换为足够长的随机密码。它也会用于 PostgreSQL 连接 URL，建议使用随机十六进制或其他 URL 安全字符。配置 OSS 的区域、服务地址、桶名和访问密钥；对象使用桶内独立的 `pwtools/` 目录。Compose 需要完整 OSS 配置才能启动 API。`.env` 已加入忽略规则，不要提交；已有配置时保留现有 `.env`。OSS 密钥只放在后端使用的根 `.env`，不能放到客户端配置或源码。

2. 启动数据库、API 和 OCR：

   ```powershell
   docker compose up -d --build
   docker compose ps
   ```

   首次构建需要联网安装依赖和 OCR 模型、编译 Rust 后端，并创建数据库表；后续识别在本地 CPU 上执行，无需云端 OCR 密钥。等待三个服务健康后，可检查 [健康接口](http://localhost:8080/api/health)。正常响应为 `{"status":"ok","database":"connected"}`。OCR 端口仅在 Docker 网络内开放。

3. 安装依赖并启动桌面应用：

   ```powershell
   npm install
   npm run dev
   ```

   第一次原生构建会下载固定版本的 WebView2 SDK 和 nlohmann/json，并验证 SHA-256；它们用于编译，不进入用户运行目录。客户端使用系统共享的 WebView2 Evergreen，不再下载或打包 Electron。

   在登录页切换到注册，填写邮箱、10–128 个字符的密码和确认密码。注册成功后进入所有老板总览，再建立老板与订单。

浏览器预览：

```powershell
npm run dev:web
```

访问 [http://localhost:5173](http://localhost:5173)。桌面开发与浏览器预览共用该端口，每次启动一种模式即可。浏览器预览的登录令牌只保存在内存，刷新页面后需要重新登录。

## 老板账本使用流程

1. 在「老板账本」选择老板，进入他的独立订单页。新增老板保存后直接进入该老板。称呼与长期备注供自己查看；小时单和仅手录的对赌单可不填截图昵称，金额单或上传截图需要准确昵称。
2. 在该老板页面「新建订单」，选择基础或个人模板。填写本次金额、时长或对赌物品，名字可自动生成；护航规则用一句话展示，可展开「更多设置」修改。创建后留在该老板页面。
3. 找到本单点「记一场」，顶部直接显示已确定的老板和订单。默认上传 PNG、JPEG、WebP 截图，可点击选择文件，也可先复制截图、在截图录入界面按 Ctrl+V 粘贴上传；粘贴后继续原有识别和校对流程。也可切换手工填写；小时单直接填时长。录入方式切换保留当前结果。
4. 金额场次核对原值并明确假账扣除，没有假账可主动选择填 0；失败保留原值及净值但完成量计入 0。对赌人工选择物品结果。原图与识别结果先保存，界面只显示原图和本场结果；点击「确认入账」后才更新订单，保存失败保留填写内容。
5. 保存后仍停在原订单。订单的次级入口可查看场次、配置、调整约定或保存为个人模板；已结束订单默认折叠。个人模板不绑定老板，开新单改数值不会回写模板；模板修改和删除不改变旧订单。
6. 展开本单的场次账本，在截图流水中「查看此场」即可核对原图和修改结果；尚未确认的截图从「待确认截图」继续填写，仍在同一订单内。历史未归属订单的记录保持原归属，不自动加入新订单。截图最大 12 MiB、4000 万像素。

小时和护航订单的任务总量 = 初始约定 + 保底追加 + 约定调整；还欠 = max(任务总量 − 已完成, 0)。例如护航目标 1000 万，原值 350 万扣假账 50 万，净完成 300 万，再追加 100 万，剩余 800 万。单局目标 100 万，两场各净带出 60 万仍未达标，下一场仍需独立达到 100 万。老板总览把剩余小时、累计护航金额、待达标单局数和待结算对赌数分别展示。

护航可以设置「仅失败」「失败且净值低于标准」或「任意结果净值低于标准」触发追加；追加可每场手填、固定金额或补足标准与净值的差额。未触发时追加为 0，历史场次保存当时确认的金额。订单尚无流水或截图草稿时可更改类型和规则；已有记录后核心约定锁定，名称、备注和未来场次默认追加仍可修改。

对赌物品目录结合用户指定的 DDDJ 简体历史目录及公开官方国际服 Wiki 表，包含 2,296 个去重 ID、11 类，可搜索和按分类筛选；它不代表国服最新全量目录。目录缺项可手填，既有订单保存物品名称快照，刷新目录不改旧约定。来源与刷新方式见 [物品目录说明](services/api/data/README.md)。

截图只有已确认才进入账本。失败的计入完成量为 0，物资原值和扣除仍保留用于标准判断。重复上传或确认不重复扣账；修改、撤销确认或删除截图会重算订单。重新识别保留已经保存的人工结果和假账扣除；识别失败保留原图、草稿和已填写结果。老板匹配区分大小写，除两端空白外要求昵称一致；历史截图保留导入时昵称。

「补充信息」中的场次时间点击整个输入框即可打开中文日历，支持小时分钟、现在和清空；时间按北京时间保存，留空则使用入账时间。日历打开时按 Esc 只关闭日历，记场内容继续保留。

截图在后端按识别服务的单 worker 容量排队，排队和识别各有 35 秒上限；服务返回可重试的繁忙响应时有限重试。界面区分服务繁忙、超时、没有文字和没有定位到队员行。已有失败草稿可在同一个记场面板点击「重新识别」重试，人工填写的结果仍保留。

目前针对三角洲行动的战绩详情表解析「带出价值」列和队员撤离状态，其他界面或裁掉表头可能需要人工补录。提供的真实成功截图已识别出 3,314,221、1,867,449、97,593；失败、混合状态和缺失字段使用合成解析测试验证，尚未收到真实失败截图。识别结果需要人工确认。

## 构建与 Windows 安装包

```powershell
npm run build
npm run package:win
```

Windows 安装包生成在 `apps/desktop/release/`，当前版本的文件名为 `PWTools-Setup-0.9.4.exe`，应用可执行文件为 `PWTools.exe`，卸载程序为 `Uninstall-PWTools.exe`。文件与默认安装路径均不带空格；默认安装到 `%LOCALAPPDATA%\Programs\PWToolsNative`，与旧 Electron 客户端分开。程序文件位于 `apps/desktop/release/native-win-x64/`。安装包不包含 Docker 后端或数据库，正式版通过 HTTPS 访问已部署的 API。[本地安装包](apps/desktop/release/PWTools-Setup-0.9.4.exe)。此次上线范围为后端，安装包保留在本地。

制作安装包需要 NSIS 3 的 `makensis.exe`，可安装到默认位置或加入 `PATH`；脚本也可复用本机既有的 NSIS 缓存。当前未配置 Windows 代码签名。

首次打开原生版需重新登录，原有账号、老板、订单和截图仍在服务器。新版使用独立 DPAPI 会话文件，不覆盖旧 Electron 会话；卸载保留用户数据与共享 WebView2 运行时。旧版安装包保留，可按需回退。

0.9.4 实测安装包为 529,780 字节（约 0.53 MB），完整程序文件为 1,693,432 字节（约 1.69 MB）。相比 0.8.3 的 115,846,874 字节安装包和 434,074,966 字节程序目录，分别减少 99.54% 和 99.61%。这些数字不包含共享 WebView2 运行时、运行缓存和用户数据；运行时缺失时，安装器会另行下载微软安装程序。

## 配置

| 变量 | 位置 / 用途 | 默认值 |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | 根 `.env`，数据库密码，必须设置 | 无可用默认值 |
| `POSTGRES_PORT` | 根 `.env`，数据库映射到本机的端口 | `5432` |
| `API_PORT` | 根 `.env`，API 映射到本机的端口 | `8080` |
| `API_BIND_IP` | 根 `.env`，API 对宿主机的绑定地址 | `127.0.0.1` |
| `ALLOWED_ORIGINS` | 根 `.env` / API 环境，逗号分隔的明确浏览器来源 | `http://localhost:5173` |
| `TRUSTED_PROXY_IPS` | API 环境，可信反向代理的精确 IPv4/IPv6，逗号分隔；仅这些来源可提供 `X-Real-IP` | 空，直接使用 TCP 来源 |
| `RUST_LOG` | 根 `.env` / API 环境，日志级别 | `info,tower_http=info` |
| `PWTOOLS_API_URL` | 原生构建或运行时的环境变量，公开 API 地址 | `http://localhost:8080/api` |
| `PWTOOLS_DATA_DIR` | 原生程序测试或开发时的独立数据目录 | `%APPDATA%\PWTools` |
| `VITE_API_URL` | `apps/desktop/.env`，浏览器开发配置 | `http://localhost:8080/api` |
| `DATABASE_URL` | 本机启动 Rust API 时设置 | Docker 内自动注入 |
| `OCR_URL` | Rust API 内部 OCR 地址，不含 `/recognize` | Compose 为 `http://ocr:8090` |
| `OSS_REGION` | 根 `.env` / API 环境，OSS 区域 | 与桶所在区域一致 |
| `OSS_ENDPOINT` | 根 `.env` / API 环境，OSS 服务地址 | 区域服务地址，不含桶名和对象路径 |
| `OSS_BUCKET` | 根 `.env` / API 环境，已有私有桶 | 必须设置 |
| `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` | 仅后端根 `.env` / API 环境，OSS 访问凭证 | 必须设置，不能进入客户端 |
| `OSS_PREFIX` | 根 `.env` / API 环境，独立对象目录 | 固定使用 `pwtools/` |
| `OSS_SECURITY_TOKEN` | 根 `.env` / API 环境，临时 STS 凭证 | 使用长期凭证时留空 |

客户端 API 地址需要包含 `/api`。`npm run package:win` 默认从 `deploy/desktop-api-url.txt` 读取正式 HTTPS 地址，并在 NSIS 打包前检查生成配置；开发构建每次明确选择本机地址，避免 CMake 缓存残留。构建自定义服务器版本时在当前终端设置：

```powershell
$env:PWTOOLS_API_URL = 'https://api.example.com/api'
npm run package:win
Remove-Item Env:PWTOOLS_API_URL
```

浏览器预览通过 `apps/desktop/.env` 中的 `VITE_API_URL` 配置。原生 C++ 模块接受 HTTPS 地址或本机 HTTP 地址；运行环境中的 `PWTOOLS_API_URL` 优先于编译配置。浏览器来源应加入 `ALLOWED_ORIGINS`，如 `https://preview.example.com,http://localhost:5173`，不要设置为 `*`。

## API

普通请求和响应使用 JSON；上传及原图接口使用二进制，退出登录和删除成功返回 `204`。需要登录的接口使用 `Authorization: Bearer <token>`。

| 方法 | 路径 | 登录 | 功能 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | 否 | 检查 API 和数据库连接 |
| `POST` | `/api/auth/register` | 否 | 注册并返回 `token`、`user` |
| `POST` | `/api/auth/login` | 否 | 登录并返回 `token`、`user` |
| `POST` | `/api/auth/logout` | 是 | 撤销当前会话 |
| `GET` | `/api/me` | 是 | 读取账户 `id`、`email`、`created_at` |
| `GET/POST` | `/api/bosses` | 是 | 所有老板 / 新建老板 |
| `GET/PATCH` | `/api/bosses/{id}` | 是 | 查看 / 更新本人老板称呼、游戏身份与备注 |
| `POST` | `/api/bosses/{id}/orders` | 是 | 为该老板建立一笔独立订单 |
| `GET` | `/api/orders` | 是 | 本人全部订单，可按 `boss_id` 筛选 |
| `GET/PATCH` | `/api/orders/{id}` | 是 | 单笔订单投影 / 修改订单配置 |
| `GET/POST` | `/api/order-templates` | 是 | 个人模板列表 / 保存完整默认约定 |
| `PATCH/DELETE` | `/api/order-templates/{id}` | 是 | 修改 / 删除本人模板，不改变已有订单 |
| `GET` | `/api/catalog/items` | 是 | 对赌物品搜索、分类与分页目录 |
| `GET/POST` | `/api/orders/{id}/entries` | 是 | 分页流水 / 记录进度、失败追加或调整约定 |
| `DELETE` | `/api/orders/{order_id}/entries/{entry_id}` | 是 | 删除手动流水并重算余额 |
| `GET/PATCH` | `/api/matches/settings` | 是 | 读取 / 保存 `boss_id` 与 `boss_player_name` |
| `POST` | `/api/matches` | 是 | 原图上传、老板匹配，返回 `{record,duplicate}` |
| `GET` | `/api/matches?order_id={id}&page=1&page_size=20` | 是 | 指定订单分页截图记录 |
| `GET` | `/api/matches/stats?order_id={id}` | 是 | 指定订单的已确认统计及草稿数 |
| `GET/PATCH/DELETE` | `/api/matches/{id}` | 是 | 查看 / 校对 / 删除本人记录 |
| `GET` | `/api/matches/{id}/image` | 是 | 获取完整原图 |
| `POST` | `/api/matches/{id}/recognize` | 是 | 重试 OCR |

注册与登录请求字段均为 `email`、`password`；确认密码只在注册界面校验。账户响应仅包含 `id`、`email`、`created_at`。

密码长度为 10–128 个字符。老板称呼与游戏身份属于私人老板记录。错误响应形如 `{"error":{"code":"INVALID_CREDENTIALS","message":"邮箱或密码不正确，请重新输入"}}`。

战绩上传 body 是原图字节，`Content-Type` 为 `image/png`、`image/jpeg` 或 `image/webp`，`X-File-Name` 为 URL 编码文件名，`X-Order-Id` 指定单局、护航或对赌订单。校对字段包括 `player_name`、`outcome`（`success/failed/unknown`）、`amount`（原值）、`fake_amount`（明确假账扣除）、`item_obtained`（人工物品结果）、`failure_extra_amount`、`confirmed`、`played_at`（RFC3339 或 null）、`note`。金额单必须明确填写 0 至原值之间的扣除；服务端计算 `net_amount` 与 `credited_amount`，失败计入 0 但保留原值及净值。金额上限 9,000,000,000,000，备注最多 1000 字。后端保存原图对象引用、SHA-256 和尺寸，通过已登录 API 读取私有原图。OCR 不可用时仍保存截图草稿。完整四类配置与流水契约见 [API 说明](services/api/README.md)。

密码以带随机盐的 Argon2 哈希保存。登录会话使用随机 opaque token，有效期 7 天；数据库只保存 token 的 SHA-256 摘要。C++ 模块通过 WinHTTP 请求 API，并使用 Windows DPAPI 加密保存会话；令牌不返回 React 页面。会话文件按 API 地址隔离。WebView2 页面通过受限 JSON 消息桥调用操作；生产页面固定在本地虚拟 HTTPS 来源，禁用跨页导航、弹出窗口、宿主对象与页面直接联网。

## 本机开发 Rust API

需要 Rust 1.88 或更新版本；Windows 使用 MSVC 工具链时还需要 Visual Studio C++ Build Tools。下面复用 Compose 数据库，并停止 Compose API 以腾出 `8080` 端口。示例读取根 `.env` 中的密码，不向终端输出密码或连接串：

```powershell
docker compose stop api
$dbPassword = ((Get-Content .env | Where-Object { $_ -match '^POSTGRES_PASSWORD=' }) -split '=', 2)[1]
$env:DATABASE_URL = "postgres://pwtools:${dbPassword}@localhost:5432/pwtools"
$env:API_HOST = '127.0.0.1'
$env:API_PORT = '8080'
$env:ALLOWED_ORIGINS = 'http://localhost:5173'
$env:OCR_URL = 'http://localhost:8090'
cargo run --manifest-path services/api/Cargo.toml --bin pwtools-api
```

如果修改过 `POSTGRES_PORT`，同时修改上面的连接端口。结束本机 API 后执行 `docker compose up -d api` 可恢复容器服务。

本机 Rust 开发需要单独启动 OCR 才能自动识别；Compose 默认不向宿主机映射 OCR，按照 [OCR 开发说明](services/ocr/README.md) 启动本机服务。没有 OCR 时仍能保存原图和人工校对。

## 检查与测试

0.9.4 的设置只保留外观、账号和版本，不再显示连接状态、API 地址及重试入口；同时修复小时单场次流水使用金额 0 误显示为 0 分钟的问题。正式后端已上线 `https://pwtools.liukersun.com/api`，旧数据完整迁移；新安装包默认连接此地址，保留无场次展开和 Ctrl+V 截图上传功能。

18 项浏览器回归、18 项 Rust 单元测试与 fmt/check/clippy 通过。实际 WebView2 在空白客户端目录重新登录，读回同一账号的老板资料、订单、45 分钟流水和模板。公网合成结算图真实 OCR、原图字节/SHA-256、人工校对、重新登录与 API 重启后读回一致，跨账号访问返回 404、匿名访问返回 401。最终安装包验收覆盖 7 文件哈希、三次普通启动与恢复、公网登录会话重启和退出、卸载及原注册项/快捷方式恢复；真实剪贴板写入测试改为显式 opt-in，常规验收跳过，不操作用户剪贴板。

0.9.3 支持在订单「记一场」的截图录入界面按 Ctrl+V 粘贴图片，复用文件选择的类型、大小校验、原图上传和识别流程。连续粘贴不会重复上传，已有原图不会被替换，上传结果不确定时仅可重试原图；普通文字和手工模式继续使用正常粘贴。没有新增后台剪贴板读取或原生权限放开。

3 项独立浏览器回归验证粘贴原图字节、订单关联、识别回填、重复拦截及 503 后的原图重试，原有 2 项识别校对/日期流程通过；0.9.3 实际 WebView2 程序用模拟粘贴事件验证上传桥、识别和预览。类型检查、前端与 C++ Release 构建、安装的全部 7 个文件哈希、三次普通启动与恢复、登录会话重启及卸载通过，测试安装与注册项、快捷方式均已恢复。0.9.2 的独立真实 Ctrl+V 输入探针确认系统粘贴事件提供 PNG 文件，但该探针原剪贴板快照写回后的完整格式等价校验未通过；后续上传回归使用模拟事件。

0.9.2 修复没有场次的订单展开后先下拉再回弹：场次加载行与空状态采用相同高度，未加载出内容的待确认截图不再临时撑开面板。9 项浏览器回归覆盖不同响应时机、流水与截图请求不同步、已有截图和错误重试；实际打包版 WebView2 小时单、护航单在 400 毫秒响应延迟下逐帧测量回弹均为 0 像素。版本同步至 0.9.2，打包脚本按 UTF-8 读取版本号，输出 `PWTools-Setup-0.9.2.exe` 及 SHA-256 校验文件。

0.9.2 安装验收已核对全部 7 个程序文件的 SHA-256，实际安装后的三次普通启动与最小化恢复、原生登录、DPAPI 会话重启恢复、退出和卸载通过；验收后已恢复原卸载项与快捷方式并清理测试安装。类型检查、前端与 C++ Release 构建、7 项消息桥单测及原有 4 项订单流程测试通过，客户端扫描未发现 OSS 凭证或 `.env`。此次没有改动后端与数据库结构。

0.9.1 修复普通启动时白边、透明或空白窗口：宿主窗口先显示，再创建 WebView2，使用不透明背景和完整客户区，并随最小化、恢复同步控制器可见性。原版在未连接调试器、未激活或调整窗口的普通启动中连续两次复现空白；仅调整显示时机后恢复登录界面。新增 `test:startup` 使用独立临时数据目录、不连接调试器、不访问真实账户，直接捕获本进程原生窗口检查实际画面及最小化恢复；安装验收也先运行同一检查。此前 0.9.0 的桌面验收使用隐藏窗口与 CDP，只验证了页面内容，没有覆盖用户实际看到的窗口。

最终 0.9.1 发布文件已通过 5 项原生回归，包括真实截图 OCR 与未决保存关闭保护。实际安装后的程序连续三次普通启动及最小化恢复通过，边缘采样未发现白框；安装文件 SHA-256 与发布文件逐一一致，登录、重启恢复、退出和卸载通过。验收已恢复原有卸载项及快捷方式并移除测试安装，客户端扫描未发现 OSS 凭证或 `.env`；此次没有改动后端与数据库结构。

0.9.0 已替换 Electron 主进程、preload 和打包依赖，使用 Win32 C++20 / WebView2 Evergreen；React / Mantine 组件、主题与动效保留。已通过 TypeScript、7 项消息桥单测、本地 HTTP / DPAPI fixture、10 项浏览器场景和 5 项原生桌面场景。原生验收覆盖登录重启与退出、四类订单和模板、中文日期、深浅主题与 960×760 布局、真实 OCR、原图 SHA-256、去重和重启恢复。未保存关闭保护同步表单状态；服务器已提交但响应断开或 JSON 无效时，保留同一幂等请求，经过限流重试也只产生一条流水。

实际 NSIS 安装、已安装程序登录 / 重启 / 退出、卸载均已验证，安装的 7 个文件与发布文件逐个 SHA-256 一致；测试后恢复原有注册项与快捷方式。原生程序目录扫描确认没有后端 OSS 凭证、`.env` 或浏览器运行时。此次没有修改 Rust 后端、数据库结构或旧账户数据。

此前框架和 OCR 已通过 Rust 编译 / 格式 / Clippy、真实 PostgreSQL 隔离集成测试、OCR 13 项测试与最终镜像断网 HTTP 识别。真实截图验证覆盖非首位老板匹配、人工校对、原图 SHA-256、去重、重启恢复及无匹配草稿。

0.5.0 多老板总览曾通过四项浏览器交互与两项打包版 Electron 回归，覆盖同一老板的多笔护航独立记账、全局选择目标、草稿切换保护、搜索后返回、删除重算和重启恢复。实际打包程序用五位老板、同老板三笔订单及真实 OCR 样例验证过深浅主题、960×760 布局与减少动态效果，保存和取消按钮完整可见。真实 PostgreSQL 测试覆盖账号隔离、幂等提交、并发越界回滚、截图确认与修正，以及旧数据迁移后原图完整。

0.6.0 私人账本已通过 TypeScript、Rust fmt/check/clippy、9 项单元测试、真实 PostgreSQL 的账号升级/账本/战绩/OSS 存储与归档回归、4 项浏览器交互和 2 项打包版 Electron 测试。真实 OSS 已迁移全部 37 张历史截图（失败 0），新上传原图、识别和校对 JSON、账本镜像及不可变版本均已读回核对；原图匿名请求被拒绝。所有原图已转存 OSS，归档队列已同步完成。实际新版客户端以五位老板、同老板三笔订单验证了真实 OCR、深浅主题、960×760 布局、侧栏折叠、减少动态效果和导航保护，没有页面异常。安装包已生成，扫描确认不包含后端 OSS 密钥或 `.env`。Windows 安装包尚未配置代码签名。

0.7.0 四类订单已通过 TypeScript、Rust fmt/check/clippy、11 项单元测试、6 项真实 PostgreSQL 集成、7 项浏览器交互和 2 项打包版 Electron 测试。验证单局两场各净值 60 万不能完成 100 万目标、假账必须明确填写、失败原值保留但计入 0、条件追加、对赌人工结算、规则锁定、目录搜索与手填、固定规则历史快照及幂等重放。真实升级前后 41 张旧图的总字节和 SHA 指纹、63 笔订单目标与默认值总量、46 条流水数量总量一致。实际客户端以五位老板、同老板四种订单验证原值 1,867,449 扣除 500,000 后净计入 1,367,449、深浅主题、960×760 布局及减少动态效果，无页面异常。OSS 原图、包含新金额字段的记录 JSON、账本镜像和不可变版本各抽取 3 项读回核对，匿名原图被拒绝，归档队列已同步。PWTools-Setup-0.7.0.exe 已生成，客户端扫描未包含 OSS 凭证或 `.env`。

0.8.0 简化交互已通过 TypeScript、Rust fmt/check/clippy、12 项单元测试、7 项真实 PostgreSQL 集成、9 项浏览器交互和 3 项实际打包版 Electron 测试。覆盖先选老板、独立订单页、统一记场、个人模板完整默认值和编辑删除不影响旧单。真实 OCR 等待期间切换手工填写，金额、假账、撤离结果、时间和备注保留；确认更新同一截图记录，重复已确认截图不自动撤销或重复入账。模拟服务器已提交但响应丢失、重试限流后再核实，三次请求保留同一结果与幂等键，仅产生一条流水；普通窗口关闭和原生关闭均保护未决结果，未保存表单可继续填写。

实际 0.8.0 客户端使用五位老板与四类订单完成 22 张界面截图和约 49 秒交互录屏验收，检查深浅主题、960×760 窗口、侧栏折叠、长表单操作按钮、订单定位、完成单折叠与减少动态效果，无页面异常。升级前后 47 张旧图总字节 222,531,370、96 笔旧订单目标总量 450,004,400、76 条旧流水数量总量 73,601,530 一致。OSS 原图、记录 JSON、账本镜像和不可变版本各抽取 3 项读回一致，包含 1 条个人模板的完整配置；原图匿名访问被拒绝，52 张截图均存于 OSS，记录和账户归档队列已同步。PWTools-Setup-0.8.0.exe 已生成，客户端扫描未包含 OSS 凭证或 `.env`。

0.8.1 已移除独立「战绩记录」页面及所有相关跳转，主导航只保留老板账本和设置。上传识别在订单「记一场」中完成；订单历史可继续填写待确认截图，或直接查看已确认场次的原图并保存校对。关闭原图大图保留记场面板。已通过 TypeScript、Rust fmt/clippy、真实 PostgreSQL 截图筛选与归单集成测试、9 项浏览器交互和 3 项实际打包版 Electron 测试，覆盖草稿恢复、同记录确认、真实 OCR、原图完整性、去重、重启恢复与未决提交保护。

本次后端升级前后，52 张旧图的 SHA 指纹和总字节 246,204,920、134 笔订单目标总量 558,005,979、108 条流水数量总量 94,401,800 均一致。OSS 原图、记录 JSON、账本镜像和不可变版本各抽取 3 项读回核对，包含个人模板完整默认值；原图匿名访问被拒绝，记录和账户归档队列已同步。PWTools-Setup-0.8.1.exe 已生成，客户端扫描未包含 OSS 凭证或 `.env`。

实际 0.8.1 客户端完成 24 张界面截图和约 60 秒交互录屏，验证深浅主题、真实 960×760 视口、侧栏折叠、长表单固定操作区、订单内原图校对与待确认场次恢复，没有页面异常。真实样例仍识别出 3 名队员；累计 66 张截图均存于 OSS，记录与账户归档队列为空。

0.8.2 精简个人用户界面：去掉页面旁白、重复状态、底部说明、登录保存策略和常驻表单教程；登录与注册使用明确按钮，手工记场使用紧凑表单，未触发追加时隐藏追加区域，规则和连接信息按需展开。已通过 TypeScript、9 项浏览器交互和 3 项实际打包版 Electron 测试，覆盖四类订单、人工假账、真实 OCR、模板、登录重启恢复与未决保存保护。实际程序完成 26 张截图及约 39 秒交互录屏，验证深浅主题、960×760 视口、侧栏和长表单按钮，无页面异常。PWTools-Setup-0.8.2.exe 已生成，客户端扫描未包含 OSS 凭证或 `.env`；本次未改后端或数据库结构。

0.8.3 移除「识别详情」和「识别文字」，记场只保留原图与本场结果。场次时间使用整框可点击的中文日期时间选择器，支持分钟精度、现在和清空，按北京时间保存；Esc 只关闭日历。重新识别成功回填尚未手工修改的金额与撤离结果，并清除对应旧校验提示，保留手工结果、假账及备注。已通过 TypeScript、3 项浏览器回归和 3 项实际打包版 Electron 测试，覆盖原生控件故障复现、日期选择与 UTC 保存、成功识别恢复、登录重启和未决提交保护。实际 0.8.3 程序完成 5 张界面截图，验证深浅主题、960×760 视口、真实原图和日期时间保存，无页面异常。PWTools-Setup-0.8.3.exe 已生成，客户端扫描未包含 OSS 凭证或 `.env`；本次未改后端或数据库结构。

```powershell
npm run typecheck
npm run build
npm run test:bridge
npm run test:native-api
cargo fmt --manifest-path services/api/Cargo.toml --check
cargo check --manifest-path services/api/Cargo.toml
cargo clippy --manifest-path services/api/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path services/api/Cargo.toml
npm run test:e2e
npm run test:desktop
npm run test:startup
npm run test:installer
```

端到端测试需要运行后端；浏览器测试首次执行前运行 `npx playwright install chromium`。桌面测试需先执行 `npm run build`，测试会使用独立的临时应用数据目录。

真实截图端到端测试需要显式指定本机样例，用户原图不会提交进仓库：

```powershell
$env:PWTOOLS_OCR_SAMPLE = 'C:\path\to\scoreboard.png'
npm run test:desktop
Remove-Item Env:PWTOOLS_OCR_SAMPLE
```

该测试覆盖老板匹配、界面上传和确认、二进制消息桥、重复上传、原图 SHA-256、桌面重启持久化及未匹配老板保留草稿。

`test:bridge` 验证 JavaScript 消息关联、图片字节、错误、超时和关闭事件；`test:native-api` 仅使用本地 HTTP fixture 与独立 DPAPI 临时目录，不读取真实后端配置。`test:startup` 连续三次检查普通启动和最小化恢复，截图只包含独立测试窗口。`test:installer` 需要预先安装 WebView2，使用工作区内唯一目录安装并验收程序，先检查普通启动，再验证登录和重启，随后卸载，恢复原有卸载注册项和快捷方式；不调用旧客户端的卸载程序。

验证 Windows 打包后的程序可执行：

```powershell
$env:PWTOOLS_E2E_EXECUTABLE = (Resolve-Path 'apps/desktop/release/native-win-x64/PWTools.exe').Path
npm run test:desktop
Remove-Item Env:PWTOOLS_E2E_EXECUTABLE
```

Rust 真实数据库集成测试默认标为 `ignored`。先按上面的本机开发示例设置 `DATABASE_URL`，确保该本地 PostgreSQL 账号具有 `CREATE DATABASE` 权限，再显式执行：

```powershell
cargo test --manifest-path services/api/Cargo.toml --tests -- --ignored
```

测试创建随机名称的独立数据库，执行认证、账户隔离、会话撤销、多老板多订单与截图归单，以及原图保存、OCR 失败、分页、去重、统计和删除验证后删除测试数据库，不修改连接串指向的原数据库。API、OSS 迁移与测试细节见 [services/api/README.md](services/api/README.md)。

## 服务管理与部署

正式后端位于 `39.106.63.14` 的 `/opt/pwtools`，使用 `deploy/compose.production.yaml` 独立运行 PostgreSQL、API 和 OCR。API 仅映射 `127.0.0.1:8187`，数据库与 OCR 不映射公网端口；现有 Openresty 通过 `deploy/pwtools.nginx.conf` 提供 `pwtools.liukersun.com` 的 HTTPS 服务。该域名的 Cloudflare A 记录为 DNS-only，反向代理覆盖客户端 IP 头，API 只信任专用桥网关 `172.30.94.1`。

服务端 `.env` 单独保存在服务器，权限 600；凭据不进入源码包或安装包。管理命令：

```sh
cd /opt/pwtools
docker compose --env-file /opt/pwtools/.env -f deploy/compose.production.yaml ps
docker compose --env-file /opt/pwtools/.env -f deploy/compose.production.yaml logs -f api
```

现有数据通过完整 PostgreSQL 备份迁移，API 上线前核对全部 11 张表的数量与内容摘要一致；本机旧 API 已停止，以避免两套数据库向相同 OSS 目录分别归档。原数据库卷与迁移备份保留。开发测试若另起本机服务，应使用独立数据库和 OSS 前缀，避免恢复旧库后继续双写。

Let's Encrypt 证书通过 Certbot 自动续期，`deploy/renew-certificate.sh` 仅处理此域名并按 Compose 标签定位 Openresty 重载。`pwtools-backup.timer` 每天北京时间 03:30 左右运行完整数据库备份，保存到 `/opt/pwtools/backups`，权限 600，附 SHA-256，保留约 14 天。备份不包含存于 OSS 的原图字节；应同时保护 OSS 对象。升级镜像前先备份数据库，回退时保持数据库与镜像兼容。

```powershell
docker compose logs -f api
docker compose down
docker compose up -d
```

数据库通过 `postgres_data` 命名卷持久化，普通 `docker compose down` 保留数据。修改已有数据库卷的 `.env` 密码不会自动修改 PostgreSQL 用户密码，应在数据库中同步修改后再更新配置。

PostgreSQL 是老板、订单、流水和校对结果的权威数据源，OSS 保存原图及自动归档副本。对象全部位于桶内独立目录，不使用邮箱或老板昵称作为路径：

```text
pwtools/users/<accountUUID>/
├── ledger.json
├── archives/ledger-<revision>.json
└── bosses/<bossKeySHA256>/orders/<orderUUID或unassigned>/matches/<matchUUID>/
    ├── original.png        # 或 original.jpg / original.webp
    └── record.json
```

`record.json` 自动保存该场 OCR 队员行、识别文本和人工校对结果；`archives/ledger-<revision>.json` 按版本保留不可变的本账号账本快照，包含老板、订单、手工流水和截图记录，不包含密码或会话令牌。`ledger.json` 提供便于查看的当前镜像，版本归档防止多实例旧同步任务覆盖后丢失唯一副本。后端定期同步，归档失败保留重试任务，副本可能稍后更新。删除截图会同步清理对应的原图和记录副本；账户账本归档随变更新增版本。客户端只访问需登录的 API，不接收 OSS 密钥或私有对象签名地址。

升级前已有的 PostgreSQL `BYTEA` 原图需要使用后端迁移命令转存 OSS；迁移会先校验原图，成功后才清除数据库内对应字节，失败保留旧图。操作范围和命令见 [API 存储管理说明](services/api/README.md)。

长期保存需要定期备份 PostgreSQL，并保护 OSS 对象和验证恢复。`ledger.json` 是自动归档快照，不能代替数据库备份。`docker compose down -v` 会删除数据库卷及账本、账户和旧版数据库原图；OSS 对象不会随容器卷删除，但失去数据库后不能仅靠重启客户端恢复账本。可生成并取出数据库备份：

```powershell
docker compose exec -T postgres pg_dump -U pwtools -d pwtools -Fc -f /tmp/pwtools.backup
docker compose cp postgres:/tmp/pwtools.backup ./pwtools.backup
docker compose exec -T postgres rm /tmp/pwtools.backup
```

默认 API 和数据库端口只映射到本机回环地址。向其他设备提供 API 时，使用 HTTPS 反向代理并配置明确的 CORS 来源，再将客户端 API 地址改为相应的 HTTPS 地址。当前 Compose 不提供 TLS 终结；正式部署还需配置数据库备份和恢复策略，数据库端口无需对公网开放。
