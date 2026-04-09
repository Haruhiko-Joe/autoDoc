# ModelClient — 模型提供者 API 通信层

## 概述与职责

ModelClient 模块是 Codex 核心引擎（Core → SessionEngine）中负责与模型提供者 API 通信的关键层。它封装了从认证、传输选择到流式请求、连接管理等所有与 LLM API 交互的细节，使上层的 SessionEngine 无需关心底层通信复杂性。

本模块由三个源文件组成：

- **`client.rs`**：核心通信逻辑，包含 `ModelClient`（会话级）和 `ModelClientSession`（Turn 级）两个主结构体
- **`client_common.rs`**：共享的请求/响应类型定义，包括 `Prompt` 和 `ResponseStream`
- **`connectors.rs`**：外部 App Connector 的发现、列表、策略解析和 MCP 工具缓存

在整体架构中，ModelClient 位于 Core 的 SessionEngine 子系统内，是 SessionEngine 与外部 ModelProviders 层之间的桥梁。同级模块包括 ToolsOrchestration（工具调度）、ContextManagement（上下文管理）、AgentCoordination（多 Agent 协调）等。

---

## 关键流程

### 1. 会话初始化与 Turn 创建

每个 Codex 会话创建一个 `ModelClient`，它通过 `Arc<ModelClientState>` 持有会话级不可变状态（认证、provider 信息、conversation ID 等），支持 `Clone` 以便在不同组件间共享。

每个 Turn 通过 `ModelClient::new_session()` 创建一个 `ModelClientSession`。该方法会从会话级缓存中 **take** 上一个 Turn 遗留的 WebSocket 连接（`take_cached_websocket_session`），实现连接复用。当 `ModelClientSession` 被 Drop 时，其 WebSocket 连接会被存回会话级缓存，供下一个 Turn 使用。

> 源码位置：`codex-rs/core/src/client.rs:257-306`（`ModelClient::new` 和 `new_session`）

### 2. 流式请求——WebSocket 优先，SSE 回退

`ModelClientSession::stream()` 是发起模型请求的入口。执行流程：

1. 检查 provider 是否支持 WebSocket 且 WebSocket 未被禁用
2. **WebSocket 路径**：调用 `stream_responses_websocket()`
   - 获取或建立 WebSocket 连接（`websocket_connection()`）
   - 构建 `ResponseCreateWsRequest`，尝试增量发送（仅发送相对上次请求的增量 input items）
   - 如果连接返回 `426 Upgrade Required`，触发回退
3. **SSE/HTTP 回退路径**：调用 `stream_responses_api()`
   - 通过 `ReqwestTransport` 发起标准 HTTP POST 流式请求
   - 支持 401 自动重试（token 刷新）

> 源码位置：`codex-rs/core/src/client.rs:1360-1408`（`stream` 方法）

### 3. WebSocket 预热（Prewarm）

Turn 开始前，`prewarm_websocket()` 发送一个 `generate=false` 的 v2 `response.create` 请求。这会：

1. 建立 WebSocket 连接并完成握手
2. 服务端分配资源但不生成内容
3. 等待 `Completed` 事件后返回
4. 后续的真实请求可复用同一连接和 `previous_response_id`

这被视为该 Turn 的首次 WebSocket 连接尝试——如果失败，正常的重试/回退逻辑会接管。

> 源码位置：`codex-rs/core/src/client.rs:1302-1351`

### 4. Sticky Routing（`x-codex-turn-state`）

每个 Turn 维护一个 `OnceLock<String>` 作为 turn state token。首次请求时，服务端通过响应头返回一个 `x-codex-turn-state` 值，客户端将其存入 `OnceLock`。同一 Turn 内的所有后续请求（重试、增量追加、continuation）都会在请求头中回传此 token，确保请求被路由到同一服务端实例。

**关键约束**：不同 Turn 之间不得复用此 token，因此每次 `new_session()` 都会创建新的 `OnceLock`。

> 源码位置：`codex-rs/core/src/client.rs:206-219`

### 5. 增量 WebSocket 请求

`get_incremental_items()` 检测当前请求是否为上一次请求的严格扩展。如果除 `input` 以外的所有字段不变，且当前 `input` 是上次 input + 上次响应 items 的前缀扩展，则只发送增量部分，并设置 `previous_response_id`，大幅减少传输量。

> 源码位置：`codex-rs/core/src/client.rs:846-883`

### 6. 传输回退机制

WebSocket 回退是**会话级**的：一旦某个 Turn 触发了 HTTP 回退（通过 `force_http_fallback()`），`disable_websockets` 标志被原子地设为 `true`，该会话后续所有 Turn 都将使用 HTTP。

> 源码位置：`codex-rs/core/src/client.rs:347-366`

### 7. Connector 发现与缓存

