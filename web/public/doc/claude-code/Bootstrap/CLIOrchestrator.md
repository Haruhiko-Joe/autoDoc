# CLIOrchestrator

## Overview & Responsibilities

The CLIOrchestrator (`src/main.tsx`, ~4700 lines) is the central entry point and startup sequencer for Claude Code. It defines the Commander.js CLI program with all subcommands and options, parses CLI arguments, and orchestrates the full initialization sequence from raw process invocation to a running interactive REPL or headless session. Within the **Bootstrap** module, it sits upstream of every other module — it is the first code to run and the last to hand off control.

**Position in the architecture**: The CLIOrchestrator is the top of the call chain. Its sibling modules in the Bootstrap group handle lower-level concerns (Node.js validation, telemetry sinks, structured I/O), but `main.tsx` is the conductor that sequences their execution. It calls into **Services** (API clients, analytics, MCP, GrowthBook), **Infrastructure** (config, auth, permissions, git), and ultimately launches either the **TerminalUI** (via `launchRepl`) or the headless print engine (via `runHeadless` exported from `src/cli/print.ts`).

## Key Processes

### 1. Module-Level Side Effects (Lines 1–209)

Before any function runs, top-level side effects fire in carefully ordered imports:

1. **`profileCheckpoint('main_tsx_entry')`** — marks the startup profiler entry point
2. **`startMdmRawRead()`** — fires MDM subprocesses (plutil/reg query) so they run in parallel with the ~135ms of remaining imports
3. **`startKeychainPrefetch()`** — fires macOS keychain reads (OAuth + legacy API key) in parallel, saving ~65ms that would otherwise be sequential

These three prefetches overlap with the heavy import phase (~200 imports), so their latency is hidden.

### 2. `main()` — Early Argv Processing (Lines 585–856)

The exported `main()` function handles pre-Commander argv rewriting for special modes:

1. **Security**: Sets `NoDefaultCurrentDirectoryInExePath` to prevent Windows PATH hijacking
2. **Signal handlers**: Registers `SIGINT` and `exit` handlers for cursor cleanup
3. **Deep link handling**: Intercepts `--handle-uri` and macOS URL scheme launches, processing them and exiting before full init
4. **`cc://` URL rewriting**: Detects `cc://` or `cc+unix://` URLs in argv and rewrites them so the main command handler picks them up (interactive gets the full TUI, headless gets the `open` subcommand)
5. **`claude ssh` argv rewriting**: Strips `ssh <host> [dir]` from argv, stashes host/cwd/flags in `_pendingSSH`, and lets the main command handler launch an SSH-backed session
6. **`claude assistant` argv rewriting**: Similar pattern for the assistant viewer mode
7. **Interactive/non-interactive detection**: Checks for `-p`/`--print`, `--init-only`, `--sdk-url`, and TTY status
8. **Client type determination**: Classifies the session as `cli`, `sdk-typescript`, `sdk-python`, `github-action`, `remote`, etc.
9. **Eager settings load**: Parses `--settings` and `--setting-sources` flags before `init()` so the settings hierarchy is established early
10. Calls `run()` to enter Commander.js parsing

### 3. `run()` — Commander.js Program Definition (Lines 884–4513)

#### preAction Hook (Lines 907–967)

Every command passes through this hook before its action handler:

1. Awaits MDM settings and keychain prefetch completion
2. Calls `init()` — the core initialization function (telemetry, config, auth bootstrapping)
3. Attaches analytics sinks so subcommands can use `logEvent`/`logError`
4. Processes `--plugin-dir` inline plugins
5. Runs **migrations** (version-gated, currently at version 11) — model string migrations, settings migrations, permission migrations
6. Fires non-blocking `loadRemoteManagedSettings()` and `loadPolicyLimits()` for enterprise

#### Default Command Action (Lines 1007–3808)

This is the main action handler for `claude [prompt]`. It is the heart of the orchestrator:

**Option extraction and validation** (~300 lines):
- Extracts all CLI flags: debug, permission mode, MCP configs, model, tools, system prompts, thinking mode, etc.
- Validates mutual exclusions (e.g., `--system-prompt` vs `--system-prompt-file`)
- Validates session ID uniqueness, format constraints on output/input formats

**Permission setup** (~50 lines):
- Calls `initialPermissionModeFromCLI()` to resolve the effective permission mode
- Initializes tool permission context with allowed/disallowed tool lists
- Strips dangerous permissions for auto mode when the transcript classifier feature is enabled

**MCP configuration** (~200 lines):
- Parses `--mcp-config` (JSON strings or file paths)
- Validates against reserved names and enterprise policy
- Sets up Claude in Chrome MCP integration
- Sets up Computer Use MCP (macOS only, feature-gated)
- Kicks off async `getClaudeCodeMcpConfigs()` to overlap config I/O with setup

