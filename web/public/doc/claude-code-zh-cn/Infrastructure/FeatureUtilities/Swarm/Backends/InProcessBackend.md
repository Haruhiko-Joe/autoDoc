# InProcessBackend

## 概述与职责

`InProcessBackend` 是 Swarm 多 Agent 协调系统中三种 Teammate 执行后端之一，实现了 `TeammateExecutor` 接口。与基于终端面板的后端（Tmux / iTerm2）不同，它让 Teammate 在**同一 Node.js 进程内**运行，通过 `AsyncLocalStorage` 实现上下文隔离。

在整体架构中，该模块位于 **Infrastructure → FeatureUtilities → Swarm → Backends** 层级。它是后端检测优先级链的最后一环——当 Tmux 和 iTerm2 均不可用时，作为兜底方案启用。同级后端包括 `TmuxBackend` 和 `ITermBackend`。

**核心特点**：
- 无外部依赖——`isAvailable()` 始终返回 `true`
- 与 Leader 共享 API 客户端、MCP 连接等资源
- 通信机制与 Pane 后端一致，使用基于文件的 Mailbox
- 生命周期通过 `AbortController` 管理，而非终端 pane 操作

> 源码位置：`src/utils/swarm/backends/InProcessBackend.ts`（339 行）

## 关键流程

### Spawn 流程（创建并启动 Teammate）

1. **前置检查**：验证 `context`（`ToolUseContext`）已通过 `setContext()` 设置，未设置则返回失败结果
2. **调用 `spawnInProcessTeammate()`**：传入 name、teamName、prompt、color、planModeRequired 和 context，该函数负责：
   - 创建 `TeammateContext`（包含 `AsyncLocalStorage` 隔离上下文）
   - 创建独立的 `AbortController`（不与父级关联）
   - 在 `AppState.tasks` 中注册任务
3. **Fire-and-forget 启动 Agent 循环**：spawn 成功后，调用 `startInProcessTeammate()` 启动 Agent 执行循环。注意传入的 `toolUseContext` 会清空 `messages` 数组——Teammate 不需要父级对话历史，`runAgent` 会通过 `createSubagentContext` 覆盖它（`InProcessBackend.ts:122`）
4. **返回结果**：包含 `agentId`、`taskId`、`abortController`

```
setContext(ctx) → spawn(config) → spawnInProcessTeammate() → startInProcessTeammate() [fire-and-forget]
                                         ↓                            ↓
                                  创建 Context + AbortController    启动 Agent 执行循环
                                  注册 AppState.tasks
```

### 消息发送流程

1. 通过 `parseAgentId()` 解析 `agentId`（格式 `agentName@teamName`），提取 `agentName` 和 `teamName`
2. 调用 `writeToMailbox()` 将消息写入对应 Teammate 的文件 Mailbox
3. 消息格式包含 `text`、`from`、`color`、`timestamp` 字段

> 源码位置：`InProcessBackend.ts:150-180`

### 优雅终止流程（terminate）

1. 从 `AppState` 中查找对应 `agentId` 的任务
2. 若已有 `shutdownRequested` 标记，直接返回 `true`（避免重复发送）
3. 生成确定性 `requestId`（`shutdown-${agentId}-${timestamp}`）
4. 通过 `createShutdownRequestMessage()` 创建关闭请求消息
5. 将消息写入 Teammate 的 Mailbox（发送者为 `team-lead`）
6. 调用 `requestTeammateShutdown()` 在任务上设置 `shutdownRequested` 标记

Teammate 收到关闭请求后可以选择批准（退出）或拒绝（继续工作）——这是一个**协商式**关闭流程。

> 源码位置：`InProcessBackend.ts:192-253`

### 强制终止流程（kill）

1. 从 `AppState` 中查找任务
2. 调用 `killInProcessTeammate(taskId, setAppState)` 通过 `AbortController.abort()` 立即取消所有异步操作，并更新任务状态为 `killed`

> 源码位置：`InProcessBackend.ts:261-290`

### 活跃状态检查（isActive）

同时检查两个条件：
- `task.status === 'running'`
- `task.abortController?.signal.aborted` 为 `false`

