# Compaction

## Overview & Responsibilities

The Compaction module (`src/services/compact/`) is the context management engine for Claude Code. As conversations grow, they eventually exceed the model's context window — this module ensures the session can continue indefinitely by summarizing older messages and freeing token headroom. It sits within the **Services** layer, invoked by the **QueryEngine** (via auto-compact on each turn) and the **CommandSystem** (via the manual `/compact` command).

The module implements a layered compaction strategy, from lightweight inline cleanup to full conversation summarization:

1. **Auto-compact** — proactive full compaction triggered when token usage crosses a threshold
2. **Micro-compact** — lightweight, inline tool-result clearing (three variants: cached, time-based, API-based)
3. **Session memory compaction** — uses the session memory system's running summary instead of generating a new one
4. **Partial compact** — user-initiated compaction of a selected portion of the conversation
5. **Post-compact cleanup** — cache/state invalidation after any compaction path

## Key Processes

### Auto-Compact Flow

The primary automatic compaction path, orchestrated by `autoCompactIfNeeded()` (`src/services/compact/autoCompact.ts:241-351`):

1. **Guard checks**: Skips if compaction is disabled, if the caller is a forked agent (`session_memory`, `compact`, `marble_origami`), if reactive-compact or context-collapse mode is active, or if the circuit breaker has tripped (3+ consecutive failures).

2. **Threshold evaluation** (`shouldAutoCompact`, line 160-239): Estimates token count via `tokenCountWithEstimation()`, subtracts any tokens freed by snip, and compares against the auto-compact threshold. The threshold is `effectiveContextWindow - 13,000` tokens (the `AUTOCOMPACT_BUFFER_TOKENS` constant).

3. **Session memory compaction attempt** (line 288-310): Tries `trySessionMemoryCompaction()` first — if session memory has a valid running summary, it's cheaper than an API call. On success, resets state and returns immediately.

4. **Full compaction** (line 312-333): Falls back to `compactConversation()`, which forks an agent to generate a summary of the entire conversation.

5. **Circuit breaker** (line 260-265, 334-349): Tracks consecutive failures. After `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` (3) failures, stops retrying for the rest of the session — this was added because some sessions had 50+ consecutive failures (up to 3,272), wasting ~250K API calls/day globally.

### Full Compaction (`compactConversation`)

The core compaction function (`src/services/compact/compact.ts:387-763`):

1. **Pre-compact hooks**: Executes `PreCompact` hooks, merging any hook-provided custom instructions with user instructions.

2. **Summary generation**: Builds a compaction prompt via `getCompactPrompt()` and sends the conversation to the model. Uses a **forked agent** path by default to reuse the main conversation's prompt cache (controlled by the `tengu_compact_cache_prefix` feature flag, defaulting to `true`). Falls back to direct streaming if the fork fails.

3. **Prompt-too-long retry loop** (line 450-491): If the compaction request itself exceeds the prompt limit, `truncateHeadForPTLRetry()` drops the oldest API-round groups and retries up to 3 times.

4. **Post-compact reconstruction** (line 517-584):
   - Clears the file read cache and loaded memory paths
   - Re-creates file attachments for recently-read files (up to 5 files, 50K token budget)
   - Re-injects plan state, skill content, deferred tools, agent listings, and MCP instructions
   - Runs `SessionStart` hooks

5. **Boundary marker creation** (line 598-611): Creates a `SystemCompactBoundaryMessage` marking the compaction point, carrying metadata like pre-compact token count, discovered tool names, and preserved segment pointers.

6. **Summary message** (line 614-624): Wraps the model's summary in a structured user message via `getCompactUserSummaryMessage()`, including a transcript path for accessing pre-compaction details.

### Micro-Compact Flow

Lightweight compaction that runs on every turn *before* the API call, clearing old tool results without generating a summary (`src/services/compact/microCompact.ts:253-293`):

```
microcompactMessages() → time-based path OR cached MC path OR no-op
```

