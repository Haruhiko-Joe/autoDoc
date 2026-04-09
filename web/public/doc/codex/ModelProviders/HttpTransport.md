# HTTP 传输层（HttpTransport）

## 概述与职责

HttpTransport 是 Codex 系统中 **ModelProviders** 层的底层 HTTP 传输组件，由 `codex-client` crate 实现。它为上层的 LLM API 客户端提供统一的 HTTP 请求发送能力，包括：

- 定义 `HttpTransport` trait 抽象，解耦传输实现与业务逻辑
- 基于 reqwest 的 `ReqwestTransport` 实现，支持普通请求和流式响应
- Zstd 请求体压缩
- 指数退避（exponential backoff）重试策略
- SSE（Server-Sent Events）流消费
- OpenTelemetry 分布式追踪注入
- 企业级自定义 CA 证书支持

在整体架构中，HttpTransport 位于 **ModelProviders** 节点内部，是所有对外 HTTP API 调用（如 OpenAI Responses API）的基础网络层。同级模块包括 WebSocket 传输、Realtime API 客户端、本地模型提供者（Ollama/LM Studio）等。

## 关键流程

### 请求构建与发送流程

1. 调用方构造 `Request` 结构体，指定 HTTP 方法、URL、请求头、JSON body、压缩方式和超时时间
2. `ReqwestTransport::build()` 将 `Request` 转换为 `CodexRequestBuilder`：
   - 如果指定了 `RequestCompression::Zstd`，先将 body 序列化为 JSON，然后用 zstd level 3 压缩，设置 `Content-Encoding: zstd` 头（`src/transport.rs:72-103`）
   - 如果 body 已设置了 `Content-Encoding` 头但又请求了压缩，返回 `TransportError::Build` 错误
3. `CodexRequestBuilder::send()` 在发送前自动注入 OpenTelemetry trace headers（`src/default_client.rs:113-141`）
4. 对于 `execute()` 方法：等待完整响应体，非 2xx 状态码包装为 `TransportError::Http` 返回
5. 对于 `stream()` 方法：返回 `StreamResponse`，其 `bytes` 字段是一个 `BoxStream<Result<Bytes, TransportError>>`，供调用方流式消费

### 重试流程

`run_with_retry()` 函数接受 `RetryPolicy` 和一个请求工厂闭包（`src/retry.rs:49-73`）：

1. 循环执行最多 `max_attempts + 1` 次
2. 每次调用 `make_req()` 生成新的 `Request`（保证每次重试使用新请求）
3. 执行操作，成功则立即返回
4. 失败时由 `RetryOn::should_retry()` 判断是否可重试：
   - `retry_429`：HTTP 429（限流）可重试
   - `retry_5xx`：5xx 服务端错误可重试
   - `retry_transport`：超时和网络错误可重试
   - 其他错误（如 `Build`、`RetryLimit`）不可重试
5. 可重试时调用 `backoff()` 计算等待时间：以 `base_delay` 为基础，指数增长（`2^(attempt-1)`），并加 ±10% 的随机抖动（jitter）（`src/retry.rs:38-47`）
6. 超出最大尝试次数返回 `TransportError::RetryLimit`

### SSE 流消费流程

`sse_stream()` 函数在一个 tokio 任务中消费字节流（`src/sse.rs:12-48`）：

1. 将 `ByteStream` 通过 `eventsource-stream` crate 转换为 SSE 事件流
2. 在循环中带 `idle_timeout` 超时等待下一个事件
3. 收到有效事件时，通过 `mpsc::Sender` 发送 `Ok(ev.data)` 给调用方
4. 遇到流错误发送 `Err(StreamError::Stream(...))`，流关闭发送 "stream closed before completion" 错误，超时发送 `Err(StreamError::Timeout)`
5. 任何错误或流结束后任务退出

### 自定义 CA 证书加载流程

用于企业代理/网关拦截 TLS 流量的场景（`src/custom_ca.rs`）：

