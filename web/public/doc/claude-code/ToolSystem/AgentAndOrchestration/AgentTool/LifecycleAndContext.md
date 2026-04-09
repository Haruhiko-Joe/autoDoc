# Lifecycle and Context

## Overview & Responsibilities

This module comprises five files within the `AgentTool` subsystem that handle specialized agent lifecycle flows and context injection. Sitting under **ToolSystem → AgentAndOrchestration → AgentTool**, these files collectively manage:

- **Forking** child agents that inherit a parent's full conversation context
- **Resuming** previously-running agents from persisted transcripts
- **Constructing** the Agent tool's system prompt describing available agent types
- **Managing** per-agent persistent memory directories across user/project/local scopes
- **Snapshotting** agent memory for initialization and synchronization

Together, they enable the Agent tool to spawn context-aware subagents, resume interrupted work, and maintain long-term memory — the glue between the one-shot `runAgent` execution and the richer lifecycle requirements of production agent orchestration.

---

## Key Processes

### Fork-Subagent Flow (`forkSubagent.ts`)

The fork path creates a child agent that inherits the parent's **entire conversation history and system prompt**, unlike regular subagents that start from scratch.

1. **Gate check**: `isForkSubagentEnabled()` checks the `FORK_SUBAGENT` feature flag, then rejects coordinator mode and non-interactive sessions (`src/tools/AgentTool/forkSubagent.ts:32-39`)
2. **Recursion guard**: `isInForkChild()` scans messages for the `<fork-boilerplate>` XML tag to prevent fork children from forking again (`src/tools/AgentTool/forkSubagent.ts:78-89`)
3. **Message construction**: `buildForkedMessages()` builds cache-friendly conversation messages:
   - Clones the parent's assistant message (all tool_use, thinking, and text blocks)
   - Creates placeholder `tool_result` blocks with identical text (`"Fork started — processing in background"`) for every `tool_use` block
   - Appends a per-child directive text block — only this final block differs across siblings, maximizing prompt cache hits (`src/tools/AgentTool/forkSubagent.ts:107-168`)
4. **Child directive**: `buildChildMessage()` wraps the directive in a `<fork-boilerplate>` tag with strict behavioral rules (no sub-spawning, no conversing, structured output format) (`src/tools/AgentTool/forkSubagent.ts:171-198`)
5. **Worktree notice**: `buildWorktreeNotice()` injects path-translation guidance when the fork runs in an isolated git worktree (`src/tools/AgentTool/forkSubagent.ts:205-210`)

The `FORK_AGENT` definition uses `tools: ['*']` with `model: 'inherit'` and `permissionMode: 'bubble'` — the child gets the parent's exact tool pool and model for cache-identical API prefixes.

### Agent Resume Flow (`resumeAgent.ts`)

Resuming an agent restores its full execution state from session storage and re-enters the query loop.

1. **Load state**: Reads the agent's transcript and metadata in parallel via `getAgentTranscript()` and `readAgentMetadata()` (`src/tools/AgentTool/resumeAgent.ts:63-66`)
2. **Message sanitization**: Applies three filters sequentially to produce clean messages:
   - `filterUnresolvedToolUses()` — removes tool_use blocks without matching results
   - `filterOrphanedThinkingOnlyMessages()` — removes assistant messages that contain only thinking
   - `filterWhitespaceOnlyAssistantMessages()` — removes empty assistant messages (`src/tools/AgentTool/resumeAgent.ts:70-74`)
3. **Tool result reconstruction**: `reconstructForSubagentResume()` rebuilds the content replacement state from persisted replacements (`src/tools/AgentTool/resumeAgent.ts:75-79`)
4. **Worktree recovery**: Validates the original worktree path still exists; falls back to parent cwd if removed. Bumps `mtime` on valid worktrees to prevent stale-worktree cleanup from deleting them (`src/tools/AgentTool/resumeAgent.ts:82-97`)
5. **Agent type resolution**: Determines which agent definition to use — `FORK_AGENT` for fork resumes, the original agent type from metadata, or `GENERAL_PURPOSE_AGENT` as fallback (`src/tools/AgentTool/resumeAgent.ts:100-112`)
6. **System prompt reconstruction**: For fork resumes, threads the parent's rendered system prompt (byte-exact for cache sharing) or reconstructs it from scratch if `renderedSystemPrompt` is unavailable (`src/tools/AgentTool/resumeAgent.ts:116-148`)
7. **Task registration and execution**: Registers the agent as an async background task, then launches `runAsyncAgentLifecycle` within an agent context and optional cwd override (`src/tools/AgentTool/resumeAgent.ts:198-258`)

### Prompt Construction (`prompt.ts`)

Builds the Agent tool's description string that tells Claude how and when to use the tool.

