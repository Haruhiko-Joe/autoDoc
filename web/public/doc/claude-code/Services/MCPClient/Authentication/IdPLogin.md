# IdP Login

## Overview & Responsibilities

The IdP Login module (`src/services/mcp/xaaIdpLogin.ts`) implements the enterprise Identity Provider (IdP) OIDC login flow for the XAA (Cross-App Access) authentication system. It sits within the **Services → MCPClient → Authentication** layer and provides the "one browser pop → N silent MCP server auths" capability: a single interactive IdP login produces an `id_token` that is cached and reused across multiple MCP server connections.

The module handles:
- **Feature gating** via the `CLAUDE_CODE_ENABLE_XAA` environment variable
- **OIDC discovery** with path-append semantics for Azure AD, Okta, and Keycloak compatibility
- **Authorization code + PKCE browser flow** using the MCP SDK's auth primitives
- **id_token caching** in secure storage (OS keychain), keyed by normalized IdP issuer URL
- **IdP client secret management** in a separate secure storage namespace
- **A local HTTP callback server** with state/CSRF validation, XSS-sanitized error pages, and abort signal support

Its sibling modules in the Authentication group include the standard OAuth flow and RFC 8693 token exchange — this module specifically handles acquiring the OIDC id_token that those flows later consume.

## Key Processes

### Token Acquisition Flow (`acquireIdpIdToken`)

This is the primary entry point. It implements a cache-first strategy:

1. **Check cache** — calls `getCachedIdpIdToken()` to look up a valid id_token in secure storage. If a non-expired token exists (with a 60-second buffer), return it immediately (`src/services/mcp/xaaIdpLogin.ts:406-410`)
2. **OIDC discovery** — fetches `{issuer}/.well-known/openid-configuration` via `discoverOidc()`, validating the response schema and rejecting non-HTTPS token endpoints (`src/services/mcp/xaaIdpLogin.ts:414`)
3. **Port selection** — uses the configured `callbackPort` or finds a random available one (`src/services/mcp/xaaIdpLogin.ts:415`)
4. **Start authorization** — calls the MCP SDK's `startAuthorization()` with scope `openid`, generating a PKCE code verifier and authorization URL (`src/services/mcp/xaaIdpLogin.ts:423-432`)
5. **Local callback server** — `waitForCallback()` starts an HTTP server on `127.0.0.1:{port}` and only opens the browser *after* the socket is bound (to surface `EADDRINUSE` before a spurious tab appears) (`src/services/mcp/xaaIdpLogin.ts:438-451`)
6. **Browser pop** — opens the IdP authorization URL in the user's browser (unless `skipBrowserOpen` is set)
7. **Code exchange** — once the callback receives the authorization code with matching state, calls `exchangeAuthorization()` with a 30-second request timeout (`src/services/mcp/xaaIdpLogin.ts:453-465`)
8. **Validate response** — ensures the token response contains an `id_token` (requires `scope=openid`) (`src/services/mcp/xaaIdpLogin.ts:466-470`)
9. **Cache with TTL** — extracts the JWT's `exp` claim for cache TTL (falls back to `expires_in` or 1 hour default), then persists to secure storage (`src/services/mcp/xaaIdpLogin.ts:475-484`)

### OIDC Discovery (Path-Append Fix)

A critical detail: `discoverOidc()` appends `.well-known/openid-configuration` to the issuer's existing path rather than replacing it (`src/services/mcp/xaaIdpLogin.ts:205-206`). This is done by ensuring the base URL ends with `/` and using a relative URL reference:

```typescript
// src/services/mcp/xaaIdpLogin.ts:205-206
const base = idpIssuer.endsWith('/') ? idpIssuer : idpIssuer + '/'
const url = new URL('.well-known/openid-configuration', base)
```

Without this, `new URL('/.well-known/...', issuer)` with a leading slash would drop the issuer's pathname — breaking Azure AD (`login.microsoftonline.com/{tenant}/v2.0`), Okta custom auth servers, and Keycloak realms.

The function also guards against captive portals returning HTML with a 200 status, and rejects non-HTTPS token endpoints.

### Callback Server & Security Validation

