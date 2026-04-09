# SubcommandHandlers

## Overview & Responsibilities

The SubcommandHandlers module contains the lazily-loaded handler implementations for CLI subcommands that execute outside the main REPL session. When a user runs commands like `claude auth login`, `claude mcp add`, or `claude plugin install`, the CLI's argument parser dynamically imports only the relevant handler file, keeping the main entry point lightweight.

Within the Bootstrap layer of the architecture, these handlers sit at the boundary between CLI argument parsing (in `main.tsx`) and the core services (OAuth, MCP, plugins, etc.). Each handler file is self-contained: it imports what it needs, performs its operation, writes output to stdout/stderr, and exits the process.

### Module map

| File | Subcommand prefix | Purpose |
|------|-------------------|---------|
| `auth.ts` | `claude auth` | OAuth login, logout, status |
| `mcp.tsx` | `claude mcp` | MCP server add/remove/list/get/serve/reset |
| `plugins.ts` | `claude plugin`, `claude plugin marketplace` | Plugin & marketplace CRUD |
| `agents.ts` | `claude agents` | List configured agents |
| `autoMode.ts` | `claude auto-mode` | Dump/critique auto-mode classifier rules |
| `update.ts` | `claude update` | CLI self-update |
| `util.tsx` | `claude setup-token`, `claude doctor`, `claude install` | Shared utilities and misc handlers |

## Key Processes

### Auth Login Flow (`auth.ts`)

1. Check for mutually exclusive flags (`--console` vs `--claudeai`) and resolve `forceLoginMethod` from managed settings (`src/cli/handlers/auth.ts:130-136`)
2. **Fast path**: If `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` env var is set, exchange the refresh token directly for new tokens via `refreshOAuthToken()`, skipping the browser (`src/cli/handlers/auth.ts:141-186`)
3. **Browser path**: Instantiate `OAuthService`, call `startOAuthFlow()` which opens the user's browser to the Anthropic OAuth consent page and waits for the redirect (`src/cli/handlers/auth.ts:190-206`)
4. **Token installation** (`installOAuthTokens`, `src/cli/handlers/auth.ts:50-110`): Shared post-acquisition logic that:
   - Clears previous auth state via `performLogout()`
   - Fetches the OAuth profile and stores account info
   - Saves tokens to disk and clears the token cache
   - Fetches user roles; for Console users, creates and stores an API key
5. Validate organization constraints via `validateForceLoginOrg()` and exit

### Auth Status Flow (`auth.ts`)

Determines the current auth method by checking OAuth tokens, `ANTHROPIC_API_KEY` env var, and third-party service configuration. Outputs either human-readable text (`--text`) or structured JSON with fields like `loggedIn`, `authMethod`, `apiProvider`, `email`, `subscriptionType` (`src/cli/handlers/auth.ts:232-319`).

### MCP Server Management (`mcp.tsx`)

All MCP handlers follow a pattern: validate inputs, call into `services/mcp/config.ts` for config mutations, log an analytics event, and print results.

- **`mcpAddJsonHandler`** (`src/cli/handlers/mcp.tsx:286-316`): Parses a JSON server definition, optionally reads a client secret from stdin, writes the config to the requested scope (user/project/local), and saves any OAuth client secret to secure storage.
- **`mcpRemoveHandler`** (`src/cli/handlers/mcp.tsx:74-141`): Looks up the server across all config scopes. If it exists in exactly one scope, removes it and cleans up secure storage tokens. If it exists in multiple scopes, prompts the user to specify which scope.
- **`mcpListHandler`** (`src/cli/handlers/mcp.tsx:144-190`): Fetches all configured MCP servers, checks each server's health concurrently using `pMap` with a configurable batch size, and prints connection status (Connected, Needs authentication, Failed, Error).
- **`mcpGetHandler`** (`src/cli/handlers/mcp.tsx:193-285`): Prints detailed information about a single server including type, URL/command, headers, OAuth config, environment variables, and health status.
- **`mcpServeHandler`** (`src/cli/handlers/mcp.tsx:42-71`): Starts Claude Code as an MCP server itself by calling `startMCPServer()` after running setup.
- **`mcpAddFromDesktopHandler`** (`src/cli/handlers/mcp.tsx:317-351`): Renders an Ink-based dialog (`MCPServerDesktopImportDialog`) that imports MCP server configs from the Claude Desktop app.
- **`mcpResetChoicesHandler`** (`src/cli/handlers/mcp.tsx:352-362`): Clears the `approvedMcpServers` and `rejectedMcpServers` lists from project config, resetting all approval/rejection state.

