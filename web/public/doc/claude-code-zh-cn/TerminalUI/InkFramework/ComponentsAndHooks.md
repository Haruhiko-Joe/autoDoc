# 基础 UI 原语组件与框架级 React Hooks

## 概述与职责

本模块是 Ink 终端渲染框架的**基础构建层**，提供 18 个核心 UI 组件和 12 个框架级 React Hooks。它位于 `TerminalUI > InkFramework` 层级中，是所有上层业务组件（UIComponents，144 个）和业务 Hooks（80+ 个）的底层依赖。

在整体架构中：
- **上级模块**：InkFramework（深度定制的 Ink 终端渲染框架）
- **兄弟模块**：UIComponents（业务组件库）、Hooks（业务 Hooks）、Screens（REPL 主屏幕）、StateAndContext（全局状态）、Keybindings（快捷键系统）、InteractionModes（Vim/语音等）
- **角色**：提供终端 UI 的"HTML 元素 + 浏览器 API"等价物——布局容器、文本渲染、滚动、输入监听、焦点管理、动画定时器等

## 组件总览

### 核心布局组件

| 组件 | 文件 | 职责 |
|------|------|------|
| `App` | `components/App.tsx` | 根组件，管理 stdin/stdout、raw mode、按键解析、鼠标追踪、进程挂起/恢复 |
| `Box` | `components/Box.tsx` | Flexbox 容器，等价于 `<div style="display:flex">`，支持点击/焦点/键盘事件 |
| `Text` | `components/Text.tsx` | 文本渲染，支持颜色、粗体、斜体、下划线、文本截断/换行 |
| `ScrollBox` | `components/ScrollBox.tsx` | 可滚动容器，带命令式 API（scrollTo/scrollBy/scrollToBottom）和虚拟视口裁剪 |
| `Spacer` | `components/Spacer.tsx` | 弹性空白填充（`flexGrow: 1`） |
| `Newline` | `components/Newline.tsx` | 插入换行符，需在 `<Text>` 内使用 |

### 交互组件

| 组件 | 文件 | 职责 |
|------|------|------|
| `Button` | `components/Button.tsx` | 无样式按钮，支持 Enter/Space/点击激活，render prop 暴露 focused/hovered/active 状态 |
| `Link` | `components/Link.tsx` | 超链接，支持终端 hyperlink 的自动降级（不支持时显示纯文本） |
| `AlternateScreen` | `components/AlternateScreen.tsx` | 全屏模式容器，进入备用屏幕缓冲区，可选开启 SGR 鼠标追踪 |
| `NoSelect` | `components/NoSelect.tsx` | 标记内容为不可选中（用于行号、diff 前缀等 gutter 区域） |
| `RawAnsi` | `components/RawAnsi.tsx` | 高性能 ANSI 直出组件，跳过 React→Yoga→序列化的完整管线 |
| `ErrorOverview` | `components/ErrorOverview.tsx` | 错误边界展示组件 |

### Context 提供者

| Context | 文件 | 职责 |
|---------|------|------|
| `AppContext` | `components/AppContext.ts` | 暴露 `exit()` 方法，供子组件手动退出应用 |
| `StdinContext` | `components/StdinContext.ts` | 暴露 stdin 流、`setRawMode()`、事件发射器、终端查询器 |
| `ClockContext` | `components/ClockContext.tsx` | 共享时钟，所有动画/定时器统一调度，终端失焦时自动降频 |
| `TerminalSizeContext` | `components/TerminalSizeContext.tsx` | 终端尺寸（columns × rows） |
| `TerminalFocusContext` | `components/TerminalFocusContext.tsx` | 终端焦点状态（通过 DECSET 1004 报告） |
| `CursorDeclarationContext` | `components/CursorDeclarationContext.ts` | 声明原生光标位置（IME 输入和无障碍追踪） |

## 关键流程

### 1. App 组件初始化与输入处理管线

`App` 是一个 `PureComponent`（class 组件），是整个 Ink 渲染树的根。它的 `render()` 方法按以下层级嵌套 Context Provider：

```
TerminalSizeContext → AppContext → StdinContext → TerminalFocusProvider → ClockProvider → CursorDeclarationContext
```

> 源码位置：`src/ink/components/App.tsx:154-179`

**输入处理流程**：

1. **启用 raw mode** 时（`handleSetRawMode(true)`），注册 stdin 的 `readable` 事件监听器，同时启用括号粘贴模式（EBP）、终端焦点报告（EFE）、以及扩展按键报告（Kitty keyboard + modifyOtherKeys）
2. **stdin 数据到达**（`handleReadable`）时，检测是否存在长时间间隔（>5s，用于检测 tmux 重连等），然后循环读取所有 chunk
3. 每个 chunk 通过 `processInput()` 进入 `parseMultipleKeypresses` 状态机解析，产出 `ParsedKey[]`
4. 所有解析出的按键在**单次 `discreteUpdates`** 调用中批量处理（避免大量粘贴时的 "Maximum update depth exceeded" 错误）
5. 每个按键分发到 `EventEmitter`（legacy 路径，供 `useInput` 消费）和 DOM 键盘事件系统
6. 鼠标事件处理双击/三击检测（`MULTI_CLICK_TIMEOUT_MS = 500ms`）、拖选、hover

