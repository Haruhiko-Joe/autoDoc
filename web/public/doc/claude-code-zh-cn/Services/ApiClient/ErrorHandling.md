# ErrorHandling — API 错误分类与格式化

## 概述与职责

ErrorHandling 模块是 Claude Code **API 通信层（ApiClient）** 的错误处理核心，由两个文件组成：

- **`errors.ts`**（~1200 行）：将 Anthropic SDK 抛出的原始 `APIError` 映射为用户友好的错误消息，覆盖认证失败、速率限制、模型过载、prompt 过长、内容审核、权限不足等数十种错误场景。同时集成订阅状态（claude.ai subscriber）和提供商信息（Bedrock / Vertex / First-party）生成针对性提示。
- **`errorUtils.ts`**（~260 行）：解析底层连接错误的 cause 链（SSL/TLS、DNS、超时等），提供格式化后的连接错误消息和 HTML 净化功能。

在整体架构中，该模块位于 **Services → ApiClient** 层级。当 `claude.ts`（核心 API 调用入口）捕获到异常时，会调用本模块将原始错误转换为 `AssistantMessage`，最终渲染到终端 UI 或通过 SDK 返回给调用方。同级模块包括 McpClient、Compact、Analytics 等服务。

## 关键流程

### 1. API 错误到用户消息的转换（主流程）

入口函数 `getAssistantMessageFromError()` 是整个模块的核心。它接收一个 `unknown` 类型的错误对象，按优先级逐一匹配错误类型，返回一个 `AssistantMessage`：

1. **SDK 超时错误**：检测 `APIConnectionTimeoutError` 或包含 "timeout" 的 `APIConnectionError`（`errors.ts:433-443`）
2. **图片尺寸/resize 错误**：在 API 调用前的验证阶段抛出，区分交互式和非交互式模式给出不同提示（`errors.ts:448-452`）
3. **Opus 容量紧急开关**：当 Opus 高负载时引导用户切换到 Sonnet（`errors.ts:455-463`）
4. **429 速率限制**：最复杂的分支——
   - 若响应头包含 `anthropic-ratelimit-unified-*` 系列头部，解析限额类型（`five_hour` / `seven_day` / `seven_day_opus`）、超额状态、重置时间等，委托 `getRateLimitErrorMessage()` 生成消息（`errors.ts:469-535`）
   - 若包含 "Extra usage is required for long context"，提示启用 Extra Usage（`errors.ts:540-548`）
   - 无配额头的 429，提取内层 JSON 消息展示（`errors.ts:549-557`）
5. **Prompt 过长**：匹配 "prompt is too long"（大小写不敏感，兼容 Vertex），将原始 token 数保存到 `errorDetails` 供 reactive compact 使用（`errors.ts:562-574`）
6. **PDF 错误**：页数超限、密码保护、格式无效分别给出不同提示（`errors.ts:577-610`）
7. **图片尺寸超限 / 多图维度超限**：400 错误中匹配特定子串（`errors.ts:613-639`）
8. **AFK 模式不可用**：beta header 被服务器拒绝（`errors.ts:644-655`）
9. **请求体过大（413）**：通常是大 PDF + 上下文超过 32MB 限制（`errors.ts:659-664`）
10. **tool_use / tool_result 不匹配（400）**：记录诊断日志，引导用户 `/rewind` 恢复（`errors.ts:667-733`）
11. **无效模型名称**：区分订阅用户（提示 Pro 计划不含 Opus）和内部员工（提示 org 未被 gate）（`errors.ts:736-770`）
12. **余额不足 / 组织已禁用**：检测 API Key 来源，区分是环境变量覆盖还是真正的组织禁用（`errors.ts:772-811`）
13. **认证失败（401/403）**：API Key 无效、OAuth Token 已撤销、组织不允许 OAuth，CCR 模式下提示重试而非重新登录（`errors.ts:813-883`）
14. **Bedrock 模型访问拒绝 / 404 模型不存在**：为第三方用户推荐降级模型（`errors.ts:887-914`）
15. **连接错误（非超时）**：委托 `formatAPIError()` 生成详细消息（`errors.ts:917-922`）
16. **兜底**：通用 Error 直接取 message，其他返回默认前缀（`errors.ts:924-933`）

### 2. 连接错误 cause 链解析

`extractConnectionErrorDetails()`（`errorUtils.ts:42-83`）递归遍历错误对象的 `.cause` 属性（最多 5 层），查找包含 `code` 属性的 `Error` 实例，并判断该 code 是否属于预定义的 29 个 SSL 错误码集合。

`formatAPIError()`（`errorUtils.ts:200-260`）基于解析结果生成消息：
- `ETIMEDOUT` → "Check your internet connection and proxy settings"
- SSL 错误 → 按证书类型（过期、自签名、主机名不匹配等）给出具体提示
- 通用连接错误 → 附带错误码
- 反序列化错误（从 JSONL 恢复的会话）→ 尝试从嵌套结构提取消息

### 3. 错误分类（用于分析追踪）