### Plugin Management (`plugins.ts`)

Plugin handlers manage the full plugin lifecycle with scope awareness (`user`, `project`, `local`):

- **`pluginInstallHandler`** (`src/cli/handlers/plugins.ts:668-701`): Validates the scope, parses the plugin identifier (name + optional marketplace), delegates to `installPlugin()` from `pluginCliCommands.ts`.
- **`pluginUninstallHandler`** (`src/cli/handlers/plugins.ts:703-737`): Same pattern with `uninstallPlugin()`, supports `--keepData` to preserve plugin data on removal.
- **`pluginEnableHandler`** / **`pluginDisableHandler`** (`src/cli/handlers/plugins.ts:740-843`): Toggle plugin enabled state. Disable supports `--all` to disable every plugin at once.
- **`pluginUpdateHandler`** (`src/cli/handlers/plugins.ts:846-878`): Updates a plugin to its latest version within a given scope.
- **`pluginListHandler`** (`src/cli/handlers/plugins.ts:157-444`): The most complex handler — loads installed plugins from V2 bookkeeping, loads all plugins (including session-only inline plugins from `--plugin-dir`), collects load errors, and outputs either human-readable or `--json` format. With `--available`, also queries configured marketplaces for uninstalled plugins.
- **`pluginValidateHandler`** (`src/cli/handlers/plugins.ts:101-154`): Validates a plugin manifest file and, if inside a `.claude-plugin` directory, also validates plugin content files (skills, agents, commands, hooks).

**Marketplace subcommands** (`src/cli/handlers/plugins.ts:447-665`):
- `marketplaceAddHandler`: Parses source (GitHub repo, git URL, directory, file), validates scope, materializes marketplace data, and saves to settings.
- `marketplaceListHandler`: Lists configured marketplaces with their source types.
- `marketplaceRemoveHandler`: Removes a marketplace by name.
- `marketplaceUpdateHandler`: Refreshes one or all marketplaces from their sources.

### Agents Listing (`agents.ts`)

Loads all agent definitions with overrides from the current working directory, resolves which agents are active vs. shadowed, groups them by source (bundled, project, user), and prints a formatted list showing agent type, model, and memory allocation (`src/cli/handlers/agents.ts:32-70`).

### Auto-Mode Rule Inspection (`autoMode.ts`)

- **`autoModeDefaultsHandler`** (`src/cli/handlers/autoMode.ts:24-26`): Dumps the built-in default classifier rules as JSON.
- **`autoModeConfigHandler`** (`src/cli/handlers/autoMode.ts:35-47`): Dumps the effective merged config — user settings replace defaults per-section (REPLACE semantics, not merge).
- **`autoModeCritiqueHandler`** (`src/cli/handlers/autoMode.ts:73-149`): Uses `sideQuery()` to send the user's custom rules to Claude for AI-powered critique. The system prompt instructs the model to evaluate clarity, completeness, conflicts, and actionability of each rule.

### CLI Self-Update (`update.ts`)

1. Run `getDoctorDiagnostic()` to detect the installation type and check for multiple installations (`src/cli/update.ts:41-58`)
2. Display any diagnostic warnings (PATH issues, config mismatches) (`src/cli/update.ts:60-74`)
3. Auto-detect and persist the installation method if not already configured (`src/cli/update.ts:77-106`)
4. Branch by installation type:
   - **Development**: Refuse to update (`src/cli/update.ts:109-115`)
   - **Package manager** (Homebrew, winget, apk, etc.): Print the appropriate update command for the user to run manually (`src/cli/update.ts:118-166`)
   - **Native**: Use `installLatestNative()` with lock contention handling (`src/cli/update.ts:214-258`)
   - **npm-local / npm-global**: Use `installOrUpdateClaudePackage()` or `installGlobalPackage()` respectively (`src/cli/update.ts:321-369`)
5. Handle result statuses: `success`, `no_permissions`, `install_failed`, `in_progress` (`src/cli/update.ts:373-420`)

### Shared Utilities (`util.tsx`)

- **`setupTokenHandler`** (`src/cli/handlers/util.tsx:20-49`): Renders the `ConsoleOAuthFlow` component within an Ink React tree to guide the user through long-lived (1-year) auth token setup.
- **`doctorHandler`** (`src/cli/handlers/util.tsx:72-87`): Renders the `Doctor` screen component with MCP connection management and plugin support.
- **`installHandler`** (`src/cli/handlers/util.tsx:90-109`): Delegates to the `install` command module after running setup, passing through target and `--force` options.

