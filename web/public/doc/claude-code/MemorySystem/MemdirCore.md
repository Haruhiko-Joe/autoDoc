# MemdirCore

## Overview & Responsibilities

MemdirCore is the foundational infrastructure for Claude Code's persistent, file-based memory system. It sits within the **MemorySystem** module — a sibling to modules like QueryEngine and ToolSystem — and provides the machinery that lets Claude remember information across conversations.

This module has three core responsibilities:

1. **Path resolution** (`src/memdir/paths.ts`): Determines where on disk the memory directory lives, with a multi-layer override chain (env vars → settings → default convention).
2. **Memory type taxonomy** (`src/memdir/memoryTypes.ts`): Defines the four permitted memory types (`user`, `feedback`, `project`, `reference`) and the prompt text that teaches the model how to use each one.
3. **Prompt building** (`src/memdir/memdir.ts`): Assembles the system-prompt text that instructs the model on how to read, write, and recall memories — including loading the `MEMORY.md` entrypoint index.

The prompt text generated here is injected into the system prompt by the QueryEngine, making the model aware of the memory directory, its conventions, and its current contents.

## Key Processes

### Memory Directory Path Resolution

When Claude Code starts a session, the system needs to determine where to store memories. `getAutoMemPath()` (`src/memdir/paths.ts:223-235`) resolves this through a priority chain:

1. **`CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`** env var — used by Cowork/SDK to redirect memory to a space-scoped mount
2. **`autoMemoryDirectory`** in settings.json — from trusted sources only (policy, flag, local, user settings; project settings are excluded for security)
3. **Default**: `~/.claude/projects/<sanitized-git-root>/memory/`

All candidate paths pass through `validateMemoryPath()` (`src/memdir/paths.ts:109-150`), which rejects dangerous inputs: relative paths, root/near-root paths, UNC paths, null bytes, and Windows drive-roots. For settings.json paths, `~/` expansion is supported; env var overrides must be absolute.

The function is **memoized** on `getProjectRoot()` because render-path callers invoke it frequently per message re-render.

### Deciding Whether Memory Is Enabled

`isAutoMemoryEnabled()` (`src/memdir/paths.ts:30-55`) evaluates a priority chain:

1. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env var (truthy → OFF, falsy → ON)
2. `CLAUDE_CODE_SIMPLE` / `--bare` mode → OFF
3. Remote mode (`CLAUDE_CODE_REMOTE`) without `CLAUDE_CODE_REMOTE_MEMORY_DIR` → OFF
4. `autoMemoryEnabled` in settings.json
5. Default: **enabled**

### System Prompt Injection

The main entry point is `loadMemoryPrompt()` (`src/memdir/memdir.ts:419-507`), called once per session. It dispatches based on the active mode:

```
loadMemoryPrompt()
  ├─ KAIROS active?        → buildAssistantDailyLogPrompt()   [append-only log mode]
  ├─ TEAMMEM + team enabled? → buildCombinedMemoryPrompt()    [private + team dirs]
  ├─ auto memory enabled?  → buildMemoryLines()               [single directory]
  └─ all disabled          → null (+ telemetry)
```

Each branch ensures the memory directory exists via `ensureMemoryDirExists()` before returning prompt text.

### Prompt Assembly (Individual Mode)

`buildMemoryLines()` (`src/memdir/memdir.ts:199-266`) constructs the prompt as an array of lines, composing sections from `memoryTypes.ts`:

1. Header with the memory directory path and existence guidance
2. **Types of memory** — the four-type taxonomy with descriptions, when-to-save triggers, how-to-use guidance, and examples
3. **What NOT to save** — explicit exclusions (code patterns, git history, debugging solutions, CLAUDE.md content, ephemeral task details)
4. **How to save** — two-step process (write file with frontmatter → update `MEMORY.md` index), or single-step if `skipIndex` is true
5. **When to access** — access triggers, mandatory recall rules, ignore semantics, drift caveats
6. **Before recommending from memory** — verification instructions (check file exists, grep for functions)
7. **Memory vs. other persistence** — guidance on when to use plans or tasks instead
8. **Searching past context** — grep instructions for memory files and session transcripts (feature-gated)

