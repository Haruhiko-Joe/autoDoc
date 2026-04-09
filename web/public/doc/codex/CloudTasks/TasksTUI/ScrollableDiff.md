# ScrollableDiff — 可滚动文本/Diff 显示控件

## 概述与职责

`ScrollableDiff` 是 CloudTasks TUI 中一个自包含的可滚动文本显示控件，位于模块层级 **CloudTasks → TasksTUI** 下。它被 `DiffOverlay` 用来展示 diff 内容和会话文本。

该控件的核心职责是：
1. **存储原始文本行**并在给定列宽下进行 Unicode 感知的自动换行
2. **维护滚动状态**（当前滚动位置、视口高度、内容总高度），并在几何尺寸变化时自动夹紧（clamp）滚动位置
3. **提供滚动操作 API**：逐行滚动、翻页、跳顶/跳底、滚动百分比指示

同级兄弟模块包括 TasksClient（API 客户端）、TasksMockClient（Mock 客户端）和 CloudRequirements（云端配置加载）。

## 核心数据结构

### `ScrollViewState`

滚动视图的几何与位置状态，是一个轻量的值类型（`Copy + Clone`）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `scroll` | `u16` | 当前滚动偏移（以换行后的行数计） |
| `viewport_h` | `u16` | 可见视口高度（行数） |
| `content_h` | `u16` | 换行后的内容总行数 |

关键方法 `clamp()` 确保 `scroll` 不超过 `content_h - viewport_h`，防止滚动越界（`scrollable_diff.rs:13-18`）。

### `ScrollableDiff`

主控件结构体，包含原始内容、换行缓存和滚动状态。

| 字段 | 类型 | 说明 |
|------|------|------|
| `raw` | `Vec<String>` | 原始未换行的文本行 |
| `wrapped` | `Vec<String>` | 按当前列宽换行后的行 |
| `wrapped_src_idx` | `Vec<usize>` | 每个 wrapped 行对应的原始行索引 |
| `wrap_cols` | `Option<u16>` | 当前缓存的换行列宽（`None` 表示需要重新换行） |
| `state` | `ScrollViewState` | 公开的滚动状态 |

> 源码位置：`scrollable_diff.rs:26-32`

## 关键流程

### 内容设置与换行流程

1. 调用方通过 `set_content(lines)` 传入原始文本行，此时清空换行缓存并将 `wrap_cols` 置为 `None` 强制下次重新换行（`scrollable_diff.rs:40-47`）
2. 调用方随后调用 `set_width(width)` 设置目标列宽。如果宽度未变且缓存有效则跳过；否则触发 `rewrap()` 并 clamp 滚动位置（`scrollable_diff.rs:50-57`）
3. 调用方通过 `set_viewport(height)` 更新视口高度，触发滚动 clamp（`scrollable_diff.rs:60-63`）

**典型调用顺序**：`set_content()` → `set_width()` → `set_viewport()` → 使用 `wrapped_lines()` 获取渲染数据。

### 自动换行算法（`rewrap`）

核心换行逻辑位于 `rewrap()` 方法（`scrollable_diff.rs:114-175`），执行以下步骤：

1. **宽度为零的特殊处理**：直接克隆原始行，不做换行
2. **逐行处理**：遍历每一行原始文本
   - 先将 tab 替换为 4 个空格（`scrollable_diff.rs:125`）
   - 空行直接推入输出
3. **逐字符累加宽度**：使用 `UnicodeWidthChar::width()` 获取每个字符的显示宽度，正确处理 CJK 全角字符和零宽字符
4. **软断点追踪**：在空白字符和常见标点（`, ; . : ) ] } | / ? ! - _`）处记录潜在断行位置（`scrollable_diff.rs:156-163`）
5. **超宽处理**：当累加宽度超过 `max_cols` 时：
   - 如果存在软断点，在该位置分割，前半部分去除尾部空白，后半部分去除前导空白
   - 如果不存在软断点（如超长连续字符串），直接硬断行
6. **索引映射**：每推入一行 wrapped 输出时，同步记录其对应的原始行索引到 `wrapped_src_idx`，供调用方（如 DiffOverlay）回溯原始行信息

