# SessionLoop —— 核心会话结构与主调度循环

## 概述与职责

SessionLoop 是 Codex 代理引擎的心脏，位于 **Core → SessionEngine** 层级中。它负责：

1. **会话创建与配置**：通过 `Codex::spawn` 启动一个完整的代理会话，初始化所有依赖服务
2. **中央事件调度循环**：`submission_loop` 接收外部提交的 `Op`（操作），逐一分发给对应的 handler
3. **Turn 执行**：构建 prompt、与模型交互、处理工具调用结果，循环直到模型完成回答
4. **会话关闭**：优雅中止所有任务、关闭 rollout 记录器、释放资源
5. **Rollout 持久化与重建**：将会话历史写入 JSONL 文件，并在 resume/fork 时从 JSONL 重建完整历史

在整体架构中，TUI、CLI、AppServer 等前端通过 `Codex` 结构体的队列接口向 SessionLoop 提交操作，SessionLoop 处理后通过事件通道将结果推送回调用方。同级模块包括 ToolsOrchestration（工具调度）、ContextManagement（上下文管理）、AgentCoordination（多代理协调）等。

---

## 关键类型定义

### `Codex` — 高层公开接口

```rust
pub struct Codex {
    tx_sub: Sender<Submission>,
    rx_event: Receiver<Event>,
    agent_status: watch::Receiver<AgentStatus>,
    session: Arc<Session>,
    session_loop_termination: SessionLoopTermination,
}
```
> 源码位置：`codex-rs/core/src/codex.rs:388-397`

`Codex` 是对外暴露的主要接口，作为一个**队列对（queue pair）**运作：调用方通过 `tx_sub` 发送 `Submission`（包含 `Op`），通过 `rx_event` 接收 `Event`。它不直接执行业务逻辑，而是将所有操作委托给内部的 `Session`。

### `Session` — 已初始化的代理上下文

```rust
pub(crate) struct Session {
    conversation_id: ThreadId,
    tx_event: Sender<Event>,
    agent_status: watch::Sender<AgentStatus>,
    state: Mutex<SessionState>,
    features: ManagedFeatures,
    active_turn: Mutex<Option<ActiveTurn>>,
    mailbox: Mailbox,
    guardian_review_session: GuardianReviewSessionManager,
    services: SessionServices,
    js_repl: Arc<JsReplHandle>,
    // ...
}
```
> 源码位置：`codex-rs/core/src/codex.rs:809-828`

`Session` 是核心状态容器。**一个 Session 同时最多只有一个运行中的 task**，可以被用户输入中断。它持有所有会话级服务（通过 `SessionServices`）、可变状态（通过 `SessionState`）以及当前活跃的 Turn（通过 `ActiveTurn`）。

### `TurnContext` — 单次 Turn 的上下文快照

```rust
pub(crate) struct TurnContext {
    sub_id: String,
    trace_id: Option<String>,
    realtime_active: bool,
    config: Arc<Config>,
    model_info: ModelInfo,
    provider: ModelProviderInfo,
    reasoning_effort: Option<ReasoningEffortConfig>,
    cwd: AbsolutePathBuf,
    approval_policy: Constrained<AskForApproval>,
    sandbox_policy: Constrained<SandboxPolicy>,
    tools_config: ToolsConfig,
    features: ManagedFeatures,
    dynamic_tools: Vec<DynamicToolSpec>,
    truncation_policy: TruncationPolicy,
    // ... 约 40 个字段
}
```
> 源码位置：`codex-rs/core/src/codex.rs:847-892`

`TurnContext` 是**不可变的 per-turn 快照**，在每个 Turn 开始时从 `SessionConfiguration` 构建。它携带该 Turn 所需的所有配置：模型信息、安全策略、工具配置、路径解析基准目录等。下游的工具执行、prompt 构建、审批流程等都依赖此上下文。

### `SessionConfiguration` — 会话配置

```rust
pub(crate) struct SessionConfiguration {
    provider: ModelProviderInfo,
    collaboration_mode: CollaborationMode,
    base_instructions: String,
    approval_policy: Constrained<AskForApproval>,
    sandbox_policy: Constrained<SandboxPolicy>,
    cwd: AbsolutePathBuf,
    session_source: SessionSource,
    dynamic_tools: Vec<DynamicToolSpec>,
    // ...
}
```
> 源码位置：`codex-rs/core/src/codex.rs:1075-1128`

