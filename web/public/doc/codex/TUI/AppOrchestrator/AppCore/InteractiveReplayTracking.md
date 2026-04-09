# 交互式重播追踪（InteractiveReplayTracking）

## 概述与职责

`PendingInteractiveReplayState` 是 TUI 层线程切换（thread-switching）机制的核心状态追踪器，位于 `AppCore` 内部。当用户在多个 agent 线程之间切换时，TUI 需要重播（replay）目标线程的事件缓冲区快照来恢复 UI 状态。但并非所有事件都应该重播——已经被用户回答或被服务端解决的交互式提示（如命令执行审批、文件变更审批、权限请求、用户输入请求、MCP elicitation）不应再次弹出。本模块正是负责追踪哪些交互式提示仍处于"未解决"状态，以便快照过滤时跳过已完成的提示。

在系统层级中，本模块属于 **TUI → AppOrchestrator → AppCore** 路径下的子模块，被 `ThreadEventStore` 在构建快照时调用。

> 源码位置：`codex-rs/tui/src/app/pending_interactive_replay.rs`

## 关键流程

### 提示的生命周期：注册 → 过滤 → 移除

一个交互式提示的完整生命周期如下：

1. **注册**：当 app-server 发来一个 `ServerRequest`（如 `CommandExecutionRequestApproval`），调用 `note_server_request()` 将其 call ID 同时插入 HashSet（快速查找）和 turn-indexed HashMap（按轮次批量清除）
2. **快照过滤**：线程切换时，`should_replay_snapshot_request()` 检查 HashSet 判断该请求是否仍待处理
3. **移除**：通过以下任一路径移除：
   - 用户在 TUI 中做出决策 → `note_outbound_op()` 处理对应的 `Op` 变体
   - 服务端通知该请求已解决 → `note_server_notification()` 处理 `ServerRequestResolved`
   - 该请求对应的 item 已开始执行 → `note_server_notification()` 处理 `ItemStarted`
   - 轮次完成/中止 → `note_server_notification()` 处理 `TurnCompleted`，批量清除该 turn 下所有残留提示
   - 线程关闭 → `clear()` 清空全部状态
   - 事件从缓冲区中被驱逐 → `note_evicted_server_request()` 移除对应条目

### 用户输入请求的 FIFO 消解

`request_user_input` 类型的提示有一个特殊设计：同一个 `turn_id` 下可能有多个排队的用户输入请求，而 `Op::UserInputAnswer` 只携带 `turn_id` 而不指定具体的 `call_id`。TUI overlay 按 FIFO 顺序回答这些请求，因此 `note_outbound_op()` 对 `UserInputAnswer` 的处理是从 `request_user_input_call_ids_by_turn_id[turn_id]` 的 **头部** 移除最早的 call ID（`call_ids.remove(0)`，即 `codex-rs/tui/src/app/pending_interactive_replay.rs:152`）。

### 双数据结构设计

每种交互式提示类型都维护两种数据结构：

| 数据结构 | 类型 | 用途 |
|---------|------|------|
| `*_call_ids` | `HashSet<String>` | O(1) 查找，用于 `should_replay_snapshot_request()` 快速判断是否仍待处理 |
| `*_call_ids_by_turn_id` | `HashMap<String, Vec<String>>` | 按 turn 分组，用于 `TurnCompleted` / `TurnAborted` 时批量清除一个 turn 下的所有待处理提示 |

此外，`pending_requests_by_request_id: HashMap<AppServerRequestId, PendingInteractiveRequest>` 提供了按 `AppServerRequestId` 的反向索引，用于处理 `ServerRequestResolved` 通知时精确定位并移除对应条目。

## 类型定义

### `PendingInteractiveReplayState`（公开，`pub(super)`）

核心状态结构体，`#[derive(Debug, Default)]`。包含 5 类交互式提示的追踪集合：

