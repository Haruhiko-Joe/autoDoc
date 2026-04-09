# MessagePipeline

## Overview & Responsibilities

The MessagePipeline is the core message rendering orchestration layer within the **TerminalUI → Components → MessageDisplay** hierarchy of Claude Code's terminal interface. It transforms raw conversation messages from the QueryEngine into rendered terminal output through a three-stage pipeline:

1. **`src/components/Messages.tsx`** — Top-level container: normalizes, filters, reorders, groups, collapses, and slices the raw message array
2. **`src/components/Message.tsx`** — Type dispatcher: routes each normalized message to its specific renderer component based on message type
3. **`src/components/MessageRow.tsx`** — Row layout wrapper: adds metadata (model label, timestamp), manages animation state, and wraps content with `OffscreenFreeze` for render optimization

Sibling modules in the MessageDisplay group include the 30+ individual message type renderers (e.g., `AssistantTextMessage`, `UserToolResultMessage`), the `VirtualMessageList` for efficient scrolling, message actions, and compact summaries. The parent Components module sits within TerminalUI alongside Hooks, Screens, and AppState.

The data flow is: **raw messages → normalization/filtering → reordering → grouping → collapsing → type dispatch → row layout → rendered output**.

## Key Processes

### 1. Message Normalization & Filtering (Messages.tsx)

The `MessagesImpl` component receives a raw `MessageType[]` array and applies a multi-stage transformation pipeline inside a `useMemo` block (`src/components/Messages.tsx:486-529`):

1. **Normalize**: `normalizeMessages(messages)` (from `src/utils/messages.ts`) splits multi-block messages into individual normalized messages, each with a derived UUID
2. **Filter empty**: `.filter(isNotEmptyMessage)` removes messages with no renderable content
3. **Compact boundary**: In non-fullscreen mode, `getMessagesAfterCompactBoundary()` hides pre-compaction messages (they live in terminal scrollback)
4. **Reorder**: `reorderMessagesInUI()` reorders messages for display coherence (e.g., moving streaming tool uses next to their results)
5. **Filter progress/attachments**: Drops `progress` type messages and null-rendering attachments (`hook_success`, `hook_additional_context`, etc.)
6. **Brief filtering**: When the Brief tool is active, `filterForBriefTool()` or `dropTextInBriefTurns()` strips redundant assistant text
7. **Transcript truncation**: In transcript mode, limits to last 30 messages (`MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE`) unless "show all" is toggled
8. **Group**: `applyGrouping()` (from `src/utils/groupToolUses.ts`) merges consecutive tool uses of the same type into `grouped_tool_use` messages
9. **Collapse**: A chain of four collapse functions merges related items into compact displays:
   - `collapseReadSearchGroups()` (from `src/utils/collapseReadSearch.ts`) — merges consecutive read/search tool calls into `collapsed_read_search` groups
   - `collapseTeammateShutdowns()` (from `src/utils/collapseTeammateShutdowns.ts`) — collapses teammate shutdown notifications
   - `collapseHookSummaries()` (from `src/utils/collapseHookSummaries.ts`) — merges hook summary messages
   - `collapseBackgroundBashNotifications()` (from `src/utils/collapseBackgroundBashNotifications.ts`) — collapses background bash notifications
10. **Build lookups**: `buildMessageLookups()` (from `src/utils/messages.ts`) creates index maps (tool_use_id → message, resolved IDs, progress messages, sibling IDs)

The collapsed result and lookups are memoized separately from the render-range slice, so scrolling does not re-run the O(n) transforms.

### 2. Render Capping & Virtualization (Messages.tsx)

Two strategies prevent unbounded rendering:

- **Virtual scroll** (`src/components/VirtualMessageList.tsx`): Used in fullscreen mode when `scrollRef` is present. Renders only visible items — no message cap needed. The virtual list is wrapped in `InVirtualListContext.Provider` (`src/components/Messages.tsx:699-701`).
- **Non-virtualized cap** (`MAX_MESSAGES_WITHOUT_VIRTUALIZATION = 200`): For the main-screen mode, a UUID-anchored sliding window keeps at most ~200 messages rendered. The anchor advances in steps of 50 (`MESSAGE_CAP_STEP`) to avoid per-message shifts. The `computeSliceStart()` function (`src/components/Messages.tsx:315-340`) manages this anchor with fallback logic for when UUIDs become stale after collapse regrouping.

