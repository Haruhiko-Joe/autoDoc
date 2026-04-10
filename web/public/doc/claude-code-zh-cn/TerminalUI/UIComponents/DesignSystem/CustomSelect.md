# CustomSelect 自定义选择控件系统

## 概述与职责

CustomSelect 是 Claude Code 终端 UI 的核心表单交互控件，提供功能完整的单选（`Select`）和多选（`SelectMulti`）组件。它位于 **TerminalUI → UIComponents → DesignSystem** 层级中，是设计系统的一部分，被权限确认对话框、设置面板、模型选择器、Agent 创建向导等众多上层组件广泛使用。

同级兄弟模块包括 ThemeProvider 主题系统、Dialog 对话框、ProgressBar 进度条、FuzzyPicker 模糊匹配等设计系统基础组件。

整个模块由 10 个文件组成，采用**关注点分离**的架构：组件层负责渲染，Hook 层负责状态管理和键盘交互，数据层负责选项索引。

## 文件结构与职责划分

| 文件 | 职责 |
|------|------|
| `select.tsx` | 主选择器组件 `Select`，单选模式 |
| `SelectMulti.tsx` | 多选组件 `SelectMulti` |
| `select-option.tsx` | 纯文本选项渲染组件 |
| `select-input-option.tsx` | 可输入选项渲染组件（内嵌 TextInput） |
| `use-select-navigation.ts` | 键盘导航与视口滚动逻辑（核心 Hook） |
| `use-select-state.ts` | 单选状态管理 Hook |
| `use-multi-select-state.ts` | 多选状态管理 Hook |
| `use-select-input.ts` | 键盘输入处理 Hook |
| `option-map.ts` | 双向链表选项索引数据结构 |
| `index.ts` | 模块导出入口 |

## 关键流程

### 单选流程（Select）

1. `Select` 组件接收 `options` 数组和回调函数，调用 `useSelectState` 初始化状态
2. `useSelectState` 内部调用 `useSelectNavigation` 创建导航状态（焦点位置、可视窗口范围）
3. `Select` 再调用 `useSelectInput` 绑定键盘事件处理
4. 用户按 ↑/↓ 或 j/k 导航时，`useSelectInput` 通过 keybindings 系统触发 `focusNextOption`/`focusPreviousOption`
5. `useSelectNavigation` 内部的 `reducer` 处理 action，更新焦点值和可视窗口的滚动位置
6. 用户按 Enter 确认时，调用 `state.onChange` 将选中值回传给父组件
7. 按 Escape 取消时，调用 `state.onCancel`

### 多选流程（SelectMulti）

1. `SelectMulti` 调用 `useMultiSelectState` 管理选中值数组 `selectedValues`
2. `useMultiSelectState` 自行处理全部键盘输入（不使用 `useSelectInput`），通过 `useInput` 监听按键
3. Space 或 Enter 切换当前焦点选项的选中/取消状态
4. 支持可选的 Submit 按钮——当提供 `submitButtonText` 时，Tab 可导航到底部提交按钮，Enter 在按钮上触发 `onSubmit`
5. 数字键 1-9 可直接按索引切换选项（可通过 `hideIndexes` 禁用）

### 键盘导航与视口滚动机制

这是整个控件最核心的逻辑，实现在 `use-select-navigation.ts` 中：

- 使用 `useReducer` 管理状态，支持 6 种 action：`focus-next-option`、`focus-previous-option`、`focus-next-page`、`focus-previous-page`、`set-focus`、`reset`
- `OptionMap`（`option-map.ts`）是一个扩展自 `Map` 的**双向链表**，每个节点持有 `previous`/`next` 指针、`index` 和 `value`，支持 O(1) 的相邻节点查找（`option-map.ts:4-50`）
- **循环导航**：在最后一项按 ↓ 跳到第一项，在第一项按 ↑ 跳到最后一项，同时重置视口位置（`use-select-navigation.ts:88-101`、`139-159`）
- **视口窗口**：通过 `visibleFromIndex` 和 `visibleToIndex` 维护一个固定大小的滑动窗口，焦点移出窗口时自动滚动一行（`use-select-navigation.ts:104-125`）
- **翻页**：PageUp/PageDown 一次移动 `visibleOptionCount` 个选项，整页滚动（`use-select-navigation.ts:182-272`）
- **选项变更时的智能重置**：当 `options` 变化时（如搜索过滤），通过 `isDeepStrictEqual` 检测变化，尽量保持当前焦点和视口位置（`use-select-navigation.ts:528-543`）

### 输入型选项（Input Option）

