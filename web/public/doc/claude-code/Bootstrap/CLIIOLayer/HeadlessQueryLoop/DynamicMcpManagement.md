# Dynamic MCP Management

## Overview & Responsibilities

This module handles the **lifecycle management of dynamically added and SDK-injected MCP (Model Context Protocol) servers** within the headless (non-interactive) execution path. It lives in `src/cli/print.ts` as part of the `CLIIOLayer > HeadlessQueryLoop` layer, which drives query execution for SDK, piped, and bridge sessions.

Within the broader architecture, the **Bootstrap > CLIIOLayer > HeadlessQueryLoop** path is the non-interactive counterpart to the Ink-based REPL. While the REPL uses `useManageMCPConnections` hooks for MCP lifecycle, this module provides equivalent functionality for headless mode — processing `mcp_set_servers` control requests from SDK consumers, reconciling server state, managing SDK MCP client upgrades, handling MCP elicitation flows, and re-registering channel notification handlers after reconnects.

**Sibling modules** include the `StructuredIOLayer` (NDJSON message framing and control protocol), `Transports` (WebSocket/SSE/CCR communication), and `Utilities` (serialization helpers).

## Key Processes

### `mcp_set_servers` Control Request Flow

When an SDK consumer sends an `mcp_set_servers` control message, `handleMcpSetServers` orchestrates the full reconciliation:

1. **Enterprise policy enforcement** — Calls `filterMcpServersByPolicy()` to apply `allowedMcpServers`/`deniedMcpServers` enterprise policy. Blocked servers are reported in `response.errors` so the SDK caller knows why they were rejected. This mirrors the `--mcp-config` filter in `main.tsx` to prevent a policy bypass vector (`src/cli/print.ts:5359-5369`).

2. **Server classification** — Incoming configs are split into two categories:
   - **SDK servers** (`type === 'sdk'`): Run in the SDK process, managed by `SdkControlClientTransport`
   - **Process-transport servers** (stdio/http/sse): Spawned and connected by the CLI itself

3. **SDK server diffing** — Compares current `SdkMcpState.configs` against the desired SDK servers:
   - **Removed servers**: Calls `client.cleanup()` on connected clients, filters out associated tools (matching the `mcp__<name>__` prefix), and removes configs
   - **New servers**: Added as `pending` clients with `scope: 'dynamic'` — they are upgraded to `connected` when `updateSdkMcp()` runs on the next query turn (`src/cli/print.ts:5408-5421`)

4. **Process-transport reconciliation** — Delegates to `reconcileMcpServers()` for the remaining servers

5. **Result aggregation** — Merges SDK and process-transport results into a single `McpSetServersResult` containing `added`, `removed`, `errors`, and updated state objects

### Process-Transport Reconciliation (`reconcileMcpServers`)

This function performs low-level diffing and connection management for process-transport MCP servers (`src/cli/print.ts:5450-5594`):

1. **Three-way diff** — Categorizes servers into:
   - `toRemove`: present in current state but absent from desired
   - `toAdd`: present in desired but absent from current
   - `toReplace`: present in both but with different configs (detected via `areMcpConfigsEqual`)

2. **Teardown** — For removed and replaced servers:
   - Calls `client.cleanup()` on connected clients
   - Clears the memoization cache via `clearServerCache()`
   - Removes tools matching the `mcp__<name>__` prefix
   - Removes the client from the clients list

3. **Connection** — For added and replaced servers:
   - Calls `connectToServer(name, scopedConfig)` to spawn/connect
   - On success (`type === 'connected'`): fetches tools via `fetchToolsForClient()`
   - On failure (`type === 'failed'`): records the error message
   - Uncaught exceptions are caught, logged, and added to `errors`

4. **AppState update** — Atomically updates the shared `AppState.mcp` by removing stale dynamic tools/clients and inserting new ones, ensuring subagents see the updated tool pool (`src/cli/print.ts:5558-5588`)

