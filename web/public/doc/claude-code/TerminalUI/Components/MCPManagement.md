# MCP Management

## Overview & Responsibilities

The MCP Management module is the complete UI layer for configuring and interacting with MCP (Model Context Protocol) servers within Claude Code's terminal interface. It lives under `src/components/mcp/` with several companion dialogs at the root `src/components/` level, and sits within the **Components** layer of the **TerminalUI** system.

This module provides:

- A settings panel (`MCPSettings`) that acts as a state-machine router for all MCP views
- A server list browser (`MCPListPanel`) grouped by configuration scope
- Per-server management menus for stdio, remote (SSE/HTTP/Claude AI proxy), and agent-defined servers
- Tool inspection views for browsing and examining individual MCP tools
- Approval and import dialogs for project-level `.mcp.json` servers and Claude Desktop imports
- An elicitation dialog for MCP server-initiated prompts (form fields and URL flows)
- Reconnection UI and helpers
- Configuration parsing warning display
- An LSP plugin recommendation menu (tangentially related, under `LspRecommendation/`)

## Key Processes

### MCPSettings View State Machine

`MCPSettings` (`src/components/mcp/MCPSettings.tsx:21`) is the top-level component that orchestrates all MCP sub-views through a `viewState` state machine. It reads MCP client connections and agent definitions from `useAppState`, prepares `ServerInfo` objects (including authentication status for remote servers), and then renders the appropriate sub-component based on the current state:

1. **`list`** → renders `MCPListPanel` — the default view showing all servers grouped by scope
2. **`server-menu`** → renders either `MCPStdioServerMenu` (for stdio transport) or `MCPRemoteServerMenu` (for SSE/HTTP/Claude AI proxy)
3. **`server-tools`** → renders `MCPToolListView` — lists all tools for a specific server
4. **`server-tool-detail`** → renders `MCPToolDetailView` — shows details of a single tool
5. **`agent-server-menu`** → renders `MCPAgentServerMenu` — management for agent-defined servers

When no servers are configured and none are loading, it exits immediately with a help message directing users to `/doctor` or the MCP documentation.

### Server List & Scope Grouping

`MCPListPanel` (`src/components/mcp/MCPListPanel.tsx:92`) displays all configured MCP servers in a navigable list. The rendering has two distinct parts:

**Scope-ordered servers** are iterated via the `SCOPE_ORDER` constant (`src/components/mcp/MCPListPanel.tsx:37`), which covers only the four user-configurable scopes:

```typescript
const SCOPE_ORDER: ConfigScope[] = ['project', 'local', 'user', 'enterprise'];
```

For each scope, servers are grouped via `groupServersByScope()` and sorted alphabetically within each group. Each group heading shows the scope label and the config file path (e.g., "Project MCPs — .mcp.json").

**Separately rendered categories** are appended after the scope-ordered servers in this order:
1. **Claude AI proxy** servers — filtered from the server list by `transport === "claudeai-proxy"`
2. **Agent servers** — from agent definitions, not part of the regular server list
3. **Dynamic/Built-in** servers — from the `dynamic` scope, rendered last with heading "Built-in MCPs — always available"

This means the final display order is: Project → Local → User → Enterprise → Claude AI → Agent → Dynamic, but only the first four are driven by `SCOPE_ORDER`; the remaining three are hardcoded in separate rendering blocks (`src/components/mcp/MCPListPanel.tsx:149-177`).

The panel uses keyboard navigation (up/down/enter/escape) via `useKeybindings` and also displays any MCP config parsing warnings via `McpParsingWarnings`.

### Server Authentication Flow (Remote Servers)

`MCPRemoteServerMenu` (`src/components/mcp/MCPRemoteServerMenu.tsx:41`) handles SSE, HTTP, and Claude AI proxy server management. The authentication flow differs by server type:

**Standard OAuth (SSE/HTTP):**
1. User selects "Authenticate" from the menu
2. Component calls `performMCPOAuthFlow()`, which opens a browser for OAuth
3. An authorization URL is displayed as a fallback if the browser doesn't open
4. User can press `c` to copy the URL to clipboard
5. On success, the server is reconnected and tools become available

**Claude AI Proxy:**
1. User selects "Connect to claude.ai"
2. Component constructs an OAuth URL using `getOauthConfig().CLAUDE_AI_ORIGIN` and account info
3. Browser opens for authentication
4. On return, user presses Enter, and the server reconnects

**Cleanup on unmount:** The component aborts any in-progress OAuth flow via `AbortController` when unmounted (`src/components/mcp/MCPRemoteServerMenu.tsx:79-85`), preventing dangling callback servers.

