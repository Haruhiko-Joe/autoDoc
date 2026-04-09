# Execution Backends

## Overview & Responsibilities

The Execution Backends module provides four hook execution strategies and their shared utilities within the HooksEngine. It lives under `Infrastructure > CoreUtilities > DomainHelpers > HooksEngine` and is responsible for actually *running* hooks once the hooks engine has determined they should fire.

The four backends are:

| Backend | File | Purpose |
|---------|------|---------|
| **execAgentHook** | `src/utils/hooks/execAgentHook.ts` | Multi-turn LLM agent with tool access |
| **execPromptHook** | `src/utils/hooks/execPromptHook.ts` | Single-turn LLM evaluation |
| **execHttpHook** | `src/utils/hooks/execHttpHook.ts` | HTTP POST to external URLs |
| **ssrfGuard** | `src/utils/hooks/ssrfGuard.ts` | DNS-level SSRF protection for HTTP hooks |
| **hookHelpers** | `src/utils/hooks/hookHelpers.ts` | Shared Zod schema, argument substitution, structured output tooling |

All LLM-based backends (`execAgentHook`, `execPromptHook`) share a common response contract defined in `hookHelpers`: `{ ok: boolean; reason?: string }`. They return a `HookResult` with an outcome of `'success'`, `'blocking'`, `'cancelled'`, or `'non_blocking_error'`.

## Key Processes

### Agent Hook Execution (`execAgentHook`)

The most complex backend — spawns a multi-turn LLM conversation that can use tools to inspect the codebase before making a judgment.

1. **Prompt preparation** — `$ARGUMENTS` placeholders in `hook.prompt` are replaced with the hook's JSON input via `addArgumentsToPrompt()` (`hookHelpers.ts:30-35`)
2. **Timeout setup** — Combines the parent abort signal with a hook-specific timeout (default 60s) using `createCombinedAbortSignal`
3. **Tool filtering** — Starts with the caller's tool set, removes `ALL_AGENT_DISALLOWED_TOOLS` (prevents subagent spawning / plan mode), replaces any existing `SyntheticOutputTool` with one configured for the hook response schema (`execAgentHook.ts:93-105`)
4. **Context construction** — Creates a dedicated `ToolUseContext` with:
   - A unique `hookAgentId`
   - Permission mode set to `'dontAsk'` (non-interactive)
   - Thinking disabled, a session rule allowing reads of the transcript file
   - Model defaults to `getSmallFastModel()` unless overridden by `hook.model`
5. **Structured output enforcement** — Registers a session-level stop hook via `registerStructuredOutputEnforcement()` that rejects any stop attempt that hasn't called `SyntheticOutputTool` (`hookHelpers.ts:70-83`)
6. **Multi-turn loop** — Iterates over `query()` stream events up to `MAX_AGENT_TURNS` (50). On each assistant turn, increments a counter; on receiving a `structured_output` attachment, parses it against `hookResponseSchema` and aborts
7. **Cleanup** — Removes the session stop hook, cleans up signals, and maps the result to `HookResult`

```
execAgentHook.ts:36-339
```

### Prompt Hook Execution (`execPromptHook`)

A lighter-weight alternative — makes a single non-streaming API call and expects a JSON response.

1. **Prompt preparation** — Same `addArgumentsToPrompt()` substitution as the agent hook
2. **Message assembly** — If conversation `messages` are provided, prepends them before the user message (gives the LLM context about what happened)
3. **Model query** — Calls `queryModelWithoutStreaming()` with:
   - A system prompt instructing the model to return `{ ok, reason? }` JSON
   - Thinking disabled, `outputFormat` set to `json_schema` for constrained decoding
   - Default model: `getSmallFastModel()`, default timeout: 30s
4. **Response parsing** — Extracts text content, parses as JSON, validates against `hookResponseSchema()`. Returns `'non_blocking_error'` on parse/validation failure
5. **Result mapping** — `ok: true` → `'success'`, `ok: false` → `'blocking'` with `preventContinuation: true`

```
execPromptHook.ts:21-211
```

### HTTP Hook Execution (`execHttpHook`)

POSTs JSON payloads to user-configured URLs with multiple security layers.

