# ReconcilerDOM — React Reconciler 适配层与虚拟 DOM 实现

## 概述与职责

ReconcilerDOM 是 Ink 终端渲染框架的核心底层模块，负责将 React 组件树的操作映射为终端虚拟 DOM 的变更。它在整体架构中位于 **TerminalUI → InkFramework** 层级下，是整个终端 UI 的运行时基础——上层所有 UI 组件（Box、Text、ScrollBox 等 18 个原语及 144 个业务组件）最终都通过本模块完成节点创建、属性更新、布局计算和焦点管理。

同级模块包括输出优化器、边框/文本渲染管线、事件系统、基础 UI 原语组件、以及终端 IO 层。本模块专注于 React reconciler 与 DOM 抽象这一最底层的桥接工作。

模块由四个文件组成：

| 文件 | 职责 |
|------|------|
| `reconciler.ts` | 实现 `react-reconciler` HostConfig 接口，将 React 操作映射为 DOM 变更 |
| `dom.ts` | 定义 `DOMElement`/`TextNode` 类型和树操作（创建、插入、删除、脏标记） |
| `styles.ts` | 定义完整的样式类型系统并转换为 Yoga 布局属性 |
| `focus.ts` | 实现焦点管理器（Tab 导航、焦点栈、自动聚焦） |

## 关键流程

### 1. React 组件渲染到 DOM 节点的完整路径

当 React 组件树发生更新时，`react-reconciler` 调用 HostConfig 中定义的方法，将虚拟操作转换为对 DOM 树的实际变更：

1. **创建节点**：`createInstance()` 被调用，根据元素类型（`ink-box`、`ink-text` 等）调用 `dom.ts` 的 `createNode()` 创建 `DOMElement`，同时为需要布局的节点创建关联的 Yoga `LayoutNode`（`src/ink/dom.ts:110-132`）
2. **应用属性**：通过 `applyProp()` 分发处理 `style`、`textStyles`、事件处理器和普通属性（`src/ink/reconciler.ts:121-143`）
3. **构建树结构**：通过 `appendChildNode()` / `insertBeforeNode()` 将子节点插入父节点，同时维护 Yoga 布局树的同步（`src/ink/dom.ts:134-202`）
4. **提交更新**：`commitUpdate()` 使用 `diff()` 对比新旧 props，只应用变更部分（`src/ink/reconciler.ts:426-459`）
5. **触发渲染**：`resetAfterCommit()` 在所有变更提交后调用 `rootNode.onComputeLayout()` 执行 Yoga 布局计算，然后调用 `rootNode.onRender()` 触发终端输出（`src/ink/reconciler.ts:247-314`）

### 2. 样式到 Yoga 布局属性的转换

`styles.ts` 的 `applyStyles()` 函数是样式转换的入口，它将 CSS-like 的 `Styles` 对象拆分为 8 个子流程依次应用到 Yoga 节点上：

1. **Position**：`absolute`/`relative` 定位及 top/bottom/left/right 偏移（支持百分比）
2. **Overflow**：`visible`/`hidden`/`scroll` 映射为 Yoga 的 Overflow 枚举
3. **Margin/Padding**：支持 `margin`、`marginX`/`marginY`、`marginTop` 等多层简写展开
4. **Flex**：flexGrow、flexShrink、flexDirection、flexWrap、alignItems、justifyContent 等完整 Flexbox 属性
5. **Dimension**：width/height/minWidth/maxWidth 等（支持数字和百分比字符串）
6. **Display**：`flex`/`none`
7. **Border**：根据 `borderStyle` 和各方向 `borderTop`/`borderBottom` 等设置 1px 或 0px 边框宽度
8. **Gap**：columnGap、rowGap、gap 简写

### 3. 脏标记与增量更新机制

DOM 变更时不立即重绘，而是通过脏标记（dirty flag）实现增量更新：

1. 任何属性、样式或子节点变更都调用 `markDirty()`（`src/ink/dom.ts:393-413`）
2. `markDirty()` 向上遍历祖先链，将所有 `DOMElement` 的 `dirty` 标记为 `true`
3. 对于 `ink-text` 和 `ink-raw-ansi` 叶子节点，还会调用 Yoga 的 `markDirty()` 触发文本重新测量
4. 样式和属性的设置函数（`setStyle`、`setAttribute`、`setTextNodeValue`）内置了浅比较优化——值未变时跳过 `markDirty()`，避免 React 每次 render 创建新对象引起不必要的重布局（`src/ink/dom.ts:266-316`）

### 4. 焦点管理流程

`FocusManager` 实现了类似浏览器的焦点模型：

