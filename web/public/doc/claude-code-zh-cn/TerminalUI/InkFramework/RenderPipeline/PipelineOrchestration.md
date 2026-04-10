# 渲染管线编排与帧管理（PipelineOrchestration）

## 概述与职责

PipelineOrchestration 是 Ink 渲染管线（RenderPipeline）中的**编排层**，负责将虚拟 DOM 树转换为最终的 `Frame` 数据结构——每一帧包含 Screen buffer、视口尺寸和光标位置。它位于 TerminalUI → InkFramework → RenderPipeline 层级中，与同级的 Screen buffer（`screen.ts`）、DOM 遍历器（`render-node-to-output.ts`）、终端增量更新器（`log-update.ts`）等模块协作。

本模块由三个文件组成：
- **`renderer.ts`**：渲染管线主入口，编排双缓冲渲染循环
- **`frame.ts`**：Frame/Patch/Diff 类型体系和清屏判断逻辑
- **`render-to-screen.ts`**：独立的搜索渲染路径，将单个 React 元素渲染到隔离 Screen

## 关键流程

### 主渲染循环（createRenderer）

`createRenderer` 是一个工厂函数，接收 DOM 根节点和样式池，返回一个渲染函数。每次调用该渲染函数即执行一帧的完整渲染流程：

1. **Yoga 布局验证**：检查根节点的 `yogaNode` 是否存在且布局尺寸有效（非 NaN、非负、非 Infinity）。无效时返回空 Frame 并记录调试日志（`renderer.ts:48-82`）

2. **Alt-screen 高度钳制**：在全屏模式下，将渲染高度强制钳制为 `terminalRows`。如果 Yoga 计算的高度超过终端行数（通常意味着有组件渲染在 `<AlternateScreen>` 之外），溢出内容会被静默裁剪，同时输出警告日志（`renderer.ts:97-104`）

3. **Output 复用与重置**：复用跨帧的 `Output` 实例以保留 charCache（tokenize + grapheme clustering 缓存），避免每帧重建。首帧创建新实例，后续帧调用 `output.reset()` 重置尺寸（`renderer.ts:108-112`）

4. **prevFrame 污染检测**：决定是否向 `renderNodeToOutput` 传递上一帧的 Screen 用于 blit 优化。以下情况会禁用 blit（传入 `undefined`）：
   - `prevFrameContaminated` 为 true：上一帧的 Screen 被选区覆写、alt-screen 进入/resize 重置、或强制重绘清零
   - `absoluteRemoved` 为 true：有绝对定位节点被移除，其像素可能覆盖了非兄弟节点的区域
   
   当 prevScreen 有效时，blit 可以跳过未变化的区域，这是稳态帧（spinner 跳动、文本流）的关键性能优化（`renderer.ts:118-135`）

5. **DOM 遍历与 Screen 写入**：调用 `renderNodeToOutput` 递归遍历 DOM 树，将内容写入 Output buffer，再通过 `output.get()` 刷新到 Screen（`renderer.ts:130-137`）

6. **Scroll drain 续帧标记**：如果某个 ScrollBox 还有未消耗完的 `pendingScrollDelta`，通过 `markDirty` 标记其祖先链为脏，确保下一帧会重新遍历该子树完成剩余滚动（`renderer.ts:139-144`）

7. **构建 Frame**：组装最终的 Frame 对象，包含：
   - `screen`：渲染后的 Screen buffer
   - `viewport`：视口尺寸（alt-screen 下 height 设为 `rows + 1` 以避免触发 `shouldClearScreen` 的溢出判断）
   - `cursor`：光标位置（alt-screen 下钳制在视口内，防止 log-update 的光标恢复 LF 导致滚动错位）
   - `scrollHint`：DECSTBM 滚动优化提示（仅 alt-screen）
   - `scrollDrainPending`：续帧标记

### 搜索渲染路径（renderToScreen）

这是一条**完全独立**的渲染路径，用于搜索功能。它将单个 React 消息元素渲染到隔离的 Screen buffer 上，不影响主渲染循环：

1. **初始化共享资源**（仅首次调用）：创建独立的 `ink-root` DOM 节点、`FocusManager`、`StylePool`、`CharPool`、`HyperlinkPool`，以及 `LegacyRoot` 类型的 React container（`render-to-screen.ts:63-82`）。选择 `LegacyRoot` 而非 `ConcurrentRoot` 是因为后者的 scheduler 积压会跨 root 泄漏

