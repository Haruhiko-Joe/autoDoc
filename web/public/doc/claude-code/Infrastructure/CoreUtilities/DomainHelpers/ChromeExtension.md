# Chrome Extension Native Messaging Host Integration

## Overview & Responsibilities

This module (`src/utils/claudeInChrome/`) provides bidirectional communication between the Claude Code CLI and a Chrome browser extension. It sits within the **Infrastructure > CoreUtilities > DomainHelpers** layer and enables Claude to perform browser automation — navigating pages, executing JavaScript, capturing screenshots, reading console logs, and more — by bridging the CLI process with a running Chrome extension via the Chrome native messaging protocol and MCP (Model Context Protocol).

The module is organized into 7 files, each with a distinct responsibility:

| File | Role |
|------|------|
| `common.ts` | Browser configuration registry, path resolution, socket utilities, browser detection |
| `chromeNativeHost.ts` | Chrome native messaging protocol implementation (stdin/stdout length-prefixed binary framing) |
| `mcpServer.ts` | MCP server setup, context construction, bridge configuration, analytics wiring |
| `setup.ts` | Feature gating, native host manifest installation, wrapper script generation, extension detection |
| `setupPortable.ts` | Portable extension detection logic (shared with VS Code extension) |
| `prompt.ts` | System prompt augmentation for Chrome tool availability and usage instructions |
| `toolRendering.tsx` | JSX rendering of Chrome tool use/result messages in the terminal UI |

## Key Processes

### 1. Native Messaging Protocol (stdin/stdout Framing)

Chrome's native messaging protocol uses a length-prefixed binary format: each message is preceded by a 4-byte little-endian `uint32` indicating the JSON payload size.

The `ChromeMessageReader` class (`chromeNativeHost.ts:440-527`) implements async reading from stdin:

1. Listens for `data` events on `process.stdin`, appending chunks to an internal buffer
2. When a pending `read()` call exists, `tryProcessMessage()` checks if the buffer contains at least 4 bytes (length prefix) plus the indicated payload length
3. Extracts and returns the complete UTF-8 JSON string, advancing the buffer

Outbound messages use `sendChromeMessage()` (`chromeNativeHost.ts:50-57`):
```
// chromeNativeHost.ts:50-57
const jsonBytes = Buffer.from(message, 'utf-8')
const lengthBuffer = Buffer.alloc(4)
lengthBuffer.writeUInt32LE(jsonBytes.length, 0)
process.stdout.write(lengthBuffer)
process.stdout.write(jsonBytes)
```

Messages are capped at `MAX_MESSAGE_SIZE` (1MB).

### 2. Native Host Server Lifecycle

`runChromeNativeHost()` (`chromeNativeHost.ts:59-82`) orchestrates the full lifecycle:

1. Creates a `ChromeNativeHost` instance and a `ChromeMessageReader`
2. Calls `host.start()` which creates a Unix domain socket (or Windows named pipe) server
3. Enters a read loop, processing each Chrome message via `host.handleMessage()`
4. When stdin closes (Chrome disconnected), calls `host.stop()` for cleanup

**Socket management** (`chromeNativeHost.ts:110-191`):
- Socket path is PID-based: `/tmp/claude-mcp-browser-bridge-<username>/<pid>.sock`
- On startup, the directory is created with `0o700` permissions, the socket with `0o600`
- Stale sockets from dead PIDs are cleaned up by attempting `process.kill(pid, 0)`
- On Windows, named pipes are used instead: `\\.\pipe\claude-mcp-browser-bridge-<username>`

### 3. MCP Client ↔ Chrome Message Routing

The `ChromeNativeHost` class acts as a bidirectional router between MCP clients (connected via the Unix socket) and the Chrome extension (connected via stdin/stdout).

**Inbound from Chrome** — `handleMessage()` dispatches on `message.type`:
- `ping` → responds with `pong` + timestamp
- `get_status` → responds with version info
- `tool_response` → forwards to all connected MCP clients via socket (length-prefixed)
- `notification` → forwards to all MCP clients

**Inbound from MCP clients** — `handleMcpClient()` (`chromeNativeHost.ts:354-433`):
- Accepts socket connections, assigns incrementing client IDs
- Reads length-prefixed messages from the socket buffer
- Forwards tool requests to Chrome via `sendChromeMessage()` with `type: 'tool_request'`
- Notifies Chrome of connect/disconnect events

### 4. MCP Server Setup and Context

`createChromeContext()` (`mcpServer.ts:85-246`) builds a `ClaudeForChromeContext` that configures the MCP server:

- **Socket paths**: Provides both the PID-specific socket and the directory scanner for discovery
- **Bridge URL**: Resolves WebSocket bridge based on feature flags (`tengu_copper_bridge`) and environment (local/staging/production)
- **Device pairing**: Persists paired extension device IDs to `~/.claude.json` via `onExtensionPaired`
- **OAuth integration**: Supplies bridge auth tokens from the CLI's OAuth session
- **Analytics**: Sanitized event forwarding with an allowlist of safe string metadata keys
- **Inference support** (ant-only): Wires `callAnthropicMessages` for the `browser_task` lightning-mode agent loop via `sideQuery()`

`runClaudeInChromeMcpServer()` (`mcpServer.ts:248-275`) starts the server as a subprocess:
1. Enables config loading and analytics
2. Creates the context and MCP server from `@ant/claude-for-chrome-mcp`
3. Connects via `StdioServerTransport`
4. Handles graceful shutdown on stdin close (flushes analytics before exit)

### 5. Setup and Installation Flow

`setupClaudeInChrome()` (`setup.ts:91-171`) is the main entry point called during CLI startup:

1. **Determines binary mode**: Detects if running as a bundled native binary or from source
2. **Creates wrapper script**: Generates `~/.claude/chrome/chrome-native-host` (shell script or `.bat`) because Chrome's native host manifest `path` field cannot contain arguments
3. **Installs native host manifest**: Writes `com.anthropic.claude_code_browser_extension.json` to every detected browser's `NativeMessagingHosts/` directory
4. **Windows registry**: Calls `reg add` to register the manifest path under each browser's registry key
5. **Returns MCP config**: Produces the `ScopedMcpServerConfig` for the MCP client to spawn the server subprocess

**Feature gating** (`setup.ts:39-84`):
- `shouldEnableClaudeInChrome()` checks: non-interactive sessions (disabled by default), CLI `--chrome` flag, `CLAUDE_CODE_ENABLE_CFC` env var, and `claudeInChromeDefaultEnabled` in global config
- `shouldAutoEnableClaudeInChrome()` additionally requires interactive mode, detected extension installation, and feature flag (`tengu_chrome_auto_enable`) or ant-user status

### 6. Extension Detection

Two detection strategies exist:

**Full detection** (`setupPortable.ts:147-213`): Scans browser profile directories (`Default/`, `Profile 1/`, etc.) for an `Extensions/<extension-id>/` directory. Checks the production extension ID (`fcoeoabgfenejglbffodgkkbkcdhcgfn`) plus dev/ant IDs for internal users.

**Cached detection** (`setup.ts:362-383`): Returns `cachedChromeExtensionInstalled` from `~/.claude.json` synchronously. Triggers a background filesystem scan to update the cache. Only positive detections are persisted to avoid poisoning shared config files across machines.

### 7. Browser Support

The module supports 7 Chromium-based browsers with per-platform path configurations (`common.ts:39-216`):

| Browser | macOS | Linux | Windows |
|---------|-------|-------|---------|
| Chrome | `/Applications/Google Chrome.app` | `google-chrome` binary | `AppData\Local\Google\Chrome` |
| Brave | `/Applications/Brave Browser.app` | `brave-browser` binary | `AppData\Local\BraveSoftware` |
| Arc | `/Applications/Arc.app` | N/A | `AppData\Local\Arc` |
| Edge | `/Applications/Microsoft Edge.app` | `microsoft-edge` binary | `AppData\Local\Microsoft\Edge` |
| Chromium | `/Applications/Chromium.app` | `chromium` binary | `AppData\Local\Chromium` |
| Vivaldi | `/Applications/Vivaldi.app` | `vivaldi` binary | `AppData\Local\Vivaldi` |
| Opera | via `com.operasoftware.Opera` | `opera` binary | `AppData\Roaming\Opera Software` |

Detection priority order: Chrome > Brave > Arc > Edge > Chromium > Vivaldi > Opera.

## Function Signatures

### `runChromeNativeHost(): Promise<void>`
Entry point for the native messaging host process. Reads messages from Chrome via stdin, routes them through the `ChromeNativeHost` server, and exits when stdin closes.
> `chromeNativeHost.ts:59-82`

### `sendChromeMessage(message: string): void`
Sends a JSON message to Chrome via stdout using the native messaging binary protocol (4-byte LE length prefix + UTF-8 payload).
> `chromeNativeHost.ts:50-57`

### `setupClaudeInChrome(): { mcpConfig, allowedTools, systemPrompt }`
Configures the Chrome MCP server, installs native host manifests, and returns the MCP config for the CLI to spawn the server subprocess.
> `setup.ts:91-171`

### `shouldEnableClaudeInChrome(chromeFlag?: boolean): boolean`
Evaluates whether Chrome integration should be active based on CLI flags, environment variables, and global config.
> `setup.ts:39-68`

