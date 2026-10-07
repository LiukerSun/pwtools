# PWTools API

Rust 2024 + Axum 0.8 + SQLx 0.8。启动时自动执行 `migrations/`，运行时 SQL 不要求编译机器连接数据库。二进制名称是 `pwtools-api`。

## 本地启动

从项目根目录启动 Docker Compose 中的 PostgreSQL，再为当前终端配置 `DATABASE_URL`，执行 `cargo run --manifest-path services/api/Cargo.toml`。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 必填 | PostgreSQL 连接串；生产环境通过秘密管理注入 |
| `API_HOST` | `0.0.0.0` | 监听 IP |
| `API_PORT` | `8080` | 监听端口 |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | 逗号分隔的明确 Origin，不接受通配符 |
| `OCR_URL` | `http://ocr:8090` | 后端配置的内部 OCR 服务地址；客户端不能指定识别服务或外链 |
| `RUST_LOG` | `pwtools_api=info,tower_http=info` | 日志级别 |

原生桌面版通过 C++ 宿主中受限的 API 请求桥访问服务端，WebView2 负责界面渲染；开发浏览器只接受配置的 CORS Origin。

## 接口

所有路径带 `/api`。普通请求和响应为 JSON；战绩上传和原图下载使用二进制，退出和删除成功返回空的 `204`。受保护接口需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ "status": "ok", "database": "connected" }`，数据库断开返回 `503` |
| POST | `/auth/register` | `{ "email", "password" }` | `201`，`{ "token", "user" }` |
| POST | `/auth/login` | `{ "email", "password" }` | `{ "token", "user" }` |
| POST | `/auth/logout` | — | `204`，撤销当前会话 |
| GET | `/me` | — | 当前基本账户对象 |

用户对象仅含 `id`、`email`、`created_at`。UUID 和 UTC 时间以字符串返回。

账户用于管理自己的私人账本，没有个人展示资料或接单状态；`PATCH /me` 返回 405。升级迁移精准删除旧资料字段，保留密码、会话、老板备注、订单和战绩。旧客户端注册请求中的 `display_name` 被兼容忽略。

邮箱去除两端空白并转为小写，只接受普通 ASCII 邮箱格式，唯一性由数据库保障。密码需 10–128 个字符；普通 JSON 请求上限 16 KiB。

统一错误格式为 `{ "error": { "code": "...", "message": "中文提示" } }`。常见错误：`VALIDATION_ERROR`（422）、`INVALID_JSON`（400）、`INVALID_CREDENTIALS` / `UNAUTHORIZED`（401）、`EMAIL_EXISTS`（409）、`RATE_LIMITED`（429）。

## 老板档案与订单账本

所有档案、订单和场次均按当前账号隔离，跨账号访问返回未找到。UUID 用于明确归属；全局老板设置只兼容旧未分配战绩，不用于新订单记账。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/bosses` | 搜索 `?q=` 或创建老板；列表返回 `{ items }` |
| GET / PATCH | `/bosses/{id}` | 查看余额汇总或修改老板称呼、游戏 ID、截图昵称、长期备注 |
| GET | `/orders?boss_id={id}` | 指定老板或当前账号所有订单，返回 `{ items }` |
| POST | `/bosses/{id}/orders` | 建立小时单、护航单或单局单 |
| POST | `/orders/{id}/transfer` | 保存预计转单快照，退出待打；此时不计实际收入 |
| POST | `/orders/{id}/transfer-action` | 确认结账、撤销未收付款转单、调整保留收入或确认退款 |
| GET / PATCH | `/orders/{id}` | 查看订单投影或修改订单配置 |
| GET / POST | `/orders/{id}/entries` | 分页查看场次账本或添加手工进度、失败追加、约定调整 |
| DELETE | `/orders/{id}/entries/{entry_id}` | 删除手工记录并重算余额；截图场次需通过截图接口修改 |

老板输入为 `{ display_name, game_id, game_name, notes }`，称呼 1–80 字，游戏 ID 和截图昵称各 0–80 字，长期备注最多 2000 字。护航单和单局单需要截图昵称非空；小时单可仅用手工时长记录。

