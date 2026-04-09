# AuthManager

## 概述与职责

`AuthManager` 是 Codex 认证系统的核心编排器，位于 `codex-login` crate 的 `auth` 模块中。它是整个 Auth 子系统的一部分——Auth 负责认证与凭据管理，而 `AuthManager` 具体承担 token 生命周期的完整管理：加载凭据、刷新 OAuth token、持久化更新后的状态、协调外部认证提供者，以及在 API 调用返回 401 时驱动多步恢复流程。

在架构层级中，Auth 模块被 Core（获取 API 调用凭据）、TUI（发起登录流程）、AppServer（验证 JWT）、ModelProviders（授权 API 请求）、CloudTasks 等多个顶级组件依赖。`AuthManager` 同级的兄弟模块包括 ChatGPTClient（ChatGPT 后端 API 客户端）、KeyringStore（OS 钥匙链抽象层）和 Secrets（加密密钥管理）。

**核心源文件**：
- `codex-rs/login/src/auth/manager.rs` — 主要实现
- `codex-rs/login/src/auth/mod.rs` — 模块导出
- `codex-rs/login/src/auth/error.rs` — 错误类型重导出
- `codex-rs/login/src/auth/util.rs` — 辅助函数

## 关键流程

### 认证机制枚举 `CodexAuth`

`CodexAuth` 是一个枚举，表示当前使用的认证方式（`codex-rs/login/src/auth/manager.rs:42-47`）：

```rust
pub enum CodexAuth {
    ApiKey(ApiKeyAuth),          // 纯 API Key 认证
    Chatgpt(ChatgptAuth),       // ChatGPT OAuth 认证（自管理，含持久化存储）
    ChatgptAuthTokens(ChatgptAuthTokens), // 外部管理的 ChatGPT token（无持久化）
}
```

- **`ApiKey`**：最简单的模式，持有一个 API key 字符串，无需刷新。
- **`Chatgpt`**：完整的 OAuth 认证，包含 `ChatgptAuthState`（当前 token 状态 + HTTP client）和一个 `Arc<dyn AuthStorageBackend>` 用于持久化。token 过期时可通过 OAuth refresh 流程自动续期。
- **`ChatgptAuthTokens`**：由外部应用（如 IDE 扩展）提供的 ChatGPT token。只有 `ChatgptAuthState`，没有持久化存储后端——刷新由外部 `ExternalAuth` trait 驱动。

### 凭据加载流程

`AuthManager::new()` 在构造时调用 `load_auth()` 加载初始凭据（`manager.rs:1130-1159`）。`load_auth()` 的优先级顺序（`manager.rs:597-636`）：

1. **环境变量 `CODEX_API_KEY`**：如果启用了 `enable_codex_api_key_env` 且该环境变量有值，直接构造 `ApiKey` 认证，优先级最高。
2. **Ephemeral 存储**：检查内存中的临时存储，用于外部 ChatGPT token（如 IDE 传入的 token），优先于磁盘凭据。
3. **持久化存储**：按配置的 `AuthCredentialsStoreMode` 从文件/钥匙链加载 `auth.json`。

`AuthCredentialsStoreMode` 定义了四种存储后端：
- `File` — 持久化到 `CODEX_HOME/auth.json`（默认）
- `Keyring` — OS 钥匙链存储
- `Auto` — 优先钥匙链，不可用时回退到文件
- `Ephemeral` — 仅内存存储

### 主动 Token 刷新

`AuthManager::auth()` 是获取当前认证的主入口（`manager.rs:1231-1244`）。它不仅返回缓存的认证快照，还会在 token 过期时主动触发刷新：

1. 先检查是否有外部 API Key 认证，有则直接返回
2. 从缓存获取当前认证
3. 调用 `is_stale_for_proactive_refresh()` 判断 token 是否过期（`manager.rs:1561-1581`）：
   - 解析 JWT 的 `exp` 字段，若已过期则刷新
   - 否则检查 `last_refresh` 时间是否超过 8 天（`TOKEN_REFRESH_INTERVAL`）
