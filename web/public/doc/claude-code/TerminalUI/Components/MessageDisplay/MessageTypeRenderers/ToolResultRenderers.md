# Tool Result Renderers

## Overview & Responsibilities

The Tool Result Renderers module is a collection of React components responsible for displaying the outcomes of tool executions in the terminal UI. Sitting within the **TerminalUI → Components → MessageDisplay → MessageTypeRenderers** layer, these components form the visual feedback loop that tells users what happened when Claude invoked a tool — whether it succeeded, failed, was rejected by permissions, or was interrupted by the user.

The module has two physical locations:
- **`src/components/messages/UserToolResultMessage/`** — The primary dispatcher and four outcome-state renderers, plus rejection sub-components and a shared utility hook.
- **`src/components/`** (root-level) — Standalone fallback and tool-specific components for edge cases that don't need the full dispatcher context.

## Key Processes

### Dispatch Flow: `UserToolResultMessage`

The top-level dispatcher (`UserToolResultMessage.tsx:23-100`) receives a `ToolResultBlockParam` and routes it to one of four outcome components based on the result's content:

1. **Look up the tool** — Calls `useGetToolFromMessages()` to resolve the `Tool` object and `ToolUseBlockParam` from the tool use ID. Returns `null` if the tool can't be found (e.g., old/removed tools in resumed conversations).

2. **Canceled** — If `param.content` starts with `CANCEL_MESSAGE`, renders `<UserToolCanceledMessage />`.

3. **Rejected** — If `param.content` starts with `REJECT_MESSAGE` or equals `INTERRUPT_MESSAGE_FOR_TOOL_USE`, renders `<UserToolRejectMessage />` with the tool's input for tool-specific rejection display.

4. **Error** — If `param.is_error` is truthy, renders `<UserToolErrorMessage />`.

5. **Success** (default) — Otherwise renders `<UserToolSuccessMessage />` with the full tool result, message lookups, and display options.

### Error Message Resolution: `UserToolErrorMessage`

`UserToolErrorMessage` (`UserToolErrorMessage.tsx:23-102`) performs a cascade of content checks before rendering:

1. If the content contains `INTERRUPT_MESSAGE_FOR_TOOL_USE` → renders `<InterruptedByUser />`
2. If the content starts with `PLAN_REJECTION_PREFIX` → strips the prefix and renders `<RejectedPlanMessage />` with the plan content
3. If the content starts with `REJECT_MESSAGE_WITH_REASON_PREFIX` → renders `<RejectedToolUseMessage />`
4. If the `TRANSCRIPT_CLASSIFIER` feature is enabled and `isClassifierDenial()` matches → renders a dimmed "Denied by auto mode classifier" message
5. **Otherwise** → delegates to the tool's own `renderToolUseErrorMessage()` method, falling back to `<FallbackToolUseErrorMessage />` if the tool doesn't provide one

### Rejection Message Resolution: `UserToolRejectMessage`

`UserToolRejectMessage` (`UserToolRejectMessage.tsx:21-94`) attempts tool-specific rejection rendering:

1. If the `tool` is undefined or lacks `renderToolUseRejectedMessage` → renders `<FallbackToolUseRejectedMessage />`
2. Validates input against the tool's `inputSchema` via `safeParse()` — on failure, falls back to `<FallbackToolUseRejectedMessage />`
3. Calls `tool.renderToolUseRejectedMessage()` with parsed input and context (columns, theme, tools, verbose, style, progress messages) — falls back to `<FallbackToolUseRejectedMessage />` if the method returns `null`

### Success Message Rendering: `UserToolSuccessMessage`

`UserToolSuccessMessage` (`UserToolSuccessMessage.tsx:25-100`) handles the success path:

1. Validates `message.toolUseResult` against the tool's `outputSchema` via `safeParse()` — returns `null` for invalid data (guards against corrupt resumed transcripts)
2. Calls `tool.renderToolResultMessage()` with the validated result, filtered progress messages, and display options including `style`, `theme`, `verbose`, `isBriefOnly`, and `isTranscriptMode`
3. If the tool's `userFacingName()` returns `''`, the component renders without width constraints (allowing Markdown tables to render correctly)
4. Optionally shows classifier approval annotations (auto-approved rules, YOLO classifier reasons) via feature flags
5. Renders `<HookProgressMessage />` for post-tool-use hook output

## Function Signatures

### `UserToolResultMessage(props: Props): React.ReactNode`

Top-level dispatcher that routes tool results to the appropriate renderer.

| Prop | Type | Description |
|------|------|-------------|
| `param` | `ToolResultBlockParam` | The API tool result block |
| `message` | `NormalizedUserMessage` | The parent user message |
| `lookups` | `ReturnType<typeof buildMessageLookups>` | Pre-built message lookup maps |
| `progressMessagesForMessage` | `ProgressMessage[]` | Progress messages for this tool use |
| `style` | `'condensed'` (optional) | Compact rendering for subagent views |
| `tools` | `Tools` | All registered tools |
| `verbose` | `boolean` | Whether to show full output (transcript mode) |
| `width` | `number \| string` | Available width for rendering |
| `isTranscriptMode` | `boolean` (optional) | Whether displaying in transcript view |

