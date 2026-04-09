# TextLayout — 文本布局基础设施

## 概述与职责

TextLayout 是 TUI 渲染管线的底层文本布局层，为 **ContentRendering** 子系统提供可复用的布局原语。它位于 `TUI > ContentRendering` 层级中，被 ChatSurface、BottomPane 以及 PickersAndStatus 等兄弟模块间接消费。

该模块解决的核心问题是：**如何在固定宽度的终端窗口中，将带有样式的富文本正确地排列、换行、截断并组合成可渲染的 widget 树**。

模块由以下 7 个文件组成，各自承担独立职责：

| 文件 | 职责 |
|------|------|
| `render/mod.rs` | `Insets` 布局边距 + `RectExt` 扩展 trait |
| `render/renderable.rs` | `Renderable` trait 与布局容器（Column/Flex/Row/Inset） |
| `render/line_utils.rs` | 行级工具函数（克隆、空行检测、前缀插入） |
| `wrapping.rs` | URL 感知的自适应换行引擎 |
| `live_wrap.rs` | `RowBuilder` 增量流式文本换行 |
| `line_truncation.rs` | 行截断与省略号支持 |
| `text_formatting.rs` | JSON 紧凑格式化、grapheme 截断、路径中间截断等工具 |

---

## 关键流程

### 1. Renderable 布局树的构建与渲染

整个 TUI 的 widget 布局围绕 `Renderable` trait 构建。各 widget 实现该 trait 后，通过 `ColumnRenderable`、`FlexRenderable`、`RowRenderable` 等容器组合成树形结构。渲染时自顶向下分配区域。

**流程 walkthrough：**

1. 上层创建 `ColumnRenderable` 或 `FlexRenderable`，通过 `push()` 依次加入子 widget
2. 渲染引擎调用根容器的 `desired_height(width)` 计算所需高度
3. 调用 `render(area, buf)` 时，容器遍历子节点，根据各自 `desired_height` 分配子区域（`Rect`），逐一调用子节点的 `render`
4. `FlexRenderable` 采用 Flutter 风格的二阶段分配：先给非 flex 子节点分配固定高度，再按 flex 因子按比例分配剩余空间（`renderable.rs:242-291`）
5. 光标位置通过 `cursor_pos()` 向上冒泡——取第一个返回 `Some` 的子节点

### 2. URL 感知的自适应换行

这是该模块最复杂的流程，解决终端中 URL 被拆行后不可点击的问题。

**流程 walkthrough：**

1. 调用 `adaptive_wrap_line(line, opts)` 或 `adaptive_wrap_lines(lines, opts)`
2. 对每一行，先调用 `line_contains_url_like()` 检测是否包含 URL（`wrapping.rs:179-186`）
3. URL 检测逻辑：将所有 span 内容拼接为纯文本 → 按空白分词 → 逐 token 检查是否匹配 URL 模式（`wrapping.rs:213-215`）
4. **若检测到 URL**：切换到 `url_preserving_wrap_options`，使用 `AsciiSpace` 分词（不在 `/` `-` 处断开），并安装自定义 `WordSplitter`——URL token 返回空分割点列表，非 URL token 返回所有字符边界（`wrapping.rs:464-480`）
5. **若无 URL**：使用默认 `textwrap` 换行策略，在连字符和单词边界处正常断行
6. `word_wrap_line` 将带样式的 `Line` 展平为纯文本 → 调用 `textwrap` 获取换行范围 → 通过 `slice_line_spans` 将范围映射回原始 span 边界，保留样式信息（`wrapping.rs:638-719`）

### 3. 增量流式换行（RowBuilder）

用于 streaming 场景——LLM 逐块输出文本时实时换行显示。

1. 创建 `RowBuilder::new(target_width)`
2. 每收到一段文本片段调用 `push_fragment(fragment)`
3. `push_fragment` 逐字符扫描 `\n`，遇到换行则 `flush_current_line(explicit_break=true)`
4. 非换行部分追加到 `current_line` 缓冲区，然后调用 `wrap_current_line()` 循环调用 `take_prefix_by_width` 按 Unicode 显示宽度切分
5. 通过 `drain_rows()` 或 `display_rows()` 获取已产生的行
6. `drain_commit_ready(max_keep)` 可淘汰最早的行，用于控制滚动缓冲区大小

---

## 函数签名与参数说明

### Renderable trait（`render/renderable.rs:13-19`）

