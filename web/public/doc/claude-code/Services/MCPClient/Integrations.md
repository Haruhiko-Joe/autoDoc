# Integrations

## Overview & Responsibilities

The Integrations module provides three external system integration points for the MCP (Model Context Protocol) subsystem within Claude Code's Services layer. Sitting under **Services → MCPClient**, these integrations connect the MCP client to the outside world:

1. **VS Code SDK MCP Bridge** (`src/services/mcp/vscodeSdkMcp.ts`) — bidirectional notification channel between Claude Code and the VS Code extension
2. **Official Registry Client** (`src/services/mcp/officialRegistry.ts`) — fetches and caches the list of Anthropic-approved MCP server URLs
3. **Server Approval UI** (`src/services/mcpServerApproval.tsx`) — renders Ink-based dialogs prompting the user to approve pending project MCP servers

Sibling modules in MCPClient handle the core protocol client (SDKClient), transport layers (Transports), connection management (ConnectionUI), configuration (Configuration), and utilities (Utilities). This module focuses exclusively on the integrations that sit at the edges.

## Key Processes

### VS Code SDK MCP Bridge

> Source: `src/services/mcp/vscodeSdkMcp.ts`

The bridge enables bidirectional communication between Claude Code and the `claude-vscode` VS Code extension over the MCP notification mechanism.

#### Setup Flow

`setupVscodeSdkMcp(sdkClients)` is called with the list of connected MCP server connections. It:

1. Finds the client named `"claude-vscode"` from the SDK clients list (`src/services/mcp/vscodeSdkMcp.ts:65`)
2. Stores a module-level reference (`vscodeMcpClient`) for outbound notifications (`src/services/mcp/vscodeSdkMcp.ts:69`)
3. Registers a notification handler for `log_event` messages from VS Code — these are forwarded to the analytics pipeline as `tengu_vscode_{eventName}` events (`src/services/mcp/vscodeSdkMcp.ts:71-80`)
4. Immediately sends an `experiment_gates` notification to VS Code containing cached feature gate values (`src/services/mcp/vscodeSdkMcp.ts:83-110`)

#### Experiment Gates Sync

On setup, the bridge pushes the following feature gates to VS Code:

| Gate Key | Type | Purpose |
|----------|------|---------|
| `tengu_vscode_review_upsell` | boolean | Review upsell feature flag |
| `tengu_vscode_onboarding` | boolean | Onboarding experience flag |
| `tengu_quiet_fern` | any | Browser support configuration |
| `tengu_vscode_cc_auth` | any | In-band OAuth vs. extension-native PKCE |
| `tengu_auto_mode_state` | `'enabled'` \| `'disabled'` \| `'opt-in'` | Auto-mode state (omitted if unknown, so VS Code fails closed) |

Gate values come from GrowthBook cached feature flags via `checkStatsigFeatureGate_CACHED_MAY_BE_STALE` and `getFeatureValue_CACHED_MAY_BE_STALE`.

#### File Update Notifications

```typescript
// src/services/mcp/vscodeSdkMcp.ts:39-58
export function notifyVscodeFileUpdated(
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
): void
```

Sends a `file_updated` notification to VS Code when Claude edits or writes a file. This lets the VS Code extension refresh its view of changed files.

**Guard conditions**: The notification is only sent when `USER_TYPE` is `"ant"` (Anthropic-internal users) **and** a VS Code MCP client is connected (`src/services/mcp/vscodeSdkMcp.ts:44`). Failures are silently logged — they never propagate.

#### Inbound Log Events

VS Code can send `log_event` notifications (validated against `LogEventNotificationSchema` at `src/services/mcp/vscodeSdkMcp.ts:22-30`) containing an `eventName` and arbitrary `eventData`. These are forwarded to the analytics pipeline prefixed with `tengu_vscode_`.

### Official Registry Prefetch and Classification

> Source: `src/services/mcp/officialRegistry.ts`

A lightweight client that fetches Anthropic's official MCP server registry and caches it in memory for URL classification.

#### Prefetch Flow

```typescript
// src/services/mcp/officialRegistry.ts:33-60
export async function prefetchOfficialMcpUrls(): Promise<void>
```

