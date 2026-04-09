# AI Features

## Overview & Responsibilities

AI Features is a collection of seven LLM-powered auxiliary services within the **Services** module that enhance the Claude Code user experience through background intelligence. These features run alongside the main conversation loop — generating summaries, predicting next actions, consolidating memories, maintaining documentation, and surfacing contextual tips — without blocking the user's primary workflow.

All features share a common architectural pattern: they fork the main conversation context using `runForkedAgent()` or call lightweight models (Haiku) to piggyback on the parent's prompt cache. This cache-sharing strategy is critical for cost efficiency — tools are denied via callback rather than omitted from the request, preserving the cache key.

The seven sub-features are:

| Feature | Purpose | Model/Method |
|---------|---------|--------------|
| **Agent Summary** | Progress updates for coordinator sub-agents | Forked agent (cache-safe) |
| **Magic Docs** | Auto-updates `# MAGIC DOC:` files | Forked agent (Sonnet) |
| **Prompt Suggestion** | Predicts user's next input | Forked agent (cache-safe) |
| **Speculation** | Speculatively executes accepted suggestions | Forked agent (overlay FS) |
| **Tool Use Summary** | Labels completed tool batches | Haiku (direct query) |
| **Auto Dream** | Background memory consolidation | Forked agent (cache-safe) |
| **Tips** | Contextual usage tips during spinner | Local (no LLM) |
| **Away Summary** | Session recap on return | Small/fast model (direct) |

---

## Key Processes

### Agent Summary — Periodic Sub-Agent Progress

Agent summaries provide real-time progress visibility for coordinator-mode sub-agents by forking every ~30 seconds to produce a 3-5 word present-tense status line (e.g., "Reading runAgent.ts").

1. `startAgentSummarization()` is called when a sub-agent starts, receiving the agent's `CacheSafeParams` (`src/services/AgentSummary/agentSummary.ts:46-51`)
2. A timer fires every 30 seconds (`SUMMARY_INTERVAL_MS = 30_000`, line 26)
3. Each tick reads the agent's current transcript via `getAgentTranscript()`, skipping if fewer than 3 messages (line 69)
4. `filterIncompleteToolCalls()` cleans the messages, then `runForkedAgent()` generates a summary (lines 78-119)
5. The summary is stored via `updateAgentSummary()` for UI rendering (line 140)
6. The next timer is scheduled only after the current summary completes — preventing overlapping requests (line 152)
7. `stop()` clears the timer and aborts any in-flight request (lines 162-173)

The prompt instructs the model to avoid past tense, vague descriptions, and branch names, and to say something new if a previous summary exists (`buildSummaryPrompt`, lines 28-44).

### Prompt Suggestion — Next-Action Prediction

Predicts what the user would naturally type next (2-12 words) and optionally triggers speculative execution.

**Enable/disable cascade** (`shouldEnablePromptSuggestion`, `src/services/PromptSuggestion/promptSuggestion.ts:37-94`):
1. Environment variable `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` (highest priority)
2. GrowthBook feature flag `tengu_chomp_inflection`
3. Non-interactive sessions → disabled
4. Swarm teammates → disabled (only leader shows suggestions)
5. User setting `promptSuggestionEnabled` (default true)

**Generation flow** (`executePromptSuggestion`, lines 184-237):
1. Triggered as a post-sampling hook on `repl_main_thread` queries
2. Suppressed if: fewer than 2 assistant turns, last response was an error, cache is cold (>10K uncached tokens), plan mode active, rate limited, or pending permissions
3. Calls `generateSuggestion()` which forks with the `SUGGESTION_PROMPT` (lines 258-287) — the prompt tells the model to predict what the **user** would type, not what Claude should do
4. Result passes through `shouldFilterSuggestion()` — an extensive filter chain (lines 354-456) that rejects: meta-text ("nothing found", "silence"), evaluative phrases ("looks good", "thanks"), Claude-voice ("Let me...", "I'll..."), error messages, formatted text, too few words (unless allowed single-words like "yes", "push", "commit"), too many words (>12), multiple sentences
5. If accepted, sets `promptSuggestion` app state for UI display
6. If speculation is enabled, immediately starts speculative execution

