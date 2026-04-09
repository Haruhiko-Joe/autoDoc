# IntegrationCommands

## Overview & Responsibilities

IntegrationCommands is a collection of slash commands within the **CommandSystem** module that connect Claude Code with external platforms, manage plugins, and control integrations. These commands let users set up and manage connections to IDEs, browsers, mobile apps, GitHub/Slack, MCP servers, plugins, voice input, and remote-control sessions — all from within the CLI.

Within the top-level architecture, IntegrationCommands sits inside **CommandSystem**, which is invoked by the **TerminalUI** when a user types a slash command. Many integration commands delegate to **Services** (MCP client, OAuth, analytics) and **Infrastructure** (config, auth, permissions). The sibling command groups cover session management, configuration, development workflows, and diagnostics.

---

## Command Inventory

| Command | Aliases | Type | Availability | Purpose |
|---------|---------|------|-------------|----------|
| `/mcp` | — | local-jsx | all | Manage MCP server connections |
| `/ide` | — | local-jsx | all | Connect to VS Code / JetBrains IDEs |
| `/desktop` | `/app` | local-jsx | claude-ai | Hand off session to Claude Desktop |
| `/chrome` | — | local-jsx | claude-ai | Chrome extension settings |
| `/mobile` | `/ios`, `/android` | local-jsx | all | QR code for mobile app download |
| `/install-github-app` | — | local-jsx | claude-ai, console | Multi-step GitHub App + Actions wizard |
| `/install-slack-app` | — | local | claude-ai | Open Slack app marketplace |
| `/install` | — | local-jsx | all | Native binary installer/updater |
| `/plugin` | `/plugins`, `/marketplace` | local-jsx | all | Plugin marketplace & management |
| `/reload-plugins` | — | local | all | Activate pending plugin changes |
| `/agents` | — | local-jsx | all | Manage agent configurations |
| `/skills` | — | local-jsx | all | List available skills |
| `/tasks` | `/bashes` | local-jsx | all | Manage background tasks |
| `/remote-control` | `/rc` | local-jsx | feature-gated | Bridge session for remote control |
| `/bridge-kick` | — | local | ant-only | Inject bridge failure states (debug) |
| `/voice` | — | local | claude-ai | Toggle voice input mode |
| `/web-setup` | — | local-jsx | claude-ai | GitHub token import for web Claude Code |
| `/brief` | — | local-jsx | feature-gated | Toggle brief-only output mode |

---

## MCP Server Management (`/mcp`)

### Entry Point

The command is registered at `src/commands/mcp/index.ts` as a `local-jsx` command. The main handler in `src/commands/mcp/mcp.tsx` dispatches to subcommands:

- **Default** — renders `<MCPSettings>` dialog for interactive server management
- **`enable [all|<name>]`** / **`disable [all|<name>]`** — toggles servers on/off (filters out the `ide` server)
- **`reconnect <name>`** — reconnects to a specific server
- **`no-redirect`** — shows settings inline without redirecting

### `mcp add` Subcommand

Defined in `src/commands/mcp/addCommand.ts` (~280 lines). Registers a new MCP server with full transport and auth support.

**Syntax:** `claude mcp add <name> <commandOrUrl> [args...]`

**Key options:**
- `-s, --scope <scope>` — `local` (default), `user`, or `project`
- `-t, --transport <transport>` — `stdio`, `sse`, or `http`
- `-e, --env <env...>` — environment variables (`KEY=value`)
- `-H, --header <header...>` — HTTP headers for SSE/HTTP transports
- `--client-id`, `--client-secret`, `--callback-port` — OAuth configuration
- `--xaa` — enable XAA (SEP-990) cross-app authentication

**Validation flow** (`src/commands/mcp/addCommand.ts:140-260`):
1. Server name validated (alphanumeric, hyphens, underscores)
2. Enterprise policy checked via `isMcpServerDenied()` / `isMcpServerAllowedByPolicy()`
3. Transport inferred or validated (URLs default to HTTP; commands to stdio)
4. Config written via `addMcpConfig(name, config, scope)`

**Configuration formats by transport:**
- **Stdio:** `{ type: 'stdio', command, args, env }`
- **SSE:** `{ type: 'sse', url, headers?, oauth? }`
- **HTTP:** `{ type: 'http', url, headers?, oauth? }`

