# Configuration Commands

## Overview & Responsibilities

The Configuration Commands module is a collection of 20+ slash commands within the Claude Code **CommandSystem** that allow users to configure CLI behavior, appearance, and preferences at runtime. These commands sit between the **TerminalUI** (which dispatches slash commands) and the **Infrastructure** layer (which persists settings to config files). Most commands follow a two-file pattern: an `index.ts` that registers metadata (name, aliases, description, visibility) and a lazily-loaded implementation file that handles the actual logic.

Within the broader architecture, the CommandSystem dispatches user-entered slash commands to these handlers. Each configuration command reads and/or mutates state via the Infrastructure layer's settings utilities (`src/utils/config.ts`, `src/utils/settings/settings.ts`), application state (`src/state/AppState.tsx`), or external APIs.

## Command Catalog

| Command | Aliases | Type | Description |
|---------|---------|------|-------------|
| `/config` | `/settings` | local-jsx | Opens the full settings panel UI |
| `/theme` | — | local-jsx | Interactive theme picker |
| `/color` | — | local-jsx | Set session prompt bar color |
| `/model` | — | local-jsx | Set or view the AI model |
| `/vim` | — | local | Toggle vim/normal editing mode |
| `/keybindings` | — | local | Open keybindings config file in editor |
| `/permissions` | `/allowed-tools` | local-jsx | Manage allow/deny tool permission rules |
| `/hooks` | — | local-jsx | View hook configurations for tool events |
| `/fast` | — | local-jsx | Toggle fast mode (faster output) |
| `/effort` | — | local-jsx | Set reasoning effort level |
| `/output-style` | — | local-jsx | **Deprecated** — redirects to `/config` |
| `/privacy-settings` | — | local-jsx | View/update privacy settings (consumer only) |
| `/sandbox` | — | local-jsx | Configure command sandboxing |
| `/statusline` | — | prompt | Set up status line UI from shell PS1 |
| `/env` | — | stub | Disabled/stub |
| `/remote-env` | — | local-jsx | Configure default remote environment |
| `/plan` | — | local-jsx | Enable plan mode or view current plan |
| `/tag` | — | local-jsx | Toggle searchable tag on session (internal) |
| `/rate-limit-options` | — | local-jsx | Show options when rate-limited (hidden/internal) |
| `/terminal-setup` | — | local-jsx | Install Shift+Enter keybinding for newlines |
| `/onboarding` | — | stub | Disabled/stub |

## Key Processes

### Command Registration & Lazy Loading

Every command exports a `Command` object from its `index.ts` with metadata fields:

1. **`name`** — the slash command name (e.g., `"config"`)
2. **`type`** — execution type (`"local"`, `"local-jsx"`, or `"prompt"`)
3. **`description`** — shown in the help menu
4. **`load`** — a dynamic import function for lazy loading the implementation
5. Optional: `aliases`, `argumentHint`, `immediate`, `isHidden`, `isEnabled`, `availability`

When the user types a slash command, the CommandSystem matches the name, calls `load()` to import the implementation, then invokes the exported `call()` function. This lazy-loading pattern keeps startup time fast — no implementation code is loaded until a command is actually used.

> Source: `src/commands/config/index.ts:1-11`, `src/commands/model/index.ts:1-16`

### Settings Panel (`/config`)

The `/config` command opens a full React-based `Settings` component with the "Config" tab as default. This is the most comprehensive settings UI, allowing users to modify output style and other configuration in an interactive panel.

```typescript
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <Settings onClose={onDone} context={context} defaultTab="Config" />;
};
```

> Source: `src/commands/config/config.tsx:4-6`

### Model Selection (`/model`)

The model command supports three modes:

1. **No arguments** — shows the current model name
2. **Interactive picker** — opens `ModelPicker` component when no args or help args given
3. **Direct setting** — `/model <name>` validates and applies the model immediately

