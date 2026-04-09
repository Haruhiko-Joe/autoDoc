# SessionMemory

## Overview & Responsibilities

SessionMemory is the automatic note-taking subsystem within the MemorySystem module. It maintains a structured Markdown file that summarizes the current conversation, running periodically in the background as a **forked subagent**. Its purpose is to capture key information — task state, important files, errors, learnings, and workflow details — without interrupting the main conversation flow.

SessionMemory is a critical dependency of the **compaction system**: when the context window grows too large and older messages are pruned, the session memory file provides continuity so that essential context is not lost. It sits alongside the persistent `CLAUDE.md` memory and the memdir-based structured memory store as part of the broader MemorySystem.

The module is split across three files:
- **`src/services/SessionMemory/sessionMemory.ts`** — Core orchestration: initialization, threshold-based triggering, extraction execution via forked agent
- **`src/services/SessionMemory/sessionMemoryUtils.ts`** — Stateful utilities: configuration, threshold checks, extraction state tracking, content retrieval
- **`src/services/SessionMemory/prompts.ts`** — Prompt engineering: templates, update prompts, section size management, variable substitution

## Key Processes

### Initialization Flow

1. `initSessionMemory()` is called during startup (`src/services/SessionMemory/sessionMemory.ts:357-375`)
2. It exits early if running in **remote mode** or if **auto-compact is disabled** (session memory piggybacks on the auto-compact feature gate)
3. It registers `extractSessionMemory` as a **post-sampling hook** — this hook fires after every Claude API response in the main REPL loop

### Threshold-Based Triggering

The system uses a two-phase threshold model to decide when to extract notes:

**Phase 1 — Initialization threshold** (`shouldExtractMemory`, `src/services/SessionMemory/sessionMemory.ts:134-181`):
- No extraction happens until the conversation reaches `minimumMessageTokensToInit` tokens (default: **10,000**)
- Once this threshold is crossed, session memory is marked as initialized and never rechecks this gate

**Phase 2 — Update thresholds** (both must be satisfied):
- **Token threshold**: Context window must have grown by at least `minimumTokensBetweenUpdate` tokens (default: **5,000**) since the last extraction
- **Tool call threshold**: At least `toolCallsBetweenUpdates` tool calls (default: **3**) must have occurred since the last extraction

Extraction triggers when:
- Both thresholds are met (tokens AND tool calls), **OR**
- The token threshold is met AND the last assistant turn has no pending tool calls (a natural conversation break)

The token threshold is **always required** — even if the tool call count is exceeded, extraction won't fire until enough new context has accumulated.

### Extraction Execution

1. The `extractSessionMemory` hook (wrapped in `sequential()` to prevent concurrent runs) validates preconditions: main REPL thread only, feature gate enabled (`src/services/SessionMemory/sessionMemory.ts:272-350`)
2. Config is lazily initialized from remote GrowthBook config (memoized, runs once per session)
3. `setupSessionMemoryFile()` creates the session memory directory and file if they don't exist, seeding from the template (`src/services/SessionMemory/sessionMemory.ts:183-233`)
4. `buildSessionMemoryUpdatePrompt()` constructs the extraction prompt with current notes content and section size warnings (`src/services/SessionMemory/prompts.ts:226-247`)
5. `runForkedAgent()` spawns an isolated subagent that reads the conversation context and uses the **Edit tool** (and only Edit) to update the memory file
6. Post-extraction: token count is recorded, `lastSummarizedMessageId` is updated (only at safe boundaries — no pending tool calls), and analytics events are logged

### Security: Tool Restriction

The forked subagent is sandboxed via `createMemoryFileCanUseTool()` (`src/services/SessionMemory/sessionMemory.ts:460-482`). It **only** allows the `file_edit` tool targeting the exact session memory file path. All other tool calls are denied. This prevents the extraction agent from accidentally modifying user files.

### Manual Extraction

`manuallyExtractSessionMemory()` (`src/services/SessionMemory/sessionMemory.ts:387-453`) bypasses all threshold checks and runs extraction immediately. It is used by the `/summary` command. It follows the same flow as automatic extraction but builds `cacheSafeParams` directly from the tool use context rather than from a hook context.

## Function Signatures

### `initSessionMemory(): void`

Registers the post-sampling hook that drives automatic extraction. No-ops if in remote mode or auto-compact is disabled. Called once during startup.

> `src/services/SessionMemory/sessionMemory.ts:357-375`

### `shouldExtractMemory(messages: Message[]): boolean`

Pure decision function that evaluates whether extraction should trigger based on initialization state, token growth, and tool call count.

> `src/services/SessionMemory/sessionMemory.ts:134-181`

### `manuallyExtractSessionMemory(messages, toolUseContext): Promise<ManualExtractionResult>`

Triggers extraction on demand, returning `{ success, memoryPath?, error? }`.

> `src/services/SessionMemory/sessionMemory.ts:387-453`

### `createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn`

Returns a permission function allowing only `file_edit` on the given path.

> `src/services/SessionMemory/sessionMemory.ts:460-482`

### `getSessionMemoryContent(): Promise<string | null>`

Reads and returns the current session memory file contents. Returns `null` if the file doesn't exist.

> `src/services/SessionMemory/sessionMemoryUtils.ts:110-126`

