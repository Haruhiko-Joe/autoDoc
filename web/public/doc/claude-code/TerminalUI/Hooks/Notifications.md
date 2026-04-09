# Notifications

## Overview & Responsibilities

The `src/hooks/notifs/` directory contains 16 React hooks responsible for surfacing startup and runtime notifications to the user within the terminal UI. These hooks sit within the **Hooks** module of the **TerminalUI** layer, acting as the bridge between backend state changes (model migrations, MCP failures, rate limits, etc.) and the notification bar visible in the REPL screen.

Most hooks follow a common pattern built on the `useStartupNotification` base hook, which provides:
- A **remote-mode gate** (notifications are suppressed in remote sessions)
- A **once-per-session guard** (via `useRef`) to prevent duplicate firings
- Support for sync or async compute functions that return `Notification | Notification[] | null`

Hooks that need to react to ongoing state changes (not just startup) use `useEffect` directly with the same remote-mode gate pattern instead of `useStartupNotification`.

## Key Processes

### Startup Notification Flow

1. A hook calls `useStartupNotification(compute)` (`src/hooks/notifs/useStartupNotification.ts:19-41`)
2. On first `useEffect` mount, the base hook checks `getIsRemoteMode()` (from `src/bootstrap/state.ts`) and the `hasRunRef` guard
3. If both pass, it calls the `compute` function (sync or async)
4. The returned `Notification` or `Notification[]` is forwarded to `addNotification()` from the notifications context (`src/context/notifications.tsx`)
5. Rejections are routed to `logError`

### Runtime Notification Flow

Some hooks (e.g., `useFastModeNotification`, `useDeprecationWarningNotification`, `useRateLimitWarningNotification`) subscribe to ongoing state changes via `useEffect` dependency arrays or event listeners (`onCooldownTriggered`, `onOrgFastModeChanged`, `onPluginsAutoUpdated`). These:

1. Check `getIsRemoteMode()` at the top of each effect
2. Compare current state against previously-shown notification refs to avoid duplicates
3. Call `addNotification()` (or `removeNotification()` for clearing stale ones)

## Hook Inventory

### `useStartupNotification` (base hook)
> `src/hooks/notifs/useStartupNotification.ts:19-41`

The foundation for most notification hooks. Accepts a compute function that runs exactly once on mount, gated by remote mode. Returns void.

**Signature**: `useStartupNotification(compute: () => Result | Promise<Result>): void`

Where `Result = Notification | Notification[] | null`.

---

### `useAutoModeUnavailableNotification`
> `src/hooks/notifs/useAutoModeUnavailableNotification.ts:19-56`

Shows a one-shot warning when the user cycles through permission modes (shift-tab carousel) past where auto mode would appear, but auto mode is unavailable. Triggers only when:
- The `TRANSCRIPT_CLASSIFIER` feature flag is enabled
- The mode wraps from a non-default/non-auto mode back to `default`
- Auto mode is unavailable (settings, circuit-breaker, or org-allowlist reasons)
- The user has previously opted into auto mode

**Does not use `useStartupNotification`** — instead watches `mode` and `isAutoModeAvailable` via `useAppState`.

| Property | Value |
|----------|-------|
| Key | `auto-mode-unavailable` |
| Color | `warning` |
| Priority | `medium` |

---

### `useCanSwitchToExistingSubscription`
> `src/hooks/notifs/useCanSwitchToExistingSubscription.tsx:13-15`

Prompts users who have a Claude Pro or Max subscription but aren't logged in with it. Checks the OAuth profile via API key to detect existing subscriptions. Shown up to 3 times (tracked in global config as `subscriptionNoticeCount`). Logs a `tengu_switch_to_subscription_notice_shown` analytics event.

| Property | Value |
|----------|-------|
| Key | `switch-to-subscription` |
| Priority | `low` |

---

### `useDeprecationWarningNotification`
> `src/hooks/notifs/useDeprecationWarningNotification.tsx:6-43`

Fires when the active model has a deprecation warning (via `getModelDeprecationWarning()`). Re-fires if the warning text changes (e.g., model switch), and resets tracking when the model is no longer deprecated. Watches `model` as a dependency.

| Property | Value |
|----------|-------|
| Key | `model-deprecation-warning` |
| Color | `warning` |
| Priority | `high` |

---

### `useFastModeNotification`
> `src/hooks/notifs/useFastModeNotification.tsx:12-161`

The most complex notification hook, managing four distinct fast-mode scenarios via three `useEffect` blocks:

1. **Org status change**: Subscribes to `onOrgFastModeChanged`. When org enables fast mode, shows availability notice. When org disables it while user has fast mode active, turns off fast mode and warns.
2. **Overage rejection**: Subscribes to `onFastModeOverageRejection`. Disables fast mode and shows the rejection message.
3. **Cooldown lifecycle**: Subscribes to `onCooldownTriggered` and `onCooldownExpired`. Uses `invalidates` to replace cooldown-start with cooldown-expired notifications (and vice versa). Cooldown messages differentiate between `overloaded` and `rate_limit` reasons.

| Key | Color | Priority |
|-----|-------|----------|
| `fast-mode-org-changed` | `fastMode` or `warning` | `immediate` |
| `fast-mode-overage-rejected` | `warning` | `immediate` |
| `fast-mode-cooldown-started` | `warning` | `immediate` |
| `fast-mode-cooldown-expired` | `fastMode` | `immediate` |

---

### `useIDEStatusIndicator`
> `src/hooks/notifs/useIDEStatusIndicator.tsx:17-75+`

Multi-faceted IDE integration notification. Accepts `ideInstallationStatus`, `ideSelection`, and `mcpClients` as props. Uses `useIdeConnectionStatus` to derive `ideStatus` and `ideName`. Manages several notification states:

- **IDE hint**: Shown after 3s delay for non-IDE terminals with no connection, up to 5 times (tracked in `ideHintShownCount` global config)
- **Connection status**: Shows connected/disconnected IDE status
- **Install errors**: Surfaces IDE extension installation failures
- **JetBrains info**: Special handling for JetBrains IDEs

| Key | Priority |
|-----|----------|
| `ide-status-hint` | `low` |
| `ide-status` | `low` |
| `ide-install-error` | `medium` |

---

### `useInstallMessages`
> `src/hooks/notifs/useInstallMessages.tsx:3-25`

Startup hook that calls `checkInstall()` and maps each install message to a notification. Priority is determined by message type:
- `error` or `userActionRequired` → `high`
- `path` or `alias` → `medium`
- Others → `low`

| Property | Value |
|----------|-------|
| Key | `install-message-{index}-{type}` |
| Color | `error` or `warning` |

---

### `useLspInitializationNotification`
> `src/hooks/notifs/useLspInitializationNotification.tsx:22-133`

Polls LSP server status every 5 seconds (when `ENABLE_LSP_TOOL` is set). Detects two failure types:
1. **Manager initialization failure**: The LSP manager itself failed to start
2. **Individual server errors**: Any LSP server entering an error state

Errors are deduplicated via a `notifiedErrorsRef` Set and also persisted to `appState.plugins.errors` for `/doctor` display. Notifications auto-dismiss after 8 seconds.

| Property | Value |
|----------|-------|
| Key | `lsp-error-{source}` |
| Priority | `medium` |
| Timeout | 8000ms |

---

### `useMcpConnectivityStatus`
> `src/hooks/notifs/useMcpConnectivityStatus.tsx:13-87`

Monitors MCP server connections and shows separate notifications for four failure categories:
1. **Failed local servers**: Non-IDE, non-claudeai-proxy servers in `failed` state
2. **Failed claude.ai connectors**: claudeai-proxy servers that previously connected but are now failed (indicates toolbox-service outage)
3. **Local servers needing auth**: Non-claudeai-proxy servers in `needs-auth` state
4. **Claude.ai connectors needing auth**: claudeai-proxy servers needing auth that previously connected

| Key | Color | Priority |
|-----|-------|----------|
| `mcp-failed` | `error` | `medium` |
| `mcp-claudeai-failed` | `error` | `medium` |
| `mcp-needs-auth` | `warning` | `medium` |
| `mcp-claudeai-needs-auth` | `warning` | `medium` |

---

### `useModelMigrationNotifications`
> `src/hooks/notifs/useModelMigrationNotifications.tsx:1-51`

Startup hook that checks global config for recent model migration timestamps (within 3 seconds). Currently handles two migrations:

1. **Sonnet 4.5 → 4.6**: Checks `sonnet45To46MigrationTimestamp`
2. **Opus Pro → default / Legacy Opus remap**: Checks `legacyOpusMigrationTimestamp` and `opusProMigrationTimestamp`. Legacy remaps get a longer timeout (8s) and include opt-out instructions via `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1`.

New migrations are added by appending entries to the `MIGRATIONS` array.

| Key | Color | Priority | Timeout |
|-----|-------|----------|---------|
| `sonnet-46-update` | `suggestion` | `high` | 3000ms |
| `opus-pro-update` | `suggestion` | `high` | 3000/8000ms |

