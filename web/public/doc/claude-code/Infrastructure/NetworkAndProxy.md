# Network and Proxy

## Overview & Responsibilities

The NetworkAndProxy module is the HTTP networking foundation within the **Infrastructure** layer, providing every outbound connection in Claude Code with proxy routing, TLS certificate management, and authentication headers. It sits beneath the Services layer (API client, MCP, telemetry) and the RemoteAndBridge layer (WebSocket connections), ensuring that all HTTP/HTTPS traffic respects corporate proxy configurations, mutual TLS requirements, and custom CA certificates.

The module is split across seven files, each with a narrow responsibility:

| File | Role |
|------|------|
| `proxy.ts` | Proxy URL resolution, NO_PROXY matching, agent creation for HTTP/WebSocket/Axios/undici/AWS |
| `mtls.ts` | Mutual TLS configuration — client certs, keys, passphrases, HTTPS agents |
| `caCerts.ts` | CA certificate loading — bundled Mozilla CAs, system store, extra certs from `NODE_EXTRA_CA_CERTS` |
| `caCertsConfig.ts` | Bridges settings/config into `process.env.NODE_EXTRA_CA_CERTS` at startup |
| `http.ts` | User-Agent string construction, auth header generation (OAuth + API key), 401 retry logic |
| `userAgent.ts` | Minimal dependency-free `claude-code/<version>` string for SDK-bundled code |
| `peerAddress.ts` | URI-style address parsing for inter-agent messaging (UDS, bridge, other) |

A key architectural constraint: `proxy.ts` and `mtls.ts` must **not** transitively import the config/command registry (~5300 modules) because they are used in the lightweight Agent SDK bundle. The `caCertsConfig.ts` file exists specifically to bridge that gap — it imports config at startup and writes `NODE_EXTRA_CA_CERTS` to `process.env`, while `caCerts.ts` only reads that env var.

## Key Processes

### Proxy Resolution and NO_PROXY Matching

When any component needs to make an outbound HTTP request, the proxy infrastructure determines whether to route it through a proxy or connect directly:

1. `getProxyUrl()` checks environment variables in priority order: `https_proxy` → `HTTPS_PROXY` → `http_proxy` → `HTTP_PROXY` (`src/utils/proxy.ts:64-66`)
2. For each request URL, `shouldBypassProxy()` checks the `NO_PROXY`/`no_proxy` value against several matching patterns (`src/utils/proxy.ts:88-129`):
   - Wildcard `*` bypasses all URLs
   - Exact hostname match (e.g., `localhost`)
   - Domain suffix with leading dot (e.g., `.example.com` matches `sub.example.com` and `example.com`)
   - Port-specific match (e.g., `example.com:8080`)
   - IP address match (e.g., `127.0.0.1`)
3. If the URL should bypass the proxy, the request uses a direct connection (with mTLS agent if configured); otherwise, it uses the proxy agent

### CA Certificate Assembly

CA certificates are assembled from multiple sources by `getCACertificates()` (`src/utils/caCerts.ts:28-105`):

1. If neither `--use-system-ca`/`--use-openssl-ca` node option nor `NODE_EXTRA_CA_CERTS` is set → returns `undefined` (runtime defaults apply)
2. If `--use-system-ca` is set:
   - Tries the Bun-specific `tls.getCACertificates('system')` API
   - Falls back to bundled `tls.rootCertificates` (Mozilla CAs) if unavailable
   - Under Node.js without extra certs, defers to Node.js native handling
3. Otherwise, starts with bundled Mozilla root certificates from `tls.rootCertificates`
4. Appends contents of the file at `NODE_EXTRA_CA_CERTS` if set

The `NODE_EXTRA_CA_CERTS` env var is populated early in init by `applyExtraCACertsFromConfig()` (`src/utils/caCertsConfig.ts:34-45`), which reads from user-controlled config files (`~/.claude.json` and `~/.claude/settings.json`) — never project-level settings, to prevent malicious projects from injecting CA certs before the trust dialog.

### Mutual TLS (mTLS) Configuration

mTLS allows client certificate authentication, configured via three environment variables (`src/utils/mtls.ts:23-73`):

1. `CLAUDE_CODE_CLIENT_CERT` → path to client certificate PEM file
2. `CLAUDE_CODE_CLIENT_KEY` → path to client private key PEM file
3. `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` → passphrase for encrypted keys

`getMTLSConfig()` reads and caches these. `getMTLSAgent()` creates a Node.js `https.Agent` with the mTLS config plus CA certificates, with `keepAlive: true` for connection reuse.

### Global Agent Configuration

`configureGlobalAgents()` (`src/utils/proxy.ts:327-388`) wires everything together at startup:

1. Ejects any previously installed axios interceptor (idempotent reconfiguration)
2. If a proxy URL is configured:
   - Creates an `HttpsProxyAgent` with mTLS and CA cert options
   - Installs an axios request interceptor that checks `shouldBypassProxy()` per request
   - Sets the undici global dispatcher to an `EnvHttpProxyAgent` that natively respects `NO_PROXY`
