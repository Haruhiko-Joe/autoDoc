# 事件翻译层（BespokeEventHandling）

## 概述与职责

`bespoke_event_handling` 是 AppServer 的**事件翻译层**，负责将 Codex Core 引擎产生的内部事件（`EventMsg` / `Op` 变体）转换为 app-server 协议通知，通过 WebSocket/stdio 传输发送给连接的客户端（IDE 扩展、桌面应用等）。

在架构层级中，该模块隶属于 **AppServer → RequestProcessing**，与 Protocol（协议类型定义）、Transport（消息发送通道）紧密协作。它是 Core 引擎与客户端之间的"翻译官"——Core 只产生内部 `Event`，而客户端只理解 JSON-RPC 协议通知，两者之间的转换全部在这里完成。

同级兄弟模块包括 `CodexMessageProcessor`（处理入站 JSON-RPC 请求）、`ThreadState`（线程状态管理），以及 `ServerAPIs`（文件操作、搜索等辅助功能）。

> 源码位置：`codex-rs/app-server/src/bespoke_event_handling.rs`（约 3958 行）

## 关键流程

### 核心入口：`apply_bespoke_event_handling`

整个模块的核心是一个大型 `async` 函数 `apply_bespoke_event_handling`（`bespoke_event_handling.rs:256-1899`），它接收一个 `Event`（包含 `id` 即 turn ID 和 `msg` 即事件消息体），然后通过一个巨型 `match msg` 分支将 30+ 种内部事件类型映射到相应的协议通知。

函数签名：

```rust
pub(crate) async fn apply_bespoke_event_handling(
    event: Event,
    conversation_id: ThreadId,
    conversation: Arc<CodexThread>,
    thread_manager: Arc<ThreadManager>,
    outgoing: ThreadScopedOutgoingMessageSender,
    thread_state: Arc<tokio::sync::Mutex<ThreadState>>,
    thread_watch_manager: ThreadWatchManager,
    api_version: ApiVersion,
    fallback_model_provider: String,
    codex_home: &Path,
)
```

> 源码位置：`bespoke_event_handling.rs:256-267`

### API 版本分流

大量事件处理逻辑根据 `api_version`（V1 或 V2）采取不同路径。V2 是更丰富的协议版本，支持更细粒度的通知（如 `ItemStarted`/`ItemCompleted` 生命周期、Guardian 审批等）。V1 使用较简单的请求-响应模式。许多新功能（如 `RequestUserInput`、`RequestPermissions`、`DynamicToolCall`）仅在 V2 下可用，V1 下会记录错误并返回默认/拒绝响应。

### Turn 生命周期管理

Turn（对话轮次）是事件流的基本组织单位，其生命周期由以下事件驱动：

1. **`TurnStarted`**（`bespoke_event_handling.rs:273-297`）：中止所有挂起的服务器请求，通知 `ThreadWatchManager` turn 已启动，V2 下发送 `TurnStartedNotification`（包含当前 turn 快照）。

2. **`TurnComplete`**（`bespoke_event_handling.rs:298-306`）：中止挂起请求，从 `ThreadState` 读取 `TurnSummary` 中的 `last_error`，据此决定最终状态为 `Completed`（无错误）或 `Failed`（有错误），然后发送 `TurnCompletedNotification`。

3. **`TurnAborted`**（`bespoke_event_handling.rs:1756-1784`）：中止挂起请求，解决所有 `pending_interrupts`（向每个等待中断响应的客户端发送 V1 `InterruptConversationResponse` 或 V2 `TurnInterruptResponse`），最后以 `Interrupted` 状态发送 `TurnCompletedNotification`。

### 审批请求的双向通信模式

审批请求（ApplyPatch、ExecCommand、FileChange、Permissions 等）采用一种**请求-响应-回调**模式：

1. 将审批请求作为 **ServerRequest** 发送给客户端（通过 `outgoing.send_request()`）
2. 获得一个 `oneshot::Receiver` 用于异步等待客户端响应
3. `tokio::spawn` 一个异步任务等待响应
4. 收到响应后反序列化、映射为 Core 可理解的决策，提交回 `conversation`（通过 `Op::PatchApproval` / `Op::ExecApproval` 等）
5. 如果响应失败或反序列化出错，默认采取保守策略（Denied / 空响应）

关键的审批回调函数包括：
- `on_patch_approval_response`（`bespoke_event_handling.rs:2194-2248`）
- `on_exec_approval_response`（`bespoke_event_handling.rs:2250-2291`）
- `on_file_change_request_approval_response`（`bespoke_event_handling.rs:2549-2613`）
- `on_command_execution_request_approval_response`（`bespoke_event_handling.rs:2616-2737`）
- `on_request_user_input_response`（`bespoke_event_handling.rs:2293-2372`）
- `on_mcp_server_elicitation_response`（`bespoke_event_handling.rs:2374-2400`）
- `on_request_permissions_response`（`bespoke_event_handling.rs:2441-2468`）

### 权限守卫与 ThreadWatchManager

