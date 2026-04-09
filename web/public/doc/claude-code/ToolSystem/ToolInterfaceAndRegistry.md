# Tool Interface and Registry

## Overview & Responsibilities

The Tool Interface and Registry module is the backbone of Claude Code's **ToolSystem** — it defines what a tool *is* and how the complete set of available tools is assembled at runtime. Within the ToolSystem hierarchy, it sits alongside 40+ concrete tool implementations (Bash, Read, Edit, Grep, etc.) and provides the shared type contracts and assembly logic they all depend on.

The module has two primary files:

- **`src/Tool.ts`** — The core type definitions: the `Tool` interface (30+ methods), `ToolUseContext` (runtime state bag), `ToolResult`/`ToolProgress` types, permission-related types, and the `buildTool` factory that fills in safe defaults.
- **`src/tools.ts`** — The tool registry: assembles the complete tool pool from built-in tools, conditionally-loaded feature-flagged tools, and MCP tools. Applies permission filtering, REPL mode handling, and deny rules.

Two supporting directories round out the scope:

- **`src/tools/shared/`** — Cross-tool utilities: `gitOperationTracking.ts` (detects git commits/pushes/PRs in shell output for metrics) and `spawnMultiAgent.ts` (teammate spawning for agent swarm mode).
- **`src/tools/testing/`** — `TestingPermissionTool.tsx`, a test-only tool that always triggers a permission prompt.

## Key Processes

### Tool Definition via `buildTool`

Every tool in the codebase is created through `buildTool()`, a factory function that merges a partial tool definition (`ToolDef`) with safe defaults. This ensures all 60+ tools share consistent fallback behavior without each needing boilerplate stubs.

The defaults follow a **fail-closed** principle where safety matters:

| Method | Default | Rationale |
|---|---|---|
| `isEnabled` | `true` | Tools are available unless explicitly disabled |
| `isConcurrencySafe` | `false` | Assume tools can't run in parallel |
| `isReadOnly` | `false` | Assume tools perform writes |
| `isDestructive` | `false` | Non-destructive by default |
| `checkPermissions` | `{ behavior: 'allow' }` | Defer to the general permission system |
| `toAutoClassifierInput` | `''` | Skip auto-mode classifier — security-relevant tools must override |
| `userFacingName` | `name` | Falls back to the tool's primary name |

> Source: `src/Tool.ts:757-792`

The `BuiltTool<D>` type uses mapped types to mirror the runtime `{ ...TOOL_DEFAULTS, ...def }` spread at the type level, preserving the concrete literal types from each tool's definition.

### Tool Pool Assembly

Getting from "all possible tools" to "tools available for this query" is a multi-stage pipeline:

```
getAllBaseTools()  →  getTools(permissionCtx)  →  assembleToolPool(permCtx, mcpTools)
     ↓                      ↓                            ↓
  All built-in         Remove special tools,         Merge with MCP,
  tools (40+)          filter by deny rules,         deduplicate,
                       REPL mode, isEnabled()        sort for cache
```

#### Stage 1: `getAllBaseTools()` — The Complete Built-in Catalog

Returns every tool that *could* be available in the current environment. This is the single source of truth for built-in tools and must stay synchronized with the system prompt cache configuration.

Tools are included conditionally based on:
- **Environment variables**: `USER_TYPE === 'ant'` gates internal tools (REPLTool, ConfigTool, TungstenTool)
- **Feature flags** via `feature()` from `bun:bundle`: `PROACTIVE`, `KAIROS`, `AGENT_TRIGGERS`, `COORDINATOR_MODE`, `OVERFLOW_TEST_TOOL`, `CONTEXT_COLLAPSE`, `TERMINAL_PANEL`, `WEB_BROWSER_TOOL`, `HISTORY_SNIP`, `UDS_INBOX`, `WORKFLOW_SCRIPTS`, `MONITOR_TOOL`
- **Runtime checks**: `isWorktreeModeEnabled()`, `isAgentSwarmsEnabled()`, `isTodoV2Enabled()`, `isPowerShellToolEnabled()`, `isToolSearchEnabledOptimistic()`, `hasEmbeddedSearchTools()`
- **Test mode**: `NODE_ENV === 'test'` includes `TestingPermissionTool`

> Source: `src/tools.ts:193-251`

