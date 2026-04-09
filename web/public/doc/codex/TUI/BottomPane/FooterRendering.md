# Footer 渲染层

## 概述与职责

FooterRendering 是 TUI 中 BottomPane 模块的**纯渲染层**，负责将上层状态（`FooterProps`）格式化为 ratatui 的 `Line` / `Paragraph` 并绘制到 composer 输入框下方的区域。它自身**不持有可变状态**，也不做决策（由 `ChatComposer` 选择 `FooterMode`，由 `ChatWidget` 决定何时允许退出/中断），仅执行"状态 → 像素"的映射。

在系统架构中，FooterRendering 位于 **TUI → BottomPane** 层级。BottomPane 拥有 ChatComposer 和多个弹出层，而 FooterRendering 是其中最底部的可视区域，与 SharedUtilities 中的 key_hint、颜色常量、行截断等工具模块紧密配合。

该渲染层由四个文件组成，各自负责一个独立的 footer 子区域：

| 文件 | 职责 |
|------|------|
| `footer.rs` | 主 footer 行：瞬态提示、快捷键浮层、状态行、协作模式标签、宽度折叠逻辑 |
| `pending_input_preview.rs` | 待提交消息预览：pending steers、rejected steers、queued follow-up messages |
| `pending_thread_approvals.rs` | 跨线程审批徽章：列出需要审批的非活动线程 |
| `unified_exec_footer.rs` | 后台终端会话摘要行 |

---

## 关键流程

### 1. 主 footer 行的宽度折叠流程（`footer.rs`）

这是本模块最核心的逻辑。当终端宽度不足以同时显示左侧提示和右侧上下文时，`single_line_footer_layout` 按优先级逐步降级：

1. **尝试完整布局**：左侧提示（快捷键提示 / queue 提示 + 协作模式标签）+ 右侧上下文（context window 百分比或 token 用量）
2. **Queue 模式优先策略**：当 queue 提示激活时，优先保留 queue 提示，依次尝试：
   - 完整 queue 提示 + 右侧上下文
   - 完整 queue 提示（无右侧上下文）
   - 缩短的 queue 提示（`"tab to queue"` 替代 `"tab to queue message"`）
3. **协作模式降级**：非 queue 模式下：
   - 去掉 `"? for shortcuts"`，保留 `"(shift+tab to cycle)"`
   - 去掉 cycle 提示，仅保留模式标签
   - 如果 cycle 提示适用但放不下，同时隐藏右侧上下文（避免视觉不一致）
4. **最终回退**：左侧完全清空，仅显示右侧上下文

> 源码位置：`codex-rs/tui/src/bottom_pane/footer.rs:310-472`

宽度判定由 `can_show_left_with_context` 完成——计算左侧内容末端加上间隔列是否不超过右对齐内容的起始 x 坐标（`codex-rs/tui/src/bottom_pane/footer.rs:518-527`）。

### 2. FooterMode 状态映射流程

`FooterMode` 枚举决定 footer 展示什么内容。上层构造 `FooterProps` 后，通过 `footer_from_props_lines` 映射为具体的 `Line` 列表：

- **`QuitShortcutReminder`**：显示 `"Ctrl+C again to quit"` 等瞬态提醒（`codex-rs/tui/src/bottom_pane/footer.rs:731-733`）
- **`ShortcutOverlay`**：多行快捷键浮层，按两列布局排列所有可用快捷键（`codex-rs/tui/src/bottom_pane/footer.rs:750-799`）
- **`EscHint`**：`"Esc again to edit previous message"` 或双 Esc 提示（`codex-rs/tui/src/bottom_pane/footer.rs:735-748`）
- **`ComposerEmpty`** / **`ComposerHasDraft`**：基础单行 footer，可组合快捷键提示、queue 提示、模式标签

当 `status_line_enabled` 为 true 且处于"被动"模式（idle 或无任务的草稿状态）时，`passive_footer_status_line` 会用配置的状态行（model、git branch 等）替换快捷键提示，并可追加 active agent 标签（`codex-rs/tui/src/bottom_pane/footer.rs:638-659`）。

### 3. 待提交消息预览渲染流程（`pending_input_preview.rs`）

`PendingInputPreview` 渲染 composer 上方的排队消息预览，分三个区段按序绘制：

