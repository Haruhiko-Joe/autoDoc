# LayoutEngine — Yoga 布局引擎封装层

## 概述与职责

LayoutEngine 是终端 UI 框架（InkFramework）的底层布局模块，负责将 Facebook Yoga 布局引擎的 C++ 绑定封装为一套与引擎无关的 TypeScript 抽象接口。它在整体架构中属于 **TerminalUI → InkFramework** 层级，为上层的 Box、Text、ScrollBox 等 UI 组件提供 Flexbox 布局计算能力。

模块由四个文件组成，各司其职：

| 文件 | 职责 |
|------|------|
| `node.ts` | 定义 `LayoutNode` 抽象接口和所有布局枚举类型 |
| `yoga.ts` | 将 Yoga C++ 绑定适配为 `LayoutNode` 接口的具体实现 |
| `geometry.ts` | 提供 `Point`/`Size`/`Rectangle`/`Edges` 几何原语和工具函数 |
| `engine.ts` | 工厂入口，暴露 `createLayoutNode()` 创建节点 |

这种分层设计使得布局引擎可以被替换（只需实现 `LayoutNode` 接口），上层代码不依赖 Yoga 细节。

## 关键流程

### 布局节点的创建与使用

1. 上层代码调用 `createLayoutNode()`（`src/ink/layout/engine.ts:4`）
2. 内部调用 `createYogaLayoutNode()`（`src/ink/layout/yoga.ts:306-308`），通过 `Yoga.Node.create()` 创建底层 Yoga 节点并包装为 `YogaLayoutNode`
3. 调用方通过 `LayoutNode` 接口设置样式属性（宽高、flex 方向、对齐方式、边距等）
4. 通过 `insertChild()` / `removeChild()` 构建节点树
5. 在根节点调用 `calculateLayout(width, height)` 触发 Yoga 引擎计算布局
6. 计算完成后，通过 `getComputedLeft()` / `getComputedTop()` / `getComputedWidth()` / `getComputedHeight()` 读取每个节点的布局结果

### Yoga 枚举映射机制

`YogaLayoutNode` 内部维护了一套从抽象枚举到 Yoga 原生枚举的映射表。以 Edge 和 Gutter 为例，文件顶部定义了两个常量映射（`src/ink/layout/yoga.ts:33-49`）：

```typescript
const EDGE_MAP: Record<LayoutEdge, Edge> = {
  all: Edge.All,
  horizontal: Edge.Horizontal,
  // ...
}
```

而 `FlexDirection`、`Align`、`Justify`、`Wrap` 等枚举的映射则以内联 `Record` 的形式出现在各自的 setter 方法中（如 `src/ink/layout/yoga.ts:178-184`）。

### 自定义测量函数

对于叶子节点（如 Text），需要提供自定义测量函数来告诉布局引擎内容的尺寸。通过 `setMeasureFunc()` 注册回调（`src/ink/layout/yoga.ts:86-96`），该方法负责将 Yoga 的 `MeasureMode` 枚举转换为 `LayoutMeasureMode` 后传递给调用方的回调函数。

## 接口/类型定义

### `LayoutNode`（`src/ink/layout/node.ts:93-152`）

核心抽象接口，定义了布局节点的完整能力，分为四组方法：

**树操作**：`insertChild`、`removeChild`、`getChildCount`、`getParent`

**布局计算**：`calculateLayout(width?, height?)`、`setMeasureFunc`、`unsetMeasureFunc`、`markDirty`

**布局结果读取**：`getComputedLeft`、`getComputedTop`、`getComputedWidth`、`getComputedHeight`、`getComputedBorder`、`getComputedPadding`

**样式设置**（完整 Flexbox 支持）：
- 尺寸：`setWidth` / `setWidthPercent` / `setWidthAuto`（同理 height、minWidth、minHeight、maxWidth、maxHeight）
- Flex 属性：`setFlexDirection` / `setFlexGrow` / `setFlexShrink` / `setFlexBasis` / `setFlexBasisPercent` / `setFlexWrap`
- 对齐：`setAlignItems` / `setAlignSelf` / `setJustifyContent`
- 显示与定位：`setDisplay` / `getDisplay` / `setPositionType` / `setPosition` / `setPositionPercent` / `setOverflow`
- 间距：`setMargin` / `setPadding` / `setBorder` / `setGap`

**生命周期**：`free()` 释放单个节点，`freeRecursive()` 递归释放整棵子树