2. **同步 reconcile**：调用 `updateContainerSync` + `flushSyncWork` 将 React 元素同步渲染到虚拟 DOM

3. **Yoga 布局**：设置宽度并计算布局，获取自然高度

4. **绘制到 Screen**：创建新 Screen，通过 `renderNodeToOutput` 写入内容。无 alt-screen、无 prevScreen（每次都是全新渲染）

5. **卸载**：渲染完成后立即卸载组件树，但保留 root/container/pools 供下次复用

6. **性能监控**：累积 reconcile、yoga、paint、scan 各阶段耗时，每 20 次调用输出一次统计日志。单次调用约 1-3ms

### 搜索匹配扫描（scanPositions）

在 `renderToScreen` 获得的 Screen 上执行文本匹配：

1. 逐行遍历 Screen 的 cell 矩阵，跳过 `SpacerTail`（宽字符尾部占位）、`SpacerHead`（宽字符头部占位）和 `noSelect` 标记的 cell
2. 构建小写化的纯文本字符串，同时维护 `codeUnitToCell` 映射表处理 surrogate pair（emoji）和多 code unit 小写转换（如土耳其语 İ → i + U+0307）
3. 使用 `indexOf` 进行非重叠搜索，返回消息局部坐标系的 `MatchPosition[]`

### 当前匹配高亮（applyPositionedHighlight）

对搜索结果中"当前选中"的匹配项应用黄色+粗体+下划线样式。其他匹配项的反色高亮由 `applySearchHighlight` 单独处理（两层高亮机制：扫描层 = "你可以去这里"，定位层 = "你在这里"）。接受 `rowOffset` 参数将消息局部坐标转换为屏幕坐标，并裁剪超出屏幕范围的匹配项（`render-to-screen.ts:212-231`）。

## 函数签名

### `createRenderer(node: DOMElement, stylePool: StylePool): Renderer`

渲染器工厂函数。返回一个闭包，每次调用执行一帧渲染。

- **node**：DOM 树根节点
- **stylePool**：样式池，用于样式 ID 分配和转换
- **返回值**：`Renderer` 类型，签名为 `(options: RenderOptions) => Frame`

> 源码位置：`src/ink/renderer.ts:31-178`

### `renderToScreen(el: ReactElement, width: number): { screen: Screen; height: number }`

将单个 React 元素渲染到隔离 Screen。用于搜索场景——渲染一条消息，再在其 Screen 上扫描匹配。

- **el**：需要渲染的 React 元素（调用方需自行包裹所需 Context）
- **width**：渲染宽度（列数）
- **返回值**：Screen buffer 和 Yoga 计算的自然高度

> 源码位置：`src/ink/render-to-screen.ts:59-139`

### `scanPositions(screen: Screen, query: string): MatchPosition[]`

在 Screen buffer 中扫描所有匹配位置，大小写不敏感。

- **screen**：待扫描的 Screen（通常由 `renderToScreen` 产出）
- **query**：搜索关键词
- **返回值**：`MatchPosition[]`，坐标相对于 buffer 顶部（row 0 = 消息顶部）

> 源码位置：`src/ink/render-to-screen.ts:149-201`

### `applyPositionedHighlight(screen, stylePool, positions, rowOffset, currentIdx): boolean`

在主渲染 Screen 上为当前选中匹配项应用高亮样式。

- **rowOffset**：消息在屏幕上的起始行偏移
- **currentIdx**：当前匹配项在 `positions` 数组中的索引
- **返回值**：是否成功应用（索引越界或行超出屏幕时返回 false）

> 源码位置：`src/ink/render-to-screen.ts:212-231`

### `emptyFrame(rows, columns, stylePool, charPool, hyperlinkPool): Frame`

创建空 Frame，Screen 尺寸为 0×0。用于初始化双缓冲中的前/后帧。

> 源码位置：`src/ink/frame.ts:22-34`

### `shouldClearScreen(prevFrame: Frame, frame: Frame): FlickerReason | undefined`

判断是否需要清屏。返回清屏原因或 `undefined`（不需要清屏）。

- **`'resize'`**：视口尺寸发生变化
- **`'offscreen'`**：当前帧或上一帧的 Screen 高度 ≥ 视口高度（内容溢出滚动缓冲区）

