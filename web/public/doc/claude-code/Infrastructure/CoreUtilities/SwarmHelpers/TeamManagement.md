# TeamManagement

## Overview & Responsibilities

TeamManagement (`src/utils/swarm/teamHelpers.ts`) is the persistence and lifecycle layer for multi-agent swarm teams. It owns the JSON config file (`~/.claude/teams/{team-name}/config.json`) that serves as the **source of truth** for which agents are in a team, what they're doing, and what permissions they have.

Within the module hierarchy, it lives under **Infrastructure > CoreUtilities > SwarmHelpers** and is consumed by nearly every other sub-unit in the swarm module — the team creation tool, teammate tool, inbox poller, teams dialog UI, and shutdown hooks all depend on these helpers.

Its responsibilities break into four areas:

1. **File I/O** — Reading and writing the team config file, with both sync (for React render paths) and async (for tool handlers) variants
2. **Member lifecycle** — Adding, removing, and looking up team members by agent ID, name, or pane ID
3. **State synchronization** — Tracking member activity status (`isActive`) and permission modes across all teammates
4. **Cleanup** — Destroying git worktrees, killing orphaned panes, and removing team/task directories on session exit

## Key Types

### `TeamFile`

The root data structure persisted as `config.json`. Defined at `src/utils/swarm/teamHelpers.ts:64-90`.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Team display name |
| `description` | `string?` | Purpose of the team |
| `createdAt` | `number` | Creation timestamp |
| `leadAgentId` | `string` | Agent ID of the team leader |
| `leadSessionId` | `string?` | Session UUID of the leader (for discovery) |
| `hiddenPaneIds` | `string[]?` | Pane IDs currently hidden from the UI |
| `teamAllowedPaths` | `TeamAllowedPath[]?` | Paths all teammates can edit without prompting |
| `members` | `Member[]` | Array of team member records (see below) |

Each **member** record contains:

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | `string` | Unique agent identifier (e.g., `researcher@my-team`) |
| `name` | `string` | Display name |
| `agentType` | `string?` | Role label (e.g., `"researcher"`, `"test-runner"`) |
| `model` | `string?` | Model override for this agent |
| `prompt` | `string?` | System prompt fragment |
| `color` | `string?` | UI display color |
| `tmuxPaneId` | `string` | Terminal pane identifier |
| `cwd` | `string` | Working directory |
| `worktreePath` | `string?` | Git worktree path, if isolated |
| `sessionId` | `string?` | Session identifier |
| `subscriptions` | `string[]` | Message channels subscribed to |
| `backendType` | `BackendType?` | Terminal backend (tmux, iTerm2, in-process) |
| `isActive` | `boolean?` | `false` when idle, `undefined`/`true` when active |
| `mode` | `PermissionMode?` | Current permission mode |

### `TeamAllowedPath`

Tracks paths that all teammates are pre-approved to edit (`src/utils/swarm/teamHelpers.ts:57-62`):

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Absolute directory path |
| `toolName` | `string` | Tool this applies to (e.g., `"Edit"`, `"Write"`) |
| `addedBy` | `string` | Agent name who added the rule |
| `addedAt` | `number` | Timestamp |

### Input Schema

Defined via Zod at `src/utils/swarm/teamHelpers.ts:19-42`. Supports two operations:

- **`spawnTeam`** — Create a new team (requires `team_name`, optional `agent_type` and `description`)
- **`cleanup`** — Remove team and task directories

## Key Processes

### Team File I/O

The module provides **paired sync/async** variants for both reading and writing:

| Function | Sync/Async | Purpose |
|----------|-----------|---------|
| `readTeamFile()` | sync | For React render paths and other sync contexts |
| `readTeamFileAsync()` | async | For tool handlers |
| `writeTeamFile()` | sync (private) | Internal write used by all sync mutators |
| `writeTeamFileAsync()` | async (exported) | For async contexts |

All reads return `null` on `ENOENT` (file not found) rather than throwing, logging other errors via `logForDebugging`. Writes ensure the team directory exists with `mkdir({ recursive: true })` before writing.

The file path is derived by: `getTeamsDir()` → append `sanitizeName(teamName)` → append `config.json`.

### Member Removal

Three removal strategies exist, each suited to different identification scenarios:

1. **`removeTeammateFromTeamFile(teamName, { agentId?, name? })`** (`src/utils/swarm/teamHelpers.ts:188-227`) — Removes by agent ID or name. Used by the leader when processing shutdown approvals. Filters the members array and rewrites the file.

2. **`removeMemberFromTeam(teamName, tmuxPaneId)`** (`src/utils/swarm/teamHelpers.ts:285-317`) — Removes by pane ID. Also cleans up the `hiddenPaneIds` array if the pane was hidden. Used when identifying members by their terminal pane.

3. **`removeMemberByAgentId(teamName, agentId)`** (`src/utils/swarm/teamHelpers.ts:326-348`) — Removes by agent ID only. Designed for **in-process teammates** that share a single `tmuxPaneId`, where pane-based lookup would be ambiguous.

### Permission Mode Synchronization

Permission modes flow bidirectionally between the leader and teammates through the team file:

- **Leader → Teammate**: `setMemberMode(teamName, memberName, mode)` updates a single member's mode. The leader calls this from the TeamsDialog UI. It performs a no-op optimization when the mode hasn't changed (`src/utils/swarm/teamHelpers.ts:376-378`).

- **Batch update**: `setMultipleMemberModes(teamName, modeUpdates)` atomically updates multiple members in a single file write, avoiding race conditions from sequential single-member updates (`src/utils/swarm/teamHelpers.ts:415-445`). Uses a `Map` for O(1) lookup of updates during the member array pass.

