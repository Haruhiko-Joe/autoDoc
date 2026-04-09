# CommandRegistry

## Overview & Responsibilities

The CommandRegistry (`src/commands.ts`) is the central hub that assembles, filters, and exposes all slash commands available in the Claude Code CLI. It sits within the **CommandSystem** module, acting as the bridge between the TerminalUI (which dispatches user-typed `/` commands) and the 90+ individual command implementations spread across the codebase.

Its core responsibilities are:

- **Importing and assembling** all built-in command modules into a master list
- **Loading dynamic sources** — skills directories, plugin commands, workflow commands, bundled skills, and MCP skills
- **Filtering** commands by auth/provider availability (`claude-ai` vs `console`) and feature-flag enablement
- **Providing lookup utilities** (`findCommand`, `getCommand`, `hasCommand`) for other parts of the system
- **Defining safety sets** for remote mode (`REMOTE_SAFE_COMMANDS`) and bridge mode (`BRIDGE_SAFE_COMMANDS`)
- **Managing memoization caches** and their invalidation when dynamic commands change

The companion file `src/commands/createMovedToPluginCommand.ts` provides a factory for migrating built-in commands to the plugin marketplace ecosystem.

## Key Processes

### Command Assembly Flow

The master command list is built via a memoized `COMMANDS()` function (`src/commands.ts:258-346`) that returns an array of all statically-imported command objects. This function is deliberately lazy (not executed at module load time) because underlying functions read from config that isn't available during module initialization.

The assembly follows a priority order:
1. **Always-included commands** — ~70 commands imported at the top of the file (e.g., `clear`, `compact`, `config`, `help`, `review`)
2. **Feature-gated commands** — conditionally included via `feature()` flags from `bun:bundle` (e.g., `proactive`, `bridge`, `voiceCommand`, `workflowsCmd`)
3. **Auth-gated commands** — `login` and `logout` are only included when not using third-party services (`src/commands.ts:337`)
4. **Internal-only commands** — the `INTERNAL_ONLY_COMMANDS` array (`src/commands.ts:225-254`) is appended only when `USER_TYPE === 'ant'` and not in demo mode

### Dynamic Command Loading (`loadAllCommands`)

The `loadAllCommands` function (`src/commands.ts:449-469`) is memoized by `cwd` and loads all external command sources in parallel via `Promise.all`:

1. **Skills** (`getSkills`) — loads from four sub-sources concurrently:
   - Skill directory commands (`getSkillDirCommands`) — user-defined skills from `/skills/` directories
   - Plugin skills (`getPluginSkills`) — skills provided by installed plugins
   - Bundled skills (`getBundledSkills`) — skills shipped with Claude Code
   - Built-in plugin skills (`getBuiltinPluginSkillCommands`) — skills from enabled built-in plugins
2. **Plugin commands** (`getPluginCommands`) — slash commands defined by plugins
3. **Workflow commands** (`getWorkflowCommands`) — commands backed by workflow scripts (feature-gated behind `WORKFLOW_SCRIPTS`)

The final merged array places dynamic sources *before* built-in commands:
```
bundledSkills → builtinPluginSkills → skillDirCommands → workflowCommands → pluginCommands → pluginSkills → COMMANDS()
```

### Availability & Enablement Filtering (`getCommands`)

`getCommands(cwd)` (`src/commands.ts:476-517`) is the primary public API. It:

1. Calls `loadAllCommands(cwd)` to get the full (memoized) list
2. Retrieves any dynamic skills discovered during file operations via `getDynamicSkills()`
3. Filters every command through two checks:
   - `meetsAvailabilityRequirement(cmd)` — checks auth/provider type (not memoized, re-evaluated each call so `/login` takes effect immediately)
   - `isCommandEnabled(cmd)` — checks feature flags and runtime conditions
4. Deduplicates dynamic skills against the base command list by name
5. Inserts unique dynamic skills just before built-in commands in the final array

### Availability Check (`meetsAvailabilityRequirement`)

`meetsAvailabilityRequirement` (`src/commands.ts:417-443`) evaluates a command's `availability` field:

- **No `availability` field** → command is universal, always available
- **`'claude-ai'`** → available if `isClaudeAISubscriber()` returns true
- **`'console'`** → available if the user is a direct Console API key user (not claude.ai, not 3P services, and using a first-party Anthropic base URL)

A command with `availability: ['claude-ai', 'console']` passes if *any* of the listed conditions match.

## Function Signatures

### `getCommands(cwd: string): Promise<Command[]>`

