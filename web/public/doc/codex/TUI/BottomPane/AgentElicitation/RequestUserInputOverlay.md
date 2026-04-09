# RequestUserInputOverlay

## 概述与职责

`RequestUserInputOverlay` 是 TUI 中一个通用的、由 Agent 发起的多问题表单覆盖层（overlay）。当 Agent 需要向用户收集结构化输入时（例如多选项选择、自由文本回答），该模块会以模态弹窗的形式展示在 BottomPane 的视图栈中。

**在架构中的位置**：该模块属于 `TUI > BottomPane > AgentElicitation` 子系统，与 MCP Server Elicitation 和 App-Link View 并列，是三种 Agent-to-User 输入请求覆盖层之一。它实现了 `BottomPaneView` trait，通过 Orchestration 层被推入 BottomPane 的视图栈，依赖 `SelectionFramework`（`selection_popup_common`）提供的菜单表面、行渲染和文本换行原语。

**核心能力**：
- 支持多问题表单，每个问题可包含选项列表和/或自由文本输入（notes）
- 自适应布局引擎，根据终端高度动态分配进度条、问题文本、可滚动选项、notes 编辑器和底部快捷键提示的垂直空间
- 焦点在选项列表和 notes 编辑器之间切换
- 未回答问题的确认子页面（unanswered confirmation）
- 请求队列机制（FIFO），依次处理多个入站请求
- 底部对齐的选项行渲染和基于单词边界的行截断

## 文件结构

模块分为三个源文件：

| 文件 | 职责 |
|------|------|
| `mod.rs` | 核心状态机：数据模型、键盘事件处理、表单逻辑、`BottomPaneView` trait 实现 |
| `layout.rs` | 布局引擎：根据可用空间计算各区域（progress/question/options/notes/footer）的高度 |
| `render.rs` | 渲染层：`Renderable` trait 实现、未回答确认子页面渲染、底部对齐行渲染、单词边界截断 |

## 关键数据模型

### `RequestUserInputOverlay`（`mod.rs:122-137`）

主结构体，持有完整的表单状态：

```rust
pub(crate) struct RequestUserInputOverlay {
    app_event_tx: AppEventSender,       // 向 App 发送事件的通道
    request: RequestUserInputEvent,      // 当前正在处理的请求
    queue: VecDeque<RequestUserInputEvent>, // 后续请求的 FIFO 队列
    composer: ChatComposer,              // 复用的文本编辑器（用于 notes 输入）
    answers: Vec<AnswerState>,           // 每个问题一个回答状态
    current_idx: usize,                  // 当前展示的问题索引
    focus: Focus,                        // 焦点：Options 或 Notes
    done: bool,                          // 是否已完成（提交或中断）
    pending_submission_draft: Option<ComposerDraft>, // 提交时暂存的草稿
    confirm_unanswered: Option<ScrollState>,        // 未回答确认子页面状态
}
```

### `Focus` 枚举（`mod.rs:57-61`）

焦点模式，决定键盘事件的路由目标：
- `Focus::Options`：选项列表获得焦点，方向键/j/k 移动选项高亮
- `Focus::Notes`：notes 编辑器获得焦点，键盘输入进入 ChatComposer

### `AnswerState`（`mod.rs:89-98`）

每个问题的回答状态：
- `options_state: ScrollState` — 选项列表的滚动和选中状态
- `draft: ComposerDraft` — notes 文本草稿（包含文本、text_elements、图片路径和粘贴内容）
- `answer_committed: bool` — 该问题是否已被用户明确确认
- `notes_visible: bool` — notes UI 是否对该问题可见

### `ComposerDraft`（`mod.rs:63-69`）

保存 notes 编辑器的快照，用于在问题间切换时保留/恢复草稿内容。支持 pending paste 的延迟展开。

## 关键流程

### 1. 表单初始化

`RequestUserInputOverlay::new()`（`mod.rs:140-175`）创建覆盖层：

1. 使用 `ChatComposerConfig::plain_text()` 配置创建一个 `ChatComposer` 实例（禁用斜杠命令、文件搜索等弹窗功能），并覆盖 footer hint 为空
2. 调用 `reset_for_request()` 为每个问题初始化 `AnswerState`：有选项的问题默认选中第一个选项，无选项的问题默认 notes 可见
3. 调用 `ensure_focus_available()` 确保焦点模式与当前问题类型匹配
4. 调用 `restore_current_draft()` 加载当前问题的草稿到编辑器

### 2. 键盘事件路由

`handle_key_event()`（`mod.rs:993-1219`）是核心交互入口，按优先级路由：

