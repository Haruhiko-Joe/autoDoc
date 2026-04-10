# StructuredIO — SDK 结构化 IO 协议层

## 概述与职责

StructuredIO 是 Claude Code CLI 传输层（CLITransport）中的核心协议组件，负责在 SDK 模式下实现 stdin/stdout 上的 **NDJSON 双向通信协议**。它在系统中承担"SDK 协议网关"角色——所有 SDK 宿主（VS Code 扩展、云端运行时、第三方集成）与 Claude Code 引擎之间的控制消息都经由此层序列化和反序列化。

本模块包含两个类：

- **`StructuredIO`**（基类，`src/cli/structuredIO.ts`）：实现完整的 NDJSON 请求/响应协议，处理权限审批、Hook 回调、MCP 消息转发、沙箱网络请求等控制流
- **`RemoteIO`**（子类，`src/cli/remoteIO.ts`）：扩展为远程传输模式，通过 WebSocket/SSE 连接云端运行时（CCR），支持会话追踪、断线重连和心跳保活

在整体架构中，StructuredIO 位于 CLITransport 模块内，与 Entrypoints（入口层）和 CoreEngine（查询引擎）协作——入口层调用它处理 CLI 命令的 IO 序列化，查询引擎通过它接收用户输入和返回流式响应。同层兄弟模块包括命令处理器（handlers/）、输出格式化（print、NDJSON）和版本更新检查等。

## 关键流程

### 1. NDJSON 消息读取与分发流程

`StructuredIO` 的核心读取逻辑在 `read()` 异步生成器中（`src/cli/structuredIO.ts:215-261`）：

1. 从 `this.input`（AsyncIterable\<string\>）逐块读取数据，累积到 `content` 缓冲区
2. 按 `\n` 分割为独立行，每行调用 `processLine()` 解析为 JSON 消息
3. 在每次分割前，检查 `prependedLines` 队列——允许在流中间插入合成用户消息
4. 输入流关闭时，将所有 pending 请求 reject，防止悬挂的 Promise

`processLine()` 是消息路由的核心（`src/cli/structuredIO.ts:333-463`），按 `type` 字段分发：

| 消息类型 | 处理方式 |
|---------|---------|
| `keep_alive` | 静默丢弃 |
| `update_environment_variables` | 直接写入 `process.env`（用于 bridge 刷新 auth token） |
| `control_response` | 匹配 pending 请求并 resolve/reject，含去重逻辑 |
| `user` / `assistant` / `system` | 透传给消费者 |
| `control_request` | 校验后透传 |
| 其他 | 打印警告并丢弃 |

### 2. 控制请求/响应（Request-Response）协议

SDK 协议的核心是一个基于 `request_id` 的异步请求-响应模式。`sendRequest()` 方法（`src/cli/structuredIO.ts:469-531`）实现了完整的请求生命周期：

1. 构造 `SDKControlRequest` 消息，分配唯一 `request_id`
2. 将消息入队到 `outbound` Stream（与 print.ts 的流式事件共享队列，保证消息顺序）
3. 创建 Promise 并注册到 `pendingRequests` Map 中等待响应
4. 支持 `AbortSignal` 取消——中止时发送 `control_cancel_request` 并立即 reject
5. 响应到达时通过 Zod schema 校验后 resolve

**去重机制**：`resolvedToolUseIds` Set 跟踪已完成的 tool_use ID（上限 1000 条，LRU 淘汰），防止 WebSocket 重连导致的重复 `control_response` 引发 API 400 错误（`src/cli/structuredIO.ts:149-187`）。

### 3. 工具权限审批流程（Hook 竞赛机制）

`createCanUseTool()` 返回一个权限判定函数（`src/cli/structuredIO.ts:533-659`），这是 SDK 模式下工具执行前的权限门控核心：

1. 先调用 `hasPermissionsToUseTool()` 检查规则/模式级权限——若明确 allow/deny 则直接返回
2. 若需要用户确认（`ask` 行为），同时启动两个竞赛者：
   - **Hook 路径**：执行 `PermissionRequest` 钩子（可能包含自动审批逻辑）
   - **SDK 路径**：通过 `sendRequest()` 向宿主发送 `can_use_tool` 控制请求
3. 使用 `Promise.race()` 竞赛——先完成的获胜，后者被取消
4. Hook 胜出时：中止 SDK 请求，应用权限更新并持久化
5. SDK 胜出时：将宿主的审批结果转换为 `PermissionDecision`
6. 所有 pending 请求清空后，通知会话状态回到 `running`

