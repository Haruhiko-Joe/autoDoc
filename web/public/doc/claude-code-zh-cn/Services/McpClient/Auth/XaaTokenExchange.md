# 跨应用访问令牌交换（XaaTokenExchange）

## 概述与职责

XaaTokenExchange 模块实现了企业级跨应用访问（XAA / SEP-990）的令牌交换流程，使 MCP 客户端能够**无需浏览器弹窗**即可静默获取 access_token。它位于 **Services → McpClient → Auth** 子系统中，与同级的 `auth.ts`（标准 OAuth 2.0 PKCE 流程）和 `xaaIdpLogin.ts`（企业 IdP OIDC 登录）共同构成 MCP 认证三件套。

核心思路是将用户已有的 OIDC `id_token` 通过两次令牌交换转换为目标 MCP 服务器可接受的 `access_token`：

```
id_token → [RFC 8693 Token Exchange] → ID-JAG → [RFC 7523 JWT Bearer] → access_token
```

模块由**四个 Layer-2 操作**和**一个 Layer-3 编排器**组成，设计上与 MCP TS SDK PR #1593 的 Layer-2 接口形状对齐，以便未来可机械性地迁移到 SDK 内置实现。

## 关键流程

### 完整 XAA 流程 Walkthrough

编排器 `performCrossAppAccess` 串联四个步骤，完成从 MCP 服务器 URL 到 access_token 的完整链路：

1. **PRM 发现**（`discoverProtectedResource`）：对目标 MCP 服务器执行 RFC 9728 Protected Resource Metadata 发现，获取其声明的 `resource` 标识符和关联的授权服务器列表 `authorization_servers`。同时验证返回的 `resource` 与请求的 `serverUrl` 一致（RFC 9728 §3.3 mix-up 防护）。

2. **AS 元数据发现**（`discoverAuthorizationServer`）：遍历 PRM 返回的授权服务器列表，对每个 AS 执行 RFC 8414 元数据发现（含 OIDC 回退）。验证 `issuer` 一致性、强制 HTTPS token endpoint、检查是否支持 `jwt-bearer` grant type。选中第一个合格的 AS。

3. **令牌交换**（`requestJwtAuthorizationGrant`）：向 IdP 的 token endpoint 发送 RFC 8693 Token Exchange 请求，将 `id_token`（subject_token）交换为 ID-JAG（Identity Assertion Authorization Grant）。请求参数中指定 `audience` 为 AS issuer、`resource` 为 PRM 返回的资源标识符。

4. **JWT Bearer 授权**（`exchangeJwtAuthGrant`）：向 AS 的 token endpoint 发送 RFC 7523 JWT Bearer Grant 请求，以 ID-JAG 作为 `assertion`，最终获取 `access_token`。

```
MCP Server URL
      │
      ▼
discoverProtectedResource ──→ { resource, authorization_servers[] }
      │
      ▼
discoverAuthorizationServer ──→ { issuer, token_endpoint, auth_methods }
      │
      ▼
requestJwtAuthorizationGrant ──→ ID-JAG (id_token → IdP token exchange)
      │
      ▼
exchangeJwtAuthGrant ──→ access_token (ID-JAG → AS jwt-bearer grant)
```

### 认证方式选择逻辑

编排器会根据 AS 元数据中的 `token_endpoint_auth_methods_supported` 自动选择客户端认证方式（`src/services/mcp/xaa.ts:475-481`）：

- 默认使用 `client_secret_basic`（Base64 编码的 Authorization 头），这是 SEP-990 合规测试的要求
- 仅当 AS 明确不支持 `client_secret_basic` 但支持 `client_secret_post` 时，才切换为 POST body 传参

### 错误处理与缓存决策

`XaaTokenExchangeError` 通过 `shouldClearIdToken` 字段指导调用方是否应清除缓存的 `id_token`（`src/services/mcp/xaa.ts:77-84`）：

| 场景 | shouldClearIdToken | 原因 |
|------|--------------------|------|
| HTTP 4xx / `invalid_grant` / `invalid_token` | `true` | id_token 已失效或被拒绝 |
| HTTP 5xx | `false` | IdP 宕机，id_token 可能仍有效 |
| 200 但响应体结构无效 | `true` | 协议违规，状态不可信 |
| 非 JSON 响应（如验证码门户） | `false` | 网络层瞬时问题 |

## 函数签名与参数说明

### `discoverProtectedResource(serverUrl, opts?): Promise<ProtectedResourceMetadata>`

RFC 9728 PRM 发现，验证资源标识符匹配。

- **serverUrl**：MCP 服务器 URL
- **opts.fetchFn**：可选的自定义 fetch 函数
- **返回**：`{ resource: string, authorization_servers: string[] }`
- **抛出**：发现失败或资源标识符不匹配时抛出 `Error`

> 源码位置：`src/services/mcp/xaa.ts:135-165`

### `discoverAuthorizationServer(asUrl, opts?): Promise<AuthorizationServerMetadata>`

RFC 8414 AS 元数据发现，强制 HTTPS。

- **asUrl**：授权服务器 URL
- **opts.fetchFn**：可选的自定义 fetch 函数
- **返回**：`{ issuer, token_endpoint, grant_types_supported?, token_endpoint_auth_methods_supported? }`
- **抛出**：发现失败、issuer 不匹配、或 token endpoint 非 HTTPS 时抛出 `Error`

> 源码位置：`src/services/mcp/xaa.ts:178-210`

### `requestJwtAuthorizationGrant(opts): Promise<JwtAuthGrantResult>`

