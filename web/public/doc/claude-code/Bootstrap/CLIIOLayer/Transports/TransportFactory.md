# TransportFactory

## Overview & Responsibilities

The TransportFactory module (`src/cli/transports/transportUtils.ts`) exposes a single factory function, `getTransportForUrl`, that selects and instantiates the correct transport implementation for remote/bridge server communication. It sits within the **Bootstrap → CLIIOLayer → Transports** layer and is called by `RemoteIO` when establishing a connection to a session endpoint.

The module abstracts away transport selection so that callers don't need to know which transport variant is appropriate — the decision is driven entirely by the incoming URL protocol and two environment flags.

## Key Process Walkthrough

### Transport Selection Logic

The factory evaluates conditions in strict priority order:

1. **CCR v2 mode** — If `CLAUDE_CODE_USE_CCR_V2` is truthy, an `SSETransport` is returned. Before constructing it, the function converts WebSocket URLs to their HTTP equivalents (`wss:` → `https:`, `ws:` → `http:`) and appends `/worker/events/stream` to the pathname. This effectively transforms a session URL like `wss://host/sessions/abc` into `https://host/sessions/abc/worker/events/stream` for SSE streaming. (`src/cli/transports/transportUtils.ts:22-35`)

2. **Hybrid ingress mode** — If the URL uses `ws:` or `wss:` and `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` is truthy, a `HybridTransport` is returned. This transport reads via WebSocket but writes via HTTP POST. (`src/cli/transports/transportUtils.ts:38-39`)

3. **Default WebSocket** — If the URL uses `ws:` or `wss:` and neither flag is set, a standard `WebSocketTransport` is returned (bidirectional WebSocket). (`src/cli/transports/transportUtils.ts:41`)

4. **Unsupported protocol** — Any other URL protocol throws an `Error`. (`src/cli/transports/transportUtils.ts:43`)

```
getTransportForUrl(url)
  │
  ├─ CLAUDE_CODE_USE_CCR_V2?  ──yes──▶ SSETransport (with URL rewrite)
  │
  ├─ ws:/wss: protocol?
  │    ├─ CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2?  ──yes──▶ HybridTransport
  │    └─ otherwise  ──────────────────────────────────────▶ WebSocketTransport
  │
  └─ other protocol  ──▶ throw Error
```

## Function Signature

### `getTransportForUrl(url, headers?, sessionId?, refreshHeaders?): Transport`

Factory function that returns the appropriate transport instance.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | `URL` | — | The session endpoint URL (typically `wss://...`) |
| `headers` | `Record<string, string>` | `{}` | Static HTTP headers to attach to requests |
| `sessionId` | `string \| undefined` | `undefined` | Session identifier passed through to the transport |
| `refreshHeaders` | `() => Record<string, string>` | `undefined` | Callback to dynamically refresh auth/request headers |

**Returns**: A `Transport` instance — one of `SSETransport`, `HybridTransport`, or `WebSocketTransport`.

**Throws**: `Error` if the URL protocol is not `ws:` or `wss:` and CCR v2 mode is not active.

> Source: `src/cli/transports/transportUtils.ts:16-45`

## Configuration

| Environment Variable | Effect |
|---|---|
| `CLAUDE_CODE_USE_CCR_V2` | When truthy (`1`, `true`, `yes`, `on`), forces SSE transport with URL protocol conversion |
| `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` | When truthy and CCR v2 is not active, selects HybridTransport (WS reads + POST writes) over pure WebSocket |

Truthiness is evaluated by `isEnvTruthy()` from `src/utils/envUtils.ts`, which normalizes the value to lowercase and accepts `1`, `true`, `yes`, or `on`.

## Edge Cases & Caveats

- **CCR v2 takes absolute priority**: When `CLAUDE_CODE_USE_CCR_V2` is set, the function always returns `SSETransport` regardless of the URL protocol or `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2`. The two flags are not combined.
- **URL rewriting strips trailing slashes**: The pathname rewrite uses `replace(/\/$/, '')` before appending `/worker/events/stream`, preventing double-slash issues (`/sessions/abc//worker/events/stream`).
- **Non-WebSocket URLs without CCR v2 throw**: If a caller passes an `http:` or `https:` URL without `CLAUDE_CODE_USE_CCR_V2` being set, the function throws rather than silently falling back. This is an intentional guard against misconfiguration.
- **All transport constructors receive the same four arguments** (`url`, `headers`, `sessionId`, `refreshHeaders`), keeping the factory simple — no transport-specific configuration is handled here.

## Key Code Snippet

The complete factory logic (`src/cli/transports/transportUtils.ts:16-45`):

```typescript
export function getTransportForUrl(
  url: URL,
  headers: Record<string, string> = {},
  sessionId?: string,
  refreshHeaders?: () => Record<string, string>,
): Transport {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CCR_V2)) {
    const sseUrl = new URL(url.href)
    if (sseUrl.protocol === 'wss:') {
      sseUrl.protocol = 'https:'
    } else if (sseUrl.protocol === 'ws:') {
      sseUrl.protocol = 'http:'
    }
    sseUrl.pathname =
      sseUrl.pathname.replace(/\/$/, '') + '/worker/events/stream'
    return new SSETransport(sseUrl, headers, sessionId, refreshHeaders)
  }

  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    if (isEnvTruthy(process.env.CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2)) {
      return new HybridTransport(url, headers, sessionId, refreshHeaders)
    }
    return new WebSocketTransport(url, headers, sessionId, refreshHeaders)
  } else {
    throw new Error(`Unsupported protocol: ${url.protocol}`)
  }
}
```