1. **Tab 导航**：`focusNext()`/`focusPrevious()` 通过 DFS 收集所有 `tabIndex >= 0` 的节点，构成焦点环，按方向循环切换（`src/ink/focus.ts:102-131`）
2. **焦点栈**：切换焦点时，旧焦点元素入栈（最大深度 32），节点被删除时自动从栈中恢复最近的有效焦点（`src/ink/focus.ts:57-81`）
3. **事件派发**：焦点变更时派发 `FocusEvent`（`focus`/`blur`），携带 `relatedTarget` 信息
4. **自动聚焦**：`finalizeInitialChildren()` 检测 `autoFocus` 属性，`commitMount()` 调用 `handleAutoFocus()` 完成首次挂载的自动聚焦（`src/ink/reconciler.ts:394-403`）
5. **根节点挂载**：`FocusManager` 实例存储在 `ink-root` 节点的 `focusManager` 属性上，任意节点通过 `getRootNode()` 沿 `parentNode` 向上遍历即可获取（类似浏览器的 `node.ownerDocument`）

## 核心类型定义

### `DOMElement`（`src/ink/dom.ts:31-91`）

虚拟 DOM 元素节点，核心字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeName` | `ElementNames` | 元素类型：`ink-root`/`ink-box`/`ink-text`/`ink-virtual-text`/`ink-link`/`ink-progress`/`ink-raw-ansi` |
| `attributes` | `Record<string, DOMNodeAttribute>` | 节点属性 |
| `childNodes` | `DOMNode[]` | 子节点列表 |
| `style` | `Styles` | 样式对象 |
| `yogaNode` | `LayoutNode \| undefined` | 关联的 Yoga 布局节点 |
| `parentNode` | `DOMElement \| undefined` | 父节点引用 |
| `dirty` | `boolean` | 脏标记，指示需要重新渲染 |
| `isHidden` | `boolean` | 隐藏状态（`display: none`） |
| `scrollTop` / `pendingScrollDelta` | `number` | 滚动状态（用于 `overflow: scroll` 容器） |
| `focusManager` | `FocusManager` | 仅 `ink-root` 上存在，管理整棵树的焦点 |
| `_eventHandlers` | `Record<string, unknown>` | 事件处理器（与属性分离存储，避免处理器身份变化触发脏标记） |

### `TextNode`（`src/ink/dom.ts:93-96`）

文本节点，结构简单：

```typescript
type TextNode = {
  nodeName: '#text'
  nodeValue: string
  parentNode: DOMElement | undefined
  yogaNode?: LayoutNode
  style: Styles
}
```

### `Styles`（`src/ink/styles.ts:55-404`）

完整的样式类型，覆盖终端 UI 所需的所有布局和视觉属性：

- **文本换行**：`textWrap`（`wrap`/`truncate-end`/`truncate-middle` 等 8 种模式）
- **定位**：`position`（`absolute`/`relative`）、`top`/`bottom`/`left`/`right`
- **Flexbox**：`flexGrow`/`flexShrink`/`flexDirection`/`flexWrap`/`flexBasis`/`alignItems`/`alignSelf`/`justifyContent`
- **间距**：`margin`/`marginX`/`marginY`/各方向 margin、`padding` 同理、`gap`/`columnGap`/`rowGap`
- **尺寸**：`width`/`height`/`minWidth`/`maxWidth`/`minHeight`/`maxHeight`（支持数字和百分比字符串）
- **边框**：`borderStyle`/`borderTop`/`borderBottom`/`borderLeft`/`borderRight`/`borderColor` 等（含各方向颜色和 dim 控制）
- **视觉**：`backgroundColor`/`opaque`/`display`/`overflow`/`overflowX`/`overflowY`/`noSelect`

### `TextStyles`（`src/ink/styles.ts:44-53`）

文本样式属性，用于结构化文本着色（不依赖 ANSI 字符串变换）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `color` | `Color` | 前景色 |
| `backgroundColor` | `Color` | 背景色 |
| `dim` / `bold` / `italic` / `underline` / `strikethrough` / `inverse` | `boolean` | 文本装饰 |

颜色类型 `Color` 支持：`rgb(r,g,b)`、`#hex`、`ansi256(n)`、16 色 ANSI 命名色（`ansi:red` 等）。

### `FocusManager`（`src/ink/focus.ts:15-132`）

焦点管理器类，核心 API：

| 方法 | 说明 |
|------|------|
| `focus(node)` | 聚焦到指定节点，旧焦点入栈 |
| `blur()` | 清除当前焦点 |
| `focusNext(root)` / `focusPrevious(root)` | Tab / Shift+Tab 循环导航 |
| `handleNodeRemoved(node, root)` | 节点移除时清理焦点并从栈恢复 |
| `handleAutoFocus(node)` | 处理 `autoFocus` 属性 |
| `handleClickFocus(node)` | 点击聚焦（需有 `tabIndex` 属性） |
| `enable()` / `disable()` | 启用/禁用焦点系统 |

## 函数签名

### DOM 树操作（`dom.ts` 导出）

