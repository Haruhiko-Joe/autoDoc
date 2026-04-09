# SpecialRenderers

## Overview & Responsibilities

The SpecialRenderers module is a collection of seven specialized React components and utilities within the **MessageDisplay > MessageTypeRenderers** layer of the TerminalUI. These renderers handle composite, cross-cutting, and non-standard message types that don't fit neatly into the simple assistant/user/system message categories. They sit alongside the 30+ standard message type renderers and are dispatched by the `Message.tsx` dispatcher based on message type.

Within the broader architecture, this module belongs to:
**TerminalUI → Components → MessageDisplay → MessageTypeRenderers**

Sibling modules handle assistant text/thinking rendering, user prompt rendering, system message rendering, and tool result rendering. The SpecialRenderers handle the more complex composite cases: rich attachments, collapsed tool groups, plan approval workflows, advisor messages, grouped tool invocations, team memory display, and null-rendering attachment filtering.

## Key Components

### AttachmentMessage (`AttachmentMessage.tsx`)

The largest renderer (~535 lines), responsible for displaying all `Attachment`-typed messages. It uses a massive `switch` statement over `attachment.type` to dispatch rendering for 30+ attachment types.

**Key rendering paths:**

1. **Teammate mailbox** (pre-switch, guard: `isAgentSwarmsEnabled()`): Filters out invisible messages (idle notifications, shutdown approvals), then renders task assignments, plan approval messages, and plain teammate messages with colored sender headers.

2. **Skill discovery** (pre-switch, guard: `feature('EXPERIMENTAL_SKILL_SEARCH')`): Shows discovered skills with optional feedback hints for internal users.

3. **File/directory attachments** (`file`, `already_read_file`, `directory`, `compact_file_reference`, `pdf_reference`): Renders one-line summaries like `Read src/foo.ts (42 lines)` or `Listed directory src/`.

4. **IDE integration** (`selected_lines_in_ide`): Shows line selections from connected IDEs.

5. **Memory attachments** (`relevant_memories`, `nested_memory`): Renders recalled memories with expandable content via `CtrlOToExpand`.

6. **Hook results** (`hook_blocking_error`, `hook_non_blocking_error`, `hook_error_during_execution`, `hook_stopped_continuation`, `hook_system_message`, `hook_permission_decision`, `async_hook_response`): Various hook lifecycle events with appropriate error coloring.

7. **Task status** (`task_status`): Delegates to `TaskStatusMessage` → `GenericTaskStatus` or `TeammateTaskStatus` (for agent swarms), showing background task completion/running states.

8. **Default/null branch**: Falls through to `null` for types listed in `nullRenderingAttachments.ts`, with a TypeScript `satisfies` assertion ensuring exhaustiveness.

**Internal helper components:**
- `Line` — wraps content in `MessageResponse` with dim styling and background color
- `TaskStatusMessage` — routes to generic or teammate task status display
- `GenericTaskStatus` / `TeammateTaskStatus` — render task completion with appropriate agent coloring

> Source: `src/components/messages/AttachmentMessage.tsx:36-357` (main component), `src/components/messages/AttachmentMessage.tsx:361-503` (task status helpers)

### CollapsedReadSearchContent (`CollapsedReadSearchContent.tsx`)

Renders collapsed groups of read/search/list tool operations as a compact one-line summary (e.g., "Searched for 3 patterns, read 5 files, recalled 2 memories…"). This is one of the most visually prominent components — users see it constantly as Claude explores codebases.

**Two rendering modes:**

1. **Verbose mode** (`verbose: true`): Renders each individual tool use with its result using the internal `VerboseToolUse` component, which resolves the tool, parses input/output via schemas, and renders the tool's own `renderToolUseMessage` and `renderToolResultMessage`.

2. **Collapsed mode** (default): Builds a comma-separated summary line from multiple count categories:
   - **Git operations** (commits, pushes, branch merges, PRs) — lead the line as "load-bearing outcomes"
   - **Search/read/list counts** — "Searched for N patterns, read N files, listed N directories"
   - **REPL/MCP/bash counts** — additional tool usage summaries
   - **Memory operations** — "recalled N memories, searched memories, wrote N memories"
   - **Team memory** (feature-gated via `TEAMMEM`) — delegated to `teamMemCollapsed.tsx`

