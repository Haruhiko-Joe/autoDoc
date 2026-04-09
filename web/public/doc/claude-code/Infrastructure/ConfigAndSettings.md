# ConfigAndSettings

## Overview & Responsibilities

The ConfigAndSettings module is the configuration backbone of Claude Code, sitting within the **Infrastructure** layer that every other module depends on. It implements a multi-source settings hierarchy that loads, validates, merges, and caches configuration from multiple sources with strict precedence rules. It also manages the global/project config persistence file (`~/.claude.json`), early CLI argument parsing, environment variable management, MDM (Mobile Device Management) policy enforcement, live settings change detection, and tool/permission validation.

At a high level, the module serves two distinct but related purposes:

1. **Settings system** (`src/utils/settings/`): A structured, validated, multi-source configuration pipeline using Zod schemas. This handles user preferences, project settings, enterprise policies, and plugin configuration.
2. **Global config** (`src/utils/config.ts`): A JSON persistence layer (`~/.claude.json`) for mutable application state — session history, UI preferences, OAuth credentials, feature gate caches, and per-project metadata.

## Key Processes

### Settings Loading & Merge Flow

The core merge pipeline lives in `loadSettingsFromDisk()` (`src/utils/settings/settings.ts:645-796`). Settings are merged from lowest to highest priority using lodash `mergeWith`:

1. **Plugin settings** (lowest) — injected by the plugin loader as a base layer
2. **User settings** — `~/.claude/settings.json` (or `cowork_settings.json` in cowork mode)
3. **Project settings** — `.claude/settings.json` (shared, committed to repo)
4. **Local settings** — `.claude/settings.local.json` (gitignored, per-developer)
5. **Flag settings** — `--settings` CLI flag or SDK inline settings
6. **Policy settings** (highest) — enterprise managed settings from one of four sub-sources

For arrays, the merge strategy concatenates and deduplicates (`settingsMergeCustomizer`, `src/utils/settings/settings.ts:538-547`). For objects, lodash deep-merge applies. The result is cached at the session level to avoid repeated file I/O (`src/utils/settings/settingsCache.ts`).

### Policy Settings Resolution (First Source Wins)

Policy settings use a "first source wins" strategy (`src/utils/settings/settings.ts:319-345`). The system checks sources in this priority order and stops at the first one with content:

1. **Remote managed settings** — fetched from enterprise API, cached locally
2. **MDM settings** — macOS plist (`com.anthropic.claudecode`) or Windows HKLM registry (`HKLM\SOFTWARE\Policies\ClaudeCode`)
3. **File-based managed settings** — `/Library/Application Support/ClaudeCode/managed-settings.json` (macOS), `/etc/claude-code/managed-settings.json` (Linux), `C:\Program Files\ClaudeCode\managed-settings.json` (Windows), plus `managed-settings.d/*.json` drop-ins merged alphabetically
4. **HKCU registry** (Windows only) — user-writable, lowest policy priority

### Environment Variable Application Flow

Environment variables from settings are applied in two phases to balance security with functionality:

**Phase 1: Pre-trust** (`applySafeConfigEnvironmentVariables()`, `src/utils/managedEnv.ts:124-178`):
1. Apply global config (`~/.claude.json`) env vars
2. Apply ALL env vars from trusted sources (user, flag, policy settings) — these are user-controlled and safe
3. Compute remote-managed-settings eligibility (reads provider env vars)
4. Apply policy env vars (last, highest priority)
5. Apply only `SAFE_ENV_VARS` allowlist from the fully-merged settings (which includes project-scoped sources)

**Phase 2: Post-trust** (`applyConfigEnvironmentVariables()`, `src/utils/managedEnv.ts:187-199`):
- Apply ALL env vars from all sources (including dangerous ones like `LD_PRELOAD`, `PATH`)
- Clear and reconfigure proxy/mTLS/CA certs caches

