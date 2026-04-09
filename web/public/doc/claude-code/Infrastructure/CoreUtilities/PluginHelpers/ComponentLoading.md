# Component Loading

## Overview & Responsibilities

The Component Loading module is the extension-point registration layer within the Plugin Helpers subsystem of Infrastructure → CoreUtilities. It bridges the gap between plugin packages on disk and the running application session by loading, parsing, and registering all plugin-provided extension points: slash commands, AI agents, event hooks, output styles, MCP servers, and LSP servers.

This module sits downstream of the plugin loader (`pluginLoader.ts`, which discovers and validates installed plugins) and upstream of the systems that consume extension points (the command registry, agent tool, hook execution engine, MCP client, and LSP client). Its nine files share a common pattern: iterate over enabled plugins, walk their directories for markdown or JSON configuration, parse frontmatter/schemas, perform variable substitution, and register the results—all with memoized caching and parallel processing.

**Sibling context**: Within PluginHelpers, this module works alongside plugin discovery, installation, dependency resolution, and cache management modules. The ComponentLoading files are specifically responsible for the "load into session" phase of the plugin lifecycle.

## Key Processes

### Shared Directory Walker (`walkPluginMarkdown`)

All markdown-based loaders (commands, agents, output styles) share `walkPluginMarkdown` (`src/utils/plugins/walkPluginMarkdown.ts:21-69`), a recursive directory scanner that:

1. Reads a root directory using the injectable `getFsImplementation()`
2. Invokes an `onFile` callback for each `.md` file found, passing the full path and a namespace array tracking subdirectory depth (e.g., `['foo', 'bar']` for `root/foo/bar/file.md`)
3. When `stopAtSkillDir` is true, treats directories containing `SKILL.md` as leaf containers—it processes all `.md` files in that directory but does not recurse into subdirectories
4. Swallows readdir errors with a debug log so one bad directory doesn't abort the entire plugin load

### Slash Command Loading

`loadPluginCommands.ts` (~946 lines) provides two memoized entry points: `getPluginCommands()` and `getPluginSkills()`.

**Command loading flow** (`getPluginCommands`):

1. Calls `loadAllPluginsCacheOnly()` to get the list of enabled plugins
2. For each plugin, processes three command sources in parallel:
   - **Default commands directory** (`plugin.commandsPath`) — walks for `.md` files via `collectMarkdownFiles` → `walkPluginMarkdown`
   - **Additional paths** (`plugin.commandsPaths`) — handles both directories and individual `.md` files, with support for `commandsMetadata` overrides from the manifest
   - **Inline content** (`plugin.commandsMetadata` entries with `content` but no `source`) — parses inline markdown directly
3. Each markdown file goes through `createPluginCommand` (`src/utils/plugins/loadPluginCommands.ts:218-412`), which:
   - Parses frontmatter for `description`, `allowed-tools`, `argument-hint`, `arguments`, `when_to_use`, `model`, `effort`, `shell`, `user-invocable`, and `disable-model-invocation`
   - Substitutes `${CLAUDE_PLUGIN_ROOT}` in allowed-tools
   - Returns a `Command` object with a `getPromptForCommand` closure that performs runtime substitution of `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`, and `${user_config.X}` variables, then executes any embedded shell commands

**Skill loading flow** (`getPluginSkills`):

Skills are special commands defined by `SKILL.md` files in subdirectories. `loadSkillsFromDirectory` (`src/utils/plugins/loadPluginCommands.ts:687-838`) first checks if the path itself contains a `SKILL.md`, then scans subdirectories (including symlinks) for `SKILL.md` files. Skills get `isSkillMode: true`, which prepends the base directory path to the prompt content and enables `${CLAUDE_SKILL_DIR}` substitution.

**Command naming**: Commands are namespaced as `pluginName:namespace:commandName`, where `namespace` is derived from subdirectory structure. For skills, the parent directory name becomes the command name.

### Agent Loading

`loadPluginAgents.ts` loads AI agent definitions from plugin markdown files. The flow mirrors command loading:

1. `loadPluginAgents()` (memoized) iterates enabled plugins
2. `loadAgentsFromDirectory` walks the `agentsPath` using `walkPluginMarkdown`
3. `loadAgentFromFile` (`src/utils/plugins/loadPluginAgents.ts:65-229`) parses frontmatter for:
   - `description` / `when-to-use` — when the agent should be invoked
   - `tools`, `disallowedTools`, `skills` — capability restrictions
   - `color`, `model`, `background`, `memory` (user/project/local scope), `isolation` (worktree), `effort`, `maxTurns`
4. Performs `${CLAUDE_PLUGIN_ROOT}` and `${user_config.X}` substitution on the system prompt
5. When `memory` is set and auto-memory is enabled, injects `Write`, `Edit`, and `Read` tools for memory access

**Security boundary**: `permissionMode`, `hooks`, and `mcpServers` frontmatter fields are intentionally **ignored** for plugin agents (logged as warnings). These fields could escalate permissions beyond what was approved at install time. Users who need this level of control should define agents in `.claude/agents/` instead (`src/utils/plugins/loadPluginAgents.ts:153-168`).

### Hook Registration

`loadPluginHooks.ts` registers plugin-provided event-driven callbacks into the application's hook system.

**Registration flow** (`loadPluginHooks`, `src/utils/plugins/loadPluginHooks.ts:91-157`):

1. Loads enabled plugins
2. For each plugin with `hooksConfig`, calls `convertPluginHooksToMatchers` which maps hook events to `PluginHookMatcher` objects containing the matcher, hooks array, and plugin context (`pluginRoot`, `pluginName`, `pluginId`)
3. Performs an **atomic clear-then-register**: calls `clearRegisteredPluginHooks()` then `registerHookCallbacks()` as a pair, ensuring old hooks stay valid until new ones take over

