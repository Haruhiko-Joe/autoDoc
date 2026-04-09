# OutputBuffer

## Overview & Responsibilities

The `Output` class is the operation-buffering stage of the Ink rendering pipeline, sitting between the DOM-to-positioned-text phase (`render-node-to-output`) and the final `Screen` cell buffer. Within the **TerminalUI → InkEngine → RenderPipeline** hierarchy, it acts as a write-ahead queue: upstream rendering code calls simple methods (`write`, `blit`, `clear`, `clip`, `shift`, `noSelect`) to describe what should appear on screen, and `Output.get()` replays those operations in order onto a `Screen` buffer that is then diffed against the previous frame.

Key responsibilities:

- **Operation queuing** — Collects seven operation types into an ordered list that preserves paint order (later writes win)
- **Clip stack** — Manages nested clipping regions for `ScrollBox` viewport clipping via `clip`/`unclip`, with proper intersection so nested overflow:hidden containers cannot escape their ancestors
- **Character cache (`charCache`)** — Caches the expensive ANSI tokenization → grapheme segmentation → bidi reordering pipeline per unique line string, so unchanged lines across frames become a single `Map.get` hit
- **Screen population** — Performs the final cell-by-cell write into the `Screen` buffer, handling wide characters, tab expansion, control character skipping, and escape sequence filtering

## Key Processes

### Operation Collection Phase

Upstream code (primarily `render-node-to-output`) builds up an `Output` instance by calling its public methods. Each call pushes a typed operation onto the internal `operations` array:

1. **`write(x, y, text, softWrap?)`** — Positioned ANSI-styled text, the most common operation (`src/ink/output.ts:241-253`)
2. **`blit(src, x, y, width, height)`** — Block copy from a previous frame's `Screen`, used for clean subtree optimization (`src/ink/output.ts:210-212`)
3. **`clear(region, fromAbsolute?)`** — Marks a region for damage tracking when nodes shrink (`src/ink/output.ts:227-229`)
4. **`clip(clip)` / `unclip()`** — Push/pop clipping rectangles (`src/ink/output.ts:255-266`)
5. **`shift(top, bottom, n)`** — Row-level shift for scroll optimization (`src/ink/output.ts:219-221`)
6. **`noSelect(region)`** — Marks regions excluded from text selection (`src/ink/output.ts:237-239`)

### `get()` — Screen Population

The `get()` method (`src/ink/output.ts:268-531`) replays all queued operations in two passes:

**Pass 1 — Damage expansion** (lines 288–305): Scans for `clear` operations, expands `screen.damage` to cover their regions, and collects clears from absolute-positioned nodes into `absoluteClears[]`. This is needed because the screen buffer starts zeroed — damage marking ensures `diff()` will check these regions against the previous frame.

**Pass 2 — Main dispatch loop** (lines 309–508): Iterates all operations in order:

- **`clip`**: Pushes onto a clip stack, intersecting with the parent clip via `intersectClip()` so nested containers can't escape their ancestor's viewport (`src/ink/output.ts:104-112`)
- **`unclip`**: Pops the clip stack
- **`blit`**: Copies cells from a source `Screen` via `blitRegion()`, intersected with the active clip. Rows covered by `absoluteClears` are skipped to prevent ghosting from stale absolute-positioned content (lines 330–389)
- **`shift`**: Delegates to `shiftRows()` for scroll-region row shifting
- **`write`**: The most complex path — clips text horizontally and vertically, then calls `writeLineToScreen()` per line. Tracks `softWrap` bits for proper line continuation metadata (lines 397–506)

**Pass 3 — noSelect** (lines 515–520): Applied last so `noSelect` marks win over blits and writes.

### `writeLineToScreen()` — Per-Line Cell Writing

This standalone function (`src/ink/output.ts:633-797`) is extracted for JIT optimization. It:

1. **Cache lookup**: Checks `charCache` for pre-processed `ClusteredChar[]` for the line string
2. **Cache miss path**: Runs the full pipeline: `tokenize()` → `styledCharsFromTokens()` → `styledCharsWithGraphemeClustering()` → `reorderBidi()`
3. **Cell loop**: Iterates clustered characters and calls `setCellAt()` for each:
   - Skips C0 control characters (CR, BS, BEL, etc.)
   - Expands tabs to 8-column tab stops (lines 664–675)
   - Skips unrecognized escape sequences (CSI, OSC, DCS, charset selection, single-char escapes) (lines 682–749)
   - Skips zero-width characters (combining marks, ZWS)
   - Handles wide characters: places `SpacerHead` when a wide char can't fit at the last column (lines 773–781)

### Character Caching & Clustering

The `charCache` (`Map<string, ClusteredChar[]>`) is the primary performance optimization. The cache key is the raw ANSI-styled line string; the value is the fully processed array of `ClusteredChar` objects.