#### Stage 2: `getTools(permissionContext)` — Filtered Built-in Tools

Applies multiple filtering layers in sequence:

1. **Simple mode** (`CLAUDE_CODE_SIMPLE`): If set, restricts to just Bash + Read + Edit (or REPL in REPL mode), with coordinator tools added when coordinator mode is active. Returns early after deny-rule filtering.

2. **Special tool removal**: Before any other filtering, `getTools` builds a `specialTools` set containing `ListMcpResourcesTool.name`, `ReadMcpResourceTool.name`, and `SYNTHETIC_OUTPUT_TOOL_NAME`, then strips them from the `getAllBaseTools()` result. These tools are added conditionally elsewhere (MCP resource tools are only relevant when MCP servers are connected; the synthetic output tool is injected by the query engine when needed).

   ```typescript
   const specialTools = new Set([
     ListMcpResourcesTool.name,
     ReadMcpResourceTool.name,
     SYNTHETIC_OUTPUT_TOOL_NAME,
   ])
   const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
   ```
   > Source: `src/tools.ts:301-307`

3. **Deny rule filtering** via `filterToolsByDenyRules()`: Removes tools that are blanket-denied in the permission context. Uses the same matcher as runtime permission checks, so `mcp__server` deny rules strip all tools from that MCP server before the model sees them.

4. **REPL mode handling**: When REPL mode is enabled and the REPL tool is present, primitive tools in `REPL_ONLY_TOOLS` (Bash, Read, Edit, etc.) are hidden from direct use — they remain accessible inside the REPL VM context.

5. **`isEnabled()` check**: Final filter removes any tool that reports itself as disabled.

> Source: `src/tools.ts:271-327`

#### Stage 3: `assembleToolPool()` — Merging Built-in + MCP Tools

The final assembly point used by both the REPL UI (`useMergedTools` hook) and `runAgent.ts` for coordinator workers:

1. Gets built-in tools via `getTools()`
2. Filters MCP tools by deny rules
3. Sorts each partition alphabetically for **prompt-cache stability** — built-in tools form a contiguous prefix so MCP tool changes don't invalidate cache keys
4. Deduplicates by name via `uniqBy` (built-in tools take precedence)

> Source: `src/tools.ts:345-367`

### Tool Lookup

Two utility functions enable finding tools by name or alias:

- **`toolMatchesName(tool, name)`** — Checks primary `name` and optional `aliases` array (`src/Tool.ts:348-353`)
- **`findToolByName(tools, name)`** — Finds the first tool matching a name in a tool set (`src/Tool.ts:358-360`)

## The `Tool` Interface

The `Tool<Input, Output, P>` generic interface is the contract every tool must satisfy. It has three type parameters:
- `Input` — Zod schema type for tool input
- `Output` — Type of the tool result's data field
- `P` — Progress data type (defaults to `ToolProgressData`)

### Core Execution Methods

| Method | Signature | Purpose |
|---|---|---|
| `call` | `(args, context, canUseTool, parentMessage, onProgress?) → Promise<ToolResult<Output>>` | Execute the tool |
| `validateInput` | `(input, context) → Promise<ValidationResult>` | Pre-execution validation; informs model on failure |
| `checkPermissions` | `(input, context) → Promise<PermissionResult>` | Tool-specific permission logic, called after `validateInput` passes |

### Schema & Metadata

| Field | Purpose |
|---|---|
| `name` | Primary tool name |
| `aliases` | Optional backward-compatible names |
| `searchHint` | 3–10 word phrase for `ToolSearch` keyword matching when the tool is deferred |
| `inputSchema` | Zod schema for input validation |
| `inputJSONSchema` | Alternative JSON Schema for MCP tools |
| `outputSchema` | Optional Zod schema for output |
| `description(input, options)` | Dynamic description string |
| `prompt(options)` | System prompt text for the model |
| `maxResultSizeChars` | Threshold for persisting large results to disk (set to `Infinity` to disable) |

### Behavioral Flags