> 源码位置：`src/ink/components/App.tsx:209-368`

### 2. ScrollBox 滚动机制

ScrollBox 是一个带命令式 API 的可滚动容器，**绕过 React 状态更新**来实现高性能滚动：

1. `scrollTo`/`scrollBy` 直接修改 DOM 节点的 `scrollTop` 属性
2. 调用 `markDirty()` 标记节点脏，然后通过 `scheduleRenderFrom()` 触发 Ink 渲染器的节流渲染
3. 渲染器在输出时读取节点的 `scrollTop`，只渲染视口内可见的子节点（视口裁剪）
4. `stickyScroll` 模式下，内容增长时自动保持滚动到底部

关键 API：
- `scrollTo(y)` / `scrollBy(dy)` — 绝对/相对滚动
- `scrollToElement(el, offset)` — 延迟到渲染时读取位置，避免异步渲染导致的位置过时
- `scrollToBottom()` — 滚动到底部并启用 sticky 模式
- `isSticky()` — 是否固定在底部
- `setClampBounds(min, max)` — 配合虚拟滚动限制滚动范围

> 源码位置：`src/ink/components/ScrollBox.tsx:10-62`（Handle 接口定义）

### 3. 共享时钟与动画调度

`ClockContext` 提供一个全局共享时钟，所有动画和定时器通过它统一调度，而非各自创建 `setInterval`：

1. `createClock(tickIntervalMs)` 创建时钟实例，内部维护单个 `setInterval`
2. 订阅者通过 `subscribe(onChange, keepAlive)` 注册。`keepAlive=true` 的订阅者（如 Spinner）驱动时钟运行
3. 当没有 `keepAlive` 订阅者时，时钟停止（不浪费 CPU）
4. 终端失焦时，`ClockProvider` 将 tick 间隔从 `FRAME_INTERVAL_MS` 翻倍到 `BLURRED_TICK_INTERVAL_MS`

> 源码位置：`src/ink/components/ClockContext.tsx:10-68`

`useAnimationFrame` 利用此时钟：
- 通过 `useTerminalViewport` 检测元素是否在视口内
- 不可见时暂停动画（`keepAlive=false`），可见时驱动时钟（`keepAlive=true`）

> 源码位置：`src/ink/hooks/use-animation-frame.ts:30-57`

### 4. useInput 输入监听

`useInput` 是框架级输入处理 Hook，流程如下：

1. 通过 `useStdin()` 获取 `setRawMode` 和 `internal_eventEmitter`
2. 在 `useLayoutEffect`（非 useEffect）中**同步**启用 raw mode——避免渲染后到 effect 执行之间的空窗期
3. 注册 EventEmitter 的 `input` 事件监听器，使用 `useEventCallback` 保持引用稳定
4. 回调接收 `(input, key, event)` 三个参数，其中 `key` 包含修饰键信息（ctrl、shift、meta 等）
5. 支持 `isActive` 选项控制监听开关，且监听器不会因 active 切换而改变注册顺序（保持 `stopImmediatePropagation` 语义）

> 源码位置：`src/ink/hooks/use-input.ts:42-92`

## 函数签名与参数说明

### 组件 Props

#### `Box` Props

继承全部 `Styles`（Yoga Flexbox 属性）并扩展：

| 属性 | 类型 | 说明 |
|------|------|------|
| `ref` | `Ref<DOMElement>` | DOM 元素引用 |
| `tabIndex` | `number` | Tab 导航顺序，`-1` 仅编程式聚焦 |
| `autoFocus` | `boolean` | 挂载时自动聚焦 |
| `onClick` | `(event: ClickEvent) => void` | 点击事件（仅 AlternateScreen 内有效） |
| `onFocus` / `onBlur` | `(event: FocusEvent) => void` | 焦点事件（含 Capture 变体） |
| `onKeyDown` | `(event: KeyboardEvent) => void` | 键盘事件（含 Capture 变体） |
| `onMouseEnter` / `onMouseLeave` | `() => void` | 鼠标悬停事件（不冒泡） |

> 源码位置：`src/ink/components/Box.tsx:11-46`

