# PaneBackendExecutor

## 概述与职责

`PaneBackendExecutor` 是 Swarm 多 Agent 协调系统中的**适配器类**，负责将低层的 `PaneBackend` 接口（面向终端 Pane 操作）包装为高层的 `TeammateExecutor` 接口（面向 Teammate 生命周期管理）。

在系统架构中，它位于 **Infrastructure → FeatureUtilities → Swarm → Backends** 层级。Backends 子系统定义了三种执行后端——Tmux、iTerm2 和 InProcess。其中 Tmux 和 iTerm2 属于"基于终端 Pane"的后端，它们只实现了 `PaneBackend` 接口（创建 Pane、发送命令、销毁 Pane 等低层操作）。`PaneBackendExecutor` 在此之上桥接，使这两种后端可以通过与 `InProcessBackend` 相同的 `TeammateExecutor` 统一抽象被上层代码使用，实现后端的透明切换。

> 源码位置：`src/utils/swarm/backends/PaneBackendExecutor.ts`（354 行）

## 关键流程

### spawn 流程：创建并启动一个 Pane-Based Teammate

这是本模块最核心的方法，完整流程如下：

1. **格式化 Agent ID**：调用 `formatAgentId(name, teamName)` 生成 `agentName@teamName` 格式的唯一标识（`PaneBackendExecutor.ts:80`）
2. **前置检查**：确认 `context`（`ToolUseContext`）已通过 `setContext()` 设置，否则返回失败（`PaneBackendExecutor.ts:82-92`）
3. **分配颜色**：使用 `config.color` 或调用 `assignTeammateColor(agentId)` 从颜色轮中分配一个唯一颜色（`PaneBackendExecutor.ts:96`）
4. **创建 Pane**：调用底层 `backend.createTeammatePaneInSwarmView(name, color)` 创建终端 Pane，返回 `paneId` 和 `isFirstTeammate` 标记（`PaneBackendExecutor.ts:99-103`）
5. **检测 tmux 环境**：调用 `isInsideTmux()` 判断当前是否运行在 tmux 内部，这决定了后续命令发送是否需要使用外部 session socket（`PaneBackendExecutor.ts:106`）
6. **首个 Teammate 特殊处理**：如果是第一个 Teammate 且在 tmux 内部，启用 Pane 边框状态显示（`PaneBackendExecutor.ts:109-111`）
7. **构建 CLI 命令**：
   - 获取 Claude Code 二进制路径 `getTeammateCommand()`（`PaneBackendExecutor.ts:114`）
   - 构建 Teammate 身份标志：`--agent-id`、`--agent-name`、`--team-name`、`--agent-color`、`--parent-session-id`，以及可选的 `--plan-mode-required`（`PaneBackendExecutor.ts:117-126`）
   - 构建继承的 CLI 标志（权限模式等），通过 `buildInheritedCliFlags()`（`PaneBackendExecutor.ts:129-133`）
   - 若配置了自定义模型，替换或追加 `--model` 标志（`PaneBackendExecutor.ts:136-146`）
   - 构建继承的环境变量字符串，通过 `buildInheritedEnvVars()`（`PaneBackendExecutor.ts:152`）
   - 最终拼装完整命令：`cd <cwd> && env <envVars> <binary> <teammateArgs> <flags>`（`PaneBackendExecutor.ts:154`）
8. **发送命令到 Pane**：调用 `backend.sendCommandToPane(paneId, command, useExternalSession)`（`PaneBackendExecutor.ts:158`）
9. **注册 agentId→paneId 映射**：保存到 `spawnedTeammates` Map 中，同时记录 `insideTmux` 状态供后续 kill 时使用（`PaneBackendExecutor.ts:161`）
10. **注册进程退出清理回调**：首次 spawn 时通过 `registerCleanup()` 注册清理函数，在 Leader 进程退出（如 SIGHUP）时遍历并销毁所有已 spawn 的 Pane（`PaneBackendExecutor.ts:164-175`）
11. **通过 Mailbox 发送初始 Prompt**：调用 `writeToMailbox()` 将初始指令写入文件 Mailbox，Teammate 进程启动后会轮询读取（`PaneBackendExecutor.ts:178-186`）
12. **返回成功结果**：包含 `agentId` 和 `paneId`（`PaneBackendExecutor.ts:192-196`）

### sendMessage 流程：通过 Mailbox 发送消息

1. 调用 `parseAgentId(agentId)` 解析出 `agentName` 和 `teamName`（`PaneBackendExecutor.ts:221-228`）
2. 调用 `writeToMailbox(agentName, message, teamName)` 将消息写入目标 Teammate 的文件 Mailbox（`PaneBackendExecutor.ts:230-239`）

### terminate 流程：优雅终止