The flow for direct setting:
1. Check if model is allowed by organization policy via `isModelAllowed()`
2. Check 1M context access for Opus/Sonnet variants via `checkOpus1mAccess()` / `checkSonnet1mAccess()`
3. If the model is a known alias (from `MODEL_ALIASES`), skip validation and set directly
4. Otherwise, call `validateModel()` against the API
5. Update `AppState.mainLoopModel` and handle fast mode compatibility (auto-disable fast mode if the new model doesn't support it)
6. Display billing information if the model incurs extra usage

> Source: `src/commands/model/model.tsx:130-232`

### Fast Mode Toggle (`/fast`)

Fast mode provides faster output using the same model. The toggle:

1. Updates user settings via `updateSettingsForSource('userSettings', { fastMode: enable })` (defined in `src/utils/settings/settings.ts`)
2. If enabling and current model doesn't support fast mode, switches to the fast mode model automatically
3. Clears any fast mode cooldown timer
4. Shows pricing information on enable

The command is only visible when `isFastModeEnabled()` returns true (feature-gated) and only available on `claude-ai` and `console` platforms.

```typescript
function applyFastMode(enable: boolean, setAppState): void {
  clearFastModeCooldown();
  updateSettingsForSource('userSettings', { fastMode: enable ? true : undefined });
  // ... model switch logic
}
```

> Source: `src/commands/fast/fast.tsx:16-39`

### Effort Level (`/effort`)

Sets the reasoning effort level with values: `low`, `medium`, `high`, `max`, or `auto`.

The flow:
1. Parse and normalize the argument
2. For `auto`/`unset`: clear the effort setting from user settings
3. For specific levels: persist via `updateSettingsForSource('userSettings', { effortLevel })` (in `src/utils/settings/settings.ts`)
4. Check for `CLAUDE_CODE_EFFORT_LEVEL` environment variable conflicts — if the env var is set to a different value, warn the user that the env var takes precedence
5. Update `AppState.effortValue` (managed by `src/state/AppState.tsx`) for immediate effect

> Source: `src/commands/effort/effort.tsx:16-61`, `src/commands/effort/effort.tsx:107-118`

### Session Color (`/color`)

Sets the prompt bar color for the current session. Available colors come from the `AGENT_COLORS` constant.

1. Validates the color argument against `AGENT_COLORS`
2. Teammates (swarm sessions) are blocked from changing their color
3. Persists the color to the transcript file via `saveAgentColor()` for cross-session persistence
4. Updates `AppState.standaloneAgentContext.color` for immediate visual effect
5. Reset aliases: `default`, `reset`, `none`, `gray`, `grey`

> Source: `src/commands/color/color.ts:20-93`

### Vim Mode Toggle (`/vim`)

Toggles between `vim` and `normal` editing modes. Handles backward compatibility by treating the legacy `emacs` mode as `normal`. Persists the choice via `saveGlobalConfig()` (defined in `src/utils/config.ts`).

> Source: `src/commands/vim/vim.ts:8-38`

### Plan Mode (`/plan`)

Enables plan mode or displays the current plan:

1. If not already in plan mode: transitions the permission context to plan mode via `handlePlanModeTransition()` and `applyPermissionUpdate()`, which restricts tool permissions to read-only operations
2. If a description argument is provided (other than "open"), triggers a query with `shouldQuery: true`
3. If already in plan mode with no plan: reports status
4. `/plan open`: opens the plan file in the user's external editor via `editFileInEditor()`
5. Otherwise: renders the current plan content with the plan file path

> Source: `src/commands/plan/plan.tsx:64-121`

### Sandbox Configuration (`/sandbox`)

Manages command sandboxing with platform-aware checks:

1. Validates platform support (macOS, Linux, WSL2 — not WSL1)
2. Checks dependencies via `SandboxManager.checkDependencies()`
3. Checks enterprise `enabledPlatforms` policy restrictions
4. Checks if settings are locked by higher-priority configuration
5. **No arguments**: opens interactive `SandboxSettings` component
6. **`/sandbox exclude "pattern"`**: adds a command pattern to the excluded commands list in local settings

The description dynamically shows current sandbox status (enabled/disabled, auto-allow, managed).

> Source: `src/commands/sandbox-toggle/index.ts:1-50`, `src/commands/sandbox-toggle/sandbox-toggle.tsx:10-82`

### Privacy Settings (`/privacy-settings`)

Available only to consumer subscribers (`isConsumerSubscriber()`). Interacts with the Grove API:

1. Check qualification via `isQualifiedForGrove()`
2. Fetch current settings and notice config in parallel
3. If the user has already accepted terms: show `PrivacySettingsDialog` for toggling "Help improve Claude"
4. If first time: show `GroveDialog` for initial terms acceptance
5. Falls back to a web URL if API calls fail

> Source: `src/commands/privacy-settings/privacy-settings.tsx:7-57`

### Permissions Management (`/permissions`)

Opens an interactive `PermissionRuleList` component that displays current allow/deny rules. Supports retrying denied tool calls by creating retry messages in the conversation.

> Source: `src/commands/permissions/permissions.tsx:5-9`

### Hooks Viewer (`/hooks`)

Opens the `HooksConfigMenu` component, passing available tool names from the current permission context. Logs analytics event `tengu_hooks_command`.

> Source: `src/commands/hooks/hooks.tsx:6-12`

### Keybindings (`/keybindings`)

Feature-gated via `isKeybindingCustomizationEnabled()`. Creates or opens `~/.claude/keybindings.json`:

1. Creates the directory if needed
2. Writes a template file using exclusive create flag (`wx`) to avoid overwriting
3. Opens the file in the user's editor via `editFileInEditor()`

> Source: `src/commands/keybindings/keybindings.ts:11-53`

### Status Line (`/statusline`)

A `prompt`-type command (not local) that delegates to a specialized `statusline-setup` subagent. It reads the user's shell PS1 configuration and configures the status line UI. Allowed tools are restricted to `Agent`, `Read(~/**)`, and `Edit(~/.claude/settings.json)`.

> Source: `src/commands/statusline.tsx:4-23`

### Terminal Setup (`/terminal-setup`)

Installs keyboard bindings (Shift+Enter for newlines) for terminals that don't natively support CSI u / Kitty keyboard protocol. Hidden for terminals with native support (Ghostty, Kitty, iTerm2, WezTerm, Warp). On Apple Terminal specifically, it sets up Option+Enter and visual bell. Handles VSCode Remote SSH detection for correct local vs. remote installation.

> Source: `src/commands/terminalSetup/index.ts:1-23`, `src/commands/terminalSetup/terminalSetup.tsx:39-78`

### Remote Environment (`/remote-env`)

Configures the default remote environment for teleport sessions. Only enabled for Claude AI subscribers with `allow_remote_sessions` policy. Renders a `RemoteEnvironmentDialog`.

> Source: `src/commands/remote-env/index.ts:5-15`

### Tag (`/tag`)

Internal command (enabled only when `USER_TYPE === 'ant'`). Toggles a searchable tag on the current session, persisted via `saveTag()` to session storage. Shows a confirmation dialog when removing an existing tag.

> Source: `src/commands/tag/index.ts:1-12`

### Rate Limit Options (`/rate-limit-options`)

Hidden internal command shown when rate limits are hit. Only enabled for Claude AI subscribers. Presents options like upgrading subscription or enabling extra usage, with dynamic labels based on subscription type (Max, Team, Enterprise) and current overage status.

> Source: `src/commands/rate-limit-options/index.ts:1-19`

## Command Type System

Commands use three execution types:

| Type | Mechanism | Return |
|------|-----------|--------|
| `local` | Synchronous function, returns `{ type: 'text', value: string }` | Text result |
| `local-jsx` | Async function, receives `onDone` callback and optionally returns React JSX | React component or null |
| `prompt` | Generates a prompt that gets sent to Claude as a message | Content blocks |

Most configuration commands are `local-jsx` because they render interactive React components (pickers, dialogs, settings panels). Simple toggles like `/vim` use `local` type.

## Visibility & Availability Controls

Commands use several mechanisms to control when they appear:

- **`isEnabled()`**: Dynamic function check — returns false to fully disable the command
- **`isHidden`**: Hides from help/autocomplete but still executable (e.g., `/rate-limit-options`, `/output-style`)
- **`availability`**: Platform restrictions (e.g., `/fast` only on `['claude-ai', 'console']`)
- **`immediate`**: Some commands (e.g., `/model`, `/fast`, `/effort`) use `shouldInferenceConfigCommandBeImmediate()` to determine if they execute instantly or show a picker

## Configuration Persistence

Commands persist settings through several mechanisms:

| Mechanism | Used By | Scope |
|-----------|---------|-------|
| `saveGlobalConfig()` in `src/utils/config.ts` | `/vim` | Global, persists across sessions |
| `updateSettingsForSource()` in `src/utils/settings/settings.ts` | `/fast`, `/effort` | User settings file |
| `AppState` in `src/state/AppState.tsx` (in-memory) | `/model`, `/color`, `/plan`, `/effort` | Session only (some persisted) |
| `saveAgentColor()` / `saveTag()` | `/color`, `/tag` | Session transcript storage |
| Grove API | `/privacy-settings` | Server-side |

## Edge Cases & Caveats

- **`/output-style` is deprecated**: It simply displays a message redirecting users to `/config`. It is hidden from help but still callable.
- **`/env` and `/onboarding` are stubs**: Both export `{ isEnabled: () => false, isHidden: true, name: 'stub' }` and do nothing.
- **Environment variable overrides for `/effort`**: The `CLAUDE_CODE_EFFORT_LEVEL` env var takes precedence over the persisted setting. The command warns users when both are set to conflicting values.
- **Fast mode model compatibility**: When switching models via `/model`, fast mode is automatically disabled if the new model doesn't support it, without updating the fast mode setting (so it auto-re-enables if the user switches back).
- **Teammate color restriction**: In swarm/teammate sessions, `/color` is blocked — colors are assigned by the team leader.
- **Sandbox platform gating**: `/sandbox` is completely hidden on unsupported platforms and when the platform isn't in the enterprise `enabledPlatforms` list. Settings locked by higher-priority policy cannot be changed locally.
- **`/keybindings` uses exclusive create**: The file write uses the `wx` flag to avoid TOCTOU race conditions when checking if the file exists before writing.
- **`/tag` is internal-only**: Gated behind `USER_TYPE === 'ant'`, making it unavailable to external users.