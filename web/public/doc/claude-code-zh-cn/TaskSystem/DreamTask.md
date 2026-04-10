# DreamTask — Dream 记忆整合任务

## 概述与职责

DreamTask 是 **TaskSystem** 下的一个任务类型实现，为后台运行的 auto-dream（记忆整合子 Agent）提供**任务注册与状态追踪的 UI 表面**。它本身不包含任何 dream 逻辑（记忆整合的实际工作由 `src/services/autoDream/` 驱动），而是让原本不可见的后台 Agent 能够出现在终端底部状态栏（footer pill）和 Shift+Down 任务对话框中。

在 TaskSystem 的任务类型体系中，DreamTask 对应 `type: 'dream'`，与 `local_bash`、`local_agent`、`remote_agent` 等并列，共享统一的 `TaskStateBase` 基础状态和 `registerTask` / `updateTaskState` 框架函数。

同级兄弟模块包括本地 Shell 任务、本地 Agent 任务、远程 Agent 任务、团队协作任务、工作流任务、MCP 监控任务等。

## 关键流程

### 1. 任务注册

当 auto-dream 服务启动一次记忆整合时，调用 `registerDreamTask()` 完成注册：

1. 通过 `generateTaskId('dream')` 生成以 `d` 为前缀的唯一任务 ID（`src/Task.ts:86,98-106`）
2. 用 `createTaskStateBase()` 创建基础状态，设置初始 phase 为 `'starting'`、status 为 `'running'`
3. 记录 `sessionsReviewing`（本次整合涉及的会话数）、`priorMtime`（consolidation lock 的原始 mtime，用于回滚）、`abortController`（用于中止）
4. 调用 `registerTask()` 将任务注册到全局 AppState，使其可见于 UI

```typescript
// src/tasks/DreamTask/DreamTask.ts:52-74
export function registerDreamTask(
  setAppState: SetAppState,
  opts: {
    sessionsReviewing: number
    priorMtime: number
    abortController: AbortController
  },
): string
```

### 2. 增量更新（assistant 轮次追踪）

dream agent 每完成一个 assistant 轮次，调用 `addDreamTurn()` 推送更新：

1. 对新 `touchedPaths` 去重——用 `Set` 过滤已在 `filesTouched` 中出现的路径（`src/tasks/DreamTask/DreamTask.ts:83-84`）
2. **空轮次优化**：若 turn 文本为空、工具调用为 0、且无新触及路径，直接返回原 state，避免无意义的 UI 重渲染（`src/tasks/DreamTask/DreamTask.ts:87-93`）
3. 当首次检测到新的文件触及时，将 phase 从 `'starting'` 切换为 `'updating'`（`src/tasks/DreamTask/DreamTask.ts:96`）
4. turns 数组采用滑动窗口策略，仅保留最近 `MAX_TURNS`（30）个轮次用于 UI 展示（`src/tasks/DreamTask/DreamTask.ts:101`）

### 3. 任务终结（完成 / 失败 / 终止）

三种终结路径共享相似模式——设置终态 status、记录 `endTime`、清除 `abortController`、标记 `notified: true`：

- **`completeDreamTask()`**：正常完成。`notified` 立即设为 `true`，因为 dream 没有模型侧通知路径，行内的 `appendSystemMessage` 就是用户可见的完成通知
- **`failDreamTask()`**：执行失败
- **`DreamTask.kill()`**：用户主动终止。额外执行两步操作：
  1. 调用 `abortController.abort()` 中止正在运行的 dream agent
  2. 调用 `rollbackConsolidationLock(priorMtime)` 回滚 consolidation lock 的 mtime，使下一次会话可以重新触发 dream（`src/tasks/DreamTask/DreamTask.ts:153-155`）。仅在任务确实处于 `'running'` 状态时执行回滚

## 函数签名与参数说明

### `registerDreamTask(setAppState, opts): string`

注册一个新的 dream 任务，返回任务 ID。

