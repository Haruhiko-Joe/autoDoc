# CostTracker

## Overview & Responsibilities

The CostTracker module is part of the **QueryEngine** subsystem and is responsible for tracking, accumulating, persisting, and displaying token usage and monetary costs across a Claude Code session. It sits between the API client (which reports per-request usage) and the terminal UI (which displays cost summaries to the user on exit).

The module spans two files:
- **`src/cost-tracker.ts`** — the core cost tracking logic: accumulating per-model usage, formatting cost summaries, and persisting/restoring session costs via project config.
- **`src/costHook.ts`** — a React hook (`useCostSummary`) that wires cost display and persistence into the process exit lifecycle.

## Key Processes

### Accumulating Session Costs

When the API returns a response with token usage, the main entry point is `addToTotalSessionCost()` (`src/cost-tracker.ts:278-323`):

1. Calls `addToTotalModelUsage()` to update the per-model usage accumulator (input, output, cache read, cache write tokens, web search requests, and USD cost).
2. Pushes the accumulated model usage into the global state via `addToTotalCostState()`.
3. Reports metrics to OpenTelemetry counters (`getCostCounter()`, `getTokenCounter()`) with model and speed attributes.
4. Recursively processes **advisor usage** — if the response included nested advisor model invocations (via `getAdvisorUsage()`), it calculates their cost with `calculateUSDCost()`, logs an analytics event, and recursively calls itself to accumulate those costs too.
5. Returns the total cost (primary + all advisor costs) for the call.

### Per-Model Usage Tracking

`addToTotalModelUsage()` (`src/cost-tracker.ts:250-276`) maintains a running tally per model string. For each model, it tracks:
- `inputTokens`, `outputTokens`
- `cacheReadInputTokens`, `cacheCreationInputTokens`
- `webSearchRequests` (from `usage.server_tool_use?.web_search_requests`)
- `costUSD`
- `contextWindow` and `maxOutputTokens` (looked up from model metadata)

### Formatting Cost Summaries

`formatTotalCost()` (`src/cost-tracker.ts:228-244`) builds the full cost summary string displayed to the user. It includes:
- Total cost in USD (with a warning if unknown models were used)
- API duration and wall-clock duration
- Lines of code added/removed
- Per-model usage breakdown via `formatModelUsage()`

`formatModelUsage()` (`src/cost-tracker.ts:181-226`) groups usage by **canonical short name** (e.g., multiple model ID variants for the same model are merged) and formats each as a line showing input/output/cache tokens, optional web search count, and cost.

`formatCost()` (`src/cost-tracker.ts:177-179`) formats a USD amount: costs above $0.50 are rounded to 2 decimal places, smaller costs show up to 4 decimal places.

### Persisting and Restoring Session Costs

Costs are persisted to the project config so that resumed sessions can pick up where they left off.

**Saving** — `saveCurrentSessionCosts()` (`src/cost-tracker.ts:143-175`) writes all accumulated state (cost, durations, token counts, lines changed, per-model usage, FPS metrics, and the current session ID) into the project config file.

**Restoring** — `restoreCostStateForSession(sessionId)` (`src/cost-tracker.ts:130-137`) checks if the saved session ID matches the one being resumed. If so, it calls `getStoredSessionCosts()` to read the stored data and `setCostStateForRestore()` to re-hydrate the global state.

**Reading** — `getStoredSessionCosts(sessionId)` (`src/cost-tracker.ts:87-123`) reads cost data from project config, enriching the stored per-model usage with current `contextWindow` and `maxOutputTokens` values (since these may change between versions). Returns `undefined` if the session ID doesn't match.

### Exit Hook (useCostSummary)

`useCostSummary()` (`src/costHook.ts:6-22`) is a React hook used by the terminal UI. On mount, it registers a `process.on('exit')` handler that:
1. Checks `hasConsoleBillingAccess()` — only displays costs if the user has billing visibility.
2. Writes the formatted cost summary to stdout.
3. Calls `saveCurrentSessionCosts()` with optional FPS metrics to persist the session state.

The handler is cleaned up on unmount via `process.off('exit')`.

## Function Signatures

### `addToTotalSessionCost(cost: number, usage: Usage, model: string): number`

Main accumulation entry point. Adds a single API call's cost and usage to the running session totals.
- **cost** — the USD cost for this API call
- **usage** — the Anthropic SDK `Usage` object with token counts
- **model** — the model ID string
- **Returns** — total cost including any nested advisor costs

### `formatTotalCost(): string`

Returns a chalk-dimmed multi-line string with the complete cost summary (cost, durations, code changes, per-model breakdown).

### `saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void`

Persists all current session cost state to the project config file. Optionally includes FPS rendering metrics.

### `restoreCostStateForSession(sessionId: string): boolean`

Attempts to restore cost state from project config for the given session. Returns `true` if restoration succeeded (session ID matched), `false` otherwise.

### `getStoredSessionCosts(sessionId: string): StoredCostState | undefined`

Reads stored cost data from project config without modifying global state. Returns `undefined` if the session ID doesn't match.

### `useCostSummary(getFpsMetrics?: () => FpsMetrics | undefined): void`

React hook that registers process exit handlers for cost display and persistence.

## Type Definitions

### `StoredCostState`

(`src/cost-tracker.ts:71-80`)

| Field | Type | Description |
|-------|------|-------------|
| `totalCostUSD` | `number` | Accumulated USD cost |
| `totalAPIDuration` | `number` | Total time spent in API calls |
| `totalAPIDurationWithoutRetries` | `number` | API time excluding retries |
| `totalToolDuration` | `number` | Total time spent in tool execution |
| `totalLinesAdded` | `number` | Lines of code added |
| `totalLinesRemoved` | `number` | Lines of code removed |
| `lastDuration` | `number \| undefined` | Wall-clock session duration |
| `modelUsage` | `{ [modelName: string]: ModelUsage } \| undefined` | Per-model token/cost breakdown |

## Re-exported API Surface

The module re-exports a large set of state accessors from `./bootstrap/state.js` (`src/cost-tracker.ts:49-69`), including `getTotalCost` (aliased from `getTotalCostUSD`), `getTotalDuration`, `getTotalInputTokens`, `getTotalOutputTokens`, `getModelUsage`, `resetCostState`, and others. These provide read access to the accumulated counters for other modules.

## Edge Cases & Caveats

- **Unknown model costs**: If a model's pricing isn't known, `setHasUnknownModelCost()` is called elsewhere, and `formatTotalCost()` appends a warning: *"costs may be inaccurate due to usage of unknown models"*.
- **Session ID matching**: Cost restoration is gated on session ID equality — if you start a new session, prior costs are not loaded. This prevents cross-session cost contamination.
- **Advisor recursion**: `addToTotalSessionCost` calls itself recursively for advisor usage, so a single API response can trigger multiple cost accumulations if advisor models were used.
- **Billing access gate**: The cost summary is only printed on exit if `hasConsoleBillingAccess()` returns true; session costs are always persisted regardless.
- **Cost formatting threshold**: Costs above $0.50 display with 2 decimal places; below $0.50 with 4 decimal places — this avoids showing "$0.00" for small sessions while keeping large costs readable.
- **Canonical name merging**: `formatModelUsage()` merges usage from model ID variants (e.g., dated model snapshots) into a single canonical display name, so users see one line per logical model.