# AppState

## Overview & Responsibilities

AppState is the global application state management layer for the Claude Code terminal UI. It sits within the **TerminalUI** module — the interactive terminal interface built on a customized Ink (React for CLI) rendering engine. Its sibling modules include the rendering pipeline, 100+ React components, screen-level layouts, and the keybinding system.

AppState has two main jobs:

1. **Canonical state store** (`src/state/`): A lightweight, framework-agnostic reactive store (`Store<AppState>`) that holds the single source of truth for the entire application's runtime state — settings, permission context, model configuration, task management, MCP connections, plugin state, UI state, and more.

2. **React context providers** (`src/context/`): A collection of scoped React contexts that provide domain-specific state to the component tree — queued messages, FPS metrics, mailbox communication, modal/overlay stacking, prompt overlays, notifications, statistics, and voice input.

The `AppStateProvider` component wires everything together: it creates the store, nests the context providers, and hooks up a settings-change listener so that file-system settings changes propagate reactively into the store.

## Key Processes

### Store Creation & Initialization Flow

1. `AppStateProvider` (React component) is mounted at the root of the Ink component tree (`src/state/AppState.tsx:37-110`)
2. It calls `createStore(getDefaultAppState(), onChangeAppState)` to build a `Store<AppState>` (`src/state/store.ts:10-34`)
3. `getDefaultAppState()` assembles the initial state from settings, thinking/prompt-suggestion defaults, empty collections for tasks/MCP/plugins, and the initial permission mode (`src/state/AppStateStore.ts:456-569`)
4. On mount, the provider checks if bypass-permissions mode needs to be disabled (remote settings may have loaded before mount) and disables it if so
5. `useSettingsChange` registers a file-system watcher; when any settings source changes, `applySettingsChange` is called to update the store

### State Change Side-Effect Flow (`onChangeAppState`)

Every `setState` call triggers `onChangeAppState` (`src/state/onChangeAppState.ts:43-171`), which diffs old vs. new state and fires side effects:

1. **Permission mode sync** (lines 65-92): When `toolPermissionContext.mode` changes, it notifies CCR (Claude Code Remote) via `notifySessionMetadataChanged` and the SDK status stream via `notifyPermissionModeChanged`. Externalizes internal-only modes (e.g., `bubble` → `default`) before notifying CCR to avoid noise.
2. **Model persistence** (lines 94-112): When `mainLoopModel` changes, persists/removes it from user settings and updates the bootstrap model override.
3. **Expanded view persistence** (lines 114-128): Saves `expandedView` state to global config as `showExpandedTodos`/`showSpinnerTree`.
4. **Verbose mode persistence** (lines 130-140): Syncs `verbose` flag to global config.
5. **Settings change** (lines 156-170): Clears auth credential caches (API key helper, AWS, GCP) and re-applies environment variables when `settings.env` changes.

### React State Subscription Flow

Components subscribe to AppState slices via `useAppState(selector)` (`src/state/AppState.tsx:142-163`):

1. Component calls `useAppState(s => s.someField)`
2. Internally uses React's `useSyncExternalStore` with the store's `subscribe`/`getState`
3. Only re-renders when the selected value changes (via `Object.is` comparison)
4. `useSetAppState()` returns a stable `setState` reference for write-only consumers (no re-renders)

## Function Signatures

### `createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T>`

Creates a minimal reactive store. The store skips updates when `Object.is(next, prev)` is true.

> Source: `src/state/store.ts:10-34`

### `getDefaultAppState(): AppState`

Returns the full default state object with settings, empty task/MCP/plugin maps, initial permission mode (respects teammate plan-mode), and feature defaults for thinking/prompt-suggestions.

> Source: `src/state/AppStateStore.ts:456-569`

### `useAppState<T>(selector: (state: AppState) => T): T`

Subscribe to a slice of AppState. Only re-renders when the selected value changes. **Do not** return new objects from the selector — `Object.is` will always see them as changed.

> Source: `src/state/AppState.tsx:142-163`

### `useSetAppState(): (updater: (prev: AppState) => AppState) => void`

Returns a stable `setState` updater. Components using only this hook never re-render from state changes.

