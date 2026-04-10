# REPL 核心桥接与控制流 Hooks

## 概述与职责

本模块包含 12 个 React 自定义 Hooks/组件，构成 **TerminalUI → CoreEngine** 的核心桥接层。它们共同负责：

- **会话桥接**：将本地 REPL 与远程 claude.ai 会话双向同步（`useReplBridge`）
- **工具权限判断**：在工具执行前完成权限检查、用户确认、分类器自动审批（`useCanUseTool`）
- **请求中断控制**：处理 Escape/Ctrl+C 中断正在进行的请求或清空命令队列（`CancelRequestHandler`）
- **命令队列与顺序执行**：排队用户输入和系统通知，按优先级顺序执行（`useCommandQueue` + `useQueueProcessor`）
- **快捷键响应**：注册全局快捷键（转录模式、Todo 切换等）和命令级快捷键（`useGlobalKeybindings` + `useCommandKeybindings`）
- **退出手势**：双击 Ctrl+C/Ctrl+D 退出应用（`useExitOnCtrlCD`）
- **辅助功能**：模型状态追踪、延迟消息注入、日志记录

在架构层级中，本模块位于 **TerminalUI > Hooks** 下，是 Screens（REPL.tsx）与 CoreEngine 之间的"胶水层"——REPL 屏幕通过这些 Hooks 驱动查询引擎处理用户输入，同时将引擎的流式响应反馈到 UI。同级模块包括 InkFramework（底层渲染）、UIComponents（业务组件）、Screens（屏幕组装）、StateAndContext（全局状态）、Keybindings（快捷键系统）等。

---

## 关键流程

### 1. 远程桥接生命周期（useReplBridge）

`useReplBridge` 是本模块最大的 Hook（722 行），管理与 claude.ai 远程会话的完整生命周期：

1. **初始化**：监听 `AppState.replBridgeEnabled`，启用时动态导入 `initReplBridge`，传入当前消息作为初始上下文（`src/hooks/useReplBridge.tsx:95-481`）
2. **等待前次清理**：如有进行中的 teardown，先 `await teardownPromiseRef.current` 避免新旧 bridge 的注册/注销竞态（`src/hooks/useReplBridge.tsx:139-144`）
3. **状态同步**：通过 `handleStateChange` 回调将 bridge 状态（ready/connected/reconnecting/failed）映射到 AppState（`src/hooks/useReplBridge.tsx:224-365`）
4. **入站消息注入**：远程用户消息通过 `handleInboundMessage` → `enqueue()` 注入 REPL 命令队列（`src/hooks/useReplBridge.tsx:180-221`）
5. **出站消息转发**：第二个 `useEffect` 监听 `messages` 变化，增量写入新的 user/assistant 消息到 bridge（`src/hooks/useReplBridge.tsx:685-713`）
6. **权限桥接**：构建 `BridgePermissionCallbacks` 对象，允许远程端参与工具权限审批（`src/hooks/useReplBridge.tsx:540-582`）
7. **清理**：effect cleanup 中调用 `handle.teardown()` 并重置所有 AppState 字段（`src/hooks/useReplBridge.tsx:650-679`）

**失败保护机制**：连续失败达到 `MAX_CONSECUTIVE_INIT_FAILURES`（3 次）后，session 内不再重试。单次失败后 `BRIDGE_FAILURE_DISMISS_MS`（10 秒）自动禁用 bridge。

### 2. 工具权限判断流程（useCanUseTool）

`useCanUseTool` 返回一个 `CanUseToolFn`，在每次工具调用前执行：

1. 调用 `hasPermissionsToUseTool()` 获取初步判断（allow/deny/ask）
2. **allow 路径**：直接放行，记录分类器审批信息（如 auto-mode classifier）（`src/hooks/useCanUseTool.tsx:39-53`）
3. **deny 路径**：记录拒绝日志，对 auto-mode 拒绝显示通知（`src/hooks/useCanUseTool.tsx:66-92`）
4. **ask 路径**：依次尝试三种处理方式：
   - `handleCoordinatorPermission`：自动化检查（awaiting automated checks before dialog）（`src/hooks/useCanUseTool.tsx:96-109`）
   - `handleSwarmWorkerPermission`：Swarm 工作节点的权限委托（`src/hooks/useCanUseTool.tsx:113-125`）
   - Bash 分类器快速路径：对 Bash 命令尝试投机分类器匹配（2 秒超时），高置信度匹配直接放行（`src/hooks/useCanUseTool.tsx:126-158`）
   - `handleInteractivePermission`：最终回退到交互式用户确认弹窗（`src/hooks/useCanUseTool.tsx:160-168`）

整个流程中，每一步都通过 `ctx.resolveIfAborted(resolve)` 检查请求是否已被中断。

### 3. 请求中断控制（CancelRequestHandler）

`CancelRequestHandler` 是一个渲染 null 的组件，注册三个快捷键处理器：

