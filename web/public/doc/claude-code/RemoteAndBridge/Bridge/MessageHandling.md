# MessageHandling

## Overview & Responsibilities

The MessageHandling module is the shared message-processing layer used by both the env-based and env-less bridge cores within the **Bridge** subsystem of the **RemoteAndBridge** architecture. It sits between the raw WebSocket/SSE transport and the REPL query engine, responsible for:

- Parsing and routing inbound WebSocket/SSE data (user messages, control responses, control requests)
- Deduplicating echo and re-delivered messages via a ring-buffer UUID set
- Processing server-initiated control requests (initialize, set_model, interrupt, permission mode)
- Extracting and normalizing content from inbound user messages, including image blocks
- Resolving file attachments uploaded via the web composer by downloading them to local disk
- Defining the permission callback interface for bridging tool-approval prompts to claude.ai
- Building result/completion events for session archival

The module is intentionally **pure** — no closure over bridge-specific state. All collaborators (transport, session ID, UUID sets, callbacks) are passed as parameters, enabling both `initBridgeCore` (env-based) and `initEnvLessBridgeCore` to share the same logic.

The four source files are:

| File | Lines | Role |
|------|-------|------|
| `src/bridge/bridgeMessaging.ts` | ~460 | Transport-layer helpers: ingress routing, control request handling, result messages, echo dedup |
| `src/bridge/inboundMessages.ts` | ~80 | Extracts and normalizes content from inbound user messages including image blocks |
| `src/bridge/inboundAttachments.ts` | ~175 | Resolves `file_uuid` attachments by downloading from the OAuth files API to local disk |
| `src/bridge/bridgePermissionCallbacks.ts` | ~43 | Defines `BridgePermissionCallbacks` interface and validates permission response payloads |

## Key Processes

### Ingress Message Routing

The central entry point is `handleIngressMessage` (`src/bridge/bridgeMessaging.ts:132-208`), which parses raw WebSocket data and dispatches to the appropriate handler:

1. JSON-parse the raw string and normalize control message keys via `normalizeControlMessageKeys`
2. Check if it's a `control_response` — if so, route to the permission response handler and return
3. Check if it's a `control_request` — if so, route to the control request handler and return
4. Validate it's a well-formed `SDKMessage` via the `isSDKMessage` type guard
5. **Echo dedup**: if the message UUID exists in `recentPostedUUIDs` (messages we sent), skip it
6. **Re-delivery dedup**: if the UUID exists in `recentInboundUUIDs` (messages we already processed), skip it
7. For `user` type messages, record the UUID in `recentInboundUUIDs`, log an analytics event, and fire-and-forget the `onInboundMessage` callback

Three type guards support this routing:

- `isSDKMessage` (`src/bridge/bridgeMessaging.ts:36-43`) — checks for a non-null object with a string `type` field
- `isSDKControlResponse` (`src/bridge/bridgeMessaging.ts:46-56`) — checks `type === 'control_response'` and presence of `response`
- `isSDKControlRequest` (`src/bridge/bridgeMessaging.ts:59-70`) — checks `type === 'control_request'` and presence of `request_id` and `request`

### Server Control Request Handling

`handleServerControlRequest` (`src/bridge/bridgeMessaging.ts:243-391`) responds to server-initiated control requests. The server expects a response within ~10-14 seconds or kills the WebSocket connection.

Supported subtypes:

| Subtype | Behavior |
|---------|----------|
| `initialize` | Returns minimal capabilities (empty commands/models, PID). Always succeeds, even in outbound-only mode. |
| `set_model` | Delegates to `onSetModel` callback, responds success. |
| `set_max_thinking_tokens` | Delegates to `onSetMaxThinkingTokens` callback, responds success. |
| `set_permission_mode` | Delegates to `onSetPermissionMode` callback which returns a verdict; responds success or error. |
| `interrupt` | Delegates to `onInterrupt` callback, responds success. |
| (unknown) | Responds with an error so the server doesn't hang. |

