# SessionTelemetry

## 概述与职责

`SessionTelemetry` 是 `codex-otel` crate 中的**高级遥测门面（facade）**，为每个会话提供统一的结构化遥测事件发送接口。它位于 **Observability → OpenTelemetry** 层级之下，是 Core、AppServer 等上层模块发送遥测数据的主要入口。

在整体架构中，`SessionTelemetry` 属于 Observability 子系统的 OpenTelemetry 模块，与同级的 Analytics（用量分析）和 Feedback（用户反馈）模块并列。Core 和 AppServer 通过调用 `SessionTelemetry` 的方法来记录 API 调用、工具执行、SSE/WebSocket 事件等关键操作的遥测数据。

该模块的核心职责：

1. **双通道事件发送**：每个遥测事件同时通过 OTel log 和 OTel trace 两条通路输出，通过 `tracing` 宏的 `target` 路由实现分流
2. **指标采集**：通过内嵌的 `MetricsClient` 记录计数器（counter）和直方图（histogram）指标
3. **会话元数据管理**：维护 conversation ID、认证模式、模型名称、来源等会话级上下文，自动附加到每个事件
4. **运行时指标快照**：支持采集和重置运行时指标摘要

> 源码位置：`codex-rs/otel/src/events/session_telemetry.rs`、`codex-rs/otel/src/events/shared.rs`、`codex-rs/otel/src/lib.rs`

## 关键流程

### 事件双通道路由机制

`SessionTelemetry` 的核心设计是**每个遥测事件同时走两条通路**：log 通路（携带完整数据，含敏感信息）和 trace 通路（仅含安全数据，适合远端采集）。这通过三个内部宏实现：

1. **`log_event!`**：使用 `tracing::event!` 发送事件，target 设为 `codex_otel.log_only`。log 通路会携带完整的原始数据（如用户 prompt 文本、工具输出内容等）（`codex-rs/otel/src/events/shared.rs:4-22`）

2. **`trace_event!`**：同样使用 `tracing::event!`，target 设为 `codex_otel.trace_safe`。trace 通路仅携带脱敏后的数据（如只记录长度而非内容）（`codex-rs/otel/src/events/shared.rs:24-40`）

3. **`log_and_trace_event!`**：组合宏，接受 `common`（两路共享）、`log`（仅 log 通路）、`trace`（仅 trace 通路）三组字段，一次调用同时发送两个事件（`codex-rs/otel/src/events/shared.rs:42-52`）

target 路由的判定逻辑在 `targets.rs` 中定义：
- `codex_otel.log_only` → 仅导出到 OTel log
- `codex_otel.trace_safe` → 导出到 OTel trace（span 事件）

所有三个宏都会自动附加会话元数据字段（`conversation.id`、`app.version`、`auth_mode`、`originator`、`model`、`slug` 等），确保每条事件都能关联到具体会话。

### API 请求遥测流程

以 `record_api_request` 为例，展示一个典型的遥测记录流程：

1. 调用方（如 HTTP 客户端）传入请求的 `attempt`、`status`、`error`、`duration` 以及认证相关的元数据
2. 方法先判定请求是否成功（2xx 且无 error）
3. 发送 `API_CALL_COUNT_METRIC` 计数器（+1），带 status 和 success 标签
4. 发送 `API_CALL_DURATION_METRIC` 直方图记录耗时
5. 通过 `log_and_trace_event!` 发送 `codex.api_request` 结构化事件，携带完整的认证环境信息

> 源码位置：`codex-rs/otel/src/events/session_telemetry.rs:391-451`

`log_request` 方法是一个更高层的异步包装器，自动计时并调用 `record_api_request`（`codex-rs/otel/src/events/session_telemetry.rs:357-388`）。

### 指标标签合并机制

每次记录指标时，`tags_with_metadata` 方法会将调用方提供的额外标签与会话级元数据标签合并（`codex-rs/otel/src/events/session_telemetry.rs:234-241`）。元数据标签包括 `auth_mode`、`session_source`、`originator`、`service_name`、`model`、`app_version`，由 `SessionMetricTagValues` 结构体转换而来。

可通过 `with_metrics_without_metadata_tags` 构建器方法禁用元数据标签自动注入，此时 `metadata_tag_refs` 返回空向量（`codex-rs/otel/src/events/session_telemetry.rs:123-127`）。