The module supports **28 hook events** including `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `FileChanged`, `CwdChanged`, and more.

**Hot reload** (`setupPluginHookHotReload`, `src/utils/plugins/loadPluginHooks.ts:255-287`): Subscribes to `settingsChangeDetector` for `policySettings` changes. Compares a snapshot of four settings fields (`enabledPlugins`, `extraKnownMarketplaces`, `strictKnownMarketplaces`, `blockedMarketplaces`) and reloads hooks only when plugin-affecting settings actually changed.

**Pruning** (`pruneRemovedPluginHooks`, `src/utils/plugins/loadPluginHooks.ts:179-207`): Removes hooks from plugins no longer in the enabled set without adding hooks from newly-enabled plugins. Called from `clearAllCaches()` so uninstalled plugins stop firing hooks immediately.

### Output Style Loading

`loadPluginOutputStyles.ts` loads output style configurations from plugin markdown. Each `.md` file produces an `OutputStyleConfig` with:

- `name` — namespaced as `pluginName:styleName`
- `description` — from frontmatter or extracted from markdown content
- `prompt` — the trimmed markdown content
- `forceForPlugin` — boolean flag from `force-for-plugin` frontmatter, allowing plugins to force their output style

The loader follows the same pattern as commands: walks default directory, then additional paths from manifest, with duplicate detection via `loadedPaths` sets.

### MCP Server Integration

`mcpPluginIntegration.ts` (~635 lines) loads MCP (Model Context Protocol) server configurations from plugins, handling multiple configuration sources and formats.

**Loading flow** (`loadPluginMcpServers`, `src/utils/plugins/mcpPluginIntegration.ts:131-212`):

1. Checks for `.mcp.json` in the plugin directory (lowest priority)
2. Processes `manifest.mcpServers` which can be:
   - A **string** — either an MCPB file path (`.mcpb`/`.dxt`) or a JSON file path
   - An **array** of strings or inline configs (loaded in parallel, merged in order for last-wins semantics)
   - A **direct object** — inline MCP server configurations
3. Each config is validated against `McpServerConfigSchema`

**Environment resolution** (`resolvePluginMcpEnvironment`, `src/utils/plugins/mcpPluginIntegration.ts:465-582`):

For each server config, resolves variables in three phases:
1. `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` substitution
2. `${user_config.X}` substitution from saved plugin options (non-sensitive values for prompts, sensitive values from secure storage)
3. General `${VAR}` environment variable expansion

Handles all server types: `stdio` (command, args, env), `sse`/`http`/`ws` (url, headers), and pass-through types (`sse-ide`, `ws-ide`, `sdk`, `claudeai-proxy`).

**Scoping** (`addPluginScopeToServers`): Prefixes server names as `plugin:pluginName:serverName` to prevent conflicts between plugins. All plugin servers use `scope: 'dynamic'`.

**Channel configuration** (`getUnconfiguredChannels`, `src/utils/plugins/mcpPluginIntegration.ts:290-318`): Checks manifest `channels` for entries whose `userConfig` schema has unsatisfied required fields. Returns the list for the UI to prompt the user.

### MCPB Protocol Handler

`mcpbHandler.ts` (~968 lines) handles the MCPB/DXT package format—zip archives containing a DXT manifest and MCP server implementation.

**Core flow** (`loadMcpbFile`, `src/utils/plugins/mcpbHandler.ts:698-968`):

1. **Cache check**: Looks for existing cache metadata; if cached and unchanged, loads manifest from cache and skips download/extraction
2. **Acquisition**: Downloads from URL (with progress callbacks and telemetry) or reads from local path
3. **Extraction**: Unzips the archive, preserving file permissions (exec bits for native binaries), creates directory structure
4. **Manifest validation**: Parses `manifest.json` from the archive using `parseAndValidateManifestFromBytes`
5. **User configuration**: If the manifest declares `user_config`, validates saved values against the schema. Returns `McpbNeedsConfigResult` if required fields are missing, allowing the UI to prompt the user
6. **MCP config generation**: Calls `getMcpConfigForManifest` from `@anthropic-ai/mcpb` to convert the DXT manifest into an `McpServerConfig`

**User config persistence** (`saveMcpServerUserConfig`, `src/utils/plugins/mcpbHandler.ts:193-341`):

Splits values by `schema[key].sensitive`:
- **Sensitive** (`sensitive: true`) → secure storage (macOS Keychain, `.credentials.json` 0600 elsewhere)
- **Non-sensitive** → `settings.json` under `pluginConfigs[pluginId].mcpServers[serverName]`

Performs cross-store scrubbing: when a key moves between sensitive/non-sensitive (schema update), removes the stale copy from the other store.

**Caching**: Uses content-hash-based cache directories under `pluginPath/.mcpb-cache/`. For local files, detects changes via mtime comparison. For URLs, re-checks only on explicit update.

### LSP Server Integration

`lspPluginIntegration.ts` loads LSP (Language Server Protocol) server configurations from plugins, following a pattern similar to MCP integration.

**Loading** (`loadPluginLspServers`, `src/utils/plugins/lspPluginIntegration.ts:57-122`):
1. Checks for `.lsp.json` in the plugin directory
2. Processes `manifest.lspServers` — supports string paths (with path traversal validation), inline configs, and arrays

**Security**: `validatePathWithinPlugin` (`src/utils/plugins/lspPluginIntegration.ts:28-45`) blocks path traversal attacks (`..'` or absolute paths) when loading from string paths in the manifest.

**Environment resolution**: Same three-phase pattern as MCP: plugin variables → user config → general env vars. Additionally resolves `workspaceFolder` if present.

**Scoping**: Server names are prefixed as `plugin:pluginName:serverName` with `scope: 'dynamic'`.

### LSP Plugin Recommendation

`lspRecommendation.ts` recommends LSP plugins based on file extensions. Given a file path, it:

1. Extracts the file extension
2. Scans all installed marketplaces for plugins with `lspServers` declarations
3. Extracts extension-to-language mappings from inline config (cannot read `.lsp.json` from marketplace entries)
4. Filters to plugins where:
   - The extension matches
   - The LSP binary is installed on the system (`isBinaryInstalled`)
   - The plugin is not already installed
   - The plugin is not in the user's "never suggest" list
5. Sorts results with official marketplace plugins first

**Rate limiting**: After the user ignores 5 recommendations (`MAX_IGNORED_COUNT`), recommendations are automatically disabled. Users can also explicitly disable via config or add specific plugins to a "never suggest" list.

## Function Signatures

### Commands

| Function | Signature | Description |
|----------|-----------|-------------|
| `getPluginCommands` | `() => Promise<Command[]>` | Memoized. Returns all slash commands from enabled plugins |
| `getPluginSkills` | `() => Promise<Command[]>` | Memoized. Returns all skills (SKILL.md-based commands) from enabled plugins |
| `clearPluginCommandCache` | `() => void` | Clears the memoized command cache |
| `clearPluginSkillsCache` | `() => void` | Clears the memoized skills cache |

