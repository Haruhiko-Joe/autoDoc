# Op 提交与请求解析

## 概述与职责

本模块是 TUI 应用状态机（`App`）中负责**将用户操作（Op）提交到 app-server 并解析挂起请求**的核心子系统。它位于 `AppOrchestrator > AppCore > MainEventLoop` 层级中，是 TUI 侧与 app-server 通信的出口——所有用户在聊天界面发起的操作（发送消息、审批工具调用、中断回合等）都通过此模块路由到 app-server。

在整体架构中，本模块与以下兄弟模块协作：
- **ServerEventAdapter**：负责入站事件（app-server → TUI），本模块则负责出站操作（TUI → app-server）
- **PendingRequests**：维护挂起的 app-server 请求映射表，本模块调用其 `take_resolution()` 来关联出站 Op 与挂起请求
- **InteractiveReplayTracking**：追踪未解决的交互式提示，本模块在 Op 提交后更新其状态

## 关键流程

### Op 提交的三层路由

`submit_thread_op()` 是所有 Op 的统一入口（`app.rs:1839-1872`）。它实现了一个**三层优先级路由**：

1. **本地历史拦截**（`try_handle_local_history_op`）：检查 Op 是否为 composer 历史操作（`AddToHistory` 或 `GetHistoryEntryRequest`），如果是则直接操作本地 `history.jsonl`，无需经过 app-server
2. **挂起请求解析**（`try_resolve_app_server_request`）：检查 Op 是否对应一个已挂起的 app-server 请求（如审批回复），如果是则将 Op 转换为请求响应发送给 app-server
3. **app-server 提交**（`try_submit_active_thread_op_via_app_server`）：将 Op 转换为对应的 app-server 协议方法调用（如 `turn_start`、`turn_steer`、`turn_interrupt` 等）

如果三层都未处理该 Op，则显示 "Not available in TUI yet" 错误信息。

```
submit_active_thread_op(op)
  └─ submit_thread_op(thread_id, op)
       ├─ try_handle_local_history_op()     → 本地处理，不走网络
       ├─ try_resolve_app_server_request()  → 关联到挂起请求并回复
       └─ try_submit_active_thread_op_via_app_server() → 发送到 app-server
```

### Steer 竞态重试机制

当用户在模型回合进行中提交新消息时，`try_submit_active_thread_op_via_app_server` 会尝试 **steer**（转向）而非启动新回合（`app.rs:2236-2298`）。该流程处理了两种竞态场景：

1. **`ActiveTurnSteerRace::Missing`**：app-server 报告当前无活跃回合（可能已在 TUI 感知前结束）。此时清除本地缓存的 `active_turn_id`，回退到 `turn_start` 启动新回合
2. **`ActiveTurnSteerRace::ExpectedTurnMismatch`**：本地缓存的 turn ID 与 server 实际的不一致（常见于 Review 流程切换了活跃回合）。从 server 错误消息中提取实际 turn ID，更新本地缓存并**重试一次**。若重试仍失败则报错

此外，`active_turn_not_steerable_turn_error()` 检测 server 返回的结构化错误（如 `ActiveTurnNotSteerable`，典型场景：Review 回合不可 steer），此时将被拒绝的 steer 入队或显示错误信息（`app.rs:1031-1041`）。

### 挂起请求解析流程

`try_resolve_app_server_request()`（`app.rs:2404-2436`）将出站 Op 关联到 app-server 发来的挂起请求：

1. 调用 `PendingAppServerRequests::take_resolution(op)` 尝试匹配——它检查 Op 类型（如 `ExecApproval`、`PatchApproval`、`UserInputAnswer` 等）是否对应某个挂起的审批/权限/输入请求
2. 匹配成功时，调用 `app_server.resolve_server_request()` 发送响应
3. 如果该 Op 可能改变交互式重放状态（`op_can_change_pending_replay_state`），同时更新 `InteractiveReplayTracking` 并刷新跨线程审批状态

### 跨线程审批刷新

`refresh_pending_thread_approvals()`（`app.rs:2438-2465`）在每次 Op 提交后被调用，扫描所有**非活跃线程**的事件存储：

1. 遍历所有 `thread_event_channels`，跳过当前活跃线程
2. 检查每个线程的 `PendingInteractiveReplayState` 是否存在未解决的审批（exec 审批、patch 审批、权限请求、MCP elicitation）
3. 收集有挂起审批的线程 ID 并排序
4. 通过 `chat_widget.set_pending_thread_approvals()` 将结果传递给 UI 底栏，以线程级交互式请求的形式展示

这使得用户即使聚焦在主线程，也能感知到子 agent 线程中等待审批的操作。

## 函数签名与参数说明

### `submit_active_thread_op(&mut self, app_server, op) -> Result<()>`

便捷入口，自动使用当前活跃线程 ID 调用 `submit_thread_op`。若无活跃线程，在 chat 中显示错误。

> 源码位置：`codex-rs/tui/src/app.rs:1825-1837`

### `submit_thread_op(&mut self, app_server, thread_id, op) -> Result<()>`

核心路由函数。按优先级依次尝试三种处理方式。每次成功的 Op 提交都会记录到 session log。

- **app_server**: `&mut AppServerSession` — app-server 会话句柄
- **thread_id**: `ThreadId` — 目标线程
- **op**: `AppCommand` — 待提交的操作命令

> 源码位置：`codex-rs/tui/src/app.rs:1839-1872`

### `try_handle_local_history_op(&mut self, thread_id, op) -> Result<bool>`

拦截 `AddToHistory` 和 `GetHistoryEntryRequest` 两种 Op，直接操作本地 `$CODEX_HOME/history.jsonl`。返回 `true` 表示已处理。

