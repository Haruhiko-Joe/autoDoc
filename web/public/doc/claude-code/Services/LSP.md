# LSP (Language Server Protocol Integration)

## Overview & Responsibilities

The LSP module integrates Language Server Protocol servers into Claude Code, enabling real-time diagnostics (errors, warnings) and code intelligence from language-specific tooling. It sits within the **Services** layer and is consumed by the Tool System (via `LSPTool`), file editing tools (`FileWriteTool`, `FileEditTool`), and the attachment system for surfacing diagnostics to Claude during conversation.

The module is **plugin-driven**: LSP server configurations are loaded exclusively from Claude Code plugins, not from user or project settings. Servers are **lazily started** on first use — the heavy `vscode-jsonrpc` dependency (~129KB) is only loaded when an LSP server is actually instantiated.

**Sibling context**: Within the Services group, the LSP module sits alongside the Claude API client, MCP protocol client, analytics pipeline, and context compaction engine. It provides a passive feedback loop where language servers push diagnostics that are automatically attached to Claude's conversation context.

## Architecture

The module is organized into five layers, each with a single responsibility:

| Layer | File | Role |
|-------|------|------|
| **LSP Client** | `src/services/lsp/LSPClient.ts` | Low-level JSON-RPC wrapper over stdio |
| **Server Instance** | `src/services/lsp/LSPServerInstance.ts` | Lifecycle management for a single server |
| **Server Manager** | `src/services/lsp/LSPServerManager.ts` | Routes requests to servers by file extension |
| **Singleton Manager** | `src/services/lsp/manager.ts` | Global singleton, startup/shutdown orchestration |
| **Config** | `src/services/lsp/config.ts` | Loads server definitions from plugins |
| **Passive Feedback** | `src/services/lsp/passiveFeedback.ts` | Converts LSP notifications to Claude attachments |
| **Diagnostic Registry** | `src/services/lsp/LSPDiagnosticRegistry.ts` | Aggregates, deduplicates, and volume-limits diagnostics |

Data flows **bottom-up for requests** (Manager → Instance → Client → LSP server) and **top-down for notifications** (LSP server → Client → Instance → Passive Feedback → Diagnostic Registry → Claude conversation).

## Key Processes

### Startup & Initialization Flow

1. During Claude Code startup, `initializeLspServerManager()` is called (`src/services/lsp/manager.ts:145`). It skips initialization in bare/scripted mode.
2. A `LSPServerManager` singleton is created synchronously, then `initialize()` runs **asynchronously** in the background without blocking startup.
3. `initialize()` calls `getAllLspServers()` (`src/services/lsp/config.ts:15`) which loads all enabled plugins in parallel and extracts their LSP server configurations.
4. For each configured server, the manager builds a **file extension → server name** mapping and creates an `LSPServerInstance` (but does **not** start the process yet).
5. On success, `registerLSPNotificationHandlers()` is called to wire up diagnostic listeners on all server instances.

A **generation counter** (`initializationGeneration`) prevents stale initialization promises from corrupting state when `reinitializeLspServerManager()` is called after a plugin refresh.

### Lazy Server Start Flow

Servers are not started during initialization. They start on first use:

1. When a tool or file operation calls `ensureServerStarted(filePath)` (`src/services/lsp/LSPServerManager.ts:215`), the manager resolves the file extension to a server name.
2. If the server is in `stopped` or `error` state, `server.start()` is called.
3. `start()` in `src/services/lsp/LSPServerInstance.ts:135` invokes `client.start()` which:
   - Spawns the LSP server as a child process via stdio (`src/services/lsp/LSPClient.ts:98`)
   - Waits for the `spawn` event (critical: avoids ENOENT races)
   - Creates a `vscode-jsonrpc` `MessageConnection` over stdin/stdout
   - Applies any queued notification/request handlers
4. `client.initialize()` sends the LSP `initialize` request with workspace folders, client capabilities, and `initializationOptions` from the plugin config.
5. An optional `startupTimeout` races the initialization against a timer.

### File Synchronization Flow

The manager implements the LSP text document synchronization protocol:

1. **`openFile(filePath, content)`** — Sends `textDocument/didOpen` with language ID derived from the server's `extensionToLanguage` mapping. Tracks open files by URI to avoid duplicate opens.
2. **`changeFile(filePath, content)`** — Sends `textDocument/didChange` with full content. Falls back to `openFile` if the file hasn't been opened yet (LSP requires `didOpen` before `didChange`).
3. **`saveFile(filePath)`** — Sends `textDocument/didSave` to trigger server-side diagnostics.
4. **`closeFile(filePath)`** — Sends `textDocument/didClose` and removes the file from tracking.

### Diagnostic Delivery Pipeline

This is the most valuable flow — it enables Claude to see compiler errors and warnings:

1. LSP servers push `textDocument/publishDiagnostics` notifications asynchronously.
2. The passive feedback handler (`src/services/lsp/passiveFeedback.ts:161`) receives these, validates the params, and converts them to Claude's `DiagnosticFile[]` format via `formatDiagnosticsForAttachment()`.
3. Diagnostics are stored in the `LSPDiagnosticRegistry` via `registerPendingLSPDiagnostic()`.
4. On the next query turn, `checkForLSPDiagnostics()` retrieves pending diagnostics, applying:
   - **Within-batch deduplication** — by `(message, severity, range, source, code)` key
   - **Cross-turn deduplication** — via an LRU cache (max 500 files) so the same diagnostic isn't shown twice
   - **Volume limiting** — max 10 diagnostics per file, max 30 total
   - **Severity-based sorting** — errors first, then warnings, info, hints
5. The attachments system delivers these to Claude's conversation context.

When a file is edited, `clearDeliveredDiagnosticsForFile(fileUri)` resets the cross-turn dedup cache for that file so fresh diagnostics can flow through.

### Request Retry Logic

`LSPServerInstance.sendRequest()` (`src/services/lsp/LSPServerInstance.ts:355`) implements retry logic for transient errors:

- **Error code -32801** ("content modified") is retried up to 3 times with exponential backoff (500ms, 1000ms, 2000ms). This commonly occurs with rust-analyzer during project indexing.
- Uses duck typing for error code detection to handle multiple `vscode-jsonrpc` versions in the dependency tree.

### Crash Recovery

When an LSP server process exits with a non-zero code:

1. The `onCrash` callback in `src/services/lsp/LSPClient.ts:165` fires, setting the instance state to `error`.
2. On next use, `ensureServerStarted()` attempts to restart the server.
3. Crash recovery is capped at `maxRestarts` (default: 3) to prevent unbounded child process spawning.

## Function Signatures

### Singleton Manager (`src/services/lsp/manager.ts`)

#### `initializeLspServerManager(): void`
Synchronously creates the manager and kicks off async initialization. Skipped in bare mode. Idempotent — retries on prior failure.

#### `reinitializeLspServerManager(): void`
Force re-initializes after plugin refresh. Shuts down old servers (best-effort) and creates a fresh manager. No-op if `initializeLspServerManager()` was never called.

#### `getLspServerManager(): LSPServerManager | undefined`
Returns the singleton or `undefined` if not initialized/failed.

#### `isLspConnected(): boolean`
Returns `true` if at least one server is not in `error` state. Used by `LSPTool.isEnabled()`.

#### `shutdownLspServerManager(): Promise<void>`
Stops all servers and clears state. Errors are logged but not propagated.

### LSPServerManager (`src/services/lsp/LSPServerManager.ts`)

#### `ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>`
Lazily starts the appropriate server for a file. Returns `undefined` if no server handles the file type.

#### `sendRequest<T>(filePath, method, params): Promise<T | undefined>`
Routes an LSP request to the correct server, starting it if needed.

#### `openFile / changeFile / saveFile / closeFile`
LSP text document synchronization methods. All resolve file paths to URIs and derive language IDs from server config.

### LSPServerInstance (`src/services/lsp/LSPServerInstance.ts`)

Factory function `createLSPServerInstance(name, config)` returns an instance with:
- **State machine**: `stopped → starting → running → stopping → stopped`, with `error` reachable from any state
- `start() / stop() / restart()` — Lifecycle methods with `maxRestarts` enforcement
- `isHealthy()` — `true` when `state === 'running'` AND client is initialized
- `sendRequest<T>(method, params)` — With retry logic for transient errors

### LSP Client (`src/services/lsp/LSPClient.ts`)

`createLSPClient(serverName, onCrash?)` returns the low-level interface:
- `start(command, args, options)` — Spawns process, creates JSON-RPC connection
- `initialize(params)` — Sends LSP `initialize` + `initialized`
- `sendRequest / sendNotification / onNotification / onRequest` — Message passing
- `stop()` — Graceful `shutdown` → `exit` → process kill

### Diagnostic Registry (`src/services/lsp/LSPDiagnosticRegistry.ts`)

- `registerPendingLSPDiagnostic({ serverName, files })` — Stores incoming diagnostics
- `checkForLSPDiagnostics()` — Retrieves, deduplicates, volume-limits, and marks as delivered
- `clearDeliveredDiagnosticsForFile(fileUri)` — Resets dedup cache for edited files
- `resetAllLSPDiagnosticState()` — Full reset for session boundaries

## Configuration

