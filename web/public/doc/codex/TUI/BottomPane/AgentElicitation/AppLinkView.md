# AppLinkView

## 概述与职责

`AppLinkView` 是 TUI BottomPane 中的一个模态覆盖层视图，用于向用户展示 **应用链接建议**——提示用户安装或启用某个 ChatGPT 应用（App）。它属于 `AgentElicitation` 模块家族，实现了 `BottomPaneView` trait，可被推入 BottomPane 的视图栈中。

在整体架构中，`AppLinkView` 位于 **TUI → BottomPane → AgentElicitation** 层级。它的兄弟视图包括 MCP 服务器 elicitation（OAuth/凭据表单）和通用的 request-user-input 覆盖层。所有这些视图都通过 `SelectionFramework` 提供的渲染原语来绘制菜单行。

> 源码位置：`codex-rs/tui/src/bottom_pane/app_link_view.rs`

## 核心数据结构

### `AppLinkScreen` 枚举

内部状态机的两个屏幕（`codex-rs/tui/src/bottom_pane/app_link_view.rs:36-40`）：

- **`Link`**：初始屏幕，显示应用标题、描述、推荐理由和安装/管理操作
- **`InstallConfirmation`**：当用户点击"Install on ChatGPT"后浏览器已打开，等待用户确认安装完成

### `AppLinkSuggestionType` 枚举

```rust
pub(crate) enum AppLinkSuggestionType {
    Install,  // 应用尚未安装，建议安装
    Enable,   // 应用已安装但未启用，建议启用
}
```

### `AppLinkElicitationTarget`

当此视图由 MCP 工具建议触发时，需要通过该结构体将用户决策（Accept/Decline）回传给 elicitation 系统（`codex-rs/tui/src/bottom_pane/app_link_view.rs:48-53`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `thread_id` | `ThreadId` | 所属会话线程 |
| `server_name` | `String` | MCP 服务器名称 |
| `request_id` | `McpRequestId` | MCP 请求标识 |

### `AppLinkViewParams`

构造参数包（`codex-rs/tui/src/bottom_pane/app_link_view.rs:55-66`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `app_id` | `String` | 应用唯一标识（如 `"connector_google_calendar"`） |
| `title` | `String` | 应用显示名称 |
| `description` | `Option<String>` | 应用描述文字 |
| `instructions` | `String` | 安装/启用指引文字 |
| `url` | `String` | ChatGPT 上的应用链接 URL |
| `is_installed` | `bool` | 应用是否已安装 |
| `is_enabled` | `bool` | 应用是否已启用 |
| `suggest_reason` | `Option<String>` | 推荐理由（如 "Plan and reference events from your calendar"） |
| `suggestion_type` | `Option<AppLinkSuggestionType>` | 建议类型 |
| `elicitation_target` | `Option<AppLinkElicitationTarget>` | MCP elicitation 目标，存在时表示这是一个工具建议 |

## 关键流程

### 屏幕状态机与操作路由

整个视图围绕一个两屏状态机运作。`activate_selected_action()` 是核心路由方法（`codex-rs/tui/src/bottom_pane/app_link_view.rs:206-245`），根据三个维度决定行为：

1. **是否是工具建议**（`elicitation_target` 是否存在）
2. **当前屏幕**（`Link` 还是 `InstallConfirmation`）
3. **选中的操作索引**（`selected_action`）

#### 操作标签的动态生成

`action_labels()` 根据屏幕和安装状态动态生成菜单项（`codex-rs/tui/src/bottom_pane/app_link_view.rs:117-136`）：

| 屏幕 | 已安装 | 菜单项 |
|------|--------|--------|
| Link | 否 | "Install on ChatGPT", "Back" |
| Link | 是 + 已启用 | "Manage on ChatGPT", "Disable app", "Back" |
| Link | 是 + 未启用 | "Manage on ChatGPT", "Enable app", "Back" |
| InstallConfirmation | — | "I already Installed it", "Back" |

### Install 流程（未安装应用）

1. 用户在 Link 屏幕选择 "Install on ChatGPT"
2. `open_chatgpt_link()` 发送 `AppEvent::OpenUrlInBrowser` 打开浏览器（`codex-rs/tui/src/bottom_pane/app_link_view.rs:169-177`）
3. 由于 `is_installed == false`，自动切换到 `InstallConfirmation` 屏幕
4. 用户在浏览器中完成安装后，回到终端选择 "I already Installed it"
5. `refresh_connectors_and_close()` 发送 `AppEvent::RefreshConnectors { force_refetch: true }` 刷新连接器列表（`codex-rs/tui/src/bottom_pane/app_link_view.rs:179-187`）
6. 如果是工具建议，同时发送 `ElicitationAction::Accept` 回传给 MCP 层

