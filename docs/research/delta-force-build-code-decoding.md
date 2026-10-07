# 不启动三角洲客户端，通过改枪码获得枪支属性

调研日期：2026-10-07。范围：公开接口文档、网站实际请求与公开源码。未使用游戏客户端，未修改业务代码或 OpenSpec。

## 认证接口验证（2026-10-07）

用户提供服务 Token 后，对 `gun_gqm_v2` 发起一次只读 GET：`key1=全部`、`key2=全部`、`p=1`、`solutionType=gun`。返回业务码 `0`、消息「成功」、`count=754`，本页 12 条记录。Token 未写入文件。

首条方案为汤姆逊冲锋枪，核心码 `6L79CCC0BK4JN1CPUVQAH`，参考价 219453。`properties_data` 返回肉伤 34、甲伤 36、射速 880、射程 25、后座 59、操控 53、稳定性 58、腰射 56，并含属性变化值。此结果验证了当前凭证可访问烽火方案目录及属性，不验证游戏内数值准确性或任意码解码能力。依据接口文档，成功查询消耗 1 次资源；未分页拉取全量或测试其他服务。

实际 `solutionCode` 可仅包含核心码，录入和匹配规则应支持这种格式，不能强制所有方案都含枪名和模式前缀。核心码匹配还应核对来源的武器和模式。

## 结论

**可以在游戏外查询已收录方案的属性，也可以在网页中按已知配件模拟属性；目前没有验证到把任意用户改枪码直接还原为配件、精校和完整最终属性的通用接口或可靠开源解码器。** “查已有方案”和“解任意码”应作为两种不同能力处理。

没有找到可靠解码器不等于证明不存在。改枪码究竟是配置编码、服务端标识还是混合结构，本次证据不足以断言，不能仅凭字母数字外观认定为 Base36 可逆编码。

## 已收录方案查询：有明确的数据来源

