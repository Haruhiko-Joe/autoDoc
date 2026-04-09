# InfraAndUtilities

## Overview & Responsibilities

InfraAndUtilities is the shared infrastructure and low-level utility layer underpinning the entire plugin system. It sits within the **Infrastructure > CoreUtilities > PluginHelpers** hierarchy, providing foundational services that higher-level plugin modules (loader, marketplace manager, reconciler) depend on.

The module spans 13 files (~2,400 lines) and covers:

- **Directory path resolution** — centralized plugin directory configuration with cowork mode and custom cache dir support
- **Option storage** — plugin user-configurable options with sensitive/non-sensitive split storage and variable substitution
- **ZIP-based caching** — compressed plugin storage for ephemeral container environments
- **Cache lifecycle** — cache clearing, orphan version marking, and garbage collection
- **Versioning** — version calculation from manifests, git SHAs, or timestamps
- **Git detection** — memoized git availability checking
- **Fetch telemetry** — network request classification and logging
- **Install counts** — statistics fetching and caching from GitHub
- **Hint recommendations** — plugin suggestions triggered by CLI/SDK tool tags
- **Orphan exclusion** — ripgrep glob patterns to hide stale plugin versions from search
- **Add-dir settings** — reading plugin settings from `--add-dir` directories
- **Refresh orchestrator** — swapping all active plugin components in a running session

## Key Processes

### Plugin Directory Resolution

The directory resolution flow (`pluginDirectories.ts`) determines where plugins are stored on disk:

1. Check `CLAUDE_CODE_PLUGIN_CACHE_DIR` environment variable — if set, use it (with tilde expansion) (`src/utils/plugins/pluginDirectories.ts:53-63`)
2. Otherwise, combine `~/.claude/` with a directory name chosen by priority:
   - Session state from `--cowork` CLI flag → `cowork_plugins/`
   - `CLAUDE_CODE_USE_COWORK_PLUGINS` env var → `cowork_plugins/`
   - Default → `plugins/`
3. Seed directories (`CLAUDE_CODE_PLUGIN_SEED_DIR`) provide a read-only fallback layer — multiple seeds can be PATH-delimited and are checked in precedence order (`src/utils/plugins/pluginDirectories.ts:85-90`)

Each plugin also gets a persistent data directory at `~/.claude/plugins/data/<sanitized-id>/`, exposed as `${CLAUDE_PLUGIN_DATA}`. Unlike version-scoped install paths, this directory survives plugin updates and is only deleted on final uninstall.

### Plugin Option Storage & Substitution

Options declared in `manifest.userConfig` are split by sensitivity (`pluginOptionsStorage.ts`):

1. **Load** (`loadPluginOptions`): merges non-sensitive values from `settings.pluginConfigs[id].options` with sensitive values from secure storage (macOS Keychain / `.credentials.json`). Secure storage wins on collision. Memoized per plugin ID to avoid repeated keychain spawns (~50-100ms each on macOS). (`src/utils/plugins/pluginOptionsStorage.ts:56-77`)

2. **Save** (`savePluginOptions`): writes secure storage **first** — if keychain fails, settings.json is left untouched so old plaintext stays as fallback. Then writes non-sensitive values to settings.json, scrubbing any keys that migrated to the sensitive category. (`src/utils/plugins/pluginOptionsStorage.ts:90-194`)

3. **Variable substitution**: Two patterns are supported in MCP/LSP server configs, hook commands, and skill content:
   - `${CLAUDE_PLUGIN_ROOT}` → version-scoped install directory
   - `${CLAUDE_PLUGIN_DATA}` → persistent data directory (lazily created)
   - `${user_config.KEY}` → saved option values (with a content-safe variant that redacts sensitive keys)

### Plugin Version Calculation

`calculatePluginVersion` (`pluginVersioning.ts:36-106`) resolves a version string through a priority chain:

1. `manifest.version` from `plugin.json` (highest priority)
2. Provided version from marketplace entry
3. Pre-resolved git commit SHA — for `git-subdir` sources, a SHA256 hash of the normalized subdirectory path is appended to disambiguate plugins at different paths within the same monorepo commit
4. Git SHA read from the install path's `.git` directory
5. `'unknown'` as last resort

`getVersionFromPath` extracts the version segment from a cache path like `~/.claude/plugins/cache/marketplace/plugin/1.0.0`.

