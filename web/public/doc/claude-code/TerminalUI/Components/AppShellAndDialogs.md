# AppShellAndDialogs

## Overview & Responsibilities

AppShellAndDialogs is the outermost visual layer of the Claude Code terminal UI, sitting within the **Components** module of the **TerminalUI** system. While sibling modules like **Screens** (REPL, Doctor, ResumeConversation) handle page-level layouts and **Hooks** provide reusable state logic, this module supplies the application wrapper, every standalone dialog, and dozens of miscellaneous UI components that appear across the interface.

Its responsibilities fall into seven categories:

1. **App shell** — the top-level provider wrapper (`App.tsx`), fullscreen layout with scroll chrome, exit flow, error boundary, and developer toolbar
2. **Auto-update system** — three update strategies (npm, native binary, package manager) behind a unified wrapper
3. **Authentication flows** — API key approval, OAuth login, and AWS credential status
4. **Feedback & survey system** — probabilistic feedback surveys with transcript sharing, memory surveys, and post-compact surveys
5. **Memory UI** — file selector, update notifications, and heap usage indicator
6. **Teleport components** — git stash, error handling, progress, session resume, and repo mismatch resolution for session teleportation
7. **Standalone dialogs & utilities** — 15+ dialog components and 20+ small utility components

---

## Key Processes

### Application Startup Wrapping Flow

1. Bootstrap launches the Ink-based REPL, which renders `App` as the outermost component
2. `App` (`src/components/App.tsx:19-55`) nests three context providers: FpsMetricsProvider → StatsProvider → AppStateProvider
3. Inside AppStateProvider, `FullscreenLayout` (`src/components/FullscreenLayout.tsx`) manages the scroll viewport, pinned footer, overlays, and modals
4. `SentryErrorBoundary` (`src/components/SentryErrorBoundary.ts:11-28`) wraps subtrees to silently catch and swallow render errors (returns `null` on error)
5. `DevBar` (`src/components/DevBar.tsx:11-45`) optionally renders in dev/ant builds, polling slow operations every 500ms

### Auto-Update Flow

1. `AutoUpdaterWrapper` (`src/components/AutoUpdaterWrapper.tsx:34-54`) detects the installation type on mount via `getCurrentInstallationType()`
2. Routes to the appropriate updater component:
   - **npm** → `AutoUpdater` (`src/components/AutoUpdater.tsx`) — calls `installGlobalPackage()` or `installOrUpdateClaudePackage()`
   - **Native binary** → `NativeAutoUpdater` (`src/components/NativeAutoUpdater.tsx`) — calls `installLatest(channel)`, handles lock contention gracefully
   - **Package manager** → `PackageManagerAutoUpdater` (`src/components/PackageManagerAutoUpdater.tsx`) — read-only, displays the command for the user to run (e.g. `brew upgrade claude-code`)
3. All updaters check a server-side max version cap, skip in test/dev environments, use a ref to prevent concurrent updates, and poll every 30 minutes
4. Analytics events are logged for success, failure, and up-to-date states

### Feedback Survey Flow

1. `useFeedbackSurvey` (`src/components/FeedbackSurvey/useFeedbackSurvey.tsx`) evaluates trigger conditions: ≥10 minutes elapsed, ≥5 user turns, probability roll (default 0.5%), feature flag check
2. On trigger, `useSurveyState` (`src/components/FeedbackSurvey/useSurveyState.tsx`) transitions: closed → open → (thanks | transcript_prompt) → closed
3. `FeedbackSurveyView` (`src/components/FeedbackSurvey/FeedbackSurveyView.tsx`) renders digit-based options via `useDebouncedDigitInput` (400ms debounce): 0=dismiss, 1=bad, 2=fine, 3=good
4. If configured, `TranscriptSharePrompt` (`src/components/FeedbackSurvey/TranscriptSharePrompt.tsx`) follows up asking permission to share the session transcript
5. `submitTranscriptShare` (`src/components/FeedbackSurvey/submitTranscriptShare.ts`) normalizes/redacts the transcript, applies a 25MB size guard, refreshes OAuth, and POSTs to the Anthropic API

