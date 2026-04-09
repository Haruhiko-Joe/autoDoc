# MessageClient

## Overview & Responsibilities

The MessageClient module is the core API communication layer within the **Services > APIClient** subsystem of Claude Code. It is responsible for two fundamental concerns:

1. **SDK Client Instantiation** (`client.ts`): Creating properly authenticated Anthropic SDK client instances for four distinct providers — direct API, AWS Bedrock, GCP Vertex AI, and Azure Foundry.
2. **Message Sending** (`claude.ts`): The main `queryModel` function that orchestrates the entire API request lifecycle — building system prompts, serializing tool schemas, selecting model parameters and beta headers, streaming responses, handling retries and non-streaming fallbacks, and normalizing the response into internal message types.

This module sits between the QueryEngine (which drives the conversation loop) and the external Anthropic API. Every LLM request in Claude Code — from the main REPL conversation to subagent queries, compaction summaries, and memory extraction — flows through these two files.

## Key Processes

### SDK Client Creation Flow (`client.ts`)

The `getAnthropicClient()` function creates an authenticated Anthropic SDK instance. The provider is selected by environment variables:

1. **Common setup** (all providers): Build default headers (`x-app`, `User-Agent`, session ID, container ID, remote session ID), check OAuth token freshness, configure API key headers for non-subscriber users, and wrap `fetch` to inject `x-client-request-id` UUIDs for request correlation (`src/services/api/client.ts:88-152`).

2. **Provider selection** via environment flags, checked in order:
   - `CLAUDE_CODE_USE_BEDROCK` → `AnthropicBedrock` with AWS region selection, credential refresh, and optional bearer token auth (`src/services/api/client.ts:153-190`)
   - `CLAUDE_CODE_USE_FOUNDRY` → `AnthropicFoundry` with Azure AD token provider or API key (`src/services/api/client.ts:191-220`)
   - `CLAUDE_CODE_USE_VERTEX` → `AnthropicVertex` with GCP credential refresh, `GoogleAuth` instantiation, and region-per-model routing (`src/services/api/client.ts:221-298`)
   - Default → Direct `Anthropic` client with API key or OAuth `authToken` for Claude.ai subscribers (`src/services/api/client.ts:300-316`)

3. **Auth skipping**: Each cloud provider supports a `CLAUDE_CODE_SKIP_*_AUTH` env var for testing/proxy scenarios that provides mock credentials.

### Custom Headers and Fetch Wrapping

`getCustomHeaders()` parses the `ANTHROPIC_CUSTOM_HEADERS` environment variable — a newline-separated list of `Name: Value` pairs — and merges them into default request headers (`src/services/api/client.ts:330-354`).

`buildFetch()` wraps the fetch function to inject a `x-client-request-id` UUID header on each request (first-party API only). This allows correlating client-side timeouts with server logs even when no server request ID is returned (`src/services/api/client.ts:358-389`).

### Main Query Flow (`claude.ts:queryModel`)

The `queryModel` async generator (~900 lines) is the heart of the module. It:

1. **Pre-flight checks**: Verifies the "off-switch" feature flag for Opus models, resolves Bedrock inference profile backing models (`src/services/api/claude.ts:1031-1062`).

2. **Beta header assembly**: Merges model-specific betas, advisor beta, tool search beta, prompt caching scope, structured outputs, fast mode, AFK mode, cache editing, and context management betas. Many headers use a "sticky-on latch" pattern — once first sent in a session, they remain for all subsequent requests to avoid busting the server-side prompt cache (`src/services/api/claude.ts:1405-1456`).

3. **Tool schema building**: Filters tools based on tool search state, builds API schemas with `defer_loading` for deferred tools, injects advisor server tool if enabled (`src/services/api/claude.ts:1064-1396`).

4. **Message normalization**: Normalizes internal messages to API format, strips tool-search-specific fields for unsupported models, repairs tool_use/tool_result pairing, strips advisor blocks if beta is absent, and limits media items to the API maximum of 100 (`src/services/api/claude.ts:1259-1315`).

5. **System prompt construction**: Prepends attribution header and CLI system prompt prefix, appends advisor and Chrome tool search instructions (`src/services/api/claude.ts:1358-1379`).

