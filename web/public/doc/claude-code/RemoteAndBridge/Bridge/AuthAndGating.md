# Auth & Gating

## Overview & Responsibilities

The AuthAndGating module provides the authentication, security, and feature-gating primitives that the Bridge subsystem depends on for secure remote-controlled sessions. It sits within the **RemoteAndBridge → Bridge** layer of the architecture and is consumed by the bridge lifecycle code (`replBridge.ts`, `bridgeMain.ts`, `remoteBridgeCore.ts`) as well as login flows and bridge API headers.

The module is composed of five focused files:

| File | Responsibility |
|------|---------------|
| `jwtUtils.ts` | JWT decoding (payload, expiry) and proactive token refresh scheduling |
| `trustedDevice.ts` | Trusted device enrollment and token management for elevated-security sessions |
| `workSecret.ts` | Work secret decoding, WebSocket URL construction, worker registration, and session ID comparison |
| `sessionIdCompat.ts` | Session ID format translation between infrastructure (`cse_*`) and compat API (`session_*`) tags |
| `bridgeEnabled.ts` | Runtime entitlement checks, GrowthBook feature gates, and version enforcement |

## Key Processes

### Token Refresh Lifecycle

The token refresh scheduler (`jwtUtils.ts`) keeps long-running bridge sessions authenticated by proactively refreshing tokens before they expire:

1. When a new session token arrives, `schedule()` decodes its JWT `exp` claim via `decodeJwtExpiry()` (`src/bridge/jwtUtils.ts:38-49`)
2. A timer is set to fire `refreshBufferMs` (default 5 minutes) before expiry (`src/bridge/jwtUtils.ts:125-139`)
3. When the timer fires, `doRefresh()` calls the injected `getAccessToken()` to obtain a fresh OAuth token (`src/bridge/jwtUtils.ts:165-174`)
4. On success, the `onRefresh` callback delivers the token to the transport layer, and a follow-up timer is scheduled at the fallback interval (30 minutes) to keep the chain alive (`src/bridge/jwtUtils.ts:220-229`)
5. On failure, up to `MAX_REFRESH_FAILURES` (3) retries are attempted at 60-second intervals before the chain is abandoned (`src/bridge/jwtUtils.ts:196-204`)

A generation counter per session prevents stale async `doRefresh()` calls from setting orphaned timers after a `cancel()` or re-`schedule()` (`src/bridge/jwtUtils.ts:91-100`).

