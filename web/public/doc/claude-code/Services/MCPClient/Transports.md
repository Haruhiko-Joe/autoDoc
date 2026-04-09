# Transports

## Overview & Responsibilities

The Transports module provides two custom MCP (Model Context Protocol) transport implementations that extend beyond the standard SDK transports (stdio, SSE, streamable HTTP). Both live within the **Services → MCPClient** layer of the architecture and solve the problem of MCP communication when the server and client are **not** separate OS processes connected by pipes.

| Transport | File | Purpose |
|-----------|------|---------|
| `InProcessTransport` | `src/services/mcp/InProcessTransport.ts` | Linked pair for same-process MCP server + client |
| `SdkControlClientTransport` / `SdkControlServerTransport` | `src/services/mcp/SdkControlTransport.ts` | Bridge between CLI process (MCP client) and SDK process (MCP server) via stdout control messages |

Both implement the MCP SDK's `Transport` interface (`@modelcontextprotocol/sdk/shared/transport.js`), which requires `start()`, `send()`, `close()`, and the callback hooks `onmessage`, `onclose`, and `onerror`.

---

## Key Processes

### InProcessTransport: Linked Pair Communication

`createLinkedTransportPair()` (`src/services/mcp/InProcessTransport.ts:57-63`) creates two `InProcessTransport` instances that are cross-wired: calling `send()` on one delivers the message to `onmessage` on the other. This enables running an MCP server and client **in the same Node.js process** without spawning a subprocess or opening a network connection.

```
┌──────────────┐   send() ──→ onmessage   ┌──────────────┐
│  Transport A │ ←──────────────────────── │  Transport B │
│  (client)    │   onmessage ←── send()    │  (server)    │
└──────────────┘                           └──────────────┘
```

The flow for a single request-response cycle:

1. MCP Client calls `transportA.send(request)`
2. `send()` guards against a closed transport, then schedules delivery via `queueMicrotask()` (`src/services/mcp/InProcessTransport.ts:32-34`)
3. On the next microtask, `transportB.onmessage(request)` fires, delivering the message to the MCP Server
4. The MCP Server processes the request and calls `transportB.send(response)`
5. `queueMicrotask()` delivers `transportA.onmessage(response)` back to the MCP Client

**Why `queueMicrotask` instead of direct invocation?** Synchronous delivery would cause stack depth issues when a request handler immediately sends a response — each send/receive pair would nest deeper on the call stack. Deferring to the microtask queue breaks this chain while still delivering before any macrotask (setTimeout, I/O) runs.

**Bidirectional close propagation** (`src/services/mcp/InProcessTransport.ts:37-48`): Closing either side closes both. The `closed` flag prevents infinite close loops — when side A closes, it sets its own `closed = true`, fires its `onclose`, then checks if the peer is already closed before propagating.

### SdkControlTransport: Cross-Process Bridge

When the Claude Code SDK runs an MCP server **in its own process**, the CLI process (MCP client) and SDK process (MCP server) need to exchange MCP messages across a process boundary. The SdkControlTransport pair wraps MCP JSON-RPC messages inside "control messages" sent over stdout/stdin.

```
CLI Process                              SDK Process
┌─────────────┐                          ┌─────────────────────┐
│  MCP Client │                          │  MCP Server         │
│      │       │                          │         ▲           │
│      ▼       │                          │         │           │
│ SdkControl   │  control request        │ SdkControl          │
│ Client       │ ──── stdout ──────────→ │ Server              │
│ Transport    │ ←─── response ──────── │ Transport            │
└─────────────┘                          └─────────────────────┘
```

#### CLI → SDK Flow (SdkControlClientTransport)

1. MCP Client calls `transport.send(message)` (`src/services/mcp/SdkControlTransport.ts:74-86`)
2. Transport calls `sendMcpMessage(serverName, message)` — a callback provided at construction that wraps the JSON-RPC message in a control request with `server_name` for routing
3. The callback sends the control request via stdout to the SDK process and returns a `Promise<JSONRPCMessage>` that resolves when the SDK responds
4. SDK's StructuredIO receives the control request, routes it to the correct `SdkControlServerTransport` by `server_name`, and calls `transport.onmessage(message)`
5. The resolved response is delivered to `transport.onmessage` on the client side

Unlike `InProcessTransport`'s fire-and-forget delivery, `SdkControlClientTransport.send()` **awaits the full round-trip response** before delivering it — each call blocks until the SDK responds.

