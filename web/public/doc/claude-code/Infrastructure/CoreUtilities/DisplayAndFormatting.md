# Display and Formatting

## Overview & Responsibilities

This module is a collection of terminal display and text formatting utilities within the **Infrastructure → CoreUtilities** layer. Every visual element in the Claude Code CLI — from colored text and tree-shaped output to clickable hyperlinks — relies on these utilities. The module comprises seven files, each handling a distinct formatting concern:

| File | Purpose |
|------|---------|
| `theme.ts` | Color palette definitions and theme lookup |
| `systemTheme.ts` | Auto-detection of terminal dark/light mode |
| `sliceAnsi.ts` | Width-aware slicing of ANSI-escaped strings |
| `truncate.ts` | Text truncation and wrapping with ellipsis |
| `treeify.ts` | Tree structure visualization (├─└─│) |
| `cliHighlight.ts` | Lazy-loaded syntax highlighting for code blocks |
| `hyperlink.ts` | Clickable terminal hyperlinks via OSC 8 |

Sibling modules in CoreUtilities (telemetry, file utils, async patterns, etc.) consume these utilities for their own display needs, while the TerminalUI layer is the primary consumer for rendering the interactive REPL.

## Theme System

### Color Palette (`src/utils/theme.ts`)

The theme system defines a `Theme` type with **85+ named color slots** covering semantic colors (success, error, warning), diff highlighting, agent identity colors, UI element backgrounds, shimmer animation variants, and rainbow keyword highlighting.

Six concrete themes are available:

| ThemeName | Description |
|-----------|-------------|
| `dark` | Default. RGB true-color for dark terminals |
| `light` | RGB true-color for light terminals |
| `dark-ansi` | 16-color ANSI fallback for dark terminals |
| `light-ansi` | 16-color ANSI fallback for light terminals |
| `dark-daltonized` | Color-blind friendly dark theme |
| `light-daltonized` | Color-blind friendly light theme |

Users can also set the theme to `'auto'`, which resolves at runtime based on terminal background detection.

#### Key Types

- **`Theme`** — Record of color slot names to color strings (RGB or ANSI format)
- **`ThemeName`** — Union of the six concrete theme names
- **`ThemeSetting`** — `ThemeName | 'auto'`

#### Key Functions

##### `getTheme(themeName: ThemeName): Theme`

Returns the color palette object for a given theme name. Falls back to `darkTheme` for unrecognized names.

> Source: `src/utils/theme.ts:598-613`

##### `themeColorToAnsi(themeColor: string): string`

Converts an `rgb(r,g,b)` color string into an ANSI escape sequence opener. Used for integrations like `asciichart` that need raw escape codes rather than chalk-wrapped strings. Apple Terminal gets special handling — it uses 256-color mode (`Chalk({ level: 2 })`) since it doesn't handle 24-bit color well.

> Source: `src/utils/theme.ts:626-639`

### System Theme Detection (`src/utils/systemTheme.ts`)

Detects whether the terminal has a dark or light background so the `'auto'` theme setting resolves correctly. Detection is based on the **terminal's actual background color**, not the OS appearance setting — a dark terminal on a light-mode OS correctly resolves to `'dark'`.

#### Detection Flow

1. **Synchronous initial guess** — reads `$COLORFGBG` environment variable (rxvt convention, set by some terminals). Parses the background ANSI color index: 0–6 and 8 are dark, 7 and 9–15 are light (`src/utils/systemTheme.ts:109-119`).
2. **Async OSC 11 update** — a separate watcher (not in this module) queries the terminal's actual background color via the OSC 11 escape sequence. When the response arrives, it calls `setCachedSystemTheme()` to update the cache.
3. **OSC color parsing** — `themeFromOscColor()` parses XParseColor formats (`rgb:R/G/B`, `#RRGGBB`, `#RRRRGGGGBBBB`) and computes ITU-R BT.709 relative luminance. Luminance > 0.5 → `'light'`, otherwise `'dark'` (`src/utils/systemTheme.ts:60-66`).

#### Key Functions

