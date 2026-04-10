# CCRClient

## 概述与职责

`CCRClient` 是 Worker 端与云端运行时（Cloud Code Runtime, CCR）服务端的完整通信客户端，定义于 `src/cli/transports/ccrClient.ts`（998 行）。它在系统架构中属于 **CLITransport → Transports** 层，被 `RemoteIO`（StructuredIO 的远程子类）使用，负责远程会话中 Worker 进程与 CCR 服务端之间的所有 HTTP 通信。

其核心职责包括：

- **Worker 注册与生命周期管理**：通过 epoch 机制确保同一时刻只有一个有效 Worker
- **心跳保活**：每 20 秒发送一次心跳，防止服务端判定 Worker 下线（服务端 TTL 为 60 秒）
- **事件上传**：将客户端事件（前端可见）和内部事件（会话恢复用）分别上传至 CCR
- **流式事件优化**：对 `stream_event` 进行 100ms 缓冲 + `text_delta` 快照累积合并，减少 POST 次数
- **Worker 状态上报**：通过 `WorkerStateUploader` 上报 idle/busy/requires_action 等状态
- **事件投递确认**：接收到服务端推送的事件后回报 delivery 状态
- **认证与熔断**：处理 JWT 过期检测和连续 401 熔断保护

同级模块包括 `WebSocketTransport`（全双工 WS）、`SSETransport`（SSE 读 + HTTP POST 写）、`HybridTransport`（WS 读 + HTTP POST 写）以及 `SerialBatchEventUploader`、`WorkerStateUploader` 两个上传原语。

## 关键流程

### 1. 初始化流程（`initialize`）

`initialize(epoch?)` 是客户端的启动入口，完成以下步骤：

1. **验证认证头**：检查 `getAuthHeaders()` 是否返回有效 header，否则抛出 `CCRInitError('no_auth_headers')`
2. **读取 epoch**：优先使用参数传入的 epoch，否则从环境变量 `CLAUDE_CODE_WORKER_EPOCH` 读取；无效时抛出 `CCRInitError('missing_epoch')`（`src/cli/transports/ccrClient.ts:459-471`）
3. **并发执行两个请求**：
   - `getWorkerState()`：GET 读取上一个 Worker 留下的 `external_metadata`（用于会话恢复）
   - `PUT /worker`：注册当前 Worker，设置状态为 `idle`，清除上一次崩溃残留的 `pending_action` 和 `task_summary`
4. **启动心跳定时器**：调用 `startHeartbeat()`
5. **注册 keep_alive 回调**：通过 `registerSessionActivityCallback` 在 API 调用或工具执行期间自动发送 `keep_alive` 事件，防止容器租约过期
6. **返回恢复的元数据**：等待 `getWorkerState()` 完成，返回 `external_metadata`（如有）

```typescript
// src/cli/transports/ccrClient.ts:473-498
// 并发发起 GET（读取上次状态）和 PUT（注册当前 Worker）
const restoredPromise = this.getWorkerState()
const result = await this.request('put', '/worker', {
  worker_status: 'idle',
  worker_epoch: this.workerEpoch,
  external_metadata: { pending_action: null, task_summary: null },
}, 'PUT worker (init)')
```

### 2. 心跳机制

心跳通过 `startHeartbeat()` 启动，以 `setTimeout` 递归调度的方式运行：

- **间隔**：默认 20 秒（`DEFAULT_HEARTBEAT_INTERVAL_MS`），服务端 TTL 为 60 秒，约 3 次心跳余量
- **抖动**：可通过 `heartbeatJitterFraction` 配置随机抖动，避免多 Worker 同时发送
- **防重入**：`heartbeatInFlight` 标志确保同一时刻只有一个心跳请求在飞
- **端点**：`POST /sessions/{id}/worker/heartbeat`，超时 5 秒（`src/cli/transports/ccrClient.ts:706-723`）
- **关闭感知**：每次 tick 后检查 `heartbeatTimer` 是否被 `close()` 置空，避免已关闭客户端继续调度

### 3. 事件上传流程

CCRClient 管理四个独立的上传器，全部基于 `SerialBatchEventUploader`：

| 上传器 | 端点 | 用途 | 批量上限 |
|--------|------|------|----------|
| `eventUploader` | `POST /worker/events` | 前端可见的客户端事件（stream_event、assistant 等） | 100 条 / 10MB |
| `internalEventUploader` | `POST /worker/internal-events` | Worker 内部事件（会话恢复用转录消息、压缩标记） | 100 条 / 10MB |
| `deliveryUploader` | `POST /worker/events/delivery` | 事件投递状态确认 | 64 条 |
| `workerState` | `PUT /worker`（通过 `WorkerStateUploader`） | Worker 状态上报 | 单条（最新状态覆盖） |

