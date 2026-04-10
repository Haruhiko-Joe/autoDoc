# UI 通用工具 Hooks

## 概述与职责

UIUtilities 是 TerminalUI → Hooks 模块下的一组通用 React 自定义 Hooks 和工具函数，为终端 UI 提供**时间与动画**、**布局**、**状态监控**三大类基础能力。这些 Hooks 不涉及具体业务逻辑，而是为上层 UI 组件（如 REPL 主屏幕、消息列表、输入框等）提供可复用的底层行为支撑。

在整个 TerminalUI 架构中，UIUtilities 位于 Hooks 子模块，依赖 InkFramework 提供的底层原语（`useAnimationFrame`、`useTerminalFocus`、`TerminalSizeContext` 等），并被 UIComponents 和 Screens 广泛消费。同级的其他 Hooks 模块包括输入处理（useTextInput）、历史导航、IDE 集成、远程会话等专项 Hooks。

---

## 时间与动画类 Hooks

### `useBlink` — 光标闪烁动画

基于 Ink 的 `useAnimationFrame` 实现同步闪烁效果。所有实例共享同一个动画时钟，因此多个闪烁元素保持同步。当终端失焦时暂停动画以节省资源。

**函数签名**

```ts
function useBlink(
  enabled: boolean,
  intervalMs?: number  // 默认 600ms
): [ref: (element: DOMElement | null) => void, isVisible: boolean]
```

- `ref`：附加到需要闪烁的元素上，用于跟踪元素是否在屏幕内
- `isVisible`：当前闪烁周期内是否可见（`true`=显示，`false`=隐藏）

**核心逻辑**：通过 `Math.floor(time / intervalMs) % 2 === 0` 从动画时钟推导闪烁状态，保证所有调用者同步。当 `enabled=false` 或终端未聚焦时，始终返回 `isVisible=true`（即不闪烁、常亮）。

> 源码位置：`src/hooks/useBlink.ts:22-34`

---

### `useElapsedTime` — 经过时间格式化

追踪从 `startTime` 到当前的时间差，返回格式化的持续时间字符串（如 `"1m 23s"`）。

**函数签名**

```ts
function useElapsedTime(
  startTime: number,      // Unix 时间戳 (ms)
  isRunning: boolean,     // 是否持续更新
  ms?: number,            // 更新频率，默认 1000ms
  pausedMs?: number,      // 需扣除的暂停时长
  endTime?: number        // 冻结时间点（用于已完成的任务）
): string
```

**关键设计**：使用 `useSyncExternalStore` + `setInterval` 实现高效更新，避免不必要的重渲染。`endTime` 参数解决"已完成任务仍在计时"的问题——如果不传此参数，一个 2 分钟的任务在完成 30 分钟后会显示 "32m"。

> 源码位置：`src/hooks/useElapsedTime.ts:17-37`

---

### `useMinDisplayTime` — 最小展示时长保证

确保每个值在屏幕上至少停留 `minMs` 毫秒后才被替换，防止快速切换的进度文字闪烁到无法阅读。

**函数签名**

```ts
function useMinDisplayTime<T>(value: T, minMs: number): T
```

**与 debounce/throttle 的区别**：debounce 等待安静期、throttle 限制频率，而 `useMinDisplayTime` 保证**每个值**都获得足够的展示时间。如果值变化时距上次更新未满 `minMs`，会延迟 `setTimeout(minMs - elapsed)` 后再切换。

> 源码位置：`src/hooks/useMinDisplayTime.ts:10-35`

---

### `useTimeout` — 简易超时标记

在指定延迟后将布尔状态翻转为 `true`。

**函数签名**

```ts
function useTimeout(delay: number, resetTrigger?: number): boolean
```

`resetTrigger` 变化时重置计时器。返回值表示延迟是否已经过去。

> 源码位置：`src/hooks/useTimeout.ts:3-14`

---

### `useNotifyAfterTimeout` — 空闲桌面通知

当用户一段时间未与终端交互时，发送桌面通知（如 "Claude 已完成响应"）。

**函数签名**

```ts
function useNotifyAfterTimeout(message: string, notificationType: string): void
```

**通知逻辑**：
1. Hook 挂载时立即重置交互时间戳（`updateLastInteractionTime(true)`），避免长耗时请求完成后立即弹出通知
2. 每隔 6 秒（`DEFAULT_INTERACTION_THRESHOLD_MS`）检查用户是否有近期交互
3. 若超过 6 秒无交互，通过 `sendNotification` 发送桌面通知，同时触发终端通知（bell/urgency hint）
4. 通知只发一次（`hasNotified` 标记）

**注意**：用户交互跟踪由 `App.tsx` 的 `processKeysInBatch` 集中处理，避免与 stdin 主 listener 竞争导致输入字符丢失。