```
hasPermissionsToUseTool() → allow/deny → 直接返回
                         → ask → Promise.race([hookPromise, sdkPromise])
                                    ↓ hook 胜出 → abort SDK, apply permissions
                                    ↓ sdk 胜出  → convert to PermissionDecision
```

### 4. RemoteIO 连接建立与 CCR v2 初始化

`RemoteIO` 构造函数（`src/cli/remoteIO.ts:44-215`）执行以下步骤：

1. 创建 `PassThrough` 流作为 `StructuredIO` 的输入源
2. 准备认证头（Bearer token + 环境运行器版本号），并注册动态刷新回调
3. 根据 URL 协议选择传输层（WebSocket 或 SSE）
4. 设置 `onData` 回调将传输层数据写入 PassThrough 流
5. 设置 `onClose` 回调触发优雅关闭
6. **若启用 CCR v2**（`CLAUDE_CODE_USE_CCR_V2` 环境变量）：
   - 实例化 `CCRClient`（必须在 `transport.connect()` 之前，否则早期 SSE 帧的 ACK 会丢失）
   - 初始化 worker 状态，恢复 `restoredWorkerState`
   - 注册 internal event 读写器（用于会话简报持久化和恢复）
   - 注册命令生命周期、会话状态和元数据变更监听器
7. 调用 `transport.connect()` 建立连接
8. Bridge 模式下启动 keep-alive 定时器（防止上游代理 idle 超时）
9. 注册清理回调用于优雅关闭

## 函数签名与参数说明

### StructuredIO（基类）

#### `constructor(input: AsyncIterable<string>, replayUserMessages?: boolean)`

- **input**：NDJSON 行的异步可迭代源（通常是 stdin）
- **replayUserMessages**：为 `true` 时 `control_response` 也会透传给消费者（用于消息回放场景）

#### `createCanUseTool(onPermissionPrompt?: (details: RequiresActionDetails) => void): CanUseToolFn`

创建工具权限判定函数。

- **onPermissionPrompt**：权限提示发出时的回调（用于 UI 层显示状态）
- 返回值：异步函数，接收 `(tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision?)` 返回 `PermissionDecision`

#### `createHookCallback(callbackId: string, timeout?: number): HookCallback`

创建 Hook 回调代理——将 Hook 调用转发给 SDK 宿主处理。

- **callbackId**：回调标识符
- **timeout**：可选超时时间
- 返回包含 `callback` 函数的 `HookCallback` 对象

#### `handleElicitation(serverName, message, requestedSchema?, signal?, mode?, url?, elicitationId?): Promise<ElicitResult>`

向 SDK 宿主发送信息获取请求（如 MCP 服务器需要用户输入时）。

- **serverName**：发起请求的 MCP 服务器名称
- **message**：向用户展示的提示信息
- **requestedSchema**：期望的响应 JSON Schema
- **mode**：交互模式，`'form'` 或 `'url'`
- 失败时返回 `{ action: 'cancel' }`

> 源码位置：`src/cli/structuredIO.ts:694-721`

#### `sendMcpMessage(serverName: string, message: JSONRPCMessage): Promise<JSONRPCMessage>`

通过 SDK 协议转发 MCP JSON-RPC 消息并等待响应。

> 源码位置：`src/cli/structuredIO.ts:758-773`

#### `createSandboxAskCallback(): (hostPattern: { host: string; port?: number }) => Promise<boolean>`

创建沙箱网络访问权限回调。复用 `can_use_tool` 协议，使用合成工具名 `SandboxNetworkAccess`。

> 源码位置：`src/cli/structuredIO.ts:731-753`

#### `prependUserMessage(content: string): void`

向消息流头部注入合成用户消息，下一次 `read()` 迭代时优先消费。

#### `write(message: StdoutMessage): Promise<void>`

将消息 NDJSON 序列化后写入 stdout。

#### `injectControlResponse(response: SDKControlResponse): void`

注入控制响应——由 bridge 用于将 claude.ai 的权限审批结果注入 SDK 权限流。注入后会向 SDK 消费者发送 `control_cancel_request`。

> 源码位置：`src/cli/structuredIO.ts:283-309`

### RemoteIO（子类）

