# SettingsViews — 配置与设置模态视图

## 概述与职责

SettingsViews 是 TUI **BottomPane** 视图栈中的一组设置类模态视图。每个视图都实现了 `BottomPaneView` trait 和 `Renderable` trait，可被推入 BottomPane 的弹窗栈，供用户在不离开聊天界面的情况下完成各种配置操作。

在整体架构中，SettingsViews 属于 **TUI → BottomPane** 层级。BottomPane 是聊天界面的交互式底栏，管理输入编辑器和一系列瞬态弹窗视图——SettingsViews 就是这些弹窗中专门负责"设置"的子集。同级的其他 BottomPane 视图还包括工具调用审批、文件搜索、斜杠命令菜单等。

本模块包含六个独立视图：

| 视图 | 文件 | 用途 |
|------|------|------|
| `StatusLineSetupView` | `status_line_setup.rs` | 配置底部状态栏显示哪些信息项 |
| `TerminalTitleSetupView` | `title_setup.rs` | 配置终端标题模板 |
| `ExperimentalFeaturesView` | `experimental_features_view.rs` | 开关实验性功能标志 |
| `CustomPromptView` | `custom_prompt_view.rs` | 编辑自定义系统 prompt |
| `SkillsToggleView` | `skills_toggle_view.rs` | 启用/禁用技能和插件 |
| `FeedbackNoteView` | `feedback_view.rs` | 提交反馈（分类、备注、日志上传同意） |

## 通用模式

所有视图共享以下实现模式：

1. **`BottomPaneView` trait 实现**：提供 `handle_key_event()`（键盘路由）、`is_complete()`（视图是否可以弹出）、`on_ctrl_c()`（取消处理，返回 `CancellationEvent::Handled`）
2. **`Renderable` trait 实现**：提供 `render()` 和 `desired_height()` 用于 ratatui 布局
3. **事件驱动**：通过 `AppEventSender` 向主事件循环发送 `AppEvent`，不直接修改应用状态
4. **自包含**：每个视图持有自身的全部 UI 状态（选中索引、滚动、文本输入等）

---

## StatusLineSetupView — 状态栏配置

### 核心逻辑

StatusLineSetupView 允许用户选择和排序底部状态栏中显示的信息项。它封装了一个 `MultiSelectPicker`，提供多选 + 排序 + 实时预览的交互体验。

### 关键流程

1. **初始化**（`StatusLineSetupView::new()`，`status_line_setup.rs:191-246`）：
   - 将当前已配置的项（`status_line_items`）置于列表顶部并标记为启用
   - 将剩余的 `StatusLineItem` 枚举变体追加到列表末尾并标记为禁用
   - 通过 `MultiSelectPicker::builder()` 构建 picker，注册 `on_preview`、`on_confirm`、`on_cancel` 回调

2. **实时预览**：`StatusLinePreviewData` 持有运行时值的 `BTreeMap<StatusLineItem, String>`，`line_for_items()` 方法将启用项的实际值用 ` · ` 连接渲染为预览行（`status_line_setup.rs:152-166`）

3. **确认**：`on_confirm` 回调将选中的 ID 解析回 `StatusLineItem`，发送 `AppEvent::StatusLineSetup { items }` 事件
4. **取消**：发送 `AppEvent::StatusLineSetupCancelled`

### StatusLineItem 枚举

定义了 16 种可显示的状态信息项（`status_line_setup.rs:48-98`），使用 `strum` 宏序列化为 kebab-case（如 `ModelWithReasoning` → `"model-with-reasoning"`）。每个变体通过 `description()` 方法提供用户可读的说明文字。

可用项包括：`ModelName`、`ModelWithReasoning`、`CurrentDir`、`ProjectRoot`、`GitBranch`、`ContextRemaining`、`ContextUsed`、`FiveHourLimit`、`WeeklyLimit`、`CodexVersion`、`ContextWindowSize`、`UsedTokens`、`TotalInputTokens`、`TotalOutputTokens`、`SessionId`、`FastMode`。

部分项是条件性显示的——例如 Git 相关项只在 git 仓库中可用，Context 相关项在 API 返回数据前不显示。

---

## TerminalTitleSetupView — 终端标题配置

### 核心逻辑

与 StatusLineSetupView 结构高度相似，同样基于 `MultiSelectPicker`，但配置的是终端窗口/标签页标题中显示的内容。

