# ApprovalOverlay

## 概述与职责

`ApprovalOverlay` 是 TUI BottomPane 中的**模态审批对话框**，负责在 Agent 请求执行操作时向用户展示审批提示，并将用户的决策（批准、拒绝、永久允许、中止等）路由回协议层。

在整体架构中，它属于 **TUI → BottomPane** 层级。当 Core 层的 Agent 发出需要用户确认的操作请求时（如执行 shell 命令、申请文件系统/网络权限、应用代码补丁、MCP 服务器信息确认），`ChatSurface` 将请求传递给 BottomPane，由 `ApprovalOverlay` 接管用户交互。同级模块包括 ChatComposer（输入框）、文件搜索弹窗、斜杠命令菜单等其他瞬态视图。

> 源码位置：`codex-rs/tui/src/bottom_pane/approval_overlay.rs`

## 关键类型

### `ApprovalRequest` 枚举

定义了四种需要用户审批的请求类型（`codex-rs/tui/src/bottom_pane/approval_overlay.rs:46-79`）：

| 变体 | 场景 | 关键字段 |
|------|------|----------|
| `Exec` | 执行 shell 命令 | `command`、`available_decisions`、`network_approval_context`、`additional_permissions` |
| `Permissions` | 请求文件系统/网络权限 | `permissions: RequestPermissionProfile` |
| `ApplyPatch` | 应用代码补丁（文件变更） | `cwd`、`changes: HashMap<PathBuf, FileChange>` |
| `McpElicitation` | MCP 服务器需要用户确认 | `server_name`、`message` |

所有变体均携带 `thread_id` 和可选的 `thread_label`（用于多 Agent 线程场景下标识来源线程）。

### `ApprovalOverlay` 结构体

```rust
pub(crate) struct ApprovalOverlay {
    current_request: Option<ApprovalRequest>,  // 当前正在展示的请求
    queue: Vec<ApprovalRequest>,               // 等待处理的后续请求
    app_event_tx: AppEventSender,              // 向 App 发送事件的通道
    list: ListSelectionView,                   // 底层选项列表 UI 组件
    options: Vec<ApprovalOption>,              // 当前请求的可选操作
    current_complete: bool,                    // 当前请求是否已处理
    done: bool,                                // 所有请求是否已处理完毕
    features: Features,                        // Feature flags
}
```

> 源码位置：`codex-rs/tui/src/bottom_pane/approval_overlay.rs:102-111`

### `ApprovalOption` 与 `ApprovalDecision`

每个可选操作由 `ApprovalOption` 描述，包含显示标签（`label`）、对应的决策（`ApprovalDecision`）、以及键盘快捷键绑定。`ApprovalDecision` 分为两类：

- `Review(ReviewDecision)` — 用于 Exec / Permissions / ApplyPatch 请求
- `McpElicitation(ElicitationAction)` — 用于 MCP 确认请求

## 关键流程

### 1. 请求展示流程

1. 外部调用 `ApprovalOverlay::new(request, tx, features)` 创建实例，首个请求立即通过 `set_current()` 设为当前展示项
2. `set_current()` 调用 `build_header()` 生成请求的可视化头部（命令预览、权限规则、diff 摘要等），然后调用 `build_options()` 根据请求类型生成对应的选项列表
3. 头部和选项被组装为 `SelectionViewParams`，交给内部的 `ListSelectionView` 渲染

如果在当前请求未处理完时又收到新请求，`try_consume_approval_request()` 将其加入 `queue`。

### 2. 用户决策流程

用户可以通过两种方式做出选择：

- **键盘快捷键**：`try_handle_shortcut()` 匹配按键（如 `y` 批准、`n`/`Esc` 拒绝、`a` 会话级允许、`p` 永久允许前缀命令），直接调用 `apply_selection()`
- **列表选择**：通过上下键导航并按 Enter 确认，由 `ListSelectionView` 处理后通过 `take_last_selected_index()` 传回

`apply_selection()` 根据请求类型分发到四个处理方法：

| 请求类型 | 处理方法 | 发送的 AppEvent |
|---------|---------|----------------|
| `Exec` | `handle_exec_decision()` | `AppEventSender::exec_approval()` |
| `Permissions` | `handle_permissions_decision()` | `AppEventSender::request_permissions_response()` |
| `ApplyPatch` | `handle_patch_decision()` | `AppEventSender::patch_approval()` |
| `McpElicitation` | `handle_elicitation_decision()` | `AppEventSender::resolve_elicitation()` |

处理完成后调用 `advance_queue()` 弹出下一个排队请求，或标记 `done = true`。

### 3. 取消流程（Ctrl+C）

`on_ctrl_c()` 对当前未完成的请求发送 `Abort`（Exec/Permissions/ApplyPatch）或 `Cancel`（McpElicitation），然后清空队列并标记 `done`（`codex-rs/tui/src/bottom_pane/approval_overlay.rs:415-452`）。

### 4. 特殊快捷键

