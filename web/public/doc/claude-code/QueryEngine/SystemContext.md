# SystemContext

## Overview & Responsibilities

The SystemContext module (`src/context.ts`) builds the ambient context that gets prepended to every Claude conversation. It produces two independent context objects — **system context** (git repository state, optional cache-breaking injection) and **user context** (CLAUDE.md instructions, current date) — and memoizes both so the potentially expensive I/O (git commands, filesystem walks) only runs once per conversation.

Within the QueryEngine pipeline, this module sits at the very beginning of a query turn: before any user message is sent to the Claude API, the query engine calls `getSystemContext()` and `getUserContext()` to obtain the key-value maps that populate the system prompt. It depends on infrastructure utilities for git operations, environment detection, and CLAUDE.md file discovery.

## Key Processes

### System Context Construction (`getSystemContext`)

1. **Check skip conditions** — If running in Claude Code Remote (`CLAUDE_CODE_REMOTE` env var) or git instructions are disabled via settings, git status is skipped entirely (`src/context.ts:124-128`).
2. **Gather git status** — Delegates to `getGitStatus()` which runs five git commands in parallel (`src/context.ts:61-77`):
   - `getBranch()` — current branch name
   - `getDefaultBranch()` — main/master branch name
   - `git status --short` — working tree changes
   - `git log --oneline -n 5` — last 5 commits
   - `git config user.name` — committer identity
3. **Truncate large status** — If `git status` output exceeds 2000 characters, it is truncated with a hint to use BashTool for full output (`src/context.ts:85-89`).
4. **Format git status string** — Assembles a human-readable multi-section string: branch, main branch, optional git user, status, and recent commits (`src/context.ts:96-103`).
5. **Attach cache breaker** — If the `BREAK_CACHE_COMMAND` feature flag is enabled and an injection string is set, appends a `cacheBreaker` key to the result (`src/context.ts:131-148`).
6. **Return memoized result** — The entire function is wrapped in `lodash memoize`, so subsequent calls return the cached object.

### User Context Construction (`getUserContext`)

1. **Check CLAUDE.md disable conditions** — CLAUDE.md loading is skipped when `CLAUDE_CODE_DISABLE_CLAUDE_MDS` is truthy, or when running in bare mode (`--bare`) without explicit `--add-dir` directories (`src/context.ts:165-167`).
2. **Load memory files and CLAUDE.md** — Calls `getMemoryFiles()` (async filesystem walk), filters through `filterInjectedMemoryFiles()`, then passes to `getClaudeMds()` to produce the combined CLAUDE.md content string (`src/context.ts:170-172`).
3. **Cache for downstream consumers** — Stores the result via `setCachedClaudeMdContent()` so that the auto-mode classifier (`yoloClassifier.ts`) can read it without creating an import cycle (`src/context.ts:176`).
4. **Return context map** — Returns an object with `claudeMd` (if present) and `currentDate` (always present, formatted as `"Today's date is YYYY-MM-DD."`) (`src/context.ts:184-187`).

## Function Signatures

### `getGitStatus(): Promise<string | null>`

Memoized async function. Runs git commands to build a snapshot of the repository state.

- **Returns**: A formatted multi-line string containing branch, main branch, user name, working tree status, and recent commits — or `null` if not in a git repo, in test mode, or on error.

### `getSystemContext(): Promise<{ [k: string]: string }>`

Memoized async function. Builds the system-level context map.

- **Returns**: Object with optional keys:
  - `gitStatus` — formatted git status string (omitted in remote mode or non-git directories)
  - `cacheBreaker` — injection string wrapped in `[CACHE_BREAKER: ...]` (only when feature flag is active and injection is set)

### `getUserContext(): Promise<{ [k: string]: string }>`

Memoized async function. Builds the user-level context map.

- **Returns**: Object with keys:
  - `claudeMd` (optional) — combined content from all discovered CLAUDE.md and memory files
  - `currentDate` — always present, e.g. `"Today's date is 2026-04-08."`

### `getSystemPromptInjection(): string | null`

Returns the current cache-breaking injection string, or `null`.

### `setSystemPromptInjection(value: string | null): void`

Sets the cache-breaking injection string and **immediately invalidates** both memoized context caches (`getUserContext` and `getSystemContext`) so the next call recomputes them (`src/context.ts:29-34`).

- **value**: The injection string to set, or `null` to clear it.

## Configuration & Defaults

| Mechanism | Effect |
|---|---|
| `CLAUDE_CODE_REMOTE` env var | When truthy, git status is skipped (reduces overhead in remote sessions) |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` env var | When truthy, CLAUDE.md loading is completely disabled |
| `--bare` CLI flag | Skips CLAUDE.md auto-discovery; explicit `--add-dir` directories are still honored |
| `BREAK_CACHE_COMMAND` feature flag | Gates the cache-breaking injection feature (internal/debugging use) |
| `MAX_STATUS_CHARS` constant | `2000` — hard limit on git status output length before truncation |

## Edge Cases & Caveats

- **Memoization is conversation-scoped**: Both `getSystemContext` and `getUserContext` use `lodash memoize` with no arguments, meaning they compute once and cache forever within a process. The git status is explicitly described as "a snapshot in time" that "will not update during the conversation." This is intentional — tools like BashTool can run live `git status` when needed.

- **Cache invalidation on injection change**: `setSystemPromptInjection()` clears both context caches via `cache.clear?.()` (the optional chaining guards against memoize implementations that lack a `clear` method). This is the only code path that forces recomputation.

- **Test environment short-circuit**: `getGitStatus()` returns `null` immediately when `NODE_ENV === 'test'` to avoid test-time side effects and import cycles (`src/context.ts:37-40`).

- **Bare mode semantics**: `--bare` means "skip what I didn't ask for" — it disables auto-discovery of CLAUDE.md files but still loads directories explicitly specified via `--add-dir`. This subtle distinction is enforced at `src/context.ts:165-167`.

- **Cycle avoidance**: The CLAUDE.md content is cached via `setCachedClaudeMdContent()` specifically to break an import cycle: `claudemd.ts → permissions/filesystem → permissions → yoloClassifier → claudemd.ts`. The classifier reads the cached value instead of importing the module directly.

- **`--no-optional-locks` flag**: Git commands use `--no-optional-locks` to avoid creating lock files that could interfere with concurrent git operations (e.g., IDE-triggered git operations running simultaneously).

## Key Code Snippets

### Parallel git command execution

Five git commands run concurrently via `Promise.all` to minimize startup latency:

```typescript
// src/context.ts:61-77
const [branch, mainBranch, status, log, userName] = await Promise.all([
  getBranch(),
  getDefaultBranch(),
  execFileNoThrow(gitExe(), ['--no-optional-locks', 'status', '--short'], {
    preserveOutputOnError: false,
  }).then(({ stdout }) => stdout.trim()),
  execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'log', '--oneline', '-n', '5'],
    { preserveOutputOnError: false },
  ).then(({ stdout }) => stdout.trim()),
  execFileNoThrow(gitExe(), ['config', 'user.name'], {
    preserveOutputOnError: false,
  }).then(({ stdout }) => stdout.trim()),
])
```

### CLAUDE.md disable logic

The two-condition check implements the nuanced `--bare` semantics:

```typescript
// src/context.ts:165-167
const shouldDisableClaudeMd =
  isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
  (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)
```