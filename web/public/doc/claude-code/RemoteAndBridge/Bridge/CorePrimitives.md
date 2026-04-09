# CorePrimitives

## Overview & Responsibilities

CorePrimitives is the foundational layer of the Bridge subsystem within the RemoteAndBridge module. It provides the shared type definitions, configuration management, debug infrastructure, and concurrency primitives that all other bridge modules (`replBridge.ts`, `bridgeMain.ts`, `remoteBridgeCore.ts`, etc.) depend on.

This module contains no high-level orchestration logic itself — instead, it defines the **contracts** (types and interfaces), **tuning knobs** (poll configuration), **safety utilities** (secret redaction, error parsing), and **coordination primitives** (flush gating, capacity wake) that the bridge's runtime components consume.

Sibling modules in the Bridge subsystem include the env-based bridge path (`replBridge.ts`/`bridgeMain.ts`) and the env-less path (`remoteBridgeCore.ts`), both of which import heavily from these files.

---

## Key Files at a Glance

| File | Purpose |
|------|---------|
| `types.ts` | Protocol types, dependency-injection interfaces, constants |
| `pollConfig.ts` | GrowthBook-tuned poll interval fetching with Zod validation |
| `pollConfigDefaults.ts` | Hardcoded default poll intervals (no GrowthBook dependency) |
| `bridgeDebug.ts` | Ant-only fault injection for testing recovery paths |
| `debugUtils.ts` | Secret redaction, error extraction, debug truncation |
| `flushGate.ts` | State machine for gating message writes during history flush |
| `capacityWake.ts` | Shared wake primitive for poll loop capacity management |

---

## Type Definitions (`types.ts`)

### Protocol Types — Environments API

The bridge communicates with claude.ai's Environments API using three core types:

- **`WorkData`** — The payload inside a work item. Has a `type` field (`'session'` or `'healthcheck'`) and an `id`.
- **`WorkResponse`** — A complete work item returned by the poll endpoint. Contains the `WorkData`, an `environment_id`, a `state`, a base64url-encoded `secret` string, and a `created_at` timestamp.
- **`WorkSecret`** — Decoded from `WorkResponse.secret`. Carries the `session_ingress_token` for WebSocket auth, `api_base_url`, source repository configuration, auth tokens, optional MCP config, environment variables, and a `use_code_sessions` flag for CCR v2 routing.

> Source: `src/bridge/types.ts:18-51`

### Session Lifecycle Types

- **`SessionDoneStatus`** — `'completed' | 'failed' | 'interrupted'` — terminal states for a session.
- **`SessionActivity`** — Lightweight activity event (`tool_start`, `text`, `result`, `error`) with a summary string and timestamp, used for UI status display.
- **`SpawnMode`** — Controls how `claude remote-control` assigns working directories:
  - `'single-session'`: one session in cwd, bridge exits when it ends
  - `'worktree'`: persistent server, each session gets an isolated git worktree
  - `'same-dir'`: persistent server, all sessions share cwd

> Source: `src/bridge/types.ts:53-69`

### `BridgeConfig`

Configuration for a bridge instance. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `dir` | `string` | Working directory |
| `machineName` | `string` | Human-readable machine identifier |
| `branch` | `string` | Git branch |
| `maxSessions` | `number` | Concurrent session limit |
| `spawnMode` | `SpawnMode` | Directory isolation strategy |
| `bridgeId` | `string` | Client-generated UUID for this bridge instance |
| `workerType` | `string` | Metadata for web client filtering (e.g. `'claude_code'`) |
| `environmentId` | `string` | Client UUID for idempotent registration |
| `reuseEnvironmentId` | `string?` | Backend-issued ID for reconnect (resume scenarios) |
| `apiBaseUrl` | `string` | API endpoint for polling |
| `sessionIngressUrl` | `string` | WebSocket endpoint (may differ from apiBaseUrl locally) |
| `sessionTimeoutMs` | `number?` | Per-session timeout; defaults to 24 hours (`DEFAULT_SESSION_TIMEOUT_MS`) |

> Source: `src/bridge/types.ts:81-115`

### Dependency-Injection Interfaces

These interfaces decouple bridge logic from concrete implementations, enabling testability:

**`BridgeApiClient`** — The HTTP client contract for all Environments API operations:
- `registerBridgeEnvironment()` — Register the bridge, get back an `environment_id` and `environment_secret`
- `pollForWork()` — Long-poll for new work items (supports `AbortSignal` and stale-work reclaim)
- `acknowledgeWork()` — ACK a work item so the server marks it in-progress
- `stopWork()` / `deregisterEnvironment()` — Cleanup operations
- `sendPermissionResponseEvent()` — Push a permission decision back to a session
- `archiveSession()` / `reconnectSession()` — Session lifecycle management
- `heartbeatWork()` — Lightweight lease extension using JWT auth (no DB hit)

> Source: `src/bridge/types.ts:133-176`