1. 检查环境变量优先级：`CODEX_CA_CERTIFICATE` > `SSL_CERT_FILE`，空字符串视为未设置
2. 如果无自定义 CA 配置，使用系统默认根证书
3. 读取 PEM 文件内容，处理 OpenSSL 的 `TRUSTED CERTIFICATE` 标签兼容性：将其替换为标准 `CERTIFICATE` 标签（`src/custom_ca.rs:570-585`）
4. 遍历 PEM 段，提取 `Certificate` 类型的段（忽略 CRL 段）
5. 对于 `TRUSTED CERTIFICATE` 来源的 DER 数据，通过 `first_der_item()` 裁剪掉尾部的 OpenSSL X509_AUX 信任元数据（`src/custom_ca.rs:628-630`）
6. 将每个证书注册到 reqwest 的 `ClientBuilder` 或 rustls 的 `RootCertStore`

## 函数签名与参数说明

### `HttpTransport` trait

```rust
#[async_trait]
pub trait HttpTransport: Send + Sync {
    async fn execute(&self, req: Request) -> Result<Response, TransportError>;
    async fn stream(&self, req: Request) -> Result<StreamResponse, TransportError>;
}
```

- **`execute`**：发送请求并等待完整响应。非 2xx 状态码返回错误
- **`stream`**：发送请求并返回流式响应。非 2xx 状态码返回错误，成功时返回字节流

> 源码位置：`src/transport.rs:26-30`

### `ReqwestTransport::new(client: reqwest::Client) -> Self`

用已有的 `reqwest::Client` 实例构造传输层。调用方负责配置 client（如超时、TLS 等）。

> 源码位置：`src/transport.rs:38-42`

### `run_with_retry<T, F, Fut>(policy, make_req, op) -> Result<T, TransportError>`

通用重试执行器。

- **`policy: RetryPolicy`**：重试策略配置
- **`make_req: impl FnMut() -> Request`**：每次尝试生成新请求的工厂闭包
- **`op: F`**：接受 `(Request, attempt_number)` 的异步操作

> 源码位置：`src/retry.rs:49-73`

### `backoff(base: Duration, attempt: u64) -> Duration`

计算指数退避等待时间。attempt=0 返回 base，之后按 `base * 2^(attempt-1) * jitter(0.9..1.1)` 增长。

> 源码位置：`src/retry.rs:38-47`

### `sse_stream(stream, idle_timeout, tx)`

将字节流转换为 SSE 事件流，通过 mpsc channel 发送给调用方。

- **`stream: ByteStream`**：原始字节流
- **`idle_timeout: Duration`**：两个事件之间的最大等待时间
- **`tx: mpsc::Sender<Result<String, StreamError>>`**：事件输出通道

> 源码位置：`src/sse.rs:12-48`

### `build_reqwest_client_with_custom_ca(builder: reqwest::ClientBuilder) -> Result<reqwest::Client, BuildCustomCaTransportError>`

构建支持自定义 CA 证书的 reqwest 客户端。调用方提供基础 builder 配置，此函数叠加 CA 处理后构建。

> 源码位置：`src/custom_ca.rs:179-183`

### `maybe_build_rustls_client_config_with_custom_ca() -> Result<Option<Arc<ClientConfig>>, BuildCustomCaTransportError>`

WebSocket 侧的 CA 支持入口。有自定义 CA 时返回 `Some(config)`（以平台原生根证书为基础加载自定义 CA），无自定义 CA 时返回 `None`。

> 源码位置：`src/custom_ca.rs:196-199`

## 接口/类型定义

### `Request`

| 字段 | 类型 | 说明 |
|------|------|------|
| method | `Method` | HTTP 方法 |
| url | `String` | 请求 URL |
| headers | `HeaderMap` | 请求头 |
| body | `Option<Value>` | JSON body（可选） |
| compression | `RequestCompression` | 压缩方式，默认 `None` |
| timeout | `Option<Duration>` | 请求超时（可选） |

提供 `with_json()` 和 `with_compression()` 构建器方法。

> 源码位置：`src/request.rs:15-46`

### `Response`

| 字段 | 类型 | 说明 |
|------|------|------|
| status | `StatusCode` | HTTP 状态码 |
| headers | `HeaderMap` | 响应头 |
| body | `Bytes` | 响应体字节 |

> 源码位置：`src/request.rs:48-53`

### `StreamResponse`

| 字段 | 类型 | 说明 |
|------|------|------|
| status | `StatusCode` | HTTP 状态码 |
| headers | `HeaderMap` | 响应头 |
| bytes | `ByteStream` | `BoxStream<'static, Result<Bytes, TransportError>>` |

