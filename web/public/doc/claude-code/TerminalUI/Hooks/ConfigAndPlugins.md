# ConfigAndPlugins

## Overview & Responsibilities

ConfigAndPlugins is a collection of React hooks within the **TerminalUI → Hooks** layer that wire dynamic configuration, settings reactivity, plugin lifecycle, model resolution, and MCP resource merging into the UI. These hooks bridge external state sources — GrowthBook feature flags, settings files on disk, plugin directories, and MCP server connections — into React's reactive model so that the REPL and other components stay up-to-date without manual polling.

Within the TerminalUI architecture, these hooks sit alongside ~80 other hooks in the Hooks module. They are consumed primarily by the REPL screen and AppState providers. Sibling hook groups handle input, IDE integration, session lifecycle, and UI state.

## Key Processes

### Settings Reactivity Flow

1. `useSettings()` reads settings from `AppState` via the `useAppState` selector (`src/hooks/useSettings.ts:16`), providing a `ReadonlySettings` (deep-immutable) value.
2. `useSettingsChange()` subscribes to `settingsChangeDetector` — a file-system watcher that fires when any settings file changes on disk (`src/hooks/useSettingsChange.ts:22`).
3. When a change is detected, the subscriber calls `getSettings_DEPRECATED()` to re-read from disk and passes the fresh settings plus the `SettingSource` to the provided callback. The cache is already reset by the change detector's fanout, avoiding N-way thrashing with multiple subscribers.

### Dynamic Config (Feature Flags)

`useDynamicConfig()` fetches a GrowthBook feature flag value asynchronously via `getDynamicConfig_BLOCKS_ON_INIT()` (`src/hooks/useDynamicConfig.ts:16`). It returns the `defaultValue` synchronously on first render, then updates state once the config resolves. In test environments, the effect is skipped to prevent hanging.

### Skill/Command Refresh Flow

`useSkillsChange()` keeps the slash-command list fresh across two independent triggers (`src/hooks/useSkillsChange.ts:24-62`):

1. **Skill file changes** — subscribes to `skillChangeDetector`. On change, clears the full command cache (`clearCommandsCache()`), re-scans disk via `getCommands(cwd)`, and calls `onCommandsChange`.
2. **GrowthBook init/refresh** — subscribes via `onGrowthBookRefresh`. Only clears memoization caches (`clearCommandMemoizationCaches()`), not the disk cache, because only feature-flag predicates may have changed (e.g., gated commands like `/btw`). Then re-evaluates `getCommands(cwd)`.

Both paths are non-fatal; errors are logged but do not crash the session.

### Plugin Lifecycle (useManagePlugins)

This is the most substantial hook in the group (`src/hooks/useManagePlugins.ts:37-304`). It orchestrates the initial plugin load on mount:

1. **Load plugins** — calls `loadAllPlugins()`, which returns `{ enabled, disabled, errors }`.
2. **Delisting enforcement** — runs `detectAndUninstallDelistedPlugins()` to auto-remove blocklisted plugins.
3. **Flagged-plugin notifications** — checks `getFlaggedPlugins()` and shows a warning notification if any plugins are flagged.
4. **Load plugin extensions** — loads commands (`getPluginCommands`), agents (`loadPluginAgents`), and hooks (`loadPluginHooks`) in sequence, catching errors individually so one failure doesn't block others.
5. **MCP server discovery** — iterates enabled plugins, calls `loadPluginMcpServers()` per plugin, warms the cache for the MCP connection manager.
6. **LSP server discovery** — similarly loads LSP servers per plugin and calls `reinitializeLspServerManager()`.
7. **AppState update** — merges all results (enabled, disabled, commands, errors) into `AppState.plugins`, preserving existing LSP errors through deduplication.
8. **Telemetry** — emits `tengu_plugins_loaded` with counts of enabled, disabled, inline, marketplace plugins, errors, skills, agents, hooks, MCP and LSP servers.

Post-mount refresh is deliberately **not** handled by this hook. When `AppState.plugins.needsRefresh` becomes true, a notification directs the user to run `/reload-plugins`, which calls `refreshActivePlugins()` for a consistent full reload.

### Model Resolution (useMainLoopModel)

`useMainLoopModel()` resolves the active model name for the main conversation loop (`src/hooks/useMainLoopModel.ts:13-34`):

1. Reads `mainLoopModelForSession` (per-session override) and `mainLoopModel` (persistent setting) from AppState.
2. Falls back to `getDefaultMainLoopModelSetting()` if neither is set.
3. Runs `parseUserSpecifiedModel()` which resolves aliases (e.g., `"sonnet"` → full model ID) and reads the `tengu_ant_model_override` GrowthBook flag.
4. Subscribes to `onGrowthBookRefresh` and forces a re-render so that alias resolution picks up fresh feature-flag values after GrowthBook initializes.

### MCP Resource Merging

Three hooks merge initial (startup) resources with dynamically discovered ones:

**`useMergedClients`** (`src/hooks/useMergedClients.ts:15-23`):
- Merges `initialClients` (from props/startup) with `mcpClients` (discovered at runtime).
- Uses `lodash uniqBy` on `'name'` to deduplicate. Initial clients take precedence (listed first).