```rust
// codex-rs/tui/src/app/pending_interactive_replay.rs:39-50
pub(super) struct PendingInteractiveReplayState {
    exec_approval_call_ids: HashSet<String>,
    exec_approval_call_ids_by_turn_id: HashMap<String, Vec<String>>,
    patch_approval_call_ids: HashSet<String>,
    patch_approval_call_ids_by_turn_id: HashMap<String, Vec<String>>,
    elicitation_requests: HashSet<ElicitationRequestKey>,
    request_permissions_call_ids: HashSet<String>,
    request_permissions_call_ids_by_turn_id: HashMap<String, Vec<String>>,
    request_user_input_call_ids: HashSet<String>,
    request_user_input_call_ids_by_turn_id: HashMap<String, Vec<String>>,
    pending_requests_by_request_id: HashMap<AppServerRequestId, PendingInteractiveRequest>,
}
```

### `PendingInteractiveRequest`（私有枚举）

表示一条待处理的交互式请求，用于 `pending_requests_by_request_id` 的值，支持按 `AppServerRequestId` 反向查找。变体包括：

- `ExecApproval { turn_id, approval_id }` — 命令执行审批
- `PatchApproval { turn_id, item_id }` — 文件变更审批
- `Elicitation(ElicitationRequestKey)` — MCP elicitation
- `RequestPermissions { turn_id, item_id }` — 权限请求
- `RequestUserInput { turn_id, item_id }` — 用户输入请求

### `ElicitationRequestKey`（私有结构体）

MCP elicitation 请求的复合键，由 `server_name: String` 和 `request_id: codex_protocol::mcp::RequestId` 组成。实现了 `Hash` 和 `Eq` 以支持 `HashSet` 存储。

## 函数签名与参数说明

### `op_can_change_state<T: Into<AppCommand>>(op: T) -> bool`

静态方法。判断一个出站操作是否可能影响 pending 状态。返回 `true` 的变体包括：`ExecApproval`、`PatchApproval`、`ResolveElicitation`、`RequestPermissionsResponse`、`UserInputAnswer`、`Shutdown`。调用方可用此方法做快速短路判断，避免不必要的 `note_outbound_op()` 调用。

### `note_outbound_op<T: Into<AppCommand>>(&mut self, op: T)`

处理用户在 TUI 中做出的决策（出站操作）。根据 `AppCommandView` 变体，从 HashSet、turn map 和 request-id map 中移除对应条目。对 `UserInputAnswer` 采用 FIFO 策略（见上文）。`Shutdown` 触发 `clear()`。

### `note_server_request(&mut self, request: &ServerRequest)`

处理从 app-server 收到的新请求。将请求的 call ID 注册到所有相关数据结构中。支持的 `ServerRequest` 变体：

- `CommandExecutionRequestApproval` — 使用 `approval_id`（fallback 到 `item_id`）
- `FileChangeRequestApproval`
- `McpServerElicitationRequest` — 通过 `app_server_request_id_to_mcp_request_id()` 转换 request ID 类型
- `ToolRequestUserInput`
- `PermissionsRequestApproval`

### `note_server_notification(&mut self, notification: &ServerNotification)`

处理服务端通知。响应以下通知类型：

- `ItemStarted(CommandExecution | FileChange)` — item 已开始执行，移除对应审批
- `TurnCompleted` — 批量清除该 turn 下所有类型的待处理提示
- `ServerRequestResolved` — 按 `request_id` 精确移除
- `ThreadClosed` — 调用 `clear()` 清空全部状态

### `note_evicted_server_request(&mut self, request: &ServerRequest)`

当事件缓冲区因容量限制驱逐旧事件时调用。从所有数据结构中移除被驱逐请求对应的条目，确保不会出现"数据结构中追踪了一个已不存在于缓冲区中的请求"的不一致状态。

### `should_replay_snapshot_request(&self, request: &ServerRequest) -> bool`

线程切换时的核心过滤方法。对 5 种交互式请求类型，通过 HashSet 查找判断是否仍然待处理；对其他所有 `ServerRequest` 变体，默认返回 `true`（即始终重播）。

### `has_pending_thread_approvals(&self) -> bool`

