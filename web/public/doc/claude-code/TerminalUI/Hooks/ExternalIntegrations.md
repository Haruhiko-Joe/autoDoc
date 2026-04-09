# External Integrations

## Overview & Responsibilities

The External Integrations module is a collection of 11 React hooks under `src/hooks/` that connect the terminal UI to systems beyond the local REPL — Chrome browser extensions, voice input hardware, SSH tunnels, remote WebSocket sessions, the claude.ai web bridge, and teammate mailbox messaging. Each hook follows a common pattern: wire up an external transport, convert inbound events into REPL-compatible messages (or prompt submissions), and relay outbound user actions (permission decisions, interrupts) back to the external system.

Within the **TerminalUI → Hooks** layer, these hooks sit alongside input-handling and UI-state hooks but are distinguished by their reliance on external I/O channels (MCP servers, WebSockets, SSH processes, filesystem mailboxes, native audio capture). Sibling modules like **Components** consume the state these hooks produce, and **Screens** (primarily the REPL screen) orchestrate their lifecycle.

---

## Chrome Extension Integration

### `useChromeExtensionNotification`

**File:** `src/hooks/useChromeExtensionNotification.tsx`

Displays a startup notification about the Chrome extension's status. Checks three conditions:

1. Whether Chrome integration is enabled (via `--chrome`/`--no-chrome` flags or default config)
2. Whether the user holds a claude.ai subscription (required for external builds)
3. Whether the Chrome extension is installed on the system

Depending on the result, it enqueues one of three notifications via `useStartupNotification`:
- **Error** (immediate, 5s): subscription required
- **Warning** (immediate, 3s): extension not detected, with install link
- **Info** (low priority): Chrome integration is default-enabled

### `usePromptsFromClaudeInChrome`

**File:** `src/hooks/usePromptsFromClaudeInChrome.tsx`

Listens for prompt notifications from the Claude for Chrome MCP server and injects them into the REPL's message queue. Two effects:

1. **Notification listener** — Finds the connected Chrome MCP client by name (`CLAUDE_IN_CHROME_MCP_SERVER_NAME`), registers a JSON-RPC 2.0 notification handler for `notifications/message`. Incoming prompts include text, an optional base64 image, and a `tabId`. Only messages from tracked tab IDs are processed. Text-only prompts are enqueued as strings; prompts with images are enqueued as `ContentBlockParam[]` arrays containing both text and image source blocks.

2. **Permission sync** — Whenever `toolPermissionMode` changes, calls `set_permission_mode` on the Chrome client via `callIdeRpc`, mapping `bypassPermissions` to `skip_all_permission_checks` and everything else to `ask`.

```typescript
// src/hooks/usePromptsFromClaudeInChrome.tsx:14-25
const ClaudeInChromePromptNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('notifications/message'),
    params: z.object({
      prompt: z.string(),
      image: z.object({ ... }).optional(),
      tabId: z.number().optional(),
    }),
  })
)
```

---

## Voice Input

Voice input spans three hooks with a layered architecture:

### `useVoiceEnabled`

**File:** `src/hooks/useVoiceEnabled.ts`

A simple gate that combines three conditions into a single boolean:
- **User intent**: `settings.voiceEnabled === true`
- **Auth**: `hasVoiceAuth()` (memoized on `authVersion` to avoid expensive keychain lookups on every render)
- **Feature flag**: `isVoiceGrowthBookEnabled()` (a cheap cached lookup, evaluated every render so a mid-session kill-switch takes effect)

### `useVoice`

**File:** `src/hooks/useVoice.ts`

The core hold-to-talk recording engine. States: `idle` → `recording` → `processing` → `idle`.

**Key design decisions:**

