# Coordinator

## Overview & Responsibilities

The Coordinator module (`src/coordinator/coordinatorMode.ts`) controls whether Claude Code operates in **coordinator mode** — a multi-agent orchestration mode where the main Claude session acts as a task coordinator that delegates work to parallel worker agents instead of executing tools directly.

Within the **RemoteAndBridge** subsystem, the Coordinator sits alongside the Bridge (claude.ai WebSocket sessions), Remote (remote agent sessions), and Server (direct-connect sessions) modules. While those modules handle transport and session management, the Coordinator module governs the behavioral mode of the session itself — determining which tools are available, what system prompt is used, and how sessions are resumed.

The module is a single file exporting four functions:

| Function | Purpose |
|---|---|
| `isCoordinatorMode()` | Checks whether the current session is in coordinator mode |
| `matchSessionMode()` | Reconciles coordinator mode with a resumed session's stored mode |
| `getCoordinatorUserContext()` | Generates user-context metadata describing worker capabilities |
| `getCoordinatorSystemPrompt()` | Returns the full coordinator system prompt |

## Key Processes

### Mode Activation Flow

Coordinator mode requires **two conditions** to be active:

1. The `COORDINATOR_MODE` **build-time feature flag** must be enabled (checked via `feature('COORDINATOR_MODE')` from `bun:bundle`)
2. The **environment variable** `CLAUDE_CODE_COORDINATOR_MODE` must be truthy (e.g., `"1"`, `"true"`)

