# FileOperationTools

## Overview & Responsibilities

The FileOperationTools module is a suite of six tools that give Claude the ability to interact with the local file system. Sitting within the **ToolSystem** layer of the architecture, these tools are invoked by the **QueryEngine** whenever Claude's response includes a file-operation tool call. Together they cover the full lifecycle of file interaction: discovering files (Glob), searching content (Grep), reading files of any type (Read), making surgical edits (Edit), overwriting/creating files (Write), and editing Jupyter notebook cells (NotebookEdit).

Each tool follows a shared contract defined by `buildTool()` from `src/Tool.ts`, providing standardized input/output schemas (Zod v4), permission checks, input validation, execution logic, and UI rendering hooks.

### Sibling context

These tools sit alongside other ToolSystem tools like BashTool, AgentTool, and WebFetchTool. They share the Infrastructure layer's permission system (`checkReadPermissionForTool` / `checkWritePermissionForTool`) and file utilities.

---

## Tool-by-Tool Breakdown

### 1. FileReadTool (`Read`)

**Source**: `src/tools/FileReadTool/FileReadTool.ts`

The most complex of the six tools, FileReadTool handles reading **text files, images, PDFs, and Jupyter notebooks** through a single entry point.

#### Input Schema

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string (required) | Absolute path to the file |
| `offset` | number (optional) | Line number to start reading from (1-indexed) |
| `limit` | number (optional) | Number of lines to read |
| `pages` | string (optional) | PDF page range (e.g., `"1-5"`) |

#### Output Types (Discriminated Union)

The output is a discriminated union on `type`:

- **`text`** — Line-numbered file content with `numLines`, `startLine`, `totalLines`
- **`image`** — Base64-encoded image data with MIME type and dimension metadata
- **`notebook`** — Array of parsed notebook cells
- **`pdf`** — Base64-encoded PDF document
- **`parts`** — Extracted PDF page images (for large PDFs or unsupported models)
- **`file_unchanged`** — Deduplication stub when the file hasn't changed since last read

#### Key Process: File Read Flow

1. **Path expansion & validation** — Expands `~` paths via `expandPath()`, checks deny rules, blocks binary extensions (except images/PDFs), blocks dangerous device paths (`/dev/zero`, `/dev/stdin`, etc.)
2. **Deduplication check** — If the same file+range was already read and `mtime` hasn't changed, returns a `file_unchanged` stub to save tokens (`src/tools/FileReadTool/FileReadTool.ts:536-573`)
3. **Skill discovery** — Fire-and-forget scan for skill directories triggered by the file path
4. **Format dispatch** — Routes to specialized handlers based on file extension:
   - `.ipynb` → `readNotebook()` parses cells, validates size against `maxSizeBytes`
   - Image extensions (png/jpg/gif/webp) → `readImageWithTokenBudget()` with resize/compression
   - PDF extensions → `readPDF()` or `extractPDFPages()` depending on size/model support
   - Everything else → `readFileInRange()` for text with line-based slicing
5. **Token validation** — `validateContentTokens()` estimates token count and throws `MaxFileReadTokenExceededError` if it exceeds the limit
6. **State tracking** — Updates `readFileState` with content, mtime, offset, and limit for staleness detection by Edit/Write tools

#### Reading Limits (`src/tools/FileReadTool/limits.ts`)

Two caps apply to text reads:

| Limit | Default | Purpose |
|-------|---------|---------|
| `maxSizeBytes` | 256 KB (`MAX_OUTPUT_SIZE`) | Pre-read gate on total file size |
| `maxTokens` | 25,000 | Post-read gate on output token count |

Precedence for `maxTokens`: env var `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` > GrowthBook feature flag > hardcoded default. The limits are memoized at first call to avoid mid-session changes.

#### Image Processing (`src/tools/FileReadTool/imageProcessor.ts`)

Lazy-loads either `image-processor-napi` (bundled mode) or `sharp` as a fallback. Provides two exports:

