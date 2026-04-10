# RemoteSession — 远程 CCR 会话管理

## 概述与职责

RemoteSession 模块是 **BridgeAndRemote** 子系统的核心组成部分，负责管理本地 CLI 客户端与云端运行时（CCR, Claude Code Runtime）之间的双向通信。它通过 WebSocket 订阅远程会话的流式消息，通过 HTTP POST 向远程会话发送用户输入，并在本地 UI 中代理展示远程工具的权限请求。

模块由四个文件组成，各自承担清晰的职责：

| 文件 | 职责 |
|------|------|
| `RemoteSessionManager.ts` | 会话管理器：协调 WebSocket 订阅、HTTP 消息发送和权限请求流 |
| `SessionsWebSocket.ts` | WebSocket 客户端：连接 CCR 端点，处理自动重连、指数退避和 ping 保活 |
| `sdkMessageAdapter.ts` | 消息适配器：将 SDK 消息格式转换为内部 REPL 消息类型 |
| `remotePermissionBridge.ts` | 权限桥接：为远程工具创建合成消息和工具桩，使本地 UI 能展示权限确认对话框 |

在整体架构中，`TaskSystem` 中的 `RemoteAgentTask` 通过本模块连接 CCR 执行远程任务，而本模块产生的消息和权限请求会推送到 `TerminalUI` 层进行渲染。

## 关键流程

### 1. 建立远程会话连接

```
createRemoteSessionConfig() → new RemoteSessionManager(config, callbacks) → manager.connect()
                                                                                  ↓
                                                            new SessionsWebSocket(...) → ws.connect()
                                                                                             ↓
                                                                    wss://api.anthropic.com/v1/sessions/ws/{id}/subscribe
                                                                    (通过 Authorization header 认证)
```

1. 调用方通过 `createRemoteSessionConfig()` 构造配置（`src/remote/RemoteSessionManager.ts:329-343`），包含 `sessionId`、`getAccessToken` 回调、`orgUuid` 等
2. 实例化 `RemoteSessionManager`，传入配置和回调集合
3. 调用 `connect()` 创建 `SessionsWebSocket` 并发起连接
4. `SessionsWebSocket.connect()` 构造 WebSocket URL：`wss://{baseUrl}/v1/sessions/ws/{sessionId}/subscribe?organization_uuid={orgUuid}`（`src/remote/SessionsWebSocket.ts:108-109`）
5. 认证通过 HTTP header `Authorization: Bearer {token}` 完成，无需额外握手消息
6. 连接成功后启动 30 秒间隔的 ping 保活（`src/remote/SessionsWebSocket.ts:301-313`）

### 2. 消息接收与分发

WebSocket 收到的消息在 `RemoteSessionManager.handleMessage()` 中按类型分发（`src/remote/RemoteSessionManager.ts:146-184`）：

- **`control_request`**：权限请求 → 转入权限处理流程
- **`control_cancel_request`**：服务端取消待处理的权限请求 → 从 `pendingPermissionRequests` Map 中移除，触发 `onPermissionCancelled` 回调
- **`control_response`**：服务端确认 → 仅记录日志
- **其他 SDKMessage**：通过 `isSDKMessage()` 类型守卫过滤后，转发给 `onMessage` 回调

上层消费者（如 `RemoteAgentTask`）收到 `SDKMessage` 后，会使用 `sdkMessageAdapter.convertSDKMessage()` 将其转换为 REPL 可渲染的内部消息类型。

### 3. SDK 消息转换（sdkMessageAdapter）

`convertSDKMessage()` 函数（`src/remote/sdkMessageAdapter.ts:168-278`）是消息格式桥梁，将 CCR 发送的 SDK 格式消息转换为本地 REPL 的 `Message` 或 `StreamEvent` 类型：

| SDK 消息类型 | 转换目标 | 说明 |
|-------------|---------|------|
| `assistant` | `AssistantMessage` | 完整的助手回复 |
| `stream_event` | `StreamEvent` | 流式传输中的增量事件 |
| `result`（非 success） | `SystemMessage`（warning） | 错误结果，success 被忽略 |
| `system`（init） | `SystemMessage`（info） | 会话初始化，显示模型名 |
| `system`（status） | `SystemMessage`（info） | 状态变更（如 "compacting"） |
| `system`（compact_boundary） | `SystemMessage`（compact_boundary） | 对话压缩边界标记 |
| `tool_progress` | `SystemMessage`（info） | 工具执行进度 |
| `user` | 通常 `ignored` | 用户消息已由本地 REPL 添加 |
| `auth_status`、`tool_use_summary`、`rate_limit_event` | `ignored` | SDK 专有事件，不在 REPL 展示 |