1. **Release 事件**：直接忽略
2. **确认子页面激活时**：转发到 `handle_confirm_unanswered_key_event()`
3. **Esc**：若 notes 可见且有选项，关闭 notes 回到选项焦点；否则触发中断（`app_event_tx.interrupt()`）
4. **全局问题导航**：`Ctrl+P`/`PageUp` 前一题，`Ctrl+N`/`PageDown` 后一题；选项焦点时 `h`/`←` 前一题，`l`/`→` 后一题
5. **按焦点分发**：
   - `Focus::Options`：`j`/`↓` 下移、`k`/`↑` 上移、`Space` 确认选择、`Backspace` 清除选择、`Tab` 切到 notes（需先有选项选中）、`Enter` 提交当前题并前进、数字键 `1-9` 快速选择并提交
   - `Focus::Notes`：`Tab` 清空 notes 回到选项、`Backspace`（notes 为空时）隐藏 notes 回选项、`Enter` 提交当前题、`↑`/`↓` 切换选中的选项（不离开 notes 焦点）、其余键转发给 ChatComposer

### 3. 提交流程

当用户在最后一个问题上按 Enter 时，调用 `go_next_or_submit()`（`mod.rs:701-712`）：

1. 若存在未回答的问题，打开确认子页面（`open_unanswered_confirmation()`）
2. 若所有问题都已回答，调用 `submit_answers()`（`mod.rs:715-770`）：
   - 遍历所有问题，从 `AnswerState` 构建 `RequestUserInputAnswer`
   - 对有选项的问题，仅在 `answer_committed` 为 true 时包含选中选项的 label
   - notes 内容以 `"user_note: {notes}"` 格式追加到答案列表
   - 通过 `app_event_tx.user_input_answer()` 发送 `RequestUserInputResponse`
   - 同时插入 `RequestUserInputResultCell` 到聊天历史
   - 若队列中有等待的请求，弹出下一个请求并 `reset_for_request()`；否则标记 `done = true`

### 4. 未回答确认子页面

当用户尝试提交但存在未回答问题时，显示一个两选项确认页面：
- **Proceed**：直接提交所有答案（包括空答案）
- **Go back**：跳转到第一个未回答的问题

键盘操作：`↑`/`↓`/`j`/`k` 移动选择，`Enter` 确认，`Esc`/`Backspace` 返回到第一个未回答问题。

### 5. 请求队列

通过 `try_consume_user_input_request()`（`mod.rs:1269-1275`）入队后续请求。覆盖层按 FIFO 顺序依次处理，提交当前请求后自动弹出下一个。中断（Esc/Ctrl+C）时丢弃所有排队请求。

## 布局引擎

布局引擎定义在 `layout.rs`，核心入口是 `layout_sections()`（`layout.rs:19-60`）。它接受可用的 `Rect` 区域，返回 `LayoutSections`：

```rust
pub(super) struct LayoutSections {
    pub(super) progress_area: Rect,     // 进度条（"Question 2/5"）
    pub(super) question_area: Rect,     // 问题文本
    pub(super) question_lines: Vec<String>, // 换行后的问题文本行
    pub(super) options_area: Rect,      // 选项列表
    pub(super) notes_area: Rect,        // Notes 编辑器
    pub(super) footer_lines: u16,       // Footer 提示行数
}
```

**布局策略根据是否有选项分两条路径**：

**有选项时**（`layout_with_options`，`layout.rs:63-95`）：
1. 确保选项至少占 1 行
2. 若问题文本超出可用高度减去最小选项高度，截断问题文本
3. 进入 `layout_with_options_normal()`（`layout.rs:99-196`）：先分配 footer 和 progress（各 1 行），然后根据 notes 是否可见分配间距和 notes 区域，剩余空间给选项增长

**无选项时**（`layout_without_options`，`layout.rs:198-222`）：
- 空间充足时：依次分配问题、notes、footer、progress，剩余空间给 notes 扩展
- 空间紧张时（tight layout）：仅保留截断后的问题文本，其余区域为 0

最终通过 `build_layout_areas()`（`layout.rs:281-326`）将计算出的各区域高度转为具体的 `Rect` 坐标。布局自上而下排列：progress → question → spacer → options → spacer → notes → footer。

## 渲染层

### `Renderable` trait 实现（`render.rs:61-114`）

- `desired_height()` 计算覆盖层的理想高度（最小 8 行）
- `render()` 委托给 `render_ui()`
- `cursor_pos()` 在 notes 焦点时返回光标位置

### 主渲染流程 `render_ui()`（`render.rs:248-384`）

