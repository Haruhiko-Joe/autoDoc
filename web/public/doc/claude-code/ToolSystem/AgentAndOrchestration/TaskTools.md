# TaskTools

## Overview & Responsibilities

The TaskTools module provides a suite of six CRUD tools for structured task management within Claude Code sessions. These tools sit within the **ToolSystem > AgentAndOrchestration** layer and enable Claude to create, track, update, list, stop, and read output from tasks — giving both the AI and the user visibility into multi-step work progress.

All six tools follow the uniform `buildTool` pattern defined in the Tool interface, and delegate persistence operations to shared utilities in `src/utils/tasks.ts`. The tools are gated behind the `isTodoV2Enabled()` feature flag (except TaskStop and TaskOutput which have their own enablement logic). Each tool is deferred (`shouldDefer: true`) and marked as concurrency-safe.

**Sibling modules** in AgentAndOrchestration include AgentTool (subagent lifecycle), Team tools, and SendMessage — TaskTools provides the structured task tracking that coordinates work across these agents.

## Tools Summary

| Tool | Name | File | Read-Only | Description |
|------|------|------|-----------|-------------|
| TaskCreateTool | `TaskCreate` | `src/tools/TaskCreateTool/TaskCreateTool.ts` | No | Creates a new task |
| TaskGetTool | `TaskGet` | `src/tools/TaskGetTool/TaskGetTool.ts` | Yes | Retrieves task details by ID |
| TaskUpdateTool | `TaskUpdate` | `src/tools/TaskUpdateTool/TaskUpdateTool.ts` | No | Modifies task fields and status |
| TaskListTool | `TaskList` | `src/tools/TaskListTool/TaskListTool.ts` | Yes | Lists all tasks with summary info |
| TaskStopTool | `TaskStop` | `src/tools/TaskStopTool/TaskStopTool.ts` | No | Terminates a running background task |
| TaskOutputTool | `TaskOutput` | `src/tools/TaskOutputTool/TaskOutputTool.tsx` | Yes | Reads output from background tasks |

## Key Processes

### Task Lifecycle (Create → Update → Complete)

The primary CRUD flow for task management uses the first four tools:

1. **Create** — `TaskCreateTool` calls `createTask()` from `src/utils/tasks.ts` with status `pending`, no owner, and empty dependency arrays (`src/tools/TaskCreateTool/TaskCreateTool.ts:81-90`)
2. **Hook execution** — After creation, `executeTaskCreatedHooks()` runs. If any hook returns a blocking error, the task is immediately deleted and an error is thrown (`src/tools/TaskCreateTool/TaskCreateTool.ts:92-113`)
3. **UI expansion** — On successful creation, the app state is updated to auto-expand the task list view (`src/tools/TaskCreateTool/TaskCreateTool.ts:116-119`)
4. **Start work** — `TaskUpdateTool` sets status to `in_progress`. In agent swarm mode, the owner is auto-set to the current agent name if not explicitly provided (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:188-199`)
5. **Complete** — Setting status to `completed` triggers `executeTaskCompletedHooks()`. Blocking errors prevent the status change (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:232-265`)
6. **Verification nudge** — When the last task in a 3+ task list is completed by the main thread agent, and no task subject matches `/verif/i`, a verification nudge is appended to the result (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:333-349`)

### Task Deletion Flow

Deletion is handled as a special status value `deleted` within `TaskUpdateTool` — not a separate tool. When `status === 'deleted'`, `deleteTask()` is called and the method returns early (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:213-227`).

### Dependency Management

Tasks support blocking relationships via `addBlocks` and `addBlockedBy` parameters on `TaskUpdateTool`:

- `addBlocks` — marks that other tasks cannot start until this task completes. Calls `blockTask(taskListId, taskId, blockId)` for each new blocker (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:301-311`)
- `addBlockedBy` — marks that this task depends on others. Calls `blockTask(taskListId, blockerId, taskId)` in reverse (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:314-324`)
- `TaskListTool` filters out completed tasks from `blockedBy` arrays, so resolved dependencies no longer appear as blockers (`src/tools/TaskListTool/TaskListTool.ts:73-83`)

