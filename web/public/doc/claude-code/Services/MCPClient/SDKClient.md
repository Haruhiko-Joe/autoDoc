# SDKClient

## Overview & Responsibilities

The SDKClient module (`src/services/mcp/client.ts`) is the central entry point for all MCP (Model Context Protocol) server connections in Claude Code. It sits within the **Services > MCPClient** layer of the architecture and orchestrates the full lifecycle of MCP server connections: creating SDK `Client` instances over various transports, fetching tools/prompts/resources from connected servers, handling reconnection on connection drops, managing authentication flows, and caching connection and fetch results for performance.

Every other MCP sub-module feeds into this file — configuration (`config.ts`), authentication (`auth.ts`), normalization (`normalization.ts`), and the Claude.ai integration (`claudeai.ts`) — while the ToolSystem and CommandSystem consume its outputs (tools, commands, resources).

The companion types file (`src/services/mcp/types.ts`) defines the Zod schemas for all server configuration variants, the discriminated union of connection states, and serialization types used for CLI state transfer.

---

## Key Processes

### 1. Server Connection Flow (`connectToServer`)

The primary connection function is `connectToServer` (`src/services/mcp/client.ts:595-1641`), a **memoized** async function keyed by `getServerCacheKey(name, config)`. It handles every supported transport type:

1. **Transport selection** based on `serverRef.type`:
   - **`sse`**: Creates `SSEClientTransport` with `ClaudeAuthProvider`, custom headers, proxy support, and a separate long-lived `eventSourceInit` fetch (no timeout) for the SSE stream (`client.ts:619-677`)
   - **`sse-ide` / `ws-ide`**: IDE-specific transports without authentication, used by VS Code extensions (`client.ts:678-734`)
   - **`ws`**: WebSocket transport with custom headers, TLS options, and proxy support. Uses Bun's native WebSocket or Node's `ws` package (`client.ts:735-783`)
   - **`http`**: `StreamableHTTPClientTransport` with auth provider, session ingress token handling, and per-request timeout wrapping (`client.ts:784-865`)
   - **`claudeai-proxy`**: Streamable HTTP through Claude.ai's MCP proxy URL with OAuth bearer tokens and 401 retry logic (`client.ts:868-904`)
   - **`stdio`**: `StdioClientTransport` with subprocess environment, shell prefix support, and stderr capture (`client.ts:944-958`). Special-cased for Chrome MCP and Computer Use servers that run in-process (`client.ts:905-943`)
   - **`sdk`**: Handled separately via `setupSdkMcpClients`, not through `connectToServer`

2. **Client initialization**: Creates an MCP SDK `Client` with `claude-code` identity, declaring `roots` and `elicitation` capabilities. Registers a `ListRootsRequest` handler returning the current working directory (`client.ts:985-1018`)

3. **Connection with timeout**: Races `client.connect(transport)` against a configurable timeout (default 30s via `MCP_TIMEOUT` env var). On timeout, closes the transport and returns a `failed` connection (`client.ts:1048-1155`)

4. **Post-connection setup**:
   - Reads server capabilities, version, and instructions (truncated to 2048 chars)
   - Registers a default elicitation handler that returns `cancel`
   - Installs enhanced `onerror` / `onclose` handlers for connection drop detection and automatic cache invalidation
   - Registers a cleanup function in the global cleanup registry for graceful shutdown

5. **Return value**: A `ConnectedMCPServer` object (or `FailedMCPServer` / `NeedsAuthMCPServer` on failure/auth required)

### 2. Connection Drop Detection & Reconnection

The `onerror` handler (`client.ts:1266-1371`) implements a multi-layered detection strategy:

- **Session expiry** (HTTP 404 + JSON-RPC `-32001`): Immediately closes the transport to reject pending tool calls and trigger reconnection
- **SSE reconnection exhaustion** ("Maximum reconnection attempts"): Closes transport when the SDK gives up
- **Terminal connection errors** (ECONNRESET, ETIMEDOUT, EPIPE, ECONNREFUSED, EHOSTUNREACH): Tracked with a counter; after 3 consecutive terminal errors, triggers reconnection
- **Non-terminal errors**: Reset the consecutive error counter

The `onclose` handler (`client.ts:1374-1402`) clears all memoization caches (connection + fetch caches for tools, resources, commands, skills) so the next operation transparently reconnects.

### 3. Batch Connection Orchestration (`getMcpToolsCommandsAndResources`)

The main startup entry point (`client.ts:2226-2403`) connects to all configured MCP servers:

1. Loads all configs from `getAllMcpConfigs()`, partitions into disabled vs. active
2. Splits active servers into **local** (stdio/sdk, concurrency default 3) and **remote** (SSE/HTTP/WS, concurrency default 20)
3. For each server:
   - Skips if disabled → emits `disabled` status
   - Skips if auth-cached (15-min TTL) or has discovery metadata but no token → emits `needs-auth` with an auth tool
   - Calls `connectToServer`, then fetches tools/commands/skills/resources in parallel
   - Adds `ListMcpResourcesTool` and `ReadMcpResourceTool` for the first server that supports resources
4. Uses `pMap` for concurrent processing within each group, replacing the previous fixed-batch approach for better scheduling

### 4. Tool Call Flow

When Claude invokes an MCP tool, the call flows through:

1. **`tool.call()`** (generated in `fetchToolsForClient`) → calls `ensureConnectedClient` to get a valid connection
2. **`callMCPToolWithUrlElicitationRetry`** (`client.ts:2813-3027`) → wraps the actual call with URL elicitation retry logic (up to 3 retries for `-32042` errors)
3. **`callMCPTool`** (`client.ts:3029-3245`) → the low-level call:
   - Logs progress every 30s for long-running tools
   - Races `client.callTool()` against a configurable timeout (default ~27.8 hours via `MCP_TOOL_TIMEOUT`)
   - Handles `isError: true` results by throwing `McpToolCallError`
   - Detects 401 errors → throws `McpAuthError` to trigger re-auth
   - Detects session expiry → clears cache and throws `McpSessionExpiredError` (caller retries once)
   - Processes results through `processMCPResult`

### 5. Result Processing

`processMCPResult` (`client.ts:2720-2799`) handles large outputs:

- If content is small enough, returns as-is
- If large and contains images, truncates (to preserve image compression)
- Otherwise, persists to a file on disk and returns instructions for the model to read specific portions via the Read tool

---

## Function Signatures

### `connectToServer(name: string, serverRef: ScopedMcpServerConfig, serverStats?): Promise<MCPServerConnection>`

Memoized. Creates and connects an MCP client for any transport type. Returns a discriminated union: `connected`, `failed`, or `needs-auth`.

> Source: `src/services/mcp/client.ts:595-1641`

### `ensureConnectedClient(client: ConnectedMCPServer): Promise<ConnectedMCPServer>`

Ensures a valid connection exists, reconnecting transparently if the cache was cleared. SDK servers are returned as-is.

> Source: `src/services/mcp/client.ts:1688-1704`

### `clearServerCache(name: string, serverRef: ScopedMcpServerConfig): Promise<void>`

Cleans up a server connection and invalidates all caches (connection + tools/resources/commands/skills).

> Source: `src/services/mcp/client.ts:1648-1673`

### `getMcpToolsCommandsAndResources(onConnectionAttempt, mcpConfigs?): Promise<void>`

Connects to all configured MCP servers in batches and calls `onConnectionAttempt` for each with the resulting client, tools, commands, and resources.

> Source: `src/services/mcp/client.ts:2226-2403`

### `fetchToolsForClient(client: MCPServerConnection): Promise<Tool[]>`

LRU-cached. Fetches tools from a connected server and converts them to the internal `Tool` format with MCP-specific overrides (permission checks, progress reporting, annotations).

> Source: `src/services/mcp/client.ts:1743-1998`

### `fetchResourcesForClient(client: MCPServerConnection): Promise<ServerResource[]>`

LRU-cached. Fetches resources from a connected server, tagging each with the server name.

> Source: `src/services/mcp/client.ts:2000-2031`

### `fetchCommandsForClient(client: MCPServerConnection): Promise<Command[]>`

LRU-cached. Fetches prompts from a connected server and converts them to slash commands.

> Source: `src/services/mcp/client.ts:2033-2107`

### `setupSdkMcpClients(sdkMcpConfigs, sendMcpMessage): Promise<{clients, tools}>`

Connects SDK MCP servers that run in-process via `SdkControlClientTransport`.

> Source: `src/services/mcp/client.ts:3262-3348`

### `reconnectMcpServerImpl(name, config): Promise<{client, tools, commands, resources?}>`

Clears keychain cache, disconnects, reconnects, and re-fetches all resources for a single server. Used by the UI reconnection flow.

> Source: `src/services/mcp/client.ts:2137-2210`

### `prefetchAllMcpResources(mcpConfigs): Promise<{clients, tools, commands}>`

Connects to all servers in the given config map and aggregates results. Not memoized (inner calls are cached). Used at startup/reconfig.

> Source: `src/services/mcp/client.ts:2408-2473`

### `callMCPToolWithUrlElicitationRetry({client, tool, args, ...}): Promise<MCPToolCallResult>`

