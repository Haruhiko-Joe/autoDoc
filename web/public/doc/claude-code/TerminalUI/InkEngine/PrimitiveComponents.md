# Primitive Components

## Overview & Responsibilities

The Primitive Components module is the built-in React component library that powers Claude Code's terminal UI rendering. It sits within the **InkEngine** layer of the **TerminalUI** system, and every higher-level UI component (messages, dialogs, diffs, status lines) is composed from these primitives.

The module provides three categories of components:

- **Layout components**: `Box`, `Text`, `ScrollBox` — the flexbox-based building blocks for all terminal layouts
- **Interactive components**: `Button`, `Link` — clickable/focusable elements for user interaction
- **Infrastructure components**: `App`, `AlternateScreen`, `ErrorOverview` — root wrappers, screen modes, and error boundaries
- **Context providers**: `AppContext`, `StdinContext`, `TerminalSizeContext`, `TerminalFocusContext`, `ClockContext`, `CursorDeclarationContext` — shared state for the entire component tree
- **Utility components**: `Spacer`, `Newline`, `NoSelect`, `RawAnsi`, `Ansi` — special-purpose rendering helpers

All components are compiled with the React Compiler (note the `_c()` memoization runtime throughout), rendering to Ink's custom DOM elements (`ink-box`, `ink-text`, `ink-link`, `ink-raw-ansi`) which are laid out by Yoga (Facebook's flexbox engine) and painted as ANSI escape sequences to the terminal.

## Key Processes

### Render Pipeline

1. Application code composes `Box`, `Text`, `ScrollBox`, and other primitives into a React tree
2. The React reconciler maps these to Ink DOM elements (`ink-box`, `ink-text`, etc.)
3. Yoga computes flexbox layout for all elements (widths, heights, positions)
4. The Ink renderer walks the layout tree, generates ANSI output, and writes to stdout
5. For `ScrollBox`, only children intersecting the visible viewport are rendered (culling)

### App Bootstrap & Context Flow

When `App` mounts (`src/ink/components/App.tsx:154-179`), it establishes a nested context provider hierarchy that all descendants consume:

```
TerminalSizeContext.Provider  (columns, rows)
  → AppContext.Provider       (exit function)
    → StdinContext.Provider   (stdin stream, raw mode, event emitter, terminal querier)
      → TerminalFocusProvider (terminal window focus state)
        → ClockProvider       (shared animation clock)
          → CursorDeclarationContext.Provider (native cursor positioning)
            → children | ErrorOverview
```

On mount, `App` hides the cursor (unless in accessibility mode). When raw mode is first enabled, it activates bracketed paste mode, terminal focus reporting (DECSET 1004), and extended key reporting (Kitty keyboard protocol + xterm modifyOtherKeys).

### Input Event Flow

1. Raw stdin data arrives at `App`'s readable handler
2. `parseMultipleKeypresses()` parses the byte stream into structured `ParsedKey` / `ParsedMouse` events
3. Keyboard events are dispatched through the `EventEmitter` (legacy path) and through DOM `dispatchKeyboardEvent`
4. Mouse events are routed to click handlers (`onClickAt`), hover handlers (`onHoverAt`), selection handlers, or hyperlink detection
5. Multi-click detection (500ms window, 1-cell tolerance) supports double-click word selection and triple-click line selection
6. After >5s of stdin silence, the next input triggers re-assertion of terminal modes (catches tmux detach/attach, SSH reconnect, laptop wake)

### ScrollBox Scroll Flow

1. User input (wheel event, keyboard) calls `scrollBy(dy)` on the imperative handle
2. `scrollBy` accumulates delta in `pendingScrollDelta` on the DOM node — no React state involved
3. The DOM node is marked dirty and a microtask-deferred `scheduleRender` is queued (`src/ink/components/ScrollBox.tsx:103-117`)
4. Multiple `scrollBy` calls in one input batch coalesce into a single render
5. The Ink renderer reads `scrollTop` / `pendingScrollDelta` from the DOM node, clamps values, and culls children outside the visible window
6. `stickyScroll` mode auto-pins to bottom when content grows; broken by explicit `scrollTo`/`scrollBy`

## Core Layout Components

### Box — Flexbox Container

`Box` is the fundamental layout primitive, equivalent to `<div style="display: flex">` in the browser. Every visual container in the terminal UI is a `Box`.

