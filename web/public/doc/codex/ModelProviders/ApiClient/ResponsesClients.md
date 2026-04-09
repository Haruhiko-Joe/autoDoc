# ResponsesClients — Responses API 客户端

## 概述与职责

ResponsesClients 是 Codex 与 OpenAI Responses API 通信的核心客户端模块，位于 **ModelProviders → ApiClient** 层级下。它提供两种传输方式与 Responses API 交互：

- **HTTP + SSE**：`ResponsesClient` 发送 POST 请求，消费服务端发送的 SSE（Server-Sent Events）流
- **WebSocket**：`ResponsesWebsocketClient` 维护持久 WebSocket 连接，支持 per-message deflate 压缩、连接复用和空闲超时

此外，模块还包含 **SSE 流解析器**（将原始 SSE 事件解码为类型化的 `ResponseEvent`）和 **请求体构建辅助函数**（Azure item-ID 附加、zstd 压缩选择）。

同级兄弟模块包括 HttpTransport（底层 HTTP 传输）、ModelsManager（模型发现与管理）、ProviderRegistry（提供商配置注册）等。本模块依赖 HttpTransport 的 `ReqwestTransport` 完成实际的 HTTP 请求发送和 SSE 流消费。

---

## 模块结构

| 文件 | 职责 |
|------|------|
| `endpoint/responses.rs` | HTTP 模式的 `ResponsesClient` |
| `endpoint/responses_websocket.rs` | WebSocket 模式的 `ResponsesWebsocketClient` 和连接管理 |
| `sse/responses.rs` | SSE 流解析器和事件处理核心逻辑 |
| `sse/mod.rs` | SSE 模块的公开导出 |
| `requests/responses.rs` | 请求体辅助：`Compression` 枚举和 `attach_item_ids` |

---

## 关键流程

### 1. HTTP + SSE 请求流程（ResponsesClient）

1. 调用 `stream_request()` 传入 `ResponsesApiRequest` 和 `ResponsesOptions`
2. 将请求序列化为 JSON（`serde_json::to_value`）
3. **Azure 特殊处理**：如果 `request.store == true` 且 provider 是 Azure Responses 端点，调用 `attach_item_ids()` 为输入项附加 item ID（`requests/responses.rs:11-37`）
4. 构建 HTTP 头：`x-client-request-id`、会话 header、子 agent header
5. 调用内部 `stream()` 方法，设置 `Accept: text/event-stream` 头和请求压缩方式
6. 通过 `EndpointSession.stream_with()` 发送 POST 请求到 `/responses` 端点
7. 响应流经 `spawn_response_stream()` 封装为 `ResponseStream`

> 源码位置：`codex-rs/codex-api/src/endpoint/responses.rs:69-150`

### 2. WebSocket 连接与请求流程

**连接阶段**（`ResponsesWebsocketClient::connect()`）：

1. 通过 `provider.websocket_url_for_path("responses")` 构建 WebSocket URL
2. 合并三层 header：provider headers → extra headers → default headers（优先级递减）
3. 添加认证 header
4. 配置 TLS：检查自定义 CA 证书，构建 rustls connector
5. 使用 `connect_async_tls_with_config()` 建立连接，启用 **per-message deflate** 压缩
6. 从响应头提取元数据：`x-reasoning-included`、`x-models-etag`、`openai-model`、`x-codex-turn-state`
7. 返回 `ResponsesWebsocketConnection` 实例，持有连接流和空闲超时配置

> 源码位置：`codex-rs/codex-api/src/endpoint/responses_websocket.rs:299-326`

**请求阶段**（`ResponsesWebsocketConnection::stream_request()`）：

1. 序列化请求为 JSON，通过 WebSocket 发送文本消息
2. 在后台 tokio task 中循环读取消息，应用空闲超时
3. 每条文本消息先检查是否为包装错误事件（`parse_wrapped_websocket_error_event`）
4. 解析为 `ResponsesStreamEvent`，交由 `process_responses_event()` 转换为 `ResponseEvent`
5. 遇到 `response.completed` 事件时终止循环
6. 连接在多个 turn 之间复用（`connection_reused` 参数标记是否复用）

> 源码位置：`codex-rs/codex-api/src/endpoint/responses_websocket.rs:214-280`

### 3. SSE 事件解析流程

`process_sse()` 是 HTTP 模式的 SSE 消费循环，`process_responses_event()` 是两种模式共享的核心事件映射函数。

**事件类型映射表**：

