# DaemonBridge

## Overview & Responsibilities

The DaemonBridge module is the core orchestration engine behind `claude remote-control` — the persistent bridge daemon that connects a local development environment to claude.ai for remote-controlled REPL sessions. It sits within the **RemoteAndBridge > Bridge** subsystem and is responsible for:

- **Environment registration**: Registering a bridge environment with the Environments API so claude.ai knows about this local machine
- **Work polling**: Continuously polling for incoming session work items dispatched from the web UI
- **Session lifecycle management**: Spawning, monitoring, and tearing down child CLI processes for each session
- **Multi-session orchestration**: Running up to 32 concurrent sessions in worktree-isolated or shared-directory mode
- **Token management**: Proactive JWT refresh and OAuth token rotation for long-running sessions
- **Graceful shutdown**: SIGTERM→SIGKILL escalation with configurable grace periods
- **Session resume**: Reconnecting to existing sessions via `--session-id` or `--continue`

The module consists of two files: `bridgeMain.ts` (~3000 lines) containing the main orchestration loop, CLI entrypoint, and argument parsing; and `sessionRunner.ts` (~550 lines) handling child process spawning and stdout/stderr parsing.

## Key Processes

### Bridge Startup Flow

1. **Parse CLI arguments** via `parseArgs()` — validates flags like `--spawn`, `--capacity`, `--session-id`, `--continue` (`src/bridge/bridgeMain.ts:1737-1887`)
2. **Bootstrap environment**: Enable configs, init analytics sinks, validate workspace trust, resolve OAuth tokens (`src/bridge/bridgeMain.ts:2036-2108`)
3. **Gate check**: Verify multi-session feature flag via GrowthBook if `--spawn`/`--capacity` flags were used (`src/bridge/bridgeMain.ts:2055-2076`)
4. **Resolve spawn mode**: Precedence is resume > explicit `--spawn` > saved project preference > gate default (`src/bridge/bridgeMain.ts:2278-2302`)
5. **Register environment** with the Environments API via `api.registerBridgeEnvironment()` (`src/bridge/bridgeMain.ts:2450-2467`)
6. **Pre-create initial session** so the user has an immediate place to type (`src/bridge/bridgeMain.ts:2674-2698`)
7. **Enter poll loop** via `runBridgeLoop()` (`src/bridge/bridgeMain.ts:2732-2750`)

### Main Poll Loop (`runBridgeLoop`)

The core orchestration loop (`src/bridge/bridgeMain.ts:141-1580`) runs until the abort signal fires:

1. **Poll for work** via `api.pollForWork()` with the environment secret
2. **Handle null response** (no work): sleep with capacity-aware intervals, optionally heartbeat active sessions
3. **Decode work secret**: Extract session ingress JWT and v2 flags from the base64url-encoded secret
4. **Dispatch by work type**:
   - `healthcheck`: Acknowledge and log
   - `session`: Either refresh token for an existing session or spawn a new one
5. **Acknowledge work** only after committing to handle it — never before capacity checks
6. **Sleep at capacity** with heartbeat-aware throttling when `maxSessions` is reached

### Session Spawn Flow

When a new session work item arrives (`src/bridge/bridgeMain.ts:859-1204`):

1. **Validate session ID** and check for duplicates (existing sessions get token refreshes instead)
2. **Guard capacity**: Break without acking if at max sessions
3. **Resolve transport**: CCR v2 path registers a worker via `registerWorker()` and builds SSE URLs; v1 path uses WebSocket URLs via `buildSdkUrl()`
4. **Create worktree** (if in worktree mode): Isolates the session in a git worktree to prevent file conflicts
5. **Spawn child process** via `safeSpawn()` → `sessionRunner.createSessionSpawner().spawn()`
6. **Wire up lifecycle**: Register timeout watchdog, schedule JWT refresh, attach `onSessionDone` handler
7. **Fetch/derive title**: Attempt server-side title fetch; fall back to deriving from first user message

### Child Process Management (`sessionRunner.ts`)

`createSessionSpawner()` (`src/bridge/sessionRunner.ts:248-548`) creates a factory that spawns child CLI processes:

1. **Build CLI args**: `--print --sdk-url <url> --session-id <id> --input-format stream-json --output-format stream-json --replay-user-messages` plus optional verbose/debug/permission flags (`src/bridge/sessionRunner.ts:287-304`)
2. **Configure environment**: Strip parent OAuth token, set `CLAUDE_CODE_ENVIRONMENT_KIND=bridge`, inject session access token and v2 env vars (`src/bridge/sessionRunner.ts:306-323`)
3. **Spawn child** via Node's `child_process.spawn()` with piped stdio (`src/bridge/sessionRunner.ts:335-340`)
4. **Parse stdout NDJSON**: Line-by-line parsing via `readline` extracts:
   - `assistant` messages → tool activity tracking (tool_start, text) (`src/bridge/sessionRunner.ts:128-163`)
   - `result` messages → session completion/error status (`src/bridge/sessionRunner.ts:166-197`)
   - `control_request` messages → permission request forwarding (`src/bridge/sessionRunner.ts:417-431`)
   - `user` messages → first-message title derivation (`src/bridge/sessionRunner.ts:432-443`)
5. **Buffer stderr**: Ring buffer of last 10 lines for error diagnostics (`src/bridge/sessionRunner.ts:353-366`)
6. **Return `SessionHandle`**: Exposes `kill()`, `forceKill()`, `writeStdin()`, `updateAccessToken()`, and a `done` promise (`src/bridge/sessionRunner.ts:482-543`)

### Heartbeat & Token Refresh

The bridge maintains session liveness through two mechanisms:

- **Work heartbeats** (`src/bridge/bridgeMain.ts:202-270`): Periodically calls `api.heartbeatWork()` for each active session. On 401/403 (JWT expired), triggers `api.reconnectSession()` to re-queue work with a fresh token
- **Proactive token refresh** (`src/bridge/bridgeMain.ts:284-313`): Uses `createTokenRefreshScheduler()` (from `src/bridge/jwtUtils.ts`) to schedule refresh 5 minutes before JWT expiry. v1 sessions receive new OAuth tokens via stdin; v2 sessions trigger server re-dispatch via `reconnectSession()`

### Graceful Shutdown

When SIGINT/SIGTERM is received (`src/bridge/bridgeMain.ts:1417-1578`):

1. **SIGTERM all active sessions** and wait up to 30 seconds (configurable via `shutdownGraceMs`)
2. **SIGKILL** any processes that didn't exit within the grace window
3. **Clean up worktrees** for any sessions that had isolated directories
4. **Stop all work items** via `api.stopWork()` so the server knows they're done
5. **Archive sessions** so they don't appear stale in the web UI
6. **Deregister environment** so the web UI shows the bridge as offline
7. **Clear bridge pointer** (crash-recovery file) unless in resumable single-session mode

### Error Handling & Backoff

The poll loop uses dual-track exponential backoff (`src/bridge/bridgeMain.ts:1236-1400`):

- **Connection errors** (ECONNREFUSED, ETIMEDOUT, 5xx): Start at 2s, cap at 2min, give up after 10min
- **General errors**: Start at 500ms, cap at 30s, give up after 10min
- **Sleep detection**: If the gap between errors exceeds 2× the backoff cap, reset the error budget (handles laptop sleep/wake)
- **Fatal errors** (`BridgeFatalError`): 401/403 → immediate exit; expired environments get a clean status message

## Function Signatures

### `bridgeMain(args: string[]): Promise<void>`

Primary CLI entrypoint for `claude remote-control`. Handles interactive setup (trust dialog, spawn mode selection, consent), resolves auth, registers the environment, and enters the poll loop.

> Source: `src/bridge/bridgeMain.ts:1980-2768`

### `runBridgeLoop(config, environmentId, environmentSecret, api, spawner, logger, signal, backoffConfig?, initialSessionId?, getAccessToken?): Promise<void>`

Core poll loop. Continuously polls for work, spawns sessions, manages heartbeats and capacity. Returns when the signal aborts or a fatal error occurs.

> Source: `src/bridge/bridgeMain.ts:141-1580`

