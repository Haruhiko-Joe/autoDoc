# RenderNodeToOutput

## Overview & Responsibilities

`renderNodeToOutput` is the core DOM tree walker in the Ink rendering engine (~1,460 lines). It sits within the **RenderPipeline** stage of **InkEngine**, which itself is part of the **TerminalUI** module. After Yoga layout calculation produces computed positions and sizes for every DOM node, this module recursively walks the DOM tree and converts each `DOMElement` into positioned text operations on an `Output` buffer — a 2D grid that will eventually be diffed against the previous screen and flushed to the terminal.

Its sibling pipeline stages include the `renderer` (orchestration), `Output` (2D cell grid), `Screen` (diff buffer), `render-border` (box borders), and `colorize` (ANSI styling). This module is the bridge between the abstract DOM/layout world and the concrete cell-based terminal output.

**Key responsibilities:**
- Recursive DOM traversal of `ink-root`, `ink-box`, `ink-text`, and `ink-raw-ansi` nodes
- Blit optimization: skip re-rendering clean subtrees by copying cells from the previous `Screen`
- ScrollBox viewport management: clipping, scroll offset, sticky follow, virtual-scroll clamping
- Hardware scroll hints (DECSTBM) for efficient terminal scrolling
- Adaptive scroll drain with separate strategies for native terminals vs xterm.js (VS Code)
- Text node squashing into styled segments with per-segment ANSI styling and OSC 8 hyperlinks
- Text wrapping with soft-wrap tracking and style preservation across wrapped lines
- Clip region management for overflow hidden/scroll containers
- Layout-shift detection for damage tracking (narrow vs full-screen diff)
- Background color fill, `noSelect` marking, border rendering delegation
- Absolute-positioned element handling (negative-y clamping, escaping-descendant blit repair)

## Key Processes

### Main Render Walk (`renderNodeToOutput`)

The entry point is `renderNodeToOutput()` (`src/ink/render-node-to-output.ts:387-1227`), called once per frame for the root node. It recurses through the DOM tree with these steps for each node:

1. **Display check** — If the Yoga node has `display: none`, clear its cached position and return early. Drops the subtree cache so unhiding doesn't restore stale cells.

2. **Position computation** — Compute absolute screen position (`x`, `y`) by adding the node's Yoga-computed left/top to the parent offset. Absolute-positioned nodes with negative `y` are clamped to 0.

3. **Blit check** — If the node is clean (not dirty), has no pending scroll, its position/size match the cache, and a previous screen exists, copy (blit) the node's rectangle from `prevScreen` and return early. This is the primary optimization — unchanged subtrees skip all rendering work.

4. **Stale content clearing** — If the node moved or its content changed, clear the old cached rectangle from the output buffer. Process any pending child-removal clears.

5. **Zero-height squeeze guard** — If Yoga squeezed the node to height 0 and a sibling occupies the same row, skip rendering to prevent ghost characters.

6. **Node-type dispatch:**
   - **`ink-raw-ansi`**: Write pre-rendered ANSI text directly
   - **`ink-text`**: Squash text nodes into styled segments, wrap, style, and write (see Text Rendering below)
   - **`ink-box`**: Handle noSelect, clipping, scroll containers, background fills, child rendering, and borders
   - **`ink-root`**: Simply render children

7. **Cache update** — Store the node's computed rect in `nodeCache`, record absolute rects, clear the dirty flag.

### Text Rendering Pipeline

When an `ink-text` node is encountered (`src/ink/render-node-to-output.ts:549-627`):

1. **Squash** — `squashTextNodesToSegments()` collapses inline text children into an array of `StyledSegment` objects, each carrying its text content, ANSI styles, and optional hyperlink URL.

2. **Measure** — Join segment text to get the plain string. Compute `maxWidth` clamped to screen bounds.

3. **Wrap** — If the text exceeds `maxWidth`, wrap it using `wrapWithSoftWrap()` which tracks which newlines are soft-wraps (inserted by word-wrap) vs hard newlines from the source.