## Function Signatures

### `installOAuthTokens(tokens: OAuthTokens): Promise<void>`

Shared post-token-acquisition logic. Saves tokens, fetches profile/roles, creates API keys for Console users.

> `src/cli/handlers/auth.ts:50-110`

### `authLogin(opts: { email?, sso?, console?, claudeai? }): Promise<void>`

Main login entry point. Supports browser OAuth flow, SSO, Console vs claude.ai selection, and env-var refresh token shortcut.

> `src/cli/handlers/auth.ts:112-230`

### `authStatus(opts: { json?, text? }): Promise<void>`

Prints authentication status. Exits with code 0 if logged in, 1 if not.

> `src/cli/handlers/auth.ts:232-319`

### `authLogout(): Promise<void>`

Clears auth state and prints confirmation.

> `src/cli/handlers/auth.ts:321-330`

### `mcpAddJsonHandler(name, json, opts: { scope?, clientSecret? }): Promise<void>`

Adds an MCP server from a raw JSON config string. Supports optional `--client-secret` flag for OAuth-enabled SSE/HTTP servers.

> `src/cli/handlers/mcp.tsx:286-316`

### `mcpRemoveHandler(name, opts: { scope? }): Promise<void>`

Removes an MCP server. Scope-aware: if the server exists in multiple scopes, requires explicit `--scope`.

> `src/cli/handlers/mcp.tsx:74-141`

### `mcpListHandler(): Promise<void>`

Lists all MCP servers with concurrent health checks.

> `src/cli/handlers/mcp.tsx:144-190`

### `update(): Promise<void>`

Performs CLI self-update with installation-type auto-detection and multi-method support.

> `src/cli/update.ts:30-422`

### `agentsHandler(): Promise<void>`

Prints grouped, sorted list of active/shadowed agents.

> `src/cli/handlers/agents.ts:32-70`

### `autoModeCritiqueHandler(opts: { model? }): Promise<void>`

AI-powered critique of custom auto-mode classifier rules.

> `src/cli/handlers/autoMode.ts:73-149`

## Configuration & Defaults

- **`CLAUDE_CODE_OAUTH_REFRESH_TOKEN`**: Env var for non-interactive login. Requires `CLAUDE_CODE_OAUTH_SCOPES` to also be set.
- **`autoUpdatesChannel`**: Settings field controlling update channel (`latest` or `stable`). Defaults to `latest`.
- **`forceLoginMethod`**: Managed setting that overrides CLI login flags — either `"claudeai"` or `"console"`.
- **`forceLoginOrgUUID`**: Managed setting constraining which organization the user must belong to after login.
- **Plugin scopes**: `user`, `project`, `local` — controls where plugin state is persisted. `--cowork` always forces `user` scope.
- **MCP config scopes**: `user` (global config), `project` (`.mcp.json`), `local` (project config) — servers can exist in multiple scopes simultaneously.

## Edge Cases & Caveats

- **Multiple MCP scopes**: When removing an MCP server that exists in multiple scopes without specifying `--scope`, the handler errors and lists the scopes rather than guessing which one to remove (`src/cli/handlers/mcp.tsx:126-137`).
- **Lock contention on native update**: If another Claude process holds the native installer lock, the update exits gracefully with a retry message instead of failing hard (`src/cli/update.ts:222-232`).
- **Package manager updates are manual**: For Homebrew/winget/apk/pacman/deb/rpm installations, the update handler only prints instructions rather than running the package manager command directly (`src/cli/update.ts:118-166`).
- **Inline plugin errors**: Session-only plugins loaded via `--plugin-dir` can fail at two levels — path-level (directory doesn't exist) and plugin-level (manifest parse error). Both are tracked separately to avoid silent failures (`src/cli/handlers/plugins.ts:184-193`).
- **Plugin dirName vs manifestName divergence**: When a dev checkout directory name differs from the plugin manifest name, error correlation uses both `e.source` and `e.plugin` fields to match errors to the correct plugin (`src/cli/handlers/plugins.ts:258-269`).
- **Auto-mode REPLACE semantics**: Custom auto-mode rules replace entire sections of defaults — they don't merge with defaults. An empty user section falls through to defaults (`src/cli/handlers/autoMode.ts:28-47`).
- **Auth status exit code**: `authStatus` exits with code 1 when not logged in, making it usable in shell scripts for conditional logic (`src/cli/handlers/auth.ts:318`).