# 三角洲物品选择目录

`delta_items.json` 是服务端内嵌的物品选择快照，用于对赌订单选择物品与保存物品名称。目录按物品 ID 去重，不使用物品名称去重；不同 ID 可以有同名物品。接口为需登录的 `GET /api/catalog/items`，支持 `q`、`category`、`page` 和 `page_size`（默认 40，上限 100）。

首期数据合并两组来源：

- 用户指定的 DDDJ 项目在 2026-09-21 保存的简体目录，共 2,116 个 ID。该目录包含社区物品表、历史 AMS 响应的社区存档，以及社区公开的外观 ID 映射。每个条目的 `source_url` 和 `source_version` 保留实际来源与原始时间，不把社区同步日期视为腾讯更新日期。
- 本次直接读取的[官方国际服 Wiki](https://www.playdeltaforce.com/events/officialwiki/)公开静态数据。12 张表合计 1,720 行，其中收集品表与钥匙表重叠 80 个 ID，去重后 1,640 个 ID。官方资料语言为 `zh-TW`，不据此保证国服已上线或可交易。同 ID 保留 DDDJ 简体名称，官方名称用于别名搜索；`official_name` 与 `official_source_url` 记录对应关系，图标 URL 直接使用公开第一方地址。

本次合并后共 **2,296 个唯一 ID、11 个分类**。实际读取时间、逐表数量与 SHA256 记录在快照的 `fetched_at`、`sources` 中；完整分类数量见 `categories`。官方 `16110000026` 的名称字段为空，因此保留明确 ID 与图标，显示诊断文字“名称未提供 · 16110000026”，并记录到 `unresolved_items`，未猜测游戏名称。

目录包含公开资料可确认的物品、外观及头像，不代表国服最新全部物品或整个 CDN 的可穷尽清单。腾讯国服 AMS 物品接口此前无登录返回 `ret=101`；本实现不调用登录接口、不使用游戏凭据、不绕过该限制。未匹配物品可由产品提供手填名称入口。

## 官方静态表

固定来源根目录为 `https://www.playdeltaforce.com/basic_info/`，只读取下列公开文件：

| 文件 | 条目数 | 对应类型 |
| --- | ---: | --- |
| `collections_zh-TW.js` | 736 | 收集品；也包含部分钥匙条目 |
| `medicines_zh-TW.js` | 14 | 药品 |
| `injections_zh-TW.js` | 12 | 针剂 |
| `repair_kits_zh-TW.js` | 8 | 维修套件 |
| `door_cards_zh-TW.js` | 80 | 钥匙卡 |
| `mandel_bricks_zh-TW.js` | 11 | 曼德尔砖 |
| `guns_zh-TW.js` | 68 | 枪械；含官方分类名称映射 |
| `attachments_zh-TW.js` | 576 | 配件 |
| `bullets_zh-TW.js` | 113 | 弹药 |
| `helmets_zh-TW.js` | 29 | 头盔 |
| `armors_zh-TW.js` | 28 | 护甲 |
| `rigs_zh-TW.js` | 45 | 胸挂与背包 |

这些 URL 来自官方 Wiki 实际加载的 `useObjectCatalog`、`guns` 模块及官方总部页面。刷新脚本只解析其中的 JSON 字面量，不执行下载的 JavaScript，不枚举未列出的物品 ID，也不下载图标图片。

## 刷新

在仓库根目录执行：

```powershell
python services/api/scripts/refresh_delta_catalog.py
cargo test --manifest-path services/api/Cargo.toml --lib catalog::tests
```

默认保留快照中标明 `dddj_snapshot` 的历史条目，重新读取所有固定官方表并替换官方补充。每张表读取完整数组，按 ID 合并；任一网络、格式或重复 ID 校验失败都会停止，不覆盖现有文件。最多 3 个并发请求，只允许官方静态根目录内的重定向。默认刷新无需访问 DDDJ 或第三方社区站。

需要重新导入用户指定的历史资料时，可明确传入唯一 JSON 文件：

```powershell
python services/api/scripts/refresh_delta_catalog.py --dddj-catalog "C:/path/to/merged-items.json"
```

JSON 通过 `include_str!` 编译进后端，刷新后需要重新编译、部署 API。既有订单已经保存物品名称快照，不随目录更新而改名。
