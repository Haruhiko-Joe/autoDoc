# OAuth 浏览器登录

## 概述与职责

OAuth 浏览器登录模块是 Codex CLI 交互式登录流程的核心实现，属于 **Auth → Login** 子系统。它通过在本地启动一个短生命周期的 HTTP 服务器，配合浏览器完成 OAuth 2.0 Authorization Code + PKCE 流程，最终获取并持久化用户的认证令牌。

在整体架构中，Auth 模块为 Core、TUI、AppServer、ModelProviders、CloudTasks 等多个顶层模块提供认证凭证。Login 是 Auth 的核心子模块，而本模块（OAuthBrowserLogin）专门负责浏览器交互式登录这一路径。同级的其他模块包括 ChatGPTClient（后端 API 客户端）、KeyringStore（OS 密钥链存储）和 Secrets（加密密钥管理）。

本模块由三个文件组成：
- `server.rs` — 本地回调服务器、OAuth 流程编排、令牌交换与持久化
- `pkce.rs` — PKCE 码对生成
- `assets/` — 登录成功和错误的 HTML 页面模板

## 关键流程

### 整体登录流程 Walkthrough

```
用户发起登录
    │
    ▼
run_login_server()
    ├── 1. generate_pkce()        → 生成 PKCE code_verifier / code_challenge
    ├── 2. generate_state()       → 生成随机 state 参数（防 CSRF）
    ├── 3. bind_server()          → 绑定 127.0.0.1:1455（默认端口）
    ├── 4. build_authorize_url()  → 构造 OpenAI OAuth 授权 URL
    ├── 5. webbrowser::open()     → 打开用户浏览器
    └── 6. 进入请求循环，等待回调
              │
              ▼
        浏览器完成认证后重定向到 /auth/callback?code=...&state=...
              │
              ▼
        process_request() → 路由分发
              ├── /auth/callback  → 验证 state → 交换 code → 验证 workspace → 持久化
              ├── /success        → 返回成功页面并退出服务器
              └── /cancel         → 取消登录并退出服务器
```

### 1. PKCE 码对生成

`generate_pkce()` 生成符合 RFC 7636 的 PKCE 码对（`codex-rs/login/src/pkce.rs:12-27`）：

- 使用 `rand::rng()` 生成 64 字节随机数据
- `code_verifier`：对随机字节进行 URL-safe Base64 无填充编码
- `code_challenge`：对 verifier 做 SHA-256 哈希后再 URL-safe Base64 无填充编码（S256 方法）

```rust
pub struct PkceCodes {
    pub code_verifier: String,
    pub code_challenge: String,
}
```

### 2. 服务器绑定与端口冲突处理

`bind_server()` 尝试在 `127.0.0.1:{port}` 上启动 `tiny_http` 服务器（`server.rs:529-572`）。如果端口被占用（可能有上一次未关闭的登录服务器），它会：

1. 向该端口发送 `GET /cancel` 请求，尝试关闭上一个实例
2. 每 200ms 重试一次，最多重试 10 次
3. 仍然失败则返回 `AddrInUse` 错误

### 3. 授权 URL 构造

`build_authorize_url()` 构造 OpenAI 的 OAuth 授权端点 URL（`server.rs:468-504`），包含以下查询参数：

| 参数 | 值 |
|------|------|
| `response_type` | `code` |
| `client_id` | 配置的客户端 ID |
| `redirect_uri` | `http://localhost:{port}/auth/callback` |
| `scope` | `openid profile email offline_access api.connectors.read api.connectors.invoke` |
| `code_challenge` | PKCE challenge |
| `code_challenge_method` | `S256` |
| `state` | 随机 state 值 |
| `originator` | 来源标识 |
| `allowed_workspace_id` | （可选）强制限定的 workspace |

### 4. 回调处理（`/auth/callback`）

收到浏览器回调后（`server.rs:276-397`），处理逻辑如下：

