# AgentTypes — Built-in Agent Definitions & Custom Agent Loading

## Overview & Responsibilities

The AgentTypes module defines what kinds of agents Claude Code can spawn and how they are loaded. It sits within the **ToolSystem → AgentAndOrchestration → AgentTool** hierarchy, providing the agent registry that the core AgentTool consults when a user or the system requests a subagent.

The module has two major responsibilities:

1. **Built-in agent registry** (`builtInAgents.ts` + `built-in/` directory): Assembles the set of built-in agents available in the current session, gated by feature flags, environment variables, and entrypoint type (SDK vs. CLI).
2. **Custom agent loading** (`loadAgentsDir.ts`): Defines the `AgentDefinition` type system, parses agent definitions from Markdown frontmatter or JSON, loads custom agents from user/project/plugin directories, validates configurations, and filters agents by MCP server availability.

## Key Processes

### Built-in Agent Assembly Flow

The entry point is `getBuiltInAgents()` in `builtInAgents.ts:22-72`. It returns a filtered list of `AgentDefinition[]` based on runtime conditions:

1. **SDK blank-slate check** — If `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` is set and the session is non-interactive, returns an empty array (`builtInAgents.ts:25-30`)
2. **Coordinator mode override** — If the `COORDINATOR_MODE` feature flag is on and `CLAUDE_CODE_COORDINATOR_MODE` env var is truthy, delegates entirely to `getCoordinatorAgents()` from the coordinator subsystem (`builtInAgents.ts:35-43`)
3. **Base agents** — Always includes `general-purpose` and `statusline-setup` (`builtInAgents.ts:45-48`)
4. **Explore + Plan** — Added when `areExplorePlanAgentsEnabled()` returns true, controlled by the `BUILTIN_EXPLORE_PLAN_AGENTS` compile-time flag and the `tengu_amber_stoat` GrowthBook experiment (`builtInAgents.ts:13-20, 50-52`)
5. **Claude Code Guide** — Added for non-SDK entrypoints (not `sdk-ts`, `sdk-py`, or `sdk-cli`) (`builtInAgents.ts:55-62`)
6. **Verification** — Added when both the `VERIFICATION_AGENT` feature flag and the `tengu_hive_evidence` experiment are enabled (`builtInAgents.ts:64-69`)

### Full Agent Resolution Flow

The complete agent list (built-in + plugin + custom) is assembled by `getAgentDefinitionsWithOverrides()` in `loadAgentsDir.ts:296-393`. This memoized async function:

1. In **simple mode** (`CLAUDE_CODE_SIMPLE`), returns only built-in agents immediately (`loadAgentsDir.ts:299-305`)
2. Loads markdown files from the `agents` subdirectory across all settings sources via `loadMarkdownFilesForSubdir('agents', cwd)` (`loadAgentsDir.ts:308`)
3. Parses each markdown file through `parseAgentFromMarkdown()`, collecting failures for files that look like agent attempts (have a `name` field) (`loadAgentsDir.ts:311-342`)
4. Concurrently loads **plugin agents** (`loadPluginAgents()`) and initializes **agent memory snapshots** if the feature is enabled (`loadAgentsDir.ts:347-355`)
5. Combines all three sources: `[...builtInAgents, ...pluginAgents, ...customAgents]` (`loadAgentsDir.ts:359-363`)
6. Resolves overrides via `getActiveAgentsFromList()`, where later sources (user → project → flag → policy) override earlier ones sharing the same `agentType` key (`loadAgentsDir.ts:193-221`)
7. Initializes display colors for active agents (`loadAgentsDir.ts:368-372`)

### Custom Agent Parsing (Markdown)

`parseAgentFromMarkdown()` (`loadAgentsDir.ts:541-755`) extracts an `AgentDefinition` from a markdown file's YAML frontmatter and body content. It parses and validates:

- **Required fields**: `name` (becomes `agentType`), `description` (becomes `whenToUse`)
- **Tool configuration**: `tools` (allowed tool list), `disallowedTools` (blocked tools)
- **Model/effort**: `model` (string, supports `"inherit"`), `effort` (string level or integer)
- **Permission mode**: Must be one of `PERMISSION_MODES`
- **MCP servers**: Array of server name references or inline `{ name: config }` definitions, validated via Zod
- **Hooks**: Parsed through `HooksSchema` for session-scoped hook registration
- **Memory**: Scope enum (`user`, `project`, `local`) — when enabled, auto-injects `Write`/`Edit`/`Read` tools
- **Other**: `maxTurns`, `background`, `isolation` (`worktree` or `remote`), `color`, `skills`, `initialPrompt`