订单输入保留 `{ title, kind, target_quantity, failure_default_quantity, note }`，并支持 `failure_trigger`、`failure_standard_quantity`、`failure_mode`。`hourly` 目标为整数分钟；`escort` 和 `single_round` 目标为整数哈夫币。目标大于 0，金额和时长上限为 9000000000000；订单备注最多 2000 字。

护航追加触发条件为 `failed`（撤离失败）、`failed_below_standard`（失败且净值低于标准）或 `below_standard`（任意结果净值低于标准）。追加方式为 `manual`（本场明确填写，0 有效）、`fixed`（订单固定值）或 `shortfall`（标准减本场净值，最低为 0）。未触发时追加为 0。固定追加按本场开始记录时的配置保存，后续修改默认值不会改变历史场次。

`configuration_locked` 表示订单已存在手工记录或截图草稿。此时类型、目标、触发条件、计算方式和标准不能改变；订单名称、备注和未来场次的默认追加量仍可修改。

手工场次输入包含 `{ kind, quantity, occurred_at, note, idempotency_key }`。小时单 `progress` 的 `quantity` 是大于 0 的分钟数。护航单和单局单 `progress` 需明确传入 `amount`（带出原值）、`fake_amount`（假账扣除，0 有效）和 `outcome`，并按护航规则填写 `failure_extra_amount`；输入 `quantity` 与原值一致，返回流水中的 `quantity` 为净值。净值为 0 的场次可以记录。兼容旧 `failure` 追加流水；`adjustment` 为小时单或护航单非零有符号约定变化，单局单不支持调整。备注最多 2000 字，幂等 UUID 防止重试重复记账。分页为 `page=1&page_size=20`，每页最多 100 条。

小时单和护航单余额直接投影手工流水与已确认截图：任务总量 = 初始约定 + 本场追加 + 约定调整；剩余 = max(任务总量 − 已完成, 0)。护航只累计成功撤离的净值。单局单 `completed_quantity` 和 `best_round_quantity` 为成功场次的最高净值；未有单场达标时 `remaining_quantity` 始终是完整目标，不能跨场累加。老板汇总分别返回剩余小时分钟、护航欠额和未完成单局数量，不混为金额。所有影响余额的写入按订单加行锁并在事务内校验；重复确认、校正、撤回或删除不会产生额外流水副本。

已移除 `wager` 和 `item_result`，写入返回 `422 ORDER_TYPE_UNSUPPORTED`。历史记录保留在数据库和原始账户归档中，当前订单与模板列表、老板汇总只包含三种有效类型。目录接口 `/api/catalog/items` 返回 404。兼容旧客户端的空物品字段用于正常三类订单；实际物品配置或布尔物品结果返回 422。

### 转单与实际收付款

转单使用 `POST /orders/{id}/transfer`，请求为 `{ id, prepaid, progress_bps, note, expected_updated_at }`。`id` 是客户端生成的幂等 UUID；`prepaid` 表示已收到本人整单份额；`progress_bps` 为 0–10000 的协商百分比基点，`null` 使用服务端精确履约比例（单局单默认 0）。总价、人数和抽成必须完整。创建后通过 `archived_at` 停止履约，顶级 `status` 仍为 `archived`，转单快照及状态保存在 `transfer_history`，普通归档/恢复接口不能绕过转单限制。

后续调用 `POST /orders/{id}/transfer-action`，公共字段为 `{ id, transfer_id, action, note, expected_updated_at }`：

| action | 附加字段 | 结果 |
| --- | --- | --- |
| `settle` | `amount_cents` | 确认实际收/付金额；本人最终收益在 0 到当前预计应得之间，才计入租号分析 |
| `cancel` | 无 | 未确认结账且没有现金事件时撤销，保留转单历史并恢复原履约状态 |
| `refund` | `mode: refund或waiver`、`final_income_cents` | 只能调减本人保留收入；已收款形成待退款，尚未收款调减应收；免单将收益归零 |
| `confirm_refund` | 无 | 确认全部待退款已经退回，新增现金支出，不再次冲减本人收益 |

