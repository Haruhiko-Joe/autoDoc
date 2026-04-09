# Suggestions

## Overview & Responsibilities

The Suggestions module is the prompt autocomplete and suggestion system for Claude Code's terminal UI. It lives within the **Infrastructure > CoreUtilities > DomainHelpers** layer and provides five distinct suggestion sources that power the interactive input experience:

1. **Command suggestions** — Fuse.js-based fuzzy matching of slash commands (`/commit`, `/review-pr`, etc.)
2. **Directory path completion** — Filesystem path autocompletion with LRU caching
3. **Shell history completion** — Ghost-text suggestions from the user's shell command history
4. **Slack channel suggestions** — `#channel` autocompletion via the Slack MCP server
5. **Skill usage tracking** — Frequency/recency scoring to rank frequently-used skills higher

Each source is self-contained in its own file and exports functions consumed by the `PromptInput` UI components (specifically `PromptInputFooterSuggestions`). The sources share a common `SuggestionItem` type but are otherwise independent.

## Key Processes

### Command Suggestion Flow

When the user types a `/` in the prompt input, `generateCommandSuggestions()` drives the autocomplete:

1. **Empty query (`/` alone)** — Returns all visible commands organized into categories: recently-used skills (top 5 by usage score), built-in commands, user commands, project commands, policy commands, and others. Each category is sorted alphabetically (`commandSuggestions.ts:309-380`).

2. **Typed query (`/com`)** — Uses a cached Fuse.js index for fuzzy search. The index is built once per stable `commands` array and searches across four weighted keys (`commandSuggestions.ts:53-80`):
   - `commandName` (weight 3) — highest priority
   - `partKey` (weight 2) — segments split on `:`, `_`, `-`
   - `aliasKey` (weight 2) — command aliases
   - `descriptionKey` (weight 0.5) — tokenized description words

3. **Result sorting** — Fuse results are re-sorted with a priority cascade: exact name match > exact alias match > prefix name match > prefix alias match > Fuse score. Ties at the Fuse-score level are broken by skill usage score (`commandSuggestions.ts:414-473`).

4. **Hidden command handling** — If the user types the exact name of a hidden command (and no visible command shares that name), it is prepended to results. This handles edge cases like OAuth expiry toggling visibility mid-session (`commandSuggestions.ts:391-496`).

### Mid-Input Slash Command Detection

`findMidInputSlashCommand()` detects slash commands typed after other text (e.g., `please run /commit`). It scans backwards from the cursor for a `/` preceded by whitespace, avoiding false positives on filesystem paths like `/usr/bin`. The regex deliberately avoids lookbehind to prevent JSC JIT deoptimization (`commandSuggestions.ts:114-154`).

### Directory Path Completion Flow

When input contains a path-like token (`~/`, `./`, `../`, or `/`):

1. `parsePartialPath()` splits the input into a resolved directory and a filename prefix (`directoryCompletion.ts:55-78`)
2. `scanDirectory()` or `scanDirectoryForPaths()` reads the directory contents, applying an LRU cache (500 entries, 5-minute TTL) to avoid repeated filesystem calls (`directoryCompletion.ts:84-116`)
3. Results are prefix-filtered and formatted with trailing `/` for directories

Two variants exist: `getDirectoryCompletions()` returns only directories, while `getPathCompletions()` returns both files and directories with configurable hidden-file inclusion.

### Shell History Completion Flow

When the user types a `!` prefix (handled externally), `getShellHistoryCompletion()`:

1. Reads session history entries via `getHistory()`, filtering for entries prefixed with `!` (shell commands)
2. Caches up to 50 unique commands with a 60-second TTL (`shellHistoryCompletion.ts:23-57`)
3. Returns the first command that starts with the exact input as ghost text
4. `prependToShellHistoryCache()` allows newly-executed commands to be pushed to the front of the cache without flushing it (`shellHistoryCompletion.ts:74-83`)

### Slack Channel Suggestion Flow

When a `#` token is detected and a Slack MCP server is connected:

1. `mcpQueryFor()` strips the trailing partial word segment from the search token (e.g., `claude-code-team-en` → `claude-code-team`) because Slack's search tokenizes on hyphens and requires whole-word matches (`slackChannelSuggestions.ts:129-135`)
2. `findReusableCacheEntry()` checks if any cached query is a prefix of the current one that still has matching results, avoiding redundant MCP calls as the user types (`slackChannelSuggestions.ts:140-157`)
3. If no cache hit, `fetchChannels()` calls the `slack_search_channels` MCP tool with a 5-second timeout (`slackChannelSuggestions.ts:29-65`)
4. Results are parsed from the Slack MCP server's markdown format (`Name: #channel-name` lines), potentially unwrapping a JSON `{results: "..."}` envelope (`slackChannelSuggestions.ts:87-100`)
5. All discovered channel names are added to a `knownChannels` set used by `findSlackChannelPositions()` to highlight only confirmed-real channel names in the prompt input (`slackChannelSuggestions.ts:110-122`)
6. In-flight request deduplication prevents concurrent identical MCP calls (`slackChannelSuggestions.ts:170-171`)

### Skill Usage Scoring

`recordSkillUsage()` persists usage data (count + timestamp) to the global config file. A 60-second in-process debounce avoids excessive file I/O since the scoring algorithm uses 7-day granularity (`skillUsageTracking.ts:13-35`).

`getSkillUsageScore()` calculates a combined frequency/recency score using exponential decay:

```
score = usageCount × max(0.5^(daysSinceUse / 7), 0.1)
```

The 7-day half-life means last week's usage is worth half of today's. The 0.1 floor prevents heavily-used skills from completely vanishing after inactivity (`skillUsageTracking.ts:44-55`).

## Function Signatures

### commandSuggestions.ts

#### `generateCommandSuggestions(input: string, commands: Command[]): SuggestionItem[]`
Main entry point for command autocompletion. Returns an ordered list of matching commands for the given `/`-prefixed input.

#### `findMidInputSlashCommand(input: string, cursorOffset: number): MidInputSlashCommand | null`
Detects a slash command token appearing mid-input (not at position 0). Returns the token, its position, and the partial command string.

#### `getBestCommandMatch(partialCommand: string, commands: Command[]): { suffix: string; fullCommand: string } | null`
Returns the inline completion suffix for a partial command (e.g., `"mit"` for partial `"com"` matching `"commit"`).

#### `applyCommandSuggestion(suggestion, shouldExecute, commands, onInputChange, setCursorOffset, onSubmit): void`
Applies a selected command suggestion to the input field. If `shouldExecute` is true and the command takes no arguments, immediately submits it.

#### `findSlashCommandPositions(text: string): Array<{ start: number; end: number }>`
Returns character ranges of all `/command` patterns in text for syntax highlighting. Requires preceding whitespace or start-of-string to avoid matching filesystem paths.

### directoryCompletion.ts

#### `getDirectoryCompletions(partialPath: string, options?: CompletionOptions): Promise<SuggestionItem[]>`
Returns directory-only completions for a partial path. Defaults to 10 results from the current working directory.

#### `getPathCompletions(partialPath: string, options?: PathCompletionOptions): Promise<SuggestionItem[]>`
Returns file and directory completions with configurable hidden-file inclusion.

#### `isPathLikeToken(token: string): boolean`
Checks whether a string looks like a path (`~/`, `./`, `../`, `/`, `~`, `.`, `..`).

#### `clearDirectoryCache(): void` / `clearPathCache(): void`
Clears the LRU caches for directory and path scans respectively.

### shellHistoryCompletion.ts

#### `getShellHistoryCompletion(input: string): Promise<ShellHistoryMatch | null>`
Finds the best prefix match from shell history for the given input (minimum 2 characters). Returns the full command and the ghost-text suffix.

#### `prependToShellHistoryCache(command: string): void`
Adds a newly-executed command to the front of the in-memory cache without flushing it.

#### `clearShellHistoryCache(): void`
Resets the shell history cache, forcing a fresh read on next access.

### slackChannelSuggestions.ts

#### `getSlackChannelSuggestions(clients: MCPServerConnection[], searchToken: string): Promise<SuggestionItem[]>`
Returns up to 10 Slack channel suggestions for the given search token, using MCP to query Slack's channel search API.

#### `hasSlackMcpServer(clients: MCPServerConnection[]): boolean`
Checks whether any connected MCP server is a Slack integration.

#### `findSlackChannelPositions(text: string): Array<{ start: number; end: number }>`
Returns character ranges of `#channel` patterns in text that match known (previously-fetched) channel names, used for highlighting.

### skillUsageTracking.ts

