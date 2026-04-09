# Planning and Workflow Tools

## Overview & Responsibilities

The PlanningAndWorkflow module is a collection of tools within the **ToolSystem** that give Claude structured mechanisms for planning work, tracking progress, isolating workspaces, and scheduling future actions. These tools sit in the tool execution layer and are invoked by the query engine during conversations.

The module contains three functional groups:

1. **Plan Mode** (`EnterPlanMode` / `ExitPlanMode`) — transitions Claude into a read-only exploration phase where it designs an implementation approach before writing code, then presents the plan for user approval.
2. **Task Tracking** (`TodoWrite`) — a session-scoped checklist for tracking multi-step work progress.
3. **Workspace Isolation** (`EnterWorktree` / `ExitWorktree`) — creates and manages git worktree-based isolated working directories.
4. **Scheduled Execution** (`CronCreate` / `CronDelete` / `CronList`) — schedules prompts to fire on cron schedules, either session-only or persisted to disk.
5. **Remote Triggers** (`RemoteTrigger`) — manages scheduled remote agent executions via the claude.ai API.
6. **Auxiliary** (`SleepTool`, `SyntheticOutputTool`) — a sleep primitive for idle waiting, and a structured-output tool for non-interactive SDK/CLI sessions.

All tools follow the standard `Tool` interface: they define input/output Zod schemas, a `call()` method, permission checks, UI renderers, and prompt instructions.

---

## Key Processes

### Plan Mode Lifecycle

The plan mode system enforces a "think before you code" workflow:

1. **Enter plan mode**: Claude calls `EnterPlanMode` (no parameters). The tool transitions the permission mode to `'plan'` via `applyPermissionUpdate()` and `prepareContextForPlanMode()`, restricting Claude to read-only tools (`src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:88-94`).

2. **Explore and design**: While in plan mode, Claude uses Glob, Grep, and Read tools to understand the codebase. It writes its plan to a plan file on disk.

3. **Exit plan mode**: Claude calls `ExitPlanMode`. The tool reads the plan from disk via `getPlan()`, presents it to the user for approval, and restores the previous permission mode (`src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:357-403`). The pre-plan mode is stored in `toolPermissionContext.prePlanMode` and restored on exit.

4. **User approval**: The tool requires user interaction (`requiresUserInteraction() = true` for non-teammates). The user can approve, reject, or edit the plan. Edited plans are synced back to disk.

Key constraints:
- Plan mode is disabled when `--channels` is active (Telegram/Discord) because the approval dialog would hang.
- Cannot be used in agent (subagent) contexts — throws an error (`src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:78-79`).
- `ExitPlanMode` validates that the current mode is `'plan'` before proceeding; calling it outside plan mode returns an error.

**Teammate flow**: When a teammate agent exits plan mode with `isPlanModeRequired()`, instead of showing a local dialog, the plan is sent as a `plan_approval_request` to the team leader's mailbox (`src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:264-313`).

**Auto-mode restoration**: On exit, if the pre-plan mode was `'auto'` but the auto-mode gate has been disabled (circuit breaker), the tool falls back to `'default'` mode and notifies the user (`src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:328-355`).

### Todo List Management

`TodoWrite` provides a session-scoped task checklist stored in `appState.todos`:

1. Claude calls `TodoWrite` with a full `todos` array (replacing the previous list).
2. The tool stores todos keyed by `agentId` (for subagents) or `sessionId` (for the main thread) (`src/tools/TodoWriteTool/TodoWriteTool.ts:67`).
3. When all todos are marked `completed`, the list is cleared (`src/tools/TodoWriteTool/TodoWriteTool.ts:69`).
4. A **verification nudge** fires when 3+ tasks are completed at once and none contained a verification step — it appends a reminder to spawn the verification agent (`src/tools/TodoWriteTool/TodoWriteTool.ts:76-86`).

Each todo item has three states: `pending`, `in_progress`, and `completed`. The tool enforces that exactly one task should be `in_progress` at a time via prompt instructions. Items require both `content` (imperative: "Run tests") and `activeForm` (progressive: "Running tests") fields.

The tool is disabled when `isTodoV2Enabled()` returns true, indicating migration to a newer task system.

### Worktree Isolation

The worktree tools create isolated git working directories for safe experimentation:

**EnterWorktree** (`src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:77-119`):
1. Validates no worktree session is already active.
2. Resolves to the canonical git root (handles being inside an existing worktree).
3. Calls `createWorktreeForSession()` to create a new worktree under `.claude/worktrees/` with a new branch based on HEAD.
4. Changes the process working directory and updates all CWD-dependent state: `setCwd()`, `setOriginalCwd()`, clears system prompt sections, memory file caches, and plan directory caches.
5. Supports an optional `name` parameter (validated to only contain `[a-zA-Z0-9._-/]`, max 64 chars).

