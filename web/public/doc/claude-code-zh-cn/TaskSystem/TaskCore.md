# TaskCore — 任务系统核心抽象层

## 概述与职责

TaskCore 是 **TaskSystem** 模块的基础抽象层，为整个多任务/多 Agent 执行框架提供统一的类型定义、注册表和通用操作。它不包含任何具体任务的运行时逻辑，而是定义了所有任务类型共享的"骨架"——类型枚举、状态基类、ID 生成、注册查找、停止流程和 UI 标签渲染。

在 TaskSystem 的同级模块中，ToolSystem 通过 AgentTool/TaskTool 创建子任务，CoreEngine 管理后台任务状态，BridgeAndRemote 负责远程 Agent 的实际执行——它们都依赖 TaskCore 提供的统一接口进行交互。

本模块由 5 个文件组成：

| 文件 | 角色 |
|------|------|
| `src/Task.ts` | 核心类型定义：TaskType、TaskStatus、TaskStateBase、Task 接口、ID 生成 |
| `src/tasks.ts` | 任务注册表：按 feature gate 收集所有具体任务实现 |
| `src/tasks/types.ts` | 类型聚合：将所有具体任务状态合并为 TaskState 联合类型 |
| `src/tasks/stopTask.ts` | 通用停止逻辑：查找、校验、终止任务的完整流程 |
| `src/tasks/pillLabel.ts` | UI 标签生成：为状态栏后台任务指示器生成紧凑文本 |

## 关键类型定义

### TaskType — 任务类型枚举

定义了系统支持的 7 种任务类型（`src/Task.ts:6-13`）：

| 值 | 含义 | ID 前缀 |
|----|------|---------|
| `local_bash` | 本地 Shell 命令 | `b` |
| `local_agent` | 本地子 Agent | `a` |
| `remote_agent` | 远程云端 Agent（CCR） | `r` |
| `in_process_teammate` | 进程内团队协作 | `t` |
| `local_workflow` | 本地工作流脚本 | `w` |
| `monitor_mcp` | MCP 监控任务 | `m` |
| `dream` | Dream 模式 | `d` |

### TaskStatus — 任务生命周期状态

5 个状态构成线性生命周期（`src/Task.ts:15-20`）：

```
pending → running → completed / failed / killed
```

`isTerminalTaskStatus()` 判断任务是否处于终态（completed/failed/killed），用于防止向已结束任务注入消息、清理孤儿任务等场景。

### TaskStateBase — 任务状态基类

所有具体任务状态的公共字段（`src/Task.ts:45-57`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 带类型前缀的唯一 ID |
| `type` | `TaskType` | 任务类型 |
| `status` | `TaskStatus` | 当前状态 |
| `description` | `string` | 任务描述文本 |
| `toolUseId` | `string?` | 关联的工具调用 ID |
| `startTime` | `number` | 创建时间戳 |
| `endTime` | `number?` | 结束时间戳 |
| `totalPausedMs` | `number?` | 累计暂停时长 |
| `outputFile` | `string` | 磁盘输出文件路径 |
| `outputOffset` | `number` | 输出文件读取偏移量 |
| `notified` | `boolean` | 是否已发送完成通知 |

### Task 接口 — 任务实现契约