4. 如果需要刷新，调用 `refresh_token()`

### 带保护的 Token 刷新（`refresh_token`）

`refresh_token()` 方法（`manager.rs:1465-1491`）采用乐观并发策略，避免多实例重复刷新：

1. 获取 `refresh_lock` 异步互斥锁，保证同一进程内串行刷新
2. 记录刷新前的认证快照
3. 调用 `reload_if_account_id_matches()` 从存储重新加载凭据：
   - 如果 account ID 不匹配（可能用户已切换账号），返回 `Skipped`
   - 如果重新加载后凭据**发生变化**（说明其他进程已刷新），直接使用新凭据，跳过网络请求
   - 如果凭据**未变化**，继续向认证服务器请求刷新

### ChatGPT OAuth Token 刷新

`request_chatgpt_token_refresh()` 执行实际的网络请求（`manager.rs:666-707`）：

1. 构造 `RefreshRequest`，携带 `client_id`（`app_EMoamEEZ73f0CkXaXp7hrann`）、`grant_type: "refresh_token"` 和当前 refresh token
2. POST 到 `https://auth.openai.com/oauth/token`（可通过 `CODEX_REFRESH_TOKEN_URL_OVERRIDE` 环境变量覆盖）
3. 成功时返回新的 `id_token`、`access_token`、`refresh_token`
4. 失败时根据 HTTP 状态码分类错误：
   - **401**：永久性错误，进一步分类为 `Expired`、`Exhausted`（token 已使用）、`Revoked`
   - **其他**：瞬态错误，可重试

刷新成功后 `persist_tokens()` 将新 token 写入存储并更新 `last_refresh` 时间戳（`manager.rs:639-662`），然后 `reload()` 更新内存缓存。

### UnauthorizedRecovery 状态机

当 API 调用返回 401 时，调用方通过 `AuthManager::unauthorized_recovery()` 创建一个 `UnauthorizedRecovery` 状态机（`manager.rs:885-1091`）。每次遇到 401 时调用 `next()` 推进一步：

**Managed 模式**（自管理的 ChatGPT 认证）：
1. **`Reload`**：从磁盘重新加载凭据，检查 account ID 是否匹配
   - 凭据变化 → 返回 `auth_state_changed: true`，进入 `RefreshToken` 步骤
   - 凭据未变 → 返回 `auth_state_changed: false`，进入 `RefreshToken` 步骤
   - account ID 不匹配 → 终止，返回永久错误
2. **`RefreshToken`**：调用 `refresh_token_from_authority()` 请求新 token，成功后进入 `Done`
3. **`Done`**：无更多恢复步骤

**External 模式**（外部管理的 token 或 bearer auth）：
1. **`ExternalRefresh`**：调用 `refresh_external_auth()` 向外部认证提供者请求新凭据
2. **`Done`**：无更多恢复步骤

调用方通过 `has_next()` 检查是否还有可用步骤，通过 `unavailable_reason()` 获取不可用原因（如 `"not_chatgpt_auth"`、`"recovery_exhausted"`）。

### 外部认证提供者（`ExternalAuth` trait）

`ExternalAuth` trait（`manager.rs:146-166`）定义了可插拔的外部认证接口：

```rust
pub trait ExternalAuth: Send + Sync {
    fn auth_mode(&self) -> AuthMode;
    async fn resolve(&self) -> std::io::Result<Option<ExternalAuthTokens>>;
    async fn refresh(&self, context: ExternalAuthRefreshContext) -> std::io::Result<ExternalAuthTokens>;
}
```

- `resolve()` — 同步获取缓存的或立即可用的认证信息
- `refresh()` — 当需要刷新时调用，传入刷新原因和之前的 account ID

