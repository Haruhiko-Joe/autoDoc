# ReplBridge

## Overview & Responsibilities

ReplBridge is the REPL-embedded single-session bridge that connects a local Claude Code CLI process to claude.ai for remote control. It sits within the **RemoteAndBridge → Bridge** subsystem and is the primary mechanism by which a user's terminal REPL session becomes controllable from claude.ai's web/mobile interface.

The module implements the full bridge lifecycle through four files:

- **`replBridge.ts`** (~2400 lines) — The bootstrap-free core: environment registration, session creation, work-dispatch poll loop, transport management (v1 WebSocket / v2 SSE+CCR), message ingress/egress with echo deduplication, reconnection with backoff, and teardown orchestration.
- **`initReplBridge.ts`** (~570 lines) — The REPL-specific wrapper that handles OAuth validation, feature gates, policy checks, git context gathering, session title derivation, and the env-less vs. env-based path decision before delegating to the core.
- **`replBridgeTransport.ts`** (~370 lines) — Transport abstraction layer that unifies v1 (HybridTransport: WebSocket reads + HTTP POST writes) and v2 (SSETransport reads + CCRClient writes) behind a single `ReplBridgeTransport` interface.
- **`replBridgeHandle.ts`** (~36 lines) — A global singleton pointer to the active bridge handle, enabling tools and slash commands outside the React tree to access bridge methods.

Sibling modules in the Bridge subsystem include the env-less bridge (`remoteBridgeCore.ts`) and the standalone bridge (`bridgeMain.ts`). The Remote, DirectConnect, and Coordinator modules handle other connectivity patterns.

## Key Processes

### 1. Initialization Flow (`initReplBridge`)

The entry point is `initReplBridge()`, called by `useReplBridge` (React hook, auto-start) or `print.ts` (SDK `-p` mode). It runs a strict sequence of gates before any network call:

1. **Runtime gate** — `isBridgeEnabledBlocking()` checks GrowthBook feature flags (`src/bridge/initReplBridge.ts:135`)
2. **OAuth check** — Verifies claude.ai OAuth tokens exist; returns `null` with `onStateChange('failed', '/login')` if missing (`src/bridge/initReplBridge.ts:147-151`)
3. **Policy check** — Waits for policy limits to load, then checks `allow_remote_control` (`src/bridge/initReplBridge.ts:154-162`)
4. **Token freshness** — Proactively refreshes expired OAuth tokens; implements cross-process backoff for dead tokens (3 failures per `expiresAt` value) to prevent fleet-wide 401 storms (`src/bridge/initReplBridge.ts:168-241`)
5. **Org UUID resolution** — Required by both v1 (environment registration) and v2 (archive endpoint) (`src/bridge/initReplBridge.ts:390-395`)

After gates pass, a **path decision** is made:

- **Env-less path** (`isEnvLessBridgeEnabled() && !perpetual`): Delegates to `initEnvLessBridgeCore` from `remoteBridgeCore.ts` — skips the Environments API entirely, connecting via `POST /bridge` (`src/bridge/initReplBridge.ts:410-452`)
- **Env-based path** (default): Gathers git context (branch, remote URL), determines worker type, and delegates to `initBridgeCore` (`src/bridge/initReplBridge.ts:454-544`)

### 2. Environment Registration & Session Creation (`initBridgeCore`)

`initBridgeCore()` receives all context as explicit parameters (no bootstrap state reads), making it reusable by both the REPL wrapper and daemon callers.

1. **Bridge API client creation** — Creates the API client with OAuth, version header, and trusted-device token (`src/bridge/replBridge.ts:319-330`)
2. **Environment registration** — `api.registerBridgeEnvironment(bridgeConfig)` with a random `bridgeId` and `environmentId`. If `perpetual` mode has a prior pointer, `reuseEnvironmentId` is set to attempt env resurrection (`src/bridge/replBridge.ts:349-367`)
3. **Perpetual reconnection** — If reusing a prior environment, calls `tryReconnectInPlace()` which invokes `api.reconnectSession()` to re-queue the existing session without creating a new one (`src/bridge/replBridge.ts:381-429`)
4. **Session creation** — `createSession()` (injected callback) creates a session on the bridge with the environment ID and title. Initial messages are NOT included as creation events — they're flushed later via the transport (`src/bridge/replBridge.ts:456-477`)
5. **Crash-recovery pointer** — Writes `bridgePointer` to disk so a kill -9 at any point leaves a recoverable trail (`src/bridge/replBridge.ts:484-488`)

