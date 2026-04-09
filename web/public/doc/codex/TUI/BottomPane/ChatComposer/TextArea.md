# TextArea

## 概述与职责

`TextArea` 是 TUI 聊天输入区（ChatComposer）背后的**可编辑文本缓冲区组件**。它位于系统层级 `TUI → BottomPane → ChatComposer` 之下，是用户在终端中撰写消息时直接交互的底层文本编辑引擎。

在 BottomPane 的兄弟模块中，ChatComposer 管理历史导航、粘贴检测、斜杠命令路由等高层逻辑，而 TextArea 则专注于更基础的职责：

- **原始 UTF-8 文本缓冲区**：持有用户输入的全部文本内容
- **字节索引光标**：支持 preferred-column 跟踪的光标系统
- **原子化 TextElement**：类似占位符的标记区间，随编辑操作整体移动（不会被部分删除或插入打断）
- **Unicode 感知的自动换行**：基于 `textwrap` 库，通过 `RefCell<WrapCache>` 缓存换行结果
- **Emacs 风格编辑快捷键**：Ctrl+A/E/K/U/Y、单条目 kill buffer
- **词边界导航**：Ctrl+Left/Right、Alt+B/F
- **ratatui 渲染集成**：实现 `StatefulWidgetRef`，将光标位置映射到屏幕坐标并支持滚动

> 源码位置：`codex-rs/tui/src/bottom_pane/textarea.rs`

## 核心数据结构

### `TextArea`

```rust
pub(crate) struct TextArea {
    text: String,              // 原始 UTF-8 文本缓冲区
    cursor_pos: usize,         // 字节索引光标位置
    wrap_cache: RefCell<Option<WrapCache>>,  // 缓存的换行结果
    preferred_col: Option<usize>,            // 垂直移动时记住的目标列
    elements: Vec<TextElement>,              // 原子化文本元素列表
    next_element_id: u64,                    // 元素 ID 自增计数器
    kill_buffer: String,                     // 单条目 kill buffer（Ctrl+K/U 的内容）
}
```

> 源码位置：`codex-rs/tui/src/bottom_pane/textarea.rs:61-69`

### `TextElement`

内部结构，表示缓冲区中一段"原子化"的文本区间。元素拥有唯一 `id`、字节范围 `range: Range<usize>` 和可选的 `name`。元素内部不允许光标停留或文本插入——所有编辑操作都将元素视为不可分割的整体。

```rust
struct TextElement {
    id: u64,
    range: Range<usize>,
    name: Option<String>,
}
```

> 源码位置：`codex-rs/tui/src/bottom_pane/textarea.rs:38-43`

### `WrapCache`

缓存指定宽度下的换行结果，避免重复计算。每个条目是一个 `Range<usize>` 表示该行在原始文本中的字节范围。任何修改文本的操作都会清空缓存（`self.wrap_cache.replace(None)`），下次渲染时按需重新计算。

```rust
struct WrapCache {
    width: u16,
    lines: Vec<Range<usize>>,
}
```

> 源码位置：`codex-rs/tui/src/bottom_pane/textarea.rs:71-75`

### `TextAreaState`

ratatui 渲染所需的外部状态，仅包含一个 `scroll: u16` 字段，记录当前滚动到第几行。

> 源码位置：`codex-rs/tui/src/bottom_pane/textarea.rs:77-81`

## 关键流程

### 1. 文本编辑流程

所有文本修改最终汇聚到两条路径：

**插入路径** (`insert_str` / `insert_str_at`)：
1. 通过 `clamp_pos_for_insertion()` 确保插入点不在元素内部（如果在，则吸附到最近的元素边界）
2. 在底层 `String` 上执行 `insert_str`
3. 清空 `wrap_cache`
4. 如果插入点在光标之前或等于光标，光标后移 `text.len()` 字节
5. 调用 `shift_elements()` 将所有在插入点之后的元素范围后移