#### `constructor(streamUrl: string, initialPrompt?: AsyncIterable<string>, replayUserMessages?: boolean)`

- **streamUrl**：远程传输端点 URL（WebSocket 或 SSE）
- **initialPrompt**：可选的初始提示内容流
- **replayUserMessages**：透传给基类

#### `write(message: StdoutMessage): Promise<void>`

覆写基类方法。CCR v2 模式下通过 `CCRClient.writeEvent()` 发送；否则通过传输层直接发送。Bridge 模式下 `control_request` 始终回显到 stdout。

> 源码位置：`src/cli/remoteIO.ts:231-242`

#### `close(): void`

清理定时器、关闭传输层、结束输入流。

#### `flushInternalEvents(): Promise<void>`

刷新 CCR v2 内部事件队列。基类为空操作。

## 接口/类型定义

### `PendingRequest<T>`

```typescript
type PendingRequest<T> = {
  resolve: (result: T) => void
  reject: (error: unknown) => void
  schema?: z.Schema        // Zod 校验 schema
  request: SDKControlRequest // 原始请求（用于去重追踪）
}
```

> 源码位置：`src/cli/structuredIO.ts:119-124`

### 控制消息子类型（`SDKControlRequest.request.subtype`）

通过 `sendRequest()` 发送的控制请求包含以下子类型：

| subtype | 用途 |
|---------|------|
| `can_use_tool` | 工具使用权限请求（含沙箱网络访问） |
| `hook_callback` | Hook 回调转发给 SDK 宿主 |
| `elicitation` | 信息获取请求（MCP 服务器需要用户输入） |
| `mcp_message` | MCP JSON-RPC 消息转发 |

### 关键常量

- **`SANDBOX_NETWORK_ACCESS_TOOL_NAME`** = `'SandboxNetworkAccess'`：沙箱网络权限请求的合成工具名
- **`MAX_RESOLVED_TOOL_USE_IDS`** = `1000`：已解析 tool_use ID 的最大追踪数量（LRU 策略）

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `CLAUDE_CODE_USE_CCR_V2` | 环境变量 | `false` | 启用 CCR v2 协议（SSE+POST） |
| `CLAUDE_CODE_ENVIRONMENT_KIND` | 环境变量 | - | 值为 `'bridge'` 时启用 bridge 模式特性 |
| `CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION` | 环境变量 | - | 环境运行器版本号，附加到请求头 |
| `session_keepalive_interval_v2_ms` | GrowthBook 配置 | 120s | keep-alive 发送间隔，0 表示禁用 |

## 边界 Case 与注意事项

1. **重复响应去重**：WebSocket 重连可能导致同一 `control_response` 被投递多次。`resolvedToolUseIds` Set 会过滤这些重复，避免向 API 发送重复的 assistant 消息导致 400 错误（`src/cli/structuredIO.ts:376-394`）。

2. **Hook 与 SDK 竞赛的取消语义**：当 Hook 先于 SDK 宿主做出权限决策时，`sdkPromise.catch(() => {})` 静默吞掉 AbortError（`src/cli/structuredIO.ts:617`），这是有意为之——Hook 获胜后 SDK Promise 的 reject 是预期行为。

3. **CCRClient 初始化顺序**：`new CCRClient()` 必须在 `transport.connect()` 之前执行（`src/cli/remoteIO.ts:111-115`），否则早期 SSE 帧的 delivery ACK 会因 `onEventCallback` 未注册而丢失。

4. **Bridge 模式 stdout 回显**：RemoteIO 在 bridge 模式下会将 `control_request` 消息回显到 stdout（`src/cli/remoteIO.ts:237-241`），使 bridge 父进程能够检测到权限请求并转发到 claude.ai。

5. **输入流关闭处理**：当 stdin 关闭时，所有 pending 请求会被统一 reject（`src/cli/structuredIO.ts:255-260`），错误消息为 `'Tool permission stream closed before response received'`。

6. **keep-alive 仅限 Bridge**：keep-alive 定时器只在 bridge 拓扑下启用，解决 Envoy 代理的 idle 超时问题。BYOC worker 使用不同的网络路径，不需要此机制。

7. **环境变量热更新**：`update_environment_variables` 消息直接修改 `process.env`（`src/cli/structuredIO.ts:348-360`），主要用于 bridge 场景下的 auth token 刷新，确保 REPL 进程本身（而非仅子 Bash 进程）能读到新 token。