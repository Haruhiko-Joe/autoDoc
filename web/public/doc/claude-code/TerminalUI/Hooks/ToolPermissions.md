# Tool Permissions

## Overview & Responsibilities

The Tool Permissions module is the decision-making system that determines whether Claude is allowed to execute a tool. It sits within the **Hooks** layer of the **TerminalUI** subsystem, acting as a gatekeeper between the query engine's tool dispatch and actual tool execution.

When Claude wants to run a tool (e.g., write a file, execute a shell command), every request flows through the `useCanUseTool` hook, which orchestrates a multi-stage decision pipeline: check configured permissions, try automated classifiers, run permission hooks, and—if nothing resolves automatically—show the user an interactive permission dialog.

The module is organized into:
- **PermissionContext** (`src/hooks/toolPermission/PermissionContext.ts`) — Core state object and shared utilities for all permission flows
- **Three handler strategies** (`src/hooks/toolPermission/handlers/`) — Dispatch permission requests based on execution mode (interactive, coordinator, swarm worker)
- **Permission logging** (`src/hooks/toolPermission/permissionLogging.ts`) — Centralized analytics and telemetry
- **useCanUseTool** (`src/hooks/useCanUseTool.tsx`) — The React hook that orchestrates the full decision flow

## Key Processes

### Full Permission Decision Flow (`useCanUseTool`)

The `useCanUseTool` hook is the single entry point. It returns a `CanUseToolFn` callback memoized over the queue and context setters. The flow:

1. **Create PermissionContext** — wraps tool, input, abort controller, queue operations, and logging helpers into a frozen context object (`src/hooks/useCanUseTool.tsx:33`)
2. **Abort check** — if the request is already aborted, resolve immediately
3. **Check configured permissions** — calls `hasPermissionsToUseTool()` to evaluate the settings-based allowlist/denylist. A `forceDecision` parameter can bypass this check entirely.
4. **Branch on result behavior**:
   - `"allow"` → log as config-approved, resolve immediately
   - `"deny"` → log as config-denied, record auto-mode denials if applicable, resolve
   - `"ask"` → enter the handler strategy chain (see below)

### The "ask" Handler Chain

When config-level permissions return `"ask"`, three handler strategies are tried in order:

1. **Coordinator handler** (`handleCoordinatorPermission`) — only runs when `awaitAutomatedChecksBeforeDialog` is set (coordinator worker mode). Sequentially tries hooks then classifier. Returns a decision or `null` to fall through.

2. **Swarm worker handler** (`handleSwarmWorkerPermission`) — only runs when the process is a swarm worker. Tries classifier, then forwards the request to the swarm leader via mailbox and waits for the leader's response.

3. **Speculative classifier race** — for Bash commands, if a speculative classifier check is already in-flight, race it against a 2-second timeout. If it resolves with high confidence before the timeout, auto-approve without showing a dialog.

4. **Interactive handler** (`handleInteractivePermission`) — the final fallback. Pushes a permission dialog entry to the React confirm queue and races multiple resolution sources against each other.

### Interactive Permission Race (`handleInteractivePermission`)

This is the most complex handler. It sets up a multi-way race using a `ResolveOnce` guard to ensure exactly one resolution wins (`src/hooks/toolPermission/handlers/interactiveHandler.ts:57-531`):

| Racer | Description |
|-------|-------------|
| **User (local)** | `onAllow`/`onReject`/`onAbort` callbacks from the terminal permission dialog |
| **Permission hooks** | Async hooks that may auto-approve or deny before the user responds |
| **Bash classifier** | Background classifier check that can auto-approve bash commands |
| **Bridge (CCR)** | Permission response from claude.ai via WebSocket when bridge-connected |
| **Channel relay** | Responses from mobile channels (Telegram, iMessage) via MCP notifications |
| **Recheck** | `recheckPermission` callback triggered when permission mode changes mid-dialog |

The `claim()` method on `ResolveOnce` provides atomic check-and-mark semantics so concurrent async callbacks cannot double-resolve the promise (`src/hooks/toolPermission/PermissionContext.ts:75-93`).

When the **classifier** wins, a checkmark indicator is briefly shown in the dialog (3s if terminal focused, 1s otherwise) before the dialog is removed. The user can dismiss it early with Esc.

## Function Signatures

### `useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext): CanUseToolFn`

React hook that returns the memoized permission decision function.

- **setToolUseConfirmQueue**: React state setter for the permission dialog queue
- **setToolPermissionContext**: Setter for the tool permission context on the app state
- **Returns**: `CanUseToolFn` — async function `(tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision?) => Promise<PermissionDecision>`

> Source: `src/hooks/useCanUseTool.tsx:28`

### `createPermissionContext(tool, input, toolUseContext, assistantMessage, toolUseID, setToolPermissionContext, queueOps?): PermissionContext`

Factory function that builds a frozen context object carrying all state and utilities needed by the permission handlers.

Key methods on the returned context:
- `logDecision(args, opts?)` — delegates to centralized telemetry logging
- `logCancelled()` — logs a tool-use cancellation event
- `persistPermissions(updates)` — persists permission rule updates and applies them to app state
- `resolveIfAborted(resolve)` — checks abort signal and resolves with cancel if aborted
- `cancelAndAbort(feedback?, isAbort?, contentBlocks?)` — builds a deny decision and aborts the controller
- `tryClassifier(pendingCheck, updatedInput)` — awaits a bash classifier auto-approval (feature-gated)
- `runHooks(permissionMode, suggestions, updatedInput?, startTimeMs?)` — executes `PermissionRequest` hooks
- `buildAllow(input, opts?)` / `buildDeny(message, reason)` — construct decision objects
- `handleUserAllow(input, updates, feedback?, startTimeMs?, blocks?, reason?)` — persist permissions and build allow decision
- `pushToQueue(item)` / `removeFromQueue()` / `updateQueueItem(patch)` — manage the confirm dialog queue

