# XAATokenExchange

## Overview & Responsibilities

This module implements the **Cross-App Access (XAA)** token exchange protocol, enabling MCP servers to obtain access tokens **without a browser consent screen**. It lives within the **Services → MCPClient → Authentication** hierarchy and is the silent-auth counterpart to the interactive OAuth flow.

The core idea: chain two standardized OAuth grant types to convert an existing OIDC `id_token` (from an enterprise IdP login) into an MCP `access_token`:

1. **RFC 8693 Token Exchange** at the IdP: `id_token` → `ID-JAG` (Identity Assertion Authorization Grant)
2. **RFC 7523 JWT Bearer Grant** at the AS: `ID-JAG` → `access_token`

Before those exchanges, two discovery steps locate the relevant endpoints. The module is structured as **four Layer-2 operations** plus **one Layer-3 orchestrator** that composes them.

Relevant specs: RFC 8693 (Token Exchange), RFC 7523 (JWT Bearer), RFC 9728 (Protected Resource Metadata), RFC 8414 (AS Metadata), and the IETF ID-JAG draft.

## Key Processes

### Full XAA Flow (`performCrossAppAccess`)

The orchestrator at `src/services/mcp/xaa.ts:426-511` runs the four Layer-2 operations in sequence:

1. **PRM Discovery** — Calls `discoverProtectedResource(serverUrl)` to fetch the MCP server's Protected Resource Metadata (RFC 9728). Returns the `resource` identifier and a list of `authorization_servers`.

2. **AS Metadata Discovery** — Iterates through each advertised authorization server URL, calling `discoverAuthorizationServer(asUrl)` until one is found that supports the `jwt-bearer` grant type. If the AS's `grant_types_supported` list is present but omits `jwt-bearer`, it is skipped. If absent (optional per RFC 8414 §2), the AS is tried. Also selects the authentication method (`client_secret_basic` vs `client_secret_post`) based on what the AS advertises, defaulting to `client_secret_basic` for SEP-990 conformance.

3. **Token Exchange (IdP)** — Calls `requestJwtAuthorizationGrant()` to POST an RFC 8693 token-exchange request to the IdP's token endpoint, sending the user's `id_token` as the `subject_token` and requesting an `id-jag` token type. The response must contain an `access_token` with `issued_token_type` of `urn:ietf:params:oauth:token-type:id-jag`.

4. **JWT Bearer Grant (AS)** — Calls `exchangeJwtAuthGrant()` to POST an RFC 7523 JWT bearer grant to the AS's token endpoint, using the ID-JAG as the `assertion`. Returns the final `access_token`, `token_type`, and optionally `refresh_token`, `expires_in`, and `scope`.

The result includes `authorizationServerUrl` (the AS issuer) so callers can persist it for future refresh and revocation operations.

### Abort Signal Propagation

The `makeXaaFetch` wrapper (`src/services/mcp/xaa.ts:42-52`) creates a fetch function that combines a 30-second timeout (`XAA_REQUEST_TIMEOUT_MS`) with an optional caller-provided `AbortSignal` via `AbortSignal.any()`. This ensures user cancellation (e.g., pressing Esc) actually aborts in-flight HTTP requests rather than being masked by the timeout signal.

### Token Redaction for Debug Logging

The `redactTokens` function (`src/services/mcp/xaa.ts:94-97`) uses a regex to replace sensitive token values (`access_token`, `refresh_token`, `id_token`, `assertion`, `subject_token`, `client_secret`) with `[REDACTED]` in debug log output and error messages. This covers both parsed JSON and raw text error bodies from non-OK responses.

## Function Signatures

### `discoverProtectedResource(serverUrl, opts?): Promise<ProtectedResourceMetadata>`

RFC 9728 PRM discovery. Fetches the MCP server's protected resource metadata and validates that the returned `resource` field matches `serverUrl` (mix-up protection via URL normalization).

- **serverUrl**: The MCP server URL to discover
- **opts.fetchFn**: Optional custom fetch implementation
- **Returns**: `{ resource, authorization_servers }` — the resource identifier and list of AS URLs

> Source: `src/services/mcp/xaa.ts:135-165`

### `discoverAuthorizationServer(asUrl, opts?): Promise<AuthorizationServerMetadata>`

RFC 8414 AS metadata discovery with OIDC fallback. Validates issuer matches `asUrl` (mix-up protection) and **rejects non-HTTPS token endpoints** to prevent leaking credentials over plaintext.

- **asUrl**: The authorization server URL to discover
- **opts.fetchFn**: Optional custom fetch implementation
- **Returns**: `{ issuer, token_endpoint, grant_types_supported?, token_endpoint_auth_methods_supported? }`

> Source: `src/services/mcp/xaa.ts:178-210`

### `requestJwtAuthorizationGrant(opts): Promise<JwtAuthGrantResult>`

RFC 8693 token exchange at the IdP. Exchanges an `id_token` for an ID-JAG.

- **opts.tokenEndpoint**: IdP token endpoint URL
- **opts.audience**: The AS issuer (target audience for the ID-JAG)
- **opts.resource**: The MCP server's resource identifier
- **opts.idToken**: The user's OIDC id_token
- **opts.clientId**: Client ID registered at the IdP
- **opts.clientSecret?**: Optional client secret (sent via `client_secret_post`)
- **opts.scope?**: Optional scope string
- **Returns**: `{ jwtAuthGrant, expiresIn?, scope? }` — the ID-JAG token and optional metadata
- **Throws**: `XaaTokenExchangeError` with `shouldClearIdToken` semantics

