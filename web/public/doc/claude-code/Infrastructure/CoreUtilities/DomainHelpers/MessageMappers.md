# MessageMappers

## Overview & Responsibilities

MessageMappers is a pair of utility modules in `src/utils/messages/` that handle **bidirectional conversion between internal message representations and SDK-facing message types**, plus construction of the `system/init` message that opens every SDK stream.

Within the broader architecture, this module lives under **Infrastructure → CoreUtilities → DomainHelpers**. It is consumed by the **QueryEngine** (which streams SDK messages to remote clients) and the **REPL bridge** (which sends session metadata on connect). Sibling domain helpers handle hooks, MCP utilities, plugins, and other feature-specific concerns — MessageMappers is narrowly focused on the message serialization boundary.

The module comprises two files:

| File | Lines | Purpose |
|------|-------|---------|
| `mappers.ts` | ~291 | Bidirectional conversion between `Message` (internal) and `SDKMessage` (wire format) |
| `systemInit.ts` | ~97 | Builds the `system/init` SDKMessage carrying session metadata |

## Key Processes

### Internal → SDK Conversion (`toSDKMessages`)

This is the primary outbound path — converting the internal conversation history into the SDK wire format for remote clients (mobile apps, web viewers, bridge sessions).

1. Iterates over the internal `Message[]` array
2. For each message, dispatches on `message.type`:
   - **`assistant`**: Wraps the message through `normalizeAssistantMessageForSDK()` (see below), attaches `session_id` and `uuid`
   - **`user`**: Maps `isMeta`/`isVisibleInTranscriptOnly` to `isSynthetic`, conditionally includes `tool_use_result` for structured tool output
   - **`system` (compact_boundary)**: Converts `compactMetadata` via `toSDKCompactMetadata()`, translating camelCase fields to snake_case
   - **`system` (local_command)**: Only forwards messages containing actual stdout/stderr XML tags (not command-input metadata), converting them to synthetic assistant messages via `localCommandOutputToSDKAssistantMessage()`
3. Unknown message types are silently dropped (returns `[]`)

> Source: `src/utils/messages/mappers.ts:115-181`

### SDK → Internal Conversion (`toInternalMessages`)

The inbound path — used when receiving messages from the SDK (e.g., from remote sessions or session restore).

1. Iterates over `SDKMessage[]`
2. Maps `assistant` messages directly, assigning a fresh timestamp
3. Maps `user` messages, generating a UUID if missing, mapping `isSynthetic` → `isMeta`
4. Maps `system` messages only for the `compact_boundary` subtype, converting snake_case metadata to camelCase via `fromSDKCompactMetadata()`
5. All other message types are dropped

> Source: `src/utils/messages/mappers.ts:26-74`

### Assistant Message Normalization

Before emitting assistant messages to the SDK, `normalizeAssistantMessageForSDK()` performs a targeted fixup:

1. Scans the message's content blocks for `tool_use` blocks
2. If a block targets `ExitPlanModeV2`, injects the current plan content into `tool_input.plan` — because the V2 tool reads the plan from a file at runtime, but SDK consumers expect it inline in the tool input
3. All other blocks pass through unchanged

> Source: `src/utils/messages/mappers.ts:260-290`

### Local Command Output Conversion