## 函数签名与参数说明

### 构造与配置

#### `SessionTelemetry::new(...) -> SessionTelemetry`

创建新的会话遥测实例。

| 参数 | 类型 | 说明 |
|------|------|------|
| `conversation_id` | `ThreadId` | 会话唯一标识 |
| `model` | `&str` | 模型名称 |
| `slug` | `&str` | 模型 slug |
| `account_id` | `Option<String>` | 用户账户 ID |
| `account_email` | `Option<String>` | 用户邮箱 |
| `auth_mode` | `Option<TelemetryAuthMode>` | 认证模式 |
| `originator` | `String` | 请求来源标识（会被 `sanitize_metric_tag_value` 清洗） |
| `log_user_prompts` | `bool` | 是否在 log 通路中记录用户 prompt 原文 |
| `terminal_type` | `String` | 终端类型 |
| `session_source` | `SessionSource` | 会话来源（如 TUI、AppServer 等） |

构造时自动获取全局 `MetricsClient`（通过 `crate::metrics::global()`），并默认启用元数据标签。

> 源码位置：`codex-rs/otel/src/events/session_telemetry.rs:258-290`

#### Builder 方法（链式调用）

- **`with_auth_env(auth_env: AuthEnvTelemetryMetadata) -> Self`**：设置认证环境元数据
- **`with_model(model: &str, slug: &str) -> Self`**：更新模型名称和 slug
- **`with_metrics_service_name(service_name: &str) -> Self`**：设置指标的 service_name 标签
- **`with_metrics(metrics: MetricsClient) -> Self`**：注入自定义 MetricsClient，启用元数据标签
- **`with_metrics_without_metadata_tags(metrics: MetricsClient) -> Self`**：注入 MetricsClient 但不附加元数据标签
- **`with_metrics_config(config: MetricsConfig) -> MetricsResult<Self>`**：从配置创建 MetricsClient
- **`with_provider_metrics(provider: &OtelProvider) -> Self`**：从 OtelProvider 获取 MetricsClient

### 基础指标方法

#### `counter(&self, name: &str, inc: i64, tags: &[(&str, &str)])`

递增计数器指标。如果 MetricsClient 未配置则静默跳过，出错时打印 warn 日志。

#### `histogram(&self, name: &str, value: i64, tags: &[(&str, &str)])`

记录直方图指标值。

#### `record_duration(&self, name: &str, duration: Duration, tags: &[(&str, &str)])`

记录耗时直方图指标。

#### `start_timer(&self, name: &str, tags: &[(&str, &str)]) -> Result<Timer, MetricsError>`

启动一个计时器，返回 `Timer` 对象（drop 时自动记录耗时）。

### 会话生命周期事件

#### `conversation_starts(&self, ...)`

记录会话开始事件（`codex.conversation_starts`）。发送包含 provider 名称、reasoning 配置、上下文窗口大小、审批策略、沙箱策略、MCP 服务器列表、活跃 Profile 等信息的事件。如果启用了 Profile，还会递增 `PROFILE_USAGE_METRIC` 计数器。

> 源码位置：`codex-rs/otel/src/events/session_telemetry.rs:313-355`

#### `user_prompt(&self, items: &[UserInput])`

记录用户输入事件（`codex.user_prompt`）。log 通路记录 prompt 原文（受 `log_user_prompts` 开关控制，关闭时记录 `[REDACTED]`）；trace 通路仅记录文本长度和各类输入的计数（text、image、local_image）。

> 源码位置：`codex-rs/otel/src/events/session_telemetry.rs:821-862`

### API 请求遥测

#### `log_request<F, Fut>(&self, attempt: u64, f: F) -> Result<Response, Error>`

异步包装器，自动为请求计时并调用 `record_api_request`。`f` 是实际执行 HTTP 请求的闭包。

#### `record_api_request(&self, attempt, status, error, duration, ...)`

记录 API 请求的完整遥测，包括 HTTP 状态码、耗时、认证头信息、重试状态、恢复模式、endpoint、request ID、Cloudflare ray ID 等。发送 `codex.api_request` 事件和 `API_CALL_COUNT_METRIC` / `API_CALL_DURATION_METRIC` 指标。

### WebSocket 遥测

