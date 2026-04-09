# Plugins

## Overview & Responsibilities

The Plugins module (`src/services/plugins/`) is the service layer for managing plugin lifecycles in Claude Code. It sits within the **Services** group, under the broader **SkillsAndPlugins** extensibility layer. Sibling modules handle skill execution and MCP-based skill building; this module owns the install/uninstall/enable/disable/update operations for plugin packages.

The module is split into three files with distinct responsibilities:

- **`pluginOperations.ts`** — Pure library functions for all plugin CRUD operations. Framework-agnostic: no `console` output, no `process.exit()`. Used by both CLI commands and the interactive UI (`ManagePlugins.tsx`).
- **`pluginCliCommands.ts`** — Thin CLI wrappers around the operations. Adds console output, telemetry events, and `process.exit()` for non-interactive use via `claude plugin install/uninstall/...`.
- **`PluginInstallationManager.ts`** — Background marketplace reconciliation that runs at startup, keeping marketplace clones up-to-date and auto-refreshing plugins without blocking the REPL.

## Key Processes

### Plugin Installation Flow

The install operation (`installPluginOp`) follows a **settings-first** pattern — the settings file is the source of truth for intent; caching is materialization:

1. **Resolve plugin** — Parse the identifier (`name` or `name@marketplace`). Search materialized marketplaces for a matching `PluginMarketplaceEntry` (`src/services/plugins/pluginOperations.ts:330-359`).
2. **Policy check** — If the org has blocked this plugin (or a dependency), reject immediately with a clear message (`src/services/plugins/pluginOperations.ts:398-408`).
3. **Write settings** — Call `installResolvedPlugin()` which writes the plugin to `enabledPlugins` in the appropriate settings file (user/project/local scope). This is the atomic action that declares the user's intent.
4. **Cache plugin** — Download/copy the plugin package to a versioned cache directory and record a version hint.
5. **Return result** — A `PluginOperationResult` with success status, message, pluginId, and scope.

Marketplace reconciliation is *not* the install function's job — if a marketplace isn't materialized yet, the error is "not found." The background installer handles catching up.

### Plugin Uninstall Flow

Uninstallation (`uninstallPluginOp`, `src/services/plugins/pluginOperations.ts:427-558`) handles several edge cases:

1. **Find plugin** — Searches loaded plugins by identifier. Falls back to `installed_plugins_v2.json` for delisted plugins that no longer appear in marketplace data.
2. **Scope validation** — Verifies the plugin is installed at the requested scope. Provides helpful error messages when the scope is wrong (e.g., suggesting `--scope local` for project-scoped plugins shared with the team).
3. **Remove from settings** — Deletes the plugin key from `enabledPlugins` via `updateSettingsForSource()`.
4. **Remove installation record** — Removes the scope entry from `installed_plugins_v2.json`.
5. **Cleanup** — If this was the last scope referencing this plugin version:
   - Marks the version directory as orphaned for garbage collection
   - Deletes stored plugin options and secrets (including legacy `mcpServers` config)
   - Optionally deletes the plugin data directory
6. **Dependency warning** — Checks for reverse dependents (other plugins that depend on this one) and appends a warning to the result message. Does *not* block — blocking would create tombstone situations with delisted plugins.

### Enable/Disable Flow

Both operations route through `setPluginEnabledOp()` (`src/services/plugins/pluginOperations.ts:573-747`), which implements:

- **Scope auto-detection** — Without an explicit `--scope`, searches settings files in precedence order (`local > project > user`) to find where the plugin is mentioned.
- **Scope override support** — Users can write to a higher-precedence scope to override a lower one (e.g., `disable --scope local` overrides a project-enabled plugin without touching the shared `.claude/settings.json`).
- **Built-in plugin handling** — Built-in plugins bypass normal scope resolution and always write to user settings.
- **Policy guard** — Org-blocked plugins cannot be enabled at any scope.
- **Idempotency** — Returns a "already enabled/disabled" message instead of failing.
- **Reverse dependency tracking** — On disable, captures dependents *before* writing settings so the warning reflects the pre-disable state.

### Disable All

`disableAllPluginsOp()` (`src/services/plugins/pluginOperations.ts:782-812`) iterates over all currently enabled plugins (from `getPluginEditableScopes()`) and disables each one individually. Collects successes and failures, returning a combined result.

### Plugin Update Flow

