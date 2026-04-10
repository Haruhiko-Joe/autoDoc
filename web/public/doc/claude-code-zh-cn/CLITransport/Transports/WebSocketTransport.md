# WebSocketTransport

## 概述与职责

`WebSocketTransport` 是 CLI 传输协议层中的全双工 WebSocket 传输实现，位于 `src/cli/transports/WebSocketTransport.ts`（800 行）。它实现了 `Transport` 接口，通过 WebSocket 同时处理消息的读取和写入。

**在架构中的位置**：该模块属于 **CLITransport → Transports** 层，与 `SSETransport`（SSE 读 + HTTP POST 写）和 `HybridTransport`（WS 读 + HTTP POST 写）是同级的三种传输策略之一。上层 `StructuredIO` / `RemoteIO` 通过传输选择工厂按需创建具体传输实例。

核心能力：
- **全双工通信**：通过单一 WebSocket 连接同时收发消息
- **自动重连**：带指数退避、抖动和睡眠检测的重连机制
- **连接健康检查**：ping/pong 心跳检测死连接
- **Keep-Alive**：定期发送数据帧防止代理空闲超时（如 Cloudflare 5 分钟限制）
- **消息缓冲与重放**：使用 `CircularBuffer` 缓冲消息，断线重连后自动重放
- **mTLS 和代理支持**：通过工具函数配置 TLS 证书和代理
- **双运行时兼容**：同时支持 Bun 原生 WebSocket 和 Node.js `ws` 包

## 关键流程

### 状态机

传输层定义了 5 种状态，状态转换如下：

```
idle ──connect()──→ reconnecting ──onOpen──→ connected
                         ↑                       │
                         └──handleConnectionError─┘
                                    │
                    (超时/永久关闭码) ↓
                                  closed
```

- `idle`：初始状态，尚未调用 `connect()`
- `reconnecting`：正在建立或重新建立连接
- `connected`：连接已建立，可以收发消息
- `closing`：主动调用 `close()` 正在关闭
- `closed`：连接已终止，不再重试

> 源码位置：`src/cli/transports/WebSocketTransport.ts:60-65`

### 连接建立流程

1. `connect()` 检查当前状态必须为 `idle` 或 `reconnecting`，否则拒绝连接
2. 如果有 `lastSentId`，将其附加到 `X-Last-Request-Id` 请求头，用于服务端判断消息重放起点
3. 根据运行时环境选择 WebSocket 实现：
   - **Bun 环境**：使用 `globalThis.WebSocket`，通过 `addEventListener` 注册事件
   - **Node.js 环境**：动态导入 `ws` 包，通过 `.on()` 注册事件
4. 两种环境都配置了代理（`getWebSocketProxyAgent` / `getWebSocketProxyUrl`）和 mTLS（`getWebSocketTLSOptions`）

> 源码位置：`src/cli/transports/WebSocketTransport.ts:135-193`

### 连接成功后的初始化（handleOpenEvent）

连接成功时 `handleOpenEvent()` 执行以下操作（`src/cli/transports/WebSocketTransport.ts:296-329`）：

1. 记录连接耗时日志
2. 如果是 bridge 模式下的重连，上报重连遥测（尝试次数、宕机时长）
3. 重置重连相关状态（`reconnectAttempts`、`reconnectStartTime`）
4. 将状态切换为 `connected`，触发 `onConnectCallback`
5. 启动 ping 心跳定时器（`startPingInterval`）
6. 启动 keep-alive 定时器（`startKeepaliveInterval`）
7. 注册会话活动回调——当会话有活动信号时发送 `keep_alive` 消息

### 消息发送与缓冲

`write(message)` 是主要的消息发送方法（`src/cli/transports/WebSocketTransport.ts:660-681`）：

1. 如果消息包含 `uuid` 字段，将其添加到 `CircularBuffer`（最多 1000 条）并记录 `lastSentId`
2. 将消息序列化为 JSON + 换行符
3. 如果当前未连接（`state !== 'connected'`），消息已缓冲在 buffer 中，直接返回——等重连后自动重放
4. 已连接时调用 `sendLine()` 通过 WebSocket 发送

