# RMCP 客户端库（codex-rmcp-client）

## 概述与职责

`codex-rmcp-client` 是 Codex 中与外部 MCP（Model Context Protocol）服务器通信的底层客户端库，位于系统架构中 **MCP** 模块之下。它封装了官方 [rmcp Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)，对上层提供统一的 `RmcpClient` 类型，支持两种传输方式连接 MCP 服务器：

1. **Stdio 子进程传输**：启动本地 MCP 服务器进程，通过 stdin/stdout 通信
2. **Streamable HTTP 传输**：通过 HTTP + SSE 连接远程 MCP 服务器，支持 OAuth 2.0 认证

在整体架构中，`RmcpClient` 被上层的 ToolSystem 和 Core 模块调用，用于发现和调用 MCP 服务器提供的工具。它与 Auth 模块协作完成 OAuth 登录，与 Config 模块协作读取 MCP 服务器的连接配置。同级模块还包括 MCP Server（将 Codex 自身暴露为 MCP 服务提供者）。

## 关键流程

### 1. Stdio 子进程连接流程

1. 调用 `RmcpClient::new_stdio_client()` 创建客户端实例（`src/rmcp_client.rs:478-504`）
2. 通过 `create_env_for_mcp_server()` 构造干净的环境变量集——仅传递白名单中的系统变量（Unix 上包括 `HOME`、`PATH`、`SHELL` 等，Windows 上包括 `PATH`、`PATHEXT`、`SYSTEMROOT` 等）以及用户指定的额外变量（`src/utils.rs:10-21`）
3. 通过 `program_resolver::resolve()` 解析可执行文件路径——Unix 上直接返回原始名称（依赖 shebang 机制），Windows 上使用 `which` crate 查找带扩展名的完整路径（如 `.cmd`、`.bat`），解决 `npx`/`uvx` 等工具在 Windows 上的执行问题（`src/program_resolver.rs:22-56`）
4. 以 `process_group(0)` 启动子进程（Unix），创建独立进程组，并通过 `ProcessGroupGuard` 在 Drop 时先发 SIGTERM 再等待 2 秒后发 SIGKILL 确保清理（`src/rmcp_client.rs:340-386`）
5. 子进程的 stderr 被异步转发到 tracing 日志
6. 调用 `initialize()` 完成 MCP 协议握手

### 2. Streamable HTTP 连接流程

1. 调用 `RmcpClient::new_streamable_http_client()` 创建客户端实例（`src/rmcp_client.rs:507-532`）
2. 构建默认 HTTP headers（合并静态 headers 和环境变量引用的 headers）
3. 认证策略按优先级选择：
   - **Bearer Token**：如果提供了 `bearer_token` 参数或 headers 中已有 `Authorization`，直接使用
   - **已有 OAuth 令牌**：从 keyring/文件加载已保存的 OAuth tokens，通过 `AuthClient` 包装的传输层自动处理令牌附加和刷新
   - **无认证**：使用普通 HTTP 传输
4. 如果 OAuth 元数据发现不可用（`AuthError::NoAuthorizationSupport`），则回退为将已存储的 access token 作为静态 bearer token 使用（`src/rmcp_client.rs:953-976`）

### 3. MCP 协议初始化