> 源码位置：`src/ink/frame.ts:105-124`

## 接口/类型定义

### `Frame`

渲染管线的核心产出物，表示一帧的完整渲染结果。

| 字段 | 类型 | 说明 |
|------|------|------|
| screen | `Screen` | 渲染后的 cell 矩阵 |
| viewport | `Size` | 视口尺寸 `{ width, height }` |
| cursor | `Cursor` | 光标位置 `{ x, y, visible }` |
| scrollHint | `ScrollHint \| null` | DECSTBM 滚动优化提示（仅 alt-screen） |
| scrollDrainPending | `boolean` | 是否有 ScrollBox 需要续帧完成滚动 |

### `RenderOptions`

传给渲染函数的每帧配置。

| 字段 | 类型 | 说明 |
|------|------|------|
| frontFrame | `Frame` | 前缓冲（当前显示帧） |
| backFrame | `Frame` | 后缓冲（待渲染帧） |
| isTTY | `boolean` | 是否为 TTY 终端 |
| terminalWidth | `number` | 终端列数 |
| terminalRows | `number` | 终端行数 |
| altScreen | `boolean` | 是否在 alt-screen 模式 |
| prevFrameContaminated | `boolean` | 上一帧 Screen 是否被污染（选区覆写/resize/强制重绘） |

### `Patch`（联合类型）

终端增量更新的原子操作，共 9 种变体：

| type | 说明 |
|------|------|
| `stdout` | 写入文本内容 |
| `clear` | 清除 N 行 |
| `clearTerminal` | 全屏清除（含 `FlickerReason` 和调试信息） |
| `cursorHide` / `cursorShow` | 光标显隐 |
| `cursorMove` | 光标相对移动 |
| `cursorTo` | 光标移到指定列 |
| `carriageReturn` | 回车 |
| `hyperlink` | 超链接 OSC 序列 |
| `styleStr` | 预序列化的样式转换字符串（从 `StylePool.transition()` 缓存） |

### `FrameEvent`

帧性能事件，包含总耗时、各阶段细分（renderer/diff/optimize/write/yoga/commit）和闪烁记录。

### `MatchPosition`

搜索匹配的位置描述，坐标相对于消息自身的边界框。

| 字段 | 类型 | 说明 |
|------|------|------|
| row | `number` | 行号（0 = 消息顶部） |
| col | `number` | 起始列号 |
| len | `number` | 匹配占据的 cell 数 |

## 边界 Case 与注意事项

- **Alt-screen viewport hack**：alt-screen 下 `viewport.height` 被设为 `terminalRows + 1`，这是为了避免 `shouldClearScreen` 在内容恰好填满 alt-screen 时误判为溢出。此 `+1` 是刻意的，不是 bug

- **Alt-screen cursor 钳制**：光标 y 坐标被限制在 `Math.min(screen.height, terminalRows) - 1`，防止 log-update 的光标恢复逻辑在最后一行发出 LF，导致 alt buffer 顶部内容被滚走

- **prevFrame 污染的三种来源**：(1) 选区覆写——`ink.tsx` 在渲染后修改 Screen buffer 以显示反色选区；(2) alt-screen 进入/resize——Screen 被重置为空白；(3) `forceRedraw()`——Screen 被重置为 0×0。这三种情况下 blit 会复制到脏数据

- **绝对定位节点移除**：移除 `position: absolute` 的节点会使 prevScreen 失效，因为该节点可能覆盖了非兄弟子树的区域。普通文档流节点的移除不受影响

- **searchRender 的 LegacyRoot 选择**：使用 `LegacyRoot` 而非 `ConcurrentRoot`，因为后者的 `flushSyncWork` 调度积压会跨 root 泄漏。对于逐条消息按需渲染的场景影响极小（~0.0003ms/call），但如果一次渲染 8000 条消息则会变成病态

- **scanPositions 的宽字符处理**：通过 `codeUnitToCell` 映射正确处理 emoji（surrogate pair）和特殊 Unicode 小写转换，确保 `indexOf` 返回的 code unit 偏移能准确映射回 cell 坐标

- **两层搜索高亮**：`applySearchHighlight`（扫描层）对所有可见匹配应用反色，`applyPositionedHighlight`（定位层）对当前匹配应用黄色+粗体+下划线。两层叠加时反色操作是幂等的，不会产生视觉问题