> Source: `src/state/AppState.tsx:170-172`

### `useAppStateMaybeOutsideOfProvider<T>(selector): T | undefined`

Safe version that returns `undefined` when called outside `AppStateProvider`. Uses `NOOP_SUBSCRIBE` as fallback.

> Source: `src/state/AppState.tsx:186-198`

### `onChangeAppState({ newState, oldState }): void`

Global change handler invoked on every state transition. Syncs permission mode to CCR/SDK, persists model/config changes, and clears auth caches.

> Source: `src/state/onChangeAppState.ts:43-171`

## Selectors

Pure functions that derive computed values from `AppState` (`src/state/selectors.ts`):

### `getViewedTeammateTask(appState): InProcessTeammateTaskState | undefined`

Returns the currently viewed teammate task, validating it exists and is an in-process teammate task.

### `getActiveAgentForInput(appState): ActiveAgentForInput`

Determines where user input should be routed — to the leader, a viewed teammate, or a named agent. Returns a discriminated union: `{ type: 'leader' }`, `{ type: 'viewed', task }`, or `{ type: 'named_agent', task }`.

## Teammate View Helpers

Stateful transitions for the teammate transcript viewer (`src/state/teammateViewHelpers.ts`):

- **`enterTeammateView(taskId, setAppState)`**: Sets `viewingAgentTaskId`, marks the task with `retain: true` (blocks eviction, enables stream-append), and releases any previously viewed agent back to stub form.
- **`exitTeammateView(setAppState)`**: Returns to the leader's view, drops `retain`, clears messages, and optionally schedules eviction via `evictAfter` (30s grace period) for terminal tasks.
- **`stopOrDismissAgent(taskId, setAppState)`**: Context-sensitive action — aborts running agents, instantly dismisses terminal ones (sets `evictAfter: 0`).

## Context Providers

Each context in `src/context/` follows a consistent pattern: a `createContext` + a `Provider` component + consumer hooks.

| Context | Provider | Key Hooks | Purpose |
|---------|----------|-----------|---------|
| **QueuedMessage** | `QueuedMessageProvider` | `useQueuedMessage()` | Marks messages as queued with padding metadata; brief layout skips padding to avoid double-indent |
| **FpsMetrics** | `FpsMetricsProvider` | `useFpsMetrics()` | Provides a getter function for FPS tracking metrics |
| **Mailbox** | `MailboxProvider` | `useMailbox()` | Creates a per-session `Mailbox` instance for inter-component messaging; throws if used outside provider |
| **Modal** | `ModalContext` (raw export) | `useIsInsideModal()`, `useModalOrTerminalSize(fallback)`, `useModalScrollRef()` | Provides modal dimensions and scroll ref so components size themselves to the modal pane rather than the terminal |
| **Overlay** | Stored in `AppState.activeOverlays` | `useRegisterOverlay(id, enabled)`, `useIsOverlayActive()`, `useIsModalOverlayActive()` | Tracks active overlays (Select dialogs, etc.) for Escape key coordination; distinguishes modal vs non-modal (e.g., autocomplete) |
| **PromptOverlay** | `PromptOverlayProvider` | `usePromptOverlay()`, `useSetPromptOverlay()`, `usePromptOverlayDialog()`, `useSetPromptOverlayDialog()` | Portal for floating content above the prompt that escapes FullscreenLayout's `overflowY:hidden` clip; split into data/setter pairs so writers don't re-render on their own writes |
| **Notifications** | Stored in `AppState.notifications` | `useNotifications()` → `{ addNotification, removeNotification }` | Priority-based notification queue with `immediate` preemption, key-based invalidation, and `fold()` for combining same-key notifications (default 8s timeout) |
| **Stats** | `StatsProvider` | `useStats()`, `useCounter(name)`, `useGauge(name)` | In-memory metrics store with counters, gauges, histograms (reservoir sampling, p50/p95/p99), and set cardinality; flushes to project config on process exit |
| **Voice** | `VoiceProvider` | `useVoiceState(selector)`, `useSetVoiceState()`, `useGetVoiceState()` | Manages voice input state (idle/recording/processing, error, interim transcript, audio levels); uses its own `Store<VoiceState>` with `useSyncExternalStore` for slice-level subscriptions |