> Source: `src/components/messages/UserToolResultMessage/UserToolResultMessage.tsx:12-22`

### `useGetToolFromMessages(toolUseID: string, tools: Tools, lookups): { tool: Tool; toolUse: ToolUseBlockParam } | null`

Utility hook that resolves a tool use ID to its `Tool` definition and `ToolUseBlockParam`. Returns `null` if either the tool use block or the tool definition can't be found.

> Source: `src/components/messages/UserToolResultMessage/utils.tsx:6-43`

## Standalone Fallback Components

These components live at the `src/components/` root level and serve as generic fallbacks or tool-specific result renderers.

### `FallbackToolUseErrorMessage({ result, verbose })`

Generic error display used when a tool doesn't define its own error renderer (`FallbackToolUseErrorMessage.tsx:16-115`).

- Extracts error text from `<tool_use_error>` tags, strips sandbox violation and `<error>` tags
- Simplifies `InputValidationError` messages to "Invalid tool parameters" in non-verbose mode
- Truncates output to **10 lines** in non-verbose mode with a "+ N lines" indicator and a transcript shortcut hint (`ctrl+o`)
- Strips underline ANSI codes and renders error text in the `error` color

### `FallbackToolUseRejectedMessage()`

Minimal fallback for rejected tool uses (`FallbackToolUseRejectedMessage.tsx:5-15`). Simply renders `<InterruptedByUser />` wrapped in `<MessageResponse height={1}>`.

### `FileEditToolUpdatedMessage({ filePath, structuredPatch, firstLine, fileContent, style, verbose, previewHint })`

Renders successful file edit results (`FileEditToolUpdatedMessage.tsx:18-111`).

- Counts added/removed lines from structured patch hunks
- Displays a summary line like "Added **3** lines, removed **1** line"
- In condensed mode without verbose, returns just the text summary
- If `previewHint` is provided (plan mode files), shows only the hint in regular mode
- Otherwise renders the full `<StructuredDiffList>` with hunks, adjusting width by subtracting 12 columns for the response gutter

### `FileEditToolUseRejectedMessage({ file_path, operation, patch, firstLine, fileContent, content, style, verbose })`

Renders rejected file edit/write operations (`FileEditToolUseRejectedMessage.tsx:24-100+`).

- Shows "User rejected {write|update} to **{path}**" header in subtle color
- For `write` operations with content: shows syntax-highlighted code preview, truncated to 10 lines in non-verbose mode
- For `update` operations with patch: shows the `<StructuredDiffList>` diff
- In condensed mode, returns just the header text

### `NotebookEditToolUseRejectedMessage({ notebook_path, cell_id, new_source, cell_type, edit_mode, verbose })`

Renders rejected notebook cell edits (`NotebookEditToolUseRejectedMessage.tsx:16-91`).

- Displays "User rejected {replace|insert|delete} cell in **{path}** at cell {id}"
- Shows relative paths in non-verbose mode
- For non-delete operations: renders syntax-highlighted source preview (Markdown or Python based on `cell_type`)
- `edit_mode` defaults to `'replace'`

### `InterruptedByUser()`

Shared component for user interruption display (`InterruptedByUser.tsx:4-14`). Renders dimmed text: "Interrupted · What should Claude do instead?"

### Specialized Sub-Components

#### `RejectedPlanMessage({ plan })`

Displays a rejected plan with the plan content in a bordered box styled with `planMode` color (`RejectedPlanMessage.tsx:9-30`). Renders the plan as Markdown.

#### `RejectedToolUseMessage()`

Minimal component that displays "Tool use rejected" in dimmed text (`RejectedToolUseMessage.tsx:5-15`).

#### `UserToolCanceledMessage()`

Wraps `<InterruptedByUser />` in a `<MessageResponse>` for canceled tool calls (`UserToolCanceledMessage.tsx:5-15`).

## Edge Cases & Caveats

- **Old/missing tools**: When resuming a conversation that used a now-removed tool, `useGetToolFromMessages()` returns `null` and the entire result is silently hidden. The `tool` prop is typed as optional (`Tool | undefined`) for this reason.
- **Corrupt transcript data**: `UserToolSuccessMessage` validates tool results against `outputSchema` before rendering, returning `null` for parse failures. This guards against crashes from corrupt/partial data in resumed JSONL transcripts.
- **Classifier approvals are ephemeral**: `UserToolSuccessMessage` captures classifier approval data from a global `Map` on mount via `useState` lazy initializer, then immediately deletes it to prevent memory growth. This means the approval annotation is render-once data.
- **Width handling**: Tools whose `userFacingName()` returns `''` render without the standard width constraint, allowing them to behave like plain assistant text (important for Markdown table rendering).
- **Feature flags**: Several behaviors are gated behind compile-time feature flags (`TRANSCRIPT_CLASSIFIER`, `BASH_CLASSIFIER`, `KAIROS`, `KAIROS_BRIEF`) which are resolved at build time via `bun:bundle`.
- **Verbose vs condensed**: The `verbose` flag (from transcript mode) and `style: 'condensed'` (from subagent views) interact to control output detail. Condensed mode typically shows summaries; verbose shows full content.