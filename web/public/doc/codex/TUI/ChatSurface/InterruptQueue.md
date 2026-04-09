# InterruptQueue — 中断事件队列

## 概述与职责

InterruptQueue 模块位于 **TUI → ChatSurface** 层级下，是 `ChatWidget` 的内部子模块，负责解决一个经典的并发 UI 问题：**当 ChatWidget 正处于写入周期（write cycle）时，来自协议层的中断性事件不能立即处理，需要缓冲并在写入周期结束后按 FIFO 顺序逐一分发。**

该模块由两个核心类型组成：

- **`QueuedInterrupt`**：一个枚举，统一建模了 10 种可能的中断事件类型
- **`InterruptManager`**：一个基于 `VecDeque` 的 FIFO 队列管理器，提供入队和批量刷新接口

在整体架构中，ChatSurface 通过 `ChatWidget` 驱动对话视口的渲染与交互。当 agent 会话产生需要 UI 响应的事件（如工具调用审批、权限请求等），这些事件可能恰好在 UI 正在更新的过程中到达。InterruptManager 充当缓冲层，确保这些事件不会被丢弃，也不会在 UI 不一致的状态下被处理。

## 关键流程

### 中断事件的缓冲与刷新流程

1. **事件到达**：协议层产生一个中断事件（如 `ExecApprovalRequestEvent`）
2. **入队缓冲**：`ChatWidget` 判断当前正处于写入周期，调用 `InterruptManager` 对应的 `push_*` 方法将事件包装为 `QueuedInterrupt` 枚举变体，压入 `VecDeque` 尾部
3. **写入周期完成**：`ChatWidget` 的写入周期结束后，调用 `flush_all()` 
4. **按序分发**：`flush_all()` 从队列头部逐个弹出事件（`pop_front`），通过 `match` 分发到 `ChatWidget` 上对应的 `handle_*_now()` 方法（`codex-rs/tui/src/chatwidget/interrupts.rs:89-104`）
5. **队列清空**：所有缓冲的事件处理完毕，队列恢复为空

整个过程保证了事件的**先入先出顺序**和**原子性处理**——要么全部刷新，要么保持排队。

## 类型定义

### `QueuedInterrupt` 枚举

定义于 `codex-rs/tui/src/chatwidget/interrupts.rs:17-28`，包含 10 个变体，每个变体包装一个来自 `codex_protocol` 的事件结构体：

| 变体 | 包装类型 | 含义 |
|------|---------|------|
| `ExecApproval` | `ExecApprovalRequestEvent` | 命令执行审批请求 |
| `ApplyPatchApproval` | `ApplyPatchApprovalRequestEvent` | 补丁应用审批请求 |
| `Elicitation` | `ElicitationRequestEvent` | MCP 服务器向用户请求信息 |
| `RequestPermissions` | `RequestPermissionsEvent` | 权限请求事件 |
| `RequestUserInput` | `RequestUserInputEvent` | 向用户请求输入 |
| `ExecBegin` | `ExecCommandBeginEvent` | 命令开始执行通知 |
| `ExecEnd` | `ExecCommandEndEvent` | 命令执行结束通知 |
| `McpBegin` | `McpToolCallBeginEvent` | MCP 工具调用开始通知 |
| `McpEnd` | `McpToolCallEndEvent` | MCP 工具调用结束通知 |
| `PatchEnd` | `PatchApplyEndEvent` | 补丁应用结束通知 |

这些变体可以分为两类：
- **需要用户交互的**：`ExecApproval`、`ApplyPatchApproval`、`Elicitation`、`RequestPermissions`、`RequestUserInput` — 会弹出审批对话框或输入表单
- **状态通知类的**：`ExecBegin`、`ExecEnd`、`McpBegin`、`McpEnd`、`PatchEnd` — 用于更新 UI 中的执行状态显示

### `InterruptManager` 结构体

定义于 `codex-rs/tui/src/chatwidget/interrupts.rs:31-33`，内部仅持有一个 `VecDeque<QueuedInterrupt>` 字段。

## 函数签名与参数说明

### `InterruptManager::new() -> Self`

构造一个空的中断管理器。（`codex-rs/tui/src/chatwidget/interrupts.rs:36-40`）

### `InterruptManager::is_empty(&self) -> bool`

检查队列是否为空。标记为 `#[inline]`，用于 `ChatWidget` 判断写入周期结束后是否需要调用 `flush_all()`。（`codex-rs/tui/src/chatwidget/interrupts.rs:42-45`）

### `InterruptManager::push_*(&mut self, ev: T)`

10 个类型化的入队方法（`codex-rs/tui/src/chatwidget/interrupts.rs:47-87`），每个方法接受对应的事件类型，将其包装为 `QueuedInterrupt` 变体后 `push_back` 到队列：

- `push_exec_approval(ev: ExecApprovalRequestEvent)`
- `push_apply_patch_approval(ev: ApplyPatchApprovalRequestEvent)`
- `push_elicitation(ev: ElicitationRequestEvent)`
- `push_request_permissions(ev: RequestPermissionsEvent)`
- `push_user_input(ev: RequestUserInputEvent)`
- `push_exec_begin(ev: ExecCommandBeginEvent)`
- `push_exec_end(ev: ExecCommandEndEvent)`
- `push_mcp_begin(ev: McpToolCallBeginEvent)`
- `push_mcp_end(ev: McpToolCallEndEvent)`
- `push_patch_end(ev: PatchApplyEndEvent)`

### `InterruptManager::flush_all(&mut self, chat: &mut ChatWidget)`

批量刷新方法（`codex-rs/tui/src/chatwidget/interrupts.rs:89-104`）。以 `while let` 循环从队列头部逐个弹出事件，通过模式匹配分发到 `ChatWidget` 上对应的即时处理方法：

| 队列变体 | 分发到 |
|---------|--------|
| `ExecApproval` | `chat.handle_exec_approval_now()` |
| `ApplyPatchApproval` | `chat.handle_apply_patch_approval_now()` |
| `Elicitation` | `chat.handle_elicitation_request_now()` |
| `RequestPermissions` | `chat.handle_request_permissions_now()` |
| `RequestUserInput` | `chat.handle_request_user_input_now()` |
| `ExecBegin` | `chat.handle_exec_begin_now()` |
| `ExecEnd` | `chat.handle_exec_end_now()` |
| `McpBegin` | `chat.handle_mcp_begin_now()` |
| `McpEnd` | `chat.handle_mcp_end_now()` |
| `PatchEnd` | `chat.handle_patch_apply_end_now()` |

注意 `flush_all` 接受 `&mut ChatWidget`，而非 `&mut self` 上的方法自引用——这是因为 `InterruptManager` 作为 `ChatWidget` 的一个字段存在，Rust 的借用规则要求将两者拆分为独立的可变引用。

## 边界 Case 与注意事项

- **可见性**：所有类型和方法均为 `pub(crate)`，仅在 TUI crate 内部使用，不对外暴露
- **非异步设计**：所有方法都是同步的。`flush_all` 在调用线程上同步执行所有 `handle_*_now()` 方法，这意味着刷新过程中如果某个处理器耗时较长，会阻塞后续事件的处理
- **顺序保证**：`VecDeque` + `push_back`/`pop_front` 的组合严格保证 FIFO 顺序，这对于 `ExecBegin` → `ExecEnd` 这类配对事件的正确处理至关重要
- **`Default` derive**：`InterruptManager` 同时提供了 `#[derive(Default)]` 和手动实现的 `new()`，两者语义等价