- **Lazy module loading**: The native audio module (`src/services/voice.ts` / `audio-capture-napi`) is imported only on first activation, avoiding macOS TCC microphone permission prompts until the user actually enables voice.
- **Hold-to-talk via auto-repeat detection**: Terminal key events don't have key-up events. Instead, the hook detects key release by arming a timer (`RELEASE_TIMEOUT_MS = 200ms`) that fires when auto-repeat stops. A separate `REPEAT_FALLBACK_MS = 600ms` timer handles the gap before auto-repeat starts.
- **Focus mode**: When enabled, recording starts on terminal focus and ends on blur, with a `FOCUS_SILENCE_TIMEOUT_MS = 5s` inactivity teardown.
- **Language support**: `normalizeLanguageForSTT()` maps language names (English and native) to BCP-47 codes. Supports 20 languages. Unsupported languages fall back to English.
- **Silent-drop replay**: ~1% of sessions hit a sticky CE pod that accepts audio but returns zero transcripts. When detected (finalize via `no_data_timeout` with audio signal but no transcript), the hook replays the buffered audio on a fresh WebSocket connection.
- **Audio level visualization**: Computes RMS amplitude from 16-bit PCM buffers via `computeLevel()`, normalized with a sqrt curve for visual range.

### `useVoiceIntegration`

**File:** `src/hooks/useVoiceIntegration.tsx`

Bridges `useVoice` into the REPL input field. Handles:

- **Dead code elimination**: Conditionally loads `useVoice` via `require()` gated on `feature('VOICE_MODE')`, replaced with a no-op stub when the feature is disabled.
- **Keybinding detection**: Matches keyboard events against the configured voice keybinding. Bare-char bindings (e.g., space) require `HOLD_THRESHOLD = 5` rapid presses to activate; modifier combos (e.g., Ctrl+Space) activate on first press.
- **Cursor-aware transcript insertion**: Tracks `voicePrefixRef`/`voiceSuffixRef` around the cursor position when voice starts. Interim transcripts are spliced at the cursor without clobbering surrounding text.
- **Trailing char cleanup**: `stripTrailing()` removes leaked hold-key characters (e.g., spaces from holding spacebar) from the input, with full-width space (U+3000) normalization for CJK IMEs.

---

## SSH Session

### `useSSHSession`

**File:** `src/hooks/useSSHSession.ts`

REPL integration for `claude ssh` sessions. Shares the same interface shape as `useDirectConnect` (`isRemoteMode`, `sendMessage`, `cancelRequest`, `disconnect`) but drives an SSH child process instead of a WebSocket.

**Lifecycle difference from `useDirectConnect`**: The SSH process and auth proxy are created *before* this hook runs (during startup in `main.tsx`) and passed in via props. The hook wires an `SSHSessionManager` with callbacks:

- **`onMessage`**: Converts SDK messages via `convertSDKMessage` (with `convertToolResults: true`) and appends to the message list. Deduplicates `system/init` messages.
- **`onPermissionRequest`**: Creates a `ToolUseConfirm` entry with allow/deny/abort handlers that delegate to `manager.respondToPermissionRequest()`. Unknown tools get a stub via `createToolStub()`.
- **`onReconnecting`**: Injects a warning system message and tracks connection state.
- **`onDisconnected`**: Surfaces remote stderr on failure and triggers `gracefulShutdown(1)`.

> Source: `src/hooks/useSSHSession.ts:48-241`

---

## Remote Session (CCR)

### `useRemoteSession`

**File:** `src/hooks/useRemoteSession.ts`

Manages a remote Cloud Code Runner (CCR) session with WebSocket transport. The most feature-rich of the remote hooks.

**Key processes:**

1. **Connection**: Creates a `RemoteSessionManager` and calls `manager.connect()`. Tracks connection status in `AppState.remoteConnectionStatus`.
2. **Message routing**: Handles SDK messages including:
   - Echo filtering via `BoundedUUIDSet(50)` — user messages POST'd locally echo back on the WebSocket and must be deduplicated
   - Subagent lifecycle tracking (`task_started`/`task_notification`) for the "N in background" counter
   - Compaction state tracking with extended timeouts (`COMPACTION_TIMEOUT_MS = 180s` vs normal `RESPONSE_TIMEOUT_MS = 60s`)
   - Streaming tool use updates for real-time UI
   - `tool_use` ID lifecycle management (add on assistant message, remove on `tool_result`)