> 源码位置：`src/hooks/useNotifyAfterTimeout.ts:38-65`

---

### `useAfterFirstRender` — 首次渲染后执行

在首次渲染完成后执行特定逻辑。当前仅用于**启动性能测量**：当环境变量 `USER_TYPE=ant` 且 `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER=true` 时，输出启动耗时并退出进程。这是 Anthropic 内部用于测量冷启动性能的工具。

```ts
function useAfterFirstRender(): void
```

> 源码位置：`src/hooks/useAfterFirstRender.ts:4-17`

---

## 布局类 Hooks

### `useTerminalSize` — 终端尺寸监听

从 `TerminalSizeContext` 获取当前终端的行列数。必须在 Ink App 组件树内使用，否则抛出异常。

**函数签名**

```ts
function useTerminalSize(): TerminalSize
// TerminalSize = { columns: number, rows: number }
```

> 源码位置：`src/hooks/useTerminalSize.ts:7-15`

---

### `useVirtualScroll` — 虚拟滚动（大列表性能优化）

这是本模块中最复杂的 Hook（721 行），为 ScrollBox 内的长列表提供 React 级别的虚拟化。解决的核心问题：Ink 的 ScrollBox 虽然在渲染层做了视口裁剪，但所有 React fiber 和 Yoga 布局节点仍会被创建——在 1000 条消息的会话中，这意味着 ~250MB 的内存占用。

**函数签名**

```ts
function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  columns: number  // 终端列数，列变化时触发高度缩放
): VirtualScrollResult
```

**返回值 `VirtualScrollResult`**

| 字段 | 类型 | 说明 |
|------|------|------|
| `range` | `[start, end)` | 当前应渲染的半开区间 |
| `topSpacer` | `number` | 首个渲染项之前的占位高度（行数） |
| `bottomSpacer` | `number` | 末尾渲染项之后的占位高度（行数） |
| `measureRef` | `(key) => ref` | 回调 ref 工厂，附加到每项的根 Box 上采集高度 |
| `spacerRef` | `RefObject` | 附加到 topSpacer Box，用于读取列表在 ScrollBox 中的起始坐标 |
| `offsets` | `ArrayLike<number>` | 每项的累计 y 偏移，`offsets[n] = totalHeight` |
| `getItemTop` | `(index) => number` | 读取指定项的 Yoga computedTop |
| `getItemElement` | `(index) => DOMElement` | 获取已挂载项的 DOM 元素 |
| `getItemHeight` | `(index) => number?` | 已缓存的 Yoga 高度 |
| `scrollToIndex` | `(i) => void` | 滚动到指定索引 |

#### 关键流程 Walkthrough

**1. 高度估算与缓存**

未测量的项使用 `DEFAULT_ESTIMATE = 3` 行作为估计高度。项挂载后，通过 `useLayoutEffect` 读取 Yoga 的 `getComputedHeight()` 并缓存到 `heightCache`（`src/hooks/useVirtualScroll.ts:619-645`）。偏移量数组 `offsets` 使用 `Float64Array` 存储，通过版本号 `offsetVersionRef` 惰性重建，避免每次渲染都重新分配数组。

**2. 滚动事件量化**

使用 `useSyncExternalStore` 订阅 ScrollBox 的滚动事件，但对 `scrollTop` 做 40 行（`SCROLL_QUANTUM = OVERSCAN_ROWS >> 1`）的量化：只有累积滚动超过 40 行才触发 React 重渲染。视觉滚动不受影响，因为 ScrollBox 自身的 `forceRender` 逐帧更新。

> 源码位置：`src/hooks/useVirtualScroll.ts:228-244`

**3. 范围计算策略**

三种模式（`src/hooks/useVirtualScroll.ts:317-479`）：

- **冻结模式**（`frozenRange`）：终端列数变化后冻结 2 帧，复用变化前的范围，避免高度缩放导致的挂载/卸载抖动
- **冷启动**（`viewportH=0`）：ScrollBox 未完成首次布局前，渲染尾部 30 项（`COLD_START_COUNT`）
- **Sticky 模式**（在底部）：从尾部向前回溯，直到覆盖 `viewportH + OVERSCAN_ROWS`（80 行过扫描）
- **自由滚动模式**：二分搜索 `offsets` 定位起始项（`src/hooks/useVirtualScroll.ts:402-411`），然后向后扩展直到覆盖 `viewportH + 2*OVERSCAN_ROWS`。使用 `PESSIMISTIC_HEIGHT = 1` 计算覆盖率，宁可多挂载也不留空白

**4. 滑动窗口限流（Slide Cap）**