- **`chat:cancel`（Escape）**：优先中断活跃请求（`abortSignal.abort()`），其次弹出队列命令（`src/hooks/useCancelRequest.ts:97-116`）
- **`app:interrupt`（Ctrl+C）**：在 teammate 视图中先杀死所有 agent 再退出视图，然后执行 cancel（`src/hooks/useCancelRequest.ts:200-215`）
- **`chat:killAgents`（Ctrl+X Ctrl+K）**：双击确认模式——第一次显示确认提示，3 秒内第二次实际杀死所有后台 agent（`src/hooks/useCancelRequest.ts:225-266`）

**激活条件守卫**：当其他 UI 上下文（转录模式、历史搜索、帮助、Overlay、Vim INSERT 模式等）活跃时，Escape 处理器自动让位。

### 4. 命令队列与顺序执行

**`useCommandQueue`**（`src/hooks/useCommandQueue.ts`）：通过 `useSyncExternalStore` 订阅模块级命令队列存储，返回只读命令数组。队列变更时自动触发 React 重渲染。

**`useQueueProcessor`**（`src/hooks/useQueueProcessor.ts`）：监听三个条件的交集来触发命令处理：
1. 查询未活跃（`queryGuard` 通过 `useSyncExternalStore` 响应式订阅）
2. 队列非空
3. 无活跃的本地 JSX UI

满足条件时调用 `processQueueIfReady()`。队列按优先级处理：`now` > `next`（用户输入）> `later`（任务通知）。执行链 `executeQueuedInput → handlePromptSubmit → executeUserInput → queryGuard.reserve()` 同步完成，确保不会重复处理。

### 5. 全局快捷键注册

**`GlobalKeybindingHandlers`**（`src/hooks/useGlobalKeybindings.tsx`）注册以下全局快捷键：

| 快捷键 | Action | 行为 |
|--------|--------|------|
| Ctrl+T | `app:toggleTodos` | 循环切换视图：none → tasks → teammates → none |
| Ctrl+O | `app:toggleTranscript` | 切换 prompt ↔ transcript 模式 |
| Ctrl+Shift+B | `app:toggleBrief` | 切换 brief-only 视图（需 KAIROS 特性门控） |
| Meta+J | `app:toggleTerminal` | 切换内置终端面板（需 TERMINAL_PANEL 特性门控） |
| Ctrl+L | `app:redraw` | 清屏并强制全量重绘 |
| Ctrl+E | `transcript:toggleShowAll` | 转录模式下显示/隐藏全部消息 |
| Escape | `transcript:exit` | 退出转录模式 |

**`CommandKeybindingHandlers`**（`src/hooks/useCommandKeybindings.tsx`）从用户快捷键配置中提取所有 `command:*` 类型的 action，为每个 action 注册 handler，触发时将对应的斜杠命令（如 `command:commit` → `/commit`）提交到 `onSubmit`。快捷键触发的命令是"即时"的——不清空用户当前输入文本。

---

## 函数签名与参数说明

### `useReplBridge(messages, setMessages, abortControllerRef, commands, mainLoopModel)`

主桥接 Hook，管理与远程 claude.ai 的双向同步。

| 参数 | 类型 | 说明 |
|------|------|------|
| `messages` | `Message[]` | 当前对话消息列表 |
| `setMessages` | `SetStateAction<Message[]>` | 更新消息列表 |
| `abortControllerRef` | `RefObject<AbortController \| null>` | 当前请求的中断控制器 |
| `commands` | `readonly Command[]` | 已注册的命令列表 |
| `mainLoopModel` | `string` | 当前使用的模型名称 |

**返回值**：`{ sendBridgeResult: () => void }` — 通知 bridge 当前请求已完成

> 源码位置：`src/hooks/useReplBridge.tsx:53-55`

### `useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext)`

返回 `CanUseToolFn` — 一个异步函数，判断给定工具是否有权执行。

**`CanUseToolFn` 签名**：
```typescript
(tool: ToolType, input: Input, toolUseContext: ToolUseContext, 
 assistantMessage: AssistantMessage, toolUseID: string, 
 forceDecision?: PermissionDecision<Input>) => Promise<PermissionDecision<Input>>
```

> 源码位置：`src/hooks/useCanUseTool.tsx:27-28`

### `CancelRequestHandler(props: CancelRequestHandlerProps)`

渲染 null 的组件，注册取消/中断/杀死 agent 快捷键。

| Props 字段 | 说明 |
|------------|------|
| `onCancel` | 取消回调 |
| `onAgentsKilled` | agent 被杀死后的回调 |
| `abortSignal` | 当前请求的 AbortSignal |
| `popCommandFromQueue` | 从队列弹出命令 |
| `screen` | 当前屏幕状态 |
| `vimMode` | Vim 模式状态 |
| `streamMode` | 当前 Spinner 模式 |

> 源码位置：`src/hooks/useCancelRequest.ts:40-57`

### `useMainLoopModel(): ModelName`

返回当前解析后的模型名称，响应 session 级覆盖、AppState 变更和 GrowthBook 刷新。优先级：`mainLoopModelForSession` > `mainLoopModel` > 默认模型设置。

> 源码位置：`src/hooks/useMainLoopModel.ts:13-34`