##### `getSystemThemeName(): SystemTheme`

Returns `'dark'` or `'light'`. Uses the cached value if available, otherwise falls back to `$COLORFGBG` detection, defaulting to `'dark'`.

##### `resolveThemeSetting(setting: ThemeSetting): ThemeName`

Converts a `ThemeSetting` to a concrete `ThemeName`. If `setting` is `'auto'`, delegates to `getSystemThemeName()`; otherwise returns the setting as-is.

##### `themeFromOscColor(data: string): SystemTheme | undefined`

Parses an OSC 10/11 color response string and returns the detected theme. Returns `undefined` for unrecognized formats.

## ANSI String Slicing (`src/utils/sliceAnsi.ts`)

Slices a string containing ANSI escape codes by **display width** (terminal columns), not by code unit index. This is critical for correctly truncating styled text in the terminal.

### `sliceAnsi(str: string, start: number, end?: number): string`

The function tokenizes the input using `@alcalzone/ansi-tokenize`, which correctly handles OSC 8 hyperlink sequences (unlike the `slice-ansi` npm package). Key behaviors:

1. **Display-width tracking** — position advances by `stringWidth()` for text tokens and by `2` for full-width characters (CJK), not by `.length`. This ensures CJK characters and emoji are measured correctly (`src/utils/sliceAnsi.ts:44-46`).
2. **Combining mark handling** — zero-width combining marks (Devanagari matras, diacritics, ZWJ) attach to their preceding base character. The slicer includes trailing zero-width marks even after `end` is reached to avoid splitting a grapheme cluster (`src/utils/sliceAnsi.ts:48-57`).
3. **ANSI code bookkeeping** — tracks active ANSI codes. When the slice region begins, it replays all currently-active start codes so colors carry into the sliced result. At the end, it emits undo codes to properly close all open escape sequences (`src/utils/sliceAnsi.ts:74-76`, `88-89`).
4. **Leading zero-width skip** — at `start > 0`, leading zero-width marks are skipped because they belong to the preceding base character in the left half (`src/utils/sliceAnsi.ts:69-72`).

## Text Truncation (`src/utils/truncate.ts`)

Width-aware truncation utilities that correctly handle CJK, emoji, and surrogate pairs by splitting on grapheme boundaries via `Intl.Segmenter`.

### Functions

##### `truncate(str: string, maxWidth: number, singleLine?: boolean): string`

General-purpose truncation. Appends `'…'` when text exceeds `maxWidth`. When `singleLine` is `true`, also truncates at the first newline character.

> Source: `src/utils/truncate.ts:134-158`

##### `truncatePathMiddle(path: string, maxLength: number): string`

Path-specific middle-truncation preserving both directory context and filename. Output format: `src/components/…/MyComponent.tsx`. Splits at the last `/` to isolate the filename, allocates remaining width to the directory prefix, and joins with `'…'`.

> Source: `src/utils/truncate.ts:16-56`

##### `truncateToWidth(text: string, maxWidth: number): string`

Truncates from the end, appending `'…'`. Grapheme-safe.

##### `truncateStartToWidth(text: string, maxWidth: number): string`

Truncates from the start, prepending `'…'`. Keeps the tail end. Useful for paths where the filename matters more than the directory.

##### `truncateToWidthNoEllipsis(text: string, maxWidth: number): string`

Truncates without adding an ellipsis character. Used internally by `truncatePathMiddle` where the caller provides its own `'…'` separator.

##### `wrapText(text: string, width: number): string[]`

Wraps text into lines of at most `width` terminal columns. Returns an array of line strings, splitting on grapheme boundaries.

> Source: `src/utils/truncate.ts:160-179`

## Tree Visualization (`src/utils/treeify.ts`)

Renders JavaScript objects as ASCII tree structures using Unicode box-drawing characters (├, └, │) from the `figures` package.

### `treeify(obj: TreeNode, options?: TreeifyOptions): string`

Converts a nested `TreeNode` object into a formatted tree string.

