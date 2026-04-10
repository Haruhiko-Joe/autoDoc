# PermissionSync — 跨 Agent 权限协调系统

## 概述与职责

PermissionSync 是 Swarm（多 Agent 协调）子系统中的**权限同步模块**，负责在 Worker Agent 与 Leader Agent 之间协调权限请求和审批。当 Worker 执行工具（如 Bash、Edit）时若缺少权限，它不会直接弹出确认对话框，而是将请求转发给 Leader，由 Leader 的 UI 展示给用户进行审批，然后将审批结果回传给 Worker。

该模块位于 `Infrastructure → FeatureUtilities → Swarm` 层级下，与同级的 ComputerUse、Plugins、Hooks 等子系统并列。它依赖 ConfigAndSettings 获取团队配置，依赖 PermissionsAndAuth 提供权限类型定义。

模块由两个文件组成：
- **`permissionSync.ts`** — 核心权限同步引擎，包含文件目录和 Mailbox 两种通信通道
- **`leaderPermissionBridge.ts`** — 进程内桥接器，让 in-process Teammate 复用 REPL 的权限确认队列

## 关键流程

### 流程一：基于文件目录的权限请求（File-Based Channel）

这是原始的权限同步通道，通过文件系统中的 `pending/` 和 `resolved/` 目录进行通信：

1. **Worker 创建请求**：调用 `createPermissionRequest()` 构建 `SwarmPermissionRequest` 对象，包含工具名、工具输入、描述和权限建议（`src/utils/swarm/permissionSync.ts:167-207`）
2. **Worker 写入 pending**：调用 `writePermissionRequest()` 在 `~/.claude/teams/{teamName}/permissions/pending/{requestId}.json` 写入请求文件，使用 `lockfile.lock()` 保证原子性（`src/utils/swarm/permissionSync.ts:215-250`）
3. **Leader 轮询 pending**：调用 `readPendingPermissions()` 扫描 pending 目录，用 Zod Schema 校验每个 JSON 文件，按 `createdAt` 升序返回（`src/utils/swarm/permissionSync.ts:256-312`）
4. **用户在 Leader UI 审批**：Leader 将请求展示给用户（通过 TerminalUI 的权限确认组件）
5. **Leader 写入 resolved**：调用 `resolvePermission()` 将审批结果写入 `resolved/{requestId}.json`，同时删除 `pending/{requestId}.json`，全过程加文件锁（`src/utils/swarm/permissionSync.ts:360-443`）
6. **Worker 轮询 resolved**：调用 `pollForResponse()` 检查 resolved 目录，获取简化的 `PermissionResponse` 格式（`src/utils/swarm/permissionSync.ts:544-564`）
7. **Worker 清理**：处理完响应后调用 `removeWorkerResponse()` 删除 resolved 文件

### 流程二：基于 Mailbox 的权限请求（Mailbox Channel）

这是较新的通信通道，通过 Teammate Mailbox 系统传递消息，支持进程内和文件两种路由方式：

1. **Worker 发送请求**：调用 `sendPermissionRequestViaMailbox()`，先通过 `getLeaderName()` 从团队文件查找 Leader 名称，再通过 `writeToMailbox()` 将权限请求消息发送到 Leader 的邮箱（`src/utils/swarm/permissionSync.ts:676-722`）
2. **Leader 接收并审批**：Leader 的邮箱轮询机制检测到权限请求消息
3. **Leader 发送响应**：调用 `sendPermissionResponseViaMailbox()` 将审批结果发送到 Worker 的邮箱（`src/utils/swarm/permissionSync.ts:734-783`）

### 流程三：沙箱网络权限请求（Sandbox Permission）

专门处理沙箱运行时的网络访问权限请求，也通过 Mailbox 通道通信：

1. **Worker 请求网络访问**：调用 `sendSandboxPermissionRequestViaMailbox(host, requestId)`，发送包含目标 host 的请求到 Leader 邮箱（`src/utils/swarm/permissionSync.ts:805-869`）
2. **Leader 审批**：调用 `sendSandboxPermissionResponseViaMailbox()` 回传 `allow: boolean` 结果（`src/utils/swarm/permissionSync.ts:882-928`）