- **Ctrl+A**：将当前请求发送为 `FullScreenApprovalRequest` AppEvent，切换到全屏审批视图（`codex-rs/tui/src/bottom_pane/approval_overlay.rs:357-370`）
- **`o`**：仅在跨线程请求（`thread_label` 存在时）可用，发送 `SelectAgentThread` 事件跳转到请求来源的 Agent 线程（`codex-rs/tui/src/bottom_pane/approval_overlay.rs:371-387`）

## 各请求类型的选项详情

### Exec 命令执行（`exec_options()`）

选项根据 `available_decisions` 动态生成，并受 `network_approval_context` 影响标签文案：

| 决策 | 普通命令标签 | 网络访问标签 | 快捷键 |
|------|------------|------------|--------|
| `Approved` | "Yes, proceed" | "Yes, just this once" | `y` |
| `ApprovedForSession` | "Yes, and don't ask again for this command in this session" | "Yes, and allow this host for this conversation" | `a` |
| `ApprovedExecpolicyAmendment` | "Yes, and don't ask again for commands that start with \`{prefix}\`" | — | `p` |
| `NetworkPolicyAmendment(Allow)` | — | "Yes, and allow this host in the future" | `p` |
| `NetworkPolicyAmendment(Deny)` | — | "No, and block this host in the future" | `d` |
| `Denied` | "No, continue without running it" | — | `d` |
| `Abort` | "No, and tell Codex what to do differently" | 同左 | `Esc` / `n` |

> 注意：包含换行符的 `ApprovedExecpolicyAmendment` 前缀会被自动过滤掉，不显示该选项。

### Permissions 权限请求（`permissions_options()`）

| 标签 | 快捷键 |
|------|--------|
| "Yes, grant these permissions" | `y` |
| "Yes, grant these permissions for this session" | `a` |
| "No, continue without permissions" | `n` |

权限审批区分 `Turn`（单次）和 `Session`（会话级）两种授权范围。

### ApplyPatch 补丁应用（`patch_options()`）

| 标签 | 快捷键 |
|------|--------|
| "Yes, proceed" | `y` |
| "Yes, and don't ask again for these files" | `a` |
| "No, and tell Codex what to do differently" | `Esc` / `n` |

### MCP Elicitation（`elicitation_options()`）

| 标签 | 快捷键 |
|------|--------|
| "Yes, provide the requested info" | `y` |
| "No, but continue without it" | `n` |
| "Cancel this request" | `Esc` / `c` |

## 头部渲染（`build_header()`）

`build_header()` 根据请求类型生成不同的可视化头部（`codex-rs/tui/src/bottom_pane/approval_overlay.rs:499-618`）：

- **Exec**：可选展示线程标签、原因说明、权限规则行（通过 `format_additional_permissions_rule()` 格式化网络/文件系统权限），以及经语法高亮处理的命令预览（`highlight_bash_to_lines()`），命令前添加 `$ ` 提示符。网络审批场景下不展示命令行
- **Permissions**：展示线程标签、原因说明、权限规则摘要
- **ApplyPatch**：展示线程标签、原因说明，以及通过 `DiffSummary` 组件渲染的文件变更摘要
- **McpElicitation**：展示线程标签、服务器名称、提示消息

## Trait 实现

### `BottomPaneView`

使 `ApprovalOverlay` 能作为 BottomPane 的活动视图参与键盘事件路由和生命周期管理：

- `handle_key_event()` — 优先尝试快捷键匹配，否则委托给 `ListSelectionView`
- `on_ctrl_c()` — 中止当前请求并清空队列
- `is_complete()` — 返回 `done` 状态，BottomPane 据此决定是否移除该视图
- `try_consume_approval_request()` — 将新到达的请求入队，返回 `None` 表示已消费

### `Renderable`

将渲染完全委托给内部的 `ListSelectionView`，包括 `desired_height()`、`render()` 和 `cursor_pos()`。

## 辅助函数

### `format_additional_permissions_rule()`

将 `PermissionProfile` 格式化为人类可读的权限描述字符串，如 `"network; read \`/tmp/readme.txt\`; write \`/tmp/out.txt\`"`。各权限部分用分号连接，文件路径用反引号包裹。无权限时返回 `None`。

> 此函数为 `pub(crate)`，也被模块外部调用。

### `approval_footer_hint()`

生成底部提示行，格式为 "Press [Enter] to confirm or [Esc] to cancel"。跨线程请求额外追加 "or [o] to open thread"。

## 边界 Case 与注意事项

- **请求队列**：多个审批请求可以排队处理，前一个处理完后自动展示下一个。Ctrl+C 会清空整个队列
- **幂等性保护**：`current_complete` 标志防止同一请求被重复处理
- **跨线程请求**：当 `thread_label` 存在时，审批来自非主线程的 Agent，此时不会向历史记录插入决策 cell（避免在非当前线程的聊天记录中产生噪音）
- **网络审批上下文**：存在 `network_approval_context` 时，提示标题变为 "Do you want to approve network access to {host}?"，且不显示命令行预览（仅显示主机名）
- **ExecPolicy 前缀过滤**：包含换行的命令前缀不会生成 "always allow" 选项（`codex-rs/tui/src/bottom_pane/approval_overlay.rs:666-668`），防止不安全的宽泛匹配