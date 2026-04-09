# BottomPane 编排层

## 概述与职责

`BottomPane` 是 TUI 聊天界面底部的**交互容器**，位于 `TUI > BottomPane` 模块层级中。它的上级是 `ChatSurface`（主聊天视图），同级兄弟模块包括 `AppOrchestrator`、`ContentRendering`、`TerminalRuntime`、`Onboarding`、`PickersAndStatus` 和 `SharedUtilities`。

`BottomPane` 承担两大核心职责：

1. **视图栈状态机**：管理一个 `Vec<Box<dyn BottomPaneView>>` 栈，栈顶是当前活跃的模态弹窗/覆盖层（如审批对话框、文件搜索弹窗、斜杠命令菜单等）。当栈为空时，用户直接与底层的 `ChatComposer`（可编辑的提示输入框）交互。
2. **分层输入路由**：将键盘事件、粘贴事件、Ctrl-C/Esc 取消信号等分发到正确的目标——栈顶视图优先，否则落入 composer。

该模块还定义了 `BottomPaneView` trait（所有弹窗/模态视图的接口契约）、共享常量（退出超时、弹窗尺寸）、取消事件枚举以及通用滚动状态辅助结构。

## 关键流程

### 1. 键盘事件路由 (`handle_key_event`)

这是 `BottomPane` 最核心的方法，实现了分层输入路由的完整逻辑（`codex-rs/tui/src/bottom_pane/mod.rs:373-448`）：

1. **视图栈非空时**：过滤掉 `KeyEventKind::Release` 事件，然后：
   - 如果按下 `Esc` 且视图未声明 `prefer_esc_to_handle_key_event()`，先调用 `on_ctrl_c()` 尝试让视图自行处理取消
   - 如果视图取消后标记为 `is_complete()`，则弹出栈顶视图
   - 否则将按键转发给视图的 `handle_key_event()`
   - 如果视图处于 paste-burst 状态，调度一次延迟重绘
   - 如果 `ctrl_c_completed`，仅弹出栈顶（保留下层视图）；如果视图自身 `complete`，则**清空整个栈**

2. **视图栈为空时**（composer 模式）：
   - 特判：如果任务正在运行且有 status indicator，`Esc` 会触发中断（`status.interrupt()`），而非传给 composer
   - 否则将事件转发给 `ChatComposer::handle_key_event()`
   - 若 composer 处于 paste-burst，调度延迟重绘

```rust
// codex-rs/tui/src/bottom_pane/mod.rs:383-398
let (ctrl_c_completed, view_complete, view_in_paste_burst) = {
    let last_index = self.view_stack.len() - 1;
    let view = &mut self.view_stack[last_index];
    let prefer_esc =
        key_event.code == KeyCode::Esc && view.prefer_esc_to_handle_key_event();
    let ctrl_c_completed = key_event.code == KeyCode::Esc
        && !prefer_esc
        && matches!(view.on_ctrl_c(), CancellationEvent::Handled)
        && view.is_complete();
    if ctrl_c_completed {
        (true, true, false)
    } else {
        view.handle_key_event(key_event);
        (false, view.is_complete(), view.is_in_paste_burst())
    }
};
```

### 2. Ctrl-C 取消分发 (`on_ctrl_c`)

`on_ctrl_c()` 方法实现了三级取消逻辑（`codex-rs/tui/src/bottom_pane/mod.rs:458-479`）：

1. **栈顶视图存在**：调用视图的 `on_ctrl_c()`。若视图处理了取消且标记完成，弹出栈顶。返回 `CancellationEvent::Handled`。
2. **Composer 不为空**：清空 composer 输入内容，返回 `Handled`。
3. **Composer 为空**：返回 `NotHandled`，让上层 `ChatWidget` 决定是否触发退出流程。

### 3. 粘贴路由 (`handle_paste`)

粘贴事件同样遵循栈优先原则（`codex-rs/tui/src/bottom_pane/mod.rs:481-502`）：

- 视图栈非空时，转发给栈顶视图的 `handle_paste()`。若视图完成则清空栈。
- 视图栈为空时，转发给 `ChatComposer::handle_paste()`，并同步弹窗状态。

### 4. 审批/用户输入请求推送

当 Agent 请求用户审批或输入时，`BottomPane` 使用一种**先尝试消费，再创建新视图**的模式：

