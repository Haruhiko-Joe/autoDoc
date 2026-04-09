# Status and Progress Indicators

## Overview & Responsibilities

The StatusAndProgress module is the visual feedback layer of the Claude Code terminal UI. It encompasses all components that communicate ongoing activity, completion state, and session metadata to the user — from the persistent status bar at the bottom of the screen, to animated spinners during AI processing, to progress indicators for tool execution and multi-agent coordination.

Within the **TerminalUI > Components** hierarchy, this module sits alongside message display, dialogs, and input components. While other component groups handle content *display*, this module handles *state communication* — telling the user what Claude is doing right now, how long it's been going, and how much it's costing.

The module breaks into five functional groups:

1. **StatusLine** — The persistent bottom bar showing model, cost, token count, and session info
2. **Spinner system** — Animated indicators during AI processing (requesting, thinking, tool use)
3. **Progress components** — Tool-specific and agent-specific progress displays
4. **Coordinator panel** — Multi-agent task management UI
5. **Effort indicators** — Visual controls for the reasoning effort level

## Key Processes

### StatusLine Update Flow

The StatusLine (`src/components/StatusLine.tsx`) renders a persistent bar at the bottom of the terminal. Rather than directly rendering text, it delegates to a user-configurable status line command:

1. `StatusLineInner` subscribes to changes in `lastAssistantMessageId`, `permissionMode`, `vimMode`, and `mainLoopModel`
2. On any change, `scheduleUpdate()` debounces (300ms) a call to `doUpdate()`
3. `doUpdate()` calls `buildStatusLineCommandInput()` which assembles a rich `StatusLineCommandInput` object containing:
   - Model info (id, display name)
   - Workspace info (current dir, project dir, added dirs)
   - Cost metrics (total cost, durations, lines added/removed)
   - Context window usage (input/output tokens, percentage used)
   - Rate limit utilization (5-hour and 7-day windows)
   - Optional vim mode, agent type, remote session, and worktree info
4. This input is passed to `executeStatusLineCommand()` which runs the user's configured status line shell command
5. The resulting text is stored in `AppState.statusLineText`

The `statusLineShouldDisplay()` function gates visibility — the status line is hidden in assistant/Kairos mode since the displayed fields would reflect the REPL process rather than the actual agent.

> Source: `src/components/StatusLine.tsx:30-35` (visibility gate), `src/components/StatusLine.tsx:36-127` (input builder), `src/components/StatusLine.tsx:138-250` (update loop)

### Spinner Animation Flow

The Spinner is the primary indicator shown while Claude is processing. It uses a **two-tier rendering architecture** to optimize performance:

1. **`SpinnerWithVerb`** (outer, `src/components/Spinner.tsx:62-81`) — Re-renders only when props or app state change (~25×/turn). Handles:
   - Selecting a random verb from `spinnerVerbs` or using the current task's active form
   - Choosing between brief mode (`BriefSpinner`) and full mode (`SpinnerWithVerbInner`)
   - Computing teammate state, effort suffix, tips, and budget text
   - Deciding between animated spinner, idle display, and spinner tree views

2. **`SpinnerAnimationRow`** (inner, `src/components/Spinner/SpinnerAnimationRow.tsx:81-102`) — Owns `useAnimationFrame(50)` and runs at ~20fps. Computes all time-dependent values:
   - **Frame index**: `Math.floor(time / 120)` — cycles through spinner character frames
   - **Glimmer index**: Sweeps across the message text creating a shimmer highlight
   - **Flash opacity**: Sine-wave pulsing during tool-use mode
   - **Stalled intensity**: Gradual red tint when no new tokens arrive for 3+ seconds
   - **Token counter animation**: Smooth increment toward actual token count
   - **Elapsed time**: Wall-clock duration accounting for pauses
   - **Thinking shimmer**: Sine-wave glow on "thinking" text after 3s delay

The spinner characters cycle through platform-specific Unicode glyphs (defined in `src/components/Spinner/utils.ts:4-11`):
- macOS: `·`, `✢`, `✳`, `✶`, `✻`, `✽`
- Ghostty terminal: uses `*` instead of `✽` due to rendering offset
- Other platforms: uses `*` instead of `✳`