当事件涉及用户交互（审批请求、用户输入请求）时，模块通过 `ThreadWatchManager` 注册活动状态守卫（`ThreadWatchActiveGuard`），追踪线程当前是否在等待权限确认或用户输入。这些守卫在回调完成时自动释放（`drop(permission_guard)`），确保线程状态监控的准确性。

典型调用链：
```
note_permission_requested() → ThreadWatchActiveGuard
  → tokio::spawn(回调)
    → resolve_server_request_on_thread_listener()
    → drop(guard)
    → conversation.submit(Op::...)
```

### Server Request 解析机制

`resolve_server_request_on_thread_listener`（`bespoke_event_handling.rs:162-192`）是一个关键的辅助函数。当审批响应从客户端返回后，它通过 `ThreadListenerCommand::ResolveServerRequest` 将对应的 pending request 从线程监听器中移除。使用 `oneshot` channel 确保移除操作完成后再继续处理。

## 事件类型全览

### 直接通知类事件（简单映射）

这些事件直接构造协议通知并发送，无需复杂副作用：

| 内部事件 | 协议通知 | 备注 |
|----------|---------|------|
| `AgentMessageContentDelta` | `AgentMessageDelta` | 流式文本增量 |
| `PlanDelta` | `PlanDelta` | 计划增量 |
| `ContextCompacted` | `ContextCompacted` | 上下文压缩 |
| `DeprecationNotice` | `DeprecationNotice` | 弃用警告 |
| `ReasoningContentDelta` | `ReasoningSummaryTextDelta` | 推理摘要增量 |
| `ReasoningRawContentDelta` | `ReasoningTextDelta` | 原始推理增量 |
| `AgentReasoningSectionBreak` | `ReasoningSummaryPartAdded` | 推理分节 |
| `ModelReroute` | `ModelRerouted` | 模型重路由（V2） |
| `SkillsUpdateAvailable` | `SkillsChanged` | 技能变更（V2） |
| `ThreadNameUpdated` | `ThreadNameUpdated` | 线程名称更新（V2，全局广播） |
| `TurnDiff` | `TurnDiffUpdated` | diff 更新（V2） |
| `PlanUpdate` | `TurnPlanUpdated` | 计划步骤更新（V2） |
| `GuardianAssessment` | `ItemGuardianApprovalReview{Started,Completed}` | Guardian 审批（V2） |
| `HookStarted` / `HookCompleted` | `HookStarted` / `HookCompleted` | Hook 执行（V2） |
| `TerminalInteraction` | `TerminalInteraction` | 终端交互（stdin 发送） |

### 命令执行生命周期

| 内部事件 | 协议通知 | 副作用 |
|----------|---------|--------|
| `ExecCommandBegin` | `ItemStarted(CommandExecution)` | 在 `turn_summary.command_execution_started` 中注册 |
| `ExecCommandOutputDelta` | `CommandExecutionOutputDelta` 或 `FileChangeOutputDelta` | 根据 `file_change_started` 集合判断是命令还是文件变更 |
| `ExecCommandEnd` | `ItemCompleted(CommandExecution)` | 从 `command_execution_started` 中移除 |

### 文件变更生命周期

| 内部事件 | 协议通知 | 副作用 |
|----------|---------|--------|
| `PatchApplyBegin` | `ItemStarted(FileChange)` | 在 `turn_summary.file_change_started` 中注册（去重） |
| `PatchApplyEnd` | `ItemCompleted(FileChange)` | 从 `file_change_started` 中移除 |

### MCP 工具调用

`McpToolCallBegin` 和 `McpToolCallEnd` 分别构造 `ItemStartedNotification` 和 `ItemCompletedNotification`，包含服务器名称、工具名、参数、结果/错误、耗时等信息（`bespoke_event_handling.rs:2782-2848`）。

### 协作 Agent 事件族

模块处理一组完整的多 Agent 协作生命周期事件，每种操作都有 Begin/End 对：

- **Spawn**（`CollabAgentSpawnBegin`/`End`）：创建子 Agent
- **SendInput**（`CollabAgentInteractionBegin`/`End`）：向子 Agent 发送输入
- **Wait**（`CollabWaitingBegin`/`End`）：等待子 Agent 完成
- **Close**（`CollabCloseBegin`/`End`）：关闭子 Agent（End 时还会从 `ThreadWatchManager` 移除线程）
- **Resume**（`CollabResumeBegin`/`End`）：恢复子 Agent

所有这些都映射为 `ThreadItem::CollabAgentToolCall`，通过不同的 `CollabAgentTool` 枚举值（`SpawnAgent`、`SendInput`、`Wait`、`CloseAgent`、`ResumeAgent`）区分。

### Realtime 音频事件

`RealtimeConversationStarted` / `RealtimeConversationRealtime` / `RealtimeConversationClosed` 处理实时音频会话。`RealtimeConversationRealtime` 内部再通过 `RealtimeEvent` 枚举进一步分发：语音检测开始、输入/输出转录增量、音频输出、响应取消、会话项添加、切换请求、错误等（`bespoke_event_handling.rs:369-505`）。

