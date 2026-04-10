# MessageStream — Claude API 核心调用入口

## 概述与职责

MessageStream 模块是 Claude Code 整个 API 通信层的核心，位于 `Services > ApiClient` 层级下。它负责与 Anthropic Claude API 的所有直接交互：构建请求参数、发起流式消息请求、处理流事件、收集用量统计，并协调重试、缓存、日志等子系统。

在整体架构中，它是 **CoreEngine 与 Claude 模型之间的桥梁**——上游的 QueryEngine 调用本模块发送消息并接收流式响应，下游依赖 Compact（上下文压缩）、Analytics（遥测）、withRetry（重试逻辑）等子模块。同级模块 McpClient 负责外部工具服务器通信，而本模块专注于 Claude API 本身。

本模块由三个文件组成：
- **`claude.ts`**（约 3420 行）：核心调用逻辑，包含请求构建、流式处理、重试回退的全部实现
- **`dumpPrompts.ts`**（227 行）：调试用的请求/响应记录，为内部 `/issue` 命令提供数据
- **`emptyUsage.ts`**（22 行）：零值 Usage 对象常量，避免循环依赖

## 关键流程

### 1. 主请求流程（queryModel）

`queryModel` 是整个模块的核心函数（`claude.ts:1017-2892`），它是一个 `AsyncGenerator`，按以下步骤执行：

1. **前置检查**：验证 Off-Switch 开关状态（GrowthBook 动态配置），对非订阅用户的 Opus 模型可临时禁用服务
2. **Beta 头组装**：调用 `getMergedBetas()` 获取模型级 beta 列表，按需追加 Advisor、Tool Search、Fast Mode、AFK Mode、Cache Editing 等 beta header。使用 **sticky-on latch 机制**（`claude.ts:1405-1456`）确保 beta header 一旦启用就保持不变，防止中途切换导致服务端缓存失效
3. **工具 Schema 构建**：将内部 `Tool` 对象转换为 API 格式，支持 `defer_loading` 延迟加载和动态工具发现
4. **消息规范化**：调用 `normalizeMessagesForAPI()` 处理消息格式，然后依次执行 tool_result 配对修复、Advisor 块清理、多媒体数量裁剪
5. **系统提示词构建**：拼接归因头、CLI 前缀、用户系统提示词、Advisor/Chrome 指令
6. **Prompt Cache 配置**：通过 `addCacheBreakpoints()` 在消息中插入 `cache_control` 标记
7. **发起流式请求**：通过 `withRetry` 包装器调用 `anthropic.beta.messages.create({ stream: true })`
8. **流事件消费**：逐事件处理 `message_start`、`content_block_start/delta/stop`、`message_delta`、`message_stop`
9. **错误恢复**：流式失败时自动回退到非流式模式（`executeNonStreamingRequest`）
10. **成功日志**：记录用量统计、耗时、缓存命中情况

### 2. 流式事件处理

流事件处理发生在 `claude.ts:1979-2297` 的 `switch(part.type)` 分支中：

| 事件类型 | 处理逻辑 |
|---------|---------|
| `message_start` | 初始化 `partialMessage`，记录 TTFB，提取初始 usage |
| `content_block_start` | 按 block 类型（`tool_use`/`server_tool_use`/`text`/`thinking`）初始化内容块，`input` 初始化为空字符串用于后续拼接 |
| `content_block_delta` | 增量追加内容：`input_json_delta` → 拼接 JSON，`text_delta` → 拼接文本，`thinking_delta` → 拼接思考内容，`signature_delta` → 设置签名 |
| `content_block_stop` | 将完成的 content block 通过 `normalizeContentFromAPI()` 规范化后构造 `AssistantMessage` 并 yield |
| `message_delta` | 更新最终 usage 和 `stop_reason`，计算 USD 成本，处理 `max_tokens` 和 `model_context_window_exceeded` 停止原因 |

### 3. 流式健康监控

模块内置两层流式健康检测机制（`claude.ts:1868-1928`）：

- **Stall 检测**（被动）：每个事件到达时检查距上一事件是否超过 30 秒，超过则记录 `tengu_streaming_stall` 事件
- **Idle Watchdog**（主动）：使用 `setTimeout` 监控，默认 90 秒无数据则主动中断流并触发非流式回退。可通过 `CLAUDE_ENABLE_STREAM_WATCHDOG` 环境变量启用，通过 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 配置超时时长

### 4. 非流式回退机制

当流式请求失败（网络错误、超时、空响应等）时，模块自动回退到非流式模式：

