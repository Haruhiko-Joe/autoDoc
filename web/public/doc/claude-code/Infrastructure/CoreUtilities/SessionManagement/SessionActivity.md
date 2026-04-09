# SessionActivity

## Overview & Responsibilities

SessionActivity is a refcount-based activity tracker that keeps remote containers alive by sending periodic heartbeat signals during active work. It sits within the **Infrastructure > CoreUtilities > SessionManagement** layer and is used by the query engine and tool system to bracket active work periods (API streaming, tool execution).

The core problem it solves: remote containers may be torn down during idle periods. When Claude Code is actively streaming a response or executing a tool, this module ensures a keep-alive callback fires every 30 seconds so the remote environment stays running. When all work completes, it switches to idle monitoring and logs a diagnostic event if the session stays idle for 30+ seconds.

## Key Processes

### Activity Lifecycle (Start → Heartbeat → Stop → Idle)

1. A caller invokes `startSessionActivity('api_call')` or `startSessionActivity('tool_exec')`, incrementing the refcount (`src/utils/sessionActivity.ts:92-100`)
2. On the **0→1 transition**, the module records `oldestActivityStartedAt` and starts a 30-second periodic heartbeat timer
3. Each heartbeat tick logs a `session_keepalive_heartbeat` diagnostic event, and — if `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES` is truthy — fires the registered callback (`src/utils/sessionActivity.ts:32-39`)
4. When work finishes, `stopSessionActivity(reason)` decrements the refcount (`src/utils/sessionActivity.ts:121-133`)
5. On the **1→0 transition**, the heartbeat timer is cleared and an idle timer starts. If no new activity begins within 30 seconds, a `session_idle_30s` diagnostic event is logged

### Callback Registration (Transport Layer)

1. The transport layer (e.g., remote WebSocket connection) registers its keep-alive sender via `registerSessionActivityCallback(cb)` (`src/utils/sessionActivity.ts:60-66`)
2. If work is already in progress when the callback is registered (e.g., reconnect during streaming), the heartbeat timer starts immediately
3. On disconnect, `unregisterSessionActivityCallback()` tears down both the heartbeat and idle timers (`src/utils/sessionActivity.ts:68-76`)

### Shutdown Diagnostics

On first `startSessionActivity` call, a cleanup handler is registered via `registerCleanup()` that logs the final refcount, active reason breakdown, and duration of the oldest in-flight activity (`src/utils/sessionActivity.ts:101-114`).

## Function Signatures

### `registerSessionActivityCallback(cb: () => void): void`

Registers the keep-alive callback that the heartbeat timer will invoke. Typically called by the remote transport layer. If activity is already in progress (refcount > 0), immediately starts the heartbeat timer.

### `unregisterSessionActivityCallback(): void`

Removes the callback and stops all timers (heartbeat and idle). Called on transport disconnect.

### `startSessionActivity(reason: SessionActivityReason): void`

Increments the activity refcount for the given reason. On 0→1 transition, starts the heartbeat timer if a callback is registered.

- **reason**: `'api_call'` or `'tool_exec'`

### `stopSessionActivity(reason: SessionActivityReason): void`

Decrements the activity refcount for the given reason. On 1→0 transition, stops the heartbeat and starts the idle timer.

- **reason**: `'api_call'` or `'tool_exec'`

### `sendSessionActivitySignal(): void`

Fires the registered callback immediately (one-shot), gated behind `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES`. Useful for sending a keep-alive outside of the periodic timer cycle.

### `isSessionActivityTrackingActive(): boolean`

Returns `true` if a callback is currently registered, indicating the transport layer is connected and tracking is active.

## Type Definitions

### `SessionActivityReason`

```typescript
type SessionActivityReason = 'api_call' | 'tool_exec'
```

Identifies why activity is occurring. Used both for refcount tracking and for the per-reason breakdown in shutdown diagnostics.

## Internal State

| Variable | Type | Purpose |
|----------|------|---------|
| `refcount` | `number` | Total number of active work units across all reasons |
| `activeReasons` | `Map<SessionActivityReason, number>` | Per-reason refcount for diagnostic breakdown |
| `oldestActivityStartedAt` | `number \| null` | Timestamp of the 0→1 transition, used to compute duration at shutdown |
| `heartbeatTimer` | `interval \| null` | The 30-second periodic timer that fires the keep-alive callback |
| `idleTimer` | `timeout \| null` | One-shot 30-second timer that logs an idle diagnostic event |
| `activityCallback` | `(() => void) \| null` | The registered keep-alive function from the transport layer |

## Configuration

- **`CLAUDE_CODE_REMOTE_SEND_KEEPALIVES`**: Environment variable (checked via `isEnvTruthy`). When truthy, the heartbeat timer actually invokes the registered callback. When falsy, diagnostic logging still fires but no keep-alive signal is sent. This gates the feature for remote container environments only.
- **`SESSION_ACTIVITY_INTERVAL_MS`**: Hardcoded constant at `30_000` (30 seconds). Controls both the heartbeat interval and the idle detection threshold.

## Edge Cases & Caveats

- **Refcount never goes negative**: `stopSessionActivity` guards against decrementing below zero (`src/utils/sessionActivity.ts:122-124`). Mismatched start/stop calls won't corrupt state.
- **Reconnect during streaming**: If `registerSessionActivityCallback` is called while `refcount > 0` (e.g., transport reconnects mid-stream), the heartbeat timer starts immediately rather than waiting for a new start/stop cycle (`src/utils/sessionActivity.ts:63-65`).
- **Callback removed mid-activity**: `unregisterSessionActivityCallback` stops all timers even if the refcount is non-zero. The refcount remains elevated, so a subsequent `registerSessionActivityCallback` will restart the heartbeat.
- **No callback registered**: If `startSessionActivity` is called before any callback is registered, the refcount increments but no heartbeat timer starts. The timer will start when a callback is later registered.
- **Idle timer only fires with a callback**: `startIdleTimer` exits early if `activityCallback` is null (`src/utils/sessionActivity.ts:44-46`), so idle logging only occurs in remote-capable sessions.
- **Cleanup is registered once**: The `registerCleanup` call is guarded by `cleanupRegistered` to avoid duplicate shutdown handlers.