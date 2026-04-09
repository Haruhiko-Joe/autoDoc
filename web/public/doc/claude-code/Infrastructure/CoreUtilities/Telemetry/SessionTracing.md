# Session Tracing

## Overview & Responsibilities

Session Tracing is the OpenTelemetry span management layer within the Telemetry subsystem of Claude Code's Infrastructure. It provides a high-level API for creating, tracking, and ending trace spans that capture the lifecycle of user interactions — from user prompt through LLM requests, tool executions, permission prompts, and hook invocations.

The module is split into two files:

- **`sessionTracing.ts`** — The core span management engine. Owns the span lifecycle (start/end) for all span types, manages parent-child relationships via `AsyncLocalStorage`, handles TTL-based cleanup of orphaned spans, and coordinates with both the OpenTelemetry and Perfetto tracing backends.
- **`betaSessionTracing.ts`** — A beta extension that injects detailed diagnostic attributes into spans when enabled. Adds system prompt logging with hash-based deduplication, tool schema tracking, model/thinking output capture, per-agent incremental message context, and content truncation to stay within Honeycomb's 64KB attribute limit.

Within the broader architecture, this module sits under **Infrastructure → CoreUtilities → Telemetry** and is called by the QueryEngine (LLM requests), ToolSystem (tool executions), and DomainHelpers (hook runs) to instrument the request/response pipeline.

## Key Processes

### Span Hierarchy and Parent-Child Relationships

The tracing system maintains a hierarchical span structure using two `AsyncLocalStorage` instances:

1. **`interactionContext`** — Holds the current interaction span (root of each user turn)
2. **`toolContext`** — Holds the current tool span

The parent-child chain is: `interaction` → `llm_request` / `tool` → `tool.execution` / `tool.blocked_on_user` / `hook`. When creating child spans, the code looks up the parent from the appropriate ALS store and sets it as the OpenTelemetry parent context (`sessionTracing.ts:316-319`, `502-504`).

### Interaction Span Lifecycle

1. **`startInteractionSpan(userPrompt)`** is called when a user submits a prompt. It increments a global `interactionSequence` counter, creates a root span named `claude_code.interaction`, and stores it in `interactionContext` via `enterWith()`. The user prompt is redacted unless `OTEL_LOG_USER_PROMPTS` is set (`sessionTracing.ts:176-235`).

2. Operations within the interaction (LLM requests, tool calls) create child spans parented to the interaction span.

3. **`endInteractionSpan()`** records the duration, ends the OTel span, deletes it from tracking maps, and clears the ALS store with `enterWith(undefined)` to prevent stale references from leaking into subsequent async continuations (`sessionTracing.ts:237-272`).

### LLM Request Span Lifecycle

1. **`startLLMRequestSpan(model, newContext?, messagesForAPI?, fastMode?)`** creates a child span under the current interaction. It records the model name, query source (agent name), and speed mode. The beta extension adds system prompt hashes, tool schemas, and incremental message context (`sessionTracing.ts:274-340`).

2. **`endLLMRequestSpan(span?, metadata?)`** attaches response metadata — token counts (input, output, cache read, cache creation), success/error status, TTFT, and retry information. It accepts an optional `span` parameter to correctly match responses to requests when multiple LLM calls run in parallel (e.g., warmup, classifiers, main thread). Without this parameter, it falls back to finding the most recent `llm_request` span, which can cause mismatches (`sessionTracing.ts:353-464`).

### Tool Span Lifecycle

A tool span has up to three nested layers:

1. **`startToolSpan(toolName, attributes?, toolInput?)`** → `claude_code.tool` — wraps the entire tool invocation, stored in `toolContext` ALS
2. **`startToolBlockedOnUserSpan()`** → `claude_code.tool.blocked_on_user` — optional, created when the tool is waiting for user permission approval
3. **`startToolExecutionSpan()`** → `claude_code.tool.execution` — the actual execution phase after permission is granted

Each has a corresponding `end*` function that records duration and outcome metadata, then removes the span from tracking.

### TTL-Based Orphan Cleanup