`buildMemoryPrompt()` (`src/memdir/memdir.ts:272-316`) wraps `buildMemoryLines()` and appends the actual `MEMORY.md` content (or an empty-state message), used by agent memory contexts.

### MEMORY.md Entrypoint Truncation

`MEMORY.md` is an index file that's always loaded into the conversation context. To prevent it from consuming excessive tokens, `truncateEntrypointContent()` (`src/memdir/memdir.ts:57-103`) enforces two caps:

- **Line cap**: 200 lines (`MAX_ENTRYPOINT_LINES`)
- **Byte cap**: 25,000 bytes (`MAX_ENTRYPOINT_BYTES`)

Line truncation is applied first (natural boundary), then byte truncation at the last newline before the cap. A `WARNING` message is appended naming which cap fired, guiding the model to keep index entries concise.

### Assistant Daily-Log Mode (KAIROS)

`buildAssistantDailyLogPrompt()` (`src/memdir/memdir.ts:327-370`) generates an alternative prompt for long-lived assistant sessions. Instead of maintaining `MEMORY.md` as a live index, the model appends timestamped bullets to a daily log file at `<memoryDir>/logs/YYYY/MM/YYYY-MM-DD.md`. A separate nightly `/dream` skill distills these logs into topic files and `MEMORY.md`.

## Function Signatures

### `isAutoMemoryEnabled(): boolean`
Returns whether the memory system is active for this session. Checks env vars, settings, and mode flags.
> `src/memdir/paths.ts:30-55`

### `getAutoMemPath(): string`
Returns the canonical memory directory path (with trailing separator). Memoized on project root.
> `src/memdir/paths.ts:223-235`

### `getAutoMemEntrypoint(): string`
Returns the full path to `MEMORY.md` inside the auto-memory directory.
> `src/memdir/paths.ts:257-259`

### `getAutoMemDailyLogPath(date?: Date): string`
Returns the daily log file path for KAIROS mode: `<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md`.
> `src/memdir/paths.ts:246-251`

### `isAutoMemPath(absolutePath: string): boolean`
Checks if a given absolute path falls within the auto-memory directory. Normalizes the path to prevent traversal bypasses.
> `src/memdir/paths.ts:274-278`

### `hasAutoMemPathOverride(): boolean`
Returns whether `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` is set to a valid path. Used to decide write-permission carve-outs.
> `src/memdir/paths.ts:194-196`

### `loadMemoryPrompt(): Promise<string | null>`
Main entry point. Returns the complete memory prompt for system-prompt injection, or `null` if memory is disabled.
> `src/memdir/memdir.ts:419-507`

### `buildMemoryLines(displayName, memoryDir, extraGuidelines?, skipIndex?): string[]`
Builds the behavioral instruction lines (without `MEMORY.md` content). Used for system-prompt injection where content is provided separately.
> `src/memdir/memdir.ts:199-266`

### `buildMemoryPrompt({ displayName, memoryDir, extraGuidelines? }): string`
Builds the full prompt including `MEMORY.md` content. Used by agent memory contexts.
> `src/memdir/memdir.ts:272-316`

### `truncateEntrypointContent(raw: string): EntrypointTruncation`
Truncates `MEMORY.md` to line and byte caps. Returns the truncated content plus metadata about whether truncation occurred.
> `src/memdir/memdir.ts:57-103`

### `ensureMemoryDirExists(memoryDir: string): Promise<void>`
Idempotently creates the memory directory. Errors are logged but not thrown — the model's Write tool will surface real permission errors.
> `src/memdir/memdir.ts:129-147`

