# MemoryRetrieval

## Overview & Responsibilities

MemoryRetrieval is the query-time recall subsystem within the **MemorySystem** module. When a user sends a message, this module determines which persisted memories (if any) are relevant and should be surfaced to the main conversation. It handles three concerns:

1. **Scanning** — Reading the memory directory, parsing frontmatter headers from `.md` files, and producing a compact manifest of available memories.
2. **Relevance ranking** — Sending the user's query plus the memory manifest to a Sonnet side-model that selects the most useful memories (up to 5).
3. **Age & freshness** — Computing human-readable memory ages and attaching staleness caveats so the main model doesn't treat outdated observations as current fact.

Within the broader architecture, MemoryRetrieval sits between the persistent memory store on disk and the QueryEngine's system prompt assembly. The Services layer calls `findRelevantMemories()` before each query turn; the returned paths are read and injected into the conversation context.

---

## Key Processes

### Memory Scanning Flow

1. `scanMemoryFiles()` reads the memory directory recursively via `fs.readdir` (`src/memdir/memoryScan.ts:40`)
2. Filters to `.md` files, excluding `MEMORY.md` (the index file, already loaded in the system prompt)
3. For each file, reads the first 30 lines via `readFileInRange()` — enough to capture frontmatter without reading full content (`src/memdir/memoryScan.ts:48-54`)
4. Parses YAML frontmatter with `parseFrontmatter()`, extracting `description` and `type` fields
5. Sorts results newest-first by `mtimeMs` and caps at **200 files** (`src/memdir/memoryScan.ts:72-73`)

This is a single-pass design: `readFileInRange` returns `mtimeMs` from its internal stat call, avoiding a separate stat round. The `Promise.allSettled` pattern means individual file read failures are silently dropped rather than failing the entire scan.

### Relevance Selection Flow

1. `findRelevantMemories()` calls `scanMemoryFiles()` and filters out any paths in `alreadySurfaced` (memories shown in prior turns) (`src/memdir/findRelevantMemories.ts:46-48`)
2. If no candidate memories remain, returns early with an empty array
3. Formats the memory list into a text manifest via `formatMemoryManifest()` — one line per memory with `[type] filename (ISO timestamp): description`
4. Sends a structured side-query to Sonnet (`sideQuery()`) with:
   - A system prompt instructing selective, conservative memory picking
   - The user's query text plus the manifest
   - An optional list of recently-used tools (to suppress redundant reference docs)
   - A JSON schema constraint requiring `{ selected_memories: string[] }` output
5. Parses the Sonnet response and validates that every returned filename actually exists in the scanned set (`src/memdir/findRelevantMemories.ts:130`)
6. Optionally logs telemetry about recall shape (selection rate) when the `MEMORY_SHAPE_TELEMETRY` feature flag is enabled
7. Returns an array of `{ path, mtimeMs }` for the selected memories

### Age Calculation & Freshness Caveat Flow

1. `memoryAgeDays()` computes floor-rounded days since a memory's mtime, clamping negative values (clock skew) to 0 (`src/memdir/memoryAge.ts:7`)
2. `memoryAge()` converts the day count into human-readable text: `"today"`, `"yesterday"`, or `"N days ago"` — because models reason better about relative time than raw ISO timestamps
3. `memoryFreshnessText()` generates a staleness warning for memories older than 1 day, reminding the model that file:line citations and code-state claims may be outdated (`src/memdir/memoryAge.ts:33-41`)
4. `memoryFreshnessNote()` wraps the staleness text in `<system-reminder>` tags for contexts that don't already provide their own wrapper

---

## Function Signatures

### `findRelevantMemories(query, memoryDir, signal, recentTools?, alreadySurfaced?): Promise<RelevantMemory[]>`

Main entry point. Scans memory files, asks Sonnet which are relevant, and returns up to 5 selected memories.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | — | The user's current message text |
| `memoryDir` | `string` | — | Absolute path to the memory directory |
| `signal` | `AbortSignal` | — | Cancellation signal |
| `recentTools` | `readonly string[]` | `[]` | Tool names used recently; suppresses reference-doc matches for these tools |
| `alreadySurfaced` | `ReadonlySet<string>` | `new Set()` | Absolute paths of memories already shown in prior turns |

**Returns**: `RelevantMemory[]` — array of `{ path: string, mtimeMs: number }`

