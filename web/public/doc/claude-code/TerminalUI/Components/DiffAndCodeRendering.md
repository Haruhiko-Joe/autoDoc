# Diff and Code Rendering

## Overview & Responsibilities

This module provides the rich content rendering components for displaying code, diffs, and markdown within the Claude Code terminal UI. It sits within the **Components** layer of the **TerminalUI** subsystem, and is consumed by message display, tool result views, and the diff dialog.

The module covers three rendering domains:

1. **Syntax-highlighted code blocks** — `HighlightedCode` with native NAPI coloring and a pure-JS fallback
2. **Structured diff visualization** — `StructuredDiff`, `StructuredDiffList`, `FileEditToolDiff`, and the full `DiffDialog` with file list and detail views
3. **Markdown rendering** — `Markdown` and `StreamingMarkdown` for assistant output, plus `MarkdownTable` for tabular data
4. **Interactive content references** — `FilePathLink` and `ClickableImageRef` for clickable file/image links

Sibling component groups in the Components layer include message display, dialog system, design system primitives, and status indicators.

## Key Processes

### Syntax Highlighting Pipeline

The syntax highlighting system uses a two-tier strategy:

1. **Native path (preferred)**: `HighlightedCode` checks whether the `color-diff-napi` module is available via `expectColorFile()` (`src/components/StructuredDiff/colorDiff.ts:29-31`). If available and not disabled by `CLAUDE_CODE_SYNTAX_HIGHLIGHT` env var, it creates a `ColorFile` instance with the code and file path, then calls `colorFile.render(theme, width, dim)` to produce pre-colored ANSI lines.
2. **Fallback path**: When native coloring is unavailable, `HighlightedCodeFallback` (`src/components/HighlightedCode/Fallback.tsx:39`) renders using a pure-JS approach.

In fullscreen mode, line numbers are displayed via a gutter column — each line is split into a non-selectable gutter (`NoSelect`) and content portion using `sliceAnsi` (`src/components/HighlightedCode.tsx:137-189`).

Width is either passed as a prop or auto-measured from the DOM element via `measureElement`.

### Diff Rendering Pipeline

`StructuredDiff` (`src/components/StructuredDiff.tsx:95`) is the core diff component that renders a single hunk:

1. **Native rendering**: Calls `renderColorDiff()` which uses `ColorDiff` from `color-diff-napi` to produce syntax-highlighted diff output. Results are cached in a `WeakMap` keyed by hunk identity, with a compound cache key including theme, width, dim state, and file path (`src/components/StructuredDiff.tsx:41-94`). The cache is capped at 4 entries per hunk to handle terminal resizing.
2. **Gutter splitting**: In fullscreen mode, pre-splits each line into gutter (line numbers + markers) and content columns using `sliceAnsi`, rendering the gutter as `NoSelect` and content as `RawAnsi` — this replaces N per-line components with just two column nodes.
3. **Fallback**: When native coloring fails, delegates to `StructuredDiffFallback` (`src/components/StructuredDiff/Fallback.tsx:81`) which implements word-level diff highlighting purely in JS.

`StructuredDiffList` (`src/components/StructuredDiffList.tsx:16-29`) renders multiple hunks separated by dimmed ellipsis (`...`) markers using the `intersperse` utility.

### Word-Level Diff Algorithm (Fallback)

The fallback diff renderer (`src/components/StructuredDiff/Fallback.tsx`) implements a multi-step word-level diff:

1. **Line classification**: `transformLinesToObjects()` parses each diff line's `+`/`-`/` ` prefix into typed `LineObject` entries (add/remove/nochange)
2. **Adjacent pairing**: `processAdjacentLines()` groups consecutive remove+add line sequences and pairs them for word-level comparison
3. **Word diffing**: `calculateWordDiffs()` uses `diffWordsWithSpace` from the `diff` library to find specific changed words within paired lines
4. **Threshold check**: A `CHANGE_THRESHOLD` of 0.4 determines whether to show word-level highlighting or treat the entire line as changed — preventing noisy diffs when most of the line changed
5. **Rendering**: Changed words get darker red/green backgrounds; unchanged portions render normally with standard add/remove line coloring

### Markdown Rendering

`Markdown` (`src/components/Markdown.tsx:78`) uses a hybrid rendering approach:

1. **Fast-path detection**: `hasMarkdownSyntax()` checks the first 500 characters for markdown markers. Plain text skips the full parser entirely, constructing a single paragraph token inline.
2. **Token caching**: `cachedLexer()` maintains an LRU cache (max 500 entries) of parsed token arrays keyed by content hash. This avoids re-parsing on virtual scroll remounts (~3ms savings per message).
3. **Parsing**: Uses `marked.lexer()` for GFM markdown tokenization, with XML prompt tags stripped beforehand.
4. **Rendering split**: Table tokens are rendered as React components (`MarkdownTable`), while all other tokens are formatted to ANSI strings via `formatToken()` and rendered through `<Ansi>`.
5. **Syntax highlighting**: Loads asynchronously via `Suspense` — when highlighting is unavailable or loading, falls back to unhighlighted output.

`StreamingMarkdown` (`src/components/Markdown.tsx:186`) optimizes for streaming by splitting content at the last stable block boundary — only the final (in-progress) block is re-parsed per delta, while preceding stable content is memoized.

### MarkdownTable Rendering

`MarkdownTable` (`src/components/MarkdownTable.tsx:72`) handles terminal-width-aware table layout:

1. Calculates minimum column widths (longest word) and ideal widths (full content)
2. Distributes available space proportionally across columns, accounting for border overhead and a safety margin
3. Wraps cell content using ANSI-aware `wrapText()`, supporting hard wrapping when columns are narrower than the longest word
4. Switches to vertical (key-value) format when wrapped rows exceed `MAX_ROW_LINES` (4 lines)

### FileEditToolDiff

`FileEditToolDiff` (`src/components/FileEditToolDiff.tsx:23`) renders inline edit previews for the file edit tool:

1. Starts a `Suspense`-wrapped async load via `loadDiffData()`
2. **Chunked file reading**: For single edits, uses `scanForContext()` to read only the relevant file region (avoiding full file reads for large files). Falls back to full-file read for multi-edit or empty old_string cases.
3. **Large file bypass**: If `old_string >= CHUNK_SIZE`, skips file reading entirely and diffs the tool inputs directly
4. **Edit normalization**: `normalizeEdit()` calls `findActualString()` and `preserveQuoteStyle()` to handle whitespace/quote variations between the edit request and actual file content
5. Renders the resulting hunks via `StructuredDiffList` inside a dashed-border frame

### Diff Dialog

The `DiffDialog` (`src/components/diff/DiffDialog.tsx:55`) is a full-screen dialog for browsing file changes:

1. **Data sources**: Supports switching between the current git diff (`useDiffData()`) and per-turn diffs (`useTurnDiffs(messages)`), navigable with left/right arrows
2. **Two view modes**: `list` (file list via `DiffFileList`) and `detail` (single file diff via `DiffDetailView`), toggled with Enter/Escape
3. **DiffFileList** (`src/components/diff/DiffFileList.tsx:14`): Paginated file list with selection indicator, truncated paths, and per-file stats (+N/-N with color coding). Shows max 5 files with scroll indicators.
4. **DiffDetailView** (`src/components/diff/DiffDetailView.tsx:25`): Renders all hunks for a selected file using `StructuredDiff`. Handles edge cases — binary files, large files (>1MB), untracked files, and truncated diffs — with appropriate placeholder messages.

## Function Signatures & Parameters

### `HighlightedCode`

```typescript
HighlightedCode({ code, filePath, width?, dim? }: Props): React.ReactNode
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| code | string | — | Source code to highlight |
| filePath | string | — | File path for language detection |
| width | number | 80 | Render width; auto-measured if omitted |
| dim | boolean | false | Render all text dimmed |

> Memoized via `React.memo`. Source: `src/components/HighlightedCode.tsx:18`

### `StructuredDiff`

```typescript
StructuredDiff({ patch, dim, filePath, firstLine, fileContent?, width, skipHighlighting? }: Props): React.ReactNode
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| patch | StructuredPatchHunk | — | Diff hunk to render |
| dim | boolean | — | Dim all text |
| filePath | string | — | File path for language detection |
| firstLine | string \| null | — | First line of file for shebang detection |
| fileContent | string | undefined | Full file content for syntax context |
| width | number | — | Render width |
| skipHighlighting | boolean | false | Force fallback rendering |

> Memoized via `React.memo`. Source: `src/components/StructuredDiff.tsx:95`

### `StructuredDiffList`

```typescript
StructuredDiffList({ hunks, dim, width, filePath, firstLine, fileContent? }: Props): React.ReactNode
```