`user` 类型消息的处理有两个可选模式（通过 `ConvertOptions` 控制）：
- `convertToolResults`：将包含 `tool_result` 内容块的用户消息转换为 `UserMessage`，用于直连模式
- `convertUserTextMessages`：将用户文本消息也纳入转换，用于历史事件回放

### 4. 权限请求处理

当远程 CCR 需要本地用户授权某个工具使用时：

1. CCR 通过 WebSocket 发送 `control_request`（subtype: `can_use_tool`）
2. `RemoteSessionManager.handleControlRequest()` 将请求存入 `pendingPermissionRequests` Map，并触发 `onPermissionRequest` 回调（`src/remote/RemoteSessionManager.ts:189-214`）
3. 上层 UI 收到回调后，使用 `remotePermissionBridge` 的两个函数构建 UI 所需的数据：
   - `createSyntheticAssistantMessage()`（`src/remote/remotePermissionBridge.ts:12-46`）：生成一个伪造的 `AssistantMessage`，包含 `tool_use` 内容块，满足 `ToolUseConfirm` 组件的数据要求
   - `createToolStub()`（`src/remote/remotePermissionBridge.ts:53-78`）：为本地未加载的远程工具（如 MCP 工具）创建最小化工具桩，提供 `renderToolUseMessage`、`needsPermissions` 等必要接口
4. 用户在本地 UI 做出允许/拒绝决策
5. 调用 `manager.respondToPermissionRequest(requestId, result)` 将决策通过 WebSocket 发送回 CCR（`src/remote/RemoteSessionManager.ts:247-282`）

对于 CCR 发送的无法识别的 `control_request` subtype，Manager 会立即回复一个 error 类型的 `control_response`，防止服务端无限等待。

### 5. 断线重连与退避策略

`SessionsWebSocket` 实现了多层重连机制（`src/remote/SessionsWebSocket.ts:234-298`）：

**永久关闭码**（立即停止重连）：
- `4003`：未授权

**瞬态关闭码 4001（session not found）**的特殊处理：
- 在对话压缩期间服务端可能短暂认为会话不存在
- 允许最多 3 次重试（`MAX_SESSION_NOT_FOUND_RETRIES`）
- 退避间隔：`RECONNECT_DELAY_MS × 重试次数`（即 2s、4s、6s）

**一般性断连**（从 connected 状态断开）：
- 最多 5 次重连尝试（`MAX_RECONNECT_ATTEMPTS`）
- 固定间隔 2 秒（`RECONNECT_DELAY_MS`）
- 每次重连重新获取 access token

**强制重连**：
- `reconnect()` 方法重置所有计数器，关闭现有连接，500ms 后发起新连接（`src/remote/SessionsWebSocket.ts:393-403`）
- 用于容器关停后订阅失效的场景

### 6. 发送消息到远程会话

用户输入通过 `RemoteSessionManager.sendMessage()` 经 HTTP POST 发送（`src/remote/RemoteSessionManager.ts:219-242`），调用 `sendEventToRemoteSession()` API。这与 WebSocket（只用于订阅接收）是独立的通道。

中断信号则通过 WebSocket 发送 `control_request`（subtype: `interrupt`）：`manager.cancelSession()`（`src/remote/RemoteSessionManager.ts:294-297`）。

## 函数签名与参数说明

### RemoteSessionManager

#### `constructor(config: RemoteSessionConfig, callbacks: RemoteSessionCallbacks)`

创建会话管理器实例。

#### `connect(): void`

建立 WebSocket 连接开始接收消息。

#### `sendMessage(content: RemoteMessageContent, opts?: { uuid?: string }): Promise<boolean>`

通过 HTTP POST 向远程会话发送用户消息。返回 `true` 表示发送成功。

#### `respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void`

回复一个待处理的权限请求。`result` 为联合类型：
- `{ behavior: 'allow', updatedInput: Record<string, unknown> }`
- `{ behavior: 'deny', message: string }`

#### `cancelSession(): void`

发送中断信号取消远程会话的当前请求。

#### `isConnected(): boolean`

查询当前 WebSocket 是否处于已连接状态。

#### `disconnect(): void`

关闭 WebSocket 连接并清理所有待处理的权限请求。

#### `reconnect(): void`

强制重连 WebSocket，重置重连计数器。

### sdkMessageAdapter

#### `convertSDKMessage(msg: SDKMessage, opts?: ConvertOptions): ConvertedMessage`

将 SDK 消息转换为 REPL 消息。返回值为联合类型：
- `{ type: 'message', message: Message }` — 可渲染的消息
- `{ type: 'stream_event', event: StreamEvent }` — 流式事件
- `{ type: 'ignored' }` — 不需要处理的消息

#### `isSessionEndMessage(msg: SDKMessage): boolean`

判断消息是否为 `result` 类型（会话结束标志）。

