# API Observability

## Overview & Responsibilities

The API Observability module provides the instrumentation layer for all Claude API interactions within the APIClient subsystem of the Services layer. It is responsible for:

- **Request/response analytics logging** — recording detailed per-request metrics (token usage, costs, latency, stop reasons, model info) via both first-party analytics events and OpenTelemetry spans
- **Prompt cache break detection** — diagnosing why the Anthropic server-side prompt cache was invalidated between requests by hashing and diffing system prompts, tools, betas, and configuration
- **Request payload dumping** — saving full API request/response payloads to disk in JSONL format for debugging (primarily used by the `/issue` command)
- **Usage constants** — providing a zero-initialized usage object to avoid circular import chains

This module sits between the core API client (which sends messages to Claude) and the analytics pipeline (which exports events to Datadog, GrowthBook, and first-party telemetry). It does not initiate API calls itself — instead, the query engine calls these functions at the appropriate lifecycle points (pre-request, post-success, post-error).

## Key Processes

### API Request Lifecycle Logging

The logging flow follows a three-phase pattern tied to each API call:

1. **Pre-request** — `logAPIQuery()` fires a `tengu_api_query` event capturing the model, message count, temperature, permission mode, query source, effort level, fast mode, and any beta headers (`src/services/api/logging.ts:171-233`)

2. **On success** — `logAPISuccessAndDuration()` computes duration, measures content block lengths (text, thinking, tool use), detects AI gateways from response headers, then delegates to `logAPISuccess()` which fires `tengu_api_success` with full token usage breakdown (input, output, cache read, cache creation), cost in USD, TTFT, stop reason, and gateway info. It also emits an OpenTelemetry `api_request` event and ends the LLM tracing span (`src/services/api/logging.ts:581-788`)

3. **On error** — `logAPIError()` classifies the error via `classifyAPIError()`, extracts connection error details (including SSL errors), fires `tengu_api_error` and an OTel `api_error` event, and ends the LLM span with failure metadata (`src/services/api/logging.ts:235-396`)

Both success and error paths also handle teleported session reliability tracking — logging the first message outcome for sessions that were teleported from another environment.

### Gateway Detection

The `detectGateway()` function identifies AI proxy gateways (LiteLLM, Helicone, Portkey, Cloudflare AI Gateway, Kong, Braintrust, Databricks) by matching response header prefixes or `ANTHROPIC_BASE_URL` hostname suffixes. This metadata is attached to analytics events for understanding the infrastructure path of API calls (`src/services/api/logging.ts:107-139`).

### Prompt Cache Break Detection (Two-Phase)

Cache break detection uses a two-phase approach to separate observation from diagnosis:

**Phase 1 — `recordPromptState()` (pre-call):**
Hashes the current system prompt, tool schemas, model, betas, fast mode, effort level, cache control settings, global cache strategy, overage state, and extra body params. Compares each hash against the previous state for the same query source. If anything changed, stores a `PendingChanges` object describing exactly what differed — including per-tool schema diffs to pinpoint which specific tool's description changed (`src/services/api/promptCacheBreakDetection.ts:247-430`).

**Phase 2 — `checkResponseForCacheBreak()` (post-call):**
Examines the API response's `cache_read_input_tokens`. A cache break is detected when cache read tokens drop by more than 5% AND at least 2,000 tokens from the previous call. When detected, it:
- Builds a human-readable explanation from the pending changes (e.g., "system prompt changed (+142 chars), tools changed (+1/-0 tools)")
- Checks time gaps against known Anthropic cache TTLs (5min, 1hr) to attribute unexplained breaks to TTL expiry or server-side causes
- Fires a `tengu_prompt_cache_break` analytics event with all change flags
- Writes a unified diff of the prompt state to a temp file for debugging
- Logs a warning summary visible via `--debug` (`src/services/api/promptCacheBreakDetection.ts:437-666`)