**Props** (from `src/ink/components/Box.tsx:11-46`):

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `flexDirection` | `'row' \| 'column'` | `'row'` | Main axis direction |
| `flexGrow` | `number` | `0` | How much the box grows to fill available space |
| `flexShrink` | `number` | `1` | How much the box shrinks when space is tight |
| `flexWrap` | `'nowrap' \| 'wrap'` | `'nowrap'` | Whether children wrap to next line |
| `tabIndex` | `number` | — | Tab order index; `-1` for programmatic focus only |
| `autoFocus` | `boolean` | — | Focus on mount (like HTML `autofocus`) |
| `onClick` | `(event: ClickEvent) => void` | — | Left-click handler (alt-screen only) |
| `onFocus` / `onBlur` | `(event: FocusEvent) => void` | — | Focus/blur handlers with capture variants |
| `onKeyDown` | `(event: KeyboardEvent) => void` | — | Keyboard event handler with capture variant |
| `onMouseEnter` / `onMouseLeave` | `() => void` | — | Hover handlers (alt-screen only, no bubble) |

`Box` also accepts all `Styles` properties (margin, padding, width, height, border, overflow, gap, alignment, etc.) and validates that spacing values are integers at render time (`src/ink/components/Box.tsx:110-126`).

Overflow is resolved per-axis: `overflowX` and `overflowY` fall back to `overflow`, then to `"visible"` (`src/ink/components/Box.tsx:166-167`).

The component renders an `<ink-box>` DOM element that the Ink reconciler maps to a Yoga layout node.

### Text — Styled Text

`Text` is the text rendering primitive. It supports color, weight, decoration, and text wrapping.

**Props** (from `src/ink/components/Text.tsx:5-58`):

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `color` | `Color` | — | Foreground color (rgb, hex, ansi) |
| `backgroundColor` | `Color` | — | Background color |
| `bold` | `boolean` | — | Bold text (mutually exclusive with `dim`) |
| `dim` | `boolean` | — | Dim text (mutually exclusive with `bold`) |
| `italic` | `boolean` | `false` | Italic text |
| `underline` | `boolean` | `false` | Underlined text |
| `strikethrough` | `boolean` | `false` | Strikethrough text |
| `inverse` | `boolean` | `false` | Swap foreground and background |
| `wrap` | `TextWrap` | `'wrap'` | Text wrapping strategy |

**Key design decision**: `bold` and `dim` are enforced as mutually exclusive via a TypeScript discriminated union (`WeightProps` at line 49-58). Terminals treat these as conflicting SGR attributes, so the type system prevents nonsensical combinations.

**Wrap modes** include: `'wrap'`, `'wrap-trim'`, `'end'`, `'middle'`, `'truncate'`, `'truncate-end'`, `'truncate-middle'`, `'truncate-start'`. Each is backed by a pre-memoized style object (`memoizedStylesForWrap`, lines 60-109) to avoid allocations on re-render.

Returns `null` when `children` is `undefined` or `null` (`src/ink/components/Text.tsx:133-135`).

### ScrollBox — Scrollable Container

`ScrollBox` wraps `Box` with `overflow: scroll` and exposes a rich imperative scroll API.

**Architecture** (`src/ink/components/ScrollBox.tsx:72-81`): Children are laid out at their full Yoga-computed height inside a constrained container. At render time, only children intersecting the visible window are rendered (viewport culling). Content is translated by `-scrollTop` and clipped to the box bounds.

**Props** (`src/ink/components/ScrollBox.tsx:63-70`):

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `stickyScroll` | `boolean` | — | Auto-pin to bottom as content grows |
| `ref` | `Ref<ScrollBoxHandle>` | — | Imperative handle for scroll control |
| All `Styles` except `overflow`, `textWrap` | — | — | Passed through to the inner Box |

**ScrollBoxHandle API** (`src/ink/components/ScrollBox.tsx:10-62`):

| Method | Description |
|--------|-------------|
| `scrollTo(y)` | Jump to absolute scroll position; breaks stickiness |
| `scrollBy(dy)` | Relative scroll (accumulates in `pendingScrollDelta`); breaks stickiness |
| `scrollToElement(el, offset?)` | Deferred element-based scroll — reads position at render time for accuracy |
| `scrollToBottom()` | Pin to bottom and re-enable sticky scroll |
| `getScrollTop()` / `getScrollHeight()` / `getViewportHeight()` | Read current scroll geometry |
| `getFreshScrollHeight()` | Reads Yoga directly (bypasses cache) for use in `useLayoutEffect` |
| `isSticky()` | Whether scroll is pinned to the bottom |
| `subscribe(listener)` | Subscribe to imperative scroll changes |
| `setClampBounds(min, max)` | Constrain render-time scrollTop for virtual scroll integration |

**Internal structure** (`src/ink/components/ScrollBox.tsx:206-228`): The outer `ink-box` has `overflow: scroll` and a constrained height. The inner content box uses `flexGrow: 1, flexShrink: 0` — it fills at least the viewport but grows beyond it for tall content. `stickyScroll` is passed as a DOM attribute (not React state) so it's available on the first render before ref callbacks fire.