1. **URL allowlist check** — Reads `allowedHttpHookUrls` from merged settings. If defined, the hook URL must match at least one wildcard pattern (uses `*` as glob). Empty array blocks all URLs. Undefined means no restriction. (`execHttpHook.ts:137-145`)
2. **Header construction** — Iterates over `hook.headers`, interpolating `$VAR_NAME` / `${VAR_NAME}` patterns from `process.env`. Only variables listed in both `hook.allowedEnvVars` AND the policy-level `httpHookAllowedEnvVars` are resolved; all others become empty strings. Values are sanitized to strip `\r\n\0` bytes to prevent CRLF header injection. (`execHttpHook.ts:89-108`)
3. **Proxy routing** — Checks for sandbox proxy first (dynamic import of `SandboxManager`), then falls back to environment variable proxy (`HTTP_PROXY` / `HTTPS_PROXY`). When either proxy is active, the SSRF guard is skipped since the proxy handles DNS.
4. **Request dispatch** — Uses `axios.post()` with `maxRedirects: 0`, `validateStatus: () => true` (caller interprets status), and `lookup: ssrfGuardedLookup` when no proxy is active
5. **Result** — Returns `{ ok, statusCode, body, error?, aborted? }` where `ok` is `true` for 2xx status codes

### SSRF Guard (`ssrfGuard`)

Validates DNS resolutions at the socket level to prevent Server-Side Request Forgery.

**Blocked ranges:**

| Range | Reason |
|-------|--------|
| `0.0.0.0/8` | "this" network |
| `10.0.0.0/8` | RFC 1918 private |
| `100.64.0.0/10` | CGNAT / shared address (Alibaba Cloud metadata) |
| `169.254.0.0/16` | Link-local / cloud metadata (AWS, GCP, etc.) |
| `172.16.0.0/12` | RFC 1918 private |
| `192.168.0.0/16` | RFC 1918 private |
| `::` | Unspecified |
| `fc00::/7` | Unique local |
| `fe80::/10` | Link-local |
| `::ffff:<blocked-v4>` | IPv4-mapped IPv6 in blocked range |

**Explicitly allowed:** `127.0.0.0/8` and `::1` (loopback) — local dev servers are a primary HTTP hook use case.

The `ssrfGuardedLookup` function (`ssrfGuard.ts:216-283`) is designed as a drop-in for axios's `lookup` config option. It:
- Short-circuits IP literals without DNS
- Resolves hostnames with `dns.lookup({ all: true })` and validates *every* returned address
- Returns the validated address to axios, which connects directly — no TOCTOU rebinding window

IPv4-mapped IPv6 addresses (e.g., `::ffff:169.254.169.254` or `::ffff:a9fe:a9fe`) are handled by `extractMappedIPv4()`, which fully expands the IPv6 address into 8 hex groups and extracts the embedded IPv4 for delegation to the v4 check (`ssrfGuard.ts:127-204`).

## Function Signatures

### `execAgentHook(hook, hookName, hookEvent, jsonInput, signal, toolUseContext, toolUseID, _messages, agentName?): Promise<HookResult>`

Spawns a multi-turn agent. Parameters:
- **hook** (`AgentHook`): Configuration with `prompt`, optional `model`, optional `timeout` (seconds)
- **jsonInput** (`string`): JSON payload substituted into `$ARGUMENTS`
- **signal** (`AbortSignal`): Parent cancellation signal
- **toolUseContext** (`ToolUseContext`): Provides tools, permissions, app state
- **agentName** (`string?`): For analytics tagging

> `src/utils/hooks/execAgentHook.ts:36-50`

### `execPromptHook(hook, hookName, hookEvent, jsonInput, signal, toolUseContext, messages?, toolUseID?): Promise<HookResult>`

Single-turn LLM evaluation. Parameters:
- **hook** (`PromptHook`): Configuration with `prompt`, optional `model`, optional `timeout` (seconds)
- **messages** (`Message[]?`): Optional conversation history for context

> `src/utils/hooks/execPromptHook.ts:21-30`

### `execHttpHook(hook, _hookEvent, jsonInput, signal?): Promise<{ ok, statusCode?, body, error?, aborted? }>`

