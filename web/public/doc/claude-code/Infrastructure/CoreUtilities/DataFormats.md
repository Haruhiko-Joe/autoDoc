# DataFormats

## Overview & Responsibilities

The DataFormats module is a collection of data format parsing and serialization utilities within the **Infrastructure > CoreUtilities** layer. Every other module in the system depends on these utilities whenever it needs to read, write, or transform structured data — from configuration files (JSON, YAML) to user-facing content (Markdown, PDF, Jupyter notebooks) to instruction files (CLAUDE.md).

The module spans eight source files, each handling a distinct format:

| File | Format | Primary Role |
|------|--------|-------------|
| `json.ts` | JSON / JSONL / JSONC | Parse, cache, stream, and modify JSON data |
| `jsonRead.ts` | BOM stripping | Leaf utility to strip UTF-8 BOM from strings |
| `yaml.ts` | YAML | Parse YAML with Bun-native or npm fallback |
| `xml.ts` | XML | Escape strings for safe XML/HTML interpolation |
| `markdown.ts` | Markdown | Render Markdown tokens to styled terminal output |
| `pdf.ts` | PDF | Read PDFs as base64, extract pages as JPEG images |
| `pdfUtils.ts` | PDF utilities | Page-range parsing and model compatibility checks |
| `notebook.ts` | Jupyter `.ipynb` | Read and process notebook cells into tool results |
| `claudemd.ts` | CLAUDE.md | Parse instruction files with `@include` directives, frontmatter, and multi-source hierarchy |

## Key Processes

### JSON Parsing with LRU Cache

The primary JSON entry point is `safeParseJSON` (`src/utils/json.ts:45-58`). It wraps `JSON.parse` with:

1. **Null/empty guard** — returns `null` for falsy input
2. **BOM stripping** — calls `stripBOM()` to handle PowerShell-generated UTF-8 files
3. **LRU-bounded memoization** — inputs under 8 KB are cached (50-slot LRU) to avoid re-parsing frequently-read config files. Inputs above 8 KB bypass the cache to prevent pinning large strings in memory
4. **Error suppression** — parse failures return `null` and optionally log the error. Both successes and failures are cached via a discriminated union wrapper (`CachedParse`)

JSONC parsing (`safeParseJSONC`) uses `jsonc-parser` to handle VS Code-style configuration files with comments.

### JSONL Streaming Parse

JSONL (newline-delimited JSON) parsing (`src/utils/json.ts:182-190`) uses a three-tier strategy:

1. **Bun.JSONL.parseChunk** — when running under Bun, uses the native JSONL parser for best performance. Handles mid-stream errors by skipping to the next newline and resuming
2. **Buffer path** (`parseJSONLBuffer`) — for Node.js Buffer inputs, scans for `0x0a` bytes and parses line-by-line
3. **String path** (`parseJSONLString`) — for string inputs, uses `indexOf('\n')` scanning

`readJSONLFile` reads JSONL files up to 100 MB. For files exceeding that limit, it reads only the **tail** (last 100 MB) using a file descriptor with offset, then skips the first partial line (`src/utils/json.ts:201-226`).

### JSONC Array Modification

`addItemToJSONCArray` (`src/utils/json.ts:228-277`) appends items to JSONC arrays while **preserving comments and formatting**. It uses `jsonc-parser`'s `modify()` and `applyEdits()` to generate minimal edits rather than re-serializing the entire document.

### YAML Parsing

`parseYaml` (`src/utils/yaml.ts:9-15`) uses a dual-backend strategy:
- Under **Bun**: uses `Bun.YAML.parse` (built-in, zero-cost)
- Under **Node.js**: lazy-requires the `yaml` npm package (~270 KB) only when needed

### XML Escaping

Two escape functions (`src/utils/xml.ts:6-16`):
- `escapeXml(s)` — escapes `&`, `<`, `>` for element text content
- `escapeXmlAttr(s)` — additionally escapes `"` and `'` for attribute values

### Markdown Terminal Rendering

`applyMarkdown` (`src/utils/markdown.ts:36-47`) converts Markdown content into ANSI-styled terminal output:

1. Strips prompt XML tags from the content
2. Lexes using `marked` (with strikethrough disabled — the model often uses `~` for "approximate")
3. Recursively formats each token via `formatToken()`, which handles: headings (bold/italic/underline), code blocks (syntax highlighting via `CliHighlight`), inline code (themed color), blockquotes (dim vertical bar prefix), links (OSC 8 hyperlinks when supported), tables (auto-width columns with alignment), and nested lists (numeric, alphabetic, roman numeral numbering by depth)

GitHub issue references (`owner/repo#123`) are automatically linkified into clickable hyperlinks (`src/utils/markdown.ts:289-308`).

### PDF Reading and Page Extraction

**Direct PDF reading** (`readPDF` in `src/utils/pdf.ts:34-113`):
1. Validates the file is non-empty and under the size limit (`PDF_TARGET_RAW_SIZE`, ~20 MB to leave room after base64 encoding within the 32 MB API limit)
2. Checks for `%PDF-` magic bytes to reject non-PDF files early — invalid PDF document blocks in conversation history cause unrecoverable 400 errors
3. Returns the file as base64-encoded data

