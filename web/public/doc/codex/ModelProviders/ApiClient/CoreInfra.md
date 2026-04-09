# CoreInfra — 基础类型与共享基础设施

## 概述与职责

CoreInfra 是 `codex-api` crate 的基础层，为所有端点客户端（Responses、Realtime、Models、Compact、Memories 等）提供**统一的类型定义、认证注入、请求构建、错误处理和遥测采集**能力。它位于 **ModelProviders → ApiClient** 层级下，是 ApiClient 内各端点实现的公共底座。

在整体架构中，ModelProviders 负责与 LLM 提供商通信，ApiClient 则是其高层抽象。CoreInfra 不直接面向终端用户，而是被同 crate 内的 `ResponsesClient`、`RealtimeWebsocketClient`、`ModelsClient` 等端点客户端组合使用。同级兄弟模块（如 HttpTransport、ProviderRegistry）分别提供底层传输和提供商配置注册能力。

---

## 模块结构

| 文件 | 职责 |
|------|------|
| `lib.rs` | crate 入口，re-export 所有公共类型 |
| `provider.rs` | `Provider` 结构体——端点配置与请求构建 |
| `auth.rs` | `AuthProvider` trait——认证头注入 |
| `endpoint/session.rs` | `EndpointSession` 泛型包装——组合传输+配置+认证 |
| `error.rs` | `ApiError` 错误枚举 |
| `common.rs` | 领域类型（请求/响应/流/推理控制等） |
| `requests/headers.rs` | 请求头构建辅助函数 |
| `telemetry.rs` | 遥测 trait 与重试遥测包装器 |
| `endpoint/mod.rs` | 端点子模块声明 |
| `requests/mod.rs` | 请求子模块声明 |

---

## 关键流程

### 请求全生命周期 Walkthrough

一个典型的 API 请求从端点客户端发起，经过 CoreInfra 的完整路径如下：

1. **端点客户端**（如 `ResponsesClient`）持有一个 `EndpointSession<T, A>`，调用 `execute()` 或 `stream_with()` 方法。

2. **请求构建**：`EndpointSession::make_request()` 被调用（`endpoint/session.rs:46-59`）：
   - 调用 `Provider::build_request()` 生成基础 `Request`（含 base URL 拼接、默认 headers）
   - 合并端点级的 `extra_headers`
   - 设置 JSON body
   - 调用 `add_auth_headers()` 注入 `Authorization: Bearer <token>` 和可选的 `ChatGPT-Account-ID` 头

3. **带遥测的重试执行**：`run_with_request_telemetry()` 被调用（`telemetry.rs:68-98`）：
   - 将 `Provider::retry` 配置转换为 `RetryPolicy`
   - 在 `run_with_retry` 循环中，每次尝试记录耗时和状态码，通过 `RequestTelemetry::on_request()` 回调上报
   - 对于普通请求调用 `transport.execute()`，对于流式请求调用 `transport.stream()`

4. **结果返回**：`Response` 或 `StreamResponse` 沿调用链返回给端点客户端进行进一步解析。

### Azure 端点检测

`Provider::is_azure_responses_endpoint()` 和独立函数 `is_azure_responses_wire_base_url()` 通过检查 provider name（不区分大小写匹配 "azure"）或 base URL 中的特征子串（如 `openai.azure.`、`cognitiveservices.azure.`、`aoai.azure.` 等）来判断是否为 Azure 部署（`provider.rs:106-128`）。这影响下游端点客户端的协议行为差异处理。

---

## 核心类型详解

### `Provider` — 端点配置

```rust
// provider.rs:43-50
pub struct Provider {
    pub name: String,
    pub base_url: String,
    pub query_params: Option<HashMap<String, String>>,
    pub headers: HeaderMap,
    pub retry: RetryConfig,
    pub stream_idle_timeout: Duration,
}
```

| 字段 | 说明 |
|------|------|
| `name` | 提供商名称，也用于 Azure 检测 |
| `base_url` | API 基础 URL |
| `query_params` | 附加到每个请求 URL 的查询参数（如 `api-version`） |
| `headers` | 每个请求携带的默认头 |
| `retry` | 重试策略配置 |
| `stream_idle_timeout` | 流式响应的空闲超时时长 |

