# MetricsClient

## 概述与职责

MetricsClient 是 Codex 的 OpenTelemetry 指标子系统，位于 `Observability > OpenTelemetry` 层级下。它为整个 Codex 运行时提供统一的指标采集能力——计数器（counter）、直方图（histogram）、耗时直方图（duration histogram）——底层由 OTel SDK 的 `SdkMeterProvider` 驱动。

在 Observability 体系中，MetricsClient 与 Analytics（用户行为事件上报）和 Feedback（用户反馈收集）并列，专注于**运行时性能与调用量**的度量。Core、AppServer 等上层模块通过全局单例 `metrics::global()` 获取客户端实例，记录 API 调用、工具执行、SSE/WebSocket 事件等关键指标。

### 核心文件结构

| 文件 | 职责 |
|------|------|
| `mod.rs` | 模块入口，全局单例管理 |
| `client.rs` | `MetricsClient` 主体实现，OTLP 导出器构建 |
| `config.rs` | `MetricsConfig` / `MetricsExporter` 配置类型 |
| `error.rs` | `MetricsError` 错误枚举 |
| `validation.rs` | 指标名称与标签的字符合法性校验 |
| `names.rs` | 预定义的指标名称常量 |
| `tags.rs` | 会话级标签常量与 `SessionMetricTagValues` 辅助类型 |
| `timer.rs` | `Timer`——基于 RAII 的自动耗时记录 |
| `runtime_metrics.rs` | `RuntimeMetricsSummary`——按需聚合运行时指标快照 |

## 关键流程

### 1. 初始化与全局注册

```
MetricsConfig::otlp(env, name, version, exporter)
  → MetricsClient::new(config)
    → validate_tags(default_tags)
    → 构建 Resource（service_name, version, env, os 信息）
    → 可选：创建 ManualReader（Delta 时间窗口）
    → build_otlp_metric_exporter() 或直接使用 InMemory exporter
    → build_provider() → SdkMeterProvider + Meter("codex")
  → install_global(client)  // OnceLock 写入
```

上层通过 `metrics::global()` 获取 `Option<MetricsClient>`，这是一个基于 `OnceLock` 的进程级单例（`mod.rs:17-25`）。`MetricsClient` 内部通过 `Arc<MetricsClientInner>` 实现 `Clone`，可以在多线程间安全共享。

### 2. 记录指标

所有指标记录方法遵循相同模式：

1. **校验指标名称**：调用 `validate_metric_name()` 确认只包含 `[a-zA-Z0-9._-]`
2. **合并标签**：将调用方传入的 `tags` 与 `default_tags` 合并（BTreeMap 保证有序），每个标签键值都经过 `validate_tag_key/validate_tag_value` 校验
3. **惰性创建 instrument**：从 `Mutex<HashMap>` 缓存中获取或创建对应的 OTel Counter/Histogram
4. **记录数据点**

三种指标类型：

- **`counter(name, inc, tags)`**：`u64` 计数器，`inc` 必须非负（`client.rs:93-112`）
- **`histogram(name, value, tags)`**：`f64` 直方图，记录任意整数值（`client.rs:114-127`）
- **`record_duration(name, duration, tags)`**：耗时直方图，自动将 `Duration` 转为毫秒，附带 `unit=ms` 和描述元数据（`client.rs:129-146`）

### 3. Timer 自动计时

`Timer` 是一个 RAII 守卫：创建时记录 `Instant::now()`，析构时自动调用 `record_duration` 记录经过的时间。

```rust
// 典型用法
let _timer = metrics.start_timer("codex.api_request.duration_ms", &[("model", "gpt-5.1")])?;
// ... 执行操作 ...
// timer 离开作用域时自动记录耗时
```

也可以在 drop 之前手动调用 `timer.record(additional_tags)` 来提前记录并附加额外标签（`timer.rs:34-40`）。如果自动记录时发生错误，会通过 `tracing::error!` 打印日志而非 panic。

### 4. 运行时快照（ManualReader）

当 `MetricsConfig::with_runtime_reader()` 启用后，会额外注册一个 `ManualReader`（Delta 时间窗口）到 MeterProvider。调用 `client.snapshot()` 即可按需收集当前所有指标数据，返回 `ResourceMetrics`（`client.rs:276-285`）。

`SharedManualReader` 是对 `Arc<ManualReader>` 的 newtype 包装，实现了 `MetricReader` trait 以满足 OTel SDK 的注册要求（`client.rs:48-79`）。

### 5. RuntimeMetricsSummary 聚合

