# HybridTransport

## Overview & Responsibilities

HybridTransport is a specialized transport implementation that extends `WebSocketTransport` to split its communication channels: **WebSocket for reads** (receiving messages from the server) and **HTTP POST for writes** (sending messages to the server). It lives in the CLI I/O layer within the Bootstrap module hierarchy, alongside sibling transports (WebSocketTransport, SSETransport, CCRClient) that are selected by `transportUtils` based on URL and environment flags.

The motivation for this split is documented directly in the class: bridge mode fires writes via `void transport.write()` (fire-and-forget). Without serialization, concurrent POSTs would cause concurrent Firestore writes to the same document, leading to collisions, retry storms, and oncall pages. HybridTransport solves this by delegating all writes through a `SerialBatchEventUploader` that guarantees at most one POST is in-flight at a time.

## Key Processes

### Write Flow

The write pipeline is the core of HybridTransport. The class header contains an ASCII diagram summarizing it (`src/cli/transports/HybridTransport.ts:28-38`):

1. **`stream_event` messages** are accumulated in a delay buffer (`streamEventBuffer`) for up to **100ms** before being enqueued. This reduces POST frequency for high-volume content deltas (e.g., streaming assistant responses).

2. **Non-`stream_event` messages** trigger an immediate flush of any buffered stream events (to preserve ordering), then enqueue themselves for upload.

3. **`SerialBatchEventUploader`** handles the actual POST: it batches up to 500 events per request, serializes them (one POST in-flight at a time), retries on failure with exponential backoff + jitter, and provides backpressure via a 100,000-event queue cap.

4. **`postOnce()`** executes a single HTTP POST to the session-ingress endpoint. It classifies responses:
   - **2xx**: Success, move on.
   - **4xx (non-429)**: Permanent failure — drop the batch, don't retry.
   - **429 / 5xx**: Retryable — throw so the uploader re-queues with backoff.
   - **Network errors**: Retryable — throw for re-queue.

### URL Conversion

The constructor converts the WebSocket URL to an HTTP POST endpoint URL via `convertWsUrlToPostUrl()` (`src/cli/transports/HybridTransport.ts:269-282`):

```
wss://api.example.com/v2/session_ingress/ws/<session_id>
  → https://api.example.com/v2/session_ingress/session/<session_id>/events
```

The conversion replaces `wss:` → `https:` (or `ws:` → `http:`), swaps `/ws/` for `/session/` in the pathname, and appends `/events`.

### Graceful Shutdown

`close()` (`src/cli/transports/HybridTransport.ts:171-195`) handles teardown:

1. Clears the stream event delay timer and discards buffered events.
2. Races `uploader.flush()` against a **3-second grace timer** (`CLOSE_GRACE_MS`). This gives queued writes a last chance to POST, but doesn't block indefinitely.
3. After the race resolves, calls `uploader.close()` to terminate the drain loop.
4. Calls `super.close()` to tear down the underlying WebSocket.

The grace period is fire-and-forget (`void Promise.race(...)`) — `close()` returns synchronously while the drain happens in the background.

## Function Signatures

### `constructor(url, headers, sessionId, refreshHeaders, options)`

Extends `WebSocketTransport`'s constructor. Additional options:

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | `URL` | WebSocket URL (converted internally to HTTP POST URL) |
| `headers` | `Record<string, string>` | Headers for the WebSocket connection |
| `sessionId` | `string?` | Optional session identifier |
| `refreshHeaders` | `() => Record<string, string>` | Callback to refresh auth headers |
| `options.maxConsecutiveFailures` | `number?` | Cap on consecutive POST failures before dropping a batch (undefined = infinite retry) |
| `options.onBatchDropped` | `(batchSize, failures) => void` | Callback when a batch is dropped after hitting maxConsecutiveFailures |

### `write(message: StdoutMessage): Promise<void>`

Overrides `WebSocketTransport.write()`. Routes messages based on type:
- `stream_event`: Buffered for up to 100ms, resolves immediately.
- All other types: Flushes buffered stream events first (ordering guarantee), then enqueues and waits for the POST to complete.

### `writeBatch(messages: StdoutMessage[]): Promise<void>`

Enqueues multiple messages at once, flushing any buffered stream events first to maintain ordering. Waits for the queue to drain.

### `flush(): Promise<void>`

Blocks until all pending events (including buffered stream events) have been POSTed. Used by bridge's initial history flush so `onStateChange('connected')` fires only after persistence.

### `get droppedBatchCount: number`

Returns the total number of batches dropped by the uploader due to exceeding `maxConsecutiveFailures`. Useful for detecting silent data loss (snapshot before/after `writeBatch()`).

### `close(): void`

Synchronous. Clears buffers, gives queued writes up to 3 seconds to drain, then shuts down both the uploader and the underlying WebSocket.

## Configuration & Defaults

| Constant | Value | Purpose |
|----------|-------|---------|
| `BATCH_FLUSH_INTERVAL_MS` | 100ms | How long `stream_event` messages accumulate before being enqueued |
| `POST_TIMEOUT_MS` | 15,000ms | Per-attempt HTTP POST timeout to prevent hung connections from blocking the queue |
| `CLOSE_GRACE_MS` | 3,000ms | Maximum time `close()` waits for queued writes to drain |

Uploader configuration set in the constructor:

| Setting | Value | Notes |
|---------|-------|-------|
| `maxBatchSize` | 500 | Session-ingress accepts arbitrary batch sizes; this bounds payload size |
| `maxQueueSize` | 100,000 | Memory bound only — bridge callers don't `await`, so backpressure doesn't apply in practice |
| `baseDelayMs` | 500ms | Initial retry backoff |
| `maxDelayMs` | 8,000ms | Maximum retry backoff |
| `jitterMs` | 1,000ms | Random jitter added to backoff to avoid thundering herd |

## Authentication

Each POST is authenticated using a session ingress auth token obtained from `getSessionIngressAuthToken()` (`src/utils/sessionIngressAuth.ts`). If no token is available, the POST is silently skipped (logged as a warning) — this is treated as a permanent failure (no retry).

## Edge Cases & Caveats

- **Ordering guarantee**: Non-`stream_event` writes always flush buffered stream events first, ensuring message ordering is preserved even with the delay buffer.
- **Fire-and-forget callers**: Bridge mode uses `void transport.write()`. The returned Promise resolving later adds no latency since nobody awaits it, but the serialization guarantee still holds.
- **Backpressure is theoretical**: With `maxQueueSize` at 100,000 and callers not awaiting writes, the backpressure mechanism in `SerialBatchEventUploader` doesn't actually apply. The queue size serves only as a memory bound.
- **Grace period exceeds cleanup budget**: `CLOSE_GRACE_MS` (3s) exceeds `gracefulShutdown`'s 2s cleanup budget, but the process lives ~2s longer for hooks and analytics, making this a reasonable last resort.
- **Missing token = silent drop**: If `getSessionIngressAuthToken()` returns falsy, the batch is silently dropped (not retried). This is intentional — no token means the POST would fail anyway.
- **`maxConsecutiveFailures` is caller-controlled**: `replBridge` sets this to cap drain time on a failing server; the first-party `transportUtils` path leaves it undefined for infinite retry.