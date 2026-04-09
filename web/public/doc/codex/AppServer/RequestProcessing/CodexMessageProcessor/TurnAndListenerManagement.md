# Turn 管理与事件监听器基础设施

## 概述与职责

本模块是 `CodexMessageProcessor` 中负责**对话轮次（Turn）生命周期管理**和**事件监听器基础设施**的核心部分。它位于 AppServer → RequestProcessing → CodexMessageProcessor 层级下，是 IDE 客户端（VS Code、Cursor 等）通过 JSON-RPC 协议与 Codex 核心引擎交互的关键桥梁。

在 RequestProcessing 的同级模块中：
- **MessageProcessor** 负责顶层请求分发，将轮次相关请求路由到本模块
- **BespokeEventHandling** 负责将核心事件翻译为协议通知，被本模块的监听器循环调用
- **ThreadStateManagement** 管理每线程状态（中断队列、监听器生命周期等），本模块依赖它跟踪运行时状态

本模块实现了三个维度的功能：

1. **轮次操作**：`turn_start`（发起新轮次）、`turn_steer`（向运行中轮次注入追加输入）、`turn_interrupt`（中断运行中轮次）
2. **监听器子系统**：为每个连接-线程对附加事件监听器，通过后台 tokio 任务持续轮询 `CodexThread` 事件并分发给订阅客户端
3. **操作提交**：`submit_core_op` 作为统一的操作提交入口，封装了向 `CodexThread` 提交 `Op` 并传播追踪上下文的逻辑

## 关键流程

### Turn Start 流程

`turn_start` 是发起新对话轮次的入口，完整流程如下：

1. **输入校验**：调用 `validate_v2_input_limit()` 检查用户输入的文本字符总数是否超出 `MAX_USER_INPUT_TEXT_CHARS` 上限。超出时返回带有 `input_error_code`、`max_chars`、`actual_chars` 详细信息的错误响应（`codex_message_processor.rs:6478`）
2. **加载线程**：通过 `load_thread()` 解析 thread ID 字符串并从 `ThreadManager` 获取 `Arc<CodexThread>` 句柄（`codex_message_processor.rs:6482`）
3. **设置客户端名称**：调用 `set_app_server_client_name()` 在线程上记录发起请求的客户端标识（`codex_message_processor.rs:6489-6494`）
4. **规范化协作模式**：如果请求携带了 `collaboration_mode`，调用 `normalize_turn_start_collaboration_mode()` 填充缺省的 `developer_instructions`（`codex_message_processor.rs:6499-6501`）
5. **输入映射**：将 v2 协议的 `V2UserInput` 项转换为核心层的 `CoreInputItem`（`codex_message_processor.rs:6504-6508`）
6. **提交 per-turn 覆盖配置**：如果请求中携带了 `cwd`、`model`、`approval_policy`、`collaboration_mode`、`effort`、`personality` 等任意一个覆盖参数，先通过 `submit_core_op` 提交 `Op::OverrideTurnContext` 更新会话上下文（`codex_message_processor.rs:6522-6544`）
7. **提交用户输入**：通过 `submit_core_op` 提交 `Op::UserInput`，其返回值即为 `turn_id`（`codex_message_processor.rs:6547-6556`）
8. **返回响应**：成功时构造 `TurnStartResponse`（包含初始 `Turn` 对象，状态为 `InProgress`）；失败时返回 `INTERNAL_ERROR_CODE` 错误

### Turn Steer 流程

`turn_steer` 允许在一个正在运行的轮次中注入追加输入，实现"转向"语义：

