# Remote Session Management

## Overview & Responsibilities

The `src/remote/` module is the **client-side half** of Claude Code's remote execution architecture. It lives within the **RemoteAndBridge** group—alongside the Bridge (claude.ai WebSocket sessions), Server (direct-connect), and Coordinator (multi-agent)—and is specifically responsible for connecting a local CLI terminal to a **CCR (Claude Code Remote)** session running on Anthropic's infrastructure.

At a high level this module does four things:

1. **WebSocket transport** (`SessionsWebSocket`) — maintains a persistent connection to the CCR subscribe endpoint, with automatic reconnection, ping/pong keepalive, and permanent-close-code handling.
2. **Session orchestration** (`RemoteSessionManager`) — coordinates the WebSocket subscription with HTTP-based message sending and the permission request/response lifecycle.
3. **Permission bridging** (`remotePermissionBridge`) — translates remote `can_use_tool` permission requests into synthetic local objects so the terminal UI can show its normal approval dialogs.
4. **Message adaptation** (`sdkMessageAdapter`) — converts the CCR SDK message format into the internal REPL `Message` / `StreamEvent` types the terminal UI already knows how to render.

## Key Processes

### 1. Connecting to a Remote Session

```
RemoteSessionManager.connect()
  └─ creates SessionsWebSocket(sessionId, orgUuid, getAccessToken, callbacks)
       └─ SessionsWebSocket.connect()
            ├─ builds WSS URL: wss://<BASE_API_URL>/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...
            ├─ attaches Bearer token via headers (no separate auth message needed)
            ├─ Bun path: uses globalThis.WebSocket with proxy/TLS options
            └─ Node path: dynamically imports 'ws' package with agent/TLS options
```

Authentication is header-based — the access token is passed as an `Authorization: Bearer` header on the WebSocket handshake itself (`src/remote/SessionsWebSocket.ts:115-118`). On successful open, the state transitions to `connected`, reconnect counters reset, and the ping interval starts.

### 2. Reconnection Strategy

The WebSocket handles three categories of close events (`src/remote/SessionsWebSocket.ts:234-288`):

| Close code | Behavior | Rationale |
|------------|----------|-----------|
| **4003** (unauthorized) | Permanent close, no reconnect | Server definitively rejected the session |
| **4001** (session not found) | Up to 3 retries with linear backoff (`2s × attempt`) | Transient during compaction — the server may briefly consider the session stale |
| **Any other code** | Up to 5 reconnect attempts at 2s intervals | Standard transient failure recovery |

The `onReconnecting` callback fires on every transient close so the UI can display a reconnecting indicator. The `onClose` callback fires only when reconnection is permanently abandoned.

A manual `reconnect()` method (`src/remote/SessionsWebSocket.ts:393-403`) resets all counters and schedules a fresh connection after 500ms — used when the container shuts down and the subscription becomes stale.

### 3. Ping/Pong Keepalive

