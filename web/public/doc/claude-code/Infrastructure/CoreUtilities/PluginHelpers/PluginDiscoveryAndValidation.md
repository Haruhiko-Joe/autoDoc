# Plugin Discovery and Validation

## Overview & Responsibilities

This module is the core engine that powers Claude Code's plugin system. It sits within the **Infrastructure → CoreUtilities → PluginHelpers** layer and is responsible for three fundamental operations:

1. **Discovery & Loading** (`pluginLoader.ts`, ~3,300 lines) — Discovers plugins from marketplace registries, git repositories, npm packages, and local directories; caches plugin artifacts to a versioned on-disk cache; and assembles fully validated `LoadedPlugin` objects with resolved component paths, hooks, and settings.

2. **Schema Validation** (`validatePlugin.ts`, ~900 lines) — Provides deep validation of `plugin.json` and `marketplace.json` manifest files used by `claude plugin validate`. Checks JSON syntax, Zod schema conformance, path traversal security, frontmatter correctness in component markdown files, and hooks configuration.

3. **Dependency Resolution** (`dependencyResolver.ts`, ~300 lines) — Resolves transitive plugin dependency closures at install time (DFS with cycle detection) and verifies dependency satisfaction at load time (fixed-point demotion of plugins with missing deps).

Together, these three files form the pipeline that turns a user's `enabledPlugins` settings into a concrete set of loaded, validated, dependency-checked plugin objects ready for use by the rest of the CLI.

## Key Processes

### Plugin Loading Pipeline (Full Load)

The main entry point is `loadAllPlugins()` (`pluginLoader.ts:3096`), a memoized async function. Here is the end-to-end flow:

1. **Discover marketplace plugins** — `loadPluginsFromMarketplaces()` reads `enabledPlugins` from merged settings (including `--add-dir` plugins at lowest priority). Each entry in `plugin@marketplace` format is filtered, and enterprise policy checks (allowlist/blocklist) are applied. Marketplace catalogs are pre-loaded in bulk to avoid per-plugin I/O.

2. **Discover session plugins** — `loadSessionOnlyPlugins()` loads plugins from `--plugin-dir` CLI paths. These are always enabled and tagged with `@inline` as a synthetic marketplace sentinel.

3. **Load built-in plugins** — `getBuiltinPlugins()` returns plugins bundled with the CLI.

4. **Resolve each marketplace entry** — For each plugin, `loadPluginFromMarketplaceEntry()` handles the source type:
   - **Local relative path**: Resolves relative to the marketplace install location, copies to versioned cache via `copyPluginToVersionedCache()`.
   - **External source** (npm, github, url, git-subdir): Probes versioned cache → ZIP cache → seed cache. On miss, calls `cachePlugin()` which downloads to a temp directory, then moves to versioned cache.

5. **Assemble LoadedPlugin** — `createPluginFromPath()` (`pluginLoader.ts:1348`) reads the manifest, auto-detects component directories (commands, agents, skills, output-styles, hooks), validates all declared paths exist, loads and merges hook configurations, and loads plugin settings.

6. **Merge sources** — `mergePluginSources()` deduplicates: session plugins override marketplace plugins by name, except when managed settings (enterprise policy) lock a plugin.

7. **Verify dependencies** — `verifyAndDemote()` runs a fixed-point loop to disable any plugin whose dependencies are unsatisfied.

8. **Cache settings** — `cachePluginSettings()` merges settings from all enabled plugins into a synchronous cache for the settings cascade.

### Cache-Only Load Path

`loadAllPluginsCacheOnly()` (`pluginLoader.ts:3137`) follows the same pipeline but skips all network operations. It reads from `installed_plugins.json` install paths and emits `plugin-cache-miss` errors for plugins not on disk. This is used during interactive startup to avoid blocking on git clones.

### Plugin Caching Strategy

The versioned cache layout is:
```
~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
```

Path computation (`getVersionedCachePath`, `pluginLoader.ts:172`) sanitizes all segments to prevent path traversal. The system supports:

- **Versioned directory cache** — the default
- **ZIP cache** — when enabled, directories are converted to `.zip` files and extracted to session-scoped temp dirs at load time
- **Seed cache** — read-only pre-populated caches (e.g., CCR container images) probed before network fetch
- **Legacy cache** — flat `~/.claude/plugins/cache/{plugin-name}/` for backward compatibility

Version is calculated with a fallback chain: manifest version → marketplace entry version → git commit SHA → `'unknown'`.

### Git Clone Strategies

The loader supports several git installation methods:

- **Full clone** (`gitClone`, `pluginLoader.ts:534`): Shallow `--depth 1` clone with `--recurse-submodules`. If a specific SHA is needed, fetches it separately (shallow first, unshallow fallback).
- **Sparse checkout** (`installFromGitSubdir`, `pluginLoader.ts:718`): Uses `--filter=tree:0 --no-checkout` + `sparse-checkout set --cone` to download only the needed subdirectory from monorepos. Resolves the commit SHA before discarding the clone directory.
- **GitHub shorthand**: `owner/repo` format auto-expands to SSH (`git@github.com:`) or HTTPS based on `CLAUDE_CODE_REMOTE`.

### Dependency Resolution at Install Time

`resolveDependencyClosure()` (`dependencyResolver.ts:95`) performs a DFS walk:

1. Start from the root plugin ID
2. For each dependency, qualify bare names against the declaring plugin's marketplace via `qualifyDependency()`
3. **Security boundary**: Cross-marketplace dependencies are blocked unless the root marketplace's `allowCrossMarketplaceDependenciesOn` allowlist permits it
4. Already-enabled dependencies are skipped (no surprise settings writes)
5. Cycle detection via a stack — returns the cycle chain on detection
6. The returned closure is in dependency-first (topological) order

```typescript
// dependencyResolver.ts:58-67
export type ResolutionResult =
  | { ok: true; closure: PluginId[] }
  | { ok: false; reason: 'cycle'; chain: PluginId[] }
  | { ok: false; reason: 'not-found'; missing: PluginId; requiredBy: PluginId }
  | { ok: false; reason: 'cross-marketplace'; dependency: PluginId; requiredBy: PluginId }
```

### Dependency Verification at Load Time

`verifyAndDemote()` (`dependencyResolver.ts:177`) runs after all plugins are loaded:

1. Builds enabled and known sets (both by full ID and by bare name for `@inline` plugins)
2. Iterates in a fixed-point loop: for each enabled plugin, checks all declared dependencies
3. Bare dependencies from `@inline` plugins are matched by name only (since `inline` is a synthetic sentinel)
4. If any dependency is unsatisfied, the plugin is demoted (disabled) and the loop restarts — demoting A may break B that depends on A
5. Returns the set of demoted plugin IDs plus structured errors distinguishing `'not-enabled'` vs `'not-found'`

### Manifest Validation Flow

`validateManifest()` (`validatePlugin.ts:814`) is the top-level entry point for `claude plugin validate`:

1. **Auto-detect type**: By filename (`plugin.json` vs `marketplace.json`), by directory structure (`.claude-plugin/`), or by content heuristic (presence of `plugins` array)
2. **Schema validation**: Uses `.strict()` variants of Zod schemas (stricter than runtime, which silently strips unknown keys) to catch typos
3. **Security checks**: Path traversal detection in component paths and source fields, with context-aware hints (marketplace source paths resolve from repo root, not from `marketplace.json`)
4. **Cross-file consistency**: For local marketplace entries with declared versions, reads the plugin's `plugin.json` to detect version mismatches
5. **Component validation**: `validatePluginContents()` scans skills, agents, commands directories and validates YAML frontmatter in each `.md` file, plus `hooks/hooks.json` schema

## Function Signatures

### pluginLoader.ts — Core API

#### `loadAllPlugins(): Promise<PluginLoadResult>`
Memoized main entry point. Discovers, loads, caches, and validates all plugins from all sources. Returns `{ enabled, disabled, errors }`.