### XAA IdP Management

Defined in `src/commands/mcp/xaaIdpCommand.ts` (~267 lines). Only registered when `isXaaEnabled()` returns true.

| Subcommand | Purpose |
|---|---|
| `mcp xaa setup --issuer <url> --client-id <id>` | One-time OIDC IdP configuration; stores in settings + keychain |
| `mcp xaa login [--force] [--id-token <jwt>]` | Cache an IdP id_token via browser OIDC flow with PKCE |
| `mcp xaa show` | Display current IdP connection config and login status |
| `mcp xaa clear` | Remove all IdP config and cached tokens |

### Configuration Scopes

MCP configs live in a hierarchy of scopes (from highest to lowest precedence): `enterprise` (read-only) → `managed` (read-only) → `project` (`.mcp.json`) → `user` (`~/.claude/config.json`) → `local` (project-local config). The `addMcpConfig()` function in `src/services/mcp/config.ts:625` validates against schemas and enterprise policies before writing.

---

## IDE Integration (`/ide`)

### Entry Point

`src/commands/ide/index.ts` registers the command with argument hint `[open]`. The main logic lives in `src/commands/ide/ide.tsx` (~645 lines).

### Connection Flow

1. **Detection** — reads lockfiles from `~/.claude/ide/` via `detectIDEs()` (`src/utils/ide.ts:664-820`). Each lockfile contains the IDE name, port, workspace folders, auth token, and optional Windows flag.
2. **Validation** — filters IDEs into "available" (workspace matches cwd) and "unavailable" (workspace mismatch). Path normalization handles macOS Unicode (NFC), WSL, and case-insensitive Windows paths.
3. **Selection** — `IDEScreen` component (`src/commands/ide/ide.tsx:25-197`) presents a selection dialog. Shows instance counts for duplicate IDE names and workspace folders for disambiguation.
4. **MCP Configuration** — on selection, `handleSelectIDE()` (`src/commands/ide/ide.tsx:554-597`) creates a dynamic MCP config:
   ```
   { type: 'sse-ide' or 'ws-ide', url, ideName, authToken, scope: 'dynamic' }
   ```
5. **Connection monitoring** — a `useEffect` hook watches the `ide` MCP client state for `connected` or `failed`, with a 35-second timeout (`IDE_CONNECTION_TIMEOUT_MS`).

### Open Project in IDE

When invoked as `/ide open`:
- **VS Code / Cursor / Windsurf** — executes `code <path>` via `execFileNoThrow`
- **JetBrains** — displays a manual-open instruction (JetBrains uses its own CLI)
- Supports worktree paths

### Supported IDEs

Defined in `src/utils/ide.ts:130-226`:
- **VS Code family:** VS Code, Cursor, Windsurf
- **JetBrains family:** PyCharm, IntelliJ, WebStorm, PhpStorm, RubyMine, CLion, GoLand, Rider, DataGrip, AppCode, DataSpell, Aqua, Gateway, Fleet, Android Studio

### Auto-Connect

`src/components/IdeAutoConnectDialog.tsx` provides a dialog that asks whether to enable auto-connect to IDE. The `autoConnectIde` config boolean is persisted and checked on startup.

---

## GitHub App Installation (`/install-github-app`)

### Entry Point

`src/commands/install-github-app/index.ts` — available on `claude-ai` and `console`. The main orchestrator is `src/commands/install-github-app/install-github-app.tsx` (~586 lines).

### State Machine Wizard

The wizard is a React state machine with the following steps:

```
check-gh → warnings? → choose-repo → install-app → check-existing-workflow?
→ check-existing-secret? → api-key? → oauth-flow? → creating → success | error
```

**State shape** (`src/commands/install-github-app/install-github-app.tsx:27-44`):
- `step` — current wizard step
- `selectedRepoName`, `currentRepo`, `useCurrentRepo` — repository selection
- `apiKeyOrOAuthToken`, `authType` — credential storage
- `selectedWorkflows` — `'claude'` and/or `'claude-review'`
- `secretName`, `secretExists`, `useExistingSecret` — GitHub secret management
- `warnings` — collected pre-flight warnings

### Step Components (14 files)

