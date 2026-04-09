# Entrypoints

## Overview & Responsibilities

The Entrypoints module is the outermost layer of the Claude Code CLI. It sits at the very top of the **Bootstrap** subsystem and is responsible for dispatching every CLI invocation to the correct execution path. The module contains three distinct concerns:

1. **CLI bootstrap** (`src/entrypoints/cli.tsx`) — the main process entrypoint that inspects `process.argv`, handles fast-path flags (e.g. `--version`, `--daemon-worker`, `bridge`), and lazily imports the full CLI only when no shortcut applies.
2. **MCP server** (`src/entrypoints/mcp.ts`) — a standalone entrypoint that starts a Model Context Protocol server, exposing Claude Code's built-in tools over stdio for external MCP clients.
3. **SDK type definitions & schemas** (`src/entrypoints/agentSdkTypes.ts`, `src/entrypoints/sandboxTypes.ts`, `src/entrypoints/sdk/`) — the public contract consumed by the Agent SDK. The checked-in source files define Zod validation schemas and core types. Several modules referenced via imports (`runtimeTypes`, `controlTypes`, `settingsTypes.generated`, `toolTypes`, `coreTypes.generated`) are **build-time generated artifacts** that do not exist in the checked-in source tree — they are produced during the build process and exist only in the build output. The stub functions in `agentSdkTypes.ts` throw "not implemented" so the SDK package can be type-checked independently; real implementations are injected at build time.

Sibling modules in Bootstrap (e.g. initialization, environment setup, auth) take over once the entrypoint decides which path to run.

## Key Processes

### CLI Bootstrap Flow (`src/entrypoints/cli.tsx`)

The `main()` function (`cli.tsx:33`) parses `process.argv` and runs through a cascading series of fast-path checks. Each fast path dynamically imports only the modules it needs, keeping cold-start latency low for specialized subcommands.

1. **`--version` / `-v` / `-V`** — prints `MACRO.VERSION` (inlined at build time) and exits immediately. Zero module imports beyond the file itself (`cli.tsx:36-42`).

2. **`--dump-system-prompt`** — (internal, feature-gated) renders and prints the full system prompt. Used by prompt sensitivity evals (`cli.tsx:53-71`).

3. **`--claude-in-chrome-mcp` / `--chrome-native-host`** — launches Chrome extension integration servers (`cli.tsx:72-86`).

4. **`--computer-use-mcp`** — (feature-gated) starts the computer-use MCP server (`cli.tsx:86-93`).

5. **`--daemon-worker`** — (feature-gated) runs a lean daemon worker subprocess. Skips config/analytics initialization for performance; workers that need those call them internally (`cli.tsx:100-106`).

6. **`remote-control` / `rc` / `remote` / `sync` / `bridge`** — (feature-gated) starts the bridge mode that serves the local machine as a remote-control environment for claude.ai. Validates OAuth, checks GrowthBook gates, verifies minimum version, and enforces policy limits before delegating to `bridgeMain()` (`cli.tsx:112-162`).

7. **`daemon`** — (feature-gated) launches the long-running daemon supervisor (`cli.tsx:165-180`).

8. **`ps` / `logs` / `attach` / `kill` / `--bg` / `--background`** — (feature-gated) background session management commands (`cli.tsx:185-209`).

9. **`new` / `list` / `reply`** — (feature-gated) template job commands (`cli.tsx:212-222`).

10. **`environment-runner`** — (feature-gated) headless BYOC runner (`cli.tsx:226-233`).

11. **`self-hosted-runner`** — (feature-gated) headless self-hosted runner targeting the SelfHostedRunnerWorkerService API (`cli.tsx:238-245`).

12. **`--worktree` + `--tmux`** — fast path to exec into a tmux worktree session before loading the full CLI (`cli.tsx:248-274`).

13. **Fallthrough** — if no fast path matches, the full CLI is loaded via dynamic `import('../main.js')` and `cliMain()` is called (`cli.tsx:288-298`). Early keyboard input is captured during the import to avoid dropped keystrokes.

Additionally, top-level side effects before `main()` handle:
- Disabling corepack auto-pinning (`cli.tsx:5`)
- Setting `--max-old-space-size=8192` for CCR (remote container) environments (`cli.tsx:9-14`)
- Ablation baseline environment variable injection when the `ABLATION_BASELINE` feature flag is active (`cli.tsx:21-26`)

### MCP Server Flow (`src/entrypoints/mcp.ts`)

