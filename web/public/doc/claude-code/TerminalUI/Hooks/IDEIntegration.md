# IDE Integration Hooks

## Overview & Responsibilities

The IDE Integration module is a collection of seven React hooks within the **TerminalUI → Hooks** layer that bridge Claude Code's terminal UI to IDE extensions (VS Code, JetBrains, etc.) via the **Model Context Protocol (MCP)**. These hooks enable bidirectional communication: the terminal detects a running IDE extension, connects to it as an MCP server, and then receives notifications (selections, @-mentions, log events) and sends RPC calls (diffs, tab management) over that connection.

Within the broader architecture, these hooks sit between the MCP client infrastructure (in `Services`) and the UI components (in `Components`/`Screens`). The REPL screen composes these hooks to wire up IDE awareness throughout the session.

## Key Hooks at a Glance

| Hook | File | Purpose |
|------|------|---------|
| `useIDEIntegration` | `src/hooks/useIDEIntegration.tsx` | Main initializer — detects IDE, configures MCP connection |
| `useIdeConnectionStatus` | `src/hooks/useIdeConnectionStatus.ts` | Derives connection status from MCP client list |
| `useIdeSelection` | `src/hooks/useIdeSelection.ts` | Tracks text selection changes in the IDE |
| `useIdeLogging` | `src/hooks/useIdeLogging.ts` | Forwards IDE log events to the analytics pipeline |
| `useIdeAtMentioned` | `src/hooks/useIdeAtMentioned.ts` | Receives @-mention file references from IDE |
| `useDiffInIDE` | `src/hooks/useDiffInIDE.ts` | Sends file diffs to the IDE for review/approval |
| `useLspPluginRecommendation` | `src/hooks/useLspPluginRecommendation.tsx` | Recommends LSP plugins based on edited file types |

## Key Processes

### IDE Detection & Auto-Connect Flow

`useIDEIntegration` (`src/hooks/useIDEIntegration.tsx:15-69`) orchestrates the initial connection:

1. On mount, it calls `initializeIdeIntegration()` from `src/utils/ide.ts`, passing callback functions for IDE detection, onboarding, and installation status.
2. When an IDE is detected, the `addIde` callback checks whether auto-connect is enabled by evaluating multiple sources:
   - Global config (`autoConnectIde` setting)
   - The `autoConnectIdeFlag` prop
   - Terminal type detection via `isSupportedTerminal()`
   - The `CLAUDE_CODE_SSE_PORT` env var (handles tmux/screen sessions where terminal detection breaks)
   - The `CLAUDE_CODE_AUTO_CONNECT_IDE` env var
3. If auto-connect is enabled and no IDE is already registered, it adds a dynamic MCP server config with type `ws-ide` or `sse-ide` based on the URL scheme.
4. The onboarding callback triggers `setShowIdeOnboarding(true)` and installation status updates flow through `setIDEInstallationState`.

### Connection Status Derivation

`useIdeConnectionStatus` (`src/hooks/useIdeConnectionStatus.ts:11-33`) is a pure derivation hook:

1. Searches the `mcpClients` array for a client named `'ide'`.
2. Extracts the IDE name from configs of type `sse-ide` or `ws-ide`.
3. Returns a status of `'connected'`, `'pending'`, `'disconnected'`, or `null` (no IDE client exists).

This is memoized via `useMemo` keyed on the `mcpClients` array.

### Selection Tracking via MCP Notifications

`useIdeSelection` (`src/hooks/useIdeSelection.ts:59-150`) registers a notification handler on the IDE's MCP client for `selection_changed` events:

1. Finds the connected IDE client via `getConnectedIdeClient()` from `src/utils/ide.ts`.
2. Tracks the current IDE client in a ref to detect reconnections — when the client changes, it resets the selection and re-registers handlers.
3. Validates incoming notification data against `SelectionChangedSchema` (Zod schema).
4. Computes `lineCount` from start/end positions, with a special case: if the cursor is at character 0 of the end line, that line is not counted as selected.
5. Calls the `onSelect` callback with `{ lineCount, lineStart, text, filePath }`.

### IDE Event Logging

`useIdeLogging` (`src/hooks/useIdeLogging.ts:18-41`) forwards IDE analytics events:

1. Registers a `log_event` notification handler on the connected IDE MCP client.
2. Prefixes all event names with `tengu_ide_` and forwards to the analytics `logEvent()` function.

### @-Mention File Tracking

`useIdeAtMentioned` (`src/hooks/useIdeAtMentioned.ts:33-76`) handles `at_mentioned` notifications:

