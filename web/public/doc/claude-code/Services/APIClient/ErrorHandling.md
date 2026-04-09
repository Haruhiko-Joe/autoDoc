# Error Handling

## Overview & Responsibilities

The Error Handling module is part of the **APIClient** service within the **Services** layer. It is responsible for three concerns:

1. **Error categorization and user-facing messages** (`errors.ts`) — classifies raw API errors (rate limits, prompt too long, auth failures, overloaded, billing, content moderation, media size, connection issues) into actionable, human-readable messages shown to the user.
2. **Connection/SSL error extraction** (`errorUtils.ts`) — walks the `cause` chain of errors from the Anthropic SDK to surface root-cause connection and SSL/TLS error codes, then formats them into clear diagnostic messages.
3. **Retry logic with exponential backoff** (`withRetry.ts`) — wraps API calls in a configurable retry loop that handles 429 rate limits, 529 overloaded errors, fast-mode cooldown/fallback, credential refresh on 401/403, context overflow adjustments, abort signal support, and a persistent unattended retry mode.

Together, these files ensure that transient API failures are retried intelligently and that unrecoverable errors are presented to the user with enough context to take action.

## Key Processes

### Error Classification Flow (`errors.ts`)

The central function `getAssistantMessageFromError()` (`src/services/api/errors.ts:425-933`) converts a raw error into an `AssistantMessage` that the UI can display. It checks errors in priority order:

1. **Timeout** — SDK `APIConnectionTimeoutError` or timeout-containing connection errors → "Request timed out"
2. **Image size/resize** — `ImageSizeError` or `ImageResizeError` thrown during pre-API validation
3. **Rate limit (429)** — inspects unified rate-limit headers (`anthropic-ratelimit-unified-*`) to build a detailed message with reset times and overage status. Falls back to extracting the inner JSON message for non-quota 429s (e.g., long-context entitlement rejections).
4. **Prompt too long** — case-insensitive match on "prompt is too long"; stores raw error in `errorDetails` for reactive compact's token-gap parser
5. **PDF errors** — page-limit, password-protected, and invalid PDF detection with interactive vs. non-interactive hint variants
6. **Image errors** — single image size exceeded, many-image dimension exceeded
7. **Request too large (413)** — overall payload limit
8. **Tool use mismatches (400)** — tool_use/tool_result pairing errors, duplicate tool IDs, with `/rewind` recovery guidance
9. **Invalid model (400)** — subscription-specific messages; 3P users get fallback model suggestions
10. **Billing** — credit balance too low
11. **Authentication (401/403)** — API key invalid, OAuth token revoked, org not allowed, CCR mode transient errors
12. **Bedrock/Vertex model access** — model ID errors with provider-specific guidance
13. **Connection errors** — delegates to `formatAPIError()` for SSL-specific messages
14. **Fallback** — generic "API Error: \<message\>"

A parallel function `classifyAPIError()` (`src/services/api/errors.ts:965-1161`) maps errors to analytics tag strings (e.g., `'rate_limit'`, `'prompt_too_long'`, `'ssl_cert_error'`) for Datadog tracking.

### Connection Error Extraction Flow (`errorUtils.ts`)

`extractConnectionErrorDetails()` (`src/services/api/errorUtils.ts:42-83`) walks the error's `.cause` chain (up to 5 levels deep) looking for an `Error` with a `.code` string property. It classifies the code against a set of ~20 known OpenSSL error codes (`SSL_ERROR_CODES`) and returns a `ConnectionErrorDetails` object with `{ code, message, isSSLError }`.

`formatAPIError()` (`src/services/api/errorUtils.ts:200-260`) uses these details to produce specific messages:
- `ETIMEDOUT` → internet/proxy hint
- SSL errors → per-code messages (verification failed, expired, revoked, self-signed, hostname mismatch)
- `Connection error.` with a code → includes the code for debugging
- Deserialized errors (from session JSONL resume) → extracts nested message from Bedrock/Anthropic shapes via `extractNestedErrorMessage()`
- HTML responses (e.g., CloudFlare error pages) → strips HTML, extracts `<title>`

