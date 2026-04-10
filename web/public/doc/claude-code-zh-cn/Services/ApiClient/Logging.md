# API 调用日志与遥测（Logging）

## 概述与职责

`logging.ts` 是 ApiClient 子系统中的日志与遥测模块，负责记录每一次 Claude API 请求的完整生命周期指标。它在 Services → ApiClient 层级中扮演**可观测性核心**角色，与同级的 `claude.ts`（API 调用入口）和 `client.ts`（多云客户端实例化）协作，将每次请求的性能、用量、错误和环境信息上报到两个遥测通道：

1. **内部分析系统**：通过 `logEvent()` 发送结构化事件（事件名以 `tengu_` 为前缀）
2. **OpenTelemetry（OTLP）**：通过 `logOTelEvent()` 和 `endLLMRequestSpan()` 发送标准化追踪数据

该模块还实现了 **AI 网关指纹识别**——通过响应头和 URL 特征检测请求是否经过 LiteLLM、Helicone、Portkey 等代理网关。

## 关键流程

### 1. API 请求发起日志（logAPIQuery）

当 `claude.ts` 准备发送 API 请求时，调用 `logAPIQuery()` 记录请求前的上下文：

1. 收集模型名称、消息数量、温度、beta 特性列表、权限模式等请求参数
2. 通过 `getAPIProviderForStatsig()` 获取当前 API 提供商标识
3. 计算构建版本年龄（`getBuildAgeMinutes()`），用于追踪客户端版本分布
4. 附加环境变量元数据（`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 等）
5. 发送 `tengu_api_query` 事件

> 源码位置：`src/services/api/logging.ts:171-233`

### 2. API 成功响应日志（logAPISuccessAndDuration）

这是最核心的日志函数，由 `claude.ts` 在收到完整响应后调用。流程如下：

1. **网关检测**：调用 `detectGateway()` 从响应头/URL 识别 AI 网关（`src/services/api/logging.ts:641-644`）
2. **响应内容分析**：遍历 `newMessages` 中的所有内容块，统计：
   - `textContentLength`：文本输出字符数
   - `thinkingContentLength`：思维链输出字符数
   - `toolUseContentLengths`：按工具名分组的工具调用 input 大小（工具名经 `sanitizeToolNameForAnalytics` 脱敏）
   - `connectorTextBlockCount`：连接器文本块数量（feature flag 控制）
3. **计算耗时**：`durationMs`（本次请求耗时）和 `durationMsIncludingRetries`（含重试总耗时），并累加到全局状态
4. **发送 `tengu_api_success` 事件**：包含完整的 Token 用量（输入/输出/缓存读取/缓存创建）、费用、TTFT、停止原因、全局缓存策略等 30+ 个字段
5. **发送 OTLP 事件**：`api_request` 事件，包含模型、Token 数、费用、耗时等核心指标
6. **Beta 追踪**：当 `isBetaTracingEnabled()` 时，提取模型文本输出和思维链内容，用于 Perfetto 追踪可视化
7. **结束 LLM Span**：调用 `endLLMRequestSpan()` 关闭追踪 span，传入 Token 用量和重试时间线
8. **Teleported 会话追踪**：如果是远程传送的会话，记录首次成功消息事件（`tengu_teleport_first_message_success`）

> 源码位置：`src/services/api/logging.ts:581-788`

### 3. API 错误日志（logAPIError）

API 调用失败时的日志记录：

1. **网关检测**：优先从 `APIError.headers` 获取响应头，降级使用传入的 headers 参数
2. **错误分类**：通过 `classifyAPIError()` 获取错误类型，通过 `extractConnectionErrorDetails()` 提取连接错误详情（如 SSL 错误）
3. **调试日志**：将连接错误详情和 `x-client-request-id` 写入 debug 日志，方便 API 团队查询服务端日志
4. **发送 `tengu_api_error` 事件**：包含错误信息、HTTP 状态码、错误类型、重试次数、网关信息等
5. **发送 OTLP 错误事件**：`api_error` 事件
6. **结束 LLM Span**：标记为失败
7. **Teleported 会话追踪**：记录首次错误事件

> 源码位置：`src/services/api/logging.ts:235-396`

## 函数签名与参数说明

### `logAPIQuery(params): void`（导出）

记录 API 请求发起。

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | `string` | 模型标识符 |
| `messagesLength` | `number` | 消息数组长度 |
| `temperature` | `number` | 采样温度 |
| `betas` | `string[]` | 启用的 beta 特性列表 |
| `permissionMode` | `PermissionMode` | 权限模式 |
| `querySource` | `string` | 查询来源标识 |
| `queryTracking` | `QueryChainTracking` | 查询链追踪（chainId + depth） |
| `thinkingType` | `'adaptive' \| 'enabled' \| 'disabled'` | 思维链模式 |
| `effortValue` | `EffortLevel \| null` | 推理努力级别 |
| `fastMode` | `boolean` | 是否快速模式 |
| `previousRequestId` | `string \| null` | 上一次请求的 ID |

### `logAPIError(params): void`（导出）

记录 API 请求错误。

| 参数 | 类型 | 说明 |
|------|------|------|
| `error` | `unknown` | 原始错误对象 |
| `model` | `string` | 模型标识符 |
| `durationMs` | `number` | 请求耗时（毫秒） |
| `durationMsIncludingRetries` | `number` | 含重试的总耗时 |
| `attempt` | `number` | 当前重试次数 |
| `requestId` | `string \| null` | 服务端请求 ID |
| `clientRequestId` | `string` | 客户端生成的请求 ID（用于超时场景的服务端日志查找） |
| `llmSpan` | `Span` | 追踪 span 引用 |
| `headers` | `Headers` | 响应头（降级使用） |

### `logAPISuccessAndDuration(params): void`（导出）

记录 API 成功响应，是信息最丰富的日志函数。

| 参数 | 类型 | 说明 |
|------|------|------|
| `model` | `string` | 最终使用的模型 |
| `preNormalizedModel` | `string` | 归一化前的模型名（用于检测模型别名） |
| `start` | `number` | 本次尝试开始时间戳 |
| `startIncludingRetries` | `number` | 含重试的起始时间戳 |
| `ttftMs` | `number \| null` | Time to First Token（毫秒） |
| `usage` | `NonNullableUsage` | Token 用量（input/output/cache_read/cache_creation） |
| `costUSD` | `number` | 本次请求费用（美元） |
| `stopReason` | `BetaStopReason \| null` | 停止原因（end_turn/max_tokens/tool_use 等） |
| `newMessages` | `AssistantMessage[]` | 响应消息——用于提取内容长度和追踪数据 |
| `globalCacheStrategy` | `GlobalCacheStrategy` | 全局缓存策略：`'tool_based'` / `'system_prompt'` / `'none'` |
| `requestSetupMs` | `number` | 请求前准备耗时 |
| `attemptStartTimes` | `number[]` | 各重试尝试的开始时间——用于 Perfetto 重试子 span |

## 接口/类型定义

### `GlobalCacheStrategy`

```typescript
type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'
```

全局 Prompt 缓存策略。`tool_based` 表示通过工具定义实现缓存，`system_prompt` 通过系统提示词缓存，`none` 表示未启用。

### `KnownGateway`

```typescript
type KnownGateway =
  | 'litellm' | 'helicone' | 'portkey'
  | 'cloudflare-ai-gateway' | 'kong'
  | 'braintrust' | 'databricks'