### Speculation — Speculative Execution of Suggestions

Runs the suggested prompt speculatively in an isolated overlay filesystem so work is pre-computed before the user accepts (`src/services/PromptSuggestion/speculation.ts`).

**Isolation model**:
- File writes go to a copy-on-write overlay directory under `~/.claude/tmp/speculation/<pid>/<id>/` (line 80-81)
- Read tools (`Read`, `Glob`, `Grep`, `ToolSearch`, `LSP`, `TaskGet`, `TaskList`) are allowed freely (lines 62-70)
- Write tools (`Edit`, `Write`, `NotebookEdit`) are allowed only when the user's permission mode is `acceptEdits` or `bypassPermissions`; otherwise they become a boundary that halts speculation (lines 466-494)
- Bash commands must pass `checkReadOnlyConstraints()` — only read-only commands are allowed (lines 577-608)
- All other tools are denied, creating a boundary (lines 610-631)

**Boundary types** (`CompletionBoundary`):
- `bash` — non-read-only bash command encountered
- `edit` — file edit in a restricted permission mode
- `denied_tool` — unsupported tool requested
- `complete` — speculation ran to natural completion

**Acceptance flow** (`acceptSpeculation`, lines 717-800):
1. Copies overlay files to the real workspace via `copyOverlayToMain()`
2. Logs time saved and tool use count
3. Cleans up the overlay directory

**Pipelining**: When speculation completes, it immediately generates a *next* suggestion using `generatePipelinedSuggestion()` (lines 345-400, 672-679). If the user accepts the current speculation, the pipelined suggestion is promoted and a new speculation starts — creating a chain of pre-computed actions.

**Message injection** (`prepareMessagesForInjection`, lines 203-271): Strips thinking blocks, pending/interrupted tool calls, and interrupt messages before injecting speculated messages into the main conversation.

### Magic Docs — Automated Documentation Maintenance

Detects markdown files with a `# MAGIC DOC: [title]` header and automatically updates them in the background (`src/services/MagicDocs/magicDocs.ts`).

1. `initMagicDocs()` registers a `FileReadListener` that detects magic doc headers on any file read (lines 242-254) — currently ant-only (`process.env.USER_TYPE === 'ant'`)
2. When a magic doc is detected, `registerMagicDoc()` adds it to a tracking map (lines 87-94)
3. A `postSamplingHook` (`updateMagicDocs`) fires after each assistant turn, but only when the conversation is idle (no tool calls in the last turn) and on the main thread (lines 217-240)
4. For each tracked doc, `updateMagicDoc()` re-reads the file, re-detects the header, and runs a forked agent with the Sonnet model and only the `Edit` tool allowed — constrained to edit only that specific file (lines 114-212)
5. The update prompt (`src/services/MagicDocs/prompts.ts:8-59`) instructs the agent to incorporate new learnings from the conversation while preserving the magic doc header, keeping content current (not a changelog), and being terse

**Custom prompts**: Users can override the update prompt by placing a file at `~/.claude/magic-docs/prompt.md`. Variable substitution uses `{{docContents}}`, `{{docPath}}`, `{{docTitle}}`, and `{{customInstructions}}` syntax (lines 66-76, 81-93).

**Per-doc instructions**: An optional italicized line immediately after the header (`*instructions here*`) provides document-specific update guidance (lines 35-36, 62-81).

### Tool Use Summary — Concise Tool Batch Labels

Generates ~30-character human-readable labels for completed tool batches, used by the SDK for mobile app progress updates (`src/services/toolUseSummary/toolUseSummaryGenerator.ts`).

