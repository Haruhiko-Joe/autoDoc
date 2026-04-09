# ElicitationHandler

## Overview & Responsibilities

The ElicitationHandler is the interactive authentication prompt subsystem within the MCP (Model Context Protocol) client. It sits under **Services → MCPClient → Authentication** and is responsible for handling server-initiated elicitation requests — interactive prompts that MCP servers send when they need user input during connection, typically for authentication flows.

The module registers JSON-RPC handlers on an MCP `Client` instance to intercept two message types:
1. **Elicitation requests** (`ElicitRequestSchema`) — the server asks the user to fill out a form or visit a URL
2. **Elicitation completion notifications** (`ElicitationCompleteNotificationSchema`) — the server confirms a URL-mode auth flow finished

It manages elicitation state through a queue in the React app state, enabling the terminal UI to render auth dialogs. It also integrates with a hook system for programmatic resolution and with analytics for event tracking.

## Key Processes

### Elicitation Request Flow

When an MCP server sends an elicitation request, the following sequence executes:

1. The JSON-RPC request handler receives the request and determines the mode — either `'form'` (inline form fields) or `'url'` (open a browser URL) (`src/services/mcp/elicitationHandler.ts:49-51`)
2. An analytics event `tengu_mcp_elicitation_shown` is logged with the mode
3. **Pre-elicitation hooks** run via `runElicitationHooks()` — these can short-circuit the flow by returning a programmatic response (e.g., auto-accept or auto-decline). If a hook returns a response, it is sent back immediately without showing any UI (`src/services/mcp/elicitationHandler.ts:91-107`)
4. If no hook resolved the request, a new `ElicitationRequestEvent` is pushed onto the `elicitation.queue` in app state. This triggers the React UI to render the appropriate dialog (`src/services/mcp/elicitationHandler.ts:127-150`)
5. An `AbortSignal` listener is attached — if the signal fires (e.g., timeout or user cancellation), the elicitation resolves with `{ action: 'cancel' }` (`src/services/mcp/elicitationHandler.ts:115-117`)
6. The promise awaits until the UI calls the `respond()` callback with the user's action
7. **Post-response hooks** run via `runElicitationResultHooks()` — these can override or block the user's response before it is sent back to the server (`src/services/mcp/elicitationHandler.ts:159-165`)
8. A notification hook fires for observability, and the final result is returned to the MCP server

### URL-Mode Completion Flow

For URL-mode elicitations (e.g., OAuth browser redirects), a two-phase process occurs:

1. The elicitation is queued with a `waitingState` containing `actionLabel: 'Skip confirmation'` — the UI shows this while the user completes the browser-based flow (`src/services/mcp/elicitationHandler.ts:124-125`)
2. When the server detects the browser flow completed, it sends an `ElicitationCompleteNotification`
3. The notification handler finds the matching queue entry by `serverName` and `elicitationId`, then sets `completed: true` on it (`src/services/mcp/elicitationHandler.ts:175-207`)
4. The React dialog reacts to the `completed` flag to dismiss itself or update its display
5. If no matching elicitation is found, a debug message is logged and the notification is ignored

### Hook System

Two hook stages bracket the user interaction:

- **`runElicitationHooks()`** (`src/services/mcp/elicitationHandler.ts:214-257`): Runs before showing UI. Calls `executeElicitationHooks()` with server name, message, requested schema, mode, URL, and elicitation ID. If a `blockingError` is returned, the elicitation is declined. If an `elicitationResponse` is returned, it is used directly.

- **`runElicitationResultHooks()`** (`src/services/mcp/elicitationHandler.ts:264-313`): Runs after the user responds. Calls `executeElicitationResultHooks()` with the user's action and content. Can override the action/content or block the response (converting it to `'decline'`). Always fires a notification hook for observability, even on error.

Both hook functions are error-tolerant — exceptions are caught and logged, falling through to default behavior.

## Function Signatures

### `registerElicitationHandler(client, serverName, setAppState): void`

The main entry point. Registers both the request handler and the completion notification handler on the MCP client.

| Parameter | Type | Description |
|-----------|------|-------------|
| `client` | `Client` (from `@modelcontextprotocol/sdk`) | The MCP client instance to register handlers on |
| `serverName` | `string` | Human-readable name of the MCP server |
| `setAppState` | `(f: (prev: AppState) => AppState) => void` | React state updater for managing the elicitation queue |

Wrapped in a top-level `try/catch` — if the client was not created with elicitation capability declared, `setRequestHandler` throws and the function silently returns (`src/services/mcp/elicitationHandler.ts:76`).

> Source: `src/services/mcp/elicitationHandler.ts:68-212`