`styledCharsWithGraphemeClustering()` (`src/ink/output.ts:553-584`) fixes a limitation of `ansi-tokenize` that splits grapheme clusters (like family emojis) into individual code points. It groups consecutive characters with the same ANSI styles, then re-segments using the ICU grapheme segmenter. Crucially, it computes `styleId` and `hyperlink` once per style run (not per character) via `flushBuffer()`:

```
// src/ink/output.ts:592-619
// An 80-char line with 3 style runs does 3 intern calls instead of 80
```

The cache is capped at 16,384 entries in `reset()` (`src/ink/output.ts:204`) — if exceeded, it's cleared entirely rather than using LRU eviction.

## Type Definitions

### `Operation` (union type)

```typescript
// src/ink/output.ts:62-69
export type Operation =
  | WriteOperation | ClipOperation | UnclipOperation
  | BlitOperation | ClearOperation | NoSelectOperation | ShiftOperation
```

### `ClusteredChar`

Pre-computed character data cached per unique line (`src/ink/output.ts:38-43`):

| Field | Type | Description |
|-------|------|-------------|
| `value` | `string` | The grapheme cluster string |
| `width` | `number` | Terminal display width (pre-computed via `stringWidth`) |
| `styleId` | `number` | Interned style ID from `StylePool` (safe to cache — pool is session-lived) |
| `hyperlink` | `string \| undefined` | Raw hyperlink URL (not interned — `hyperlinkPool` resets every 5 min) |

### `Clip`

```typescript
// src/ink/output.ts:91-96
export type Clip = {
  x1: number | undefined  // undefined = unbounded on that axis
  x2: number | undefined
  y1: number | undefined
  y2: number | undefined
}
```

### `Options`

| Field | Type | Description |
|-------|------|-------------|
| `width` | `number` | Screen width in columns |
| `height` | `number` | Screen height in rows |
| `stylePool` | `StylePool` | Session-lived style interning pool |
| `screen` | `Screen` | Target screen buffer (supports double-buffering via reuse) |

## Function Signatures

### `Output` class — Public API

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `(options: Options)` | Initializes dimensions, style pool, screen; calls `resetScreen()` |
| `reset` | `(width, height, screen): void` | Reuses Output for a new frame; clears ops, resets screen, caps charCache at 16K |
| `write` | `(x, y, text, softWrap?): void` | Queue positioned styled text |
| `blit` | `(src, x, y, width, height): void` | Queue block copy from another screen |
| `clear` | `(region, fromAbsolute?): void` | Queue damage-marking clear |
| `clip` / `unclip` | `(clip): void` / `(): void` | Push/pop clipping region |
| `shift` | `(top, bottom, n): void` | Queue row shift |
| `noSelect` | `(region): void` | Queue non-selectable region mark |
| `get` | `(): Screen` | Replay all operations and return the populated screen |

### Module-level Functions

| Function | Purpose |
|----------|---------|
| `intersectClip(parent, child)` | Intersects two clip regions, taking the tighter bound on each axis (`src/ink/output.ts:104-112`) |
| `styledCharsWithGraphemeClustering(chars, stylePool)` | Fixes grapheme splitting, pre-computes styleId/hyperlink per style run (`src/ink/output.ts:553-584`) |
| `flushBuffer(buffer, styles, stylePool, out)` | Segments a same-style text run into grapheme clusters with computed metadata (`src/ink/output.ts:586-620`) |
| `writeLineToScreen(screen, line, x, y, screenWidth, stylePool, charCache)` | Writes one line into screen cells with caching, tab expansion, and escape filtering (`src/ink/output.ts:633-797`) |
| `stylesEqual(a, b)` | Fast reference-then-deep comparison of ANSI style code arrays (`src/ink/output.ts:534-543`) |

## Edge Cases & Caveats

- **Wide characters at screen edge**: When a 2-cell-wide character would start at the last column, a `SpacerHead` blank is placed instead, matching terminal wrapping behavior (`src/ink/output.ts:773-781`)
- **Wide characters at clip boundary**: If `sliceAnsi` includes a wide character that overflows `clip.x2` by one cell, it re-slices one cell earlier (`src/ink/output.ts:443-445`)
- **Absolute-positioned node ghosting**: Blit operations skip rows covered by absolute-position clears to prevent stale content from overlaying normal-flow siblings (lines 362–388). This is why `ClearOperation` has a `fromAbsolute` flag
- **Hyperlink style filtering**: OSC 8 close codes (empty URL) are treated as active styles by the tokenizer and must be filtered even when no hyperlink URL is present (`src/ink/output.ts:601-609`)
- **charCache growth**: Hard-capped at 16,384 entries with full eviction (no LRU). This prevents memory leaks from long-running sessions with many unique lines
- **Soft-wrap through clip**: When vertical clipping removes the line before a soft-wrap continuation, the content-end of the clipped line is pre-computed so `screen.softWrap` metadata stays correct (`src/ink/output.ts:463-465`)
- **Unrecognized escape sequences**: The write loop handles CSI, OSC, DCS, APC, PM, SOS, charset selection, and single-character escape sequences that `ansi-tokenize` doesn't parse, skipping them to prevent cursor desync