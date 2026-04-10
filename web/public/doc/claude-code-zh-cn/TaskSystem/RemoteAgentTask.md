# RemoteAgentTask — 远程 Agent 任务运行时

## 概述与职责

`RemoteAgentTask` 是 **TaskSystem** 中负责管理远程 Agent 会话生命周期的运行时模块。它通过 WebSocket 长轮询 CCR（Claude Cloud Runtime）获取远程会话事件，驱动远程任务从创建、运行、监控到归档的完整生命周期。

在整体架构中，`RemoteAgentTask` 隶属于 **TaskSystem**（多任务与多 Agent 执行框架），是 `Task` 接口的一种具体实现。它向上通过 **BridgeAndRemote** 层与云端运行时通信（`pollRemoteSessionEvents`、`archiveRemoteSession`、`fetchSession`），向下通过统一任务框架（`registerTask`、`updateTaskState`）将状态变更推送到 **TerminalUI** 层渲染。

该模块支持五种远程任务类型：`remote-agent`（通用远程 Agent）、`ultraplan`（远程计划模式）、`ultrareview`（远程代码审查）、`autofix-pr`（自动修复 PR）和 `background-pr`（后台 PR 处理）。

> 源码位置：`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`（单文件，约 855 行）

## 关键流程

### 1. 任务注册流程

任务通过 `registerRemoteAgentTask()` 进入系统，该函数是整个模块的入口：

1. 调用 `generateTaskId('remote_agent')` 生成唯一任务 ID（`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:415`）
2. 调用 `initTaskOutput(taskId)` 创建磁盘输出文件，确保在首条事件到达前文件已存在（`:420`）
3. 构建 `RemoteAgentTaskState` 对象（初始 `status: 'running'`），通过 `registerTask()` 注册到 AppState（`:437`）
4. 调用 `persistRemoteAgentMetadata()` 将任务元数据持久化到 session sidecar，以支持 `--resume` 恢复（`:442-454`）
5. 调用 `startRemoteSessionPolling()` 启动轮询循环（`:460`）
6. 返回 `{ taskId, sessionId, cleanup }` 给调用方

```typescript
// src/tasks/RemoteAgentTask/RemoteAgentTask.tsx:386-402
export function registerRemoteAgentTask(options: {
  remoteTaskType: RemoteTaskType;
  session: { id: string; title: string };
  command: string;
  context: TaskContext;
  toolUseId?: string;
  isRemoteReview?: boolean;
  isUltraplan?: boolean;
  isLongRunning?: boolean;
  remoteTaskMetadata?: RemoteTaskMetadata;
}): { taskId: string; sessionId: string; cleanup: () => void }
```

### 2. 轮询与状态同步核心循环

`startRemoteSessionPolling()` 是模块的核心引擎（`:538-805`），以 **1 秒间隔** 轮询 CCR 会话事件：

1. **拉取增量事件**：调用 `pollRemoteSessionEvents(sessionId, lastEventId)` 获取新事件，通过 `lastEventId` 实现增量拉取（`:564`）
2. **累积日志**：新事件追加到 `accumulatedLog`，同时将文本内容写入磁盘输出文件（`:567-577`）
3. **判定完成条件**（按优先级）：
   - **会话已归档**（`sessionStatus === 'archived'`）→ 直接标记完成（`:579-588`）
   - **外部完成检查器**匹配 → 调用已注册的 `RemoteTaskCompletionChecker`（`:590-603`）
   - **Result 事件**（非 ultraplan/长运行模式）→ 根据 `result.subtype` 标记成功/失败（`:610`）
   - **远程审查完成**（`<remote-review>` 标签出现或稳定 idle）→ 注入审查内容（`:685`）
   - **审查超时**（超过 30 分钟）→ 标记失败（`:686`）
4. **更新 AppState**：通过 `updateTaskState()` 原子更新任务状态、日志、TodoList 和审查进度（`:694-719`）
5. **发送通知**：任务完成/失败时，通过 `enqueuePendingNotification()` 向消息队列发送结构化通知（`:722-760`）
6. **资源清理**：完成后调用 `evictTaskOutput()`、`removeRemoteAgentMetadata()` 清理磁盘和 sidecar 元数据

