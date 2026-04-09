# Feedback（codex-feedback）

## 概述与职责

`codex-feedback` 是 Codex 可观测性层（Observability）的一部分，专门负责**用户反馈的采集与上报**。它在会话运行期间通过 `tracing-subscriber` 层将完整日志写入一个有界环形缓冲区（默认 4 MiB），同时从特殊 tracing 事件中提取结构化元数据标签，并在用户提交反馈时将日志、连接性诊断信息和分类标签一并上传到 Sentry。

在整体架构中，该模块位于 **Observability** 节点下，与 OpenTelemetry 分布式追踪、使用分析事件采集并列。Core 引擎和 AppServer 等上游模块通过调用 Observability 来发出反馈信号，最终由本 crate 完成实际的数据收集和上传。

## 关键流程

### 1. 日志捕获流程（Ring Buffer 写入）

1. 调用方通过 `CodexFeedback::new()` 创建实例，内部初始化一个 4 MiB 上限的 `RingBuffer`（`src/lib.rs:29`）
2. 调用 `logger_layer()` 获取一个 `tracing_subscriber` 格式化层，该层将所有 `TRACE` 及以上级别的日志（不受 `RUST_LOG` 环境变量影响）写入环形缓冲区（`src/lib.rs:191-203`）
3. 日志经由 `FeedbackMakeWriter` → `FeedbackWriter` → `RingBuffer::push_bytes()` 写入。当缓冲区满时，自动从头部驱逐旧数据，始终保留最新的 4 MiB 内容（`src/lib.rs:303-326`）

### 2. 元数据标签采集流程

1. 调用 `metadata_layer()` 获取一个 `FeedbackMetadataLayer`，该层仅监听 `target = "feedback_tags"` 的 tracing 事件（`src/lib.rs:209-217`）
2. 当其他模块调用 `emit_feedback_request_tags()` 或 `emit_feedback_request_tags_with_auth_env()` 时，以 `target: FEEDBACK_TAGS_TARGET` 发出结构化 tracing 事件（`src/lib.rs:100-156`）
3. `FeedbackMetadataLayer::on_event()` 通过 `FeedbackTagsVisitor` 将事件字段提取为 `BTreeMap<String, String>`，存入共享的 tags map，上限 64 个标签（`src/lib.rs:541-567`）

### 3. 反馈上传流程

1. 调用 `snapshot()` 冻结当前环形缓冲区内容、元数据标签，并采集连接性诊断信息，生成 `FeedbackSnapshot`（`src/lib.rs:219-238`）
2. 调用 `FeedbackSnapshot::upload_feedback()` 执行上传：
   - 构建 Sentry `Client`，使用硬编码 DSN（`src/lib.rs:393-398`）
   - 组装标签：`thread_id`、`classification`、`cli_version`、`session_source`、`reason`，再合并元数据层收集的动态标签（跳过保留键名）（`src/lib.rs:401-427`）
   - 根据 `classification` 设置 Sentry 事件级别：`bug`、`bad_result`、`safety_check` 为 `Error`，其余为 `Info`（`src/lib.rs:429-432`）
   - 构建 Sentry `Envelope`，包含事件和附件（日志文件、连接性诊断文本、额外附件文件）（`src/lib.rs:434-463`）
   - 通过 `client.send_envelope()` 发送，并以 10 秒超时调用 `client.flush()`（`src/lib.rs:465-466`）

### 4. 连接性诊断采集

1. `FeedbackDiagnostics::collect_from_env()` 扫描环境变量中的代理配置：`HTTP_PROXY`、`http_proxy`、`HTTPS_PROXY`、`https_proxy`、`ALL_PROXY`、`all_proxy`（`src/feedback_diagnostics.rs:4-11`）
2. 发现任何代理变量后生成诊断条目，包含标题和具体变量值列表（`src/feedback_diagnostics.rs:45-58`）
3. 通过 `attachment_text()` 序列化为人类可读的文本格式，作为附件上传（`src/feedback_diagnostics.rs:71-88`）

## 公开 API

### `CodexFeedback`

核心入口结构体，`Clone` + 线程安全（内部使用 `Arc<FeedbackInner>`）。

| 方法 | 签名 | 说明 |
|------|------|------|
| `new()` | `fn new() -> Self` | 创建默认 4 MiB 容量的实例 |
| `make_writer()` | `fn make_writer(&self) -> FeedbackMakeWriter` | 返回 `tracing_subscriber::fmt` 可用的 writer |
| `logger_layer()` | `fn logger_layer<S>(&self) -> impl Layer<S>` | 返回捕获全量日志的 tracing 层 |
| `metadata_layer()` | `fn metadata_layer<S>(&self) -> impl Layer<S>` | 返回采集 `feedback_tags` 事件的 tracing 层 |
| `snapshot()` | `fn snapshot(&self, session_id: Option<ThreadId>) -> FeedbackSnapshot` | 冻结当前状态为快照 |

