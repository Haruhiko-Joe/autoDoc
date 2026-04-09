# PaneBackendExecutor

## Overview & Responsibilities

`PaneBackendExecutor` is an adapter class that bridges pane-based terminal backends (tmux or iTerm2) to the unified `TeammateExecutor` interface. It sits within the **Infrastructure > CoreUtilities > SwarmHelpers > PaneBackends** hierarchy, alongside sibling modules for in-process execution, team management, and permission coordination.

The swarm system supports multiple execution strategies for teammate agents. While `InProcessBackend` runs teammates inside the leader's Node.js process, pane-based backends spawn each teammate as a separate Claude CLI process in a terminal pane. `PaneBackendExecutor` wraps any `PaneBackend` implementation so that higher-level swarm orchestration code can interact with both execution modes through the same `TeammateExecutor` API.

## Key Processes

### Spawn Flow

The `spawn()` method is the core of this adapter. It creates a new terminal pane, launches a Claude CLI process in it, and delivers the initial prompt via a file-based mailbox.

1. **Format the agent ID** from `config.name` and `config.teamName` using `formatAgentId()` — producing a `name@team` identifier
2. **Validate context** — fails early if `setContext()` was never called (no access to `AppState`)
3. **Assign a color** for the teammate's pane border (`config.color` or auto-assigned via `assignTeammateColor()`)
4. **Create the pane** by calling `backend.createTeammatePaneInSwarmView()`, which returns a `paneId` and an `isFirstTeammate` flag
5. **Detect tmux environment** via `isInsideTmux()` — this determines whether commands target the current tmux session (internal) or an external swarm session socket
6. **Enable pane border status** on the first teammate when running inside tmux (`src/utils/swarm/backends/PaneBackendExecutor.ts:109-111`)
7. **Build the CLI command** — assembles the full spawn command with:
   - The teammate binary path from `getTeammateCommand()`
   - Identity flags: `--agent-id`, `--agent-name`, `--team-name`, `--agent-color`, `--parent-session-id`, and optionally `--plan-mode-required`
   - Inherited CLI flags from `buildInheritedCliFlags()` (propagating permission mode, plan mode, etc.)
   - Custom `--model` flag if `config.model` is specified (replaces any inherited model flag)
   - Inherited environment variables from `buildInheritedEnvVars()`
   - Working directory via `cd` prefix
8. **Send the command to the pane** via `backend.sendCommandToPane()`, passing `!insideTmux` as the `useExternalSession` flag (`src/utils/swarm/backends/PaneBackendExecutor.ts:158`)
9. **Track the teammate** in the internal `spawnedTeammates` map (agentId → `{ paneId, insideTmux }`)
10. **Register cleanup** (once) via `registerCleanup()` to kill all spawned panes on leader exit
11. **Write initial prompt** to the teammate's file-based mailbox using `writeToMailbox()`

### External vs Internal Tmux Session Routing

A key design detail is the `insideTmux` / `useExternalSession` distinction (`src/utils/swarm/backends/PaneBackendExecutor.ts:106, 158`). When the leader is running **inside** an existing tmux session, commands target that session directly. When running **outside** tmux, the backend creates a standalone tmux session and commands must use an external session socket — hence `useExternalSession = !insideTmux`. This flag is persisted per-teammate so that `kill()` routes correctly later.

### Message Flow (sendMessage)

Messages between leader and pane-based teammates use a file-based mailbox, not terminal I/O:

1. Parse the `agentId` into `agentName` and `teamName` via `parseAgentId()`
2. Write the message to the teammate's mailbox file via `writeToMailbox()` with `text`, `from`, `color`, and `timestamp` fields

### Graceful Termination (terminate)

Sends a structured shutdown request through the mailbox rather than killing the process:

1. Parse `agentId` to extract agent and team names
2. Construct a `shutdown_request` JSON payload with a unique `requestId`, the sender (`team-lead`), and an optional `reason`
3. Write the JSON payload as the message `text` to the teammate's mailbox

The teammate process is expected to read this message and exit gracefully.

### Force Kill (kill)

Immediately destroys the pane via the backend:

1. Look up the `paneId` and `insideTmux` flag from `spawnedTeammates`
2. Call `backend.killPane(paneId, !insideTmux)` — routing through the external session socket if needed
3. Remove the teammate from the tracking map on success

