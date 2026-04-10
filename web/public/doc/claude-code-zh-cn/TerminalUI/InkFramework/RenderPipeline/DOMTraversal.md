# DOM 树递归遍历与渲染输出生成（DOMTraversal）

## 概述与职责

DOMTraversal 模块是 Ink 渲染管线的核心执行阶段，负责将经过 Yoga 布局计算的虚拟 DOM 树递归遍历，并将每个节点的内容写入 Output buffer。它位于 **TerminalUI → InkFramework → RenderPipeline** 层级中，是从"布局完成"到"像素写入"的关键桥梁。

在 RenderPipeline 的同级模块中，`screen.ts` 提供底层 cell 矩阵缓冲区，`output.ts` 收集渲染操作，`log-update.ts` 执行终端增量更新，而本模块则负责**决定写入什么内容、在哪里写入**——包括裁剪、滚动、脏检测跳过、绝对定位修复等复杂渲染语义。

模块由三个文件组成：

| 文件 | 行数 | 职责 |
|------|------|------|
| `render-node-to-output.ts` | ~1461 | 核心递归遍历器，处理所有节点类型的渲染 |
| `render-border.ts` | ~231 | 边框绘制，支持多种样式和嵌入文本 |
| `node-cache.ts` | ~55 | 节点布局缓存，支撑 blit 优化和清除管理 |

## 关键流程

### 1. 主递归遍历：`renderNodeToOutput()`

这是整个模块的入口函数（`render-node-to-output.ts:387-1227`），每帧由 Ink 主循环调用，从根节点开始递归处理整棵 DOM 树。核心逻辑按节点类型分三条路径：

**入口参数：**
```typescript
function renderNodeToOutput(
  node: DOMElement,
  output: Output,
  { offsetX, offsetY, prevScreen, skipSelfBlit, inheritedBackgroundColor }
): void
```

- `prevScreen`：上一帧的 Screen buffer，用于 blit 快速路径
- `skipSelfBlit`：强制跳过自身 blit（用于非不透明绝对定位覆盖层）
- `inheritedBackgroundColor`：从父节点继承的背景色

**执行流程：**

1. **Display:None 检测**（:412-433）—— 隐藏节点直接返回，清除旧位置缓存
2. **坐标计算**（:436-450）—— 从 Yoga 读取 `getComputedLeft()/getComputedTop()`，叠加父偏移量。绝对定位节点的负 y 值钳位到 0（防止自动补全菜单上溢）
3. **Blit 快速路径**（:454-482）—— **核心性能优化**：如果节点未脏（`!node.dirty`）、无待处理滚动、布局位置/尺寸与缓存一致、且有 prevScreen，直接从上一帧拷贝像素，跳过整个子树
4. **旧位置清除**（:487-523）—— 位置/尺寸变化时清除旧区域，处理 `pendingClears`（被移除子节点留下的矩形）
5. **零高度检测**（:535-539）—— Yoga 将节点压缩到 0 高度且与兄弟共享 y 坐标时跳过渲染，防止残影
6. **节点类型分发**：
   - `ink-raw-ansi`：直接写入预渲染的 ANSI 文本
   - `ink-text`：文本节点处理（详见下节）
   - `ink-box`：容器节点处理（裁剪、滚动、子节点递归）
   - `ink-root`：根节点，直接递归子节点
7. **缓存更新**（:1220-1226）—— 将当前帧的布局信息写入 `nodeCache`，清除 dirty 标记

### 2. 文本节点渲染

文本节点处理流程（`render-node-to-output.ts:549-627`）：

1. 调用 `squashTextNodesToSegments()` 将子文本节点合并为带样式的 `StyledSegment[]`
2. 拼接纯文本，计算 `maxWidth`（取 Yoga 宽度和屏幕剩余宽度的较小值）
3. 根据是否需要换行，分三条路径处理：
   - **单段 + 需换行**：先换行再逐行应用样式
   - **多段 + 需换行**：通过 `buildCharToSegmentMap()` 建立字符→段映射，换行后用 `applyStylesToWrappedText()` 按映射恢复每个字符的样式
   - **无需换行**：直接对每段应用样式
4. 每段的超链接通过 `wrapWithOsc8Link()` 包装 OSC 8 序列（`render-node-to-output.ts:184-186`），**逐行包装**确保多行文本每行都可独立点击
5. 调用 `applyPaddingToText()` 根据首个子节点的 Yoga 偏移应用内边距
6. 通过 `wrapWithSoftWrap()` 记录哪些换行是自动插入的（软换行），传给 `output.write()` 供后续处理

