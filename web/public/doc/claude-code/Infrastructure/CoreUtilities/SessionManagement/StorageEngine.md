# StorageEngine

## Overview & Responsibilities

The StorageEngine module is the core session persistence layer for Claude Code, responsible for storing, reading, and managing all conversation data. It sits within the **Infrastructure > CoreUtilities > SessionManagement** hierarchy and is depended upon by virtually every other subsystem that needs to read or write session state — the query engine, resume flow, compaction service, remote sessions, and the VS Code extension.

The module is split into two files with distinct roles:

- **`SessionStorage`** (`src/utils/sessionStorage.ts`, ~5100 lines) — The full-featured persistence engine used by the CLI. Manages the complete JSONL transcript lifecycle: writing messages with `parentUuid` chain linking, buffered/batched file I/O, session metadata persistence (titles, tags, PR links, agent settings, worktree state), remote session hydration, compact-boundary-aware loading, dead-fork pruning before parse, and progressive session listing with lite metadata reads.

- **`SessionStoragePortable`** (`src/utils/sessionStoragePortable.ts`, ~790 lines) — Pure Node.js utilities with zero internal dependencies. Shared between the CLI and the VS Code extension. Provides JSON string field extraction without full parsing, head/tail file reading for lightweight metadata, first-prompt extraction from JSONL, path sanitization, project directory discovery, and a high-performance chunked forward-read transcript loader that strips attribution snapshots and handles compact boundaries in a single pass.

## Key Processes

### 1. Writing a Conversation Turn

When a query turn completes, messages flow through `recordTranscript()` → `Project.insertMessageChain()` → `Project.appendEntry()` → batched file I/O.

1. `recordTranscript()` (`src/utils/sessionStorage.ts:1408-1449`) deduplicates messages against the session's known UUID set, tracking the prefix parent chain for correct `parentUuid` linking after compaction.
2. `insertMessageChain()` (`src/utils/sessionStorage.ts:993-1083`) stamps each message with session metadata (`sessionId`, `version`, `cwd`, `gitBranch`, `slug`), assigns `parentUuid` linkage (skipping progress messages via `isChainParticipant`), and handles `sourceToolAssistantUUID` for parallel tool results.
3. `appendEntry()` (`src/utils/sessionStorage.ts:1128-1265`) routes entries by type — metadata entries (titles, tags, modes) are enqueued immediately, while transcript messages are dedup-checked and written to either the main session file or an agent sidechain file.
4. The `Project` class batches writes via `enqueueWrite()` → `drainWriteQueue()`, flushing every 100ms (or 10ms for remote sessions). Writes are chunked at 100MB to prevent OOM on large batches.

```
recordTranscript(messages)
  → cleanMessagesForLogging(messages)        // Filter progress, strip REPL wrappers
  → dedup against getSessionMessages(uuid)   // Skip already-recorded UUIDs
  → Project.insertMessageChain(newMessages)  // Stamp metadata, assign parentUuids
    → appendEntry(entry)                     // Route by type, enqueue write
      → enqueueWrite(filePath, entry)        // Buffer into per-file queue
        → scheduleDrain()                    // Timer-based flush (100ms default)
          → drainWriteQueue()                // Batch serialize + appendFile
```

### 2. Session File Materialization (Lazy Creation)

Session files are not created at startup. The `Project` class buffers entries in `pendingEntries` until the first user or assistant message triggers `materializeSessionFile()` (`src/utils/sessionStorage.ts:976-991`). This prevents metadata-only orphan files from being created when a session starts but the user quits before sending a message.

### 3. Loading a Transcript for Resume

Loading a session for `--resume` or `--continue` is a multi-stage pipeline optimized for large files (sessions can grow to multiple GB):

