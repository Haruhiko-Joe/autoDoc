# Plugin Telemetry

## Overview & Responsibilities

The `pluginTelemetry` module provides **privacy-safe analytics helpers** for the plugin system. It lives within the **Infrastructure → CoreUtilities → Telemetry** layer and is consumed by plugin lifecycle call sites (session startup, skill invocation, slash commands, plugin installation) to emit structured telemetry events to BigQuery.

The module solves a core tension: the analytics team needs per-plugin usage metrics, but plugin names are user-defined strings that may contain PII or proprietary information. The solution is a **twin-column privacy pattern** — every plugin name field is emitted twice:

1. A **raw** `_PROTO_*` column routed to PII-tagged storage (restricted access)
2. A **redacted** twin that exposes the real name only for Anthropic-controlled plugins, substituting `'third-party'` for everything else

Additionally, a **`plugin_id_hash`** (truncated SHA-256) provides an opaque aggregation key that works across both columns without any privacy dependency.

> **Source**: `src/utils/telemetry/pluginTelemetry.ts`

## Key Processes

### Plugin ID Hashing

The `hashPluginId()` function creates an opaque, deterministic identifier for any plugin:

1. Concatenate `name@marketplace` (marketplace lowercased for reproducibility)
2. Append a fixed salt (`claude-plugin-telemetry-v1`)
3. SHA-256 hash the result
4. Truncate to 16 hex characters

The salt is intentionally **not** per-org and **not** rotated — per-org salt would break cross-org distinct counts, and rotation would break trend lines. Customers can compute the same hash on their known plugin names to reverse-match their own telemetry.

> `src/utils/telemetry/pluginTelemetry.ts:48-54`

### Scope Classification

`getTelemetryPluginScope()` classifies a plugin into one of four origin buckets:

| Scope | Condition | Meaning |
|-------|-----------|---------|
| `default-bundle` | `marketplace === 'builtin'` | Ships with the CLI, auto-enabled |
| `official` | Marketplace is on Anthropic's allowlist | From an official Anthropic marketplace |
| `org` | Plugin name is in the `managedNames` set | Enterprise admin-pushed via policy settings |
| `user-local` | None of the above | User-installed marketplace or local plugin |

This is distinct from `PluginScope` (managed/user/project/local), which describes the *installation target*, not the *marketplace origin*.

> `src/utils/telemetry/pluginTelemetry.ts:72-81`

### Telemetry Field Building

`buildPluginTelemetryFields()` is the core field builder. Given a plugin's name and marketplace, it returns a set of analytics-safe fields:

1. Determines the `plugin_scope` via `getTelemetryPluginScope()`
2. Checks if the plugin is **Anthropic-controlled** (`official` or `default-bundle`)
3. Returns:
   - `plugin_id_hash` — opaque aggregation key
   - `plugin_scope` — the 4-value scope enum
   - `plugin_name_redacted` — real name if Anthropic-controlled, else `'third-party'`
   - `marketplace_name_redacted` — real marketplace if Anthropic-controlled, else `'third-party'`
   - `is_official_plugin` — boolean convenience flag

Callers add the raw `_PROTO_plugin_name` and `_PROTO_marketplace_name` fields separately at each emission site, since those require the PII-tagged marker type.

> `src/utils/telemetry/pluginTelemetry.ts:133-164`

### Session-Level Plugin Enabled Logging

`logPluginsEnabledForSession()` fires **one `tengu_plugin_enabled_for_session` event per enabled plugin** at session start. This supplements the per-skill `tengu_skill_loaded` event — a plugin with 5 skills emits 5 `skill_loaded` rows but only 1 of these.

Each event includes:
- The standard twin-column fields (raw `_PROTO_*` + redacted)
- `enabled_via` — how the plugin arrived in the session (`user-install`, `org-policy`, `default-enable`, `seed-mount`)
- `skill_path_count` and `command_path_count` — how many skill/command paths the plugin contributes
- `has_mcp` and `has_hooks` — boolean capability flags
- `version` — plugin manifest version, if present

> `src/utils/telemetry/pluginTelemetry.ts:191-224`

### Plugin Load Error Logging

`logPluginLoadErrors()` emits **one `tengu_plugin_load_failed` event per error** during session-start plugin loading. This pairs with `tengu_plugin_enabled_for_session` so dashboards can compute a load-success rate. The `PluginError.type` discriminant (a bounded enum of ~11 values like `path-not-found`, `git-auth-failed`, `manifest-parse-error`) is used directly as `error_category`.

