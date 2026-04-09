# StopHooks

## Overview & Responsibilities

The StopHooks module (`src/query/stopHooks.ts`) orchestrates the end-of-turn lifecycle logic that runs every time the model finishes generating a response. It sits within the **QueryEngine** subsystem and acts as a post-processing pipeline — after Claude produces an assistant message, `handleStopHooks` determines what background work to fire, which user-defined hooks to execute, and whether the query loop should continue or terminate.

Within the broader architecture, StopHooks is a peer to the query loop's message-sending and tool-dispatch logic. It receives the full conversation state (messages, system prompt, tool context) and produces a stream of events plus a final verdict: either the loop continues (possibly with blocking errors injected as messages), or it stops.

## Key Processes

### 1. Cache-Safe Parameter Snapshot

Before any hooks run, the module snapshots the current conversation context into "cache-safe params" — a serialized form that the REPL `/btw` command and SDK `side_question` control requests can read later. This only happens for main-thread queries (`repl_main_thread` or `sdk`), preventing subagents from overwriting the snapshot.

> `src/query/stopHooks.ts:92-98`

### 2. Job Classification (Templates Feature)

When the `TEMPLATES` feature flag is enabled and the session is running as a dispatched job (`CLAUDE_JOB_DIR` env var set), the module invokes `classifyAndWriteState()` to update job state after each turn. This ensures `claude list` shows current status. A 60-second timeout prevents the classifier from blocking the turn indefinitely.

> `src/query/stopHooks.ts:108-132`

### 3. Fire-and-Forget Background Tasks

Unless the session is in bare/simple mode (`--bare` flag or equivalent), three background tasks are launched as fire-and-forget promises:

- **Prompt Suggestions** — `executePromptSuggestion()` suggests follow-up prompts to the user. Gated by the `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` env var.
- **Memory Extraction** — `executeExtractMemories()` auto-saves conversation insights to the memdir. Only runs when the `EXTRACT_MEMORIES` feature is enabled, the session isn't a subagent, and extract mode is active.
- **Auto-Dream** — `executeAutoDream()` runs background dream execution. Only for main agents (not subagents).

> `src/query/stopHooks.ts:136-157`

### 4. Computer Use Cleanup (Chicago MCP)

When the `CHICAGO_MCP` feature is enabled, the module calls `cleanupComputerUseAfterTurn()` to auto-unhide windows and release CU locks. This only runs on the main thread — subagents don't start CU sessions, and releasing locks from a subagent would break the main thread's cleanup flow.

> `src/query/stopHooks.ts:164-173`

### 5. Stop Hook Execution (User-Defined Shell Commands)

This is the core of the module. User-configured stop hooks (shell commands that run after each assistant turn) are executed via `executeStopHooks()`, which returns an async generator of progress updates, attachment results, and blocking errors.

The consumption loop (`src/query/stopHooks.ts:200-295`) tracks:

| Tracked State | Purpose |
|---|---|
| `stopHookToolUseID` | Associates hook output with a tool use ID for UI rendering |
| `hookCount` | Number of hooks executed |
| `hookErrors` | Stderr/exit-code messages from failed hooks |
| `hookInfos` | Per-hook command, prompt text, and duration |
| `hasOutput` | Whether any hook produced stdout/stderr |
| `preventedContinuation` | Whether a hook signaled the query loop should stop |

Hook results are categorized by attachment type:
- `hook_non_blocking_error` — Hook failed but doesn't block the model
- `hook_error_during_execution` — Execution-level error
- `hook_success` — Successful hook, may have stdout/stderr output
- `hook_stopped_continuation` — Hook explicitly prevents the query loop from continuing

After all hooks complete, if any ran, a summary message is yielded via `createStopHookSummaryMessage()`. If errors occurred, a notification is added (visible via Ctrl+O transcript toggle).

**Abort handling**: At any point during hook execution, if the abort signal fires, the function immediately yields a user interruption message and returns `{ preventContinuation: true }`.

### 6. Teammate Hooks (TaskCompleted + TeammateIdle)

If the current session is a teammate (detected via `isTeammate()`), two additional hook types execute after stop hooks pass:

1. **TaskCompleted hooks** (`src/query/stopHooks.ts:346-400`) — For each in-progress task owned by this teammate (fetched via `listTasks()`), `executeTaskCompletedHooks()` runs. This notifies the coordinator that a task may be done.

