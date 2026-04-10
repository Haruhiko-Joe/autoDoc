# InkOrchestrator — Ink 主类与渲染入口

## 概述与职责

InkOrchestrator 是整个终端 UI 引擎的中枢，位于 `TerminalUI > InkFramework` 层级中。它负责：

- 管理 React fiber root 的完整生命周期（创建、更新、卸载）
- 调度渲染帧——基于 `throttle` + `queueMicrotask` 的 ~60fps 节流渲染
- 驱动**双缓冲渲染循环**（front/back frame swap）
- 协调键盘、鼠标输入分发与文本选择
- 处理 alt-screen 切换、终端 resize、SIGCONT 恢复
- 提供 `render()` / `createRoot()` 公共 API 供上层屏幕挂载
- 管理多实例注册，确保同一 stdout 复用同一 Ink 实例

该模块由 4 个文件组成：`ink.tsx`（1700+ 行核心类）、`root.ts`（公共 API）、`instances.ts`（实例注册表）、`constants.ts`（帧率常量），以及辅助的 `warn.ts`。

上层的 `Screens` 模块（REPL、Doctor 等）通过 `root.ts` 的 `render()` / `createRoot()` 挂载 React 组件树，`UIComponents` 和 `Hooks` 则依赖 Ink 底层提供的渲染循环和事件分发能力。

## 关键流程

### 1. 实例创建与初始化流程

1. 外部调用 `render(node)` 或 `createRoot(options)`（`src/ink/root.ts:76-157`）
2. `render()` 内部先 `await Promise.resolve()` 保持微任务边界，防止首帧同步渲染导致 Static 组件覆盖 scrollback
3. 通过 `getInstance()` 查询 `instances` Map，同一 stdout 复用已有实例（`src/ink/root.ts:172-184`）
4. `new Ink(options)` 初始化（`src/ink/ink.tsx:180-278`）：
   - 创建 `StylePool`、`CharPool`、`HyperlinkPool` 对象池
   - 初始化双缓冲帧（`frontFrame` / `backFrame`），均为空帧
   - 构造 `LogUpdate` 实例用于差分输出
   - 创建节流渲染调度器 `scheduleRender`：`throttle(deferredRender, 16ms)`，其中 `deferredRender` 通过 `queueMicrotask` 延迟到微任务，确保 `useLayoutEffect` 中的 `cursorDeclaration` 不滞后一帧
   - 创建 DOM 根节点 `ink-root`，挂载 `FocusManager`
   - 通过 `reconciler.createContainer()` 创建 React `ConcurrentRoot` fiber 容器
   - 注册 `resize` / `SIGCONT` 事件监听和 `onExit` 进程退出钩子

### 2. 渲染帧循环（双缓冲 + 差分输出）

核心渲染在 `onRender()` 方法中（`src/ink/ink.tsx:420-789`），每帧执行：

1. **交互时间刷新**：调用 `flushInteractionTime()` 批量更新，避免每次按键都调用 `Date.now()`
2. **渲染器执行**：调用 `this.renderer()` 将 React DOM 树渲染为 `Frame`（包含 `Screen` 像素缓冲区、viewport 尺寸、cursor 位置）
3. **选择覆盖层**：在 alt-screen 模式下，应用文本选择高亮（`applySelectionOverlay`）和搜索高亮（`applySearchHighlight` + `applyPositionedHighlight`）
4. **全帧损伤检测**：当布局发生偏移（`didLayoutShift()`）、存在选择/搜索高亮、或前帧被污染时，标记全屏为 damage 区域
5. **差分计算**：`this.log.render(prevFrame, frame)` 生成差分 patch 列表
6. **缓冲区交换**：`backFrame = frontFrame; frontFrame = frame`（经典双缓冲）
7. **优化与输出**：`optimize(diff)` 合并冗余 patch，`writeDiffToTerminal()` 写入终端
8. **原生光标定位**：根据 `cursorDeclaration`（由 `useDeclaredCursor` 设置）计算并输出光标移动序列，支持 IME 预编辑和无障碍跟踪
9. **滚动续帧**：如果 ScrollBox 有待排空的滚动增量，调度 `FRAME_INTERVAL_MS / 4` 的快速续帧
10. **性能指标回调**：通过 `options.onFrame` 上报各阶段耗时（renderer、diff、optimize、write、yoga）

