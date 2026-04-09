# MCP and Integrations

## Overview & Responsibilities

This module contains the tool implementations that let Claude Code interact with external protocols and services. It sits within the **ToolSystem** layer and provides seven tools that bridge Claude's conversation loop to MCP (Model Context Protocol) servers, Language Server Protocol (LSP) servers, the skills/plugin system, and the deferred-tool discovery mechanism.

Within the overall architecture, these tools are invoked by the **QueryEngine** when Claude's responses contain tool calls. They rely on the **Services** layer for MCP client connections and LSP server management, and on the **SkillsAndPlugins** layer for skill resolution and execution.

The seven tools are:

| Tool | Purpose |
|------|---------|
| **MCPTool** | Proxies tool calls to MCP server connections |
| **McpAuthTool** | Starts OAuth flows for unauthenticated MCP servers |
| **ListMcpResourcesTool** | Lists available resources from MCP servers |
| **ReadMcpResourceTool** | Reads a specific MCP resource by URI |
| **LSPTool** | Communicates with language servers for code intelligence |
| **SkillTool** | Invokes user-defined and bundled skills (slash commands) |
| **ToolSearchTool** | Discovers deferred tools via keyword/name matching |

---

## MCPTool

### How It Works

MCPTool is a **template tool** — its `name`, `description`, `prompt`, `call`, and `userFacingName` are all overridden at runtime by the MCP client service layer (`src/services/mcp/client.ts`). The definition in `src/tools/MCPTool/MCPTool.ts:27-77` provides the structural skeleton: a passthrough Zod input schema (`z.object({}).passthrough()`), a string output schema, and placeholder implementations. When MCP servers connect, `src/services/mcp/client.ts:1770` spreads `...MCPTool` and overrides each field with the real MCP tool's name, arguments, and call implementation.

Key properties:
- `isMcp: true` — marks it as an MCP tool for deferred-tool classification
- `maxResultSizeChars: 100_000` — caps result size to prevent context overflow
- `checkPermissions` returns `'passthrough'`, deferring permission decisions to the MCP client layer

### Result Collapse Classification

The `classifyForCollapse` module (`src/tools/MCPTool/classifyForCollapse.ts`) determines whether an MCP tool call should be visually collapsed in the UI as a search or read operation. It maintains two large allowlists:

- **`SEARCH_TOOLS`** (~140 entries): Tools from Slack, GitHub, Linear, Datadog, Sentry, Notion, Gmail, Google Drive, Jira, Asana, and many others that perform search/query operations.
- **`READ_TOOLS`** (~440 entries): Tools that read/list/get data without side effects.

The function `classifyMcpToolForCollapse(serverName, toolName)` normalizes the tool name (converting camelCase and kebab-case to snake_case) and checks membership in these sets. Unknown tools default to `{ isSearch: false, isRead: false }` (conservative — no collapse).

> Source: `src/tools/MCPTool/classifyForCollapse.ts:595-604`

### UI Rendering

The MCPTool UI (`src/tools/MCPTool/UI.tsx`) handles rich output formatting including:
- Flat key-value input display with truncation at 80 chars in non-verbose mode
- Progress bars for operations that report MCP progress notifications
- Large-response warnings when output exceeds ~10k tokens
- Special compact rendering for Slack message sends (showing channel + timestamp)

---

## McpAuthTool

### How It Works

When an MCP server is installed but returns HTTP 401 (unauthenticated), `createMcpAuthTool()` generates a pseudo-tool that replaces the server's real tools in the tool list. This makes the server visible to Claude so it can proactively start authentication.

> Source: `src/tools/McpAuthTool/McpAuthTool.ts:49-215`

### Authentication Flow

