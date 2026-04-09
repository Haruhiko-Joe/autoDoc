# QueryLoop

## Overview & Responsibilities

The QueryLoop is the core async generator that drives every AI conversation in Claude Code. It sits inside the **QueryEngine** module and orchestrates the full lifecycle of a single user turn: sending messages to the Claude API, streaming responses, executing tool calls, recovering from errors, compacting context when it grows too large, and auto-continuing when a token budget is set. Every interaction surface — the REPL, SDK, bridge, and remote sessions — funnels through this single `query()` entry point.

The module is split across four files:

| File | Purpose |
|------|--------|
| `src/query.ts` | The main `query()` and `queryLoop()` async generators |
| `src/query/config.ts` | `QueryConfig` — immutable per-query settings snapshot |
| `src/query/deps.ts` | `QueryDeps` — injectable I/O dependencies for testing |
| `src/query/tokenBudget.ts` | `BudgetTracker` — auto-continuation token budget logic |

## Key Processes

### Entry Point: `query()` → `queryLoop()`

The public `query()` generator (`src/query.ts:219-239`) is a thin wrapper around `queryLoop()`. Its only added responsibility is **command lifecycle tracking**: it collects UUIDs of consumed slash commands and notifies them as `'completed'` when the loop returns normally. If the loop throws or the generator is closed via `.return()`, completion notifications are skipped — matching the asymmetric started/completed signal design.

### Main Loop Structure

`queryLoop()` (`src/query.ts:241-1729`) runs an infinite `while (true)` loop. Each iteration represents one API round-trip. The loop continues when the model requests tool use, hits `max_output_tokens`, or a stop hook injects blocking errors. It terminates when the model produces a final response with no tool calls, an unrecoverable error occurs, the user aborts, or `maxTurns` is reached.

Mutable state is bundled into a single `State` struct (`src/query.ts:204-217`) that is replaced wholesale at each `continue` site, making the transition reasons explicit and testable via `state.transition`.

### Per-Iteration Pipeline

Each loop iteration follows this sequence:

1. **Snip compaction** — If the `HISTORY_SNIP` feature is enabled, `snipCompactIfNeeded()` removes old messages that exceed a threshold (`src/query.ts:401-410`)
2. **Microcompact** — `deps.microcompact()` compresses tool results in-place, reducing token count without an API call (`src/query.ts:414-426`)
3. **Context collapse** — If `CONTEXT_COLLAPSE` is enabled, `applyCollapsesIfNeeded()` projects a collapsed view of history (`src/query.ts:440-447`)
4. **Auto-compaction** — `deps.autocompact()` may trigger a full summarization API call if context exceeds thresholds. On success, all messages are replaced with a compact summary (`src/query.ts:454-543`)
5. **Blocking limit check** — If auto-compact is disabled, checks whether the context is at a hard blocking limit and exits early with `PROMPT_TOO_LONG_ERROR_MESSAGE` (`src/query.ts:628-648`)
6. **API streaming call** — Calls `deps.callModel()` and streams response chunks, collecting `AssistantMessage`s and `ToolUseBlock`s (`src/query.ts:659-863`)
7. **Tool execution** — Either via `StreamingToolExecutor` (starts tools during streaming) or `runTools()` (batch after streaming completes) (`src/query.ts:1366-1408`)
8. **Attachment injection** — Memory prefetch results, queued commands, skill discovery, and file-change notifications are attached as messages for the next turn (`src/query.ts:1580-1628`)
9. **Continue or terminate** — The loop either sets `state` to a new `State` and `continue`s, or `return`s a `Terminal` reason

### Error Recovery Flows

**Prompt-too-long (413) recovery** (`src/query.ts:1062-1183`):
- The error is *withheld* from the yielded stream during streaming
- First attempts context-collapse drain (if `CONTEXT_COLLAPSE` enabled)
- Falls back to reactive compact (full re-summarization)
- If both fail, surfaces the error and returns `{ reason: 'prompt_too_long' }`