### 流程四：进程内权限桥接（Leader Permission Bridge）

当 Teammate 作为 in-process 线程运行（而非独立进程）时，不需要走文件或 Mailbox 通道，可以直接复用 REPL 的权限确认队列：

1. **REPL 注册**：启动时调用 `registerLeaderToolUseConfirmQueue()` 和 `registerLeaderSetToolPermissionContext()` 注册回调函数（`src/utils/swarm/leaderPermissionBridge.ts:28-30`）
2. **in-process Teammate 获取队列**：通过 `getLeaderToolUseConfirmQueue()` 获取 `setToolUseConfirmQueue` 函数，直接向 Leader 的 React 状态中插入权限确认项（`src/utils/swarm/leaderPermissionBridge.ts:34-36`）
3. **清理**：会话结束时调用 `unregisterLeaderToolUseConfirmQueue()` 和 `unregisterLeaderSetToolPermissionContext()` 释放引用

## 函数签名与参数说明

### permissionSync.ts 核心 API

#### `createPermissionRequest(params): SwarmPermissionRequest`

构造权限请求对象。`toolName`、`toolUseId`、`input`、`description` 为必填；`teamName`、`workerId`、`workerName` 可选，缺省时从环境变量自动获取。

#### `writePermissionRequest(request): Promise<SwarmPermissionRequest>`

将请求写入 `pending/` 目录，使用文件锁保证原子写入。返回写入的请求对象。

#### `readPendingPermissions(teamName?): Promise<SwarmPermissionRequest[]>`

读取团队所有待处理的权限请求，按创建时间升序排列。每个文件经 Zod Schema 校验，无效文件被跳过。

#### `resolvePermission(requestId, resolution, teamName?): Promise<boolean>`

将请求从 `pending/` 移动到 `resolved/`，写入审批结果。加文件锁，返回是否成功。

#### `pollForResponse(requestId, _agentName?, teamName?): Promise<PermissionResponse | null>`

Worker 端轮询函数，检查 `resolved/` 目录中是否有对应结果，返回简化的 `PermissionResponse`。

#### `sendPermissionRequestViaMailbox(request): Promise<boolean>`

通过 Mailbox 通道发送工具权限请求到 Leader。

#### `sendPermissionResponseViaMailbox(workerName, resolution, requestId, teamName?): Promise<boolean>`

通过 Mailbox 通道发送工具权限审批结果到 Worker。

#### `sendSandboxPermissionRequestViaMailbox(host, requestId, teamName?): Promise<boolean>`

通过 Mailbox 通道发送沙箱网络权限请求到 Leader。

#### `sendSandboxPermissionResponseViaMailbox(workerName, requestId, host, allow, teamName?): Promise<boolean>`

通过 Mailbox 通道发送沙箱网络权限审批结果到 Worker。

#### `isTeamLeader(teamName?): boolean`

判断当前进程是否为 Leader。逻辑：没有 `agentId` 或 `agentId === 'team-lead'` 即为 Leader（`src/utils/swarm/permissionSync.ts:581-591`）。

#### `isSwarmWorker(): boolean`

判断当前进程是否为 Swarm Worker。逻辑：同时拥有 `teamName` 和 `agentId`，且不是 Leader。

#### `cleanupOldResolutions(teamName?, maxAgeMs?): Promise<number>`

清理过期的 resolved 文件，默认清理 1 小时前的记录。无法解析的文件也会被清理。返回清理数量。

### leaderPermissionBridge.ts API

#### `registerLeaderToolUseConfirmQueue(setter): void`

注册 REPL 的 `setToolUseConfirmQueue` 回调。`setter` 类型为 `(updater: (prev: ToolUseConfirm[]) => ToolUseConfirm[]) => void`——一个 React 状态更新函数。

#### `getLeaderToolUseConfirmQueue(): SetToolUseConfirmQueueFn | null`

获取已注册的队列设置函数，未注册时返回 `null`。

#### `registerLeaderSetToolPermissionContext(setter): void` / `getLeaderSetToolPermissionContext()`

注册和获取权限上下文设置函数，支持 `preserveMode` 选项保留当前权限模式。

#### `unregisterLeaderToolUseConfirmQueue()` / `unregisterLeaderSetToolPermissionContext()`

