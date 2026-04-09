# QueryEngine Class

## Overview & Responsibilities

The `QueryEngine` class is the central orchestrator for SDK and headless conversations in Claude Code. It owns the entire query lifecycle — from accepting a user prompt, through building system prompts, sending messages to the Claude API, processing streaming responses and tool calls, to yielding structured SDK messages back to the caller.

Within the top-level architecture, QueryEngine sits between the **TerminalUI** (which submits user prompts) and the **Services** layer (which handles the Claude API client and context compaction). It dispatches tool calls to the **ToolSystem** and receives memory/context from the **MemorySystem**. Both the REPL and remote/bridge entry points create QueryEngine instances to drive conversations.

One `QueryEngine` instance exists per conversation. Each call to `submitMessage()` starts a new turn within that conversation, while state (messages, file cache, token usage, permission denials) persists across turns.

## Key Processes

### Turn Lifecycle (`submitMessage()`)

The `submitMessage()` method is an async generator that drives a complete turn. The high-level flow:

1. **Configuration extraction** — Destructures the engine's config for the current turn, clears per-turn skill discovery tracking, and sets the working directory (`src/QueryEngine.ts:213-239`).

2. **Permission denial tracking** — Wraps the caller-provided `canUseTool` function to intercept and record every tool permission denial into `this.permissionDenials` (`src/QueryEngine.ts:244-271`).

3. **System prompt assembly** — Fetches default system prompt parts via `fetchSystemPromptParts()`, injects coordinator context if in coordinator mode, optionally loads memory mechanics prompt when `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` is set, and combines everything (custom prompt, memory prompt, append prompt) into the final system prompt (`src/QueryEngine.ts:284-325`).

4. **Orphaned permission handling** — On the first turn, if an orphaned permission exists, yields messages from `handleOrphanedPermission()` before processing user input (`src/QueryEngine.ts:398-408`).

5. **User input processing** — Calls `processUserInput()` which parses the prompt, handles slash commands, resolves attachments, and determines whether a query to Claude is needed (`shouldQuery` flag) (`src/QueryEngine.ts:410-428`).

6. **Transcript persistence** — Records the user message(s) to the session transcript before entering the query loop. This ensures resumability even if the process is killed before an API response arrives. In bare mode, this is fire-and-forget for performance (`src/QueryEngine.ts:450-463`).

7. **System init message** — Yields a `buildSystemInitMessage` containing tool definitions, MCP clients, model info, permission mode, commands, agents, skills, and plugins (`src/QueryEngine.ts:540-551`).

8. **Query loop** — If `shouldQuery` is true, enters the core `query()` loop which streams messages from the Claude API. Each yielded message is dispatched through a switch statement (`src/QueryEngine.ts:675-1049`).

9. **Result emission** — After the query loop completes, extracts the text result from the last assistant message and yields a final `result` message with cost, usage, duration, and permission denial data (`src/QueryEngine.ts:1135-1155`).

### Message Dispatch (the `switch` block)

Inside the query loop, each message from `query()` is handled by type:

| Message Type | Handling |
|---|---|
| `assistant` | Pushed to `mutableMessages`, yielded via `normalizeMessage()`, stop_reason captured |
| `user` | Pushed to `mutableMessages`, increments `turnCount` |
| `progress` | Pushed to both stores, recorded to transcript inline |
| `stream_event` | Tracks per-message usage (`message_start`/`message_delta`/`message_stop`), optionally yielded if `includePartialMessages` is true |
| `attachment` | Handles structured output extraction, max turns signal, queued commands |
| `system` | Handles snip boundaries (memory management for long sessions), compact boundaries (GC of pre-compaction messages), and API error retries |
| `tombstone` | Silently skipped (control signal for message removal) |
| `tool_use_summary` | Yielded directly to SDK |

### Token Usage Tracking

Usage is tracked at two levels:
- **Per-message**: `currentMessageUsage` is reset on each `message_start` stream event, updated on `message_delta`, and accumulated into the total on `message_stop` (`src/QueryEngine.ts:789-816`).
- **Per-engine**: `this.totalUsage` accumulates across all turns and is included in every result message.

### Budget & Limit Enforcement

After processing each message from the query loop, three limits are checked:

1. **USD budget** (`maxBudgetUsd`) — If `getTotalCost()` exceeds the budget, yields an `error_max_budget_usd` result and returns (`src/QueryEngine.ts:972-1002`).
2. **Max turns** — Signaled via an `attachment` with `type: 'max_turns_reached'`, yields `error_max_turns` (`src/QueryEngine.ts:842-874`).
3. **Structured output retries** — Counts `StructuredOutput` tool calls this query; if exceeding `MAX_STRUCTURED_OUTPUT_RETRIES` (default 5), yields `error_max_structured_output_retries` (`src/QueryEngine.ts:1004-1048`).

### Compact Boundary & Memory Management

When the conversation exceeds context window limits, the services layer triggers compaction. QueryEngine handles this by:
- Flushing pre-compaction messages to transcript before the boundary (`src/QueryEngine.ts:701-715`)
- Splicing `mutableMessages` and `messages` arrays to release pre-compaction entries for garbage collection (`src/QueryEngine.ts:926-933`)
- Yielding the compact boundary with metadata to the SDK caller

The snip replay mechanism (feature-gated behind `HISTORY_SNIP`) provides an additional memory-bounding strategy for long SDK sessions, injected via the `snipReplay` config callback (`src/QueryEngine.ts:905-915`).

## Function Signatures

### `constructor(config: QueryEngineConfig)`

Creates a new engine instance. Initializes `mutableMessages` from `config.initialMessages` (or empty), creates an abort controller, and sets usage to `EMPTY_USAGE`.

