# OAuth

## Overview & Responsibilities

The OAuth module (`src/services/oauth/`) implements the OAuth 2.0 Authorization Code flow with PKCE (Proof Key for Code Exchange) that authenticates users against Anthropic's services. It sits within the **Services** layer and is consumed by the Bootstrap module during startup and by the CommandSystem for login/logout commands.

The module handles:
- Opening the user's browser to an authorization page and capturing the resulting authorization code
- Exchanging authorization codes for access/refresh tokens
- Refreshing expired tokens with smart profile-fetch elision to reduce API traffic
- Fetching user profile information (subscription tier, billing, organization) from the OAuth profile endpoint
- PKCE cryptographic operations for securing the code exchange
- Analytics event tracking at every stage of the flow

## Architecture

The module is composed of five files, each with a clear responsibility:

| File | Role |
|------|------|
| `index.ts` | `OAuthService` class — orchestrates the full login flow |
| `client.ts` | HTTP-level operations — URL building, token exchange, refresh, profile fetch |
| `auth-code-listener.ts` | `AuthCodeListener` — temporary localhost HTTP server to capture browser redirects |
| `crypto.ts` | PKCE utilities — code verifier, code challenge, state generation |
| `getOauthProfile.ts` | Profile fetching via OAuth token or API key |

## Key Processes

### Login Flow (`OAuthService.startOAuthFlow`)

This is the primary entry point. The flow supports two parallel paths — automatic (browser redirect to localhost) and manual (user copy-pastes the code).

1. **Generate PKCE values**: A code verifier is created in the constructor via `crypto.generateCodeVerifier()`. At flow start, a code challenge (SHA-256 hash of the verifier) and a random state parameter are generated (`src/services/oauth/index.ts:55-56`).

2. **Start local HTTP server**: An `AuthCodeListener` is created and starts listening on an OS-assigned port (`src/services/oauth/index.ts:51-52`).

3. **Build authorization URLs**: Two URLs are constructed — one for the automatic flow (redirect URI = `http://localhost:{port}/callback`) and one for the manual flow (redirect URI = a hosted callback page). Both include the PKCE challenge, state, requested scopes, and optional parameters like `orgUUID` and `loginHint` (`src/services/oauth/client.ts:46-105`).

4. **Race automatic vs. manual**: `waitForAuthorizationCode()` sets up a Promise that resolves from either:
   - The `AuthCodeListener` receiving a redirect with the auth code (automatic), or
   - The caller invoking `handleManualAuthCodeInput()` with a user-pasted code (manual)
   
   Concurrently, the manual URL is shown to the user and the browser is opened to the automatic URL (`src/services/oauth/index.ts:73-86`).

5. **Exchange code for tokens**: The authorization code is POSTed to the token endpoint along with the PKCE code verifier, state, and redirect URI (`src/services/oauth/client.ts:107-144`).

6. **Fetch profile**: The access token is used to retrieve the user's subscription type, rate limit tier, billing type, and organization info (`src/services/oauth/client.ts:355-420`).

7. **Success/error redirect**: If the automatic flow was used, the user's browser is redirected to a success page. On error, it redirects to an error page before cleanup (`src/services/oauth/index.ts:111-131`).

8. **Return `OAuthTokens`**: The formatted token object includes access token, refresh token, expiry, scopes, subscription type, and account info.

### Token Refresh (`client.refreshOAuthToken`)

Refresh is the most frequently executed OAuth operation in production.

1. POST the refresh token to the token endpoint, requesting the full Claude AI scope set (`src/services/oauth/client.ts:146-163`)
2. **Smart profile elision**: Before making an extra network call to `/api/oauth/profile`, check whether the global config already has complete profile data (billing type, account creation dates) AND the secure storage has subscription/rate-limit info. If both are present, skip the profile fetch entirely — this optimization cuts ~7M requests/day fleet-wide (`src/services/oauth/client.ts:187-211`)
3. If the profile was fetched, update any changed fields in global config (display name, billing type, usage flags) (`src/services/oauth/client.ts:214-239`)
4. Return `OAuthTokens` with a cascading fallback for subscription type: `profileInfo → existing secure storage → null` (`src/services/oauth/client.ts:246-249`)