> 源码位置：`src/transport.rs:20-24`

### `RequestCompression`

```rust
pub enum RequestCompression {
    None,  // 默认值
    Zstd,
}
```

### `RetryPolicy`

| 字段 | 类型 | 说明 |
|------|------|------|
| max_attempts | `u64` | 最大重试次数（不含首次） |
| base_delay | `Duration` | 退避基准延迟 |
| retry_on | `RetryOn` | 可重试条件配置 |

### `RetryOn`

| 字段 | 类型 | 说明 |
|------|------|------|
| retry_429 | `bool` | 是否重试 429 限流 |
| retry_5xx | `bool` | 是否重试 5xx 错误 |
| retry_transport | `bool` | 是否重试超时/网络错误 |

### `TransportError`

```rust
pub enum TransportError {
    Http { status, url, headers, body },  // 非 2xx HTTP 响应
    RetryLimit,                           // 重试次数耗尽
    Timeout,                              // 请求超时
    Network(String),                      // 网络错误
    Build(String),                        // 请求构建错误（如压缩冲突）
}
```

### `StreamError`

```rust
pub enum StreamError {
    Stream(String),  // 流处理错误
    Timeout,         // 空闲超时
}
```

### `BuildCustomCaTransportError`

详细的 CA 证书错误类型，包含 6 个变体，每个都携带环境变量名、文件路径和具体原因，并附带用户友好的修复提示。可通过 `From` 转换为 `io::Error`。

> 源码位置：`src/custom_ca.rs:73-145`

### `RequestTelemetry` trait

```rust
pub trait RequestTelemetry: Send + Sync {
    fn on_request(&self, attempt: u64, status: Option<StatusCode>,
                  error: Option<&TransportError>, duration: Duration);
}
```

供上层实现的遥测回调，在每次请求完成后调用，报告尝试次数、状态码、错误和耗时。

> 源码位置：`src/telemetry.rs:6-14`

## 配置项

- **`CODEX_CA_CERTIFICATE`**：环境变量，指向自定义 CA PEM 文件路径。优先级最高
- **`SSL_CERT_FILE`**：环境变量，通用 SSL 证书文件路径。作为 `CODEX_CA_CERTIFICATE` 的后备
- 两个变量设为空字符串等同于未设置

## `custom_ca_probe` 诊断工具

`src/bin/custom_ca_probe.rs` 是一个独立的诊断二进制，用于在集成测试中以独立进程验证自定义 CA 行为。它调用 `build_reqwest_client_for_subprocess_tests()` 尝试构建客户端，成功输出 "ok"，失败输出错误信息并以退出码 1 退出。测试文件 `tests/ca_env.rs` 通过启动此进程、设置不同的环境变量来验证 CA 优先级、多证书 bundle 加载和错误提示。

## 边界 Case 与注意事项

- **压缩与 Content-Encoding 冲突**：如果请求已设置 `Content-Encoding` 头但又指定了 `RequestCompression::Zstd`，会返回 `TransportError::Build` 错误，而非静默覆盖
- **TRUSTED CERTIFICATE 兼容**：OpenSSL `TRUSTED CERTIFICATE` PEM 标签会被自动规范化为标准 `CERTIFICATE`，尾部的 X509_AUX 信任元数据通过 DER 长度解析被裁剪掉（`src/custom_ca.rs:628-680`）
- **CRL 处理**：PEM bundle 中的 `X509 CRL` 段会被静默忽略，但如果 CRL 格式畸形导致解析器报错，整个加载仍会失败
- **SSE 流异常关闭**：如果服务端在未发送完成信号前关闭流，`sse_stream` 会发送 "stream closed before completion" 错误而非静默结束
- **macOS seatbelt 环境**：在 seatbelt 沙箱下，`reqwest::Client::builder().build()` 可能因系统代理探测 panic，测试专用路径通过 `no_proxy()` 禁用代理自动检测来规避此问题
- **Trace header 注入**：每个请求自动注入 OpenTelemetry W3C TraceContext headers，使用当前 tracing span 的上下文。这对分布式追踪至关重要，但意味着调用方必须在正确的 span 内发起请求