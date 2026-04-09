# Frame Orchestration

## Overview & Responsibilities

The Frame Orchestration module is the pipeline entry point for the Ink rendering engine's per-frame output. It sits within the **RenderPipeline** subgroup of **InkEngine**, which itself is part of the **TerminalUI** layer. Sibling pipeline stages handle DOM-to-output conversion, screen buffering, diffing, and terminal writing — this module defines the data contracts they all share (Frame, Patch, Diff) and owns the top-level `createRenderer` factory that drives each render cycle.

Its responsibilities:

- **Define the `Frame` type** — the canonical output of a single render pass (screen buffer + viewport size + cursor position + scroll hints).
- **Define `Patch` / `Diff` types** — the vocabulary of incremental terminal update operations.
- **Provide `FrameEvent`** — timing instrumentation that breaks a frame's cost into measurable phases.
- **Implement `shouldClearScreen`** — a heuristic deciding when the terminal must be fully cleared instead of incrementally patched.
- **Implement `createRenderer`** — the factory that produces a per-frame render function, managing double-buffered screen allocation, Output reuse, yoga dimension validation, blit-safety checks, and alt-screen adjustments.

## Key Processes

### Per-Frame Render Loop (`createRenderer`)

The `createRenderer` factory (`src/ink/renderer.ts:31-178`) accepts a root DOM element and a style pool, then returns a closure that is called once per frame. Each invocation:

1. **Extract double-buffered screens** — reads `frontFrame.screen` (the previously-displayed buffer) and `backFrame.screen` (the back buffer to render into). Pools (char, hyperlink) are read from the back buffer since they may be replaced between frames during generational resets (`src/ink/renderer.ts:40-46`).

2. **Validate Yoga dimensions** — checks that the root node's computed width and height are finite, non-negative numbers. If the yoga node is missing or dimensions are invalid (e.g., `NaN` before `calculateLayout()` runs), it returns an empty frame immediately and logs a diagnostic message (`src/ink/renderer.ts:52-82`).

3. **Compute effective height** — in normal mode, uses the yoga-computed height. In alt-screen mode, clamps to `terminalRows` to enforce the invariant that alt-screen content never exceeds the terminal size. Overflow is clipped with a warning log (`src/ink/renderer.ts:84-104`).

4. **Manage the Output instance** — reuses a single `Output` object across frames so its internal `charCache` (tokenize + grapheme clustering results) persists, avoiding redundant work for unchanged lines. On first call it constructs a new `Output`; on subsequent calls it resets the existing one (`src/ink/renderer.ts:108-112`).

5. **Reset per-frame state** — clears layout-shifted, scroll-hint, and scroll-drain tracking flags (`src/ink/renderer.ts:114-116`).

6. **Blit-safety check** — determines whether the previous frame's screen can be used for blit optimization (copying unchanged regions). The previous screen is "contaminated" when:
   - Selection overlays mutated it post-render
   - Alt-screen entry/resize/SIGCONT reset it to blanks
   - `forceRedraw()` reset it to 0×0
   - An absolute-positioned node was removed (it may have painted over non-siblings)
   
   When contaminated, `prevScreen` is passed as `undefined` to `renderNodeToOutput`, disabling blit and forcing a full re-render (`src/ink/renderer.ts:118-135`).

7. **Invoke `renderNodeToOutput`** — the core DOM-to-screen conversion, walking the DOM tree and writing styled text cells into the Output/Screen buffer (`src/ink/renderer.ts:130-135`).

8. **Handle scroll drain continuation** — if a ScrollBox has remaining `pendingScrollDelta`, marks the drain node as dirty so the next frame descends into its subtree (`src/ink/renderer.ts:139-144`).

9. **Assemble the final Frame** — constructs the return value with:
   - `scrollHint`: DECSTBM scroll region hint (alt-screen only)
   - `scrollDrainPending`: signals that another frame should be scheduled
   - `screen`: the rendered screen buffer
   - `viewport`: terminal dimensions, with a `+1` height hack in alt-screen mode to prevent `shouldClearScreen` from triggering on content that exactly fills the alt buffer
   - `cursor`: positioned at `(0, screen.height)` in normal mode; in alt-screen mode, clamped inside the viewport to prevent cursor-restore from emitting a linefeed that would scroll the alt buffer (`src/ink/renderer.ts:146-177`).

### Screen Clear Heuristic (`shouldClearScreen`)

`shouldClearScreen` (`src/ink/frame.ts:105-124`) compares consecutive frames and returns a `FlickerReason` when a full terminal clear is needed:

1. **Resize detection** — if `viewport.width` or `viewport.height` changed between frames, returns `'resize'`.
2. **Overflow detection** — if either the current or previous frame's `screen.height >= viewport.height`, returns `'offscreen'`. This catches cases where content overflows the terminal and incremental diffing would produce artifacts.

If neither condition is met, returns `undefined` (incremental diff is safe).

## Type Definitions

### `Frame` (`src/ink/frame.ts:12-20`)

The output of a single render pass.

| Field | Type | Description |
|-------|------|-------------|
| `screen` | `Screen` | The rendered cell buffer |
| `viewport` | `Size` (`{width, height}`) | Terminal dimensions for this frame |
| `cursor` | `Cursor` (`{x, y, visible}`) | Cursor position and visibility |
| `scrollHint` | `ScrollHint \| null` | DECSTBM scroll optimization hint (alt-screen only) |
| `scrollDrainPending` | `boolean` | Whether a ScrollBox needs another frame to finish scrolling |

### `Patch` (`src/ink/frame.ts:73-93`)

A discriminated union representing a single atomic terminal update operation:

| Variant | Fields | Purpose |
|---------|--------|---------|
| `stdout` | `content: string` | Raw text to write |
| `clear` | `count: number` | Clear N lines |
| `clearTerminal` | `reason: FlickerReason`, `debug?` | Full terminal clear with attribution |
| `cursorHide` | — | Hide the cursor |
| `cursorShow` | — | Show the cursor |
| `cursorMove` | `x, y: number` | Relative cursor movement |
| `cursorTo` | `col: number` | Move cursor to column |
| `carriageReturn` | — | Carriage return |
| `hyperlink` | `uri: string` | OSC 8 hyperlink escape |
| `styleStr` | `str: string` | Pre-serialized SGR style transition |

### `Diff` (`src/ink/frame.ts:94`)

Simply `Patch[]` — an ordered list of patches that transforms the previous frame into the current one.

### `FlickerReason` (`src/ink/frame.ts:36`)

`'resize' | 'offscreen' | 'clear'` — categorizes why a full screen clear was triggered.

### `FrameEvent` (`src/ink/frame.ts:38-71`)

Timing instrumentation for frame performance analysis.

| Field | Type | Description |
|-------|------|-------------|
| `durationMs` | `number` | Total frame time |
| `phases` | object (optional) | Per-phase breakdown (populated when instrumentation is enabled) |
| `flickers` | `Array<{desiredHeight, availableHeight, reason}>` | Full-clear events during this frame |

The `phases` object tracks: `renderer`, `diff`, `optimize`, `write` (ms durations), `patches` (pre-optimize count), `yoga` / `commit` (layout and reconcile time), and `yogaVisited` / `yogaMeasured` / `yogaCacheHits` / `yogaLive` (yoga node statistics).

### `RenderOptions` (`src/ink/renderer.ts:15-27`)

Configuration passed to the renderer each frame.

| Field | Type | Description |
|-------|------|-------------|
| `frontFrame` | `Frame` | The currently-displayed frame (for diffing) |
| `backFrame` | `Frame` | The back buffer to render into |
| `isTTY` | `boolean` | Whether stdout is a TTY |
| `terminalWidth` | `number` | Terminal column count |
| `terminalRows` | `number` | Terminal row count |
| `altScreen` | `boolean` | Whether alt-screen mode is active |
| `prevFrameContaminated` | `boolean` | Whether the previous screen buffer was mutated post-render |

## Function Signatures

### `emptyFrame(rows, columns, stylePool, charPool, hyperlinkPool): Frame`

Creates a zero-content frame with an empty screen (0×0) but a viewport matching the given terminal dimensions. Used for initialization before the first real render.

> Source: `src/ink/frame.ts:22-34`

### `shouldClearScreen(prevFrame, frame): FlickerReason | undefined`

Compares two consecutive frames to determine if a full screen clear is needed. Returns the reason string or `undefined` if incremental diffing is safe.

> Source: `src/ink/frame.ts:105-124`

### `createRenderer(node, stylePool): Renderer`

Factory function that returns a `Renderer` closure (type: `(options: RenderOptions) => Frame`). The closure captures the DOM root node and reuses an `Output` instance across frames for cache efficiency.

> Source: `src/ink/renderer.ts:31-178`

## Edge Cases & Caveats

- **Alt-screen viewport hack**: In alt-screen mode, the viewport height is set to `terminalRows + 1` (`src/ink/renderer.ts:158-160`). This prevents `shouldClearScreen`'s overflow check from firing on content that exactly fills the terminal — which is the normal case for alt-screen. Without this, every alt-screen frame would trigger a full clear, causing visible flicker.

- **Alt-screen cursor clamping**: The cursor Y position is clamped to `min(screen.height, terminalRows) - 1` in alt-screen mode (`src/ink/renderer.ts:170-171`). If the cursor lands at `screen.height === terminalRows`, log-update's cursor-restore would emit a linefeed at the last row, scrolling the alt buffer up by one line and desyncing the diff model.

- **Alt-screen height clamping**: When yoga computes a height exceeding `terminalRows` in alt-screen mode (typically a bug where a component renders outside `<AlternateScreen>`), the height is clamped and overflow is silently clipped. A warning is logged to help diagnose the misplaced component (`src/ink/renderer.ts:97-104`).

- **Absolute-node removal poisons blit**: When an absolute-positioned node is removed between frames, the previous screen is treated as contaminated (`src/ink/renderer.ts:129`). Absolute nodes can paint over unrelated subtrees, so blitting from the old screen would restore stale pixels. Normal-flow removals don't have this cross-subtree contamination issue.

- **Selection contamination**: The selection overlay system mutates the screen buffer *after* render (in `ink.tsx`). The `prevFrameContaminated` flag propagates this, ensuring the next frame doesn't blit inverted (selected) cells from the stale buffer.

- **NaN yoga dimensions**: Before `calculateLayout()` has run, `getComputedHeight()` returns `NaN`. The renderer guards against this and also checks for negative and `Infinity` values that would cause `RangeError` when allocating arrays (`src/ink/renderer.ts:52-62`).

- **Output reuse for cache efficiency**: The `Output` instance is deliberately kept alive across frames (`src/ink/renderer.ts:37`). Its internal `charCache` stores tokenization and grapheme clustering results, so unchanged lines skip expensive re-parsing. This is a key performance optimization for steady-state rendering (e.g., spinner ticks, streaming text).

- **Scroll drain continuation**: After rendering a frame that partially scrolls a `ScrollBox`, the drain node is marked dirty (`src/ink/renderer.ts:143-144`) so the next frame re-enters its subtree. This must happen *after* `renderNodeToOutput` completes, since that function clears dirty flags at the end of its walk.