### 断线重连流程

`handleConnectionError(closeCode?)` 是重连的核心入口（`src/cli/transports/WebSocketTransport.ts:397-553`）：

1. 调用 `doDisconnect()` 清理当前连接（停止定时器、移除监听器、关闭 WebSocket）
2. **永久关闭码检测**：如果 `closeCode` 在 `PERMANENT_CLOSE_CODES`（1002、4001、4003）中，直接转入 `closed` 状态，不再重试。**例外**：4003（未授权）在 `refreshHeaders` 可用且返回了新 token 时允许重试
3. **autoReconnect 开关**：如果为 false，直接进入 `closed` 状态，由调用方（如 REPL bridge 轮询循环）自行处理恢复
4. **睡眠检测**：如果距上次重连尝试的间隔超过 `SLEEP_DETECTION_THRESHOLD_MS`（60 秒），判定系统经历了睡眠/唤醒，重置重连预算从头开始
5. **时间预算检查**：重连总耗时不超过 `DEFAULT_RECONNECT_GIVE_UP_MS`（10 分钟），超时则放弃
6. **指数退避 + 抖动**：延迟 = `min(1000ms × 2^(attempts-1), 30000ms)` ± 25% 随机抖动，避免惊群效应
7. 设置定时器，到期后调用 `connect()` 发起新连接

### 消息重放（replayBufferedMessages）

重连成功后触发消息重放（`src/cli/transports/WebSocketTransport.ts:574-634`）：

- **Node.js（ws 包）**：从 upgrade 响应头读取 `x-last-request-id`，只重放服务端尚未确认的消息，并从 buffer 中驱逐已确认的消息
- **Bun 环境**：无法获取 upgrade 响应头，重放全部缓冲消息，由服务端通过 UUID 去重
- 重放后**不清空** buffer——消息保留直到下次重连时服务端确认，防止重放后再次断线导致消息丢失

### Ping/Pong 心跳检测

`startPingInterval()`（`src/cli/transports/WebSocketTransport.ts:697-758`）每 10 秒执行：

1. **进程挂起检测**：如果两次 tick 间隔超过 60 秒，说明进程被挂起过（合盖、SIGSTOP、VM 暂停），直接触发重连，不等待 ping/pong 确认
2. **Pong 超时检测**：如果上次 ping 未收到 pong 回复，判定连接已死，触发重连
3. 发送新的 ping 帧，重置 `pongReceived` 标志

### Keep-Alive 数据帧

`startKeepaliveInterval()`（`src/cli/transports/WebSocketTransport.ts:767-792`）每 5 分钟发送 `{"type":"keep_alive"}` 数据帧：

- 目的是重置代理的空闲超时计数器（ping/pong 是控制帧，代理可能不计入活动）
- 在 CCR 远程环境（`CLAUDE_CODE_REMOTE` 环境变量为 truthy）下跳过，因为会话活动心跳已承担此职责

## 类型定义

### `WebSocketTransportOptions`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `autoReconnect` | `boolean` | `true` | 是否自动重连。设为 false 时调用方自行处理恢复 |
| `isBridge` | `boolean` | `false` | 是否启用 bridge 模式遥测（`tengu_ws_transport_*` 事件） |

### `WebSocketTransportState`

5 种状态字面量联合类型：`'idle' | 'connected' | 'reconnecting' | 'closing' | 'closed'`

### `WebSocketLike`

Bun 原生 WebSocket 和 Node.js `ws` 包的公共接口抽象：

```typescript
type WebSocketLike = {
  close(): void
  send(data: string): void
  ping?(): void  // Bun 和 ws 都支持，但 DOM 类型中没有
}
```

> 源码位置：`src/cli/transports/WebSocketTransport.ts:68-72`

## 构造函数与公开 API

