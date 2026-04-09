# Memory Services

## Overview & Responsibilities

Memory Services is a collection of three backend services within the **Services** layer that power Claude Code's persistent memory system. They sit between the core **MemorySystem** (which defines the memory store, CLAUDE.md ecosystem, and relevance ranking) and the **QueryEngine** (which triggers these services at query boundaries). Together they ensure that important information from conversations is captured, persisted, and synchronized across sessions and users.

The three services are:

| Service | Directory | Role |
|---------|-----------|------|
| **Session Memory** | `src/services/SessionMemory/` | Maintains a structured markdown notepad for the *current* session — extracts key facts periodically in the background |
| **Extract Memories** | `src/services/extractMemories/` | Writes durable, cross-session memories to the auto-memory directory (`~/.claude/projects/<path>/memory/`) at the end of each query loop |
| **Team Memory Sync** | `src/services/teamMemorySync/` | Synchronizes team memory files between the local filesystem and a server API, with file watching, secret scanning, and conflict resolution |

**Sibling modules** in the Services layer include the Claude API client, analytics pipeline, MCP protocol client, and context compaction engine — all of which Memory Services may interact with (e.g., analytics for telemetry, the API client indirectly via forked agents).

---

## Session Memory

### Purpose

Session Memory automatically maintains a markdown file with structured notes about the current conversation. It runs periodically in the background using a **forked subagent** — a perfect fork of the main conversation that shares the parent's prompt cache — so note extraction never interrupts the user's flow.

### Key Process: Extraction Lifecycle

1. **Initialization** (`initSessionMemory` — `src/services/SessionMemory/sessionMemory.ts:357-375`): Registers a post-sampling hook if auto-compact is enabled and the session is not in remote mode. The feature gate (`tengu_session_memory`) and remote config are checked lazily when the hook fires, not at registration time.

2. **Threshold evaluation** (`shouldExtractMemory` — `src/services/SessionMemory/sessionMemory.ts:134-181`): On every post-sampling hook invocation, the system checks two thresholds:
   - **Token threshold**: Context window must have grown by at least `minimumTokensBetweenUpdate` tokens (default 5,000) since the last extraction.
   - **Tool-call threshold**: At least `toolCallsBetweenUpdates` tool calls (default 3) since the last extraction.
   
   Extraction triggers when *both* thresholds are met, or when the token threshold is met and the last assistant turn has no tool calls (a natural conversation break). A one-time initialization gate (`minimumMessageTokensToInit`, default 10,000 tokens) prevents premature extraction at session start.

3. **File setup** (`setupSessionMemoryFile` — `src/services/SessionMemory/sessionMemory.ts:183-233`): Creates the session memory directory and file if they don't exist, populating the file with a customizable markdown template. The template is loaded from `~/.claude/session-memory/config/template.md` if present, falling back to `DEFAULT_SESSION_MEMORY_TEMPLATE`.

4. **Forked agent execution** (`src/services/SessionMemory/sessionMemory.ts:318-325`): A `runForkedAgent` call sends the extraction prompt to a forked subagent. The agent is only permitted to use the `Edit` tool on the exact memory file path — all other tools are denied via `createMemoryFileCanUseTool`.

5. **Post-extraction bookkeeping**: Records the current token count, updates the last-summarized message ID (only if the last turn had no tool calls to avoid orphaned `tool_result` blocks), and logs telemetry.

### Session Memory Template Structure

The default template (`src/services/SessionMemory/prompts.ts:11-41`) provides these sections:

- **Session Title** — short descriptive title
- **Current State** — active work, pending tasks, next steps
- **Task specification** — what the user asked to build
- **Files and Functions** — important files and their relevance
- **Workflow** — bash commands and their order
- **Errors & Corrections** — errors encountered and fixes
- **Codebase and System Documentation** — system components overview
- **Learnings** — what worked, what to avoid
- **Key results** — exact outputs the user requested
- **Worklog** — terse step-by-step log

The update prompt instructs the agent to preserve all section headers and italic description lines, only modifying content below them. Each section is capped at ~2,000 tokens, with a total budget of 12,000 tokens (`MAX_SECTION_LENGTH` and `MAX_TOTAL_SESSION_MEMORY_TOKENS` in `src/services/SessionMemory/prompts.ts:8-9`).

### Configuration

Session memory configuration can come from a remote GrowthBook config (`tengu_sm_config`) or fall back to defaults:

```typescript
// src/services/SessionMemory/sessionMemoryUtils.ts:32-36
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
}
```

