# 重试与容错逻辑（RetryAndResilience）

## 概述与职责

`withRetry` 模块是 Claude Code **API 通信层的核心容错组件**，位于 `Services → ApiClient` 层级中。它包裹每一次 Claude API 调用，提供自动重试、指数退避、多云凭证刷新、Fast Mode 降级、输出 Token 动态调整等能力。

在整体架构中，`ApiClient` 模块（`claude.ts` 和 `client.ts`）负责与 Claude 模型通信，而 `withRetry` 则作为调用的外壳，确保在网络抖动、速率限制、服务过载、凭证过期等场景下，请求能够自动恢复或优雅降级。同级模块包括 `McpClient`（MCP 工具服务器连接）、`Compact`（上下文压缩）、`Analytics`（遥测）等。

## 关键流程

### 1. 主重试循环

核心函数 `withRetry()` 是一个 **异步生成器**（`AsyncGenerator<SystemAPIErrorMessage, T>`），在等待重试期间通过 `yield` 向上游发送系统错误消息，用于 UI 展示重试状态。

主流程（`src/services/api/withRetry.ts:170-517`）：

1. 初始化 `RetryContext`（携带模型名、thinking 配置、Fast Mode 状态）
2. 进入 `for` 循环，最多执行 `maxRetries + 1` 次尝试
3. 每次尝试前检查 `AbortSignal`，支持用户中断
4. 捕获操作异常后，按优先级依次判断：
   - **Fast Mode 降级**：429/529 错误时决定短等待重试还是切换标准模式
   - **后台查询丢弃**：非前台查询源遇到 529 直接放弃，避免级联放大
   - **529 连续计数**：达到阈值（3次）触发模型降级（FallbackTriggeredError）
   - **凭证刷新**：OAuth 401/403、AWS/GCP 凭证过期时重建客户端
   - **连接重建**：ECONNRESET/EPIPE 时禁用 Keep-Alive 并重连
   - **输出 Token 调整**：上下文溢出时动态缩减 `max_tokens`
   - **常规退避等待**：指数退避 + 抖动，或遵循 `retry-after` 响应头

### 2. Fast Mode 降级策略

当 Fast Mode 处于激活状态且遇到 429/529 错误时（`src/services/api/withRetry.ts:267-314`）：

```
429/529 错误 → 检查 overage-disabled-reason 头
  ├─ 有 overage 原因 → 永久禁用 Fast Mode
  └─ 无 overage 原因 → 检查 retry-after 时长
       ├─ < 20秒（SHORT_RETRY_THRESHOLD_MS）→ 保持 Fast Mode，短等待重试（保护 prompt cache）
       └─ ≥ 20秒或未知 → 进入冷却期（至少10分钟），切换标准速度模型
```

关键常量：
- `SHORT_RETRY_THRESHOLD_MS`：20 秒，短重试阈值
- `MIN_COOLDOWN_MS`：10 分钟，最低冷却时长
- `DEFAULT_FAST_MODE_FALLBACK_HOLD_MS`：30 分钟，默认冷却时长

此外，若 API 返回 400 "Fast mode is not enabled"，则永久禁用 Fast Mode 并以标准速度重试（`src/services/api/withRetry.ts:310-314`）。

### 3. 前台/后台查询源差异化重试

模块维护了一个 `FOREGROUND_529_RETRY_SOURCES` 集合（`src/services/api/withRetry.ts:62-82`），只有以下查询源在 529 过载时才会重试：

- **用户直接交互**：`repl_main_thread`（及其 outputStyle 变体）、`sdk`
- **Agent 任务**：`agent:custom`、`agent:default`、`agent:builtin`
- **关键后台任务**：`compact`（压缩）、`hook_agent`、`hook_prompt`、`verification_agent`、`side_question`
- **安全分类器**：`auto_mode`、`bash_classifier`（特性门控，仅内部构建）

所有其他查询源（摘要、标题生成、建议等）遇到 529 时**立即丢弃**，不进行重试。原因是在容量级联期间，每次重试会产生 3-10 倍的网关放大效应，而这些后台请求的失败对用户不可见。

### 4. 连续 529 模型降级

当连续 529 错误达到 `MAX_529_RETRIES`（3 次）时（`src/services/api/withRetry.ts:327-365`）：

- 若配置了 `fallbackModel`：抛出 `FallbackTriggeredError`，通知上层切换备用模型
- 若为外部用户（非沙盒、非持久化模式）：抛出 `CannotRetryError`，携带友好的过载提示信息
- 触发条件受 `FALLBACK_FOR_ALL_PRIMARY_MODELS` 环境变量或模型类型（非自定义 Opus）控制