两者同时满足才返回 `true`。若 `abortController` 不存在，默认视为已 aborted。

> 源码位置：`InProcessBackend.ts:298-330`

## 函数签名与参数说明

### `class InProcessBackend implements TeammateExecutor`

| 属性/方法 | 签名 | 说明 |
|-----------|------|------|
| `type` | `readonly type = 'in-process'` | 后端类型标识 |
| `setContext()` | `(context: ToolUseContext): void` | 设置工具上下文，**必须在 `spawn()` 之前调用** |
| `isAvailable()` | `(): Promise<boolean>` | 始终返回 `true`（无外部依赖） |
| `spawn()` | `(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>` | 创建并启动 Teammate |
| `sendMessage()` | `(agentId: string, message: TeammateMessage): Promise<void>` | 向 Teammate Mailbox 写入消息 |
| `terminate()` | `(agentId: string, reason?: string): Promise<boolean>` | 优雅关闭：发送 shutdown 请求 |
| `kill()` | `(agentId: string): Promise<boolean>` | 强制终止：通过 AbortController 立即中断 |
| `isActive()` | `(agentId: string): Promise<boolean>` | 检查 Teammate 是否仍在运行 |

### `createInProcessBackend(): InProcessBackend`

工厂函数，创建 `InProcessBackend` 实例。供 `registry.ts` 在后端检测时使用。

## 接口/类型定义

### `TeammateExecutor`（实现的接口）

定义于 `src/utils/swarm/backends/types.ts:279-300`，是所有 Teammate 后端的统一抽象，包含 `spawn`、`sendMessage`、`terminate`、`kill`、`isActive` 六个方法。`InProcessBackend` 额外添加了 `setContext()` 方法以注入 `ToolUseContext`。

### `TeammateSpawnConfig`

Spawn 配置，继承自 `TeammateIdentity`，关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Agent 名称（如 "researcher"） |
| `teamName` | `string` | 所属团队名称 |
| `prompt` | `string` | 初始提示词 |
| `color` | `AgentColorName?` | UI 展示颜色 |
| `model` | `string?` | 使用的模型 |
| `systemPrompt` | `string?` | 系统提示词 |
| `systemPromptMode` | `'default' \| 'replace' \| 'append'?` | 系统提示词应用方式 |
| `permissions` | `string[]?` | 授予的工具权限列表 |
| `allowPermissionPrompts` | `boolean?` | 是否允许未列出工具的权限弹窗 |
| `planModeRequired` | `boolean?` | 是否需要 Plan Mode 审批 |

### `TeammateSpawnResult`

Spawn 结果，关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | `boolean` | 是否成功 |
| `agentId` | `string` | 格式 `agentName@teamName` |
| `taskId` | `string?` | AppState.tasks 中的任务 ID（仅进程内后端） |
| `abortController` | `AbortController?` | 生命周期控制器（仅进程内后端） |

### `TeammateMessage`

消息结构，包含 `text`、`from`、`color`、`timestamp`、`summary` 字段。

## 边界 Case 与注意事项

- **`setContext()` 必须在 `spawn()` 前调用**：这是硬性要求。未设置 context 时，`spawn()` 返回失败结果而非抛出异常；`terminate()`、`kill()`、`isActive()` 在无 context 时返回 `false`
- **Fire-and-forget 模式**：`startInProcessTeammate()` 的返回值被忽略，Agent 执行循环在后台独立运行。错误处理由 `inProcessRunner` 内部负责
- **消息清空**：传给 `startInProcessTeammate` 的 `toolUseContext.messages` 被显式清空为 `[]`，避免父级对话历史被 Teammate 长期引用导致内存泄漏
- **重复终止保护**：`terminate()` 检查 `task.shutdownRequested` 标记，避免重复发送 shutdown 请求
- **`agentId` 格式**：必须为 `agentName@teamName`（如 `researcher@my-team`），`parseAgentId()` 解析失败时 `sendMessage()` 会抛出异常
- **terminate vs kill**：`terminate` 是协商式的（Teammate 可以拒绝），`kill` 是立即生效的（通过 `AbortController.abort()`）。两者对应不同的使用场景——正常结束用 `terminate`，紧急情况用 `kill`