快速滚动时（速度超过 2 倍视口高度），每次 commit 最多新增 `SLIDE_STEP = 25` 项，避免一次性挂载 ~190 项导致的 ~290ms 阻塞。通过 `setClampBounds` 将视口钳制在已挂载范围的边缘，用户看到的是平滑追赶而非空白。

> 源码位置：`src/hooks/useVirtualScroll.ts:465-477`

**5. React 时间切片**

使用 `useDeferredValue` 延迟范围扩张（新增挂载），让 React 先以旧范围完成低成本渲染，再在后台 commit 中处理新项。范围收缩（卸载）不延迟。Sticky 模式和向下滚动时跳过延迟，确保尾部内容即时可见。

> 源码位置：`src/hooks/useVirtualScroll.ts:503-528`

**6. 终端宽度变化处理**

列数变化时不清空 `heightCache`，而是按 `oldCols/newCols` 比例缩放已有高度。清空会导致所有项回退到 `PESSIMISTIC_HEIGHT=1`，触发一次性挂载 ~190 项。缩放后的估计值在下一帧被真实 Yoga 高度覆盖。

> 源码位置：`src/hooks/useVirtualScroll.ts:193-202`

#### 关键常量

| 常量 | 值 | 说明 |
|------|------|------|
| `DEFAULT_ESTIMATE` | 3 | 未测量项的估计行高（偏低以避免空白） |
| `OVERSCAN_ROWS` | 80 | 视口上下各多渲染 80 行 |
| `COLD_START_COUNT` | 30 | ScrollBox 未布局前渲染的尾部项数 |
| `SCROLL_QUANTUM` | 40 | scrollTop 量化步长（行） |
| `PESSIMISTIC_HEIGHT` | 1 | 覆盖率计算时未测量项的最坏高度 |
| `MAX_MOUNTED_ITEMS` | 300 | 单次最大挂载项数上限 |
| `SLIDE_STEP` | 25 | 快速滚动时每 commit 最大新增项数 |

---

## 状态监控类 Hooks

### `useMemoryUsage` — 内存使用监控

每 10 秒轮询 `process.memoryUsage().heapUsed`，当内存超过阈值时返回状态信息，否则返回 `null` 以避免不必要的重渲染。

**函数签名**

```ts
function useMemoryUsage(): MemoryUsageInfo | null

type MemoryUsageInfo = { heapUsed: number; status: MemoryUsageStatus }
type MemoryUsageStatus = 'normal' | 'high' | 'critical'
```

**阈值**：
- `high`：≥ 1.5 GB
- `critical`：≥ 2.5 GB
- `normal`：< 1.5 GB（返回 `null`，99%+ 用户场景）

> 源码位置：`src/hooks/useMemoryUsage.ts:18-39`

---

### `usePrStatus` — PR 状态轮询

每 60 秒调用 `gh` CLI 查询当前分支关联 PR 的 review 状态。

**函数签名**

```ts
function usePrStatus(isLoading: boolean, enabled?: boolean): PrStatusState

type PrStatusState = {
  number: number | null
  url: string | null
  reviewState: PrReviewState | null
  lastUpdated: number
}
```

**智能节流策略**（`src/hooks/usePrStatus.ts:49-87`）：
1. 通过 `getLastInteractionTime()` 检测用户活跃度，空闲超过 60 分钟自动停止轮询
2. 如果某次 `gh` 调用耗时超过 4 秒（`SLOW_GH_THRESHOLD_MS`），永久禁用轮询（`disabledRef`）
3. Effect 依赖 `isLoading` —— 每轮对话开始/结束时重新启动轮询循环
4. 调度下一次轮询时考虑距上次 fetch 的实际时间差，避免 turn 边界产生重复请求

---

### `useTurnDiffs` — 对话轮次文件差异

从消息列表中提取每个对话轮次（用户提问 → 助手响应）的文件修改汇总。

**函数签名**

```ts
function useTurnDiffs(messages: Message[]): TurnDiff[]

type TurnDiff = {
  turnIndex: number
  userPromptPreview: string      // 截断到 30 字符
  timestamp: string
  files: Map<string, TurnFileDiff>
  stats: { filesChanged: number; linesAdded: number; linesRemoved: number }
}
```

**核心逻辑**（`src/hooks/useTurnDiffs.ts:100-213`）：
1. 增量处理：通过 `cache.lastProcessedIndex` 记录已处理位置，只扫描新消息
2. 遇到非 tool_result 的用户消息时开启新 turn
3. 从 tool_result 中提取 `FileEditTool` 和 `FileWriteTool` 的结果，收集 `structuredPatch` hunks
4. 新建文件（`type='create'`）时从 `content` 合成虚拟 hunk
5. 同一文件在同一轮次内可被多次编辑，hunks 追加合并
6. 支持消息回退（`messages.length < lastProcessedIndex` 时重置缓存）
7. 返回结果按时间倒序（最新轮次在前）

