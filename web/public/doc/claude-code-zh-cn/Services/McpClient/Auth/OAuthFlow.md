# OAuth 授权流程（OAuthFlow）

## 概述与职责

OAuthFlow 模块是 MCP 客户端认证子系统的核心组件，实现了完整的 **OAuth 2.0 授权码流程（PKCE）**，为 Claude Code 连接需要认证的 MCP 服务器提供安全的身份验证能力。

在整体架构中，该模块位于 **Services → McpClient → Auth** 层级。它被 `ClientCore`（MCP 客户端核心）直接调用——当 MCP 服务器返回 401/403 时，`ClientCore` 通过 `ClaudeAuthProvider` 和 `performMCPOAuthFlow` 发起认证流程。同级模块包括 XAA 跨应用认证（`xaa.ts`）和 IdP 登录（`xaaIdpLogin.ts`），但本模块同时也是 XAA 流程的编排入口。

模块由两个文件组成：
- **`src/services/mcp/auth.ts`**：主文件（~2466 行），包含 `ClaudeAuthProvider` 类、`performMCPOAuthFlow` 编排函数、令牌管理、错误标准化等全部核心逻辑
- **`src/services/mcp/oauthPort.ts`**：OAuth 重定向端口选择工具（79 行），从 `auth.ts` 提取以打破与 `xaaIdpLogin.ts` 的循环依赖

## 关键流程

### 标准 OAuth 授权码流程（PKCE）

`performMCPOAuthFlow` 是整个认证的主编排函数（`src/services/mcp/auth.ts:847-1342`），完整流程如下：

1. **路径分发**：检查 `serverConfig.oauth?.xaa`，若配置了 XAA 则转入 `performMCPXaaAuth`，否则走标准 OAuth 流程
2. **读取缓存的 step-up 状态**：从 keychain 读取之前 403 响应缓存的 `stepUpScope` 和 `resourceMetadataUrl`
3. **清除旧凭据**：调用 `clearServerTokensFromLocalStorage` 确保全新注册
4. **端口分配**：优先使用配置的 `callbackPort`，否则调用 `findAvailablePort()` 随机选择可用端口
5. **创建 Provider**：实例化 `ClaudeAuthProvider`，传入 redirect URI 和回调函数
6. **元数据发现**：通过 `fetchAuthServerMetadata` 按 RFC 9728 → RFC 8414 顺序发现授权服务器
7. **启动本地 HTTP 服务器**：在 `127.0.0.1:port` 监听 `/callback` 路径，等待授权码回调
8. **触发 SDK 认证**：调用 `sdkAuth(provider, ...)` 启动 PKCE 流程，SDK 内部完成动态客户端注册（DCR）、生成 code_verifier/code_challenge、构建授权 URL
9. **浏览器跳转**：`redirectToAuthorization` 方法打开浏览器到授权 URL
10. **等待授权码**：本地 HTTP 服务器接收回调，验证 `state` 参数防止 CSRF，提取 `code`
11. **令牌交换**：再次调用 `sdkAuth` 携带 `authorizationCode` 完成令牌交换
12. **存储令牌**：通过 `saveTokens` 将 access_token、refresh_token 安全存储到 keychain

超时设定为 **5 分钟**（`src/services/mcp/auth.ts:1204-1213`），服务器使用 `unref()` 避免阻塞进程退出。

### 令牌刷新流程（含跨进程锁）

`refreshAuthorization` 方法（`src/services/mcp/auth.ts:2090-2175`）实现了带锁的安全刷新：

1. **获取文件锁**：使用 `lockfile.lock()` 在 `~/.claude/mcp-refresh-{key}.lock` 上获取排他锁，最多重试 5 次，每次间隔 1-2 秒随机延迟
2. **检查竞争**：加锁后清除 keychain 缓存重新读取——如果另一个 Claude Code 进程已刷新且令牌有效期 > 300 秒，直接复用
3. **执行刷新**：`_doRefresh` 方法（`src/services/mcp/auth.ts:2177-2359`）最多重试 3 次，指数退避（1s/2s/4s）
4. **错误处理**：
   - `InvalidGrantError`：先检查其他进程是否已刷新，若无则清除令牌触发重新认证
   - 超时/5xx/429：可重试，直到 3 次用尽
   - 其他错误：不可重试，直接返回 undefined

### 主动令牌刷新

`tokens()` 方法（`src/services/mcp/auth.ts:1540-1702`）在每次 MCP 请求前被 SDK 调用，包含主动刷新逻辑：

- 当令牌剩余有效期 ≤ 300 秒且存在 refresh_token 时，主动触发刷新
- 使用 `_refreshInProgress` Promise 去重，避免并发刷新
- 若 step-up 认证待处理，故意省略 refresh_token，迫使 SDK 走 PKCE 重认证（因为 RFC 6749 §6 禁止通过 refresh 提升 scope）

### XAA 跨应用认证流程

当 `serverConfig.oauth?.xaa` 为 true 时，`performMCPXaaAuth`（`src/services/mcp/auth.ts:664-845`）执行：

