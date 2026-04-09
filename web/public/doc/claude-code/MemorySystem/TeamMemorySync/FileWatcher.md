# FileWatcher

## Overview & Responsibilities

The FileWatcher module (`src/services/teamMemorySync/watcher.ts`) is the filesystem observation layer of the **TeamMemorySync** subsystem within the broader **MemorySystem**. Its job is to detect when team memory files change on disk and push those changes to the server, ensuring that shared memories propagate across team members' sessions.

It sits alongside its siblings in the TeamMemorySync group: the sync protocol (`index.ts`) handles the actual pull/push logic and delta uploads, while the FileWatcher orchestrates *when* pushes happen. Upstream, **TeamMemoryPaths** provides path resolution and security validation; downstream, the watcher feeds into the push/pull API exposed by the sync module.

Key responsibilities:
- **Startup orchestration**: Pull server state on boot, then unconditionally start watching — even for empty repos — to avoid a bootstrap dead zone where fresh repos never sync.
- **Change detection**: Monitor the team memory directory via `fs.watch({ recursive: true })` for O(1) file descriptor usage (FSEvents on macOS, inotify on Linux).
- **Debounced push scheduling**: Coalesce rapid writes into a single push after a 2-second quiet period.
- **Permanent failure suppression**: After a non-recoverable push failure (e.g., missing OAuth, HTTP 4xx), stop retrying to prevent runaway retry loops. Suppression clears on file deletion (recovery action) or session restart.
- **Graceful shutdown**: Flush any pending changes before the process exits.
- **Explicit push hook**: Expose `notifyTeamMemoryWrite()` so PostToolUse hooks can trigger a push even if `fs.watch` misses the write event.

## Key Processes

### Startup Sequence (`startTeamMemoryWatcher`)

1. **Gate checks** — Returns early if any precondition fails: `TEAMMEM` build flag off, team memory disabled, OAuth unavailable, or no `github.com` remote (`watcher.ts:252-266`). The GitHub check prevents a noisy failure mode where every push logs `no_repo` forever.
2. **Create sync state** — Initializes a shared `SyncState` object used across all sync operations (`watcher.ts:268`).
3. **Initial pull** — Calls `pullTeamMemory()` to fetch server content *before* the watcher starts, so downloaded files don't trigger spurious push events (`watcher.ts:275-291`).
4. **Start watcher** — Calls `startFileWatcher()` unconditionally. Even if the server had no content (fresh repo), the watcher must be active so that Claude's first write gets detected (`watcher.ts:296`).
5. **Analytics event** — Logs `tengu_team_mem_sync_started` with pull results (`watcher.ts:298-304`).

### File Change → Push Flow

1. **`fs.watch` callback fires** — Any file event (add, change, rename, delete) triggers the callback (`watcher.ts:182-207`).
2. **Suppression check** — If `pushSuppressedReason` is set, the event is ignored *unless* the file was deleted (detected via `stat()` returning `ENOENT`), which clears suppression and allows the push to proceed (`watcher.ts:187-204`).
3. **`schedulePush()`** — Sets `hasPendingChanges = true`, resets the 2-second debounce timer (`watcher.ts:132-145`).
4. **Debounce fires** — After 2 seconds of quiet, checks if a push is already in flight. If so, re-arms the debounce; otherwise calls `executePush()` (`watcher.ts:138-144`).
5. **`executePush()`** — Calls `pushTeamMemory()`, sets `pushInProgress` for in-flight deduplication. On success, clears `hasPendingChanges`. On permanent failure, sets `pushSuppressedReason` to prevent further retries and logs an analytics event (`watcher.ts:84-127`).

### Shutdown Flow (`stopTeamMemoryWatcher`)

