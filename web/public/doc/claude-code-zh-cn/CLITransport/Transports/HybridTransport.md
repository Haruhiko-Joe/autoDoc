# HybridTransport

## 概述与职责

HybridTransport 是 CLI 传输协议适配层（Transports）中的一种混合传输实现，采用 **WebSocket 读 + HTTP POST 写** 的分离策略。它继承自 `WebSocketTransport`，复用父类的 WebSocket 连接作为读通道（接收服务端消息），同时将所有写操作重写为 HTTP POST 请求发送到对应的 REST 端点。

在整体架构中，HybridTransport 位于 **CLITransport → Transports** 层级，与 `WebSocketTransport`（全双工 WS）和 `SSETransport`（SSE 读 + HTTP POST 写）并列，是三种传输策略之一。它被 `StructuredIO` / `RemoteIO` 等上层模块通过传输选择工厂（`transportUtils`）实例化，用于远程会话场景下的消息传输。

**核心设计动机**：Bridge 模式下调用方通过 `void transport.write()` 进行 fire-and-forget 写入。如果使用 WebSocket 发送写入，并发 POST 会导致 Firestore 同一文档的并发写冲突，引发重试风暴。HybridTransport 通过 `SerialBatchEventUploader` 将写入串行化，确保同一时刻最多只有一个 POST 在飞行中。

## 关键流程

### 写入流程总览

源码中的 ASCII 图清晰描述了写入数据流（`src/cli/transports/HybridTransport.ts:28-38`）：

```
write(stream_event) ─┐
                     │ (100ms timer)
                     │
                     ▼
write(other) ────► uploader.enqueue()  (SerialBatchEventUploader)
                     ▲    │
writeBatch() ────────┘    │ serial, batched, retries indefinitely,
                          │ backpressure at maxQueueSize
                          ▼
                     postOnce()  (single HTTP POST, throws on retryable)
```

### stream_event 延迟缓冲

1. 当 `write()` 收到 `type === 'stream_event'` 的消息时，不立即发送，而是将其推入 `streamEventBuffer` 数组（`src/cli/transports/HybridTransport.ts:118-129`）
2. 首条 stream_event 触发一个 100ms 的定时器（`BATCH_FLUSH_INTERVAL_MS`）
3. 定时器到期后调用 `flushStreamEvents()`，将缓冲区中累积的所有 stream_event 一次性通过 `uploader.enqueue()` 入队
4. 如果在定时器到期前收到非 stream_event 消息，`write()` 会先通过 `takeStreamEvents()` 立即提取并清空缓冲区，将缓冲的 stream_event 与当前消息一起入队，**保证消息顺序**

这一设计将高频的内容增量（content delta）合并，显著减少 POST 请求数。

### HTTP POST 发送（postOnce）

`postOnce()` 是单次 POST 尝试的实现（`src/cli/transports/HybridTransport.ts:202-261`）：

1. 通过 `getSessionIngressAuthToken()` 获取会话认证 token；如果没有 token，静默返回（不重试）
2. 使用 axios 发送 POST 请求，payload 格式为 `{ events: StdoutMessage[] }`，超时 15 秒（`POST_TIMEOUT_MS`）
3. 根据响应状态码分类处理：
   - **2xx**：成功，正常返回
   - **4xx（非 429）**：永久性错误，记录日志后丢弃，不重试
   - **429 / 5xx**：可重试错误，**抛出异常**让 `SerialBatchEventUploader` 重新入队并指数退避重试
   - **网络错误**：同样抛出异常触发重试

### URL 转换

`convertWsUrlToPostUrl()` 将 WebSocket URL 转换为对应的 HTTP POST 端点（`src/cli/transports/HybridTransport.ts:269-282`）：

```
wss://api.example.com/v2/session_ingress/ws/<session_id>
  → https://api.example.com/v2/session_ingress/session/<session_id>/events
```

转换规则：`wss:` → `https:`（`ws:` → `http:`），路径中 `/ws/` → `/session/`，末尾追加 `/events`。

### 关闭流程（close）

`close()` 方法（`src/cli/transports/HybridTransport.ts:171-195`）：

