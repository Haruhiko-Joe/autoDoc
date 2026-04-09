# UserInputRenderers

## Overview & Responsibilities

The UserInputRenderers module contains 13 React components responsible for rendering all forms of user-role messages in the terminal UI conversation view. These components sit within the **MessageDisplay > MessageTypeRenderers** layer of the TerminalUI system, and are dispatched by `UserTextMessage` — the central router that inspects message content and delegates to the appropriate specialized renderer.

Within the broader architecture, these renderers are siblings to assistant-role and system-role renderers inside **MessageTypeRenderers**, which is composed by the **MessagePipeline** (`Message.tsx` dispatcher). They consume Ink primitives (`Box`, `Text`) from the **InkEngine** and shared layout helpers like `MessageResponse` from **MessageLayoutHelpers**.

## Key Processes

### Message Routing via UserTextMessage

`UserTextMessage` (`src/components/messages/UserTextMessage.tsx`) acts as the dispatcher for all user content blocks. It receives a `TextBlockParam` and routes based on content inspection:

1. **Empty content** — if text equals `NO_CONTENT_MESSAGE`, renders nothing
2. **Plan mode** — if `planContent` is provided, delegates to `UserPlanMessage`
3. **Tick/caveat tags** — silently suppresses internal housekeeping messages (`<tick>`, `<local-command-caveat>`)
4. **Bash output** — text starting with `<bash-stdout` or `<bash-stderr` → `UserBashOutputMessage`
5. **Local command output** — text starting with `<local-command-stdout` or `<local-command-stderr` → `UserLocalCommandOutputMessage`
6. **Interrupt** — exact match on interrupt sentinel strings → `InterruptedByUser` display
7. **Feature-gated types** — GitHub webhooks, fork boilerplate, cross-session messages, channel messages (behind `bun:bundle` feature flags)
8. **Bash input** — contains `<bash-input>` → `UserBashInputMessage`
9. **Slash commands** — contains command message tag → `UserCommandMessage`
10. **Memory input** — contains `<user-memory-input>` → `UserMemoryInputMessage`
11. **Teammate messages** — contains teammate tag (requires agent swarms enabled) → `UserTeammateMessage`
12. **Agent notifications** — contains task notification tag → `UserAgentNotificationMessage`
13. **Resource updates** — contains `<mcp-resource-update` or `<mcp-polling-update` → `UserResourceUpdateMessage`
14. **Fallback** — renders as `UserPromptMessage` (the default rich text renderer)

> Source: `src/components/messages/UserTextMessage.tsx:29-280`

### XML Tag Extraction Pattern

Most renderers share a common data extraction pattern using `extractTag(text, tagName)` from `../../utils/messages.js`. The raw message text arrives as XML-tagged content (e.g., `<bash-input>ls -la</bash-input>`), and each renderer extracts its relevant payload before rendering. If extraction returns `null`, the component returns `null` (renders nothing).

## Component Reference

### UserPromptMessage

The default renderer for plain user prompts. Displays user text with syntax highlighting via `HighlightedThinkingText`, handles text truncation for large piped inputs (>10,000 chars with head/tail preservation), and supports a brief layout mode for Kairos-enabled sessions.

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Whether to add top margin |
| `param` | `TextBlockParam` | The text block to render |
| `isTranscriptMode` | `boolean?` | Whether rendering in transcript view |
| `timestamp` | `string?` | Message timestamp for brief layout |

Key behavior:
- Truncation: `MAX_DISPLAY_CHARS = 10,000`; shows first 2,500 + last 2,500 chars with hidden line count
- Background: `userMessageBackground` (or `messageActionsBackground` when selected)
- Brief layout: conditionally enabled via feature flags and app state

> Source: `src/components/messages/UserPromptMessage.tsx:31-79`

### UserTextMessage (Dispatcher)

Not a leaf renderer itself — acts as the routing hub described in the Key Processes section above. Accepts all user text blocks and delegates to the appropriate specialized renderer.

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Margin control passed to child renderers |
| `param` | `TextBlockParam` | Raw text content block |
| `verbose` | `boolean` | Verbose mode for bash output |
| `planContent` | `string?` | Plan text when in plan mode |
| `isTranscriptMode` | `boolean?` | Transcript mode flag |
| `timestamp` | `string?` | Message timestamp |

> Source: `src/components/messages/UserTextMessage.tsx:29-280`

