# CCRClient

## Overview & Responsibilities

CCRClient is the orchestrator for the **CCR (Claude Code Remote) v2 protocol**, implementing the complete server-side worker lifecycle. It lives within the CLI IO layer's transport subsystem (Bootstrap → CLIIOLayer → Transports) alongside WebSocket, SSE, and Hybrid transports. While those transports handle bidirectional message framing, CCRClient manages the higher-level worker protocol: registration, heartbeat liveness, event uploading, state reporting, and auth token management.

The module consists of two classes:

- **`CCRClient`** (~1000 lines, `src/cli/transports/ccrClient.ts`) — the main orchestrator
- **`WorkerStateUploader`** (~130 lines, `src/cli/transports/WorkerStateUploader.ts`) — a coalescing uploader for worker state PUT requests

It also exports several free functions and types for **stream event accumulation** — the text_delta coalescing logic that converts incremental deltas into full-so-far snapshots.

## Key Processes

### Worker Initialization Flow

The `initialize()` method (`src/cli/transports/ccrClient.ts:459-526`) bootstraps the worker:

1. **Validate auth headers** — if none are available, throws `CCRInitError('no_auth_headers')`
2. **Resolve worker epoch** — from the explicit `epoch` argument (in-process callers like replBridge) or `CLAUDE_CODE_WORKER_EPOCH` env var (spawn-mode children). Throws `CCRInitError('missing_epoch')` if neither is available
3. **Concurrently**: fetches prior worker state via `GET /worker` (for session resume metadata) and registers the worker via `PUT /worker` with `worker_status: 'idle'`, clearing stale `pending_action`/`task_summary` metadata
4. **Start heartbeat timer** — schedules periodic `POST /worker/heartbeat` at 20s intervals
5. **Register session activity callback** — fires `keep_alive` events during long-running API calls or tool executions to prevent container lease expiry
6. Returns the restored `external_metadata` (or null) for the caller to use in session resume

### Heartbeat Lifecycle

Heartbeats (`src/cli/transports/ccrClient.ts:678-723`) keep the worker alive with the CCR server (server TTL is 60s):

1. `startHeartbeat()` schedules a recurring timer with configurable jitter
2. Each tick calls `POST /sessions/{id}/worker/heartbeat` with the session ID and epoch
3. A guard (`heartbeatInFlight`) prevents overlapping heartbeat requests
4. `stopHeartbeat()` clears the timer; `close()` calls it during shutdown

### Stream Event Accumulation (text_delta Coalescing)

Stream events flow through a **100ms delay buffer** (`STREAM_EVENT_FLUSH_INTERVAL_MS`) before upload, enabling text_delta coalescing (`src/cli/transports/ccrClient.ts:37-42`):

1. `writeEvent()` pushes `stream_event` messages into `streamEventBuffer` and starts a 100ms flush timer
2. Non-stream events trigger an immediate flush to preserve ordering
3. `flushStreamEventBuffer()` passes the buffer through `accumulateStreamEvents()` (`src/cli/transports/ccrClient.ts:141-203`)
4. The accumulator tracks text chunks per content block (keyed by API message ID and block index) in a `StreamAccumulatorState`
5. Multiple `text_delta` events for the same block within a flush window are **coalesced into a single event** containing the full accumulated text from the start of the block — a self-contained snapshot
6. Non-text-delta events (e.g., `input_json_delta`, `message_start`) pass through unchanged
7. When the complete `assistant` message arrives, `clearStreamAccumulatorForMessage()` cleans up the accumulator state

This design means a client connecting mid-stream receives a complete text snapshot, not a fragment.

### Event Uploading via Three SerialBatchEventUploader Instances

All server-bound data flows through one of three `SerialBatchEventUploader` pipelines, each with retry and backpressure:

| Uploader | Endpoint | Purpose | Max Batch | Max Queue |
|----------|----------|---------|-----------|-----------|
| `eventUploader` | `POST /worker/events` | Client-visible events (stream events, assistant messages, tool results) | 100 items / 10MB | 100,000 |
| `internalEventUploader` | `POST /worker/internal-events` | Worker-internal transcript state for session resume | 100 items / 10MB | 200 |
| `deliveryUploader` | `POST /worker/events/delivery` | Delivery acknowledgments for received client events | 64 items | 64 |

All three share the same retry config: 500ms base delay, 30s max, 500ms jitter. On failure, they throw `RetryableError` with optional `retryAfterMs` (from HTTP 429 `Retry-After` header).