`getSSLErrorHint()` (`src/services/api/errorUtils.ts:94-100`) provides a standalone SSL hint for non-API-client contexts (e.g., OAuth token exchange), suggesting `NODE_EXTRA_CA_CERTS` and `/doctor`.

### Retry Loop Flow (`withRetry.ts`)

`withRetry()` (`src/services/api/withRetry.ts:170-517`) is an `AsyncGenerator` that yields `SystemAPIErrorMessage` objects (displayed in the UI as retry status) and returns the operation result on success. The flow per attempt:

1. **Abort check** — if `signal.aborted`, throw `APIUserAbortError`
2. **Mock rate limits** — for internal (ant) users, check `/mock-limits` test overrides
3. **Client refresh** — get a fresh Anthropic client on first attempt or after auth errors (401, 403 token revoked, Bedrock/Vertex credential failures, stale ECONNRESET/EPIPE connections)
4. **Execute operation** — call `operation(client, attempt, retryContext)` and return on success
5. **On error**, evaluate in order:
   - **Fast-mode fallback** (429/529 when fast mode was active): short retry-after (<20s) → sleep and retry with same model; long retry-after → trigger cooldown (min 10 min, default 30 min), switch to standard speed. Overage-disabled → permanently disable fast mode.
   - **Fast-mode rejection** (400 "Fast mode is not enabled") → permanently disable, retry standard
   - **Background 529 drop** — non-foreground query sources (summaries, classifiers, titles) bail immediately to avoid retry amplification during capacity cascades
   - **529 fallback tracking** — after `MAX_529_RETRIES` (3) consecutive 529s, trigger `FallbackTriggeredError` if a fallback model is configured, or throw `CannotRetryError` with a "Repeated 529 Overloaded errors" message
   - **Persistent retry** (unattended sessions via `CLAUDE_CODE_UNATTENDED_RETRY`) — 429/529 errors retry indefinitely with up to 5-minute backoff, capped at 6 hours. Yields heartbeat messages every 30 seconds to prevent the host from marking the session idle.
   - **Cloud credential errors** — clear AWS/GCP credential caches and retry
   - **Context overflow (400)** — parse "input length and `max_tokens` exceed context limit" message, compute adjusted `maxTokensOverride`, and retry with reduced output tokens (floor: 3000)
   - **Normal backoff** — exponential delay starting at 500ms (`BASE_DELAY_MS * 2^(attempt-1)`) with 25% jitter, capped at 32s. Honors `Retry-After` header when present. Yields a `SystemAPIErrorMessage` before sleeping.
6. **Exhausted retries** → throw `CannotRetryError` wrapping the original error and retry context

## Function Signatures

### `errors.ts` — Key Exports

#### `getAssistantMessageFromError(error, model, options?): AssistantMessage`
Converts any error into a user-facing `AssistantMessage`. The main error-to-UI-message mapper.
- **error**: The caught error (any type)
- **model**: Current model name string (used for model-specific guidance)
- **options.messages / options.messagesForAPI**: Optional message arrays for tool_use mismatch diagnostics

> `src/services/api/errors.ts:425-933`

#### `classifyAPIError(error): string`
Returns a standardized error type tag for analytics (e.g., `'rate_limit'`, `'prompt_too_long'`, `'ssl_cert_error'`, `'unknown'`).

> `src/services/api/errors.ts:965-1161`

#### `categorizeRetryableAPIError(error: APIError): SDKAssistantMessageError`
Categorizes retryable API errors for the Agent SDK interface. Returns `'rate_limit'`, `'authentication_failed'`, `'server_error'`, or `'unknown'`.

> `src/services/api/errors.ts:1163-1182`

#### `parsePromptTooLongTokenCounts(rawMessage): { actualTokens, limitTokens }`
Parses token counts from a "prompt is too long: N tokens > M maximum" message. Used by reactive compact to calculate the over-limit gap.

> `src/services/api/errors.ts:85-96`

#### `getErrorMessageIfRefusal(stopReason, model): AssistantMessage | undefined`
Returns a usage-policy refusal message when `stopReason === 'refusal'`.

> `src/services/api/errors.ts:1184-1207`

### `errorUtils.ts` — Key Exports

