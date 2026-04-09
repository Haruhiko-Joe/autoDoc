# ExecutionEngine (runAgent.ts)

## Overview & Responsibilities

The ExecutionEngine is the core agent execution loop that orchestrates a single subagent's entire query cycle. Located at `src/tools/AgentTool/runAgent.ts` (~970 lines), it sits within the **ToolSystem → AgentAndOrchestration → AgentTool** hierarchy and is called by the AgentTool when spawning any subagent — whether built-in types (Explore, Plan, general-purpose) or custom user-defined agents.

This module is responsible for:

- Assembling the agent's tool pool (filtering disallowed tools, merging MCP tools from required servers)
- Building the system prompt with environment details and agent-specific instructions
- Connecting to agent-declared MCP servers and managing their lifecycle
- Creating an isolated subagent context with its own file state cache, permission model, and abort controller
- Executing the query loop (calling the Claude API with message threading, streaming events, and abort signal handling)
- Recording the agent's transcript for resumability
- Cleaning up all resources (MCP connections, shell tasks, hooks, file state, todos, perfetto traces) when the agent completes or aborts

## Key Processes

### Agent Initialization Flow

When `runAgent()` is called, it performs a multi-step setup before entering the query loop:

1. **Resolve the agent model** via `getAgentModel()`, considering the agent definition's model preference, the parent's main loop model, and any explicit model override (`src/tools/AgentTool/runAgent.ts:340-345`)
2. **Generate a unique agent ID** or reuse one from `override.agentId` for resumed agents (`src/tools/AgentTool/runAgent.ts:347`)
3. **Prepare initial messages** — merge forked parent context (filtered for incomplete tool calls) with the agent's prompt messages (`src/tools/AgentTool/runAgent.ts:370-373`)
4. **Create or clone the file state cache** — forked agents clone the parent's cache; fresh agents get a new one (`src/tools/AgentTool/runAgent.ts:375-378`)
5. **Resolve user/system context** — optionally strips CLAUDE.md content for read-only agents (Explore, Plan) and removes stale gitStatus to save tokens (`src/tools/AgentTool/runAgent.ts:380-410`)
6. **Configure permission mode** — respects the agent definition's `permissionMode` unless the parent is in `bypassPermissions`, `acceptEdits`, or `auto` mode (`src/tools/AgentTool/runAgent.ts:415-498`)
7. **Resolve tools** — either uses pre-computed exact tools (for fork children) or filters through `resolveAgentTools()` (`src/tools/AgentTool/runAgent.ts:500-502`)
8. **Build the system prompt** via `getAgentSystemPrompt()`, enhanced with environment details (`src/tools/AgentTool/runAgent.ts:508-518`)
9. **Execute SubagentStart hooks** and collect additional context messages (`src/tools/AgentTool/runAgent.ts:531-555`)
10. **Register frontmatter hooks** scoped to the agent's lifecycle (`src/tools/AgentTool/runAgent.ts:564-575`)
11. **Preload skills** declared in the agent's frontmatter (`src/tools/AgentTool/runAgent.ts:578-646`)
12. **Initialize agent-specific MCP servers** (`src/tools/AgentTool/runAgent.ts:648-664`)
13. **Create the subagent context** via `createSubagentContext()` with all resolved configuration (`src/tools/AgentTool/runAgent.ts:700-714`)
14. **Record initial transcript** and agent metadata for resumability (`src/tools/AgentTool/runAgent.ts:735-742`)

### Query Loop Execution

The core execution is an async generator that yields messages from the `query()` function:

```typescript
// src/tools/AgentTool/runAgent.ts:748-806
for await (const message of query({
  messages: initialMessages,
  systemPrompt: agentSystemPrompt,
  userContext: resolvedUserContext,
  systemContext: resolvedSystemContext,
  canUseTool,
  toolUseContext: agentToolUseContext,
  querySource,
  maxTurns: maxTurns ?? agentDefinition.maxTurns,
})) {
  // Forward API metrics, handle attachments, record and yield messages
}
```

Within the loop, the engine:
- **Forwards API request metrics** (TTFT/OTPS) from subagent to parent display (`src/tools/AgentTool/runAgent.ts:761-768`)
- **Handles attachment messages** like `max_turns_reached` signals and structured output (`src/tools/AgentTool/runAgent.ts:771-790`)
- **Records each message** incrementally to the sidechain transcript for resume support (`src/tools/AgentTool/runAgent.ts:792-805`)
- **Fires the `onQueryProgress` callback** on every message for liveness detection during long streams (`src/tools/AgentTool/runAgent.ts:758`)