### ZIP Cache Flow (Ephemeral Containers)

When `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` is enabled (`zipCache.ts`, `zipCacheAdapters.ts`):

1. Plugins are stored as ZIP archives on a mounted volume (e.g., GCP Filestore) that persists across container lifetimes
2. At session start, a temp directory is created on local disk (`/tmp/claude-plugin-session-<random>`)
3. ZIPs are extracted to this session-local directory for use
4. On session end, the temp directory is cleaned up

Key operations:
- **`createZipFromDirectory`**: Recursively collects files (skipping `.git`, resolving symlinks, detecting inode cycles), stores Unix mode bits in ZIP external attributes, compresses at level 6 (`src/utils/plugins/zipCache.ts:216-229`)
- **`extractZipToDirectory`**: Extracts and restores exec bits from ZIP external attributes so hooks/scripts remain executable (`src/utils/plugins/zipCache.ts:331-364`)
- **`atomicWriteToZipCache`**: Write-to-temp then rename pattern prevents corruption on shared mounts (`src/utils/plugins/zipCache.ts:175-201`)
- **`syncMarketplacesToZipCache`** (adapters): Saves marketplace JSONs and merges with previously cached data so ephemeral containers don't need to re-clone (`src/utils/plugins/zipCacheAdapters.ts:141-164`)

Only `github`, `git`, `url`, and `settings` marketplace sources are supported in zip cache mode; `file`/`directory`/`npm` are excluded.

### Cache Clearing and Orphan Garbage Collection

`cacheUtils.ts` manages two concerns:

**Cache clearing** (`clearAllPluginCaches`, `clearAllCaches`): Clears memoized caches for plugins, commands, agents, hooks, options, output styles, prompt cache, and agent definitions. Also prunes hooks from uninstalled plugins asynchronously. (`src/utils/plugins/cacheUtils.ts:26-50`)

**Orphan GC** (`cleanupOrphanedPluginVersionsInBackground`): When a plugin is updated, the old version directory gets a `.orphaned_at` marker file. The background cleanup runs in two passes (`src/utils/plugins/cacheUtils.ts:74-116`):
1. **Pass 1**: Remove `.orphaned_at` markers from currently-installed versions (handles reinstalls)
2. **Pass 2**: Walk `cache/<marketplace>/<plugin>/<version>/` — if a version isn't in `installed_plugins.json`, create a marker if missing or delete the directory if the marker is older than 7 days

Empty marketplace and plugin directories are cleaned up after processing. Skipped entirely in zip cache mode.

### Refresh Orchestrator

`refreshActivePlugins` (`refresh.ts:72-191`) is the Layer-3 refresh primitive that hot-swaps all active plugin components in a running session:

1. Clear ALL plugin caches and orphan exclusions
2. Run `loadAllPlugins()` — the full clone+cache pipeline
3. After that completes, load plugin commands and agent definitions (these depend on the warmed cache)
4. Load MCP and LSP servers for each enabled plugin in parallel
5. Update `AppState` with new enabled/disabled plugins, commands, errors; increment `pluginReconnectKey` to trigger MCP reconnection
6. Reinitialize the LSP server manager
7. Load plugin hooks (caught separately so hook failures don't lose other data)
8. Return a summary with counts of enabled/disabled plugins, commands, agents, hooks, MCP servers, LSP servers, and errors

Called from `/reload-plugins` (interactive), headless auto-refresh, and background post-install.

### Fetch Telemetry

`fetchTelemetry.ts` provides privacy-aware logging for plugin network operations:

- **Host extraction** (`extractHost`): Parses URLs and git SCP specs, buckets to an allowlist of known public hosts (GitHub, GitLab, GCS, etc.) — private hostnames are reported as `'other'` (`src/utils/plugins/fetchTelemetry.ts:54-68`)
- **Error classification** (`classifyFetchError`): Maps error messages to stable buckets (`dns_or_refused`, `timeout`, `conn_reset`, `auth`, `not_found`, `tls`, `invalid_schema`, `other`) to keep dashboard cardinality bounded (`src/utils/plugins/fetchTelemetry.ts:108-135`)
- DNS errors are checked before timeout because git clone error enhancement can rewrite DNS failures to include the word "timeout"

### Install Count Statistics

`installCounts.ts` fetches and caches unique install counts from the official `claude-plugins-official` stats branch:

1. Check local cache at `~/.claude/plugins/install-counts-cache.json`
2. If valid and <24 hours old, return cached data (logs `cache_hit` telemetry)
3. Otherwise, fetch from GitHub via axios (10s timeout), validate response structure
4. Save to cache atomically (temp file + rename, mode 0o600)
5. Return `Map<pluginId, count>` or `null` on failure (UI hides counts rather than showing zeros)

`formatInstallCount` formats numbers for display: raw below 1000, `K` suffix for thousands, `M` for millions.

### Hint-Based Plugin Recommendations

`hintRecommendation.ts` surfaces plugin suggestions when CLIs/SDKs emit `<claude-code-hint />` tags to stderr:

**Pre-store gate** (`maybeRecordPluginHint`, synchronous — called from shell tools):
- Feature-gated behind `tengu_lapis_finch`
- Drops hints if: dialog already shown this session, hints disabled, shown-plugins list exceeds 100, plugin ID doesn't parse, marketplace isn't official, plugin already installed, already tried this session, or blocked by policy

**Async resolution** (`resolvePluginHint`): Looks up the plugin in the marketplace cache and returns a `PluginHintRecommendation` with name, description, and source command.

State persists in `GlobalConfig.claudeCodeHints` with show-once semantics per plugin and a global disable flag.

### Orphaned Plugin Filter

`orphanedPluginFilter.ts` generates ripgrep `--glob` exclusion patterns so search tools don't return results from stale plugin versions:

1. Uses ripgrep to find `.orphaned_at` marker files within `~/.claude/plugins/cache/` (max depth 4)
2. Converts each marker's parent directory to a `!**/<relative-path>/**` exclusion pattern
3. Caches the result for the session (cleared only by `/reload-plugins`)
4. Short-circuits if the search path doesn't overlap the plugin cache directory

### Add-Dir Plugin Settings

`addDirPluginSettings.ts` reads `enabledPlugins` and `extraKnownMarketplaces` from `--add-dir` directories (lowest priority). For each directory, it checks both `settings.json` and `settings.local.json` (local wins within the same dir). Callers must spread standard settings on top.

## Function Signatures

### pluginDirectories.ts

| Function | Signature | Description |
|----------|-----------|-------------|
| `getPluginsDirectory` | `(): string` | Returns the full plugin directory path, respecting `CLAUDE_CODE_PLUGIN_CACHE_DIR` override |
| `getPluginSeedDirs` | `(): string[]` | Returns read-only seed directories from `CLAUDE_CODE_PLUGIN_SEED_DIR` (PATH-delimited) |
| `getPluginDataDir` | `(pluginId: string): string` | Returns and creates the persistent per-plugin data directory |
| `pluginDataDirPath` | `(pluginId: string): string` | Pure path computation (no mkdir) for display purposes |
| `getPluginDataDirSize` | `(pluginId: string): Promise<{bytes, human} \| null>` | Recursive size calculation for uninstall confirmation |
| `deletePluginDataDir` | `(pluginId: string): Promise<void>` | Best-effort cleanup on last-scope uninstall |

### pluginOptionsStorage.ts

| Function | Signature | Description |
|----------|-----------|-------------|
| `loadPluginOptions` | `(pluginId: string): PluginOptionValues` | Memoized load merging settings + secure storage |
| `savePluginOptions` | `(pluginId, values, schema): void` | Split-save by sensitivity; secure storage first |
| `deletePluginOptions` | `(pluginId: string): void` | Remove all stored options (both stores) on last uninstall |
| `getUnconfiguredOptions` | `(plugin: LoadedPlugin): PluginOptionSchema` | Returns schema slice for options that need user input |
| `substitutePluginVariables` | `(value, plugin): string` | Replace `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` |
| `substituteUserConfigVariables` | `(value, userConfig): string` | Replace `${user_config.KEY}` — throws on missing keys |
| `substituteUserConfigInContent` | `(content, options, schema): string` | Content-safe variant: redacts sensitive keys, leaves unknown keys literal |

### pluginVersioning.ts

| Function | Signature | Description |
|----------|-----------|-------------|
| `calculatePluginVersion` | `(pluginId, source, manifest?, installPath?, providedVersion?, gitCommitSha?): Promise<string>` | Multi-source version resolution |
| `getVersionFromPath` | `(installPath: string): string \| null` | Extract version segment from a cache path |
| `isVersionedPath` | `(path: string): boolean` | Check if a path follows versioned cache structure |

### refresh.ts

| Function | Signature | Description |
|----------|-----------|-------------|
| `refreshActivePlugins` | `(setAppState: SetAppState): Promise<RefreshActivePluginsResult>` | Full hot-swap of all active plugin components |

### installCounts.ts

| Function | Signature | Description |
|----------|-----------|-------------|
| `getInstallCounts` | `(): Promise<Map<string, number> \| null>` | Fetch/cache install counts; null on failure |
| `formatInstallCount` | `(count: number): string` | Format for display (e.g., "1.2K", "36.2M") |

## Type Definitions

### `RefreshActivePluginsResult`

Returned by `refreshActivePlugins` with counts for all component types:

| Field | Type | Description |
|-------|------|-------------|
| `enabled_count` | `number` | Plugins successfully loaded |
| `disabled_count` | `number` | Plugins present but disabled |
| `command_count` | `number` | Slash commands from plugins |
| `agent_count` | `number` | Agent definitions from plugins |
| `hook_count` | `number` | Hooks registered from plugins |
| `mcp_count` | `number` | MCP servers from plugins |
| `lsp_count` | `number` | LSP servers from plugins |
| `error_count` | `number` | Errors encountered during refresh |
| `agentDefinitions` | `AgentDefinitionsResult` | Refreshed agent definitions |
| `pluginCommands` | `Command[]` | Refreshed plugin commands |

### `PluginFetchSource` / `PluginFetchOutcome`

Telemetry enums for network fetch classification:
- **Sources**: `'install_counts'`, `'marketplace_clone'`, `'marketplace_pull'`, `'marketplace_url'`, `'plugin_clone'`, `'mcpb'`
- **Outcomes**: `'success'`, `'failure'`, `'cache_hit'`

### `PluginHintRecommendation`

Resolved hint data for the recommendation UI: `pluginId`, `pluginName`, `marketplaceName`, `pluginDescription?`, `sourceCommand`.

## Configuration & Defaults

| Variable / Setting | Purpose | Default |
|--------------------|---------|---------|
| `CLAUDE_CODE_PLUGIN_CACHE_DIR` | Override plugin directory path | `~/.claude/plugins` |
| `CLAUDE_CODE_USE_COWORK_PLUGINS` | Use cowork plugin directory | `false` |
| `CLAUDE_CODE_PLUGIN_SEED_DIR` | Read-only seed directories (PATH-delimited) | unset |
| `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` | Enable ZIP-based cache for containers | `false` |
| Install counts cache TTL | How long cached counts are valid | 24 hours |
| Orphan cleanup age | Time before orphaned versions are deleted | 7 days |
| Max shown hint plugins | Config growth cap for hint history | 100 |

## Edge Cases & Caveats

- **Tilde expansion**: `CLAUDE_CODE_PLUGIN_CACHE_DIR` set via `settings.json` env (not shell) won't have `~` expanded — `expandTilde` is called explicitly to prevent literal `~` directories in the cwd (gh-30794 / CC-212)
- **macOS xcrun shim**: `checkGitAvailable` uses PATH lookup (no exec), so the macOS `/usr/bin/git` xcrun shim passes even without Xcode CLT. Callers that hit `xcrun: error:` at exec time must call `markGitUnavailable()` to short-circuit for the rest of the session
- **ZIP exec bits**: fflate doesn't surface `external_attr` — the extraction code separately parses the ZIP central directory to recover Unix mode bits so hooks/scripts retain `+x`
- **Windows inode precision**: ZIP file collection uses `bigint: true` for stat to prevent inode collision on NTFS where high MFT sequence numbers exceed `Number.MAX_SAFE_INTEGER`
- **Telemetry DNS ordering**: `classifyFetchError` checks DNS errors before timeout because git clone error enhancement rewrites DNS failures to include "timeout"
- **Secure storage ordering**: `savePluginOptions` writes to keychain first — if it fails, settings.json is untouched so existing plaintext values serve as fallback
- **Refresh sequencing**: `loadAllPlugins()` must complete before `getPluginCommands`/`getAgentDefinitions` because the latter use a separate `loadAllPluginsCacheOnly` memoize that depends on the warmed cache
- **Orphan GC skipped in zip mode**: The directory-walking cleanup would incorrectly delete ZIP files since `readSubdirs` filters to directories only