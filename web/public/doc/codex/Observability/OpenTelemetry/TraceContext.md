# TraceContext — W3C 分布式追踪上下文传播

## 概述与职责

`trace_context` 模块是 **Observability → OpenTelemetry** 层的底层工具模块，负责 **W3C Trace Context** 标准（`traceparent` / `tracestate` 头）与 OpenTelemetry SDK 内部 `Context` 之间的双向转换。它使 Codex 的各组件能够在进程边界（如 HTTP 请求、子进程生成、WebSocket 会话）之间正确地传播分布式追踪链路。

在系统架构中，该模块属于 `codex-otel` crate，与同级的 Analytics（事件埋点）和 Feedback（反馈收集）模块并列，共同组成 Codex 的可观测性基础设施。Core、AppServer 等上层模块通过调用 Observability 层来发射 span 和传播追踪上下文。

**核心能力**：
- 将 OpenTelemetry span 上下文**注入**为 W3C `traceparent`/`tracestate` 头
- 从 W3C 头**提取**并还原 OpenTelemetry `Context`
- 从环境变量 `TRACEPARENT` / `TRACESTATE` 加载父追踪上下文（用于子进程继承追踪链路）
- 为当前 span 设置远程父上下文
- 获取当前 span 的 trace ID（hex 字符串）

> 源码位置：`codex-rs/otel/src/trace_context.rs`

## 关键流程

### 1. Inject：span → W3C 头

当需要将当前追踪上下文传播到外部系统时（如发起 HTTP 请求、生成子进程），调用方使用 `span_w3c_trace_context()` 或 `current_span_w3c_trace_context()`：

1. 获取 `tracing::Span` 的 OpenTelemetry `Context`（`codex-rs/otel/src/trace_context.rs:24`）
2. 校验 span context 是否有效，无效则返回 `None`（`:25-27`）
3. 使用 `TraceContextPropagator::inject_context()` 将上下文序列化为 `HashMap<String, String>`（`:30`）
4. 从 map 中取出 `traceparent` 和 `tracestate`，封装为 `W3cTraceContext` 协议类型返回（`:32-35`）

### 2. Extract：W3C 头 → Context

当从外部接收到追踪头时（如收到带 `traceparent` 的请求），通过 `context_from_w3c_trace_context()` 或底层的 `context_from_trace_headers()` 还原：

1. 检查 `traceparent` 是否存在，缺失则返回 `None`（`:76`）
2. 将头值组装为 `HashMap`（`:77-81`）
3. 使用 `TraceContextPropagator::extract()` 解析为 `Context`（`:83`）
4. 校验解析出的 span context 是否有效，无效则返回 `None`（`:84-86`）

### 3. 环境变量继承追踪链路

子进程启动时可通过环境变量继承父进程的追踪上下文。`traceparent_context_from_env()` 实现了这一逻辑：

1. 使用 `OnceLock` 确保只加载一次（`:67-70`）
2. 读取 `TRACEPARENT` 环境变量，缺失则返回 `None`（`:91`）
3. 可选读取 `TRACESTATE` 环境变量（`:92`）
4. 调用 `context_from_trace_headers()` 解析，成功时记录 debug 日志，失败时记录 warn 日志（`:94-103`）

### 4. 设置父 span 上下文

`set_parent_from_w3c_trace_context()` 将提取到的远程上下文关联到当前 span，建立父子关系：

1. 通过 `context_from_w3c_trace_context()` 解析 W3C 头（`:54`）
2. 调用 `span.set_parent(context)` 设置父上下文（`:63`）
3. 返回 `bool` 指示是否成功设置（`:56-58`）

## 函数签名与参数说明

### `current_span_w3c_trace_context() -> Option<W3cTraceContext>`

获取当前 `tracing::Span` 的 W3C 追踪上下文。若当前无活跃 span 或 span 无效则返回 `None`。

### `span_w3c_trace_context(span: &Span) -> Option<W3cTraceContext>`

将指定 `Span` 的追踪上下文注入为 W3C 协议类型。

- **span**：要导出上下文的 tracing span

### `current_span_trace_id() -> Option<String>`

返回当前 span 的 trace ID，格式为 32 字符的十六进制字符串。无有效 span 时返回 `None`。

### `context_from_w3c_trace_context(trace: &W3cTraceContext) -> Option<Context>`

从 `W3cTraceContext` 协议类型还原 OpenTelemetry `Context`。

- **trace**：包含可选 `traceparent` 和 `tracestate` 字段的结构体

### `set_parent_from_w3c_trace_context(span: &Span, trace: &W3cTraceContext) -> bool`

解析 W3C 头并设置为指定 span 的父上下文。返回 `true` 表示成功设置，`false` 表示头无效或缺失。

- **span**：要设置父上下文的 span
- **trace**：W3C 追踪上下文

### `set_parent_from_context(span: &Span, context: Context)`

直接用已有的 `Context` 设置 span 的父上下文。

### `traceparent_context_from_env() -> Option<Context>`

从 `TRACEPARENT`（和可选的 `TRACESTATE`）环境变量加载追踪上下文。结果通过 `OnceLock` 缓存，整个进程生命周期只读取一次。

### `context_from_trace_headers(traceparent: Option<&str>, tracestate: Option<&str>) -> Option<Context>` *(crate 内部)*

底层提取函数，将原始头字符串解析为 `Context`。`traceparent` 缺失时返回 `None`。

## 接口/类型定义

### `W3cTraceContext`（来自 `codex_protocol::protocol`）

模块依赖的协议类型，包含两个可选字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `traceparent` | `Option<String>` | W3C `traceparent` 头，格式：`{version}-{trace-id}-{parent-id}-{trace-flags}` |
| `tracestate` | `Option<String>` | W3C `tracestate` 头，供应商特定的键值对 |

## 配置项与默认值

| 环境变量 | 用途 | 必填 | 说明 |
|----------|------|------|------|
| `TRACEPARENT` | 父进程的 W3C traceparent 头 | 否 | 设置后子进程自动继承追踪链路 |
| `TRACESTATE` | 父进程的 W3C tracestate 头 | 否 | 仅在 `TRACEPARENT` 存在时有意义 |

## 边界 Case 与注意事项

- **无效 traceparent 不会导致错误**：所有解析函数在输入无效时返回 `None`，不会 panic。环境变量场景下会输出 `warn` 级别日志提示无效值。
- **OnceLock 缓存**：`traceparent_context_from_env()` 的结果在进程生命周期内缓存，环境变量变更后不会重新读取。这是有意设计——追踪上下文在进程启动时确定，不应中途变化。
- **远程 span 标记**：通过 `extract()` 还原的 span context 会被标记为 `is_remote() = true`，OpenTelemetry SDK 据此决定是否创建新的本地根 span。
- **`set_parent` 返回值被忽略**：`set_parent_from_context()` 中 `span.set_parent()` 的返回值被 `let _ =` 丢弃（`:63`），这是因为 `tracing_opentelemetry` 的该方法返回值无实际用途。