### Agents

| Function | Signature | Description |
|----------|-----------|-------------|
| `loadPluginAgents` | `() => Promise<AgentDefinition[]>` | Memoized. Returns all agent definitions from enabled plugins |
| `clearPluginAgentCache` | `() => void` | Clears the memoized agent cache |

### Hooks

| Function | Signature | Description |
|----------|-----------|-------------|
| `loadPluginHooks` | `() => Promise<void>` | Memoized. Loads and registers hooks from all enabled plugins |
| `clearPluginHookCache` | `() => void` | Invalidates the memoize without wiping registered hooks |
| `pruneRemovedPluginHooks` | `() => Promise<void>` | Removes hooks from disabled/uninstalled plugins |
| `setupPluginHookHotReload` | `() => void` | Subscribes to settings changes for automatic hook reload |

### Output Styles

| Function | Signature | Description |
|----------|-----------|-------------|
| `loadPluginOutputStyles` | `() => Promise<OutputStyleConfig[]>` | Memoized. Returns all output style configs from enabled plugins |
| `clearPluginOutputStyleCache` | `() => void` | Clears the memoized output style cache |

### MCP Integration

| Function | Signature | Description |
|----------|-----------|-------------|
| `loadPluginMcpServers` | `(plugin, errors?) => Promise<Record<string, McpServerConfig> \| undefined>` | Loads MCP servers from a single plugin |
| `extractMcpServersFromPlugins` | `(plugins, errors?) => Promise<Record<string, ScopedMcpServerConfig>>` | Extracts and scopes MCP servers from all plugins |
| `getPluginMcpServers` | `(plugin, errors?) => Promise<Record<string, ScopedMcpServerConfig> \| undefined>` | Gets resolved and scoped MCP servers for a single plugin |
| `resolvePluginMcpEnvironment` | `(config, plugin, userConfig?, errors?) => McpServerConfig` | Resolves env vars in an MCP server config |
| `getUnconfiguredChannels` | `(plugin) => UnconfiguredChannel[]` | Finds channels needing user configuration |

### MCPB Handler

| Function | Signature | Description |
|----------|-----------|-------------|
| `loadMcpbFile` | `(source, pluginPath, pluginId, onProgress?, userConfig?, forceConfigDialog?) => Promise<McpbLoadResult \| McpbNeedsConfigResult>` | Loads, caches, and extracts an MCPB/DXT archive |
| `isMcpbSource` | `(source: string) => boolean` | Checks if a string is an `.mcpb` or `.dxt` file reference |
| `validateUserConfig` | `(values, schema) => { valid, errors }` | Validates user config values against a DXT schema |
| `saveMcpServerUserConfig` | `(pluginId, serverName, config, schema) => void` | Saves user config with sensitive/non-sensitive split |
| `loadMcpServerUserConfig` | `(pluginId, serverName) => UserConfigValues \| null` | Loads merged user config from settings + secure storage |

### LSP Integration

| Function | Signature | Description |
|----------|-----------|-------------|
| `loadPluginLspServers` | `(plugin, errors?) => Promise<Record<string, LspServerConfig> \| undefined>` | Loads LSP servers from a single plugin |
| `extractLspServersFromPlugins` | `(plugins, errors?) => Promise<Record<string, ScopedLspServerConfig>>` | Extracts and scopes LSP servers from all plugins |
| `getPluginLspServers` | `(plugin, errors?) => Promise<Record<string, ScopedLspServerConfig> \| undefined>` | Gets resolved and scoped LSP servers for a single plugin |

### LSP Recommendation

| Function | Signature | Description |
|----------|-----------|-------------|
| `getMatchingLspPlugins` | `(filePath: string) => Promise<LspPluginRecommendation[]>` | Finds LSP plugins matching a file's extension |
| `addToNeverSuggest` | `(pluginId: string) => void` | Adds a plugin to the "never suggest" list |
| `incrementIgnoredCount` | `() => void` | Tracks ignored recommendations; disables after 5 |
| `isLspRecommendationsDisabled` | `() => boolean` | Checks if recommendations are disabled |

## Key Type Definitions