外部认证的典型使用场景：IDE 扩展通过 AppServer 将 ChatGPT token 注入 Codex，token 失效时由 IDE 负责获取新 token。刷新后的 token 保存到 Ephemeral 存储并 reload 缓存。

### 登录限制强制执行

`enforce_login_restrictions()` 函数（`manager.rs:495-568`）在启动时检查当前认证是否符合管理策略：

- **`forced_login_method`**：如果配置要求 API 认证但当前是 ChatGPT 认证（或反之），则强制登出
- **`forced_chatgpt_workspace_id`**：如果配置要求特定 workspace，但当前 token 对应的 `chatgpt_account_id` 不匹配，则强制登出

违规时会调用 `logout_all_stores()` 清除所有存储（包括 Ephemeral 和持久化存储），然后返回错误信息。

## 函数签名与参数说明

### `AuthManager::new(codex_home, enable_codex_api_key_env, auth_credentials_store_mode) -> Self`

构造函数。加载初始凭据，加载失败时静默处理（`auth()` 返回 `None`）。

- **`codex_home`** (`PathBuf`)：Codex 主目录路径，凭据文件存放位置
- **`enable_codex_api_key_env`** (`bool`)：是否启用 `CODEX_API_KEY` 环境变量
- **`auth_credentials_store_mode`** (`AuthCredentialsStoreMode`)：凭据存储后端模式

> 源码位置：`codex-rs/login/src/auth/manager.rs:1135-1159`

### `AuthManager::shared(…) -> Arc<Self>`

便捷构造器，返回 `Arc` 包装的实例。参数同 `new()`。

> 源码位置：`codex-rs/login/src/auth/manager.rs:1395-1405`

### `async AuthManager::auth(&self) -> Option<CodexAuth>`

获取当前认证快照。对过期的 ChatGPT token 会主动触发刷新，刷新失败时返回旧 token。

> 源码位置：`codex-rs/login/src/auth/manager.rs:1231-1244`

### `AuthManager::auth_cached(&self) -> Option<CodexAuth>`

获取缓存的认证快照，不触发刷新。

> 源码位置：`codex-rs/login/src/auth/manager.rs:1214-1216`

### `AuthManager::reload(&self) -> bool`

从存储重新加载凭据，返回认证是否发生变化。

> 源码位置：`codex-rs/login/src/auth/manager.rs:1248-1252`

### `async AuthManager::refresh_token(&self) -> Result<(), RefreshTokenError>`

带保护的 token 刷新：先重新加载存储，如果凭据未变再向服务端请求刷新。

> 源码位置：`codex-rs/login/src/auth/manager.rs:1465-1491`

### `AuthManager::unauthorized_recovery(self: &Arc<Self>) -> UnauthorizedRecovery`

创建 401 恢复状态机。

> 源码位置：`codex-rs/login/src/auth/manager.rs:1422-1424`

### `AuthManager::logout(&self) -> std::io::Result<bool>`

删除所有存储中的凭据并刷新内存缓存。返回是否有文件被删除。

> 源码位置：`codex-rs/login/src/auth/manager.rs:1540-1545`

### `logout(codex_home, auth_credentials_store_mode) -> std::io::Result<bool>`

模块级函数，删除指定存储后端中的凭据。

> 源码位置：`codex-rs/login/src/auth/manager.rs:422-428`

### `login_with_api_key(codex_home, api_key, auth_credentials_store_mode) -> std::io::Result<()>`

将 API Key 写入存储。

> 源码位置：`codex-rs/login/src/auth/manager.rs:431-443`

### `login_with_chatgpt_auth_tokens(codex_home, access_token, chatgpt_account_id, chatgpt_plan_type) -> std::io::Result<()>`

将外部 ChatGPT token 写入 Ephemeral 存储。

> 源码位置：`codex-rs/login/src/auth/manager.rs:446-462`

## 接口/类型定义

### `CodexAuth`