### 3. Work Poll Loop (`startWorkPollLoop`)

The poll loop is the heartbeat of the bridge, running for the entire bridge lifetime (`src/bridge/replBridge.ts:1851-2398`):

```
┌──────────────────────────────────────────────────┐
│                    Poll Loop                      │
│                                                   │
│  ┌─► pollForWork() ──► work? ──yes──► decode      │
│  │       │                            secret      │
│  │      no                            │           │
│  │       │                     acknowledgeWork()  │
│  │   at capacity? ──yes──► heartbeat loop         │
│  │       │                  (non_exclusive_hb)    │
│  │      no                            │           │
│  │       │                     onWorkReceived()   │
│  │   sleep(poll_interval)      (connect transport)│
│  │       │                            │           │
│  └───────┘                            │           │
│                                       └───────────┘
└──────────────────────────────────────────────────┘
```

**States:**
- **Not at capacity** (no transport): Fast-polls at `poll_interval_ms_not_at_capacity`
- **At capacity** (transport connected): Enters heartbeat mode with `non_exclusive_heartbeat_interval_ms`, periodically calling `api.heartbeatWork()` to keep the work lease alive (300s TTL). Breaks out to poll at `poll_interval_ms_at_capacity` intervals.

**Error recovery:**
- **Transient errors**: Exponential backoff 2s → 60s cap, gives up after 15 minutes (`src/bridge/replBridge.ts:244-246`)
- **Environment lost (404)**: Calls `onEnvironmentLost` → `reconnectEnvironmentWithSession()` which tries two strategies (see Reconnection below)
- **Fatal errors (401/403/410)**: Triggers teardown immediately
- **Process suspension detection**: If sleep overruns by >60s, forces one fast-poll cycle to recover (`src/bridge/replBridge.ts:2121-2130`)

### 4. Transport Connection (`onWorkReceived`)

When work arrives, `onWorkReceived` (`src/bridge/replBridge.ts:1077-1501`) connects the ingress transport:

1. **Session ID validation** — Rejects foreign session IDs using UUID comparison (ignores `session_*` vs `cse_*` tag differences) (`src/bridge/replBridge.ts:1120-1125`)
2. **v1/v2 decision** — Server-driven via `secret.use_code_sessions`, with `CLAUDE_BRIDGE_USE_CCR_V2` as an ant-dev override (`src/bridge/replBridge.ts:1139-1140`)
3. **Auth divergence**:
   - **v1**: Uses OAuth tokens (standard refresh flow handles expiry)
   - **v2**: Uses JWT from the work secret (`session_id` claim required by `register_worker.go:32`)
4. **Transport construction** — Calls `createV1ReplTransport` or `createV2ReplTransport`, then `wireTransport()` which:
   - Sets `onConnect`: triggers initial message flush, then signals `'connected'` state
   - Sets `onData`: delegates to `handleIngressMessage()` for echo filtering and message routing
   - Sets `onClose`: runs `handleTransportPermanentClose()` for reconnection
   - Starts the flush gate if initial messages exist
   - Calls `transport.connect()`

### 5. Message Flow

**Outbound (REPL → server):**
- `writeMessages(messages)` — Filters eligible messages, deduplicates against `initialMessageUUIDs` + `recentPostedUUIDs` (bounded ring buffer, capacity 2000), converts to SDK format, and sends via `transport.writeBatch()` (`src/bridge/replBridge.ts:1694-1756`)
- `writeSdkMessages(messages)` — Daemon path: skips conversion, same dedup (`src/bridge/replBridge.ts:1757-1778`)
- During initial flush, messages are queued in `FlushGate` and drained after history completes (`src/bridge/replBridge.ts:1722-1728`)

**Inbound (server → REPL):**
- Transport's `onData` callback passes raw data to `handleIngressMessage()` which checks `recentPostedUUIDs` (echo filter) and `recentInboundUUIDs` (dedup), then dispatches to `onInboundMessage`, `onPermissionResponse`, or `onServerControlRequest` callbacks