**Page extraction** (`extractPDFPages` in `src/utils/pdf.ts:179-300`):
1. Checks `pdftoppm` availability (from poppler-utils), caching the result
2. Runs `pdftoppm -jpeg -r 100` to convert pages to JPEG images at 100 DPI
3. Supports optional page ranges via `-f` (first) and `-l` (last) flags
4. Detects password-protected and corrupted PDFs from stderr output
5. Returns the output directory path and page count

**Page range parsing** (`parsePDFPageRange` in `src/utils/pdfUtils.ts:16-50`) supports three formats:
- `"5"` → single page
- `"1-10"` → closed range
- `"3-"` → open-ended range (from page 3 to end)

### Jupyter Notebook Reading

`readNotebook` (`src/utils/notebook.ts:164-183`) parses `.ipynb` files:

1. Reads and JSON-parses the notebook file
2. Extracts the kernel language from metadata (defaults to Python)
3. Processes each cell — joining multi-line source arrays, handling execution counts
4. For code cells with outputs, processes four output types: `stream`, `execute_result`, `display_data`, and `error`
5. Extracts embedded images (PNG/JPEG) from `display_data` outputs
6. Large outputs (>10,000 chars) are replaced with a hint to use `cat | jq` to inspect them directly
7. Supports reading a single cell by ID via the `cellId` parameter

`mapNotebookCellsToToolResult` (`src/utils/notebook.ts:188-215`) converts processed cells into Anthropic API `ToolResultBlockParam` format, merging adjacent text blocks for efficiency. Each cell is wrapped in XML-style `<cell>` tags with metadata.

### CLAUDE.md Parsing and Loading

The most complex subsystem. `getMemoryFiles` (`src/utils/claudemd.ts:790+`) loads instruction files from a **four-tier hierarchy** with ascending priority:

1. **Managed** (`/etc/claude-code/CLAUDE.md`) — global admin-controlled instructions
2. **User** (`~/.claude/CLAUDE.md`) — personal global instructions
3. **Project** (`CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`) — checked into the repo
4. **Local** (`CLAUDE.local.md`) — private project-specific overrides

Project and Local files are discovered by walking from CWD upward to the filesystem root. Files closer to CWD have higher priority (loaded later so the model pays more attention).

**@include directive resolution** (`src/utils/claudemd.ts:451-535`):
- Syntax: `@path`, `@./relative`, `@~/home`, `@/absolute`
- Extracted from Markdown text nodes only (not inside code blocks/spans)
- Supports escaped spaces (`@path\ with\ spaces`)
- Strips fragment identifiers (`@file.md#section`)
- Recursively resolves includes up to `MAX_INCLUDE_DEPTH` (5 levels)
- Circular references are prevented via a `processedPaths` set

**Frontmatter support** (`parseFrontmatterPaths` at `src/utils/claudemd.ts:254-279`):
- Parses YAML frontmatter with a `paths` field containing glob patterns
- Rules with `paths` become conditional — they only apply when the active file matches the glob
- Patterns like `**` (match-all) are treated as unconditional

**HTML comment stripping** (`stripHtmlComments` at `src/utils/claudemd.ts:292-334`):
- Uses the `marked` lexer to identify block-level HTML comments only
- Preserves comments inside code blocks and inline code
- Leaves unclosed comments intact to prevent silent content loss

**Additional features**:
- `claudeMdExcludes` setting support — picomatch-based path exclusion with symlink resolution
- Worktree deduplication — when running in a nested git worktree, skips duplicate Project files from the main repo
- External include gating — `@include` paths outside CWD require explicit user approval
- Content diffing — tracks when loaded content differs from disk (due to frontmatter stripping, comment removal, or truncation)

## Function Signatures

### JSON (`src/utils/json.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `safeParseJSON` | `(json: string \| null \| undefined, shouldLogError?: boolean) => unknown` | LRU-cached JSON parse, returns `null` on failure |
| `safeParseJSONC` | `(json: string \| null \| undefined) => unknown` | Parse JSON with comments (JSONC) |
| `parseJSONL<T>` | `(data: string \| Buffer) => T[]` | Parse newline-delimited JSON, skipping malformed lines |
| `readJSONLFile<T>` | `(filePath: string) => Promise<T[]>` | Read JSONL file (tail-reads files >100 MB) |
| `addItemToJSONCArray` | `(content: string, newItem: unknown) => string` | Append to JSONC array preserving comments |

### PDF (`src/utils/pdf.ts`, `src/utils/pdfUtils.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `readPDF` | `(filePath: string) => Promise<PDFResult<...>>` | Read PDF as base64 with validation |
| `getPDFPageCount` | `(filePath: string) => Promise<number \| null>` | Get page count via `pdfinfo` |
| `extractPDFPages` | `(filePath: string, options?) => Promise<PDFResult<PDFExtractPagesResult>>` | Convert pages to JPEG images |
| `parsePDFPageRange` | `(pages: string) => { firstPage, lastPage } \| null` | Parse `"1-10"` style range strings |
| `isPDFSupported` | `() => boolean` | Check if current model supports PDF document blocks |