- `AddToHistory`：异步写入历史文件（fire-and-forget）
- `GetHistoryEntryRequest`：在 blocking 线程中查找历史条目，通过 `AppEvent::ThreadHistoryEntryResponse` 回传结果

> 源码位置：`codex-rs/tui/src/app.rs:2149-2205`

### `try_submit_active_thread_op_via_app_server(&mut self, app_server, thread_id, op) -> Result<bool>`

将 `AppCommand` 转换为 app-server 协议调用。支持的操作类型：

| AppCommandView 变体 | app-server 方法 |
|---|---|
| `Interrupt` | `turn_interrupt` |
| `UserTurn` | `turn_steer` 或 `turn_start` |
| `ListSkills` | `skills_list` |
| `Compact` | `thread_compact_start` |
| `SetThreadName` | `thread_set_name` |
| `ThreadRollback` | `thread_rollback` |
| `Review` | `review_start` |
| `CleanBackgroundTerminals` | `thread_background_terminals_clean` |
| `RealtimeConversation*` | `thread_realtime_*` |
| `RunUserShellCommand` | `thread_shell_command` |
| `ReloadUserConfig` | `reload_user_config` |

返回 `false` 表示该 Op 类型不受支持。

> 源码位置：`codex-rs/tui/src/app.rs:2207-2402`

### `try_resolve_app_server_request(&mut self, app_server, thread_id, op) -> Result<bool>`

尝试将 Op 匹配到挂起的 app-server 请求。通过 `PendingAppServerRequests::take_resolution()` 进行关联，成功后调用 `resolve_server_request()` 发送响应。

> 源码位置：`codex-rs/tui/src/app.rs:2404-2436`

### `refresh_pending_thread_approvals(&mut self)`

扫描所有非活跃线程通道，收集有挂起审批的线程并更新 UI 显示。

> 源码位置：`codex-rs/tui/src/app.rs:2438-2465`

### `interactive_request_for_thread_request(&self, thread_id, request) -> Option<ThreadInteractiveRequest>`

将 app-server 的 `ServerRequest` 转换为 TUI 可渲染的 `ThreadInteractiveRequest`。支持四种请求类型：

- `CommandExecutionRequestApproval` → `ApprovalRequest::Exec`（含网络审批上下文、权限、执行策略修正）
- `FileChangeRequestApproval` → `ApprovalRequest::ApplyPatch`
- `McpServerElicitationRequest` → `ThreadInteractiveRequest::McpServerElicitation` 或 `ApprovalRequest::McpElicitation`
- `PermissionsRequestApproval` → `ApprovalRequest::Permissions`

> 源码位置：`codex-rs/tui/src/app.rs:1711-1823`

## 辅助函数

### `active_turn_not_steerable_turn_error(error) -> Option<AppServerTurnError>`

从 `TypedRequestError` 中提取结构化的 "active turn not steerable" 错误信息。用于识别 Review 回合等不可 steer 的场景。

> 源码位置：`codex-rs/tui/src/app.rs:1031-1041`

### `active_turn_steer_race(error) -> Option<ActiveTurnSteerRace>`

解析 `turn/steer` 错误消息，识别两种竞态：
- `"no active turn to steer"` → `ActiveTurnSteerRace::Missing`
- `"expected active turn id ... but found ..."` → `ActiveTurnSteerRace::ExpectedTurnMismatch`（从消息中提取实际 turn ID）

> 源码位置：`codex-rs/tui/src/app.rs:1049-1072`

### `note_thread_outbound_op(&mut self, thread_id, op)`

将出站 Op 记录到对应线程的 `ThreadEventStore` 中，供 `InteractiveReplayTracking` 使用。

> 源码位置：`codex-rs/tui/src/app.rs:1631-1637`

## 类型定义

### `ActiveTurnSteerRace`

```rust
enum ActiveTurnSteerRace {
    Missing,
    ExpectedTurnMismatch { actual_turn_id: String },
}
```

表示 steer 操作遇到的两种竞态场景。`Missing` 意味着活跃回合已结束，`ExpectedTurnMismatch` 意味着 TUI 缓存的 turn ID 过时。

> 源码位置：`codex-rs/tui/src/app.rs:1043-1047`

## 边界 Case 与注意事项

- **Steer 仅重试一次**：当遇到 `ExpectedTurnMismatch` 时，通过 `retried_after_turn_mismatch` 标志确保只重试一次。如果重试后仍不匹配，直接返回错误而非无限循环
- **本地历史操作是 fire-and-forget**：`AddToHistory` 的写入在独立 `tokio::spawn` 中执行，失败仅记录 warning 日志而不阻塞 UI
- **`GetHistoryEntryRequest` 使用 `spawn_blocking`**：历史查找涉及文件 I/O，在 blocking 线程池中执行以避免阻塞 async runtime
- **审批刷新跳过活跃线程**：`refresh_pending_thread_approvals` 有意排除当前活跃线程，因为活跃线程的审批已经直接显示在 chat UI 中，只有非活跃线程的审批需要作为 thread-level 提示呈现
- **Op 提交后的状态同步**：成功提交的 Op 会同时更新 `InteractiveReplayTracking`（通过 `note_thread_outbound_op`）和审批指示器（通过 `refresh_pending_thread_approvals`），保证 UI 状态与 server 端一致
- **被拒绝的 steer 入队处理**：当 steer 遇到 `ActiveTurnNotSteerable` 错误时，`enqueue_rejected_steer()` 尝试将消息入队等待回合结束后重新提交，而非直接丢弃用户输入