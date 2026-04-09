# OAuthFlow

## Overview & Responsibilities

The OAuthFlow module (`src/services/mcp/auth.ts`) is the core authentication engine for MCP server connections in Claude Code. It sits within the **Services > MCPClient > Authentication** hierarchy, alongside sibling modules for IdP login (`src/services/mcp/xaaIdpLogin.ts`), cross-app token exchange (`src/services/mcp/xaa.ts`), and OAuth port management (`src/services/mcp/oauthPort.ts`).

This module provides:

- **`ClaudeAuthProvider`** — an `OAuthClientProvider` implementation that the MCP SDK uses for token storage, retrieval, refresh, Dynamic Client Registration (DCR), PKCE state management, and step-up auth detection
- **`performMCPOAuthFlow`** — the top-level orchestrator that runs either the browser-based PKCE authorization code flow or the XAA (Cross-App Access) flow depending on server config
- **`performMCPXaaAuth`** — silent XAA authentication using a cached IdP `id_token` with RFC 8693 token exchange
- **Token revocation** — RFC 7009-compliant revocation with `client_secret_basic`/`client_secret_post` and Bearer fallback
- **OAuth error normalization** — rewrites non-compliant 2xx error responses (e.g., Slack) into proper 4xx so the SDK's error handling works correctly
- **Auth server metadata discovery** — RFC 9728 → RFC 8414 with path-aware fallback for legacy servers
- **Client secret management** — secure storage helpers for reading, saving, and clearing MCP client secrets
- **Analytics instrumentation** — structured events for flow start, success, failure, and refresh outcomes

## Key Processes

### Standard OAuth Authorization Code Flow (PKCE)

This is the primary authentication path for MCP servers without XAA configuration.

1. **Entry**: `performMCPOAuthFlow()` is called with server name, config, and callbacks (`src/services/mcp/auth.ts:847-856`)
2. **XAA check**: If `serverConfig.oauth.xaa` is set, delegates to `performMCPXaaAuth()` instead (`src/services/mcp/auth.ts:871-901`)
3. **Step-up scope recovery**: Reads any cached `stepUpScope` and `resourceMetadataUrl` from secure storage before clearing credentials (`src/services/mcp/auth.ts:906-935`)
4. **Port allocation**: Uses the configured `callbackPort` or finds an available one via `findAvailablePort()` (`src/services/mcp/auth.ts:960-962`)
5. **Provider setup**: Creates a `ClaudeAuthProvider` instance and fetches OAuth metadata for scope info (`src/services/mcp/auth.ts:968-999`)
6. **Callback server**: Spins up a local HTTP server on `127.0.0.1:{port}` to receive the `/callback` redirect (`src/services/mcp/auth.ts:1099-1151`). Also supports manual callback URL paste for remote environments (`src/services/mcp/auth.ts:1056-1097`)
7. **SDK auth (redirect phase)**: Calls `sdkAuth(provider)` which triggers DCR (if needed), generates PKCE challenge, and redirects to the authorization server (`src/services/mcp/auth.ts:1178-1182`)
8. **Browser open**: `ClaudeAuthProvider.redirectToAuthorization()` opens the browser and notifies the UI (`src/services/mcp/auth.ts:1852-1943`)
9. **Code capture**: The callback server validates `state` (CSRF protection) and captures the authorization `code` (`src/services/mcp/auth.ts:1100-1150`)
10. **Token exchange**: Calls `sdkAuth(provider)` again with the code to exchange for tokens (`src/services/mcp/auth.ts:1220-1224`)
11. **Persistence**: `ClaudeAuthProvider.saveTokens()` writes tokens to secure storage keyed by `serverName|configHash` (`src/services/mcp/auth.ts:1704-1731`)

The flow has a 5-minute timeout and supports cancellation via `AbortSignal`. Failure reasons are categorized and emitted as analytics events.

### XAA (Cross-App Access) Flow

XAA enables SSO-like authentication where one IdP login is shared across all XAA-configured MCP servers.