1. **加载线程并校验 turn ID**：确保 `expected_turn_id` 非空，并记录请求与 turn 的关联（`codex_message_processor.rs:6607-6617`）
2. **输入校验与映射**：同 `turn_start`，校验字符上限并转换输入项（`codex_message_processor.rs:6618-6627`）
3. **调用核心层 `steer_input`**：直接调用 `CodexThread::steer_input()`，传入映射后的输入项和期望的 turn ID（`codex_message_processor.rs:6629-6631`）
4. **错误处理**：核心层返回 `SteerInputError` 枚举，对应以下场景：
   - `NoActiveTurn`：当前没有运行中的轮次
   - `ExpectedTurnMismatch`：请求的 turn ID 与实际活跃 turn ID 不匹配
   - `ActiveTurnNotSteerable`：当前轮次类型不可转向（如 Review 或 Compact 轮次）
   - `EmptyInput`：输入为空

### Turn Interrupt 流程

`turn_interrupt` 请求中断一个正在运行的轮次：

1. 记录请求与 turn ID 的关联（`codex_message_processor.rs:7132-7134`）
2. 加载线程句柄（`codex_message_processor.rs:7136-7142`）
3. 将中断请求压入 `ThreadState` 的 `pending_interrupts` 队列，附带 API 版本信息（`codex_message_processor.rs:7147-7153`）
4. 通过 `submit_core_op` 提交 `Op::Interrupt`（`codex_message_processor.rs:7156-7158`）
5. **不立即响应客户端**——响应在后续 `TurnAborted` 事件到达时由 `BespokeEventHandling` 从待处理队列中取出并发送

### 监听器附加流程

监听器子系统确保每个连接-线程对有且仅有一个后台 tokio 任务来轮询事件：

1. **`ensure_conversation_listener`**（`codex_message_processor.rs:7161-7185`）：入口方法，从 `self` 中提取所需上下文构建 `ListenerTaskContext`，然后委托给静态方法 `ensure_conversation_listener_task`
2. **`ensure_conversation_listener_task`**（`codex_message_processor.rs:7187-7224`）：
   - 从 `ThreadManager` 获取 `CodexThread` 句柄
   - 调用 `ThreadStateManager::try_ensure_connection_subscribed()` 注册连接订阅，获取 `ThreadState`
   - 若连接已关闭，返回 `ConnectionClosed`
   - 调用 `ensure_listener_task_running_task` 启动后台任务
3. **`ensure_listener_task_running_task`**（`codex_message_processor.rs:7276-7376`）：核心实现：
   - 检查 `ThreadState::listener_matches()` 判断是否已有匹配的监听器在运行——如果是则直接返回（幂等性保证）
   - 调用 `ThreadState::set_listener()` 注册新监听器，获取 `listener_command_rx` 通道和 `listener_generation` 代数
   - 通过 `tokio::spawn` 启动后台任务，进入 `select!` 事件循环

### 监听器事件循环

后台 tokio 任务内部使用 `tokio::select!` 同时监听三个源（`codex_message_processor.rs:7302-7376`）：

1. **`cancel_rx`**：当监听器被取代或线程拆除时收到取消信号，退出循环
2. **`conversation.next_event()`**：轮询 `CodexThread` 的下一个事件：
   - 先通过 `ThreadState::track_current_turn_event()` 更新本地轮次历史
   - 检查 `experimental_raw_events` 标志，过滤 `RawResponseItem` 事件
   - 获取订阅该线程的所有连接 ID
   - 构建 `ThreadScopedOutgoingMessageSender` 并调用 `apply_bespoke_event_handling()` 将事件翻译为协议通知分发给客户端
3. **`listener_command_rx`**：接收监听器命令（`ThreadListenerCommand`），委托给 `handle_thread_listener_command` 处理

任务退出时，检查 `listener_generation` 是否匹配，若匹配则调用 `clear_listener()` 清理状态。

### 监听器命令处理

`handle_thread_listener_command`（`codex_message_processor.rs:7783-7821`）处理两种命令：

- **`SendThreadResumeResponse`**：委托给 `handle_pending_thread_resume_request`，在监听器上下文中完成线程恢复响应的发送，确保与事件流的顺序一致性
- **`ResolveServerRequest`**：通知客户端某个服务端请求已解决，通过 `resolve_pending_server_request` 发送 `ServerRequestResolved` 通知，并通过 `completion_tx` 信号完成同步