### 5. 凭证刷新与客户端重建

客户端实例在以下情况下会被重建（`src/services/api/withRetry.ts:218-251`）：

| 错误类型 | 检测条件 | 恢复动作 |
|---------|---------|---------|
| OAuth 401 | `APIError.status === 401` | 调用 `handleOAuth401Error()` 刷新 token，重建客户端 |
| OAuth Token 吊销 | 403 + "OAuth token has been revoked" | 同上 |
| AWS Bedrock 凭证过期 | `CredentialsProviderError` 或 403（Bedrock 环境） | 调用 `clearAwsCredentialsCache()`，重建客户端 |
| GCP Vertex 凭证过期 | google-auth-library 错误或 401（Vertex 环境） | 调用 `clearGcpCredentialsCache()`，重建客户端 |
| 连接重置 | `ECONNRESET` 或 `EPIPE` | 调用 `disableKeepAlive()` 禁用连接池，重建客户端 |

### 6. 持久化重试模式（Unattended）

通过环境变量 `CLAUDE_CODE_UNATTENDED_RETRY` 启用（需特性门控 `UNATTENDED_RETRY`），专为无人值守会话设计（`src/services/api/withRetry.ts:96-104`）。

特点：
- 429/529 错误**无限重试**，不受 `maxRetries` 限制（通过 `attempt` 钳位实现，`src/services/api/withRetry.ts:506`）
- 最大退避上限 5 分钟（`PERSISTENT_MAX_BACKOFF_MS`），总等待上限 6 小时（`PERSISTENT_RESET_CAP_MS`）
- 对于 429 错误，优先读取 `anthropic-ratelimit-unified-reset` 响应头获取精确重置时间
- 长等待期间每 30 秒（`HEARTBEAT_INTERVAL_MS`）通过 `yield` 发送心跳消息，防止宿主环境判定会话空闲

### 7. 输出 Token 动态调整

当 API 返回 400 错误且消息匹配 `"input length and max_tokens exceed context limit"` 时（`src/services/api/withRetry.ts:388-427`）：

1. `parseMaxTokensContextOverflowError()` 从错误消息中提取 `inputTokens`、`maxTokens`、`contextLimit`
2. 计算可用空间：`contextLimit - inputTokens - 1000`（安全缓冲）
3. 若可用空间低于 `FLOOR_OUTPUT_TOKENS`（3000），放弃重试
4. 否则设置 `retryContext.maxTokensOverride`，确保不低于 thinking budget + 1
5. 下次重试时上层使用调整后的 `max_tokens` 值

> 注：随着 extended-context-window beta 的引入，API 现在返回 `model_context_window_exceeded` stop_reason 而非此 400 错误。此逻辑保留用于向后兼容。

## 函数签名与参数说明

### `withRetry<T>(getClient, operation, options): AsyncGenerator<SystemAPIErrorMessage, T>`

主入口。包裹一个 API 操作并提供完整的重试容错。

| 参数 | 类型 | 说明 |
|------|------|------|
| `getClient` | `() => Promise<Anthropic>` | 获取 SDK 客户端实例的工厂函数，凭证刷新后会重新调用 |
| `operation` | `(client, attempt, context) => Promise<T>` | 实际的 API 调用操作 |
| `options` | `RetryOptions` | 重试配置（见下方类型定义） |

返回值为异步生成器，`yield` 的 `SystemAPIErrorMessage` 用于向 UI 层报告重试状态。

### `getRetryDelay(attempt, retryAfterHeader?, maxDelayMs?): number`

计算指数退避延迟（`src/services/api/withRetry.ts:530-548`）。

- 基础延迟：`BASE_DELAY_MS(500ms) × 2^(attempt-1)`，上限 `maxDelayMs`（默认 32 秒）
- 抖动：叠加 0~25% 的随机抖动
- 若存在 `retry-after` 响应头，直接使用其值（覆盖计算值）

### `parseMaxTokensContextOverflowError(error): { inputTokens, maxTokens, contextLimit } | undefined`

解析上下文溢出错误消息，提取 token 数量信息（`src/services/api/withRetry.ts:550-595`）。

### `is529Error(error): boolean`

检测 529 过载错误（`src/services/api/withRetry.ts:610-621`）。除了检查 status === 529，还匹配消息中的 `"type":"overloaded_error"`——因为 SDK 在流式模式下有时无法正确传递 529 状态码。

### `getDefaultMaxRetries(): number`

