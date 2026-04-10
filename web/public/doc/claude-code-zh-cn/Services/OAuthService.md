# OAuthService

## 概述与职责

OAuthService 是 Claude Code 的 OAuth 认证流程服务，实现了 **OAuth 2.0 授权码流程 + PKCE**（Proof Key for Code Exchange）。它位于 `Services` 层，为 API 客户端和 MCP 连接提供身份认证支持。

在整体架构中，OAuthService 是 `Services`（后端服务集成层）的子模块，与 `api/`（Anthropic API 通信）、`mcp/`（MCP 客户端）等同级。入口层（Entrypoints）在启动时初始化认证服务，远程会话模块（BridgeAndRemote）也依赖它进行会话鉴权。

模块由 5 个文件组成：

| 文件 | 职责 |
|------|------|
| `index.ts` | 主类 `OAuthService`，编排整个 OAuth 流程 |
| `client.ts` | OAuth 客户端函数——URL 构建、令牌交换/刷新、用户信息存储 |
| `crypto.ts` | PKCE 加密工具——code verifier、code challenge、state 生成 |
| `auth-code-listener.ts` | 本地 HTTP 服务器，监听浏览器 OAuth 回调 |
| `getOauthProfile.ts` | 用户配置文件获取（两种方式：OAuth Token / API Key） |

## 关键流程

### 完整 OAuth 授权码流程（PKCE）

`OAuthService.startOAuthFlow()` 是核心入口（`src/services/oauth/index.ts:32-132`），流程如下：

1. **生成 PKCE 密钥对**：构造函数中调用 `crypto.generateCodeVerifier()` 生成 43 字符的 Base64URL 随机字符串作为 code verifier；调用 `crypto.generateCodeChallenge()` 对其做 SHA-256 哈希得到 code challenge
2. **启动本地 HTTP 服务器**：创建 `AuthCodeListener` 实例，在 `localhost` 的 OS 随机端口上监听 `/callback` 路径
3. **构建授权 URL**：`client.buildAuthUrl()` 生成两个 URL：
   - **自动流程 URL**（`isManual=false`）：`redirect_uri` 指向 `http://localhost:{port}/callback`，浏览器授权后自动回调
   - **手动流程 URL**（`isManual=true`）：`redirect_uri` 指向平台托管的回调页面，用户需手动拷贝授权码
4. **等待授权码**：`waitForAuthorizationCode()` 同时监听两个通道——本地 HTTP 服务器回调（自动流程）或 `handleManualAuthCodeInput()` 被调用（手动流程），先到先得
5. **交换令牌**：`client.exchangeCodeForTokens()` 向 `TOKEN_URL` 发送 POST 请求，携带授权码、code verifier、state 等参数
6. **获取用户信息**：`client.fetchProfileInfo()` 用 access token 调用 `/api/oauth/profile` 获取订阅类型、速率限制等级等
7. **返回格式化令牌**：`formatTokens()` 将响应转换为内部 `OAuthTokens` 结构

```
用户 → 浏览器打开授权页 → 授权 → 回调到 localhost:{port}/callback
                                          ↓
                              AuthCodeListener 捕获 code + state
                                          ↓
                              exchangeCodeForTokens（POST /v1/oauth/token）
                                          ↓
                              fetchProfileInfo（GET /api/oauth/profile）
                                          ↓
                              返回 OAuthTokens（含 accessToken, refreshToken, scopes, 订阅信息等）
```

### 自动流程 vs 手动流程

OAuthService 支持两种获取授权码的方式（`src/services/oauth/index.ts:14-20`）：

- **自动流程**：调用 `openBrowser()` 打开浏览器，用户授权后 OAuth 服务商 302 重定向到 `localhost:{port}/callback`，`AuthCodeListener` 自动捕获。成功后还会将浏览器重定向到成功页面
- **手动流程**：在无浏览器环境（如远程 SSH 会话）中，向用户显示手动 URL，用户在其他设备上授权后将授权码粘贴回终端，通过 `handleManualAuthCodeInput()` 注入
- **SDK 模式**：当 `skipBrowserOpen=true` 时，两个 URL 都通过 `authURLHandler` 回调交给 SDK 调用方处理，OAuthService 自身不打开浏览器

### 令牌刷新流程

`client.refreshOAuthToken()`（`src/services/oauth/client.ts:146-274`）负责刷新过期令牌：

1. 向 `TOKEN_URL` 发送 `grant_type=refresh_token` 请求，可通过 `scopes` 参数请求特定权限范围（默认请求 `CLAUDE_AI_OAUTH_SCOPES` 全集）
2. **智能跳过 Profile 请求**：如果全局配置和安全存储中已有完整的 `billingType`、`accountCreatedAt`、`subscriptionCreatedAt`、`subscriptionType`、`rateLimitTier`，则跳过 `/api/oauth/profile` 网络请求（`src/services/oauth/client.ts:187-211`）。这项优化在全量用户中每天节省约 700 万次请求
3. 如果确实拉取了新的 Profile，增量更新 `displayName`、`hasExtraUsageEnabled`、`billingType` 等字段到全局配置