转出时的价格、人数、比例和进度快照不受后续议价影响。预计收入、实际收益与 `cash_events` 分开保存；只确认转出不会产生现金流水。已预收整单份额且尚未付下家时，部分退款单独形成待退款，不增加下家应收；全免取消下家应付，退回本人仍持有的整份款项。已经付给下家时，各组自行退回各自持有部分。租号分析的参考收益取本人转出时已赚部分，不把下家剩余部分记为退款损失。所有写入使用订单行锁、版本校验和幂等请求，重试不会重复收付；转单与现金历史随账户归档保存。

### 个人订单模板

模板只属于当前账号，不绑定老板，也不保存流水或余额。三种基础模板由客户端提供；个人模板保存在 PostgreSQL，选择后复制默认配置到新订单，仍通过 `/bosses/{id}/orders` 开单。修改或删除模板不会修改已经创建的订单。

| 方法 | 路径（带 `/api`） | 响应 |
| --- | --- | --- |
| GET | `/order-templates` | `{ items }`，包含当前账号全部个人模板 |
| POST | `/order-templates` | `201`，新模板 |
| PATCH | `/order-templates/{id}` | `200`，替换模板完整配置 |
| DELETE | `/order-templates/{id}` | `204`，只删除模板 |

请求为扁平 `{ name, ...OrderInput }`；`name` 去两端空白后为 1–80 字，订单 `title` 为 1–120 字。目标、类型及所有规则必须有效，不能把未填写目标保存为有效模板；省略可选规则时使用订单接口的相同默认值。模板不要求老板截图昵称，使用模板建立金额订单时仍校验所选老板。响应返回完整配置、`id`、`created_at`、`updated_at`，不含账号 ID。未知字段、重复字段及不完整 PATCH 返回 400；配置无效返回 422；不存在或属于其他账号的模板统一返回 `404 ORDER_TEMPLATE_NOT_FOUND`。

模板创建、更新、删除与账户归档修订在同一数据库事务提交，回滚不会留下待归档修改。账户 JSON 的 `order_templates` 数组按创建时间和 ID 排序，在同一 PostgreSQL 快照读取并保存到现有私有 OSS 账户目录。008 升级为已有账户推进归档修订，保留活跃租约，避免用新 JSON 结构覆盖已有不可变修订。

## 租号与收入分析

游戏账号资料可复用，每次租用单独保存报价、押金和最终成本。同一账号最多有一次未还号租用，所有数据按登录账号隔离。

| 方法 | 路径（带 `/api`） | 用途 |
| --- | --- | --- |
| GET / POST | `/rental-accounts` | 查询或添加游戏账号，创建输入 `{ id, name, note }` |
| GET / POST | `/rental-sessions` | 查询或开始一次租用 |
| PATCH | `/rental-sessions/{id}/return` | 手填 `final_cost_cents` 还号；再次提交可修正最终成本 |
| GET | `/rental-sessions/{id}/analysis` | 对局、参与订单、收入归属、成本和退补差额 |

开始租用输入 `{ id, account_id, coin_per_yuan, aw_price, helmet_price, armor_price, initial_coins, deposit_cents, started_at, note }`。客户端生成 UUID，原样重试不会重复创建。`coin_per_yuan` 表示 1 元对应的游戏币；比例与纯币使用整数游戏币，界面以 W 展示（1 W = 10000）。`aw_price`、`helmet_price`、`armor_price` 是人民币报价，界面分别使用元/把、元/个、元/个；为兼容已发布的数据格式，这三个字段以万分之一元保存（界面金额乘 10000），新录入保留两位小数。0.9.23 的 W 报价标签有误，0.9.24 修正单位并保留已有数值，不按租号比例换算。押金、成本和订单收入以整数分保存，百分比以基点保存（10000 = 100%）。报价和开租纯币只作记录，程序不推算装备损耗；最终成本由用户填写。应退押金为 `max(押金 − 成本, 0)`，应补差额为 `max(成本 − 押金, 0)`，押金不重复计入成本。