**替换/删除路径** (`replace_range` → `replace_range_raw`)：
1. `replace_range()` 先调用 `expand_range_to_element_boundaries()` 将范围扩展到覆盖所有相交元素的完整边界（元素不会被部分删除）
2. `replace_range_raw()` 执行底层字符串替换，清空缓存
3. `update_elements_after_replace()` 移除被完全覆盖的元素，偏移后续元素
4. 光标位置根据三种情况调整：在编辑区之前（不变）、在编辑区内（移到新文本末尾）、在编辑区之后（按差值偏移）
5. `clamp_pos_to_nearest_boundary()` 确保光标不落在元素内部

### 2. Kill / Yank 流程（Emacs 风格）

TextArea 维护一个**单条目 kill buffer**（非 Emacs 完整的 kill ring）：

- **Ctrl+K** (`kill_to_end_of_line`)：从光标到行尾的文本被移除并存入 `kill_buffer`。如果光标已在行尾且有后续换行符，则删除该换行符（`codex-rs/tui/src/bottom_pane/textarea.rs:587-601`）
- **Ctrl+U** (`kill_to_beginning_of_line`)：从行首到光标的文本被 kill。如果光标已在行首且前方有换行符，则删除那个换行符（`codex-rs/tui/src/bottom_pane/textarea.rs:604-615`）
- **Ctrl+W** / **Alt+Backspace** (`delete_backward_word`)：向后删除一个词并存入 kill buffer
- **Alt+D** / **Alt+Delete** (`delete_forward_word`)：向前删除一个词并存入 kill buffer
- **Ctrl+Y** (`yank`)：将 kill buffer 内容插入光标处（`codex-rs/tui/src/bottom_pane/textarea.rs:622-628`）

**关键设计决策**：全缓冲区替换 API（`set_text_clearing_elements` / `set_text_with_elements`）**不会清空 kill buffer**。这是有意为之——当用户提交消息或触发斜杠命令后，缓冲区被清空，但 Ctrl+Y 仍可恢复上一次 kill 的内容。模块顶部的文档注释明确记录了这个契约（`codex-rs/tui/src/bottom_pane/textarea.rs:1-11`）。

### 3. 光标移动与 preferred-column 跟踪

垂直移动（上/下箭头、Ctrl+P/N）使用 **preferred column** 机制：

1. 首次垂直移动时，记录当前光标的显示列宽（display width，非字节偏移）到 `preferred_col`
2. 移动到目标行时，调用 `move_to_display_col_on_line()` 按显示宽度逐 grapheme 定位，尽量接近 preferred column
3. 连续垂直移动保持 `preferred_col` 不变，直到用户进行水平移动或编辑操作时才重置为 `None`

移动优先使用 **wrapped lines**（视觉行）导航：如果 `wrap_cache` 中有缓存数据，上/下移动跨越的是换行后的视觉行而非逻辑行。只有在缓存不可用时才回退到逻辑行（按 `\n` 分隔）导航（`codex-rs/tui/src/bottom_pane/textarea.rs:657-786`）。

### 4. 词边界导航

`beginning_of_previous_word()` 和 `end_of_next_word()` 的词边界判定逻辑（`codex-rs/tui/src/bottom_pane/textarea.rs:1210-1250`）：

1. 跳过空白字符
2. 判断当前字符是否为"分隔符"（`` `~!@#$%^&*()-=+[{]}\|;:'",.<>/? ``）
3. 连续的同类字符（都是分隔符或都不是分隔符）构成一个"词"
4. 通过 `adjust_pos_out_of_elements()` 确保结果位置不在元素内部

触发方式：Alt+B / Ctrl+Left（向前词跳转）、Alt+F / Ctrl+Right / Alt+Right（向后词跳转）。

### 5. Unicode 感知的自动换行

`wrapped_lines()` 方法（`codex-rs/tui/src/bottom_pane/textarea.rs:1265-1285`）：

1. 检查 `RefCell<Option<WrapCache>>` 中的缓存是否存在且宽度匹配
2. 缓存失效时，调用 `crate::wrapping::wrap_ranges()` 配合 `textwrap::Options` 和 `FirstFit` 算法重新计算
3. 结果是 `Vec<Range<usize>>`——每个 Range 表示一个视觉行在原始文本中的字节范围
4. 返回 `Ref<'_, Vec<Range<usize>>>`（共享借用），避免不必要的 clone