| SSE 事件类型 | 产出的 ResponseEvent | 说明 |
|---|---|---|
| `response.created` | `Created` | 响应开始 |
| `response.output_item.added` | `OutputItemAdded(ResponseItem)` | 新输出项开始 |
| `response.output_item.done` | `OutputItemDone(ResponseItem)` | 输出项完成 |
| `response.output_text.delta` | `OutputTextDelta(String)` | 文本增量 |
| `response.reasoning_summary_text.delta` | `ReasoningSummaryDelta { delta, summary_index }` | 推理摘要增量 |
| `response.reasoning_text.delta` | `ReasoningContentDelta { delta, content_index }` | 推理内容增量 |
| `response.reasoning_summary_part.added` | `ReasoningSummaryPartAdded { summary_index }` | 推理摘要段落开始 |
| `response.completed` | `Completed { response_id, token_usage }` | 响应完成，携带 token 用量 |
| `response.failed` | → `ApiError`（各类错误） | 响应失败 |
| `response.incomplete` | → `ApiError::Stream` | 响应不完整 |
| `codex.rate_limits` | `RateLimits(snapshot)` | 速率限制快照（仅 WebSocket） |

> 源码位置：`codex-rs/codex-api/src/sse/responses.rs:236-355`

**错误分类**（`response.failed` 事件）：

根据错误 `code` 字段分类为不同的 `ApiError` 变体：

- `context_length_exceeded` → `ContextWindowExceeded`
- `insufficient_quota` → `QuotaExceeded`
- `usage_not_included` → `UsageNotIncluded`
- `invalid_prompt` → `InvalidRequest`
- `server_is_overloaded` / `slow_down` → `ServerOverloaded`
- `rate_limit_exceeded` → `Retryable`（尝试从错误消息中解析 retry-after 时间）
- 其他 → `Retryable`

> 源码位置：`codex-rs/codex-api/src/sse/responses.rs:274-305`

---

## 函数签名与参数说明

### `ResponsesClient::new(transport: T, provider: Provider, auth: A) -> Self`

构造 HTTP 模式客户端。`T` 实现 `HttpTransport` trait，`A` 实现 `AuthProvider` trait。

### `ResponsesClient::stream_request(&self, request: ResponsesApiRequest, options: ResponsesOptions) -> Result<ResponseStream, ApiError>`

发起 HTTP + SSE 流式请求。

- **request**：完整的 Responses API 请求体
- **options**：附加选项（见下方 `ResponsesOptions`）

### `ResponsesWebsocketClient::connect(&self, extra_headers, default_headers, turn_state, telemetry) -> Result<ResponsesWebsocketConnection, ApiError>`

建立 WebSocket 连接。

- **extra_headers**：高优先级自定义头（覆盖 provider headers）
- **default_headers**：低优先级默认头（不覆盖已有值）
- **turn_state**：用于接收服务端返回的 `x-codex-turn-state` 头值（`OnceLock` 语义，仅设置一次）
- **telemetry**：可选的 `WebsocketTelemetry` 观测回调

### `ResponsesWebsocketConnection::stream_request(&self, request: ResponsesWsRequest, connection_reused: bool) -> Result<ResponseStream, ApiError>`

在已有连接上发送请求并获取响应流。

- **connection_reused**：标记此连接是否被复用（用于遥测）

### `spawn_response_stream(stream_response, idle_timeout, telemetry, turn_state) -> ResponseStream`

从 HTTP `StreamResponse` 启动 SSE 解析后台任务，返回 `ResponseStream`。提取响应头中的 rate limit、model etag、server model 和 reasoning included 元数据。

> 源码位置：`codex-rs/codex-api/src/sse/responses.rs:57-106`

### `process_responses_event(event: ResponsesStreamEvent) -> Result<Option<ResponseEvent>, ResponsesEventError>`

核心事件映射函数，将解析后的 SSE 事件转换为 `ResponseEvent`。HTTP 和 WebSocket 两种模式共享此逻辑。

> 源码位置：`codex-rs/codex-api/src/sse/responses.rs:236-355`

---

## 接口/类型定义

### `ResponsesOptions`

```rust
pub struct ResponsesOptions {
    pub conversation_id: Option<String>,    // 会话 ID，用于 x-client-request-id 头
    pub session_source: Option<SessionSource>, // 来源信息，生成 x-openai-subagent 头
    pub extra_headers: HeaderMap,            // 额外 HTTP 头
    pub compression: Compression,            // 请求体压缩方式
    pub turn_state: Option<Arc<OnceLock<String>>>, // 用于捕获 turn state 头
}
```

> 源码位置：`codex-rs/codex-api/src/endpoint/responses.rs:31-38`

### `Compression`

```rust
pub enum Compression {
    None,  // 默认值
    Zstd,  // zstd 压缩
}
```

> 源码位置：`codex-rs/codex-api/src/requests/responses.rs:5-9`

### `ResponsesStreamEvent`