**Control messages:**
- `sendControlRequest/Response/CancelRequest` — Forward SDK control protocol messages to the server
- `sendResult()` — Sends a result message signaling session completion

### 6. Reconnection Strategies (`doReconnect`)

When the environment is lost (poll returns 404, or transport permanently closes), `reconnectEnvironmentWithSession()` (`src/bridge/replBridge.ts:605-836`) tries two strategies:

**Strategy 1 — Reconnect in place:** Re-register with `reuseEnvironmentId` set to the current env ID. If the backend returns the same ID, call `reconnectSession()` to re-queue the existing session. The session URL on mobile/web stays valid; `previouslyFlushedUUIDs` are preserved.

**Strategy 2 — Fresh session:** If the backend returns a different env ID (original TTL-expired, e.g., laptop slept >4h) or `reconnectSession()` fails, archive the old session and create a new one on the now-registered environment. Resets SSE sequence numbers, inbound UUID dedup, and title derivation state.

Both strategies use a reentrancy guard (`reconnectPromise`) so concurrent callers share the same attempt. Limited to `MAX_ENVIRONMENT_RECREATIONS = 3` before giving up.

### 7. Teardown

The teardown sequence (`src/bridge/replBridge.ts:1553-1668`) is shared between explicit `teardown()` and cleanup registration:

1. Clears timers (pointer refresh, keep-alive, SIGUSR2 handler)
2. Aborts the poll loop
3. Captures final SSE sequence number from live transport
4. **Perpetual mode**: Local-only cleanup — leaves session alive on server, refreshes pointer mtime
5. **Normal mode**: Sends result message → `stopWork` + `archiveSession` in parallel → closes transport → deregisters environment → clears crash-recovery pointer

## Function Signatures

### `initReplBridge(options?: InitBridgeOptions): Promise<ReplBridgeHandle | null>`

REPL-specific entry point. Returns `null` if any gate fails (not enabled, no OAuth, policy denied, version too old).

Key options (`src/bridge/initReplBridge.ts:75-108`):
- `onInboundMessage` — Callback for incoming SDK messages from claude.ai
- `onPermissionResponse` — Callback for permission grant/deny responses
- `onInterrupt` — Callback when remote user sends an interrupt
- `onSetModel / onSetMaxThinkingTokens / onSetPermissionMode` — Remote configuration callbacks
- `onStateChange` — Bridge state transitions: `'ready'` | `'connected'` | `'reconnecting'` | `'failed'`
- `initialMessages` — Conversation history to flush on first connect
- `perpetual` — Keeps session alive across process restarts (daemon/assistant mode)
- `outboundOnly` — Mirror mode: forwards events but receives no inbound control

### `initBridgeCore(params: BridgeCoreParams): Promise<BridgeCoreHandle | null>`

Bootstrap-free core. All context passed explicitly. Returns `null` on registration or session-creation failure.

> Source: `src/bridge/replBridge.ts:260-262`

### `ReplBridgeHandle` (type)

```typescript
type ReplBridgeHandle = {
  bridgeSessionId: string            // Current session ID (mutable on reconnect)
  environmentId: string              // Registered environment ID
  sessionIngressUrl: string          // Base URL for session ingress
  writeMessages(messages: Message[]): void
  writeSdkMessages(messages: SDKMessage[]): void
  sendControlRequest(request: SDKControlRequest): void
  sendControlResponse(response: SDKControlResponse): void
  sendControlCancelRequest(requestId: string): void
  sendResult(): void
  teardown(): Promise<void>
}
```

> Source: `src/bridge/replBridge.ts:70-81`

### `ReplBridgeTransport` (type)

Transport abstraction with unified interface for v1/v2 (`src/bridge/replBridgeTransport.ts:23-70`):
- `write(message) / writeBatch(messages)` — Send messages to server
- `connect() / close()` — Lifecycle management
- `getLastSequenceNum()` — SSE high-water mark for resumption across transport swaps
- `reportState / reportMetadata / reportDelivery` — v2-only: worker state, metadata, and event delivery tracking
- `flush()` — Drain write queue before close (v2 only)

### `setReplBridgeHandle / getReplBridgeHandle`

Global singleton accessors (`src/bridge/replBridgeHandle.ts:18-27`). Set by `useReplBridge.tsx` on init, cleared on teardown. Also publishes the bridge session ID to the concurrent-sessions PID file for peer dedup.

