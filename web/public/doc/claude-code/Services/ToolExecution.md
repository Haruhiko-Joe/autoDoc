# Tool Execution

## Overview & Responsibilities

The Tool Execution module (`src/services/tools/`) is the runtime engine that manages how tools are invoked during a conversation turn. It sits between the QueryEngine (which dispatches tool calls from Claude's responses) and the individual Tool implementations (which perform the actual work). Within the broader **Services** layer, this module is the bridge that takes raw `ToolUseBlock` objects from the Anthropic API response and shepherds them through validation, permission checking, execution, result formatting, and analytics.

The module consists of four files, each handling a distinct concern:

| File | Responsibility |
|------|----------------|
| `StreamingToolExecutor.ts` | Concurrent execution of tools as they stream in, with ordering guarantees |
| `toolOrchestration.ts` | Batch-oriented orchestration: partitioning, serial vs. concurrent dispatch |
| `toolExecution.ts` | Core execution engine: validation, permissions, tool invocation, result formatting, telemetry |
| `toolHooks.ts` | Pre/post execution hooks for analytics, permission overrides, and side effects |

## Key Processes

### 1. Streaming Tool Execution Flow (`StreamingToolExecutor`)

The `StreamingToolExecutor` class is the primary executor used during a live conversation turn. It processes tools as they arrive from the streaming API response, rather than waiting for all tool calls to be collected first.

1. **Tool arrives** via `addTool(block, assistantMessage)` — looks up the tool definition, parses input to determine concurrency safety, and enqueues it with status `'queued'` (`src/services/tools/StreamingToolExecutor.ts:76-124`)
2. **Queue processing** (`processQueue`) — iterates queued tools and starts any that satisfy concurrency constraints (`src/services/tools/StreamingToolExecutor.ts:140-151`)
3. **Concurrency check** (`canExecuteTool`) — a tool can execute if either (a) nothing else is executing, or (b) both the new tool and all executing tools are concurrency-safe (`src/services/tools/StreamingToolExecutor.ts:129-135`)
4. **Tool execution** (`executeTool`) — creates a per-tool `AbortController` (child of the sibling controller), calls `runToolUse()` from `toolExecution.ts`, collects results and progress messages (`src/services/tools/StreamingToolExecutor.ts:265-405`)
5. **Result yielding** (`getCompletedResults` / `getRemainingResults`) — emits results in the order tools were received, yielding progress messages immediately regardless of ordering (`src/services/tools/StreamingToolExecutor.ts:412-490`)

**Concurrency model**: Tools declare themselves concurrency-safe via `tool.isConcurrencySafe(input)`. Safe tools (e.g., Read, Grep, Glob) run in parallel. Unsafe tools (e.g., Bash, Edit) run with exclusive access. Non-concurrent tools block the queue — if a non-concurrent tool is queued behind executing concurrent tools, the executor waits.

**Error cascading**: When a Bash tool errors, the executor aborts all sibling tools via `siblingAbortController`. Other tool types (Read, WebFetch, etc.) do not cascade errors — they are considered independent (`src/services/tools/StreamingToolExecutor.ts:358-363`).

### 2. Batch Orchestration Flow (`toolOrchestration`)

The `runTools()` function provides an alternative orchestration path that partitions tool calls into ordered batches.

1. **Partition** (`partitionToolCalls`) — groups consecutive concurrency-safe tools into one batch, and wraps each non-safe tool as its own single-item batch (`src/services/tools/toolOrchestration.ts:91-116`)
2. **Concurrent batches** — dispatched via `runToolsConcurrently()` using `all()` with a configurable concurrency limit (default 10, overridable via `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`) (`src/services/tools/toolOrchestration.ts:152-177`)
3. **Serial batches** — dispatched via `runToolsSerially()`, one tool at a time, with context modifiers applied between tools (`src/services/tools/toolOrchestration.ts:118-150`)
4. **Context propagation** — context modifiers from concurrent batches are queued and applied in original tool order after the batch completes (`src/services/tools/toolOrchestration.ts:31-63`)

### 3. Core Tool Execution Pipeline (`checkPermissionsAndCallTool`)

This is the central function that every tool invocation passes through (`src/services/tools/toolExecution.ts:599-1745`). The pipeline stages are:

1. **Input validation** — Zod schema parsing via `tool.inputSchema.safeParse(input)`. On failure, returns a formatted error. If the tool is a deferred tool whose schema wasn't sent to the API, appends a hint to call `ToolSearch` first (`src/services/tools/toolExecution.ts:615-680`)
2. **Custom validation** — `tool.validateInput()` for tool-specific semantic checks (`src/services/tools/toolExecution.ts:683-733`)
3. **Speculative classifier** — For Bash tools, speculatively starts the permission classifier in parallel with hooks (`src/services/tools/toolExecution.ts:740-752`)
4. **Pre-tool hooks** — Runs `PreToolUse` hooks that can allow/deny/ask permissions, modify input, inject additional context, or stop execution entirely (`src/services/tools/toolExecution.ts:800-862`)
5. **Permission resolution** — Calls `resolveHookPermissionDecision()` which integrates hook results with the rule-based permission system and interactive prompts (`src/services/tools/toolExecution.ts:921-931`)
6. **Tool invocation** — Calls `tool.call()` with the final input, capturing progress events via a callback (`src/services/tools/toolExecution.ts:1207-1222`)
7. **Result processing** — Maps the tool result to API format, attaches user feedback/images if provided during permission approval, and stores the result (`src/services/tools/toolExecution.ts:1292-1474`)
8. **Post-tool hooks** — Runs `PostToolUse` hooks that can inject additional context, block continuation, or modify MCP tool output (`src/services/tools/toolExecution.ts:1483-1563`)
9. **Error handling** — On failure, runs `PostToolUseFailure` hooks, handles MCP auth errors by updating client state, and formats error results (`src/services/tools/toolExecution.ts:1589-1744`)

### 4. Hook Permission Resolution

The `resolveHookPermissionDecision()` function (`src/services/tools/toolHooks.ts:332-433`) encapsulates a critical invariant: **hook `allow` does NOT bypass settings.json deny/ask rules**.

```
Hook says "allow"
  → Does tool require user interaction AND no updatedInput?  → canUseTool()
  → Does requireCanUseTool apply?                           → canUseTool()
  → Check rule-based permissions:
      → null (no rule)  → honor hook allow
      → deny rule       → deny overrides hook
      → ask rule        → show dialog despite hook
Hook says "deny"   → deny immediately
Hook says "ask"    → normal flow with forceDecision
No hook decision   → normal permission flow
```

## Function Signatures

### `StreamingToolExecutor` (class)

```typescript
class StreamingToolExecutor {
  constructor(toolDefinitions: Tools, canUseTool: CanUseToolFn, toolUseContext: ToolUseContext)
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void
  discard(): void
  *getCompletedResults(): Generator<MessageUpdate, void>
  async *getRemainingResults(): AsyncGenerator<MessageUpdate, void>
  getUpdatedContext(): ToolUseContext
}
```

> Source: `src/services/tools/StreamingToolExecutor.ts:40-519`

### `runTools()`

```typescript
async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void>
```

Entry point for batch-mode tool orchestration. Partitions tools into concurrent/serial batches and yields results.

> Source: `src/services/tools/toolOrchestration.ts:19-82`

### `runToolUse()`

```typescript
async function* runToolUse(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage,
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void>
```

Executes a single tool use block. Resolves the tool by name (including deprecated aliases), checks for abort, then delegates to `streamedCheckPermissionsAndCallTool`.

> Source: `src/services/tools/toolExecution.ts:337-490`

### `resolveHookPermissionDecision()`

```typescript
async function resolveHookPermissionDecision(
  hookPermissionResult: PermissionResult | undefined,
  tool: Tool,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
  assistantMessage: AssistantMessage,
  toolUseID: string,
): Promise<{ decision: PermissionDecision; input: Record<string, unknown> }>
```

Merges hook permission results with the rule-based permission system. Shared between the main query loop and REPL inner calls to keep permission semantics in lockstep.

> Source: `src/services/tools/toolHooks.ts:332-433`

## Type Definitions

### `ToolStatus`

Lifecycle states for a tracked tool in the streaming executor:

| Value | Meaning |
|-------|---------|
| `'queued'` | Awaiting execution (concurrency slot not available) |
| `'executing'` | Currently running |
| `'completed'` | Finished, results buffered but not yet yielded |
| `'yielded'` | Results have been emitted to the caller |

> Source: `src/services/tools/StreamingToolExecutor.ts:19`

### `MessageUpdateLazy<M>`

```typescript
type MessageUpdateLazy<M extends Message = Message> = {
  message: M
  contextModifier?: {
    toolUseID: string
    modifyContext: (context: ToolUseContext) => ToolUseContext
  }
}
```

The unit of output from tool execution — a message plus an optional context modifier that transforms the `ToolUseContext` for subsequent tools.

> Source: `src/services/tools/toolExecution.ts:264-270`

### `McpServerType`

```typescript
type McpServerType = 'stdio' | 'sse' | 'http' | 'ws' | 'sdk' | 'sse-ide' | 'ws-ide' | 'claudeai-proxy' | undefined
```

Transport type for MCP server connections, used in analytics and error handling.

> Source: `src/services/tools/toolExecution.ts:272-281`

## Configuration

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | env var | `10` | Maximum number of concurrent tool executions in batch mode |
| `HOOK_TIMING_DISPLAY_THRESHOLD_MS` | constant | `500` | Minimum hook duration to show inline timing summary |
| `SLOW_PHASE_LOG_THRESHOLD_MS` | constant | `2000` | Threshold for logging debug warnings about slow hooks/permissions |

## Edge Cases & Caveats

- **Bash error cascading**: Only Bash tool errors cancel sibling tools. This is intentional — Bash commands often form implicit dependency chains (e.g., `mkdir` fails → subsequent commands are pointless), while Read/WebFetch tools are independent (`src/services/tools/StreamingToolExecutor.ts:358-363`).

- **Abort signal hierarchy**: The `StreamingToolExecutor` creates a `siblingAbortController` as a child of the `toolUseContext.abortController`. Each tool gets its own child controller. Aborting a tool's controller bubbles up to the query controller (to end the turn), *except* when the reason is `'sibling_error'` — preventing one Bash failure from terminating the entire query (`src/services/tools/StreamingToolExecutor.ts:301-318`).

- **Interrupt behavior**: Tools declare an `interruptBehavior()` of either `'cancel'` or `'block'`. When the user types a new message (interrupt), only `'cancel'` tools are aborted; `'block'` tools continue running (`src/services/tools/StreamingToolExecutor.ts:233-241`).

- **Context modifiers not supported for concurrent tools**: The streaming executor explicitly notes this limitation — context modifiers are only applied for non-concurrency-safe tools. If concurrent tools need context modification, additional work is required (`src/services/tools/StreamingToolExecutor.ts:389-395`).

- **Deferred tool schema mismatch**: When a deferred tool's schema wasn't sent in the API request, Zod validation fails with confusing type errors. The `buildSchemaNotSentHint()` function detects this and appends a hint telling the model to call `ToolSearch` first (`src/services/tools/toolExecution.ts:578-597`).

- **`_simulatedSedEdit` defense-in-depth**: This internal-only field on Bash input is stripped from model-provided input as a safeguard, since it should only be injected by the permission system after user approval (`src/services/tools/toolExecution.ts:756-773`).

- **Hook `allow` does not bypass deny rules**: A PreToolUse hook returning `{behavior: 'allow'}` skips the interactive permission prompt but still runs `checkRuleBasedPermissions()`. A deny rule in settings.json overrides the hook (`src/services/tools/toolHooks.ts:372-405`).

- **MCP tool output modification**: PostToolUse hooks can modify MCP tool output via `updatedMCPToolOutput`. For MCP tools, `addToolResult()` is deferred until after hooks run, so the modified output is what gets stored. Non-MCP tools add results before hooks (`src/services/tools/toolExecution.ts:1477-1542`).

- **Progress messages bypass ordering**: Progress messages from tools are yielded immediately via `pendingProgress`, independent of the normal result-ordering constraints. This ensures UI responsiveness for long-running tools (`src/services/tools/StreamingToolExecutor.ts:368-378`).