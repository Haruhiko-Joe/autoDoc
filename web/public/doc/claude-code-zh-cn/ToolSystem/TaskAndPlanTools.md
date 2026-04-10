# 任务管理与计划模式工具集（TaskAndPlanTools）

## 概述与职责

本模块是 ToolSystem 的一部分，包含 11 个工具，分为三个功能域：

1. **任务管理工具**（v1 + v2）：管理会话内的任务跟踪和后台任务交互
2. **计划模式工具**：控制"计划→探索→审批→实施"的工作流
3. **Worktree 隔离工具**：通过 git worktree 提供代码修改的隔离环境

在顶层架构中，这些工具由 ToolSystem（中央注册表）注册，被 CoreEngine 的查询引擎按需调度。任务管理工具与 TaskSystem（多任务执行框架）紧密协作，而计划模式工具则操控权限系统的模式状态（`toolPermissionContext.mode`）。

---

## 工具总览

| 工具名 | 类型 | 只读 | 核心文件 |
|--------|------|------|----------|
| `TaskOutput` | 后台任务输出读取 | 是 | `src/tools/TaskOutputTool/TaskOutputTool.tsx` |
| `TaskStop` | 终止后台任务 | 否 | `src/tools/TaskStopTool/TaskStopTool.ts` |
| `TaskCreate` | v2 任务创建 | 否 | `src/tools/TaskCreateTool/TaskCreateTool.ts` |
| `TaskGet` | v2 任务查询 | 是 | `src/tools/TaskGetTool/TaskGetTool.ts` |
| `TaskUpdate` | v2 任务更新 | 否 | `src/tools/TaskUpdateTool/TaskUpdateTool.ts` |
| `TaskList` | v2 任务列表 | 是 | `src/tools/TaskListTool/TaskListTool.ts` |
| `TodoWrite` | v1 待办事项 | 否 | `src/tools/TodoWriteTool/TodoWriteTool.ts` |
| `EnterPlanMode` | 进入计划模式 | 是 | `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts` |
| `ExitPlanMode` | 退出计划模式 | 否 | `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` |
| `EnterWorktree` | 创建并进入 worktree | 否 | `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts` |
| `ExitWorktree` | 退出 worktree | 否 | `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts` |

所有工具均通过 `buildTool()` 构建，遵循 `ToolDef<InputSchema, Output>` 接口，使用 Zod v4 做输入输出校验，并设置 `shouldDefer: true`（延迟加载模式）。

---

## 关键流程

### 1. TaskOutputTool — 后台任务输出读取

这是本模块中最大的工具（580+ 行），支持读取所有类型的后台任务输出：`local_bash`、`local_agent`、`remote_agent`。

**核心流程：**

1. 通过 `task_id` 从 `appState.tasks` 中查找任务（`TaskOutputTool.tsx:196-203`）
2. 根据 `block` 参数决定行为：
   - `block=false`（非阻塞）：立即返回当前状态，如任务已完成则标记 `notified: true`
   - `block=true`（默认）：调用 `waitForTaskCompletion()` 以 100ms 轮询间隔等待任务完成，最长等待 `timeout`（默认 30s）（`TaskOutputTool.tsx:118-143`）
3. 调用 `getTaskOutputData()` 统一输出格式，按任务类型分别处理：
   - `local_bash`：优先从 `shellCommand.taskOutput` 获取 stdout/stderr，回退到磁盘文件
   - `local_agent`：优先使用内存中的 `result.content`（最终回答），而非磁盘上的完整 JSONL 转录（`TaskOutputTool.tsx:91-105`）
   - `remote_agent`：从磁盘获取输出并附加 `prompt` 字段

**返回状态三态：** `success`（任务完成）、`timeout`（等待超时）、`not_ready`（非阻塞且任务仍在运行）

**向后兼容：** 通过 `aliases: ['AgentOutputTool', 'BashOutputTool']` 保持对旧工具名的兼容。当前标记为 **Deprecated**，推荐改用 Read 工具直接读取任务输出文件。