1. Claude calls the auth tool (named `mcp__<serverName>__authenticate`)
2. For `claudeai-proxy` transport: returns a message directing the user to `/mcp`
3. For `sse` or `http` transport: calls `performMCPOAuthFlow()` (from `src/services/mcp/auth.ts`) with `skipBrowserOpen: true`
4. Returns the OAuth authorization URL to Claude, which presents it to the user
5. In the background, when OAuth completes:
   - Clears the auth cache via `clearMcpAuthCache()` (from `src/services/mcp/client.ts`)
   - Reconnects the MCP server via `reconnectMcpServerImpl()` (from `src/services/mcp/client.ts`)
   - Replaces the pseudo-tool with the server's real tools in `appState.mcp.tools` using prefix-based replacement (`mcp__<server>__*`)

### Output Type

```typescript
type McpAuthOutput = {
  status: 'auth_url' | 'unsupported' | 'error'
  message: string
  authUrl?: string
}
```

The tool auto-allows permissions (`behavior: 'allow'`) since authentication itself is not a sensitive operation.

---

## ListMcpResourcesTool

### Function Signature

```typescript
call(input: { server?: string }, context): Promise<{ data: Resource[] }>
```

- **server** (optional): Filter to a specific MCP server name
- **Returns**: Array of `{ uri, name, mimeType?, description?, server }` objects

> Source: `src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts:40-123`

### Key Behavior

- Uses `ensureConnectedClient()` for reconnection if a server dropped, then `fetchResourcesForClient()` which is LRU-cached and warm from startup prefetch (both from `src/services/mcp/client.ts`)
- Cache invalidates on `onclose` and `resources/list_changed` notifications
- Individual server failures are caught and logged — one failing server doesn't block results from others
- Marked as `shouldDefer: true` — requires ToolSearch to discover
- Read-only and concurrency-safe

---

## ReadMcpResourceTool

### Function Signature

```typescript
call(input: { server: string, uri: string }, context): Promise<{ data: { contents: ContentItem[] } }>
```

> Source: `src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts:49-158`

### Binary Content Handling

When an MCP resource returns binary blob content (base64-encoded), the tool:
1. Decodes the base64 data to a `Buffer`
2. Persists it to disk via `persistBinaryContent()` (from `src/utils/mcpOutputStorage.ts`) with a MIME-derived file extension
3. Replaces the blob in the response with a `blobSavedTo` path and a human-readable message

This prevents large base64 strings from being injected into the conversation context.

---

## LSPTool

### Overview

LSPTool provides code intelligence by communicating with Language Server Protocol servers. It supports 9 operations and is enabled only when an LSP connection is active (`isLspConnected()` from `src/services/lsp/manager.ts`).

> Source: `src/tools/LSPTool/LSPTool.ts:127-422`

### Supported Operations

| Operation | LSP Method | Description |
|-----------|-----------|-------------|
| `goToDefinition` | `textDocument/definition` | Find where a symbol is defined |
| `findReferences` | `textDocument/references` | Find all references to a symbol |
| `hover` | `textDocument/hover` | Get type info and documentation |
| `documentSymbol` | `textDocument/documentSymbol` | List all symbols in a file |
| `workspaceSymbol` | `workspace/symbol` | Search symbols across workspace |
| `goToImplementation` | `textDocument/implementation` | Find interface implementations |
| `prepareCallHierarchy` | `textDocument/prepareCallHierarchy` | Get call hierarchy item at position |
| `incomingCalls` | `callHierarchy/incomingCalls` | Find callers of a function |
| `outgoingCalls` | `callHierarchy/outgoingCalls` | Find functions called by a function |

### Input Parameters

All operations share the same input shape:
- **operation**: One of the 9 operation names
- **filePath**: Absolute or relative path to the file
- **line**: 1-based line number (converted to 0-based for LSP protocol)
- **character**: 1-based character offset (converted to 0-based for LSP protocol)

### Key Process: Tool Call Execution