返回最大重试次数，优先读取 `CLAUDE_CODE_MAX_RETRIES` 环境变量，默认 10 次。

## 接口/类型定义

### `RetryContext`

```typescript
interface RetryContext {
  maxTokensOverride?: number  // 上下文溢出后动态调整的 max_tokens
  model: string               // 当前使用的模型
  thinkingConfig: ThinkingConfig
  fastMode?: boolean          // 是否启用 Fast Mode
}
```

传递给 `operation` 回调，让调用方感知重试过程中的状态变更（如 max_tokens 调整、Fast Mode 切换）。

### `RetryOptions`

```typescript
interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string           // 529 连续失败后的备用模型
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal             // 支持用户中断
  querySource?: QuerySource        // 查询来源，决定 529 重试策略
  initialConsecutive529Errors?: number  // 预设 529 计数（流式转非流式场景）
}
```

### `CannotRetryError`

重试耗尽或遇到不可重试错误时抛出。携带原始错误和当前 `RetryContext`，供上层决策。

### `FallbackTriggeredError`

连续 529 达到阈值且配置了 `fallbackModel` 时抛出，携带 `originalModel` 和 `fallbackModel`，通知上层切换模型。

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `CLAUDE_CODE_MAX_RETRIES` | 环境变量 | 10 | 最大重试次数 |
| `CLAUDE_CODE_UNATTENDED_RETRY` | 环境变量 + 特性门控 | 禁用 | 启用无限持久化重试 |
| `CLAUDE_CODE_USE_BEDROCK` | 环境变量 | - | 启用 AWS Bedrock 凭证错误处理 |
| `CLAUDE_CODE_USE_VERTEX` | 环境变量 | - | 启用 GCP Vertex 凭证错误处理 |
| `CLAUDE_CODE_REMOTE` | 环境变量 | - | CCR 模式，401/403 视为暂态错误 |
| `FALLBACK_FOR_ALL_PRIMARY_MODELS` | 环境变量 | - | 所有主模型均启用 529 降级 |
| `BASE_DELAY_MS` | 常量 | 500ms | 指数退避基础延迟 |
| `DEFAULT_MAX_RETRIES` | 常量 | 10 | 默认最大重试次数 |
| `MAX_529_RETRIES` | 常量 | 3 | 触发模型降级的连续 529 阈值 |
| `FLOOR_OUTPUT_TOKENS` | 常量 | 3000 | 输出 Token 下限 |
| `PERSISTENT_MAX_BACKOFF_MS` | 常量 | 5 分钟 | 持久化模式最大退避 |
| `PERSISTENT_RESET_CAP_MS` | 常量 | 6 小时 | 持久化模式总等待上限 |
| `HEARTBEAT_INTERVAL_MS` | 常量 | 30 秒 | 持久化模式心跳间隔 |
| `SHORT_RETRY_THRESHOLD_MS` | 常量 | 20 秒 | Fast Mode 短重试阈值 |
| `MIN_COOLDOWN_MS` | 常量 | 10 分钟 | Fast Mode 最低冷却时长 |

## 边界 Case 与注意事项

- **`shouldRetry` 中的订阅者差异化处理**：Claude.ai Max/Pro 订阅用户即使收到 `x-should-retry: true`，429 时也不重试（因为重试窗口通常是数小时）。Enterprise 用户例外，因其通常使用按量付费。参见 `src/services/api/withRetry.ts:737-769`。

- **Mock 错误不重试**：通过 `/mock-limits` 命令生成的模拟速率限制错误（Ant 内部测试工具）会被 `isMockRateLimitError()` 识别并跳过重试。

- **CCR 模式的 401/403 处理**：远程运行时（`CLAUDE_CODE_REMOTE`）中，401/403 被视为暂态错误（基础设施 JWT 短暂失效），绕过 `x-should-retry: false` 直接重试。

- **`initialConsecutive529Errors` 的用途**：当流式请求遇到 529 后降级为非流式请求时，流式阶段的 529 计数通过此字段传入，确保总 529 次数一致，不会因请求模式切换而重置。

- **529 检测的双重逻辑**：`is529Error()` 除了检查 HTTP 状态码，还匹配错误消息中的 `"type":"overloaded_error"` 字符串——这是因为 Anthropic SDK 在流式模式下有时无法正确传递 529 状态码。

- **Ant 用户 5xx 特权**：内部用户（`USER_TYPE=ant`）在遇到 5xx 服务端错误时，会忽略 `x-should-retry: false` 头继续重试（`src/services/api/withRetry.ts:746-751`）。