#### SDK → CLI Flow (SdkControlServerTransport)

1. External code (the Query layer) calls `transport.onmessage(request)` to deliver an inbound control request
2. The MCP Server processes the request and calls `transport.send(response)` (`src/services/mcp/SdkControlTransport.ts:120-127`)
3. Transport passes the response to its `sendMcpMessage` callback (a synchronous `(message: JSONRPCMessage) => void`)
4. The Query layer's callback resolves the pending promise, completing the control request cycle back to the CLI

#### Multi-Server Routing

The `serverName` parameter on `SdkControlClientTransport` (`src/services/mcp/SdkControlTransport.ts:68`) is included in every control request wrapper, enabling the SDK process to route messages to the correct MCP server when **multiple SDK MCP servers** run simultaneously. Message IDs are preserved end-to-end for proper correlation.

---

## Function Signatures

### `createLinkedTransportPair(): [Transport, Transport]`

Factory function that creates and returns a linked in-process transport pair. The first element is conventionally the client transport, the second is the server transport. The `InProcessTransport` class itself is **not exported** — only this factory is public.

```typescript
// src/services/mcp/InProcessTransport.ts:57-63
const [clientTransport, serverTransport] = createLinkedTransportPair()
```

> Source: `src/services/mcp/InProcessTransport.ts:57-63`

### `SdkControlClientTransport`

CLI-side transport. Constructed with `serverName` and a `SendMcpMessageCallback`.

```typescript
// src/services/mcp/SdkControlTransport.ts:60-70
constructor(
  private serverName: string,
  private sendMcpMessage: SendMcpMessageCallback,
)
```

- `send(message)`: Calls `sendMcpMessage`, awaits the response, and delivers it to `onmessage`
- `close()`: Sets `isClosed`, fires `onclose`

> Source: `src/services/mcp/SdkControlTransport.ts:60-95`

### `SdkControlServerTransport`

SDK-side transport. Constructed with a synchronous message callback.

```typescript
// src/services/mcp/SdkControlTransport.ts:109-112
constructor(private sendMcpMessage: (message: JSONRPCMessage) => void)
```

- `send(message)`: Passes the response directly to `sendMcpMessage`
- `close()`: Sets `isClosed`, fires `onclose`

> Source: `src/services/mcp/SdkControlTransport.ts:109-136`

---

## Interface/Type Definitions

### `SendMcpMessageCallback`

```typescript
// src/services/mcp/SdkControlTransport.ts:45-48
type SendMcpMessageCallback = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>
```

Callback type used by `SdkControlClientTransport`. The implementation wraps the message in a control request, sends it via stdout, and resolves when the SDK process responds.

### `Transport` Interface (from MCP SDK)

Both transports implement this interface:

| Member | Type | Description |
|--------|------|-------------|
| `start()` | `Promise<void>` | Initialize the transport (no-op in both implementations) |
| `send(message)` | `Promise<void>` | Send a JSON-RPC message |
| `close()` | `Promise<void>` | Close the transport |
| `onmessage` | `(message: JSONRPCMessage) => void` | Callback for received messages |
| `onclose` | `() => void` | Callback when transport closes |
| `onerror` | `(error: Error) => void` | Callback for errors |

---

## Edge Cases & Caveats

- **Closed transport throws**: Both transports throw `Error('Transport is closed')` if `send()` is called after `close()`. Callers should handle this during shutdown sequences.
- **InProcessTransport close is irreversible**: Once closed, a transport pair cannot be reopened. Create a new pair via `createLinkedTransportPair()`.
- **SdkControlClientTransport serializes requests**: Because `send()` awaits the full round-trip response, the MCP client's request pipeline is serialized per-call — each request must complete before the next one can be sent.
- **No reconnection logic**: Neither transport implements reconnection. They are designed for stable, co-located communication channels (same process or parent-child process) where connection loss is not expected.
- **`onerror` is never called internally**: Both transports declare the `onerror` callback per the `Transport` interface contract but never invoke it themselves. Error signaling depends on external infrastructure (StructuredIO on the CLI side, Query on the SDK side).
- **`start()` is a no-op**: Both implementations have empty `start()` methods (`src/services/mcp/InProcessTransport.ts:24`, `src/services/mcp/SdkControlTransport.ts:72`, `src/services/mcp/SdkControlTransport.ts:118`) since there are no connections to establish — the transports are ready immediately after construction.