# TeammateConfig

## Overview & Responsibilities

TeammateConfig is a collection of shared utilities within the **SwarmHelpers** subsystem (under **Infrastructure > CoreUtilities**) that handle the configuration, spawning, initialization, and lifecycle management of teammate agents in Claude Code's multi-agent "swarm" system. When a team leader creates teammates, these modules provide the glue code that determines how teammate processes are launched, what settings they inherit, how they rejoin after disconnection, and how they present themselves visually in terminal panes.

Sibling modules in SwarmHelpers handle the lower-level terminal multiplexer backends (tmux, iTerm2, in-process) and team file management; TeammateConfig sits one layer above, providing the coordination logic that those backends rely on.

The module spans 8 files (~552 lines):

| File | Purpose |
|------|---------|
| `constants.ts` | Session/socket naming constants and env var identifiers |
| `spawnUtils.ts` | CLI flag and environment variable inheritance for spawned teammates |
| `teammateInit.ts` | Post-spawn initialization hooks (idle notification, permission rules) |
| `teammateModel.ts` | Model fallback selection for new teammates |
| `teammatePromptAddendum.ts` | System prompt addendum for SendMessage requirements |
| `teammateLayoutManager.ts` | Color assignment and pane creation delegation |
| `reconnection.ts` | Session resumption with team context restoration |
| `It2SetupPrompt.tsx` | React component for interactive iTerm2 CLI installation |

## Key Processes

### Teammate Spawning Flow

When the team leader needs to spawn a new teammate, several modules collaborate:

1. **Resolve the command**: `getTeammateCommand()` checks the `CLAUDE_CODE_TEAMMATE_COMMAND` env var; if unset, it falls back to `process.execPath` (bundled mode) or `process.argv[1]` (`src/utils/swarm/spawnUtils.ts:23-28`).

2. **Build inherited CLI flags**: `buildInheritedCliFlags()` constructs a flag string propagating the leader's settings to the child process (`src/utils/swarm/spawnUtils.ts:38-89`):
   - Permission mode (`--dangerously-skip-permissions`, `--permission-mode acceptEdits`) — suppressed when `planModeRequired` is true for safety
   - Model override (`--model`)
   - Settings path (`--settings`)
   - Inline plugins (`--plugin-dir` for each)
   - Teammate mode (`--teammate-mode`)
   - Chrome flag override (`--chrome` / `--no-chrome`)

3. **Build inherited env vars**: `buildInheritedEnvVars()` constructs an `env KEY=VALUE ...` string that always includes `CLAUDECODE=1` and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, plus conditionally forwards ~18 environment variables for API provider selection, proxy/TLS config, CCR markers, and config directory overrides (`src/utils/swarm/spawnUtils.ts:96-146`).

4. **Assign a color**: `assignTeammateColor()` in the layout manager picks the next color from `AGENT_COLORS` in round-robin order (`src/utils/swarm/teammateLayoutManager.ts:22-33`).

5. **Create a pane**: `createTeammatePaneInSwarmView()` delegates to the auto-detected backend (tmux, iTerm2, or external tmux session) to create the visual pane (`src/utils/swarm/teammateLayoutManager.ts:76-82`).

### Teammate Initialization Flow

After a teammate process starts, `initializeTeammateHooks()` is called with the `AppState` setter, session ID, and team info (`src/utils/swarm/teammateInit.ts:28-129`):

1. **Read the team file** to discover the leader's agent ID and any team-wide allowed paths.

2. **Apply team permission rules**: For each entry in `teamFile.teamAllowedPaths`, it creates an `allow` permission rule (e.g., `//absolute/path/**` or `relative/path/**`) scoped to a specific tool and applies it to the session's `toolPermissionContext`.

