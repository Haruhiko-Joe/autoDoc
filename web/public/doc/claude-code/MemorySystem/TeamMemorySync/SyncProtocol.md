# SyncProtocol

## Overview & Responsibilities

The SyncProtocol module (`src/services/teamMemorySync/index.ts`) is the core synchronization engine for team memory — shared memory files that are synced between the local filesystem and the Anthropic server API. It sits within the **MemorySystem → TeamMemorySync** subtree and works alongside sibling modules: **TeamMemoryPaths** (path validation/security) and the secret scanner.

Team memory is scoped per-repository (identified by git remote slug) and shared across all authenticated organization members. This module implements the complete pull/push lifecycle with delta uploads, ETag-based caching, conflict resolution, secret scanning, and gateway-aware body batching.

**Key design principle**: All mutable state lives in a `SyncState` object created by the caller and threaded through every call — there is no module-level mutable state, giving tests natural isolation.

## Key Processes

### Pull Flow (Server → Local)

1. **Auth check**: Verify OAuth is available via `isUsingOAuth()` (requires first-party Anthropic OAuth with both inference and profile scopes)
2. **Repo resolution**: Resolve the GitHub repo slug via `getGithubRepo()` — used as the team memory partition key
3. **Conditional GET**: Send `GET /api/claude_code/team_memory?repo={slug}` with an `If-None-Match` ETag header (from `state.lastKnownChecksum`) to avoid re-downloading unchanged data
4. **Response handling**:
   - **304 Not Modified**: Return immediately — nothing changed
   - **404**: Clear `serverChecksums` and return (no remote data exists)
   - **200**: Parse the response with `TeamMemoryDataSchema`, extract entries and per-key checksums
5. **Checksum refresh**: Populate `state.serverChecksums` from the server's `entryChecksums` (enables delta push)
6. **Write to disk**: Call `writeRemoteEntriesToLocal()` which validates paths, skips unchanged files, and writes new/modified entries in parallel
7. **Cache invalidation**: If any files were written, clear the memory file cache via `clearMemoryFileCaches()`
8. **Retry logic**: On transient failures (timeout, network), retries up to 3 times with exponential backoff via `getRetryDelay()`. Auth errors and parse failures skip retry (`skipRetry: true`)

> Source: `src/services/teamMemorySync/index.ts:770-867`

### Push Flow (Local → Server)

1. **Read local files**: `readLocalTeamMemory()` walks the team memory directory tree, filtering out files exceeding 250KB and files containing detected secrets (via `scanForSecrets`)
2. **Entry cap enforcement**: If a `serverMaxEntries` cap was learned from a prior 413 response, truncate the entry set alphabetically to that limit
3. **Hash local entries**: Compute `sha256:<hex>` for every local entry (computed once, reused across conflict retries)
4. **Delta computation**: Compare each local hash against `state.serverChecksums` — only keys with differing hashes are included in the upload
5. **Body batching**: Split the delta into batches ≤200KB via `batchDeltaByBytes()` to stay under the API gateway's body-size limit. Batches are sent sequentially; each successful batch updates `serverChecksums`
6. **Upload**: `PUT /api/claude_code/team_memory?repo={slug}` with `If-Match` ETag header for optimistic locking. Server uses upsert semantics
7. **412 Conflict resolution**: On ETag mismatch, perform a lightweight hash probe (`GET ?view=hashes`) to refresh `serverChecksums` without downloading full entry bodies (~300KB savings). Recompute the delta — keys where a teammate pushed identical content are naturally excluded. Retry up to 2 times
8. **413 handling**: Parse structured 413 responses to learn the server's `max_entries` cap (GB-tunable per-org). Cache in `state.serverMaxEntries` for the next push

> Source: `src/services/teamMemorySync/index.ts:889-1146`

### Bidirectional Sync

`syncTeamMemory()` orchestrates a full sync cycle: pull first (with `skipEtagCache: true` for a complete refresh), then push with conflict resolution. Server entries win on pull; local edits win on push.

> Source: `src/services/teamMemorySync/index.ts:1153-1191`

### Local File Tree Walking

`readLocalTeamMemory()` recursively walks the team memory directory using `fs/promises`:
- Skips files over `MAX_FILE_SIZE_BYTES` (250KB)
- Runs each file through `scanForSecrets()` (gitleaks-based rules) before adding to the upload set — files with detected secrets are excluded and logged
- Converts paths to forward-slash relative keys
- When `serverMaxEntries` is known, sorts alphabetically and truncates, ensuring deterministic delta computation

> Source: `src/services/teamMemorySync/index.ts:567-673`

### Remote-to-Local Writes

`writeRemoteEntriesToLocal()` processes entries in parallel:
- Validates each path via `validateTeamMemKey()` — rejects path traversal attempts (`PathTraversalError`)
- Skips oversized entries (>250KB)
- **Skip-if-unchanged optimization**: Reads existing on-disk content and skips the write if it matches, preserving file mtime and avoiding spurious watcher/cache events
- Creates parent directories with `mkdir({ recursive: true })`

> Source: `src/services/teamMemorySync/index.ts:689-755`

