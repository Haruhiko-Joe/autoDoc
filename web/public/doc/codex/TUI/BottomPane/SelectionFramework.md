# SelectionFramework — 共享弹窗渲染基础设施与可复用选择控件

## 概述与职责

SelectionFramework 是 TUI BottomPane 模块中的**弹窗渲染基础层**，为底部面板中几乎所有的弹出式选择列表提供统一的渲染原语和交互控件。它由三个文件组成，形成从底层到高层的分层架构：

- **selection_popup_common**：最底层的渲染原语——菜单表面绘制、行测量/渲染、列宽计算、文本换行、`GenericDisplayRow` 数据模型
- **ListSelectionView**：基于 common 原语构建的全功能可滚动列表控件（键盘导航、搜索过滤、侧边内容面板、子标题、脚注）
- **MultiSelectPicker**：扩展了选择列表模式，支持多选 toggle 操作

在整体架构中，SelectionFramework 位于 **TUI → BottomPane** 层级。BottomPane 是聊天界面的交互式底栏，而 SelectionFramework 为其中的 model picker、theme picker、approval 选择、status-line 配置等弹窗提供统一的 UI 基础。同级模块包括 ChatComposer（输入框）、tool-call approval overlay、file-search popup 等。

---

## 关键流程

### 1. 菜单表面渲染流程（selection_popup_common）

所有选择类弹窗共享统一的"菜单表面"外观：

1. 调用 `render_menu_surface(area, buf)` 绘制背景块（使用 `user_message_style()`）
2. 返回经过 inset（垂直 1 行、水平 2 列）处理后的内容区域
3. 调用方在返回的内容区域内布局具体内容

> 源码位置：`selection_popup_common.rs:84-92`

### 2. 行渲染核心流程（selection_popup_common）

`render_rows_inner` 是所有行渲染的统一入口：

1. **空列表处理**：无数据时渲染斜体占位文本（如 "no matches"）
2. **滚动窗口计算**：通过 `adjust_start_for_wrapped_selection_visibility` 确定可见行起始位置，确保选中行始终在视口内（即使换行后行高超出预期）
3. **列宽计算**：调用 `compute_desc_col` 根据 `ColumnWidthMode` 策略计算描述列的起始位置
4. **逐行渲染**：遍历可见行，对每行调用 `wrap_row_lines` 生成换行后的多行内容，应用选中/禁用样式后逐行写入 Buffer

> 源码位置：`selection_popup_common.rs:502-581`

### 3. 单行构建流程（selection_popup_common）

`build_full_line` 将 `GenericDisplayRow` 组装为一个完整的 `Line`：

1. 合并 `description` 和 `disabled_reason` 为统一描述文本
2. 对 `name` 逐字符处理：根据 `match_indices` 对匹配字符加粗（用于模糊搜索高亮），超宽时截断并加省略号
3. 拼接前缀 spans、名称 spans、可选快捷键、描述（padding 到 `desc_col`）和分类标签

> 源码位置：`selection_popup_common.rs:415-496`

### 4. ListSelectionView 交互流程

1. **构造**：`ListSelectionView::new(params, tx)` 接收 `SelectionViewParams`，组合 header，立即执行 `apply_filter()` 初始化过滤索引
2. **搜索过滤**：用户输入字符时触发 `apply_filter()`，对 `items` 的 `search_value` 进行大小写不敏感的子串匹配，更新 `filtered_indices` 并尝试保持选中项
3. **键盘导航**：Up/Down/Ctrl+P/Ctrl+N/j/k 上下移动，自动跳过 disabled 行；数字键（1-9）直接跳转并选中
4. **确认**：Enter 触发 `accept()`，执行选中 item 的 `actions` 回调；如果 `dismiss_on_select` 为 true 则关闭弹窗
5. **渲染**：实现 `Renderable` trait，在 `render()` 中依次绘制 header、search bar、list rows、side content（侧边或堆叠）、footer

### 5. MultiSelectPicker 交互流程

1. **构造**：通过 builder 模式 `MultiSelectPicker::builder(title, subtitle, tx).items(...).build()`
2. **模糊搜索**：输入字符触发 `apply_filter()`，使用 `fuzzy_match` 进行模糊匹配并按得分排序
3. **Toggle**：Space 键调用 `toggle_selected()` 翻转当前项的 `enabled` 状态
4. **排序**：当 `ordering_enabled` 且搜索为空时，Left/Right 键调用 `move_selected_item()` 交换相邻元素位置
5. **确认**：Enter 触发 `confirm_selection()`，收集所有 `enabled` 项的 ID 传递给回调

---

## 核心类型定义

### `GenericDisplayRow`（selection_popup_common）

所有弹窗行的通用渲染模型，与具体业务解耦：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 行的主要文本 |
| `name_prefix_spans` | `Vec<Span<'static>>` | 名称前的富文本前缀（如序号 `› 1. `） |
| `display_shortcut` | `Option<KeyBinding>` | 可选的快捷键标签 |
| `match_indices` | `Option<Vec<usize>>` | 模糊搜索匹配的字符位置（用于加粗高亮） |
| `description` | `Option<String>` | 右侧灰色描述文本 |
| `category_tag` | `Option<String>` | 右侧分类标签 |
| `disabled_reason` | `Option<String>` | 禁用原因 |
| `is_disabled` | `bool` | 是否禁用 |
| `wrap_indent` | `Option<usize>` | 换行后的缩进列数 |