### Token Expiry Check

`isOAuthTokenExpired()` applies a 5-minute buffer — tokens are considered expired 5 minutes before their actual expiry to prevent edge-case failures during long API calls (`src/services/oauth/client.ts:344-353`).

### Profile Population (`populateOAuthAccountInfoIfNeeded`)

Called during startup to ensure account metadata is cached:

1. Check for SDK environment variables (`CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_USER_EMAIL`, `CLAUDE_CODE_ORGANIZATION_UUID`) as a fast synchronous path (`src/services/oauth/client.ts:457-471`)
2. Wait for any in-flight token refresh to complete
3. If profile data is incomplete and the user is a Claude AI subscriber with profile scope, fetch and store the full profile (`src/services/oauth/client.ts:488-513`)

## Function Signatures

### `OAuthService` (index.ts)

#### `startOAuthFlow(authURLHandler, options?): Promise<OAuthTokens>`

Orchestrates the complete login. The `authURLHandler` callback receives the manual-flow URL (and optionally the automatic URL when `skipBrowserOpen` is true) so the caller can display it to the user.

Options:
- `loginWithClaudeAi?: boolean` — use Claude AI authorize URL instead of Console
- `inferenceOnly?: boolean` — request only `user:inference` scope (long-lived tokens)
- `expiresIn?: number` — custom token lifetime
- `orgUUID?: string` — pre-select organization
- `loginHint?: string` — pre-populate email (standard OIDC `login_hint`)
- `loginMethod?: string` — request specific login method (e.g. `'sso'`, `'google'`)
- `skipBrowserOpen?: boolean` — delegate browser opening to the caller (used by SDK control protocol)

#### `handleManualAuthCodeInput({ authorizationCode, state }): void`

Resolves the pending authorization promise with a manually-entered code and shuts down the local listener.

#### `cleanup(): void`

Tears down the local HTTP server and clears pending resolvers.

### Client functions (client.ts)

| Function | Description |
|----------|-------------|
| `buildAuthUrl(params)` | Constructs the full authorization URL with PKCE, state, scopes, and optional params |
| `exchangeCodeForTokens(code, state, verifier, port, useManualRedirect, expiresIn?)` | POSTs to token endpoint, returns raw token response |
| `refreshOAuthToken(refreshToken, { scopes? })` | Refreshes an expired token, optionally fetches profile |
| `fetchProfileInfo(accessToken)` | Fetches subscription type, rate limit tier, billing info from profile endpoint |
| `fetchAndStoreUserRoles(accessToken)` | Fetches and persists organization/workspace roles to global config |
| `createAndStoreApiKey(accessToken)` | Creates a Console API key and saves it to secure storage |
| `isOAuthTokenExpired(expiresAt)` | Returns true if the token is within 5 minutes of expiry |
| `shouldUseClaudeAIAuth(scopes)` | Returns true if scopes include `user:inference` |
| `parseScopes(scopeString)` | Splits a space-delimited scope string into an array |
| `getOrganizationUUID()` | Returns org UUID from config or profile endpoint |
| `populateOAuthAccountInfoIfNeeded()` | Ensures account metadata is cached; returns whether it was populated |
| `storeOAuthAccountInfo(info)` | Persists account info to global config with dedup check |

### AuthCodeListener (auth-code-listener.ts)