Main entry point. Returns all commands available to the current user, filtered by availability and enablement. Not memoized at the top level — auth-sensitive filters run fresh each call.

### `findCommand(commandName: string, commands: Command[]): Command | undefined`

Looks up a command by name, computed name (`getCommandName`), or aliases. Returns `undefined` if not found.

> Source: `src/commands.ts:688-698`

### `getCommand(commandName: string, commands: Command[]): Command`

Like `findCommand` but throws a `ReferenceError` with a sorted list of available commands if not found.

> Source: `src/commands.ts:704-719`

### `hasCommand(commandName: string, commands: Command[]): boolean`

Convenience wrapper — returns `true` if `findCommand` finds a match.

> Source: `src/commands.ts:700-702`

### `meetsAvailabilityRequirement(cmd: Command): boolean`

Checks whether a command's `availability` requirement is met by the current user's auth state. Not memoized.

> Source: `src/commands.ts:417-443`

### `getSkillToolCommands(cwd: string): Promise<Command[]>`

Returns prompt-type commands the model can invoke via the SkillTool. Filters for `type === 'prompt'`, non-builtin source, and not disabled for model invocation. Memoized.

> Source: `src/commands.ts:563-581`

### `getSlashCommandToolSkills(cwd: string): Promise<Command[]>`

Returns the subset of commands that are "skills" — loaded from `skills`, `plugin`, or `bundled` sources, or explicitly marked with `disableModelInvocation`. Memoized, with error fallback to empty array.

> Source: `src/commands.ts:586-608`

### `getMcpSkillCommands(mcpCommands: readonly Command[]): readonly Command[]`

Filters MCP-provided commands to only those that are prompt-type, model-invocable skills. Gated by the `MCP_SKILLS` feature flag.

> Source: `src/commands.ts:547-559`

### `clearCommandsCache(): void`

Full cache invalidation — clears memoization caches for `loadAllCommands`, `getSkillToolCommands`, `getSlashCommandToolSkills`, plus plugin command/skill caches and skill directory caches.

> Source: `src/commands.ts:534-539`

### `clearCommandMemoizationCaches(): void`

Lighter invalidation — clears only the memoization layer without reloading skill/plugin caches. Used when dynamic skills are added mid-session.

> Source: `src/commands.ts:523-532`

### `formatDescriptionWithSource(cmd: Command): string`

Formats a command's description with a source annotation (e.g., `(workflow)`, `(plugin)`, `(bundled)`) for display in typeahead and help screens.

> Source: `src/commands.ts:728-754`

### `isBridgeSafeCommand(cmd: Command): boolean`

Returns whether a command is safe to execute when received over the Remote Control bridge. Prompt commands are always safe; local-jsx commands are always blocked; local commands need explicit inclusion in `BRIDGE_SAFE_COMMANDS`.

> Source: `src/commands.ts:672-676`

### `filterCommandsForRemoteMode(commands: Command[]): Command[]`

Filters a command array to only those in the `REMOTE_SAFE_COMMANDS` set. Used in `--remote` mode before CCR initialization.

> Source: `src/commands.ts:684-686`

## Interface/Type Definitions

### `Command` (from `src/types/command.ts:205-206`)

A discriminated union of `CommandBase` with one of three types:

| Type | Description |
|------|-------------|
| `prompt` | Expands to text content sent to the model (skills, review, commit) |
| `local` | Executes locally and returns a text result (compact, cost) |
| `local-jsx` | Renders an Ink (React) UI component (config, mcp, doctor) |

### `CommandBase` (from `src/types/command.ts:175-203`)

Common fields shared by all command types:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Primary slash-command name |
| `description` | `string` | Human-readable description |
| `aliases` | `string[]?` | Alternative names |
| `availability` | `CommandAvailability[]?` | Auth/provider restrictions |
| `isEnabled` | `() => boolean?` | Runtime feature-flag check |
| `isHidden` | `boolean?` | Whether to hide from typeahead/help |
| `loadedFrom` | `string?` | Source: `'skills'`, `'plugin'`, `'bundled'`, `'mcp'`, etc. |
| `kind` | `'workflow'?` | Badge for workflow-backed commands |
| `disableModelInvocation` | `boolean?` | Prevent model from invoking this command |
| `userInvocable` | `boolean?` | Whether users can invoke via `/skill-name` |
| `immediate` | `boolean?` | Bypass queue, execute immediately |

### `CommandAvailability` (from `src/types/command.ts:169-173`)

- `'claude-ai'` — Claude.ai OAuth subscriber (Pro/Max/Team/Enterprise)
- `'console'` — Direct Console API key user (api.anthropic.com)

