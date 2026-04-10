# DirectConnect 直连会话管理器

## 概述与职责

DirectConnect 是 Claude Code 中用于**直连服务器会话**的客户端模块，位于 `BridgeAndRemote` 架构层。它允许客户端通过 HTTP POST 在远程服务器上创建会话，然后通过 WebSocket 建立双向通信通道，实现消息发送、权限请求响应和中断操作。

与同层级的 `bridge/`（远程控制模式）和 `remote/`（CCR 云端运行时）不同，DirectConnect 提供的是一种更轻量的**点对点直连**方式——客户端直接连接到一个运行 Claude Code 服务的实例，无需经过云端中转。

该模块由三个文件组成：

- **`types.ts`**：定义服务器配置、会话状态机和持久化索引的类型
- **`createDirectConnectSession.ts`**：HTTP 会话创建函数
- **`directConnectManager.ts`**：WebSocket 会话管理器类

## 关键流程

### 会话建立流程

1. 调用方（如 `src/main.tsx:188`）调用 `createDirectConnectSession()`，传入服务器地址、认证 token 和工作目录
2. 函数向 `${serverUrl}/sessions` 发起 HTTP POST 请求，请求体包含 `cwd` 和可选的 `dangerously_skip_permissions` 标志（`src/server/createDirectConnectSession.ts:49-58`）
3. 服务器返回 `{ session_id, ws_url, work_dir }` 响应，经 Zod schema（`connectResponseSchema`）校验后解析
4. 返回 `DirectConnectConfig` 对象（包含 `serverUrl`、`sessionId`、`wsUrl`、`authToken`），供后续 WebSocket 连接使用

### WebSocket 通信流程

1. 使用 `DirectConnectConfig` 构造 `DirectConnectSessionManager` 实例，注册回调函数集合（`DirectConnectCallbacks`）
2. 调用 `connect()` 建立 WebSocket 连接，通过 `authorization` 头传递 Bearer token（`src/server/directConnectManager.ts:50-58`）
3. 收到消息后按换行符拆分，逐行解析 JSON（NDJSON 格式）（`src/server/directConnectManager.ts:64-73`）
4. 根据消息类型分发处理：
   - **`control_request`（权限请求）**：`can_use_tool` 子类型触发 `onPermissionRequest` 回调；不支持的子类型自动返回错误响应，避免服务端挂起等待
   - **SDK 消息**（`assistant`、`result`、`system` 等）：过滤掉 `control_response`、`keep_alive`、`control_cancel_request`、`streamlined_text`、`streamlined_tool_use_summary` 和 `post_turn_summary` 后，转发给 `onMessage` 回调
5. 连接关闭和错误分别触发 `onDisconnected` 和 `onError` 回调

## 函数签名与参数说明

### `createDirectConnectSession(options): Promise<{ config, workDir? }>`

创建直连会话的入口函数。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `serverUrl` | `string` | 是 | 服务器 HTTP 地址 |
| `authToken` | `string` | 否 | Bearer 认证令牌 |
| `cwd` | `string` | 是 | 工作目录路径 |
| `dangerouslySkipPermissions` | `boolean` | 否 | 跳过权限校验（危险） |

**返回值**：`{ config: DirectConnectConfig, workDir?: string }`

**异常**：网络错误、HTTP 非 2xx 响应、响应格式校验失败均抛出 `DirectConnectError`。

> 源码位置：`src/server/createDirectConnectSession.ts:26-88`

### `DirectConnectSessionManager`

WebSocket 会话管理器，提供以下方法：

| 方法 | 签名 | 说明 |
|------|------|------|
| `connect()` | `(): void` | 建立 WebSocket 连接并注册事件监听 |
| `sendMessage(content)` | `(content: RemoteMessageContent): boolean` | 发送用户消息，返回是否成功 |
| `respondToPermissionRequest(requestId, result)` | `(requestId: string, result: RemotePermissionResponse): void` | 响应权限请求（allow 或 deny） |
| `sendInterrupt()` | `(): void` | 发送中断信号取消当前请求 |
| `disconnect()` | `(): void` | 关闭 WebSocket 连接 |
| `isConnected()` | `(): boolean` | 检查连接是否处于 OPEN 状态 |

> 源码位置：`src/server/directConnectManager.ts:40-213`

## 接口/类型定义

### `DirectConnectConfig`

WebSocket 连接所需的配置信息，由 `createDirectConnectSession` 返回。