### Reconnection

Two components handle reconnection:

- **`MCPReconnect`** (`src/components/mcp/MCPReconnect.tsx:15`) — a standalone component for the `/mcp reconnect <name>` command. It looks up the server in app state, calls `reconnectMcpServer()`, and reports the outcome (connected, needs-auth, failed).
- **Inline reconnection** in server menus — both `MCPStdioServerMenu` and `MCPRemoteServerMenu` offer a "Reconnect" menu option that triggers reconnection inline with a spinner.

The `reconnectHelpers.tsx` utility (`src/components/mcp/utils/reconnectHelpers.tsx:12-48`) provides two pure functions:
- `handleReconnectResult()` — maps connection state (`connected`, `needs-auth`, `failed`) to user messages
- `handleReconnectError()` — formats error objects into user-friendly strings

### MCP Server Approval Flow

When new servers are discovered in a project's `.mcp.json`, approval dialogs are shown:

- **`MCPServerApprovalDialog`** (`src/components/MCPServerApprovalDialog.tsx:12`) — for a single new server. Offers three choices:
  - "Use this and all future MCP servers in this project" (saves `enableAllProjectMcpServers: true`)
  - "Use this MCP server" (adds to `enabledMcpjsonServers`)
  - "Continue without using this MCP server" (adds to `disabledMcpjsonServers`)

- **`MCPServerMultiselectDialog`** (`src/components/MCPServerMultiselectDialog.tsx:17`) — for multiple new servers at once. Uses `SelectMulti` to let users pick which servers to enable. Pressing Escape rejects all. Logs analytics via `tengu_mcp_multidialog_choice`.

Both dialogs include the `MCPServerDialogCopy` component, which displays a security warning: *"MCP servers may execute code or access system resources. All tool calls require approval."*

### Desktop Import Flow

`MCPServerDesktopImportDialog` (`src/components/MCPServerDesktopImportDialog.tsx:19`) handles importing MCP servers from Claude Desktop. It:

1. Receives the list of servers found in Claude Desktop configuration
2. Loads all existing MCP configs via `getAllMcpConfigs()` to detect name collisions
3. Presents a multi-select list where colliding names are marked "(already exists)"
4. On submit, imports selected servers using `addMcpConfig()`, appending a numbered suffix for collisions (e.g., `server_1`)
5. Calls `gracefulShutdown()` after import since the config change requires a restart

### Elicitation Dialog

`ElicitationDialog` (`src/components/mcp/ElicitationDialog.tsx:112`) handles MCP server-initiated prompts. It supports two modes:

- **Form mode** (`ElicitationFormDialog`) — renders a dynamic form based on the MCP `requestedSchema`. Supports text fields, numbers, booleans (checkboxes), enums (select lists), multi-select enums, and date/datetime fields. Includes input validation via `validateElicitationInput()` and async validation. Fields can have defaults, descriptions, and required markers.

- **URL mode** (`ElicitationURLDialog`) — for URL-based elicitation where the server provides a URL for the user to visit.

The dialog respects abort signals from the MCP server and registers as an overlay via `useRegisterOverlay`.

### Tool Inspection

- **`MCPToolListView`** (`src/components/mcp/MCPToolListView.tsx:20`) — lists all tools for a connected server. Each tool shows its display name and annotations (read-only, destructive, open-world) with color coding. Tools are presented in a `Select` component for navigation.

- **`MCPToolDetailView`** (`src/components/mcp/MCPToolDetailView.tsx:14`) — shows comprehensive details for a single tool: tool name, full qualified name, description (loaded asynchronously), read-only/destructive/open-world flags, and a complete parameter list with types and descriptions extracted from the JSON schema.

## Function Signatures

### `MCPSettings({ onComplete })`

Top-level MCP management component. Entry point for the `/mcp` command.

- **onComplete**: `(result?: string, options?: { display?: CommandResultDisplay }) => void` — called when the user exits or an action completes

> Source: `src/components/mcp/MCPSettings.tsx:21`

### `MCPListPanel({ servers, agentServers, onSelectServer, onSelectAgentServer, onComplete, defaultTab })`

Server list browser with scope-based grouping.

- **servers**: `ServerInfo[]` — configured MCP server connections
- **agentServers**: `AgentMcpServerInfo[]` — servers from agent definitions
- **onSelectServer**: `(server: ServerInfo) => void` — callback when a server is selected
- **onSelectAgentServer**: `(agentServer: AgentMcpServerInfo) => void` — callback for agent server selection
- **defaultTab**: `string` (optional) — which tab to focus on initial render

