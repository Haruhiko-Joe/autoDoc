# SessionCommands

## Overview & Responsibilities

SessionCommands is the collection of slash commands within the **CommandSystem** module that manage the CLI session lifecycle and conversation context. These 18 command directories provide users with full control over how conversations are created, navigated, preserved, and shared. They sit between the TerminalUI (which dispatches slash commands) and lower-level systems like the QueryEngine, Services, and Infrastructure layers.

The commands fall into several functional groups:

- **Session lifecycle**: `/clear`, `/exit`, `/compact` — start fresh, quit, or compress context
- **Session navigation**: `/resume`, `/session`, `/branch` — switch between and fork conversations
- **Session identity**: `/rename` — label conversations for later retrieval
- **Conversation manipulation**: `/rewind`, `/copy` — restore previous states or extract content
- **Context management**: `/files`, `/add-dir`, `/context` — inspect and expand the working scope
- **Persistent memory**: `/memory` — edit CLAUDE.md instruction files
- **Special features**: `/think-back`, `/thinkback-play` — year-in-review experience
- **Stubs (disabled)**: `/share`, `/teleport`, `/summary` — reserved for future functionality

Each command is a self-contained module with an `index.ts` metadata definition and a lazy-loaded implementation file, following the command framework's `Command` interface pattern.

## Key Processes

### Session Clear Flow (`/clear`)

The `/clear` command (aliases: `/reset`, `/new`) performs a comprehensive session teardown and rebuild. This is the most complex lifecycle operation.