- `getImageProcessor()` — Returns a Sharp-like function for resizing/converting existing images
- `getImageCreator()` — Always uses `sharp` directly (NAPI module doesn't support creation)

Both are cached after first load. Module interop handles both ESM (`{ default: fn }`) and CJS (direct function) import shapes.

---

### 2. FileEditTool (`Edit`)

**Source**: `src/tools/FileEditTool/FileEditTool.ts`

Performs **exact string replacement** within files. This is the primary tool for modifying existing files — it sends only the diff, not the full content.

#### Input Schema (`src/tools/FileEditTool/types.ts`)

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string (required) | Absolute path to the file |
| `old_string` | string (required) | Text to find and replace |
| `new_string` | string (required) | Replacement text |
| `replace_all` | boolean (default: `false`) | Replace all occurrences |

#### Key Process: Edit Flow

1. **Validation** (`validateInput`, `src/tools/FileEditTool/FileEditTool.ts:137-362`):
   - Rejects if `old_string === new_string`
   - Checks deny rules and UNC path security
   - Rejects files > 1 GiB (`MAX_EDIT_FILE_SIZE`)
   - Detects file encoding (UTF-8 or UTF-16LE via BOM)
   - **Requires prior Read** — checks `readFileState` for a non-partial read
   - **Staleness check** — compares file mtime against last read timestamp; on Windows, falls back to content comparison to avoid false positives from cloud sync
   - **Uniqueness check** — uses `findActualString()` with quote normalization, then verifies the match is unique (or `replace_all` is set)
   - Redirects `.ipynb` files to NotebookEditTool

2. **Execution** (`call`, `src/tools/FileEditTool/FileEditTool.ts:387-574`):
   - Creates parent directory if needed
   - Backs up file via `fileHistoryTrackEdit()` (if file history is enabled)
   - Re-checks staleness atomically (synchronous read + mtime check)
   - Applies quote normalization via `findActualString()` and `preserveQuoteStyle()`
   - Generates structured patch via `getPatchForEdit()`
   - Writes to disk with `writeTextContent()` preserving encoding and line endings
   - Notifies LSP servers (didChange + didSave) and VSCode
   - Updates `readFileState` with new content and mtime

#### String Matching Utilities (`src/tools/FileEditTool/utils.ts`)

- **`findActualString()`** — First tries exact match; if not found, normalizes curly quotes to straight quotes and retries. Returns the original file substring so edits preserve typography (`src/tools/FileEditTool/utils.ts:73-93`)
- **`preserveQuoteStyle()`** — When quote normalization was used, converts straight quotes in `new_string` back to curly quotes matching the file's style
- **`normalizeFileEditInput()`** — Pre-processes edits by stripping trailing whitespace (except in Markdown files) and de-sanitizing API-sanitized strings (e.g., `<fnr>` → `<function_results>`)
- **`applyEditToFile()`** — Applies the string replacement; when deleting text (`new_string === ""`), intelligently strips trailing newlines
- **`areFileEditsEquivalent()`** — Semantic comparison: applies both edit sets to the original content and compares results

#### De-sanitization (`src/tools/FileEditTool/utils.ts:531-550`)

Claude's API sanitizes certain XML-like strings in its output. The `DESANITIZATIONS` map reverses these (e.g., `<fnr>` → `<function_results>`, `\n\nH:` → `\n\nHuman:`), ensuring edits targeting files containing these strings succeed.

---

### 3. FileWriteTool (`Write`)

**Source**: `src/tools/FileWriteTool/FileWriteTool.ts`

Creates new files or **completely overwrites** existing ones. Preferred over Edit only for new file creation or full rewrites.

#### Input Schema

| Parameter | Type | Description |
|-----------|------|-------------|
| `file_path` | string (required) | Absolute path to the file |
| `content` | string (required) | Complete file content to write |

#### Key Process: Write Flow

1. **Validation** — Similar to Edit: checks secrets, deny rules, UNC paths, requires prior Read for existing files, staleness check
2. **Execution** (`src/tools/FileWriteTool/FileWriteTool.ts:223-417`):
   - Creates parent directory, backs up via file history
   - Re-checks staleness atomically (sync read + mtime comparison)
   - Writes with `writeTextContent()` using the original file's encoding but always LF line endings (the model's content is authoritative)
   - Notifies LSP and VSCode
   - Returns output typed as either `create` or `update` with a structured diff patch for updates

