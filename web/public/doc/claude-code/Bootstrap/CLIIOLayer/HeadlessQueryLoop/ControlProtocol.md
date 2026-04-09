# ControlProtocol — Stdin Message Router

## Overview & Responsibilities

The ControlProtocol is the central stdin message router within the headless query loop (`src/cli/print.ts:2807–4143`). It processes structured NDJSON input from SDK consumers, IDE extensions, and bridge sessions, dispatching 25+ `control_request` subtypes to their respective handlers. It sits inside `runHeadless` as a parallel `async` task that reads from `structuredIO.structuredInput` and routes each incoming message by type and subtype.

Within the broader architecture, this module belongs to the **CLIIOLayer** (under **Bootstrap > CLIIOLayer > HeadlessQueryLoop**). While `StructuredIO` handles the low-level NDJSON framing, and `RemoteIO` adds WebSocket transport, the ControlProtocol is the application-level dispatcher that interprets each control request and mutates session state accordingly. Its sibling modules — StructuredIOLayer, Transports, and Utilities — provide the I/O plumbing it reads from and writes to.

## Key Processes

### Message Loop Architecture

The router runs as a `for await` loop over the structured input stream (`src/cli/print.ts:2816`). Two parallel async tasks cooperate:

1. **Stdin reader** (this module): reads NDJSON messages, dispatches control requests inline, and enqueues user messages for the query engine
2. **Query runner** (`run()`): dequeues user messages and drives the AI conversation loop

Control requests are handled synchronously within the stdin loop (never queued), ensuring they take effect before the next user message is processed. Each dispatched message receives a lifecycle notification (`notifyCommandLifecycle`) on completion.

### Control Request Dispatch Flow

When a message arrives with `type === 'control_request'`, the router enters a large `if/else if` chain that matches on `message.request.subtype`:

1. **Session lifecycle**: `initialize`, `interrupt`, `end_session`
2. **Configuration**: `set_permission_mode`, `set_model`, `set_max_thinking_tokens`, `apply_flag_settings`, `get_settings`
3. **MCP management**: `mcp_status`, `mcp_message`, `mcp_set_servers`, `mcp_reconnect`, `mcp_toggle`, `mcp_authenticate`, `mcp_oauth_callback_url`, `mcp_clear_auth`
4. **Session operations**: `get_context_usage`, `rewind_files`, `cancel_async_message`, `seed_read_state`, `stop_task`
5. **Plugins & agents**: `reload_plugins`, `channel_enable`
6. **Authentication**: `claude_authenticate`, `claude_oauth_callback`, `claude_oauth_wait_for_completion`
7. **Async features**: `generate_session_title`, `side_question`, `set_proactive`, `remote_control`

After all control/keep-alive/system messages are handled, only `user` messages remain — these pass through deduplication and are enqueued for the query engine via `enqueue()` / `run()`.

### Response Protocol

Every control request receives either a success or error response via helper functions:

- `sendControlResponseSuccess(message, payload?)` — enqueues a `control_response` with `subtype: 'success'`
- `sendControlResponseError(message, errorString)` — enqueues a `control_response` with `subtype: 'error'`

Unknown subtypes receive an error response so the caller never hangs waiting for a reply (`src/cli/print.ts:4021–4028`).

### User Message Deduplication

User messages go through a two-tier deduplication check before being enqueued (`src/cli/print.ts:4062–4100`):

1. **Historical check**: `doesMessageExistInSession()` checks whether the UUID exists in the persisted session transcript
2. **Runtime check**: `receivedMessageUuids` set tracks UUIDs seen in the current session

Duplicates in replay mode get an acknowledgment echoed back (`isReplay: true`). Historical duplicates also fire a lifecycle `completed` notification for the message that was interrupted before its ack.

## Function Signatures

### `handleInitializeRequest(request, requestId, initialized, output, commands, modelInfos, structuredIO, enableAuthStatus, options, agents, getAppState): Promise<void>`

Bootstraps the SDK session. Rejects if already initialized. Applies `systemPrompt`/`appendSystemPrompt` from the request (avoids ARG_MAX limits), merges SDK-defined agents, resolves main-thread agent configuration, registers hook callbacks, sets JSON schema constraints, and responds with session metadata including available commands, agents, output styles, model info, and account details.

> Source: `src/cli/print.ts:4336–4518`

### `handleSetPermissionMode(request, requestId, toolPermissionContext, output): ToolPermissionContext`

Validates and applies a permission mode transition. Guards against:
- `bypassPermissions` when disabled by settings or when the session wasn't launched with `--dangerously-skip-permissions`
- `auto` mode when the transcript classifier gate is not enabled

Returns the updated `ToolPermissionContext` with the new mode applied via `transitionPermissionMode()`.

> Source: `src/cli/print.ts:4568–4642`

### `handleRewindFiles(userMessageId, appState, setAppState, dryRun): Promise<RewindFilesResult>`

Reverts file changes to a checkpoint associated with a specific user message. In `dryRun` mode, returns diff statistics (files changed, insertions, deletions) without modifying the filesystem. Returns error if file history is disabled or no checkpoint exists for the given message ID.

> Source: `src/cli/print.ts:4520–4566`

### `handleChannelEnable(requestId, serverName, connectionPool, output): void`

Enables IDE-triggered MCP channel notifications. Validates the server is connected and plugin-sourced (marketplace origin required), gates through the channel allowlist, then registers a notification handler on the MCP client that enqueues channel messages at `priority: 'next'` for processing between turns. Rolls back the allowlist entry on gate failure.

> Source: `src/cli/print.ts:4662–4768`

### `reregisterChannelHandlerAfterReconnect(connection): void`