### `useDeferredHookMessages(pendingHookMessages, setMessages): () => Promise<void>`

管理延迟的 SessionStart hook 消息。REPL 启动时不阻塞等待 hook 执行（~500ms），而是异步注入。返回的回调供 `onSubmit` 在首次 API 请求前调用，确保模型总能看到 hook 上下文。

> 源码位置：`src/hooks/useDeferredHookMessages.ts:12-46`

### `useLogMessages(messages, ignore?)`

将消息增量记录到转录文件。使用 `lastRecordedLengthRef` 追踪已记录位置，避免 O(n) 重复扫描。支持增量追加、压缩后全量重写、同头缩减等场景。

> 源码位置：`src/hooks/useLogMessages.ts:19-119`

### `useExitOnCtrlCD(useKeybindingsHook, onInterrupt?, onExit?, isActive?): ExitState`

注册 Ctrl+C 和 Ctrl+D 退出手势。使用基于时间的双击确认机制：第一次按键显示提示，窗口期内第二次按键执行退出。不使用 chord 系统是因为需要第一次 Ctrl+C 同时触发中断。

> 源码位置：`src/hooks/useExitOnCtrlCD.ts:45-95`

### `useExitOnCtrlCDWithKeybindings(onExit?, onInterrupt?, isActive?): ExitState`

`useExitOnCtrlCD` 的便利封装，自动注入 `useKeybindings`，避免循环导入。

> 源码位置：`src/hooks/useExitOnCtrlCDWithKeybindings.ts:18-24`

---

## 接口/类型定义

### `ExitState`

```typescript
type ExitState = {
  pending: boolean          // 是否处于等待第二次按键的状态
  keyName: 'Ctrl-C' | 'Ctrl-D' | null  // 哪个键触发了退出
}
```

> 源码位置：`src/hooks/useExitOnCtrlCD.ts:6-9`

### `CanUseToolFn<Input>`

工具权限判断函数的类型签名，泛型 `Input` 默认为 `Record<string, unknown>`。

> 源码位置：`src/hooks/useCanUseTool.tsx:27`

### `CancelRequestHandlerProps`

取消请求处理器的属性类型，包含 abort 信号、各种 UI 状态标志和回调函数。

> 源码位置：`src/hooks/useCancelRequest.ts:40-57`

---

## 配置项与默认值

| 常量 | 值 | 文件 | 说明 |
|------|----|------|------|
| `BRIDGE_FAILURE_DISMISS_MS` | 10,000 ms | `useReplBridge.tsx:29` | bridge 失败后自动禁用的等待时间 |
| `MAX_CONSECUTIVE_INIT_FAILURES` | 3 | `useReplBridge.tsx:40` | 连续初始化失败的最大次数，超过后 session 内不再重试 |
| `KILL_AGENTS_CONFIRM_WINDOW_MS` | 3,000 ms | `useCancelRequest.ts:38` | 双击确认杀死 agent 的时间窗口 |

**特性门控**：
- `BRIDGE_MODE`：控制 `useReplBridge` 中所有 bridge 相关逻辑的编译时开关
- `TRANSCRIPT_CLASSIFIER` / `BASH_CLASSIFIER`：控制 `useCanUseTool` 中分类器相关路径
- `KAIROS` / `KAIROS_BRIEF`：控制 brief 视图和 assistant 模式
- `TERMINAL_PANEL`：控制内置终端面板快捷键

---

## 边界 Case 与注意事项

- **Bridge 竞态防护**：`useReplBridge` 在重新初始化前会等待前次 teardown 完成（`teardownPromiseRef`），防止注册/注销请求在服务端竞态（`src/hooks/useReplBridge.tsx:139-144`）
- **消息压缩感知**：出站消息转发和日志记录都处理了消息数组压缩（长度突然缩短）的场景——`useReplBridge` 通过 clamp index，`useLogMessages` 通过检测首条消息 UUID 变化
- **Escape 优先级链**：`CancelRequestHandler` 有复杂的激活条件守卫——当转录模式、历史搜索、帮助、Overlay、Vim INSERT 模式等上下文活跃时，Escape 让位给对应的处理器
- **Ctrl+C 共享问题**：`app:interrupt` 绑定在主线程空闲时必须保持非活跃状态，否则会抢占复制选择和双击退出的按键事件（`src/hooks/useCancelRequest.ts:158-162`）
- **GrowthBook 刷新**：`useMainLoopModel` 订阅 GrowthBook 刷新信号强制重渲染，确保模型别名解析与 `/model` 显示一致（`src/hooks/useMainLoopModel.ts:22-26`）
- **队列处理原子性**：`useQueueProcessor` 的执行链同步完成 `reserve()` 调用，确保 React 下一次 effect 运行时 `isQueryActive` 已为 true，避免重复出队
- **Chord 按键冲突**：`chat:killAgents` 必须始终活跃（即使逻辑上不需要），因为 Ctrl+X 作为 chord 前缀会被消费，不活跃的 handler 会将 Ctrl+K 泄漏到 readline 的 kill-line（`src/hooks/useCancelRequest.ts:269-273`）