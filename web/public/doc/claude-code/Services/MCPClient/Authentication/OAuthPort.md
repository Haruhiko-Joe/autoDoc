# OAuthPort

## Overview & Responsibilities

OAuthPort is a small utility module within the **Services → MCPClient → Authentication** subsystem. It provides two functions — `findAvailablePort` and `buildRedirectUri` — that both the main MCP OAuth flow (`auth.ts`) and the enterprise IdP login (`xaaIdpLogin.ts`) depend on to set up local HTTP callback servers for OAuth redirects.

The module was extracted specifically to **break a circular dependency** between `auth.ts` and `xaaIdpLogin.ts`, as noted in the file header comment (`src/services/mcp/oauthPort.ts:1-4`).

Both functions implement aspects of RFC 8252 Section 7.3 — the standard for OAuth 2.0 native-app loopback redirects, where the authorization server redirects to `http://localhost:{port}/callback` and port matching is flexible.

## Key Processes

### Port Selection Flow (`findAvailablePort`)

1. **Check for configured override** — reads the `MCP_OAUTH_CALLBACK_PORT` environment variable via `getMcpOAuthCallbackPort()`. If set to a valid positive integer, returns it immediately with no availability check (`src/services/mcp/oauthPort.ts:38-41`).

2. **Random port probing** — selects a random port within a platform-specific ephemeral range and tests availability by briefly binding an HTTP server to it. Repeats up to `maxAttempts` times (capped at 100) on failure (`src/services/mcp/oauthPort.ts:43-63`).

   - **Non-Windows**: range `49152–65535` (IANA dynamic/private port range)
   - **Windows**: range `39152–49151` (avoids the Windows-reserved `49152–65535` dynamic port range)

   Platform detection is delegated to `src/utils/platform.ts` via the `getPlatform()` function. The port range is evaluated once at module load time (`src/services/mcp/oauthPort.ts:9-12`).

3. **Fallback to port 3118** — if all random attempts fail, tries the hardcoded fallback port `3118` (`src/services/mcp/oauthPort.ts:66-74`).

4. **Error** — if the fallback port is also unavailable, throws `"No available ports for OAuth redirect"` (`src/services/mcp/oauthPort.ts:76`).

### Redirect URI Construction (`buildRedirectUri`)

Constructs `http://localhost:{port}/callback`. Defaults to port `3118` when called without arguments (`src/services/mcp/oauthPort.ts:21-25`).

## Function Signatures

### `findAvailablePort(): Promise<number>`

Exported async function. Returns a port number suitable for binding the OAuth callback HTTP server.

- **No parameters** — reads configuration from the environment internally
- **Returns**: a port number guaranteed to have been bindable at the moment of the check (or the configured override port, which is not checked)
- **Throws**: `Error` if no port could be found after all attempts

> Source: `src/services/mcp/oauthPort.ts:36-78`

### `buildRedirectUri(port?: number): string`

Exported synchronous function. Builds the full redirect URI for the OAuth callback.

- **port** (optional, `number`, default `3118`) — the port to embed in the URI
- **Returns**: `"http://localhost:{port}/callback"`

> Source: `src/services/mcp/oauthPort.ts:21-25`

### `getMcpOAuthCallbackPort(): number | undefined` (internal)

Private helper that parses `process.env.MCP_OAUTH_CALLBACK_PORT`. Returns the parsed integer if positive, otherwise `undefined`.

> Source: `src/services/mcp/oauthPort.ts:27-30`

## Configuration

| Source | Name | Type | Default | Description |
|--------|------|------|---------|-------------|
| Environment variable | `MCP_OAUTH_CALLBACK_PORT` | integer string | *(none)* | When set, `findAvailablePort` returns this port unconditionally, skipping random selection |

### Platform-Specific Port Ranges

| Platform | Range | Rationale |
|----------|-------|-----------|
| Windows | `39152–49151` | Avoids the Windows dynamic port range (`49152–65535`) |
| macOS / Linux | `49152–65535` | Standard IANA ephemeral port range |

Fallback port: **3118** (used when random selection exhausts all attempts, or as the default for `buildRedirectUri`).

## Edge Cases & Caveats

- **Configured port is not tested for availability.** When `MCP_OAUTH_CALLBACK_PORT` is set, `findAvailablePort` returns it immediately without binding a test server. If the port is occupied, the caller will discover the conflict later when it tries to start the actual callback server.

- **TOCTOU race.** The random port probe binds and immediately releases the port. Another process could claim it in the interval before the caller binds. This is an inherent limitation of probe-based port selection.

- **Random selection, not sequential.** Ports are chosen randomly within the range rather than scanned sequentially. This reduces predictability (better for security) but means the function may re-test the same port across attempts. With up to 100 attempts over a 16K+ port range, collisions are statistically unlikely.

- **Module-load-time platform detection.** The port range constant is set when the module is first imported (`src/services/mcp/oauthPort.ts:9-12`), based on the result of `getPlatform()` from `src/utils/platform.ts`. It does not re-evaluate per call.