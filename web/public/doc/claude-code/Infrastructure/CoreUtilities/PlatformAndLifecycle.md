# Platform and Lifecycle

## Overview & Responsibilities

This module is part of **Infrastructure → CoreUtilities** and provides the foundational platform detection, process management, error handling, logging, and lifecycle orchestration that every other module in the codebase depends on. It answers three key questions:

1. **Where are we running?** — OS detection, WSL version, Linux distro info, VCS detection, terminal capabilities
2. **How do we handle problems?** — Structured error classes, error logging with sink-based architecture, warning suppression
3. **How do we shut down cleanly?** — Signal handling, cleanup registry, graceful shutdown with failsafe timers, terminal mode restoration, and auto-updates with semver comparison

Sibling modules under CoreUtilities include telemetry/observability, CLAUDE.md parsing, data format handling, async patterns, file utilities, and domain-specific helpers.

---

## Key Files at a Glance

| File | Purpose |
|------|---------|
| `platform.ts` | OS detection, WSL version, Linux distro info, VCS detection |
| `process.ts` | EPIPE handling, stdout/stderr writers, stdin peek |
| `terminal.ts` | ANSI-aware text wrapping and truncation for terminal display |
| `errors.ts` | Error class hierarchy, abort detection, errno helpers, axios error classification |
| `log.ts` | Error logging with sink pattern, in-memory error buffer, session/MCP log management |
| `warningHandler.ts` | Node.js `process.on('warning')` handler with analytics and suppression |
| `context.ts` | Model context window calculation and output token limits |
| `cwd.ts` | Working directory tracking with `AsyncLocalStorage` for concurrent agents |
| `cleanup.ts` | Time-based file cleanup for logs, sessions, plans, debug files, npm cache |
| `cleanupRegistry.ts` | Global registry of cleanup functions for shutdown |
| `gracefulShutdown.ts` | Orchestrated shutdown: terminal restore, cleanup, hooks, analytics flush |
| `signal.ts` | Lightweight pub/sub signal primitive (`createSignal`) |
| `autoUpdater.ts` | Version checking, npm/GCS update installation, lock-based concurrency |
| `semver.ts` | Semver comparison with Bun.semver fast path and npm semver fallback |

---

## Platform Detection (`platform.ts`)

### OS Detection

`getPlatform()` returns one of `'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'`. The result is memoized. WSL detection reads `/proc/version` and checks for "microsoft" or "wsl" strings.

```ts
// src/utils/platform.ts:11-49
export const getPlatform = memoize((): Platform => {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'linux') {
    // reads /proc/version for WSL markers
    ...
  }
})
```

Only `'macos'` and `'wsl'` are in the `SUPPORTED_PLATFORMS` array.

### WSL Version Detection

`getWslVersion()` (`src/utils/platform.ts:51-79`) parses `/proc/version` for explicit WSL version markers like `WSL2`. Falls back to `'1'` if only "microsoft" is found.

### Linux Distro Info

`getLinuxDistroInfo()` (`src/utils/platform.ts:87-116`) is async and returns `{ linuxDistroId, linuxDistroVersion, linuxKernel }` by parsing `/etc/os-release` and calling `os.release()`.

### VCS Detection

`detectVcs(dir?)` (`src/utils/platform.ts:129-150`) scans a directory for version control markers (`.git`, `.hg`, `.svn`, `.p4config`, `.jj`, `.sl`, etc.) and also checks the `P4PORT` environment variable for Perforce.

---

## Process Management (`process.ts`)

### EPIPE Handling

`registerProcessOutputErrorHandlers()` (`src/utils/process.ts:12-15`) attaches error listeners to `stdout` and `stderr` that silently destroy the stream on `EPIPE`. This prevents crashes when output is piped to a short-lived consumer (e.g., `claude -p | head -1`).

### Safe Output Writers

`writeToStdout(data)` and `writeToStderr(data)` (`src/utils/process.ts:28-34`) skip writes if the stream is already destroyed. Backpressure is not currently handled.

### Exit Helper

`exitWithError(message)` (`src/utils/process.ts:38-43`) writes to stderr and exits with code 1. Typed as `never`.

### Stdin Peek

`peekForStdinData(stream, ms)` (`src/utils/process.ts:50-68`) races a timeout against `data`/`end` events on a stream. Returns `true` on timeout (no data arrived), `false` if the stream ended. Used in `-p` mode to distinguish a real pipe producer from an inherited-but-idle parent stdin.

---

## Terminal Display (`terminal.ts`)

### Text Truncation