**Max-output-tokens recovery** (`src/query.ts:1188-1256`):
- First tries escalation: if using the default 8k cap, retries at 64k (`ESCALATED_MAX_TOKENS`) without any meta message (`src/query.ts:1199-1221`)
- Then enters multi-turn recovery: injects a nudge message telling the model to resume without recap, up to `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` (3) attempts (`src/query.ts:1223-1252`)
- If all recovery attempts exhaust, the withheld error is surfaced

**Model fallback** (`src/query.ts:893-953`):
- On `FallbackTriggeredError`, switches to `fallbackModel`, tombstones orphaned messages, strips thinking signatures, and retries

**Streaming fallback** (`src/query.ts:712-741`):
- If the streaming callback fires `onStreamingFallback`, clears all accumulated messages and restarts collection from the fallback response

### Token Budget Auto-Continuation

When the `TOKEN_BUDGET` feature is enabled and a budget is set, the loop checks `checkTokenBudget()` after the model stops naturally (`src/query.ts:1308-1355`). If the model has used less than 90% of its budget and is not showing diminishing returns, a continuation message is injected and the loop continues. This allows long-running agentic tasks to persist without user intervention.

## Function Signatures

### `query(params: QueryParams): AsyncGenerator<StreamEvent | Message | ..., Terminal>`

The public entry point. Delegates to `queryLoop()` and handles command lifecycle notifications.

### `QueryParams`

> Source: `src/query.ts:181-199`

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `Message[]` | The conversation history |
| `systemPrompt` | `SystemPrompt` | The system prompt content |
| `userContext` | `{ [k: string]: string }` | User context prepended to messages |
| `systemContext` | `{ [k: string]: string }` | System context appended to system prompt |
| `canUseTool` | `CanUseToolFn` | Permission check callback |
| `toolUseContext` | `ToolUseContext` | Tool execution environment |
| `fallbackModel?` | `string` | Model to fall back to on overload |
| `querySource` | `QuerySource` | Origin identifier (e.g. `'repl_main_thread'`, `'agent:...'`) |
| `maxOutputTokensOverride?` | `number` | Override default max output tokens |
| `maxTurns?` | `number` | Hard limit on loop iterations |
| `skipCacheWrite?` | `boolean` | Skip prompt cache writes |
| `taskBudget?` | `{ total: number }` | API-level task budget |
| `deps?` | `QueryDeps` | Injectable I/O dependencies |

## Interface/Type Definitions

### `QueryConfig`

> Source: `src/query/config.ts:15-27`

Immutable values snapshotted once at `query()` entry. Intentionally excludes `feature()` gates (those must stay inline for tree-shaking).

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `SessionId` | Current session identifier |
| `gates.streamingToolExecution` | `boolean` | Whether to start tool execution during streaming |
| `gates.emitToolUseSummaries` | `boolean` | Whether to generate Haiku summaries of tool use |
| `gates.isAnt` | `boolean` | Whether the user is an Anthropic employee |
| `gates.fastModeEnabled` | `boolean` | Whether fast mode is allowed |

Built by `buildQueryConfig()` (`src/query/config.ts:29-46`), which reads from Statsig cached gates and environment variables.

### `QueryDeps`

> Source: `src/query/deps.ts:21-31`

Injectable I/O dependencies using `typeof` to keep signatures in sync with real implementations.

| Field | Type | Description |
|-------|------|-------------|
| `callModel` | `typeof queryModelWithStreaming` | Sends messages to the Claude API |
| `microcompact` | `typeof microcompactMessages` | In-place message compression |
| `autocompact` | `typeof autoCompactIfNeeded` | Full context summarization |
| `uuid` | `() => string` | UUID generator (for query chain IDs and tracking) |

Production defaults provided by `productionDeps()` (`src/query/deps.ts:33-40`). Tests inject fakes via the `deps` field of `QueryParams`.

### `BudgetTracker`

> Source: `src/query/tokenBudget.ts:6-11`

Tracks auto-continuation state across budget check calls.

| Field | Type | Description |
|-------|------|-------------|
| `continuationCount` | `number` | How many times the budget check has continued |
| `lastDeltaTokens` | `number` | Token delta from the previous check |
| `lastGlobalTurnTokens` | `number` | Cumulative tokens at last check |
| `startedAt` | `number` | Timestamp for duration tracking |

