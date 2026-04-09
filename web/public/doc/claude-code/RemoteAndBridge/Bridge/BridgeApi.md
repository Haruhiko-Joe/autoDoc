# BridgeApi

## Overview & Responsibilities

BridgeApi is the HTTP client layer that enables Claude Code to communicate with the bridge backend — the server-side infrastructure that powers "Remote Control" sessions on claude.ai. It sits within the **RemoteAndBridge → Bridge** subsystem and provides the low-level API calls that higher-level bridge orchestrators (`replBridge.ts`, `bridgeMain.ts`, `remoteBridgeCore.ts`) depend on.

The module spans three files with distinct roles:

- **`bridgeApi.ts`** — The `BridgeApiClient` factory: environment registration, work polling, acknowledgment, stop, heartbeat, deregistration, permission event dispatch, session archival, and session reconnection. All requests flow through a centralized error handler and an OAuth 401 refresh-and-retry mechanism.
- **`createSession.ts`** — Session lifecycle operations (create, get, archive, update title) via the Sessions API (`/v1/sessions`), with git source metadata and optional conversation history pre-population.
- **`bridgeConfig.ts`** — Auth token and base URL resolution, centralizing Anthropic-internal dev overrides (`CLAUDE_BRIDGE_*` env vars) so they aren't copy-pasted across dozens of callers.

## Key Processes

### Environment Registration Flow

1. `registerBridgeEnvironment()` sends `POST /v1/environments/bridge` with machine metadata (name, directory, branch, git URL, max sessions, worker type)
2. The request goes through `withOAuthRetry()`, which resolves the access token and handles 401 refresh
3. If a `reuseEnvironmentId` is provided (session resume scenario), it's included in the body for idempotent re-registration
4. The backend returns `{ environment_id, environment_secret }` — the secret is used for subsequent work-polling calls

> Source: `src/bridge/bridgeApi.ts:142-197`

### Work Polling & Dispatch

1. `pollForWork()` sends `GET /v1/environments/{id}/work/poll` with the environment secret (not the OAuth token)
2. Supports a `reclaimOlderThanMs` query parameter to reclaim stale work items
3. Tracks consecutive empty polls internally, logging at the 1st empty response and every 100th thereafter to reduce noise
4. Returns `WorkResponse | null` — null means no work is available

> Source: `src/bridge/bridgeApi.ts:199-247`

### OAuth 401 Refresh-and-Retry

The `withOAuthRetry()` wrapper implements a single-retry pattern for OAuth token expiration:

1. Resolve the current access token via `resolveAuth()`
2. Execute the request
3. On 401, call the injected `onAuth401` handler (which triggers `handleOAuth401Error` from the auth utilities)
4. If refresh succeeds, resolve the new token and retry once
5. If the retry also returns 401, return the response for `handleErrorStatus` to throw `BridgeFatalError`

Not all callers provide `onAuth401` — daemon workers using env-var tokens skip refresh since their tokens can't be refreshed. The `onAuth401` callback is injected rather than imported directly to avoid pulling in the full `src/utils/auth.ts` → `config.ts` → `permissions/filesystem.ts` → `sessionStorage.ts` → `commands.ts` module graph (~1300 modules).

> Source: `src/bridge/bridgeApi.ts:106-139`

### Session Creation Flow

1. `createBridgeSession()` resolves an OAuth token and organization UUID
2. Parses the git remote URL into structured `GitSource` and `GitOutcome` objects (tries `parseGitRemote` first, falls back to `parseGitHubRepository`)
3. Builds the request body with events (conversation history wrapped as `SessionEvent[]`), session context (sources, outcomes, model), environment ID, and permission mode
4. Sends `POST /v1/sessions` with org-scoped headers (`x-organization-uuid`, `anthropic-beta: ccr-byoc-2025-07-29`)
5. Returns the session ID on success, `null` on any failure (non-fatal)

> Source: `src/bridge/createSession.ts:34-180`

### Error Handling Strategy

`handleErrorStatus()` classifies HTTP errors into two categories:

| Status | Behavior | Error Type |
|--------|----------|------------|
| 200, 204 | Success, no-op | — |
| 401 | `BridgeFatalError` — auth failed | Fatal |
| 403 | `BridgeFatalError` — expired session or access denied | Fatal |
| 404 | `BridgeFatalError` — not found / feature unavailable | Fatal |
| 410 | `BridgeFatalError` — environment expired | Fatal |
| 429 | Standard `Error` — rate limited (retryable) | Retryable |
| Other | Standard `Error` — generic failure | Retryable |

The `BridgeFatalError` class carries a `status` code and optional `errorType` string from the server response, enabling callers to make nuanced decisions (e.g., `isSuppressible403()` silences 403s for non-critical scopes like `external_poll_sessions`).

> Source: `src/bridge/bridgeApi.ts:454-499`

## Function Signatures

### `createBridgeApiClient(deps: BridgeApiDeps): BridgeApiClient`

Factory function that returns the full `BridgeApiClient` interface. All methods share the injected dependencies.

**`BridgeApiDeps`**:

| Field | Type | Description |
|-------|------|-------------|
| `baseUrl` | `string` | Bridge API base URL |
| `getAccessToken` | `() => string \| undefined` | Resolves the current OAuth token |
| `runnerVersion` | `string` | Sent as `x-environment-runner-version` header |
| `onDebug` | `(msg: string) => void` | Optional debug logger |
| `onAuth401` | `(staleToken: string) => Promise<boolean>` | Optional 401 refresh handler |
| `getTrustedDeviceToken` | `() => string \| undefined` | Optional trusted device token for elevated security |

### `BridgeApiClient` Methods

- **`registerBridgeEnvironment(config)`** → `Promise<{ environment_id, environment_secret }>` — Registers a new bridge environment
- **`pollForWork(environmentId, environmentSecret, signal?, reclaimOlderThanMs?)`** → `Promise<WorkResponse | null>` — Long-polls for work items
- **`acknowledgeWork(environmentId, workId, sessionToken)`** → `Promise<void>` — Acknowledges receipt of a work item
- **`stopWork(environmentId, workId, force)`** → `Promise<void>` — Stops a work item (with OAuth retry)
- **`heartbeatWork(environmentId, workId, sessionToken)`** → `Promise<{ lease_extended, state }>` — Extends work lease
- **`deregisterEnvironment(environmentId)`** → `Promise<void>` — Removes the environment registration
- **`sendPermissionResponseEvent(sessionId, event, sessionToken)`** → `Promise<void>` — Sends permission callback responses
- **`archiveSession(sessionId)`** → `Promise<void>` — Archives a session (409 = already archived, treated as success)
- **`reconnectSession(environmentId, sessionId)`** → `Promise<void>` — Reconnects an existing session to an environment

### `createBridgeSession(opts)` → `Promise<string | null>`

Creates a session via `POST /v1/sessions`. Returns the session ID or `null` on failure. Accepts `events` (conversation history as `SessionEvent[]`), git metadata, and an optional `permissionMode`.

> Source: `src/bridge/createSession.ts:34-180`

### `getBridgeSession(sessionId, opts?)` → `Promise<{ environment_id?, title? } | null>`

Fetches session metadata via `GET /v1/sessions/{id}`. Used for `--session-id` resume to retrieve the associated environment ID.

> Source: `src/bridge/createSession.ts:190-244`

### `archiveBridgeSession(sessionId, opts?)` → `Promise<void>`

Archives a session via `POST /v1/sessions/{id}/archive`. Called during shutdown cleanup. Callers must handle errors — this function intentionally does not catch 5xx or network errors.

> Source: `src/bridge/createSession.ts:263-317`

### `updateBridgeSessionTitle(sessionId, title, opts?)` → `Promise<void>`

Updates session title via `PATCH /v1/sessions/{id}`. Best-effort — errors are swallowed. Converts session IDs to compat format via `toCompatSessionId()` (from `src/bridge/sessionIdCompat.ts`) for gateway compatibility.

> Source: `src/bridge/createSession.ts:327-384`

### `validateBridgeId(id, label)` → `string`