Custom prompts and templates can be placed at:
- `~/.claude/session-memory/config/template.md` — custom template
- `~/.claude/session-memory/config/prompt.md` — custom extraction prompt (supports `{{currentNotes}}` and `{{notesPath}}` variable substitution)

### Utility Functions

`sessionMemoryUtils.ts` provides state management without circular dependencies:

- `waitForSessionMemoryExtraction()` — blocks up to 15s for in-progress extraction (with a 1-minute staleness check)
- `getSessionMemoryContent()` — reads the session memory file from disk
- `isSessionMemoryEmpty()` — checks if content matches the template (no real content extracted yet)
- `truncateSessionMemoryForCompact()` — truncates oversized sections when inserting session memory into compact messages

---

## Extract Memories

### Purpose

Extract Memories writes **durable, cross-session memories** to the auto-memory directory. Unlike Session Memory (which maintains an ephemeral per-session notepad), these memories persist across conversations and are loaded into the system prompt of future sessions.

It runs once at the end of each complete query loop (when the model produces a final response with no tool calls) via `handleStopHooks`.

### Key Process: Extraction Flow

1. **Initialization** (`initExtractMemories` — `src/services/extractMemories/extractMemories.ts:296-587`): Creates a fresh closure capturing all mutable state — cursor position, overlap guard, pending context, and in-flight tracking. This closure-scoped pattern (same as `confidenceRating.ts`) gives tests natural isolation via `beforeEach`.

2. **Gate checks** (`executeExtractMemoriesImpl` — `src/services/extractMemories/extractMemories.ts:527-567`):
   - Only runs for the main agent (not subagents)
   - Feature gate `tengu_passport_quail` must be enabled
   - Auto-memory must be enabled (`isAutoMemoryEnabled()`)
   - Not in remote mode

3. **Overlap management**: If an extraction is already in progress, the new context is stashed. After the current extraction completes, a single trailing extraction runs with the latest stashed context. This coalescing prevents overlapping runs while ensuring no messages are lost.

4. **Turn throttling** (`src/services/extractMemories/extractMemories.ts:377-385`): Extraction only runs every N eligible turns (controlled by `tengu_bramble_lintel`, default 1). Trailing extractions skip this check.

5. **Mutual exclusion with main agent** (`hasMemoryWritesSince` — `src/services/extractMemories/extractMemories.ts:121-148`): If the main agent already wrote to memory files (the system prompt has full save instructions), the forked extraction is skipped and the cursor advances past that range.

6. **Agent execution** (`src/services/extractMemories/extractMemories.ts:415-427`): Runs a forked agent with:
   - A memory manifest pre-injected (existing memory files with frontmatter) to avoid wasted turns
   - Tool permissions via `createAutoMemCanUseTool`: allows Read/Grep/Glob unrestricted, read-only Bash, and Edit/Write only within the auto-memory directory
   - Max 5 turns to prevent rabbit-holes
   - Transcript recording skipped to avoid race conditions

7. **Post-extraction**: Extracts written file paths from agent messages, logs telemetry, and appends a `memorySavedMessage` to the conversation if memories were saved.

### Tool Permissions

`createAutoMemCanUseTool` (`src/services/extractMemories/extractMemories.ts:171-222`) enforces a strict sandbox:

| Tool | Permission |
|------|-----------|
| `FileRead`, `Grep`, `Glob` | Allowed unrestricted (read-only) |
| `Bash` | Only read-only commands (ls, find, grep, cat, etc.) |
| `FileEdit`, `FileWrite` | Only for paths within the auto-memory directory |
| `REPL` | Allowed (inner primitives are still gated) |
| All others | Denied |

### Prompt Construction

Two prompt builders exist (`src/services/extractMemories/prompts.ts`):

- `buildExtractAutoOnlyPrompt` — for individual (private) memory only; uses the four-type memory taxonomy (user, feedback, project, reference)
- `buildExtractCombinedPrompt` — when team memory is enabled (`TEAMMEM` build flag); adds per-type scope guidance for choosing private vs. team memory directories, plus a rule against saving sensitive data in team memories

Both share an `opener()` that lists available tools and enforces the turn budget strategy: read all files in parallel (turn 1), then write all files in parallel (turn 2).

### Public API

- `executeExtractMemories(context, appendSystemMessage?)` — fire-and-forget entry point called from stop hooks
- `drainPendingExtraction(timeoutMs?)` — awaits all in-flight extractions with a soft timeout; called before graceful shutdown

---

## Team Memory Sync

### Purpose

