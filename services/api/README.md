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
| POST | `/bosses/{id}/orders` | 建立小时单、护航单、单局单或对赌单 |
| GET / PATCH | `/orders/{id}` | 查看订单投影或修改订单配置 |
| GET / POST | `/orders/{id}/entries` | 分页查看场次账本或添加手工进度、失败追加、约定调整 |
| DELETE | `/orders/{id}/entries/{entry_id}` | 删除手工记录并重算余额；截图场次需通过截图接口修改 |

老板输入为 `{ display_name, game_id, game_name, notes }`，称呼 1–80 字，游戏 ID 和截图昵称各 0–80 字，长期备注最多 2000 字。护航单和单局单需要截图昵称非空；对赌单可只用手工记录，上传截图前仍须设置截图昵称。

订单输入保留 `{ title, kind, target_quantity, failure_default_quantity, note }`，并支持 `failure_trigger`、`failure_standard_quantity`、`failure_mode`、`wager_item_id`、`wager_item_name`、`wager_condition`、`wager_expected`。`hourly` 目标为整数分钟；`escort` 和 `single_round` 目标为整数哈夫币；`wager` 目标固定为 1，表示一笔待判断的对赌。目标大于 0，金额和时长上限为 9000000000000；订单备注最多 2000 字。

护航追加触发条件为 `failed`（撤离失败）、`failed_below_standard`（失败且净值低于标准）或 `below_standard`（任意结果净值低于标准）。追加方式为 `manual`（本场明确填写，0 有效）、`fixed`（订单固定值）或 `shortfall`（标准减本场净值，最低为 0）。未触发时追加为 0。固定追加按本场开始记录时的配置保存，后续修改默认值不会改变历史场次。

对赌支持目录物品 ID 与名称快照，或没有 ID 的自定义物品。`wager_condition` 为 `appearance`（是否出现）或 `extracted`（是否成功带出），`wager_expected` 为 `obtained`（有）或 `not_obtained`（没有）。用户明确填写本场布尔结果后，这一笔订单结算为 `won` 或 `lost`；不会推算赔率或付款。失败撤离不能标记为成功带出物品。

`configuration_locked` 表示订单已存在手工记录或截图草稿。此时类型、目标、触发条件、计算方式、标准和对赌约定不能改变；订单名称、备注和未来场次的默认追加量仍可修改。相同目录 ID 的原有名称快照保留，不随目录更新改写历史。

手工场次输入包含 `{ kind, quantity, occurred_at, note, idempotency_key }`。小时单 `progress` 的 `quantity` 是大于 0 的分钟数。护航单和单局单 `progress` 需明确传入 `amount`（带出原值）、`fake_amount`（假账扣除，0 有效）和 `outcome`，并按护航规则填写 `failure_extra_amount`；输入 `quantity` 与原值一致，返回流水中的 `quantity` 为净值。净值为 0 的场次可以记录。对赌用 `item_result`，`quantity` 为 0，`item_obtained` 必须是布尔值。兼容旧 `failure` 追加流水；`adjustment` 为小时单或护航单非零有符号约定变化，单局单和对赌单不支持调整。备注最多 2000 字，幂等 UUID 防止重试重复记账。分页为 `page=1&page_size=20`，每页最多 100 条。

小时单和护航单余额直接投影手工流水与已确认截图：任务总量 = 初始约定 + 本场追加 + 约定调整；剩余 = max(任务总量 − 已完成, 0)。护航只累计成功撤离的净值。单局单 `completed_quantity` 和 `best_round_quantity` 为成功场次的最高净值；未有单场达标时 `remaining_quantity` 始终是完整目标，不能跨场累加。对赌只允许一条已确认结果，撤回或删除后恢复待判断。老板汇总分别返回剩余小时分钟、护航欠额、未完成单局数量和未结算对赌数量，不混为金额。所有影响余额的写入按订单加行锁并在事务内校验；重复确认、校正、撤回或删除不会产生额外流水副本。

### 个人订单模板

模板只属于当前账号，不绑定老板，也不保存流水或余额。四种基础模板由客户端提供；个人模板保存在 PostgreSQL，选择后复制默认配置到新订单，仍通过 `/bosses/{id}/orders` 开单。修改或删除模板不会修改已经创建的订单。

| 方法 | 路径（带 `/api`） | 响应 |
| --- | --- | --- |
| GET | `/order-templates` | `{ items }`，包含当前账号全部个人模板 |
| POST | `/order-templates` | `201`，新模板 |
| PATCH | `/order-templates/{id}` | `200`，替换模板完整配置 |
| DELETE | `/order-templates/{id}` | `204`，只删除模板 |

