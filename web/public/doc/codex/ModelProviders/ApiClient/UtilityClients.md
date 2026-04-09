# UtilityClients — 辅助 API 端点客户端

## 概述与职责

UtilityClients 是 `codex-api` crate 中三个面向辅助 API 端点的客户端：**ModelsClient**、**CompactClient** 和 **MemoriesClient**。它们分别负责模型列表获取、对话历史压缩和记忆摘要生成。三者共享统一的 `EndpointSession` 模式——一个封装了 HTTP 传输、Provider 配置、认证和遥测的会话抽象，提供带重试策略的请求执行能力。

在整体架构中，这三个客户端属于 **ModelProviders → ApiClient** 层，被上层的 ModelsManager、Core 会话管理等模块调用，底层通过 `codex-client` 的 `HttpTransport` trait 发出实际 HTTP 请求。

## EndpointSession — 共享会话基础设施

三个客户端的内部结构完全一致：各自持有一个 `EndpointSession<T, A>` 实例（`codex-rs/codex-api/src/endpoint/session.rs:17-22`）。

```rust
pub(crate) struct EndpointSession<T: HttpTransport, A: AuthProvider> {
    transport: T,
    provider: Provider,
    auth: A,
    request_telemetry: Option<Arc<dyn RequestTelemetry>>,
}
```

`EndpointSession` 提供的核心能力：

- **请求构建**：根据 `Provider` 的 `base_url` 拼接路径，合并 extra headers，注入认证头（`add_auth_headers`）
- **带重试的执行**：通过 `run_with_request_telemetry` 执行请求，遵循 `Provider.retry` 中配置的重试策略（最大重试次数、退避延迟、429/5xx/传输错误的重试开关）
- **遥测集成**：可通过 `with_request_telemetry` 注入遥测回调
- **`execute` / `execute_with`**：非流式请求执行，`execute_with` 额外接受一个 `configure` 闭包用于在发送前修改请求（如追加查询参数）

每个客户端的构造模式一致：`new(transport, provider, auth)` → 内部创建 `EndpointSession::new(...)`，外加 `with_telemetry` builder 方法。

---

## ModelsClient — 模型列表获取

**源码**：`codex-rs/codex-api/src/endpoint/models.rs`

### 职责

向 `{base_url}/models` 端点发送 GET 请求，获取可用模型列表。支持 ETag 缓存和客户端版本号上报。

### 函数签名

#### `list_models(client_version: &str, extra_headers: HeaderMap) -> Result<(Vec<ModelInfo>, Option<String>), ApiError>`

主方法。执行流程（`models.rs:40-73`）：

1. 调用 `session.execute_with`，使用 `configure` 闭包追加 `?client_version=<version>` 查询参数
2. 从响应头中提取 `ETag` 值（如果存在）
3. 将响应体反序列化为 `ModelsResponse { models: Vec<ModelInfo> }`
4. 返回 `(models, etag)`——模型列表和可选的 ETag 字符串

### 关键实现细节

- **client_version 查询参数**：`append_client_version_query`（`models.rs:35-38`）手动拼接 URL 查询参数，根据 URL 中是否已有 `?` 决定使用 `?` 还是 `&` 作为分隔符
- **ETag 缓存**：返回的 ETag 由调用方（如 ModelsManager）用于后续条件请求的 `If-None-Match` 头，实现增量缓存
- 反序列化失败时，错误信息中会包含原始响应体的 lossy UTF-8 表示，便于调试

### 类型定义

`ModelInfo` 和 `ModelsResponse` 来自 `codex_protocol::openai_models`，包含 slug、display_name、reasoning 级别、context window 大小、工具调用支持等丰富的模型元数据。

---

## CompactClient — 对话历史压缩

**源码**：`codex-rs/codex-api/src/endpoint/compact.rs`

### 职责

向 `{base_url}/responses/compact` 端点发送 POST 请求，将冗长的对话历史压缩为更精简的表示，用于上下文窗口管理。

### 函数签名

#### `compact(body: serde_json::Value, extra_headers: HeaderMap) -> Result<Vec<ResponseItem>, ApiError>`

底层方法。直接发送原始 JSON body，解析响应中的 `output` 字段为 `Vec<ResponseItem>`（`compact.rs:36-48`）。

#### `compact_input(input: &CompactionInput<'_>, extra_headers: HeaderMap) -> Result<Vec<ResponseItem>, ApiError>`

高层便捷方法。将结构化的 `CompactionInput` 序列化为 JSON 后调用 `compact`（`compact.rs:50-58`）。

### CompactionInput 类型