4. **Style application** — Three paths depending on complexity:
   - **Single segment + wrapping**: Wrap plain text, then apply styles line-by-line
   - **Multiple segments + wrapping**: Build a `charToSegment` map, then `applyStylesToWrappedText()` re-applies per-character styles after wrapping
   - **No wrapping**: Apply styles directly to each segment

5. **Padding** — `applyPaddingToText()` adds vertical/horizontal offset based on the first child's Yoga position.

6. **Write** — `output.write(x, y, text, softWrap)` places the styled text into the output buffer.

### ScrollBox Rendering

The most complex code path handles `overflowY: 'scroll'` containers (`src/ink/render-node-to-output.ts:688-1154`):

1. **Geometry calculation** — Compute `innerHeight` (viewport minus padding/borders), `scrollHeight` (content wrapper's intrinsic height), and `maxScroll`.

2. **Scroll anchor resolution** — If `scrollAnchor` is set, snap `scrollTop` to the anchor element's Yoga position (one-shot).

3. **At-bottom follow** — If `scrollTop` was at or past the previous max and content grew, pin to the new max. Records a `FollowScroll` event so `ink.tsx` can translate active text selections.

4. **Pending scroll drain** — Consume `pendingScrollDelta` using one of two strategies:
   - **Native terminals** (`drainProportional`): Drain ~75% per frame with a minimum of 4 rows. Big bursts catch up in log₄ frames.
   - **xterm.js / VS Code** (`drainAdaptive`): Low pending (≤5) drains instantly; higher pending uses small fixed steps (2-3 rows) for smooth animation. Excess beyond 30 snaps immediately.

5. **Virtual-scroll clamp** — If `scrollTop` raced past the mounted child range, clamp the visual render to the edge of the mounted range without writing back (React will catch up).

6. **Rendering** — Two paths:
   - **Fast path (DECSTBM)**: When scroll delta is small and the container didn't move, blit the previous viewport, shift rows in-place, then render only edge rows (new content entering the viewport). A second pass re-renders dirty children in stable rows. A third pass repairs rows where shifted absolute overlay copies landed.
   - **Full path**: Clear the viewport and render all visible children with culling.

### Blit Optimization & Overflow Contamination

`renderChildren()` (`src/ink/render-node-to-output.ts:1257-1294`) manages the sibling rendering order with contamination tracking:

- After a dirty child renders, subsequent siblings have `prevScreen` disabled to prevent blitting stale overflow content.
- Exception: children that clip both axes can't overflow onto siblings, so the contamination guard is skipped for them (critical for ScrollBox + spinner performance).
- A separate `seenDirtyClipped` flag handles overlap contamination for absolute-positioned siblings that sit inside a dirty clipped child's bounds.

### Layout-Shift Detection

A per-frame boolean `layoutShifted` (`src/ink/render-node-to-output.ts:34`) is set whenever a node's position/size changes from its cached value, a child is removed, or a large scroll occurs. `ink.tsx` reads this via `didLayoutShift()` to decide between narrow damage-bounded diff (O(changed cells)) and full-screen diff (O(rows×cols)). Steady-state frames (spinner ticks, clock updates, text appends) avoid setting this flag.

## Function Signatures

### `renderNodeToOutput(node, output, options): void`

The main recursive tree walker. Not exported — called internally by the renderer.

| Parameter | Type | Description |
|-----------|------|-------------|
| `node` | `DOMElement` | The DOM node to render |
| `output` | `Output` | The 2D output buffer to write into |
| `options.offsetX` | `number` | Cumulative X offset from ancestors (default 0) |
| `options.offsetY` | `number` | Cumulative Y offset from ancestors (default 0) |
| `options.prevScreen` | `Screen \| undefined` | Previous frame's screen for blit optimization |
| `options.skipSelfBlit` | `boolean` | Force descent instead of blitting this node's rect |
| `options.inheritedBackgroundColor` | `Color` | Background color inherited from parent boxes |

> Source: `src/ink/render-node-to-output.ts:387-407`

### Exported Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `resetLayoutShifted()` | `() => void` | Clear the layout-shift flag at frame start |
| `didLayoutShift()` | `() => boolean` | Check if any node shifted position this frame |
| `resetScrollHint()` | `() => void` | Clear the DECSTBM scroll hint and rotate absolute rects |
| `getScrollHint()` | `() => ScrollHint \| null` | Get the captured hardware scroll hint |
| `resetScrollDrainNode()` | `() => void` | Clear the pending-drain scheduling node |
| `getScrollDrainNode()` | `() => DOMElement \| null` | Get the node needing continued drain next frame |
| `consumeFollowScroll()` | `() => FollowScroll \| null` | Consume the at-bottom follow event (one-shot read) |

### Exported Test Utilities

`buildCharToSegmentMap` and `applyStylesToWrappedText` are exported for testing (`src/ink/render-node-to-output.ts:1460`).

## Type Definitions

### `ScrollHint`

DECSTBM hardware scroll optimization hint. Consumed by `log-update.ts` to emit terminal scroll sequences instead of rewriting the viewport.

| Field | Type | Description |
|-------|------|-------------|
| `top` | `number` | 0-indexed inclusive top screen row of the scroll region |
| `bottom` | `number` | 0-indexed inclusive bottom screen row |
| `delta` | `number` | Rows to shift; positive = content moved up (scrolled down) |

> Source: `src/ink/render-node-to-output.ts:49`

### `FollowScroll`

Event emitted when at-bottom follow pins `scrollTop` to new content. Used by `ink.tsx` to translate active text selections so highlights stay anchored to the text.

| Field | Type | Description |
|-------|------|-------------|
| `delta` | `number` | How many rows scrollTop advanced |
| `viewportTop` | `number` | Absolute screen row where the viewport starts |
| `viewportBottom` | `number` | Absolute screen row where the viewport ends |

> Source: `src/ink/render-node-to-output.ts:93-97`

## Configuration & Defaults

### Scroll Drain Constants

**Native terminal (proportional) drain** (`src/ink/render-node-to-output.ts:110`):

| Constant | Value | Purpose |
|----------|-------|---------|
| `SCROLL_MIN_PER_FRAME` | 4 | Minimum rows drained per frame |

Proportional formula: `step = min(cap, max(4, floor(abs * 3/4)))`, so big bursts catch up in ~log₄(n) frames while the tail decelerates smoothly.

**xterm.js (VS Code) adaptive drain** (`src/ink/render-node-to-output.ts:117-121`):

| Constant | Value | Purpose |
|----------|-------|---------|
| `SCROLL_INSTANT_THRESHOLD` | 5 | At or below this: drain all at once (slow clicks feel instant) |
| `SCROLL_HIGH_PENDING` | 12 | Above this: use the high step size |
| `SCROLL_STEP_MED` | 2 | Medium catch-up step for pending in (5, 12) |
| `SCROLL_STEP_HIGH` | 3 | Fast flick step for pending ≥ 12 |
| `SCROLL_MAX_PENDING` | 30 | Snap excess beyond this limit immediately |

### Terminal Detection

`isXtermJsHost()` (`src/ink/render-node-to-output.ts:23-25`) selects the drain strategy. Returns `true` when `TERM_PROGRAM=vscode` or the async XTVERSION probe identified xterm.js. This is the same detection used by the wheel-acceleration curve in `ScrollKeybindingHandler.tsx`.

## Edge Cases & Caveats

- **Negative absolute positioning**: Absolute nodes with `y < 0` (e.g., autocomplete menus with `bottom='100%'`) are clamped to `y = 0` so content is visible rather than clipped at the top (`src/ink/render-node-to-output.ts:448-450`).

- **Zero-height ghost prevention**: When Yoga squeezes a box to height 0, rendering is skipped only if a sibling shares the same Y coordinate. Without the sibling check, Yoga's pixel-grid rounding can legitimately produce `h=0` nodes that should still occupy a row (`src/ink/render-node-to-output.ts:527-539`).

- **Blit contamination after dirty siblings**: Content can overflow right/down, so clean siblings after a dirty one have `prevScreen` disabled. Clipped children (overflow hidden/scroll on both axes) are exempt since their content is confined — without this exemption, a spinner inside a ScrollBox would force the entire bottom prompt to re-render every frame (`src/ink/render-node-to-output.ts:1229-1294`).

- **Escaping absolute descendants**: When a node blits, absolute-positioned descendants painting outside the node's bounds are not covered. `blitEscapingAbsoluteDescendants()` re-blits these rects from prevScreen — without this, floating menus (e.g., the slash command menu) vanish on the next frame when an adjacent spinner ticks (`src/ink/render-node-to-output.ts:1337-1369`).

- **DECSTBM fast path safety**: The blit+shift fast path is only used when the height delta matches the scroll delta (pure scroll or bottom-append). Mismatched height changes (child insertion/removal) fall back to the full path to avoid stale rows (`src/ink/render-node-to-output.ts:908-916`).

- **Virtual-scroll clamp is visual only**: When `scrollTop` races past the mounted child range, the rendered position is clamped but `node.scrollTop` retains the target value so React can mount the correct range on the next commit (`src/ink/render-node-to-output.ts:834-850`).

- **Past-clamp drain throttling**: Scroll drain continues past the virtual-scroll clamp edge (stopping caused stop-start jutter), but is throttled to ~4 rows/frame to prevent `scrollTop` from racing thousands of rows ahead of the mounted range (`src/ink/render-node-to-output.ts:809-824`).

- **Display:none cache cleanup**: When a node transitions to `display: none`, its entire subtree cache is dropped. Without this, unhiding would blit empty cells from prevScreen at the old position (`src/ink/render-node-to-output.ts:413-433`).

- **Wrap-trim whitespace sync**: `applyStylesToWrappedText()` carefully tracks character indices through whitespace that was trimmed by the wrapper, skipping leading spaces that disappeared from the output while preserving tabs and other non-space whitespace (`src/ink/render-node-to-output.ts:211-323`).

## Key Code Snippets

### Blit Fast Path (skip unchanged subtrees)

The core optimization that makes incremental rendering fast — if a node is clean and hasn't moved, copy its pixels from the previous frame:

```typescript
// src/ink/render-node-to-output.ts:455-482
if (
  !node.dirty &&
  !skipSelfBlit &&
  node.pendingScrollDelta === undefined &&
  cached &&
  cached.x === x && cached.y === y &&
  cached.width === width && cached.height === height &&
  prevScreen
) {
  output.blit(prevScreen, fx, fy, fw, fh)
  blitEscapingAbsoluteDescendants(node, output, prevScreen, fx, fy, fw, fh)
  return
}
```

### Adaptive Scroll Drain (xterm.js)

The drain function that decides how many rows to apply per frame for smooth scrolling in VS Code:

```typescript
// src/ink/render-node-to-output.ts:124-157
function drainAdaptive(node, pending, innerHeight) {
  const sign = pending > 0 ? 1 : -1
  let abs = Math.abs(pending)
  let applied = 0
  if (abs > SCROLL_MAX_PENDING) {
    applied += sign * (abs - SCROLL_MAX_PENDING)
    abs = SCROLL_MAX_PENDING
  }
  const step = abs <= SCROLL_INSTANT_THRESHOLD ? abs
    : abs < SCROLL_HIGH_PENDING ? SCROLL_STEP_MED : SCROLL_STEP_HIGH
  applied += sign * step
  // ... cap at innerHeight-1 for DECSTBM compatibility
}
```

### DECSTBM Scroll Fast Path

Instead of re-rendering all visible children, blit + shift + render only the edge rows:

```typescript
// src/ink/render-node-to-output.ts:917-956
if (hint && prevScreen && safeForFastPath) {
  const { top, bottom, delta } = hint
  output.blit(prevScreen, Math.floor(x), top, w, bottom - top + 1)
  output.shift(top, bottom, delta)
  const edgeTop = delta > 0 ? bottom - delta + 1 : top
  const edgeBottom = delta > 0 ? bottom : top - delta - 1
  output.clear({ x: Math.floor(x), y: edgeTop, width: w, height: edgeBottom - edgeTop + 1 })
  output.clip({ x1: undefined, x2: undefined, y1: edgeTop, y2: edgeBottom + 1 })
  renderScrolledChildren(content, output, contentX, contentY, ...)
  output.unclip()
}
```