```rust
pub trait Renderable {
    fn render(&self, area: Rect, buf: &mut Buffer);
    fn desired_height(&self, width: u16) -> u16;
    fn cursor_pos(&self, _area: Rect) -> Option<(u16, u16)> { None }
}
```

- **`render`**：在给定 `area` 内渲染到 `Buffer`
- **`desired_height`**：给定可用宽度，返回所需行数
- **`cursor_pos`**：返回光标 (x, y) 坐标，默认 `None`

已有的 blanket impl：`()`, `&str`, `String`, `Span`, `Line`, `Paragraph`, `Option<R>`, `Arc<R>`

### Insets 与 RectExt（`render/mod.rs:7-50`）

```rust
pub struct Insets { left: u16, top: u16, right: u16, bottom: u16 }
impl Insets {
    pub fn tlbr(top: u16, left: u16, bottom: u16, right: u16) -> Self;
    pub fn vh(v: u16, h: u16) -> Self;  // 对称的垂直/水平边距
}
pub trait RectExt {
    fn inset(&self, insets: Insets) -> Rect;
}
```

`inset()` 使用 `saturating_sub` / `saturating_add` 避免溢出，安全地缩小矩形区域。

### 自适应换行（`wrapping.rs`）

```rust
pub(crate) fn adaptive_wrap_line<'a>(line: &'a Line<'a>, base: RtOptions<'a>) -> Vec<Line<'a>>;
pub(crate) fn adaptive_wrap_lines<'a, I, L>(lines: I, width_or_options: RtOptions<'a>) -> Vec<Line<'static>>;
pub(crate) fn word_wrap_line<'a, O>(line: &'a Line<'a>, width_or_options: O) -> Vec<Line<'a>>;
pub(crate) fn word_wrap_lines<'a, I, O, L>(lines: I, width_or_options: O) -> Vec<Line<'static>>;
```

- **`adaptive_wrap_*`**：自动检测 URL 并切换换行策略，是大多数渲染路径的首选入口
- **`word_wrap_*`**：直接使用传入的 options，不做 URL 检测
- `RtOptions` 是对 `textwrap::Options` 的封装，支持 ratatui `Line` 作为缩进前缀

### RowBuilder（`live_wrap.rs:21-183`）

```rust
pub struct RowBuilder { /* ... */ }
impl RowBuilder {
    pub fn new(target_width: usize) -> Self;
    pub fn push_fragment(&mut self, fragment: &str);
    pub fn end_line(&mut self);            // 等同于 push '\n'
    pub fn drain_rows(&mut self) -> Vec<Row>;
    pub fn display_rows(&self) -> Vec<Row>; // 包含当前未完成行
    pub fn drain_commit_ready(&mut self, max_keep: usize) -> Vec<Row>;
    pub fn set_width(&mut self, width: usize); // 宽度变化时重新换行
}
```

`Row` 结构体包含 `text: String` 和 `explicit_break: bool`（区分换行符断行与硬换行）。

### 行截断（`line_truncation.rs`）

```rust
pub(crate) fn line_width(line: &Line<'_>) -> usize;
pub(crate) fn truncate_line_to_width(line: Line<'static>, max_width: usize) -> Line<'static>;
pub(crate) fn truncate_line_with_ellipsis_if_overflow(line: Line<'static>, max_width: usize) -> Line<'static>;
```

- `truncate_line_to_width`：逐 span、逐字符按 Unicode 显示宽度截断，保留样式
- `truncate_line_with_ellipsis_if_overflow`：溢出时截断至 `max_width - 1` 并追加 `…`，省略号继承最后一个 span 的样式

### 文本格式化工具（`text_formatting.rs`）

```rust
pub(crate) fn capitalize_first(input: &str) -> String;
pub(crate) fn format_and_truncate_tool_result(text: &str, max_lines: usize, line_width: usize) -> String;
pub(crate) fn format_json_compact(text: &str) -> Option<String>;
pub(crate) fn truncate_text(text: &str, max_graphemes: usize) -> String;
pub(crate) fn center_truncate_path(path: &str, max_width: usize) -> String;
pub(crate) fn proper_join<T: AsRef<str>>(items: &[T]) -> String;
```