选项不仅可以是纯文本，还可以是**内嵌输入框**的 `type: 'input'` 类型：

1. 当焦点移到 input 类型选项时，`SelectInputOption` 渲染一个 `TextInput` 组件
2. 在输入模式下，j/k/Enter 等快捷键被拦截传递给 TextInput，只有方向键仍可导航选项列表（`use-select-input.ts:187-231`）
3. 支持 Tab 键切换输入模式（通过 `onInputModeToggle` 回调）
4. 支持通过 `onOpenEditor`（Ctrl+G）打开外部编辑器编辑输入值
5. 支持图片粘贴（`onImagePaste`），粘贴后显示图片附件，可通过方向键导航和删除附件

## 核心类型定义

### `OptionWithDescription<T>`

选项的联合类型，分为文本选项和输入选项两种：

```typescript
// 文本选项
type BaseOption<T> = {
  label: ReactNode        // 选项显示文本，支持 ReactNode
  value: T                // 选项值（泛型）
  description?: string    // 选项描述
  dimDescription?: boolean // 是否淡化描述文字
  disabled?: boolean      // 是否禁用
}

// 输入选项（type: 'input'）额外字段
{
  type: 'input'
  onChange: (value: string) => void  // 输入变化回调（必填）
  placeholder?: string               // 占位符
  initialValue?: string              // 初始值
  allowEmptySubmitToCancel?: boolean  // 空值提交行为控制
  showLabelWithValue?: boolean        // 是否始终显示 label
  labelValueSeparator?: string        // label 和 value 间的分隔符
  resetCursorOnUpdate?: boolean       // 异步更新时自动重置光标
}
```

> 源码位置：`src/components/CustomSelect/select.tsx:28-69`

### `SelectProps<T>`

`Select` 组件的完整 Props：

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `options` | `OptionWithDescription<T>[]` | 必填 | 选项列表 |
| `onChange` | `(value: T) => void` | - | 选中回调 |
| `onCancel` | `() => void` | - | 取消回调（提供时注册 overlay 防止 Escape 被拦截） |
| `visibleOptionCount` | `number` | 5 | 可见选项数（超出时滚动） |
| `defaultValue` | `T` | - | 初始选中值 |
| `defaultFocusValue` | `T` | - | 初始焦点值 |
| `layout` | `'compact' \| 'expanded' \| 'compact-vertical'` | `'compact'` | 布局模式 |
| `hideIndexes` | `boolean` | `false` | 隐藏数字索引 |
| `highlightText` | `string` | - | 高亮匹配文本 |
| `disableSelection` | `boolean \| 'numeric'` | `false` | 禁止选择（`'numeric'` 仅禁止数字键选择） |
| `inlineDescriptions` | `boolean` | `false` | 描述文本内联显示 |
| `onUpFromFirstItem` | `() => void` | - | 在首项按 ↑ 的回调（提供时不循环） |
| `onDownFromLastItem` | `() => void` | - | 在末项按 ↓ 的回调（提供时不循环） |
| `onOpenEditor` | `(currentValue, setValue) => void` | - | Ctrl+G 打开外部编辑器 |
| `onImagePaste` | `(base64, mediaType?, ...) => void` | - | 图片粘贴回调 |

> 源码位置：`src/components/CustomSelect/select.tsx:70-191`

### `SelectMultiProps<T>`

`SelectMulti` 在 `Select` 基础上增加的关键差异：

| 属性 | 类型 | 说明 |
|------|------|------|
| `defaultValue` | `T[]` | 初始选中值数组（而非单值） |
| `onChange` | `(values: T[]) => void` | 回调参数为值数组 |
| `onCancel` | `() => void` | 必填（Select 中可选） |
| `submitButtonText` | `string` | 提供时显示提交按钮 |
| `onSubmit` | `(values: T[]) => void` | 提交回调 |
| `initialFocusLast` | `boolean` | 初始焦点放在最后一项 |
| `hideIndexes` | `boolean` | 隐藏数字索引（同时禁用数字键快捷选择） |

> 源码位置：`src/components/CustomSelect/SelectMulti.tsx:11-57`

## 三种布局模式

`Select` 支持三种 `layout`：

1. **`compact`**（默认）：每个选项一行，索引号 + label 水平排列，描述以对齐列展示。对于文本和输入选项，计算所有 label 的最大宽度进行列对齐
2. **`expanded`**：每个选项占多行，label 单独一行，description 缩进显示在下方，选项间有空行分隔
3. **`compact-vertical`**：索引号格式与 compact 一致，但 description 显示在 label 下方（而非同行右侧列）

## 键盘交互一览

### 单选模式（Select）