#### `record_websocket_connect(&self, duration, status, error, ...)`

记录 WebSocket 连接建立事件（`codex.websocket_connect`），含认证信息、连接复用状态等。

#### `record_websocket_request(&self, duration, error, connection_reused)`

记录 WebSocket 请求级遥测（`codex.websocket_request`），发送 `WEBSOCKET_REQUEST_COUNT_METRIC` 和 `WEBSOCKET_REQUEST_DURATION_METRIC` 指标。

#### `record_websocket_event(&self, result, duration)`

解析 WebSocket 消息并记录事件（`codex.websocket_event`）。对文本消息解析 JSON 获取 `type` 字段作为事件类型；对 `responsesapi.websocket_timing` 类型的消息还会提取和记录服务端时序指标（overhead、inference time、TTFT、TBT 等）。Ping/Pong 消息被静默忽略。

> 源码位置：`codex-rs/otel/src/events/session_telemetry.rs:576-670`

### SSE 遥测

#### `log_sse_event<E>(&self, response, duration)`

解析 SSE 流事件并记录遥测。处理逻辑：
- 正常事件：记录事件类型和耗时
- `response.failed`：解析错误内容并记录失败
- `response.output_item.done`：尝试解析为 `ResponseItem`，失败则记录解析错误
- 流错误或超时：记录失败事件

#### `sse_event_completed(&self, input_token_count, output_token_count, ...)`

记录 SSE 流的 `response.completed` 事件，包含 token 用量统计（输入、输出、缓存、推理、工具 token 数量）。

#### `see_event_completed_failed<T>(&self, error: &T)`

记录 `response.completed` 事件处理失败。

### 工具调用遥测

#### `tool_decision(&self, tool_name, call_id, decision, source)`

记录工具审批决策事件（`codex.tool_decision`），包含工具名、调用 ID、审批结果和决策来源。仅走 log 通路。

#### `log_tool_result_with_tags<F, Fut, E>(&self, tool_name, call_id, arguments, extra_tags, mcp_server, mcp_server_origin, f)`

异步包装器，自动计时工具执行并记录结果。

#### `tool_result_with_tags(&self, tool_name, call_id, arguments, duration, success, output, extra_tags, mcp_server, mcp_server_origin)`

记录工具执行结果事件（`codex.tool_result`）。log 通路记录完整的 arguments 和 output 内容；trace 通路仅记录长度和行数。还区分 `builtin` 和 `mcp` 工具来源。发送 `TOOL_CALL_COUNT_METRIC` 和 `TOOL_CALL_DURATION_METRIC` 指标。

> 源码位置：`codex-rs/otel/src/events/session_telemetry.rs:945-992`

#### `log_tool_failed(&self, tool_name, error)`

记录工具执行失败（duration 为 0，success 为 false）。

### 模型响应遥测

#### `record_responses(&self, handle_responses_span: &Span, event: &ResponseEvent)`

在已有的 tracing span 上记录模型响应事件的类型信息。设置 span 的 `otel.name` 为事件类型字符串，对 `OutputItemDone` 和 `OutputItemAdded` 事件还记录 `tool_name`（如果是函数调用）。

### 认证恢复遥测

#### `record_auth_recovery(&self, mode, step, outcome, ...)`

记录认证恢复流程的各步骤事件（`codex.auth_recovery`），含恢复模式、步骤、结果、错误信息、状态变更标记等。

### 运行时指标管理

#### `shutdown_metrics(&self) -> MetricsResult<()>`

关闭 MetricsClient。

#### `snapshot_metrics(&self) -> MetricsResult<ResourceMetrics>`

获取当前指标快照。

#### `reset_runtime_metrics(&self)`

采集并丢弃一次指标快照，用于重置 delta 累加器。

#### `runtime_metrics_summary(&self) -> Option<RuntimeMetricsSummary>`

采集运行时指标摘要。如果快照为空则返回 `None`。

## 接口/类型定义

### `SessionTelemetryMetadata`

会话遥测元数据结构，自动附加到每个遥测事件。

