# ScreenBuffer

## Overview & Responsibilities

ScreenBuffer (`src/ink/screen.ts`, ~1,490 lines) is the cell-based 2D buffer that backs Ink's terminal rendering pipeline. It sits within **TerminalUI → InkEngine → RenderPipeline** — the renderer writes styled cells into a Screen, the diff engine compares the previous and current Screen to compute minimal terminal updates, and `log-update` writes only the changed cells to stdout.

The module provides two categories of functionality:

1. **Interning pools** (`CharPool`, `StylePool`, `HyperlinkPool`) — session-lived string interning that lets every cell store integer IDs instead of strings. This enables O(1) equality checks during diff (two `Int32` comparisons per cell) and zero-copy blit between screens.

2. **Screen type and operations** — a flat packed `Int32Array` buffer representing a grid of styled terminal cells, with functions for creation, mutation, bulk copy, row shifting, region clearing, and diffing.

Sibling pipeline stages (render-node-to-output, Output, render-to-screen, colorize, optimizer) feed data into or consume data from the Screen buffer.

## Key Data Structures

### Packed Cell Layout

Each cell occupies **2 consecutive `Int32` elements** in a single contiguous `Int32Array`:

| Word | Bits | Content |
|------|------|---------|
| word0 (`cells[ci]`) | 31:0 | `charId` — index into `CharPool` |
| word1 (`cells[ci+1]`) | 31:17 | `styleId` — encoded style pool ID |
| | 16:2 | `hyperlinkId` — index into `HyperlinkPool` (15 bits) |
| | 1:0 | `width` — `CellWidth` enum (Narrow/Wide/SpacerTail/SpacerHead) |

> Source: `src/ink/screen.ts:332-348`

A `BigInt64Array` view (`cells64`) shares the same `ArrayBuffer`, enabling bulk-fill operations (e.g., `resetScreen`) with a single `fill(0n)` call instead of per-cell loops.

For a 200×120 terminal, this avoids allocating 24,000 Cell objects — all data lives in a single typed array with zero GC pressure.

### Screen Type

```typescript
// src/ink/screen.ts:366-415
export type Screen = Size & {
  cells: Int32Array       // packed cell data (2 Int32s per cell)
  cells64: BigInt64Array  // same buffer, for bulk fill
  charPool: CharPool
  hyperlinkPool: HyperlinkPool
  emptyStyleId: number
  damage: Rectangle | undefined   // bounding box of written cells this frame
  noSelect: Uint8Array            // per-cell selection exclusion bitmap
  softWrap: Int32Array            // per-row soft-wrap continuation markers
}
```

**`damage`** tracks the bounding box of cells written during the current frame so `diffEach` can skip scanning unchanged regions.

**`noSelect`** is a per-cell bitmap (1 = exclude from text selection) used by `<NoSelect>` components to mark gutters, line numbers, and diff sigils so click-drag yields clean copyable text.

**`softWrap`** tracks per-row word-wrap continuation: `softWrap[r] = N > 0` means row `r` is a continuation of row `r-1`, and row `r-1`'s content ends at column `N`. This lets selection copy join wrapped lines without inserting false newlines.

### CellWidth Enum

```typescript
// src/ink/screen.ts:289-300
export const enum CellWidth {
  Narrow = 0,      // Standard single-width character
  Wide = 1,        // First cell of a double-wide character (CJK, emoji)
  SpacerTail = 2,  // Second cell of a wide character (not rendered)
  SpacerHead = 3,  // End-of-line spacer when a wide char wraps to next line
}
```

Wide characters occupy two cells: the first holds the actual character with `width = Wide`, and the next column is a `SpacerTail` placeholder. This keeps the buffer aligned to visual columns.

## Interning Pools

### CharPool

`src/ink/screen.ts:21-53`

Interns character strings (single chars and grapheme clusters like emoji) into integer IDs. Index 0 is always `' '` (space), index 1 is always `''` (empty, used for spacer cells).

**ASCII fast path**: For single-byte characters (code < 128), a pre-allocated `Int32Array[128]` provides direct lookup without touching the `Map`, making the common case (ASCII text) allocation-free after the first intern.

### HyperlinkPool

`src/ink/screen.ts:57-75`

Interns OSC 8 hyperlink URIs. Index 0 means "no hyperlink". Straightforward Map-based interning.

### StylePool

`src/ink/screen.ts:112-260`

The most complex pool. Interns arrays of `AnsiCode` objects (SGR sequences) into integer IDs with a key design detail:

**Bit 0 encodes visibility on spaces**: `id = (rawId << 1) | visibleOnSpaceFlag`. Styles that only affect foreground color get even IDs; styles with background, inverse, underline, etc. get odd IDs. This lets the renderer skip invisible styled spaces with a single bitmask check (`id & 1`).

