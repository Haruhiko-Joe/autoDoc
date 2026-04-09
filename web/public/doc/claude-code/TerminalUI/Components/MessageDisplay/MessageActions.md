# MessageActions

## Overview & Responsibilities

The MessageActions module provides the interactive message navigation and action system for Claude Code's terminal UI. It sits within the **TerminalUI → Components → MessageDisplay** hierarchy, enabling users to navigate between conversation messages with keyboard shortcuts and perform contextual actions (copy, edit, expand/collapse) on individual messages.

The module is split across two files:

- **`src/components/messageActions.tsx`** (449 lines) — Defines which messages are navigable, what actions are available per message type, keybinding wiring, the selection context, and text extraction logic for copy operations.
- **`src/components/MessageSelector.tsx`** (830 lines) — Provides the "Rewind" UI that lets users restore conversation and/or code state to a previous point, with file history diff stats and summarization support.

## Key Processes

### Message Navigation Flow

1. The `isNavigableMessage()` function (`src/components/messageActions.tsx:18-64`) filters the full message list to determine which messages the user can land on. It uses a two-tier system:
   - **Tier 1**: Messages with rendered height > 0 (handled externally by the virtual list)
   - **Tier 2 (blocklist)**: This function rejects messages that render but aren't actionable — synthetic messages, meta user messages, compact summaries, XML-wrapped command outputs, and certain system message subtypes (`api_metrics`, `stop_hook_summary`, `turn_duration`, `memory_saved`, `agents_killed`, `away_summary`, `thinking`)
2. `useMessageActions()` (`src/components/messageActions.tsx:217-271`) builds stable keybinding handlers via refs (avoiding re-registration on every message append). It creates handlers for:
   - `messageActions:prev` / `messageActions:next` — step through navigable messages
   - `messageActions:prevUser` / `messageActions:nextUser` — jump between user messages only
   - `messageActions:top` / `messageActions:bottom` — jump to first/last message
   - `messageActions:escape` — collapse expanded message or exit cursor mode
   - `messageActions:ctrlc` — immediately exit cursor mode (skipping collapse step)
   - Action-specific keys (`enter`, `c`, `p`) dispatched to the matching `MESSAGE_ACTIONS` entry
3. `MessageActionsKeybindings` (`src/components/messageActions.tsx:274-293`) mounts inside the `<KeybindingSetup>` provider and registers all handlers with the keybinding system.

### Action Dispatch Flow

When a user presses an action key while a message is selected:

1. The handler looks up the `MESSAGE_ACTIONS` array for an action matching both the key and the current message's state (type, tool name, expanded status)
2. `isApplicable()` (`src/components/messageActions.tsx:188-191`) checks that the action's `types` includes the current message type, and any additional `applies` predicate passes
3. If the action has `stays: true` (the expand/collapse action), cursor state toggles `expanded` without leaving cursor mode
4. Otherwise, the action's `run()` is called with the selected message and capabilities (`copy`, `edit`), then cursor mode exits

### Message Rewind/Restore Flow (MessageSelector)

1. The `MessageSelector` component (`src/components/MessageSelector.tsx:46-401`) opens as a pick-list of user messages filtered by `selectableUserMessagesFilter()`
2. Messages are displayed in a scrollable window of `MAX_VISIBLE_MESSAGES = 7` items, with a pointer indicator and optional diff stats
3. When the user selects a message:
   - If file history is disabled, the conversation is restored directly via `onRestoreMessage`
   - If file history is enabled, `fileHistoryGetDiffStats()` computes diff stats and presents restore options
4. Restore options include:
   - **Restore code and conversation** — reverts both file edits and conversation state
   - **Restore conversation** — forks the conversation only
   - **Restore code** — reverts file changes only
   - **Summarize from here** — compacts messages after the selected point, with optional user-provided context
   - **Summarize up to here** — compacts messages before the selected point (internal-only feature)
   - **Never mind** — cancels
5. `computeDiffStatsBetweenMessages()` (`src/components/MessageSelector.tsx:722-766`) walks messages between two points, collecting `FileEditOutput` and `FileWriteToolOutput` results to tally insertions, deletions, and changed files

## Function Signatures

### `isNavigableMessage(msg: NavigableMessage): boolean`