**False-positive suppression:**
- `notifyCacheDeletion()` — marks that a cached microcompact deletion was sent, so the expected drop in cache reads isn't flagged (`src/services/api/promptCacheBreakDetection.ts:673-682`)
- `notifyCompaction()` — resets the cache read baseline after compaction, since message count legitimately drops (`src/services/api/promptCacheBreakDetection.ts:689-698`)
- Haiku models are excluded entirely (different caching behavior)

**Tracking scoping:**
State is tracked per query source using `getTrackingKey()`. The main REPL thread and compact share a key (same server-side cache). Subagents use their unique `agentId` for isolation. Short-lived forked agents (speculation, session memory) are not tracked. The map is capped at 10 entries to bound memory (`src/services/api/promptCacheBreakDetection.ts:101-158`).

### Prompt Dumping for Debugging

`createDumpPromptsFetch()` returns a custom `fetch` wrapper that intercepts API calls and saves payloads to a JSONL file at `~/.claude/dump-prompts/<sessionId>.jsonl` (`src/services/api/dumpPrompts.ts:146-226`):

1. **On request** — Defers parsing to `setImmediate` (the request body can be megabytes) to avoid blocking the actual API call. Writes an `init` entry on first call (system prompt, tools, metadata), a `system_update` entry when those change, and `message` entries for new user messages only (assistant messages come from the response).

2. **On response** — Clones the response and asynchronously parses it. Handles both JSON and SSE streaming responses, saving parsed SSE chunks.

3. **In-memory cache** — The last 5 API requests are kept in memory via `addApiRequestToCache()` for quick access by the `/issue` command. Both the disk dump and in-memory cache are gated to `USER_TYPE=ant` (Anthropic internal users), except the in-memory cache which always runs (`src/services/api/dumpPrompts.ts:48-57`).

A fingerprinting optimization (`initFingerprint()`) skips the expensive stringify+hash when model, tool names, and system prompt length haven't changed — since these rarely change between turns (`src/services/api/dumpPrompts.ts:74-88`).

## Function Signatures

### logging.ts — Public API

#### `logAPIQuery(params): void`
Logs a `tengu_api_query` event before an API request is sent.
- Key params: `model`, `messagesLength`, `temperature`, `permissionMode`, `querySource`, `effortValue`, `fastMode`

#### `logAPISuccessAndDuration(params): void`
Logs success metrics after an API response. Computes duration, measures content lengths, detects gateways, emits OTel events, and ends the LLM tracing span.
- Key params: `model`, `start`/`startIncludingRetries` (timestamps), `usage`, `costUSD`, `ttftMs`, `stopReason`, `newMessages`, `llmSpan`

#### `logAPIError(params): void`
Logs error details after a failed API request. Classifies the error, detects gateways, emits OTel events, and ends the LLM span.
- Key params: `error`, `model`, `durationMs`, `attempt`, `requestId`, `clientRequestId`

### promptCacheBreakDetection.ts — Public API

#### `recordPromptState(snapshot: PromptStateSnapshot): void`
Phase 1 (pre-call). Records current prompt/tool state and detects what changed from the previous call.

#### `checkResponseForCacheBreak(querySource, cacheReadTokens, cacheCreationTokens, messages, agentId?, requestId?): Promise<void>`
Phase 2 (post-call). Checks if a cache break occurred and diagnoses the cause.

#### `notifyCacheDeletion(querySource, agentId?): void`
Marks that cache edit deletions were sent — suppresses the next cache break warning.

#### `notifyCompaction(querySource, agentId?): void`
Resets the cache read baseline after compaction.

#### `cleanupAgentTracking(agentId): void`
Removes tracking state for a completed agent.

#### `resetPromptCacheBreakDetection(): void`
Clears all tracking state (used in tests).

### dumpPrompts.ts — Public API

#### `createDumpPromptsFetch(agentIdOrSessionId: string): ClientOptions['fetch']`
Returns a fetch wrapper that intercepts and dumps API request/response payloads to disk.

