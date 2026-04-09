# StructuredIO Layer

## Overview & Responsibilities

The StructuredIO layer is the I/O abstraction for non-interactive (headless/SDK/bridge/remote) execution modes within the **CLIIOLayer** subsystem of the **Bootstrap** module. It provides the communication backbone that lets external SDK hosts (VS Code, claude.ai bridge, CCR workers) exchange messages with the Claude Code engine over NDJSON-framed streams.

Two classes form this layer:

- **`StructuredIO`** (`src/cli/structuredIO.ts`) — Base class implementing NDJSON stdin/stdout message framing, control request/response correlation, permission prompt orchestration, hook callbacks, elicitation, MCP message forwarding, and sandbox network access prompts.
- **`RemoteIO`** (`src/cli/remoteIO.ts`) — Subclass extending `StructuredIO` with WebSocket/SSE transport for bridge and remote sessions, CCR v2 client integration, keep-alive frames, and bidirectional message bridging.

**Sibling modules** in CLIIOLayer include `print.ts` (the `runHeadless` function that drives the query loop without a terminal UI, consuming `StructuredIO`'s `structuredInput` generator) and transport implementations (WebSocket, SSE, Hybrid, CCR client).

## Key Processes

### NDJSON Message Reading Flow

`StructuredIO` reads from an `AsyncIterable<string>` input stream, splitting it into newline-delimited JSON messages via the private `read()` async generator (`src/cli/structuredIO.ts:215-261`):

1. Accumulate text chunks from the input iterable
2. Split on newlines, parse each line as JSON via `jsonParse()` and normalize keys with `normalizeControlMessageKeys()`
3. Dispatch based on `message.type`:
   - **`keep_alive`** — silently dropped
   - **`update_environment_variables`** — applied to `process.env` (used for auth token refresh in bridge sessions)
   - **`control_response`** — correlated to a pending request and resolved (see below)
   - **`user` / `assistant` / `system` / `control_request`** — yielded to the consumer (`print.ts`)
   - Unknown types — logged and discarded
4. When the input stream closes, all pending requests are rejected with an error

The generator also supports **prepended messages** via `prependUserMessage()` (`src/cli/structuredIO.ts:204-213`), which queues synthetic user turns that are yielded before the next real input line.

### Control Request/Response Correlation

The `sendRequest<T>()` method (`src/cli/structuredIO.ts:469-531`) implements a request/response protocol over the NDJSON stream:

1. Build an `SDKControlRequest` with a unique `request_id` (UUID)
2. Enqueue it on the `outbound` Stream (shared with `print.ts` to preserve ordering with stream events)
3. Store a `PendingRequest` in the `pendingRequests` Map, keyed by `request_id`
4. When a `control_response` arrives in `processLine()`, look up the matching pending request and resolve/reject its Promise
5. If an `AbortSignal` fires, send a `control_cancel_request` and immediately reject

Duplicate/orphan responses are guarded by `resolvedToolUseIds` — a bounded Set (max 1000 entries, LRU eviction) that tracks tool_use IDs already resolved, preventing duplicate assistant messages that would cause API 400 errors (`src/cli/structuredIO.ts:130-187`).

### Permission Prompt Race (canUseTool)

`createCanUseTool()` (`src/cli/structuredIO.ts:533-659`) returns a `CanUseToolFn` callback that orchestrates tool permission decisions:

1. Check `hasPermissionsToUseTool()` for pre-existing allow/deny rules
2. If the result is "ask", race two parallel paths:
   - **SDK prompt**: Send a `can_use_tool` control_request to the SDK host (VS Code permission dialog, claude.ai prompt, etc.)
   - **Hook evaluation**: Run `executePermissionRequestHooks` in the background
3. `Promise.race()` determines the winner:
   - If a hook decides first → abort the SDK request via `AbortController`, return the hook's decision
   - If the hook passes (no decision) → await the SDK prompt result
   - If the SDK prompt responds first → use its result, ignore the hook
4. On error → deny with an error message
5. Session state transitions back to `'running'` when no more permission prompts are pending

### Bridge Integration Callbacks

For bridge mode (claude.ai remote control), `StructuredIO` exposes two callback hooks:

- **`setOnControlRequestSent()`** (`src/cli/structuredIO.ts:316-320`) — Fires when a `can_use_tool` control_request is written, allowing the bridge to forward it to claude.ai
- **`setOnControlRequestResolved()`** (`src/cli/structuredIO.ts:327-331`) — Fires when the SDK consumer resolves a request, allowing the bridge to cancel the stale prompt on claude.ai
- **`injectControlResponse()`** (`src/cli/structuredIO.ts:283-309`) — Lets the bridge inject a permission response (e.g., from claude.ai's UI), resolving the pending request and sending a `control_cancel_request` to the SDK consumer

### RemoteIO Transport and CCR v2

`RemoteIO` (`src/cli/remoteIO.ts:35-255`) extends `StructuredIO` by replacing stdin/stdout with a network transport:

1. **Constructor** creates a `PassThrough` stream as the input, selects a transport (WebSocket or SSE) via `getTransportForUrl()`, and wires `transport.setOnData()` to pipe incoming data into the PassThrough
2. **Authentication** — reads session ingress auth tokens and passes them as `Authorization: Bearer` headers; provides a `refreshHeaders` callback for token rotation on reconnect
3. **CCR v2 integration** (`src/cli/remoteIO.ts:116-168`) — When `CLAUDE_CODE_USE_CCR_V2` is enabled:
   - Creates a `CCRClient` bound to the `SSETransport` (asserts the transport type invariant)
   - `initialize()` restores worker state; failures trigger graceful shutdown
   - Registers internal event writer/reader for transcript persistence and session resume
   - Maps command lifecycle events (`started`→`processing`, `completed`→`processed`) to CCR delivery reports
   - Forwards session state changes and metadata updates to CCR
4. **Keep-alive** (`src/cli/remoteIO.ts:184-196`) — In bridge mode, sends periodic `keep_alive` frames at the interval from GrowthBook config (`session_keepalive_interval_v2_ms`, default 120s) to prevent upstream proxy idle timeouts
5. **`write()` override** (`src/cli/remoteIO.ts:231-242`) — Routes outbound messages through `ccrClient.writeEvent()` if CCR v2 is active, otherwise through the raw transport. In bridge mode, `control_request` messages are always echoed to stdout so the bridge parent can detect permission requests

## Function Signatures

### StructuredIO

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(input: AsyncIterable<string>, replayUserMessages?: boolean)` | Creates the IO layer from an async text stream |
| `prependUserMessage` | `(content: string): void` | Queues a synthetic user turn before the next real message |
| `createCanUseTool` | `(onPermissionPrompt?): CanUseToolFn` | Returns a permission callback that races SDK prompts against hooks |
| `createHookCallback` | `(callbackId: string, timeout?: number): HookCallback` | Creates a hook callback that forwards to the SDK host |
| `handleElicitation` | `(serverName, message, requestedSchema?, signal?, mode?, url?, elicitationId?): Promise<ElicitResult>` | Sends an elicitation request (form/URL) to the SDK consumer |
| `createSandboxAskCallback` | `(): (hostPattern) => Promise<boolean>` | Creates a callback for sandbox network access permission prompts |
| `sendMcpMessage` | `(serverName: string, message: JSONRPCMessage): Promise<JSONRPCMessage>` | Forwards an MCP JSON-RPC message to an SDK-hosted MCP server |
| `write` | `(message: StdoutMessage): Promise<void>` | Writes NDJSON to stdout (overridden by `RemoteIO`) |
| `injectControlResponse` | `(response: SDKControlResponse): void` | Resolves a pending request from an external source (bridge) |
| `getPendingPermissionRequests` | `(): SDKControlRequest[]` | Returns all pending `can_use_tool` requests |
| `flushInternalEvents` | `(): Promise<void>` | No-op in base; overridden by `RemoteIO` |

### RemoteIO

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(streamUrl: string, initialPrompt?: AsyncIterable<string>, replayUserMessages?: boolean)` | Connects to remote transport, initializes CCR v2 if enabled |
| `write` | `(message: StdoutMessage): Promise<void>` | Sends via CCR client or transport; echoes to stdout in bridge mode |
| `close` | `(): void` | Stops keep-alive timer, closes transport and input stream |
| `flushInternalEvents` | `(): Promise<void>` | Flushes CCR v2 internal event queue |

## Type Definitions

### `PendingRequest<T>` (`src/cli/structuredIO.ts:119-124`)

Internal type tracking an in-flight control request:

| Field | Type | Description |
|-------|------|-------------|
| `resolve` | `(result: T) => void` | Promise resolution callback |
| `reject` | `(error: unknown) => void` | Promise rejection callback |
| `schema` | `z.Schema` (optional) | Zod schema to validate the response payload |
| `request` | `SDKControlRequest` | The original request (used for bridge callbacks and dedup tracking) |

### `SANDBOX_NETWORK_ACCESS_TOOL_NAME` (`src/cli/structuredIO.ts:62`)

Exported constant `'SandboxNetworkAccess'` — a synthetic tool name used to piggyback sandbox network permission prompts on the existing `can_use_tool` protocol.

## Configuration & Defaults

| Config | Source | Default | Description |
|--------|--------|---------|-------------|
| `MAX_RESOLVED_TOOL_USE_IDS` | Constant | 1000 | Max tracked resolved tool_use IDs before LRU eviction |
| `session_keepalive_interval_v2_ms` | GrowthBook (`tengu_bridge_poll_interval_config`) | 120000 (120s) | Keep-alive frame interval for bridge sessions; 0 disables |
| `CLAUDE_CODE_USE_CCR_V2` | Environment variable | — | Enables CCR v2 client (SSE+POST transport, heartbeats, state reporting) |
| `CLAUDE_CODE_ENVIRONMENT_KIND` | Environment variable | — | Set to `'bridge'` to enable bridge-mode behaviors (stdout echo, keep-alive) |
| `CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION` | Environment variable | — | Sent as `x-environment-runner-version` header on remote connections |

## Edge Cases & Caveats

- **Duplicate control_response handling**: WebSocket reconnects can redeliver responses. The `resolvedToolUseIds` Set prevents duplicate assistant messages that would cause API 400 "tool_use ids must be unique" errors. The Set is bounded to 1000 entries with LRU eviction.

- **Input stream closure**: When the input closes, all pending requests are rejected immediately. The `inputClosed` flag prevents new `sendRequest()` calls from hanging indefinitely.

- **Abort propagation**: `sendRequest()` wires both a local `AbortController` (for hook-wins-the-race) and the parent tool context's abort signal. The abort handler sends `control_cancel_request` and immediately rejects — it does not wait for host acknowledgment.

- **CCR v2 transport invariant**: `RemoteIO` asserts that CCR v2 mode uses `SSETransport`. If `getTransportForUrl()` returns a different transport type under `CLAUDE_CODE_USE_CCR_V2`, it throws immediately rather than failing silently inside `CCRClient`.

- **CCR initialization failure**: If `CCRClient.initialize()` fails, `RemoteIO` triggers `gracefulShutdown(1, 'other')` — this is a fatal error, not a recoverable state.

- **Bridge stdout echo**: In bridge mode, only `control_request` messages are echoed to stdout (plus all messages in debug mode). This keeps the bridge parent informed of permission prompts without flooding it with stream events.

- **Keep-alive timer**: Uses `unref()` so the timer doesn't prevent Node.js process exit. Only active in bridge mode (`CLAUDE_CODE_ENVIRONMENT_KIND === 'bridge'`).

- **Hook callback errors**: `createHookCallback()` catches errors and returns `{}` rather than propagating — a failed hook callback should not crash the session.

- **Elicitation cancellation**: If the elicitation request fails or is aborted, `handleElicitation()` returns `{ action: 'cancel' }` as a safe default.