### 错误处理

- **`Error`**（`bespoke_event_handling.rs:1356-1399`）：先检查是否为 `ThreadRollbackFailed` 错误（若是则特殊处理），再检查 `affects_turn_status()`，若影响 turn 状态则记录到 `turn_summary.last_error` 并发送 `ErrorNotification`（`will_retry: false`）。
- **`StreamError`**（`bespoke_event_handling.rs:1400-1416`）：中间重试状态，只发通知不更新 turn summary（`will_retry: true`）。

### Thread Rollback

`ThreadRolledBack`（`bespoke_event_handling.rs:1785-1857`）从 `thread_state.pending_rollbacks` 取出等待的请求 ID，重新从 rollout 文件加载线程摘要和历史 items，构建完整的 `ThreadRollbackResponse` 返回给客户端。

### Token 使用量

`handle_token_count_event`（`bespoke_event_handling.rs:2157-2183`）将 `TokenCountEvent` 拆分为两个独立通知：
- `ThreadTokenUsageUpdated`：输入/输出/缓存 token 数、上下文窗口大小
- `AccountRateLimitsUpdated`：速率限制快照（百分比、窗口、积分余额等）

## 辅助类型

### `CommandExecutionApprovalPresentation`

```rust
enum CommandExecutionApprovalPresentation {
    Network(V2NetworkApprovalContext),
    Command(CommandExecutionCompletionItem),
}
```

> 源码位置：`bespoke_event_handling.rs:151-160`

用于区分命令执行审批是**网络访问审批**还是**常规命令审批**。当 `ExecApprovalRequest` 包含 `network_approval_context` 时走 Network 分支（此时不发送 command/cwd 等字段），否则走 Command 分支。

### `CommandExecutionCompletionItem`

持有命令字符串（经过 `shlex_join` 拼接）、工作目录和解析后的命令动作列表，在审批被拒绝时用于构建 `ItemCompleted` 通知。

## 边界 Case 与注意事项

- **V1/V2 降级策略**：`RequestUserInput`、`RequestPermissions`、`DynamicToolCall` 等在 V1 下不可用，会记录错误日志并提交空/拒绝响应给 Core，确保流程不阻塞。

- **审批失败的保守默认值**：所有审批回调在遇到反序列化错误或通道断开时，都默认为 Denied/Decline/空响应，防止意外授权。

- **`file_change_started` 去重**：`PatchApplyBegin` 和 `ApplyPatchApprovalRequest` 都可能触发 `ItemStarted`，通过 `HashSet::insert` 的返回值确保只发送一次。

- **`ExecCommandOutputDelta` 双用途**：该事件同时服务于命令执行和文件变更（apply_patch），通过检查 `file_change_started` 集合来决定发送 `CommandExecutionOutputDelta` 还是 `FileChangeOutputDelta`。

- **Turn 转换期间的请求中止**：`is_turn_transition_server_request_error` 检测 "turnTransition" 类型的错误，当 turn 切换导致挂起请求被中止时，回调函数会静默返回而非提交拒绝决策。

- **`ThreadRollbackFailed` 短路**：该错误不走常规错误通知路径，而是直接将错误作为 JSON-RPC 错误响应发给发起 rollback 的客户端请求。

- **子命令审批抑制**：当 `approval_id` 存在且对应的父命令仍在执行中时（zsh-fork 子命令场景），拒绝决策不会额外发送 `ItemCompleted`，避免重复关闭父命令项。

- **权限交集保护**：`on_request_permissions_response` 使用 `intersect_permission_profiles` 确保客户端授予的权限不超过最初请求的范围。

## 关键代码片段

### 事件分发核心 match

```rust
let Event { id: event_turn_id, msg } = event;
match msg {
    EventMsg::TurnStarted(payload) => { ... }
    EventMsg::TurnComplete(_ev) => { ... }
    EventMsg::ExecApprovalRequest(ev) => { ... }
    // ... 30+ 分支
    _ => {}
}
```

> 源码位置：`bespoke_event_handling.rs:268-1899`

### Guardian 审批通知构造

```rust
fn guardian_auto_approval_review_notification(
    conversation_id: &ThreadId,
    event_turn_id: &str,
    assessment: &GuardianAssessmentEvent,
) -> ServerNotification {
    let turn_id = if assessment.turn_id.is_empty() {
        event_turn_id.to_string()
    } else {
        assessment.turn_id.clone()
    };
    // 根据 assessment.status 发出 Started 或 Completed 通知
}
```

> 源码位置：`bespoke_event_handling.rs:194-253`

### 权限响应交集计算

```rust
Some(CoreRequestPermissionsResponse {
    permissions: intersect_permission_profiles(
        requested_permissions.into(),
        response.permissions.into(),
    ).into(),
    scope: response.scope.to_core(),
})
```

> 源码位置：`bespoke_event_handling.rs:2501-2508`