### `FeedbackSnapshot`

不可变的反馈快照，包含日志字节、标签、诊断信息和 thread ID。

| 方法 | 签名 | 说明 |
|------|------|------|
| `upload_feedback()` | `fn upload_feedback(&self, classification: &str, reason: Option<&str>, include_logs: bool, extra_attachment_paths: &[PathBuf], session_source: Option<SessionSource>, logs_override: Option<Vec<u8>>) -> Result<()>` | 上传反馈到 Sentry |
| `save_to_temp_file()` | `fn save_to_temp_file(&self) -> io::Result<PathBuf>` | 将日志保存到临时文件 |
| `feedback_diagnostics()` | `fn feedback_diagnostics(&self) -> &FeedbackDiagnostics` | 获取连接性诊断 |
| `with_feedback_diagnostics()` | `fn with_feedback_diagnostics(self, fd: FeedbackDiagnostics) -> Self` | 替换诊断信息（builder 模式） |

### `FeedbackRequestTags`

用于向反馈系统注入请求/认证上下文的结构体，字段包括 `endpoint`、`auth_header_attached`、`auth_mode`、`auth_error` 等认证相关信息。

### 辅助函数

- **`emit_feedback_request_tags(tags)`**：将 `FeedbackRequestTags` 作为 tracing 事件发出，供 metadata layer 捕获（`src/lib.rs:100-119`）
- **`emit_feedback_request_tags_with_auth_env(tags, auth_env)`**：同上，额外附加 `AuthEnvTelemetry` 中的环境变量存在性信息（`src/lib.rs:121-156`）

### `FeedbackDiagnostics`

连接性诊断容器。

| 方法 | 说明 |
|------|------|
| `collect_from_env()` | 从当前进程环境变量采集代理配置 |
| `is_empty()` | 是否有诊断条目 |
| `diagnostics()` | 获取诊断列表 `&[FeedbackDiagnostic]` |
| `attachment_text()` | 序列化为可读文本，无诊断时返回 `None` |

## 类型定义

### `FeedbackDiagnostic`

```rust
// src/feedback_diagnostics.rs:19-22
pub struct FeedbackDiagnostic {
    pub headline: String,
    pub details: Vec<String>,
}
```

单条诊断条目，`headline` 为总结性描述，`details` 为具体值列表。

### 反馈分类（classification）

通过字符串传递，支持以下值：

| 值 | 显示名 | Sentry 级别 |
|----|--------|-------------|
| `"bug"` | Bug | Error |
| `"bad_result"` | Bad result | Error |
| `"good_result"` | Good result | Info |
| `"safety_check"` | Safety check | Error |
| 其他 | Other | Info |

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_MAX_BYTES` | 4 MiB (4 × 1024 × 1024) | 环形缓冲区默认容量 |
| `UPLOAD_TIMEOUT_SECS` | 10 秒 | Sentry 上传 flush 超时 |
| `MAX_FEEDBACK_TAGS` | 64 | 元数据标签上限 |
| `SENTRY_DSN` | 硬编码 | Sentry 项目端点 |
| `FEEDBACK_TAGS_TARGET` | `"feedback_tags"` | tracing 事件 target 过滤值 |

## 边界 Case 与注意事项

- **环形缓冲区溢出策略**：当写入数据超出容量时，从头部逐字节驱逐旧数据。如果单次写入数据本身就超过容量，则清空缓冲区仅保留数据末尾的 `max` 字节（`src/lib.rs:309-314`）
- **标签上限**：元数据标签达到 64 个后，新的键名不再被添加，但已有键名的值可以被更新（`src/lib.rs:561-562`）
- **保留标签键名**：`thread_id`、`classification`、`cli_version`、`session_source`、`reason` 在上传时由系统填充，元数据层中同名标签会被忽略（`src/lib.rs:413-419`）
- **日志级别独立性**：`logger_layer()` 始终捕获 `TRACE` 级别，不受调用者的 `RUST_LOG` 设置影响，确保反馈报告包含完整上下文（`src/lib.rs:200-202`）
- **附件读取容错**：额外附件文件读取失败时仅 warn 日志，不中断上传流程（`src/lib.rs:499-506`）
- **无活跃会话时的 thread_id**：如果 `snapshot()` 的 `session_id` 为 `None`，生成 `"no-active-thread-"` 前缀加随机 ID（`src/lib.rs:235-236`）
- **代理变量原样记录**：连接性诊断中的代理 URL 不做脱敏处理，可能包含认证信息（`src/feedback_diagnostics.rs:49`）