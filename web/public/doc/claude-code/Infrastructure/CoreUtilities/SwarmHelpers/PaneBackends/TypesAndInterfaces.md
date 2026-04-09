# Types and Interfaces

## Overview & Responsibilities

This module (`src/utils/swarm/backends/types.ts`) defines the core type system for the swarm backend infrastructure — the layer that enables Claude Code to spawn and manage multiple teammate agents in parallel. It sits within the **PaneBackends** sub-unit of **SwarmHelpers** (under **CoreUtilities → Infrastructure**) and provides the shared contract that all three backend implementations (tmux, iTerm2, in-process) must conform to.

The module defines two key abstraction layers:
- **`PaneBackend`** — low-level terminal pane lifecycle operations (create, command, style, kill, hide/show)
- **`TeammateExecutor`** — high-level teammate lifecycle operations (spawn, message, terminate, kill, status check)

Every other module in the swarm subsystem depends on these types: the backend implementations (tmux, iTerm2, in-process), the detection module, the registry, and the `PaneBackendExecutor` adapter all import from this file.

## Key Concepts

### Two-Layer Abstraction

The type system separates concerns into two interfaces:

1. **`PaneBackend`** deals with *terminal panes* — creating split windows, sending shell commands, setting border colors and titles, hiding/showing panes. This is specific to terminal multiplexer backends (tmux and iTerm2).

2. **`TeammateExecutor`** deals with *teammate agents* — spawning a teammate with a prompt and config, sending messages, checking liveness, and terminating. This works across all backends including in-process execution.

The `PaneBackendExecutor` adapter (defined elsewhere) bridges these two layers by implementing `TeammateExecutor` on top of a `PaneBackend`.

### Backend Discriminators

Two union types distinguish execution modes:

- **`BackendType`**: `'tmux' | 'iterm2' | 'in-process'` — all three backend strategies
- **`PaneBackendType`**: `'tmux' | 'iterm2'` — only the pane-based backends

The `isPaneBackend()` type guard narrows a `BackendType` to `PaneBackendType`, useful for conditionally executing pane-specific logic.

## Interface Definitions

### `PaneBackend`

The low-level interface for terminal pane management. Each pane-based backend (tmux, iTerm2) implements this interface.

| Property/Method | Signature | Description |
|---|---|---|
| `type` | `readonly BackendType` | Backend identifier |
| `displayName` | `readonly string` | Human-readable name |
| `supportsHideShow` | `readonly boolean` | Whether hide/show operations are supported |
| `isAvailable()` | `() => Promise<boolean>` | Checks if the backend tool (tmux/it2) exists on the system |
| `isRunningInside()` | `() => Promise<boolean>` | Checks if currently inside this backend's environment |
| `createTeammatePaneInSwarmView()` | `(name, color) => Promise<CreatePaneResult>` | Creates a new pane with layout handling |
| `sendCommandToPane()` | `(paneId, command, useExternalSession?) => Promise<void>` | Executes a command in a pane |
| `setPaneBorderColor()` | `(paneId, color, useExternalSession?) => Promise<void>` | Styles a pane's border |
| `setPaneTitle()` | `(paneId, name, color, useExternalSession?) => Promise<void>` | Sets the pane header title |
| `enablePaneBorderStatus()` | `(windowTarget?, useExternalSession?) => Promise<void>` | Enables title display in borders |
| `rebalancePanes()` | `(windowTarget, hasLeader) => Promise<void>` | Redistributes pane layout |
| `killPane()` | `(paneId, useExternalSession?) => Promise<boolean>` | Closes a pane |
| `hidePane()` | `(paneId, useExternalSession?) => Promise<boolean>` | Breaks pane into hidden window |
| `showPane()` | `(paneId, targetWindowOrPane, useExternalSession?) => Promise<boolean>` | Joins hidden pane back |

> Source: `src/utils/swarm/backends/types.ts:39-168`

The `useExternalSession` parameter appears on many methods — this is a tmux-specific concern where operations may need to target a different tmux server socket.

### `TeammateExecutor`

The high-level interface for teammate lifecycle management, implemented by all three backends.

| Method | Signature | Description |
|---|---|---|
| `type` | `readonly BackendType` | Backend identifier |
| `isAvailable()` | `() => Promise<boolean>` | System availability check |
| `spawn()` | `(config: TeammateSpawnConfig) => Promise<TeammateSpawnResult>` | Creates and starts a teammate |
| `sendMessage()` | `(agentId, message: TeammateMessage) => Promise<void>` | Delivers a message to a teammate |
| `terminate()` | `(agentId, reason?) => Promise<boolean>` | Graceful shutdown request |
| `kill()` | `(agentId) => Promise<boolean>` | Immediate forced termination |
| `isActive()` | `(agentId) => Promise<boolean>` | Liveness check |

> Source: `src/utils/swarm/backends/types.ts:279-300`

## Type Definitions

### `BackendType`

```typescript
type BackendType = 'tmux' | 'iterm2' | 'in-process'
```

Discriminator for all backend strategies. `'tmux'` and `'iterm2'` are pane-based (visible terminal splits); `'in-process'` runs the teammate within the leader's Node.js process.

> Source: `src/utils/swarm/backends/types.ts:9`

