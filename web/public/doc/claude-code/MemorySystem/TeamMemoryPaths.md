# TeamMemoryPaths

## Overview & Responsibilities

TeamMemoryPaths is a security-critical module within the **MemorySystem** that manages file path resolution and validation for the team memory feature. Team memory allows shared, synced memories across all users working in a project directory. This module's primary job is to ensure that all file operations targeting the team memory directory are safe — specifically, that no path traversal or symlink-based escape can cause writes outside the designated team memory directory.

It sits alongside the broader auto-memory path system (`memdir/paths.ts`) and is consumed by team memory sync, file detection, and prompt-building code. Its companion file `teamMemPrompts.ts` builds the combined user-facing prompt when both private and team memory are active.

## Key Processes

### Path Validation Flow (Write Operations)

The module implements a **two-pass validation** strategy for every write path:

1. **String-level containment check** — `path.resolve()` normalizes `..` segments and converts to an absolute path, then checks it starts with the team memory directory prefix (`src/memdir/teamMemPaths.ts:237-245`)
2. **Symlink-resolved containment check** — `realpathDeepestExisting()` walks up the directory tree to resolve symlinks on the deepest existing ancestor, then `isRealPathWithinTeamDir()` verifies the real filesystem location is still inside the real team directory (`src/memdir/teamMemPaths.ts:249-254`)

This two-pass approach is necessary because `path.resolve()` does **not** resolve symlinks — an attacker who places a symlink inside the team directory pointing to `~/.ssh/authorized_keys` would pass a resolve-only check (referenced as PSR M22186).

### Key Sanitization Flow (Server-Provided Keys)

When the server returns relative path keys (e.g., from a sync response), `validateTeamMemKey()` runs:

1. **`sanitizePathKey()`** — rejects null bytes, URL-encoded traversals (`%2e%2e%2f`), Unicode normalization attacks (fullwidth `．．／`), backslashes, and absolute paths (`src/memdir/teamMemPaths.ts:22-64`)
2. Joins the sanitized key with the team directory and runs the same two-pass validation as above (`src/memdir/teamMemPaths.ts:265-284`)

### Feature Gating

`isTeamMemoryEnabled()` gates the entire feature behind two conditions (`src/memdir/teamMemPaths.ts:73-78`):
1. Auto-memory must be enabled (team memory is a subdirectory of auto-memory)
2. The `tengu_herring_clock` feature flag must be active (via GrowthBook)

## Function Signatures

### `isTeamMemoryEnabled(): boolean`

Returns whether team memory features are active. Requires both auto-memory and the feature flag.

### `getTeamMemPath(): string`

Returns the team memory directory path: `<autoMemBase>/team/` (with trailing separator, NFC-normalized).

### `getTeamMemEntrypoint(): string`

Returns the path to the team memory index file: `<autoMemBase>/team/MEMORY.md`.

### `isTeamMemPath(filePath: string): boolean`

Fast, synchronous check whether a resolved path is inside the team memory directory. Uses `path.resolve()` only — **does not resolve symlinks**. Suitable for read-side checks, not for write validation.

### `validateTeamMemWritePath(filePath: string): Promise<string>`

Validates an absolute file path for writing. Performs two-pass validation (string-level + symlink-resolved). Returns the resolved path on success, throws `PathTraversalError` on failure.

### `validateTeamMemKey(relativeKey: string): Promise<string>`

Validates a relative key from the server. Sanitizes the key, joins it with the team directory, then runs two-pass validation. Returns the resolved absolute path.

### `isTeamMemFile(filePath: string): boolean`

Convenience function combining the feature gate check (`isTeamMemoryEnabled()`) with the path check (`isTeamMemPath()`).

### `buildCombinedMemoryPrompt(extraGuidelines?: string[], skipIndex?: boolean): string`

*(In `teamMemPrompts.ts`)* Builds the system prompt text for the combined private + team memory mode. Describes both directories, scope rules, the four memory types with per-type scope guidance, how to save memories, and when to access them. The `skipIndex` parameter controls whether the MEMORY.md indexing step is included in the instructions.

## Type Definitions

### `PathTraversalError`

Custom `Error` subclass (`src/memdir/teamMemPaths.ts:10-15`) thrown by all validation functions when a path fails security checks. Its `name` property is set to `'PathTraversalError'`, allowing callers to catch and handle traversal attempts gracefully (e.g., skip the entry instead of aborting an entire batch).

## Internal Security Architecture

### `sanitizePathKey(key: string): string` *(private)*

Defends against five injection vectors (`src/memdir/teamMemPaths.ts:22-64`):

| Vector | Check | Example |
|--------|-------|---------|
| Null bytes | `key.includes('\0')` | Truncate paths in C-based syscalls |
| URL-encoded traversal | `decodeURIComponent` then check for `..` or `/` | `%2e%2e%2f` → `../` |
| Unicode normalization | NFKC normalize then check for `..`, `/`, `\`, `\0` | Fullwidth `．．／` → `../` |
| Backslashes | `key.includes('\\')` | Windows-style path separators |
| Absolute paths | `key.startsWith('/')` | Direct root escape |

### `realpathDeepestExisting(absolutePath: string): Promise<string>` *(private)*

Resolves symlinks for paths where the target file may not yet exist (`src/memdir/teamMemPaths.ts:109-171`). Walks up the directory tree collecting non-existent segments, calls `realpath()` on the deepest existing ancestor, then reattaches the tail. Handles edge cases:

- **Dangling symlinks**: Detected via `lstat()` — a dangling symlink would cause `writeFile` to follow the link and create the target outside the team directory
- **Symlink loops** (`ELOOP`): Rejected as corrupted or malicious state
- **Permission errors** (`EACCES`, `EIO`): Fails closed — wraps as `PathTraversalError` so the caller can skip gracefully

### `isRealPathWithinTeamDir(realCandidate: string): Promise<boolean>` *(private)*

Compares a realpath-resolved candidate against the realpath-resolved team directory (`src/memdir/teamMemPaths.ts:183-206`). Uses separator-aware prefix matching (`realTeamDir + sep`) to prevent prefix attacks (e.g., `/foo/team-evil` must not match `/foo/team`). When the team directory doesn't exist yet, returns `true` — no directory means no symlinks to exploit, so the string-level check is sufficient.

## Edge Cases & Caveats

- **Trailing separator convention**: `getTeamMemPath()` always appends a path separator. This is intentional for prefix-matching safety but must be stripped before calling `realpath()` (some platforms reject trailing separators).
- **Fail-closed design**: When `realpath()` or `lstat()` encounters unexpected errors (permission denied, I/O errors), the module throws `PathTraversalError` rather than allowing the operation — security over availability.
- **Feature flag dependency**: The feature flag name `tengu_herring_clock` uses the cached/stale variant of the GrowthBook evaluator, meaning there can be a brief delay after the flag changes before the team memory feature activates or deactivates.
- **`isTeamMemPath` vs `validateTeamMemWritePath`**: The synchronous `isTeamMemPath` is adequate for read-side detection but **must not** be used for write validation — it does not resolve symlinks. All write paths must go through `validateTeamMemWritePath` or `validateTeamMemKey`.
- **NFC normalization**: `getTeamMemPath()` normalizes to NFC to ensure consistent path comparison across macOS (which uses NFD for filenames) and other platforms.