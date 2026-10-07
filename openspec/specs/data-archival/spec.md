# data-archival Specification

## Purpose

定义业务数据的持久化与归档：PostgreSQL 是权威数据源，阿里云 OSS 私有桶保存原图与自动归档副本，全部数据按账号隔离，客户端不接触 OSS 凭证。

## Requirements

### Requirement: 权威数据源与账号隔离

系统必须（SHALL）以 PostgreSQL 作为账号、老板、订单、流水和校对结果的权威数据源，账号、老板资料及备注、订单、个人模板和每场记录通过 API 保存，等待保存成功后才更新界面；同一账号在独立客户端重新登录后可查看。所有业务数据按账号隔离，跨账号访问返回 404，匿名访问返回 401。SQL 迁移随 API 启动执行。

#### Scenario: 跨客户端取回

- **WHEN** 同一账号在另一台客户端登录
- **THEN** 该账号的老板、订单和记录完整可见

#### Scenario: 越权访问

- **WHEN** 已登录账号请求他人数据
- **THEN** 系统返回 404；未登录请求返回 401

### Requirement: OSS 原图与记录归档

系统必须（SHALL）把已确认截图的原图长期保存到 OSS 私有对象，通过已登录 API 由后端签名访问；客户端不接收 OSS 密钥或私有对象签名地址。对象全部位于桶内独立 `pwtools/` 目录，不使用邮箱或老板昵称作为路径，结构为 `users/<accountUUID>/bosses/<bossKeySHA256>/orders/<orderUUID或unassigned>/matches/<matchUUID>/` 下的 `original.<ext>` 与 `record.json`。`record.json` 自动保存该场 OCR 队员行、识别文本和人工校对结果。删除截图同步清理对应原图和记录副本。未确认截图取消后不保留。

#### Scenario: 原图私有访问

- **WHEN** 客户端请求某场原图
- **THEN** 经登录鉴权后由后端返回；匿名请求被拒绝

#### Scenario: 删除联动清理

- **WHEN** 用户删除一条截图记录
- **THEN** 对应 OSS 原图与 record.json 副本同步清理

### Requirement: 账本自动归档

系统必须（SHALL）把 OCR 行、识别文本、人工校对结果和订单账本保存到 PostgreSQL，并自动归档到 OSS：`archives/ledger-<revision>.json` 按版本保留不可变的本账号账本快照（含老板、订单、手工流水和截图记录，不含密码或会话令牌），`ledger.json` 提供当前镜像。后端定期同步，归档失败保留重试任务，副本可能稍后更新；当前业务余额仍以服务端账本记录为准，归档快照不能代替数据库备份。

#### Scenario: 变更新增版本

- **WHEN** 账户账本发生变更
- **THEN** 归档队列生成新的不可变版本快照，失败时保留重试任务

#### Scenario: 镜像非权威

- **WHEN** OSS 镜像与数据库存在短暂差异
- **THEN** 业务读写始终以 PostgreSQL 为准

### Requirement: 缩略图派生

系统必须（SHALL）通过 OSS 图片处理按需生成 216×122 像素以内、质量 80 的 WebP 缩略图，处理查询串参与 V4 签名；不持久化缩略图对象，原图与私有访问方式保持不变。

#### Scenario: 按需缩略

- **WHEN** 客户端请求记录缩略图
- **THEN** 后端返回经签名的 OSS 图片处理结果，源原图不受影响

### Requirement: 备份与恢复边界

系统必须（SHALL）支持通过 `pg_dump` 生成完整数据库备份用于迁移与恢复；OSS 原图字节不包含在数据库备份内，需另行保护。旧版数据库内 BYTEA 原图由后端迁移命令转存 OSS：先校验原图，成功后才清除数据库字节，失败保留旧图。`docker compose down -v` 删除数据库卷会丢失账本数据，OSS 对象不随卷删除，但失去数据库后不能仅靠重启客户端恢复账本。

#### Scenario: 原图迁移

- **WHEN** 对含 BYTEA 原图的旧库执行存储迁移
- **THEN** 校验并转存 OSS 成功后清除数据库字节，失败的图保持原样

#### Scenario: 升级前备份

- **WHEN** 升级 API 镜像或执行数据库结构迁移
- **THEN** 先完成数据库备份，升级后核对各表数量与内容摘要一致