Renders multiple hunks with ellipsis separators. Source: `src/components/StructuredDiffList.tsx:16`

### `Markdown` / `StreamingMarkdown`

```typescript
Markdown({ children, dimColor? }: Props): React.ReactNode
StreamingMarkdown({ children }: StreamingProps): React.ReactNode
```

`children` is raw markdown string content. `Markdown` is for complete content; `StreamingMarkdown` optimizes for incremental rendering during response streaming. Source: `src/components/Markdown.tsx:78, 186`

### `MarkdownTable`

```typescript
MarkdownTable({ token, highlight, forceWidth? }: Props): React.ReactNode
```

Renders a `Tokens.Table` from the `marked` lexer with terminal-aware column sizing. Source: `src/components/MarkdownTable.tsx:72`

### `FileEditToolDiff`

```typescript
FileEditToolDiff({ file_path, edits }: Props): React.ReactNode
```

Renders an inline diff preview for file edit tool operations. `edits` is an array of `FileEdit` objects with `old_string`/`new_string` pairs. Source: `src/components/FileEditToolDiff.tsx:23`

### `FilePathLink`

```typescript
FilePathLink({ filePath, children? }: Props): React.ReactNode
```

Renders a file path as an OSC 8 terminal hyperlink using `pathToFileURL()`. Falls back to displaying the raw path. Source: `src/components/FilePathLink.tsx:17`

### `ClickableImageRef`

```typescript
ClickableImageRef({ imageId, backgroundColor?, isSelected? }: Props): React.ReactNode
```

Renders `[Image #N]` as a clickable link that opens the stored image file. Falls back to styled text when the terminal doesn't support hyperlinks or the image isn't found. Source: `src/components/ClickableImageRef.tsx:23`

## Configuration & Defaults

| Setting | Source | Default | Effect |
|---------|--------|---------|--------|
| `CLAUDE_CODE_SYNTAX_HIGHLIGHT` | Env var | enabled | Set to falsy value to disable native syntax highlighting |
| `syntaxHighlightingDisabled` | User settings | false | Disables syntax highlighting in both code blocks and diffs |
| Fullscreen mode | `isFullscreenEnvEnabled()` | — | Enables line number gutters in code and diff views |
| `TOKEN_CACHE_MAX` | Hardcoded | 500 | Maximum cached markdown parse results |
| `CHANGE_THRESHOLD` | Hardcoded | 0.4 | Word-diff fallback: ratio above which the entire line is treated as changed |
| `MAX_VISIBLE_FILES` | Hardcoded | 5 | Maximum files shown at once in diff file list |
| `MAX_ROW_LINES` | Hardcoded | 4 | Table rows taller than this trigger vertical format |
| `SAFETY_MARGIN` | Hardcoded | 4 | Extra width buffer for table layout to prevent flicker |

## Edge Cases & Caveats

- **Narrow terminals**: When the gutter width would consume the entire render width, `StructuredDiff` skips the gutter split and renders as a single column to avoid empty content regions (`src/components/StructuredDiff.tsx:54-60`).
- **Render cache limits**: The diff render cache (`RENDER_CACHE`) caps at 4 entries per hunk and clears on overflow — rapid terminal resizing can trigger cache churn.
- **Token cache LRU**: The markdown token cache uses a poor-man's LRU via `Map` insertion-order semantics. Cache hits are promoted by delete-then-reinsert (`src/components/Markdown.tsx:57-61`).
- **Streaming boundary reset**: `StreamingMarkdown` tracks a stable prefix boundary that only advances monotonically. When XML tag stripping causes content to shrink, the boundary resets via a `startsWith` check.
- **Large file edits**: `FileEditToolDiff` skips file reading entirely when `old_string >= CHUNK_SIZE`, diffing only the tool inputs. This avoids O(needle) memory allocation for sed-style whole-file edits.
- **Binary and large files**: `DiffDetailView` renders placeholder messages for binary files and files exceeding the 1MB diff limit, rather than attempting to render the diff.
- **Hyperlink fallback**: Both `FilePathLink` and `ClickableImageRef` gracefully degrade when the terminal doesn't support OSC 8 hyperlinks — `ClickableImageRef` checks via `supportsHyperlinks()` and shows styled but non-clickable text.
- **React Compiler opt-out**: `StreamingMarkdown` uses `'use no memo'` because its ref-mutation-during-render pattern (monotonic boundary advancement) is safe but unprovable by the React Compiler.