#### 稳定 Idle 判定

远程会话在工具调用之间会短暂进入 `idle` 状态。为避免误判，轮询器要求 **连续 5 次** idle 且无日志增长才认为会话真正结束（`STABLE_IDLE_POLLS = 5`，`:545`）。同时，存在 `SessionStart` hook 事件时（bughunter 模式），稳定 idle 不作为完成信号——只有 `<remote-review>` 标签或 30 分钟超时才能结束任务（`:681-685`）。

### 3. 会话恢复流程（`--resume`）

`restoreRemoteAgentTasks()` 在会话恢复时重建远程任务（`:477-531`）：

1. 调用 `listRemoteAgentMetadata()` 从 sidecar 目录读取所有持久化的任务元数据（`:485`）
2. 对每个任务，调用 `fetchSession(sessionId)` 查询 CCR 会话的实时状态（`:490`）
   - **404**：会话不存在，清理 sidecar 条目（`:498-499`）
   - **已归档**：会话已结束，跳过（`:506-509`）
   - **其他错误**（如 401 未授权）：视为可恢复，跳过但不清理（`:501-503`）
3. 对仍在运行的会话，重建 `RemoteAgentTaskState` 并重启轮询
4. 关键细节：`pollStartedAt` 设为 `Date.now()` 而非原始生成时间，避免恢复后立即触发超时（`:525`）

### 4. 任务终止流程

`RemoteAgentTask.kill()` 处理任务终止（`:811-849`）：

1. 原子更新状态为 `killed`，同时标记 `notified: true` 防止通知重复
2. 调用 `emitTaskTerminatedSdk()` 向 SDK 消费者发送终止事件
3. 调用 `archiveRemoteSession(sessionId)` 归档远程会话释放云资源
4. 清理磁盘输出和 sidecar 元数据

## 函数签名与参数说明

### `registerRemoteAgentTask(options)`

注册并启动一个远程 Agent 任务，返回 `{ taskId, sessionId, cleanup }`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `remoteTaskType` | `RemoteTaskType` | 是 | 任务类型，决定完成判定逻辑 |
| `session` | `{ id: string; title: string }` | 是 | CCR 会话标识 |
| `command` | `string` | 是 | 触发该任务的用户命令 |
| `context` | `TaskContext` | 是 | 包含 `getAppState` / `setAppState` 的上下文 |
| `toolUseId` | `string` | 否 | 关联的 tool_use block ID |
| `isRemoteReview` | `boolean` | 否 | 标记为远程审查任务 |
| `isUltraplan` | `boolean` | 否 | 标记为 ultraplan 任务 |
| `isLongRunning` | `boolean` | 否 | 长运行任务，不因首个 `result` 事件完成 |
| `remoteTaskMetadata` | `RemoteTaskMetadata` | 否 | 任务特定元数据（如 PR 信息） |

### `restoreRemoteAgentTasks(context: TaskContext): Promise<void>`

从 session sidecar 恢复所有远程任务。`--resume` 场景下调用。

### `checkRemoteAgentEligibility(options?): Promise<RemoteAgentPreconditionResult>`

检查当前环境是否满足创建远程会话的前置条件。返回 `{ eligible: true }` 或 `{ eligible: false, errors: [...] }`。

### `formatPreconditionError(error): string`

将前置条件错误转换为用户友好的提示文本。支持的错误类型：`not_logged_in`、`no_remote_environment`、`not_in_git_repo`、`no_git_remote`、`github_app_not_installed`、`policy_blocked`。

### `registerCompletionChecker(remoteTaskType, checker): void`

为特定任务类型注册外部完成检查器。检查器在每次轮询 tick 被调用，返回非 null 字符串表示任务完成（字符串内容成为通知文本）。

### `extractPlanFromLog(log: SDKMessage[]): string | null`

从会话日志中逆序搜索 `<ultraplan>` 标签，提取计划内容。

### `enqueueUltraplanFailureNotification(taskId, sessionId, reason, setAppState): void`

发送 ultraplan 专用失败通知，包含 CCR 会话 URL 供用户查看。

### `getRemoteTaskSessionUrl(sessionId: string): string`

生成远程会话的 Web 访问 URL。

## 接口/类型定义

