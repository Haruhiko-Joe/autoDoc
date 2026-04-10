# 工具权限管理子系统（ToolPermission）

## 概述与职责

ToolPermission 是 Claude Code 终端 UI 层（TerminalUI → Hooks）中的**工具权限管理子系统**，负责在 AI 模型请求调用工具时，决定是否允许执行。它是用户安全的最后一道防线——每次 Bash 命令执行、文件写入、代码编辑等操作都必须通过该子系统的权限审批。

在整体架构中，ToolPermission 属于 **Hooks** 模块，与 UIComponents（权限确认弹窗）、StateAndContext（AppState 全局状态）紧密协作。它的兄弟模块包括 useTextInput、useVimInput、useRemoteSession 等 80+ 个 React 自定义 Hooks。

该子系统包含两层：
- **PermissionContext**：权限上下文工厂，封装单次权限决策所需的全部状态和操作方法
- **handlers/**：三种权限处理策略（交互式、Swarm Worker、Coordinator），适配不同运行模式
- **permissionLogging**：权限决策的审计日志，统一输出到 Analytics、OTel 和代码编辑指标

## 关键流程

### 权限决策主流程

当模型请求使用某个工具时，权限系统执行以下决策链：

1. **创建 PermissionContext**：调用 `createPermissionContext()` 封装当前工具、输入参数、消息上下文等信息（`PermissionContext.ts:96-348`）
2. **策略分发**：根据运行模式选择处理器：
   - **Swarm Worker 模式**：`handleSwarmWorkerPermission()` 将请求转发给 Leader 节点
   - **Coordinator 模式**：`handleCoordinatorPermission()` 先跑自动化检查，未通过则回退到交互式
   - **交互式模式**（默认）：`handleInteractivePermission()` 弹出权限确认弹窗
3. **多路竞赛**：交互式模式下，最多 4 个决策源并行竞赛，先到先得：
   - 用户在终端点击允许/拒绝
   - Permission Hook 返回结果
   - Bash Classifier 自动审批
   - Bridge（CCR/claude.ai）远程响应
   - Channel（Telegram/iMessage 等）远程响应
4. **日志记录**：通过 `logPermissionDecision()` 记录决策结果

### 交互式权限确认流程（interactiveHandler）

这是最复杂的路径，处理用户直接面对的权限弹窗场景：

1. 调用 `ctx.pushToQueue()` 将一个 `ToolUseConfirm` 条目推入 React 状态队列，触发 UI 渲染权限弹窗
2. 弹窗注册 4 个回调：`onAllow`、`onReject`、`onAbort`、`recheckPermission`
3. 同时异步启动 Hook 检查和 Bash Classifier 检查（`interactiveHandler.ts:411-530`）
4. 使用 `createResolveOnce()` 的 `claim()` 机制保证**只有一个决策源**能胜出——原子性地检查并标记为已解决
5. 用户交互（按键、Tab 切换）触发 `onUserInteraction()`，取消 Classifier 自动审批资格（200ms 宽限期）
6. Classifier 自动批准后，显示勾号标记 3 秒（终端聚焦）或 1 秒（后台），用户可按 Esc 提前关闭

### Swarm Worker 权限委托流程

当 Claude Code 作为 Swarm 的工作节点运行时（`swarmWorkerHandler.ts:40-156`）：

1. 检查 `isAgentSwarmsEnabled()` && `isSwarmWorker()`，不满足则返回 `null`
2. 对 Bash 命令先尝试 Classifier 自动审批
3. 通过 `createPermissionRequest()` 创建请求，经 `sendPermissionRequestViaMailbox()` 转发给 Leader
4. 用 `registerPermissionCallback()` 注册回调，等待 Leader 的允许/拒绝响应
5. 同时在 AppState 中设置 `pendingWorkerRequest` 展示等待指示器
6. 监听 abort 信号，避免 Promise 永久挂起

### Coordinator 权限预检流程

Coordinator 模式下的预检逻辑最为简洁（`coordinatorHandler.ts:26-62`）：

1. **先跑 Hook**：`ctx.runHooks()` 执行本地权限钩子
2. **再跑 Classifier**：对 Bash 命令尝试 Classifier 自动审批
3. 两者都未决策则返回 `null`，调用方回退到交互式弹窗
4. 关键区别：这里的检查是**顺序执行**的（await），而非与 UI 竞赛

## 函数签名与参数说明

### `createPermissionContext()`

创建一个冻结的权限上下文对象，封装单次工具权限决策的全部能力。

```typescript
function createPermissionContext(
  tool: ToolType,                    // 请求使用的工具定义
  input: Record<string, unknown>,    // 工具调用的输入参数
  toolUseContext: ToolUseContext,     // 工具使用上下文（含 abortController、appState 等）
  assistantMessage: AssistantMessage, // 触发本次工具调用的助手消息
  toolUseID: string,                 // 唯一标识本次工具调用
  setToolPermissionContext: (ctx: ToolPermissionContext) => void, // 权限配置更新回调
  queueOps?: PermissionQueueOps,     // 可选的 UI 队列操作（React 模式下提供）
): PermissionContext
```

> 源码位置：`PermissionContext.ts:96-348`

### `handleInteractivePermission()`

处理交互式权限确认，不返回 Promise——通过 `resolve` 回调异步解决。

```typescript
function handleInteractivePermission(
  params: InteractivePermissionParams,
  resolve: (decision: PermissionDecision) => void,
): void
```

> 源码位置：`handlers/interactiveHandler.ts:57-536`

### `handleSwarmWorkerPermission()`

处理 Swarm Worker 模式的权限委托。返回 `null` 表示不适用，调用方应回退到交互式。

```typescript
async function handleSwarmWorkerPermission(
  params: SwarmWorkerPermissionParams,
): Promise<PermissionDecision | null>
```

> 源码位置：`handlers/swarmWorkerHandler.ts:40-156`

### `handleCoordinatorPermission()`

处理 Coordinator 模式的自动化预检。返回 `null` 表示需要回退到交互式弹窗。

```typescript
async function handleCoordinatorPermission(
  params: CoordinatorPermissionParams,
): Promise<PermissionDecision | null>
```

> 源码位置：`handlers/coordinatorHandler.ts:26-62`

### `logPermissionDecision()`

权限决策日志的统一入口，扇出到 Analytics、OTel、代码编辑指标计数器。

```typescript
function logPermissionDecision(
  ctx: PermissionLogContext,          // 工具名、输入、消息 ID 等上下文
  args: PermissionDecisionArgs,       // 决策结果（accept/reject）和来源
  permissionPromptStartTimeMs?: number, // 弹窗开始时间，用于计算用户等待时长
): void
```

> 源码位置：`permissionLogging.ts:181-235`

## 接口/类型定义

### `PermissionApprovalSource`

描述权限被批准的来源：

| type | 含义 | 附加字段 |
|------|------|----------|
| `'hook'` | 由 Permission Hook 自动批准 | `permanent?: boolean` |
| `'user'` | 用户手动批准 | `permanent: boolean`（是否保存为永久规则） |
| `'classifier'` | Bash Classifier 自动批准 | 无 |

### `PermissionRejectionSource`

描述权限被拒绝的来源：

| type | 含义 | 附加字段 |
|------|------|----------|
| `'hook'` | 由 Permission Hook 拒绝 | 无 |
| `'user_abort'` | 用户中止操作 | 无 |
| `'user_reject'` | 用户主动拒绝 | `hasFeedback: boolean` |

### `PermissionQueueOps`

解耦自 React 的权限队列操作接口，支持推入、移除、更新弹窗条目：

```typescript
type PermissionQueueOps = {
  push(item: ToolUseConfirm): void
  remove(toolUseID: string): void
  update(toolUseID: string, patch: Partial<ToolUseConfirm>): void
}
```

> 源码位置：`PermissionContext.ts:57-61`

### `ResolveOnce<T>`

保证 Promise 只被解决一次的竞态守卫：

```typescript
type ResolveOnce<T> = {
  resolve(value: T): void      // 解决 Promise（重复调用无效）
  isResolved(): boolean         // 查询是否已解决
  claim(): boolean              // 原子性地检查并标记——赢得竞赛返回 true
}
```

> 源码位置：`PermissionContext.ts:63-73`

### `PermissionDecisionArgs`

决策日志的判别联合类型——`accept` 对应批准源，`reject` 对应拒绝源：

```typescript
type PermissionDecisionArgs =
  | { decision: 'accept'; source: PermissionApprovalSource | 'config' }
  | { decision: 'reject'; source: PermissionRejectionSource | 'config' }
```

> 源码位置：`permissionLogging.ts:29-31`

## 配置项与默认值

- **Bash Classifier**：通过 `feature('BASH_CLASSIFIER')` 和 `feature('TRANSCRIPT_CLASSIFIER')` 特性门控启用/禁用
- **Channel 权限转发**：通过 `feature('KAIROS')` 或 `feature('KAIROS_CHANNELS')` 特性门控
- **Classifier 交互宽限期**：200ms（`interactiveHandler.ts:115`），用户在此期间的按键不会取消 Classifier
- **Checkmark 显示时长**：终端聚焦时 3000ms，后台时 1000ms（`interactiveHandler.ts:509`）
- **代码编辑工具列表**：`['Edit', 'Write', 'NotebookEdit']`（`permissionLogging.ts:33`），这些工具的权限决策会额外记录语言指标

## 边界 Case 与注意事项

- **竞态安全**：`createResolveOnce()` 的 `claim()` 方法是整个子系统的核心设计——在 async callback 中 **await 之前**调用 `claim()` 来关闭 `isResolved()` 检查和实际 `resolve()` 之间的竞态窗口（`PermissionContext.ts:67-72`）。所有 handler 的 `onAllow`、`onReject`、hook 回调、classifier 回调均遵循此模式。

- **Abort 信号传播**：所有等待中的权限 Promise 都监听 `abortController.signal`，确保取消操作时不会产生 Promise 泄漏。Swarm Worker 特别注意了这一点（`swarmWorkerHandler.ts:137-146`）。

- **Channel 权限的局限**：Channel（Telegram/iMessage）回复仅支持简单的 yes/no，不支持 `updatedInput`。需要用户交互的工具（`ExitPlanMode`、`AskUserQuestion`、`ReviewArtifact`）在 Channel 模式下会被跳过（`interactiveHandler.ts:307-311`）。

- **Coordinator vs Interactive 的 Hook/Classifier 时序**：Coordinator 模式下 Hook 和 Classifier 是**顺序 await** 后才可能进入弹窗；交互式模式下则是**并行竞赛**。通过 `awaitAutomatedChecksBeforeDialog` 标志避免重复执行（`interactiveHandler.ts:411`）。

- **子 Agent 的拒绝消息差异**：当工具调用来自子 Agent（`toolUseContext.agentId` 存在）时，拒绝消息使用 `SUBAGENT_REJECT_MESSAGE` 前缀，且不会触发 abort——子 Agent 的拒绝不应中止整个会话（`PermissionContext.ts:159-172`）。

- **Bridge 远程审批的降级**：CCR（claude.ai）的通用 allow/deny 弹窗可处理所有工具，但部分工具（如 `ReviewArtifact`）在远程批准时缺少特定字段（如 `selected`），设计上容忍字段缺失而非抛错（`interactiveHandler.ts:240-243`）。

- **日志扇出架构**：`logPermissionDecision()` 同时写入 4 个目标——Statsig Analytics 事件、OTel 遥测、代码编辑 OTel 计数器（仅 Edit/Write/NotebookEdit）、以及 `toolUseContext.toolDecisions` Map（供下游代码内省）。