**Setup and trust** (~100 lines):
- Calls `setup()` which handles worktree creation, CWD resolution, UDS messaging
- Parallelizes `setup()` with `getCommands()` and `getAgentDefinitionsWithOverrides()` when possible
- Shows setup screens (trust dialog, onboarding, OAuth) for interactive sessions
- Refreshes auth-dependent services after onboarding

**Agent resolution** (~80 lines):
- Merges CLI agents (`--agents`) with file-based agent definitions
- Resolves main thread agent from `--agent` flag or settings
- Applies agent system prompts and initial prompts

**State assembly and launch**:
- For **headless mode** (`--print`): Builds `headlessStore`, connects MCP servers synchronously (with 5s timeout for claude.ai connectors), then dynamically imports and calls `runHeadless()` from the print module (`src/cli/print.ts`)
- For **interactive mode**: Builds the full `AppState`, handles resume/continue/teleport/remote/SSH/assistant/direct-connect flows, then calls `launchRepl()`

### 4. Session Resume Flows (Lines 3101–3760)

Multiple resume entry points converge on `processResumedConversation()`:

- **`--continue`**: Loads the most recent conversation for the current directory
- **`--resume <id|name>`**: Loads by UUID, custom title match, ccshare URL, or file path
- **`--from-pr`**: Filters sessions linked to a specific PR
- **`--teleport`**: Resumes a Claude Code Web (CCR) session locally
- **`--remote`**: Creates a new remote session with TUI or prints session URL
- **Direct connect (`cc://`)**: Connects to a session server
- **SSH (`claude ssh`)**: Deploys binary to remote host and tunnels auth

Each path ultimately calls `launchRepl()` with the appropriate initial state, messages, and configuration.

### 5. Subcommand Registration (Lines 3892–4502)

Subcommands are registered only in interactive mode (skipped for `-p` to save ~65ms):

| Subcommand | Description |
|---|---|
| `mcp serve/add/remove/list/get/add-json/add-from-claude-desktop/reset-project-choices` | MCP server management |
| `auth login/status/logout` | Authentication management |
| `plugin validate/list/install/uninstall/enable/disable/update` | Plugin management |
| `plugin marketplace add/list/remove/update` | Marketplace management |
| `server` | Start a session server (feature-gated) |
| `ssh <host> [dir]` | Remote execution via SSH |
| `open <cc-url>` | Direct-connect headless mode |
| `doctor` | Installation health check |
| `update` | Check and install updates |
| `agents` | List configured agents |
| `config` | View/edit configuration |
| `setup-token` | Set up long-lived auth token |
| `install` | Install native build |
| `remote-control` / `rc` | Bridge to claude.ai/code |
| `assistant` | Viewer client for bridge sessions |

## Function Signatures

### `main(): Promise<void>`

The exported entry point. Handles early argv rewriting, mode detection, client type classification, eager settings loading, then delegates to `run()`.

> Source: `src/main.tsx:585-856`

### `run(): Promise<CommanderCommand>`

Defines the Commander.js program with all options and subcommands, registers the `preAction` hook, and calls `program.parseAsync()`. Returns the program instance.

> Source: `src/main.tsx:884-4513`

### `startDeferredPrefetches(): void`

Exported function called after the REPL's first render. Kicks off background prefetches that don't need to complete before first paint: `initUser()`, `getUserContext()`, system context, AWS/GCP credentials, file counting, analytics gates, model capabilities, and file change detectors. Skips entirely for `--bare` mode or startup benchmarks.

> Source: `src/main.tsx:388-431`

### `runMigrations(): void`

Executes synchronous migrations guarded by `CURRENT_MIGRATION_VERSION` (currently 11). Includes model string migrations (Sonnet 4.5→4.6, Opus→Opus 1M), permission migrations, and settings migrations. Only runs when the stored version differs from current.

> Source: `src/main.tsx:326-352`

## Configuration & Defaults

### Key CLI Options

| Option | Default | Description |
|---|---|---|
| `-p, --print` | off | Non-interactive headless mode |
| `--bare` | off | Minimal mode: skips hooks, LSP, plugins, CLAUDE.md, prefetches |
| `--model <model>` | per subscription | Model alias (`sonnet`, `opus`) or full ID |
| `--permission-mode <mode>` | `default` | One of: `default`, `auto`, `bypassPermissions`, `plan` |
| `--dangerously-skip-permissions` | off | Bypass all permission checks |
| `--mcp-config <configs...>` | none | MCP server configs (JSON or file paths) |
| `--system-prompt <prompt>` | none | Override system prompt |
| `--append-system-prompt <prompt>` | none | Append to default system prompt |
| `--output-format <format>` | `text` | `text`, `json`, or `stream-json` |
| `--thinking <mode>` | per model | `enabled`, `adaptive`, or `disabled` |
| `-c, --continue` | off | Continue most recent conversation |
| `-r, --resume [id]` | off | Resume by session ID or open picker |
| `--worktree [name]` | off | Run in a new git worktree |
| `--allowed-tools <tools...>` | none | Restrict available tools |
| `--settings <file-or-json>` | none | Additional settings file |

