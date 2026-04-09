# Marketplace Management

## Overview & Responsibilities

The Marketplace Management module is the central hub for all marketplace-related operations in Claude Code's plugin system. It sits within **Infrastructure > CoreUtilities > PluginHelpers** and is responsible for the complete lifecycle of marketplace sources — from parsing user input and enforcing enterprise policies, to cloning git repositories, caching manifests, and reconciling desired state (declared in settings) with on-disk state (`known_marketplaces.json`).

A "marketplace" is a curated collection of plugins, defined by a `marketplace.json` manifest. Marketplaces can be sourced from GitHub repos, arbitrary git URLs, HTTP endpoints, local files/directories, or inline settings. The module manages a two-layer architecture:

- **Intent layer**: What marketplaces *should* exist, declared in settings (`extraKnownMarketplaces`) and implicit built-in sources.
- **State layer**: What marketplaces *actually* exist on disk, tracked in `~/.claude/plugins/known_marketplaces.json`.

The module spans ~2,600 lines across 7 files:

| File | Responsibility |
|------|---------------|
| `marketplaceManager.ts` | Core CRUD operations, git clone/pull, caching, memoized access |
| `marketplaceHelpers.ts` | Policy validation, source comparison, display formatting |
| `officialMarketplace.ts` | Constants for the Anthropic official marketplace |
| `officialMarketplaceGcs.ts` | GCS mirror fetch for the official marketplace |
| `officialMarketplaceStartupCheck.ts` | Auto-install logic with retry/backoff |
| `parseMarketplaceInput.ts` | User input parsing (URLs, SSH, paths, shorthand) |
| `reconciler.ts` | Diff and sync between settings intent and on-disk state |

## Key Processes

### Adding a Marketplace Source

The primary entry point is `addMarketplaceSource()` (`marketplaceManager.ts:1782-1924`). The flow:

1. **Resolve paths** — relative `directory`/`file` paths are converted to absolute
2. **Policy check** — `isSourceAllowedByPolicy()` checks blocklist then allowlist before any network I/O
3. **Idempotency check** — scans `known_marketplaces.json` for an existing entry with the same source; returns early if found
4. **Fetch & cache** — delegates to `loadAndCacheMarketplace()` which dispatches by source type:
   - `github`: Probes SSH availability, tries SSH then HTTPS (or vice versa) with fallback
   - `git`: Clones directly from the provided URL
   - `url`: Downloads marketplace.json via HTTP
   - `file`/`directory`: Reads from local filesystem
   - `settings`: Synthesizes marketplace.json from inline plugin definitions
5. **Validate** — parses the manifest against `PluginMarketplaceSchema`
6. **Rename cache** — moves temp directory to `~/.claude/plugins/marketplaces/<name>` with path traversal protection
7. **Persist** — writes the entry to `known_marketplaces.json`

### Official Marketplace Auto-Install on Startup

`checkAndInstallOfficialMarketplace()` (`officialMarketplaceStartupCheck.ts:147-439`) runs fire-and-forget at startup:

1. **Retry gate** — checks `GlobalConfig` for previous attempts, respects exponential backoff (1 hour initial, 2x multiplier, 1 week max, 10 attempts max)
2. **Env var check** — `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` disables entirely
3. **Already installed?** — checks `known_marketplaces.json` for the official name
4. **Policy check** — enterprise policy can block the official marketplace
5. **GCS mirror** (preferred) — `fetchOfficialMarketplaceFromGcs()` downloads a pre-built zip from `downloads.claude.ai`, avoiding git entirely
6. **Git fallback** — if GCS fails and the feature flag allows, falls back to `addMarketplaceSource()` with git clone
7. **macOS xcrun shim detection** — recognizes the non-functional `/usr/bin/git` Xcode shim and skips without recording backoff state

### GCS Mirror Fetch

`fetchOfficialMarketplaceFromGcs()` (`officialMarketplaceGcs.ts:47-170`) implements a content-addressed download:

1. **Path safety** — refuses any `installLocation` outside the marketplaces cache directory
2. **Wait for scroll idle** — defers network I/O to avoid competing with UI rendering
3. **Fetch `latest` pointer** — a ~40-byte file containing the current SHA, cached by CDN for 5 minutes
4. **Sentinel check** — reads `.gcs-sha` in the install directory; if it matches, returns early (no-op)
5. **Download zip** — fetches `{sha}.zip` (~3.5MB), extracts with exec-bit preservation
6. **Atomic swap** — extracts to `.staging` directory, then `rm` old + `rename` staging into place
7. **Telemetry** — logs outcome, duration, bytes, and error classification

### Refreshing Marketplaces

`refreshMarketplace()` (`marketplaceManager.ts:2365-2575`) does in-place updates:

- For the official marketplace, tries GCS first, then git if the feature flag allows
- For `github` sources: uses SSH/HTTPS protocol detection with fallback
- For `git` sources: pulls directly from the URL
- For `url` sources: re-downloads to the existing file
- For local sources: validates the file still exists
- For `settings` sources: skips (no upstream; edits flow through the reconciler)
- Validates post-update that `marketplace.json` still exists (handles repo restructuring)