> Source: `src/components/mcp/MCPListPanel.tsx:92`

### `MCPStdioServerMenu({ server, serverToolsCount, onViewTools, onCancel, onComplete, borderless })`

Management menu for stdio-transport servers. Displays status, command, args, config location, capabilities, and tools count. Menu options: View tools, Reconnect, Disable/Enable.

> Source: `src/components/mcp/MCPStdioServerMenu.tsx:30`

### `MCPRemoteServerMenu({ server, serverToolsCount, onViewTools, onCancel, onComplete, borderless })`

Management menu for SSE/HTTP/Claude AI proxy servers. Extends stdio menu with authentication, OAuth flows, and Claude AI-specific connection handling.

> Source: `src/components/mcp/MCPRemoteServerMenu.tsx:41`

### `MCPAgentServerMenu({ agentServer, onCancel, onComplete })`

Menu for agent-defined MCP servers. Allows pre-authentication for HTTP/SSE servers before running the agent.

> Source: `src/components/mcp/MCPAgentServerMenu.tsx:28`

### `MCPServerApprovalDialog({ serverName, onDone })`

Single-server approval dialog for new `.mcp.json` entries.

> Source: `src/components/MCPServerApprovalDialog.tsx:12`

### `MCPServerMultiselectDialog({ serverNames, onDone })`

Multi-server approval dialog using `SelectMulti`.

> Source: `src/components/MCPServerMultiselectDialog.tsx:17`

### `MCPServerDesktopImportDialog({ servers, scope, onDone })`

Import dialog for Claude Desktop servers.

- **servers**: `Record<string, McpServerConfig>` — servers found in Desktop config
- **scope**: `ConfigScope` — target scope for imported servers

> Source: `src/components/MCPServerDesktopImportDialog.tsx:19`

### `ElicitationDialog({ event, onResponse, onWaitingDismiss })`

MCP server-initiated prompt dialog. Routes to form or URL sub-dialog based on `event.params.mode`.

> Source: `src/components/mcp/ElicitationDialog.tsx:112`

### `CapabilitiesSection({ serverToolsCount, serverPromptsCount, serverResourcesCount })`

Displays a server's MCP capabilities (tools, resources, prompts) as a comma-separated byline.

> Source: `src/components/mcp/CapabilitiesSection.tsx:10`

### `MCPReconnect({ serverName, onComplete })`

Standalone reconnection component. Attempts reconnection on mount and reports the outcome.

- **serverName**: `string` — name of the server to reconnect
- **onComplete**: `(result?: string, options?: { display?: CommandResultDisplay }) => void`

> Source: `src/components/mcp/MCPReconnect.tsx:15`

### `McpParsingWarnings()`

Parameterless component that reads MCP configs for all scopes (user, project, local) and renders parsing errors and warnings grouped by scope.

> Source: `src/components/mcp/McpParsingWarnings.tsx:122`

### `MCPServerDialogCopy()`

Parameterless component rendering the shared security disclaimer text used in approval dialogs.

> Source: `src/components/MCPServerDialogCopy.tsx:4`

### `handleReconnectResult(result, serverName): ReconnectResult`

Maps reconnection outcomes to user-facing messages.

> Source: `src/components/mcp/utils/reconnectHelpers.tsx:12`

### `handleReconnectError(error, serverName): string`

Formats reconnection errors into user-friendly strings.

> Source: `src/components/mcp/utils/reconnectHelpers.tsx:45`

### `LspRecommendationMenu({ pluginName, pluginDescription, fileExtension, onResponse })`

LSP plugin recommendation dialog with auto-dismiss after 30 seconds.

- **onResponse**: `(response: 'yes' | 'no' | 'never' | 'disable') => void`

> Source: `src/components/LspRecommendation/LspRecommendationMenu.tsx:12`

## Interface/Type Definitions

### `ConfigScope`

Defined in `src/services/mcp/types.ts:10-20` via a Zod enum schema:

```typescript
export const ConfigScopeSchema = lazySchema(() =>
  z.enum([
    'local',
    'user',
    'project',
    'dynamic',
    'enterprise',
    'claudeai',
    'managed',
  ]),
)
export type ConfigScope = z.infer<ReturnType<typeof ConfigScopeSchema>>
```

The seven values are: `'local' | 'user' | 'project' | 'dynamic' | 'enterprise' | 'claudeai' | 'managed'`. Of these, `MCPListPanel` iterates only `['project', 'local', 'user', 'enterprise']` via `SCOPE_ORDER`; `claudeai`-proxy, agent, and `dynamic` servers are rendered in separate blocks. The `managed` scope is used for remotely-managed server configurations.

