# UpstreamProxy

## Overview & Responsibilities

The UpstreamProxy module is the container-side networking layer for Claude Code Remote (CCR) environments. It lives under the **RemoteAndBridge** parent module and is responsible for transparently routing HTTPS traffic from agent subprocesses (curl, gh, kubectl, etc.) through an organization's upstream proxy.

When a CCR session container starts with upstream proxy enabled, this module:

1. Reads a one-time session token from disk
2. Hardens the process against credential theft via ptrace
3. Downloads and trusts the MITM proxy's CA certificate
4. Starts a local TCP relay that tunnels CONNECT requests over WebSocket
5. Removes the token file from disk (keeping it heap-only)
6. Exports proxy environment variables so all child processes route through the relay

Every step **fails open** — a broken proxy setup logs a warning and disables the feature rather than blocking the session.

## Key Processes

### Initialization Flow (`initUpstreamProxy`)

The main entry point is called once during CLI startup. It gates on two environment variables before doing any work:

1. **Gate checks** — returns early (disabled) unless both `CLAUDE_CODE_REMOTE` and `CCR_UPSTREAM_PROXY_ENABLED` are truthy, and `CLAUDE_CODE_REMOTE_SESSION_ID` is set (`src/upstreamproxy/upstreamproxy.ts:85-103`)
2. **Read session token** — reads `/run/ccr/session_token`, returns null on ENOENT or empty file (`src/upstreamproxy/upstreamproxy.ts:206-218`)
3. **Set non-dumpable** — calls `prctl(PR_SET_DUMPABLE, 0)` via Bun FFI on Linux to prevent same-UID ptrace from scraping the token off the heap (`src/upstreamproxy/upstreamproxy.ts:225-252`)
4. **Download CA bundle** — fetches the MITM proxy's CA certificate from `{baseUrl}/v1/code/upstreamproxy/ca-cert` (5s timeout), concatenates it with the system CA bundle (`/etc/ssl/certs/ca-certificates.crt`), and writes the combined bundle to `~/.ccr/ca-bundle.crt` (`src/upstreamproxy/upstreamproxy.ts:254-285`)
5. **Start relay** — launches the local CONNECT-over-WebSocket relay on an ephemeral port, registers a cleanup handler to stop it on process exit (`src/upstreamproxy/upstreamproxy.ts:132-143`)
6. **Unlink token** — removes the token file from disk only after the relay is confirmed listening, so a supervisor restart can retry if earlier steps fail (`src/upstreamproxy/upstreamproxy.ts:140-144`)

### CONNECT-over-WebSocket Relay Flow

The relay (`src/upstreamproxy/relay.ts`) implements a two-phase per-connection state machine:

**Phase 1 — CONNECT parsing** (`handleData`, lines 303-333):
1. Accumulates incoming bytes until a complete HTTP CONNECT request is detected (terminated by `\r\n\r\n`)
2. Validates the request line matches `CONNECT <host:port> HTTP/1.x`; rejects non-CONNECT methods with 405
3. Stashes any trailing bytes (e.g., a coalesced TLS ClientHello) into a pending buffer
4. Opens a WebSocket tunnel to the CCR upstream proxy endpoint

**Phase 2 — Tunnel** (`openTunnel`, lines 344-428):
1. On WebSocket open: sends the CONNECT request line plus `Proxy-Authorization: Basic <sessionId:token>` as the first protobuf-framed chunk
2. Flushes any pending bytes that arrived during the WebSocket handshake
3. Starts a 30-second keepalive ping interval (empty protobuf chunks)
4. Pipes server→client: decodes incoming protobuf chunks and writes raw bytes to the TCP socket
5. Pipes client→server: splits outgoing data into 512KB chunks, encodes each as protobuf, and sends over WebSocket
6. On error before tunnel establishment: sends `HTTP/1.1 502 Bad Gateway` to the client
7. On error after establishment: closes the socket without writing (to avoid corrupting the TLS stream)

### Protobuf Wire Format

Bytes are wrapped in `UpstreamProxyChunk { bytes data = 1; }` protobuf messages, hand-encoded to avoid a runtime dependency:

- **Tag byte**: `0x0a` (field 1, wire type 2 / length-delimited)
- **Length**: varint-encoded byte count
- **Payload**: raw bytes

```typescript
// src/upstreamproxy/relay.ts:66-81
export function encodeChunk(data: Uint8Array): Uint8Array {
  const len = data.length
  const varint: number[] = []
  let n = len
  while (n > 0x7f) {
    varint.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  varint.push(n)
  const out = new Uint8Array(1 + varint.length + len)
  out[0] = 0x0a
  out.set(varint, 1)
  out.set(data, 1 + varint.length)
  return out
}
```

### Environment Variable Propagation

`getUpstreamProxyEnv()` (`src/upstreamproxy/upstreamproxy.ts:160-199`) returns a record of env vars merged into every agent subprocess (Bash, MCP, LSP, hooks). When the relay is active:

| Variable | Value | Purpose |
|----------|-------|---------|
| `HTTPS_PROXY` / `https_proxy` | `http://127.0.0.1:<port>` | Routes HTTPS CONNECT through the local relay |
| `NO_PROXY` / `no_proxy` | See below | Bypasses for loopback, RFC1918, Anthropic API, GitHub, package registries |
| `SSL_CERT_FILE` | `~/.ccr/ca-bundle.crt` | OpenSSL / Node / curl CA trust |
| `NODE_EXTRA_CA_CERTS` | same | Node.js additional CA trust |
| `REQUESTS_CA_BUNDLE` | same | Python requests/httpx CA trust |
| `CURL_CA_BUNDLE` | same | curl CA trust |