1. **Size check**: Files >5MB enter the optimized path via `readTranscriptForLoad()` from the portable module.
2. **Chunked forward read** (`sessionStoragePortable.ts:717-793`): Reads the file in 1MB chunks, stripping attribution snapshots at the fd level and truncating at compact boundaries. Peak memory is output size, not file size.
3. **Dead fork pruning** (`walkChainBeforeParse`, `src/utils/sessionStorage.ts:3306-3466`): For large buffers, performs a byte-level pre-pass that walks the `parentUuid` chain from the leaf backward, excising dead fork branches before JSON parsing. Measured 93% speedup on fork-heavy sessions.
4. **JSONL parsing**: `parseJSONL` converts the pruned buffer into entries.
5. **Entry classification** (`loadTranscriptFile`, `src/utils/sessionStorage.ts:3472-3813`): Routes each entry into typed maps — messages, summaries, titles, tags, file history snapshots, attribution snapshots, content replacements, context-collapse commits, etc.
6. **Post-processing**: `applyPreservedSegmentRelinks()` splices preserved segments back into the chain after compaction. `applySnipRemovals()` deletes middle-range removals and relinks across gaps.
7. **Leaf computation**: Identifies terminal messages (no children), walks back to the nearest user/assistant ancestor to find leaf UUIDs.
8. **Chain building**: `buildConversationChain()` (`src/utils/sessionStorage.ts:2069-2094`) walks `parentUuid` from leaf to root, producing the linear conversation. `recoverOrphanedParallelToolResults()` post-passes to recover sibling assistant blocks and tool results orphaned by the single-parent walk.

### 4. Progressive Session Listing

The resume picker uses a two-phase loading strategy to appear fast:

1. **Stat-only phase** (`getSessionFilesLite`, `src/utils/sessionStorage.ts:4975-5016`): Reads only filesystem metadata (mtime, size, ctime) via `stat()` — no file reads. Returns "lite" `LogOption` objects with empty messages.
2. **Enrichment phase** (`enrichLogs`, `src/utils/sessionStorage.ts:5077-5105`): Reads the first and last 64KB of each file (`readHeadAndTail` from portable module) to extract metadata: `firstPrompt`, `customTitle`, `gitBranch`, `tag`, `isSidechain`, etc. Filters out sidechains and agent sessions. Only the visible page of sessions is enriched initially (50 sessions = ~6.4MB I/O).

### 5. Metadata Re-append on Exit

Session metadata (title, tag, agent name/color, mode, worktree state, PR link) is cached in the `Project` singleton and re-appended to EOF on session exit via `reAppendSessionMetadata()` (`src/utils/sessionStorage.ts:721-838`). This ensures metadata stays within the 64KB tail window that `readLiteMetadata` reads during progressive loading. Before re-appending, the method refreshes SDK-mutable fields (title, tag) from a sync tail read to avoid clobbering values written by external processes (e.g., the VS Code extension).

### 6. Remote Session Hydration

Two remote persistence paths exist:

- **v1 Session Ingress** (`hydrateRemoteSession`, `src/utils/sessionStorage.ts:1587-1622`): Fetches logs from a remote ingress URL and writes them to the local transcript file.
- **CCR v2 Internal Events** (`hydrateFromCCRv2InternalEvents`, `src/utils/sessionStorage.ts:1632-1723`): Fetches foreground and subagent events via registered readers, groups subagent events by `agent_id`, and writes each to its own transcript file.

## Function Signatures

### Core Write API

#### `recordTranscript(messages, teamInfo?, startingParentUuidHint?, allMessages?): Promise<UUID | null>`
Main entry point for persisting conversation messages. Deduplicates against existing session UUIDs and returns the last recorded chain participant's UUID.

#### `recordSidechainTranscript(messages, agentId?, startingParentUuid?): Promise<void>`
Persists agent/sidechain transcript messages to a separate per-agent file.

#### `flushSessionStorage(): Promise<void>`
Flushes all queued writes to disk. Called before shutdown.

### Metadata API

#### `saveCustomTitle(sessionId, customTitle, fullPath?, source?): Promise<void>`
Persists a user-set session title.

#### `saveAiGeneratedTitle(sessionId, aiTitle): void`
Persists an AI-generated title as a distinct `ai-title` entry. Never re-appended, so user titles always win.

#### `saveTag(sessionId, tag, fullPath?): Promise<void>`
Tags a session (e.g., for filtering in the resume picker).