| 按键 | 行为 |
|------|------|
| ↑ / k / Ctrl+P | 上移焦点（通过 keybindings `select:previous`） |
| ↓ / j / Ctrl+N | 下移焦点（通过 keybindings `select:next`） |
| Enter | 确认选择（通过 keybindings `select:accept`） |
| Escape | 取消（通过 keybindings `select:cancel`） |
| PageUp / PageDown | 翻页 |
| 1-9 | 直接按索引选择对应选项 |
| Tab | 切换输入模式（仅 input 类型选项） |

### 多选模式（SelectMulti）

| 按键 | 行为 |
|------|------|
| ↑/↓ / j/k / Ctrl+P/N | 导航 |
| Space / Enter | 切换选中状态 |
| Tab | 移到下一项或提交按钮 |
| Shift+Tab | 移到上一项 |
| 1-9 | 按索引切换选项选中状态 |
| Escape | 取消 |
| Ctrl+Enter | 从输入框直接提交（有 onSubmit 时） |

## 边界 Case 与注意事项

- **Overlay 注册**：当提供 `onCancel` 时，组件通过 `useRegisterOverlay` 注册为活跃覆盖层，防止 `CancelRequestHandler` 拦截 Escape 键（`use-select-input.ts:101`、`use-multi-select-state.ts:215`）
- **全角字符归一化**：数字键和空格都会经过 `normalizeFullWidthDigits`/`normalizeFullWidthSpace` 处理，兼容日文等 IME 输入（`use-select-input.ts:175`）
- **选项动态变更**：当 `options` 引用或内容变化时，navigation 会 `reset` 状态，但尽量保持当前焦点值和视口位置（`use-select-navigation.ts:528-543`）。多选模式下选中值也会重置为 `defaultValue`（`use-multi-select-state.ts:176-180`）
- **焦点值验证**：`useSelectNavigation` 在每次渲染时验证 `focusedValue` 是否仍存在于当前 options 中，不存在则回退到第一项，避免 options 异步更新时光标消失（`use-select-navigation.ts:592-602`）
- **禁用选项**：`disabled: true` 的选项可被焦点选中但无法被选择确认（`use-select-input.ts:143`）
- **输入模式下的按键隔离**：当焦点在 input 类型选项上时，`select:next`/`select:previous`/`select:accept` keybindings 被移除，j/k/Enter 等字符直接传入 TextInput，只有方向键仍可导航（`use-select-input.ts:115-148`、`187-231`）
- **图片附件管理**：input 选项支持图片粘贴后的导航（左右方向键切换图片、Backspace 删除），通过 `imagesSelected` 状态和 Attachments keybindings 上下文实现（`select-input-option.tsx:286-312`）
- **React Compiler 优化**：所有组件和 Hook 均经过 React Compiler 编译，使用 `_c()` 缓存机制实现细粒度 memoization，避免不必要的重渲染

## 关键代码片段

### OptionMap 双向链表构建

```typescript
// option-map.ts:13-50
export default class OptionMap<T> extends Map<T, OptionMapItem<T>> {
  readonly first: OptionMapItem<T> | undefined
  readonly last: OptionMapItem<T> | undefined

  constructor(options: OptionWithDescription<T>[]) {
    const items: Array<[T, OptionMapItem<T>]> = []
    let previous: OptionMapItem<T> | undefined
    for (const option of options) {
      const item = { label: option.label, value: option.value,
        description: option.description, previous, next: undefined, index }
      if (previous) { previous.next = item }
      items.push([option.value, item])
      previous = item
    }
    super(items)
  }
}
```

### reducer 核心导航逻辑（循环滚动）

焦点到达列表尾部时循环到头部，并重置视口：

```typescript
// use-select-navigation.ts:88-101
const next = item.next || state.optionMap.first  // 无 next 则取第一个
if (!item.next && next === state.optionMap.first) {
  return {
    ...state,
    focusedValue: next.value,
    visibleFromIndex: 0,
    visibleToIndex: state.visibleOptionCount,
  }
}
```

### 输入模式下的按键分流

```typescript
// use-select-input.ts:112-148
const keybindingHandlers = useMemo(() => {
  const handlers: Record<string, () => void> = {}
  if (!isInInput) {
    // 非输入模式：注册 select:next/previous/accept
    handlers['select:next'] = () => { ... }
    handlers['select:previous'] = () => { ... }
    handlers['select:accept'] = () => { ... }
  }
  // onCancel 始终注册
  if (state.onCancel) {
    handlers['select:cancel'] = () => { state.onCancel!() }
  }
  return handlers
}, [...])
```