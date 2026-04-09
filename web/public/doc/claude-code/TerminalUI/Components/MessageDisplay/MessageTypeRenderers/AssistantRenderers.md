# AssistantRenderers

## Overview & Responsibilities

The AssistantRenderers module contains five React components that handle the visual rendering of all assistant-role message content blocks in the Claude Code terminal UI. These components sit within the **MessageTypeRenderers** layer of the **MessageDisplay** pipeline (TerminalUI → Components → MessageDisplay → MessageTypeRenderers) and are dispatched by the `Message.tsx` dispatcher based on content block type.

Each component maps to a specific Anthropic API content block type:

| Component | Content Block | Purpose |
|-----------|--------------|---------|
| `AssistantTextMessage` | `text` | Streamed text output, error messages, markdown rendering |
| `AssistantThinkingMessage` | `thinking` | Extended thinking display with expand/collapse |
| `AssistantRedactedThinkingMessage` | `redacted_thinking` | Placeholder for redacted thinking blocks |
| `AssistantToolUseMessage` | `tool_use` | Tool invocation display with progress and status |
| `HighlightedThinkingText` | *(helper)* | Syntax-highlighted thinking text with rainbow trigger support |

Sibling renderers in the same MessageTypeRenderers group handle user messages, system messages, and tool result messages.

## Key Processes

### Text Message Rendering Flow (`AssistantTextMessage`)

1. Extract the `text` field from the `TextBlockParam` content block (`AssistantTextMessage.tsx:56-58`)
2. **Short-circuit checks**: Return `null` for empty text or `NO_RESPONSE_REQUESTED` sentinel values
3. **Error routing**: Match the text against a cascade of known error constants via a `switch` statement (`AssistantTextMessage.tsx:75-195`):
   - Rate limit errors → delegate to `<RateLimitMessage>`
   - `PROMPT_TOO_LONG_ERROR_MESSAGE` → show context limit warning with upgrade hint
   - `CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE` → show billing link
   - `INVALID_API_KEY_ERROR_MESSAGE` → delegate to `<InvalidApiKeyMessage>` (includes macOS keychain-locked hint)
   - `ORG_DISABLED_ERROR_MESSAGE_ENV_KEY` → show org disabled error
   - `TOKEN_REVOKED_ERROR_MESSAGE` → show revocation message
   - `API_TIMEOUT_ERROR_MESSAGE` → show timeout with `API_TIMEOUT_MS` env var hint
   - `CUSTOM_OFF_SWITCH_MESSAGE` → show Opus demand message with model switch suggestion
   - `ERROR_MESSAGE_USER_ABORT` → show `<InterruptedByUser>`
4. **Generic API error**: If text starts with the API error prefix, truncate to `MAX_API_ERROR_CHARS` (1000) in non-verbose mode and show `<CtrlOToExpand>` for full view
5. **Normal text**: Render through `<Markdown>` component inside a `<Box>` with optional leading dot indicator (`BLACK_CIRCLE`) and message-action selection background

### Tool Use Rendering Flow (`AssistantToolUseMessage`)

This is the most complex renderer. The flow:

1. **Tool resolution**: Look up the tool by `param.name` using `findToolByName()` from the tool registry (`AssistantToolUseMessage.tsx:67`). Parse the input via `tool.inputSchema.safeParse()`. If tool or parse fails, log error and return `null`.
2. **State derivation**: Compute several boolean states from props and app state:
   - `isResolved` — tool result exists in `lookups.resolvedToolUseIDs`
   - `isQueued` — tool is neither in-progress nor resolved
   - `isWaitingForPermission` — matches `pendingWorkerRequest.toolUseId`
   - `isClassifierChecking` — classifier approval in progress
3. **Transparent wrapper handling**: If `tool.isTransparentWrapper()` returns true, skip the tool name header and only render progress messages (`AssistantToolUseMessage.tsx:123-157`)
4. **Tool name rendering**: Show `userFacingToolName` (bold, with optional background color) and parenthesized tool use message from `tool.renderToolUseMessage()`
5. **Status indicator**: Show a `<ToolUseLoader>` spinner (animated when in-progress), a dimmed `BLACK_CIRCLE` (when queued), or a checkmark/error indicator (when resolved)
6. **Progress messages**: Below the header, render:
   - `<HookProgressMessage>` for pre-tool-use hook progress (wrapped in `<SentryErrorBoundary>`)
   - Tool-specific progress via `tool.renderToolUseProgressMessage()`
   - Permission waiting message ("Waiting for permission…")
   - Classifier checking message ("Auto classifier checking…" / "Bash classifier checking…")
   - Queued message via `tool.renderToolUseQueuedMessage()`