### Enable 流程（已安装但未启用）

1. 用户在 Link 屏幕选择 "Enable app"
2. `toggle_enabled()` 翻转 `is_enabled` 状态，发送 `AppEvent::SetAppEnabled`（`codex-rs/tui/src/bottom_pane/app_link_view.rs:194-204`）
3. 如果是工具建议，立即发送 `ElicitationAction::Accept` 并关闭视图

### 拒绝/取消流程

- 在工具建议模式下，选择 "Back" 或按 Esc/Ctrl-C 会调用 `decline_tool_suggestion()`，发送 `ElicitationAction::Decline` 并关闭视图
- 在非工具建议模式下，"Back" 仅关闭视图或返回 Link 屏幕

### 工具建议 vs 非工具建议的行为差异

当 `elicitation_target` 存在时（`is_tool_suggestion() == true`），视图进入**工具建议模式**：

- **所有退出路径**（Back、Esc、Ctrl-C）都会发送 `ElicitationAction::Decline`
- **所有确认路径**（安装确认、启用）都会发送 `ElicitationAction::Accept`
- elicitation 解析通过 `resolve_elicitation()` 方法完成，它调用 `app_event_tx.resolve_elicitation()` 发出 `SubmitThreadOp` 事件（`codex-rs/tui/src/bottom_pane/app_link_view.rs:150-162`）

非工具建议模式下，InstallConfirmation 屏幕的 "Back" 会返回 Link 屏幕而不是关闭视图。

## 键盘交互

`handle_key_event()` 实现（`codex-rs/tui/src/bottom_pane/app_link_view.rs:393-464`）：

| 按键 | 行为 |
|------|------|
| `↑` / `←` / `BackTab` / `k` / `h` | 选中上一个操作项 |
| `↓` / `→` / `Tab` / `j` / `l` | 选中下一个操作项 |
| `Enter` | 执行当前选中的操作 |
| `1`-`9` 数字键 | 直接跳转到对应编号的操作并执行 |
| `Esc` / `Ctrl-C` | 关闭视图（工具建议模式下同时发送 Decline） |

## 渲染

视图实现了 `Renderable` trait（`codex-rs/tui/src/bottom_pane/app_link_view.rs:479-543`），布局分为三个垂直区域：

1. **内容区**（`Fill(1)`）：显示应用标题（粗体）、描述（暗色）、推荐理由（斜体）、安装指引等文本。使用 `textwrap::wrap` 进行文本换行
2. **操作区**（固定高度）：使用 `selection_popup_common` 的 `render_rows` 渲染带 `›` 前缀的操作菜单项
3. **提示行**（1 行）：显示键位提示（Tab/↑↓ 移动, Enter 选择, Esc 关闭）

Link 屏幕的内容（`link_content_lines`，`codex-rs/tui/src/bottom_pane/app_link_view.rs:254-312`）包含：
- 应用标题（粗体）
- 描述（如有，暗色显示）
- 推荐理由（如有，斜体显示）
- 已安装时提示"Use $ to insert this app into the prompt."
- 安装指引文本 + "Newly installed apps can take a few minutes to appear in /apps." 提示

InstallConfirmation 屏幕的内容（`install_confirmation_lines`，`codex-rs/tui/src/bottom_pane/app_link_view.rs:314-343`）包含：
- "Finish App Setup" 标题
- 引导用户在浏览器中完成安装的说明
- Setup URL 显示（青色+下划线），使用 `adaptive_wrap_lines` 包装以保证长 URL 在窄窗口下仍完整可见

## 边界 Case 与注意事项

- **长 URL 换行处理**：InstallConfirmation 屏幕使用 `adaptive_wrap_lines` 而非普通 `textwrap::wrap`，确保 URL-like 的长字符串不会在非 scheme 位置被错误截断。测试 `install_confirmation_does_not_split_long_url_like_token_without_scheme` 和 `install_confirmation_render_keeps_url_tail_visible_when_narrow` 验证了此行为
- **零尺寸渲染保护**：`render()` 在 `area.height == 0 || area.width == 0` 时提前返回
- **`desired_height` 计算**：内容区使用 `Paragraph::line_count` 精确计算换行后行数，加上操作区高度和 3 行固定开销（上下 padding + 提示行）
- **选择索引边界**：`move_selection_prev` 使用 `saturating_sub(1)` 防止下溢，`move_selection_next` 使用 `.min(len - 1)` 防止上溢
- **Enable 的即时生效**：`toggle_enabled()` 同时更新本地状态 `is_enabled` 和发送事件，使操作标签在下次渲染时立即从 "Enable app" 变为 "Disable app"（反之亦然）