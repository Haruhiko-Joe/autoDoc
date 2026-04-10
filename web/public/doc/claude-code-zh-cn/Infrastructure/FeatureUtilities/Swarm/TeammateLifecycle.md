# Teammate 生命周期管理

## 概述与职责

TeammateLifecycle 模块是 Swarm 多 Agent 协调子系统的核心执行层，负责管理进程内 Teammate（队友）从创建到销毁的完整生命周期。它位于 `Infrastructure > FeatureUtilities > Swarm` 层级下，与同级的 Plugins、Hooks、ModelManagement 等模块并列，依赖 ModelManagement 进行模型选择，依赖 CommonUtilities 提供的 AbortController、sleep 等基础能力。

该模块由 5 个文件组成，各自承担不同阶段的职责：

| 文件 | 职责 | 行数 |
|------|------|------|
| `teammateInit.ts` | 初始化 Teammate Hook（空闲通知、权限应用） | ~130 |
| `spawnInProcess.ts` | 创建 TeammateContext、注册 AppState 任务 | ~330 |
| `inProcessRunner.ts` | 核心执行循环（runAgent + Mailbox 轮询 + 权限 + 压缩） | ~1550 |
| `spawnUtils.ts` | 构建继承的 CLI 标志和环境变量 | ~150 |
| `reconnection.ts` | 会话恢复时重建 teamContext | ~120 |

## 关键流程

### 1. Teammate 初始化流程（teammateInit）

当一个 Claude Code 实例作为 Teammate 启动时，`initializeTeammateHooks()` 在 session 启动早期被调用：

1. 读取 team file 获取 `leadAgentId` 和团队配置
2. 如果 team file 中有 `teamAllowedPaths`，遍历并通过 `applyPermissionUpdate()` 将路径权限注入 `AppState.toolPermissionContext`（`src/utils/swarm/teammateInit.ts:45-78`）
3. 判断自身是否为 Leader——如果是则跳过后续 Hook 注册
4. 通过 `addFunctionHook()` 注册一个 **Stop Hook**，当 Teammate session 停止时：
   - 调用 `setMemberActive(teamName, agentName, false)` 将自己标记为非活跃
   - 通过 `writeToMailbox()` 向 Leader 的信箱发送空闲通知（包含最后一条对话摘要）
   - Hook 设置了 10 秒超时，返回 `true` 表示不阻塞 Stop 事件

### 2. 进程内 Spawn 流程（spawnInProcess）

`spawnInProcessTeammate()` 是创建进程内 Teammate 的入口，返回 `InProcessSpawnOutput`：

1. **生成标识**：通过 `formatAgentId(name, teamName)` 生成确定性的 agentId（格式 `name@team`），`generateTaskId('in_process_teammate')` 生成任务 ID
2. **创建 AbortController**：独立于 Leader 的 AbortController，Teammate 不会因 Leader 的查询中断而被终止（`src/utils/swarm/spawnInProcess.ts:122`）
3. **构建 TeammateIdentity 和 TeammateContext**：Identity 是纯数据对象存储在 AppState 中，Context 用于 `AsyncLocalStorage` 上下文隔离
4. **注册 Perfetto Trace**（可选）：用于性能分析的层级可视化
5. **构建 TaskState**：类型为 `InProcessTeammateTaskState`，初始 status 为 `running`，包含 spinner 动词、权限模式、消息队列等字段
6. **注册清理回调**：通过 `registerCleanup()` 确保进程退出时 abort Teammate
7. **注册到 AppState**：调用 `registerTask(taskState, setAppState)`

`killInProcessTeammate()` 是对应的销毁函数：abort 控制器 → 清理回调 → 更新 teamContext.teammates → 设置 status 为 `killed` → 从 team file 移除成员 → 释放 Perfetto 注册 → 延迟回收 UI 显示。

### 3. 核心执行循环（inProcessRunner）

`runInProcessTeammate()` 是整个模块最核心的函数（~650 行），封装了 Teammate 的持续运行循环：

#### 3.1 初始化阶段

```
构建 AgentContext → 构建 System Prompt → 解析 Agent Definition → 包装初始 Prompt
```

- **System Prompt** 支持三种模式：`replace`（完全替换）、`append`（追加到默认 prompt 后）、`default`（使用默认 + Teammate 附加信息）（`src/utils/swarm/inProcessRunner.ts:924-970`）
- **Agent Definition** 始终注入团队协调必需的工具（SendMessage、TeamCreate/Delete、TaskCreate/Get/List/Update），即使自定义 Agent 定义了限定工具列表（`src/utils/swarm/inProcessRunner.ts:982-995`）
- 权限模式强制设为 `default`，确保 Teammate 拥有完整工具访问权，不受 Leader 权限模式影响

#### 3.2 主循环（while 循环）

每次迭代的流程：

