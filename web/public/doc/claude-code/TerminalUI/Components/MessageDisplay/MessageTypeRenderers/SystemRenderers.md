# SystemRenderers

## Overview & Responsibilities

The SystemRenderers module contains React components responsible for rendering **system-role messages** in the Claude Code terminal UI. These are the non-conversational messages that communicate application state, errors, progress, and metadata to the user — everything from "Worked for 12s" turn summaries to rate limit warnings and shutdown notifications.

Within the TerminalUI → Components → MessageDisplay → MessageTypeRenderers hierarchy, this module handles the `system` message role. The central component, `SystemTextMessage`, acts as a dispatcher that routes 10+ message subtypes to specialized inline render functions. Supporting components handle API errors, rate limits, shutdown flows, hook progress, conversation compaction markers, and task assignments.

### Sibling Context

This module sits alongside other message type renderers for assistant messages (text, thinking, tool use), user messages (prompts, commands, images), and tool result messages. The `Message.tsx` dispatcher in the MessagePipeline routes system-role messages here.

---

## Key Processes

### SystemTextMessage Dispatch Flow

The main `SystemTextMessage` component (`src/components/messages/SystemTextMessage.tsx:36`) receives a `SystemMessage` with a `subtype` field and routes it through a chain of conditional checks:

1. **`turn_duration`** → `TurnDurationMessage` — shows how long a turn took, with optional thinking budget stats
2. **`memory_saved`** → `MemorySavedMessage` — displays saved memory count with clickable file links
3. **`away_summary`** → inline render with `※` (reference mark) prefix, dimmed text
4. **`agents_killed`** → inline "All background agents stopped" with error-colored dot
5. **`thinking`** → returns `null` (suppressed in normal rendering)
6. **`bridge_status`** → `BridgeStatusMessage` — shows `/remote-control` is active with a clickable URL
7. **`scheduled_task_fire`** → shows scheduled task notification with `✽` prefix
8. **`permission_retry`** → shows "Allowed {commands}" when a permission rule is applied
9. **`api_error`** → delegates to `SystemAPIErrorMessage`
10. **`stop_hook_summary`** → `StopHookSummaryMessage` — shows how many stop hooks ran, errors, and whether continuation was prevented

For any unmatched subtype with string content, the fallback `SystemTextMessageInner` renders a generic text message with a colored dot indicator based on `message.level` (info/warning/error). Info-level messages are hidden unless verbose mode is active (`src/components/messages/SystemTextMessage.tsx:201`).

### API Error Retry Flow

`SystemAPIErrorMessage` (`src/components/messages/SystemAPIErrorMessage.tsx:15`):

1. Hides early retry attempts (attempts < 4) to reduce noise
2. Formats the error via `formatAPIError()` and truncates to 1000 chars unless verbose
3. Shows a live countdown timer (1-second intervals via `useInterval`) counting down to the next retry
4. Displays attempt number (e.g., "attempt 3/5") and hints about `API_TIMEOUT_MS` if set
5. Shows `CtrlOToExpand` hint when content is truncated

### Rate Limit Warning Flow

`RateLimitMessage` (`src/components/messages/RateLimitMessage.tsx:52`):

1. Determines subscription type and rate limit tier on mount
2. Checks if the user is a Claude AI subscriber for upsell eligibility
3. Monitors `claudeAiLimits` status to detect active rate limiting
4. Auto-opens the rate limit options menu for eligible users who haven't seen it
5. Shows contextual upsell messages via `getUpsellMessage()`:
   - Max 20x users → `/extra-usage` or `/login`
   - Team/Enterprise → `/extra-usage` (admin request if no billing access)
   - Others → `/upgrade` or `/extra-usage`
6. Renders a countdown timer showing time remaining until rate limit resets

### Shutdown Message Flow

`ShutdownMessage.tsx` handles multi-agent shutdown coordination:

1. `tryRenderShutdownMessage(content)` (`src/components/messages/ShutdownMessage.tsx:95`) parses raw message content to detect shutdown message types
2. **Shutdown requests** → `ShutdownRequestDisplay` renders a warning-bordered card with requester name and reason
3. **Shutdown approved** → skipped (handled inline by caller)
4. **Shutdown rejected** → `ShutdownRejectedDisplay` renders a subtle-bordered card with rejection reason and a note that the teammate continues working
5. `getShutdownMessageSummary()` (`src/components/messages/ShutdownMessage.tsx:117`) provides short text summaries for inbox queue display

---

## Function Signatures

### `SystemTextMessage({ message, addMargin, verbose, isTranscriptMode }): ReactNode`

Main dispatcher component for all system messages.

- **message** (`SystemMessage`): The system message with `subtype`, `content`, `level`, and subtype-specific fields
- **addMargin** (`boolean`): Whether to add top margin for visual separation
- **verbose** (`boolean`): Enables expanded display (show info-level messages, full error text, hook details)
- **isTranscriptMode** (`boolean`, optional): Adjusts rendering for transcript/history view

> Source: `src/components/messages/SystemTextMessage.tsx:36`

### `SystemAPIErrorMessage({ message, verbose }): ReactNode`

Renders API error with countdown timer and retry info.

- **message** (`SystemAPIErrorMessage`): Contains `retryAttempt`, `error`, `retryInMs`, `maxRetries`
- **verbose** (`boolean`): When false, truncates error text to 1000 characters

> Source: `src/components/messages/SystemAPIErrorMessage.tsx:15`

### `RateLimitMessage({ text, onOpenRateLimitOptions }): ReactNode`

Rate limit warning with countdown and upsell suggestions.

- **text** (`string`): Primary rate limit message text
- **onOpenRateLimitOptions** (`() => void`, optional): Callback to open the rate limit options menu

> Source: `src/components/messages/RateLimitMessage.tsx:52`

### `getUpsellMessage(params): string | null`

Pure function that determines the appropriate upsell message based on subscription state.

- Returns slash command suggestions like `/upgrade`, `/extra-usage`, or `/login`

> Source: `src/components/messages/RateLimitMessage.tsx:18`

### `tryRenderShutdownMessage(content): ReactNode | null`

Attempts to parse and render a shutdown message from raw string content.

> Source: `src/components/messages/ShutdownMessage.tsx:95`

### `getShutdownMessageSummary(content): string | null`

Returns a brief summary string for shutdown messages (e.g., `[Shutdown Request from agent-1]`).

> Source: `src/components/messages/ShutdownMessage.tsx:117`

### `HookProgressMessage({ hookEvent, lookups, toolUseID, verbose, isTranscriptMode }): ReactNode`

Shows progress for hook execution.

- **hookEvent** (`HookEvent`): The hook lifecycle event type (e.g., `PreToolUse`, `PostToolUse`)
- **lookups**: Message lookup maps containing `inProgressHookCounts` and `resolvedHookCounts`
- **toolUseID** (`string`): The tool use instance this hook applies to
- In transcript mode, shows a static summary ("2 PreToolUse hooks ran"); otherwise shows "Running {hookEvent} hook(s)..." while in progress

> Source: `src/components/messages/HookProgressMessage.tsx:14`

### `CompactBoundaryMessage(): ReactNode`

Renders the "✻ Conversation compacted" marker with a keyboard shortcut hint for viewing history.

> Source: `src/components/messages/CompactBoundaryMessage.tsx:5`

### `TaskAssignmentDisplay({ assignment }): ReactNode`

Renders a task assignment card with cyan border showing task ID, assignee, subject, and description.

> Source: `src/components/messages/TaskAssignmentMessage.tsx:12`

### `tryRenderTaskAssignmentMessage(content): ReactNode | null`

Parses raw content and renders a `TaskAssignmentDisplay` if it matches the task assignment format.

> Source: `src/components/messages/TaskAssignmentMessage.tsx:58`

### `teamMemSavedPart(message): { segment: string; count: number } | null`