`waitForCallback()` (`src/services/mcp/xaaIdpLogin.ts:272-395`) creates a local HTTP server that:

- Listens only on `127.0.0.1` (loopback)
- Only responds to `/callback` path; all other paths get 404
- Validates `state` parameter against the expected value to prevent CSRF attacks (`src/services/mcp/xaaIdpLogin.ts:343-348`)
- Sanitizes `error` and `error_description` query params with `xss()` before rendering in HTML responses (`src/services/mcp/xaaIdpLogin.ts:331-341`)
- Provides platform-specific diagnostic messages for `EADDRINUSE` (suggests `lsof` on Unix, `netstat` on Windows) (`src/services/mcp/xaaIdpLogin.ts:364-378`)
- Times out after 5 minutes (`IDP_LOGIN_TIMEOUT_MS`)
- Supports cancellation via `AbortSignal` (`src/services/mcp/xaaIdpLogin.ts:311-318`)
- Uses `resolveOnce`/`rejectOnce` guards to prevent double-settlement of the promise

### Issuer Normalization

`issuerKey()` (`src/services/mcp/xaaIdpLogin.ts:84-93`) normalizes IdP issuer URLs for consistent cache keying: strips trailing slashes, lowercases the host. This ensures that cosmetic URL differences (e.g., trailing slash) between config and OIDC discovery don't create duplicate cache entries.

### id_token Caching

Tokens are stored in OS secure storage (keychain) under the `mcpXaaIdp` namespace, keyed by normalized issuer URL. The cache entry stores both the raw token and an `expiresAt` timestamp. `getCachedIdpIdToken()` checks remaining TTL against a 60-second buffer (`ID_TOKEN_EXPIRY_BUFFER_S`) to avoid using tokens that are about to expire (`src/services/mcp/xaaIdpLogin.ts:99-107`).

### JWT exp Extraction

`jwtExp()` (`src/services/mcp/xaaIdpLogin.ts:252-263`) decodes the JWT payload without verifying the signature. This is intentionally insecure for a documented reason: the id_token will be validated by the IdP's own token endpoint during the RFC 8693 token exchange. Client-side verification would add code without adding security. The function is used solely to derive a cache TTL.

## Function Signatures

### `isXaaEnabled(): boolean`
Returns `true` if `CLAUDE_CODE_ENABLE_XAA` environment variable is truthy. Feature gate for the entire XAA system.

> Source: `src/services/mcp/xaaIdpLogin.ts:32-34`

### `getXaaIdpSettings(): XaaIdpSettings | undefined`
Reads `settings.xaaIdp` from the application settings, using a type cast since the field is env-gated and not in the compile-time type.

> Source: `src/services/mcp/xaaIdpLogin.ts:47-49`

### `issuerKey(issuer: string): string`
Normalizes an IdP issuer URL for cache keying. Strips trailing slashes, lowercases host. Falls back to simple slash-stripping if URL parsing fails.

> Source: `src/services/mcp/xaaIdpLogin.ts:84-93`

### `getCachedIdpIdToken(idpIssuer: string): string | undefined`
Returns a cached id_token if it exists and has more than 60 seconds until expiry. Returns `undefined` otherwise.

> Source: `src/services/mcp/xaaIdpLogin.ts:99-107`

### `saveIdpIdTokenFromJwt(idpIssuer: string, idToken: string): number`
Saves an externally-obtained id_token (e.g., from conformance testing) into the cache. Returns the computed `expiresAt` timestamp.

> Source: `src/services/mcp/xaaIdpLogin.ts:133-141`

### `clearIdpIdToken(idpIssuer: string): void`
Removes a cached id_token for the given issuer. Used by cleanup/logout commands.

> Source: `src/services/mcp/xaaIdpLogin.ts:143-150`

### `saveIdpClientSecret(idpIssuer: string, clientSecret: string): { success: boolean; warning?: string }`
Stores an IdP client secret in secure storage under the `mcpXaaIdpConfig` namespace (separate from token storage). Returns success status so callers can surface keychain failures.

> Source: `src/services/mcp/xaaIdpLogin.ts:159-172`

### `getIdpClientSecret(idpIssuer: string): string | undefined`
Reads the stored client secret for an issuer.