订单新增 `price_cents`、`participant_count`、`commission_bps`，三项须同时填写或同时为空；本人应得收入为 `订单总价 ÷ 接单人数 × (1 − 抽成比例)`，最终四舍五入到分。收入配置可在有流水后修正，分析会随之重算。`default_rental_session_id` 只用于客户端开局预填；实际账号由手工流水或截图 PATCH 中的 `rental_session_id` 决定，`null` 表示自己账号。

每条手工对局和每张已确认截图各计一局，失败对局也计数；约定调整和截图草稿不计数。小时单同样逐局记录。还号后的租用可补录租用期间的历史对局，不允许关联租用时间之外的对局。还号不要求订单完成。

每个订单的归属收入为 `本人应得收入 × 本次租用参与局数 ÷ 订单总局数`；分母包含自己账号和其他租用的全部对局，与时长或带出进度无关。按分使用最大余数法分配尾差，确保各账号收入合计等于本人应得收入。订单沿用账本的完成条件：未完成标记 `pending`，完成但未填写收入标记 `missing_finance`，其余为 `settled`。待分摊收入不纳入 `income_cents`，全部参与订单结单并填全收入、且已确定租号成本后才返回 `profit_cents`。修改、撤回、删除对局或修正收入后，查询分析会自动反映新结果。

旧数据迁移为自己账号，旧订单收入保持空值；不会把未知收入当作免费订单。账户归档包含 `rental_accounts`、`rental_sessions`，订单和流水保留新增字段；迁移为旧账号推进一次归档修订。

## 老板战绩与原图

所有战绩接口要求登录，并限制在当前账号。新截图通过 `X-Order-Id` 明确绑定护航单或单局单，读取对应老板截图昵称；UID 本身通常不出现在截图里，因此需要昵称映射。小时单使用手工时长记录。

| 方法 | 路径（带 `/api`） | 用途 |
| --- | --- | --- |
| GET / PATCH | `/matches/settings` | 读取或保存 `{ "boss_id", "boss_player_name" }`，两项均为 1–80 个字符；未设置时返回空字符串 |
| POST | `/matches` | 原始二进制上传，返回 `{ "record", "duplicate" }`；新增 201，重复 200 |
| POST | `/matches/local` | 同样上传和保存原图，立即返回草稿，不调用服务端 OCR；原生客户端并行在本机识别 |
| GET | `/matches?page=1&page_size=20&order_id={id}&confirmed=false` | 对应订单的 `{ "items", "total", "page", "page_size" }`，每页最多 100 条；`confirmed=false` 只查草稿，`true` 只查已确认，省略则返回两者；省略订单仅查询当前旧设置老板的未分配历史。总数与分页使用相同筛选范围 |
| GET / PATCH / DELETE | `/matches/{id}` | 读取、人工修改或删除记录；删除同时删除原图，成功返回 204 |
| GET | `/matches/{id}/image` | 下载原始图片，账号鉴权，`private, no-store` |
| POST | `/matches/{id}/recognize` | 使用已保存的原图重新识别，返回记录 |
| POST | `/matches/{id}/local-recognition` | `{ "image_sha256", "recognition" }`；保存客户端 OCR 结果并返回记录，`recognition: null` 表示本地识别失败 |
| GET | `/matches/stats?order_id={id}` | 指定订单截图的确认数量、成功/失败数量、草稿数、成功金额总和及成功率；订单完整余额通过 `/orders/{id}` 获取 |

上传使用 `Content-Type: image/png` / `image/jpeg` / `image/webp`，并可通过 `X-File-Name: encodeURIComponent(filename)` 指定原始名称。两个上传端点允许 12 MiB，本地识别结果端点允许 1 MiB，其余端点限制为 16 KiB。后端验证真实图片格式并完整解码，单边最多 16000 像素、总像素最多 4000 万，解码和服务端 OCR 均限制并发。