```
流式请求失败
  → 检查 CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK / GrowthBook 开关
  → 若允许回退：调用 executeNonStreamingRequest()
  → 通过 withRetry 包装，支持 529 错误计数延续
  → 超时配置：远程会话 120s，本地 300s
```

特殊情况：404 错误在流创建阶段抛出时（`claude.ts:2612-2749`），也会触发非流式回退——这处理了某些网关不支持流式端点的场景。

回退可通过 `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` 环境变量或 GrowthBook 特性开关 `tengu_disable_streaming_to_non_streaming_fallback` 禁用。

## 函数签名与参数说明

### `queryModelWithStreaming(params): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage>`

流式查询的公开入口（`claude.ts:752-780`）。通过 VCR 包装器（用于测试录放）委托给内部 `queryModel`。

### `queryModelWithoutStreaming(params): Promise<AssistantMessage>`

非流式查询的公开入口（`claude.ts:709-750`）。消费 `queryModel` 生成器直到获取完整的 `AssistantMessage`。

### `queryHaiku(params): Promise<AssistantMessage>`

便捷方法（`claude.ts:3241-3291`），使用小型快速模型（Haiku）进行轻量查询，不带工具、不启用思考，适用于分类、摘要等辅助任务。

### `queryWithModel(params): Promise<AssistantMessage>`

通用便捷方法（`claude.ts:3300-3348`），通过完整的 Claude Code 基础设施（认证、beta、header）查询指定模型。

### `verifyApiKey(apiKey, isNonInteractiveSession): Promise<boolean>`

API 密钥验证（`claude.ts:530-586`），使用 Haiku 模型发送最小测试请求。非交互模式下跳过验证。

## 接口/类型定义

### `Options`

主查询配置类型（`claude.ts:676-707`），关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | `string` | 使用的模型标识符 |
| `querySource` | `QuerySource` | 查询来源标识（`repl_main_thread`、`agent:*`、`sdk` 等） |
| `toolChoice` | `BetaToolChoiceTool \| BetaToolChoiceAuto` | 工具选择策略 |
| `fallbackModel` | `string?` | 模型降级回退目标 |
| `mcpTools` | `Tools` | MCP 外部工具列表 |
| `effortValue` | `EffortValue?` | 推理努力程度（`low`/`medium`/`high` 或数值） |
| `fastMode` | `boolean?` | 是否启用快速模式 |
| `advisorModel` | `string?` | Advisor 服务端工具使用的模型 |
| `taskBudget` | `{ total: number; remaining?: number }?` | API 侧 token 预算，让模型自行控制节奏 |
| `outputFormat` | `BetaJSONOutputFormat?` | 结构化输出格式（JSON Schema） |
| `enablePromptCaching` | `boolean?` | 是否启用 prompt 缓存 |
| `skipCacheWrite` | `boolean?` | 跳过缓存写入（用于 fire-and-forget 分支查询） |

### `EMPTY_USAGE`

零值 Usage 常量（`emptyUsage.ts:8-22`），类型为 `Readonly<NonNullableUsage>`，包含所有 usage 字段的零值初始化，包括 `server_tool_use`、`cache_creation`、`iterations`、`speed` 等。独立文件存在是为了避免循环依赖——`bridge/replBridge.ts` 需要导入它但不应间接拉入整个 API 模块。

## 配置项与默认值

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CLAUDE_CODE_EXTRA_BODY` | - | JSON 对象，额外的 API 请求 body 参数 |
| `CLAUDE_CODE_EXTRA_METADATA` | - | JSON 对象，额外的 API 元数据 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | 模型默认值 | 最大输出 token 数 |
| `CLAUDE_CODE_DISABLE_THINKING` | `false` | 禁用思考模式 |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | `false` | 禁用自适应思考，回退到预算思考 |
| `DISABLE_PROMPT_CACHING` | `false` | 全局禁用 prompt 缓存 |
| `DISABLE_PROMPT_CACHING_HAIKU` | `false` | 仅禁用 Haiku 模型的 prompt 缓存 |
| `DISABLE_PROMPT_CACHING_SONNET` | `false` | 仅禁用 Sonnet 模型的 prompt 缓存 |
| `DISABLE_PROMPT_CACHING_OPUS` | `false` | 仅禁用 Opus 模型的 prompt 缓存 |
| `ENABLE_PROMPT_CACHING_1H_BEDROCK` | `false` | 为 3P Bedrock 用户启用 1 小时缓存 TTL |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | `false` | 禁用流式到非流式的自动回退 |
| `CLAUDE_ENABLE_STREAM_WATCHDOG` | `false` | 启用流式空闲超时看门狗 |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | `90000` | 流式空闲超时时间（毫秒） |
| `API_TIMEOUT_MS` | 远程 120s / 本地 300s | 非流式回退的请求超时 |
| `CLAUDE_CODE_REMOTE` | - | 标识远程会话，影响超时默认值 |

### 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_NON_STREAMING_TOKENS` | `64,000` | 非流式模式最大 token 数（`claude.ts:3354`） |
| `API_MAX_MEDIA_PER_REQUEST` | 100（从 constants 导入） | 单请求最大媒体项数 |
| `STALL_THRESHOLD_MS` | `30,000` | 流式停顿检测阈值 |

