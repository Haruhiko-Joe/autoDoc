# LocalAgentTask — 本地 Agent 子任务运行时

## 概述与职责

`LocalAgentTask` 是 TaskSystem 中负责**本地 Agent 子任务生命周期管理**的核心模块。它为每个子 Agent 提供独立的运行环境：独立的 `AbortController` 用于取消控制、`ProgressTracker` 用于跟踪 token 消耗和工具调用进度、前台/后台切换机制、以及任务完成时的 XML 通知生成。

在系统架构中，`LocalAgentTask` 位于 **TaskSystem** 层内，被 `AgentTool`（ToolSystem 层）调用来创建和管理子 Agent 任务，同时也被 `LocalMainSessionTask` 复用。它与 CoreEngine 的查询引擎配合，实际执行子 Agent 的对话循环。同级模块包括远程 Agent 任务（RemoteAgentTask）和协调器（coordinator）等。

> 源码位置：`src/tasks/LocalAgentTask/LocalAgentTask.tsx`（共 682 行，单文件模块）

## 关键流程

### 1. 子 Agent 注册与启动

子 Agent 有两种注册模式：

**后台模式** — `registerAsyncAgent()`（`LocalAgentTask.tsx:466-515`）：
1. 调用 `initTaskOutputAsSymlink()` 初始化输出文件（符号链接到 agent transcript 路径）
2. 根据是否提供 `parentAbortController`，创建独立的或子级的 `AbortController`（子级会随父级自动 abort，确保子 Agent 随父 Agent 一起终止）
3. 调用 `createTaskStateBase()` 构建任务基础状态，设置 `isBackgrounded: true`
4. 通过 `registerCleanup()` 注册进程退出时的清理回调（自动 kill 该 Agent）
5. 调用 `registerTask()` 将任务写入 `AppState.tasks`

**前台模式** — `registerAgentForeground()`（`LocalAgentTask.tsx:526-614`）：
1. 与后台模式类似地初始化任务状态，但设置 `isBackgrounded: false`
2. 创建一个 `backgroundSignal` Promise，存储其 resolve 函数到 `backgroundSignalResolvers` Map 中
3. 若配置了 `autoBackgroundMs`，启动定时器，超时后自动触发后台切换
4. 返回 `{ taskId, backgroundSignal, cancelAutoBackground }` 供调用方使用

调用方（如 AgentTool）可以 `await backgroundSignal` 来等待用户将任务切换到后台，或者在 Agent 完成前一直阻塞在前台。

### 2. 进度追踪（ProgressTracker）

ProgressTracker 是一个轻量级状态容器，追踪子 Agent 的执行进度：

```
createProgressTracker()  →  updateProgressFromMessage()  →  getProgressUpdate()
```

**Token 计数策略**（`LocalAgentTask.tsx:43-49`）：
- `latestInputTokens`：取**最新值**（Claude API 的 input_tokens 是累积的，包含历史上下文）
- `cumulativeOutputTokens`：**累加**每轮的 output_tokens
- 总 token = latestInputTokens + cumulativeOutputTokens

`updateProgressFromMessage()`（`LocalAgentTask.tsx:68-96`）在每次收到 assistant 消息时调用：
- 更新 token 统计（含 cache 读/写 token）
- 遍历消息中的 `tool_use` 内容块，递增 `toolUseCount`
- 将工具活动（名称、输入、描述、是否搜索/读取操作）推入 `recentActivities` 队列
- 过滤掉 `StructuredOutput`（内部合成工具，不应显示给用户）
- 队列保持最多 5 条记录（`MAX_RECENT_ACTIVITIES`）

### 3. 前台/后台切换

`backgroundAgentTask()`（`LocalAgentTask.tsx:620-652`）：
1. 检查任务是否存在且尚未后台化
2. 将 `isBackgrounded` 设为 `true`
3. 从 `backgroundSignalResolvers` Map 中取出并调用 resolve 函数，令前台等待的 `backgroundSignal` Promise resolve

`unregisterAgentForeground()`（`LocalAgentTask.tsx:657-682`）：
- 当前台 Agent 完成且**未被后台化**时调用
- 清理 `backgroundSignalResolvers` Map
- 从 `AppState.tasks` 中移除任务状态
- 调用 `unregisterCleanup` 取消进程退出回调

### 4. 任务终态处理

三种终态路径：