1. **Pending steers**：将在下一个 tool-call 边界自动提交的 steer 消息，附 `"press Esc to interrupt and send immediately"` 提示
2. **Rejected steers**：将在本轮结束时重试的被拒 steer
3. **Queued follow-up messages**：用户排队的后续消息

每条消息通过 `adaptive_wrap_lines` 自适应换行，并限制最多 `PREVIEW_LINE_LIMIT`（3）行显示，超出部分以 `"…"` 省略。底部仅在有 queued messages 时显示编辑提示（默认 `Alt+Up`，可通过 `set_edit_binding` 配置）。

> 源码位置：`codex-rs/tui/src/bottom_pane/pending_input_preview.rs:72-160`

### 4. 线程审批徽章渲染流程（`pending_thread_approvals.rs`）

`PendingThreadApprovals` 列出最多 3 个需要审批的非活动线程名称（红色 `!` 前缀），超过 3 个显示 `"..."`，底部附 `/agent to switch threads` 提示。

> 源码位置：`codex-rs/tui/src/bottom_pane/pending_thread_approvals.rs:40-70`

### 5. 后台终端摘要渲染流程（`unified_exec_footer.rs`）

`UnifiedExecFooter` 跟踪活跃的 unified-exec 后台进程列表，生成一行紧凑摘要如 `"3 background terminals running · /ps to view · /stop to close"`。摘要文本通过 `summary_text()` 公开，既可用于独立 footer 行，也可内联到状态行中。渲染时通过 `take_prefix_by_width` 截断以适应可用宽度。

> 源码位置：`codex-rs/tui/src/bottom_pane/unified_exec_footer.rs:45-67`

---

## 核心类型与接口

### `FooterProps`（`footer.rs:66-87`）

footer 渲染的全部输入，由上层组装后传入。关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | `FooterMode` | 当前 footer 模式 |
| `esc_backtrack_hint` | `bool` | 是否已按过一次 Esc（影响提示文案） |
| `use_shift_enter_hint` | `bool` | 换行快捷键使用 Shift+Enter 还是 Ctrl+J |
| `is_task_running` | `bool` | agent 是否正在执行任务 |
| `collaboration_modes_enabled` | `bool` | 是否启用协作模式 |
| `is_wsl` | `bool` | 是否运行在 WSL 下（影响粘贴快捷键） |
| `quit_shortcut_key` | `KeyBinding` | 退出快捷键（Ctrl+C 或 Ctrl+D） |
| `context_window_percent` | `Option<i64>` | 上下文窗口剩余百分比 |
| `context_window_used_tokens` | `Option<i64>` | 已使用 token 数 |
| `status_line_value` | `Option<Line<'static>>` | `/statusline` 配置的状态行内容 |
| `status_line_enabled` | `bool` | 状态行功能是否启用 |
| `active_agent_label` | `Option<String>` | 当前活跃 agent 标签 |

### `FooterMode`（`footer.rs:131-146`）

```rust
pub(crate) enum FooterMode {
    QuitShortcutReminder,  // 瞬态退出确认
    ShortcutOverlay,       // 多行快捷键浮层
    EscHint,               // Esc 提示
    ComposerEmpty,         // 空 composer 基础行
    ComposerHasDraft,      // 有草稿的基础行
}
```

### `CollaborationModeIndicator`（`footer.rs:90-96`）

表示当前协作模式：`Plan`（品红色）、`PairProgramming`（青色）、`Execute`（灰色）。各自带样式化 Span 和可选的 cycle 提示。

### `SummaryLeft`（`footer.rs:302-306`）

`single_line_footer_layout` 的返回类型之一，指示左侧内容的处理方式：
- `Default`：使用默认 props 映射
- `Custom(Line)`：使用折叠后的自定义行
- `None`：不显示左侧内容

---

## 公开函数签名

### footer.rs 主要导出