| Method | Returns | Purpose |
|---|---|---|
| `isEnabled()` | `boolean` | Whether the tool is available |
| `isConcurrencySafe(input)` | `boolean` | Safe for parallel execution? |
| `isReadOnly(input)` | `boolean` | Does it only read? |
| `isDestructive(input)` | `boolean` | Irreversible operations (delete, overwrite, send)? |
| `isOpenWorld(input)` | `boolean` | Accesses external resources? |
| `interruptBehavior()` | `'cancel' \| 'block'` | What happens when user interrupts |
| `requiresUserInteraction()` | `boolean` | Needs interactive user input? |
| `shouldDefer` | `boolean` | Deferred loading via `ToolSearch` |
| `alwaysLoad` | `boolean` | Never deferred — always in initial prompt |
| `isMcp` / `isLsp` | `boolean` | MCP or LSP tool marker |

### Rendering Methods

The interface includes a rich set of rendering methods for the terminal UI:

- **`renderToolUseMessage`** — Renders the tool invocation (input may be partial during streaming)
- **`renderToolResultMessage`** — Renders the tool's output
- **`renderToolUseProgressMessage`** — Progress UI while running
- **`renderToolUseRejectedMessage`** — Custom rejection UI (falls back to `FallbackToolUseRejectedMessage`)
- **`renderToolUseErrorMessage`** — Custom error UI (falls back to `FallbackToolUseErrorMessage`)
- **`renderGroupedToolUse`** — Renders multiple parallel instances as a group (non-verbose only)
- **`renderToolUseTag`** — Optional metadata tag (timeout, model, etc.)
- **`renderToolUseQueuedMessage`** — UI while queued

Additional display helpers: `userFacingName`, `userFacingNameBackgroundColor`, `getToolUseSummary`, `getActivityDescription`, `isSearchOrReadCommand`, `isResultTruncated`, `isTransparentWrapper`, `extractSearchText`.

### Other Methods

- **`inputsEquivalent(a, b)`** — Compare two inputs for deduplication
- **`getPath(input)`** — Extract file path for tools operating on files
- **`preparePermissionMatcher(input)`** — Build a matcher for hook `if` patterns (e.g., `"Bash(git *)"`)
- **`backfillObservableInput(input)`** — Mutate copies of input before observers see them (adds legacy/derived fields)
- **`toAutoClassifierInput(input)`** — Compact representation for the auto-mode security classifier
- **`mapToolResultToToolResultBlockParam(content, toolUseID)`** — Convert output to API format

## `ToolUseContext` — Runtime State

`ToolUseContext` (`src/Tool.ts:158-300`) is the runtime context bag passed to every tool's `call` method. It carries:

### Core State
- **`options`** — Commands, debug flags, model name, tools list, thinking config, MCP clients/resources, agent definitions, budget limit, custom system prompts
- **`messages`** — The full conversation message history
- **`abortController`** — Signal for cancellation
- **`readFileState`** — LRU file content cache
- **`getAppState()` / `setAppState()`** — Global application state access

### UI Callbacks
- `setToolJSX` — Render tool-specific JSX
- `addNotification` — Push UI notifications
- `appendSystemMessage` — Inject system messages into the REPL
- `sendOSNotification` — Trigger OS-level notifications
- `setStreamMode` — Control spinner display mode
- `openMessageSelector` — Open the message selector UI

### Tracking & Metrics
- `setInProgressToolUseIDs` — Track which tool calls are running
- `setResponseLength` — Track response size
- `updateFileHistoryState` — File modification tracking
- `updateAttributionState` — Commit attribution tracking
- `queryTracking` — Chain ID and depth for query chains
- `toolDecisions` — Cached tool permission decisions

### Agent & Session
- `agentId` / `agentType` — Subagent identification
- `contentReplacementState` — Tool result budget management
- `localDenialTracking` — Denial counter for async subagents
- `renderedSystemPrompt` — Frozen parent prompt for cache sharing

## `ToolResult` and `ToolProgress` Types

### `ToolResult<T>` (`src/Tool.ts:321-336`)

```typescript
type ToolResult<T> = {
  data: T                           // The tool's output
  newMessages?: Message[]           // Inject messages into conversation
  contextModifier?: (ctx) => ctx    // Modify context (non-concurrent tools only)
  mcpMeta?: { ... }                 // MCP protocol metadata passthrough
}
```

### `ToolProgress<P>` (`src/Tool.ts:307-310`)

```typescript
type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string
  data: P
}
```

