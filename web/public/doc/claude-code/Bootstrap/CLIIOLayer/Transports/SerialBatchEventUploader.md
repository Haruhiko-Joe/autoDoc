# SerialBatchEventUploader

## Overview & Responsibilities

The `SerialBatchEventUploader` is a generic, ordered event upload primitive located in the CLI I/O layer's Transports subsystem. Within the broader architecture, it sits under **Bootstrap → CLIIOLayer → Transports** and serves as the shared upload engine for both `HybridTransport` (which uses WebSocket for reads but HTTP POST for writes) and `CCRClient` (the CCR v2 protocol orchestrator).

Its core responsibility is to serialize outbound event delivery over HTTP POST while providing:

- **Serial ordering** — at most one POST is in-flight at any time
- **Batching** — groups pending items up to configurable count and byte limits
- **Retry with exponential backoff and jitter** — handles transient failures
- **Server-directed retry** — honors `Retry-After` headers via `RetryableError`
- **Backpressure** — blocks producers when the internal queue is full
- **Batch dropping** — optionally drops batches after N consecutive failures

## Key Processes

### Enqueue & Backpressure Flow

1. A caller invokes `enqueue(events)` with one or more events (`src/cli/transports/SerialBatchEventUploader.ts:101-119`)
2. If adding the items would exceed `maxQueueSize`, the caller's promise blocks — it awaits a resolver that the drain loop will trigger when space opens up
3. Once space is available (or immediately if the queue has room), items are pushed onto the `pending` array
4. `drain()` is kicked off (fire-and-forget) to begin sending

### Drain Loop (Core Send Cycle)

The drain loop (`src/cli/transports/SerialBatchEventUploader.ts:156-202`) is the heart of the uploader. It is guarded by a `draining` boolean so at most one instance runs at a time:

1. **Take a batch** — `takeBatch()` pulls up to `maxBatchSize` items from the front of `pending`, respecting the optional `maxBatchBytes` byte budget
2. **Send** — calls the user-provided `config.send(batch)` function
3. **On success** — resets the failure counter, releases backpressure waiters, and loops to the next batch
4. **On failure** — increments the failure counter, then either:
   - **Drops the batch** if `maxConsecutiveFailures` is set and the threshold is reached (calls `onBatchDropped`, resets failures, continues)
   - **Re-queues the batch** at the front of `pending` via `batch.concat(this.pending)` (single allocation, avoids O(n) unshift), then sleeps for the computed retry delay
5. **On drain complete** — sets `draining = false` and resolves any pending `flush()` promises

### Batch Assembly (`takeBatch`)

The `takeBatch` method (`src/cli/transports/SerialBatchEventUploader.ts:213-233`) supports two modes:

- **Count-only** (no `maxBatchBytes`): simple `splice(0, maxBatchSize)`
- **Count + byte limit**: iterates items, serializes each with `jsonStringify()` to measure byte length. The first item is always included regardless of size; subsequent items are added only if cumulative bytes stay under the limit. Un-serializable items (e.g., circular references, BigInt) are silently dropped to prevent queue poisoning.

### Retry Delay Calculation

The `retryDelay` method (`src/cli/transports/SerialBatchEventUploader.ts:235-253`) computes how long to wait before retrying:

- **Standard path**: `baseDelayMs * 2^(failures-1)`, clamped to `maxDelayMs`, plus random jitter in `[0, jitterMs)`
- **Server-directed path** (when `RetryableError.retryAfterMs` is set): the server's hint is clamped to `[baseDelayMs, maxDelayMs]`, then jitter is added. This prevents both hot-looping (floor) and indefinite stalling (ceiling), while the jitter prevents thundering herd when multiple sessions receive the same `Retry-After`

### Flush & Close