1. **Short-circuits** if `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set — respects offline/restricted environments (`src/services/mcp/officialRegistry.ts:34-36`)
2. Fetches `https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial` with a 5-second timeout (`src/services/mcp/officialRegistry.ts:39-42`)
3. Iterates over all `servers[].server.remotes[].url` entries in the response
4. Normalizes each URL via `normalizeUrl()` (strips query string and trailing slash) and stores it in a module-level `Set<string>` (`src/services/mcp/officialRegistry.ts:44-53`)
5. Logs the count of loaded URLs on success; logs errors on failure without throwing

#### URL Classification

```typescript
// src/services/mcp/officialRegistry.ts:66-68
export function isOfficialMcpUrl(normalizedUrl: string): boolean
```

Returns `true` only if the URL is present in the cached registry set. **Fail-closed**: if the registry was never fetched (or the fetch failed), this returns `false`.

The `normalizedUrl` parameter is expected to already be normalized via `getLoggingSafeMcpBaseUrl` elsewhere in the codebase — the same normalization (strip query string, strip trailing slash) is mirrored in the internal `normalizeUrl` helper (`src/services/mcp/officialRegistry.ts:19-27`).

### Server Approval Dialog

> Source: `src/services/mcpServerApproval.tsx`

Renders an interactive terminal dialog for approving project-scoped MCP servers that are in a `"pending"` state.

#### Approval Flow

```typescript
// src/services/mcpServerApproval.tsx:15-40
export async function handleMcpjsonServerApprovals(root: Root): Promise<void>
```

1. Retrieves all project-scoped MCP server configurations via `getMcpConfigsByScope('project')` (`src/services/mcpServerApproval.tsx:17-18`)
2. Filters to servers whose status is `"pending"` using `getProjectMcpServerStatus()` (`src/services/mcpServerApproval.tsx:19`)
3. If no pending servers, returns immediately (`src/services/mcpServerApproval.tsx:20-22`)
4. Renders an Ink-based dialog into the provided `Root` instance:
   - **Single pending server** → renders `<MCPServerApprovalDialog>` (`src/services/mcpServerApproval.tsx:27-29`)
   - **Multiple pending servers** → renders `<MCPServerMultiselectDialog>` (`src/services/mcpServerApproval.tsx:33-37`)
5. Wraps the dialog in `<AppStateProvider>` and `<KeybindingSetup>` for proper React context
6. Awaits a Promise that resolves when the user completes the dialog (via the `onDone` callback)

The function reuses the existing Ink `Root` instance (passed from `main.tsx`) rather than creating a new terminal rendering context.

## Function Signatures

| Function | File | Description |
|----------|------|-------------|
| `setupVscodeSdkMcp(sdkClients: MCPServerConnection[])` | `src/services/mcp/vscodeSdkMcp.ts:64` | Initializes bidirectional VS Code bridge |
| `notifyVscodeFileUpdated(filePath, oldContent, newContent)` | `src/services/mcp/vscodeSdkMcp.ts:39` | Sends file change notification to VS Code |
| `prefetchOfficialMcpUrls()` | `src/services/mcp/officialRegistry.ts:33` | Fire-and-forget registry fetch |
| `isOfficialMcpUrl(normalizedUrl)` | `src/services/mcp/officialRegistry.ts:66` | Checks if URL is in official registry |
| `resetOfficialMcpUrlsForTesting()` | `src/services/mcp/officialRegistry.ts:70` | Clears cached URLs (test helper) |
| `handleMcpjsonServerApprovals(root: Root)` | `src/services/mcpServerApproval.tsx:15` | Shows approval dialogs for pending servers |

## Type Definitions

### Registry Types (`src/services/mcp/officialRegistry.ts`)

| Type | Fields | Description |
|------|--------|-------------|
| `RegistryServer` | `server.remotes?: Array<{ url: string }>` | Single server entry from the registry |
| `RegistryResponse` | `servers: RegistryServer[]` | Top-level API response shape |

### VS Code Types (`src/services/mcp/vscodeSdkMcp.ts`)

| Type | Values | Description |
|------|--------|-------------|
| `AutoModeEnabledState` | `'enabled'` \| `'disabled'` \| `'opt-in'` | Tri-state for auto-mode feature gate |

## Edge Cases & Caveats

- **VS Code bridge is Anthropic-internal only**: `notifyVscodeFileUpdated` checks `USER_TYPE === 'ant'` — external users never send file update notifications even if a VS Code MCP client is connected.
- **Auto-mode gate omission**: When `readAutoModeEnabledState()` returns `undefined`, the `tengu_auto_mode_state` gate is intentionally omitted from the experiment gates notification so VS Code defaults to treating it as disabled (fail-closed).
- **Registry is fire-and-forget**: `prefetchOfficialMcpUrls` never throws. If the network request fails, `isOfficialMcpUrl` silently returns `false` for all URLs.
- **Registry respects traffic disable flag**: Setting `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` prevents the registry fetch entirely.
- **Approval dialog blocks startup**: `handleMcpjsonServerApprovals` is async and blocks until the user completes the approval dialog. The caller must await it before proceeding with MCP server connections.