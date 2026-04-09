# Settings and Configuration

## Overview & Responsibilities

The SettingsAndConfig module is the central UI layer for all user-facing configuration in Claude Code. It lives within the **TerminalUI > Components** layer of the architecture, sitting between the Ink rendering engine (which provides primitives like `Box`, `Text`, `Dialog`, `Select`) and the Infrastructure layer (which manages the actual settings files, permissions, and configuration state).

This module provides:

- **The main Settings panel** with tabbed navigation across Status, Config, and Usage views
- **Sandbox configuration** for controlling the sandboxed execution environment
- **Hooks configuration** for browsing configured hook events and their handlers
- **Security and trust dialogs** that gate access when project settings contain potentially dangerous configurations
- **Preference pickers** for model, theme, language, and output style selection
- **Error dialogs** for invalid configuration/settings files
- **Output styles loader** for discovering custom output styles from markdown files

## Key Processes

### Settings Panel Navigation Flow

1. The `Settings` component (`src/components/Settings/Settings.tsx:22`) mounts with a `defaultTab` prop (`'Status' | 'Config' | 'Usage' | 'Gates'`)
2. It renders a `Pane` containing a `Tabs` component with three `Tab` children (Status, Config, Usage). `Tabs` accepts `children: Array<ReactElement<TabProps>>` — each `Tab` has a `title` and `key` prop, and `Tabs` manages the selected tab via `defaultTab` and internal state
3. The Config tab is wrapped in `<Suspense>` for deferred loading
4. Escape is handled conditionally: if a sub-component (like Config's search mode) "owns" Escape, the parent defers to it via `configOwnsEsc` state; otherwise, Escape closes the dialog
5. The `Status` tab invokes `buildDiagnostics()` on mount, returning installation/health/memory diagnostics asynchronously via a `Promise` that `Status` resolves with React's `use()` hook

### Config Tab Setting Modification Flow

1. `Config` (`src/components/Settings/Config.tsx:85`) reads the current global config, per-source settings, and AppState on mount, storing snapshots for revert-on-escape
2. It constructs a `Setting[]` array with entries for each configurable option (theme, model, verbose, notifications, permissions mode, output style, language, auto-updater, fast mode, thinking, etc.)
3. Each setting has a `type` (`'boolean'`, `'enum'`, `'managedEnum'`) governing its edit UI
4. Boolean settings toggle directly; enum/managedEnum settings open a custom sub-component via `setShowSubmenu()`, which also hides the tab bar
5. Submenus (`'Theme' | 'Model' | 'TeammateModel' | 'ExternalIncludes' | 'OutputStyle' | 'ChannelDowngrade' | 'Language' | 'EnableAutoUpdates'`) render the corresponding picker component
6. On Escape from Config, all changes are **reverted** by restoring per-source settings snapshots and AppState to their initial values — changes persist only when the user exits through a non-cancel path
7. Config includes a `SearchBox`-based interface that filters the visible settings list by query, with `useSearchInput` managing the search input lifecycle

### Sandbox Configuration Flow

`SandboxSettings` (`src/components/sandbox/SandboxSettings.tsx:22`) renders a `Pane` with `Tabs` (`defaultTab="Mode"`). The tab set is **dynamic** based on dependency status:

- **When dependency errors exist** (`depCheck.errors.length > 0`): Only the **Dependencies** tab is rendered, blocking access to all other tabs until dependencies are resolved (`src/components/sandbox/SandboxSettings.tsx:201`)
- **When no errors exist**: Up to four tabs are shown:
  1. **Mode tab** — Uses the inline `SandboxModeTab` component (defined at `src/components/sandbox/SandboxSettings.tsx:222`). This contains the sandbox mode picker `Select` with three options: `'auto-allow'` (sandbox with auto-approved bash), `'regular'` (sandbox with standard permissions), and `'disabled'`. Selection calls `SandboxManager.setSandboxSettings()` to persist the choice
  2. **Dependencies tab** — `SandboxDependenciesTab` (`src/components/sandbox/SandboxDependenciesTab.tsx:9`), shown only when dependency warnings exist. Displays platform-specific status of ripgrep, bubblewrap/seatbelt, socat, and seccomp with install hints
  3. **Overrides tab** — `SandboxOverridesTab` (`src/components/sandbox/SandboxOverridesTab.tsx:14`), controls whether unsandboxed command fallback is allowed. Respects policy locks — when `areSandboxSettingsLockedByPolicy()` returns true, the UI shows the current setting as read-only
  4. **Config tab** — `SandboxConfigTab` (`src/components/sandbox/SandboxConfigTab.tsx:5`), a read-only view of the current sandbox restriction details: filesystem read/write configs (`SandboxManager.getFsReadConfig()`, `getFsWriteConfig()`), network restrictions (`getNetworkRestrictionConfig()`), unix socket allowances (`getAllowUnixSockets()`), excluded commands (`getExcludedCommands()`), and glob pattern warnings (`getLinuxGlobPatternWarnings()`). When sandbox is disabled, shows a simple "Sandbox is not enabled" message

### Hooks Configuration Browsing Flow

The hooks UI (`src/components/hooks/HooksConfigMenu.tsx:51`) is a **read-only** browser with four navigation modes managed by a `ModeState` discriminated union:

1. **SelectEventMode** (`src/components/hooks/SelectEventMode.tsx:27`) — Entry screen listing all hook event types (e.g., `PreToolUse`, `PostToolUse`) with counts of configured hooks per event. Shows a policy restriction banner when `restrictedByPolicy` is true
2. **SelectMatcherMode** (`src/components/hooks/SelectMatcherMode.tsx:28`) — If the event supports matchers (tool-name scoping), shows configured matchers with hook counts and source indicators (inline display strings like "user settings", "project settings")
3. **SelectHookMode** (`src/components/hooks/SelectHookMode.tsx:24`) — Lists all hooks for a given event+matcher pair, displaying type (`command`, `prompt`, `agent`, `http`) and source
4. **ViewHookMode** (`src/components/hooks/ViewHookMode.tsx:17`) — Read-only details of a single hook: event, matcher, type, source, command/URL, timeout, and environment variables

The menu responds to `useSettingsChange` to live-reload when policy settings change. Back-navigation is wired through `useKeybinding("confirm:no", ...)` at each level.

### Trust Dialog Flow

`TrustDialog` (`src/components/TrustDialog/TrustDialog.tsx:23`) activates when a workspace has project-level settings that could execute arbitrary code:

1. It inspects multiple risk vectors via utility functions in `src/components/TrustDialog/utils.ts`:
   - `getHooksSources()` — checks `.claude/settings.json` and `.claude/settings.local.json` for hooks, statusLine, or fileSuggestion
   - `getBashPermissionSources()` — checks for allow rules on the BashTool
   - `getApiKeyHelperSources()` — checks for `apiKeyHelper` configuration
   - `getAwsCommandsSources()` / `getGcpCommandsSources()` — checks for cloud auth refresh commands
   - `getOtelHeadersHelperSources()` — checks for OTEL headers helper
   - `getDangerousEnvVarsSources()` — checks for env vars not in the `SAFE_ENV_VARS` allowlist
2. The user can "Trust and proceed" (persisted via `saveCurrentProjectConfig`) or "Don't trust" (triggers `gracefulShutdownSync()`)

### Managed Settings Security Dialog Flow

`ManagedSettingsSecurityDialog` (`src/components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.tsx:15`) prompts when organization-managed settings contain potentially dangerous configurations:

1. `extractDangerousSettings()` (`src/components/ManagedSettingsSecurityDialog/utils.ts:24-70`) extracts three categories:
   - **Shell settings** — Checked against `DANGEROUS_SHELL_SETTINGS` constant
   - **Environment variables** — Any env var NOT in the `SAFE_ENV_VARS` allowlist
   - **Hooks** — Any non-empty hooks configuration
2. `hasDangerousSettingsChanged()` (`src/components/ManagedSettingsSecurityDialog/utils.ts:87-117`) compares serialized old vs. new dangerous settings to determine if re-approval is needed
3. `formatDangerousSettingsList()` (`src/components/ManagedSettingsSecurityDialog/utils.ts:123-144`) produces a display list of setting names (without values) for the approval UI

### Output Styles Loading

`loadOutputStylesDir.ts` (`src/outputStyles/loadOutputStylesDir.ts:26-92`) discovers custom output styles:

1. Calls `loadMarkdownFilesForSubdir('output-styles', cwd)` to find `.md` files in `.claude/output-styles/` (project) and `~/.claude/output-styles/` (user)
2. Parses frontmatter for `name`, `description`, and `keep-coding-instructions` flag
3. File content (minus frontmatter) becomes the style's prompt
4. Results are memoized via `lodash-es/memoize`; `clearOutputStyleCaches()` resets memoization for reload

## Function Signatures & Key Components

### Settings Panel

#### `Settings({ onClose, context, defaultTab })`
Main settings dialog wrapper with tab navigation.
- **onClose**: `(result?: string, options?: { display?: CommandResultDisplay }) => void`
- **context**: `LocalJSXCommandContext` — carries MCP clients, IDE status, etc.
- **defaultTab**: `'Status' | 'Config' | 'Usage' | 'Gates'`

> `src/components/Settings/Settings.tsx:22`

#### `Config({ onClose, context, setTabsHidden, onIsSearchModeChange, contentHeight })`
Searchable config tab with submenu management. Defines `Setting` types (`boolean`, `enum`, `managedEnum`) and tracks per-source snapshots for revert.

> `src/components/Settings/Config.tsx:85`

#### `buildDiagnostics(): Promise<Diagnostic[]>`
Async helper that aggregates installation, health, and memory diagnostics for the Status tab.

> `src/components/Settings/Status.tsx:54`

#### `Usage()`
Displays rate limit utilization via `ProgressBar` components and extra-usage spending. Fetches data via `fetchUtilization()`.

> `src/components/Settings/Usage.tsx`

### Sandbox Configuration

#### `SandboxSettings({ onComplete, depCheck })`
Top-level sandbox dialog with dynamic tab set. Renders `Pane > Tabs` with `defaultTab="Mode"`. When dependency errors exist, only the Dependencies tab is shown.
- **depCheck**: `SandboxDependencyCheck` — pre-computed dependency status with `errors` and `warnings` arrays

> `src/components/sandbox/SandboxSettings.tsx:22`

#### `SandboxModeTab({ showSocketWarning, options, onSelect, onComplete })`
Internal component (not exported) rendering the sandbox mode `Select` picker with socket warning. Located inside the SandboxSettings file.

> `src/components/sandbox/SandboxSettings.tsx:222`

#### `SandboxConfigTab()`
Read-only view of current sandbox restrictions: filesystem read/write configs, network restrictions, unix socket allowances, excluded commands, and glob pattern warnings. Shows "Sandbox is not enabled" when disabled.

> `src/components/sandbox/SandboxConfigTab.tsx:5`

#### `SandboxDependenciesTab({ depCheck })`
Displays dependency status with platform-specific install instructions for ripgrep, bubblewrap/seatbelt, socat, and seccomp.

> `src/components/sandbox/SandboxDependenciesTab.tsx:9`

#### `SandboxOverridesTab({ onComplete })`
Controls unsandboxed command fallback. Shows read-only state when policy-locked via `SandboxManager.areSandboxSettingsLockedByPolicy()`.

> `src/components/sandbox/SandboxOverridesTab.tsx:14`

#### `SandboxDoctorSection()`
Renders sandbox dependency status for the `/doctor` diagnostic. Returns `null` if sandbox unsupported or disabled.

> `src/components/sandbox/SandboxDoctorSection.tsx:5`

### Hooks Configuration

#### `HooksConfigMenu({ toolNames, onExit })`
Read-only hook browser with `ModeState`-driven navigation across four subviews.

> `src/components/hooks/HooksConfigMenu.tsx:51`

#### `PromptDialog({ title, toolInputSummary, request, onRespond, onAbort })`
Renders a hook prompt interaction as a `PermissionDialog` with selectable options from `request.options`.

> `src/components/hooks/PromptDialog.tsx:15`

### Security Dialogs

#### `ManagedSettingsSecurityDialog({ settings, onAccept, onReject })`
- **settings**: `SettingsJson` — the managed settings to review
- **onAccept / onReject**: Approval callbacks

> `src/components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.tsx:15`

#### `TrustDialog({ onDone, commands })`
Workspace trust prompt. Inspects project MCP servers, hooks, bash permissions, auth helpers, cloud commands, and dangerous env vars.

> `src/components/TrustDialog/TrustDialog.tsx:23`

### Preference Pickers

#### `ModelPicker({ initial, sessionModel, onSelect, onCancel, ... })`
Model selection with effort level cycling (`e` key), fast mode toggle (`f` key), and "No preference" sentinel (`__NO_PREFERENCE__`).

> `src/components/ModelPicker.tsx:39`

#### `ThemePicker({ onThemeSelect, showIntroText, helpText, ... })`
Theme selection with live preview via `usePreviewTheme()`, a `StructuredDiff` code sample, and syntax highlighting toggle (`Ctrl+T`).

> `src/components/ThemePicker.tsx:30`

#### `LanguagePicker({ initialLanguage, onComplete, onCancel })`
Free-text input for preferred response language. Uses `TextInput` with placeholder examples.

> `src/components/LanguagePicker.tsx:12`

#### `OutputStylePicker({ initialStyle, onComplete, onCancel, isStandaloneCommand })`
Loads built-in and custom output styles via `getAllOutputStyles(getCwd())`, falls back to `OUTPUT_STYLE_CONFIG` on error.

> `src/components/OutputStylePicker.tsx:28`

### Error Dialogs

#### `InvalidConfigDialog({ filePath, errorDescription, onExit, onReset })`
Shown when `~/.claude.json` contains invalid JSON. Options: exit to fix manually, or reset to defaults (writes `{}`).

> `src/components/InvalidConfigDialog.tsx:25`

#### `InvalidSettingsDialog({ settingsErrors, onContinue, onExit })`
Shown when settings files fail validation. Renders errors via `ValidationErrorsList`. Files with errors are skipped entirely.

> `src/components/InvalidSettingsDialog.tsx:18`

### Output Styles Loader

#### `getOutputStyleDirStyles(cwd): Promise<OutputStyleConfig[]>`
Memoized async loader for `.md` output style files from `output-styles` subdirectories.

> `src/outputStyles/loadOutputStylesDir.ts:26`

#### `clearOutputStyleCaches(): void`
Clears memoization caches for output style and plugin output style loading.

> `src/outputStyles/loadOutputStylesDir.ts:94`

## Interface/Type Definitions

### `ModeState` (Hooks Menu)
Discriminated union controlling hooks browser navigation:
```typescript
type ModeState =
  | { mode: 'select-event' }
  | { mode: 'select-matcher'; event: HookEvent }
  | { mode: 'select-hook'; event: HookEvent; matcher: string }
  | { mode: 'view-hook'; event: HookEvent; hook: IndividualHookConfig }
```
> `src/components/hooks/HooksConfigMenu.tsx:37-50`

### `DangerousSettings`
Extracted dangerous configuration from managed settings:
```typescript
type DangerousSettings = {
  shellSettings: Partial<Record<DangerousShellSetting, string>>
  envVars: Record<string, string>
  hasHooks: boolean
  hooks?: unknown
}
```
> `src/components/ManagedSettingsSecurityDialog/utils.ts:10-15`

### `Setting` (Config Tab)
Union type for configurable items in the Config tab:
- `type: 'boolean'` — Toggle with `onChange(value: boolean)`
- `type: 'enum'` — Dropdown with `options: string[]` and `onChange(value: string)`
- `type: 'managedEnum'` — Enum set by a custom sub-component, displays a `value: string` but has no inline options
> `src/components/Settings/Config.tsx:68-83`

### `SubMenu` (Config Tab)
```typescript
type SubMenu = 'Theme' | 'Model' | 'TeammateModel' | 'ExternalIncludes'
             | 'OutputStyle' | 'ChannelDowngrade' | 'Language' | 'EnableAutoUpdates'
```
> `src/components/Settings/Config.tsx:84`

### `SandboxMode`
```typescript
type SandboxMode = 'auto-allow' | 'regular' | 'disabled'
```
> `src/components/sandbox/SandboxSettings.tsx:21`

### `OverrideMode`
```typescript
type OverrideMode = 'open' | 'closed'
```
> `src/components/sandbox/SandboxOverridesTab.tsx:13`

## Configuration & Defaults

| Setting | Default | Notes |
|---------|---------|-------|
| Output style | `'default'` (`DEFAULT_OUTPUT_STYLE_NAME`) | Selectable from built-in + custom styles |
| Language | `undefined` (English) | Free text input, empty = English |
| Sandbox mode | `'disabled'` | Platform-dependent availability (macOS seatbelt, Linux bubblewrap) |
| Sandbox default tab | `"Mode"` | Falls back to Dependencies-only when errors present |
| Custom output styles | `.claude/output-styles/*.md` | Project-level; also `~/.claude/output-styles/` for user-level |
| `keep-coding-instructions` | `undefined` | Frontmatter flag in custom output style `.md` files |
| Hooks menu | Read-only | Editing requires `settings.json` or Claude |
| Invalid config reset | `{}` (empty JSON) | Written to config file path on reset |

## Edge Cases & Caveats

- **Config revert on Escape**: The Config tab snapshots all per-source settings (`localSettings`, `userSettings`) and AppState at mount. Pressing Escape reverts *all* changes — including theme, model, effort, output style, language, and `userMsgOptIn`. Changes only persist if the user navigates away from Config or closes the dialog through a non-cancel path.

- **Sandbox tabs are dynamic**: When `depCheck.errors.length > 0`, `SandboxSettings` renders *only* the Dependencies tab, hiding Mode, Overrides, and Config entirely (`src/components/sandbox/SandboxSettings.tsx:201`). When there are no errors but warnings exist, the Dependencies tab appears alongside the other tabs. The Mode tab (with the sandbox mode picker) and Config tab (with restriction details) are separate components — the mode picker is `SandboxModeTab` (internal to `SandboxSettings.tsx:222`), not `SandboxConfigTab`.

- **Hooks menu is read-only**: The UI cannot add, modify, or delete hooks. Users must edit `settings.json` directly or ask Claude. This is by design: the old editing UI only supported command-type hooks, and supporting all four types (`command`, `prompt`, `agent`, `http`) in-menu would be a maintenance burden (`src/components/hooks/HooksConfigMenu.tsx:1-13`).

- **Policy restrictions in hooks**: When `allowManagedHooksOnly` is set in policy settings, user-defined hooks from `~/.claude/settings.json`, `.claude/settings.json`, and `.claude/settings.local.json` are blocked — only managed settings hooks execute. When `disableAllHooks` is set in policy, all hooks are disabled entirely.

- **Trust dialog is blocking**: `TrustDialog` offers no way to proceed without explicitly accepting or rejecting. Rejecting triggers `gracefulShutdownSync()`, immediately terminating the process.

- **Dangerous env var detection**: The `SAFE_ENV_VARS` allowlist is authoritative — any env var *not* in it is considered dangerous. Newly added env vars are dangerous-by-default until explicitly safelisted in `managedEnvConstants.ts`.

- **Output style loading fallback**: If `getAllOutputStyles()` fails (e.g., filesystem error), `OutputStylePicker` falls back to built-in styles only (`OUTPUT_STYLE_CONFIG`), ensuring the picker always renders.

- **Sandbox policy locks**: `SandboxOverridesTab` checks `SandboxManager.areSandboxSettingsLockedByPolicy()` — when locked, the UI displays the current setting as read-only text rather than an interactive selector.

- **`force-for-plugin` frontmatter**: Setting this on a non-plugin output style in `loadOutputStylesDir.ts` logs a warning but is otherwise ignored — it only applies to plugin output styles.