`startMCPServer(cwd, debug, verbose)` creates a stdio-based MCP server named `claude/tengu` that exposes Claude Code's tool suite to external MCP clients.

1. **Initialization** — sets the working directory, creates a size-limited LRU file-state cache (100 files / 25 MB), and instantiates an MCP `Server` with tool capabilities (`mcp.ts:35-57`).

2. **`ListTools` handler** — retrieves all tools via `getTools()`, converts their Zod input/output schemas to JSON Schema, and generates tool descriptions by calling each tool's `prompt()` method. Output schemas with non-object root types (e.g. `z.union`) are omitted per MCP SDK constraints (`mcp.ts:59-97`).

3. **`CallTool` handler** — looks up the tool by name, constructs a `ToolUseContext` with a fresh `AbortController`, validates input via `tool.validateInput()`, calls `tool.call()`, and returns the result as a text content block. Errors are caught and returned with `isError: true` (`mcp.ts:99-188`).

4. **Transport** — connects to a `StdioServerTransport` and awaits the server loop (`mcp.ts:190-196`).

The MCP server runs in a non-interactive mode (`isNonInteractiveSession: true`) with thinking disabled and no MCP sub-clients.

## Function Signatures

### `startMCPServer(cwd: string, debug: boolean, verbose: boolean): Promise<void>`

Starts the MCP server on stdio. Parameters control the working directory and logging verbosity.

> Source: `src/entrypoints/mcp.ts:35-196`

### `query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query`

SDK stub for sending a prompt to Claude Code programmatically. Has an internal overload accepting `InternalOptions`. Throws at the stub level; real implementation is injected at build time.

> Source: `src/entrypoints/agentSdkTypes.ts:112-122`

### `unstable_v2_createSession(options: SDKSessionOptions): SDKSession`

Creates a persistent session for multi-turn SDK conversations. Marked `@alpha`.

> Source: `src/entrypoints/agentSdkTypes.ts:129-133`

### `unstable_v2_resumeSession(sessionId: string, options: SDKSessionOptions): SDKSession`

Resumes an existing session by ID. Marked `@alpha`.

> Source: `src/entrypoints/agentSdkTypes.ts:140-145`

### `unstable_v2_prompt(message: string, options: SDKSessionOptions): Promise<SDKResultMessage>`

One-shot convenience function for single prompts. Marked `@alpha`.

> Source: `src/entrypoints/agentSdkTypes.ts:160-165`

### `tool<Schema>(name, description, inputSchema, handler, extras?): SdkMcpToolDefinition<Schema>`

Defines a custom MCP tool for use with the SDK transport. Generic over the Zod input schema.

> Source: `src/entrypoints/agentSdkTypes.ts:73-88`

### `createSdkMcpServer(options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance`

Creates an in-process MCP server instance that can be attached to an SDK session. Override `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` for long-running tool calls (>60s).

> Source: `src/entrypoints/agentSdkTypes.ts:103-107`

### Session Management Functions

| Function | Description |
|----------|-------------|
| `listSessions(options?)` | Lists session metadata, optionally filtered by project directory. Supports pagination via `limit`/`offset`. |
| `getSessionMessages(sessionId, options?)` | Reads conversation messages from a session's JSONL transcript. |
| `getSessionInfo(sessionId, options?)` | Reads metadata for a single session by ID. |
| `renameSession(sessionId, title, options?)` | Renames a session by appending a custom-title entry. |
| `tagSession(sessionId, tag, options?)` | Tags a session; pass `null` to clear. |
| `forkSession(sessionId, options?)` | Forks a session into a new branch with fresh UUIDs. Supports `upToMessageId` for branching from a specific point. |

> Source: `src/entrypoints/agentSdkTypes.ts:178-273`

### Daemon Primitives (Internal)

| Function | Description |
|----------|-------------|
| `watchScheduledTasks(opts)` | Watches `<dir>/.claude/scheduled_tasks.json` and yields `fire`/`missed` events. Acquires a per-directory scheduler lock. |
| `buildMissedTaskNotification(missed)` | Formats missed one-shot tasks into a confirmation prompt. |
| `connectRemoteControl(opts)` | Holds a claude.ai remote-control bridge connection from a daemon process. Returns a `RemoteControlHandle` for bidirectional communication. |

> Source: `src/entrypoints/agentSdkTypes.ts:350-443`

## Interface / Type Definitions

### Sandbox Configuration (`src/entrypoints/sandboxTypes.ts`)

Defines Zod schemas and inferred types for sandbox settings. These schemas are the single source of truth — both the SDK and the settings validation layer import from here.

