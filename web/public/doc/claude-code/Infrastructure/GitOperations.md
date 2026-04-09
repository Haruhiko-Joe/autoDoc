# Git Operations

## Overview & Responsibilities

Git Operations is the foundational git integration layer within the **Infrastructure** module of Claude Code. It provides every other module with the ability to interact with git repositories — from detecting whether the current directory is inside a repo, to resolving branches and commits, parsing diffs, managing worktrees, and tracking file attribution.

The module is architected around a key design principle: **avoid spawning git subprocesses on hot paths**. A high-performance filesystem-based reader (`src/utils/git/gitFilesystem.ts`) directly parses `.git/HEAD`, loose refs, packed-refs, and `.git/config` — trading the overhead of `git` process spawns (~15–90ms each) for direct file reads (~1ms). A `GitFileWatcher` class uses `fs.watchFile` to automatically invalidate cached values when git state changes on disk.

The module spans eight files organized into three logical tiers:

| Tier | Files | Purpose |
|------|-------|---------|
| **Low-level readers** | `git/gitFilesystem.ts`, `git/gitConfigParser.ts`, `git/gitignore.ts` | Filesystem-based git state reading, config parsing, gitignore management |
| **Core operations** | `git.ts`, `gitDiff.ts`, `gitSettings.ts` | Repository detection, branch/remote queries, diff analysis, settings |
| **Higher-level features** | `worktree.ts`, `worktreeModeEnabled.ts`, `commitAttribution.ts` | Worktree lifecycle, commit attribution tracking |

## Key Processes

### Repository Root Detection

The entry point for all git operations is `findGitRoot()`, which walks up the directory tree from a given path looking for a `.git` entry (`src/utils/git.ts:27-86`).

1. Starting from the given path, `statSync` each directory for a `.git` entry
2. Accept both directories (regular repos) and files (worktrees/submodules where `.git` contains `gitdir: <path>`)
3. Return the containing directory, normalized to NFC Unicode form
4. Results are memoized in an LRU cache (max 50 entries) to avoid repeated filesystem walks

For project-scoped state (memory, config), `findCanonicalGitRoot()` goes further: it follows the `.git` file → `gitdir:` → `commondir` chain to resolve worktrees back to the main repository root (`src/utils/git.ts:123-183`). This includes **security validation** to prevent a malicious repo from pointing `commondir` at an attacker-chosen path:

```
// src/utils/git.ts:156-170
if (resolve(dirname(worktreeGitDir)) !== join(commonDir, 'worktrees')) {
  return gitRoot  // Structure doesn't match git worktree add
}
const backlink = realpathSync(
  readFileSync(join(worktreeGitDir, 'gitdir'), 'utf-8').trim(),
)
if (backlink !== join(realpathSync(gitRoot), '.git')) {
  return gitRoot  // Backlink doesn't point back to us
}
```

### Filesystem-Based HEAD/Branch/Remote Resolution

Instead of spawning `git rev-parse` or `git config`, the `GitFileWatcher` class reads git internals directly from disk (`src/utils/git/gitFilesystem.ts:333-496`):

1. **Initialization**: On first cache access, resolves the `.git` directory and starts watching `HEAD`, `config`, and the current branch's ref file via `fs.watchFile`
2. **HEAD parsing** (`readGitHead`, line 149): Reads `.git/HEAD`, which is either `ref: refs/heads/<branch>\n` (on a branch) or a raw SHA (detached HEAD). All values pass through `isSafeRefName()` / `isValidGitSha()` validation to prevent injection attacks from tampered `.git` files
3. **Ref resolution** (`resolveRef`, line 203): Resolves refs by checking loose ref files first, then falling back to `packed-refs`. For worktrees, checks both the worktree-specific gitdir and the shared `commondir`
4. **Remote URL** (`computeRemoteUrl`, line 527): Parsed from `.git/config` via the lightweight config parser, checking both worktree gitdir and commondir
5. **Cache invalidation**: When a watched file changes, all cache entries are marked dirty. The next `get()` call recomputes from disk. Race conditions are handled by clearing the dirty flag before async compute starts — if a file changes during compute, dirty is re-set

Exported accessors: `getCachedBranch()`, `getCachedHead()`, `getCachedRemoteUrl()`, `getCachedDefaultBranch()`.

### Git Config Parsing

The `.git/config` parser (`src/utils/git/gitConfigParser.ts`) implements a subset of git's `config.c` format:

- Section names are case-insensitive; subsection names (quoted) are case-sensitive
- Supports backslash escape sequences (`\n`, `\t`, `\\`, `\"`) inside quoted values
- Handles inline comments (`#` and `;`) outside quotes
- Trims trailing whitespace from unquoted values

```typescript
// src/utils/git/gitConfigParser.ts:18-30
export async function parseGitConfigValue(
  gitDir: string,
  section: string,        // e.g., 'remote'
  subsection: string | null, // e.g., 'origin'
  key: string,            // e.g., 'url'
): Promise<string | null>
```

### Remote URL Normalization

`normalizeGitRemoteUrl()` converts SSH and HTTPS URLs to a canonical `host/owner/repo` form for consistent hashing (`src/utils/git.ts:283-321`):

| Input | Output |
|-------|--------|
| `git@github.com:owner/repo.git` | `github.com/owner/repo` |
| `https://github.com/owner/repo.git` | `github.com/owner/repo` |
| `ssh://git@github.com/owner/repo` | `github.com/owner/repo` |
| `http://proxy@127.0.0.1:16583/git/owner/repo` | `github.com/owner/repo` |
| `http://proxy@127.0.0.1:PORT/git/ghe.host/owner/repo` | `ghe.host/owner/repo` |

Special handling exists for CCR git proxy URLs (localhost addresses with `/git/` prefix), distinguishing legacy GitHub format from GHE format by checking whether the first path segment contains a dot.

### Diff Analysis

`fetchGitDiff()` (`src/utils/gitDiff.ts:49-108`) uses a two-phase approach:

1. **Quick probe** (`--shortstat`): O(1) memory check for total file/line counts. If more than 500 files changed, returns only aggregate stats (no per-file details) to avoid loading hundreds of MB
2. **Detailed stats** (`--numstat`): Per-file additions/deletions, capped at 50 files in `perFileStats`. Untracked files are appended from `git ls-files --others --exclude-standard`
3. **Hunks** (on-demand via `fetchGitDiffHunks()`): Full unified diff parsed into `StructuredPatchHunk[]`, with per-file limits of 1MB and 400 lines

Both functions skip diff calculation during **transient git states** (merge, rebase, cherry-pick, revert) by checking for sentinel files like `MERGE_HEAD` in the git directory (`src/utils/gitDiff.ts:307-326`).

`fetchSingleFileGitDiff()` produces a PR-like diff for a single file by diffing against the merge-base with the default branch (or `CLAUDE_CODE_BASE_REF` env var).

### Worktree Lifecycle Management

The worktree system (`src/utils/worktree.ts`) provides isolated working directories for agents and parallel tasks:

**Creation flow** (`getOrCreateWorktree`, line 235):
1. **Fast resume**: Read `.git` pointer file directly via `readWorktreeHeadSha()` — if the worktree exists, skip all git operations (~0ms vs ~90ms)
2. **Fetch base**: Resolve the default branch ref from the filesystem first; only spawn `git fetch` if the ref doesn't exist locally (saves 6–8s on large repos)
3. **Create**: `git worktree add -B worktree-<slug> <path> <base>`. Optionally applies sparse-checkout from settings
4. **Post-creation setup**: Copy `settings.local.json`, configure `core.hooksPath`, symlink directories (e.g., `node_modules`), copy `.worktreeinclude` files, install attribution hooks

**Slug validation** (`validateWorktreeSlug`, line 66): Prevents path traversal by requiring each `/`-separated segment to match `[a-zA-Z0-9._-]+`, rejecting `.` and `..` segments, and capping length at 64 characters. Forward slashes are flattened to `+` for both branch names and directory paths to avoid git D/F conflicts.

**Cleanup** (`cleanupStaleAgentWorktrees`, line 1058): Periodically removes ephemeral worktrees (agents, workflows, bridge sessions) older than a cutoff date, but only if they have no uncommitted changes and no unpushed commits. Pattern matching distinguishes ephemeral slugs from user-named worktrees.

**Hook-based worktrees**: An extensibility point allowing non-git VCS systems — if `WorktreeCreate`/`WorktreeRemove` hooks are configured, they take precedence over git operations.

### Commit Attribution

The attribution system (`src/utils/commitAttribution.ts`) tracks Claude's character-level contribution to files:

1. **Tracking**: `trackFileModification()` computes Claude's contribution using common prefix/suffix matching between old and new content — the changed region size (max of old and new changed lengths) is accumulated per file
2. **State management**: `AttributionState` tracks per-file states, session baselines, prompt counts, and permission prompt counts. State is serialized to snapshots for persistence across context compaction
3. **Commit calculation**: `calculateCommitAttribution()` merges file states from multiple sessions, processes staged files in parallel, and produces an `AttributionData` record with per-file and per-surface breakdowns
4. **Model name sanitization**: Internal model variants are mapped to public names (e.g., any `opus-4-6` variant → `claude-opus-4-6`) to prevent codename leaks. An allowlist of private Anthropic repos permits unsanitized names

### Git State Preservation for Issues

`preserveGitStateForIssue()` (`src/utils/git.ts:724-845`) captures a full snapshot for bug report replay:

1. Find the best remote base (tracking branch → `origin/main` → `origin/staging` → `origin/master`)
2. Compute `merge-base` between HEAD and the remote
3. In parallel: generate diff patch, capture untracked files (with binary detection and 500MB/5GB size limits), run `format-patch` for committed changes, and resolve HEAD SHA and branch name
4. Graceful degradation: falls back to HEAD-only mode for shallow clones, missing remotes, or failed merge-base

## Function Signatures

### Repository Detection

| Function | Signature | Description |
|----------|-----------|-------------|
| `findGitRoot` | `(startPath: string) => string \| null` | Walk up to find `.git`, memoized with LRU-50 |
| `findCanonicalGitRoot` | `(startPath: string) => string \| null` | Resolve through worktrees to main repo root |
| `getIsGit` | `() => Promise<boolean>` | Whether CWD is in a git repo (memoized) |
| `isCurrentDirectoryBareGitRepo` | `() => boolean` | Security check for bare-repo sandbox escape |

### Branch/HEAD/Remote

| Function | Signature | Description |
|----------|-----------|-------------|
| `getBranch` | `() => Promise<string>` | Current branch name (or `"HEAD"` if detached) |
| `getHead` | `() => Promise<string>` | Current HEAD commit SHA |
| `getDefaultBranch` | `() => Promise<string>` | Default branch (via `origin/HEAD` symref or probing) |
| `getRemoteUrl` | `() => Promise<string \| null>` | Remote origin URL from config |
| `normalizeGitRemoteUrl` | `(url: string) => string \| null` | Canonicalize SSH/HTTPS URLs |
| `getRepoRemoteHash` | `() => Promise<string \| null>` | SHA-256 prefix of normalized remote URL |

### Working Tree Status

| Function | Signature | Description |
|----------|-----------|-------------|
| `getIsClean` | `(options?: { ignoreUntracked?: boolean }) => Promise<boolean>` | Check for uncommitted changes |
| `getChangedFiles` | `() => Promise<string[]>` | List of changed file paths |
| `getFileStatus` | `() => Promise<GitFileStatus>` | Tracked vs untracked file lists |
| `stashToCleanState` | `(message?: string) => Promise<boolean>` | Stash all changes including untracked |

### Diff Analysis

| Function | Signature | Description |
|----------|-----------|-------------|
| `fetchGitDiff` | `() => Promise<GitDiffResult \| null>` | Stats + per-file stats (polling-friendly) |
| `fetchGitDiffHunks` | `() => Promise<Map<string, StructuredPatchHunk[]>>` | On-demand hunk data |
| `fetchSingleFileGitDiff` | `(absoluteFilePath: string) => Promise<ToolUseDiff \| null>` | PR-like diff for one file |

### Worktree Management

| Function | Signature | Description |
|----------|-----------|-------------|
| `createWorktreeForSession` | `(sessionId, slug, tmuxSessionName?, options?) => Promise<WorktreeSession>` | Create/resume session worktree |
| `createAgentWorktree` | `(slug: string) => Promise<{worktreePath, ...}>` | Lightweight worktree for subagents |
| `removeAgentWorktree` | `(worktreePath, branch?, gitRoot?, hookBased?) => Promise<boolean>` | Remove agent worktree + branch |
| `cleanupStaleAgentWorktrees` | `(cutoffDate: Date) => Promise<number>` | GC ephemeral worktrees past age cutoff |
| `hasWorktreeChanges` | `(worktreePath, headCommit) => Promise<boolean>` | Check for uncommitted/unpushed work |

## Type Definitions

### `GitRepoState`

Aggregate snapshot of repository state, fetched in parallel by `getGitState()`:

| Field | Type | Description |
|-------|------|-------------|
| `commitHash` | `string` | HEAD commit SHA |
| `branchName` | `string` | Current branch name |
| `remoteUrl` | `string \| null` | Origin remote URL |
| `isHeadOnRemote` | `boolean` | Whether HEAD tracks a remote |
| `isClean` | `boolean` | No uncommitted changes |
| `worktreeCount` | `number` | Number of linked worktrees |

### `GitDiffResult`

| Field | Type | Description |
|-------|------|-------------|
| `stats` | `GitDiffStats` | `{filesCount, linesAdded, linesRemoved}` |
| `perFileStats` | `Map<string, PerFileStats>` | Per-file `{added, removed, isBinary, isUntracked?}` (max 50) |
| `hunks` | `Map<string, StructuredPatchHunk[]>` | Per-file hunks (populated on-demand) |

### `WorktreeSession`

| Field | Type | Description |
|-------|------|-------------|
| `originalCwd` | `string` | Directory before worktree creation |
| `worktreePath` | `string` | Absolute path to worktree |
| `worktreeName` | `string` | User-provided or generated slug |
| `worktreeBranch` | `string?` | Git branch name (`worktree-<slug>`) |
| `originalHeadCommit` | `string?` | HEAD SHA at creation for change detection |
| `hookBased` | `boolean?` | True if created via VCS hook, not git |
| `creationDurationMs` | `number?` | Creation time (unset on resume) |

### `AttributionState`

Tracks Claude's contributions across a session. Key fields: `fileStates` (per-file content hash + character contribution), `sessionBaselines`, `promptCount`, `permissionPromptCount`, `escapeCount`, and surface identifier.

## Configuration & Defaults

| Setting / Env Var | Default | Description |
|-------------------|---------|-------------|
| `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` | `undefined` | Truthy value disables git instructions in prompts |
| `CLAUDE_CODE_BASE_REF` | (default branch) | Override base ref for single-file diffs |
| `settings.includeGitInstructions` | `true` | Setting-level control for git instructions |
| `settings.worktree.symlinkDirectories` | `[]` | Directories to symlink into worktrees (e.g., `["node_modules"]`) |
| `settings.worktree.sparsePaths` | `undefined` | Sparse-checkout cone paths for worktrees |

Diff limits: 5s timeout, 50 files max in perFileStats, 1MB per-file diff cap, 400 lines per file for hunks, 500 files threshold for shortstat-only mode.

## Edge Cases & Caveats

- **Bare repo detection** (`isCurrentDirectoryBareGitRepo`): Guards against a sandbox escape where an attacker creates `HEAD`, `objects/`, `refs/` in the CWD to trick git into treating it as a bare repo and executing hooks. Checks for valid `.git/HEAD` first; if missing/invalid, flags the presence of any bare-repo indicator.

- **Ref name validation**: All ref names read from `.git/HEAD` and loose ref files are validated against an allowlist (`[a-zA-Z0-9/._+@-]+`, no `..`, no leading `-` or `/`). This prevents path traversal and argument/shell injection from tampered `.git` files.

- **Transient git states**: Both `fetchGitDiff()` and `isGitTransientState()` check for sentinel files (`MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`, `rebase-apply`, `BISECT_LOG`). Diff calculation is skipped during these states since the working tree contains incoming changes.

- **V8 sliced string optimization**: In `parseGitDiff()`, hunk lines are copied via `'' + line` to break V8's sliced string references, which would otherwise keep the entire multi-MB diff string alive in memory.

- **Worktree slug flattening**: Forward slashes in slugs are replaced with `+` to avoid git ref D/F conflicts (a file `worktree-user` can't coexist with a directory `worktree-user/feature`) and directory nesting issues.

- **Shallow clone handling**: `preserveGitStateForIssue()` detects shallow clones by checking for `<commonDir>/shallow` and falls back to HEAD-only mode.

- **macOS symlink resolution**: `findCanonicalGitRoot()` uses `realpathSync` on the directory (not the `.git` file itself) to handle `/tmp` → `/private/tmp` symlinks without allowing an attacker to borrow a victim's backlink via a symlinked `.git` file.

- **Worktree mode**: `isWorktreeModeEnabled()` unconditionally returns `true` — the feature gate was removed because the cached-may-be-stale pattern returned `false` on first launch, silently swallowing the `--worktree` flag.