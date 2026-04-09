# InteractiveHelpers

## Overview & Responsibilities

The InteractiveHelpers module is the **orchestration layer for interactive user flows** within the TerminalUI subsystem. It coordinates the multi-step dialog sequences that run before the main REPL appears — onboarding, trust verification, permission prompts, API key approval, and more — and provides factory functions for imperatively launching specific dialogs from anywhere in the application.

The module is split across three files with distinct roles:

| File | Role |
|------|------|
| `src/interactiveHelpers.tsx` | Core dialog primitives (`showDialog`, `showSetupDialog`) and the `showSetupScreens` orchestrator that runs the full pre-REPL setup sequence |
| `src/dialogLaunchers.tsx` | Thin factory functions that dynamically import a dialog component and wire it through `showSetupDialog` |
| `src/projectOnboardingState.ts` | State machine for per-project first-run onboarding flows (workspace setup, CLAUDE.md creation) |

Within the TerminalUI architecture, this module sits between the Bootstrap layer (which calls `showSetupScreens` after initialization) and the individual dialog components. It acts as the imperative bridge that lets procedural startup code render React dialog trees and `await` their results.

## Key Processes

### Pre-REPL Setup Sequence (`showSetupScreens`)

The main orchestration function `showSetupScreens()` (`src/interactiveHelpers.tsx:104-298`) runs a strictly ordered chain of conditional dialogs before the REPL renders. Each step dynamically imports its component only when needed:

1. **Onboarding** — If the user has no theme or hasn't completed onboarding, show the `Onboarding` dialog and call `completeOnboarding()` to persist the flag.
2. **Trust Dialog** — Unless running in Claubbit mode, check whether the current workspace is trusted. If not, render `TrustDialog`. After trust is established, reinitialize GrowthBook with fresh auth headers and prefetch system context.
3. **MCP Server Approvals** — If settings are valid, check for any `mcp.json` servers needing user approval.
4. **CLAUDE.md External Includes** — If external includes exist that haven't been approved, show `ClaudeMdExternalIncludesDialog`.
5. **GitHub Repo Path Mapping** — Fire-and-forget update of the repo-to-path mapping (must happen after trust).
6. **Environment Variables** — Apply config environment variables now that the trust boundary has been crossed.
7. **Telemetry Initialization** — Deferred to next tick so OTEL endpoint env vars are available.
8. **Grove Policy Dialog** — If the user qualifies for Grove, show the policy dialog; exit on escape.
9. **Custom API Key Approval** — If `ANTHROPIC_API_KEY` is set and unrecognized, show `ApproveApiKey`.
10. **Bypass Permissions Warning** — If running in `bypassPermissions` mode, show a confirmation dialog.
11. **Auto Mode Opt-In** — If the `TRANSCRIPT_CLASSIFIER` feature is enabled and auto mode is active, require opt-in consent.
12. **Dev Channels Confirmation** — If development channels are specified via CLI flags, show a confirmation or silently append them when channels are blocked.
13. **Chrome Onboarding** — For first-time Claude-in-Chrome users.

The function returns `true` if the onboarding dialog was shown, `false` otherwise. This return value is used downstream to set the Grove dialog's `location` parameter.

### Dialog Rendering Primitive

The core pattern for imperative dialog rendering is `showDialog<T>()` (`src/interactiveHelpers.tsx:39-44`):

```typescript
// src/interactiveHelpers.tsx:39-44
export function showDialog<T = void>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode
): Promise<T>
```

It wraps `root.render()` in a `Promise` — the rendered component receives a `done` callback, and the promise resolves when the component calls it. This converts React's callback-driven rendering into an `await`-able imperative API.

`showSetupDialog<T>()` (`src/interactiveHelpers.tsx:86-92`) wraps `showDialog` with `<AppStateProvider>` and `<KeybindingSetup>` so every setup dialog gets consistent state management and keybindings.

### Dialog Launcher Pattern

Each launcher in `src/dialogLaunchers.tsx` follows an identical pattern:

1. Dynamically import the dialog component (code-splitting)
2. Call `showSetupDialog<T>()` with a renderer that wires props and the `done` callback
3. Return the typed `Promise<T>` result

This keeps dialog-specific JSX out of the main startup code and ensures components are only loaded when actually needed.

## Function Signatures

### interactiveHelpers.tsx

#### `showDialog<T>(root, renderer): Promise<T>`
Core primitive — renders a React element into the Ink root and resolves when the component signals completion via the `done` callback.

#### `showSetupDialog<T>(root, renderer, options?): Promise<T>`
Wraps `showDialog` with `<AppStateProvider>` + `<KeybindingSetup>`. Optional `onChangeAppState` handler.

#### `exitWithError(root, message, beforeExit?): Promise<never>`
Renders an error message (red) through Ink and exits with code 1. Use for fatal errors after the Ink root exists, since `console.error` is swallowed by Ink's `patchConsole`.

#### `exitWithMessage(root, message, options?): Promise<never>`
General version of `exitWithError`. Accepts optional `color`, `exitCode` (default 1), and `beforeExit` async hook.

#### `renderAndRun(root, element): Promise<void>`
Renders the main UI, starts deferred prefetches, waits for exit, then runs graceful shutdown. Used for full-screen UIs (REPL, ResumeConversation).

