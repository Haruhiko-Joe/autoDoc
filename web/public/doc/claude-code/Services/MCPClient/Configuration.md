# MCP Server Configuration

## Overview & Responsibilities

The Configuration module is the entry point for loading, validating, merging, and filtering MCP (Model Context Protocol) server configurations across the entire Claude Code application. It sits within the **Services > MCPClient** subsystem — sibling modules include the MCP SDK client wrapper, transport layers, tool discovery, and server approval UI. Upstream, the Bootstrap layer and MCP connection manager call into this module to determine which MCP servers should be started for a given session.

The module answers a single question: **"Which MCP servers should be active right now, and with what configuration?"** To answer it, it:

1. Loads server configs from six distinct scopes (project `.mcp.json`, user global config, local project config, enterprise managed config, dynamic/runtime configs, and claude.ai organization-managed connectors)
2. Expands environment variables in config strings (`${VAR}` and `${VAR:-default}`)
3. Normalizes server names to API-compatible identifiers (`^[a-zA-Z0-9_-]{1,64}$`)
4. Applies enterprise policy (allowlists and denylists) to filter servers
5. Deduplicates plugin and claude.ai servers against manually-configured ones
6. Merges everything into a single precedence-ordered map

The module spans four source files:
- **`config.ts`** — Core loading, merging, policy filtering, CRUD operations
- **`normalization.ts`** — Name normalization utility
- **`envExpansion.ts`** — Environment variable expansion
- **`claudeai.ts`** — Fetching organization-managed servers from claude.ai

## Key Processes

### Configuration Loading Pipeline

The main entry point is `getAllMcpConfigs()` (`src/services/mcp/config.ts:1258`), which orchestrates the full pipeline:

1. **Enterprise check** — If a managed enterprise config file exists (`managed-mcp.json`), it takes exclusive control. No other scopes are loaded. This is the strongest override.
2. **Parallel fetch kickoff** — The claude.ai connector fetch (`fetchClaudeAIMcpConfigsIfEligible`) is started before the synchronous loading so it overlaps with plugin loading.
3. **Scope loading** via `getClaudeCodeMcpConfigs()` (`src/services/mcp/config.ts:1071`):
   - **User scope** — from the global config file (`mcpServers` in global config)
   - **Project scope** — from `.mcp.json` files, walking from filesystem root down to CWD (closer files win)
   - **Local scope** — from the per-project config (`mcpServers` in project config)
   - **Plugin scope** — MCP servers contributed by installed plugins (loaded from cache)
   - **Dynamic scope** — servers injected at runtime (e.g., `--mcp-config` CLI flag)
4. **Project server approval** — Project-scope servers require explicit user approval (`getProjectMcpServerStatus(name) === 'approved'`).
5. **Plugin deduplication** — Plugin servers are content-deduplicated against manual servers by comparing command arrays (stdio) or URLs (remote). Manual servers always win; among plugins, first-loaded wins.
6. **Claude.ai deduplication** — Claude.ai connectors are similarly deduplicated against enabled manual servers by URL signature.
7. **Policy filtering** — Every server passes through allowlist/denylist checks. The denylist has absolute precedence.
8. **Merge** — Final merge in precedence order: `plugin < user < project < local`, with claude.ai having the lowest precedence.

### Environment Variable Expansion

When configs are parsed, each string field is expanded via `expandEnvVarsInString()` (`src/services/mcp/envExpansion.ts:10`):

- `${VAR}` — replaced with `process.env[VAR]`; if missing, the variable name is tracked and a warning is emitted
- `${VAR:-default}` — replaced with `process.env[VAR]` if set, otherwise falls back to `default`

Expansion applies to different fields depending on server type (`src/services/mcp/config.ts:556-616`):
- **stdio** servers: `command`, each `args` element, each `env` value
- **sse/http/ws** servers: `url`, each `headers` value
- **sdk, sse-ide, ws-ide, claudeai-proxy**: no expansion (no user-provided strings)