A background interval (60s tick, 30-minute TTL) evicts orphaned spans that were never properly ended — for example, due to aborted streams or uncaught exceptions. The interval is lazily started on the first `startInteractionSpan` call and uses `unref()` so it doesn't keep the Node.js process alive (`sessionTracing.ts:86-120`).

### Memory Management: WeakRef + Strong Reference Strategy

All spans are tracked in `activeSpans` as `WeakRef<SpanContext>`. Spans stored in ALS (`interactionContext`, `toolContext`) are held strongly by the ALS itself. Spans *not* in ALS — LLM requests, blocked-on-user, tool execution, hooks — are additionally stored in `strongSpans` to prevent GC from collecting them before their `end*` function runs (`sessionTracing.ts:65-76`).

### Beta Tracing: Hash-Based Deduplication

The beta module avoids sending redundant data by hashing content and tracking what has been sent:

1. **System prompts**: Hashed with SHA-256 (prefix `sp_`). The full prompt is logged via `logOTelEvent` only once per unique hash; subsequent requests just attach the hash and a 500-char preview (`betaSessionTracing.ts:257-281`).

2. **Tool schemas**: Each tool's JSON definition is hashed individually. Full schemas are logged once per unique hash (`betaSessionTracing.ts:285-331`).

3. **Incremental message context**: Per-agent (`querySource`) tracking of the last reported message hash. On each LLM request, only messages *after* the last reported one are included in `new_context`, and system reminders (wrapped in `<system-reminder>` tags) are separated into their own attribute (`betaSessionTracing.ts:334-399`).

## Function Signatures

### Core Span API (`sessionTracing.ts`)

| Function | Parameters | Returns | Description |
|----------|-----------|---------|-------------|
| `startInteractionSpan` | `userPrompt: string` | `Span` | Creates root interaction span for a user turn |
| `endInteractionSpan` | — | `void` | Ends the current interaction span |
| `startLLMRequestSpan` | `model, newContext?, messagesForAPI?, fastMode?` | `Span` | Creates LLM request child span |
| `endLLMRequestSpan` | `span?, metadata?` | `void` | Ends LLM span with token/timing metadata |
| `startToolSpan` | `toolName, toolAttributes?, toolInput?` | `Span` | Creates tool invocation span |
| `endToolSpan` | `toolResult?, resultTokens?` | `void` | Ends tool span with result data |
| `startToolBlockedOnUserSpan` | — | `Span` | Creates sub-span for permission wait |
| `endToolBlockedOnUserSpan` | `decision?, source?` | `void` | Ends permission wait span |
| `startToolExecutionSpan` | — | `Span` | Creates sub-span for tool execution phase |
| `endToolExecutionSpan` | `metadata?: { success?, error? }` | `void` | Ends execution sub-span |
| `startHookSpan` | `hookEvent, hookName, numHooks, hookDefinitions` | `Span` | Creates hook execution span (beta-only) |
| `endHookSpan` | `span, metadata?` | `void` | Ends hook span with outcome counts |
| `executeInSpan` | `spanName, fn, attributes?` | `Promise<T>` | Wraps an async function in a traced span |
| `getCurrentSpan` | — | `Span \| null` | Returns the innermost active span (tool > interaction) |
| `addToolContentEvent` | `eventName, attributes` | `void` | Adds a span event (requires `OTEL_LOG_TOOL_CONTENT=1`) |
| `isEnhancedTelemetryEnabled` | — | `boolean` | Checks if enhanced telemetry is active |

### Beta Tracing API (`betaSessionTracing.ts`)

| Function | Description |
|----------|-------------|
| `isBetaTracingEnabled()` | Checks env vars + GrowthBook gate for beta tracing |
| `addBetaInteractionAttributes(span, userPrompt)` | Adds truncated user prompt as `new_context` |
| `addBetaLLMRequestAttributes(span, newContext?, messages?)` | Adds system prompt hash, tool schemas, incremental message context |
| `addBetaLLMResponseAttributes(endAttributes, metadata?)` | Adds `model_output` and `thinking_output` (ant-only) |
| `addBetaToolInputAttributes(span, toolName, toolInput)` | Adds truncated tool input |
| `addBetaToolResultAttributes(endAttributes, toolName, toolResult)` | Adds truncated tool result as `new_context` |
| `clearBetaTracingState()` | Resets deduplication caches (call after compaction) |
| `truncateContent(content, maxSize?)` | Truncates to 60KB with marker; returns `{ content, truncated }` |

