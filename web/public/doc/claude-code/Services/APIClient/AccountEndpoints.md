# Account Endpoints

## Overview & Responsibilities

AccountEndpoints is a collection of auxiliary API client functions within the **Services > APIClient** layer. These endpoints handle account-level and platform feature operations that sit outside the core Claude messaging API. They communicate with Anthropic's backend to fetch configuration, manage community features, track referrals, check usage quotas, and handle billing-related flows.

Each file is a self-contained API client for a specific feature domain. Most follow a common pattern: make an authenticated HTTP request, validate the response, and cache the result to disk (via `GlobalConfig`) or in-memory to minimize redundant network calls across sessions and process lifetimes.

**Sibling context**: These endpoints complement the core API message-sending client (also in `APIClient`) and are consumed by UI components, slash commands, and startup initialization flows throughout the application.

## Key Processes

### Authentication Pattern

All endpoints use one of two authentication strategies:

1. **OAuth Bearer token** — used by Claude.ai subscribers. Obtained via `getAuthHeaders()` or `getClaudeAIOAuthTokens()`, with automatic 401 retry and token refresh handled by `withOAuth401Retry()`.
2. **API key** — used by console/API-key users. Passed as `x-api-key` header.

Most endpoints also check `isEssentialTrafficOnly()` early and bail out during incident mode to shed non-critical load.

### Two-Tier Caching Strategy

Several endpoints (bootstrap, Grove, referral, metrics opt-out, overage credits) implement a two-tier cache:

1. **Disk cache** (persisted in `GlobalConfig`, typically 1–24h TTL) — survives process restarts, collapses repeated `claude -p` invocations into ~1 API call per TTL window.
2. **In-memory cache** (via `memoize` or `memoizeWithTTLAsync`) — deduplicates calls within a single process/session.

The general flow:
1. Check disk cache; if fresh, return immediately (zero network).
2. If stale, return the stale value and fire a background refresh.
3. If no cache exists (cold start), either block on fetch or return a safe default and populate cache for the next session.

### Bootstrap Flow

`src/services/api/bootstrap.ts`

1. `fetchBootstrapData()` is called at startup.
2. Guards: skips if essential-traffic-only mode, non-first-party provider, or no usable auth.
3. Calls `GET /api/claude_cli/bootstrap` with OAuth or API key auth.
4. Parses response with a Zod schema, extracting `client_data` and `additional_model_options` (transformed to `{value, label, description}` format).
5. Compares against existing disk cache via `isEqual`; writes only if data changed to avoid unnecessary config writes on every startup.

### Grove (Community Feature) Flow

`src/services/api/grove.ts`

Grove manages a community feature toggle with notice/consent tracking:

1. **Qualification check** (`isQualifiedForGrove`): Non-blocking, cache-first. Requires `isConsumerSubscriber()`. Uses a per-account disk cache with 24h TTL. On cold start returns `false` and fetches in background.
2. **Settings read** (`getGroveSettings`): Session-memoized. Fetches `GET /api/oauth/account/settings` returning `grove_enabled` and `grove_notice_viewed_at`.
3. **Settings update** (`updateGroveSettings`): `PATCH /api/oauth/account/settings` with `grove_enabled` boolean. Invalidates the memoized cache so subsequent reads are fresh.
4. **Notice viewed** (`markGroveNoticeViewed`): `POST /api/oauth/account/grove_notice_viewed`. Also invalidates the settings cache.
5. **Dialog visibility** (`calculateShouldShowGrove`): Pure function combining settings and config to determine if the Grove dialog should appear — considering whether the user has chosen, grace period status, and reminder frequency.
6. **Non-interactive check** (`checkGroveForNonInteractive`): For headless/piped usage. During grace period, prints an informational message. After grace period ends, prints an error and calls `gracefulShutdown(1)`.

### Referral System Flow

`src/services/api/referral.ts`