所有上传器共享相同的重试策略：基础延迟 500ms，最大延迟 30s，抖动 500ms。

### 4. stream_event 缓冲与 text_delta 快照累积

这是该模块最精巧的机制，目标是减少 HTTP 请求数并让中途连接的客户端看到完整文本而非片段。

**缓冲层**（`writeEvent` → `flushStreamEventBuffer`）：
1. `stream_event` 类型消息不立即上传，而是推入 `streamEventBuffer`
2. 首条消息触发 100ms 定时器（`STREAM_EVENT_FLUSH_INTERVAL_MS`）
3. 定时器到期或非 stream 事件写入时 flush 缓冲区

**累积层**（`accumulateStreamEvents`）：
1. `message_start` 事件记录当前作用域（`session_id:parent_tool_use_id`）的活跃消息 ID
2. `content_block_delta` 中的 `text_delta` 按消息 ID + block index 追加到 chunks 数组
3. 每次 flush 时，同一 block 的所有增量合并为一个**完整快照事件**（`chunks.join('')`）
4. 非 `text_delta` 类型的 delta（如 `input_json_delta`）直接透传

```typescript
// src/cli/transports/ccrClient.ts:141-203 核心合并逻辑
// 每次 flush 产生的事件是自包含的全文快照，而非增量片段
const snapshot: CoalescedStreamEvent = {
  type: 'stream_event',
  uuid: msg.uuid,  // 复用首个 delta 的 UUID，保证服务端幂等性
  session_id: msg.session_id,
  parent_tool_use_id: msg.parent_tool_use_id,
  event: {
    type: 'content_block_delta',
    index: msg.event.index,
    delta: { type: 'text_delta', text: chunks.join('') },
  },
}
```

**生命周期清理**：当完整的 `assistant` 消息到达 `writeEvent` 时，调用 `clearStreamAccumulatorForMessage` 清除对应消息的累积状态——这是可靠的结束信号，即使 abort/error 路径跳过了 SSE 的 `content_block_stop` / `message_stop` 事件。

### 5. 认证与熔断机制

`request()` 方法是所有 HTTP 通信的统一出口，包含完整的认证保护：

- **401/403 + JWT 已过期**：通过 `decodeJwtExpiry` 检查 token 的 `exp` 字段。若已过期则立即调用 `onEpochMismatch()` 退出——确定性失败，重试无意义（`src/cli/transports/ccrClient.ts:593-602`）
- **401/403 + JWT 未过期**：累加 `consecutiveAuthFailures` 计数器。达到阈值 10（约 200 秒 = 10 × 20s 心跳间隔）后熔断退出。此场景对应服务端瞬时故障（userauth 宕机、KMS 故障、时钟偏移）
- **2xx 响应**：重置 `consecutiveAuthFailures` 为 0
- **409 Conflict**：触发 epoch 不匹配处理，意味着更新的 Worker 已取代当前实例
- **429 Too Many Requests**：读取 `Retry-After` 头，返回 `retryAfterMs` 供上传器使用

### 6. Epoch 机制与 Worker 替换

每个 Worker 实例持有一个 `workerEpoch` 编号。当新 Worker 注册时会获得更大的 epoch，服务端对旧 epoch 的请求返回 409。收到 409 时：

- 默认行为：`process.exit(1)`——适用于 spawn 模式，父进程（bridge）会重新拉起
- 可注入覆盖：通过构造函数 `opts.onEpochMismatch` 传入自定义处理——`replBridge` 等进程内调用方**必须**覆盖此回调以优雅关闭，否则会杀死用户的 REPL

## 函数签名与参数说明

### 构造函数

```typescript
constructor(
  transport: SSETransport,         // SSE 传输实例，用于注册事件接收回调
  sessionUrl: URL,                 // 会话 URL: https://host/v1/code/sessions/{id}
  opts?: {
    onEpochMismatch?: () => never  // epoch 冲突时的处理回调
    heartbeatIntervalMs?: number   // 心跳间隔，默认 20000ms
    heartbeatJitterFraction?: number // 心跳抖动系数，默认 0
    getAuthHeaders?: () => Record<string, string> // 认证头获取函数
  }
)
```

构造时立即在 `transport` 上注册 `onEvent` 回调，对每个收到的事件自动回报 `received` 状态。

### `initialize(epoch?: number): Promise<Record<string, unknown> | null>`

初始化 Worker 注册，返回上一个 Worker 的 `external_metadata`（用于恢复状态）。抛出 `CCRInitError` 若认证头缺失、epoch 无效或注册失败。

### `writeEvent(message: StdoutMessage): Promise<void>`