三角洲数据帝/小涛查的 [改枪码 V2 接口文档](https://work-api.apifox.cn/513185324e0) 给出 `GET https://orzice.com/workApi/v1/sjz_api/gun_gqm_v2`。示例中方案同时包含 `solutionCode`、`objectID` 和 `properties_data`，后者有肉伤、甲伤、射速、射程、后座、操控、稳定性、腰射及变化值。文档描述的是按分类、预算与排序查询，未显示接收任意改枪码的解码参数；`zb` 字段被标注不准确。

因此可考虑同步目录到数据库，用户粘贴代码后按完整代码或核心码匹配，命中时展示来源提供的属性。未收录代码不能保证命中。这是本次调研提出的实现方案，尚未开发。依据 [开通说明](https://work-api.apifox.cn/8352576m0)，该服务需要开通并取得专属 Token，建议由后台调用并缓存。最初仅核查文档；后续已使用用户提供的 Token 成功验证烽火方案列表，详见上方认证接口验证。

开源 [有力气的改枪网站](https://github.com/Steven8427/Interactive-weapon-data-management-platform) 的 [OfficialCodes.jsx](https://github.com/Steven8427/Interactive-weapon-data-management-platform/blob/main/src/pages/OfficialCodes.jsx) 实际查询 `official_gun_codes` 和 `game_items`，配件另存在 `accessory` JSON 的 `slotID/objectID` 中。README 宣称从腾讯 AMS 同步，但仓库未见完整同步端实现，未验证官方任意码查询接口。这个源码证明的是目录展示与配件映射，不能证明通用解码。

## 网站模拟器：无需游戏，但需要已知配置

读取 [云码库前端脚本](https://www.yunmaku.com/assets/js/weapons-flux.min.js?v=1)，发现模拟器按 `weapon_id` 请求初始状态，并按用户选择的配件提交操作。未发现改枪码导入逻辑。

实际请求 [RM277 模拟器初始状态](https://www.yunmaku.com/api/simulator.php?weapon_id=2)，返回 `ok: true`，含 `base_stats`、`total_bonus`、`final_stats`、`active_slots`、`parts_by_slot`、`installed` 等字段。未装配时加成为零；返回最终数值为伤害 41、甲伤 42、射程 55、射速 550、后坐力控制 48、操控速度 50、据枪稳定性 59、腰射精度 44。

这验证了“游戏外能获取属性/配装状态”。网站后台公式、数据版本、精校处理未核实，不能据此保证与当前游戏完全一致，也没有证明它能接收任意码还原配置。第三方网站的公开可访问接口亦不等于稳定、获准的生产集成协议。

## 开源解码器核查：一个重要反例

[weapon-code-generator 的初始提交](https://git.xcyyds.top/LithiumCitrate/weapon-code-generator/commit/3fe31067b1c26897f547ffd2176b2e317aa5354a) 中 `parseWeaponCode` 只检查分隔、模式、长度和首字符，返回枪名、模式与原码，不返回配件或属性。生成器把版本、武器、九槽配件及精校直接拼接，再截断到固定长度；精校和末端配件会被丢弃。项目所称测试通过率不包含真实游戏导入验证。

按已读源码重现拼接、截断和校验：固定前七槽，弹匣 `5A → 5B`、战术配件 `00 → 01`、精校全部更改，两组配置仍输出同一个核心码 `6EIAL01112AS1343E4D5V`。这证明该实现无法保留完整配置，不能用作本项目真实解码依据。实验仅复现此源码算法，没有在游戏中验证该字符串。

[star-Cosmo/delta-force-gunsmith-web](https://github.com/star-Cosmo/delta-force-gunsmith-web) 的搜索缓存 README 宣称可生成游戏代码，但调研时仓库克隆与原始脚本请求均返回 404，无法核查实现，未采信其能力声明。

## 补充：可参考的开源项目

以下补充核查仍未发现“任意改枪码 → 配件/精校/最终属性”的实现。开源代码站、数据集、SDK 和解码器需要区分。

| 项目 | 源码实际能力 | 对本项目的用途 |
| --- | --- | --- |
| [a23138278/DeltaGunsmith](https://github.com/a23138278/DeltaGunsmith) | 已克隆核查提交 `d05e4f619062a325b4af73c32032b03d33da7837`；[builds API](https://github.com/a23138278/DeltaGunsmith/blob/d05e4f619062a325b4af73c32032b03d33da7837/app/api/builds/route.js) 分别接收 `code` 与人工填写的 `parts`，存 JSON/Blob，未解码 | 改枪码收集、提交与展示流程参考 |
| [Petersrsr/delta-query](https://github.com/Petersrsr/delta-query) | 已克隆核查提交 `d3ba3ee8347f77016086adfe70b9ddd4ecc1d95c`；[script.js](https://github.com/Petersrsr/delta-query/blob/d3ba3ee8347f77016086adfe70b9ddd4ecc1d95c/script.js) 加载静态 JSON，按枪名/码筛选，射程来自预录数据；提取枪名只是读取连字符前的文字 | 轻量查询 UI 与静态方案目录参考 |
| [orzice/DeltaForceApi](https://github.com/orzice/DeltaForceApi) | Python/Go/PHP 请求 SDK，使用 Token 调用服务端 API；本地解码未见证据 | 候选方案属性 API 的调用参考，仍需服务和认证 |
| [metacodexgg-tools/deltaforcetools-discord-bot](https://github.com/metacodexgg-tools/deltaforcetools-discord-bot) | `src/api.ts` 按语言、区域、模式、武器分页请求 `/api/weapon-loadouts`，返回代码、标签、描述等；未见最终属性和任意码解码 | 社区方案目录集成参考 |
| [HanKongXingYu/DeltaForce_Gunsmith_Simulator](https://github.com/HanKongXingYu/DeltaForce_Gunsmith_Simulator) | 核查 `main` 文件树只有 README，未见模拟器实现 | 暂无可复用实现 |

## 武器和配件数据：存在，但版本和计算规则仍需解决

成功读取 [jiansenc/DeltaForceData](https://github.com/jiansenc/DeltaForceData)，固定提交为 `669981eda15f747677f93cfddcde9e67eabd676a`，提交日期 2024-12-21。实际路径是 `public/json/`，README 写的 `web/public/json/` 已不一致。

[枪械 JSON](https://github.com/jiansenc/DeltaForceData/blob/669981eda15f747677f93cfddcde9e67eabd676a/public/json/gun/gunRifle.json) 有 `gunDetail` 基础属性及配件槽位。[枪口 JSON](https://github.com/jiansenc/DeltaForceData/blob/669981eda15f747677f93cfddcde9e67eabd676a/public/json/acc/accMuzzle.json) 有 `accDetail` 增减数值；[枪管 JSON](https://github.com/jiansenc/DeltaForceData/blob/669981eda15f747677f93cfddcde9e67eabd676a/public/json/acc/accBarrel.json) 等还包含射程和初速的百分比效果文本。

这些文件可用于理解字段、建立配件模型，不能作为当前赛季权威数据。数值加减、百分比叠加、默认配件替换、模式差异、精校、取整和上下限都需要独立验证，不能用简单累加就宣称得到准确最终属性。

## 对改枪码管理的建议

1. 数据库存原始码、枪名、模式、备注；属性作为可选快照，另记来源、查询时间、数据版本和匹配状态。
2. 第一阶段接入经过认证实测的方案目录。准确匹配时展示来源属性，未命中时明确显示“未获取属性”。同一枪名不能当作同一方案。
3. 用户如果提供配件列表，可以另做配装计算；在公式和精校未验证前标记为估算。
4. 若未来要支持任意码，先取得能输入真实代码并返回配件/精校的合法接口，或取得有真实代码样本及反向验证的解码实现，再承诺自动属性解析。

下一步最有价值的验证：开通候选 API 后，用已收录码、未收录码、只有精校不同的码分别测试；确认属性是否为最终配置快照、是否区分模式，以及覆盖率和数据更新时间。游戏端对照可由已有真实截图或人工提供的配装资料完成，但本次未做该验证。
