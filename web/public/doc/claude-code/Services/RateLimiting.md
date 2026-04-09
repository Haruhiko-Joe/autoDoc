# Rate Limiting

## Overview & Responsibilities

The Rate Limiting module is responsible for tracking, interpreting, and displaying rate limit information for Claude.ai subscribers. It sits within the **Services** layer and bridges the gap between raw API response headers and user-facing messages shown in the terminal UI.

The module handles several concerns:

- **Parsing API rate limit headers** into a structured `ClaudeAILimits` state object
- **Generating user-facing messages** (errors and warnings) based on limit state, subscription type, and overage status
- **Early warning detection** — alerting users before they hit hard limits, using both server-sent threshold headers and a client-side time-relative fallback
- **A React hook** for reactive UI updates when limits change
- **A mock testing layer** (internal/Ant-only) for simulating every rate limit scenario without hitting the real API

## Key Processes

### Rate Limit Header Extraction Flow

Every API response flows through `extractQuotaStatusFromHeaders()` (`src/services/claudeAiLimits.ts:454-485`):

1. Check if the user is a Claude.ai subscriber (or mock testing is active); bail out if not
2. Run headers through `processRateLimitHeaders()` — if the `/mock-limits` command is active, mock headers are overlaid onto the real ones
3. Extract raw per-window utilization (`five_hour`, `seven_day`) for statusline display
4. Call `computeNewLimitsFromHeaders()` to produce a `ClaudeAILimits` object from the parsed headers
5. Cache the extra-usage disabled reason to global config (persists across sessions)
6. If limits changed (deep equality check via lodash `isEqual`), emit a status change event to all registered listeners

For 429 errors, `extractQuotaStatusFromError()` (`src/services/claudeAiLimits.ts:487-515`) follows the same flow but always forces `status: 'rejected'`.

### Early Warning Detection

Early warnings use a two-tier strategy (`src/services/claudeAiLimits.ts:347-374`):

1. **Header-based (preferred)**: The API sends a `surpassed-threshold` header per claim window (`5h`, `7d`, `overage`). If present, the client constructs an `allowed_warning` status with utilization data.
2. **Time-relative fallback (client-side)**: When the server doesn't send threshold headers, the client checks whether usage is outpacing the time window. For example, using 90% of the 5-hour window when only 72% of the time has elapsed triggers a warning. The 7-day window has three thresholds (25%/50%/75% usage vs time).

```typescript
// src/services/claudeAiLimits.ts:53-70
const EARLY_WARNING_CONFIGS: EarlyWarningConfig[] = [
  {
    rateLimitType: 'five_hour',
    claimAbbrev: '5h',
    windowSeconds: 5 * 60 * 60,
    thresholds: [{ utilization: 0.9, timePct: 0.72 }],
  },
  {
    rateLimitType: 'seven_day',
    claimAbbrev: '7d',
    windowSeconds: 7 * 24 * 60 * 60,
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },
      { utilization: 0.5, timePct: 0.35 },
      { utilization: 0.25, timePct: 0.15 },
    ],
  },
]
```

### Message Generation Flow

`getRateLimitMessage()` (`src/services/rateLimitMessages.ts:45-104`) is the central decision function:

1. If **using overage**: only show a warning if overage status is `allowed_warning`; otherwise suppress
2. If **status is `rejected`**: generate an error via `getLimitReachedText()` — message varies by `rateLimitType` (session, weekly, Opus, Sonnet) and includes reset time
3. If **status is `allowed_warning`**: generate a warning via `getEarlyWarningText()` — but only if utilization > 70% (to avoid false warnings after weekly resets). Team/Enterprise users with overages enabled skip warnings since they seamlessly transition to overage

Two convenience wrappers filter by severity:
- `getRateLimitErrorMessage()` — returns only errors (used by the error handler)
- `getRateLimitWarning()` — returns only warnings (used by the UI footer)

### Startup Quota Check

`checkQuotaStatus()` (`src/services/claudeAiLimits.ts:220-249`) runs at startup in interactive sessions. It makes a minimal 1-token API request to pre-populate limit state before the user's first real query. Skipped in non-interactive (`-p`) mode and when essential-traffic-only privacy is enabled.

## Function Signatures

### `claudeAiLimits.ts` — Core State

| Function | Description |
|----------|-------------|
| `extractQuotaStatusFromHeaders(headers: Headers): void` | Parse rate limit headers from any API response and update global state |
| `extractQuotaStatusFromError(error: APIError): void` | Extract limits from a 429 error response |
| `checkQuotaStatus(): Promise<void>` | Proactive quota check at startup (makes a minimal API call) |
| `emitStatusChange(limits: ClaudeAILimits): void` | Update `currentLimits` and notify all listeners; also logs an analytics event |
| `getRawUtilization(): RawUtilization` | Returns per-window utilization fractions for statusline scripts |
| `getRateLimitDisplayName(type: RateLimitType): string` | Human-readable name for a rate limit type |

### `rateLimitMessages.ts` — Message Generation

