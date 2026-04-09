# SessionRestore

## Overview & Responsibilities

SessionRestore is the orchestration layer for resuming prior Claude Code conversations. It lives within the **Infrastructure > CoreUtilities > SessionManagement** hierarchy and coordinates the full restore pipeline when a user resumes a session via `--resume`, `--continue`, or the interactive `/resume` slash command.

When a conversation is resumed, substantial hidden state must be reconstructed: file edit history, commit attribution tracking, context-collapse snapshots, todo lists, agent definitions, worktree working directories, and coordinator mode settings. This module owns that reconstruction, exposing focused functions that both the CLI startup path (`main.tsx`) and the interactive REPL path (`REPL.tsx`) call into.

## Key Processes

### Main Resume Pipeline (`processResumedConversation`)

This is the primary entry point, called by both `--continue` and `--resume` paths in `main.tsx`. It coordinates the full resume sequence:

1. **Mode matching** — If coordinator mode is enabled, matches the current mode to the resumed session's mode. Pushes a warning system message if they differ (`src/utils/sessionRestore.ts:427-433`).

2. **Session ID setup** — Unless `--fork-session` is specified, switches the global session ID to the resumed session's ID, repoints the asciicast recording, resets the session file pointer, and restores cost tracking state (`src/utils/sessionRestore.ts:436-451`). For fork mode, it seeds content-replacement records into the new session to avoid cache misses (`src/utils/sessionRestore.ts:452-463`).

3. **Metadata restoration** — Calls `restoreSessionMetadata()` so `/status` shows the saved session name and metadata is re-appended on exit. Forks strip worktree state to prevent cross-session worktree deletion (`src/utils/sessionRestore.ts:470-472`).

4. **Worktree restoration** — For non-fork resumes, `cd`s back into the worktree the session occupied when it last exited, then adopts the resumed transcript file (`src/utils/sessionRestore.ts:474-488`).

5. **Context-collapse restoration** — Restores the commit log and staged snapshot so `projectView()` can rebuild the collapsed view (`src/utils/sessionRestore.ts:494-503`).

6. **Agent restoration** — Re-applies the agent type and model override from the resumed session via `restoreAgentFromSession()` (`src/utils/sessionRestore.ts:506-511`).

7. **Mode persistence** — Saves the current mode so future resumes know what mode this session was in (`src/utils/sessionRestore.ts:514-516`).

8. **Initial state computation** — Computes attribution state, standalone agent context, session name, and refreshed agent definitions, then assembles the `ProcessedResume` result with a merged `AppState` (`src/utils/sessionRestore.ts:519-551`).

### Log-Based State Restoration (`restoreSessionStateFromLog`)

Used by both SDK and interactive resume paths to restore incremental state from log snapshots:

1. **File history** — Replays `FileHistorySnapshot` entries via `fileHistoryRestoreStateFromLog()` into AppState (`src/utils/sessionRestore.ts:104-108`).
2. **Attribution** — If the `COMMIT_ATTRIBUTION` feature is enabled, replays attribution snapshots (`src/utils/sessionRestore.ts:111-119`).
3. **Context collapse** — Unconditionally restores commit entries and snapshot via a lazy `require()` of the context-collapse persistence module. Called unconditionally so that resuming into a session with no commits correctly resets stale state (`src/utils/sessionRestore.ts:127-136`).
4. **Todos** — When TodoV2 (file-backed) is not enabled, scans the transcript backwards for the last `TodoWrite` tool-use block and hydrates `AppState.todos` (`src/utils/sessionRestore.ts:140-149`).

### Worktree Restore & Exit

**`restoreWorktreeForResume`** (`src/utils/sessionRestore.ts:332-366`):
- If a fresh worktree was created by `--worktree`, it takes precedence — the function saves that fresh state and returns immediately.
- Otherwise, if the transcript recorded an active worktree, it attempts `process.chdir()` into it. This doubles as a TOCTOU-safe existence check — if the directory is gone (`ENOENT`), it records a null worktree state and falls back gracefully.
- On success, updates `cwd`, `originalCwd`, restores the worktree session object, and clears stale caches (memory files, system prompt sections, plans directory).