**ExitWorktree** (`src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:148-329`):
1. Only operates on worktrees created by `EnterWorktree` in the current session — will not touch manually created worktrees.
2. Accepts `action: "keep" | "remove"` and optional `discard_changes: boolean`.
3. On `"remove"`, validates that the worktree is clean (no uncommitted files, no new commits). If dirty, refuses unless `discard_changes: true` is set (`src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:190-221`).
4. Restores the session to the original working directory via `restoreSessionToOriginalCwd()`, which resets CWD, project root (if it was the worktree), hooks config, and all CWD-dependent caches.
5. On `"remove"`, kills any associated tmux session before cleanup.

The `countWorktreeChanges()` helper runs `git status --porcelain` and `git rev-list --count` to detect uncommitted files and new commits. It returns `null` when state cannot be reliably determined (fail-closed safety) (`src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:79-113`).

### Cron Scheduling System

Three tools manage scheduled prompt execution:

**CronCreate** (`src/tools/ScheduleCronTool/CronCreateTool.ts:56-157`):
- Takes a 5-field cron expression (local timezone), a prompt string, and flags for `recurring` (default true) and `durable` (default false).
- Validates the cron expression, ensures no more than 50 active jobs, and blocks durable crons for teammate agents.
- Calls `addCronTask()` and enables the scheduler via `setScheduledTasksEnabled(true)`.
- Recurring tasks auto-expire after `DEFAULT_MAX_AGE_DAYS` (derived from `DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs`).
- Durable tasks persist to `.claude/scheduled_tasks.json` and survive restarts; session-only tasks live in memory.

**CronDelete** (`src/tools/ScheduleCronTool/CronDeleteTool.ts:35-95`):
- Takes a job `id` and removes it via `removeCronTasks()`.
- Teammates can only delete their own crons (enforced by `agentId` comparison).