## Type Definitions

### `AppState`

The canonical application state type (`src/state/AppStateStore.ts:89-452`). Key sections:

| Category | Fields | Description |
|----------|--------|-------------|
| Settings & Config | `settings`, `verbose`, `mainLoopModel`, `mainLoopModelForSession`, `fastMode`, `effortValue` | Runtime configuration and model selection |
| Permissions | `toolPermissionContext`, `denialTracking`, `activeOverlays` | Permission mode, bypass mode, overlay tracking |
| UI State | `expandedView`, `isBriefOnly`, `footerSelection`, `viewSelectionMode`, `coordinatorTaskIndex` | Current view state and navigation |
| Tasks & Agents | `tasks`, `agentNameRegistry`, `foregroundedTaskId`, `viewingAgentTaskId`, `teamContext` | Multi-agent task management and team coordination |
| MCP & Plugins | `mcp`, `plugins`, `agentDefinitions` | MCP server connections, tools, plugin state |
| Bridge & Remote | `replBridge*` (12 fields), `remoteSessionUrl`, `remoteConnectionStatus` | Always-on bridge state and remote session management |
| Speculation | `speculation`, `speculationSessionTimeSavedMs`, `promptSuggestion` | Speculative execution and prompt suggestion state |
| Notifications | `notifications`, `elicitation` | Notification queue and MCP elicitation requests |

The type uses `DeepImmutable` for most fields to enforce immutability, with explicit exclusions for `tasks` (contains function types) and `agentNameRegistry` (Map).

### `Store<T>`

Minimal reactive store interface (`src/state/store.ts:4-8`):

```typescript
type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}
```

### `CompletionBoundary`

Discriminated union for speculation completion types: `complete`, `bash`, `edit`, or `denied_tool` (`src/state/AppStateStore.ts:42-50`).

### `Notification`

Either `TextNotification` (text + optional color) or `JSXNotification` (arbitrary React node). Supports `priority` levels (`low`/`medium`/`high`/`immediate`), `invalidates` keys, `fold()` for merging, and configurable `timeoutMs`.

### `VoiceState`

Voice input state: `voiceState` (`idle`/`recording`/`processing`), `voiceError`, `voiceInterimTranscript`, `voiceAudioLevels`, `voiceWarmingUp`.

## Edge Cases & Caveats

- **Nesting guard**: `AppStateProvider` throws if nested within another `AppStateProvider` — enforced via `HasAppStateContext` (`src/state/AppState.tsx:45-47`).
- **VoiceProvider conditional loading**: `VoiceProvider` is loaded only when the `VOICE_MODE` feature flag is active (DCE: dead-code elimination for external builds). Otherwise, a passthrough identity component is used (`src/state/AppState.tsx:14-18`).
- **Selector anti-pattern**: `useAppState` will silently cause excessive re-renders if the selector returns a new object each call. The hook relies on `Object.is` for change detection — always select existing sub-object references.
- **Overlay Escape coordination**: The overlay system distinguishes modal overlays (Select dialogs — capture all input) from non-modal overlays (autocomplete — allow typing). `useRegisterOverlay` auto-registers/unregisters on mount/unmount and invalidates the previous Ink frame on close to prevent ghost rendering artifacts.
- **Teammate view eviction**: When exiting a teammate view, terminal tasks get a 30-second grace period (`PANEL_GRACE_MS`) before eviction, keeping the row visible briefly. Instant dismiss sets `evictAfter: 0`.
- **Circular dependency avoidance**: `getDefaultAppState` uses `require()` (lazy) for teammate utilities, and `teammateViewHelpers.ts` inlines the `isLocalAgent` type check to avoid import cycles through `BackgroundTasksDialog`.
- **PromptOverlay clip workaround**: The prompt overlay system exists specifically to escape FullscreenLayout's `overflowY:hidden` clip (CC-668). Floating overlays use `position:absolute bottom="100%"` but Ink's clip stack intersects all descendants, so content is portaled out via context.