1. **Validate input** against a discriminated Zod union (`src/tools/LSPTool/schemas.ts:8-191`) and verify the file exists
2. **Check read permissions** via `checkReadPermissionForTool()`
3. **Wait for LSP initialization** if still pending (`src/tools/LSPTool/LSPTool.ts:230-233`)
4. **Open the file** in the LSP server if not already open (reads content, enforces 10MB size limit at `src/tools/LSPTool/LSPTool.ts:261-278`)
5. **Send the LSP request** via `manager.sendRequest()`
6. For `incomingCalls`/`outgoingCalls`: perform a **two-step process** — first `prepareCallHierarchy` to get `CallHierarchyItem`, then the actual calls request (`src/tools/LSPTool/LSPTool.ts:299-334`)
7. **Filter gitignored files** from location-based results using `git check-ignore` (batched in groups of 50) (`src/tools/LSPTool/LSPTool.ts:556-611`)
8. **Format the result** using operation-specific formatters

### Formatters

The formatting layer (`src/tools/LSPTool/formatters.ts`) converts raw LSP types into human-readable strings:
- Converts `file://` URIs to relative paths when shorter (`src/tools/LSPTool/formatters.ts:24-72`)
- Groups references/symbols by file
- Converts 0-based LSP positions back to 1-based for display
- Handles both `Location` and `LocationLink` formats uniformly
- Maps `SymbolKind` enum values to readable names (File, Class, Method, etc.) (`src/tools/LSPTool/formatters.ts:272-302`)
- Renders call hierarchy with call-site ranges

### Symbol Context

The `symbolContext.ts` module (`src/tools/LSPTool/symbolContext.ts:21-90`) extracts the symbol/word at a given file position for UI display. It reads only the first 64KB of the file synchronously (called from React render) and uses a regex pattern that handles standard identifiers, Rust lifetimes, macros, and operators.

---

## SkillTool

### Overview

SkillTool is the bridge between Claude's tool-calling capability and the slash-command/skill system. When Claude detects that a user's request matches a skill (like `/commit`, `/review-pr`), it invokes this tool to execute it.

> Source: `src/tools/SkillTool/SkillTool.ts:331-869`

### Input

```typescript
{ skill: string, args?: string }
```

- **skill**: The skill name (e.g., `"commit"`, `"review-pr"`, `"ms-office-suite:pdf"`)
- **args**: Optional arguments passed to the skill

### Execution Modes

#### Inline Execution (Default)
The skill's prompt is processed via `processPromptSlashCommand()`, producing user messages that are injected into the conversation. The tool returns `newMessages` and a `contextModifier` that can:
- Override allowed tools for the remainder of the conversation
- Switch the model (e.g., a skill specifying `model: opus`)
- Override the effort level

#### Forked Execution (`context: 'fork'`)
When a skill has `context: 'fork'`, it runs in an isolated sub-agent via `runAgent()` (`src/tools/SkillTool/SkillTool.ts:122-289`). The sub-agent has its own token budget and message context. Progress from tool uses within the sub-agent is reported back to the parent.

#### Remote Skill Execution (Experimental)
Skills with the `_canonical_<slug>` prefix are loaded from a remote source (AKI/GCS), cached locally, and injected as user messages (`src/tools/SkillTool/SkillTool.ts:969-1108`). This path handles `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}` substitutions.

### Validation Pipeline

1. Strip leading `/` if present
2. Check for remote canonical skills (experimental)
3. Look up the command in `getAllCommands()` (local + MCP skills)
4. Verify the command exists, is prompt-based, and doesn't have `disableModelInvocation`

### Permission Model

The tool checks permission rules in order (`src/tools/SkillTool/SkillTool.ts:432-578`):
1. **Deny rules**: Block if a deny rule matches the skill name (exact or prefix with `:*`)
2. **Remote canonical skills**: Auto-allow (experimental, ant-only)
3. **Allow rules**: Permit if an allow rule matches
4. **Safe properties check**: Auto-allow skills that only use safe (allowlisted) properties (`src/tools/SkillTool/SkillTool.ts:875-908`)
5. **Default**: Ask the user, offering suggestions to add allow rules

### Prompt Budget Management

The prompt module (`src/tools/SkillTool/prompt.ts`) manages how skill listings appear in Claude's system prompt:
- Allocates 1% of the context window for skill descriptions (`SKILL_BUDGET_CONTEXT_PERCENT = 0.01`)
- Per-entry description cap of 250 characters (`MAX_LISTING_DESC_CHARS`)
- Bundled skills always get full descriptions; non-bundled skills are truncated to fit the budget (`src/tools/SkillTool/prompt.ts:70-171`)
- Falls back to name-only listing when budget is extremely tight

