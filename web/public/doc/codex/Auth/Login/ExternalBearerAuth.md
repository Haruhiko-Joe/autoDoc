# ExternalBearerAuth — 外部 Bearer Token 认证

## 概述与职责

`ExternalBearerAuth` 模块为自定义模型提供商（model provider）提供基于外部 shell 命令的 Bearer Token 认证机制。它属于 **Auth → Login** 层级，是 Login 子系统中可插拔认证策略的一种实现。

在 Codex 的架构中，当用户配置了自定义模型提供商（如私有部署的 LLM 服务）时，该提供商可能需要一个 Bearer Token 进行 API 认证。与内置的 ChatGPT OAuth 流程或静态 API Key 不同，`ExternalBearerAuth` 通过执行用户配置的 shell 命令来动态获取 token，适用于需要从外部认证系统（如 `gcloud auth print-access-token`、`aws sso get-role-credentials` 等）获取临时凭证的场景。

**同级模块**包括 ChatGPTClient（ChatGPT 后端认证）、KeyringStore（OS 密钥链存储）和 Secrets（加密密钥管理），它们共同构成 Auth 子系统的完整认证能力。

## 关键流程

### Token 获取与缓存流程（resolve）

`resolve()` 方法是主要的 token 获取入口，实现了"缓存优先、按需刷新"的策略：

1. **获取缓存锁**：通过 `Mutex<Option<CachedExternalBearerToken>>` 对缓存进行互斥访问（`external_bearer.rs:38`）
2. **检查缓存有效性**：若存在缓存 token，根据 `refresh_interval` 判断是否过期：
   - 若 `refresh_interval_ms > 0`，检查 `fetched_at.elapsed() < refresh_interval`（`external_bearer.rs:40-41`）
   - 若 `refresh_interval_ms == 0`（即 `refresh_interval()` 返回 `None`），缓存永不主动过期，仅在 401 触发 `refresh()` 时更新（`external_bearer.rs:42`）
3. **缓存命中**：直接返回缓存的 `access_token`，封装为 `ExternalAuthTokens::access_token_only`
4. **缓存未命中**：调用 `run_provider_auth_command()` 执行 shell 命令获取新 token，写入缓存并返回

### 强制刷新流程（refresh）

当模型提供商返回 401（Unauthorized）时，`AuthManager` 会调用 `refresh()` 方法强制重新获取 token：

1. 无条件执行 `run_provider_auth_command()` 获取新 token（`external_bearer.rs:65`）
2. 更新缓存中的 token 和时间戳（`external_bearer.rs:66-70`）
3. 返回新的 `ExternalAuthTokens`

注意：`refresh()` 忽略传入的 `ExternalAuthRefreshContext`（参数命名为 `_context`），因为 Bearer Token 刷新不需要关心前一个 token 的 account_id 等元信息。

### Shell 命令执行流程（run_provider_auth_command）

这是实际执行用户配置的外部命令的核心函数（`external_bearer.rs:101-157`）：

1. **程序路径解析**：调用 `resolve_provider_auth_program()` 解析命令路径（`external_bearer.rs:102`）
2. **构建 Command**：使用 `tokio::process::Command` 配置子进程：
   - 设置命令参数（`config.args`）和工作目录（`config.cwd`）
   - stdin 设为 null，stdout/stderr 设为 piped
   - 启用 `kill_on_drop` 确保进程不会泄漏（`external_bearer.rs:103-110`）
3. **带超时执行**：通过 `tokio::time::timeout(config.timeout(), ...)` 限制执行时间（`external_bearer.rs:112`）
4. **错误处理**：依次检查超时、启动失败、非零退出码、非 UTF-8 输出、空输出等情况，生成详细的错误信息
5. **提取 token**：对 stdout 做 `trim()` 处理后作为 access_token 返回（`external_bearer.rs:148`）

### 命令路径解析逻辑（resolve_provider_auth_program）

路径解析函数（`external_bearer.rs:159-170`）处理三种情况：

1. **绝对路径**：直接使用（如 `/usr/bin/gcloud`）
2. **相对路径（含目录分隔符）**：相对于 `cwd` 解析（如 `./scripts/get-token.sh` → `{cwd}/scripts/get-token.sh`）
3. **裸命令名**：直接传递给 OS，由 `PATH` 环境变量解析（如 `gcloud`）

## 核心类型

### `BearerTokenRefresher`

```rust
// external_bearer.rs:18-20
pub(crate) struct BearerTokenRefresher {
    state: Arc<ExternalBearerAuthState>,
}
```

模块的公开入口类型，实现了 `ExternalAuth` trait 和 `Clone`。内部状态通过 `Arc` 共享，支持在多个异步任务间安全使用。

### `ExternalBearerAuthState`

```rust
// external_bearer.rs:82-85
struct ExternalBearerAuthState {
    config: ModelProviderAuthInfo,
    cached_token: Mutex<Option<CachedExternalBearerToken>>,
}
```

持有配置和缓存状态。`Mutex` 是 `tokio::sync::Mutex`，确保异步安全的互斥访问。

### `CachedExternalBearerToken`

```rust
// external_bearer.rs:96-99
struct CachedExternalBearerToken {
    access_token: String,
    fetched_at: Instant,
}
```

缓存的 token 及其获取时间，用于判断是否需要刷新。

### `ModelProviderAuthInfo`（外部依赖）

来自 `codex_protocol::config_types`，包含用户配置的全部参数：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `command` | `String` | — | 要执行的命令 |
| `args` | `Vec<String>` | `[]` | 命令参数 |
| `timeout_ms` | `NonZeroU64` | 30000 | 命令超时时间（毫秒） |
| `refresh_interval_ms` | `u64` | 300000 (5分钟) | 缓存刷新间隔（毫秒），设为 0 禁用主动刷新 |
| `cwd` | `AbsolutePathBuf` | 当前目录 | 命令工作目录 |

## 接口实现

`BearerTokenRefresher` 实现了 `ExternalAuth` trait（定义于 `manager.rs:151`），该 trait 是 `AuthManager` 用于管理可插拔认证提供者的抽象接口：

- **`auth_mode()`** → 返回 `AuthMode::ApiKey`，表明该认证方式在 API 层面表现为 API Key 模式（Bearer Token 作为 API Key 使用）
- **`resolve()`** → 带缓存的 token 获取
- **`refresh()`** → 强制重新获取 token

## 边界 Case 与注意事项

- **并发安全**：`cached_token` 使用 `tokio::sync::Mutex` 保护，`resolve()` 在持锁期间完成命令执行和缓存更新，确保不会出现重复请求。但这也意味着并发调用 `resolve()` 时会串行化执行。
- **进程泄漏防护**：`kill_on_drop(true)` 确保 `Command` 被 drop 时子进程会被终止，避免超时场景下的进程泄漏。
- **错误信息包含 stderr**：命令失败时，错误信息会附带 stderr 输出，帮助用户诊断认证命令的问题（`external_bearer.rs:128-139`）。
- **空 token 视为错误**：命令成功执行但 stdout 为空（或仅含空白字符）时，会返回明确的错误而非静默传递空 token（`external_bearer.rs:149-153`）。
- **`refresh_interval_ms = 0` 的语义**：设为 0 时，`refresh_interval()` 返回 `None`，缓存不会主动过期。token 仅在收到 401 后通过 `refresh()` 更新。这适用于 token 有效期很长或由外部系统管理过期的场景。