## Interactive Components

### Button — Clickable Element

`Button` is a focusable, clickable element that responds to Enter, Space, and mouse clicks.

**Props** (`src/ink/components/Button.tsx:15-38`):

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `onAction` | `() => void` | (required) | Called on activation (Enter, Space, click) |
| `tabIndex` | `number` | `0` | Tab order; `-1` for programmatic focus only |
| `autoFocus` | `boolean` | — | Focus on mount |
| `children` | `((state: ButtonState) => ReactNode) \| ReactNode` | — | Render prop or static content |

`ButtonState` exposes `{ focused, hovered, active }` booleans for state-dependent styling. The component is intentionally unstyled — styling is delegated to the render prop.

Activation triggers a brief `isActive` flash (set to `true`, then reset via `setTimeout`) for visual feedback (`src/ink/components/Button.tsx:94-100`).

### Link — OSC 8 Hyperlinks

`Link` renders terminal hyperlinks using the OSC 8 protocol when supported, with graceful fallback.

**Props** (`src/ink/components/Link.tsx:6-10`):

| Prop | Type | Description |
|------|------|-------------|
| `url` | `string` | (required) The URL to link to |
| `children` | `ReactNode` | Display text; defaults to the URL |
| `fallback` | `ReactNode` | Content shown when hyperlinks aren't supported |

When `supportsHyperlinks()` returns true, renders `<ink-link href={url}>` wrapped in `<Text>`. Otherwise falls back to displaying the `fallback` or `children` as plain text.

## Infrastructure Components

### App — Root Component

`App` is a class component (`PureComponent`) that serves as the root of every Ink application tree (`src/ink/components/App.tsx:101`).

**Responsibilities**:

1. **Context provider nesting**: Wraps children in the full provider hierarchy (see Key Processes above)
2. **Error boundary**: Catches errors via `getDerivedStateFromError` and `componentDidCatch`, rendering `<ErrorOverview>` when an error occurs
3. **Input handling**: Manages raw mode on stdin, parses keypresses via `parseMultipleKeypresses`, and dispatches events through the `EventEmitter`
4. **Terminal mode management**: On mount, hides the cursor; enables bracketed paste mode, focus reporting, and extended key reporting when raw mode is activated. Manages Kitty keyboard protocol and xterm `modifyOtherKeys`
5. **Mouse event processing**: Tracks multi-click state (double/triple-click with 500ms timeout and 1-cell tolerance), handles text selection start/finish, dispatches hover events, and manages deferred hyperlink opens
6. **Stdin resume detection**: Detects gaps >5 seconds (`STDIN_RESUME_GAP_MS`) in stdin activity to re-assert terminal modes after tmux detach/attach, SSH reconnect, or laptop wake (`src/ink/components/App.tsx:35`)

### AlternateScreen — Fullscreen Mode

`AlternateScreen` switches the terminal to its alternate screen buffer for fullscreen UI (`src/ink/components/AlternateScreen.tsx:13-32`).

While mounted:
- Enters the alt screen (DEC 1049), clears it, homes the cursor
- Constrains height to the terminal row count via `TerminalSizeContext`
- Optionally enables SGR mouse tracking (wheel + click/drag) — default `true`

Uses `useInsertionEffect` (not `useLayoutEffect`) to ensure the alt screen escape sequence reaches the terminal *before* the first frame render — this prevents a visual flash of the main screen content.

On unmount, disables mouse tracking, exits the alt screen, and clears any text selection. Notifies the Ink instance via `setAltScreenActive()` so signal-exit cleanup can exit the alt screen if the component's own unmount doesn't run.

### ErrorOverview — Error Boundary Display

Renders a styled error view with stack trace and source code context (`src/ink/components/ErrorOverview.tsx`).

Parses the error stack with `StackUtils`, extracts the originating file path (stripping the `file://` prefix and cwd), reads the source file synchronously via `readFileSync`, and displays a code excerpt around the error line using `codeExcerpt`. Styled with a red `ERROR` badge and dimmed stack trace lines.

## Context Providers

### AppContext

Exposes `exit(error?)` to manually unmount the Ink app (`src/ink/components/AppContext.ts:7`).

### StdinContext

Provides access to the stdin stream and raw mode control (`src/ink/components/StdinContext.ts:5-29`):
- `stdin`: The `NodeJS.ReadStream`
- `setRawMode(value)`: Toggle raw mode (use this instead of `process.stdin.setRawMode`)
- `isRawModeSupported`: Whether raw mode is available
- `internal_exitOnCtrlC`: Whether Ctrl+C should exit the app
- `internal_eventEmitter`: The shared event bus for input events
- `internal_querier`: Terminal query/response interface (DECRQM, OSC 11, etc.)

### TerminalSizeContext