### 延迟恢复请求处理

`handle_pending_thread_resume_request`（`codex_message_processor.rs:7824-7919`）在监听器附加完成后处理挂起的线程恢复请求：

1. 获取当前活跃轮次快照（`codex_message_processor.rs:7834-7837`）
2. 判断是否有正在进行的轮次（结合 `AgentStatus::Running` 和 `TurnStatus::InProgress`）
3. 调用 `populate_thread_turns()` 从 rollout 文件加载历史轮次数据
4. 通过 `ThreadWatchManager` 获取线程状态，调用 `set_thread_status_and_interrupt_stale_turns()` 修正过期轮次状态
5. 从配置快照中提取 `model`、`service_tier`、`approval_policy` 等字段，构造 `ThreadResumeResponse` 发送给客户端
6. 调用 `replay_requests_to_connection_for_thread()` 重放待处理的服务端请求
7. 将连接注册到线程的订阅列表

## 函数签名与参数说明

### `submit_core_op(&self, request_id: &ConnectionRequestId, thread: &CodexThread, op: Op) -> CodexResult<String>`

向 `CodexThread` 提交一个操作（`Op`），自动附加当前请求的 W3C 追踪上下文。返回值为该操作的提交 ID（即 turn ID）。

> 源码位置：`codex_message_processor.rs:2170-2179`

### `turn_start(&self, request_id: ConnectionRequestId, params: TurnStartParams, app_server_client_name: Option<String>)`

发起新轮次。参数 `TurnStartParams` 包含：
- `thread_id`：目标线程
- `input`：`Vec<V2UserInput>` 用户输入项
- `cwd`、`model`、`approval_policy`、`collaboration_mode`、`effort`、`personality` 等可选 per-turn 覆盖
- `output_schema`：可选的结构化输出 JSON Schema

> 源码位置：`codex_message_processor.rs:6472-6582`

### `turn_steer(&self, request_id: ConnectionRequestId, params: TurnSteerParams)`

向运行中轮次注入追加输入。参数 `TurnSteerParams` 包含：
- `thread_id`：目标线程
- `expected_turn_id`：期望的活跃 turn ID（必须非空，用于校验）
- `input`：`Vec<V2UserInput>` 追加输入项

> 源码位置：`codex_message_processor.rs:6598-6693`

### `turn_interrupt(&mut self, request_id: ConnectionRequestId, params: TurnInterruptParams)`

中断指定轮次。参数 `TurnInterruptParams` 包含：
- `thread_id`：目标线程
- `turn_id`：要中断的 turn ID

注意：该方法不会立即返回响应，响应在 `TurnAborted` 事件处理时发送。

> 源码位置：`codex_message_processor.rs:7126-7159`

### `ensure_conversation_listener(&self, conversation_id: ThreadId, connection_id: ConnectionId, raw_events_enabled: bool, api_version: ApiVersion) -> Result<EnsureConversationListenerResult, JSONRPCErrorError>`

为指定连接-线程对附加事件监听器。返回 `Attached` 或 `ConnectionClosed`。

> 源码位置：`codex_message_processor.rs:7161-7185`

### `ensure_listener_task_running_task(listener_task_context: ListenerTaskContext, conversation_id: ThreadId, conversation: Arc<CodexThread>, thread_state: Arc<Mutex<ThreadState>>, api_version: ApiVersion)`

静态方法，确保后台监听器 tokio 任务正在运行。具有幂等性——如果已有匹配的监听器则直接返回。

> 源码位置：`codex_message_processor.rs:7276-7376`

## 接口/类型定义

### `ListenerTaskContext`