#### `Text` Props

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `color` | `Color` | - | 文本颜色（rgb/hex/ansi） |
| `backgroundColor` | `Color` | - | 背景色 |
| `bold` | `boolean` | - | 粗体（与 dim 互斥） |
| `dim` | `boolean` | - | 暗色（与 bold 互斥） |
| `italic` | `boolean` | - | 斜体 |
| `underline` | `boolean` | - | 下划线 |
| `strikethrough` | `boolean` | - | 删除线 |
| `inverse` | `boolean` | - | 反色 |
| `wrap` | `Styles['textWrap']` | `'wrap'` | 文本换行/截断模式 |

> 源码位置：`src/ink/components/Text.tsx:5-59`

#### `ScrollBox` Props

继承 `Styles`（排除 `textWrap`、`overflow` 相关）：

| 属性 | 类型 | 说明 |
|------|------|------|
| `ref` | `Ref<ScrollBoxHandle>` | 命令式滚动 API 句柄 |
| `stickyScroll` | `boolean` | 内容增长时自动固定到底部 |

> 源码位置：`src/ink/components/ScrollBox.tsx:63-70`

#### `AlternateScreen` Props

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mouseTracking` | `boolean` | `true` | 启用 SGR 鼠标追踪（滚轮+点击/拖拽） |

> 源码位置：`src/ink/components/AlternateScreen.tsx:8-11`

#### `Button` Props

| 属性 | 类型 | 说明 |
|------|------|------|
| `onAction` | `() => void` | 按钮激活回调（Enter/Space/点击） |
| `tabIndex` | `number` | Tab 顺序，默认 `0` |
| `autoFocus` | `boolean` | 挂载时聚焦 |
| `children` | `((state: ButtonState) => ReactNode) \| ReactNode` | render prop，状态含 `focused/hovered/active` |

> 源码位置：`src/ink/components/Button.tsx:15-38`

### Hook 签名

#### `useInput(handler, options?)`

```typescript
type Handler = (input: string, key: Key, event: InputEvent) => void
type Options = { isActive?: boolean }  // 默认 true
```

监听键盘输入。`key` 对象包含 `ctrl`、`shift`、`meta`、`leftArrow`、`rightArrow` 等布尔属性。

> 源码位置：`src/ink/hooks/use-input.ts:42`

#### `useApp()`

```typescript
const { exit } = useApp()
exit(error?: Error)  // 手动退出（卸载）整个 Ink 应用
```

> 源码位置：`src/ink/hooks/use-app.ts:7`

#### `useStdin()`

```typescript
const { stdin, setRawMode, isRawModeSupported, internal_eventEmitter, internal_querier } = useStdin()
```

直接访问 stdin 流和 raw mode 控制。大多数场景应使用 `useInput` 而非直接操作 stdin。

> 源码位置：`src/ink/hooks/use-stdin.ts:7`

#### `useAnimationFrame(intervalMs?)`

```typescript
function useAnimationFrame(intervalMs: number | null = 16):
  [ref: (element: DOMElement | null) => void, time: number]
```

同步动画 Hook。返回的 `ref` 绑定到元素后自动检测视口可见性——不可见时暂停动画。传 `null` 手动暂停。

> 源码位置：`src/ink/hooks/use-animation-frame.ts:30-32`

#### `useInterval(callback, intervalMs)`

```typescript
function useInterval(callback: () => void, intervalMs: number | null): void
```

基于共享时钟的定时器。传 `null` 暂停。与 `usehooks-ts` 的同名 Hook 不同，不会创建独立 `setInterval`。

> 源码位置：`src/ink/hooks/use-animation-frame.ts:43-67`

#### `useTerminalViewport()`

```typescript
function useTerminalViewport():
  [ref: (element: DOMElement | null) => void, entry: { isVisible: boolean }]
