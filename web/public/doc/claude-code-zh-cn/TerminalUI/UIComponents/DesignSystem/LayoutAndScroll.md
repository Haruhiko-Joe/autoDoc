# 布局管理与滚动控制（LayoutAndScroll）

## 概述与职责

本模块是终端 UI 层（TerminalUI → UIComponents → DesignSystem）中的布局与滚动基础设施，由三个文件组成：

- **FullscreenLayout.tsx**：REPL 主界面的全屏布局容器，负责内容区域分割、ScrollBox 管理、模态面板叠加、"N 条新消息"提示胶囊（pill）和粘性提示头（sticky prompt header）
- **ScrollKeybindingHandler.tsx**：滚动行为的核心控制器，处理键盘滚动（Page Up/Down、Home/End）、鼠标滚轮加速（含原生终端和 xterm.js 两套算法）、文本选择与拖拽滚动、以及模态翻页器（less/tmux 风格的 ctrl+u/d/b/f、g/G）
- **OffscreenFreeze.tsx**：性能优化组件，在子组件滚出终端可视区域后冻结渲染，避免定时更新（spinner、计时器）引发全屏重绘

这三个组件协同工作：`FullscreenLayout` 定义布局结构并持有 `ScrollBox` 引用，`ScrollKeybindingHandler` 监听用户输入驱动滚动，`OffscreenFreeze` 包裹消息行以避免已滚出内容的无效渲染。

## 关键流程

### 全屏布局渲染流程（FullscreenLayout）

1. 检测 `isFullscreenEnvEnabled()`，在全屏模式和传统模式间切换渲染路径（`src/components/FullscreenLayout.tsx:338`）
2. **全屏模式**下构建三层布局：
   - **顶部**：可选的 `StickyPromptHeader`——当用户向上滚动时，固定显示当前对话轮次的用户提示（1 行高，点击可跳回原位）
   - **中间**：`ScrollBox`（flexGrow=1，stickyScroll=true）包裹消息内容 + overlay（权限请求等），支持粘性滚动（新内容自动跟随）
   - **底部**：固定区域包含 `SuggestionsOverlay`（补全建议）、`DialogOverlay`（对话框），以及 `bottom` 插槽（spinner、prompt、权限面板），限制最大高度 50%，内容溢出时隐藏
3. 如有 `modal` 内容，渲染绝对定位的模态面板覆盖在 ScrollBox 之上，顶部保留 `MODAL_TRANSCRIPT_PEEK`（2 行）对话上下文
4. "N 条新消息"胶囊（`NewMessagesPill`）通过 `useSyncExternalStore` 直接订阅 ScrollBox 的滚动位置，与 `dividerYRef` 比较判断可见性——整个过程不触发 REPL 层 re-render
5. **非全屏模式**下简单顺序渲染所有内容，依赖终端自身 scrollback

### 未读消息分割线追踪（useUnseenDivider）

1. 用户首次向上滚动时（`onScrollAway`），快照当前消息数量和 scrollHeight 作为分割线位置（`src/components/FullscreenLayout.tsx:125-146`）
2. 后续滚动不会重新快照（只在首次 scroll-away 时触发）
3. `dividerYRef`（scrollHeight 快照）供 `FullscreenLayout` 的 `pillVisible` 订阅使用——viewport 底部超过此位置时胶囊消失
4. 用户提交消息或滚动到底部时调用 `onRepin`，清除分割线
5. `shiftDivider` 处理无限向上滚动时消息前插导致的索引和高度偏移

### 滚轮加速算法（ScrollKeybindingHandler）

系统维护两套独立的滚轮加速算法，根据终端类型自动切换（`src/components/ScrollKeybindingHandler.tsx:176-297`）：