**Key methods**:

- **`intern(styles)`** — Deduplicate a style array, return its ID with the visibility bit.
- **`get(id)`** — Recover the `AnsiCode[]` from an ID (strips bit 0 via `>>> 1`).
- **`transition(fromId, toId)`** — Returns the pre-serialized ANSI escape string to switch from one style to another. Cached by `(fromId, toId)` pair using the key `fromId * 0x100000 + toId`. Zero allocations after the first call for a given pair. This is the hot path in the render loop.
- **`withInverse(baseId)`** — Returns a new style ID that is `base + SGR 7 (inverse)`. Used by the selection overlay. Cached per base ID; avoids stacking if already inverted.
- **`withCurrentMatch(baseId)`** — Returns a style for the *current* search match: yellow background (via fg-then-inverse swap), bold, and underline. Strips existing fg/bg to avoid ambiguity across terminals. Other matches use plain inverse; the current match gets this distinct treatment to stand out.
- **`withSelectionBg(baseId)` / `setSelectionBg(bg)`** — Replaces a cell's background with a solid selection color while preserving foreground attributes. Strips existing bg and inverse to match native terminal selection behavior. Falls back to `withInverse` if no selection color is set.

## Key Processes

### Screen Creation and Reset

**`createScreen(width, height, styles, charPool, hyperlinkPool)`** (`src/ink/screen.ts:451-492`)

Allocates a single `ArrayBuffer` of `width * height * 8` bytes, then creates two views: `Int32Array` for per-word access and `BigInt64Array` for bulk fill. Since `ArrayBuffer` is zero-initialized, all cells start as empty (charId=0=space, styleId=0=none, width=0=Narrow).

**`resetScreen(screen, width, height)`** (`src/ink/screen.ts:501-544`)

Reuses an existing screen for the next frame (double-buffering). Only reallocates if the new dimensions exceed the current buffer size (grow-only policy to avoid thrashing). Clears cells via `cells64.fill(0n)`, resets `noSelect` and `softWrap`, and clears `damage`.

### Cell Write Flow (setCellAt)

`src/ink/screen.ts:693-810`

Writing a cell is more than a simple store — it must maintain wide-character invariants:

1. **Orphan cleanup (overwriting a Wide)**: If the cell being overwritten was `Wide` and the new cell is `Narrow`, the old `SpacerTail` at `x+1` is cleared to prevent ghost cells leaking through in the diff.
2. **Orphan cleanup (overwriting a SpacerTail)**: If overwriting a `SpacerTail`, the orphaned `Wide` character at `x-1` is cleared to prevent cursor desync.
3. **Pack and store**: Interns the character string and hyperlink, then packs `styleId | hyperlinkId | width` into word1.
4. **Damage tracking**: Expands the damage bounding box in-place to include this cell (and any cleared orphans).
5. **SpacerTail creation**: If the new cell is `Wide`, automatically writes a `SpacerTail` at `x+1`, including cascading orphan cleanup if that position was also `Wide`.

### Blit (blitRegion)

`src/ink/screen.ts:858-952`

Bulk-copies a rectangular region from one screen to another using `TypedArray.set()`:

- **Fast path**: When copying full-width rows at matching strides, a single `set()` call copies the entire region contiguously.
- **Slow path**: Per-row `set()` calls for partial-width or mismatched-stride regions.
- Both paths also copy `noSelect` and `softWrap` data.
- After the copy, computes damage once for the whole region.
- Handles wide characters at the right edge: if the last cell in a blit row is `Wide`, writes the `SpacerTail` into the destination even if it's outside the blit region.

Because both screens share the same `CharPool` and `HyperlinkPool`, interned IDs are valid across screens — no re-interning needed during blit.

### Diff Engine (diffEach)

`src/ink/screen.ts:1156-1463`

Computes the minimal set of cell changes between two screens (prev and next):

1. **Region computation**: Uses `damage` rectangles from both screens (unioned together) to limit scanning. Also handles height/width shrinkage by extending the region.
2. **Same-width fast path** (`diffSameWidth`): Both screens share the same stride, so a single cell index tracks both arrays. Uses `findNextDiff()` — a tight loop comparing 2 Int32s per cell — to skip over unchanged runs. JIT-friendly: small, pure, no allocations.
3. **Different-width fallback** (`diffDifferentWidth`): Maintains separate indices for prev and next. Used during terminal resize.
4. **Row dispatch**: Each row is classified as both-present, removed-only, or added-only, and dispatched to a specialized function. Removed rows emit all cells (terminal needs clearing); added rows skip empty cells.
5. **Zero-allocation iteration**: Two `Cell` objects are pre-allocated and reused across all callback invocations. Callers must not retain references.

The callback returns `true` for early exit, `false`/`void` to continue.

