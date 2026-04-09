# SessionIngress

## Overview & Responsibilities

SessionIngress is the session transcript logging service within the APIClient layer of the Services module. It is responsible for persisting conversation log entries to the backend API so that sessions can be resumed, teleported (moved between devices), or replayed later. It sits between the local session state and the remote Anthropic API, ensuring that every conversation turn is durably stored server-side.

The module handles four core concerns:

1. **Appending log entries** with optimistic concurrency control (UUID-chained writes)
2. **Fetching session logs** for session hydration/resume
3. **Teleport event retrieval** via a newer paginated Sessions API (v2)
4. **Concurrency safety** through per-session sequential execution and retry with exponential backoff

## Key Processes

### Appending a Log Entry

The primary write path flows through `appendSessionLog()` → sequential wrapper → `appendSessionLogImpl()`:

1. **Auth check**: `appendSessionLog()` calls `getSessionIngressAuthToken()` to obtain a session ingress JWT. If no token is available, the append is silently dropped (`src/services/api/sessionIngress.ts:198-203`).
2. **Sequential gating**: Each session ID gets its own `sequential()` wrapper (lazily created in `getOrCreateSequentialAppend()`), guaranteeing that only one append is in-flight per session at a time. This prevents race conditions where concurrent writes could corrupt the UUID chain (`src/services/api/sessionIngress.ts:42-55`).
3. **Optimistic concurrency**: Each PUT request includes a `Last-Uuid` header containing the UUID of the previously-written entry. The server uses this to detect out-of-order or conflicting writes (`src/services/api/sessionIngress.ts:71-75`).
4. **Retry loop**: On failure, the implementation retries up to 10 times with exponential backoff (500ms base, capped at 8s). Different HTTP status codes trigger different behaviors (`src/services/api/sessionIngress.ts:69-186`):
   - **200/201**: Success — update `lastUuidMap` and return
   - **409 Conflict**: Two recovery strategies (see below)
   - **401 Unauthorized**: Fail immediately (non-retryable)
   - **429 / other 4xx**: Retry after backoff
   - **5xx / network errors**: Caught in the `catch` block, retried after backoff

### 409 Conflict Recovery

A 409 means the server's UUID chain head doesn't match the client's `Last-Uuid`. This commonly happens when a previous process was killed mid-request and its in-flight write landed after the process died. Two recovery paths exist (`src/services/api/sessionIngress.ts:90-141`):

1. **Entry already stored**: If the server's `x-last-uuid` response header matches the entry being written, the entry was already persisted in a prior attempt — treat as success.
2. **Adopt server state**: If the server's `x-last-uuid` differs, adopt it as the new chain head and retry. If the header is absent (v1 endpoint), fall back to fetching all session logs via GET and walking backward to find the last UUID.

### Fetching Session Logs (Hydration)

Two mechanisms exist for retrieving stored session logs:

**Session Ingress API** (`getSessionLogs` / `getSessionLogsViaOAuth`): Issues a GET request and expects a `{ loglines: Entry[] }` response. After fetching, it updates `lastUuidMap` with the last entry's UUID so subsequent appends chain correctly (`src/services/api/sessionIngress.ts:217-259`).

- `getSessionLogs()` authenticates via session ingress JWT token
- `getSessionLogsViaOAuth()` authenticates via OAuth access token with org UUID header — used for teleporting sessions from the Sessions API
- Supports an `after_last_compact` query param (gated behind `CLAUDE_AFTER_LAST_COMPACT` env var) to fetch only entries after the last compaction point

**Teleport Events API** (`getTeleportEvents`): The newer v2 endpoint using cursor-based pagination (`src/services/api/sessionIngress.ts:291-415`). Key differences from the session ingress path:

- Paginated at 1000 events/page (vs. session-ingress's one-shot 50k limit)
- Uses `next_cursor` for pagination — loops until cursor is absent/null
- Has a 100-page safety cap (100k events) to prevent infinite loops if the server doesn't advance the cursor
- Gracefully handles 404 mid-pagination by returning partial results
- Returns partial data on page cap instead of failing entirely
- Event payloads may be null (threadstore non-generic events or encryption failures) — these are filtered out

## Function Signatures

### `appendSessionLog(sessionId, entry, url): Promise<boolean>`

Public entry point for writing a log entry. Returns `true` on success.

- **sessionId** (`string`): The session to append to
- **entry** (`TranscriptMessage`): The log entry, must include a `uuid` field
- **url** (`string`): The backend API endpoint URL

### `getSessionLogs(sessionId, url): Promise<Entry[] | null>`

Fetches all log entries for a session using session ingress token auth. Returns `null` on auth failure or error, empty array if session has no logs (404).

### `getSessionLogsViaOAuth(sessionId, accessToken, orgUUID): Promise<Entry[] | null>`

Fetches session logs using OAuth authentication. Constructs the URL from the OAuth config's `BASE_API_URL`. Used for cross-device session teleportation.

### `getTeleportEvents(sessionId, accessToken, orgUUID): Promise<Entry[] | null>`

Fetches session transcript via the v2 Sessions API with cursor-based pagination. Throws on 401 with a user-facing re-login message.

### `clearSession(sessionId): void`

Clears cached UUID chain head and sequential wrapper for a single session.

### `clearAllSessions(): void`

Clears all cached session state. Called on `/clear` to free sub-agent session entries.

## Type Definitions

### `SessionIngressError`

Internal interface for error response bodies:

| Field | Type | Description |
|-------|------|-------------|
| error?.message | string | Human-readable error description |
| error?.type | string | Error category identifier |

### `TeleportEventsResponse`

Response shape from `GET /v1/code/sessions/{id}/teleport-events`:

| Field | Type | Description |
|-------|------|-------------|
| data | Array | List of worker events |
| data[].event_id | string | Unique event identifier |
| data[].event_type | string | Event type discriminator |
| data[].is_compaction | boolean | Whether this event is a compaction marker |
| data[].payload | Entry \| null | The transcript entry (null for non-generic events) |
| data[].created_at | string | ISO timestamp |
| next_cursor | string? | Opaque pagination cursor; absent at end-of-stream |

## Module-Level State

Two `Map` objects maintain per-session state (`src/services/api/sessionIngress.ts:23, 29-36`):

- **`lastUuidMap`**: Maps session ID → last successfully written entry UUID. Used for optimistic concurrency control via the `Last-Uuid` header.
- **`sequentialAppendBySession`**: Maps session ID → sequential wrapper function. Ensures appends for a given session are serialized (no concurrent writes).

Both maps are cleared by `clearSession()` / `clearAllSessions()`.

## Configuration & Defaults

| Constant / Env Var | Value | Description |
|--------------------|-------|-------------|
| `MAX_RETRIES` | 10 | Maximum retry attempts for append operations |
| `BASE_DELAY_MS` | 500 | Base delay for exponential backoff (ms) |
| Backoff cap | 8000ms | `Math.min(500 * 2^(attempt-1), 8000)` |
| `CLAUDE_AFTER_LAST_COMPACT` | env var | When truthy, fetches only logs after last compaction |
| Fetch timeout | 20000ms | Axios timeout for GET requests |
| Teleport page size | 1000 | Events per page for teleport events API |
| Teleport max pages | 100 | Safety cap to prevent infinite pagination loops |

## Edge Cases & Caveats

- **Stale UUID after process kill**: If a process is killed while an append is in-flight, the server may accept that write but the client never updates `lastUuidMap`. The next append from a new process will get a 409. The recovery logic handles this by adopting the server's UUID from the `x-last-uuid` header or by re-fetching all logs.
- **401 is non-retryable**: Authentication failures abort immediately rather than burning through retry attempts.
- **`validateStatus: status => status < 500`** on PUT means 4xx responses don't throw — they're handled in the response status checks. Only 5xx and network errors go to the `catch` block.
- **Teleport 404 ambiguity**: During the migration from session-ingress to the v2 Sessions API, a 404 on page 0 could mean either "session not found" or "endpoint not deployed yet." Returning `null` lets the caller fall back to the session-ingress path.
- **Null payloads in teleport events**: Some events (threadstore non-generic, encryption failures) have null payloads and are silently skipped.
- **`next_cursor == null`** (loose equality) is used intentionally to handle both `undefined` (field omitted) and `null` (some serializers emit null). Using strict `=== undefined` would cause infinite loops when the server returns `null`.
- **Teleport graceful degradation**: If the page cap is hit, partial results are returned rather than failing — a truncated transcript is better than no teleport.