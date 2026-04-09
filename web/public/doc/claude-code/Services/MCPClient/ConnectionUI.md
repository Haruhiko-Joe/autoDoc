# ConnectionUI

## Overview & Responsibilities

ConnectionUI is the React-level MCP (Model Context Protocol) connection management layer within the **Services → MCPClient** module. It bridges the lower-level MCP client infrastructure and the React component tree by:

- **Initializing** MCP server connections on mount based on configuration (Claude Code configs, dynamic configs, claude.ai configs)
- **Tracking** connection state in `AppState` (pending, connected, failed, disabled, needs-auth)
- **Automatically reconnecting** remote transports (SSE, HTTP, WebSocket) with exponential backoff when connections drop
- **Exposing** `reconnectMcpServer` and `toggleMcpServer` functions to the component tree via React context
- **Batching** state updates to avoid excessive re-renders when multiple servers connect in quick succession
- **Registering** MCP notification handlers for dynamic tool/prompt/resource list changes and channel messages

The module consists of two files:
- `useManageMCPConnections.ts` — the core hook containing all connection lifecycle logic
- `MCPConnectionManager.tsx` — a thin React context provider that wraps the hook's output for consumption by child components

## Key Processes

### Server Initialization Flow

When the component mounts (or when `sessionId`, `authVersion`, or `pluginReconnectKey` changes), a two-phase initialization runs:

1. **Phase 1 — Claude Code configs** (`src/services/mcp/useManageMCPConnections.ts:858-902`): Loads local MCP server configs via `getClaudeCodeMcpConfigs()` (merging project, user, enterprise, and dynamic/plugin configs). All discovered servers are set to `'pending'` state in `AppState`. Enabled servers are immediately handed to `getMcpToolsCommandsAndResources()` which begins connecting concurrently.

2. **Phase 2 — claude.ai configs** (`src/services/mcp/useManageMCPConnections.ts:904-963`): Concurrently fetches remote claude.ai MCP configs via `fetchClaudeAIMcpConfigsIfEligible()`. These are deduplicated against local configs (by URL signature, not just name) using `dedupClaudeAiMcpServers()`, then added as pending and connected. Skipped entirely when `isStrictMcpConfig` is true or enterprise MCP config exists.

Before Phase 1, a separate `useEffect` (`src/services/mcp/useManageMCPConnections.ts:772-854`) pre-populates all servers as `'pending'` or `'disabled'` in `AppState`, and cleans up stale plugin servers that no longer appear in config.

### Connection Attempt Handling

The `onConnectionAttempt` callback (`src/services/mcp/useManageMCPConnections.ts:310-763`) is invoked each time a server connection resolves. Based on the connection type:

- **`connected`**: Registers the elicitation handler, sets up an `onclose` callback for automatic reconnection, registers MCP `list_changed` notification handlers (tools, prompts, resources), and optionally registers channel notification handlers (feature-gated behind `KAIROS`/`KAIROS_CHANNELS`).
- **`needs-auth` / `failed` / `pending` / `disabled`**: State is updated but no handlers are registered.

### Automatic Reconnection with Exponential Backoff

When a connected remote server (SSE, HTTP, WebSocket — not stdio or SDK) disconnects via `onclose` (`src/services/mcp/useManageMCPConnections.ts:333-467`):

1. Checks if the server has been disabled on disk — if so, skips reconnection
2. Cancels any existing reconnection timer for this server
3. Enters a retry loop with up to `MAX_RECONNECT_ATTEMPTS` (5) attempts
4. Each attempt sets the server to `'pending'` state with `reconnectAttempt` / `maxReconnectAttempts` metadata (for UI progress display)
5. On success, calls `onConnectionAttempt` to re-register handlers
6. On failure after max attempts, marks the server as `'failed'`
7. Backoff timing: starts at `INITIAL_BACKOFF_MS` (1000ms), doubles each attempt, capped at `MAX_BACKOFF_MS` (30000ms)

### Batched State Updates

To avoid excessive React re-renders when multiple MCP servers report state changes in rapid succession, updates are batched (`src/services/mcp/useManageMCPConnections.ts:203-308`):

