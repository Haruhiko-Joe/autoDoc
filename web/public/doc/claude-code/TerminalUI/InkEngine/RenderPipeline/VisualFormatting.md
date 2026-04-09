# VisualFormatting

## Overview & Responsibilities

VisualFormatting is a set of terminal visual formatting utilities within the **RenderPipeline** stage of the **InkEngine** (part of **TerminalUI**). It sits at the tail end of the render pipeline, responsible for three concerns:

1. **Color application** (`colorize.ts`) — Translates structured color specifications into ANSI escape sequences via chalk, with environment-aware level adjustments for xterm.js and tmux.
2. **Box border rendering** (`render-border.ts`) — Draws configurable box borders around DOM nodes, supporting per-side colors, dim styling, embedded text labels, and multiple border character sets.
3. **Diff optimization** (`optimizer.ts`) — Performs a single-pass compaction of the render diff (the patch list written to the terminal), eliminating no-ops, merging redundant patches, and canceling cursor hide/show pairs.

Sibling modules in the RenderPipeline include the frame type system, the renderer orchestrator, render-node-to-output traversal, the Output 2D grid, and the Screen cell buffer. VisualFormatting operates after content has been laid out and positioned, applying the final visual polish before terminal output.

## Key Processes

### Chalk Level Calibration (module load)

At import time, `colorize.ts` runs two calibration functions in strict order:

1. **`boostChalkLevelForXtermJs()`** — If `TERM_PROGRAM === 'vscode'` and chalk is at level 2 (256-color), boosts to level 3 (truecolor). This compensates for containers (code-server, Coder) that don't set `COLORTERM=truecolor`, preventing washed-out color approximations (`src/ink/colorize.ts:20-26`).

2. **`clampChalkLevelForTmux()`** — If `$TMUX` is set and chalk is above level 2, clamps back down to 256-color. tmux's default config doesn't pass truecolor sequences to the outer terminal, causing black backgrounds. Skipped if `CLAUDE_CODE_TMUX_TRUECOLOR` is set (`src/ink/colorize.ts:47-57`).

Order matters: boost runs first so that if tmux is inside VS Code, the tmux clamp wins. Both results are exported as `CHALK_BOOSTED_FOR_XTERMJS` and `CHALK_CLAMPED_FOR_TMUX` for debugging.

### Color Application Flow

`colorize(str, color, type)` dispatches on the color string format:

| Color format | Example | Dispatch |
|---|---|---|
| Named ANSI | `"ansi:red"`, `"ansi:cyanBright"` | `chalk.red()` / `chalk.bgRed()` |
| Hex | `"#d77757"` | `chalk.hex()` / `chalk.bgHex()` |
| ANSI 256 | `"ansi256(174)"` | `chalk.ansi256()` / `chalk.bgAnsi256()` |
| RGB | `"rgb(215,119,87)"` | `chalk.rgb()` / `chalk.bgRgb()` |

Each format supports both foreground and background via the `type` parameter. Unrecognized formats return the string unchanged.

### Text Style Application

`applyTextStyles(text, styles)` wraps text in chalk modifiers in a specific order to achieve correct ANSI nesting. Applied innermost-first so that chalk's wrapping produces the desired outermost-to-innermost order:

```
background > foreground > dim > bold > italic > underline > strikethrough > inverse
```

Applied in reverse: inverse → strikethrough → underline → italic → bold → dim → foreground color → background color (`src/ink/colorize.ts:176-219`).

### Border Rendering Flow

`renderBorder(x, y, node, output)` draws a box border for a DOM node:

1. Reads `node.style.borderStyle` to select the character set — either a named `cli-boxes` style (e.g., `"single"`, `"double"`, `"round"`), a custom `"dashed"` style (using `╌`/`╎` characters), or a custom `BoxStyle` object (`src/ink/render-border.ts:91-96`).

2. Resolves per-side colors and dim flags, falling back to `borderColor`/`borderDimColor` when side-specific values aren't set (`src/ink/render-border.ts:98-115`).

3. Checks `borderTop`/`borderBottom`/`borderLeft`/`borderRight` visibility flags (each defaults to visible unless explicitly `false`).

4. Constructs the top and bottom border strings from corner + repeated horizontal characters, optionally embedding text labels via `embedTextInBorder()`.

5. Constructs left and right vertical borders as newline-separated repeated characters.

6. Writes all visible border segments to the Output grid at the correct `(x, y)` positions.

### Text Embedding in Borders

`embedTextInBorder()` places a pre-rendered text string into a horizontal border line:

- **`center`**: Centers the text within the border
- **`start`**: Places text at `offset + 1` from the left (accounting for the corner character)
- **`end`**: Places text at `offset + 1` from the right

The border characters around the embedded text are rebuilt so the text replaces border segments cleanly. If the text is wider than the border minus 2, it's truncated to fit (`src/ink/render-border.ts:35-68`).

### Diff Optimization

`optimize(diff)` makes a single forward pass over the patch array, building a compacted result:

| Rule | Condition | Action |
|---|---|---|
| Skip empty stdout | `patch.content === ''` | Drop patch |
| Skip no-op cursorMove | `x === 0 && y === 0` | Drop patch |
| Skip zero-count clear | `patch.count === 0` | Drop patch |
| Merge cursorMove | Two consecutive cursorMove patches | Sum x and y components |
| Collapse cursorTo | Two consecutive cursorTo patches | Keep only the last |
| Concat styleStr | Two consecutive styleStr patches | Concatenate strings (cannot drop either — they're transition diffs, not setters) |
| Dedupe hyperlinks | Same URI in consecutive hyperlink patches | Keep only the first |
| Cancel cursor visibility | cursorHide immediately followed by cursorShow (or vice versa) | Remove both |

The function short-circuits for diffs with 0 or 1 patches (`src/ink/optimizer.ts:16-93`).

## Function Signatures

### `colorize(str, color, type): string`

Applies a single color to a string.

- **str** (`string`): The text to colorize
- **color** (`string | undefined`): Color specification — `"ansi:red"`, `"#ff0000"`, `"rgb(255,0,0)"`, `"ansi256(196)"`, or `undefined` (no-op)
- **type** (`ColorType`): `"foreground"` or `"background"`
- **Returns**: The string wrapped in ANSI color codes

> `src/ink/colorize.ts:69-169`

### `applyTextStyles(text, styles): string`

Applies a full set of text styles (bold, dim, italic, underline, strikethrough, inverse, foreground color, background color) to a string.

- **text** (`string`): The text to style
- **styles** (`TextStyles`): Style object with boolean flags and color values
- **Returns**: The styled string

> `src/ink/colorize.ts:176-220`

### `applyColor(text, color): string`

Convenience wrapper — applies a foreground color to text. Theme resolution is expected to happen at the component layer before calling this.

- **text** (`string`): The text to color
- **color** (`Color | undefined`): Color specification or undefined
- **Returns**: Colorized string

> `src/ink/colorize.ts:226-231`

### `renderBorder(x, y, node, output): void`

Draws a box border for a DOM node onto the Output grid.

- **x** (`number`): Left edge x-coordinate
- **y** (`number`): Top edge y-coordinate
- **node** (`DOMNode`): The DOM node whose `style.borderStyle`, `style.borderColor`, `style.borderText`, etc. are read
- **output** (`Output`): The 2D output grid to write border characters into

> `src/ink/render-border.ts:82-229`

### `optimize(diff): Diff`

Compacts a render diff by removing no-ops and merging consecutive compatible patches.

- **diff** (`Diff`): Array of patch objects (stdout, cursorMove, cursorTo, styleStr, hyperlink, cursorHide, cursorShow, clear)
- **Returns**: A new compacted `Diff` array

> `src/ink/optimizer.ts:16-93`

## Type Definitions

### `ColorType`

```typescript
type ColorType = 'foreground' | 'background'
```

### `BorderTextOptions`

Options for embedding text within a border line:

| Field | Type | Description |
|---|---|---|
| content | `string` | Pre-rendered string (may contain ANSI codes) |
| position | `'top' \| 'bottom'` | Which border edge to embed in |
| align | `'start' \| 'end' \| 'center'` | Horizontal alignment |
| offset | `number` (optional) | Character offset from edge (for start/end alignment) |

### `BorderStyle`

```typescript
type BorderStyle = keyof Boxes | keyof typeof CUSTOM_BORDER_STYLES | BoxStyle
```

Accepts any named `cli-boxes` style (e.g., `"single"`, `"double"`, `"round"`, `"bold"`), the custom `"dashed"` style, or a raw `BoxStyle` object with individual character definitions.

### `CUSTOM_BORDER_STYLES`

Extends `cli-boxes` with a `"dashed"` style using Unicode light-dashed box-drawing characters (`╌` horizontal, `╎` vertical). Corners are spaces because no dashed corner characters exist in Unicode.

## Edge Cases & Caveats

- **Chalk level is a global singleton.** The boost/clamp runs once at module load and affects all chalk usage across the entire application. There is no per-call level override.

- **tmux truecolor escape hatch.** Setting `CLAUDE_CODE_TMUX_TRUECOLOR` skips the tmux clamp entirely. The `bg.ts` module sets this when it configures `terminal-overrides :Tc` before tmux attach.

- **styleStr patches are transition diffs, not absolute styles.** The optimizer concatenates consecutive styleStr patches rather than dropping the first one, because each encodes a delta (e.g., "reset background" + "enable dim"). Dropping either would leak styling artifacts via BCE (Background Color Erase) (`src/ink/optimizer.ts:58-66`).

- **Border text truncation.** If embedded text is wider than the border width minus 2, it's hard-truncated via `substring`. This doesn't account for ANSI escape sequences in the content string, which could be cut mid-sequence.

- **Color format validation is lenient.** Unrecognized color strings (e.g., `"ansi:notAColor"` or malformed rgb) silently return the unstyled string rather than throwing.