The character sequence plays forward then backward (`[...chars, ...chars.reverse()]`) for a smooth breathing effect.

### Stalled Detection

`useStalledAnimation` (`src/components/Spinner/useStalledAnimation.ts`) monitors token flow and signals when Claude appears stuck:

1. Tracks `lastTokenTime` — resets whenever `currentResponseLength` increases
2. After 3 seconds with no new tokens (and no active tools), sets `isStalled = true`
3. `stalledIntensity` ramps from 0 to 1 over the next 2 seconds
4. The intensity is smoothed via exponential decay (`current += diff * 0.1` per 50ms step) unless `reducedMotion` is enabled
5. `SpinnerGlyph` uses `interpolateColor()` to blend from the theme color toward error red (`rgb(171, 43, 63)`) based on intensity

> Source: `src/components/Spinner/useStalledAnimation.ts:6-75`

### Shimmer Animation

`useShimmerAnimation` (`src/components/Spinner/useShimmerAnimation.ts`) creates the traveling highlight effect on spinner messages:

1. Subscribes to `useAnimationFrame` at speed determined by mode: 50ms for `requesting`, 200ms for others
2. Computes a `glimmerIndex` that sweeps across the message width with 10-char padding on each side
3. Direction depends on mode: left-to-right for `requesting`, right-to-left otherwise
4. When stalled, returns index `-100` (off-screen) to disable the shimmer
5. Unsubscribes from the animation clock when stalled to avoid unnecessary 20fps rendering

`ShimmerChar` and `FlashingChar` are the per-character rendering components:
- **`ShimmerChar`** (`src/components/Spinner/ShimmerChar.tsx`): Highlights characters at or adjacent to the glimmer index using the shimmer color
- **`FlashingChar`** (`src/components/Spinner/FlashingChar.tsx`): Interpolates between base and shimmer colors using `flashOpacity` (sine wave during tool-use mode), with ANSI fallback for themes without RGB support

### Teammate Spinner Tree

When multiple in-process teammate agents are running, the spinner can display a tree view (`src/components/Spinner/TeammateSpinnerTree.tsx`):

