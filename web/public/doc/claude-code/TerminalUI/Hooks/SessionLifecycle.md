# Session Lifecycle

## Overview & Responsibilities

The Session Lifecycle module is a collection of React hooks within the **TerminalUI → Hooks** layer that govern how a Claude Code session starts, pauses, resumes, and ends. These hooks handle the control-flow mechanics that sit between raw user input (keypresses, queued commands) and the query engine, ensuring the session responds correctly to cancellations, exits, backgrounding, multi-agent coordination, and asynchronous startup.

Within the broader TerminalUI architecture, these hooks are consumed primarily by the **REPL screen** and its sub-components. They depend on **AppState** for global state, the **Keybindings** system for shortcut registration, and **Infrastructure** utilities (queue manager, swarm helpers, teleport APIs).

### Hook inventory

| Hook / Component | File | Purpose |
|---|---|---|
| `CancelRequestHandler` | `src/hooks/useCancelRequest.ts` | Cancel/interrupt running tasks via Escape or Ctrl+C |
| `useExitOnCtrlCD` | `src/hooks/useExitOnCtrlCD.ts` | Double-press Ctrl+C/D to exit the application |
| `useExitOnCtrlCDWithKeybindings` | `src/hooks/useExitOnCtrlCDWithKeybindings.ts` | Convenience wrapper wiring exit hook to the keybindings system |
| `useSessionBackgrounding` | `src/hooks/useSessionBackgrounding.ts` | Ctrl+B to background/foreground tasks |
| `useTeammateViewAutoExit` | `src/hooks/useTeammateViewAutoExit.ts` | Auto-exit teammate viewing when the viewed agent dies |
| `useSwarmInitialization` | `src/hooks/useSwarmInitialization.ts` | Initialize swarm/team context on session start or resume |
| `useSwarmPermissionPoller` | `src/hooks/useSwarmPermissionPoller.ts` | Poll for permission responses in worker agents |
| `useCommandQueue` | `src/hooks/useCommandQueue.ts` | Subscribe to the unified command queue |
| `useQueueProcessor` | `src/hooks/useQueueProcessor.ts` | Process queued commands when the query engine is idle |
| `useTeleportResume` | `src/hooks/useTeleportResume.tsx` | Resume a teleported (remote) session |
| `useDeferredHookMessages` | `src/hooks/useDeferredHookMessages.ts` | Inject async SessionStart hook messages without blocking render |

---

## Key Processes

### Cancel & Interrupt Flow

`CancelRequestHandler` (`src/hooks/useCancelRequest.ts:63-276`) is a renderless component that registers three keybinding handlers:

1. **`chat:cancel` (Escape)** — Cancels the active task or pops from the command queue. Priority order:
   - If an abort signal is active (task running): abort the task immediately and clear the tool-use confirm queue (`src/hooks/useCancelRequest.ts:97-102`)
   - If commands are queued but no task is running: pop the next command from the queue (`src/hooks/useCancelRequest.ts:105-110`)
   - Fallback: fire the cancel callback anyway

2. **`app:interrupt` (Ctrl+C)** — When viewing a teammate's transcript, kills all running agents and exits teammate view. Otherwise delegates to the same cancel logic. Importantly, Ctrl+C is **not** claimed when the main thread is idle at the prompt — this preserves copy-selection and the double-press-to-exit pathway (`src/hooks/useCancelRequest.ts:159-162`).

3. **`chat:killAgents` (Ctrl+X Ctrl+K)** — Uses a two-press confirmation pattern with a 3-second window. First press shows a status-bar notification; second press within the window kills all running background agents, emits SDK termination events, and enqueues an aggregate notification for the model (`src/hooks/useCancelRequest.ts:225-266`).

The component has extensive activation guards (`src/hooks/useCancelRequest.ts:128-154`) to avoid conflicts with overlays, vim insert mode, history search, help screens, and teammate view navigation.

### Double-Press Exit Flow

`useExitOnCtrlCD` (`src/hooks/useExitOnCtrlCD.ts:45-95`) implements application exit via a time-based double-press mechanism:

1. First press sets `exitState.pending = true` with the key name (`Ctrl-C` or `Ctrl-D`)
2. Second press within the timeout window calls `exit()` (from Ink's `useApp`)
3. An optional `onInterrupt` callback lets features intercept Ctrl+C before the exit logic — if it returns `true`, the double-press is skipped

The hook uses dependency injection for the keybindings hook (`useKeybindingsHook` parameter) to avoid import cycles. `useExitOnCtrlCDWithKeybindings` (`src/hooks/useExitOnCtrlCDWithKeybindings.ts:18-24`) is the standard convenience wrapper that supplies `useKeybindings` from the keybindings module.

These keys are **hardcoded** and cannot be rebound via `keybindings.json`.

### Session Backgrounding Flow

`useSessionBackgrounding` (`src/hooks/useSessionBackgrounding.ts:27-158`) manages Ctrl+B toggling:

**Backgrounding a foreground task:**
- If a task is currently foregrounded (`foregroundedTaskId` exists), pressing Ctrl+B marks it as backgrounded, clears the message display, and resets loading state (`src/hooks/useSessionBackgrounding.ts:42-64`)
- If no task is foregrounded, delegates to `onBackgroundQuery()` to spawn a new background task from the current query

**Syncing a foregrounded task:**
- A `useEffect` continuously syncs a foregrounded task's messages and loading state to the main view (`src/hooks/useSessionBackgrounding.ts:77-153`)
- Only updates when message count changes (avoids redundant renders via `lastSyncedMessagesLengthRef`)
- If the task's abort controller is aborted (user pressed Escape), immediately re-backgrounds it
- When the task completes, auto-restores to background

### Command Queue Subscription & Processing

**`useCommandQueue`** (`src/hooks/useCommandQueue.ts:13-15`) is a thin wrapper around `useSyncExternalStore` that subscribes to the module-level unified command queue. Components re-render only when the queue changes.

**`useQueueProcessor`** (`src/hooks/useQueueProcessor.ts:28-68`) drives command execution by watching three conditions:
1. No query is active (`queryGuard` — reactive via `useSyncExternalStore`)
2. The queue has items
3. No active local JSX UI is blocking input

When all conditions are met, it calls `processQueueIfReady()` which dequeues by priority: `'now'` > `'next'` (user input) > `'later'` (task notifications). The reservation mechanism ensures that by the time React re-runs the effect after a dequeue, `isQueryActive` is already `true`, preventing double-processing (`src/hooks/useQueueProcessor.ts:53-60`).

### Swarm Initialization

`useSwarmInitialization` (`src/hooks/useSwarmInitialization.ts:30-81`) runs once on mount when `ENABLE_AGENT_SWARMS` is active. It handles two scenarios:

1. **Resumed teammate sessions** (from `--resume` or `/resume`): Extracts `teamName` and `agentName` from the first transcript message, restores team context via `initializeTeammateContextFromSession`, looks up the `agentId` from the team file, and initializes teammate hooks (`src/hooks/useSwarmInitialization.ts:40-65`)

2. **Fresh spawns**: Reads context from `getDynamicTeamContext()` (set via environment variables in `main.tsx`) and initializes teammate hooks if team info is present (`src/hooks/useSwarmInitialization.ts:66-78`)

The hook is conditionally loaded to allow dead code elimination when swarms are disabled.

### Swarm Permission Polling

`useSwarmPermissionPoller` (`src/hooks/useSwarmPermissionPoller.ts:268-330`) activates only for swarm worker agents. It polls every 500ms for permission responses from the team leader:

1. Checks each pending request ID against the filesystem-based inbox via `pollForResponse()`
2. On response, invokes the registered callback (`onAllow` or `onReject`) and cleans up the response file
3. Guards against concurrent polling with `isProcessingRef`

The module maintains two **module-level registries** (not React state):
- `pendingCallbacks` — for tool permission requests (`src/hooks/useSwarmPermissionPoller.ts:76`)
- `pendingSandboxCallbacks` — for sandbox permission requests (`src/hooks/useSwarmPermissionPoller.ts:172`)

External code registers callbacks via `registerPermissionCallback()` and `registerSandboxPermissionCallback()`. Mailbox-based responses (IPC) are handled by `processMailboxPermissionResponse()` and `processSandboxPermissionResponse()`, which bypass the filesystem polling path and invoke callbacks directly. All entries are validated against `permissionUpdateSchema` before propagation (`src/hooks/useSwarmPermissionPoller.ts:35-53`).

### Teammate View Auto-Exit

`useTeammateViewAutoExit` (`src/hooks/useTeammateViewAutoExit.ts:11-63`) monitors the viewed teammate's status and automatically exits viewing mode when:
- The task no longer exists in the task map (evicted)
- The teammate status is `killed`, `failed`, or has an error
- The status is not one of `running`, `completed`, or `pending`

Users can continue viewing `completed` teammates to review transcripts. The hook selects only the viewed task (not the full tasks map) to avoid re-rendering on every streaming update from other teammates.

### Teleport Session Resumption

`useTeleportResume` (`src/hooks/useTeleportResume.tsx`) provides `resumeSession(session)` to resume a teleported (remote) code session:

1. Sets loading state, logs an analytics event
2. Calls `teleportResumeCodeSession(session.id)`
3. On success, stores teleported session info for reliability logging
4. On failure, captures the error with structured `TeleportResumeError` (distinguishing `TeleportOperationError` from generic errors)

Returns `{ resumeSession, isResuming, error, selectedSession, clearError }`.

### Deferred Hook Message Injection

`useDeferredHookMessages` (`src/hooks/useDeferredHookMessages.ts:12-46`) solves a startup latency problem: SessionStart hook execution takes ~500ms, and blocking on it would delay the first render.

The hook takes a `Promise<HookResultMessage[]>` and:
1. **Asynchronously injects** resolved messages into the message list via `setMessages(prev => [...msgs, ...prev])` — prepending them so the model sees hook context first
2. **Returns a flush callback** that `onSubmit` calls before the first API request, ensuring the model always has hook context even if the promise hasn't resolved yet by the time the user submits (`src/hooks/useDeferredHookMessages.ts:36-45`)
3. Uses `resolvedRef` to ensure messages are injected exactly once

---

## Function Signatures

### `CancelRequestHandler(props: CancelRequestHandlerProps): null`

Renderless component registering cancel/interrupt/kill-agents keybinding handlers.

| Prop | Type | Description |
|---|---|---|
| `onCancel` | `() => void` | Called to cancel the active task |
| `onAgentsKilled` | `() => void` | Called after all agents are stopped |
| `setToolUseConfirmQueue` | `(f) => void` | Clears the pending tool confirmation queue |
| `abortSignal` | `AbortSignal?` | Signal for the currently running task |
| `popCommandFromQueue` | `() => void?` | Pops the next command when idle |
| `screen` | `Screen` | Current screen name (guards activation) |
| `streamMode` | `SpinnerMode?` | Current stream mode (for analytics) |

> Source: `src/hooks/useCancelRequest.ts:40-57`

### `useExitOnCtrlCD(useKeybindingsHook, onInterrupt?, onExit?, isActive?): ExitState`

Registers double-press Ctrl+C/D exit handlers. Returns `{ pending: boolean, keyName: 'Ctrl-C' | 'Ctrl-D' | null }`.

> Source: `src/hooks/useExitOnCtrlCD.ts:45-95`

### `useSessionBackgrounding(props): { handleBackgroundSession: () => void }`

Manages Ctrl+B background/foreground toggling and task message syncing.

> Source: `src/hooks/useSessionBackgrounding.ts:27-158`

### `useSwarmPermissionPoller(): void`

Activates filesystem-based permission polling for swarm workers. No parameters — reads swarm context from module-level state.

> Source: `src/hooks/useSwarmPermissionPoller.ts:268-330`

### `registerPermissionCallback(callback: PermissionResponseCallback): void`

Registers a callback for a pending permission request in the module-level registry.

> Source: `src/hooks/useSwarmPermissionPoller.ts:82-89`

### `processMailboxPermissionResponse(params): boolean`

Processes a permission response received via IPC mailbox. Returns `true` if a callback was found and invoked.

> Source: `src/hooks/useSwarmPermissionPoller.ts:124-156`

### `useDeferredHookMessages(pendingHookMessages, setMessages): () => Promise<void>`

Returns a flush callback that ensures hook messages are injected before the first API request.

> Source: `src/hooks/useDeferredHookMessages.ts:12-46`

---

## Type Definitions

### `ExitState`

```typescript
type ExitState = {
  pending: boolean
  keyName: 'Ctrl-C' | 'Ctrl-D' | null
}
```

Tracks whether a double-press exit is pending and which key initiated it.

> Source: `src/hooks/useExitOnCtrlCD.ts:6-9`

### `PermissionResponseCallback`

```typescript
type PermissionResponseCallback = {
  requestId: string
  toolUseId: string
  onAllow: (updatedInput, permissionUpdates, feedback?) => void
  onReject: (feedback?) => void
}
```

Callback registered by `useCanUseTool` when a worker submits a permission request to the leader.

> Source: `src/hooks/useSwarmPermissionPoller.ts:58-67`

### `SandboxPermissionResponseCallback`

```typescript
type SandboxPermissionResponseCallback = {
  requestId: string
  host: string
  resolve: (allow: boolean) => void
}
```

Promise-based callback for sandbox permission requests.

> Source: `src/hooks/useSwarmPermissionPoller.ts:165-169`

### `TeleportResumeError`

```typescript
type TeleportResumeError = {
  message: string
  formattedMessage?: string
  isOperationError: boolean
}
```

Structured error from a teleport resume attempt, distinguishing `TeleportOperationError` from generic failures.

> Source: `src/hooks/useTeleportResume.tsx`

---

## Configuration & Defaults

| Constant | Value | Location | Description |
|---|---|---|---|
| `KILL_AGENTS_CONFIRM_WINDOW_MS` | `3000` | `src/hooks/useCancelRequest.ts:38` | Time window for the two-press kill-agents confirmation |
| `POLL_INTERVAL_MS` | `500` | `src/hooks/useSwarmPermissionPoller.ts:28` | Swarm worker permission polling interval |

---

## Edge Cases & Caveats

- **Ctrl+C not claimed when idle**: `CancelRequestHandler` deliberately does **not** register `app:interrupt` when the main thread is idle at the prompt. This ensures Ctrl+C flows through to the copy-selection handler and the double-press-to-exit mechanism (`src/hooks/useCancelRequest.ts:158-162`).

- **`chat:killAgents` is always active**: The Ctrl+X Ctrl+K handler stays registered even when the component would otherwise be inactive, because Ctrl+X is consumed as a chord prefix. An inactive handler would leak the subsequent Ctrl+K to readline's kill-line. The handler gates internally instead (`src/hooks/useCancelRequest.ts:269-273`).

- **Vim insert mode blocks Escape**: When vim mode is enabled and the user is in INSERT mode, Escape is not intercepted for cancel — it's left to the vim input handler for mode transition (`src/hooks/useCancelRequest.ts:146`).

- **Exit keys are not rebindable**: The double-press Ctrl+C/D exit uses time-based detection rather than the chord system because the first Ctrl+C must also trigger interrupt. The chord system would prevent the first press from firing (`src/hooks/useExitOnCtrlCD.ts:26-29`).

- **Foregrounded task abort detection**: `useSessionBackgrounding` checks the foregrounded task's `abortController.signal.aborted` to detect when the user pressed Escape while viewing. This is a synchronous check that immediately re-backgrounds the task rather than waiting for the abort to propagate (`src/hooks/useSessionBackgrounding.ts:101-121`).

- **Teammate view vs local agent view**: `useTeammateViewAutoExit` narrows to in-process teammate tasks only. Local agent tasks exist in the same task map but are not auto-ejected — the status checks are teammate-specific (`src/hooks/useTeammateViewAutoExit.ts:39`).

- **Permission update validation**: The swarm permission poller validates all incoming `permissionUpdates` through a Zod schema before passing to callbacks, filtering out malformed entries from buggy or old teammate processes (`src/hooks/useSwarmPermissionPoller.ts:35-53`).

- **Deferred hook messages are prepended**: Hook messages are inserted at the **beginning** of the message array, not appended, ensuring the model sees hook context before user messages (`src/hooks/useDeferredHookMessages.ts:28`).

- **`useTeleportResume` uses React Compiler**: The built file uses `react/compiler-runtime` (`_c` cache slots) rather than manual `useMemo`/`useCallback`. The original source uses standard `useCallback`.