### MCP Server Initialization Flow

The `initializeAgentMcpServers()` function (`src/tools/AgentTool/runAgent.ts:95-218`) handles agent-declared MCP servers:

1. If no agent-specific servers are defined, returns the parent's clients unchanged
2. Respects `pluginOnly` policy — skips frontmatter MCP for user-controlled agents when MCP is locked to plugin-only
3. For each server spec:
   - **String specs** reference existing named MCP configs via `getMcpConfigByName()` (shared/memoized connections)
   - **Inline object specs** (`{ [name]: config }`) create new agent-scoped connections marked for cleanup
4. Connects to each server via `connectToServer()` and fetches available tools via `fetchToolsForClient()`
5. Returns merged clients (parent + agent-specific), discovered tools, and a cleanup function that only disposes newly created clients

### Cleanup Flow

The `finally` block (`src/tools/AgentTool/runAgent.ts:816-859`) ensures comprehensive resource cleanup regardless of how the agent terminates:

1. Clean up agent-specific MCP server connections
2. Clear session hooks registered by the agent
3. Clean up prompt cache tracking state
4. Release the cloned file state cache memory
5. Release forked context messages (set `length = 0`)
6. Unregister from Perfetto tracing
7. Clear transcript subdirectory mapping
8. Remove orphaned todo entries from AppState
9. Kill background shell tasks spawned by this agent
10. Kill monitor MCP tasks (feature-flagged)

## Function Signatures

### `runAgent(params): AsyncGenerator<Message, void>`

The main exported function — an async generator that yields `Message` objects as the agent processes its query.

| Parameter | Type | Description |
|-----------|------|-------------|
| `agentDefinition` | `AgentDefinition` | Agent type, model, permissions, hooks, skills, MCP servers |
| `promptMessages` | `Message[]` | The initial prompt messages for the agent |
| `toolUseContext` | `ToolUseContext` | Parent's runtime context (app state, abort controller, options) |
| `canUseTool` | `CanUseToolFn` | Permission check callback for tool execution |
| `isAsync` | `boolean` | Whether the agent runs asynchronously (background) |
| `canShowPermissionPrompts` | `boolean?` | Override for permission prompt visibility |
| `forkContextMessages` | `Message[]?` | Parent conversation messages to inherit (context forking) |
| `querySource` | `QuerySource` | Identifies the query origin for tracking |
| `override` | `object?` | Overrides for userContext, systemContext, systemPrompt, abortController, agentId |
| `model` | `ModelAlias?` | Explicit model selection override |
| `maxTurns` | `number?` | Maximum query loop iterations |
| `availableTools` | `Tools` | Pre-computed tool pool (avoids circular dependency) |
| `allowedTools` | `string[]?` | Scoped permission rules replacing parent's session rules |
| `useExactTools` | `boolean?` | When true, skip tool filtering (fork subagent path for cache hits) |
| `worktreePath` | `string?` | Git worktree path for isolated agents |
| `description` | `string?` | Task description persisted to metadata for resume notifications |
| `onCacheSafeParams` | `callback?` | Exposes constructed params for background summarization |
| `contentReplacementState` | `ContentReplacementState?` | Restored replacement state for resumed agents |
| `transcriptSubdir` | `string?` | Subdirectory for grouping transcripts (e.g., workflow runs) |
| `onQueryProgress` | `callback?` | Liveness callback fired on every query message |

### `initializeAgentMcpServers(agentDefinition, parentClients)`

Connects to MCP servers declared in the agent's frontmatter. Returns merged client list, discovered tools, and a cleanup function (`src/tools/AgentTool/runAgent.ts:95-218`).

### `filterIncompleteToolCalls(messages): Message[]`

Exported utility that removes assistant messages containing `tool_use` blocks that lack corresponding `tool_result` blocks. Prevents API validation errors when forking parent context into a subagent (`src/tools/AgentTool/runAgent.ts:866-904`).

### `getAgentSystemPrompt(agentDefinition, toolUseContext, model, dirs, tools): Promise<string[]>`