- **Teammate → Leader**: `syncTeammateMode(mode)` is called by a teammate process to write its own mode back to the team file. It's a no-op if the caller isn't running as a teammate (`src/utils/swarm/teamHelpers.ts:397-407`).

### Activity Status Tracking

`setMemberActive(teamName, memberName, isActive)` (`src/utils/swarm/teamHelpers.ts:454-485`) is the async counterpart for tracking whether a teammate is currently working or idle. Like `setMemberMode`, it includes a change-detection guard to avoid unnecessary file writes.

### Hidden Pane Management

Two functions manage the `hiddenPaneIds` array on the team file:

- `addHiddenPaneId(teamName, paneId)` — Adds a pane to the hidden list (deduplicated)
- `removeHiddenPaneId(teamName, paneId)` — Removes a pane from the hidden list

These control which teammate panes are visible in the terminal UI.

### Session Cleanup Flow

Cleanup runs on three levels, triggered at session exit:

1. **`registerTeamForSessionCleanup(teamName)`** / **`unregisterTeamForSessionCleanup(teamName)`** (`src/utils/swarm/teamHelpers.ts:560-570`) — Tracks which teams were created this session using a `Set` stored in `bootstrap/state.ts` (so it's reset between tests).

2. **`cleanupSessionTeams()`** (`src/utils/swarm/teamHelpers.ts:576-590`) — Registered with `gracefulShutdown`. For each session-created team that wasn't explicitly deleted:
   - First kills orphaned panes via `killOrphanedTeammatePanes()`
   - Then removes directories via `cleanupTeamDirectories()`
   - Clears the tracking set

3. **`killOrphanedTeammatePanes(teamName)`** (`src/utils/swarm/teamHelpers.ts:598-634`) — Dynamically imports backend modules (registry, detection) to avoid adding them to the static dependency graph. Filters for pane-backed members (excluding the team lead), then calls `backend.killPane()` on each.

4. **`cleanupTeamDirectories(teamName)`** (`src/utils/swarm/teamHelpers.ts:641-683`) — The full teardown sequence:
   - Reads the team file to collect worktree paths **before** deletion
   - Destroys each git worktree via `destroyWorktree()`
   - Removes the team directory (`~/.claude/teams/{team-name}/`)
   - Removes the tasks directory (`~/.claude/tasks/{sanitized-name}/`)
   - Notifies task UI of the update

### Git Worktree Destruction

`destroyWorktree(worktreePath)` (`src/utils/swarm/teamHelpers.ts:492-551`) performs a two-tier removal:

1. Parses the `.git` file inside the worktree to discover the main repo path (the `.git` file contains a `gitdir:` pointer)
2. Attempts `git worktree remove --force`
3. Falls back to `rm -rf` if git removal fails (e.g., corrupt worktree state)

## Function Signatures

### Path Helpers

- **`sanitizeName(name: string): string`** — Replaces non-alphanumeric chars with hyphens, lowercases. Used for directory names and tmux window names.
- **`sanitizeAgentName(name: string): string`** — Replaces `@` with `-` to prevent ambiguity in the `agentName@teamName` format.
- **`getTeamDir(teamName: string): string`** — Returns `~/.claude/teams/{sanitized-name}/`.
- **`getTeamFilePath(teamName: string): string`** — Returns `~/.claude/teams/{sanitized-name}/config.json`.

### Read/Write

- **`readTeamFile(teamName): TeamFile | null`** — Sync read, returns `null` on missing file.
- **`readTeamFileAsync(teamName): Promise<TeamFile | null>`** — Async read.
- **`writeTeamFileAsync(teamName, teamFile): Promise<void>`** — Async write (exported).

### Member Mutation

- **`removeTeammateFromTeamFile(teamName, { agentId?, name? }): boolean`**
- **`removeMemberFromTeam(teamName, tmuxPaneId): boolean`**
- **`removeMemberByAgentId(teamName, agentId): boolean`**
- **`setMemberMode(teamName, memberName, mode): boolean`**
- **`setMultipleMemberModes(teamName, modeUpdates): boolean`**
- **`syncTeammateMode(mode, teamNameOverride?): void`**
- **`setMemberActive(teamName, memberName, isActive): Promise<void>`**

### Pane Visibility

- **`addHiddenPaneId(teamName, paneId): boolean`**
- **`removeHiddenPaneId(teamName, paneId): boolean`**

### Cleanup

- **`registerTeamForSessionCleanup(teamName): void`**
- **`unregisterTeamForSessionCleanup(teamName): void`**
- **`cleanupSessionTeams(): Promise<void>`**
- **`cleanupTeamDirectories(teamName): Promise<void>`**

## Edge Cases & Caveats

- **No file locking**: Read-modify-write cycles are not protected by file locks. The `setMultipleMemberModes` function exists specifically to reduce race windows by batching updates into a single write.
- **Sync vs. async duality**: The sync `writeTeamFile` is private while async `writeTeamFileAsync` is exported. All sync mutations (remove, setMode, hiddenPane) use the private sync writer internally. Mixing sync and async callers on the same file could produce lost-update races.
- **Worktree cleanup is best-effort**: `destroyWorktree` catches and logs all errors rather than propagating them, ensuring one failed worktree removal doesn't block cleanup of the rest.
- **Dynamic imports in `killOrphanedTeammatePanes`**: Backend modules (`registry.js`, `detection.js`) are dynamically imported at shutdown time to avoid circular dependencies in the static module graph.
- **`isActive` defaults**: `undefined` and `true` are both treated as "active" — only an explicit `false` means idle. Consumers should use `member.isActive !== false` rather than `member.isActive === true`.
- **Session cleanup tracking**: The backing `Set` lives in `bootstrap/state.ts` (not in this module) so that `resetStateForTests()` clears it between test shards, preventing cross-shard leaks (referenced as PR #17615).