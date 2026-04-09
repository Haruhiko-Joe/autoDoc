# InstallationLifecycle

## Overview & Responsibilities

The InstallationLifecycle module manages the complete lifecycle of plugin installations in Claude Code — from initial install through updates, delisting enforcement, and startup verification. It sits within the **Infrastructure → CoreUtilities → PluginHelpers** hierarchy, providing the state management layer that other plugin subsystems (marketplace browsing, plugin loading, MCP integration) depend on.

The module is composed of 8 files with distinct responsibilities:

| File | Lines | Role |
|------|-------|------|
| `installedPluginsManager.ts` | ~1,268 | Core persistence layer for `installed_plugins.json` |
| `pluginInstallationHelpers.ts` | ~596 | Shared install logic (caching, registering, dependency resolution) |
| `pluginStartupCheck.ts` | ~342 | Startup verification of enabled plugins |
| `pluginAutoupdate.ts` | ~285 | Background auto-update with marketplace refresh |
| `headlessPluginInstall.ts` | ~175 | Headless/CCR-mode batch installation |
| `pluginBlocklist.ts` | ~128 | Delisting detection and auto-uninstall |
| `pluginFlagging.ts` | ~209 | Flagged plugin state tracking |
| `performStartupChecks.tsx` | ~69 | React-integrated startup check entry point |

## Key Processes

### Plugin Installation Flow

The installation flow has two entry points that share a common core:

1. **Interactive UI path** — `installPluginFromMarketplace()` wraps the core with try/catch, analytics logging, and user-facing message formatting (`pluginInstallationHelpers.ts:506-595`).
2. **CLI path** — `installPluginOp()` (external) calls the same core.

Both funnel into `installResolvedPlugin()` (`pluginInstallationHelpers.ts:348-481`), which:

1. **Policy guard** — Checks `isPluginBlockedByPolicy()` to reject org-blocked plugins.
2. **Dependency resolution** — Calls `resolveDependencyClosure()` to compute the transitive closure of plugin dependencies, respecting cross-marketplace allowlists.
3. **Policy guard for dependencies** — Iterates the closure to ensure no transitive dependency is policy-blocked.
4. **Settings write** — Writes the entire closure to `enabledPlugins` in one atomic settings update via `updateSettingsForSource()`.
5. **Materialize** — For each plugin in the closure, calls `cacheAndRegisterPlugin()` to download/copy sources and register them.
6. **Cache clear** — Calls `clearAllCaches()` to invalidate memoized plugin data.

### Cache and Register

`cacheAndRegisterPlugin()` (`pluginInstallationHelpers.ts:128-226`) is the workhorse that:

1. Calls `cachePlugin()` to download or copy plugin sources to `~/.claude/plugins/cache/`.
2. Computes the git commit SHA from either the local source or cache path.
3. Calculates the plugin version via `calculatePluginVersion()`.
4. Moves the cached plugin to a versioned path: `cache/{marketplace}/{plugin}/{version}/`.
5. Optionally converts to ZIP format if `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` is enabled.
6. Registers the installation in `installed_plugins.json` via `addInstalledPlugin()`.

Path traversal protection is enforced by `validatePathWithinBase()` (`pluginInstallationHelpers.ts:87-107`) for local plugin sources.

### Installed Plugins Persistence (installedPluginsManager)

The persistence layer manages `~/.claude/plugins/installed_plugins.json` in V2 format, where each plugin has an array of installation entries scoped by `user`, `project`, `local`, or `managed`.

**Dual-state architecture**: The manager maintains two separate views of installed plugins:

- **In-memory session state** (`inMemoryInstalledPlugins`) — Snapshot loaded at startup, used by the running session. Never modified by background operations.
- **Disk state** — The actual file, modified by background updaters via `updateInstallationPathOnDisk()`.

This separation enables non-disruptive background updates: the updater writes new versions to disk, while the session continues using old versions. `hasPendingUpdates()` (`installedPluginsManager.ts:595-618`) detects divergence by comparing install paths between memory and disk.

**Key functions**:

- `addInstalledPlugin()` (`installedPluginsManager.ts:874-912`) — Adds or updates an installation entry at a specific scope+projectPath. Preserves entries at other scopes.
- `removeInstalledPlugin()` (`installedPluginsManager.ts:924-952`) — Removes all installation entries for a plugin.
- `loadInstalledPluginsV2()` (`installedPluginsManager.ts:315-364`) — Loads from disk with V1→V2 migration, caches result.
- `loadInstalledPluginsFromDisk()` (`installedPluginsManager.ts:502-524`) — Bypasses all caches for background updater use.
- `isPluginInstalled()` (`installedPluginsManager.ts:818-831`) — Checks project-relevant installations AND verifies `enabledPlugins` settings haven't diverged.
- `isPluginGloballyInstalled()` (`installedPluginsManager.ts:849-862`) — Only returns true for `user` or `managed` scope installations.