清理函数，将模块级变量置为 `null`。

## 接口/类型定义

### `SwarmPermissionRequest`

权限请求的完整数据结构，经 Zod Schema（`SwarmPermissionRequestSchema`）校验：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识，格式 `perm-{timestamp}-{random}` |
| workerId | string | Worker 的 `CLAUDE_CODE_AGENT_ID` |
| workerName | string | Worker 的 `CLAUDE_CODE_AGENT_NAME` |
| workerColor | string? | Worker 的显示颜色 |
| teamName | string | 团队名称 |
| toolName | string | 需要权限的工具名（如 "Bash"、"Edit"） |
| toolUseId | string | Worker 上下文中的原始 toolUseID |
| description | string | 工具使用的人类可读描述 |
| input | Record\<string, unknown\> | 序列化的工具输入 |
| permissionSuggestions | unknown[] | 建议的权限规则 |
| status | 'pending' \| 'approved' \| 'rejected' | 当前状态 |
| resolvedBy | 'worker' \| 'leader'? | 审批方 |
| resolvedAt | number? | 审批时间戳 |
| feedback | string? | 拒绝时的反馈消息 |
| updatedInput | Record\<string, unknown\>? | 审批方修改后的输入 |
| permissionUpdates | unknown[]? | "始终允许"规则 |
| createdAt | number | 创建时间戳 |

### `PermissionResolution`

审批结果结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| decision | 'approved' \| 'rejected' | 审批决定 |
| resolvedBy | 'worker' \| 'leader' | 审批方（Worker 可自行解决） |
| feedback | string? | 拒绝反馈 |
| updatedInput | Record\<string, unknown\>? | 修改后的输入 |
| permissionUpdates | PermissionUpdate[]? | 要应用的权限规则更新 |

### `PermissionResponse`（Legacy）

供 Worker 轮询使用的简化响应格式，`decision` 值为 `'approved' | 'denied'`（注意与 `PermissionResolution` 中 `'rejected'` 的映射）。

## 配置项与默认值

- **文件存储路径**：`~/.claude/teams/{teamName}/permissions/`，下设 `pending/` 和 `resolved/` 子目录
- **文件锁**：使用 `pending/.lock` 文件配合 `lockfile.lock()` 实现互斥
- **过期清理阈值**：`cleanupOldResolutions` 默认 `maxAgeMs = 3600000`（1 小时）
- **请求 ID 格式**：工具权限 `perm-{timestamp}-{random7}`，沙箱权限 `sandbox-{timestamp}-{random7}`
- **Leader 判定**：`agentId` 为空或等于 `'team-lead'` 即视为 Leader

## 边界 Case 与注意事项

- **双通道并存**：文件目录通道和 Mailbox 通道同时存在。文件通道是原始实现，Mailbox 是较新方案。`submitPermissionRequest` 是 `writePermissionRequest` 的别名，保持向后兼容（`src/utils/swarm/permissionSync.ts:641`）
- **Worker 自行解决**：`resolvedBy` 字段支持 `'worker'` 值，意味着 Worker 在某些场景下可以自行解决权限请求而不等待 Leader
- **Schema 校验容错**：`readPendingPermissions` 读取失败或校验失败的文件会被跳过而非抛异常，保证不因单个损坏文件阻塞整体
- **`PermissionResponse.decision` 值域差异**：Legacy 类型使用 `'denied'` 而非 `'rejected'`，`pollForResponse` 中做了映射转换（`src/utils/swarm/permissionSync.ts:556`）
- **过期清理的激进策略**：`cleanupOldResolutions` 对无法解析的 JSON 文件直接删除，不会保留损坏文件（`src/utils/swarm/permissionSync.ts:496-503`）
- **leaderPermissionBridge 的模块级状态**：桥接器使用模块顶层 `let` 变量存储回调引用，这意味着同一进程中只能有一个 Leader 注册。这符合设计预期——一个 REPL 进程只有一个 Leader
- **`preserveMode` 选项**：`SetToolPermissionContextFn` 支持 `preserveMode` 参数，允许在设置权限上下文时保留当前的权限模式，避免 in-process Teammate 覆盖 Leader 的权限模式设置