> Source: `src/services/mcp/xaa.ts:233-310`

### `exchangeJwtAuthGrant(opts): Promise<XaaTokenResult>`

RFC 7523 JWT bearer grant at the AS. Exchanges an ID-JAG for a final access token.

- **opts.tokenEndpoint**: AS token endpoint URL
- **opts.assertion**: The ID-JAG from the previous step
- **opts.clientId**: Client ID registered at the AS
- **opts.clientSecret**: Client secret for the AS
- **opts.authMethod?**: `'client_secret_basic'` (default) or `'client_secret_post'`
- **opts.scope?**: Optional scope string
- **Returns**: `{ access_token, token_type, expires_in?, scope?, refresh_token? }`

> Source: `src/services/mcp/xaa.ts:337-394`

### `performCrossAppAccess(serverUrl, config, serverName?, abortSignal?): Promise<XaaResult>`

Layer-3 orchestrator composing all four Layer-2 operations.

- **serverUrl**: The MCP server URL
- **config**: `XaaConfig` with IdP and AS credentials
- **serverName**: Label for debug logging (default: `'xaa'`)
- **abortSignal?**: Optional abort signal for cancellation
- **Returns**: `XaaResult` (token result + `authorizationServerUrl`)

> Source: `src/services/mcp/xaa.ts:426-511`

## Type Definitions

### `XaaConfig`

Configuration for the full XAA orchestrator.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| clientId | string | Yes | Client ID at the MCP server's AS |
| clientSecret | string | Yes | Client secret for the AS |
| idpClientId | string | Yes | Client ID at the IdP |
| idpClientSecret | string | No | IdP client secret (for `client_secret_post`) |
| idpIdToken | string | Yes | User's OIDC id_token from IdP login |
| idpTokenEndpoint | string | Yes | IdP token endpoint for RFC 8693 exchange |

### `XaaResult`

Extends `XaaTokenResult` with `authorizationServerUrl: string` — the discovered AS issuer URL. Callers must persist this so that refresh and revocation can locate the correct endpoints.

### `XaaTokenExchangeError`

Custom error class with a `shouldClearIdToken: boolean` property.

| Condition | shouldClearIdToken | Rationale |
|-----------|--------------------|-----------|
| HTTP 4xx / `invalid_grant` / `invalid_token` | `true` | The id_token is rejected; clear cache |
| HTTP 5xx | `false` | IdP outage; id_token may still be valid |
| 200 OK with non-JSON body | `false` | Transient issue (captive portal) |
| 200 OK with structurally invalid body | `true` | Protocol violation; clear cache |

## Configuration & Defaults

- **`XAA_REQUEST_TIMEOUT_MS`**: `30000` (30 seconds) — per-request timeout for all XAA HTTP calls (`src/services/mcp/xaa.ts:29`)
- **Default auth method**: `client_secret_basic` (Base64 Authorization header) per SEP-990 conformance, unless the AS explicitly only supports `client_secret_post`
- **Default token_type**: `'Bearer'` — the Zod schema defaults this if the AS omits it (common since RFC 6750 only defines Bearer)

## Edge Cases & Caveats

- **Issuer/resource mismatch protection**: Both `discoverProtectedResource` and `discoverAuthorizationServer` validate that the returned identifier matches the request URL after RFC 3986 normalization (lowercase scheme+host, strip trailing slash, drop default port). This prevents mix-up attacks.

- **HTTPS enforcement**: `discoverAuthorizationServer` rejects any token endpoint that isn't `https:` (`src/services/mcp/xaa.ts:198-202`). Without this, a PRM-advertised `http://` AS that self-consistently reports an `http://` issuer would pass the mismatch check but leak credentials in plaintext.

- **Non-conformant IdPs**: The Zod schemas use `z.coerce.number()` for `expires_in` to tolerate IdPs (common in PHP backends) that serialize it as a string instead of a number (`src/services/mcp/xaa.ts:107`). The `token_type` field defaults to `'Bearer'` since many ASes omit it.

- **AS fallback iteration**: The orchestrator tries each AS in the `authorization_servers` array in order (`src/services/mcp/xaa.ts:446-466`). If the `grant_types_supported` field is absent (optional per RFC 8414), the AS is tried rather than skipped. Only explicit omission of `jwt-bearer` from the list causes a skip.

- **Abort signal edge case**: In the AS iteration loop, if the abort signal fires during a failed `discoverAuthorizationServer` call, the error is re-thrown immediately rather than accumulated (`src/services/mcp/xaa.ts:451`).

- **Sensitive token redaction**: Error messages and debug logs never contain raw tokens. The `SENSITIVE_TOKEN_RE` regex matches token-bearing JSON keys at any nesting depth, covering both parsed-then-stringified bodies and raw text error bodies from misbehaving servers that echo back request parameters.

- **Layer-2/Layer-3 design**: The four operations are designed to align with the MCP TypeScript SDK PR #1593's Layer-2 shapes, so a future SDK swap is mechanical. Each Layer-2 function is independently exported and testable.