1. 解析 `agentId` 获取 `agentName` 和 `teamName`（`PaneBackendExecutor.ts:257-265`）
2. 构造 `shutdown_request` 消息（包含 `type`、`requestId`、`from`、`reason`）（`PaneBackendExecutor.ts:268-273`）
3. 通过 `writeToMailbox()` 发送关闭请求，由 Teammate 进程自行处理退出（`PaneBackendExecutor.ts:275-283`）

### kill 流程：强制销毁

1. 从 `spawnedTeammates` Map 中查找 `paneId`（`PaneBackendExecutor.ts:298-304`）
2. 调用 `backend.killPane(paneId, useExternalSession)` 直接销毁 Pane（`PaneBackendExecutor.ts:310`）
3. 成功后从映射中删除该条目（`PaneBackendExecutor.ts:313`）

## 类/接口定义

### `PaneBackendExecutor` 类

实现 `TeammateExecutor` 接口，内部持有以下状态：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `BackendType` | 后端类型（`'tmux'` 或 `'iterm2'`），继承自底层 backend |
| `backend` | `PaneBackend` | 被适配的低层 Pane 后端实例 |
| `context` | `ToolUseContext \| null` | 工具使用上下文，提供 AppState 和权限信息 |
| `spawnedTeammates` | `Map<string, { paneId: string; insideTmux: boolean }>` | agentId 到 paneId 的映射，同时记录 tmux 环境状态 |
| `cleanupRegistered` | `boolean` | 标记是否已注册进程退出清理回调，确保只注册一次 |

### 公开方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `setContext` | `(context: ToolUseContext): void` | 设置工具上下文，**必须在 spawn() 前调用** |
| `isAvailable` | `(): Promise<boolean>` | 委托给底层 backend 检查可用性 |
| `spawn` | `(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>` | 创建 Pane 并启动 Teammate 进程 |
| `sendMessage` | `(agentId: string, message: TeammateMessage): Promise<void>` | 通过文件 Mailbox 发送消息 |
| `terminate` | `(agentId: string, reason?: string): Promise<boolean>` | 通过 Mailbox 发送优雅关闭请求 |
| `kill` | `(agentId: string): Promise<boolean>` | 强制销毁 Pane |
| `isActive` | `(agentId: string): Promise<boolean>` | 检查 Teammate 是否存活（当前实现仅检查映射中是否存在记录） |

### 工厂函数

```typescript
export function createPaneBackendExecutor(backend: PaneBackend): PaneBackendExecutor
```

简单的工厂函数，创建并返回一个 `PaneBackendExecutor` 实例（`PaneBackendExecutor.ts:350-354`）。

## 关键依赖

| 依赖模块 | 用途 |
|----------|------|
| `spawnUtils.buildInheritedCliFlags` / `buildInheritedEnvVars` / `getTeammateCommand` | 构建 Teammate 进程的 CLI 命令、标志和环境变量 |
| `teammateLayoutManager.assignTeammateColor` | 从颜色轮中分配唯一颜色 |
| `teammateMailbox.writeToMailbox` | 文件 Mailbox 写入，所有 Pane-Based 通信的底层机制 |
| `agentId.formatAgentId` / `parseAgentId` | Agent ID 的格式化（`name@team`）和解析 |
| `cleanupRegistry.registerCleanup` | 注册进程退出时的清理回调 |
| `detection.isInsideTmux` | 检测当前是否运行在 tmux 会话内 |
| `bash/shellQuote.quote` | Shell 参数安全转义 |

## 边界 Case 与注意事项

- **context 未设置时 spawn 会失败**：`setContext()` 必须在 `spawn()` 之前调用，否则返回 `{ success: false }` 而不是抛出异常（`PaneBackendExecutor.ts:82-92`）
- **isActive 的局限性**：当前 `isActive()` 仅检查内部 Map 中是否存在记录，并不实际查询 Pane 是否存活。代码注释明确指出这是 best-effort 检查——Pane 可能存在但内部进程已退出（`PaneBackendExecutor.ts:340-343`）
- **清理回调只注册一次**：通过 `cleanupRegistered` 标志确保 `registerCleanup` 只调用一次，即使 spawn 多个 Teammate（`PaneBackendExecutor.ts:164`）
- **tmux 内外的命令发送差异**：`insideTmux` 状态决定是否使用外部 session socket。在 tmux 外部运行时（external swarm session 模式），需要通过外部 socket 与 tmux 服务器通信（`PaneBackendExecutor.ts:158`）
- **自定义模型标志的处理**：当 `config.model` 存在时，会先从继承的标志中过滤掉已有的 `--model` 标志再追加新的，避免重复（`PaneBackendExecutor.ts:137-146`）
- **terminate 与 kill 的区别**：`terminate` 是协作式的——发送 Mailbox 消息让 Teammate 自行退出；`kill` 是强制的——直接销毁 Pane 进程。`kill` 成功后会清理内部映射，`terminate` 不会