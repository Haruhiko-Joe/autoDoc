# Schemas and Types

## Overview & Responsibilities

The **SchemasAndTypes** module is the foundational data contract layer of the plugin system. It sits within **Infrastructure → CoreUtilities → PluginHelpers** and is imported by nearly every other sub-unit in the plugin subsystem. It defines all Zod validation schemas for plugin-related data structures, exports inferred TypeScript types, and provides a small set of pure utility functions for plugin identifier parsing, org-policy blocking checks, and managed plugin name resolution.

The module spans four files:

| File | Purpose |
|------|---------|
| `schemas.ts` | All Zod schemas + type exports + marketplace name security |
| `pluginIdentifier.ts` | Plugin ID parsing (`name@marketplace`), scope/source mapping |
| `pluginPolicy.ts` | Org-policy plugin blocking check |
| `managedPlugins.ts` | Resolves which plugin names are locked by managed settings |

Sibling modules in PluginHelpers (discovery, installation, caching, telemetry, recommendations) all depend on the types and schemas defined here.

## Key Processes

### Plugin Identifier Lifecycle

Plugin identifiers follow the `name@marketplace` format. The parsing and construction flow works as follows:

1. `parsePluginIdentifier()` splits a string on the first `@` → `{ name, marketplace? }` (`pluginIdentifier.ts:51-57`)
2. `buildPluginId()` reassembles name and optional marketplace into a canonical string (`pluginIdentifier.ts:65-67`)
3. `isOfficialMarketplaceName()` checks whether a marketplace belongs to the allow-list of Anthropic-controlled names — used to decide telemetry redaction rules (`pluginIdentifier.ts:75-82`)

### Scope ↔ Settings Source Mapping

Plugins are installed at one of four scopes (`managed`, `user`, `project`, `local`) plus a transient `flag` scope for session-only plugins. The identifier module provides bidirectional mapping between these scopes and the settings system:

1. `SETTING_SOURCE_TO_SCOPE` maps every `SettingSource` to an `ExtendedPluginScope` (`pluginIdentifier.ts:26-32`)
2. `scopeToSettingSource()` converts a `PluginScope` to an `EditableSettingSource`, throwing if `managed` is passed since managed plugins cannot be user-installed (`pluginIdentifier.ts:104-111`)
3. `settingSourceToScope()` performs the reverse mapping for editable sources (`pluginIdentifier.ts:119-123`)

### Marketplace Name Security Validation

The schemas enforce multi-layer protection against marketplace name impersonation:

1. **Allow-list check**: `ALLOWED_OFFICIAL_MARKETPLACE_NAMES` contains 8 reserved names for Anthropic official marketplaces (`schemas.ts:19-28`)
2. **Impersonation pattern**: `BLOCKED_OFFICIAL_NAME_PATTERN` catches names like "official-claude-plugins" or "anthropic-marketplace-new" (`schemas.ts:71-72`)
3. **Homograph attack prevention**: `NON_ASCII_PATTERN` blocks Unicode lookalike characters (`schemas.ts:79`)
4. **Source org verification**: `validateOfficialNameSource()` ensures reserved names only come from `anthropics/` GitHub repos, supporting both HTTPS and SSH URL formats (`schemas.ts:119-157`)
5. **Combined check**: `isBlockedOfficialName()` orchestrates allow-list → non-ASCII → pattern checks (`schemas.ts:87-101`)
6. **Schema-level enforcement**: `MarketplaceNameSchema` integrates all checks plus reserved word rejection (`inline`, `builtin`) (`schemas.ts:216-246`)

### Org-Policy Plugin Blocking

`isPluginBlockedByPolicy()` reads `policySettings.enabledPlugins` and returns `true` when a plugin is explicitly set to `false` (`pluginPolicy.ts:17-20`). This is the single source of truth for policy blocking, used at the install chokepoint, enable operation, and UI filters.

### Managed Plugin Name Resolution

`getManagedPluginNames()` scans `policySettings.enabledPlugins` for boolean entries in `name@marketplace` format and extracts the set of plugin names locked by org policy (`managedPlugins.ts:9-27`). Returns `null` when no policy is in effect (common case). Legacy `owner/repo` array-form entries are intentionally skipped.

## Function Signatures & Parameters

### `pluginIdentifier.ts`

