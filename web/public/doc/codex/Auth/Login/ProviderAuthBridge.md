# ProviderAuthBridge

## 概述与职责

ProviderAuthBridge 是 Login 模块中负责**将认证凭据桥接到具体模型提供商 API 请求**的组件。它位于 Auth → Login 层级下，解决的核心问题是：Codex 支持多种模型提供商（OpenAI、第三方 LLM 服务等），每个提供商可能使用不同的认证方式——环境变量中的 API Key、实验性 Bearer Token、或通过 OAuth 获取的 ChatGPT Token。本模块提供统一的桥接逻辑，让上层调用者无需关心认证细节。

该组件由两个源文件组成：
- `api_bridge.rs`：将各种认证源解析为统一的 `CoreAuthProvider` 结构
- `provider_auth.rs`：根据提供商配置返回正确的 `AuthManager` 实例

在系统架构中，ModelProviders 层依赖 Auth 层获取认证凭据（见架构图中 ModelProviders → Auth 边），而 ProviderAuthBridge 正是这一依赖关系的具体实现点。同级的兄弟模块 ChatGPTClient、KeyringStore、Secrets 分别负责 ChatGPT API 交互、OS 密钥环存储、加密密钥管理。

## 关键流程

### Token 解析优先级（auth_provider_from_auth）

`auth_provider_from_auth()` 按以下优先级尝试解析认证 token，**首个匹配即返回**：

1. **Provider API Key**：调用 `provider.api_key()` 从环境变量读取（如 `OPENAI_API_KEY`）。若存在，直接包装为 `CoreAuthProvider`，不携带 `account_id`（`api_bridge.rs:10-15`）
2. **Experimental Bearer Token**：检查 `provider.experimental_bearer_token` 字段。这是提供商配置中的实验性静态 token，同样不携带 `account_id`（`api_bridge.rs:17-22`）
3. **CodexAuth Token**：使用传入的 `CodexAuth`（可能是 API Key 认证或 ChatGPT OAuth 认证），调用 `get_token()` 获取 token 字符串，同时通过 `get_account_id()` 提取账户 ID（`api_bridge.rs:24-29`）
4. **无认证兜底**：如果以上均不可用（`auth` 为 `None`），返回空的 `CoreAuthProvider`（token 和 account_id 均为 `None`）（`api_bridge.rs:31-34`）

这种优先级设计意味着：**提供商级配置优先于全局认证状态**。如果用户为某个提供商设置了专用 API Key 环境变量，即使同时登录了 ChatGPT 账户，也会使用该 API Key。

### AuthManager 选择（provider_auth.rs）

`provider_auth.rs` 中的两个函数处理的是另一维度的问题：某些提供商配置了**自定义命令驱动的认证**（`ModelProviderAuthInfo`），需要使用专门的 `AuthManager` 来执行外部命令获取 Bearer Token。

**`auth_manager_for_provider()`**（`provider_auth.rs:10-18`）：
- 若提供商有 `auth` 配置 → 创建 `external_bearer_only` AuthManager（通过 `BearerTokenRefresher` 执行外部命令刷新 token）
- 若没有 → 透传调用者传入的 `auth_manager`（可能为 `None`）

**`required_auth_manager_for_provider()`**（`provider_auth.rs:24-32`）：
- 逻辑与上者相同，但签名要求 `auth_manager` 必须存在（`Arc<AuthManager>` 而非 `Option`）
- 用于**必须认证**的请求路径，保证始终返回一个有效的 `AuthManager`

## 函数签名与参数说明

### `auth_provider_from_auth`

```rust
pub fn auth_provider_from_auth(
    auth: Option<CodexAuth>,
    provider: &ModelProviderInfo,
) -> codex_protocol::error::Result<CoreAuthProvider>
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `auth` | `Option<CodexAuth>` | 当前全局认证状态。`CodexAuth` 是枚举，包含 `ApiKey`、`Chatgpt`、`ChatgptAuthTokens` 三种变体 |
| `provider` | `&ModelProviderInfo` | 当前模型提供商的配置信息，包含 `env_key`、`experimental_bearer_token`、`auth` 等字段 |
| **返回值** | `Result<CoreAuthProvider>` | 包含 `token: Option<String>` 和 `account_id: Option<String>` 的统一认证载体 |

> 源码位置：`codex-rs/login/src/api_bridge.rs:6-36`

### `auth_manager_for_provider`

```rust
pub fn auth_manager_for_provider(
    auth_manager: Option<Arc<AuthManager>>,
    provider: &ModelProviderInfo,
) -> Option<Arc<AuthManager>>
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `auth_manager` | `Option<Arc<AuthManager>>` | 调用者持有的基础 AuthManager，可能为空 |
| `provider` | `&ModelProviderInfo` | 提供商配置，`auth` 字段决定是否启用自定义认证 |
| **返回值** | `Option<Arc<AuthManager>>` | 提供商有自定义 auth 时返回新建的 bearer-only manager，否则透传原值 |

> 源码位置：`codex-rs/login/src/provider_auth.rs:10-18`

### `required_auth_manager_for_provider`

```rust
pub fn required_auth_manager_for_provider(
    auth_manager: Arc<AuthManager>,
    provider: &ModelProviderInfo,
) -> Arc<AuthManager>
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `auth_manager` | `Arc<AuthManager>` | 必须存在的基础 AuthManager |
| `provider` | `&ModelProviderInfo` | 提供商配置 |
| **返回值** | `Arc<AuthManager>` | 保证非空的 AuthManager 实例 |

> 源码位置：`codex-rs/login/src/provider_auth.rs:24-32`

## 接口/类型定义

### `CoreAuthProvider`

由 `codex-api` crate 定义，是认证信息的统一载体（`codex-rs/codex-api/src/api_bridge.rs:178-181`）：

```rust
pub struct CoreAuthProvider {
    pub token: Option<String>,
    pub account_id: Option<String>,
}
```

- `token`：用于 API 请求的 Bearer Token 或 API Key
- `account_id`：仅在 ChatGPT OAuth 认证时存在，标识用户账户

### `CodexAuth`

认证状态枚举（`codex-rs/login/src/auth/manager.rs:43-47`）：

```rust
pub enum CodexAuth {
    ApiKey(ApiKeyAuth),
    Chatgpt(ChatgptAuth),
    ChatgptAuthTokens(ChatgptAuthTokens),
}
```

三种变体对应不同的认证方式，`get_token()` 统一返回可用的 token 字符串。

## 边界 Case 与注意事项

- **优先级覆盖**：如果环境变量中同时设置了 Provider API Key 和 `experimental_bearer_token`，API Key 优先。`CodexAuth` 只在前两者都不存在时才被使用。

- **`account_id` 仅来自 CodexAuth**：前两条路径（API Key、experimental bearer）都不设置 `account_id`，只有 ChatGPT OAuth 认证才会携带。上层逻辑若依赖 `account_id`（如审计、配额追踪），需注意此限制。

- **`external_bearer_only` 的特殊性**：通过 `AuthManager::external_bearer_only()` 创建的 manager 使用哑路径 `"non-existent"` 作为 `codex_home`，且内部 `auth` 缓存为空。它完全依赖 `BearerTokenRefresher`（外部命令）获取 token，不走常规的 OAuth/API Key 流程（`codex-rs/login/src/auth/manager.rs:1196-1211`）。

- **`provider.auth` 的 `clone()` 开销**：两个 `auth_manager_*` 函数都对 `provider.auth` 进行了 `clone()`。`ModelProviderAuthInfo` 包含命令字符串等数据，在高频调用场景下可能值得关注。