请求为扁平 `{ name, ...OrderInput }`；`name` 去两端空白后为 1–80 字，订单 `title` 为 1–120 字。目标、类型及所有规则必须有效，不能把未选对赌物品或未填写目标保存为有效模板；省略可选规则时使用订单接口的相同默认值。模板不要求老板截图昵称，使用模板建立金额订单时仍校验所选老板。响应返回完整配置、`id`、`created_at`、`updated_at`，不含账号 ID。新目录物品使用服务端规范名称；编辑相同目录 ID 时保留原有名称快照，目录变化不阻塞修改模板名称或备注。未知字段、重复字段及不完整 PATCH 返回 400；配置无效返回 422；不存在或属于其他账号的模板统一返回 `404 ORDER_TEMPLATE_NOT_FOUND`。

模板创建、更新、删除与账户归档修订在同一数据库事务提交，回滚不会留下待归档修改。账户 JSON 的 `order_templates` 数组按创建时间和 ID 排序，在同一 PostgreSQL 快照读取并保存到现有私有 OSS 账户目录。008 升级为已有账户推进归档修订，保留活跃租约，避免用新 JSON 结构覆盖已有不可变修订。

### 对赌物品目录

登录后 `GET /api/catalog/items?q=&category=&page=1&page_size=40` 查询内置目录，每页最多 100 条。响应包含 `items`、`categories`、`snapshot_total`、`total`、分页、抓取时间和来源范围。当前快照为 2296 个唯一物品、11 类，合并 DDDJ 历史目录与三角洲官方国际站公开资料；这不是国服最新全量承诺。每项保留来源、版本与名称别名，支持搜索、分类和手填目录外物品。API 使用随服务打包的快照，不在用户查询时爬取。来源和刷新方法见 [目录说明](data/README.md)。

## 老板战绩与原图

所有战绩接口要求登录，并限制在当前账号。新截图通过 `X-Order-Id` 明确绑定护航单、单局单或对赌单，读取对应老板截图昵称；UID 本身通常不出现在截图里，因此需要昵称映射。小时单使用手工时长记录。

| 方法 | 路径（带 `/api`） | 用途 |
| --- | --- | --- |
| GET / PATCH | `/matches/settings` | 读取或保存 `{ "boss_id", "boss_player_name" }`，两项均为 1–80 个字符；未设置时返回空字符串 |
| POST | `/matches` | 原始二进制上传，返回 `{ "record", "duplicate" }`；新增 201，重复 200 |
| GET | `/matches?page=1&page_size=20&order_id={id}&confirmed=false` | 对应订单的 `{ "items", "total", "page", "page_size" }`，每页最多 100 条；`confirmed=false` 只查草稿，`true` 只查已确认，省略则返回两者；省略订单仅查询当前旧设置老板的未分配历史。总数与分页使用相同筛选范围 |
| GET / PATCH / DELETE | `/matches/{id}` | 读取、人工修改或删除记录；删除同时删除原图，成功返回 204 |
| GET | `/matches/{id}/image` | 下载原始图片，账号鉴权，`private, no-store` |
| POST | `/matches/{id}/recognize` | 使用已保存的原图重新识别，返回记录 |
| GET | `/matches/stats?order_id={id}` | 指定订单截图的确认数量、成功/失败数量、草稿数、成功金额总和及成功率；订单完整余额通过 `/orders/{id}` 获取 |

上传使用 `Content-Type: image/png` / `image/jpeg` / `image/webp`，并可通过 `X-File-Name: encodeURIComponent(filename)` 指定原始名称。仅上传端点允许 12 MiB，其他端点仍限制为 16 KiB。后端验证真实图片格式并完整解码，单边最多 16000 像素、总像素最多 4000 万，解码和 OCR 均限制并发。

记录包含 `id`、`order_id`、`failure_extra_amount`、`boss_id`、`boss_player_name`、`original_name`、`image_content_type`、`image_sha256`、`image_width`、`image_height`、`image_size`、`players`、`raw_text`、`warnings`、`ocr_status`、`player_name`、`outcome`、`amount`、`fake_amount`、`net_amount`、`credited_amount`、`item_obtained`、`confirmed`、`played_at`、`note`、`created_at`、`updated_at`，不公开所有者 ID、内部校对标志、配置快照或图片字节。`played_at` 是可空 UTC 时间字符串。