#### `showSetupScreens(root, permissionMode, allowDangerouslySkipPermissions, commands?, claudeInChrome?, devChannels?): Promise<boolean>`
The main pre-REPL orchestrator. Runs the full chain of conditional setup dialogs. Returns whether the onboarding screen was shown.

- **permissionMode**: `PermissionMode` — controls which permission-related dialogs appear
- **allowDangerouslySkipPermissions**: `boolean` — triggers the bypass-mode warning dialog
- **commands**: `Command[]` — passed to the TrustDialog
- **claudeInChrome**: `boolean` — triggers Chrome-specific onboarding
- **devChannels**: `ChannelEntry[]` — development channel entries to confirm

#### `completeOnboarding(): void`
Persists `hasCompletedOnboarding: true` and the current version to global config.

#### `getRenderContext(exitOnCtrlC): { renderOptions, getFpsMetrics, stats }`
Creates the Ink render configuration including FPS tracking, frame timing logging (bench mode via `CLAUDE_CODE_FRAME_TIMING_LOG`), flicker detection, and a stats store.

### dialogLaunchers.tsx

All launchers accept an Ink `Root` as the first argument and return a typed `Promise`.

| Function | Result Type | Dialog |
|----------|-------------|--------|
| `launchSnapshotUpdateDialog(root, props)` | `'merge' \| 'keep' \| 'replace'` | Agent memory snapshot update prompt |
| `launchInvalidSettingsDialog(root, props)` | `void` | Settings validation error display |
| `launchAssistantSessionChooser(root, props)` | `string \| null` | Bridge session picker |
| `launchAssistantInstallWizard(root)` | `string \| null` | Assistant install wizard (rejects on failure) |
| `launchTeleportResumeWrapper(root)` | `TeleportRemoteResponse \| null` | Teleport session picker |
| `launchTeleportRepoMismatchDialog(root, props)` | `string \| null` | Local checkout picker for repo mismatch |
| `launchResumeChooser(root, appProps, worktreePathsPromise, resumeProps)` | `void` | Full-screen resume conversation UI (uses `renderAndRun`, not `showSetupDialog`) |

### projectOnboardingState.ts

#### `getSteps(): Step[]`
Returns the current onboarding checklist. Steps are dynamically computed from filesystem state:
- **workspace**: "Ask Claude to create a new app or clone a repository" — enabled when CWD is empty
- **claudemd**: "Run /init to create a CLAUDE.md file" — enabled when CWD is non-empty, complete when `CLAUDE.md` exists

#### `isProjectOnboardingComplete(): boolean`
Returns `true` when all enabled, completable steps are complete.

#### `shouldShowProjectOnboarding(): boolean` (memoized)
Returns `false` if onboarding is already completed, has been shown 4+ times, or running in demo mode. Otherwise checks `isProjectOnboardingComplete()`.

#### `maybeMarkProjectOnboardingComplete(): void`
Called on every REPL prompt submit. Short-circuits on the cached config flag to avoid filesystem hits on the hot path. Persists `hasCompletedProjectOnboarding: true` when all steps are done.

#### `incrementProjectOnboardingSeenCount(): void`
Increments the seen counter in project config to suppress the onboarding UI after 4 views.

## Type Definitions

### `Step` (`src/projectOnboardingState.ts:11-17`)

```typescript
type Step = {
  key: string          // Unique identifier ('workspace' | 'claudemd')
  text: string         // User-facing description
  isComplete: boolean  // Whether the step is done
  isCompletable: boolean // Whether the step can be completed
  isEnabled: boolean   // Whether the step applies to the current workspace
}
```

## Edge Cases & Caveats

- **Skip conditions for `showSetupScreens`**: The entire function short-circuits in test environments, when `IS_DEMO` is set, or when `CLAUBBIT` is truthy. Non-interactive sessions (CI/CD with `-p`) never call this function at all.
- **Trust before environment variables**: Config environment variables from untrusted sources are only applied *after* the trust dialog is accepted. This is a deliberate security boundary.
- **`shouldShowProjectOnboarding` is memoized**: It uses `lodash/memoize`, so the result is computed once per process. This is intentional since it runs during first render and hitting the filesystem repeatedly would be expensive.
- **`maybeMarkProjectOnboardingComplete` hot-path optimization**: Short-circuits on the cached config flag before calling `isProjectOnboardingComplete()`, which touches the filesystem. This matters because the REPL calls it on every prompt submit.
- **`launchAssistantInstallWizard` uses `Promise.race`**: It races the normal dialog result against an error promise, allowing install failures to propagate as rejections rather than resolving to `null`.
- **`launchResumeChooser` differs from other launchers**: It uses `renderAndRun` (full-screen, waits for exit) instead of `showSetupDialog` (modal overlay, resolves on done). It also parallelizes the worktree paths fetch with the component dynamic imports via `Promise.all`.
- **Flicker tracking**: `getRenderContext` tracks visual flickers but skips reporting for terminals that support DEC 2026 synchronized output, since clear+redraw is atomic there.
- **Project onboarding suppression**: The onboarding checklist is suppressed after being shown 4 times (`projectOnboardingSeenCount >= 4`), even if steps remain incomplete, to avoid annoying users who intentionally skip it.