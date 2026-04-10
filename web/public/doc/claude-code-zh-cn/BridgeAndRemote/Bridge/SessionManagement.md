# 会话生命周期管理（SessionManagement）

## 概述与职责

SessionManagement 模块是 Bridge 子系统的核心组成部分，负责远程控制（Remote Control）模式下会话的完整生命周期管理。它位于 `BridgeAndRemote → Bridge` 层级中，与同级的传输层（HybridTransport/SSETransport）、轮询调度、JWT 刷新等模块协作，共同实现远程会话的创建、运行、恢复和销毁。

该模块由 6 个文件组成，各司其职：

| 文件 | 核心职责 |
|------|---------|
| `sessionRunner.ts` | 派发子 CLI 进程作为会话运行器，捕获和解析 NDJSON 输出 |
| `createSession.ts` | 封装 v1 Sessions API（创建/查询/归档/更新标题） |
| `codeSessionApi.ts` | CCR v2 code-session API 的轻量 HTTP 封装 |
| `bridgePointer.ts` | 磁盘上的崩溃恢复指针管理 |
| `sessionIdCompat.ts` | `cse_*` / `session_*` 两种 ID 格式间的转换 |
| `replBridgeHandle.ts` | 全局活跃 REPL 桥接句柄的存取 |

## 关键流程

### 1. 子进程会话运行器（sessionRunner.ts）

这是 Bridge 系统中实际执行会话的核心组件。`createSessionSpawner()` 创建一个 `SessionSpawner` 工厂，其 `spawn()` 方法负责启动子 CLI 进程并管理其生命周期。

**派发流程：**

1. 根据配置确定调试文件路径——优先使用 `deps.debugFile`（按 session ID 后缀区分），其次在 verbose 模式或内部构建下自动生成临时文件（`src/bridge/sessionRunner.ts:255-266`）
2. 构建子进程启动参数，包括 `--print`、`--sdk-url`、`--session-id`、`--input-format stream-json`、`--output-format stream-json`、`--replay-user-messages` 等标志（`src/bridge/sessionRunner.ts:287-303`）
3. 配置环境变量——剥离桥接自身的 OAuth token（`CLAUDE_CODE_OAUTH_TOKEN=undefined`），注入会话访问令牌（`CLAUDE_CODE_SESSION_ACCESS_TOKEN`），设置环境类型为 `bridge`（`src/bridge/sessionRunner.ts:306-323`）
4. 通过 `child_process.spawn` 以 `['pipe','pipe','pipe']` 模式启动子进程，三个标准流全部可控

**输出解析机制：**

子进程通过 stdout 输出 NDJSON（换行分隔的 JSON），`sessionRunner` 使用 `readline` 逐行解析：

- **活动提取**：`extractActivities()` 函数解析 `assistant` 类型消息中的 `tool_use` 和 `text` 块，以及 `result` 类型消息，生成 `SessionActivity` 活动记录。工具使用通过 `TOOL_VERBS` 映射表转换为可读描述（如 `Read → "Reading"`、`Bash → "Running"`）（`src/bridge/sessionRunner.ts:69-105`）
- **权限请求检测**：当解析到 `control_request` 类型且子类型为 `can_use_tool` 时，触发 `onPermissionRequest` 回调，将权限请求转发给服务端供用户审批（`src/bridge/sessionRunner.ts:417-430`）
- **首条用户消息**：检测 `user` 类型消息，提取第一条真实的人类输入文本（排除工具结果、合成消息和回放消息），触发 `onFirstUserMessage` 回调（`src/bridge/sessionRunner.ts:432-443`）

**活动环形缓冲区：** 活动记录维护在一个最大容量为 10 的环形缓冲区中（`MAX_ACTIVITIES = 10`），stderr 同样使用 10 行环形缓冲（`MAX_STDERR_LINES = 10`），用于错误诊断。

**Transcript 日志：** 当配置了 `debugFile` 时，会在同目录下创建 `bridge-transcript-{safeId}.jsonl` 文件，将原始 NDJSON 行写入，供事后分析。

### 2. v1 会话 API（createSession.ts）

封装了面向 `/v1/sessions` 端点的四个 HTTP 操作，使用 OAuth 认证和组织 UUID：