**`exitRestoredWorktree`** (`src/utils/sessionRestore.ts:380-400`):
- Cleans up worktree state when a mid-session `/resume` switches to a different session. Without this, the user would be left in the old worktree directory with stale `currentWorktreeSession` state.
- Restores `null` worktree state, clears caches, then `chdir`s back to the original working directory.

### Todo Extraction from Transcript

**`extractTodosFromTranscript`** (`src/utils/sessionRestore.ts:77-93`):
- Scans assistant messages in reverse order looking for the last `TodoWrite` tool-use block.
- Parses the `todos` field from the tool input using `TodoListSchema` (Zod validation).
- Returns the parsed todo list, or an empty array if none found or parsing fails.
- Only used for SDK/non-interactive resume where file-backed v2 tasks are unavailable.

## Function Signatures

### `processResumedConversation(result, opts, context): Promise<ProcessedResume>`

The main orchestrator. Coordinates the full resume pipeline.

| Parameter | Type | Description |
|-----------|------|-------------|
| `result` | `ResumeLoadResult` | Loaded conversation data including messages, snapshots, session metadata, and worktree state |
| `opts.forkSession` | `boolean` | Whether to create a new session ID (fork) or reuse the original |
| `opts.sessionIdOverride` | `string?` | Override the session ID from the loaded result |
| `opts.transcriptPath` | `string?` | Path to the transcript file (for cross-project resume) |
| `opts.includeAttribution` | `boolean?` | Whether to compute and include attribution state |
| `context.modeApi` | `CoordinatorModeApi \| null` | Coordinator mode API for mode matching |
| `context.mainThreadAgentDefinition` | `AgentDefinition?` | CLI-provided agent (takes precedence over resumed agent) |
| `context.agentDefinitions` | `AgentDefinitionsResult` | Currently loaded agent definitions |
| `context.currentCwd` | `string` | Current working directory |
| `context.cliAgents` | `AgentDefinition[]` | Agents provided via `--agents` CLI flag |
| `context.initialState` | `AppState` | Base AppState to merge restored state into |

**Returns**: `ProcessedResume` containing messages, agent metadata, and the computed initial `AppState`.

### `restoreSessionStateFromLog(result, setAppState): void`

Restores file history, attribution, context-collapse, and todo state into AppState via a setter callback.

### `computeRestoredAttributionState(result): AttributionState | undefined`

Pure computation of attribution state from snapshots. Returns `undefined` if the feature is disabled or no snapshots exist.

### `computeStandaloneAgentContext(agentName, agentColor): { name, color } | undefined`

Builds the `standaloneAgentContext` object from session-stored agent name/color. Normalizes `"default"` color to `undefined`.

### `restoreAgentFromSession(agentSetting, currentAgentDefinition, agentDefinitions): { agentDefinition, agentType }`

Re-applies the resumed session's agent type and model override. Precedence:
1. CLI `--agent` flag (kept as-is)
2. Resumed session's agent (looked up in active agents)
3. No agent (clears stale bootstrap state)

### `refreshAgentDefinitionsForModeSwitch(modeWasSwitched, currentCwd, cliAgents, currentAgentDefinitions): Promise<AgentDefinitionsResult>`

Re-derives agent definitions when coordinator/normal mode changed. Clears the definition cache, re-fetches, and merges CLI-provided agents back in.

### `restoreWorktreeForResume(worktreeSession): void`

Restores worktree working directory with stale-path fallback. See Worktree Restore section above.

### `exitRestoredWorktree(): void`

Undoes worktree restoration for mid-session `/resume` switches.

## Type Definitions

### `ResumeResult`