The markdown body (after frontmatter) becomes the agent's system prompt, optionally appended with memory context at call time via the `getSystemPrompt()` closure.

### Custom Agent Parsing (JSON)

`parseAgentFromJson()` (`loadAgentsDir.ts:445-516`) uses Zod schema validation (`AgentJsonSchema`) to parse agent definitions from JSON (used by flag-based settings). It supports the same fields as markdown parsing. `parseAgentsFromJson()` (`loadAgentsDir.ts:521-536`) handles batch parsing of multiple agents from a single JSON object.

### Agent Override Priority

`getActiveAgentsFromList()` (`loadAgentsDir.ts:193-221`) implements a priority-based override system. Agents are processed in order:

1. `built-in` (lowest priority)
2. `plugin`
3. `userSettings`
4. `projectSettings`
5. `flagSettings`
6. `policySettings` (highest priority — managed/enterprise settings)

When multiple agents share the same `agentType` name, later groups replace earlier ones, allowing users or organizations to override built-in agent behavior.

### MCP Server Requirement Filtering

`hasRequiredMcpServers()` (`loadAgentsDir.ts:229-242`) checks whether an agent's `requiredMcpServers` patterns all match at least one available MCP server (case-insensitive substring match). `filterAgentsByMcpRequirements()` (`loadAgentsDir.ts:250-255`) applies this filter across a list of agents, removing any whose MCP dependencies are unmet.

## Built-in Agent Catalog

### general-purpose (`built-in/generalPurposeAgent.ts`)

The default fallback agent for multi-step research and code tasks. Has access to all tools (`tools: ['*']`). Uses the default subagent model (no explicit model override). Prompt emphasizes broad search strategies and concise reporting.

### Explore (`built-in/exploreAgent.ts`)

A fast, **read-only** codebase exploration agent. Disallows `Agent`, `ExitPlanMode`, `Edit`, `Write`, and `NotebookEdit` tools. Uses `haiku` model for external users (speed-optimized) or `inherit` for internal users. Sets `omitClaudeMd: true` to save tokens since the main agent has full CLAUDE.md context. The prompt enforces strict read-only behavior and encourages parallel tool calls for speed.

### Plan (`built-in/planAgent.ts`)

A **read-only** software architect agent for designing implementation plans. Shares the same disallowed tools as Explore. Uses `inherit` model. Prompt guides a structured process: understand requirements → explore code → design solution → detail the plan with critical files. Also sets `omitClaudeMd: true`.

### verification (`built-in/verificationAgent.ts`)

An evidence-based verification agent that tries to **break** implementations rather than confirm them. Runs as a background task (`background: true`). Color-coded red. Disallows file modification tools. Its detailed prompt addresses two documented failure patterns: "verification avoidance" and "being seduced by the first 80%." Requires a `VERDICT: PASS/FAIL/PARTIAL` line in output. Includes a `criticalSystemReminder_EXPERIMENTAL` re-injected at every user turn to reinforce read-only constraints.

### statusline-setup (`built-in/statuslineSetup.ts`)

A UI configuration agent limited to `Read` and `Edit` tools. Uses `sonnet` model, color-coded orange. Guides users through converting shell PS1 prompts to Claude Code status line commands, including PS1 escape sequence mapping and `settings.json` configuration.

### claude-code-guide (`built-in/claudeCodeGuideAgent.ts`)

An onboarding/help agent with expertise in Claude Code, Claude Agent SDK, and the Claude API. Uses `haiku` model with `dontAsk` permission mode (no user prompts). Its `getSystemPrompt()` is the only built-in agent that accesses `toolUseContext` at prompt-generation time to inject the user's current configuration (custom skills, custom agents, MCP servers, plugins, settings) into the system prompt. Excluded from SDK entrypoints.

## Type Definitions

### AgentDefinition (Union Type)

```typescript
type AgentDefinition = BuiltInAgentDefinition | CustomAgentDefinition | PluginAgentDefinition
```

> Source: `loadAgentsDir.ts:162-165`

### BaseAgentDefinition

The shared base for all agent types (`loadAgentsDir.ts:106-133`):