`classifyAPIError()`（`errors.ts:965-1161`）将错误映射为标准化的字符串标签（如 `'rate_limit'`、`'ssl_cert_error'`、`'prompt_too_long'`），用于 Datadog 等分析系统的标签化追踪。分类逻辑与 `getAssistantMessageFromError()` 的匹配顺序保持一致。

## 函数签名与参数说明

### errors.ts 导出函数

#### `getAssistantMessageFromError(error: unknown, model: string, options?): AssistantMessage`

将任意错误转换为可展示的 `AssistantMessage`。这是调用方最常使用的入口。

| 参数 | 类型 | 说明 |
|------|------|------|
| `error` | `unknown` | SDK 抛出的原始错误 |
| `model` | `string` | 当前使用的模型 ID，用于生成针对性建议 |
| `options.messages` | `Message[]` | 原始消息列表，用于 tool_use 不匹配时的诊断日志 |
| `options.messagesForAPI` | `(UserMessage \| AssistantMessage)[]` | 规范化后的 API 消息，同上 |

> 源码位置：`src/services/api/errors.ts:425-933`

#### `classifyAPIError(error: unknown): string`

将错误分类为标准化标签字符串，返回值包括：`'aborted'`、`'api_timeout'`、`'repeated_529'`、`'rate_limit'`、`'server_overload'`、`'prompt_too_long'`、`'pdf_too_large'`、`'image_too_large'`、`'tool_use_mismatch'`、`'invalid_model'`、`'credit_balance_low'`、`'invalid_api_key'`、`'token_revoked'`、`'auth_error'`、`'bedrock_model_access'`、`'ssl_cert_error'`、`'connection_error'`、`'server_error'`、`'client_error'`、`'unknown'` 等。

> 源码位置：`src/services/api/errors.ts:965-1161`

#### `categorizeRetryableAPIError(error: APIError): SDKAssistantMessageError`

将 `APIError` 分为可重试的几个大类：`'rate_limit'`（429/529）、`'authentication_failed'`（401/403）、`'server_error'`（≥408）、`'unknown'`。

> 源码位置：`src/services/api/errors.ts:1163-1182`

#### `getErrorMessageIfRefusal(stopReason, model): AssistantMessage | undefined`

当 API 返回 `stopReason === 'refusal'` 时生成内容审核拒绝消息，包含 Usage Policy 链接和模型切换建议。

> 源码位置：`src/services/api/errors.ts:1184-1207`

#### Prompt 过长相关

- `isPromptTooLongMessage(msg: AssistantMessage): boolean` — 判断消息是否为 prompt 过长错误（`errors.ts:64-77`）
- `parsePromptTooLongTokenCounts(rawMessage: string): { actualTokens, limitTokens }` — 从原始错误消息中提取实际/限制 token 数（`errors.ts:85-96`）
- `getPromptTooLongTokenGap(msg: AssistantMessage): number | undefined` — 计算超出限制的 token 差值，供 reactive compact 跳过多个消息组（`errors.ts:104-118`）

#### 媒体错误相关

- `isMediaSizeError(raw: string): boolean` — 判断原始错误文本是否为媒体尺寸拒绝（`errors.ts:133-139`）
- `isMediaSizeErrorMessage(msg: AssistantMessage): boolean` — 消息级别的媒体错误判定（`errors.ts:147-153`）

#### 各类错误消息常量与生成函数

| 常量 / 函数 | 说明 |
|-------------|------|
| `API_ERROR_MESSAGE_PREFIX` | `'API Error'`，所有错误消息的统一前缀 |
| `PROMPT_TOO_LONG_ERROR_MESSAGE` | `'Prompt is too long'` |
| `CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE` | `'Credit balance is too low'` |
| `INVALID_API_KEY_ERROR_MESSAGE` | `'Not logged in · Please run /login'` |
| `REPEATED_529_ERROR_MESSAGE` | `'Repeated 529 Overloaded errors'` |
| `CUSTOM_OFF_SWITCH_MESSAGE` | Opus 高负载提示 |
| `getPdfTooLargeErrorMessage()` | 根据交互模式返回不同的 PDF 过大提示 |
| `getPdfPasswordProtectedErrorMessage()` | PDF 密码保护提示 |
| `getImageTooLargeErrorMessage()` | 图片过大提示 |
| `getRequestTooLargeErrorMessage()` | 请求体过大提示（413） |

### errorUtils.ts 导出函数

#### `extractConnectionErrorDetails(error: unknown): ConnectionErrorDetails | null`

递归遍历错误 cause 链（最多 5 层），返回根错误的 `code`、`message` 和 `isSSLError` 标志。

> 源码位置：`src/services/api/errorUtils.ts:42-83`

#### `getSSLErrorHint(error: unknown): string | null`

为 SSL/TLS 错误生成一行可操作提示（设置 `NODE_EXTRA_CA_CERTS` 或请 IT 加白名单）。用于 OAuth token 交换等 `formatAPIError` 不适用的场景。

> 源码位置：`src/services/api/errorUtils.ts:94-100`

#### `formatAPIError(error: APIError): string`