#### `recordSkillUsage(skillName: string): void`
Records a skill invocation. Debounced to at most once per 60 seconds per skill.

#### `getSkillUsageScore(skillName: string): number`
Returns a frequency-weighted recency score for ranking skills in suggestion lists.

## Interface/Type Definitions

### `SuggestionItem` (imported from PromptInputFooterSuggestions)
The shared output type for all suggestion sources:
- `id: string` — Unique identifier
- `displayText: string` — Text shown in the suggestion list
- `description?: string` — Secondary description text
- `tag?: string` — Optional tag (e.g., `"workflow"`)
- `metadata?: unknown` — Source-specific data (e.g., the `Command` object)

### `MidInputSlashCommand`
| Field | Type | Description |
|-------|------|-------------|
| `token` | `string` | The full token (e.g., `"/com"`) |
| `startPos` | `number` | Position of the `/` in the input |
| `partialCommand` | `string` | The command portion without `/` |

### `DirectoryEntry` / `PathEntry`
| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Filename |
| `path` | `string` | Full resolved path |
| `type` | `'directory'` or `'file'` | Entry type (PathEntry only has both) |

### `ShellHistoryMatch`
| Field | Type | Description |
|-------|------|-------------|
| `fullCommand` | `string` | The complete command from history |
| `suffix` | `string` | The ghost-text portion after the user's input |

## Configuration & Defaults

| Parameter | Default | Location |
|-----------|---------|----------|
| Directory cache size | 500 entries | `directoryCompletion.ts:37` |
| Directory cache TTL | 5 minutes | `directoryCompletion.ts:38` |
| Directory scan limit | 100 entries per directory | `directoryCompletion.ts:106` |
| Path completion max results | 10 | `directoryCompletion.ts:125` |
| Shell history cache TTL | 60 seconds | `shellHistoryCompletion.ts:18` |
| Shell history max commands | 50 unique | `shellHistoryCompletion.ts:46` |
| Slack MCP call timeout | 5 seconds | `slackChannelSuggestions.ts:49` |
| Slack results per query | 20 (from MCP), 10 (returned) | `slackChannelSuggestions.ts:44,196` |
| Slack cache max size | 50 entries (FIFO eviction) | `slackChannelSuggestions.ts:183` |
| Skill usage debounce | 60 seconds | `skillUsageTracking.ts:3` |
| Skill usage score half-life | 7 days | `skillUsageTracking.ts:50` |
| Skill usage score floor | 0.1 | `skillUsageTracking.ts:54` |
| Fuse.js threshold | 0.3 | `commandSuggestions.ts:55` |
| Recently used skills shown | Top 5 | `commandSuggestions.ts:324` |

## Edge Cases & Caveats

- **Fuse index staleness**: The Fuse index is cached by commands-array identity. If a command's `isHidden` flag changes mid-session (e.g., OAuth expiry), the index won't reflect it. The hidden-exact-match prepend logic (`commandSuggestions.ts:391-401`) compensates for this.

- **Duplicate command names**: Commands with the same name from different sources (e.g., `projectSettings` vs `userSettings`) are intentionally not deduplicated — they may have different implementations.

- **Regex performance**: The mid-input slash command regex avoids lookbehind (`(?<=\s)`) because it defeats the YARR JIT in JavaScriptCore, causing O(n) interpreter scans (`commandSuggestions.ts:129-130`).

- **Slack partial-word stripping**: Slack's search requires complete hyphen-separated words. Typing `#my-chan` sends `my` to the MCP server (not `my-chan`), then filters locally. This avoids 0-result responses from Slack's search API.

- **Slack cache reuse**: Typing `#c` → `#cl` → `#cla` reuses the `#c` cache entry rather than issuing new MCP calls, as long as the cached results still contain matches for the longer prefix.

- **Shell history prefix matching is exact**: `"ls "` (with trailing space) matches `"ls -lah"` but `"ls  "` (two spaces) does not. This prevents spurious ghost text when the user is still thinking about arguments.

- **Directory completions exclude hidden files** by default. The `getPathCompletions()` variant supports an `includeHidden` option, while `getDirectoryCompletions()` always excludes them.

- **Skill usage persistence**: Usage data is written to the global config (`~/.claude.json`) via `saveGlobalConfig`. The 60-second debounce prevents lock contention on the config file during rapid skill invocations.