**`useMergedCommands`** (`src/hooks/useMergedCommands.ts:5-15`):
- Merges `initialCommands` with `mcpCommands` using the same `uniqBy('name')` deduplication.
- Returns initial commands unchanged if no MCP commands exist.

**`useMergedTools`** (`src/hooks/useMergedTools.ts:20-44`):
- Calls `assembleToolPool(toolPermissionContext, mcpTools)` — the shared pure function used by both REPL and `runAgent` — which handles built-in tools + MCP deny-rule filtering + deduplication + MCP CLI exclusion.
- Then calls `mergeAndFilterTools(initialTools, assembled, mode)` to layer extra initial tools on top.
- Memoized on all inputs including `toolPermissionContext`.

## Function Signatures

### `useDynamicConfig<T>(configName: string, defaultValue: T): T`

Fetches a GrowthBook feature flag value. Returns `defaultValue` synchronously, updates when the async fetch resolves.

> Source: `src/hooks/useDynamicConfig.ts:8-22`

### `useSettings(): ReadonlySettings`

Returns the current settings object from AppState. Reactively updates when settings change on disk.

> Source: `src/hooks/useSettings.ts:15-17`

### `useSettingsChange(onChange: (source: SettingSource, settings: SettingsJson) => void): void`

Subscribes to settings file changes. Calls `onChange` with the source that triggered the change and the freshly-read settings.

> Source: `src/hooks/useSettingsChange.ts:7-25`

### `useSkillsChange(cwd: string | undefined, onCommandsChange: (commands: Command[]) => void): void`

Subscribes to skill-file and GrowthBook changes. Calls `onCommandsChange` with a refreshed command list when either source triggers.

> Source: `src/hooks/useSkillsChange.ts:24-62`

### `useManagePlugins({ enabled?: boolean }): void`

Loads plugins on mount, enforces delisting, surfaces flagged-plugin notifications, and populates `AppState.plugins`. Shows a reload notification when `needsRefresh` is set.

> Source: `src/hooks/useManagePlugins.ts:37-304`

### `useMainLoopModel(): ModelName`

Resolves the active model name with alias support and GrowthBook override. Returns a fully-qualified model name for API calls.

> Source: `src/hooks/useMainLoopModel.ts:13-34`

### `mergeClients(initialClients, mcpClients): MCPServerConnection[]`

Pure function (non-hook) that merges two client arrays, deduplicating by name.

> Source: `src/hooks/useMergedClients.ts:5-13`

### `useMergedClients(initialClients, mcpClients): MCPServerConnection[]`

Memoized React hook wrapper around `mergeClients`.

> Source: `src/hooks/useMergedClients.ts:15-23`

### `useMergedCommands(initialCommands, mcpCommands): Command[]`

Merges initial and MCP-discovered commands, deduplicating by name.

> Source: `src/hooks/useMergedCommands.ts:5-15`

### `useMergedTools(initialTools, mcpTools, toolPermissionContext): Tools`

Assembles the full tool pool by combining built-in tools with MCP tools, applying deny rules, deduplication, and permission filtering.

> Source: `src/hooks/useMergedTools.ts:20-44`

## Type Definitions

### `ReadonlySettings`

```typescript
type ReadonlySettings = AppState['settings']
```

Deep-immutable wrapper over the settings object stored in AppState. Use this to annotate variables holding `useSettings()` return values.

> Source: `src/hooks/useSettings.ts:7`

## Edge Cases & Caveats

- **`useDynamicConfig` skips in tests**: The effect returns early when `NODE_ENV === 'test'` to prevent test hangs from the blocking GrowthBook init call.

- **Settings change N-way thrashing**: `useSettingsChange` deliberately does **not** reset the settings cache itself. The `settingsChangeDetector.fanOut` already handles cache invalidation; resetting inside each subscriber caused thrashing with multiple subscribers.

- **GrowthBook timing for commands**: `getCommands()` runs before GrowthBook initializes (during REPL mount), so the initial command list may not reflect feature-gated commands. `useSkillsChange` fixes this by subscribing to `onGrowthBookRefresh` and re-evaluating with only memoization cache cleared (not the full disk cache).

- **Plugin refresh is manual**: `useManagePlugins` does **not** auto-refresh when `needsRefresh` is set. A previous auto-refresh implementation had a stale-cache bug (only cleared `loadAllPlugins` but not downstream memoized loaders). All post-mount refresh goes through `/reload-plugins` → `refreshActivePlugins()`.

- **Plugin error isolation**: Each plugin extension type (commands, agents, hooks) loads in its own try/catch. A failure in one does not prevent loading others. All errors are accumulated and stored in `AppState.plugins.errors` for visibility in the Doctor UI.

- **Model alias staleness**: `useMainLoopModel` subscribes to GrowthBook refresh and forces a re-render because `parseUserSpecifiedModel` reads a cached GrowthBook value that may be stale before initialization completes. Without this, the displayed model and the actual API model could diverge.

- **Merge precedence**: In `useMergedClients` and `useMergedCommands`, initial items are listed first in the `uniqBy` call, meaning they take precedence over dynamically discovered items with the same name. In `useMergedTools`, the `mergeAndFilterTools` function applies mode-specific filtering after assembly.