### 3. Alt-Screen 管理

Alt-screen 是全屏模式的基础，由 `<AlternateScreen>` 组件通过 `setAltScreenActive()` 控制（`src/ink/ink.tsx:861-873`）。关键行为：

- **进入**：`resetFramesForAltScreen()` 用 rows×cols 的空白帧替代 0×0 空帧（`src/ink/ink.tsx:984-1009`），避免 log-update 检测到 heightDelta > 0 触发 LF 滚动
- **resize 处理**：同步更新尺寸（不 debounce，避免维度不一致导致双闪），重新 `render()` React 树触发 Yoga 重新布局（`src/ink/ink.tsx:309-346`）
- **SIGCONT 恢复**：`reenterAltScreen()` 重新发送 `ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME`，恢复鼠标跟踪（`src/ink/ink.tsx:964-967`）
- **外部编辑器切换**：`enterAlternateScreen()` / `exitAlternateScreen()` 暂停 Ink、禁用扩展键报告、切换 alt-screen，交还终端控制权（`src/ink/ink.tsx:357-419`）
- **终端模式重置**：`reassertTerminalModes()` 处理 tmux detach/attach、SSH 重连、笔记本睡眠唤醒等场景，重新断言 Kitty 键盘协议和鼠标跟踪（`src/ink/ink.tsx:896-919`）

### 4. 输入分发

- **键盘事件**：`dispatchKeyboardEvent(parsedKey)` 从 `focusManager.activeElement` 开始冒泡分发 `KeyboardEvent`（`src/ink/ink.tsx:1269-1283`）。Tab 键作为默认行为（未被 `preventDefault`）触发焦点循环
- **鼠标点击**：`dispatchClick(col, row)` 通过 hit-test 找到最深命中节点，冒泡 `ClickEvent`（`src/ink/ink.tsx:1260-1264`）
- **鼠标悬停**：`dispatchHover(col, row)` 使用 `hoveredNodes` Set 差分计算进出（`src/ink/ink.tsx:1265-1268`）
- **文本选择**：`handleMultiClick`（双击选词/三击选行）、`handleSelectionDrag`（拖拽扩展选区）、`moveSelectionFocus`（Shift+方向键）

### 5. 卸载与清理

`unmount()` 方法（`src/ink/ink.tsx:1455-1533`）执行同步清理：

1. 最终渲染一帧，输出非 Static 内容
2. 恢复 console 补丁和 stderr 拦截
3. 同步写入终端重置序列（`writeSync` 确保进程退出前完成）：退出 alt-screen、禁用鼠标跟踪、禁用扩展键报告、显示光标等
4. 排空 stdin 缓冲区（`drainStdin`）防止鼠标事件泄漏到 shell
5. 通过 reconciler 清除 React 容器，释放 Yoga 根节点
6. 从 `instances` Map 中删除自身

## 函数签名与参数说明

### `render(node, options?)` — 默认导出

```typescript
async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions
): Promise<Instance>
```

挂载组件并渲染。返回 `Instance` 对象包含 `rerender`、`unmount`、`waitUntilExit`、`cleanup`。

> 源码位置：`src/ink/root.ts:107-121`

### `renderSync(node, options?)`

同步版本的 `render`，跳过微任务边界延迟。

> 源码位置：`src/ink/root.ts:76-105`

### `createRoot(options?)`

```typescript
async function createRoot(options?: RenderOptions): Promise<Root>
```

类似 `react-dom` 的 `createRoot` API——先创建实例，后续调用 `root.render(node)` 挂载。支持同一 root 承载多个顺序屏幕。

> 源码位置：`src/ink/root.ts:129-157`

