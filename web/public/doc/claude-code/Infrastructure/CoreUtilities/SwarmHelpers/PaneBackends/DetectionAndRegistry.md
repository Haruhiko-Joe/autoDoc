# Detection and Registry

## Overview & Responsibilities

This module provides the environment detection, backend selection, and configuration snapshotting layer for the swarm teammate system. It sits within **Infrastructure > CoreUtilities > SwarmHelpers > PaneBackends** and answers a single question at startup: *how should teammate agents be executed?*

The module comprises three files:

| File | Role |
|------|------|
| `detection.ts` | Probes the terminal environment (tmux, iTerm2) and caches results |
| `registry.ts` | Singleton registry that selects a backend via a priority-based fallback chain and exposes the `getTeammateExecutor()` entry point |
| `teammateModeSnapshot.ts` | Freezes the `teammateMode` config value at session startup so runtime changes cannot alter the current session |

Sibling modules — **InProcessExecution**, **TeamManagement**, **PermissionCoordination**, and **TeammateConfig** — consume these results to spawn teammates, manage the team file, and coordinate permissions.

## Key Processes

### Environment Detection (`detection.ts`)

Detection captures terminal state **at module load time** — before any other code can mutate environment variables:

1. `ORIGINAL_USER_TMUX` and `ORIGINAL_TMUX_PANE` are read from `process.env` at the top of the module (`detection.ts:10,19`). This is critical because `Shell.ts` later overrides `TMUX` when initializing Claude's own socket.
2. `isInsideTmux()` / `isInsideTmuxSync()` check `ORIGINAL_USER_TMUX`, returning a cached boolean. They deliberately avoid running `tmux display-message` — that command succeeds whenever *any* tmux server is running, even if the current process isn't inside tmux (`detection.ts:33-34`).
3. `isInITerm2()` checks three signals: `TERM_PROGRAM === 'iTerm.app'`, the presence of `ITERM_SESSION_ID`, and the `env.terminal` utility from `utils/env.ts` (`detection.ts:96-101`).
4. `isIt2CliAvailable()` validates the `it2` CLI by running `it2 session list` (not `--version`), because `--version` succeeds even when the iTerm2 Python API is disabled in preferences (`detection.ts:117-120`).
5. `isTmuxAvailable()` simply runs `tmux -V` to check if tmux is installed and in `PATH` (`detection.ts:73-76`).

All boolean results are cached for the process lifetime and can be cleared via `resetDetectionCache()` for testing.

### Backend Selection (`registry.ts`)

`detectAndGetBackend()` implements a priority-based fallback chain that returns a `BackendDetectionResult` containing the chosen `PaneBackend`, an `isNative` flag, and a `needsIt2Setup` hint:

```
Priority 1: Inside tmux?        → TmuxBackend (isNative=true)
Priority 2: In iTerm2?
  ├── User prefers tmux?         → skip iTerm2
  ├── it2 CLI available?         → ITermBackend (isNative=true)
  ├── tmux available?            → TmuxBackend (isNative=false, needsIt2Setup=true)
  └── neither available          → throw Error
Priority 3: tmux available?     → TmuxBackend (isNative=false)
Otherwise:                       → throw Error (with platform-specific install instructions)
```

> Source: `registry.ts:136-254`

The result is cached — once detected, the backend is fixed for the process lifetime (`registry.ts:26-31`).

### Lazy Backend Registration

Backend classes are registered lazily to break circular dependencies:

1. `TmuxBackend.ts` and `ITermBackend.ts` each call `registerTmuxBackend()` / `registerITermBackend()` at their own module level, passing their class constructor (`registry.ts:85-100`).
2. `ensureBackendsRegistered()` dynamically imports both modules when needed, without spawning subprocesses — useful for operations like killing a pane by stored `backendType` (`registry.ts:74-79`).
3. `createTmuxBackend()` and `createITermBackend()` instantiate via the registered constructors, throwing if registration hasn't happened yet (`registry.ts:106-126`).