RFC 8693 令牌交换：id_token → ID-JAG。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| tokenEndpoint | string | 是 | IdP 的 token endpoint |
| audience | string | 是 | 目标 AS 的 issuer URL |
| resource | string | 是 | PRM 返回的资源标识符 |
| idToken | string | 是 | 用户的 OIDC id_token |
| clientId | string | 是 | IdP 注册的客户端 ID |
| clientSecret | string | 否 | IdP 客户端密钥（client_secret_post 方式） |
| scope | string | 否 | 请求的 scope |
| fetchFn | FetchLike | 否 | 自定义 fetch |

- **返回**：`{ jwtAuthGrant: string, expiresIn?: number, scope?: string }`
- **抛出**：`XaaTokenExchangeError`，携带 `shouldClearIdToken` 缓存决策

> 源码位置：`src/services/mcp/xaa.ts:233-310`

### `exchangeJwtAuthGrant(opts): Promise<XaaTokenResult>`

RFC 7523 JWT Bearer 授权：ID-JAG → access_token。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| tokenEndpoint | string | 是 | AS 的 token endpoint |
| assertion | string | 是 | ID-JAG 令牌 |
| clientId | string | 是 | AS 注册的客户端 ID |
| clientSecret | string | 是 | AS 客户端密钥 |
| authMethod | `'client_secret_basic'` \| `'client_secret_post'` | 否 | 认证方式，默认 `client_secret_basic` |
| scope | string | 否 | 请求的 scope |
| fetchFn | FetchLike | 否 | 自定义 fetch |

- **返回**：`{ access_token, token_type, expires_in?, scope?, refresh_token? }`

> 源码位置：`src/services/mcp/xaa.ts:337-394`

### `performCrossAppAccess(serverUrl, config, serverName?, abortSignal?): Promise<XaaResult>`

Layer-3 编排器，串联四个步骤完成完整 XAA 流程。

- **serverUrl**：MCP 服务器 URL
- **config**：`XaaConfig` 类型，包含 IdP 和 AS 的凭据配置
- **serverName**：调试日志标识，默认 `'xaa'`
- **abortSignal**：可选的取消信号（如用户按 Esc）
- **返回**：`XaaResult`（access_token + authorizationServerUrl）

> 源码位置：`src/services/mcp/xaa.ts:426-511`

## 接口/类型定义

### `XaaConfig`

编排器所需的完整凭据配置，结构与 SEP-990 合规测试的 `ClientConformanceContextSchema` 对齐：

| 字段 | 类型 | 说明 |
|------|------|------|
| clientId | string | 在 MCP 服务器 AS 注册的客户端 ID |
| clientSecret | string | AS 客户端密钥 |
| idpClientId | string | 在 IdP 注册的客户端 ID |
| idpClientSecret | string? | IdP 客户端密钥（部分 IdP 要求） |
| idpIdToken | string | 用户的 OIDC id_token |
| idpTokenEndpoint | string | IdP token endpoint URL |

> 源码位置：`src/services/mcp/xaa.ts:402-415`

### `XaaResult`

最终返回类型，在 `XaaTokenResult` 基础上附加 `authorizationServerUrl`。调用方必须持久化此 URL，供后续令牌刷新（`auth.ts _doRefresh`）和令牌撤销（`revokeServerTokens`）使用——因为 MCP 服务器 URL 并不等于 AS URL。

> 源码位置：`src/services/mcp/xaa.ts:320-328`

## 配置项与默认值

- **`XAA_REQUEST_TIMEOUT_MS`**：所有 XAA HTTP 请求的超时时间，硬编码为 **30 秒**（`src/services/mcp/xaa.ts:29`）
- **默认认证方式**：`client_secret_basic`（JWT Bearer 阶段），仅在 AS 明确要求时回退为 `client_secret_post`
- **AS 选择策略**：遍历 PRM 返回的 `authorization_servers` 列表，选取第一个发现成功且支持 `jwt-bearer` grant 的 AS

## 边界 Case 与注意事项

- **敏感信息脱敏**：所有错误日志通过 `redactTokens()` 正则替换，确保 `access_token`、`id_token`、`client_secret` 等字段不会泄露到调试日志中（`src/services/mcp/xaa.ts:91-97`）
- **PHP IdP 兼容**：`TokenExchangeResponseSchema` 中 `expires_in` 使用 `z.coerce.number()` 而非 `z.number()`，兼容将该字段返回为字符串的 PHP 后端 IdP（`src/services/mcp/xaa.ts:107`）
- **token_type 容错**：`JwtBearerResponseSchema` 中 `token_type` 默认为 `'Bearer'`，因为许多 AS 会省略此字段（`src/services/mcp/xaa.ts:117`）
- **grant_types_supported 可选**：RFC 8414 §2 规定该字段可选。编排器仅在 AS 明确声明了该列表且不包含 `jwt-bearer` 时才跳过，未声明时交给 token endpoint 自行决定（`src/services/mcp/xaa.ts:441-463`）
- **URL 规范化**：`normalizeUrl()` 使用 `new URL()` 进行 RFC 3986 §6.2.2 语法规范化（小写 scheme/host、去除默认端口、去除尾部斜杠），用于 PRM resource 和 AS issuer 的一致性校验（`src/services/mcp/xaa.ts:61-67`）
- **AbortSignal 组合**：`makeXaaFetch()` 使用 `AbortSignal.any()` 将超时信号和调用方取消信号组合，确保用户取消操作（如在认证菜单按 Esc）能立即中止正在进行的 HTTP 请求（`src/services/mcp/xaa.ts:42-52`）
- **HTTPS 强制**：`discoverAuthorizationServer` 会拒绝非 HTTPS 的 token endpoint，防止通过明文 HTTP 传输 id_token 和 client_secret（`src/services/mcp/xaa.ts:198-202`）