### Agent Swarm Integration

When agent swarms are enabled (`isAgentSwarmsEnabled()`):

- **Ownership notification** — When `TaskUpdateTool` changes a task's owner, it writes a task assignment message to the new owner's mailbox via `writeToMailbox()` (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:277-298`)
- **Auto-ownership** — Agents starting work (`in_progress`) automatically become the owner (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:188-199`)
- **Completion reminder** — When an agent completes a task, the result includes a reminder to call `TaskList` to find next available work (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:387-394`)
- **Prompts adapt** — `TaskCreateTool` and `TaskListTool` prompts include additional teammate context and workflow guidance

### Background Task Management (Stop & Output)

`TaskStopTool` and `TaskOutputTool` operate on a different concept of "task" — these manage **background runtime tasks** (shell processes, agents, remote sessions) tracked in `appState.tasks`, rather than the file-based structured task list.

- **TaskStopTool** validates the task exists and is `running` via `validateInput()`, then delegates to `stopTask()` from `src/tasks/stopTask.ts` (`src/tools/TaskStopTool/TaskStopTool.ts:107-129`). It maintains backward compatibility with the deprecated `KillShell` tool via the `aliases` field and `shell_id` parameter.
- **TaskOutputTool** supports blocking and non-blocking modes:
  - **Blocking** (`block=true`, default): polls `getAppState()` every 100ms until the task completes or `timeout` (default 30s) elapses (`src/tools/TaskOutputTool/TaskOutputTool.tsx:118-143`)
  - **Non-blocking** (`block=false`): returns current state immediately
  - Handles three task types with type-specific output: `local_bash` (stdout/stderr + exit code), `local_agent` (clean final answer from in-memory result preferred over raw JSONL transcript), `remote_agent` (command as prompt) (`src/tools/TaskOutputTool/TaskOutputTool.tsx:60-115`)
  - Marks tasks as `notified: true` after successful retrieval

## Function Signatures & Parameters

### TaskCreateTool

```typescript
call({ subject, description, activeForm?, metadata? }, context): Promise<{ data: { task: { id, subject } } }>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `subject` | `string` | Yes | Brief title for the task |
| `description` | `string` | Yes | What needs to be done |
| `activeForm` | `string` | No | Present continuous form for spinner (e.g., "Running tests") |
| `metadata` | `Record<string, unknown>` | No | Arbitrary metadata to attach |

### TaskGetTool

```typescript
call({ taskId }): Promise<{ data: { task: { id, subject, description, status, blocks, blockedBy } | null } }>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | `string` | Yes | The ID of the task to retrieve |

### TaskUpdateTool

```typescript
call({ taskId, subject?, description?, activeForm?, status?, owner?, addBlocks?, addBlockedBy?, metadata? }, context): Promise<{ data: Output }>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | `string` | Yes | The ID of the task to update |
| `subject` | `string` | No | New task title |
| `description` | `string` | No | New description |
| `activeForm` | `string` | No | Spinner text when in_progress |
| `status` | `'pending' \| 'in_progress' \| 'completed' \| 'deleted'` | No | New status (deleted removes permanently) |
| `owner` | `string` | No | Agent name to assign |
| `addBlocks` | `string[]` | No | Task IDs this task blocks |
| `addBlockedBy` | `string[]` | No | Task IDs that block this task |
| `metadata` | `Record<string, unknown>` | No | Keys to merge (null values delete keys) |

**Output** includes `success`, `taskId`, `updatedFields[]`, optional `statusChange` (`{ from, to }`), optional `error`, and `verificationNudgeNeeded`.

### TaskListTool

```typescript
call(): Promise<{ data: { tasks: Array<{ id, subject, status, owner?, blockedBy }> } }>
```

Takes no input parameters. Returns all tasks excluding those with `metadata._internal`. Filters completed task IDs from `blockedBy` arrays.

### TaskStopTool

```typescript
call({ task_id?, shell_id? }, context): Promise<{ data: { message, task_id, task_type, command? } }>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | `string` | Yes* | ID of the background task to stop |
| `shell_id` | `string` | No | Deprecated alias for `task_id` (KillShell compat) |

### TaskOutputTool

```typescript
call({ task_id, block?, timeout? }, context): Promise<{ data: { retrieval_status, task: TaskOutput | null } }>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | `string` | — | ID of the task to read output from |
| `block` | `boolean` | `true` | Whether to wait for completion |
| `timeout` | `number` | `30000` | Max wait time in ms (0–600000) |

**`retrieval_status`** values: `'success'` (task completed and output retrieved), `'timeout'` (wait expired), `'not_ready'` (non-blocking check, task still running).

## Type Definitions

### TaskStatus

The task status enum used by Create/Get/Update/List tools:

```typescript
// From src/utils/tasks.ts
type TaskStatus = 'pending' | 'in_progress' | 'completed'
```

`TaskUpdateTool` extends this with `'deleted'` as a special action status.

### TaskOutput (TaskOutputTool)

```typescript
type TaskOutput = {
  task_id: string
  task_type: TaskType        // 'local_bash' | 'local_agent' | 'remote_agent'
  status: string
  description: string
  output: string
  exitCode?: number | null   // local_bash only
  error?: string             // local_agent only
  prompt?: string            // agents only
  result?: string            // local_agent only
}
```

## Shared Infrastructure

All six tools follow the `buildTool` factory pattern and share these characteristics:

- **Lazy schemas**: Input/output Zod schemas are wrapped in `lazySchema()` for deferred evaluation
- **`maxResultSizeChars: 100_000`**: Uniform output size cap
- **`shouldDefer: true`**: All tools are deferred (loaded on demand via ToolSearch)
- **`isConcurrencySafe: true`**: All tools are safe for concurrent execution
- **`mapToolResultToToolResultBlockParam`**: Each tool provides custom serialization of results back to the model — typically as human-readable text summaries rather than raw JSON
- **Task persistence**: The CRUD tools (Create/Get/Update/List) delegate to `createTask`, `getTask`, `updateTask`, `deleteTask`, `listTasks`, and `blockTask` from `src/utils/tasks.ts`, which manage file-based task storage identified by `getTaskListId()`

## Edge Cases & Caveats

- **Two different "task" concepts**: The CRUD tools (Create/Get/Update/List) manage a file-based structured task list. TaskStop and TaskOutput manage runtime background tasks in `appState.tasks`. These are separate systems that happen to share the "Task" name.
- **TaskOutputTool is deprecated**: Its prompt explicitly states to prefer using the `Read` tool on the task's output file path instead. It maintains backward-compatible aliases (`AgentOutputTool`, `BashOutputTool`).
- **TaskStopTool backward compatibility**: Aliased as `KillShell` and accepts both `task_id` and the deprecated `shell_id` parameter.
- **Hook blocking**: Both task creation and completion can be blocked by user-configured hooks. On creation, the task is rolled back (deleted). On completion, the status change is prevented and the error is returned.
- **Metadata merge semantics**: `TaskUpdateTool` merges metadata keys — setting a key to `null` deletes it from the existing metadata map (`src/tools/TaskUpdateTool/TaskUpdateTool.ts:200-211`).
- **Internal tasks hidden**: `TaskListTool` filters out tasks where `metadata._internal` is truthy (`src/tools/TaskListTool/TaskListTool.ts:68-70`).
- **Verification nudge**: Only fires when: the `VERIFICATION_AGENT` feature is enabled, the `tengu_hive_evidence` feature flag is true, the caller is the main thread (not a subagent), and all 3+ tasks are completed with none matching `/verif/i`.
- **Non-error failure pattern**: `TaskUpdateTool.mapToolResultToToolResultBlockParam` returns "task not found" as a non-error `tool_result` to avoid triggering sibling tool cancellation in `StreamingToolExecutor`.