| Type | Description |
|------|-------------|
| `SandboxSettings` | Top-level sandbox configuration: `enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `network`, `filesystem`, `ignoreViolations`, `excludedCommands`, `ripgrep` config, and more. |
| `SandboxNetworkConfig` | Network isolation: `allowedDomains`, `allowManagedDomainsOnly`, `allowUnixSockets` (macOS only), `allowLocalBinding`, proxy ports. |
| `SandboxFilesystemConfig` | Filesystem isolation: `allowWrite`, `denyWrite`, `denyRead`, `allowRead` path arrays with managed-settings support. |

> Source: `src/entrypoints/sandboxTypes.ts:14-156`

### SDK Core Types (`src/entrypoints/sdk/coreTypes.ts`)

Re-exports sandbox types from `src/entrypoints/sandboxTypes.ts` and generated types from a build-time artifact (`coreTypes.generated.js`, not checked in). Also exports runtime constants:
- `HOOK_EVENTS` — 28 hook event names (PreToolUse, PostToolUse, SessionStart, Stop, etc.)
- `EXIT_REASONS` — session exit reason literals (clear, resume, logout, etc.)

> Source: `src/entrypoints/sdk/coreTypes.ts`

### SDK Core Schemas (`src/entrypoints/sdk/coreSchemas.ts`)

The single source of truth for all serializable SDK data types, defined as Zod schemas. TypeScript types are generated from these schemas by a build-time code generation step (the source file references a `generate-sdk-types` script in a comment at `coreSchemas.ts:7`, but this script is not present in the checked-in repository — it is part of the build toolchain outside this tree). Major schema groups include:

- **Usage & Model**: `ModelUsageSchema` (tokens, cost, context window)
- **Configuration**: `ThinkingConfigSchema` (adaptive/enabled/disabled), `OutputFormatSchema`, `ApiKeySourceSchema`
- **MCP Server Configs**: `McpStdioServerConfigSchema`, `McpSSEServerConfigSchema`, `McpHttpServerConfigSchema`, `McpSdkServerConfigSchema`, `McpServerStatusSchema`
- **Permissions**: `PermissionModeSchema` (default/acceptEdits/bypassPermissions/plan/dontAsk), `PermissionUpdateSchema`, `PermissionResultSchema`
- **Hooks**: 28+ hook input schemas (one per event) plus `SyncHookJSONOutputSchema` and `AsyncHookJSONOutputSchema`
- **Messages**: `SDKUserMessageSchema`, `SDKAssistantMessageSchema`, `SDKResultMessageSchema`, `SDKSystemMessageSchema`, `SDKStatusMessageSchema`, and many more event-specific message schemas
- **Agents**: `AgentDefinitionSchema`, `AgentInfoSchema`
- **Session**: `SDKSessionInfoSchema`

> Source: `src/entrypoints/sdk/coreSchemas.ts`

### SDK Control Schemas (`src/entrypoints/sdk/controlSchemas.ts`)

Defines the control protocol between SDK implementations (e.g. the Python SDK) and the CLI process. This is a request/response protocol layered on top of the message stream:

| Request Schema | Purpose |
|----------------|---------|
| `SDKControlInitializeRequestSchema` | Session initialization with hooks, MCP servers, agents, system prompt overrides |
| `SDKControlInterruptRequestSchema` | Interrupts the current conversation turn |
| `SDKControlPermissionRequestSchema` | Tool permission prompts (tool name, input, suggestions) |
| `SDKControlSetPermissionModeRequestSchema` | Changes permission mode at runtime |
| `SDKControlSetModelRequestSchema` | Switches model mid-session |
| `SDKControlSetMaxThinkingTokensRequestSchema` | Adjusts thinking token budget |
| `SDKControlMcpStatusRequestSchema` | Queries MCP server connection status |
| `SDKControlGetContextUsageRequestSchema` | Context window usage breakdown |
| `SDKControlRewindFilesRequestSchema` | Reverts file changes since a given message |
| `SDKControlMcpSetServersRequestSchema` | Replaces dynamically managed MCP servers |
| `SDKControlReloadPluginsRequestSchema` | Hot-reloads plugins from disk |
| `SDKControlElicitationRequestSchema` | Proxies MCP elicitation (user input request) to the SDK consumer |
| `SDKControlGetSettingsRequestSchema` | Returns effective merged settings and raw per-source settings |
| `SDKControlApplyFlagSettingsRequestSchema` | Merges settings into the flag settings layer |

All requests are wrapped in `SDKControlRequestSchema` (`type: 'control_request'` + `request_id`) and responses in `SDKControlResponseSchema` (`type: 'control_response'` with success/error variants).

Aggregate message types define what flows on stdout vs stdin:
- **`StdoutMessageSchema`** — SDK messages, streamlined text, tool use summaries, control responses/requests, keep-alives
- **`StdinMessageSchema`** — User messages, control requests/responses, keep-alives, environment variable updates

> Source: `src/entrypoints/sdk/controlSchemas.ts`

### Agent SDK Types (`src/entrypoints/agentSdkTypes.ts`)

The main entrypoint for SDK consumers. Re-exports types from sub-modules, several of which are **build-time generated** and not present in the checked-in source tree:

| Import path | Checked in? | Description |
|-------------|-------------|-------------|
| `./sdk/coreTypes.js` | Yes (`src/entrypoints/sdk/coreTypes.ts`) | Serializable types (messages, configs) |
| `./sdk/runtimeTypes.js` | No (generated at build) | Non-serializable types (callbacks, interfaces with methods) |
| `./sdk/controlTypes.js` | No (generated at build) | Control protocol types (marked `@alpha`) |
| `./sdk/settingsTypes.generated.js` | No (generated at build) | Settings types generated from JSON schema |
| `./sdk/toolTypes.js` | No (generated at build) | Tool types (marked `@internal`) |

Also defines daemon-related internal types: `CronTask`, `CronJitterConfig`, `ScheduledTaskEvent`, `ScheduledTasksHandle`, `InboundPrompt`, `ConnectRemoteControlOptions`, and `RemoteControlHandle`.

> Source: `src/entrypoints/agentSdkTypes.ts`

## Configuration & Defaults

- **MCP server name**: `claude/tengu` (`mcp.ts:49`)
- **MCP file cache**: 100 files max, 25 MB size limit (`mcp.ts:42-43`)
- **CCR heap size**: `--max-old-space-size=8192` when `CLAUDE_CODE_REMOTE=true` (`cli.tsx:9-14`)
- **Corepack**: `COREPACK_ENABLE_AUTO_PIN=0` set unconditionally (`cli.tsx:5`)
- **Sandbox defaults**: sandbox `enabled` defaults to undefined (opt-in); `failIfUnavailable` defaults to false; `allowUnsandboxedCommands` defaults to true

## Edge Cases & Caveats

- **Feature gates are build-time**: `feature('...')` calls use Bun's dead-code elimination. Gated fast paths (daemon, bridge, templates, etc.) are completely removed from external builds, so they cannot be triggered by end users.

- **All SDK function stubs throw**: Functions like `query()`, `createSdkMcpServer()`, and all session management functions throw `"not implemented"` errors. The real implementations are substituted at build time by the SDK packaging step. These stubs exist solely for type-checking.

- **Bridge auth ordering matters**: The bridge fast path (`cli.tsx:112-162`) checks OAuth before the GrowthBook feature gate because GrowthBook needs user context from the auth token to return correct gate values.

- **MCP output schema limitation**: The MCP SDK requires `outputSchema` to have `type: "object"` at root level. Schemas that produce `anyOf`/`oneOf` at the root (from `z.union`, `z.discriminatedUnion`) are silently omitted (`mcp.ts:73-82`).

- **`--update` / `--upgrade` redirect**: These flags are silently rewritten to the `update` subcommand (`cli.tsx:277-279`).

- **`--bare` flag**: Sets `CLAUDE_CODE_SIMPLE=1` early so feature gates that check this env var fire during module evaluation, not just inside action handlers (`cli.tsx:283-285`).

- **Sandbox `enabledPlatforms`**: An undocumented setting read via `.passthrough()`. Added to support enterprise deployments that want sandboxing on macOS only (`sandboxTypes.ts:104-111`).

- **Unix socket restrictions**: `allowUnixSockets` in sandbox network config is macOS-only — seccomp on Linux cannot filter by socket path (`sandboxTypes.ts:28-30`).

- **Generated SDK files not in source tree**: The `src/entrypoints/sdk/` directory contains only 3 checked-in files (`controlSchemas.ts`, `coreSchemas.ts`, `coreTypes.ts`). Several other modules referenced by imports in `agentSdkTypes.ts` — `runtimeTypes.ts`, `controlTypes.ts`, `settingsTypes.generated.js`, `toolTypes.ts`, and `coreTypes.generated.js` — are produced during the build and exist only in the build output directory.