### `waitForSessionMemoryExtraction(): Promise<void>`

Blocks until any in-progress extraction completes, with a **15-second timeout**. Returns immediately if the extraction is stale (>1 minute old).

> `src/services/SessionMemory/sessionMemoryUtils.ts:89-105`

### `buildSessionMemoryUpdatePrompt(currentNotes, notesPath): Promise<string>`

Constructs the full extraction prompt by loading the prompt template, substituting `{{currentNotes}}` and `{{notesPath}}` variables, and appending section size warnings if any sections exceed limits.

> `src/services/SessionMemory/prompts.ts:226-247`

### `isSessionMemoryEmpty(content: string): Promise<boolean>`

Checks if the content matches the bare template (no actual notes have been extracted yet). Used by compaction to decide whether to fall back to legacy behavior.

> `src/services/SessionMemory/prompts.ts:220-224`

### `truncateSessionMemoryForCompact(content: string): { truncatedContent, wasTruncated }`

Truncates individual sections that exceed `MAX_SECTION_LENGTH * 4` characters, cutting at line boundaries. Used when injecting session memory into compact messages to prevent it from consuming the entire post-compact token budget.

> `src/services/SessionMemory/prompts.ts:256-296`

## Interface/Type Definitions

### `SessionMemoryConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `minimumMessageTokensToInit` | `number` | 10,000 | Context window tokens required before first extraction |
| `minimumTokensBetweenUpdate` | `number` | 5,000 | Minimum context growth (tokens) between updates |
| `toolCallsBetweenUpdates` | `number` | 3 | Tool calls required between updates |

> `src/services/SessionMemory/sessionMemoryUtils.ts:18-29`

### `ManualExtractionResult`

```typescript
type ManualExtractionResult = {
  success: boolean
  memoryPath?: string
  error?: string
}
```

> `src/services/SessionMemory/sessionMemory.ts:377-381`

## Configuration & Defaults

### Remote Configuration

Thresholds can be overridden via GrowthBook remote config (`tengu_sm_config`). The feature gate `tengu_session_memory` controls whether the feature is active at all. Both use **cached, non-blocking** reads — values may be slightly stale but never block startup.

Remote config values are only applied if they are positive numbers; otherwise defaults are used (`src/services/SessionMemory/sessionMemory.ts:240-264`).

### Custom Templates

Users can provide a custom session memory template at:
```
~/.claude/session-memory/config/template.md
```

If this file doesn't exist, `DEFAULT_SESSION_MEMORY_TEMPLATE` is used, which defines sections: Session Title, Current State, Task specification, Files and Functions, Workflow, Errors & Corrections, Codebase and System Documentation, Learnings, Key results, and Worklog (`src/services/SessionMemory/prompts.ts:11-41`).

### Custom Prompts

Users can override the extraction prompt at:
```
~/.claude/session-memory/config/prompt.md
```

Custom prompts support `{{variableName}}` substitution (e.g., `{{currentNotes}}`, `{{notesPath}}`). If not provided, the default prompt is used which instructs the subagent to use Edit tool calls to update the notes file while preserving the section structure (`src/services/SessionMemory/prompts.ts:111-129`).

### Token Budget Limits

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_SECTION_LENGTH` | 2,000 tokens | Per-section limit; triggers condensation reminders |
| `MAX_TOTAL_SESSION_MEMORY_TOKENS` | 12,000 tokens | Total file limit; triggers aggressive condensation |
| `EXTRACTION_WAIT_TIMEOUT_MS` | 15,000 ms | Max wait time for in-progress extraction |
| `EXTRACTION_STALE_THRESHOLD_MS` | 60,000 ms | Extraction older than this is considered stale |

## Edge Cases & Caveats

- **Main thread only**: Extraction only runs when `querySource === 'repl_main_thread'`. Subagents, teammates, and other contexts are silently skipped.
- **Sequential execution**: The `extractSessionMemory` function is wrapped in `sequential()`, ensuring only one extraction runs at a time even if the hook fires rapidly.
- **Safe message ID updates**: `lastSummarizedMessageId` is only updated when the last assistant turn has no pending tool calls, preventing orphaned `tool_result` blocks if compaction uses this ID as a truncation boundary.
- **File creation race**: The memory file is created with `wx` flag (O_CREAT|O_EXCL) to avoid overwriting if it already exists. The template is only written on initial creation.
- **ReadFileState cache invalidation**: Before reading the memory file, the cached entry is explicitly deleted from `readFileState` to prevent the `FileReadTool` dedup logic from returning a stale "file_unchanged" stub (`src/services/SessionMemory/sessionMemory.ts:216`).
- **Stale extraction detection**: `waitForSessionMemoryExtraction()` considers any extraction older than 1 minute as stale and returns immediately, preventing indefinite blocking from a crashed extraction.
- **Section truncation for compaction**: `truncateSessionMemoryForCompact()` uses a character-based approximation (`MAX_SECTION_LENGTH * 4` chars ≈ 2,000 tokens) and truncates at line boundaries rather than mid-line.
- **Variable substitution safety**: The `substituteVariables()` function uses a single-pass regex replacement with a replacer function to avoid both `$` backreference corruption and double-substitution when user content contains `{{varName}}` patterns (`src/services/SessionMemory/prompts.ts:201-213`).