In **outbound-only mode** (`outboundOnly: true`), all mutable requests except `initialize` receive an error response (`src/bridge/bridgeMessaging.ts:268-283`) rather than a false success. The error message is the constant `OUTBOUND_ONLY_ERROR` at line 231.

### Inbound Message Extraction & Normalization

`extractInboundMessageFields` (`src/bridge/inboundMessages.ts:21-40`) processes an inbound `SDKMessage`:

1. Rejects non-`user` messages and messages with empty content
2. Extracts the UUID for dedup tracking
3. Normalizes image blocks via `normalizeImageBlocks` (`src/bridge/inboundMessages.ts:52-73`)

Image normalization fixes a cross-platform compat issue: iOS/web clients may send `mediaType` (camelCase) instead of `media_type` (snake_case), or omit it entirely. The normalizer:

- Fast-path scans with `isMalformedBase64Image` — returns the original array reference with zero allocation when no fix is needed
- For malformed blocks, reads camelCase `mediaType` if present, otherwise falls back to `detectImageFormatFromBase64` to infer the format from the data itself
- Rebuilds only the affected blocks with a proper `media_type` field

### File Attachment Resolution

When users upload files through the web composer, the message arrives with `file_attachments` containing `file_uuid` + `file_name` pairs. The resolution flow in `src/bridge/inboundAttachments.ts`:

1. **Extract** — `extractInboundAttachments` (line 42-48) Zod-validates the `file_attachments` array from the loosely-typed message
2. **Download** — `resolveOne` (line 68-117) for each attachment:
   - Fetches file content from `GET {baseUrl}/api/oauth/files/{uuid}/content` with OAuth bearer token (30s timeout)
   - Sanitizes the filename (strips path components via `basename`, allows only `[a-zA-Z0-9._-]`)
   - Writes to `~/.claude/uploads/{sessionId}/{prefix}-{safeName}` with a UUID prefix to prevent collisions
3. **Format refs** — `resolveInboundAttachments` (line 123-134) resolves all attachments in parallel via `Promise.all`, returns a string of quoted `@"path"` refs
4. **Prepend** — `prependPathRefs` (line 142-161) prepends refs to the **last** text block in content (not the first), because `processUserInputBase` reads `inputString` from `processedBlocks[processedBlocks.length - 1]`
5. **Convenience** — `resolveAndPrepend` (line 167-175) combines extract + resolve + prepend; no-ops with zero overhead when no attachments exist

All failures are best-effort: network errors, missing tokens, or disk write failures log a debug message and skip that attachment.

### Permission Callback Protocol

`src/bridge/bridgePermissionCallbacks.ts` defines the `BridgePermissionCallbacks` interface for bridging tool-approval prompts between the local REPL and claude.ai:

| Method | Purpose |
|--------|---------|
| `sendRequest` | Send a permission prompt to the web app (tool name, input, description, permission suggestions, blocked path) |
| `sendResponse` | Relay a resolved permission response back |
| `cancelRequest` | Dismiss a pending permission prompt on the web app |
| `onResponse` | Subscribe to responses for a given `requestId`; returns an unsubscribe function |

`isBridgePermissionResponse` (`src/bridge/bridgePermissionCallbacks.ts:32-40`) provides runtime validation by checking the `behavior` discriminant is either `'allow'` or `'deny'`, avoiding an unsafe `as` cast.

### Message Eligibility Filtering

`isEligibleBridgeMessage` (`src/bridge/bridgeMessaging.ts:77-88`) determines which internal `Message` objects should be forwarded to the bridge transport. The rules:

- **Forward**: non-virtual `user` messages, non-virtual `assistant` messages, `system` messages with `subtype === 'local_command'`
- **Filter out**: virtual messages (REPL inner calls that are display-only), `tool_result`, `progress`, and other internal REPL chatter

### Session Title Extraction