When the relay is **not** active but inherited proxy vars exist (child CLI processes that can't re-initialize), the function passes through the parent's proxy environment variables.

## Function Signatures

### `initUpstreamProxy(opts?): Promise<UpstreamProxyState>`

Initializes the upstream proxy. Called once from `init.ts`.

- **opts.tokenPath** (`string`): Override session token path (default: `/run/ccr/session_token`)
- **opts.systemCaPath** (`string`): Override system CA bundle path (default: `/etc/ssl/certs/ca-certificates.crt`)
- **opts.caBundlePath** (`string`): Override output CA bundle path (default: `~/.ccr/ca-bundle.crt`)
- **opts.ccrBaseUrl** (`string`): Override CCR API base URL (default: `ANTHROPIC_BASE_URL` or `https://api.anthropic.com`)
- **Returns**: `{ enabled: boolean, port?: number, caBundlePath?: string }`

> Source: `src/upstreamproxy/upstreamproxy.ts:79-153`

### `getUpstreamProxyEnv(): Record<string, string>`

Returns env vars to merge into subprocess environments. Empty object when proxy is disabled.

> Source: `src/upstreamproxy/upstreamproxy.ts:160-199`

### `startUpstreamProxyRelay(opts): Promise<UpstreamProxyRelay>`

Starts the TCP relay server. Dispatches to Bun or Node implementation based on runtime.

- **opts.wsUrl** (`string`): WebSocket endpoint URL
- **opts.sessionId** (`string`): CCR session ID for authentication
- **opts.token** (`string`): Session token for authentication
- **Returns**: `{ port: number, stop: () => void }`

> Source: `src/upstreamproxy/relay.ts:155-174`

### `encodeChunk(data: Uint8Array): Uint8Array` / `decodeChunk(buf: Uint8Array): Uint8Array | null`

Hand-rolled protobuf encoder/decoder for `UpstreamProxyChunk { bytes data = 1; }`. Exported for testing.

> Source: `src/upstreamproxy/relay.ts:66-103`

## Type Definitions

### `UpstreamProxyState`

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | `boolean` | Whether the proxy relay is active |
| `port` | `number?` | Ephemeral port the relay is listening on |
| `caBundlePath` | `string?` | Path to the combined CA certificate bundle |

### `UpstreamProxyRelay`

| Field | Type | Description |
|-------|------|-------------|
| `port` | `number` | TCP port the relay is bound to |
| `stop` | `() => void` | Shuts down the relay server |

### `ConnState`

Per-connection state for the two-phase CONNECT/tunnel state machine:

| Field | Type | Description |
|-------|------|-------------|
| `ws` | `WebSocketLike?` | The upstream WebSocket connection |
| `connectBuf` | `Buffer` | Accumulator for CONNECT request bytes |
| `pending` | `Buffer[]` | Bytes received before WebSocket opened |
| `wsOpen` | `boolean` | Whether the WebSocket handshake completed |
| `established` | `boolean` | Whether the tunnel's 200 response was forwarded |
| `closed` | `boolean` | Guard against double-close |

## Configuration

### Environment Variables (read)

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_REMOTE` | Yes | Must be truthy to enable the module |
| `CCR_UPSTREAM_PROXY_ENABLED` | Yes | Feature flag injected by CCR server-side |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | Yes | Session ID used for relay authentication |
| `ANTHROPIC_BASE_URL` | No | API base URL; defaults to `https://api.anthropic.com` |

### Files

| Path | Description |
|------|-------------|
| `/run/ccr/session_token` | One-time session token; read then deleted |
| `/etc/ssl/certs/ca-certificates.crt` | System CA bundle; concatenated with MITM CA |
| `~/.ccr/ca-bundle.crt` | Output combined CA bundle |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_CHUNK_BYTES` | 512 KB | Maximum protobuf chunk size (Envoy buffer limit) |
| `PING_INTERVAL_MS` | 30,000 ms | Keepalive interval (sidecar idle timeout is 50s) |

## Edge Cases & Caveats

- **Fail-open design**: Every step (token read, CA download, relay start, token unlink) catches errors and disables the proxy rather than crashing the session. This is intentional — a broken proxy must never block an otherwise-working session.

- **Token lifecycle**: The token file is only unlinked *after* the relay is confirmed listening. If CA download or `listen()` fails, the supervisor can restart and retry with the token still on disk.

- **ptrace hardening**: `prctl(PR_SET_DUMPABLE, 0)` prevents a prompt-injected `gdb -p $PPID` from scraping the session token from process memory. Only works on Linux under Bun (uses `bun:ffi`); silently no-ops on other platforms.

- **NO_PROXY list**: Anthropic API domains are excluded in three formats (`anthropic.com`, `.anthropic.com`, `*.anthropic.com`) because `NO_PROXY` parsing differs across runtimes (Bun uses glob, Python uses suffix, etc.). The MITM proxy's forged CA isn't trusted by non-Bun runtimes like Python httpx/certifi.

- **HTTPS only**: Only `HTTPS_PROXY` is set, not `HTTP_PROXY`. The relay only handles CONNECT — plain HTTP requests would get a 405.

- **TCP coalescing**: The relay correctly handles TCP packets that coalesce the CONNECT header with subsequent TLS ClientHello bytes, buffering trailing data and flushing it once the WebSocket opens.

- **Post-establishment errors**: Once the tunnel's `200 Connection Established` has been forwarded and TLS is flowing, errors cause a silent socket close rather than writing a plaintext `502` (which would corrupt the client's TLS stream).

- **Bun vs Node write semantics**: Bun's `sock.write()` does partial writes (returns bytes written), requiring explicit tail-queueing in a `writeBuf`. Node's `net.Socket.write()` buffers internally, so no additional buffering is needed. The relay handles both via the `ClientSocket` abstraction.

- **Child process inheritance**: Child CLI processes can't re-initialize the relay (the token file is gone), but if they inherit `HTTPS_PROXY` and `SSL_CERT_FILE` from the parent, `getUpstreamProxyEnv()` passes those through so grandchild processes also route through the parent's relay.

- **WebSocket protocol**: The upgrade request must include `Content-Type: application/proto`; without it the server tries JSON unmarshalling of binary chunks and fails silently with EOF.

- **Dual authentication**: The WebSocket upgrade carries a `Bearer` token (session-ingress JWT for gateway auth), while the tunneled CONNECT request carries `Proxy-Authorization: Basic <sessionId:token>` (for the proxy endpoint itself).