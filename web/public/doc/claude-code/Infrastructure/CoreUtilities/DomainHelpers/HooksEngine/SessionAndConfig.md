# Session and Configuration

## Overview & Responsibilities

The **SessionAndConfig** module is part of the HooksEngine within the Infrastructure > CoreUtilities > DomainHelpers layer. It provides three closely related capabilities:

1. **Session-scoped hook storage** (`sessionHooks.ts`) — an in-memory, per-session registry for ephemeral hooks (command, prompt, and function hooks) that live only as long as the session.
2. **Hook querying and display** (`hooksSettings.ts`, `hooksConfigManager.ts`) — utilities to aggregate hooks from all sources (user settings, project settings, local settings, session, plugin, built-in, policy/managed), compare them, render display strings, and sort by priority.
3. **Configuration snapshotting with policy enforcement** (`hooksConfigSnapshot.ts`) — captures the effective hooks configuration at startup and provides lazy-invalidation refreshes, respecting policy controls like `allowManagedHooksOnly` and `disableAllHooks`.

Sibling modules in the HooksEngine handle hook *execution* (bash, HTTP, prompt, agent runners) and event broadcasting. This module is focused on hook *storage*, *retrieval*, and *configuration resolution*.

---

## Key Processes

### Adding and Removing Session Hooks

Session hooks are stored in a `Map<string, SessionStore>` on `AppState.sessionHooks`, keyed by session ID. The Map is deliberately used (instead of a plain Record) so that `.set()` / `.delete()` mutations are O(1) and don't trigger store listener notifications — critical under high-concurrency scenarios like parallel agent spawning (`sessionHooks.ts:49-62`).

**Adding a hook:**

1. `addSessionHook()` or `addFunctionHook()` is called with a session ID, hook event, matcher string, and the hook definition.
2. The internal `addHookToSession()` helper retrieves or creates the `SessionStore` for that session.
3. It looks for an existing `SessionHookMatcher` with the same `matcher` + `skillRoot` combination. If found, the hook is appended to that matcher's hook list; otherwise, a new matcher entry is created (`sessionHooks.ts:180-205`).
4. The Map is mutated in-place and the *same* `prev` state is returned, avoiding unnecessary store listener notifications.

**Removing a hook:**

- `removeSessionHook()` removes by structural equality using `isHookEqual()`.
- `removeFunctionHook()` removes by hook ID, filtering across all matchers for the given event.
- Both prune empty matchers and empty event entries to keep the store clean.

### Retrieving Hooks by Type

Two separate getter functions split hooks into non-function and function categories:

- `getSessionHooks()` returns `Map<HookEvent, SessionDerivedHookMatcher[]>` with function hooks filtered out — these are the hooks that can be serialized to `HookMatcher` format for the execution pipeline (`sessionHooks.ts:302-330`).
- `getSessionFunctionHooks()` returns only the `FunctionHook` entries, which carry in-memory TypeScript callbacks and cannot be persisted (`sessionHooks.ts:345-392`).

### Aggregating Hooks from All Sources

`getAllHooks()` in `hooksSettings.ts` merges hooks from multiple origins into a flat `IndividualHookConfig[]` list:

1. Checks `policySettings.allowManagedHooksOnly` — if true, skips all user/project/local hooks entirely (`hooksSettings.ts:97-101`).
2. Iterates over `userSettings`, `projectSettings`, and `localSettings`, deduplicating by resolved file path (handles the case where home directory is also the project directory) (`hooksSettings.ts:110-141`).
3. Appends session hooks for the current session ID (`hooksSettings.ts:145-158`).

`groupHooksByEventAndMatcher()` in `hooksConfigManager.ts` extends this by also including registered plugin hooks and built-in hooks, organizing everything into a `Record<HookEvent, Record<matcherKey, IndividualHookConfig[]>>` structure suitable for UI rendering (`hooksConfigManager.ts:270-365`).

### Policy Enforcement in Configuration Snapshots

`hooksConfigSnapshot.ts` resolves which hooks are actually effective given the policy layer:

1. **`disableAllHooks` from policy** → returns empty `{}` (no hooks at all).
2. **`allowManagedHooksOnly` from policy** → returns only `policySettings.hooks`.
3. **`isRestrictedToPluginOnly('hooks')`** → returns only policy hooks (blocks user/project/local settings but not plugin hooks registered separately).
4. **`disableAllHooks` from non-managed settings** → managed hooks still run, non-managed are disabled.
5. **Otherwise** → returns the full merged settings from all sources.