`renderTruncatedContent(content, terminalWidth, suppressExpandHint?)` (`src/utils/terminal.ts:71-113`) wraps text at terminal width using ANSI-aware slicing, then truncates to 3 visible lines. Excess lines show a `"… +N lines (ctrl+o to expand)"` hint. An optimization caps the input to `MAX_LINES_TO_SHOW * wrapWidth * 4` characters to avoid O(n) wrapping on huge outputs.

`isOutputLineTruncated(content)` (`src/utils/terminal.ts:119-131`) is a fast check that counts raw newlines without performing terminal-width wrapping.

---

## Error Classes and Utilities (`errors.ts`)

### Error Hierarchy

| Class | Purpose |
|-------|---------|
| `ClaudeError` | Base error with auto-set `this.name` |
| `MalformedCommandError` | Invalid slash command syntax |
| `AbortError` | User/system abort; `isAbortError(e)` checks all abort variants including SDK's `APIUserAbortError` |
| `ConfigParseError` | Config file parse failure; carries `filePath` and `defaultConfig` |
| `ShellError` | Shell command failure; carries `stdout`, `stderr`, `code`, `interrupted` |
| `TeleportOperationError` | Teleport failures with a formatted display message |
| `TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` | Error safe to send to telemetry; optional separate `telemetryMessage` |

### Utility Functions

- **`toError(e)`** — normalizes unknown values to `Error` instances (`src/utils/errors.ts:111-113`)
- **`errorMessage(e)`** — extracts message string from unknown values (`src/utils/errors.ts:119-121`)
- **`getErrnoCode(e)`** / **`isENOENT(e)`** — safe errno code extraction without casting (`src/utils/errors.ts:128-141`)
- **`getErrnoPath(e)`** — extracts the filesystem path from errno errors (`src/utils/errors.ts:148-153`)
- **`isFsInaccessible(e)`** — returns true for ENOENT, EACCES, EPERM, ENOTDIR, ELOOP (`src/utils/errors.ts:186-195`)
- **`shortErrorStack(e, maxFrames?)`** — truncates stack traces to N frames for model context (`src/utils/errors.ts:161-171`)
- **`classifyAxiosError(e)`** — categorizes axios errors into `'auth' | 'timeout' | 'network' | 'http' | 'other'` with status code (`src/utils/errors.ts:213-238`)

---

## Logging Infrastructure (`log.ts`)

### Sink-Based Architecture

Logging uses a deferred-attachment pattern. Errors logged before the sink is attached are queued and drained when `attachErrorLogSink(sink)` is called during startup (`src/utils/log.ts:109-134`). The `ErrorLogSink` interface defines three methods: `logError`, `logMCPError`, and `logMCPDebug`.

### `logError(error)`

The primary error logging function (`src/utils/log.ts:158-199`):

1. Converts to `Error` via `toError()`
2. In `--hard-fail` mode (build-time feature flag), crashes immediately
3. Skips logging for Bedrock/Vertex/Foundry providers, when `DISABLE_ERROR_REPORTING` is set, or when in essential-traffic-only mode
4. Always appends to an in-memory ring buffer (capped at 100 entries)
5. Forwards to the sink, or queues if sink not yet attached

### MCP Logging

`logMCPError(serverName, error)` and `logMCPDebug(serverName, message)` follow the same queue-or-forward pattern (`src/utils/log.ts:300-326`).

### Session Log Management

`loadErrorLogs()` and `getErrorLogByIndex(index)` read persisted error logs from the cache directory. `captureAPIRequest(params, querySource)` stores the last API request (without messages) for bug reports (`src/utils/log.ts:331-352`).

---

## Warning Handler (`warningHandler.ts`)

`initializeWarningHandler()` (`src/utils/warningHandler.ts:60-121`) installs a single `process.on('warning')` listener that:

1. **Suppresses all warnings from user-facing output** — warnings are hidden from end users
2. **Logs to analytics** — every warning is sent to Statsig with class name and occurrence count
3. **Shows in debug mode** — warnings appear when `CLAUDE_DEBUG` is set
4. **Tracks occurrences** — bounded `Map` (max 1000 keys) prevents memory growth
5. **Strips default handler** — for non-development builds, removes Node.js's default warning listener to prevent stderr output

Known internal warnings (e.g., `MaxListenersExceededWarning` for `AbortSignal`) are tagged as internal in analytics.

---

## Working Directory Tracking (`cwd.ts`)

Uses `AsyncLocalStorage` to provide per-async-context working directory overrides (`src/utils/cwd.ts:4`).

