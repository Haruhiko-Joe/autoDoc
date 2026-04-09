# QueryLoop

## Overview & Responsibilities

The QueryLoop is the central orchestration engine for Claude Code's **non-interactive (headless) execution mode**. Implemented as the `runHeadlessStreaming` async generator function (`src/cli/print.ts:976-4143`), it drives the complete query lifecycle when Claude Code runs without a terminal UI — powering the SDK, piped (`--print`) mode, bridge sessions, and remote-controlled execution.

Within the architecture, QueryLoop sits inside the **CLIIOLayer** module of the **Bootstrap** subsystem. Its parent, `HeadlessQueryLoop`, wraps it with the `runHeadless` entry point that handles output formatting and process exit. Its sibling modules — `StructuredIOLayer` (NDJSON message framing) and `Transports` (WebSocket/SSE/CCR) — provide the I/O plumbing that QueryLoop reads from and writes to.

The generator yields `StdoutMessage` objects that the outer `runHeadless` function streams to SDK consumers as NDJSON events.

## Key Processes

### The `run()` Mutex and Command Draining

The innermost driver is the `run()` async function (`src/cli/print.ts:1865-2681`), which acts as a **single-flight mutex** — if `running` is already `true`, subsequent calls return immediately. This prevents concurrent query turns from overlapping.

1. `run()` sets `running = true`, notifies session state as `'running'`, and stops the idle timer.
2. It resolves any deferred plugin installation (`pluginInstallPromise`) on the first invocation, ensuring plugins are available before the first `ask()` call.
3. The `drainCommandQueue()` inner function (`src/cli/print.ts:1934-2366`) pops commands from the message queue in a `while` loop. **Consecutive prompt-mode commands are batched** via `canBatchWith()` (`src/cli/print.ts:443-453`) — commands with matching `workload` and `isMeta` flags are merged into a single `ask()` invocation using `joinPromptValues()`, so messages that queue up during a long turn coalesce into one follow-up rather than N separate turns.
4. For each (possibly batched) command, the loop assembles the full tool set via `buildAllTools()`, registers MCP elicitation handlers, and invokes the `ask()` query engine inside a `runWithWorkload()` context for billing attribution.
5. Streaming messages from `ask()` are forwarded to the output queue. **Result hold-back** logic (`src/cli/print.ts:2222-2244`) defers emitting the `result` message while background agents are still running, so the SDK consumer sees the final answer only after all agents complete.

### The do-while Background Agent Wait Loop

After `drainCommandQueue()` finishes, a `do-while` loop (`src/cli/print.ts:2371-2406`) keeps the session alive while background tasks exist:

1. Drains any pending SDK events (task_started, task_progress).
2. Re-drains the command queue (agents may have enqueued new task-notification commands).
3. Checks for running background tasks (excluding `in_process_teammate` which are long-lived by design).
4. If background tasks exist but no commands are queued, sleeps 100ms and loops back.
5. Once all background tasks complete, the held-back result (if any) is emitted along with any deferred prompt suggestions.

### The Stdin Message Loop

A parallel async IIFE (`src/cli/print.ts:2813-4140`) reads from `structuredIO.structuredInput` and processes incoming messages:

- **Control requests** (`initialize`, `set_permission_mode`, `set_model`, `mcp_set_servers`, `mcp_reconnect`, `mcp_toggle`, `mcp_authenticate`, `remote_control`, `side_question`, `stop_task`, `reload_plugins`, `apply_flag_settings`, `interrupt`, `end_session`, etc.) are handled inline without queuing.
- **User messages** are deduplicated by UUID (both against the session file and a runtime `Set` of 10K capacity), then enqueued and trigger `run()`.
- **Keep-alive**, **assistant/system replay**, and **control_response** messages are handled with type-specific logic.

When the input stream closes, `inputClosed` is set to `true`, the cron scheduler stops, and (if not currently running) the output stream is finalized.

### Post-Run Hooks and Re-entry

