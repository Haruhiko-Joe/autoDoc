# DirectConnect

## Overview & Responsibilities

The DirectConnect module provides an alternative session transport for Claude Code, allowing the CLI to connect to a **locally-hosted or custom server endpoint** instead of Anthropic's cloud infrastructure. It sits within the **RemoteAndBridge** family alongside the Bridge (claude.ai WebSocket) and Remote (remote agent) subsystems, but targets a simpler topology: a single HTTP + WebSocket connection to a user-controlled server.

The module handles three concerns:

1. **Session creation** — an HTTP POST handshake that provisions a session and returns WebSocket coordinates.
2. **Bidirectional communication** — a WebSocket channel that multiplexes SDK messages (assistant turns, tool results) and control messages (permission requests/responses, interrupts).
3. **UI integration** — a React hook (`useDirectConnect`) that bridges the `DirectConnectSessionManager` into the REPL's message and permission queues.

### Position in the architecture

DirectConnect is one of three remote transports available to the REPL screen. When the user launches Claude Code with a `cc://` URL or the `connect` subcommand, `main.tsx` calls `createDirectConnectSession()` to establish the session, then passes the resulting `DirectConnectConfig` into the REPL, which activates the `useDirectConnect` hook instead of the local query engine.

Sibling transports (Bridge for claude.ai, Remote for remote agents) follow a similar pattern but use different protocols and authentication mechanisms.

---

## Key Processes

### Session Creation Flow

1. The CLI parses a server URL (and optional auth token) from the user's `cc://` URL or CLI arguments.
2. `createDirectConnectSession()` sends an **HTTP POST** to `${serverUrl}/sessions` with a JSON body containing `cwd` and optionally `dangerously_skip_permissions: true` (`src/server/createDirectConnectSession.ts:48-58`).
3. If an `authToken` is provided, it is sent as a `Bearer` token in the `Authorization` header.
4. The response is validated against `connectResponseSchema` (Zod), which expects `session_id`, `ws_url`, and an optional `work_dir` (`src/server/types.ts:5-11`).
5. On success, a `DirectConnectConfig` object is returned containing the `serverUrl`, `sessionId`, `wsUrl`, and `authToken`, ready for the session manager.

Any failure — network error, non-2xx status, or schema mismatch — throws a `DirectConnectError` with a descriptive message.

### WebSocket Connection & Message Routing

Once the REPL receives a `DirectConnectConfig`, it instantiates `DirectConnectSessionManager` and calls `connect()`:

1. A WebSocket is opened to `config.wsUrl`, with the auth token passed as a header (`src/server/directConnectManager.ts:50-58`).
2. Incoming messages are newline-delimited JSON. Each line is parsed and classified:

   | Message type | Handling |
   |---|---|
   | `control_request` (subtype `can_use_tool`) | Routed to `onPermissionRequest` callback |
   | `control_request` (unknown subtype) | Auto-replied with an error response to prevent server hangs |
   | `control_response`, `keep_alive`, `control_cancel_request`, `streamlined_text`, `streamlined_tool_use_summary`, `system/post_turn_summary` | **Filtered out** — not forwarded to the UI |
   | Everything else (assistant turns, tool results, system init, etc.) | Forwarded to `onMessage` as `SDKMessage` |

3. `close` and `error` WebSocket events trigger the `onDisconnected` / `onError` callbacks respectively.

> Source: `src/server/directConnectManager.ts:64-113`

### Sending User Messages

`sendMessage()` wraps user content in the `SDKUserMessage` envelope expected by the server's `--input-format stream-json` mode:

```ts
{
  type: 'user',
  message: { role: 'user', content },
  parent_tool_use_id: null,
  session_id: '',
}
```

> Source: `src/server/directConnectManager.ts:125-142`

### Permission Request / Response Cycle

When the server needs tool-use approval, it sends a `control_request` with subtype `can_use_tool`. The flow is:

1. `DirectConnectSessionManager` invokes `onPermissionRequest(request, requestId)`.
2. The `useDirectConnect` hook creates a synthetic assistant message and a `ToolUseConfirm` entry, pushing it into the REPL's permission queue (`src/hooks/useDirectConnect.ts:87-158`).
3. The user sees the standard permission dialog. Their decision (allow / deny / abort) calls back into `manager.respondToPermissionRequest()`.
4. The manager sends a `control_response` with subtype `success`, carrying either `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }` (`src/server/directConnectManager.ts:144-167`).

### Interrupt

`sendInterrupt()` sends a `control_request` with subtype `interrupt` and a random UUID as the request ID, signaling the server to cancel the in-progress turn (`src/server/directConnectManager.ts:172-186`).

### Disconnection Handling

On WebSocket close, the `useDirectConnect` hook distinguishes two cases (`src/hooks/useDirectConnect.ts:165-178`):

- **Never connected** (auth rejected, bad URL): prints `Failed to connect to server at <url>` and initiates graceful shutdown with exit code 1.
- **Was connected then lost** (server exited, network drop): prints `Server disconnected.` and shuts down.