| 终态 | 函数 | 触发场景 |
|------|------|---------|
| completed | `completeAgentTask()` | Agent 正常完成 |
| failed | `failAgentTask()` | Agent 执行出错 |
| killed | `killAsyncAgent()` | 用户取消或父 Agent abort |

所有终态函数都执行以下操作：
- 检查任务当前是否 `running`（幂等保护）
- 调用 `unregisterCleanup()` 取消清理回调
- 设置 `evictAfter`：若任务被 UI retain，不设截止时间；否则设为 `Date.now() + PANEL_GRACE_MS`
- 清除 `abortController`、`unregisterCleanup`、`selectedAgent` 引用
- 调用 `evictTaskOutput()` 清理磁盘输出

`killAsyncAgent()`（`LocalAgentTask.tsx:281-303`）还会额外调用 `abortController.abort()` 来中断正在运行的查询循环。

`killAllRunningAgentTasks()`（`LocalAgentTask.tsx:309-315`）提供批量终止能力，遍历所有 `local_agent` 类型的运行中任务逐一 kill，供 ESC 取消等场景使用。

### 5. XML 通知生成

`enqueueAgentNotification()`（`LocalAgentTask.tsx:197-262`）在任务结束后生成结构化 XML 通知：

1. **原子去重**：通过 `updateTaskState` 检查并设置 `notified` 标志，防止重复通知
2. **中止投机推理**：调用 `abortSpeculation()` 使缓存的推测响应失效（因后台任务状态已变）
3. **组装 XML**：包含以下标签：
   - `<task-notification>` 根标签
   - `<task-id>`, `<output-file>`, `<status>`, `<summary>`
   - 可选的 `<result>`, `<usage>`, `<tool-use-id>`
   - 可选的 `<worktree>` 段（含 `<worktree-path>` 和 `<worktree-branch>`）
4. 调用 `enqueuePendingNotification()` 以 `task-notification` 模式入队，等待主对话循环消费

### 6. 消息队列（SendMessage 支持）

模块实现了一个简单的 pending message 队列，支持在 Agent 运行过程中通过 `SendMessage` 工具向其注入消息：

- `queuePendingMessage()`（`LocalAgentTask.tsx:162-167`）：将消息追加到 `pendingMessages` 数组
- `drainPendingMessages()`（`LocalAgentTask.tsx:181-192`）：在工具轮次边界清空并返回所有待处理消息
- `appendMessageToLocalAgent()`（`LocalAgentTask.tsx:175-180`）：将消息追加到 `task.messages`，用于 UI 即时展示（与队列独立）

## 函数签名与参数说明

### 核心注册函数

#### `registerAsyncAgent(options): LocalAgentTaskState`

注册一个后台 Agent 子任务。

| 参数 | 类型 | 说明 |
|------|------|------|
| agentId | string | Agent 唯一标识 |
| description | string | Agent 描述（显示名称） |
| prompt | string | 发送给 Agent 的初始 prompt |
| selectedAgent | AgentDefinition | Agent 定义（类型、模型等） |
| setAppState | SetAppState | 全局状态更新函数 |
| parentAbortController? | AbortController | 父级 abort 控制器（子级会跟随 abort） |
| toolUseId? | string | 关联的工具调用 ID |

#### `registerAgentForeground(options): { taskId, backgroundSignal, cancelAutoBackground? }`

注册一个前台 Agent 任务，返回后台切换信号。

额外参数：`autoBackgroundMs?: number` — 自动后台化的超时毫秒数。

### 进度追踪函数

- **`createProgressTracker(): ProgressTracker`** — 创建零值追踪器
- **`updateProgressFromMessage(tracker, message, resolver?, tools?)`** — 从 assistant 消息更新进度
- **`getProgressUpdate(tracker): AgentProgress`** — 生成进度快照
- **`createActivityDescriptionResolver(tools): ActivityDescriptionResolver`** — 创建工具描述解析器
- **`updateAgentProgress(taskId, progress, setAppState)`** — 更新任务状态中的进度（保留已有 summary）
- **`updateAgentSummary(taskId, summary, setAppState)`** — 更新后台摘要，并向 SDK 消费者发出进度事件

### 生命周期函数

- **`backgroundAgentTask(taskId, getAppState, setAppState): boolean`** — 后台化前台任务
- **`unregisterAgentForeground(taskId, setAppState)`** — 注销未后台化的前台任务
- **`killAsyncAgent(taskId, setAppState)`** — 终止单个 Agent 任务
- **`killAllRunningAgentTasks(tasks, setAppState)`** — 批量终止所有运行中的 Agent
- **`completeAgentTask(result, setAppState)`** — 标记任务完成
- **`failAgentTask(taskId, error, setAppState)`** — 标记任务失败
- **`markAgentsNotified(taskId, setAppState)`** — 标记已通知（抑制重复通知）