### `parseMemoryType(raw: unknown): MemoryType | undefined`
Parses a raw frontmatter value into one of the four valid memory types. Returns `undefined` for invalid/missing values.
> `src/memdir/memoryTypes.ts:28-31`

## Type Definitions

### `MemoryType`
Union type: `'user' | 'feedback' | 'project' | 'reference'`
> `src/memdir/memoryTypes.ts:21`

### `EntrypointTruncation`

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | The (possibly truncated) entrypoint content |
| `lineCount` | `number` | Original line count before truncation |
| `byteCount` | `number` | Original byte count before truncation |
| `wasLineTruncated` | `boolean` | Whether the line cap (200) was exceeded |
| `wasByteTruncated` | `boolean` | Whether the byte cap (25KB) was exceeded |

> `src/memdir/memdir.ts:41-47`

## Configuration & Defaults

| Setting / Env Var | Purpose | Default |
|---|---|---|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Disable memory entirely | Not set (memory enabled) |
| `CLAUDE_CODE_SIMPLE` | Bare mode, disables memory | Not set |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | Base directory for remote memory storage | Not set |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | Full path override for Cowork/SDK | Not set |
| `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` | Extra policy text injected into prompt | Not set |
| `autoMemoryEnabled` (settings.json) | Toggle memory on/off | `true` |
| `autoMemoryDirectory` (settings.json) | Custom memory directory (supports `~/`) | Computed from git root |
| `MAX_ENTRYPOINT_LINES` | Line cap for MEMORY.md | 200 |
| `MAX_ENTRYPOINT_BYTES` | Byte cap for MEMORY.md | 25,000 |

## The Memory Type Taxonomy

The module enforces a closed four-type taxonomy. Each type has distinct save triggers and usage patterns:

- **`user`**: Who the user is — role, expertise, preferences. Always private. Triggers: learning about the user's background.
- **`feedback`**: How to approach work — corrections AND confirmed approaches. Triggers: user corrects or validates behavior.
- **`project`**: Non-code-derivable project context — deadlines, incidents, decisions. Triggers: learning who/what/why/when.
- **`reference`**: Pointers to external systems — dashboards, trackers, channels. Triggers: learning about external resources.

Two variants of the type section exist: `TYPES_SECTION_INDIVIDUAL` (no scope tags, for single-directory mode) and `TYPES_SECTION_COMBINED` (with `<scope>` tags distinguishing private vs. team, for combined mode).

## Edge Cases & Caveats

- **Security: project settings excluded** — `autoMemoryDirectory` from `.claude/settings.json` (committed to repo) is intentionally ignored. A malicious repo could set it to `~/.ssh` and gain write access via the memory carve-out (`src/memdir/paths.ts:169-186`).
- **Path validation rejects dangerous inputs** — `validateMemoryPath()` blocks relative paths, root paths, UNC paths, null bytes, and bare `~` expansion that would match all of `$HOME`.
- **Worktree sharing** — `getAutoMemBase()` uses `findCanonicalGitRoot()` so all git worktrees of the same repo share one memory directory.
- **Memoization** — `getAutoMemPath()` is memoized on project root. Tests that change the mock mid-block must call `getAutoMemPath.cache.clear()`.
- **KAIROS and TEAMMEM don't compose** — The daily-log paradigm doesn't work with team sync (which expects a shared `MEMORY.md`). KAIROS takes precedence when both are active.
- **Prompt caching across midnight** — `buildAssistantDailyLogPrompt()` uses a path *pattern* (`YYYY-MM-DD`) rather than today's literal date, because the prompt is cached and not invalidated on date change.
- **Feature gates** — Several behaviors are controlled by GrowthBook flags: `tengu_coral_fern` (searching past context section), `tengu_moth_copse` (skip index), `tengu_herring_clock` (team memory cohort tracking), `tengu_passport_quail` / `tengu_slate_thimble` (extract mode).