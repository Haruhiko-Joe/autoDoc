# TmuxBackend

## Overview & Responsibilities

`TmuxBackend` is a `PaneBackend` implementation that uses tmux to manage terminal panes for the multi-agent swarm system. It sits within the **Infrastructure > CoreUtilities > SwarmHelpers > PaneBackends** layer and is one of three backend strategies (alongside iTerm2 and in-process) for spawning teammate agent panes.

The backend supports two distinct operating modes depending on whether the leader agent is already running inside a tmux session:

- **Inside tmux**: Splits the leader's existing window, placing the leader on the left (30%) and teammates on the right (70%) using a `main-vertical` layout.
- **Outside tmux**: Creates a dedicated `claude-swarm` session on a separate socket with a `tiled` layout where all teammate panes are distributed equally.

The module self-registers with the backend registry on import (`src/utils/swarm/backends/TmuxBackend.ts:764`), a deliberate side effect that avoids circular dependency issues.

## Key Processes

### Pane Creation Flow

All pane creation goes through `createTeammatePaneInSwarmView()` (`src/utils/swarm/backends/TmuxBackend.ts:129-146`), which:

1. **Acquires a sequential lock** — Prevents race conditions when multiple teammates are spawned in parallel. The lock is a chained Promise; each caller waits for the previous one to finish before proceeding.
2. **Detects the operating mode** — Calls `isRunningInside()` to determine whether we're inside an existing tmux session.
3. **Delegates to the appropriate strategy**:
   - Inside tmux → `createTeammatePaneWithLeader()`
   - Outside tmux → `createTeammatePaneExternal()`
4. **Releases the lock** in a `finally` block.

### Inside-Tmux Teammate Creation

`createTeammatePaneWithLeader()` (`src/utils/swarm/backends/TmuxBackend.ts:551-630`):

1. Resolves the leader's pane ID (from `TMUX_PANE` env var captured at startup) and window target (`session:window` format, cached after first lookup).
2. Counts existing panes in the window.
3. **First teammate**: Splits horizontally from the leader pane with a 70% width allocation (`split-window -h -l 70%`).
4. **Subsequent teammates**: Uses binary-tree-style splitting — alternates between vertical and horizontal splits based on the teammate index (`teammateCount % 2 === 1` → vertical, otherwise horizontal), targeting the pane at index `floor((count - 1) / 2)` in the teammate list.
5. Applies border color and title styling.
6. Rebalances with `main-vertical` layout, resizing the leader pane back to 30%.
7. Waits 200ms for shell initialization before returning.

### Outside-Tmux Teammate Creation

`createTeammatePaneExternal()` (`src/utils/swarm/backends/TmuxBackend.ts:635-702`):

1. Calls `createExternalSwarmSession()` which creates (or locates) a `claude-swarm` session with a `swarm-view` window on a dedicated socket (via `-L` flag).
2. **First teammate**: Reuses the initial pane created with the session (tracked by `firstPaneUsedForExternal` flag). Enables pane border status display.
3. **Subsequent teammates**: Uses the same binary-tree splitting algorithm as the inside-tmux path, but commands are routed through the swarm socket.
4. Applies border color and title, then rebalances with `tiled` layout.
5. Waits 200ms for shell initialization.

### Hide/Show Mechanism

Panes can be hidden and restored, which supports the `supportsHideShow = true` capability:

- **Hide** (`hidePane`, line 281): Creates a detached `_hidden` session if needed, then uses `break-pane -d` to move the target pane into it — the pane keeps running but is removed from the visible window.
- **Show** (`showPane`, line 313): Uses `join-pane -h` to move the pane back into the target window, then reapplies `main-vertical` layout with 30% leader width.

### Binary-Tree Split Strategy

When adding the Nth teammate (N > 1), the backend alternates split direction and picks a target pane to bisect:

```
splitVertically = teammateCount % 2 === 1
targetPaneIndex = floor((teammateCount - 1) / 2)
```

> Source: `src/utils/swarm/backends/TmuxBackend.ts:596-600` (inside-tmux), `src/utils/swarm/backends/TmuxBackend.ts:670-672` (external)

This produces balanced pane trees — odd-numbered additions split vertically, even-numbered split horizontally, each targeting the "oldest" unsplit pane in the tree.

## Function Signatures

### Public API (PaneBackend interface)

#### `isAvailable(): Promise<boolean>`
Checks if the `tmux` binary is installed by delegating to `detection.ts`.