- `push_approval_request()`（`mod.rs:894-911`）：先让栈顶视图尝试 `try_consume_approval_request()`。若未消费，创建新的 `ApprovalOverlay` 压入栈。
- `push_user_input_request()`（`mod.rs:914-940`）：类似逻辑，创建 `RequestUserInputOverlay`。
- `push_mcp_server_elicitation_request()`（`mod.rs:942-1019`）：如果请求包含工具建议（install/enable），创建 `AppLinkView`；否则创建 `McpServerElicitationOverlay`。

这些方法都会暂停 status timer 并禁用 composer 输入。

### 5. 渲染管线 (`as_renderable`)

渲染时（`mod.rs:1120-1165`）：

- **视图栈非空**：直接返回栈顶视图作为渲染目标（模态视图完全遮盖 composer）
- **视图栈为空**：使用 `FlexRenderable` 组合多个垂直区域：
  1. Status indicator（任务运行时的进度显示）
  2. Unified exec footer（exec 进程摘要，仅在无 status indicator 时单独显示）
  3. Pending thread approvals（非活跃线程的待审批列表）
  4. Pending input preview（排队消息和 steer 预览）
  5. `ChatComposer`（始终在最底部，flex=0 固定高度）

## 接口/类型定义

### `BottomPaneView` trait

所有弹窗/模态视图必须实现的接口（`codex-rs/tui/src/bottom_pane/bottom_pane_view.rs:10-90`），继承自 `Renderable`：

| 方法 | 签名 | 说明 |
|------|------|------|
| `handle_key_event` | `(&mut self, KeyEvent)` | 处理键盘事件，调用后自动调度重绘 |
| `is_complete` | `(&self) -> bool` | 返回 `true` 表示视图已完成，应从栈中移除 |
| `view_id` | `(&self) -> Option<&'static str>` | 稳定标识符，用于外部刷新时匹配视图 |
| `selected_index` | `(&self) -> Option<usize>` | 列表类视图的当前选中索引，用于刷新后保持选中状态 |
| `on_ctrl_c` | `(&mut self) -> CancellationEvent` | 处理 Ctrl-C，默认返回 `NotHandled` |
| `prefer_esc_to_handle_key_event` | `(&self) -> bool` | 返回 `true` 时 Esc 走 `handle_key_event` 而非取消路径 |
| `handle_paste` | `(&mut self, String) -> bool` | 处理粘贴，返回是否需要重绘 |
| `flush_paste_burst_if_due` | `(&mut self) -> bool` | 刷新 paste-burst 暂态，返回是否有变化 |
| `is_in_paste_burst` | `(&self) -> bool` | 是否持有 paste-burst 暂态 |
| `try_consume_approval_request` | `(&mut self, ApprovalRequest) -> Option<ApprovalRequest>` | 尝试消费审批请求，返回 `None` 表示已消费 |
| `try_consume_user_input_request` | `(&mut self, RequestUserInputEvent) -> Option<...>` | 尝试消费用户输入请求 |
| `try_consume_mcp_server_elicitation_request` | `(&mut self, McpServerElicitationFormRequest) -> Option<...>` | 尝试消费 MCP 表单请求 |

所有方法都有合理的默认实现（不处理/不消费），视图只需覆盖关心的方法。

### `CancellationEvent` 枚举

```rust
// codex-rs/tui/src/bottom_pane/mod.rs:139-143
pub(crate) enum CancellationEvent {
    Handled,
    NotHandled,
}
```

Ctrl-C/Esc 取消操作的路由结果。`Handled` 表示底部面板自行消费了取消（如关闭弹窗、清空输入），`NotHandled` 表示上层 `ChatWidget` 需要决定下一步（如中断 Agent 或触发退出）。

### `BottomPane` 结构体

`codex-rs/tui/src/bottom_pane/mod.rs:162-193`