### Worker State Reporting

State updates flow through `WorkerStateUploader` (`src/cli/transports/WorkerStateUploader.ts:29-96`), a coalescing fire-and-forget uploader:

1. `reportState()` (`src/cli/transports/ccrClient.ts:645-658`) enqueues `worker_status` + optional `requires_action_details`
2. `reportMetadata()` (`src/cli/transports/ccrClient.ts:661-663`) enqueues `external_metadata` patches
3. The uploader maintains at most **2 slots**: 1 in-flight PUT + 1 pending patch
4. New calls coalesce into pending via `coalescePatches()` — top-level keys use last-value-wins; `external_metadata`/`internal_metadata` keys use RFC 7396 merge (one level deep, null values preserved for server-side delete)
5. On failure: exponential backoff (500ms base, 30s cap, 500ms jitter), retries indefinitely, absorbing pending patches before each retry

### Auth Token Expiry Detection

The `request()` method (`src/cli/transports/ccrClient.ts:556-642`) handles auth failures with two strategies:

1. **Expired JWT fast-path**: On 401/403, decodes the token's `exp` claim. If the token is expired, exits immediately — retry is futile since no refresh was delivered
2. **Consecutive failure threshold**: If the token looks valid but the server returns 401/403 (server-side auth blip), increments `consecutiveAuthFailures`. After 10 consecutive failures (~200s at heartbeat rate), exits. Successful requests reset the counter to 0

### Epoch Mismatch Handling

When the server returns **409 Conflict**, it means a newer worker epoch has superseded this one (`src/cli/transports/ccrClient.ts:669-675`). The `onEpochMismatch` callback fires:

- **Spawn-mode** (default): `process.exit(1)` — the parent bridge re-spawns
- **In-process** (replBridge): Must be overridden to close gracefully without killing the REPL

## Function Signatures

### `CCRClient` Constructor

```typescript
constructor(
  transport: SSETransport,
  sessionUrl: URL,
  opts?: {
    onEpochMismatch?: () => never
    heartbeatIntervalMs?: number       // default: 20_000
    heartbeatJitterFraction?: number   // default: 0
    getAuthHeaders?: () => Record<string, string>
  }
)
```

> Source: `src/cli/transports/ccrClient.ts:310-446`

The constructor immediately wires `transport.setOnEvent()` to acknowledge received client events — this must be ready before `transport.connect()` is called.

### `initialize(epoch?: number): Promise<Record<string, unknown> | null>`

Registers the worker, starts heartbeats, returns restored metadata. Throws `CCRInitError` on failure.

> Source: `src/cli/transports/ccrClient.ts:459-526`

### `writeEvent(message: StdoutMessage): Promise<void>`

Enqueues a client-visible event. Stream events are buffered for 100ms; other events flush the buffer first.

> Source: `src/cli/transports/ccrClient.ts:735-751`

### `writeInternalEvent(eventType, payload, opts?): Promise<void>`

Persists a worker-internal event (transcript, compaction marker). Not visible to frontend clients.

> Source: `src/cli/transports/ccrClient.ts:793-814`

### `readInternalEvents(): Promise<InternalEvent[] | null>`

Paginated GET of foreground agent internal events from the last compaction boundary. Used for session resume.

> Source: `src/cli/transports/ccrClient.ts:842-844`

### `readSubagentInternalEvents(): Promise<InternalEvent[] | null>`

Same as above but with `subagents=true` — returns merged events across all non-foreground agents.

> Source: `src/cli/transports/ccrClient.ts:852-858`

### `reportState(state: SessionState, details?: RequiresActionDetails): void`

Reports worker status (idle, busy, requires_action) via the coalescing uploader. Skips if state hasn't changed.

> Source: `src/cli/transports/ccrClient.ts:645-658`

### `reportMetadata(metadata: Record<string, unknown>): void`

Reports external metadata via the coalescing uploader (RFC 7396 merge semantics).

> Source: `src/cli/transports/ccrClient.ts:661-663`

### `reportDelivery(eventId, status): void`

Acknowledges delivery of a client-to-worker event (`received` | `processing` | `processed`).

> Source: `src/cli/transports/ccrClient.ts:964-969`

### `flush(): Promise<void>`

Drains the stream event buffer and the client event uploader queue. Call before `close()` if delivery matters.