1. Registers a notification handler for the `at_mentioned` method.
2. Converts line numbers from 0-based (IDE) to 1-based by adding 1 to both `lineStart` and `lineEnd`.
3. Calls the `onAtMentioned` callback with `{ filePath, lineStart, lineEnd }`.
4. Uses a ref to track the current IDE client and ignores stale notifications from previous connections.

### Sending Diffs to IDE

`useDiffInIDE` (`src/hooks/useDiffInIDE.ts:46-164`) is the most complex hook, enabling interactive diff review in the IDE:

1. **Eligibility check**: Verifies the IDE extension supports diffs (`hasAccessToIDEExtensionDiffFeature` from `src/utils/ide.ts`), the global config `diffTool` is `'auto'`, and the file is not a `.ipynb` notebook.
2. **Tab naming**: Generates a unique tab name like `✻ [Claude Code] filename.ts (a1b2c3) ⧉` using a random UUID prefix.
3. **Diff display** (`showDiffInIDE`, line 216-327): Reads the original file content, computes the patched version via `getPatchForEdits()` from `src/tools/FileEditTool/utils.ts`, handles WSL-to-Windows path conversion if needed, then calls `callIdeRpc('openDiff', ...)` to open a diff tab in the IDE.
4. **Result handling**: The RPC call resolves when the user acts in the IDE:
   - `FILE_SAVED` → accepts edits with the user's modified content
   - `TAB_CLOSED` → accepts the original proposed edits
   - `DIFF_REJECTED` → rejects edits (returns old content as new content)
5. **Edit recomputation** (`computeEditsFromContents`, line 170-200): After the user potentially modifies the diff, recomputes `FileEdit[]` from the old and new content strings using `getPatchFromContents` and `getEditsForPatch` from `src/tools/FileEditTool/utils.ts`.
6. **Cleanup**: Registers cleanup on abort signal and `beforeExit` to close the IDE tab, with race-condition guards.

### LSP Plugin Recommendation

`useLspPluginRecommendation` (`src/hooks/useLspPluginRecommendation.tsx:41-180`) detects file edits and suggests LSP plugins:

1. Watches `fileHistory.trackedFiles` from app state for newly edited files.
2. For each new file, calls `getMatchingLspPlugins(filePath)` from `src/utils/plugins/lspRecommendation.ts` to check if an LSP plugin is available for that file extension.
3. Shows at most **one recommendation per session** (tracked via `hasShownLspRecommendationThisSession()` from `src/bootstrap/state.ts`).
4. The user can respond with:
   - `'yes'` → installs the plugin via `installPluginAndNotify()`, registers it in user settings
   - `'no'` → if elapsed time ≥ 28s (timeout threshold), increments the ignored count
   - `'never'` → adds the plugin to the never-suggest list
   - `'disable'` → sets `lspRecommendationDisabled: true` in global config

## Function Signatures & Parameters

### `useIDEIntegration(props: UseIDEIntegrationProps): void`

Main initializer hook. Detects the IDE and sets up the dynamic MCP server config.

- **`autoConnectIdeFlag`** (`boolean | undefined`): Override flag to force auto-connect.
- **`ideToInstallExtension`** (`IdeType | null`): If set, triggers extension installation for this IDE type.
- **`setDynamicMcpConfig`**: State setter for the dynamic MCP config map.
- **`setShowIdeOnboarding`**: State setter to trigger IDE onboarding UI.
- **`setIDEInstallationState`**: State setter for extension installation progress.

> Source: `src/hooks/useIDEIntegration.tsx:15-69`

### `useIdeConnectionStatus(mcpClients?: MCPServerConnection[]): IdeConnectionResult`

Returns `{ status, ideName }` derived from the current MCP client list.

> Source: `src/hooks/useIdeConnectionStatus.ts:11-33`

### `useIdeSelection(mcpClients, onSelect): void`

Registers a `selection_changed` MCP notification handler.

- **`mcpClients`** (`MCPServerConnection[]`): Current MCP connections.
- **`onSelect`** (`(selection: IDESelection) => void`): Called with updated selection data.

> Source: `src/hooks/useIdeSelection.ts:59-150`

### `useIdeLogging(mcpClients: MCPServerConnection[]): void`

Forwards `log_event` notifications from the IDE to the analytics pipeline.

> Source: `src/hooks/useIdeLogging.ts:18-41`

### `useIdeAtMentioned(mcpClients, onAtMentioned): void`

Registers an `at_mentioned` MCP notification handler.

