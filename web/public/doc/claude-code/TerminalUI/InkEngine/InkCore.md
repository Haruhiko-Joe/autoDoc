# InkCore

## Overview & Responsibilities

InkCore is the central orchestrator of the terminal UI rendering engine within the **TerminalUI → InkEngine** layer. It bridges React's virtual DOM reconciliation with physical terminal output — owning the render loop, managing the React fiber root through a custom reconciler, coordinating frame scheduling, handling stdin/stdout streams, dispatching keyboard and mouse events, managing text selection state, and driving the full render cycle: **reconcile → layout (Yoga) → render-to-output → diff → optimize → write**.

Within the broader architecture, InkCore sits at the foundation of the TerminalUI module. Every component, hook, and screen in the application renders through this engine. The Bootstrap module launches the Ink-based REPL after initialization, and the QueryEngine streams responses through it for display. Sibling modules (Components, Hooks, Screens, AppState, Keybindings, VimMode) all depend on InkCore's primitives.

The module spans six files:

| File | Role |
|------|------|
| `src/ink/ink.tsx` | The `Ink` class — the heart of the engine |
| `src/ink/reconciler.ts` | Custom React reconciler configuration |
| `src/ink/root.ts` | Public `render()` and `createRoot()` entry points |
| `src/ink/instances.ts` | Singleton map ensuring one Ink instance per stdout |
| `src/ink/constants.ts` | Shared frame interval constant |
| `src/ink.ts` | Public barrel re-export with ThemeProvider wrapping |

## Key Processes

### 1. Application Startup: `render()` / `createRoot()`

The entry point for mounting a React tree into the terminal. Two APIs are exposed:

- **`render(node, options)`** — One-shot mount. Creates an `Ink` instance (or reuses one keyed by `stdout`), calls `instance.render(node)`, and returns an `Instance` handle with `rerender`, `unmount`, `waitUntilExit`, and `cleanup` methods. An `await Promise.resolve()` preserves a microtask boundary so async startup work settles before the first render (`src/ink/root.ts:107-123`).

- **`createRoot(options)`** — Deferred mount, analogous to `react-dom`'s `createRoot`. Creates the `Ink` instance and registers it in the instances map, but defers rendering until `root.render(node)` is called (`src/ink/root.ts:129-157`).

Both APIs are re-exported through `src/ink.ts`, which wraps every render call with a `<ThemeProvider>` so themed components work without explicit provider mounting at each call site (`src/ink.ts:14-31`).

### 2. Instance Singleton Management

The `instances` map (`src/ink/instances.ts`) ensures that consecutive `render()` calls targeting the same `stdout` stream reuse the same `Ink` instance rather than creating a new one. The `getInstance()` helper in `root.ts` performs this lookup-or-create (`src/ink/root.ts:172-184`). On unmount, `Ink` removes itself from the map (`src/ink/ink.tsx:1521`).

### 3. The Render Cycle (`Ink.onRender`)

This is the most critical path in the module. When React commits an update, the reconciler's `resetAfterCommit` fires `onComputeLayout()` (Yoga layout) followed by `onRender` (or `scheduleRender`). The full pipeline in `onRender()` (`src/ink/ink.tsx:420-789`):

1. **Flush deferred state** — `flushInteractionTime()` batches Date.now() calls per frame
2. **Render DOM to screen** — `this.renderer()` walks the Ink DOM tree, converts it to a `Frame` (a screen buffer with cursor position and viewport dimensions)
3. **Follow-scroll translation** — If a ScrollBox auto-scrolled, the selection highlight is shifted to track the content
4. **Selection overlay** — In alt-screen mode, selected cells are style-inverted directly in the screen buffer
5. **Search highlight overlay** — Matching cells are inverted (and the "current" match highlighted in yellow)
6. **Full-damage detection** — If layout shifted, selection is active, or the previous frame was contaminated, damage is expanded to full-screen
7. **Diff computation** — `this.log.render(prevFrame, frame)` diffs the front and back frame buffers, producing a list of patches
8. **Buffer swap** — `this.backFrame = this.frontFrame; this.frontFrame = frame`
9. **Optimization** — `optimize(diff)` merges adjacent patches
10. **Cursor positioning** — Alt-screen prepends CSI H (cursor home) and appends a park-at-bottom patch; native cursor declaration positions the cursor for IME input
11. **Terminal write** — `writeDiffToTerminal()` sends the optimized patches to stdout
12. **Frame metrics callback** — `onFrame` is called with timing data (yoga, commit, renderer, diff, optimize, write phases)

