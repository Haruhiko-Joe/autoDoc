# WebSocketTransport

## Overview & Responsibilities

`WebSocketTransport` is a bidirectional WebSocket transport that implements the `Transport` interface, serving as the primary communication channel for remote and bridge sessions in Claude Code. It sits within the **Bootstrap > CLIIOLayer > Transports** module hierarchy, alongside sibling transports (SSETransport, HybridTransport, CCRClient) that are selected at runtime by `transportUtils`.

Its core job is to maintain a reliable, long-lived WebSocket connection between the CLI client and the server, surviving network interruptions, proxy idle timeouts, and system sleep/wake cycles. It does this through automatic reconnection with exponential backoff, message buffering for replay after reconnects, keep-alive frame emission, and ping/pong health monitoring.

## Key Processes

### Connection Establishment

1. `connect()` guards against invalid state transitions — only `'idle'` or `'reconnecting'` states may initiate a connection (`src/cli/transports/WebSocketTransport.ts:136-143`)
2. If a `lastSentId` exists (from a prior connection), it's sent as the `X-Last-Request-Id` header so the server knows which messages were already delivered (`src/cli/transports/WebSocketTransport.ts:152-157`)
3. The runtime is detected: **Bun** uses `globalThis.WebSocket` with `addEventListener`, while **Node.js** dynamically imports the `ws` package and uses `.on()` (`src/cli/transports/WebSocketTransport.ts:159-192`)
4. Both runtimes configure proxy support (`getWebSocketProxyAgent` / `getWebSocketProxyUrl`) and mTLS (`getWebSocketTLSOptions`)
5. Five event handlers are attached: `open`, `message`, `error`, `close`, and `pong`

### Open / Reconnect Success

When the WebSocket opens, `handleOpenEvent()` runs (`src/cli/transports/WebSocketTransport.ts:296-329`):

1. Logs connection duration for diagnostics
2. If this was a reconnection (bridge mode), emits a `tengu_ws_transport_reconnected` analytics event with attempt count and downtime
3. Resets all reconnection state (attempts, start time)
4. Transitions state to `'connected'`
5. Fires the `onConnectCallback`
6. Starts the **ping interval** (10s) and **keep-alive interval** (5min)
7. Registers a session activity callback that sends a `keep_alive` frame on user activity

On Node.js, the `onNodeOpen` handler additionally checks the upgrade response for an `x-last-request-id` header and replays only unconfirmed buffered messages. On Bun (which lacks upgrade response headers), all buffered messages are replayed and the server deduplicates by UUID.

### Message Replay on Reconnection

`replayBufferedMessages(lastId)` (`src/cli/transports/WebSocketTransport.ts:574-634`) handles the at-least-once delivery guarantee:

1. Retrieves all messages from the `CircularBuffer`
2. If the server provided a `lastId`, finds that message in the buffer and evicts everything up to and including it — these were already received
3. Sends remaining unconfirmed messages one by one via `sendLine()`
4. Does **not** clear the buffer after replay — messages remain until the server confirms receipt on the next reconnection, preventing loss if the connection drops mid-replay

### Reconnection with Exponential Backoff

When a connection error or close event occurs, `handleConnectionError(closeCode?)` orchestrates recovery (`src/cli/transports/WebSocketTransport.ts:397-553`):

1. **Permanent close codes** — codes `1002` (protocol error), `4001` (session expired), and `4003` (unauthorized) cause an immediate transition to `'closed'` with no retry. Exception: `4003` can be retried if `refreshHeaders()` returns a new `Authorization` token (`src/cli/transports/WebSocketTransport.ts:427-438`)
2. **autoReconnect disabled** — goes straight to `'closed'`, letting the caller (e.g., REPL bridge poll loop) handle recovery
3. **Sleep/wake detection** — if the gap since the last reconnect attempt exceeds 60 seconds (`SLEEP_DETECTION_THRESHOLD_MS`), the machine likely slept. The reconnection budget and attempt counter are reset (`src/cli/transports/WebSocketTransport.ts:476-488`). The server will reject with permanent codes if the session was reaped during sleep
4. **Time budget check** — reconnection attempts continue for up to 10 minutes (`DEFAULT_RECONNECT_GIVE_UP_MS = 600_000`). After that, the transport gives up and transitions to `'closed'`
5. **Backoff calculation** — base delay doubles each attempt (1s, 2s, 4s, … capped at 30s), with ±25% random jitter to avoid thundering herd (`src/cli/transports/WebSocketTransport.ts:510-517`)
6. Headers are refreshed before each reconnect attempt (if `refreshHeaders` is provided)

### Ping/Pong Health Checks

`startPingInterval()` (`src/cli/transports/WebSocketTransport.ts:697-758`) runs a 10-second interval that:

1. **Detects process suspension** — if the wall-clock gap between ticks exceeds 60s, the process was suspended (laptop lid close, SIGSTOP). Forces an immediate reconnect without waiting for a ping/pong round-trip, since the socket is almost certainly dead (NAT mappings drop in 30s–5min)
2. **Detects dead connections** — if the previous ping received no pong, the connection is treated as dead and `handleConnectionError()` is called
3. Sends a WebSocket ping frame via `ws.ping()`

### Keep-Alive Frame Emission