Team Memory Sync enables multi-user memory synchronization by syncing team memory files between the local filesystem and a server API. Team memory is scoped per-repository (identified by GitHub remote) and shared across all authenticated org members via OAuth.

### Architecture Overview

The service has five files:

| File | Responsibility |
|------|---------------|
| `index.ts` | Core sync logic — fetch, upload, pull, push, conflict resolution |
| `watcher.ts` | File system watcher that triggers debounced pushes on local changes |
| `secretScanner.ts` | Client-side credential detection using gitleaks-derived patterns |
| `teamMemSecretGuard.ts` | Write-time guard called from FileWriteTool/FileEditTool |
| `types.ts` | Zod schemas and TypeScript types for the API contract |

### Key Process: Pull (Server to Local)

`pullTeamMemory` (`src/services/teamMemorySync/index.ts:770-867`):

1. Validates OAuth availability and GitHub remote
2. Fetches team memory via `GET /api/claude_code/team_memory?repo={owner/repo}` with ETag-based conditional requests (304 Not Modified support)
3. Parses response against `TeamMemoryDataSchema` (Zod validation)
4. Refreshes `serverChecksums` from server-provided per-key SHA-256 hashes
5. Writes remote entries to local directory via `writeRemoteEntriesToLocal`, which:
   - Validates each path against the team memory directory boundary (prevents path traversal)
   - Skips files whose on-disk content already matches (preserves mtime)
   - Skips oversized entries (>250KB)
   - Processes all entries in parallel
6. Clears memory file caches if any files were written

### Key Process: Push (Local to Server)

`pushTeamMemory` (`src/services/teamMemorySync/index.ts:889-1146`):

1. Reads all local team memory files via `readLocalTeamMemory`, which:
   - Walks the directory tree recursively
   - Skips oversized files (>`MAX_FILE_SIZE_BYTES` = 250KB)
   - **Scans each file for secrets** before inclusion — files with detected secrets are excluded from the upload
   - Applies server-learned entry count cap if known
2. Computes local content hashes (SHA-256) for each entry
3. **Delta computation**: Only uploads keys whose local hash differs from `serverChecksums`
4. **Batch splitting** (`batchDeltaByBytes` — `src/services/teamMemorySync/index.ts:426-460`): Splits the delta into PUT-sized batches under 200KB each to stay under the API gateway's body-size limit
5. Uploads batches sequentially via `PUT /api/claude_code/team_memory`
6. **Conflict resolution**: On 412 (ETag mismatch), probes `GET ?view=hashes` for a cheap serverChecksums refresh, recomputes the delta, and retries (up to 2 conflict retries). Local-wins-on-conflict: the local user's edit overwrites the server version for that key.

### Key Process: File Watcher

`startTeamMemoryWatcher` (`src/services/teamMemorySync/watcher.ts:252-305`):

1. Validates `TEAMMEM` build flag, `isTeamMemoryEnabled()`, OAuth availability, and GitHub remote presence
2. Creates a `SyncState` instance
3. Performs an initial pull from the server
4. Starts `fs.watch` with `recursive: true` on the team memory directory
5. On file change events, schedules a debounced push (2-second debounce via `DEBOUNCE_MS`)

**Push suppression** (`src/services/teamMemorySync/watcher.ts:51`): After a permanent failure (no OAuth, 4xx except 409/429), further pushes are suppressed to prevent infinite retry loops. Suppression clears on file deletion (detected via `stat` ENOENT on watch events), which is the recovery action for too-many-entries errors.

**Shutdown** (`stopTeamMemoryWatcher` — `src/services/teamMemorySync/watcher.ts:327-352`): Closes the watcher, awaits any in-flight push, and flushes pending debounced changes as a best-effort final push.

### Secret Scanner

`secretScanner.ts` (`src/services/teamMemorySync/secretScanner.ts`) implements client-side credential detection to prevent secrets from ever leaving the user's machine. It uses a curated subset of high-confidence rules from gitleaks:

**Covered credential types** (30+ rules):
- Cloud providers: AWS access tokens, GCP API keys, Azure AD client secrets, DigitalOcean tokens
- AI APIs: Anthropic API keys (assembled at runtime to avoid literal presence in bundle), OpenAI keys, HuggingFace tokens
- Version control: GitHub PATs/fine-grained PATs/app tokens/OAuth/refresh tokens, GitLab PATs/deploy tokens
- Communication: Slack bot/user/app tokens, Twilio API keys, SendGrid tokens
- Dev tooling: NPM/PyPI tokens, Databricks/HashiCorp/Pulumi/Postman tokens
- Observability: Grafana keys/cloud tokens/service account tokens, Sentry tokens
- Payment: Stripe access tokens, Shopify tokens
- Crypto: PEM private keys

