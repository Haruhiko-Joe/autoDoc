# Skill Framework

## Overview & Responsibilities

The Skill Framework is the core skill loading and registration infrastructure within the **SkillsAndPlugins** module. It is responsible for three concerns:

1. **Bundled skill registration** — an in-process registry that lets compiled-in skills register themselves at startup and be resolved as `Command` objects.
2. **Filesystem skill loading** — discovers and parses user-defined skills from `.claude/skills/` directories (and legacy `.claude/commands/` directories) across multiple setting sources (managed/policy, user, project).
3. **MCP skill builder bridge** — a write-once dependency-inversion registry that exposes the skill creation functions to the MCP subsystem without introducing circular imports.

The framework sits between the **Infrastructure** layer (config directories, settings, file system) and the **ToolSystem** (which invokes skills via the `SkillTool`). Sibling modules in **SkillsAndPlugins** include the plugin loader and recommendation system.

The three source files map cleanly to the three concerns:

| File | Responsibility |
|------|---------------|
| `bundledSkills.ts` | In-process registry for compiled-in skills, plus secure file extraction |
| `loadSkillsDir.ts` | Filesystem discovery, frontmatter parsing, command construction, deduplication, conditional/dynamic skill management |
| `mcpSkillBuilders.ts` | Dependency-leaf registry bridging `loadSkillsDir` functions to MCP code |

## Key Processes

### Bundled Skill Registration Flow

1. At module initialization, a bundled skill calls `registerBundledSkill(definition)` with a `BundledSkillDefinition` (`src/skills/bundledSkills.ts:53-100`).
2. If the definition includes `files` (reference files to extract to disk), the registration wraps `getPromptForCommand` in a lazy-extraction closure. Extraction is memoized at the *promise* level so concurrent callers await a single write rather than racing (`src/skills/bundledSkills.ts:64-67`).
3. The definition is converted to a `Command` object (with `source: 'bundled'`, `loadedFrom: 'bundled'`) and pushed into the module-level `bundledSkills` array.
4. Consumers call `getBundledSkills()` to get a defensive copy of the registry (`src/skills/bundledSkills.ts:106-108`).

### Filesystem Skill Loading Flow

The main entry point is the memoized `getSkillDirCommands(cwd)` function (`src/skills/loadSkillsDir.ts:638-804`):

1. **Resolve directories** — computes skill directory paths for three setting sources:
   - **Managed** (policy): `<managedFilePath>/.claude/skills/`
   - **User**: `~/.claude/skills/`
   - **Project**: walks parent directories up to `$HOME`, checking `.claude/skills/` at each level
   - **Additional**: explicit `--add-dir` paths
   - **Legacy**: `.claude/commands/` directories
2. **Bare mode shortcut** — in `--bare` mode, only `--add-dir` paths are loaded; all auto-discovery is skipped (`src/skills/loadSkillsDir.ts:658-675`).
3. **Parallel loading** — all five sources are loaded concurrently via `Promise.all` (`src/skills/loadSkillsDir.ts:679-714`).
4. **Per-directory loading** (`loadSkillsFromSkillsDir`, line 407) — reads directory entries, looks for `<skill-name>/SKILL.md`, parses frontmatter, and calls `createSkillCommand`.
5. **Deduplication** — resolves symlinks via `realpath` to canonical paths, then deduplicates by file identity. First-seen wins (`src/skills/loadSkillsDir.ts:728-763`).
6. **Conditional skill separation** — skills with a `paths` frontmatter field are held back in a `conditionalSkills` map and only activated when a matching file is touched (`src/skills/loadSkillsDir.ts:771-796`).

### Frontmatter Parsing

`parseSkillFrontmatterFields()` (`src/skills/loadSkillsDir.ts:185-265`) extracts all metadata from the YAML frontmatter of a `SKILL.md` file:

- `description`, `name` (display name), `when_to_use`
- `allowed-tools` → parsed into a string array
- `arguments`, `argument-hint` → for argument substitution
- `model` → parsed via `parseUserSpecifiedModel` (or `undefined` if `'inherit'`)
- `user-invocable`, `disable-model-invocation` → boolean flags
- `hooks` → validated against `HooksSchema`
- `context` → `'fork'` or undefined
- `agent`, `effort`, `shell`, `version`

### Command Construction

`createSkillCommand()` (`src/skills/loadSkillsDir.ts:270-401`) builds a `Command` object. The key behavior is in `getPromptForCommand`:

1. Prepends a `Base directory for this skill: <dir>` header if the skill has a directory.
2. Performs `${arg}` substitution via `substituteArguments`.
3. Replaces `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}` template variables.
4. For non-MCP skills, executes inline shell commands (`!\`…\``) in the prompt body. **MCP skills are explicitly excluded** from shell execution for security (`src/skills/loadSkillsDir.ts:374`).

### Dynamic Skill Discovery

During a session, when files are read or written, the framework can discover new skill directories:

1. `discoverSkillDirsForPaths(filePaths, cwd)` (`src/skills/loadSkillsDir.ts:861-915`) walks from each file's parent up to (but not including) cwd, checking for `.claude/skills/` directories. Gitignored directories are skipped.
2. `addSkillDirectories(dirs)` (`src/skills/loadSkillsDir.ts:923-975`) loads from discovered directories and merges into the `dynamicSkills` map. Deeper paths override shallower ones.
3. A signal (`skillsLoaded`) is emitted so other modules can clear caches.

### Conditional Skill Activation

`activateConditionalSkillsForPaths(filePaths, cwd)` (`src/skills/loadSkillsDir.ts:997-1058`) checks if any pending conditional skills match the given file paths using gitignore-style pattern matching (via the `ignore` library). Matched skills are moved from the `conditionalSkills` map into `dynamicSkills`, making them available to the model.

### MCP Skill Builder Bridge

The `mcpSkillBuilders.ts` module (`src/skills/mcpSkillBuilders.ts:1-44`) solves a circular dependency problem:

1. It imports only *types* from `loadSkillsDir.ts`, making it a dependency-graph leaf.
2. At `loadSkillsDir.ts` module init, `registerMCPSkillBuilders({ createSkillCommand, parseSkillFrontmatterFields })` is called (`src/skills/loadSkillsDir.ts:1083-1086`).
3. MCP server code calls `getMCPSkillBuilders()` to obtain the functions, throwing if registration hasn't happened yet.

This avoids both the runtime failure of variable-specifier dynamic imports in Bun-bundled binaries and the dependency-cruiser cycle violations of literal dynamic imports.

## Function Signatures

### `registerBundledSkill(definition: BundledSkillDefinition): void`

Registers a compiled-in skill into the in-process registry. Wraps `getPromptForCommand` with lazy file extraction if `definition.files` is non-empty.

> `src/skills/bundledSkills.ts:53`

### `getBundledSkills(): Command[]`

Returns a shallow copy of all registered bundled skills.

> `src/skills/bundledSkills.ts:106`

### `getSkillDirCommands(cwd: string): Promise<Command[]>`

Memoized. Loads all filesystem-based skills (managed, user, project, additional, legacy) and returns deduplicated unconditional skills. Conditional skills are stored internally for later activation.

> `src/skills/loadSkillsDir.ts:638`

### `parseSkillFrontmatterFields(frontmatter, markdownContent, resolvedName, descriptionFallbackLabel?): {...}`

Parses all skill metadata from frontmatter. Shared between file-based and MCP skill loading.

> `src/skills/loadSkillsDir.ts:185`

### `createSkillCommand({...}): Command`

Constructs a `Command` object from parsed skill data, including the `getPromptForCommand` function with template variable substitution and shell execution.

> `src/skills/loadSkillsDir.ts:270`

### `discoverSkillDirsForPaths(filePaths: string[], cwd: string): Promise<string[]>`

Walks from file paths up to cwd, discovering `.claude/skills/` directories. Skips gitignored paths. Returns directories sorted deepest-first.

> `src/skills/loadSkillsDir.ts:861`

### `addSkillDirectories(dirs: string[]): Promise<void>`

Loads skills from discovered directories into the dynamic skills map. Emits `skillsLoaded` signal.

> `src/skills/loadSkillsDir.ts:923`

### `activateConditionalSkillsForPaths(filePaths: string[], cwd: string): string[]`

Activates path-filtered conditional skills that match the given file paths. Returns names of newly activated skills.

> `src/skills/loadSkillsDir.ts:997`

### `getMCPSkillBuilders(): MCPSkillBuilders`

Returns `{ createSkillCommand, parseSkillFrontmatterFields }`. Throws if called before `loadSkillsDir.ts` has been evaluated.

> `src/skills/mcpSkillBuilders.ts:37`

## Interface & Type Definitions

### `BundledSkillDefinition`

