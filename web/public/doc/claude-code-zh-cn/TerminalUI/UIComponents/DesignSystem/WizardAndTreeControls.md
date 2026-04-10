# 向导框架与树形控件

## 概述与职责

本模块属于 TerminalUI → UIComponents → DesignSystem 层级，提供两类可复用的 UI 构件：

1. **wizard/**：多步骤向导框架，用于引导用户完成分步操作流程（如创建 Agent 向导）。通过 React Context 管理步骤状态和导航，提供对话框布局壳和导航按钮。
2. **ui/**：树形选择控件（TreeSelect）和有序列表组件（OrderedList/OrderedListItem），为需要层级展示或编号列表的场景提供基础 UI 原语。

同级兄弟模块包括 Dialog、Pane、ThemeProvider 等设计系统组件，本模块的向导框架被 AgentAndMCPUI 中的 CreateAgentWizard 等业务组件直接消费。

## 关键流程

### 向导生命周期

1. **初始化**：消费者将步骤组件数组 `steps` 和回调传入 `WizardProvider`。Provider 初始化 `currentStepIndex=0`、`wizardData=initialData`、空的 `navigationHistory` 栈（`src/components/wizard/WizardProvider.tsx:30-40`）
2. **渲染当前步骤**：Provider 从 `steps[currentStepIndex]` 取出当前步骤组件 `CurrentStepComponent`，作为子树渲染。若传入了 `children` 则优先使用 children（`WizardProvider.tsx:180-186`）
3. **前进（goNext）**：若当前不是最后一步，将当前索引压入 `navigationHistory` 栈，然后 `currentStepIndex + 1`；若已是最后一步，设置 `isCompleted=true`（`WizardProvider.tsx:63-73`）
4. **完成**：`isCompleted` 变为 true 后，useEffect 触发 `onComplete(wizardData)` 回调，清空导航历史（`WizardProvider.tsx:44-61`）
5. **后退（goBack）**：若 `navigationHistory` 非空，弹出栈顶索引并跳转；否则若 `currentStepIndex > 0`，索引减一；再否则调用 `onCancel()`（`WizardProvider.tsx:83-100`）
6. **跳转（goToStep）**：直接跳到指定索引，同时将当前索引压入历史栈，支持非线性导航（`WizardProvider.tsx:110-116`）

### TreeSelect 树形选择流程

1. **树形→扁平化**：递归遍历 `nodes`，将树结构展平为 `FlattenedNode[]`，只展开 `isExpanded` 为 true 的节点的子节点（`TreeSelect.tsx:158-184`）
2. **构建选项**：为每个扁平节点生成 label（带缩进前缀），父节点用 `▼`/`▶` 标记展开/折叠状态，子节点用 `▸` 缩进前缀（`TreeSelect.tsx:186-209`）
3. **键盘交互**：监听 `onKeyDown` 事件——`→` 键展开有子节点的节点，`←` 键折叠当前节点或跳转到父节点（`TreeSelect.tsx:278-310`）
4. **选择与聚焦**：选中时通过 `nodeMap` 查找原始 `TreeNode` 对象并调用 `onSelect` 回调；聚焦变化时调用 `onFocus`（`TreeSelect.tsx:323-362`）
5. **渲染**：最终通过 `<Select>` 组件渲染扁平化的选项列表（`TreeSelect.tsx:364-365`）

## 函数签名与参数说明

### `WizardProvider<T>`

向导状态的顶层 Provider 组件。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| steps | `WizardStepComponent[]` | — | 步骤组件数组，按顺序渲染 |
| initialData | `T` | `{}` | 向导数据的初始值 |
| onComplete | `(data: T) => void` | — | 所有步骤完成后的回调 |
| onCancel | `() => void` | — | 在第一步后退时触发 |
| children | `ReactNode` | — | 可选，覆盖默认的步骤组件渲染 |
| title | `string` | — | 向导标题，显示在对话框顶部 |
| showStepCounter | `boolean` | `true` | 是否在标题后显示 `(1/N)` 步骤计数 |

> 源码位置：`src/components/wizard/WizardProvider.tsx:9-202`

### `useWizard<T>(): WizardContextValue<T>`

获取向导上下文的 Hook，必须在 `WizardProvider` 内使用。

返回值包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| currentStepIndex | `number` | 当前步骤索引 |
| totalSteps | `number` | 步骤总数 |
| wizardData | `T` | 当前向导累积数据 |
| setWizardData | `(data: T) => void` | 完整替换向导数据 |
| updateWizardData | `(updates: Partial<T>) => void` | 部分更新向导数据（浅合并） |
| goNext | `() => void` | 前进到下一步 |
| goBack | `() => void` | 返回上一步或取消 |
| goToStep | `(index: number) => void` | 跳转到指定步骤 |
| cancel | `() => void` | 取消整个向导流程 |
| title | `string` | 向导标题 |
| showStepCounter | `boolean` | 步骤计数显示标记 |

> 源码位置：`src/components/wizard/useWizard.ts:1-13`

### `WizardDialogLayout`

基于设计系统 `Dialog` 组件的向导布局壳，自动从 `useWizard()` 读取步骤信息并在标题中显示进度。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| title | `string` | Provider 中的 title | 覆盖向导标题 |
| color | `keyof Theme` | `"suggestion"` | 对话框主题色 |
| children | `ReactNode` | — | 步骤内容 |
| subtitle | `string` | — | 副标题 |
| footerText | `ReactNode` | — | 自定义底部导航提示文本 |

> 源码位置：`src/components/wizard/WizardDialogLayout.tsx:1-64`

### `WizardNavigationFooter`

渲染向导底部的导航快捷键提示。默认显示 `↑↓ navigate`、`Enter select`、`Esc go back`。支持 Ctrl+C/D 退出确认。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| instructions | `ReactNode` | 默认快捷键提示 | 自定义底部提示内容 |

> 源码位置：`src/components/wizard/WizardNavigationFooter.tsx:1-23`

### `TreeSelect<T>`

树形节点选择器，将层级结构展平后通过 `Select` 组件渲染，支持展开/折叠和键盘导航。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| nodes | `TreeNode<T>[]` | — | 树形节点数据 |
| onSelect | `(node: TreeNode<T>) => void` | — | 节点选中回调 |
| onCancel | `() => void` | — | 取消回调 |
| onFocus | `(node: TreeNode<T>) => void` | — | 聚焦变化回调 |
| focusNodeId | `string \| number` | — | 外部控制聚焦的节点 ID |
| visibleOptionCount | `number` | — | 可见选项数量 |
| layout | `'compact' \| 'expanded' \| 'compact-vertical'` | `"expanded"` | 选项布局模式 |
| isDisabled | `boolean` | `false` | 禁用用户交互 |
| hideIndexes | `boolean` | `false` | 隐藏数字序号 |
| isNodeExpanded | `(nodeId) => boolean` | — | 外部控制展开状态 |
| onExpand | `(nodeId) => void` | — | 节点展开回调 |
| onCollapse | `(nodeId) => void` | — | 节点折叠回调 |
| getParentPrefix | `(isExpanded: boolean) => string` | `▼`/`▶` | 自定义父节点前缀 |
| getChildPrefix | `(depth: number) => string` | `"  ▸ "` | 自定义子节点前缀 |
| onUpFromFirstItem | `() => void` | — | 在第一项按上键时的回调（阻止环绕） |

> 源码位置：`src/components/ui/TreeSelect.tsx:1-397`

### `OrderedList` / `OrderedListItem`

支持嵌套的有序列表组件。`OrderedList` 自动计算子项序号并通过 Context 传递 marker 字符串（如 `"1."`、`" 1. 2."`），`OrderedListItem` 渲染序号前缀和内容。

使用方式：`OrderedList.Item` 是 `OrderedListItem` 的便捷引用。

> 源码位置：`src/components/ui/OrderedList.tsx:1-70`，`src/components/ui/OrderedListItem.tsx:1-44`

## 接口/类型定义

### `TreeNode<T>`

```typescript
type TreeNode<T> = {
  id: string | number       // 唯一标识
  value: T                  // 节点携带的值
  label: string             // 显示标签
  description?: string      // 可选描述文本
  dimDescription?: boolean  // 描述是否淡化显示
  children?: TreeNode<T>[]  // 子节点
  metadata?: Record<string, unknown>  // 扩展元数据
}
```

> 源码位置：`src/components/ui/TreeSelect.tsx:6-14`

### `FlattenedNode<T>`（内部类型）

```typescript
type FlattenedNode<T> = {
  node: TreeNode<T>
  depth: number              // 缩进深度
  isExpanded: boolean        // 是否展开
  hasChildren: boolean       // 是否有子节点
  parentId?: string | number // 父节点 ID
}
```

> 源码位置：`src/components/ui/TreeSelect.tsx:15-21`

## 边界 Case 与注意事项

- **useWizard 必须在 Provider 内调用**：否则会抛出 `"useWizard must be used within a WizardProvider"` 错误（`useWizard.ts:10`）
- **导航历史栈机制**：`goBack` 优先从 `navigationHistory` 栈中弹出上一个步骤，支持非线性跳转后的正确回退。若历史栈为空则按索引线性后退
- **展开状态双模式**：TreeSelect 支持受控（通过 `isNodeExpanded`/`onExpand`/`onCollapse`）和非受控（内部 `Set` 管理）两种展开状态模式。提供了 `isNodeExpanded` 时优先使用外部控制
- **键盘导航边界**：`←` 键在已折叠的子节点上会跳转到父节点并折叠父节点；`→` 键只对有子节点的节点生效
- **编程式聚焦去重**：`isProgrammaticFocusRef` 防止在程序触发焦点变化时重复调用 `onFocus` 回调（`TreeSelect.tsx:140-141, 298, 341-343`）
- **OrderedList 嵌套**：通过 `OrderedListContext` 传递 `parentMarker`，支持嵌套列表时自动拼接多级序号（如 `" 1. 2."`）
- **React Compiler 优化**：所有组件都使用了 React Compiler 的 `_c()` 缓存机制进行细粒度的 memoization，这是编译产物而非手写代码
- **Ctrl+C/D 退出**：`WizardProvider` 和 `WizardNavigationFooter` 都集成了 `useExitOnCtrlCDWithKeybindings`，在向导流程中支持通过快捷键退出，且有二次确认机制