#### `extractConnectionErrorDetails(error): ConnectionErrorDetails | null`
Walks the `.cause` chain (max 5 deep) to find the root error code. Returns `{ code, message, isSSLError }` or `null`.

> `src/services/api/errorUtils.ts:42-83`

#### `formatAPIError(error: APIError): string`
Produces a human-readable string from an `APIError`, handling SSL errors, timeouts, connection errors, HTML responses, and deserialized JSONL errors.

> `src/services/api/errorUtils.ts:200-260`

#### `getSSLErrorHint(error): string | null`
Returns a one-liner SSL hint for contexts outside the main API client (e.g., OAuth), or `null` if not an SSL error.

> `src/services/api/errorUtils.ts:94-100`

#### `sanitizeAPIError(apiError: APIError): string`
Strips HTML content (e.g., CloudFlare pages) from an API error message, extracting the `<title>` if present.

> `src/services/api/errorUtils.ts:122-130`

### `withRetry.ts` — Key Exports

#### `withRetry<T>(getClient, operation, options): AsyncGenerator<SystemAPIErrorMessage, T>`
The core retry wrapper. An async generator that yields retry status messages and returns the operation result.
- **getClient**: `() => Promise<Anthropic>` — factory for fresh SDK clients (called on first attempt and after auth errors)
- **operation**: `(client, attempt, context) => Promise<T>` — the API call to execute
- **options**: `RetryOptions` — configuration including `maxRetries`, `model`, `fallbackModel`, `thinkingConfig`, `fastMode`, `signal` (AbortSignal), `querySource`, `initialConsecutive529Errors`

> `src/services/api/withRetry.ts:170-517`

#### `getRetryDelay(attempt, retryAfterHeader?, maxDelayMs?): number`
Computes delay in ms: honors `Retry-After` header if present, otherwise uses exponential backoff (`500ms * 2^(attempt-1)` + 25% jitter, capped at `maxDelayMs` defaulting to 32s).

> `src/services/api/withRetry.ts:530-548`

#### `is529Error(error): boolean`
Detects overloaded errors by status 529 or `"type":"overloaded_error"` in the message (workaround for SDK streaming bug).

> `src/services/api/withRetry.ts:610-621`

## Interface/Type Definitions

### `ConnectionErrorDetails` (`src/services/api/errorUtils.ts:31-35`)

| Field | Type | Description |
|-------|------|-------------|
| code | string | Error code from the root cause (e.g., `CERT_HAS_EXPIRED`, `ECONNRESET`) |
| message | string | Error message from the root cause |
| isSSLError | boolean | Whether the code is a known SSL/TLS error |

### `RetryContext` (`src/services/api/withRetry.ts:120-125`)

Mutable context passed to the operation on each attempt:

| Field | Type | Description |
|-------|------|-------------|
| model | string | Current model name |
| thinkingConfig | ThinkingConfig | Thinking/budget configuration |
| maxTokensOverride? | number | Set when context overflow triggers a token reduction |
| fastMode? | boolean | Whether fast mode is active for this attempt |

### `RetryOptions` (`src/services/api/withRetry.ts:127-142`)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | — | Primary model name |
| maxRetries? | number | 10 | Max retry attempts |
| fallbackModel? | string | — | Model to fall back to after repeated 529s |
| thinkingConfig | ThinkingConfig | — | Thinking budget config |
| fastMode? | boolean | — | Whether to attempt fast mode |
| signal? | AbortSignal | — | Cancellation signal |
| querySource? | QuerySource | — | Source tag for 529 retry eligibility |
| initialConsecutive529Errors? | number | 0 | Pre-seed 529 counter (used for streaming fallback) |

### `CannotRetryError` (`src/services/api/withRetry.ts:144-158`)
Thrown when retries are exhausted or the error is non-retryable. Wraps the original error and the `RetryContext`.

### `FallbackTriggeredError` (`src/services/api/withRetry.ts:160-168`)
Thrown when `MAX_529_RETRIES` consecutive 529 errors trigger a model fallback. Contains `originalModel` and `fallbackModel`.

## Configuration & Defaults