The UUID-anchor approach replaced earlier count-based slicing, which caused full terminal resets on every append (CC-941) or on compaction/collapse regrouping (CC-1174). The anchor stores both UUID and index; when the UUID vanishes (e.g., `collapseHookSummaries` reshuffles adjacency), the stored index (clamped) keeps the slice stable.

### 3. Streaming Tool Use Integration (Messages.tsx)

Streaming tool uses arrive as `StreamingToolUse[]` objects separate from the main message array. The pipeline converts them to synthetic assistant messages (`src/components/Messages.tsx:447-458`):

1. Filter out tool uses already in `inProgressToolUseIDs` or `normalizedToolUseIDs`
2. Wrap each remaining streaming tool use in `createAssistantMessage()`
3. Override the UUID with `deriveUUID(contentBlock.id, 0)` for deterministic React keys — fresh `randomUUID` calls would cause component remounts and Ink rendering corruption
4. Normalize via `normalizeMessages()` to match the rest of the pipeline

These synthetic messages are passed to `reorderMessagesInUI()` alongside the real messages.

### 4. Message Type Dispatch (Message.tsx)

`MessageImpl` (`src/components/Message.tsx:58`) receives a normalized message and switches on `message.type`:

| Type | Renderer Component | Description |
|------|-------------------|-------------|
| `attachment` | `AttachmentMessage` | File attachments, queued commands |
| `assistant` | Maps each content block via `AssistantMessageBlock` | Text, tool use, thinking, advisor blocks |
| `user` | Maps each content block via `UserMessage` | Text input, images, tool results |
| `system` | `SystemTextMessage`, `CompactBoundaryMessage`, `UserTextMessage` | System notices, compact boundaries, local commands, snip boundaries |
| `grouped_tool_use` | `GroupedToolUseContent` | Multiple tool calls displayed together |
| `collapsed_read_search` | `CollapsedReadSearchContent` (wrapped in `OffscreenFreeze`) | Collapsed read/search operations |

**Assistant content block dispatch** (`AssistantMessageBlock`, `src/components/Message.tsx:433`):

| Block Type | Renderer |
|------------|----------|
| `tool_use` | `AssistantToolUseMessage` |
| `text` | `AssistantTextMessage` |
| `thinking` | `AssistantThinkingMessage` (visibility controlled by `lastThinkingBlockId`) |
| `redacted_thinking` | `AssistantRedactedThinkingMessage` |
| `connector_text` | `AssistantTextMessage` (feature-gated via `CONNECTOR_TEXT`) |
| Advisor blocks | `AdvisorMessage` |

**User content block dispatch** (`UserMessage`, `src/components/Message.tsx:356`):

| Block Type | Renderer |
|------------|----------|
| `text` | `UserTextMessage` |
| `image` | `UserImageMessage` |
| `tool_result` | `UserToolResultMessage` |

For `user` messages with `isCompactSummary`, the dispatcher renders a `CompactSummary` instead of the normal block-level dispatch.

### 5. Row Layout & Optimization (MessageRow.tsx)

`MessageRowImpl` (`src/components/MessageRow.tsx:93`) wraps each dispatched message with layout concerns:

1. **Display message resolution**: For `grouped_tool_use`, uses `msg.displayMessage`; for `collapsed_read_search`, uses `getDisplayMessageFromCollapsed(msg)` (from `src/utils/collapseReadSearch.ts`); otherwise uses the message directly
2. **Progress messages**: Looks up associated progress messages via `getProgressMessagesFromLookup()` (from `src/utils/messages.ts`), skipping this for grouped/collapsed types
3. **Static determination**: Calls `shouldRenderStatically()` to decide if the message can skip re-rendering
4. **Animation state**: Determines `shouldAnimate` based on whether the message has in-progress tool uses — checks vary by type (grouped iterates `msg.messages`, collapsed uses `hasAnyToolInProgress`, individual checks `inProgressToolUseIDs`)
5. **Metadata row**: In transcript mode, assistant messages with text content get a header row containing `MessageTimestamp` (`src/components/MessageTimestamp.tsx`) and `MessageModel` (`src/components/MessageModel.tsx`) (`src/components/MessageRow.tsx:267-275`)
6. **OffscreenFreeze**: Every message row is wrapped in `<OffscreenFreeze>` (`src/components/OffscreenFreeze.tsx`) to skip re-rendering when off-screen

### 6. Final Rendering (Messages.tsx)

The `renderMessageRow` callback (`src/components/Messages.tsx:614-637`) assembles each row:

1. Determines `isUserContinuation` (consecutive user messages suppress duplicate margin)
2. Pre-computes `hasContentAfter` for collapsed read/search groups (controls spinner state)
3. Renders `<MessageRow>` with all derived props
4. Wraps in `MessageActionsSelectedContext.Provider` for cursor-based selection
5. Optionally inserts an "unseen divider" before the first unseen message in fullscreen mode

The final JSX (`src/components/Messages.tsx:677-720`) renders:
- `LogoHeader` (memoized, only for first chunk or non-range renders)
- Truncation/show-all dividers
- Either `VirtualMessageList` (fullscreen) or `renderableMessages.flatMap(renderMessageRow)` (main screen)
- Streaming text preview via `StreamingMarkdown`
- Streaming thinking block via `AssistantThinkingMessage`

## Function Signatures

### `Messages` (exported, memoized)

```typescript
const Messages: React.MemoExoticComponent<(props: Props) => React.ReactNode>
```

Key props:
- **`messages: MessageType[]`** — Raw conversation messages from the query engine
- **`tools: Tools`** — Available tool definitions (used for grouping/collapsing logic)
- **`inProgressToolUseIDs: Set<string>`** — Tool calls currently being executed
- **`streamingToolUses: StreamingToolUse[]`** — Tool uses still receiving streaming input
- **`screen: Screen`** — Current screen mode (`"prompt"` or `"transcript"`)
- **`isLoading: boolean`** — Whether the query engine is actively loading
- **`isBriefOnly?: boolean`** — When true, only show Brief tool output
- **`scrollRef?: RefObject<ScrollBoxHandle>`** — Enables virtual scroll in fullscreen mode
- **`renderRange?: readonly [start, end]`** — For chunked export, renders only a slice

> Source: `src/components/Messages.tsx:207-275`

### `MessageRow` (exported, memoized)

```typescript
const MessageRow: React.MemoExoticComponent<(props: Props) => React.ReactNode>
```

Key props:
- **`message: RenderableMessage`** — A post-processing message (may be grouped or collapsed)
- **`hasContentAfter: boolean`** — Whether substantive content follows (controls collapsed group spinner)
- **`lookups: ReturnType<typeof buildMessageLookups>`** — Pre-built index maps for message relationships
- **`canAnimate: boolean`** — Whether animation is allowed (disabled during permission prompts/tool JSX)
- **`columns: number`** — Terminal width for layout

> Source: `src/components/MessageRow.tsx:15-38`

### `shouldRenderStatically(message, streamingToolUseIDs, inProgressToolUseIDs, siblingToolUseIDs, screen, lookups): boolean`

Determines if a message can be rendered as static (immutable) content. Key rules:
- Transcript mode → always static
- Tool uses streaming, in-progress, or with unresolved hooks → never static
- `collapsed_read_search` in prompt mode → never static (prevents flicker between API turns)
- `system` with `api_error` subtype → never static (hidden when next non-error arrives)
- `grouped_tool_use` → static only when all contained tools are resolved

> Source: `src/components/Messages.tsx:779-833`

### `computeSliceStart(collapsed, anchorRef, cap?, step?): number`

Calculates the start index for the non-virtualized render cap. Uses a UUID-anchored approach that only advances when count exceeds `cap + step`, immune to length churn from grouping/compaction. Exported for testing.

> Source: `src/components/Messages.tsx:315-340`

### `filterForBriefTool<T>(messages, briefToolNames): T[]`

Filters messages for brief-only mode: keeps Brief `tool_use` blocks, their `tool_result`s, real user input, and system messages (except `api_metrics`). Collects Brief tool_use IDs in a single pass so tool_results can be matched.

> Source: `src/components/Messages.tsx:93-158`

### `dropTextInBriefTurns<T>(messages, briefToolNames): T[]`

Two-pass filter for the default (non-brief-only) mode when Brief tool is active. First pass identifies which conversation turns contain a Brief tool_use. Second pass drops assistant text blocks only in those turns, leaving text visible in turns where Brief was not called.

> Source: `src/components/Messages.tsx:169-206`

### `hasContentAfterIndex(messages, index, tools, streamingToolUseIDs): boolean`

Scans forward from `index + 1` to check if non-collapsible content follows. Skips thinking/redacted_thinking blocks, collapsible tool uses, streaming tool uses, system/attachment messages, tool results, and collapsible grouped_tool_use messages. Used to determine whether a collapsed read/search group spinner should stay active.

> Source: `src/components/MessageRow.tsx:50-92`

### `areMessageRowPropsEqual(prev, next): boolean`