> Source: `src/services/mcp/xaaIdpLogin.ts:177-181`

### `clearIdpClientSecret(idpIssuer: string): void`
Removes a stored client secret. Used by `claude mcp xaa clear`.

> Source: `src/services/mcp/xaaIdpLogin.ts:187-194`

### `discoverOidc(idpIssuer: string): Promise<OpenIdProviderDiscoveryMetadata>`
Fetches and validates OIDC discovery metadata. Enforces HTTPS on token endpoints, handles non-JSON responses (captive portals), and uses path-append semantics.

> Source: `src/services/mcp/xaaIdpLogin.ts:202-237`

### `acquireIdpIdToken(opts: IdpLoginOptions): Promise<string>`
Main entry point. Returns a cached id_token or runs the full browser-based OIDC login flow.

> Source: `src/services/mcp/xaaIdpLogin.ts:401-487`

## Type Definitions

### `XaaIdpSettings`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issuer` | `string` | Yes | IdP issuer URL |
| `clientId` | `string` | Yes | OIDC client ID registered with the IdP |
| `callbackPort` | `number` | No | Fixed callback port for the redirect URI |

> Source: `src/services/mcp/xaaIdpLogin.ts:36-40`

### `IdpLoginOptions`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `idpIssuer` | `string` | Yes | IdP issuer URL |
| `idpClientId` | `string` | Yes | OIDC client ID |
| `idpClientSecret` | `string` | No | Client secret for confidential clients |
| `callbackPort` | `number` | No | Fixed port for redirect URI (per RFC 8252 §7.3) |
| `onAuthorizationUrl` | `(url: string) => void` | No | Callback invoked with the authorization URL |
| `skipBrowserOpen` | `boolean` | No | If true, don't auto-open browser |
| `abortSignal` | `AbortSignal` | No | Signal to cancel the login flow |

> Source: `src/services/mcp/xaaIdpLogin.ts:55-76`

## Configuration & Defaults

| Constant / Setting | Value | Description |
|---|---|---|
| `CLAUDE_CODE_ENABLE_XAA` | env var | Must be truthy to enable XAA |
| `settings.xaaIdp` | settings | IdP issuer, client ID, and optional callback port |
| `IDP_LOGIN_TIMEOUT_MS` | 5 minutes | Max time to wait for browser callback (`src/services/mcp/xaaIdpLogin.ts:51`) |
| `IDP_REQUEST_TIMEOUT_MS` | 30 seconds | Timeout for OIDC discovery and token exchange HTTP requests (`src/services/mcp/xaaIdpLogin.ts:52`) |
| `ID_TOKEN_EXPIRY_BUFFER_S` | 60 seconds | Tokens within this margin of expiry are treated as expired (`src/services/mcp/xaaIdpLogin.ts:53`) |

## Edge Cases & Caveats

- **Azure AD / Okta / Keycloak compatibility**: The OIDC discovery URL is constructed with path-append, not path-replace. Using a leading slash in `new URL()` would drop the tenant/realm from the issuer path.
- **Captive portals**: `discoverOidc()` explicitly catches HTML-as-JSON responses that return HTTP 200 but are not valid JSON.
- **Non-HTTPS token endpoints**: Explicitly rejected to prevent credential leakage.
- **No JWT signature verification**: The `jwtExp()` function intentionally skips verification — the token is validated later by the IdP during token exchange. This is a deliberate security design, not an omission.
- **EADDRINUSE**: If the callback port is occupied, the error includes a platform-specific command (`lsof`/`netstat`) to help identify the conflicting process.
- **Double-settlement guard**: The callback server uses `resolveOnce`/`rejectOnce` wrappers to prevent promise double-settlement from concurrent requests or timeout races.
- **Secure storage namespaces**: id_tokens (`mcpXaaIdp`) and client secrets (`mcpXaaIdpConfig`) are stored in separate namespaces — different trust domains.
- **Cache key normalization**: Different URL forms of the same issuer (trailing slash, case differences) resolve to the same cache slot via `issuerKey()`.
- **Browser open timing**: The browser is only opened after the callback server socket is bound, preventing a spurious browser tab from appearing when the port is unavailable.