1. **Agent list formatting**: `formatAgentLine()` renders each agent as `- type: whenToUse (Tools: ...)`, using `getToolsDescription()` to resolve allow/deny list interactions (`src/tools/AgentTool/prompt.ts:15-46`)
2. **Attachment vs. inline decision**: `shouldInjectAgentListInMessages()` determines whether to embed the agent list in the tool description or move it to an attachment message — the inline list was ~10.2% of fleet cache_creation tokens because MCP/plugin changes bust the cache (`src/tools/AgentTool/prompt.ts:59-64`)
3. **Fork-aware sections**: When fork is enabled, injects a "When to fork" section with fork-specific guidance (research vs. implementation, cache sharing, don't-peek/don't-race rules) and replaces examples with fork-oriented ones (`src/tools/AgentTool/prompt.ts:80-154`)
4. **Coordinator trim**: Coordinator mode gets only the shared core prompt — the coordinator's own system prompt already covers usage notes (`src/tools/AgentTool/prompt.ts:216-218`)
5. **Full prompt assembly**: Non-coordinator mode assembles: core description → when-not-to-use → usage notes (concurrency, background, worktree) → when-to-fork → writing-the-prompt → examples (`src/tools/AgentTool/prompt.ts:252-287`)

### Agent Memory Management (`agentMemory.ts`)

Provides a three-scope persistent memory system for agents.

**Scopes**:
| Scope | Path | Purpose |
|-------|------|---------|
| `user` | `~/.claude/agent-memory/<agentType>/` | General learnings across all projects |
| `project` | `<cwd>/.claude/agent-memory/<agentType>/` | Project-specific, VCS-tracked |
| `local` | `<cwd>/.claude/agent-memory-local/<agentType>/` | Machine-specific, not VCS-tracked |