`updatePluginOp()` (`src/services/plugins/pluginOperations.ts:829-890`) performs a **non-inplace** update:

1. **Lookup** — Fetches the plugin entry from the marketplace and verifies the installation exists at the given scope.
2. **Fetch source** — For remote plugins: downloads to a temp directory via `cachePlugin()`, capturing the git commit SHA. For local plugins: resolves the path from the marketplace install location.
3. **Calculate version** — Uses `calculatePluginVersion()` with manifest, source path, and git SHA.
4. **Compare versions** — If the computed version matches the installed version (or the installed path matches the versioned cache), reports "already up to date."
5. **Copy to versioned cache** — `copyPluginToVersionedCache()` places the new version in a separate directory (may be `.zip`).
6. **Update disk record** — Writes the new install path and version to `installed_plugins_v2.json`. Memory stays unchanged until restart.
7. **Orphan old version** — If no other installation references the old version path, marks it for cleanup.
8. **Cleanup** — Temp download directories are cleaned up in a `finally` block.

Update supports all scopes including `managed` (unlike install, which excludes managed scope).

### Background Marketplace Reconciliation

`performBackgroundPluginInstallations()` (`src/services/plugins/PluginInstallationManager.ts:60-184`) runs at startup without blocking the REPL:

1. **Diff** — Compares declared marketplaces (from settings) against materialized ones (on disk) to find missing or source-changed entries.
2. **Initialize UI state** — Sets pending status in `AppState.plugins.installationStatus` so the REPL can show progress spinners.
3. **Reconcile** — Calls `reconcileMarketplaces()` with an `onProgress` callback that updates AppState as each marketplace transitions through `installing → installed | failed`.
4. **Post-reconcile**:
   - **New installs**: Auto-refreshes plugins via `refreshActivePlugins()`, which clears all caches and bumps `pluginReconnectKey` for MCP re-establishment. Falls back to `needsRefresh` notification on failure.
   - **Updates only**: Sets `needsRefresh` flag so the user is notified to run `/reload-plugins`.
5. **Telemetry** — Logs `tengu_marketplace_background_install` with counts of installed, updated, failed, and up-to-date marketplaces.

## Function Signatures

### pluginOperations.ts — Core Operations

| Function | Signature | Description |
|----------|-----------|-------------|
| `installPluginOp` | `(plugin: string, scope?: InstallableScope) → Promise<PluginOperationResult>` | Install a plugin from a marketplace |
| `uninstallPluginOp` | `(plugin: string, scope?: InstallableScope, deleteDataDir?: boolean) → Promise<PluginOperationResult>` | Uninstall a plugin from a given scope |
| `enablePluginOp` | `(plugin: string, scope?: InstallableScope) → Promise<PluginOperationResult>` | Enable a disabled plugin |
| `disablePluginOp` | `(plugin: string, scope?: InstallableScope) → Promise<PluginOperationResult>` | Disable an enabled plugin |
| `disableAllPluginsOp` | `() → Promise<PluginOperationResult>` | Disable all enabled plugins across scopes |
| `updatePluginOp` | `(plugin: string, scope: PluginScope) → Promise<PluginUpdateResult>` | Update a plugin to the latest version |
| `setPluginEnabledOp` | `(plugin: string, enabled: boolean, scope?: InstallableScope) → Promise<PluginOperationResult>` | Shared enable/disable implementation |

### pluginOperations.ts — Helpers

| Function | Signature | Description |
|----------|-----------|-------------|
| `assertInstallableScope` | `(scope: string) → asserts scope is InstallableScope` | Runtime assertion that scope is user/project/local |
| `isInstallableScope` | `(scope: PluginScope) → scope is InstallableScope` | Type guard excluding 'managed' scope |
| `getProjectPathForScope` | `(scope: PluginScope) → string \| undefined` | Returns cwd for project/local scopes, undefined otherwise |
| `isPluginEnabledAtProjectScope` | `(pluginId: string) → boolean` | Checks if a plugin is enabled in `.claude/settings.json` |
| `getPluginInstallationFromV2` | `(pluginId: string) → { scope, projectPath? }` | Gets the most relevant installation (priority: local > project > user > managed) |

### pluginCliCommands.ts — CLI Commands