**`SessionHandle`** — Represents a running child session process:
- `done: Promise<SessionDoneStatus>` — Resolves when the session terminates
- `kill()` / `forceKill()` — Graceful and forced termination
- `activities` / `currentActivity` — Ring buffer of recent activity events
- `writeStdin()` — Direct stdin access to the child process
- `updateAccessToken()` — Hot-swap the session token (e.g. after refresh)

> Source: `src/bridge/types.ts:178-190`

**`SessionSpawner`** — Factory for creating `SessionHandle` instances. The `spawn()` method accepts `SessionSpawnOpts` (session ID, SDK URL, access token, CCR v2 flags, and an optional `onFirstUserMessage` callback for title derivation).

> Source: `src/bridge/types.ts:192-211`

**`BridgeLogger`** — UI abstraction with 20+ methods covering banner display, session status, reconnection status, QR code toggling, multi-session list management, and idle/error states. This decouples bridge logic from the terminal rendering layer entirely.

> Source: `src/bridge/types.ts:213-262`

---

## Poll Configuration (`pollConfig.ts` + `pollConfigDefaults.ts`)

### Default Values

Poll intervals are defined in `pollConfigDefaults.ts` to avoid pulling in GrowthBook's transitive dependency chain:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `poll_interval_ms_not_at_capacity` | 2,000ms | Polling speed when seeking work (affects "connecting…" latency) |
| `poll_interval_ms_at_capacity` | 600,000ms (10 min) | Liveness poll when a session is connected. Gives 24× headroom on the server's 4h Redis TTL |
| `non_exclusive_heartbeat_interval_ms` | 0 (disabled) | Per-work-item heartbeat interval, runs alongside (not instead of) at-capacity polling |
| `multisession_poll_interval_ms_*` | Same as single-session | Independently tunable for `bridgeMain.ts` multi-session mode |
| `reclaim_older_than_ms` | 5,000ms | Reclaim unacknowledged work items older than this (matches server default) |
| `session_keepalive_interval_v2_ms` | 120,000ms (2 min) | Keep-alive frame interval to prevent upstream proxy GC |

> Source: `src/bridge/pollConfigDefaults.ts:55-82`

### Live Tuning via GrowthBook

`getPollIntervalConfig()` in `pollConfig.ts` fetches the `tengu_bridge_poll_interval_config` feature flag from GrowthBook with a 5-minute refresh window. The raw value is validated against a Zod schema with several safety constraints:

1. **Minimum floors**: All "not at capacity" intervals require `≥ 100ms` to prevent tight-looping
2. **Zero-or-≥100 rule**: "At capacity" intervals accept `0` (disabled) or `≥ 100ms`. Values 1–99 are rejected to catch unit confusion (seconds vs milliseconds)
3. **Liveness invariant**: At least one at-capacity liveness mechanism (heartbeat OR poll interval) must be enabled, enforced via object-level `.refine()` checks on both single-session and multi-session configs

If validation fails on any field, the **entire config** falls back to `DEFAULT_POLL_CONFIG` rather than being partially trusted.

> Source: `src/bridge/pollConfig.ts:28-110`

---

## Debug Infrastructure

### Fault Injection (`bridgeDebug.ts`)

An **ant-only** (internal Anthropic users) fault injection system for manually testing bridge recovery paths. Real failure modes it targets include:

- Poll 404 `not_found_error` (~147K sessions/week)
- WebSocket close codes 1002/1006 (~22K sessions/week)
- Transient registration failures during reconnect

**Architecture**: A module-level singleton `BridgeDebugHandle` is registered by the bridge's init function and cleared on teardown. The `/bridge-kick` slash command uses this handle to:

- `fireClose(code)` — Simulate a WebSocket permanent-close event
- `forceReconnect()` — Trigger `reconnectEnvironmentWithSession()`
- `injectFault(fault)` — Queue a one-shot or multi-shot fault
- `wakePollLoop()` — Abort the at-capacity sleep for immediate fault delivery

**Fault injection flow**:
1. `/bridge-kick` calls `injectBridgeFault()` to push a `BridgeFault` onto the `faultQueue`
2. `wrapApiForFaultInjection()` wraps the real `BridgeApiClient` in a proxy
3. On each API call, the proxy checks the queue for a matching fault by method name
4. Matching faults throw either a `BridgeFatalError` (triggers teardown) or a plain `Error` (triggers retry/backoff), mirroring real error behavior
5. Fault count is decremented per use; removed at zero

The wrapper is only applied when `USER_TYPE === 'ant'`, so there is zero overhead in external builds.

> Source: `src/bridge/bridgeDebug.ts:1-135`

### Debug Utilities (`debugUtils.ts`)

Shared helpers for safe debug logging and error extraction:

**`redactSecrets(s: string)`** — Regex-based redaction of sensitive JSON fields (`session_ingress_token`, `environment_secret`, `access_token`, `secret`, `token`). Values shorter than 16 characters are fully replaced with `[REDACTED]`; longer values preserve the first 8 and last 4 characters (e.g., `"abcdefgh...wxyz"`).