- **`flush()`** (`src/cli/transports/SerialBatchEventUploader.ts:125-133`): Returns a promise that resolves when `pending` is empty and no drain is active. Used at turn boundaries and graceful shutdown. Note: flush resolves normally even if batches were dropped — callers can snapshot `droppedBatchCount` before and after to detect this.
- **`close()`** (`src/cli/transports/SerialBatchEventUploader.ts:139-150`): Immediately drops all pending events, records `pendingAtClose` for diagnostics, cancels any active sleep, and resolves all blocked `enqueue()` and `flush()` callers. After close, all subsequent `enqueue()` calls are no-ops.

## Function Signatures

### `enqueue(events: T | T[]): Promise<void>`

Adds one or more events to the pending buffer. Returns immediately if queue has space; blocks (awaits) if the buffer exceeds `maxQueueSize`. No-ops after `close()`.

### `flush(): Promise<void>`

Blocks until all pending events have been successfully sent (or dropped). Kicks the drain loop if it isn't already running.

### `close(): void`

Immediately stops processing: clears the queue, cancels retry sleeps, and unblocks all waiting callers.

### `get droppedBatchCount: number`

Monotonic counter of batches dropped due to `maxConsecutiveFailures`. Useful for detecting silent data loss across flush boundaries.

### `get pendingCount: number`

Current queue depth. After `close()`, returns the count at close time for shutdown diagnostics.

## Interface/Type Definitions

### `RetryableError`

A custom `Error` subclass (`src/cli/transports/SerialBatchEventUploader.ts:26-33`) that `config.send()` can throw to signal a retryable failure with an optional server-supplied delay:

| Field | Type | Description |
|-------|------|-------------|
| `retryAfterMs` | `number \| undefined` | Server-suggested wait time (e.g., from a 429 response). Overrides exponential backoff when set. |

### `SerialBatchEventUploaderConfig<T>`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxBatchSize` | `number` | — | Max items per POST. Set to 1 for no batching. |
| `maxBatchBytes` | `number \| undefined` | `undefined` (no limit) | Max serialized JSON bytes per POST. First item always included regardless. |
| `maxQueueSize` | `number` | — | Max pending items before `enqueue()` blocks. |
| `send` | `(batch: T[]) => Promise<void>` | — | The actual HTTP call. Caller controls payload format. |
| `baseDelayMs` | `number` | — | Base delay for exponential backoff. |
| `maxDelayMs` | `number` | — | Upper cap on retry delay. |
| `jitterMs` | `number` | — | Random jitter range added to every retry delay. |
| `maxConsecutiveFailures` | `number \| undefined` | `undefined` (infinite) | Drop batch after this many consecutive failures. |
| `onBatchDropped` | `(batchSize: number, failures: number) => void` | — | Callback when a batch is dropped. |

## Edge Cases & Caveats

- **Un-serializable items are silently dropped**: If `jsonStringify()` throws for an item during `takeBatch()`, that item is spliced out of the queue. This prevents a single poison item from blocking the entire upload pipeline.
- **Re-queue uses `concat`, not `unshift`**: On failure, the batch is re-queued via `batch.concat(this.pending)` rather than `unshift(...batch)` to avoid O(n) array shifting on every retry — important since this is the hot failure path.
- **`flush()` resolves even after drops**: If `maxConsecutiveFailures` causes batches to be dropped during a flush, the promise still resolves normally. Callers must compare `droppedBatchCount` snapshots to detect data loss.
- **`close()` is immediate and non-graceful**: It does not wait for in-flight POSTs to complete. The sleep timer is cancelled, pending events are discarded, and all blocked callers are released.
- **`pendingCount` after close**: Returns the frozen count at close time, not zero, so shutdown diagnostics can report how many events were dropped.
- **Retry-After clamping**: Server-supplied `retryAfterMs` is always clamped to `[baseDelayMs, maxDelayMs]` — the server cannot force the client into either a hot-loop or an indefinite stall.
- **Jitter on Retry-After**: Jitter is added on top of the clamped server hint to prevent thundering herd when many sessions share a rate limit and all receive identical `Retry-After` values.
- **Single drain loop invariant**: The `draining` boolean ensures only one drain loop runs at a time. Multiple `enqueue()` calls while draining simply append to `pending`; they don't spawn additional loops.