### 4. The Custom React Reconciler

The reconciler (`src/ink/reconciler.ts`) bridges React's fiber tree to Ink's DOM model. Key behaviors:

- **`createInstance`** — Creates an Ink DOM node (`ink-box`, `ink-text`, `ink-virtual-text`, `ink-link`), applies props (style, text styles, event handlers, attributes). Enforces that `<Box>` cannot nest inside `<Text>` (`src/ink/reconciler.ts:331-359`)
- **`createTextInstance`** — Creates a text node; enforces that raw text strings must be inside `<Text>` (`src/ink/reconciler.ts:360-372`)
- **`commitUpdate`** (React 19) — Receives old and new props directly, diffs them, and applies changes to style, text styles, event handlers, and attributes (`src/ink/reconciler.ts:426-459`)
- **`resetAfterCommit`** — Triggers layout computation (`onComputeLayout`) and rendering (`onRender`) after React's commit phase. In test environments, uses synchronous `onImmediateRender` instead of the throttled path (`src/ink/reconciler.ts:247-314`)
- **`removeChildFromContainer` / `removeChild`** — Removes DOM nodes, frees Yoga nodes recursively, and notifies the focus manager (`src/ink/reconciler.ts:420-470`)

The reconciler uses `ConcurrentRoot` mode and integrates with an event `Dispatcher` for update priority resolution and discrete event batching (`src/ink/reconciler.ts:487-512`).

### 5. Frame Scheduling

Rendering is throttled to ~60fps via lodash `throttle` with `FRAME_INTERVAL_MS` (16ms, defined in `src/ink/constants.ts`). The throttled function defers the actual render to a microtask (`queueMicrotask`) so layout effects have committed before rendering (`src/ink/ink.tsx:212-216`).

For scroll drain (smooth scrolling), a faster interval (`FRAME_INTERVAL_MS >> 2`, ~4ms) is used via `setTimeout` to maximize scroll speed without re-entering the throttle (`src/ink/ink.tsx:757-759`).

### 6. Resize and Resume Handling

- **`handleResize`** — Synchronous (not debounced) to prevent dimension mismatch between `stdout.columns` and internal state. Updates dimensions, resets frame buffers for alt-screen, and re-renders the React tree with updated terminal size props (`src/ink/ink.tsx:309-346`).
- **`handleResume` (SIGCONT)** — Restores terminal state after a suspend (Ctrl+Z). In alt-screen mode, re-enters the alt screen and re-enables mouse tracking. In main-screen mode, resets frame buffers to prevent clobbering terminal content (`src/ink/ink.tsx:280-301`).
- **`reassertTerminalModes`** — Self-healing for sleep/wake, tmux detach/attach, SSH reconnect. Re-enables Kitty keyboard protocol (pop-before-push to keep stack depth balanced) and mouse tracking (`src/ink/ink.tsx:896-919`).

### 7. Alt-Screen and External Editor Handoff

