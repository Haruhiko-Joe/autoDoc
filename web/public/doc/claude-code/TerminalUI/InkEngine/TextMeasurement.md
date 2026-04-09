# TextMeasurement

## Overview & Responsibilities

TextMeasurement is a collection of text measurement and string-width utilities within the InkEngine subsystem of the TerminalUI. It provides the foundational text metrics that the layout engine (Yoga) and rendering pipeline depend on to correctly position content in the terminal.

The module answers a deceptively hard question: *how wide is this string when rendered in a terminal?* Unicode makes this complex — CJK characters are double-width, combining marks are zero-width, emoji sequences render as a single glyph, and ANSI escape codes are invisible. These utilities handle all of that, plus text wrapping, truncation, tab expansion, and caching for performance.

### Position in the Architecture

TextMeasurement lives inside **InkEngine** (the custom Ink rendering engine), which is a child of **TerminalUI**. Its sibling modules include the DOM model, Yoga layout bindings, ANSI output generation, and primitive components (Box, Text, ScrollBox). The measurement utilities feed directly into the layout and rendering pipeline — every text node's dimensions flow through these functions.

## Key Processes

### String Width Calculation

The core pipeline for measuring a single string's display width (`src/ink/stringWidth.ts`):

1. **Runtime dispatch** (line 220–222): At module load, check if `Bun.stringWidth` is available. If so, use the native Bun implementation (faster, handles complex scripts correctly). Otherwise, fall back to the JavaScript implementation.

2. **Fast path: pure ASCII** (lines 26–45): Scan the string byte-by-byte. If every character is below code point 127 and not an ANSI escape, simply count printable characters (code > `0x1f`). This avoids all Unicode overhead for the common case.

3. **ANSI stripping** (lines 47–53): If the string contains `\x1b` (escape character), strip all ANSI sequences before measuring.

4. **Fast path: simple Unicode** (lines 56–65): If the string has no emoji, variation selectors, or ZWJ joiners (checked by `needsSegmentation()`), iterate code points and sum their East Asian widths directly, skipping zero-width characters.

5. **Full grapheme segmentation** (lines 67–89): For complex strings, use `Intl.Segmenter` to split into grapheme clusters. Each cluster is classified as either emoji (width 2, with special cases for regional indicators and incomplete keycaps) or a standard grapheme (width of first non-zero-width code point).

### Text Wrapping Flow

`wrapText()` (`src/ink/wrap-text.ts:40–74`) dispatches based on the `textWrap` style:

- **`wrap`**: Delegates to `wrapAnsi()` with `trim: false, hard: true` — preserves leading/trailing whitespace, breaks at column boundary
- **`wrap-trim`**: Same but trims whitespace from wrapped lines
- **`truncate` / `truncate-middle` / `truncate-start`**: Calls `truncate()` which uses `sliceAnsi()` to cut the string at the right visual position and inserts an ellipsis (`…`). The `sliceFit()` helper (line 10–13) handles boundary-spanning wide characters by retrying with a tighter bound.

### Measurement Pipeline

When the layout engine needs to measure a text node:

1. `measureText()` (`src/ink/measure-text.ts:11–45`) computes both width and height in a **single pass** — it iterates lines via `indexOf('\n')` (avoiding `split()` allocation), measures each with `lineWidth()`, and accumulates height based on wrapping (`Math.ceil(w / maxWidth)`)
2. `lineWidth()` (`src/ink/line-width-cache.ts:10–24`) wraps `stringWidth()` with a per-line cache (up to 4096 entries), providing ~50x reduction in `stringWidth` calls during streaming
3. `getMaxWidth()` (`src/ink/get-max-width.ts:17–25`) extracts the content-area width from a Yoga layout node (computed width minus padding and border)

## Function Signatures

### `stringWidth(str: string): number`

Returns the terminal display width of a string, handling full-width CJK, combining marks, emoji, and ANSI escapes.

> Source: `src/ink/stringWidth.ts:220–222`

### `measureText(text: string, maxWidth: number): { width: number; height: number }`

Single-pass measurement returning the widest line's width and the total visual height (accounting for line wrapping at `maxWidth`).

- **text**: The string to measure (may contain newlines)
- **maxWidth**: Column limit for wrapping. If `<= 0` or `Infinity`, no wrapping occurs.

> Source: `src/ink/measure-text.ts:11–45`

### `widestLine(string: string): number`

Returns the display width of the widest line in a multi-line string.

> Source: `src/ink/widest-line.ts:3–19`

### `wrapAnsi(input: string, columns: number, options?: WrapAnsiOptions): string`

Wraps text at `columns` width while preserving ANSI escape codes. Uses `Bun.wrapAnsi` when available, falls back to the `wrap-ansi` npm package.

- **options.hard**: Break at exact column even mid-word (default behavior in usage)
- **options.wordWrap**: Prefer breaking at word boundaries
- **options.trim**: Trim whitespace from wrapped lines

> Source: `src/ink/wrapAnsi.ts:14–18`