关键方法：

- **`url_for_path(path)`**：拼接 base URL 和路径，附加 query params（`provider.rs:53-75`）
- **`build_request(method, path)`**：构建含默认 headers 的 `Request` 对象（`provider.rs:77-86`）
- **`websocket_url_for_path(path)`**：将 HTTP URL 转为 WebSocket URL（`http→ws`，`https→wss`）（`provider.rs:92-103`）

### `RetryConfig` — 重试配置

```rust
// provider.rs:16-22
pub struct RetryConfig {
    pub max_attempts: u64,
    pub base_delay: Duration,
    pub retry_429: bool,
    pub retry_5xx: bool,
    pub retry_transport: bool,
}
```

通过 `to_policy()` 转换为底层 `codex-client` 的 `RetryPolicy`，控制对 429（限流）、5xx（服务器错误）和传输错误的重试行为。

### `AuthProvider` trait — 认证抽象

```rust
// auth.rs:10-15
pub trait AuthProvider: Send + Sync {
    fn bearer_token(&self) -> Option<String>;
    fn account_id(&self) -> Option<String> { None }
}
```

设计为轻量、非阻塞的同步接口。任何异步 token 刷新逻辑应在更高层完成。`add_auth_headers()` 辅助函数（`auth.rs:30-33`）将 trait 的输出注入到 `Request` 的 headers 中：

- `Authorization: Bearer <token>`
- `ChatGPT-Account-ID: <account_id>`（可选）

### `EndpointSession<T, A>` — 泛型会话包装

```rust
// endpoint/session.rs:17-22
pub(crate) struct EndpointSession<T: HttpTransport, A: AuthProvider> {
    transport: T,
    provider: Provider,
    auth: A,
    request_telemetry: Option<Arc<dyn RequestTelemetry>>,
}
```

这是所有端点客户端的核心组合体，将传输层（`HttpTransport`）、配置（`Provider`）和认证（`AuthProvider`）绑定在一起。对外提供三个请求方法：

- **`execute()`**（`session.rs:61-70`）：发起普通 HTTP 请求，内部委托给 `execute_with`
- **`execute_with()`**（`session.rs:78-104`）：支持通过 `configure` 闭包在发送前自定义 `Request`，带 `tracing::instrument` 采集 span
- **`stream_with()`**（`session.rs:112-138`）：流式 HTTP 请求，同样带 instrument 和重试遥测

三者都经过 `run_with_request_telemetry()` 包装，在每次重试尝试后上报状态码和耗时。

### `ApiError` — 错误枚举

```rust
// error.rs:8-32
pub enum ApiError {
    Transport(TransportError),
    Api { status: StatusCode, message: String },
    Stream(String),
    ContextWindowExceeded,
    QuotaExceeded,
    UsageNotIncluded,
    Retryable { message: String, delay: Option<Duration> },
    RateLimit(String),
    InvalidRequest { message: String },
    ServerOverloaded,
}
```

覆盖了从传输层错误到业务语义错误（上下文窗口超限、配额用尽、服务器过载）的完整错误分类。`Retryable` 变体携带可选的延迟时间提示，供上层决定退避策略。

---

## 领域类型（`common.rs`）

### `ResponsesApiRequest`

Responses API 的标准 HTTP 请求体（`common.rs:153-171`），包含模型、指令、输入、工具、推理配置、流式开关等所有字段。可通过 `From` trait 转换为 `ResponseCreateWsRequest` 以用于 WebSocket 通道。

### `ResponseCreateWsRequest`

WebSocket 变体的请求体（`common.rs:196-220`），额外支持 `previous_response_id`（续接先前响应）、`generate` 标志和 `client_metadata`（用于注入 W3C trace context）。

### `ResponseEvent`

从 API 流中解析出的事件枚举（`common.rs:65-95`）：

| 变体 | 含义 |
|------|------|
| `Created` | 响应已创建 |
| `OutputItemDone` / `OutputItemAdded` | 输出项完成/新增 |
| `ServerModel(String)` | 服务端实际使用的模型（可能因安全路由与请求不同） |
| `ServerReasoningIncluded(bool)` | 服务端是否已计入历史推理 token |
| `Completed { response_id, token_usage }` | 响应完成，携带 token 用量 |
| `OutputTextDelta` / `ReasoningSummaryDelta` / `ReasoningContentDelta` | 流式文本增量 |
| `RateLimits(RateLimitSnapshot)` | 限流快照 |
| `ModelsEtag(String)` | 模型列表 ETag |