可变的会话级配置。每次 Turn 开始时，通过 `SessionSettingsUpdate` 增量更新（如切换模型、修改审批策略、更换工作目录等），然后生成对应的 `TurnContext`。

### `SessionServices` — 会话级服务集合

```rust
pub(crate) struct SessionServices {
    mcp_connection_manager: Arc<RwLock<McpConnectionManager>>,
    unified_exec_manager: UnifiedExecProcessManager,
    analytics_events_client: AnalyticsEventsClient,
    hooks: Hooks,
    rollout: Mutex<Option<RolloutRecorder>>,
    exec_policy: Arc<ExecPolicyManager>,
    auth_manager: Arc<AuthManager>,
    models_manager: Arc<ModelsManager>,
    model_client: ModelClient,
    code_mode_service: CodeModeService,
    // ... 约 20 个字段
}
```
> 源码位置：`codex-rs/core/src/state/service.rs:30-61`

将所有会话作用域的服务引用集中在一个结构体中，避免 `Session` 本身过于膨胀。包含 MCP 连接管理、执行策略、认证、模型客户端、Rollout 记录等。

### `SessionState` — 会话级可变状态

> 源码位置：`codex-rs/core/src/state/session.rs:20-36`

持有 `ContextManager`（对话历史）、token 用量、rate limit 快照、MCP 依赖状态、授予的权限等。通过 `Mutex<SessionState>` 在 `Session` 中保护。

### `ActiveTurn` 与 `TurnState` — Turn 级状态

> 源码位置：`codex-rs/core/src/state/turn.rs:27-109`

`ActiveTurn` 管理当前运行中的任务集合（`IndexMap<String, RunningTask>`），支持同时运行多个子任务（如主任务 + ghost snapshot）。`TurnState` 跟踪该 Turn 内的待审批请求、pending input 缓冲、mailbox delivery 阶段和 token 用量。

---

## 关键流程

### 1. 会话创建流程（`Codex::spawn` → `Session::new`）

1. `Codex::spawn` 校验 parent trace，调用 `spawn_internal`（`codex.rs:440-462`）
2. `spawn_internal` 创建 `async_channel` 队列对：`(tx_sub, rx_sub)` 用于 submission，`(tx_event, rx_event)` 用于 event
3. 加载 skills、plugins，解析模型、base instructions、dynamic tools
4. 构建 `SessionConfiguration`，将各种策略（approval、sandbox、network）和配置打包
5. 调用 `Session::new`（`codex.rs:1477`），并行初始化多个异步任务以降低启动延迟：
   - **Rollout 初始化**：创建或 resume `RolloutRecorder`，初始化 StateDB
   - **历史元数据加载**：读取历史消息数量（subagent 跳过）
   - **Auth + MCP**：获取认证信息，计算 MCP 服务器列表和 OAuth 状态
6. 上述三个 future 通过 `tokio::join!` 并行执行（`codex.rs:1614-1618`）
7. 初始化 `SessionServices`，启动 MCP 连接、网络代理、shell 环境等
8. 调用 `record_initial_history` 从 `InitialHistory`（New/Resumed/Forked）恢复对话状态
9. `tokio::spawn` 启动 `submission_loop` 后台任务
10. 返回 `CodexSpawnOk { codex, thread_id }`

### 2. 中央事件调度循环（`submission_loop`）

```rust
async fn submission_loop(sess: Arc<Session>, config: Arc<Config>, rx_sub: Receiver<Submission>) {
    while let Ok(sub) = rx_sub.recv().await {
        match sub.op.clone() {
            Op::Interrupt => handlers::interrupt(&sess).await,
            Op::UserInput { .. } | Op::UserTurn { .. } => 
                handlers::user_input_or_turn(&sess, sub.id, sub.op).await,
            Op::ExecApproval { .. } => handlers::exec_approval(...).await,
            Op::Shutdown => return handlers::shutdown(&sess, sub.id).await,
            // ... 20+ 其他 Op 变体
        }
    }
}
```
> 源码位置：`codex-rs/core/src/codex.rs:4441-4652`

这是一个简单的 **while-recv** 循环。每个 `Submission` 包含一个唯一 ID、一个 `Op`（操作指令）和可选的 trace context。循环为每个 submission 创建一个 tracing span，然后 match 到对应的 handler。唯一能中止循环的是 `Op::Shutdown`（handler 返回 `true`）。

支持的主要 Op 类型：