### Environment Variables

- `CLAUDE_CODE_SIMPLE=1` — Equivalent to `--bare`
- `CLAUDE_CODE_ENTRYPOINT` — Set by SDK/action launchers to classify the session
- `CLAUDE_CODE_PROACTIVE` — Activate proactive mode
- `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` — Enable alternative API providers
- `ANTHROPIC_MODEL` — Override default model
- `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` — Skip prefetches for startup benchmarking
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` — Prevent `process.title` override

## Edge Cases & Caveats

- **Trust-gated operations**: Git commands, LSP initialization, environment variable application, and MCP resource prefetching are deferred until after the trust dialog is accepted. This prevents code execution in untrusted directories (e.g., malicious `core.fsmonitor` git hooks).

- **`--bare` mode**: Sets `CLAUDE_CODE_SIMPLE=1` and skips a wide set of features: CLAUDE.md discovery, hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, claude.ai MCP connectors, and startup prefetches. Only `--mcp-config`, `--settings`, `--system-prompt`, `--add-dir`, `--agents`, `--plugin-dir`, and skills still resolve.

- **Debugger detection**: The file exits immediately (`process.exit(1)`) if `--inspect` flags or an active inspector are detected, unless running in an internal build. This prevents attaching debuggers to production builds (`src/main.tsx:266-271`).

- **Print mode subcommand skip**: In `-p` mode, the 52 subcommand registrations are skipped entirely to save ~65ms of startup time (`src/main.tsx:3883-3890`). The `cc://` URL check ensures `open` subcommand still works.

- **Claude.ai MCP timeout**: In headless mode, claude.ai MCP connectors get a 5-second bounded wait. If they don't finish, the session proceeds and connectors populate asynchronously for later turns (`src/main.tsx:2738-2808`).

- **Migration versioning**: Migrations are idempotent but version-gated. The `CURRENT_MIGRATION_VERSION` constant (currently 11) must be bumped when adding new migrations. An async migration (`migrateChangelogFromConfig`) runs fire-and-forget.

- **Lazy imports**: Circular dependency avoidance uses `require()` with lazy getters for teammate utils, coordinator mode, and assistant modules (`src/main.tsx:69-81`). Feature-gated modules use conditional `require()` with dead code elimination.

- **MCP enterprise policy**: Dynamic MCP configs from `--mcp-config` are filtered through enterprise policy (`filterMcpServersByPolicy`). Enterprise MCP configurations block all non-SDK dynamic configs. Reserved MCP server names (`claude-in-chrome`, `computer-use`) are rejected.

## Key Code Snippets

### Startup Side Effects (Parallel Prefetches)

```typescript
// src/main.tsx:9-20
profileCheckpoint('main_tsx_entry');
startMdmRawRead();       // MDM subprocesses run during import phase
startKeychainPrefetch();  // macOS keychain reads overlap with imports
```

### preAction Hook (Initialization Sequencing)

```typescript
// src/main.tsx:907-967
program.hook('preAction', async thisCommand => {
  await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
  await init();
  const { initSinks } = await import('./utils/sinks.js');
  initSinks();
  // ... plugin dirs, migrations, remote settings
  void loadRemoteManagedSettings();
  void loadPolicyLimits();
});
```

### Branching: Headless vs Interactive

The headless engine is defined in `src/cli/print.ts` and dynamically imported at `src/main.tsx:2825-2827`:

```typescript
// src/main.tsx:2585-2861 (headless path)
if (isNonInteractiveSession) {
  // ... build headlessStore, connect MCP, start prefetches
  const { runHeadless } = await import(/* src/cli/print.ts */ '...');
  void runHeadless(inputPrompt, () => headlessStore.getState(), ...);
  return;
}

// src/main.tsx:3760-3807 (interactive, fresh session)
await launchRepl(root, { getFpsMetrics, stats, initialState }, {
  ...sessionConfig,
  initialMessages,
  pendingHookMessages
}, renderAndRun);
```

### Migration System

```typescript
// src/main.tsx:326-352
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    // ... 10 more sync migrations
    saveGlobalConfig(prev => ({ ...prev, migrationVersion: CURRENT_MIGRATION_VERSION }));
  }
  migrateChangelogFromConfig().catch(() => {}); // async, fire-and-forget
}
```