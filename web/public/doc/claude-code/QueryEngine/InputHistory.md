# InputHistory

## Overview & Responsibilities

InputHistory manages the persistent prompt history for Claude Code's CLI, powering the **up-arrow recall** and **Ctrl+R search** features. It sits within the **QueryEngine** module group and provides the storage layer that the TerminalUI consumes when users navigate previous prompts.

The module handles:
- **Persisting** each user prompt as a JSONL line in a global history file (`~/.claude/history.jsonl`)
- **Pasted content management** — small pastes are inlined directly in the history entry; large pastes (>1 KB) are stored externally via a content-addressable hash in a separate paste store
- **Per-project filtering** — only entries matching the current project root are surfaced
- **Current-session prioritization** — the current session's entries appear before other sessions' entries when pressing up-arrow, so concurrent sessions don't interleave
- **Deduplication** — the Ctrl+R picker deduplicates entries by display text
- **Lazy resolution** — paste content is only fetched from the paste store when actually needed

## Key Processes

### Adding a History Entry

When the user submits a prompt, `addToHistory()` is called (`src/history.ts:411-434`):

1. **Environment check** — if `CLAUDE_CODE_SKIP_PROMPT_HISTORY` is set (e.g., in Tungsten verification sessions), the entry is silently dropped
2. **Cleanup registration** — on first use, a process-exit cleanup handler is registered to flush any remaining pending entries
3. **Paste content classification** — each pasted content attachment is processed:
   - Images are **excluded** (stored separately in image-cache)
   - Small text pastes (≤1024 chars) are stored **inline** in the JSONL entry
   - Large text pastes are **hashed** via `hashPastedText()`, and the hash is stored as a reference. The actual content is written to the paste store asynchronously (fire-and-forget)
4. **Buffering** — the `LogEntry` (with timestamp, project root, and session ID) is pushed to `pendingEntries` and an async flush is triggered

### Flushing to Disk

The flush pipeline (`src/history.ts:292-353`) uses a coalescing write pattern:

1. `flushPromptHistory()` guards against concurrent flushes via the `isWriting` flag
2. `immediateFlushHistory()` acquires a file lock on `history.jsonl` (stale after 10s, 3 retries), serializes all pending entries as newline-delimited JSON, and appends them atomically
3. If new entries arrived during the flush, it retries after a 500ms backoff (up to 5 retries)
4. On process exit, the cleanup handler awaits any in-progress flush and performs a final `immediateFlushHistory()` for remaining entries

### Reading History (Up-Arrow)

`getHistory()` (`src/history.ts:190-217`) yields entries for the current project with session-aware ordering:

1. The core reader `makeLogEntryReader()` reads entries newest-first — first from the in-memory `pendingEntries` buffer, then from `history.jsonl` via `readLinesReverse()`
2. Entries are filtered to the current project root
3. **Current-session entries are yielded immediately**; other-session entries are buffered
4. After scanning up to `MAX_HISTORY_ITEMS` (100) entries, the buffered other-session entries are yielded
5. Each `LogEntry` is converted to a `HistoryEntry` by resolving paste store references

### Reading History (Ctrl+R Search)

`getTimestampedHistory()` (`src/history.ts:162-180`) provides a deduplicated, lazily-resolved stream for the search picker:

1. Filters to current project, deduplicates by `display` text
2. Yields `TimestampedHistoryEntry` objects containing `display`, `timestamp`, and a `resolve()` function
3. The `resolve()` function is only called when the user selects an entry — this avoids eagerly fetching paste store content for every history item
4. Caps at `MAX_HISTORY_ITEMS` (100) entries

### Undoing the Last Entry

`removeLastFromHistory()` (`src/history.ts:453-464`) supports the auto-restore-on-interrupt feature (Esc to rewind a prompt before any response arrives):

- **Fast path**: if the entry is still in the pending buffer, it's spliced out directly
- **Slow path**: if the async flush already wrote the entry to disk, its timestamp is added to `skippedTimestamps`, which is checked by `makeLogEntryReader()` to filter it out on subsequent reads

## Function Signatures

### `addToHistory(command: HistoryEntry | string): void`

Main entry point for recording a prompt. Accepts either a plain string or a `HistoryEntry` (with pasted contents). Fire-and-forget — returns immediately, writes happen asynchronously.

> `src/history.ts:411`

### `getHistory(): AsyncGenerator<HistoryEntry>`

Yields history entries for the current project, current-session-first, newest-first. Used for up-arrow navigation.

> `src/history.ts:190`

### `getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry>`

Yields deduplicated entries with timestamps and lazy resolution. Used for Ctrl+R search.

