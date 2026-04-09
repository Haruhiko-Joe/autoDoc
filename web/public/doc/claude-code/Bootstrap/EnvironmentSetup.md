# Environment Setup

## Overview & Responsibilities

The `setup()` function in `src/setup.ts` is the second phase of the Claude Code bootstrap sequence, executing after `init()` and before the REPL or headless session begins. It transforms a raw CLI process into a fully configured runtime environment by performing environment validation, session configuration, terminal restoration, worktree management, and background service initialization.

Within the **Bootstrap** module hierarchy, this function bridges the gap between low-level CLI parsing/initialization (handled by `init()`) and the interactive session layer (the Ink-based REPL or headless print mode). Sibling modules in the Bootstrap group handle CLI argument parsing, telemetry setup, and authentication bootstrapping, while `setup()` specifically owns the runtime environment preparation.

## Function Signature

```typescript
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void>
```

> Source: `src/setup.ts:56-66`

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `cwd` | `string` | The working directory to use for the session |
| `permissionMode` | `PermissionMode` | Current permission mode (e.g., `'bypassPermissions'`) |
| `allowDangerouslySkipPermissions` | `boolean` | Whether `--dangerously-skip-permissions` was passed |
| `worktreeEnabled` | `boolean` | Whether `--worktree` flag was passed |
| `worktreeName` | `string \| undefined` | Optional custom worktree name |
| `tmuxEnabled` | `boolean` | Whether `--tmux` flag was passed |
| `customSessionId` | `string \| null` | Optional custom session ID override |
| `worktreePRNumber` | `number` | Optional PR number for PR-based worktrees |
| `messagingSocketPath` | `string` | Optional explicit UDS socket path for messaging |

## Key Process Walkthrough

The `setup()` function executes a carefully ordered sequence of initialization steps. The ordering is significant — comments in the source explicitly note dependencies between steps.

### 1. Node.js Version Validation (`src/setup.ts:70-79`)

Parses `process.version` and exits with an error if the major version is below 18. This is the earliest guard — no other setup runs if the runtime is unsupported.

### 2. Custom Session ID (`src/setup.ts:82-84`)

If `customSessionId` is provided, calls `switchSession()` to override the auto-generated session ID. This supports session resumption and remote-controlled sessions.

### 3. UDS Messaging Server (`src/setup.ts:89-102`)