3. If no proxy but mTLS is configured:
   - Sets the mTLS agent as axios's default `httpsAgent`
   - Creates an undici `Agent` with TLS options as the global dispatcher

### Keep-Alive Management

A process-wide `keepAliveDisabled` flag (`src/utils/proxy.ts:27-31`) can be flipped by `disableKeepAlive()` after a stale-pool `ECONNRESET`. Once set, all subsequent `getProxyFetchOptions()` calls include `keepalive: false`. The flag is sticky for the process lifetime — once the pool is known-bad, it stays disabled.

### Auth Header Generation and 401 Retry

`getAuthHeaders()` (`src/utils/http.ts:69-99`) produces authentication headers based on the user type:

- **Claude.ai subscribers (Max/Pro)**: Returns `Authorization: Bearer <accessToken>` with the OAuth beta header
- **API key users**: Returns `x-api-key: <key>`

`withOAuth401Retry()` (`src/utils/http.ts:115-136`) wraps request closures with automatic token refresh on 401 errors:

1. Executes the request
2. On 401 (or optionally 403 with "OAuth token has been revoked" body), force-refreshes the OAuth token via `handleOAuth401Error()`
3. Retries the request once, which re-reads auth headers to pick up the refreshed token

### User-Agent String Construction

Three user-agent formats are produced for different contexts (`src/utils/http.ts:18-58`):

- **`getUserAgent()`**: Full CLI agent string: `claude-cli/<version> (<user_type>, <entrypoint>, agent-sdk/<ver>, client-app/<app>, workload/<tag>)`. Used for API requests — log filtering depends on the `claude-cli` prefix.
- **`getMCPUserAgent()`**: MCP-specific: `claude-code/<version> (<entrypoint>, agent-sdk/<ver>, client-app/<app>)`
- **`getWebFetchUserAgent()`**: For WebFetch tool requests: `Claude-User (claude-code/<version>; +https://support.anthropic.com/)` — matches Anthropic's documented agent for robots.txt.

`getClaudeCodeUserAgent()` in `userAgent.ts` provides a dependency-free `claude-code/<version>` string for SDK-bundled code paths that cannot afford to import `auth.ts`.

## Function Signatures

### Proxy (`src/utils/proxy.ts`)

#### `getProxyUrl(env?: EnvLike): string | undefined`
Returns the active proxy URL from environment variables. Checks `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY` in that order.

#### `shouldBypassProxy(urlString: string, noProxy?: string): boolean`
Checks if a URL should skip the proxy based on the `NO_PROXY` value. Supports exact hostname, domain suffix (`.example.com`), wildcard (`*`), port-specific (`host:port`), and IP address patterns.

#### `getProxyFetchOptions(opts?: { forAnthropicAPI?: boolean }): object`
Returns fetch options (dispatcher, proxy URL, TLS config, keepalive) for the Anthropic SDK and other fetch callers. When `forAnthropicAPI` is true and `ANTHROPIC_UNIX_SOCKET` is set under Bun, routes through the `claude ssh` auth proxy unix socket.

#### `getWebSocketProxyAgent(url: string): Agent | undefined`
Creates an `HttpsProxyAgent` for Node.js WebSocket connections. Returns `undefined` if no proxy or the URL matches `NO_PROXY`.

#### `getWebSocketProxyUrl(url: string): string | undefined`
Returns the raw proxy URL string for Bun's native WebSocket `proxy` option. Returns `undefined` if no proxy or URL should bypass.

#### `createAxiosInstance(extra?: HttpsProxyAgentOptions): AxiosInstance`
Creates an Axios instance with a scoped proxy agent and NO_PROXY-aware request interceptor.

#### `configureGlobalAgents(): void`
Configures global axios defaults and undici global dispatcher with proxy/mTLS settings. Idempotent — ejects previous interceptors on reconfiguration.

#### `getAWSClientProxyConfig(): Promise<object>`
Returns AWS SDK client configuration (`requestHandler` + `credentials`) with proxy support. Dynamically imports `@smithy/node-http-handler` and `@aws-sdk/credential-provider-node` to defer ~929KB.

#### `disableKeepAlive(): void`
Permanently disables keep-alive for all subsequent `getProxyFetchOptions()` calls after a stale-pool ECONNRESET.

#### `clearProxyCache(): void`
Clears the memoized proxy agent cache.

### mTLS (`src/utils/mtls.ts`)

#### `getMTLSConfig(): MTLSConfig | undefined`
Returns mTLS configuration (cert, key, passphrase) from environment variables. Memoized.

#### `getMTLSAgent(): HttpsAgent | undefined`
Creates an `https.Agent` with mTLS config and CA certificates. Memoized. Returns `undefined` if no custom TLS is needed.

#### `getWebSocketTLSOptions(): tls.ConnectionOptions | undefined`
Returns TLS options (cert, key, passphrase, ca) for WebSocket connections.