3. **Register a Stop hook** (skipped if this agent *is* the leader): When the teammate's session stops, the hook:
   - Marks the teammate as idle in the team config via `setMemberActive(teamName, agentName, false)`
   - Sends an idle notification to the team leader's mailbox with a summary of the last peer DM
   - Returns `true` to avoid blocking the Stop event
   - Has a 10-second timeout to prevent hanging on shutdown

### Reconnection Flow

When a session is resumed (fresh spawn or session restore), the reconnection module provides two entry points:

1. **`computeInitialTeamContext()`** — called synchronously in `main.tsx` *before* first render. Reads `dynamicTeamContext` from CLI args and the team file to produce the initial `teamContext` for `AppState`. Determines `isLeader` based on whether `agentId` is present (`src/utils/swarm/reconnection.ts:23-66`).

2. **`initializeTeammateContextFromSession()`** — called when resuming a session that has `teamName`/`agentName` stored in the transcript. Looks up the member in the team file to recover `agentId`, then sets `teamContext` in `AppState` with `isLeader: false` (`src/utils/swarm/reconnection.ts:75-119`).

### iTerm2 Setup Flow (It2SetupPrompt)

The `It2SetupPrompt` React component guides users through installing the `it2` CLI tool for native iTerm2 split pane support (`src/utils/swarm/It2SetupPrompt.tsx`). It is a multi-step wizard with these states:

1. **initial**: Detects available Python package manager (`uvx`, `pipx`, or `pip`) on mount. Presents options: install, use tmux instead, or cancel.
2. **installing**: Runs `installIt2(packageManager)`. On success, transitions to API instructions.
3. **install-failed**: Shows error with manual install command, offers retry/tmux/cancel.
4. **api-instructions**: Displays Python API setup instructions; user presses Enter to verify.
5. **verifying**: Calls `verifyIt2Setup()` to confirm communication with iTerm2.
6. **success**: Shows confirmation, auto-calls `onDone('installed')` after 1.5 seconds.
7. **failed**: Verification failed — prompts to check iTerm2 Python API preferences, offers retry/tmux/cancel.

The component signals its result via `onDone('installed' | 'use-tmux' | 'cancelled')`.

## Function Signatures

### constants.ts

#### `getSwarmSocketName(): string`
Returns a PID-scoped tmux socket name (`claude-swarm-{pid}`) to isolate swarm operations from the user's tmux sessions.

### spawnUtils.ts

#### `getTeammateCommand(): string`
Resolves the executable path for spawning teammates. Checks `TEAMMATE_COMMAND_ENV_VAR`, falls back to `process.execPath` or `process.argv[1]`.

#### `buildInheritedCliFlags(options?: { planModeRequired?: boolean; permissionMode?: PermissionMode }): string`
Builds a space-separated string of CLI flags to propagate to child teammate processes. `planModeRequired` suppresses bypass permission inheritance.

#### `buildInheritedEnvVars(): string`
Builds a space-separated `KEY=VALUE` string for forwarding environment variables to tmux-spawned teammates.

### teammateInit.ts

#### `initializeTeammateHooks(setAppState, sessionId, teamInfo: { teamName, agentId, agentName }): void`
Registers initialization hooks for a teammate: applies team-wide permission rules and sets up the Stop hook for idle notification.

### teammateModel.ts

#### `getHardcodedTeammateModelFallback(): string`
Returns the default model ID for new teammates (currently Claude Opus 4.6), using the correct provider-specific model ID for the active API provider (firstParty, Bedrock, Vertex, or Foundry).

> Source: `src/utils/swarm/teammateModel.ts:8-10`

### teammateLayoutManager.ts

#### `assignTeammateColor(teammateId: string): AgentColorName`
Assigns a color from the `AGENT_COLORS` palette in round-robin order, returning existing assignment if already assigned.

#### `getTeammateColor(teammateId: string): AgentColorName | undefined`
Looks up a previously assigned color for a teammate.

#### `clearTeammateColors(): void`
Resets all color assignments and the round-robin index.