2. **TeammateIdle hooks** (`src/query/stopHooks.ts:402-441`) — `executeTeammateIdleHooks()` runs to signal the teammate has gone idle. Both hook types follow the same consumption pattern as stop hooks: yielding progress/attachment messages, collecting blocking errors, and respecting `preventContinuation`.

### 7. Return Value — Loop Continuation Decision

The function returns a `StopHookResult`:

```typescript
type StopHookResult = {
  blockingErrors: Message[]      // Errors injected back into the conversation
  preventContinuation: boolean   // If true, the query loop should terminate
}
```

The query loop terminates when:
- Any hook sets `preventContinuation` to true
- The abort signal fires during hook execution

The query loop continues (possibly with injected error context) when:
- Blocking errors exist but continuation isn't prevented — errors are fed back as messages for the model to address
- All hooks pass cleanly — returns `{ blockingErrors: [], preventContinuation: false }`

### Error Handling

The entire hook execution is wrapped in a try/catch (`src/query/stopHooks.ts:175-472`). If an unexpected error occurs:
- An analytics event (`tengu_stop_hook_error`) is logged with duration and query tracking info
- A warning system message is yielded for debugging (not visible to the model)
- The function returns `{ blockingErrors: [], preventContinuation: false }` — gracefully allowing the loop to continue

## Function Signature

### `handleStopHooks(...): AsyncGenerator<StreamEvent | ..., StopHookResult>`

The sole export. An async generator that yields stream events during execution and returns a `StopHookResult` on completion.

| Parameter | Type | Description |
|---|---|---|
| `messagesForQuery` | `Message[]` | Messages from the current query iteration |
| `assistantMessages` | `AssistantMessage[]` | Assistant responses from this turn |
| `systemPrompt` | `SystemPrompt` | The active system prompt |
| `userContext` | `{ [k: string]: string }` | User-provided context key-value pairs |
| `systemContext` | `{ [k: string]: string }` | System-level context key-value pairs |
| `toolUseContext` | `ToolUseContext` | Rich context object providing abort controller, app state, agent ID, notifications, etc. |
| `querySource` | `QuerySource` | Origin of the query (e.g., `repl_main_thread`, `sdk`) |
| `stopHookActive` | `boolean?` | Optional flag indicating whether a stop hook is already running (prevents recursion) |

## Type Definitions

### `StopHookResult`

Defined locally at `src/query/stopHooks.ts:60-63`:

```typescript
type StopHookResult = {
  blockingErrors: Message[]
  preventContinuation: boolean
}
```

### `REPLHookContext`

The context object assembled from the function parameters and passed to all hook executors and background tasks. Contains `messages`, `systemPrompt`, `userContext`, `systemContext`, `toolUseContext`, and `querySource`.

## Configuration & Feature Gates

| Gate / Env Var | Controls |
|---|---|
| `feature('EXTRACT_MEMORIES')` | Enables memory extraction (conditional `require()` at module level) |
| `feature('TEMPLATES')` | Enables job classification (conditional `require()` at module level) |
| `feature('CHICAGO_MCP')` | Enables computer-use cleanup after each turn |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | When set to a falsy value, disables prompt suggestions |
| `CLAUDE_JOB_DIR` | When set, activates job classifier for template jobs |
| `isBareMode()` | When true, skips all background tasks (prompt suggestion, memory extraction, auto-dream) |

The `EXTRACT_MEMORIES` and `TEMPLATES` modules are conditionally loaded via `require()` at module top-level (`src/query/stopHooks.ts:42-47`), enabling dead code elimination in builds where those features are disabled.

## Edge Cases & Caveats

- **Subagent isolation**: Cache-safe params are only saved for `repl_main_thread` / `sdk` sources. Job classification, memory extraction, auto-dream, and computer-use cleanup all skip when `toolUseContext.agentId` is set, preventing subagents from interfering with main-thread state.
- **Bare mode**: The `--bare` flag disables all background bookkeeping. This is intentional for scripted `-p` invocations where forked agents contending for resources during shutdown would be problematic.
- **Graceful degradation**: Uncaught errors in the hook pipeline are logged and swallowed — the query loop always continues rather than crashing.
- **Abort during hooks**: If the user interrupts (Ctrl+C) while hooks are executing, the function short-circuits immediately with `preventContinuation: true`.
- **Hook timeout for job classifier**: The job classifier is race-limited to 60 seconds to prevent blocking the turn indefinitely.
- **Computer-use lock safety**: CU cleanup is restricted to the main thread because the lock is process-wide; releasing it from a subagent would cause the main thread to skip exit notifications.