# ServerEventAdapter

## 概述与职责

ServerEventAdapter 是 TUI 与 app-server 之间的**混合迁移适配层**，位于 `codex-rs/tui/src/app/app_server_adapter.rs`。它在 TUI 逐步迁移到 app-server 架构的过渡期间，负责将 app-server 产生的事件翻译为 TUI 能消费的状态变更。

在系统层级中，该模块属于 **TUI → AppOrchestrator → AppCore** 路径下的子模块。它作为 `App` 结构体的 `impl` 扩展存在，使得过渡期逻辑与主编排代码 (`app.rs`) 保持分离。正如模块头部注释所说："随着更多 TUI 流程直接迁移到 app-server 表面，这个适配器应当逐步缩小并最终消失。"

同级模块包括 EntryAndCLI（入口与 CLI 参数解析）、EventBus（内部消息总线）、Backtracking（回溯状态机）、ServerSession（会话包装）和 UpdateCheck（版本检查）。

## 关键流程

### 顶层事件分发：`handle_app_server_event`

这是适配层的入口函数，处理从 app-server 事件流接收到的所有 `AppServerEvent`。四种变体各有不同处理路径：

1. **`Lagged { skipped }`**：事件消费者落后，部分事件被丢弃。记录警告日志后，刷新 MCP 启动服务器列表并通知 `chat_widget` 完成 MCP 启动恢复（`app_server_adapter.rs:130-137`）

2. **`ServerNotification(notification)`**：委托给 `handle_server_notification_event` 进行通知路由（`app_server_adapter.rs:138-141`）

3. **`ServerRequest(request)`**：委托给 `handle_server_request_event` 进行请求路由（`app_server_adapter.rs:142-145`）

4. **`Disconnected { message }`**：连接断开，向聊天界面添加错误消息并发送 `FatalExitRequest` 事件，触发应用退出（`app_server_adapter.rs:146-151`）

### 通知路由：`handle_server_notification_event`

通知处理分为三个阶段：

**阶段一：全局前置拦截**（`app_server_adapter.rs:159-188`）

四种通知在进入线程路由之前被优先处理：

| 通知类型 | 处理方式 |
|---------|---------|
| `ServerRequestResolved` | 从 `pending_app_server_requests` 中移除已解决的请求 |
| `McpServerStatusUpdated` | 从配置刷新已启用的 MCP 服务器列表 |
| `AccountRateLimitsUpdated` | 转换速率限制快照并更新 `chat_widget`，然后 **提前返回** |
| `AccountUpdated` | 更新账户显示状态（含 ChatGPT 认证模式检测），然后 **提前返回** |

**阶段二：线程目标解析**（`app_server_adapter.rs:190-214`）

调用 `server_notification_thread_target()` 判断通知的目标线程：
- `Thread(thread_id)`：分发到主线程或对应子线程的事件通道
- `InvalidThreadId`：记录警告并丢弃
- `Global`：落入阶段三

**阶段三：全局通知透传**（`app_server_adapter.rs:216-218`）

无线程归属的通知直接交给 `chat_widget.handle_server_notification()` 处理。

### 请求路由：`handle_server_request_event`

请求处理流程（`app_server_adapter.rs:220-263`）：

1. 调用 `pending_app_server_requests.note_server_request()` 记录请求。如果返回 `Some(unsupported)`，说明该请求类型不受支持——记录警告、在 UI 显示错误、调用 `reject_app_server_request` 以 JSON-RPC 错误码 `-32000` 拒绝请求，然后提前返回

2. 调用 `server_request_thread_id()` 提取请求的目标线程 ID。无线程的请求（如 `ChatgptAuthTokensRefresh`、旧式 `ApplyPatchApproval`、`ExecCommandApproval`）被静默忽略

3. 根据线程 ID 分发：若匹配主线程则入队 `enqueue_primary_thread_request`，否则入队 `enqueue_thread_request`

### 请求拒绝

`reject_app_server_request`（`app_server_adapter.rs:264-281`）通过 `AppServerSession` 发送 JSON-RPC 错误响应：

```rust
JSONRPCErrorError {
    code: -32000,
    message: reason,
    data: None,
}
```

## 函数签名

### `App::handle_app_server_event(&mut self, app_server_client: &AppServerSession, event: AppServerEvent)`

适配层主入口。`pub(super)` 可见性，异步执行。根据 `AppServerEvent` 变体分发到对应处理器。

> 源码位置：`app_server_adapter.rs:124-152`

### `App::handle_server_notification_event(&mut self, _app_server_client: &AppServerSession, notification: ServerNotification)`

通知路由核心。先拦截全局通知（账户/速率限制/MCP/请求解析），再按线程目标分发。

> 源码位置：`app_server_adapter.rs:154-218`

### `App::handle_server_request_event(&mut self, app_server_client: &AppServerSession, request: ServerRequest)`