**创建会话** — `createBridgeSession()`：
1. 获取 OAuth access token 和组织 UUID
2. 构建请求体，包含 `events`（SDK 消息事件）、`session_context`（git 源、模型信息）、`environment_id`、`source: 'remote-control'`
3. 解析 git 仓库 URL，生成 `git_repository` 类型的 source 和 outcome 上下文
4. POST 到 `/v1/sessions`，成功返回 session ID（`src/bridge/createSession.ts:34-180`）

**查询会话** — `getBridgeSession()`：GET `/v1/sessions/{id}`，返回 `environment_id` 和 `title`，用于 `--session-id` 恢复场景（`src/bridge/createSession.ts:190-244`）

**归档会话** — `archiveBridgeSession()`：POST `/v1/sessions/{id}/archive`。CCR 服务器不会自动归档，必须由客户端显式调用。已归档会话返回 409，因此可安全重复调用。调用者需自行处理异常（`src/bridge/createSession.ts:263-317`）

**更新标题** — `updateBridgeSessionTitle()`：PATCH `/v1/sessions/{id}`，在用户通过 `/rename` 重命名时同步标题。内部调用 `toCompatSessionId()` 将 `cse_*` 转换为 `session_*` 格式以兼容 compat 网关（`src/bridge/createSession.ts:327-384`）

所有函数共享相同的认证头模式：OAuth Bearer token + `anthropic-beta: ccr-byoc-2025-07-29` + `x-organization-uuid`。

### 3. CCR v2 Code-Session API（codeSessionApi.ts）

独立于 `createSession.ts` 的轻量 HTTP 封装，面向 `/v1/code/sessions` 端点。之所以独立成文件，是为了让 SDK 的 `/bridge` 子路径能导出这些函数而不引入沉重的 CLI 依赖树。调用者需显式传入 `accessToken` 和 `baseUrl`——不读取任何隐式认证或配置。

**创建会话** — `createCodeSession()`：POST `/v1/code/sessions`，请求体包含 `title`、`bridge: {}`（作为 oneof runner 的正信号）和可选 `tags`。返回以 `cse_*` 前缀开头的 session ID（`src/bridge/codeSessionApi.ts:26-80`）

**获取远程凭证** — `fetchRemoteCredentials()`：POST `/v1/code/sessions/{id}/bridge`，每次调用都会在服务端递增 `worker_epoch`（即此调用本身就是 bridge 注册）。返回 `RemoteCredentials` 对象（`src/bridge/codeSessionApi.ts:93-168`）

### 4. 崩溃恢复指针（bridgePointer.ts）

实现了磁盘持久化的会话恢复机制。当 bridge 进程异常退出（崩溃、kill -9、终端关闭）时，指针文件留存；下次启动时 `claude remote-control` 检测到指针并提供通过 `--session-id` 恢复的选项。

**指针结构（BridgePointer）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string | 会话 ID |
| `environmentId` | string | 环境 ID |
| `source` | `'standalone' \| 'repl'` | 来源——独立桥接或 REPL 内桥接 |

**存储位置：** `{projectsDir}/{sanitizedPath}/bridge-pointer.json`，按工作目录隔离，避免不同仓库的并发 bridge 互相覆盖。

**新鲜度管理：** 使用文件的 mtime（而非内嵌时间戳）判断新鲜度。长时间运行的 bridge 周期性地以相同内容重写文件来刷新 mtime，与后端的 `BRIDGE_LAST_POLL_TTL`（4 小时）语义对齐。TTL 常量为 `BRIDGE_POINTER_TTL_MS = 4 * 60 * 60 * 1000`（`src/bridge/bridgePointer.ts:40`）。

**Worktree 感知恢复** — `readBridgePointerAcrossWorktrees()`：

这是为 `--continue` 场景设计的增强版读取。REPL bridge 将指针写入 `getOriginalCwd()`，但 `claude remote-control --continue` 可能从不同的工作目录启动。该函数：

1. **快速路径**：先检查当前目录，命中则直接返回（一次 stat，零次 exec）
2. **扇出路径**：通过 `git worktree list` 获取所有 worktree 路径，过滤掉当前目录后并行读取（`Promise.all`）
3. 选取最新鲜的指针（最小 `ageMs`）返回，同时返回对应的目录路径
4. 扇出上限为 `MAX_WORKTREE_FANOUT = 50`，超出则跳过以防异常配置下的性能问题

（`src/bridge/bridgePointer.ts:129-184`）

### 5. Session ID 兼容转换（sessionIdCompat.ts）

CCR v2 引入了 `cse_*` 前缀的会话 ID，但 v1 compat API 层仍然期望 `session_*` 前缀。两者的 UUID 部分相同，仅前缀不同。