| 变体 | 内部结构 | 说明 |
|------|---------|------|
| `ApiKey(ApiKeyAuth)` | `api_key: String` | 纯 API Key |
| `Chatgpt(ChatgptAuth)` | `state: ChatgptAuthState`, `storage: Arc<dyn AuthStorageBackend>` | 自管理的 OAuth |
| `ChatgptAuthTokens(ChatgptAuthTokens)` | `state: ChatgptAuthState` | 外部管理的 token |

### `ExternalAuthTokens`

| 字段 | 类型 | 说明 |
|------|------|------|
| `access_token` | `String` | Bearer token |
| `chatgpt_metadata` | `Option<ExternalAuthChatgptMetadata>` | ChatGPT 元数据（account ID + plan） |

### `RefreshTokenError`

| 变体 | 说明 |
|------|------|
| `Permanent(RefreshTokenFailedError)` | 不可恢复的刷新失败（token 过期/已用/已撤销） |
| `Transient(std::io::Error)` | 瞬态错误（网络问题等），可重试 |

### `RefreshTokenFailedReason`

枚举值：`Expired`、`Exhausted`（refresh token 已使用）、`Revoked`、`Other`。

### `AuthConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| `codex_home` | `PathBuf` | Codex 主目录 |
| `auth_credentials_store_mode` | `AuthCredentialsStoreMode` | 存储模式 |
| `forced_login_method` | `Option<ForcedLoginMethod>` | 强制使用的认证方式 |
| `forced_chatgpt_workspace_id` | `Option<String>` | 强制使用的 workspace ID |

## 配置项与默认值

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `TOKEN_REFRESH_INTERVAL` | `i64` | `8`（天） | 主动刷新的时间间隔阈值 |
| `REFRESH_TOKEN_URL` | `&str` | `https://auth.openai.com/oauth/token` | OAuth token 刷新端点 |
| `CLIENT_ID` | `&str` | `app_EMoamEEZ73f0CkXaXp7hrann` | OAuth client ID |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE` | 环境变量 | 无 | 覆盖默认的 token 刷新 URL |
| `OPENAI_API_KEY` | 环境变量 | 无 | OpenAI API Key（通过 `read_openai_api_key_from_env` 读取） |
| `CODEX_API_KEY` | 环境变量 | 无 | Codex API Key，优先级最高 |

## 边界 Case 与注意事项

- **并发安全**：`AuthManager` 使用 `RwLock` 保护缓存状态，`AsyncMutex` 保证同一进程内 token 刷新串行执行。但外部对 `auth.json` 的修改不会被自动感知，必须显式调用 `reload()`。
- **多进程协调**：`refresh_token()` 的"先 reload 再刷新"策略处理了多个 Codex 进程共享同一份 `auth.json` 的场景——如果发现磁盘上的 token 已被其他进程刷新，就跳过网络请求。
- **永久刷新失败缓存**：刷新失败且被归类为 `Permanent` 时，错误会被缓存到 `AuthScopedRefreshFailure`。后续对相同凭据的刷新尝试直接返回缓存的错误，避免重复网络请求。当凭据变更时缓存自动清除。
- **Ephemeral 存储的特殊处理**：`ChatgptAuthTokens` 模式始终使用 Ephemeral 存储（`AuthDotJson::storage_mode()`），不会将外部提供的 token 写入磁盘。
- **登出清理**：`logout_all_stores()` 同时清除 Ephemeral 和持久化存储，确保强制登出时不遗留任何凭据。
- **错误消息解析**：`try_parse_error_message()`（`util.rs:3-16`）从 JSON 错误响应中提取 `error.message` 字段；如果解析失败则返回原始文本，空文本时返回 "Unknown error"。
- **Account ID 校验**：reload 和外部刷新时都会校验 account ID 是否匹配。如果用户已在其他地方登录了不同账号，reload 会被跳过并返回 `REFRESH_TOKEN_ACCOUNT_MISMATCH_MESSAGE` 错误。