6. **Parameter assembly** (`paramsFromContext`): Builds the full `BetaMessageStreamParams` including model, messages with cache breakpoints, system prompt blocks, tool schemas, thinking configuration (adaptive vs. budget), effort level, task budget, fast mode speed, temperature, context management, and extra body params (`src/services/api/claude.ts:1538-1729`).

7. **Streaming execution**: Creates a streaming request via `withRetry`, iterates SSE events (`message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`), accumulates content blocks, tracks usage and cost, and yields `StreamEvent` and `AssistantMessage` objects (`src/services/api/claude.ts:1776-2304`).

8. **Non-streaming fallback**: If streaming fails (network errors, idle timeout, 404), falls back to a non-streaming request via `executeNonStreamingRequest` with its own retry loop (`src/services/api/claude.ts:2404-2570`).

9. **Post-response**: Checks for prompt cache breaks, extracts quota status from headers, logs success metrics, tracks request IDs for cache eviction hints on shutdown (`src/services/api/claude.ts:2382-2892`).

### Streaming Idle Watchdog

A configurable timeout mechanism (`CLAUDE_ENABLE_STREAM_WATCHDOG`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS` defaulting to 90s) detects hung streams where no SSE chunks arrive. At half the timeout it emits a warning; at the full timeout it aborts the stream and triggers the non-streaming fallback (`src/services/api/claude.ts:1868-1928`).

### Prompt Caching

Cache breakpoints are placed on the last message (or second-to-last for `skipCacheWrite` fork queries) via `addCacheBreakpoints()`. The module supports:

- **1-hour cache TTL** for eligible users (Anthropic employees or non-overage subscribers), gated by a GrowthBook allowlist per query source (`src/services/api/claude.ts:393-434`)
- **Global cache scope** for system prompts when no MCP tools are present (`src/services/api/claude.ts:1207-1229`)
- **Cache editing** (cached microcompact) that inserts `cache_edits` blocks with delete operations and `cache_reference` tags on tool_result blocks (`src/services/api/claude.ts:3063-3211`)

### Thinking Configuration

The module selects between two thinking modes based on model capabilities (`src/services/api/claude.ts:1601-1630`):

- **Adaptive thinking** (`type: 'adaptive'`): Used for models that support it; no budget is specified.
- **Budget-based thinking** (`type: 'enabled'`): For older models; the budget is the lesser of the model's default thinking budget and `maxOutputTokens - 1`.

Thinking is globally disableable via `CLAUDE_CODE_DISABLE_THINKING` and adaptive thinking specifically via `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`.

## Function Signatures

### `getAnthropicClient(options): Promise<Anthropic>`

Creates an authenticated Anthropic SDK client instance.

| Parameter | Type | Description |
|-----------|------|-------------|
| `apiKey` | `string?` | Optional API key override |
| `maxRetries` | `number` | SDK-level retry count (usually 0; retries are handled manually) |
| `model` | `string?` | Model name, used for region selection on Bedrock/Vertex |
| `fetchOverride` | `ClientOptions['fetch']?` | Custom fetch implementation |
| `source` | `string?` | Caller identifier for request logging |

> Source: `src/services/api/client.ts:88-100`

### `queryModelWithStreaming(params): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage>`

Public streaming entry point. Wraps `queryModel` with VCR recording support.

> Source: `src/services/api/claude.ts:752-780`

### `queryModelWithoutStreaming(params): Promise<AssistantMessage>`

Public non-streaming entry point. Consumes the streaming generator and returns the final assistant message.

> Source: `src/services/api/claude.ts:709-750`

### `executeNonStreamingRequest(clientOptions, retryOptions, paramsFromContext, onAttempt, captureRequest, originatingRequestId?): AsyncGenerator<SystemAPIErrorMessage, BetaMessage>`

Helper generator for non-streaming API requests with retry. Used as the fallback path when streaming fails.

> Source: `src/services/api/claude.ts:818-917`

### `queryHaiku(params): Promise<AssistantMessage>`

Convenience wrapper that queries the small/fast model (Haiku) with no tools and no thinking.

> Source: `src/services/api/claude.ts:3241-3291`

### `queryWithModel(params): Promise<AssistantMessage>`

Queries a specific model through the full Claude Code pipeline (authentication, betas, headers).

> Source: `src/services/api/claude.ts:3300-3348`

### `verifyApiKey(apiKey, isNonInteractiveSession): Promise<boolean>`

Validates an API key by making a minimal request to the Haiku model. Returns `false` for authentication errors, throws for other errors.

> Source: `src/services/api/claude.ts:530-586`

### `getExtraBodyParams(betaHeaders?): JsonObject`

Assembles extra body parameters from the `CLAUDE_CODE_EXTRA_BODY` env var and beta headers (primarily for Bedrock).

> Source: `src/services/api/claude.ts:272-331`

### `getPromptCachingEnabled(model): boolean`

Returns whether prompt caching is enabled for the given model, considering global and per-model disable flags.

> Source: `src/services/api/claude.ts:333-356`

### `getMaxOutputTokensForModel(model): number`

Returns the effective max output tokens, considering the model's native limit, the optional slot-reservation cap (8k), and the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env var override.

> Source: `src/services/api/claude.ts:3399-3419`

### `updateUsage(usage, partUsage): NonNullableUsage`

Updates cumulative usage statistics from streaming API events. Handles the semantic that input token fields should only be updated when non-zero (to avoid `message_delta` overwriting `message_start` values).

> Source: `src/services/api/claude.ts:2924-2987`

### `accumulateUsage(totalUsage, messageUsage): NonNullableUsage`

Sums usage across multiple assistant turns for cumulative tracking.

> Source: `src/services/api/claude.ts:2993-3038`

### `addCacheBreakpoints(messages, enablePromptCaching, querySource?, ...): MessageParam[]`

Converts internal messages to API `MessageParam` format, inserting cache control markers on the appropriate message and optionally inserting `cache_edits` blocks for cached microcompact.

> Source: `src/services/api/claude.ts:3063-3211`

### `buildSystemPromptBlocks(systemPrompt, enablePromptCaching, options?): TextBlockParam[]`

Splits the system prompt into text blocks with cache control markers, respecting global cache scope settings.

> Source: `src/services/api/claude.ts:3213-3237`

## Key Type Definitions

### `Options`

The main configuration object passed to `queryModel`. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Model identifier |
| `querySource` | `QuerySource` | Identifies the caller (e.g., `repl_main_thread`, `agent:*`, `sdk`) |
| `tools` / `mcpTools` | `Tools` | Available tool definitions |
| `toolChoice` | `BetaToolChoiceTool \| BetaToolChoiceAuto` | Tool selection strategy |
| `fallbackModel` | `string?` | Model to fall back to on 529 overload |
| `effortValue` | `EffortValue?` | Thinking effort level |
| `fastMode` | `boolean?` | Enable fast output mode |
| `advisorModel` | `string?` | Model for server-side advisor tool |
| `taskBudget` | `{ total, remaining? }?` | API-side token budget for pacing |
| `outputFormat` | `BetaJSONOutputFormat?` | Structured output JSON schema |
| `enablePromptCaching` | `boolean?` | Override prompt caching (auto-detected from model otherwise) |
| `agents` | `AgentDefinition[]` | Available agent definitions for tool schema building |
| `skipCacheWrite` | `boolean?` | Shift cache marker for fork queries |

> Source: `src/services/api/claude.ts:676-707`

## Configuration & Defaults

### Client Configuration (`client.ts`)

| Env Variable | Provider | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Direct | API key for direct access |
| `CLAUDE_CODE_USE_BEDROCK` | Bedrock | Enable AWS Bedrock provider |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | Bedrock | AWS region (default: `us-east-1`) |
| `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION` | Bedrock | Region override for Haiku model |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock | Bearer token for API key auth |
| `CLAUDE_CODE_USE_VERTEX` | Vertex | Enable GCP Vertex provider |
| `ANTHROPIC_VERTEX_PROJECT_ID` | Vertex | GCP project ID |
| `CLOUD_ML_REGION` | Vertex | Default GCP region (fallback: `us-east5`) |
| `CLAUDE_CODE_USE_FOUNDRY` | Foundry | Enable Azure Foundry provider |
| `ANTHROPIC_FOUNDRY_RESOURCE` | Foundry | Azure resource name |
| `ANTHROPIC_FOUNDRY_BASE_URL` | Foundry | Full base URL (alternative to resource) |
| `ANTHROPIC_FOUNDRY_API_KEY` | Foundry | Azure API key (alternative to AD auth) |
| `ANTHROPIC_CUSTOM_HEADERS` | All | Newline-separated custom headers in `Name: Value` format |
| `API_TIMEOUT_MS` | All | Client timeout (default: 600s) |
| `CLAUDE_CODE_ADDITIONAL_PROTECTION` | All | Send additional protection header |

### Query Configuration (`claude.ts`)

| Env Variable | Description | Default |
|---|---|---|
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Override max output tokens | Model-dependent |
| `CLAUDE_CODE_EXTRA_BODY` | JSON object merged into API request body | — |
| `CLAUDE_CODE_EXTRA_METADATA` | JSON object merged into API metadata | — |
| `DISABLE_PROMPT_CACHING` | Globally disable prompt caching | `false` |
| `DISABLE_PROMPT_CACHING_HAIKU` | Disable caching for Haiku | `false` |
| `DISABLE_PROMPT_CACHING_SONNET` | Disable caching for Sonnet | `false` |
| `DISABLE_PROMPT_CACHING_OPUS` | Disable caching for Opus | `false` |
| `CLAUDE_CODE_DISABLE_THINKING` | Disable extended thinking | `false` |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | Force budget-based thinking | `false` |
| `CLAUDE_ENABLE_STREAM_WATCHDOG` | Enable idle stream timeout | `false` |
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | Idle timeout duration | `90000` |
| `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` | Skip non-streaming fallback on stream errors | `false` |
| `ENABLE_PROMPT_CACHING_1H_BEDROCK` | Opt-in 1h cache TTL for 3P Bedrock | `false` |

### Key Constants

- `MAX_NON_STREAMING_TOKENS`: `64,000` — cap for non-streaming fallback requests (`src/services/api/claude.ts:3354`)
- `STALL_THRESHOLD_MS`: `30,000` — threshold for detecting streaming stalls (`src/services/api/claude.ts:1936`)
- `API_MAX_MEDIA_PER_REQUEST`: `100` — maximum media items per request (imported from `src/constants/apiLimits.ts`)

## Edge Cases & Caveats

- **Beta header latching**: Once a beta header (fast mode, AFK mode, cache editing) is first sent in a session, it continues for all subsequent requests. This prevents mid-session cache key changes that would bust ~50-70K tokens of cached prompt. Latches are cleared on `/clear` and `/compact`.

- **Non-streaming fallback risks**: The fallback to non-streaming after a streaming failure can cause double tool execution when streaming tool execution is active (the partial stream starts a tool, then the non-streaming retry produces the same `tool_use`). This is mitigated by the `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` flag and the `tengu_disable_streaming_to_non_streaming_fallback` feature gate.

- **Stream resource leaks**: The `Response` object holds native TLS/socket buffers outside the V8 heap. The module explicitly cancels and releases stream resources in `finally` blocks and on normal completion to prevent memory leaks (related to GH #32920).

- **Vertex auth timeout**: Without the `ANTHROPIC_VERTEX_PROJECT_ID` fallback, `GoogleAuth` attempts a metadata server lookup that causes a 12-second timeout outside GCP environments (`src/services/api/client.ts:240-288`).

- **Usage tracking semantics**: The streaming API provides cumulative usage totals, not incremental deltas. Input token fields from `message_delta` events may send explicit 0 values that must not overwrite values from `message_start` (`src/services/api/claude.ts:2914-2987`).

- **Media item limit**: The API rejects requests with more than 100 media items. Rather than erroring, the module silently strips the oldest media items to stay within limits (`src/services/api/claude.ts:956-1015`).

- **Temperature constraint**: When extended thinking is enabled, temperature must be 1 (the API default), so the module omits the temperature parameter entirely in that case (`src/services/api/claude.ts:1693-1695`).

- **Off-switch**: A GrowthBook feature flag (`tengu-off-switch`) can disable Opus model queries for non-subscriber users. This check runs before any API call (`src/services/api/claude.ts:1031-1049`).

- **404 streaming fallback**: Some gateways return 404 for streaming endpoints but work with non-streaming. The module detects 404 errors during stream creation and automatically falls back (`src/services/api/claude.ts:2612-2749`).

- **Remote session timeouts**: Non-streaming fallback defaults to 120s for remote sessions (vs. 300s normally) to stay under the container idle-kill threshold (~5min) (`src/services/api/claude.ts:807-811`).