Progress data is specialized per tool via a discriminated union type `ToolProgressData`, which is re-exported from `src/Tool.ts:303`. Concrete variants include: `BashProgress`, `AgentToolProgress`, `MCPProgress`, `REPLToolProgress`, `SkillToolProgress`, `TaskOutputProgress`, `WebSearchProgress`. These are imported into `Tool.ts` from an internal build-time generated module and re-exported for public consumption.

## `ToolPermissionContext` (`src/Tool.ts:123-138`)

Immutable context for permission decisions:

| Field | Type | Purpose |
|---|---|---|
| `mode` | `PermissionMode` | Current permission mode (default, auto, bypassPermissions, etc.) |
| `additionalWorkingDirectories` | `Map` | Extra directories the tool may access |
| `alwaysAllowRules` / `alwaysDenyRules` / `alwaysAskRules` | `ToolPermissionRulesBySource` | Permission rules from settings |
| `isBypassPermissionsModeAvailable` | `boolean` | Whether bypass mode can be entered |
| `shouldAvoidPermissionPrompts` | `boolean` | Auto-deny prompts (background agents) |
| `awaitAutomatedChecksBeforeDialog` | `boolean` | Await classifier/hooks before showing dialog |
| `prePlanMode` | `PermissionMode` | Saved mode before plan-mode entry |

The `PermissionResult` type is imported from `src/types/permissions.ts`, the centralized location for permission-related types that breaks import cycles.

## Shared Utilities

### Git Operation Tracking (`src/tools/shared/gitOperationTracking.ts`)

Provides `detectGitOperation(command, output)` and `trackGitOperations(command, exitCode, stdout)` — shell-agnostic detection of git commits, pushes, cherry-picks, merges, rebases, and PR operations (via `gh`, `glab`, or `curl`) in command strings. Used by shell tools (BashTool, PowerShellTool) to:

- Increment OTLP counters for commits and PRs
- Fire analytics events (`tengu_git_operation`)
- Auto-link sessions to PRs when `gh pr create` output contains a PR URL
- Surface operation summaries in the collapsed tool-use display

### Multi-Agent Spawning (`src/tools/shared/spawnMultiAgent.ts`)

Provides `spawnTeammate()` for creating new Claude Code teammate sessions. Handles:

- Model resolution (`'inherit'` alias, configured defaults, hardcoded fallbacks)
- Backend detection (tmux split-pane, iTerm2, in-process)
- Unique name generation to avoid duplicates within a team
- CLI flag inheritance (permission mode, model, settings, plugins, chrome flags)
- Team file management for swarm coordination

### Testing Permission Tool (`src/tools/testing/TestingPermissionTool.tsx`)

A minimal tool that always returns `{ behavior: 'ask' }` from `checkPermissions`. Only enabled when `NODE_ENV === 'test'`. Demonstrates the `buildTool` pattern with all rendering methods returning `null`.

## Edge Cases & Caveats

- **Special tools are stripped before filtering**: `getTools()` removes `ListMcpResourcesTool`, `ReadMcpResourceTool`, and the synthetic output tool from the base set *before* applying deny rules or REPL filtering. These tools are injected through separate paths (MCP resource tools when servers connect, synthetic output by the query engine).
- **Prompt-cache stability**: `assembleToolPool` sorts built-in and MCP tools separately, then concatenates (built-ins first). This prevents MCP tool additions from invalidating the server-side prompt cache for built-in tools.
- **Circular dependency avoidance**: `TeamCreateTool`, `TeamDeleteTool`, and `SendMessageTool` use lazy `require()` calls to break circular import chains. Similarly, `PermissionResult` types are imported from `src/types/permissions.ts` rather than their original module, and `ToolProgressData` is imported from an internal build-time module and re-exported through `src/Tool.ts`.
- **Embedded search tools**: When the binary includes embedded `bfs`/`ugrep` (ant-native builds), `GlobTool` and `GrepTool` are excluded from the base tool list since shell aliases handle them.
- **`maxResultSizeChars: Infinity`**: Tools like Read set this to prevent result persistence, which would create circular Read→file→Read loops.
- **`buildTool` type safety**: The `BuiltTool<D>` mapped type proves correctness at compile time across 60+ tools — if a default is missing or mistyped, the typecheck fails.
- **REPL mode tool hiding**: Primitive tools are hidden from direct model use but remain accessible inside the REPL VM context — the tools aren't removed, just filtered from the model's view.