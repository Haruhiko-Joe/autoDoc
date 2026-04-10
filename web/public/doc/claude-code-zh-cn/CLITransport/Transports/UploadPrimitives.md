# 上传原语库（Upload Primitives）

## 概述与职责

上传原语库提供两个通用的异步上传器，位于 **CLITransport → Transports** 层级下，为 CCRClient 等传输层组件提供可靠的 HTTP 上传基础设施。两个上传器解决的是同一类问题——**如何在不稳定的网络环境中可靠地将数据发送到服务端**——但针对不同的数据特征采用了不同的策略：

- **`SerialBatchEventUploader`**（275 行）：面向**有序事件流**，保证严格串行、支持批量发送和背压控制
- **`WorkerStateUploader`**（131 行）：面向**状态快照**，利用"最新值覆盖旧值"的特性实现 patch 合并，天然有界无需背压

两者共同的设计原则：最多 1 个请求在途（in-flight）、指数退避重试、可被 `close()` 安全终止。

## 关键流程

### SerialBatchEventUploader 的 drain 循环

这是整个事件上传器的核心调度机制。drain 循环保证任意时刻最多 1 个 POST 在途：

1. **入队**：`enqueue()` 将事件追加到 `pending` 数组，若队列已满则阻塞调用方（背压）
2. **触发 drain**：`enqueue()` 在添加事件后调用 `void this.drain()` 启动循环
3. **取批次**：`takeBatch()` 从 `pending` 头部取出一批事件，同时受 `maxBatchSize`（条数）和 `maxBatchBytes`（字节数）双重限制
4. **发送**：调用 `config.send(batch)` 执行实际 HTTP POST
5. **成功**：重置失败计数，释放背压等待者，继续取下一批
6. **失败**：将批次重新放回 `pending` 头部（`batch.concat(this.pending)` 一次分配），计算退避延迟后 sleep，然后重试
7. **循环结束**：`pending` 为空时通知所有 `flush()` 等待者

```
enqueue() ──→ pending[] ──→ drain loop ──→ takeBatch() ──→ send()
    ↑                           │                           │
    │ (backpressure block)      │ (at most 1 running)       ├─ success → release backpressure → next batch
    │                           │                           └─ failure → re-queue → sleep → retry
    └───────────────────────────┘
```

> 核心调度逻辑：`src/cli/transports/SerialBatchEventUploader.ts:156-202`

### 背压机制

当 `pending.length + items.length > maxQueueSize` 时，`enqueue()` 通过 Promise 阻塞调用方（`src/cli/transports/SerialBatchEventUploader.ts:107-114`）。drain 循环每次成功发送或丢弃一个批次后调用 `releaseBackpressure()`，唤醒所有被阻塞的 `enqueue` 调用。这实现了生产者-消费者模型中的流量控制。

### 批次构建（takeBatch）

`takeBatch()` 的策略（`src/cli/transports/SerialBatchEventUploader.ts:213-233`）：

- 若未配置 `maxBatchBytes`：直接 `splice(0, maxBatchSize)`
- 若配置了字节限制：逐条序列化累加字节数，**第一条无条件取出**（即使超限），后续条目超限则停止
- 序列化失败的条目（如含 BigInt、循环引用）会被**原地丢弃**，避免毒化队列导致 `flush()` 永远挂起

### 重试与退避策略

两个上传器共享相同的退避公式（`src/cli/transports/SerialBatchEventUploader.ts:235-253`）：

- **指数退避**：`baseDelayMs * 2^(failures-1)`，上限 `maxDelayMs`
- **随机抖动**：`Math.random() * jitterMs`，叠加在退避值之上
- **Retry-After 支持**（仅 SerialBatchEventUploader）：当 `send()` 抛出 `RetryableError` 且携带 `retryAfterMs` 时，使用服务端建议值替代指数退避，但会被 clamp 到 `[baseDelayMs, maxDelayMs]` 并附加 jitter，防止 thundering herd

### WorkerStateUploader 的 patch 合并流程

WorkerStateUploader 的核心思路是**最多 2 个槽位**（1 in-flight + 1 pending），新 patch 自动合并进 pending：

1. **入队**：`enqueue(patch)` 将 patch 与现有 `pending` 合并（或直接赋值），然后触发 drain
2. **drain**：若无 in-flight 请求，取出 pending 作为 payload，置 `inflight = sendWithRetry(payload)`
3. **sendWithRetry**：循环调用 `config.send(current)` 直到成功或 `close()`
4. **重试时吸收**：每次重试前检查是否有新的 pending patch，若有则合并进当前 payload（`src/cli/transports/WorkerStateUploader.ts:80-84`），这意味着重试发送的永远是**最新的完整状态**
5. **成功后续发**：in-flight 完成后若 pending 非空，自动触发下一轮 drain

```
enqueue(patch) ──→ coalesce into pending ──→ drain() ──→ sendWithRetry()
                        ↑                                      │
                        │                                      ├─ success → check pending → drain again
                        │                                      └─ failure → sleep → absorb pending → retry
                        └── new enqueue() during in-flight ────┘
```

