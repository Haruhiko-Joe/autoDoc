# SessionLifecycle

## Overview & Responsibilities

SessionLifecycle encompasses the `runHeadless` entry point and its supporting functions in `src/cli/print.ts`. It is the top-level orchestrator for **non-interactive (headless) execution** of Claude Code — the code path used by the SDK, piped invocations (`--print`), bridge sessions, and remote workers.

Within the module hierarchy, SessionLifecycle lives under **Bootstrap → CLIIOLayer → HeadlessQueryLoop**. Its sibling modules include **StructuredIOLayer** (NDJSON message framing), **Transports** (WebSocket/SSE/CCR communication), and **Utilities** (safe JSON serialization, exit helpers). SessionLifecycle consumes StructuredIO/RemoteIO instances and delegates the actual query loop to `runHeadlessStreaming`, focusing on everything that happens *before* the first query and *after* the last response.

**Core responsibilities:**
- Validate CLI arguments and guard against invalid option combinations
- Instantiate the correct I/O channel (local `StructuredIO` or remote `RemoteIO`)
- Initialize sandbox, feature flags (GrowthBook), and Grove compliance checks
- Load or resume a conversation via `loadInitialMessages` (continue, resume, teleport)
- Restore agent settings from resumed sessions
- Handle the `--rewind-files` standalone operation
- Set up output format dispatch (text, JSON, stream-JSON with optional streamlined transformer)
- Wire up settings-change subscriptions and hook event handlers for headless mode
- Drive the streaming message loop and format the final output
- Drain pending memory extraction and trigger graceful shutdown

## Key Processes

### Startup Sequence (runHeadless entry)

1. **Early exit check** — If `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` is set, print startup timing and exit immediately (`src/cli/print.ts:494-503`)
2. **User settings download** — Fire an async download of user settings so it overlaps with subsequent setup (`src/cli/print.ts:510-515`)
3. **Settings change subscription** — Subscribe to `settingsChangeDetector` so managed-settings and policy updates are applied in headless mode where no React tree exists (`src/cli/print.ts:520-532`)
4. **Proactive activation fallback** — Activate proactive mode if the environment variable was injected after argv parsing (`src/cli/print.ts:538-545`)
5. **GC timer (Bun)** — Set up periodic garbage collection in Bun environments (`src/cli/print.ts:548-551`)
6. **Headless profiler** — Start the first-turn profiler and record checkpoints throughout initialization (`src/cli/print.ts:554-555`)
7. **Grove check** — For qualified non-interactive consumers, verify Grove requirements (`src/cli/print.ts:558-561`)
8. **GrowthBook init** — Initialize feature flags so they work in headless mode (`src/cli/print.ts:565`)
9. **Argument validation** — Validate option dependencies: `--resume-session-at` requires `--resume`, `--rewind-files` requires `--resume` and no prompt (`src/cli/print.ts:567-585`)

### IO Instantiation (getStructuredIO)

The `getStructuredIO` factory function (`src/cli/print.ts:5199-5233`) selects the appropriate I/O channel:

- If `sdkUrl` is provided → creates a `RemoteIO` instance (WebSocket/SSE transport)
- Otherwise → creates a local `StructuredIO` instance (stdin/stdout NDJSON)
- String prompts are normalized into a single-element async stream of `SDKUserMessage`
- Empty strings produce an empty stream

### Sandbox Initialization

After IO is created (`src/cli/print.ts:598-626`):
- If sandbox is required but unavailable, print the reason and exit
- If sandbox is enabled and available, initialize it with a callback that forwards network permission requests through the StructuredIO control protocol
- If sandbox is unavailable but not required, warn on stderr

### Hook Event Handlers

When `stream-json` output with `--verbose` is active, a hook event handler is registered (`src/cli/print.ts:628-674`) that converts hook lifecycle events (`started`, `progress`, `response`) into `system` NDJSON messages with subtypes `hook_started`, `hook_progress`, and `hook_response`.

### Session Loading (loadInitialMessages)

`loadInitialMessages` (`src/cli/print.ts:4893-5197`) resolves the initial conversation state based on the resume/continue/teleport options. It returns a `LoadInitialMessagesResult` containing the message history, any turn-interruption state, and the agent setting from the resumed session.

**Continue flow** (`options.continue`):
1. Call `loadConversationForResume()` with no session ID (picks up the most recent session)
2. Match coordinator mode to the resumed session
3. Switch to the resumed session's ID (unless forking)
4. Restore session state and metadata

**Teleport flow** (`options.teleport`):
1. Verify remote sessions are policy-allowed
2. Validate git state, then call `teleportResumeCodeSession()` with the session ID
3. Check out the teleported session's branch
4. Process messages for teleport resume

**Resume flow** (`options.resume`):
1. Parse the session identifier (UUID, JSONL file, or URL)
2. For CCR v2: hydrate the local transcript from remote internal events, restore worker metadata
3. For URL-based v1: hydrate from Session Ingress
4. Load the conversation and optionally slice at `resumeSessionAt`
5. Match coordinator mode and switch session IDs
6. Restore session state and metadata

**Default (new session)**: Returns messages from `processSessionStartHooks('startup')`.

### Agent Restoration

After messages are loaded (`src/cli/print.ts:707-727`), if no `--agent` flag or settings-based agent was provided, the function restores the agent from the resumed session's `agentSetting`. It updates app state, applies the agent's system prompt for non-built-in agents, and re-persists the agent setting for future resumes.

### Rewind-Files Handling

When `--rewind-files` is provided (`src/cli/print.ts:737-771`):
1. Find the target user message by UUID in the loaded messages
2. Call `handleRewindFiles()` to restore file state at that point
3. Print a success message and exit — no query loop runs

