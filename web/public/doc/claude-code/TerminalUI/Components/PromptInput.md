# PromptInput

## Overview & Responsibilities

PromptInput is the primary user input area of the Claude Code terminal UI. It lives within the **TerminalUI → Components** layer and is rendered by the REPL screen at the bottom of the conversation view. It handles everything the user types, pastes, or dictates before it reaches the query engine.

Its responsibilities include:

- **Text entry** with multiline support, cursor management, and vim mode
- **Autocomplete & suggestions** for slash commands, file paths, agents, MCP resources, and Slack channels
- **Image and text paste handling** with automatic truncation for large inputs
- **Input mode switching** between normal prompt mode and bash (`!`) mode
- **Prompt suggestion display** (AI-generated next-turn suggestions with speculative execution)
- **History search** (Ctrl+R style incremental search through past prompts)
- **Footer chrome**: mode indicators, notification badges, stash notices, queued command previews, help menu, task/team status pills, and keyboard shortcut hints
- **Voice input** with a recording/processing shimmer indicator
- **Swarm/team integration**: teammate selection, direct `@name` messaging, and agent view switching

## Key Processes

### Text Input & Submission Flow

1. The user types in the input area, rendered by either `TextInput` (standard) or `VimTextInput` (when `editorMode === 'vim'` in config). Both delegate rendering to `BaseTextInput` (`src/components/BaseTextInput.tsx:22`).

2. As the user types, the `inputFilter` callback in PromptInput intercepts each keystroke to detect mode-switch characters (`!` triggers bash mode), handle special macOS option characters, and manage the lazy-space-after-image-pill behavior.

3. Typeahead suggestions are computed by the `useTypeahead` hook, matching against slash commands, file paths, agents, MCP resources, and Slack channels. Results display in `PromptInputFooterSuggestions` (`src/components/PromptInput/PromptInputFooterSuggestions.tsx:9-17`).

4. On submit (Enter), `onSubmit` (`src/components/PromptInput/PromptInput.tsx:984`) runs through several gates:
   - Checks if a footer pill is selected (swallows Enter to open the pill)
   - Checks for prompt suggestion acceptance (with speculative execution shortcut)
   - Parses `@name` direct messages for team communication
   - Blocks submission if the autocomplete dropdown is still open
   - Routes input to a viewed agent (teammate or local agent) if applicable
   - Falls through to normal leader submission via `onSubmitProp`

### Input Mode System

The module supports two input modes, managed by `inputModes.ts` (`src/components/PromptInput/inputModes.ts:4-13`):

- **`prompt`** (default): Normal conversation mode, prompt character is `❯`
- **`bash`**: Shell command mode, triggered by typing `!` on an empty line. Prompt character becomes `!` in orange. The `!` prefix is prepended to input and stripped before display.

`getModeFromInput()` parses the mode from stored history entries; `getValueFromInput()` strips the mode prefix.

### Paste & Truncation Logic

**Text truncation** (`src/components/PromptInput/inputPaste.ts:4-5`): Inputs exceeding 10,000 characters are automatically truncated. The first and last 500 characters are kept, and the middle is replaced with a `[...Truncated text #N +M lines...]` reference. The hidden content is stored in `pastedContents` (keyed by ID) and reattached at submission time.

The `useMaybeTruncateInput` hook (`src/components/PromptInput/useMaybeTruncateInput.ts:13`) applies truncation via `useEffect` when input length exceeds the threshold, resetting when input is cleared after submission.

**Image paste** is handled upstream in `BaseTextInput` via `usePasteHandler`, which detects clipboard images and inserts `[Image #N]` reference pills into the input text.

### Syntax Highlighting

The displayed input text is augmented with several highlight layers, combined in `combinedHighlights` (around line 601):

| Trigger | Color | Source |
|---------|-------|--------|
| `/command` | Blue (`suggestion`) | `findSlashCommandPositions` |
| `@teammate` mentions | Team member's assigned color | `memberMentionHighlights` |
| Thinking keywords | Rainbow shimmer | `findThinkingTriggerPositions` |
| `btw` side-question | Yellow (`warning`) | `findBtwTriggerPositions` |
| `[Image #N]` pills | Inverse when selected | `parseReferences` |
| History search match | Yellow (`warning`) | Inline |
| Voice interim text | Dim | `voiceInterimRange` |
| Token budget markers | Blue (`suggestion`) | `findTokenBudgetPositions` |
| Slack `#channel` | Blue (`suggestion`) | `findSlackChannelPositions` |