Re-binds the channel notification handler after `mcp_reconnect` or `mcp_toggle` creates a new MCP client object. Without this, channel messages silently drop after reconnection because the handler was bound to the old client.

> Source: `src/cli/print.ts:4786–4835`

## Control Request Subtypes Reference

| Subtype | Category | Behavior |
|---------|----------|----------|
| `initialize` | Lifecycle | One-time session setup; merges agents, hooks, system prompts; returns session metadata |
| `interrupt` | Lifecycle | Aborts the current generation and suggestion state; tracks escape count for attribution |
| `end_session` | Lifecycle | Aborts generation, breaks the stdin loop, triggers graceful shutdown |
| `set_permission_mode` | Config | Switches between `default`, `auto`, and `bypassPermissions` modes with validation |
| `set_model` | Config | Overrides the active model; injects breadcrumbs and notifies metadata listeners |
| `set_max_thinking_tokens` | Config | Configures thinking token budget: `null` = reset, `0` = disabled, `N` = enabled with budget |
| `apply_flag_settings` | Config | Merges key/value settings into in-memory flag settings; null values delete keys |
| `get_settings` | Config | Returns the full settings cascade with source annotations and applied model/effort |
| `mcp_status` | MCP | Returns connection statuses for all MCP servers |
| `mcp_message` | MCP | Forwards an MCP notification to a connected SDK server's transport |
| `mcp_set_servers` | MCP | Applies MCP server configuration changes; reconnects SDK servers after responding |
| `mcp_reconnect` | MCP | Disconnects and reconnects an MCP server; updates appState and dynamicMcpState |
| `mcp_toggle` | MCP | Enables or disables an MCP server; persists the setting and manages connection lifecycle |
| `mcp_authenticate` | MCP/Auth | Initiates an OAuth flow for an SSE/HTTP MCP server; returns the auth URL to the caller |
| `mcp_oauth_callback_url` | MCP/Auth | Submits the OAuth redirect URL; validates the `code` param; waits for token exchange |
| `mcp_clear_auth` | MCP/Auth | Revokes stored OAuth tokens for a server and reconnects it |
| `claude_authenticate` | Auth | Starts an Anthropic OAuth flow; returns manual and automatic auth URLs |
| `claude_oauth_callback` | Auth | Submits a manual authorization code + state to the in-flight OAuth flow |
| `claude_oauth_wait_for_completion` | Auth | Waits for the OAuth flow to complete; returns account info on success |
| `get_context_usage` | Session | Collects and returns context window usage data (messages, tools, system prompt) |
| `rewind_files` | Session | Reverts file changes to a checkpoint; supports dry-run mode |
| `cancel_async_message` | Session | Dequeues a pending message by UUID from the command queue |
| `seed_read_state` | Session | Pre-seeds file read cache for files observed by the client but removed from context |
| `stop_task` | Session | Stops a running background task by ID |
| `reload_plugins` | Plugins | Re-downloads user settings, refreshes plugins, and returns updated commands/agents/plugins |
| `channel_enable` | Channels | Enables MCP channel notifications for an IDE-connected plugin server |
| `generate_session_title` | Async | Fire-and-forget Haiku call to generate a session title; optionally persists it |
| `side_question` | Async | Fire-and-forget forked agent for answering a side question using cache-safe params |
| `set_proactive` | Async | Activates or deactivates proactive mode (feature-gated) |
| `remote_control` | Bridge | Initializes or tears down a bridge handle for remote-controlled sessions |

## Non-Control Message Types

The router also handles several non-control message types inline:

- **`control_response`**: Replayed in replay mode (`options.replayUserMessages`); otherwise consumed by `StructuredIO.processLine`
- **`keep_alive`**: Silently ignored
- **`update_environment_variables`**: Handled in `structuredIO.ts`; the type guard here prevents fallthrough
- **`assistant` / `system`**: History replay from bridge sessions — injected into `mutableMessages` as conversation context; assistant messages echoed back in replay mode
- **`user`**: After deduplication, enqueued for the query engine

## Edge Cases & Caveats

- **Initialize is one-shot**: Calling `initialize` twice returns an error. However, the first user prompt implicitly sets `initialized = true`, so `initialize` becomes a no-op if a prompt arrives first (`src/cli/print.ts:4060`).

- **Fire-and-forget subtypes**: `generate_session_title` and `side_question` spawn background async tasks that don't block the stdin loop. This prevents API roundtrips from delaying subsequent messages or interrupts.

- **OAuth flow lifecycle**: `mcp_authenticate` stores an `AbortController` per server in `activeOAuthFlows`. A new flow for the same server aborts the previous one. The `mcp_oauth_callback_url` handler validates that the callback URL contains a `code` or `error` param — without this check, the auth promise would hang indefinitely.

- **MCP server lookup spread**: Several handlers (`mcp_reconnect`, `mcp_toggle`, `channel_enable`) search across three client pools — `mcpClients`, `sdkClients`, and `dynamicMcpState.clients` — because servers can be injected via SDK, config files, or dynamically added at runtime.

- **`seed_read_state` mtime check**: The handler compares disk mtime against the client's observed mtime before seeding. If the file changed since observation, the seed is skipped to force a fresh `Read` — otherwise the model would never learn about the content change (`src/cli/print.ts:3034–3050`).

- **Bridge `remote_control` deadlock prevention**: `mcp_set_servers` sends its success response *before* connecting SDK servers to avoid blocking the stdin loop while awaiting server connections (`src/cli/print.ts:3061–3064`).

- **Graceful shutdown**: When the input stream ends (`end_session` or EOF), the loop sets `inputClosed = true`, waits for in-flight suggestion promises, finalizes async hooks, and closes the output stream (`src/cli/print.ts:4124–4139`).