# LocalMainSessionTask — 主会话后台化任务

## 概述与职责

`LocalMainSessionTask` 是 TaskSystem 中专门处理**主会话后台化**的模块。当用户在主会话查询执行过程中按两次 `Ctrl+B` 时，当前正在运行的查询会被"后台化"——查询在后台继续执行，前台 UI 恢复到空闲状态，用户可以发起新的对话。查询完成后，系统会通过 XML 格式的通知告知用户结果。

在整体架构中，该模块属于 **TaskSystem**（多任务与多 Agent 执行框架）。它复用了 `LocalAgentTask` 的状态结构（`LocalAgentTaskState`），通过 `agentType: 'main-session'` 标记区分于常规的子 Agent 任务。核心引擎中的 `query()` 函数被直接复用来驱动后台查询。

> 源码位置：`src/tasks/LocalMainSessionTask.ts`

## 关键流程

### 1. 注册后台任务（registerMainSessionTask）

当用户触发后台化操作时，系统调用 `registerMainSessionTask()` 完成以下步骤：

1. 调用 `generateMainSessionTaskId()` 生成以 `s` 为前缀的 9 位任务 ID（区别于子 Agent 任务的 `a` 前缀），使用 base-36 字母表（`src/tasks/LocalMainSessionTask.ts:75-82`）
2. 调用 `initTaskOutputAsSymlink()` 将任务输出链接到隔离的 transcript 文件，**不使用**主会话的 transcript 路径——这确保 `/clear` 操作不会破坏后台任务的输出（`src/tasks/LocalMainSessionTask.ts:107-110`）
3. 复用已有的 `AbortController`（如果提供了 `existingAbortController`），或创建新的。复用已有控制器确保中止任务能真正中止底层查询（`src/tasks/LocalMainSessionTask.ts:114`）
4. 通过 `registerCleanup()` 注册进程退出时的清理回调
5. 构建 `LocalMainSessionTaskState` 对象，设置 `isBackgrounded: true`、`status: 'running'`
6. 调用 `registerTask()` 将任务注册到全局 `AppState`

### 2. 启动后台查询（startBackgroundSession）

`startBackgroundSession()` 是完整的后台会话启动入口，它：

1. 调用 `registerMainSessionTask()` 注册任务
2. 将当前消息列表写入隔离的 transcript 文件作为初始上下文
3. 创建 `SubagentContext` 并通过 `runWithAgentContext()` 包裹后台执行——这利用 `AsyncLocalStorage` 隔离上下文，确保后台任务的技能调用不会影响前台（`src/tasks/LocalMainSessionTask.ts:368-376`）
4. 在异步循环中调用 `query()` 迭代处理事件流：
   - 每收到 `user`/`assistant`/`system` 类型的事件，追加到消息列表并写入 transcript
   - 对 `assistant` 消息，统计 token 数量和工具调用数量，维护最近 5 条工具活动记录
   - 持续更新 `AppState` 中的 `progress`（tokenCount、toolUseCount、recentActivities）和 `messages`
   - 检测 `abortSignal.aborted` 提前退出，并发送 SDK 终止事件
5. 循环结束后调用 `completeMainSessionTask()` 标记完成

### 3. 任务完成与通知（completeMainSessionTask）

任务完成时（`src/tasks/LocalMainSessionTask.ts:168-218`）：

1. 通过 `updateTaskState()` 将状态设为 `completed` 或 `failed`，记录结束时间
2. 调用 `evictTaskOutput()` 清理磁盘输出
3. **根据 `isBackgrounded` 状态决定通知方式**：
   - 如果仍在后台（`wasBackgrounded = true`）：调用 `enqueueMainSessionNotification()` 生成 XML 通知推送到消息队列
   - 如果已被前台化（用户正在查看）：不发 XML 通知，仅标记 `notified: true` 并通过 `emitTaskTerminatedSdk()` 通知 SDK 消费者

### 4. 前台化任务（foregroundMainSessionTask）

用户可以将后台任务拉回前台查看（`src/tasks/LocalMainSessionTask.ts:270-302`）：

1. 如果之前已有前台化的任务，先将其恢复为后台状态（`isBackgrounded: true`）
2. 将目标任务设为前台（`isBackgrounded: false`）
3. 更新 `AppState.foregroundedTaskId`
4. 返回任务累积的消息列表供 UI 渲染

## 函数签名与参数说明

### `registerMainSessionTask(description, setAppState, mainThreadAgentDefinition?, existingAbortController?)`

注册一个后台化的主会话任务。

| 参数 | 类型 | 说明 |
|------|------|------|
| `description` | `string` | 任务描述 |
| `setAppState` | `SetAppState` | 全局状态更新函数 |
| `mainThreadAgentDefinition` | `AgentDefinition?` | 可选的 Agent 定义（`--agent` 模式时使用） |
| `existingAbortController` | `AbortController?` | 可选的已有中止控制器（后台化正在执行的查询时复用） |