### SDK MCP Client Lifecycle (`updateSdkMcp`)

The `updateSdkMcp` function (`src/cli/print.ts:1389-1459`) runs before each query turn to upgrade pending SDK clients:

1. **Change detection** — Checks for any of four conditions:
   - New servers added to `sdkMcpConfigs` not yet in `sdkClients`
   - Servers in `sdkClients` no longer in `sdkMcpConfigs`
   - Pending clients needing upgrade to connected
   - Failed clients needing retry (e.g., handshake timeout on WebSocket reconnect race)

2. **Cleanup** — Calls `cleanup()` on clients whose names are no longer in the current config set

3. **Re-initialization** — Calls `setupSdkMcpClients()` with current configs and a message callback routed through `structuredIO.sendMcpMessage()`

4. **AppState sync** — Removes stale SDK tools (matching any old or new server name prefix) and inserts fresh tools, so subagents can access them via `assembleToolPool`

5. **VSCode integration** — Calls `setupVscodeSdkMcp()` to configure the special internal VSCode MCP server if applicable

### Elicitation Handler Registration (`registerElicitationHandlers`)

Registers MCP elicitation request/completion handlers on connected clients (`src/cli/print.ts:1263-1387`):

1. **Filtering** — Skips non-connected clients, already-registered clients, and SDK servers (which route elicitation through `SdkControlClientTransport`)

2. **Request handler** (`ElicitRequestSchema`):
   - Determines mode (`url` or `form`) from the request
   - Runs elicitation hooks first (`runElicitationHooks`) — hooks can provide a response programmatically, matching REPL behavior
   - If no hook responds, delegates to the SDK consumer via `structuredIO.handleElicitation()` using the control protocol
   - Runs result hooks (`runElicitationResultHooks`) on the response before returning
   - Logs analytics events at both the request and response stages

3. **Completion notification handler** (`ElicitationCompleteNotificationSchema`):
   - Surfaces URL-mode completion notifications to SDK consumers
   - Executes notification hooks and enqueues a `system/elicitation_complete` event to the output stream

### Channel Handler Re-registration (`reregisterChannelHandlerAfterReconnect`)

Re-registers `notifications/claude/channel` handlers on MCP servers after transport reconnects (`src/cli/print.ts:4786-4835`):

1. **Feature gate** — Early-returns if neither `KAIROS` nor `KAIROS_CHANNELS` feature flags are enabled
2. **Channel gating** — Calls `gateChannelServer()` to check if this server is channel-enabled; no-op if not
3. **Handler setup** — Registers a `ChannelMessageNotificationSchema` handler that:
   - Logs the message and analytics event (content length, meta keys, plugin ID)
   - Enqueues the channel message as a high-priority prompt via `wrapChannelMessage()`

This mirrors the interactive CLI's `onConnectionAttempt` in `useManageMCPConnections`.

## Type Definitions

### `DynamicMcpState`

Tracks the state of dynamically added process-transport MCP servers (`src/cli/print.ts:5306-5310`):

| Field | Type | Description |
|-------|------|-------------|
| `clients` | `MCPServerConnection[]` | Active MCP client connections |
| `tools` | `Tools` | Tools discovered from connected servers |
| `configs` | `Record<string, ScopedMcpServerConfig>` | Server configs keyed by name |

### `SdkMcpState`

Tracks the state of SDK-managed MCP servers (`src/cli/print.ts:5328-5332`):

| Field | Type | Description |
|-------|------|-------------|
| `configs` | `Record<string, McpSdkServerConfig>` | SDK server configs keyed by name |
| `clients` | `MCPServerConnection[]` | SDK MCP client connections |
| `tools` | `Tools` | Tools from SDK servers |

### `McpSetServersResult`

Return type of `handleMcpSetServers` (`src/cli/print.ts:5337-5342`):