1. Execute `SessionEnd` hooks with a configurable timeout (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`, default 1.5s) — `src/commands/clear/conversation.ts:66-74`
2. Send a cache eviction hint to inference via analytics — `src/commands/clear/conversation.ts:77-85`
3. Identify background tasks to preserve (tasks with `isBackgrounded !== false` survive the clear) — `src/commands/clear/conversation.ts:93-107`
4. Wipe messages via `setMessages(() => [])` — `src/commands/clear/conversation.ts:109`
5. Call `clearSessionCaches()` which resets 25+ individual caches: context caches, file suggestion caches, prompt cache break detection, system prompt injection, skills, LSP diagnostics, magic docs, web fetch cache, tool search cache, agent definitions cache, and more — `src/commands/clear/caches.ts:47-144`
6. Reset working directory to the original cwd — `src/commands/clear/conversation.ts:129`
7. Clean app state: kill foreground tasks (abort controllers, shell processes), reset attribution, file history, MCP state, and standalone agent context — `src/commands/clear/conversation.ts:135-192`
8. Regenerate session ID (marking old session as parent for analytics lineage) — `src/commands/clear/conversation.ts:203`
9. Re-point preserved background task symlinks to the new session directory — `src/commands/clear/conversation.ts:218-224`
10. Execute `SessionStart` hooks and inject any hook-generated messages — `src/commands/clear/conversation.ts:245-250`

### Conversation Compaction Flow (`/compact`)

The `/compact` command reduces conversation history while preserving a summary. It supports an optional custom summarization instruction argument.

1. Filter messages to those after the compact boundary (preserving UI scrollback) — `src/commands/compact/compact.ts:46`
2. **Session memory compaction** is tried first (if no custom instructions) via `trySessionMemoryCompaction()` — `src/commands/compact/compact.ts:58-83`
3. If reactive-only mode is enabled, route through `compactViaReactive()` which runs pre-compact hooks and cache-sharing parameter builds concurrently — `src/commands/compact/compact.ts:87-94`
4. Otherwise, fall back to traditional compaction: run microcompact first to reduce tokens, then call `compactConversation()` with the full system prompt context — `src/commands/compact/compact.ts:97-108`
5. After success, suppress the compact warning, clear user context cache, and run post-compact cleanup — `src/commands/compact/compact.ts:114-118`
6. Can be disabled via the `DISABLE_COMPACT` environment variable

### Session Resume Flow (`/resume`)

The `/resume` command (alias: `/continue`) allows users to restore a previous conversation. Accepts an optional session ID or search term argument.

1. **No argument**: Displays an interactive `LogSelector` picker showing resumable sessions from the same repo (with toggle for all projects) — `src/commands/resume/resume.tsx:107-189`
2. **UUID argument**: Directly looks up the session by ID and resumes it — `src/commands/resume/resume.tsx:222-229`
3. **Search term**: First checks custom titles for exact/prefix matches, then searches first-prompt text, and finally tries agentic session search — `src/commands/resume/resume.tsx:206-end`
4. Cross-project resume detection: if the session is from a different directory, copies the resume command to clipboard instead of resuming directly — `src/commands/resume/resume.tsx:147-166`
5. Sessions are filtered to exclude the current session and sidechain conversations — `src/commands/resume/resume.tsx:191-193`

### Conversation Branch Flow (`/branch`)

The `/branch` command (alias: `/fork` when `FORK_SUBAGENT` feature is disabled) creates a copy of the current conversation as a new session.

1. Read the current transcript JSONL file and parse all entries — `src/commands/branch/branch.ts:78-90`
2. Filter to main conversation messages (exclude sidechains) — `src/commands/branch/branch.ts:93-96`
3. Preserve content-replacement entries (to avoid prompt cache misses on resume) — `src/commands/branch/branch.ts:105-111`
4. Build new transcript entries with a fresh session ID, preserving all original metadata and adding `forkedFrom` traceability — `src/commands/branch/branch.ts:122-146`
5. Write the fork session file with proper permissions (mode `0o600`) — `src/commands/branch/branch.ts:161-164`
6. Generate a unique fork name with collision handling: "Name (Branch)", "Name (Branch 2)", etc. — `src/commands/branch/branch.ts:179-220`
7. Resume into the forked conversation — `src/commands/branch/branch.ts:279-281`

### Exit Flow (`/exit`)

The `/exit` command (alias: `/quit`) handles three distinct scenarios:

1. **Background session** (`claude --bg` inside tmux): detaches the tmux client via `spawnSync('tmux', ['detach-client'])` so the REPL keeps running and `claude attach` can reconnect — `src/commands/exit/exit.tsx:18-24`
2. **Worktree session**: renders an `ExitFlow` component to handle worktree cleanup before exiting — `src/commands/exit/exit.tsx:25-28`
3. **Normal session**: displays a random goodbye message and calls `gracefulShutdown(0, 'prompt_input_exit')` — `src/commands/exit/exit.tsx:29-31`

### Rename Flow (`/rename`)

The `/rename` command labels the current session for easier identification in `/resume`.

1. If no argument provided, calls `generateSessionName()` which uses Haiku to produce a 2-4 word kebab-case name from conversation content — `src/commands/rename/generateSessionName.ts:10-67`
2. Saves the custom title via `saveCustomTitle()` — `src/commands/rename/rename.ts:57`
3. Syncs the title to the bridge session on claude.ai/code (best-effort, non-blocking) — `src/commands/rename/rename.ts:62-73`
4. Also persists as the session's agent name for prompt-bar display — `src/commands/rename/rename.ts:76-83`
5. Teammates in swarm mode cannot rename themselves — `src/commands/rename/rename.ts:27-33`

### Memory Edit Flow (`/memory`)

The `/memory` command opens a memory file selector dialog, then launches the user's editor.

1. Clears and re-primes the memory file cache to avoid stale data — `src/commands/memory/memory.tsx:86-87`
2. Renders a `MemoryFileSelector` inside a `Dialog` component — `src/commands/memory/memory.tsx:69-81`
3. On selection: creates the claude config directory if needed, creates the file with `wx` flag (no-op if exists), then opens in `$VISUAL` / `$EDITOR` / system default — `src/commands/memory/memory.tsx:21-58`

### Context Visualization (`/context`)

Two variants depending on session type:

- **Interactive** (`local-jsx`): renders a colored grid visualizing context usage — `src/commands/context/context.tsx`
- **Non-interactive** (`local`): outputs a detailed markdown table with token breakdowns by category (messages, MCP tools, agents, memory files, skills), context-collapse status, and model info — `src/commands/context/context-noninteractive.ts:79-88`

Both share `collectContextData()` which mirrors the query engine's pre-API transforms (compact boundary, projectView, microcompact) so token counts reflect what the model actually sees — `src/commands/context/context-noninteractive.ts:34-77`

## Function Signatures

### `clearConversation(context): Promise<void>`

Performs a full session reset — clears messages, caches, tasks, and regenerates the session ID.

| Parameter | Type | Description |
|-----------|------|-------------|
| `setMessages` | `(updater: (prev: Message[]) => Message[]) => void` | Message state setter |
| `readFileState` | `FileStateCache` | File state cache to clear |
| `discoveredSkillNames` | `Set<string>` (optional) | Skill names set to clear |
| `loadedNestedMemoryPaths` | `Set<string>` (optional) | Nested memory paths to clear |
| `getAppState` / `setAppState` | `() => AppState` / `(f) => void` (optional) | App state accessors for task cleanup |
| `setConversationId` | `(id: UUID) => void` (optional) | Forces logo re-render |

> Source: `src/commands/clear/conversation.ts:49-65`

### `clearSessionCaches(preservedAgentIds?): void`

Clears all session-related caches without affecting messages or session ID. Called during both `/clear` and `--resume`.

- **preservedAgentIds**: `ReadonlySet<string>` — agent IDs whose per-agent state should survive (for background tasks)
- When `preservedAgentIds` is non-empty, request-ID-keyed state (pending permission callbacks, dump state, cache-break tracking) is left intact

> Source: `src/commands/clear/caches.ts:47-49`

### `compact.call(args, context): Promise<CompactResult>`

Compacts conversation history with optional custom summarization instructions.

- **args**: `string` — optional custom instructions for the summarization model
- **Returns**: `{ type: 'compact', compactionResult: CompactionResult, displayText: string }`

> Source: `src/commands/compact/compact.ts:40`

### `generateSessionName(messages, signal): Promise<string | null>`

Uses Haiku to generate a 2-4 word kebab-case session name from conversation content.

- **messages**: `Message[]` — conversation messages to summarize
- **signal**: `AbortSignal` — for cancellation
- Returns `null` if no conversation text or Haiku fails

> Source: `src/commands/rename/generateSessionName.ts:10-67`

### `createFork(customTitle?): Promise<ForkResult>`

Creates a fork of the current conversation transcript.

- **Returns**: `{ sessionId, title, forkPath, serializedMessages, contentReplacementRecords }`

> Source: `src/commands/branch/branch.ts:61-173`

### `validateDirectoryForWorkspace(directoryPath, permissionContext): Promise<AddDirectoryResult>`

Validates a directory path for addition as a working directory. Checks existence, directory type, and overlap with existing working directories.

- **Returns**: Discriminated union with `resultType`: `'success'`, `'emptyPath'`, `'pathNotFound'`, `'notADirectory'`, `'alreadyInWorkingDirectory'`

> Source: `src/commands/add-dir/validation.ts:31-93`

### `collectContextData(context): Promise<ContextData>`

Shared data-collection path for `/context` command and SDK `get_context_usage` requests. Mirrors the query engine's pre-API transforms.

> Source: `src/commands/context/context-noninteractive.ts:34-77`

### `collectRecentAssistantTexts(messages): string[]`

Walks messages newest-first, returning text from assistant messages that actually said something (skips tool-use-only turns and API errors). Used by `/copy` to offer selection of recent responses.

- **Returns**: Array where index 0 = latest response, capped at `MAX_LOOKBACK` (20)

> Source: `src/commands/copy/copy.tsx:50-61`

## Interface/Type Definitions

### `AddDirectoryResult`

Discriminated union returned by `validateDirectoryForWorkspace`:

```typescript
type AddDirectoryResult =
  | { resultType: 'success'; absolutePath: string }
  | { resultType: 'emptyPath' }
  | { resultType: 'pathNotFound' | 'notADirectory'; directoryPath: string; absolutePath: string }
  | { resultType: 'alreadyInWorkingDirectory'; directoryPath: string; workingDir: string }
```

> Source: `src/commands/add-dir/validation.ts:12-29`

### Command Metadata Pattern

All commands follow the `Command` interface with lazy-loaded implementations:

```typescript
{
  type: 'local' | 'local-jsx',  // local = returns text, local-jsx = returns React nodes
  name: string,
  description: string,
  aliases?: string[],
  isEnabled?: () => boolean,
  isHidden?: boolean,
  immediate?: boolean,           // executes without waiting for user prompt
  argumentHint?: string,
  supportsNonInteractive?: boolean,
  load: () => Promise<{ call: ... }>
}
```

## Configuration & Defaults

| Command | Environment / Feature Gate | Default |
|---------|---------------------------|---------|
| `/compact` | `DISABLE_COMPACT` env var | Enabled |
| `/files` | `USER_TYPE === 'ant'` | Hidden for external users |
| `/session` | Remote mode (`getIsRemoteMode()`) | Hidden outside remote mode |
| `/think-back` | `tengu_thinkback` statsig gate | Feature-gated |
| `/thinkback-play` | `tengu_thinkback` statsig gate | Hidden, feature-gated |
| `/clear` session-end hook timeout | `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | 1.5 seconds |
| `/branch` fork alias | `FORK_SUBAGENT` feature flag | `/fork` alias when flag is off |

### Stub Commands

Three commands are stubbed out (disabled and hidden), reserved for future implementation:
- `/share` — `src/commands/share/index.js`
- `/teleport` — `src/commands/teleport/index.js`
- `/summary` — `src/commands/summary/index.js`

## Edge Cases & Caveats

- **Background task preservation during `/clear`**: Tasks with `isBackgrounded !== false` survive a clear. Their `TaskOutput` symlinks are re-pointed to the new session directory so reads resolve to the live transcript rather than a frozen pre-clear snapshot. Only running tasks are re-pointed — finished tasks would get dangling symlinks. (`src/commands/clear/conversation.ts:87-224`)

- **`/compact` three-tier strategy**: Compaction tries session memory compaction first (cheapest), then reactive compaction if in reactive-only mode, and finally falls back to traditional `compactConversation`. Session memory compaction doesn't support custom instructions.

- **`/branch` content-replacement records**: The fork copies content-replacement entries from the original session to avoid prompt cache misses. Without them, previously-replaced tool results would be classified as `FROZEN` and sent as full content, causing permanent overage. (`src/commands/branch/branch.ts:98-111`)

- **`/rename` teammate restriction**: Swarm teammates cannot rename themselves — their names are set by the team leader. (`src/commands/rename/rename.ts:27-33`)

- **`/resume` cross-project detection**: When resuming a session from a different project directory, the command copies the CLI resume command to clipboard rather than resuming in-place, preventing working directory mismatches.

- **`/exit` in background sessions**: When running inside a `claude --bg` tmux session, `/exit` detaches the tmux client instead of killing the process, allowing `claude attach` to reconnect later. (`src/commands/exit/exit.tsx:18-24`)

- **`/exit` with worktrees**: If the session is inside a git worktree, an `ExitFlow` component is shown (to handle worktree cleanup) instead of immediately exiting. (`src/commands/exit/exit.tsx:25-28`)

- **`/memory` editor selection**: Uses `$VISUAL` first, then `$EDITOR`, falling back to the system default. Creates the memory file if it doesn't exist (using `wx` flag to avoid overwriting). (`src/commands/memory/memory.tsx:42-55`)

- **`/rewind` is UI-only**: The command simply opens the message selector UI via `context.openMessageSelector()` and returns `{ type: 'skip' }` without appending any messages. The actual rewind logic lives in the message selector component. (`src/commands/rewind/rewind.ts:4-13`)

- **`/copy` fallback behavior**: In addition to writing to the system clipboard via OSC 52, `/copy` always writes the content to a temp file at `$TMPDIR/claude/response.md` as a reliable fallback when terminal clipboard support is unavailable. (`src/commands/copy/copy.tsx:81-94`)

## Key Code Snippets

### Cache clearing scope (25+ caches)

The `clearSessionCaches` function demonstrates the breadth of state that accumulates during a session:

```typescript
// src/commands/clear/caches.ts:47-144
export function clearSessionCaches(
  preservedAgentIds: ReadonlySet<string> = new Set(),
): void {
  const hasPreserved = preservedAgentIds.size > 0
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  getGitStatus.cache.clear?.()
  // ... 20+ more cache clears including:
  // file suggestions, commands, prompt cache break detection,
  // system prompt injection, skills, image paths, session ingress,
  // repository detection, bash command prefixes, LSP diagnostics,
  // magic docs, web fetch cache, tool search cache, agent definitions
}
```

### Compact strategy selection

```typescript
// src/commands/compact/compact.ts:54-108
// 1. Try session memory compaction (cheapest, no custom instructions)
if (!customInstructions) {
  const sessionMemoryResult = await trySessionMemoryCompaction(messages, context.agentId)
  if (sessionMemoryResult) { /* return early */ }
}
// 2. Try reactive compaction
if (reactiveCompact?.isReactiveOnlyMode()) {
  return await compactViaReactive(messages, context, customInstructions, reactiveCompact)
}
// 3. Fall back to traditional: microcompact then full compaction
const microcompactResult = await microcompactMessages(messages, context)
const result = await compactConversation(messagesForCompact, context, ...)
```

### Fork name collision handling

```typescript
// src/commands/branch/branch.ts:179-220
async function getUniqueForkName(baseName: string): Promise<string> {
  const candidateName = `${baseName} (Branch)`
  const existingWithExactName = await searchSessionsByCustomTitle(
    candidateName, { exact: true },
  )
  if (existingWithExactName.length === 0) return candidateName
  // Find next available number: (Branch 2), (Branch 3), ...
  let nextNumber = 2
  while (usedNumbers.has(nextNumber)) nextNumber++
  return `${baseName} (Branch ${nextNumber})`
}
```