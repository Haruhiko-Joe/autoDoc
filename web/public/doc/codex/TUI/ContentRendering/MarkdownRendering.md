# Markdown 渲染引擎

## 概述与职责

Markdown 渲染引擎是 TUI 内容渲染管线（ContentRendering）的核心组件，负责将 Markdown 源文本解析并转换为带样式的 ratatui `Line` 序列，最终显示在终端聊天界面中。它基于 `pulldown-cmark` 解析器，支持完整的 CommonMark 子集以及删除线扩展，并对本地文件链接提供特殊的路径归一化和相对化显示逻辑。

在 TUI 层级中，该模块被 ChatSurface、BottomPane 和 PickersAndStatus 等组件调用，用于将 agent 输出的 Markdown 文本渲染为终端可显示的带样式文本。

模块由两个文件组成：
- **`markdown.rs`**：薄门面层，提供唯一的公开入口 `append_markdown`
- **`markdown_render.rs`**：完整的渲染引擎实现，包含解析器驱动的 `Writer` 状态机和本地链接路径处理逻辑

## 关键流程

### 渲染入口与调用链

整个渲染流程从 `append_markdown` 开始，经过三步完成：

1. 调用方通过 `append_markdown(markdown_source, width, cwd, lines)` 提交 Markdown 文本（`codex-rs/tui/src/markdown.rs:8-20`）
2. 内部委托给 `render_markdown_text_with_width_and_cwd`，创建 `pulldown-cmark` 解析器并实例化 `Writer` 状态机（`codex-rs/tui/src/markdown_render.rs:104-115`）
3. `Writer::run()` 逐事件遍历解析器输出，调用 `handle_event` 分发到各标签处理方法（`codex-rs/tui/src/markdown_render.rs:206-211`）
4. 最终通过 `push_owned_lines` 将渲染结果追加到调用方提供的 `Vec<Line>` 中

### 事件驱动的状态机

`Writer` 是一个迭代器驱动的状态机，通过 `handle_event` 将 pulldown-cmark 事件分发到对应处理器（`codex-rs/tui/src/markdown_render.rs:213-235`）：

- **`Event::Start(tag)` / `Event::End(tag)`**：进入/离开标签，管理缩进栈、样式栈和列表状态
- **`Event::Text(text)`**：将文本内容按当前样式推入当前行，代码块内会缓冲文本等待批量高亮
- **`Event::Code(code)`**：内联代码，以 cyan 样式渲染
- **`Event::SoftBreak` / `Event::HardBreak`**：处理行内换行，对本地文件链接后的冒号描述有特殊的合并逻辑
- **`Event::Rule`**：渲染为 `———` 水平分隔线

### 代码块渲染与语法高亮

代码块处理分两种路径（`codex-rs/tui/src/markdown_render.rs:526-571`）：

1. **有语言标注的围栏代码块**：文本事件累积到 `code_block_buffer`，在 `end_codeblock` 时调用 `highlight_code_to_lines` 进行语法高亮。语言标识从 info string 中提取首个 token（用逗号/空格/tab 分割），支持如 `rust,no_run` 这样的复合标注
2. **无语言标注的围栏代码块或缩进代码块**：直接以纯文本方式逐行推入，不做语法高亮

代码块内的行**不会被自动换行**——即使设置了 `wrap_width`，也会保持原始宽度以便复制粘贴（`codex-rs/tui/src/markdown_render.rs:631`）。

### 本地文件链接的特殊处理

这是该模块最具特色的功能。当链接目标被识别为本地路径时，渲染器**抑制 Markdown 标签文本**，转而显示从目标路径推导出的规范化路径（`codex-rs/tui/src/markdown_render.rs:596-618`）。

判定本地路径的规则（`is_local_path_like_link`，`codex-rs/tui/src/markdown_render.rs:729-741`）：
- `file://` 前缀
- `/` 绝对路径、`~/` home 相对路径、`./` 或 `../` 相对路径
- `\\` UNC 路径
- Windows 驱动器路径如 `C:/...`

路径解析流程（`parse_local_link_target`，`codex-rs/tui/src/markdown_render.rs:764-793`）：
1. `file://` URL 通过 `url::Url` 解析，提取路径和 `#fragment` 位置后缀
2. 普通路径先检查 `#L..C..` 样式的 hash 后缀，再检查 `:line:col` 样式的冒号后缀
3. `~/` 路径通过 `dirs::home_dir()` 展开为绝对路径
4. 所有路径分隔符统一为正斜杠
5. 绝对路径如果位于 `cwd` 下，自动去除 cwd 前缀显示为相对路径

位置后缀由两个正则表达式匹配：
- `COLON_LOCATION_SUFFIX_RE`：匹配 `:line`、`:line:col`、`:line:col-line:col` 格式
- `HASH_LOCATION_SUFFIX_RE`：匹配 `L12`、`L12C3`、`L12C3-L14C9` 格式

hash 后缀会被规范化为 `:line:col` 的显示格式（通过 `codex_utils_string::normalize_markdown_hash_location_suffix`）。

### 自动换行

当提供 `wrap_width` 参数时，非代码块的行会通过 `adaptive_wrap_line` 进行自适应换行（`codex-rs/tui/src/markdown_render.rs:627-646`）。换行时保持正确的初始缩进（含列表标记）和后续缩进（仅空白对齐），由 `prefix_spans` 方法根据缩进栈计算。

## 函数签名与参数说明

### `append_markdown` （公开入口）

```rust
pub(crate) fn append_markdown(
    markdown_source: &str,
    width: Option<usize>,
    cwd: Option<&Path>,
    lines: &mut Vec<Line<'static>>,
)
```