### `TokenBudgetDecision`

> Source: `src/query/tokenBudget.ts:22-43`

Discriminated union returned by `checkTokenBudget()`: either `{ action: 'continue', nudgeMessage, ... }` or `{ action: 'stop', completionEvent }`. The `completionEvent` is non-null only when at least one continuation occurred (used for analytics).

### `checkTokenBudget(tracker, agentId, budget, globalTurnTokens): TokenBudgetDecision`

> Source: `src/query/tokenBudget.ts:45-93`

Decides whether to auto-continue based on:
- **Completion threshold**: continues if `turnTokens < budget * 0.9` (`COMPLETION_THRESHOLD`)
- **Diminishing returns**: stops if 3+ continuations have occurred and the last two deltas were both below 500 tokens (`DIMINISHING_THRESHOLD`)
- **Agent exclusion**: always returns `'stop'` for subagents (`agentId` is set)
- **No budget**: always returns `'stop'` when `budget` is null or ≤ 0

### `State` (internal)

> Source: `src/query.ts:204-217`

Mutable state carried between loop iterations, destructured at the top of each iteration. Notable fields:
- `transition`: records *why* the previous iteration continued (e.g. `'next_turn'`, `'max_output_tokens_recovery'`, `'reactive_compact_retry'`), enabling test assertions on recovery paths
- `hasAttemptedReactiveCompact`: prevents infinite compact-retry loops
- `maxOutputTokensRecoveryCount`: tracks multi-turn recovery attempts (max 3)
- `stopHookActive`: set to `true` when re-entering the loop due to a stop-hook blocking error

## Configuration & Defaults

| Constant | Value | Location | Description |
|----------|-------|----------|-------------|
| `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` | 3 | `src/query.ts:164` | Max multi-turn recovery attempts for output truncation |
| `COMPLETION_THRESHOLD` | 0.9 | `src/query/tokenBudget.ts:3` | Budget fraction below which auto-continuation fires |
| `DIMINISHING_THRESHOLD` | 500 | `src/query/tokenBudget.ts:4` | Minimum token delta to avoid diminishing-returns stop |

Environment variables consumed:
- `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` — enables Haiku-generated tool use summaries
- `USER_TYPE` — `'ant'` enables dump-prompts fetch and thinking-signature stripping
- `CLAUDE_CODE_DISABLE_FAST_MODE` — disables fast mode
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — when set, prevents the escalation retry path

## Edge Cases & Caveats

- **Withheld error messages**: Recoverable errors (`prompt_too_long`, `max_output_tokens`, media size errors) are *withheld* from the yielded stream during streaming. They're still pushed to `assistantMessages` so recovery logic can find them, but SDK consumers don't see them unless recovery fails. This prevents SDK callers (desktop, cowork) from terminating the session on an intermediate error.

- **Thinking block rules**: The code comments (`src/query.ts:152-163`) warn about three strict API rules for thinking blocks: they require `max_thinking_length > 0`, cannot be the last content block, and must be preserved within an assistant trajectory. Violating these causes API errors.

- **Task budget tracking across compaction**: `taskBudgetRemaining` is loop-local (not on `State`) and tracks cumulative spend across compaction boundaries. Before the first compact, the server handles budget countdown from the full history. After a compact, the server only sees the summary, so `remaining` must be passed explicitly (`src/query.ts:285-291`).

- **Stop-hook reactive compact guard**: `hasAttemptedReactiveCompact` is preserved across stop-hook retry transitions to prevent an infinite loop: compact → still too long → error → stop hook blocking → compact → ... (`src/query.ts:1293-1296`).

- **Agent-scoped queue draining**: The message queue is process-global but each loop iteration only drains commands addressed to its own `agentId`. The main thread drains `agentId === undefined`; subagents drain only their own `agentId` with `mode === 'task-notification'` (`src/query.ts:1560-1578`).

- **Streaming tool execution**: When `streamingToolExecution` gate is enabled, tools begin executing *during* API streaming via `StreamingToolExecutor`. If a streaming fallback occurs, the executor is discarded and recreated to prevent orphan `tool_result` blocks with stale `tool_use_id`s (`src/query.ts:733-740`).