1. `generateToolUseSummary()` receives an array of `ToolInfo` objects (name, input, output) — returns null if empty (lines 45-97)
2. Each tool's input/output is JSON-stringified and truncated to 300 characters (lines 57-63)
3. Queries Haiku with a system prompt requesting git-commit-subject style labels in past tense (lines 15-24)
4. Errors are logged but never propagated — summaries are non-critical (lines 90-96)

### Auto Dream — Background Memory Consolidation

Periodically consolidates session memories into durable, well-organized memory files (`src/services/autoDream/autoDream.ts`).

**Gate sequence** (cheapest checks first):
1. **Feature gate**: Not in KAIROS mode, not remote, auto-memory enabled, `isAutoDreamEnabled()` returns true (`src/services/autoDream/config.ts:13-21` — checks user setting then GrowthBook `tengu_onyx_plover`)
2. **Time gate**: Hours since `lastConsolidatedAt` >= `minHours` (default 24h) — read from lock file mtime (line 140-141)
3. **Scan throttle**: At least 10 minutes since last session scan (lines 144-150)
4. **Session gate**: Number of transcript files with mtime > lastConsolidatedAt >= `minSessions` (default 5), excluding current session (lines 154-171)
5. **Lock gate**: File-based lock with PID and stale detection (`src/services/autoDream/consolidationLock.ts:46-84`)

**Lock mechanism** (`consolidationLock.ts`):
- The lock file's **mtime IS the lastConsolidatedAt timestamp** — no separate state file needed (line 1)
- Body contains the holder's PID for liveness checking
- Stale after 1 hour even if PID is live (PID reuse guard, line 19)
- Two concurrent acquirers resolved by re-read verification (lines 74-81)
- Rollback on failure rewinds mtime via `utimes()` (lines 91-108)

**Consolidation prompt** (`src/services/autoDream/consolidationPrompt.ts:10-65`):
Four phases: Orient (ls memory dir, read index) → Gather recent signal (daily logs, drifted memories, narrow transcript grep) → Consolidate (write/update memory files) → Prune and index (keep entrypoint under line/size limits).

Bash is restricted to read-only commands. Progress is tracked via `DreamTask` state with `makeDreamProgressWatcher()` which extracts text blocks and file paths from each assistant turn (lines 281-313). On completion, an inline "Improved N memories" message appears in the main transcript.

### Tips — Contextual Usage Tips

A three-module system that displays contextual tips during spinner waits, educating users about features.

**Tip Registry** (`src/services/tips/tipRegistry.ts`):
- 60+ tips defined as `Tip` objects with `id`, `content` (async function), `cooldownSessions`, and `isRelevant` (async predicate)
- Categories: new user warmup, plan mode, permissions, git worktrees, terminal setup, memory, themes, IDE integration, desktop/web/mobile upsells, plugins (frontend-design, vercel), effort levels, subagent fan-out, loop command, guest passes, overage credits, feedback
- Context-aware filtering considers: terminal type, platform, user type (ant vs external), `numStartups`, installed features, running IDEs, concurrent sessions, GrowthBook flags
- Custom tips via `spinnerTipsOverride` setting with optional `excludeDefault` flag (lines 655-666)

**Tip History** (`src/services/tips/tipHistory.ts`):
- Tracks when each tip was last shown using `numStartups` as the time unit (not wall-clock time)
- `recordTipShown(tipId)` saves to global config (lines 3-9)
- `getSessionsSinceLastShown(tipId)` returns `numStartups - lastShown` or `Infinity` if never shown (lines 12-17)

**Tip Scheduler** (`src/services/tips/tipScheduler.ts`):
- `getTipToShowOnSpinner()` is called during spinner waits (lines 32-46)
- Checks `spinnerTipsEnabled` setting (default true)
- Gets relevant tips from registry (filtered by `isRelevant` and cooldown)
- Selects the tip with the longest time since last shown via `selectTipWithLongestTimeSinceShown()` (lines 10-30)
- `recordShownTip()` persists the shown state and logs an analytics event (lines 48-58)

### Away Summary — Session Recap on Return