| Field | Type | Description |
|-------|------|-------------|
| `response` | `SDKControlMcpSetServersResponse` | Lists `added`, `removed`, and `errors` |
| `newSdkState` | `SdkMcpState` | Updated SDK MCP state |
| `newDynamicState` | `DynamicMcpState` | Updated dynamic (process-transport) state |
| `sdkServersChanged` | `boolean` | Whether SDK servers were added or removed |

## Function Signatures

### `handleMcpSetServers(servers, sdkState, dynamicState, setAppState): Promise<McpSetServersResult>`

Top-level handler for `mcp_set_servers` control requests. Enforces enterprise policy, separates SDK from process-transport servers, diffs and reconciles both, and returns the combined result.

> Source: `src/cli/print.ts:5353-5444`

### `reconcileMcpServers(desiredConfigs, currentState, setAppState): Promise<{ response, newState }>`

Low-level reconciliation for process-transport MCP servers. Diffs current vs desired state, connects new servers, disconnects removed ones, handles config changes via replace, and updates `AppState`.

> Source: `src/cli/print.ts:5450-5594`

### `updateSdkMcp(): Promise<void>`

Lifecycle function for SDK MCP clients. Detects pending/failed/added/removed servers, reinitializes via `setupSdkMcpClients()`, and syncs tools into `AppState`. Called before each query turn.

> Source: `src/cli/print.ts:1389-1459`

### `registerElicitationHandlers(clients: MCPServerConnection[]): void`

Registers `ElicitRequestSchema` and `ElicitationCompleteNotificationSchema` handlers on connected non-SDK MCP clients. Routes through hooks first, then falls back to the SDK control protocol.

> Source: `src/cli/print.ts:1263-1387`

### `reregisterChannelHandlerAfterReconnect(connection: MCPServerConnection): void`

Re-registers channel notification handlers after a transport reconnect. Feature-gated behind `KAIROS`/`KAIROS_CHANNELS`. No-op for non-channel servers.

> Source: `src/cli/print.ts:4786-4835`

### `toScopedConfig(config: McpServerConfigForProcessTransport): ScopedMcpServerConfig`

Helper that converts a process-transport config to a scoped config by adding `scope: 'dynamic'`. The types are structurally compatible.

> Source: `src/cli/print.ts:5316-5323`

## Edge Cases & Caveats

- **Enterprise policy bypass prevention**: Both the `--mcp-config` path (in `main.tsx`) and `mcp_set_servers` apply `filterMcpServersByPolicy`. Without this, SDK V2 `Query.setMcpServers()` would be a second policy bypass vector. Blocked servers appear in `response.errors`.

- **Pending-to-connected upgrade**: New SDK servers are initially added as `pending` clients. They are only upgraded to `connected` when `updateSdkMcp()` runs on the next query turn, not immediately upon `handleMcpSetServers`.

- **Failed client retry**: `updateSdkMcp` explicitly checks for `failed` clients. Without this, a client that fails its handshake (e.g., during a WebSocket reconnect race) would stay failed forever, contributing zero tools despite its name satisfying the diff check.

- **Config change detection**: `reconcileMcpServers` detects config changes via `areMcpConfigsEqual()`. Changed servers are treated as remove-then-add (replace), ensuring the old connection is fully cleaned up before a new one is established.

- **Tool naming convention**: All MCP tools use the `mcp__<serverName>__` prefix. This convention is critical for cleanup — when a server is removed, all tools matching this prefix are filtered out.

- **Elicitation handler idempotency**: The `elicitationRegistered` set prevents double-registration. SDK servers are skipped because their elicitation flows through `SdkControlClientTransport` instead.

- **Channel re-registration cost**: For non-channel servers, `reregisterChannelHandlerAfterReconnect` is a cheap no-op — `gateChannelServer` calls `findChannelEntry` internally and returns `skip`/`session` for unlisted servers, costing only one feature-flag check.