**Time-based micro-compact** (`src/services/compact/microCompact.ts:446-530`): Fires when the gap since the last assistant message exceeds a configurable threshold (default: 60 minutes, matching the server's cache TTL). Since the cache is cold anyway, it content-clears all but the most recent N tool results by replacing their content with `'[Old tool result content cleared]'`. Only applies to compactable tools (file read, shell, grep, glob, web fetch/search, file edit/write).

**Cached micro-compact** (`src/services/compact/microCompact.ts:305-399`): Uses the cache editing API to remove tool results server-side without invalidating the cached prefix. Tracks tool results via `CachedMCState`, queues `cache_edits` blocks for the API layer, and produces no local message mutations. Only runs for the main thread and supported models.

### API-Based Micro-Compact

Server-side context management via the `context_management` API parameter (`src/services/compact/apiMicrocompact.ts:64-153`):

Builds a `ContextManagementConfig` with edit strategies:
- **`clear_tool_uses_20250919`**: Clears tool result content or entire tool use blocks when input tokens exceed a threshold, targeting specific tool types
- **`clear_thinking_20251015`**: Preserves or clears thinking blocks from previous assistant turns

Configuration is controlled by environment variables (`USE_API_CLEAR_TOOL_RESULTS`, `USE_API_CLEAR_TOOL_USES`, `API_MAX_INPUT_TOKENS`, `API_TARGET_INPUT_TOKENS`). Tool clearing strategies are restricted to internal users (`USER_TYPE === 'ant'`).

### Session Memory Compaction

An alternative to API-based summary generation (`src/services/compact/sessionMemoryCompact.ts:514-630`):

1. **Eligibility**: Requires both `tengu_session_memory` and `tengu_sm_compact` feature flags. Checks that session memory exists and contains actual extracted content (not just the empty template).

2. **Message preservation**: Calculates which recent messages to keep using `calculateMessagesToKeepIndex()` (`src/services/compact/sessionMemoryCompact.ts:324-397`), which expands backwards from the last summarized message until meeting minimum thresholds:
   - At least 10,000 tokens (`minTokens`)
   - At least 5 messages with text blocks (`minTextBlockMessages`)
   - Hard cap at 40,000 tokens (`maxTokens`)

3. **API invariant preservation** (`adjustIndexToPreserveAPIInvariants`, `src/services/compact/sessionMemoryCompact.ts:232-314`): Ensures the split point doesn't orphan `tool_use`/`tool_result` pairs or separate thinking blocks that share a `message.id` with kept assistant messages.

4. **Result construction**: Uses the session memory content as the summary (truncating oversized sections), wraps it in the standard compaction result format with boundary markers and preserved message segments.

### Partial Compaction

User-directed compaction of a selected conversation portion (`src/services/compact/compact.ts:772-1106`):

Two directions:
- **`from`** (default): Summarizes messages *after* the pivot index, keeps earlier messages. Preserves prompt cache for the kept prefix.
- **`up_to`**: Summarizes messages *before* the pivot index, keeps later messages. Invalidates prompt cache since the summary precedes kept messages.

Uses the same streaming/forked-agent infrastructure as full compaction, with direction-specific prompts from `getPartialCompactPrompt()`.

### Message Grouping

`groupMessagesByApiRound()` (`src/services/compact/grouping.ts:22-63`) splits the conversation into groups at API round-trip boundaries. A new group starts when a new assistant `message.id` appears. This provides fine-grained split points for the PTL retry truncation logic, enabling compaction on single-prompt agentic sessions where the entire workload is one human turn.

## Function Signatures

### Core Functions

#### `compactConversation(messages, context, cacheSafeParams, suppressFollowUpQuestions, customInstructions?, isAutoCompact?, recompactionInfo?): Promise<CompactionResult>`
Main compaction entry point. Summarizes the conversation via a forked agent or streaming API call.
> `src/services/compact/compact.ts:387`

#### `partialCompactConversation(allMessages, pivotIndex, context, cacheSafeParams, userFeedback?, direction?): Promise<CompactionResult>`
Compacts a user-selected portion of the conversation.
> `src/services/compact/compact.ts:772`

#### `autoCompactIfNeeded(messages, toolUseContext, cacheSafeParams, querySource?, tracking?, snipTokensFreed?): Promise<{wasCompacted, compactionResult?, consecutiveFailures?}>`
Entry point called by the query loop. Checks thresholds and triggers compaction if needed.
> `src/services/compact/autoCompact.ts:241`

#### `microcompactMessages(messages, toolUseContext?, querySource?): Promise<MicrocompactResult>`
Lightweight pre-request compaction. Delegates to time-based or cached MC paths.
> `src/services/compact/microCompact.ts:253`

#### `getAPIContextManagement(options?): ContextManagementConfig | undefined`
Builds the server-side context management configuration for the API request.
> `src/services/compact/apiMicrocompact.ts:64`

#### `trySessionMemoryCompaction(messages, agentId?, autoCompactThreshold?): Promise<CompactionResult | null>`
Attempts compaction using session memory content instead of an API call.
> `src/services/compact/sessionMemoryCompact.ts:514`

### Threshold & State Functions

#### `getEffectiveContextWindowSize(model): number`
Returns context window minus reserved output tokens (capped at 20K). Respects `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env override.
> `src/services/compact/autoCompact.ts:33`

#### `getAutoCompactThreshold(model): number`
Returns the token count that triggers auto-compact: `effectiveContextWindow - 13,000`. Supports `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` for testing.
> `src/services/compact/autoCompact.ts:72`

#### `calculateTokenWarningState(tokenUsage, model): {percentLeft, isAboveWarningThreshold, isAboveErrorThreshold, isAboveAutoCompactThreshold, isAtBlockingLimit}`
Computes UI warning levels based on current token usage relative to thresholds.
> `src/services/compact/autoCompact.ts:93`

#### `estimateMessageTokens(messages): number`
Rough token estimation for messages by extracting text content. Pads by 4/3 for conservative estimates.
> `src/services/compact/microCompact.ts:164`

#### `evaluateTimeBasedTrigger(messages, querySource): {gapMinutes, config} | null`
Checks whether the time-based MC trigger should fire. Returns the gap and config when it fires, null otherwise.
> `src/services/compact/microCompact.ts:422`

## Interface/Type Definitions

### `CompactionResult`
The output of any compaction operation:

| Field | Type | Description |
|-------|------|-------------|
| `boundaryMarker` | `SystemMessage` | Compact boundary marker with metadata |
| `summaryMessages` | `UserMessage[]` | The summary wrapped as user message(s) |
| `attachments` | `AttachmentMessage[]` | Re-injected file/plan/skill attachments |
| `hookResults` | `HookResultMessage[]` | Results from session start hooks |
| `messagesToKeep` | `Message[]` | Preserved recent messages (optional) |
| `preCompactTokenCount` | `number` | Token count before compaction |
| `postCompactTokenCount` | `number` | Compact API call's total usage |
| `truePostCompactTokenCount` | `number` | Estimated size of resulting context |

> `src/services/compact/compact.ts:299-310`

### `AutoCompactTrackingState`
Tracks compaction state across query loop iterations:

| Field | Type | Description |
|-------|------|-------------|
| `compacted` | `boolean` | Whether compaction occurred this chain |
| `turnCounter` | `number` | Turns since last compaction |
| `turnId` | `string` | Unique ID for the current turn |
| `consecutiveFailures` | `number` | Failure count for circuit breaker |

> `src/services/compact/autoCompact.ts:51-60`

### `MicrocompactResult`
Return type from `microcompactMessages()`:

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `Message[]` | Possibly-modified message array |
| `compactionInfo` | `object` | Optional metadata about pending cache edits |

> `src/services/compact/microCompact.ts:215-220`

### `SessionMemoryCompactConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `minTokens` | `number` | 10,000 | Minimum tokens to preserve after compaction |
| `minTextBlockMessages` | `number` | 5 | Minimum messages with text blocks to keep |
| `maxTokens` | `number` | 40,000 | Hard cap on preserved tokens |

> `src/services/compact/sessionMemoryCompact.ts:47-54`

### `TimeBasedMCConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Master switch for time-based MC |
| `gapThresholdMinutes` | `number` | 60 | Trigger after this idle gap (minutes) |
| `keepRecent` | `number` | 5 | Number of recent tool results to keep |

> `src/services/compact/timeBasedMCConfig.ts:18-28`

### `ContextEditStrategy`
Server-side context management strategy (union type):
- `clear_tool_uses_20250919` — clears tool result content or uses based on token thresholds, with configurable trigger, keep-recent, clear-at-least, tool exclusions
- `clear_thinking_20251015` — manages thinking block retention (keep all or keep N recent turns)

> `src/services/compact/apiMicrocompact.ts:35-57`

### `RecompactionInfo`
Diagnosis context passed from `autoCompactIfNeeded` into `compactConversation`:

| Field | Type | Description |
|-------|------|-------------|
| `isRecompactionInChain` | `boolean` | Whether this is a re-compaction within the same chain |
| `turnsSincePreviousCompact` | `number` | Turns elapsed since prior compaction |
| `previousCompactTurnId` | `string` | Turn ID of the previous compaction |
| `autoCompactThreshold` | `number` | The active threshold |
| `querySource` | `QuerySource` | The originating query source |

> `src/services/compact/compact.ts:317-323`

## Configuration & Defaults

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `DISABLE_COMPACT` | Disables all compaction | `false` |
| `DISABLE_AUTO_COMPACT` | Disables auto-compact only (manual `/compact` still works) | `false` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Override effective context window size | Model default |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Override auto-compact threshold as percentage | N/A |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | Override blocking limit for testing | N/A |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | Force-enable session memory compaction | `false` |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | Force-disable session memory compaction | `false` |
| `USE_API_CLEAR_TOOL_RESULTS` | Enable API-based tool result clearing (ant-only) | `false` |
| `USE_API_CLEAR_TOOL_USES` | Enable API-based tool use clearing (ant-only) | `false` |
| `API_MAX_INPUT_TOKENS` | Token threshold for API-based clearing | 180,000 |
| `API_TARGET_INPUT_TOKENS` | Target token budget after clearing | 40,000 |

### User Configuration

Auto-compact can be disabled via `autoCompactEnabled` in the user's global config (checked by `isAutoCompactEnabled()` at `src/services/compact/autoCompact.ts:147-158`).

### Key Constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | `autoCompact.ts:62` | Buffer below effective window for auto-compact trigger |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | `autoCompact.ts:63` | Buffer for UI warning display |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | `autoCompact.ts:65` | Buffer for blocking limit |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | `autoCompact.ts:30` | Reserved output tokens for summary generation |
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | `compact.ts:122` | Max files re-attached after compact |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | `compact.ts:123` | Token budget for file re-attachment |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | `compact.ts:124` | Per-file token cap for re-attachment |
| `POST_COMPACT_MAX_TOKENS_PER_SKILL` | 5,000 | `compact.ts:129` | Per-skill token cap |
| `POST_COMPACT_SKILLS_TOKEN_BUDGET` | 25,000 | `compact.ts:130` | Total budget for skill re-injection |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | `autoCompact.ts:70` | Circuit breaker threshold |
| `IMAGE_MAX_TOKEN_SIZE` | 2,000 | `microCompact.ts:38` | Estimated tokens per image/document block |

## Compaction Prompts

The prompt module (`src/services/compact/prompt.ts`) defines three prompt variants:

1. **`BASE_COMPACT_PROMPT`** — full conversation summary with 9 structured sections: primary request/intent, key technical concepts, files/code sections, errors/fixes, problem solving, all user messages, pending tasks, current work, optional next step
2. **`PARTIAL_COMPACT_PROMPT`** (direction `from`) — scoped to recent messages only, referencing "earlier retained context"
3. **`PARTIAL_COMPACT_UP_TO_PROMPT`** (direction `up_to`) — full summary positioned before kept messages, includes a "Context for Continuing Work" section instead of "Current Work"

All prompts are wrapped with:
- A `NO_TOOLS_PREAMBLE` that aggressively instructs text-only output — critical because on Sonnet 4.6+ the model sometimes attempts tool calls despite weaker instructions, and with `maxTurns: 1` a denied tool call means no text output
- An `<analysis>` block instruction as a structured drafting scratchpad (stripped by `formatCompactSummary()` before the summary reaches context)
- A `NO_TOOLS_TRAILER` reminder appended at the end

Key helper functions:
- `getCompactPrompt(customInstructions?)` — builds full compact prompt (`src/services/compact/prompt.ts:293`)
- `getPartialCompactPrompt(customInstructions?, direction?)` — builds partial compact prompt (`src/services/compact/prompt.ts:274`)
- `formatCompactSummary(summary)` — strips `<analysis>` tags, reformats `<summary>` tags into headers (`src/services/compact/prompt.ts:311`)
- `getCompactUserSummaryMessage(summary, suppressFollowUpQuestions?, transcriptPath?, recentMessagesPreserved?)` — wraps formatted summary with session continuation preamble, optional transcript link, and autonomous-mode instructions (`src/services/compact/prompt.ts:337`)

## Post-Compact Cleanup

`runPostCompactCleanup()` (`src/services/compact/postCompactCleanup.ts:31-77`) runs after every compaction path to invalidate stale caches and tracking state:

- Resets micro-compact state (cached MC tool tracking)
- Resets context collapse state (main thread only)
- Clears `getUserContext` memoization cache and memory file cache (main thread only)
- Clears system prompt sections, classifier approvals, speculative checks
- Clears beta tracing state and session messages cache
- Sweeps file content cache (for commit attribution, gated by `COMMIT_ATTRIBUTION` feature)

Notably, it does **not** clear invoked skill content — skills must survive across compactions so `createSkillAttachmentIfNeeded()` can include the full skill text in subsequent compaction attachments.

Subagent compactions (`querySource` starting with `agent:`) skip main-thread-only resets to avoid corrupting shared module-level state. The `isMainThreadCompact` check (`src/services/compact/postCompactCleanup.ts:36-39`) treats `undefined`, `repl_main_thread*`, and `sdk` sources as main-thread.

## Compact Warning State & Hook

A simple reactive state store for the UI:

**State** (`src/services/compact/compactWarningState.ts`): Uses `createStore<boolean>(false)` to track whether the "context left until autocompact" warning should be suppressed.
- `suppressCompactWarning()` — called after successful compaction to hide the warning (token counts are stale until the next API response)
- `clearCompactWarningSuppression()` — called at the start of each new micro-compact attempt

**React Hook** (`src/services/compact/compactWarningHook.ts`): `useCompactWarningSuppression()` subscribes to the store via `useSyncExternalStore`. Lives in its own file to keep `compactWarningState.ts` React-free — importing React into the micro-compact module graph would drag it into the print-mode startup path.

## Edge Cases & Caveats

- **Circuit breaker**: After 3 consecutive auto-compact failures, the system stops retrying for the entire session. This was added because BQ data from 2026-03-10 showed 1,279 sessions with 50+ consecutive failures (up to 3,272), wasting ~250K API calls/day globally.

- **Recursion guards**: Auto-compact is suppressed for `session_memory`, `compact`, and `marble_origami` (context agent) query sources to prevent deadlocks and state corruption in forked agents that share module-level state.

- **Forked agent cache sharing**: The compaction fork intentionally does **not** set `maxOutputTokens` to avoid creating a thinking config mismatch that would invalidate the main conversation's prompt cache. The streaming fallback path can safely set it since it doesn't share cache.

- **Time-based MC resets cached MC state**: After content-clearing tool results (cache miss scenario), the cached MC module-level state is reset to prevent it from trying to `cache_edit` tools whose server-side entries no longer exist.

- **Tool result pairing**: `adjustIndexToPreserveAPIInvariants()` handles the case where streaming yields separate messages per content block (thinking, tool_use) with the same `message.id`. Without this, compaction boundaries could orphan `tool_result` blocks or lose thinking blocks that need to be merged by `normalizeMessagesForAPI`.

- **Prompt-too-long in compact itself**: When the compaction request exceeds the API limit, `truncateHeadForPTLRetry()` (`src/services/compact/compact.ts:243-291`) drops oldest API-round groups and retries up to 3 times. A synthetic `PTL_RETRY_MARKER` user message is prepended if the first remaining message is an assistant message (API requires user-first ordering).

- **Image stripping**: `stripImagesFromMessages()` (`src/services/compact/compact.ts:145-200`) replaces image and document blocks with `[image]`/`[document]` text markers before sending for compaction, since images are not needed for summary generation and can cause the compact API call itself to hit prompt-too-long.

- **Token count 4/3 padding**: `estimateMessageTokens()` pads its estimate by 33% to be conservative, since it approximates token counts from text content without a tokenizer.

- **`keepRecent` floor of 1**: Time-based MC floors `keepRecent` at 1 (`src/services/compact/microCompact.ts:461`) because `slice(-0)` returns the full array (paradoxically keeping everything) and clearing ALL results leaves the model with zero working context.