`recognition` 使用内部 OCR 响应结构：`{ "outcome", "players": [{ "player_name", "outcome", "amount", "confidence" }], "raw_text", "warnings" }`。仅记录所有者能提交结果，`image_sha256` 必须等于已保存原图的摘要；客户端不能指定老板、订单或确认入账状态。服务端规范化金额、昵称和置信度，沿用原有精确昵称匹配，保留人工校正字段。返回成功只代表 OCR 参考已保存，金额仍需用户明确确认后入账。

记录包含 `id`、`order_id`、`failure_extra_amount`、`boss_id`、`boss_player_name`、`original_name`、`image_content_type`、`image_sha256`、`image_width`、`image_height`、`image_size`、`players`、`raw_text`、`warnings`、`ocr_status`、`player_name`、`outcome`、`amount`、`fake_amount`、`net_amount`、`credited_amount`、`confirmed`、`played_at`、`note`、`created_at`、`updated_at`，不公开所有者 ID、内部校对标志、配置快照或图片字节。`played_at` 是可空 UTC 时间字符串。

启用 OSS 后，新原图私有存储于独立 `pwtools/` 目录，数据库保留归属、对象引用和 SHA-256。上传使用 Content-MD5，随后回读验证长度与 SHA-256，验证成功才提交记录；OCR 繁忙或失败保留原图和草稿。未启用 OSS 的开发/测试继续使用 PostgreSQL `BYTEA`；旧原图迁移前仍可读取。旧识别链路的排队和 OCR 各有 35 秒上限；本地识别不进入服务端 OCR 队列。单个账号、老板标识、SHA-256 的组合唯一，重复上传不增加统计；同老板原图不能重复归到不同订单，同一截图可为不同老板记录其各自结果。

### 私有 OSS 存储与历史迁移

仅 Rust 后端读取 `OSS_ENDPOINT`、`OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`，可选 `OSS_SECURITY_TOKEN`。`OSS_PREFIX` 接受 `pwtools` 或 `pwtools/`，对象始终位于 `pwtools/`。区域、端点与私有桶由服务端环境变量配置，例如北京区域使用 `OSS_REGION=cn-beijing`、`OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com`，`OSS_BUCKET` 填写实际桶名。不修改桶 ACL，不访问其他项目目录；凭证不进入桌面安装包、业务 JSON、接口响应或日志。

原图键为 `pwtools/users/<账号 UUID>/bosses/<老板稳定标识 SHA256>/orders/<订单 UUID 或 unassigned>/matches/<战绩 UUID>/original.<扩展名>`，同目录的 `record.json` 保存识别和人工校对快照。对象显式设置 private。客户端经过账号鉴权的 `/matches/{id}/image` 获取字节，不获取 OSS 地址或签名。旧图首次归单不移动不可变原图，最新归属保存在数据库和业务 JSON。