Determines whether a message should be included in keyboard navigation. Filters out synthetic messages, meta/compact-summary user messages, XML-wrapped command outputs, and non-actionable system subtypes.

> Source: `src/components/messageActions.tsx:18-64`

### `toolCallOf(msg: NavigableMessage): { name: string; input: Record<string, unknown> } | undefined`

Extracts the tool call name and input from an assistant or grouped tool use message. Returns `undefined` for non-tool messages.

> Source: `src/components/messageActions.tsx:122-141`

### `useMessageActions(cursor, setCursor, navRef, caps): { enter, handlers }`

React hook that builds keybinding handlers for message navigation and actions. Uses refs to keep handlers stable across re-renders.

- **cursor**: Current `MessageActionsState` or `null` when not in cursor mode
- **setCursor**: State setter for entering/exiting/updating cursor mode
- **navRef**: Ref to `MessageActionsNav` providing scroll/navigation primitives
- **caps**: `MessageActionCaps` with `copy(text)` and `edit(msg)` functions
- **Returns**: `enter` callback to activate cursor mode, and `handlers` map for keybinding registration

> Source: `src/components/messageActions.tsx:217-271`

### `copyTextOf(msg: NavigableMessage): string`

Extracts copyable text from any navigable message type — user message text (with system reminders stripped), assistant text, tool results joined with newlines, system message content, or attachment prompts.

> Source: `src/components/messageActions.tsx:409-441`

### `MessageSelector({ messages, onPreRestore, onRestoreMessage, onRestoreCode, onSummarize, onClose, preselectedMessage })`

Full-screen rewind UI component. Filters messages to user-authored ones, displays a scrollable pick-list with diff stats, and offers restore/summarize options for the selected message.

> Source: `src/components/MessageSelector.tsx:46-401`

### `selectableUserMessagesFilter(message: Message): message is UserMessage`

Type guard that filters messages to genuine user-authored prompts — excludes tool results, synthetic messages, meta messages, compact summaries, and messages containing XML tags for command output, bash I/O, task notifications, or teammate messages.

> Source: `src/components/MessageSelector.tsx:767-792`

### `messagesAfterAreOnlySynthetic(messages: Message[], fromIndex: number): boolean`

Checks whether all messages after a given index are non-meaningful (synthetic, tool results, progress, system, attachments). Used to determine if rewinding to a point would skip any real content.

> Source: `src/components/MessageSelector.tsx:799-830`

## Type Definitions

### `NavigableType`

Union of message types that can participate in navigation:
`'user' | 'assistant' | 'grouped_tool_use' | 'collapsed_read_search' | 'system' | 'attachment'`

> Source: `src/components/messageActions.tsx:11`

### `MessageActionsState`

Tracks the currently selected message in cursor mode:

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | `string` | UUID of the selected message |
| `msgType` | `NavigableType` | Type of the selected message |
| `expanded` | `boolean` | Whether the message is expanded (for grouped/collapsed types) |
| `toolName` | `string?` | Tool name if the message is a tool call (enables the "copy primary input" action) |

> Source: `src/components/messageActions.tsx:192-197`

### `MessageActionsNav`

Interface for navigation callbacks provided by the virtual message list:

| Method | Description |
|--------|-------------|
| `enterCursor()` | Activate cursor mode on the nearest message |
| `navigatePrev()` / `navigateNext()` | Move to adjacent navigable message |
| `navigatePrevUser()` / `navigateNextUser()` | Jump to the previous/next user message |
| `navigateTop()` / `navigateBottom()` | Jump to first/last navigable message |
| `getSelected()` | Return the currently selected `NavigableMessage` or `null` |

> Source: `src/components/messageActions.tsx:198-207`

### `MessageActionCaps`

Capabilities passed to action handlers:

| Field | Type | Description |
|-------|------|-------------|
| `copy` | `(text: string) => void` | Copy text to clipboard |
| `edit` | `(msg: NormalizedUserMessage) => Promise<void>` | Open message for editing |

> Source: `src/components/messageActions.tsx:142-145`

### `RestoreOption` (MessageSelector-internal)

`'both' | 'conversation' | 'code' | 'summarize' | 'summarize_up_to' | 'nevermind'`

> Source: `src/components/MessageSelector.tsx:31`