Rendering is handled by `HighlightedInput` and `ShimmerChar` in `ShimmeredInput.tsx`, which segments text by highlight ranges and optionally applies animated shimmer effects.

### Footer Pill Navigation

The footer below the input contains navigable "pills" for background tasks, teams, bridge status, tmux sessions, and the companion sprite. Navigation state is stored in `AppState.footerSelection`.

The `footerItems` array defines the ordering. Arrow keys (when input is empty or cursor is on the last line) move between pills. Enter opens the selected pill's dialog.

## Component Architecture

### `PromptInput` (main component)
`src/components/PromptInput/PromptInput.tsx:194`

The ~2300-line orchestrator. Accepts 40+ props from the REPL screen and wires together all sub-components and hooks. Key internal state includes:
- `cursorOffset` / `setCursorOffset` — character position in the input
- `suggestionsState` — active typeahead dropdown items and selection index
- `footerItemSelected` — which footer pill is focused
- Dialog visibility booleans (`showModelPicker`, `showTeamsDialog`, etc.)

### `PromptInputFooter`
`src/components/PromptInput/PromptInputFooter.tsx:63`

Composes the area below the text input. Contains:
- `PromptInputFooterLeftSide` — mode indicators, vim mode label, history search bar, permission badges, task/team status
- `PromptInputFooterSuggestions` — autocomplete dropdown overlay
- `PromptInputHelpMenu` — keyboard shortcut reference (toggled by `?` or keybinding)
- `Notifications` — status badges (API key, token warnings, auto-updater, IDE selection, voice state, sandbox violations)
- `StatusLine` / `CoordinatorTaskPanel` — background task and coordinator agent status

### `PromptInputFooterSuggestions`
`src/components/PromptInput/PromptInputFooterSuggestions.tsx:9-17`

Renders the autocomplete dropdown. Each `SuggestionItem` has an `id`, `displayText`, optional `tag`, `description`, and `color`. Supports unified suggestion types (files with `+` icon, MCP resources with `◇`, agents with `*`) and standard command suggestions. Limited to `OVERLAY_MAX_ITEMS = 5` visible rows.

### `PromptInputModeIndicator`
`src/components/PromptInput/PromptInputModeIndicator.tsx:63`

Renders the prompt character (`❯` or `!`) with color based on mode, loading state, and teammate view. In swarm mode, the prompt character takes the teammate's assigned color.

### `PromptInputStashNotice`
`src/components/PromptInput/PromptInputStashNotice.tsx:8`

Shows "› Stashed (auto-restores after submit)" when the user has stashed input (Ctrl+S). The stash mechanism saves the current input text, cursor position, and pasted contents, restoring them after the next submission.

### `PromptInputQueuedCommands`
`src/components/PromptInput/PromptInputQueuedCommands.tsx:71`

Previews queued messages above the input as rendered `Message` components. Task notifications are capped at `MAX_VISIBLE_NOTIFICATIONS = 3` with an overflow summary. Idle notifications are filtered out silently.

### `HistorySearchInput`
`src/components/PromptInput/HistorySearchInput.tsx:11`

Inline search bar that replaces the footer left side during Ctrl+R history search. Displays "search prompts:" or "no matching prompt:" with the search query in a compact `TextInput`.

### `VoiceIndicator`
`src/components/PromptInput/VoiceIndicator.tsx:24`

Feature-gated component (`VOICE_MODE`). Shows "listening…" during recording, and an animated shimmer "Voice: processing…" during processing. The shimmer uses a 2-second sinusoidal pulse between dim and bright gray. `VoiceWarmupHint` shows a static "keep holding…" during the brief warmup window.

### `IssueFlagBanner`
`src/components/PromptInput/IssueFlagBanner.tsx:9`

Internal-only (ant build) banner prompting users to report friction via `/issue`. Returns `null` in external builds.

### `SandboxPromptFooterHint`
`src/components/PromptInput/SandboxPromptFooterHint.tsx:7`

Shows a transient notification when sandbox mode blocks operations: "⧈ Sandbox blocked N operations · ctrl+o for details · /sandbox to disable". Auto-clears after 5 seconds.

## Text Input Primitives

### `TextInput`
`src/components/TextInput.tsx:37`

