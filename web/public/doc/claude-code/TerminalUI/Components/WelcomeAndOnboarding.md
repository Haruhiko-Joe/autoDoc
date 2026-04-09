# Welcome and Onboarding

## Overview & Responsibilities

This module implements the welcome screen, onboarding flows, and first-run experiences for Claude Code's terminal UI. It is part of the **Components** layer within the **TerminalUI** subsystem — sitting alongside 100+ other React components that form the application's visual surface. Sibling modules in the Components group handle message display, dialogs, diff views, and other UI elements; this module specifically owns everything a user sees on startup and during their initial setup.

The module encompasses six major subsystems:

1. **LogoV2** — The main welcome screen with animated logo, Clawd mascot, information feeds, and promotional notices
2. **HelpV2** — The `/help` dialog with tabbed command listings and general information
3. **Onboarding** — The first-run setup wizard (theme selection, OAuth, security notes, terminal setup)
4. **IDE Onboarding** — Dialogs for IDE extension discovery and auto-connect preferences
5. **Chrome Extension Onboarding** — Introduction dialog for the Claude in Chrome feature
6. **DesktopUpsellStartup** — Promotional dialog encouraging desktop app adoption
7. **Passes** — Guest pass referral display and sharing interface

## Key Processes

### Welcome Screen Rendering (LogoV2)

The `LogoV2` component (`src/components/LogoV2/LogoV2.tsx:47`) is the main entry point for the welcome screen. It determines what to display based on several conditions:

1. **Layout mode selection**: Calls `getLayoutMode(columns)` to determine `"compact"`, `"horizontal"`, or `"vertical"` layout based on terminal width
2. **Condensed vs. full mode**: If there are no new release notes AND project onboarding is not needed, the screen renders the compact `CondensedLogo` variant instead of the full bordered welcome box
3. **Full layout**: When shown, it renders a bordered box containing:
   - A welcome message (personalized with the user's display name if available)
   - The Clawd mascot character
   - Model name, billing type, and working directory
   - A `FeedColumn` with contextual information feeds on the right side (in horizontal layout)
4. **Notice stack**: Below the main box, optional notices are rendered: `VoiceModeNotice`, `Opus1mMergeNotice`, `ChannelsNotice`, `EmergencyTip`, sandbox status, tmux session info, company announcements, and debug mode indicators

### Feed System

The feed system provides the informational columns displayed alongside the welcome art:

- **`FeedColumn`** (`src/components/LogoV2/FeedColumn.tsx:11`): Container that renders multiple `Feed` components vertically with dividers, calculating optimal width
- **`Feed`** (`src/components/LogoV2/Feed.tsx:51`): Renders a single feed panel with a title, lines (with optional timestamps), footer, and optional custom content
- **`feedConfigs.tsx`**: Factory functions that create `FeedConfig` objects:
  - `createRecentActivityFeed(activities)` — shows recent session summaries with relative timestamps
  - `createWhatsNewFeed(releaseNotes)` — displays changelog entries
  - `createProjectOnboardingFeed(steps)` — checklist of getting-started steps with checkmarks
  - `createGuestPassesFeed()` — promotional feed for guest pass sharing

The feeds shown depend on context (`src/components/LogoV2/LogoV2.tsx:421`): onboarding steps take priority, then guest passes upsell, then overage credit upsell, with recent activity + changelog as the default.

### Onboarding Flow

The `Onboarding` component (`src/components/Onboarding.tsx:30`) implements a multi-step wizard for first-time users:

1. **Preflight** (if OAuth enabled) — runs `PreflightStep` to validate environment
2. **Theme selection** — presents `ThemePicker` for choosing a color theme
3. **API key approval** (if `ANTHROPIC_API_KEY` env var is set and new) — shows `ApproveApiKey` dialog
4. **OAuth login** (if OAuth enabled and not skipped) — runs `ConsoleOAuthFlow`
5. **Security notes** — displays warnings about Claude's limitations and prompt injection risks, with a link to security documentation
6. **Terminal setup** (if applicable) — offers to configure terminal settings (Shift+Enter for newlines, etc.)

Each step advances via `goToNextStep()`, which increments an index through the `steps` array and logs analytics events. The wizard calls `onDone()` after the final step.

### IDE Onboarding Dialogs

Two dialog components handle IDE extension discovery:

- **`IdeOnboardingDialog`** (`src/components/IdeOnboardingDialog.tsx:14`): Shown when Claude Code detects it's running inside a supported IDE terminal. Displays a welcome message with the IDE name, explains features (file mentions via keyboard shortcut, diagnostics sync), and shows the installed extension version. Uses `markDialogAsShown()` to prevent re-display.
- **`IdeAutoConnectDialog`** (`src/components/IdeAutoConnectDialog.tsx:11`): Asks whether to enable automatic IDE connection when running outside a supported terminal. Presents Yes/No selection and persists the choice to global config via `autoConnectIde` flag. `shouldShowAutoConnectDialog()` checks if the dialog should appear.
- **`IdeDisableAutoConnectDialog`** (`src/components/IdeAutoConnectDialog.tsx:80`): Companion dialog for disabling auto-connect when the user already has it enabled but is in a non-IDE terminal.

### Chrome Extension Onboarding

`ClaudeInChromeOnboarding` (`src/components/ClaudeInChromeOnboarding.tsx:14`) introduces the Chrome browser control feature. On mount it:
1. Logs a `tengu_claude_in_chrome_onboarding_shown` analytics event
2. Checks if the Chrome extension is installed via `isChromeExtensionInstalled()`
3. Sets `hasCompletedClaudeInChromeOnboarding: true` in global config
4. Displays information about browser control capabilities (navigate, fill forms, capture screenshots, record GIFs)
5. Shows installation link if extension not detected, or permissions management link if it is

### Desktop Upsell Startup

`DesktopUpsellStartup` (`src/components/DesktopUpsell/DesktopUpsellStartup.tsx:37`) promotes the desktop app version. It:
- Checks eligibility via `shouldShowDesktopUpsellStartup()` — requires macOS or Windows x64, dynamic config flag enabled, not dismissed, and fewer than 3 impressions
- Presents three options: "Try Claude Code desktop", "Not now", and "Don't show again"
- Selecting "Try" transitions to a `DesktopHandoff` component for app handoff
- "Don't show again" sets `desktopUpsellDismissed: true` in config

### HelpV2 Dialog

`HelpV2` (`src/components/HelpV2/HelpV2.tsx:20`) renders the `/help` screen as a tabbed `Pane`:

1. **General tab** (`src/components/HelpV2/General.tsx:5`): Shows a brief description of Claude Code and a `PromptInputHelpMenu` listing keyboard shortcuts
2. **Commands tab** (`src/components/HelpV2/Commands.tsx:17`): Lists all built-in slash commands in a scrollable `Select` list, deduplicated and sorted alphabetically, with descriptions truncated to terminal width
3. **Custom Commands tab**: Shows user-defined/MCP-registered commands separately

Commands are partitioned by checking against `builtInCommandNames()` and filtering out hidden commands. The dialog is dismissible via the `help:dismiss` keybinding (default: Escape).

### Passes Screen

`Passes` (`src/components/Passes/Passes.tsx:25`) displays the guest pass referral interface:

1. On mount, calls `getCachedOrFetchPassesEligibility()` to check if the user is eligible
2. Fetches redemption data via `fetchReferralRedemptions(campaign)` to determine which passes are used/available
3. Renders pass status icons (available vs. redeemed) and the referral link
4. Pressing Enter copies the referral link to clipboard via OSC escape sequences
5. Tracks analytics events for link copying

## Component Signatures & Props

### LogoV2
```typescript
function LogoV2(): React.ReactNode
```
No props — reads all data from global config, settings, and utility functions.

### Onboarding
```typescript
function Onboarding({ onDone }: { onDone(): void }): React.ReactNode
```
- **onDone**: Called when the entire onboarding wizard completes

### HelpV2
```typescript
function HelpV2({ onClose, commands }: {
  onClose: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  commands: Command[];
}): React.ReactNode
```
- **onClose**: Callback to dismiss the help dialog
- **commands**: Array of available slash commands to display

### ClaudeInChromeOnboarding
```typescript
function ClaudeInChromeOnboarding({ onDone }: { onDone(): void }): React.ReactNode
```

### IdeAutoConnectDialog / IdeOnboardingDialog
```typescript
function IdeAutoConnectDialog({ onComplete }: { onComplete: () => void }): React.ReactNode
function IdeOnboardingDialog({ onDone, installationStatus }: {
  onDone: () => void;
  installationStatus: IDEExtensionInstallationStatus | null;
}): React.ReactNode
```

### Passes
```typescript
function Passes({ onDone }: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
}): React.ReactNode
```

### DesktopUpsellStartup
```typescript
function DesktopUpsellStartup({ onDone }: { onDone: () => void }): React.ReactNode
```

## Interface/Type Definitions

### FeedConfig & FeedLine (`src/components/LogoV2/Feed.tsx:6-18`)
```typescript
type FeedLine = {
  text: string;
  timestamp?: string;
};

type FeedConfig = {
  title: string;
  lines: FeedLine[];
  footer?: string;
  emptyMessage?: string;
  customContent?: { content: React.ReactNode; width: number };
};
```

### ClawdPose (`src/components/LogoV2/Clawd.tsx:5-7`)
```typescript
type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right';
```
Used by the animated Clawd mascot — `AnimatedClawd` cycles through poses on click (jump-wave or look-around animations).

### OnboardingStep (`src/components/Onboarding.tsx:23-26`)
```typescript
type StepId = 'preflight' | 'theme' | 'oauth' | 'api-key' | 'security' | 'terminal-setup';
interface OnboardingStep {
  id: StepId;
  component: React.ReactNode;
}
```

### Visibility Guards (exported functions)

| Function | File | Purpose |
|----------|------|---------|
| `shouldShowAutoConnectDialog()` | `src/components/IdeAutoConnectDialog.tsx:73` | True when not in IDE terminal, auto-connect not yet configured |
| `shouldShowDisableAutoConnectDialog()` | `src/components/IdeAutoConnectDialog.tsx:150` | True when not in IDE terminal but auto-connect is enabled |
| `shouldShowDesktopUpsellStartup()` | `src/components/DesktopUpsell/DesktopUpsellStartup.tsx:25` | Platform + config + impression checks |
| `shouldShowGuestPassesUpsell()` | `src/components/LogoV2/GuestPassesUpsell.tsx:22` | Eligibility + cache + impression checks |
| `shouldShowOverageCreditUpsell()` | `src/components/LogoV2/OverageCreditUpsell.tsx:32` | Backend eligibility + impression cap |
| `shouldShowOpus1mMergeNotice()` | `src/components/LogoV2/Opus1mMergeNotice.tsx:10` | Feature enabled + seen count < 6 |

## Configuration & Defaults

### Impression-Capped Notices

Several notices use a "seen count" pattern to limit how many times they appear:

| Notice | Config Key | Max Shows | Dismiss Key |
|--------|-----------|-----------|-------------|
| Guest Passes Upsell | `passesUpsellSeenCount` | 3 | `hasVisitedPasses` |
| Overage Credit Upsell | `overageCreditUpsellSeenCount` | 3 | `hasVisitedExtraUsage` |
| Voice Mode Notice | `voiceNoticeSeenCount` | 3 | (auto-dismissed when `voiceEnabled` is true) |
| Opus 1M Merge Notice | `opus1mMergeNoticeSeenCount` | 6 | — |
| Desktop Upsell | `desktopUpsellSeenCount` | 3 | `desktopUpsellDismissed` |

### Layout Breakpoints

- **Condensed mode**: Used when there are no release notes to show and project onboarding is not active. Renders a minimal one-line logo.
- **Compact layout**: Narrow terminals get a simplified bordered box with Clawd centered.
- **Horizontal layout**: Wide terminals show Clawd + info on the left, feed columns on the right, separated by a vertical border.
- **Vertical layout**: Medium terminals stack the welcome info above the feeds.
- **Left panel max width**: `LEFT_PANEL_MAX_WIDTH = 50` characters (`src/components/LogoV2/LogoV2.tsx:46`)
- **Welcome art width**: `WELCOME_V2_WIDTH = 58` characters (`src/components/LogoV2/WelcomeV2.tsx:5`)

### Feature Gates

- **`VOICE_MODE`**: Guards `VoiceModeNotice` rendering via `feature('VOICE_MODE')` positive ternary pattern
- **`KAIROS` / `KAIROS_CHANNELS`**: Guards `ChannelsNotice` via conditional `require()` for tree-shaking (`src/components/LogoV2/LogoV2.tsx:36`)

## Edge Cases & Caveats

- **Apple Terminal special rendering**: Both `WelcomeV2` and `Clawd` detect `env.terminal === "Apple_Terminal"` and render simplified variants using different Unicode characters, since Apple Terminal has limited glyph and background color support.
- **Reduced motion support**: `AnimatedAsterisk` and `AnimatedClawd` check `getInitialSettings().prefersReducedMotion` at mount time. If true, animations are skipped entirely (asterisk renders in settled grey, Clawd stays in default pose).
- **Home directory warning**: `createProjectOnboardingFeed()` appends a warning if `getCwd() === homedir()`, advising the user to launch Claude Code in a project directory instead.
- **Guest passes refresh reset**: `resetIfPassesRefreshed()` in `GuestPassesUpsell.tsx:8` resets the upsell seen count and visited flag when the remaining passes increase (e.g., passes were refreshed by a campaign change), ensuring users see the upsell again.
- **EmergencyTip deduplication**: `EmergencyTip` compares the current tip from dynamic config against `lastShownEmergencyTip` in global config, only displaying when the tip content has changed.
- **OffscreenFreeze wrapping**: The main welcome box is wrapped in `<OffscreenFreeze>` to prevent re-renders once the component scrolls out of the visible terminal viewport, avoiding unnecessary terminal resets.
- **Clawd click animations**: `AnimatedClawd` responds to mouse clicks only when mouse tracking is enabled (inside `<AlternateScreen>` / fullscreen mode). The container height is fixed at 3 rows so animations never shift surrounding layout. Two animation sequences cycle: jump-wave (crouch + arms-up) and look-around (look-right, look-left, default).
- **AnimatedAsterisk hue sweep**: Runs a 2-sweep (3 seconds total) rainbow hue animation using `useAnimationFrame`, then settles to grey (`rgb(153,153,153)`). The viewport-pause mechanism automatically stops the animation clock when the element scrolls into scrollback, preventing flicker (`src/components/LogoV2/AnimatedAsterisk.tsx:15-48`).
- **Onboarding API key flow**: If the user approves an `ANTHROPIC_API_KEY` from the environment, the OAuth step is automatically skipped via the `skipOAuth` state flag (`src/components/Onboarding.tsx:34`).