### `RemoteAgentTaskState`

继承 `TaskStateBase`，是远程任务在 AppState 中的完整状态表示：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'remote_agent'` | 固定类型标识 |
| `remoteTaskType` | `RemoteTaskType` | 具体任务类型 |
| `remoteTaskMetadata` | `RemoteTaskMetadata?` | PR 号、仓库名等元数据 |
| `sessionId` | `string` | CCR 会话 ID |
| `command` | `string` | 触发命令 |
| `title` | `string` | 任务标题 |
| `todoList` | `TodoList` | 从远程日志同步的待办列表 |
| `log` | `SDKMessage[]` | 累积的会话事件日志 |
| `isLongRunning` | `boolean?` | 长运行任务标记 |
| `pollStartedAt` | `number` | 本地轮询器启动时间戳 |
| `isRemoteReview` | `boolean?` | 远程审查标记 |
| `reviewProgress` | `object?` | 审查进度（阶段、bug 数量统计） |
| `isUltraplan` | `boolean?` | ultraplan 标记 |
| `ultraplanPhase` | `UltraplanPhase?` | ultraplan 阶段（`needs_input` / `plan_ready`） |

### `RemoteTaskType`

```typescript
type RemoteTaskType = 'remote-agent' | 'ultraplan' | 'ultrareview' | 'autofix-pr' | 'background-pr';
```

### `RemoteTaskMetadata` / `AutofixPrRemoteTaskMetadata`

```typescript
type AutofixPrRemoteTaskMetadata = { owner: string; repo: string; prNumber: number };
type RemoteTaskMetadata = AutofixPrRemoteTaskMetadata;
```

### `RemoteAgentPreconditionResult`

```typescript
type RemoteAgentPreconditionResult =
  | { eligible: true }
  | { eligible: false; errors: BackgroundRemoteSessionPrecondition[] };
```

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|------|------|
| `POLL_INTERVAL_MS` | `1000` | 轮询间隔（毫秒） |
| `REMOTE_REVIEW_TIMEOUT_MS` | `30 * 60 * 1000`（30 分钟） | 远程审查超时上限 |
| `STABLE_IDLE_POLLS` | `5` | 连续 idle 次数阈值，避免瞬态 idle 误判 |

环境变量：
- `SESSION_INGRESS_URL`：可选，覆盖远程会话 URL 的入口地址（`:853-854`）

## 边界 Case 与注意事项

- **竞态保护**：`markTaskNotified()` 使用原子标记防止重复通知（`:189-202`）。轮询循环中，`updateTaskState` 回调检测到 `status !== 'running'` 时会立即退出，避免与 `kill()` 操作竞态覆盖状态（`:694-720`）。

- **Ultraplan 特殊处理**：ultraplan 任务的生命周期由外部 `startDetachedPoll` 管理（通过 `ExitPlanMode` 扫描器），本模块的轮询仅负责同步日志和 UI 进度，不驱动完成判定（`:606-610`）。

- **Bughunter vs Prompt 双路径**：远程审查存在两种执行路径——bughunter 模式（`run_hunt.sh` 作为 `SessionStart` hook，通过 `hook_progress` 输出）和 prompt 模式（标准 assistant 消息）。代码通过检测 `SessionStart` hook 事件区分两种模式，在 bughunter 模式下禁用稳定 idle 完成判定（`:670-683`）。

- **跨事件标签分割**：大 JSON 输出可能被管道缓冲区截断为多个 `hook_progress` 事件。`extractReviewFromLog` 包含 hook stdout 拼接回退逻辑处理此场景（`:273-278`）。

- **恢复后超时重置**：`--resume` 恢复时 `pollStartedAt` 重置为当前时间，确保不会因任务原始创建时间过久而立即触发 30 分钟超时（`:525`）。

- **TodoList 同步**：轮询循环从远程日志中提取最后一次 `TodoWriteTool` 调用的输入作为当前待办列表，仅在日志增长时重新扫描以避免不必要的解析开销（`:714-715`）。

- **元数据持久化为 fire-and-forget**：`persistRemoteAgentMetadata` 和 `removeRemoteAgentMetadata` 的失败不会阻塞任务流程，仅记录调试日志（`:92-111`）。