### `constructor(url, headers?, sessionId?, refreshHeaders?, options?)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | `URL` | WebSocket 服务端地址 |
| `headers` | `Record<string, string>` | 连接时附加的 HTTP 头 |
| `sessionId` | `string` | 可选的会话 ID，用于日志标识 |
| `refreshHeaders` | `() => Record<string, string>` | 头部刷新函数，重连时调用以获取新 token |
| `options` | `WebSocketTransportOptions` | 配置选项 |

### `connect(): Promise<void>`

建立 WebSocket 连接。只在 `idle` 或 `reconnecting` 状态下生效。

### `write(message: StdoutMessage): Promise<void>`

发送消息。带 `uuid` 的消息会被缓冲，未连接时消息仅入缓冲区，连接后自动重放。

### `close(): void`

主动关闭连接。清理所有定时器、取消待重连任务、移除监听器。

### `setOnData(callback)` / `setOnConnect(callback)` / `setOnClose(callback)`

注册数据接收、连接成功、连接关闭的回调函数。

### `isConnectedStatus()` / `isClosedStatus()` / `getStateLabel()`

状态查询方法。

## 配置常量与默认值

| 常量 | 值 | 说明 |
|------|------|------|
| `DEFAULT_MAX_BUFFER_SIZE` | 1000 | 消息缓冲区最大容量 |
| `DEFAULT_BASE_RECONNECT_DELAY` | 1000ms | 重连基础延迟 |
| `DEFAULT_MAX_RECONNECT_DELAY` | 30000ms | 重连最大延迟上限 |
| `DEFAULT_RECONNECT_GIVE_UP_MS` | 600000ms (10min) | 重连总时间预算 |
| `DEFAULT_PING_INTERVAL` | 10000ms | Ping 心跳间隔 |
| `DEFAULT_KEEPALIVE_INTERVAL` | 300000ms (5min) | Keep-alive 数据帧间隔 |
| `SLEEP_DETECTION_THRESHOLD_MS` | 60000ms | 睡眠检测阈值（两倍最大重连延迟） |

> 源码位置：`src/cli/transports/WebSocketTransport.ts:22-36`

### 永久关闭码（PERMANENT_CLOSE_CODES）

| 关闭码 | 含义 | 行为 |
|--------|------|------|
| 1002 | 协议错误（如会话已被清理） | 不重试，直接关闭 |
| 4001 | 会话过期/未找到 | 不重试，直接关闭 |
| 4003 | 未授权 | 如果 `refreshHeaders` 返回新 token 则重试，否则关闭 |

> 源码位置：`src/cli/transports/WebSocketTransport.ts:42-46`

## 边界 Case 与注意事项

- **内存泄漏防护**：每次重连前通过 `removeWsListeners()` 移除旧 WebSocket 上的所有事件监听器，防止在网络不稳定时因反复重连积累孤立的 WebSocket 对象和闭包（`src/cli/transports/WebSocketTransport.ts:360-378`）
- **竞态安全**：`onNodeOpen` 中在调用 `handleOpenEvent()` 之前捕获 `ws` 引用，因为 `onConnectCallback` 可能同步关闭传输导致 `this.ws` 变为 null（`src/cli/transports/WebSocketTransport.ts:247-249`）
- **消息重放不清空 buffer**：重放后保留 buffer 内容，防止"重放后再断线"场景下消息丢失（`src/cli/transports/WebSocketTransport.ts:631-633`）
- **进程挂起 vs. 网络断开**：ping 定时器同时检测 tick 间隔异常（进程被挂起）和 pong 超时（网络断开），两种情况都触发重连
- **代理空闲超时**：ping/pong 是 WebSocket 控制帧，某些代理（如 Cloudflare）不将其计入活动，因此额外发送 keep_alive 数据帧
- **遥测隔离**：`tengu_ws_transport_*` 遥测事件仅在 `isBridge=true` 时上报，避免 print-mode worker 产生噪音数据
- **Bun 兼容性限制**：Bun 的 WebSocket 不暴露 upgrade 响应头，因此无法获取 `x-last-request-id`，只能重放全部缓冲消息交由服务端去重