---

## ToolSearchTool

### Overview

ToolSearchTool enables deferred tool discovery. Most tools (especially MCP tools) are "deferred" — their full schemas are not loaded into the initial prompt. Instead, they appear as names in system reminders. When Claude needs one, it calls ToolSearchTool to fetch the full schema.

> Source: `src/tools/ToolSearchTool/ToolSearchTool.ts:304-471`

### Input

```typescript
{ query: string, max_results?: number }
```

### Query Modes

#### Direct Selection (`select:`)
```
select:Read,Edit,Grep
```
Fetches exact tools by name (comma-separated). Checks deferred tools first, then falls back to the full tool set — selecting an already-loaded tool is a harmless no-op.

#### Keyword Search
```
notebook jupyter
+slack send
```
Scores tools based on name parts and description matches. The `+` prefix makes a term required (must match in name or description). Scoring weights (`src/tools/ToolSearchTool/ToolSearchTool.ts:259-292`):
- Exact name-part match: 10 points (12 for MCP tools)
- Partial name-part match: 5 points (6 for MCP)
- `searchHint` match: 4 points
- Full name fallback: 3 points
- Description word-boundary match: 2 points

### Tool Name Parsing

MCP tools (`mcp__server__action`) are split on `__` and `_` into searchable parts. Regular tools (CamelCase) are split at case boundaries and underscores (`src/tools/ToolSearchTool/ToolSearchTool.ts:132-161`).

### Deferral Rules

A tool is deferred if (`src/tools/ToolSearchTool/prompt.ts:62-108`):
- It has `isMcp: true` (MCP tools always defer) — unless `alwaysLoad` is set via `_meta['anthropic/alwaysLoad']`
- It has `shouldDefer: true`

Exceptions (never deferred):
- ToolSearchTool itself
- The Agent tool when `FORK_SUBAGENT` is enabled
- BriefTool and SendUserFileTool (communication channels)

### Output Format

Results are returned as `tool_reference` blocks that the API expands into full tool schemas:

```typescript
{
  matches: string[],        // matched tool names
  query: string,
  total_deferred_tools: number,
  pending_mcp_servers?: string[]  // servers still connecting
}
```

When no matches are found and MCP servers are still connecting, the response includes their names and suggests retrying.

---

## Edge Cases & Caveats

- **MCPTool is a template**: The actual `call()` implementation, tool name, description, and prompt are all overridden by `src/services/mcp/client.ts` at registration time. The source file (`src/tools/MCPTool/MCPTool.ts`) is just the structural skeleton.
- **McpAuthTool auto-replaces itself**: Once OAuth completes, the prefix-based replacement in `appState.mcp.tools` removes the auth pseudo-tool and inserts the server's real tools.
- **LSPTool two-step call hierarchy**: `incomingCalls` and `outgoingCalls` require first calling `prepareCallHierarchy` then the actual calls endpoint — this is handled transparently within the tool.
- **LSPTool gitignore filtering**: Results from `findReferences`, `goToDefinition`, `goToImplementation`, and `workspaceSymbol` are filtered against `.gitignore` using `git check-ignore` in batches of 50 paths.
- **LSPTool 1-based/0-based conversion**: User-facing coordinates are 1-based; the tool converts to 0-based for the LSP protocol and back for display.
- **SkillTool contextModifier**: Inline skills can modify the conversation context (allowed tools, model, effort) for subsequent turns — this is how skills like `/review-pr` get elevated tool permissions.
- **ToolSearchTool cache invalidation**: The description cache is cleared when the set of deferred tools changes (e.g., new MCP server connects).
- **Binary MCP resources**: `ReadMcpResourceTool` persists binary blobs to disk via `src/utils/mcpOutputStorage.ts` to avoid injecting base64 into the context window.