This logic lives in `getHooksFromAllowedSources()` (`hooksConfigSnapshot.ts:18-53`).

### Hook Equality Comparison

`isHookEqual()` compares two hooks by type and content, not by timeout:

- `command` hooks: compared by `command`, `shell` (defaulting to bash), and `if` condition.
- `prompt` / `agent` hooks: compared by `prompt` and `if` condition.
- `http` hooks: compared by `url` and `if` condition.
- `function` hooks: always return `false` (no stable identifier for comparison).

> Source: `hooksSettings.ts:33-65`

---

## Function Signatures

### sessionHooks.ts

#### `addSessionHook(setAppState, sessionId, event, matcher, hook, onHookSuccess?, skillRoot?): void`

Adds a command or prompt hook to the session-scoped store.

- **setAppState** — state updater function from the app store
- **event** — the `HookEvent` to bind to (e.g., `PreToolUse`, `Stop`)
- **matcher** — pattern string that selects which invocations trigger the hook
- **hook** — a `HookCommand` (command, prompt, agent, or http type)
- **onHookSuccess** — optional callback invoked when the hook executes successfully
- **skillRoot** — optional path scoping the hook to a specific skill

#### `addFunctionHook(setAppState, sessionId, event, matcher, callback, errorMessage, options?): string`

Adds an in-memory function hook. Returns the hook's ID for later removal.

- **callback** — `(messages, signal?) => boolean | Promise<boolean>` — the validation function
- **errorMessage** — message shown when the callback returns `false`
- **options.timeout** — execution timeout in ms (default: 5000)
- **options.id** — custom ID; auto-generated if omitted

#### `removeFunctionHook(setAppState, sessionId, event, hookId): void`

Removes a function hook by its ID across all matchers for the given event.

#### `removeSessionHook(setAppState, sessionId, event, hook): void`

Removes a command/prompt hook by structural equality via `isHookEqual()`.

#### `getSessionHooks(appState, sessionId, event?): Map<HookEvent, SessionDerivedHookMatcher[]>`

Returns non-function session hooks. If `event` is provided, filters to that event only.

#### `getSessionFunctionHooks(appState, sessionId, event?): Map<HookEvent, FunctionHookMatcher[]>`

Returns only function hooks for the session, separated because they cannot be serialized.

#### `getSessionHookCallback(appState, sessionId, event, matcher, hook): { hook, onHookSuccess? } | undefined`

Looks up a specific hook entry including its `onHookSuccess` callback. Used by the execution pipeline to fire post-success side effects.

#### `clearSessionHooks(setAppState, sessionId): void`

Deletes all hooks for a session (e.g., on session end).

### hooksSettings.ts

#### `isHookEqual(a, b): boolean`

Structural equality check for hooks. Compares type, content, shell, and `if` condition. Function hooks are never considered equal.

#### `getHookDisplayText(hook): string`

Returns a human-readable string for a hook: the command string, prompt text, URL, or `"function"`.

#### `getAllHooks(appState): IndividualHookConfig[]`

Aggregates hooks from user/project/local settings and session hooks into a flat list. Respects `allowManagedHooksOnly` policy.

#### `sortMatchersByPriority(matchers, hooksByEventAndMatcher, selectedEvent): string[]`

Sorts matcher strings by the priority of their source, using the `SOURCES` ordering (user > project > local). Plugin and built-in hooks get lowest priority.

### hooksConfigManager.ts

#### `getHookEventMetadata(toolNames): Record<HookEvent, HookEventMetadata>`

Memoized function (keyed on sorted tool names) returning metadata for all 27 hook events: summary, description, and optional matcher metadata with allowed values.

#### `groupHooksByEventAndMatcher(appState, toolNames): Record<HookEvent, Record<string, IndividualHookConfig[]>>`

Groups all hooks (settings + registered plugins + built-in) by event and matcher key for UI display.

#### `getSortedMatchersForEvent(hooksByEventAndMatcher, event): string[]`

Returns matcher keys for an event, sorted by source priority.

#### `getHooksForMatcher(hooksByEventAndMatcher, event, matcher): IndividualHookConfig[]`

Retrieves the hook list for a specific event + matcher combination.