- **`enterAlternateScreen()`** — Pauses Ink, suspends stdin, disables extended key reporting and mouse tracking, enters alt-screen (if not already in one), clears the screen, and shows the cursor for external TUI use (`src/ink/ink.tsx:357-378`).
- **`exitAlternateScreen()`** — Re-enters alt-screen (vim's rmcup may have dropped to main), clears, re-enables mouse tracking, restores stdin, resumes Ink, and re-enables extended key reporting (`src/ink/ink.tsx:392-419`).

### 8. Selection and Search Highlight

The `Ink` class owns the `SelectionState` and provides a full API for text selection in alt-screen mode:

- `handleMultiClick(col, row, count)` — Word (double-click) or line (triple-click) selection
- `handleSelectionDrag(col, row)` — Drag-to-extend with word/line snapping
- `copySelection()` / `copySelectionNoClear()` — OSC 52 clipboard integration
- `moveSelectionFocus(move)` — Keyboard selection extension (shift+arrow)
- `shiftSelectionForScroll(dRow, min, max)` — Keeps selection anchored during keyboard scrolling
- `subscribeToSelectionChange(cb)` — React-land subscription for `useHasSelection`

Search highlighting is applied per-frame as an overlay:
- `setSearchHighlight(query)` — Inverts all matching cells
- `scanElementSubtree(el)` — Paints a DOM subtree to a scratch buffer and scans for match positions
- `setSearchPositions(state)` — Overlays a yellow "current match" indicator at the given position

### 9. Event Dispatch

- **Keyboard** — `dispatchKeyboardEvent(parsedKey)` creates a `KeyboardEvent` and dispatches it through the event `Dispatcher` to the focused element. Tab/Shift+Tab cycling is the default action if no handler calls `preventDefault()` (`src/ink/ink.tsx:1269-1283`).
- **Click** — `dispatchClick(col, row)` hit-tests the rendered DOM tree and bubbles a `ClickEvent` from the deepest hit node (`src/ink/ink.tsx:1260-1264`).
- **Hover** — `dispatchHover(col, row)` tracks hovered nodes and dispatches enter/leave events (`src/ink/ink.tsx:1265-1268`).

### 10. Unmount and Cleanup

`unmount()` (`src/ink/ink.tsx:1455-1533`) performs a thorough cleanup sequence:

1. Renders a final frame
2. Unsubscribes exit handlers and restores patched console/stderr
3. Removes TTY event listeners
4. Resets terminal modes synchronously via `writeSync` (alt-screen exit, mouse tracking, keyboard protocol, focus events, bracketed paste, cursor visibility, iTerm2 progress, tab status)
5. Cancels pending throttled renders and drain timers
6. Unmounts the React container and frees the root Yoga node
7. Removes itself from the instances map
8. Resolves or rejects the exit promise

## Function Signatures & Parameters

### `render(node, options?)` (default export from `src/ink/root.ts`)

```typescript
async (node: ReactNode, options?: NodeJS.WriteStream | RenderOptions): Promise<Instance>
```

Mount a React component tree and render to the terminal. Returns an `Instance` with `rerender`, `unmount`, `waitUntilExit`, and `cleanup` methods.

### `createRoot(options?)` (from `src/ink/root.ts`)

```typescript
async function createRoot(options?: RenderOptions): Promise<Root>
```

Create a root without rendering. Returns `{ render, unmount, waitUntilExit }`.

### `Ink.render(node)` (from `src/ink/ink.tsx:1442`)

```typescript
render(node: ReactNode): void
```

Wraps the node in `<App>` (with stdin/stdout/selection/event props) and `<TerminalWriteProvider>`, then synchronously updates the React container.

### `Ink.onRender()` (from `src/ink/ink.tsx:420`)

The core render pipeline. Produces a frame, diffs against the previous frame, and writes patches to the terminal.

### `Ink.unmount(error?)` (from `src/ink/ink.tsx:1455`)

```typescript
unmount(error?: Error | number | null): void
```

Tears down the entire Ink application, resets terminal state, and resolves/rejects the exit promise.

## Interface/Type Definitions

### `RenderOptions` (`src/ink/root.ts:8-44`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `stdout` | `NodeJS.WriteStream` | `process.stdout` | Output stream for rendering |
| `stdin` | `NodeJS.ReadStream` | `process.stdin` | Input stream for keyboard events |
| `stderr` | `NodeJS.WriteStream` | `process.stderr` | Error stream |
| `exitOnCtrlC` | `boolean` | `true` | Whether Ctrl+C exits the app |
| `patchConsole` | `boolean` | `true` | Redirect console methods to prevent output mixing |
| `onFrame` | `(event: FrameEvent) => void` | - | Called after each frame with timing/flicker data |

### `Instance` (`src/ink/root.ts:46-60`)

| Field | Type | Description |
|-------|------|-------------|
| `rerender` | `Ink['render']` | Replace or update the root node |
| `unmount` | `Ink['unmount']` | Manually unmount the app |
| `waitUntilExit` | `Ink['waitUntilExit']` | Promise that resolves on unmount |
| `cleanup` | `() => void` | Remove from instances map |

### `Root` (`src/ink/root.ts:67-71`)

| Field | Type | Description |
|-------|------|-------------|
| `render` | `(node: ReactNode) => void` | Mount or update the tree |
| `unmount` | `() => void` | Unmount |
| `waitUntilExit` | `() => Promise<void>` | Resolves on unmount |

### `Options` (Ink constructor, `src/ink/ink.tsx:67-75`)

| Field | Type | Description |
|-------|------|-------------|
| `stdout` | `NodeJS.WriteStream` | Output stream |
| `stdin` | `NodeJS.ReadStream` | Input stream |
| `stderr` | `NodeJS.WriteStream` | Error stream |
| `exitOnCtrlC` | `boolean` | Handle Ctrl+C |
| `patchConsole` | `boolean` | Redirect console methods |
| `waitUntilExit` | `() => Promise<void>` | Optional external exit promise |
| `onFrame` | `(event: FrameEvent) => void` | Per-frame callback |

## Configuration & Defaults

- **`FRAME_INTERVAL_MS`** = 16ms (~60fps) — shared throttle interval for render scheduling and animations (`src/ink/constants.ts:2`)
- **`CLAUDE_CODE_DEBUG_REPAINTS`** — Environment variable; when truthy, enables debug owner chain logging for full repaints (`src/ink/reconciler.ts:180-185`)
- **`CLAUDE_CODE_COMMIT_LOG`** — Environment variable; path to a file for commit instrumentation logs (reconcile timing, slow yoga, slow paint) (`src/ink/reconciler.ts:191`)
- **Pool reset interval** — Char and hyperlink pools are reset every 5 minutes to prevent unbounded memory growth during long sessions (`src/ink/ink.tsx:600-603`)
- **Scroll drain interval** — `FRAME_INTERVAL_MS >> 2` (~4ms) for smooth scroll continuation frames (`src/ink/ink.tsx:758`)

## Edge Cases & Caveats

- **Microtask boundary preservation**: Both `render()` and `createRoot()` include an `await Promise.resolve()` that preserves a microtask boundary originally provided by WASM Yoga loading. Without it, the first render fires synchronously before async startup work settles, causing Static writes to overwrite scrollback (`src/ink/root.ts:111-115`).

- **Alt-screen cursor drift self-healing**: Every alt-screen frame prepends CSI H (cursor home) to reset the physical cursor to (0,0) before diffing. This guards against tmux, multiplexers, or terminal emulators moving the cursor out-of-band between frames (`src/ink/ink.tsx:568-584`).

- **Resize is synchronous**: `handleResize` is deliberately NOT debounced. A debounce window where `stdout.columns` differs from `this.terminalColumns` causes log-update to detect a width change and clear the screen, then the debounce fires and clears again — double blank-then-paint flicker (`src/ink/ink.tsx:303-308`).

- **Kitty keyboard protocol stack management**: Extended key reporting uses a push/pop stack. `reassertTerminalModes()` always pops before pushing to keep depth at 1. Without this, each idle gap adds a stack entry, and the single pop on exit can't drain them — leaving the shell in CSI-u mode where Ctrl+C/D leak as escape sequences (`src/ink/ink.tsx:883-888`).

- **`detachForShutdown()`**: Must be called by the graceful shutdown path to prevent `signal-exit`'s deferred `unmount()` from writing redundant EXIT_ALT_SCREEN sequences that clobber resume hints on the main screen (`src/ink/ink.tsx:921-950`).

- **Selection during scroll**: Follow-scroll translates selection endpoints so highlights track content (native terminal behavior). During drag, only the anchor shifts; after release, both ends move. Straddling selections (one end in scrollbox, one in footer) are pinned — neither shift nor capture runs to avoid teleporting the highlight (`src/ink/ink.tsx:462-513`).

- **Console patching**: `patchConsole()` redirects `console.log/info/debug/dir` to the debug log and `console.error/warn` to the error logger to prevent stray stdout/stderr writes from corrupting the terminal buffer.

- **React 19 reconciler**: The reconciler implements React 19's `commitUpdate` signature (receives old/new props directly instead of an update payload) and includes required React 19 methods like `maySuspendCommit`, `preloadInstance`, and `suspendInstance` (`src/ink/reconciler.ts:472-506`).

## Key Code Snippets

### Render scheduling with microtask deferral

```typescript
// src/ink/ink.tsx:212-216
const deferredRender = (): void => queueMicrotask(this.onRender);
this.scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS, {
  leading: true,
  trailing: true
});
```

### Reconciler resetAfterCommit triggering layout + render

```typescript
// src/ink/reconciler.ts:247-301
resetAfterCommit(rootNode) {
    // ...timing instrumentation...
    if (typeof rootNode.onComputeLayout === 'function') {
      rootNode.onComputeLayout()   // Yoga layout calculation
    }
    // ...
    rootNode.onRender?.()           // Schedule terminal render
}
```

### ThemeProvider wrapping in the barrel export

```typescript
// src/ink.ts:14-23
function withTheme(node: ReactNode): ReactNode {
  return createElement(ThemeProvider, null, node)
}

export async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  return inkRender(withTheme(node), options)
}
```

### Instance singleton management

```typescript
// src/ink/root.ts:172-184
const getInstance = (
  stdout: NodeJS.WriteStream,
  createInstance: () => Ink,
): Ink => {
  let instance = instances.get(stdout)
  if (!instance) {
    instance = createInstance()
    instances.set(stdout, instance)
  }
  return instance
}
```