1. **创建 per-turn AbortController**（`currentWorkAbortController`）：允许用户按 Escape 中止当前工作而不杀死整个 Teammate
2. **自动压缩检查**：当累积 token 数超过 `getAutoCompactThreshold()` 时，在隔离的 `ToolUseContext` 中调用 `compactConversation()`，压缩后重置 microcompact 状态和 content replacement 状态（`src/utils/swarm/inProcessRunner.ts:1073-1126`）
3. **执行 `runAgent()`**：在 `runWithTeammateContext()` + `runWithAgentContext()` 双层上下文内运行，流式处理每条消息：
   - 更新进度追踪器（`updateProgressFromMessage`）
   - 维护 `inProgressToolUseIDs` 集合（用于 UI 动画）
   - 同步消息到 `task.messages`
4. **空闲通知**：Agent 完成当前 prompt 后，标记 `isIdle: true`，通过文件信箱向 Leader 发送空闲通知
5. **等待下一个 Prompt**：进入 `waitForNextPromptOrShutdown()` 轮询循环

#### 3.3 消息轮询（waitForNextPromptOrShutdown）

轮询间隔 500ms，按优先级处理三种消息来源：

1. **内存中的 `pendingUserMessages`**（最高优先级）：来自 UI 的直接用户输入
2. **文件信箱消息**，按以下优先级：
   - **Shutdown 请求**：最高优先级，即使前面有未读消息也优先处理
   - **Leader 消息**：优先于 Peer 消息（`msg.from === TEAM_LEAD_NAME`）
   - **Peer 消息**：FIFO 顺序
3. **任务列表**（最低优先级）：通过 `tryClaimNextTask()` 尝试认领未分配的待办任务

#### 3.4 权限处理（createInProcessCanUseTool）

`canUseTool` 回调实现了两条权限审批路径（`src/utils/swarm/inProcessRunner.ts:128-451`）：

**主路径——Leader UI 桥接**：当 `getLeaderToolUseConfirmQueue()` 可用时，将权限请求推入 Leader 的 ToolUseConfirm 队列，显示带有 Worker 徽章的标准权限对话框。支持 allow/reject/recheck，权限更新通过 `getLeaderSetToolPermissionContext()` 回写到 Leader 的共享上下文。

**回退路径——Mailbox 轮询**：当 UI 桥接不可用时，通过 `sendPermissionRequestViaMailbox()` 发送请求到 Leader 信箱，每 500ms 轮询自己的信箱等待响应，通过 `processMailboxPermissionResponse()` 处理结果。

两条路径都支持：
- Bash 命令分类器自动审批（`awaitClassifierAutoApproval`，需 `BASH_CLASSIFIER` 特性门控）
- Abort 信号取消等待

### 4. CLI 标志与环境变量继承（spawnUtils）

为 Tmux/iTerm2 等外部进程 Teammate 提供配置传播：

**`buildInheritedCliFlags()`** 构建的 CLI 标志：
- `--dangerously-skip-permissions`（仅在非 Plan Mode 且 Leader 有此权限时）
- `--permission-mode acceptEdits`
- `--model`（如果 Leader 显式设置了模型）
- `--settings`（自定义设置文件路径）
- `--plugin-dir`（每个内联插件目录）
- `--teammate-mode`（从 snapshot 读取当前模式）
- `--chrome` / `--no-chrome`

**`buildInheritedEnvVars()`** 始终包含 `CLAUDECODE=1` 和 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，并转发约 16 个关键环境变量（API Provider、代理、证书、远程会话等）。

### 5. 断线重连（reconnection）

提供两种场景下的 teamContext 恢复：

**`computeInitialTeamContext()`**：在 `main.tsx` 首次渲染前同步调用，从 `getDynamicTeamContext()` 获取 CLI 参数中的团队信息，读取 team file 构建初始 `teamContext`。通过 `!agentId` 判断是否为 Leader。

**`initializeTeammateContextFromSession()`**：在恢复已有 session 时调用，从 session 记录中的 `teamName` 和 `agentName` 重建 `teamContext`，确保 heartbeat 和其他 Swarm 功能正常工作。

## 函数签名

### `initializeTeammateHooks(setAppState, sessionId, teamInfo): void`

注册 Stop Hook 以在 Teammate 停止时发送空闲通知。

- **setAppState**：`(updater: (prev: AppState) => AppState) => void` — 状态更新器
- **sessionId**：`string` — 当前 session ID
- **teamInfo**：`{ teamName, agentId, agentName }` — 团队与身份信息

> 源码位置：`src/utils/swarm/teammateInit.ts:28-129`

### `spawnInProcessTeammate(config, context): Promise<InProcessSpawnOutput>`

创建进程内 Teammate 并注册到 AppState。

- **config**：`InProcessSpawnConfig` — 包含 name、teamName、prompt、planModeRequired 等
- **context**：`SpawnContext` — 包含 setAppState 和可选的 toolUseId
- **返回**：包含 success、agentId、taskId、abortController、teammateContext

> 源码位置：`src/utils/swarm/spawnInProcess.ts:104-216`

### `killInProcessTeammate(taskId, setAppState): boolean`

终止进程内 Teammate：abort 控制器 → 清理状态 → 移除团队成员。