### Name Normalization

`normalizeNameForMCP()` (`src/services/mcp/normalization.ts:17`) ensures server names conform to the API pattern `^[a-zA-Z0-9_-]{1,64}$`:

1. Replace any character not in `[a-zA-Z0-9_-]` with `_`
2. For claude.ai servers (names starting with `"claude.ai "`), additionally collapse consecutive underscores and strip leading/trailing underscores — this prevents interference with the `__` delimiter used in MCP tool names (e.g., `mcp__serverName__toolName`)

### Claude.ai Server Fetching

`fetchClaudeAIMcpConfigsIfEligible()` (`src/services/mcp/claudeai.ts:39`) fetches organization-managed MCP servers from the claude.ai API:

1. **Gate checks**: disabled if `ENABLE_CLAUDEAI_MCP_SERVERS` is falsy, no OAuth access token, or token lacks `user:mcp_servers` scope
2. **API call**: `GET /v1/mcp_servers?limit=1000` with bearer auth and the `mcp-servers-2025-12-04` beta header (5-second timeout)
3. **Name collision handling**: Each server is keyed as `"claude.ai <display_name>"`. If normalized names collide, a `(2)`, `(3)`, etc. suffix is appended until unique
4. **Memoization**: Results are cached for the session lifetime. `clearClaudeAIMcpConfigsCache()` (`src/services/mcp/claudeai.ts:140`) invalidates after login

The module also tracks which connectors have ever successfully connected (`markClaudeAiMcpConnected` at line 154, `hasClaudeAiMcpEverConnected` at line 162) to gate startup notifications — only connectors that previously worked trigger "needs auth" warnings.

### Enterprise Policy Enforcement

Policy enforcement is a two-layer system (`src/services/mcp/config.ts:364-508`):

**Denylist** (`deniedMcpServers`) — checked first, has absolute precedence. Supports three match types:
- Name-based: exact server name match
- Command-based: exact match on `[command, ...args]` array (stdio only)
- URL-based: wildcard pattern match via `urlPatternToRegex()` (`src/services/mcp/config.ts:320`) where `*` matches any characters

**Allowlist** (`allowedMcpServers`) — checked second. Same three match types. When present:
- An empty allowlist blocks all servers
- Stdio servers must match a command entry if any exist, otherwise fall back to name matching
- Remote servers must match a URL entry if any exist, otherwise fall back to name matching

The `allowManagedMcpServersOnly` policy setting (`src/services/mcp/config.ts:1485`) restricts allowlist sources to managed (policy) settings only, while denylists always merge from all sources.

### CCR Proxy URL Unwrapping

In remote sessions, claude.ai connector URLs are rewritten to route through a CCR/session-ingress proxy. `unwrapCcrProxyUrl()` (`src/services/mcp/config.ts:182`) detects proxy URLs by path markers (`/v2/session_ingress/shttp/mcp/` or `/v2/ccr-sessions/`) and extracts the original vendor URL from the `mcp_url` query parameter so that signature-based deduplication can correctly match a plugin's raw URL against a connector's rewritten proxy URL.

## Function Signatures

### Core Loading Functions

#### `getAllMcpConfigs(): Promise<{ servers, errors }>`
Loads all configs from every scope including claude.ai. May be slow due to network calls. Returns merged server map and plugin errors.
> `src/services/mcp/config.ts:1258`

#### `getClaudeCodeMcpConfigs(dynamicServers?, extraDedupTargets?): Promise<{ servers, errors }>`
Fast loading of local-only configs (no network). Optional `dynamicServers` for runtime-injected configs and `extraDedupTargets` promise for concurrent dedup against in-flight fetches.
> `src/services/mcp/config.ts:1071`

#### `getMcpConfigsByScope(scope): { servers, errors }`
Loads configs from a single scope (`'project' | 'user' | 'local' | 'enterprise'`). For project scope, walks from root to CWD merging `.mcp.json` files.
> `src/services/mcp/config.ts:888`

