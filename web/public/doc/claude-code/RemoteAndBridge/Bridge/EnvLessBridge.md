# EnvLessBridge

## Overview & Responsibilities

The EnvLessBridge is a simplified Remote Control bridge core that connects Claude Code directly to the session-ingress layer **without** the Environments API work-dispatch layer. It lives within the **RemoteAndBridge → Bridge** subsystem and coexists with the older env-based bridge path (`replBridge.ts` / `bridgeMain.ts`).

**Key distinction**: "Env-less" refers to removing the poll/dispatch layer (Environments API), not to the transport protocol. The env-based path can also use CCR v2 transport. This module eliminates the `register → poll → ack → stop → heartbeat → deregister` environment lifecycle entirely, replacing it with two HTTP calls and a direct SSE connection.

The module is gated by the `tengu_bridge_repl_v2` GrowthBook flag and is **REPL-only** — daemon and print modes stay on the env-based path.

### Files

| File | Lines | Role |
|------|-------|------|
| `src/bridge/remoteBridgeCore.ts` | ~1009 | Main bridge core — initialization, transport lifecycle, JWT refresh, 401 recovery, teardown |
| `src/bridge/envLessBridgeConfig.ts` | ~165 | GrowthBook-tuned configuration with Zod validation and safe defaults |
| `src/bridge/codeSessionApi.ts` | ~169 | Thin HTTP wrappers for the CCR v2 code-session API (deliberately decoupled for SDK bundling) |

## Key Processes

### Session Initialization Flow

The entry point is `initEnvLessBridgeCore(params)` (`src/bridge/remoteBridgeCore.ts:140`), which orchestrates a 5-step startup:

1. **Create session** — `POST /v1/code/sessions` with OAuth token, title, and a `bridge: {}` body signal (no `env_id`). Returns a `cse_*`-prefixed session ID (`src/bridge/codeSessionApi.ts:26-80`).

2. **Fetch bridge credentials** — `POST /v1/code/sessions/{id}/bridge` with OAuth token. Returns a `RemoteCredentials` object: `worker_jwt`, `api_base_url`, `expires_in`, and `worker_epoch`. Each `/bridge` call bumps epoch server-side — this **is** the register (`src/bridge/codeSessionApi.ts:93-168`).

3. **Build v2 transport** — Calls `createV2ReplTransport()` with the worker JWT and epoch, producing an SSE read stream + CCRClient write path (`src/bridge/remoteBridgeCore.ts:220-255`).

4. **Schedule JWT refresh** — Uses `createTokenRefreshScheduler()` (from `src/bridge/jwtUtils.ts`) to proactively re-fetch credentials before the JWT expires (default: 5 minutes before expiry) (`src/bridge/remoteBridgeCore.ts:317-377`).

5. **Wire callbacks and connect** — Attaches `onConnect`, `onData`, and `onClose` handlers, starts the SSE connection, and arms a connect-timeout deadline (`src/bridge/remoteBridgeCore.ts:380-604`).

All init-phase HTTP calls use `withRetry()` — exponential backoff with jitter, up to 3 attempts by default (`src/bridge/remoteBridgeCore.ts:892-913`).

### Transport Rebuild (JWT Refresh & 401 Recovery)

Two paths trigger a transport rebuild — both share `rebuildTransport()` (`src/bridge/remoteBridgeCore.ts:477-527`):

**Proactive refresh** (`src/bridge/remoteBridgeCore.ts:328-376`):
1. Timer fires ~5min before JWT expiry
2. Refreshes OAuth token via `onAuth401`
3. Calls `POST /bridge` for fresh credentials (new JWT + bumped epoch)
4. Rebuilds transport, preserving the SSE sequence number

**401 recovery** (`src/bridge/remoteBridgeCore.ts:530-590`):
1. SSE transport fires `onClose(401)` (JWT expired on the server)
2. Refreshes OAuth token
3. Fetches fresh credentials via `POST /bridge`
4. Rebuilds transport with `initialFlushDone = false` so history re-flushes

