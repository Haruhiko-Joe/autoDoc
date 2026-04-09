# SSETransport

## Overview & Responsibilities

SSETransport is a communication transport for Claude Code Remote (CCR) v2 environments, sitting within the **Bootstrap → CLIIOLayer → Transports** layer. It implements the `Transport` interface using a split-channel design: **Server-Sent Events (SSE)** for reading server-to-client events, and **HTTP POST** for writing client-to-server events.

It is one of three transport implementations alongside `WebSocketTransport` (fully bidirectional WebSocket) and `HybridTransport` (WebSocket reads + POST writes). The transport selection logic in `transportUtils.ts` chooses `SSETransport` when the `CLAUDE_CODE_USE_CCR_V2` environment variable is set.

The transport is consumed by `RemoteIO` (in the StructuredIO layer), which feeds parsed messages into the headless query loop for remote/bridge sessions.

## Key Processes

### SSE Connection & Stream Reading Flow

1. **`connect()`** builds the SSE URL, appending `from_sequence_num` as a query parameter if resuming from a prior position (`src/cli/transports/SSETransport.ts:244-248`)
2. Fresh auth headers are obtained via `getAuthHeaders()`. If Cookie-based auth is present, the `Authorization` header is removed to avoid confusing the server's auth interceptor (`src/cli/transports/SSETransport.ts:253-263`)
3. A `Last-Event-ID` header is set to the last seen sequence number for SSE-level resumption (`src/cli/transports/SSETransport.ts:264-266`)
4. A native `fetch()` call opens the SSE stream with an `AbortController` for cancellation (`src/cli/transports/SSETransport.ts:275-278`)
5. On HTTP error, **permanent codes** (401, 403, 404) immediately transition to `closed`; other errors trigger reconnection (`src/cli/transports/SSETransport.ts:280-298`)
6. On success, the state transitions to `connected`, reconnection counters reset, and the liveness timer starts (`src/cli/transports/SSETransport.ts:312-316`)
7. **`readStream()`** reads chunks from the `ReadableStream`, appending decoded text to a buffer, then passes it through `parseSSEFrames()` for incremental frame extraction (`src/cli/transports/SSETransport.ts:339-351`)

### Incremental SSE Frame Parsing

`parseSSEFrames()` (`src/cli/transports/SSETransport.ts:58-116`) is an exported, stateless parser that processes an SSE text buffer:

1. Scans for double-newline (`\n\n`) delimiters that separate SSE frames
2. For each raw frame, splits into lines and parses `event:`, `id:`, and `data:` fields per the SSE specification (including multi-line `data:` concatenation with `\n`)
3. Lines starting with `:` are treated as SSE comments (e.g., keepalive pings) — these produce frames that reset the liveness timer but carry no data
4. Returns parsed frames plus the unconsumed buffer remainder for the next chunk

### Event Handling

`handleSSEFrame()` (`src/cli/transports/SSETransport.ts:425-465`) processes parsed frames:

1. Only `client_event` frames are expected on the worker subscriber stream; other event types are logged as warnings
2. The `data:` field is parsed as JSON into a `StreamClientEvent` structure containing `event_id`, `sequence_num`, `event_type`, `source`, `payload`, and `created_at`
3. The `payload` object is extracted and serialized as newline-delimited JSON, matching the format that `StructuredIO` consumers expect
4. An optional `onEventCallback` is fired with the full `StreamClientEvent` for higher-level consumers (e.g., `CCRClient`)

### Duplicate Detection & Sequence Tracking

During stream reading (`src/cli/transports/SSETransport.ts:357-384`):

- Each frame's `id:` field is parsed as a sequence number
- A `seenSequenceNums` Set tracks received sequence numbers to detect and log duplicates
- The Set is pruned when it exceeds 1000 entries, keeping only numbers within 200 of the high-water mark
- `lastSequenceNum` is updated monotonically and used for resumption on reconnect
- Callers can read `getLastSequenceNum()` before closing the transport and pass it as `initialSequenceNum` to the next instance to avoid replaying the full session history

### Reconnection with Exponential Backoff

`handleConnectionError()` (`src/cli/transports/SSETransport.ts:470-535`) manages reconnection:

1. Clears the liveness timer and aborts any in-flight SSE fetch
2. Tracks a **10-minute time budget** (`RECONNECT_GIVE_UP_MS = 600,000ms`) from the first failure
3. Computes backoff delay: `min(1000ms * 2^(attempt-1), 30,000ms)` with ±25% jitter
4. Calls `refreshHeaders()` before each attempt to obtain fresh auth credentials
5. If the budget is exhausted, transitions to `closed` and fires the `onCloseCallback`

### Liveness Detection

The server sends keepalive SSE comments every ~15 seconds. The transport sets a **45-second liveness timeout** (`src/cli/transports/SSETransport.ts:21`):

- `resetLivenessTimer()` is called on every received frame (including comment-only keepalives)
- If no frame arrives within 45 seconds, `onLivenessTimeout` aborts the connection and triggers reconnection
- The timeout callback is a bound method (`src/cli/transports/SSETransport.ts:542`) rather than an inline closure to avoid per-frame allocation

### HTTP POST Write Path

`write()` (`src/cli/transports/SSETransport.ts:572-653`) sends client events to the server:

1. Obtains auth headers; returns early if no session token is available
2. POSTs the message as JSON to the `postUrl` (derived by stripping `/stream` from the SSE URL)
3. Retries up to **10 times** with exponential backoff: `min(500ms * 2^(attempt-1), 8000ms)`
4. **4xx errors** (except 429) are treated as permanent client errors — no retry
5. **429 and 5xx errors** are retried
6. Network errors (connection refused, timeout) are also retried

## Function Signatures

### `constructor(url, headers?, sessionId?, refreshHeaders?, initialSequenceNum?, getAuthHeaders?)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | `URL` | SSE stream endpoint URL |
| `headers` | `Record<string, string>` | Additional headers for requests |
| `sessionId` | `string` | Session identifier for logging |
| `refreshHeaders` | `() => Record<string, string>` | Called before each reconnect to refresh auth headers |
| `initialSequenceNum` | `number` | High-water mark to seed resumption (avoids replaying full history) |
| `getAuthHeaders` | `() => Record<string, string>` | Per-instance auth header source; defaults to process-wide `getSessionIngressAuthHeaders` |

### `connect(): Promise<void>`

Opens the SSE stream connection. Only callable from `idle` or `reconnecting` states.

### `write(message: StdoutMessage): Promise<void>`

Sends a message to the server via HTTP POST with retry logic.

### `getLastSequenceNum(): number`

Returns the highest sequence number seen on this stream. Used to seed the next transport instance's `initialSequenceNum`.

### `close(): void`

Aborts the SSE connection, clears all timers, and transitions state to `closing`.

### Transport Interface Methods

- **`isConnectedStatus()`**: Returns `true` when state is `connected`
- **`isClosedStatus()`**: Returns `true` when state is `closed`
- **`setOnData(callback)`**: Registers the handler for incoming payload data (newline-delimited JSON)
- **`setOnClose(callback)`**: Registers the handler for transport closure (receives optional HTTP status code for permanent failures)
- **`setOnEvent(callback)`**: Registers the handler for raw `StreamClientEvent` objects

### `parseSSEFrames(buffer: string): { frames: SSEFrame[], remaining: string }`

Exported (for testing) stateless parser. Extracts complete SSE frames from a text buffer and returns the unconsumed remainder.

## Type Definitions

### `SSETransportState`

Union type for the transport's lifecycle states:

| State | Meaning |
|-------|---------|
| `idle` | Initial state before `connect()` |
| `connected` | SSE stream is open and receiving frames |
| `reconnecting` | Connection lost, backoff timer running |
| `closing` | `close()` called, aborting in progress |
| `closed` | Terminal state — permanent error or budget exhausted |

### `StreamClientEvent`

Payload shape for `event: client_event` SSE frames, matching the `StreamClientEvent` proto:

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | `string` | Unique event identifier |
| `sequence_num` | `number` | Monotonically increasing sequence number |
| `event_type` | `string` | Event type discriminator |
| `source` | `string` | Event source |
| `payload` | `Record<string, unknown>` | Inner payload passed to `onData` |
| `created_at` | `string` | ISO timestamp |

### `SSEFrame`

Internal representation of a parsed SSE frame with optional `event`, `id`, and `data` fields.

## Configuration & Defaults

| Constant | Value | Purpose |
|----------|-------|---------|
| `RECONNECT_BASE_DELAY_MS` | 1,000 ms | Initial reconnect backoff delay |
| `RECONNECT_MAX_DELAY_MS` | 30,000 ms | Maximum reconnect backoff delay |
| `RECONNECT_GIVE_UP_MS` | 600,000 ms (10 min) | Total time budget for reconnection attempts |
| `LIVENESS_TIMEOUT_MS` | 45,000 ms | Max silence before treating connection as dead |
| `POST_MAX_RETRIES` | 10 | Maximum retry attempts for HTTP POST writes |
| `POST_BASE_DELAY_MS` | 500 ms | Initial POST retry backoff delay |
| `POST_MAX_DELAY_MS` | 8,000 ms | Maximum POST retry backoff delay |
| `PERMANENT_HTTP_CODES` | {401, 403, 404} | HTTP codes that immediately close without retry |

## Edge Cases & Caveats

- **Cookie vs Authorization auth**: When `getAuthHeaders()` returns a `Cookie` header, the `Authorization` header is explicitly deleted from the merged headers to prevent the server's auth interceptor from seeing both (`src/cli/transports/SSETransport.ts:261-263`)
- **Duplicate frames**: The server may replay events around reconnection boundaries. The transport deduplicates via a `seenSequenceNums` Set but only logs duplicates rather than dropping them silently — the `onData` callback is still invoked. The Set is pruned to prevent unbounded memory growth (`src/cli/transports/SSETransport.ts:371-378`)
- **Frames without `event:` field**: Data frames lacking an `event:` field are dropped with a warning log, as they indicate the old envelope format or a server bug (`src/cli/transports/SSETransport.ts:388-396`)
- **Multi-session concurrency**: The default `getAuthHeaders` reads a process-global environment variable (`CLAUDE_CODE_SESSION_ACCESS_TOKEN`). For concurrent multi-session callers, a per-instance `getAuthHeaders` function must be provided to avoid cross-session token stomping (`src/cli/transports/SSETransport.ts:197-202`)
- **URL conversion**: The POST endpoint URL is derived by stripping the `/stream` suffix from the SSE URL path. For example, `.../events/stream` becomes `.../events` (`src/cli/transports/SSETransport.ts:704-711`)
- **Liveness timer allocation**: The timeout callback is a pre-bound method rather than a per-frame inline closure to minimize GC pressure on high-throughput streams (`src/cli/transports/SSETransport.ts:542`)