```

已知的 7 种 AI 网关类型。前 6 种通过响应头前缀匹配，`databricks` 通过域名后缀匹配。

> 源码位置：`src/services/api/logging.ts:56-63`

## AI 网关指纹识别

`detectGateway()` 函数通过两种策略检测请求是否经过 AI 代理网关：

**策略一：响应头前缀匹配**（`src/services/api/logging.ts:66-93`）

| 网关 | 响应头前缀 |
|------|-----------|
| LiteLLM | `x-litellm-` |
| Helicone | `helicone-` |
| Portkey | `x-portkey-` |
| Cloudflare AI Gateway | `cf-aig-` |
| Kong | `x-kong-` |
| Braintrust | `x-bt-` |

**策略二：域名后缀匹配**（`src/services/api/logging.ts:98-105`）

| 网关 | 域名后缀 |
|------|---------|
| Databricks | `.cloud.databricks.com`、`.azuredatabricks.net`、`.gcp.databricks.com` |

检测到的网关标识会附加到 `tengu_api_success` 和 `tengu_api_error` 事件中，用于分析用户的 API 接入拓扑。

## 环境变量与配置

通过 `getAnthropicEnvMetadata()` 采集的环境变量（`src/services/api/logging.ts:141-162`）：

| 环境变量 | 事件字段 | 说明 |
|---------|---------|------|
| `ANTHROPIC_BASE_URL` | `baseUrl` | 自定义 API 端点（网关检测依据之一） |
| `ANTHROPIC_MODEL` | `envModel` | 用户覆盖的默认模型 |
| `ANTHROPIC_SMALL_FAST_MODEL` | `envSmallFastModel` | 用户覆盖的快速模型 |

其他影响日志行为的变量：
- `USER_TYPE`：值为 `'ant'` 时，beta 追踪中会记录思维链输出
- `MACRO.BUILD_TIME`：编译时注入的构建时间，用于计算 `buildAgeMins`

## 边界 Case 与注意事项

- **缓存删除 Token**：`cache_deleted_input_tokens` 字段受 `CACHED_MICROCOMPACT` feature flag 控制，仅在缓存编辑功能启用且值 > 0 时记录（`src/services/api/logging.ts:558-566`）
- **连接器文本块**：`connectorTextBlockCount` 受 `CONNECTOR_TEXT` feature flag 控制
- **Teleported 会话**：远程传送的会话只记录首次成功/失败消息，通过 `markFirstTeleportMessageLogged()` 防止重复
- **模型归一化追踪**：仅当 `preNormalizedModel !== model` 时才记录 `preNormalizedModel` 字段，用于追踪模型别名映射
- **`timeSinceLastApiCallMs`**：记录两次 API 调用之间的间隔，用于分析用户交互节奏。首次调用时为 `undefined`
- **`clientRequestId`**：客户端生成的请求 ID，在超时场景下比 `requestId`（服务端返回）更可靠，可用于服务端日志回溯
- **工具名脱敏**：通过 `sanitizeToolNameForAnalytics()` 处理工具名，防止敏感信息泄露到分析系统