Helper for the memory-saved UI that computes the team memory segment. Only loaded when the `TEAMMEM` feature flag is enabled.

> Source: `src/components/messages/teamMemSaved.ts:10`

---

## Internal Components

### `TurnDurationMessage`

Displays turn completion info (`src/components/messages/SystemTextMessage.tsx:494`):
- Randomly selects a completion verb from `TURN_COMPLETION_VERBS` (e.g., "Worked", "Ran")
- Shows formatted duration (e.g., "Worked for 12s")
- Optionally appends thinking budget usage (tokens used vs. limit, percentage, nudge count)
- Appends background task summary if agents are still running
- Respects `showTurnDuration` config setting

### `MemorySavedMessage`

Shows memory save confirmation (`src/components/messages/SystemTextMessage.tsx:594`):
- Separates private vs. team memory counts (team feature-gated behind `TEAMMEM`)
- Displays "Saved 2 memories · 1 team memory"
- Lists each written file path as a clickable `MemoryFileRow` with hover underline and click-to-open

### `StopHookSummaryMessage`

Summarizes stop hook execution (`src/components/messages/SystemTextMessage.tsx:251`):
- Shows total hook count, total duration, and optional label
- In verbose mode, lists each hook command individually
- Displays hook errors and stop reasons when continuation was prevented
- In transcript mode, shows individual hook commands inline

### `BridgeStatusMessage`

Renders the remote-control status indicator (`src/components/messages/SystemTextMessage.tsx:768`):
- Shows that `/remote-control` is active
- Displays the bridge URL as a clickable link

---

## Configuration & Defaults

| Config | Source | Default | Description |
|--------|--------|---------|-------------|
| `showTurnDuration` | `getGlobalConfig()` | `true` | Controls whether turn duration is displayed |
| `API_TIMEOUT_MS` | Environment variable | — | If set, shown as a hint in API error messages |
| `TEAMMEM` feature flag | `bun:bundle` feature gate | — | Enables team memory display in `MemorySavedMessage` |
| `MAX_API_ERROR_CHARS` | Constant | `1000` | Truncation limit for API error text in non-verbose mode |

---

## Edge Cases & Caveats

- **Early retry suppression**: `SystemAPIErrorMessage` silently hides the first 3 API error retry attempts on external builds to avoid noise (`src/components/messages/SystemAPIErrorMessage.tsx:27`). Users won't see errors until attempt 4+.

- **Info-level suppression**: Non-stop-hook system messages at `info` level are hidden unless verbose mode is active (`src/components/messages/SystemTextMessage.tsx:201`). This means many system messages are invisible by default.

- **Thinking subtype returns null**: The `thinking` subtype is explicitly suppressed — it returns `null` in `SystemTextMessage` (`src/components/messages/SystemTextMessage.tsx:122-124`). Thinking display is handled elsewhere.

- **Shutdown approved is skipped**: `tryRenderShutdownMessage` returns `null` for approved shutdown messages because the caller handles those inline (`src/components/messages/ShutdownMessage.tsx:101-104`).

- **React Compiler optimization**: All components use the React Compiler runtime (`_c()` memoization cache) for fine-grained reactivity. The `teamMemSaved` module is deliberately a plain function (not a component) to avoid React Compiler hoisting issues with property access.

- **Countdown timer precision**: Both `SystemAPIErrorMessage` and `RateLimitMessage` use 1-second interval timers for countdowns, so displayed values may be up to 1 second off from actual remaining time.

- **Rate limit auto-open**: The rate limit options menu auto-opens exactly once per component mount for eligible users who are currently rate-limited (`src/components/messages/RateLimitMessage.tsx:88`). The `hasOpenedInteractiveMenu` state prevents repeated opens.

- **Team-aware colors**: `TaskAssignmentDisplay` and `ShutdownRequestDisplay` use special color tokens (`cyan_FOR_SUBAGENTS_ONLY`, `warning`) that are only meaningful in sub-agent contexts.