#### `linkSessionToPR(sessionId, prNumber, prUrl, prRepository, fullPath?): Promise<void>`
Associates a session with a GitHub PR.

#### `saveWorktreeState(worktreeSession | null): void`
Records the session's worktree state for `--resume`. Pass `null` to indicate exit from worktree.

#### `restoreSessionMetadata(meta): void`
Populates the in-memory cache on resume. Used so metadata is available for display and re-append.

### Read API

#### `loadTranscriptFile(filePath, opts?): Promise<{messages, summaries, customTitles, tags, ...}>`
Full transcript loader. Returns typed maps of all entry types. Core of both resume and log viewing.

#### `buildConversationChain(messages, leafMessage): TranscriptMessage[]`
Walks `parentUuid` from leaf to root, producing the linear conversation array.

#### `loadFullLog(log): Promise<LogOption>`
Upgrades a lite log to a full log by reading and parsing its JSONL file.

#### `getAgentTranscript(agentId): Promise<{messages, contentReplacements} | null>`
Loads a subagent's transcript from its dedicated file.

#### `fetchLogs(limit?): Promise<LogOption[]>`
Returns lite session logs for the current project directory.

### Session Resolution

#### `resolveSessionFilePath(sessionId, dir?): Promise<{filePath, projectPath, fileSize} | undefined>`
Resolves a session ID to its on-disk JSONL path. Handles worktree fallback and cross-project scanning.
> Source: `src/utils/sessionStoragePortable.ts:403-466`

## Interface/Type Definitions

### `AgentMetadata`
```typescript
type AgentMetadata = {
  agentType: string
  worktreePath?: string   // If spawned with isolation: "worktree"
  description?: string    // Original task description
}
```
> Source: `src/utils/sessionStorage.ts:264-272`

### `RemoteAgentMetadata`
```typescript
type RemoteAgentMetadata = {
  taskId: string
  remoteTaskType: string
  sessionId: string       // CCR session ID for live status
  title: string
  command: string
  spawnedAt: number
  toolUseId?: string
  isLongRunning?: boolean
  isUltraplan?: boolean
  isRemoteReview?: boolean
  remoteTaskMetadata?: Record<string, unknown>
}
```
> Source: `src/utils/sessionStorage.ts:305-318`

### `SessionLogResult`
```typescript
type SessionLogResult = {
  logs: LogOption[]           // Enriched logs ready for display
  allStatLogs: LogOption[]    // Full stat-only list for progressive loading
  nextIndex: number           // Where progressive loading should continue
}
```
> Source: `src/utils/sessionStorage.ts:4064-4071`

### `LiteSessionFile` (Portable)
```typescript
type LiteSessionFile = {
  mtime: number
  size: number
  head: string   // First 64KB
  tail: string   // Last 64KB
}
```
> Source: `src/utils/sessionStoragePortable.ts:244-249`

## Configuration & Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `LITE_READ_BUF_SIZE` | 65,536 (64KB) | Head/tail buffer for lite metadata reads |
| `MAX_TRANSCRIPT_READ_BYTES` | 50MB | OOM guard for raw transcript reads |
| `MAX_TOMBSTONE_REWRITE_BYTES` | 50MB | Tombstone slow-path size limit |
| `SKIP_PRECOMPACT_THRESHOLD` | 5MB | File size above which pre-compact filtering is applied |
| `TRANSCRIPT_READ_CHUNK_SIZE` | 1MB | Chunk size for the forward transcript reader |
| `FLUSH_INTERVAL_MS` | 100ms (local), 10ms (remote) | Write queue flush interval |
| `MAX_CHUNK_BYTES` | 100MB | Maximum bytes per write batch |
| `INITIAL_ENRICH_COUNT` | 50 | Sessions enriched on initial resume picker load |
| `MAX_SANITIZED_LENGTH` | 200 | Max filesystem component length before hash suffix |

