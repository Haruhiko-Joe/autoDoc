# MCP Utilities

## Overview & Responsibilities

The MCP Utilities module provides shared helper functions used throughout the MCPClient subsystem within the Services layer. It sits alongside the MCP connection manager, transport layers, and server configuration modules, offering three categories of functionality:

1. **Filtering & exclusion** — selecting or removing tools, commands, and resources by MCP server name or staleness (`src/services/mcp/utils.ts`)
2. **String parsing & construction** — parsing the `mcp__<server>__<tool>` naming convention and building qualified names (`src/services/mcp/mcpStringUtils.ts`)
3. **Dynamic header generation** — executing user-configured helper scripts to produce authentication headers for SSE/HTTP/WebSocket servers (`src/services/mcp/headersHelper.ts`)

Additionally, the module handles project-level MCP server status queries (approved/rejected/pending), config scope labeling, config hashing for change detection, agent MCP server extraction, and analytics-safe URL sanitization.

## Key Processes

### Tool/Command Name Resolution

MCP tools follow a strict naming convention: `mcp__<normalizedServerName>__<normalizedToolName>`. The flow for resolving names works as follows:

1. `normalizeNameForMCP()` (from `./normalization.js`) normalizes server and tool names
2. `getMcpPrefix()` builds the `mcp__<server>__` prefix (`src/services/mcp/mcpStringUtils.ts:39-41`)
3. `buildMcpToolName()` combines prefix + normalized tool name to produce the fully qualified name (`src/services/mcp/mcpStringUtils.ts:50-52`)
4. `mcpInfoFromString()` performs the inverse: splitting a qualified string back into `{ serverName, toolName }` (`src/services/mcp/mcpStringUtils.ts:19-32`)

**Known limitation**: Server names containing `__` will be parsed incorrectly — the parser splits on `__` and takes the first segment as the server name. This is documented in the source and rare in practice.

MCP commands use two naming patterns: prompts use `mcp__<server>__<prompt>` while skills use `<server>:<skill>`. The `commandBelongsToServer()` function checks both patterns (`src/services/mcp/utils.ts:52-62`).

### Stale Plugin Client Cleanup

When plugins are reloaded (`/reload-plugins`), the system detects stale MCP clients via `excludeStalePluginClients()` (`src/services/mcp/utils.ts:185-224`):