Local slash-command output (e.g., `/voice`, `/cost`) needs special handling because the `system/local_command_output` subtype is unknown to several downstream consumers (Android's `SdkMessageTypes.kt`, the `api-go` session-ingress converter). The solution:

1. Strip ANSI escape codes (from chalk formatting)
2. Unwrap the `<local-command-stdout>` / `<local-command-stderr>` XML wrapper tags
3. Wrap the cleaned text in a synthetic `SDKAssistantMessage` using `createAssistantMessage()`, which sets `model: SYNTHETIC_MODEL` and all required fields

> Source: `src/utils/messages/mappers.ts:196-215`

### System Init Message Construction

`buildSystemInitMessage()` assembles the first message emitted on every SDK stream, carrying all session metadata that remote clients need to render their UI:

1. Reads current settings for `outputStyle`
2. Maps tool names through `sdkCompatToolName()` — currently remapping `Agent` → `Task` for backwards compatibility with SDK consumers that haven't migrated
3. Maps MCP server connections to `{ name, status }` pairs
4. Filters commands and skills to only user-invocable ones
5. Resolves the API key source, SDK betas, Claude Code version, and fast mode state
6. Conditionally includes the UDS messaging socket path (behind the `UDS_INBOX` feature gate)

> Source: `src/utils/messages/systemInit.ts:53-96`

## Function Signatures

### `toInternalMessages(messages: readonly DeepImmutable<SDKMessage>[]): Message[]`

Converts SDK messages to internal message format. Drops unknown message types.

### `toSDKMessages(messages: Message[]): SDKMessage[]`

Converts internal messages to SDK wire format. Handles assistant, user, compact boundary, and local command output messages. Drops unknown types.

### `toSDKCompactMetadata(meta: CompactMetadata): SDKCompactMetadata`

Converts internal camelCase compact metadata to SDK snake_case format. Maps `preTokens` → `pre_tokens`, `headUuid` → `head_uuid`, etc.

### `fromSDKCompactMetadata(meta: SDKCompactMetadata): CompactMetadata`

Inverse of `toSDKCompactMetadata`. Converts SDK snake_case to internal camelCase.

### `localCommandOutputToSDKAssistantMessage(rawContent: string, uuid: UUID): SDKAssistantMessage`

Strips ANSI codes and XML wrapper tags from local command output, then wraps it in a synthetic assistant message for SDK consumption.

### `toSDKRateLimitInfo(limits: ClaudeAILimits | undefined): SDKRateLimitInfo | undefined`

Maps internal `ClaudeAILimits` to the SDK-facing `SDKRateLimitInfo`, stripping internal-only fields like `unifiedRateLimitFallbackAvailable`. Conditionally includes optional fields (`resetsAt`, `rateLimitType`, `utilization`, `overageStatus`, etc.) only when defined.

> Source: `src/utils/messages/mappers.ts:221-252`

### `sdkCompatToolName(name: string): string`

Remaps the `Agent` tool name to the legacy `Task` name for SDK backwards compatibility. All other names pass through unchanged. Marked with a TODO to remove in the next minor version.

> Source: `src/utils/messages/systemInit.ts:23-25`

### `buildSystemInitMessage(inputs: SystemInitInputs): SDKMessage`

Builds the `system/init` message containing session metadata. Called from two paths (QueryEngine and REPL bridge) that must produce identical shapes.

> Source: `src/utils/messages/systemInit.ts:53-96`

## Interface / Type Definitions

### `SystemInitInputs`

Input structure for `buildSystemInitMessage()`:

| Field | Type | Description |
|-------|------|-------------|
| `tools` | `ReadonlyArray<{ name: string }>` | Available tools |
| `mcpClients` | `ReadonlyArray<{ name, type }>` | Connected MCP servers |
| `model` | `string` | Active model identifier |
| `permissionMode` | `PermissionMode` | Current permission mode |
| `commands` | `ReadonlyArray<CommandLike>` | Slash commands |
| `agents` | `ReadonlyArray<{ agentType }>` | Available agent types |
| `skills` | `ReadonlyArray<CommandLike>` | Available skills |
| `plugins` | `ReadonlyArray<{ name, path, source }>` | Loaded plugins |
| `fastMode` | `boolean \| undefined` | Fast mode override |

> Source: `src/utils/messages/systemInit.ts:29-39`

### `CommandLike`

Internal type alias: `{ name: string; userInvocable?: boolean }`. Used to filter commands and skills to only those visible to users.

## Edge Cases & Caveats

- **Local command filtering**: Only `system/local_command` messages containing `<local-command-stdout>` or `<local-command-stderr>` tags are forwarded to the SDK. Command-input metadata (e.g., `<command-name>`) is intentionally excluded to prevent leaking to the Remote Control web UI (`src/utils/messages/mappers.ts:160-175`).

- **SDK backwards compatibility**: The `Agent` tool is emitted as `Task` on the wire. This is a temporary compat shim tracked by a TODO — removing it requires a minor version bump because the rename broke SDK consumers on a prior patch release.

- **Synthetic assistant messages**: Local command output is emitted as `assistant` type (not a dedicated system subtype) because Android and api-go ingress don't handle `local_command_output`. The synthetic message uses `SYNTHETIC_MODEL` as the model identifier.

- **ExitPlanModeV2 plan injection**: The plan content is read from file at normalization time and injected into the tool input. If no plan exists, the tool_use block passes through without modification.

- **Feature-gated UDS path**: The `messaging_socket_path` field is only included when the `UDS_INBOX` feature flag is enabled, and is intentionally hidden from public SDK types (cast to `Record<string, unknown>`).

- **Timestamp handling**: `toInternalMessages` assigns `new Date().toISOString()` to all converted messages — the original SDK timestamp is only preserved for user messages that carry one.
