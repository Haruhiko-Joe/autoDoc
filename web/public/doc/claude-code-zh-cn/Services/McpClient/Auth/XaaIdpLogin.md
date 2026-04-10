# XaaIdpLogin — 企业 IdP 的 OIDC 登录流程

## 概述与职责

`xaaIdpLogin.ts` 实现了企业身份提供商（IdP）的 OIDC 登录流程，是 XAA（跨应用访问）认证方案中的核心组件。它的核心价值主张是**「一次浏览器登录，N 个 MCP 服务器静默认证」**——用户只需在 IdP 完成一次交互式登录，获取的 `id_token` 会被缓存并复用于后续所有 MCP 服务器的无浏览器认证。

在系统架构中，该模块位于 `Services → McpClient → Auth` 层级下，与同级的 `auth.ts`（OAuth 2.0 流程）和 `xaa.ts`（RFC 8693 令牌交换）协作，共同构成 MCP 客户端的三层认证体系。`xaaIdpLogin.ts` 专注于获取 `id_token`，而 `xaa.ts` 负责将其作为 `subject_token` 进行令牌交换。

该模块通过环境变量 `CLAUDE_CODE_ENABLE_XAA` 控制启用状态（`src/services/mcp/xaaIdpLogin.ts:32-34`）。

## 关键流程

### 主流程：acquireIdpIdToken

`acquireIdpIdToken` 是整个模块的主入口函数（`src/services/mcp/xaaIdpLogin.ts:401-487`），采用**缓存优先**策略：

1. **检查缓存**：调用 `getCachedIdpIdToken()` 从 keychain 安全存储中查找该 issuer 的已缓存令牌。若令牌存在且未过期（含 60 秒缓冲），直接返回
2. **OIDC 发现**：调用 `discoverOidc()` 获取 IdP 的 OpenID Connect 配置（authorization_endpoint、token_endpoint 等）
3. **构建授权请求**：确定回调端口（固定端口或随机端口），生成 CSRF 防护用的 `state` 参数，组装 `OAuthClientInformation`（支持公开客户端和机密客户端两种模式）
4. **启动 PKCE 授权**：调用 MCP SDK 的 `startAuthorization()` 生成 `authorizationUrl` 和 `codeVerifier`
5. **启动本地回调服务器 → 打开浏览器**：先绑定本地 HTTP 服务器监听回调端口，确认端口可用后才打开浏览器。这避免了端口冲突时弹出无用的浏览器标签页
6. **等待授权码**：本地服务器在 `/callback` 路径等待 IdP 重定向，校验 `state` 参数后提取 `code`
7. **令牌交换**：调用 MCP SDK 的 `exchangeAuthorization()` 用授权码换取令牌，提取 `id_token`
8. **缓存令牌**：解析 JWT 的 `exp` 声明确定过期时间，将 `id_token` 存入 keychain 安全存储

### OIDC 发现流程

`discoverOidc` 函数（`src/services/mcp/xaaIdpLogin.ts:202-237`）正确处理了多种 IdP 的路径拼接问题：

```typescript
// 关键：使用尾部斜杠 + 相对路径拼接，而非绝对路径引用
const base = idpIssuer.endsWith('/') ? idpIssuer : idpIssuer + '/'
const url = new URL('.well-known/openid-configuration', base)
```

这解决了 `new URL('/.well-known/...', issuer)` 会丢弃 issuer 路径部分的问题——该 bug 会导致 Azure AD（`login.microsoftonline.com/{tenant}/v2.0`）、Okta 自定义授权服务器和 Keycloak Realm 的发现请求失败。

此外还包含以下安全检查：
- 30 秒请求超时（`IDP_REQUEST_TIMEOUT_MS`）
- 检测非 JSON 响应（应对强制门户或代理认证页面）
- 使用 Zod schema（`OpenIdProviderDiscoveryMetadataSchema`）验证响应结构
- **拒绝非 HTTPS 的 token_endpoint**（`src/services/mcp/xaaIdpLogin.ts:231-235`）

### 本地回调服务器

`waitForCallback` 函数（`src/services/mcp/xaaIdpLogin.ts:272-395`）实现了一个临时 HTTP 服务器来接收 IdP 的授权码回调：

- 监听 `127.0.0.1` 上指定端口的 `/callback` 路径
- 校验 `state` 参数防止 CSRF 攻击
- 处理 IdP 返回的 `error` / `error_description`（使用 `xss` 库转义 HTML 输出）
- 5 分钟登录超时（`IDP_LOGIN_TIMEOUT_MS`）
- 支持通过 `AbortSignal` 取消等待
- 端口冲突时给出平台特定的诊断命令（macOS: `lsof`，Windows: `netstat`）
- 使用 `server.unref()` 和 `timeoutId.unref()` 避免阻止 Node.js 进程退出
- `onListening` 回调在 socket 绑定成功后才触发，确保浏览器打开发生在端口可用之后

## 函数签名与参数说明

### `acquireIdpIdToken(opts: IdpLoginOptions): Promise<string>`

主入口。优先返回缓存的 `id_token`，否则启动完整的 OIDC 登录流程。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:401-487`

### `discoverOidc(idpIssuer: string): Promise<OpenIdProviderDiscoveryMetadata>`

执行 OIDC 发现，获取 IdP 的元数据配置。正确处理 Azure AD / Okta / Keycloak 的路径拼接。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:202-237`

### `getCachedIdpIdToken(idpIssuer: string): string | undefined`

