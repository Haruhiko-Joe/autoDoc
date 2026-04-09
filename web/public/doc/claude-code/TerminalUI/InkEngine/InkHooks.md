# Ink Hooks

## Overview & Responsibilities

The Ink Hooks module (`src/ink/hooks/`) provides the core React hooks that form the programmatic API of the customized Ink framework powering the terminal UI. These hooks sit within the **InkEngine** layer of the **TerminalUI** subsystem. Higher-level components and application hooks in the **Components** and **Hooks** siblings consume these primitives for input handling, animation timing, terminal state tracking, text selection, and terminal-specific integrations (titles, tab status, notifications).

The hooks fall into several categories:

| Category | Hooks |
|----------|-------|
| Input & stdin | `useInput`, `useStdin` |
| App lifecycle | `useApp` |
| Animation & timing | `useAnimationFrame`, `useAnimationTimer`, `useInterval` |
| Text selection | `useSelection`, `useHasSelection` |
| Terminal state | `useTerminalFocus`, `useTerminalViewport` |
| Terminal integrations | `useTerminalTitle`, `useTabStatus`, `useTerminalNotification` |
| Cursor management | `useDeclaredCursor` |
| Search | `useSearchHighlight` |

---

## Key Processes

### Input Handling Flow (`useInput`)

1. On mount, `useInput` calls `setRawMode(true)` via a `useLayoutEffect` to enable raw terminal mode synchronously during React's commit phase — preventing keystroke echo before the effect fires (`src/ink/hooks/use-input.ts:50-60`).
2. A stable event listener is registered on the internal `EventEmitter` using `useEventCallback` from `usehooks-ts`. This ensures listener ordering is preserved across active/inactive transitions without re-appending (`src/ink/hooks/use-input.ts:69-81`).
3. When an `InputEvent` fires, the handler checks `isActive`, filters out Ctrl+C if the app is configured to exit on it, and delegates to the user's callback with `(input, key, event)`.
4. On unmount or when `isActive` becomes `false`, raw mode is restored to `false`.

### Animation Clock Subscription Flow

All timing hooks share a single `ClockContext` to consolidate wake-ups:

1. **`useAnimationFrame`** subscribes with `keepAlive: true` — visible animations actively drive the clock. It also integrates `useTerminalViewport` to auto-pause when the element scrolls offscreen (`src/ink/hooks/use-animation-frame.ts:37-53`).
2. **`useAnimationTimer`** subscribes with `keepAlive: false` — it piggybacks on an active clock but won't start one. Used for pure time-based computations like shimmer effects (`src/ink/hooks/use-interval.ts:13-34`).
3. **`useInterval`** also subscribes non-keepAlive, invoking a callback ref at the specified interval. Pass `null` to pause (`src/ink/hooks/use-interval.ts:43-67`).

### Viewport Visibility Detection (`useTerminalViewport`)

1. Returns a callback ref to attach to a `Box` element.
2. On every render (no dependency array), a `useLayoutEffect` walks the DOM parent chain from the element to the root, accumulating yoga layout positions and subtracting `scrollTop` from scroll containers (`src/ink/hooks/use-terminal-viewport.ts:61-72`).
3. Computes whether the element intersects the visible viewport rows, accounting for cursor-restore scroll in overflow scenarios (`src/ink/hooks/use-terminal-viewport.ts:79-88`).
4. Updates a ref (not state) to avoid cascading re-renders during the commit phase.

### Terminal Notification Dispatch (`useTerminalNotification`)

1. Reads a `writeRaw` function from `TerminalWriteContext` — a raw stdout writer that bypasses Ink's rendering pipeline (`src/ink/useTerminalNotification.ts:26-31`).
2. Returns terminal-specific notification methods: `notifyITerm2` (OSC 1337), `notifyKitty` (OSC 99), `notifyGhostty` (OSC 9999), and `notifyBell` (raw BEL character) (`src/ink/useTerminalNotification.ts:33-69`).
3. Also provides a `progress` method for OSC 9;4 progress reporting (supported by ConEmu, Ghostty, iTerm2) with states: `running`, `indeterminate`, `error`, `completed` (`src/ink/useTerminalNotification.ts:71-120`).

---

## Function Signatures & Parameters

### `useInput(inputHandler, options?)`

```ts
(inputHandler: (input: string, key: Key, event: InputEvent) => void, options?: { isActive?: boolean }) => void
```

Registers a keyboard input handler. `isActive` defaults to `true`; set to `false` to temporarily disable without losing listener ordering.

> Source: `src/ink/hooks/use-input.ts:42-90`

### `useStdin()`

```ts
() => { stdin: NodeJS.ReadStream; setRawMode: (value: boolean) => void; isRawModeSupported: boolean; internal_exitOnCtrlC: boolean; internal_eventEmitter: EventEmitter }
```