1. 从 keychain 获取/通过 OIDC 浏览器登录获取 IdP 的 `id_token`
2. 通过 RFC 8693 令牌交换 + RFC 7523 JWT Bearer 授权，将 id_token 换为 MCP 服务器的 access_token
3. 令牌写入 keychain 同一存储位置，后续流程与标准 OAuth 一致

XAA 的静默刷新由 `xaaRefresh()` 私有方法处理（`src/services/mcp/auth.ts:1751-1850`），当 access_token 过期且无 refresh_token 时自动触发。

### Step-up 认证检测

`wrapFetchWithStepUpDetection`（`src/services/mcp/auth.ts:1354-1374`）包装 fetch 函数，拦截 403 响应：

1. 检查 `WWW-Authenticate` 头中的 `insufficient_scope`
2. 提取所需 scope（支持引号和非引号格式）
3. 调用 `provider.markStepUpPending(scope)` 标记待提升
4. 下次 `tokens()` 调用时省略 refresh_token，强制 SDK 走 PKCE 流程请求更高 scope

## 函数签名与参数说明

### `performMCPOAuthFlow(serverName, serverConfig, onAuthorizationUrl, abortSignal?, options?): Promise<void>`

主编排函数，执行完整的 OAuth 或 XAA 认证流程。

| 参数 | 类型 | 说明 |
|------|------|------|
| `serverName` | `string` | MCP 服务器名称 |
| `serverConfig` | `McpSSEServerConfig \| McpHTTPServerConfig` | 服务器配置，含 URL 和 OAuth 选项 |
| `onAuthorizationUrl` | `(url: string) => void` | 授权 URL 回调，用于 UI 展示 |
| `abortSignal` | `AbortSignal` | 可选，用户取消信号 |
| `options.skipBrowserOpen` | `boolean` | 可选，跳过自动打开浏览器 |
| `options.onWaitingForCallback` | `(submit) => void` | 可选，支持手动粘贴回调 URL（远程环境） |

> 源码位置：`src/services/mcp/auth.ts:847-1342`

### `wrapFetchWithStepUpDetection(baseFetch, provider): FetchLike`

包装 fetch，检测 403 `insufficient_scope` 触发 step-up 认证。

> 源码位置：`src/services/mcp/auth.ts:1354-1374`

### `getServerKey(serverName, serverConfig): string`

生成服务器凭据的唯一键，格式为 `{serverName}|{sha256Hash前16位}`。哈希基于 type、url、headers 计算，防止同名不同配置的服务器复用凭据。

> 源码位置：`src/services/mcp/auth.ts:325-341`

### `revokeServerTokens(serverName, serverConfig, options?): Promise<void>`

撤销令牌并清除本地存储。按 RFC 7009 先撤销 refresh_token（防止生成新 access_token），再撤销 access_token。`preserveStepUpState` 选项保留 step-up scope 和 discovery 状态以加速重认证。

> 源码位置：`src/services/mcp/auth.ts:467-618`

### `hasMcpDiscoveryButNoToken(serverName, serverConfig): boolean`

检测服务器是否已完成 OAuth 发现但没有有效令牌——此状态下连接必定 401，只能通过 `/mcp` 命令重新认证。XAA 服务器除外（可通过缓存 id_token 静默重认证）。

> 源码位置：`src/services/mcp/auth.ts:349-363`

### `normalizeOAuthErrorBody(response): Promise<Response>`

标准化非标 OAuth 错误响应。某些服务器（如 Slack）在 HTTP 200 中返回错误 JSON，此函数将其重写为 400 响应以触发 SDK 正确的错误处理。同时将 Slack 的非标错误码（`invalid_refresh_token`、`expired_refresh_token`、`token_expired`）映射为标准 `invalid_grant`。

> 源码位置：`src/services/mcp/auth.ts:157-191`

### `findAvailablePort(): Promise<number>`

在端口范围内随机选择可用端口。优先使用 `MCP_OAUTH_CALLBACK_PORT` 环境变量，否则随机尝试最多 100 次，最后回退到端口 3118。

> 源码位置：`src/services/mcp/oauthPort.ts:36-78`

### `buildRedirectUri(port?): string`

构建 `http://localhost:{port}/callback` 格式的重定向 URI。遵循 RFC 8252 §7.3（本机应用 OAuth 环回地址匹配规则）。

> 源码位置：`src/services/mcp/oauthPort.ts:21-25`

## ClaudeAuthProvider 类

`ClaudeAuthProvider` 实现 MCP SDK 的 `OAuthClientProvider` 接口（`src/services/mcp/auth.ts:1376-2360`），是整个模块的核心类。

### 关键属性

| 属性 | 用途 |
|------|------|
| `_refreshInProgress` | 去重并发刷新请求的 Promise |
| `_pendingStepUpScope` | 403 检测到的待提升 scope |
| `_metadata` | 缓存的授权服务器元数据 |
| `_codeVerifier` | PKCE code verifier，仅在内存中保存 |

### 接口方法

