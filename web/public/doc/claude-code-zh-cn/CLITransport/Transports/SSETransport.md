# SSETransport

## 概述与职责

`SSETransport` 是 CLI 传输协议适配层（Transports）中的一种传输实现，采用 **SSE（Server-Sent Events）读 + HTTP POST 写** 的半双工通信模式，用于连接 CCR v2（Cloud Code Runtime）云端运行时。

在整体架构中，它位于 `CLITransport > Transports` 层级下，与 `WebSocketTransport`（全双工 WS）和 `HybridTransport`（WS 读 + POST 写）并列，均实现了统一的 `Transport` 接口。传输选择由 `transportUtils.ts` 中的工厂函数 `getTransportForUrl()` 根据环境变量决定——当 `CLAUDE_CODE_USE_CCR_V2` 被设置时，选用 `SSETransport`。

上游消费者是 `StructuredIO` / `RemoteIO`，它们通过 `onData` 回调接收 newline-delimited JSON 格式的消息。

整个文件约 711 行，包含四个主要部分：SSE 帧增量解析器、连接与自动重连逻辑、活性超时检测、以及 HTTP POST 写入与重试。

## 关键流程

### 1. 连接与 SSE 流读取

```
connect() → fetch(SSE URL) → readStream(body) → parseSSEFrames() → handleSSEFrame()
```

1. `connect()` 构建带 `from_sequence_num` 查询参数的 SSE URL（用于断线恢复），组装请求头（包含认证、`Accept: text/event-stream`、`Last-Event-ID` 等）（`SSETransport.ts:231-333`）
2. 使用原生 `fetch` 发起 SSE 长连接请求
3. 连接成功后，进入 `readStream()` 循环：使用 `ReadableStream.getReader()` 逐块读取字节流，经 `TextDecoder` 解码后送入 `parseSSEFrames()` 增量解析（`SSETransport.ts:339-415`）
4. 每个解析出的帧会触发活性定时器重置；带 `id` 的帧更新 `lastSequenceNum` 高水位标记并进行去重
5. 带 `event` + `data` 的帧交给 `handleSSEFrame()` 处理——目前只识别 `client_event` 类型
6. `handleSSEFrame()` 将帧的 `payload` 字段提取后序列化为 JSON + `\n`，通过 `onData` 回调传递给上层（`SSETransport.ts:425-465`）

### 2. SSE 帧增量解析（parseSSEFrames）

`parseSSEFrames()` 是一个纯函数，接收文本缓冲区，返回解析出的帧数组和剩余未完成的缓冲区（`SSETransport.ts:58-116`）：

- 以双换行符 `\n\n` 为帧分隔符
- 每一行按 SSE 规范解析：`:` 开头为注释（keepalive），`event:`、`id:`、`data:` 为标准字段
- 多个 `data:` 行按规范用 `\n` 拼接
- 只有包含 `data` 或为纯注释的帧才会被发出

### 3. 自动重连（指数退避 + 时间预算）

当连接断开（流结束、HTTP 错误、网络异常、活性超时）时，`handleConnectionError()` 启动重连（`SSETransport.ts:470-535`）：

- **时间预算**：从首次错误开始计时，最多持续 10 分钟（`RECONNECT_GIVE_UP_MS = 600_000`），超时后放弃并转入 `closed` 状态
- **退避策略**：基础延迟 1 秒，每次翻倍，上限 30 秒（`RECONNECT_BASE_DELAY_MS` / `RECONNECT_MAX_DELAY_MS`）
- **抖动**：在计算出的延迟基础上添加 ±25% 随机抖动，避免雷群效应
- **恢复点**：重连时携带 `Last-Event-ID` 和 `from_sequence_num` 参数，服务端从断点续传
- **永久性错误**：HTTP 401/403/404 被视为永久拒绝，立即转入 `closed` 状态，不重试
- **Header 刷新**：重连前调用 `refreshHeaders()` 获取新的认证头

### 4. 活性超时检测

服务端每 15 秒发送 keepalive，客户端设定 45 秒无帧判定断线（`SSETransport.ts:542-566`）：

- 每收到任意帧（包括注释型 keepalive）都会重置 `livenessTimer`
- 超时触发 `onLivenessTimeout`：中止当前 fetch，进入重连流程
- `onLivenessTimeout` 使用类属性箭头函数绑定，避免每帧创建新闭包

### 5. HTTP POST 写入（带重试）

`write()` 方法通过 HTTP POST 向服务端发送消息（`SSETransport.ts:572-653`）：

- POST URL 由 SSE URL 转换而来：去掉路径末尾的 `/stream`（如 `.../events/stream` → `.../events`）
- 使用 axios 发送，`validateStatus` 设为始终返回 true 以自行处理状态码
- **重试策略**：最多 10 次（`POST_MAX_RETRIES`），基础延迟 500ms，每次翻倍，上限 8 秒
- **不重试的情况**：4xx 错误（429 除外）视为客户端错误，直接放弃
- **可重试的情况**：429（限流）和 5xx（服务端错误）以及网络异常
- 无可用 session token 时静默跳过

## 函数签名与参数说明

### `parseSSEFrames(buffer: string): { frames: SSEFrame[], remaining: string }`

增量 SSE 帧解析器（导出，供测试使用）。

| 参数 | 类型 | 说明 |
|------|------|------|
| buffer | `string` | 累积的文本缓冲区，可能包含不完整帧 |
| **返回** | `{ frames, remaining }` | 解析出的完整帧数组 + 剩余未完成缓冲区 |