| Component | File | Purpose |
|-----------|------|---------|
| `CheckGitHubStep` | `CheckGitHubStep.tsx` | Verifies `gh` CLI installed, authenticated, has `repo` + `workflow` scopes |
| `WarningsStep` | `WarningsStep.tsx` | Displays configuration warnings with fix instructions |
| `ChooseRepoStep` | `ChooseRepoStep.tsx` | Current repo toggle or custom `owner/repo` input with validation |
| `InstallAppStep` | `InstallAppStep.tsx` | Prompts user to install Claude GitHub App at `https://github.com/apps/claude` |
| `ExistingWorkflowStep` | `ExistingWorkflowStep.tsx` | Handles `.github/workflows/claude.yml` conflicts (Update / Skip / Exit) |
| `CheckExistingSecretStep` | `CheckExistingSecretStep.tsx` | Manages `ANTHROPIC_API_KEY` secret; custom name with validation |
| `ApiKeyStep` | `ApiKeyStep.tsx` | Three options: existing local key, new key entry, or OAuth |
| `OAuthFlowStep` | `OAuthFlowStep.tsx` | Full OAuth authorization_code flow with browser + manual code fallback |
| `CreatingStep` | `CreatingStep.tsx` | Progress indicator through setup phases |
| `SuccessStep` | `SuccessStep.tsx` | Completion confirmation with next-step guidance |
| `ErrorStep` | `ErrorStep.tsx` | Error display with reason and fix instructions |

### GitHub Actions Setup

`src/commands/install-github-app/setupGitHubActions.ts` (~325 lines) performs the actual repository configuration:

1. Validate repository access via `gh api repos/{repo}` (`line 137-153`)
2. Get default branch and HEAD SHA (`line 156-192`)
3. Create feature branch `add-claude-github-actions-{timestamp}` (`line 196-218`)
4. Create/update workflow files via `gh api --method PUT` (`line 220-250`)
5. Set API key secret via `gh secret set` (`line 254-282`)
6. Open browser to pre-filled PR creation URL (`line 285-290`)

The `createWorkflowFile()` helper (`line 17-109`) handles workflow template rendering with secret name substitution and SHA-based conflict detection.

---

## Plugin Management (`/plugin`)

### Entry Point

`src/commands/plugin/index.tsx` registers with aliases `plugins` and `marketplace`. The argument parser in `src/commands/plugin/parseArgs.ts` supports rich subcommand syntax:

```
/plugin                         → Main menu (tabs: discover, installed, marketplaces, errors)
/plugin install [plugin[@marketplace]]  → Browse/install plugins
/plugin manage                  → Manage installed plugins
/plugin uninstall [plugin]      → Uninstall
/plugin enable|disable [plugin] → Toggle plugin
/plugin validate [path]         → Validate manifest
/plugin marketplace list|add|remove|update  → Marketplace management
```

### Architecture (17 files)

The plugin system is built around a tabbed settings UI (`PluginSettings.tsx`) with four tabs:

| Tab | Component | Purpose |
|-----|-----------|--------|
| Discover | `DiscoverPlugins.tsx` | Browse all plugins across all marketplaces; search by name/description; bulk install |
| Installed | `ManagePlugins.tsx` | View installed plugins; enable/disable/uninstall; view flagged/failed plugins; inspect MCP servers and tools |
| Marketplaces | `ManageMarketplaces.tsx` | Add/remove/update custom marketplace sources; auto-update toggle |
| Errors | `PluginErrors.tsx` | Aggregated error display with actionable guidance |

### Discovery & Installation Flow

`DiscoverPlugins.tsx` loads plugins through this pipeline:
1. Load marketplace configs via `loadKnownMarketplacesConfig()`
2. Fetch marketplace data via `loadMarketplacesWithGracefulDegradation()` (partial failures tolerated)
3. Filter out already-installed plugins (`isPluginGloballyInstalled()`)
4. Block policy-denied plugins (`isPluginBlockedByPolicy()`)
5. Sort by install count popularity
6. Display with continuous-scroll pagination (`usePagination.ts`)

Installation supports three scopes:
- **User** — available in all projects
- **Project** — shared with collaborators via repo config
- **Local** — current project only, not shared

### Trust & Security

