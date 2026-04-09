# MessageLayoutHelpers

## Overview & Responsibilities

This module is a collection of small, shared React components used to lay out and annotate message rows in the conversation display. Within the **TerminalUI → Components → MessageDisplay** hierarchy, these helpers handle the visual scaffolding around message content rather than the content itself:

- **MessageResponse** — the indentation gutter that renders the `⎿` prefix on assistant responses
- **MessageModel** — displays the AI model name on assistant messages in transcript mode
- **MessageTimestamp** — formats and displays timestamps on assistant messages in transcript mode
- **CompactSummary** — renders compacted/summarized conversation markers with metadata and expand shortcuts
- **ThinkingToggle** — a settings dialog for enabling or disabling extended thinking mid-session

Sibling modules in the MessageDisplay group consume these helpers to compose the full message row layout.

## Components

### MessageResponse

**File**: `src/components/MessageResponse.tsx`

Provides the response indentation gutter — the visual `⎿` character that prefixes all assistant output, creating the characteristic indented reply appearance.

#### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `children` | `React.ReactNode` | yes | The message content to wrap |
| `height` | `number` | no | Fixed height for the response area |

#### Key Behavior

1. **Nesting prevention**: Uses a `MessageResponseContext` (React context, default `false`) to detect when a `MessageResponse` is already an ancestor. If so, it returns `children` directly without adding another `⎿` gutter. This prevents nested response indicators when components like `CompactSummary` nest `MessageResponse` inside an outer `MessageResponse`. (`src/components/MessageResponse.tsx:16-19`)

2. **Gutter rendering**: Renders a horizontal row with a non-selectable, dim-colored `⎿` prefix on the left and the children in a flex-grow container on the right. The gutter is wrapped in `<NoSelect fromLeftEdge>` so it is excluded from text selection. (`src/components/MessageResponse.tsx:22, 37`)

3. **Height locking with Ratchet**: When no explicit `height` is passed, the content is wrapped in `<Ratchet lock="offscreen">`, which prevents the rendered height from shrinking once content scrolls offscreen. This avoids layout jitter during streaming. When an explicit `height` is provided, the content uses `overflowY="hidden"` with that fixed height instead, bypassing Ratchet. (`src/components/MessageResponse.tsx:45-56`)

---

### MessageModel

**File**: `src/components/MessageModel.tsx`

Displays the AI model name (e.g., `claude-opus-4-6`) next to assistant messages, but only in transcript mode.

#### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `message` | `NormalizedMessage` | yes | The message to inspect |
| `isTranscriptMode` | `boolean` | yes | Whether the UI is in transcript mode |

#### Visibility Conditions

The model is shown only when all of these are true (`src/components/MessageModel.tsx:16`):
- `isTranscriptMode` is `true`
- `message.type === 'assistant'`
- `message.message.model` is truthy
- The message content contains at least one `text` content block

If any condition fails, the component returns `null`.

#### Rendering

Renders the model name as dim-colored text inside a `<Box>` with `minWidth` set to `stringWidth(model) + 8`, ensuring consistent column alignment across messages. (`src/components/MessageModel.tsx:20-38`)

---

### MessageTimestamp

**File**: `src/components/MessageTimestamp.tsx`

Formats and displays a human-readable timestamp for assistant messages in transcript mode.

#### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `message` | `NormalizedMessage` | yes | The message to inspect |
| `isTranscriptMode` | `boolean` | yes | Whether the UI is in transcript mode |

#### Visibility Conditions

Shown only when (`src/components/MessageTimestamp.tsx:16`):
- `isTranscriptMode` is `true`
- `message.timestamp` is truthy
- `message.type === 'assistant'`
- The message content contains at least one `text` content block

#### Formatting

The timestamp is formatted using `Date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })`, producing output like `02:45 PM`. The result is rendered as dim-colored text in a `<Box>` with `minWidth` set to the string width of the formatted timestamp for alignment. (`src/components/MessageTimestamp.tsx:24-38`)

---

### CompactSummary

**File**: `src/components/CompactSummary.tsx`

Renders a visual marker in the message list where conversation compaction occurred. Compaction replaces older messages with a summary to reduce token usage.

#### Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `message` | `NormalizedUserMessage` | yes | The user message that holds summary data |
| `screen` | `Screen` | yes | Current screen mode (used to check `'transcript'`) |

#### Two Rendering Modes

**1. Summarized conversation (with metadata)** — when `message.summarizeMetadata` is present:

- Displays a `●` (BLACK_CIRCLE) icon followed by bold "Summarized conversation" heading
- In normal mode: shows a `MessageResponse`-wrapped detail block with:
  - Count of messages summarized and direction (`"up to this point"` or `"from this point"`)
  - Optional user-provided context string (quoted with curly quotes)
  - A configurable shortcut hint for `app:toggleTranscript` (default `ctrl+o`) labeled "expand history"
- In transcript mode: shows the raw text content of the summary message instead of the metadata details

(`src/components/CompactSummary.tsx:31-73`)