```rust
// scrollable_diff.rs:142-154 — 超宽时的断行逻辑
let w = UnicodeWidthChar::width(ch).unwrap_or(0);
if line_cols.saturating_add(w) > max_cols {
    if let Some(split) = last_soft_idx {
        let (prefix, rest) = line.split_at(split);
        out.push(prefix.trim_end().to_string());
        out_idx.push(raw_idx);
        line = rest.trim_start().to_string();
        last_soft_idx = None;
    } else if !line.is_empty() {
        out.push(std::mem::take(&mut line));
        out_idx.push(raw_idx);
    }
}
```

### 滚动操作

| 方法 | 行为 | 源码 |
|------|------|------|
| `scroll_by(delta)` | 按有符号增量滚动，自动 clamp 到 `[0, max_scroll]` | `scrollable_diff.rs:79-82` |
| `page_by(delta)` | 翻页滚动（委托给 `scroll_by`，调用方传入 `viewport_h - 1`） | `scrollable_diff.rs:85-87` |
| `to_top()` | 跳到顶部（`scroll = 0`） | `scrollable_diff.rs:89-91` |
| `to_bottom()` | 跳到底部（`scroll = max_scroll`） | `scrollable_diff.rs:93-95` |
| `percent_scrolled()` | 返回 `Option<u8>` 百分比。内容不足一屏或几何未知时返回 `None` | `scrollable_diff.rs:98-108` |

`percent_scrolled()` 的计算方式是 `(scroll + viewport_h) / content_h * 100`，即可见区域底边占内容总高的比例。

## 函数签名与参数说明

### 公开 API

```rust
pub fn new() -> Self
```
创建空实例，等同于 `Default::default()`。

```rust
pub fn set_content(&mut self, lines: Vec<String>)
```
替换原始内容行，清空缓存，强制下次 `set_width` 时重新换行。

```rust
pub fn set_width(&mut self, width: u16)
```
设置换行列宽。宽度不变时跳过换行计算（性能优化）。

```rust
pub fn set_viewport(&mut self, height: u16)
```
更新视口高度并 clamp 滚动位置。

```rust
pub fn wrapped_lines(&self) -> &[String]
```
返回缓存的换行后行切片，供渲染层直接使用。

```rust
pub fn wrapped_src_indices(&self) -> &[usize]
```
返回每个 wrapped 行对应的原始行索引，与 `wrapped_lines()` 等长。

```rust
pub fn raw_line_at(&self, idx: usize) -> &str
```
按索引获取原始行，越界时返回空字符串。

```rust
pub fn scroll_by(&mut self, delta: i16)
pub fn page_by(&mut self, delta: i16)
pub fn to_top(&mut self)
pub fn to_bottom(&mut self)
pub fn percent_scrolled(&self) -> Option<u8>
```

## 配置项与默认值

- **Tab 宽度**：硬编码为 4 个空格（`scrollable_diff.rs:125`），不可配置
- **软断点字符集**：硬编码为空白字符加 `, ; . : ) ] } | / ? ! - _`（`scrollable_diff.rs:158-160`）
- **所有数值类型使用 `u16`**：意味着最大支持 65535 行换行后的内容高度

## 边界 Case 与注意事项

- **宽度为零**：`rewrap` 对 `width == 0` 做了特殊处理，直接返回原始行不换行，避免除零或死循环
- **内容不足一屏**：`percent_scrolled()` 在 `content_h <= viewport_h` 时返回 `None`，调用方应据此决定是否显示滚动指示器
- **`page_by` 与 `scroll_by` 相同**：`page_by` 只是简单委托给 `scroll_by`，翻页步长由调用方决定（通常传 `viewport_h - 1`），控件本身不计算页大小
- **Unicode 全角字符**：换行算法通过 `unicode_width` crate 正确处理 CJK 等全角字符的显示宽度（占 2 列）
- **内嵌换行符**：原始行中如果包含 `\n`，`rewrap` 会在该位置断行，而非忽略
- **`wrapped_src_idx` 映射**：多个 wrapped 行可能映射到同一个原始行索引，调用方可据此判断哪些 wrapped 行来自同一源行