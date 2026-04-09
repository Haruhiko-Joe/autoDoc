# AssistantHistory

## Overview & Responsibilities

The `AssistantHistory` module (`src/assistant/sessionHistory.ts`) provides paginated retrieval of session events for the Claude assistant viewer mode. It sits within the **RemoteAndBridge** subsystem and is responsible for fetching historical conversation events from the CCR (Claude Code Remote) API.

The module has three core responsibilities:

1. **Authentication context preparation** — resolves OAuth tokens and organization identity once, producing a reusable `HistoryAuthCtx` object that avoids redundant auth work across multiple page fetches.
2. **Latest-page fetching** — retrieves the most recent page of session events using an `anchor_to_latest` cursor strategy.
3. **Older-page fetching** — retrieves progressively older pages using a `before_id` cursor for backward pagination.

All API responses are normalized from the raw `SessionEventsResponse` shape into typed `HistoryPage` objects for downstream consumption.

## Key Processes

### Authentication Context Creation

1. `createHistoryAuthCtx(sessionId)` calls `prepareApiRequest()` (`src/utils/teleport/api.ts:181`) to obtain an OAuth `accessToken` and `orgUUID`.
2. It constructs the full events endpoint URL: `{BASE_API_URL}/v1/sessions/{sessionId}/events`, where `BASE_API_URL` comes from the OAuth config (defaults to `https://api.anthropic.com`).
3. It assembles request headers combining OAuth bearer auth (`getOAuthHeaders`), the `anthropic-beta: ccr-byoc-2025-07-29` feature flag, and the `x-organization-uuid` header.
4. The resulting `HistoryAuthCtx` is returned for reuse — callers create it once and pass it into every subsequent page fetch.

> Source: `src/assistant/sessionHistory.ts:31-43`

### Page Fetching (Internal)

All page retrieval flows through a single private `fetchPage()` function:

1. Issues a GET request via `axios` to the events endpoint with the provided query parameters.
2. Uses a 15-second timeout and `validateStatus: () => true` to accept all HTTP status codes without throwing.
3. Network errors are caught and coalesced to `null`.
4. Non-200 responses are logged via `logForDebugging()` and return `null`.
5. Successful responses are mapped into a `HistoryPage`: the `data` array is defensively checked with `Array.isArray()`, and `first_id` / `has_more` are carried through.

> Source: `src/assistant/sessionHistory.ts:45-67`

### Fetching the Latest Events

`fetchLatestEvents(ctx, limit?)` retrieves the newest page of events by passing `{ limit, anchor_to_latest: true }` to the API. The returned events are in chronological order within the page. When `hasMore` is `true` on the result, older events exist beyond this page.

> Source: `src/assistant/sessionHistory.ts:73-78`

### Fetching Older Events

`fetchOlderEvents(ctx, beforeId, limit?)` retrieves the page of events immediately older than the given cursor. The `beforeId` value typically comes from `firstId` of a previously fetched page, enabling backward pagination through the full session history.

> Source: `src/assistant/sessionHistory.ts:81-87`

## Function Signatures

### `createHistoryAuthCtx(sessionId: string): Promise<HistoryAuthCtx>`

Prepares a reusable authentication context for a given session.

- **sessionId** — The remote session ID whose events will be fetched.
- **Returns** — `HistoryAuthCtx` containing the fully-qualified `baseUrl` and pre-built `headers`.

### `fetchLatestEvents(ctx: HistoryAuthCtx, limit?: number): Promise<HistoryPage | null>`

Fetches the most recent page of events.

- **ctx** — Auth context from `createHistoryAuthCtx`.
- **limit** — Maximum number of events to return (default: `HISTORY_PAGE_SIZE` = 100).
- **Returns** — A `HistoryPage` on success, or `null` on network/HTTP failure.

### `fetchOlderEvents(ctx: HistoryAuthCtx, beforeId: string, limit?: number): Promise<HistoryPage | null>`

Fetches a page of events older than the given cursor.

- **ctx** — Auth context from `createHistoryAuthCtx`.
- **beforeId** — Cursor ID; events older than this ID are returned.
- **limit** — Maximum number of events to return (default: `HISTORY_PAGE_SIZE` = 100).
- **Returns** — A `HistoryPage` on success, or `null` on network/HTTP failure.

## Type Definitions

### `HistoryPage` (exported)

| Field | Type | Description |
|-------|------|-------------|
| `events` | `SDKMessage[]` | Session events in chronological order within the page |
| `firstId` | `string \| null` | ID of the oldest event in this page; used as `before_id` cursor for the next-older page |
| `hasMore` | `boolean` | `true` if older events exist beyond this page |

### `HistoryAuthCtx` (exported)

| Field | Type | Description |
|-------|------|-------------|
| `baseUrl` | `string` | Fully-qualified URL to the session's events endpoint |
| `headers` | `Record<string, string>` | Pre-built HTTP headers (auth, beta flag, org UUID) |

### `SessionEventsResponse` (internal)

The raw API response shape before normalization:

| Field | Type | Description |
|-------|------|-------------|
| `data` | `SDKMessage[]` | Array of session event messages |
| `has_more` | `boolean` | Whether older events exist |
| `first_id` | `string \| null` | Oldest event ID in the response |
| `last_id` | `string \| null` | Newest event ID in the response |

## Configuration & Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `HISTORY_PAGE_SIZE` | `100` | Default number of events per page |
| HTTP timeout | `15000` ms | Request timeout for each page fetch |
| `anthropic-beta` | `ccr-byoc-2025-07-29` | Beta feature flag required by the CCR events API |

## Edge Cases & Caveats

- **Graceful failure**: Both `fetchLatestEvents` and `fetchOlderEvents` return `null` on any network error or non-200 HTTP status — callers must handle the `null` case. Errors are logged via `logForDebugging` but never thrown.
- **Defensive array check**: The `data` field from the API response is guarded with `Array.isArray()` — if the API returns an unexpected shape, an empty `events` array is used rather than crashing.
- **`validateStatus: () => true`**: Axios is configured to never throw on HTTP error codes. This means 4xx/5xx responses are handled in application code rather than as exceptions.
- **`last_id` is discarded**: The API returns both `first_id` and `last_id`, but `last_id` is not surfaced in `HistoryPage` since it is not needed for backward pagination.
- **Auth context is not refreshed**: The `HistoryAuthCtx` captures the OAuth token at creation time. If the token expires during a long pagination session, subsequent fetches will fail with a non-200 status and return `null`.