**2. Default compact summary (auto-compact)** — when no metadata:

- Displays a `●` icon followed by bold "Compact summary" with an inline expand shortcut hint (in normal mode)
- In transcript mode: shows the raw text content below

(`src/components/CompactSummary.tsx:76-116`)

#### Dependencies

- Uses `getUserMessageText()` from `src/utils/messages.ts` to extract text content from the user message
- Uses `ConfigurableShortcutHint` to render keybinding-aware shortcut labels
- Uses `MessageResponse` for the indented detail block

---

### ThinkingToggle

**File**: `src/components/ThinkingToggle.tsx`

A settings dialog that lets users enable or disable extended thinking (Claude's step-by-step reasoning) for the current session. Includes a confirmation step when changing the setting mid-conversation.

#### Props (exported as `Props`)

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `currentValue` | `boolean` | yes | Current thinking mode state |
| `onSelect` | `(enabled: boolean) => void` | yes | Callback when a selection is confirmed |
| `onCancel` | `() => void` | no | Callback when the dialog is dismissed |
| `isMidConversation` | `boolean` | no | Whether the conversation has already started |

#### Key Process

1. **Option selection**: Presents a `<Select>` dropdown with two options:
   - **Enabled** — "Claude will think before responding"
   - **Disabled** — "Claude will respond without extended thinking"

2. **Mid-conversation confirmation**: When `isMidConversation` is `true` and the user selects a value different from `currentValue`, instead of immediately calling `onSelect`, the component enters a confirmation state (`confirmationPending`). It displays a warning: *"Changing thinking mode mid-conversation will increase latency and may reduce quality. For best results, set this at the start of a session."* (`src/components/ThinkingToggle.tsx:97-104, 122`)

3. **Keybinding integration**: 
   - `confirm:yes` (Enter) — confirms the pending change and calls `onSelect`
   - `confirm:no` (Esc) — if in confirmation state, returns to the select view; otherwise calls `onCancel`
   - Uses `useExitOnCtrlCDWithKeybindings` for Ctrl+C/D exit handling

4. **Layout**: Wrapped in a `<Pane color="permission">` with a title "Toggle thinking mode" and footer showing available keyboard shortcuts via `Byline`, `KeyboardShortcutHint`, and `ConfigurableShortcutHint`.

(`src/components/ThinkingToggle.tsx:18-150`)

## Key Processes

### Message Row Metadata Flow

When the message list renders each assistant message row, the layout components compose in this order:

1. `MessageTimestamp` checks transcript mode and renders a formatted time (e.g., `02:45 PM`) with fixed-width alignment
2. `MessageModel` checks transcript mode and renders the model identifier (e.g., `claude-opus-4-6`) with fixed-width alignment
3. `MessageResponse` wraps the actual message content, adding the `⎿` gutter prefix and locking the height via Ratchet

Both `MessageTimestamp` and `MessageModel` share the same visibility guard pattern: they only render for assistant messages with text content blocks in transcript mode, returning `null` otherwise.

### Compaction Display Flow

When the query engine compacts conversation history:

1. A `NormalizedUserMessage` is created with optional `summarizeMetadata` attached
2. `CompactSummary` reads `message.summarizeMetadata` to decide which rendering branch to use
3. In normal mode, it renders metadata (message count, direction, user context) inside a `MessageResponse` gutter, with a shortcut hint to expand the full transcript via `app:toggleTranscript`
4. In transcript mode, it shows the raw summary text content instead of the metadata UI

### ThinkingToggle Confirmation Flow

1. User opens the thinking toggle dialog
2. A `<Select>` presents Enabled/Disabled options with the current value pre-selected
3. If `isMidConversation` and the user picks a different value → enters confirmation state showing a latency/quality warning
4. User presses Enter to confirm (`confirm:yes` keybinding) → `onSelect(newValue)` fires
5. User presses Esc (`confirm:no` keybinding) → returns to the select view (or dismisses the dialog if not in confirmation state)

## Edge Cases & Caveats

- **MessageResponse nesting**: The `MessageResponseContext` prevents double-rendering of the `⎿` gutter. Any component that wraps content in `MessageResponse` can safely be placed inside another `MessageResponse` without visual duplication.
- **Ratchet height lock**: `MessageResponse` uses `Ratchet lock="offscreen"` to prevent layout collapse when streaming content scrolls up. This means once content has been rendered and scrolled past, its height is locked and won't shrink — intentional for streaming stability.
- **MessageModel and MessageTimestamp** only render for assistant messages with text content blocks. Tool-use-only messages or non-assistant messages produce no output.
- **CompactSummary direction**: The `metadata.direction` field controls whether the summary reads "up to this point" or "from this point", reflecting whether the compaction happened from the beginning of the conversation forward or from a specific point backward.
- **ThinkingToggle mid-conversation warning**: The confirmation prompt only appears when both `isMidConversation` is true AND the selected value differs from `currentValue`. Selecting the already-active option fires `onSelect` immediately without warning.