---

### `useFileHistorySnapshotInit` — 文件历史快照初始化

在会话恢复时，从日志中还原文件历史状态。只执行一次（`initialized` ref 守护），且仅在 `fileHistoryEnabled()` 为 `true` 时生效。

```ts
function useFileHistorySnapshotInit(
  initialFileHistorySnapshots: FileHistorySnapshot[] | undefined,
  fileHistoryState: FileHistoryState,
  onUpdateState: (newState: FileHistoryState) => void
): void
```

> 源码位置：`src/hooks/useFileHistorySnapshotInit.ts:9-25`

---

### `useAwaySummary` — 离开期间摘要

当终端失焦超过 5 分钟后，自动调用 AI 生成"你离开期间发生了什么"的摘要消息。

**函数签名**

```ts
function useAwaySummary(
  messages: readonly Message[],
  setMessages: SetMessages,
  isLoading: boolean
): void
```

**触发条件**（`src/hooks/useAwaySummary.ts:53-116`）：
1. 功能开关：需要 `feature('AWAY_SUMMARY')` 编译标记和 GrowthBook 特性标记 `tengu_sedge_lantern` 同时启用
2. 终端失焦 ≥ 5 分钟（`BLUR_DELAY_MS`）
3. 当前无进行中的对话轮次（`!isLoading`）
4. 自上一条用户消息以来无已有的 `away_summary`
5. 终端焦点状态为 `unknown`（终端不支持 DECSET 1004）时不执行

**处理 mid-turn 场景**：如果 5 分钟定时器触发时正在加载中，设置 `pendingRef=true`，等 `isLoading` 变为 `false` 后再生成摘要。重新聚焦时取消所有待处理操作。

---

### `useClipboardImageHint` — 剪贴板图片提示

当终端重新获得焦点时，检测系统剪贴板是否包含图片，若有则弹出通知提示用户可以粘贴。

**函数签名**

```ts
function useClipboardImageHint(isFocused: boolean, enabled: boolean): void
```

**防抖与冷却**：
- 焦点变化后 1 秒（`FOCUS_CHECK_DEBOUNCE_MS`）才执行检测，避免快速聚焦/失焦引起的频繁调用
- 同一提示 30 秒内不重复显示（`HINT_COOLDOWN_MS`）
- 仅在 `isFocused` 从 `false` → `true` 的转变时触发

> 源码位置：`src/hooks/useClipboardImageHint.ts:19-77`

---

### `renderPlaceholder` — 占位符渲染

纯函数（非 Hook），为输入框在空值状态下渲染占位符文本和光标。

**函数签名**

```ts
function renderPlaceholder(props: PlaceholderRendererProps): {
  renderedPlaceholder: string | undefined
  showPlaceholder: boolean
}

type PlaceholderRendererProps = {
  placeholder?: string
  value: string
  showCursor?: boolean
  focus?: boolean
  terminalFocus: boolean
  invert?: (text: string) => string    // 默认 chalk.inverse
  hidePlaceholderText?: boolean         // 语音录制时只显示光标
}
```

**渲染逻辑**：
- `hidePlaceholderText=true`（语音录制模式）：只显示反色光标方块，无文字
- 正常模式：placeholder 用 `chalk.dim` 渲染；当输入框和终端都聚焦时，首字符显示为反色光标
- `showPlaceholder`：当 `value` 为空且 `placeholder` 存在时为 `true`

> 源码位置：`src/hooks/renderPlaceholder.ts:13-51`

---

## 边界 Case 与注意事项

- **`useVirtualScroll` 的内存特性**：Ink 的屏幕缓冲区、Yoga WASM 线性内存、JSC 页面保留都是只增不减的。虚拟滚动通过限制同时挂载的 fiber 数量来缓解增长速度，但无法完全回收已使用的内存
- **`useNotifyAfterTimeout` 的交互跟踪**：不在自身内部监听 stdin，而是依赖 `App.tsx` 的集中处理，避免多 listener 竞争导致输入字符丢失
- **`usePrStatus` 的自动禁用**：在 `gh` CLI 响应慢（>4s）的环境下永久停止轮询，避免拖慢整体体验
- **`useVirtualScroll` 的冷启动**：ScrollBox 首次布局前（`viewportH=0`），默认渲染尾部 30 项并假设 sticky 模式，首次 Ink 渲染会将 scrollTop 固定到底部
- **`useAwaySummary` 的特性门控**：需要编译期标记和运行时 GrowthBook 标记双重启用，第三方部署默认关闭