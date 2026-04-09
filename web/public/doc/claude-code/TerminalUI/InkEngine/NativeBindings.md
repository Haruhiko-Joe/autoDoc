# NativeBindings

## Overview & Responsibilities

NativeBindings (`src/native-ts/`) provides **pure TypeScript reimplementations** of modules that originally shipped as Rust/NAPI native binaries. These ports eliminate platform-specific native dependencies while preserving API-compatible behavior so callers don't need to change.

Within the TerminalUI → InkEngine hierarchy, these bindings supply two critical rendering foundations — the **Yoga flexbox layout engine** that computes every element's position and size, and the **color-diff module** that renders syntax-highlighted, word-diffed code blocks in the terminal. A third module, **file-index**, provides fuzzy file search used elsewhere in the system.

The directory contains three sub-modules:

| Sub-module | File | Lines | Purpose |
|---|---|---|---|
| yoga-layout | `src/native-ts/yoga-layout/index.ts` + `enums.ts` | ~2,700 | Flexbox layout engine (CSS Flexbox subset) |
| color-diff | `src/native-ts/color-diff/index.ts` | ~1,000 | Syntax-highlighted diff rendering with word-level granularity |
| file-index | `src/native-ts/file-index/index.ts` | ~370 | Fuzzy file search with nucleo-style scoring |

## Key Processes

### Layout Calculation (Yoga)

The full layout flow when `calculateLayout()` is called on a root node:

1. **Cache check** — dirty-flag skip with two-slot + multi-entry (4-slot) LRU cache. Clean subtrees with matching inputs skip entirely. A generation counter prevents stale cross-generation cache hits from dirty nodes while allowing same-generation caching for fresh mounts.
2. **Resolve dimensions** — padding, border, margin resolved against owner width. Fast-path flags (`_hasPadding`, `_hasBorder`, `_hasMargin`) skip resolution for nodes with no edges set.
3. **Leaf nodes** — if a measure function is set, invoke it with inner dimensions and mode; otherwise size to padding+border.
4. **Container layout** (STEP 1-3) — compute flex-basis for each child via `computeFlexBasis()`, break into lines for wrap, resolve flexible lengths via multi-pass distribution per CSS §9.7.
5. **Position children** (STEP 5) — apply `justify-content`, `align-items`, `align-content`, auto margins, relative position offsets. Handle `wrap-reverse` and baseline alignment.
6. **Absolute children** (STEP 6) — position absolutely-positioned children against the containing block's padding-box.
7. **Pixel-grid rounding** — `roundLayout()` walks the tree applying upstream yoga's rounding rules (floor for text positions, ceil for fractional text widths).

> Source: `src/native-ts/yoga-layout/index.ts:1058-1902`

### Diff Rendering Pipeline (ColorDiff)

When `ColorDiff.render()` is called:

1. **Detect color mode** from theme name and `$COLORTERM` env var → truecolor, 256-color, or ANSI
2. **Build theme** — select Monokai/GitHub/ANSI scope tables and diff background colors (with daltonized variants)
3. **Detect language** from file extension, filename, or shebang line
4. **Parse hunk** — assign `+`/`-`/` ` markers and line numbers to each line
5. **Compute word-level diffs** — find adjacent delete/add pairs via `findAdjacentPairs()`, tokenize into words/whitespace/punctuation, run `diffArrays()` to get changed byte ranges. Skip if >40% of content changed (`CHANGE_THRESHOLD`)
6. **Per-line transform pipeline**: syntax highlight → strip newlines → apply word-diff background colors → wrap to terminal width → prepend `+`/`-`/` ` marker → prepend line number → serialize to ANSI escape strings

> Source: `src/native-ts/color-diff/index.ts:860-932`

### Fuzzy File Search (FileIndex)

When `FileIndex.search()` is called:

1. **Bitmap pre-filter** — O(1) rejection: if the path's 26-bit letter bitmap doesn't contain all letters in the query, skip immediately
2. **Smart case** — lowercase query → case-insensitive; any uppercase → case-sensitive
3. **Fused indexOf scan** — finds match positions using `String.indexOf()` and accumulates gap/consecutive penalties inline
4. **Gap-bound reject** — before the expensive boundary-scoring pass, reject candidates whose best-case score can't beat the current top-k threshold
5. **Boundary/camelCase scoring** — bonuses for matches at word boundaries and camelCase transitions
6. **Top-k maintenance** — sorted ascending array with binary-search insertion
7. **Score normalization** — final score = position-in-results / result-count (lower = better). Paths containing `"test"` get a 1.05× penalty

> Source: `src/native-ts/file-index/index.ts:173-290`

---

## Yoga Layout Bindings

### What It Does