**Key design details:**
- Uses `useRef` to track maximum-ever-seen counts, preventing visual jitter from streaming count dips
- Shows a live hint (`displayedHint`) with the current file/pattern being processed, debounced via `useMinDisplayTime` (700ms minimum display)
- Displays shell progress (elapsed time, line count) for long-running bash commands after 2 seconds
- Shows a `ToolUseLoader` spinner when the group is actively loading, or a 2-char gutter when finalized
- Tense changes between active ("Reading", "Searching") and completed ("Read", "Searched")
- Hook execution time summaries are appended at the bottom

> Source: `src/components/messages/CollapsedReadSearchContent.tsx:142-482`

### PlanApprovalMessage (`PlanApprovalMessage.tsx`)

Handles the plan review and approval workflow used in multi-agent (teammate) scenarios.

**Exported components and functions:**

| Export | Description |
|--------|-------------|
| `PlanApprovalRequestDisplay` | Renders a plan approval request with a `planMode`-colored border, showing the plan content in Markdown and the plan file path |
| `PlanApprovalResponseDisplay` | Renders approval (green `✓` border) or rejection (red `✗` border with feedback) |
| `tryRenderPlanApprovalMessage(content, senderName)` | Parses a raw string, returns the appropriate display component if it's a plan approval message, `null` otherwise |
| `formatTeammateMessageContent(content)` | Formats structured teammate messages (plan approvals, shutdowns, idle notifications, task assignments) into brief summary strings |

**Flow:**
1. `tryRenderPlanApprovalMessage` is called by `AttachmentMessage` for each teammate mailbox message
2. It delegates to `isPlanApprovalRequest` / `isPlanApprovalResponse` (from `utils/teammateMailbox.js`) to parse the JSON
3. If matched, renders the appropriate display component

> Source: `src/components/messages/PlanApprovalMessage.tsx:17-221`

### AdvisorMessage (`AdvisorMessage.tsx`)

Renders messages from the advisor role — a secondary AI model that reviews the conversation and provides feedback.

**Handles three `AdvisorBlock` types:**

1. **`server_tool_use`**: Shows "Advising" with a `ToolUseLoader` spinner, optionally displaying the advisor model name and stringified input. Uses `addMargin` for spacing control.

2. **`advisor_tool_result_error`**: Shows "Advisor unavailable" with the error code in error color.

3. **`advisor_result`**: In verbose mode, shows the full advisor text. In normal mode, shows a checkmark with "Advisor has reviewed the conversation and will apply the feedback" plus `CtrlOToExpand` for detail access.

4. **`advisor_redacted_result`**: Same as `advisor_result` but without the expandable text (content was redacted).

Result blocks are wrapped in `MessageResponse` for the standard `⎿` indentation gutter.

> Source: `src/components/messages/AdvisorMessage.tsx:20-157`

### GroupedToolUseContent (`GroupedToolUseContent.tsx`)

A thin delegation layer that renders multiple tool uses of the same type as a single visual block. Used when consecutive tool calls of the same tool can be meaningfully grouped (e.g., multiple file reads shown as a batch).

**Flow:**
1. Looks up the tool by `message.toolName` using `findToolByName`
2. Returns `null` if the tool doesn't define `renderGroupedToolUse`
3. Builds a `resultsByToolUseId` map by iterating `message.results` and extracting `tool_result` content blocks
4. Maps each tool use message to a data object with: `param`, `isResolved`, `isError`, `isInProgress`, `progressMessages`, and `result`
5. Delegates to `tool.renderGroupedToolUse(toolUsesData, options)` — the tool itself owns the grouped rendering logic

> Source: `src/components/messages/GroupedToolUseContent.tsx:13-57`

### teamMemCollapsed (`teamMemCollapsed.tsx`)

Feature-gated module (`TEAMMEM` feature flag) that extends `CollapsedReadSearchContent` with team memory operation counts. Only loaded via `require()` when the feature is enabled, allowing dead-code elimination in external builds.

**Exports:**

| Export | Description |
|--------|-------------|
| `checkHasTeamMemOps(message)` | Returns `true` if the message has any team memory read/search/write counts > 0. Deliberately not a React component to avoid React Compiler hoisting |
| `TeamMemCountParts({message, isActiveGroup, hasPrecedingParts})` | Renders comma-separated count text for team memory reads ("Recalled N team memories"), searches ("Searched team memories"), and writes ("Wrote N team memories") with active/past tense |

Uses React Compiler memoization (`_c`) for efficient re-renders.

> Source: `src/components/messages/teamMemCollapsed.tsx:1-139`

### nullRenderingAttachments (`nullRenderingAttachments.ts`)

A pure TypeScript utility (no React) that defines which attachment types render as `null` unconditionally.