#### `getTLSFetchOptions(): { tls?: TLSConfig, dispatcher?: undici.Dispatcher }`
Returns TLS-configured fetch options. Under Bun, returns a `tls` object; under Node.js, creates an undici `Agent` with TLS connect options.

#### `clearMTLSCache(): void`
Clears memoized mTLS config and agent caches.

### Auth & User-Agent (`src/utils/http.ts`)

#### `getAuthHeaders(): AuthHeaders`
Returns `{ headers, error? }` with either OAuth Bearer token or `x-api-key` header.

#### `withOAuth401Retry<T>(request: () => Promise<T>, opts?: { also403Revoked?: boolean }): Promise<T>`
Wraps a request with automatic OAuth token refresh on 401 (and optionally 403 revoked). Retries once.

### Peer Address (`src/utils/peerAddress.ts`)

#### `parseAddress(to: string): { scheme: 'uds' | 'bridge' | 'other', target: string }`
Parses URI-style addresses (`uds:/path`, `bridge:id`) for inter-agent message routing. Bare `/`-prefixed paths are treated as UDS for backward compatibility with legacy senders.

## Type Definitions

### `MTLSConfig` (`src/utils/mtls.ts:10-14`)
```typescript
type MTLSConfig = {
  cert?: string       // PEM-encoded client certificate
  key?: string        // PEM-encoded client private key
  passphrase?: string // Passphrase for encrypted key
}
```

### `TLSConfig` (`src/utils/mtls.ts:16-18`)
Extends `MTLSConfig` with an optional `ca` field for CA certificates:
```typescript
type TLSConfig = MTLSConfig & {
  ca?: string | string[] | Buffer
}
```

### `AuthHeaders` (`src/utils/http.ts:60-63`)
```typescript
type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}
```

## Configuration & Environment Variables

| Variable | Purpose |
|----------|---------|
| `HTTPS_PROXY` / `https_proxy` | Proxy URL for HTTPS requests (lowercase preferred) |
| `HTTP_PROXY` / `http_proxy` | Fallback proxy URL |
| `NO_PROXY` / `no_proxy` | Comma/space-separated list of hostnames/IPs/patterns to bypass proxy |
| `CLAUDE_CODE_PROXY_RESOLVES_HOSTS` | When truthy, skip local DNS resolution and let the proxy handle it |
| `CLAUDE_CODE_CLIENT_CERT` | Path to client certificate PEM file for mTLS |
| `CLAUDE_CODE_CLIENT_KEY` | Path to client private key PEM file for mTLS |
| `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` | Passphrase for the client key |
| `NODE_EXTRA_CA_CERTS` | Path to extra CA certificate PEM file (also populatable from `~/.claude/settings.json`) |
| `ANTHROPIC_UNIX_SOCKET` | Unix socket path for `claude ssh` auth proxy tunneling (Bun only, Anthropic API only) |
| `CLAUDE_AGENT_SDK_VERSION` | SDK version included in User-Agent string |
| `CLAUDE_AGENT_SDK_CLIENT_APP` | Client app identifier included in User-Agent string |

Node options `--use-system-ca` and `--use-openssl-ca` trigger loading from the system CA store instead of bundled Mozilla CAs.

## Edge Cases & Caveats

- **Lazy loading for bundle size**: `undici` (~1.5MB) is lazy-`require()`'d only when proxy or mTLS is actually configured. Similarly, `tls.rootCertificates` (~750KB on Bun) is deferred until CA cert handling is needed. AWS SDK modules (~929KB) are dynamically imported only in `getAWSClientProxyConfig()`.

- **Bun vs Node.js divergence**: The module handles runtime differences throughout — Bun's native fetch uses `proxy` string and `tls` options, while Node.js/undici uses `dispatcher` agents. `ANTHROPIC_UNIX_SOCKET` only works under Bun. System CA loading uses Bun's `tls.getCACertificates('system')` API.

- **Keep-alive is sticky-off**: Once `disableKeepAlive()` is called after an ECONNRESET, it never re-enables for the process lifetime. Under Node/undici, the `keepalive` flag is a no-op for pooling, but undici naturally evicts dead sockets.

- **Proxy agent memoization**: `getProxyAgent()` is memoized by URI, meaning the same proxy URL always returns the same dispatcher. Call `clearProxyCache()` if proxy configuration changes at runtime.

- **CA certs from settings read only user-controlled files**: `applyExtraCACertsFromConfig()` deliberately reads only from `~/.claude.json` and `~/.claude/settings.json`, never project-level settings, to prevent a malicious project from injecting CA certs before the trust dialog.

- **OAuth 401 retry is single-attempt**: `withOAuth401Retry()` retries exactly once after refreshing the token. The request closure must re-read auth headers on retry to pick up the new token. A separate DI-injected version exists in `bridgeApi.ts` to avoid the config.ts import chain in the SDK bundle.

- **`configureGlobalAgents()` is idempotent**: It ejects the previous axios interceptor before installing a new one, allowing safe reconfiguration (e.g., after proxy settings change).