### Activity Check (isActive)

Currently a best-effort implementation — returns `true` if the teammate exists in the `spawnedTeammates` map (`src/utils/swarm/backends/PaneBackendExecutor.ts:340-344`). The code notes that a more robust check would query the backend for pane existence.

## Function Signatures

### `constructor(backend: PaneBackend)`

Wraps the given `PaneBackend`, inheriting its `type` identifier and initializing an empty teammate tracking map.

### `setContext(context: ToolUseContext): void`

Must be called before `spawn()`. Provides access to `AppState` (used to read `toolPermissionContext.mode` for building inherited CLI flags).

### `isAvailable(): Promise<boolean>`

Delegates directly to `backend.isAvailable()`.

### `spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>`

Creates a pane, launches a Claude CLI teammate process, and delivers the initial prompt. Returns `{ success, agentId, paneId? , error? }`.

### `sendMessage(agentId: string, message: TeammateMessage): Promise<void>`

Writes a message to the teammate's file-based mailbox. Throws if `agentId` format is invalid.

### `terminate(agentId: string, reason?: string): Promise<boolean>`

Sends a graceful shutdown request via mailbox. Returns `true` on success, `false` if the `agentId` is invalid.

### `kill(agentId: string): Promise<boolean>`

Force-kills the teammate's pane via the backend. Returns `true` if the pane was killed, `false` if the teammate was not found or kill failed.

### `isActive(agentId: string): Promise<boolean>`

Returns `true` if the teammate is in the tracking map, `false` otherwise.

### `createPaneBackendExecutor(backend: PaneBackend): PaneBackendExecutor`

Factory function that creates and returns a new `PaneBackendExecutor` wrapping the given backend.

## Interface & Type Definitions

### `TeammateExecutor` (implemented by this class)

The unified interface for teammate lifecycle management across all backends (pane-based and in-process). Defines `spawn`, `sendMessage`, `terminate`, `kill`, and `isActive`.

### `PaneBackend` (wrapped by this class)

Low-level interface for terminal pane operations: creating panes, sending commands, setting border colors/titles, killing panes, and hide/show management.

### `TeammateSpawnConfig`

Extends `TeammateIdentity` with `prompt`, `cwd`, `model`, `systemPrompt`, `parentSessionId`, `permissions`, and other spawn-time configuration.

### `TeammateSpawnResult`

Result object with `success`, `agentId`, optional `error`, `paneId` (pane-based), or `abortController`/`taskId` (in-process).

### Key internal state

| Field | Type | Purpose |
|-------|------|---------|
| `backend` | `PaneBackend` | The wrapped terminal backend |
| `context` | `ToolUseContext \| null` | Provides access to AppState; set via `setContext()` |
| `spawnedTeammates` | `Map<string, { paneId: string; insideTmux: boolean }>` | Tracks all spawned teammates for kill/cleanup routing |
| `cleanupRegistered` | `boolean` | Ensures the process-exit cleanup handler is registered only once |

## Edge Cases & Caveats

- **`setContext()` must be called before `spawn()`** — if omitted, `spawn()` returns a failure result rather than throwing, so callers should check `result.success`.
- **`isActive()` is approximate** — it only checks the in-memory map, not whether the pane process is still running. A teammate whose process has crashed will still appear active until explicitly killed.
- **External session routing** — the `useExternalSession` flag is critical for correct tmux operation. When the leader runs outside tmux, all pane commands must use the external swarm session socket. This flag is captured at spawn time and reused for `kill()`.
- **Cleanup on leader exit** — `registerCleanup()` ensures all spawned panes are killed when the leader process exits (e.g., SIGHUP). The cleanup handler iterates the entire `spawnedTeammates` map.
- **Model flag replacement** — when `config.model` is set, the code strips any existing `--model` flag from inherited flags before appending the new one (`src/utils/swarm/backends/PaneBackendExecutor.ts:137-146`). This filter also removes the value argument following `--model` by checking `arr[i - 1] !== '--model'`.
- **Graceful vs force termination** — `terminate()` sends a mailbox message and trusts the teammate to exit; `kill()` destroys the pane immediately. There is no timeout-based escalation from terminate to kill built into this class.