`extractTitleText` (`src/bridge/bridgeMessaging.ts:103-122`) derives a session title from the first user message. It returns `undefined` (no title) for:

- Non-`user` messages
- Meta messages (nudges)
- Tool results and compact summaries
- Non-human origins (task notifications, channel messages)
- Content that is purely display tags (cleaned via `stripDisplayTagsAllowEmpty`)

### Result Message Construction

`makeResultMessage` (`src/bridge/bridgeMessaging.ts:399-416`) builds a minimal `SDKResultSuccess` event for session archival. The server needs this event before a WebSocket close to trigger archival. It populates all required fields with zero/empty defaults and generates a fresh UUID.

## Function Signatures

### `handleIngressMessage(data, recentPostedUUIDs, recentInboundUUIDs, onInboundMessage, onPermissionResponse?, onControlRequest?): void`

Main ingress router. Parses raw WebSocket string, deduplicates, and dispatches to the appropriate callback.

> `src/bridge/bridgeMessaging.ts:132-208`

### `handleServerControlRequest(request, handlers): void`

Responds to server-initiated control requests via the transport.

- **handlers**: `ServerControlRequestHandlers` — transport reference, session ID, optional outbound-only flag, and per-subtype callbacks

> `src/bridge/bridgeMessaging.ts:243-391`

### `makeResultMessage(sessionId): SDKResultSuccess`

Builds a minimal result event for session archival.

> `src/bridge/bridgeMessaging.ts:399-416`

### `extractInboundMessageFields(msg): { content, uuid } | undefined`

Extracts content and UUID from an inbound user `SDKMessage`. Returns `undefined` for non-user or empty messages.

> `src/bridge/inboundMessages.ts:21-40`

### `normalizeImageBlocks(blocks): Array<ContentBlockParam>`

Fixes camelCase `mediaType` and missing `media_type` on base64 image blocks. Zero-alloc fast path when no normalization needed.

> `src/bridge/inboundMessages.ts:52-73`

### `resolveAndPrepend(msg, content): Promise<string | ContentBlockParam[]>`

End-to-end convenience: extracts file attachments, downloads them, and prepends `@path` references to message content.

> `src/bridge/inboundAttachments.ts:167-175`

### `extractInboundAttachments(msg): InboundAttachment[]`

Zod-validates and extracts `file_attachments` from a loosely-typed inbound message.

> `src/bridge/inboundAttachments.ts:42-48`

### `prependPathRefs(content, prefix): string | Array<ContentBlockParam>`

Prepends `@path` refs to the last text block in content.

> `src/bridge/inboundAttachments.ts:142-161`

### `isEligibleBridgeMessage(m): boolean`

Returns `true` for messages that should be forwarded to the bridge transport.

> `src/bridge/bridgeMessaging.ts:77-88`

### `extractTitleText(m): string | undefined`

Derives a session title from the first user message, filtering out non-titleable messages.

> `src/bridge/bridgeMessaging.ts:103-122`

### `isBridgePermissionResponse(value): value is BridgePermissionResponse`

Runtime type predicate validating the `behavior` discriminant.

> `src/bridge/bridgePermissionCallbacks.ts:32-40`

## Type Definitions

### `BoundedUUIDSet` (class)

Ring-buffer-backed FIFO set for echo deduplication. O(capacity) memory, constant-time `add`/`has`/`clear`.

```typescript
// src/bridge/bridgeMessaging.ts:429-461
class BoundedUUIDSet {
  constructor(capacity: number)
  add(uuid: string): void    // Insert; evicts oldest when full
  has(uuid: string): boolean  // Membership check
  clear(): void               // Reset all state
}
```

Internally maintains a `Set<string>` for O(1) lookups and a fixed-size `(string | undefined)[]` ring buffer. When capacity is reached, the oldest entry is evicted from both the set and the ring.

### `ServerControlRequestHandlers`

