# OtelProvider — OTel SDK 引导与配置层

## 概述与职责

OtelProvider 是 Codex 可观测性体系中 **OpenTelemetry** 子系统的核心引导组件，位于 `Observability > OpenTelemetry` 层级下。它负责将三大遥测信号——**分布式追踪（Tracing）**、**结构化日志导出（Logs）** 和 **指标（Metrics）**——统一初始化并注入 `tracing_subscriber` 生态。

同级兄弟模块 Analytics 和 Feedback 分别处理业务分析事件与用户反馈上报，而本模块专注于底层 OTLP 传输通道的配置与管理。

本模块由四个源文件组成：

| 文件 | 职责 |
|------|------|
| `provider.rs` | `OtelProvider` 结构体：统一构建 logger / tracer / metrics，提供 tracing layer 和生命周期管理 |
| `config.rs` | `OtelSettings`、`OtelExporter` 等配置类型，以及 Statsig 默认导出器解析 |
| `otlp.rs` | OTLP 传输层工具函数：gRPC/HTTP 客户端构建、TLS/mTLS 配置、超时解析 |
| `targets.rs` | 基于 tracing target 前缀的事件路由——区分 log-only 与 trace-safe 事件 |

---

## 关键流程

### 1. OtelProvider 初始化流程（`OtelProvider::from`）

入口是 `OtelProvider::from(settings: &OtelSettings)`（`provider.rs:67-120`），完整步骤如下：

1. **判断各信号是否启用**：分别检查 `settings.exporter`（日志）、`settings.trace_exporter`（追踪）、`settings.metrics_exporter`（指标）是否为 `OtelExporter::None`
2. **构建 MetricsClient**：若指标导出器不为 None，创建 `MetricsClient` 并调用 `install_global()` 安装为全局实例（`provider.rs:72-89`）
3. **短路返回**：若三个信号均未启用，返回 `Ok(None)`
4. **构建 Resource**：分别为 Logs 和 Traces 创建 OpenTelemetry `Resource`，附带 service_name、service_version、env、host.name 等属性（注意 `host.name` 仅附加到 Logs 资源）
5. **构建 Logger**：调用 `build_logger()` 创建 `SdkLoggerProvider`
6. **构建 TracerProvider**：调用 `build_tracer_provider()` 创建 `SdkTracerProvider`，并从中获取 `Tracer` 实例
7. **注册全局 Provider**：将 TracerProvider 设置为 OpenTelemetry 全局 provider，同时安装 W3C `TraceContextPropagator` 用于跨服务追踪传播

### 2. Exporter 构建流程

`build_logger`（`provider.rs:219-286`）和 `build_tracer_provider`（`provider.rs:288-383`）共享相同的模式：

1. 调用 `resolve_exporter()` 将 `Statsig` 变体解析为具体的 OTLP HTTP 配置
2. 根据 `OtelExporter` 变体选择传输方式：
   - **OtlpGrpc**：使用 tonic 构建 gRPC 导出器，配置 TLS（含可选 mTLS）和自定义 headers
   - **OtlpHttp**：使用 reqwest 构建 HTTP 导出器，支持 Binary（protobuf）和 JSON 两种协议
3. 将导出器包装进 `BatchSpanProcessor` 或批量日志处理器

**特殊分支**：HTTP trace 导出器在多线程 Tokio 运行时下使用 `TokioBatchSpanProcessor`（`provider.rs:328-353`），以利用 async 批处理；单线程运行时回退到阻塞客户端。

### 3. 事件路由（Target-based Filtering）

OtelProvider 通过 tracing target 前缀实现日志与追踪的**事件路由分流**：

```
codex_otel.*（排除 trace_safe）→ 仅导出为 Log
codex_otel.trace_safe.*          → 导出为 Trace span/event
所有 span                         → 导出为 Trace
```

具体实现在 `targets.rs`：

- `is_log_export_target(target)`：匹配以 `codex_otel` 开头但**不以** `codex_otel.trace_safe` 开头的 target（`targets.rs:5-7`）
- `is_trace_safe_target(target)`：匹配以 `codex_otel.trace_safe` 开头的 target（`targets.rs:9-11`）

这两个函数被 `OtelProvider` 的 filter 方法引用：

- `log_export_filter`（`provider.rs:150-152`）：用于 logger layer，只放行 log-only 事件
- `trace_export_filter`（`provider.rs:154-156`）：用于 tracing layer，放行所有 span **加上** trace_safe 事件

设计意图：某些包含敏感信息或高频的事件只应写入日志通道（如网络代理事件 `codex_otel.network_proxy`），而不应出现在分布式追踪中。

---

## 函数签名与参数说明

### `OtelProvider::from(settings: &OtelSettings) -> Result<Option<Self>, Box<dyn Error>>`

主构建函数。根据配置初始化所有遥测管道。

- 返回 `Ok(None)` 表示所有导出器均被禁用
- 返回 `Ok(Some(provider))` 表示至少有一个信号启用

### `OtelProvider::shutdown(&self)`

优雅关闭所有遥测管道：先 flush+shutdown tracer_provider，再 shutdown metrics，最后 shutdown logger。`Drop` trait 实现中也调用相同逻辑（`provider.rs:163-176`）。

### `OtelProvider::logger_layer<S>(&self) -> Option<impl Layer<S>>`