缓存在每次文本修改时被清空（所有调用 `self.wrap_cache.replace(None)` 的地方）。

### 6. 渲染流程

TextArea 实现了两个 ratatui trait：

- **`WidgetRef`**：无状态渲染，不带滚动（`codex-rs/tui/src/bottom_pane/textarea.rs:1321-1326`）
- **`StatefulWidgetRef`**：带滚动状态的渲染，更新 `TextAreaState.scroll`（`codex-rs/tui/src/bottom_pane/textarea.rs:1328-1340`）

渲染步骤：
1. 获取当前宽度下的 wrapped lines
2. 调用 `effective_scroll()` 计算滚动偏移，保证光标始终可见
3. 计算可见行范围 `[scroll, scroll + area.height)`
4. `render_lines()` 逐行渲染：先绘制普通文本，再叠加元素区间的 **Cyan** 高亮样式
5. 元素渲染通过计算与当前行的字节重叠区间、换算 x 偏移来精确定位（`codex-rs/tui/src/bottom_pane/textarea.rs:1378-1408`）

额外渲染变体：
- `render_ref_masked()`：将所有字符替换为遮罩字符（如 `*`），用于密码输入场景
- `render_ref_styled()`：应用自定义 base style，用于 Zellij 等终端复用器环境中覆盖继承样式

## 函数签名

### 全缓冲区操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `set_text_clearing_elements` | `(&mut self, text: &str)` | 替换全部文本并清空元素，保留 kill buffer |
| `set_text_with_elements` | `(&mut self, text: &str, elements: &[UserTextElement])` | 替换文本并重建元素列表 |

### 文本编辑

| 方法 | 签名 | 说明 |
|------|------|------|
| `insert_str` | `(&mut self, text: &str)` | 在光标处插入文本 |
| `insert_str_at` | `(&mut self, pos: usize, text: &str)` | 在指定字节位置插入文本 |
| `replace_range` | `(&mut self, range: Range<usize>, text: &str)` | 替换指定范围（自动扩展到元素边界） |
| `delete_backward` | `(&mut self, n: usize)` | 向后删除 n 个 grapheme |
| `delete_forward` | `(&mut self, n: usize)` | 向前删除 n 个 grapheme |
| `delete_backward_word` | `(&mut self)` | 向后删除一个词（存入 kill buffer） |
| `delete_forward_word` | `(&mut self)` | 向前删除一个词（存入 kill buffer） |
| `kill_to_end_of_line` | `(&mut self)` | Ctrl+K：kill 到行尾 |
| `kill_to_beginning_of_line` | `(&mut self)` | Ctrl+U：kill 到行首 |
| `yank` | `(&mut self)` | Ctrl+Y：插入 kill buffer 内容 |

### 元素操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `insert_element` | `(&mut self, text: &str) -> u64` | 插入文本并标记为原子元素，返回 ID |
| `add_element_range` | `(&mut self, range: Range<usize>) -> Option<u64>` | 将现有文本标记为元素（不修改文本） |
| `remove_element_range` | `(&mut self, range: Range<usize>) -> bool` | 移除指定范围的元素标记 |
| `replace_element_payload` | `(&mut self, old: &str, new: &str) -> bool` | 按内容匹配并替换元素文本 |
| `text_elements` | `(&self) -> Vec<UserTextElement>` | 导出所有元素为协议层类型 |

### 光标与查询