### V1 → V2 Migration

`migrateToSinglePluginFile()` (`installedPluginsManager.ts:115-182`) consolidates the legacy dual-file system on startup:

1. If `installed_plugins_v2.json` exists → rename to `installed_plugins.json`, clean up legacy cache.
2. If only `installed_plugins.json` exists with `version=1` → convert in-place to `version=2` (all plugins default to `user` scope).
3. Clean up legacy flat cache directories that don't match the versioned structure.

`migrateFromEnabledPlugins()` (`installedPluginsManager.ts:1048-1268`) syncs `enabledPlugins` from `settings.json` files into `installed_plugins.json`, resolving scope from the settings source hierarchy (user → project → local, last wins).

### Background Auto-Update

`autoUpdateMarketplacesAndPluginsInBackground()` (`pluginAutoupdate.ts:227-284`) is called from `main.tsx` during startup as a fire-and-forget async job:

1. Checks `shouldSkipPluginAutoupdate()` for the kill switch.
2. Determines which marketplaces have `autoUpdate` enabled (official Anthropic marketplaces default to true).
3. Refreshes those marketplaces via `refreshMarketplace()` (git pull / re-download).
4. Calls `updatePluginsForMarketplaces()` which iterates `installed_plugins.json`, filters to plugins from auto-update marketplaces, further filters to project-relevant installations, and calls `updatePluginOp()` per installation.
5. Notifies the REPL via a registered callback, or queues the notification if the REPL hasn't mounted yet.

**Notification delivery** uses a callback pattern with pending queue (`pluginAutoupdate.ts:38-65`):
- `onPluginsAutoUpdated(callback)` registers a listener. If updates already happened, delivers immediately.
- `pendingNotification` stores updates that occurred before callback registration.

### Headless/CCR-Mode Installation

`installPluginsForHeadless()` (`headlessPluginInstall.ts:43-174`) is the headless equivalent of the interactive startup flow, without AppState updates:

1. Registers seed marketplaces from `CLAUDE_CODE_PLUGIN_SEED_DIR`.
2. Ensures ZIP cache directory structure exists (when enabled).
3. Reconciles declared marketplaces with materialized state via `reconcileMarketplaces()`.
4. Syncs marketplace JSONs to ZIP cache for offline container access.
5. Runs delisting enforcement via `detectAndUninstallDelistedPlugins()`.
6. Registers session cleanup for extracted plugin temp directories.
7. Returns `true` if any plugins changed (caller should refresh MCP).

### Blocklist Detection and Delisting Enforcement

`detectAndUninstallDelistedPlugins()` (`pluginBlocklist.ts:64-127`):

1. Loads flagged plugins from disk to avoid re-processing.
2. Iterates all known marketplaces that have `forceRemoveDeletedPlugins` enabled.
3. For each marketplace, compares installed plugins against the marketplace manifest to find plugins that have been removed.
4. Skips managed-only plugins (enterprise admin handles those).
5. Auto-uninstalls delisted plugins from all user-controllable scopes.
6. Records each delisted plugin via `addFlaggedPlugin()`.

`detectDelistedPlugins()` (`pluginBlocklist.ts:34-53`) performs the comparison: it builds a set of marketplace plugin names and checks if any installed plugin with the matching `@marketplace` suffix is absent from the set.

### Startup Checks

**Interactive mode** — `performStartupChecks()` (`performStartupChecks.tsx:24-69`):

1. Verifies the current directory has been trusted (security gate — prevents malicious repos from auto-installing plugins).
2. Registers seed marketplaces and clears caches if state changed.
3. Sets `plugins.needsRefresh` in AppState to trigger UI refresh.
4. Delegates to `performBackgroundPluginInstallations()` for the actual work.

**Plugin verification** — `pluginStartupCheck.ts` provides:

- `checkEnabledPlugins()` (`pluginStartupCheck.ts:39-72`) — Merges enabled plugins from `--add-dir` (lowest priority) with settings (policy > local > project > user). Explicitly disabled plugins are removed even if `--add-dir` enabled them.
- `getPluginEditableScopes()` (`pluginStartupCheck.ts:96-163`) — Returns a map of plugin ID → owning scope, used to determine where to write back when enabling/disabling. Processes sources in precedence order: addDir → managed → user → project → local → flag.
- `findMissingPlugins()` (`pluginStartupCheck.ts:216-250`) — Cross-references enabled plugins against installed plugins, then verifies missing ones exist in a marketplace before returning them.
- `installSelectedPlugins()` (`pluginStartupCheck.ts:272-341`) — Batch-installs a list of plugins, caching external ones and registering local ones, then updates settings.

