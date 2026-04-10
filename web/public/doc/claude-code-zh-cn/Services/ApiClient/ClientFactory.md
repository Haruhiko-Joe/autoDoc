# ClientFactory — 多云 SDK 客户端工厂

## 概述与职责

`ClientFactory` 是 Services → ApiClient 子系统中的客户端实例化模块，位于 `src/services/api/client.ts`。它的核心职责是：**根据当前配置的 API 提供商，创建并返回正确初始化的 Anthropic SDK 客户端实例**。

在 Services 层级中，它是 ApiClient 的底层基础设施——`claude.ts`（核心调用入口）依赖本模块获取可用的 SDK 客户端。同级的兄弟模块包括 McpClient（MCP 协议客户端）、Compact（上下文压缩）、Analytics（遥测）等。

本模块支持四种 API 提供商：
- **Anthropic 直连**（First-Party API）
- **AWS Bedrock**
- **GCP Vertex AI**
- **Azure Foundry**

每种提供商有独立的认证机制、区域路由策略和 SDK 初始化逻辑。

## 关键流程

### 客户端创建主流程（`getAnthropicClient`）

这是模块唯一的导出函数，也是整个客户端创建的入口。流程如下：

1. **构建默认请求头**：注入 `x-app`、`User-Agent`、会话 ID、容器 ID、远程会话 ID、客户端应用标识等元信息（`client.ts:104-116`）
2. **额外保护头**：若环境变量 `CLAUDE_CODE_ADDITIONAL_PROTECTION` 为真，注入 `x-anthropic-additional-protection` 头（`client.ts:124-129`）
3. **OAuth Token 刷新**：调用 `checkAndRefreshOAuthTokenIfNeeded()` 确保 OAuth 令牌有效（`client.ts:132-133`）
4. **API Key 配置**：非 Claude.ai 订阅用户走 `configureApiKeyHeaders` 注入 Authorization 头（`client.ts:135-137`）
5. **构建 fetch 包装器**：通过 `buildFetch` 注入客户端请求 ID 和调试日志（`client.ts:139`）
6. **组装通用参数 `ARGS`**：包含 headers、重试次数、超时时间、代理配置、fetch 函数（`client.ts:141-152`）
7. **按提供商分支创建客户端**：依次检查 Bedrock → Foundry → Vertex → 直连（`client.ts:153-316`）

### AWS Bedrock 分支

通过 `CLAUDE_CODE_USE_BEDROCK` 环境变量激活。认证优先级：

1. **Bearer Token 认证**：若设置了 `AWS_BEARER_TOKEN_BEDROCK`，跳过 SDK 内置认证，直接在请求头注入 Bearer Token（`client.ts:172-178`）
2. **STS 凭证认证**：调用 `refreshAndGetAwsCredentials()` 获取（可能是刷新后的）Access Key / Secret Key / Session Token（`client.ts:181-186`）
3. **跳过认证**：`CLAUDE_CODE_SKIP_BEDROCK_AUTH` 为真时跳过（测试/代理场景）

区域路由：对 Small Fast Model（Haiku），可通过 `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` 单独指定区域，其他模型使用 `getAWSRegion()` 返回的默认区域（`client.ts:156-160`）。

### Azure Foundry 分支

通过 `CLAUDE_CODE_USE_FOUNDRY` 环境变量激活。认证方式：

1. **API Key 认证**：SDK 自动读取 `ANTHROPIC_FOUNDRY_API_KEY`
2. **Azure AD 认证**：无 API Key 时，使用 `@azure/identity` 的 `DefaultAzureCredential` + `getBearerTokenProvider`，请求 scope 为 `https://cognitiveservices.azure.com/.default`（`client.ts:202-209`）
3. **跳过认证**：`CLAUDE_CODE_SKIP_FOUNDRY_AUTH` 为真时使用空 token provider