- **`onAtMentioned`** (`(atMentioned: IDEAtMentioned) => void`): Called with file path and 1-based line range.

> Source: `src/hooks/useIdeAtMentioned.ts:33-76`

### `useDiffInIDE(props: Props): { closeTabInIDE, showingDiffInIDE, ideName, hasError }`

Opens an interactive diff tab in the IDE for file edit approval.

- **`onChange`**: Callback invoked with the user's decision (`accept-once` or `reject`) and the final edits.
- **`toolUseContext`** (`ToolUseContext`): Provides MCP clients and an abort controller.
- **`filePath`** (`string`): The file being edited.
- **`edits`** (`FileEdit[]`): The proposed edits.
- **`editMode`** (`'single' | 'multiple'`): Whether to treat edits as a single hunk or multiple.

Returns:
- **`closeTabInIDE()`**: Manually close the diff tab.
- **`showingDiffInIDE`** (`boolean`): Whether the diff is currently displayed in the IDE.
- **`ideName`** (`string`): Display name of the connected IDE.
- **`hasError`** (`boolean`): Whether the diff display failed.

> Source: `src/hooks/useDiffInIDE.ts:46-164`

### `useLspPluginRecommendation(): UseLspPluginRecommendationResult`

Returns `{ recommendation, handleResponse }` for showing LSP plugin suggestions in the UI.

- **`recommendation`** (`LspRecommendationState`): Current recommendation or `null`.
- **`handleResponse`** (`(response: 'yes' | 'no' | 'never' | 'disable') => void`): Handler for the user's choice.

> Source: `src/hooks/useLspPluginRecommendation.tsx:41-180`

## Type Definitions

### `IdeStatus`

```typescript
type IdeStatus = 'connected' | 'disconnected' | 'pending' | null
```

### `IDESelection`

```typescript
type IDESelection = {
  lineCount: number
  lineStart?: number
  text?: string
  filePath?: string
}
```

Represents the user's current text selection in the IDE.

### `IDEAtMentioned`

```typescript
type IDEAtMentioned = {
  filePath: string
  lineStart?: number  // 1-based (converted from IDE's 0-based)
  lineEnd?: number    // 1-based
}
```

### `LspRecommendationState`

```typescript
type LspRecommendationState = {
  pluginId: string
  pluginName: string
  pluginDescription?: string
  fileExtension: string
  shownAt: number  // Timestamp for timeout detection
} | null
```

## Configuration & Environment Variables

| Variable / Config | Purpose | Default |
|---|---|---|
| `autoConnectIde` (global config) | Master toggle for IDE auto-connection | `false` |
| `CLAUDE_CODE_SSE_PORT` | IDE extension port; if set, forces auto-connect (useful in tmux/screen) | unset |
| `CLAUDE_CODE_AUTO_CONNECT_IDE` | Env var override for auto-connect (`true`/`false`) | unset |
| `diffTool` (global config) | Must be `'auto'` for IDE diff feature to activate | — |
| `lspRecommendationDisabled` (global config) | Disables LSP plugin recommendations | `false` |

## Edge Cases & Caveats

- **tmux/screen breaks terminal detection**: The `TERM_PROGRAM` env var is overwritten by terminal multiplexers. The hooks work around this by also checking `CLAUDE_CODE_SSE_PORT`, which is inherited through the environment.
- **WSL path conversion**: When the IDE runs on Windows but Claude Code runs in WSL, `useDiffInIDE` converts file paths using `WindowsToWSLConverter` (from `src/utils/idePathConversion.ts`) before sending them to the IDE via RPC.
- **Selection line counting**: If the end position is at character 0 of a line, that line is excluded from the count — this matches the common behavior where dragging to the start of the next line doesn't intend to include it.
- **@-mention line number conversion**: The IDE sends 0-based line numbers; `useIdeAtMentioned` converts them to 1-based before passing to the callback.
- **Stale notification guards**: Both `useIdeSelection` and `useIdeAtMentioned` track the current IDE client in refs and silently drop notifications from previous (disconnected) clients.
- **Diff race conditions**: `showDiffInIDE` uses an `isCleanedUp` flag to prevent double-cleanup when both abort signals and normal resolution fire.
- **LSP recommendation throttle**: Only one recommendation is shown per session. Dismissals via timeout (≥28s) are tracked separately from explicit dismissals.
- **No `.ipynb` diffs**: Jupyter notebook files are explicitly excluded from IDE diff review.
- **MCP lifecycle**: None of these hooks clean up notification handlers manually — MCP clients manage their own lifecycle, so handlers are discarded when the connection drops.