| Function | Description |
|----------|-------------|
| `getRateLimitMessage(limits, model): RateLimitMessage \| null` | Central logic: returns `{ message, severity }` or null |
| `getRateLimitErrorMessage(limits, model): string \| null` | Error-only filter (for error handler) |
| `getRateLimitWarning(limits, model): string \| null` | Warning-only filter (for UI footer) |
| `getUsingOverageText(limits): string` | Notification text for overage mode transitions |
| `isRateLimitErrorMessage(text): boolean` | Checks if a string starts with a known rate limit prefix |

### `rateLimitMocking.ts` — Mock Facade

| Function | Description |
|----------|-------------|
| `processRateLimitHeaders(headers): Headers` | Overlay mock headers if `/mock-limits` is active |
| `shouldProcessRateLimits(isSubscriber): boolean` | True if subscriber or mocking is active |
| `checkMockRateLimitError(currentModel, isFastModeActive?): APIError \| null` | Returns a synthetic 429 error for mock scenarios |
| `isMockRateLimitError(error): boolean` | Identifies mock 429s (should not be retried) |

### `claudeAiLimitsHook.ts` — React Hook

| Function | Description |
|----------|-------------|
| `useClaudeAiLimits(): ClaudeAILimits` | React hook that subscribes to limit state changes and triggers re-renders |

## Type Definitions

### `ClaudeAILimits`

The primary state type representing current rate limit status (`src/services/claudeAiLimits.ts:122-136`):

| Field | Type | Description |
|-------|------|-------------|
| `status` | `'allowed' \| 'allowed_warning' \| 'rejected'` | Current quota status |
| `unifiedRateLimitFallbackAvailable` | `boolean` | Whether model fallback (e.g., Opus → Sonnet) is available |
| `resetsAt` | `number?` | Unix timestamp when the limit resets |
| `rateLimitType` | `RateLimitType?` | Which limit window applies (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`) |
| `utilization` | `number?` | 0–1 fraction of limit consumed |
| `overageStatus` | `QuotaStatus?` | Status of extra usage quota |
| `overageResetsAt` | `number?` | When overage quota resets |
| `overageDisabledReason` | `OverageDisabledReason?` | Why overage is unavailable (12 possible reasons) |
| `isUsingOverage` | `boolean?` | True when subscription is rejected but overage is allowed |
| `surpassedThreshold` | `number?` | The warning threshold value that was crossed |

### `OverageDisabledReason`

Union of 12 string literals explaining why extra usage is unavailable (`src/services/claudeAiLimits.ts:107-121`). Examples: `'out_of_credits'`, `'org_service_zero_credit_limit'`, `'member_zero_credit_limit'`.

### `MockScenario`

20 predefined test scenarios available via `/mock-limits` (`src/services/mockRateLimits.ts:60-80`), ranging from `'normal'` to `'overage-exhausted'` to `'fast-mode-limit'`.

## Configuration & Defaults

- **Warning threshold**: 70% utilization — warnings below this are suppressed to avoid false alarms after weekly resets (`src/services/rateLimitMessages.ts:72`)
- **Default mock subscription**: `'max'` when mocking is active without an explicit subscription type (`src/services/mockRateLimits.ts:89`)
- **Ant-only guard**: All mock functionality checks `process.env.USER_TYPE === 'ant'` before executing
- **`CLAUDE_MOCK_HEADERLESS_429`**: Environment variable that triggers a headerless 429 mock (for SDK/`-p` testing where slash commands aren't available)
- **Extra usage disabled reason** is cached in global config via `saveGlobalConfig()` so it persists across sessions

## Edge Cases & Caveats

- **False warning suppression**: When `allowed_warning` is received with utilization < 70%, it is discarded. This handles the case where the API sends stale `allowed_warning` status after a weekly reset when actual usage is low (`src/services/rateLimitMessages.ts:69-78`).
- **Team/Enterprise warning suppression**: Non-billing Team/Enterprise users with overages enabled don't see "approaching limit" warnings, since they seamlessly transition to overage (`src/services/rateLimitMessages.ts:82-94`).
- **Opus-specific mock behavior**: Mock Opus limits only trigger 429s when the current model contains "opus" — this simulates the real API where fallback to Sonnet succeeds (`src/services/rateLimitMocking.ts:78-87`).
- **Fast mode mock limits**: Have a time-based expiry. The expiry timer starts on the first error, not when the scenario is configured. A duration > 20s triggers cooldown behavior; ≤ 20s does not (`src/services/mockRateLimits.ts:574-588`).
- **Representative claim selection**: When multiple limits are exceeded simultaneously, the claim with the **furthest** reset time is used as the representative — this determines which limit name and reset time are displayed to the user (`src/services/mockRateLimits.ts:218-226`).
- **Ant employees** see enhanced error messages with a feedback channel (`#briarpatch-cc`) and a `/reset-limits` command hint (`src/services/rateLimitMessages.ts:339-341`).
- **Non-interactive sessions** (`-p` flag) skip the startup quota check since the real query follows immediately and will update limits from its own response headers (`src/services/claudeAiLimits.ts:233-236`).