#### `getDumpPromptsPath(agentIdOrSessionId?): string`
Returns the JSONL file path for a given session: `~/.claude/dump-prompts/<id>.jsonl`.

#### `getLastApiRequests(): Array<{ timestamp: string; request: unknown }>`
Returns the in-memory cache of recent API requests (up to 5).

#### `addApiRequestToCache(requestData): void`
Adds a request to the in-memory cache (ant users only for storage, always callable).

#### `clearApiRequestCache(): void` / `clearDumpState(id): void` / `clearAllDumpState(): void`
Cleanup functions for the in-memory cache and per-session dump state.

## Type Definitions

### `NonNullableUsage`
Re-exported from SDK utility types. Represents API usage with all fields guaranteed non-null — `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `server_tool_use`, `service_tier`, `cache_creation`, `inference_geo`, `iterations`, `speed`.

### `GlobalCacheStrategy`
```typescript
type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'
```
Strategy used for global prompt caching. Flips when MCP tools are discovered or removed.

### `PromptStateSnapshot`
Input to `recordPromptState()` — contains `system`, `toolSchemas`, `querySource`, `model`, and optional fields for `fastMode`, `globalCacheStrategy`, `betas`, `autoModeActive`, `isUsingOverage`, `cachedMCEnabled`, `effortValue`, and `extraBodyParams`.

### `EMPTY_USAGE`
A frozen zero-initialized `NonNullableUsage` constant (`src/services/api/emptyUsage.ts:8-22`):

```typescript
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
}
```

This constant is intentionally extracted to its own file to break a circular dependency chain: `logging.ts → errors.ts → messages.ts → BashTool.tsx → ...`. Modules like `bridge/replBridge.ts` can import `EMPTY_USAGE` without pulling in the entire logging dependency tree.

## Configuration & Defaults

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `ANTHROPIC_BASE_URL` | env var | — | Custom API base URL; logged in analytics and used for gateway detection |
| `ANTHROPIC_MODEL` | env var | — | Model override; logged in analytics metadata |
| `ANTHROPIC_SMALL_FAST_MODEL` | env var | — | Small/fast model override; logged in analytics |
| `USER_TYPE` | env var | — | When `ant`, enables prompt dumping to disk and thinking output in tracing |
| `MACRO.BUILD_TIME` | build-time | — | Used to compute `buildAgeMins` in analytics events |
| `MIN_CACHE_MISS_TOKENS` | constant | 2,000 | Minimum absolute token drop to trigger a cache break warning |
| `MAX_TRACKED_SOURCES` | constant | 10 | Cap on tracked query sources to prevent unbounded memory growth |
| `MAX_CACHED_REQUESTS` | constant | 5 | In-memory API request cache size for `/issue` command |
| Cache TTL thresholds | constants | 5min / 1hr | Used to classify unexplained cache breaks as likely TTL expiry |

## Edge Cases & Caveats

- **Gateway detection is best-effort** — it relies on response header prefixes and hostname patterns. Self-hosted gateways without distinctive headers won't be detected. Databricks is detected by hostname only (not headers).

- **Cache break detection excludes haiku** — the `isExcludedModel()` check skips models containing "haiku" because they have different caching behavior.

- **The 5% + 2,000 token threshold** for cache breaks avoids false positives from normal variation, but may miss small legitimate breaks.

- **Prompt dumping defers parsing** — `dumpRequest` runs via `setImmediate` so it doesn't block the API call. This means the dump file may be written slightly after the request completes.

- **Per-tool hash diffing** is only computed when the aggregate tool hash changes — the common case (tools unchanged) skips N extra `jsonStringify` calls.

- **MCP tool names are sanitized** to `'mcp'` in analytics events to prevent leaking user-configured file paths in tool names.

- **`cache_deleted_input_tokens`** is tracked behind the `CACHED_MICROCOMPACT` feature flag and is intentionally not on the public `NonNullableUsage` type.

- **Teleported session tracking** logs the first message outcome (success or error) for sessions teleported from another environment, then stops — it only cares about the first message for reliability metrics.