监听器任务所需的上下文集合，解耦了 `&self` 引用使其可以传入 `tokio::spawn`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `thread_manager` | `Arc<ThreadManager>` | 线程管理器 |
| `thread_state_manager` | `ThreadStateManager` | 每线程状态管理器 |
| `outgoing` | `Arc<OutgoingMessageSender>` | 出站消息发送器 |
| `analytics_events_client` | `AnalyticsEventsClient` | 分析事件客户端 |
| `general_analytics_enabled` | `bool` | 是否启用通用分析 |
| `thread_watch_manager` | `ThreadWatchManager` | 线程状态监控管理器 |
| `fallback_model_provider` | `String` | 回退模型提供者 |
| `codex_home` | `PathBuf` | Codex 主目录路径 |

> 源码位置：`codex_message_processor.rs:438-447`

### `EnsureConversationListenerResult`

```rust
enum EnsureConversationListenerResult {
    Attached,         // 监听器成功附加
    ConnectionClosed, // 连接已关闭，跳过附加
}
```

> 源码位置：`codex_message_processor.rs:450-453`

### `ThreadListenerCommand`（定义于 `thread_state.rs`）

```rust
pub(crate) enum ThreadListenerCommand {
    SendThreadResumeResponse(Box<PendingThreadResumeRequest>),
    ResolveServerRequest {
        request_id: RequestId,
        completion_tx: oneshot::Sender<()>,
    },
}
```

在监听器事件循环的上下文中执行操作，确保与事件流的顺序一致性。

> 源码位置：`thread_state.rs:33-42`

### `PendingThreadResumeRequest`（定义于 `thread_state.rs`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `request_id` | `ConnectionRequestId` | 原始恢复请求 ID |
| `rollout_path` | `PathBuf` | 历史 rollout 文件路径 |
| `config_snapshot` | `ThreadConfigSnapshot` | 线程配置快照 |
| `thread_summary` | `Thread` | 线程摘要（待填充 turns） |

> 源码位置：`thread_state.rs:25-30`

## 配置项与默认值

- **`MAX_USER_INPUT_TEXT_CHARS`**：单次输入的最大字符数上限（从 `codex_protocol::user_input` 导入）。超过此限制时 `turn_start` 和 `turn_steer` 均返回 `INVALID_PARAMS_ERROR_CODE` 错误
- **`experimental_raw_events`**：每线程标志，控制是否向客户端转发 `RawResponseItem` 事件。默认为 `false`，通过连接订阅时设置

## 边界 Case 与注意事项

- **中断响应延迟**：`turn_interrupt` 不会立即向客户端返回响应。它将中断请求入队 `pending_interrupts`，并提交 `Op::Interrupt`。实际响应在 `BespokeEventHandling` 处理 `TurnAborted` 事件时从队列中取出并发送。这意味着如果核心层从未产生 `TurnAborted` 事件，客户端可能无法收到中断响应。

- **监听器幂等性**：`ensure_listener_task_running_task` 通过 `listener_matches()` 检查当前监听器是否已绑定到同一个 `CodexThread` 实例（使用 `Arc::ptr_eq` 比较），避免重复启动。新监听器附加时通过 `cancel_tx` 取消旧监听器。

- **监听器代数（generation）**：每次调用 `set_listener()` 时 `listener_generation` 递增（wrapping_add）。后台任务退出时通过比较 generation 判断自己是否仍是当前监听器——只有匹配时才调用 `clear_listener()`，防止新旧监听器竞争。

- **Turn Steer 的 Turn ID 校验**：`expected_turn_id` 必须非空且与当前活跃 turn 匹配。这是为了防止在轮次切换的竞态条件下向错误的轮次注入输入。此外，Review 和 Compact 类型的轮次不可 steer。

- **操作提交的追踪上下文传播**：所有通过 `submit_core_op` 提交的操作都会自动附加 W3C 追踪上下文（通过 `request_trace_context` 从请求中提取），支持分布式追踪链路的完整传播。

- **监听器命令的顺序保证**：`SendThreadResumeResponse` 和 `ResolveServerRequest` 之所以通过监听器命令通道执行，而不是直接在请求处理器中完成，是为了确保这些操作与事件流的时序一致——恢复响应和请求解决通知不会乱序插入事件流中。