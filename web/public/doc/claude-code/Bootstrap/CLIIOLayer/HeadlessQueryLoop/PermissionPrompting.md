# PermissionPrompting

## Overview & Responsibilities

The PermissionPrompting module provides the exported functions that create **tool permission callbacks** (`CanUseToolFn`) for Claude Code's headless (SDK/piped/bridge) and interactive execution modes. These callbacks are invoked every time Claude attempts to use a tool, and they decide whether to allow, deny, or prompt the user for permission.

This module sits within the **CLIIOLayer → HeadlessQueryLoop** part of the Bootstrap hierarchy. It bridges two worlds: the static permission system (`hasPermissionsToUseTool`) that checks pre-configured allow/deny rules, and dynamic permission prompting via MCP tools or the SDK control protocol. Sibling modules include the **StructuredIOLayer** (which provides the `stdio`-based permission path) and **Transports** (which carry remote permission messages).

The module exports three functions from `src/cli/print.ts`:

| Function | Lines | Purpose |
|---|---|---|
| `createCanUseToolWithPermissionPrompt` | 4149–4263 | Wraps an MCP permission prompt tool into a `CanUseToolFn` |
| `getCanUseToolFn` | 4267–4334 | Factory that selects the right permission strategy |
| `handleOrphanedPermissionResponse` | 5241–5305 | Recovers orphaned permission responses from reconnected sessions |

## Key Processes

### Permission Strategy Selection (`getCanUseToolFn`)

`getCanUseToolFn` is the entry point called during headless session setup. It examines the `permissionPromptToolName` parameter (from `--permission-prompt-tool` CLI flag) and returns the appropriate `CanUseToolFn`:

1. **`'stdio'`** — Delegates to `structuredIO.createCanUseTool(onPermissionPrompt)`, which uses the SDK control protocol to send permission prompts over stdin/stdout NDJSON framing (`src/cli/print.ts:4273-4275`).

2. **`undefined`** — No custom prompt tool configured. Falls back directly to `hasPermissionsToUseTool()`, which evaluates static permission rules (auto-mode). If a `forceDecision` is provided, it short-circuits and returns that immediately (`src/cli/print.ts:4276-4293`).

3. **Any other string** — Treated as an MCP tool name. Uses **lazy resolution**: the MCP tool is not looked up at construction time (because MCP server connections are incremental and may not be ready yet), but on first invocation. On that first call it:
   - Calls `getMcpTools()` to get the current MCP tool list
   - Finds the tool by name via `toolMatchesName()`
   - Validates the tool has `inputJSONSchema` (must be an MCP tool)
   - Wraps it with `createCanUseToolWithPermissionPrompt()` and caches the result
   - On failure, writes to stderr and calls `gracefulShutdownSync(1)` (`src/cli/print.ts:4306-4323`)

### MCP Permission Prompt Flow (`createCanUseToolWithPermissionPrompt`)

This function converts an MCP-based `PermissionPromptTool` into a standard `CanUseToolFn`. The flow for each tool use:

1. **Check static permissions first** — Calls `hasPermissionsToUseTool()` (or uses `forceDecision` if provided). If the result is `allow` or `deny`, returns immediately without prompting. Only `ask`-behavior results proceed to the MCP prompt (`src/cli/print.ts:4160-4176`).

2. **Abort signal setup** — Creates a combined abort signal via `createCombinedAbortSignal()` that merges the tool use context's abort controller. Checks if already aborted before starting the race (`src/cli/print.ts:4188-4203`).

3. **Race prompt against abort** — Runs `Promise.race()` between:
   - `permissionPromptTool.call()` — the MCP tool call that may block indefinitely waiting for user input
   - An abort promise that resolves to `'aborted'` when the combined signal fires

   This race is necessary because the permission tool may block forever waiting for user input (e.g., via a UI dialog). Without it, an abort (Ctrl+C) would not be detected until the tool completes (`src/cli/print.ts:4205-4222`).

4. **Handle abort** — If the race resolves to `'aborted'` or the signal is aborted (double-check for race conditions), returns a `deny` decision with `'Permission prompt was aborted.'` (`src/cli/print.ts:4225-4235`).

5. **Parse tool result** — Maps the MCP tool result to a `ToolResultBlockParam`, validates it contains a single text block, parses the JSON text through `permissionToolOutputSchema()`, and converts it to a `PermissionDecision` via `permissionPromptToolResultToPermissionDecision()` (`src/cli/print.ts:4240-4260`).

### Orphaned Permission Recovery (`handleOrphanedPermissionResponse`)

In remote/bridge sessions, permission responses can arrive after the original prompt context has been lost (e.g., due to WebSocket reconnection). This function recovers those "orphaned" responses:

1. **Validate the message** — Checks that it's a successful `SDKControlResponse` with a `toolUseID` string (`src/cli/print.ts:5252-5261`).

2. **Deduplication check** — Looks up the `toolUseID` in a `handledToolUseIds` set. Without this guard, duplicate `control_response` deliveries (e.g., from WebSocket reconnect) would cause the same tool to execute multiple times, producing duplicate tool_use IDs and a 400 error from the API (`src/cli/print.ts:5272-5277`).

