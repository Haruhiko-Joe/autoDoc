# Auth and Credentials

## Overview & Responsibilities

The Auth and Credentials module is the authentication backbone of Claude Code, living within the **Infrastructure** layer. It resolves *who* the current user is and *what credentials* should accompany API requests, regardless of whether the user is a Claude.ai subscriber, an API key holder, or authenticating through a cloud provider like AWS Bedrock or GCP Vertex.

This module handles:

- **Multi-source API key resolution** with a strict priority chain (env vars → file descriptors → apiKeyHelper commands → macOS Keychain → config file)
- **OAuth token lifecycle** — reading, caching, refreshing (with cross-process lock coordination), and persisting tokens
- **AWS STS credential validation and refresh** via configurable `awsAuthRefresh` / `awsCredentialExport` commands
- **GCP credential validation and refresh** via configurable `gcpAuthRefresh` commands
- **Secure storage backends** — macOS Keychain (primary on darwin) with plaintext JSON fallback, connected through a fallback-chain adapter
- **CCR (Claude Code Remote) file-descriptor tokens** — pipe-based credential injection for managed sessions
- **Session ingress authentication** for WebSocket/bridge connections
- **Billing and subscription introspection** based on the resolved auth state

Sibling modules in the Infrastructure layer (e.g., configuration, permissions, proxy/TLS) consume the credentials this module provides when making outbound API calls.

## Key Processes

### API Key Resolution Chain

The primary entry point is `getAnthropicApiKeyWithSource()` (`src/utils/auth.ts:226`). It walks a prioritized fallback chain:

1. **`--bare` mode** — only `ANTHROPIC_API_KEY` env var or `apiKeyHelper` from `--settings` flag. No keychain, no OAuth.
2. **`ANTHROPIC_API_KEY` env var** — checked first for CI and `--print` flows, or when user has approved the key suffix in `customApiKeyResponses`.
3. **File descriptor** — `getApiKeyFromFileDescriptor()` reads from a pipe FD set by the CCR Go environment-manager (`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`).
4. **`apiKeyHelper` command** — a user-configured shell command (`settings.apiKeyHelper`) executed with a stale-while-revalidate cache (5-minute default TTL, configurable via `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`). The sync reader `getApiKeyFromApiKeyHelperCached()` returns the last-known value without blocking.
5. **macOS Keychain / config file** — `getApiKeyFromConfigOrMacOSKeychain()` (`src/utils/auth.ts:1051`) checks the legacy keychain entry (with prefetch optimization), then `config.primaryApiKey`.

### OAuth Token Source Resolution

`getAuthTokenSource()` (`src/utils/auth.ts:153`) determines where the bearer token comes from:

1. **`--bare` mode** — only `apiKeyHelper` is allowed.
2. **`ANTHROPIC_AUTH_TOKEN` env var** — external bearer token (skipped in managed OAuth contexts).
3. **`CLAUDE_CODE_OAUTH_TOKEN` env var** — force-set by Claude Desktop or managed sessions.
4. **File descriptor** — `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, with disk fallback for CCR subprocesses.
5. **`apiKeyHelper`** — treated as a token source when configured (skipped in managed OAuth contexts).
6. **Secure storage (Keychain/plaintext)** — tokens stored by `/login` via `saveOAuthTokensIfNeeded()`.

The `isManagedOAuthContext()` guard (`src/utils/auth.ts:91`) prevents CCR and Claude Desktop sessions from falling back to the user's personal `~/.claude/settings.json` API key configuration — those settings are for the terminal CLI only.

### OAuth Token Refresh Flow

`checkAndRefreshOAuthTokenIfNeeded()` (`src/utils/auth.ts:1427`) orchestrates token refresh:

1. **Cross-process staleness check** — `invalidateOAuthCacheIfDiskChanged()` stats `.credentials.json` and clears memoize caches if another process wrote newer tokens.
2. **Expiration check** — skipped when `force=true` (server returned 401).
3. **Async re-read** — `getClaudeAIOAuthTokensAsync()` reads from keychain without blocking the event loop.
4. **File lock** — acquires an exclusive lock on `~/.claude/` to coordinate with other Claude Code instances. Retries up to 5 times with jittered backoff on `ELOCKED`.
5. **Double-check after lock** — re-reads tokens; if another process refreshed while waiting, returns early.
6. **Refresh** — calls `refreshOAuthToken()` with the refresh token. For Claude.ai subscribers, omits scopes to allow scope expansion without re-login.
7. **Save** — `saveOAuthTokensIfNeeded()` writes refreshed tokens to secure storage.

The `handleOAuth401Error()` function (`src/utils/auth.ts:1360`) handles server-side expiration, deduplicating concurrent 401 handlers by failed access token to prevent keychain cache thrashing.

### CCR File Descriptor Credential Injection

`getCredentialFromFd()` (`src/utils/authFileDescriptor.ts:97`) implements a two-tier read:

1. **Pipe FD** — reads from `/dev/fd/<N>` (macOS) or `/proc/self/fd/<N>` (Linux). The FD is passed by the Go environment-manager and can only be read once.
2. **Well-known file fallback** — `/home/claude/.claude/remote/.oauth_token` (or `.api_key`, `.session_ingress_token`). Written by `maybePersistTokenForSubprocesses()` on successful FD read, because pipe FDs don't cross tmux/shell boundaries.

Results are cached in global state. This pattern is shared by OAuth tokens, API keys, and session ingress tokens.

### AWS Credential Refresh

`refreshAndGetAwsCredentials()` (`src/utils/auth.ts:787`) is memoized with a 1-hour TTL:

1. **`awsAuthRefresh`** — runs a configurable command (e.g., `aws sso login`). Only executes if `checkStsCallerIdentity()` fails (STS identity can't be fetched). Output streams to `AwsAuthStatusManager` for UI display. 3-minute timeout.
2. **`awsCredentialExport`** — runs a second command that outputs JSON matching the `AwsStsOutput` shape (`{ Credentials: { AccessKeyId, SecretAccessKey, SessionToken } }`). Validated by `isValidAwsStsOutput()`.
3. **Cache clear** — `clearAwsIniCache()` forces `@aws-sdk/credential-providers` to re-read `~/.aws/credentials`.

Both commands require workspace trust when sourced from project settings.

### GCP Credential Refresh

`refreshGcpCredentialsIfNeeded()` (`src/utils/auth.ts:974`) follows the same pattern as AWS:

1. **Validity check** — `checkGcpCredentialsValid()` attempts to get an access token via `google-auth-library` with a 5-second timeout (prevents 12s hangs when no local credentials exist outside GCP).
2. **`gcpAuthRefresh`** — runs a configurable command (e.g., `gcloud auth application-default login`). 3-minute timeout.
3. Memoized with a 1-hour TTL.

### Session Ingress Authentication

`getSessionIngressAuthToken()` (`src/utils/sessionIngressAuth.ts:101`) resolves the token for WebSocket/bridge connections:

1. **`CLAUDE_CODE_SESSION_ACCESS_TOKEN` env var** — highest priority, updated in-process by `updateSessionIngressAuthToken()`.
2. **File descriptor** — `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR`.
3. **Well-known file** — `CLAUDE_SESSION_INGRESS_TOKEN_FILE` or `/home/claude/.claude/remote/.session_ingress_token`.

`getSessionIngressAuthHeaders()` formats the token as either `Cookie: sessionKey=<token>` (for `sk-ant-sid` session keys, with optional `X-Organization-Uuid`) or `Authorization: Bearer <token>` (for JWTs).

## Secure Storage Architecture

### Backend Selection

`getSecureStorage()` (`src/utils/secureStorage/index.ts:9`) returns a platform-appropriate implementation:

- **macOS** — `createFallbackStorage(macOsKeychainStorage, plainTextStorage)`: tries Keychain first, falls back to plaintext.
- **Linux / other** — `plainTextStorage` only (libsecret support is TODO).

### macOS Keychain Backend

`macOsKeychainStorage` (`src/utils/secureStorage/macOsKeychainStorage.ts:26`) uses the `security` CLI:

- **Read** — `security find-generic-password -a <user> -w -s <service>`. Has a 30-second TTL cache (`KEYCHAIN_CACHE_TTL_MS`) to avoid repeated ~500ms `security` spawns. Implements stale-while-error: transient failures serve the previous cached value rather than poisoning the cache with `null`.
- **Write** — Prefers `security -i` (stdin mode) to hide credentials from process monitors. Falls back to argv when the payload exceeds the 4032-byte `fgets()` stdin buffer limit. Data is hex-encoded to avoid escaping issues.
- **Async read** — `readAsync()` deduplicates concurrent calls with a shared in-flight promise, using a generation counter to prevent stale subprocess results from overwriting fresh cache entries.

The service name is constructed as `Claude Code<oauth-suffix><credentials-suffix><config-dir-hash>` to support multiple config directories.

### Keychain Prefetch

`startKeychainPrefetch()` (`src/utils/secureStorage/keychainPrefetch.ts:69`) fires both keychain reads (OAuth credentials + legacy API key) in parallel at `main.tsx` top-level, overlapping with ~65ms of module imports. Results prime the caches so subsequent sync reads hit cache instead of spawning subprocesses.

### Plaintext Backend

`plainTextStorage` (`src/utils/secureStorage/plainTextStorage.ts:19`) reads/writes `~/.claude/.credentials.json` with `chmod 0o600`. Issues a warning on write.

### Fallback Storage

`createFallbackStorage()` (`src/utils/secureStorage/fallbackStorage.ts:7`) chains primary → secondary:

- **Read** — returns primary if non-null, else secondary.
- **Write** — tries primary first. On first successful primary write, deletes secondary (migration). If primary fails, writes to secondary and deletes stale primary to prevent it from shadowing fresh data.
- **Delete** — deletes from both.

## Function Signatures

### Core Auth Functions

#### `getAnthropicApiKeyWithSource(opts?): { key: string | null, source: ApiKeySource }`
Resolves the API key through the full priority chain. Pass `skipRetrievingKeyFromApiKeyHelper: true` to detect source without executing the helper command.
> `src/utils/auth.ts:226`

#### `getAuthTokenSource(): { source: string, hasToken: boolean }`
Returns the active OAuth/bearer token source without the token value.
> `src/utils/auth.ts:153`

#### `isAnthropicAuthEnabled(): boolean`
Whether first-party Anthropic OAuth is active (false for `--bare`, Bedrock/Vertex/Foundry, or external API keys outside managed contexts).
> `src/utils/auth.ts:100`

#### `checkAndRefreshOAuthTokenIfNeeded(retryCount?, force?): Promise<boolean>`
Refreshes expired OAuth tokens with cross-process file locking. Returns `true` if a fresh token is now available.
> `src/utils/auth.ts:1427`

#### `handleOAuth401Error(failedAccessToken): Promise<boolean>`
Handles server-reported token expiration. Deduplicates concurrent 401 handlers per token.
> `src/utils/auth.ts:1360`

#### `saveOAuthTokensIfNeeded(tokens): { success: boolean, warning?: string }`
Persists OAuth tokens to secure storage. Preserves existing `subscriptionType`/`rateLimitTier` on null profile responses.
> `src/utils/auth.ts:1194`

### AWS/GCP

#### `refreshAndGetAwsCredentials(): Promise<{ accessKeyId, secretAccessKey, sessionToken } | null>`
Memoized (1-hour TTL). Runs auth refresh + credential export commands, clears AWS INI cache.
> `src/utils/auth.ts:787`

#### `refreshGcpCredentialsIfNeeded(): Promise<boolean>`
Memoized (1-hour TTL). Validates GCP credentials and runs refresh command if expired.
> `src/utils/auth.ts:974`

### CCR File Descriptors

#### `getOAuthTokenFromFileDescriptor(): string | null`
Reads OAuth token from `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` FD or CCR well-known file.
> `src/utils/authFileDescriptor.ts:173`

#### `getApiKeyFromFileDescriptor(): string | null`
Reads API key from `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` FD or CCR well-known file.
> `src/utils/authFileDescriptor.ts:188`

### Session Ingress

#### `getSessionIngressAuthToken(): string | null`
Resolves session token from env var → FD → well-known file.
> `src/utils/sessionIngressAuth.ts:101`

#### `getSessionIngressAuthHeaders(): Record<string, string>`
Builds auth headers (Cookie or Bearer) for the current session token.
> `src/utils/sessionIngressAuth.ts:117`

## Interface & Type Definitions

### `AwsCredentials`
| Field | Type | Description |
|-------|------|-------------|
| AccessKeyId | string | AWS access key |
| SecretAccessKey | string | AWS secret key |
| SessionToken | string | STS session token |
| Expiration | string? | ISO timestamp of credential expiry |

> `src/utils/aws.ts:4`

### `AwsAuthStatus`
| Field | Type | Description |
|-------|------|-------------|
| isAuthenticating | boolean | Whether auth refresh is in progress |
| output | string[] | Streamed stdout lines from the refresh command |
| error | string? | Last stderr line |

> `src/utils/awsAuthStatusManager.ts:12`

### `ApiKeySource` (union type)
`'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none'`
> `src/utils/auth.ts:208`

### `SecureStorage` interface
Implemented by all storage backends with `read()`, `readAsync()`, `update(data)`, `delete()`, and a `name` field.

## Configuration & Defaults

| Setting / Env Var | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Direct API key | — |
| `ANTHROPIC_AUTH_TOKEN` | External bearer token | — |
| `CLAUDE_CODE_OAUTH_TOKEN` | Force-set OAuth token (Claude Desktop, CCR) | — |
| `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` | FD number for pipe-injected API key | — |
| `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` | FD number for pipe-injected OAuth token | — |
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | Session ingress token (env var path) | — |
| `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` | FD for session ingress token | — |
| `CLAUDE_CODE_REMOTE` | Enables CCR mode (managed OAuth context) | — |
| `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` | TTL for apiKeyHelper cache | 300000 (5 min) |
| `settings.apiKeyHelper` | Shell command that prints an API key | — |
| `settings.awsAuthRefresh` | Shell command for AWS SSO login | — |
| `settings.awsCredentialExport` | Shell command that prints AWS STS JSON | — |
| `settings.gcpAuthRefresh` | Shell command for GCP auth login | — |
| `DISABLE_COST_WARNINGS` | Suppresses billing access checks | — |
| Keychain cache TTL | `KEYCHAIN_CACHE_TTL_MS` | 30000 (30 sec) |
| API key helper TTL | `DEFAULT_API_KEY_HELPER_TTL` | 300000 (5 min) |
| AWS STS credential TTL | `DEFAULT_AWS_STS_TTL` | 3600000 (1 hr) |
| GCP credential TTL | `DEFAULT_GCP_CREDENTIAL_TTL` | 3600000 (1 hr) |
| AWS auth refresh timeout | `AWS_AUTH_REFRESH_TIMEOUT_MS` | 180000 (3 min) |
| GCP auth refresh timeout | `GCP_AUTH_REFRESH_TIMEOUT_MS` | 180000 (3 min) |
| GCP credentials check timeout | `GCP_CREDENTIALS_CHECK_TIMEOUT_MS` | 5000 (5 sec) |

## Edge Cases & Caveats

- **Managed OAuth context isolation** — When `CLAUDE_CODE_REMOTE=1` or `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, the user's personal settings (`apiKeyHelper`, `ANTHROPIC_API_KEY` from settings.env) are ignored. Without this guard, a stale personal API key could hijack managed sessions.