#### `loadAllPluginsCacheOnly(): Promise<PluginLoadResult>`
Same as above but never hits the network. Reads from on-disk cache. Falls back to `loadAllPlugins()` when `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`.

#### `clearPluginCache(reason?: string): void`
Invalidates both memoized loaders and clears plugin settings cache. Call after install/uninstall/settings changes.

#### `createPluginFromPath(pluginPath, source, enabled, fallbackName, strict?): Promise<{ plugin: LoadedPlugin; errors: PluginError[] }>`
Assembles a `LoadedPlugin` from a directory. Loads manifest, detects components, validates paths, loads hooks and settings. (`pluginLoader.ts:1348`)

#### `loadPluginManifest(manifestPath, pluginName, source): Promise<PluginManifest>`
Reads and validates `plugin.json`. Returns a default manifest if file is missing. Throws on invalid JSON or schema failure. (`pluginLoader.ts:1147`)

#### `cachePlugin(source, options?): Promise<{ path, manifest, gitCommitSha? }>`
Downloads a plugin from an external source (local/npm/github/url/git-subdir) to a temp directory, reads its manifest, and renames to a final cache path. (`pluginLoader.ts:911`)

#### `copyPluginToVersionedCache(sourcePath, pluginId, version, entry?, marketplaceDir?): Promise<string>`
Copies plugin files to the versioned cache. Handles seed cache hits, ZIP conversion, and `.git` directory removal. (`pluginLoader.ts:365`)

#### `mergePluginSources({ session, marketplace, builtin, managedNames? }): { plugins, errors }`
Deduplicates across sources. Session overrides marketplace (unless managed). (`pluginLoader.ts:3009`)

### validatePlugin.ts — Validation API

#### `validateManifest(filePath): Promise<ValidationResult>`
Auto-detecting entry point. Accepts files or directories. (`validatePlugin.ts:814`)

#### `validatePluginManifest(filePath): Promise<ValidationResult>`
Validates a `plugin.json` file with strict schema, marketplace-only field warnings, and kebab-case name check. (`validatePlugin.ts:129`)

#### `validateMarketplaceManifest(filePath): Promise<ValidationResult>`
Validates a `marketplace.json` with strict schema (including strict entries), duplicate name detection, and version mismatch checks. (`validatePlugin.ts:310`)

#### `validatePluginContents(pluginDir): Promise<ValidationResult[]>`
Scans skills/, agents/, commands/ directories and hooks/hooks.json. Returns one `ValidationResult` per file with issues. (`validatePlugin.ts:763`)

### dependencyResolver.ts — Dependency API

#### `resolveDependencyClosure(rootId, lookup, alreadyEnabled, allowedCrossMarketplaces?): Promise<ResolutionResult>`
Install-time DFS. Returns the closure to install or an error (cycle/not-found/cross-marketplace). (`dependencyResolver.ts:95`)

#### `verifyAndDemote(plugins): { demoted: Set<string>; errors: PluginError[] }`
Load-time fixed-point verification. Returns IDs to demote and diagnostic errors. (`dependencyResolver.ts:177`)

#### `qualifyDependency(dep, declaringPluginId): string`
Normalizes bare dependency names to `name@marketplace` form. `@inline` plugins' bare deps are left bare. (`dependencyResolver.ts:38`)

#### `findReverseDependents(pluginId, plugins): string[]`
Returns names of enabled plugins that depend on `pluginId`. Used to warn on uninstall/disable. (`dependencyResolver.ts:244`)

#### `getEnabledPluginIdsForScope(settingSource): Set<PluginId>`
Builds the set of currently enabled plugin IDs at a settings scope. Matches both `true` and array (version constraint) values. (`dependencyResolver.ts:275`)

## Type Definitions

### `ResolutionResult` (dependencyResolver.ts:58)

Discriminated union for dependency resolution outcomes:

| Variant | Fields | Meaning |
|---------|--------|---------|
| `ok: true` | `closure: PluginId[]` | All deps resolved; closure is install order |
| `reason: 'cycle'` | `chain: PluginId[]` | Circular dependency detected |
| `reason: 'not-found'` | `missing`, `requiredBy` | Dependency not in marketplace |
| `reason: 'cross-marketplace'` | `dependency`, `requiredBy` | Blocked cross-marketplace auto-install |

### `ValidationResult` (validatePlugin.ts:32)

```typescript
type ValidationResult = {
  success: boolean
  errors: ValidationError[]    // { path, message, code? }
  warnings: ValidationWarning[] // { path, message }
  filePath: string
  fileType: 'plugin' | 'marketplace' | 'skill' | 'agent' | 'command' | 'hooks'
}
```

### `PluginLoadResult`

Returned by `loadAllPlugins()`:
- `enabled: LoadedPlugin[]` — plugins active for this session
- `disabled: LoadedPlugin[]` — plugins present but disabled
- `errors: PluginError[]` — non-fatal loading errors

## Configuration & Defaults

- **`enabledPlugins`** (settings): Map of `"name@marketplace": true | false | string[]`. Drives which plugins are discovered.
- **`CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`**: Forces cache-only loader to delegate to full loader (blocking installs before first query). Used in headless/CCR modes.
- **`CLAUDE_CODE_REMOTE`**: When truthy, git URLs use HTTPS instead of SSH (for environments without SSH keys).
- **Plugin seed directories** (`getPluginSeedDirs()`): Pre-populated read-only caches, checked before network fetch.
- **ZIP cache** (`isPluginZipCacheEnabled()`): When enabled, cached plugins are stored as `.zip` files and extracted per-session.
- **Enterprise policy**: `strictKnownMarketplaces` (allowlist) and `blockedMarketplaces` (blocklist) gate which marketplace sources are permitted. Fail-closed when policy is active but source is unresolvable.
- **Managed plugin names**: Plugins locked by enterprise `policySettings` cannot be overridden by `--plugin-dir`.

## Edge Cases & Caveats

- **Re-installing an already-enabled plugin**: The root plugin is never skipped in `resolveDependencyClosure()` even if already enabled — otherwise re-installing a plugin with a cleared cache would return an empty closure and nothing would be cached (`dependencyResolver.ts:117`).

- **Version mismatch trap**: `calculatePluginVersion` prefers `manifest.version` over `entry.version`. A stale marketplace entry version is silently ignored at install time but shown in marketplace UI — `validateMarketplaceManifest` warns about this (`validatePlugin.ts:478`).

- **Cross-marketplace security**: A plugin from marketplace A cannot auto-install dependencies from marketplace B. The user must manually install cross-marketplace deps first (they become "already-enabled" and are skipped by the resolver).

- **Bare dependencies from `@inline` plugins**: Since `inline` is a synthetic sentinel (not a real marketplace), bare deps are matched by name only against any enabled plugin, regardless of marketplace. This uses a multiset to correctly handle multiple plugins with the same name across marketplaces (`dependencyResolver.ts:186`).

- **Fixed-point demotion cascade**: Demoting plugin A at load time may break plugin B that depends on A. The `verifyAndDemote` loop continues until no more plugins are demoted. Demotion is session-local and does NOT write settings.

- **Path traversal protection**: All cache paths are sanitized (`[^a-zA-Z0-9\-_]` → `-`). Plugin manifest component paths are checked for `..` segments. `validatePathWithinBase` is used before extracting git subdirectories.

- **Strict vs non-strict marketplace mode**: When `entry.strict` is true (default) and a plugin has both `plugin.json` and marketplace entry component declarations, the plugin is rejected as a conflict. In strict mode, `plugin.json` is the single source of truth.

- **Hooks deduplication**: If `manifest.hooks` points to `hooks/hooks.json` (which is auto-loaded), the duplicate is detected via `realpath` comparison and reported as an error in strict mode (`pluginLoader.ts:1690`).

- **Enterprise fail-closed**: If enterprise policy is configured but a marketplace source cannot be resolved (corrupted `known_marketplaces.json`), the plugin is blocked rather than loaded unchecked (`pluginLoader.ts:1982`).