```typescript
// src/bridge/bridgeMessaging.ts:212-229
type ServerControlRequestHandlers = {
  transport: ReplBridgeTransport | null
  sessionId: string
  outboundOnly?: boolean
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (mode: PermissionMode) => { ok: true } | { ok: false; error: string }
}
```

### `BridgePermissionCallbacks`

```typescript
// src/bridge/bridgePermissionCallbacks.ts:10-27
type BridgePermissionCallbacks = {
  sendRequest(requestId, toolName, input, toolUseId, description, permissionSuggestions?, blockedPath?): void
  sendResponse(requestId, response: BridgePermissionResponse): void
  cancelRequest(requestId): void
  onResponse(requestId, handler): () => void  // returns unsubscribe
}
```

### `BridgePermissionResponse`

```typescript
// src/bridge/bridgePermissionCallbacks.ts:3-8
type BridgePermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  message?: string
}
```

### `InboundAttachment`

```typescript
// src/bridge/inboundAttachments.ts:39
type InboundAttachment = { file_uuid: string; file_name: string }
```

## Configuration & Defaults

| Item | Value | Source |
|------|-------|--------|
| Attachment download timeout | 30,000 ms | `src/bridge/inboundAttachments.ts:25` |
| Upload directory | `~/.claude/uploads/{sessionId}/` | `src/bridge/inboundAttachments.ts:60-62` |
| Outbound-only error message | `"This session is outbound-only. Enable Remote Control locally to allow inbound control."` | `src/bridge/bridgeMessaging.ts:231-232` |
| Server control request timeout | ~10-14 seconds (server-enforced) | Documented in code comments |

## Edge Cases & Caveats

- **Echo dedup is a secondary safety net**: The primary dedup mechanism is the hook's `lastWrittenIndexRef` sequence number. `BoundedUUIDSet` catches edge cases where sequence-number negotiation fails (e.g., server ignores `from_sequence_num`, transport died before receiving frames). See `src/bridge/bridgeMessaging.ts:175-185`.

- **Image block normalization is critical**: iOS and web clients may send `mediaType` (camelCase) instead of `media_type` (snake_case). Without normalization, a single malformed block poisons the session — every subsequent API call fails with `"media_type: Field required"`. See `src/bridge/inboundMessages.ts:42-48`.

- **Attachment `@path` refs target the last text block**: `prependPathRefs` prepends to the last text block, not the first, because `processUserInputBase` reads `inputString` from `processedBlocks[processedBlocks.length - 1]`. Prepending to block[0] would silently drop refs for `[text, image]` content. See `src/bridge/inboundAttachments.ts:139-141`.

- **Filename sanitization**: Attachment filenames come from the network (web composer) and are treated as untrusted. Path components are stripped via `basename()` and only `[a-zA-Z0-9._-]` characters survive. See `src/bridge/inboundAttachments.ts:55-58`.

- **Outbound-only mode preserves `initialize`**: When `outboundOnly` is true, the `initialize` request still responds with success because the server kills the connection otherwise. All other mutable requests get proper error responses so claude.ai doesn't show false success. See `src/bridge/bridgeMessaging.ts:265-283`.

- **`extractTitleText` does not filter synthetic interrupts**: `isSyntheticMessage` lives in `messages.ts` which has a heavy import chain (pulls command registry). The `initialMessages` path checks it separately; an interrupt reaching `writeMessages` as the first message is implausible. See `src/bridge/bridgeMessaging.ts:96-101`.

- **Best-effort attachment resolution**: Any failure in fetching or writing attachments is silently swallowed with a debug log. The user message still reaches Claude, just without the `@path` reference to the uploaded file. This prevents a single broken attachment from blocking the entire message. See `src/bridge/inboundAttachments.ts:9-11`.

- **`set_permission_mode` without callback returns error**: If `onSetPermissionMode` is not registered (e.g., daemon context), the handler returns an error verdict rather than silent false-success, because the mode would never actually be applied. See `src/bridge/bridgeMessaging.ts:334-340`.