**`toCompatSessionId(id)`**：`cse_xxx` → `session_xxx`。用于客户端向 compat 端点（`/v1/sessions/{id}`）发请求时转换 ID。当 `_isCseShimEnabled` gate 返回 false 时保持原样（`src/bridge/sessionIdCompat.ts:38-42`）

**`toInfraSessionId(id)`**：`session_xxx` → `cse_xxx`。用于基础设施层调用（如 `/v1/environments/{id}/bridge/reconnect`），因为一旦服务端启用 `ccr_v2_compat_enabled`，基础设施层需要 `cse_*` 格式来查找会话（`src/bridge/sessionIdCompat.ts:54-57`）

**GrowthBook 门控**：通过 `setCseShimGate()` 注入 kill switch 函数，控制 shim 是否生效。独立成文件是为了避免 SDK bundle 引入 `bridgeEnabled.ts → growthbook.ts → config.ts` 的依赖链（`src/bridge/sessionIdCompat.ts:21-23`）

### 6. REPL 桥接句柄（replBridgeHandle.ts）

维护一个进程级全局指针，指向当前活跃的 REPL 桥接句柄（`ReplBridgeHandle`）。这使得 React 组件树之外的代码（工具实现、slash 命令等）能够访问 bridge 的方法（如 `subscribePR`）。

**`setReplBridgeHandle(h)`**：设置或清除全局句柄。同时调用 `updateSessionBridgeId()` 将 bridge session ID 发布到会话记录中，使其他本地 peer 能够通过 dedup 识别到本机已有 bridge 连接——本地优先策略（`src/bridge/replBridgeHandle.ts:18-23`）

**`getReplBridgeHandle()`**：返回当前句柄或 null

**`getSelfBridgeCompatId()`**：返回当前 bridge session ID 的 `session_*` compat 格式，供 API 响应匹配使用（`src/bridge/replBridgeHandle.ts:33-36`）

## 函数签名

### sessionRunner.ts

#### `createSessionSpawner(deps: SessionSpawnerDeps): SessionSpawner`

创建会话派发器工厂。

**SessionSpawnerDeps 参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `execPath` | string | 可执行文件路径 |
| `scriptArgs` | string[] | 前置于 CLI 标志的脚本参数（编译二进制为空，npm 安装为 `process.argv[1]`） |
| `env` | NodeJS.ProcessEnv | 环境变量 |
| `verbose` | boolean | 是否开启详细日志 |
| `sandbox` | boolean | 是否强制沙箱模式 |
| `debugFile` | string? | 调试文件路径 |
| `permissionMode` | string? | 权限模式 |
| `onDebug` | (msg: string) => void | 调试日志回调 |
| `onActivity` | (sessionId, activity) => void | 活动通知回调 |
| `onPermissionRequest` | (sessionId, request, accessToken) => void | 权限请求回调 |

返回的 `SessionHandle` 提供以下方法：`kill()`（发送 SIGTERM）、`forceKill()`（发送 SIGKILL）、`writeStdin(data)`（向子进程写入数据）、`updateAccessToken(token)`（通过 stdin 发送 token 刷新消息）。

#### `safeFilenameId(id: string): string`

清理 session ID 中的特殊字符（替换为下划线），防止路径遍历攻击。

### createSession.ts

#### `createBridgeSession(opts): Promise<string | null>`

创建 bridge 会话。成功返回 session ID，失败返回 null。

#### `getBridgeSession(sessionId, opts?): Promise<{environment_id?, title?} | null>`

获取会话信息，用于 `--session-id` 恢复。

#### `archiveBridgeSession(sessionId, opts?): Promise<void>`

归档会话。不捕获异常，调用者需自行 `.catch()`。

#### `updateBridgeSessionTitle(sessionId, title, opts?): Promise<void>`

更新会话标题。错误被内部吞没——标题同步是尽力而为。

### codeSessionApi.ts

#### `createCodeSession(baseUrl, accessToken, title, timeoutMs, tags?): Promise<string | null>`

通过 v2 API 创建 code session，返回 `cse_*` 格式的 ID。

#### `fetchRemoteCredentials(sessionId, baseUrl, accessToken, timeoutMs, trustedDeviceToken?): Promise<RemoteCredentials | null>`

获取 bridge 工作凭证。每次调用递增服务端的 `worker_epoch`。

### bridgePointer.ts

