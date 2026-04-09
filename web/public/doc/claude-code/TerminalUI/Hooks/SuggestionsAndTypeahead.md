# Suggestions and Typeahead

## Overview & Responsibilities

This module implements the complete autocomplete, suggestion, and recommendation system for the Claude Code terminal UI. It sits within the **Hooks** layer of the **TerminalUI** subsystem, providing the reusable state management and data-fetching logic that powers the prompt input's autocomplete dropdown, inline ghost text, file @-mentions, slash command completion, and plugin install recommendations.

The module is composed of eight files, each handling a distinct concern:

| File | Role |
|------|------|
| `fileSuggestions.ts` | Git-aware file discovery and fuzzy search index |
| `unifiedSuggestions.ts` | Merges file, MCP resource, and agent suggestions into a single ranked list |
| `useTypeahead.tsx` | Central hook orchestrating multi-source typeahead with keyboard handling |
| `renderPlaceholder.ts` | Generates styled placeholder text with cursor rendering |
| `usePromptSuggestion.ts` | Manages speculative prompt suggestion state and telemetry |
| `usePluginRecommendationBase.tsx` | Shared state machine for plugin install recommendation hooks |
| `useClaudeCodeHintRecommendation.tsx` | Surfaces plugin install prompts from `<claude-code-hint>` tags |
| `useOfficialMarketplaceNotification.tsx` | Auto-installs the official Anthropic marketplace on startup |

Sibling hook modules in the same `Hooks` group handle other concerns (input handling, session lifecycle, IDE integration, etc.).

## Key Processes

### File Suggestion Pipeline

The file suggestion system uses a two-tier strategy: fast git-based discovery with a background untracked-file merge.

1. **Index initialization**: On mount, `useTypeahead` calls `startBackgroundCacheRefresh()` which lazily creates a singleton `FileIndex` (a Rust/nucleo-backed fuzzy matcher) and populates it via `getPathsForSuggestions()` (`src/hooks/fileSuggestions.ts:523-570`).

2. **Git-first file discovery**: `getFilesUsingGit()` runs `git ls-files --recurse-submodules` from the repo root to get tracked files in ~5ms. Paths are normalized relative to the current working directory and filtered through `.ignore`/`.rgignore` patterns (`src/hooks/fileSuggestions.ts:248-383`).

3. **Background untracked merge**: Untracked files are fetched asynchronously via `git ls-files --others --exclude-standard` and merged into the index without blocking the UI (`src/hooks/fileSuggestions.ts:315-376`).

4. **Ripgrep fallback**: For non-git directories, `getProjectFiles()` falls back to `ripgrep --files` with hidden-file inclusion and VCS directory exclusions (`src/hooks/fileSuggestions.ts:459-516`).

5. **Throttled refresh**: `startBackgroundCacheRefresh()` monitors `.git/index` mtime to detect tracked-file changes instantly, with a 5-second floor to catch untracked files. Path-list signatures (FNV-1a hash sampling ~500 paths) skip index rebuilds when nothing changed (`src/hooks/fileSuggestions.ts:636-686`).

6. **Progressive querying**: The `FileIndex` is queryable while building — early searches return partial results from ready chunks. When the build completes, `indexBuildComplete` signal fires, and the typeahead re-runs the last search to upgrade results (`src/hooks/fileSuggestions.ts:46-47`).

### Unified Suggestion Ranking

`generateUnifiedSuggestions()` merges three source types into a single scored list (`src/hooks/unifiedSuggestions.ts:111-202`):

1. **File suggestions** — scored by the nucleo fuzzy matcher (0–1, lower is better)
2. **MCP resource suggestions** — scored by Fuse.js against `displayText`, `name`, `server`, `description`
3. **Agent suggestions** — scored by Fuse.js against `agentType` and `displayText`

All scores are normalized to the same 0–1 scale, sorted ascending, and capped at 15 results. When no query is present (empty `@`), sources are concatenated without scoring.

### useTypeahead Orchestration

`useTypeahead` (`src/hooks/useTypeahead.tsx:353-1384`) is the central hook consumed by the prompt input component. It handles:

1. **Input analysis**: On every input change, `updateSuggestions()` classifies the input into one of several suggestion modes:
   - **Slash commands** (`/compact`, `/resume`, etc.) — synchronous filtering against the command registry
   - **@ file mentions** (`@readme.md`) — debounced fuzzy search via `generateUnifiedSuggestions`
   - **Path-like tokens** (`@~/path`, `@./dir`) — directory traversal via `getPathCompletions`
   - **Team member DMs** (`@agent-name`) — filtered from live agent registry state
   - **Slack channels** (`#channel`) — fetched via MCP server if available
   - **Shell completions** (bash mode) — async completions via `getShellCompletions`
   - **History ghost text** (bash mode) — inline completion from shell history
   - **Mid-input slash commands** (prompt mode) — ghost text for `/command` typed mid-sentence