## 接口/类型定义

### `LocalAgentTaskState`

继承自 `TaskStateBase`，核心字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| type | `'local_agent'` | 任务类型标识 |
| agentId | string | Agent 唯一 ID |
| prompt | string | 初始 prompt |
| selectedAgent? | AgentDefinition | Agent 定义（运行时清除以释放引用） |
| agentType | string | Agent 类型（如 `'general-purpose'`） |
| model? | string | 可选的模型覆盖 |
| abortController? | AbortController | 取消控制器 |
| result? | AgentToolResult | 完成后的返回结果 |
| progress? | AgentProgress | 当前进度快照 |
| isBackgrounded | boolean | 是否已后台化 |
| pendingMessages | string[] | 待注入消息队列 |
| retain | boolean | UI 是否持有（阻止回收） |
| diskLoaded | boolean | 是否已从磁盘加载 sidechain JSONL |
| evictAfter? | number | 面板可见性截止时间戳 |
| retrieved | boolean | 结果是否已被取回 |
| lastReportedToolCount | number | 上次上报的工具调用数（用于计算增量） |
| lastReportedTokenCount | number | 上次上报的 token 数（用于计算增量） |

### `ProgressTracker`

| 字段 | 类型 | 说明 |
|------|------|------|
| toolUseCount | number | 累计工具调用次数 |
| latestInputTokens | number | 最新输入 token 数（取最新值，非累加） |
| cumulativeOutputTokens | number | 累计输出 token 数 |
| recentActivities | ToolActivity[] | 最近 5 条工具活动记录 |

### `ToolActivity`

| 字段 | 类型 | 说明 |
|------|------|------|
| toolName | string | 工具名称 |
| input | Record<string, unknown> | 工具输入参数 |
| activityDescription? | string | 预计算的活动描述（如 "Reading src/foo.ts"） |
| isSearch? | boolean | 是否为搜索操作（Grep、Glob 等） |
| isRead? | boolean | 是否为读取操作（Read、cat 等） |

### `AgentProgress`

进度快照，包含 `toolUseCount`、`tokenCount`、`lastActivity`、`recentActivities` 和可选的 `summary`。

## 类型守卫

- **`isLocalAgentTask(task): task is LocalAgentTaskState`** — 判断任务是否为 `local_agent` 类型
- **`isPanelAgentTask(t): t is LocalAgentTaskState`** — 判断是否为面板 Agent 任务（排除 `main-session` 类型），所有 pill/panel UI 过滤器共用此谓词

## 边界 Case 与注意事项

1. **幂等终态**：所有终态函数（complete/fail/kill）都检查 `status !== 'running'`，对已终止的任务是 no-op，避免重复状态更新。

2. **通知去重**：`enqueueAgentNotification` 通过原子性的 `notified` 标志确保每个任务只通知一次。`markAgentsNotified` 允许批量 kill 时抑制逐个通知，改发一条聚合消息。

3. **Token 计数方式**：input_tokens 在 Claude API 中是**累积的**（包含所有历史上下文），因此 ProgressTracker 只保留最新值；output_tokens 是每轮的，需要累加。这是一个容易出错的点。

4. **父子 AbortController**：`registerAsyncAgent` 支持传入 `parentAbortController`，创建子级控制器。当父 Agent（如 in-process teammate）被 abort 时，子 Agent 自动跟随 abort。

5. **retain 与 evictAfter 机制**：任务进入终态时，若 UI 正在 retain（用户正在查看），`evictAfter` 设为 `undefined`（永不自动回收）；否则设为 `Date.now() + PANEL_GRACE_MS`，给用户一个宽限期查看结果。

6. **selectedAgent 运行时清除**：终态转换时 `selectedAgent` 被置为 `undefined`，释放 AgentDefinition 对象引用，避免长期内存占用。

7. **投机推理中止**：后台任务完成通知前会调用 `abortSpeculation()`，确保主对话的推测响应不会基于过时的任务状态。

8. **SDK 进度事件**：`updateAgentSummary` 在更新摘要后，若启用了 `SdkAgentProgressSummariesEnabled`，会通过 `emitTaskProgress` 向外部消费者（如 VS Code 扩展面板）发送进度事件。