# Migrations

## Overview & Responsibilities

The `src/migrations/` module contains a collection of small, idempotent migration scripts that run during the Bootstrap phase of the CLI startup sequence. Their purpose is to silently upgrade user configuration and settings between Claude Code CLI versions — renaming model aliases, moving settings between storage locations, and resetting defaults when product changes require it.

Within the overall architecture, Migrations sit inside the **Bootstrap** group and depend heavily on the **Infrastructure** layer (specifically the config and settings utilities). They execute early in the startup sequence, before the REPL or any interactive components launch, ensuring that all downstream code sees up-to-date configuration.

All 11 migrations share a common pattern:
1. Read current config/settings state
2. Check whether the migration applies (guard clause)
3. Write updated values
4. Clean up the old values and/or set a completion flag
5. Log an analytics event

## Migration Inventory

| Migration | Category | Scope | Idempotency Mechanism |
|-----------|----------|-------|----------------------|
| `migrateFennecToOpus` | Model rename | userSettings | Self-checking (old value absent = no-op) |
| `migrateOpusToOpus1m` | Model rename | userSettings | Self-checking |
| `migrateSonnet1mToSonnet45` | Model pin | userSettings | Completion flag (`sonnet1m45MigrationComplete`) |
| `migrateSonnet45ToSonnet46` | Model rename | userSettings | Self-checking |
| `migrateLegacyOpusToCurrent` | Model rename | userSettings | Self-checking |
| `migrateAutoUpdatesToSettings` | Setting relocation | globalConfig → userSettings | Self-checking (old key removed) |
| `migrateBypassPermissionsAcceptedToSettings` | Setting relocation | globalConfig → userSettings | Self-checking (old key removed) |
| `migrateEnableAllProjectMcpServersToSettings` | Setting relocation | projectConfig → localSettings | Self-checking (old keys removed) |
| `migrateReplBridgeEnabledToRemoteControlAtStartup` | Key rename | globalConfig | Self-checking |
| `resetAutoModeOptInForDefaultOffer` | Default reset | userSettings | Completion flag (`hasResetAutoModeOptInForDefaultOffer`) |
| `resetProToOpusDefault` | Default reset | globalConfig | Completion flag (`opusProMigrationComplete`) |

## Key Processes

### Model Alias Rename Chain

Several migrations form a chronological chain tracking the evolution of model naming:

1. **Fennec → Opus** (`src/migrations/migrateFennecToOpus.ts`): Internal-only (`USER_TYPE=ant`). Maps removed Fennec aliases to their Opus 4.6 equivalents. Handles four variants including fast-mode models. Only touches `userSettings` — project/local/policy settings are intentionally left alone to avoid silently promoting settings globally.

2. **Opus → Opus[1m]** (`src/migrations/migrateOpusToOpus1m.ts`): For Max/Team Premium users eligible for the merged Opus 1M experience, upgrades `'opus'` to `'opus[1m]'`. Skips Pro subscribers (who retain separate options) and 3P users. If the migrated value matches the current default, it clears the setting entirely rather than writing a redundant pin.

3. **Sonnet[1m] → Sonnet 4.5** (`src/migrations/migrateSonnet1mToSonnet45.ts`): When the `sonnet` alias was updated to resolve to Sonnet 4.6, users who had `sonnet[1m]` needed to be pinned to the explicit `sonnet-4-5-20250929[1m]` to preserve their intended model. Also migrates the in-memory model override if already set. Uses a completion flag since the target value is a concrete version string that won't naturally self-clear.

4. **Sonnet 4.5 → Sonnet 4.6** (`src/migrations/migrateSonnet45ToSonnet46.ts`): Moves Pro/Max/Team Premium first-party users off explicit Sonnet 4.5 strings back to the `sonnet` alias (now pointing to 4.6). Preserves the `[1m]` suffix. Sets a notification timestamp for existing users (`numStartups > 1`) so the REPL can display a one-time upgrade notice.

5. **Legacy Opus → Current** (`src/migrations/migrateLegacyOpusToCurrent.ts`): First-party only. Replaces explicit Opus 4.0/4.1 model IDs (`claude-opus-4-20250514`, `claude-opus-4-1-20250805`, etc.) with the `'opus'` alias. Sets a `legacyOpusMigrationTimestamp` for a one-time REPL notification.

### Settings Relocation Flow

Three migrations move configuration values from older storage locations to the canonical settings system:

1. **Auto-updates** (`src/migrations/migrateAutoUpdatesToSettings.ts`): Moves the `autoUpdates: false` preference from `globalConfig` to `userSettings.env.DISABLE_AUTOUPDATER = '1'`. Critically, it distinguishes between user-initiated disabling and native-protection disabling (`autoUpdatesProtectedForNative`) — only the former is migrated. After writing the env var, it also sets `process.env.DISABLE_AUTOUPDATER` for immediate effect in the current session.

2. **Bypass permissions** (`src/migrations/migrateBypassPermissionsAcceptedToSettings.ts`): Moves `bypassPermissionsModeAccepted` from `globalConfig` to `skipDangerousModePermissionPrompt` in `userSettings`. Checks for an existing value via `hasSkipDangerousModePermissionPrompt()` before writing to avoid overwriting.