```typescript
// src/coordinator/coordinatorMode.ts:36-41
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

If the feature flag is compiled out, the function always returns `false` regardless of the environment variable. This allows dead-code elimination in builds where coordinator mode is disabled.

### Tool Filtering

When coordinator mode is active, the available tool set is drastically restricted. The coordinator can only use orchestration tools — it cannot read files, run commands, or edit code directly. All code-level work is delegated to workers.

**Coordinator tools** (defined in `src/constants/tools.ts:107-112`):
- `Agent` — spawn a new worker
- `TaskStop` — stop a running worker
- `SendMessage` — send a follow-up message to an existing worker
- `SyntheticOutput` — structured output
- PR activity subscription tools (dynamically allowed)

**Worker tools** — Workers receive the standard `ASYNC_AGENT_ALLOWED_TOOLS` set (Read, Grep, Glob, Bash, Edit, Write, NotebookEdit, WebSearch, WebFetch, TodoWrite, Skill, ToolSearch, EnterWorktree, ExitWorktree), minus internal-only tools (`TeamCreate`, `TeamDelete`, `SendMessage`, `SyntheticOutput`).

The filtering is applied via `applyCoordinatorToolFilter()` in `src/utils/toolPool.ts:35-41`, which is invoked from both the REPL path and the headless path to stay in sync.

**Simple mode override**: When `CLAUDE_CODE_SIMPLE` is truthy, the worker tool list is narrowed to just `Bash`, `Read`, and `Edit` (`src/coordinator/coordinatorMode.ts:88-91`).

### Session Resume & Mode Matching

When a user resumes a previous conversation, the session's stored mode (`'coordinator'` or `'normal'`) may not match the current environment. `matchSessionMode()` handles this reconciliation:

1. If no mode is stored (old session before mode tracking), do nothing
2. If the current mode matches the stored mode, do nothing
3. If mismatched, **flip the environment variable** so `isCoordinatorMode()` returns the correct value
4. Log an analytics event (`tengu_coordinator_mode_switched`)
5. Return a warning message like `"Entered coordinator mode to match resumed session."`

```typescript
// src/coordinator/coordinatorMode.ts:49-78
export function matchSessionMode(
  sessionMode: 'coordinator' | 'normal' | undefined,
): string | undefined
```

This function is called from multiple resume paths: `REPL.tsx`, `ResumeConversation.tsx`, `print.ts`, and `sessionRestore.ts`. The mode is persisted via a `saveMode()` function called at session start and after `/clear` commands.

### User Context Generation

`getCoordinatorUserContext()` builds a key-value map injected into the system prompt's user context section. This tells the coordinator what tools its workers have access to.

```typescript
// src/coordinator/coordinatorMode.ts:80-108
export function getCoordinatorUserContext(
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
): { [k: string]: string }
```

The output includes:
- **Worker tool list** — a sorted, comma-separated list of tool names (filtered to exclude internal tools)
- **MCP server names** — if any MCP clients are connected, their names are appended
- **Scratchpad directory** — if scratchpad is enabled (gated by the `tengu_scratch` feature gate), the shared scratchpad path is included so the coordinator can instruct workers to use it for cross-worker knowledge sharing

The scratchpad gate check is duplicated from `utils/permissions/filesystem.ts` via `isScratchpadGateEnabled()` to break a circular dependency (`src/coordinator/coordinatorMode.ts:19-27`). The actual scratchpad path is dependency-injected from `QueryEngine.ts`.

## Function Signatures

### `isCoordinatorMode(): boolean`

Returns `true` if the `COORDINATOR_MODE` feature flag is enabled and `CLAUDE_CODE_COORDINATOR_MODE` env var is truthy. No caching — reads the env var live on each call, which allows `matchSessionMode()` to flip it at runtime.

> Source: `src/coordinator/coordinatorMode.ts:36-41`

### `matchSessionMode(sessionMode): string | undefined`

| Parameter | Type | Description |
|---|---|---|
| `sessionMode` | `'coordinator' \| 'normal' \| undefined` | The mode stored in the resumed session |
| **Returns** | `string \| undefined` | Warning message if mode was switched, `undefined` otherwise |

> Source: `src/coordinator/coordinatorMode.ts:49-78`

### `getCoordinatorUserContext(mcpClients, scratchpadDir): { [k: string]: string }`

| Parameter | Type | Description |
|---|---|---|
| `mcpClients` | `ReadonlyArray<{ name: string }>` | Connected MCP server descriptors |
| `scratchpadDir` | `string \| undefined` | Path to the shared scratchpad directory |
| **Returns** | `{ [k: string]: string }` | Empty object if not in coordinator mode; otherwise `{ workerToolsContext: string }` |

> Source: `src/coordinator/coordinatorMode.ts:80-108`

### `getCoordinatorSystemPrompt(): string`

Returns the full multi-section system prompt used when the session is in coordinator mode. This prompt defines the coordinator's role, available tools (`Agent`, `SendMessage`, `TaskStop`), worker management patterns, concurrency guidelines, prompt-writing best practices, and a complete example session. The prompt varies slightly based on `CLAUDE_CODE_SIMPLE` — in simple mode, worker capabilities are described as "Bash, Read, and Edit" only.

This function is called from `src/utils/systemPrompt.ts:68-72`, which lazy-requires it to avoid circular dependencies.

> Source: `src/coordinator/coordinatorMode.ts:111-369`

## Configuration & Defaults

| Config | Type | Default | Description |
|---|---|---|---|
| `CLAUDE_CODE_COORDINATOR_MODE` | Env var | unset (disabled) | Enables coordinator mode when truthy |
| `CLAUDE_CODE_SIMPLE` | Env var | unset | Restricts worker tools to Bash/Read/Edit when truthy |
| `COORDINATOR_MODE` | Build feature flag | varies by build | Compile-time gate; if off, all coordinator code is dead-code eliminated |
| `tengu_scratch` | Statsig feature gate | off | Enables scratchpad directory for cross-worker file sharing |

## Edge Cases & Caveats

- **Circular dependency avoidance**: The scratchpad gate check (`isScratchpadGateEnabled`) is duplicated from `utils/permissions/filesystem.ts` to break a circular import chain. The comment at `src/coordinator/coordinatorMode.ts:19-24` documents this.

- **Dead-code elimination**: All call sites use `feature('COORDINATOR_MODE')` guards and lazy `require()` imports so that coordinator code is tree-shaken from builds where the flag is off. The `getCoordinatorUserContext` and `getCoordinatorSystemPrompt` imports in `REPL.tsx`, `QueryEngine.ts`, and `systemPrompt.ts` all follow this pattern.

- **Runtime env var flipping**: `matchSessionMode()` mutates `process.env.CLAUDE_CODE_COORDINATOR_MODE` at runtime. This works because `isCoordinatorMode()` reads the env var live with no caching.

- **Coordinator cannot self-serve**: In coordinator mode, the tool pool is filtered down to only orchestration tools. The coordinator literally cannot read files or run commands — it must delegate all such work to workers. This is enforced by `applyCoordinatorToolFilter()` in `src/utils/toolPool.ts`.

- **Model parameter ignored in coordinator mode**: When `isCoordinatorMode()` is true, the `AgentTool` ignores any user-specified model parameter (`src/tools/AgentTool/AgentTool.tsx:252`), ensuring workers always use the default model for substantive tasks.

- **Fork subagent disabled**: Coordinator mode disables the fork-subagent optimization (`src/tools/AgentTool/forkSubagent.ts:34`), as coordinator workers need full independent contexts.