### Notebook (`src/utils/notebook.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `readNotebook` | `(notebookPath: string, cellId?: string) => Promise<NotebookCellSource[]>` | Parse `.ipynb` into processed cells |
| `mapNotebookCellsToToolResult` | `(data: NotebookCellSource[], toolUseID: string) => ToolResultBlockParam` | Convert cells to API tool result format |
| `parseCellId` | `(cellId: string) => number \| undefined` | Extract numeric index from `"cell-N"` IDs |

### CLAUDE.md (`src/utils/claudemd.ts`)

| Function | Signature | Description |
|----------|-----------|-------------|
| `getMemoryFiles` | `(forceIncludeExternal?: boolean) => Promise<MemoryFileInfo[]>` | Load all instruction files (memoized) |
| `processMemoryFile` | `(filePath, type, processedPaths, includeExternal, depth?, parent?) => Promise<MemoryFileInfo[]>` | Recursively process a single file with `@include` resolution |
| `processMdRules` | `({rulesDir, type, ...}) => Promise<MemoryFileInfo[]>` | Process all `.md` files in a rules directory |
| `stripHtmlComments` | `(content: string) => { content: string; stripped: boolean }` | Remove block-level HTML comments from Markdown |

## Type Definitions

### `PDFError` / `PDFResult<T>` (`src/utils/pdf.ts:14-27`)

```typescript
type PDFError = {
  reason: 'empty' | 'too_large' | 'password_protected' | 'corrupted' | 'unknown' | 'unavailable'
  message: string
}
type PDFResult<T> = { success: true; data: T } | { success: false; error: PDFError }
```

A discriminated union for all PDF operations — callers pattern-match on `success` to handle errors structurally.

### `MemoryFileInfo` (`src/utils/claudemd.ts:229-243`)

```typescript
type MemoryFileInfo = {
  path: string              // Absolute file path
  type: MemoryType          // 'Managed' | 'User' | 'Project' | 'Local' | 'AutoMem' | 'TeamMem'
  content: string           // Processed content (frontmatter/comments stripped)
  parent?: string           // Path of the file that @included this one
  globs?: string[]          // Frontmatter path patterns (conditional rules)
  contentDiffersFromDisk?: boolean  // True when content was transformed
  rawContent?: string       // Original disk content when transformed
}
```

## Configuration & Defaults

| Constant | Location | Value | Purpose |
|----------|----------|-------|---------|
| `PARSE_CACHE_MAX_KEY_BYTES` | `json.ts:29` | 8 KB | Max input size for LRU parse cache |
| LRU cache size | `json.ts:42` | 50 entries | Bounded memoization for `safeParseJSON` |
| `MAX_JSONL_READ_BYTES` | `json.ts:192` | 100 MB | Max tail-read size for JSONL files |
| `LARGE_OUTPUT_THRESHOLD` | `notebook.ts:20` | 10,000 chars | Threshold to elide large notebook outputs |
| `MAX_INCLUDE_DEPTH` | `claudemd.ts:537` | 5 | Maximum `@include` recursion depth |
| `MAX_MEMORY_CHARACTER_COUNT` | `claudemd.ts:93` | 40,000 | Recommended max size for a memory file |
| `TEXT_FILE_EXTENSIONS` | `claudemd.ts:96-227` | ~80 extensions | Allowlist for `@include` (prevents binary files) |

**External dependencies**:
- PDF page extraction requires **poppler-utils** (`pdftoppm`, `pdfinfo`) installed on the system
- `isPDFSupported()` returns `false` for Claude 3 Haiku (the only model predating PDF support)

## Edge Cases & Caveats

- **BOM handling**: `stripBOM` is applied pervasively because PowerShell 5.x writes UTF-8 with BOM by default. Without stripping, `JSON.parse` fails with "Unexpected token"
- **JSONL tail reading**: For files >100 MB, the first partial line after seeking is discarded. This is safe because the 100 MB cap far exceeds the longest conversation context (~2M tokens)
- **PDF magic byte validation**: Files without `%PDF-` header are rejected early. An invalid PDF document block in conversation history causes every subsequent API call to fail with 400, making the session unrecoverable without `/clear`
- **Notebook large outputs**: Cell outputs exceeding 10,000 characters are replaced with a `jq` command hint rather than being included inline, preventing context window bloat
- **CLAUDE.md worktree dedup**: When running from a git worktree nested inside its main repo, checked-in Project files from the main repo are skipped to avoid double-loading identical content
- **@include security**: Included files outside the working directory require explicit user approval (`hasClaudeMdExternalIncludesApproved`). Binary files are blocked by the `TEXT_FILE_EXTENSIONS` allowlist
- **Markdown strikethrough disabled**: The `marked` tokenizer's `del` rule is overridden to return `undefined` because the model frequently uses `~` for "approximate" (e.g., `~100`), not strikethrough