1. 若确认子页面激活，转到 `render_unanswered_confirmation()`
2. 调用 `render_menu_surface()` 绘制共享的菜单外框
3. 通过 `layout_sections()` 计算各区域
4. 渲染进度行（如 `"Question 2/5 (1 unanswered)"`），未回答问题用 cyan 高亮
5. 渲染问题文本，已回答的问题使用默认颜色，未回答的用 cyan
6. 调用 `render_rows_bottom_aligned()` 渲染选项列表（底部对齐）
7. 渲染 notes 编辑器（支持 `is_secret` 时使用 `*` 掩码）
8. 渲染 footer 提示行，使用 `truncate_line_word_boundary_with_ellipsis()` 截断

### 底部对齐渲染 `render_rows_bottom_aligned()`（`render.rs:439-474`）

该函数解决了选项行少于分配高度时的对齐问题：先渲染到一个临时 Buffer，然后将内容复制到目标区域的底部。这保证了选项列表始终紧贴 notes/footer 区域，避免上方出现多余空白。

### 单词边界截断 `truncate_line_word_boundary_with_ellipsis()`（`render.rs:483-582`）

对超出宽度的 styled `Line` 进行智能截断：
1. 逐字符扫描计算显示宽度，追踪最后一个适配字符和最后一个空白分隔点
2. 优先在单词边界处截断，避免截断到单词中间
3. 裁去尾部空白后追加 `"…"` 省略号，继承最后一个可见 span 的样式
4. 正确处理 Unicode 宽度（通过 `unicode_width` crate）

## "None of the above" 选项

当问题的 `is_other` 为 true 且有选项列表时，自动在选项末尾追加一个 "None of the above" 选项（`mod.rs:48-49`、`mod.rs:592-600`）。选中该选项会提示用户通过 Tab 切换到 notes 添加补充说明。

## Footer 提示系统

`footer_tips()`（`mod.rs:430-463`）根据当前状态动态生成快捷键提示：

| 条件 | 提示内容 |
|------|---------|
| 有选项 + 已选中 + notes 未展开 | **tab to add notes**（高亮） |
| 有选项 + notes 已展开 | tab or esc to clear notes |
| 单问题 | **enter to submit answer**（高亮） |
| 多问题最后一题 | **enter to submit all**（高亮） |
| 多问题非最后一题 | enter to submit answer |
| 多问题 + 选项焦点 | ←/→ to navigate questions |
| 多问题 + 无选项 | ctrl + p / ctrl + n change question |
| 非 notes+选项模式 | esc to interrupt |

提示行支持自动换行：`wrap_footer_tips()`（`mod.rs:482-521`）按终端宽度将提示拆分为多行，用 `" | "` 分隔符连接。

## 配置项与常量

| 常量 | 值 | 说明 |
|------|----|------|
| `MIN_COMPOSER_HEIGHT` | 3 | notes 编辑器最小高度 |
| `DESIRED_SPACERS_BETWEEN_SECTIONS` | 2 | notes 隐藏时选项与 footer 间的理想间距行数 |
| `MIN_OVERLAY_HEIGHT`（render.rs） | 8 | 覆盖层最小总高度 |
| `NOTES_PLACEHOLDER` | "Add notes" | 已选中选项时的 notes 占位文本 |
| `ANSWER_PLACEHOLDER` | "Type your answer (optional)" | 无选项问题的输入占位文本 |
| `SELECT_OPTION_PLACEHOLDER` | "Select an option to add notes" | 未选中选项时的 notes 占位文本 |

## 边界 Case 与注意事项

- **粘贴行为**：在选项焦点下粘贴文本会自动切换到 notes 焦点（`handle_paste()`，`mod.rs:1246-1259`）
- **草稿保存/恢复**：切换问题时自动保存当前 notes 草稿并恢复目标问题的草稿，确保用户输入不会丢失（`save_current_draft()`/`restore_current_draft()`）
- **空答案语义**：无选项的自由文本问题，若用户未明确提交（按 Enter），则提交空答案列表；有选项的问题在未 commit 时同样提交空答案
- **Secret 问题**：`is_secret` 为 true 的问题，notes 编辑器以 `*` 掩码渲染（`render.rs:417-424`）
- **Ctrl+C 行为**：若 notes 有内容则清空 notes；否则中断整个覆盖层并标记 done
- **中断不提交**：中断时当前不会发送已填写的部分答案（代码中有 TODO 注释说明未来可能支持，`mod.rs:1008-1009`）
- **问题导航环绕**：`move_question()` 支持首尾环绕（`mod.rs:617-627`）