- **`createNode(nodeName: ElementNames): DOMElement`** — 创建元素节点。`ink-virtual-text`、`ink-link`、`ink-progress` 不创建 Yoga 节点；`ink-text` 和 `ink-raw-ansi` 会绑定测量函数
- **`createTextNode(text: string): TextNode`** — 创建文本节点
- **`appendChildNode(node: DOMElement, childNode: DOMElement): void`** — 追加子节点，同步 Yoga 树
- **`insertBeforeNode(node: DOMElement, newChild: DOMNode, beforeChild: DOMNode): void`** — 在指定节点前插入，计算正确的 Yoga 索引（因为部分 DOM 子节点没有对应 Yoga 节点）
- **`removeChildNode(node: DOMElement, removeNode: DOMNode): void`** — 移除子节点，回收缓存的渲染矩形
- **`setAttribute(node, key, value): void`** — 设置属性（跳过 `children`，未变时不标脏）
- **`setStyle(node, style): void`** — 设置样式（浅比较优化）
- **`setTextStyles(node, textStyles): void`** — 设置文本样式（浅比较优化）
- **`setTextNodeValue(node, text): void`** — 更新文本内容（未变时跳过）
- **`markDirty(node): void`** — 向上遍历祖先链标记脏，对叶子文本节点同时标记 Yoga 脏
- **`scheduleRenderFrom(node): void`** — 从任意节点触发根节点的 `onRender()`，用于非 React 路径的 DOM 变更（如 scrollTop 调整）
- **`clearYogaNodeReferences(node): void`** — 递归清除 Yoga 节点引用，防止释放后的悬空指针

### Reconciler 导出（`reconciler.ts`）

- **`getOwnerChain(fiber: unknown): string[]`** — 从 React Fiber 向上遍历提取组件名称链，用于调试重绘归因
- **`isDebugRepaintsEnabled(): boolean`** — 检查 `CLAUDE_CODE_DEBUG_REPAINTS` 环境变量
- **`recordYogaMs(ms) / getLastYogaMs() / markCommitStart() / getLastCommitMs() / resetProfileCounters()`** — 性能 profiling 接口，用于滚动基准测试

### 样式转换（`styles.ts` 默认导出）

- **`applyStyles(node: LayoutNode, style: Styles, resolvedStyle?: Styles): void`** — 将 `Styles` 对象转换为 Yoga 布局属性。`resolvedStyle` 参数用于 `commitUpdate` 场景：`style` 可能是 diff（只含变更属性），`resolvedStyle` 是完整样式，用于边框等需要上下文的属性

## 边界 Case 与注意事项

### 文本节点必须在 `<Text>` 内

`createTextInstance()` 会校验 `hostContext.isInsideText`，裸文本字符串不在 `<Text>` 组件内时抛出错误。类似地，`<Box>` 不能嵌套在 `<Text>` 内（`src/ink/reconciler.ts:338-339, 365-369`）。

### `ink-text` vs `ink-virtual-text` 的自动转换

当 `<Text>` 嵌套在另一个 `<Text>` 中时，内层的 `ink-text` 会被自动降级为 `ink-virtual-text`（不创建 Yoga 节点），避免布局树中出现嵌套的测量节点（`src/ink/reconciler.ts:342-346`）。

### Yoga 节点与 DOM 节点的索引差异

`insertBeforeNode` 需要手动计算 Yoga 索引，因为 `ink-virtual-text`、`ink-link`、`ink-progress` 等类型不创建 Yoga 节点，导致 DOM 子节点索引与 Yoga 子节点索引不一致（`src/ink/dom.ts:169-180`）。

### 节点删除时的资源回收

`cleanupYogaNode()` 必须在释放前调用 `clearYogaNodeReferences()` 递归清除所有后代的 `yogaNode` 引用，防止并发操作中访问已释放的 WASM 内存（`src/ink/reconciler.ts:95-104`）。

### 事件处理器与属性分离存储

事件处理器存储在 `_eventHandlers` 而非 `attributes` 中，因为处理器的引用身份在每次 render 时可能变化，若存入 attributes 会触发不必要的 `markDirty`，破坏 blit 优化（`src/ink/dom.ts:49-51`）。

### 焦点栈的去重与上限

焦点栈最大深度为 32。Tab 循环可能导致同一节点反复入栈，因此 `focus()` 在入栈前会先去重（`src/ink/focus.ts:33-37`）。

### Commit 调试工具

设置 `CLAUDE_CODE_COMMIT_LOG` 环境变量可将每次 commit 的性能数据（间隔、reconcile 耗时、节点创建数、Yoga 计算耗时等）写入指定文件，用于诊断渲染卡顿。`CLAUDE_CODE_DEBUG_REPAINTS` 则启用组件归因链追踪。

### React 19 适配

Reconciler 已适配 React 19 API：`commitUpdate` 直接接收 `oldProps`/`newProps`（不再使用 `updatePayload`），并实现了 `maySuspendCommit`、`preloadInstance`、`suspendInstance` 等新增必要方法（`src/ink/reconciler.ts:472-506`）。