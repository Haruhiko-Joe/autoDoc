# LocalShellTask — 本地 Shell 后台任务运行时

## 概述与职责

`LocalShellTask` 是 TaskSystem 中负责**本地 Shell 命令后台执行**的运行时模块。当 Claude Code 需要在后台运行一条 Shell 命令（如长时间编译、日志监控、测试套件等），该模块负责完成从进程 spawn 到终止的完整生命周期管理。

在整体架构中，它位于 **TaskSystem** 层，与同级的 `LocalAgentTask`（本地 Agent 子任务）、`RemoteAgentTask`（远程 Agent 任务）等并列。ToolSystem 中的 `BashTool` 和 `TaskTool` 会调用本模块来创建和管理后台命令。

模块支持两种任务类型（`BashTaskKind`）：
- **`bash`**：普通后台 Shell 命令，启用 stall watchdog 检测交互式阻塞
- **`monitor`**：流式监控脚本，不启用 stall watchdog，完成时有独立的通知措辞

代码分布在三个文件中，按"避免非 React 消费者引入 React/Ink 依赖"的原则拆分：

| 文件 | 职责 |
|------|------|
| `LocalShellTask.tsx` | 主逻辑：spawn、background、watchdog、通知、Task 对象注册 |
| `guards.ts` | 纯类型定义和类型守卫，供非 React 模块安全导入 |
| `killShellTasks.ts` | 纯函数的 kill 逻辑，供 `runAgent.ts` 等非 React 模块调用 |

## 关键流程

### 1. 后台任务 Spawn 流程

入口函数 `spawnShellTask()` (`LocalShellTask.tsx:180-252`) 完成以下步骤：

1. 从传入的 `ShellCommand` 获取 `taskOutput.taskId` 作为任务标识
2. 通过 `registerCleanup()` 注册进程退出时的清理回调（确保异常退出时 kill 子进程）
3. 构造 `LocalShellTaskState` 并通过 `registerTask()` 注册到全局 `AppState.tasks`
4. 调用 `shellCommand.background(taskId)` 将进程切换为后台模式
5. 启动 **stall watchdog** 定时器监控输出停滞
6. 监听 `shellCommand.result` Promise，在进程退出时执行清理和通知

### 2. 前台注册 → 自动后台化流程

当 Bash 命令前台运行时间过长，UI 会显示 BackgroundHint。此时流程为：

1. `registerForeground()` (`LocalShellTask.tsx:259-287`)：将正在前台运行的命令注册为任务（`isBackgrounded: false`）
2. `backgroundExistingForegroundTask()` (`LocalShellTask.tsx:420-474`)：用户确认或自动触发后台化——调用 `shellCommand.background()`，翻转 `isBackgrounded` 标志，启动 stall watchdog 和完成回调
3. 如果命令在后台化前就完成了，`unregisterForeground()` (`LocalShellTask.tsx:491-514`) 直接从 tasks 中移除，无需发送通知

### 3. Stall Watchdog 检测交互式阻塞

`startStallWatchdog()` (`LocalShellTask.tsx:46-104`) 是一个定时轮询器，用于检测后台命令是否被交互式提示（如 `(y/n)?`）阻塞：

1. 每 **5 秒**（`STALL_CHECK_INTERVAL_MS`）检查一次输出文件大小
2. 如果输出持续 **45 秒**（`STALL_THRESHOLD_MS`）未增长，读取文件末尾 **1024 字节**
3. 用 `looksLikePrompt()` 匹配末行是否符合交互式提示模式（如 `(y/n)`、`Press Enter`、`Continue?` 等）
4. 若匹配，发送一条通知告诉模型该命令可能被阻塞，建议用管道输入或非交互标志重跑
5. **仅对 `bash` 类型生效**——`monitor` 类型直接返回空函数，不监控

关键设计：watchdog 只在"输出停滞 + 末行像提示"时才触发，避免对慢构建或 `git log -S` 等耗时但正常的命令误报（参见 CC-1175）。

### 4. 进程终止（Kill）流程

`killTask()` (`killShellTasks.ts:16-46`)：