> `src/utils/telemetry/pluginTelemetry.ts:267-289`

## Function Signatures

### `hashPluginId(name: string, marketplace?: string): string`

Returns a 16-character hex hash for plugin aggregation. Deterministic and reproducible across sessions.

### `getTelemetryPluginScope(name, marketplace, managedNames): TelemetryPluginScope`

Classifies a plugin's origin into `'official' | 'org' | 'user-local' | 'default-bundle'`.

- **managedNames**: `Set<string> | null` — plugin names pushed by enterprise admin policy. Pass `null` if unavailable.

### `getEnabledVia(plugin, managedNames, seedDirs): EnabledVia`

Determines how a plugin arrived in the session.

- **plugin**: `LoadedPlugin` — the loaded plugin object
- **seedDirs**: `string[]` — directories that were seed-mounted (path prefix matching with trailing separator enforcement)
- Returns: `'default-enable' | 'org-policy' | 'seed-mount' | 'user-install'`

### `buildPluginTelemetryFields(name, marketplace, managedNames?): {...}`

Core field builder returning the hash, scope, redacted twins, and official flag. Callers add `_PROTO_*` PII columns separately.

### `buildPluginCommandTelemetryFields(pluginInfo, managedNames?): {...}`

Convenience wrapper for per-invocation call sites. Extracts `marketplace` from `pluginInfo.repository` via `parsePluginIdentifier()`, then delegates to `buildPluginTelemetryFields()`.

### `logPluginsEnabledForSession(plugins, managedNames, seedDirs): void`

Emits `tengu_plugin_enabled_for_session` for each loaded plugin at session start.

### `logPluginLoadErrors(errors, managedNames): void`

Emits `tengu_plugin_load_failed` for each `PluginError` encountered during loading.

### `classifyPluginCommandError(error: unknown): PluginCommandErrorCategory`

Maps free-form error messages to 5 stable categories for dashboard GROUP BY:

| Category | Matched Patterns |
|----------|-----------------|
| `network` | `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `timed out`, etc. |
| `not-found` | `404`, `not found`, `does not exist`, `no such plugin` |
| `permission` | `401`, `403`, `EACCES`, `EPERM`, `permission denied` |
| `validation` | `invalid`, `malformed`, `schema`, `parse error` |
| `unknown` | Anything else (fallback) |

## Type Definitions

### `TelemetryPluginScope`

`'official' | 'org' | 'user-local' | 'default-bundle'` — marketplace-origin classification.

### `EnabledVia`

`'user-install' | 'org-policy' | 'default-enable' | 'seed-mount'` — how a plugin entered the session.

### `InvocationTrigger`

`'user-slash' | 'claude-proactive' | 'nested-skill'` — how a skill/command invocation was triggered. Defined here for consumers to import.

### `SkillExecutionContext`

`'fork' | 'inline' | 'remote'` — where a skill invocation executes.

### `InstallSource`

`'cli-explicit' | 'ui-discover' | 'ui-suggestion' | 'deep-link'` — how a plugin install was initiated.

### `PluginCommandErrorCategory`

`'network' | 'not-found' | 'permission' | 'validation' | 'unknown'` — bounded-cardinality error buckets.

## Edge Cases & Caveats

- **`BUILTIN_MARKETPLACE_NAME` is inlined** as `'builtin'` to avoid a circular dependency through `commands.js`. The marketplace schemas enforce that `'builtin'` is a reserved name.
- **Per-invocation call sites pass `managedNames=null`** to avoid a settings read on the hot path. The session-level event carries the authoritative `plugin_scope`; per-invocation rows can join on `plugin_id_hash` to recover it.
- **Seed directory matching** uses trailing-separator enforcement (`dir + sep`) to prevent `/opt/plugins` from matching `/opt/plugins-extra`.
- **Hash truncation to 16 chars** is sufficient for negligible collision probability at the projected 10k-plugin scale. Collisions would merge plugin metrics, not cause errors.
- **Plugin name case** is preserved in both the hash input and the raw `_PROTO_` columns. Only the marketplace suffix is lowercased for hash reproducibility.
- **`PluginError` variants** don't always carry a `plugin` property (some have `pluginId`, some are marketplace-level). `logPluginLoadErrors` falls back to parsing the name from `err.source`.