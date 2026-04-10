# InProcessTeammateTask

## 概述与职责

InProcessTeammateTask 是 Swarm 多 Agent 协调模式中 **进程内 teammate** 的任务运行时。它属于 TaskSystem 的一部分，为在同一 Node.js 进程内运行的 teammate 提供统一的生命周期管理接口。

与 `LocalAgentTask`（后台独立 Agent）不同，InProcessTeammateTask 具有以下特点：

1. **同进程隔离**：使用 `AsyncLocalStorage` 在同一 Node.js 进程内隔离运行，无需 fork 子进程
2. **团队身份感知**：每个 teammate 具有 `agentName@teamName` 格式的身份标识
3. **Plan Mode 审批流**：支持 plan mode 下的审批等待机制
4. **空闲/活跃状态切换**：teammate 可以处于 idle（等待分配任务）或 active（处理中）状态
5. **消息队列上限**：UI 展示用的消息数组上限为 50 条，防止内存膨胀

在架构层级中，TaskSystem 是多任务与多 Agent 执行框架，由 ToolSystem 中的 AgentTool 调用创建子任务。InProcessTeammateTask 是 TaskSystem 中专门处理 Swarm 协调模式下 teammate 的实现。

## 关键流程

### 1. Teammate 生命周期

teammate 的生命周期由外部的 `spawnInProcess` 模块发起，InProcessTeammateTask 本身主要管理状态和对外接口：

1. **创建**：Swarm coordinator 调用 spawn 逻辑，初始化 `InProcessTeammateTaskState`，状态设为 `running`，`isIdle: true`
2. **运行**：teammate 处理任务时，`isIdle` 切换为 `false`，消息通过 `appendTeammateMessage()` 追加到会话历史
3. **空闲等待**：任务处理完毕后，teammate 回到 idle 状态，触发 `onIdleCallbacks` 通知 leader
4. **优雅关闭**：通过 `requestTeammateShutdown()` 设置 `shutdownRequested` 标志，teammate 在下一个安全检查点退出
5. **强制终止**：通过 `kill()` 方法调用 `killInProcessTeammate()`，通过 `abortController` 立即终止

### 2. 用户消息注入流程

当用户在终端 UI 中查看某个 teammate 的 transcript 并输入消息时：

1. UI 调用 `injectUserMessageToTeammate(taskId, message, setAppState)`
2. 函数检查 teammate 是否处于终态（completed/killed），如果是则丢弃消息并记录日志
3. 消息被追加到 `pendingUserMessages` 队列，供 teammate 的下一个处理轮次消费
4. 同时通过 `appendCappedMessage()` 追加到 `task.messages`，确保用户在 transcript 中立即看到自己发送的消息

### 3. 消息队列 Cap 机制

`task.messages` 数组的上限由 `TEAMMATE_MESSAGES_UI_CAP = 50` 控制（`types.ts:101`）。

此限制的背景：BQ 分析（2026-03-20）发现在 500+ 轮对话中每个 agent 占用约 20MB RSS，并发 burst 下每个 agent 约 125MB。一个极端会话在 2 分钟内启动了 292 个 agent，内存峰值达 36.8GB。主要成本来自 `task.messages` 保留了一份完整的消息副本。

`appendCappedMessage()` 的策略（`types.ts:108-121`）：
- 数组为空/未定义时，直接返回包含新消息的单元素数组
- 已达上限时，丢弃最旧的消息（`slice` 保留最近 49 条），再追加新消息
- 始终返回新数组，保证 AppState 不可变性

```typescript
// types.ts:108-121
export function appendCappedMessage<T>(
  prev: readonly T[] | undefined,
  item: T,
): T[] {
  if (prev === undefined || prev.length === 0) {
    return [item]
  }
  if (prev.length >= TEAMMATE_MESSAGES_UI_CAP) {
    const next = prev.slice(-(TEAMMATE_MESSAGES_UI_CAP - 1))
    next.push(item)
    return next
  }
  return [...prev, item]
}
```

需要注意的是，`task.messages` 仅用于 UI 的 zoomed transcript 视图展示。完整的对话历史保留在 `inProcessRunner` 的局部 `allMessages` 数组和磁盘上的 agent transcript 文件中。

## 函数签名与参数说明

### `InProcessTeammateTask` (Task 对象)

Task 接口的实现对象，注册在任务框架中（`InProcessTeammateTask.tsx:24-30`）。

| 属性 | 值 | 说明 |
|------|-----|------|
| `name` | `'InProcessTeammateTask'` | 任务名称 |
| `type` | `'in_process_teammate'` | 任务类型标识 |
| `kill(taskId, setAppState)` | async | 委托给 `killInProcessTeammate()` 执行强制终止 |

### `requestTeammateShutdown(taskId: string, setAppState: SetAppState): void`

请求优雅关闭一个 teammate（`InProcessTeammateTask.tsx:35-45`）。

- 仅在 `status === 'running'` 且尚未请求关闭时生效
- 设置 `shutdownRequested: true` 标志，teammate 在下一个安全检查点自行退出

### `appendTeammateMessage(taskId: string, message: Message, setAppState: SetAppState): void`

向 teammate 的会话历史追加一条消息（`InProcessTeammateTask.tsx:51-61`）。

- 仅在 `status === 'running'` 时执行追加
- 使用 `appendCappedMessage()` 保证消息不超过上限

### `injectUserMessageToTeammate(taskId: string, message: string, setAppState: SetAppState): void`