### `ServerInfo`

Represents a configured MCP server with its connection state. Variants by transport:
- `StdioServerInfo` — `transport: "stdio"`, config is `McpStdioServerConfig`
- `SSEServerInfo` — `transport: "sse"`, includes `isAuthenticated` flag
- `HTTPServerInfo` — `transport: "http"`, includes `isAuthenticated` flag
- `ClaudeAIServerInfo` — `transport: "claudeai-proxy"`

All variants share: `name`, `client` (MCPServerConnection), `scope` (ConfigScope), `config`.

### `AgentMcpServerInfo`

Server defined in agent frontmatter. Includes `name`, `url`, `transport`, and `needsAuth` flag.

### `MCPViewState`

Union type representing the state machine states: `list`, `server-menu`, `server-tools`, `server-tool-detail`, `agent-server-menu`. Each variant carries the data needed for its view (e.g., `server-menu` holds a `ServerInfo`, `server-tool-detail` holds a `ServerInfo` plus `toolIndex`).

### `ReconnectResult`

```typescript
interface ReconnectResult {
  message: string;
  success: boolean;
}
```

> Source: `src/components/mcp/utils/reconnectHelpers.tsx:4`

### `SelectableItem`

Internal union type in `MCPListPanel` for the navigable item list:

```typescript
type SelectableItem =
  | { type: 'server'; server: ServerInfo }
  | { type: 'agent-server'; agentServer: AgentMcpServerInfo };
```

> Source: `src/components/mcp/MCPListPanel.tsx:27-33`

## Configuration & Defaults

- **`SCOPE_ORDER`**: The constant `['project', 'local', 'user', 'enterprise']` (`src/components/mcp/MCPListPanel.tsx:37`) controls the iteration order for scope-grouped servers. Claude AI proxy, agent, and dynamic/built-in servers are rendered in separate blocks after these four scopes.
- **Auto-dismiss timer**: `LspRecommendationMenu` auto-dismisses after 30 seconds (`AUTO_DISMISS_MS = 30_000` in `src/components/LspRecommendation/LspRecommendationMenu.tsx:11`) — counts as "no"
- **Settings keys used by approval dialogs**: `enabledMcpjsonServers`, `disabledMcpjsonServers`, `enableAllProjectMcpServers` (stored in `localSettings`)
- **Elicitation spinner**: Custom 80ms animation cycle (`src/components/mcp/ElicitationDialog.tsx:49-77`) for field resolution, independent of the shared `<Spinner />` component to preserve column alignment
- **Elicitation constants**: `RESOLVING_SPINNER_CHARS` uses braille unicode characters for a compact 1-column-wide spinner

## Edge Cases & Caveats

- **OAuth cleanup on unmount**: `MCPRemoteServerMenu` and `MCPAgentServerMenu` both abort in-progress OAuth flows on unmount to prevent orphaned callback servers that could outlive the terminal process (`src/components/mcp/MCPRemoteServerMenu.tsx:79-85`).
- **Desktop import triggers shutdown**: After importing servers from Claude Desktop, the app calls `gracefulShutdown()` because config changes require a restart.
- **Collision handling in Desktop import**: Duplicate server names get a numbered suffix (`server_1`, `server_2`, etc.) rather than overwriting existing entries.
- **Escape rejects all in multiselect**: Pressing Escape in `MCPServerMultiselectDialog` adds all servers to the disabled list — there is no "cancel without deciding" option.
- **Effective authentication detection**: `MCPRemoteServerMenu` considers a server "effectively authenticated" if it has OAuth tokens OR is connected with tools available (`src/components/mcp/MCPRemoteServerMenu.tsx:90`) — this handles servers using alternative auth mechanisms like session ingress tokens.
- **Empty server list guard**: `MCPSettings` waits for async server info preparation before concluding there are no servers. It only shows the "no servers" message once `filteredClients` has been processed and the servers array is still empty (`src/components/mcp/MCPSettings.tsx:146-153`).
- **Elicitation abort signal**: The `ElicitationFormDialog` listens for the MCP server's abort signal and auto-cancels the form if the server aborts the elicitation request (`src/components/mcp/ElicitationDialog.tsx:186-198`).
- **Clipboard copy feedback**: `MCPRemoteServerMenu` uses an `unmountedRef` guard to prevent setting state after unmount when the async `setClipboard` promise resolves (`src/components/mcp/MCPRemoteServerMenu.tsx:68,199`).
- **Config parsing warnings**: `McpParsingWarnings` reads config for all scopes (user, project, local) at mount time and displays errors and warnings grouped by scope with file locations (`src/components/mcp/McpParsingWarnings.tsx:122`).