### `runBridgeHeadless(opts: HeadlessBridgeOpts, signal: AbortSignal): Promise<void>`

Non-interactive entrypoint for daemon workers. Linear subset of `bridgeMain()` — no readline dialogs, no stdin handlers, no TUI. Config comes from the caller, auth via IPC. Throws `BridgeHeadlessPermanentError` for non-retryable failures so the supervisor can distinguish permanent from transient errors.

> Source: `src/bridge/bridgeMain.ts:2810-2965`

### `createSessionSpawner(deps: SessionSpawnerDeps): SessionSpawner`

Factory function that returns a `SessionSpawner` with a `spawn(opts, dir)` method. Each invocation spawns a child CLI process with the given SDK URL and session ID, wiring up stdout/stderr parsing and lifecycle management.

> Source: `src/bridge/sessionRunner.ts:248-548`

### `parseArgs(args: string[]): ParsedArgs`

Parses `claude remote-control` CLI arguments. Validates flag combinations (e.g., `--session-id` incompatible with `--spawn`).

> Source: `src/bridge/bridgeMain.ts:1737-1887`

## Interface/Type Definitions

### `BackoffConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| connInitialMs | number | 2000 | Initial delay for connection errors |
| connCapMs | number | 120000 | Max delay for connection errors (2 min) |
| connGiveUpMs | number | 600000 | Give up after this duration (10 min) |
| generalInitialMs | number | 500 | Initial delay for general errors |
| generalCapMs | number | 30000 | Max delay for general errors (30s) |
| generalGiveUpMs | number | 600000 | Give up after this duration (10 min) |
| shutdownGraceMs | number | 30000 | SIGTERM→SIGKILL grace period |
| stopWorkBaseDelayMs | number | 1000 | Base delay for stopWork retries |

> Source: `src/bridge/bridgeMain.ts:59-70`

### `SpawnMode` (from `types.ts`)

- `'single-session'` — One session in cwd, bridge tears down when it ends
- `'worktree'` — Persistent server, each session gets an isolated git worktree
- `'same-dir'` — Persistent server, all sessions share the current directory

> Source: `src/bridge/types.ts:69`

### `SessionHandle` (from `types.ts`)

The control surface returned by `spawn()`:

- `sessionId: string` — The session identifier
- `done: Promise<SessionDoneStatus>` — Resolves when the child process exits (`'completed'`, `'failed'`, or `'interrupted'`)
- `activities: SessionActivity[]` — Ring buffer of recent activities (max 10)
- `currentActivity: SessionActivity | null` — Most recent activity for status display
- `accessToken: string` — Current session access token
- `lastStderr: string[]` — Ring buffer of last 10 stderr lines
- `kill(): void` — Send SIGTERM (or default signal on Windows)
- `forceKill(): void` — Send SIGKILL after SIGTERM was insufficient
- `writeStdin(data: string): void` — Write data to child's stdin
- `updateAccessToken(token: string): void` — Deliver a fresh token via stdin as an `update_environment_variables` message

### `PermissionRequest`

```typescript
type PermissionRequest = {
  type: 'control_request'
  request_id: string
  request: {
    subtype: 'can_use_tool'
    tool_name: string
    input: Record<string, unknown>
    tool_use_id: string
  }
}
```

Emitted by the child CLI when it needs per-invocation permission approval. The bridge forwards this to the server for user approval.

> Source: `src/bridge/sessionRunner.ts:32-43`

### `BridgeConfig` (from `types.ts`)

Key fields controlling bridge behavior:

| Field | Type | Description |
|-------|------|-------------|
| dir | string | Working directory for sessions |
| maxSessions | number | Maximum concurrent sessions |
| spawnMode | SpawnMode | How session directories are chosen |
| bridgeId | string | Client-generated UUID for this bridge instance |
| reuseEnvironmentId | string? | Backend-issued env ID for resume reconnect |
| apiBaseUrl | string | API base URL for polling |
| sessionIngressUrl | string | WebSocket URL for session ingress |
| sessionTimeoutMs | number? | Per-session timeout (kills sessions that exceed it) |

> Source: `src/bridge/types.ts:81-115`