Validates that server-provided IDs match `/^[a-zA-Z0-9_-]+$/` before URL interpolation. Prevents path traversal attacks (e.g., `../../admin`).

> Source: `src/bridge/bridgeApi.ts:48-53`

## Configuration (`bridgeConfig.ts`)

Centralizes auth token and base URL resolution with a two-layer strategy:

| Function | Purpose | Resolution Order |
|----------|---------|-----------------|
| `getBridgeTokenOverride()` | Dev-only token override | `CLAUDE_BRIDGE_OAUTH_TOKEN` (requires `USER_TYPE=ant`) |
| `getBridgeBaseUrlOverride()` | Dev-only URL override | `CLAUDE_BRIDGE_BASE_URL` (requires `USER_TYPE=ant`) |
| `getBridgeAccessToken()` | Production token resolver | Override → OAuth keychain via `getClaudeAIOAuthTokens()` from `src/utils/auth.ts` |
| `getBridgeBaseUrl()` | Production URL resolver | Override → `getOauthConfig().BASE_API_URL` from `src/constants/oauth.ts` |

The dev overrides are gated behind `USER_TYPE=ant`, ensuring they only activate for Anthropic-internal development. This file was introduced to consolidate identical override logic that was previously duplicated across ~12 callers.

> Source: `src/bridge/bridgeConfig.ts:1-48`

## Type Definitions

### `BridgeFatalError`

Extends `Error` with:
- `status: number` — HTTP status code (401, 403, 404, 410)
- `errorType: string | undefined` — Server-provided error type (e.g., `"environment_expired"`)

Used to distinguish non-retryable errors (auth, expiry) from transient failures (rate limiting, network errors).

> Source: `src/bridge/bridgeApi.ts:56-66`

### `SessionEvent`

```typescript
type SessionEvent = {
  type: 'event'
  data: SDKMessage
}
```

Wraps SDK messages in the discriminated union format required by `POST /v1/sessions`.

> Source: `src/bridge/createSession.ts:20-23`

### `GitSource` / `GitOutcome`

Git context attached to session creation:
- `GitSource` — the repository URL and revision (branch) the session operates on
- `GitOutcome` — expected output metadata (GitHub repo and branch names for PR creation)

> Source: `src/bridge/createSession.ts:7-16`

## Edge Cases & Caveats

- **Two distinct header sets**: `bridgeApi.ts` uses `anthropic-beta: environments-2025-11-01` for the Environments API, while `createSession.ts` uses `anthropic-beta: ccr-byoc-2025-07-29` with an `x-organization-uuid` header for the Sessions API. Using the wrong headers causes 404s.
- **`pollForWork` uses the environment secret**, not the OAuth token — the secret is obtained during registration and is specific to the environment.
- **409 on archive is not an error**: `archiveSession()` in `bridgeApi.ts` silently accepts 409 (already archived) for idempotent shutdown cleanup.
- **`archiveBridgeSession` in `createSession.ts` does not catch errors** — unlike other session operations that return `null` on failure, this function deliberately throws on 5xx/network errors. Callers wrap with `.catch()`.
- **Dynamic imports in `createSession.ts`**: All dependency imports are done inside function bodies (not at module level) to avoid pulling in the full module graph (~1300 modules). This is an intentional tree-shaking boundary.
- **Session ID compatibility**: `updateBridgeSessionTitle` converts session IDs via `toCompatSessionId()` (from `src/bridge/sessionIdCompat.ts`) because the compat gateway only accepts `session_*` prefixed IDs, while v2 callers may hold `cse_*` IDs.
- **`isSuppressible403()`**: Filters out 403 errors for scopes like `external_poll_sessions` or `environments:manage` that don't affect core functionality — prevents noisy error messages for users whose roles lack optional permissions.
- **Consecutive empty poll tracking**: The client tracks empty poll responses internally and only logs at intervals (1st and every 100th) to avoid flooding debug logs during idle periods.
- **Path traversal protection**: All server-provided IDs are validated against `/^[a-zA-Z0-9_-]+$/` via `validateBridgeId()` before being interpolated into URL paths, preventing injection of `../` or other special characters.