### Teleport Session Migration Flow

1. `TeleportError` (`src/components/TeleportError.tsx:178-187`) checks preconditions: login status and git cleanliness
2. If `needsLogin` → renders `ConsoleOAuthFlow`; if `needsGitStash` → renders `TeleportStash` (`src/components/TeleportStash.tsx`) which detects changed files and calls `stashToCleanState()`
3. `TeleportProgress` (`src/components/TeleportProgress.tsx:14-138`) shows an animated 4-step progress indicator: validating → fetching_logs → fetching_branch → checking_out
4. `TeleportResumeWrapper` (`src/components/TeleportResumeWrapper.tsx:42-165`) manages session selection via `ResumeTask` and logs analytics events
5. If multiple local paths match, `TeleportRepoMismatchDialog` (`src/components/TeleportRepoMismatchDialog.tsx:28-104`) validates each path against the target repo

### Exit Flow

`ExitFlow` (`src/components/ExitFlow.tsx:15-47`) is a conditional component that only renders UI when there is a worktree to clean up:

1. The component defines an internal `onExit` callback (`src/components/ExitFlow.tsx:24-27`) that calls `onDone()` with the provided result message (or a random goodbye message as fallback) and then triggers `gracefulShutdown(0, "prompt_input_exit")`
2. **When `showWorktree` is true** (line 34): renders `WorktreeExitDialog`, passing `onExit` as the `onDone` prop. The dialog checks for uncommitted changes/commits, auto-removes if the worktree is clean, and otherwise prompts the user to keep or remove it. The goodbye message and shutdown are triggered only when the dialog calls `onExit`.
3. **When `showWorktree` is false** (line 46): returns `null` — the component renders nothing. The caller is responsible for handling non-worktree exit logic separately.

---

## App Shell

### App.tsx

The root wrapper component for interactive sessions. It nests three context providers in order:

1. **FpsMetricsProvider** — exposes FPS tracking to descendants
2. **StatsProvider** — optional stats store for session metrics
3. **AppStateProvider** — global application state with change callbacks

```typescript
// src/components/App.tsx:8-13
type Props = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
  children: React.ReactNode;
}
```

> Source: `src/components/App.tsx:19-55`

### FullscreenLayout.tsx

Manages the fullscreen scroll layout with several content zones:

- **scrollable** — main scrolling content area
- **bottom** — pinned footer
- **overlay** — content inside ScrollBox after messages
- **bottomFloat** — floating element over scrollback
- **modal** — slash-command dialog overlay

Exports `ScrollChromeContext` allowing child components (like `StickyTracker` in the virtual message list) to write scroll-derived UI state directly, avoiding deep prop threading.

The `useUnseenDivider()` hook tracks a "N new messages" divider position when the user scrolls up, providing methods to jump to the divider, shift it for infinite scroll-back, and clear it on scroll-to-bottom.

> Source: `src/components/FullscreenLayout.tsx:26-30` (context), `src/components/FullscreenLayout.tsx:86-146` (hook)

### ExitFlow.tsx

Conditional exit component that only renders when there is a worktree to clean up. Defines an `onExit` callback that calls `onDone()` with the result message (falling back to a random goodbye from "Goodbye!", "See ya!", "Bye!", "Catch you later!") and triggers `gracefulShutdown(0, "prompt_input_exit")`.

- When `showWorktree` is true: renders `WorktreeExitDialog` with `onExit` as the `onDone` callback. The goodbye message and shutdown are triggered only when the dialog completes.
- When `showWorktree` is false: returns `null`. The caller handles non-worktree exit separately.

> Source: `src/components/ExitFlow.tsx:15-47`

### SentryErrorBoundary.ts