请求路由核心。验证支持性、提取线程 ID、入队到正确线程。

> 源码位置：`app_server_adapter.rs:220-263`

### `App::refresh_mcp_startup_expected_servers_from_config(&mut self)`

从配置中读取已启用的 MCP 服务器名称列表，更新 `chat_widget` 的启动预期服务器集。

> 源码位置：`app_server_adapter.rs:111-122`

## 接口与类型定义

### `ServerNotificationThreadTarget`

线程目标解析结果枚举（`app_server_adapter.rs:310-315`）：

```rust
enum ServerNotificationThreadTarget {
    Thread(ThreadId),        // 通知属于特定线程
    InvalidThreadId(String), // thread_id 字符串无法解析为有效 UUID
    Global,                  // 通知无线程归属，为全局事件
}
```

### `server_notification_thread_target(notification: &ServerNotification) -> ServerNotificationThreadTarget`

核心路由函数。通过一个大型 `match` 对约 35 种 `ServerNotification` 变体进行分类（`app_server_adapter.rs:317-424`）：

- **线程绑定通知**（返回 `Some(thread_id)`）：`Error`、`ThreadStarted`、`ThreadStatusChanged`、`ThreadArchived`/`Unarchived`/`Closed`、`ThreadNameUpdated`、`ThreadTokenUsageUpdated`、`TurnStarted`/`Completed`、`HookStarted`/`Completed`、`TurnDiffUpdated`/`PlanUpdated`、`ItemStarted`/`Completed`、`ItemGuardianApproval*`、`RawResponseItemCompleted`、`AgentMessageDelta`、`PlanDelta`、各类 `CommandExecution*`/`FileChange*`/`TerminalInteraction`、`McpToolCallProgress`、`ReasoningSummary*`/`ReasoningText*`、`ContextCompacted`、`ModelRerouted`、`ThreadRealtime*` 系列

- **全局通知**（返回 `None`）：`SkillsChanged`、`McpServerStatusUpdated`/`OauthLoginCompleted`、`AccountUpdated`/`RateLimitsUpdated`、`AppListUpdated`、`DeprecationNotice`、`ConfigWarning`、`FuzzyFileSearch*`、`CommandExecOutputDelta`、`FsChanged`、`Windows*` 系列、`AccountLoginCompleted`

### `server_request_thread_id(request: &ServerRequest) -> Option<ThreadId>`

从 `ServerRequest` 变体中提取线程 ID（`app_server_adapter.rs:284-308`）：

| 请求类型 | 有 thread_id |
|---------|:-----------:|
| `CommandExecutionRequestApproval` | 是 |
| `FileChangeRequestApproval` | 是 |
| `ToolRequestUserInput` | 是 |
| `McpServerElicitationRequest` | 是 |
| `PermissionsRequestApproval` | 是 |
| `DynamicToolCall` | 是 |
| `ChatgptAuthTokensRefresh` | 否 |
| `ApplyPatchApproval`（旧式） | 否 |
| `ExecCommandApproval`（旧式） | 否 |

## 通知到协议事件的转换（测试基础设施）

文件中包含大量 `#[cfg(test)]` 标记的函数，构成了从 app-server 协议类型到 TUI 核心协议 `Event` 的完整转换层。这些函数虽然仅在测试中编译，但定义了关键的语义映射逻辑。

### `server_notification_thread_events(notification) -> Option<(ThreadId, Vec<Event>)>`

将单个 `ServerNotification` 转换为一组 TUI `Event`（`app_server_adapter.rs:453-647`）。支持的映射包括：

| ServerNotification | EventMsg |
|---|---|
| `ThreadTokenUsageUpdated` | `TokenCount` |
| `Error` | `Error` |
| `ThreadNameUpdated` | `ThreadNameUpdated` |
| `TurnStarted` | `TurnStarted` |
| `TurnCompleted` | 根据状态：`TurnComplete` / `TurnAborted` / `Error` + `TurnComplete` |
| `ItemStarted` (CommandExecution) | `ExecCommandBegin` |
| `ItemStarted` (其他) | `ItemStarted` |
| `ItemCompleted` (CommandExecution) | `ExecCommandEnd` |
| `ItemCompleted` (其他) | `ItemCompleted` |
| `CommandExecutionOutputDelta` | `ExecCommandOutputDelta` |
| `AgentMessageDelta` | `AgentMessageDelta` |
| `PlanDelta` | `PlanDelta` |
| `ReasoningSummaryTextDelta` | `AgentReasoningDelta` |
| `ReasoningTextDelta` | `AgentReasoningRawContentDelta` |
| `ThreadRealtimeStarted` | `RealtimeConversationStarted` |
| `ThreadRealtimeItemAdded` | `RealtimeConversationRealtime` |
| `ThreadRealtimeOutputAudioDelta` | `RealtimeConversationRealtime(AudioOut)` |
| `ThreadRealtimeError` | `RealtimeConversationRealtime(Error)` |
| `ThreadRealtimeClosed` | `RealtimeConversationClosed` |

