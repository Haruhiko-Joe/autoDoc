# Task Framework

## Overview & Responsibilities

The Task Framework is the shared abstraction layer within the **Infrastructure** module that manages concurrent work units across Claude Code. Every background operation — shell commands, local agents, remote cloud sessions, in-process teammates, and memory-consolidation "dream" agents — is modeled as a **task** with a uniform lifecycle, output capture, and notification system.

The framework provides:
- **Task type definitions and ID generation** (`src/Task.ts`)
- **A registry that loads per-type implementations** with feature-gating (`src/tasks.ts`)
- **Per-type implementations** for shell, agent, remote, teammate, and dream tasks (`src/tasks/`)
- **Output capture** in two modes: file-descriptor redirect and pipe with memory/disk spillover (`src/utils/task/TaskOutput.ts`, `src/utils/task/diskOutput.ts`)
- **State management helpers** — register, update, evict, poll (`src/utils/task/framework.ts`)
- **Output formatting and progress reporting** for API and SDK consumers (`src/utils/task/outputFormatting.ts`, `src/utils/task/sdkProgress.ts`)

Other modules (ToolSystem's `BashTool`, `AgentTool`, `TaskStopTool`; the QueryEngine's polling loop; the TerminalUI's footer pills and detail dialogs) depend on this framework to spawn, track, and display concurrent work.

---

## Task Types and Status Lifecycle

### TaskType Variants

Defined in `src/Task.ts:6-13`:

| Type | Prefix | Description |
|------|--------|-------------|
| `local_bash` | `b` | Background shell commands spawned by BashTool |
| `local_agent` | `a` | Local sub-agent queries (also used for backgrounded main sessions) |
| `remote_agent` | `r` | Cloud-hosted remote sessions (ultraplan, ultrareview, autofix-pr) |
| `in_process_teammate` | `t` | In-process teammates running via AsyncLocalStorage in coordinator/swarm mode |
| `local_workflow` | `w` | Workflow script tasks (feature-gated behind `WORKFLOW_SCRIPTS`) |
| `monitor_mcp` | `m` | MCP monitor tasks (feature-gated behind `MONITOR_TOOL`) |
| `dream` | `d` | Auto-dream memory consolidation sub-agent |

### Status Lifecycle

Defined in `src/Task.ts:15-20`:

```
pending → running → completed
                  → failed
                  → killed
```

The helper `isTerminalTaskStatus()` (`src/Task.ts:27-29`) returns `true` for `completed`, `failed`, or `killed`. Terminal tasks are candidates for eviction from `AppState.tasks` once their completion has been notified.

### Task ID Generation

`generateTaskId()` (`src/Task.ts:98-106`) produces IDs in the format `<prefix><8 random chars>`, where the prefix encodes the task type (e.g., `b` for bash, `r` for remote) and the 8-character suffix is drawn from a case-insensitive-safe alphabet (`0-9a-z`), yielding ~2.8 trillion combinations — sufficient to resist brute-force symlink attacks from sandboxed processes.

---

## Task Registry

`src/tasks.ts` is the central registry that maps `TaskType` to its implementation. It uses the `Task` interface:

```typescript
// src/Task.ts:72-76
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

The `kill` method is the only polymorphic dispatch point — each task type implements its own termination logic. Spawn and render are handled per-type outside this interface.

### Feature-Gated Loading

`getAllTasks()` (`src/tasks.ts:22-32`) always loads four core implementations (`LocalShellTask`, `LocalAgentTask`, `RemoteAgentTask`, `DreamTask`) and conditionally loads two more via Bun's `feature()` compile-time flags:

- `WORKFLOW_SCRIPTS` → `LocalWorkflowTask`
- `MONITOR_TOOL` → `MonitorMcpTask`

The conditional loading uses `require()` (not `import`) so that feature-gated code is excluded from the bundle at build time.

`getTaskByType()` (`src/tasks.ts:37-39`) performs a linear scan to find an implementation by its `type` field.

---

## Task State Management (`src/utils/task/framework.ts`)

This module provides the state management primitives that all task implementations share.

### Core Functions

**`registerTask(task, setAppState)`** (`framework.ts:77-117`): Adds a new task to `AppState.tasks`. On re-registration (e.g., agent resume), it carries forward UI-held state (`retain`, `startTime`, `messages`, `diskLoaded`, `pendingMessages`) to avoid resetting the user's view. Emits a `task_started` SDK event for new tasks.

**`updateTaskState<T>(taskId, setAppState, updater)`** (`framework.ts:48-72`): Generic helper for type-safe task state updates. Performs a reference-equality check — if the updater returns the same object, the spread is skipped to avoid unnecessary React re-renders.

**`evictTerminalTask(taskId, setAppState)`** (`framework.ts:125-144`): Eagerly removes terminal + notified tasks from `AppState`. Respects a grace period for `local_agent` tasks that have `evictAfter` set (default 30 seconds via `PANEL_GRACE_MS`), keeping them visible in the coordinator panel.

### Polling Loop

**`pollTasks(getAppState, setAppState)`** (`framework.ts:255-269`): The main polling entry point called by the query loop framework. It:

1. Calls `generateTaskAttachments()` to scan all tasks for output deltas and terminal states
2. Applies offset patches and evictions via `applyTaskOffsetsAndEvictions()`
3. Enqueues XML-formatted notifications for completed tasks

**`generateTaskAttachments()`** (`framework.ts:158-206`) reads output deltas only for `running` tasks, using `getTaskOutputDelta()` to read incrementally from the last known byte offset. Terminal tasks that have been notified are collected for eviction.

**`applyTaskOffsetsAndEvictions()`** (`framework.ts:213-249`) merges patches against *fresh* state (not the stale pre-await snapshot), preventing concurrent status transitions from being clobbered.

### Task Notifications

`enqueueTaskNotification()` (`framework.ts:274-290`) formats an XML message containing the task ID, type, output file path, status, and summary, then pushes it onto the pending notification queue for the query engine to deliver to Claude.

---

## TaskOutput (`src/utils/task/TaskOutput.ts`)

`TaskOutput` is the single source of truth for a command's stdout/stderr. It operates in two modes:

### File Mode (Bash commands)

Both stdout and stderr are redirected to a file via stdio file descriptors — **data never enters the JS heap**. Progress is extracted by a shared poller that reads the file tail periodically.

### Pipe Mode (Hooks)

Data flows through `writeStdout()`/`writeStderr()` and is buffered in memory (default 8MB cap). When the buffer exceeds the limit, content spills to disk via `DiskTaskOutput`.

### Progress Polling Architecture

`TaskOutput` uses a **shared static poller** (`src/utils/task/TaskOutput.ts:53-56`) rather than per-instance timers:

- `startPolling(taskId)` / `stopPolling(taskId)`: Called from React `useEffect` when progress components mount/unmount. The interval (1 second) is created on first active task and destroyed when the last one stops.
- `#tick()` (`TaskOutput.ts:109-164`): Reads the last 4KB of each actively-polled task's output file, counts newlines, extracts the last 5 and last 100 lines, and calls the `onProgress` callback. Line counts are extrapolated when the file exceeds the tail window.

### Memory-to-Disk Spillover

When pipe-mode data exceeds the 8MB in-memory limit (`TaskOutput.ts:188-193`):
1. A `DiskTaskOutput` is created
2. Existing memory buffers are flushed to disk
3. Subsequent writes go directly to disk
4. `getStdout()` returns the last 5 recent lines plus a truncation notice with the file path

### Key Methods

| Method | Description |
|--------|-------------|
| `getStdout()` | File mode: reads up to `maxOutputLength` bytes from disk. Pipe mode: returns memory buffer or truncated tail. |
| `getStderr()` | Returns stderr buffer (pipe mode only; file mode always returns `''`). |
| `spillToDisk()` | Forces all buffered content to disk. Called when backgrounding a task. |
| `clear()` | Resets all buffers, cancels disk writes, stops polling, and unregisters from the static registry. |
| `outputFileRedundant` | True after `getStdout()` when the entire file fit in memory — signals the file can be deleted. |

---

## Disk Output Layer (`src/utils/task/diskOutput.ts`)

### Output File Paths

Output files live in `<projectTempDir>/<sessionId>/tasks/<taskId>.output`. The session ID is captured at first call and memoized (`diskOutput.ts:49-55`) — this prevents `/clear` (which regenerates the session ID) from orphaning in-flight output files.

### DiskTaskOutput Class

`DiskTaskOutput` (`diskOutput.ts:97-231`) manages async disk writes for a single task with careful memory management:

- Uses a flat `string[]` write queue processed by a single drain loop
- `#queueToBuffers()` (`diskOutput.ts:189-205`) splices the queue in-place and concatenates into a single `Buffer` to enable immediate GC
- The `#drain()` loop retries once on transient FS errors (EMFILE, EPERM)
- A 5GB disk cap (`MAX_TASK_OUTPUT_BYTES`) prevents runaway output from filling the disk

### Security

Files are opened with `O_NOFOLLOW` (`diskOutput.ts:20-21`) to prevent symlink-following attacks from sandboxed processes. `initTaskOutput()` additionally uses `O_EXCL` to ensure only new files are created.

### Key Functions

| Function | Description |
|----------|-------------|
| `initTaskOutput(taskId)` | Creates an empty output file with `O_EXCL \| O_NOFOLLOW` |
| `initTaskOutputAsSymlink(taskId, targetPath)` | Creates the output path as a symlink to another file (e.g., agent transcript) |
| `appendTaskOutput(taskId, content)` | Appends to the write queue (fire-and-forget) |
| `getTaskOutputDelta(taskId, fromOffset)` | Reads new bytes from `fromOffset`, returns content + new offset |
| `getTaskOutput(taskId)` | Reads the tail of the output file (capped at 8MB) |
| `evictTaskOutput(taskId)` | Flushes pending writes and removes from the in-memory map (file persists) |
| `cleanupTaskOutput(taskId)` | Cancels writes, removes map entry, and deletes the file |

---

## Per-Type Task Implementations

### LocalShellTask (`src/tasks/LocalShellTask/`)

Manages background shell commands. State type `LocalShellTaskState` (`guards.ts:11-32`) extends `TaskStateBase` with:
- `command`: The shell command string
- `shellCommand`: Reference to the `ShellCommand` process handle
- `isBackgrounded`: Whether the task has been moved to background
- `agentId`: The agent that spawned this task (used for orphan cleanup)
- `kind`: `'bash'` or `'monitor'` — affects UI display

**Kill path** (`killShellTasks.ts:16-46`): Calls `shellCommand.kill()` and `.cleanup()`, unregisters cleanup handlers, clears timeouts, and evicts disk output.

**Agent-scoped cleanup** (`killShellTasks.ts:53-76`): `killShellTasksForAgent()` kills all running bash tasks spawned by a given agent when that agent exits, preventing zombie processes.

**Stall detection** (`LocalShellTask.tsx:46-80`): A watchdog polls the output file size every 5 seconds. If output hasn't grown for 45 seconds and the tail matches interactive prompt patterns (`(y/n)`, `Press Enter`, etc.), it sends a notification so Claude can respond to the stalled command.

### LocalAgentTask (`src/tasks/LocalAgentTask/`)

Manages background sub-agent queries. Tracks progress via `ProgressTracker` (`LocalAgentTask.tsx:41-57`):
- `latestInputTokens`: Latest cumulative input tokens (API reports cumulatively)
- `cumulativeOutputTokens`: Sum of per-turn output tokens
- `recentActivities`: Last 5 tool uses with activity descriptions

Also used for backgrounded main sessions via `LocalMainSessionTask` (`src/tasks/LocalMainSessionTask.ts`), which creates a `LocalAgentTaskState` with `agentType: 'main-session'`.

### RemoteAgentTask (`src/tasks/RemoteAgentTask/`)

Manages cloud-hosted sessions. Supports multiple remote task types (`remote-agent`, `ultraplan`, `ultrareview`, `autofix-pr`, `background-pr`). Features include:
- Completion checkers: External-API-aware hooks registered per remote task type
- Metadata persistence: Writes sidecar files for session restore across `/resume`
- Ultraplan phase tracking: `needs_input`, `plan_ready` phases surfaced in the UI pill

### InProcessTeammateTask (`src/tasks/InProcessTeammateTask/`)

Manages teammates in coordinator/swarm mode. Key characteristics:
- Runs in the same Node.js process using `AsyncLocalStorage` for isolation
- Has team-aware identity (`agentName@teamName`) with color and plan-mode settings
- Supports message injection from the user when viewing the transcript
- Messages capped at 50 (`TEAMMATE_MESSAGES_UI_CAP`) to control memory usage — full conversation lives in a separate local array and on disk

### DreamTask (`src/tasks/DreamTask/DreamTask.ts`)

Surfaces the auto-dream memory consolidation agent in the UI. Tracks:
- `phase`: `'starting'` → `'updating'` (when first Edit/Write tool use detected)
- `filesTouched`: Paths observed in Edit/Write tool uses (incomplete — misses bash-mediated writes)
- `turns`: Last 30 assistant turns with tool use counts collapsed

Kill rolls back the consolidation lock mtime so the next session can retry.

---

## Output Formatting (`src/utils/task/outputFormatting.ts`)

`formatTaskOutput()` (`outputFormatting.ts:22-38`) truncates task output for API consumption:
- Default limit: 32,000 characters (`TASK_MAX_OUTPUT_DEFAULT`)
- Upper limit: 160,000 characters, configurable via `TASK_MAX_OUTPUT_LENGTH` env var
- When truncated, prepends a header with the full output file path and returns the **tail** (last N characters) to preserve the most recent output

---

## SDK Progress Reporting (`src/utils/task/sdkProgress.ts`)

`emitTaskProgress()` (`sdkProgress.ts:10-36`) emits `task_progress` SDK events with:
- Task and tool-use IDs
- Usage stats (total tokens, tool use count, duration)
- Last tool name and optional summary
- Workflow-specific progress data

Shared by background agents (per tool_use in `runAsyncAgentLifecycle`) and workflows (per flush batch).

---

## Stopping Tasks (`src/tasks/stopTask.ts`)

`stopTask()` (`stopTask.ts:38-100`) provides the unified stop path used by both the `TaskStopTool` (LLM-invoked) and the SDK `stop_task` control request:

1. Looks up the task by ID in `AppState.tasks`
2. Validates it is running (throws `StopTaskError` with coded reasons: `not_found`, `not_running`, `unsupported_type`)
3. Dispatches to the type-specific `kill()` implementation
4. For bash tasks: suppresses the noisy "exit code 137" notification and emits an SDK event directly
5. For agent tasks: lets the `AbortError` catch path send a notification carrying `extractPartialResult()`

---

## UI Integration (`src/tasks/pillLabel.ts`, `src/tasks/types.ts`)

**Background task detection** (`types.ts:37-46`): `isBackgroundTask()` returns true for tasks that are running/pending and have been explicitly backgrounded (`isBackgrounded !== false`).

**Footer pill labels** (`pillLabel.ts:10-67`): `getPillLabel()` generates compact labels for the status bar:
- Same-type groups: `"2 shells"`, `"1 local agent"`, `"◇ ultraplan"`, `"dreaming"`
- Mixed groups: `"3 background tasks"`
- Ultraplan phases use filled/open diamond symbols (`◆`/`◇`) to indicate readiness

**Attention CTA** (`pillLabel.ts:74-82`): `pillNeedsCta()` returns true for single ultraplan tasks in `needs_input` or `plan_ready` phase, triggering the dimmed "↓ to view" call-to-action.