#### `parsePluginIdentifier(plugin: string): ParsedPluginIdentifier`
Splits on the first `@`. Returns `{ name, marketplace? }`. Multiple `@` symbols cause everything after the second to be ignored.

#### `buildPluginId(name: string, marketplace?: string): string`
Returns `"name@marketplace"` or `"name"` if no marketplace provided.

#### `isOfficialMarketplaceName(marketplace: string | undefined): boolean`
Case-insensitive check against the official marketplace allow-list.

#### `scopeToSettingSource(scope: PluginScope): EditableSettingSource`
Throws if `scope === 'managed'`.

#### `settingSourceToScope(source: EditableSettingSource): Exclude<PluginScope, 'managed'>`
Inverse of `scopeToSettingSource`.

### `pluginPolicy.ts`

#### `isPluginBlockedByPolicy(pluginId: string): boolean`
Returns `true` when `policySettings.enabledPlugins[pluginId] === false`.

### `managedPlugins.ts`

#### `getManagedPluginNames(): Set<string> | null`
Returns the set of plugin names governed by org policy, or `null` when no policy entries exist.

### `schemas.ts` — Utility Functions

#### `isMarketplaceAutoUpdate(marketplaceName: string, entry: { autoUpdate?: boolean }): boolean`
Returns `entry.autoUpdate` if set; otherwise defaults to `true` for official marketplaces (except those in `NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES`), `false` for third-party.