| Constant / Env Var | Value | Location | Description |
|---|---|---|---|
| `DEFAULT_MAX_RETRIES` | 10 | `src/services/api/withRetry.ts:52` | Default max retry attempts |
| `CLAUDE_CODE_MAX_RETRIES` | env var | `src/services/api/withRetry.ts:790` | Override max retries |
| `BASE_DELAY_MS` | 500ms | `src/services/api/withRetry.ts:55` | Base delay for exponential backoff |
| Max backoff | 32s | `src/services/api/withRetry.ts:534` | Default cap for retry delay |
| `MAX_529_RETRIES` | 3 | `src/services/api/withRetry.ts:54` | Consecutive 529s before fallback |
| `SHORT_RETRY_THRESHOLD_MS` | 20s | `src/services/api/withRetry.ts:800` | Fast-mode: retry-after below this keeps fast mode |
| `MIN_COOLDOWN_MS` | 10 min | `src/services/api/withRetry.ts:801` | Minimum fast-mode cooldown duration |
| `DEFAULT_FAST_MODE_FALLBACK_HOLD_MS` | 30 min | `src/services/api/withRetry.ts:799` | Default fast-mode cooldown when no retry-after |
| `FLOOR_OUTPUT_TOKENS` | 3000 | `src/services/api/withRetry.ts:53` | Minimum output tokens for context overflow adjustment |
| `CLAUDE_CODE_UNATTENDED_RETRY` | env var | `src/services/api/withRetry.ts:100` | Enable persistent (indefinite) retry for unattended sessions |
| `PERSISTENT_MAX_BACKOFF_MS` | 5 min | `src/services/api/withRetry.ts:96` | Max backoff in persistent mode |
| `PERSISTENT_RESET_CAP_MS` | 6 hours | `src/services/api/withRetry.ts:97` | Absolute cap on persistent wait time |
| `HEARTBEAT_INTERVAL_MS` | 30s | `src/services/api/withRetry.ts:98` | Heartbeat yield interval during persistent waits |

## Edge Cases & Caveats

- **Deserialized errors lack `.message`**: When errors are loaded from session JSONL (e.g., `--resume`), the SDK `APIError` loses its `.message`. Both `formatAPIError()` and `getAssistantMessageFromError()` handle this by checking nested error shapes at two levels (Bedrock vs. standard Anthropic) and providing safe fallbacks.

- **SDK 529 status bug**: The Anthropic SDK sometimes fails to propagate the 529 status code during streaming. `is529Error()` also checks for `"type":"overloaded_error"` in the error message as a workaround.

- **HTML in error messages**: CloudFlare and other proxies may return HTML error pages. `sanitizeMessageHTML()` detects `<!DOCTYPE html` or `<html` and extracts the `<title>` content instead.

- **Background query sources skip 529 retry**: Non-foreground queries (summaries, titles, suggestions) throw `CannotRetryError` immediately on 529 to prevent retry amplification during capacity cascades — each retry causes 3-10x gateway amplification.

- **Fast-mode cooldown preserves prompt cache**: When fast mode hits a short retry-after (<20s), the retry keeps the same model name to preserve prompt cache. Only longer delays trigger a model switch.

- **Context overflow adjustment is backward-compat**: The `maxTokensOverride` path handles the legacy 400 error for context window overflow. With the extended-context-window beta, the API returns a `model_context_window_exceeded` stop reason instead, but the retry logic is kept for backward compatibility.

- **Stale keep-alive connections**: ECONNRESET/EPIPE errors (from HTTP keep-alive socket reuse) trigger `disableKeepAlive()` and a fresh client connection on the next attempt, gated behind a feature flag.

- **Persistent retry heartbeats**: In unattended mode, long waits are chunked into 30-second intervals. Each chunk yields a `SystemAPIErrorMessage` so the host environment doesn't mark the session as idle. The for-loop `attempt` counter is clamped to prevent termination while a separate `persistentAttempt` counter tracks the true attempt count for backoff calculation.

- **Rate limit reset awareness**: For persistent 429 retries, `getRateLimitResetDelayMs()` reads the `anthropic-ratelimit-unified-reset` header (Unix timestamp) and waits until the exact reset time rather than polling with backoff.