# Computer Use Orchestration

## Overview & Responsibilities

The `computerUse` module is the macOS computer control orchestration layer within Claude Code's Infrastructure → CoreUtilities → DomainHelpers hierarchy. It enables Claude to interact with the user's desktop — clicking, typing, taking screenshots, managing windows — by wrapping two native NAPI modules:

- **`@ant/computer-use-input`** (Rust/enigo) — mouse movement, clicks, scrolling, keyboard input, frontmost app detection
- **`@ant/computer-use-swift`** — SCContentFilter screenshots, NSWorkspace app management, TCC permission checks, CGEventTap hotkey handling

The module bridges these native capabilities into Claude Code's MCP tool system, exposing them as `mcp__computer-use__*` tools. It handles the full lifecycle: feature gating, permission dialogs, session locking, app hiding/unhiding, ESC hotkey abort, native module loading, CFRunLoop pumping, and turn-end cleanup.

Sibling domain helpers include hooks execution, Chrome extension support, deep link handling, and others. The computer use module depends on async coordination primitives (abort controllers, sleep), file utilities, and platform detection from other CoreUtilities siblings.

## Architecture

The module is organized into 15 files with clear separation of concerns:

| File | Role |
|------|------|
| `executor.ts` | `ComputerExecutor` implementation — wraps native modules into a unified interface |
| `wrapper.tsx` | Session context binding, tool dispatch, permission dialog, lock lifecycle |
| `mcpServer.ts` | MCP server construction for tool discovery (ListTools) |
| `setup.ts` | MCP config generation and tool allowlisting |
| `hostAdapter.ts` | Process-lifetime singleton adapter bridging executor + gates + logger |
| `gates.ts` | Feature flags and subscription gating via GrowthBook |
| `computerUseLock.ts` | File-based lock for single-session exclusivity |
| `cleanup.ts` | Turn-end cleanup: unhide apps, release lock, unregister hotkey |
| `escHotkey.ts` | Global Escape key → abort via CGEventTap |
| `drainRunLoop.ts` | CFRunLoop pump for `@MainActor` Swift methods under libuv |
| `inputLoader.ts` | Lazy loader/cache for `@ant/computer-use-input` |
| `swiftLoader.ts` | Lazy loader/cache for `@ant/computer-use-swift` |
| `toolRendering.tsx` | JSX rendering overrides for tool use/result messages in the terminal UI |
| `appNames.ts` | Installed app filtering and prompt-injection hardening |
| `common.ts` | Shared constants: server name, sentinel bundle ID, terminal detection, capabilities |

## Key Processes

### 1. Initialization & Tool Registration

When computer use is enabled (gated by `getChicagoEnabled()` in `gates.ts`), the startup flow is:

1. **`setup.ts:setupComputerUseMCP()`** builds the MCP server config and a list of `mcp__computer-use__*` tool names added to `allowedTools` (bypassing normal permission prompts since the package's `request_access` tool handles approval).
2. On first CU connection, **`mcpServer.ts:createComputerUseMcpServerForCli()`** constructs an in-process MCP server. It enumerates installed apps (with a 1s timeout) and builds the `ListTools` response with app names in the `request_access` description.
3. The MCP server exists **only for `ListTools`** — actual tool dispatch goes through `wrapper.tsx`.

### 2. Tool Dispatch Flow

When Claude invokes a `mcp__computer-use__*` tool:

1. **`wrapper.tsx:getComputerUseMCPToolOverrides()`** returns a `.call()` override that is spread onto the MCP tool object.
2. On first call, `getOrBind()` creates a `Binding`: it builds a `ComputerUseSessionContext` and passes it to the package's `bindSessionContext()`, which returns a `dispatch` function. This binding is cached for the process lifetime.
3. Each call updates `currentToolUseContext` (a module-level ref) so per-call values like `abortController` and `setToolJSX` are always current.
4. The `dispatch(toolName, args)` call enters the `@ant/computer-use-mcp` package, which:
   - Checks/acquires the file lock (via `checkCuLock` / `acquireCuLock` callbacks)
   - Runs permission gates (via `onPermissionRequest` → `runPermissionDialog`)
   - Calls the executor method
   - Returns MCP content blocks
5. The wrapper maps MCP content blocks (text + image) to Anthropic API format.

### 3. Native Module Execution & CFRunLoop Pump

The critical challenge: Swift's `@MainActor` methods and enigo's keyboard dispatch both queue work onto `DispatchQueue.main`. Under Electron this drains automatically via CFRunLoop, but **Node.js/libuv never drains the main queue** — promises hang forever.

**`drainRunLoop.ts`** solves this with a refcounted `setInterval` pump:

```typescript
// src/utils/computerUse/drainRunLoop.ts:61-79
export async function drainRunLoop<T>(fn: () => Promise<T>): Promise<T> {
  retain()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = fn()
    work.catch(() => {})
    const timeout = withResolvers<never>()
    timer = setTimeout(timeoutReject, TIMEOUT_MS, timeout.reject)
    return await Promise.race([work, timeout.promise])
  } finally {
    clearTimeout(timer)
    release()
  }
}
```

- `retain()` increments a counter and starts a 1ms `setInterval` calling `cu._drainMainRunLoop()` (Swift's `RunLoop.main.run`)
- `release()` decrements; at zero the pump stops
- 30s timeout prevents indefinite hangs
- Multiple concurrent calls share one pump via refcounting
- `retainPump()`/`releasePump()` are exported for long-lived registrations (the ESC hotkey tap)

The four `@MainActor` methods requiring the pump: `captureExcluding`, `captureRegion`, `apps.listInstalled`, `resolvePrepareCapture`.

### 4. Session Locking

**`computerUseLock.ts`** implements file-based mutual exclusion so only one Claude session controls the computer at a time.

The lock file lives at `~/.claude/computer-use.lock` and contains `{sessionId, pid, acquiredAt}`.

- **`tryAcquireComputerUseLock()`**: Uses `O_EXCL` (`'wx'` flag) for atomic test-and-set. If the file exists, checks ownership (same session → re-entrant) and PID liveness (dead process → stale recovery via unlink + retry). Returns `{kind: 'acquired', fresh: true|false}` or `{kind: 'blocked', by: sessionId}`.
- **`checkComputerUseLock()`**: Read-only check (no acquire). Used by `request_access` / `list_granted_applications` which defer lock acquisition per the package's contract.
- **`releaseComputerUseLock()`**: Unlinks if owned. Idempotent.
- A shutdown cleanup handler is registered via `registerCleanup()` so the lock is released even on `/exit` during a tool call.

### 5. Permission Management

When the `@ant/computer-use-mcp` package needs user approval for app access:

1. It calls `onPermissionRequest(req)` on the session context
2. **`wrapper.tsx:runPermissionDialog()`** renders a `<ComputerUseApproval>` React component via `setToolJSX`
3. The function returns a `Promise<CuPermissionResponse>` that resolves when the user responds
4. Abort (Ctrl+C) rejects the promise, and `setToolJSX(null)` clears the dialog in `finally`
5. Approved apps are persisted via `onAllowedAppsChanged` → `setAppState`

### 6. App Hiding/Unhiding Lifecycle

Before computer actions, non-target apps are hidden to prevent interference:

1. **`executor.ts:prepareForAction()`** calls `cu.apps.prepareDisplay()` with the allowlist and surrogate host, wrapped in `drainRunLoop()`. Returns the list of hidden bundle IDs.
2. **`wrapper.tsx:onAppsHidden()`** tracks hidden IDs in `appState.computerUseMcpState.hiddenDuringTurn`.
3. **`cleanup.ts:cleanupComputerUseAfterTurn()`** at turn end calls `unhideComputerUseApps()` on all tracked hidden apps, with a 5s timeout to prevent wedging on abort paths. Clears the tracking set.

### 7. ESC Hotkey Handling

**`escHotkey.ts`** registers a global CGEventTap that consumes Escape keypresses system-wide (prompt-injection defense — injected actions can't dismiss dialogs with Escape):

- **Registered** on fresh lock acquire in `wrapper.tsx:acquireCuLock()`. The callback calls `tuc().abortController.abort()`.
- **Unregistered** on lock release in `cleanup.ts`.
- Holds a `retainPump()` for its lifetime since the CGEventTap's `CFRunLoopSource` needs the pump.
- **`notifyExpectedEscape()`** punches a hole for model-synthesized Escapes. Called by `executor.ts:key()` before posting a bare Escape event. Swift schedules a 100ms decay to prevent the hole from eating the next user ESC.

### 8. Terminal as Surrogate Host

Since Claude Code runs in a terminal (no window), the executor detects the terminal emulator's bundle ID via `getTerminalBundleId()` (`common.ts:43-47`):

1. First checks `__CFBundleIdentifier` (set by LaunchServices, inherited by children)
2. Falls back to a lookup table: iTerm2, Apple Terminal, Ghostty, Kitty, Warp, VS Code

The terminal bundle ID is used as `surrogateHost` so `prepareDisplay` exempts it from hiding, the activate z-order walk skips it, and `withoutTerminal()` strips it from screenshot allow-lists.

## Function Signatures

### `createCliExecutor(opts): ComputerExecutor`
> `src/utils/computerUse/executor.ts:259-644`

Factory that returns the full `ComputerExecutor` interface. macOS-only (throws on other platforms).

- **opts.getMouseAnimationEnabled**: `() => boolean` — controls animated drag movement
- **opts.getHideBeforeActionEnabled**: `() => boolean` — controls pre-action app hiding

Key methods on the returned executor:
- `screenshot(opts)` / `zoom(region, allowedBundleIds, displayId?)` — captures via Swift, pre-sized to `targetImageSize` so the API transcoder doesn't resize
- `key(keySequence, repeat?)` — xdotool-style sequences (e.g. `"ctrl+shift+a"`), 8ms between iterations
- `type(text, {viaClipboard})` — direct typing or clipboard-paste (`pbcopy` → verify → `Cmd+V` → restore)
- `click(x, y, button, count, modifiers?)` — move-and-settle, then click with optional modifier bracket
- `drag(from?, to)` — animated ease-out-cubic at 60fps for press→to motion
- `prepareForAction(allowlistBundleIds, displayId?)` — hide non-target apps

### `cleanupComputerUseAfterTurn(ctx): Promise<void>`
> `src/utils/computerUse/cleanup.ts:30-86`

Called from three sites: natural turn end, abort during streaming, abort during tool execution. Unhides apps, unregisters ESC hotkey, releases lock, sends OS notification.

### `getComputerUseMCPToolOverrides(toolName): ComputerUseMCPToolOverrides`
> `src/utils/computerUse/wrapper.tsx:248-287`

Returns rendering overrides + `.call()` dispatch for a single CU tool. The `.call()` sets the per-call context ref, dispatches through the cached binder, and maps MCP content blocks to API format.

### `setupComputerUseMCP(): {mcpConfig, allowedTools}`
> `src/utils/computerUse/setup.ts:23-53`

Builds the MCP server config (stdio type, never actually spawned — intercepted by `client.ts`) and the `mcp__computer-use__*` tool name allowlist.

## Interface/Type Definitions

### `ComputerUseLock`
```typescript
type ComputerUseLock = {
  readonly sessionId: string   // Claude session that holds the lock
  readonly pid: number         // Process ID for liveness check
  readonly acquiredAt: number  // Timestamp for diagnostics
}
```

### `AcquireResult` / `CheckResult`
Lock operation outcomes — discriminated unions on `kind`:
- `'acquired'` (fresh or re-entrant), `'blocked'` (by session ID), `'free'`, `'held_by_self'`

### `ChicagoConfig` (gates.ts)
Feature gate configuration merged from GrowthBook with defaults:
- `enabled`, `pixelValidation`, `clipboardPasteMultiline`, `mouseAnimation`, `hideBeforeAction`, `autoTargetDisplay`, `clipboardGuard`, `coordinateMode` (`'pixels'` or normalized)

### `CuToolInput` (toolRendering.tsx)
Shape for rendering tool inputs: `coordinate`, `start_coordinate`, `text`, `apps`, `region`, `direction`, `amount`, `duration`.

## Configuration & Defaults

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `tengu_malort_pedway` | GrowthBook | `{enabled: false, ...}` | Full Chicago feature config |
| Subscription gate | `getSubscriptionType()` | — | Requires `max` or `pro` (or `ant` USER_TYPE) |
| `ALLOW_ANT_COMPUTER_USE_MCP` | Env var | unset | Override ant+monorepo disable |
| `COMPUTER_USE_INPUT_NODE_PATH` | Env var | — | Custom path to input NAPI binary |
| `COMPUTER_USE_SWIFT_NODE_PATH` | Env var | — | Custom path to Swift NAPI binary |
| `__CFBundleIdentifier` | Env var (LaunchServices) | — | Terminal bundle ID auto-detection |
| JPEG quality | Hardcoded | 0.75 | Screenshot compression quality |
| Move settle | Hardcoded | 50ms | HID round-trip settle after mouse move |
| Drain timeout | Hardcoded | 30s | Max wait for native @MainActor calls |
| Unhide timeout | Hardcoded | 5s | Max wait for app unhide on cleanup |
| App enum timeout | Hardcoded | 1s | Max wait for installed app enumeration |

## Edge Cases & Caveats

- **Coordinate mode is frozen at first read** (`gates.ts:68-71`). A mid-session GrowthBook flip would cause the model to see one mode while the executor transforms coordinates in another. The freeze prevents this.

- **Clipboard paste verifies round-trip** (`executor.ts:192-194`). If `pbcopy` → `pbpaste` doesn't match, `Cmd+V` is never pressed (would paste junk). The user's clipboard is always restored in `finally`.

- **Bare Escape detection** (`executor.ts:97-101`). Only single-element sequences matching "escape" or "esc" trigger the CGEventTap hole-punch. Modified sequences like `ctrl+escape` pass through without notification.

- **Orphaned drainRunLoop lambdas** (`executor.ts:488`). The `holdKey` method uses an `orphaned` flag to prevent a timeout-orphaned press lambda from continuing to push keys after the `finally` block's `releasePressed` has already run.

- **Terminal as surrogate host** — the sentinel `CLI_HOST_BUNDLE_ID` (`com.anthropic.claude-code.cli-no-window`) never matches a real frontmost app, so the package's "host is frontmost" safety branch is dead code. The terminal emulator's real bundle ID is used for hide-exemption and screenshot exclusion.

- **App name prompt injection hardening** (`appNames.ts`). Display names are sanitized: Unicode letters/marks/numbers only, 40 char max, no newlines or special chars. Known vendor apps (Apple, Google, Microsoft) bypass the char filter but still get length-capped.

- **Stale lock recovery** (`computerUseLock.ts:114-121`). If the owning process is dead (`process.kill(pid, 0)` throws), the lock is unlinked. Race between two recovering sessions is resolved by `O_EXCL` — only one create succeeds.

- **No click-through bracket**. Unlike the Cowork (Electron) implementation, there's no `setIgnoreMouseEvents` wrapper since the CLI has no window. The sentinel host bundle ID ensures the package's frontmost gate treats this correctly.