1. **Eligibility gate** (`shouldCheckForPasses`): Requires an org UUID, Claude.ai subscriber status, and `max` subscription tier.
2. **Eligibility fetch** (`fetchReferralEligibility`): `GET /api/oauth/organizations/{orgUUID}/referral/eligibility` with campaign parameter (defaults to `claude_code_guest_pass`).
3. **Cache-first access** (`getCachedOrFetchPassesEligibility`): Non-blocking. Returns cached data immediately; triggers background refresh if stale (24h TTL). On cold start returns `null` — the passes command is unavailable until the next session.
4. **Deduplication**: Uses a module-level `fetchInProgress` promise to prevent duplicate concurrent API calls.
5. **Redemption tracking** (`fetchReferralRedemptions`): `GET .../referral/redemptions` for viewing referral usage.
6. **Reward display helpers**: `getCachedReferrerReward()`, `getCachedRemainingPasses()`, and `formatCreditAmount()` for UI rendering with multi-currency support (USD, EUR, GBP, BRL, CAD, AUD, NZD, SGD).

### Metrics Opt-Out Flow

`src/services/api/metricsOptOut.ts`

1. **Two-tier cache**: In-memory (1h TTL via `memoizeWithTTLAsync`) + disk (24h TTL). Fresh disk cache means zero network.
2. `checkMetricsEnabled()` is the main entry point:
   - Short-circuits for subscribers without `user:profile` scope (would 403).
   - If disk cache exists and is fresh, returns it. If stale, returns stale value and fires background refresh.
   - On first-ever run, blocks on network to populate disk.
3. **Error handling**: Transient failures are not persisted to disk — a failed fetch won't overwrite a known-good cached value.
4. Consumed by the bigquery exporter to decide whether to export metrics.

### Overage Credit Grant Flow

`src/services/api/overageCreditGrant.ts`

1. `getCachedOverageCreditGrant()`: Returns cached grant info or `null` if no cache or stale (1h TTL). Per-org caching.
2. `refreshOverageCreditGrantCache()`: Fire-and-forget fetch. Smart write avoidance: skips config write when data is unchanged AND timestamp is still fresh.
3. `invalidateOverageCreditGrantCache()`: Drops the current org's entry, leaving other orgs intact.
4. `formatGrantAmount()`: Formats minor units to display string (currently USD only, e.g., `$5`).
5. Write path uses `prev` from the lock-acquired config (not a pre-lock read) to handle concurrent CLI instances safely.

### Admin Requests Flow

`src/services/api/adminRequests.ts`

For Team/Enterprise users without billing permissions:

1. `createAdminRequest()`: `POST .../admin_requests`. Supports `limit_increase` (no details) and `seat_upgrade` (with message and current tier). Server deduplicates — returns existing pending request if one exists.
2. `getMyAdminRequests()`: `GET .../admin_requests/me` filtered by request type and statuses.
3. `checkAdminRequestEligibility()`: `GET .../admin_requests/eligibility` to check if a request type is allowed for the org.

### First Token Date Tracking

`src/services/api/firstTokenDate.ts`

Single function `fetchAndStoreClaudeCodeFirstTokenDate()`:
1. Called after successful login.
2. Early-returns if `claudeCodeFirstTokenDate` is already in config (write-once).
3. Fetches `GET /api/organization/claude_code_first_token_date`.
4. Validates the returned date string before persisting to prevent invalid data in config.

### Ultrareview Quota

`src/services/api/ultrareviewQuota.ts`

`fetchUltrareviewQuota()`: Peek-only — consumption happens server-side at session creation.
- Returns `null` for non-subscribers or on error.
- Response includes `reviews_used`, `reviews_limit`, `reviews_remaining`, and `is_overage`.

### Usage/Utilization Fetching

`src/services/api/usage.ts`

`fetchUtilization()`: Fetches rate limit utilization for the current subscriber.
- Requires `isClaudeAISubscriber()` and `hasProfileScope()`.
- Pre-checks OAuth token expiry to avoid unnecessary 401s.
- Returns utilization buckets: `five_hour`, `seven_day`, `seven_day_oauth_apps`, `seven_day_opus`, `seven_day_sonnet`, plus `extra_usage` info.