端点配置通过 `ANTHROPIC_FOUNDRY_RESOURCE`（资源名）或 `ANTHROPIC_FOUNDRY_BASE_URL`（完整 URL）指定。

### GCP Vertex AI 分支

通过 `CLAUDE_CODE_USE_VERTEX` 环境变量激活。流程：

1. **GCP 凭证刷新**：调用 `refreshGcpCredentialsIfNeeded()`（`client.ts:224-226`）
2. **GoogleAuth 实例化**：使用 `google-auth-library`，scope 为 `https://www.googleapis.com/auth/cloud-platform`（`client.ts:273-288`）
3. **Project ID 回退策略**：为避免 GCE 元数据服务器 12 秒超时，当用户未设置项目环境变量（`GCLOUD_PROJECT`、`GOOGLE_CLOUD_PROJECT` 等）且无 keyfile 时，使用 `ANTHROPIC_VERTEX_PROJECT_ID` 作为 fallback（`client.ts:253-288`）
4. **区域路由**：通过 `getVertexRegionForModel(model)` 按模型选择区域，支持模型级环境变量（如 `VERTEX_REGION_CLAUDE_3_5_HAIKU`）→ `CLOUD_ML_REGION` → 默认 `us-east5` 的优先级链

### Anthropic 直连分支

当以上三个云提供商均未激活时，走直连路径。认证方式：

- **Claude.ai 订阅用户**：使用 OAuth access token（`authToken` 字段），`apiKey` 设为 `null`（`client.ts:302-305`）
- **普通用户**：使用传入的 `apiKey` 或从 `getAnthropicApiKey()` 获取（`client.ts:302`）
- **Staging 环境**：当 `USER_TYPE=ant` 且 `USE_STAGING_OAUTH` 为真时，覆盖 `baseURL` 为 staging OAuth 配置的 API 地址（`client.ts:307-309`）

## 函数签名与参数说明

### `getAnthropicClient(options): Promise<Anthropic>`（导出）

主入口函数，异步创建并返回 Anthropic SDK 客户端实例。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `apiKey` | `string` | 否 | 直连模式下的 API Key，不传则从环境变量获取 |
| `maxRetries` | `number` | 是 | SDK 内置重试次数 |
| `model` | `string` | 否 | 目标模型名，影响 Bedrock/Vertex 的区域路由 |
| `fetchOverride` | `ClientOptions['fetch']` | 否 | 自定义 fetch 函数，用于测试或拦截 |
| `source` | `string` | 否 | 调用来源标识，用于调试日志 |

> 源码位置：`src/services/api/client.ts:88-316`

### `configureApiKeyHeaders(headers, isNonInteractiveSession): Promise<void>`（内部）

为非 Claude.ai 订阅用户注入 Authorization 头。优先使用 `ANTHROPIC_AUTH_TOKEN` 环境变量，其次调用 `getApiKeyFromApiKeyHelper`。

> 源码位置：`src/services/api/client.ts:318-328`

### `getCustomHeaders(): Record<string, string>`（内部）

解析 `ANTHROPIC_CUSTOM_HEADERS` 环境变量（支持多行，`Name: Value` 格式），返回自定义请求头字典。

> 源码位置：`src/services/api/client.ts:330-354`

### `buildFetch(fetchOverride, source): ClientOptions['fetch']`（内部）

包装 fetch 函数，为第一方 API 请求自动注入 `x-client-request-id`（UUID）并记录调试日志。第三方提供商（Bedrock/Vertex/Foundry）不注入该头，以避免严格代理拒绝未知头。

> 源码位置：`src/services/api/client.ts:358-389`

### `createStderrLogger(): ClientOptions['logger']`（内部）

创建将 SDK 日志输出到 stderr 的 logger，仅在 `isDebugToStdErr()` 为真时启用。

> 源码位置：`src/services/api/client.ts:73-86`

## 配置项与环境变量

### 提供商选择