### `runElicitationHooks(serverName, params, signal): Promise<ElicitResult | undefined>`

Runs pre-elicitation hooks that can programmatically resolve the elicitation before showing UI.

- Returns `ElicitResult` if a hook provided a response, or `undefined` to proceed with normal UI flow
- Returns `{ action: 'decline' }` if a hook raises a `blockingError`

> Source: `src/services/mcp/elicitationHandler.ts:214-257`

### `runElicitationResultHooks(serverName, result, signal, mode?, elicitationId?): Promise<ElicitResult>`

Runs post-response hooks after the user has acted. Can modify or block the result.

- Returns the (potentially modified) `ElicitResult`
- On `blockingError`, overrides with `{ action: 'decline' }` and fires a notification
- On exception, returns the original `result` unchanged

> Source: `src/services/mcp/elicitationHandler.ts:264-313`

## Type Definitions

### `ElicitationWaitingState`

Configuration for the waiting-phase UI shown after the user opens a URL in browser-based flows.

| Field | Type | Description |
|-------|------|-------------|
| `actionLabel` | `string` | Button label, e.g. "Retry now" or "Skip confirmation" |
| `showCancel` | `boolean?` | Whether to show a Cancel button (used in error-based retry flows) |

> Source: `src/services/mcp/elicitationHandler.ts:22-27`

### `ElicitationRequestEvent`

Represents a single elicitation in the queue. This is what the React UI consumes to render dialogs.

| Field | Type | Description |
|-------|------|-------------|
| `serverName` | `string` | The MCP server that initiated this elicitation |
| `requestId` | `string \| number` | JSON-RPC request ID, unique per server connection |
| `params` | `ElicitRequestParams` | The full request parameters from the MCP server |
| `signal` | `AbortSignal` | Cancellation signal for the request |
| `respond` | `(response: ElicitResult) => void` | Callback the UI calls to resolve the elicitation |
| `waitingState` | `ElicitationWaitingState?` | Present for URL-mode: UI config for the browser-waiting phase |
| `onWaitingDismiss` | `((action) => void)?` | Callback when the waiting phase is dismissed by user action or completion |
| `completed` | `boolean?` | Set to `true` by the completion notification handler |

> Source: `src/services/mcp/elicitationHandler.ts:29-47`

## Edge Cases & Caveats

- **Elicitation capability not declared**: If the MCP `Client` was created without elicitation capability, `setRequestHandler` throws. The outer `try/catch` silently swallows this, meaning no handlers are registered and elicitations are simply not supported for that connection (`src/services/mcp/elicitationHandler.ts:208-211`).

- **Already-aborted signals**: The handler checks `extra.signal.aborted` immediately before queuing, resolving with `cancel` if the signal is already aborted (`src/services/mcp/elicitationHandler.ts:119-122`).

- **Error-based retry (-32042)**: The `respond` callback comment notes that for error-based retry elicitations, the `'accept'` action is a no-op — retry is driven by `onWaitingDismiss` instead (`src/services/mcp/elicitationHandler.ts:37-39`).

- **Completion notification for unknown elicitation**: If a completion notification arrives for an elicitation not in the queue (already resolved or never queued), it is silently logged and ignored (`src/services/mcp/elicitationHandler.ts:200-205`).

- **Hook errors are non-fatal**: Both `runElicitationHooks` and `runElicitationResultHooks` catch all exceptions and fall through to default behavior, ensuring hook failures never break the elicitation flow.

- **Abort listener cleanup**: The `respond` callback removes the abort event listener before resolving, preventing double-resolution (`src/services/mcp/elicitationHandler.ts:139`).

## Key Code Snippets

### Queue entry creation with abort handling

```typescript
// src/services/mcp/elicitationHandler.ts:114-153
const response = new Promise<ElicitResult>(resolve => {
  const onAbort = () => {
    resolve({ action: 'cancel' })
  }

  if (extra.signal.aborted) {
    onAbort()
    return
  }

  setAppState(prev => ({
    ...prev,
    elicitation: {
      queue: [
        ...prev.elicitation.queue,
        {
          serverName,
          requestId: extra.requestId,
          params: request.params,
          signal: extra.signal,
          waitingState,
          respond: (result: ElicitResult) => {
            extra.signal.removeEventListener('abort', onAbort)
            // ... analytics logging ...
            resolve(result)
          },
        },
      ],
    },
  }))

  extra.signal.addEventListener('abort', onAbort, { once: true })
})
```

This pattern creates a `Promise` whose resolution is controlled by either the UI calling `respond()` or the abort signal firing — whichever comes first. The abort listener is registered with `{ once: true }` and explicitly removed on normal resolution to prevent leaks.