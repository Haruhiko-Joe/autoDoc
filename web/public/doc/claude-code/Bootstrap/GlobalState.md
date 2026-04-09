# GlobalState

## Overview & Responsibilities

GlobalState (`src/bootstrap/state.ts`) is the centralized, mutable, in-memory state store for the entire Claude Code session. It lives in the Bootstrap layer and acts as the **single source of truth** for session-wide configuration, runtime metrics, telemetry providers, and feature toggles that all other modules read from and write to.

Because it sits in the `bootstrap/` directory — a leaf of the import DAG — it has minimal dependencies and can be imported by any module without creating circular imports. The file is guarded by prominent comments (`DO NOT ADD MORE STATE HERE`, `THINK THRICE BEFORE MODIFYING`) emphasizing that additions should be rare and deliberate.

Within the broader architecture, GlobalState is a sibling to other Bootstrap concerns (CLI parsing, environment setup, telemetry initialization). Modules across every layer — QueryEngine, ToolSystem, TerminalUI, Services, and others — import individual getter/setter functions from this file to read or mutate session state.

## Key Concepts

### Architecture: Private Singleton + Exported Accessors

The module follows a strict encapsulation pattern:

1. A private `State` type defines all fields (~80 properties)
2. A private `getInitialState()` factory creates the default values
3. A module-level singleton `const STATE: State = getInitialState()` holds all mutable state
4. Every field is accessed exclusively through individually exported getter/setter functions

No external code ever touches the `STATE` object directly. This accessor pattern allows the module to enforce invariants (e.g., `switchSession` atomically updates both `sessionId` and `sessionProjectDir`) and add side-effects to mutations (e.g., `setUseCoworkPlugins` resets the settings cache).

```typescript
// src/bootstrap/state.ts:429
const STATE: State = getInitialState()
```

### State Categories

The ~80 fields in the `State` type break down into these logical groups:

| Category | Key Fields | Purpose |
|---|---|---|
| **Session identity** | `sessionId`, `parentSessionId`, `sessionProjectDir` | Uniquely identify the current session and its lineage |
| **Paths** | `originalCwd`, `projectRoot`, `cwd` | Track working directory and project root (symlink-resolved, NFC-normalized) |
| **Cost & usage tracking** | `totalCostUSD`, `modelUsage`, `totalLinesAdded/Removed` | Accumulate API costs, token counts, and code change metrics |
| **Timing** | `startTime`, `lastInteractionTime`, `totalAPIDuration`, `turnToolDurationMs` | Track session duration, idle time, and per-turn performance |
| **Model config** | `mainLoopModelOverride`, `initialMainLoopModel`, `modelStrings` | Store model selection and display strings |
| **Telemetry providers** | `meter`, `meterProvider`, `tracerProvider`, `loggerProvider`, `eventLogger` | OpenTelemetry SDK provider instances |
| **Telemetry counters** | `sessionCounter`, `locCounter`, `costCounter`, `tokenCounter`, etc. | Pre-created OTel counter instruments |
| **Session flags** | `isInteractive`, `isRemoteMode`, `sessionBypassPermissionsMode`, `kairosActive` | Boolean toggles for session modes |
| **API state** | `lastAPIRequest`, `lastAPIRequestMessages`, `lastMainRequestId` | Captured API payloads for bug reports and `/share` |
| **Hooks & SDK** | `registeredHooks`, `initJsonSchema`, `sdkBetas` | SDK callback hooks and structured output schema |
| **Prompt cache latches** | `afkModeHeaderLatched`, `fastModeHeaderLatched`, `cacheEditingHeaderLatched` | Sticky-on flags preventing prompt cache busting |
| **Plugins & channels** | `inlinePlugins`, `allowedChannels`, `useCoworkPlugins` | Plugin directories and channel server allowlists |
| **Cron & teams** | `sessionCronTasks`, `sessionCreatedTeams`, `scheduledTasksEnabled` | In-memory scheduled tasks and team lifecycle tracking |

## Key Processes

### Initialization

`getInitialState()` (`src/bootstrap/state.ts:260-426`) constructs a fresh state object with safe defaults:

1. Resolves the current working directory via `realpathSync` to follow symlinks, normalizing to NFC form. Falls back to raw `process.cwd()` on EPERM (e.g., CloudStorage mounts)
2. Sets `originalCwd`, `projectRoot`, and `cwd` all to the resolved path
3. Generates a fresh `sessionId` via `randomUUID()`
4. Initializes all counters, providers, and caches to `null`/empty
5. Sets `startTime` and `lastInteractionTime` to `Date.now()`