### 3. ScrollBox 滚动处理

滚动处理是本模块最复杂的部分（`render-node-to-output.ts:688-1154`），分为滚动状态管理和渲染两大阶段。

#### 3.1 滚动状态计算

1. **视口度量**（:695-723）—— 从 Yoga 读取 padding，计算 `innerHeight`（可见区域高度）和 `scrollHeight`（内容总高度）
2. **锚点滚动**（:737-744）—— `scrollAnchor` 提供基于元素引用的定位：读取锚点元素的 `getComputedTop()`，直接设置 `scrollTop`
3. **底部跟随**（:745-795）—— 当 `scrollTop` 处于上一帧的 `maxScroll` 位置时自动跟随新内容（sticky 模式）。记录 `followScroll` 事件供 `ink.tsx` 调整文本选区偏移
4. **分帧 Drain**（:796-849）—— 将大量滚动增量分散到多帧平滑执行，两种策略：
   - **原生终端**（iTerm2/Ghostty）：`drainProportional()`（:161-176）—— 每帧消费 `max(4, floor(abs*3/4))`，大突发以 log₄ 帧追赶
   - **xterm.js**（VS Code）：`drainAdaptive()`（:124-157）—— 低量（≤5）一次全排，高量分步追赶，超过 30 行直接截断
5. **虚拟滚动钳位**（:842-850）—— `scrollClampMin/Max` 将视觉渲染限制在已挂载的子节点范围内，防止快速 PageUp 后显示空白间距

#### 3.2 渲染路径

分为 **blit+shift 快速路径** 和 **全量路径**：

**快速路径**（:917-1105）—— 当滚动 delta 小于视口高度、容器未移动时：

1. 从 prevScreen blit 整个滚动区域
2. 调用 `output.shift()` 原地移动行内容（对应终端的 DECSTBM 硬件滚动）
3. 仅渲染边缘行（新进入视口的内容），通过 `output.clip()` 限制写入范围
4. **第二遍**：修复稳定区域中的脏子节点（内容变化）和中间生长点下方的干净子节点（位置偏移）
5. **第三遍**：修复绝对定位覆盖层被 shift 错位的残影——从 `absoluteRectsPrev` 读取上帧的绝对定位矩形，擦除并重新渲染受影响行

**全量路径**（:1106-1146）—— 大跳转或容器移动时：

- 如果发生了滚动，清空整个视口
- 调用 `renderScrolledChildren()` 渲染所有可见子节点

#### 3.3 DECSTBM ScrollHint

`ScrollHint` 类型（`render-node-to-output.ts:49`）记录滚动提示信息：

```typescript
type ScrollHint = { top: number; bottom: number; delta: number }
```

- `top/bottom`：0 索引的屏幕行范围（包含）
- `delta`：正值=内容上移（向下滚动）
- 由 `log-update.ts` 消费，转化为 DECSTBM + SU/SD 终端硬件滚动指令

### 4. 脏检测与 Blit 优化

**blit**（block transfer）是将上一帧的像素直接拷贝到当前帧的优化手段，避免重新渲染未变化的子树。

**Blit 成立条件**（`render-node-to-output.ts:455-465`）：
- `node.dirty === false`
- `skipSelfBlit === false`
- `node.pendingScrollDelta === undefined`
- 缓存的 x/y/width/height 与当前帧一致
- `prevScreen` 可用

**溢出污染防护**（`renderChildren()`, :1257-1294）：

当一个脏子节点被渲染后，其内容可能溢出到后续兄弟的区域。因此：
- 脏子节点之后的兄弟不再传递 `prevScreen`（禁止 blit）
- 但**裁剪了两轴的子节点**（overflow: hidden/scroll）是例外——其内容不会溢出，后续兄弟仍可 blit
- 绝对定位的裁剪子节点不享受此优化（其布局可能与任意兄弟重叠）

**Layout Shift 检测**（`render-node-to-output.ts:34-41`）：

模块级 `layoutShifted` 标志在以下情况下设为 true：
- 节点位置/尺寸与缓存不一致
- 有子节点被移除（`pendingClears`）
- ScrollBox 大跳转（delta ≥ 视口高度）

`ink.tsx` 在帧结束时读取此标志决定是否需要全屏 damage（回退到 O(rows×cols) diff）。

### 5. 绝对定位节点处理

绝对定位节点有两个特殊问题：

1. **跨子树绘制**：绝对节点可能绘制在非兄弟区域上。`blitEscapingAbsoluteDescendants()`（:1337-1369）在父节点 blit 后，递归查找超出父布局边界的绝对子孙，额外 blit 它们的区域