---

### 4. GlobTool (`Glob`)

**Source**: `src/tools/GlobTool/GlobTool.ts`

Fast file pattern matching. Read-only and concurrency-safe.

#### Input Schema

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string (required) | Glob pattern (e.g., `**/*.ts`) |
| `path` | string (optional) | Directory to search in (defaults to cwd) |

#### Behavior

- Delegates to `glob()` utility with a default limit of 100 results (configurable via `globLimits`)
- Results are sorted by modification time (most recent first) and relativized to cwd
- Validates that the `path` exists and is a directory
- Checks read permissions via `checkReadPermissionForTool()`
- Returns `{ filenames, numFiles, durationMs, truncated }`

---

### 5. GrepTool (`Grep`)

**Source**: `src/tools/GrepTool/GrepTool.ts`

Content search powered by **ripgrep**. Read-only and concurrency-safe.

#### Input Schema

| Parameter | Type | Description |
|-----------|------|-------------|
| `pattern` | string (required) | Regex pattern to search for |
| `path` | string (optional) | File/directory to search in |
| `glob` | string (optional) | Glob filter for files |
| `type` | string (optional) | File type filter (e.g., `js`, `py`) |
| `output_mode` | enum (optional) | `files_with_matches` (default), `content`, or `count` |
| `-B`, `-A`, `-C`, `context` | number (optional) | Context lines (before/after/both) |
| `-n` | boolean (default: true) | Show line numbers |
| `-i` | boolean (default: false) | Case insensitive |
| `head_limit` | number (default: 250) | Max results to return (0 = unlimited) |
| `offset` | number (default: 0) | Skip first N results |
| `multiline` | boolean (default: false) | Enable multiline matching |

#### Key Process: Grep Flow

