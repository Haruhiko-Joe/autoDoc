# Settings and Policy

## Overview & Responsibilities

This module encompasses three closely related services within the **Services** layer that manage configuration and policy enforcement for Claude Code:

1. **Remote Managed Settings** (`src/services/remoteManagedSettings/`) — Fetches organization-level configuration from the Anthropic API, caches it locally, and applies it to the running session. Designed for enterprise/team administrators to push settings to their users' CLI instances.

2. **Settings Sync** (`src/services/settingsSync/`) — Bidirectionally synchronizes user preferences (settings files and CLAUDE.md memory files) between environments. The interactive CLI uploads local files; Claude Code Remote (CCR) downloads them before starting.

3. **Policy Limits** (`src/services/policyLimits/`) — Fetches and enforces organization-level usage restrictions (feature gates, quotas) from the API. Provides a synchronous `isPolicyAllowed()` check that other modules call to decide whether a feature is permitted.

All three services share a common architectural pattern: **fail-open** design (network errors don't block the CLI), **ETag/checksum-based HTTP caching**, **exponential-backoff retries**, **local file caching for offline resilience**, and **hourly background polling** for mid-session updates.

---

## Remote Managed Settings

### Key Process Walkthrough

#### Initialization and Loading Flow

1. **Early init** — `initializeRemoteManagedSettingsLoadingPromise()` is called during bootstrap (`init.ts`). It creates a `Promise` that other subsystems can `await` via `waitForRemoteManagedSettingsToLoad()`, gated by an eligibility check. A 30-second timeout prevents deadlocks if `loadRemoteManagedSettings()` is never called (`src/services/remoteManagedSettings/index.ts:77-99`).

2. **Cache-first fast path** — `loadRemoteManagedSettings()` first checks the on-disk cache via `getRemoteManagedSettingsSyncFromCache()`. If cached settings exist, the loading promise resolves immediately, unblocking downstream consumers before the network fetch completes (`src/services/remoteManagedSettings/index.ts:529-532`).

3. **Fetch from API** — `fetchAndLoadRemoteManagedSettings()` computes a SHA-256 checksum of cached settings and sends it as an `If-None-Match` ETag header. The API returns `304 Not Modified` when nothing changed, `200` with new settings, `204`/`404` when no settings exist, or an error (`src/services/remoteManagedSettings/index.ts:248-361`).

4. **Security check** — Before applying new settings that contain "dangerous" entries (e.g., allowed shell commands), `checkManagedSettingsSecurity()` renders a blocking dialog in interactive mode. If the user rejects the settings, the app performs a graceful shutdown (`src/services/remoteManagedSettings/securityCheck.tsx:22-61`).

5. **Persist and notify** — Approved settings are written to `~/.claude/remote-settings.json` (mode `0600`) and stored in the session cache. `settingsChangeDetector.notifyChange('policySettings')` triggers hot-reload across the application (`src/services/remoteManagedSettings/index.ts:470-472`).

6. **Background polling** — An hourly `setInterval` (unreffed to not block process exit) re-fetches settings and fires `notifyChange` only when the serialized JSON actually changes (`src/services/remoteManagedSettings/index.ts:612-628`).

#### Retry Logic

`fetchWithRetry()` wraps the single-attempt `fetchRemoteManagedSettings()` with up to 5 retries using exponential backoff from the shared `getRetryDelay()` utility. Auth errors (401/403) set `skipRetry: true` to avoid pointless retries (`src/services/remoteManagedSettings/index.ts:209-242`).

### Eligibility

Determined by `isRemoteManagedSettingsEligible()` in `src/services/remoteManagedSettings/syncCache.ts:49-112`:

| User type | Eligible? |
|---|---|
| Console (API key) | Yes, if key is present |
| OAuth Enterprise/Team | Yes |
| OAuth with null subscriptionType (injected tokens) | Yes (API decides) |
| OAuth Free/Pro | No |
| Third-party provider or custom base URL | No |
| `local-agent` entrypoint (Cowork) | No |

The result is computed once and cached in module-level state.

### Module Structure

| File | Purpose |
|---|---|
| `src/services/remoteManagedSettings/index.ts` | Main service: fetch, retry, save, load, poll, public API |
| `src/services/remoteManagedSettings/syncCache.ts` | Eligibility check (imports `auth.ts`), `resetSyncCache` |
| `src/services/remoteManagedSettings/syncCacheState.ts` | Leaf state: session cache, disk I/O, settings path — no auth import to break circular dependencies |
| `src/services/remoteManagedSettings/securityCheck.tsx` | Interactive security dialog for dangerous settings |
| `src/services/remoteManagedSettings/types.ts` | Zod schema (`RemoteManagedSettingsResponseSchema`) and result types |

The split between `syncCache.ts` and `syncCacheState.ts` exists specifically to break a circular dependency: `settings.ts → syncCacheState.ts` is safe because `syncCacheState.ts` only imports leaf modules. The auth-dependent eligibility logic stays in `syncCache.ts`.

### Function Signatures

#### `loadRemoteManagedSettings(): Promise<void>`
Main entry point called during CLI startup. Loads cached settings, fetches from API, starts background polling, and notifies change listeners.

> Source: `src/services/remoteManagedSettings/index.ts:514-555`

#### `waitForRemoteManagedSettingsToLoad(): Promise<void>`
Blocks until the initial load completes. Returns immediately if the user is ineligible or loading already finished.

> Source: `src/services/remoteManagedSettings/index.ts:155-159`

#### `isEligibleForRemoteManagedSettings(): boolean`
Public wrapper for the eligibility check. Used by other systems to decide whether to wait for remote settings.

> Source: `src/services/remoteManagedSettings/index.ts:144-146`

#### `refreshRemoteManagedSettings(): Promise<void>`
Clears all caches and re-fetches. Called on login/logout to pick up auth state changes.

> Source: `src/services/remoteManagedSettings/index.ts:562-579`

#### `computeChecksumFromSettings(settings: SettingsJson): string`
Computes a `sha256:...` checksum matching the server's Python `json.dumps(sort_keys=True, separators=(",", ":"))` format. Exported for testing.

> Source: `src/services/remoteManagedSettings/index.ts:131-137`

### Type Definitions

#### `RemoteManagedSettingsResponse` (`src/services/remoteManagedSettings/types.ts:10-16`)

| Field | Type | Description |
|---|---|---|
| `uuid` | `string` | Settings UUID |
| `checksum` | `string` | Server-computed checksum |
| `settings` | `SettingsJson` | The actual settings object |

#### `RemoteManagedSettingsFetchResult` (`src/services/remoteManagedSettings/types.ts:25-31`)

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the fetch succeeded |
| `settings` | `SettingsJson \| null` | `null` means 304 (cache valid) |
| `checksum` | `string?` | Server ETag |
| `error` | `string?` | Error description |
| `skipRetry` | `boolean?` | If true, don't retry (auth error) |

---

## Settings Sync

### Key Process Walkthrough

#### Upload Flow (Interactive CLI → Remote)

1. `uploadUserSettingsInBackground()` is called from `main.tsx` preAction, runs in background (`src/services/settingsSync/index.ts:60-111`)
2. Gated by: `UPLOAD_USER_SETTINGS` build feature, `tengu_enable_settings_sync_push` GrowthBook feature flag, interactive mode, and first-party OAuth authentication
3. Fetches existing remote entries via `GET /api/claude_code/user_settings`, builds local entries from disk, computes a diff using `lodash-es/pickBy`, and uploads only changed entries via `PUT /api/claude_code/user_settings`

#### Download Flow (Remote → CCR)

1. `downloadUserSettings()` is called fire-and-forget at the top of `runHeadless()` for CCR mode (`src/services/settingsSync/index.ts:129-135`)
2. A cached promise ensures multiple callers share one fetch
3. Downloads remote entries, writes them to local file paths, then invalidates settings and memory caches via `resetSettingsCache()` and `clearMemoryFileCaches()`
4. `redownloadUserSettings()` provides a no-retry variant for mid-session `/reload-plugins` commands (`src/services/settingsSync/index.ts:152-155`)

#### Synced Files

Determined by the `SYNC_KEYS` constant (`src/services/settingsSync/types.ts:61-67`):

| Key | Description |
|---|---|
| `~/.claude/settings.json` | Global user settings |
| `~/.claude/CLAUDE.md` | Global user memory |
| `projects/{id}/.claude/settings.local.json` | Project-scoped settings (keyed by git remote hash) |
| `projects/{id}/CLAUDE.local.md` | Project-scoped memory (keyed by git remote hash) |

Project IDs are derived from `getRepoRemoteHash()` (a hash of the git remote URL).

#### Applying Remote Entries to Local Files

`applyRemoteEntriesToLocal()` (`src/services/settingsSync/index.ts:488-581`) iterates over known sync keys, writes matching entries to their local file paths, and performs cache invalidation:
- Uses `markInternalWrite()` before writing settings files to suppress spurious file-change detection
- Calls `resetSettingsCache()` if any settings files were written
- Calls `clearMemoryFileCaches()` if any memory (CLAUDE.md) files were written
- Enforces a 500 KB size limit per file as defense-in-depth

### Function Signatures

#### `uploadUserSettingsInBackground(): Promise<void>`
Incrementally uploads changed local settings/memory files. Fail-open — unexpected errors are logged but never block startup.

> Source: `src/services/settingsSync/index.ts:60-111`

#### `downloadUserSettings(): Promise<boolean>`
Downloads and applies remote settings to local files. Returns `true` if settings were applied. Cached: multiple callers share one fetch.

> Source: `src/services/settingsSync/index.ts:129-135`

#### `redownloadUserSettings(): Promise<boolean>`
Force-downloads without retry or caching. For mid-session refresh via `/reload-plugins`. Caller is responsible for firing `settingsChangeDetector.notifyChange`.

> Source: `src/services/settingsSync/index.ts:152-155`

### Type Definitions

#### `UserSyncData` (`src/services/settingsSync/types.ts:25-33`)

| Field | Type | Description |
|---|---|---|
| `userId` | `string` | User identifier |
| `version` | `number` | Data version |
| `lastModified` | `string` | ISO 8601 timestamp |
| `checksum` | `string` | MD5 hash |
| `content.entries` | `Record<string, string>` | Key-value map of file path to file content |

#### `SettingsSyncFetchResult` (`src/services/settingsSync/types.ts:40-46`)

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the fetch succeeded |
| `data` | `UserSyncData?` | The fetched data |
| `isEmpty` | `boolean?` | `true` if 404 (no data exists yet) |
| `error` | `string?` | Error description |
| `skipRetry` | `boolean?` | If true, don't retry |

### Configuration

| Constant | Value | Description |
|---|---|---|
| `SETTINGS_SYNC_TIMEOUT_MS` | 10,000 ms | Per-request timeout |
| `DEFAULT_MAX_RETRIES` | 3 | Maximum retry attempts |
| `MAX_FILE_SIZE_BYTES` | 512,000 (500 KB) | Per-file size limit (matches backend) |

---

## Policy Limits

### Key Process Walkthrough

#### Loading and Enforcement Flow

1. `initializePolicyLimitsLoadingPromise()` creates a promise with 30-second timeout, similar to remote managed settings (`src/services/policyLimits/index.ts:94-114`)
2. `loadPolicyLimits()` fetches restrictions from `GET /api/claude_code/policy_limits` using the same retry/ETag/caching pattern and starts hourly background polling (`src/services/policyLimits/index.ts:556-575`)
3. Restrictions are cached in-memory (`sessionCache`) and on disk at `~/.claude/policy-limits.json`
4. Other modules call `isPolicyAllowed(policy)` synchronously to check if a feature is permitted (`src/services/policyLimits/index.ts:510-526`)

#### `isPolicyAllowed()` Decision Logic

The function at `src/services/policyLimits/index.ts:510-526` follows this logic:

1. Load restrictions from session cache or disk via `getRestrictionsFromCache()`
2. If no restrictions are available:
   - If essential-traffic-only mode is active **and** the policy is in `ESSENTIAL_TRAFFIC_DENY_ON_MISS` → return `false` (fail **closed**)
   - Otherwise → return `true` (fail **open**)
3. If the policy key is absent from the restrictions map → return `true` (unknown = allowed)
4. Otherwise → return `restrictions[policy].allowed`

The `ESSENTIAL_TRAFFIC_DENY_ON_MISS` set currently contains only `allow_product_feedback` — in HIPAA-compliant organizations, a cache miss must not silently re-enable feedback collection (`src/services/policyLimits/index.ts:502`).

### Eligibility

`isPolicyLimitsEligible()` (`src/services/policyLimits/index.ts:167-211`):

| User type | Eligible? |
|---|---|
| Console (API key) | Yes |
| OAuth Enterprise/Team | Yes |
| OAuth Free/Pro/null subscriptionType | No |
| Third-party provider or custom base URL | No |

Unlike remote managed settings, OAuth users with `null` subscriptionType are **not** eligible for policy limits — the restriction only applies to known Team/Enterprise orgs.

### Function Signatures

#### `isPolicyAllowed(policy: string): boolean`
Synchronous check. Returns `true` if the policy is unknown, cache unavailable (fail-open), or explicitly allowed. Returns `false` only when a restriction explicitly sets `allowed: false`, or for deny-on-miss policies in essential-traffic-only mode.

> Source: `src/services/policyLimits/index.ts:510-526`

#### `loadPolicyLimits(): Promise<void>`
Main entry point called during CLI initialization. Fetches restrictions, populates caches, starts background polling.

> Source: `src/services/policyLimits/index.ts:556-575`

#### `waitForPolicyLimitsToLoad(): Promise<void>`
Blocks until the initial load completes. Returns immediately if ineligible or already loaded.

> Source: `src/services/policyLimits/index.ts:217-221`

#### `refreshPolicyLimits(): Promise<void>`
Clears cache and re-fetches. Called on login to pick up auth state changes.

> Source: `src/services/policyLimits/index.ts:581-590`

#### `isPolicyLimitsEligible(): boolean`
Checks whether the current user should query the policy limits API.

> Source: `src/services/policyLimits/index.ts:167-211`

### Type Definitions

#### `PolicyLimitsResponse` (`src/services/policyLimits/types.ts:8-12`)

```typescript
{
  restrictions: Record<string, { allowed: boolean }>
}
```

Only blocked/explicitly-set policies appear. Absent keys are implicitly allowed.

#### `PolicyLimitsFetchResult` (`src/services/policyLimits/types.ts:21-27`)

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the fetch succeeded |
| `restrictions` | `Record<string, {allowed: boolean}> \| null` | `null` = 304 cache valid |
| `etag` | `string?` | Cached checksum for ETag |
| `error` | `string?` | Error description |
| `skipRetry` | `boolean?` | If true, don't retry |

---

## Shared Patterns & Configuration

All three services share these design patterns:

| Pattern | Detail |
|---|---|
| **Fail-open** | Network/API failures never block the CLI; stale cache or empty defaults are used |
| **ETag caching** | SHA-256 checksums sent as `If-None-Match`; 304 avoids re-downloading |
| **Disk cache** | Settings/restrictions persisted to `~/.claude/` for offline resilience |
| **Session cache** | Module-level variables avoid repeated disk reads within a session |
| **Retry with backoff** | Uses shared `getRetryDelay()` from `src/services/api/withRetry.ts`; auth errors skip retry |
| **Background polling** | 1-hour interval via unreffed `setInterval` with cleanup registration |
| **Loading promise** | 30-second timeout prevents deadlocks in non-CLI contexts (Agent SDK, tests) |
| **Auth** | API key (`x-api-key` header) or OAuth Bearer token with `anthropic-beta` header |
| **Fetch timeout** | 10 seconds per HTTP request |

## Edge Cases & Caveats

- **Circular dependency avoidance**: `syncCacheState.ts` exists as a leaf module specifically to break the `settings.ts → auth.ts → settings.ts` cycle. The eligibility check (which needs auth) is isolated in `syncCache.ts`. This split is documented extensively in the module header comment at `src/services/remoteManagedSettings/syncCacheState.ts:1-22`.
- **Security dialog**: When remote managed settings contain dangerous entries (e.g., `allowedTools`, shell commands), a blocking React dialog is rendered via Ink. If the user rejects, the CLI exits via `gracefulShutdownSync(1)`. In non-interactive mode, the check is skipped entirely (`src/services/remoteManagedSettings/securityCheck.tsx:34-36`).
- **Essential-traffic-only mode**: Policy limits for `allow_product_feedback` fail **closed** (denied) when the cache is unavailable and the org has opted into essential-traffic-only mode. This prevents HIPAA orgs from accidentally leaking data during cache misses.
- **Checksum compatibility**: `computeChecksumFromSettings()` must produce output matching Python's `json.dumps(sort_keys=True, separators=(",", ":"))` — keys are recursively sorted via `sortKeysDeep()` and JSON is serialized without spaces (`src/services/remoteManagedSettings/index.ts:112-137`).
- **Settings sync size limit**: Files larger than 500 KB are silently skipped on both upload and download, matching the backend's limit. Enforced via `tryReadFileForSync()` on upload and `exceedsSizeLimit()` on download.
- **Cowork exclusion**: The `local-agent` entrypoint skips remote managed settings entirely — Cowork VMs have their own permission model, and server-managed CLI settings don't apply there (`src/services/remoteManagedSettings/syncCache.ts:66-68`).
- **OAuth token freshness**: All three services call `checkAndRefreshOAuthTokenIfNeeded()` before every fetch to prevent stale-token 401 errors.
- **Settings cache poisoning**: When `getRemoteManagedSettingsSyncFromCache()` first loads settings from disk, it calls `resetSettingsCache()` to flush any merged settings cache that was computed before the remote settings layer became available (`src/services/remoteManagedSettings/syncCacheState.ts:77-93`).