After the `run()` try/finally block (`src/cli/print.ts:2453-2473`):

1. **Proactive tick scheduling** (`src/cli/print.ts:2476-2485`): If proactive mode is active and the queue is empty, a `setTimeout(0)` injects a tick message to keep the model looping autonomously.
2. **Queue re-check** (`src/cli/print.ts:2492-2495`): Catches messages that arrived between the last `dequeue()` returning `undefined` and `running = false`, preventing stranded commands.
3. **Team lead inbox polling** (`src/cli/print.ts:2500-2635`): For coordinator-mode sessions, polls for unread teammate messages at 500ms intervals, processes `shutdown_approved` messages (removing teammates from the team file and unassigning tasks), and injects formatted teammate messages as prompts.
4. **Shutdown orchestration** (`src/cli/print.ts:2637-2680`): When input is closed, checks for active swarms that need shutdown prompts, waits for in-flight prompt suggestions, and closes the output stream.

## Function Signatures

### `runHeadlessStreaming(...): AsyncIterable<StdoutMessage>`

The main generator function. Not exported (called only by `runHeadless`).

| Parameter | Type | Description |
|-----------|------|-------------|
| `structuredIO` | `StructuredIO` | NDJSON I/O abstraction for stdin/stdout |
| `mcpClients` | `MCPServerConnection[]` | Initial MCP server connections from startup |
| `commands` | `Command[]` | Registered slash commands |
| `tools` | `Tools` | Base tool set (built-in + MCP) |
| `initialMessages` | `Message[]` | Resumed/continued conversation messages |
| `canUseTool` | `CanUseToolFn` | Permission checking callback |
| `sdkMcpConfigs` | `Record<string, McpSdkServerConfig>` | SDK-managed MCP server configurations |
| `getAppState` / `setAppState` | Functions | Application state accessor/mutator |
| `agents` | `AgentDefinition[]` | Available agent definitions |
| `options` | Object | Session configuration (model, thinking, maxTurns, etc.) |
| `turnInterruptionState` | `TurnInterruptionState?` | State for auto-resuming interrupted turns |

> Source: `src/cli/print.ts:976-1009`

### `buildAllTools(appState: AppState): Tools`

Assembles the complete tool set for an `ask()` call by merging built-in tools, SDK MCP tools, dynamic MCP tools, and assembled tools from appState. Filters out the permission prompt tool if configured, and injects a synthetic output tool when `initJsonSchema` is set.

> Source: `src/cli/print.ts:1474-1500`

### `forwardMessagesToBridge(): void`

Incrementally forwards new messages from `mutableMessages` to the bridge handle (for claude.ai remote control). Uses an index cursor (`bridgeLastForwardedIndex`) to avoid re-scanning already-sent messages. Guards against `mutableMessages` shrinking from compaction.

> Source: `src/cli/print.ts:1517-1531`

### `refreshPluginState(): Promise<void>`

Clears plugin caches, reloads commands/agents/hooks after plugin installation. Preserves SDK-provided agents (those with `source='flagSettings'`) while replacing all disk-loaded agents with fresh definitions.

> Source: `src/cli/print.ts:1760-1785`

### `applyPluginMcpDiff(): Promise<void>`

Re-diffs MCP configurations after plugin state changes, filtering to supported transport types and carrying SDK-mode servers through so their transports aren't closed.

> Source: `src/cli/print.ts:1792-1821`

### `installPluginsAndApplyMcpInBackground(): Promise<void>`

Waits for user settings download and managed settings, then installs plugins for headless mode and applies MCP differences.

> Source: `src/cli/print.ts:1704-1729`

## Configuration & Defaults