| Function | Signature | Description |
|----------|-----------|-------------|
| `installPlugin` | `(plugin: string, scope?: InstallableScope) → Promise<void>` | CLI install — prints result, logs telemetry, exits |
| `uninstallPlugin` | `(plugin: string, scope?: InstallableScope, keepData?: boolean) → Promise<void>` | CLI uninstall |
| `enablePlugin` | `(plugin: string, scope?: InstallableScope) → Promise<void>` | CLI enable |
| `disablePlugin` | `(plugin: string, scope?: InstallableScope) → Promise<void>` | CLI disable |
| `disableAllPlugins` | `() → Promise<void>` | CLI disable-all |
| `updatePluginCli` | `(plugin: string, scope: PluginScope) → Promise<void>` | CLI update |

### PluginInstallationManager.ts

| Function | Signature | Description |
|----------|-----------|-------------|
| `performBackgroundPluginInstallations` | `(setAppState: SetAppState) → Promise<void>` | Background marketplace reconciliation at startup |

## Type Definitions

### `PluginOperationResult`

```typescript
// src/services/plugins/pluginOperations.ts:141-149
type PluginOperationResult = {
  success: boolean
  message: string
  pluginId?: string
  pluginName?: string
  scope?: PluginScope
  reverseDependents?: string[]  // Plugins that depend on this one
}
```

### `PluginUpdateResult`

```typescript
// src/services/plugins/pluginOperations.ts:154-162
type PluginUpdateResult = {
  success: boolean
  message: string
  pluginId?: string
  newVersion?: string
  oldVersion?: string
  alreadyUpToDate?: boolean
  scope?: PluginScope
}
```

### Scope Types

- **`InstallableScope`**: `'user' | 'project' | 'local'` — scopes where plugins can be explicitly installed. Excludes `'managed'` which can only come from managed-settings.json.
- **`VALID_UPDATE_SCOPES`**: `['user', 'project', 'local', 'managed']` — update operations additionally allow the `managed` scope.
- **Scope precedence**: `local (2) > project (1) > user (0)`. Higher-precedence scopes override lower ones.

## Configuration & Defaults

- **Default install scope**: `'user'` (when no `--scope` flag is provided)
- **Plugin identifier format**: `name` (bare name, searched across all marketplaces) or `name@marketplace` (fully qualified)
- **Settings storage**: Plugin enablement is stored in `enabledPlugins` within the appropriate settings file per scope (`userSettings`, `projectSettings`, or local settings)
- **Installation tracking**: `installed_plugins_v2.json` tracks where each plugin is installed, including scope, project path, install path, and version

## Edge Cases & Caveats

- **Delisted plugins**: If a plugin is removed from its marketplace, uninstall still works by falling back to `installed_plugins_v2.json` data (`src/services/plugins/pluginOperations.ts:460-471`). This prevents orphaned installations.
- **Project scope uninstall**: Project-scoped plugins live in `.claude/settings.json` (shared with the team). The uninstall error message directs users to `disable --scope local` instead, to avoid modifying shared config (`src/services/plugins/pluginOperations.ts:487-491`).
- **Scope override pattern**: `disable --scope local` writes `false` at local scope to mask a project-scope `true`, without touching the shared settings file. The `isOverride` logic (`src/services/plugins/pluginOperations.ts:675-676`) detects this and skips the "wrong scope" error.
- **Background install auto-refresh failure**: If auto-refresh fails after new marketplace installs, the system falls back to setting `needsRefresh: true` and prompting the user to run `/reload-plugins` (`src/services/plugins/PluginInstallationManager.ts:147-164`).
- **Update requires restart**: After `updatePluginOp`, the in-memory plugin state is stale. The result message instructs the user to restart (`src/services/plugins/pluginOperations.ts:1069`).
- **Reverse dependency warnings**: Uninstall and disable operations warn about reverse dependents but do *not* block. Blocking would create tombstone scenarios when a dependency gets delisted. The load-time `verifyAndDemote` catches the fallout instead (`src/services/plugins/pluginOperations.ts:543-545`).
- **Telemetry PII handling**: Plugin names and marketplace names are routed to PII-tagged columns (`_PROTO_plugin_name`, `_PROTO_marketplace_name`) rather than general-access metadata (`src/services/plugins/pluginCliCommands.ts:120-139`).
- **CLI error classification**: `handlePluginCommandError` classifies errors via `classifyPluginCommandError()` for dashboard success-rate tracking (`src/services/plugins/pluginCliCommands.ts:53-96`).