A React error boundary that silently catches errors and renders `null` — hiding the crashed subtree without displaying a fallback UI. Used to prevent individual component failures from crashing the entire terminal interface.

> Source: `src/components/SentryErrorBoundary.ts:11-28`

### DevBar.tsx

Development-only status bar that polls `getSlowOperations()` every 500ms and displays the last 3 slow synchronous operations with their durations. Only renders in development builds or the "ant" environment.

```typescript
// src/components/DevBar.tsx:8-10
function shouldShowDevBar(): boolean
```

> Source: `src/components/DevBar.tsx:11-45`

### ScrollKeybindingHandler.tsx

The most complex component in the shell layer — a comprehensive keyboard scroll and selection handler for the fullscreen message view. Key features:

- **Page navigation**: PgUp/PgDn (half-viewport), Ctrl+Home/End (top/bottom)
- **Mouse wheel acceleration**: Dual-path algorithm supporting native terminals (linear ramp with bounce detection for mouse vs. trackpad) and xterm.js (exponential decay for browser wheel events)
- **Modal pager keys**: g/G (top/bottom), Ctrl+u/d (half-page), Ctrl+b/f (full-page) — only active in transcript mode
- **Selection handling**: Esc clears selection, Ctrl+C copies when text is selected, shift+arrows extend selection
- **Drag-to-scroll**: Auto-scroll when dragging past viewport edges

The wheel acceleration system (`computeWheelStep()`, lines 176-297) detects encoder bounce to distinguish mouse wheels from trackpads and adjusts scroll speed accordingly. The `CLAUDE_CODE_SCROLL_SPEED` environment variable allows users to tune the base speed (default 1, range 0-20).

> Source: `src/components/ScrollKeybindingHandler.tsx:359-623`

---

## Auto-Update System

### AutoUpdaterWrapper.tsx — Routing Layer

Detects the installation type on mount (`getCurrentInstallationType()`) and renders the appropriate updater:

| Installation Type | Component |
|---|---|
| Package manager (Homebrew, winget, apk) | `PackageManagerAutoUpdater` |
| Native binary | `NativeAutoUpdater` |
| npm (local/global) | `AutoUpdater` |

> Source: `src/components/AutoUpdaterWrapper.tsx:34-89`

### Shared Behavior

All three updaters share the same props interface and common patterns:

```typescript
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
}
```

- **30-minute polling interval** for update checks
- **Max version checking** — server-side kill switch to cap the maximum allowed version
- **Skip in test/dev** environments
- **Concurrent update prevention** via refs
- **Analytics logging** for success/failure events

### AutoUpdater.tsx — npm Updates

Handles both local and global npm installations. Detects installation type, then calls the appropriate install method (`installGlobalPackage()` or `installOrUpdateClaudePackage()`). Performs updates automatically and shows success/error messages with manual fallback commands.

> Source: `src/components/AutoUpdater.tsx:48-163`

### NativeAutoUpdater.tsx — Native Binary Updates