> 源码位置：`src/utils/swarm/spawnInProcess.ts:227-328`

### `runInProcessTeammate(config): Promise<InProcessRunnerResult>`

核心执行循环。在 AsyncLocalStorage 上下文中运行 runAgent()，支持多轮 Prompt、自动压缩、权限审批。

- **config**：`InProcessRunnerConfig` — 包含 identity、taskId、prompt、teammateContext、toolUseContext、abortController、model、systemPrompt/Mode、allowedTools 等
- **返回**：`{ success, error?, messages }`

> 源码位置：`src/utils/swarm/inProcessRunner.ts:883-1534`

### `startInProcessTeammate(config): void`

fire-and-forget 入口，内部调用 `runInProcessTeammate()` 并捕获未处理异常。

> 源码位置：`src/utils/swarm/inProcessRunner.ts:1544-1552`

### `computeInitialTeamContext(): AppState['teamContext'] | undefined`

同步计算初始 teamContext，在首次渲染前调用。

> 源码位置：`src/utils/swarm/reconnection.ts:23-66`

### `initializeTeammateContextFromSession(setAppState, teamName, agentName): void`

从已恢复的 session 中重建 teamContext。

> 源码位置：`src/utils/swarm/reconnection.ts:75-119`

## 接口/类型定义

### `InProcessSpawnConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| name | string | 显示名称，如 "researcher" |
| teamName | string | 所属团队 |
| prompt | string | 初始任务 Prompt |
| color | string? | UI 颜色标识 |
| planModeRequired | boolean | 是否必须进入 Plan Mode |
| model | string? | 模型覆盖 |

### `InProcessRunnerConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| identity | TeammateIdentity | 身份信息 |
| taskId | string | AppState 中的任务 ID |
| prompt | string | 初始 Prompt |
| agentDefinition | CustomAgentDefinition? | 自定义 Agent 定义 |
| teammateContext | TeammateContext | AsyncLocalStorage 上下文 |
| toolUseContext | ToolUseContext | 父级工具上下文 |
| abortController | AbortController | 生命周期控制器 |
| model | string? | 模型覆盖 |
| systemPrompt | string? | 自定义 system prompt |
| systemPromptMode | 'default' \| 'replace' \| 'append' | prompt 应用方式 |
| allowedTools | string[]? | 允许的工具白名单 |
| allowPermissionPrompts | boolean? | 是否允许弹出权限确认（默认 true） |
| description | string? | 任务简述 |
| invokingRequestId | string? | 父 API 请求 ID |

### `WaitResult`（联合类型）

- `{ type: 'shutdown_request', request, originalMessage }` — 收到 Leader 的关闭请求
- `{ type: 'new_message', message, from, color?, summary? }` — 收到新消息
- `{ type: 'aborted' }` — 被 abort 信号终止

## 配置项与默认值

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `PERMISSION_POLL_INTERVAL_MS` | 500ms | 权限响应轮询间隔 |
| 消息等待轮询间隔 | 500ms | `waitForNextPromptOrShutdown` 中的 Mailbox 检查频率 |
| Stop Hook 超时 | 10000ms | 空闲通知写入的超时时间 |
| `STOPPED_DISPLAY_MS` | 来自 framework.ts | Kill 后 UI 任务条保留显示时长 |
| `TEAMMATE_COMMAND_ENV_VAR` | 环境变量 | 覆盖 Teammate 启动命令的可执行路径 |

## 边界 Case 与注意事项

- **双层 Abort 机制**：`abortController` 控制整个 Teammate 生命周期，`currentWorkAbortController` 控制单次工作迭代。用户按 Escape 仅中止当前工作，Teammate 回到空闲状态继续等待新任务。
- **Plan Mode 与权限冲突**：当 `planModeRequired = true` 时，`buildInheritedCliFlags()` 不会继承 Leader 的 `bypassPermissions` 模式，确保 Plan Mode 的安全约束优先。
- **Leader 消息优先级**：Mailbox 轮询中 Leader 消息优先于 Peer 消息，Shutdown 请求优先于所有消息，防止在消息洪泛时 Leader 指令被饿死。
- **权限回写隔离**：Teammate 通过 UI 桥接获得的权限更新回写到 Leader 时会 `preserveMode: true`，防止 Teammate 的 `acceptEdits` 模式泄漏到 Leader 上下文。
- **压缩后状态重置**：自动压缩后会重置 `microcompactState` 和 `contentReplacementState`，因为旧的 tool_use_id 已不存在。同时同步更新 `task.messages` 防止内存无限增长。
- **Kill 时的防重复**：`killInProcessTeammate()` 和正常退出路径都会检查 `task.status !== 'running'`，避免双重设置终态或重复发射 SDK 事件。
- **Team file 不存在**：`initializeTeammateHooks()` 和 `computeInitialTeamContext()` 在 team file 读取失败时静默返回，不会崩溃。
- **重连时成员已移除**：`initializeTeammateContextFromSession()` 在 team file 中找不到对应成员时仍能继续（agentId 为 undefined），仅输出 debug 日志。