Builds the agent's system prompt by calling the agent definition's `getSystemPrompt()` method and enhancing it with environment details. Falls back to `DEFAULT_AGENT_PROMPT` on error (`src/tools/AgentTool/runAgent.ts:906-932`).

### `resolveSkillName(skillName, allSkills, agentDefinition): string | null`

Resolves a bare skill name from agent frontmatter to a registered command name using three strategies (`src/tools/AgentTool/runAgent.ts:945-973`):
1. **Exact match** via `hasCommand()` (checks name, userFacingName, aliases)
2. **Plugin prefix** — prepends the agent's plugin namespace (e.g., `"my-skill"` → `"my-plugin:my-skill"`)
3. **Suffix match** — finds any command ending with `":skillName"`

## Type Definitions

### `QueryMessage`

Union type for messages produced by the `query()` function (`src/tools/AgentTool/runAgent.ts:220-226`):

```typescript
type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage
```

### `isRecordableMessage(msg): msg is AssistantMessage | UserMessage | ProgressMessage | SystemCompactBoundaryMessage`

Type guard that identifies messages worth persisting to the sidechain transcript. Matches `assistant`, `user`, `progress`, and `system` (subtype `compact_boundary`) messages (`src/tools/AgentTool/runAgent.ts:231-246`).

## Configuration & Defaults

| Setting | Default | Description |
|---------|---------|-------------|
| `thinkingConfig` | `{ type: 'disabled' }` | Thinking is disabled for regular subagents to control output token costs. Fork children inherit the parent's config for cache hits. |
| `isNonInteractiveSession` | `true` for async agents | Async agents cannot prompt for user input |
| `shouldAvoidPermissionPrompts` | `true` for async agents | Async agents auto-deny permission prompts (unless `canShowPermissionPrompts` or bubble mode) |
| `awaitAutomatedChecksBeforeDialog` | `true` for async + promptable agents | Waits for classifier/hooks before interrupting the user |
| `tengu_slim_subagent_claudemd` | `true` (feature flag) | Strips CLAUDE.md from read-only agents (Explore/Plan) to save ~5-15 Gtok/week |
| `READ_FILE_STATE_CACHE_SIZE` | (from fileStateCache) | Size limit for the agent's file state cache |

## Edge Cases & Caveats

- **Permission mode inheritance**: The agent's `permissionMode` is only applied if the parent is *not* in `bypassPermissions`, `acceptEdits`, or `auto` mode — those privileged modes always take precedence (`src/tools/AgentTool/runAgent.ts:421-434`).
- **Tool permission scoping**: When `allowedTools` is provided, it replaces all session-level allow rules but preserves CLI-arg-level rules from `--allowedTools` (SDK consumer permissions). This prevents parent approval leakage (`src/tools/AgentTool/runAgent.ts:469-479`).
- **Abort controller isolation**: Async agents get their own `AbortController` (independent lifecycle), while sync agents share the parent's controller. Override takes precedence over both (`src/tools/AgentTool/runAgent.ts:524-528`).
- **Context forking safety**: `filterIncompleteToolCalls()` strips assistant messages with orphaned `tool_use` blocks before passing parent context to a subagent, preventing API validation errors (`src/tools/AgentTool/runAgent.ts:370-372`).
- **MCP cleanup semantics**: Only *newly created* (inline-defined) MCP clients are cleaned up when the agent exits. Named/referenced servers are shared memoized connections owned by the parent (`src/tools/AgentTool/runAgent.ts:197-210`).
- **Memory leak prevention**: The `finally` block aggressively releases resources — clears file state cache, zeros out the initial messages array, removes orphaned todo keys from AppState, and kills zombie background shell processes (`src/tools/AgentTool/runAgent.ts:816-859`).
- **Transcript recording**: Messages are recorded incrementally (O(1) per message) with parent-chain UUIDs for correct ordering. Recording failures are caught and logged but never block the agent (`src/tools/AgentTool/runAgent.ts:792-805`).
- **gitStatus omission**: Explore and Plan agents strip the (potentially 40KB) stale `gitStatus` from system context — they can run `git status` themselves for fresh data (`src/tools/AgentTool/runAgent.ts:400-410`).
- **Skill resolution for plugins**: Plugin agents reference skills with bare names, but the registry uses namespaced names. `resolveSkillName()` handles this mismatch with a three-strategy fallback (`src/tools/AgentTool/runAgent.ts:945-973`).