### 2. TaskStopTool — 终止后台任务

**核心流程：**

1. 接受 `task_id` 参数（兼容已废弃的 `shell_id`）
2. `validateInput` 检查任务存在且状态为 `running`（`TaskStopTool.ts:60-91`）
3. 委托 `stopTask()` 执行实际终止操作（`src/tasks/stopTask.js`）
4. 返回被终止任务的 ID、类型和命令描述

通过 `aliases: ['KillShell']` 保持对旧 KillShell 工具名的兼容。

### 3. v2 任务 CRUD 工具集（TaskCreate/Get/Update/List）

这四个工具构成完整的任务管理 CRUD 系统，由 `isTodoV2Enabled()` 特性门控启用。底层通过 `src/utils/tasks.ts` 的 `createTask()`、`getTask()`、`updateTask()`、`listTasks()` 等函数操作任务持久化存储。

#### TaskCreateTool

- 输入：`subject`（标题）、`description`（描述）、`activeForm`（进行时形式，如 "Running tests"）、`metadata`
- 创建后状态默认为 `pending`，自动展开 UI 中的任务列表面板（`TaskCreateTool.ts:116-119`）
- 执行 `executeTaskCreatedHooks()` 钩子，若钩子返回阻塞错误则回滚删除任务（`TaskCreateTool.ts:92-113`）

#### TaskGetTool

- 输入：`taskId`
- 返回完整任务信息：`id`、`subject`、`description`、`status`、`blocks`（阻塞的任务）、`blockedBy`（被阻塞的任务）
- 标记为 `isReadOnly: true`

#### TaskUpdateTool — 最复杂的 CRUD 工具

**可更新字段：** `subject`、`description`、`activeForm`、`status`、`owner`、`metadata`、`addBlocks`、`addBlockedBy`

**状态工作流：** `pending` → `in_progress` → `completed`，另有特殊值 `deleted`

**核心逻辑：**

1. 只更新实际变更的字段（与 `existingTask` 逐一对比）（`TaskUpdateTool.ts:169-211`）
2. `status: 'deleted'` 触发 `deleteTask()` 直接删除并提前返回（`TaskUpdateTool.ts:214-227`）
3. `status: 'completed'` 时执行 `executeTaskCompletedHooks()`，若钩子返回阻塞错误则拒绝完成（`TaskUpdateTool.ts:232-265`）
4. Agent Swarm 模式下自动设置 `owner` 和通过 mailbox 通知新 owner（`TaskUpdateTool.ts:188-199, 277-298`）
5. 依赖管理通过 `blockTask()` 实现双向阻塞关系（`TaskUpdateTool.ts:301-324`）
6. **验证 Nudge 机制**：当主线程 Agent 完成 3+ 个任务但无验证步骤时，提示生成验证 Agent（`TaskUpdateTool.ts:333-349`）

#### TaskListTool

- 无输入参数，返回所有非内部任务（过滤 `metadata._internal`）
- `blockedBy` 自动过滤掉已完成的任务 ID（`TaskListTool.ts:73-83`）
- Agent Swarm 模式下额外返回 teammate 工作流指引

### 4. TodoWriteTool（v1 待办事项）

v1 版本的任务管理，与 v2 CRUD 工具**互斥**——通过 `isEnabled()` 返回 `!isTodoV2Enabled()` 实现（`TodoWriteTool.ts:53-54`）。

- 输入为完整的待办列表数组（`TodoListSchema`），每项包含 `content`、`status`、`activeForm`
- 当所有 todo 标记为 `completed` 时自动清空列表（`TodoWriteTool.ts:69-70`）
- 通过 `appState.todos[key]` 持久化，key 为 `agentId` 或 `sessionId`
- 同样包含验证 Nudge 机制

### 5. 计划模式工具对（EnterPlanMode / ExitPlanMode）