In both cases the process exits — there is no automatic reconnection.

---

## Function Signatures

### `createDirectConnectSession(options): Promise<{ config, workDir? }>`

Creates a new session on a direct-connect server.

| Parameter | Type | Description |
|---|---|---|
| `serverUrl` | `string` | Base URL of the server (e.g. `http://localhost:3000`) |
| `authToken` | `string?` | Optional Bearer token for authentication |
| `cwd` | `string` | Working directory to pass to the server |
| `dangerouslySkipPermissions` | `boolean?` | If true, tells the server to skip permission checks |

**Returns** `{ config: DirectConnectConfig, workDir?: string }`

**Throws** `DirectConnectError` on network, HTTP, or schema-validation failures.

> Source: `src/server/createDirectConnectSession.ts:26-88`

### `DirectConnectSessionManager`

Class managing the WebSocket lifecycle.

| Method | Signature | Description |
|---|---|---|
| `connect()` | `(): void` | Opens the WebSocket and wires event listeners |
| `sendMessage(content)` | `(content: RemoteMessageContent): boolean` | Sends a user message; returns `false` if not connected |
| `respondToPermissionRequest(requestId, result)` | `(requestId: string, result: RemotePermissionResponse): void` | Sends allow/deny response for a permission request |
| `sendInterrupt()` | `(): void` | Sends an interrupt control request |
| `disconnect()` | `(): void` | Closes the WebSocket |
| `isConnected()` | `(): boolean` | Returns `true` if the WebSocket is in the `OPEN` state |

> Source: `src/server/directConnectManager.ts:40-213`

---

## Interface & Type Definitions

### `DirectConnectConfig`

Configuration returned by session creation, consumed by the session manager.

| Field | Type | Description |
|---|---|---|
| `serverUrl` | `string` | Base URL of the server |
| `sessionId` | `string` | Server-assigned session identifier |
| `wsUrl` | `string` | WebSocket URL to connect to |
| `authToken` | `string?` | Bearer token for authenticating the WebSocket |

> Source: `src/server/directConnectManager.ts:13-18`

### `DirectConnectCallbacks`

Callback interface passed to the session manager constructor.

| Callback | Signature | Description |
|---|---|---|
| `onMessage` | `(message: SDKMessage) => void` | Receives forwarded SDK messages |
| `onPermissionRequest` | `(request: SDKControlPermissionRequest, requestId: string) => void` | Fires when a tool needs user approval |
| `onConnected` | `() => void` | WebSocket opened |
| `onDisconnected` | `() => void` | WebSocket closed |
| `onError` | `(error: Error) => void` | WebSocket error |

> Source: `src/server/directConnectManager.ts:20-29`

### `ServerConfig`

Configuration for the server-side process (not used by the client directly, but defines the server's expected parameters).

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | — | Listening port |
| `host` | `string` | — | Bind address |
| `authToken` | `string` | — | Expected auth token |
| `unix` | `string?` | — | Optional Unix socket path |
| `idleTimeoutMs` | `number?` | — | Idle timeout for detached sessions (0 = never) |
| `maxSessions` | `number?` | — | Max concurrent sessions |
| `workspace` | `string?` | — | Default workspace directory |

> Source: `src/server/types.ts:13-24`

### `SessionState`, `SessionInfo`, `SessionIndexEntry`

Server-side types for session lifecycle tracking:

- **`SessionState`**: `'starting' | 'running' | 'detached' | 'stopping' | 'stopped'` — lifecycle states of a server-managed session.
- **`SessionInfo`**: Runtime metadata including the `ChildProcess` handle and creation timestamp.
- **`SessionIndexEntry`**: Persisted to `~/.claude/server-sessions.json` so sessions can be resumed across server restarts. Tracks the transcript session ID, working directory, permission mode, and activity timestamps.

> Source: `src/server/types.ts:26-57`

---

## Edge Cases & Caveats

- **No automatic reconnection**: When the WebSocket closes, the CLI exits immediately. There is no retry or reconnect logic — this is a deliberate design choice since the server process may have terminated.
- **Duplicate init suppression**: The server sends a `system/init` message at the start of every turn. The `useDirectConnect` hook drops all but the first to avoid duplicate "session started" messages in the UI (`src/hooks/useDirectConnect.ts:73-78`).
- **Unrecognized control request subtypes**: The manager auto-replies with an error response rather than silently ignoring, preventing the server from hanging indefinitely waiting for a reply (`src/server/directConnectManager.ts:88-98`).
- **Feature-gated**: Direct connect is behind the `DIRECT_CONNECT` feature flag. The entry point in `main.tsx` checks `feature('DIRECT_CONNECT')` before attempting connection.
- **Bun WebSocket header workaround**: The WebSocket constructor casts the `{ headers }` options object through `unknown` to work around DOM typings that don't include Bun's header support (`src/server/directConnectManager.ts:56-58`).