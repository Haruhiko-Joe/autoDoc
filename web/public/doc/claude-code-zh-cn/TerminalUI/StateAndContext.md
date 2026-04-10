# 全局状态管理与 React Context 层

## 概述与职责

StateAndContext 模块是 Claude Code 终端 UI（TerminalUI）的**全局状态管理和跨组件通信基础设施**。它由两个子目录组成：

- **`src/state/`**：基于自研轻量 Store 的全局应用状态管理，类似 Zustand 但更精简。定义了完整的 `AppState` 类型、状态变更监听（副作用同步）、选择器和 Teammate 视图辅助函数。
- **`src/context/`**：提供 9 个独立的 React Context，分别管理消息队列、FPS 指标、邮箱通信、模态框、通知系统、覆盖层、提示覆盖层、统计和语音状态。

在 TerminalUI 架构中，StateAndContext 是所有 UI 组件的数据基座——REPL 主屏幕、144 个 UI 组件、键绑定系统等都通过它读取和修改状态。它与 CoreEngine 之间通过 `AppState` 中的消息、任务、MCP 等字段进行双向数据流。

---

## 关键流程

### 1. Store 创建与状态订阅

整个状态管理的核心是 `src/state/store.ts` 中的 `createStore<T>()` 函数——一个极简的发布-订阅 Store 实现：

1. 内部维护一个 `state` 变量和 `Set<Listener>` 订阅者集合
2. `setState(updater)` 接收一个纯函数 `(prev) => next`，通过 `Object.is` 判断是否变化
3. 状态变化时依次调用可选的 `onChange` 回调和所有 `listener`
4. `subscribe(listener)` 返回取消订阅函数

> 源码位置：`src/state/store.ts:1-34`

```typescript
export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}
```

### 2. AppState 的初始化与 Provider 挂载

`AppStateProvider`（`src/state/AppState.tsx:37-110`）是应用的顶层状态提供者：

1. 调用 `getDefaultAppState()` 创建包含 60+ 字段的初始状态
2. 用 `createStore()` 包装，传入 `onChangeAppState` 作为变更回调
3. 内部自动嵌套 `MailboxProvider` 和 `VoiceProvider`（后者仅在 `VOICE_MODE` feature flag 开启时加载）
4. 通过 `HasAppStateContext` 防止 Provider 嵌套
5. 监听 settings 文件变更，自动应用到 Store

组件通过 `useAppState(selector)` 订阅状态切片——底层使用 React 18 的 `useSyncExternalStore`，只有选中的值变化时才触发重渲染：

```typescript
const verbose = useAppState(s => s.verbose)
const model = useAppState(s => s.mainLoopModel)
```

> 源码位置：`src/state/AppState.tsx:142-163`

### 3. 状态变更的副作用同步（onChangeAppState）

`onChangeAppState`（`src/state/onChangeAppState.ts:43-171`）是 Store 的 `onChange` 回调，负责将 AppState 变更同步到外部系统：

1. **权限模式同步**：当 `toolPermissionContext.mode` 变化时，通知 CCR（Claude Cloud Runtime）和 SDK 状态流。这是所有权限模式变更的统一出口——无论来自 Shift+Tab 切换、ExitPlanMode 对话框还是 REPL bridge
2. **模型设置持久化**：`mainLoopModel` 变化时写入用户 settings 文件，并更新 bootstrap 层的 model override
3. **视图偏好持久化**：`expandedView` 变化时写入全局配置（`showExpandedTodos` / `showSpinnerTree`）
4. **verbose 模式持久化**：同步到全局配置
5. **Settings 变更缓存清理**：当 `settings` 对象变化时清除 API Key、AWS/GCP 凭据缓存，重新应用环境变量

### 4. 输入路由：从用户到正确的 Agent

`src/state/selectors.ts` 中的 `getActiveAgentForInput()` 决定用户输入发往哪里：

1. 检查是否正在查看某个 teammate 的消息流（`viewingAgentTaskId`）
2. 如果是 `InProcessTeammateTask`，返回 `{ type: 'viewed', task }`
3. 如果是 `LocalAgentTask`，返回 `{ type: 'named_agent', task }`
4. 否则返回 `{ type: 'leader' }`，输入由主 Agent 处理

> 源码位置：`src/state/selectors.ts:59-76`

### 5. Teammate 视图切换

`src/state/teammateViewHelpers.ts` 管理多 Agent 场景下的 UI 视图切换：