### `PaneBackendType`

```typescript
type PaneBackendType = 'tmux' | 'iterm2'
```

Subset of `BackendType` for pane-based backends only.

> Source: `src/utils/swarm/backends/types.ts:15`

### `PaneId`

```typescript
type PaneId = string
```

Opaque identifier for a managed pane. For tmux this is a pane ID like `"%1"`; for iTerm2 it's the session ID returned by the `it2` CLI.

> Source: `src/utils/swarm/backends/types.ts:22`

### `CreatePaneResult`

| Field | Type | Description |
|---|---|---|
| `paneId` | `PaneId` | ID of the newly created pane |
| `isFirstTeammate` | `boolean` | Whether this is the first teammate pane (affects layout strategy) |

> Source: `src/utils/swarm/backends/types.ts:27-32`

### `TeammateIdentity`

Base identity fields shared across teammate types. Designed as a minimal subset to avoid circular dependencies with the full `TeammateContext` type defined elsewhere.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Agent name (e.g., `"researcher"`, `"tester"`) |
| `teamName` | `string` | Yes | Team this teammate belongs to |
| `color` | `AgentColorName` | No | Assigned color for UI differentiation |
| `planModeRequired` | `boolean` | No | Whether plan mode approval is required before implementation |

> Source: `src/utils/swarm/backends/types.ts:191-200`

### `TeammateSpawnConfig`

Extends `TeammateIdentity` with all configuration needed to spawn a teammate.

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | Yes | Initial prompt to send to the teammate |
| `cwd` | `string` | Yes | Working directory |
| `parentSessionId` | `string` | Yes | Parent session ID for context linking |
| `model` | `string` | No | Model override for this teammate |
| `systemPrompt` | `string` | No | Custom system prompt (resolved from workflow config) |
| `systemPromptMode` | `'default' \| 'replace' \| 'append'` | No | How to apply the system prompt relative to the default |
| `worktreePath` | `string` | No | Optional git worktree path for isolation |
| `permissions` | `string[]` | No | Tool permissions to grant |
| `allowPermissionPrompts` | `boolean` | No | If `false` (default), unlisted tools are auto-denied |

> Source: `src/utils/swarm/backends/types.ts:205-225`

### `TeammateSpawnResult`

| Field | Type | Required | Description |
|---|---|---|---|
| `success` | `boolean` | Yes | Whether spawn succeeded |
| `agentId` | `string` | Yes | Unique ID in format `agentName@teamName` |
| `error` | `string` | No | Error message on failure |
| `abortController` | `AbortController` | No | Lifecycle handle (in-process only) |
| `taskId` | `string` | No | AppState task registry ID (in-process only) |
| `paneId` | `PaneId` | No | Terminal pane ID (pane-based only) |

> Source: `src/utils/swarm/backends/types.ts:230-254`

Note the backend-specific optional fields: `abortController` and `taskId` are only set for in-process teammates, while `paneId` is only set for pane-based teammates.

### `TeammateMessage`

| Field | Type | Required | Description |
|---|---|---|---|
| `text` | `string` | Yes | Message content |
| `from` | `string` | Yes | Sender agent ID |
| `color` | `string` | No | Sender display color |
| `timestamp` | `string` | No | ISO timestamp |
| `summary` | `string` | No | 5-10 word preview for UI display |

> Source: `src/utils/swarm/backends/types.ts:259-270`

### `BackendDetectionResult`

Returned by the detection module after probing the terminal environment.

| Field | Type | Required | Description |
|---|---|---|---|
| `backend` | `PaneBackend` | Yes | The detected/selected backend |
| `isNative` | `boolean` | Yes | Whether running inside the backend's native environment |
| `needsIt2Setup` | `boolean` | No | `true` if iTerm2 is detected but the `it2` CLI is not installed |

> Source: `src/utils/swarm/backends/types.ts:173-180`

## Type Guard

### `isPaneBackend(type: BackendType): type is PaneBackendType`

Narrows a `BackendType` to the pane-based subset (`'tmux' | 'iterm2'`). Returns `false` for `'in-process'`.

```typescript
export function isPaneBackend(type: BackendType): type is 'tmux' | 'iterm2' {
  return type === 'tmux' || type === 'iterm2'
}
```

> Source: `src/utils/swarm/backends/types.ts:309-311`

## Edge Cases & Caveats

- **`useExternalSession` parameter**: Many `PaneBackend` methods accept this optional boolean. It is a tmux-specific concern (for targeting a different tmux server socket) and is ignored by the iTerm2 backend. If you're implementing a new backend, you can safely ignore it.
- **`TeammateIdentity` is intentionally minimal**: The comment at line 188-189 explains this is a subset of the full `TeammateContext` to avoid circular dependencies. The full context type lives in the in-process execution module.
- **`TeammateSpawnResult` has backend-specific fields**: `abortController`/`taskId` are only populated for in-process teammates; `paneId` is only populated for pane-based teammates. Consumers should check the backend type or use the `isPaneBackend` guard before accessing these fields.
- **`allowPermissionPrompts` defaults to `false`**: When not set, any tool not explicitly listed in `permissions` will be auto-denied rather than prompting the user. This is a security-conscious default for automated teammate agents.