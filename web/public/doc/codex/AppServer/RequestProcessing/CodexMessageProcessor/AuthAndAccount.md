# 认证与账户管理

## 概述与职责

本模块是 `CodexMessageProcessor` 中负责**认证流程**和**账户信息查询**的部分，位于 AppServer → RequestProcessing → CodexMessageProcessor 层级中。它实现了 JSON-RPC 协议中所有 `account/*` 相关的请求处理方法，为 IDE 扩展和桌面客户端提供完整的登录/登出/账户查询能力。

在整体架构中，本模块与 `codex_login` crate（凭证存储、OAuth 服务器、设备码轮询）以及 `codex_backend_client`（后端 API 调用）紧密协作，同时通过 `OutgoingMessageSender` 向所有已连接客户端广播认证状态变更通知。

同级模块包括：MessageProcessor（顶层请求分发）、BespokeEventHandling（事件翻译层）、ThreadStateManagement（线程状态管理）。

## 关键流程

### 登录分发：`login_v2`

`login_v2` 是所有登录请求的统一入口（`codex_message_processor.rs:988-1014`）。它根据 `LoginAccountParams` 枚举的变体分发到四条不同路径：

1. **`ApiKey { api_key }`** → `login_api_key_v2`
2. **`Chatgpt`** → `login_chatgpt_v2`（浏览器 OAuth 流程）
3. **`ChatgptDeviceCode`** → `login_chatgpt_device_code_v2`（设备码轮询流程）
4. **`ChatgptAuthTokens { access_token, chatgpt_account_id, chatgpt_plan_type }`** → `login_chatgpt_auth_tokens`（直接 token 注入）

### API Key 登录流程

**`login_api_key_common`**（`codex_message_processor.rs:1025-1067`）执行通用验证与持久化逻辑：

1. 检查是否存在外部 ChatGPT 认证（`is_external_chatgpt_auth_active()`），若存在则拒绝
2. 检查 `forced_login_method` 配置——若强制要求 ChatGPT 登录，则拒绝 API Key 方式
3. 取消任何进行中的登录尝试（获取 `active_login` 锁并 `drop` 现有实例）
4. 调用 `login_with_api_key()` 将 API Key 持久化到 `codex_home` 目录
5. 成功后调用 `auth_manager.reload()` 刷新内存中的认证状态

**`login_api_key_v2`**（`codex_message_processor.rs:1069-1100`）在 `login_api_key_common` 基础上：
- 发送 `LoginAccountResponse::ApiKey` 响应
- 广播 `AccountLoginCompleted` 通知（`login_id: None` 因为 API Key 登录是同步的）
- 广播 `AccountUpdated` 通知，携带当前 `auth_mode` 和 `plan_type`

### 浏览器 OAuth 登录流程

**`login_chatgpt_common`**（`codex_message_processor.rs:1103-1137`）构建 `LoginServerOptions`：
- 验证外部 auth 和 `forced_login_method` 约束
- 设置 `open_browser: false`（由客户端自行打开）
- 在 debug 模式下支持通过环境变量 `CODEX_APP_SERVER_LOGIN_ISSUER` 覆盖 issuer

**`login_chatgpt_v2`**（`codex_message_processor.rs:1156-1263`）是浏览器 OAuth 的核心流程：

1. 调用 `run_login_server(opts)` 启动本地 HTTP 回调服务器
2. 生成随机 `login_id`（UUID v4）并获取 `shutdown_handle`
3. 将 `ActiveLogin::Browser { shutdown_handle, login_id }` 存入 `active_login`（替换已有登录）
4. **立即返回** `LoginAccountResponse::Chatgpt { login_id, auth_url }` 给客户端
5. `tokio::spawn` 一个后台任务等待 OAuth 完成：
   - 使用 `tokio::time::timeout(LOGIN_CHATGPT_TIMEOUT, server.block_until_done())` 等待，超时时间为 **10 分钟**
   - 超时时调用 `shutdown_handle.shutdown()` 关闭回调服务器
   - 成功时：`auth_manager.reload()` → 刷新 cloud requirements loader → 同步 residency 配置 → 广播 `AccountUpdated`
   - 广播 `AccountLoginCompleted` 通知（携带 `login_id`）
   - 最后清理 `active_login`（仅当 `login_id` 匹配时，因为可能已被新登录替换）

### 设备码轮询登录流程

**`login_chatgpt_device_code_v2`**（`codex_message_processor.rs:1265-1365`）适用于无浏览器环境：

1. 调用 `request_device_code(&opts)` 获取设备码信息（`verification_url`、`user_code`）
2. 生成 `login_id` 和 `CancellationToken`
3. 存入 `ActiveLogin::DeviceCode { cancel, login_id }`
4. 立即返回 `LoginAccountResponse::ChatgptDeviceCode { login_id, verification_url, user_code }`
5. 后台任务使用 `tokio::select!` 同时监听：
   - `cancel.cancelled()` — 用户取消
   - `complete_device_code_login(opts, device_code)` — 轮询完成