定义在 `codex-rs/codex-api/src/common.rs:24-34`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | `&str` | 目标模型标识 |
| `input` | `&[ResponseItem]` | 待压缩的对话历史项 |
| `instructions` | `&str` | 系统指令 |
| `tools` | `Vec<Value>` | 当前可用的工具定义 |
| `parallel_tool_calls` | `bool` | 是否启用并行工具调用 |
| `reasoning` | `Option<Reasoning>` | 可选的推理配置（effort + summary） |
| `text` | `Option<TextControls>` | 可选的文本控制（verbosity + output schema） |

### 响应格式

内部 `CompactHistoryResponse`（`compact.rs:61-64`）结构简单，仅包含 `output: Vec<ResponseItem>`——即压缩后的对话项列表，可直接替换原始历史。

---

## MemoriesClient — 记忆摘要生成

**源码**：`codex-rs/codex-api/src/endpoint/memories.rs`

### 职责

向 `{base_url}/memories/trace_summarize` 端点发送 POST 请求，将原始对话 trace 转换为结构化的记忆摘要。

### 函数签名

#### `summarize(body: serde_json::Value, extra_headers: HeaderMap) -> Result<Vec<MemorySummarizeOutput>, ApiError>`

底层方法。发送原始 JSON，解析响应 `output` 字段（`memories.rs:36-48`）。

#### `summarize_input(input: &MemorySummarizeInput, extra_headers: HeaderMap) -> Result<Vec<MemorySummarizeOutput>, ApiError>`

高层便捷方法。序列化 `MemorySummarizeInput` 后调用 `summarize`（`memories.rs:50-59`）。

### 输入类型

**MemorySummarizeInput**（`common.rs:38-44`）：

| 字段 | 类型 | 序列化名 | 说明 |
|------|------|----------|------|
| `model` | `String` | `model` | 用于摘要的模型 |
| `raw_memories` | `Vec<RawMemory>` | `traces` | 原始记忆 trace 列表（注意 serde rename） |
| `reasoning` | `Option<Reasoning>` | `reasoning` | 可选推理配置 |

**RawMemory**（`common.rs:47-51`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `String` | trace 唯一标识 |
| `metadata` | `RawMemoryMetadata` | 元数据（包含 `source_path`） |
| `items` | `Vec<Value>` | 原始对话项（非类型化 JSON） |

### 输出类型

**MemorySummarizeOutput**（`common.rs:59-63`）：

| 字段 | 类型 | 序列化别名 | 说明 |
|------|------|-----------|------|
| `raw_memory` | `String` | `trace_summary` / `raw_memory` | trace 级别的原始摘要 |
| `memory_summary` | `String` | — | 精炼的记忆摘要 |

注意 `raw_memory` 字段使用了 `#[serde(rename = "trace_summary", alias = "raw_memory")]`，同时兼容两种 wire format 命名。

---

## 三个客户端的统一模式

| 特征 | ModelsClient | CompactClient | MemoriesClient |
|------|-------------|---------------|----------------|
| HTTP 方法 | GET | POST | POST |
| 端点路径 | `models` | `responses/compact` | `memories/trace_summarize` |
| 请求体 | 无 | `CompactionInput` JSON | `MemorySummarizeInput` JSON |
| 响应解析 | `ModelsResponse` | `CompactHistoryResponse` | `SummarizeResponse` |
| 返回值 | `(Vec<ModelInfo>, Option<String>)` | `Vec<ResponseItem>` | `Vec<MemorySummarizeOutput>` |
| 特殊处理 | ETag 提取 + client_version 查询参数 | — | serde alias 兼容 |

三者的构造方式、遥测注入和错误处理完全对称，体现了 `EndpointSession` 作为统一 HTTP 会话抽象的设计意图。

## 边界 Case 与注意事项

- **ModelsClient 的 URL 拼接**：`append_client_version_query` 是手动字符串拼接，不做 URL encoding。如果 `client_version` 包含特殊字符可能导致问题，但实际使用中版本号格式固定（如 `0.99.0`），风险可控
- **CompactClient 和 MemoriesClient 的双层 API**：同时暴露原始 JSON 的 `compact`/`summarize` 和结构化的 `compact_input`/`summarize_input`，为调用方提供灵活性——可以绕过类型化输入直接发送自定义 payload
- **MemorySummarizeInput.raw_memories 的 serde rename**：Rust 字段名为 `raw_memories`，但序列化时变为 `traces`（`common.rs:41`），与 API wire format 保持一致。阅读代码时注意字段名和 JSON key 的差异
- **MemorySummarizeOutput 的别名兼容**：`trace_summary` 为主名，`raw_memory` 为别名，确保新旧 API 版本均可正确反序列化