Conservative memo comparator for `MessageRow`. Fails safe by re-rendering when uncertain. Bails out early for: different message reference, screen mode change, verbose toggle, width change, `latestBashOutputUUID` affecting this row, `lastThinkingBlockId` changes (only for messages with thinking content), and any message still streaming or unresolved.

> Source: `src/components/MessageRow.tsx:342-381`

## Performance Optimizations

The pipeline contains several deliberate performance safeguards documented in inline comments:

1. **Memoized `LogoHeader`** (`src/components/Messages.tsx:47-76`): Prevents the logo from re-rendering on every message update. Without this, `renderChildren`'s `seenDirtyChild` cascade disables `prevScreen` (blit) for all subsequent siblings — in long sessions (~2800 messages) this means 150K+ writes/frame pegging CPU at 100%.

2. **Split `useMemo`s** (`src/components/Messages.tsx:476-543`): The expensive message transforms (filter, reorder, group, collapse, lookups) are separated from the render-range slice. Previously these were combined with `renderRange` — every scroll rebuilt 6 Maps over 27k messages plus 4 filter/map passes (~50ms alloc per scroll), causing GC pressure and 100-173ms stop-the-world pauses on a 1GB heap.

3. **Custom `React.memo` comparators**: Both `Messages` (`src/components/Messages.tsx:741-778`) and `MessageRow` (`src/components/MessageRow.tsx:342-382`) use custom equality functions. The `Messages` comparator skips stable callback props and does structural comparison for Sets, streaming tool use arrays, and the unseen divider.

4. **UUID-anchored slice** (`src/components/Messages.tsx:289-312`): Replaced count-based slicing which caused full terminal resets per append (CC-941) and on compaction/collapse regrouping (CC-1174). The anchor stores both UUID and index to handle UUID instability from `collapseHookSummaries`.

5. **`OffscreenFreeze` wrapping** (`src/components/OffscreenFreeze.tsx`): Every message row is wrapped to skip rendering when scrolled off-screen.

6. **`hasContentAfterIndex` pre-computation**: Computed once per message in `renderMessageRow` and passed as a boolean prop. This avoids passing the full `renderableMessages` array to each `MessageRow`, which React Compiler would pin in the fiber's `memoCache`, accumulating every historical version (~1-2MB over a 7-turn session).

7. **Search text caching** (`src/components/Messages.tsx:649-676`): A `WeakMap<RenderableMessage, string>` cache stores lowercased search text per message. Lowering is done once at warm time instead of per keystroke, eliminating per-keystroke allocations during transcript search.

## Edge Cases & Caveats

- **Streaming tool use key stability**: Tool uses arriving via streaming are assigned deterministic UUIDs via `deriveUUID(contentBlock.id, 0)`. Without this, fresh `randomUUID()` calls produce unstable React keys → component remounts → Ink rendering corruption (overlapping text from stale DOM nodes) (`src/components/Messages.tsx:451-456`).

- **Brief mode text dropping**: `dropTextInBriefTurns()` only drops assistant text in turns that actually called Brief. If the model forgets to call Brief, text still shows so the user sees something. `filterForBriefTool()` (strict brief-only mode) intentionally shows nothing for turns without Brief — "that's on the model to get right" (`src/components/Messages.tsx:87-91`).

- **Collapsed group active state**: A collapsed read/search group shows as "active" (spinner, present-tense label) when either: (a) any contained tool is in `inProgressToolUseIDs`, OR (b) the query is loading (`isLoading`) with no substantive content after it (`src/components/MessageRow.tsx:117-118`).

- **Thinking block visibility**: In transcript mode with `hidePastThinking`, only the last thinking block from the current turn is shown. When streaming thinking is active, all completed thinking blocks are hidden via a special `'streaming'` ID that won't match any block. The search stops at the last non-tool-result user message to avoid showing stale thinking from previous turns (`src/components/Messages.tsx:395-419`).

- **`collapsed_read_search` never static in prompt mode** (`src/components/Messages.tsx:826-831`): Prevents flicker between API turns when read groups finalize and need visual updates.

- **Export chunking**: The `renderRange` prop enables chunked headless export (`/export` via `renderToString`). The logo renders only for chunk 0 (`start === 0`); later chunks are mid-stream continuations. Measured: 538-message session, 20 slices → −55% plateau RSS (`src/components/Messages.tsx:269-274`).

- **`disableRenderCap`**: Bypasses `MAX_MESSAGES_WITHOUT_VIRTUALIZATION` for one-shot headless renders (e.g., `/export`) where the memory concern doesn't apply and content isn't in scrollback (`src/components/Messages.tsx:259-262`).