Generates a 1-3 sentence recap when users return to an idle session (`src/services/awaySummary.ts`).

1. `generateAwaySummary()` takes the conversation messages and an abort signal (lines 29-74)
2. Truncates to the last 30 messages (`RECENT_MESSAGE_WINDOW`, line 16) to avoid prompt-too-long errors
3. Fetches session memory for broader context via `getSessionMemoryContent()` (line 38)
4. Queries the small/fast model (`getSmallFastModel()`) with thinking disabled, no tools, and `skipCacheWrite: true` (lines 41-58)
5. The prompt instructs: state the high-level task, then the concrete next step — skip status reports and commit recaps (lines 18-23)
6. Returns null gracefully on abort, API error, or any exception (lines 60-73)

---

## Function Signatures

### Agent Summary

#### `startAgentSummarization(taskId, agentId, cacheSafeParams, setAppState): { stop: () => void }`
Starts periodic summarization for a coordinator sub-agent. Returns a handle with a `stop()` method.
> `src/services/AgentSummary/agentSummary.ts:46-179`

### Prompt Suggestion

#### `shouldEnablePromptSuggestion(): boolean`
Evaluates the enable/disable cascade (env → feature flag → non-interactive → swarm → setting).
> `src/services/PromptSuggestion/promptSuggestion.ts:37-94`

#### `executePromptSuggestion(context: REPLHookContext): Promise<void>`
Post-sampling hook entry point. Generates a suggestion and optionally starts speculation.
> `src/services/PromptSuggestion/promptSuggestion.ts:184-237`

#### `tryGenerateSuggestion(abortController, messages, getAppState, cacheSafeParams, source?): Promise<{suggestion, promptId, generationRequestId} | null>`
Shared guard + generation logic for both CLI and SDK paths.
> `src/services/PromptSuggestion/promptSuggestion.ts:125-182`

### Speculation

#### `startSpeculation(suggestionText, context, setAppState, isPipelined?, cacheSafeParams?): Promise<void>`
Starts speculative execution in an overlay filesystem. Aborts any existing speculation first.
> `src/services/PromptSuggestion/speculation.ts:402-715`

#### `acceptSpeculation(state, setAppState, cleanMessageCount): Promise<SpeculationResult | null>`
Accepts speculation results: copies overlay files to main, calculates time saved.
> `src/services/PromptSuggestion/speculation.ts:717-800`

#### `handleSpeculationAccept(speculationState, speculationSessionTimeSavedMs, setAppState, input, deps): Promise<{queryRequired: boolean}>`
Full acceptance handler: injects speculated messages, promotes pipelined suggestions, handles errors gracefully (fails open to normal query).
> `src/services/PromptSuggestion/speculation.ts:835-991`

### Tool Use Summary

#### `generateToolUseSummary({tools, signal, isNonInteractiveSession, lastAssistantText?}): Promise<string | null>`
Generates a ~30-character label for a batch of completed tools. Returns null on failure.
> `src/services/toolUseSummary/toolUseSummaryGenerator.ts:45-97`

### Auto Dream

#### `initAutoDream(): void`
Initializes the auto-dream closure. Must be called once at startup.
> `src/services/autoDream/autoDream.ts:122-273`

#### `executeAutoDream(context, appendSystemMessage?): Promise<void>`
Entry point from stopHooks. No-op until `initAutoDream()` has been called.
> `src/services/autoDream/autoDream.ts:319-324`

#### `isAutoDreamEnabled(): boolean`
Checks user setting then GrowthBook feature flag.
> `src/services/autoDream/config.ts:13-21`

### Tips

#### `getTipToShowOnSpinner(context?): Promise<Tip | undefined>`
Selects the most appropriate tip to show during a spinner wait.
> `src/services/tips/tipScheduler.ts:32-46`

#### `getRelevantTips(context?): Promise<Tip[]>`
Filters the full tip registry by relevance and cooldown.
> `src/services/tips/tipRegistry.ts:668-686`