**CronList** (`src/tools/ScheduleCronTool/CronListTool.ts:37-97`):
- Returns all active jobs (or only the calling teammate's jobs).
- Read-only and concurrency-safe.

**Feature gating** (`src/tools/ScheduleCronTool/prompt.ts:36-45`): The cron system requires both the build-time `feature('AGENT_TRIGGERS')` flag and the runtime `tengu_kairos_cron` GrowthBook gate (refreshed every 5 minutes). The local override `CLAUDE_CODE_DISABLE_CRON` wins over GrowthBook.

### Remote Trigger Management

`RemoteTrigger` (`src/tools/RemoteTriggerTool/RemoteTriggerTool.ts:46-161`) is a REST client for the claude.ai trigger API:
- Supports 5 actions: `list`, `get`, `create`, `update`, `run`.
- Authenticates via OAuth tokens (`getClaudeAIOAuthTokens()`) with the `ccr-triggers-2026-01-30` beta header.
- Gated behind the `tengu_surreal_dali` feature flag and `allow_remote_sessions` policy.
- Returns raw HTTP status and JSON response body.

### SyntheticOutputTool

`SyntheticOutputTool` (`src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:28-101`) enables structured JSON output for non-interactive (SDK/CLI) sessions:
- Only enabled when `isNonInteractiveSession` is true.
- Accepts any input object, validates it, and returns it as `structured_output`.
- `createSyntheticOutputTool()` wraps it with a user-provided JSON schema, using Ajv for validation. Results are identity-cached via `WeakMap` to avoid repeated Ajv compilation (~1.4ms per call → ~0.05ms cached) (`src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:109-125`).

---

## Function Signatures

### EnterPlanModeTool

```typescript
call(_input: {}, context: ToolUseContext): Promise<{ data: { message: string } }>
```

No input parameters. Returns a confirmation message. Throws if called from an agent context.

> Source: `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:77-101`

### ExitPlanModeV2Tool

```typescript
call(input: {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>
}, context: ToolUseContext): Promise<{ data: Output }>
```

- `allowedPrompts` — optional semantic permission requests (e.g., "run tests") for the Bash tool.
- Returns `{ plan, isAgent, filePath, hasTaskTool?, planWasEdited?, awaitingLeaderApproval?, requestId? }`.

> Source: `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:243-418`

### TodoWriteTool

```typescript
call({ todos }: { todos: TodoList }, context: ToolUseContext): Promise<{ data: Output }>
```

- `todos` — the complete replacement todo list (array of `{ content, activeForm, status }` items).
- Returns `{ oldTodos, newTodos, verificationNudgeNeeded? }`.

> Source: `src/tools/TodoWriteTool/TodoWriteTool.ts:65-103`

### EnterWorktreeTool

```typescript
call(input: { name?: string }, context: ToolUseContext): Promise<{ data: Output }>
```

- `name` — optional worktree slug (letters, digits, dots, underscores, dashes; max 64 chars). Random if omitted.
- Returns `{ worktreePath, worktreeBranch?, message }`.

> Source: `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:77-119`

### ExitWorktreeTool

```typescript
call(input: { action: 'keep' | 'remove'; discard_changes?: boolean }, context: ToolUseContext): Promise<{ data: Output }>
```

- `action` — `"keep"` preserves the worktree; `"remove"` deletes it.
- `discard_changes` — must be `true` to remove a dirty worktree.
- Returns `{ action, originalCwd, worktreePath, worktreeBranch?, tmuxSessionName?, discardedFiles?, discardedCommits?, message }`.

> Source: `src/tools/ExitWorktreeTool/ExitWorktreeTool.ts:227-321`

### CronCreateTool

```typescript
call({ cron, prompt, recurring?, durable? }): Promise<{ data: CreateOutput }>
```

- `cron` — 5-field cron expression in local time.
- `prompt` — the prompt to enqueue.
- `recurring` — default `true`; `false` for one-shot.
- `durable` — default `false`; `true` to persist to `.claude/scheduled_tasks.json`.
- Returns `{ id, humanSchedule, recurring, durable? }`.

> Source: `src/tools/ScheduleCronTool/CronCreateTool.ts:117-141`

### CronDeleteTool

```typescript
call({ id }): Promise<{ data: { id: string } }>
```

> Source: `src/tools/ScheduleCronTool/CronDeleteTool.ts:82-84`

### CronListTool

```typescript
call(): Promise<{ data: { jobs: Array<{ id, cron, humanSchedule, prompt, recurring?, durable? }> } }>
```

> Source: `src/tools/ScheduleCronTool/CronListTool.ts:63-78`

### RemoteTriggerTool

```typescript
call(input: { action: 'list'|'get'|'create'|'update'|'run'; trigger_id?: string; body?: Record<string, unknown> }, context): Promise<{ data: { status: number; json: string } }>
```

> Source: `src/tools/RemoteTriggerTool/RemoteTriggerTool.ts:78-151`

### createSyntheticOutputTool

```typescript
function createSyntheticOutputTool(jsonSchema: Record<string, unknown>): { tool: Tool } | { error: string }
```

Factory that wraps `SyntheticOutputTool` with Ajv-based JSON schema validation. Identity-cached per schema object.

> Source: `src/tools/SyntheticOutputTool/SyntheticOutputTool.ts:116-125`

---

## Configuration & Feature Gates

| Gate / Config | Type | Controls |
|---|---|---|
| `feature('AGENT_TRIGGERS')` | Build-time | Dead-code eliminates the entire cron scheduling module |
| `tengu_kairos_cron` (GrowthBook) | Runtime, 5-min refresh | Fleet-wide kill switch for cron tools (default: `true`) |
| `tengu_kairos_cron_durable` (GrowthBook) | Runtime | Kill switch for durable (disk-persistent) cron tasks |
| `CLAUDE_CODE_DISABLE_CRON` | Env var | Local override to disable cron (wins over GrowthBook) |
| `tengu_surreal_dali` (GrowthBook) | Runtime | Enables `RemoteTrigger` tool |
| `allow_remote_sessions` | Policy | Required for `RemoteTrigger` |
| `feature('KAIROS')` / `feature('KAIROS_CHANNELS')` | Build-time | When active with `--channels`, disables plan mode tools |
| `feature('TRANSCRIPT_CLASSIFIER')` | Build-time | Enables auto-mode state management during plan mode transitions |
| `feature('VERIFICATION_AGENT')` + `tengu_hive_evidence` | Build-time + runtime | Enables verification nudge in TodoWrite |
| `isTodoV2Enabled()` | Runtime | Disables TodoWriteTool when the v2 task system is active |

---

## Edge Cases & Caveats

- **Plan mode is a trap when channels are active**: Both `EnterPlanMode` and `ExitPlanMode` are disabled when `--channels` is set with allowed channels, because the approval dialog requires the local terminal.

- **ExitPlanMode outside plan mode**: If called when the permission mode is not `'plan'`, returns an error with analytics logging. This can happen after plan approval when context is compacted/cleared and the tool list still includes `ExitPlanMode`.

- **Worktree scope is session-only**: `ExitWorktree` only operates on worktrees created by `EnterWorktree` in the current session. Manually created worktrees or worktrees from previous sessions are untouched — this is a deliberate safety boundary.

- **Worktree dirty check fail-closed**: `countWorktreeChanges()` returns `null` when git commands fail (lock file, corrupt index, bad ref, or hook-based worktree without `originalHeadCommit`). The tool treats `null` as "unknown, assume unsafe" and refuses removal without `discard_changes: true`.

- **Cron minute jitter**: The scheduler adds deterministic jitter (up to 10% of period for recurring, up to 90s for one-shot tasks at :00/:30) to avoid fleet-wide API thundering herds. The prompt instructs the model to avoid :00 and :30 minute marks.

- **Cron max jobs**: Limited to 50 concurrent scheduled jobs per session.

- **Durable crons disallowed for teammates**: Teammate agents cannot create durable crons because teammates don't persist across sessions — the `agentId` would become orphaned on restart.

- **SyntheticOutputTool schema caching**: Uses `WeakMap` identity caching on the schema object reference. Different object references with identical content will not share the cache. This is intentional — workflow scripts typically reuse the same schema object reference across calls.

- **TodoWrite auto-clear**: When every todo in the submitted list has `status: 'completed'`, the tool clears the entire list (sets it to `[]`) rather than keeping completed items.