上传前端可见事件。`stream_event` 类型进入缓冲区延迟发送，其他类型立即 flush 缓冲后发送。

### `writeInternalEvent(eventType, payload, opts?): Promise<void>`

上传内部事件，支持 `isCompaction`（压缩标记）和 `agentId`（子 Agent 标识）选项。

### `reportState(state: SessionState, details?: RequiresActionDetails): void`

上报 Worker 状态（idle/busy/requires_action），包含可选的 action 详情（工具名、描述、请求 ID）。相同状态不会重复上报。

### `reportMetadata(metadata: Record<string, unknown>): void`

上报外部元数据（如 `pending_action`、`task_summary`），通过 `WorkerStateUploader` 发送。

### `reportDelivery(eventId, status): void`

回报事件投递状态：`received` / `processing` / `processed`。

### `readInternalEvents(): Promise<InternalEvent[] | null>`

分页读取前台 Agent 的内部事件（从最后一次压缩边界开始），用于会话恢复。

### `readSubagentInternalEvents(): Promise<InternalEvent[] | null>`

分页读取所有子 Agent 的内部事件，用于会话恢复。

### `flush(): Promise<void>`

排空 stream_event 缓冲区和客户端事件队列。应在 `close()` 前调用以确保事件投递。

### `close(): void`

清理所有定时器、上传器和累积状态。注意 `close()` 会**丢弃**缓冲区中未发送的事件——需要确保投递的场景应先调用 `flush()`。

## 接口与类型定义

### `CCRInitError`

初始化失败异常，携带类型化原因：

| `reason` | 含义 |
|-----------|------|
| `'no_auth_headers'` | 认证头为空 |
| `'missing_epoch'` | 未提供 epoch 且环境变量无效 |
| `'worker_register_failed'` | PUT /worker 注册失败（含 409） |

### `StreamAccumulatorState`

text_delta 累积器状态：

- `byMessage: Map<string, string[][]>`：消息 ID → 每个 content block 的 chunk 数组
- `scopeToMessage: Map<string, string>`：`{session_id}:{parent_tool_use_id}` → 当前活跃消息 ID

### `InternalEvent`

内部事件结构体，包含 `event_id`、`event_type`、`payload`、`is_compaction`、`created_at`、`agent_id` 等字段。

## 配置项与默认值

| 常量/参数 | 默认值 | 说明 |
|-----------|--------|------|
| `DEFAULT_HEARTBEAT_INTERVAL_MS` | 20,000ms | 心跳间隔（服务端 TTL 60s） |
| `STREAM_EVENT_FLUSH_INTERVAL_MS` | 100ms | stream_event 缓冲窗口 |
| `MAX_CONSECUTIVE_AUTH_FAILURES` | 10 | 连续 401 熔断阈值（≈200s） |
| `eventUploader.maxQueueSize` | 100,000 | 客户端事件队列上限 |
| `internalEventUploader.maxQueueSize` | 200 | 内部事件队列上限 |
| `deliveryUploader.maxBatchSize` | 64 | 投递确认批量上限 |
| 所有上传器 `baseDelayMs` | 500ms | 重试基础延迟 |
| 所有上传器 `maxDelayMs` | 30,000ms | 重试最大延迟 |
| `getWithRetry` 最大尝试次数 | 10 | GET 请求重试上限 |
| 环境变量 `CLAUDE_CODE_WORKER_EPOCH` | — | Worker epoch（由 bridge 设置） |

## 边界 Case 与注意事项

- **`close()` 不保证投递**：`close()` 直接清空缓冲区和上传器。需要确保事件投递的场景必须先调用 `flush()`，再调用 `close()`
- **中途连接的客户端**：text_delta 快照累积确保每次 flush 发出的事件包含从 block 起始的完整文本。但如果 `message_start` 丢失（如重连后未收到），delta 会直接透传而非生成快照
- **进程内使用必须覆盖 `onEpochMismatch`**：默认实现调用 `process.exit(1)`，仅适用于 spawn 模式。`replBridge` 等进程内调用方必须注入自定义回调
- **多会话并发必须注入 `getAuthHeaders`**：默认实现读取进程级环境变量 `CLAUDE_CODE_SESSION_ACCESS_TOKEN`，多会话场景下会互相覆盖
- **eventUploader 队列上限为 100,000**：远高于 `internalEventUploader` 的 200，因为 `flushStreamEventBuffer()` 可能一次性入队整个 100ms 窗口的事件，较小的队列会在 `SerialBatchEventUploader` 的背压检查处死锁
- **心跳超时仅 5 秒**（vs 常规请求的 10 秒），避免心跳阻塞过久影响下一轮调度