A multi-layer filter pipeline (`filterSettingsEnv`, `src/utils/managedEnv.ts:85-91`) strips sensitive variables:
- SSH tunnel auth vars (when `ANTHROPIC_UNIX_SOCKET` is set)
- Host-managed provider routing vars (when `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set)
- Claude Code Desktop spawn-env keys (prevents settings from overriding CCD's operational vars)

### Settings Change Detection

The change detector (`src/utils/settings/changeDetector.ts`) uses chokidar to watch settings files for external modifications:

1. On initialization, it identifies all settings file paths and their parent directories
2. Sets up filesystem watchers with write-stability thresholds (1000ms stability, 500ms polling)
3. Distinguishes internal writes (from Claude Code itself) vs. external edits using a timestamp-based mechanism (`src/utils/settings/internalWrites.ts`)
4. Handles delete-and-recreate patterns with a grace period (1700ms) to absorb auto-updater file swaps
5. Fires `ConfigChange` hooks before applying changes — hooks can block the change
6. Resets the settings cache centrally in `fanOut()` before notifying subscribers, ensuring one disk reload per notification
7. Polls MDM settings (registry/plist) every 30 minutes since these can't be watched via filesystem events

### Settings Validation

Each settings file is validated against `SettingsSchema` (Zod v4) during parsing (`src/utils/settings/settings.ts:201-231`):

1. Read file content, resolve symlinks safely
2. Filter invalid permission rules *before* schema validation — one bad rule doesn't reject the entire file
3. Run Zod schema validation
4. Format errors with human-readable messages, suggestions, and documentation links (`src/utils/settings/validation.ts`)
5. Cache parsed results per-file path to avoid duplicate disk reads

### Global Config Persistence

`getGlobalConfig()` and `saveGlobalConfig()` (`src/utils/config.ts`) manage `~/.claude.json`:

- Uses file locking (`lockfile.js`) for safe concurrent writes across multiple Claude Code sessions
- Implements an auth-loss guard: refuses to write defaults over cached config if it would wipe OAuth credentials (`wouldLoseAuthState`, `src/utils/config.ts:783-795`)
- File watching with `fs.watchFile` provides change notifications
- An in-memory write-through cache avoids re-reading after self-initiated writes
- Re-entrancy guard prevents infinite recursion when config reads trigger analytics

## Function Signatures

### Settings API

#### `getInitialSettings(): SettingsJson`
Returns the fully-merged settings snapshot from all enabled sources. Uses session-level caching. For React components, prefer the `useSettings()` hook for reactive updates.
> Source: `src/utils/settings/settings.ts:812-815`

#### `getSettingsForSource(source: SettingSource): SettingsJson | null`
Returns settings for a single source, with per-source caching.
> Source: `src/utils/settings/settings.ts:309-317`

#### `updateSettingsForSource(source: EditableSettingSource, settings: SettingsJson): { error: Error | null }`
Merges new settings into an existing source file. Handles `undefined` values as key deletion. Arrays are replaced wholesale (not merged). Automatically adds `settings.local.json` to `.gitignore`.
> Source: `src/utils/settings/settings.ts:416-524`

#### `getSettingsWithSources(): SettingsWithSources`
Returns both the effective merged settings and raw per-source settings for debugging/status display. Always reads fresh from disk.
> Source: `src/utils/settings/settings.ts:836-848`

### Environment Variable API

#### `applySafeConfigEnvironmentVariables(): void`
Applies env vars from trusted sources before trust dialog. Project-scoped sources are limited to the `SAFE_ENV_VARS` allowlist.
> Source: `src/utils/managedEnv.ts:124-178`

#### `applyConfigEnvironmentVariables(): void`
Applies all env vars after trust is established. Reconfigures proxy/mTLS agents.
> Source: `src/utils/managedEnv.ts:187-199`

### CLI Argument Parsing

#### `eagerParseCliFlag(flagName: string, argv?: string[]): string | undefined`
Parses a single CLI flag before Commander.js runs. Supports both `--flag value` and `--flag=value` syntax. Used for flags like `--settings` that affect configuration loading.
> Source: `src/utils/cliArgs.ts:13-29`

#### `extractArgsAfterDoubleDash(commandOrValue: string, args?: string[]): { command: string; args: string[] }`
Handles the standard Unix `--` separator when using Commander.js with `.passThroughOptions()`.
> Source: `src/utils/cliArgs.ts:49-60`

### Session Env Vars

#### `getSessionEnvVars(): ReadonlyMap<string, string>`
Returns env vars set via `/env` command. Applied only to spawned child processes, not the REPL itself.
> Source: `src/utils/sessionEnvVars.ts:8-10`

## Interface/Type Definitions

### `SettingSource`
```typescript
type SettingSource = 'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings'
```
Defined in `src/utils/settings/constants.ts:7-22`. Order matters — later sources override earlier ones in the merge.

### `EditableSettingSource`
```typescript
type EditableSettingSource = Exclude<SettingSource, 'policySettings' | 'flagSettings'>
```
Sources that can be written to via `updateSettingsForSource`. Policy and flag settings are read-only.

### `SettingsJson`
The Zod-validated schema for settings files (`src/utils/settings/types.ts:255+`). Key fields include:
- `env` — environment variables (`Record<string, string>`)
- `permissions` — allow/deny/ask rules with permission mode defaults
- `hooks` — lifecycle event hooks (PreToolUse, PostToolUse, Notification, etc.)
- `sandbox` — sandbox configuration (enabled, network, filesystem rules)
- `apiKeyHelper` / `awsCredentialExport` / `gcpAuthRefresh` — auth helper scripts
- `mcpServers` — MCP server configurations
- `agent` — custom agent definitions

### `GlobalConfig`
The type for `~/.claude.json` (`src/utils/config.ts:183-578`). Contains:
- UI preferences (theme, editor mode, notification channel)
- Per-project state (trust dialog, allowed tools, MCP servers)
- OAuth account info and cached credentials
- Feature gate caches (Statsig, GrowthBook)
- Session metrics and usage tracking

### `SAFE_ENV_VARS`
A `Set<string>` defining environment variables safe to apply before the trust dialog (`src/utils/managedEnvConstants.ts:108-191`). Variables NOT in this list (like `ANTHROPIC_BASE_URL`, proxy vars, TLS settings) are considered dangerous because they could redirect traffic to attacker-controlled servers.

## Configuration & Defaults

### Settings File Locations

| Source | Path | Editable |
|--------|------|----------|
| User | `~/.claude/settings.json` | Yes |
| Project | `.claude/settings.json` | Yes |
| Local | `.claude/settings.local.json` (gitignored) | Yes |
| Flag | `--settings <path>` or SDK inline | Read-only |
| Policy (macOS) | `/Library/Application Support/ClaudeCode/managed-settings.json` | Admin only |
| Policy (Linux) | `/etc/claude-code/managed-settings.json` | Admin only |
| Policy (Windows) | `C:\Program Files\ClaudeCode\managed-settings.json` | Admin only |
| Policy drop-ins | `managed-settings.d/*.json` | Admin only |
| MDM (macOS) | `com.anthropic.claudecode` plist domain | MDM profile |
| MDM (Windows) | `HKLM\SOFTWARE\Policies\ClaudeCode` | Admin registry |
| HKCU (Windows) | `HKCU\SOFTWARE\Policies\ClaudeCode` | User registry |

### Default Global Config Values
Key defaults from `createDefaultGlobalConfig()` (`src/utils/config.ts:585-623`):
- `theme`: `'dark'`
- `autoCompactEnabled`: `true`
- `editorMode`: `'normal'`
- `terminalProgressBarEnabled`: `true`
- `messageIdleNotifThresholdMs`: `60000` (1 minute)
- `respectGitignore`: `true`

### Change Detector Timing Constants
- `FILE_STABILITY_THRESHOLD_MS`: 1000ms — wait for writes to stabilize
- `FILE_STABILITY_POLL_INTERVAL_MS`: 500ms — poll frequency during stability check
- `INTERNAL_WRITE_WINDOW_MS`: 5000ms — suppress self-triggered notifications
- `DELETION_GRACE_MS`: 1700ms — absorb delete-and-recreate patterns
- `MDM_POLL_INTERVAL_MS`: 30 minutes — registry/plist polling

## Edge Cases & Caveats

- **Security boundary**: Project-scoped settings (`.claude/settings.json`, `.claude/settings.local.json`) can only set env vars from the `SAFE_ENV_VARS` allowlist before trust is established. This prevents a malicious project from redirecting API traffic via `ANTHROPIC_BASE_URL` or injecting proxy settings.

- **SSH tunnel protection**: When `ANTHROPIC_UNIX_SOCKET` is set (remote `claude ssh` sessions), auth-related env vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, etc.) are stripped from all settings-sourced env to prevent settings from clobbering the SSH tunnel auth path.

- **Claude Code Desktop isolation**: When launched as a CCD subprocess, env keys present at spawn time are snapshot and protected — settings cannot override them (e.g., `OTEL_LOGS_EXPORTER=console` would corrupt the stdio JSON-RPC transport).

- **Settings source isolation**: The SDK can pass `settingSources: []` to disable all user/project sources, creating an isolated settings environment. Policy and flag sources are always enabled and cannot be disabled.

- **Permission rule pre-filtering**: Invalid permission rules are filtered *before* Zod schema validation (`filterInvalidPermissionRules` in `src/utils/settings/validation.ts:224-265`), so one bad rule doesn't reject the entire settings file.

- **Auth-loss guard**: `saveGlobalConfig()` detects when a fresh config read would lose OAuth credentials or onboarding state (due to a corrupted/truncated file from a concurrent write), and refuses to persist defaults over the cached good config.

- **`strictPluginOnlyCustomization` policy** (`src/utils/settings/pluginOnlyPolicy.ts`): Enterprise admins can lock customization surfaces (skills, agents, hooks, MCP) to plugin-only sources, preventing user/project configuration. Admin-trusted sources (plugin, policy, built-in) always bypass this restriction.

- **Cowork mode**: When `--cowork` flag is passed or `CLAUDE_CODE_USE_COWORK_PLUGINS` env var is set, user settings are loaded from `cowork_settings.json` instead of `settings.json`.

- **Settings file edit validation** (`src/utils/settings/validateEditTool.ts`): When the Edit tool modifies a Claude settings file, the result is validated against the schema. If the file was valid before the edit but invalid after, the edit is rejected. If the file was already invalid, edits are allowed through (to avoid permanently blocking fixes).

## Key Code Snippets

### Settings Source Priority Constant
```typescript
// src/utils/settings/constants.ts:7-22
export const SETTING_SOURCES = [
  'userSettings',      // User settings (global)
  'projectSettings',   // Project settings (shared per-directory)
  'localSettings',     // Local settings (gitignored)
  'flagSettings',      // Flag settings (from --settings flag)
  'policySettings',    // Policy settings (managed/enterprise, highest priority)
] as const
```

### Environment Variable Filter Pipeline
```typescript
// src/utils/managedEnv.ts:85-91
function filterSettingsEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return withoutCcdSpawnEnvKeys(
    withoutHostManagedProviderVars(withoutSSHTunnelVars(env)),
  )
}
```

### Settings Cache Reset (Centralized)
```typescript
// src/utils/settings/changeDetector.ts:437-440
function fanOut(source: SettingSource): void {
  resetSettingsCache()
  settingsChanged.emit(source)
}
```
Cache reset is centralized here (single producer) rather than in each listener (N consumers) to avoid N-way thrashing where each subscriber clears and re-reads from disk.