1. **验证 state**：比对回调中的 `state` 与发出时的值，不匹配则返回 400
2. **检查 OAuth 错误**：如果回调携带 `error` 参数，生成用户友好的错误消息。特别处理 `missing_codex_entitlement` 错误，给出明确的"联系管理员"提示
3. **提取 authorization code**：缺失则返回错误页
4. **交换令牌**：调用 `exchange_code_for_tokens()` 向 `{issuer}/oauth/token` 发送 POST 请求，传入 code、redirect_uri、client_id、code_verifier，获得 id_token、access_token、refresh_token
5. **验证 workspace 限制**：`ensure_workspace_allowed()` 检查 ID token 中的 `chatgpt_account_id` 是否匹配 `forced_chatgpt_workspace_id`
6. **获取 API Key**：通过 `obtain_api_key()` 执行 OAuth token exchange（`urn:ietf:params:oauth:grant-type:token-exchange`），将 ID token 换为 OpenAI API key
7. **持久化**：`persist_tokens_async()` 解析 JWT claims，构建 `AuthDotJson` 结构体，调用 `save_auth()` 存储到本地
8. **重定向到成功页**：构造包含 token 信息的 `/success` URL 并 302 重定向

### 5. 令牌持久化

`persist_tokens_async()` 在 `spawn_blocking` 中执行（`server.rs:756-789`）：

- 解析 ID token 的 JWT claims 提取用户信息
- 从 claims 中提取 `chatgpt_account_id`
- 构建 `AuthDotJson`，设置 `auth_mode` 为 `AuthMode::Chatgpt`
- 调用 `save_auth()` 按配置的 `AuthCredentialsStoreMode`（文件/keyring/自动）存储

### 6. 成功页与 Onboarding 引导

成功页 `success.html` 根据 JWT claims 中的 `completed_platform_onboarding` 和 `is_org_owner` 字段判断用户是否需要完成 API 组织设置（`server.rs:791-837`）：

- 如果 `needs_setup = true`（未完成 onboarding 且是组织 owner），页面显示"Finish setting up your API organization"，3 秒后自动重定向到 `platform.openai.com/org-setup`
- 否则显示"Signed in to Codex"和"You may now close this page"

## 函数签名与参数说明

### `run_login_server(opts: ServerOptions) -> io::Result<LoginServer>`

模块入口函数。启动本地回调服务器并返回控制句柄。

- **参数** `opts`：服务器配置选项
- **返回** `LoginServer`，包含 `auth_url`（需要在浏览器中打开的授权 URL）、`actual_port`（实际绑定端口）、以及 `block_until_done()` / `cancel()` 方法

> 源码位置：`codex-rs/login/src/server.rs:133-243`

### `generate_pkce() -> PkceCodes`

生成 PKCE code_verifier 和 code_challenge 码对。

> 源码位置：`codex-rs/login/src/pkce.rs:12-27`

### `exchange_code_for_tokens(issuer, client_id, redirect_uri, pkce, code) -> io::Result<ExchangedTokens>`

将授权码交换为令牌三元组（id_token, access_token, refresh_token）。

> 源码位置：`codex-rs/login/src/server.rs:684-753`

### `obtain_api_key(issuer, client_id, id_token) -> io::Result<String>`

通过 OAuth token exchange 将 ID token 换为 OpenAI API key。

> 源码位置：`codex-rs/login/src/server.rs:1059-1092`

### `ensure_workspace_allowed(expected: Option<&str>, id_token: &str) -> Result<(), String>`

验证 ID token 中的 workspace ID 是否匹配预期值。`expected` 为 `None` 时跳过验证。

> 源码位置：`codex-rs/login/src/server.rs:871-889`

### `persist_tokens_async(codex_home, api_key, id_token, access_token, refresh_token, store_mode) -> io::Result<()>`

在 tokio blocking 线程中持久化认证凭证。

> 源码位置：`codex-rs/login/src/server.rs:756-789`

## 接口/类型定义

### `ServerOptions`

登录服务器配置：