### Reconciliation: Settings Intent → On-Disk State

The reconciler (`reconciler.ts`) bridges the gap between what settings declare and what exists:

1. **`getDeclaredMarketplaces()`** (`marketplaceManager.ts:161-192`) merges three sources (lowest to highest precedence):
   - Implicit official marketplace (when any enabled plugin references it, with `sourceIsFallback: true`)
   - `--add-dir` extra marketplaces
   - Merged settings `extraKnownMarketplaces`

2. **`diffMarketplaces()`** (`reconciler.ts:50-83`) compares declared vs materialized:
   - `missing`: declared but absent from JSON
   - `sourceChanged`: present in both but source differs (unless `sourceIsFallback`)
   - `upToDate`: present and matching

3. **`reconcileMarketplaces()`** (`reconciler.ts:114-234`) processes the diff:
   - Calls `addMarketplaceSource()` for missing and changed entries
   - Skips local-path updates where the declared path doesn't exist (multi-checkout safety)
   - Reports progress via `onProgress` callback
   - Additive only — never deletes entries

### Input Parsing

`parseMarketplaceInput()` (`parseMarketplaceInput.ts:23-162`) converts user-provided strings into typed `MarketplaceSource` objects:

| Input Format | Result |
|-------------|--------|
| `git@host:path.git` / `user@host:path` | `{ source: 'git', url, ref? }` |
| `https://github.com/owner/repo` | `{ source: 'git', url }` (appends `.git`) |
| `https://.../_git/...` (Azure DevOps) | `{ source: 'git', url }` |
| `https://example.com/marketplace.json` | `{ source: 'url', url }` |
| `./path`, `/path`, `~/path` | `{ source: 'file' }` or `{ source: 'directory' }` |
| `owner/repo` or `owner/repo#ref` | `{ source: 'github', repo, ref? }` |