Both paths are **mutually exclusive** — the `authRecoveryInFlight` flag prevents double epoch bumps when laptop-wake fires both simultaneously (`src/bridge/remoteBridgeCore.ts:333-340`, `460-461`).

The rebuild sequence in `rebuildTransport()`:
1. Start `FlushGate` to queue writes during the swap
2. Capture the old transport's last SSE sequence number
3. Close old transport, create new one with fresh JWT/epoch and preserved seq-num
4. Re-wire callbacks, reconnect, reschedule refresh timer
5. Drain queued messages into the new transport

### Message Flow

**Outbound** (`writeMessages`, `src/bridge/remoteBridgeCore.ts:767-812`):
1. Filter messages: must be eligible bridge messages, not already posted, not initial-history duplicates
2. Fire `onUserMessage` callback for title derivation (until callback returns `true`)
3. If `FlushGate` is active (history flush or rebuild in progress), queue messages
4. Otherwise, add UUIDs to `recentPostedUUIDs`, convert to SDK format, and `writeBatch()`
5. If batch contains a user message, report state as `'running'`

**Inbound** (`setOnData`, `src/bridge/remoteBridgeCore.ts:422-448`):
1. Raw SSE data → `handleIngressMessage()` with echo-dedup (`recentPostedUUIDs`) and re-delivery dedup (`recentInboundUUIDs`)
2. Permission responses trigger `transport.reportState('running')` then forward to `onPermissionResponse`
3. Server control requests (interrupt, set model, set permission mode) route through `handleServerControlRequest()`

**Echo dedup** uses a two-tier approach (`src/bridge/remoteBridgeCore.ts:260-276`):
- `recentPostedUUIDs`: `BoundedUUIDSet` ring buffer (default 2000 capacity) for live writes
- `initialMessageUUIDs`: unbounded `Set` for initial history UUIDs (fallback if ring buffer evicts them)
- `recentInboundUUIDs`: separate ring buffer for re-delivered inbound prompts

### History Flush

On first connect, if `initialMessages` are provided:
1. `FlushGate` starts before `transport.connect()` — queues any live writes during handshake (`src/bridge/remoteBridgeCore.ts:596-598`)
2. `onConnect` triggers `flushHistory()` which filters eligible messages, applies the `initialHistoryCap`, and `writeBatch()`es them (`src/bridge/remoteBridgeCore.ts:624-656`)
3. After flush completes (and if no rebuild interrupted it), `drainFlushGate()` sends queued live messages and transitions state to `'connected'` (`src/bridge/remoteBridgeCore.ts:607-622`)

### Graceful Teardown

`teardown()` (`src/bridge/remoteBridgeCore.ts:664-745`) runs under a 2-second budget from `gracefulShutdown`:
1. Cancel refresh scheduler, clear connect deadline, drop flush gate
2. Report state `'idle'` and fire-and-forget a result message
3. `POST /v1/sessions/{compatId}/archive` — uses the compat session ID format (`session_*`) via `toCompatSessionId()` (from `src/bridge/sessionIdCompat.ts`) because the archive endpoint lives at the compat layer
4. If archive returns 401, retry once after OAuth refresh
5. Close transport
6. Emit teardown telemetry with archive status categorization

The teardown is registered via `registerCleanup()` for SIGINT/SIGTERM handling (`src/bridge/remoteBridgeCore.ts:746`).

## Function Signatures

### `initEnvLessBridgeCore(params: EnvLessBridgeParams): Promise<ReplBridgeHandle | null>`

Main entry point. Creates a session, fetches credentials, builds transport, and returns a handle for message I/O. Returns `null` on any pre-flight failure.

> Source: `src/bridge/remoteBridgeCore.ts:140-887`

### `EnvLessBridgeParams` (input)