1. **Entry**: `performMCPXaaAuth()` validates IdP settings, `clientId`, and `clientSecret` (`src/services/mcp/auth.ts:664-713`)
2. **IdP id_token acquisition**: Calls `acquireIdpIdToken()` which uses a cached id_token from the keychain or runs a one-time OIDC authorization_code+PKCE flow at the IdP (`src/services/mcp/auth.ts:728-740`)
3. **OIDC discovery**: Discovers the IdP's token endpoint (`src/services/mcp/auth.ts:744`)
4. **Token exchange**: Calls `performCrossAppAccess()` which runs the RFC 8693 + RFC 7523 exchange chain — no browser required (`src/services/mcp/auth.ts:751-763`)
5. **Token storage**: Writes tokens directly to secure storage including `discoveryState.authorizationServerUrl` so refresh/revocation can find the correct AS (`src/services/mcp/auth.ts:796-824`)

On failure, the module tracks the failure stage (`idp_login`, `discovery`, `token_exchange`, `jwt_bearer`) for analytics attribution. If the token exchange fails with a clearable error, the cached id_token is purged.

### Token Refresh

`ClaudeAuthProvider.refreshAuthorization()` handles token refresh with cross-process safety:

1. **Lockfile acquisition**: Acquires a file lock (`mcp-refresh-{key}.lock`) with up to 5 retries and jittered backoff to prevent concurrent refreshes across Claude Code instances (`src/services/mcp/auth.ts:2090-2136`)
2. **Stale check**: After acquiring the lock, re-reads storage — another process may have already refreshed (`src/services/mcp/auth.ts:2139-2163`)
3. **Metadata resolution**: Uses in-memory cache → persisted discovery state → full RFC 9728 discovery, in that priority order (`src/services/mcp/auth.ts:2222-2249`)
4. **SDK refresh**: Calls `sdkRefreshAuthorization()` with metadata, client info, and the refresh token (`src/services/mcp/auth.ts:2265-2274`)
5. **Transient retry**: Retries up to 3 times with exponential backoff (1s, 2s, 4s) on timeouts, `ServerError`, `TemporarilyUnavailableError`, and `TooManyRequestsError` (`src/services/mcp/auth.ts:2327-2354`)
6. **Invalid grant handling**: On `InvalidGrantError`, checks if another process refreshed successfully before invalidating (`src/services/mcp/auth.ts:2289-2325`)

### XAA Silent Refresh

`ClaudeAuthProvider.tokens()` triggers silent XAA refresh when the access token is missing or expiring and no refresh token is available:

1. **Condition**: XAA enabled, `oauth.xaa` set, no `refreshToken`, and access token expired/expiring within 5 minutes (`src/services/mcp/auth.ts:1585-1591`)
2. **`xaaRefresh()`**: Reads cached id_token from keychain → discovers IdP token endpoint → runs `performCrossAppAccess()` → writes tokens including `clientId`/`clientSecret` (`src/services/mcp/auth.ts:1751-1850`)
3. **Fallback**: If id_token is not cached or the exchange fails, returns `undefined` and the normal needs-auth path kicks in

### Step-Up Auth Detection

`wrapFetchWithStepUpDetection()` wraps the MCP transport's fetch to intercept 403 `insufficient_scope` responses (`src/services/mcp/auth.ts:1354-1374`):