1. For each existing client, look up its config in the fresh config map
2. A client is stale if:
   - It has `scope === 'dynamic'` and its name is absent from the new configs (plugin was disabled)
   - Its config hash changed (the server's args/url/env were edited on disk) — applies to all scopes
3. For each stale client, strip its tools, commands, and resources using the exclude helpers
4. Return the cleaned state plus the list of stale clients for the caller to disconnect

Config hashing (`hashMcpConfig()`, line 157-169) uses SHA-256 over a JSON-serialized config with sorted keys, excluding the `scope` field (since moving a server between config files shouldn't trigger a reconnect). Only the first 16 hex chars are kept.

### Project MCP Server Status

`getProjectMcpServerStatus()` (`src/services/mcp/utils.ts:351-406`) determines whether a project-scoped MCP server is approved, rejected, or pending:

1. Check `disabledMcpjsonServers` in settings — if the server is listed, return `'rejected'`
2. Check `enabledMcpjsonServers` or `enableAllProjectMcpServers` — if matched, return `'approved'`
3. In dangerous/bypass-permissions mode (`hasSkipDangerousModePermissionPrompt()`), auto-approve if `projectSettings` is enabled. Importantly, this reads only from user/local/flag/policy settings — **not** project settings — to prevent a malicious repo from self-approving
4. In non-interactive mode (SDK, `claude -p`, piped input), auto-approve if `projectSettings` is enabled
5. Otherwise return `'pending'`

### Dynamic Header Generation

For SSE, HTTP, and WebSocket MCP servers, headers can come from two sources merged by `getMcpServerHeaders()` (`src/services/mcp/headersHelper.ts:125-138`):

1. **Static headers** — defined directly in the server config as `config.headers`
2. **Dynamic headers** — produced by running a `config.headersHelper` shell script

The dynamic header flow (`getMcpHeadersFromHelper()`, lines 32-117):

1. If `headersHelper` is not configured, return `null`
2. **Security check**: For project/local-scoped configs in interactive sessions, verify workspace trust has been established via `checkHasTrustDialogAccepted()`. If trust is missing, log a security error and return `null`
3. Execute the helper script via `execFileNoThrow` with a 10-second timeout, passing environment variables:
   - `CLAUDE_CODE_MCP_SERVER_NAME` — the server name
   - `CLAUDE_CODE_MCP_SERVER_URL` — the server URL
4. Parse the script's stdout as JSON, validating it's a flat `Record<string, string>`
5. Dynamic headers **override** static headers when both specify the same key

## Function Signatures

### Filtering Functions (`utils.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `filterToolsByServer` | `(tools: Tool[], serverName: string) => Tool[]` | Returns tools whose names start with the server's MCP prefix |
| `filterCommandsByServer` | `(commands: Command[], serverName: string) => Command[]` | Returns commands belonging to a server (both prompt and skill naming) |
| `filterMcpPromptsByServer` | `(commands: Command[], serverName: string) => Command[]` | Like `filterCommandsByServer` but excludes MCP skills (`loadedFrom === 'mcp'`) |
| `filterResourcesByServer` | `(resources: ServerResource[], serverName: string) => ServerResource[]` | Returns resources matching a server name |
| `excludeToolsByServer` | `(tools: Tool[], serverName: string) => Tool[]` | Inverse of filter — removes a server's tools |
| `excludeCommandsByServer` | `(commands: Command[], serverName: string) => Command[]` | Removes a server's commands |
| `excludeResourcesByServer` | `(resources: Record<string, ServerResource[]>, serverName: string) => Record<string, ServerResource[]>` | Removes a server's resource entry from the map |

### Identity Checks (`utils.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `isToolFromMcpServer` | `(toolName: string, serverName: string) => boolean` | Parses the tool name and checks if the server matches |
| `isMcpTool` | `(tool: Tool) => boolean` | `true` if name starts with `mcp__` or `tool.isMcp` is set |
| `isMcpCommand` | `(command: Command) => boolean` | `true` if name starts with `mcp__` or `command.isMcp` is set |

### String Utilities (`mcpStringUtils.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `mcpInfoFromString` | `(toolString: string) => { serverName, toolName? } \| null` | Parses `mcp__server__tool` into components |
| `getMcpPrefix` | `(serverName: string) => string` | Returns `mcp__<normalized>__` |
| `buildMcpToolName` | `(serverName: string, toolName: string) => string` | Builds `mcp__<server>__<tool>` from parts |
| `getToolNameForPermissionCheck` | `(tool: { name, mcpInfo? }) => string` | Returns the qualified MCP name for permission matching, preventing collisions with built-in tool names |
| `getMcpDisplayName` | `(fullName: string, serverName: string) => string` | Strips the MCP prefix, returning only the tool portion |
| `extractMcpToolDisplayName` | `(userFacingName: string) => string` | Strips both the `server - ` prefix and ` (MCP)` suffix from a user-facing name |

### Header Helpers (`headersHelper.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `getMcpHeadersFromHelper` | `(serverName, config) => Promise<Record<string, string> \| null>` | Executes the `headersHelper` script and returns parsed headers |
| `getMcpServerHeaders` | `(serverName, config) => Promise<Record<string, string>>` | Merges static `config.headers` with dynamic headers from the helper |

### Other Utilities (`utils.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `hashMcpConfig` | `(config: ScopedMcpServerConfig) => string` | SHA-256 hash (16 hex chars) of config excluding `scope`, with sorted keys |
| `excludeStalePluginClients` | `(mcp, configs) => { clients, tools, commands, resources, stale }` | Detects and removes stale MCP clients after config changes |
| `getProjectMcpServerStatus` | `(serverName: string) => 'approved' \| 'rejected' \| 'pending'` | Queries settings to determine a project MCP server's approval status |
| `getMcpServerScopeFromToolName` | `(toolName: string) => ConfigScope \| null` | Looks up the config scope for a tool's server; falls back to `'claudeai'` for `claude_ai_` prefixed servers |
| `describeMcpConfigFilePath` | `(scope: ConfigScope) => string` | Human-readable path description for each scope |
| `getScopeLabel` | `(scope: ConfigScope) => string` | User-facing label (e.g., "Local config (private to you in this project)") |
| `ensureConfigScope` | `(scope?: string) => ConfigScope` | Validates and defaults to `'local'` |
| `ensureTransport` | `(type?: string) => 'stdio' \| 'sse' \| 'http'` | Validates and defaults to `'stdio'` |
| `parseHeaders` | `(headerArray: string[]) => Record<string, string>` | Parses `"Key: value"` strings into an object |
| `extractAgentMcpServers` | `(agents: AgentDefinition[]) => AgentMcpServerInfo[]` | Collects inline MCP server definitions from agent frontmatter, deduplicating by server name |
| `getLoggingSafeMcpBaseUrl` | `(config: McpServerConfig) => string \| undefined` | Extracts the base URL without query strings (which may contain tokens) for safe analytics logging |

## Edge Cases & Caveats

- **Double-underscore ambiguity**: `mcpInfoFromString` splits on `__` and takes the first segment as the server name. A server named `my__server` would be incorrectly parsed as server `my` with tool `server__<rest>`. Tool names containing `__` are handled correctly (remaining parts are re-joined).

- **Headers helper security**: For project/local-scoped servers, the helper script is blocked until workspace trust is confirmed. This prevents a cloned repository from executing arbitrary scripts before the user approves the workspace. In non-interactive mode (CI/CD), the trust check is skipped.

- **Headers helper timeout**: The helper script has a hard 10-second timeout. If it exceeds this, the connection proceeds without dynamic headers rather than failing entirely.

- **Config hash excludes scope**: Moving a server definition between `.mcp.json` and `settings.json` does not change its hash, intentionally avoiding unnecessary reconnections.

- **Project server auto-approval**: The `getProjectMcpServerStatus` function explicitly avoids reading `projectSettings` for the bypass-permissions check. This prevents a malicious repo's `.claude/settings.json` from self-approving its own MCP servers.

- **Command naming duality**: MCP prompts use `mcp__<server>__<name>` while MCP skills use `<server>:<name>`. Functions like `commandBelongsToServer` and `filterMcpPromptsByServer` account for both conventions.