**原生终端路径（iTerm2、Ghostty 等）**：
1. 硬窗口线性加速——40ms 内连续事件递增 multiplier（步进 0.3，上限 6）
2. **编码器弹跳检测**：物理滚轮的光学编码器会产生虚假反向信号（测量 28% 事件率）。通过延迟方向翻转（`pendingFlip`）等待下一事件确认——翻转后立即翻回则为弹跳（激活 wheelMode），否则为真实反向
3. wheelMode 激活后使用指数衰减曲线（halflife=150ms），更高的步进（15）和上限（15），直到检测到设备切换（空闲 >1500ms 或触控板突发 ≥5 事件/5ms）

**xterm.js 路径（VS Code/Cursor 集成终端）**：
1. 指数衰减曲线：momentum = 0.5^(gap/150ms)，携带分数余量（`frac`）保证平均吞吐量正确
2. 低延迟突发（<5ms）按 1 行/事件处理
3. 根据事件间隔动态调整上限：慢事件 cap=3（精确），快事件 cap=6（吞吐）
4. 空闲 >500ms 或方向反转时重置为 mult=2

环境变量 `CLAUDE_CODE_SCROLL_SPEED` 可调整基准速度（默认 1，范围 (0, 20]）。

### 键盘滚动与文本选择协同

1. `useKeybindings` 注册 `scroll:pageUp/Down`、`scroll:lineUp/Down`、`scroll:top/bottom` 等快捷键（`src/components/ScrollKeybindingHandler.tsx:447-513`）
2. 页面跳转（PageUp/Down）使用 `jumpBy` → `scrollTo`（同步写入 scrollTop），滚轮使用 `scrollBy`（异步 pendingDelta 累积）
3. 跳转前调用 `translateSelectionForJump` 同步平移选区坐标，保持选中内容不变（模拟原生终端行为）
4. 滚轮滚动因 pendingDelta 异步特性无法同步平移选区，直接清除选中
5. 拖拽选择超出视口边缘时，`useDragToScroll` 以 50ms 间隔自动滚动（2 行/tick），并通过 `captureScrolledRows` + `shiftAnchor` 维护选区正确性

### 模态翻页器（Modal Pager）

在 transcript 模式（无输入框竞争字符时）下启用（`isModal=true`），提供 less/tmux 风格按键：

| 按键 | 动作 |
|------|------|
| `↑` / `↓` | 上/下滚动 1 行 |
| `ctrl+u` / `ctrl+d` | 上/下半页 |
| `ctrl+b` / `ctrl+f` | 上/下整页 |
| `g` / `G` | 跳到顶部/底部 |
| `ctrl+n` / `ctrl+p` | emacs 风格上/下 1 行 |
| `Home` / `End` | 顶部/底部 |

### 离屏冻结机制（OffscreenFreeze）

1. 使用 `useTerminalViewport` hook 检测组件是否在终端可视区域内（`src/components/OffscreenFreeze.tsx:31-33`）
2. 可见时正常更新 `cached.current = children`
3. 不可见时返回缓存的 ReactElement 引用——React reconciler 发现引用相同，跳过整个子树的 diff
4. 在虚拟列表（`InVirtualListContext`）中禁用冻结，因为 ScrollBox 内部裁剪不涉及终端 scrollback
5. 使用 `'use no memo'` 显式退出 React Compiler 的自动 memoization，因为组件的冻结机制依赖于每次渲染都读取 `cached.current`

## 函数签名与参数说明

### `FullscreenLayout(props: Props): ReactNode`