### TerminalTitleItem 枚举

定义了 8 种标题项（`title_setup.rs:34-51`）：`AppName`、`Project`、`Spinner`、`Status`、`Thread`、`GitBranch`、`Model`、`TaskProgress`。

每个变体额外提供：
- `description()` —— 用户可见描述
- `preview_example()` —— 预览用的示例值（如 `AppName` → `"codex"`，`Status` → `"Working"`）
- `separator_from_previous()` —— 项间分隔符逻辑：`Spinner` 两侧用空格，其余用 ` | `（`title_setup.rs:93-103`）

### 独特行为

- **`on_change` 回调**：每次用户切换或移动项时立即发送 `AppEvent::TerminalTitleSetupPreview`，实现即时标题预览（`title_setup.rs:184-194`）
- **确认**发送 `AppEvent::TerminalTitleSetup`，**取消**发送 `AppEvent::TerminalTitleSetupCancelled`
- `parse_terminal_title_items()` 采用全有或全无策略——任何一个 ID 解析失败就返回 `None`，避免部分有效的排序被持久化（`title_setup.rs:106-117`）

---

## ExperimentalFeaturesView — 实验特性开关

### 核心逻辑

提供一个复选框列表，让用户开关各种实验性 `Feature` 标志。与前两个视图不同，它**不使用 `MultiSelectPicker`**，而是自行管理 `ScrollState` 和手动渲染行。

### 关键流程

1. **初始化**：接收 `Vec<ExperimentalFeatureItem>`（包含 `Feature` 枚举值、名称、描述、启用状态），构建带 header 和 footer hint 的滚动列表（`experimental_features_view.rs:49-69`）

2. **键盘处理**（`experimental_features_view.rs:138-194`）：
   - `↑` / `k` / `Ctrl+P` 上移
   - `↓` / `j` / `Ctrl+N` 下移
   - `Space` 切换选中项的启用/禁用状态
   - `Enter` / `Esc` 保存并关闭

3. **保存时机**：在 `on_ctrl_c()`（即关闭时）收集所有 `(Feature, bool)` 对，发送 `AppEvent::UpdateFeatureFlags { updates }`（`experimental_features_view.rs:200-214`）。配置变更保存到 `config.toml`。

### 渲染

每行格式为 `› [x] feature-name` 或 `  [ ] feature-name`，附带描述。使用 `selection_popup_common` 的 `render_rows` 进行实际渲染，受 `MAX_POPUP_ROWS` 常量限制最大可见行数。

---

## CustomPromptView — 自定义 Prompt 编辑

### 核心逻辑

一个极简的多行文本输入视图，用于收集用户自定义的 review 指令或系统 prompt 文本。核心是内嵌一个 `TextArea` 组件。

### 构造函数

```rust
pub fn new(
    title: String,
    placeholder: String,
    context_label: Option<String>,
    on_submit: PromptSubmitted,   // Box<dyn Fn(String) + Send + Sync>
) -> Self
```
> 源码位置：`custom_prompt_view.rs:41-56`

`on_submit` 是一个回调闭包，提交时以 trim 后的文本调用。

### 键盘处理（`custom_prompt_view.rs:60-88`）

- `Esc`：取消（关闭视图）
- `Enter`（无修饰键）：提交文本，空文本时忽略
- `Enter`（带修饰键，如 Shift+Enter）：在 TextArea 中换行
- 其他按键：转发给 TextArea

### 渲染布局

从上到下：标题行（带 `▌ ` 青色 gutter）→ 可选 context label（青色）→ 多行文本输入区（高度 1~9 行自适应）→ 空行 → 键盘提示行。支持 `handle_paste()` 和光标位置报告（`cursor_pos()`）。

---

## SkillsToggleView — 技能开关

### 核心逻辑

与 ExperimentalFeaturesView 相似的复选框列表，但增加了**搜索过滤**能力。用户可以输入文字实时筛选技能列表。

### SkillsToggleItem 结构

```rust
pub struct SkillsToggleItem {
    pub name: String,        // 显示名称
    pub skill_name: String,  // 内部标识
    pub description: String, // 描述
    pub enabled: bool,       // 当前状态
    pub path: PathBuf,       // 技能配置文件路径
}
```
> 源码位置：`skills_toggle_view.rs:36-42`

### 搜索过滤机制（`skills_toggle_view.rs:85-128`）