## Function Signatures

### Bootstrap

#### `fetchBootstrapData(): Promise<void>`
Fetches bootstrap config and persists to disk cache. Called at startup. No return value — writes directly to `GlobalConfig`.

> `src/services/api/bootstrap.ts:114-141`

### Grove

#### `getGroveSettings(): Promise<ApiResult<AccountSettings>>`
Session-memoized. Returns account-level Grove settings (enabled state and notice viewed timestamp).

#### `updateGroveSettings(groveEnabled: boolean): Promise<void>`
Toggles Grove on/off. Invalidates memoized cache.

#### `isQualifiedForGrove(): Promise<boolean>`
Non-blocking qualification check. Cache-first with 24h TTL.

#### `calculateShouldShowGrove(settingsResult, configResult, showIfAlreadyViewed): boolean`
Pure function determining Grove dialog visibility.

#### `checkGroveForNonInteractive(): Promise<void>`
Handles Grove consent for headless mode. May exit the process after grace period.

> `src/services/api/grove.ts`

### Referral

#### `fetchReferralEligibility(campaign?): Promise<ReferralEligibilityResponse>`
Direct API call for referral eligibility. Defaults to `claude_code_guest_pass` campaign.

#### `getCachedOrFetchPassesEligibility(): Promise<ReferralEligibilityResponse | null>`
Main entry point. Non-blocking, cache-first.

#### `checkCachedPassesEligibility(): { eligible, needsRefresh, hasCache }`
Synchronous cache check returning current state and staleness info.

#### `formatCreditAmount(reward: ReferrerRewardInfo): string`
Formats reward amount with currency symbol (e.g., `$5`, `€10`).

> `src/services/api/referral.ts`

### Metrics Opt-Out

#### `checkMetricsEnabled(): Promise<MetricsStatus>`
Returns `{ enabled: boolean, hasError: boolean }`. Two-tier cached.

> `src/services/api/metricsOptOut.ts:128-154`

### Overage Credit Grant

#### `getCachedOverageCreditGrant(): OverageCreditGrantInfo | null`
Synchronous cache read. Returns `null` if no cache or stale.

#### `refreshOverageCreditGrantCache(): Promise<void>`
Fire-and-forget background fetch and cache update.

#### `invalidateOverageCreditGrantCache(): void`
Drops current org's cached entry.

#### `formatGrantAmount(info: OverageCreditGrantInfo): string | null`
Formats grant amount for display (USD only currently).

> `src/services/api/overageCreditGrant.ts`

### Admin Requests

#### `createAdminRequest(params: AdminRequestCreateParams): Promise<AdminRequest>`
Creates a limit increase or seat upgrade request. Server deduplicates pending requests.

#### `getMyAdminRequests(requestType, statuses): Promise<AdminRequest[] | null>`
Fetches the current user's admin requests filtered by type and status.

#### `checkAdminRequestEligibility(requestType): Promise<AdminRequestEligibilityResponse | null>`
Checks if a request type is permitted for the org.

> `src/services/api/adminRequests.ts`

### First Token Date

#### `fetchAndStoreClaudeCodeFirstTokenDate(): Promise<void>`
Write-once fetch of the user's first Claude Code usage date.

> `src/services/api/firstTokenDate.ts:12-60`

### Ultrareview Quota

#### `fetchUltrareviewQuota(): Promise<UltrareviewQuotaResponse | null>`
Peek at ultrareview quota. Returns `null` for non-subscribers.

> `src/services/api/ultrareviewQuota.ts:19-38`

### Usage

#### `fetchUtilization(): Promise<Utilization | null>`
Fetches rate limit utilization across time windows.

> `src/services/api/usage.ts:33-63`

## Interface/Type Definitions