| Op | 作用 |
|---|---|
| `UserInput` / `UserTurn` | 提交用户消息，启动新 Turn |
| `Interrupt` | 中断当前 Turn |
| `ExecApproval` / `PatchApproval` | 用户对工具调用的审批决策 |
| `OverrideTurnContext` | 修改模型/策略等运行时配置 |
| `Compact` | 触发上下文压缩 |
| `Undo` | 撤销上一轮操作 |
| `ThreadRollback` | 回滚 N 个 user turn |
| `Shutdown` | 关闭会话 |
| `InterAgentCommunication` | 子代理间消息传递 |
| `RefreshMcpServers` | 刷新 MCP 服务器连接 |
| `RunUserShellCommand` | 执行用户 shell 命令 |

### 3. Turn 执行流程（`user_input_or_turn`）

1. 从 `Op` 中解析用户输入和设置更新（`codex.rs:4768-4822`）
2. 调用 `sess.new_turn_with_sub_id` 创建新的 `TurnContext`，应用设置变更
3. 尝试 `steer_input`——如果已有活跃 Turn，将输入注入到该 Turn
4. 如果没有活跃 Turn（`NoActiveTurn`），则：
   - 刷新 MCP 服务器（如有待处理的刷新请求）
   - 调用 `sess.spawn_task(turn_context, items, RegularTask::new())` 启动新任务
5. 任务在独立 `tokio::spawn` 中运行，通过 `ActiveTurn` 注册和追踪

### 4. TurnContext 构建流程（`make_turn_context`）

> 源码位置：`codex-rs/core/src/codex.rs:1369-1473`

从 `SessionConfiguration` 快照中提取所有 Turn 所需的参数：
- 通过 `build_per_turn_config` 合并最新会话配置到 per-turn Config
- 从 `ModelsManager` 获取模型元数据（context window、reasoning effort 等）
- 重新加载 plugins 和 skills
- 构建 `ToolsConfig`（工具可用性取决于模型能力、沙箱策略、feature flags）
- 解析本地时间和时区

### 5. 会话关闭流程（`handlers::shutdown`）

> 源码位置：`codex-rs/core/src/codex.rs:5432-5472+`

1. `abort_all_tasks` 中止所有运行中的任务
2. 关闭 realtime conversation
3. `unified_exec_manager.terminate_all_processes` 终止所有子进程
4. 关闭 guardian review session
5. 统计 turn 数量并上报 telemetry
6. 取出 `RolloutRecorder` 并优雅 shutdown（flush 到磁盘）

### 6. Rollout 重建流程（`reconstruct_history_from_rollout`）

> 源码位置：`codex-rs/core/src/codex/rollout_reconstruction.rs`

当 resume 或 fork 一个已有会话时，需要从 JSONL rollout 文件重建完整的对话历史。算法分两阶段：

**阶段一：逆序扫描（newest → oldest）**
- 从最新的 rollout item 开始，将连续的 item 聚合为一个个 "turn segment"
- 识别 `TurnStarted`/`TurnComplete` 边界
- 处理 `ThreadRolledBack`——跳过被回滚的 N 个 user turn
- 处理 `Compacted`——找到最新的 `replacement_history` 作为历史基线
- 收集 `PreviousTurnSettings` 和 `reference_context_item`（用于 resume 后的上下文注入）
- 一旦同时找到 replacement_history 基线和 resume 元数据，即可停止扫描

**阶段二：正序回放（suffix）**
- 从基线之后的 rollout suffix 开始正序回放
- `ResponseItem` 记录到 history
- `Compacted` 触发 history 替换
- `ThreadRolledBack` 裁剪最近的 N 个 user turn

返回 `RolloutReconstruction { history, previous_turn_settings, reference_context_item }`。

---

## 函数签名与参数说明

### `Codex::spawn(args: CodexSpawnArgs) -> CodexResult<CodexSpawnOk>`

会话入口点。接收配置、认证、模型管理器等依赖，返回可用的 `Codex` 实例和 `thread_id`。

### `Codex::submit(&self, op: Op) -> CodexResult<String>`

提交操作到会话循环，自动生成唯一 submission ID（UUID v7），返回该 ID。

### `Codex::next_event(&self) -> CodexResult<Event>`

从事件通道接收下一个事件。阻塞直到有事件可用，或会话已终止时返回 `InternalAgentDied`。

### `Codex::shutdown_and_wait(&self) -> CodexResult<()>`

发送 `Op::Shutdown` 并等待 submission loop 完全退出。

### `Codex::steer_input(&self, input: Vec<UserInput>, expected_turn_id: Option<&str>) -> Result<String, SteerInputError>`