> Source: `src/bridge/debugUtils.ts:26-34`

**`debugTruncate(s: string)`** / **`debugBody(data: unknown)`** — Truncate strings or JSON-serializable values to 2,000 characters for debug logging, with newlines collapsed to `\n` literals. `debugBody` also applies secret redaction before truncation.

> Source: `src/bridge/debugUtils.ts:37-53`

**`describeAxiosError(err: unknown)`** — Extract a descriptive error message from an axios error. Appends the server's `data.message` or `data.error.message` if present, since axios's default message only includes the status code.

> Source: `src/bridge/debugUtils.ts:60-82`

**`extractHttpStatus(err: unknown)`** — Pull the HTTP status code from an axios error's `response.status`. Returns `undefined` for non-HTTP errors (network failures).

> Source: `src/bridge/debugUtils.ts:88-100`

**`extractErrorDetail(data: unknown)`** — Extract a human-readable message from an API response body, checking `data.message` then `data.error.message`.

> Source: `src/bridge/debugUtils.ts:106-121`

**`logBridgeSkip(reason, debugMsg?, v2?)`** — Centralized logging for bridge initialization skips. Emits both a debug log message and a `tengu_bridge_repl_skipped` analytics event.

> Source: `src/bridge/debugUtils.ts:128-141`

---

## Concurrency Primitives

### FlushGate (`flushGate.ts`)

A generic state machine (`FlushGate<T>`) for gating message writes during an initial history flush. When a bridge session starts, historical messages are POSTed to the server in bulk. Any new messages arriving during this flush must be queued to prevent interleaving.

**State transitions**:

```
[inactive] --start()--> [active: queuing]
[active]   --end()----> [inactive] (returns queued items for draining)
[active]   --drop()---> [inactive] (discards items — permanent close)
[active]   --deactivate()--> [inactive] (preserves items — transport replacement)
```

**Key methods**:
- `start()` — Mark flush in-progress; `enqueue()` begins queuing
- `enqueue(...items)` — Returns `true` if items were queued (flush active), `false` if caller should send directly
- `end()` — Returns all queued items via `splice(0)` and deactivates. Caller is responsible for draining
- `drop()` — Discards all queued items and deactivates (used on permanent transport close)
- `deactivate()` — Clears the active flag but preserves queued items (used when the transport is replaced — the new transport's flush will drain them)

> Source: `src/bridge/flushGate.ts:1-71`

### CapacityWake (`capacityWake.ts`)

A shared wake primitive for bridge poll loops. Both `replBridge.ts` and `bridgeMain.ts` need to sleep while "at capacity" but wake early on shutdown or session completion. This module eliminates the duplicated signal-merging logic.

**`createCapacityWake(outerSignal: AbortSignal): CapacityWake`**

Returns an object with two methods:

- **`signal()`** — Creates a merged `AbortSignal` that fires when either the outer loop signal (shutdown) or the internal wake controller fires. Returns `{ signal, cleanup }` — the cleanup function removes event listeners if the sleep resolves normally without abort.
- **`wake()`** — Aborts the current at-capacity sleep and arms a fresh `AbortController` so the poll loop immediately re-checks for new work.

**Implementation detail**: On each `wake()` call, the existing `AbortController` is aborted and replaced with a new one. This ensures that the poll loop immediately re-enters its work-check cycle. The `signal()` method handles already-aborted states by immediately aborting the merged controller if either source is already aborted at call time.

> Source: `src/bridge/capacityWake.ts:1-56`

---

## Edge Cases & Caveats

- **Poll config validation is all-or-nothing**: If any single field in the GrowthBook config fails Zod validation, the entire config falls back to defaults. There is no partial acceptance — this prevents a config with one bad field from being partially trusted.
- **Heartbeat and at-capacity polling are independent**: Both can run simultaneously. The heartbeat loop periodically yields to poll. Setting both to 0 is rejected by the schema's refine constraints.
- **Fault injection is ant-only**: `wrapApiForFaultInjection()` is only called when `USER_TYPE === 'ant'`. External builds see the raw `BridgeApiClient` with no proxy overhead.
- **FlushGate's `deactivate()` vs `drop()`**: `deactivate()` preserves queued items for a replacement transport to drain, while `drop()` discards them on permanent close. Using the wrong one can lose messages or cause stale delivery.
- **Secret redaction length threshold**: Values shorter than 16 characters are fully replaced with `[REDACTED]`; longer values show partial content. This means short tokens get no partial visibility in debug logs.
- **`DEFAULT_SESSION_TIMEOUT_MS`** is 24 hours (`src/bridge/types.ts:1`). Sessions exceeding this are killed by the bridge.
- **`reclaim_older_than_ms`** (default 5,000ms) must be ≥1 per server constraint. It enables picking up stale-pending work after JWT expiry when a prior ACK failed.