启用 OSS 后，新原图私有存储于独立 `pwtools/` 目录，数据库保留归属、对象引用和 SHA-256。上传使用 Content-MD5，随后回读验证长度与 SHA-256，验证成功才提交记录；OCR 繁忙或失败保留原图和草稿。未启用 OSS 的开发/测试继续使用 PostgreSQL `BYTEA`；旧原图迁移前仍可读取。排队和 OCR 各有 35 秒上限。单个账号、老板标识、SHA-256 的组合唯一，重复上传不增加统计；同老板原图不能重复归到不同订单，同一截图可为不同老板记录其各自结果。

### 私有 OSS 存储与历史迁移

仅 Rust 后端读取 `OSS_ENDPOINT`、`OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`，可选 `OSS_SECURITY_TOKEN`。`OSS_PREFIX` 接受 `pwtools` 或 `pwtools/`，对象始终位于 `pwtools/`。区域、端点与私有桶由服务端环境变量配置，例如北京区域使用 `OSS_REGION=cn-beijing`、`OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com`，`OSS_BUCKET` 填写实际桶名。不修改桶 ACL，不访问其他项目目录；凭证不进入桌面安装包、业务 JSON、接口响应或日志。

原图键为 `pwtools/users/<账号 UUID>/bosses/<老板稳定标识 SHA256>/orders/<订单 UUID 或 unassigned>/matches/<战绩 UUID>/original.<扩展名>`，同目录的 `record.json` 保存识别和人工校对快照。对象显式设置 private。客户端经过账号鉴权的 `/matches/{id}/image` 获取字节，不获取 OSS 地址或签名。旧图首次归单不移动不可变原图，最新归属保存在数据库和业务 JSON。

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

人工 PATCH 允许 `player_name`、`outcome`、`amount`、`fake_amount`、`item_obtained`、`confirmed`、`played_at`、`note`、`order_id` 和 `failure_extra_amount`，支持部分修改；可空字段显式传入 `null` 可清空。确认需填写与记录绑定老板一致的玩家名称和明确撤离结果。金额订单还需有效原值和明确假账扣除，0 也必须提交；0 ≤ 假账扣除 ≤ 带出原值 ≤ 9000000000000。`net_amount = amount - fake_amount`；成功时 `credited_amount = net_amount`，失败时为 0，但原值和净值仍保留，用于追加规则和核对。对赌结果由用户填 `item_obtained`，OCR 不判定物品出现或胜负。

新金额草稿 `fake_amount` 为 null，未确认不计账；历史金额记录迁移为假账扣除 0，余额保持。截图备注最多 1000 字。重识别只刷新 OCR 参考；已确认结果和已保存的人工校正草稿均保留。识别失败只更新状态和警告，不丢失上次队员列表、文本、备注或校对；首次识别失败仍保留原图和空结果草稿。

统计响应为 `{ "confirmed_count", "success_count", "failed_count", "draft_count", "total_amount", "success_rate" }`。`total_amount` 只累加已确认、成功撤离的净值，作为截图统计；单局单是否完成仍按 `/orders/{id}` 的最高单场净值判定，对赌不以金额判定。成功率范围 0–100。汇总超过 JavaScript 安全整数 9007199254740991 时返回 `409 TOTAL_AMOUNT_TOO_LARGE`，不会默默舍入。

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

各项测试创建独立随机数据库并执行迁移，验证基本账户、旧账号与业务保留、战绩原图与 OCR、四类订单投影、明确假账扣除、条件追加、单场达标、对赌结算、规则锁定、幂等写入、校正撤回、并发回滚及旧 schema 升级。OCR 使用内部本地 HTTP mock，图片为真实编码的 PNG。结束时删除测试数据库，不修改连接串指向的原数据库或清空任何用户表。

### 私人账本自动归档

PostgreSQL 是老板、订单、场次和战绩校对的权威数据源。每次已提交的业务变更由数据库触发器更新账号归档 revision；回滚不会留下归档变更。后台每 15 秒处理待同步记录，网络操作不持有业务行锁，失败重试。

`pwtools/users/<账号 UUID>/ledger.json` 保存当前镜像，`archives/ledger-<revision>.json` 保存不可变版本副本。JSON 包含基本账号标识、老板备注、订单、手工流水、战绩元数据和原图对象引用；不包含密码、会话令牌或图片字节。读取时同一 SQL 快照校验 revision，避免把新业务内容写入旧版本。不可变副本上传并读回验证成功后才更新当前镜像；恢复时可使用最高可用 revision 的版本副本，数据库本身仍需定期备份。

显式验证实际 OSS 原图、匿名访问限制和账本归档内容（读取已知对象，不列举桶）：

```text
cargo run --example verify_private_storage
```

需要服务器的 `DATABASE_URL` 与 OSS 环境配置，以及至少一张已上传或迁移的原图。命令仅输出校验计数。