A complete TypeScript port of Meta's [Yoga](https://github.com/facebook/yoga) flexbox layout engine, matching the `yoga-layout/load` API surface used by Ink's layout layer. It computes positions (left/top) and dimensions (width/height) for a tree of nodes using CSS Flexbox rules.

### Supported Features

**Used by Ink:**
- `flex-direction` (row, column, row-reverse, column-reverse)
- `flex-grow`, `flex-shrink`, `flex-basis`
- `align-items` / `align-self` (stretch, flex-start, center, flex-end)
- `justify-content` (all six values: flex-start, center, flex-end, space-between, space-around, space-evenly)
- `margin` / `padding` / `border` / `gap`
- `width` / `height` / `min-*` / `max-*` (point, percent, auto)
- `position: relative | absolute`
- `display: flex | none`
- Measure functions (for text nodes)

**Implemented for spec parity (not used by Ink):**
- `margin: auto`, `flex-wrap` / `wrap-reverse`, `align-content`, `display: contents`, baseline alignment

**Not implemented:** `aspect-ratio`, `box-sizing: content-box`, RTL direction

> Source: `src/native-ts/yoga-layout/index.ts:1-38`

### Enums

All Yoga enums are ported as `const` objects (not TypeScript enums) matching upstream values exactly. Each has a corresponding type alias:

`Align`, `BoxSizing`, `Dimension`, `Direction`, `Display`, `Edge`, `Errata`, `ExperimentalFeature`, `FlexDirection`, `Gutter`, `Justify`, `MeasureMode`, `Overflow`, `PositionType`, `Unit`, `Wrap`

> Source: `src/native-ts/yoga-layout/enums.ts`

### Key Types

```typescript
// src/native-ts/yoga-layout/index.ts:82-85
type Value = { unit: Unit; value: number }

// src/native-ts/yoga-layout/index.ts:349-354
type MeasureFunction = (
  width: number, widthMode: MeasureMode,
  height: number, heightMode: MeasureMode,
) => { width: number; height: number }
```

### Node API

The `Node` class (`src/native-ts/yoga-layout/index.ts:403-964`) is the primary public interface.

**Tree management:**
- `insertChild(child, index)`, `removeChild(child)`, `getChild(index)`, `getChildCount()`, `getParent()`

**Lifecycle:**
- `free()`, `freeRecursive()`, `reset()` — release resources and reset state

**Dirty tracking:**
- `markDirty()` — propagates up to root; `isDirty()` — checks status

**Measure function:**
- `setMeasureFunc(fn)` — registers a callback for leaf text nodes to report their intrinsic dimensions

**Style setters** — all call `markDirty()` internally:
- Dimensions: `setWidth()`, `setHeight()`, `setMinWidth()`, `setMaxWidth()`, etc. Accept `number`, `'auto'`, or percent strings (`'50%'`)
- Flex: `setFlexDirection()`, `setFlexGrow()`, `setFlexShrink()`, `setFlexBasis()`, `setFlex()`, `setFlexWrap()`
- Alignment: `setAlignItems()`, `setAlignSelf()`, `setAlignContent()`, `setJustifyContent()`
- Spacing: `setMargin(edge, v)`, `setPadding(edge, v)`, `setBorder(edge, v)`, `setGap(gutter, v)`
- Layout: `setDisplay()`, `setPositionType()`, `setPosition(edge, v)`, `setOverflow()`

**Layout entry point:**
- `calculateLayout(ownerWidth, ownerHeight, direction?)` — runs the full flexbox algorithm and rounds results to the pixel grid

**Computed layout getters:**
- `getComputedLeft()`, `getComputedTop()`, `getComputedWidth()`, `getComputedHeight()`
- `getComputedLayout()` — returns `{ left, top, right, bottom, width, height }`
- `getComputedBorder(edge)`, `getComputedPadding(edge)`, `getComputedMargin(edge)`

### Module-Level API

The module exports a `Yoga` object and `loadYoga()` function matching the `yoga-layout/load` API:

```typescript
// src/native-ts/yoga-layout/index.ts:2561-2576
const YOGA_INSTANCE: Yoga = {
  Config: { create: createConfig, destroy() {} },
  Node: {
    create: (config?) => new Node(config),
    createDefault: () => new Node(),
    createWithConfig: (config) => new Node(config),
    destroy() {},
  },
}

export function loadYoga(): Promise<Yoga> {
  return Promise.resolve(YOGA_INSTANCE)
}
```

### Performance Optimizations