**Environment variables:**
- `ENABLE_SESSION_PERSISTENCE` — enables v1 remote ingress persistence
- `CLAUDE_CODE_SKIP_PROMPT_HISTORY` — suppresses all transcript writes
- `CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP` — disables pre-compact optimization
- `TEST_ENABLE_SESSION_PERSISTENCE` — allows persistence in test environment
- `CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT` — saves hook attachment context

## Edge Cases & Caveats

- **Lazy file creation**: Session files are not created until the first user/assistant message. Metadata-only entries (mode, agent setting) are buffered in `pendingEntries` and flushed on materialization. This prevents orphan files when a session starts but the user quits immediately.

- **Fork dedup subtlety**: Agent sidechain writes bypass UUID dedup against the main session's `messageSet` (`src/utils/sessionStorage.ts:1224-1261`). Adding sidechain UUIDs to the main set would cause `recordTranscript` to skip them on the main thread, breaking the `parentUuid` chain.

- **Compact boundary metadata recovery**: When a compact boundary truncates pre-boundary content, session-scoped metadata (agent-setting, mode, pr-link) written before the boundary would be lost. `scanPreBoundaryMetadata()` (`src/utils/sessionStorage.ts:3157-3224`) performs a byte-level forward scan of `[0, boundary)` to recover these entries without parsing message content.

- **Progress bridge for legacy transcripts**: Transcripts written before PR #24099 have `progress` entries in the `parentUuid` chain. `loadTranscriptFile` maintains a `progressBridge` map that chain-resolves through consecutive progress entries, rewriting `parentUuid` on subsequent messages to skip the gap (`src/utils/sessionStorage.ts:3623-3644`).

- **Parallel tool result recovery**: Streaming emits one `AssistantMessage` per `content_block_stop` — N parallel tool_uses produce N messages with the same `message.id` but different UUIDs. `recoverOrphanedParallelToolResults()` (`src/utils/sessionStorage.ts:2118-2206`) post-passes the chain to splice in orphaned siblings and their tool results.

- **Title precedence**: User titles (`custom-title` entries, `customTitle` field) always win over AI titles (`ai-title` entries, `aiTitle` field). The distinct field names allow `extractLastJsonStringField` to naturally disambiguate in both head and tail reads.

- **Tombstone removal**: `removeMessageByUuid()` (`src/utils/sessionStorage.ts:871-951`) has a fast path that reads only the last 64KB (the target is almost always the most recently appended entry) and a slow path that rewrites the file, gated at 50MB to prevent OOM.

- **Hash mismatch between runtimes**: The CLI uses `Bun.hash` while Node.js (SDK/VS Code) uses `djb2Hash` for path sanitization. `findProjectDir()` (`src/utils/sessionStoragePortable.ts:354-380`) falls back to prefix-based directory scanning when the exact hash-suffixed match doesn't exist.

## Key Code Snippets

### The Project Singleton Write Queue

The `Project` class manages a timer-based batched write queue. Entries are buffered per-file and flushed in a single `appendFile` call:

```typescript
// src/utils/sessionStorage.ts:606-616
private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
  return new Promise<void>(resolve => {
    let queue = this.writeQueues.get(filePath)
    if (!queue) {
      queue = []
      this.writeQueues.set(filePath, queue)
    }
    queue.push({ entry, resolve })
    this.scheduleDrain()
  })
}
```

### Compact-Boundary-Aware Chunked Read

The portable module's `readTranscriptForLoad` reads files in 1MB chunks, stripping attribution snapshots and truncating at compact boundaries in a single forward pass:

```typescript
// src/utils/sessionStoragePortable.ts:717-793
export async function readTranscriptForLoad(
  filePath: string,
  fileSize: number,
): Promise<{
  boundaryStartOffset: number
  postBoundaryBuf: Buffer
  hasPreservedSegment: boolean
}>
```

### JSON String Field Extraction Without Full Parse

The portable module provides regex-free field extraction that works on truncated JSONL lines:

```typescript
// src/utils/sessionStoragePortable.ts:53-76
export function extractJsonStringField(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue
    const valueStart = idx + pattern.length
    let i = valueStart
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i))
      }
      i++
    }
  }
  return undefined
}
```