An alternative entry point, `scheduleFromExpiresIn()`, accepts an explicit TTL in seconds (e.g., from a `POST /bridge` response's `expires_in` field) instead of decoding a JWT. It clamps the delay to a 30-second floor to prevent tight-looping if the buffer exceeds the server's TTL (`src/bridge/jwtUtils.ts:147-163`).

### Trusted Device Enrollment

Trusted device tokens provide elevated security for bridge sessions (SecurityTier=ELEVATED on CCR v2). Enrollment must happen immediately after login because the server restricts it to sessions younger than 10 minutes:

1. During `/login`, `enrollTrustedDevice()` checks the `tengu_sessions_elevated_auth_enforcement` GrowthBook gate via `checkGate_CACHED_OR_BLOCKING` (awaits any in-flight GrowthBook re-init) (`src/bridge/trustedDevice.ts:98-108`)
2. If the `CLAUDE_TRUSTED_DEVICE_TOKEN` env var is set, enrollment is skipped — the env var takes precedence for enterprise/canary deployments (`src/bridge/trustedDevice.ts:112-117`)
3. A `POST /api/auth/trusted_devices` request is sent with the device's hostname and platform as display name (`src/bridge/trustedDevice.ts:145-159`)
4. The returned `device_token` is persisted to the OS keychain via `secureStorage.update()` (`src/bridge/trustedDevice.ts:182-197`)
5. The memoized `readStoredToken()` cache is cleared so subsequent bridge API calls pick up the new token (`src/bridge/trustedDevice.ts:198`)

On every bridge API call (poll, heartbeat, ack), `getTrustedDeviceToken()` checks the GrowthBook gate live (allowing runtime gate flips) and returns the memoized keychain value. The memoization avoids spawning a macOS `security` subprocess (~40ms) on every call (`src/bridge/trustedDevice.ts:45-59`).

### Work Secret Decoding & URL Construction

When the bridge receives a work assignment from the Environments API, it includes a base64url-encoded work secret:

1. `decodeWorkSecret()` decodes the base64url payload, parses the JSON, and validates `version === 1` and the presence of `session_ingress_token` and `api_base_url` (`src/bridge/workSecret.ts:6-32`)
2. `buildSdkUrl()` constructs a WebSocket URL for the v1 (env-based) path: `wss://{host}/v1/session_ingress/ws/{sessionId}`. For localhost, it uses `ws://` and `/v2/` (direct to session-ingress, no Envoy rewrite) (`src/bridge/workSecret.ts:41-48`)
3. `buildCCRv2SdkUrl()` constructs an HTTP(S) URL for the CCR v2 path: `{base}/v1/code/sessions/{sessionId}` — the child process derives SSE stream and worker endpoints from this base (`src/bridge/workSecret.ts:81-87`)
4. `registerWorker()` sends `POST {sessionUrl}/worker/register` to claim the worker slot, returning the `worker_epoch` that must be included in all subsequent heartbeat/state/event requests (`src/bridge/workSecret.ts:97-127`)

### Session ID Translation

CCR v2 introduces a dual-tag system where the same underlying UUID appears as `cse_*` (infrastructure layer) or `session_*` (compat API layer):

- `toCompatSessionId()` rewrites `cse_` → `session_` for client-facing compat endpoints (`/v1/sessions/{id}`, archive, events) (`src/bridge/sessionIdCompat.ts:38-42`)
- `toInfraSessionId()` rewrites `session_` → `cse_` for infrastructure calls like `/v1/environments/{id}/bridge/reconnect` (`src/bridge/sessionIdCompat.ts:54-57`)
- `sameSessionId()` in `workSecret.ts` compares IDs by their UUID suffix (everything after the last underscore, requiring ≥4 chars) regardless of prefix tag (`src/bridge/workSecret.ts:62-73`)

The `cse_` shim is controlled by a GrowthBook kill-switch (`tengu_bridge_repl_v2_cse_shim_enabled`). The gate function is injected via `setCseShimGate()` to avoid pulling GrowthBook dependencies into the SDK bundle (`src/bridge/sessionIdCompat.ts:15-23`).

### Bridge Entitlement Checks

`bridgeEnabled.ts` provides a layered gating system that determines whether Remote Control is available:

1. **Build-time gate**: `feature('BRIDGE_MODE')` eliminates GrowthBook string literals from external builds (`src/bridge/bridgeEnabled.ts:32`)
2. **Subscription check**: `isClaudeAISubscriber()` excludes Bedrock, Vertex, Foundry, API-key-only, and Console API logins (`src/bridge/bridgeEnabled.ts:94-100`)
3. **GrowthBook feature gate**: `tengu_ccr_bridge` controls per-organization rollout (`src/bridge/bridgeEnabled.ts:34`)

Two flavors are exposed:
- `isBridgeEnabled()` — cached/non-blocking, suitable for UI visibility checks
- `isBridgeEnabledBlocking()` — awaits GrowthBook init for entitlement gates where a stale `false` would unfairly block access

`getBridgeDisabledReason()` provides actionable diagnostics: missing subscription, missing `user:profile` scope (setup-token/env-var tokens), missing organization UUID, or gate-off (`src/bridge/bridgeEnabled.ts:70-87`).

## Function Signatures

### jwtUtils.ts

#### `decodeJwtPayload(token: string): unknown | null`
Decodes a JWT's payload segment without signature verification. Strips the `sk-ant-si-` session-ingress prefix if present.

#### `decodeJwtExpiry(token: string): number | null`
Extracts the `exp` claim (Unix seconds) from a JWT. Returns `null` if the token is malformed or has no `exp`.

#### `createTokenRefreshScheduler(opts): { schedule, scheduleFromExpiresIn, cancel, cancelAll }`
Factory that returns a per-session refresh scheduler. Parameters:
- **`getAccessToken`** `() => string | undefined | Promise<...>` — obtains a fresh OAuth token
- **`onRefresh`** `(sessionId, oauthToken) => void` — callback to deliver the refreshed token
- **`label`** `string` — log prefix (e.g. `"repl-bridge"`)
- **`refreshBufferMs`** `number` (default `300000`) — how far before expiry to trigger refresh

Returned methods:
- **`schedule(sessionId, token)`** — decode JWT expiry and schedule refresh
- **`scheduleFromExpiresIn(sessionId, expiresInSeconds)`** — schedule from an explicit TTL
- **`cancel(sessionId)`** — cancel a single session's refresh chain
- **`cancelAll()`** — cancel all active refresh chains

### trustedDevice.ts

#### `getTrustedDeviceToken(): string | undefined`
Returns the trusted device token if the GrowthBook gate is enabled. Reads from `CLAUDE_TRUSTED_DEVICE_TOKEN` env var (if set) or OS keychain (memoized).

#### `clearTrustedDeviceTokenCache(): void`
Clears the memoized keychain read. Called on logout via `clearAuthRelatedCaches`.

#### `clearTrustedDeviceToken(): void`
Removes the token from secure storage and clears the memo cache. Called before enrollment during `/login` to prevent stale tokens from a previous account.

#### `enrollTrustedDevice(): Promise<void>`
Best-effort enrollment via `POST /api/auth/trusted_devices`. Must be called within 10 minutes of login (server-enforced). Persists the returned `device_token` to keychain.

### workSecret.ts

#### `decodeWorkSecret(secret: string): WorkSecret`
Decodes a base64url work secret, validates `version === 1` and required fields. Throws on invalid input.

#### `buildSdkUrl(apiBaseUrl: string, sessionId: string): string`
Builds a `wss://` WebSocket URL for session-ingress (v1 env-based path). Uses `ws://` and `/v2/` for localhost.

#### `buildCCRv2SdkUrl(apiBaseUrl: string, sessionId: string): string`
Builds an `https://` URL at `/v1/code/sessions/{sessionId}` for the CCR v2 path.

#### `registerWorker(sessionUrl: string, accessToken: string): Promise<number>`
Registers this bridge as the worker for a CCR v2 session via `POST {sessionUrl}/worker/register`. Returns `worker_epoch` (handles protojson int64-as-string encoding).

#### `sameSessionId(a: string, b: string): boolean`
Compares two session IDs by their UUID suffix (after the last `_`), ignoring tag prefixes. Requires the suffix to be ≥ 4 chars to avoid false matches.

### sessionIdCompat.ts

#### `setCseShimGate(gate: () => boolean): void`
Registers the GrowthBook kill-switch function. Called by bridge init code.

#### `toCompatSessionId(id: string): string`
Rewrites `cse_{body}` → `session_{body}` for compat API endpoints. No-op if the shim gate is disabled or the ID doesn't start with `cse_`.

#### `toInfraSessionId(id: string): string`
Rewrites `session_{body}` → `cse_{body}` for infrastructure endpoints. No-op for non-`session_` IDs.

### bridgeEnabled.ts

#### `isBridgeEnabled(): boolean`
Non-blocking runtime check: subscription + cached `tengu_ccr_bridge` gate. Safe for render loops.

#### `isBridgeEnabledBlocking(): Promise<boolean>`
Blocking check that awaits GrowthBook init. Use at entitlement gates.

#### `getBridgeDisabledReason(): Promise<string | null>`
Returns an actionable error message, or `null` if bridge is enabled. Checks subscription, profile scope, organization UUID, and gate.

#### `isEnvLessBridgeEnabled(): boolean`
Checks the `tengu_bridge_repl_v2` gate for the v2 (env-less) REPL bridge path.

#### `isCseShimEnabled(): boolean`
Kill-switch for the `cse_*` → `session_*` retag shim (`tengu_bridge_repl_v2_cse_shim_enabled`, default `true`).

#### `checkBridgeMinVersion(): string | null`
Returns an error string if the CLI version is below the `tengu_bridge_min_version` config floor, or `null` if acceptable.

#### `getCcrAutoConnectDefault(): boolean`
Default for `remoteControlAtStartup` config: `true` when `CCR_AUTO_CONNECT` build flag and `tengu_cobalt_harbor` gate are both on.

#### `isCcrMirrorEnabled(): boolean`
Opt-in CCR mirror mode: `CLAUDE_CODE_CCR_MIRROR` env var or `tengu_ccr_mirror` GrowthBook gate.

## Configuration & Defaults

| Constant / Config | Value | Location | Description |
|-------------------|-------|----------|-------------|
| `TOKEN_REFRESH_BUFFER_MS` | 5 min (300,000 ms) | `jwtUtils.ts:52` | How far before JWT expiry to trigger refresh |
| `FALLBACK_REFRESH_INTERVAL_MS` | 30 min (1,800,000 ms) | `jwtUtils.ts:55` | Follow-up refresh interval when expiry is unknown |
| `MAX_REFRESH_FAILURES` | 3 | `jwtUtils.ts:58` | Consecutive failures before abandoning refresh chain |
| `REFRESH_RETRY_DELAY_MS` | 60 s (60,000 ms) | `jwtUtils.ts:61` | Delay between retry attempts on OAuth token failure |
| `CLAUDE_TRUSTED_DEVICE_TOKEN` | env var | `trustedDevice.ts:47` | Override for trusted device token (testing/enterprise) |
| `CLAUDE_CODE_CCR_MIRROR` | env var | `bridgeEnabled.ts:199` | Opt-in for CCR mirror mode |

### GrowthBook Gates

| Gate | Purpose | Default |
|------|---------|---------|
| `tengu_ccr_bridge` | Enables Remote Control per-organization | `false` |
| `tengu_bridge_repl_v2` | Enables env-less (v2) REPL bridge path | `false` |
| `tengu_bridge_repl_v2_cse_shim_enabled` | Kill-switch for `cse_`→`session_` retag | `true` |
| `tengu_sessions_elevated_auth_enforcement` | Enables trusted device token flow | `false` |
| `tengu_bridge_min_version` | Dynamic config with `minVersion` floor | `0.0.0` |
| `tengu_cobalt_harbor` | Auto-connect to CCR at startup | `false` |
| `tengu_ccr_mirror` | CCR mirror mode rollout | `false` |

## Edge Cases & Caveats

- **JWT prefix stripping**: `decodeJwtPayload` strips the `sk-ant-si-` prefix from session-ingress tokens before splitting on `.` — callers don't need to pre-process tokens (`src/bridge/jwtUtils.ts:22-24`).

- **Non-decodable tokens**: If `schedule()` receives a token without a parseable JWT expiry (e.g., a raw OAuth token), it preserves any existing timer rather than clearing it, keeping the refresh chain intact (`src/bridge/jwtUtils.ts:104-113`).

- **Generation counter for stale refresh prevention**: Each `schedule()`/`cancel()` call bumps a per-session generation counter. In-flight `doRefresh()` calls check the generation before setting follow-up timers, preventing orphaned timers after a rapid cancel-then-reschedule sequence (`src/bridge/jwtUtils.ts:176-183`).

- **`scheduleFromExpiresIn` floor clamping**: The delay is clamped to a minimum of 30 seconds to prevent tight-looping if `refreshBufferMs` exceeds the server's `expires_in` (`src/bridge/jwtUtils.ts:157`).

- **Enrollment timing constraint**: The server gates `POST /auth/trusted_devices` on `account_session.created_at < 10min`. Lazy enrollment (e.g., on a 403 from `/bridge`) will fail with `403 stale_session` — enrollment must happen in the `/login` flow (`src/bridge/trustedDevice.ts:95-97`).

- **Account-switch without logout**: `enrollTrustedDevice()` always re-enrolls on login rather than checking for an existing token, because the stored token may belong to a different account (`src/bridge/trustedDevice.ts:131-133`).

- **Circular import avoidance**: `trustedDevice.ts` uses `require()` for `src/utils/auth.ts` to avoid pulling ~1300 transitive modules into daemon callers (`src/bridge/trustedDevice.ts:118-124`). `sessionIdCompat.ts` uses dependency injection (`setCseShimGate`) to avoid importing `bridgeEnabled.ts` → `growthbook.ts` → `config.ts` into the SDK bundle (`src/bridge/sessionIdCompat.ts:8-12`). `bridgeEnabled.ts` uses a namespace import (`import * as authModule`) to break a circular dependency with `src/utils/auth.ts` while preserving mock compatibility (`src/bridge/bridgeEnabled.ts:8-12`).

- **Pre-config safety**: `isClaudeAISubscriber()`, `hasProfileScope()`, and `getOauthAccountInfo()` in `bridgeEnabled.ts` are wrapped in try/catch because they may be called before `enableConfigs()` runs during Commander program definition (`src/bridge/bridgeEnabled.ts:89-116`).

- **protojson int64 handling**: `registerWorker()` handles `worker_epoch` arriving as either a JSON number or a string (protojson encodes int64 as strings to avoid JS precision loss) (`src/bridge/workSecret.ts:115-116`).