Provides `{ columns, rows }` of the terminal viewport (`src/ink/components/TerminalSizeContext.tsx:2-6`). Default value is `null`; the `App` component provides the actual values from its props.

### TerminalFocusContext

Tracks whether the terminal window has focus, using `useSyncExternalStore` for tear-free reads (`src/ink/components/TerminalFocusContext.tsx:5-8`):
- `isTerminalFocused`: Boolean focus state
- `terminalFocusState`: `'unknown' | 'focused' | 'blurred'`

Implemented as a separate `TerminalFocusProvider` component to avoid re-rendering `App` on focus changes — only consumers of the context re-render.

### ClockContext

A shared animation clock that ticks at `FRAME_INTERVAL_MS` when focused, halving the rate when blurred (`src/ink/components/ClockContext.tsx:5-68`):
- `subscribe(onChange, keepAlive)`: Register for tick notifications; `keepAlive` controls whether the interval stays running
- `now()`: Returns synchronized tick time (all subscribers in the same tick see the same value)
- `setTickInterval(ms)`: Adjust tick rate

The clock auto-stops when no `keepAlive` subscribers remain, avoiding unnecessary CPU usage. Created once via `useState` initializer so the provider value is stable and never causes consumer re-renders on its own.

### CursorDeclarationContext

Allows components to declare where the native terminal cursor should be positioned (for IME composition and screen readers) (`src/ink/components/CursorDeclarationContext.ts:4-26`). The setter accepts a `CursorDeclaration` with `{ relativeX, relativeY, node }`, and supports conditional clearing via `clearIfNode` to handle focus transfers between sibling components safely.

## Utility Components

### Spacer

Expands to fill available space along the major axis. Renders `<Box flexGrow={1} />` — useful for pushing elements to opposite ends of a container (`src/ink/components/Spacer.tsx:9`).

### Newline

Inserts one or more `\n` characters. Must be used within a `<Text>` context. Accepts an optional `count` prop (default `1`) (`src/ink/components/Newline.tsx:15`).

### NoSelect

Marks its children as non-selectable in fullscreen text selection (`src/ink/components/NoSelect.tsx:17-34`). Cells inside are skipped by both the selection highlight and the copied text. Use for gutters (line numbers, diff sigils, list bullets). The `fromLeftEdge` prop extends the exclusion zone from column 0 to the box's right edge for nested gutter scenarios. Only affects alt-screen text selection — no-op in the main-screen scrollback render.

### RawAnsi

A performance escape hatch that bypasses the normal `<Ansi>` → React tree → Yoga → squash → re-serialize roundtrip (`src/ink/components/RawAnsi.tsx:13-27`). Accepts pre-rendered ANSI `lines` (string array) and a column `width`, emitting a single Yoga leaf with a constant-time measure function (`width × lines.length`). Hands the joined string straight to `output.write()`. Used when external renderers (e.g., the ColorDiff NAPI module) have already produced terminal-ready output.

### Ansi

Parses ANSI escape codes in a string and renders them as a tree of `<Text>` and `<Link>` components (`src/ink/Ansi.tsx:24-31`). Supports hyperlinks (OSC 8), all SGR text styles, and an optional `dimColor` override. Memoized via `React.memo` to prevent re-renders when the input string hasn't changed. Optimized with fast paths: single unstyled spans skip the full tree construction.

## Edge Cases & Caveats

- **Mouse events require AlternateScreen**: `onClick`, `onMouseEnter`, `onMouseLeave` on `Box` are no-ops outside `<AlternateScreen>` where mouse tracking is enabled
- **Bold and dim are mutually exclusive**: The TypeScript types enforce this, matching terminal SGR behavior
- **ScrollBox bypasses React state**: Scroll mutations go directly to the DOM node and trigger Ink renders via microtask — this means React state and scroll position can be out of sync until the next render
- **`stickyScroll` is a DOM attribute**: It's set directly on the `ink-box` element (not via React state) so it's available on the first render frame before ref callbacks fire
- **`useInsertionEffect` timing in AlternateScreen**: The component uses insertion effects (not layout effects) to ensure escape sequences reach the terminal before the reconciler's `resetAfterCommit` fires the first frame render
- **Stdin resume gap**: App detects >5s stdin silence and re-asserts terminal modes, handling tmux detach/attach and SSH reconnect without user intervention
- **Accessibility mode**: When `CLAUDE_CODE_ACCESSIBILITY` env var is truthy, the native cursor stays visible for screen magnifiers (skips `HIDE_CURSOR` on mount)
- **Process suspension**: Unix-only (`process.platform !== 'win32'`) — the `SUPPORTS_SUSPEND` constant gates SIGSTOP/SIGCONT handling (`src/ink/components/App.tsx:28`)