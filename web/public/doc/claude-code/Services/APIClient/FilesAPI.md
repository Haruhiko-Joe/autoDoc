# FilesAPI

## Overview & Responsibilities

The FilesAPI module is a client for the Anthropic Files API, providing file upload, download, and listing capabilities. It sits within the **Services > APIClient** layer and is used by the Claude Code agent primarily to download file attachments at session startup and to upload files in BYOC (Bring Your Own Cloud) mode.

The module handles:
- **Downloading** files from the API and saving them to a session-specific workspace directory
- **Uploading** local files to the API as multipart form data
- **Listing** files created after a given timestamp (for 1P/Cloud mode)
- **Parsing** file attachment specs from CLI arguments
- Authentication via OAuth Bearer tokens
- Retry logic with exponential backoff for transient failures
- Concurrency-limited parallel batch operations

## Key Processes

### File Download Flow

1. `downloadSessionFiles()` receives a list of `File` objects (each containing a `fileId` and `relativePath`) and a `FilesApiConfig`
2. Files are processed in parallel via `parallelWithLimit()` with a default concurrency of 5 (`src/services/api/filesApi.ts:317-345`)
3. For each file, `downloadAndSaveFile()` orchestrates the download:
   - Calls `buildDownloadPath()` to construct a safe filesystem path under `{cwd}/{sessionId}/uploads/`, with path traversal protection (rejects paths starting with `..`) (`src/services/api/filesApi.ts:187-210`)
   - Calls `downloadFile()` which issues a `GET /v1/files/{fileId}/content` request with Bearer auth and beta headers (`src/services/api/filesApi.ts:132-180`)
   - On success, creates the parent directory and writes the content to disk
4. `downloadFile()` uses `retryWithBackoff()` for transient errors (5xx, network failures), while 401/403/404 errors fail immediately without retry

### File Upload Flow

1. `uploadSessionFiles()` receives an array of `{ path, relativePath }` objects and processes them in parallel with a concurrency limit of 5 (`src/services/api/filesApi.ts:570-593`)
2. For each file, `uploadFile()` orchestrates the upload (`src/services/api/filesApi.ts:378-552`):
   - Reads the file into memory and validates it against the 500 MB size limit (`src/services/api/filesApi.ts:82`)
   - Constructs a multipart/form-data request body manually using buffer concatenation with a UUID-based boundary
   - Sends a `POST /v1/files` request with a 2-minute timeout
   - Supports `AbortSignal` for cancellation
3. Non-retriable errors (401, 403, 413, cancellation) are handled via `UploadNonRetriableError` to exit the retry loop immediately (`src/services/api/filesApi.ts:555-560`)
4. Analytics events (`tengu_file_upload_failed`) are logged for each failure category

### File Listing Flow (1P/Cloud Mode)

1. `listFilesCreatedAfter()` queries `GET /v1/files` with an `after_created_at` timestamp filter (`src/services/api/filesApi.ts:617-709`)
2. Handles cursor-based pagination: when `has_more` is true, uses the last file's ID as the `after_id` cursor for the next page
3. Returns an array of `FileMetadata` objects with `filename`, `fileId`, and `size`

### Retry Logic

The generic `retryWithBackoff()` function (`src/services/api/filesApi.ts:97-123`) provides retry with exponential backoff:
- Up to 3 attempts (`MAX_RETRIES`)
- Base delay of 500ms, doubling each attempt (500ms, 1000ms, 2000ms)
- The `attemptFn` returns a discriminated union `RetryResult<T>`: `{ done: true, value }` to succeed, or `{ done: false, error }` to trigger a retry
- Non-retriable errors are thrown directly from the attempt function, bypassing the retry loop

## Function Signatures

### `downloadFile(fileId: string, config: FilesApiConfig): Promise<Buffer>`

Downloads a single file's content from the API. Returns the raw bytes. Retries on 5xx and network errors; throws immediately on 401, 403, 404.

### `downloadAndSaveFile(attachment: File, config: FilesApiConfig): Promise<DownloadResult>`

Downloads a file and writes it to `{cwd}/{sessionId}/uploads/{relativePath}`. Returns a `DownloadResult` indicating success or failure, never throws.

### `downloadSessionFiles(files: File[], config: FilesApiConfig, concurrency?: number): Promise<DownloadResult[]>`

Batch downloads with concurrency-limited parallelism (default: 5). Returns results in the same order as input.

### `uploadFile(filePath: string, relativePath: string, config: FilesApiConfig, opts?: { signal?: AbortSignal }): Promise<UploadResult>`

Uploads a single file via multipart form data. Validates file size (max 500 MB). Supports abort via `AbortSignal`. Returns the API-assigned `fileId` on success.

