# ExtractMemories

## Overview & Responsibilities

ExtractMemories is a background memory extraction agent within the **MemorySystem** module. It runs automatically at the end of each query loop — after the main Claude agent produces a final response with no tool calls — to analyze the conversation transcript and persist durable memories to disk (`~/.claude/projects/<path>/memory/`).

It uses the **forked agent pattern** (`runForkedAgent`), creating a perfect fork of the main conversation that shares the parent's prompt cache for cost efficiency. The module is designed to be invisible to the user: it runs in the background, writes only to the auto-memory directory, and notifies the main conversation via system messages when memories are saved.

Key design properties:
- **Mutual exclusion** with the main agent's memory writes — if the main agent already wrote memories in the current turn, the background extraction is skipped entirely
- **Turn throttling** via a configurable cadence (feature flag `tengu_bramble_lintel`) to avoid running on every single turn
- **Overlap coalescing** — if a new extraction is requested while one is in-progress, the context is stashed for a single trailing run after the current one completes
- **Closure-scoped state** via `initExtractMemories()` for clean test isolation

## Key Processes

### Initialization Flow

1. `initExtractMemories()` is called once at startup (`src/services/extractMemories/extractMemories.ts:296`)
2. Creates a fresh closure capturing all mutable state: cursor position (`lastMemoryMessageUuid`), overlap guard (`inProgress`), throttle counter (`turnsSinceLastExtraction`), stashed context (`pendingContext`), and in-flight promise tracking (`inFlightExtractions`)
3. Assigns the closure-internal `executeExtractMemoriesImpl` to the module-level `extractor` variable, and a drain function to `drainer`

### Extraction Trigger Flow

When `executeExtractMemories()` is called (fire-and-forget from `handleStopHooks`):

1. **Guard checks** (`src/services/extractMemories/extractMemories.ts:531-563`):
   - Skip if called from a subagent (not the main agent)
   - Skip if the feature gate `tengu_passport_quail` is disabled
   - Skip if auto-memory is not enabled (`isAutoMemoryEnabled()`)
   - Skip if running in remote mode
   - If an extraction is already in progress, stash the context for a trailing run and return immediately

2. **`runExtraction()`** (`src/services/extractMemories/extractMemories.ts:329-523`):
   - Count new model-visible messages since the last extraction cursor (`countModelVisibleMessagesSince`)
   - **Mutual exclusion check**: scan for Write/Edit tool_use blocks targeting auto-memory paths since the cursor — if found, advance the cursor and skip (`hasMemoryWritesSince`, line 348)
   - **Turn throttling**: increment `turnsSinceLastExtraction`; skip if below the configured threshold (trailing runs bypass this check)
   - Scan existing memory files to build a manifest (`scanMemoryFiles` + `formatMemoryManifest`)
   - Build the extraction prompt — either `buildExtractAutoOnlyPrompt` or `buildExtractCombinedPrompt` depending on whether team memory is enabled
   - Launch a forked agent with `runForkedAgent()`, limited to 5 turns, skipping transcript recording
   - On success: advance the cursor, extract written file paths, log analytics, and notify the main conversation via `appendSystemMessage` with a `memorySaved` system message
   - On error: log and swallow — extraction is best-effort

3. **Trailing run** (`src/services/extractMemories/extractMemories.ts:510-521`): In the `finally` block, if a context was stashed during the run, execute one more extraction with the stashed context. This ensures messages from overlapping turns are not lost.

### Drain Flow

`drainPendingExtraction()` (`src/services/extractMemories/extractMemories.ts:611-615`) awaits all in-flight extraction promises (including trailing runs) with a configurable soft timeout (default 60s). Called by the print layer after the response is flushed but before graceful shutdown, ensuring the forked agent completes before the process exits.

## Function Signatures

### `initExtractMemories(): void`

Initializes the extraction system by creating a fresh closure with all mutable state. Must be called once at startup. In tests, call in `beforeEach` for isolation.

> Source: `src/services/extractMemories/extractMemories.ts:296`

### `executeExtractMemories(context: REPLHookContext, appendSystemMessage?: AppendSystemMessageFn): Promise<void>`

Public entry point called fire-and-forget from stop hooks. No-ops until `initExtractMemories()` has been called.

- **context**: The REPL hook context containing the current message array and tool-use context
- **appendSystemMessage**: Optional callback to inject a system message (memory-saved notification) into the main conversation

> Source: `src/services/extractMemories/extractMemories.ts:598-603`

### `drainPendingExtraction(timeoutMs?: number): Promise<void>`