Supports `#ref` and `@ref` suffixes for branch/tag selection. Handles Windows paths (`C:\`, `.\`). Returns `{ error: string }` for invalid paths.

### Enterprise Policy Enforcement

`isSourceAllowedByPolicy()` (`marketplaceHelpers.ts:480-505`) enforces two policy mechanisms:

1. **Blocklist** (`blockedMarketplaces`) — checked first; if the source matches, it's blocked. Cross-references `github` and `git` source types to prevent bypass (e.g., blocking `owner/repo` also blocks `git@github.com:owner/repo.git`)
2. **Allowlist** (`strictKnownMarketplaces`) — if set, the source must appear in the list. Supports:
   - Exact source matching via `areSourcesEqual()`
   - `hostPattern`: regex matching against extracted hostname
   - `pathPattern`: regex matching against file/directory paths

## Function Signatures

### Core CRUD

#### `addMarketplaceSource(source, onProgress?)`
Fetches, validates, caches, and registers a marketplace. Returns `{ name, alreadyMaterialized, resolvedSource }`.

#### `removeMarketplaceSource(name)`
Removes marketplace config, cache files, settings entries, installed plugins, plugin options, and data directories. Blocks removal of seed-managed marketplaces.

#### `refreshMarketplace(name, onProgress?, options?)`
In-place update of a single marketplace. Clears memoization cache.

#### `refreshAllMarketplaces()`
Bulk refresh of all non-seed, non-settings marketplaces.

### Lookup

#### `getMarketplace(name)` — memoized
Reads from disk cache; re-fetches from source on cache miss/corruption. Throws on marketplace not found.

#### `getMarketplaceCacheOnly(name)`
Cache-only read, returns `null` on any error. Safe for startup paths.

#### `getPluginById(pluginId)` / `getPluginByIdCacheOnly(pluginId)`
Finds a plugin entry within a marketplace by `name@marketplace` ID format.

### Configuration

#### `loadKnownMarketplacesConfig()` / `loadKnownMarketplacesConfigSafe()`
Reads `known_marketplaces.json`. The safe variant returns `{}` on error (for read-only paths).

#### `saveKnownMarketplacesConfig(config)`
Validates and writes the config file.

#### `registerSeedMarketplaces()`
Syncs read-only seed directories into the primary config. Seed entries always win. Idempotent.

#### `setMarketplaceAutoUpdate(name, autoUpdate)`
Toggles auto-update flag in both state and intent layers.

### Git Operations

#### `gitClone(gitUrl, targetPath, ref?, sparsePaths?)`
Shallow clone with SSH `StrictHostKeyChecking=yes`, credential redaction, sparse-checkout support, and enhanced error messages for common failures.

> Source: `marketplaceManager.ts:803-985`

#### `gitPull(cwd, ref?, options?)`
Pull with fetch+checkout for specific refs, submodule sync, and configurable timeout via `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS` (default 120s).

> Source: `marketplaceManager.ts:528-582`

## Type Definitions

### `MarketplaceSource` (from `schemas.ts`)
Discriminated union with variants: `github`, `git`, `url`, `npm`, `file`, `directory`, `settings`, `hostPattern`, `pathPattern`.

### `KnownMarketplace`
```typescript
{
  source: MarketplaceSource
  installLocation: string   // Absolute path to cached content
  lastUpdated?: string       // ISO timestamp
  autoUpdate?: boolean
}
```

### `DeclaredMarketplace`
```typescript
{
  source: MarketplaceSource
  installLocation?: string
  autoUpdate?: boolean
  sourceIsFallback?: boolean  // Presence suffices; diffMarketplaces skips source comparison
}
```

### `MarketplaceDiff`
```typescript
{
  missing: string[]
  sourceChanged: Array<{ name, declaredSource, materializedSource }>
  upToDate: string[]
}
```

### `OfficialMarketplaceCheckResult`
```typescript
{
  installed: boolean
  skipped: boolean
  reason?: 'already_attempted' | 'already_installed' | 'policy_blocked'
           | 'git_unavailable' | 'gcs_unavailable' | 'unknown'
  configSaveFailed?: boolean
}
```

## Configuration & Defaults

| Setting / Env Var | Purpose | Default |
|---|---|---|
| `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS` | Git clone/pull timeout | `120000` (2 min) |
| `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` | Disables official marketplace auto-install | `false` |
| `CLAUDE_CODE_REMOTE` | Forces HTTPS-only for GitHub sources (no SSH in CCR) | — |
| `policySettings.strictKnownMarketplaces` | Allowlist of permitted marketplace sources | `null` (unrestricted) |
| `policySettings.blockedMarketplaces` | Blocklist of forbidden marketplace sources | `null` (none blocked) |
| `policySettings.pluginTrustMessage` | Custom trust message for enterprise | `undefined` |
| `extraKnownMarketplaces` (settings) | Declared marketplace sources | `{}` |

### File Layout
```
~/.claude/
  └── plugins/
      ├── known_marketplaces.json        # State: registered marketplaces
      └── marketplaces/                  # Cache directory
          ├── claude-plugins-official/   # Git clone (or GCS extract)
          │   ├── .claude-plugin/
          │   │   └── marketplace.json
          │   └── .gcs-sha              # GCS sentinel file
          ├── my-marketplace/            # Another git-sourced marketplace
          └── url-marketplace.json       # URL-sourced marketplace
```

### Official Marketplace Constants
- **Name**: `claude-plugins-official`
- **Source**: `{ source: 'github', repo: 'anthropics/claude-plugins-official' }`
- **GCS base URL**: `https://downloads.claude.ai/claude-code-releases/plugins/claude-plugins-official`

### Auto-Install Retry Config
- Max attempts: 10
- Initial delay: 1 hour
- Backoff multiplier: 2x
- Max delay: 1 week
- Permanent failure (no retry): `policy_blocked`

## Edge Cases & Caveats

- **Path traversal protection**: Both `loadAndCacheMarketplace()` and `fetchOfficialMarketplaceFromGcs()` verify that computed paths stay inside the cache directory before any `rm` operations. The schema also rejects path separators in marketplace names.

- **Corrupted `installLocation`**: A corrupted `known_marketplaces.json` (e.g., Windows paths on WSL, literal tildes) can point outside the cache dir. `refreshMarketplace()` detects this and throws with remediation instructions rather than operating on the wrong directory.

- **macOS xcrun shim**: `/usr/bin/git` exists on macOS even without Xcode CLT installed. The auto-install detects the `xcrun: error:` failure, poisons the memoized git availability check for the session, and skips without recording backoff state.

- **Seed marketplaces are immutable**: Seed-managed entries (baked into container images via `CLAUDE_CODE_PLUGIN_SEED_DIRS`) cannot be removed, refreshed, or have auto-update toggled. Appropriate error messages guide users to admin actions.

- **`sourceIsFallback` prevents overwriting mirrors**: The implicit official marketplace declaration uses `sourceIsFallback: true` so the reconciler won't report `sourceChanged` if a seed or internal mirror already materialized it under a different source.

- **Credential redaction**: All git URLs with embedded credentials (`https://user:token@host/...`) are redacted before logging or error output. Both username and password are masked because their roles can't be reliably distinguished.

- **Git submodule sync**: `gitPull()` runs `submodule update --init --recursive` after pull, but only when `.gitmodules` exists and the clone is not sparse. This was added to fix stale submodule working dirs after marketplace updates (gh-30696).

- **Sparse checkout support**: GitHub/git sources can specify `sparsePaths` for monorepo marketplaces. The clone uses `--filter=blob:none --no-checkout` followed by `sparse-checkout set --cone`. Transitioning from sparse to full requires a re-clone (partial clones can't `sparse-checkout disable` without fetching all blobs).

- **GCS vs Git fallback**: The official marketplace prefers the GCS mirror. A feature flag (`tengu_plugin_official_mkt_git_fallback`, default `true`) controls whether git clone is attempted when GCS fails. This will be flipped to `false` once the GCS backend is confirmed stable.

- **Settings-sourced marketplaces**: The `settings` source type embeds plugin definitions directly in settings JSON. These have no upstream to refresh — edits flow through the reconciler's `sourceChanged` detection via `isEqual` comparison.