#### `isRunningInside(): Promise<boolean>`
Returns whether the leader process is running inside an existing tmux session.

#### `createTeammatePaneInSwarmView(name: string, color: AgentColorName): Promise<CreatePaneResult>`
Main entry point for pane creation. Returns `{ paneId: string, isFirstTeammate: boolean }`. Serialized via internal lock.

#### `sendCommandToPane(paneId: PaneId, command: string, useExternalSession?: boolean): Promise<void>`
Sends a shell command to a pane via `tmux send-keys`. The `useExternalSession` flag determines whether to use the swarm socket.

#### `setPaneBorderColor(paneId: PaneId, color: AgentColorName, useExternalSession?: boolean): Promise<void>`
Sets per-pane border styling (requires tmux 3.2+). Configures both `pane-border-style` and `pane-active-border-style`.

#### `setPaneTitle(paneId: PaneId, name: string, color: AgentColorName, useExternalSession?: boolean): Promise<void>`
Sets the pane title and enables colored `pane-border-format` display.

#### `enablePaneBorderStatus(windowTarget?: string, useExternalSession?: boolean): Promise<void>`
Enables `pane-border-status: top` on a window so pane titles are visible in the borders.

#### `rebalancePanes(windowTarget: string, hasLeader: boolean): Promise<void>`
Dispatches to either `main-vertical` (with leader at 30%) or `tiled` layout rebalancing.

#### `killPane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>`
Kills a pane. Returns `true` on success.

#### `hidePane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>`
Moves a pane to a hidden session via `break-pane`. Returns `true` on success.

#### `showPane(paneId: PaneId, targetWindowOrPane: string, useExternalSession?: boolean): Promise<boolean>`
Restores a hidden pane via `join-pane`. Reapplies layout afterward.

## Type Definitions

### `AgentColorName` (imported)
Union of `'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan'` — agent colors mapped to tmux color names including extended palette (`colour208` for orange, `colour205` for pink).

### `CreatePaneResult` (imported from `types.ts`)
```typescript
{ paneId: string; isFirstTeammate: boolean }
```

### `PaneId`
String alias for a tmux pane identifier (e.g., `%0`, `%5`).

## Configuration & Defaults

| Item | Value | Description |
|------|-------|-------------|
| `PANE_SHELL_INIT_DELAY_MS` | `200` | Milliseconds to wait after pane creation for shell startup (rc files, prompts) |
| Leader pane width | `30%` | Width of the leader pane in `main-vertical` layout |
| First teammate width | `70%` | Initial horizontal split percentage for the first teammate |
| `SWARM_SESSION_NAME` | (from constants) | Name of the tmux session created for external mode |
| `SWARM_VIEW_WINDOW_NAME` | (from constants) | Name of the window within the swarm session |
| `HIDDEN_SESSION_NAME` | (from constants) | Name of the detached session used for hiding panes |
| `TMUX_COMMAND` | (from constants) | The tmux binary name/path |

## Edge Cases & Caveats

- **Sequential locking**: Pane creation is serialized via a promise-chain lock (`acquirePaneCreationLock`). If one creation fails, the lock is still released in `finally`, allowing subsequent creations to proceed.
- **Module-level mutable state**: `firstPaneUsedForExternal`, `cachedLeaderWindowTarget`, and `paneCreationLock` are module-scoped variables. This means the backend is effectively a singleton — creating multiple `TmuxBackend` instances would share this state.
- **tmux 3.2+ required**: Per-pane border styling via `-P` flag on `select-pane` and per-pane `set-option -p` requires tmux 3.2 or later.
- **Leader pane ID stability**: The leader's pane ID is captured from `TMUX_PANE` at module load (via `getLeaderPaneId()`), ensuring it remains stable even if the user switches to a different pane. Falls back to `display-message` query.
- **Window target caching**: `getCurrentWindowTarget()` caches the `session:window` string after the first successful query, assuming the leader never changes windows.
- **Socket isolation**: External-mode operations use a separate tmux socket (`-L` flag with `getSwarmSocketName()`), keeping swarm panes completely isolated from the user's tmux sessions.
- **Self-registration side effect**: The `registerTmuxBackend(TmuxBackend)` call at line 764 runs on import, which is a deliberate pattern to avoid circular dependencies in the registry system.
- **Shell initialization delay**: The 200ms delay is a heuristic that accommodates slow shell configurations (starship, oh-my-zsh). If a shell takes longer, commands sent immediately after pane creation could arrive before the prompt is ready.