### `ResponseStream`

对 `mpsc::Receiver<Result<ResponseEvent, ApiError>>` 的封装，实现了 `futures::Stream` trait（`common.rs:271-281`），供调用方以标准异步流的方式消费事件。

### `Reasoning` 与 `TextControls`

- **`Reasoning`**（`common.rs:97-103`）：控制推理 effort 和 summary 配置
- **`TextControls`**（`common.rs:126-132`）：组合 verbosity（Low/Medium/High）和可选的 JSON Schema 输出格式控制
- **`create_text_param_for_request()`**（`common.rs:252-269`）：根据 verbosity 和 output_schema 构造 `TextControls`

### `CompactionInput`

压缩端点的输入载荷（`common.rs:23-34`），包含模型、待压缩的对话输入、指令、工具列表和推理/文本控制选项。

### `MemorySummarizeInput` / `MemorySummarizeOutput`

记忆摘要端点的输入输出类型（`common.rs:37-63`），用于将 raw memory traces 通过 LLM 压缩为结构化摘要。

---

## 请求头构建（`requests/headers.rs`）

### `build_conversation_headers(conversation_id)`

构建会话级 HTTP headers（`headers.rs:5-11`）。当提供 `conversation_id` 时，插入 `session_id` 头用于服务端会话追踪。此函数是 crate 的公共 re-export。

### `subagent_header(source)`

根据 `SessionSource` 生成子代理标识字符串（`headers.rs:13-28`）。映射规则：

| `SubAgentSource` 变体 | 输出 |
|------------------------|------|
| `Review` | `"review"` |
| `Compact` | `"compact"` |
| `MemoryConsolidation` | `"memory_consolidation"` |
| `ThreadSpawn` | `"collab_spawn"` |
| `Other(label)` | 原始 label |

### `insert_header(headers, name, value)`

安全的头部插入辅助函数（`headers.rs:30-37`），自动处理解析失败（静默忽略无效的 header name/value），避免 panic。

---

## 遥测（`telemetry.rs`）

### `SseTelemetry` trait

SSE 流的遥测接口（`telemetry.rs:18-32`），提供 `on_sse_poll()` 回调，在每次 SSE 事件轮询后上报结果和耗时。

### `WebsocketTelemetry` trait

WebSocket 传输的遥测接口（`telemetry.rs:35-43`），提供：
- `on_ws_request()`：请求级遥测（耗时、错误、是否复用连接）
- `on_ws_event()`：消息级遥测（每条 WebSocket 消息的结果和耗时）

### `run_with_request_telemetry()`

重试遥测包装器（`telemetry.rs:68-98`），核心逻辑：

1. 接收 `RetryPolicy`、可选的 `RequestTelemetry` 回调、请求工厂闭包和发送闭包
2. 在底层 `run_with_retry` 的每次尝试中，记录开始时间
3. 请求完成后，提取 HTTP 状态码（成功时从 `Response`/`StreamResponse`，失败时从 `TransportError`）
4. 通过 `RequestTelemetry::on_request(attempt, status, error, duration)` 回调上报

`WithStatus` 内部 trait 统一了 `Response` 和 `StreamResponse` 的状态码提取接口。

---

## 边界 Case 与注意事项

- **`AuthProvider` 必须是非阻塞的**：trait 方法是同步的，异步 token 刷新必须在调用前完成。
- **Azure 检测是尽力而为**：基于 URL 子串匹配，自定义代理域名（如 `azurewebsites.net`）不会被识别为 Azure 端点。
- **`insert_header` 静默失败**：无效的 header name 或 value 不会报错，依赖调用方保证输入合理性。
- **`ResponseStream` 是单消费者**：底层基于 `mpsc::Receiver`，只能被一个消费者 poll。
- **`query_params` 拼接不做 URL 编码**：`url_for_path()` 直接拼接键值对，依赖调用方确保参数安全。