| 字段 | 类型 | 说明 |
|------|------|------|
| `conversation_id` | `ThreadId` | 会话 ID |
| `auth_mode` | `Option<String>` | 认证模式的字符串表示 |
| `auth_env` | `AuthEnvTelemetryMetadata` | 认证环境信息 |
| `account_id` | `Option<String>` | 账户 ID |
| `account_email` | `Option<String>` | 账户邮箱 |
| `originator` | `String` | 请求来源（已清洗） |
| `service_name` | `Option<String>` | 服务名称标签 |
| `session_source` | `String` | 会话来源 |
| `model` | `String` | 模型名称 |
| `slug` | `String` | 模型 slug |
| `log_user_prompts` | `bool` | 是否记录 prompt 原文 |
| `app_version` | `&'static str` | 应用版本（编译时注入） |
| `terminal_type` | `String` | 终端类型 |

> 源码位置：`codex-rs/otel/src/events/session_telemetry.rs:76-91`

### `AuthEnvTelemetryMetadata`

认证环境元数据，记录各种 API key 环境变量的存在状态。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `openai_api_key_env_present` | `bool` | `false` | `OPENAI_API_KEY` 环境变量是否存在 |
| `codex_api_key_env_present` | `bool` | `false` | Codex API key 环境变量是否存在 |
| `codex_api_key_env_enabled` | `bool` | `false` | Codex API key 是否启用 |
| `provider_env_key_name` | `Option<String>` | `None` | 自定义 provider key 的环境变量名 |
| `provider_env_key_present` | `Option<bool>` | `None` | 自定义 provider key 是否存在 |
| `refresh_token_url_override_present` | `bool` | `false` | 刷新 token URL 覆盖是否存在 |

> 源码位置：`codex-rs/otel/src/events/session_telemetry.rs:66-74`

### `ToolDecisionSource`（定义于 `lib.rs`）

工具审批决策的来源枚举，序列化为 `snake_case`。

| 变体 | 说明 |
|------|------|
| `AutomatedReviewer` | 自动审批器 |
| `Config` | 配置规则 |
| `User` | 用户手动决策 |

> 源码位置：`codex-rs/otel/src/lib.rs:31-37`

### `TelemetryAuthMode`（定义于 `lib.rs`）

认证模式的遥测表示，避免对 `codex-core` 的循环依赖。

| 变体 | 说明 |
|------|------|
| `ApiKey` | API key 认证 |
| `Chatgpt` | ChatGPT 账号认证（含 `Chatgpt` 和 `ChatgptAuthTokens` 两种协议模式） |

实现了 `From<codex_app_server_protocol::AuthMode>` 转换。

> 源码位置：`codex-rs/otel/src/lib.rs:40-54`

## 边界 Case 与注意事项

- **MetricsClient 可选**：`counter`、`histogram`、`record_duration` 方法在 `self.metrics` 为 `None` 时静默返回，不会 panic。出错时仅打印 `tracing::warn` 日志，不会向上传播错误。

- **log 与 trace 的数据敏感性差异**：`log_event!` 会记录完整的用户 prompt 和工具 output 内容（受 `log_user_prompts` 控制），而 `trace_event!` 仅记录长度/行数等聚合信息。此外 trace 通路不包含 `user.account_id` 和 `user.email`。这是隐私保护的核心设计。

- **Ping/Pong 静默忽略**：`record_websocket_event` 对 WebSocket 的 Ping/Pong 消息直接 `return`，不记录任何遥测。

- **WebSocket timing 指标提取**：当收到 `responsesapi.websocket_timing` 类型的 WebSocket 消息时，会从 JSON 中提取 6 个服务端时序字段（overhead、inference、IAPI TTFT/TBT、service TTFT/TBT）并记录为独立的 duration 指标。`duration_from_ms_value` 辅助函数会过滤 NaN/Infinity/负值（`codex-rs/otel/src/events/session_telemetry.rs:1086-1097`）。

- **`app_version` 编译时注入**：通过 `env!("CARGO_PKG_VERSION")` 在编译时确定，运行时不可更改。

- **`originator` 值清洗**：构造时通过 `sanitize_metric_tag_value` 清洗 originator 字符串，确保其适合作为指标标签值。

- **全局 MetricsClient 回退**：`new` 构造函数会自动获取全局安装的 `MetricsClient`（`crate::metrics::global()`），但也可以通过 builder 方法覆盖。`start_global_timer` 函数（`lib.rs:57-62`）提供了不依赖 `SessionTelemetry` 实例的全局计时器入口。