## 关键设计决策

### Sticky-on Beta Header Latch

Beta header 采用"一旦激活即保持"的 latch 机制（`claude.ts:1405-1456`）。一旦某个 beta header 在会话中被发送过一次，后续所有请求都会继续携带它。原因是：**服务端 prompt 缓存的 key 包含 beta header**，中途切换 header 会导致约 50-70K token 的缓存失效。Latch 在 `/clear` 和 `/compact` 时重置。

### 裸 Stream 而非 BetaMessageStream

模块直接使用 `anthropic.beta.messages.create({ stream: true })` 返回的原始 SSE 流，而非 SDK 提供的 `BetaMessageStream` 高层封装（`claude.ts:1818-1820`）。原因是 `BetaMessageStream` 对每个 `input_json_delta` 事件执行 `partialParse()`，产生 O(n²) 的 JSON 解析开销，而本模块自行通过字符串拼接累积 tool input，最终一次解析。

### 内存泄漏防护

`releaseStreamResources()`（`claude.ts:1519-1526`）在 `finally` 块中主动释放 Stream 和 Response 对象。Response 对象持有 V8 堆外的原生 TLS/socket 缓冲区，不释放会造成内存泄漏（参见 GH #32920）。

### 缓存断点策略

`addCacheBreakpoints()` 每个请求**只设置一个** `cache_control` 标记（`claude.ts:3078-3088`）。多个标记会导致 mycro（服务端 KV 缓存引擎）无法及时释放 local-attention KV pages。对于 `skipCacheWrite` 的分支查询，标记放在倒数第二条消息上，使缓存写入成为 no-op merge。

## dumpPrompts 调试子系统

`dumpPrompts.ts` 为内部用户（`USER_TYPE === 'ant'`）提供 API 请求/响应的 JSONL 日志：

- **`createDumpPromptsFetch()`**（`dumpPrompts.ts:146-226`）：返回一个自定义 `fetch` 函数，拦截所有 POST 请求，使用 `setImmediate` 异步记录请求体（避免阻塞 API 调用），并异步解析 SSE 流响应
- **`DumpState`**：每个 agent/session 独立跟踪状态，使用指纹比对（model + tool names + system prompt length）跳过昂贵的 stringify 操作
- **增量记录**：首次请求记录完整 `init` 数据，后续仅在 system/tools 变更时记录 `system_update`，每轮只记录新增的 user message
- **缓存**：最近 5 条请求保存在内存中，供 `/issue` 命令使用

## 边界 Case 与注意事项

- **空流检测**：如果流完成但未产生任何 `AssistantMessage`（无 `message_start` 或无 `content_block_stop`），会主动抛出错误触发非流式回退（`claude.ts:2350-2364`）。这处理了代理服务器返回 200 但无 SSE 数据的场景
- **SDK 的 `APIUserAbortError` 歧义**：SDK 在用户主动取消和内部超时时都抛出此错误。模块通过检查 `signal.aborted` 区分两者（`claude.ts:2434-2462`）——只有用户主动触发才重新抛出，超时则转换为 `APIConnectionTimeoutError`
- **多媒体数量限制**：API 限制每请求 100 个媒体项。模块在发送前静默裁剪最旧的媒体项（`stripExcessMediaItems`，`claude.ts:956-1015`），而非报错，以避免 Cowork/CCD 模式下难以恢复的错误
- **Thinking 配置**：支持 `adaptive`（无预算限制）和 `enabled`（带预算）两种模式。Adaptive 思考仅限支持的模型；非流式回退时 thinking budget 会自动调低以满足 `max_tokens > budget_tokens` 的 API 约束
- **1 小时缓存 TTL 的 Latch**：用户资格和 GrowthBook 允许列表在首次检查后缓存到 bootstrap state，防止会话中途因额度变化或配置更新导致 TTL 翻转，进而导致缓存失效（约 20K token 损失）
- **`FallbackTriggeredError` 透传**：此错误**不能**被 catch 块吞掉（`claude.ts:2599-2605`），必须向上传播到 `query.ts` 执行实际的模型切换