6. 成功/失败后的处理逻辑与浏览器流程一致

### 直接 Token 注入：`login_chatgpt_auth_tokens`

**`login_chatgpt_auth_tokens`**（`codex_message_processor.rs:1408-1496`）供外部系统（如桌面应用）直接提供已获取的 OAuth token：

1. 验证 `forced_login_method` 不为 `Api`
2. 取消进行中的登录尝试
3. 验证 `chatgpt_account_id` 与 `forced_chatgpt_workspace_id` 匹配（若配置了强制 workspace）
4. 调用 `login_with_chatgpt_auth_tokens()` 持久化 token
5. 刷新 auth、cloud requirements、residency 配置
6. 广播 `LoginAccountResponse::ChatgptAuthTokens`、`AccountLoginCompleted`、`AccountUpdated`

### 取消登录：`cancel_login_v2`

**`cancel_login_v2`**（`codex_message_processor.rs:1382-1406`）：

1. 解析 `login_id` 字符串为 UUID
2. 调用 `cancel_login_chatgpt_common` — 获取 `active_login` 锁，检查 `login_id` 是否匹配
3. 匹配时 `take()` 并 `drop()` 该 `ActiveLogin`（触发 `Drop` trait 自动取消）
4. 返回 `CancelLoginAccountStatus::Canceled` 或 `NotFound`

### 登出：`logout_v2`

**`logout_common`**（`codex_message_processor.rs:1498-1521`）→ **`logout_v2`**（`codex_message_processor.rs:1523-1542`）：

1. 取消进行中的登录尝试
2. 调用 `auth_manager.logout()` 清除持久化凭证
3. 返回登出后的当前 auth mode（通常为 `None`）
4. 广播 `AccountUpdated`（`auth_mode` 和 `plan_type` 均为 `None`）

### 认证状态查询：`get_auth_status`

**`get_auth_status`**（`codex_message_processor.rs:1559-1618`）：

1. 根据 `params.refresh_token` 决定是否先刷新 token
2. 检查 `model_provider.requires_openai_auth`——若自定义 provider 不需要 OpenAI auth，直接返回 `requires_openai_auth: false`
3. 否则从 `auth_manager` 获取当前认证信息，根据 `include_token` 参数决定是否在响应中包含实际 token
4. 若 token 刷新永久失败，即使请求了 token 也不返回（返回 `auth_mode` 但 `token` 为 `None`）

### 账户信息查询：`get_account`

**`get_account`**（`codex_message_processor.rs:1620-1670`）：

1. 可选刷新 token
2. 若 provider 不需要 OpenAI auth，返回 `account: None`
3. 根据 `auth_mode` 分支：
   - **ApiKey** → 返回 `Account::ApiKey {}`
   - **Chatgpt / ChatgptAuthTokens** → 从 auth 中提取 `email` 和 `plan_type`，返回 `Account::Chatgpt { email, plan_type }`；若缺少任一字段则报错

### 速率限制查询：`get_account_rate_limits`

**`get_account_rate_limits`**（`codex_message_processor.rs:1672-1690`）→ **`fetch_account_rate_limits`**（`codex_message_processor.rs:1692-1759`）：

1. 要求已认证且为 ChatGPT 认证模式
2. 构建 `BackendClient::from_auth()` 调用后端 API
3. 调用 `client.get_rate_limits_many()` 获取多个速率限制快照
4. 以 `limit_id` 为键构建 HashMap，优先选取 `limit_id == "codex"` 的快照作为主快照
5. 返回包含 `rate_limits`（主快照）和 `rate_limits_by_limit_id`（全部快照映射）的响应

## 类型定义

### `ActiveLogin` 枚举

```rust
// codex_message_processor.rs:354-363
enum ActiveLogin {
    Browser {
        shutdown_handle: ShutdownHandle,
        login_id: Uuid,
    },
    DeviceCode {
        cancel: CancellationToken,
        login_id: Uuid,
    },
}
```

管理并发登录生命周期的状态机。两个变体分别对应浏览器 OAuth 和设备码轮询流程，各自持有不同的取消机制：

- **`Browser`**：持有本地 HTTP 服务器的 `ShutdownHandle`，取消时关闭服务器
- **`DeviceCode`**：持有 tokio `CancellationToken`，取消时中断轮询循环

实现了 `Drop` trait（`codex_message_processor.rs:400-404`），**drop 时自动调用 `cancel()`**，确保登录被替换或作用域结束时，后台任务能被正确清理。这是一种 RAII 模式——只要 `ActiveLogin` 被 `take()` 并 `drop()`，对应的后台登录流程就会被终止。

### `CancelLoginError` 枚举

```rust
// codex_message_processor.rs:384-387
enum CancelLoginError {
    NotFound,
}
```