## Key Code Snippets

### View State Machine Dispatch

The core routing logic in `MCPSettings` that selects which sub-component to render:

```typescript
switch (viewState.type) {
  case "list":
    return <MCPListPanel servers={servers} agentServers={agentMcpServers}
      onSelectServer={server => setViewState({ type: "server-menu", server })}
      onSelectAgentServer={agentServer => setViewState({ type: "agent-server-menu", agentServer })}
      onComplete={onComplete} defaultTab={viewState.defaultTab} />;
  case "server-menu":
    // Routes to MCPStdioServerMenu or MCPRemoteServerMenu based on transport
  case "server-tools":
    return <MCPToolListView server={viewState.server}
      onSelectTool={(_, index) => setViewState({
        type: "server-tool-detail", server: viewState.server, toolIndex: index
      })}
      onBack={() => setViewState({ type: "server-menu", server: viewState.server })} />;
  case "agent-server-menu":
    return <MCPAgentServerMenu agentServer={viewState.agentServer} ... />;
}
```

> Source: `src/components/mcp/MCPSettings.tsx:165-375`

### Server List Item Assembly

Shows how items are assembled from multiple sources — `SCOPE_ORDER` drives the first four groups, then Claude AI, agent, and dynamic servers are appended separately:

```typescript
items = [];
for (const scope of SCOPE_ORDER) {
  const scopeServers = serversByScope.get(scope) ?? [];
  for (const server of scopeServers) {
    items.push({ type: "server", server });
  }
}
for (const server of claudeAiServers) {
  items.push({ type: "server", server });
}
for (const agentServer of agentServers) {
  items.push({ type: "agent-server", agentServer });
}
for (const server of dynamicServers) {
  items.push({ type: "server", server });
}
```

> Source: `src/components/mcp/MCPListPanel.tsx:149-177`

### Server Info Preparation with Auth Detection

The async effect that builds `ServerInfo` objects, including auth status for remote servers:

```typescript
const serverInfos = await Promise.all(filteredClients.map(async client => {
  const isSSE = client.config.type === "sse";
  const isHTTP = client.config.type === "http";
  let isAuthenticated = undefined;
  if (isSSE || isHTTP) {
    const authProvider = new ClaudeAuthProvider(client.name, client.config);
    const tokens = await authProvider.tokens();
    const hasSessionAuth = getSessionIngressAuthToken() !== null
      && client.type === "connected";
    const hasToolsAndConnected = client.type === "connected"
      && filterToolsByServer(mcp.tools, client.name).length > 0;
    isAuthenticated = Boolean(tokens) || hasSessionAuth || hasToolsAndConnected;
  }
  return { name: client.name, client, scope, transport: ..., isAuthenticated, config };
}));
```

> Source: `src/components/mcp/MCPSettings.tsx:68-131`

### Approval Dialog Settings Persistence

How server approval/rejection is saved to local settings:

```typescript
case "yes":
case "yes_all":
  const enabledServers = currentSettings.enabledMcpjsonServers || [];
  if (!enabledServers.includes(serverName)) {
    updateSettingsForSource("localSettings", {
      enabledMcpjsonServers: [...enabledServers, serverName]
    });
  }
  if (value === "yes_all") {
    updateSettingsForSource("localSettings", { enableAllProjectMcpServers: true });
  }
  break;
case "no":
  const disabledServers = currentSettings.disabledMcpjsonServers || [];
  updateSettingsForSource("localSettings", {
    disabledMcpjsonServers: [...disabledServers, serverName]
  });
  break;
```

> Source: `src/components/MCPServerApprovalDialog.tsx:20-54`

### Reconnect Result Mapping

Pure helper that converts connection state to user messages:

```typescript
export function handleReconnectResult(result: {
  client: MCPServerConnection;
  tools: Tool[];
  commands: Command[];
  resources?: ServerResource[];
}, serverName: string): ReconnectResult {
  switch (result.client.type) {
    case 'connected':
      return { message: `Reconnected to ${serverName}.`, success: true };
    case 'needs-auth':
      return { message: `${serverName} requires authentication.`, success: false };
    case 'failed':
      return { message: `Failed to reconnect to ${serverName}.`, success: false };
    default:
      return { message: `Unknown result when reconnecting to ${serverName}.`, success: false };
  }
}
```

> Source: `src/components/mcp/utils/reconnectHelpers.tsx:12-40`