- `enterTeammateView(taskId)`: 切换到查看某个 Agent 的消息流。设置 `retain: true` 阻止任务被回收，清除 `evictAfter`。如果从另一个 Agent 切换过来，先释放前一个
- `exitTeammateView()`: 返回 leader 视图。释放任务回到 stub 状态，终态任务设置 30 秒宽限期后回收
- `stopOrDismissAgent(taskId)`: 运行中则 abort，已终止则立即标记回收

> 源码位置：`src/state/teammateViewHelpers.ts:46-141`

---

## AppState 类型结构

`AppState`（`src/state/AppStateStore.ts:89-452`）是一个 `DeepImmutable` 包裹的巨型类型，包含以下主要分组：

| 分组 | 关键字段 | 说明 |
|------|----------|------|
| 基础设置 | `settings`, `verbose`, `mainLoopModel`, `fastMode`, `effortValue` | 用户配置和会话设置 |
| 权限与安全 | `toolPermissionContext`, `denialTracking`, `activeOverlays` | 工具执行权限模型 |
| 任务系统 | `tasks`, `foregroundedTaskId`, `viewingAgentTaskId`, `agentNameRegistry` | 多任务/多Agent状态 |
| 远程连接 | `replBridge*` (12 个字段), `remoteSessionUrl`, `remoteConnectionStatus` | Bridge 和远程会话状态 |
| MCP/插件 | `mcp` (clients, tools, commands, resources), `plugins` | MCP 服务器和插件系统 |
| 通知/UI | `notifications`, `elicitation`, `promptSuggestion`, `speculation` | UI 交互状态 |
| 团队协作 | `teamContext`, `inbox`, `workerSandboxPermissions` | Swarm 多 Agent 协作 |
| 功能特性 | `tungstenActiveSession`, `bagelActive`, `computerUseMcpState` | Tmux/浏览器/计算机使用 |

辅助类型：

- **`CompletionBoundary`**：推测执行的完成边界，区分 complete / bash / edit / denied_tool 四种
- **`SpeculationState`**：推测执行状态机（idle → active），包含 abort 控制、消息引用、流水线建议
- **`FooterItem`**：底部栏可展示的 pill 类型（tasks / tmux / bagel / teams / bridge / companion）

---

## React Context 详解

### 1. QueuedMessageContext（消息队列上下文）

**文件**: `src/context/QueuedMessageContext.tsx`

为排队中的消息提供渲染上下文。`QueuedMessageProvider` 包裹每条排队消息，提供 `isQueued`、`isFirst` 和 `paddingWidth` 信息。Brief 模式下 padding 为 0 以避免双重缩进。

- Hook: `useQueuedMessage()` → `QueuedMessageContextValue | undefined`

### 2. FpsMetricsContext（FPS 指标上下文）

**文件**: `src/context/fpsMetrics.tsx`

向组件树注入 FPS 指标获取器函数。`FpsMetricsProvider` 接收 `getFpsMetrics` getter，子组件通过 `useFpsMetrics()` 按需读取帧率数据。

- Hook: `useFpsMetrics()` → `FpsMetricsGetter | undefined`

### 3. MailboxContext（邮箱通信上下文）

**文件**: `src/context/mailbox.tsx`

提供进程内的消息邮箱通信机制。`MailboxProvider` 内部用 `useMemo` 创建单例 `Mailbox` 实例（来自 `utils/mailbox.js`）。`useMailbox()` 在 Provider 外调用会抛出异常。

- Hook: `useMailbox()` → `Mailbox`（必须在 Provider 内）

### 4. ModalContext（模态框上下文）

**文件**: `src/context/modalContext.tsx`

由 `FullscreenLayout` 在渲染 modal slot 时设置。提供模态区域的可用行列数和 scroll ref。用途：

- `Pane` 组件据此跳过全宽分隔线
- `Select` 组件据此限制可见选项数（模态区域比终端小）
- `Tabs` 据此在 tab 切换时重置滚动

导出 Hooks:
- `useIsInsideModal()` → `boolean`
- `useModalOrTerminalSize(fallback)` → `{ rows, columns }`
- `useModalScrollRef()` → `RefObject<ScrollBoxHandle | null> | null`

### 5. NotificationContext（通知系统）

**文件**: `src/context/notifications.tsx`

基于 AppState 的通知队列系统，支持优先级（low / medium / high / immediate）、超时自动消失、通知合并（fold）和互斥失效（invalidates）。

`useNotifications()` 返回：
- `addNotification(notif)`: 添加通知。immediate 优先级直接显示并挤掉当前通知；非 immediate 进入队列
- `removeNotification(key)`: 按 key 移除通知