### `uploadSessionFiles(files: Array<{ path: string; relativePath: string }>, config: FilesApiConfig, concurrency?: number): Promise<UploadResult[]>`

Batch uploads with concurrency-limited parallelism (default: 5). Returns results in the same order as input.

### `listFilesCreatedAfter(afterCreatedAt: string, config: FilesApiConfig): Promise<FileMetadata[]>`

Lists files created after the given ISO 8601 timestamp. Automatically paginates through all results.

### `buildDownloadPath(basePath: string, sessionId: string, relativePath: string): string | null`

Constructs a safe download path under `{basePath}/{sessionId}/uploads/`. Returns `null` if the path contains traversal (`..`). Strips redundant prefix segments to avoid nested `uploads/uploads/` directories.

### `parseFileSpecs(fileSpecs: string[]): File[]`

Parses CLI file spec strings in the format `<file_id>:<relative_path>`. Handles the sandbox-gateway convention of passing multiple specs as a single space-separated string.

## Type Definitions

### `File`

| Field | Type | Description |
|-------|------|-------------|
| fileId | string | API file identifier (e.g., `file_011CNha8iCJcU1wXNR6q4V8w`) |
| relativePath | string | Destination path relative to the workspace |

### `FilesApiConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| oauthToken | string | - | OAuth Bearer token for authentication |
| baseUrl | string | `ANTHROPIC_BASE_URL` or `https://api.anthropic.com` | API base URL |
| sessionId | string | - | Session ID used for organizing files into session-specific directories |

### `DownloadResult`

| Field | Type | Description |
|-------|------|-------------|
| fileId | string | The file ID that was downloaded |
| path | string | The filesystem path where the file was saved |
| success | boolean | Whether the download succeeded |
| error | string? | Error message on failure |
| bytesWritten | number? | Number of bytes written on success |

### `UploadResult` (discriminated union on `success`)

**Success variant:**

| Field | Type | Description |
|-------|------|-------------|
| path | string | The relative path of the uploaded file |
| fileId | string | The API-assigned file ID |
| size | number | File size in bytes |
| success | true | Literal `true` |

**Failure variant:**

| Field | Type | Description |
|-------|------|-------------|
| path | string | The relative path of the file |
| error | string | Error description |
| success | false | Literal `false` |

### `FileMetadata`

| Field | Type | Description |
|-------|------|-------------|
| filename | string | Original filename |
| fileId | string | API file identifier |
| size | number | File size in bytes |

## Configuration & Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_RETRIES` | 3 | Maximum retry attempts for API calls |
| `BASE_DELAY_MS` | 500 | Base delay for exponential backoff (500ms, 1s, 2s) |
| `MAX_FILE_SIZE_BYTES` | 500 MB | Maximum upload file size |
| `DEFAULT_CONCURRENCY` | 5 | Maximum parallel downloads/uploads |
| `FILES_API_BETA_HEADER` | `files-api-2025-04-14,oauth-2025-04-20` | Beta feature header enabling the Files API and OAuth on public-api routes |
| `ANTHROPIC_VERSION` | `2023-06-01` | API version header |

**Environment variables** for base URL resolution (checked in order):
1. `ANTHROPIC_BASE_URL` — set by env-manager for the appropriate environment
2. `CLAUDE_CODE_API_BASE_URL` — alternative configuration
3. Falls back to `https://api.anthropic.com`

## Edge Cases & Caveats

- **Path traversal protection**: `buildDownloadPath()` rejects any `relativePath` that normalizes to start with `..`, returning `null` and logging an error. This prevents writes outside the workspace.
- **Redundant prefix stripping**: `buildDownloadPath()` strips redundant `{basePath}/{sessionId}/uploads/` or `/uploads/` prefixes from the relative path to avoid double-nesting (e.g., `uploads/uploads/file.txt`).
- **TOCTOU avoidance on uploads**: File content is read into memory before size validation, avoiding a race condition where the file could change between a stat check and the actual read (`src/services/api/filesApi.ts:372-375` comment).
- **Non-retriable vs retriable errors**: HTTP 401, 403, 404, and 413 are treated as non-retriable and fail immediately. Only 5xx status codes and network errors trigger retries.
- **Upload boundary collisions**: Uses `crypto.randomUUID()` for multipart boundaries to avoid collisions when multiple uploads start in the same millisecond.
- **Space-separated file specs**: `parseFileSpecs()` splits each input string on spaces because the sandbox-gateway may pass multiple specs as a single string (`src/services/api/filesApi.ts:726`).
- **Download timeout**: 60 seconds for downloads, 120 seconds for uploads.
- **Analytics tracking**: Upload failures log `tengu_file_upload_failed` events categorized by error type (`file_read`, `file_too_large`, `auth`, `forbidden`, `size`, `network`). List failures log `tengu_file_list_failed`.