| Configuration | Source | Default | Description |
|---------------|--------|---------|-------------|
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | Env var | `false` | When `true`, blocks first `ask()` until plugins install |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS` | Env var | No timeout | Deadline for sync plugin install before proceeding without plugins |
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` | Env var | `undefined` | Enables auto-resume of interrupted turns on restart |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | Env var | `true` (unless defined falsy) | Controls prompt suggestion generation for SDK consumers |
| `CLAUDE_CODE_PROACTIVE` | Env var | `false` | Activates proactive tick scheduling |
| `maxTurns` | CLI option | `undefined` | Maximum number of query turns before stopping |
| `maxBudgetUsd` | CLI option | `undefined` | USD budget ceiling |
| `promptSuggestions` | SDK option | `false` | Enables push-model prompt suggestion generation |

Feature flags gating major subsystems: `PROACTIVE`/`KAIROS` (proactive ticks, channel handlers), `AGENT_TRIGGERS` (cron scheduler), `COORDINATOR_MODE` (team lead), `UDS_INBOX` (Unix domain socket callbacks), `EXTRACT_MEMORIES` (post-run memory extraction), `FILE_PERSISTENCE` (file state persistence after turns).

## Edge Cases & Caveats

- **Mutex race condition**: A message arriving between the last `dequeue()` and `running = false` would be stranded. The post-run re-check at `src/cli/print.ts:2492` explicitly handles this.

- **Background agent hold-back**: The `result` message is withheld while `local_agent` or `local_workflow` background tasks are running. Prompt suggestions generated during hold-back are also deferred and may be discarded if a new command arrives first.

- **`in_process_teammate` exclusion**: The do-while background agent loop explicitly excludes `in_process_teammate` tasks from the "still waiting" check — teammates are long-lived by design and would cause infinite loops (gh-30008).

- **Team lead shutdown**: When `inputClosed` is `true` and teammates are still active, a `SHUTDOWN_TEAM_PROMPT` is injected exactly once (`shutdownPromptInjected` flag) telling the model to shut down its team before producing a final response.

- **Duplicate message dedup**: User messages are checked against both the persisted session file (`doesMessageExistInSession`) and a runtime `Set` capped at 10,000 entries with FIFO eviction (`src/cli/print.ts:394-415`).

- **Plugin install timeout**: With `CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS`, a `Promise.race` ensures the first query isn't blocked indefinitely by slow plugin downloads.

- **Skill hot-reloading**: The `skillChangeDetector` subscription (`src/cli/print.ts:1824-1829`) clears the commands cache and reloads commands whenever skill definitions change on disk.

- **Cron scheduler**: Cron-fired prompts are marked as `isMeta: true` (hidden from transcript) and tagged with `WORKLOAD_CRON` for QoS-based billing attribution (`src/cli/print.ts:2709-2733`).

## Key Code Snippets

### Command Batching Logic

Consecutive prompt-mode commands with matching workload and isMeta flags are merged into one ask() call:

```typescript
// src/cli/print.ts:1949-1961
const batch: QueuedCommand[] = [command]
if (command.mode === 'prompt') {
  while (canBatchWith(command, peek(isMainThread))) {
    batch.push(dequeue(isMainThread)!)
  }
  if (batch.length > 1) {
    command = {
      ...command,
      value: joinPromptValues(batch.map(c => c.value)),
      uuid: batch.findLast(c => c.uuid)?.uuid ?? command.uuid,
    }
  }
}
```

### Result Hold-Back for Background Agents

```typescript
// src/cli/print.ts:2222-2244
if (message.type === 'result') {
  for (const event of drainSdkEvents()) {
    output.enqueue(event)
  }
  const currentState = getAppState()
  if (
    getRunningTasks(currentState).some(
      t =>
        (t.type === 'local_agent' || t.type === 'local_workflow') &&
        isBackgroundTask(t),
    )
  ) {
    heldBackResult = message
  } else {
    heldBackResult = null
    output.enqueue(message)
  }
}
```

### Post-Run Queue Re-Check

```typescript
// src/cli/print.ts:2487-2495
// Re-check the queue after releasing the mutex. A message may have
// arrived (and called run()) between the last dequeue() returning
// undefined and `running = false` above.
if (peek(isMainThread) !== undefined) {
  void run()
  return
}
```