## Interface/Type Definitions

### `LLMRequestNewContext`

```typescript
// betaSessionTracing.ts:210-217
interface LLMRequestNewContext {
  systemPrompt?: string   // System prompt text (logged once per unique hash)
  querySource?: string    // Agent identifier, e.g. 'repl_main_thread', 'agent:builtin'
  tools?: string          // JSON-serialized array of tool schemas
}
```

### `SpanType` (union)

```typescript
// sessionTracing.ts:49-56
type SpanType = 'interaction' | 'llm_request' | 'tool' | 'tool.blocked_on_user' | 'tool.execution' | 'hook'
```

### `SpanContext` (internal)

```typescript
// sessionTracing.ts:57-63
interface SpanContext {
  span: Span
  startTime: number
  attributes: Record<string, string | number | boolean>
  ended?: boolean
  perfettoSpanId?: string
}
```

## Configuration & Defaults

| Variable | Purpose | Default |
|----------|---------|---------|
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` / `ENABLE_ENHANCED_TELEMETRY_BETA` | Enables standard enhanced telemetry | Disabled; falls back to `USER_TYPE=ant` or GrowthBook `enhanced_telemetry_beta` gate |
| `ENABLE_BETA_TRACING_DETAILED` | Enables beta detailed tracing (must be `1`) | Disabled |
| `BETA_TRACING_ENDPOINT` | OTLP endpoint for beta tracing | Required for beta tracing |
| `OTEL_LOG_USER_PROMPTS` | Logs full user prompt text in interaction spans | Disabled (prompts redacted as `<REDACTED>`) |
| `OTEL_LOG_TOOL_CONTENT` | Enables `addToolContentEvent` span events | Disabled |
| `USER_TYPE` | When `ant`, enables tracing in all modes; affects thinking output visibility | — |
| `OTEL_TRACES_EXPORTER` | Standard OTel config for export target | — |

**Internal constants:**
- `SPAN_TTL_MS` = 30 minutes — maximum age before orphaned spans are force-ended
- `MAX_CONTENT_SIZE` = 60KB — truncation threshold (Honeycomb limit is 64KB)
- Cleanup interval runs every 60 seconds

## Edge Cases & Caveats

- **Parallel LLM requests**: When multiple LLM requests run concurrently (warmup, classifiers, main thread), callers **must** pass the specific `span` to `endLLMRequestSpan()`. The legacy fallback (finding the most recent `llm_request` span) can attach responses to the wrong span (`sessionTracing.ts:344-351`).

- **Visibility restrictions for beta tracing**: Thinking/reasoning output is only captured for `ant` users (`USER_TYPE=ant`). External users see model output but not thinking output (`betaSessionTracing.ts:430-442`).

- **External user gating**: Beta tracing for non-ant users requires either SDK/headless mode or allowlisting via the `tengu_trace_lantern` GrowthBook gate. The gate reads from disk cache, so the first run after allowlisting returns false — it takes effect on the second run (`betaSessionTracing.ts:87-98`).

- **Compaction invalidates hashes**: After context compaction (which replaces conversation messages), `clearBetaTracingState()` must be called to reset the deduplication caches; otherwise, stale message hashes cause the incremental context tracker to miss new messages.

- **ALS clearing after span end**: Both `endInteractionSpan` and `endToolSpan` call `enterWith(undefined)` to clear the ALS store. This prevents async continuations (timers, promise callbacks) from inheriting stale span references. Using `exit(() => {})` would be a no-op since it only suppresses inside the callback (`sessionTracing.ts:256-259`).

- **Dummy spans when tracing is disabled**: All `start*` functions return a real `Span` object even when tracing is off — either the active span or a freshly created dummy. This avoids null checks at call sites. However, Perfetto spans are still tracked independently even if OTel is disabled.