#### `getMcpConfigByName(name): ScopedMcpServerConfig | null`
Looks up a server by name across all scopes. Precedence: enterprise > local > project > user.
> `src/services/mcp/config.ts:1033`

### CRUD Functions

#### `addMcpConfig(name, config, scope): Promise<void>`
Adds a server to the specified scope. Validates the name pattern (`[a-zA-Z0-9_-]`), checks for reserved names (`claude-in-chrome`, computer-use), validates config schema via `McpServerConfigSchema`, and enforces policy. Throws on invalid input, duplicates, or policy violations.
> `src/services/mcp/config.ts:625`

#### `removeMcpConfig(name, scope): Promise<void>`
Removes a server from the specified scope. Throws if not found. Only project/user/local scopes are mutable.
> `src/services/mcp/config.ts:769`

### Policy Functions

#### `filterMcpServersByPolicy<T>(configs): { allowed, blocked }`
Filters a config map by allowlist/denylist policy. SDK-type servers are exempt. Used by external entry points (`--mcp-config`, SDK `setMcpServers`).
> `src/services/mcp/config.ts:536`

#### `isMcpServerDisabled(name): boolean`
Checks if a server is disabled in the current project config. Default-disabled builtins use an opt-in list (`enabledMcpServers`); all others use an opt-out list (`disabledMcpServers`).
> `src/services/mcp/config.ts:1528`

#### `setMcpServerEnabled(name, enabled): void`
Toggles a server's enabled/disabled state in the project config.
> `src/services/mcp/config.ts:1553`

### Deduplication Functions

#### `dedupPluginMcpServers(pluginServers, manualServers): { servers, suppressed }`
Removes plugin servers whose signature (command array or URL) matches a manual server or earlier plugin.
> `src/services/mcp/config.ts:223`

#### `dedupClaudeAiMcpServers(claudeAiServers, manualServers): { servers, suppressed }`
Removes claude.ai connectors whose URL matches an enabled manual server.
> `src/services/mcp/config.ts:281`

#### `getMcpServerSignature(config): string | null`
Computes a dedup key: `"stdio:<json-command-array>"` or `"url:<unwrapped-url>"`. Returns null for SDK-type servers.
> `src/services/mcp/config.ts:202`

### Utility Functions

#### `normalizeNameForMCP(name): string`
Normalizes a server name to match `^[a-zA-Z0-9_-]{1,64}$`. Extra cleanup for claude.ai-prefixed names.
> `src/services/mcp/normalization.ts:17`

#### `expandEnvVarsInString(value): { expanded, missingVars }`
Expands `${VAR}` and `${VAR:-default}` syntax in a string. Returns the expanded string and a list of any unresolvable variable names.
> `src/services/mcp/envExpansion.ts:10`

#### `fetchClaudeAIMcpConfigsIfEligible(): Promise<Record<string, ScopedMcpServerConfig>>`
Memoized fetch of organization MCP servers from claude.ai. Returns empty object on any failure or ineligibility.
> `src/services/mcp/claudeai.ts:39`

#### `parseMcpConfig(params): { config, errors }`
Validates a config object against `McpJsonConfigSchema`, expands env vars if requested, and checks for Windows npx issues.
> `src/services/mcp/config.ts:1297`

#### `parseMcpConfigFromFilePath(params): { config, errors }`
Reads a JSON file from disk, parses it, and delegates to `parseMcpConfig`. Handles ENOENT gracefully.
> `src/services/mcp/config.ts:1384`

## Type Definitions

### `ConfigScope`
One of `'local' | 'user' | 'project' | 'enterprise' | 'dynamic' | 'claudeai'` — identifies where a server config originated.

### `ScopedMcpServerConfig`
An `McpServerConfig` extended with a `scope: ConfigScope` field, used throughout the merge pipeline.

### `ClaudeAIMcpServer` (`src/services/mcp/claudeai.ts:16`)
API response shape: `{ type: 'mcp_server', id: string, display_name: string, url: string, created_at: string }`.

