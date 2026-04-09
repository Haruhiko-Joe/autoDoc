# BridgeDisplay

## Overview & Responsibilities

BridgeDisplay is the terminal UI, status display, and crash-recovery layer for the Bridge subsystem within the RemoteAndBridge module. It sits between the bridge session lifecycle (managed by `replBridge.ts` / `bridgeMain.ts`) and the user's terminal, translating internal session state changes into a live, continuously-updated terminal display. It also manages persistent crash-recovery pointers so that sessions can be resumed after an unexpected process exit.

The module is composed of three files with distinct roles:

| File | Lines | Role |
|------|-------|------|
| `bridgeUI.ts` | ~530 | Terminal renderer — implements the `BridgeLogger` interface with a state machine driving all visual output |
| `bridgeStatusUtil.ts` | ~163 | Pure formatting helpers — URL builders, shimmer math, duration formatting, OSC-8 hyperlinks |
| `bridgePointer.ts` | ~210 | Crash-recovery pointer management — persistent files for session resume with TTL and worktree scanning |

In the broader architecture, BridgeDisplay is a sibling to the bridge core modules (session creation, WebSocket transport, work-dispatch polling). The bridge core calls into `BridgeLogger` methods as session state evolves; BridgeDisplay renders those changes directly to stdout using ANSI escape sequences (not through the Ink/React UI pipeline used by the REPL).

## Key Processes

### Terminal Rendering Lifecycle

The bridge logger manages a **status block** at the bottom of the terminal that is continuously rewritten in place using ANSI cursor movement:

1. **`printBanner()`** initializes the display: caches the environment ID and ingress URL, builds the connect URL via `buildBridgeConnectUrl()`, starts QR code generation asynchronously, and launches the connecting spinner (`src/bridge/bridgeUI.ts:295-320`)
2. The **connecting spinner** (`startConnecting()`) runs on a 150ms interval, cycling through `BRIDGE_SPINNER_FRAMES` with a yellow "Connecting" label until the first `updateIdleStatus()` call stops it (`src/bridge/bridgeUI.ts:170-185`)
3. **`updateIdleStatus()`** transitions to the `idle` state, regenerates the QR code for the environment connect URL, and renders the green "Ready" status line (`src/bridge/bridgeUI.ts:376-386`)
4. **`setAttached()`** transitions to `attached` / cyan "Connected". In single-session mode, it builds a per-session URL via `buildBridgeSessionUrl()` and updates the QR code to point there. In multi-session mode, the QR stays on the environment URL so users can spawn additional sessions (`src/bridge/bridgeUI.ts:388-405`)
5. **`updateReconnectingStatus()`** shows a yellow spinner with retry delay and disconnection elapsed time (`src/bridge/bridgeUI.ts:407-425`)
6. **`updateFailedStatus()`** shows a red failure indicator with the error message and static footer text (`src/bridge/bridgeUI.ts:427-448`)

### Status Block Rendering (`renderStatusLine`)

The core rendering function (`src/bridge/bridgeUI.ts:188-292`) assembles the status block from top to bottom:

1. Clears previous status lines using tracked line count
2. Renders QR code lines (if visible) in dim text
3. Renders the main status indicator with state-appropriate color (green for idle, cyan for attached/titled)
4. Appends repo name and branch as dim suffixes (branch hidden in worktree mode to avoid confusion)
5. **Multi-session mode** (`sessionMax > 1`): renders capacity line (`active/max`) with mode hint, then a bullet list of per-session entries — each showing a truncated title (or "Attached") wrapped in an OSC-8 terminal hyperlink, plus a dim activity summary
6. **Single-session mode**: renders a mode description line, and optionally a tool activity line if a tool started within the last 30 seconds (`TOOL_DISPLAY_EXPIRY_MS`)
7. Renders footer text with the connect/session URL and keyboard hints (space for QR toggle, `w` for spawn mode toggle)

### Line Counting for In-Place Updates

The `countVisualLines()` function (`src/bridge/bridgeUI.ts:95-115`) calculates how many terminal rows a string occupies, accounting for line wrapping at `process.stdout.columns`. Every `writeStatus()` call accumulates the count into `statusLineCount`. `clearStatusLines()` then uses ANSI escape `\x1b[{N}A` (cursor up) + `\x1b[J` (erase to end of screen) to wipe exactly the right number of rows.

### Shimmer Animation

`bridgeStatusUtil.ts` provides two functions for a reverse-sweep shimmer effect used by both the CLI renderer and the React/Ink bridge component:

- **`computeGlimmerIndex(tick, messageWidth)`** returns a column position that sweeps right-to-left across the message width on each tick (`src/bridge/bridgeStatusUtil.ts:61-67`)
- **`computeShimmerSegments(text, glimmerIndex)`** splits text into `{ before, shimmer, after }` segments using grapheme segmentation, so callers can apply highlight coloring to the shimmer window (`src/bridge/bridgeStatusUtil.ts:79-111`)

