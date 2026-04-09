# InProcessBackend

## Overview & Responsibilities

`InProcessBackend` is the in-process implementation of the `TeammateExecutor` interface, enabling teammate agents to run within the same Node.js process as the leader agent. It sits within the **Infrastructure > CoreUtilities > SwarmHelpers > PaneBackends** module hierarchy, alongside the pane-based backends (tmux, iTerm2) that run teammates in separate terminal panes.

Unlike pane-based backends that spawn entirely separate CLI processes, `InProcessBackend` shares the leader's Node.js process while maintaining isolation via `AsyncLocalStorage`. This means teammates share resources like API clients and MCP connections with the leader, reducing overhead. It is always available with no external dependencies — no tmux or iTerm2 installation required.

Communication with teammates uses the same file-based mailbox system as pane-based backends, keeping the messaging interface uniform across all backend types.

## Key Processes

### Spawn Flow

1. Caller (typically `TeammateTool`) sets the `ToolUseContext` via `setContext()` — this provides access to `AppState`
2. `spawn()` validates that context has been set; returns an error result if not
3. Delegates to `spawnInProcessTeammate()` which creates a `TeammateContext`, an independent `AbortController`, and registers the teammate as a task in `AppState.tasks`
4. On successful spawn, fires off the agent execution loop via `startInProcessTeammate()` in a fire-and-forget fashion (`src/utils/swarm/backends/InProcessBackend.ts:107-129`)
5. The parent's `messages` array is explicitly stripped (`messages: []`) from the forwarded `toolUseContext` to avoid pinning the leader's conversation in memory for the teammate's lifetime
6. Returns `TeammateSpawnResult` with `agentId`, `taskId`, and `abortController`

### Message Delivery Flow

1. `sendMessage()` parses the `agentId` (format: `agentName@teamName`) via `parseAgentId()`
2. Writes the message to the teammate's file-based mailbox using `writeToMailbox()`
3. This is identical to how pane-based backends deliver messages — all backends share the mailbox mechanism

### Graceful Termination Flow

1. `terminate()` looks up the teammate's task in `AppState.tasks` via `findTeammateTaskByAgentId()`
2. If a shutdown is already requested (`task.shutdownRequested`), returns `true` immediately — no duplicate requests
3. Creates a shutdown request message with a deterministic ID (`shutdown-{agentId}-{timestamp}`)
4. Writes the shutdown message to the teammate's mailbox via `writeToMailbox()` (`src/utils/swarm/backends/InProcessBackend.ts:235-243`)
5. Marks the task as shutdown-requested via `requestTeammateShutdown()`, which sets the `shutdownRequested` flag
6. The teammate processes the request asynchronously — it may approve (exit) or reject (continue working)

### Force Kill Flow

1. `kill()` finds the task in `AppState` the same way as `terminate()`
2. Delegates to `killInProcessTeammate()` which aborts the teammate's `AbortController`, cancelling all async operations immediately
3. The task state is updated to `'killed'`

### Active Status Check

`isActive()` returns `true` only when both conditions hold:
- `task.status === 'running'`
- `task.abortController.signal.aborted === false`

If the abort controller is missing, the teammate is considered inactive (defaults to `aborted = true`).

## Function Signatures

### `class InProcessBackend implements TeammateExecutor`

| Method | Signature | Description |
|--------|-----------|-------------|
| `setContext` | `(context: ToolUseContext): void` | Sets the context needed for AppState access. Must be called before `spawn()` |
| `isAvailable` | `(): Promise<boolean>` | Always returns `true` — no external dependencies |
| `spawn` | `(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>` | Spawns a teammate and starts its agent loop |
| `sendMessage` | `(agentId: string, message: TeammateMessage): Promise<void>` | Delivers a message via file-based mailbox |
| `terminate` | `(agentId: string, reason?: string): Promise<boolean>` | Graceful shutdown via mailbox message |
| `kill` | `(agentId: string): Promise<boolean>` | Immediate termination via AbortController |
| `isActive` | `(agentId: string): Promise<boolean>` | Checks task status and abort signal |

### `createInProcessBackend(): InProcessBackend`

Factory function used by the backend registry to create instances (`src/utils/swarm/backends/InProcessBackend.ts:337-339`).

## Interface & Type Definitions

`InProcessBackend` implements `TeammateExecutor` (defined in `src/utils/swarm/backends/types.ts`). Key types used:

- **`TeammateSpawnConfig`** — Extends `TeammateIdentity` with `prompt`, `cwd`, `model`, `systemPrompt`, `systemPromptMode`, `permissions`, `allowPermissionPrompts`, and more
- **`TeammateSpawnResult`** — Contains `success`, `agentId`, optional `taskId`, `abortController`, and `error`
- **`TeammateMessage`** — Contains `text`, `from`, optional `color`, `timestamp`, and `summary`
- **`AgentId` format** — String in the form `agentName@teamName` (e.g., `"researcher@my-team"`)

## Edge Cases & Caveats

- **Context must be set before spawn**: Calling `spawn()` without first calling `setContext()` returns a failed result rather than throwing — the error is logged and returned gracefully
- **Duplicate shutdown protection**: `terminate()` is idempotent — if `shutdownRequested` is already set on the task, it short-circuits and returns `true`
- **Fire-and-forget agent loop**: `startInProcessTeammate()` runs in the background with no `await`. The spawn method returns immediately after launching the loop
- **Messages stripped from context**: The leader's conversation messages are explicitly zeroed out (`messages: []`) when passed to the teammate to prevent memory pinning
- **Missing abort controller**: `isActive()` treats a missing `abortController` as aborted (`?? true`), so teammates without controllers are always considered inactive
- **terminate vs kill**: `terminate()` is cooperative — the teammate can reject it. `kill()` is immediate via `AbortController.abort()`. These mirror the distinction between SIGTERM and SIGKILL