```typescript
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

这是所有具体任务实现必须满足的接口（`src/Task.ts:72-76`）。注意，`Task` 接口**仅包含 `kill` 方法**——`spawn` 和 `render` 方法曾经存在但已在 #22546 中移除，因为它们从未被多态调用过。`kill` 的签名也被精简为只接收 `setAppState`，因为所有 6 种任务实现的 kill 逻辑都不需要 `getAppState` 或 `abortController`。

### 辅助类型

- **`TaskHandle`**：`{ taskId, cleanup? }` — 任务创建后返回的句柄
- **`TaskContext`**：`{ abortController, getAppState, setAppState }` — 任务运行时上下文
- **`SetAppState`**：`(f: (prev: AppState) => AppState) => void` — 不可变状态更新函数
- **`LocalShellSpawnInput`**：Shell 任务的创建参数，包含 `command`、`timeout`、`kind`（区分 `'bash'` 和 `'monitor'` 两种 UI 展示模式）

## 关键流程

### 任务 ID 生成

`generateTaskId()` 使用 `crypto.randomBytes` 生成安全的任务标识符（`src/Task.ts:98-106`）：

1. 根据 TaskType 取 1 字符前缀（如 `local_bash` → `b`）
2. 用 8 个随机字节映射到 36 字符字母表（`0-9a-z`），生成 8 位后缀
3. 最终 ID 格式如 `b3k9m2x7p`，36^8 ≈ 2.8 万亿种组合，足以抵御符号链接暴力攻击

前缀使得开发者可以通过 ID 直接辨别任务类型。

### 任务注册与查找

`src/tasks.ts` 是任务注册表，采用与 `tools.ts` 相同的模式：

1. **静态导入**核心任务：`LocalShellTask`、`LocalAgentTask`、`RemoteAgentTask`、`DreamTask`
2. **按 feature gate 条件加载**：`LocalWorkflowTask`（`WORKFLOW_SCRIPTS`）和 `MonitorMcpTask`（`MONITOR_TOOL`）通过 `bun:bundle` 的 `feature()` 函数在编译时决定是否包含
3. `getAllTasks()` 每次调用都内联构建数组（而非顶层 const），以避免循环依赖问题
4. `getTaskByType(type)` 通过线性查找返回匹配的 Task 实现

### 任务停止流程

`stopTask()` 封装了完整的任务终止逻辑（`src/tasks/stopTask.ts:38-100`），被 TaskStopTool（LLM 调用）和 SDK 的 `stop_task` 控制请求共同使用：

1. **查找任务**：从 `appState.tasks` 中按 ID 查找，未找到抛出 `StopTaskError('not_found')`
2. **校验状态**：确认任务为 `running` 状态，否则抛出 `StopTaskError('not_running')`
3. **查找实现**：通过 `getTaskByType()` 获取对应的 Task 实现，未找到抛出 `StopTaskError('unsupported_type')`
4. **执行终止**：调用 `taskImpl.kill(taskId, setAppState)`
5. **处理通知**：
   - 对于 **Shell 任务**：抑制 "exit code 137" 通知（这只是噪音），并通过 `emitTaskTerminatedSdk()` 直接发送 SDK 事件
   - 对于 **Agent 任务**：不抑制通知，因为 AbortError 的 catch 分支会携带 `extractPartialResult(agentMessages)` 作为有价值的载荷
6. **返回结果**：包含 `taskId`、`taskType` 和 `command`（Shell 任务返回命令文本，其他返回描述文本）

`StopTaskError` 是自定义错误类，携带 `code` 字段（`'not_found' | 'not_running' | 'unsupported_type'`）供调用方区分失败原因。

### 后台任务判断

`isBackgroundTask()`（`src/tasks/types.ts:37-46`）判断一个任务是否应显示在后台任务指示器中，条件为：

1. 状态为 `running` 或 `pending`
2. 未被显式标记为前台任务（`isBackgrounded !== false`）

### 状态栏标签生成

`getPillLabel()` 为后台任务指示器生成紧凑的文本标签（`src/tasks/pillLabel.ts:10-67`），同时用于页脚 pill 和会话时长记录行：

- **同类型任务**时按类型生成具体标签：
  - `local_bash`：区分 shell 和 monitor 两种 kind，如 `"2 shells, 1 monitor"`
  - `in_process_teammate`：按不同团队名去重计数，如 `"2 teams"`
  - `remote_agent`：展示钻石图标（◇/◆），ultraplan 模式有特殊文案（`"◆ ultraplan ready"`、`"◇ ultraplan needs your input"`）
  - `dream`：固定返回 `"dreaming"`
- **混合类型**时退化为通用标签：`"3 background tasks"`

`pillNeedsCta()` 判断是否需要显示 "↓ to view" 行动召唤提示——仅在单个 ultraplan 远程 Agent 处于 `needs_input` 或 `plan_ready` 阶段时返回 true。

## 类型聚合

`src/tasks/types.ts` 将 7 种具体任务状态聚合为两个联合类型：

```typescript
type TaskState = LocalShellTaskState | LocalAgentTaskState | RemoteAgentTaskState
  | InProcessTeammateTaskState | LocalWorkflowTaskState | MonitorMcpTaskState
  | DreamTaskState

type BackgroundTaskState = /* 同上，当前与 TaskState 完全一致 */
```

`TaskState` 供需要处理任意任务类型的组件使用（如状态面板、任务列表）；`BackgroundTaskState` 语义上表示可出现在后台指示器中的任务子集（目前恰好与 TaskState 相同，但保留了独立类型以便未来扩展）。

## 边界 Case 与注意事项

- **循环依赖规避**：`getAllTasks()` 每次调用都内联构建数组而非使用顶层 const，这是为了避免模块加载顺序导致的循环依赖
- **Feature gate 是编译时决策**：`LocalWorkflowTask` 和 `MonitorMcpTask` 通过 `bun:bundle` 的 `feature()` 在构建时裁剪，而非运行时判断
- **Shell 任务通知抑制**：`stopTask` 对 Shell 任务会主动标记 `notified: true` 以抑制 "exit code 137" 噪音通知，同时通过 `emitTaskTerminatedSdk()` 确保 SDK 消费者仍能收到事件
- **ID 安全性**：任务 ID 使用密码学安全的随机字节生成，36^8 组合空间可抵御符号链接攻击