(`src/skills/bundledSkills.ts:15-41`)

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Skill command name |
| `description` | `string` | Human-readable description |
| `aliases` | `string[]` | Optional alternative names |
| `whenToUse` | `string` | Hint for the model on when to invoke |
| `argumentHint` | `string` | Hint for argument format |
| `allowedTools` | `string[]` | Tools the skill is permitted to use |
| `model` | `string` | Model override |
| `disableModelInvocation` | `boolean` | Prevent model from invoking this skill |
| `userInvocable` | `boolean` | Whether users can type `/name` to invoke |
| `isEnabled` | `() => boolean` | Dynamic enable/disable check |
| `hooks` | `HooksSettings` | Lifecycle hooks |
| `context` | `'inline' \| 'fork'` | Execution context |
| `agent` | `string` | Agent type override |
| `files` | `Record<string, string>` | Reference files to extract to disk (relative path → content) |
| `getPromptForCommand` | `(args, context) => Promise<ContentBlockParam[]>` | Produces the skill's prompt content |

### `LoadedFrom`

(`src/skills/loadSkillsDir.ts:67-74`)

```typescript
type LoadedFrom = 'commands_DEPRECATED' | 'skills' | 'plugin' | 'managed' | 'bundled' | 'mcp'
```

Tracks the origin of a loaded skill for deduplication and security decisions (e.g., MCP skills skip shell execution).

### `MCPSkillBuilders`

(`src/skills/mcpSkillBuilders.ts:26-29`)

```typescript
type MCPSkillBuilders = {
  createSkillCommand: typeof createSkillCommand
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
}
```

## Configuration & Defaults

- **Skill directory structure**: Skills must be in `<skill-name>/SKILL.md` format within a `skills/` directory.
- **Legacy support**: The `commands/` directory is also scanned, supporting both `SKILL.md` and plain `.md` files (`loadedFrom: 'commands_DEPRECATED'`).
- **Setting sources**: Controlled by `isSettingSourceEnabled()` — `policySettings`, `userSettings`, `projectSettings` can each be independently enabled/disabled.
- **`CLAUDE_CODE_DISABLE_POLICY_SKILLS`**: Environment variable that skips loading managed/policy skills.
- **`--bare` mode**: Disables all auto-discovery; only `--add-dir` paths are loaded.
- **Plugin-only policy**: When `isRestrictedToPluginOnly('skills')` is true, only plugin-sourced skills load.
- **`user-invocable`**: Defaults to `true`. When `false`, the skill is hidden and can only be invoked by the model.
- **`disableModelInvocation`**: Defaults to `false`. When `true`, only users can invoke the skill.
- **Memoization**: `getSkillDirCommands` is memoized per `cwd`. Call `clearSkillCaches()` to reset.

## Edge Cases & Caveats

- **Symlink-safe file extraction**: Bundled skill reference files are written with `O_EXCL | O_NOFOLLOW` flags and `0o600` permissions. The extraction directory uses a per-process nonce from `getBundledSkillsRoot()` to defend against pre-created symlink attacks. On write failure, the skill continues without the base-directory prefix rather than crashing (`src/skills/bundledSkills.ts:169-193`).

- **Path traversal protection**: `resolveSkillFilePath()` rejects relative paths containing `..` or absolute paths, throwing an error to prevent escaping the skill directory (`src/skills/bundledSkills.ts:196-206`).

- **MCP shell execution block**: Skills loaded from MCP (`loadedFrom === 'mcp'`) have inline shell commands (`!\`…\``) in their markdown body explicitly skipped. This is a security measure since MCP skills are remote and untrusted (`src/skills/loadSkillsDir.ts:374`).

- **Deduplication via realpath**: Skills loaded from multiple paths (e.g., via symlinks or overlapping parent directories) are deduplicated by resolving to canonical paths. First-seen wins, so managed > user > project precedence is preserved.

- **Conditional skills survive cache clears**: The `activatedConditionalSkillNames` set persists across `getSkillDirCommands` cache clears within a session, preventing re-evaluation of already-activated skills (`src/skills/loadSkillsDir.ts:829`).

- **Windows compatibility**: `safeWriteFile` uses string flags (`'wx'`) instead of numeric `O_EXCL` on Windows to avoid `EINVAL` through libuv (`src/skills/bundledSkills.ts:178-184`). `${CLAUDE_SKILL_DIR}` normalizes backslashes to forward slashes on Windows.

- **Promise-level memoization**: Bundled skill file extraction memoizes the *promise* (not the result), ensuring that concurrent invocations of the same skill await a single extraction rather than racing (`src/skills/bundledSkills.ts:62-67`).

- **Gitignored skill directories**: Dynamically discovered skill directories inside gitignored paths (e.g., `node_modules/`) are skipped (`src/skills/loadSkillsDir.ts:892-897`).