| 字段 | 类型 | 说明 |
|------|------|------|
| `composer` | `ChatComposer` | 可编辑的提示输入框，视图弹出后仍保留状态 |
| `view_stack` | `Vec<Box<dyn BottomPaneView>>` | 模态视图栈，栈顶为当前活跃视图 |
| `app_event_tx` | `AppEventSender` | 应用事件发送通道 |
| `frame_requester` | `FrameRequester` | 帧重绘调度器 |
| `has_input_focus` | `bool` | 当前是否拥有输入焦点 |
| `is_task_running` | `bool` | 是否有 Agent 任务正在运行 |
| `status` | `Option<StatusIndicatorWidget>` | 任务运行时显示的状态指示器 |
| `unified_exec_footer` | `UnifiedExecFooter` | exec 进程摘要 |
| `pending_input_preview` | `PendingInputPreview` | 排队消息/steer 预览 |
| `pending_thread_approvals` | `PendingThreadApprovals` | 非活跃线程待审批 |
| `context_window_percent` | `Option<i64>` | 上下文窗口使用百分比 |

### `ScrollState` 结构体

通用的垂直列表滚动/选中状态辅助器（`codex-rs/tui/src/bottom_pane/scroll_state.rs:8-11`）：

```rust
pub(crate) struct ScrollState {
    pub selected_idx: Option<usize>,
    pub scroll_top: usize,
}
```

| 方法 | 说明 |
|------|------|
| `reset()` | 清除选中和滚动位置 |
| `clamp_selection(len)` | 将选中索引钳制在 `[0, len-1]`，空列表时设为 `None` |
| `move_up_wrap(len)` | 向上移动，到顶部时环绕到底部 |
| `move_down_wrap(len)` | 向下移动，到底部时环绕到顶部 |
| `ensure_visible(len, visible_rows)` | 调整 `scroll_top` 使选中行在可见窗口内 |

## 配置项与常量

### 退出快捷键相关

```rust
// codex-rs/tui/src/bottom_pane/mod.rs:125-132
pub(crate) const QUIT_SHORTCUT_TIMEOUT: Duration = Duration::from_secs(1);
pub(crate) const DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED: bool = false;
```

- `QUIT_SHORTCUT_TIMEOUT`：「再按一次退出」提示的显示时长，1 秒。被 `ChatWidget`、`BottomPane` 和 `ChatComposer` 共享。
- `DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED`：双击退出功能的开关，当前设为 `false`（已禁用）。注释说明这个 UX 实验"按两次才退出"在实际使用中体验不佳。

### 弹窗常量

```rust
// codex-rs/tui/src/bottom_pane/popup_consts.rs:10
pub(crate) const MAX_POPUP_ROWS: usize = 8;
```

所有弹窗统一使用的最大行数限制，确保视觉一致性。

`standard_popup_hint_line()` 函数生成标准的弹窗底部提示行：「Press Enter to confirm or Esc to go back」。

## 边界 Case 与注意事项

- **Esc 的双重语义**：Esc 默认走取消路径（`on_ctrl_c`），但视图可以通过 `prefer_esc_to_handle_key_event()` 返回 `true` 来让 Esc 走普通按键处理路径。这对需要 Esc 做局部导航（如关闭子菜单但不关闭整个弹窗）的视图很重要。

- **栈清空策略不对称**：`ctrl_c_completed` 时只弹出栈顶（`pop`），允许下层视图继续显示；而视图通过按键自然完成时（`view_complete`）则**清空整个栈**（`clear`）。这意味着确认操作会关闭所有层级，而取消只关闭当前层。

- **Composer 状态持久化**：`ChatComposer` 始终存活，不随视图栈变化而销毁。用户在弹窗期间的输入草稿在弹窗关闭后仍然保留。

- **Paste-burst 定时器**：粘贴事件会触发一个短延迟重绘（`recommended_paste_flush_delay()`），用于批量合并快速连续的粘贴字符。视图栈中的模态视图也参与这一机制。

- **Status timer 暂停**：推送审批/输入请求模态时，会暂停 status indicator 的计时器（`pause_status_timer_for_modal()`），模态关闭时恢复（`resume_status_timer_after_modal()`），避免在用户做决策时计时器继续走动。

- **任务运行时的 Esc**：当任务正在运行且无弹窗时，Esc 会发送中断信号给 Agent，而非与 composer 交互。但如果 composer 有活跃的内联弹窗（如自动补全），Esc 优先关闭弹窗。

- **录音计量占位符**：非 Linux 平台有额外的 `insert_recording_meter_placeholder` / `update_recording_meter_in_place` / `remove_recording_meter_placeholder` 方法，用于在 composer 中显示实时语音录制指示器（`mod.rs:1190-1213`）。