Internal type used by `restoreSessionStateFromLog`:

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `Message[]?` | Conversation transcript |
| `fileHistorySnapshots` | `FileHistorySnapshot[]?` | File edit history snapshots |
| `attributionSnapshots` | `AttributionSnapshotMessage[]?` | Commit attribution snapshots |
| `contextCollapseCommits` | `ContextCollapseCommitEntry[]?` | Context-collapse commit log |
| `contextCollapseSnapshot` | `ContextCollapseSnapshotEntry?` | Context-collapse staged snapshot |

### `ResumeLoadResult`

Extended type for the full loaded conversation, adds session metadata:

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `UUID?` | Original session ID |
| `agentName` / `agentColor` / `agentSetting` | `string?` | Agent display and configuration metadata |
| `customTitle` / `tag` | `string?` | Session title and tag |
| `mode` | `'coordinator' \| 'normal'?` | Session operating mode |
| `worktreeSession` | `PersistedWorktreeSession \| null?` | Worktree state at last exit |
| `prNumber` / `prUrl` / `prRepository` | PR metadata from the session |

### `ProcessedResume`

Return type of `processResumedConversation`:

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `Message[]` | Restored conversation messages |
| `fileHistorySnapshots` | `FileHistorySnapshot[]?` | For downstream file history replay |
| `contentReplacements` | `ContentReplacementRecord[]?` | Content replacement records for cache efficiency |
| `agentName` / `agentColor` | Agent display metadata |
| `restoredAgentDef` | `AgentDefinition?` | The restored agent definition, if any |
| `initialState` | `AppState` | Fully computed initial application state |

### `CoordinatorModeApi`

Minimal interface for coordinator mode interactions during resume:

| Method | Description |
|--------|-------------|
| `matchSessionMode(mode?)` | Returns a warning string if mode changed, undefined otherwise |
| `isCoordinatorMode()` | Whether the current session is in coordinator mode |

## Edge Cases & Caveats

- **Stale worktree paths**: If a worktree directory was deleted between sessions, `process.chdir()` throws `ENOENT`. The module catches this and records `null` worktree state rather than crashing (`src/utils/sessionRestore.ts:342-349`).

- **Fork mode and worktrees**: Forked sessions deliberately strip `worktreeSession` from metadata to prevent a "Remove" action on the fork's exit dialog from deleting a worktree the original session still references (`src/utils/sessionRestore.ts:470-472`).

- **Fork mode and content replacements**: When forking, content-replacement records must be seeded into the new session. Without this, tool_use IDs in messages would have no matching replacement records, causing them to be classified as `FROZEN` — which means full content is sent on every query (cache miss, permanent token overage) (`src/utils/sessionRestore.ts:452-463`).

- **Context-collapse unconditional reset**: `restoreFromEntries` is called even with empty/undefined entries because it resets the store first. Without this, an in-session `/resume` into a session with no commits would leave the prior session's stale commit log intact (`src/utils/sessionRestore.ts:127-136`).

- **Agent unavailability on resume**: If the resumed session's agent type is no longer available (e.g., agent definition was removed), the module logs a debug message and falls back to default behavior rather than failing (`src/utils/sessionRestore.ts:222-228`).

- **`projectRoot` intentionally not set on worktree restore**: The transcript doesn't record whether the worktree was entered via `--worktree` or `EnterWorktreeTool`. Leaving `projectRoot` stable matches `EnterWorktreeTool`'s behavior, keeping skills and history anchored to the original project (`src/utils/sessionRestore.ts:354-358`).

- **Mid-session `/resume` cache invalidation**: Both `restoreWorktreeForResume` and `exitRestoredWorktree` clear memory file caches, system prompt sections, and the plans directory cache, because these were populated against the old working directory.

- **TodoV2 vs TodoV1**: Todo extraction from transcripts only runs when file-backed v2 tasks are disabled (`!isTodoV2Enabled()`). Interactive mode uses v2 file-backed tasks, making `AppState.todos` unused there (`src/utils/sessionRestore.ts:140`).