- **Fast-path flags** on Node (`_hasAutoMargin`, `_hasPosition`, `_hasPadding`, `_hasBorder`, `_hasMargin`) — skip expensive edge resolution when no edges are set (~67% of calls in benchmarks). Source: `src/native-ts/yoga-layout/index.ts:414-433`
- **Multi-entry layout cache** — 4-slot LRU per node; for 500-message scrollbox relayout: 76k → 4k layoutNode calls (6.86ms → 550µs). Source: `src/native-ts/yoga-layout/index.ts:487-496`
- **Flex-basis cache** (`_fbBasis`, `_fbGen`) — generation-stamped to avoid stale hits while allowing same-generation reuse for repeated measure calls. Source: `src/native-ts/yoga-layout/index.ts:468-486`
- **`resolveEdges4Into()`** — batched 4-edge resolution avoiding per-edge function call overhead. Source: `src/native-ts/yoga-layout/index.ts:269-307`
- **Inline `boundAxis()` fast path** — skips `resolveValue` when no min/max constraints exist. Source: `src/native-ts/yoga-layout/index.ts:2352-2384`

---

## Color-Diff Module

### What It Does

Provides syntax-highlighted, word-level diff rendering for terminal output. Used by the structured diff views to display code changes with colored backgrounds (green for additions, red for deletions) and inline word-level highlighting.

### Architecture

The module has four layers:

1. **Color/ANSI escape helpers** — RGB-to-ANSI-256 approximation (`ansi256FromRgb`), escape sequence generation for truecolor/256-color/ANSI modes
2. **Theme system** — Monokai Extended (dark), GitHub (light), and ANSI themes with scope-to-color mappings
3. **Syntax highlighting** — highlight.js integration with lazy loading, scope color mapping, and hljs AST flattening
4. **Diff rendering pipeline** — per-line transform: highlight → remove newlines → word-diff backgrounds → wrap text → add markers → add line numbers → serialize to ANSI

### Function Signatures & Parameters

#### `ColorDiff`

```typescript
// src/native-ts/color-diff/index.ts:842-933
class ColorDiff {
  constructor(hunk: Hunk, firstLine: string | null, filePath: string, prefixContent?: string | null)
  render(themeName: string, width: number, dim: boolean): string[] | null
}
```

- `hunk` — unified diff hunk with `oldStart`, `oldLines`, `newStart`, `newLines`, and `lines` (each prefixed with `+`/`-`/` `)
- `firstLine` — first line of the original file, used for shebang-based language detection
- `filePath` — used for extension-based language detection
- `themeName` — Claude theme name (e.g. `"dark"`, `"light"`, `"ansi-dark"`, `"daltonized-dark"`)
- `width` — terminal width in columns; lines wrap to fit
- `dim` — when true, entire output is dimmed and word-diff highlighting is suppressed

Returns an array of ANSI-escaped strings (one per display line after wrapping).

#### `ColorFile`

```typescript
// src/native-ts/color-diff/index.ts:935-968
class ColorFile {
  constructor(code: string, filePath: string)
  render(themeName: string, width: number, dim: boolean): string[] | null
}
```

Renders a complete file with syntax highlighting and line numbers (no diff markers).

#### `getSyntaxTheme(themeName: string): SyntaxTheme`

Returns the syntax theme name for the given Claude theme. Since highlight.js doesn't support bat themes, always returns the default for dark/light/ansi.

> Source: `src/native-ts/color-diff/index.ts:970-977`

#### `getNativeModule(): NativeModule | null`

Lazy loader returning `{ ColorDiff, ColorFile, getSyntaxTheme }` — matches the vendor native module API.

> Source: `src/native-ts/color-diff/index.ts:982-986`

### Interface/Type Definitions

```typescript
// src/native-ts/color-diff/index.ts:52-58
type Hunk = {
  oldStart: number; oldLines: number
  newStart: number; newLines: number
  lines: string[]
}

// src/native-ts/color-diff/index.ts:60-63
type SyntaxTheme = { theme: string; source: string | null }

// src/native-ts/color-diff/index.ts:65-69
type NativeModule = {
  ColorDiff: typeof ColorDiff
  ColorFile: typeof ColorFile
  getSyntaxTheme: (themeName: string) => SyntaxTheme
}
```

### RGB to ANSI-256 Color Approximation

Port of the `ansi_colours` Rust crate. Approximates RGB to the xterm-256 palette by comparing candidates from the 6×6×6 color cube (indices 16-231) and the 24-step grey ramp (indices 232-255), picking whichever has smaller squared-distance.

> Source: `src/native-ts/color-diff/index.ts:104-127`

### Word Diff Algorithm

The `wordDiffStrings` function (`src/native-ts/color-diff/index.ts:604-636`):

1. Tokenizes old and new strings into words (Unicode letters/digits/underscore), whitespace runs, and single punctuation codepoints
2. Runs `diffArrays` (from the `diff` npm package) on the token arrays
3. Returns byte-offset ranges for changed regions in both old and new strings
4. If more than 40% of content changed (`CHANGE_THRESHOLD = 0.4`), returns empty ranges (entire line is highlighted instead)