- **`runWithCwdOverride(cwd, fn)`** — runs `fn` (and all its async descendants) with a custom working directory
- **`pwd()`** — returns the override if in an async context, otherwise the global CWD state
- **`getCwd()`** — like `pwd()` but falls back to `getOriginalCwd()` on error

This enables concurrent agents to each see their own working directory without mutex contention.

---

## Context Utilities (`context.ts`)

Manages model context window sizes and output token limits.

### Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `MODEL_CONTEXT_WINDOW_DEFAULT` | 200,000 | Default context window |
| `COMPACT_MAX_OUTPUT_TOKENS` | 20,000 | Max output for compact operations |
| `CAPPED_DEFAULT_MAX_TOKENS` | 8,000 | Slot-reservation optimization cap |
| `ESCALATED_MAX_TOKENS` | 64,000 | Retry budget after hitting cap |

### `getContextWindowForModel(model, betas?)`

Resolution priority (`src/utils/context.ts:51-98`):
1. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` env var (ant-only override)
2. `[1m]` suffix in model name → 1,000,000
3. Model capability `max_input_tokens` from registry
4. Beta header for 1M context
5. Sonnet 1M experiment treatment
6. Ant-specific model config
7. Default: 200,000

### `getModelMaxOutputTokens(model)`

Returns `{ default, upperLimit }` based on model family (`src/utils/context.ts:149-210`). Opus 4.6 gets 64K default / 128K upper limit; Sonnet 4.6 gets 32K / 128K; older models get progressively lower limits.

---

## File Cleanup (`cleanup.ts`)

Time-based cleanup of old files, governed by `settings.cleanupPeriodDays` (default: 30 days).

### `cleanupOldMessageFilesInBackground()`

The main entry point (`src/utils/cleanup.ts:575-602`) orchestrates all cleanup tasks sequentially:

1. Error logs and MCP logs
2. Session files (`.jsonl`, `.cast`, tool results)
3. Plan files (`.md`)
4. File history backups
5. Session environment directories
6. Debug logs (preserves `latest` symlink)
7. Image caches and paste files
8. Stale agent worktrees
9. npm cache for `@anthropic-ai` packages (ant-only, once per day, lock-guarded)

If `cleanupPeriodDays` was explicitly set but settings have validation errors, cleanup is skipped entirely to prevent accidental deletion.

### Throttled Version Cleanup

`cleanupOldVersionsThrottled()` (`src/utils/cleanup.ts:543-573`) uses a marker file + lockfile to ensure old version cleanup runs at most once per 24 hours across processes.

---

## Cleanup Registry (`cleanupRegistry.ts`)

A minimal global `Set<() => Promise<void>>` that decouples cleanup registration from the shutdown orchestrator to avoid circular dependencies.

```ts
// src/utils/cleanupRegistry.ts:14-17
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn)
}
```

`runCleanupFunctions()` runs all registered functions concurrently via `Promise.all`.

---

## Graceful Shutdown (`gracefulShutdown.ts`)

### Signal Setup

`setupGracefulShutdown()` (memoized, `src/utils/gracefulShutdown.ts:237-334`) registers:

- **SIGINT** — calls `gracefulShutdown(0)` (skipped in print mode, which has its own handler)
- **SIGTERM** — calls `gracefulShutdown(143)` (128 + 15)
- **SIGHUP** — calls `gracefulShutdown(129)` (128 + 1), non-Windows only
- **Orphan detection** — 30s interval checking `process.stdout.writable` and `process.stdin.readable` for macOS TTY revocation
- **`uncaughtException`** / **`unhandledRejection`** — logged to diagnostics and analytics
- **signal-exit pin** — registers a no-op `onExit` callback to work around a Bun bug where `process.removeListener(sig, fn)` nukes kernel signal handlers

### Shutdown Orchestration

`gracefulShutdown(exitCode, reason, options?)` (`src/utils/gracefulShutdown.ts:391-523`) executes this sequence:

1. **Guard against re-entry** via `shutdownInProgress` flag
2. **Arm failsafe timer** — `max(5s, SessionEnd hook budget + 3.5s)`, calls `forceExit` if cleanup hangs
3. **Restore terminal** — `cleanupTerminalModes()` sends disable sequences (mouse tracking, Kitty keyboard, focus events, bracketed paste, alt screen, cursor visibility, iTerm2 progress, tab status, terminal title) synchronously via `writeSync`
4. **Print resume hint** — shows `claude --resume <id>` for interactive sessions
5. **Run cleanup functions** — from the cleanup registry, with a 2s timeout
6. **Execute SessionEnd hooks** — respects `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`
7. **Log startup profile** — performance report
8. **Send cache eviction hint** — analytics event for inference cache
9. **Flush analytics** — 500ms cap for 1P event logging and Datadog
10. **Force exit** — `forceExit()` calls `process.exit()`, falls back to `SIGKILL` on EIO

### `forceExit(exitCode)`

Handles the edge case where `process.exit()` throws EIO when the terminal is already gone (e.g., SSH disconnect). Falls back to `process.kill(process.pid, 'SIGKILL')` (`src/utils/gracefulShutdown.ts:193-232`).

---

## Signal Primitive (`signal.ts`)

A lightweight pub/sub utility for event-only signals (no stored state):

```ts
// src/utils/signal.ts:27-43
export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) { ... },  // returns unsubscribe function
    emit(...args) { ... },
    clear() { ... },
  }
}
```

Replaces the ~8-line `new Set(); subscribe(); notify()` pattern that was duplicated ~15 times across the codebase. Distinct from stores (no `getState()`).

---

## Auto-Updater (`autoUpdater.ts`)

### Version Enforcement

- **`assertMinVersion()`** (`src/utils/autoUpdater.ts:70-99`) — fetches `tengu_version_config` from Statsig; if the current version is below `minVersion`, prints an error and calls `gracefulShutdownSync(1)`
- **`getMaxVersion()`** / **`getMaxVersionMessage()`** — server-side kill switch to cap the allowed version during incidents
- **`shouldSkipVersion(targetVersion)`** — respects `settings.minimumVersion` to prevent downgrades when switching to the stable channel

### Update Installation

`installGlobalPackage(specificVersion?)` (`src/utils/autoUpdater.ts:456-533`):

1. Acquires a file lock (O_EXCL atomic creation, 5-minute stale timeout with TOCTOU re-check)
2. Removes old shell aliases from config files
3. Checks for Windows npm in WSL (unsupported)
4. Verifies write permissions on the global npm prefix
5. Runs `npm install -g` or `bun install -g`
6. Records `installMethod: 'global'` in config
7. Always releases the lock in `finally`

### Version Sources

| Function | Source | Timeout |
|----------|--------|---------|
| `getLatestVersion(channel)` | `npm view` | 5s |
| `getNpmDistTags()` | `npm view dist-tags --json` | 5s |
| `getLatestVersionFromGcs(channel)` | GCS bucket HTTP | 5s |
| `getVersionHistory(limit)` | `npm view versions --json` | 30s |

All `npm` commands run from `homedir()` to avoid reading potentially malicious project-level `.npmrc` files.

---

## Semver Comparison (`semver.ts`)

Provides `gt`, `gte`, `lt`, `lte`, `satisfies`, and `order` functions (`src/utils/semver.ts:19-59`).

**Fast path**: When running under Bun, uses `Bun.semver.order()` which is ~20x faster than the npm `semver` package.

**Fallback**: Lazy-loads the `semver` npm package via `require()` and uses `{ loose: true }` for all comparisons. The lazy load avoids paying the import cost when Bun's built-in is available.

Build metadata (the `+SHA` part in `X.X.X+SHA` versions) is ignored per SemVer spec for version comparison, but exact string comparison is used in the update flow to detect any change including SHA.

---

## Edge Cases & Caveats

- **Orphan detection interval** (`gracefulShutdown.ts:282-296`): On macOS, closing a terminal revokes TTY file descriptors instead of delivering SIGHUP. A 30s `setInterval` checks `process.stdout.writable` as a fallback. The interval is `.unref()`'d to not keep the process alive.
- **Failsafe timer budget** (`gracefulShutdown.ts:417-426`): Scales with SessionEnd hook timeout to avoid silently truncating user-configured hooks. Minimum 5s.
- **Signal-exit Bun workaround** (`gracefulShutdown.ts:237-254`): A pinned no-op `onExit` callback prevents signal-exit v4 from calling `removeListener` which triggers a Bun bug that resets kernel signal handlers.
- **Lock TOCTOU mitigation** (`autoUpdater.ts:190-198`): The update lock re-checks staleness immediately before unlinking to close a race between two processes observing the same stale lock.
- **Warning handler memory bound** (`warningHandler.ts:86-91`): The warning occurrence tracker is capped at 1000 unique keys. Beyond that, new unique warnings always report `occurrence_count: 1`.
- **Error sink queue** (`log.ts:96-133`): Errors logged before `attachErrorLogSink()` is called are queued and drained immediately upon attachment, ensuring no errors are lost during startup.