### UserBashInputMessage

Renders shell command input with a distinctive bash prompt styling.

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Whether to add top margin |
| `param` | `TextBlockParam` | Text block containing `<bash-input>` tag |

Extracts content from `<bash-input>` XML tag and renders in a row layout with:
- `"! "` prefix in `bashBorder` color
- Command text in `text` color
- `bashMessageBackgroundColor` background

> Source: `src/components/messages/UserBashInputMessage.tsx:10-57`

### UserBashOutputMessage

Renders shell command output (stdout/stderr) by delegating to the shared `BashToolResultMessage` component.

| Prop | Type | Description |
|------|------|-------------|
| `content` | `string` | Raw text containing `<bash-stdout>` and/or `<bash-stderr>` tags |
| `verbose` | `boolean?` | Whether to show verbose output |

Extracts stdout and stderr from their respective XML tags. Also unwraps `<persisted-output>` wrapper if present (a model-facing signaling tag).

> Source: `src/components/messages/UserBashOutputMessage.tsx:5-53`

### UserCommandMessage

Renders slash command invocations and skill invocations.

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Whether to add top margin |
| `param` | `TextBlockParam` | Text block with command tag |

Two display modes:
- **Skill format** (`<skill-format>true</skill-format>`): Shows as `❯ Skill(name)`
- **Slash command format**: Shows as `❯ /command args`

Both use `userMessageBackground` and the `figures.pointer` (❯) prefix in `subtle` color.

> Source: `src/components/messages/UserCommandMessage.tsx:12-107`

### UserImageMessage

Renders image attachment indicators, optionally as clickable hyperlinks.

| Prop | Type | Description |
|------|------|-------------|
| `imageId` | `number?` | Stored image ID |
| `addMargin` | `boolean?` | Whether to add top margin |

Display logic:
- Label: `[Image #N]` if ID is provided, otherwise `[Image]`
- If stored image path exists and terminal supports hyperlinks → clickable `file://` link
- With `addMargin`: renders in a `Box` with top margin (new user turn)
- Without `addMargin`: wraps in `MessageResponse` (connected to previous message with `⎿` gutter)

> Source: `src/components/messages/UserImageMessage.tsx:20-58`

### UserPlanMessage

Renders plan mode interactions in a bordered container.

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Whether to add top margin |
| `planContent` | `string` | Plan text to render as markdown |

Renders a rounded-border box in `planMode` color with a bold "Plan to implement" header, followed by the plan content rendered through the `Markdown` component.

> Source: `src/components/messages/UserPlanMessage.tsx:9-41`

### UserChannelMessage

Renders messages from multi-agent channel communications (e.g., Slack channels via MCP).

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Whether to add top margin |
| `param` | `TextBlockParam` | Text block containing `<channel>` tag |

Parses the XML format `<channel source="..." user="...">content</channel>` using regex. Displays:
- Channel arrow icon in `suggestion` color
- Server name (leaf segment after last `:` for plugin-scoped names) in dim text
- Optional user name separated by ` · `
- Message body truncated to 60 characters

> Source: `src/components/messages/UserChannelMessage.tsx:26-136`

### UserTeammateMessage

Renders messages from teammates in multi-agent (swarm) workflows. The most complex of the user renderers.

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Whether to add top margin |
| `param` | `TextBlockParam` | Text block with `<teammate-message>` tags |
| `isTranscriptMode` | `boolean?` | Whether in transcript view |

Parses multiple `<teammate-message teammate_id="..." color="..." summary="...">` blocks from a single text. For each message, attempts rendering as (in order):
1. **Plan approval** message (via `tryRenderPlanApprovalMessage`)
2. **Shutdown** message (via `tryRenderShutdownMessage`)
3. **Task assignment** (via `tryRenderTaskAssignmentMessage`)
4. **Task completed** notification — shows `✓ Completed task #ID`
5. **Default** — colored teammate name with `@name❯` prefix and optional summary

Pre-filters out shutdown-approved and `teammate_terminated` messages to avoid blank lines.

> Source: `src/components/messages/UserTeammateMessage.tsx:55-200`

### UserAgentNotificationMessage

Renders agent status notifications with color-coded status indicators.

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Whether to add top margin |
| `param` | `TextBlockParam` | Text block with `<summary>` and `<status>` tags |