| 方法 | 职责 |
|------|------|
| `clientMetadata` | 返回 OAuth 客户端元数据（公开客户端，支持 authorization_code 和 refresh_token） |
| `clientMetadataUrl` | 返回 CIMD（SEP-991）URL，支持 `MCP_OAUTH_CLIENT_METADATA_URL` 环境变量覆盖 |
| `clientInformation()` | 从 keychain 读取已注册的 client_id/secret，或回退到配置的 clientId |
| `saveClientInformation()` | 保存 DCR 返回的客户端信息到 keychain |
| `tokens()` | 读取令牌、触发主动刷新或 XAA 静默交换 |
| `saveTokens()` | 保存令牌到 keychain，同时清除 `_pendingStepUpScope` |
| `redirectToAuthorization()` | 打开浏览器到授权 URL，持久化 step-up scope |
| `saveCodeVerifier()` / `codeVerifier()` | PKCE code verifier 的内存存取 |
| `invalidateCredentials(scope)` | 按范围（all/client/tokens/verifier/discovery）清除凭据 |
| `saveDiscoveryState()` / `discoveryState()` | 持久化/读取 OAuth 发现状态（仅 URL，不含完整元数据，避免 keychain 溢出 #30337） |
| `refreshAuthorization()` | 带文件锁的令牌刷新 |

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `serverConfig.oauth.callbackPort` | MCP 服务器配置 | 随机端口 | OAuth 回调端口 |
| `serverConfig.oauth.clientId` | MCP 服务器配置 | - | 预配置的 OAuth 客户端 ID |
| `serverConfig.oauth.authServerMetadataUrl` | MCP 服务器配置 | - | 自定义授权服务器元数据 URL（必须 HTTPS） |
| `serverConfig.oauth.xaa` | MCP 服务器配置 | - | 启用 XAA 跨应用认证 |
| `MCP_OAUTH_CALLBACK_PORT` | 环境变量 | - | 覆盖 OAuth 回调端口 |
| `MCP_OAUTH_CLIENT_METADATA_URL` | 环境变量 | `MCP_CLIENT_METADATA_URL` 常量 | 覆盖 CIMD URL |
| `CLAUDE_CODE_ENABLE_XAA` | 环境变量 | - | 启用 XAA 功能（`=1`） |
| `MCP_CLIENT_SECRET` | 环境变量 | - | 通过环境变量提供客户端密钥 |
| `AUTH_REQUEST_TIMEOUT_MS` | 内部常量 | 30000 (30s) | 单次 OAuth 请求超时 |
| `MAX_LOCK_RETRIES` | 内部常量 | 5 | 刷新锁最大重试次数 |
| 认证等待超时 | 内部硬编码 | 300000 (5min) | 等待用户完成浏览器认证的超时 |
| 端口范围 (macOS/Linux) | 内部常量 | 49152-65535 | 随机端口选择范围 |
| 端口范围 (Windows) | 内部常量 | 39152-49151 | 避开 Windows 动态端口保留区 |
| 回退端口 | 内部常量 | 3118 | 随机选端口失败时的兜底端口 |

## 边界 Case 与注意事项

### 安全措施
- **CSRF 防护**：通过 `state` 参数验证，不匹配直接拒绝并返回 400
- **XSS 防护**：回调页面中的错误信息使用 `xss` 库过滤
- **日志脱敏**：`redactSensitiveUrlParams` 将 state、nonce、code、code_verifier 等敏感参数替换为 `[REDACTED]`
- **URL Scheme 校验**：授权 URL 必须使用 `http://` 或 `https://`

### keychain 存储限制
- macOS keychain 通过 `security -i` 写入，有 4096 字节行限制（hex 编码后约 2013 字节 JSON）
- `saveDiscoveryState` 只持久化 URL 而不存完整元数据 blob，避免多 MCP 服务器时溢出（#30337）

### 跨进程竞争
- 令牌刷新使用文件锁去重，但 XAA 静默刷新（`xaaRefresh`）目前仅有进程内 Promise 去重，跨进程竞争可能导致重复交换（不会破坏功能，但浪费请求）
- `tokens()` 方法在热路径上被频繁调用（每次 MCP 请求），不清除 keychain 缓存以避免 CPU 开销（`spawnSync` 曾达 7.2% CPU）

### 非标服务器兼容
- Slack 等服务器在 HTTP 200 中返回 OAuth 错误：`normalizeOAuthErrorBody` 将其重写为 400
- 令牌撤销在 RFC 7009 合规失败时（401），自动回退到 Bearer 认证方式
- 撤销端点认证方法从 `revocation_endpoint_auth_methods_supported` 读取，回退到 `token_endpoint_auth_methods_supported`

### 手动回调支持
- `options.onWaitingForCallback` 允许用户手动粘贴回调 URL，用于 localhost 不可达的远程/浏览器环境

### `invalid_client` 自动恢复
- 当令牌交换返回 `invalid_client` 且消息含 "Client not found" 时，自动清除存储的 clientId/clientSecret，下次认证将触发重新注册