`RuntimeMetricsSummary::from_snapshot()` 将原始的 `ResourceMetrics` 快照解析为结构化的业务摘要（`runtime_metrics.rs:119-169`）。解析逻辑：

- **计数器**（`sum_counter`）：遍历 scope metrics，匹配名称，累加 `U64 Sum` 数据点
- **直方图**（`sum_histogram_ms`）：遍历 scope metrics，匹配名称，累加 `F64 Histogram` 的 sum 值并四舍五入为 `u64`

`merge()` 方法支持将多个摘要合并：计数类字段使用 `saturating_add`，耗时类字段（如 `responses_api_overhead_ms`）采用"最新非零值覆盖"策略（`runtime_metrics.rs:75-105`）。

### 6. OTLP 导出器构建

`build_otlp_metric_exporter()` 根据 `OtelExporter` 枚举创建不同类型的导出器（`client.rs:332-406`）：

| 变体 | 传输协议 | 特点 |
|------|---------|------|
| `OtlpGrpc` | gRPC (Tonic) | 支持自定义 headers、TLS 配置（含根证书）、默认 HTTP/2 |
| `OtlpHttp` | HTTP | 支持 Binary/JSON 两种 protocol、自定义 headers、可选 TLS 客户端 |
| `Statsig` | 递归解析 | 委托给 `resolve_exporter()` 解析为具体的 gRPC/HTTP 配置 |
| `None` | - | 返回 `MetricsError::ExporterDisabled` |

所有导出器统一使用 **Delta 时间窗口**（`Temporality::Delta`）。

## 函数签名

### `MetricsClient::new(config: MetricsConfig) -> Result<Self>`

从配置构建客户端实例。校验 default_tags、构建 OTel Resource 和 MeterProvider。

### `MetricsClient::counter(name: &str, inc: i64, tags: &[(&str, &str)]) -> Result<()>`

递增计数器。`inc` 必须 >= 0，否则返回 `NegativeCounterIncrement` 错误。

### `MetricsClient::histogram(name: &str, value: i64, tags: &[(&str, &str)]) -> Result<()>`

记录直方图样本值。

### `MetricsClient::record_duration(name: &str, duration: Duration, tags: &[(&str, &str)]) -> Result<()>`

记录耗时直方图，单位毫秒。`duration` 会被 clamp 到 `i64::MAX` 范围内。

### `MetricsClient::start_timer(name: &str, tags: &[(&str, &str)]) -> Result<Timer>`

创建一个 `Timer`，析构时自动调用 `record_duration`。

### `MetricsClient::snapshot() -> Result<ResourceMetrics>`

收集运行时指标快照。需先通过 `with_runtime_reader()` 启用，否则返回 `RuntimeSnapshotUnavailable`。

### `MetricsClient::shutdown() -> Result<()>`

刷新并关闭底层 MeterProvider，调用 `force_flush()` + `shutdown()`。

### `metrics::global() -> Option<MetricsClient>`

获取全局单例（`mod.rs:23-25`）。

## 接口/类型定义

### `MetricsConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| `environment` | `String` | 部署环境标识（如 "production"） |
| `service_name` | `String` | OTel 服务名 |
| `service_version` | `String` | 服务版本 |
| `exporter` | `MetricsExporter` | 导出器类型 |
| `export_interval` | `Option<Duration>` | 周期性导出间隔 |
| `runtime_reader` | `bool` | 是否启用 ManualReader |
| `default_tags` | `BTreeMap<String, String>` | 每条指标自动附带的默认标签 |

Builder 方法：`otlp()`、`in_memory()`、`with_export_interval()`、`with_runtime_reader()`、`with_tag()`。

### `MetricsExporter`

```rust
pub enum MetricsExporter {
    Otlp(OtelExporter),        // 生产用 OTLP 导出
    InMemory(InMemoryMetricExporter), // 测试用内存导出
}
```

### `MetricsError`

关键变体：

| 变体 | 触发场景 |
|------|---------|
| `EmptyMetricName` | 指标名称为空字符串 |
| `InvalidMetricName` | 名称含非法字符（允许 `[a-zA-Z0-9._-]`） |
| `EmptyTagComponent` / `InvalidTagComponent` | 标签键或值为空或含非法字符（允许 `[a-zA-Z0-9._-/]`） |
| `NegativeCounterIncrement` | counter 传入负数 inc |
| `ExporterDisabled` | exporter 配置为 None |
| `RuntimeSnapshotUnavailable` | 未启用 runtime_reader 时调用 snapshot |