**Purpose:** The message rendering pipeline in `Messages.tsx` pre-filters these attachment types *before* counting and before the 200-message render cap. Without this, invisible attachments (like `hook_success`, `hook_additional_context`) would consume the render budget, causing real messages to be hidden (bug CC-724).

**The null-rendering types include:** `hook_success`, `hook_additional_context`, `hook_cancelled`, `command_permissions`, `agent_mention`, `budget_usd`, `critical_system_reminder`, `edited_image_file`, `edited_text_file`, `opened_file_in_ide`, `output_style`, `plan_mode`, `plan_mode_exit`, `plan_mode_reentry`, `structured_output`, `team_context`, `todo_reminder`, `context_efficiency`, `deferred_tools_delta`, `mcp_instructions_delta`, `companion_intro`, `token_usage`, `ultrathink_effort`, `max_turns_reached`, `task_reminder`, `auto_mode`, `auto_mode_exit`, `output_token_usage`, `pen_mode_enter`, `pen_mode_exit`, `verify_plan_reminder`, `current_session_memory`, `compaction_reminder`, `date_change`.

**Type safety:** The `NullRenderingAttachmentType` type is used in `AttachmentMessage`'s `default` branch via `satisfies`, so adding a new `Attachment` type without a render case or a null-rendering entry produces a compile error.

> Source: `src/components/messages/nullRenderingAttachments.ts:1-71`

## Function Signatures

### `AttachmentMessage({ attachment, addMargin, verbose, isTranscriptMode }): ReactNode`

| Parameter | Type | Description |
|-----------|------|-------------|
| `attachment` | `Attachment` | The attachment data to render |
| `addMargin` | `boolean` | Whether to add top margin |
| `verbose` | `boolean` | Verbose display mode |
| `isTranscriptMode` | `boolean?` | Whether displaying in transcript/export mode |

### `CollapsedReadSearchContent({ message, inProgressToolUseIDs, shouldAnimate, verbose, tools, lookups, isActiveGroup }): ReactNode`

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | `CollapsedReadSearchGroup` | The collapsed group data with counts and file paths |
| `inProgressToolUseIDs` | `Set<string>` | IDs of currently executing tool uses |
| `shouldAnimate` | `boolean` | Whether to animate spinners |
| `verbose` | `boolean` | When true, shows each tool use individually |
| `tools` | `Tools` | Available tool definitions |
| `lookups` | `ReturnType<typeof buildMessageLookups>` | Pre-computed message lookup tables |
| `isActiveGroup` | `boolean?` | True for the last group that's still loading |

### `AdvisorMessage({ block, addMargin, resolvedToolUseIDs, erroredToolUseIDs, shouldAnimate, verbose, advisorModel }): ReactNode`

### `GroupedToolUseContent({ message, tools, lookups, inProgressToolUseIDs, shouldAnimate }): ReactNode`

### `tryRenderPlanApprovalMessage(content: string, senderName: string): ReactNode | null`

### `isNullRenderingAttachment(msg: Message | NormalizedMessage): boolean`

## Edge Cases & Caveats

- **Render budget filtering**: `nullRenderingAttachments` must be kept in sync with `AttachmentMessage`'s switch. The TypeScript `satisfies` on the default branch enforces this at compile time — a missing case causes a type error.

- **Count jitter prevention**: `CollapsedReadSearchContent` uses `useRef` to track max-ever-seen counts because streaming can cause count dips during brief "invisible windows" in the executor pipeline.

- **Feature gating**: `teamMemCollapsed` is loaded via `require()` inside a `feature('TEAMMEM')` guard, enabling tree-shaking for external builds. The `checkHasTeamMemOps` function is intentionally *not* a React component to prevent the React Compiler from hoisting team memory property accesses.

- **Skill discovery guard**: The `skill_discovery` attachment type is handled *before* the switch statement so the string literal stays inside a `feature('EXPERIMENTAL_SKILL_SEARCH')`-guarded block — `case` labels can't be conditionally eliminated, but `if` bodies can.

- **Minimum hint display time**: `CollapsedReadSearchContent` holds each `⎿` hint for at least 700ms via `useMinDisplayTime`, preventing fast tool operations from flickering past unreadably.

- **Teammate mailbox filtering**: `AttachmentMessage` filters out idle notifications and shutdown approvals *before* counting visible messages, preventing confusing counts like "2 messages in mailbox:" with nothing shown.

- **Shell progress visibility**: Long-running bash commands in collapsed groups show elapsed time and line counts only after 2 seconds, keeping fast commands clean while reassuring users that slow ones aren't stuck.