#### `isBlockedOfficialName(name: string): boolean`
Returns `true` if the name impersonates an official marketplace (unless it's in the allow-list).

#### `validateOfficialNameSource(name, source): string | null`
Returns an error message if a reserved name comes from an unauthorized source, `null` if valid.

#### `isLocalPluginSource(source: PluginSource): source is string`
Type guard: returns `true` if the source is a relative path string (`./...`).

#### `isLocalMarketplaceSource(source: MarketplaceSource): boolean`
Returns `true` for `file` or `directory` source types (user-controlled local paths, read-only).

## Schema Hierarchy

The schemas form a layered architecture, each building on smaller pieces:

```
PluginManifestSchema (top-level plugin.json)
├── PluginManifestMetadataSchema (name, version, author, dependencies)
│   ├── PluginAuthorSchema
│   └── DependencyRefSchema (string or object form, version-stripped)
├── PluginManifestHooksSchema → HooksSchema (from schemas/hooks.js)
├── PluginManifestCommandsSchema → CommandMetadataSchema
├── PluginManifestAgentsSchema
├── PluginManifestSkillsSchema
├── PluginManifestOutputStylesSchema
├── PluginManifestChannelsSchema → PluginUserConfigOptionSchema
├── PluginManifestMcpServerSchema → McpServerConfigSchema
├── PluginManifestLspServerSchema → LspServerConfigSchema
├── PluginManifestSettingsSchema
└── PluginManifestUserConfigSchema → PluginUserConfigOptionSchema

PluginMarketplaceSchema (marketplace.json)
├── MarketplaceNameSchema (shared validation)
├── PluginAuthorSchema
└── PluginMarketplaceEntrySchema
    ├── PluginManifestSchema().partial() (extends)
    └── PluginSourceSchema (relative path | npm | pip | url | github | git-subdir)

MarketplaceSourceSchema (where to fetch marketplaces from)
└── discriminatedUnion: url | github | git | npm | file | directory | hostPattern | pathPattern | settings

InstalledPluginsFileSchema
├── V1: plugin ID → single InstalledPluginSchema
└── V2: plugin ID → array of PluginInstallationEntrySchema (multi-scope)

KnownMarketplacesFileSchema
└── Record<string, KnownMarketplaceSchema>
```

## Type Definitions

All types are inferred from their corresponding Zod schemas via `z.infer<>`:

| Type | Description |
|------|-------------|
| `PluginManifest` | Full plugin.json structure |
| `PluginManifestChannel` | Single channel entry from manifest |
| `PluginMarketplace` | Complete marketplace.json structure |
| `PluginMarketplaceEntry` | Single plugin listing in a marketplace |
| `PluginSource` | Union of all plugin source formats (relative path, npm, pip, url, github, git-subdir) |
| `MarketplaceSource` | Union of all marketplace source formats (url, github, git, npm, file, directory, hostPattern, pathPattern, settings) |
| `PluginId` | String matching `plugin@marketplace` regex |
| `PluginScope` | `'managed' \| 'user' \| 'project' \| 'local'` |
| `ExtendedPluginScope` | `PluginScope \| 'flag'` (includes session-only) |
| `PersistablePluginScope` | `Exclude<ExtendedPluginScope, 'flag'>` |
| `ParsedPluginIdentifier` | `{ name: string; marketplace?: string }` |
| `InstalledPlugin` | V1 installation metadata (version, timestamps, paths) |
| `PluginInstallationEntry` | V2 installation metadata (adds scope, projectPath) |
| `InstalledPluginsFileV1` | `{ version: 1, plugins: Record<PluginId, InstalledPlugin> }` |
| `InstalledPluginsFileV2` | `{ version: 2, plugins: Record<PluginId, PluginInstallationEntry[]> }` |
| `KnownMarketplace` | Marketplace registry entry (source, cache path, timestamps) |
| `KnownMarketplacesFile` | `Record<string, KnownMarketplace>` |
| `CommandMetadata` | Command definition with source/content, description, model, allowedTools |
| `PluginAuthor` | `{ name: string; email?: string; url?: string }` |

## Configuration & Defaults

### Plugin User Config Options (`PluginUserConfigOptionSchema`)

Plugins can declare user-configurable options in `plugin.json` under `userConfig`. Each option specifies:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `'string' \| 'number' \| 'boolean' \| 'directory' \| 'file'` | yes | Value type |
| `title` | `string` | yes | Dialog label |
| `description` | `string` | yes | Help text |
| `required` | `boolean` | no | Fail validation when empty |
| `default` | `string \| number \| boolean \| string[]` | no | Fallback value |
| `sensitive` | `boolean` | no | Stores in keychain instead of settings.json |
| `multiple` | `boolean` | no | Allow array of strings |
| `min` / `max` | `number` | no | Bounds for number type |

Non-sensitive values are saved to `settings.json` under `pluginConfigs[pluginId].options`; sensitive values go to macOS Keychain or `.credentials.json`. Values are available as `${user_config.KEY}` in MCP/LSP config, hook commands, and skill/agent content.

### Auto-Update Defaults

- Official Anthropic marketplaces: auto-update enabled by default
- Exception: `knowledge-work-plugins` opts out of auto-update
- Third-party marketplaces: auto-update disabled by default
- Any marketplace can override via the `autoUpdate` field

### Installed Plugins File Versions

The installed plugins file supports both V1 (single installation per plugin) and V2 (multi-scope array per plugin). `InstalledPluginsFileSchema` accepts either format for backward-compatible reading; migration to V2 happens at startup.

## Edge Cases & Caveats

- **Multiple `@` in identifiers**: `parsePluginIdentifier("a@b@c")` returns `{ name: "a", marketplace: "b" }` — everything after the second `@` is silently dropped. This is intentional since marketplace names should not contain `@`.

- **`DependencyRefSchema` strips versions**: Trailing `@^version` suffixes and object-form version fields are silently removed by the Zod transform. This is a forwards-compatibility measure so future version-constraint features don't break older clients (see CC-993).

- **`managed` scope is read-only**: `scopeToSettingSource('managed')` throws. Managed plugins come from org policy and cannot be installed/uninstalled by users.

- **`flag` scope is session-only**: Plugins from `--settings` CLI flags are never persisted to `installed_plugins.json`.

- **Schema strictness is intentionally asymmetric**: Top-level unknown fields in `PluginManifestSchema` and `PluginMarketplaceEntrySchema` are silently stripped (for forward compatibility), but nested config objects (`userConfig`, `channels`, `lspServers`) use strict mode to catch typos.

- **Settings-sourced marketplace plugins must be remote**: `SettingsMarketplacePluginSchema` rejects relative paths (`"./foo"`) because there's no marketplace repository to resolve them against.

- **`pluginPolicy.ts` is deliberately a leaf module**: It only imports from `settings` to avoid circular dependencies with the rest of the plugin subsystem.

- **`getManagedPluginNames()` skips legacy format**: Only boolean entries in `name@marketplace` format are recognized. Legacy `owner/repo` array-form entries in `enabledPlugins` are ignored.

- **Sensitive config limit**: Sensitive user config values share a single keychain entry with OAuth tokens. Keep secret counts small to stay under the ~2KB stdin-safe limit (see INC-3028).