| 字段 | 类型 | 说明 |
|------|------|------|
| `codex_home` | `PathBuf` | Codex 配置目录路径 |
| `client_id` | `String` | OAuth client ID |
| `issuer` | `String` | OAuth 发行方 URL，默认 `https://auth.openai.com` |
| `port` | `u16` | 本地服务器端口，默认 `1455` |
| `open_browser` | `bool` | 是否自动打开浏览器，默认 `true` |
| `force_state` | `Option<String>` | 强制指定 state 值（测试用途） |
| `forced_chatgpt_workspace_id` | `Option<String>` | 限制允许的 workspace ID |
| `cli_auth_credentials_store_mode` | `AuthCredentialsStoreMode` | 凭证存储模式 |

### `LoginServer`

运行中的登录服务器句柄：

- `auth_url: String` — 浏览器授权 URL
- `actual_port: u16` — 实际绑定的端口号
- `block_until_done()` — 等待登录完成
- `cancel()` — 请求关闭服务器
- `cancel_handle()` — 获取可克隆的取消句柄

### `ShutdownHandle`

可克隆的关闭信号句柄，内部使用 `tokio::sync::Notify` 实现。

### `PkceCodes`

```rust
pub struct PkceCodes {
    pub code_verifier: String,
    pub code_challenge: String,
}
```

### `ExchangedTokens`（crate 内部）

```rust
pub(crate) struct ExchangedTokens {
    pub id_token: String,
    pub access_token: String,
    pub refresh_token: String,
}
```

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `DEFAULT_ISSUER` | `https://auth.openai.com` | OAuth 授权服务器地址 |
| `DEFAULT_PORT` | `1455` | 本地回调服务器端口 |
| `MAX_ATTEMPTS` | `10` | 端口绑定最大重试次数 |
| `RETRY_DELAY` | `200ms` | 端口绑定重试间隔 |

## 安全设计

### PKCE 防护

使用 S256 方法的 PKCE 防止授权码拦截攻击。code_verifier 仅在最终的 token exchange 请求中发送，从不经过浏览器。

### State 参数防 CSRF

每次登录生成 32 字节随机 state，回调时严格比对。state 不匹配直接返回 400。

### 敏感信息脱敏

模块在日志记录方面做了精心设计（`server.rs:594-677`）：

- `SENSITIVE_URL_QUERY_KEYS` 列表定义了需要脱敏的参数名（access_token、code、refresh_token 等）
- `redact_sensitive_url_parts()` 在记录日志前清除 URL 中的用户名、密码、fragment，并替换敏感查询参数值为 `<redacted>`
- `redact_sensitive_error_url()` 对 reqwest 错误中携带的 URL 做同样处理
- 结构化日志（tracing）只记录经过审查的字段，不记录完整的错误消息字符串

### HTML 转义

`html_escape()` 对动态插入错误页的内容做 `& < > " '` 五字符转义，防止 XSS（`server.rs:1043-1056`）。

## 边界 Case 与注意事项

- **端口占用**：如果默认端口 1455 被占用（可能是上次登录未正常退出），模块会自动向旧实例发送 `/cancel` 请求尝试关闭，然后重试绑定
- **Workspace 限制**：当配置了 `forced_chatgpt_workspace_id` 时，即使 OAuth 流程成功，如果 ID token 中的 `chatgpt_account_id` 不匹配也会被拒绝
- **Codex 未授权**：`missing_codex_entitlement` 错误有专门的用户友好提示，引导联系管理员
- **API Key 获取失败**：`obtain_api_key()` 的结果是 `.ok()` 处理的——即使 token exchange 获取 API key 失败，登录仍然会成功（只是没有 API key）
- **Connection: close 问题**：`send_response_with_disconnect()` 绕过了 tiny_http 的响应机制手动写入 HTTP 响应并强制 `Connection: close`，因为 tiny_http 会过滤掉 Connection 头，导致 keep-alive 连接阻塞后续登录（`server.rs:424-466`）
- **异步/阻塞桥接**：tiny_http 是同步的，通过 `tokio::sync::mpsc` channel 将请求桥接到 async 处理循环；token 持久化通过 `spawn_blocking` 在阻塞线程中执行