- **`format_and_truncate_tool_result`**：先尝试将文本作为 JSON 紧凑格式化（为了在 ratatui 只能在空白处换行的限制下获得更好的显示效果），再按 grapheme 数截断
- **`center_truncate_path`**：路径中间截断，保留首尾段并插入 `…`，例如 `~/hello/the/…/very/fast`
- **`proper_join`**：英文列表连接（`"a, b and c"`）

### line_utils（`render/line_utils.rs`）

```rust
pub fn line_to_static(line: &Line<'_>) -> Line<'static>;
pub fn push_owned_lines<'a>(src: &[Line<'a>], out: &mut Vec<Line<'static>>);
pub fn is_blank_line_spaces_only(line: &Line<'_>) -> bool;
pub fn prefix_lines(lines: Vec<Line<'static>>, initial_prefix: Span<'static>, subsequent_prefix: Span<'static>) -> Vec<Line<'static>>;
```

- `line_to_static`：深拷贝 ratatui `Line` 的所有 span 为 `'static` 生命周期
- `prefix_lines`：为行列表添加前缀（首行用 `initial_prefix`，后续行用 `subsequent_prefix`），常用于列表项渲染

---

## 接口/类型定义

### RenderableItem（`render/renderable.rs:21-24`）

```rust
pub enum RenderableItem<'a> {
    Owned(Box<dyn Renderable + 'a>),
    Borrowed(&'a dyn Renderable),
}
```

用于在容器中灵活持有 owned 或 borrowed 的 `Renderable` 对象，避免不必要的克隆。

### 布局容器

| 容器 | 布局方向 | 特点 |
|------|----------|------|
| `ColumnRenderable` | 垂直 | 子节点按 `desired_height` 顺序排列 |
| `FlexRenderable` | 垂直 + flex | 非 flex 子节点优先分配，flex 子节点按比例分配剩余空间 |
| `RowRenderable` | 水平 | 每个子节点指定固定宽度 |
| `InsetRenderable` | 包装 | 为子节点添加 `Insets` 边距 |

### RtOptions（`wrapping.rs:536-561`）

```rust
pub struct RtOptions<'a> {
    pub width: usize,
    pub line_ending: textwrap::LineEnding,
    pub initial_indent: Line<'a>,     // ratatui Line 作为缩进前缀
    pub subsequent_indent: Line<'a>,
    pub break_words: bool,
    pub wrap_algorithm: textwrap::WrapAlgorithm,
    pub word_separator: textwrap::WordSeparator,
    pub word_splitter: textwrap::WordSplitter,
}
```

对 `textwrap::Options` 的封装，关键区别是 indent 字段使用 ratatui `Line`（支持带样式的缩进前缀），而非纯字符串。

### Row（`live_wrap.rs:6-16`）

```rust
pub struct Row {
    pub text: String,
    pub explicit_break: bool,  // true = 原始文本有 \n，false = 硬换行
}
```

---

## 边界 Case 与注意事项

- **URL 检测是启发式的**：文件路径 `src/main.rs` 不会被误判为 URL，但少数极端 case 可能产生误报（此时仅影响换行策略，不影响正确性）。检测规则在 `text_contains_url_like` 的文档注释中有详细说明（`wrapping.rs:202-215`）
- **RowBuilder 的宽度变化**：调用 `set_width()` 会将所有已有行重新拼接并重新换行，这是一个 O(n) 操作
- **`truncate_line_with_ellipsis_if_overflow` 的性能说明**：该函数先做一次完整宽度扫描判断是否溢出，溢出时再做一次截断。注释明确标注"适用于短 UI 行，在大循环中使用需重新评估性能"（`line_truncation.rs:69-74`）
- **`format_and_truncate_tool_result` 的近似计算**：用 grapheme 数近似终端列数，每行减 1 作为修正因子，对宽字符（CJK、emoji）不完全精确（`text_formatting.rs:24-27`）
- **`wrap_ranges` 使用 unsafe**：通过指针差计算 borrowed 字符串在原文中的偏移（`wrapping.rs:50-51`），这依赖 `textwrap` 返回的 `Cow::Borrowed` 确实指向原始文本
- **`take_prefix_by_width` 对零宽字符的处理**：使用 `UnicodeWidthChar::width` 获取字符宽度，零宽字符（如组合标记）宽度为 0，不消耗列预算但会被包含在输出中
- **FlexRenderable 的舍入处理**：最后一个 flex 子节点获得所有剩余空间（而非按比例），以避免浮点舍入导致空间未被完全分配（`renderable.rs:269-275`）