Wraps tool calls with URL elicitation handling (error code `-32042`). Supports hooks, print/SDK mode delegation, and REPL mode queuing.

> Source: `src/services/mcp/client.ts:2813-3027`

### `wrapFetchWithTimeout(baseFetch: FetchLike): FetchLike`

Wraps a fetch function with a 60s per-request timeout for POST requests. GET requests (long-lived SSE streams) are exempt. Also normalizes the MCP Streamable HTTP `Accept` header.

> Source: `src/services/mcp/client.ts:492-550`

### `createClaudeAiProxyFetch(innerFetch: FetchLike): FetchLike`

Fetch wrapper for claude.ai proxy connections. Attaches OAuth bearer token and retries once on 401 via `handleOAuth401Error`.

> Source: `src/services/mcp/client.ts:372-422`

### `areMcpConfigsEqual(a, b): boolean`

Compares two MCP server configurations by serializing (excluding `scope`). Used to detect config changes requiring reconnection.

> Source: `src/services/mcp/client.ts:1710-1722`

---

## Interface/Type Definitions

### Transport Types (from `types.ts`)

| Transport | Schema | Description |
|-----------|--------|-------------|
| `stdio` | `McpStdioServerConfigSchema` | Local subprocess via stdin/stdout. Fields: `command`, `args`, `env` |
| `sse` | `McpSSEServerConfigSchema` | Server-Sent Events (remote). Fields: `url`, `headers`, `headersHelper`, `oauth` |
| `sse-ide` | `McpSSEIDEServerConfigSchema` | SSE for IDE extensions (internal). Fields: `url`, `ideName` |
| `ws-ide` | `McpWebSocketIDEServerConfigSchema` | WebSocket for IDE extensions. Fields: `url`, `ideName`, `authToken` |
| `http` | `McpHTTPServerConfigSchema` | Streamable HTTP (MCP 2025-03-26 spec). Fields: `url`, `headers`, `headersHelper`, `oauth` |
| `ws` | `McpWebSocketServerConfigSchema` | WebSocket. Fields: `url`, `headers`, `headersHelper` |
| `sdk` | `McpSdkServerConfigSchema` | In-process SDK control channel. Fields: `name` |
| `claudeai-proxy` | `McpClaudeAIProxyServerConfigSchema` | Claude.ai proxy. Fields: `url`, `id` |

> Source: `src/services/mcp/types.ts:28-135`

### Config Scope (`types.ts:10-20`)

`local | user | project | dynamic | enterprise | claudeai | managed` — determines where the server config originated.

### Connection State Union (`types.ts:221-226`)

```typescript
type MCPServerConnection =
  | ConnectedMCPServer   // Active connection with client, capabilities, cleanup
  | FailedMCPServer      // Connection failed, carries error message
  | NeedsAuthMCPServer   // Server requires OAuth authentication
  | PendingMCPServer     // Connection in progress (with reconnect attempt tracking)
  | DisabledMCPServer    // Explicitly disabled by user
```

### `ConnectedMCPServer` (`types.ts:180-192`)

```typescript
type ConnectedMCPServer = {
  client: Client          // MCP SDK Client instance
  name: string
  type: 'connected'
  capabilities: ServerCapabilities
  serverInfo?: { name: string; version: string }
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}
```

### `ScopedMcpServerConfig` (`types.ts:163-169`)

Extends `McpServerConfig` with `scope: ConfigScope` and optional `pluginSource` (for plugin-provided servers).

### `MCPCliState` (`types.ts:252-258`)

Serialization type for transferring MCP state to CLI consumers: `clients`, `configs`, `tools`, `resources`, and `normalizedNames`.

### Custom Error Classes (`client.ts:152-186`)

- **`McpAuthError`**: Thrown on 401 during tool calls; carries `serverName` to trigger re-auth flow
- **`McpSessionExpiredError`**: Thrown when session is invalid (404 + `-32001`); triggers retry with fresh connection
- **`McpToolCallError`**: Thrown when MCP tool returns `isError: true`; carries `_meta` for SDK consumers

---

