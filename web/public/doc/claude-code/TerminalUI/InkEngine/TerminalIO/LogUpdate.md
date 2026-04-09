# LogUpdate

## Overview & Responsibilities

LogUpdate is the intelligent screen diffing engine within the Ink rendering pipeline. It sits at the boundary between the render pipeline (which produces `Screen` buffers) and the terminal I/O layer (which writes escape sequences to stdout). Its job: given two successive frames, compute the **minimal set of terminal patch operations** (a `Diff`) that transform the previous terminal state into the next one.

Within the ancestor hierarchy, LogUpdate belongs to **TerminalUI → InkEngine → TerminalIO**. It is consumed by the `Ink` core orchestrator (`ink.tsx`), which calls `render()` each frame and writes the resulting `Diff` to the terminal. It coordinates with sibling modules for CSI escape sequences (`termio/csi.js`), OSC hyperlinks (`termio/osc.js`), and the `Screen` buffer's cell-level diff iterator and style pooling (`screen.js`).

## Key Processes

### Diff-Based Render Flow (`render()`)

The primary entry point is `render(prev, next, altScreen, decstbmSafe)` at `src/ink/log-update.ts:123-467`. It follows this decision tree:

1. **Non-TTY fallback** — If `isTTY` is false, falls through to `renderFullFrame()` which walks every cell sequentially (no diffing). This is used for piped/redirected output.

2. **Viewport resize detection** (lines 142–147) — If the viewport shrank vertically or changed width, triggers a full terminal clear and re-render (`fullResetSequence_CAUSES_FLICKER`), since predicting post-resize layout would require recalculating text wrapping.

3. **DECSTBM scroll optimization** (lines 149–185) — When in alt-screen mode with a `scrollHint` from a `ScrollBox`, instead of redrawing the scroll region:
   - Calls `shiftRows()` to mutate the previous screen buffer to match the shifted state
   - Emits CSI `DECSTBM` (set scroll region) + scroll up/down + reset region
   - The subsequent diff loop then only finds the **newly scrolled-in rows** as changes
   - Gated by `decstbmSafe` — disabled when DEC 2026 synchronization isn't available, to avoid visible intermediate state

4. **Scrollback detection** (lines 199–248) — When content overflows the viewport, rows scroll into terminal scrollback where cursor movement can't reach them. If any changed cells are in scrollback, a full reset is required. Two checks handle this:
   - Steady-state check: content already filled viewport and cursor was at bottom
   - Shrinking check: content was above-viewport and is now at-or-below

5. **Cell-level diff loop** (lines 308–381) — Uses `diffEach()` from the `Screen` module to iterate only cells that changed between frames. For each changed cell:
   - Skips wide-character spacers (the terminal auto-advances 2 columns)
   - Skips empty cells that don't need to overwrite content
   - Detects unreachable scrollback rows → triggers full reset
   - Moves cursor to the cell position, applies style/hyperlink transitions, writes the character

6. **Growth rendering** (lines 403–412) — New rows (when screen height increased) are rendered via `renderFrameSlice()` using CR+LF sequences that scroll the terminal naturally.

7. **Cursor restoration** (lines 418–451) — Restores the cursor to its target position. Skipped in alt-screen mode (next frame starts with CSI H). On main screen, uses LF to create lines past content height since cursor movement can't create new lines.

### Full Frame Rendering (`renderFullFrame()`)

Used for non-TTY output (`src/ink/log-update.ts:65-112`). Walks every cell left-to-right, top-to-bottom, tracking style and hyperlink state transitions. Resets styles at end of each line and trims trailing whitespace. Produces a single `stdout` content string.

### Full Reset Sequence (`fullResetSequence_CAUSES_FLICKER()`)

Fallback path at `src/ink/log-update.ts:503-513`. Emits a `clearTerminal` operation followed by a complete re-render from scratch. Used when incremental updates are impossible (scrollback changes, viewport resizes). Includes debug info (trigger row, previous/next line content) for diagnostics. Named with `_CAUSES_FLICKER` as a reminder that this path produces visible screen clearing.

### Row Slice Rendering (`renderFrameSlice()`)

Renders a contiguous range of rows (`src/ink/log-update.ts:527-623`). Key optimizations:
- Uses `visibleCellAtIndex()` to skip spacers, empty cells, and fg-only styled spaces that match the previous cell's style
- Advances rows with CR+LF (not CSI cursor-down) because LF can scroll the viewport while CUD stops at the margin
- Resets styles before each newline to prevent background color bleeding during terminal scroll

## Function Signatures

### `LogUpdate` class

```typescript
constructor(options: { isTTY: boolean; stylePool: StylePool })
```
Creates a new LogUpdate instance.

```typescript
render(prev: Frame, next: Frame, altScreen?: boolean, decstbmSafe?: boolean): Diff
```
Computes the minimal diff between two frames. Returns a `Diff` (array of typed patch operations).
- **prev**: The previously rendered frame
- **next**: The frame to render
- **altScreen**: Whether rendering in alternate screen mode (default: `false`)
- **decstbmSafe**: Whether DECSTBM scroll sequences are safe to use (default: `true`)

