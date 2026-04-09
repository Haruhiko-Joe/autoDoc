# Diff 渲染模块

## 概述与职责

`diff_render` 是 TUI 内容渲染管线（ContentRendering）中的核心模块，负责将文件变更（`FileChange`）渲染为带有行号、gutter 符号（`+`/`-`/空格）和可选语法高亮的终端 diff 视图。该模块同时提供 diff 摘要生成和路径显示辅助功能，供 HistoryCell 在聊天记录中展示文件变更使用。

在整个 TUI 层级中，ContentRendering 被 ChatSurface 和 BottomPane 调用来生成 transcript 内容和审批预览中的 diff 渲染。本模块是 ContentRendering 中专门处理 diff 可视化的部分。

> 源码位置：`codex-rs/tui/src/diff_render.rs`（约 2480 行）

## 关键流程

### 1. 单文件变更渲染流程（`render_change`）

这是模块最核心的函数，将一个 `FileChange` 枚举转化为 ratatui 的 `RtLine` 列表：

1. 调用 `current_diff_render_style_context()` 一次性快照当前终端的 diff 样式上下文（主题、色深、背景色）
2. 根据变更类型分支处理：
   - **`FileChange::Add`**：将整个文件内容作为一个整体交给 `highlight_code_to_styled_spans` 进行语法高亮，然后逐行调用 `push_wrapped_diff_line_inner_with_theme_and_color_level` 渲染为带 `+` 前缀的绿色行
   - **`FileChange::Delete`**：与 Add 对称，使用 `-` 前缀和红色样式
   - **`FileChange::Update`**：使用 `diffy::Patch::from_str` 解析 unified diff，**逐 hunk 高亮**（而非逐行），hunk 之间插入 `⋮` 分隔符

> 源码位置：`codex-rs/tui/src/diff_render.rs:474-736`

### 2. Hunk 级别语法高亮策略

Update diff 的高亮策略是本模块最关键的设计决策：

1. 将 hunk 中所有行（Insert/Delete/Context）拼接成一个完整的文本块
2. 对这个拼接后的文本块调用一次 `highlight_code_to_styled_spans`
3. 将返回的语法 span 按行索引映射回各 diff 行

这样做的目的是**保持 syntect 解析器状态在 hunk 内的连续行之间传递**，确保跨行字符串、块注释等语法结构的高亮正确。跨 hunk 的状态不保留，因为 hunk 之间有视觉分隔且会在上下文边界重新同步。

```rust
// codex-rs/tui/src/diff_render.rs:607-621
let hunk_syntax_lines = diff_lang.and_then(|language| {
    let hunk_text: String = h
        .lines()
        .iter()
        .map(|line| match line {
            diffy::Line::Insert(text)
            | diffy::Line::Delete(text)
            | diffy::Line::Context(text) => *text,
        })
        .collect();
    let syntax_lines = highlight_code_to_styled_spans(&hunk_text, language)?;
    (syntax_lines.len() == h.lines().len()).then_some(syntax_lines)
});
```

### 3. 样式上下文解析流程

渲染前需要确定终端环境的配色方案，整个过程在每帧开始时执行一次：

1. `diff_theme()` → 探测终端背景色（`default_bg()`），通过 `is_light()` 判断明暗 → 返回 `DiffTheme::Dark` 或 `DiffTheme::Light`
2. `diff_color_level()` → 基于 `supports-color` 库的报告和终端特征（Windows Terminal 特殊处理）确定 `DiffColorLevel`
3. `resolve_diff_backgrounds()` → 查询当前语法主题的 `markup.inserted`/`markup.deleted`（或 `diff.inserted`/`diff.deleted`）scope 背景色，覆盖硬编码调色板
4. 三者打包为 `DiffRenderStyleContext`，传递给所有行级渲染函数

> 源码位置：`codex-rs/tui/src/diff_render.rs:214-223`

### 4. Diff 摘要生成流程（`create_diff_summary`）

用于 HistoryCell 中展示多文件变更摘要：

1. `collect_rows()` 遍历所有变更，统计每个文件的增删行数，按路径排序
2. `render_changes_block()` 生成带标题的渲染输出：
   - 单文件时显示 `• Added/Deleted/Edited <path> (+N -M)`
   - 多文件时显示 `• Edited N files (+total -total)`，每个文件下方缩进展示 `└ <path> (+n -m)` 和实际 diff 内容
3. 文件重命名（`move_path`）时使用 `→` 箭头显示新旧路径，并用目标扩展名决定语法高亮

> 源码位置：`codex-rs/tui/src/diff_render.rs:345-464`

## 函数签名与参数说明

### 公开接口

#### `current_diff_render_style_context() -> DiffRenderStyleContext`