### `Ink` 类关键方法

| 方法 | 说明 |
|------|------|
| `render(node)` | 将 ReactNode 包裹在 `<App>` 中，通过 `updateContainerSync` 同步更新 fiber 树 |
| `unmount(error?)` | 完整卸载：终端重置、React 容器清空、Yoga 节点释放 |
| `pause()` / `resume()` | 暂停/恢复渲染循环 |
| `repaint()` | 重置双缓冲帧，强制下一帧全量渲染 |
| `forceRedraw()` | 清屏 + 全量重绘（Ctrl+L 行为） |
| `enterAlternateScreen()` / `exitAlternateScreen()` | 外部编辑器切换 |
| `setAltScreenActive(active, mouseTracking?)` | 由 `<AlternateScreen>` 调用，控制全屏模式 |
| `reassertTerminalModes(includeAltScreen?)` | 重新断言终端模式（睡眠唤醒/tmux 恢复） |
| `detachForShutdown()` | 优雅关闭时标记已卸载，防止重复退出 alt-screen |
| `dispatchKeyboardEvent(parsedKey)` | 键盘事件冒泡分发 |
| `dispatchClick(col, row)` | 鼠标点击 hit-test 与事件分发 |
| `copySelection()` / `clearTextSelection()` | 选区复制（OSC 52）与清除 |
| `setSearchHighlight(query)` | 设置搜索高亮查询词 |
| `resetPools()` | 重置字符/超链接对象池防止内存泄漏 |

## 接口/类型定义

### `RenderOptions`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `stdout` | `NodeJS.WriteStream` | `process.stdout` | 输出流 |
| `stdin` | `NodeJS.ReadStream` | `process.stdin` | 输入流 |
| `stderr` | `NodeJS.WriteStream` | `process.stderr` | 错误流 |
| `exitOnCtrlC` | `boolean` | `true` | 是否监听 Ctrl+C 退出 |
| `patchConsole` | `boolean` | `true` | 是否拦截 console 方法 |
| `onFrame` | `(event: FrameEvent) => void` | - | 每帧渲染回调（性能指标） |

> 源码位置：`src/ink/root.ts:8-44`

### `Instance`

```typescript
type Instance = {
  rerender: Ink['render']    // 更新根节点
  unmount: Ink['unmount']    // 手动卸载
  waitUntilExit: Ink['waitUntilExit']  // 等待卸载的 Promise
  cleanup: () => void        // 从 instances Map 中清除
}
```

> 源码位置：`src/ink/root.ts:46-60`

### `Root`

```typescript
type Root = {
  render: (node: ReactNode) => void
  unmount: () => void
  waitUntilExit: () => Promise<void>
}
```

> 源码位置：`src/ink/root.ts:67-71`

### `Options`（Ink 构造参数）

```typescript
type Options = {
  stdout: NodeJS.WriteStream
  stdin: NodeJS.ReadStream
  stderr: NodeJS.WriteStream
  exitOnCtrlC: boolean
  patchConsole: boolean
  waitUntilExit?: () => Promise<void>
  onFrame?: (event: FrameEvent) => void
}
```

> 源码位置：`src/ink/ink.tsx:67-75`

## 配置项与默认值

### `FRAME_INTERVAL_MS`

```typescript
export const FRAME_INTERVAL_MS = 16  // ~60fps
```

渲染节流间隔和动画帧间隔的共享常量。`scheduleRender` 使用此值作为 `throttle` 的等待时间；滚动续帧使用 `FRAME_INTERVAL_MS >> 2`（~4ms）以获得更流畅的滚动体验。

> 源码位置：`src/ink/constants.ts:1-2`

### 对象池重置周期

每 5 分钟自动重置 `CharPool` 和 `HyperlinkPool`（`src/ink/ink.tsx:600-603`），防止长会话中无限增长。迁移 front frame 的 screen ID 保证 diff 正确性。

### instances Map

```typescript
const instances = new Map<NodeJS.WriteStream, Ink>()
```