- `getAgentMemoryDir()` resolves the directory for a given scope, with remote override support via `CLAUDE_CODE_REMOTE_MEMORY_DIR` for the local scope (`src/tools/AgentTool/agentMemory.ts:52-65`)
- `isAgentMemoryPath()` validates whether an absolute path falls within any agent memory directory, with path normalization to prevent traversal attacks (`src/tools/AgentTool/agentMemory.ts:68-104`)
- `loadAgentMemoryPrompt()` creates the memory directory (fire-and-forget, since the agent won't write until after an API round-trip) and builds the prompt via `buildMemoryPrompt()` with scope-specific guidelines (`src/tools/AgentTool/agentMemory.ts:138-177`)
- Agent types containing colons (e.g., `my-plugin:my-agent`) are sanitized to dashes for filesystem safety (`src/tools/AgentTool/agentMemory.ts:20-22`)

### Agent Memory Snapshots (`agentMemorySnapshot.ts`)

Manages snapshot-based memory initialization and synchronization between a project-level snapshot and the agent's working memory.

**Storage layout**: `<cwd>/.claude/agent-memory-snapshots/<agentType>/snapshot.json` holds the snapshot timestamp; memory files (`.md`) sit alongside it. Each agent memory directory gets a `.snapshot-synced.json` tracking the last synced timestamp.

**Three sync actions** determined by `checkAgentMemorySnapshot()` (`src/tools/AgentTool/agentMemorySnapshot.ts:98-144`):
| Action | Condition | Meaning |
|--------|-----------|---------|
| `none` | No snapshot exists, or snapshot is already synced | Nothing to do |
| `initialize` | Snapshot exists but no local `.md` files | First-time setup — copy snapshot to local |
| `prompt-update` | Snapshot is newer than last sync | Prompt the agent about the update |

- `initializeFromSnapshot()` copies all non-JSON files from the snapshot directory to local memory and records the sync timestamp (`src/tools/AgentTool/agentMemorySnapshot.ts:149-159`)
- `replaceFromSnapshot()` deletes existing `.md` files first to avoid orphans, then copies and records (`src/tools/AgentTool/agentMemorySnapshot.ts:164-186`)
- `markSnapshotSynced()` records the sync timestamp without modifying memory files (`src/tools/AgentTool/agentMemorySnapshot.ts:191-197`)

---

## Function Signatures

### `forkSubagent.ts`

#### `isForkSubagentEnabled(): boolean`
Returns `true` when the `FORK_SUBAGENT` feature flag is active, the session is interactive, and coordinator mode is off.

#### `isInForkChild(messages: MessageType[]): boolean`
Scans conversation messages for the fork boilerplate tag to detect whether the current context is already inside a forked child.

#### `buildForkedMessages(directive: string, assistantMessage: AssistantMessage): MessageType[]`
Constructs the forked conversation suffix — a cloned assistant message and a user message with placeholder tool results plus the directive. Returns an array of messages to append after the parent's history.

#### `buildChildMessage(directive: string): string`
Wraps a directive string in the fork boilerplate tag with strict behavioral rules for the child agent.

#### `buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string`
Generates a notice explaining the worktree isolation to the child agent.

### `resumeAgent.ts`

#### `resumeAgentBackground(params): Promise<ResumeAgentResult>`
Resumes a previously-running agent by its ID. Reads its transcript and metadata, sanitizes messages, resolves the agent definition, and launches the agent as an async background task. Returns `{ agentId, description, outputFile }`.

**Parameters**:
- `agentId: string` — The agent to resume
- `prompt: string` — New message to send to the resumed agent
- `toolUseContext: ToolUseContext` — Current tool execution context
- `canUseTool: CanUseToolFn` — Permission check function
- `invokingRequestId?: string` — Optional request ID for tracing

### `prompt.ts`

#### `getPrompt(agentDefinitions: AgentDefinition[], isCoordinator?: boolean, allowedAgentTypes?: string[]): Promise<string>`
Builds the Agent tool's full description prompt. Coordinator mode gets a slim version; non-coordinator gets the complete prompt with usage notes, examples, and when-to-fork sections.

#### `formatAgentLine(agent: AgentDefinition): string`
Formats a single agent definition into a display line: `- type: whenToUse (Tools: ...)`.

#### `shouldInjectAgentListInMessages(): boolean`
Returns whether the agent list should be injected as an attachment message (for prompt cache stability) or embedded inline in the tool description.

### `agentMemory.ts`

#### `getAgentMemoryDir(agentType: string, scope: AgentMemoryScope): string`
Returns the filesystem path for an agent's memory directory at the given scope.

#### `isAgentMemoryPath(absolutePath: string): boolean`
Security check — returns whether a path falls within any agent memory directory (user, project, or local scope).

#### `loadAgentMemoryPrompt(agentType: string, scope: AgentMemoryScope): string`
Ensures the memory directory exists and returns a formatted prompt containing the agent's persistent memories with scope-specific guidelines.

### `agentMemorySnapshot.ts`

#### `checkAgentMemorySnapshot(agentType: string, scope: AgentMemoryScope): Promise<{action, snapshotTimestamp?}>`
Compares the project snapshot timestamp against the local sync marker. Returns `'none'`, `'initialize'`, or `'prompt-update'` with the snapshot timestamp.

#### `initializeFromSnapshot(agentType: string, scope: AgentMemoryScope, snapshotTimestamp: string): Promise<void>`
First-time initialization: copies snapshot files to local memory and records sync metadata.

#### `replaceFromSnapshot(agentType: string, scope: AgentMemoryScope, snapshotTimestamp: string): Promise<void>`
Replaces local memory files with the snapshot, removing existing `.md` files first.

#### `markSnapshotSynced(agentType: string, scope: AgentMemoryScope, snapshotTimestamp: string): Promise<void>`
Records the snapshot as synced without modifying local memory files.

---

## Type Definitions

### `AgentMemoryScope` (`src/tools/AgentTool/agentMemory.ts:13`)
```typescript
type AgentMemoryScope = 'user' | 'project' | 'local'
```
Determines which directory scope agent memory is stored in.

### `ResumeAgentResult` (`src/tools/AgentTool/resumeAgent.ts:37-41`)
```typescript
type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
}
```
Return type from `resumeAgentBackground`, providing the agent's ID, UI description, and path to its output file.

### `FORK_AGENT` (`src/tools/AgentTool/forkSubagent.ts:60-71`)
Synthetic `BuiltInAgentDefinition` for fork-mode agents. Key fields:
- `tools: ['*']` — inherits the parent's exact tool pool
- `model: 'inherit'` — uses the parent's model for cache parity
- `permissionMode: 'bubble'` — surfaces permission prompts to the parent terminal

---

## Configuration & Defaults

| Configuration | Source | Default | Description |
|---------------|--------|---------|-------------|
| `FORK_SUBAGENT` | Feature flag (`bun:bundle`) | `false` | Enables fork-subagent mode |
| `tengu_agent_list_attach` | GrowthBook feature flag | `false` | Moves agent list to attachment for cache stability |
| `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES` | Environment variable | Defers to feature flag | Override for agent list attachment behavior (`true`/`false`) |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | Environment variable | unset | Redirects local-scope agent memory to a remote mount |
| `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` | Environment variable | unset | Appends extra guidelines to agent memory prompts |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Environment variable | unset | When truthy, omits background-agent usage notes from prompt |

---

## Edge Cases & Caveats

- **No recursive forking**: Fork children retain the Agent tool in their pool for cache-identical tool definitions, but `isInForkChild()` blocks any attempt to fork from within a fork child.
- **Prompt cache strategy**: `buildForkedMessages()` uses identical placeholder text for all tool results so only the final directive block differs per child — this is critical for cache hit rates across parallel forks.
- **Worktree staleness**: When resuming an agent, if the original worktree was deleted externally, the code falls back to the parent's cwd rather than crashing. Valid worktrees get their `mtime` bumped to prevent cleanup.
- **Fire-and-forget mkdir**: `loadAgentMemoryPrompt()` creates the memory directory asynchronously without awaiting — this is safe because the agent won't attempt to write until after a full API round-trip.
- **System prompt divergence**: Fork resumes thread the parent's byte-exact rendered system prompt rather than reconstructing it, because GrowthBook cold-to-warm transitions can cause divergence that busts the prompt cache.
- **Coordinator mode slim prompt**: The coordinator gets a minimal Agent tool description because its own system prompt already covers orchestration guidance — duplicate instructions would waste tokens.
- **Path traversal protection**: `isAgentMemoryPath()` normalizes paths before checking to prevent `..` segment bypasses.
- **Snapshot orphan cleanup**: `replaceFromSnapshot()` deletes all existing `.md` files before copying to prevent stale memories from persisting after a snapshot update.