2. **Debouncing and staleness**: File suggestions are debounced at 50ms. Each async operation tracks a "latest token" ref; stale results from slower queries are discarded when a newer query has been initiated.

3. **Keyboard handling**: Registered via both the keybinding system (`Autocomplete` context) and a `useInput` backward-compat bridge:
   - **Tab**: Accepts the current suggestion or ghost text; triggers shell completions when no suggestions exist
   - **Enter**: Applies and executes the selected suggestion (e.g., runs a slash command)
   - **Up/Down** (or Ctrl-P/N): Navigates the suggestion list
   - **Escape**: Dismisses suggestions
   - **Right arrow**: Accepts prompt suggestion ghost text

4. **Selection preservation**: When the suggestion list updates (e.g., from partial to full index results), `getPreservedSelection()` tries to keep the same item selected by matching IDs.

### Prompt Suggestion Speculation

`usePromptSuggestion` (`src/hooks/usePromptSuggestion.ts:15-177`) manages server-generated prompt suggestions that appear as ghost text when the input is empty and the assistant is idle:

- **Visibility gating**: Suggestion shows only when `inputValue` is empty and `isAssistantResponding` is false
- **Lifecycle tracking**: `markShown()` timestamps first display; `markAccepted()` timestamps Tab/Enter acceptance
- **Outcome telemetry**: `logOutcomeAtSubmission()` logs whether the suggestion was accepted or ignored, time-to-accept, time-to-first-keystroke, acceptance method (tab vs. enter), and similarity ratio
- **Focus awareness**: Captures whether the terminal was focused when the suggestion appeared, reported in telemetry

### Plugin Recommendation System

Three hooks form a layered plugin recommendation architecture:

1. **`usePluginRecommendationBase`** (`src/hooks/usePluginRecommendationBase.tsx:24-77`): A generic state machine providing `tryResolve` (gated async resolution), `recommendation` state, and `clearRecommendation`. Gates: skips in remote mode, skips if already showing, skips if in-flight. The `installPluginAndNotify` helper looks up a plugin by ID from the marketplace and shows success/failure notifications.

2. **`useClaudeCodeHintRecommendation`** (`src/hooks/useClaudeCodeHintRecommendation.tsx:24-120`): Subscribes to pending `<claude-code-hint>` tags emitted by CLIs/SDKs. When a hint arrives, calls `resolvePluginHint` to determine if a plugin should be recommended. The `handleResponse` callback supports three actions: `yes` (install via marketplace), `no` (dismiss), `disable` (permanently opt out). Each plugin is prompted at most once (recorded in config).

3. **`useOfficialMarketplaceNotification`** (`src/hooks/useOfficialMarketplaceNotification.tsx:12-47`): Runs on startup via `useStartupNotification`. Calls `checkAndInstallOfficialMarketplace()` and surfaces notifications for success, config-save failure, or install failure (with silent retry on next startup). Skips notifications for already-installed, policy-blocked, or git-unavailable cases.

## Function Signatures

### `generateFileSuggestions(partialPath: string, showOnEmpty?: boolean): Promise<SuggestionItem[]>`

Main entry point for file completion. Returns up to 15 fuzzy-matched file/directory suggestions. Supports custom `fileSuggestion.command` hook from project settings.

> Source: `src/hooks/fileSuggestions.ts:715-784`

### `generateUnifiedSuggestions(query: string, mcpResources: Record<string, ServerResource[]>, agents: AgentDefinition[], showOnEmpty?: boolean): Promise<SuggestionItem[]>`

Merges file, MCP resource, and agent suggestions into a single scored list of up to 15 items.

> Source: `src/hooks/unifiedSuggestions.ts:111-202`

### `useTypeahead(props: Props): UseTypeaheadResult`

Central typeahead hook. Returns `{ suggestions, selectedSuggestion, suggestionType, maxColumnWidth, commandArgumentHint, inlineGhostText, handleKeyDown }`.

**Props:**
- `input` / `cursorOffset` — current text and cursor position
- `commands` — available slash commands
- `agents` — available agent definitions
- `mode` — `'prompt'` or `'bash'`
- `onInputChange` / `setCursorOffset` / `onSubmit` — input mutation callbacks
- `setSuggestionsState` / `suggestionsState` — external state for suggestion list
- `suppressSuggestions` — disables all suggestion behavior
- `markAccepted` — callback to mark prompt suggestion as accepted

> Source: `src/hooks/useTypeahead.tsx:353-1384`

### `usePromptSuggestion(props: { inputValue: string, isAssistantResponding: boolean })`