### Plugin Flagging

The flagging system (`pluginFlagging.ts`) tracks plugins that were auto-removed due to delisting, persisting state to `~/.claude/plugins/flagged-plugins.json`:

- **Module-level cache** — `getFlaggedPlugins()` is synchronous for React render compatibility; the cache must be populated first by `loadFlaggedPlugins()`.
- **Auto-expiry** — When flagged plugins are displayed in the UI, `markFlaggedPluginsSeen()` sets a `seenAt` timestamp. On next load, entries older than 48 hours are automatically purged.
- **Atomic writes** — Uses temp file + rename pattern for crash safety (`pluginFlagging.ts:86-110`).
- **Manual dismiss** — `removeFlaggedPlugin()` lets users clear notifications from `/plugins`.

## Type Definitions

### `PluginInstallationInfo`

```typescript
// pluginInstallationHelpers.ts:64-68
type PluginInstallationInfo = {
  pluginId: string
  installPath: string
  version?: string
}
```

### `InstallCoreResult`

A discriminated union returned by `installResolvedPlugin()`:

```typescript
// pluginInstallationHelpers.ts:282-297
type InstallCoreResult =
  | { ok: true; closure: string[]; depNote: string }
  | { ok: false; reason: 'local-source-no-location'; pluginName: string }
  | { ok: false; reason: 'settings-write-failed'; message: string }
  | { ok: false; reason: 'resolution-failed'; resolution: ResolutionResult & { ok: false } }
  | { ok: false; reason: 'blocked-by-policy'; pluginName: string }
  | { ok: false; reason: 'dependency-blocked-by-policy'; pluginName: string; blockedDependency: string }
```

### `FlaggedPlugin`

```typescript
// pluginFlagging.ts:26-29
type FlaggedPlugin = {
  flaggedAt: string      // ISO timestamp when flagged
  seenAt?: string        // ISO timestamp when shown in UI; auto-cleared after 48h
}
```

### `PluginInstallResult`

```typescript
// pluginStartupCheck.ts:255-258
type PluginInstallResult = {
  installed: string[]
  failed: Array<{ name: string; error: string }>
}
```

## Configuration & Defaults

| Configuration | Source | Default | Description |
|--------------|--------|---------|-------------|
| `enabledPlugins` | settings.json (user/project/local) | `{}` | Map of plugin IDs to enabled state |
| `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` | Environment variable | disabled | Enables ZIP-based plugin caching for ephemeral containers |
| `CLAUDE_CODE_PLUGIN_SEED_DIR` | Environment variable | none | Pre-populated marketplace seed directory |
| `autoUpdate` per marketplace | marketplace config / settings | `true` for official | Controls whether marketplace is auto-updated |
| `forceRemoveDeletedPlugins` | marketplace manifest | varies | Enables delisting enforcement for a marketplace |
| Flagged plugin expiry | Hardcoded | 48 hours | Time after UI display before flagged entries auto-clear |

## Edge Cases & Caveats

- **Settings divergence guard**: `isPluginInstalled()` and `isPluginGloballyInstalled()` check both `installed_plugins.json` AND `settings.enabledPlugins`. If settings were externally clobbered (e.g., manual edit), the plugin is treated as not-installed to allow re-enabling.

- **In-memory vs disk divergence**: Background updates modify disk only. The session keeps using the old plugin version until restart. `hasPendingUpdates()` / `getPendingUpdatesDetails()` expose this gap for UI notification.

- **Subdirectory rename edge case**: When the marketplace name equals the plugin name (e.g., `exa-mcp-server@exa-mcp-server`), the versioned path is a subdirectory of the cache path. `cacheAndRegisterPlugin()` handles this by moving to a temp location first (`pluginInstallationHelpers.ts:185-196`).

- **Cross-filesystem moves**: Temp paths are placed in the same parent directory as the cache to avoid `EXDEV` errors when `/tmp` is on a different filesystem (e.g., tmpfs).

- **Trust gate**: `performStartupChecks()` requires the "trust this folder" dialog to have been accepted before any plugin installations proceed, preventing malicious repositories from triggering installs.

- **Race condition on callback**: Auto-update notifications use a pending queue to handle the case where updates complete before the REPL component mounts and registers its callback.

- **Managed plugins skip delisting**: Plugins installed only at `managed` scope are skipped during delisting enforcement — enterprise admins are expected to handle those separately.

- **Migration runs once per session**: `migrateToSinglePluginFile()` uses a module-level `migrationCompleted` flag to avoid repeated migration attempts, even if the first attempt fails.