> `src/history.ts:162`

### `makeHistoryReader(): AsyncGenerator<HistoryEntry>`

Raw history reader — all projects, no session prioritization, no deduplication. Yields newest-first with resolved paste content.

> `src/history.ts:145`

### `removeLastFromHistory(): void`

Undoes the most recent `addToHistory` call. One-shot — a second call is a no-op.

> `src/history.ts:453`

### `clearPendingHistoryEntries(): void`

Drops all buffered (unflushed) entries and resets the skip-set. Used for cleanup/testing.

> `src/history.ts:436`

### Paste Reference Utilities

| Function | Signature | Purpose |
|----------|-----------|---------|
| `formatPastedTextRef` | `(id: number, numLines: number) => string` | Produces `[Pasted text #1 +10 lines]` |
| `formatImageRef` | `(id: number) => string` | Produces `[Image #2]` |
| `parseReferences` | `(input: string) => Array<{id, match, index}>` | Extracts all paste/image refs from a string |
| `expandPastedTextRefs` | `(input: string, pastedContents: Record<number, PastedContent>) => string` | Replaces text refs with actual content; leaves image refs intact |
| `getPastedTextRefNumLines` | `(text: string) => number` | Counts newlines in pasted text (for the `+N lines` suffix) |

## Type Definitions

### `LogEntry` (internal)

The on-disk JSONL record format:

| Field | Type | Description |
|-------|------|-------------|
| `display` | `string` | The prompt text as shown to the user (with paste placeholders) |
| `pastedContents` | `Record<number, StoredPastedContent>` | Paste attachments keyed by reference ID |
| `timestamp` | `number` | `Date.now()` when the entry was created |
| `project` | `string` | Absolute path of the project root |
| `sessionId` | `string?` | The CLI session ID for session-aware ordering |

### `StoredPastedContent` (internal)

Represents a paste attachment in the JSONL file (`src/history.ts:25-32`):

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Auto-incrementing ID unique within a single prompt |
| `type` | `'text' \| 'image'` | Content type |
| `content` | `string?` | Inline content (for pastes ≤1024 chars) |
| `contentHash` | `string?` | SHA hash reference to the paste store (for pastes >1024 chars) |
| `mediaType` | `string?` | MIME type |
| `filename` | `string?` | Original filename |

### `TimestampedHistoryEntry` (exported)

Returned by `getTimestampedHistory()` for the Ctrl+R picker:

| Field | Type | Description |
|-------|------|-------------|
| `display` | `string` | The prompt text to show in the list |
| `timestamp` | `number` | When the entry was recorded |
| `resolve` | `() => Promise<HistoryEntry>` | Lazily resolves full entry with paste content |

## Configuration & Defaults

| Constant / Variable | Value | Description |
|---------------------|-------|-------------|
| `MAX_HISTORY_ITEMS` | `100` | Maximum entries returned by `getHistory()` and `getTimestampedHistory()` |
| `MAX_PASTED_CONTENT_LENGTH` | `1024` | Threshold in characters — pastes above this are stored externally via hash |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | env var | When truthy, `addToHistory()` becomes a no-op |
| History file path | `~/.claude/history.jsonl` | Global, shared across all projects |
| Lock stale timeout | `10000` ms | File lock is considered stale after 10 seconds |
| Flush retry backoff | `500` ms | Delay between retry attempts when entries arrive during a flush |
| Max flush retries | `5` | Stops retry loop to avoid hot-looping |

## Edge Cases & Caveats

- **Images are never stored in history** — they are filtered out during `addToPromptHistory()` (`src/history.ts:367-369`) because they live in a separate image-cache system.
- **Line count is newline-count, not line-count** — `getPastedTextRefNumLines` counts `\n` occurrences, so a 3-line paste reports `+2 lines`. This preserves legacy behavior (`src/history.ts:44-49`).
- **Race between flush and undo** — `removeLastFromHistory()` handles the case where the entry was already flushed to disk by adding its timestamp to a skip-set, rather than modifying the file. This skip-set is session-scoped and resets on process restart.
- **Concurrent sessions share one file** — multiple CLI instances append to the same `history.jsonl` with file-level locking. The `sessionId` field and session-prioritization logic in `getHistory()` prevent interleaving in the up-arrow experience.
- **Malformed lines are silently skipped** — corrupted or old-format JSONL lines are caught and logged for debugging, not surfaced as errors (`src/history.ts:131-134`).
- **`expandPastedTextRefs` processes replacements in reverse order** — this ensures that if pasted content itself contains placeholder-like strings (e.g., `[Pasted text #1]`), they are not accidentally matched and replaced (`src/history.ts:88-98`).