### `async *submitMessage(prompt, options?): AsyncGenerator<SDKMessage>`

The primary entry point for each conversation turn.

- **prompt**: `string | ContentBlockParam[]` — The user's message, either plain text or structured content blocks.
- **options.uuid**: `string` — Optional UUID for the message.
- **options.isMeta**: `boolean` — Whether this is a synthetic/meta message.
- **Yields**: `SDKMessage` — A union type covering `assistant`, `user`, `result`, `system`, `stream_event`, and `tool_use_summary` messages.

### `interrupt(): void`

Aborts the current query by calling `abort()` on the engine's `AbortController` (`src/QueryEngine.ts:1158-1160`).

### `getMessages(): readonly Message[]`

Returns the current conversation history (`src/QueryEngine.ts:1162-1164`).

### `getReadFileState(): FileStateCache`

Returns the current file state cache, used for tracking file read state across turns (`src/QueryEngine.ts:1166-1168`).

### `getSessionId(): string`

Returns the session identifier (`src/QueryEngine.ts:1170-1172`).

### `setModel(model: string): void`

Overrides the model for subsequent turns (`src/QueryEngine.ts:1174-1176`).

## Type Definitions

### `QueryEngineConfig`

The configuration object passed to the constructor (`src/QueryEngine.ts:130-173`):

| Field | Type | Required | Description |
|---|---|---|---|
| `cwd` | `string` | Yes | Working directory for the conversation |
| `tools` | `Tools` | Yes | Available tool definitions |
| `commands` | `Command[]` | Yes | Registered slash commands |
| `mcpClients` | `MCPServerConnection[]` | Yes | Active MCP server connections |
| `agents` | `AgentDefinition[]` | Yes | Available agent definitions |
| `canUseTool` | `CanUseToolFn` | Yes | Permission check callback |
| `getAppState` / `setAppState` | Functions | Yes | Application state accessors |
| `initialMessages` | `Message[]` | No | Pre-existing conversation history |
| `readFileCache` | `FileStateCache` | Yes | File state cache for deduplication |
| `customSystemPrompt` | `string` | No | Replaces the default system prompt entirely |
| `appendSystemPrompt` | `string` | No | Appended after the system prompt |
| `userSpecifiedModel` | `string` | No | Override the default model |
| `fallbackModel` | `string` | No | Model to fall back to on errors |
| `thinkingConfig` | `ThinkingConfig` | No | Thinking/reasoning mode configuration |
| `maxTurns` | `number` | No | Maximum agentic turns before stopping |
| `maxBudgetUsd` | `number` | No | Maximum spend in USD |
| `taskBudget` | `{ total: number }` | No | Task-level budget constraint |
| `jsonSchema` | `Record<string, unknown>` | No | Enforces structured output via a JSON schema |
| `verbose` | `boolean` | No | Enable verbose logging |
| `replayUserMessages` | `boolean` | No | Yield user messages back as replays |
| `includePartialMessages` | `boolean` | No | Yield raw stream events |
| `handleElicitation` | Function | No | Handler for MCP elicitation flows |
| `setSDKStatus` | Function | No | Callback for status updates |
| `abortController` | `AbortController` | No | External abort controller |
| `orphanedPermission` | `OrphanedPermission` | No | Permission from a previous interrupted turn |
| `snipReplay` | Function | No | Feature-gated snip boundary handler |

## The `ask()` Convenience Wrapper

The module also exports an `ask()` async generator function (`src/QueryEngine.ts:1186-1295`) that provides a one-shot convenience wrapper around `QueryEngine`. It:

1. Creates a `QueryEngine` instance from flat parameters
2. Calls `submitMessage()` once with the provided prompt
3. Restores the file state cache in a `finally` block
4. Injects the `snipReplay` callback when the `HISTORY_SNIP` feature flag is enabled

This is the primary entry point for non-interactive/headless callers that need a single prompt-response cycle.

## Edge Cases & Caveats

- **Orphaned permissions are handled once**: The `hasHandledOrphanedPermission` flag ensures orphaned permission processing only runs on the first `submitMessage()` call, preventing duplicate handling across turns.

- **Transcript persistence timing**: User messages are persisted to transcript *before* the query loop starts. This prevents lost conversations when the process is killed before an API response. In bare mode (`--bare`), transcript writes are fire-and-forget to avoid blocking the critical path.

- **Eager flush for cowork**: When `CLAUDE_CODE_EAGER_FLUSH` or `CLAUDE_CODE_IS_COWORK` environment variables are set, transcript storage is flushed synchronously at result boundaries to prevent data loss when the desktop app kills the CLI process immediately after receiving a result.

- **Assistant transcript writes are fire-and-forget**: Since `claude.ts` yields one assistant message per content block then mutates usage/stop_reason on `message_delta`, awaiting each write would block the generator. The write queue's order-preserving semantics make fire-and-forget safe here (`src/QueryEngine.ts:727-728`).

- **Stop reason arrives late**: The assistant message is yielded at `content_block_stop` with `stop_reason=null`. The actual stop reason only arrives via the `message_delta` stream event, so it's captured separately and used in the final result message.

- **Compact boundary GC**: After yielding a compact boundary, the engine splices both `mutableMessages` and the local `messages` array to release pre-compaction entries for garbage collection, preventing unbounded memory growth in long sessions.

- **Lazy MessageSelector import**: `MessageSelector.tsx` pulls in React/Ink and is lazily required to avoid loading the UI framework in headless mode (`src/QueryEngine.ts:87-89`).

- **Feature-gated imports**: Coordinator mode and snip compaction use `feature()` from `bun:bundle` for dead code elimination, with conditional `require()` calls to keep excluded strings out of the bundle (`src/QueryEngine.ts:112-128`).