### Pool Migration (migrateScreenPools)

`src/ink/screen.ts:554-587`

Occasionally (e.g., between conversation turns), pools can be replaced with fresh ones to allow the old pools to be GC'd (generational reset). This function re-interns every cell's charId and hyperlinkId from old pools to new pools in a single O(width×height) pass, then swaps the pool references.

## Function Signatures

### Screen Lifecycle

| Function | Description |
|----------|-------------|
| `createScreen(width, height, styles, charPool, hyperlinkPool): Screen` | Allocate a new screen buffer |
| `resetScreen(screen, width, height): void` | Clear and optionally resize for next frame |
| `migrateScreenPools(screen, charPool, hyperlinkPool): void` | Re-intern all IDs into new pools |

### Cell Access

| Function | Description |
|----------|-------------|
| `cellAt(screen, x, y): Cell \| undefined` | Get cell at position (bounds-checked) |
| `cellAtIndex(screen, index): Cell` | Get cell by flat index (no bounds check) |
| `visibleCellAtIndex(cells, charPool, hyperlinkPool, index, lastRenderedStyleId): Cell \| undefined` | Get cell only if it has visible content; returns `undefined` for spacers, empty cells, and fg-only spaces matching the last style |
| `charInCellAt(screen, x, y): string \| undefined` | Get just the character at a position |
| `isEmptyCellAt(screen, x, y): boolean` | Check if a cell is empty by packed value |
| `isCellEmpty(screen, cell): boolean` | Check if a Cell view object represents empty |

### Cell Mutation

| Function | Description |
|----------|-------------|
| `setCellAt(screen, x, y, cell): void` | Write a cell with wide-char invariant maintenance |
| `setCellStyleId(screen, x, y, styleId): void` | Replace only the style of an existing cell |

### Bulk Operations

| Function | Description |
|----------|-------------|
| `blitRegion(dst, src, regionX, regionY, maxX, maxY): void` | Copy a rectangular region between screens |
| `clearRegion(screen, x, y, width, height): void` | Clear a rectangular region to empty |
| `shiftRows(screen, top, bottom, n): void` | Shift rows up (`n > 0`) or down (`n < 0`) within a range |
| `markNoSelectRegion(screen, x, y, width, height): void` | Mark region as excluded from text selection |

### Diff

| Function | Description |
|----------|-------------|
| `diff(prev, next): [Point, Cell?, Cell?][]` | Collect all changes as an array (for tests) |
| `diffEach(prev, next, cb): boolean` | Iterate changes via callback (production, zero-alloc) |

### Hyperlink Helpers

| Function | Description |
|----------|-------------|
| `extractHyperlinkFromStyles(styles): Hyperlink \| null` | Extract OSC 8 URI from an AnsiCode array |
| `filterOutHyperlinkStyles(styles): AnsiCode[]` | Remove OSC 8 codes from a style array |

## Edge Cases & Caveats

- **Wide character orphan cleanup**: `setCellAt` handles 4 distinct orphan scenarios when overwriting cells involved in wide-character pairs. Missing any of these causes ghost cells or cursor desync. The cascading case (writing a Wide onto another Wide's SpacerTail position) requires clearing up to 3 cells.

- **StylePool bit-0 trick**: Style IDs are not simple sequential integers. Bit 0 encodes whether the style is visible on space characters. Code that compares or stores styleIds must be aware that `get(id)` strips this bit (`id >>> 1`). The `transition()` cache key uses `fromId * 0x100000 + toId`, which works because style IDs are bounded by pool size.

- **`visibleCellAtIndex` optimization**: This function uses a bitmask check (`word1 & 0x3fffc`) to detect cells that are "invisible" (space with no hyperlink and only fg styling matching the last rendered style). This allows the renderer to skip these cells and use cursor-forward movement instead, saving bandwidth.

- **Grow-only buffer policy**: `resetScreen` only reallocates when the new dimensions exceed the current buffer. This avoids allocation thrashing during terminal resize but means memory is not reclaimed if the terminal shrinks.

- **Damage rectangles are approximate**: `setCellAt` expands damage in-place rather than precisely tracking individual cells. The diff engine scans the entire damage region and relies on `findNextDiff` to skip unchanged cells within it.

- **Pool migration is O(n)**: `migrateScreenPools` touches every cell. It's only called between conversation turns to avoid impacting frame times.

- **`diffEach` reuses Cell objects**: The callback receives mutable Cell references that are overwritten on the next iteration. Callers must copy cell data if they need to retain it (as `diff()` does with spread syntax).

- **Non-integer dimensions**: Both `createScreen` and `resetScreen` defensively clamp non-integer width/height to `Math.max(0, Math.floor(value) || 0)` and log warnings, guarding against bad Yoga layout output.