```typescript
renderPreviousOutput_DEPRECATED(prevFrame: Frame): Diff
```
Legacy method for finalizing output. Returns cursor-show operation if cursor was hidden.

```typescript
reset(): void
```
Clears internal state. Called on `SIGCONT` to prevent clobbering terminal content after process suspension.

### Helper Functions

| Function | Signature | Purpose |
|----------|-----------|---------|
| `moveCursorTo` | `(screen, targetX, targetY) → void` | Emits relative cursor movement patches, handling pending-wrap state with CR |
| `writeCellWithStyleStr` | `(screen, cell, styleStr) → boolean` | Writes a cell with style, handles wide chars at viewport edge, returns false if skipped |
| `transitionHyperlink` | `(diff, current, target) → Hyperlink` | Emits hyperlink open/close if changed |
| `transitionStyle` | `(diff, stylePool, currentId, targetId) → number` | Emits style transition string if changed |
| `needsWidthCompensation` | `(char) → boolean` | Detects emoji needing terminal width compensation |
| `readLine` | `(screen, y) → string` | Reads a screen row as plain text (for debug output) |
| `renderFrameSlice` | `(screen, frame, startY, endY, stylePool) → VirtualScreen` | Renders a range of rows |

## Type Definitions

### `State`
Internal mutable state tracking the previous output string (used for non-TTY mode).

### `Options`
```typescript
type Options = {
  isTTY: boolean      // Whether output is a terminal
  stylePool: StylePool // ANSI style deduplication pool from the Screen module
}
```

### `VirtualScreen`
File-private class (`src/ink/log-update.ts:752-773`) that tracks virtual cursor position and accumulates diff patches. Provides a `txn()` method for atomic cursor-position-aware patch emission:

```typescript
txn(fn: (prev: Point) => [patches: Diff, next: Delta]): void
```

The callback receives the current cursor position and returns patches to emit plus a delta to apply to the cursor. This ensures cursor tracking stays synchronized with emitted operations.

### `Diff` (from `frame.js`)
Array of typed patch operations: `stdout`, `clear`, `cursorMove`, `cursorTo`, `carriageReturn`, `cursorHide`, `cursorShow`, `hyperlink`, `styleStr`, `clearTerminal`.

## Edge Cases & Caveats

- **Wide characters at viewport edge** (`src/ink/log-update.ts:647-655`): Wide (CJK) characters that would cross the viewport boundary are silently skipped. Multi-codepoint graphemes (flags, ZWJ emoji) use a stricter threshold (`vw` instead of `vw+1`). When `writeCellWithStyleStr` returns false, callers must **not** update `currentStyleId` to avoid desyncing virtual style state from actual terminal state.

- **Emoji width compensation** (`src/ink/log-update.ts:733-750`): Some emoji display at width 2 but terminals with old `wcwidth` tables report width 1. LogUpdate compensates by writing a styled space at the next column and using CHA (cursor horizontal absolute) to force correct positioning. This covers Unicode 12.0+ symbols and text-default emoji with VS16 (U+FE0F).

- **Pending wrap state**: When the cursor reaches the viewport edge (`cursor.x >= viewportWidth`), terminals enter "pending wrap" where the next character would wrap. LogUpdate handles this by emitting CR before cursor moves to resolve the pending wrap without advancing to the next line.

- **Scrollback unreachability**: Terminal cursor movement cannot reach rows that have scrolled into scrollback. LogUpdate detects this (via `viewportY` calculations) and falls back to a full reset. The `cursorRestoreScroll` adjustment accounts for the extra row pushed into scrollback by the cursor-restore LF at the end of the previous frame.

- **DECSTBM atomicity** (`decstbmSafe` parameter): Without DEC 2026 synchronized output, the scroll-region optimization creates visible intermediate state (scrolled region with unpainted edge rows). When `decstbmSafe` is false, the scroll optimization is skipped and all shifted rows are rewritten through the diff loop — more bytes, but no flicker.

- **Performance monitoring** (lines 453-462): Renders exceeding 50ms are logged with screen dimensions, damage region, and change count for debugging slow frames.

## Key Code Snippets

### DECSTBM Scroll Optimization
The scroll-region optimization avoids redrawing entire scroll regions by using hardware scroll:

```typescript
// src/ink/log-update.ts:166-185
if (altScreen && next.scrollHint && decstbmSafe) {
  const { top, bottom, delta } = next.scrollHint
  if (top >= 0 && bottom < prev.screen.height && bottom < next.screen.height) {
    shiftRows(prev.screen, top, bottom, delta)
    scrollPatch = [{
      type: 'stdout',
      content:
        setScrollRegion(top + 1, bottom + 1) +
        (delta > 0 ? csiScrollUp(delta) : csiScrollDown(-delta)) +
        RESET_SCROLL_REGION +
        CURSOR_HOME,
    }]
  }
}
```

### VirtualScreen Transaction Model
All cursor-aware operations go through `txn()`, which keeps the virtual cursor synchronized:

```typescript
// src/ink/log-update.ts:765-772
txn(fn: (prev: Point) => [patches: Diff, next: Delta]): void {
  const [patches, next] = fn(this.cursor)
  for (const patch of patches) {
    this.diff.push(patch)
  }
  this.cursor.x += next.dx
  this.cursor.y += next.dy
}
```