### hooksConfigSnapshot.ts

#### `captureHooksConfigSnapshot(): void`

Captures the effective hooks configuration (respecting policy). Called once at startup.

#### `updateHooksConfigSnapshot(): void`

Refreshes the snapshot after external settings changes. Resets the settings cache first to ensure fresh disk reads.

#### `getHooksConfigFromSnapshot(): HooksSettings | null`

Returns the cached snapshot, lazily capturing if none exists.

#### `shouldAllowManagedHooksOnly(): boolean`

Returns `true` when only managed/policy hooks should run — either because `allowManagedHooksOnly` is set, or because non-managed settings set `disableAllHooks` (which can't disable managed hooks).

#### `shouldDisableAllHooksIncludingManaged(): boolean`

Returns `true` only when policy settings explicitly sets `disableAllHooks: true`.

#### `resetHooksConfigSnapshot(): void`

Clears the cached snapshot and resets SDK init state. Intended for testing.

---

## Type Definitions

### `FunctionHook`

| Field | Type | Description |
|-------|------|-------------|
| type | `'function'` | Discriminant tag |
| id | `string?` | Optional unique ID for removal |
| timeout | `number?` | Execution timeout in ms |
| callback | `FunctionHookCallback` | The validation function |
| errorMessage | `string` | Message shown on failure |
| statusMessage | `string?` | Custom display text |

### `FunctionHookCallback`

```typescript
type FunctionHookCallback = (messages: Message[], signal?: AbortSignal) => boolean | Promise<boolean>
```

### `SessionStore`

```typescript
type SessionStore = {
  hooks: { [event in HookEvent]?: SessionHookMatcher[] }
}
```

### `SessionHooksState`

```typescript
type SessionHooksState = Map<string, SessionStore>
```

A `Map` (not a Record) to enable O(1) mutation without triggering store listeners.

### `HookSource`

```typescript
type HookSource = EditableSettingSource | 'policySettings' | 'pluginHook' | 'sessionHook' | 'builtinHook'
```

### `IndividualHookConfig`

| Field | Type | Description |
|-------|------|-------------|
| event | `HookEvent` | The hook event type |
| config | `HookCommand` | The hook definition |
| matcher | `string?` | Pattern string |
| source | `HookSource` | Where the hook was defined |
| pluginName | `string?` | Plugin identifier (for plugin hooks) |

### `HookEventMetadata`

| Field | Type | Description |
|-------|------|-------------|
| summary | `string` | Short description of the event |
| description | `string` | Detailed behavior documentation |
| matcherMetadata | `MatcherMetadata?` | Field name and allowed values for matching |

---

## Edge Cases & Caveats

- **Map mutation pattern**: `SessionHooksState` uses a `Map` and returns the same `prev` reference from state updaters. This is intentional — session hooks are ephemeral runtime state never read reactively; only `getAppState()` snapshots matter. This avoids O(N²) copy overhead and ~30 listener notifications per hook add under parallel agent concurrency (`sessionHooks.ts:49-62`).

- **Function hooks cannot be serialized**: Function hooks carry in-memory callbacks and are always separated from command/prompt hooks in retrieval. `isHookEqual()` always returns `false` for function hooks — they can only be removed by ID.

- **Duplicate file path deduplication**: When the working directory is the home directory, `userSettings` and `projectSettings` resolve to the same file. `getAllHooks()` deduplicates via resolved path comparison (`hooksSettings.ts:112-121`).

- **Policy cannot be overridden by non-managed settings**: `disableAllHooks` in user/project/local settings only disables non-managed hooks. Managed hooks always run unless the policy itself sets `disableAllHooks`. This is enforced in `getHooksFromAllowedSources()`.

- **Snapshot staleness**: `updateHooksConfigSnapshot()` explicitly calls `resetSettingsCache()` before re-reading, because the file watcher's stability threshold may not have elapsed yet after an external edit.

- **`getHookEventMetadata` memoization**: The resolver key is the sorted-joined tool names string. This prevents cache leaks when callers (like `HooksConfigMenu`) pass a fresh array reference on every render (`hooksConfigManager.ts:266`).

- **Built-in hooks visibility**: Built-in hooks (internal callbacks like attribution hooks) are only shown in the UI when `USER_TYPE === 'ant'`, and display as `[ANT-ONLY] Built-in Hook` (`hooksConfigManager.ts:346-359`).