### Away Summary

#### `generateAwaySummary(messages, signal): Promise<string | null>`
Generates a 1-3 sentence session recap. Returns null on any failure.
> `src/services/awaySummary.ts:29-74`

---

## Configuration & Defaults

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `promptSuggestionEnabled` | boolean | `true` | Enable/disable next-action suggestions |
| `autoDreamEnabled` | boolean | GrowthBook | Enable background memory consolidation |
| `spinnerTipsEnabled` | boolean | `true` | Show tips during spinner waits |
| `spinnerTipsOverride` | `{tips: string[], excludeDefault?: boolean}` | — | Custom tips, optionally replacing defaults |
| `speculationEnabled` | boolean | `true` | Enable speculative execution (ant-only, via global config) |

**Environment variables**:
- `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` — Override prompt suggestion enable/disable
- `USER_TYPE` — `"ant"` enables internal-only features (Magic Docs, speculation, extra tips)

**Feature flags** (GrowthBook):
- `tengu_chomp_inflection` — Gates prompt suggestions
- `tengu_onyx_plover` — Gates auto-dream and provides scheduling config (`minHours`, `minSessions`)
- `tengu_tide_elm` — Effort-high nudge tip
- `tengu_tern_alloy` — Subagent fan-out tip
- `tengu_timber_lark` — Loop command tip

---

## Edge Cases & Caveats

- **Cache key sensitivity**: Prompt suggestion and agent summary must NOT override `maxOutputTokens`, `effortValue`, or any API parameter that differs from the parent request — even seemingly innocuous changes can bust the prompt cache. PR #18143 caused a 45x cache write spike by setting `effort:'low'` (`src/services/PromptSuggestion/promptSuggestion.ts:308-317`).

- **Speculation is ant-only**: `isSpeculationEnabled()` checks `process.env.USER_TYPE === 'ant'` (`src/services/PromptSuggestion/speculation.ts:337-343`). Magic Docs initialization is similarly gated (`src/services/MagicDocs/magicDocs.ts:243`).

- **Speculation fails open**: If `handleSpeculationAccept` throws, it returns `{ queryRequired: true }` so the user's input proceeds via normal query flow — speculated work is discarded rather than causing a broken state (`src/services/PromptSuggestion/speculation.ts:959-989`).

- **Away summary truncates to 30 messages**: Large sessions are windowed to prevent prompt-too-long errors. The summary uses `skipCacheWrite: true` since it's a one-shot query (`src/services/awaySummary.ts:16, 56`).

- **Auto-dream scan throttle**: When the time gate passes but the session gate doesn't, the lock mtime doesn't advance, so the time gate keeps passing. A 10-minute scan throttle (`SESSION_SCAN_INTERVAL_MS`) prevents redundant session scans on every turn (`src/services/autoDream/autoDream.ts:56`).

- **Consolidation lock uses mtime as timestamp**: The lock file's modification time **is** the `lastConsolidatedAt` value. There's no separate timestamp file. Rollback uses `utimes()` to rewind the mtime (`src/services/autoDream/consolidationLock.ts:1-2, 91-108`).

- **Tip cooldown uses startup count, not wall time**: `numStartups` increments each time Claude Code launches. A tip with `cooldownSessions: 10` won't reappear until 10 launches later, regardless of elapsed time (`src/services/tips/tipHistory.ts:12-17`).

- **Tool denial via callback, not empty arrays**: Passing `tools: []` to the fork changes the API cache key, causing cache misses. Instead, tools remain in the request and are denied at permission-check time via `canUseTool` callbacks. This pattern is used consistently across Agent Summary, Prompt Suggestion, and Auto Dream.

- **Magic Docs clones FileStateCache**: The magic docs agent clones and modifies the read-file cache to force re-reading the target document (avoiding `file_unchanged` stubs), while isolating its operations from the main conversation (`src/services/MagicDocs/magicDocs.ts:124-129`).