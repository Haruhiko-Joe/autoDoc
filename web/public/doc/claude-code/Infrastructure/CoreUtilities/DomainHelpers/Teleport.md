# Teleport

## Overview & Responsibilities

Teleport is the remote environment management module within the Infrastructure → CoreUtilities → DomainHelpers layer. It provides the client-side API for Anthropic's environment provisioning service, enabling Claude Code to create, manage, and interact with remote execution environments (referred to as "CCR" — Claude Code Remote sessions).

The module handles four concerns across its four files:

1. **API client** (`api.ts`) — Authenticated HTTP calls to the Sessions API (`/v1/sessions`) with retry logic, session CRUD, and event dispatch
2. **Environment listing** (`environments.ts`) — Fetches and provisions environment providers (`/v1/environment_providers`), including BYOC (Bring Your Own Compute) environments
3. **Environment selection** (`environmentSelection.ts`) — Resolves which environment to use by combining API data with the multi-source settings hierarchy
4. **Git bundle creation** (`gitBundle.ts`) — Packages the local repository state (including uncommitted work) into a git bundle and uploads it so the remote environment starts with the user's current code

## Key Processes

### Session Lifecycle

1. **Authentication**: Every API call starts with `prepareApiRequest()` (`api.ts:181-198`), which retrieves the OAuth access token from the Claude.ai login and resolves the organization UUID. API key auth is explicitly rejected — only OAuth tokens work.

2. **Environment resolution**: Before creating a session, the system determines which environment to target via `getEnvironmentSelectionInfo()` (`environmentSelection.ts:24-77`). It fetches all environments, then checks the `remote.defaultEnvironmentId` setting across the settings hierarchy (user, project, local, policy) to find a match. If no default is configured, it falls back to the first non-bridge environment.

3. **Session creation**: Sessions are created via the Sessions API. The `SessionContext` type (`api.ts:114-125`) defines the session payload, including git sources, working directory, system prompts, model override, and an optional `seed_bundle_file_id` for seeding the remote filesystem.

4. **Ongoing interaction**: Once a session exists, `sendEventToRemoteSession()` (`api.ts:361-417`) sends user message events to it via `POST /v1/sessions/{id}/events`. The 30-second timeout accommodates cold-start container delays.

### Git Bundle Upload Flow

This is the most intricate process in the module (`gitBundle.ts`). It syncs local repository state — including uncommitted work — to a remote environment:

1. **Cleanup stale refs**: Sweeps `refs/seed/stash` and `refs/seed/root` left by any prior crashed run (`gitBundle.ts:164-168`)

2. **Empty repo guard**: Checks `git for-each-ref --count=1 refs/` to bail early if there are no commits at all (`gitBundle.ts:174-189`)

3. **Capture work-in-progress**: Runs `git stash create` to produce a dangling commit of staged+unstaged changes without touching the working tree or the user's actual stash. If WIP exists, the SHA is stored at `refs/seed/stash` so the bundle includes it (`gitBundle.ts:193-213`)

4. **Tiered bundle creation** (`_bundleWithFallback`, `gitBundle.ts:50-146`): Three attempts at shrinking the bundle to fit under the size limit (default 100 MB, configurable via feature flag `tengu_ccr_bundle_max_bytes`):
   - **`--all`**: Full repo — all refs, tags, branches, plus the stash ref
   - **`HEAD`**: Current branch history only, plus the stash ref
   - **`squashed`**: A single parentless commit containing just the tree snapshot (uses `git commit-tree`), stored at `refs/seed/root` — no history, just the files

5. **Upload**: The bundle file is uploaded to the Files API as `_source_seed.bundle`. The returned `fileId` is set on `SessionContext.seed_bundle_file_id` by the caller.

6. **Cleanup**: The temp bundle file is deleted and both seed refs are removed from the local repo in a `finally` block (`gitBundle.ts:278-291`).

### Retry Logic

`axiosGetWithRetry()` (`api.ts:47-81`) wraps GET requests with exponential backoff: 2s → 4s → 8s → 16s (4 retries, 5 total attempts). It retries on:
- Network errors (no response received)
- Server errors (HTTP 5xx)

Client errors (4xx) are thrown immediately since they are not transient.

## Function Signatures

### `api.ts`

#### `prepareApiRequest(): Promise<{ accessToken: string; orgUUID: string }>`
Validates OAuth authentication and resolves the organization UUID. Throws if unauthenticated.

#### `axiosGetWithRetry<T>(url, config?): Promise<AxiosResponse<T>>`
GET request with exponential backoff retry on transient errors.

#### `fetchCodeSessionsFromSessionsAPI(): Promise<CodeSession[]>`
Lists all sessions from `/v1/sessions`, transforming `SessionResource[]` into the `CodeSession` shape. Parses GitHub URLs from git sources to extract repo owner/name.