返回一个 `tracing_subscriber::Layer`，将匹配 `log_export_filter` 的事件桥接到 OpenTelemetry Log SDK。底层使用 `OpenTelemetryTracingBridge`（`provider.rs:122-131`）。

### `OtelProvider::tracing_layer<S>(&self) -> Option<impl Layer<S>>`

返回一个 `tracing_subscriber::Layer`，将匹配 `trace_export_filter` 的 span 和事件导出为 OTLP traces（`provider.rs:133-144`）。

### `OtelProvider::metrics(&self) -> Option<&MetricsClient>`

获取 MetricsClient 引用，用于发送计数器、直方图等指标。

---

## 接口/类型定义

### `OtelSettings`（`config.rs:36-45`）

OTel 初始化所需的全部配置：

| 字段 | 类型 | 说明 |
|------|------|------|
| `environment` | `String` | 部署环境（如 "production"、"staging"） |
| `service_name` | `String` | 服务名称，会写入 Resource |
| `service_version` | `String` | 服务版本号 |
| `codex_home` | `PathBuf` | Codex 主目录路径 |
| `exporter` | `OtelExporter` | 日志导出器配置 |
| `trace_exporter` | `OtelExporter` | 追踪导出器配置 |
| `metrics_exporter` | `OtelExporter` | 指标导出器配置 |
| `runtime_metrics` | `bool` | 是否采集运行时指标 |

### `OtelExporter`（`config.rs:62-80`）

导出器选择枚举，支持四种变体：

| 变体 | 说明 |
|------|------|
| `None` | 禁用导出 |
| `Statsig` | 使用内置 Statsig 默认配置（仅限指标，release 构建生效） |
| `OtlpGrpc { endpoint, headers, tls }` | gRPC 传输，可选 TLS/mTLS |
| `OtlpHttp { endpoint, headers, protocol, tls }` | HTTP 传输，支持 Binary 和 JSON 协议，可选 TLS/mTLS |

### `OtelTlsConfig`（`config.rs:56-60`）

TLS/mTLS 证书配置：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ca_certificate` | `Option<AbsolutePathBuf>` | CA 根证书路径 |
| `client_certificate` | `Option<AbsolutePathBuf>` | 客户端证书路径（mTLS） |
| `client_private_key` | `Option<AbsolutePathBuf>` | 客户端私钥路径（mTLS） |

### `OtelHttpProtocol`（`config.rs:48-53`）

HTTP 导出协议：`Binary`（protobuf）或 `Json`。

---

## 配置项与默认值

### Statsig 默认导出器

当 `OtelExporter::Statsig` 被 `resolve_exporter()` 解析时（`config.rs:10-33`）：

- **Release 构建**：解析为 `OtlpHttp`，endpoint 为 `https://ab.chatgpt.com/otlp/v1/metrics`，协议为 JSON，附带 `statsig-api-key` header
- **Debug 构建**：解析为 `OtelExporter::None`，避免开发/测试环境产生不必要的遥测流量

### OTLP 超时

超时解析逻辑在 `otlp.rs:196-203`，优先级为：

1. 信号特定环境变量（如 `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT`、`OTEL_EXPORTER_OTLP_LOGS_TIMEOUT`）
2. 通用环境变量 `OTEL_EXPORTER_OTLP_TIMEOUT`
3. SDK 默认值 `OTEL_EXPORTER_OTLP_TIMEOUT_DEFAULT`

环境变量值解析为毫秒数（`i64`），负值被忽略。

### Resource 属性

- `service.name`、`service.version`、`env` 始终包含
- `host.name` 仅附加到 **Logs** 类型的 Resource（通过 `gethostname()` 检测，空白值会被过滤）

---

## 边界 Case 与注意事项

### Tokio 运行时适配

`build_http_client()`（`otlp.rs:74-92`）需要处理 reqwest 阻塞客户端在不同 Tokio 运行时下的构建问题：

- **多线程运行时**：使用 `tokio::task::block_in_place` 避免阻塞 worker 线程
- **单线程运行时**：在独立 `std::thread` 中构建客户端，避免 `block_on` 死锁
- **无运行时**：直接同步构建

HTTP trace 导出器在多线程运行时下额外使用异步 `reqwest::Client`（`build_async_http_client`，`otlp.rs:148-194`）配合 `TokioBatchSpanProcessor`，以获得更好的性能。

### mTLS 校验

`client_certificate` 和 `client_private_key` 必须同时提供或同时省略，否则返回错误（`otlp.rs:59-63`、`otlp.rs:135-139`）。

### Drop 语义

`OtelProvider` 实现了 `Drop`，在析构时自动执行 flush 和 shutdown，确保缓冲的遥测数据被发送。`shutdown()` 方法也可手动调用，两者逻辑相同（`provider.rs:54-65`、`provider.rs:163-176`）。

### target 前缀约定

所有需要导出的遥测事件必须使用 `codex_otel` 前缀的 tracing target。不符合此前缀的事件会被过滤器丢弃。具体子前缀决定路由目标：
- `codex_otel.log_only`：仅日志
- `codex_otel.network_proxy`：仅日志
- `codex_otel.trace_safe`：仅追踪
- `codex_otel.trace_safe.*`：仅追踪（支持子层级）