```

检测元素是否在终端视口内。遍历 DOM 祖先链计算绝对位置，正确处理 ScrollBox 的 scrollTop 偏移。不触发重新渲染——调用者通过自身的渲染周期读取最新值。

> 源码位置：`src/ink/hooks/use-terminal-viewport.ts:29-96`

#### `useSelection()`

返回全屏文本选择操作集合：`copySelection`、`clearSelection`、`hasSelection`、`shiftAnchor`、`moveFocus`、`captureScrolledRows` 等。仅在 `AlternateScreen`（全屏模式）内有效。

> 源码位置：`src/ink/hooks/use-selection.ts:14-87`

#### `useDeclaredCursor({ line, column, active })`

声明终端原生光标位置。用于 IME 输入框定位和无障碍工具追踪。安全处理兄弟组件焦点转移——通过节点身份检查避免条件竞争。

> 源码位置：`src/ink/hooks/use-declared-cursor.ts:25-73`

#### `useTerminalFocus()`

```typescript
function useTerminalFocus(): boolean  // true = 终端有焦点或状态未知
```

> 源码位置：`src/ink/hooks/use-terminal-focus.ts:13-16`

#### `useTerminalTitle(title)`

```typescript
function useTerminalTitle(title: string | null): void
```

声明式设置终端标签页/窗口标题。自动 strip ANSI、Windows 降级到 `process.title`。传 `null` 不操作。

> 源码位置：`src/ink/hooks/use-terminal-title.ts:17-31`

#### `useTabStatus(kind)`

```typescript
function useTabStatus(kind: 'idle' | 'busy' | 'waiting' | null): void
```

通过 OSC 21337 设置终端标签页状态指示器（彩色圆点 + 状态文字）。不支持的终端静默忽略。

> 源码位置：`src/ink/hooks/use-tab-status.ts:53-72`

#### `useSearchHighlight()`

返回搜索高亮操作集合：`setQuery`（设置搜索词，匹配项反色高亮）、`scanElement`（扫描 DOM 子树获取匹配位置）、`setPositions`（设置当前高亮位置）。

> 源码位置：`src/ink/hooks/use-search-highlight.ts:18-53`

### 辅助工具

#### `measureElement(node: DOMElement): { width, height }`

测量 `<Box>` 元素的 Yoga 计算尺寸。

> 源码位置：`src/ink/measure-element.ts:18-21`

#### `useTerminalNotification()`

返回终端通知操作集合，支持多终端：

| 方法 | 终端 | 说明 |
|------|------|------|
| `notifyITerm2` | iTerm2 | OSC 序列通知 |
| `notifyKitty` | Kitty | 带 ID 的结构化通知 |
| `notifyGhostty` | Ghostty | 标题+消息通知 |
| `notifyBell` | 所有 | BEL 字符（tmux 下触发 bell-action） |
| `progress` | ConEmu/Ghostty/iTerm2 | 进度条报告（OSC 9;4） |

> 源码位置：`src/ink/useTerminalNotification.ts:25-126`

## 接口/类型定义

### `CursorDeclaration`

```typescript
type CursorDeclaration = {
  relativeX: number      // 节点内的显示列位置
  relativeY: number      // 节点内的行号
  node: DOMElement       // 提供绝对坐标原点的 ink-box 元素
}
```

> 源码位置：`src/ink/components/CursorDeclarationContext.ts:4-11`

### `TerminalSize`

```typescript
type TerminalSize = { columns: number; rows: number }
```

> 源码位置：`src/ink/components/TerminalSizeContext.tsx:2-5`

### `Clock`

```typescript
type Clock = {
  subscribe: (onChange: () => void, keepAlive: boolean) => () => void
  now: () => number
  setTickInterval: (ms: number) => void
}
```

> 源码位置：`src/ink/components/ClockContext.tsx:5-9`

### `ScrollBoxHandle`

命令式滚动 API，包含 `scrollTo`、`scrollBy`、`scrollToElement`、`scrollToBottom`、`getScrollTop`、`getScrollHeight`、`getViewportHeight`、`isSticky`、`subscribe`、`setClampBounds` 等方法。

> 源码位置：`src/ink/components/ScrollBox.tsx:10-62`

## 边界 Case 与注意事项

- **bold 与 dim 互斥**：`Text` 组件的 `bold` 和 `dim` 属性通过 TypeScript 联合类型强制互斥——终端不支持同时显示粗体和暗色
- **AlternateScreen 的 useInsertionEffect**：使用 `useInsertionEffect`（而非 `useLayoutEffect`）进入备用屏幕，确保 ENTER_ALT_SCREEN 序列在 Ink 的第一帧渲染之前到达终端——否则会在主屏幕写入一帧垃圾数据
- **ScrollBox 绕过 React**：`scrollTo`/`scrollBy` 直接修改 DOM 属性并触发 Ink 渲染，不经过 React 状态更新——避免每个滚轮事件触发 reconciler 开销
- **stdin 恢复检测**：App 组件跟踪 stdin 最后活跃时间，>5 秒间隔后的首个输入触发终端模式重置——处理 tmux detach→attach、SSH 重连、笔记本唤醒等场景
- **鼠标事件仅在 AlternateScreen 内有效**：Box 的 `onClick`、`onMouseEnter`/`onMouseLeave` 仅在全屏模式（启用鼠标追踪）下生效
- **无障碍模式**：当 `CLAUDE_CODE_ACCESSIBILITY` 环境变量为真时，App 不隐藏原生光标，供屏幕放大镜和其他辅助工具使用
- **RawAnsi 性能优化**：跳过 React→Yoga→序列化完整管线，对已有 ANSI 输出（如 ColorDiff NAPI 模块的 diff）直接写入——在长转录场景下是渲染的主要性能瓶颈优化
- **useInput 监听器顺序稳定**：通过 `useEventCallback` 保持 EventEmitter 监听器引用不变，`isActive` 切换不会改变注册顺序——这对 `stopImmediatePropagation` 的语义正确性至关重要