快照当前终端环境的 diff 样式上下文。每帧调用一次，不要逐行调用。

> 源码位置：`codex-rs/tui/src/diff_render.rs:214-223`

#### `create_diff_summary(changes, cwd, wrap_cols) -> Vec<RtLine<'static>>`

生成多文件 diff 摘要的 ratatui 行列表。

- **changes**: `&HashMap<PathBuf, FileChange>` — 路径到变更的映射
- **cwd**: `&Path` — 用于相对化路径显示的当前工作目录
- **wrap_cols**: `usize` — 可用的列宽

> 源码位置：`codex-rs/tui/src/diff_render.rs:345-352`

#### `push_wrapped_diff_line_with_style_context(...)  -> Vec<RtLine<'static>>`

渲染单个纯文本 diff 行（无语法高亮），自动换行。供主题选择器预览等外部调用者使用。

> 源码位置：`codex-rs/tui/src/diff_render.rs:787-806`

#### `push_wrapped_diff_line_with_syntax_and_style_context(...) -> Vec<RtLine<'static>>`

与上述函数类似，但叠加语法高亮 span。Delete 行会额外加 `DIM` modifier 使语法色不压过删除提示。

> 源码位置：`codex-rs/tui/src/diff_render.rs:815-835`

#### `display_path_for(path, cwd) -> String`

将绝对路径转换为相对于 cwd 的显示路径。支持 jj 等无 `.git` 的工作区。逻辑优先级：
1. 相对路径直接返回
2. 尝试 `strip_prefix(cwd)`
3. 同一 git 仓库内使用 `pathdiff::diff_paths`
4. 不同仓库使用 `~/` 前缀

> 源码位置：`codex-rs/tui/src/diff_render.rs:741-762`

#### `calculate_add_remove_from_diff(diff: &str) -> (usize, usize)`

从 unified diff 字符串解析增删行数。不可解析的 diff 返回 `(0, 0)`。

> 源码位置：`codex-rs/tui/src/diff_render.rs:764-779`

#### `line_number_width(max_line_number: usize) -> usize`

计算行号列的显示宽度（即最大行号的十进制位数），用于 gutter 对齐。

> 源码位置：`codex-rs/tui/src/diff_render.rs:1022-1028`

## 接口/类型定义

### `DiffLineType`（`pub(crate)`）

分类 diff 行的类型，决定 gutter 符号和样式选择：

| 变体 | gutter 符号 | 含义 |
|------|------------|------|
| `Insert` | `+` | 新增行，绿色 |
| `Delete` | `-` | 删除行，红色（语法高亮时额外 DIM） |
| `Context` | 空格 | 上下文行，默认样式 |

### `DiffTheme`（内部）

控制 diff 渲染使用的配色主题，由终端背景亮度决定：

| 变体 | 触发条件 | 视觉风格 |
|------|---------|---------|
| `Dark` | 背景色为深色或无法检测 | 低饱和度色调背景（`#213A2B` 绿、`#4A221D` 红） |
| `Light` | 背景色为浅色 | GitHub 风格粉彩背景（`#dafbe1` 绿、`#ffebe9` 红） |

### `DiffColorLevel`（内部）

渲染器自身的色深概念，从 `StdoutColorLevel` 派生但不完全等同：

| 变体 | 背景着色 | 说明 |
|------|---------|------|
| `TrueColor` | 有 | 24-bit RGB |
| `Ansi256` | 有 | 256 色索引 |
| `Ansi16` | **无** | 仅前景着色，避免饱和色压过内容 |

### `RichDiffColorLevel`（内部）

`DiffColorLevel` 中支持背景着色的子集（TrueColor、Ansi256）。通过 `from_diff_color_level()` 构造，ANSI-16 返回 `None`，使调用者可以优雅地跳过背景渲染。

### `DiffRenderStyleContext`（`pub(crate)`）

预计算的渲染状态包，每帧计算一次：

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `DiffTheme` | 明暗主题 |
| `color_level` | `DiffColorLevel` | 色深级别 |
| `diff_backgrounds` | `ResolvedDiffBackgrounds` | 已解析的增/删行背景色 |

### `ResolvedDiffBackgrounds`（内部）

| 字段 | 类型 | 说明 |
|------|------|------|
| `add` | `Option<Color>` | Insert 行背景色，ANSI-16 时为 `None` |
| `del` | `Option<Color>` | Delete 行背景色，ANSI-16 时为 `None` |

### `DiffSummary`（`pub`）

持有一组文件变更及工作目录，实现了 `From<DiffSummary> for Box<dyn Renderable>`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `changes` | `HashMap<PathBuf, FileChange>` | 路径到变更的映射 |
| `cwd` | `PathBuf` | 当前工作目录 |