## The `createMovedToPluginCommand` Helper

`src/commands/createMovedToPluginCommand.ts` provides a factory for commands that have been migrated to the plugin marketplace. It accepts configuration options including the plugin name, command name, and a fallback prompt function, then returns a `Command` object. When invoked:

- **Internal users** (`USER_TYPE === 'ant'`): Receive instructions to install the plugin via `claude plugin install <pluginName>@claude-code-marketplace` (`src/commands/createMovedToPluginCommand.ts:44-57`)
- **External users**: Fall back to `getPromptWhileMarketplaceIsPrivate()`, which provides the original behavior until the marketplace is publicly available (`src/commands/createMovedToPluginCommand.ts:62`)

This allows gradual migration of built-in commands to the plugin ecosystem without breaking existing users.

## Safety Sets

### `REMOTE_SAFE_COMMANDS` (`src/commands.ts:619-637`)

Commands safe to use in `--remote` mode. These only affect local TUI state and don't depend on the local filesystem, git, shell, or IDE context. Includes: `session`, `exit`, `clear`, `help`, `theme`, `color`, `vim`, `cost`, `usage`, `copy`, `btw`, `feedback`, `plan`, `keybindings`, `statusline`, `stickers`, `mobile`.

### `BRIDGE_SAFE_COMMANDS` (`src/commands.ts:651-660`)

Built-in `local`-type commands safe to execute when received over the Remote Control bridge (mobile/web client). Includes: `compact`, `clear`, `cost`, `summary`, `releaseNotes`, `files`. Note that `prompt`-type commands are always allowed over the bridge (they expand to text), and `local-jsx` commands are always blocked (they render Ink UI).

## Configuration & Feature Flags

The module uses `feature()` from `bun:bundle` for dead-code elimination at build time. Feature-gated commands include:

| Feature Flag | Command(s) |
|-------------|-----------|
| `PROACTIVE` / `KAIROS` | `proactive` |
| `KAIROS` / `KAIROS_BRIEF` | `briefCommand` |
| `KAIROS` | `assistantCommand` |
| `BRIDGE_MODE` | `bridge` |
| `DAEMON` + `BRIDGE_MODE` | `remoteControlServerCommand` |
| `VOICE_MODE` | `voiceCommand` |
| `HISTORY_SNIP` | `forceSnip` |
| `WORKFLOW_SCRIPTS` | `workflowsCmd`, `getWorkflowCommands` |
| `CCR_REMOTE_SETUP` | `webCmd` |
| `EXPERIMENTAL_SKILL_SEARCH` | `clearSkillIndexCache` |
| `MCP_SKILLS` | `getMcpSkillCommands` filtering |
| `ULTRAPLAN` | `ultraplan` |
| `TORCH` | `torch` |
| `UDS_INBOX` | `peersCmd` |
| `FORK_SUBAGENT` | `forkCmd` |
| `BUDDY` | `buddy` |

The `insights` command uses a lazy-loading shim (`src/commands.ts:190-202`) to defer loading its 113KB module until actually invoked.

## Edge Cases & Caveats

- **Memoization vs. freshness trade-off**: `loadAllCommands` is memoized by `cwd` for performance (disk I/O, dynamic imports), but `meetsAvailabilityRequirement` and `isCommandEnabled` are intentionally *not* memoized so that auth state changes (e.g., after `/login`) take effect immediately on the next `getCommands()` call.
- **Internal-only commands**: The `INTERNAL_ONLY_COMMANDS` array is only appended when `USER_TYPE === 'ant'` and `IS_DEMO` is not set. External builds eliminate these entirely.
- **The `agentsPlatform` command** uses `require()` instead of `import` and is gated on `USER_TYPE === 'ant'` at runtime (not build-time feature flags).
- **Dynamic skills deduplication**: Dynamic skills discovered during file operations are deduplicated by name against existing commands and inserted just before built-in commands in the ordering.
- **Cache invalidation layers**: `clearCommandMemoizationCaches()` only clears the lodash memoize caches (lighter), while `clearCommandsCache()` also clears plugin and skill source caches (full reload). The skill search index (`clearSkillIndexCache`) must be cleared explicitly because it's a separate memoization layer on top of the command caches.
- **Bridge safety model**: The `isBridgeSafeCommand` function was introduced after PR #19134 discovered that commands like `/model` from iOS were popping local Ink pickers. The allowlist approach blocks `local-jsx` commands entirely, allows all `prompt` commands, and requires explicit opt-in for `local` commands.