Thin wrapper around `useContext(StdinContext)`. Provides raw stdin stream access, raw mode toggling, and the internal event emitter.

> Source: `src/ink/hooks/use-stdin.ts:7`

### `useApp()`

```ts
() => { exit: (error?: Error) => void }
```

Exposes the Ink app instance. Call `exit()` to unmount the entire Ink application.

> Source: `src/ink/hooks/use-app.ts:7`

### `useAnimationFrame(intervalMs?)`

```ts
(intervalMs: number | null = 16) => [ref: (element: DOMElement | null) => void, time: number]
```

Returns a ref callback and the current clock time. Attach the ref to auto-pause when the element scrolls offscreen. Pass `null` to manually pause. Subscribes as `keepAlive` — drives the shared clock.

> Source: `src/ink/hooks/use-animation-frame.ts:30-57`

### `useAnimationTimer(intervalMs)`

```ts
(intervalMs: number) => number
```

Returns the clock time, updating at the given interval. Non-keepAlive — only ticks when another subscriber (like a spinner) drives the clock.

> Source: `src/ink/hooks/use-interval.ts:13-34`

### `useInterval(callback, intervalMs)`

```ts
(callback: () => void, intervalMs: number | null) => void
```

Clock-backed interval. Pass `null` to pause. Non-keepAlive subscriber.

> Source: `src/ink/hooks/use-interval.ts:43-67`

### `useSelection()`

```ts
() => { copySelection, copySelectionNoClear, clearSelection, hasSelection, getState, subscribe, shiftAnchor, shiftSelection, moveFocus, captureScrolledRows, setSelectionBgColor }
```

Provides full text selection API for fullscreen mode. Returns no-op functions when not in fullscreen. Key methods:

- `copySelection()` / `copySelectionNoClear()`: Copy selected text (the latter preserves the highlight)
- `shiftSelection(dRow, minRow, maxRow)`: Shift selection during keyboard scroll
- `moveFocus(move)`: Keyboard-driven selection extension (shift+arrow)
- `captureScrolledRows(firstRow, lastRow, side)`: Preserve text from rows scrolling out of viewport
- `setSelectionBgColor(color)`: Theme the selection highlight background

> Source: `src/ink/hooks/use-selection.ts:14-87`

### `useHasSelection()`

```ts
() => boolean
```

Reactive boolean that re-renders when a text selection is created or cleared. Uses `useSyncExternalStore` for tear-free reads.

> Source: `src/ink/hooks/use-selection.ts:97-104`

### `useTerminalFocus()`

```ts
() => boolean
```

Returns `true` when the terminal window has focus (or focus state is unknown). Powered by DECSET 1004 focus reporting.

> Source: `src/ink/hooks/use-terminal-focus.ts:13-16`

### `useTerminalViewport()`

```ts
() => [ref: (element: DOMElement | null) => void, entry: { isVisible: boolean }]
```

Attach the ref to track whether an element is within the visible terminal viewport. Updates via `useLayoutEffect` on every render without triggering re-renders (ref-based).

> Source: `src/ink/hooks/use-terminal-viewport.ts:29-96`

### `useTerminalTitle(title)`

```ts
(title: string | null) => void
```

Sets the terminal tab/window title via OSC 0. ANSI sequences are stripped automatically. On Windows, sets `process.title` instead. Pass `null` to opt out.

> Source: `src/ink/hooks/use-terminal-title.ts:17-31`

### `useTabStatus(kind)`

```ts
(kind: 'idle' | 'busy' | 'waiting' | null) => void
```

Sets the terminal tab-status indicator via OSC 21337 with a colored dot and status text. Presets:

| Kind | Indicator Color | Status Text |
|------|----------------|-------------|
| `idle` | Green `(0,215,95)` | "Idle" |
| `busy` | Orange `(255,149,0)` | "Working…" |
| `waiting` | Blue `(95,135,255)` | "Waiting" |

Pass `null` to clear. Wrapped for tmux/screen passthrough. Terminals without OSC 21337 support silently discard the sequence.

> Source: `src/ink/hooks/use-tab-status.ts:53-72`

### `useDeclaredCursor({ line, column, active })`

```ts
({ line: number; column: number; active: boolean }) => (element: DOMElement | null) => void
```

Declares where the terminal cursor should park after each frame. Essential for CJK IME input (preedit renders at cursor position) and screen-reader accessibility. Returns a ref callback to attach to the containing Box.

Handles sibling handoff carefully: only clears the declaration if the currently-declared node matches the caller's node, preventing clobber during focus transitions.

> Source: `src/ink/hooks/use-declared-cursor.ts:25-73`