### Session Lifecycle

Three functions manage session identity transitions:

- **`regenerateSessionId()`** (`src/bootstrap/state.ts:435-450`): Creates a new UUID, optionally saves the old one as `parentSessionId`. Cleans up the old session's plan slug entry. Used when starting a new conversation within the same process.

- **`switchSession()`** (`src/bootstrap/state.ts:468-479`): Atomically sets both `sessionId` and `sessionProjectDir`, then emits a signal. Used by `/resume` to switch to a previously saved session. The atomic update prevents these two fields from drifting out of sync.

- **`onSessionSwitch`** (`src/bootstrap/state.ts:489`): A signal subscription point so other modules (e.g., `concurrentSessions.ts`) can react to session changes.

### Cost State Accumulation and Restore

Cost tracking follows an additive pattern:

1. Each API call invokes `addToTotalCostState()` with the incremental cost and per-model usage breakdown
2. Token counts are derived on-demand via `getTotalInputTokens()` / `getTotalOutputTokens()` using `lodash.sumBy` over the `modelUsage` map
3. On session resume, `setCostStateForRestore()` (`src/bootstrap/state.ts:881-916`) bulk-loads prior accumulated values and adjusts `startTime` backward so `getTotalDuration()` returns the correct wall-clock span

### Interaction Time Batching

To avoid calling `Date.now()` on every keypress, interaction time uses a dirty-flag pattern (`src/bootstrap/state.ts:665-689`):

1. `updateLastInteractionTime()` sets `interactionTimeDirty = true` (or flushes immediately if `immediate = true`)
2. `flushInteractionTime()` is called by Ink before each render cycle, batching many keypresses into a single timestamp update

### Scroll Drain Suspension

Background intervals can check `getIsScrollDraining()` before doing work, preventing event-loop contention during active scrolling (`src/bootstrap/state.ts:792-824`). A 150ms debounce timer auto-clears the flag after scroll activity stops. `waitForScrollIdle()` provides an async version for one-shot expensive operations.

### Beta Header Latching

Four "sticky-on" latches (`afkModeHeaderLatched`, `fastModeHeaderLatched`, `cacheEditingHeaderLatched`, `thinkingClearLatched`) prevent prompt cache busting when features toggle mid-session (`src/bootstrap/state.ts:226-248`). Once a beta header is first sent, the latch stays `true` for the remainder of the session. All four are reset together by `clearBetaHeaderLatches()` on `/clear` or `/compact`.

### Hook Registration

`registerHookCallbacks()` (`src/bootstrap/state.ts:1419-1434`) merges hook matchers into the `registeredHooks` map, keyed by `HookEvent`. It supports both SDK callback hooks and plugin native hooks (`RegisteredHookMatcher` union type). `clearRegisteredPluginHooks()` selectively removes plugin hooks while preserving SDK callbacks by filtering on the `pluginRoot` property.

### Telemetry Counter Setup

`setMeter()` (`src/bootstrap/state.ts:948-987`) accepts an OTel `Meter` and a counter factory, then initializes 8 named counters:
- `claude_code.session.count`
- `claude_code.lines_of_code.count`
- `claude_code.pull_request.count`
- `claude_code.commit.count`
- `claude_code.cost.usage` (USD)
- `claude_code.token.usage` (tokens)
- `claude_code.code_edit_tool.decision`
- `claude_code.active_time.total` (seconds)

### Test Reset

`resetStateForTests()` (`src/bootstrap/state.ts:919-930`) replaces every field with a fresh `getInitialState()` result. It throws if `NODE_ENV !== 'test'` to prevent accidental state resets in production.

## Function Signatures

### Session Management

| Function | Signature | Description |
|---|---|---|
| `getSessionId` | `(): SessionId` | Returns the current session UUID |
| `regenerateSessionId` | `(options?: { setCurrentAsParent?: boolean }): SessionId` | Creates a new session ID, optionally preserving parent lineage |
| `switchSession` | `(sessionId: SessionId, projectDir?: string \| null): void` | Atomically sets session ID and project directory |
| `onSessionSwitch` | Signal subscription | Register a callback for session changes |

### Path Management

| Function | Signature | Description |
|---|---|---|
| `getOriginalCwd` | `(): string` | The startup working directory (symlink-resolved) |
| `getProjectRoot` | `(): string` | Stable project root — set once at startup, not changed by mid-session worktree entry |
| `getCwdState` / `setCwdState` | `(): string` / `(cwd: string): void` | Current working directory (may change during session) |
| `setProjectRoot` | `(cwd: string): void` | Only for `--worktree` startup flag |