1. Cancel the debounce timer (`watcher.ts:328-331`).
2. Close the `fs.watch` handle (`watcher.ts:332-335`).
3. Await any in-flight push (`watcher.ts:337-343`).
4. If there are still pending unsent changes (and push isn't suppressed), perform a best-effort final push (`watcher.ts:345-351`). This runs within the 2-second graceful shutdown budget.

### Explicit Notification (`notifyTeamMemoryWrite`)

PostToolUse hooks call `notifyTeamMemoryWrite()` after writing team memory files. This explicitly calls `schedulePush()` as a safety net — `fs.watch` can miss writes that happen in the same tick as watcher startup, or when the platform coalesces rapid events (`watcher.ts:314-319`).

## Function Signatures

### `startTeamMemoryWatcher(): Promise<void>`
Main entry point. Performs gate checks, initial pull, and starts the filesystem watcher. Called once during application startup.

### `notifyTeamMemoryWrite(): Promise<void>`
Explicitly schedules a push. No-op if sync state hasn't been initialized (watcher not started). Called by PostToolUse hooks after team memory file writes.

### `stopTeamMemoryWatcher(): Promise<void>`
Stops the watcher, awaits in-flight pushes, and flushes pending changes. Registered as a cleanup handler via `registerCleanup()`.

### `isPermanentFailure(r: TeamMemorySyncPushResult): boolean`
Determines if a push result represents a non-recoverable error. Returns `true` for:
- `no_oauth` or `no_repo` error types (client-side pre-request checks)
- HTTP 4xx status codes, **except** 409 (transient conflict) and 429 (rate limit)

## Configuration & Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `DEBOUNCE_MS` | `2000` | Milliseconds to wait after the last filesystem change before triggering a push |

**Build flag**: `feature('TEAMMEM')` must be enabled for the watcher to start.

**Runtime prerequisites**: Team memory must be enabled (`isTeamMemoryEnabled()`), OAuth must be available (`isTeamMemorySyncAvailable()`), and the repo must have a `github.com` remote.

## Edge Cases & Caveats

- **Bootstrap dead zone avoidance**: The watcher starts even when the server has no content. Without this, a fresh repo would depend entirely on `notifyTeamMemoryWrite` hook calls, which fire infrequently enough that a new team member could wait days before their first sync.

- **Permanent failure suppression**: After a permanent push failure, the module suppresses all future pushes for the session to prevent runaway retries. This was introduced after an incident (BQ Mar 14-16) where a device without OAuth emitted 167K push events over 2.5 days (`watcher.ts:46-51`). Suppression clears only on file unlink (for the too-many-entries recovery path) or session restart.

- **`fs.watch` vs chokidar**: The module explicitly avoids chokidar because chokidar 4+ dropped `fsevents` support. Under Bun, the fallback uses kqueue which opens one fd per watched file — 500+ team memory files means 500+ permanently-held fds. `fs.watch({ recursive: true })` uses FSEvents on macOS (O(1) fds) and inotify on Linux (O(subdirs) fds) (`watcher.ts:150-159`).

- **Unlink detection via `stat()`**: Since `fs.watch` emits `rename` for adds, changes, *and* deletes, the module calls `stat()` on the filename. An `ENOENT` error means the file was deleted, which is used to clear push suppression (`watcher.ts:191-203`).

- **In-flight deduplication**: If a push is already running when the debounce timer fires, the module re-arms the debounce instead of starting a concurrent push (`watcher.ts:139-141`).

- **Race on startup**: If the directory is deleted between `mkdir` and `watch`, `fs.watch` throws synchronously. The module catches this and continues — `notifyTeamMemoryWrite()` still works via explicit `schedulePush()` calls (`watcher.ts:218-226`).

- **Shutdown budget**: The final flush during `stopTeamMemoryWatcher()` is best-effort. It runs within the 2-second graceful shutdown window; if the HTTP PUT doesn't complete in time, `process.exit()` kills it (`watcher.ts:325-326`).

## Key Code Snippets

### Debounce with in-flight deduplication

```typescript
// watcher.ts:132-145
function schedulePush(): void {
  if (pushSuppressedReason !== null) return
  hasPendingChanges = true
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    if (pushInProgress) {
      schedulePush()
      return
    }
    currentPushPromise = executePush()
  }, DEBOUNCE_MS)
}
```

### Suppression clearance on file unlink

```typescript
// watcher.ts:187-204
if (pushSuppressedReason !== null) {
  void stat(join(teamDir, filename)).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') return
      if (pushSuppressedReason !== null) {
        logForDebugging(
          `team-memory-watcher: unlink cleared suppression (was: ${pushSuppressedReason})`,
          { level: 'info' },
        )
        pushSuppressedReason = null
      }
      schedulePush()
    },
  )
  return
}
```