计划模式是 Claude Code 的核心工作流模式，将操作限制为只读探索，让 AI 在编码前充分理解代码库并设计方案。

#### EnterPlanModeTool

**核心流程：**

1. 禁止在 Agent 上下文中使用（`EnterPlanModeTool.ts:78-79`）
2. 调用 `handlePlanModeTransition()` 记录模式转换
3. 通过 `applyPermissionUpdate()` 将权限模式设为 `'plan'`，同时调用 `prepareContextForPlanMode()` 处理 auto 模式的分类器副作用（`EnterPlanModeTool.ts:88-94`）
4. 返回提示信息，指引模型进入只读探索阶段

**可用条件：** 当 `--channels` 激活时禁用（因为退出计划模式需要终端审批对话框，远程通道无法支持）（`EnterPlanModeTool.ts:57-67`）

#### ExitPlanModeV2Tool

这是本模块中逻辑最复杂的工具之一，处理多种退出路径。

**核心流程：**

1. **输入验证**：检查当前确实处于 plan 模式（`ExitPlanModeV2Tool.ts:195-220`）
2. **计划文件处理**：从磁盘读取计划（`getPlan()`），或接受 CCR Web UI 编辑后的计划内容
3. **Teammate 审批路径**：若为 `isPlanModeRequired()` 的 teammate，将计划通过 mailbox 发送给 team-lead 审批，而非本地退出（`ExitPlanModeV2Tool.ts:264-313`）
4. **模式恢复**：从 `prePlanMode` 恢复之前的权限模式
   - 若之前是 auto 模式但 gate 已关闭（circuit breaker），降级为 default 并通知用户（`ExitPlanModeV2Tool.ts:327-355`）
   - 恢复到 auto 模式时保持危险权限的剥离，恢复到非 auto 模式时还原（`ExitPlanModeV2Tool.ts:383-394`）
5. **权限请求**：非 teammate 需要用户确认退出（`requiresUserInteraction()` 返回 true），teammate 则跳过权限 UI

**输入参数：** `allowedPrompts`（可选，语义级别的权限请求，如 "run tests"），以及 SDK 注入的 `plan` 和 `planFilePath`

### 6. Worktree 隔离工具对（EnterWorktree / ExitWorktree）

提供基于 git worktree 的代码隔离环境，让修改操作在独立的工作目录中进行。

#### EnterWorktreeTool

**核心流程：**

1. 检查当前未处于 worktree 会话中（`EnterWorktreeTool.ts:79-81`）
2. 解析到主仓库根目录（处理已在 worktree 内的情况）（`EnterWorktreeTool.ts:84-88`）
3. 调用 `createWorktreeForSession()` 在 `.claude/worktrees/` 下创建新 worktree 和分支
4. 切换进程工作目录并更新全部相关状态：`setCwd`、`setOriginalCwd`、`saveWorktreeState`、清除缓存（`EnterWorktreeTool.ts:94-102`）

**输入参数：** `name`（可选，经 `validateWorktreeSlug` 校验，支持字母数字和有限符号，最长 64 字符）

#### ExitWorktreeTool

**两种退出动作：**

- `keep`：保留 worktree 目录和分支，仅切换回原目录
- `remove`：删除 worktree 和分支

**安全机制（`validateInput`）：**

1. 仅操作当前会话 `EnterWorktree` 创建的 worktree，不触碰手动创建或前次会话的 worktree（`ExitWorktreeTool.ts:180-188`）
2. `remove` 时通过 `countWorktreeChanges()` 检测未提交文件和未合并提交（`ExitWorktreeTool.ts:79-113`）
3. 若有未保存的工作且未设 `discard_changes: true`，拒绝删除并列出变更（`ExitWorktreeTool.ts:203-221`）
4. `countWorktreeChanges()` 返回 `null`（git 命令失败或缺少基准 commit）时采用 **fail-closed** 策略——拒绝操作而非假设安全

**会话恢复（`restoreSessionToOriginalCwd`）：**