1. `TeammateSpinnerTree` renders a "team-lead" header line plus one `TeammateSpinnerLine` per running teammate
2. Each `TeammateSpinnerLine` (`src/components/Spinner/TeammateSpinnerLine.tsx`) shows the teammate's color-coded name, spinner verb, elapsed time, token count, and idle duration
3. Lines include optional message previews (last 3 lines of the teammate's conversation)
4. Selection mode highlights the selected teammate with `╞═`/`╘═` tree chars (vs normal `├─`/`└─`) and supports keyboard navigation (shift+↑/↓)

### Coordinator Agent Panel

The `CoordinatorTaskPanel` (`src/components/CoordinatorAgentStatus.tsx`) provides a steerable list of background agents below the prompt:

1. `getVisibleAgentTasks()` filters `AppState.tasks` to panel-managed agent tasks with `evictAfter !== 0`, sorted by start time
2. A 1-second interval tick re-renders for elapsed time and evicts tasks past their `evictAfter` deadline
3. Each agent is rendered as an `AgentLine` with status icons (play/pause), elapsed time, and token counts
4. Enter to view/steer an agent, x to dismiss

## Function Signatures & Components

### `statusLineShouldDisplay(settings: ReadonlySettings): boolean`

Returns whether the status line should be shown. Returns `false` in Kairos/assistant mode.

> Source: `src/components/StatusLine.tsx:30-35`

### `SpinnerWithVerb(props: Props): React.ReactNode`

Main spinner entry point. Branches between `BriefSpinner` and `SpinnerWithVerbInner` based on `isBriefOnly` state.

| Prop | Type | Description |
|------|------|-------------|
| `mode` | `SpinnerMode` | Current phase: `'requesting'`, `'thinking'`, `'tool-use'`, etc. |
| `loadingStartTimeRef` | `RefObject<number>` | Wall-clock start of the current loading phase |
| `totalPausedMsRef` | `RefObject<number>` | Total time spent paused |
| `pauseStartTimeRef` | `RefObject<number \| null>` | When the current pause started (null if not paused) |
| `responseLengthRef` | `RefObject<number>` | Current response length in characters (for token estimation) |
| `overrideColor` | `keyof Theme \| null` | Optional override for spinner/message color |
| `overrideShimmerColor` | `keyof Theme \| null` | Optional override for shimmer color |
| `overrideMessage` | `string \| null` | Optional override for the spinner verb |
| `spinnerSuffix` | `string \| null` | Optional suffix appended after the status line |
| `verbose` | `boolean` | Whether to always show timer and token count |
| `hasActiveTools` | `boolean` | Whether tools are currently executing (suppresses stall detection) |
| `leaderIsIdle` | `boolean` | Whether the leader's turn has completed |

> Source: `src/components/Spinner.tsx:42-57` (Props type), `src/components/Spinner.tsx:62-81` (component)

### `SpinnerGlyph(props): React.ReactNode`

Renders a single animated spinner character. Supports reduced motion (slowly flashing dot on a 2s cycle), stalled color interpolation, and normal animated frame cycling.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `frame` | `number` | — | Current animation frame index |
| `messageColor` | `keyof Theme` | — | Base color for the spinner glyph |
| `stalledIntensity` | `number` | `0` | Blend factor toward error red (0–1) |
| `reducedMotion` | `boolean` | `false` | Use slow-flash dot instead of animation |
| `time` | `number` | `0` | Animation clock time (for reduced motion cycle) |

> Source: `src/components/Spinner/SpinnerGlyph.tsx:22-79`

### `GlimmerMessage(props): React.ReactNode`

Renders the spinner message text with per-character shimmer, flash, and stalled color effects. Segments the message using grapheme segmenter for correct Unicode handling.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `message` | `string` | — | The text to render with effects |
| `mode` | `SpinnerMode` | — | Determines shimmer vs flash behavior |
| `messageColor` | `keyof Theme` | — | Base text color |
| `glimmerIndex` | `number` | — | Position of the shimmer highlight |
| `flashOpacity` | `number` | — | Flash blend factor (0–1, used in tool-use mode) |
| `shimmerColor` | `keyof Theme` | — | Color for highlighted characters |
| `stalledIntensity` | `number` | `0` | Blend toward error red |

> Source: `src/components/Spinner/GlimmerMessage.tsx:23+`

### `ToolUseLoader(props): React.ReactNode`

A blinking dot indicator for tool use status.

| Prop | Type | Description |
|------|------|-------------|
| `isError` | `boolean` | Tool resulted in error (shows error color) |
| `isUnresolved` | `boolean` | Tool is still running (shows dim blinking) |
| `shouldAnimate` | `boolean` | Whether to animate the blink |

Uses `useBlink` hook for the blinking animation. Renders a `BLACK_CIRCLE` character with color based on state: dim when unresolved, error-colored on failure, success-colored on completion.

> Source: `src/components/ToolUseLoader.tsx:11-41`

### `BashModeProgress(props): React.ReactNode`

Shows progress for bash command execution: the input command via `UserBashInputMessage` and either a `ShellProgressMessage` (when progress data is available) or `BashTool.renderToolUseProgressMessage` fallback.

| Prop | Type | Description |
|------|------|-------------|
| `input` | `string` | The bash command being executed |
| `progress` | `ShellProgress \| null` | Shell progress data (output, elapsed time, total lines) |
| `verbose` | `boolean` | Whether to show verbose output |

> Source: `src/components/BashModeProgress.tsx:13-55`

### `AgentProgressLine(props): React.ReactNode`

Renders a single line in a tree display for a sub-agent's progress. Shows agent type/name, description, tool use count, token count, and status text. Uses tree-drawing characters (`├─` / `└─`) for hierarchy.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `agentType` | `string` | — | Agent type label |
| `description` | `string?` | — | Agent description |
| `name` | `string?` | — | Agent name (used when `hideType` is true) |
| `descriptionColor` | `keyof Theme?` | — | Background color for description |
| `taskDescription` | `string?` | — | Description shown when agent is backgrounded |
| `toolUseCount` | `number` | — | Number of tools the agent has used |
| `tokens` | `number \| null` | — | Token count |
| `color` | `keyof Theme?` | — | Background color for agent type label |
| `isLast` | `boolean` | — | Whether this is the last item (affects tree char) |
| `isResolved` | `boolean` | — | Whether the agent has finished |
| `isAsync` | `boolean` | `false` | Whether the agent is async/backgrounded |
| `lastToolInfo` | `string?` | — | Description of the last tool used |
| `hideType` | `boolean` | `false` | Show name instead of type label |

> Source: `src/components/AgentProgressLine.tsx:23+`

### `CoordinatorTaskPanel(): React.ReactNode`

A steerable list of background agents displayed below the prompt input.

> Source: `src/components/CoordinatorAgentStatus.tsx:34-76`

### `getVisibleAgentTasks(tasks: AppState['tasks']): LocalAgentTaskState[]`

Filters and sorts panel-managed agent tasks by start time. Tasks with `evictAfter !== 0` are considered visible.

> Source: `src/components/CoordinatorAgentStatus.tsx:31-33`

### `useCoordinatorTaskCount(): number`

Intended to return the count of visible coordinator tasks (for selection bounds). **Note:** The current implementation is a stub that always returns `0` — it reads `AppState.tasks` but does not actually compute the visible task count. The panel's own rendering logic uses `getVisibleAgentTasks()` directly, so this hook's hardcoded return value does not affect the panel itself, but any consumer relying on this hook for accurate counts will receive incorrect data.

> Source: `src/components/CoordinatorAgentStatus.tsx:83-91`

### `StatusNotices(props): React.ReactNode`

Displays startup alerts/warnings. Gathers active notices via `getActiveNotices()` using a context built from global config, agent definitions, and memory files. Returns `null` when no notices are active.

| Prop | Type | Description |
|------|------|-------------|
| `agentDefinitions` | `AgentDefinitionsResult?` | Available agent definitions for notice evaluation |

> Source: `src/components/StatusNotices.tsx:18-54`

### `getEffortNotificationText(effortValue, model): string | undefined`

Builds the effort-changed notification text (e.g., `◐ medium · /effort`). Returns `undefined` if the model doesn't support effort.

> Source: `src/components/EffortIndicator.ts:18-25`

### `effortLevelToSymbol(level: EffortLevel): string`

Maps effort levels to their Unicode symbols: `low` → `EFFORT_LOW`, `medium` → `EFFORT_MEDIUM`, `high` → `EFFORT_HIGH`, `max` → `EFFORT_MAX`. Falls back to `EFFORT_HIGH` for unknown values.

> Source: `src/components/EffortIndicator.ts:27-42`

### `EffortCallout(props): React.ReactNode`

An interactive dialog for selecting reasoning effort level. Shows a `Select` dropdown with effort options, auto-dismisses after 30 seconds, and persists the selection to user settings via `updateSettingsForSource`.

| Prop | Type | Description |
|------|------|-------------|
| `model` | `string` | Current model ID (determines default effort and support) |
| `onDone` | `(selection: EffortCalloutSelection) => void` | Callback when user selects or dismisses |

> Source: `src/components/EffortCallout.tsx:20+`

## Configuration & Defaults

| Setting | Default | Description |
|---------|---------|-------------|
| `settings.statusLine` | `undefined` | Status line command config. When undefined, status line is hidden |
| `settings.prefersReducedMotion` | `false` | Disables animation; shows slowly flashing dot instead of spinning characters |
| `settings.spinnerTipsEnabled` | `true` | Whether to show contextual tips below the spinner |
| Debounce interval | 300ms | StatusLine update debounce period |
| Stall threshold | 3000ms | Time without new tokens before spinner starts turning red |
| Stall ramp | 2000ms | Duration over which stalled intensity ramps from 0 to 1 |
| Auto-dismiss (EffortCallout) | 30000ms | EffortCallout auto-dismiss timeout |
| Show tokens threshold | 30000ms | Elapsed time before token count appears in spinner |
| Reduced motion cycle | 2000ms | Dot flash cycle period when reduced motion is enabled |

## Utility Functions (`src/components/Spinner/utils.ts`)

- **`getDefaultCharacters(): string[]`** — Returns platform-appropriate spinner glyph array
- **`interpolateColor(color1, color2, t): RGBColor`** — Linear RGB interpolation between two colors (t: 0–1)
- **`toRGBColor(color): string`** — Converts `{r, g, b}` to `rgb(r,g,b)` string for Ink's `<Text>` component
- **`hueToRgb(hue): RGBColor`** — HSL hue to RGB conversion (fixed s=0.7, l=0.6, used by voice-mode waveform)
- **`parseRGB(colorStr): RGBColor | null`** — Parses `rgb(r,g,b)` strings with result caching via `RGB_CACHE`

## Barrel Export (`src/components/Spinner/index.ts`)

The Spinner barrel re-exports: `FlashingChar`, `GlimmerMessage`, `ShimmerChar`, `SpinnerGlyph`, `SpinnerMode` (type), `useShimmerAnimation`, `useStalledAnimation`, `getDefaultCharacters`, `interpolateColor`.

Teammate components (`TeammateSpinnerTree`, `TeammateSpinnerLine`) are intentionally **not** exported from the barrel — they use dynamic `require()` to enable dead code elimination. See `src/components/Spinner.tsx` and the REPL for the correct import pattern.

## Edge Cases & Caveats

- **ANSI dim/bold bug**: The `ToolUseLoader` contains a warning about chalk's handling of `</dim>` and `</bold>` — both are reset by the same escape sequence (`\x1b[22m`). A `<dim>` element immediately followed by `<bold>` incorrectly renders the bold text as dim. The workaround is careful element ordering to avoid adjacent dim→bold transitions. See comments in `src/components/ToolUseLoader.tsx`.

- **Stall false positives**: When a leader is idle but teammates are running, `useStalledAnimation` would detect a stall (no new leader tokens). The `leaderIsIdle` prop suppresses this by treating it like `hasActiveTools`, resetting the stall timer.

- **Shimmer clock leak**: `useShimmerAnimation` passes `null` to `useAnimationFrame` when stalled to unsubscribe from the animation clock. Without this, the 20fps interval keeps firing even when the shimmer is invisible — particularly problematic when the viewport ref isn't attached (conditional JSX), since the viewport-pause mechanism never kicks in.

- **Reduced motion**: When `prefersReducedMotion` is enabled, all animated spinners switch to a slowly pulsing dot on a 2-second cycle. Intensity changes are instant rather than smoothed. Stalled animation still works but without gradual transition.

- **Brief/Kairos mode**: A separate `BriefSpinner` provides a minimal single-line spinner for assistant mode, using `useAnimationFrame(120)` and simplified shimmer via `computeShimmerSegments` from `src/bridge/bridgeStatusUtil.ts`.

- **StatusLine in assistant mode**: Hidden entirely (`statusLineShouldDisplay` returns false) because the displayed fields (model, permission mode, cwd) reflect the REPL/daemon process rather than the running agent.

- **CoordinatorTaskPanel eviction**: Tasks are evicted on a 1-second tick interval. Setting `evictAfter = 0` triggers immediate visual removal without waiting for the next tick (the visibility filter checks `evictAfter !== 0`).

- **`useCoordinatorTaskCount` stub**: The current implementation always returns `0` despite reading tasks from AppState. The panel's own rendering uses `getVisibleAgentTasks()` directly and is unaffected, but external consumers of this hook will not get accurate counts.

- **Effort fallback**: `effortLevelToSymbol` defensively returns `EFFORT_HIGH` for unknown effort levels, since the level value can originate from remote config and may contain unexpected values.