Returns `{ suggestion, markAccepted, markShown, logOutcomeAtSubmission }` for managing speculative prompt suggestion state.

> Source: `src/hooks/usePromptSuggestion.ts:15-177`

### `renderPlaceholder(props: PlaceholderRendererProps): { renderedPlaceholder: string | undefined, showPlaceholder: boolean }`

Pure function that renders placeholder text with optional inverse cursor. Handles voice recording mode (cursor only, no text).

> Source: `src/hooks/renderPlaceholder.ts:13-51`

### `usePluginRecommendationBase<T>(): { recommendation: T | null, clearRecommendation: () => void, tryResolve: (resolve: () => Promise<T | null>) => void }`

Generic state machine for plugin recommendations with remote-mode and in-flight guards.

> Source: `src/hooks/usePluginRecommendationBase.tsx:24-77`

### `installPluginAndNotify(pluginId, pluginName, keyPrefix, addNotification, install): Promise<void>`

Helper that looks up a plugin from the marketplace, runs the install callback, and emits success/failure notifications.

> Source: `src/hooks/usePluginRecommendationBase.tsx:80-104`

## Type Definitions

### `SuggestionType`

Discriminates the active suggestion mode: `'none' | 'command' | 'file' | 'shell' | 'directory' | 'agent' | 'custom-title' | 'slack-channel'`

### `SuggestionItem`

Unified suggestion item used across all sources:
- `id: string` — unique identifier (e.g., `file-src/index.ts`, `mcp-resource-server__uri`)
- `displayText: string` — shown in the dropdown
- `description?: string` — secondary text
- `color?: keyof Theme` — optional theme color (used for agent suggestions)
- `metadata?: unknown` — source-specific data (score, completionType, sessionId)

### `SuggestionSource` (internal to `unifiedSuggestions.ts`)

Discriminated union: `FileSuggestionSource | McpResourceSuggestionSource | AgentSuggestionSource`

### `PlaceholderRendererProps`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `placeholder` | `string?` | - | Text to display |
| `value` | `string` | - | Current input value |
| `showCursor` | `boolean?` | - | Whether to render cursor |
| `focus` | `boolean?` | - | Whether input is focused |
| `terminalFocus` | `boolean` | `true` | Whether terminal window has focus |
| `invert` | `(text: string) => string` | `chalk.inverse` | Cursor styling function |
| `hidePlaceholderText` | `boolean` | `false` | Voice mode: cursor only |

## Configuration & Defaults

- **`respectGitignore`**: Project setting or global config. When `true` (default), untracked files are filtered through `--exclude-standard`. Controls whether gitignored files appear in suggestions.
- **`fileSuggestion.type: 'command'`**: Project setting that delegates file suggestion generation to a custom hook command instead of the built-in git/ripgrep pipeline.
- **`MAX_SUGGESTIONS`**: 15 — cap on file suggestions returned per query (`src/hooks/fileSuggestions.ts:617`)
- **`MAX_UNIFIED_SUGGESTIONS`**: 15 — cap on merged suggestions (`src/hooks/unifiedSuggestions.ts:70`)
- **`REFRESH_THROTTLE_MS`**: 5000ms — minimum interval between file index refreshes (`src/hooks/fileSuggestions.ts:635`)
- **Debounce intervals**: File suggestions at 50ms, Slack channels at 150ms

## Edge Cases & Caveats

- **Partial results during index build**: The first `@`-mention after startup may show incomplete results if the file index is still building. Results automatically upgrade when the build completes via the `indexBuildComplete` signal.
- **Symlinks not followed in git mode**: `git ls-files` tracks symlinks as symlinks — unlike the ripgrep fallback which uses `--follow`.
- **Unicode path support**: Token extraction uses Unicode-aware regex (`\p{L}`, `\p{N}`, `\p{M}`) to handle CJK characters, accented filenames (macOS NFD), and combining marks.
- **Quoted paths**: Paths with spaces can be referenced as `@"my file.txt"` — the completion system detects quoted tokens and preserves quoting through suggestion application.
- **Cache generation guards**: Each async operation captures `cacheGeneration` at start; if `clearFileSuggestionCaches()` is called (e.g., on session resume), stale results are silently discarded.
- **Test environment**: Background index pre-warming is skipped under `NODE_ENV=test` to avoid spawning `git ls-files` against CI workspaces with 270k+ files.
- **Plugin hint show-once semantics**: Each plugin is prompted at most once ever, regardless of the user's response. The `maybeRecordPluginHint` pre-store gate drops installed/shown/capped hints before they reach the recommendation hook.
- **Marketplace retry**: Official marketplace install failures are retried silently on next startup with backoff. No notification is shown for `already_installed`, `policy_blocked`, `already_attempted`, or `git_unavailable` states.