> Source: `src/cli/transports/ccrClient.ts:831-834`

### `close(): void`

Stops heartbeats, clears timers/buffers, closes all four uploaders.

> Source: `src/cli/transports/ccrClient.ts:982-998`

## Type Definitions

### `CCRInitFailReason`

```typescript
type CCRInitFailReason = 'no_auth_headers' | 'missing_epoch' | 'worker_register_failed'
```

Typed reason for `CCRInitError`, used by the diagnostics classifier.

### `StreamAccumulatorState`

```typescript
type StreamAccumulatorState = {
  byMessage: Map<string, string[][]>    // msg_id → blocks[index] → chunk array
  scopeToMessage: Map<string, string>   // "{session_id}:{parent_tool_use_id}" → active msg_id
}
```

Tracks text chunk accumulation across flush windows. Keyed by API message ID; cleaned up when the complete assistant message arrives.

> Source: `src/cli/transports/ccrClient.ts:104-114`

### `InternalEvent`

```typescript
type InternalEvent = {
  event_id: string
  event_type: string
  payload: Record<string, unknown>
  event_metadata?: Record<string, unknown> | null
  is_compaction: boolean
  created_at: string
  agent_id?: string
}
```

Represents a worker-internal event returned by the paginated GET endpoints.

> Source: `src/cli/transports/ccrClient.ts:233-241`

### `WorkerStateUploaderConfig`

```typescript
type WorkerStateUploaderConfig = {
  send: (body: Record<string, unknown>) => Promise<boolean>
  baseDelayMs: number
  maxDelayMs: number
  jitterMs: number
}
```

> Source: `src/cli/transports/WorkerStateUploader.ts:19-27`

## Configuration & Defaults

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_HEARTBEAT_INTERVAL_MS` | 20,000ms | Heartbeat period (server TTL is 60s, so ~3 heartbeats per TTL) |
| `STREAM_EVENT_FLUSH_INTERVAL_MS` | 100ms | Delay buffer window for text_delta coalescing |
| `MAX_CONSECUTIVE_AUTH_FAILURES` | 10 | 401/403 threshold before exit (~200s at heartbeat rate) |
| Retry base delay (all uploaders) | 500ms | Exponential backoff base |
| Retry max delay (all uploaders) | 30,000ms | Exponential backoff cap |
| Retry jitter (all uploaders) | 500ms | Random jitter range |
| GET retry attempts | 10 | Max retries for paginated reads |
| Request timeout (writes) | 10,000ms | Default timeout for POST/PUT |
| Request timeout (reads) | 30,000ms | Timeout for GET requests |
| Request timeout (heartbeat) | 5,000ms | Tighter timeout for heartbeat |

Environment variable: `CLAUDE_CODE_WORKER_EPOCH` — set by the bridge spawner to pass the epoch to spawn-mode children.

## Edge Cases & Caveats

- **Epoch mismatch is terminal**: A 409 response causes immediate exit (or graceful close in replBridge mode). There is no recovery — the newer worker has taken over.

- **Stream accumulator cleanup relies on the assistant message, not SSE stop events**: `clearStreamAccumulatorForMessage()` is called when the complete `SDKAssistantMessage` arrives in `writeEvent()`. This is intentional — abort/error paths may skip `content_block_stop`/`message_stop` delivery, but the assistant message is always reliable.

- **Delta without message_start falls through**: If a `content_block_delta` arrives without a preceding `message_start` (e.g., reconnect mid-stream), it passes through raw since there's no chunk history to build a snapshot from (`src/cli/transports/ccrClient.ts:168-175`).

- **Event uploader queue size asymmetry**: The client event uploader allows 100,000 queued items (stream events can burst during rapid delta emission), while internal events cap at 200 and delivery at 64.

- **Transport event callback wired in constructor, not initialize()**: The `transport.setOnEvent()` call is in the constructor so it's ready before `transport.connect()` — avoids racing the first SSE catch-up frame (`src/cli/transports/ccrClient.ts:438-445`).

- **WorkerStateUploader never drops patches**: It retries indefinitely with backoff and absorbs pending patches during retry sleep. Only `close()` stops it.

- **`flush()` before `close()`**: `close()` abandons queued events. Callers that need delivery confirmation must call `flush()` first.

- **Auth header source injection**: Multi-session callers (concurrent sessions with distinct JWTs) must inject `getAuthHeaders` — the default reads from a process-global env var that would collide across sessions.