The standard text input component. Wraps `BaseTextInput` with:
- Theme-aware cursor rendering
- Voice recording waveform cursor (animated single-bar visualization using audio levels)
- Clipboard image paste hint (`useClipboardImageHint`)
- Accessibility mode support (disables cursor animations)

### `BaseTextInput`
`src/components/BaseTextInput.tsx:22`

The shared rendering core for both standard and vim input modes. Handles:
- Paste detection via `usePasteHandler` (distinguishes typing from paste by timing threshold)
- Cursor positioning via `useDeclaredCursor`
- Placeholder rendering when input is empty
- Viewport windowing for single-line mode (scrolls horizontally)
- Highlight filtering and `HighlightedInput` rendering
- Argument hint display for slash commands

### `VimTextInput`
`src/components/VimTextInput.tsx:13`

Wraps `BaseTextInput` with vim keybinding support via the `useVimInput` hook. Passes vim-specific props (`onModeChange`, `onUndo`, `disableEscapeDoublePress`) and uses `chalk.inverse` for cursor rendering.

### `SearchBox`
`src/components/SearchBox.tsx:14`

A compact search input with a rounded border and `⌕` prefix. Used outside of PromptInput for various search dialogs. Renders cursor inline (inverse character) when focused and terminal is focused, placeholder text when empty.

## Supporting Components

### `ContextSuggestions`
`src/components/ContextSuggestions.tsx:11`

Renders a list of context optimization suggestions with severity icons, titles, and estimated token savings. Used to advise users on reducing context size.

### `ContextVisualization`
`src/components/ContextVisualization.tsx`

Large visualization component for displaying context window usage and composition. Rendered in diagnostic/debug views.

## Configuration & Defaults

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `editorMode` | Global config | `"normal"` | `"vim"` enables VimTextInput |
| `prefersReducedMotion` | Settings | `false` | Disables shimmer animations |
| `CLAUDE_CODE_ACCESSIBILITY` | Env var | — | Disables cursor animations |
| `TRUNCATION_THRESHOLD` | `inputPaste.ts:4` | `10000` chars | Threshold for auto-truncation |
| `PREVIEW_LENGTH` | `inputPaste.ts:5` | `1000` chars | Chars kept at start+end when truncated |
| `OVERLAY_MAX_ITEMS` | `PromptInputFooterSuggestions.tsx:18` | `5` | Max autocomplete dropdown rows |
| `MAX_VISIBLE_NOTIFICATIONS` | `PromptInputQueuedCommands.tsx:30` | `3` | Max task notification previews |
| `FOOTER_TEMPORARY_STATUS_TIMEOUT` | `Notifications.tsx:40` | `5000` ms | Duration for transient footer notifications |

## Hooks

| Hook | File | Purpose |
|------|------|---------|
| `usePromptInputPlaceholder` | `usePromptInputPlaceholder.ts:25` | Computes dynamic placeholder text (teammate hint, queue hint, example commands) |
| `useMaybeTruncateInput` | `useMaybeTruncateInput.ts:13` | Auto-truncates long inputs on initial load |
| `useShowFastIconHint` | `useShowFastIconHint.ts:11` | Shows `/fast` hint for 5 seconds, once per session |
| `useSwarmBanner` | `useSwarmBanner.ts:44` | Returns banner info for swarm/teammate/agent context |

## Edge Cases & Caveats

- **Footer pill selection swallows Enter**: When a footer pill (tasks, teams, bridge) is selected, pressing Enter opens that pill's dialog instead of submitting input. This is intentional but can surprise users who don't notice the selection state.

- **Suggestion dropdown blocks submission**: If the autocomplete dropdown is visible and the user presses Enter, the input is not submitted (except for directory-only suggestions). Users must press Escape or clear the dropdown first.

- **External input injection**: When input changes externally (e.g., speech-to-text), the cursor automatically moves to the end. This is tracked via `lastInternalInputRef` to distinguish internal keystrokes from external mutations.

- **Image pill cursor snapping**: The cursor cannot land inside an `[Image #N]` reference. If up/down navigation or a click places it mid-pill, it snaps to the nearer boundary (`src/components/PromptInput/PromptInput.tsx:594-600`).

- **Bash mode prefix**: In bash mode, the `!` character is logically part of the stored input but hidden from the display. `getValueFromInput()` strips it; `prependModeCharacterToInput()` adds it back for history storage.

- **IssueFlagBanner** is compiled out of external builds via dead-code elimination (`"external" !== 'ant'` evaluates to `true` at build time).