向当前活跃 Turn 注入新的用户输入（"steering"），用于在 Turn 执行过程中动态追加内容。

### `Session::new(...) -> anyhow::Result<Arc<Self>>`

> 接收 16 个参数（`codex.rs:1477-1493`）

初始化完整的 Session：创建 rollout recorder、发现 shell、建立 MCP 连接、启动网络代理、记录初始历史。

---

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `SUBMISSION_CHANNEL_CAPACITY` | 512 | submission 通道的有界容量 |
| `INITIAL_SUBMIT_ID` | `""` | 初始配置请求使用的 submission ID |
| `DIRECT_APP_TOOL_EXPOSURE_THRESHOLD` | 100 | 直接暴露 app tool 的最大数量阈值 |

会话配置通过 `SessionConfiguration` 管理，关键可调参数包括：
- `approval_policy`：何时请求用户审批（`AskForApproval`）
- `sandbox_policy`：命令沙箱策略
- `collaboration_mode`：模型 + 推理参数 + 开发者指令的组合
- `cwd`：会话工作目录（所有相对路径的解析基准）

---

## 边界 Case 与注意事项

- **单任务并发约束**：一个 Session 同时最多运行一个主 task。如果在活跃 Turn 期间收到新的 `UserInput`，会尝试 `steer_input` 注入而非启动新 Turn。如果 steer 失败（`NoActiveTurn`），才启动新 Turn。
- **Mailbox 投递阶段**：`MailboxDeliveryPhase` 控制子代理消息是否应并入当前 Turn。当 Turn 已输出终态文本后切换为 `NextTurn`，避免迟到的子代理消息修改已展示的回答。
- **Rate limit 合并**：`merge_rate_limit_fields` 在新快照缺少 credits 或 plan 信息时，从上一次快照中保留这些字段，默认 `limit_id` 为 `"codex"`（`state/session.rs:222-236`）。
- **Legacy compaction 兼容**：rollout 重建中遇到没有 `replacement_history` 的旧式 compaction item 时，会退回到从 user messages 重建压缩历史，并清除 `reference_context_item` 以避免上下文错位。
- **Guardian review 隔离**：guardian reviewer session 不继承调用方的 exec-policy 规则，使用默认策略以防止规则泄漏影响安全评估。
- **Subagent 深度限制**：当 spawn 深度达到 `config.agent_max_depth` 时，自动禁用 `SpawnCsv` 和 `Collab` features，防止无限递归。
- **Resume 模型不匹配警告**：恢复会话时如果当前模型与记录中的模型不同，会向用户发出警告。

---

## 关键代码片段

### submission_loop 的核心 match 分发

```rust
while let Ok(sub) = rx_sub.recv().await {
    let should_exit = match sub.op.clone() {
        Op::Interrupt => { handlers::interrupt(&sess).await; false }
        Op::UserInput { .. } | Op::UserTurn { .. } => {
            handlers::user_input_or_turn(&sess, sub.id.clone(), sub.op).await;
            false
        }
        Op::Shutdown => handlers::shutdown(&sess, sub.id.clone()).await,
        // ...
    };
    if should_exit { break; }
}
```
> 源码位置：`codex-rs/core/src/codex.rs:4441-4647`

### Session::new 中的并行初始化

```rust
let (rollout_result, history_meta, auth_mcp) = 
    tokio::join!(rollout_fut, history_meta_fut, auth_and_mcp_fut);
```
> 源码位置：`codex-rs/core/src/codex.rs:1614-1618`

通过 `tokio::join!` 并行执行 rollout 初始化、历史元数据加载和 auth+MCP 发现，显著降低会话启动延迟。

### Rollout 重建的逆序扫描核心

```rust
for (index, item) in rollout_items.iter().enumerate().rev() {
    match item {
        RolloutItem::Compacted(compacted) => { /* 处理压缩检查点 */ }
        RolloutItem::EventMsg(EventMsg::ThreadRolledBack(rollback)) => {
            pending_rollback_turns = pending_rollback_turns.saturating_add(...);
        }
        RolloutItem::EventMsg(EventMsg::TurnStarted(event)) => {
            /* 段边界：finalize_active_segment */
        }
        // ...
    }
    if base_replacement_history.is_some() && previous_turn_settings.is_some() && ... {
        break; // 早停：所有必需元数据已收集完毕
    }
}
```
> 源码位置：`codex-rs/core/src/codex/rollout_reconstruction.rs:110-222`