| Field | Type | Description |
|-------|------|-------------|
| `baseUrl` | `string` | API base URL |
| `orgUUID` | `string` | Organization UUID for archive headers |
| `title` | `string` | Session title |
| `getAccessToken` | `() => string \| undefined` | Returns current OAuth token |
| `onAuth401` | `(staleToken: string) => Promise<boolean>` | OAuth refresh callback |
| `toSDKMessages` | `(msgs: Message[]) => SDKMessage[]` | Message format converter (injected to avoid bundle bloat) |
| `initialHistoryCap` | `number` | Max messages in initial history flush |
| `initialMessages` | `Message[]` | Pre-existing conversation history to flush |
| `onInboundMessage` | `(msg: SDKMessage) => void` | Callback for incoming messages |
| `onUserMessage` | `(text: string, sessionId: string) => boolean` | Title derivation callback; return `true` when done |
| `onStateChange` | `(state: BridgeState, detail?: string) => void` | State transition callback |
| `outboundOnly` | `boolean` | Skip SSE read stream (CCR mirror mode) |
| `tags` | `string[]` | Free-form session tags (e.g. `['ccr-mirror']`) |

> Source: `src/bridge/remoteBridgeCore.ts:89-131`

### `ReplBridgeHandle` (returned)

The returned handle exposes:
- `writeMessages(messages: Message[])` — Send conversation messages
- `writeSdkMessages(messages: SDKMessage[])` — Send pre-formatted SDK messages
- `sendControlRequest(request)` / `sendControlResponse(response)` — Permission flow
- `sendControlCancelRequest(requestId)` — Cancel a permission request (locally resolved)
- `sendResult()` — Signal turn completion (sets state to `'idle'`)
- `teardown()` — Graceful shutdown with session archival

> Source: `src/bridge/remoteBridgeCore.ts:763-886`

### `createCodeSession(baseUrl, accessToken, title, timeoutMs, tags?): Promise<string | null>`

Creates a new code session via `POST /v1/code/sessions`. Returns the `cse_*` session ID or `null` on failure. Sends `bridge: {}` in the body as the positive signal for the BridgeRunner oneof.

> Source: `src/bridge/codeSessionApi.ts:26-80`

### `fetchRemoteCredentials(sessionId, baseUrl, accessToken, timeoutMs): Promise<RemoteCredentials | null>`

CLI-side wrapper that injects the trusted-device token (from `src/bridge/trustedDevice.ts`) and applies the `CLAUDE_BRIDGE_BASE_URL` dev override (from `src/bridge/bridgeConfig.ts`).

> Source: `src/bridge/remoteBridgeCore.ts:931-948`

## Interface/Type Definitions

### `RemoteCredentials`

Credentials returned by `POST /bridge`. Each call bumps `worker_epoch` server-side.

```typescript
// src/bridge/codeSessionApi.ts:86-91
type RemoteCredentials = {
  worker_jwt: string      // Opaque — do not decode
  api_base_url: string    // CCR endpoint for this session
  expires_in: number      // JWT validity in seconds
  worker_epoch: number    // Server-assigned epoch (protojson: may be string or number)
}
```

### `EnvLessBridgeConfig`

GrowthBook-tunable timing and behavior parameters. See Configuration section below.

> Source: `src/bridge/envLessBridgeConfig.ts:7-42`

### `ConnectCause`

Telemetry discriminator: `'initial' | 'proactive_refresh' | 'auth_401_recovery'`

> Source: `src/bridge/remoteBridgeCore.ts:79`

## Configuration & Defaults

All configuration is fetched once per `initEnvLessBridgeCore` call from the `tengu_bridge_repl_v2_config` GrowthBook flag and validated with a Zod schema that rejects the entire object on violation (falls back to defaults).