#### `isSuccessResult(msg: SDKResultMessage): boolean` / `getResultText(msg: SDKResultMessage): string | null`

提取结果消息的状态和文本内容。

### remotePermissionBridge

#### `createSyntheticAssistantMessage(request: SDKControlPermissionRequest, requestId: string): AssistantMessage`

为远程权限请求创建合成助手消息，供 `ToolUseConfirm` UI 组件使用。

#### `createToolStub(toolName: string): Tool`

为本地未加载的远程工具创建最小化桩对象。桩的 `renderToolUseMessage` 会展示输入参数的前 3 个键值对。

### createRemoteSessionConfig

#### `createRemoteSessionConfig(sessionId, getAccessToken, orgUuid, hasInitialPrompt?, viewerOnly?): RemoteSessionConfig`

工厂函数，创建会话配置对象。

## 接口/类型定义

### `RemoteSessionConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 远程会话 ID |
| `getAccessToken` | `() => string` | 获取 OAuth access token 的回调 |
| `orgUuid` | `string` | 组织 UUID |
| `hasInitialPrompt` | `boolean?` | 会话是否已有正在处理的初始 prompt |
| `viewerOnly` | `boolean?` | 纯观察模式：禁用中断、禁用 60s 重连超时、不更新会话标题（用于 `claude assistant`） |

### `RemoteSessionCallbacks`

| 回调 | 参数 | 说明 |
|------|------|------|
| `onMessage` | `(message: SDKMessage)` | 收到 SDK 消息 |
| `onPermissionRequest` | `(request, requestId)` | 收到权限请求 |
| `onPermissionCancelled` | `(requestId, toolUseId?)` | 权限请求被服务端取消 |
| `onConnected` | 无 | WebSocket 连接建立 |
| `onDisconnected` | 无 | 连接丢失且无法恢复 |
| `onReconnecting` | 无 | 瞬态断连，正在重连 |
| `onError` | `(error: Error)` | 发生错误 |

### `RemotePermissionResponse`

允许/拒绝联合类型：
- 允许：`{ behavior: 'allow', updatedInput: Record<string, unknown> }`
- 拒绝：`{ behavior: 'deny', message: string }`

### `ConvertedMessage`

转换结果联合类型：`'message'` | `'stream_event'` | `'ignored'`

## 配置项与默认值

以下常量定义在 `SessionsWebSocket.ts` 中：

| 常量 | 值 | 说明 |
|------|---|------|
| `RECONNECT_DELAY_MS` | 2000 | 基础重连等待时间 |
| `MAX_RECONNECT_ATTEMPTS` | 5 | 一般断连最大重连次数 |
| `PING_INTERVAL_MS` | 30000 | ping 保活间隔 |
| `MAX_SESSION_NOT_FOUND_RETRIES` | 3 | 4001 错误码最大重试次数 |
| `PERMANENT_CLOSE_CODES` | `{4003}` | 永久关闭码集合（不重连） |

WebSocket 端点 URL 基于 OAuth 配置的 `BASE_API_URL`，协议从 `https://` 替换为 `wss://`。

## 边界 Case 与注意事项

- **Bun vs Node 运行时差异**：`SessionsWebSocket.connect()` 通过 `typeof Bun !== 'undefined'` 检测运行时（`src/remote/SessionsWebSocket.ts:120`）。Bun 使用 `globalThis.WebSocket` 并通过构造选项传入 proxy/TLS；Node 环境则动态导入 `ws` 包并使用 `agent` 参数配置代理
- **消息类型前向兼容**：`isSessionsMessage()` 不使用白名单过滤，任何带 `string` 类型 `type` 字段的对象都会被接受（`src/remote/SessionsWebSocket.ts:46-55`）。这保证了后端新增消息类型不会被客户端丢弃
- **权限请求超时无保护**：`pendingPermissionRequests` Map 没有 TTL 机制。如果用户长时间不响应权限请求，Map 条目会持续存在，但 CCR 端可能通过 `control_cancel_request` 主动取消
- **消息发送与接收走不同通道**：用户消息通过 HTTP POST 发送（`sendEventToRemoteSession`），而接收走 WebSocket。中断信号是例外，通过 WebSocket 的 `control_request` 发送
- **工具桩的 `call` 方法为空实现**：`createToolStub()` 创建的桩对象 `call` 始终返回空字符串（`src/remote/remotePermissionBridge.ts:71`），因为实际工具执行发生在远程 CCR，本地只需展示权限确认 UI
- **success 类型的 result 消息被静默忽略**：`convertSDKMessage` 对 `result` 消息仅在非 success 时生成系统消息（`src/remote/sdkMessageAdapter.ts:222-226`），因为 `isLoading=false` 状态已足够标识会话完成