### Thinking Message Display Flow (`AssistantThinkingMessage`)

1. Return `null` if `thinking` text is empty or `hideInTranscript` is true
2. Determine if full thinking content should be shown: `isTranscriptMode || verbose` (`AssistantThinkingMessage.tsx:39`)
3. **Collapsed mode** (default): Show "∴ Thinking" label (dim, italic) with `<CtrlOToExpand>` hint
4. **Expanded mode**: Show "∴ Thinking…" header followed by the thinking content rendered through `<Markdown>` with `dimColor` and 2-space left padding

### Highlighted Thinking Text Flow (`HighlightedThinkingText`)

1. **Brief layout mode**: When `useBriefLayout` is true, render a chat-style "You" label with optional timestamp and plain text content (`HighlightedThinkingText.tsx:25-81`)
2. **Standard mode**: Check if "ultrathink" is enabled via `isUltrathinkEnabled()`
3. If ultrathink is off (or no trigger positions found): render plain text with a `❯` pointer prefix
4. If ultrathink triggers are found: apply per-character **rainbow coloring** using `getRainbowColor()` for trigger ranges, with plain text segments in between (`HighlightedThinkingText.tsx:117-131`)

## Function Signatures

### `AssistantTextMessage(props: Props): React.ReactNode`

Renders a text content block from assistant responses.

| Prop | Type | Description |
|------|------|-------------|
| `param` | `TextBlockParam` | The text content block from the API |
| `addMargin` | `boolean` | Whether to add top margin |
| `shouldShowDot` | `boolean` | Show leading dot indicator |
| `verbose` | `boolean` | Enable verbose mode (show full error text) |
| `width` | `number \| string` | Optional width constraint |
| `onOpenRateLimitOptions` | `() => void` | Callback for rate limit options |

> Source: `AssistantTextMessage.tsx:20-27`

### `AssistantToolUseMessage(props: Props): React.ReactNode`

Renders a tool invocation content block with status, progress, and tool-specific display.

| Prop | Type | Description |
|------|------|-------------|
| `param` | `ToolUseBlockParam` | The tool use content block |
| `addMargin` | `boolean` | Whether to add top margin |
| `tools` | `Tools` | Available tool registry |
| `commands` | `Command[]` | Available CLI commands |
| `verbose` | `boolean` | Enable verbose display |
| `inProgressToolUseIDs` | `Set<string>` | IDs of currently executing tools |
| `progressMessagesForMessage` | `ProgressMessage[]` | Progress events for this tool |
| `shouldAnimate` | `boolean` | Enable spinner animation |
| `shouldShowDot` | `boolean` | Show leading status indicator |
| `inProgressToolCallCount` | `number` | Count of concurrent tool calls |
| `lookups` | `ReturnType<typeof buildMessageLookups>` | Pre-computed message state lookups |
| `isTranscriptMode` | `boolean` | Transcript (read-only) display mode |

> Source: `AssistantToolUseMessage.tsx:21-34`

### `AssistantThinkingMessage(props: Props): React.ReactNode`

Renders a thinking content block with expand/collapse behavior.

| Prop | Type | Description |
|------|------|-------------|
| `param` | `ThinkingBlock \| ThinkingBlockParam \| { type: 'thinking'; thinking: string }` | Thinking block data |
| `addMargin` | `boolean` | Whether to add top margin (default: `false`) |
| `isTranscriptMode` | `boolean` | Show full thinking in transcript mode |
| `verbose` | `boolean` | Show full thinking in verbose mode |
| `hideInTranscript` | `boolean` | Hide block entirely (default: `false`) |

> Source: `AssistantThinkingMessage.tsx:7-18`

### `AssistantRedactedThinkingMessage(props: { addMargin: boolean }): React.ReactNode`