### 令牌过期判断

`client.isOAuthTokenExpired()`（`src/services/oauth/client.ts:344-353`）使用 **5 分钟缓冲时间**：当距离过期时间不足 5 分钟即视为已过期，避免在临界状态下请求失败。

## 函数签名与参数说明

### `OAuthService` 类

#### `startOAuthFlow(authURLHandler, options?): Promise<OAuthTokens>`

发起完整 OAuth 流程，返回令牌对象。

| 参数 | 类型 | 说明 |
|------|------|------|
| `authURLHandler` | `(url: string, automaticUrl?: string) => Promise<void>` | 回调函数，接收手动流程 URL（必传）和自动流程 URL（仅 `skipBrowserOpen` 时传入） |
| `options.loginWithClaudeAi` | `boolean` | 使用 Claude.ai 授权端点而非 Console 端点 |
| `options.inferenceOnly` | `boolean` | 仅请求 `user:inference` scope，用于长期推理令牌 |
| `options.expiresIn` | `number` | 自定义令牌有效期（秒） |
| `options.orgUUID` | `string` | 指定组织 UUID |
| `options.loginHint` | `string` | 预填登录邮箱（标准 OIDC `login_hint` 参数） |
| `options.loginMethod` | `string` | 指定登录方式，如 `'sso'`、`'magic_link'`、`'google'` |
| `options.skipBrowserOpen` | `boolean` | 不自动打开浏览器，将两个 URL 都交给调用方处理 |

> 源码位置：`src/services/oauth/index.ts:32-132`

#### `handleManualAuthCodeInput(params): void`

手动流程中注入授权码。

| 参数 | 类型 | 说明 |
|------|------|------|
| `params.authorizationCode` | `string` | 用户手动粘贴的授权码 |
| `params.state` | `string` | state 参数（当前实现未校验，直接传递） |

> 源码位置：`src/services/oauth/index.ts:157-167`

#### `cleanup(): void`

清理资源（关闭本地 HTTP 服务器、释放手动授权码 resolver）。

### `client.ts` 导出函数

#### `buildAuthUrl(params): string`

构建 OAuth 授权 URL，附带 PKCE 参数、scope、state 等查询参数。

> 源码位置：`src/services/oauth/client.ts:46-105`

#### `exchangeCodeForTokens(authorizationCode, state, codeVerifier, port, useManualRedirect?, expiresIn?): Promise<OAuthTokenExchangeResponse>`

用授权码交换 access/refresh token。超时 15 秒。

> 源码位置：`src/services/oauth/client.ts:107-144`

#### `refreshOAuthToken(refreshToken, options?): Promise<OAuthTokens>`

刷新 OAuth 令牌。支持通过 `scopes` 参数进行范围扩展（后端允许 `ALLOWED_SCOPE_EXPANSIONS` 列表内的扩展）。

> 源码位置：`src/services/oauth/client.ts:146-274`

#### `fetchAndStoreUserRoles(accessToken): Promise<void>`

获取用户的组织角色（`organization_role`、`workspace_role`）并写入全局配置。

> 源码位置：`src/services/oauth/client.ts:276-309`

#### `createAndStoreApiKey(accessToken): Promise<string | null>`

通过 OAuth token 创建 API Key 并保存到安全存储。

> 源码位置：`src/services/oauth/client.ts:311-342`

#### `populateOAuthAccountInfoIfNeeded(): Promise<boolean>`

如果全局配置中尚未缓存完整的账号信息，则从 Profile API 拉取并存储。支持通过环境变量 `CLAUDE_CODE_ACCOUNT_UUID`、`CLAUDE_CODE_USER_EMAIL`、`CLAUDE_CODE_ORGANIZATION_UUID` 直接提供账号信息（用于 SDK 调用方如 Cowork）。

> 源码位置：`src/services/oauth/client.ts:451-515`

### `crypto.ts` 导出函数

| 函数 | 返回值 | 说明 |
|------|--------|------|
| `generateCodeVerifier()` | `string` | 32 字节随机数的 Base64URL 编码，作为 PKCE code verifier |
| `generateCodeChallenge(verifier)` | `string` | 对 verifier 做 SHA-256 哈希后 Base64URL 编码，作为 code challenge |
| `generateState()` | `string` | 32 字节随机数的 Base64URL 编码，用于 CSRF 防护 |

> 源码位置：`src/services/oauth/crypto.ts:1-23`

### `AuthCodeListener` 类

临时 localhost HTTP 服务器，捕获 OAuth 授权码回调。