### `thread_snapshot_events(thread, show_raw_agent_reasoning) -> Vec<Event>`

将完整 `Thread` 快照展开为事件序列，用于会话恢复 (resume/restore) 场景（`app_server_adapter.rs:433-450`）。对每个 Turn 调用 `turn_snapshot_events`。

### `turn_snapshot_events(thread_id, turn, show_raw_agent_reasoning) -> Vec<Event>`

展开单个 Turn 为 TUI 事件序列（`app_server_adapter.rs:670-724`）：

1. 发出 `TurnStarted` 事件
2. 遍历 Turn 中的所有 Item：
   - `CommandExecution` → `ExecCommandBegin` + `ExecCommandEnd`（走专用路径）
   - `UserMessage` / `Plan` / `AgentMessage` → `ItemCompleted`（已提交语义）
   - `Reasoning` / `WebSearch` / `ImageGeneration` / `ContextCompaction` → 通过 `as_legacy_events()` 生成旧式事件（这些类型的渲染仍依赖旧事件驱动）
   - `HookPrompt` → 跳过
3. 追加终止事件（`append_terminal_turn_events`）

### `append_terminal_turn_events(events, turn, include_failed_error)`

根据 `TurnStatus` 追加终止事件（`app_server_adapter.rs:737-778`）：

| TurnStatus | 生成的事件 |
|-----------|-----------|
| `Completed` | `TurnComplete` |
| `Interrupted` | `TurnAborted { reason: Interrupted }` |
| `Failed` | 可选 `Error` + `TurnComplete` |
| `InProgress` | 无事件（Turn 仍在进行中） |

### `thread_item_to_core(item: &ThreadItem) -> Option<TurnItem>`

将 app-server 的 `ThreadItem` 转换为核心协议的 `TurnItem`（`app_server_adapter.rs:781-867`）。支持 `UserMessage`、`AgentMessage`（含 `memory_citation` 水合）、`Plan`、`Reasoning`、`WebSearch`、`ImageGeneration`、`ContextCompaction`。不支持的类型（`CommandExecution`、`FileChange`、`McpToolCall`、`DynamicToolCall`、`CollabAgentToolCall` 等）返回 `None` 并记录 debug 日志。

## 边界 Case 与注意事项

- **无效线程 ID 处理**：`server_notification_thread_target` 和 `server_request_thread_id` 都使用 `ThreadId::from_string()` 解析 UUID。解析失败时，通知路径记录警告并丢弃，请求路径返回 `None` 导致请求被忽略

- **主线程回退**：当 `self.primary_thread_id` 为 `None` 时（应用尚未建立主线程），事件一律走主线程路径入队（`app_server_adapter.rs:192-194, 255`）

- **旧式请求类型**：`ApplyPatchApproval` 和 `ExecCommandApproval` 被 `server_request_thread_id` 返回 `None`，从而被静默跳过——这些是已废弃的旧核心协议遗留

- **`AccountRateLimitsUpdated` 和 `AccountUpdated`** 在线程路由之前就提前返回，因为它们是纯全局状态更新，不需要进入线程分发逻辑

- **`Lagged` 事件恢复**：丢失事件后立即刷新 MCP 服务器列表并通知 `chat_widget`，确保 MCP 启动状态不会因事件丢失而卡住

- **`include_failed_error` 参数**：`append_terminal_turn_events` 的布尔参数控制失败 Turn 是否生成 `Error` 事件。快照回放传 `true`（需要完整还原历史），实时 `TurnCompleted` 通知传 `false`（错误已在 `Error` 通知中单独发送过）

- **命令执行 InProgress 状态**：`command_execution_completed_event` 对状态为 `InProgress` 的 item 返回空 Vec，避免在 Turn 仍在运行时生成虚假完成事件（`app_server_adapter.rs:921-926`）

## 测试覆盖

模块包含约 550 行测试代码（`app_server_adapter.rs:1007-1590`），覆盖以下场景：

- **通知桥接**：`AgentMessage` 完成、`TurnCompleted`（完成/中断/失败三种状态）、文本增量 delta（agent message 和 reasoning summary）
- **命令执行全生命周期**：`ItemStarted` → `OutputDelta` → `ItemCompleted` 的完整事件序列桥接
- **Windows 路径兼容**：含空格和反斜杠的 Windows 路径命令字符串不丢失
- **线程快照回放**：多 Turn 快照（含 completed/interrupted/failed 状态混合）展开为正确的事件序列
- **非消息类型项回放**：Reasoning、WebSearch、ImageGeneration、ContextCompaction 通过 legacy 事件正确回放
- **原始推理内容**：`show_raw_agent_reasoning` 开关控制是否额外生成 `AgentReasoningRawContent` 事件