### Crash-Recovery Pointer Lifecycle

1. **Write on session start**: `writeBridgePointer()` creates a JSON file containing `{ sessionId, environmentId, source }` in the project-scoped storage directory. The path is derived from the working directory via `sanitizePath()` so concurrent bridges in different repos don't collide (`src/bridge/bridgePointer.ts:62-74`)
2. **Periodic refresh**: The same `writeBridgePointer()` call is made periodically with identical content — the meaningful update is the file's `mtime`, which serves as the staleness clock
3. **Clean shutdown**: `clearBridgePointer()` deletes the file. It is idempotent — `ENOENT` is silently ignored (`src/bridge/bridgePointer.ts:190-202`)
4. **Resume detection on next startup**: `readBridgePointer()` reads and validates the file against a Zod schema, checks staleness against `BRIDGE_POINTER_TTL_MS` (4 hours), and auto-deletes stale or invalid pointers (`src/bridge/bridgePointer.ts:83-113`)
5. **Worktree fanout scanning**: `readBridgePointerAcrossWorktrees()` first checks the current directory (fast path: one `stat`, zero `exec`). On miss, it calls `getWorktreePathsPortable()` to discover sibling worktrees and reads pointers from all of them in parallel, returning the freshest one. Capped at `MAX_WORKTREE_FANOUT = 50` to avoid pathological `stat()` bursts (`src/bridge/bridgePointer.ts:129-184`)

## Function Signatures

### bridgeUI.ts — `createBridgeLogger(options): BridgeLogger`

Factory function returning the full `BridgeLogger` interface. The returned object exposes:

| Method | Purpose |
|--------|---------|
| `printBanner(config, environmentId)` | Initialize display with config and start connecting spinner |
| `logSessionStart(sessionId, prompt)` | Log session start (verbose only) |
| `logSessionComplete(sessionId, durationMs)` | Log session completion with duration |
| `logSessionFailed(sessionId, error)` | Log session failure |
| `logStatus(message)` / `logVerbose(message)` / `logError(message)` | Timestamped log lines |
| `logReconnected(disconnectedMs)` | Log reconnection with downtime duration |
| `setRepoInfo(repo, branchName)` | Set repo/branch for status suffix |
| `setDebugLogPath(path)` | Set debug log path (ANT-only display) |
| `updateIdleStatus()` | Transition to idle/Ready state |
| `setAttached(sessionId)` | Transition to attached/Connected state |
| `updateReconnectingStatus(delayStr, elapsedStr)` | Show reconnecting spinner |
| `updateFailedStatus(error)` | Show failure state |
| `updateSessionStatus(sessionId, elapsed, activity, trail)` | Update tool activity display |
| `updateSessionCount(active, max, mode)` | Update session capacity counters |
| `setSpawnModeDisplay(mode)` | Set spawn mode for toggle hint |
| `addSession(sessionId, url)` / `removeSession(sessionId)` | Manage multi-session bullet list |
| `updateSessionActivity(sessionId, activity)` | Update per-session activity |
| `setSessionTitle(sessionId, title)` | Set session title (shown in bullet list and main status for single-session) |
| `toggleQr()` | Toggle QR code visibility |
| `refreshDisplay()` | Force re-render |
| `clearStatus()` | Clear all status lines and stop spinner |

**Options:**
- `verbose: boolean` — enables detailed log output (session IDs, banner metadata)
- `write?: (s: string) => void` — output function, defaults to `process.stdout.write`

### bridgeStatusUtil.ts

| Function | Signature | Description |
|----------|-----------|-------------|
| `buildBridgeConnectUrl` | `(environmentId: string, ingressUrl?: string) => string` | Builds `{base}/code?bridge={envId}` |
| `buildBridgeSessionUrl` | `(sessionId: string, environmentId: string, ingressUrl?: string) => string` | Builds per-session URL with `?bridge={envId}` query |
| `computeGlimmerIndex` | `(tick: number, messageWidth: number) => number` | Returns column position for shimmer animation |
| `computeShimmerSegments` | `(text: string, glimmerIndex: number) => { before, shimmer, after }` | Splits text into pre/shimmer/post segments |
| `getBridgeStatus` | `({ error, connected, sessionActive, reconnecting }) => BridgeStatusInfo` | Derives label + color from connection state |
| `wrapWithOsc8Link` | `(text: string, url: string) => string` | Wraps text in OSC 8 terminal hyperlink escape sequences |
| `timestamp` | `() => string` | Returns `HH:MM:SS` formatted current time |
| `buildIdleFooterText` | `(url: string) => string` | Footer for idle state |
| `buildActiveFooterText` | `(url: string) => string` | Footer for active state |

Re-exported from `src/utils/format.ts`: `formatDuration` and `truncatePrompt` (alias for `truncateToWidth`). See `src/bridge/bridgeStatusUtil.ts:6,31`.