Awaits all in-flight extractions with a soft timeout. Called before graceful shutdown.

- **timeoutMs**: Soft timeout in milliseconds, defaults to 60,000

> Source: `src/services/extractMemories/extractMemories.ts:611-615`

### `createAutoMemCanUseTool(memoryDir: string): CanUseToolFn`

Creates a permission function for the forked agent that restricts tool access. Shared by extractMemories and autoDream.

- **Allowed unrestricted**: Read, Grep, Glob, REPL (which delegates inner operations back through this gate)
- **Allowed with restrictions**: Bash (read-only commands only), Edit/Write (only for paths within `memoryDir`)
- **Denied**: All other tools (MCP, Agent, write-capable Bash, etc.)

> Source: `src/services/extractMemories/extractMemories.ts:171-222`

### `buildExtractAutoOnlyPrompt(newMessageCount, existingMemories, skipIndex?): string`

Builds the extraction prompt for individual (non-team) memory. Includes the four-type memory taxonomy, what-not-to-save guidance, and save instructions. When `skipIndex` is true, omits the MEMORY.md index step.

> Source: `src/services/extractMemories/prompts.ts:50-94`

### `buildExtractCombinedPrompt(newMessageCount, existingMemories, skipIndex?): string`

Builds the extraction prompt for combined auto + team memory. Adds per-type scope guidance (private vs. team directory) and a sensitive-data warning for shared team memories. Falls back to `buildExtractAutoOnlyPrompt` if the TEAMMEM feature is disabled.

> Source: `src/services/extractMemories/prompts.ts:101-154`

## Configuration & Feature Flags

| Flag / Config | Type | Default | Purpose |
|---|---|---|---|
| `tengu_passport_quail` | boolean | `false` | Master gate — extraction is entirely disabled when false |
| `tengu_bramble_lintel` | number | `1` | Turn throttle — extraction runs every N eligible turns |
| `tengu_moth_copse` | boolean | `false` | When true, skips the MEMORY.md index step in prompts |
| `TEAMMEM` | build feature | — | Enables team memory support (combined prompts, team mem paths) |
| Auto-memory enabled | runtime check | — | `isAutoMemoryEnabled()` must return true |
| Remote mode | runtime check | — | Extraction is skipped in remote mode |

## Edge Cases & Caveats

- **Mutual exclusion with main agent**: If the main agent already wrote to auto-memory paths in the current turn range, the background extraction is skipped and the cursor advances past those messages (`hasMemoryWritesSince`, `src/services/extractMemories/extractMemories.ts:121-148`). This prevents duplicate memory writes.

- **Cursor fallback on compaction**: If the cursor UUID (`lastMemoryMessageUuid`) is not found in the message array (e.g., removed by context compaction), `countModelVisibleMessagesSince` falls back to counting all model-visible messages rather than returning 0, which would permanently disable extraction (`src/services/extractMemories/extractMemories.ts:106-108`).

- **Overlap coalescing**: Only the *latest* stashed context is kept when multiple calls arrive during an in-progress run — earlier stashed contexts are overwritten since the latest one contains all previous messages (`src/services/extractMemories/extractMemories.ts:557-563`).

- **Trailing runs bypass throttling**: When a stashed context triggers a trailing extraction, it skips the turn-count throttle check since it represents already-committed work (`src/services/extractMemories/extractMemories.ts:377-385`).

- **Hard turn cap**: The forked agent is limited to 5 turns (`maxTurns: 5`) to prevent verification rabbit-holes from burning tokens (`src/services/extractMemories/extractMemories.ts:426`).

- **Transcript isolation**: The forked agent runs with `skipTranscript: true` to avoid race conditions with the main thread's transcript recording (`src/services/extractMemories/extractMemories.ts:423`).

- **REPL tool passthrough**: When REPL mode is enabled, primitive tools are hidden from the tool list, so the forked agent calls REPL instead. REPL's VM context re-invokes `canUseTool` for each inner primitive, so the same permission gates apply. Giving the fork a different tool list would break prompt cache sharing (`src/services/extractMemories/extractMemories.ts:176-179`).

- **Best-effort error handling**: All errors are caught, logged, and swallowed — extraction never crashes the main conversation (`src/services/extractMemories/extractMemories.ts:497-502`).

- **Drain before shutdown**: `drainPendingExtraction` uses `setTimeout(...).unref()` so the timer doesn't prevent Node from exiting if the extraction finishes early (`src/services/extractMemories/extractMemories.ts:584`).