`connectors.rs` 管理外部 App Connector 的发现流程：

1. 通过 `McpConnectionManager` 连接 Codex Apps MCP 服务器
2. 列出所有可用工具，提取 `connector_id` 维度的 connector 列表
3. 结果缓存在全局静态 `ACCESSIBLE_CONNECTORS_CACHE` 中（TTL 为 `CONNECTORS_CACHE_TTL`）
4. 缓存键包含 `chatgpt_base_url`、`account_id`、`chatgpt_user_id` 和 `is_workspace_account`
5. 通过 `filter_disallowed_connectors()` 过滤黑名单 connector

> 源码位置：`codex-rs/core/src/connectors.rs:86-168`

---

## 函数签名与参数说明

### `ModelClient::new(...) -> Self`

创建会话级客户端。参数均在整个会话生命周期内保持不变：

| 参数 | 类型 | 说明 |
|------|------|------|
| `auth_manager` | `Option<Arc<AuthManager>>` | 认证管理器，负责 token 获取与刷新 |
| `conversation_id` | `ThreadId` | 会话唯一标识 |
| `provider` | `ModelProviderInfo` | 模型提供者配置（API 地址、WebSocket 支持等） |
| `session_source` | `SessionSource` | 会话来源（CLI/VSCode/SubAgent 等） |
| `model_verbosity` | `Option<VerbosityConfig>` | 模型输出详细程度 |
| `enable_request_compression` | `bool` | 是否启用 zstd 请求压缩 |
| `include_timing_metrics` | `bool` | 是否请求计时指标 |
| `beta_features_header` | `Option<String>` | Beta 功能标识 |

> 源码位置：`codex-rs/core/src/client.rs:258-294`

### `ModelClient::new_session(&self) -> ModelClientSession`

创建 Turn 级流式会话。不执行网络 I/O，WebSocket 连接在首次请求时懒加载。

> 源码位置：`codex-rs/core/src/client.rs:300-306`

### `ModelClientSession::stream(...) -> Result<ResponseStream>`

发起流式模型请求。Per-turn 参数在调用时显式传入：

| 参数 | 类型 | 说明 |
|------|------|------|
| `prompt` | `&Prompt` | 包含 input items、工具列表、指令等 |
| `model_info` | `&ModelInfo` | 模型元信息（slug、能力标志等） |
| `session_telemetry` | `&SessionTelemetry` | 遥测上下文 |
| `effort` | `Option<ReasoningEffortConfig>` | 推理努力级别 |
| `summary` | `ReasoningSummaryConfig` | 推理摘要配置 |
| `service_tier` | `Option<ServiceTier>` | 服务等级（`Fast` 映射为 `"priority"`） |
| `turn_metadata_header` | `Option<&str>` | 可选的 per-turn 元数据 |

> 源码位置：`codex-rs/core/src/client.rs:1360-1408`

### `ModelClient::compact_conversation_history(...) -> Result<Vec<ResponseItem>>`

调用 `/responses/compact` 端点压缩对话历史，返回精简后的 `ResponseItem` 列表。这是一个非流式的一元调用。

> 源码位置：`codex-rs/core/src/client.rs:375-436`

### `ModelClient::summarize_memories(...) -> Result<Vec<ApiMemorySummarizeOutput>>`

调用 `/memories/trace_summarize` 端点生成记忆摘要。同样是非流式一元调用。

> 源码位置：`codex-rs/core/src/client.rs:444-484`

### `app_tool_policy(config, connector_id, tool_name, tool_title, annotations) -> AppToolPolicy`

解析指定工具的策略（是否启用、审批模式），综合考虑用户配置、项目 requirements、connector 级别默认值和工具注解中的 `destructive_hint`/`open_world_hint`。

> 源码位置：`codex-rs/core/src/connectors.rs:669-684`

---

## 接口/类型定义

### `Prompt`

API 请求载荷，包含一次模型 Turn 所需的全部信息：

```rust
pub struct Prompt {
    pub input: Vec<ResponseItem>,          // 对话上下文 items
    pub(crate) tools: Vec<ToolSpec>,       // 可用工具（含 MCP 工具）
    pub(crate) parallel_tool_calls: bool,  // 是否允许并行工具调用
    pub base_instructions: BaseInstructions, // 系统指令
    pub personality: Option<Personality>,   // 模型人设
    pub output_schema: Option<Value>,      // 输出 JSON schema
}
```

`get_formatted_input()` 方法在检测到 Freeform `apply_patch` 工具时，会将 shell 输出从 JSON 格式重新序列化为结构化文本格式（exit code + wall time + output）。

> 源码位置：`codex-rs/core/src/client_common.rs:26-65`

### `ResponseStream`