> 源码位置：`selection_popup_common.rs:30-40`

### `ColumnWidthMode`（selection_popup_common）

控制描述列位置的三种策略：

| 变体 | 行为 |
|------|------|
| `AutoVisible`（默认） | 仅根据当前视口内可见行计算列宽 |
| `AutoAllRows` | 根据所有行计算，滚动时列宽不变 |
| `Fixed` | 固定 30% 名称 / 70% 描述的比例分割 |

> 源码位置：`selection_popup_common.rs:46-56`

### `SelectionItem`（list_selection_view）

`ListSelectionView` 的行数据模型：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 显示名称 |
| `name_prefix_spans` | `Vec<Span<'static>>` | 名称前的富文本前缀 |
| `display_shortcut` | `Option<KeyBinding>` | 可选快捷键 |
| `description` | `Option<String>` | 默认描述 |
| `selected_description` | `Option<String>` | 选中时替换的描述 |
| `is_current` | `bool` | 是否标记为 "(current)" |
| `is_default` | `bool` | 是否标记为 "(default)" |
| `is_disabled` | `bool` | 是否禁用（导航时跳过） |
| `actions` | `Vec<SelectionAction>` | Enter 确认时执行的回调列表 |
| `dismiss_on_select` | `bool` | 选中后是否关闭弹窗 |
| `search_value` | `Option<String>` | 搜索过滤使用的文本（与 `name` 可不同） |
| `disabled_reason` | `Option<String>` | 禁用原因文本 |

> 源码位置：`list_selection_view.rs:113-126`

### `SelectionViewParams`（list_selection_view）

`ListSelectionView` 的一次性构造配置：

关键字段包括 `title`、`subtitle`、`footer_note`（可换行脚注）、`footer_hint`（底部快捷键提示）、`is_searchable`、`search_placeholder`、`col_width_mode`、`side_content`（侧边面板内容）、`side_content_width`（`Fixed(n)` 或 `Half`）、`on_selection_changed`、`on_cancel`。

> 源码位置：`list_selection_view.rs:138-176`

### `SideContentWidth`（list_selection_view）

控制侧边面板宽度：

| 变体 | 行为 |
|------|------|
| `Fixed(0)`（默认） | 禁用侧边面板 |
| `Fixed(n)` | 固定 n 列宽度 |
| `Half` | 内容区域 50/50 分割（减去 2 列间隔） |

当侧边面板宽度不足 `side_content_min_width` 或剩余列表宽度不足 40 列时，自动回退为堆叠布局。

> 源码位置：`list_selection_view.rs:53-65`

### `MultiSelectItem`（multi_select_picker）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `String` | 唯一标识符，确认时返回 |
| `name` | `String` | 显示名称（超长时截断至 21 字符） |
| `description` | `Option<String>` | 可选灰色描述 |
| `enabled` | `bool` | 当前是否选中 |

> 源码位置：`multi_select_picker.rs:92-105`

---

## 函数签名与公开 API

### selection_popup_common 导出函数

```rust
pub(crate) fn render_menu_surface(area: Rect, buf: &mut Buffer) -> Rect
```
绘制菜单背景，返回 inset 后的内容区域。

```rust
pub(crate) fn menu_surface_inset(area: Rect) -> Rect
```
仅计算 inset 区域，不绘制。

```rust
pub(crate) const fn menu_surface_padding_height() -> u16
```
返回菜单表面的总垂直 padding（`MENU_SURFACE_INSET_V * 2 = 2`）。

```rust
pub(crate) fn render_rows(area, buf, rows_all, state, max_results, empty_message) -> u16
pub(crate) fn render_rows_stable_col_widths(...) -> u16
pub(crate) fn render_rows_with_col_width_mode(..., col_width_mode) -> u16
pub(crate) fn render_rows_single_line(...) -> u16
```
四种行渲染入口，分别对应不同的列宽策略和换行行为。返回实际渲染的终端行数。

```rust
pub(crate) fn measure_rows_height(rows_all, state, max_results, width) -> u16
pub(crate) fn measure_rows_height_stable_col_widths(...) -> u16
pub(crate) fn measure_rows_height_with_col_width_mode(..., col_width_mode) -> u16
```
对应渲染函数的测量版本，用于预分配垂直空间。**必须与对应的 render 函数配对使用**，否则可能导致裁剪。

```rust
pub(crate) fn wrap_styled_line<'a>(line: &'a Line<'a>, width: u16) -> Vec<Line<'a>>
```
对富文本行进行保留样式的换行，`width` 最小 clamp 到 1。

> 源码位置：`selection_popup_common.rs:98-107`

### ListSelectionView

```rust
pub fn new(params: SelectionViewParams, app_event_tx: AppEventSender) -> Self
```
构造函数，消费 `SelectionViewParams`，立即初始化过滤索引。