### In-Process Mode Resolution

`isInProcessEnabled()` determines whether teammates should run in-process (within the leader's Node.js process) or in external panes:

| Condition | Result |
|-----------|--------|
| Non-interactive session (`-p` mode) | Always in-process |
| `teammateMode === 'in-process'` | In-process |
| `teammateMode === 'tmux'` | Pane backend |
| `teammateMode === 'auto'` + prior fallback recorded | In-process (sticky for session) |
| `teammateMode === 'auto'` + inside tmux or iTerm2 | Pane backend |
| `teammateMode === 'auto'` + no terminal detected | In-process |

> Source: `registry.ts:351-389`

The `inProcessFallbackActive` flag (`registry.ts:54`) makes fallback sticky within `auto` mode — once a spawn fails to find a pane backend, all subsequent spawns go in-process. This is scoped to `auto` mode only, so an explicit switch to `tmux` via settings still takes effect.

### `getTeammateExecutor()` Entry Point

This is the primary API consumers call to get a `TeammateExecutor`:

```typescript
export async function getTeammateExecutor(
  preferInProcess: boolean = false,
): Promise<TeammateExecutor>
```

- If `preferInProcess` is `true` and `isInProcessEnabled()` returns `true`, it returns a cached `InProcessBackend` singleton (`registry.ts:404-409`).
- Otherwise, it returns a cached `PaneBackendExecutor` wrapping the auto-detected pane backend (`registry.ts:442-451`).

Both paths are lazily created and cached for the process lifetime.

### Teammate Mode Snapshot (`teammateModeSnapshot.ts`)

The snapshot module freezes `teammateMode` at session startup to prevent runtime config edits from changing behavior mid-session:

1. **CLI override**: If `--teammate-mode` is passed, `setCliTeammateModeOverride()` is called before capture (`teammateModeSnapshot.ts:25-27`).
2. **Capture**: `captureTeammateModeSnapshot()` is called early in `main.tsx`. It reads from the CLI override first, falling back to `getGlobalConfig().teammateMode` (defaulting to `'auto'`) (`teammateModeSnapshot.ts:56-69`).
3. **Read**: `getTeammateModeFromSnapshot()` returns the captured value. If called before capture (a bug), it logs an error and performs a late capture as a safety net (`teammateModeSnapshot.ts:75-87`).
4. **UI override**: `clearCliTeammateModeOverride(newMode)` allows the user to change the mode via the UI during a session — it clears the CLI flag and updates the snapshot to the new value (`teammateModeSnapshot.ts:43-49`).

## Function Signatures

### `detection.ts`

| Function | Signature | Description |
|----------|-----------|-------------|
| `isInsideTmux()` | `() => Promise<boolean>` | Async, cached check for tmux environment |
| `isInsideTmuxSync()` | `() => boolean` | Sync variant, reads captured `TMUX` env var |
| `isInITerm2()` | `() => boolean` | Checks three iTerm2 indicators, cached |
| `getLeaderPaneId()` | `() => string \| null` | Returns `TMUX_PANE` captured at load time |
| `isTmuxAvailable()` | `() => Promise<boolean>` | Checks if `tmux` binary is in PATH |
| `isIt2CliAvailable()` | `() => Promise<boolean>` | Validates `it2` CLI and Python API connectivity |
| `resetDetectionCache()` | `() => void` | Clears cached results (testing only) |

### `registry.ts`

| Function | Signature | Description |
|----------|-----------|-------------|
| `detectAndGetBackend()` | `() => Promise<BackendDetectionResult>` | Runs the priority chain, returns and caches a backend |
| `getTeammateExecutor()` | `(preferInProcess?: boolean) => Promise<TeammateExecutor>` | Main entry point — returns in-process or pane executor |
| `isInProcessEnabled()` | `() => boolean` | Resolves whether in-process mode is active |
| `getResolvedTeammateMode()` | `() => 'in-process' \| 'tmux'` | Returns what `'auto'` resolves to |
| `ensureBackendsRegistered()` | `() => Promise<void>` | Dynamically imports backend modules without spawning processes |
| `registerTmuxBackend()` | `(cls: new () => PaneBackend) => void` | Registers TmuxBackend class (called by `TmuxBackend.ts`) |
| `registerITermBackend()` | `(cls: new () => PaneBackend) => void` | Registers ITermBackend class (called by `ITermBackend.ts`) |
| `getBackendByType()` | `(type: PaneBackendType) => PaneBackend` | Creates a backend by explicit type |
| `markInProcessFallback()` | `() => void` | Records that a spawn fell back to in-process |
| `resetBackendDetection()` | `() => void` | Full cache reset (testing only) |

### `teammateModeSnapshot.ts`

| Function | Signature | Description |
|----------|-----------|-------------|
| `captureTeammateModeSnapshot()` | `() => void` | Freezes `teammateMode` from config or CLI override |
| `getTeammateModeFromSnapshot()` | `() => TeammateMode` | Returns the frozen mode (`'auto' \| 'tmux' \| 'in-process'`) |
| `setCliTeammateModeOverride()` | `(mode: TeammateMode) => void` | Sets CLI `--teammate-mode` override before capture |
| `getCliTeammateModeOverride()` | `() => TeammateMode \| null` | Returns the current CLI override |
| `clearCliTeammateModeOverride()` | `(newMode: TeammateMode) => void` | Clears CLI override and updates snapshot (for UI changes) |

## Type Definitions

### `TeammateMode`

```typescript
type TeammateMode = 'auto' | 'tmux' | 'in-process'
```

Defined in `teammateModeSnapshot.ts:13`. Controls the backend selection strategy:
- **`auto`** (default): Let the registry detect the best backend from the environment
- **`tmux`**: Force pane-based execution via tmux
- **`in-process`**: Force in-process execution within the leader's Node.js process

### `BackendDetectionResult` (from `types.ts`)

Returned by `detectAndGetBackend()`, contains:
- `backend: PaneBackend` — the selected backend instance
- `isNative: boolean` — whether teammates appear in native panes (tmux inside tmux, or iTerm2 with it2)
- `needsIt2Setup: boolean` — signals the UI to prompt for it2 CLI installation

## Edge Cases & Caveats

- **`TMUX` env var mutation**: `Shell.ts` overrides `process.env.TMUX` when Claude's socket is initialized. Detection captures the original value at module load to avoid reading the overwritten value (`detection.ts:7-10`).

- **`tmux display-message` intentionally avoided**: Running `tmux display-message` would succeed if any tmux server exists on the system — even if the current process isn't inside tmux. The detection only trusts the `TMUX` env var (`detection.ts:33-34`).

- **`it2 --version` is not sufficient**: The `it2` CLI's `--version` flag succeeds even when the iTerm2 Python API is disabled in preferences, which would cause `session split` to silently fail later. Detection uses `it2 session list` instead (`detection.ts:115-116`).

- **Sticky in-process fallback**: In `auto` mode, if a pane backend spawn fails and `markInProcessFallback()` is called, all subsequent spawns go in-process for the rest of the session. This is scoped to `auto` mode only — switching to explicit `tmux` mode still takes effect (`registry.ts:369-377`).

- **Late snapshot capture**: If `getTeammateModeFromSnapshot()` is called before `captureTeammateModeSnapshot()`, it logs an error (this is an initialization bug) but recovers by performing a late capture (`teammateModeSnapshot.ts:76-84`).

- **User tmux preference**: If a user previously chose to prefer tmux over iTerm2 (via `getPreferTmuxOverIterm2()`), the registry skips iTerm2 detection entirely and won't re-prompt for it2 setup (`registry.ts:176-179, 219`).

- **Non-interactive sessions**: The `-p` (pipe) mode forces in-process execution since tmux panes don't make sense without a terminal UI (`registry.ts:353-359`).