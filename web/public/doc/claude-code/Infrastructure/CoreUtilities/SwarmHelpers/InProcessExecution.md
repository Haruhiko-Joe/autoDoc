# InProcessExecution

## Overview & Responsibilities

The InProcessExecution module implements the execution engine for **in-process teammates** — agents that run inside the leader's Node.js process rather than in separate terminal panes (tmux/iTerm2). It sits within the **Infrastructure → CoreUtilities → SwarmHelpers** layer and provides the swarm system's lightweight alternative to process-based teammate backends.

The module is split across two files:

- **`spawnInProcess.ts`** (~330 lines): Teammate lifecycle management — creation, registration, and termination.
- **`inProcessRunner.ts`** (~1,550 lines): The full agent execution loop — context isolation, permission handling, mailbox polling, idle management, compaction, and cleanup.

In-process teammates share the same process as the leader but achieve isolation through `AsyncLocalStorage`-based context separation. They use the same `runAgent()` core as regular subagents, wrapped with teammate-specific behaviors: permission delegation to the leader, file-based mailbox communication, idle/wake cycling, and task list coordination.

## Key Processes

### Spawning a Teammate (`spawnInProcessTeammate`)

1. Generate a deterministic agent ID in `name@team` format via `formatAgentId()` (`spawnInProcess.ts:112`)
2. Create an independent `AbortController` — teammates are **not** aborted when the leader's query is interrupted (`spawnInProcess.ts:122`)
3. Build a `TeammateIdentity` record containing the agent's name, team, color, plan mode requirement, and parent session ID (`spawnInProcess.ts:128-135`)
4. Create a `TeammateContext` for `AsyncLocalStorage` isolation (`spawnInProcess.ts:139-147`)
5. Optionally register the agent in the Perfetto tracing system for hierarchy visualization (`spawnInProcess.ts:150-152`)
6. Build `InProcessTeammateTaskState` with initial status `'running'`, empty message history, spinner verbs, and permission mode (`spawnInProcess.ts:157-180`)
7. Register a cleanup handler via `registerCleanup()` that aborts on graceful shutdown (`spawnInProcess.ts:183-188`)
8. Register the task in `AppState` via `registerTask()` (`spawnInProcess.ts:191`)

### The Main Execution Loop (`runInProcessTeammate`)

This is the core of the module — a continuous prompt loop that keeps teammates alive across multiple tasks:

1. **System prompt construction** (`inProcessRunner.ts:924-970`):
   - Supports three modes: `'replace'` (custom prompt only), `'append'` (default + custom), or default (standard system prompt + teammate addendum)
   - Injects team-essential tools (`SendMessage`, `TeamCreate/Delete`, `TaskCreate/Get/List/Update`) even when the agent definition specifies an explicit tool list

2. **Per-turn execution** (`inProcessRunner.ts:1048-1273`):
   - Creates a per-turn `currentWorkAbortController` so pressing Escape stops only the current work, not the entire teammate
   - Checks token count against auto-compact threshold; if exceeded, runs `compactConversation()` on an isolated `ToolUseContext` copy to avoid clearing the leader's file state cache
   - Calls `runAgent()` within nested `runWithTeammateContext()` → `runWithAgentContext()` wrappers for identity isolation and analytics attribution
   - Streams messages from `runAgent()`, updating progress tracking and in-progress tool use IDs in task state for UI animation
   - On work abort (Escape), adds an interrupt message and transitions to idle rather than terminating

3. **Idle → Wake cycle** (`inProcessRunner.ts:1311-1416`):
   - After completing a prompt, marks the task as idle and fires registered `onIdleCallbacks`
   - Sends an idle notification to the leader via the file-based mailbox (only on transition, skipping duplicates)
   - Enters `waitForNextPromptOrShutdown()` poll loop
   - On receiving a new message: wraps it in `<teammate-message>` XML and loops back to step 2
   - On shutdown request: passes it to the model for decision (the model uses `approveShutdown`/`rejectShutdown` tools)
   - On abort: exits the loop

4. **Completion/failure cleanup** (`inProcessRunner.ts:1419-1533`):
   - Guards against double-termination (if `killInProcessTeammate` already set `status:'killed'`)
   - Fires idle callbacks, unregisters cleanup handler
   - Trims `task.messages` to only the last message (memory conservation)
   - Evicts task output from disk and AppState
   - Emits SDK task termination event and unregisters from Perfetto

### Permission Resolution (`createInProcessCanUseTool`)

The permission system has three tiers, tried in order:

1. **Static check** via `hasPermissionsToUseTool()` — returns `allow` or `deny` directly (`inProcessRunner.ts:143-154`)

2. **Bash classifier auto-approval** — for bash commands, awaits the classifier result (unlike the main agent which races it against user interaction) (`inProcessRunner.ts:159-176`)

3. **Leader UI dialog** (primary path, `inProcessRunner.ts:198-333`):
   - Pushes a `ToolUseConfirm` entry onto the leader's queue with a colored worker badge
   - The leader sees the same tool-specific UI (bash permission, file edit diff, etc.) as for their own tools
   - Handles allow (with permission persistence and context write-back), reject (with optional feedback), abort, and re-check callbacks
   - Tracks permission wait time so it can be subtracted from displayed elapsed time

4. **Mailbox fallback** (when leader UI is unavailable, `inProcessRunner.ts:337-449`):
   - Sends a structured permission request to the leader's mailbox via `sendPermissionRequestViaMailbox()`
   - Registers a callback and polls the teammate's own mailbox every 500ms for the response
   - Processes responses through `processMailboxPermissionResponse()`

### Mailbox Polling (`waitForNextPromptOrShutdown`)

The idle poll loop (`inProcessRunner.ts:689-868`) checks three sources in priority order:

1. **In-memory pending messages** (`task.pendingUserMessages`) — from the transcript viewing UI, checked every iteration without delay
2. **File-based mailbox** — prioritizes shutdown requests first, then team-lead messages, then any peer messages (FIFO). This prevents leader messages from being starved by peer-to-peer chatter
3. **Team task list** — calls `tryClaimNextTask()` to find unclaimed pending tasks with resolved dependencies

## Function Signatures

### `spawnInProcessTeammate(config, context): Promise<InProcessSpawnOutput>`

Creates and registers an in-process teammate. Does **not** start execution — that's done by `startInProcessTeammate`.

- **config** (`InProcessSpawnConfig`): `name`, `teamName`, `prompt`, optional `color`, `planModeRequired`, `model`
- **context** (`SpawnContext`): `setAppState` function and optional `toolUseId`
- **Returns**: `{ success, agentId, taskId, abortController, teammateContext, error? }`

> Source: `src/utils/swarm/spawnInProcess.ts:104-216`

### `killInProcessTeammate(taskId, setAppState): boolean`

Terminates a running teammate by aborting its controller, removing it from team membership, cleaning up state, and emitting SDK events.

- **taskId**: Task ID to kill
- **Returns**: `true` if the teammate was found and killed

> Source: `src/utils/swarm/spawnInProcess.ts:227-328`

### `runInProcessTeammate(config): Promise<InProcessRunnerResult>`

The main execution loop. Runs the teammate's agent loop with continuous prompt cycling until abort or shutdown.

- **config** (`InProcessRunnerConfig`): Full configuration including `identity`, `taskId`, `prompt`, `teammateContext`, `toolUseContext`, `abortController`, optional `model`, `systemPrompt`, `systemPromptMode`, `allowedTools`, `allowPermissionPrompts`, `agentDefinition`, `description`, `invokingRequestId`
- **Returns**: `{ success, error?, messages[] }`

> Source: `src/utils/swarm/inProcessRunner.ts:883-1534`

### `startInProcessTeammate(config): void`

Fire-and-forget wrapper around `runInProcessTeammate`. Extracts `agentId` before closure to avoid retaining the full config object during long teammate lifetimes.

> Source: `src/utils/swarm/inProcessRunner.ts:1544-1552`

## Type Definitions

### `InProcessSpawnConfig`

| Field | Type | Description |
|-------|------|-------------|
| name | `string` | Display name, e.g., `"researcher"` |
| teamName | `string` | Team this teammate belongs to |
| prompt | `string` | Initial task prompt |
| color | `string?` | Optional UI color |
| planModeRequired | `boolean` | Whether plan mode is required before implementing |
| model | `string?` | Optional model override |

### `InProcessRunnerConfig`

| Field | Type | Description |
|-------|------|-------------|
| identity | `TeammateIdentity` | Agent identity (id, name, team, color, etc.) |
| taskId | `string` | Task ID in AppState |
| prompt | `string` | Initial prompt |
| agentDefinition | `CustomAgentDefinition?` | Specialized agent definition |
| teammateContext | `TeammateContext` | AsyncLocalStorage context |
| toolUseContext | `ToolUseContext` | Parent's tool context |
| abortController | `AbortController` | Lifecycle abort controller |
| model | `string?` | Model override |
| systemPrompt | `string?` | Custom system prompt |
| systemPromptMode | `'default' \| 'replace' \| 'append'` | How to apply the system prompt |
| allowedTools | `string[]?` | Tool allowlist |
| allowPermissionPrompts | `boolean?` | Whether to show prompts for unlisted tools (default: true) |
| description | `string?` | Short task description |
| invokingRequestId | `string?` | API request ID for lineage tracing |

### `InProcessSpawnOutput`

| Field | Type | Description |
|-------|------|-------------|
| success | `boolean` | Whether spawn succeeded |
| agentId | `string` | Full agent ID (`name@team`) |
| taskId | `string?` | Task ID for AppState tracking |
| abortController | `AbortController?` | Teammate's abort controller |
| teammateContext | `TeammateContext?` | AsyncLocalStorage context |
| error | `string?` | Error message on failure |

## Edge Cases & Caveats

- **Dual abort controllers**: Each teammate has a lifecycle `abortController` (kills the entire teammate) and per-turn `currentWorkAbortController` (Escape stops only current work). The per-turn controller is stored in task state so the UI can trigger it.

- **Permission mode preservation**: When a teammate's permission approval writes back to the leader's `toolPermissionContext`, the leader's permission mode is explicitly preserved (`preserveMode: true`) to prevent workers' transformed `'acceptEdits'` context from leaking to the coordinator (`inProcessRunner.ts:277-279`).

- **Memory-conscious compaction**: After compaction, `teammateReplacementState` is reset because old `tool_use_id` keys no longer exist. Task messages in AppState are also replaced with the compacted version to prevent unbounded growth (500 turns could reach 10-50MB).

- **Double-termination guard**: Both the completion path and `killInProcessTeammate` check `task.status !== 'running'` before updating, so a kill followed by natural completion (or vice versa) won't double-emit SDK events or corrupt state.

- **Message trimming on terminal states**: When a teammate reaches `completed`, `failed`, or `killed` status, `task.messages` is trimmed to only the last message to release memory. Fields like `abortController`, `unregisterCleanup`, and `inProgressToolUseIDs` are cleared.

- **Shutdown is model-decided**: Shutdown requests from the leader are not auto-approved. They are formatted as `<teammate-message>` XML and injected as a new prompt, letting the model decide whether to approve or reject via dedicated tools.

- **Mailbox priority**: The poll loop prioritizes shutdown requests over all messages, and team-lead messages over peer messages, to prevent coordination starvation under high peer-to-peer traffic.