#### `writeBridgePointer(dir, pointer): Promise<void>`

写入或刷新指针。自动创建目录。Best-effort，不会抛异常。

#### `readBridgePointer(dir): Promise<(BridgePointer & {ageMs}) | null>`

读取指针。过期（>4h）或格式错误时自动清理并返回 null。

#### `readBridgePointerAcrossWorktrees(dir): Promise<{pointer, dir} | null>`

Worktree 感知的指针读取，返回最新鲜的指针及其所在目录。

#### `clearBridgePointer(dir): Promise<void>`

删除指针。幂等——文件不存在不报错。

## 类型定义

### `PermissionRequest`（sessionRunner.ts）

子进程请求执行特定工具时发出的权限请求：

```typescript
type PermissionRequest = {
  type: 'control_request'
  request_id: string
  request: {
    subtype: 'can_use_tool'
    tool_name: string
    input: Record<string, unknown>
    tool_use_id: string
  }
}
```

### `RemoteCredentials`（codeSessionApi.ts）

从 `/bridge` 端点返回的工作凭证：

```typescript
type RemoteCredentials = {
  worker_jwt: string      // 不透明 JWT，勿解码
  api_base_url: string    // API 基础 URL
  expires_in: number      // 有效期（秒）
  worker_epoch: number    // 工作纪元，每次 /bridge 调用递增
}
```

### `BridgePointer`（bridgePointer.ts）

```typescript
type BridgePointer = {
  sessionId: string
  environmentId: string
  source: 'standalone' | 'repl'
}
```

## 配置项与默认值

| 常量/环境变量 | 值 | 说明 |
|-------------|-----|------|
| `BRIDGE_POINTER_TTL_MS` | 4h (14400000ms) | 指针新鲜度阈值 |
| `MAX_ACTIVITIES` | 10 | 活动环形缓冲区容量 |
| `MAX_STDERR_LINES` | 10 | stderr 环形缓冲区容量 |
| `MAX_WORKTREE_FANOUT` | 50 | Worktree 扇出读取上限 |
| `CLAUDE_CODE_ENVIRONMENT_KIND` | `'bridge'` | 子进程环境类型标识 |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | - | 注入子进程的会话访问令牌 |
| `CLAUDE_CODE_FORCE_SANDBOX` | `'1'` | sandbox 模式启用时注入 |
| `CLAUDE_CODE_USE_CCR_V2` | `'1'` | v2 模式标识 |
| `CLAUDE_CODE_WORKER_EPOCH` | 数字字符串 | v2 模式下的工作纪元 |
| `anthropic-beta` header | `ccr-byoc-2025-07-29` | v1 Sessions API beta 标头 |
| `anthropic-version` header | `2023-06-01` | v2 Code-Session API 版本标头 |

## 边界 Case 与注意事项

- **Token 隔离**：子进程启动时显式将 `CLAUDE_CODE_OAUTH_TOKEN` 设为 `undefined`，强制子进程使用会话访问令牌而非桥接自身的 OAuth token，防止 staging/prod token 混用
- **Token 热刷新**：`updateAccessToken()` 通过 stdin 向子进程发送 `update_environment_variables` 消息，子进程的 StructuredIO 会直接设置 `process.env`，实现不中断的 token 轮换
- **Windows 兼容**：`kill()` 在 Windows 上不传 signal 参数（`child.kill('SIGTERM')` 在 Windows 上会抛异常），直接调用 `child.kill()`
- **protojson 精度**：`fetchRemoteCredentials` 中 `worker_epoch` 可能是 string 或 number（protojson 将 int64 序列化为 string 以避免 JS 精度丢失），代码显式处理了两种情况（`src/bridge/codeSessionApi.ts:150-161`）
- **幂等归档**：`archiveBridgeSession()` 不捕获异常（5xx 和网络错误会向上抛出），但归档端点对已归档会话返回 409，因此多次调用是安全的
- **Worktree 感知恢复**：REPL bridge 可能将指针写到 worktree 路径下，而 `--continue` 从主仓库目录运行时需要跨 worktree 搜索。扇出读取有 50 的上限保护
- **指针自动清理**：`readBridgePointer()` 遇到格式错误或过期指针时会自动删除，避免反复提示恢复已失效的会话
- **SDK bundle 隔离**：`sessionIdCompat.ts` 和 `codeSessionApi.ts` 刻意避免引入重依赖（growthbook、config 等），以支持 `sdk.mjs` 轻量 bundle 的构建需求