`startKeepaliveInterval()` (`src/cli/transports/WebSocketTransport.ts:767-792`) sends a `{"type":"keep_alive"}` data frame every 5 minutes to reset proxy idle timers (e.g., Cloudflare's 5-minute idle timeout). This is skipped in CCR (Claude Code Remote) environments where session activity heartbeats handle the same purpose.

Additionally, a session activity callback is registered so that user activity triggers an immediate keep-alive frame — not just the periodic timer.

## Public API

### Constructor

```typescript
constructor(
  url: URL,
  headers: Record<string, string> = {},
  sessionId?: string,
  refreshHeaders?: () => Record<string, string>,
  options?: WebSocketTransportOptions,
)
```

| Parameter | Description |
|-----------|-------------|
| `url` | The WebSocket server URL |
| `headers` | HTTP headers sent with the WS handshake (e.g., `Authorization`) |
| `sessionId` | Optional session identifier for diagnostic logging |
| `refreshHeaders` | Called before each reconnect to get fresh headers (e.g., rotated tokens) |
| `options.autoReconnect` | When `false`, disables automatic reconnection (default: `true`) |
| `options.isBridge` | Enables bridge-mode telemetry events (`tengu_ws_transport_*`) (default: `false`) |

### `connect(): Promise<void>`

Opens the WebSocket connection. Can only be called from `'idle'` or `'reconnecting'` states.

### `write(message: StdoutMessage): Promise<void>`

Sends a message over the WebSocket. Messages with a `uuid` field are added to the circular buffer for replay on reconnection. If the transport is not currently connected, the message is silently buffered (no error thrown).

### `close(): void`

Cleanly shuts down the transport: clears reconnection timers, stops ping/keepalive intervals, unregisters session activity callbacks, and closes the underlying WebSocket.

### `isConnectedStatus(): boolean` / `isClosedStatus(): boolean`

State queries for the current connection status.

### `setOnData(callback)` / `setOnConnect(callback)` / `setOnClose(callback)`

Register callbacks for incoming data, successful connection, and transport close events. The `onClose` callback receives the WebSocket close code when available.

### `getStateLabel(): string`

Returns the current state as a string: `'idle'` | `'connected'` | `'reconnecting'` | `'closing'` | `'closed'`.

## Type Definitions

### `WebSocketTransportState`

```
'idle' | 'connected' | 'reconnecting' | 'closing' | 'closed'
```

The five lifecycle states of the transport. Transitions: `idle → reconnecting → connected → (reconnecting ↔ connected) → closing → closed`.

### `WebSocketTransportOptions`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autoReconnect` | `boolean` | `true` | Whether to attempt automatic reconnection on disconnect |
| `isBridge` | `boolean` | `false` | Enable `tengu_ws_transport_*` telemetry for REPL bridge sessions |

### `WebSocketLike`

A minimal interface shared between `globalThis.WebSocket` (Bun) and `ws.WebSocket` (Node), providing `close()`, `send(data)`, and optionally `ping()`.

## Configuration & Defaults

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_MAX_BUFFER_SIZE` | 1000 | Max messages in the circular replay buffer |
| `DEFAULT_BASE_RECONNECT_DELAY` | 1,000 ms | Initial reconnection backoff delay |
| `DEFAULT_MAX_RECONNECT_DELAY` | 30,000 ms | Cap on exponential backoff |
| `DEFAULT_RECONNECT_GIVE_UP_MS` | 600,000 ms (10 min) | Total reconnection time budget |
| `DEFAULT_PING_INTERVAL` | 10,000 ms | Interval between ping/pong health checks |
| `DEFAULT_KEEPALIVE_INTERVAL` | 300,000 ms (5 min) | Interval for keep-alive data frames |
| `SLEEP_DETECTION_THRESHOLD_MS` | 60,000 ms | Gap threshold to detect sleep/wake or process suspension |
| `PERMANENT_CLOSE_CODES` | `{1002, 4001, 4003}` | Close codes that abort reconnection immediately |

## Edge Cases & Caveats

- **Bun vs Node runtime split**: The transport detects `typeof Bun !== 'undefined'` at connect time and uses the appropriate WebSocket API. Bun's WebSocket lacks upgrade response headers, so all buffered messages are replayed (relying on server-side UUID deduplication). Node's `ws` package exposes the upgrade response for smarter partial replay.

- **Listener cleanup on reconnect**: Event listeners are explicitly removed from the old WebSocket before closing it (`removeWsListeners`, `src/cli/transports/WebSocketTransport.ts:360-378`). Without this, each reconnect would orphan the old WS object and its closures until GC — a memory leak under network instability.

- **4003 with token refresh**: A `4003` (unauthorized) close code is normally permanent, but if `refreshHeaders()` returns a different `Authorization` header, the transport retries. This supports scenarios where the parent process mints a fresh session ingress token during reconnection.

- **Sleep/wake detection in two places**: Sleep is detected both in `handleConnectionError()` (via gap between reconnect attempts) and in `startPingInterval()` (via gap between timer ticks). The first handles sleep during an ongoing reconnection storm; the second handles sleep while the connection appears healthy.

- **Messages without UUIDs are not buffered**: Only messages containing a `uuid` field are added to the replay buffer. Fire-and-forget messages (like `keep_alive`) are intentionally excluded.

- **Buffer not cleared after replay**: After replaying messages on reconnect, the buffer is intentionally not cleared (`src/cli/transports/WebSocketTransport.ts:631-633`). Messages stay buffered until the server confirms receipt on the *next* reconnection, preventing loss if the connection drops again mid-replay.

- **CCR environment skips keepalive**: When `CLAUDE_CODE_REMOTE` is truthy, the periodic keepalive interval is not started (`src/cli/transports/WebSocketTransport.ts:771-773`), since CCR sessions have their own heartbeat mechanism.

- **Telemetry gating**: Bridge-mode analytics events (`tengu_ws_transport_closed`, `_reconnecting`, `_reconnected`) only fire when `isBridge` is true, keeping print-mode workers silent. The `msSinceLastActivity` metric in `_closed` events is specifically designed to diagnose Cloudflare's 5-minute proxy idle timeout RSTs.