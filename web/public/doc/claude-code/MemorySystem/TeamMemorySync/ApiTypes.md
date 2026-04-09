# ApiTypes

## Overview & Responsibilities

ApiTypes defines the API contract between the Claude Code client and the server for team memory synchronization. It lives within the **MemorySystem → TeamMemorySync** subsystem and is the single source of truth for all request/response shapes used by the sync protocol.

The module provides:
- **Zod schemas** for runtime validation of server responses (GET payloads, 413 error bodies)
- **TypeScript types** inferred from those schemas plus hand-written result types for each sync operation (fetch, push, upload, hash-probe)
- The **`SkippedSecretFile`** type used by client-side secret scanning to track files excluded from push

Every other TeamMemorySync module (the sync engine, the file watcher, the API client) imports from this file to ensure type-safe, validated communication with the server.

## Zod Schemas

All schemas are wrapped in `lazySchema()` (from `src/utils/lazySchema.ts`) to defer Zod construction until first use, keeping module load lightweight.

### `TeamMemoryContentSchema`

Flat key-value storage representing the memory entries themselves.

| Field | Type | Description |
|-------|------|-------------|
| `entries` | `Record<string, string>` | Keys are file paths relative to the team memory directory (e.g. `"MEMORY.md"`); values are UTF-8 content |
| `entryChecksums` | `Record<string, string>` (optional) | Per-key SHA-256 hex digests prefixed with `sha256:`. Optional for backward compatibility with older server deployments |

> Source: `src/services/teamMemorySync/types.ts:16-24`

### `TeamMemoryDataSchema`

Full response body from `GET /api/claude_code/team_memory`. Wraps `TeamMemoryContentSchema` with version metadata.

| Field | Type | Description |
|-------|------|-------------|
| `organizationId` | `string` | Owning organization |
| `repo` | `string` | Repository identifier |
| `version` | `number` | Monotonically increasing version counter |
| `lastModified` | `string` | ISO 8601 timestamp |
| `checksum` | `string` | Overall SHA-256 with `sha256:` prefix |
| `content` | `TeamMemoryContentSchema` | The entries and per-entry checksums |

> Source: `src/services/teamMemorySync/types.ts:29-38`

### `TeamMemoryTooManyEntriesSchema`

Structured body of a 413 (Request Too Large) error when a push exceeds the server's entry limit. Only the "too many entries" case is modeled client-side; the "entry too large" case is prevented by a `MAX_FILE_SIZE_BYTES` pre-check before upload.

```typescript
{
  error: {
    details: {
      error_code: "team_memory_too_many_entries",  // literal
      max_entries: number,       // server-enforced cap (positive int)
      received_entries: number,  // count of entries in the rejected push
    }
  }
}
```

> Source: `src/services/teamMemorySync/types.ts:47-57`

## Result Types

Each sync operation returns a discriminated result object with a `success` boolean, optional error details, and operation-specific metadata.

### `TeamMemorySyncFetchResult`

Returned by the fetch (pull) operation.

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the fetch succeeded |
| `data` | `TeamMemoryData` | Parsed response body (when successful) |
| `isEmpty` | `boolean` | `true` on HTTP 404 — no team memory exists yet |
| `notModified` | `boolean` | `true` on HTTP 304 — ETag matched, no changes |
| `checksum` | `string` | ETag value from the response header |
| `error` | `string` | Error message on failure |
| `skipRetry` | `boolean` | Hint to callers that retrying is pointless |
| `errorType` | `'auth' \| 'timeout' \| 'network' \| 'parse' \| 'unknown'` | Categorized error kind |
| `httpStatus` | `number` | Raw HTTP status code |

> Source: `src/services/teamMemorySync/types.ts:77-87`

### `TeamMemoryHashesResult`