1. 通过 `updateTaskState` 获取任务，校验状态为 `running` 且类型为 `local_bash`
2. 调用 `shellCommand.kill()`（内部执行 SIGTERM → SIGKILL 级联）
3. 调用 `shellCommand.cleanup()` 清理临时资源
4. 注销清理回调、清除定时器
5. 将任务状态更新为 `killed`，设置 `endTime`
6. 调用 `evictTaskOutput()` 清理磁盘输出文件

`killShellTasksForAgent()` (`killShellTasks.ts:53-76`)：当 Agent 退出时，遍历所有任务，kill 该 Agent 名下所有仍在运行的 Shell 任务，防止"僵尸进程"（如文件中注释提到的"10-day fake-logs.sh"场景）。随后调用 `dequeueAllMatching()` 清除该 Agent 的待处理通知队列。

### 5. 完成通知生成

`enqueueShellNotification()` (`LocalShellTask.tsx:105-172`) 在任务完成/失败/被杀时生成 XML 格式的通知消息：

1. 原子性检查并设置 `notified` 标志，防止重复通知
2. 调用 `abortSpeculation()` 中止推测执行（后台任务状态变化可能使推测结果过期）
3. 根据 `kind` 和 `status` 组装不同的 summary 文本：
   - `bash`：`Background command "xxx" completed/failed/was stopped`
   - `monitor`：`Monitor "xxx" stream ended/script failed/stopped`
4. 构建包含 `<task_notification>` XML 标签的消息体，包含 taskId、outputPath、status、summary
5. 通过 `enqueuePendingNotification()` 入队，monitor 类型优先级为 `next`，bash 类型为 `later`

## 函数签名与参数说明

### `spawnShellTask(input, context): Promise<TaskHandle>`

直接 spawn 一个后台 Shell 任务。

- **input**：`LocalShellSpawnInput & { shellCommand: ShellCommand }` — 包含 `command`（原始命令字符串）、`description`（用于通知显示）、`shellCommand`（已创建的 ShellCommand 实例）、`toolUseId`、`agentId`、`kind`
- **context**：`TaskContext` — 包含 `setAppState`
- **返回**：`TaskHandle`（含 `taskId` 和 `cleanup` 函数）

> 源码位置：`src/tasks/LocalShellTask/LocalShellTask.tsx:180-252`

### `registerForeground(input, setAppState, toolUseId?): string`

注册一个正在前台运行的命令为任务，稍后可被后台化。

- **返回**：`taskId`

> 源码位置：`src/tasks/LocalShellTask/LocalShellTask.tsx:259-287`

### `backgroundExistingForegroundTask(taskId, shellCommand, description, setAppState, toolUseId?): boolean`

将已注册的前台任务就地转为后台。不会重新注册任务，避免重复的 `task_started` SDK 事件。

- **返回**：`true` 表示成功后台化

> 源码位置：`src/tasks/LocalShellTask/LocalShellTask.tsx:420-474`

### `backgroundAll(getAppState, setAppState): void`

后台化所有前台任务（bash 和 agent）。用户按 Ctrl+B 时调用。

> 源码位置：`src/tasks/LocalShellTask/LocalShellTask.tsx:390-409`

### `hasForegroundTasks(state): boolean`

检查是否有可被后台化的前台任务。用于决定 Ctrl+B 是后台化现有任务还是后台化整个会话。

> 源码位置：`src/tasks/LocalShellTask/LocalShellTask.tsx:378-389`

### `markTaskNotified(taskId, setAppState): void`

手动标记任务为已通知，抑制后续的 `enqueueShellNotification`。用于后台化与完成竞态的场景——工具结果已包含完整输出，通知将是多余的。

> 源码位置：`src/tasks/LocalShellTask/LocalShellTask.tsx:481-486`

### `unregisterForeground(taskId, setAppState): void`

命令在前台完成（未被后台化）时，从 tasks 中移除注册。

> 源码位置：`src/tasks/LocalShellTask/LocalShellTask.tsx:491-514`

### `killTask(taskId, setAppState): void`

终止指定任务——kill 进程、清理资源、更新状态为 `killed`、驱逐磁盘输出。

> 源码位置：`src/tasks/LocalShellTask/killShellTasks.ts:16-46`

### `killShellTasksForAgent(agentId, getAppState, setAppState): void`

批量终止指定 Agent 名下所有运行中的 Shell 任务，并清除该 Agent 的待处理通知。