## Configuration & Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DEFAULT_SESSION_TIMEOUT_MS` | 24 hours | Per-session timeout; sessions exceeding this are killed |
| `SPAWN_SESSIONS_DEFAULT` | 32 | Default max concurrent sessions in multi-session mode |
| `STATUS_UPDATE_INTERVAL_MS` | 1000ms | How often the live status display refreshes |
| `MAX_ACTIVITIES` | 10 | Ring buffer size for per-session activity tracking |
| `MAX_STDERR_LINES` | 10 | Ring buffer size for child stderr capture |

**Environment variables:**

- `CLAUDE_BRIDGE_BASE_URL` — Override API base URL (ant local dev only)
- `CLAUDE_BRIDGE_SESSION_INGRESS_URL` — Override session ingress URL (ant local dev only)
- `CLAUDE_BRIDGE_USE_CCR_V2` — Force CCR v2 transport before server flag enables it
- `CLAUDE_CODE_ENVIRONMENT_KIND` — Set to `'bridge'` on child processes
- `CLAUDE_CODE_SESSION_ACCESS_TOKEN` — Session JWT passed to child processes
- `CLAUDE_CODE_FORCE_SANDBOX` — Enables sandboxing on child processes when `--sandbox` is used
- `CLAUDE_CODE_USE_CCR_V2` / `CLAUDE_CODE_WORKER_EPOCH` — Set on child processes for v2 transport

## Edge Cases & Caveats

- **Stale work redelivery**: The server may redeliver completed work items before processing the bridge's stop request. `completedWorkIds` deduplicates these to prevent duplicate session spawns.
- **Token refresh v1 vs v2**: v1 sessions receive fresh OAuth tokens directly via stdin (`updateAccessToken`). v2 sessions cannot use OAuth (CCR worker endpoints validate the JWT's `session_id` claim), so they trigger server re-dispatch via `reconnectSession()`. The proactive refresh scheduler lives in `src/bridge/jwtUtils.ts`.
- **Resumable shutdown**: In single-session mode with the KAIROS feature gate, SIGINT skips archive+deregister and prints a `--continue` hint. The bridge pointer file is preserved as a backup if the user closes the terminal before copying the session ID.
- **Environment mismatch on resume**: When `--session-id` specifies a session whose environment has been reaped, the backend returns a different `environment_id`. The bridge detects this mismatch and falls back to creating a fresh session with a warning.
- **Worktree mode requires git**: The `--spawn=worktree` flag requires either a git repository or `WorktreeCreate`/`WorktreeRemove` hooks. A saved worktree preference from a formerly-git directory is cleared on launch with a warning.
- **Sleep detection**: If the machine sleeps and wakes, the gap between poll errors exceeds 2× the backoff cap (`pollSleepDetectionThresholdMs`). The bridge resets its error budget to avoid falsely giving up after wake.
- **npm vs bundled spawn**: In npm installs, `process.execPath` is the Node runtime, not the claude binary. `spawnScriptArgs()` prepends `process.argv[1]` so the child doesn't interpret `--sdk-url` as a node option (see `src/bridge/bridgeMain.ts:119-124`).
- **Capacity wake**: When at max capacity, the poll loop sleeps with a `capacityWake` signal that fires immediately when a session completes, allowing the bridge to accept new work without waiting for the full sleep interval.
- **Headless mode**: `runBridgeHeadless()` is a stripped-down entrypoint for daemon workers — no interactive dialogs, no stdin handlers, no `process.exit()`. It throws `BridgeHeadlessPermanentError` for non-retryable failures so the supervisor can distinguish permanent from transient errors.
- **`stopWorkWithRetry`**: Uses exponential backoff (3 attempts, 1s/2s/4s) to ensure the server learns a work item ended, preventing server-side zombies (`src/bridge/bridgeMain.ts:1627-1676`).
- **Auth resolution**: The bridge resolves OAuth tokens via `src/utils/auth.ts` (`getBridgeAccessToken`, `checkAndRefreshOAuthTokenIfNeeded`). Child processes clear the parent OAuth cache so they use session-scoped tokens instead.