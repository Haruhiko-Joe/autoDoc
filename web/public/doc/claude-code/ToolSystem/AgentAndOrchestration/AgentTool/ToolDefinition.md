# ToolDefinition (AgentTool)

## Overview & Responsibilities

The `ToolDefinition` module is the main Agent tool definition and orchestration glue for Claude Code's subagent system. It lives within the **ToolSystem → AgentAndOrchestration → AgentTool** hierarchy and is the entry point that the tool registry calls when Claude decides to spawn a subagent.

The module spans three files:

- **`AgentTool.tsx`** (~1,400 lines) — the `buildTool()` call that defines the `Agent` tool: its input/output schemas, permission checking, the primary `call()` handler that routes between five spawn paths (teammate, fork-subagent, remote teleport, async background, sync foreground), and result mapping back to the LLM.
- **`agentToolUtils.ts`** (~690 lines) — shared utilities: tool filtering for agents, agent tool resolution, the result schema, the async agent lifecycle runner, progress emission, handoff safety classification, partial result extraction, and analytics.
- **`constants.ts`** (12 lines) — tool name constants and the one-shot agent type set.

Sibling modules (`TaskTools`, `TeamAndMessaging`) depend on this module for subagent registration, and `SendMessageTool` imports from it to resume background agents.

## Key Processes

### 1. Input Schema Resolution

The tool exposes a dynamic input schema that adapts to feature flags at load time (`src/tools/AgentTool/AgentTool.tsx:82-125`):

1. A **base schema** defines `prompt`, `description`, `subagent_type`, `model`, and `run_in_background`.
2. A **full schema** extends this with multi-agent params (`name`, `team_name`, `mode`) and `isolation` (worktree or remote).
3. Feature gates strip fields: `KAIROS` controls `cwd`, background-task disabling removes `run_in_background`, and fork-subagent mode also hides `run_in_background`.

### 2. Agent Selection & Validation (call handler entry)

When `call()` is invoked (`src/tools/AgentTool/AgentTool.tsx:239-416`):

1. **Team spawn check** — If `team_name` + `name` are provided and agent swarms are enabled, route to `spawnTeammate()` and return a `teammate_spawned` result immediately.
2. **Effective type resolution** — If `subagent_type` is omitted, either route to the fork-subagent path (when enabled) or default to `general-purpose`.
3. **Agent lookup** — Find the `AgentDefinition` from active agents, respecting permission deny rules (`filterDeniedAgents`). Throws clear errors for denied or missing agent types.
4. **MCP server validation** — If the selected agent declares `requiredMcpServers`, poll up to 30 seconds for pending connections, then verify tools are available.
5. **Model resolution** — `getAgentModel()` merges definition default, parent model, and explicit override.

### 3. Remote Isolation Path

When `effectiveIsolation === 'remote'` (ant-internal only, `src/tools/AgentTool/AgentTool.tsx:435-482`):

1. Check remote eligibility via `checkRemoteAgentEligibility()`.
2. Call `teleportToRemote()` to create a CCR session.
3. Register as a `RemoteAgentTask` and return a `remote_launched` result.

### 4. System Prompt & Message Construction

Two divergent paths (`src/tools/AgentTool/AgentTool.tsx:492-541`):

- **Fork path**: Inherits the parent's system prompt verbatim for cache-identical API prefixes. Messages are built via `buildForkedMessages()` which clones the parent's full assistant message with placeholder tool results.
- **Normal path**: Calls `selectedAgent.getSystemPrompt()` and enhances with environment details. Creates a simple user message containing the prompt.

### 5. Async (Background) Agent Execution

When `shouldRunAsync` is true — triggered by `run_in_background`, agent definition `background: true`, coordinator mode, fork gate, assistant mode, or proactive mode (`src/tools/AgentTool/AgentTool.tsx:686-764`):

1. Register via `registerAsyncAgent()` with its own abort controller (survives parent ESC).
2. Optionally register `name → agentId` in `agentNameRegistry` for SendMessage routing.
3. Fire-and-forget `runAsyncAgentLifecycle()` wrapped in `runWithAgentContext()` and CWD override.
4. Return `async_launched` result immediately with the output file path.

`runAsyncAgentLifecycle()` (`src/tools/AgentTool/agentToolUtils.ts:508-686`) drives the background agent:

- Iterates the `runAgent` async generator, appending messages to state.
- Tracks progress via `ProgressTracker` and emits SDK task progress events.
- On completion: calls `finalizeAgentTool()`, runs handoff classification, cleans up worktree, and enqueues a notification.
- On abort: extracts partial results and notifies with `killed` status.
- On error: fails the task and notifies with error details.

### 6. Sync (Foreground) Agent Execution

The synchronous path (`src/tools/AgentTool/AgentTool.tsx:765-1262`) is more nuanced because it supports **mid-flight backgrounding**:

1. Register as a foreground task via `registerAgentForeground()`, which returns a `backgroundSignal` promise and optional auto-background timer.
2. Start the `runAgent` async iterator.
3. **Main loop**: Race each `iterator.next()` against the `backgroundSignal`.
   - If `backgroundSignal` wins (user pressed background or auto-background timer fired), transition to async: close the foreground iterator, spin up a new `runAgent` in background mode, and return `async_launched`.
   - If a message arrives, accumulate it, forward progress to the SDK, forward bash/powershell progress events to the parent, and emit UI progress.
4. After the loop: `finalizeAgentTool()` produces the result, optionally run handoff classification, return `completed` with content and worktree info.
5. **Cleanup** (finally block): clear background hint UI, stop summarization, unregister foreground task, clear skills/dump state, cancel auto-background timer, clean up worktree.

### 7. Worktree Lifecycle

When `isolation: 'worktree'` is specified (`src/tools/AgentTool/AgentTool.tsx:590-685`):

1. Create a worktree via `createAgentWorktree()` with a slug like `agent-<8chars>`.
2. All agent execution runs inside `runWithCwdOverride(worktreePath, ...)`.
3. On completion, `cleanupWorktreeIfNeeded()` checks `hasWorktreeChanges()` against the head commit:
   - No changes → remove worktree and clear metadata.
   - Changes detected → keep worktree and report `worktreePath`/`worktreeBranch` in the result.
   - Hook-based worktrees are always kept.

### 8. Result Mapping

`mapToolResultToToolResultBlockParam()` (`src/tools/AgentTool/AgentTool.tsx:1298-1379`) translates internal result types to tool_result content blocks:

| Status | Behavior |
|--------|----------|
| `teammate_spawned` | Short confirmation with agent_id and name |
| `remote_launched` | Task ID, session URL, output file path |
| `async_launched` | Agent ID (for SendMessage), output file path, progress instructions |
| `completed` | Agent's text content + usage trailer (agentId, tokens, tool uses, duration). One-shot built-ins (Explore, Plan) skip the trailer to save ~135 chars per invocation. |

## Function Signatures

### `AgentTool.call(input, toolUseContext, canUseTool, assistantMessage, onProgress?)`

Primary entry point. Routes to teammate spawn, fork subagent, remote teleport, async background, or sync foreground paths based on input parameters and feature flags.

- **input.prompt** (`string`): The task description for the subagent
- **input.subagent_type** (`string?`): Agent type identifier (e.g., `"Explore"`, `"Plan"`, `"general-purpose"`)
- **input.model** (`'sonnet' | 'opus' | 'haiku'?`): Model override
- **input.run_in_background** (`boolean?`): Force async execution
- **input.isolation** (`'worktree' | 'remote'?`): Isolation mode
- **input.name** (`string?`): Addressable name for SendMessage routing
- **input.team_name** (`string?`): Team context for multi-agent spawning
- **Returns**: `{ data: Output }` — either `completed` or `async_launched`

### `filterToolsForAgent({ tools, isBuiltIn, isAsync, permissionMode }): Tools`

> `src/tools/AgentTool/agentToolUtils.ts:70-116`

Filters the parent's tool pool for a subagent. MCP tools always pass. `ExitPlanMode` passes for plan-mode agents. Applies `ALL_AGENT_DISALLOWED_TOOLS`, `CUSTOM_AGENT_DISALLOWED_TOOLS` (for non-built-in), and `ASYNC_AGENT_ALLOWED_TOOLS` (for background agents). In-process teammates get special exceptions for `AgentTool` and task tools.

### `resolveAgentTools(agentDefinition, availableTools, isAsync?, isMainThread?): ResolvedAgentTools`

> `src/tools/AgentTool/agentToolUtils.ts:122-225`

Resolves an agent definition's declared tools against available tools. Handles wildcards (`['*']` or undefined = all tools), parses `Agent(type1, type2)` syntax for `allowedAgentTypes`, filters via `disallowedTools`, and reports invalid tool specs.

### `finalizeAgentTool(agentMessages, agentId, metadata): AgentToolResult`

> `src/tools/AgentTool/agentToolUtils.ts:276-357`

Extracts the final result from a completed agent's message history. Finds text content from the last assistant message (falls back to earlier messages if the last one is pure tool_use). Logs analytics and emits a cache eviction hint for the subagent's request chain.

### `runAsyncAgentLifecycle(params): Promise<void>`

> `src/tools/AgentTool/agentToolUtils.ts:508-686`

Drives a background agent from spawn to terminal notification. Handles the complete message iteration loop with progress tracking, summarization, completion (including handoff classification and worktree cleanup), abort handling (partial result extraction), and error handling.

### `classifyHandoffIfNeeded(params): Promise<string | null>`

> `src/tools/AgentTool/agentToolUtils.ts:389-481`

In auto permission mode with the transcript classifier feature enabled, reviews a subagent's work for security policy violations before handing results back to the parent. Returns a warning string if flagged, or `null` if safe.

### `extractPartialResult(messages): string | undefined`