### `createChromeContext(env?): ClaudeForChromeContext`
Builds the full configuration context for the `@ant/claude-for-chrome-mcp` server including socket paths, bridge URL, device pairing, OAuth, and analytics.
> `mcpServer.ts:85-246`

### `runClaudeInChromeMcpServer(): Promise<void>`
Starts the MCP server as a subprocess with stdio transport. Handles graceful shutdown on stdin close.
> `mcpServer.ts:248-275`

### `detectAvailableBrowser(): Promise<ChromiumBrowser | null>`
Probes the system for installed Chromium browsers in priority order and returns the first match.
> `common.ts:345-409`

### `isChromeExtensionInstalled(): Promise<boolean>`
Scans all browser profile directories for the Claude extension by checking for known extension IDs.
> `setup.ts:391-400`

### `getClaudeInChromeMCPToolOverrides(toolName: string)`
Returns custom UI rendering hooks (name, tool-use message, result message, view-tab link) for Chrome MCP tools in the terminal.
> `toolRendering.tsx:221-258`

## Type Definitions

### `ChromiumBrowser`
Union type of supported browser identifiers:
```ts
type ChromiumBrowser = 'chrome' | 'brave' | 'arc' | 'chromium' | 'edge' | 'vivaldi' | 'opera'
```
> `setupPortable.ts:21-28`

### `BrowserConfig`
Per-browser path configuration with platform-specific data paths, native messaging paths, and Windows registry keys.
> `common.ts:20-37`

### `ChromeToolName`
Union of all 17 Chrome extension tool names:
`javascript_tool`, `read_page`, `find`, `form_input`, `computer`, `navigate`, `resize_window`, `gif_creator`, `upload_image`, `get_page_text`, `tabs_context_mcp`, `tabs_create_mcp`, `update_plan`, `read_console_messages`, `read_network_requests`, `shortcuts_list`, `shortcuts_execute`
> `toolRendering.tsx:15`

## Configuration & Defaults

| Config / Variable | Type | Default | Description |
|---|---|---|---|
| `CLAUDE_CODE_ENABLE_CFC` | env var | — | Force-enable/disable Chrome integration |
| `CLAUDE_CHROME_PERMISSION_MODE` | env var | — | Override permission mode (`ask`, `skip_all_permission_checks`, `follow_a_plan`) |
| `USER_TYPE=ant` | env var | — | Enables dev extension IDs, bridge access, and lightning agent |
| `USE_LOCAL_OAUTH` / `LOCAL_BRIDGE` | env var | — | Routes bridge to `ws://localhost:8765` |
| `USE_STAGING_OAUTH` | env var | — | Routes bridge to staging WebSocket URL |
| `claudeInChromeDefaultEnabled` | global config | `false` | Persisted default-on preference |
| `cachedChromeExtensionInstalled` | global config | — | Cached extension detection result (only positive values stored) |
| `chromeExtension.pairedDeviceId` | global config | — | Persisted paired extension device ID |

## Edge Cases & Caveats

- **Stale socket cleanup**: On startup, the native host probes `process.kill(pid, 0)` for each `*.sock` file. Dead PIDs' sockets are removed; live ones are preserved. This prevents orphaned sockets from blocking new connections.

- **Legacy socket migration**: If the socket directory path (`/tmp/claude-mcp-browser-bridge-<user>`) exists as a file (from an older version), it is deleted and recreated as a directory. `getAllSocketPaths()` also scans legacy paths for backward compatibility.

- **Cache poisoning prevention**: Only positive extension-detection results are persisted to `~/.claude.json`. A negative scan is never cached because shared config files (e.g., synced dotfiles) could permanently disable auto-enable on machines that do have Chrome.

- **Windows named pipes vs. Unix sockets**: The socket path logic branches on `platform() === 'win32'`, using `\\.\pipe\<name>` for Windows. Windows native host registration uses `reg.exe` to set registry keys instead of file-based manifests.

- **Opera's `useRoaming`**: Opera stores data in `AppData\Roaming` instead of `AppData\Local`, which is handled by a `useRoaming` flag in `BrowserConfig`.

- **MAX_MESSAGE_SIZE**: Both the Chrome message reader and MCP client socket reader enforce a 1MB limit. Messages exceeding this cause the connection to be destroyed.

- **Tab ID tracking**: `trackClaudeInChromeTabId()` maintains a set of up to 200 recently-seen tab IDs. When the limit is reached, the entire set is cleared rather than evicted incrementally.

- **Analytics safety**: Only an allowlist of string metadata keys (`bridge_status`, `error_type`, `tool_name`) is forwarded to analytics. Fields like `error_message` are dropped to prevent leaking page content or user data.