`initialize()` 方法（`src/rmcp_client.rs:536-588`）完成 [MCP 生命周期初始化握手](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#initialization)：

1. 取出预构建的 `PendingTransport`
2. 通过 `service::serve_client()` 启动 rmcp 服务层
3. 可选地应用超时控制
4. 将状态从 `Connecting` 切换为 `Ready`
5. 初始化完成后立即持久化 OAuth tokens（如适用）

### 4. 会话过期自动恢复

当 Streamable HTTP 会话因服务端返回 404 而过期时，客户端自动重建连接（`src/rmcp_client.rs:1112-1161`）：

1. `run_service_operation()` 检测到 `SessionExpired404` 错误
2. 获取 `session_recovery_lock` 防止并发恢复
3. 检查是否已被其他线程恢复（通过 `Arc::ptr_eq` 比较）
4. 使用保存的 `TransportRecipe` 和 `InitializeContext` 重建传输和服务
5. 透明地重试原始操作

### 5. OAuth 2.0 登录流程

`perform_oauth_login()` 函数（`src/perform_oauth_login.rs:73-97`）驱动完整的浏览器式 OAuth 登录：

1. 启动本地 HTTP 回调服务器（`tiny_http`），绑定到 `127.0.0.1` 的指定端口或随机端口
2. 通过 `OAuthState::new()` 从服务器发现 OAuth 元数据
3. 调用 `start_authorization()` 生成授权 URL（client name 固定为 `"Codex"`）
4. 可选附加 `resource` 查询参数
5. 调用 `webbrowser::open()` 打开浏览器（失败时打印 URL 供手动复制）
6. 回调服务器在 blocking 线程中等待 OAuth 重定向，解析 `code` 和 `state` 参数
7. 调用 `handle_callback()` 用授权码换取 tokens
8. 将 tokens 持久化到存储
9. 默认超时 300 秒

还提供了两个变体：
- `perform_oauth_login_silent()`：不打印授权 URL
- `perform_oauth_login_return_url()`：不启动浏览器，返回 `OauthLoginHandle` 供调用方控制流程

### 6. OAuth Token 持久化

`OAuthPersistor`（`src/oauth.rs:268-376`）负责运行时的令牌生命周期管理：

- `persist_if_needed()`：从 `AuthorizationManager` 获取当前凭据，与上次保存的比较，有变化时写入存储
- `refresh_if_needed()`：检查 `expires_at` 时间戳，在令牌过期前 30 秒（`REFRESH_SKEW_MILLIS`）触发刷新

### 7. 认证状态检测

`determine_streamable_http_auth_status()`（`src/auth_status.rs:30-61`）按以下优先级判断 Streamable HTTP 服务器的认证状态：

1. 有 `bearer_token_env_var` → `BearerToken`
2. 默认 headers 包含 `Authorization` → `BearerToken`
3. 本地已有 OAuth tokens → `OAuth`
4. 服务器的 OAuth 发现端点返回有效元数据 → `NotLoggedIn`
5. 以上均不满足 → `Unsupported`

OAuth 发现遵循 [RFC 8414 §3.1](https://datatracker.ietf.org/doc/html/rfc8414#section-3.1)，依次尝试以下路径（`src/auth_status.rs:172-192`）：
- `/.well-known/oauth-authorization-server/{path}`
- `/{path}/.well-known/oauth-authorization-server`
- `/.well-known/oauth-authorization-server`

## 函数签名与参数说明

### `RmcpClient::new_stdio_client`

```rust
pub async fn new_stdio_client(
    program: OsString,          // 可执行程序名或路径
    args: Vec<OsString>,        // 命令行参数
    env: Option<HashMap<OsString, OsString>>,  // 额外环境变量（覆盖默认值）
    env_vars: &[String],        // 额外白名单环境变量名
    cwd: Option<PathBuf>,       // 工作目录
) -> io::Result<Self>
```

### `RmcpClient::new_streamable_http_client`

```rust
pub async fn new_streamable_http_client(
    server_name: &str,          // 服务器标识名（用于凭据存储 key）
    url: &str,                  // MCP 服务器 HTTP 端点 URL
    bearer_token: Option<String>,          // 静态 bearer token
    http_headers: Option<HashMap<String, String>>,     // 静态 HTTP headers
    env_http_headers: Option<HashMap<String, String>>, // 环境变量引用的 HTTP headers（key→环境变量名）
    store_mode: OAuthCredentialsStoreMode,             // OAuth 凭据存储模式
) -> Result<Self>
```

### `RmcpClient::initialize`

```rust
pub async fn initialize(
    &self,
    params: InitializeRequestParams,    // MCP 客户端信息（版本、能力等）
    timeout: Option<Duration>,          // 握手超时
    send_elicitation: SendElicitation,  // 用于转发 elicitation 请求的回调
) -> Result<InitializeResult>
```

### `RmcpClient::call_tool`

```rust
pub async fn call_tool(
    &self,
    name: String,                       // 工具名称
    arguments: Option<serde_json::Value>, // JSON 对象形式的参数
    meta: Option<serde_json::Value>,    // 请求元数据
    timeout: Option<Duration>,          // 调用超时
) -> Result<CallToolResult>
```

其他公开方法包括 `list_tools()`、`list_tools_with_connector_ids()`、`list_resources()`、`list_resource_templates()`、`read_resource()`、`send_custom_notification()`、`send_custom_request()`。所有操作方法都会在执行前自动检查并刷新 OAuth token，执行后持久化 token 变更。

## 接口/类型定义

### `OAuthCredentialsStoreMode`

```rust
pub enum OAuthCredentialsStoreMode {
    Auto,    // 优先 keyring，不可用时回退文件（默认）
    File,    // 仅使用 CODEX_HOME/.credentials.json
    Keyring, // 仅使用 OS keyring，不可用则报错
}
```

### `StoredOAuthTokens`

| 字段 | 类型 | 说明 |
|------|------|------|
| `server_name` | `String` | MCP 服务器标识名 |
| `url` | `String` | 服务器 URL |
| `client_id` | `String` | OAuth client ID |
| `token_response` | `WrappedOAuthTokenResponse` | 完整的 OAuth token 响应 |
| `expires_at` | `Option<u64>` | token 过期时间（Unix 毫秒时间戳） |

### `McpAuthStatus`

认证状态枚举（从 `codex-protocol` 重导出）：`BearerToken` | `OAuth` | `NotLoggedIn` | `Unsupported`

### `SendElicitation`

```rust
pub type SendElicitation = Box<
    dyn Fn(RequestId, Elicitation) -> BoxFuture<'static, Result<ElicitationResponse>>
        + Send + Sync,
>;
```

MCP 服务器可向客户端发送 elicitation 请求（例如要求用户确认操作），此回调负责将请求转发到 UI 层并等待用户响应。

### `OauthLoginHandle`

```rust
pub struct OauthLoginHandle {
    pub fn authorization_url(&self) -> &str;   // 获取授权 URL
    pub fn into_parts(self) -> (String, Receiver<Result<()>>);  // 拆分为 URL 和完成通知
    pub async fn wait(self) -> Result<()>;     // 等待登录完成
}
```

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| OAuth 发现超时 | 5 秒 | `DISCOVERY_TIMEOUT`，用于探测 OAuth 端点 |
| OAuth 登录超时 | 300 秒 | 等待用户完成浏览器授权的超时 |
| Token 刷新提前量 | 30 秒 | `REFRESH_SKEW_MILLIS`，在过期前 30 秒触发刷新 |
| 进程组终止宽限期 | 2 秒 | `PROCESS_GROUP_TERM_GRACE_PERIOD`，SIGTERM 到 SIGKILL 的等待时间 |
| Keyring 服务名 | `"Codex MCP Credentials"` | OS keyring 中的服务标识 |
| 凭据文件路径 | `CODEX_HOME/.credentials.json` | keyring 不可用时的回退存储 |

**环境变量白名单**：Stdio 子进程运行在清理后的环境中，仅包含平台相关的基本变量：
- **Unix**：`HOME`, `LOGNAME`, `PATH`, `SHELL`, `USER`, `__CF_USER_TEXT_ENCODING`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `TZ`
- **Windows**：`PATH`, `PATHEXT`, `COMSPEC`, `SYSTEMROOT`, `SYSTEMDRIVE`, `USERNAME`, 以及各类程序/数据目录变量

## 边界 Case 与注意事项

- **凭据存储降级**：`Auto` 模式下 keyring 写入失败（如 Linux 无 DBus）会自动回退到文件存储。保存到 keyring 成功后会删除文件中的副本，避免过期凭据残留（`src/oauth.rs:198-202`）。
- **文件权限**：凭据文件在 Unix 上创建时设置 `0o600` 权限（`src/oauth.rs:582-587`）。
- **Store key 计算**：使用 `server_name` + URL 的 SHA-256 前缀（16 位十六进制）作为存储 key，确保同一服务器的不同端点有独立的凭据（`src/oauth.rs:524-535`）。
- **HTTP 代理绕过**：OAuth 发现请求使用 `no_proxy()` 以避免 `system-configuration` crate 中可能导致 panic 的 bug（`src/auth_status.rs:89`）。
- **OAuth 元数据不可用回退**：当服务器不支持 OAuth 元数据发现但本地已有 tokens 时，将 access token 作为静态 bearer token 使用，而非报错（`src/rmcp_client.rs:953-976`）。
- **回调服务器绑定地址**：如果 `callback_url` 指向非本地地址，回调服务器绑定到 `0.0.0.0`；否则绑定到 `127.0.0.1`（`src/perform_oauth_login.rs:387-400`）。
- **会话恢复的并发安全**：`session_recovery_lock` 保证同一时刻只有一个线程执行会话恢复，其他线程通过 `Arc::ptr_eq` 检测到恢复已完成后直接复用新服务（`src/rmcp_client.rs:1116-1129`）。
- **OAuth provider 错误处理**：回调服务器能识别 OAuth provider 返回的 `error` 和 `error_description` 参数，并通过 `OAuthProviderError` 类型向上报告（`src/perform_oauth_login.rs:261-299`）。