REPL 主布局组件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `scrollable` | `ReactNode` | 可滚动内容（消息、工具输出） |
| `bottom` | `ReactNode` | 固定在底部的内容（spinner、prompt、权限面板） |
| `overlay` | `ReactNode` | ScrollBox 内尾部内容（权限请求展示） |
| `bottomFloat` | `ReactNode` | 绝对定位在 ScrollBox 右下角的浮动内容（语音气泡） |
| `modal` | `ReactNode` | 模态面板内容（斜杠命令对话框） |
| `modalScrollRef` | `RefObject<ScrollBoxHandle>` | 模态面板内 ScrollBox 引用 |
| `scrollRef` | `RefObject<ScrollBoxHandle>` | 主滚动区域引用 |
| `dividerYRef` | `RefObject<number>` | 未读分割线的 Y 坐标（scrollHeight 快照） |
| `hidePill` | `boolean` | 强制隐藏胶囊（如查看子 Agent 任务时） |
| `hideSticky` | `boolean` | 强制隐藏粘性提示头 |
| `newMessageCount` | `number` | 胶囊显示的新消息计数（0 时显示"Jump to bottom"） |
| `onPillClick` | `() => void` | 点击胶囊的回调 |

> 源码位置：`src/components/FullscreenLayout.tsx:31-67`

### `useUnseenDivider(messageCount: number)`

追踪未读消息分割线位置的 Hook，返回 `{ dividerIndex, dividerYRef, onScrollAway, onRepin, jumpToNew, shiftDivider }`。

> 源码位置：`src/components/FullscreenLayout.tsx:86-190`

### `ScrollKeybindingHandler(props: Props): null`

滚动键盘处理组件（不渲染 DOM）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `scrollRef` | `RefObject<ScrollBoxHandle>` | 滚动容器引用 |
| `isActive` | `boolean` | 是否激活快捷键监听 |
| `onScroll` | `(sticky, handle) => void` | 滚动后回调，通知粘性状态和滚动句柄 |
| `isModal` | `boolean` | 启用模态翻页键（仅 transcript 模式安全） |

> 源码位置：`src/components/ScrollKeybindingHandler.tsx:359-623`

### `computeWheelStep(state: WheelAccelState, dir: 1 | -1, now: number): number`

计算单次滚轮事件应滚动的行数，原地修改加速状态。返回 0 时表示方向翻转被延迟等待弹跳检测。

> 源码位置：`src/components/ScrollKeybindingHandler.tsx:176-297`

### `OffscreenFreeze({ children }: Props): ReactNode`

包裹子组件，在滚出视口后冻结渲染。

> 源码位置：`src/components/OffscreenFreeze.tsx:23-43`

## 类型定义

### `WheelAccelState`

滚轮加速状态对象，贯穿整个滚动会话。

| 字段 | 类型 | 说明 |
|------|------|------|
| `time` | `number` | 上次事件时间戳 |
| `mult` | `number` | 当前速度乘数 |
| `dir` | `0 \| 1 \| -1` | 当前滚动方向 |
| `xtermJs` | `boolean` | 是否使用 xterm.js 衰减曲线 |
| `frac` | `number` | 分数余量（xterm.js 路径） |
| `base` | `number` | 基准行数/事件（CLAUDE_CODE_SCROLL_SPEED） |
| `pendingFlip` | `boolean` | 是否有延迟的方向翻转待确认 |
| `wheelMode` | `boolean` | 鼠标滚轮模式（弹跳确认后激活） |
| `burstCount` | `number` | 连续 <5ms 事件计数（触控板检测） |

> 源码位置：`src/components/ScrollKeybindingHandler.tsx:142-170`

### `ModalPagerAction`

模态翻页动作类型：`'lineUp' | 'lineDown' | 'halfPageUp' | 'halfPageDown' | 'fullPageUp' | 'fullPageDown' | 'top' | 'bottom'`

> 源码位置：`src/components/ScrollKeybindingHandler.tsx:883`

### `UnseenDivider`

未读分割线数据：`{ firstUnseenUuid: string, count: number }`

> 源码位置：`src/components/FullscreenLayout.tsx:224-227`