从安全存储读取缓存的 `id_token`。如果令牌不存在或距过期不足 60 秒，返回 `undefined`。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:99-107`

### `saveIdpIdTokenFromJwt(idpIssuer: string, idToken: string): number`

将外部获取的 `id_token` 保存到缓存（用于一致性测试场景）。解析 JWT 的 `exp` 声明计算 TTL，无法解析时默认 1 小时。返回计算出的 `expiresAt` 时间戳。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:133-141`

### `clearIdpIdToken(idpIssuer: string): void`

清除指定 issuer 的缓存 `id_token`。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:143-150`

### `saveIdpClientSecret(idpIssuer: string, clientSecret: string): { success: boolean; warning?: string }`

保存 IdP 客户端密钥到安全存储（与 MCP 服务器的 AS 密钥分开存储，属于不同信任域）。返回操作结果，以便调用方处理 keychain 锁定等失败场景。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:159-172`

### `getIdpClientSecret(idpIssuer: string): string | undefined`

读取指定 issuer 的客户端密钥。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:177-181`

### `clearIdpClientSecret(idpIssuer: string): void`

清除指定 issuer 的客户端密钥。供 `claude mcp xaa clear` 命令使用。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:187-194`

### `issuerKey(issuer: string): string`

将 issuer URL 规范化为缓存键：去除尾部斜杠、小写化 host。确保配置中的 issuer 和 OIDC 发现返回的 issuer 命中同一缓存槽位。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:84-93`

### `isXaaEnabled(): boolean`

检查 `CLAUDE_CODE_ENABLE_XAA` 环境变量是否为真值。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:32-34`

### `getXaaIdpSettings(): XaaIdpSettings | undefined`

从应用设置中读取 `xaaIdp` 配置。由于该字段受环境变量门控，编译时类型中不包含它，这里是唯一的类型断言点。

> 源码位置：`src/services/mcp/xaaIdpLogin.ts:47-49`

## 接口/类型定义

### `XaaIdpSettings`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `issuer` | `string` | 是 | IdP 的 issuer URL |
| `clientId` | `string` | 是 | 在 IdP 注册的 OAuth 客户端 ID |
| `callbackPort` | `number` | 否 | 固定回调端口，省略时随机分配 |

### `IdpLoginOptions`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `idpIssuer` | `string` | 是 | IdP 的 issuer URL |
| `idpClientId` | `string` | 是 | OAuth 客户端 ID |
| `idpClientSecret` | `string` | 否 | 机密客户端的密钥。省略则使用纯 PKCE（公开客户端） |
| `callbackPort` | `number` | 否 | 固定回调端口。RFC 8252 §7.3 规定 IdP 应接受任意 localhost 端口，但很多 IdP 不遵守 |
| `onAuthorizationUrl` | `(url: string) => void` | 否 | 授权 URL 生成后的回调 |
| `skipBrowserOpen` | `boolean` | 否 | 为 `true` 时不自动打开浏览器 |
| `abortSignal` | `AbortSignal` | 否 | 用于取消登录等待 |

## 配置项与默认值

| 配置项 | 来源 | 说明 |
|--------|------|------|
| `CLAUDE_CODE_ENABLE_XAA` | 环境变量 | 启用 XAA 功能的总开关 |
| `settings.xaaIdp` | 应用设置 | IdP 的 issuer、clientId、callbackPort |
| `IDP_LOGIN_TIMEOUT_MS` | 硬编码常量 | 浏览器登录超时时间，5 分钟 |
| `IDP_REQUEST_TIMEOUT_MS` | 硬编码常量 | OIDC 发现和令牌交换的 HTTP 请求超时，30 秒 |
| `ID_TOKEN_EXPIRY_BUFFER_S` | 硬编码常量 | 缓存过期缓冲时间，60 秒（提前 60 秒视为过期） |

## 安全存储结构

令牌和客户端密钥分别存储在安全存储的不同命名空间中，避免信任域混淆：

- **id_token 缓存**：`mcpXaaIdp[issuerKey(issuer)]` → `{ idToken, expiresAt }`
- **客户端密钥**：`mcpXaaIdpConfig[issuerKey(issuer)]` → `{ clientSecret }`

## 边界 Case 与注意事项

- **JWT 不验签**：`jwtExp()` 仅解析 `exp` 声明用于缓存 TTL，不验证签名。设计理由是：`id_token` 最终会在 RFC 8693 令牌交换时由 IdP 自己验证，客户端验签不增加安全性（`src/services/mcp/xaaIdpLogin.ts:239-263`）
- **过期缓冲**：缓存令牌在距过期 60 秒时即视为失效，避免令牌在传输过程中过期
- **exp 回退策略**：优先使用 JWT 自身的 `exp`；不可用时回退到 `expires_in`（但注意这是 access_token 的生命周期，可能与 id_token 不同）；两者都没有时默认 1 小时
- **端口竞争**：浏览器仅在 `server.listen` 的回调中打开，确保端口绑定成功后才有用户交互
- **强制门户检测**：OIDC 发现时显式捕获非 JSON 响应，给出明确的诊断提示而非 `SyntaxError`
- **issuer 规范化**：`issuerKey()` 会小写化 host 并去除尾部斜杠，避免同一 IdP 因 URL 格式差异导致多次登录
- **OIDC 路径拼接**：使用 `new URL('.well-known/...', base + '/')` 而非 `new URL('/.well-known/...', base)`，后者会丢弃 issuer 的路径部分，导致多租户 IdP（Azure AD、Okta、Keycloak）发现失败