Starts a Unix Domain Socket (UDS) messaging server for inter-process communication, gated behind the `UDS_INBOX` feature flag. This is **skipped in bare mode** unless an explicit `--messaging-socket-path` is provided (escape hatch per gate pattern #23222). The server is `await`-ed so that `$CLAUDE_CODE_MESSAGING_SOCKET` is exported before any hooks (especially `SessionStart`) can spawn and snapshot `process.env`.

### 4. Teammate Mode Snapshot (`src/setup.ts:105-110`)

In non-bare mode with agent swarms enabled, captures a snapshot of teammate mode configuration. This supports the multi-agent coordination system. Unlike the UDS server, there is no escape hatch — swarms are never used in bare mode.

### 5. Terminal Backup Restoration (`src/setup.ts:115-158`)

For interactive sessions only (not print/headless mode), checks for and restores interrupted terminal configurations:

- **iTerm2**: Only when agent swarms are enabled. Restores via `defaults import com.googlecode.iterm2`.
- **Terminal.app**: Always checked. Restores via `defaults import com.apple.Terminal`. Wrapped in try/catch to prevent crashes from blocking startup.

Both paths report restoration status to the user with colored console output.

### 6. Set Working Directory (`src/setup.ts:161`)

Calls `setCwd(cwd)` — this **must** happen before any code that depends on the current working directory. Subsequent steps (hooks, git detection, worktree creation) all rely on this being set.

### 7. Hooks Configuration Snapshot (`src/setup.ts:165-169`)

Captures the current hooks configuration as a baseline snapshot. This is used later to detect if hooks were modified during a session (a security measure against hidden hook modifications). **Must** run after `setCwd()` so hooks are loaded from the correct directory.

### 8. File Changed Watcher (`src/setup.ts:172`)

Initializes a synchronous file-change watcher that reads the hook config snapshot. This enables the `FileChanged` hook to fire when monitored files are modified during the session.

### 9. Git Worktree Creation (`src/setup.ts:176-285`)

The most complex section, executed only when `worktreeEnabled` is `true`:

1. **Validates prerequisites**: Checks for either a git repository or a `WorktreeCreate` hook (for non-git VCS). Exits if neither exists.
2. **Generates slug**: From PR number (`pr-{N}`), explicit name, or plan slug.
3. **Resolves canonical git root**: Uses `findCanonicalGitRoot()` to handle being invoked from within an existing worktree — switches to the main repo root if needed.
4. **Generates tmux session name**: If `--tmux` is enabled, derives a name from the repo root and branch.
5. **Creates the worktree**: Calls `createWorktreeForSession()` with the session ID, slug, and optional PR number.
6. **Creates tmux session**: If enabled, creates a tmux session attached to the worktree path and prints attach instructions.
7. **Updates environment**: Changes `process.cwd`, sets `originalCwd`, `projectRoot`, saves worktree state, clears memory file caches, and re-captures the hooks config snapshot from the new worktree directory.

### 10. Background Service Initialization (`src/setup.ts:288-304`)

Non-bare mode services initialized synchronously:
- **Session memory**: `initSessionMemory()` — registers a hook; gate check is lazy.
- **Context collapse**: Conditionally initialized behind the `CONTEXT_COLLAPSE` feature flag.
- **Version lock**: `lockCurrentVersion()` prevents deletion by other processes (runs in all modes).

### 11. Prefetch Phase (`src/setup.ts:306-381`)

Fires off several background prefetch operations to ensure data is ready before first render:

- **Commands**: `getCommands()` prefetches the command registry (skipped in bare mode and during sync plugin install).
- **Plugin hooks**: Loads and sets up hot-reload for plugin hooks.
- **Repo classification**: For Anthropic employees (`USER_TYPE=ant`), primes the repo classification cache for auto-undercover mode.
- **Attribution hooks**: Deferred to next tick via `setImmediate()` so the git subprocess spawns after first render.
- **Session file access hooks**: Registers analytics hooks for file access tracking.
- **Team memory watcher**: Behind `TEAMMEM` feature flag, starts the team memory sync watcher.
- **Analytics sinks**: `initSinks()` attaches error log and analytics sinks and drains any queued events.
- **`tengu_started` event**: Emitted immediately after analytics sink attachment — serves as the session-success-rate denominator and earliest "process started" signal for release health monitoring.
- **API key prefetch**: `prefetchApiKeyFromApiKeyHelperIfSafe()` — only executes if trust is already confirmed.
- **Release notes**: Awaited check for new release notes; if present, also awaits `getRecentActivity()` for Logo v2 display.

### 12. Permission Bypass Validation (`src/setup.ts:396-442`)

When `permissionMode === 'bypassPermissions'` or `--dangerously-skip-permissions` is set:

1. **Root/sudo check**: On Unix systems, blocks usage as root unless in a sandbox (`IS_SANDBOX=1` or bubblewrap).
2. **Anthropic employee sandbox check**: For `USER_TYPE=ant` (excluding `local-agent` and `claude-desktop` entrypoints), verifies the process is running in Docker/bubblewrap/sandbox **without** internet access. Exits if either condition fails.

### 13. Previous Session Metrics Logging (`src/setup.ts:449-476`)

If the project config contains `lastCost` and `lastDuration` from a previous session, emits a `tengu_exit` analytics event with comprehensive metrics (cost, duration, token counts, FPS stats, line changes). Values are intentionally **not** cleared after logging — they're needed for cost restoration when resuming sessions.

## Configuration & Environment Variables

| Variable / Config | Purpose |
|-------------------|---------|
| `NODE_ENV=test` | Short-circuits setup after permission validation (`src/setup.ts:444-446`) |
| `USER_TYPE=ant` | Enables Anthropic-employee-specific paths (repo classification, sandbox enforcement) |
| `IS_SANDBOX=1` | Marks environment as sandboxed, relaxing root/bypass restrictions |
| `CLAUDE_CODE_BUBBLEWRAP` | Truthy value indicates bubblewrap sandbox |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | Skips plugin prefetch to avoid race conditions with sync install |
| `CLAUDE_CODE_ENTRYPOINT` | When `local-agent` or `claude-desktop`, relaxes sandbox enforcement for bypass mode |

## Feature Flags

The function gates several capabilities behind feature flags (via `bun:bundle`):

| Flag | Controls |
|------|----------|
| `UDS_INBOX` | UDS messaging server startup |
| `CONTEXT_COLLAPSE` | Context collapse service initialization |
| `COMMIT_ATTRIBUTION` | Git commit attribution hook registration |
| `TEAMMEM` | Team memory sync watcher |

## Edge Cases & Caveats

- **Ordering dependencies are critical**: `setCwd()` must precede hooks snapshot capture; hooks snapshot must precede worktree creation (which re-captures it); the `tengu_started` event must fire immediately after `initSinks()` to serve as a reliable health signal.
- **Bare mode skips most setup**: UDS messaging (unless explicit socket path), teammate snapshot, session memory, context collapse, plugin prefetch, attribution hooks, file access hooks, team memory, and release notes are all skipped. However, permission validation, the `tengu_started` beacon, and API key prefetch still run.
- **Worktree creation from within a worktree**: If invoked from an existing worktree, resolves to the canonical (main) repo root before creating a new worktree (`src/setup.ts:213-218`).
- **Terminal backup restoration is best-effort**: iTerm2 restoration only runs when swarms are enabled; Terminal.app restoration is wrapped in try/catch to never crash startup.
- **Plugin prefetch race condition**: When `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` is set, plugin prefetch is skipped entirely to avoid concurrent filesystem operations on plugin cache directories.
- **`tengu_exit` from previous session**: Metrics from the last session are logged at the start of the next session (not at actual exit time), and intentionally not cleared because they're reused for session cost restoration.
- **Attribution hooks are deferred**: `setImmediate()` ensures the git subprocess spawns after first render rather than blocking the setup microtask window (`src/setup.ts:354-361`).