### `useSearchHighlight()`

```ts
() => { setQuery: (query: string) => void; scanElement: (el: DOMElement) => MatchPosition[]; setPositions: (state: { positions, rowOffset, currentIdx } | null) => void }
```

Screen-space search highlighting. `setQuery` highlights all visible occurrences via SGR 7 inverse. `scanElement` renders a DOM subtree to a virtual screen and returns element-relative match positions. `setPositions` overlays a yellow "current match" indicator at a specific position.

> Source: `src/ink/hooks/use-search-highlight.ts:18-53`

### `useTerminalNotification()`

```ts
() => { notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress }
```

Terminal-specific notification dispatch. Must be used within `TerminalWriteProvider`. Provides methods for iTerm2, Kitty, Ghostty native notifications, a BEL fallback, and OSC 9;4 progress reporting.

> Source: `src/ink/useTerminalNotification.ts:25-126`

---

## Type Definitions

### `TabStatusKind`

```ts
type TabStatusKind = 'idle' | 'busy' | 'waiting'
```

The three preset tab-status states, each mapped to a color and label in `TAB_STATUS_PRESETS` (`src/ink/hooks/use-tab-status.ts:11`).

### `TerminalNotification`

```ts
type TerminalNotification = {
  notifyITerm2: (opts: { message: string; title?: string }) => void
  notifyKitty: (opts: { message: string; title: string; id: number }) => void
  notifyGhostty: (opts: { message: string; title: string }) => void
  notifyBell: () => void
  progress: (state: Progress['state'] | null, percentage?: number) => void
}
```

Return type of `useTerminalNotification`, bundling all terminal-specific notification methods (`src/ink/useTerminalNotification.ts:12-23`).

### `ViewportEntry`

```ts
type ViewportEntry = { isVisible: boolean }
```

Returned by `useTerminalViewport` to indicate whether the tracked element is within the visible terminal rows (`src/ink/hooks/use-terminal-viewport.ts:5-9`).

---

## Configuration & Defaults

| Hook | Default | Notes |
|------|---------|-------|
| `useInput` | `isActive: true` | Active by default; raw mode enabled on mount |
| `useAnimationFrame` | `intervalMs: 16` (~60fps) | Pass `null` to pause |
| `useTerminalTitle` | N/A | Pass `null` to opt out; Windows uses `process.title` |
| `useTabStatus` | N/A | Pass `null` to clear; requires OSC 21337 support |

---

## Edge Cases & Caveats

- **`useInput` listener ordering**: The listener is registered once on mount and uses `useEventCallback` to keep a stable slot in the `EventEmitter` array. This is critical for `stopImmediatePropagation()` ordering — re-registering on `isActive` toggle would break priority (`src/ink/hooks/use-input.ts:62-68`).

- **`useInput` uses `useLayoutEffect` for raw mode**: The switch to `useLayoutEffect` (instead of `useEffect`) ensures raw mode is active synchronously during commit, preventing visible keystroke echo and cursor flash on the first frame (`src/ink/hooks/use-input.ts:45-49`).

- **`useAnimationFrame` auto-pauses offscreen**: Combined with `useTerminalViewport`, animations automatically stop ticking when they scroll out of the visible viewport, avoiding unnecessary re-renders and CPU usage.

- **`useTerminalViewport` does not trigger re-renders**: Visibility is stored in a ref, not state. Callers that need reactivity must re-render for other reasons (e.g., animation ticks) and will pick up the latest value naturally. This design prevents infinite update loops with other layout effects.

- **`useDeclaredCursor` sibling handoff**: When focus moves between sibling elements in the opposite order of React's commit sequence, the node-identity check prevents the newly-inactive instance from clobbering the newly-active one's cursor declaration (`src/ink/hooks/use-declared-cursor.ts:42-53`).

- **`useTabStatus` cleanup on null**: Transitioning from a non-null kind to `null` emits `CLEAR_TAB_STATUS` to avoid leaving a stale dot in the terminal tab. Process-exit cleanup is handled separately by Ink's unmount path (`src/ink/hooks/use-tab-status.ts:58-66`).

- **`useTerminalTitle` on Windows**: Classic conhost doesn't support OSC sequences, so the hook falls back to setting `process.title` directly (`src/ink/hooks/use-terminal-title.ts:25-26`).

- **`useTerminalNotification` bell passthrough**: The BEL character is written raw (not wrapped for tmux) so it triggers tmux's native bell-action window flag (`src/ink/useTerminalNotification.ts:66-68`).

- **Shared clock consolidation**: All timing hooks (`useAnimationFrame`, `useAnimationTimer`, `useInterval`) use a single `ClockContext` rather than individual `setInterval` calls, consolidating wake-ups and reducing timer overhead.