SSE 事件的反序列化结构体，包含 `kind`（事件类型）、`response`、`item`、`delta`、`summary_index`、`content_index` 等字段。提供 `response_model()` 方法从响应头或顶层头中提取服务端实际使用的模型名称。

> 源码位置：`codex-rs/codex-api/src/sse/responses.rs:163-201`

### `ResponseCompletedUsage` → `TokenUsage`

解析 `response.completed` 事件中的 token 用量信息，包含 `input_tokens`、`output_tokens`、`total_tokens` 以及细分的 `cached_tokens` 和 `reasoning_tokens`。

> 源码位置：`codex-rs/codex-api/src/sse/responses.rs:126-161`

---

## WebSocket 连接管理内部机制

### WsStream 泵模型

`WsStream` 封装了底层的 `WebSocketStream`，将读写分离为两个通道：

- **写入**：通过 `mpsc::channel<WsCommand>` 发送命令，pump task 内部执行 `inner.send()`
- **读取**：pump task 将收到的消息转发到 `mpsc::unbounded_channel`，自动回复 Ping 为 Pong
- **生命周期**：`Drop` 时 abort pump task

这种设计允许在持有 `&self`（而非 `&mut self`）的情况下发送消息，支持 `ResponsesWebsocketConnection` 中 stream 被 `Arc<Mutex<Option<WsStream>>>` 包裹后的安全访问模式。

> 源码位置：`codex-rs/codex-api/src/endpoint/responses_websocket.rs:50-153`

### 错误处理：包装错误事件

WebSocket 模式下，服务端错误以 JSON 文本消息形式发送（而非 HTTP 状态码）。`parse_wrapped_websocket_error_event()` 识别 `type: "error"` 的消息并映射为 `ApiError`：

- 连接超时限制（60 分钟）→ `ApiError::Retryable`（可自动重连）
- 带 HTTP 状态码的错误 → `ApiError::Transport(TransportError::Http { ... })`
- 无状态码的错误 → 忽略（返回 `None`）

> 源码位置：`codex-rs/codex-api/src/endpoint/responses_websocket.rs:464-507`

### Header 合并优先级

`merge_request_headers()` 实现三层 header 合并：

1. **Provider headers**（基础层）
2. **Extra headers**（覆盖 provider headers 中的同名 key）
3. **Default headers**（仅在最终结果中不存在该 key 时才插入）

> 源码位置：`codex-rs/codex-api/src/endpoint/responses_websocket.rs:328-341`

---

## 请求体辅助函数

### `attach_item_ids(payload_json: &mut Value, original_items: &[ResponseItem])`

专为 **Azure Responses 端点** 设计。Azure 要求输入项携带 `id` 字段，但标准序列化可能不包含此字段。该函数遍历 JSON payload 的 `input` 数组，根据原始 `ResponseItem` 枚举中的 `id` 字段值，将非空 ID 插入到对应的 JSON 对象中。

支持的带 ID 项类型：`Reasoning`、`Message`、`WebSearchCall`、`FunctionCall`、`ToolSearchCall`、`LocalShellCall`、`CustomToolCall`。

> 源码位置：`codex-rs/codex-api/src/requests/responses.rs:11-37`

---

## 边界 Case 与注意事项

- **空闲超时**：HTTP SSE 和 WebSocket 模式都使用 `provider.stream_idle_timeout` 作为空闲超时。超时后会产生 `ApiError::Stream("idle timeout...")` 错误，而非无限等待
- **WebSocket 连接限制**：服务端在连接持续 60 分钟后会发送 `websocket_connection_limit_reached` 错误，客户端将其映射为 `ApiError::Retryable`，上层可据此重建连接
- **连接失败清理**：当 WebSocket 流式处理遇到终端错误时，会立即 `take()` 并丢弃底层流（避免在 graceful close 握手中阻塞），然后才发送错误到调用方
- **自定义 CA 证书**：WebSocket 连接使用 `maybe_build_rustls_client_config_with_custom_ca()` 保持与 HTTP 传输层一致的 TLS 策略，避免 native-roots-only 的回退行为
- **per-message deflate**：WebSocket 配置默认启用 `DeflateConfig::default()`，减少传输数据量
- **SSE 解析容错**：无法解析的 SSE 事件会被 `debug!` 记录后跳过，不会中断流
- **rate_limit_exceeded 重试延迟**：通过正则解析错误消息中的 "try again in X s/ms/seconds" 文本提取重试延迟时间
- **response.failed 的延迟错误传播**（仅 HTTP SSE）：`response.failed` 错误被暂存到 `response_error`，而非立即发送——只有在流关闭时才通过 channel 传递，这与 WebSocket 模式（立即 `return Err`）不同