`PluginTrustWarning.tsx` displays before installation:
> "Make sure you trust a plugin before installing, updating, or using it. Anthropic does not control what MCP servers, files, or other software are included in plugins and cannot verify that they will work as intended or that they won't change."

Custom trust messages can be set via `getPluginTrustMessage()`.

### Plugin Configuration

`PluginOptionsFlow.tsx` and `PluginOptionsDialog.tsx` provide an interactive configuration flow:
- Sequential field-by-field input with progress indicator ("Field N of Total")
- Sensitive fields are never prepopulated on reconfigure; empty values preserve existing secrets
- Type coercion for number/boolean/string fields
- Required-field validation

### Validation

`ValidatePlugin.tsx` validates plugin or marketplace manifest files, returning structured results with errors, warnings, file type (`plugin` or `marketplace`), and exit codes (0 = success, 1 = failed, 2 = unexpected error).

---

## Platform Integration Commands

### Desktop (`/desktop`)

`src/commands/desktop/index.ts` — aliases: `/app`. Available on macOS and Windows x64 only. Renders a `<DesktopHandoff>` component that enables continuation of the current CLI session in the Claude Desktop application.

### Chrome (`/chrome`)

`src/commands/chrome/chrome.tsx` — manages the Chrome extension integration (Beta). The `ClaudeInChromeMenu` component provides:
- Extension installation status detection via MCP client (`claudeInChrome`)
- Actions: install extension, reconnect, manage permissions, toggle default
- Status display: enabled/disabled, extension installed/not detected
- CLI flags: `claude --chrome` / `claude --no-chrome`
- WSL not supported; requires Claude.ai subscription

### Mobile (`/mobile`)

`src/commands/mobile/mobile.tsx` — aliases: `/ios`, `/android`. Generates QR codes for iOS App Store and Google Play downloads. Platform switching via keyboard; quit with `q` or Ctrl+C.

### Slack App (`/install-slack-app`)

`src/commands/install-slack-app/install-slack-app.ts` (~30 lines) — opens the Slack marketplace URL in a browser, logs the `tengu_install_slack_app_clicked` analytics event, and increments the `slackAppInstallCount` config counter.

### Install (`/install`)

`src/commands/install.tsx` — the native binary installer/updater. Progresses through states: `checking` → `cleaning-npm` → `installing` → `setting-up` → `set-up` → `success`. Key operations:
- Runs `installLatest(channelOrVersion, force)` for native binary installation
- Cleans up old npm installations and shell aliases
- Configures `autoUpdatesChannel` preference
- Platform-specific install path: `~/.local/bin/claude` (Unix) or Windows equivalent

---

## Session & Remote Control

### Bridge (`/remote-control`)

`src/commands/bridge/bridge.tsx` — aliases: `/rc`. Feature-gated via `BRIDGE_MODE` flag. The `BridgeToggle` component:
1. Runs pre-flight checks via `checkBridgePrerequisites()`
2. Sets `replBridgeEnabled` in AppState to trigger bridge initialization in the REPL
3. Displays session URL and QR code via `BridgeDisconnectDialog`
4. Supports disconnect action with analytics tracking

This enables remote control of the CLI session from claude.ai via WebSocket.

### Bridge Kick (`/bridge-kick`)

`src/commands/bridge-kick.ts` (~201 lines) — an Anthropic-internal debug command (`USER_TYPE === 'ant'`). Injects failure states into the bridge for manual recovery testing:
- `close <code>` — simulate WebSocket close
- `poll <status>` — inject poll failures
- `register fail|fatal` — inject registration faults
- `reconnect-session fail` — inject reconnect failures
- `heartbeat <status>` — inject heartbeat failures
- `reconnect` — trigger reconnection
- `status` — print bridge state

### Web Setup (`/web-setup`)

`src/commands/remote-setup/` — sets up Claude Code for web use. The flow:
1. Checks login state and GitHub CLI authentication
2. Presents confirmation dialog with GitHub token
3. Imports token via `importGithubToken()` (`src/commands/remote-setup/api.ts:51-100`) — POSTs to `/v1/code/github/import-token`
4. Creates default remote environment via `createDefaultEnvironment()` — Python 3.11, Node 20, network config