## The MESSAGE_ACTIONS Array

The `MESSAGE_ACTIONS` constant (`src/components/messageActions.tsx:158-187`) defines all available actions as a readonly tuple:

| Key | Label | Applies To | Behavior |
|-----|-------|------------|----------|
| `enter` | expand/collapse | `grouped_tool_use`, `collapsed_read_search`, `attachment`, `system` | Toggles expanded state; stays in cursor mode |
| `enter` | edit | `user` | Opens the user message for editing |
| `c` | copy | All navigable types | Copies the message's text content to clipboard |
| `p` | copy {label} | `grouped_tool_use`, `assistant` (with tool call) | Copies the tool's primary input (e.g., file path, command, pattern) |

The "copy primary input" (`p`) action uses the `PRIMARY_INPUT` registry (`src/components/messageActions.tsx:70-119`) which maps tool names to their most important input field:

| Tool | Primary Input Field | Label |
|------|-------------------|-------|
| `Read`, `Edit`, `Write` | `file_path` | path |
| `NotebookEdit` | `notebook_path` | path |
| `Bash` | `command` | command |
| `Grep`, `Glob` | `pattern` | pattern |
| `WebFetch` | `url` | url |
| `WebSearch` | `query` | query |
| `Task`, `Agent` | `prompt` | prompt |
| `Tmux` | `args` (joined) | command |

## React Contexts

### `MessageActionsSelectedContext`

A boolean context (`src/components/messageActions.tsx:208`) that indicates whether the current message row is the selected one. Consumed by `useSelectedMessageBg()` to apply a highlight background color (`"messageActionsBackground"`) to the selected message.

### `InVirtualListContext`

A boolean context (`src/components/messageActions.tsx:209`) indicating whether the component is rendering inside the virtual message list.

## Configuration & Defaults

- **`MAX_VISIBLE_MESSAGES = 7`** (`src/components/MessageSelector.tsx:45`): Maximum number of messages visible at once in the rewind pick-list. The list scrolls to keep the selected item centered.
- **`NAVIGABLE_TYPES`** (`src/components/messageActions.tsx:10`): The fixed set of message types eligible for navigation: `['user', 'assistant', 'grouped_tool_use', 'collapsed_read_search', 'system', 'attachment']`.

## Edge Cases & Caveats

- **Escape vs Ctrl+C**: Pressing Escape while a message is expanded collapses it first (two-step exit). Ctrl+C always immediately exits cursor mode — this avoids requiring 3 presses to cancel during streaming (collapse → exit cursor → cancel request). See `src/components/messageActions.tsx:234-240`.
- **System reminder stripping**: `stripSystemReminders()` (`src/components/messageActions.tsx:399-408`) removes `<system-reminder>` tags from the beginning of user message text before navigation filtering and copy operations, ensuring injected system content doesn't leak into user-facing actions.
- **Rewind file history limitation**: The Rewind UI displays a warning that rewinding does not affect files edited manually or via bash — only files changed through Claude's Edit/Write tools with file history tracking are restorable (`src/components/MessageSelector.tsx:346-350`).
- **Summarize-up-to gating**: "Summarize up to here" is gated behind an internal flag (`"external" === 'ant'`), making it available only in internal builds (`src/components/MessageSelector.tsx:121-128`).
- **Primary input extraction**: The `Tmux` tool has special extraction logic — it joins the `args` array with spaces and prefixes `tmux` — while all other tools use simple string field extraction (`src/components/messageActions.tsx:115-118`).
- **Diff stats computation**: `computeDiffStatsBetweenMessages` only counts changes from `FileEditOutput` and `FileWriteToolOutput` tool results. File creates count all lines as insertions. Errors during hunk parsing are silently skipped (`src/components/MessageSelector.tsx:746-758`).
- **Selectable message filtering**: `selectableUserMessagesFilter` (`src/components/MessageSelector.tsx:767-792`) checks for the presence of specific XML tags (`LOCAL_COMMAND_STDOUT_TAG`, `BASH_STDOUT_TAG`, `TASK_NOTIFICATION_TAG`, `TICK_TAG`, `TEAMMATE_MESSAGE_TAG`, etc.) using `indexOf` rather than regex to efficiently exclude non-user-authored messages from the rewind list.