Shows a static "✻ Thinking…" placeholder for redacted thinking blocks. Takes only `addMargin` (default `false`).

> Source: `AssistantRedactedThinkingMessage.tsx:4-6`

### `HighlightedThinkingText(props: Props): React.ReactNode`

Renders thinking text with a pointer prefix and optional rainbow syntax highlighting for ultrathink triggers.

| Prop | Type | Description |
|------|------|-------------|
| `text` | `string` | The thinking text to display |
| `useBriefLayout` | `boolean` | Use chat-style "You" layout |
| `timestamp` | `string` | Optional timestamp for brief layout |

> Source: `HighlightedThinkingText.tsx:10-14`

## Helper Functions

### `renderToolUseMessage(tool, input, { theme, verbose, commands }): React.ReactNode`

Delegates to `tool.renderToolUseMessage()` to produce the parenthesized tool description (e.g., the file path for a Read tool, the command for Bash). Returns empty string on parse failure or error.

> Source: `AssistantToolUseMessage.tsx:304-327`

### `renderToolUseProgressMessage(tool, tools, lookups, toolUseID, progressMessages, options, terminalSize): React.ReactNode`

Renders tool progress by:
1. Filtering out `hook_progress` messages from the progress stream
2. Calling `tool.renderToolUseProgressMessage()` with the filtered messages
3. Wrapping in a fragment alongside `<HookProgressMessage>` (inside `<SentryErrorBoundary>`)

> Source: `AssistantToolUseMessage.tsx:328-358`

### `renderToolUseQueuedMessage(tool): React.ReactNode`

Calls `tool.renderToolUseQueuedMessage()` for tools that support queued state display.

> Source: `AssistantToolUseMessage.tsx:360-366`

### `InvalidApiKeyMessage(): React.ReactNode`

Internal component that renders the invalid API key error. Additionally checks `isMacOsKeychainLocked()` and shows a keychain unlock hint if applicable.

> Source: `AssistantTextMessage.tsx:28-46`

## Configuration & Defaults

- **`MAX_API_ERROR_CHARS = 1000`**: Maximum characters shown for API error messages in non-verbose mode. Truncated errors show `<CtrlOToExpand>` (`AssistantTextMessage.tsx:19`)
- **`addMargin` default**: All components default `addMargin` to `false`
- **Verbose mode**: Controls whether thinking blocks are expanded, whether API errors are shown in full, and whether tool progress includes additional detail
- **Transcript mode**: When `isTranscriptMode` is true, thinking blocks display full content and tool progress adapts its display

## Edge Cases & Caveats

- **Compiled React output**: All source files are React Compiler output (variables named `$`, `t0`, `t1`, etc., with `_c()` memo cache). The original TypeScript source is embedded in base64 source maps at the bottom of each file. The memoization cache (`$[n]`) prevents unnecessary re-renders — a critical optimization given these components render during streaming.

- **Classifier checking is disabled**: `isClassifierChecking` is hardcoded to `false` at `AssistantToolUseMessage.tsx:59` (`const isClassifierChecking = false && isClassifierCheckingRaw ...`), meaning the "classifier checking" UI path is currently dead code.

- **Transparent wrapper tools**: Tools that return `true` from `isTransparentWrapper()` skip the standard tool name header entirely and only show progress messages. They return `null` when queued or resolved — they're invisible unless actively running.

- **Empty tool name**: If `userFacingToolName` is an empty string, the entire tool use block is hidden (`AssistantToolUseMessage.tsx:158-160`).

- **Error boundary**: Tool progress rendering is wrapped in `<SentryErrorBoundary>` to prevent rendering errors in individual tool progress UIs from crashing the entire message list.

- **Rainbow thinking**: The `HighlightedThinkingText` rainbow effect is static (no animation) and only activates when `isUltrathinkEnabled()` returns true. Trigger positions are found via `findThinkingTriggerPositions()` from `utils/thinking.js`.

- **Keychain detection**: The `InvalidApiKeyMessage` component checks macOS keychain lock status once (memoized) and shows a terminal command hint `security unlock-keychain` if locked.

- **Selected state styling**: Both `AssistantTextMessage` and `HighlightedThinkingText` read `MessageActionsSelectedContext` to adjust colors and background when a message is navigated to via keyboard message actions.