- **`markdown_source`**：待渲染的 Markdown 源文本
- **`width`**：可选的换行宽度（字符数）。`None` 表示不换行
- **`cwd`**：可选的会话工作目录路径，用于将本地文件链接的绝对路径转换为相对路径显示
- **`lines`**：输出目标，渲染结果追加到此向量

> 源码位置：`codex-rs/tui/src/markdown.rs:8-20`

### `render_markdown_text`

```rust
pub fn render_markdown_text(input: &str) -> Text<'static>
```

无宽度限制的简便入口，使用进程当前工作目录。主要供测试和外部（非 crate 内部）调用使用。

> 源码位置：`codex-rs/tui/src/markdown_render.rs:89-91`

### `render_markdown_text_with_width_and_cwd`

```rust
pub(crate) fn render_markdown_text_with_width_and_cwd(
    input: &str,
    width: Option<usize>,
    cwd: Option<&Path>,
) -> Text<'static>
```

核心渲染函数，创建带 `ENABLE_STRIKETHROUGH` 选项的 pulldown-cmark 解析器，驱动 `Writer` 状态机完成渲染。

> 源码位置：`codex-rs/tui/src/markdown_render.rs:104-115`

## 接口/类型定义

### `MarkdownStyles`

内部样式配置结构体，定义了所有 Markdown 元素的 ratatui `Style`（`codex-rs/tui/src/markdown_render.rs:32-47`）：

| 元素 | 样式 |
|------|------|
| H1 | 粗体 + 下划线 |
| H2 | 粗体 |
| H3 | 粗体 + 斜体 |
| H4-H6 | 斜体 |
| 内联代码 | cyan |
| 强调（emphasis） | 斜体 |
| 粗体（strong） | 粗体 |
| 删除线 | 删除线样式 |
| 有序列表标记 | light_blue |
| 无序列表标记 | 默认样式 |
| 链接 | cyan + 下划线 |
| 引用块 | 绿色 |

### `Writer<'a, I>`

核心状态机结构体（`codex-rs/tui/src/markdown_render.rs:147-173`），持有：

- `iter`：pulldown-cmark 事件迭代器
- `text`：输出的 `Text<'static>` 对象
- `inline_styles`：内联样式栈（支持嵌套，如粗体内的斜体）
- `indent_stack`：缩进上下文栈（`Vec<IndentContext>`），追踪列表嵌套和引用块层级
- `list_indices`：列表编号栈，`Some(n)` 为有序列表当前序号，`None` 为无序列表
- `link`：当前链接状态（`Option<LinkState>`）
- `code_block_buffer` / `code_block_lang`：代码块缓冲区和语言标识
- `wrap_width` / `cwd`：换行宽度和工作目录

### `IndentContext`

缩进上下文（`codex-rs/tui/src/markdown_render.rs:72-87`），描述一层嵌套：

- `prefix`：后续行的缩进前缀 span 列表（如 `"> "` 或空白缩进）
- `marker`：首行的列表标记 span（如 `"1. "` 或 `"- "`），消费后为 `None`
- `is_list`：是否为列表项缩进（影响空行和前缀计算逻辑）

### `LinkState`

链接渲染状态（`codex-rs/tui/src/markdown_render.rs:117-126`）：

- `destination`：原始链接目标
- `show_destination`：是否在标签后显示 URL（仅非本地链接）
- `local_target_display`：本地链接的预渲染路径文本，存在时抑制 Markdown 标签显示

## 配置项与默认值

该模块没有外部配置文件或环境变量。所有样式通过 `MarkdownStyles::default()` 硬编码，pulldown-cmark 仅启用 `ENABLE_STRIKETHROUGH` 扩展。

`cwd` 参数在不同调用路径中的来源：
- `append_markdown`：由调用方显式传入会话工作目录
- `render_markdown_text_with_width`：使用 `std::env::current_dir()`
- `render_markdown_text`：同上，且不限制宽度

## 边界 Case 与注意事项

- **本地链接标签抑制**：当链接目标是本地路径时，Markdown 中的 `[label]` 文本被完全忽略，显示内容来自目标路径。这是有意设计，确保转录内容始终反映真实文件目标（`codex-rs/tui/src/markdown_render.rs:1-6` 模块注释）

- **冒号描述合并**：本地文件链接后紧跟 soft break 和以冒号 `:` 开头的文本时，不会换行而是内联合并。这保证了 `[file](path)\n  : description` 的列表格式正确渲染为单行（`codex-rs/tui/src/markdown_render.rs:237-251`）

- **Windows 路径兼容**：路径分隔符统一为正斜杠，UNC 路径 `\\server\share` 转换为 `//server/share`，Windows 驱动器号不会被冒号位置后缀正则误匹配（`codex-rs/tui/src/markdown_render.rs:867-875`）

- **cwd 等于文件路径时不缩短**：如果绝对路径恰好等于 cwd 本身，`strip_local_path_prefix` 返回 `None`，保持显示完整路径，避免渲染为空字符串（`codex-rs/tui/src/markdown_render.rs:905-921`）

- **CRLF 代码块**：pulldown-cmark 可能将 CRLF 代码块拆分为多个 Text 事件。缓冲区直接拼接而不插入分隔符，避免产生多余空行

- **info string 元数据**：围栏代码块的 info string（如 `rust,no_run`、`rust title=demo`）会被按逗号/空格/tab 分割，只取首个 token 作为语言标识传给高亮引擎（`codex-rs/tui/src/markdown_render.rs:536-541`）

- **内联样式嵌套**：样式通过栈实现 patch 合并，`**bold *italic***` 正确渲染为粗体 + 粗斜体，而非丢失外层样式

- **不支持的元素**：Table、Image、FootnoteDefinition、MetadataBlock、TaskListMarker 等标签被静默忽略，不会产生输出