对 `mpsc::Receiver<Result<ResponseEvent>>` 的包装，实现了 `futures::Stream` trait，供上层以异步流方式消费模型响应事件。

> 源码位置：`codex-rs/core/src/client_common.rs:159-169`

### `AppToolPolicy`

```rust
pub(crate) struct AppToolPolicy {
    pub enabled: bool,                // 工具是否启用
    pub approval: AppToolApproval,    // 审批模式（Auto/Manual 等）
}
```

默认值：`enabled = true, approval = Auto`。

> 源码位置：`codex-rs/core/src/connectors.rs:57-69`

### `AccessibleConnectorsStatus`

```rust
pub struct AccessibleConnectorsStatus {
    pub connectors: Vec<AppInfo>,   // 可访问的 connector 列表
    pub codex_apps_ready: bool,     // MCP Apps 服务是否就绪
}
```

> 源码位置：`codex-rs/core/src/connectors.rs:90-93`

---

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `disable_websockets` | 运行时状态 | `false` | 会话级 WebSocket 禁用标志，回退后置 `true` |
| `enable_request_compression` | 构造参数 | - | 仅 ChatGPT 认证 + OpenAI provider 时生效，使用 zstd |
| `include_timing_metrics` | 构造参数 | - | 控制 `x-responsesapi-include-timing-metrics` 头 |
| `CONNECTORS_READY_TIMEOUT_ON_EMPTY_TOOLS` | 常量 | 30 秒 | 无工具时等待 MCP 服务就绪的超时 |
| `DIRECTORY_CONNECTORS_TIMEOUT` | 常量 | 60 秒 | Directory API 请求超时 |
| WebSocket 连接超时 | `provider.websocket_connect_timeout()` | provider 级 | 由 `ModelProviderInfo` 决定 |

---

## 边界 Case 与注意事项

- **WebSocket 连接泄漏保护**：`ModelClientSession` 实现了 `Drop`，确保 WebSocket 连接总是被归还到会话级缓存，不会因为异常退出而泄漏连接。

- **401 自动恢复**：SSE 和 WebSocket 路径都实现了 `handle_unauthorized` 逻辑。收到 401 时，会尝试通过 `UnauthorizedRecovery` 刷新 token 并重试一次。恢复失败分为 Permanent（不可恢复）和 Transient（暂时性失败）两种。

- **Freeform apply_patch 特殊处理**：当工具列表中包含 Freeform 类型的 `apply_patch` 工具时，`reserialize_shell_outputs` 会将 shell 和 `apply_patch` 的 JSON 输出转换为人类可读的结构化文本，避免模型处理嵌套 JSON。

- **增量请求的条件**：增量 WebSocket 发送要求除 `input` 外的所有请求字段完全相同，且当前 input 必须是上次 input + 上次响应 items 的严格前缀扩展。任何字段变化都会触发完整请求。

- **Connector 黑名单**：`DISALLOWED_CONNECTOR_IDS` 和 `DISALLOWED_CONNECTOR_PREFIX`（`connector_openai_`）用于过滤不允许的 connector。First-party chat originator 有独立的黑名单。

- **Window Generation**：`set_window_generation()` 和 `advance_window_generation()` 在上下文窗口变更时重置 WebSocket 缓存，确保新窗口不会复用旧连接的状态。

- **SSE Fixture 模式**：当环境变量 `CODEX_RS_SSE_FIXTURE` 设置时，流式请求会从本地文件读取 fixture 数据而非发起网络调用，用于测试。

---

## 关键代码片段

### WebSocket 预热请求构造

```rust
// codex-rs/core/src/client.rs:1209-1211
if warmup {
    ws_payload.generate = Some(false);
}
```

`generate=false` 是 v2 WebSocket 协议的关键标志——服务端建立连接并分配资源，但不生成任何模型输出。

### 增量 Input 计算

```rust
// codex-rs/core/src/client.rs:869-882
let mut baseline = previous_request.input.clone();
if let Some(last_response) = last_response {
    baseline.extend(last_response.items_added.clone());
}
let baseline_len = baseline.len();
if request.input.starts_with(&baseline)
    && (allow_empty_delta || baseline_len < request.input.len())
{
    Some(request.input[baseline_len..].to_vec())
} else {
    None
}
```

Baseline = 上次发送的 input + 上次响应中新增的 items。只有当前 input 严格以此为前缀时，才返回增量部分。

### Drop 时归还 WebSocket 连接

```rust
// codex-rs/core/src/client.rs:732-738
impl Drop for ModelClientSession {
    fn drop(&mut self) {
        let websocket_session = std::mem::take(&mut self.websocket_session);
        self.client
            .store_cached_websocket_session(websocket_session);
    }
}
```

这确保了跨 Turn 的连接复用——当前 Turn 结束后，WebSocket 连接被安全地存回会话级缓存。