### Server config variants
- **`McpStdioServerConfig`** — `type: 'stdio'`, has `command`, `args`, `env`
- **`McpSSEServerConfig` / `McpHTTPServerConfig` / `McpWebSocketServerConfig`** — `type: 'sse' | 'http' | 'ws'`, has `url`, `headers`
- **`sdk`, `sse-ide`, `ws-ide`, `claudeai-proxy`** — special transport types not directly user-configurable

## Configuration & Defaults

| Setting | Source | Description |
|---------|--------|-------------|
| `ENABLE_CLAUDEAI_MCP_SERVERS` | Env var | Set to a falsy value to disable claude.ai connector fetching |
| `allowedMcpServers` | Settings (any scope) | Allowlist entries (name, command, or URL). Absent = allow all |
| `deniedMcpServers` | Settings (any scope) | Denylist entries. Always merged from all sources |
| `allowManagedMcpServersOnly` | Policy settings | When `true`, allowlist reads only from managed/policy settings |
| `disabledMcpServers` | Project config | Array of server names the user has disabled |
| `enabledMcpServers` | Project config | Array of default-disabled builtin servers the user has enabled |
| `managed-mcp.json` | Enterprise managed path | If present, takes exclusive control over all MCP servers |
| `.mcp.json` | Project directory (and parents) | Per-project MCP server definitions |

**Timeouts**: Claude.ai API fetch uses a 5-second timeout (`FETCH_TIMEOUT_MS`, `src/services/mcp/claudeai.ts:30`).

**Memoization**: `fetchClaudeAIMcpConfigsIfEligible` and `doesEnterpriseMcpConfigExist` (`src/services/mcp/config.ts:1470`) are memoized per session.

## Edge Cases & Caveats

- **Enterprise exclusive mode**: When `managed-mcp.json` exists, *all* other scopes (user, project, local, plugin, claude.ai) are ignored. Users cannot add servers via `addMcpConfig()` either — it throws.
- **Plugin-only policy**: When `isRestrictedToPluginOnly('mcp')` is true, user/project/local servers are suppressed but plugin servers still load.
- **SDK servers bypass policy**: `filterMcpServersByPolicy` exempts `type: 'sdk'` servers because they are SDK-managed transport placeholders — the CLI never spawns a process or opens a connection for them.
- **Disabled servers and dedup**: A disabled manual server does *not* suppress its plugin or claude.ai counterpart. Only enabled servers count as dedup targets, preventing the case where neither server runs.
- **Project server approval**: Project-scope servers (from `.mcp.json`) require explicit user approval before they participate in the merge. Unapproved servers are silently excluded from `getClaudeCodeMcpConfigs`.
- **Claude.ai name collisions**: If two claude.ai servers normalize to the same name, suffixes `(2)`, `(3)`, etc. are appended. The collision check operates on the *final normalized* name, catching edge cases like `"Example Server 2"` colliding with `"Example Server! (2)"`.
- **Windows npx detection**: On Windows, stdio servers using `npx` without a `cmd /c` wrapper produce a validation warning (`src/services/mcp/config.ts:1351-1369`).
- **Atomic file writes**: `.mcp.json` writes use a temp-file + `datasync` + rename pattern (`writeMcpjsonFile`, `src/services/mcp/config.ts:88`) to prevent corruption, preserving original file permissions.
- **CCR proxy URLs**: In remote sessions, connector URLs are rewritten through a proxy. `unwrapCcrProxyUrl` extracts the original vendor URL so dedup correctly identifies matching servers.
- **Missing env vars**: Expansion of `${VAR}` where `VAR` is unset leaves the original `${VAR}` string in place (aids debugging) but reports it as a warning — the server may still fail to connect.
- **Scope precedence for `getMcpConfigByName`**: Lookup order is enterprise → local → project → user (`src/services/mcp/config.ts:1046-1057`), so a local override always shadows a user-level definition of the same name.