> 源码位置：`src/tasks/LocalShellTask/killShellTasks.ts:53-76`

### `looksLikePrompt(tail: string): boolean`

判断输出末行是否匹配交互式提示模式。被 stall watchdog 内部调用，同时也被导出供外部使用。

> 源码位置：`src/tasks/LocalShellTask/LocalShellTask.tsx:39-42`

## 接口/类型定义

### `BashTaskKind`

```typescript
type BashTaskKind = 'bash' | 'monitor'
```

任务类型标识。`bash` 为普通后台命令，`monitor` 为流式监控脚本。

> 源码位置：`src/tasks/LocalShellTask/guards.ts:9`

### `LocalShellTaskState`

```typescript
type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash'
  command: string
  result?: { code: number; interrupted: boolean }
  completionStatusSentInAttachment: boolean
  shellCommand: ShellCommand | null
  unregisterCleanup?: () => void
  cleanupTimeoutId?: NodeJS.Timeout
  lastReportedTotalLines: number
  isBackgrounded: boolean
  agentId?: AgentId
  kind?: BashTaskKind
}
```

核心状态类型，继承自 `TaskStateBase`，关键字段：

| 字段 | 说明 |
|------|------|
| `type` | 固定为 `'local_bash'`（向后兼容持久化会话状态） |
| `command` | 原始 Shell 命令字符串 |
| `result` | 进程退出结果（退出码 + 是否被中断） |
| `shellCommand` | 运行中的 ShellCommand 引用，完成后置为 `null` |
| `isBackgrounded` | `false` = 前台运行中，`true` = 已后台化 |
| `agentId` | 创建该任务的 Agent ID，`undefined` 表示主线程 |
| `kind` | UI 显示变体，`monitor` 显示描述而非命令 |
| `lastReportedTotalLines` | 上次上报的总行数，用于计算增量输出 |

> 源码位置：`src/tasks/LocalShellTask/guards.ts:11-32`

### `isLocalShellTask(task): task is LocalShellTaskState`

类型守卫，通过检查 `task.type === 'local_bash'` 判断。

> 源码位置：`src/tasks/LocalShellTask/guards.ts:34-41`

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `STALL_CHECK_INTERVAL_MS` | 5000 (5s) | Stall watchdog 轮询间隔 |
| `STALL_THRESHOLD_MS` | 45000 (45s) | 输出停滞多久后开始检查末行内容 |
| `STALL_TAIL_BYTES` | 1024 | 读取输出文件末尾的字节数 |
| `BACKGROUND_BASH_SUMMARY_PREFIX` | `'Background command '` | 通知摘要前缀，也被 UI collapse transform 用于识别 |

## 边界 Case 与注意事项

- **后台化与完成的竞态**：命令可能在后台化过程中就已完成。`markTaskNotified()` 用于此场景——当工具结果已携带完整输出时，标记任务已通知以抑制多余的 `<task_notification>`。

- **重复通知防护**：`enqueueShellNotification()` 通过原子 check-and-set `notified` 标志确保每个任务只发送一次通知。如果 `TaskStopTool` 已标记过，spawn 的完成回调不会重复发送。

- **Agent 退出时的僵尸进程清理**：`killShellTasksForAgent()` 在 `runAgent.ts` 的 finally 块中调用，确保 Agent 退出后其所有后台 Shell 任务都被终止，避免长期运行的孤儿进程。清理后还会通过 `dequeueAllMatching()` 清除已无消费者的通知队列。

- **Monitor 类型的特殊处理**：Monitor 任务不启用 stall watchdog（流式监控脚本长时间无输出是正常的），且通知措辞不同——脚本退出表示"stream ended"而非"completed"，避免与 bash 类型的"N background commands completed"折叠逻辑混淆。

- **模块拆分的原因**：`guards.ts` 和 `killShellTasks.ts` 从主文件中提取出来，是为了让 `stopTask.ts`（经由 `print.ts`）和 `runAgent.ts` 等非 React 消费者可以安全导入，不会把 React/Ink 拉入模块图。

- **推测执行中止**：每次后台任务状态变化（完成/失败/被杀）都会调用 `abortSpeculation()`，因为推测的模型响应可能基于过期的任务输出。