HTTP POST to external URL. Parameters:
- **hook** (`HttpHook`): Configuration with `url`, optional `headers`, `allowedEnvVars`, `timeout` (seconds)
- **jsonInput** (`string`): Request body

> `src/utils/hooks/execHttpHook.ts:123-134`

### `ssrfGuardedLookup(hostname, options, callback): void`

Axios-compatible DNS lookup that blocks private/link-local addresses.

> `src/utils/hooks/ssrfGuard.ts:216-283`

### `isBlockedAddress(address: string): boolean`

Returns `true` if the IP is in a blocked range, `false` for allowed (including loopback).

> `src/utils/hooks/ssrfGuard.ts:42-53`

## Shared Utilities (`hookHelpers`)

### `hookResponseSchema`

Lazy-initialized Zod schema: `z.object({ ok: z.boolean(), reason: z.string().optional() })`. Used by both prompt and agent hooks for response validation. (`hookHelpers.ts:16-24`)

### `addArgumentsToPrompt(prompt, jsonInput): string`

Delegates to `substituteArguments()` — replaces `$ARGUMENTS`, `$ARGUMENTS[0]`, `$0`, etc. in the prompt string with values from the JSON input. (`hookHelpers.ts:30-35`)

### `createStructuredOutputTool(): Tool`

Returns a `SyntheticOutputTool` clone with its `inputSchema` replaced by `hookResponseSchema` and a custom prompt instructing the model to call it exactly once. (`hookHelpers.ts:41-64`)

### `registerStructuredOutputEnforcement(setAppState, sessionId): void`

Registers a session-scoped function hook on the `'Stop'` event. When the model tries to stop without having called `SyntheticOutputTool`, the hook injects a message forcing it to do so (with a 5-second timeout). (`hookHelpers.ts:70-83`)

## Configuration & Defaults

| Parameter | Default | Notes |
|-----------|---------|-------|
| Agent hook timeout | 60s | `hook.timeout * 1000`, fallback `60000` |
| Agent max turns | 50 | Hard-coded `MAX_AGENT_TURNS` |
| Prompt hook timeout | 30s | `hook.timeout * 1000`, fallback `30000` |
| HTTP hook timeout | 10 min | Matches `TOOL_HOOK_EXECUTION_TIMEOUT_MS` |
| HTTP max redirects | 0 | No redirect following |
| Default model | `getSmallFastModel()` | All LLM backends; overridable via `hook.model` |

**Settings consumed by HTTP hooks:**
- `allowedHttpHookUrls` — URL allowlist patterns (wildcard `*` supported)
- `httpHookAllowedEnvVars` — Policy-level env var allowlist for header interpolation

## Edge Cases & Caveats

- **Infinite recursion prevention**: Both LLM backends create user messages directly via `createUserMessage()` rather than `processUserInput()`, which would trigger `UserPromptSubmit` hooks and cause recursion.
- **Agent tool restrictions**: Agent hooks filter out `ALL_AGENT_DISALLOWED_TOOLS` — the agent cannot spawn sub-agents or enter plan mode.
- **Proxy bypasses SSRF guard**: When a sandbox proxy or env-var proxy is active, `ssrfGuardedLookup` is not used. The proxy handles DNS resolution, and applying the guard would validate the proxy's IP (often a private address like `10.0.0.1`), breaking corporate proxy setups.
- **IPv4-mapped IPv6 bypass protection**: The SSRF guard fully expands IPv6 addresses and checks for `::ffff:` mapped forms, preventing bypass via hex notation like `::ffff:a9fe:a9fe`.
- **Header injection prevention**: `sanitizeHeaderValue()` strips `\r`, `\n`, and `\0` from interpolated header values to prevent CRLF injection through malicious env vars.
- **Env var exfiltration prevention**: Only env vars explicitly in both the hook's `allowedEnvVars` AND the policy `httpHookAllowedEnvVars` are interpolated; all others silently resolve to empty strings.
- **Agent hook without structured output**: If the agent finishes all turns without calling `SyntheticOutputTool`, the result is `'cancelled'` (not an error), logged silently without surfacing to the user.
- **Structured output deduplication**: `execAgentHook` filters out any pre-existing `SyntheticOutputTool` from the parent context (e.g., from `--json-schema` flag) before adding its own, preventing schema conflicts.