### Patch 合并规则（coalescePatches）

`coalescePatches()` 函数（`src/cli/transports/WorkerStateUploader.ts:106-131`）实现两级合并：

- **顶层键**（如 `worker_status`）：overlay 直接覆盖 base（last value wins）
- **metadata 键**（`external_metadata` / `internal_metadata`）：RFC 7396 Merge Patch——overlay 的键添加或覆盖到 base，`null` 值保留（供服务端执行删除）

## 函数签名与参数说明

### SerialBatchEventUploader\<T\>

#### `constructor(config: SerialBatchEventUploaderConfig<T>)`

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `maxBatchSize` | `number` | 每次 POST 的最大条目数，设为 1 则不批量 |
| `maxBatchBytes` | `number?` | 每次 POST 的最大序列化字节数，`undefined` 则仅按条数限制 |
| `maxQueueSize` | `number` | 等待队列上限，超出则 `enqueue()` 阻塞 |
| `send` | `(batch: T[]) => Promise<void>` | 实际发送函数，由调用方实现 |
| `baseDelayMs` | `number` | 退避基础延迟 |
| `maxDelayMs` | `number` | 退避最大延迟 |
| `jitterMs` | `number` | 随机抖动范围 |
| `maxConsecutiveFailures` | `number?` | 连续失败上限，达到后丢弃当前批次并继续 |
| `onBatchDropped` | `(batchSize, failures) => void` | 批次被丢弃时的回调 |

#### `enqueue(events: T | T[]): Promise<void>`

添加事件到队列。接受单个事件或数组。队列满时返回的 Promise 会阻塞直到有空间。`close()` 后调用为空操作。

#### `flush(): Promise<void>`

阻塞直到所有 pending 事件发送完毕。用于会话回合边界和优雅关闭。

#### `close(): void`

清空队列并终止处理。唤醒所有被 `enqueue()` 背压阻塞和 `flush()` 等待的调用方。

#### `get droppedBatchCount: number`

已丢弃批次的单调递增计数。调用方可在 `flush()` 前后对比此值检测是否有静默丢弃。

#### `get pendingCount: number`

当前队列深度。`close()` 后返回关闭时刻的快照值。

### RetryableError

```typescript
export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number)
}
```

在 `config.send()` 中抛出此错误可指示上传器使用服务端建议的 `retryAfterMs` 作为重试延迟（例如 HTTP 429 的 Retry-After 头），而非默认的指数退避。该值会被 clamp 到 `[baseDelayMs, maxDelayMs]` 并附加 jitter。

### WorkerStateUploader

#### `constructor(config: WorkerStateUploaderConfig)`

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `send` | `(body: Record<string, unknown>) => Promise<boolean>` | 发送函数，返回 `true` 表示成功 |
| `baseDelayMs` | `number` | 退避基础延迟 |
| `maxDelayMs` | `number` | 退避最大延迟 |
| `jitterMs` | `number` | 随机抖动范围 |

#### `enqueue(patch: Record<string, unknown>): void`

入队一个 patch。与已有 pending patch 自动合并。**同步方法**，fire-and-forget，调用方无需 await。

#### `close(): void`

终止上传器，清空 pending patch。

## 接口/类型定义

### SerialBatchEventUploaderConfig\<T\>

泛型配置类型，`T` 为事件类型。`send` 回调接收 `T[]` 批量数据。失败时抛出异常触发重试，抛出 `RetryableError` 可携带服务端建议的重试延迟。

### WorkerStateUploaderConfig

非泛型配置。`send` 回调接收合并后的 `Record<string, unknown>` 状态对象，返回 `boolean` 表示成功与否（与 SerialBatchEventUploader 的异常驱动重试不同）。

## 边界 Case 与注意事项

- **毒消息防护**：`takeBatch()` 在序列化失败时丢弃该条目（`src/cli/transports/SerialBatchEventUploader.ts:224-226`），防止无法序列化的事件卡住整个队列
- **close() 后的 pendingCount**：`close()` 会清空队列但保存快照值到 `pendingAtClose`，供关闭后的诊断日志读取
- **flush() 与 droppedBatches 的交互**：`flush()` 在批次被丢弃后仍会正常 resolve（不会抛出异常），调用方需通过 `droppedBatchCount` 检测是否有数据丢失
- **WorkerStateUploader 的 send 返回值**：使用 `boolean` 而非异常来表示失败，这与 SerialBatchEventUploader 的设计不同——因为状态上传失败通常不是"错误"，只是需要重试
- **WorkerStateUploader 无背压**：由于最多只有 1 个 pending slot，`enqueue()` 是同步的且永远不会阻塞——新 patch 直接合并进 pending，天然有界
- **sleep 可中断**：SerialBatchEventUploader 的退避 sleep 在 `close()` 时会被立即唤醒（`src/cli/transports/SerialBatchEventUploader.ts:144`），确保快速关闭