```typescript
type TreeNode = { [key: string]: TreeNode | string | undefined }
```

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `showValues` | `boolean` | `true` | Whether to display leaf values |
| `hideFunctions` | `boolean` | `false` | Whether to exclude function-typed values |
| `themeName` | `ThemeName` | `'dark'` | Theme for colorization |
| `treeCharColors` | `object` | `{}` | Color keys for tree chars, property names, and values |

Key behaviors:
- **Circular reference protection** — uses a `WeakSet` to detect and display `[Circular]` for already-visited objects (`src/utils/treeify.ts:75-79`)
- **Theme integration** — colorizes tree characters, keys, and values using the theme's color function
- **Array handling** — arrays are displayed as `[Array(N)]` rather than recursed into (`src/utils/treeify.ts:124-131`)

> Source: `src/utils/treeify.ts:39-170`

## CLI Syntax Highlighting (`src/utils/cliHighlight.ts`)

Provides lazy-loaded syntax highlighting for code blocks displayed in the terminal. Wraps the `cli-highlight` package (which uses `highlight.js` under the hood) with a singleton lazy-loading pattern.

### `getCliHighlightPromise(): Promise<CliHighlight | null>`

Returns a shared promise that resolves to `{ highlight, supportsLanguage }` from the `cli-highlight` package, or `null` if the import fails. The promise is created once and cached — subsequent calls return the same instance (`src/utils/cliHighlight.ts:38-41`).

The import is intentionally lazy: `cli-highlight` and `highlight.js` are large dependencies, and deferring the load avoids slowing down CLI startup.

### `getLanguageName(file_path: string): Promise<string>`

Maps a file path to a human-readable language name (e.g., `"foo/bar.ts"` → `"TypeScript"`). Extracts the file extension, then queries highlight.js's language registry. Returns `'unknown'` if the extension isn't recognized. Used for telemetry attributes, not for blocking UI operations.

> Source: `src/utils/cliHighlight.ts:49-54`

## Terminal Hyperlinks (`src/utils/hyperlink.ts`)

Generates clickable hyperlinks in terminals that support the OSC 8 escape sequence standard.

### `createHyperlink(url: string, content?: string, options?: HyperlinkOptions): string`

Creates a clickable hyperlink using the OSC 8 protocol:

```
\e]8;;URL\x07  DISPLAY_TEXT  \e]8;;\x07
```

- If the terminal supports hyperlinks, wraps the display text (or URL if no content provided) in OSC 8 sequences with blue ANSI coloring via chalk
- If hyperlinks are not supported, returns the plain URL (ignoring `content`)
- Uses `\x07` (BEL) as the OSC terminator for broader terminal compatibility

> Source: `src/utils/hyperlink.ts:24-39`

**Constants:**
- `OSC8_START` = `'\x1b]8;;'` — opening escape sequence
- `OSC8_END` = `'\x07'` — BEL terminator

## Edge Cases & Caveats

- **Apple Terminal special handling** — `themeColorToAnsi()` downgrades to 256-color mode because Apple Terminal mishandles 24-bit color escapes (`src/utils/theme.ts:617-619`)
- **ANSI themes exist for compatibility** — the `dark-ansi` and `light-ansi` themes use only the 16 standard ANSI colors for terminals without true-color support
- **`$COLORFGBG` is best-effort** — only set by some terminals (rxvt-family, Konsole, iTerm2 with the option enabled). The default fallback is `'dark'` when no detection method succeeds
- **`sliceAnsi` tracks display width, not string length** — callers must pass `start`/`end` in display columns (as measured by `stringWidth()`), not character indices
- **Truncation is grapheme-safe** — all truncation functions use `Intl.Segmenter` to avoid splitting emoji, surrogate pairs, or combining character sequences
- **`cli-highlight` import can fail** — the lazy loader returns `null` on import failure, and callers must handle this gracefully
- **RGB colors break with OSC 8 + wrap-ansi** — hyperlink text uses basic ANSI blue instead of theme RGB colors because `wrap-ansi` doesn't preserve RGB colors across line breaks when combined with OSC 8 sequences (`src/utils/hyperlink.ts:35`)