### bridgePointer.ts

| Function | Signature | Description |
|----------|-----------|-------------|
| `writeBridgePointer` | `(dir: string, pointer: BridgePointer) => Promise<void>` | Write or refresh the pointer file (best-effort, never throws) |
| `readBridgePointer` | `(dir: string) => Promise<(BridgePointer & { ageMs }) \| null>` | Read + validate + staleness-check; auto-deletes bad/stale pointers |
| `readBridgePointerAcrossWorktrees` | `(dir: string) => Promise<{ pointer, dir } \| null>` | Worktree-aware read returning the freshest pointer and its source directory |
| `clearBridgePointer` | `(dir: string) => Promise<void>` | Delete the pointer file (idempotent) |
| `getBridgePointerPath` | `(dir: string) => string` | Returns the filesystem path for a directory's pointer file |

## Interface/Type Definitions

### `StatusState` (`src/bridge/bridgeStatusUtil.ts:10-15`)

```typescript
type StatusState = 'idle' | 'attached' | 'titled' | 'reconnecting' | 'failed'
```

The five states of the bridge UI state machine. `titled` is a sub-state of `attached` where the session's prompt title is displayed instead of "Connected".

### `BridgePointer` (`src/bridge/bridgePointer.ts:42-50`)

```typescript
type BridgePointer = {
  sessionId: string
  environmentId: string
  source: 'standalone' | 'repl'
}
```

Validated via Zod schema. The `source` field distinguishes standalone bridge invocations from REPL-spawned bridges.

### `BridgeStatusInfo` (`src/bridge/bridgeStatusUtil.ts:114-121`)

```typescript
type BridgeStatusInfo = {
  label: 'Remote Control failed' | 'Remote Control reconnecting' | 'Remote Control active' | 'Remote Control connecting…'
  color: 'error' | 'warning' | 'success'
}
```

Used by the React/Ink bridge component to determine status line rendering.

## Configuration & Defaults

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `TOOL_DISPLAY_EXPIRY_MS` | 30,000 ms | `src/bridge/bridgeStatusUtil.ts:18` | How long a tool activity line stays visible after the last `tool_start` event |
| `SHIMMER_INTERVAL_MS` | 150 ms | `src/bridge/bridgeStatusUtil.ts:21` | Tick interval for shimmer animation |
| `BRIDGE_POINTER_TTL_MS` | 4 hours | `src/bridge/bridgePointer.ts:40` | Max age for a crash-recovery pointer before it's considered stale |
| `MAX_WORKTREE_FANOUT` | 50 | `src/bridge/bridgePointer.ts:19` | Cap on parallel worktree pointer scans |
| `QR_OPTIONS` | `{ type: 'utf8', errorCorrectionLevel: 'L', small: true }` | `src/bridge/bridgeUI.ts:30-34` | QR code generation settings (compact, low error correction) |
| Connecting spinner interval | 150 ms | `src/bridge/bridgeUI.ts:176` | Spinner frame rotation speed |

## Edge Cases & Caveats

- **Branch hidden in worktree mode**: When `spawnMode === 'worktree'`, the branch name is intentionally omitted from the status suffix because each session gets its own branch (`src/bridge/bridgeUI.ts:220-221`).
- **Reconnecting/failed guards**: `renderStatusLine()` returns early for `reconnecting` and `failed` states to avoid clearing their dedicated displays. `setSessionTitle()` and `refreshDisplay()` also check these states before rendering (`src/bridge/bridgeUI.ts:189-194`, `509-510`, `526`).
- **ANT-only debug path**: When `USER_TYPE === 'ant'`, an extra line showing the debug log path is rendered above the status line (`src/bridge/bridgeUI.ts:224-228`).
- **Stale pointers auto-deleted**: `readBridgePointer()` silently deletes pointers that fail schema validation or exceed the 4-hour TTL, preventing stale resume prompts after the backend has GC'd the environment (`src/bridge/bridgePointer.ts:99-110`).
- **Best-effort pointer writes**: `writeBridgePointer()` catches and logs all errors — the crash-recovery mechanism must never itself cause a crash (`src/bridge/bridgePointer.ts:71-73`).
- **Worktree fanout cap**: If a repo has more than 50 worktrees, the fanout scan is skipped entirely and `--continue` falls back to current-directory-only lookup (`src/bridge/bridgePointer.ts:143-148`).
- **`countVisualLines` trailing newline handling**: A trailing `\n` does not count as an extra visual row because the cursor sits at the start of the next line rather than occupying a new row (`src/bridge/bridgeUI.ts:111-114`).
- **`updateSessionCount` deferred rendering**: This method only updates internal counters without calling `renderStatusLine()` — it relies on the next status tick to pick up the new values, avoiding redundant renders (`src/bridge/bridgeUI.ts:480-481`).