| Field | Type | Description |
|-------|------|-------------|
| `agentType` | `string` | Unique agent identifier |
| `whenToUse` | `string` | Description shown to the LLM for agent selection |
| `tools` | `string[]?` | Allowed tools (`['*']` = all) |
| `disallowedTools` | `string[]?` | Explicitly blocked tools |
| `model` | `string?` | Model override (`"inherit"`, `"haiku"`, `"sonnet"`, etc.) |
| `effort` | `EffortValue?` | Reasoning effort level |
| `permissionMode` | `PermissionMode?` | Permission behavior override |
| `mcpServers` | `AgentMcpServerSpec[]?` | Agent-specific MCP servers |
| `hooks` | `HooksSettings?` | Session-scoped hooks |
| `maxTurns` | `number?` | Maximum agentic turns |
| `memory` | `AgentMemoryScope?` | Persistent memory scope (`user`/`project`/`local`) |
| `background` | `boolean?` | Always run as background task |
| `isolation` | `'worktree' \| 'remote'?` | Isolation mode |
| `omitClaudeMd` | `boolean?` | Skip CLAUDE.md injection to save tokens |
| `requiredMcpServers` | `string[]?` | MCP server name patterns required for availability |
| `color` | `AgentColorName?` | Display color |

### BuiltInAgentDefinition

Extends base with `source: 'built-in'`, a dynamic `getSystemPrompt(params)` that receives `toolUseContext`, and an optional `callback` (`loadAgentsDir.ts:136-143`).

### CustomAgentDefinition

Extends base with `source: SettingSource` (one of `userSettings`, `projectSettings`, `policySettings`, `flagSettings`), a parameterless `getSystemPrompt()`, and optional `filename` (`loadAgentsDir.ts:146-151`).

### PluginAgentDefinition

Extends base with `source: 'plugin'` and a `plugin: string` field identifying the source plugin (`loadAgentsDir.ts:154-159`).

### AgentMcpServerSpec

```typescript
type AgentMcpServerSpec = string | { [name: string]: McpServerConfig }
```

Either a reference to an existing MCP server by name, or an inline server definition (`loadAgentsDir.ts:58-60`).

### AgentDefinitionsResult

```typescript
type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[]    // De-duplicated by agentType with override priority
  allAgents: AgentDefinition[]       // Every agent from all sources
  failedFiles?: Array<{ path: string; error: string }>
  allowedAgentTypes?: string[]
}
```

> Source: `loadAgentsDir.ts:186-191`

## Configuration & Defaults

| Environment Variable | Effect |
|---------------------|--------|
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | When truthy in non-interactive mode, disables all built-in agents |
| `CLAUDE_CODE_COORDINATOR_MODE` | Switches to coordinator agents instead of standard built-ins |
| `CLAUDE_CODE_ENTRYPOINT` | When `sdk-ts`/`sdk-py`/`sdk-cli`, excludes the claude-code-guide agent |
| `CLAUDE_CODE_SIMPLE` | Skips custom/plugin agent loading, returns only built-ins |
| `USER_TYPE` | When `ant`, enables `remote` isolation mode and inherits model for Explore |

Custom agents are loaded from `.claude/agents/` directories found in user settings, project settings, and managed policy settings. Agent definitions use YAML frontmatter in `.md` files or JSON in settings files.

## Edge Cases & Caveats

- **Circular dependency avoidance**: `builtInAgents.ts` uses a lazy `require()` for coordinator agents to break a circular `tools → AgentTool → builtInAgents → coordinator → tools` chain (`builtInAgents.ts:33-40`)
- **Memory tool injection**: When an agent has `memory` enabled and a restricted `tools` list, `Write`/`Edit`/`Read` tools are automatically added so the agent can access its memory store (`loadAgentsDir.ts:456-467, 662-674`)
- **Silent skip of non-agent markdown**: Files in the `agents` directory that lack a `name` frontmatter field are silently skipped — only files with `name` but missing other required fields generate parse errors (`loadAgentsDir.ts:322-327`)
- **Memoization**: `getAgentDefinitionsWithOverrides` is memoized by `cwd`, so changes to agent files during a session require calling `clearAgentDefinitionsCache()` to take effect (`loadAgentsDir.ts:395-398`)
- **Agent memory snapshots**: For agents with `memory: 'user'`, the system checks for project-level memory snapshots and initializes or flags updates via `initializeAgentMemorySnapshots()` (`loadAgentsDir.ts:262-294`)
- **Override semantics**: A custom agent with the same `agentType` as a built-in completely replaces it — there is no merging of individual fields