### `McpbLoadResult`
Returned on successful MCPB loading:
- `manifest: McpbManifest` — parsed DXT manifest
- `mcpConfig: McpServerConfig` — generated MCP server configuration
- `extractedPath: string` — filesystem path where archive was extracted
- `contentHash: string` — SHA-256 hash (first 16 chars) of the archive

### `McpbNeedsConfigResult`
Returned when MCPB requires user configuration:
- `status: 'needs-config'`
- `configSchema: UserConfigSchema` — field definitions for the config dialog
- `existingConfig: UserConfigValues` — previously saved values
- `validationErrors: string[]` — which required fields are missing

### `LspPluginRecommendation`
- `pluginId: string` — in `"plugin-name@marketplace-name"` format
- `extensions: string[]` — file extensions this plugin supports
- `command: string` — LSP server binary name (e.g., `"typescript-language-server"`)
- `isOfficial: boolean` — from an official Anthropic marketplace

### `UnconfiguredChannel`
- `server: string` — MCP server name
- `displayName: string` — human-readable name for the config dialog
- `configSchema: UserConfigSchema` — fields to prompt the user for

## Configuration & Defaults

| Setting | Source | Description |
|---------|--------|-------------|
| `enabledPlugins` | Settings (merged) | Which plugins are active |
| `extraKnownMarketplaces` | Settings (merged) | Additional marketplace sources |
| `strictKnownMarketplaces` | Policy settings | Restrict to specific marketplaces |
| `blockedMarketplaces` | Policy settings | Block specific marketplaces |
| `pluginConfigs[id].mcpServers[server]` | User settings | Non-sensitive MCP user config values |
| `pluginSecrets[id/server]` | Secure storage | Sensitive MCP user config values |
| `lspRecommendationDisabled` | Global config | Disable LSP recommendations |
| `lspRecommendationIgnoredCount` | Global config | Auto-disables after 5 ignores |
| `lspRecommendationNeverPlugins` | Global config | Per-plugin "never suggest" list |

**Variable substitution** available in plugin content:
- `${CLAUDE_PLUGIN_ROOT}` — plugin installation directory
- `${CLAUDE_PLUGIN_DATA}` — plugin data directory
- `${CLAUDE_SKILL_DIR}` — individual skill's subdirectory (skills only)
- `${CLAUDE_SESSION_ID}` — current session identifier
- `${user_config.X}` — user-configured plugin option values

## Edge Cases & Caveats

- **Bare mode** (`--bare`): Commands and skills skip marketplace plugin auto-loading. Explicit `--plugin-dir` still works via `getInlinePlugins()`.

- **Atomic hook swap**: Plugin hooks use an atomic clear-then-register pattern. The previous approach of clearing in `clearPluginHookCache()` caused hooks (especially `Stop` hooks) to silently stop firing after any plugin management operation (gh-29767).

- **Plugin agent security restrictions**: `permissionMode`, `hooks`, and `mcpServers` frontmatter fields are silently ignored for plugin-defined agents. This is a deliberate security boundary — plugins are third-party code and these fields could escalate privileges beyond install-time approval.

- **Sensitive config storage**: MCPB user config values marked `sensitive: true` are stored in secure storage (macOS Keychain), not `settings.json`. Cross-store scrubbing handles schema version changes where a field's sensitivity classification changes.

- **MCPB exec bit preservation**: The MCPB extractor parses zip central directory entries to preserve executable permissions on native MCP server binaries. `chmod` failures (NFS, FUSE mounts) are silently swallowed.

- **LSP path traversal protection**: String paths in LSP manifest declarations are validated to stay within the plugin directory. Path traversal attempts (e.g., `../../etc/passwd`) are blocked and logged.

- **LSP recommendation limitations**: Can only detect LSP plugins with inline `lspServers` configs in marketplace entries. Plugins using separate `.lsp.json` files are not discoverable until after installation.

- **Hot reload race condition handling**: `pruneRemovedPluginHooks` re-reads `getRegisteredHooks()` after an `await` because a concurrent `loadPluginHooks()` hot-reload could have swapped the hooks during the gap.

- **Per-server error isolation**: In `extractMcpServersFromPlugins` and `getPluginMcpServers`, environment resolution is wrapped in per-server try/catch blocks. This prevents one misconfigured server (e.g., a channel with a missing required field after a plugin update) from crashing the entire plugin MCP loading via `Promise.all`.