# File and Path Utilities

## Overview & Responsibilities

The FileAndPath module is a collection of foundational file system and path utilities that sit within the **Infrastructure → CoreUtilities** layer of the architecture. Nearly every other module in the codebase depends on these utilities for path resolution, file reading, content searching, and directory management.

The module is composed of eight independent files, each with a focused responsibility:

| File | Purpose |
|------|---------|
| `path.ts` | Path normalization, tilde expansion, relative path conversion |
| `tempfile.ts` | Deterministic and random temp file path generation |
| `glob.ts` | Glob pattern matching via ripgrep's `--files` mode |
| `ripgrep.ts` | Ripgrep process management, content search, and result parsing |
| `bufferedWriter.ts` | Batched, deferred file writing to avoid blocking the event loop |
| `readFileInRange.ts` | Line-range file reading with dual fast/streaming code paths |
| `systemDirectories.ts` | Cross-platform system directory resolution (Desktop, Documents, etc.) |
| `xdg.ts` | XDG Base Directory spec resolution for state, cache, and data dirs |

## Key Processes

### Path Resolution Flow (`path.ts`)

The central function `expandPath()` resolves any user-supplied path string into an absolute, NFC-normalized path:

1. Validate input (type check, null-byte rejection)
2. Handle tilde notation — `~` expands to `os.homedir()`, `~/...` joins with home
3. On Windows, convert POSIX-style paths (e.g., `/c/Users/...`) to native Windows format via `posixPathToWindowsPath()`
4. If already absolute, normalize and return
5. Otherwise resolve relative to `baseDir` (defaults to `getCwd()`)

All returned paths are Unicode NFC-normalized to prevent duplicate-path bugs on macOS.

`toRelativePath()` does the inverse — shortening an absolute path to a cwd-relative one (used to save tokens in tool output). If the relative path would escape cwd (starts with `..`), it returns the absolute path unchanged.

Security: `containsPathTraversal()` detects `../` patterns, and `getDirectoryForPath()` refuses to stat UNC paths (`\\server\share`) to prevent NTLM credential leaks.

> Source: `src/utils/path.ts:32-85` (expandPath), `src/utils/path.ts:95-99` (toRelativePath)

### Glob Pattern Matching Flow (`glob.ts`)

The `glob()` function uses ripgrep in file-listing mode rather than a JavaScript glob library, which gives better memory performance on large repos:

1. If the pattern is absolute, `extractGlobBaseDirectory()` splits it into a static base directory and a relative glob pattern (ripgrep's `--glob` flag requires relative patterns)
2. Collect ignore patterns from the permission system via `getFileReadIgnorePatterns()`
3. Build ripgrep args: `--files --glob <pattern> --sort=modified` plus `--no-ignore` and `--hidden` (both configurable via `CLAUDE_CODE_GLOB_NO_IGNORE` and `CLAUDE_CODE_GLOB_HIDDEN` env vars)
4. Exclude orphaned plugin cache directories
5. Execute via `ripGrep()`, convert relative results to absolute paths
6. Apply offset/limit pagination and return a `truncated` flag

> Source: `src/utils/glob.ts:66-130`

### Ripgrep Integration (`ripgrep.ts`)

Ripgrep is the workhorse behind both glob and content search. The module manages three execution modes:

| Mode | When | How |
|------|------|-----|
| `system` | User sets `USE_BUILTIN_RIPGREP=false` and system `rg` exists | Spawns system `rg` command |
| `embedded` | Running in bundled (Bun) mode | Spawns self with `argv0='rg'` — ripgrep is compiled into the binary |
| `builtin` | Default for npm installs | Uses vendored platform-specific binary from `vendor/ripgrep/` |

The mode is resolved once via memoized `getRipgrepConfig()`.

**Execution and error handling** in `ripGrep()`:

1. Code-sign the vendored binary on macOS if needed (`codesignRipgrepIfNecessary`)
2. Spawn ripgrep with a platform-dependent timeout (20s default, 60s on WSL, configurable via `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS`)
3. On EAGAIN errors (resource-constrained environments like Docker), retry once with `-j 1` (single-threaded)
4. On timeout with partial results, return what was collected (dropping the last potentially-incomplete line)
5. On timeout with zero results, throw `RipgrepTimeoutError` so callers know the search was incomplete rather than empty
6. Buffer cap: 20 MB max stdout to handle large monorepos (200k+ files)

**Streaming variant** `ripGrepStream()` flushes lines per chunk as they arrive (for interactive/fzf-style UIs). **Counting variant** `ripGrepFileCount()` counts newlines per chunk without materializing the full path list — peak memory is ~64 KB regardless of repo size.

> Source: `src/utils/ripgrep.ts:31-65` (config resolution), `src/utils/ripgrep.ts:345-463` (ripGrep main), `src/utils/ripgrep.ts:295-343` (ripGrepStream)

### Ranged File Reading (`readFileInRange.ts`)

`readFileInRange()` returns lines `[offset, offset + maxLines)` from a file using two code paths:

**Fast path** (regular files < 10 MB): Reads the entire file with `readFile()`, then splits lines in memory with `indexOf('\n')` scanning. ~2x faster than streaming for typical source files.

**Streaming path** (files >= 10 MB, pipes, devices): Uses `createReadStream` with 512 KB chunks. Only accumulates lines inside the requested range — lines outside the range are counted (for `totalLines`) but discarded, preventing memory blowup when reading line 1 of a 100 GB file. Event handlers are module-level named functions with zero closures; state lives in a `StreamState` object accessed via `this`.

Both paths strip UTF-8 BOM and normalize CRLF to LF.

**`maxBytes` behavior** depends on `truncateOnByteLimit`:
- `false` (default): throws `FileTooLargeError` if the file exceeds the limit
- `true`: caps selected output at `maxBytes`, stopping at the last complete line that fits; sets `truncatedByBytes` in the result

> Source: `src/utils/readFileInRange.ts:73-122` (entry point), `src/utils/readFileInRange.ts:128-194` (fast path)

### Buffered Writer (`bufferedWriter.ts`)

`createBufferedWriter()` wraps a write function with batching to avoid blocking the event loop during high-frequency writes (e.g., error log sinks):

1. Incoming `write()` calls push content into a buffer array
2. A timer-based flush fires every `flushIntervalMs` (default 1000ms)
3. If the buffer hits `maxBufferSize` (100 items) or `maxBufferBytes` before the timer, an **overflow flush** is triggered via `setImmediate` — the buffer is detached synchronously so the caller never blocks on `writeFn`
4. `immediateMode` bypasses all buffering for debugging
5. `dispose()` drains any pending overflow and buffer synchronously

> Source: `src/utils/bufferedWriter.ts:9-100`

## Function Signatures

### `expandPath(path: string, baseDir?: string): string`
Expands tilde, resolves relative paths, normalizes for the current platform. Throws on null bytes.

### `toRelativePath(absolutePath: string): string`
Converts an absolute path to cwd-relative if it doesn't escape cwd.

### `getDirectoryForPath(path: string): string`
Returns the path itself if it's a directory, otherwise returns `dirname()`. Skips stat for UNC paths.

### `containsPathTraversal(path: string): boolean`
Detects `../` directory traversal patterns.

### `normalizePathForConfigKey(path: string): string`
Normalizes path separators to forward slashes for consistent JSON config keys.

### `generateTempFilePath(prefix?: string, extension?: string, options?: { contentHash?: string }): string`
Generates a temp file path. When `contentHash` is provided, the filename is a deterministic SHA-256 prefix — stable across processes, which preserves Anthropic API prompt cache prefixes.

### `glob(filePattern, cwd, { limit, offset }, abortSignal, toolPermissionContext): Promise<{ files: string[]; truncated: boolean }>`
Glob via ripgrep with pagination and permission-aware ignore patterns.

### `ripGrep(args: string[], target: string, abortSignal: AbortSignal): Promise<string[]>`
Core ripgrep execution. Returns lines of stdout, handles EAGAIN retry, timeouts, and partial results.

### `ripGrepStream(args, target, abortSignal, onLines): Promise<void>`
Streaming ripgrep — calls `onLines(lines)` per chunk for live results.

### `countFilesRoundedRg(dirPath, abortSignal, ignorePatterns?): Promise<number | undefined>`
Counts files via ripgrep and rounds to the nearest power of 10 (for privacy/telemetry). Skips home directory to avoid macOS TCC dialogs. Memoized.

### `readFileInRange(filePath, offset?, maxLines?, maxBytes?, signal?, options?): Promise<ReadFileRangeResult>`
Reads a line range from a file. Returns content, line counts, byte sizes, and mtime.

### `createBufferedWriter({ writeFn, flushIntervalMs?, maxBufferSize?, maxBufferBytes?, immediateMode? }): BufferedWriter`
Creates a writer that batches calls to `writeFn` and flushes on timer or overflow.

### `getSystemDirectories(options?): SystemDirectories`
Returns platform-aware paths for HOME, DESKTOP, DOCUMENTS, DOWNLOADS. Uses `USERPROFILE` on Windows, XDG env vars on Linux/WSL.

### `getXDGStateHome(options?): string` / `getXDGCacheHome` / `getXDGDataHome` / `getUserBinDir`
Return XDG-compliant directories (defaulting to `~/.local/state`, `~/.cache`, `~/.local/share`, `~/.local/bin`).

## Type Definitions

### `ReadFileRangeResult`
```typescript
type ReadFileRangeResult = {
  content: string           // The selected lines joined by '\n'
  lineCount: number         // Number of lines returned
  totalLines: number        // Total lines in the file
  totalBytes: number        // Total file size in bytes
  readBytes: number         // Bytes in returned content
  mtimeMs: number           // File modification time (epoch ms)
  truncatedByBytes?: boolean // Set when output was clipped to maxBytes
}
```

### `BufferedWriter`
```typescript
type BufferedWriter = {
  write: (content: string) => void  // Queue content for writing
  flush: () => void                 // Force immediate write of all buffered content
  dispose: () => void               // Flush and clean up
}
```

### `SystemDirectories`
```typescript
type SystemDirectories = {
  HOME: string
  DESKTOP: string
  DOCUMENTS: string
  DOWNLOADS: string
  [key: string]: string
}
```

### `RipgrepConfig`
Internal type with `mode: 'system' | 'builtin' | 'embedded'`, `command`, `args`, and optional `argv0`.

## Configuration & Defaults

| Variable | Purpose | Default |
|----------|---------|---------|
| `CLAUDE_CODE_GLOB_NO_IGNORE` | Whether glob ignores `.gitignore` | `true` (ignores .gitignore) |
| `CLAUDE_CODE_GLOB_HIDDEN` | Whether glob includes hidden files | `true` |
| `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` | Ripgrep timeout override | 20s (60s on WSL) |
| `USE_BUILTIN_RIPGREP` | Set to `false` to prefer system `rg` | `true` (use builtin) |
| `XDG_STATE_HOME` | XDG state directory | `~/.local/state` |
| `XDG_CACHE_HOME` | XDG cache directory | `~/.cache` |
| `XDG_DATA_HOME` | XDG data directory | `~/.local/share` |
| `XDG_DESKTOP_DIR` / `XDG_DOCUMENTS_DIR` / `XDG_DOWNLOAD_DIR` | Linux/WSL folder overrides | `~/Desktop`, etc. |

## Edge Cases & Caveats

- **Ripgrep EAGAIN**: In resource-constrained environments (Docker, CI), ripgrep may fail with OS error 11. The module retries once with `-j 1` (single-threaded) but does not persist single-threaded mode globally — doing so caused timeouts on large repos.
- **macOS codesigning**: The vendored ripgrep binary may need ad-hoc signing on first use. The module checks for `linker-signed` and re-signs with `codesign --sign - --force` if needed, also stripping the quarantine xattr.
- **UNC path safety**: `getDirectoryForPath()` skips `statSync` for UNC paths (`\\server\...`) to prevent NTLM credential leak attacks.
- **Null-byte injection**: `expandPath()` explicitly rejects paths containing `\0` to prevent security exploits.
- **Temp file cache stability**: `generateTempFilePath()` with `contentHash` produces deterministic paths from SHA-256 hashes. This is critical for paths that appear in Anthropic API prompts — random UUIDs would invalidate the prompt cache on every subprocess spawn.
- **Streaming memory safety**: `readFileInRange()` discards out-of-range lines during streaming to prevent unbounded memory growth. A single huge line that exceeds `maxBytes` in truncate mode is also detected and discarded.
- **Buffered writer overflow**: When the buffer overflows, the batch is written via `setImmediate` (not synchronously) to keep the current tick short — important when `writeFn` is blocking (e.g., `appendFileSync`).
- **Windows path handling**: `extractGlobBaseDirectory()` handles Windows drive roots carefully — bare `C:` means "current directory on drive C" (relative), so it appends a separator to get the actual drive root `C:\`.