### `constructor(url, headers?, sessionId?, refreshHeaders?, initialSequenceNum?, getAuthHeaders?)`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| url | `URL` | - | SSE 流端点 URL |
| headers | `Record<string, string>` | `{}` | 附加请求头 |
| sessionId | `string` | - | 会话 ID（用于日志） |
| refreshHeaders | `() => Record<string, string>` | - | 重连时刷新请求头的回调 |
| initialSequenceNum | `number` | - | 初始序列号高水位，用于跨 transport 实例续传 |
| getAuthHeaders | `() => Record<string, string>` | `getSessionIngressAuthHeaders` | 认证头获取函数，多会话场景需传入以避免全局环境变量冲突 |

### `connect(): Promise<void>`

发起 SSE 连接。仅在 `idle` 或 `reconnecting` 状态下可调用。

### `write(message: StdoutMessage): Promise<void>`

通过 HTTP POST 发送消息到服务端，内置指数退避重试。

### `close(): void`

关闭连接。清除重连定时器和活性定时器，中止进行中的 fetch 请求。

### `getLastSequenceNum(): number`

返回当前序列号高水位。调用方在销毁 transport 前读取此值，传给下一个 transport 实例的 `initialSequenceNum` 以实现无缝续传。

### Transport 接口方法

| 方法 | 说明 |
|------|------|
| `isConnectedStatus()` | 当前是否处于 `connected` 状态 |
| `isClosedStatus()` | 当前是否处于 `closed` 状态 |
| `setOnData(callback)` | 注册数据接收回调（payload JSON + `\n`） |
| `setOnClose(callback)` | 注册连接关闭回调（可选 closeCode 参数） |
| `setOnEvent(callback)` | 注册原始 `StreamClientEvent` 事件回调 |

## 接口/类型定义

### `SSETransportState`

传输状态机，共 5 个状态：

| 状态 | 说明 |
|------|------|
| `idle` | 初始状态，尚未连接 |
| `connected` | SSE 流已建立，正常收发 |
| `reconnecting` | 断线后正在重连 |
| `closing` | 主动关闭中 |
| `closed` | 已关闭（永久错误或重连超时） |

### `SSEFrame`

SSE 帧的内部表示：

```typescript
type SSEFrame = {
  event?: string  // event: 字段值
  id?: string     // id: 字段值（序列号）
  data?: string   // data: 字段值（多行拼接）
}
```

### `StreamClientEvent`

服务端 `client_event` 帧的 payload 结构（对应 `session_stream.proto` 中的 `StreamClientEvent`）：

```typescript
export type StreamClientEvent = {
  event_id: string
  sequence_num: number
  event_type: string
  source: string
  payload: Record<string, unknown>
  created_at: string
}
```

Worker 订阅者只会收到 `client_event` 类型的帧；`delivery_update`、`session_update`、`ephemeral_event`、`catch_up_truncated` 等事件仅限客户端通道使用。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `RECONNECT_BASE_DELAY_MS` | 1000 | 重连基础延迟 |
| `RECONNECT_MAX_DELAY_MS` | 30000 | 重连最大延迟 |
| `RECONNECT_GIVE_UP_MS` | 600000 | 重连时间预算（10 分钟） |
| `LIVENESS_TIMEOUT_MS` | 45000 | 活性超时阈值（服务端 keepalive 间隔 15s 的 3 倍） |
| `POST_MAX_RETRIES` | 10 | POST 最大重试次数 |
| `POST_BASE_DELAY_MS` | 500 | POST 重试基础延迟 |
| `POST_MAX_DELAY_MS` | 8000 | POST 重试最大延迟 |
| `PERMANENT_HTTP_CODES` | {401, 403, 404} | 永久性 HTTP 错误码，不重试 |

环境变量 `CLAUDE_CODE_USE_CCR_V2` 控制是否启用此传输（在 `transportUtils.ts` 中判断）。

## 边界 Case 与注意事项

- **序列号去重**：`seenSequenceNums` 集合防止重复帧被处理。当集合超过 1000 条时，会修剪掉远低于高水位的旧条目（阈值为 `lastSequenceNum - 200`），防止无限增长（`SSETransport.ts:370-378`）
- **Cookie vs Authorization 冲突**：当认证头包含 `Cookie` 时，会删除 `Authorization` 头，因为同时发送两者会导致服务端认证拦截器混乱（`SSETransport.ts:261-263`）
- **无 event 字段的帧**：如果收到带 `data:` 但无 `event:` 的帧，会记录警告并丢弃，而非尝试解析——这可能是旧格式或服务端 bug（`SSETransport.ts:388-396`）
- **跨实例续传**：调用方（如 `replBridge`）在销毁旧 transport 前通过 `getLastSequenceNum()` 读取高水位，传递给新实例的 `initialSequenceNum`，避免服务端重放全部历史（`SSETransport.ts:209-215`）
- **POST 失败不阻塞**：POST 重试耗尽后仅记录日志，不抛异常，不影响 SSE 读取流
- **TextDecoder 流模式**：使用 `{ stream: true }` 选项确保多字节字符跨 chunk 边界时正确解码（`SSETransport.ts:35`）
- **URL 转换**：SSE 流 URL（`.../events/stream`）与 POST URL（`.../events`）共享相同基础路径，`convertSSEUrlToPostUrl()` 通过去除 `/stream` 后缀完成转换（`SSETransport.ts:704-711`）