3. **Session title**: Auto-generates a title on first message via `generateSessionTitle()` when no initial prompt was provided.
4. **Stuck session detection**: Arms a timeout after each `sendMessage`; on expiry, injects a warning and attempts WebSocket reconnect.
5. **Viewer-only mode**: Disables interrupt on Ctrl+C, skips stuck-session timeout, and enables `convertUserTextMessages` for rendering remote tool results.

```typescript
// src/hooks/useRemoteSession.ts:37-41
const RESPONSE_TIMEOUT_MS = 60000  // 60 seconds
const COMPACTION_TIMEOUT_MS = 180000  // 3 minutes
```

---

## Direct Connect

### `useDirectConnect`

**File:** `src/hooks/useDirectConnect.ts`

WebSocket-based session management for direct server connections. Structurally similar to `useSSHSession` but creates the WebSocket *inside* the effect via `DirectConnectSessionManager`.

**Differences from `useRemoteSession`:**
- No echo filtering, subagent tracking, compaction handling, or streaming support
- On disconnect, triggers `gracefulShutdown(1)` (the session cannot recover)
- Distinguishes never-connected (auth failure) from post-connection drops in stderr output

The permission request flow is identical to the other remote hooks: look up the tool by name → create `ToolUseConfirm` → enqueue → respond via `manager.respondToPermissionRequest()`.

---

## REPL Bridge (claude.ai)

### `useReplBridge`

**File:** `src/hooks/useReplBridge.tsx`

The largest and most complex hook — initializes an always-on bridge to claude.ai so remote clients (web, iOS, Android) can interact with a local CLI session.

**Key features:**

- **Feature-gated**: Entire hook is wrapped in `feature('BRIDGE_MODE')` for dead code elimination in external builds.
- **Initialization**: Dynamically imports `initReplBridge`, waits for any in-progress teardown, then creates the bridge with callbacks for inbound messages, permission responses, interrupts, model changes, and permission requests.
- **Failure resilience**: Tracks consecutive failures (`MAX_CONSECUTIVE_INIT_FAILURES = 3`). After 3 failures, the bridge is permanently disabled for the session. Individual failures auto-clear after `BRIDGE_FAILURE_DISMISS_MS = 10s`.
- **Inbound messages**: Messages from claude.ai are sanitized (webhook content), file attachments are resolved to disk, then enqueued as prompts with `bridgeOrigin: true` and `skipSlashCommands: true` (defense-in-depth).
- **State machine**: Bridge states (`ready` → `connected` → `reconnecting` → `failed`) are mapped to `AppState` fields (`replBridgeConnected`, `replBridgeSessionActive`, `replBridgeReconnecting`, `replBridgeError`).
- **System init**: On `connected`, sends a `system/init` SDK message with session metadata (model, permission mode, bridge-safe commands, skills, agents) so remote clients render the correct UI.
- **Permission callbacks**: Inbound permission requests from claude.ai are routed through a `pendingPermissionHandlers` map keyed by `request_id`, with responses dispatched via `handlePermissionResponse`.
- **Outbound forwarding**: Watches the `messages` array and writes new entries to the bridge handle. Tracks `flushedUUIDsRef` to avoid sending duplicate UUIDs (which would cause the server to kill the WebSocket).

---

## Mailbox & Inbox (Teammate Messaging)

### `useMailboxBridge`

**File:** `src/hooks/useMailboxBridge.ts`

A minimal bridge that polls the in-memory mailbox (React context) for incoming messages and submits them as REPL prompts when the session is idle.

- Uses `useSyncExternalStore` to reactively track mailbox revision changes
- On each revision (when not loading), polls the mailbox and calls `onSubmitMessage` with the content
- Only 21 lines — the simplest hook in this module