检查是否有任何待处理的**审批类**请求（exec、patch、elicitation、permissions）。注意：`request_user_input` **不算作**审批，不参与此判断。这一区分反映了 UI 层面的语义差异——审批会阻塞 agent 执行，而用户输入请求不会。

## 辅助函数

### `app_server_request_id_to_mcp_request_id()`

模块级私有函数（`codex-rs/tui/src/app/pending_interactive_replay.rs:565-572`）。将 `AppServerRequestId`（String 或 Integer 变体）转换为 `codex_protocol::mcp::RequestId`。MCP elicitation 需要这个转换是因为 app-server 协议和 MCP 协议使用不同的 request ID 类型。

### `remove_call_id_from_turn_map()` / `remove_call_id_from_turn_map_entry()`

两个私有辅助方法，用于从 turn-indexed HashMap 中移除 call ID：

- `remove_call_id_from_turn_map` — 不知道 turn_id 时遍历所有 turn 查找并移除（用于 `PatchApproval` 等 outbound op 不携带 turn_id 的场景）
- `remove_call_id_from_turn_map_entry` — 已知 turn_id 时直接定位对应 Vec 移除（更高效）

两者都会在 Vec 清空后自动移除整个 turn 条目，避免空 Vec 残留。

## 边界 Case 与注意事项

- **`approval_id` 与 `item_id` 的 fallback 关系**：`CommandExecutionRequestApproval` 的标识 ID 优先使用 `params.approval_id`，若为 `None` 则 fallback 到 `params.item_id`（`codex-rs/tui/src/app/pending_interactive_replay.rs:176-179`）。这意味着审批的匹配逻辑必须使用同样的 fallback 规则。

- **`UserInputAnswer` 仅携带 `turn_id`**：与其他四种类型不同，用户输入回答不指定具体的 call ID，而是通过 FIFO 顺序隐式绑定。如果同一 turn 下有多个排队请求，每次回答消解最早的一个。

- **`has_pending_thread_approvals()` 不包含 `request_user_input`**：这是有意为之的设计——用户输入请求在语义上不属于"审批"，不会触发 UI 层面的"当前线程有待处理审批"指示。

- **`TurnCompleted` 会清除所有未解决提示**：如果一个 turn 完成了但其中某些审批请求尚未被明确回答，`TurnCompleted` 会将它们全部清除。这避免了过期提示在线程切换时死灰复燃。

- **MCP elicitation 没有 turn-indexed map**：与其他四种类型不同，`elicitation_requests` 只有 HashSet 而没有 `by_turn_id` 的 HashMap。这是因为 elicitation 的 `turn_id` 是 `Option<String>`，且清除路径不依赖于 turn 级别的批量操作。

## 测试覆盖

模块包含 12 个单元测试（`codex-rs/tui/src/app/pending_interactive_replay.rs:574-944`），通过 `ThreadEventStore` 间接测试 `PendingInteractiveReplayState` 的行为。主要验证场景：

| 测试 | 验证点 |
|------|--------|
| `keeps_pending_request_user_input` | 未解决的用户输入请求保留在快照中 |
| `drops_resolved_*_after_user_answer` | 用户回答后从快照中移除 |
| `drops_resolved_*_after_server_resolution` | `ServerRequestResolved` 通知后从快照中移除 |
| `drops_answered_request_user_input_for_multi_prompt_turn` | 同 turn 多请求场景下，只移除已回答的 |
| `keeps_newer_request_user_input_pending_when_same_turn_has_queue` | FIFO 语义验证——回答一个后队列中后续仍保留 |
| `drops_pending_approvals_when_turn_completes` | `TurnCompleted` 批量清除 |
| `drops_resolved_elicitation_after_outbound_resolution` | MCP elicitation 的解决路径 |
| `reports_pending_thread_approvals` | `has_pending_thread_approvals()` 正确反映状态变化 |
| `request_user_input_does_not_count_as_pending_thread_approval` | 用户输入不算审批 |
| `drops_pending_requests_when_thread_closes` | 线程关闭清空所有状态 |