### Edge Cases & Caveats

- **highlight.js is lazily loaded** — the full bundle registers 190+ grammars (~50MB, 100-200ms on macOS). Deferred until first render to avoid blocking startup. Same lazy pattern the NAPI wrapper used for `dlopen`. Source: `src/native-ts/color-diff/index.ts:26-43`
- **Syntax highlighting differences from native** — highlight.js doesn't scope plain identifiers and operators (`=`, `:`) so they render in default foreground instead of white/pink
- **`BAT_THEME` env support is a stub** — always returns the default theme for the given Claude theme mode
- Deleted lines (`-` marker) are **not syntax highlighted** — only context and added lines get highlighting (matching the Rust module's behavior in ANSI mode where deleted lines are dimmed instead)
- **Storage keyword re-splitting** — keywords like `const`, `let`, `function`, `class`, `struct`, `impl` are re-classified from highlight.js's generic `keyword` scope to `_storage` so they get the cyan color instead of pink, matching syntect's Monokai output. Source: `src/native-ts/color-diff/index.ts:248-265`

---

## File-Index Module

### What It Does

A fuzzy file search engine ported from the Rust NAPI module that wraps [nucleo](https://github.com/helix-editor/nucleo) (used by the Helix editor). Given a list of file paths, it builds an index and performs scored fuzzy matching.

### Function Signatures & Parameters

```typescript
// src/native-ts/file-index/index.ts:18-21
type SearchResult = { path: string; score: number }
```

```typescript
// src/native-ts/file-index/index.ts:43
class FileIndex {
  // Synchronous: deduplicates and indexes all paths immediately
  loadFromFileList(fileList: string[]): void

  // Async: yields to event loop every ~4ms; returns two promises
  loadFromFileListAsync(fileList: string[]): {
    queryable: Promise<void>  // resolves when first chunk is indexed
    done: Promise<void>       // resolves when full index is built
  }

  // Fuzzy search; returns top `limit` results sorted best-first
  search(query: string, limit: number): SearchResult[]
}
```

### Scoring Constants

Approximating nucleo/fzf-v2 scoring:

| Constant | Value | Meaning |
|---|---|---|
| `SCORE_MATCH` | 16 | Base score per matched character |
| `BONUS_BOUNDARY` | 8 | Match after a boundary char (`/`, `\`, `-`, `_`, `.`, space) |
| `BONUS_CAMEL` | 6 | Match at a camelCase transition (lowercase → uppercase) |
| `BONUS_CONSECUTIVE` | 4 | Consecutive matched characters |
| `BONUS_FIRST_CHAR` | 8 | First query char matches at position 0 |
| `PENALTY_GAP_START` | 3 | Starting a gap between matches |
| `PENALTY_GAP_EXTENSION` | 1 | Each additional gap character |

> Source: `src/native-ts/file-index/index.ts:24-30`

### Index Data Structures

Per indexed path, the `FileIndex` stores:

- `paths: string[]` — original paths
- `lowerPaths: string[]` — lowercased for case-insensitive matching
- `charBits: Int32Array` — 26-bit bitmap (one bit per a-z letter present in the path)
- `pathLens: Uint16Array` — path lengths for length-bonus scoring

> Source: `src/native-ts/file-index/index.ts:44-48`

### Empty Query Behavior

When query is empty, returns cached top-level path segments (first path component of each unique path), sorted by length then alphabetically, capped at 100 entries. This mirrors `FileIndex::compute_top_level_entries` in the Rust source.

> Source: `src/native-ts/file-index/index.ts:336-367`

### Configuration & Defaults

| Constant | Value | Purpose |
|---|---|---|
| `TOP_LEVEL_CACHE_LIMIT` | 100 | Max entries for empty-query results |
| `MAX_QUERY_LEN` | 64 | Query characters beyond this are ignored |
| `CHUNK_MS` | 4 | Async yield interval in milliseconds |

> Source: `src/native-ts/file-index/index.ts:32-37`

### Edge Cases & Caveats

- Query length is capped at 64 characters (`MAX_QUERY_LEN`)
- The async loader resolves `queryable` after the first chunk is indexed — `search()` returns partial results from `readyCount` indexed paths while the rest builds in the background
- Event loop yielding uses time-based chunking (`CHUNK_MS = 4ms`) rather than count-based, so slow machines get smaller chunks and stay responsive
- The `yieldToEventLoop()` helper uses `setImmediate` and is exported for reuse. Source: `src/native-ts/file-index/index.ts:325-327`
- Test files are penalized: paths containing `"test"` get a 1.05× score multiplier (capped at 1.0) so non-test files rank higher in results