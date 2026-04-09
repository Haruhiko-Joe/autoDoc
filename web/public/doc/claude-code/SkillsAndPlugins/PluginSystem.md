# Plugin System

## Overview & Responsibilities

The Plugin System is the lifecycle management layer for Claude Code's extensibility framework, sitting within the **SkillsAndPlugins** module alongside the Skills system. While Skills provide prompt-driven capabilities, Plugins offer deeper integration points with hooks, MCP servers, and marketplace-based distribution.

This module handles five concerns:

1. **Built-in plugin registry** — manages plugins that ship with the CLI and can be toggled by users
2. **Plugin operations** — pure library functions for install, uninstall, enable, disable, and update
3. **CLI command wrappers** — adds console output, telemetry, and process exit handling around operations
4. **Background installation manager** — reconciles marketplace state at startup, auto-refreshes plugins
5. **Bundled plugin initialization** — the bootstrap entry point for registering built-in plugins

## Key Processes

### Plugin Installation Flow

The install operation (`installPluginOp`) follows a **settings-first** strategy:

1. Parse the plugin identifier (bare name or `name@marketplace` format) via `parsePluginIdentifier()`
2. Search materialized marketplaces for the plugin entry — if a marketplace is specified, query it directly; otherwise iterate all known marketplaces (`src/services/plugins/pluginOperations.ts:335-359`)
3. If not found, return a "not found" error — marketplace reconciliation is NOT this function's responsibility
4. Call `installResolvedPlugin()` which writes settings (declares intent), then caches the plugin and records the version hint
5. Handle failure reasons: `local-source-no-location`, `settings-write-failed`, `resolution-failed`, `blocked-by-policy`, `dependency-blocked-by-policy` (`src/services/plugins/pluginOperations.ts:382-408`)
6. Return a `PluginOperationResult` with the `pluginId`, scope, and success message

### Plugin Enable/Disable Flow

The `setPluginEnabledOp()` function (`src/services/plugins/pluginOperations.ts:573-747`) handles both enable and disable:

1. **Built-in plugins** get special treatment — they always use user-scope settings and bypass normal scope resolution (`src/services/plugins/pluginOperations.ts:582-604`)
2. **Scope resolution**: if an explicit scope is provided, use it; otherwise auto-detect the most specific scope where the plugin appears in settings via `findPluginInSettings()`. Search order is `local > project > user` (most specific wins) (`src/services/plugins/pluginOperations.ts:186`)
3. **Policy guard**: org-blocked plugins cannot be enabled at any scope (`src/services/plugins/pluginOperations.ts:653-658`)
4. **Cross-scope hint**: if the plugin exists at a different scope than requested, guide the user — unless they're writing to a higher-precedence scope to create an override (e.g., `disable --scope local` to override a project-enabled plugin) (`src/services/plugins/pluginOperations.ts:670-688`)
5. **Idempotency check**: if already in the desired state, return an informational failure
6. **Reverse dependency warning** (disable only): capture plugins that depend on this one before writing settings (`src/services/plugins/pluginOperations.ts:712-719`)
7. Write settings and clear all caches

### Plugin Uninstall Flow

The `uninstallPluginOp()` function (`src/services/plugins/pluginOperations.ts:427-558`) removes a plugin:

1. Load all plugins (enabled + disabled), find the target by identifier
2. If not found via marketplace lookup, fall back to `installed_plugins_v2.json` for delisted plugins (`src/services/plugins/pluginOperations.ts:462-471`)
3. Verify the plugin is installed at the requested scope; provide helpful cross-scope hints if not (e.g., project-scope plugins suggest the local-override escape hatch)
4. Remove from settings (set key to `undefined` for deletion)
5. Clear all caches and remove from `installed_plugins_v2.json`
6. If this was the last scope: mark the version as orphaned, delete stored options/secrets, and optionally delete the data directory
7. Warn (don't block) about reverse dependents

### Plugin Update Flow

The `updatePluginOp()` function (`src/services/plugins/pluginOperations.ts:829-890`) performs a **non-inplace update**:

1. Look up plugin info from the marketplace
2. Find the installation for the requested scope from disk data
3. Delegate to `performPluginUpdate()` which handles remote vs local plugins:
   - **Remote plugins**: download to temp dir via `cachePlugin()`, capture git commit SHA, calculate version (`src/services/plugins/pluginOperations.ts:924-942`)
   - **Local plugins**: resolve path from marketplace install location, verify it exists, load manifest if available (`src/services/plugins/pluginOperations.ts:944-1008`)
4. If the version matches the current installation, report already up-to-date
5. Copy to a new versioned cache directory via `copyPluginToVersionedCache()`
6. Update the disk JSON file (memory stays unchanged until restart)
7. If the old version path is no longer referenced by any installation, mark it orphaned
8. Clean up temp source directory in a `finally` block

### Background Marketplace Reconciliation

At startup, `performBackgroundPluginInstallations()` (`src/services/plugins/PluginInstallationManager.ts:60-184`) runs without blocking the REPL:

1. Compute the diff between declared marketplaces and materialized (on-disk) ones via `diffMarketplaces()` (`src/services/plugins/PluginInstallationManager.ts:67-69`)
2. Initialize AppState with pending status for missing/changed marketplaces
3. Call `reconcileMarketplaces()` with an `onProgress` callback that maps `installing`/`installed`/`failed` events to AppState updates (`src/services/plugins/PluginInstallationManager.ts:101-120`)
4. Log telemetry metrics (installed, updated, failed, up-to-date counts)
5. **New installs** → auto-refresh plugins via `refreshActivePlugins()`, which clears caches, reloads plugins, and bumps `pluginReconnectKey` for MCP reconnection. Falls back to `needsRefresh` notification on failure (`src/services/plugins/PluginInstallationManager.ts:135-165`)
6. **Updates only** → set `needsRefresh` flag, prompting the user to run `/reload-plugins` (`src/services/plugins/PluginInstallationManager.ts:166-180`)

### Built-in Plugin Registry

Built-in plugins are registered at startup via `initBuiltinPlugins()` → `registerBuiltinPlugin()` and stored in a module-level `Map<string, BuiltinPluginDefinition>` (`src/plugins/builtinPlugins.ts:21`).

The `getBuiltinPlugins()` function (`src/plugins/builtinPlugins.ts:57-102`) resolves enabled/disabled state:
- Plugins whose `isAvailable()` returns false are omitted entirely
- Plugin IDs use the format `{name}@builtin`
- Enabled state: user preference (`settings.enabledPlugins[pluginId]`) > plugin default (`defaultEnabled`) > `true`

`getBuiltinPluginSkillCommands()` converts skill definitions from enabled built-in plugins into `Command` objects via `skillDefinitionToCommand()` (`src/plugins/builtinPlugins.ts:132-159`). These commands use `source: 'bundled'` (not `'builtin'`) to keep them in the Skill tool's listing and prompt-truncation exemption.

## Function Signatures

### Plugin Operations (`pluginOperations.ts`)

#### `installPluginOp(plugin: string, scope?: InstallableScope): Promise<PluginOperationResult>`
Installs a plugin by searching marketplaces, writing settings, and caching. Scope defaults to `'user'`.

#### `uninstallPluginOp(plugin: string, scope?: InstallableScope, deleteDataDir?: boolean): Promise<PluginOperationResult>`
Uninstalls a plugin from the specified scope. Handles delisted plugins and cross-scope guidance.

#### `enablePluginOp(plugin: string, scope?: InstallableScope): Promise<PluginOperationResult>`
Enables a plugin. Delegates to `setPluginEnabledOp(plugin, true, scope)`.

#### `disablePluginOp(plugin: string, scope?: InstallableScope): Promise<PluginOperationResult>`
Disables a plugin. Delegates to `setPluginEnabledOp(plugin, false, scope)`.

#### `disableAllPluginsOp(): Promise<PluginOperationResult>`
Disables all enabled plugins across editable scopes. Returns count of disabled plugins.

#### `updatePluginOp(plugin: string, scope: PluginScope): Promise<PluginUpdateResult>`
Updates a plugin to the latest version. Supports `'managed'` scope unlike install/uninstall.

### CLI Commands (`pluginCliCommands.ts`)

Each function wraps the corresponding operation with:
- Console output (progress messages, success/failure with `figures.tick`/`figures.cross`)
- Telemetry events (`tengu_plugin_installed_cli`, `tengu_plugin_uninstalled_cli`, etc.) with PII-tagged plugin/marketplace names
- `process.exit(0)` on success, `process.exit(1)` on failure

| Function | Operation | Telemetry Event |
|----------|-----------|----------------|
| `installPlugin(plugin, scope?)` | `installPluginOp` | `tengu_plugin_installed_cli` |
| `uninstallPlugin(plugin, scope?, keepData?)` | `uninstallPluginOp` | `tengu_plugin_uninstalled_cli` |
| `enablePlugin(plugin, scope?)` | `enablePluginOp` | `tengu_plugin_enabled_cli` |
| `disablePlugin(plugin, scope?)` | `disablePluginOp` | `tengu_plugin_disabled_cli` |
| `disableAllPlugins()` | `disableAllPluginsOp` | `tengu_plugin_disabled_all_cli` |
| `updatePluginCli(plugin, scope)` | `updatePluginOp` | `tengu_plugin_updated_cli` |

### Built-in Plugin Registry (`builtinPlugins.ts`)

| Function | Description |
|----------|-------------|
| `registerBuiltinPlugin(definition)` | Registers a built-in plugin at startup |
| `isBuiltinPluginId(pluginId)` | Returns `true` if the ID ends with `@builtin` |
| `getBuiltinPluginDefinition(name)` | Looks up a definition by name |
| `getBuiltinPlugins()` | Returns `{ enabled, disabled }` `LoadedPlugin[]` arrays |
| `getBuiltinPluginSkillCommands()` | Returns `Command[]` from enabled built-in plugin skills |

## Type Definitions

### `PluginOperationResult`

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the operation succeeded |
| `message` | `string` | Human-readable result message |
| `pluginId?` | `string` | Resolved plugin ID (e.g., `name@marketplace`) |
| `pluginName?` | `string` | Plugin display name |
| `scope?` | `PluginScope` | Scope the operation acted on |
| `reverseDependents?` | `string[]` | Plugins that depend on this one (warning on uninstall/disable) |

### `PluginUpdateResult`

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the update succeeded |
| `message` | `string` | Human-readable result message |
| `pluginId?` | `string` | Resolved plugin ID |
| `newVersion?` | `string` | Version after update |
| `oldVersion?` | `string` | Version before update |
| `alreadyUpToDate?` | `boolean` | `true` if no update was needed |
| `scope?` | `PluginScope` | Scope the update applied to |

### `InstallableScope`

Union type: `'user' | 'project' | 'local'` — excludes `'managed'` which can only be installed from `managed-settings.json`.

### Scope Precedence

Scopes are ordered by specificity: `user (0) < project (1) < local (2)`. A higher-precedence scope overrides a lower one (e.g., `local` disable overrides `project` enable).

## Configuration & Defaults

- **Plugin identifiers**: `{name}@{marketplace}` format. Built-in plugins use `{name}@builtin`.
- **Settings storage**: Plugin enabled/disabled state is stored in `enabledPlugins` within the appropriate settings source (`userSettings`, `projectSettings`, or local).
- **Built-in plugin defaults**: `defaultEnabled ?? true` — built-in plugins are enabled by default unless explicitly configured otherwise.
- **Installation scopes**: `user` (global), `project` (shared via `.claude/settings.json`), `local` (per-user per-project override). `managed` scope is read-only for install but writable for update.
- **Marketplace status tracking**: AppState tracks per-marketplace status as `'pending' | 'installing' | 'installed' | 'failed'`.

## Edge Cases & Caveats

- **Delisted plugins**: If a plugin has been removed from its marketplace, uninstall falls back to `installed_plugins_v2.json` to locate it (`src/services/plugins/pluginOperations.ts:462-471`). This prevents tombstone situations where users can't remove plugins that no longer exist in the marketplace.

- **Project-scope uninstall guidance**: When a plugin is installed at project scope (shared `.claude/settings.json`), the error message suggests using `--scope local` to disable just for the current user, rather than modifying the shared config (`src/services/plugins/pluginOperations.ts:487-491`).

- **Reverse dependency warnings**: Uninstall and disable operations warn (but don't block) when other enabled plugins depend on the target. Blocking would create tombstones with delisted plugins; load-time `verifyAndDemote` catches the fallout instead (`src/services/plugins/pluginOperations.ts:543-545`).

- **Non-inplace updates**: Plugin updates install to a new versioned cache directory rather than overwriting in place. The old version is marked orphaned only if no other installation references it. Changes don't take effect until restart (`src/services/plugins/pluginOperations.ts:1069`).

- **Background install auto-refresh vs notification**: New marketplace installations trigger automatic plugin refresh (fixes "plugin-not-found" errors on fresh setups). Marketplace updates only set a `needsRefresh` flag, letting the user choose when to apply via `/reload-plugins` (`src/services/plugins/PluginInstallationManager.ts:135-180`).

- **`source: 'bundled'` vs `'builtin'`**: Built-in plugin skills use `source: 'bundled'` in their Command objects, not `'builtin'`. In the Command system, `'builtin'` means hardcoded slash commands (`/help`, `/clear`). Using `'bundled'` keeps these skills in the Skill tool's listing and prompt-truncation exemption (`src/plugins/builtinPlugins.ts:146-148`).

- **CLI commands exit the process**: All `pluginCliCommands.ts` functions call `process.exit()` — they are designed for non-interactive `claude plugin <action>` invocations, not for use within the REPL. The REPL uses `pluginOperations.ts` functions directly.

- **Failed telemetry includes error classification**: The `handlePluginCommandError` function classifies errors via `classifyPluginCommandError()` and logs them as `tengu_plugin_command_failed` with the error category, enabling success rate dashboards (`src/services/plugins/pluginCliCommands.ts:86-93`).

- **No built-in plugins registered yet**: The `initBuiltinPlugins()` function in `src/plugins/bundled/index.ts` is currently empty scaffolding for future migration of bundled skills that should be user-toggleable.