`GET /api/matches/{id}/thumbnail` 使用相同的账号与订单权限校验，只返回 216×122 像素以内的 WebP 缩略图。后端对私有 OSS 原图发起带 `x-oss-process=image/auto-orient,0/resize,m_lfit,w_216,h_122,limit_1/format,webp/quality,q_80` 的 GetObject 请求，按 [OSS 图片处理参数](https://help.aliyun.com/zh/oss/user-guide/resize-images-4) 等比缩小、不放大小图，处理查询串加入 V4 签名；返回前验证格式、尺寸与 256 KiB 上限，不覆盖原图或另存缩略图对象。OSS 处理失败返回可重试错误，不把原图作为列表缩略图返回。未配置 OSS 或尚未迁移的数据库原图由后端本地缩小为 WebP。客户端只在记录接近可视区域时读取缩略图，点击后才请求 `/image`，两种图片分别保留内存缓存并在记录卸载时释放。

快照和删除使用数据库持久任务，短租约领取后执行网络操作，不占用账本事务锁，失败保留任务重试，新修订不会被旧任务清除。删除先提交数据库事务，再删除该记录确切的原图和 JSON 键，避免回滚后丢图。上传取消或重复竞态产生的临时对象由十分钟到期的精确键任务清理，不列举桶、不删除目录，也不自动过期原图。

在服务端注入同一数据库和 OSS 配置后执行：

```text
cargo run --bin pwtools-storage -- status
cargo run --bin pwtools-storage -- migrate --limit 1000
cargo run --bin pwtools-storage -- drain --limit 1000
```

迁移逐条锁定记录，上传私有不可变对象、回读校验后，在同一数据库事务写入对象引用、清除该条 `BYTEA` 并排队 JSON。失败保留旧字节；可重复运行，已迁移记录不会再次搬运。命令只输出计数，不输出资料、原图名称或凭证。PostgreSQL 仍是订单余额和认证数据的权威，需要备份数据库本身。

签名实现核对 [官方 OSS V4 算法](https://www.alibabacloud.com/help/en/oss/developer-reference/recommend-to-use-signature-version-4) 与 [官方 Go SDK](https://github.com/aliyun/alibabacloud-oss-go-sdk-v2/blob/master/oss/signer/v4.go)，仅增加 HMAC、MD5 小型依赖。私有对象、Content-MD5 和禁止覆盖参数见 [PutObject 官方文档](https://help.aliyun.com/zh/oss/developer-reference/putobject)。

上传绑定开始时的明确订单及昵称快照，在 OCR 期间切换界面选择不会改变该记录归属。只精确匹配记录中的老板昵称，未匹配时 `player_name` 为空、`outcome` 为 `unknown`、`amount` 为 `null`，并给出警告；不会使用其他队员或默认第一行。识别结果待人工确认。旧未分配图可通过 `order_id` 明确绑定同一老板的截图订单，已关联图不能转到另一笔订单。

人工 PATCH 允许 `player_name`、`outcome`、`amount`、`fake_amount`、`confirmed`、`played_at`、`note`、`order_id` 和 `failure_extra_amount`，支持部分修改；可空字段显式传入 `null` 可清空。确认需填写与记录绑定老板一致的玩家名称和明确撤离结果。金额订单还需有效原值和明确假账扣除，0 也必须提交；0 ≤ 假账扣除 ≤ 带出原值 ≤ 9000000000000。`net_amount = amount - fake_amount`；成功时 `credited_amount = net_amount`，失败时为 0，但原值和净值仍保留，用于追加规则和核对。旧客户端省略或传入空物品结果时兼容接受；实际布尔物品结果返回 422。历史截图响应中的原有物品证据仅用于归档保留。

新金额草稿 `fake_amount` 为 null，未确认不计账；历史金额记录迁移为假账扣除 0，余额保持。截图备注最多 1000 字。重识别只刷新 OCR 参考；已确认结果和已保存的人工校正草稿均保留。识别失败只更新状态和警告，不丢失上次队员列表、文本、备注或校对；首次识别失败仍保留原图和空结果草稿。

统计响应为 `{ "confirmed_count", "success_count", "failed_count", "draft_count", "total_amount", "success_rate" }`。`total_amount` 只累加已确认、成功撤离的净值，作为截图统计；单局单是否完成仍按 `/orders/{id}` 的最高单场净值判定。成功率范围 0–100。汇总超过 JavaScript 安全整数 9007199254740991 时返回 `409 TOTAL_AMOUNT_TOO_LARGE`，不会默默舍入。

未设置老板时上传返回 `422 BOSS_REQUIRED`；未设置时列表和统计为空。不存在或不属于当前账号的记录统一返回 `404 MATCH_NOT_FOUND`。

## 当前认证边界

密码使用 Argon2id 和独立随机盐，在 `spawn_blocking` 中计算，同时限制密码计算并发。每个会话有独立的 32 字节随机令牌，数据库只保存 SHA-256 摘要，会话有效期为 7 天，退出立即删除当前会话。每小时清理过期会话。接口和日志不返回密码或令牌摘要。

注册和登录共用按 TCP 来源 IP 计数的单实例限速，每分钟最多 10 次。不会信任 `Forwarded` / `X-Forwarded-For`。如果将 API 放在反向代理之后，应结合代理层限速；多实例部署需要共享限速存储。限速记录最多保存 10,000 个活跃 IP，达到上限时新 IP 暂时被拒绝。

当前版本尚无邮箱验证、找回密码、修改密码、第三方登录或账号删除。邮箱暂时只作登录标识，不能视为已验证联系方式。生产环境应在 API 前提供 HTTPS。

## 验证

```text
cargo fmt --all --check
cargo test
cargo clippy --all-targets -- -D warnings
```

真实认证集成测试默认忽略，需配置具有 `CREATE DATABASE` 权限的本地 `DATABASE_URL` 后执行：

```text
cargo test --tests -- --ignored
```

各项测试创建独立随机数据库并执行迁移，验证基本账户、旧账号与业务保留、战绩原图与 OCR、三类订单投影、明确假账扣除、条件追加、单场达标、已移除类型拒绝与历史保留、规则锁定、幂等写入、禁止撤销为草稿、并发回滚及旧 schema 升级。OCR 使用内部本地 HTTP mock，图片为真实编码的 PNG。结束时删除测试数据库，不修改连接串指向的原数据库或清空任何用户表。

### 私人账本自动归档

PostgreSQL 是老板、订单、场次和战绩校对的权威数据源。每次已提交的业务变更由数据库触发器更新账号归档 revision；回滚不会留下归档变更。后台每 15 秒处理待同步记录，网络操作不持有业务行锁，失败重试。

`pwtools/users/<账号 UUID>/ledger.json` 保存当前镜像，`archives/ledger-<revision>.json` 保存不可变版本副本。JSON 包含基本账号标识、老板备注、订单、手工流水、战绩元数据和原图对象引用；不包含密码、会话令牌或图片字节。读取时同一 SQL 快照校验 revision，避免把新业务内容写入旧版本。不可变副本上传并读回验证成功后才更新当前镜像；恢复时可使用最高可用 revision 的版本副本，数据库本身仍需定期备份。

显式验证实际 OSS 原图、匿名访问限制和账本归档内容（读取已知对象，不列举桶）：

```text
cargo run --example verify_private_storage
```

需要服务器的 `DATABASE_URL` 与 OSS 环境配置，以及至少一张已上传或迁移的原图。命令仅输出校验计数。

### 订单结算归档与截图确认（0.9.26 测试版）

- `POST /api/orders/{id}/archive`：`id` 是重试用结算 UUID，`mode` 为 `waiver` / `refund` / `completed`，`final_income_cents` 是最终本人收入，`expected_updated_at` 防止基于旧订单结算。正常结单要求履约已完成；提前结束使用免单或部分退款。
- `POST /api/orders/{id}/restore`：传当前 `settlement_id`；恢复后收入待重新结算，保留旧结算历史。归档锁与所有对局写入共用订单行锁，已归档订单不可新增、修改、删除或重新识别对局。
- 租号收入以已结算本人收入按实际局数分配，免单对局仍计数。分析含退款/免单少赚、影响订单及对局、原价参考收益；未结算收入不提前计入。
- `POST /api/matches/preview` 接收原图供浏览器临时识别；`preview-local` 接收原图 base64 和本地识别结果。两者不创建数据库记录或 OSS 对象。
- `POST /api/matches/confirm` 接收 `name/content_type/data_base64/order_id/recognition/input`，`input.confirmed` 必须为 true。验证原图后在同一数据库事务内确认入账；去重重试不会重复记局。新对象使用独立记录 UUID，失败的上传由精确对象清理队列回收。
- 已发布旧客户端的上传路由仅作临时兼容：未确认行最多保留 30 分钟，不进入新的 OSS 账本镜像或截图快照；后台每 15 秒回收。所有客户端均拒绝 `confirmed:false` 的保存/撤销操作。
- 发布前备份数据库，执行 `pwtools-storage cleanup-unconfirmed --limit 5000` 可清理已授权的历史未确认记录（包括原来撤销入账的草稿），同时排队删除其原图和 record.json。该操作不触及已确认对局和不可变历史备份；继续执行 `drain` 并核验队列。
- 反向代理允许 18 MiB 请求以容纳 12 MiB 原图的 base64 与校对内容；API 仍限制原始图片为 12 MiB，普通业务请求限制不变。