The `RedactedGithubToken` class (`src/commands/remote-setup/api.ts:16-33`) wraps raw tokens with safe `toString()` / `toJSON()` overrides returning `[REDACTED:gh-token]`.

---

## Voice Input (`/voice`)

`src/commands/voice/voice.ts` (~150 lines) — toggles voice mode with comprehensive pre-flight validation:

1. **Kill-switch check** — `isVoiceModeEnabled()` must return true
2. **Account check** — requires Claude.ai account
3. **API availability check** — verifies voice API reachable
4. **Recording availability check** — validates audio input
5. **Voice dependencies check** — ensures required dependencies installed
6. **Microphone permission** — platform-specific permission request with guidance

On success, enables push-to-talk with STT language configuration via `normalizeLanguageForSTT()`. Language hints are shown up to 2 times via config tracking.

---

## Utility Commands

### Agents (`/agents`)

`src/commands/agents/agents.tsx` — renders `<AgentsMenu>` with the current tool set and permission context. Provides UI for managing available agent configurations.

### Skills (`/skills`)

`src/commands/skills/skills.tsx` — renders `<SkillsMenu>` with available commands. Lists all registered skills.

### Tasks (`/tasks`)

`src/commands/tasks/tasks.tsx` — aliases: `/bashes`. Renders `<BackgroundTasksDialog>` for managing long-running background operations.

### Reload Plugins (`/reload-plugins`)

`src/commands/reload-plugins/reload-plugins.ts` (~62 lines) — re-downloads user settings in remote mode, then calls `refreshActivePlugins()`. Returns a summary with counts of reloaded plugins, skills, agents, hooks, MCP servers, and LSP servers.

### Brief (`/brief`)

`src/commands/brief.ts` (~131 lines) — toggles brief-only mode, which compresses output to tool-only format. Feature-gated via `KAIROS` / `KAIROS_BRIEF` flags with `enable_slash_command` config. Checks entitlement via `isBriefEntitled()` before enabling.

---

## Key Design Patterns

### Command Registration

All commands follow a consistent pattern in their `index.ts`:
```typescript
export default {
  type: 'local-jsx' | 'local',
  name: string,
  aliases?: string[],
  description: string,
  isEnabled?: () => boolean,
  availability?: string[],
  load: () => import('./handler.js'),
}
```

JSX commands (`local-jsx`) return React components for interactive UIs via Ink. Local commands return string results.

### Feature Gating

Many commands are gated behind GrowthBook feature flags (`BRIDGE_MODE`, `KAIROS`, `tengu_cobalt_lantern`, etc.) and/or availability arrays (`['claude-ai']`, `['claude-ai', 'console']`). The `isEnabled` function performs runtime checks.

### Analytics

All integration commands log analytics events via `logEvent()` with structured properties. Common event prefixes: `tengu_install_github_app_*`, `tengu_bridge_command`, `tengu_voice_toggled`, `tengu_remote_setup_result`.

### Lazy Loading

Commands use dynamic `import()` in their `load` property for code splitting — the heavy JSX components are only loaded when the command is invoked.

---

## Edge Cases & Caveats

- **MCP `ide` server** is filtered from bulk enable/disable operations in `/mcp` to prevent accidental disconnection (`src/commands/mcp/mcp.tsx`)
- **IDE detection** normalizes paths to NFC for macOS Unicode compatibility and handles WSL path conversion for Windows-hosted IDEs (`src/utils/ide.ts`)
- **GitHub App wizard** specifically catches "workflow file already exists" errors and routes to the conflict resolution step rather than failing (`src/commands/install-github-app/install-github-app.tsx`)
- **Plugin sensitive fields** are never prepopulated on reconfigure — empty submissions preserve existing secrets in storage (`src/commands/plugin/PluginOptionsDialog.tsx:24-44`)
- **XAA setup** requires HTTPS for the issuer URL, except `http://localhost` for testing (`src/commands/mcp/xaaIdpCommand.ts`)
- **Bridge kick** is restricted to `USER_TYPE === 'ant'` — it is a debug-only command not exposed to end users
- **Voice mode** limits language hint display to 2 occurrences via config counter to avoid repetitive messaging
- **GitHub token import** uses a `RedactedGithubToken` wrapper to prevent accidental token leakage in logs (`src/commands/remote-setup/api.ts:16-33`)