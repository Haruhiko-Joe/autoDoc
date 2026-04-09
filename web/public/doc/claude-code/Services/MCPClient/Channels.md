# Channels

## Overview & Responsibilities

The Channels module is the multi-channel messaging integration layer within the MCP (Model Context Protocol) client subsystem. It enables Claude Code to communicate bidirectionally with users through messaging platforms like Discord, Slack, Telegram, and iMessage — receiving inbound messages and relaying tool-approval permission prompts.

Within the **Services → MCPClient** hierarchy, this module sits alongside the MCP connection manager and tool discovery logic. While those siblings handle the general MCP lifecycle, Channels specifically governs which MCP servers can act as messaging channels, how inbound messages are wrapped for the model, and how permission dialogs are relayed to users on their phones or chat platforms.

The module is split into three files with distinct responsibilities:

- **`channelAllowlist.ts`** — GrowthBook-backed allowlist determining which channel plugins are approved
- **`channelPermissions.ts`** — Permission relay system that races channel-based approvals against the local UI
- **`channelNotification.ts`** — Inbound message handling, gating logic, and XML wrapping

## Key Processes

### Channel Server Registration Gate

Before an MCP server can push messages into a conversation, it must pass a multi-layer gate in `gateChannelServer()` (`src/services/mcp/channelNotification.ts:191-316`). The checks run in this order — early exit on any failure:

1. **Capability check** — Server must declare `experimental['claude/channel']` in its MCP capabilities
2. **Runtime gate** — The `tengu_harbor` GrowthBook flag must be enabled (global killswitch)
3. **Auth check** — User must have claude.ai OAuth tokens (API key users are blocked)
4. **Org policy** — Team/Enterprise orgs must explicitly set `channelsEnabled: true` in managed settings
5. **Session opt-in** — Server must appear in the user's `--channels` CLI argument for this session
6. **Marketplace verification** (plugin-kind only) — The installed plugin's marketplace must match the user's `--channels` tag (e.g., `plugin:slack@anthropic` must actually be from `anthropic`)
7. **Allowlist check** — Plugin must appear on the effective allowlist (GrowthBook ledger or org-managed list)

The `--dangerously-load-development-channels` flag sets `entry.dev = true` on individual entries, bypassing the allowlist check for that entry only.

### Inbound Message Flow

When a channel server receives a user message (e.g., someone types in a Discord channel), it sends a `notifications/claude/channel` MCP notification. The handler:

1. Validates the payload against `ChannelMessageNotificationSchema` (`src/services/mcp/channelNotification.ts:37-47`)
2. Wraps the content in a `<channel>` XML tag via `wrapChannelMessage()` with the server name and optional metadata attributes
3. Enqueues the wrapped message into the conversation
4. `SleepTool` polls `hasCommandsInQueue()` and wakes within 1 second
5. The model sees the tagged message and decides how to respond (via the channel's MCP tool, `SendUserMessage`, or both)

### Permission Relay Flow

When Claude needs tool approval, the permission prompt can be relayed to messaging channels so users can approve from their phone:

1. `filterPermissionRelayClients()` selects connected servers that are allowlisted AND declare both `claude/channel` and `claude/channel/permission` capabilities (`src/services/mcp/channelPermissions.ts:177-194`)
2. CC generates a 5-letter request ID via `shortRequestId()` and sends a `notifications/claude/channel/permission_request` to each eligible server
3. The server formats the prompt for its platform and presents it to the human
4. The human replies (e.g., "yes tbxkq") — the **server** parses this reply against `PERMISSION_REPLY_RE` and emits a structured `notifications/claude/channel/permission` event with `{request_id, behavior}`
5. `resolve()` on the callbacks object matches the request ID against the pending map and fires the handler
6. The channel reply races against the local terminal UI, bridge, hooks, and classifier — first resolver wins via `claim()`

Critically, CC never regex-matches raw text from channels. Approval requires the server to deliberately emit the structured permission event, preventing accidental matches from conversational text.

## Function Signatures

### channelAllowlist.ts

#### `isChannelsEnabled(): boolean`
Global on/off gate backed by GrowthBook flag `tengu_harbor`. When false, `--channels` is a no-op.
> Source: `src/services/mcp/channelAllowlist.ts:51-53`

#### `getChannelAllowlist(): ChannelAllowlistEntry[]`
Returns the current approved plugin list from GrowthBook (`tengu_harbor_ledger`). Validates against a Zod schema; returns `[]` on parse failure.
> Source: `src/services/mcp/channelAllowlist.ts:37-44`

#### `isChannelAllowlisted(pluginSource: string | undefined): boolean`
Pure check for UI pre-filtering. Returns `true` if the given plugin source matches an entry on the allowlist. Returns `false` for `undefined`, non-plugin servers, or `@`-less sources.
> Source: `src/services/mcp/channelAllowlist.ts:67-76`

### channelNotification.ts

#### `gateChannelServer(serverName, capabilities, pluginSource): ChannelGateResult`
Runs the full 7-layer gate. Returns `{ action: 'register' }` on success or `{ action: 'skip', kind, reason }` with a human-readable explanation on failure.
> Source: `src/services/mcp/channelNotification.ts:191-316`

#### `wrapChannelMessage(serverName, content, meta?): string`
Wraps message content in a `<channel source="...">` XML tag. Meta keys are filtered to safe identifier patterns (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) and values are XML-escaped.
> Source: `src/services/mcp/channelNotification.ts:106-116`

#### `findChannelEntry(serverName, channels): ChannelEntry | undefined`
Matches a server name against parsed `--channels` entries. Server-kind matches on bare name; plugin-kind matches on the second segment of `plugin:X:Y`.
> Source: `src/services/mcp/channelNotification.ts:161-173`

#### `getEffectiveChannelAllowlist(sub, orgList): { entries, source }`
Returns the org-managed allowlist for Team/Enterprise when set, otherwise falls back to the GrowthBook ledger.
> Source: `src/services/mcp/channelNotification.ts:127-138`

### channelPermissions.ts

#### `isChannelPermissionRelayEnabled(): boolean`
Separate GrowthBook gate (`tengu_harbor_permissions`) for the permission relay feature, independent of the main channels gate.
> Source: `src/services/mcp/channelPermissions.ts:36-38`

#### `shortRequestId(toolUseID: string): string`
Generates a 5-letter ID from a tool use ID using FNV-1a hashing into a 25-character alphabet (a-z minus 'l'). Re-hashes with a salt if the result contains a blocklisted substring.
> Source: `src/services/mcp/channelPermissions.ts:140-152`

#### `truncateForPreview(input: unknown): string`
JSON-stringifies tool input, truncating to 200 characters for phone-sized display.
> Source: `src/services/mcp/channelPermissions.ts:160-167`

#### `filterPermissionRelayClients(clients, isInAllowlist): T[]`
Filters MCP clients to those eligible for permission relay: must be connected, allowlisted, and declare both `claude/channel` and `claude/channel/permission` capabilities.
> Source: `src/services/mcp/channelPermissions.ts:177-194`

#### `createChannelPermissionCallbacks(): ChannelPermissionCallbacks`
Factory that returns `{ onResponse, resolve }`. Manages a pending Map of request ID → handler. `onResponse` registers a handler (returns unsubscribe). `resolve` fires and removes the matching handler, returning `true` if found.
> Source: `src/services/mcp/channelPermissions.ts:209-240`

## Type Definitions

### `ChannelAllowlistEntry`
| Field | Type | Description |
|-------|------|-------------|
| marketplace | string | Plugin marketplace (e.g., "anthropic") |
| plugin | string | Plugin name (e.g., "slack") |

### `ChannelEntry` (from `bootstrap/state.ts`)
Union type representing a parsed `--channels` argument:
- `{ kind: 'plugin'; name: string; marketplace: string; dev?: boolean }`
- `{ kind: 'server'; name: string; dev?: boolean }`

### `ChannelGateResult`
Discriminated union: `{ action: 'register' }` on success, or `{ action: 'skip'; kind: string; reason: string }` on failure. `kind` values: `capability`, `disabled`, `auth`, `policy`, `session`, `marketplace`, `allowlist`.

### `ChannelPermissionResponse`
| Field | Type | Description |
|-------|------|-------------|
| behavior | `'allow' \| 'deny'` | The human's decision |
| fromServer | string | Which channel server relayed the reply |

### `ChannelPermissionRequestParams`
| Field | Type | Description |
|-------|------|-------------|
| request_id | string | 5-letter ID for the user to reference |
| tool_name | string | Tool requesting approval |
| description | string | Human-readable description of what the tool wants to do |
| input_preview | string | JSON-stringified tool input, truncated to 200 chars |

## Configuration & Feature Flags

| Flag / Setting | Source | Default | Purpose |
|----------------|--------|---------|---------|
| `tengu_harbor` | GrowthBook | `false` | Global channels on/off killswitch |
| `tengu_harbor_permissions` | GrowthBook | `false` | Permission relay on/off (independent rollout) |
| `tengu_harbor_ledger` | GrowthBook | `[]` | Approved `{marketplace, plugin}` pairs |
| `channelsEnabled` | Managed settings (org) | `false` | Team/Enterprise opt-in for channels |
| `allowedChannelPlugins` | Managed settings (org) | undefined | Org-managed allowlist override (replaces GrowthBook ledger) |
| `--channels` | CLI argument | none | Per-session list of allowed channel servers |
| `--dangerously-load-development-channels` | CLI flag | `false` | Bypasses allowlist for development entries |

## MCP Notification Protocol

| Method | Direction | Purpose |
|--------|-----------|---------|
| `notifications/claude/channel` | Server → CC | Inbound user message from a messaging platform |
| `notifications/claude/channel/permission` | Server → CC | Structured permission reply (parsed by server) |
| `notifications/claude/channel/permission_request` | CC → Server | Outbound permission prompt for the human |

Servers opt into channel behavior by declaring `capabilities.experimental['claude/channel']` and optionally `capabilities.experimental['claude/channel/permission']` for permission relay.

## Edge Cases & Caveats

- **API key users are blocked** — Channels requires claude.ai OAuth authentication. Console orgs have no `channelsEnabled` admin surface yet.
- **Server-kind entries never pass the allowlist** — The allowlist schema is `{marketplace, plugin}`, so `--channels server:foo` always requires `--dangerously-load-development-channels` to work.
- **Per-entry dev bypass** — The `dev` flag is set per `--channels` entry, not session-wide. Accepting the dev dialog for one entry doesn't leak allowlist bypass to other entries.
- **Marketplace verification prevents spoofing** — `--channels plugin:slack@anthropic` verifies at runtime that the installed `slack` plugin actually comes from the `anthropic` marketplace, preventing a `slack@evil` plugin from hijacking the trust.
- **Permission IDs avoid profanity** — The 5-letter request IDs are checked against a blocklist of substrings and re-hashed with a salt if they match (roughly 1 in 700 chance).
- **No 'l' in IDs** — The letter 'l' is excluded from the ID alphabet because it resembles '1' and 'I' in many fonts, important since these IDs are typed on phones.
- **Meta key injection prevention** — XML attribute names from channel metadata are validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` to prevent attribute injection.
- **Duplicate permission events are ignored** — `resolve()` deletes the pending entry before calling the handler, so a second emission (server bug or network duplicate) silently falls through.
- **Mid-session flag changes don't apply** — `isChannelPermissionRelayEnabled()` is checked once at hook mount time; toggling the GrowthBook flag requires a session restart.