1. `updateServer()` pushes each update into `pendingUpdatesRef`
2. A `setTimeout` with `MCP_BATCH_FLUSH_MS` (16ms) coalesces updates
3. `flushPendingUpdates()` applies all queued updates in a single `setAppState` call, merging clients, tools, commands, and resources

For each update, tools/commands/resources belonging to the updated server are replaced (matched by MCP prefix for tools, by `commandBelongsToServer` for commands, by server name key for resources). When a server is `disabled` or `failed`, tools/commands/resources default to empty arrays.

### MCP List Changed Notifications

Once connected, the hook registers handlers for three MCP SDK notification types:

- **`tools/list_changed`** (`src/services/mcp/useManageMCPConnections.ts:618-664`): Invalidates the tool cache, re-fetches tools, and updates AppState
- **`prompts/list_changed`** (`src/services/mcp/useManageMCPConnections.ts:667-703`): Invalidates prompt and skill caches, re-fetches both, clears the skill search index
- **`resources/list_changed`** (`src/services/mcp/useManageMCPConnections.ts:705-751`): Invalidates resource and skill caches, re-fetches all, clears the skill search index

### Enable/Disable Toggle

`toggleMcpServer` (`src/services/mcp/useManageMCPConnections.ts:1074-1126`) handles bidirectional toggling:

- **Disabling**: Persists disabled state to disk first (via `setMcpServerEnabled`), then clears the server cache if connected, cancels pending reconnection timers, and sets state to `'disabled'` (which auto-clears tools/commands/resources)
- **Enabling**: Persists enabled state to disk, sets state to `'pending'`, then reconnects and processes the connection result

### React Context Provider

`MCPConnectionManager` (`src/services/mcp/MCPConnectionManager.tsx:38-72`) is a thin wrapper that:

1. Accepts `children`, `dynamicMcpConfig`, and `isStrictMcpConfig` as props
2. Calls `useManageMCPConnections(dynamicMcpConfig, isStrictMcpConfig)` to get `reconnectMcpServer` and `toggleMcpServer`
3. Memoizes these into a context value object (using React Compiler's memoization cache `_c`)
4. Provides the value via `MCPConnectionContext.Provider`

Two consumer hooks extract individual functions from the context:
- `useMcpReconnect()` returns `reconnectMcpServer`
- `useMcpToggleEnabled()` returns `toggleMcpServer`

Both throw if called outside the provider.

## Function Signatures

### `useManageMCPConnections(dynamicMcpConfig, isStrictMcpConfig)`

The core hook that manages all MCP server connection lifecycle.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `dynamicMcpConfig` | `Record<string, ScopedMcpServerConfig> \| undefined` | — | Dynamic MCP server configs (e.g., from `--mcp-config` CLI flag) |
| `isStrictMcpConfig` | `boolean` | `false` | When true, only uses `dynamicMcpConfig` and skips loading Claude Code and claude.ai configs |

**Returns**: `{ reconnectMcpServer, toggleMcpServer }`

- `reconnectMcpServer(serverName: string)` — Reconnects a specific server by name. Cancels any pending auto-reconnect. Returns `{ client, tools, commands, resources }`. Throws if the server name is not found in AppState.
- `toggleMcpServer(serverName: string)` — Toggles a server between enabled and disabled. Persists state to disk, disconnects/reconnects as needed. Throws if the server name is not found.

> Source: `src/services/mcp/useManageMCPConnections.ts:143-1128`

### `MCPConnectionManager({ children, dynamicMcpConfig, isStrictMcpConfig })`

React context provider component that wraps `useManageMCPConnections` and exposes its return values to the component tree.

| Prop | Type | Description |
|------|------|-------------|
| `children` | `ReactNode` | Child components that can consume the context |
| `dynamicMcpConfig` | `Record<string, ScopedMcpServerConfig> \| undefined` | Passed through to `useManageMCPConnections` |
| `isStrictMcpConfig` | `boolean` | Passed through to `useManageMCPConnections` |

> Source: `src/services/mcp/MCPConnectionManager.tsx:38-72`

### `useMcpReconnect()`

Consumer hook that returns the `reconnectMcpServer` function from context. Throws if called outside `MCPConnectionManager`.

> Source: `src/services/mcp/MCPConnectionManager.tsx:17-23`

### `useMcpToggleEnabled()`

Consumer hook that returns the `toggleMcpServer` function from context. Throws if called outside `MCPConnectionManager`.

> Source: `src/services/mcp/MCPConnectionManager.tsx:24-30`

## Interface/Type Definitions

### `MCPConnectionContextValue`

The shape of the React context value:

```typescript
interface MCPConnectionContextValue {
  reconnectMcpServer: (serverName: string) => Promise<{
    client: MCPServerConnection;
    tools: Tool[];
    commands: Command[];
    resources?: ServerResource[];
  }>;
  toggleMcpServer: (serverName: string) => Promise<void>;
}
```

> Source: `src/services/mcp/MCPConnectionManager.tsx:7-15`

### `MCPConnectionManagerProps`

```typescript
interface MCPConnectionManagerProps {
  children: ReactNode;
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined;
  isStrictMcpConfig: boolean;
}
```

> Source: `src/services/mcp/MCPConnectionManager.tsx:31-35`

### `PendingUpdate` (internal)

Used by the batched update system — an `MCPServerConnection` extended with optional `tools`, `commands`, and `resources` arrays.

> Source: `src/services/mcp/useManageMCPConnections.ts:208-212`

## Configuration & Defaults

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_RECONNECT_ATTEMPTS` | `5` | Maximum automatic reconnection attempts before giving up |
| `INITIAL_BACKOFF_MS` | `1000` | Initial delay before first reconnection retry |
| `MAX_BACKOFF_MS` | `30000` | Maximum backoff delay (caps exponential growth) |
| `MCP_BATCH_FLUSH_MS` | `16` | Batching window for state updates (~1 frame) |

Feature gates that affect behavior:
- `MCP_SKILLS` — enables skill discovery from MCP resources
- `EXPERIMENTAL_SKILL_SEARCH` — enables skill search index invalidation
- `KAIROS` / `KAIROS_CHANNELS` — enables channel notification handling and permission relay

## Edge Cases & Caveats

- **Disabled server detection during reconnect**: The `onclose` handler checks `isMcpServerDisabled()` from disk rather than from AppState, because AppState may be stale in the closure. This is acknowledged as a design trade-off (`src/services/mcp/useManageMCPConnections.ts:342-346`).
- **stdio/SDK servers don't auto-reconnect**: Only remote transports (SSE, HTTP, WebSocket) support automatic reconnection. Local process (`stdio`) and internal (`sdk`) transports are marked as `'failed'` on close.
- **Stale plugin cleanup**: When `pluginReconnectKey` changes (triggered by `/reload-plugins`), the initialization effect disconnects plugin MCP servers that no longer appear in config, preventing ghost tools from disabled plugins. Stale connected servers have their `onclose` nulled before cleanup to prevent the old closure from racing with the fresh connection (`src/services/mcp/useManageMCPConnections.ts:802-812`).
- **claude.ai dedup**: Claude.ai connectors that duplicate an existing local server (by URL signature, not name) are suppressed. This prevents double-connections to the same backend.
- **Two-phase loading**: Claude Code configs connect immediately, while claude.ai configs are fetched asynchronously. This means local servers appear faster in the UI; remote claude.ai servers may appear moments later.
- **Channel notification handlers are idempotent**: Re-gating (e.g., after `/logout`) removes previously registered channel handlers to prevent stale handlers from continuing to enqueue messages.
- **Disk-first persistence for toggle**: `toggleMcpServer` writes enabled/disabled state to disk before updating AppState, because the `onclose` handler reads from disk to decide whether to reconnect.
- **Cleanup on unmount**: The cleanup effect (`src/services/mcp/useManageMCPConnections.ts:1027-1041`) clears all reconnection timers and flushes any pending batched updates to prevent state leaks.