#### `createTeammatePaneInSwarmView(teammateName, teammateColor): Promise<{ paneId: string; isFirstTeammate: boolean }>`
Creates a new pane in the swarm view using the auto-detected backend.

#### `enablePaneBorderStatus(windowTarget?, useSwarmSocket?): Promise<void>`
Enables pane border status display (shows pane titles) via the detected backend.

#### `sendCommandToPane(paneId, command, useSwarmSocket?): Promise<void>`
Sends a command to a specific pane via the detected backend.

### reconnection.ts

#### `computeInitialTeamContext(): AppState['teamContext'] | undefined`
Synchronously computes initial team context from CLI args. Returns `undefined` if not running as a teammate.

#### `initializeTeammateContextFromSession(setAppState, teamName, agentName): void`
Restores team context into `AppState` when resuming a saved session.

## Constants & Environment Variables

### Naming Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `TEAM_LEAD_NAME` | `'team-lead'` | Default name for the team leader |
| `SWARM_SESSION_NAME` | `'claude-swarm'` | tmux session name for swarm operations |
| `SWARM_VIEW_WINDOW_NAME` | `'swarm-view'` | tmux window name for the swarm view |
| `TMUX_COMMAND` | `'tmux'` | The tmux binary name |
| `HIDDEN_SESSION_NAME` | `'claude-hidden'` | Name for hidden background sessions |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_TEAMMATE_COMMAND` | Override the executable used to spawn teammates |
| `CLAUDE_CODE_AGENT_COLOR` | Set on spawned teammates to indicate their assigned color |
| `CLAUDE_CODE_PLAN_MODE_REQUIRED` | When `'true'`, requires teammates to use plan mode before writing code |

### Forwarded Environment Variables

`buildInheritedEnvVars()` explicitly forwards these variables to tmux-spawned teammates (since tmux may start a fresh login shell):

- **API provider**: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`
- **Custom endpoint**: `ANTHROPIC_BASE_URL`
- **Config**: `CLAUDE_CONFIG_DIR`
- **CCR**: `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_REMOTE_MEMORY_DIR`
- **Proxy/TLS**: `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`, `NO_PROXY`, `no_proxy`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`

## System Prompt Addendum

The `TEAMMATE_SYSTEM_PROMPT_ADDENDUM` constant (`src/utils/swarm/teammatePromptAddendum.ts:8-18`) is appended to the teammate's system prompt. It instructs the model that:

- It must use `SendMessage` with `to: "<name>"` for peer communication
- It can use `to: "*"` for team-wide broadcasts (sparingly)
- Plain text responses are **not visible** to teammates — `SendMessage` is required
- The user interacts primarily with the team lead

## Edge Cases & Caveats

- **Plan mode overrides bypass permissions**: When `planModeRequired` is `true`, `buildInheritedCliFlags()` intentionally does *not* propagate `--dangerously-skip-permissions`, even if the parent session uses bypass mode. This is a safety guardrail (`src/utils/swarm/spawnUtils.ts:47-48`).

- **PID-scoped socket names**: `getSwarmSocketName()` includes `process.pid` to prevent conflicts between concurrent Claude instances running swarms.

- **Env var forwarding is explicit**: Only the variables in the `TEAMMATE_ENV_VARS` list are forwarded. Notably, pipe-based file descriptor env vars (like CCR auth FD tokens) are *not* forwarded because pipe FDs don't survive crossing the tmux boundary.

- **Reconnected sessions are always non-leaders**: `initializeTeammateContextFromSession()` always sets `isLeader: false`, since only teammates store `teamName`/`agentName` in their transcript for later recovery.

- **Color assignment is session-scoped**: The `teammateColorAssignments` map lives in module-level state. Calling `clearTeammateColors()` resets it, which should happen during team cleanup before creating a new team.

- **It2SetupPrompt fallback**: If no Python package manager is detected, the component shows an error immediately rather than attempting installation. Users can always fall back to tmux if available.