> `src/tools/AgentTool/agentToolUtils.ts:488-500`

Scans agent messages backwards to find the last assistant message with text content. Used when an async agent is killed to preserve what it accomplished.

## Type Definitions

### `AgentToolResult` (`src/tools/AgentTool/agentToolUtils.ts:227-260`)

The structured result returned by `finalizeAgentTool`:

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `string` | Unique agent identifier |
| `agentType` | `string?` | Agent type (optional for resume compat) |
| `content` | `{type: 'text', text: string}[]` | Text content blocks from the agent |
| `totalToolUseCount` | `number` | Total tool_use blocks across all messages |
| `totalDurationMs` | `number` | Wall-clock duration |
| `totalTokens` | `number` | Token count from final usage |
| `usage` | `object` | Full usage breakdown (input/output/cache/server_tool_use/service_tier) |

### `ResolvedAgentTools` (`src/tools/AgentTool/agentToolUtils.ts:62-68`)

Result of tool resolution for an agent definition:

| Field | Type | Description |
|-------|------|-------------|
| `hasWildcard` | `boolean` | Whether the agent uses `*` (all tools) |
| `validTools` | `string[]` | Tool specs that resolved successfully |
| `invalidTools` | `string[]` | Tool specs with no matching tool |
| `resolvedTools` | `Tools` | The actual tool objects to provide |
| `allowedAgentTypes` | `string[]?` | Parsed from `Agent(type1,type2)` syntax |

### Output Union (`src/tools/AgentTool/AgentTool.tsx:141-191`)

The tool's output is a discriminated union on `status`:

- **`completed`**: `AgentToolResult` + `status: 'completed'` + `prompt` + optional `worktreePath`/`worktreeBranch`
- **`async_launched`**: `agentId`, `description`, `prompt`, `outputFile`, `canReadOutputFile`
- **`teammate_spawned`** (internal): Teammate spawn metadata
- **`remote_launched`** (internal): Remote CCR session info

## Configuration & Defaults

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `PROGRESS_THRESHOLD_MS` | Constant | `2000` | Delay before showing "background" hint UI |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Env var | `false` | Disables all background agent features |
| `CLAUDE_AUTO_BACKGROUND_TASKS` | Env var | `false` | Auto-background sync agents after 120s |
| `tengu_auto_background_agents` | GrowthBook | `false` | Feature gate for auto-backgrounding |
| `maxResultSizeChars` | Tool config | `100,000` | Maximum result size returned to parent |

## Constants (`src/tools/AgentTool/constants.ts`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `AGENT_TOOL_NAME` | `'Agent'` | Current tool name |
| `LEGACY_AGENT_TOOL_NAME` | `'Task'` | Backward-compat alias (permission rules, hooks, resumed sessions) |
| `VERIFICATION_AGENT_TYPE` | `'verification'` | Verification agent type identifier |
| `ONE_SHOT_BUILTIN_AGENT_TYPES` | `Set(['Explore', 'Plan'])` | Built-in agents that run once — skip the agentId/SendMessage/usage trailer to save ~135 chars per invocation |

## Edge Cases & Caveats

- **Fork recursion guard**: Fork children retain the Agent tool in their pool for cache-identical tool defs, but fork attempts are rejected at call time by checking `querySource` and scanning messages for fork markers (`src/tools/AgentTool/AgentTool.tsx:331-334`).
- **In-process teammate restrictions**: Cannot spawn background agents or nested teammates. The team roster is flat — validated at `src/tools/AgentTool/AgentTool.tsx:273-280`.
- **MCP server readiness**: If required MCP servers are still pending, the tool polls every 500ms up to 30 seconds. Exits early if any required server fails (`src/tools/AgentTool/AgentTool.tsx:375-410`).
- **Mid-flight backgrounding**: A foreground sync agent can be backgrounded at any time. The foreground iterator is closed (with 1s timeout to prevent MCP cleanup hangs), progress trackers are re-initialized from existing messages, and a fresh `runAgent` stream takes over (`src/tools/AgentTool/AgentTool.tsx:897-1037`).
- **Worktree cleanup idempotency**: `cleanupWorktreeIfNeeded` nulls `worktreeInfo` on first call to guard against double-cleanup if code between cleanup and end-of-try throws into catch (`src/tools/AgentTool/AgentTool.tsx:656-658`).
- **Task status transitions**: `completeAsyncAgent()` is called BEFORE handoff classification and worktree cleanup to ensure `TaskOutput(block=true)` unblocks immediately — the API call and git exec are embellishments that must not gate the status transition (per gh-20236).
- **One-shot trailer optimization**: Explore and Plan agents skip the ~135-char agentId/SendMessage/usage footer in their tool_result, saving significant tokens at scale (~34M Explore runs/week).
- **Handoff classifier unavailability**: When the safety classifier is unreachable, results pass through with a warning rather than blocking the subagent's work entirely (`src/tools/AgentTool/agentToolUtils.ts:464-469`).