3. **Find unresolved tool use** — Calls `findUnresolvedToolUse(toolUseID)` which loads the session transcript and searches for a tool_use block with that ID that has no corresponding tool_result (`src/cli/print.ts:5279-5285`).

4. **Enqueue for execution** — If found, adds the `toolUseID` to the handled set and enqueues the permission result via the command queue's `enqueue()` function with `mode: 'orphaned-permission'`, including the permission result and the matched assistant message (`src/cli/print.ts:5287-5298`).

5. **Notify caller** — Calls the optional `onEnqueued` callback and returns `true`. Returns `false` at any early exit (`src/cli/print.ts:5300-5303`).

## Function Signatures

### `createCanUseToolWithPermissionPrompt(permissionPromptTool: PermissionPromptTool): CanUseToolFn`

Wraps an MCP permission prompt tool into a `CanUseToolFn`.

- **permissionPromptTool**: An MCP tool typed as `Tool<permissionToolInputSchema, permissionToolOutputSchema>` (defined in `src/utils/queryHelpers.ts:39-42`). Must implement `.call()` and `.mapToolResultToToolResultBlockParam()`.
- **Returns**: A `CanUseToolFn` that first checks static permissions, then races the MCP tool prompt against abort signals.

> Source: `src/cli/print.ts:4149-4263`

### `getCanUseToolFn(permissionPromptToolName, structuredIO, getMcpTools, onPermissionPrompt?): CanUseToolFn`

Factory that selects the permission strategy based on configuration.

| Parameter | Type | Description |
|---|---|---|
| `permissionPromptToolName` | `string \| undefined` | `'stdio'` for SDK protocol, `undefined` for auto-mode, or an MCP tool name |
| `structuredIO` | `StructuredIO` | The structured I/O instance for SDK control protocol prompting |
| `getMcpTools` | `() => Tool[]` | Lazy getter for available MCP tools (deferred because MCP connects are incremental) |
| `onPermissionPrompt` | `(details: RequiresActionDetails) => void` | Optional callback invoked when a permission prompt is shown (stdio mode only) |

- **Returns**: A `CanUseToolFn` implementing the selected strategy.

> Source: `src/cli/print.ts:4267-4334`

### `handleOrphanedPermissionResponse({ message, setAppState, onEnqueued, handledToolUseIds }): Promise<boolean>`

Recovers orphaned permission responses and re-enqueues them for execution.

| Parameter | Type | Description |
|---|---|---|
| `message` | `SDKControlResponse` | The orphaned control response message |
| `setAppState` | `(f: (prev: AppState) => AppState) => void` | State updater function |
| `onEnqueued` | `() => void` (optional) | Callback fired when a permission is successfully enqueued |
| `handledToolUseIds` | `Set<string>` | Deduplication set tracking already-handled tool use IDs |

- **Returns**: `true` if a permission was enqueued, `false` otherwise.

> Source: `src/cli/print.ts:5241-5305`

## Type Definitions

### `CanUseToolFn`

```typescript
type CanUseToolFn<Input extends Record<string, unknown> = Record<string, unknown>> = (
  tool: Tool,
  input: Input,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  forceDecision?: PermissionDecision<Input>,
) => Promise<PermissionDecision<Input>>
```

Defined in `src/hooks/useCanUseTool.tsx:27`. The universal callback signature for permission decisions. The `forceDecision` parameter allows callers to bypass the permission check entirely (used for orphaned permission recovery).

### `PermissionPromptTool`

```typescript
type PermissionPromptTool = Tool<
  ReturnType<typeof permissionToolInputSchema>,
  ReturnType<typeof permissionToolOutputSchema>
>
```

Defined in `src/utils/queryHelpers.ts:39-42`. An MCP tool that accepts `{ tool_name, input, tool_use_id }` and returns a permission decision (allow/deny with optional updated permissions).

## Edge Cases & Caveats

- **Lazy MCP tool resolution**: The MCP permission prompt tool is resolved on first use, not at construction. This is intentional — MCP server connections are established incrementally in headless mode, and the tool may not exist in `appState` at startup. If it's still missing on first permission prompt, the process exits with code 1.

- **Double abort check**: After `Promise.race` resolves, the code checks `combinedSignal.aborted` again. This handles a race condition where the abort fires after `Promise.race` resolves but before the check executes (`src/cli/print.ts:4225`).

- **Duplicate orphaned responses**: WebSocket reconnections can deliver the same `control_response` multiple times. Without the `handledToolUseIds` guard, each duplicate would cause the tool to execute again, producing duplicate `tool_use` IDs in the message array and a 400 error from the Anthropic API. Once corrupted, every retry accumulates more duplicates (`src/cli/print.ts:5267-5271`).

- **Invalid MCP tool result**: If the permission prompt tool returns something other than a single text block, `createCanUseToolWithPermissionPrompt` throws with a descriptive error rather than silently misinterpreting the result (`src/cli/print.ts:4248-4252`).

- **Non-MCP tool rejection**: `getCanUseToolFn` validates that the resolved tool has `inputJSONSchema` — if a non-MCP tool with that name exists, it's rejected with an error and the process exits (`src/cli/print.ts:4317-4322`).