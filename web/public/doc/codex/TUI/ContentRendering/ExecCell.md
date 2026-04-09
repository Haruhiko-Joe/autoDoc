# ExecCell —— 命令执行单元的数据模型与渲染

## 概述与职责

ExecCell 模块是 TUI **ContentRendering** 子系统的一部分，负责在终端聊天记录（transcript）中表示和渲染 **工具命令执行** 条目。它位于 `codex-rs/tui/src/exec_cell/` 目录下，由三个文件组成：

| 文件 | 职责 |
|------|------|
| `mod.rs` | 模块入口，re-export 公共 API |
| `model.rs` | 数据模型——`ExecCall`、`ExecCell`、`CommandOutput` |
| `render.rs` | 渲染逻辑——将数据模型转换为 ratatui `Line` 序列 |

在整体架构中，ExecCell 属于 **TUI → ContentRendering** 层级。ChatSurface 在收到 agent 核心的 `exec_start` / `exec_end` 协议事件后，创建或更新 `ExecCell` 实例并将其作为 `HistoryCell` 插入可滚动的聊天记录。同级的兄弟模块还包括 Markdown 渲染、Diff 渲染、流式 transcript 管线等。

### 两种显示形态

ExecCell 有两种截然不同的显示模式：

1. **单命令模式（Command）**：一个 ExecCell 包含恰好一个 `ExecCall`，显示为 `• Ran <command>` 形式，带语法高亮和输出预览
2. **探索模式（Exploring）**：多个只读/搜索/列举类调用被聚合到同一个 ExecCell 中，显示为 `• Exploring` + 缩进的子操作列表

## 关键流程

### 1. ExecCell 的创建

外部通过 `new_active_exec_command()` 工厂函数创建一个包含单个 `ExecCall` 的 `ExecCell`。此时 `ExecCall.output` 为 `None`、`start_time` 被设为 `Instant::now()`，表示调用正在进行中。

> 源码位置：`codex-rs/tui/src/exec_cell/render.rs:40-61`

### 2. 探索组的聚合

当新的命令到达时，ChatSurface 调用 `ExecCell::with_added_call()` 尝试将新调用追加到当前 cell。追加仅在以下条件**同时满足**时成功：

- 当前 cell 已经是 exploring cell（所有已有调用都是探索类）
- 新调用也是探索类

判定"探索类调用"的逻辑在 `is_exploring_call()` 中（`model.rs:154-165`）：
- 来源**不是** `UserShell`
- `parsed` 非空
- 每个 `ParsedCommand` 都是 `Read`、`ListFiles` 或 `Search`

如果条件不满足，`with_added_call()` 返回 `None`，调用方会为新命令创建独立的 ExecCell。

### 3. 调用完成

`complete_call()` 通过 `call_id` 逆序匹配找到对应的 `ExecCall`，填入 `CommandOutput` 和 `duration`，并清除 `start_time`。返回值 `bool` 表示是否找到匹配——`false` 意味着路由不匹配，调用方据此判断是否需要将该结束事件作为独立条目处理。

> 源码位置：`codex-rs/tui/src/exec_cell/model.rs:82-95`

### 4. 渲染为 display_lines

`ExecCell` 实现了 `HistoryCell` trait，核心方法是 `display_lines(width)`，它根据 cell 类型分发到两个渲染路径：

```
display_lines(width)
  ├─ is_exploring_cell() == true  → exploring_display_lines(width)
  └─ is_exploring_cell() == false → command_display_lines(width)
```

> 源码位置：`codex-rs/tui/src/exec_cell/render.rs:198-205`

### 5. 单命令渲染流程 (`command_display_lines`)

这是最复杂的渲染路径（`render.rs:356-499`），步骤如下：

1. **状态指示符**：根据执行状态选择 bullet 样式
   - 成功：绿色 `•`
   - 失败：红色 `•`
   - 进行中：shimmer 动画 spinner
2. **标题词**：`"Running"` / `"Ran"` / `"You ran"`（用户 shell 命令）/ 空（交互式）
3. **命令高亮**：通过 `highlight_bash_to_lines()` 对 bash 命令进行语法高亮
4. **自适应换行**：使用 `adaptive_wrap_line` 将命令文本适配终端宽度，第一行紧接 header，续行用 `│` 前缀缩进
5. **续行截断**：超过 2 行的命令续行被 `limit_lines_from_start()` 截断，附加 `… +N lines` 省略指示
6. **输出预览**：完成后的命令输出经过 `output_lines()` 截断（agent 调用 5 行、用户 shell 50 行），再经 `truncate_lines_middle()` 做视口级别的中间截断
7. **空输出处理**：无输出时显示 `(no output)`

