# UI 渲染层

## 概述与职责

`ui.rs` 是 CloudTasks TUI 的**视图层**，负责将 `App` 状态树映射为终端画面。它属于 **CloudTasks → TasksTUI** 模块层级，基于 [ratatui](https://ratatui.rs) 框架，通过单一入口函数 `draw()` 在每帧中组合所有可视元素——任务列表、页脚、Diff 叠层、环境选择器、Best-of-N 选择器、Apply 确认对话框以及新任务编辑器。

同级兄弟模块 **TasksClient / TasksMockClient** 处理后端数据获取，**CloudRequirements** 负责云端配置拉取；本模块只关心"怎么画"，不涉及网络或业务逻辑。

## 关键流程

### 帧渲染主入口 `draw()`

`draw()` (`ui.rs:28-57`) 是每帧唯一的入口，由 TUI 事件循环调用。执行顺序：

1. 将终端区域垂直拆分为两块：**内容区**（弹性高度）和 **2 行页脚**（固定）
2. 根据 `app.new_task` 是否存在，选择渲染**新任务编辑页** 或 **任务列表**
3. 渲染页脚（帮助提示 + 状态栏）
4. 按优先级依次叠加四类模态覆盖层：Diff 叠层 → 环境选择器 → Best-of-N 选择器 → Apply 确认对话框

覆盖层按顺序渲染意味着后绘制的覆盖层会遮盖前者，`apply_modal` 拥有最高视觉优先级。

### 任务列表渲染 `draw_list()`

`draw_list()` (`ui.rs:176-234`) 将 `app.tasks` 映射为可滚动列表：

1. 每个 `TaskSummary` 经 `render_task_item()` 转为 **4 行 ListItem**：状态标签行、环境+时间元信息行、diff 摘要行、空白分隔行
2. 列表标题动态显示当前环境过滤标签和滚动百分比
3. 当任何模态/叠层激活时，列表整体添加 `DIM` 修饰以降低视觉权重
4. 刷新加载中时在列表中央显示居中 spinner

### Diff 叠层 `draw_diff_overlay()`

`draw_diff_overlay()` (`ui.rs:312-467`) 是最复杂的渲染函数，负责展示任务详情：

1. 使用 `overlay_outer()` 计算居中 80%×80% 的覆盖区域
2. 根据任务状态生成标题：失败任务标红 `[FAILED]`、有 diff 时显示 "Diff:"、否则显示 "Details:"
3. 如果同时存在对话文本和 diff，渲染**选项卡状态栏**（Prompt / Diff，← → 切换），并显示 attempt 导航提示（Tab/Shift-Tab 或 `[ ]` 循环）
4. 根据当前视图选择渲染策略：
   - **Diff 视图**：逐行调用 `style_diff_line()` 进行语法着色
   - **Prompt 视图**：调用 `style_conversation_lines()` 渲染对话
5. 内容为空且正在加载时显示居中 spinner；否则使用 `Paragraph::scroll()` 实现滚动

### 对话渲染 `style_conversation_lines()`

`style_conversation_lines()` (`ui.rs:558-652`) 将原始对话文本转化为带样式的 TUI 行：

- 识别 `User:` / `Assistant:` 标记切换说话者，渲染彩色头部（User 用 cyan，Assistant 用 magenta）
- 每行左侧添加 **gutter 竖线** `│ ` 标识当前说话者
- 追踪 ``` 围栏，代码块内容统一用 cyan 着色
- 识别 Markdown 列表项（`- ` / `* `）转换为 `• ` 并处理续行缩进
- Markdown 标题（`#`/`##`/`###`）渲染为粗体品红
- 其余文本委托给 `render_markdown_text()`（来自 `codex_tui` crate）进行行内 Markdown 样式化

## 函数签名与参数说明

### `pub fn draw(frame: &mut Frame, app: &mut App)`

帧渲染入口。每次终端刷新时被调用一次。

- **frame**：ratatui 帧缓冲区，用于写入 widget
- **app**：可变引用，因 spinner 计时器等字段需要就地更新

### `pub fn draw_new_task_page(frame: &mut Frame, area: Rect, app: &mut App)`

新任务编辑器页面。标题栏显示选中的环境和并行尝试数。composer 组件锚定在底部，高度动态扩展（最小 3 行，最大 terminal 高度 − 6）。

### `pub fn draw_env_modal(frame: &mut Frame, area: Rect, app: &mut App)`

环境选择器模态框。支持模糊搜索：对 `label`、`id`、`repo_hints` 进行大小写不敏感的子串匹配。列表第一项固定为 "All Environments (Global)"，已 pinned 的环境带 `PINNED` 标签。

### `pub fn draw_best_of_modal(frame: &mut Frame, area: Rect, app: &mut App)`

Best-of-N 并行尝试数选择器。提供 1-4 个选项，当前值标记 `Current`。模态框尺寸受限于 20-40 列宽、6-12 行高，并在覆盖区内居中。

### `pub fn draw_apply_modal(frame: &mut Frame, area: Rect, app: &mut App)`

Apply 确认对话框。分为三行布局：标题、内容区、操作提示（Y 应用 / P 预检 / N 取消）。内容区根据状态显示 spinner（预检中/应用中）或结果消息，结果分三级着色：Success（绿）、Partial（品红）、Error（红）。部分/失败时列出冲突和跳过的文件路径。

## 接口/类型定义

### `ConversationSpeaker`（私有枚举）

```rust
enum ConversationSpeaker { User, Assistant }
```

标识对话中的发言角色，决定 gutter 颜色和头部文字。(`ui.rs:552-556`)

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `CODEX_TUI_ROUNDED` | 环境变量 | `"1"`（启用） | 控制覆盖层边框是否使用圆角（`BorderType::Rounded`） |

通过 `OnceLock` 缓存，整个进程生命周期只读取一次 (`ui.rs:60-69`)。

## 边界 Case 与注意事项

- **覆盖层几何**：`overlay_outer()` 使用 10%/80%/10% 的三段式布局计算居中区域，在极小终端（< 10 行/列）下可能产生零尺寸区域。Best-of-N 模态框额外限制了最大/最小宽高以避免过大或过小。
- **Spinner 时序**：spinner 使用 `Instant::now()` 惰性初始化，600ms 间隔交替 `•` / `◦`。`spinner_start` 由 `App` 持有并通过 `&mut` 传入，因此仅在首次触发时记录起始时间。
- **状态栏截断**：`draw_footer()` 将 `app.status` 中的换行替换为空格并硬截断至 2000 字符，防止异常长消息撑乱布局 (`ui.rs:300-304`)。
- **Diff 着色规则**：`style_diff_line()` (`ui.rs:753-786`) 仅基于行首字符判断——`@@` 为品红粗体 hunk 头、`+++`/`---` 为 dim 文件头、`+` 为绿色新增、`-` 为红色删除、其余为原样。
- **列表项高度**：每个任务固定占 4 行（标题 + 元信息 + 摘要 + 空行分隔），这是硬编码的，不随终端宽度自适应换行。
- **DIM 联动**：当任何覆盖层或模态框激活时，底层任务列表和标题会变暗，引导用户视觉焦点到前景元素。

## 关键代码片段

覆盖层几何计算，将 80% 中央区域提取为可复用 helper：

```rust
// ui.rs:71-88
fn overlay_outer(area: Rect) -> Rect {
    let outer_v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage(10),
            Constraint::Percentage(80),
            Constraint::Percentage(10),
        ])
        .split(area)[1];
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(10),
            Constraint::Percentage(80),
            Constraint::Percentage(10),
        ])
        .split(outer_v)[1]
}
```

Diff 行着色——简洁的前缀匹配策略：

```rust
// ui.rs:753-786
fn style_diff_line(raw: &str) -> Line<'static> {
    if raw.starts_with("@@") { /* magenta bold hunk header */ }
    if raw.starts_with("+++") || raw.starts_with("---") { /* dim file header */ }
    if raw.starts_with('+') { /* green addition */ }
    if raw.starts_with('-') { /* red deletion */ }
    Line::from(vec![Span::raw(raw.to_string())]) // context line
}
```