### Cost & Usage

| Function | Signature | Description |
|---|---|---|
| `addToTotalCostState` | `(cost: number, modelUsage: ModelUsage, model: string): void` | Accumulate cost from an API call |
| `getTotalCostUSD` | `(): number` | Total session cost |
| `getTotalInputTokens` | `(): number` | Sum of input tokens across all models |
| `getTotalOutputTokens` | `(): number` | Sum of output tokens across all models |
| `setCostStateForRestore` | `(params): void` | Bulk-restore cost state for resumed sessions |
| `resetCostState` | `(): void` | Zero out all cost/usage fields |

### Telemetry

| Function | Signature | Description |
|---|---|---|
| `setMeter` | `(meter: Meter, createCounter: Factory): void` | Initialize the OTel meter and all counters |
| `setMeterProvider` / `getMeterProvider` | `MeterProvider \| null` | OpenTelemetry MeterProvider |
| `setTracerProvider` / `getTracerProvider` | `BasicTracerProvider \| null` | OpenTelemetry TracerProvider |
| `setLoggerProvider` / `getLoggerProvider` | `LoggerProvider \| null` | OpenTelemetry LoggerProvider |
| `setEventLogger` / `getEventLogger` | `Logger \| null` | OTel event logger instance |

## Type Definitions

### `State` (private)

The core type with ~80 fields — not exported. All access is through getter/setter functions.

### `ChannelEntry`

```typescript
// src/bootstrap/state.ts:37-39
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }
```

Discriminated union for channel server allowlist entries. The `dev` flag marks entries loaded via `--dangerously-load-development-channels`.

### `AttributedCounter`

```typescript
// src/bootstrap/state.ts:41-43
export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}
```

A simplified counter interface wrapping OTel's counter API.

### `SessionCronTask`

```typescript
// src/bootstrap/state.ts:1280-1292
export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  agentId?: string  // Routes fires to a teammate's queue instead of main REPL
}
```

In-memory cron tasks with `durable: false` — they fire on schedule but are never persisted to disk.

### `InvokedSkillInfo`

```typescript
// src/bootstrap/state.ts:1502-1508
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}
```

Tracks skills invoked during the session for preservation across context compaction. Keyed by `${agentId}:${skillName}` to prevent cross-agent overwrites.

## Edge Cases & Caveats

- **`originalCwd` vs `projectRoot` vs `cwd`**: Three distinct path concepts. `originalCwd` is the resolved startup directory. `projectRoot` is set once at startup and stays stable even when `EnterWorktreeTool` changes the working directory mid-session — use it for project identity (history, skills, sessions). `cwd` tracks the current working directory and may change during the session.

- **`setProjectRoot` restriction**: Only the `--worktree` startup flag should call this. Mid-session worktree entry must NOT change projectRoot, or skills/history anchoring breaks.

- **Bootstrap isolation**: The file deliberately avoids importing from `src/utils/` or other non-bootstrap modules (enforced by a lint rule). The `randomUUID` import uses an explicit path alias to bypass this check, with a comment documenting the intent.

- **Prompt cache latches are sticky-on**: Once set to `true`, they stay `true` until an explicit `clearBetaHeaderLatches()` call. This prevents mid-session feature toggles from busting the server-side prompt cache (which costs ~50-70K tokens to rebuild).

- **`promptCache1hEligible` is latched on first evaluation**: Once set, mid-session overage flips don't change the cache TTL, preventing server-side prompt cache busting.

- **`resetStateForTests` guard**: Throws if `NODE_ENV !== 'test'` to prevent accidental state resets in production.

- **Scroll drain is module-scope, not in `STATE`**: The `scrollDraining` flag and timer live outside the State object because they're ephemeral hot-path flags that don't need test-reset support.

- **`switchSession` atomicity**: `sessionId` and `sessionProjectDir` always change together through `switchSession()` — there is no separate setter for `sessionProjectDir` — preventing them from drifting out of sync.

- **Error log ring buffer**: `addToInMemoryErrorLog()` caps at 100 entries, evicting the oldest on overflow (`src/bootstrap/state.ts:1215-1224`).

- **Slow operations are ant-only**: `addSlowOperation()` early-returns if `USER_TYPE !== 'ant'`, and filters out editor prompt sessions that are intentionally slow (`src/bootstrap/state.ts:1569-1587`).

- **`preferThirdPartyAuthentication()`**: Returns `true` for non-interactive sessions except VS Code extension (`src/bootstrap/state.ts:1234-1237`), reflecting that IDE extensions should behave as first-party for auth purposes.