Extracts `<summary>` and `<status>` tags. Status-to-color mapping:
- `completed` → `success` (green)
- `failed` → `error` (red)
- `killed` → `warning` (yellow)
- default → `text`

Renders a filled circle (`BLACK_CIRCLE`) in the status color followed by the summary text.

> Source: `src/components/messages/UserAgentNotificationMessage.tsx:23-82`

### UserMemoryInputMessage

Renders memory save operations with a distinctive memory-themed style.

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Whether to add top margin |
| `text` | `string` | Raw text containing `<user-memory-input>` tag |

Display:
- `#` prefix in `remember` color on `memoryBackgroundColor`
- Input text on `memoryBackgroundColor`
- Below: a `MessageResponse` line with a randomly chosen confirmation message ("Got it.", "Good to know.", or "Noted.") in dim text

> Source: `src/components/messages/UserMemoryInputMessage.tsx:15-74`

### UserResourceUpdateMessage

Renders MCP resource change and polling update notifications.

| Prop | Type | Description |
|------|------|-------------|
| `addMargin` | `boolean` | Whether to add top margin |
| `param` | `TextBlockParam` | Text containing update XML tags |

Parses two types of XML updates:
- `<mcp-resource-update server="..." uri="...">` — resource changes
- `<mcp-polling-update type="..." server="..." tool="...">` — polling updates

Each update line shows:
- Refresh arrow (`REFRESH_ARROW`) in `success` color
- Server name in dim text
- Target (formatted URI for resources, tool name for polling) in `suggestion` color
- Optional reason after ` · ` separator

URI formatting: `file://` URIs show filename only; others truncated at 40 chars with `…`.

> Source: `src/components/messages/UserResourceUpdateMessage.tsx:61-120`

### UserLocalCommandOutputMessage

Renders output from local command execution (hooks, startup scripts).

| Prop | Type | Description |
|------|------|-------------|
| `content` | `string` | Raw text with `<local-command-stdout>` and/or `<local-command-stderr>` tags |

Extracts stdout and stderr from their XML tags. If both are empty, shows `NO_CONTENT_MESSAGE`. Otherwise renders each non-empty stream through `IndentedContent`, which:
- Detects **cloud launch content** (lines starting with diamond symbols `◇`/`◆`) and renders with special header/suffix parsing
- Default content: renders with `⎿` indent prefix and passes through the `Markdown` component

> Source: `src/components/messages/UserLocalCommandOutputMessage.tsx:12-87`

## Shared Patterns & Conventions

- **`addMargin` prop**: Nearly all renderers accept this boolean. When `true`, adds `marginTop={1}` to create visual separation from preceding content; when `false`, the message appears flush with its predecessor.
- **XML tag extraction**: Content arrives as XML-structured text. The `extractTag()` utility extracts inner content; returns `null` if the tag is absent, causing the component to return `null`.
- **React Compiler optimization**: All components use the React Compiler runtime (`_c()` cache arrays) for automatic memoization of JSX elements and computed values.
- **Theme colors**: Components use semantic color names (`bashBorder`, `planMode`, `suggestion`, `success`, `error`, `remember`, etc.) from the application's theme system.
- **`MessageResponse` wrapper**: Used by several components (`UserImageMessage`, `UserMemoryInputMessage`, `UserLocalCommandOutputMessage`) to render content with the `⎿` response gutter, visually connecting it to the message above.

## Edge Cases & Caveats

- `UserPromptMessage` truncates text over 10,000 characters to prevent Ink rendering performance degradation (500ms+ keystroke latency with large piped input). The truncation preserves head and tail with a hidden line count indicator.
- `UserTextMessage` suppresses several internal message types (`<tick>`, `<local-command-caveat>`, `NO_CONTENT_MESSAGE`) that are used for system bookkeeping but should not be visible to users.
- `UserTeammateMessage` pre-filters shutdown lifecycle messages and `teammate_terminated` JSON messages to prevent empty blank lines between model turns.
- `UserChannelMessage` strips plugin scope prefixes from server names (e.g., `plugin:slack-channel:slack` → `slack`) to show only the leaf name.
- `UserBashOutputMessage` unwraps `<persisted-output>` tags — these are model-facing signals that should not affect user display.
- Several renderers are gated behind feature flags (`KAIROS`, `KAIROS_CHANNELS`, `FORK_SUBAGENT`, `UDS_INBOX`) and only activate in builds that enable those features.