### 6. 探索模式渲染流程 (`exploring_display_lines`)

`render.rs:253-354` 实现了探索组的渲染：

1. **标题行**：活跃时显示 `• Exploring`（带 shimmer），完成后显示 `• Explored`
2. **调用合并**：连续的 `Read` 调用被合并为一行，如 `Read file1, file2, file3`
3. **分类显示**：非纯 Read 的调用按类型分别显示
   - `Read`：文件名列表
   - `List`：目标路径
   - `Search`：查询关键词 + 搜索路径（如 `foo in src/`）
4. **缩进排版**：所有子操作行用 `└` / 空格前缀缩进

### 7. 输出截断策略 (`output_lines` + `truncate_lines_middle`)

输出截断分两层：

**第一层：`output_lines()`**（`render.rs:99-180`）—— 逻辑行级截断
- 取输出的前 `line_limit` 行和后 `line_limit` 行
- 中间超出部分用 `… +N lines` 替代
- 如果 `only_err` 且退出码为 0，则跳过输出
- 所有输出行附加 `DIM` 修饰符

**第二层：`truncate_lines_middle()`**（`render.rs:530-622`）—— 视口行级截断
- 使用 `Paragraph::line_count(width)` 计算每行实际占用的屏幕行数（考虑长 URL 等换行场景）
- 保留前半和后半视口行，中间插入省略行
- 省略计数以**逻辑行**为单位（非屏幕行），确保终端宽度变化不影响数字

### 8. Spinner 动画

`spinner()` 函数（`render.rs:182-196`）根据终端能力选择动画方案：
- **动画禁用**：静态 `•`（dim）
- **支持 16M 色（truecolor）**：使用 `shimmer_spans` 产生渐变闪烁效果
- **不支持 truecolor**：600ms 周期的 `•` / `◦` 交替闪烁

### 9. Transcript 输出 (`transcript_lines`)

`transcript_lines()` 是 `HistoryCell` trait 的另一个方法，用于 Ctrl+T 全文 transcript 覆盖层。与 `display_lines` 不同，它为每个调用渲染完整的格式化输出（`formatted_output`），并在末尾附加带颜色的状态标记（`✓` 绿色 / `✗` 红色 + 退出码）和耗时。

> 源码位置：`codex-rs/tui/src/exec_cell/render.rs:207-249`

## 函数签名与参数说明

### `new_active_exec_command()`

```rust
pub(crate) fn new_active_exec_command(
    call_id: String,
    command: Vec<String>,
    parsed: Vec<ParsedCommand>,
    source: ExecCommandSource,
    interaction_input: Option<String>,
    animations_enabled: bool,
) -> ExecCell
```

工厂函数，创建一个包含单个进行中 `ExecCall` 的 `ExecCell`。`start_time` 自动设为当前时刻。

### `output_lines()`

```rust
pub(crate) fn output_lines(
    output: Option<&CommandOutput>,
    params: OutputLinesParams,
) -> OutputLines
```

将命令输出截断为有限行数。返回的 `OutputLines` 包含：
- `lines: Vec<Line<'static>>`——截断后的渲染行
- `omitted: Option<usize>`——被省略的行数（用于下游进一步截断时累加）

### `spinner()`

```rust
pub(crate) fn spinner(
    start_time: Option<Instant>,
    animations_enabled: bool,
) -> Span<'static>
```

根据终端能力返回适当的进度指示符 Span。

### `ExecCell::with_added_call()`

```rust
pub(crate) fn with_added_call(
    &self,
    call_id: String,
    command: Vec<String>,
    parsed: Vec<ParsedCommand>,
    source: ExecCommandSource,
    interaction_input: Option<String>,
) -> Option<Self>
```

尝试将新调用追加到探索组。成功返回 `Some(新 ExecCell)`（不可变更新），不满足探索条件时返回 `None`。

### `ExecCell::complete_call()`

```rust
pub(crate) fn complete_call(
    &mut self,
    call_id: &str,
    output: CommandOutput,
    duration: Duration,
) -> bool
```