Key design decisions:
- Rules are **lazily compiled** on first scan (`src/services/teamMemorySync/secretScanner.ts:229-237`)
- Matched secret values are **never returned or logged** — only the rule ID and a human-readable label
- `redactSecrets()` replaces matched spans with `[REDACTED]` while preserving boundary characters
- The Anthropic API key prefix is assembled at runtime via `['sk', 'ant', 'api'].join('-')` to avoid the literal sequence in the bundle

### Team Memory Secret Guard

`teamMemSecretGuard.ts` (`src/services/teamMemorySync/teamMemSecretGuard.ts`) provides `checkTeamMemSecrets(filePath, content)` — a write-time validation hook called from `FileWriteTool` and `FileEditTool`. It returns an error message if the content contains detected secrets and the target path is a team memory path, or `null` if safe. The function is safe to call unconditionally; the internal `feature('TEAMMEM')` guard keeps it inert when the build flag is off.

### Function Signatures

#### `scanForSecrets(content: string): SecretMatch[]`

Scans a string for potential secrets. Returns one match per rule that fired (deduplicated by rule ID). The actual matched text is intentionally not returned.

> Source: `src/services/teamMemorySync/secretScanner.ts:277-295`

#### `redactSecrets(content: string): string`

Replaces any matched secrets in-place with `[REDACTED]`. Preserves boundary characters around matched spans.

> Source: `src/services/teamMemorySync/secretScanner.ts:312-324`

#### `checkTeamMemSecrets(filePath: string, content: string): string | null`

Returns an error message string if the content contains secrets and the path is a team memory path. Returns `null` if safe.

> Source: `src/services/teamMemorySync/teamMemSecretGuard.ts:15-44`

### Sync State

All mutable state lives in a `SyncState` object (`src/services/teamMemorySync/index.ts:100-127`):

```typescript
export type SyncState = {
  lastKnownChecksum: string | null          // ETag for conditional requests
  serverChecksums: Map<string, string>       // Per-key SHA-256 hashes
  serverMaxEntries: number | null            // Learned from structured 413 responses
}
```

This avoids module-level mutable state and gives tests natural isolation.

### Type Definitions

`types.ts` (`src/services/teamMemorySync/types.ts`) defines Zod schemas for the API contract:

| Schema | Description |
|--------|-------------|
| `TeamMemoryContentSchema` | Flat key-value storage with optional per-key checksums |
| `TeamMemoryDataSchema` | Full GET response: org, repo, version, lastModified, checksum, content |
| `TeamMemoryTooManyEntriesSchema` | Structured 413 error with `max_entries` and `received_entries` |

Result types: `TeamMemorySyncFetchResult`, `TeamMemoryHashesResult`, `TeamMemorySyncPushResult`, `TeamMemorySyncUploadResult`, and `SkippedSecretFile`.

---

## Edge Cases & Caveats

- **Session Memory requires auto-compact**: `initSessionMemory` returns early if auto-compact is disabled, since session memory is used during compaction.
- **Remote mode exclusion**: Both Session Memory and Extract Memories are disabled in remote mode.
- **Extraction wait timeout**: `waitForSessionMemoryExtraction` has a 15-second timeout and treats extractions older than 60 seconds as stale.
- **Template variable injection safety**: The `substituteVariables` function in `src/services/SessionMemory/prompts.ts:201-213` uses single-pass replacement to avoid `$` backreference corruption and double-substitution when user content contains `{{varName}}` patterns.
- **Team memory file deletions don't propagate**: Deleting a local team memory file won't remove it from the server; the next pull restores it locally. This is by design — there is no `soft_delete_keys` API yet.
- **Gateway body-size limit**: The API gateway rejects PUT bodies over ~256-512KB before reaching the app server. `MAX_PUT_BODY_BYTES` (200KB) provides headroom, with larger deltas split into sequential batches.
- **Push suppression prevents infinite retries**: After permanent failures (no OAuth, most 4xx), the watcher suppresses further push attempts until a file deletion or session restart.
- **Secret scanner never logs secret values**: Only rule IDs and human-readable labels are recorded — actual credential text is intentionally never captured in telemetry or logs.
- **Extract Memories mutual exclusion**: When the main agent writes memories directly (via its system prompt instructions), the background extraction agent skips that turn entirely to avoid duplicate writes.