1. 清除 stream_event 定时器，清空缓冲区
2. 启动一个宽限期（`CLOSE_GRACE_MS = 3000ms`）：使用 `Promise.race` 在 `uploader.flush()` 和 3 秒超时之间竞争
3. 无论哪个先完成，都调用 `uploader.close()` 关闭上传器
4. 调用 `super.close()` 关闭底层 WebSocket 连接

该宽限期是"最后手段"——正常情况下 replBridge 的 teardown 流程会在 close 之前先完成 archive，archive 的延迟才是主要的排空窗口。

## 函数签名与参数说明

### `constructor(url, headers, sessionId, refreshHeaders, options)`

```typescript
constructor(
  url: URL,
  headers: Record<string, string> = {},
  sessionId?: string,
  refreshHeaders?: () => Record<string, string>,
  options?: WebSocketTransportOptions & {
    maxConsecutiveFailures?: number
    onBatchDropped?: (batchSize: number, failures: number) => void
  },
)
```

- **url**：WebSocket 连接地址，同时被转换为 HTTP POST 地址
- **headers**：传递给父类 WebSocketTransport 的连接头
- **sessionId**：会话标识
- **refreshHeaders**：刷新认证头的回调
- **options.maxConsecutiveFailures**：可选，连续失败上限。达到后丢弃当前批次而非无限重试。replBridge 场景会设置此值
- **options.onBatchDropped**：批次被丢弃时的回调

### `write(message: StdoutMessage): Promise<void>`

重写父类方法。stream_event 类型消息进入 100ms 延迟缓冲，其他类型立即入队发送。返回的 Promise 在事件实际 POST 成功后 resolve。

### `writeBatch(messages: StdoutMessage[]): Promise<void>`

批量写入接口。先清空 stream_event 缓冲区（保序），然后将所有消息一次性入队。

### `flush(): Promise<void>`

阻塞直到所有挂起的事件 POST 完成。用于 bridge 的初始历史刷新，确保 `onStateChange('connected')` 在数据持久化之后触发。

### `get droppedBatchCount: number`

只读属性，返回 uploader 丢弃的批次计数。用于 `writeBatch()` 前后对比检测静默丢弃。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|------|------|
| `BATCH_FLUSH_INTERVAL_MS` | 100ms | stream_event 延迟缓冲的合并窗口 |
| `POST_TIMEOUT_MS` | 15,000ms | 单次 POST 请求超时，防止卡死的连接阻塞串行队列 |
| `CLOSE_GRACE_MS` | 3,000ms | 关闭时的排空宽限期 |

SerialBatchEventUploader 配置（构造函数中硬编码）：

| 参数 | 值 | 说明 |
|------|------|------|
| `maxBatchSize` | 500 | 单次 POST 最大事件数 |
| `maxQueueSize` | 100,000 | 队列上限（内存保护） |
| `baseDelayMs` | 500ms | 重试基础延迟 |
| `maxDelayMs` | 8,000ms | 重试最大延迟 |
| `jitterMs` | 1,000ms | 重试抖动范围 |

## 边界 Case 与注意事项

- **Fire-and-forget 调用模式**：Bridge 调用方使用 `void transport.write()`，不等待 Promise。因此 `maxQueueSize` 设得很高（100,000），因为背压机制对不 await 的调用方无效。如果设太小且批次超过 maxQueueSize，会导致死锁
- **无 token 时静默丢弃**：如果 `getSessionIngressAuthToken()` 返回空，`postOnce()` 直接返回不抛异常，消息被静默丢弃
- **关闭时的竞态**：`close()` 是同步方法（立即返回），但通过 void Promise 在后台给队列 3 秒排空窗口。这意味着进程退出时可能有少量消息未发送——这是设计上的"尽力而为"策略
- **消息顺序保证**：非 stream_event 写入会先 flush 缓冲区中的 stream_event，确保整体消息顺序与调用顺序一致
- **永久性错误不重试**：4xx（非 429）响应被视为永久性错误直接丢弃，避免对已知不可恢复的请求无意义重试