### `useInboxPoller`

**File:** `src/hooks/useInboxPoller.ts`

The heavyweight teammate messaging hook. Polls the filesystem-based teammate inbox every 1 second (`INBOX_POLL_INTERVAL_MS = 1000`) for unread messages, then routes them by type:

**Message classification and routing:**

| Message Type | Direction | Handler |
|---|---|---|
| Permission request | → Leader | Routes to `ToolUseConfirmQueue` with tool-specific UI |
| Permission response | → Teammate | Invokes registered callbacks via `processMailboxPermissionResponse` |
| Sandbox permission request | → Leader | Adds to `workerSandboxPermissions` queue |
| Sandbox permission response | → Teammate | Processes via `processSandboxPermissionResponse` |
| Shutdown request | → Teammate | Passed through for UI rendering |
| Shutdown approval | → Leader | Kills pane, removes teammate from team context, unassigns tasks |
| Team permission update | → Teammate | Applies permission rules via `applyPermissionUpdate` |
| Mode set request | → Teammate | Changes permission mode (only from `team-lead`) |
| Plan approval request | → Leader | Auto-approves, writes response to teammate inbox |
| Plan approval response | → Teammate | Transitions out of plan mode if approved |
| Regular messages | Both | Formatted with XML tags and submitted as turns |

**Delivery strategy:**
- **Idle**: Messages are submitted immediately as new turns
- **Busy**: Messages are queued in `AppState.inbox` and delivered when the session becomes idle
- Messages are marked as read only *after* successful delivery or reliable queueing, preventing silent data loss on crash

**Security considerations:**
- Plan approval responses are only accepted from `team-lead` to prevent forged approvals
- Mode set requests are only accepted from `team-lead`
- Permission request deduplication prevents re-processing if `markMessagesAsRead` failed on a prior poll

**Agent name resolution** (`getAgentNameToPoll`):
- In-process teammates return `undefined` (they use a separate polling mechanism)
- Process-based teammates use `CLAUDE_CODE_AGENT_NAME`
- Team leads look up their name from `teamContext.teammates`
- Standalone sessions return `undefined` (polling disabled)

---

## Common Patterns

All remote session hooks (`useSSHSession`, `useRemoteSession`, `useDirectConnect`) share a common interface:

```typescript
type Result = {
  isRemoteMode: boolean
  sendMessage: (content: RemoteMessageContent) => Promise<boolean>
  cancelRequest: () => void
  disconnect: () => void
}
```

They all:
1. Keep a `toolsRef` to avoid stale closures in WebSocket/SSH callbacks
2. Build `ToolUseConfirm` entries for permission requests with allow/deny/abort handlers
3. Use `createToolStub()` for unknown tool names
4. Return a `useMemo`-wrapped result to prevent unnecessary re-renders in consuming components

## Edge Cases & Caveats

- **Chrome extension notifications are broadcast**: `usePromptsFromClaudeInChrome` filters by `isTrackedClaudeInChromeTabId` to only process notifications from tracked tabs.
- **Voice language fallback**: If the user's configured language is not in the server allowlist, STT falls back to English silently. Sending an unsupported code would close the WebSocket with error 1008.
- **Bridge UUID deduplication**: The server may broadcast the same user message UUID multiple times (server broadcast + worker echo). `BoundedUUIDSet` uses a ring buffer to handle this without unbounded growth.
- **Remote session compaction**: During context compaction, the normal 60s response timeout is extended to 180s to avoid spurious "unresponsive" warnings.
- **Inbox poller in shared React context**: In-process teammates share the same `AppState` with the leader. `getAgentNameToPoll` returns `undefined` for in-process teammates to prevent message routing conflicts.
- **Bridge failure fuse**: After 3 consecutive `initReplBridge` failures (e.g., unrecoverable 401s), the bridge is permanently disabled for the session to prevent a single stuck client from generating thousands of failed requests per day.