| 函数 | 签名 | 说明 |
|------|------|------|
| `footer_height` | `(props: &FooterProps) -> u16` | 计算 footer 所需行高 |
| `render_footer_line` | `(area: Rect, buf: &mut Buffer, line: Line)` | 渲染单行 footer（带缩进） |
| `render_footer_from_props` | `(area, buf, props, collab_indicator, show_cycle, show_shortcuts, show_queue)` | 从 props 直接渲染 footer |
| `single_line_footer_layout` | `(area, context_width, collab_indicator, show_cycle, show_shortcuts, show_queue) -> (SummaryLeft, bool)` | 宽度折叠决策，返回左侧内容和是否显示右侧 |
| `passive_footer_status_line` | `(props: &FooterProps) -> Option<Line>` | 提取被动状态行（状态行 + agent 标签） |
| `context_window_line` | `(percent: Option<i64>, used_tokens: Option<i64>) -> Line` | 生成右侧上下文窗口指示器 |
| `toggle_shortcut_mode` | `(current, ctrl_c_hint, is_empty) -> FooterMode` | 快捷键浮层开关 |
| `esc_hint_mode` | `(current, is_task_running) -> FooterMode` | Esc 提示触发 |
| `reset_mode_after_activity` | `(current) -> FooterMode` | 用户活动后重置为 ComposerEmpty |
| `render_context_right` | `(area, buf, line)` | 右对齐渲染上下文指示器 |
| `render_footer_hint_items` | `(area, buf, items: &[(String, String)])` | 渲染键值对提示项列表 |

### PendingInputPreview（`pending_input_preview.rs`）

- `new() -> Self`：创建空实例
- `set_edit_binding(binding: KeyBinding)`：替换编辑提示的快捷键绑定
- 实现 `Renderable` trait：`render(area, buf)` 和 `desired_height(width) -> u16`

### PendingThreadApprovals（`pending_thread_approvals.rs`）

- `new() -> Self`：创建空实例
- `set_threads(threads: Vec<String>) -> bool`：设置线程列表，返回是否变更
- `is_empty() -> bool`：是否无待审批线程
- 实现 `Renderable` trait

### UnifiedExecFooter（`unified_exec_footer.rs`）

- `new() -> Self`：创建空实例
- `set_processes(processes: Vec<String>) -> bool`：设置进程列表，返回是否变更
- `is_empty() -> bool`：是否无后台进程
- `summary_text() -> Option<String>`：获取不含缩进的摘要文本（供 footer 行和状态行复用）
- 实现 `Renderable` trait

---

## 配置项与默认值

- **`PREVIEW_LINE_LIMIT`**（`pending_input_preview.rs:32`）：每条预览消息最多显示 3 行，超出以 `…` 省略
- **`FOOTER_INDENT_COLS`**：footer 行左侧缩进列数（来自 `ui_consts` 模块）
- **`FOOTER_CONTEXT_GAP_COLS`**（`footer.rs:99`）：左侧内容与右对齐上下文之间的最小间隔，值为 1 列
- **`MODE_CYCLE_HINT`**（`footer.rs:98`）：协作模式切换提示文案 `"shift+tab to cycle"`
- **`edit_binding`** 默认值：`Alt+Up`（`pending_input_preview.rs:40`），可通过 `set_edit_binding` 覆盖
- **线程审批最多显示 3 条**（`pending_thread_approvals.rs:46`），超出显示 `"..."`

---

## 边界 Case 与注意事项

- **宽度 < 4 时全部子组件跳过渲染**：`PendingInputPreview`、`PendingThreadApprovals`、`UnifiedExecFooter` 都在极窄终端下返回空内容
- **`set_threads` / `set_processes` 的脏检查**：返回 `bool` 表示是否真正变更，调用方据此决定是否触发重绘，避免无效刷新
- **Status line 与快捷键提示互斥**：当 `status_line_enabled` 为 true 且处于被动模式时，状态行替换快捷键提示；但在 task running + draft 模式下，queue 提示优先于状态行（`shows_passive_footer_line` 在 `ComposerHasDraft + is_task_running` 时返回 false）
- **WSL 环境粘贴快捷键适配**：快捷键浮层中，WSL 下显示 `Ctrl+Alt+V` 代替 `Ctrl+V`（`footer.rs:996-1008`）
- **Cycle 提示与右侧上下文联动隐藏**：当 cycle 提示适用但宽度不足时，右侧上下文也同步隐藏，避免宽度微调时左右元素频繁出现/消失
- **快捷键浮层使用双列布局**（`build_columns`，`footer.rs:801-846`），列宽按最宽条目 + padding 计算，保证对齐
- **`summary_text()` 故意不含前导空格**：让调用方自行决定缩进或分隔符风格，同一文本既可渲染为独立行也可内联到状态行