### `AccountSettings` (Grove)
| Field | Type | Description |
|-------|------|-------------|
| `grove_enabled` | `boolean \| null` | User's Grove opt-in choice; `null` means undecided |
| `grove_notice_viewed_at` | `string \| null` | ISO timestamp of last notice view |

### `GroveConfig`
| Field | Type | Description |
|-------|------|-------------|
| `grove_enabled` | `boolean` | Whether Grove is enabled for this user |
| `domain_excluded` | `boolean` | Whether the user's email domain is excluded |
| `notice_is_grace_period` | `boolean` | Whether the consent grace period is active |
| `notice_reminder_frequency` | `number \| null` | Days between reminder prompts |

### `ApiResult<T>`
Discriminated union: `{ success: true, data: T } | { success: false }`. Distinguishes API failure from success throughout the Grove module.

### `OverageCreditGrantInfo`
| Field | Type | Description |
|-------|------|-------------|
| `available` | `boolean` | Whether the grant program is available |
| `eligible` | `boolean` | Whether this user is eligible |
| `granted` | `boolean` | Whether credits have been claimed |
| `amount_minor_units` | `number \| null` | Grant amount in cents |
| `currency` | `string \| null` | Currency code (e.g., `USD`) |

### `AdminRequest`
Discriminated union on `request_type`:
- `limit_increase`: `details` is `null`
- `seat_upgrade`: `details` contains optional `message` and `current_seat_tier`

Common fields: `uuid`, `status` (`pending` | `approved` | `dismissed`), `requester_uuid`, `created_at`.

### `UltrareviewQuotaResponse`
| Field | Type | Description |
|-------|------|-------------|
| `reviews_used` | `number` | Reviews consumed this period |
| `reviews_limit` | `number` | Total review allowance |
| `reviews_remaining` | `number` | Reviews still available |
| `is_overage` | `boolean` | Whether user has exceeded quota |

### `Utilization`
Contains optional rate limit buckets (`five_hour`, `seven_day`, `seven_day_oauth_apps`, `seven_day_opus`, `seven_day_sonnet`) each with `utilization` (0–100) and `resets_at` (ISO timestamp), plus `extra_usage` with credit info.

## Edge Cases & Caveats

- **Essential-traffic-only mode**: All non-critical endpoints (`bootstrap`, `grove`, `referral`, `metrics`, `overageCredit`) short-circuit during incidents. This is checked via `isEssentialTrafficOnly()`.

- **OAuth scope requirements**: Metrics opt-out and bootstrap skip execution for service-key OAuth tokens that lack `user:profile` scope (would 403). The metrics module explicitly avoids caching auth-derived answers to prevent poisoning the disk cache for later full-OAuth sessions (`src/services/api/metricsOptOut.ts:130-136`).

- **Non-blocking cold start**: Grove, referral, and overage credit endpoints return safe defaults on first-ever run (no cache) and populate the cache in the background. Features become available on the *next* session, not the current one.

- **Concurrent write safety**: `overageCreditGrant.ts` derives state from `prev` inside `saveGlobalConfig` (which re-reads config from disk under a file lock) rather than from an outer `getGlobalConfig()` read, preventing race conditions between concurrent CLI instances (`src/services/api/overageCreditGrant.ts:88-92`).

- **Grove non-interactive exit**: After the grace period ends, `checkGroveForNonInteractive()` calls `gracefulShutdown(1)` — headless/piped invocations will exit with code 1 if the user hasn't accepted updated terms (`src/services/api/grove.ts:349-355`).

- **Memoization cache invalidation**: Grove's `getGroveSettings` clears its memoize cache on failures (to avoid locking users out for the session) and after mutations (so post-toggle reads are fresh). The referral module uses a module-level promise (`fetchInProgress`) for deduplication instead of memoization.

- **Write amplification prevention**: Multiple endpoints (bootstrap, metrics, overage credits) compare incoming data against cached values and skip disk writes when unchanged, avoiding unnecessary config file churn across frequent startup calls.