### 布局枚举（`src/ink/layout/node.ts:4-91`）

| 枚举 | 值 | 说明 |
|------|-----|------|
| `LayoutEdge` | `all`, `horizontal`, `vertical`, `left`, `right`, `top`, `bottom`, `start`, `end` | 边方向，用于 margin/padding/border/position |
| `LayoutGutter` | `all`, `column`, `row` | 间隙方向，用于 gap |
| `LayoutDisplay` | `flex`, `none` | 显示模式 |
| `LayoutFlexDirection` | `row`, `row-reverse`, `column`, `column-reverse` | Flex 主轴方向 |
| `LayoutAlign` | `auto`, `stretch`, `flex-start`, `center`, `flex-end` | 对齐方式 |
| `LayoutJustify` | `flex-start`, `center`, `flex-end`, `space-between`, `space-around`, `space-evenly` | 主轴内容分布 |
| `LayoutWrap` | `nowrap`, `wrap`, `wrap-reverse` | 换行模式 |
| `LayoutPositionType` | `relative`, `absolute` | 定位类型 |
| `LayoutOverflow` | `visible`, `hidden`, `scroll` | 溢出处理 |
| `LayoutMeasureMode` | `undefined`, `exactly`, `at-most` | 测量模式 |

### `LayoutMeasureFunc`（`src/ink/layout/node.ts:80-83`）

```typescript
type LayoutMeasureFunc = (
  width: number,
  widthMode: LayoutMeasureMode,
) => { width: number; height: number }
```

自定义测量回调类型。`widthMode` 表示宽度约束模式：`exactly` 表示精确宽度、`at-most` 表示最大宽度约束、`undefined` 表示无约束。

## 几何原语（`src/ink/layout/geometry.ts`）

### 基础类型

| 类型 | 字段 | 说明 |
|------|------|------|
| `Point` | `x`, `y` | 二维坐标点 |
| `Size` | `width`, `height` | 尺寸 |
| `Rectangle` | `x`, `y`, `width`, `height` | 矩形区域（`Point & Size`） |
| `Edges` | `top`, `right`, `bottom`, `left` | 四方向边距值 |

### 工具函数

**`edges()`** — 创建 `Edges` 的便捷工厂，支持三种重载（`src/ink/layout/geometry.ts:22-38`）：
- `edges(all)` — 四边相同
- `edges(vertical, horizontal)` — 上下/左右分组
- `edges(top, right, bottom, left)` — 分别指定

**`addEdges(a, b)`** — 两组边距逐方向相加（`src/ink/layout/geometry.ts:41-48`）

**`resolveEdges(partial?)`** — 将 `Partial<Edges>` 填充默认值 0（`src/ink/layout/geometry.ts:54-61`）

**`unionRect(a, b)`** — 计算两个矩形的包围矩形（`src/ink/layout/geometry.ts:63-69`）

**`clampRect(rect, size)`** — 将矩形裁剪到给定尺寸边界内（`src/ink/layout/geometry.ts:71-82`）

**`withinBounds(size, point)`** — 判断点是否在给定尺寸范围内（`src/ink/layout/geometry.ts:84-91`）

**`clamp(value, min?, max?)`** — 通用数值钳制（`src/ink/layout/geometry.ts:93-97`）

**`ZERO_EDGES`** — 全零边距常量（`src/ink/layout/geometry.ts:51`）

## 边界 Case 与注意事项

- **`calculateLayout` 忽略 height 参数**：`YogaLayoutNode.calculateLayout()` 接受 `width` 和 `height` 两个参数，但实际调用 Yoga 时 height 传入 `undefined`（`src/ink/layout/yoga.ts:82-84`）。这符合终端场景——终端宽度固定但高度无限延伸。
- **布局方向固定为 LTR**：`calculateLayout` 硬编码使用 `Direction.LTR`，不支持 RTL 布局。
- **`getParent()` 每次调用创建新包装对象**：返回 `new YogaLayoutNode(p)` 而非缓存实例（`src/ink/layout/yoga.ts:76-78`），对身份比较（`===`）需注意。
- **必须手动释放节点**：使用完毕后需调用 `free()` 或 `freeRecursive()` 释放 Yoga 节点资源，否则可能导致内存泄漏。
- **纯 TS Yoga 实现**：注释说明（`src/ink/layout/yoga.ts:302-304`）使用的是纯 TypeScript 移植版 yoga-layout，无 WASM 加载，同步可用，无需预加载或重置机制。