## 配置项与默认值

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `CLAUDE_CODE_SCROLL_SPEED` | `1` | 滚轮基准速度（范围 (0, 20]），部分终端预乘滚轮事件时保持 1，单事件/notch 的终端可设 3 |
| `CLAUDE_CODE_NO_FLICKER` | 内部 `1` / 外部 `0` | 控制全屏模式启用（`isFullscreenEnvEnabled()`） |
| `MODAL_TRANSCRIPT_PEEK` | `2` | 模态面板上方保留的对话上下文行数 |
| `AUTOSCROLL_LINES` | `2` | 拖拽自动滚动每 tick 行数 |
| `AUTOSCROLL_INTERVAL_MS` | `50` | 拖拽自动滚动间隔 |
| `AUTOSCROLL_MAX_TICKS` | `200`（10 秒） | 防止释放事件丢失导致无限滚动的上限 |

## 边界 Case 与注意事项

- **滚轮编码器弹跳**：廉价光学编码器在快速滚动时产生约 28% 的虚假反向信号。系统通过延迟+确认机制区分弹跳和真实反向，误判代价仅为 1 行延迟（`src/components/ScrollKeybindingHandler.tsx:51-82`）
- **设备切换检测**：wheelMode 通过空闲超时（1500ms）和触控板突发检测（≥5 事件 <5ms）自动脱离，避免鼠标加速泄漏到触控板
- **pendingDelta 一致性**：scrollBy 累积的 pendingDelta 在 scrollTop 之外独立存在，所有边界判断（是否到底、是否显示 pill）必须同时考虑 `scrollTop + pendingDelta`，否则会出现胶囊不消失、sticky 不恢复等 bug
- **选区跨边界问题**：拖拽滚动时通过 `captureScrolledRows` 在滚动前保存即将离开视口的行内容，反向拖拽时需清除累积器避免文本重复
- **React Compiler 兼容**：`OffscreenFreeze` 和 `useUnseenDivider` 中的 ref 写入模式需要退出自动 memoization，否则冻结机制失效
- **非全屏降级**：非全屏模式下 `FullscreenLayout` 退化为简单 Fragment，所有全屏特性（pill、sticky header、modal overlay）均不可用
- **释放事件丢失**：鼠标在终端窗口外释放时，部分终端不发送释放事件，导致 `isDragging` 卡住。`AUTOSCROLL_MAX_TICKS`（200 次 = 10 秒）作为安全上限

## 关键代码片段

**全屏布局核心结构**（`src/components/FullscreenLayout.tsx:338-445`）：
```tsx
if (isFullscreenEnvEnabled()) {
  return (
    <PromptOverlayProvider>
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {stickyPromptHeader}
        <ScrollBox ref={scrollRef} flexGrow={1} stickyScroll={true}>
          <ScrollChromeContext value={chromeCtx}>{scrollable}</ScrollChromeContext>
          {overlay}
        </ScrollBox>
        {newMessagesPill}
        {bottomFloat}
      </Box>
      <Box flexDirection="column" flexShrink={0} maxHeight="50%">
        <SuggestionsOverlay />
        <DialogOverlay />
        <Box overflowY="hidden">{bottom}</Box>
      </Box>
      {modalPane}
    </PromptOverlayProvider>
  );
}
```

**Pill 可见性的零 re-render 订阅**（`src/components/FullscreenLayout.tsx:305-329`）：
```tsx
const pillVisible = useSyncExternalStore(
  listener => scrollRef?.current?.subscribe(listener) ?? noop,
  () => {
    const s = scrollRef?.current;
    const dividerY = dividerYRef?.current;
    if (!s || dividerY == null) return false;
    return s.getScrollTop() + s.getPendingDelta() + s.getViewportHeight() < dividerY;
  }
);
```

**离屏冻结核心**（`src/components/OffscreenFreeze.tsx:23-43`）：
```tsx
export function OffscreenFreeze({ children }: Props): React.ReactNode {
  'use no memo';
  const inVirtualList = useContext(InVirtualListContext);
  const [ref, { isVisible }] = useTerminalViewport();
  const cached = useRef(children);
  if (isVisible || inVirtualList) {
    cached.current = children;
  }
  return <Box ref={ref}>{cached.current}</Box>;
}
```