2. **移除时的全局污染**：`node-cache.ts:32` 的 `absoluteNodeRemoved` 标志在绝对定位节点被移除时设置，通知渲染器下一帧禁用所有 blit——因为上一帧的 prevScreen 中可能包含该节点在任意位置绘制的像素

### 6. 视口裁剪（Viewport Culling）

`renderScrolledChildren()`（:1377-1448）为滚动容器提供子节点裁剪：

- 参数 `scrollTopY/scrollBottomY` 定义可见窗口（子节点本地坐标）
- 完全在窗口外的子节点跳过渲染，并删除其 `nodeCache` 条目（防止重入时发出错误的清除指令）
- `preserveCulledCache` 参数在 DECSTBM 快速路径下为 true，跳过缓存删除（因为 blit+shift 已保证稳定行的正确性），避免 O(total_children × subtree_depth) 的遍历

**性能优化**：通过 `cumHeightShift` 追踪已遍历脏子节点的累积高度变化（:1400）。当 shift 为 0 时，干净子节点可直接使用缓存的 `top` 值进行裁剪判断，跳过 Yoga 读取——实现 O(dirty) 而非 O(mounted) 的首遍复杂度。

## 函数签名与参数说明

### `renderNodeToOutput(node, output, options): void`

主入口。递归渲染 DOM 节点到 Output buffer。

| 参数 | 类型 | 说明 |
|------|------|------|
| `node` | `DOMElement` | 待渲染的 DOM 节点 |
| `output` | `Output` | 渲染输出目标 |
| `offsetX/offsetY` | `number` | 父节点的绝对坐标偏移 |
| `prevScreen` | `Screen \| undefined` | 上一帧 Screen buffer，用于 blit |
| `skipSelfBlit` | `boolean` | 是否强制跳过自身 blit |
| `inheritedBackgroundColor` | `Color \| undefined` | 继承的背景色 |

> 源码位置：`src/ink/render-node-to-output.ts:387-408`

### `renderBorder(x, y, node, output): void`

为带 `borderStyle` 的节点绘制四边边框。

| 参数 | 类型 | 说明 |
|------|------|------|
| `x/y` | `number` | 节点绝对坐标 |
| `node` | `DOMNode` | DOM 节点（读取 style.borderStyle 等属性） |
| `output` | `Output` | 渲染输出目标 |

> 源码位置：`src/ink/render-border.ts:82-229`

### `addPendingClear(parent, rect, isAbsolute): void`

注册被移除子节点需要在下一帧清除的矩形区域。

> 源码位置：`src/ink/node-cache.ts:34-48`

### Drain 函数

- `drainAdaptive(node, pending, innerHeight): number` —— xterm.js 自适应排空（`render-node-to-output.ts:124-157`）
- `drainProportional(node, pending, innerHeight): number` —— 原生终端比例排空（`render-node-to-output.ts:161-176`）

## 接口/类型定义

### `CachedLayout`

```typescript
type CachedLayout = {
  x: number      // 绝对 x 坐标
  y: number      // 绝对 y 坐标
  width: number  // Yoga 计算宽度
  height: number // Yoga 计算高度
  top?: number   // Yoga 本地 getComputedTop()，供 ScrollBox 裁剪快速路径使用
}
```

> 源码位置：`src/ink/node-cache.ts:10-16`

### `ScrollHint`

```typescript
type ScrollHint = { top: number; bottom: number; delta: number }
```

DECSTBM 硬件滚动提示，供 `log-update.ts` 消费。

> 源码位置：`src/ink/render-node-to-output.ts:49`

### `FollowScroll`

```typescript
type FollowScroll = { delta: number; viewportTop: number; viewportBottom: number }
```

记录本帧的自动跟随滚动事件，供 `ink.tsx` 调整文本选区位置。

> 源码位置：`src/ink/render-node-to-output.ts:93-97`

### `BorderTextOptions`

```typescript
type BorderTextOptions = {
  content: string              // 预渲染的 ANSI 颜色字符串
  position: 'top' | 'bottom'  // 嵌入位置
  align: 'start' | 'end' | 'center'
  offset?: number              // 距边缘的偏移量
}
```

> 源码位置：`src/ink/render-border.ts:9-14`

### `BorderStyle`

```typescript
type BorderStyle = keyof Boxes | keyof typeof CUSTOM_BORDER_STYLES | BoxStyle
```

支持 `cli-boxes` 内置样式（single、double、round 等）、自定义 `dashed` 样式、以及完全自定义的 `BoxStyle` 对象。