1. Builds ripgrep argument list: `--hidden`, excludes VCS directories (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`), limits line length to 500 chars
2. Applies ignore patterns from permission settings and plugin cache exclusions
3. Calls `ripGrep()` with abort controller support
4. Post-processes based on output mode:
   - **`files_with_matches`** — Stats each file, sorts by mtime (most recent first), applies head_limit
   - **`content`** — Relativizes file paths in output lines, applies head_limit
   - **`count`** — Parses `filename:count` format, sums totals
5. All paths are relativized to cwd to save tokens

#### Pagination

The `head_limit` (default 250) and `offset` parameters enable pagination. The `applyHeadLimit()` helper (`src/tools/GrepTool/GrepTool.ts:110-128`) only reports truncation when it actually occurred, so the model knows whether more results exist.

---

### 6. NotebookEditTool (`NotebookEdit`)

**Source**: `src/tools/NotebookEditTool/NotebookEditTool.ts`

Edits individual cells in Jupyter notebooks (`.ipynb` files). This is a **deferred tool** (`shouldDefer: true`) — its schema is only loaded when needed.

#### Input Schema

| Parameter | Type | Description |
|-----------|------|-------------|
| `notebook_path` | string (required) | Absolute path to the `.ipynb` file |
| `cell_id` | string (optional) | Cell ID or index (e.g., `cell-0`) to target |
| `new_source` | string (required) | New cell source content |
| `cell_type` | enum (optional) | `code` or `markdown` |
| `edit_mode` | enum (optional) | `replace` (default), `insert`, or `delete` |

#### Key Process: Notebook Edit Flow

1. **Validation** (`src/tools/NotebookEditTool/NotebookEditTool.ts:176-294`):
   - Verifies `.ipynb` extension
   - Validates edit_mode is one of `replace`/`insert`/`delete`
   - Requires `cell_type` for insert mode
   - Requires prior Read (staleness check)
   - Parses notebook JSON, resolves cell by ID or numeric index (`cell-N` format)

2. **Execution** (`src/tools/NotebookEditTool/NotebookEditTool.ts:295-489`):
   - Uses `jsonParse()` (non-memoized) to avoid cache poisoning from in-place mutation
   - **Replace** — Updates `source` on target cell; resets `execution_count` and `outputs` for code cells
   - **Insert** — Creates a new cell with random ID (for nbformat >= 4.5) and splices it after the target
   - **Delete** — Splices the target cell out
   - Serializes with 1-space indent, writes via `writeTextContent()`, updates `readFileState`

---

## Shared Patterns Across All Tools

### Permission Model

All write tools (Edit, Write, NotebookEdit) use `checkWritePermissionForTool()`. Read tools (Read, Glob, Grep) use `checkReadPermissionForTool()`. Both delegate to the Infrastructure layer's filesystem permission system. UNC paths are blocked from filesystem operations to prevent NTLM credential leaks on Windows.

### Read-Before-Write Invariant

Edit, Write, and NotebookEdit all enforce that the file must have been read (via `readFileState`) before modification. This prevents blind edits and enables staleness detection. The staleness check compares the file's current mtime against the timestamp recorded during the last Read.

### readFileState Tracking

Every tool that reads or modifies a file updates `readFileState` (a `Map<string, {content, timestamp, offset, limit}>`) so that:
- Edit/Write can detect concurrent modifications
- FileReadTool can deduplicate repeat reads
- The distinction between Read-originated entries (`offset` defined) and Edit/Write-originated entries (`offset: undefined`) prevents cross-tool dedup bugs

### Skill Discovery

Read, Edit, and Write all trigger fire-and-forget skill directory discovery via `discoverSkillDirsForPaths()` and `activateConditionalSkillsForPaths()`, enabling path-based skill loading.

### LSP Integration

Edit and Write notify LSP servers of file changes (didChange + didSave) and clear delivered diagnostics, ensuring language servers stay in sync with file state.

---

## Configuration & Environment Variables

| Variable | Tool | Purpose |
|----------|------|---------|
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | FileReadTool | Override max token limit for file reads |
| `CLAUDE_CODE_SIMPLE` | FileReadTool, FileEditTool | Skip skill discovery in simple mode |
| `CLAUDE_CODE_REMOTE` | FileEditTool, FileWriteTool | Enable git diff computation for remote sessions |
| `NODE_ENV=test` | GrepTool | Sort results by filename instead of mtime for determinism |

## Edge Cases & Caveats

- **macOS screenshot paths** — FileReadTool handles the thin space (U+202F) vs regular space ambiguity in AM/PM screenshot filenames by trying an alternate path on ENOENT
- **Curly quote normalization** — FileEditTool transparently matches straight quotes against curly quotes in files, and preserves the file's quote style in replacements
- **API de-sanitization** — FileEditTool reverses Claude's API output sanitization (e.g., `<fnr>` → `<function_results>`) to enable edits targeting files with those strings
- **Windows mtime false positives** — Cloud sync and antivirus can change file timestamps without modifying content; Edit and Write fall back to content comparison for full reads
- **Large file guard** — FileEditTool rejects files > 1 GiB to prevent V8 string length OOM
- **Markdown trailing whitespace** — `normalizeFileEditInput()` skips trailing whitespace stripping for `.md`/`.mdx` files since trailing spaces are meaningful (hard line breaks)
- **NotebookEdit cache poisoning** — Uses non-memoized `jsonParse()` instead of `safeParseJSON()` because the notebook object is mutated in place
- **Grep default head_limit** — Set to 250 to prevent context bloat; pass `head_limit=0` explicitly for unlimited results