| 环境变量 | 说明 |
|----------|------|
| `CLAUDE_CODE_USE_BEDROCK` | 启用 AWS Bedrock 提供商 |
| `CLAUDE_CODE_USE_VERTEX` | 启用 GCP Vertex AI 提供商 |
| `CLAUDE_CODE_USE_FOUNDRY` | 启用 Azure Foundry 提供商 |

### AWS Bedrock 相关

| 环境变量 | 说明 |
|----------|------|
| `AWS_REGION` / `AWS_DEFAULT_REGION` | AWS 区域（默认 `us-east-1`） |
| `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` | Small Fast Model 的专用区域覆盖 |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock Bearer Token（优先于 STS 凭证） |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH` | 跳过 Bedrock 认证（测试用） |

### GCP Vertex AI 相关

| 环境变量 | 说明 |
|----------|------|
| `ANTHROPIC_VERTEX_PROJECT_ID` | GCP 项目 ID（必填） |
| `CLOUD_ML_REGION` | 默认 GCP 区域 |
| `VERTEX_REGION_CLAUDE_3_5_HAIKU` 等 | 模型级区域覆盖 |
| `GOOGLE_APPLICATION_CREDENTIALS` | GCP 服务账号凭证文件路径 |
| `GCLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT` | GCP 项目 ID（优先于 `ANTHROPIC_VERTEX_PROJECT_ID`） |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH` | 跳过 Vertex 认证（测试用） |

### Azure Foundry 相关

| 环境变量 | 说明 |
|----------|------|
| `ANTHROPIC_FOUNDRY_RESOURCE` | Azure 资源名 |
| `ANTHROPIC_FOUNDRY_BASE_URL` | 完整 Base URL（替代 resource） |
| `ANTHROPIC_FOUNDRY_API_KEY` | Foundry API Key（不设则走 Azure AD） |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` | 跳过 Foundry 认证（测试用） |

### 通用配置

| 环境变量 | 说明 |
|----------|------|
| `API_TIMEOUT_MS` | API 请求超时（毫秒），默认 600000（10 分钟） |
| `ANTHROPIC_API_KEY` | 直连模式 API Key |
| `ANTHROPIC_AUTH_TOKEN` | 外部认证 Token（优先于 API Key Helper） |
| `ANTHROPIC_CUSTOM_HEADERS` | 自定义请求头（多行，`Name: Value` 格式） |
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | 启用额外保护头 |
| `CLAUDE_CODE_CONTAINER_ID` | 容器 ID（注入请求头） |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | 远程会话 ID（注入请求头） |
| `CLAUDE_AGENT_SDK_CLIENT_APP` | SDK 客户端应用标识 |

## 边界 Case 与注意事项

- **类型断言**：Bedrock、Vertex、Foundry 返回的客户端通过 `as unknown as Anthropic` 强制转换。这些客户端不支持 batching 和 models API，代码中有注释标注此为"一直以来的谎言"（`client.ts:189, 219, 297`）
- **GoogleAuth 未缓存**：每次调用 `getAnthropicClient()` 都会创建新的 `GoogleAuth` 实例，可能导致重复认证流程。代码中有 TODO 标注此性能问题（`client.ts:232-239`）
- **Vertex Project ID 回退风险**：当认证项目与 API 目标项目不同时，使用 `ANTHROPIC_VERTEX_PROJECT_ID` 作为 fallback 可能导致计费/审计问题（`client.ts:281-282`）
- **第一方 API 专属的 `x-client-request-id`**：仅在直连 Anthropic API 时注入，第三方提供商跳过，以避免严格代理拒绝未知 header（`client.ts:364-367`）
- **提供商检测顺序**：Bedrock → Foundry → Vertex → 直连，如果同时设置多个 `CLAUDE_CODE_USE_*` 环境变量，仅第一个匹配的生效
- **自定义 header 解析**：`getCustomHeaders` 仅按第一个冒号分割，value 中可包含冒号；空行和无冒号行被静默跳过