A 30-second ping interval starts on connection (`src/remote/SessionsWebSocket.ts:301-313`). The client calls `ws.ping()` (supported by both Bun's native WebSocket and the `ws` package). Ping errors are silently swallowed — the close handler deals with dead connections.

### 4. Message Routing

All incoming WebSocket messages flow through `RemoteSessionManager.handleMessage()` (`src/remote/RemoteSessionManager.ts:146-184`):

```
WebSocket message (JSON)
  │
  ├─ type === 'control_request'        → handleControlRequest()  → onPermissionRequest callback
  ├─ type === 'control_cancel_request' → delete pending request  → onPermissionCancelled callback
  ├─ type === 'control_response'       → logged, no action (acknowledgment)
  └─ isSDKMessage(msg)                 → onMessage callback (forwarded to sdkMessageAdapter)
```

Outbound messages use two different transports:
- **User messages** → HTTP POST via `sendEventToRemoteSession()` (`src/remote/RemoteSessionManager.ts:219-242`)
- **Control responses / requests** → WebSocket via `sendControlResponse()` / `sendControlRequest()` (`src/remote/SessionsWebSocket.ts:328-357`)

### 5. Permission Bridge Flow

When the remote CCR agent needs to use a tool that requires approval, the flow is:

1. CCR sends a `control_request` with `subtype: 'can_use_tool'` containing the tool name, input, and `tool_use_id`
2. `RemoteSessionManager` stores it in `pendingPermissionRequests` (keyed by `request_id`) and fires `onPermissionRequest`
3. The UI layer calls `createSyntheticAssistantMessage()` (`src/remote/remotePermissionBridge.ts:12-46`) to build a fake `AssistantMessage` with a `tool_use` content block — needed because the local permission dialog expects an `AssistantMessage` context
4. If the tool isn't loaded locally (e.g., an MCP tool only available on the CCR container), `createToolStub()` (`src/remote/remotePermissionBridge.ts:53-78`) creates a minimal `Tool` object that routes to the fallback permission UI
5. The user approves or denies; `respondToPermissionRequest()` sends a `control_response` back over the WebSocket
6. If the server cancels a pending request (e.g., timeout), a `control_cancel_request` arrives and the pending entry is cleaned up

### 6. SDK Message Adaptation

`convertSDKMessage()` (`src/remote/sdkMessageAdapter.ts:168-278`) maps each SDK message type to the internal REPL format:

| SDK Message Type | Converted To | Notes |
|-----------------|--------------|-------|
| `assistant` | `AssistantMessage` | Direct mapping with timestamp |
| `stream_event` | `StreamEvent` | Wraps the streaming event object |
| `user` (tool_result) | `UserMessage` | Only when `convertToolResults` option is set (direct-connect mode) |
| `user` (text) | `UserMessage` | Only when `convertUserTextMessages` is set (historical replay) |
| `result` (error) | `SystemMessage` (warning) | Success results are ignored — `isLoading=false` is sufficient signal |
| `system` (init) | `SystemMessage` | Shows model name |
| `system` (status) | `SystemMessage` | Special-cases "compacting" status |
| `system` (compact_boundary) | `SystemMessage` | Carries compaction metadata |
| `tool_progress` | `SystemMessage` | Shows tool name and elapsed seconds |
| `auth_status`, `tool_use_summary`, `rate_limit_event` | Ignored | SDK-only events not displayed in REPL |
| Unknown types | Ignored | Gracefully logged for debugging |

## Function Signatures

### RemoteSessionManager

```typescript
class RemoteSessionManager {
  constructor(config: RemoteSessionConfig, callbacks: RemoteSessionCallbacks)
  connect(): void
  sendMessage(content: RemoteMessageContent, opts?: { uuid?: string }): Promise<boolean>
  respondToPermissionRequest(requestId: string, result: RemotePermissionResponse): void
  cancelSession(): void
  isConnected(): boolean
  getSessionId(): string
  disconnect(): void
  reconnect(): void
}
```

> Source: `src/remote/RemoteSessionManager.ts:95-324`

### SessionsWebSocket

```typescript
class SessionsWebSocket {
  constructor(sessionId: string, orgUuid: string, getAccessToken: () => string, callbacks: SessionsWebSocketCallbacks)
  connect(): Promise<void>
  sendControlResponse(response: SDKControlResponse): void
  sendControlRequest(request: SDKControlRequestInner): void
  isConnected(): boolean
  close(): void
  reconnect(): void
}
```

> Source: `src/remote/SessionsWebSocket.ts:82-404`

### sdkMessageAdapter

```typescript
function convertSDKMessage(msg: SDKMessage, opts?: ConvertOptions): ConvertedMessage
function isSessionEndMessage(msg: SDKMessage): boolean
function isSuccessResult(msg: SDKResultMessage): boolean
function getResultText(msg: SDKResultMessage): string | null
```

> Source: `src/remote/sdkMessageAdapter.ts:168-303`

### remotePermissionBridge

```typescript
function createSyntheticAssistantMessage(request: SDKControlPermissionRequest, requestId: string): AssistantMessage
function createToolStub(toolName: string): Tool
```

> Source: `src/remote/remotePermissionBridge.ts:12-78`

## Type Definitions

### RemoteSessionConfig

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | The CCR session identifier |
| `getAccessToken` | `() => string` | Lazy accessor for a fresh OAuth token |
| `orgUuid` | `string` | Organization UUID for the API |
| `hasInitialPrompt` | `boolean?` | True if session was created with an initial prompt already being processed |
| `viewerOnly` | `boolean?` | When true, Ctrl+C/Escape don't send interrupts, reconnect timeout is disabled, title is never updated. Used by `claude assistant` |

> Source: `src/remote/RemoteSessionManager.ts:50-62`

### RemotePermissionResponse

A discriminated union for permission outcomes:

```typescript
type RemotePermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
```

> Source: `src/remote/RemoteSessionManager.ts:40-48`

### ConvertedMessage

```typescript
type ConvertedMessage =
  | { type: 'message'; message: Message }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'ignored' }
```

> Source: `src/remote/sdkMessageAdapter.ts:145-148`

### ConvertOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `convertToolResults` | `boolean?` | `false` | Convert user messages with `tool_result` blocks into `UserMessage`. Used in direct-connect mode |
| `convertUserTextMessages` | `boolean?` | `false` | Convert user text messages for historical replay. Ignored in live WS mode since the REPL adds them locally |

> Source: `src/remote/sdkMessageAdapter.ts:150-163`

## Configuration & Defaults

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `RECONNECT_DELAY_MS` | 2000 | `SessionsWebSocket.ts:17` | Base delay between reconnect attempts |
| `MAX_RECONNECT_ATTEMPTS` | 5 | `SessionsWebSocket.ts:18` | Max reconnection attempts for generic closes |
| `PING_INTERVAL_MS` | 30000 | `SessionsWebSocket.ts:19` | Interval for WebSocket ping keepalive |
| `MAX_SESSION_NOT_FOUND_RETRIES` | 3 | `SessionsWebSocket.ts:26` | Retry budget for 4001 (session not found) closes |
| `PERMANENT_CLOSE_CODES` | `{4003}` | `SessionsWebSocket.ts:34` | Close codes that immediately stop reconnection |

The WebSocket URL is derived from the OAuth config's `BASE_API_URL` with the scheme changed from `https://` to `wss://`.

## Edge Cases & Caveats

- **Bun vs Node WebSocket**: `SessionsWebSocket.connect()` has two completely separate code paths — one for Bun's native `globalThis.WebSocket` and one that dynamically imports the `ws` package for Node.js (`src/remote/SessionsWebSocket.ts:120-204`). Both support `ping()` but attach event listeners differently (`.addEventListener` vs `.on`).

- **4001 during compaction**: The server may briefly report a session as "not found" while compaction is in progress. The client retries up to 3 times with increasing delays before giving up (`src/remote/SessionsWebSocket.ts:258-272`).

- **Unknown message types are not dropped at the WebSocket layer**: `isSessionsMessage()` accepts any object with a string `type` field (`src/remote/SessionsWebSocket.ts:46-55`). This prevents silently dropping new message types the backend starts sending before the client is updated. Unknown types are gracefully ignored downstream.

- **Tool stubs for unknown remote tools**: When CCR asks for permission on a tool that doesn't exist locally (e.g., an MCP tool), `createToolStub()` creates a minimal `Tool` object with `needsPermissions: () => true` so it routes to the fallback permission dialog rather than crashing.

- **Synthetic assistant messages**: The permission dialog requires an `AssistantMessage` context, but in remote mode there is no real local assistant message. `createSyntheticAssistantMessage()` fabricates one with zero token usage and a `remote-{requestId}` message ID.

- **Success results are suppressed**: `convertSDKMessage` intentionally returns `{ type: 'ignored' }` for successful `result` messages — the `isLoading=false` state change is considered sufficient signal without adding a noisy system message.

- **User messages are ignored by default**: In live WebSocket mode, user text messages from the SDK stream are ignored because the REPL already adds them locally when the user types. The `convertUserTextMessages` and `convertToolResults` options exist for direct-connect mode and historical replay scenarios.