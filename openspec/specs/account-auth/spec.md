# account-auth Specification

## Purpose

账户是陪玩以邮箱登录的身份，也是其私人账本的所有者。本能力定义注册、登录、会话与登出行为，保证账本数据按账号隔离，且同一账号可在独立客户端重新登录后取回数据。

## Requirements

### Requirement: 邮箱密码注册

系统必须（SHALL）提供以邮箱和密码注册账户的入口，注册界面要求填写确认密码并在界面侧校验两次输入一致。密码长度必须为 10–128 个字符。注册成功后直接返回登录令牌并进入账本。账户仅保留基本登录信息（`id`、`email`、`created_at`），邮箱仅作为登录标识，不提供邮箱验证、找回密码或支付流程。

#### Scenario: 注册成功

- **WHEN** 用户提交未注册的邮箱、10–128 字符的密码和一致的确认密码
- **THEN** 系统创建账户，返回 `token` 与 `user`（含 `id`、`email`、`created_at`），并进入所有老板总览

#### Scenario: 确认密码不一致

- **WHEN** 用户两次输入的密码不一致
- **THEN** 注册界面在校验阶段阻止提交，不发起注册请求

### Requirement: 登录与错误反馈

系统必须（SHALL）提供邮箱和密码登录。登录失败时返回结构化错误响应，形如 `{"error":{"code":"INVALID_CREDENTIALS","message":"邮箱或密码不正确，请重新输入"}}`，不区分邮箱不存在与密码错误之外的额外细节。

#### Scenario: 凭据正确

- **WHEN** 用户提交已注册邮箱和正确密码
- **THEN** 系统返回新的 `token` 与 `user`，客户端进入账本

#### Scenario: 凭据错误

- **WHEN** 用户提交错误密码或未注册邮箱
- **THEN** 系统返回 `INVALID_CREDENTIALS` 错误，不创建会话

### Requirement: 密码存储安全

系统必须（SHALL）以带随机盐的 Argon2 哈希保存密码，任何存储与归档副本中不得出现明文密码。

#### Scenario: 数据库检查

- **WHEN** 检查用户表或任意账本归档副本
- **THEN** 只存在 Argon2 哈希，不存在明文密码；归档快照不包含密码或会话令牌

### Requirement: 登录会话

系统必须（SHALL）使用随机 opaque token 作为登录会话，有效期 7 天；数据库只保存 token 的 SHA-256 摘要。需要登录的接口通过 `Authorization: Bearer <token>` 鉴权。登出撤销当前会话并返回 `204`。

#### Scenario: 令牌鉴权

- **WHEN** 客户端携带有效 token 请求需登录接口
- **THEN** 系统按 token 对应账号授权访问，仅返回该账号自己的数据

#### Scenario: 登出

- **WHEN** 已登录用户调用登出接口
- **THEN** 系统撤销当前会话并返回 `204`，该 token 此后请求需登录接口被拒绝

#### Scenario: 未登录访问

- **WHEN** 请求不携带 token 或 token 已撤销、过期
- **THEN** 系统返回 401，不返回任何账本数据

### Requirement: 桌面端会话保存

Windows 客户端必须（MUST）通过 Windows DPAPI 加密保存会话令牌，令牌不返回 React 页面；会话文件按 API 地址隔离，且与旧 Electron 客户端的会话文件相互独立。浏览器预览的登录令牌只保存在内存，刷新页面后需要重新登录。

#### Scenario: 重启恢复会话

- **WHEN** 用户在 Windows 客户端登录后关闭并重新启动应用
- **THEN** 客户端从 DPAPI 会话文件恢复登录状态，无需重新输入密码

#### Scenario: 退出登录清除

- **WHEN** 用户在设置中选择退出登录
- **THEN** 本机会话被清除，哈夫币汇率等页面输入随之清除，再次启动需要重新登录