| 方法 | 说明 |
|------|------|
| `start(port?)` | 启动监听，返回实际端口号。不传 port 则由 OS 分配 |
| `waitForAuthorization(state, onReady)` | 设置 state 校验并等待回调，返回 Promise 解析出授权码 |
| `handleSuccessRedirect(scopes, customHandler?)` | 成功后将浏览器 302 到成功页面 |
| `handleErrorRedirect()` | 错误时将浏览器 302 到错误页面 |
| `hasPendingResponse()` | 判断是否有挂起的浏览器响应（即自动流程是否正在进行） |
| `close()` | 关闭服务器，清理所有监听器 |

> 源码位置：`src/services/oauth/auth-code-listener.ts:18-211`

回调验证逻辑（`src/services/oauth/auth-code-listener.ts:152-175`）：
- 检查 `code` 参数是否存在，缺失则返回 400
- 校验 `state` 参数是否匹配预期值（CSRF 防护），不匹配则返回 400
- 验证通过后**不立即响应浏览器**，而是将 `ServerResponse` 对象保存为 `pendingResponse`，等待令牌交换完成后再发送重定向

### `getOauthProfile.ts` 导出函数

| 函数 | 说明 |
|------|------|
| `getOauthProfileFromOauthToken(accessToken)` | 用 OAuth Bearer Token 调用 `/api/oauth/profile`，超时 10 秒 |
| `getOauthProfileFromApiKey()` | 用 API Key + `x-api-key` 头调用 `/api/claude_cli_profile`，需要全局配置中有 `accountUuid` |

> 源码位置：`src/services/oauth/getOauthProfile.ts:1-53`

## 配置项与默认值

### OAuth 端点配置

通过 `getOauthConfig()`（`src/constants/oauth.ts:186-234`）获取，支持三套环境：

| 环境 | 触发条件 | 授权域名 |
|------|----------|----------|
| **prod** | 默认 | `platform.claude.com` / `claude.com` |
| **staging** | `USER_TYPE=ant` + `USE_STAGING_OAUTH=1` | `platform.staging.ant.dev` |
| **local** | `USER_TYPE=ant` + `USE_LOCAL_OAUTH=1` | `localhost:3000` / `localhost:4000` |

额外覆盖机制：
- `CLAUDE_CODE_CUSTOM_OAUTH_URL`：重写所有端点到指定基础 URL，**仅允许白名单域名**（FedStart/PubSec 部署），否则抛出异常
- `CLAUDE_CODE_OAUTH_CLIENT_ID`：覆盖 Client ID（用于 Xcode 集成等场景）

### OAuth Scopes

定义在 `src/constants/oauth.ts:33-58`：

| Scope | 用途 |
|-------|------|
| `user:inference` | Claude.ai 推理权限 |
| `user:profile` | 用户配置文件读取 |
| `org:create_api_key` | Console API Key 创建 |
| `user:sessions:claude_code` | Claude Code 会话管理 |
| `user:mcp_servers` | MCP 服务器访问 |
| `user:file_upload` | 文件上传 |

登录时默认请求 `ALL_OAUTH_SCOPES`（以上全部的去重并集）。`inferenceOnly` 模式仅请求 `user:inference`。

### SDK 环境变量

| 环境变量 | 说明 |
|----------|------|
| `CLAUDE_CODE_ACCOUNT_UUID` | 直接提供账号 UUID，跳过 Profile 网络请求 |
| `CLAUDE_CODE_USER_EMAIL` | 直接提供用户邮箱 |
| `CLAUDE_CODE_ORGANIZATION_UUID` | 直接提供组织 UUID |

三者同时设置时，`populateOAuthAccountInfoIfNeeded()` 直接使用环境变量值初始化账号信息，避免网络调用和竞态条件。

## 边界 Case 与注意事项

- **令牌过期缓冲**：`isOAuthTokenExpired()` 使用 5 分钟缓冲（`src/services/oauth/client.ts:349`），距过期不足 5 分钟即视为过期
- **Scope 扩展**：`refreshOAuthToken()` 的后端允许在刷新时扩展 scope（超出初始授权范围），这是为了兼容在 scope 列表扩充之前发放的旧令牌
- **Profile 请求优化**：刷新令牌时如果全局配置和安全存储中已有完整信息，会跳过 Profile API 调用。但在 `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` 重登录路径下需特别处理——因为 `installOAuthTokens` 会先执行 `performLogout()` 清除安全存储，所以函数会传递缓存值而非返回 null，避免永久丢失订阅信息（`src/services/oauth/client.ts:192-208`）
- **pendingResponse 设计**：`AuthCodeListener` 收到授权码后不立即响应浏览器，而是保持 HTTP 连接，等到令牌交换成功/失败后再发送 302 重定向。这让用户在浏览器中看到的最终页面能反映真实的认证结果
- **自定义 OAuth URL 白名单**：`CLAUDE_CODE_CUSTOM_OAUTH_URL` 仅允许 FedStart/PubSec 域名，防止 OAuth 令牌泄露到任意端点
- **错误页面尚未就绪**：`handleErrorRedirect()` 当前重定向到成功页面 URL，代码中标注了 TODO 等待错误页面上线（`src/services/oauth/auth-code-listener.ts:115`）