- 恢复 `cwd`、`originalCwd`、`projectRoot`（仅在 `--worktree` 启动时设置过的情况下）
- 清除依赖 CWD 的缓存：系统提示词分区、记忆文件缓存、计划目录缓存
- 若 `remove` 且存在 tmux 会话，先 kill tmux 会话

---

## 接口与类型定义

### TaskOutputTool 输出类型

```typescript
type TaskOutput = {
  task_id: string
  task_type: TaskType  // 'local_bash' | 'local_agent' | 'remote_agent'
  status: string
  description: string
  output: string
  exitCode?: number | null  // 仅 local_bash
  prompt?: string           // 仅 agent 类型
  result?: string           // 仅 local_agent
  error?: string
}

type TaskOutputToolOutput = {
  retrieval_status: 'success' | 'timeout' | 'not_ready'
  task: TaskOutput | null
}
```

### v2 任务状态

```typescript
// TaskStatusSchema 定义的状态值
type TaskStatus = 'pending' | 'in_progress' | 'completed'
// TaskUpdate 额外支持
type TaskUpdateStatus = TaskStatus | 'deleted'
```

### ExitPlanMode 输出类型

```typescript
type Output = {
  plan: string | null
  isAgent: boolean
  filePath?: string
  hasTaskTool?: boolean
  planWasEdited?: boolean
  awaitingLeaderApproval?: boolean
  requestId?: string
}
```

---

## 配置项与特性门控

| 特性门控 | 影响范围 |
|---------|---------|
| `isTodoV2Enabled()` | v1（TodoWrite）与 v2（TaskCreate/Get/Update/List）互斥切换 |
| `isAgentSwarmsEnabled()` | 启用 owner 自动设置、teammate mailbox 通知、TaskList 中的 teammate 工作流提示 |
| `VERIFICATION_AGENT` + `tengu_hive_evidence` | 验证 Nudge 机制（3+ 任务完成时提示生成验证 Agent） |
| `KAIROS` / `KAIROS_CHANNELS` + `--channels` | 禁用 Enter/ExitPlanMode（远程通道无法支持审批对话框） |
| `TRANSCRIPT_CLASSIFIER` | ExitPlanMode 中的 auto 模式 gate 和权限恢复逻辑 |
| `isPlanModeInterviewPhaseEnabled()` | 计划模式进入后的指引内容差异 |
| `process.env.USER_TYPE === 'ant'` | 内部/外部用户的提示词差异（EnterPlanMode prompt 有两个版本） |

---

## 边界 Case 与注意事项

- **TaskOutputTool 已标记 Deprecated**：推荐改用 Read 工具直接读取后台任务输出文件路径。不过该工具仍被保留且功能完整。
- **TaskOutputTool 仅对外部用户启用**：`isEnabled()` 检查 `"external" !== 'ant'`（`TaskOutputTool.tsx:164`）。
- **ExitPlanMode 的 validateInput 允许非 plan 模式下的 teammate 调用**：因为 teammate 的 AppState 可能反映 leader 的模式而非自身（`ExitPlanModeV2Tool.ts:198-200`）。
- **ExitWorktree 的 fail-closed 设计**：当 `countWorktreeChanges()` 无法确定 worktree 状态时（git 命令失败、hook-based worktree 无基准 commit），一律拒绝 remove 操作。
- **TaskUpdate 的 hook 阻塞机制**：`executeTaskCompletedHooks()` 返回的阻塞错误会阻止任务标记为 completed，`executeTaskCreatedHooks()` 的阻塞错误会回滚删除刚创建的任务。
- **TodoWrite 自动清空**：当所有 todo 都标记 completed 时，列表自动清空为空数组（`TodoWriteTool.ts:69-70`），这意味着完成的历史不会保留在 appState 中。
- **ExitPlanMode 的 circuit breaker**：如果用户之前处于 auto 模式但在计划期间 circuit breaker 触发，退出计划模式时会降级到 default 模式而非恢复 auto，防止绕过安全机制。