- 用户直接输入字符即追加到 `search_query`，Backspace 删除
- `apply_filter()` 调用 `match_skill()` 进行模糊匹配并按评分排序
- 过滤后尽量保持之前选中的项可见
- 空搜索时展示全部项

### 键盘处理（`skills_toggle_view.rs:203-266`）

- `↑` / `Ctrl+P`：上移
- `↓` / `Ctrl+N`：下移
- `Space` / `Enter`：切换选中项
- `Esc`：关闭
- 普通字符（无 Ctrl/Alt 修饰）：追加到搜索词
- `Backspace`：删除搜索词末字符

### 即时保存

与 ExperimentalFeaturesView 的"关闭时批量保存"不同，SkillsToggleView 在**每次切换时立即发送** `AppEvent::SetSkillEnabled { path, enabled }`（`skills_toggle_view.rs:165-181`）。关闭时发送 `AppEvent::ManageSkillsClosed` 并触发技能列表强制重载。

---

## FeedbackView — 反馈提交

### 核心逻辑

反馈系统由多个协作组件构成，流程跨越多个弹窗阶段。`feedback_view.rs` 是整个反馈流的中枢模块。

### 反馈提交流程

```
用户触发反馈 → 分类选择弹窗 → 日志上传同意弹窗 → 备注输入视图 → 提交
```

1. **分类选择**（`feedback_selection_params()`，`feedback_view.rs:390-429`）：构建一个 `SelectionViewParams`，提供 5 种反馈类别——Bug、Bad Result、Good Result、Safety Check、Other。每个选项触发 `AppEvent::OpenFeedbackConsent`

2. **日志上传同意**（`feedback_upload_consent_params()`，`feedback_view.rs:465-552`）：展示将要上传的文件列表（日志、rollout 文件、连接诊断信息），提供 Yes/No 选项。Yes 发送 `AppEvent::OpenFeedbackNote { include_logs: true }`，No 发送同一事件但 `include_logs: false`

3. **备注输入**（`FeedbackNoteView`，`feedback_view.rs:46-83`）：与 CustomPromptView 类似的 TextArea 输入。Enter 提交，Esc 取消。提交时发送：
   ```rust
   AppEvent::SubmitFeedback { category, reason: Option<String>, include_logs: bool }
   ```
   空备注会被转为 `None`，非空备注会被 trim（`feedback_view.rs:73-82`）

### FeedbackCategory 枚举

```rust
enum FeedbackCategory {
    BadResult,    // "bad_result"
    GoodResult,   // "good_result"
    Bug,          // "bug"
    SafetyCheck,  // "safety_check"
    Other,        // "other"
}
```

`feedback_classification()` 函数将枚举映射为字符串分类标识（`feedback_view.rs:295-303`）。

### 反馈成功后的消息

`feedback_success_cell()` 根据分类和受众生成提交成功后的提示消息（`feedback_view.rs:305-357`）：

- **外部用户**：提供 GitHub issue 链接（预填 thread ID）
- **内部员工**（`FeedbackAudience::OpenAiEmployee`）：提供内部反馈链接
- **Good Result**：不生成 issue 链接，只展示 thread ID

### 连接诊断

`should_show_feedback_connectivity_details()` 控制是否在上传同意弹窗中展示连接诊断信息——仅在非 GoodResult 且有诊断数据时展示（`feedback_view.rs:259-264`）。

### 反馈禁用状态

当配置中禁用了反馈功能时，`feedback_disabled_params()` 生成一个仅含 "Close" 按钮的信息弹窗（`feedback_view.rs:432-444`）。

---

## 边界 Case 与注意事项

- **StatusLineItem 和 TerminalTitleItem 的序列化格式是配置文件的持久化格式**，重命名或删除枚举变体属于破坏性配置变更
- TerminalTitleSetupView 的 `parse_terminal_title_items()` 采用全有或全无策略，任何无效 ID 都会导致整组解析失败
- ExperimentalFeaturesView 只在关闭时保存，而 SkillsToggleView 每次切换即时保存——两者的保存语义不同
- FeedbackNoteView 的 `Enter` 键行为取决于修饰键：无修饰键时提交，有修饰键（如 Shift）时插入换行
- 所有视图的渲染都考虑了 `area.height == 0 || area.width == 0` 的边界情况，直接返回不渲染