| 参数 | 类型 | 说明 |
|------|------|------|
| `setAppState` | `SetAppState` | 全局状态更新函数 |
| `opts.sessionsReviewing` | `number` | 本次整合涉及的会话数量 |
| `opts.priorMtime` | `number` | consolidation lock 文件的原始修改时间戳，kill 时用于回滚 |
| `opts.abortController` | `AbortController` | 用于中止 dream agent 的控制器 |

### `addDreamTurn(taskId, turn, touchedPaths, setAppState): void`

追加一个 assistant 轮次并更新触及文件列表。

| 参数 | 类型 | 说明 |
|------|------|------|
| `taskId` | `string` | 任务 ID |
| `turn` | `DreamTurn` | 包含 `text`（assistant 回复文本）和 `toolUseCount`（工具调用次数） |
| `touchedPaths` | `string[]` | 本轮中 Edit/Write 工具调用涉及的文件路径 |
| `setAppState` | `SetAppState` | 全局状态更新函数 |

### `completeDreamTask(taskId, setAppState): void`

将任务标记为正常完成。

### `failDreamTask(taskId, setAppState): void`

将任务标记为失败。

### `isDreamTask(task): task is DreamTaskState`

类型守卫，判断一个 task 对象是否为 DreamTaskState。

### `DreamTask.kill(taskId, setAppState): Promise<void>`

终止正在运行的 dream 任务，中止 agent 并回滚 consolidation lock。

## 接口 / 类型定义

### `DreamTaskState`

继承 `TaskStateBase`，扩展 dream 特有字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `'dream'` | 任务类型标识 |
| `phase` | `DreamPhase` | 当前阶段：`'starting'` 或 `'updating'` |
| `sessionsReviewing` | `number` | 正在回顾的会话数 |
| `filesTouched` | `string[]` | 已观察到被 Edit/Write 触及的文件路径（**不完整**，见下方注意事项） |
| `turns` | `DreamTurn[]` | 最近的 assistant 轮次（最多 30 个） |
| `abortController?` | `AbortController` | 中止控制器，任务终结后清除为 `undefined` |
| `priorMtime` | `number` | consolidation lock 的原始 mtime |

### `DreamTurn`

单个 assistant 轮次的精简表示：

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | `string` | assistant 回复的文本内容 |
| `toolUseCount` | `number` | 该轮中工具调用的次数（折叠为计数） |

### `DreamPhase`

```typescript
type DreamPhase = 'starting' | 'updating'
```

两阶段模型，不映射 dream agent 内部的四阶段流程（orient/gather/consolidate/prune）。当首个 Edit/Write 工具调用被检测到时，从 `'starting'` 切换为 `'updating'`。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_TURNS` | `30` | UI 展示的最大轮次数，超出时从头部裁剪 |

任务 ID 前缀为 `'d'`（在 `src/Task.ts:86` 中注册），生成格式为 `d` + 8 位随机字符。

## 边界 Case 与注意事项

- **`filesTouched` 是不完整的**：该字段仅捕获通过 `addDreamTurn` 的 `touchedPaths` 参数传入的 Edit/Write 工具调用路径。通过 Bash 命令进行的文件写入不会被追踪。应将其理解为"至少触及了这些文件"，而非"仅触及了这些文件"（`src/tasks/DreamTask/DreamTask.ts:29-35`）

- **`notified` 立即为 `true`**：与其他任务类型不同，dream 任务在完成/失败/终止时立即标记 `notified: true`，因为 dream 没有模型侧通知通道。若不这样做，任务将无法从 AppState 中被驱逐（驱逐条件要求 `terminal + notified`）

- **kill 时的 lock 回滚**：`kill()` 方法会将 consolidation lock 的 mtime 回滚到 `priorMtime`，与 `autoDream.ts` 中 fork 失败的处理路径一致。这确保用户终止 dream 后，下一次会话仍可触发新的 dream。但如果 `updateTaskState` 是空操作（任务已经处于终态），则跳过回滚

- **空轮次优化**：`addDreamTurn` 在 text 为空、toolUseCount 为 0、且无新文件触及时，返回原始 state 引用，避免触发不必要的 React/Ink 重渲染