LSP servers are configured exclusively through **plugins**. Each plugin can define servers with:

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string` | **Required.** Executable to spawn (e.g., `typescript-language-server`) |
| `args` | `string[]` | Command-line arguments (e.g., `["--stdio"]`) |
| `extensionToLanguage` | `Record<string, string>` | **Required.** Maps file extensions to language IDs (e.g., `{".ts": "typescript"}`) |
| `env` | `Record<string, string>` | Environment variables for the server process |
| `workspaceFolder` | `string` | Working directory (defaults to `getCwd()`) |
| `initializationOptions` | `object` | Passed to the server's `initialize` request (required by vue-language-server) |
| `startupTimeout` | `number` | Milliseconds to wait for initialization before timing out |
| `maxRestarts` | `number` | Maximum restart attempts (default: 3) |
| `restartOnCrash` | — | Not yet implemented (throws if set) |
| `shutdownTimeout` | — | Not yet implemented (throws if set) |

Server names are scoped with a `plugin:<pluginName>:` prefix to avoid cross-plugin conflicts.

## Client Capabilities Declared

The LSP client advertises a specific set of capabilities to servers (`src/services/lsp/LSPServerInstance.ts:189-236`):

- **Text synchronization**: `didSave` supported; `willSave`/`willSaveWaitUntil` not supported
- **Diagnostics**: `publishDiagnostics` with `relatedInformation`, severity tags (Unnecessary, Deprecated), `codeDescriptionSupport`
- **Hover**: Markdown and plaintext content formats
- **Definition**: With link support
- **References**: Basic support
- **Document symbols**: Hierarchical support
- **Call hierarchy**: Basic support
- **Workspace**: `configuration` and `workspaceFolders` both set to `false` — the client does not implement these. A fallback handler returns `null` for `workspace/configuration` requests that servers send anyway.
- **Position encoding**: UTF-16

## Edge Cases & Caveats

- **Bare mode skip**: LSP initialization is completely skipped when `isBareMode()` is true (scripted `-p` calls). LSP is only useful in the interactive REPL.
- **Lazy `require()`**: `LSPServerInstance` uses a runtime `require()` for `LSPClient` instead of a static import to avoid loading `vscode-jsonrpc` (~129KB) unless an LSP server is actually needed (`src/services/lsp/LSPServerInstance.ts:109-112`).
- **Spawn race condition**: `LSPClient.start()` explicitly waits for the `spawn` event before using stdio streams. Without this, `ENOENT` errors from invalid commands would cause unhandled promise rejections (`src/services/lsp/LSPClient.ts:110-131`).
- **Notification handler queuing**: `onNotification` and `onRequest` can be called before `start()`. Handlers are queued and applied once the connection is ready, enabling registration during initialization before the server is running (`src/services/lsp/LSPClient.ts:64-71`).
- **Cross-turn dedup uses LRU**: The `deliveredDiagnostics` cache is limited to 500 files via `LRUCache` to prevent unbounded memory growth in long sessions (`src/services/lsp/LSPDiagnosticRegistry.ts:54`).
- **Volume limiting**: At most 10 diagnostics per file and 30 total are delivered per turn, prioritized by severity (`src/services/lsp/LSPDiagnosticRegistry.ts:42-43`).
- **`closeFile` not yet integrated**: `closeFile()` exists but is not yet called during context compaction (noted as a TODO in `src/services/lsp/LSPServerManager.ts:377`).
- **Plugin refresh re-initialization**: `reinitializeLspServerManager()` exists specifically to fix a race condition where `loadAllPlugins()` memoization caches an empty plugin list before marketplace reconciliation completes (see issue #15521 referenced at `src/services/lsp/manager.ts:215`).
- **`isStopping` flag**: The client tracks intentional shutdowns to suppress spurious error logging during the `stop()` sequence (`src/services/lsp/LSPClient.ts:62`).
- **Notifications are fire-and-forget at client level**: `sendNotification` in `LSPClient` catches and logs errors without re-throwing (`src/services/lsp/LSPClient.ts:332-334`), while `LSPServerInstance.sendNotification` does propagate errors to callers.

## Key Code Snippets

### Server spawn and connection setup

The critical spawn-wait pattern that prevents ENOENT races:

```typescript
// src/services/lsp/LSPClient.ts:110-131
await new Promise<void>((resolve, reject) => {
  const onSpawn = (): void => { cleanup(); resolve() }
  const onError = (error: Error): void => { cleanup(); reject(error) }
  const cleanup = (): void => {
    spawnedProcess.removeListener('spawn', onSpawn)
    spawnedProcess.removeListener('error', onError)
  }
  spawnedProcess.once('spawn', onSpawn)
  spawnedProcess.once('error', onError)
})
```

### Extension-based server routing

```typescript
// src/services/lsp/LSPServerManager.ts:192-207
function getServerForFile(filePath: string): LSPServerInstance | undefined {
  const ext = path.extname(filePath).toLowerCase()
  const serverNames = extensionMap.get(ext)
  if (!serverNames || serverNames.length === 0) return undefined
  const serverName = serverNames[0]
  return servers.get(serverName)
}
```

### Diagnostic deduplication key

```typescript
// src/services/lsp/LSPDiagnosticRegistry.ts:110-124
function createDiagnosticKey(diag) {
  return jsonStringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source || null,
    code: diag.code || null,
  })
}
```

### Transient error retry with exponential backoff

```typescript
// src/services/lsp/LSPServerInstance.ts:367-397
for (let attempt = 0; attempt <= MAX_RETRIES_FOR_TRANSIENT_ERRORS; attempt++) {
  try {
    return await client.sendRequest(method, params)
  } catch (error) {
    const errorCode = (error as { code?: number }).code
    const isContentModifiedError =
      typeof errorCode === 'number' && errorCode === LSP_ERROR_CONTENT_MODIFIED
    if (isContentModifiedError && attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
      await sleep(delay)
      continue
    }
    break
  }
}
```