## Function Signatures

### `createSyncState(): SyncState`

Factory for the mutable state object. Call once per session; pass to all sync functions.

### `pullTeamMemory(state: SyncState, options?: { skipEtagCache?: boolean }): Promise<{ success, filesWritten, entryCount, notModified?, error? }>`

Pull remote team memory to disk. Returns `notModified: true` on 304. `skipEtagCache` forces a full fetch.

### `pushTeamMemory(state: SyncState): Promise<TeamMemorySyncPushResult>`

Push local edits to the server with delta upload and conflict resolution. Returns `filesUploaded`, optional `skippedSecrets`, and conflict/error details.

### `syncTeamMemory(state: SyncState): Promise<{ success, filesPulled, filesPushed, error? }>`

Bidirectional sync: pull then push. Returns counts of files transferred in each direction.

### `isTeamMemorySyncAvailable(): boolean`

Returns `true` if the user has first-party OAuth with the required scopes.

### `hashContent(content: string): string`

Computes `sha256:<hex>` over UTF-8 bytes. Format matches the server's `entryChecksums` for direct string equality comparison.

### `batchDeltaByBytes(delta: Record<string, string>): Array<Record<string, string>>`

Splits entries into batches where each serialized JSON body is ≤200KB. Uses greedy bin-packing over sorted keys for deterministic batching. A single entry exceeding the limit goes into its own solo batch.

## Interface/Type Definitions

### `SyncState`

| Field | Type | Description |
|-------|------|-------------|
| `lastKnownChecksum` | `string \| null` | Last ETag from the server, used for conditional GET/PUT |
| `serverChecksums` | `Map<string, string>` | Per-key `sha256:<hex>` hashes of server-held content; drives delta computation |
| `serverMaxEntries` | `number \| null` | Server's entry-count cap, learned from a structured 413 response; `null` until observed |

## Configuration & Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `TEAM_MEMORY_SYNC_TIMEOUT_MS` | 30,000 ms | HTTP request timeout |
| `MAX_FILE_SIZE_BYTES` | 250,000 | Per-entry size cap (matches server default) |
| `MAX_PUT_BODY_BYTES` | 200,000 | Max serialized PUT body per batch (stays under gateway's ~256-512KB limit) |
| `MAX_RETRIES` | 3 | Retry count for transient pull failures |
| `MAX_CONFLICT_RETRIES` | 2 | Retry count for 412 conflict resolution on push |

- **`TEAM_MEMORY_SYNC_URL`** (env var): Override the base API URL for the team memory endpoint. Defaults to the OAuth config's `BASE_API_URL`.

## Edge Cases & Caveats

- **Deletions do not propagate**: Deleting a local file will not remove it from the server. The next pull will restore it locally. True deletion requires server-side `soft_delete_keys` (not yet implemented).
- **Local-wins on push conflict**: When the same key is modified both locally and by a teammate, the local version overwrites the server version. This is intentional — the local user is actively editing and can re-incorporate the teammate's changes.
- **Server-wins on pull**: Pull always overwrites local files with server content (per-key). The pull-first ordering in `syncTeamMemory` means server state is applied before the local push.
- **No client-side default for max_entries**: The server's cap is per-org tunable. The client only truncates after learning the cap from a structured 413 response.
- **Partial batch commit on failure**: If batch N fails during a multi-batch push, batches 1..N-1 are already committed server-side. `serverChecksums` is updated after each success, so retries naturally resume from the uncommitted tail.
- **Pre-deploy compatibility**: If the server lacks `entryChecksums` support (pre-#283027), `serverChecksums` stays empty and the next push uploads everything — self-corrects on push success.
- **Secret scanning**: Files containing credentials (detected via gitleaks rules) are silently excluded from push. Only the secret type label is logged, never the secret value itself.
- **Skip-if-unchanged writes**: Remote entries matching on-disk content are not rewritten, preserving file mtime and preventing spurious watcher triggers.

## Key Code Snippets

### Delta Computation (Push)

The core of the delta upload — only keys with changed content are included:

```typescript
// src/services/teamMemorySync/index.ts:966-971
const delta: Record<string, string> = {}
for (const [key, localHash] of localHashes) {
  if (state.serverChecksums.get(key) !== localHash) {
    delta[key] = entries[key]!
  }
}
```

### 412 Conflict Resolution

Lightweight hash probe avoids downloading full entry bodies:

```typescript
// src/services/teamMemorySync/index.ts:1117-1137
const probe = await fetchTeamMemoryHashes(state, repoSlug)
if (!probe.success || !probe.entryChecksums) {
  return { success: false, filesUploaded: 0, conflict: true, error: `...` }
}
state.serverChecksums.clear()
for (const [key, hash] of Object.entries(probe.entryChecksums)) {
  state.serverChecksums.set(key, hash)
}
```

### ETag Conditional Request (Pull)

```typescript
// src/services/teamMemorySync/index.ts:206-209
const headers: Record<string, string> = { ...auth.headers }
if (etag) {
  headers['If-None-Match'] = `"${etag.replace(/"/g, '')}"`
}
```