取消登录时若 `login_id` 不匹配当前活跃登录，返回此错误。

### `RefreshTokenRequestOutcome` 枚举

```rust
// codex_message_processor.rs:455-459
enum RefreshTokenRequestOutcome {
    NotAttemptedOrSucceeded,
    FailedTransiently,
    FailedPermanently,
}
```

Token 刷新结果的三态表示。`FailedPermanently` 意味着 refresh token 已失效（需要重新登录），`FailedTransiently` 表示临时网络问题。

## 函数签名

### `login_v2(&mut self, request_id: ConnectionRequestId, params: LoginAccountParams)`

统一登录入口，根据 `LoginAccountParams` 变体分发到具体登录实现。

### `login_api_key_common(&mut self, params: &LoginApiKeyParams) -> Result<(), JSONRPCErrorError>`

API Key 登录的通用逻辑。验证约束条件后持久化 key 并刷新 auth 状态。

### `login_chatgpt_common(&self) -> Result<LoginServerOptions, JSONRPCErrorError>`

构建浏览器 OAuth 登录选项。验证约束条件，构造 `LoginServerOptions`。

### `login_chatgpt_v2(&mut self, request_id: ConnectionRequestId)`

浏览器 OAuth 登录。启动本地 HTTP 回调服务器，返回 `auth_url` 供客户端打开浏览器。

### `login_chatgpt_device_code_v2(&mut self, request_id: ConnectionRequestId)`

设备码登录。获取设备码后在后台轮询等待用户授权。

### `login_chatgpt_auth_tokens(&mut self, request_id, access_token, chatgpt_account_id, chatgpt_plan_type)`

直接注入已获取的 OAuth token。用于外部系统（桌面应用等）绕过交互式流程。

### `cancel_login_v2(&mut self, request_id: ConnectionRequestId, params: CancelLoginAccountParams)`

按 `login_id` 取消活跃的登录流程。

### `logout_v2(&mut self, request_id: ConnectionRequestId)`

清除凭证并广播认证状态变更。

### `get_auth_status(&self, request_id: ConnectionRequestId, params: GetAuthStatusParams)`

查询当前认证模式，支持可选的 token 刷新和 token 返回。

### `get_account(&self, request_id: ConnectionRequestId, params: GetAccountParams)`

获取账户详情（email、plan_type 或 API Key 标识）。

### `get_account_rate_limits(&self, request_id: ConnectionRequestId)`

查询当前账户的模型级速率限制快照。仅 ChatGPT 认证可用。

## 配置项与默认值

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `LOGIN_CHATGPT_TIMEOUT` | `Duration` | 10 分钟 | 浏览器 OAuth 登录超时时间 |
| `forced_login_method` | `Option<ForcedLoginMethod>` | `None` | 强制使用 `Api` 或 `Chatgpt` 登录方式 |
| `forced_chatgpt_workspace_id` | `Option<String>` | `None` | 强制要求 ChatGPT 登录使用指定 workspace |
| `model_provider.requires_openai_auth` | `bool` | `true` | 当前 provider 是否需要 OpenAI 认证 |
| `cli_auth_credentials_store_mode` | - | - | 凭证存储方式配置 |
| `CODEX_APP_SERVER_LOGIN_ISSUER` | 环境变量 | - | 仅 debug 构建：覆盖 OAuth issuer URL |

## 边界 Case 与注意事项

- **并发登录互斥**：任何时刻只能存在一个活跃登录。新登录会 `take()` + `drop()` 前一个（触发自动取消）。后台任务在完成后也会检查 `login_id` 是否匹配，避免清理被替换的登录。

- **外部认证锁定**：当 `is_external_chatgpt_auth_active()` 为 true 时，API Key 登录和自管理 ChatGPT 登录均被拒绝，只能使用 `ChatgptAuthTokens` 更新或 `logout` 清除。

- **Token 刷新语义**：`get_auth_status` 中的 `refresh_token` 参数控制是否在查询前刷新 token。若刷新永久失败（refresh token 过期），仍然返回 `auth_mode` 但不返回 token，供客户端判断需要重新登录。若刷新时外部 auth 处于活跃状态，跳过刷新（外部系统负责管理 token 生命周期）。

- **速率限制仅限 ChatGPT 认证**：`get_account_rate_limits` 要求 `is_chatgpt_auth()` 为 true，API Key 认证无法查询速率限制。

- **Residency 同步**：ChatGPT 登录成功后会触发 `replace_cloud_requirements_loader` → `sync_default_client_residency_requirement` 链路，根据后端返回的云端需求更新本地 residency 配置，确保后续请求路由到合规的数据中心。

- **Drop 安全性**：`ActiveLogin` 的 `Drop` 实现确保即使因 panic 或逻辑遗漏未显式取消，后台登录任务也会被终止，避免资源泄漏。