实现 `BottomPaneView` trait（`handle_key_event`、`is_complete`、`on_ctrl_c`）和 `Renderable` trait（`desired_height`、`render`）。

### MultiSelectPicker

```rust
pub fn builder(title, subtitle, app_event_tx) -> MultiSelectPickerBuilder
```
返回 builder，通过链式调用 `.items()`, `.enable_ordering()`, `.on_preview()`, `.on_confirm()`, `.on_cancel()`, `.build()` 完成构造。

```rust
pub fn close(&mut self)
```
关闭 picker 并触发 `on_cancel` 回调。

### 回调类型

| 类型 | 签名 | 用途 |
|------|------|------|
| `SelectionAction` | `Box<dyn Fn(&AppEventSender)>` | ListSelectionView 行的确认动作 |
| `OnSelectionChangedCallback` | `Option<Box<dyn Fn(usize, &AppEventSender)>>` | 高亮项变化时（用于 theme 实时预览） |
| `OnCancelCallback` | `Option<Box<dyn Fn(&AppEventSender)>>` | Esc 取消时（用于 theme 恢复） |
| `ChangeCallBack` | `Box<dyn Fn(&[MultiSelectItem], &AppEventSender)>` | MultiSelect 项状态变化时 |
| `ConfirmCallback` | `Box<dyn Fn(&[String], &AppEventSender)>` | MultiSelect 确认时，传入已启用项 ID |
| `PreviewCallback` | `Box<dyn Fn(&[MultiSelectItem]) -> Option<Line<'static>>>` | MultiSelect 预览行生成 |

---

## 键盘交互映射

### ListSelectionView

| 按键 | 动作 |
|------|------|
| Up / Ctrl+P / k（非搜索模式） | 上移，跳过 disabled 行 |
| Down / Ctrl+N / j（非搜索模式） | 下移，跳过 disabled 行 |
| 1-9（非搜索模式） | 直接选中对应序号项 |
| Enter | 确认选择，执行 actions |
| Esc / Ctrl+C | 取消并关闭 |
| 字符键（搜索模式） | 追加到搜索查询 |
| Backspace（搜索模式） | 删除搜索查询末字符 |

### MultiSelectPicker

| 按键 | 动作 |
|------|------|
| Up / Ctrl+P/K | 上移（wrap） |
| Down / Ctrl+N/J | 下移（wrap） |
| Space | Toggle 当前项 |
| Left（ordering 开启时） | 上移当前项位置 |
| Right（ordering 开启时） | 下移当前项位置 |
| Enter | 确认 |
| Esc / Ctrl+C | 取消 |
| 字符键 | 模糊搜索 |

---

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|---|------|
| `MENU_SURFACE_INSET_V` | 1 | 菜单表面垂直内边距 |
| `MENU_SURFACE_INSET_H` | 2 | 菜单表面水平内边距 |
| `FIXED_LEFT_COLUMN_NUMERATOR/DENOMINATOR` | 3/10 | Fixed 模式下名称列占比（30%） |
| `MIN_LIST_WIDTH_FOR_SIDE` | 40 | 侧边面板模式的最小列表宽度 |
| `SIDE_CONTENT_GAP` | 2 | 列表与侧边面板的间距（列） |
| `MENU_SURFACE_HORIZONTAL_INSET` | 4 | 水平总 inset（左右各 2） |
| `MAX_POPUP_ROWS` | 来自 `popup_consts` | 弹窗最大可见行数 |
| `ITEM_NAME_TRUNCATE_LEN` | 21 | MultiSelectPicker 名称截断长度 |

---

## 边界 Case 与注意事项

- **测量与渲染必须配对**：`measure_rows_height` 对应 `render_rows`，`measure_rows_height_stable_col_widths` 对应 `render_rows_stable_col_widths`。混用会导致高度预分配不准确，出现内容裁剪。

- **wrap 宽度最小为 1**：`wrap_styled_line` 和行渲染函数都将宽度 clamp 到最小 1，防止极窄布局下 panic。

- **AutoVisible 模式下滚动会导致列宽跳变**：因为只根据可见行计算列宽。如果滚到一行名称特别长的项，描述列位置会整体右移。需要稳定列宽时应使用 `AutoAllRows`。

- **搜索模式下 j/k 键不作为导航**：`ListSelectionView` 在 `is_searchable` 时禁用 j/k 导航，让字符输入用于搜索；数字键同理不再跳转。

- **MultiSelectPicker 排序仅在空搜索时生效**：`move_selected_item` 在 `search_query` 非空时直接 return，防止过滤后的索引与底层列表不一致。

- **disabled 行跳过逻辑**：`ListSelectionView` 的 `skip_disabled_down/up` 会循环最多 `len` 次避免死循环（所有行都 disabled 的极端情况）。

- **侧边面板自适应布局**：当终端宽度不足以容纳 side-by-side 布局时，自动回退为堆叠模式。可通过 `stacked_side_content` 提供专门的窄屏版本。

- **`build_full_line` 的名称截断**：当存在描述时，名称最多占用 `desc_col - 2 - prefix_width` 个字符宽度，超出部分以 `…` 截断。