> Source: `src/memdir/findRelevantMemories.ts:39-75`

### `scanMemoryFiles(memoryDir, signal): Promise<MemoryHeader[]>`

Scans the memory directory for `.md` files, reads their frontmatter, returns headers sorted newest-first (max 200).

> Source: `src/memdir/memoryScan.ts:35-77`

### `formatMemoryManifest(memories): string`

Formats memory headers into a text manifest for inclusion in LLM prompts. Each line: `- [type] filename (ISO timestamp): description`.

> Source: `src/memdir/memoryScan.ts:84-94`

### `memoryAgeDays(mtimeMs): number`

Returns floor-rounded days since `mtimeMs`. Clamps negative values to 0.

> Source: `src/memdir/memoryAge.ts:6-8`

### `memoryAge(mtimeMs): string`

Human-readable age: `"today"`, `"yesterday"`, or `"N days ago"`.

> Source: `src/memdir/memoryAge.ts:15-20`

### `memoryFreshnessText(mtimeMs): string`

Returns a plain-text staleness caveat for memories >1 day old. Returns `''` for fresh memories.

> Source: `src/memdir/memoryAge.ts:33-42`

### `memoryFreshnessNote(mtimeMs): string`

Wraps `memoryFreshnessText` output in `<system-reminder>` tags. Returns `''` for memories ≤1 day old.

> Source: `src/memdir/memoryAge.ts:49-53`

---

## Type Definitions

### `RelevantMemory`

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Absolute path to the memory file |
| `mtimeMs` | `number` | File modification time in milliseconds (for freshness display without a second stat) |

> Source: `src/memdir/findRelevantMemories.ts:13-16`

### `MemoryHeader`

| Field | Type | Description |
|-------|------|-------------|
| `filename` | `string` | Relative path within the memory directory |
| `filePath` | `string` | Absolute path on disk |
| `mtimeMs` | `number` | File modification time in milliseconds |
| `description` | `string \| null` | From frontmatter `description` field |
| `type` | `MemoryType \| undefined` | Parsed memory type (user, feedback, project, reference) |

> Source: `src/memdir/memoryScan.ts:13-19`

---

## Configuration & Defaults

| Constant | Value | Location | Description |
|----------|-------|----------|-------------|
| `MAX_MEMORY_FILES` | 200 | `memoryScan.ts:21` | Maximum memory files considered per scan |
| `FRONTMATTER_MAX_LINES` | 30 | `memoryScan.ts:22` | Lines read per file to capture frontmatter |
| Max selected memories | 5 | `findRelevantMemories.ts:21` | Enforced by the Sonnet system prompt |
| `max_tokens` for side query | 256 | `findRelevantMemories.ts:108` | Token budget for the Sonnet selection response |
| Staleness threshold | >1 day | `memoryAge.ts:35` | Memories older than 1 day get a freshness caveat |

---

## Edge Cases & Caveats

- **MEMORY.md is always excluded** from scanning — it's the index file and is already injected into the system prompt separately (`memoryScan.ts:42`).
- **`alreadySurfaced` filtering** happens before the Sonnet call, so previously-shown memories don't waste slots in the 5-memory budget.
- **Recently-used tools** are passed to the selector to suppress reference-doc false positives. However, warnings/gotchas about those tools are explicitly kept — the system prompt instructs: "DO still select memories containing warnings, gotchas, or known issues about those tools" (`findRelevantMemories.ts:23`).
- **Graceful degradation**: Both `scanMemoryFiles` and `selectRelevantMemories` return empty arrays on any error (file system failures, API errors, abort signals). Memory retrieval never blocks the main query.
- **Clock skew**: `memoryAgeDays` clamps negative ages to 0 — a file with a future mtime is treated as "today" rather than producing nonsensical output.
- **Staleness caveats exist because** models treat file:line citations as authoritative evidence. A memory saying "see `src/auth.ts:42`" sounds precise, but if the code has changed, the citation is misleading. The freshness warning explicitly tells the model to verify against current code before asserting stale claims as fact.
- **Feature-gated telemetry**: The `MEMORY_SHAPE_TELEMETRY` feature flag controls whether recall metrics (how many memories were offered vs. selected) are logged. This uses `bun:bundle`'s `feature()` for build-time gating (`findRelevantMemories.ts:66`).