> Source: `src/hooks/toolPermission/PermissionContext.ts:96-348`

### `handleInteractivePermission(params, resolve): void`

Sets up the interactive permission race. Does NOT return a Promise—callbacks eventually call `resolve()`.

> Source: `src/hooks/toolPermission/handlers/interactiveHandler.ts:57`

### `handleCoordinatorPermission(params): Promise<PermissionDecision | null>`

Sequentially tries hooks then classifier for coordinator workers. Returns `null` to fall through to the dialog.

> Source: `src/hooks/toolPermission/handlers/coordinatorHandler.ts:26`

### `handleSwarmWorkerPermission(params): Promise<PermissionDecision | null>`

Forwards permission to the swarm leader via mailbox. Returns `null` if not a swarm worker.

> Source: `src/hooks/toolPermission/handlers/swarmWorkerHandler.ts:40`

### `logPermissionDecision(ctx, args, permissionPromptStartTimeMs?): void`

Centralized telemetry entry point. Fans out to analytics events, OTel telemetry, code-edit counters, and `toolUseContext.toolDecisions` storage.

> Source: `src/hooks/toolPermission/permissionLogging.ts:181`

## Type Definitions

### `PermissionApprovalSource`

Discriminated union identifying what approved a tool use:

| Variant | Fields | Description |
|---------|--------|-------------|
| `hook` | `permanent?: boolean` | Approved by a PermissionRequest hook |
| `user` | `permanent: boolean` | User approved in dialog (permanent = saved rule) |
| `classifier` | — | Auto-approved by the bash classifier |

### `PermissionRejectionSource`

Discriminated union identifying what rejected a tool use:

| Variant | Fields | Description |
|---------|--------|-------------|
| `hook` | — | Denied by a PermissionRequest hook |
| `user_abort` | — | User aborted (Ctrl+C or equivalent) |
| `user_reject` | `hasFeedback: boolean` | User explicitly rejected, optionally with feedback |

### `PermissionQueueOps`

Generic interface for permission dialog queue operations, decoupled from React:
- `push(item)` — add a permission dialog entry
- `remove(toolUseID)` — remove an entry by ID
- `update(toolUseID, patch)` — patch an existing entry

### `ResolveOnce<T>`

Race-safe promise resolution guard:
- `resolve(value)` — resolve the promise (idempotent after first call)
- `isResolved()` — check if already resolved
- `claim()` — atomically check-and-mark as resolved; returns `true` if this caller won the race

### `PermissionDecisionArgs`

Discriminated union for logging: `{ decision: 'accept', source: PermissionApprovalSource | 'config' }` or `{ decision: 'reject', source: PermissionRejectionSource | 'config' }`.

## Configuration & Defaults

- **`awaitAutomatedChecksBeforeDialog`** — When `true` (coordinator mode), hooks and classifier run sequentially *before* showing a dialog. When `false`/undefined (interactive mode), they race concurrently alongside the dialog.
- **Feature flags**: `BASH_CLASSIFIER`, `TRANSCRIPT_CLASSIFIER`, `BRIDGE_MODE`, `KAIROS`, `KAIROS_CHANNELS` gate the classifier, bridge relay, and channel relay code paths.
- **Classifier grace period**: 200ms after the permission prompt appears, user interactions are ignored to prevent accidental keypresses from canceling classifier auto-approval (`src/hooks/toolPermission/handlers/interactiveHandler.ts:115-116`).
- **Speculative classifier timeout**: 2 seconds. If the speculative check doesn't return in time, the interactive dialog is shown (`src/hooks/useCanUseTool.tsx:131`).
- **Checkmark display time**: 3 seconds (terminal focused) or 1 second (terminal not focused) after classifier auto-approval before the dialog is removed.

## Edge Cases & Caveats

- **ResolveOnce is critical for correctness**: Multiple async paths (user click, hook, classifier, bridge, channel) can all complete concurrently. The `claim()` mechanism ensures exactly one wins. Without it, a tool could execute twice or produce contradictory decisions.
- **Abort handling is pervasive**: Every async step checks `resolveIfAborted()` because the user can Ctrl+C at any time. The abort signal listener is also registered on the swarm worker's promise to prevent hanging.
- **Bridge and channel responses after local resolution are safe**: If the user responds locally after a bridge request was sent, the bridge response's `claim()` returns `false` and is ignored. Stale channel replies fall through `tryConsumeReply` harmlessly.
- **Coordinator vs. interactive ordering**: Coordinator workers run hooks → classifier → dialog sequentially (fail-safe: if automated checks error, fall through to dialog). Interactive mode runs them in parallel (race).
- **Code editing tool metrics**: Permission decisions for `Edit`, `Write`, and `NotebookEdit` get additional OTel counter attributes including the target file's language (`src/hooks/toolPermission/permissionLogging.ts:33-65`).
- **Error handling**: Permission check errors (`AbortError`, `APIUserAbortError`) are caught at the top level and resolved as cancellations rather than propagated, ensuring the tool pipeline doesn't hang (`src/hooks/useCanUseTool.tsx:176-183`).