## Interface/Type Definitions

### `BridgeState`

```typescript
type BridgeState = 'ready' | 'connected' | 'reconnecting' | 'failed'
```

State machine transitions: `ready` → `connected` (transport up) → `reconnecting` (transport lost) → `connected` (recovered) or `failed` (gave up).

### `BridgeCoreHandle`

Superset of `ReplBridgeHandle`, adding `getSSESequenceNum(): number` for daemon callers that persist the sequence number across process restarts (`src/bridge/replBridge.ts:228-235`).

### `PollIntervalConfig` (referenced)

Controls poll/heartbeat timing. Key fields: `poll_interval_ms_not_at_capacity`, `poll_interval_ms_at_capacity`, `non_exclusive_heartbeat_interval_ms`, `session_keepalive_interval_v2_ms`, `reclaim_older_than_ms`.

## Configuration & Defaults

| Parameter | Source | Default | Description |
|-----------|--------|---------|-------------|
| `POLL_ERROR_INITIAL_DELAY_MS` | Constant | 2,000 ms | Starting backoff for poll errors |
| `POLL_ERROR_MAX_DELAY_MS` | Constant | 60,000 ms | Maximum backoff cap |
| `POLL_ERROR_GIVE_UP_MS` | Constant | 15 min | Total error budget before giving up |
| `MAX_ENVIRONMENT_RECREATIONS` | Constant | 3 | Max reconnection attempts per failure burst |
| `initialHistoryCap` | GrowthBook `tengu_bridge_initial_history_cap` | 200 | Max messages in initial flush |
| `keepAliveIntervalMs` | GrowthBook `session_keepalive_interval_v2_ms` | 120s | Keep-alive frame interval (0 = disabled) |
| `CLAUDE_BRIDGE_USE_CCR_V2` | Env var | false | Ant-dev override to force v2 transport |
| `CLAUDE_BRIDGE_SESSION_INGRESS_URL` | Env var | baseUrl | Session ingress URL override (ant-only) |
| `CLAUDE_BRIDGE_OAUTH_TOKEN` | Env var | — | Direct OAuth token for local dev |

## Edge Cases & Caveats

- **Echo deduplication**: Two layers prevent self-echo: `recentPostedUUIDs` (bounded ring buffer, 2000 entries) catches outbound messages bouncing back on the transport. `recentInboundUUIDs` (same size) prevents duplicate inbound prompt delivery during transport swaps.

- **Session ID format divergence**: The server may return `session_*` (v1 compat) or `cse_*` (infrastructure layer) IDs for the same session. `sameSessionId()` compares by underlying UUID, and `toInfraSessionId`/`toCompatSessionId` handle conversion. `tryReconnectInPlace` tries both formats sequentially.

- **v2 generation counter**: When multiple `onWorkReceived` calls race (server re-dispatches while `createV2ReplTransport` is in flight), a monotonic `v2Generation` counter ensures only the latest handshake's transport is installed (`src/bridge/replBridge.ts:549-550`).

- **Flush gate ordering**: During initial history flush, `FlushGate` queues new messages to prevent interleaving with historical messages at the server. The `'connected'` state is not emitted until the flush completes.

- **Perpetual mode teardown**: Does NOT send a result message, stop work, or close the transport — only stops polling and lets the socket die with the process. The backend times out the work-item lease (300s TTL) and the next process start reads the crash-recovery pointer to resume.

- **Cross-process dead-token backoff**: When OAuth refresh fails, `bridgeOauthDeadExpiresAt` + `bridgeOauthDeadFailCount` in global config prevent N processes from independently hammering the auth server. Content-addressed by `expiresAt` — a new `/login` automatically clears it.

- **Process suspension detection**: If the at-capacity sleep overruns by >60s (laptop lid close), forces one fast-poll cycle to recover stale transport state (`src/bridge/replBridge.ts:2121-2130`).

- **Heartbeat-fatal fast recovery**: When `heartbeatWork` returns 401/403/404/410, the `onHeartbeatFatal` callback tears down transport and work state immediately, enabling fast re-dispatch instead of the ~25-minute dead window observed without it (`src/bridge/replBridge.ts:1038-1069`).