Returned by the lightweight hash-probe operation (`GET ?view=hashes`). Retrieves per-key checksums without downloading entry bodies — used to cheaply refresh `serverChecksums` during 412 conflict resolution.

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the probe succeeded |
| `version` | `number` | Server version number |
| `checksum` | `string` | Overall checksum |
| `entryChecksums` | `Record<string, string>` | Per-key SHA-256 checksums |
| `error` | `string` | Error message on failure |
| `errorType` | `'auth' \| 'timeout' \| 'network' \| 'parse' \| 'unknown'` | Categorized error kind |
| `httpStatus` | `number` | Raw HTTP status code |

> Source: `src/services/teamMemorySync/types.ts:94-102`

### `TeamMemorySyncPushResult`

Returned by the high-level push operation that orchestrates delta uploads.

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the push succeeded |
| `filesUploaded` | `number` | Count of entries actually sent to the server |
| `checksum` | `string` | New checksum after successful push |
| `conflict` | `boolean` | `true` on HTTP 412 — version conflict detected |
| `error` | `string` | Error message on failure |
| `skippedSecrets` | `SkippedSecretFile[]` | Files excluded because secret scanning flagged them |
| `errorType` | `'auth' \| 'timeout' \| 'network' \| 'conflict' \| 'unknown' \| 'no_oauth' \| 'no_repo'` | Categorized error kind (push adds `'conflict'`, `'no_oauth'`, `'no_repo'`) |
| `httpStatus` | `number` | Raw HTTP status code |

> Source: `src/services/teamMemorySync/types.ts:107-124`

### `TeamMemorySyncUploadResult`

Returned by the low-level upload operation (the raw PUT/PATCH call).

| Field | Type | Description |
|-------|------|-------------|
| `success` | `boolean` | Whether the upload succeeded |
| `checksum` | `string` | New checksum from server |
| `lastModified` | `string` | ISO 8601 timestamp from server |
| `conflict` | `boolean` | `true` on HTTP 412 |
| `error` | `string` | Error message on failure |
| `errorType` | `'auth' \| 'timeout' \| 'network' \| 'unknown'` | Categorized error kind |
| `httpStatus` | `number` | Raw HTTP status code |
| `serverErrorCode` | `'team_memory_too_many_entries'` | Structured error code from a parsed 413 body; passed through to analytics as a Datadog facet |
| `serverMaxEntries` | `number` | Server-enforced max entry count (from 413). Lets callers cache the per-org limit |
| `serverReceivedEntries` | `number` | How many entries the rejected push would have produced after merge |

> Source: `src/services/teamMemorySync/types.ts:129-156`

## `SkippedSecretFile` Type

Used by the client-side secret scanning integration (gitleaks-based rules) to record files excluded from a push.

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | File path relative to the team memory directory |
| `ruleId` | `string` | Gitleaks rule ID (e.g. `"github-pat"`, `"aws-access-token"`) |
| `label` | `string` | Human-readable label derived from the rule ID |

> Source: `src/services/teamMemorySync/types.ts:66-72`

## Key Design Decisions

- **Zod + `lazySchema`**: Schemas are defined with Zod for runtime validation of untrusted server responses, wrapped in `lazySchema()` so the Zod parse tree is only allocated on first access rather than at module load time.
- **Inferred types**: `TeamMemoryData` is `z.infer<>` of the schema, keeping the schema and type in sync automatically. The operation result types are hand-written because they include client-side fields (like `skipRetry`, `skippedSecrets`) that have no server schema counterpart.
- **Error categorization**: Every result type carries an `errorType` discriminator with a closed union of string literals, enabling callers to branch on error category without inspecting raw HTTP codes or parsing error messages. The push result extends the base set with domain-specific categories (`'conflict'`, `'no_oauth'`, `'no_repo'`).
- **413 handling split**: The "too many entries" 413 case is parsed via `TeamMemoryTooManyEntriesSchema` and surfaced through `serverErrorCode`/`serverMaxEntries` on the upload result. The "entry too large" 413 case is prevented client-side before the request is made, so no schema exists for it.