**返回值**：`{ taskId: string; abortSignal: AbortSignal }` — 任务 ID 和用于中止的信号

### `startBackgroundSession({ messages, queryParams, description, setAppState, agentDefinition? })`

启动完整的后台查询会话。

| 参数 | 类型 | 说明 |
|------|------|------|
| `messages` | `Message[]` | 当前对话消息列表（会被拷贝） |
| `queryParams` | `Omit<QueryParams, 'messages'>` | 查询参数（不含 messages） |
| `description` | `string` | 任务描述 |
| `setAppState` | `SetAppState` | 全局状态更新函数 |
| `agentDefinition` | `AgentDefinition?` | 可选的 Agent 定义 |

**返回值**：`string` — 任务 ID

### `completeMainSessionTask(taskId, success, setAppState)`

标记任务完成并发送通知。

| 参数 | 类型 | 说明 |
|------|------|------|
| `taskId` | `string` | 任务 ID |
| `success` | `boolean` | 是否成功完成 |
| `setAppState` | `SetAppState` | 全局状态更新函数 |

### `foregroundMainSessionTask(taskId, setAppState)`

将后台任务拉回前台。返回该任务累积的 `Message[]`，如果任务不存在则返回 `undefined`。

### `isMainSessionTask(task)`

类型守卫函数，判断一个任务是否为主会话后台任务（`type === 'local_agent' && agentType === 'main-session'`）。

## 接口/类型定义

### `LocalMainSessionTaskState`

```typescript
type LocalMainSessionTaskState = LocalAgentTaskState & {
  agentType: 'main-session'
}
```

继承 `LocalAgentTaskState` 的全部字段，通过 `agentType` 字面量区分。关键字段包括：

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentType` | `'main-session'` | 固定标识，区别于普通 Agent 任务 |
| `isBackgrounded` | `boolean` | 是否处于后台运行状态 |
| `progress` | `AgentProgress?` | 运行进度（tokenCount、toolUseCount、recentActivities） |
| `messages` | `Message[]?` | 累积的对话消息 |
| `abortController` | `AbortController?` | 用于中止任务 |
| `pendingMessages` | `string[]` | 排队等待的消息 |
| `retain` | `boolean` | UI 是否持有该任务 |
| `diskLoaded` | `boolean` | 是否已从磁盘加载 transcript |

## 配置项与默认值

### `DEFAULT_MAIN_SESSION_AGENT`

当未指定 Agent 定义时使用的默认配置（`src/tasks/LocalMainSessionTask.ts:62-67`）：

| 字段 | 值 | 说明 |
|------|-----|------|
| `agentType` | `'main-session'` | 标识类型 |
| `whenToUse` | `'Main session query'` | 描述 |
| `source` | `'userSettings'` | 来源标记 |
| `getSystemPrompt` | `() => ''` | 返回空字符串（不注入额外系统提示词） |

### `MAX_RECENT_ACTIVITIES`

值为 `5`，限制 `progress.recentActivities` 数组的最大长度，仅保留最近 5 条工具调用活动用于 UI 展示。

## 边界 Case 与注意事项

- **任务 ID 前缀区分**：主会话任务 ID 以 `s` 开头（session），子 Agent 任务以 `a` 开头。这使得系统各处可以通过 ID 前缀快速区分任务类型。

- **Transcript 隔离**：后台任务使用独立的 transcript 文件路径（通过 `getAgentTranscriptPath` 而非 `getTranscriptPath`）。注释中明确说明：如果在 `/clear` 后写入主会话 transcript 会导致数据损坏（`src/tasks/LocalMainSessionTask.ts:102-106`）。

- **AbortController 复用**：当后台化一个正在执行的查询时，必须传入已有的 `existingAbortController`，否则中止操作无法终止实际的查询。新建的 `AbortController` 仅用于全新启动的后台会话。

- **重复通知防护**：`enqueueMainSessionNotification()` 通过原子性的 check-and-set `notified` 标志防止重复通知（`src/tasks/LocalMainSessionTask.ts:231-243`）。

- **前台化互斥**：`foregroundMainSessionTask()` 会自动将之前被前台化的任务恢复为后台状态，确保同一时间只有一个任务处于前台。

- **`/clear` 安全**：后台任务通过 `AsyncLocalStorage`（`runWithAgentContext`）隔离上下文，`/clear` 操作时可以通过 `clearInvokedSkills(preservedAgentIds)` 选择性保留后台任务的技能状态。

- **完成时的消息裁剪**：任务完成时，`messages` 数组被裁剪为只保留最后一条消息（`src/tasks/LocalMainSessionTask.ts:191`），减少内存占用。

- **XML 通知格式**：完成通知使用 `TASK_NOTIFICATION_TAG` 包裹，内含 `TASK_ID_TAG`、`TOOL_USE_ID_TAG`（可选）、`OUTPUT_FILE_TAG`、`STATUS_TAG`、`SUMMARY_TAG` 等 XML 标签，通过 `enqueuePendingNotification` 推送到消息队列。