> 源码位置：`src/ink/render-border.ts:30-33`

## 配置项与常量

### 滚动 Drain 常量

| 常量 | 值 | 说明 |
|------|----|------|
| `SCROLL_MIN_PER_FRAME` | 4 | 原生终端每帧最小滚动行数 |
| `SCROLL_INSTANT_THRESHOLD` | 5 | xterm.js 即时排空阈值（≤5 行一次排完） |
| `SCROLL_HIGH_PENDING` | 12 | xterm.js 高 pending 阈值 |
| `SCROLL_STEP_MED` | 2 | xterm.js 中等追赶步长 |
| `SCROLL_STEP_HIGH` | 3 | xterm.js 快速追赶步长 |
| `SCROLL_MAX_PENDING` | 30 | xterm.js 超过此值直接截断 |

> 源码位置：`src/ink/render-node-to-output.ts:110-121`

### 自定义边框样式

`CUSTOM_BORDER_STYLES` 目前只定义了 `dashed`（使用 `╌`/`╎` Unicode 线绘字符，四角为空格——因为 Unicode 中没有虚线转角字符）。

> 源码位置：`src/ink/render-border.ts:16-28`

## 边框渲染

`renderBorder()`（`render-border.ts:82-229`）的完整流程：

1. 从 Yoga 读取节点的 `width/height`
2. 解析 `borderStyle`——先查 `CUSTOM_BORDER_STYLES`，再查 `cli-boxes`，最后当作自定义 `BoxStyle` 对象
3. 读取四边独立的颜色（`borderTopColor` 等）和 dim 属性，回退到统一的 `borderColor/borderDimColor`
4. 根据 `borderTop/Bottom/Left/Right` 开关决定是否显示各边
5. **顶/底边框文本嵌入**：通过 `embedTextInBorder()`（:35-68）在边框线中插入文本——支持 `start`/`end`/`center` 三种对齐方式。文本两侧的边框字符用对应的线绘字符重复填充
6. 左/右边框按高度重复绘制
7. 对每段边框线分别应用颜色和 dim 样式
8. 边框在子节点之后渲染（`render-node-to-output.ts:1206`），防止被子节点的清除操作覆盖

## 节点布局缓存

`node-cache.ts` 维护两个 `WeakMap` 和一个全局标志：

- **`nodeCache: WeakMap<DOMElement, CachedLayout>`**（:18）—— 存储每个节点上一帧的布局信息。WeakMap 确保 DOM 节点被回收时缓存自动释放。用途：
  - Blit 判断：当前帧布局与缓存一致时跳过渲染
  - 旧位置清除：节点移动时清除缓存中的旧区域
  - ScrollBox 裁剪：`top` 字段允许跳过 Yoga 读取

- **`pendingClears: WeakMap<DOMElement, Rectangle[]>`**（:21）—— 被移除子节点留下的矩形列表。下一帧渲染时清除这些区域

- **`absoluteNodeRemoved`**（:32）—— 绝对定位节点被移除时设置的全局污染标志。通过 `consumeAbsoluteRemovedFlag()`（:50-54）在帧开始时读取并重置。此标志触发渲染器禁用整帧的 blit 优化

## 边界 Case 与注意事项

- **零高度节点残影**：当 Yoga 将节点压缩到 h=0 且与兄弟共享同一行时，会跳过渲染防止字符残留（如 "false"+"true"→"truee"）。但 h=0 + 独占行的情况（Yoga 像素舍入导致）仍正常渲染
- **负 y 绝对定位**：`bottom='100%'` 的绝对定位节点（如自动补全菜单）可能产生负 y，钳位到 0 使顶部可见
- **xterm.js 检测**：`isXtermJsHost()` 使用 `TERM_PROGRAM=vscode` 作为同步回退，`isXtermJs()` 是基于 XTVERSION 探测的权威结果。滚动事件发生时探测已完成（远在启动 50ms 之后）
- **虚拟滚动钳位**：`scrollClampMin/Max` 仅影响**视觉渲染**，不回写 `scrollTop`——React 下次提交时看到真实目标值并挂载正确范围
- **backgroundColor/opaque 禁用子 blit**：有背景色或 opaque 的容器每帧填充整个内部区域，子节点 blit 会恢复旧像素覆盖新填充
- **分帧 Drain 超越钳位**：当 scrollTop 已超出 `scrollClampMin/Max` 时，drain 限速到 ~4 行/帧，防止 scrollTop 远超已挂载范围造成长时间追赶停滞