关键设计：通知支持 `fold` 函数，同 key 的通知可以像 `Array.reduce` 一样合并（例如多个文件保存通知合并为"已保存 N 个文件"）。默认超时 8000ms。

### 6. OverlayContext（覆盖层管理）

**文件**: `src/context/overlayContext.tsx`

解决 Escape 键在有覆盖层时的冲突：当 Select 对话框等覆盖层打开时，`CancelRequestHandler` 不应取消请求。

- `useRegisterOverlay(id, enabled?)`: 组件挂载时自动注册为活跃覆盖层，卸载时自动注销。卸载时还会调用 `invalidatePrevFrame()` 强制全帧重绘防止残影
- `useIsOverlayActive()`: 检查是否有任何覆盖层活跃
- `useIsModalOverlayActive()`: 排除非模态覆盖层（如 autocomplete）后检查

### 7. PromptOverlayContext（提示覆盖层）

**文件**: `src/context/promptOverlayContext.tsx`

解决 `FullscreenLayout` 的 `overflowY:hidden` 裁剪问题——浮动在 prompt 上方的内容（如斜杠命令建议）会被裁剪到 ~1 行。

两个通道：
- `useSetPromptOverlay(data)`: 注册结构化建议数据（`SuggestionItem[]` + 选中索引）
- `useSetPromptOverlayDialog(node)`: 注册任意 React 节点（如 AutoModeOptInDialog）

数据/setter 分离为独立 Context 对，写入者不会因自己的写入而重渲染。`FullscreenLayout` 在裁剪区域外读取并渲染这些内容。

### 8. StatsContext（统计上下文）

**文件**: `src/context/stats.tsx`

内存中的会话指标收集系统，支持四种指标类型：

| 方法 | 类型 | 说明 |
|------|------|------|
| `increment(name, value?)` | Counter | 累加计数器 |
| `set(name, value)` | Gauge | 即时值设置 |
| `observe(name, value)` | Histogram | 采样观测值，使用 Algorithm R 水塘抽样（上限 1024 样本），输出 count/min/max/avg/p50/p95/p99 |
| `add(name, value)` | Set | 去重集合，输出 size |

进程退出时通过 `saveCurrentProjectConfig` 将所有指标持久化到项目配置。

便捷 Hooks: `useCounter(name)`, `useGauge(name)`, `useTimer(name)`

### 9. VoiceContext（语音状态）

**文件**: `src/context/voice.tsx`

管理语音输入的全部 UI 状态。内部使用 `createStore` 而非 React state，实现精细的切片订阅：

```typescript
type VoiceState = {
  voiceState: 'idle' | 'recording' | 'processing'
  voiceError: string | null
  voiceInterimTranscript: string
  voiceAudioLevels: number[]
  voiceWarmingUp: boolean
}
```

- `useVoiceState(selector)`: 通过 `useSyncExternalStore` 订阅切片，仅选中值变化时重渲染
- `useSetVoiceState()`: 获取同步 setter（`VoiceKeybindingHandler` 依赖其同步特性）
- `useGetVoiceState()`: 获取同步 reader，用于事件处理器中读取同 tick 内的最新状态

**注意**：VoiceProvider 仅在 `VOICE_MODE` feature flag 开启时加载（通过 `bun:bundle` 的 `feature()` 实现死代码消除），外部构建版本使用直通组件。

---

## 边界 Case 与注意事项

- **AppState 的不可变性例外**：`tasks` 字段被排除在 `DeepImmutable` 之外，因为 `TaskState` 包含函数类型（如 `abortController`）。`agentNameRegistry` 使用 `Map` 而非普通对象
- **循环依赖回避**：`getDefaultAppState()` 中通过 `require()` 延迟加载 `teammate.js`；`teammateViewHelpers.ts` 内联了 `isLocalAgent` 类型检查而非导入，以打破经过 `BackgroundTasksDialog` 的循环
- **权限模式外部化**：`onChangeAppState` 在通知 CCR 前会将内部模式名（如 bubble、ungated auto）转为外部名，避免泄露内部模式。如果外部名未变化则跳过 CCR 通知
- **Store 的 Object.is 语义**：`useAppState` 的 selector 不应返回新创建的对象（每次都是新引用），否则会导致无限重渲染。应选择 state 中已有的子对象引用
- **Provider 嵌套保护**：`AppStateProvider` 通过 `HasAppStateContext` 检测并阻止重复嵌套
- **覆盖层残影处理**：`useRegisterOverlay` 在卸载时通过 `useLayoutEffect` 同步调用 `invalidatePrevFrame()`，确保在 Ink 的微任务渲染前清除上一帧，防止高覆盖层缩小后的残影