---

### `useNpmDeprecationNotification`
> `src/hooks/notifs/useNpmDeprecationNotification.tsx:6-24`

Startup hook that warns users still running via npm to switch to the native installer. Skipped when in bundled mode, when `DISABLE_INSTALLATION_CHECKS` env var is set, or when installation type is `development`.

| Property | Value |
|----------|-------|
| Key | `npm-deprecation-warning` |
| Color | `warning` |
| Priority | `high` |
| Timeout | 15000ms |

---

### `usePluginAutoupdateNotification`
> `src/hooks/notifs/usePluginAutoupdateNotification.tsx:14-82`

Subscribes to `onPluginsAutoUpdated` events and shows a success notification when plugins are updated. Extracts plugin names from IDs (stripping the `@marketplace` suffix) and displays up to 2 names individually, or "{N} plugins" for larger updates. Directs users to `/reload-plugins`.

| Property | Value |
|----------|-------|
| Key | `plugin-autoupdate-restart` |
| Color | `success` |
| Priority | `low` |
| Timeout | 10000ms |

---

### `usePluginInstallationStatus`
> `src/hooks/notifs/usePluginInstallationStatus.tsx:10-127`

Monitors `appState.plugins.installationStatus` for failed marketplace and plugin installations. Uses `useMemo` to efficiently compute failure counts. Shows a combined notification when any installations fail, directing users to `/plugin for details`.

| Property | Value |
|----------|-------|
| Key | `plugin-install-failed` |
| Color | `error` |
| Priority | `medium` |

---

### `useRateLimitWarningNotification`
> `src/hooks/notifs/useRateLimitWarningNotification.tsx:11-113`

Manages two related notifications:

1. **Overage mode**: Fires immediately when `claudeAiLimits.isUsingOverage` becomes true. Suppressed for team/enterprise users without billing access. Resets when overage ends.
2. **Approaching limits**: Shows a warning when `getRateLimitWarning()` returns a non-null string. Deduplicates by comparing against the previously shown warning.

| Key | Priority |
|-----|----------|
| `limit-reached` | `immediate` |
| `rate-limit-warning` | `high` |

---

### `useSettingsErrors`
> `src/hooks/notifs/useSettingsErrors.tsx:9-68`

Monitors settings validation errors via `useSettingsChange` listener. When errors exist, shows a notification directing users to `/doctor`. Removes the notification when errors are resolved. Returns the errors array for use by other components.

| Property | Value |
|----------|-------|
| Key | `settings-errors` |
| Color | `warning` |
| Priority | `high` |
| Timeout | 60000ms |

---

### `useTeammateLifecycleNotification`
> `src/hooks/notifs/useTeammateShutdownNotification.ts:54-78`

Tracks in-process teammate task lifecycle changes. Uses notification folding (`fold` callback) to batch multiple spawn/shutdown events into a single notification like "3 agents spawned" or "2 agents shut down". Monitors `appState.tasks` for `InProcessTeammateTask` entries transitioning to `running` or `completed` status.

| Key | Priority | Timeout |
|-----|----------|---------|
| `teammate-spawn` | `low` | 5000ms |
| `teammate-shutdown` | `low` | 5000ms |

## Shared Patterns

### Remote Mode Gate
Every hook checks `getIsRemoteMode()` (from `src/bootstrap/state.ts`) before emitting notifications. Remote sessions (bridge, WebSocket) don't display terminal notifications.

### Notification Shape
All hooks produce objects conforming to the `Notification` type from `src/context/notifications.tsx`, with these key fields:
- `key`: Unique identifier for deduplication and removal
- `text` or `jsx`: Display content (plain string or React JSX)
- `priority`: `'low' | 'medium' | 'high' | 'immediate'`
- `color` (optional): Theme color (`'warning'`, `'error'`, `'success'`, `'suggestion'`, `'fastMode'`)
- `timeoutMs` (optional): Auto-dismiss duration
- `invalidates` (optional): Array of keys to remove when this notification fires
- `fold` (optional): Merge function for batching repeated notifications

Note: The compiled hook files import from paths with `.js` extensions (e.g., `'src/context/notifications.js'`, `'../../bootstrap/state.js'`), which is standard for TypeScript ESM module resolution. The actual source files on disk use `.ts`/`.tsx` extensions.

### React Compiler Output
Most `.tsx` files in this directory are compiled by the React compiler, resulting in `_c()` memoization wrappers and `_temp` function extractions. The original source logic is preserved in the base64 sourcemap comments.