3. **MCP server enablement** (`src/migrations/migrateEnableAllProjectMcpServersToSettings.ts`): The most complex relocation — moves three related fields (`enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`) from `projectConfig` to `localSettings`. Server lists are merged with existing values using `Set` deduplication. Each field is independently tracked for migration.

### Config Key Rename

**Bridge → Remote Control** (`src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts`): Renames the `replBridgeEnabled` key to `remoteControlAtStartup` within `globalConfig`. Uses an untyped cast to access the old key since it's been removed from the `GlobalConfig` type. Only acts when the old key exists and the new key hasn't been set.

### Default Resets

1. **Auto-mode opt-in** (`src/migrations/resetAutoModeOptInForDefaultOffer.ts`): Clears `skipAutoPermissionPrompt` for users who accepted the old 2-option auto-mode dialog but don't have auto as their default. This re-surfaces the dialog so they can see the new "make it my default mode" option. Guarded by a feature flag (`TRANSCRIPT_CLASSIFIER`) and the `getAutoModeEnabledState() === 'enabled'` check — for `'opt-in'` users, clearing this flag would make the dialog unreachable.

2. **Pro → Opus default** (`src/migrations/resetProToOpusDefault.ts`): Handles the transition to Opus as the default model for Pro subscribers on first-party. Non-Pro or non-first-party users are immediately marked complete. For Pro users on the default model (no custom setting), it sets `opusProMigrationTimestamp` to trigger a notification. Users with a custom model are marked complete without notification.

## Function Signatures

All migrations export a single synchronous function with no parameters and no return value:

```typescript
export function migrateFennecToOpus(): void
export function migrateOpusToOpus1m(): void
export function migrateSonnet1mToSonnet45(): void
export function migrateSonnet45ToSonnet46(): void
export function migrateLegacyOpusToCurrent(): void
export function migrateAutoUpdatesToSettings(): void
export function migrateBypassPermissionsAcceptedToSettings(): void
export function migrateEnableAllProjectMcpServersToSettings(): void
export function migrateReplBridgeEnabledToRemoteControlAtStartup(): void
export function resetAutoModeOptInForDefaultOffer(): void
export function resetProToOpusDefault(): void
```

These are called by the Bootstrap orchestrator. They are not intended to be invoked from other modules.

## Shared Dependencies

The migrations rely on a small set of shared infrastructure utilities:

- **Config** (`src/utils/config.ts`): `getGlobalConfig()`, `saveGlobalConfig()`, `getCurrentProjectConfig()`, `saveCurrentProjectConfig()` — read/write JSON config files
- **Settings** (`src/utils/settings/settings.ts`): `getSettingsForSource()`, `updateSettingsForSource()` — typed access to the layered settings system (userSettings, localSettings, etc.)
- **Analytics** (`src/services/analytics/index.ts`): `logEvent()` — all migrations emit telemetry events prefixed with `tengu_`
- **Auth** (`src/utils/auth.ts`): `isProSubscriber()`, `isMaxSubscriber()`, `isTeamPremiumSubscriber()` — used by model migrations to scope by subscription tier
- **Model** (`src/utils/model/model.ts`, `src/utils/model/providers.ts`): `getAPIProvider()`, `isOpus1mMergeEnabled()`, `isLegacyModelRemapEnabled()` — gate migrations to first-party users and feature-flagged cohorts

## Edge Cases & Caveats

- **userSettings-only writes**: Model migrations deliberately read and write only `userSettings` (not merged settings). This prevents a model set in project-scoped config from being silently promoted to a global default. The trade-off is that project/local pins to old model strings are not migrated — these are instead handled at runtime by `parseUserSpecifiedModel`.

- **Completion flags vs. self-checking**: Most migrations are naturally idempotent (the old value disappears after migration, so re-running is a no-op). Two exceptions (`migrateSonnet1mToSonnet45`, `resetAutoModeOptInForDefaultOffer`) require explicit completion flags in `globalConfig` because their target state could be re-triggered.

- **Error isolation**: Migrations wrap their logic in try/catch and log errors via `logError()` rather than throwing. A failing migration never blocks CLI startup.

- **Fennec migration is internal-only**: `migrateFennecToOpus` exits immediately unless `process.env.USER_TYPE === 'ant'`, since Fennec model aliases were only available to Anthropic employees.

- **Immediate env effect**: `migrateAutoUpdatesToSettings` sets `process.env.DISABLE_AUTOUPDATER = '1'` after writing the setting, ensuring the auto-updater respects the preference in the current session without requiring a restart.

- **Notification timestamps**: Several migrations (`migrateLegacyOpusToCurrent`, `migrateSonnet45ToSonnet46`, `resetProToOpusDefault`) set timestamp values in `globalConfig` that downstream UI code reads to show one-time upgrade notifications in the REPL.

- **`saveGlobalConfig` atomicity**: All config writes use the callback form of `saveGlobalConfig(current => ...)`, which re-reads the current state before writing. This avoids race conditions if multiple migrations modify the same config file.