| 字段 | 类型 | 说明 |
|------|------|------|
| `serverUrl` | `string` | 服务器地址 |
| `sessionId` | `string` | 服务器分配的会话 ID |
| `wsUrl` | `string` | WebSocket 连接地址 |
| `authToken` | `string?` | 认证令牌 |

### `DirectConnectCallbacks`

WebSocket 事件回调集合。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `onMessage` | `(message: SDKMessage) => void` | 是 | 收到 SDK 消息时回调 |
| `onPermissionRequest` | `(request, requestId) => void` | 是 | 收到工具权限请求时回调 |
| `onConnected` | `() => void` | 否 | 连接建立时回调 |
| `onDisconnected` | `() => void` | 否 | 连接断开时回调 |
| `onError` | `(error: Error) => void` | 否 | 连接错误时回调 |

### `ServerConfig`

服务器端配置类型（`src/server/types.ts:13-24`）。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `port` | `number` | - | 监听端口 |
| `host` | `string` | - | 监听地址 |
| `authToken` | `string` | - | 认证令牌 |
| `unix` | `string?` | - | Unix socket 路径（可选） |
| `idleTimeoutMs` | `number?` | - | 空闲超时（ms），0 表示永不过期 |
| `maxSessions` | `number?` | - | 最大并发会话数 |
| `workspace` | `string?` | - | 未指定 cwd 时的默认工作目录 |

### `SessionState`（会话状态机）

会话生命周期的五个状态：

```
starting → running → detached → stopping → stopped
```

- **`starting`**：会话正在初始化
- **`running`**：会话活跃，WebSocket 连接正常
- **`detached`**：客户端已断开但会话仍保留（支持重连）
- **`stopping`**：会话正在关闭
- **`stopped`**：会话已终止

### `SessionInfo`

单个会话的运行时信息（`src/server/types.ts:33-40`），包含 `id`、`status`（SessionState）、`createdAt` 时间戳、`workDir` 工作目录、`process`（子进程引用）和可选的 `sessionKey`。

### `SessionIndexEntry` 与 `SessionIndex`

持久化到 `~/.claude/server-sessions.json` 的会话索引，支持服务器重启后恢复会话。`SessionIndex` 是 `sessionKey → SessionIndexEntry` 的映射。

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 服务器分配的会话 ID |
| `transcriptSessionId` | `string` | 用于 `--resume` 恢复的会话 ID |
| `cwd` | `string` | 工作目录 |
| `permissionMode` | `string?` | 权限模式 |
| `createdAt` | `number` | 创建时间戳 |
| `lastActiveAt` | `number` | 最后活跃时间戳 |

## 协议格式

### 发送消息格式

`sendMessage` 发送的 JSON 遵循 `SDKUserMessage` 格式（`src/server/directConnectManager.ts:131-139`）：

```json
{
  "type": "user",
  "message": { "role": "user", "content": "<消息内容>" },
  "parent_tool_use_id": null,
  "session_id": ""
}
```

### 权限响应格式

`respondToPermissionRequest` 发送 `SDKControlResponse` 格式：

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "<requestId>",
    "response": {
      "behavior": "allow",
      "updatedInput": {}
    }
  }
}
```

当 `behavior` 为 `"deny"` 时，`response` 中包含 `message` 字段代替 `updatedInput`。

### 中断请求格式

`sendInterrupt` 发送：

```json
{
  "type": "control_request",
  "request_id": "<uuid>",
  "request": { "subtype": "interrupt" }
}
```

## 边界 Case 与注意事项

- **连接状态检查**：`sendMessage`、`respondToPermissionRequest`、`sendInterrupt` 均在发送前检查 WebSocket 是否处于 `OPEN` 状态，未连接时静默失败（`sendMessage` 返回 `false`，其余无返回值）
- **NDJSON 解析容错**：消息按换行拆分后逐行解析 JSON，解析失败的行会被静默跳过（`src/server/directConnectManager.ts:70-74`）
- **未知控制请求自动回复错误**：收到不支持的 `control_request` 子类型时，自动发送 `error` 响应，防止服务端无限等待（`src/server/directConnectManager.ts:89-98`）
- **Bun 兼容性**：WebSocket 构造时使用 `as unknown as string[]` 类型转换，因为 Bun 的 WebSocket 支持 `headers` 选项但 DOM 类型定义不支持（`src/server/directConnectManager.ts:56-58`）
- **消息过滤**：`keep_alive`、`streamlined_text`、`streamlined_tool_use_summary`、`control_cancel_request` 和 `post_turn_summary` 类型的消息会被过滤，不传递给 `onMessage` 回调