Calls `installLatest(channel)` from the native installer. Handles lock contention gracefully (doesn't treat as error). Exports `getErrorType()` to categorize errors for analytics (timeout, checksum_mismatch, not_found, permission_denied, disk_full, npm_error, network_error).

> Source: `src/components/NativeAutoUpdater.tsx:73-156`

### PackageManagerAutoUpdater.tsx — Package Manager Updates

Read-only updater — does not perform updates automatically. Instead, displays the appropriate command for the user to run:

- Homebrew: `brew upgrade claude-code`
- winget: `winget upgrade Anthropic.ClaudeCode`
- apk: `apk upgrade claude-code`

> Source: `src/components/PackageManagerAutoUpdater.tsx:73-102`

---

## Authentication Flows

### ApproveApiKey.tsx

Dialog for approving custom API keys detected in the environment. Shows the truncated key (e.g., `sk-ant-...`) and offers Yes/No options. Responses are persisted to global config to prevent repeated prompts.

> Source: `src/components/ApproveApiKey.tsx:19-113`

### ConsoleOAuthFlow.tsx

Full OAuth login flow with support for Claude AI and Anthropic Console login methods. Manages a state machine through: idle → platform_setup → ready_to_start → waiting_for_login → creating_api_key → success/error. Handles browser automation, code pasting, retry logic (1s timeout), and analytics logging.

> Source: `src/components/ConsoleOAuthFlow.tsx:20-144`

### AwsAuthStatusBox.tsx

Real-time AWS authentication status display. Subscribes to `AwsAuthStatusManager` for updates, shows the last 5 output lines, extracts clickable URLs from output, and displays error messages. Returns `null` when authentication succeeds.

> Source: `src/components/AwsAuthStatusBox.tsx:10-81`

---

## Feedback & Survey System

The feedback system is built on a layered architecture with shared state management:

### Core Infrastructure

**`useSurveyState.tsx`** — Foundation hook managing the survey state machine:
```
closed → open → thanks | transcript_prompt → closed
transcript_prompt → submitting → submitted → closed
```
Generates unique `appearanceId` per survey appearance for analytics correlation. Thanks and Submitted states auto-close after a configurable timeout.

**`useDebouncedDigitInput.ts`** — Shared hook that detects single digit keypresses with 400ms debounce to prevent accidental submissions. Normalizes full-width digits and trims the digit from the input buffer.

**`submitTranscriptShare.ts`** — Handles transcript submission: normalizes and redacts content, loads subagent transcripts, applies a 25MB size guard on raw JSONL, refreshes OAuth tokens, and POSTs to the Anthropic API.

### Survey Types

**`useFeedbackSurvey.tsx`** — Session satisfaction survey with probability gating (default 0.5%). Triggers after 10 minutes and 5 user turns. Configurable via GrowthBook feature flags. Response options: bad (1), fine (2), good (3), dismiss (0).

**`useMemorySurvey.tsx`** — Triggered when auto-managed memory files are accessed. 20% probability, gated by `tengu_dunwich_bell` feature flag. Deduplicates UUIDs to avoid re-rolling on re-renders.

**`usePostCompactSurvey.tsx`** — Shows after session memory compaction. 20% probability, gated by `tengu_post_compact_survey` feature flag. Tracks seen compaction boundaries.

### UI Components

**`FeedbackSurvey.tsx`** — Main survey renderer with state-dependent views (open, thanks, transcript prompt, submitting, submitted).

**`FeedbackSurveyView.tsx`** — The rating UI itself. Maps digits to responses: 0=dismissed, 1=bad, 2=fine, 3=good.

**`TranscriptSharePrompt.tsx`** — Follow-up asking permission to share the session transcript. Options: yes, no, don't ask again. Includes a link to data usage documentation.

**`Feedback.tsx`** — Full feedback submission form with git context, error log collection, and `redactSensitiveInfo()` which strips Anthropic API keys, AWS credentials, Google Cloud keys, bearer tokens, and environment variables.

> Source: `src/components/Feedback.tsx:75-111` (redaction function)

**`SkillImprovementSurvey.tsx`** — Binary apply/dismiss dialog for suggested skill improvements. Accepts only '0' (dismiss) and '1' (apply) with 400ms debounce.

> Source: `src/components/FeedbackSurvey/` directory

---

## Memory UI

### MemoryFileSelector.tsx

Complex file selector for the `/memory` command. Loads memory files organized into three categories (User, Project, Imported), supports creating new files, and provides toggles for auto-memory and auto-dream features with keyboard navigation.

> Source: `src/components/memory/MemoryFileSelector.tsx:50-349`

### MemoryUpdateNotification.tsx

Displays a notification when memory is updated, showing the shortest relative path representation (using `~` for home directory or `./` for CWD) with a link to the `/memory` editor.

> Source: `src/components/memory/MemoryUpdateNotification.tsx:7-44`

### MemoryUsageIndicator.tsx

Internal debugging aid (ant builds only). Shows heap memory usage with color coding (warning for high, error for critical) and a `/heapdump` link. Hidden when memory usage is normal.

> Source: `src/components/MemoryUsageIndicator.tsx:10-35`

---

## Teleport Components

Teleport handles session migration between environments. The flow involves error checking, git state management, progress display, and session resume:

### TeleportError.tsx

Entry point for teleport precondition checking. Detects two error types:
- **needsLogin** — renders `ConsoleOAuthFlow` for authentication
- **needsGitStash** — renders `TeleportStash` for git cleanup

Accepts an `errorsToIgnore` set to skip already-resolved errors. Calls `onComplete()` when all errors are resolved.

> Source: `src/components/TeleportError.tsx:178-187` (error detection), `src/components/TeleportError.tsx:135-166` (login UI)

### TeleportStash.tsx

Detects git file changes on mount, shows a dialog listing changed files (count only if >8 files), and offers stash/exit options. Calls `stashToCleanState()` on confirmation.

> Source: `src/components/TeleportStash.tsx:25-114`

### TeleportProgress.tsx

Animated 4-step progress indicator: validating → fetching_logs → fetching_branch → checking_out. Uses a spinner animation (◐ ◓ ◑ ◒) with 100ms frame updates. The `teleportWithProgress()` async function renders this component and manages the teleport operation.

> Source: `src/components/TeleportProgress.tsx:14-138`

### TeleportResumeWrapper.tsx

Orchestrates session selection and resume with analytics logging (`tengu_teleport_started`, `tengu_teleport_cancelled`). Renders `ResumeTask` for session selection and handles error/resuming states.

> Source: `src/components/TeleportResumeWrapper.tsx:42-165`

### TeleportRepoMismatchDialog.tsx

Displayed when multiple local paths match a target repository. Validates each selected path against the target repo using `validateRepoAtPath()`, removes invalid paths from options, and includes a cancel option.

> Source: `src/components/TeleportRepoMismatchDialog.tsx:28-104`

---

## Standalone Dialogs

### Navigation & Search Dialogs

| Dialog | Shortcut | Description |
|---|---|---|
| **QuickOpenDialog** (`src/components/QuickOpenDialog.tsx`) | Ctrl+Shift+P | Fuzzy file finder with 20-line file preview. Adaptive layout (right column at ≥120 chars). Uses `generateFileSuggestions`. |
| **GlobalSearchDialog** (`src/components/GlobalSearchDialog.tsx`) | Ctrl+Shift+F | Debounced ripgrep search (100ms) with 500 max matches. Adaptive preview at ≥140 chars. |
| **HistorySearchDialog** (`src/components/HistorySearchDialog.tsx`) | — | Conversation history search with dual strategy: exact substring (weighted higher) + fuzzy subsequence. Shows entry age and preview. |

### Permission & Safety Dialogs

| Dialog | Description |
|---|---|
| **BypassPermissionsModeDialog** (`src/components/BypassPermissionsModeDialog.tsx`) | Warning dialog for dangerous bypass mode. "No, exit" triggers shutdown; "Yes" logs analytics and persists setting. Error-colored. |
| **AutoModeOptInDialog** (`src/components/AutoModeOptInDialog.tsx`) | Opt-in for auto-permission mode. Three options: enable + set default, enable only, or decline. Legally reviewed copy. |
| **ClaudeMdExternalIncludesDialog** (`src/components/ClaudeMdExternalIncludesDialog.tsx`) | Permission prompt for CLAUDE.md files importing external files (outside CWD). Persists decision to project config. |
| **CostThresholdDialog** (`src/components/CostThresholdDialog.tsx`) | Alert when $5 spent in session. Single "Got it" button with documentation link. |

### Session & Environment Dialogs

| Dialog | Description |
|---|---|
| **ExportDialog** (`src/components/ExportDialog.tsx`) | Exports conversation to clipboard or file. Two-step: select method → enter filename. Ensures `.txt` extension. |
| **BridgeDialog** (`src/components/BridgeDialog.tsx`) | Bridge connection status with QR code for mobile. Shows session URL, repo name, branch. Toggle QR with keybinding, 'd' to disconnect. |
| **IdleReturnDialog** (`src/components/IdleReturnDialog.tsx`) | Idle timeout alert showing duration and token usage. Actions: continue, clear context, or never ask again. |
| **WorktreeExitDialog** (`src/components/WorktreeExitDialog.tsx`) | Worktree cleanup on exit. Auto-removes if no changes; otherwise prompts keep/remove. Clears plan directory cache. |
| **RemoteEnvironmentDialog** (`src/components/RemoteEnvironmentDialog.tsx`) | Remote environment selector. Fetches available environments, updates local settings with selected `environment_id`. |
| **WorkflowMultiselectDialog** (`src/components/WorkflowMultiselectDialog.tsx`) | Multi-select for GitHub workflows (Claude Code, Claude Code Review). Requires ≥1 selection. |

### Update & Channel Dialogs

| Dialog | Description |
|---|---|
| **DevChannelsDialog** (`src/components/DevChannelsDialog.tsx`) | Warning for `--dangerously-load-development-channels`. Lists imported channels. Error-colored. |
| **ChannelDowngradeDialog** (`src/components/ChannelDowngradeDialog.tsx`) | Shown when switching from latest to stable channel. Three choices: downgrade, stay on current, cancel. |

---

## Utility Components

### Status & Indicators

- **TokenWarning** (`src/components/TokenWarning.tsx`) — Token usage warnings with context collapse progress indicator. Subscribes to external collapse stats store.
- **PrBadge** (`src/components/PrBadge.tsx`) — Colored PR badge mapping review states to colors (approved=green, changes_requested=red, pending=yellow, merged=merged).
- **FastIcon** (`src/components/FastIcon.tsx`) — Lightning bolt icon for fast mode, dimmed during cooldown.
- **IdeStatusIndicator** (`src/components/IdeStatusIndicator.tsx`) — Shows IDE connection status and current file/line selection.
- **SandboxViolationExpandedView** (`src/components/SandboxViolationExpandedView.tsx`) — Lists last 10 blocked sandbox operations with timestamps and total count.

### Input Hints & Prompts

- **PressEnterToContinue** (`src/components/PressEnterToContinue.tsx`) — Simple "Press Enter to continue…" prompt.
- **CtrlOToExpand** (`src/components/CtrlOToExpand.tsx`) — Shows "(ctrl+o to expand)" hint, hidden in sub-agent contexts via `SubAgentProvider`.
- **ConfigurableShortcutHint** (`src/components/ConfigurableShortcutHint.tsx`) — Renders user-configured keyboard shortcut with fallback via `useShortcutDisplay`.
- **SessionBackgroundHint** (`src/components/SessionBackgroundHint.tsx`) — Ctrl+B hint to background current session. Uses double-press pattern with special tmux handling.
- **ShowInIDEPrompt** (`src/components/ShowInIDEPrompt.tsx`) — Permission dialog for opening files in IDE with symlink warnings.

### Session Components

- **SessionPreview** (`src/components/SessionPreview.tsx`) — Full session preview with async log loading, keyboard shortcuts (Esc to exit, Enter to select).
- **ResumeTask** (`src/components/ResumeTask.tsx`) — Fetches and displays resumable sessions filtered by current repo, sorted by date.

### Layout & Display

- **TagTabs** (`src/components/TagTabs.tsx`) — Smart tab bar with overflow indicators, centered window around selection, and tag truncation for long labels.
- **Stats** (`src/components/Stats.tsx`) — Date-ranged stats display (7d, 30d, all) with heatmap and charts. Uses React 19 `use()` for promise handling.
- **LogSelector** (`src/components/LogSelector.tsx`) — Tree-based session log selector with fuzzy search, branch filtering, and worktree filtering.
- **DiagnosticsDisplay** (`src/components/DiagnosticsDisplay.tsx`) — Diagnostic issues summary with expand-to-detail via CtrlO, relative file paths.
- **ValidationErrorsList** (`src/components/ValidationErrorsList.tsx`) — Groups validation errors by file in a nested tree structure with deduplication.

### Feature Components

- **DesktopHandoff** (`src/components/DesktopHandoff.tsx`) — Handles handoff to Claude Desktop app. State machine: checking → prompt-download → flushing → opening → success/error.
- **RemoteCallout** (`src/components/RemoteCallout.tsx`) — First-time dialog presenting Remote Control feature with enable/dismiss options.
- **KeybindingWarnings** (`src/components/KeybindingWarnings.tsx`) — Displays validation warnings for keybinding configuration (errors vs. warnings).
- **GroveDialog** (`src/components/grove/Grove.tsx`) — Policy/terms dialog for data training opt-in/out with grace period and post-grace variants.
- **PluginHintMenu** (`src/components/ClaudeCodeHint/PluginHintMenu.tsx`) — Plugin recommendation dialog with 30s auto-dismiss, yes/no/disable options.

### Shell Output (`src/components/shell/`)

- **OutputLine** (`src/components/shell/OutputLine.tsx`) — Renders shell output with JSON formatting (detects precision loss), URL linkification, and compact-mode truncation.
- **ShellProgressMessage** (`src/components/shell/ShellProgressMessage.tsx`) — Shows last 5 lines of shell command output, elapsed time, timeout display, with ANSI stripping.
- **ShellTimeDisplay** (`src/components/shell/ShellTimeDisplay.tsx`) — Formats elapsed time and/or timeout duration.
- **ExpandShellOutputProvider** (`src/components/shell/ExpandShellOutputContext.tsx`) — Context provider controlling whether shell output renders in full or truncated.

---

## Edge Cases & Caveats

- **ExitFlow returns null when no worktree** — When `showWorktree` is false, `ExitFlow` (`src/components/ExitFlow.tsx:46`) returns `null` and renders nothing. The caller is responsible for handling non-worktree exit logic. The goodbye message and `gracefulShutdown` are only invoked through `WorktreeExitDialog`'s completion callback.
- **SentryErrorBoundary renders null on error** — crashed subtrees silently disappear. This prevents terminal crashes but can make debugging harder; check Sentry for captured errors.
- **Wheel acceleration has two distinct code paths** (`src/components/ScrollKeybindingHandler.tsx:176-297`) — native terminals use bounce detection for mouse/trackpad differentiation, while xterm.js (VS Code integrated terminal) uses exponential decay. The `CLAUDE_CODE_SCROLL_SPEED` env var (0-20, default 1) tunes this.
- **PackageManagerAutoUpdater is read-only** — unlike the other updaters, it only shows the command to run rather than performing the update automatically.
- **Survey probability gating** — once a survey is rolled (pass or fail), it does not re-roll on re-renders. The `useFeedbackSurvey` hook uses a ref-based lock to prevent this.
- **Transcript sharing has a 25MB size guard** — large session transcripts are rejected before upload.
- **WorktreeExitDialog uses lazy require** for sessionStorage to avoid circular dependency.
- **FullscreenLayout's ScrollChromeContext** exists specifically to avoid threading scroll state callbacks through Messages → REPL → FullscreenLayout. Components write directly to context instead.
- **MemoryUsageIndicator only renders in "ant" builds** — it is an internal debugging tool, not visible to end users.
- **DevBar only renders in dev/ant** — polls every 500ms for slow synchronous operations, showing only the last 3 to avoid terminal clutter.