| Parameter | Default | Constraints | Purpose |
|-----------|---------|-------------|---------|
| `init_retry_max_attempts` | 3 | 1–10 | Max retries for init-phase HTTP calls |
| `init_retry_base_delay_ms` | 500 | ≥100 | Base backoff delay |
| `init_retry_jitter_fraction` | 0.25 | 0–1 | ±fraction of base delay |
| `init_retry_max_delay_ms` | 4000 | ≥500 | Backoff ceiling |
| `http_timeout_ms` | 10,000 | ≥2000 | Axios timeout for session/bridge/archive calls |
| `uuid_dedup_buffer_size` | 2000 | 100–50,000 | Ring buffer capacity for echo dedup |
| `heartbeat_interval_ms` | 20,000 | 5,000–30,000 | CCRClient heartbeat cadence (server TTL = 60s) |
| `heartbeat_jitter_fraction` | 0.1 | 0–0.5 | Per-beat jitter to spread fleet load |
| `token_refresh_buffer_ms` | 300,000 (5min) | 30s–30min | How early to refresh JWT before expiry |
| `teardown_archive_timeout_ms` | 1,500 | 500–2,000 | Archive POST timeout (must fit in 2s shutdown budget) |
| `connect_timeout_ms` | 15,000 | 5,000–60,000 | Deadline for initial SSE connect |
| `min_version` | `'0.0.0'` | Valid semver | Minimum CLI version for v2 bridge |
| `should_show_app_upgrade_message` | `false` | boolean | Nudge users to upgrade claude.ai app |

> Source: `src/bridge/envLessBridgeConfig.ts:44-117`

### Config Helper Functions

- **`getEnvLessBridgeConfig()`** (`src/bridge/envLessBridgeConfig.ts:130-137`): Fetches config from GrowthBook. Uses the blocking getter (not cached) since this runs well after GrowthBook init.
- **`checkEnvLessBridgeMinVersion()`** (`src/bridge/envLessBridgeConfig.ts:147-153`): Returns an error message if CLI version is below `min_version`, or `null`.
- **`shouldShowAppUpgradeMessage()`** (`src/bridge/envLessBridgeConfig.ts:161-165`): Returns `true` only when v2 bridge is active AND the config flag is set.

## Edge Cases & Caveats

- **Laptop wake race**: Proactive refresh timer and SSE 401 can fire simultaneously after laptop wake. The `authRecoveryInFlight` flag serializes them — the second path skips entirely. Without this, both would call `/bridge`, double-bumping the epoch and causing a 409 on the first rebuild.

- **Epoch is per-transport**: Every `/bridge` call bumps `worker_epoch` server-side. A JWT-only swap (without transport rebuild) leaves the old CCRClient heartbeating with a stale epoch, which 409s within ~20 seconds.

- **`onClose` codes are terminal**: Only `401` triggers recovery. Codes `4090` (epoch mismatch), `4091` (init failed), or SSE reconnect budget exhaustion are dead-ends that transition to `'failed'` state.

- **`worker_epoch` may be a string**: The server uses protojson which serializes `int64` as strings to avoid JS precision loss. `src/bridge/codeSessionApi.ts:150-161` handles both string and number forms.

- **Archive uses compat session IDs**: The archive endpoint lives at `/v1/sessions/*` (not `/v1/code/sessions/*`) and requires `session_*` format. `toCompatSessionId()` (from `src/bridge/sessionIdCompat.ts`) retags `cse_*` IDs. The `anthropic-beta` and `x-organization-uuid` headers are required — without them the compat gateway 404s.

- **`codeSessionApi.ts` is intentionally thin**: It avoids importing analytics, transport, or config modules so the SDK `/bridge` subpath can bundle `createCodeSession` + `fetchRemoteCredentials` without pulling in the heavy CLI tree.

- **FlushGate ordering**: Live writes during history flush or transport rebuild are queued (not dropped) and drained in order once the operation completes. This ensures the server receives `[history..., live...]` in sequence.

- **`outboundOnly` mode**: When `true` (CCR mirror), the SSE read stream is skipped — only the CCRClient write path is active. Teardown telemetry uses a separate event name (`tengu_ccr_mirror_teardown`).

- **Teardown budget**: `gracefulShutdown` gives cleanup functions 2 seconds. The result message is fire-and-forget (enqueued, not awaited). Archive timeout defaults to 1.5s. A 401 retry on archive shares the same budget — if both fire, `forceExit` kills the process.

- **Control requests during recovery**: All `sendControlRequest`, `sendControlResponse`, `sendControlCancelRequest`, and `sendResult` calls are silently dropped while `authRecoveryInFlight` is true, with debug logging.