### `wrapText(text: string, maxWidth: number, wrapType: Styles['textWrap']): string`

High-level text wrapping/truncation dispatcher. Supports modes: `'wrap'`, `'wrap-trim'`, `'truncate'`, `'truncate-middle'`, `'truncate-start'`.

> Source: `src/ink/wrap-text.ts:40–74`

### `expandTabs(text: string, interval?: number): string`

Replaces tab characters with the correct number of spaces based on column position. Default interval is 8 (POSIX standard). ANSI-aware — tokenizes the input to skip escape sequences.

> Source: `src/ink/tabstops.ts:9–46`

### `getMaxWidth(yogaNode: LayoutNode): number`

Returns a Yoga layout node's content width (computed width minus horizontal padding and border).

> Source: `src/ink/get-max-width.ts:17–25`

### `measureElement(node: DOMElement): { width: number; height: number }`

Returns the computed dimensions of a `<Box>` DOM element from its Yoga node.

> Source: `src/ink/measure-element.ts:18–21`

### `lineWidth(line: string): number`

Cached wrapper around `stringWidth()`. Maintains an LRU-style cache of up to 4096 entries, clearing entirely on overflow.

> Source: `src/ink/line-width-cache.ts:10–24`

## Type Definitions

### `WrapAnsiOptions`

```typescript
type WrapAnsiOptions = {
  hard?: boolean      // Break at exact column boundary
  wordWrap?: boolean  // Prefer word boundaries
  trim?: boolean      // Trim whitespace on wrapped lines
}
```

> Source: `src/ink/wrapAnsi.ts:3–7`

## Configuration & Defaults

| Parameter | Default | Description |
|-----------|---------|-------------|
| Tab interval | `8` | Column interval for tab stops (`expandTabs`) |
| `ambiguousAsWide` / `ambiguousIsNarrow` | `false` / `true` | East Asian ambiguous-width characters treated as narrow (width 1) |
| `MAX_CACHE_SIZE` | `4096` | Maximum entries in the line-width cache before full eviction |

## Edge Cases & Caveats

- **Bun vs. JS divergence on complex scripts**: The Bun native `stringWidth` and the JavaScript fallback can disagree on complex-script graphemes (e.g., Devanagari conjuncts like क्ष). Bun returns 2 (matching terminal cell allocation), while the JS fallback returns 1 (grapheme cluster count). The codebase prefers Bun's result for correct cursor positioning. See the comment at `src/ink/stringWidth.ts:205–209`.

- **`getMaxWidth` can exceed parent width**: In column-direction flex layouts, `align-items: stretch` never shrinks children below their intrinsic size. `getMaxWidth()` may return a value wider than the actual screen. Callers should clamp to available screen space. (`src/ink/get-max-width.ts:7–15`)

- **Wide character boundary slicing**: When slicing ANSI strings for truncation, a double-width character (e.g., CJK) at the slice boundary can overshoot by 1 column. `sliceFit()` handles this by retrying with `end - 1`. (`src/ink/wrap-text.ts:10–13`)

- **Cache eviction strategy**: The line-width cache uses simple full-clear on overflow rather than LRU eviction. This is intentional — the cache repopulates within a single frame, and the simplicity avoids overhead. (`src/ink/line-width-cache.ts:17`)

- **Incomplete emoji keycaps**: A digit + VS16 without the enclosing keycap mark (`U+20E3`) is treated as width 1, not 2, matching terminal rendering. (`src/ink/stringWidth.ts:116–124`)

## Key Code Snippets

### Fast-Path ASCII Width Calculation

The hot path for pure-ASCII strings avoids all Unicode machinery:

```typescript
// src/ink/stringWidth.ts:26-45
let isPureAscii = true
for (let i = 0; i < str.length; i++) {
  const code = str.charCodeAt(i)
  if (code >= 127 || code === 0x1b) {
    isPureAscii = false
    break
  }
}
if (isPureAscii) {
  let width = 0
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code > 0x1f) { width++ }
  }
  return width
}
```

### Single-Pass Text Measurement

Computes width and height without `split('\n')` allocation:

```typescript
// src/ink/measure-text.ts:27-42
while (start <= text.length) {
  const end = text.indexOf('\n', start)
  const line = end === -1 ? text.substring(start) : text.substring(start, end)
  const w = lineWidth(line)
  width = Math.max(width, w)
  if (noWrap) {
    height++
  } else {
    height += w === 0 ? 1 : Math.ceil(w / maxWidth)
  }
  if (end === -1) break
  start = end + 1
}
```

### Runtime-Dispatched String Width

The module selects the fastest available implementation at load time:

```typescript
// src/ink/stringWidth.ts:213-222
const bunStringWidth =
  typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
    ? Bun.stringWidth : null

export const stringWidth: (str: string) => number = bunStringWidth
  ? str => bunStringWidth(str, BUN_STRING_WIDTH_OPTS)
  : stringWidthJavaScript
```