将 `APIError` 格式化为人类可读的字符串。处理连接超时、SSL 分类（7 种证书错误各有专属消息）、通用连接错误、HTML 响应净化（如 CloudFlare 错误页）、JSONL 反序列化后丢失 `.message` 的情况。

> 源码位置：`src/services/api/errorUtils.ts:200-260`

#### `sanitizeAPIError(apiError: APIError): string`

清理可能包含 HTML 内容（如 CloudFlare 错误页面）的 API 错误消息，提取 `<title>` 或返回空字符串。

> 源码位置：`src/services/api/errorUtils.ts:122-130`

## 接口/类型定义

### `ConnectionErrorDetails`（errorUtils.ts:31-35）

```typescript
type ConnectionErrorDetails = {
  code: string       // 底层错误码，如 'ETIMEDOUT'、'CERT_HAS_EXPIRED'
  message: string    // 原始错误消息
  isSSLError: boolean // 是否属于 SSL_ERROR_CODES 集合中的 29 个错误码之一
}
```

### `NestedAPIError`（errorUtils.ts:144-149）

描述从 JSONL 反序列化后 API 错误的两种嵌套结构：
- Bedrock / proxy：`{ error: { message: "..." } }`
- 标准 Anthropic API：`{ error: { error: { message: "..." } } }`

### SSL_ERROR_CODES 集合（errorUtils.ts:5-29）

包含 29 个 OpenSSL 错误码，分为：
- **证书验证错误**：`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`CERT_SIGNATURE_FAILURE`、`CERT_HAS_EXPIRED`、`CERT_REVOKED` 等
- **自签名证书**：`DEPTH_ZERO_SELF_SIGNED_CERT`、`SELF_SIGNED_CERT_IN_CHAIN`
- **证书链错误**：`CERT_CHAIN_TOO_LONG`、`PATH_LENGTH_EXCEEDED`
- **主机名/SAN 错误**：`ERR_TLS_CERT_ALTNAME_INVALID`、`HOSTNAME_MISMATCH`
- **TLS 握手错误**：`ERR_TLS_HANDSHAKE_TIMEOUT`、`ERR_SSL_WRONG_VERSION_NUMBER` 等

## 配置项与环境变量

| 环境变量 | 用途 |
|----------|------|
| `CLAUDE_CODE_REMOTE` | 当为 truthy 时进入 CCR 模式，认证错误提示重试而非 `/login` |
| `CLAUDE_CODE_USE_BEDROCK` | 启用 Bedrock 特定的错误处理分支 |
| `ANTHROPIC_API_KEY` | 检测来源判断是环境变量覆盖还是 OAuth 认证 |
| `ANTHROPIC_MODEL` | 内部员工模型 gate 检测 |
| `USER_TYPE` | 为 `'ant'`（内部员工）时提供额外诊断信息和反馈渠道引导 |
| `NODE_EXTRA_CA_CERTS` | SSL 提示中建议设置的 CA 证书路径 |

## 边界 Case 与注意事项

- **交互式 vs 非交互式模式**：多数错误消息函数（如 `getPdfTooLargeErrorMessage()`）通过 `getIsNonInteractiveSession()` 区分两种模式——CLI 模式提示 "double press esc"，SDK/非交互模式给出替代方案描述。

- **JSONL 反序列化后的错误对象**：从会话文件恢复时，`APIError` 对象会丢失 `.message` 属性。`formatAPIError()` 和 `extractNestedErrorMessage()` 针对此场景从嵌套的 `error.error.message` 或 `error.error.error.message` 中提取消息（`errorUtils.ts:169-198`）。

- **HTML 错误页面净化**：当 CloudFlare 等代理返回 HTML 错误页时，`sanitizeMessageHTML()` 提取 `<title>` 标签内容作为消息，避免在终端展示大段 HTML。

- **429 速率限制的 fallback 机制**：当 `getRateLimitErrorMessage()` 返回 `null` 时，表示静默降级（如 Opus → Sonnet），此时返回 `NO_RESPONSE_REQUESTED` 让对话继续而不向用户展示错误。

- **第三方模型降级建议**：`get3PModelFallbackSuggestion()` 为 Bedrock/Vertex 用户在模型不可用时推荐降级路径：Opus 4.6 → Opus 4.1，Sonnet 4.6 → Sonnet 4.5，Sonnet 4.5 → Sonnet 4.0（`errors.ts:940-959`）。

- **组织禁用的环境变量覆盖问题**：当用户同时配置了 `ANTHROPIC_API_KEY` 和 OAuth 时，如果 API Key 所属组织被禁用，模块会检测是否存在有效的 OAuth 令牌，并提示"取消设置环境变量以使用订阅"（`errors.ts:785-811`）。

- **tool_use/tool_result 不匹配诊断**：发生此错误时，`logToolUseToolResultMismatch()` 会构建规范化前后的消息序列快照并发送到分析系统，帮助定位并发相关的 corruption 路径（`errors.ts:222-382`）。

- **cause 链遍历深度限制**：`extractConnectionErrorDetails()` 设置最大遍历深度为 5，防止循环引用导致无限递归。