全局实例注册表，以 stdout 为 key。确保对同一 stdout 的连续 `render()` 调用复用同一 Ink 实例。独立文件存放避免 `render.js` 和 `instance.js` 的循环依赖。

> 源码位置：`src/ink/instances.ts:1-10`

## 边界 Case 与注意事项

### 双缓冲与帧污染

`prevFrameContaminated` 标志控制 blit 安全性。当选择覆盖层、搜索高亮修改了 screen buffer 的 style ID 后，下一帧必须全量 diff（因为 front frame 中的 style 已被覆盖层改变，不能作为 blit 基准）。`forceRedraw()` 和 `resetFramesForAltScreen()` 也会设置此标志。

### Alt-screen 帧初始化

`resetFramesForAltScreen()` 创建 rows×cols 的完整空白帧而非 0×0 空帧。这是为了避免 log-update 检测到 `heightDelta > 0` 时进入 "growing" 路径，该路径会在最后一行输出 CR+LF 导致 alt-screen 滚动，永久偏移虚拟/物理光标 1 行。

### resize 不做 debounce

`handleResize` 是同步的（`src/ink/ink.tsx:309`）。Debounce 会打开一个窗口使 `stdout.columns` 是新值但 `this.terminalColumns` / Yoga 是旧值，导致 log-update 检测到宽度变化后清屏，debounce 触发后再次清屏——双闪。

### ERASE_SCREEN 延迟到 BSU/ESU 块内

Resize 时不立即写 `ERASE_SCREEN`，而是设置 `needsEraseBeforePaint = true`，在下一次 `onRender()` 的 patch 数组头部插入。这样清屏和新帧内容在同一个 BSU/ESU 原子块内完成，避免 ~80ms 的空白闪烁。

### stdin 排空

`drainStdin()` 在退出时排空内核 TTY 缓冲区中残留的鼠标事件（`src/ink/ink.tsx:1664-1718`）。它打开 `/dev/tty` 的 `O_NONBLOCK` fd 读取，因为 Node 的 stdin fd 是 blocking 的。如果 stdin 已处于 cooked 模式（`detachForShutdown` 之后），会短暂切回 raw 模式以绕过行缓冲。

### console/stderr 拦截

`patchConsole()` 将 `console.log/info/debug` 等重定向到 debug 日志，`console.error/warn` 重定向到 `logError`（`src/ink/ink.tsx:1571-1590`）。`patchStderr()` 拦截 `process.stderr.write` 防止第三方库直接写入 stderr 破坏 alt-screen buffer（`src/ink/ink.tsx:1604-1639`）。

### Kitty 键盘协议栈平衡

`reassertTerminalModes()` 在推入新的 Kitty keyboard 层之前先弹出旧层（`DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD`），保持栈深度为 1。否则每次 >5s 空闲间隔都会累积栈条目，退出时单次 pop 无法清空——shell 会残留 CSI u 模式，Ctrl+C/Ctrl+D 变成转义序列泄漏。

## 关键代码片段

### 渲染调度器初始化（微任务 + 节流）

```typescript
const deferredRender = (): void => queueMicrotask(this.onRender);
this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
  leading: true,
  trailing: true
});
```

> 源码位置：`src/ink/ink.tsx:212-216`

### render() — React 树更新

```typescript
render(node: ReactNode): void {
  this.currentNode = node;
  const tree = <App stdin={...} stdout={...} terminalColumns={this.terminalColumns}
    terminalRows={this.terminalRows} selection={this.selection} ...>
    <TerminalWriteProvider value={this.writeRaw}>
      {node}
    </TerminalWriteProvider>
  </App>;
  reconciler.updateContainerSync(tree, this.container, null, noop);
  reconciler.flushSyncWork();
}
```

> 源码位置：`src/ink/ink.tsx:1442-1454`

### 双缓冲帧交换

```typescript
// Swap buffers
this.backFrame = this.frontFrame;
this.frontFrame = frame;
```

> 源码位置：`src/ink/ink.tsx:594-595`