## Configuration & Defaults

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| Connection timeout | `MCP_TIMEOUT` env var | 30,000 ms | Max time to establish a connection |
| Tool call timeout | `MCP_TOOL_TIMEOUT` env var | ~27.8 hours (100,000,000 ms) | Max time for a single tool call |
| Request timeout | Hardcoded | 60,000 ms | Per-HTTP-request timeout (POST only; GET is exempt for long-lived SSE) |
| Local batch size | `MCP_SERVER_CONNECTION_BATCH_SIZE` env var | 3 | Max concurrent local (stdio/sdk) connections |
| Remote batch size | `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` env var | 20 | Max concurrent remote connections |
| Auth cache TTL | Hardcoded | 15 minutes | How long a `needs-auth` status is cached to avoid re-probing |
| Description cap | Hardcoded | 2,048 chars | Max length for tool descriptions and server instructions sent to the model |
| Fetch cache size | Hardcoded | 20 entries | LRU cache limit for `fetchToolsForClient`, `fetchResourcesForClient`, `fetchCommandsForClient` |
| Max reconnect errors | Hardcoded | 3 | Consecutive terminal errors before triggering reconnection |
| Shell prefix | `CLAUDE_CODE_SHELL_PREFIX` env var | unset | Wraps stdio server commands (e.g., for Docker execution) |
| SDK no prefix | `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` env var | unset | When truthy, SDK MCP tools skip the `mcp__` name prefix |

---

## Edge Cases & Caveats

- **Memoization of `connectToServer`**: The connection function is memoized by `name + JSON(config)`. The `onclose` handler invalidates this cache, which is what triggers transparent reconnection on the next call. The TODO at line 589 notes this adds complexity and may not improve performance.

- **SSE streams exempt from timeout**: The `wrapFetchWithTimeout` wrapper (`client.ts:492-550`) deliberately skips GET requests because MCP SSE connections are long-lived streams. Only POST requests get the 60s timeout.

- **Auth cache prevents probe storms**: Remote servers that return 401 are cached for 15 minutes (`mcp-needs-auth-cache.json`). Additionally, servers with OAuth discovery metadata but no stored token are skipped entirely (closing the gap the TTL leaves open). This prevents expensive re-probing on every startup.

- **Stdio process cleanup uses signal escalation**: SIGINT → wait 100ms → SIGTERM → wait 400ms → SIGKILL, with a 600ms absolute failsafe. This handles Docker containers and other servers that need explicit signals (`client.ts:1429-1562`).

- **Claude.ai proxy 401 retry**: `createClaudeAiProxyFetch` (`client.ts:372-422`) retries once on 401 using `handleOAuth401Error` to handle token staleness from memoize-cache or clock drift. Without this, a stale token would mass-401 every claude.ai connector.

- **IDE tools are filtered**: Only `mcp__ide__executeCode` and `mcp__ide__getDiagnostics` are included from IDE servers (`client.ts:568-573`).

- **Session expiry detection**: Checks for both HTTP 404 status and JSON-RPC error code `-32001` to avoid false positives from generic 404s (`client.ts:193-206`). During tool calls, also handles the indirect `-32000 Connection closed` error that surfaces when the SDK closes the transport before the pending `callTool()` rejects.

- **Large output handling**: Results exceeding the token limit are persisted to disk files (unless they contain images, which are truncated instead to preserve viewability). The model receives instructions on how to read specific portions via the Read tool (`client.ts:2720-2799`).

- **In-process servers**: Chrome MCP and Computer Use servers run in-process via `createLinkedTransportPair` to avoid spawning heavyweight subprocesses (~325 MB for Chrome) (`client.ts:905-943`).

- **Auth cache write serialization**: Concurrent 401 responses from multiple servers serialize their cache writes through a promise chain (`writeChain`) to prevent read-modify-write races on `mcp-needs-auth-cache.json` (`client.ts:291-309`).

## Key Code Snippets

### Transport selection and client creation

```typescript
// src/services/mcp/client.ts:985-1002
const client = new Client(
  {
    name: 'claude-code',
    title: 'Claude Code',
    version: MACRO.VERSION ?? 'unknown',
    description: "Anthropic's agentic coding tool",
    websiteUrl: PRODUCT_URL,
  },
  {
    capabilities: {
      roots: {},
      elicitation: {},
    },
  },
)
```

### Connection drop detection with error counting

```typescript
// src/services/mcp/client.ts:1350-1364
if (isTerminalConnectionError(error.message)) {
  consecutiveConnectionErrors++
  logMCPDebug(
    name,
    `Terminal connection error ${consecutiveConnectionErrors}/${MAX_ERRORS_BEFORE_RECONNECT}`,
  )
  if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
    consecutiveConnectionErrors = 0
    closeTransportAndRejectPending('max consecutive terminal errors')
  }
}
```

### Batch processing with split concurrency

```typescript
// src/services/mcp/client.ts:2391-2402
await Promise.all([
  processBatched(
    localServers,
    getMcpServerConnectionBatchSize(),      // default 3
    processServer,
  ),
  processBatched(
    remoteServers,
    getRemoteMcpServerConnectionBatchSize(), // default 20
    processServer,
  ),
])
```