- **Stale-while-error in Keychain reads** — If `security find-generic-password` fails transiently, the previous cached value is served rather than caching `null`. This prevents a single subprocess failure from surfacing as "Not logged in" across all subsystems.

- **Keychain stdin buffer overflow** — The macOS `security -i` command has a 4096-byte `fgets()` buffer. Payloads exceeding ~4032 bytes fall back to argv mode. Without this, the credential write silently corrupts (`src/utils/secureStorage/macOsKeychainStorage.ts:22-24`).

- **Cross-process token refresh coordination** — File locking on `~/.claude/` with jittered retry prevents multiple Claude Code instances from racing to refresh the same OAuth token (which would revoke the first instance's new token).

- **`apiKeyHelper` stale-while-revalidate** — When the cached key is past TTL, the stale value is returned immediately while a background refresh runs. On background refresh failure, the stale working key is preserved rather than replaced with the `' '` error sentinel.

- **Keychain prefetch timing** — Both keychain reads fire before main module evaluation completes (~65ms). If the prefetch times out (10s), the cache is *not* primed — the sync path retries with its own timeout to avoid masking a real key with `null`.

- **Keychain lock detection** — `isMacOsKeychainLocked()` (`src/utils/secureStorage/macOsKeychainStorage.ts:211`) is cached for the process lifetime because keychain lock state doesn't change during a CLI session, and each check is a ~27ms sync subprocess spawn.

- **`forceLoginOrgUUID` validation** — Fails closed: if the profile endpoint can't be reached, the org check fails rather than silently allowing a wrong-org token. The check is skipped over `ANTHROPIC_UNIX_SOCKET` (SSH proxy) since the local side already validated.

- **Session ingress token formats** — `sk-ant-sid*` tokens use Cookie-based auth with optional `X-Organization-Uuid`; all other tokens use Bearer auth (`src/utils/sessionIngressAuth.ts:120-131`).

- **AWS/GCP auth refresh workspace trust** — All configurable shell commands (`awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `apiKeyHelper`) from project/local settings require workspace trust before execution. This prevents untrusted repositories from executing arbitrary commands.