1. Parses the `WWW-Authenticate` header for `scope=` (quoted or unquoted per RFC 6750 §3)
2. Calls `provider.markStepUpPending(scope)` which causes `tokens()` to omit the `refresh_token`
3. This forces the SDK to skip its refresh path (which can't elevate scope per RFC 6749 §6) and fall through to a new PKCE authorization flow with the elevated scope

### Token Revocation

`revokeServerTokens()` performs RFC 7009 token revocation (`src/services/mcp/auth.ts:467-618`):

1. Discovers the revocation endpoint from OAuth metadata (using persisted `discoveryState` for XAA)
2. Determines auth method: prefers `revocation_endpoint_auth_methods_supported`, falls back to `token_endpoint_auth_methods_supported`
3. Revokes refresh token first (prevents new access token generation), then access token
4. `revokeToken()` tries RFC 7009-compliant client auth first; on 401, retries with Bearer auth as fallback for non-compliant servers (`src/services/mcp/auth.ts:381-459`)
5. Always clears local storage regardless of server-side outcome
6. Optionally preserves `stepUpScope` and `discoveryState` when `preserveStepUpState` is true (for re-authentication)

### Auth Server Metadata Discovery

`fetchAuthServerMetadata()` resolves OAuth metadata using a three-tier strategy (`src/services/mcp/auth.ts:256-311`):

1. **Configured URL**: If `authServerMetadataUrl` is provided in the server config, fetches directly (must be HTTPS)
2. **RFC 9728 → RFC 8414**: Probes `/.well-known/oauth-protected-resource` on the MCP server, reads `authorization_servers[0]`, then RFC 8414 against that URL via `discoverOAuthServerInfo()`
3. **Path-aware fallback**: If the MCP server URL has a path component, probes `/.well-known/oauth-authorization-server/{path}` directly via `discoverAuthorizationServerMetadata()` — covers legacy servers that co-host metadata without implementing RFC 9728

## Function Signatures

### `performMCPOAuthFlow(serverName, serverConfig, onAuthorizationUrl, abortSignal?, options?): Promise<void>`

Top-level OAuth orchestrator. Routes to XAA or PKCE flow based on config.

- **serverName**: Display name for the MCP server
- **serverConfig**: `McpSSEServerConfig | McpHTTPServerConfig` with URL and OAuth settings
- **onAuthorizationUrl**: Callback invoked with the authorization URL for UI display
- **abortSignal**: Optional signal for cancellation (e.g., user presses Esc)
- **options.skipBrowserOpen**: If true, shows URL but doesn't open the browser
- **options.onWaitingForCallback**: Callback for manual URL paste in remote environments

> Source: `src/services/mcp/auth.ts:847-856`

### `revokeServerTokens(serverName, serverConfig, options?): Promise<void>`

Best-effort token revocation with local cleanup.

- **options.preserveStepUpState**: When `true`, preserves `stepUpScope` and `discoveryState` across revocation

> Source: `src/services/mcp/auth.ts:467-618`

### `getServerKey(serverName, serverConfig): string`

Generates a unique storage key as `{serverName}|{sha256(type+url+headers)[0:16]}`.

> Source: `src/services/mcp/auth.ts:325-341`

### `hasMcpDiscoveryButNoToken(serverName, serverConfig): boolean`

Returns `true` when discovery state exists but no tokens are stored — indicates the user must re-authenticate. XAA servers always return `false` (they can silently re-auth).

> Source: `src/services/mcp/auth.ts:349-363`

### `wrapFetchWithStepUpDetection(baseFetch, provider): FetchLike`

Returns a fetch wrapper that detects 403 `insufficient_scope` responses and marks step-up pending on the provider.

> Source: `src/services/mcp/auth.ts:1354-1374`

### `normalizeOAuthErrorBody(response): Promise<Response>`

Rewrites 2xx responses containing OAuth error bodies to 400 responses. Normalizes non-standard error codes (Slack's `invalid_refresh_token`, `expired_refresh_token`, `token_expired`) to `invalid_grant`.

> Source: `src/services/mcp/auth.ts:157-191`

### `readClientSecret(): Promise<string>`

Reads a client secret from `MCP_CLIENT_SECRET` env var or prompts interactively via stdin (raw mode, masked input).

> Source: `src/services/mcp/auth.ts:2362-2397`

### `saveMcpClientSecret(serverName, serverConfig, clientSecret): void`

Persists a client secret to secure storage under `mcpOAuthClientConfig[serverKey]`.

> Source: `src/services/mcp/auth.ts:2399-2414`

### `clearMcpClientConfig(serverName, serverConfig): void` / `getMcpClientConfig(serverName, serverConfig)`

Delete or read client config from secure storage.

> Source: `src/services/mcp/auth.ts:2416-2438`

## ClaudeAuthProvider Class

`ClaudeAuthProvider` implements the MCP SDK's `OAuthClientProvider` interface (`src/services/mcp/auth.ts:1376-2360`). Key methods:

| Method | Description |
|--------|-------------|
| `clientMetadata` | Returns DCR metadata with `token_endpoint_auth_method: 'none'` (public client) and scopes from metadata |
| `clientMetadataUrl` | CIMD (SEP-991) URL-based `client_id`. Overridable via `MCP_OAUTH_CLIENT_METADATA_URL` env var |
| `clientInformation()` | Returns stored client info from secure storage, falling back to pre-configured `oauth.clientId` |
| `saveClientInformation()` | Persists DCR registration response |
| `tokens()` | Returns current tokens with proactive refresh (5-min window) and XAA silent exchange |
| `saveTokens()` | Persists tokens with computed `expiresAt` timestamp |
| `redirectToAuthorization()` | Validates URL scheme, notifies UI, opens browser. Persists step-up scope for transport-attached providers |
| `invalidateCredentials(scope)` | Granular credential invalidation: `'all'`, `'client'`, `'tokens'`, `'verifier'`, `'discovery'` |
| `saveDiscoveryState()` | Persists only URLs (not full metadata) to avoid macOS keychain 4KB overflow (#30337) |
| `discoveryState()` | Returns cached discovery state or fetches from configured metadata URL |
| `refreshAuthorization()` | Cross-process-safe refresh with lockfile, stale detection, and transient-error retry |
| `markStepUpPending()` | Sets flag that causes `tokens()` to omit `refresh_token`, forcing re-authorization |

## Interface/Type Definitions

### `MCPRefreshFailureReason`

Stable analytics values for refresh failure attribution (`src/services/mcp/auth.ts:71-77`):

`'metadata_discovery_failed'` | `'no_client_info'` | `'no_tokens_returned'` | `'invalid_grant'` | `'transient_retries_exhausted'` | `'request_failed'`

### `MCPOAuthFlowErrorReason`

Stable analytics values for OAuth flow errors (`src/services/mcp/auth.ts:84-92`):

`'cancelled'` | `'timeout'` | `'provider_denied'` | `'state_mismatch'` | `'port_unavailable'` | `'sdk_auth_failed'` | `'token_exchange_failed'` | `'unknown'`

### `XaaFailureStage`

Tracks which phase of the XAA flow failed (`src/services/mcp/auth.ts:641-645`):

`'idp_login'` | `'discovery'` | `'token_exchange'` | `'jwt_bearer'`

### `AuthenticationCancelledError`

Custom error thrown when the user cancels authentication (e.g., via Esc) (`src/services/mcp/auth.ts:313-318`).

## Configuration & Defaults

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `AUTH_REQUEST_TIMEOUT_MS` | Constant | 30000 | Per-request timeout for OAuth HTTP calls |
| Callback server timeout | Constant | 300000 (5 min) | Max wait for authorization callback |
| `MAX_LOCK_RETRIES` | Constant | 5 | Lock acquisition attempts for refresh |
| Refresh retry | Constant | 3 attempts | Exponential backoff: 1s, 2s, 4s |
| Proactive refresh window | Logic | 300s (5 min) | Refresh tokens before expiry |
| `MCP_CLIENT_SECRET` | Env var | — | Client secret for non-interactive environments |
| `MCP_OAUTH_CLIENT_METADATA_URL` | Env var | `MCP_CLIENT_METADATA_URL` constant | Override CIMD URL for testing |
| `CLAUDE_CODE_ENABLE_XAA` | Env var | unset | Must be `1` to enable XAA flows |
| `serverConfig.oauth.callbackPort` | Config | auto-detected | Fixed callback port for pre-configured OAuth |
| `serverConfig.oauth.authServerMetadataUrl` | Config | — | Direct URL for auth server metadata (must be HTTPS) |
| `serverConfig.oauth.clientId` | Config | — | Pre-configured OAuth client ID |
| `serverConfig.oauth.xaa` | Config | — | Enables XAA cross-app access for the server |

## Edge Cases & Caveats

- **Slack compatibility**: Slack returns HTTP 200 with error bodies instead of proper 4xx responses, and uses non-standard error codes (`invalid_refresh_token`, `expired_refresh_token`, `token_expired`). `normalizeOAuthErrorBody()` rewrites these to standard 400 + `invalid_grant` responses so the SDK's error handling works correctly (`src/services/mcp/auth.ts:127-191`).

- **macOS keychain size limit**: The keychain write path has a ~4096-byte stdin limit. `saveDiscoveryState()` intentionally stores only URLs (not full AS metadata blobs that can be ~1.5-2KB each) to prevent overflow that corrupts the credential store (issue #30337, `src/services/mcp/auth.ts:2007-2015`).

- **Cross-process refresh races**: `refreshAuthorization()` uses a lockfile to prevent concurrent refreshes. After acquiring the lock, it re-reads storage in case another process already refreshed. On `InvalidGrantError`, it also checks storage before invalidating (`src/services/mcp/auth.ts:2139-2163`).

- **Step-up auth workaround**: Without `wrapFetchWithStepUpDetection`, the SDK would refresh (uselessly, since RFC 6749 §6 forbids scope elevation via refresh) → get the same token → retry → 403 again → abort. The wrapper forces the PKCE re-authorization path (issue #28258, `src/services/mcp/auth.ts:1344-1374`).

- **XAA has no silent fallback**: If `oauth.xaa` is set but XAA fails, the module does *not* fall through to the standard consent flow. This is intentional — the user explicitly configured XAA, and falling back would have different trust/scope implications (`src/services/mcp/auth.ts:862-870`).

- **XSS protection**: Error messages from OAuth providers displayed in the callback HTML page are sanitized with the `xss` library (`src/services/mcp/auth.ts:1123-1124`).

- **Sensitive param redaction**: OAuth parameters (`state`, `nonce`, `code_challenge`, `code_verifier`, `code`) are redacted from all debug logs to prevent CSRF and session fixation exposure (`src/services/mcp/auth.ts:100-125`).

- **EADDRINUSE handling**: If the callback port is occupied, the error message includes a platform-specific command (`lsof` or `netstat`) to help the user diagnose the issue (`src/services/mcp/auth.ts:1153-1168`).

- **`server.unref()` / `timeout.unref()`**: The callback server and timeout don't pin the Node.js event loop. If the UI unmounts without aborting, the process can exit cleanly (`src/services/mcp/auth.ts:1202-1213`).

- **DCR client recovery**: If token exchange fails with `invalid_client` + "Client not found", the stored `clientId`/`clientSecret` are cleared so the next attempt triggers fresh DCR (`src/services/mcp/auth.ts:1306-1318`).

## Key Code Snippets

### OAuth Error Normalization

Non-standard error codes from servers like Slack are mapped to `invalid_grant`:

```typescript
// src/services/mcp/auth.ts:147-151
const NONSTANDARD_INVALID_GRANT_ALIASES = new Set([
  'invalid_refresh_token',
  'expired_refresh_token',
  'token_expired',
])
```

### Server Key Generation

Credentials are keyed by both name and config hash to prevent cross-server credential reuse:

```typescript
// src/services/mcp/auth.ts:325-341
export function getServerKey(
  serverName: string,
  serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
): string {
  const configJson = jsonStringify({
    type: serverConfig.type,
    url: serverConfig.url,
    headers: serverConfig.headers || {},
  })
  const hash = createHash('sha256')
    .update(configJson)
    .digest('hex')
    .substring(0, 16)
  return `${serverName}|${hash}`
}
```

### Proactive Token Refresh with XAA Fallback

The `tokens()` method attempts XAA silent exchange before falling back to standard behavior:

```typescript
// src/services/mcp/auth.ts:1585-1615
if (
  isXaaEnabled() &&
  this.serverConfig.oauth?.xaa &&
  !tokenData?.refreshToken &&
  (!tokenData?.accessToken ||
    (tokenData.expiresAt - Date.now()) / 1000 <= 300)
) {
  if (!this._refreshInProgress) {
    this._refreshInProgress = this.xaaRefresh().finally(() => {
      this._refreshInProgress = undefined
    })
  }
  try {
    const refreshed = await this._refreshInProgress
    if (refreshed) return refreshed
  } catch (e) {
    // Fall through to normal path
  }
}
```

### RFC 7009 Token Revocation with Fallback

Revocation tries standards-compliant client auth first, then falls back to Bearer for non-compliant servers:

```typescript
// src/services/mcp/auth.ts:430-458
try {
  await axios.post(endpoint, params, { headers })
} catch (error: unknown) {
  if (
    axios.isAxiosError(error) &&
    error.response?.status === 401 &&
    accessToken
  ) {
    params.delete('client_id')
    params.delete('client_secret')
    await axios.post(endpoint, params, {
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
    })
  } else {
    throw error
  }
}
```