### Output Format Dispatch

The streaming loop (`src/cli/print.ts:864-915`) iterates over `runHeadlessStreaming` and dispatches output:

| Format | Behavior |
|--------|----------|
| `stream-json` + verbose | Each message written to StructuredIO as NDJSON |
| `stream-json` + streamlined | Messages transformed via `createStreamlinedTransformer()` before writing |
| `json` + verbose | All messages accumulated in array, serialized as JSON array at end |
| `json` (default) | Only the final `result` message serialized |
| text (default) | Final result's text written to stdout |

Control messages, keep-alive frames, stream events, and system events (session state changes, task notifications) are filtered out of the final result tracking.

### Shutdown Sequence

After the streaming loop completes (`src/cli/print.ts:959-974`):
1. Log headless profiler metrics for the final turn
2. If memory extraction is active, drain any in-flight extraction (`extractMemoriesModule.drainPendingExtraction()`)
3. Call `gracefulShutdownSync()` with exit code 0 for success or 1 if the last message was an error

## Function Signatures

### `runHeadless(inputPrompt, getAppState, setAppState, commands, tools, sdkMcpConfigs, agents, options): Promise<void>`

The main entry point for headless execution. Accepts the full set of CLI options, tools, commands, and state accessors. Orchestrates the entire session lifecycle from initialization through shutdown.

> Source: `src/cli/print.ts:455-974`

Key options:
- **continue** / **resume** / **teleport** — Session resumption modes (mutually exclusive)
- **outputFormat** — `"json"` | `"stream-json"` | `undefined` (text)
- **maxTurns** / **maxBudgetUsd** / **taskBudget** — Execution limits
- **systemPrompt** / **appendSystemPrompt** — Custom system prompt overrides
- **rewindFiles** — UUID of a user message to rewind file state to
- **sdkUrl** — URL for RemoteIO transport
- **setupTrigger** — `"init"` | `"maintenance"` for setup hooks

### `loadInitialMessages(setAppState, options): Promise<LoadInitialMessagesResult>`

Resolves the initial message history for the session based on continue/teleport/resume options.

> Source: `src/cli/print.ts:4893-5197`

### `getStructuredIO(inputPrompt, options): StructuredIO`

Factory that creates the correct IO instance — `StructuredIO` for local or `RemoteIO` for remote sessions.

> Source: `src/cli/print.ts:5199-5233`

### `removeInterruptedMessage(messages, interruptedUserMessage): void`

Removes an interrupted user message and its synthetic assistant sentinel from the message array. Used during gateway-triggered restarts to clean up history before re-enqueuing. Exported for testing.

> Source: `src/cli/print.ts:4875-4885`

### `emitLoadError(message, outputFormat): void`

Emits a load error either as a structured NDJSON `result` message (for `stream-json`) or as plain stderr text.

> Source: `src/cli/print.ts:4841-4866`

## Type Definitions

### `LoadInitialMessagesResult`

```typescript
type LoadInitialMessagesResult = {
  messages: Message[]
  turnInterruptionState?: TurnInterruptionState
  agentSetting?: string
}
```

> Source: `src/cli/print.ts:4887-4891`

## Configuration & Defaults

- **`CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER`** — When truthy (ant users only), prints startup time and exits immediately
- **`CLAUDE_CODE_REMOTE`** — Enables user settings download at startup
- **`CLAUDE_CODE_PROACTIVE`** — Runtime opt-in for proactive mode activation
- **`CLAUDE_CODE_STREAMLINED_OUTPUT`** — Enables streamlined message transformation for `stream-json` output
- **`CLAUDE_CODE_USE_CCR_V2`** — Uses CCR v2 internal events for session hydration during resume
- **`ENABLE_SESSION_PERSISTENCE`** — Enables v1 session hydration from Session Ingress
- **`NODE_ENV`** — Affects sandbox behavior in development mode
- Feature flags: `DOWNLOAD_USER_SETTINGS`, `PROACTIVE`, `KAIROS`, `STREAMLINED_OUTPUT`, `COORDINATOR_MODE`, `EXTRACT_MEMORIES`, `COMMIT_ATTRIBUTION`

## Edge Cases & Caveats

- **`--resume-session-at` requires `--resume`** — The function validates this dependency early and exits with an error if violated (`src/cli/print.ts:567-571`)
- **`--rewind-files` is standalone** — Cannot be combined with a prompt; requires `--resume`; exits immediately after rewinding without entering the query loop (`src/cli/print.ts:573-585`)
- **`stream-json` requires `--verbose`** — Validated at `src/cli/print.ts:787-793`; exits with error if missing
- **Empty resumed sessions with CCR v2** — `loadConversationForResume` may return an empty message array (not null) for freshly hydrated sessions; treated as a new session with SessionStart hooks (`src/cli/print.ts:5080-5102`)
- **Settings change in headless mode** — Because there is no React tree, settings changes are handled via a direct subscription to `settingsChangeDetector` rather than the `useSettingsChange` hook
- **Memory extraction drain** — After all output is flushed, `drainPendingExtraction()` is awaited to prevent the 5-second shutdown failsafe from killing an in-flight memory extraction agent
- **Orphaned permission responses** — Duplicate `control_response` deliveries (e.g., from WebSocket reconnect) are deduplicated via a `handledToolUseIds` set to prevent duplicate tool execution (`src/cli/print.ts:5272-5277`)
- **Sandbox required but unavailable** — If `sandbox.failIfUnavailable` is set and sandbox dependencies are missing, the session refuses to start rather than running unprotected