标记指定调用为已完成。返回 `false` 表示未找到匹配的 `call_id`。

## 接口/类型定义

### `CommandOutput`

```rust
struct CommandOutput {
    exit_code: i32,
    aggregated_output: String,   // stderr + stdout 交错合并
    formatted_output: String,    // 模型可见的格式化输出
}
```

> 源码位置：`codex-rs/tui/src/exec_cell/model.rs:14-21`

### `ExecCall`

```rust
struct ExecCall {
    call_id: String,                          // 唯一调用标识
    command: Vec<String>,                     // 原始命令参数列表
    parsed: Vec<ParsedCommand>,               // 解析后的命令语义
    output: Option<CommandOutput>,            // None 表示仍在执行中
    source: ExecCommandSource,                // Agent / UserShell / UnifiedExecInteraction
    start_time: Option<Instant>,              // 开始时刻（完成后置 None）
    duration: Option<Duration>,               // 执行耗时
    interaction_input: Option<String>,        // 交互式输入内容
}
```

> 源码位置：`codex-rs/tui/src/exec_cell/model.rs:23-33`

### `ExecCell`

```rust
struct ExecCell {
    calls: Vec<ExecCall>,       // 包含的调用列表（单命令模式恰好 1 个）
    animations_enabled: bool,   // 是否启用 shimmer 动画
}
```

> 源码位置：`codex-rs/tui/src/exec_cell/model.rs:35-39`

### `OutputLinesParams`

```rust
struct OutputLinesParams {
    line_limit: usize,          // 截断行数上限
    only_err: bool,             // 仅在失败时显示输出
    include_angle_pipe: bool,   // 首行是否使用 └ 前缀
    include_prefix: bool,       // 是否添加缩进前缀
}
```

> 源码位置：`codex-rs/tui/src/exec_cell/render.rs:33-38`

### `ExecDisplayLayout` 与 `PrefixedBlock`

内部布局配置结构体，控制命令续行和输出块的前缀字符、换行宽度计算和最大显示行数。

常量 `EXEC_DISPLAY_LAYOUT` 定义了默认布局（`render.rs:682-687`）：
- 命令续行前缀：`│`，最多 2 行
- 输出块前缀：`└`（首行）/ 4 空格（续行），最多 5 行

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `TOOL_CALL_MAX_LINES` | 5 | Agent 工具调用输出截断行数 |
| `USER_SHELL_TOOL_CALL_MAX_LINES` | 50 | 用户 shell 命令输出截断行数 |
| `MAX_INTERACTION_PREVIEW_CHARS` | 80 | 交互输入预览最大字符数 |
| `command_continuation_max_lines` | 2 | 命令续行最大显示行数 |
| `output_max_lines` | 5 | 输出块最大视口行数 |

`animations_enabled` 在创建 `ExecCell` 时由上层传入，控制 spinner 是否使用 shimmer 动画。

## 边界 Case 与注意事项

- **路由不匹配信号**：`complete_call()` 和 `append_output()` 返回 `false` 时，调用方必须处理这个信号——通常意味着一个孤立的 `exec_end` 事件应作为独立的 transcript 条目渲染，而不是被静默忽略。

- **`should_flush()` 仅适用于非探索 cell**：探索 cell 不会被 flush，因为它们需要等待后续可能追加的调用。只有非探索 cell 在所有调用完成后才返回 `true`。

- **`mark_failed()` 的兜底处理**：当执行异常终止时，`mark_failed()` 会将所有未完成的调用标记为退出码 1、空输出，确保 cell 不会永久停留在"进行中"状态。

- **视口行 vs 逻辑行**：`truncate_lines_middle()` 按屏幕实际占用行数（viewport rows）计算截断，而非逻辑行数。这解决了包含长 URL 的单行输出在窄终端下占用大量屏幕空间却不被截断的问题。

- **不可变更新模式**：`with_added_call()` 返回新的 `ExecCell` 而非原地修改，这与 `complete_call()` / `append_output()` 的 `&mut self` 形成对比——前者在结构上创建新 cell，后者只修改内部状态。

- **交互式命令的特殊处理**：`UnifiedExecInteraction` 来源的调用在渲染时不显示标题词（无 "Ran"），使用 `format_unified_exec_interaction()` 生成描述文本如 `Interacted with 'cmd', sent 'input'`，并且 transcript 中不输出 `formatted_output`。