## 配色调色板

模块内置了三套调色板常量，按终端色深和明暗主题选用：

### Truecolor 调色板

| 常量 | RGB 值 | 用途 |
|------|--------|------|
| `DARK_TC_ADD_LINE_BG_RGB` | `#213A2B` | 深色主题 Insert 行背景 |
| `DARK_TC_DEL_LINE_BG_RGB` | `#4A221D` | 深色主题 Delete 行背景 |
| `LIGHT_TC_ADD_LINE_BG_RGB` | `#DAFBE1` | 浅色主题 Insert 行背景 |
| `LIGHT_TC_DEL_LINE_BG_RGB` | `#FFEBE9` | 浅色主题 Delete 行背景 |
| `LIGHT_TC_ADD_NUM_BG_RGB` | `#ACEEBB` | 浅色主题 Insert 行号 gutter 背景 |
| `LIGHT_TC_DEL_NUM_BG_RGB` | `#FFCECB` | 浅色主题 Delete 行号 gutter 背景 |
| `LIGHT_TC_GUTTER_FG_RGB` | `#1F2328` | 浅色主题 gutter 前景 |

### 256 色调色板

使用 xterm 索引号近似上述颜色（如 `22` = 深绿、`52` = 深红、`194` = 浅绿、`224` = 浅粉等）。

### 语法主题 Scope 覆盖

当活跃的语法主题为 `markup.inserted`/`markup.deleted`（或 fallback `diff.inserted`/`diff.deleted`）scope 定义了背景色时，这些颜色会覆盖硬编码调色板。ANSI-16 模式下无论主题如何均使用纯前景着色。

> 源码位置：`codex-rs/tui/src/diff_render.rs:225-263`

## 行渲染的视觉结构

每个 diff 行由四个视觉区域组成：

```
┌──────────┬──────┬──────────────────────────────────────────┐
│  gutter  │ sign │              content                     │
│ (line #) │ +/-  │  (plain or syntax-highlighted text)      │
└──────────┴──────┴──────────────────────────────────────────┘
```

加上一个全宽 `line_bg` 层通过 `RtLine::style()` 应用，使背景色覆盖到终端右边缘。

各区域在不同主题下的样式策略：
- **深色主题**：sign 和 content 共用一个样式（彩色前景 + 着色背景），gutter 使用 DIM
- **浅色主题**：sign 仅使用彩色前景（无背景，让 line_bg 透出），content 依赖 line_bg，gutter 使用不透明的高饱和度背景确保行号可读

> 源码位置：`codex-rs/tui/src/diff_render.rs:1117-1135`

## 长行换行机制（`wrap_styled_spans`）

当 diff 行超出可用列宽时，模块执行字符级硬换行：

1. 遍历每个 span 中的字符，使用 Unicode 显示宽度计算（tab 按 `TAB_WIDTH=4` 列计算）
2. 当下一个字符会溢出时，flush 当前行、开始新行
3. 如果单个字符（如 CJK 字符或 tab）就超出剩余空间，先 flush 再消费该字符
4. 样式在拆分边界上保持不变，不会因换行丢失语法着色

续行的 gutter 区域使用空白填充（无行号），与首行的 gutter 宽度对齐。

> 源码位置：`codex-rs/tui/src/diff_render.rs:940-1020`

## 边界 Case 与注意事项

- **Windows Terminal 色深提升**：Windows Terminal 实际支持 truecolor 但 `supports-color` 常报告 ANSI-16。模块通过 `diff_color_level_for_terminal` 在检测到 `WT_SESSION` 环境变量时自动提升到 truecolor，除非设置了 `FORCE_COLOR`（`codex-rs/tui/src/diff_render.rs:1089-1115`）
- **大 diff 跳过高亮**：当 patch 的总字节数或总行数超过阈值（由 `exceeds_highlight_limits` 判定），整个 patch 跳过语法高亮，避免数千次解析器初始化导致渲染卡顿（`codex-rs/tui/src/diff_render.rs:584-588`）
- **重命名文件使用目标扩展名**：当文件存在 `move_path` 时，语法高亮使用目标路径的扩展名而非源路径，因为 diff 内容反映的是新文件（`codex-rs/tui/src/diff_render.rs:456`）
- **无扩展名文件**：`detect_lang_for_path` 对没有扩展名的文件（如 `Makefile`）返回 `None`，此时不进行语法高亮
- **背景色无法检测时**：默认使用 `DiffTheme::Dark`，这在 CI 和管道输出中是安全的默认值
- **256 色量化**：使用感知距离（`perceptual_distance`）在 xterm 索引 16-255 中找最近似的颜色，跳过前 16 个系统色因其 RGB 值不可靠