### `RuntimeMetricsSummary`

聚合运行时指标的结构体，包含以下分组：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tool_calls` | `RuntimeMetricTotals` | 工具调用次数与总耗时 |
| `api_calls` | `RuntimeMetricTotals` | API 请求次数与总耗时 |
| `streaming_events` | `RuntimeMetricTotals` | SSE 事件次数与总耗时 |
| `websocket_calls` | `RuntimeMetricTotals` | WebSocket 请求次数与总耗时 |
| `websocket_events` | `RuntimeMetricTotals` | WebSocket 事件次数与总耗时 |
| `responses_api_overhead_ms` | `u64` | Responses API 开销耗时 |
| `turn_ttft_ms` / `turn_ttfm_ms` | `u64` | 每轮首 token / 首消息耗时 |

其中 `RuntimeMetricTotals` 包含 `count: u64` 和 `duration_ms: u64` 两个字段。

### `SessionMetricTagValues`

会话级标签的便捷构造器（`tags.rs:12-19`）：

| 字段 | 类型 | 对应标签常量 |
|------|------|-------------|
| `auth_mode` | `Option<&str>` | `auth_mode` |
| `session_source` | `&str` | `session_source` |
| `originator` | `&str` | `originator` |
| `service_name` | `Option<&str>` | `service_name` |
| `model` | `&str` | `model` |
| `app_version` | `&str` | `app.version` |

调用 `into_tags()` 返回 `Vec<(&str, &str)>`，`None` 字段自动跳过。

## 预定义指标名称

`names.rs` 定义了所有 well-known 指标常量，按类别归纳：

**工具调用**
- `codex.tool.call` / `codex.tool.call.duration_ms`
- `codex.tool.unified_exec`

**API 请求**
- `codex.api_request` / `codex.api_request.duration_ms`

**SSE 事件**
- `codex.sse_event` / `codex.sse_event.duration_ms`

**WebSocket**
- `codex.websocket.request` / `codex.websocket.request.duration_ms`
- `codex.websocket.event` / `codex.websocket.event.duration_ms`

**Responses API 性能**
- `codex.responses_api_overhead.duration_ms`
- `codex.responses_api_inference_time.duration_ms`
- `codex.responses_api_engine_iapi_ttft.duration_ms` / `..._service_ttft.duration_ms`
- `codex.responses_api_engine_iapi_tbt.duration_ms` / `..._service_tbt.duration_ms`

**Turn 级别**
- `codex.turn.e2e_duration_ms` / `codex.turn.ttft.duration_ms` / `codex.turn.ttfm.duration_ms`
- `codex.turn.network_proxy` / `codex.turn.tool.call` / `codex.turn.token_usage`

**其他**
- `codex.profile.usage` / `codex.plugins.startup_sync` / `codex.thread.started`
- `codex.startup_prewarm.duration_ms` / `codex.startup_prewarm.age_at_first_turn_ms`

## 校验规则

指标名称和标签使用不同的字符白名单（`validation.rs:49-55`）：

| 类型 | 允许字符 |
|------|---------|
| 指标名称 | `[a-zA-Z0-9._-]` |
| 标签键/值 | `[a-zA-Z0-9._-/]`（多一个 `/`） |

空字符串对于名称和标签都是非法的。校验在记录时和配置时都会执行。

## 边界 Case 与注意事项

- **全局单例只写一次**：`install_global` 使用 `OnceLock::set`，第二次调用会静默失败（不覆盖），需确保初始化只发生一次
- **Counter 不接受负数**：虽然参数类型是 `i64`，但负值会返回 `NegativeCounterIncrement` 错误，实际转换为 `u64` 使用
- **Duration 溢出保护**：`record_duration` 将毫秒值 clamp 到 `i64::MAX`（`client.rs:262`）
- **Mutex 中毒恢复**：instrument 缓存的 Mutex 使用 `unwrap_or_else(PoisonError::into_inner)` 处理中毒，不会 panic
- **Timer drop 错误静默**：Timer 析构时的记录错误通过 `tracing::error!` 输出日志，不会 panic
- **ManualReader 使用 Delta 时间窗口**：每次 `snapshot()` 收集的是自上次收集以来的增量数据，而非累计值
- **OS 信息采集**：Resource 属性中会自动附加 `os` 和 `os_version`，值为 "unspecified" 时跳过（`client.rs:293-307`）
- **`f64_to_u64` 转换**：对非有限值和负值返回 0，正值四舍五入并 clamp 到 `u64::MAX`（`runtime_metrics.rs:210-216`）