向 teammate 注入用户消息（`InProcessTeammateTask.tsx:68-84`）。

- 允许在 `running` 或 `idle` 状态下注入（只拒绝终态）
- 消息同时追加到 `pendingUserMessages` 和 `task.messages`
- 使用 `createUserMessage()` 将原始字符串包装为 `Message` 对象

### `findTeammateTaskByAgentId(agentId: string, tasks: Record<string, TaskStateBase>): InProcessTeammateTaskState | undefined`

根据 `agentId` 在 AppState 中查找 teammate 任务（`InProcessTeammateTask.tsx:92-108`）。

- **优先返回 `running` 状态的任务**：因为可能存在同一 agentId 的旧 killed 任务和新 running 任务并存的情况
- 如果没有 running 任务，返回第一个匹配的 fallback

### `getAllInProcessTeammateTasks(tasks): InProcessTeammateTaskState[]`

返回 AppState 中所有 InProcessTeammateTask，不区分状态（`InProcessTeammateTask.tsx:113-115`）。

### `getRunningTeammatesSorted(tasks): InProcessTeammateTaskState[]`

返回所有 running 状态的 teammate，按 `agentName` 字母序排序（`InProcessTeammateTask.tsx:123-125`）。

此函数被多个 UI 组件共享——`TeammateSpinnerTree`、`PromptInput` footer 选择器、`useBackgroundTaskNavigation`——它们都需要一致的排序顺序，因为 `selectedIPAgentIndex` 索引映射到该数组。

## 接口/类型定义

### `TeammateIdentity`（`types.ts:13-20`）

Teammate 的身份数据，存储于 `InProcessTeammateTaskState.identity` 中：

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentId` | `string` | 全局唯一 ID，格式为 `"agentName@teamName"` |
| `agentName` | `string` | 短名称，如 `"researcher"` |
| `teamName` | `string` | 所属团队名称 |
| `color` | `string?` | 可选的 UI 展示颜色 |
| `planModeRequired` | `boolean` | 是否需要 plan mode 审批 |
| `parentSessionId` | `string` | Leader 的 session ID |

`TeammateIdentity` 与运行时的 `TeammateContext`（AsyncLocalStorage 中的值）形状相同，但它是纯数据对象用于 AppState 持久化。

### `InProcessTeammateTaskState`（`types.ts:22-76`）

继承 `TaskStateBase`，完整的 teammate 任务状态定义：

**身份与配置**：
- `type: 'in_process_teammate'` — 类型鉴别器
- `identity: TeammateIdentity` — 身份信息
- `prompt: string` — 分配给 teammate 的任务 prompt
- `model?: string` — 可选的模型覆盖
- `selectedAgent?: AgentDefinition` — 可选的 agent 定义（许多 teammate 以通用 agent 运行）
- `permissionMode: PermissionMode` — 独立的权限模式，可通过 Shift+Tab 切换

**运行时控制（不序列化到磁盘）**：
- `abortController?: AbortController` — 终止整个 teammate
- `currentWorkAbortController?: AbortController` — 仅中止当前轮次，不杀死 teammate
- `unregisterCleanup?: () => void` — 清理函数注销回调

**Plan Mode**：
- `awaitingPlanApproval: boolean` — 是否正在等待 plan 审批

**状态与结果**：
- `error?: string` — 错误信息
- `result?: AgentToolResult` — 任务结果，复用 `runAgent()` 的类型
- `progress?: AgentProgress` — 执行进度

**消息与 UI**：
- `messages?: Message[]` — UI zoomed view 用的消息历史（有上限）
- `inProgressToolUseIDs?: Set<string>` — 正在执行的 tool use ID 集合，用于 transcript 动画
- `pendingUserMessages: string[]` — 待投递的用户消息队列
- `spinnerVerb?: string` — UI spinner 动词（跨 re-render 稳定）
- `pastTenseVerb?: string` — 过去时动词

**生命周期**：
- `isIdle: boolean` — 是否处于空闲状态
- `shutdownRequested: boolean` — 是否已请求优雅关闭
- `onIdleCallbacks?: Array<() => void>` — idle 回调，供 leader 免轮询等待

**进度追踪**：
- `lastReportedToolCount: number` — 上次上报的工具调用次数
- `lastReportedTokenCount: number` — 上次上报的 token 数量

### `isInProcessTeammateTask(task): task is InProcessTeammateTaskState`

类型守卫函数（`types.ts:78-87`），通过检查 `task.type === 'in_process_teammate'` 进行类型收窄。

## 边界 Case 与注意事项

- **双层 AbortController**：`abortController` 终止整个 teammate，`currentWorkAbortController` 仅中止当前轮次。前者用于 `kill()`，后者用于中断当前工作但保持 teammate 存活。
- **消息存在两份副本**：`task.messages`（capped UI 副本）和 runner 内部的 `allMessages`（完整副本）。这是有意为之的设计——UI 只需要最近的上下文，但完整历史需要保留用于 agent 推理。
- **agentId 可能重复**：同一个 agentId 可能同时存在 killed 和 running 的任务实例，`findTeammateTaskByAgentId` 优先返回 running 的实例。
- **消息注入不限于 running 状态**：`injectUserMessageToTeammate` 在 idle 状态也接受消息，因为 teammate 可能正在等待输入。只有终态（completed/killed）才会拒绝。
- **排序一致性要求**：`getRunningTeammatesSorted` 的排序顺序被多个 UI 组件依赖，修改排序逻辑时需同步更新所有消费方。