#### `fetchSession(sessionId): Promise<SessionResource>`
Fetches a single session by ID. Returns specific error messages for 404 (not found) and 401 (expired auth).

#### `getBranchFromSession(session): string | undefined`
Extracts the first branch name from a session's git repository outcomes.

#### `sendEventToRemoteSession(sessionId, messageContent, opts?): Promise<boolean>`
POSTs a user message event to a session. Returns `true`/`false` rather than throwing on failure.

#### `updateSessionTitle(sessionId, title): Promise<boolean>`
PATCHes the session title. Returns `true`/`false`.

#### `getOAuthHeaders(accessToken): Record<string, string>`
Returns standard headers: `Authorization: Bearer`, `Content-Type: application/json`, `anthropic-version: 2023-06-01`.

### `environments.ts`

#### `fetchEnvironments(): Promise<EnvironmentResource[]>`
GETs `/v1/environment_providers` and returns the environments array.

#### `createDefaultCloudEnvironment(name): Promise<EnvironmentResource>`
POSTs to `/v1/environment_providers/cloud/create` to provision a new `anthropic_cloud` environment with Python 3.11 and Node 20 pre-installed.

### `environmentSelection.ts`

#### `getEnvironmentSelectionInfo(): Promise<EnvironmentSelectionInfo>`
Resolves which environment is selected by combining the API list with the `remote.defaultEnvironmentId` setting. Returns the full environment list, the selected environment, and which settings source the selection came from.

### `gitBundle.ts`

#### `createAndUploadGitBundle(config, opts?): Promise<BundleUploadResult>`
End-to-end: stash WIP → bundle with tiered fallback → upload → cleanup. Accepts an optional `cwd` and `AbortSignal`.

## Type Definitions

### `EnvironmentKind`
`'anthropic_cloud' | 'byoc' | 'bridge'` — the three environment provider types. BYOC is Bring Your Own Compute.

### `EnvironmentResource`
Represents a provisioned environment: `kind`, `environment_id`, `name`, `created_at`, `state`.

### `SessionResource` (`api.ts:127-136`)
The core session object from the API: `id`, `title`, `session_status` (requires_action | running | idle | archived), `environment_id`, timestamps, and `session_context`.

### `SessionContext` (`api.ts:114-125`)
Defines a session's configuration: `sources` (git repos or knowledge bases), `cwd`, `outcomes`, system prompts, model override, `seed_bundle_file_id`, and optional GitHub PR reference.

### `BundleUploadResult` (`gitBundle.ts:30-38`)
Discriminated union: `{ success: true, fileId, bundleSizeBytes, scope, hasWip }` or `{ success: false, error, failReason? }`.

### `BundleScope` (`gitBundle.ts:28`)
`'all' | 'head' | 'squashed'` — which tier of the fallback chain was used.

### `CodeSession` (`api.ts:145-175`)
Zod-validated session shape with `id`, `title`, `description`, `status` (idle | working | waiting | completed | archived | cancelled | rejected), `repo`, `turns`, and timestamps.

## Configuration & Defaults

| Parameter | Source | Default | Description |
|-----------|--------|---------|-------------|
| `remote.defaultEnvironmentId` | Settings hierarchy | First non-bridge env | Which environment to use for remote sessions |
| `tengu_ccr_bundle_max_bytes` | Feature flag (GrowthBook) | 100 MB | Maximum git bundle size before falling to next tier |
| `CCR_BYOC_BETA` | Constant | `'ccr-byoc-2025-07-29'` | Beta header value for BYOC API endpoints |
| Retry delays | Constant | `[2000, 4000, 8000, 16000]` | Exponential backoff intervals for GET retries |

## Edge Cases & Caveats

- **OAuth only**: All API calls require Claude.ai OAuth tokens. API key authentication is explicitly rejected with a message directing users to `/login`.
- **Untracked files excluded**: `git stash create` only captures staged and unstaged changes to tracked files. Untracked files are intentionally not included in the bundle.
- **Stale ref cleanup**: The bundle process cleans up `refs/seed/stash` and `refs/seed/root` both before and after execution, guarding against refs left by a prior crash.
- **Empty repos**: Repos with zero commits are detected early and produce a `failReason: 'empty_repo'` result instead of attempting to bundle.
- **Squashed bundles lose history**: When the repo is too large for `--all` or `HEAD` bundles, the squashed fallback creates a single parentless commit — the remote environment gets the files but no git history.
- **Cold-start timeout**: `sendEventToRemoteSession` uses a 30-second timeout because the CCR worker container may need time to start.
- **Bridge environments skipped**: `getEnvironmentSelectionInfo` prefers the first non-bridge environment as the default when no explicit selection is configured (`environmentSelection.ts:42`).
- **Default cloud environment config**: `createDefaultCloudEnvironment` provisions environments with Python 3.11 and Node 20, a `/home/user` working directory, and default network hosts allowed.