| Method | Description |
|--------|-------------|
| `start(port?)` | Binds to localhost on the given or OS-assigned port |
| `waitForAuthorization(state, onReady)` | Returns a Promise that resolves with the auth code when the callback is hit |
| `handleSuccessRedirect(scopes, customHandler?)` | Sends a 302 redirect to the appropriate success page |
| `handleErrorRedirect()` | Sends a 302 redirect on failure |
| `hasPendingResponse()` | Whether a browser response is awaiting redirect |
| `close()` | Closes the server and cleans up listeners |

### Crypto (crypto.ts)

| Function | Description |
|----------|-------------|
| `generateCodeVerifier()` | 32 random bytes, base64url-encoded |
| `generateCodeChallenge(verifier)` | SHA-256 hash of the verifier, base64url-encoded |
| `generateState()` | 32 random bytes, base64url-encoded (CSRF protection) |

### Profile fetching (getOauthProfile.ts)

| Function | Description |
|----------|-------------|
| `getOauthProfileFromOauthToken(accessToken)` | GET `/api/oauth/profile` with Bearer token |
| `getOauthProfileFromApiKey()` | GET `/api/claude_cli_profile` with API key + account UUID |

## Configuration & Scopes

OAuth configuration is centralized in `src/constants/oauth.ts` via `getOauthConfig()`, which returns environment-specific URLs (prod/staging/local) based on `USER_TYPE` and `USE_STAGING_OAUTH`/`USE_LOCAL_OAUTH` environment variables.

Scopes requested during login:

| Scope | Purpose |
|-------|----------|
| `user:inference` | Claude AI inference access |
| `user:profile` | Profile data access |
| `user:sessions:claude_code` | Claude Code session management |
| `user:mcp_servers` | MCP server access |
| `user:file_upload` | File upload capability |
| `org:create_api_key` | Console API key creation |

When `inferenceOnly` is set, only `user:inference` is requested for long-lived inference-only tokens.

## Analytics Integration

Every significant step emits a `logEvent` call for observability:

- `tengu_oauth_auth_code_received` — with `automatic` flag indicating flow type
- `tengu_oauth_token_exchange_success`
- `tengu_oauth_token_refresh_success` / `tengu_oauth_token_refresh_failure`
- `tengu_oauth_profile_fetch_success`
- `tengu_oauth_automatic_redirect` / `tengu_oauth_automatic_redirect_error`
- `tengu_oauth_api_key` — with `status: 'success'|'failure'`
- `tengu_oauth_roles_stored`

## Edge Cases & Caveats

- **Dual-flow race condition**: The automatic and manual flows race against each other. Whichever resolves first wins; the other is cleaned up. If manual input arrives first, the `AuthCodeListener` is explicitly closed (`src/services/oauth/index.ts:164-167`).

- **5-minute expiry buffer**: `isOAuthTokenExpired` considers tokens expired 5 minutes early to prevent mid-request expiration.

- **Profile fetch elision on refresh**: To avoid ~7M daily round-trips, `refreshOAuthToken` skips the profile fetch when all required fields already exist in both global config and secure storage. This is critical for the `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` re-login path — see the detailed comment at `src/services/oauth/client.ts:187-199` for the cascading fallback logic.

- **Scope expansion on refresh**: The backend allows scope expansion beyond what was initially granted (via `ALLOWED_SCOPE_EXPANSIONS`), so refresh requests always ask for the full Claude AI scope set.

- **State parameter validation**: The `AuthCodeListener` validates the `state` query parameter against the expected value, rejecting mismatches with a 400 response to prevent CSRF attacks (`src/services/oauth/auth-code-listener.ts:164-169`).

- **SDK environment variable override**: `populateOAuthAccountInfoIfNeeded` accepts account info from `CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_USER_EMAIL`, and `CLAUDE_CODE_ORGANIZATION_UUID` environment variables, allowing SDK callers to bypass the OAuth profile fetch entirely.

- **`skipBrowserOpen` mode**: When the SDK control protocol owns the user's display, both URLs are passed to `authURLHandler` and the service does not call `openBrowser()` itself (`src/services/oauth/index.ts:76-81`).