| 方法 | 签名 | 说明 |
|------|------|------|
| `cursor` | `(&self) -> usize` | 返回当前光标字节位置 |
| `set_cursor` | `(&mut self, pos: usize)` | 设置光标（自动 clamp 到字符和元素边界） |
| `cursor_pos_with_state` | `(&self, area: Rect, state: TextAreaState) -> Option<(u16, u16)>` | 计算光标的屏幕坐标（含滚动） |
| `desired_height` | `(&self, width: u16) -> u16` | 返回给定宽度下需要的行数 |
| `input` | `(&mut self, event: KeyEvent)` | 处理按键事件的主入口 |

## 按键绑定

`input()` 方法（`codex-rs/tui/src/bottom_pane/textarea.rs:290-533`）处理的完整按键映射：

| 按键 | 操作 |
|------|------|
| 普通字符 / Shift+字符 | 插入字符 |
| Enter / Ctrl+J / Ctrl+M | 插入换行 |
| Backspace / Ctrl+H | 删除前一个 grapheme |
| Delete / Ctrl+D | 删除后一个 grapheme |
| Alt+Backspace / Ctrl+W / Ctrl+Alt+H | 向后删除一个词 |
| Alt+Delete / Alt+D | 向前删除一个词 |
| Left / Ctrl+B | 光标左移一个 grapheme |
| Right / Ctrl+F | 光标右移一个 grapheme |
| Up / Ctrl+P | 光标上移一行（视觉行） |
| Down / Ctrl+N | 光标下移一行（视觉行） |
| Alt+Left / Ctrl+Left / Alt+B | 跳到前一个词的开头 |
| Alt+Right / Ctrl+Right / Alt+F | 跳到后一个词的末尾 |
| Home | 移到行首 |
| End | 移到行尾 |
| Ctrl+A | 移到行首（已在行首时移到上一行首） |
| Ctrl+E | 移到行尾（已在行尾时移到下一行尾） |
| Ctrl+K | Kill 到行尾 |
| Ctrl+U | Kill 到行首 |
| Ctrl+Y | Yank（粘贴 kill buffer） |

此外，为兼容某些终端发送 C0 控制字符而非修饰键的情况，`^B`（0x02）、`^F`（0x06）、`^P`（0x10）、`^N`（0x0E）也被映射为对应的光标移动操作。Windows AltGr 组合键（同时报告 ALT+CONTROL）被识别并作为普通字符插入。

## 边界 Case 与注意事项

- **元素原子性**：光标永远不会停在元素内部。所有光标设置操作都经过 `clamp_pos_to_nearest_boundary()` 吸附到最近的元素边界。删除操作通过 `expand_range_to_element_boundaries()` 确保要么完整删除整个元素，要么完全不触及。

- **Kill buffer 持久性**：`set_text_clearing_elements()` 和 `set_text_with_elements()` 这两个全缓冲区替换 API **不清空 kill buffer**。这意味着用户提交消息（清空输入框）后仍可通过 Ctrl+Y 恢复之前 kill 的内容。这是有意设计，不是 bug。

- **Ctrl+A / Ctrl+E 的额外行为**：与 Home/End 不同，Ctrl+A 在光标已在行首时会继续移到上一行行首；Ctrl+E 在光标已在行尾时会移到下一行行尾。这提供了跨行快速导航能力。

- **wrap cache 的 RefCell 模式**：`wrapped_lines()` 返回 `Ref<'_, Vec<Range<usize>>>`（通过 `Ref::map`），这意味着在持有该引用期间不能修改文本。所有渲染路径都遵循"先获取 lines 引用、只读使用、自然释放"的模式。

- **滚动保证**：`effective_scroll()` 保证两个不变量：内容不足一屏时不滚动（scroll = 0）；光标所在行始终在可见范围 `[scroll, scroll + height)` 内。

- **元素渲染样式**：元素区间在渲染时以 **Cyan** 前景色高亮显示，叠加在 base style 之上（`codex-rs/tui/src/bottom_pane/textarea.rs:1404`）。

- **遮罩渲染**：`render_ref_masked()` 将每个字符替换为指定的遮罩字符，适用于密码等敏感输入场景。注意这里是按 `char` 而非 grapheme 替换。