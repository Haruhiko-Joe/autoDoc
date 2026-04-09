# Shell & Execution Infrastructure

## Overview & Responsibilities

The Shell & Execution module is the command execution backbone of Claude Code, sitting within the **Infrastructure** layer. When any tool (Bash, PowerShell) or internal system needs to run a shell command, this module handles the full lifecycle: spawning the process, managing I/O (file-descriptor or pipe mode), tracking the working directory, enforcing timeouts, supporting background tasks, and optionally wrapping commands in an OS-level sandbox.

The module is composed of several cooperating subsystems:

| Subsystem | Key files | Role |
|-----------|-----------|------|
| **Shell** | `src/utils/Shell.ts` | Top-level `exec()` entry point, shell discovery, CWD tracking |
| **ShellCommand** | `src/utils/ShellCommand.ts` | Process lifecycle wrapper (abort, timeout, background, kill) |
| **Shell Providers** | `src/utils/shell/bashProvider.ts`, `powershellProvider.ts`, `shellProvider.ts` | Shell-specific command building and spawn args |
| **Read-Only Validation** | `src/utils/shell/readOnlyCommandValidation.ts` | Whitelists of safe git/CLI commands and flags |
| **Command Prefix** | `src/utils/shell/prefix.ts`, `specPrefix.ts` | LLM-assisted and spec-driven command prefix extraction for permissions |
| **Sandbox Adapter** | `src/utils/sandbox/sandbox-adapter.ts` | Bridges `@anthropic-ai/sandbox-runtime` with Claude Code's settings |
| **Shell Config** | `src/utils/shellConfig.ts` | Shell RC file management (aliases, PATH entries) |
| **Utilities** | `src/utils/shell/outputLimits.ts`, `shellToolUtils.ts`, `powershellDetection.ts`, `resolveDefaultShell.ts` | Output limits, PS detection, default shell resolution |

## Key Processes

### Command Execution Flow (`exec()`)

The main entry point is `exec()` in `Shell.ts:181-442`. Here is the step-by-step flow:

1. **Resolve the shell provider** — looks up `bash` or `powershell` from the `resolveProvider` map, which lazily creates and memoizes providers (`Shell.ts:156-159`).
2. **Build the command string** — delegates to `provider.buildExecCommand()`, which wraps the raw command with shell snapshot sourcing, session env, extglob disabling, `eval`-wrapping, and `pwd -P` CWD tracking (`bashProvider.ts:77-198`).
3. **Validate CWD** — checks that the current working directory still exists on disk; if deleted, falls back to the original CWD or returns a `createFailedCommand` (`Shell.ts:218-238`).
4. **Check abort signal** — if already aborted, returns `createAbortedCommand()` immediately (`Shell.ts:241-243`).
5. **Apply sandbox** (optional) — when `shouldUseSandbox` is true, calls `SandboxManager.wrapWithSandbox()` to prepend the sandbox runtime wrapper (bubblewrap on Linux, sandbox-exec on macOS) (`Shell.ts:259-273`).
6. **Open output file** — in file mode (default for Bash), opens a file descriptor with `O_APPEND | O_NOFOLLOW` for atomic, symlink-safe output capture. In pipe mode (hooks, `onStdout` callback), stdout/stderr flow through `StreamWrapper` instead (`Shell.ts:301-313`).
7. **Spawn the process** — calls `child_process.spawn()` with the resolved binary, shell args, env overrides, and appropriate stdio configuration (`Shell.ts:316-337`).
8. **Wrap in ShellCommand** — `wrapSpawn()` creates a `ShellCommandImpl` that manages abort listeners, timeout, exit handling, and background promotion (`Shell.ts:339-345`).
9. **Track CWD changes** — after the command completes, reads the CWD file written by `pwd -P`, compares to the previous CWD, and calls `setCwd()` if changed (`Shell.ts:385-421`).

### Process Lifecycle (ShellCommand)

`ShellCommandImpl` (`ShellCommand.ts:114-382`) manages the full lifecycle of a spawned process:

- **Status tracking**: `running` → `backgrounded` | `completed` | `killed`
- **Timeout handling**: a `setTimeout` fires `#handleTimeout()`. If auto-background is enabled and the caller registered `onTimeout`, the callback decides whether to background. Otherwise, the process is killed with SIGTERM (`ShellCommand.ts:135-141`).
- **Abort signal**: listens for the parent `AbortSignal`. On `'interrupt'` reason (user submitted a new message), it does NOT kill — it lets the caller background the process so the model can see partial output (`ShellCommand.ts:186-193`).
- **Background promotion**: `background(taskId)` transitions the status, clears the foreground timeout, and starts a **size watchdog** that polls the output file every 5 seconds and kills with SIGKILL if it exceeds `MAX_TASK_OUTPUT_BYTES` (`ShellCommand.ts:349-366`).
- **Kill**: uses `tree-kill` to send SIGKILL to the entire process tree (`ShellCommand.ts:337-343`).
- **Exit handling**: resolves the `result` promise with `ExecResult` containing stdout, stderr, exit code, and metadata about backgrounding or output file location (`ShellCommand.ts:291-335`).

### I/O Modes: File vs Pipe

The module supports two I/O strategies:

**File mode** (default for Bash commands): stdout and stderr are redirected to the same file descriptor. On POSIX, `O_APPEND` makes each write atomic so interleaving is chronological. This allows background tasks to write with zero JS overhead. `TaskOutput` polls the file tail for progress reporting.

**Pipe mode** (hooks, `onStdout` callback): stdout and stderr are piped through `StreamWrapper` instances that funnel data into `TaskOutput` in-memory. The caller also receives real-time chunks via the `onStdout` callback. Both listeners receive the same data chunks since Node.js `ReadableStream` supports multiple `'data'` listeners (`ShellCommand.ts:66-104`).

### Shell Discovery

`findSuitableShell()` (`Shell.ts:73-137`) determines which shell binary to use:

1. Check `CLAUDE_CODE_SHELL` env var (explicit override, must be bash or zsh)
2. Check `SHELL` env var (user's login shell preference)
3. Probe well-known paths (`/bin`, `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`) for zsh/bash
4. Order candidates by user preference (bash-first if `SHELL` contains bash, else zsh-first)
5. Validate executability via `accessSync(X_OK)` with a fallback to `execFileSync --version`

### Sandbox Integration

The sandbox adapter (`sandbox-adapter.ts`) bridges `@anthropic-ai/sandbox-runtime` with Claude Code's settings system:

1. **Settings conversion** — `convertToSandboxRuntimeConfig()` reads the merged settings hierarchy and constructs a `SandboxRuntimeConfig` with filesystem restrictions (allowWrite, denyWrite, allowRead, denyRead) and network restrictions (allowed/denied domains) derived from permission rules (`sandbox-adapter.ts:172-381`).
2. **Security hardening** — always denies writes to settings files (prevents sandbox escape), denies writes to `.claude/skills`, and blocks bare-git-repo file planting (HEAD, objects, refs) to prevent `core.fsmonitor` exploits (`sandbox-adapter.ts:232-280`).
3. **Initialization** — `initialize()` resolves worktree paths, builds config, calls `BaseSandboxManager.initialize()`, and subscribes to settings changes for dynamic config updates (`sandbox-adapter.ts:730-792`).
4. **Post-command cleanup** — `cleanupAfterCommand()` scrubs planted bare-repo files before unsandboxed git operations can see them (`sandbox-adapter.ts:404-414`).

### Read-Only Command Validation

`readOnlyCommandValidation.ts` defines comprehensive whitelists of commands that are safe to execute without user permission. This includes:

- **`GIT_READ_ONLY_COMMANDS`**: Maps git subcommands (diff, log, show, status, blame, ls-files, rev-parse, etc.) to their allowed flags with typed argument specifications (`'none'`, `'number'`, `'string'`, etc.)
- **Security-sensitive callbacks**: Some commands (like `git reflog`) have `additionalCommandIsDangerousCallback` to block write-capable subcommands (expire, delete)
- Flag argument types prevent parser differentials (e.g., `-S` in `git diff` is correctly typed as `'string'` to prevent the validator from misaligning with git's actual parsing)

### Command Prefix Extraction

The permission system uses command prefixes to match rules like `Bash(npm run:*)`. Two extraction strategies exist:

**LLM-based** (`prefix.ts`): `createCommandPrefixExtractor()` creates a memoized (LRU, 200 entries) function that queries Haiku to determine the command prefix. Includes safety checks: rejects dangerous shell prefixes (bash, sh, cmd, pwsh), validates the prefix is actually a prefix of the command, and evicts failed cache entries to prevent poisoning (`prefix.ts:92-126`).

**Spec-driven** (`specPrefix.ts`): `buildPrefix()` walks Fig autocomplete specs to determine prefix depth. Uses `DEPTH_RULES` overrides for known tools (e.g., `gcloud: 4`, `kubectl: 3`), handles flag-value skipping via spec analysis, and stops at file paths/URLs (`specPrefix.ts:88-137`).

## Function Signatures

### `exec(command, abortSignal, shellType, options?): Promise<ShellCommand>`

Main execution entry point. Spawns a shell process and returns a `ShellCommand` handle.

- **command** `string` — the raw command to execute
- **abortSignal** `AbortSignal` — allows callers to abort/interrupt the command
- **shellType** `ShellType` — `'bash'` or `'powershell'`
- **options.timeout** `number` — kill timeout in ms (default: 30 minutes)
- **options.onProgress** — callback receiving last lines, all lines, total lines, total bytes, isIncomplete
- **options.preventCwdChanges** `boolean` — skip CWD tracking after completion
- **options.shouldUseSandbox** `boolean` — wrap with OS-level sandbox
- **options.shouldAutoBackground** `boolean` — enable timeout→background promotion
- **options.onStdout** `(data: string) => void` — enables pipe mode with real-time stdout callback

> Source: `src/utils/Shell.ts:181-442`

### `wrapSpawn(childProcess, abortSignal, timeout, taskOutput, shouldAutoBackground?, maxOutputBytes?): ShellCommand`

Wraps an existing `ChildProcess` in a `ShellCommand` lifecycle manager.

> Source: `src/utils/ShellCommand.ts:387-403`

### `ShellCommand` interface

```typescript
type ShellCommand = {
  background: (backgroundTaskId: string) => boolean
  result: Promise<ExecResult>
  kill: () => void
  status: 'running' | 'backgrounded' | 'completed' | 'killed'
  cleanup: () => void
  onTimeout?: (callback: (backgroundFn: (taskId: string) => boolean) => void) => void
  taskOutput: TaskOutput
}
```

> Source: `src/utils/ShellCommand.ts:32-47`

### `ShellProvider` interface

```typescript
type ShellProvider = {
  type: ShellType
  shellPath: string
  detached: boolean
  buildExecCommand(command, opts): Promise<{ commandString: string; cwdFilePath: string }>
  getSpawnArgs(commandString: string): string[]
  getEnvironmentOverrides(command: string): Promise<Record<string, string>>
}
```

> Source: `src/utils/shell/shellProvider.ts:1-33`

### `SandboxManager` (exported interface)

Key methods on the singleton:
- `initialize(sandboxAskCallback?)` — one-time setup, subscribes to settings changes
- `isSandboxingEnabled()` — checks settings + platform + dependencies
- `wrapWithSandbox(command, binShell?, customConfig?, abortSignal?)` — wraps a command string
- `cleanupAfterCommand()` — scrubs planted bare-repo files
- `refreshConfig()` — re-reads settings and pushes new config to the runtime
- `convertToSandboxRuntimeConfig(settings)` — transforms Claude Code settings to sandbox-runtime format

> Source: `src/utils/sandbox/sandbox-adapter.ts:880-917`

## Type Definitions

### `ExecResult`

| Field | Type | Description |
|-------|------|-------------|
| stdout | string | Captured standard output |
| stderr | string | Captured standard error |
| code | number | Exit code (137=SIGKILL, 143=SIGTERM) |
| interrupted | boolean | True if killed by SIGKILL |
| backgroundTaskId? | string | Set when the command was backgrounded |
| backgroundedByUser? | boolean | True if user explicitly backgrounded |
| assistantAutoBackgrounded? | boolean | True if auto-backgrounded on timeout |
| outputFilePath? | string | Path to output file when stdout is too large for inline |
| outputFileSize? | number | Size of the output file in bytes |
| outputTaskId? | string | Task ID for the output file |
| preSpawnError? | string | Error message when command failed before spawning |

> Source: `src/utils/ShellCommand.ts:13-30`

### `ShellType`

```typescript
const SHELL_TYPES = ['bash', 'powershell'] as const
type ShellType = 'bash' | 'powershell'
```

> Source: `src/utils/shell/shellProvider.ts:1-2`

### `ExternalCommandConfig`

Used by the read-only validation system to define safe commands:

```typescript
type ExternalCommandConfig = {
  safeFlags: Record<string, FlagArgType>
  additionalCommandIsDangerousCallback?: (rawCommand: string, args: string[]) => boolean
  respectsDoubleDash?: boolean
}
```

> Source: `src/utils/shell/readOnlyCommandValidation.ts:26-38`

## Configuration & Defaults

| Setting / Env Var | Default | Description |
|-------------------|---------|-------------|
| `CLAUDE_CODE_SHELL` | — | Override shell binary (must be bash or zsh) |
| `SHELL` | — | User's login shell, used for preference ordering |
| `BASH_MAX_OUTPUT_LENGTH` | 30,000 chars | Max output length returned inline (upper limit: 150,000) |
| Default timeout | 30 minutes | `DEFAULT_TIMEOUT` in `Shell.ts:44` |
| Size watchdog interval | 5 seconds | Polls background task output file size |
| `MAX_TASK_OUTPUT_BYTES` | — | Max output file size before background task is killed |
| `settings.defaultShell` | `'bash'` | Default shell type for `!` commands |
| `sandbox.enabled` | `false` | Enable OS-level sandboxing |
| `sandbox.autoAllowBashIfSandboxed` | `true` | Auto-allow bash commands when sandboxed |
| `sandbox.allowUnsandboxedCommands` | `true` | Allow commands that can't be sandboxed |
| `sandbox.failIfUnavailable` | `false` | Error if sandbox dependencies are missing |
| `sandbox.excludedCommands` | `[]` | Commands exempt from sandboxing |
| `sandbox.network.allowedDomains` | `[]` | Domains allowed through the network sandbox |
| `sandbox.filesystem.allowWrite` | `['.']` (cwd) | Additional writable paths |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | off (external), on (ant) | Enable PowerShell tool (Windows only) |
| `CLAUDE_CODE_SHELL_PREFIX` | — | Shell prefix wrapper (e.g., for Nix) |

## Edge Cases & Caveats

- **Deleted CWD recovery**: If the working directory is deleted between commands (e.g., temp dir cleanup), `exec()` falls back to the original CWD. If that's also gone, it returns a `createFailedCommand` with a descriptive error (`Shell.ts:220-238`).

- **Interrupt vs abort**: When the `AbortSignal` reason is `'interrupt'` (user submitted a new message), the process is NOT killed. This lets the caller background it so the model can see partial output (`ShellCommand.ts:186-193`).

- **Windows file mode**: On Windows, the output file is opened with `'w'` mode instead of `O_APPEND` because MSYS2/Cygwin silently discards output from handles opened in append-only mode (`Shell.ts:294-301`).

- **Unicode CWD normalization**: macOS APFS may return NFD-encoded paths from `pwd -P`, while the stored CWD is NFC-normalized. The comparison normalizes both to NFC to avoid false-positive "changed" detection on every command (`Shell.ts:405-406`).

- **Sandboxed PowerShell**: When sandboxing PowerShell, the sandbox runtime hardcodes `<binShell> -c '<cmd>'`. To preserve `-NoProfile -NonInteractive`, the provider pre-wraps the command with `pwsh -EncodedCommand <base64>` and uses `/bin/sh` as the sandbox shell. Base64 encoding survives all quoting layers (`Shell.ts:246-278`, `powershellProvider.ts:68-94`).

- **Bare-git-repo attack prevention**: The sandbox adapter denies writes to `HEAD`, `objects`, `refs`, `hooks`, and `config` in the working directory to prevent attackers from planting files that make git treat cwd as a bare repo (triggering `core.fsmonitor` code execution). Files that don't exist at config time are scrubbed after each sandboxed command (`sandbox-adapter.ts:258-280`).

- **Snapshot file disappearance**: The bash provider checks if the shell snapshot file still exists before each command. If it vanished (tmpdir cleanup), it falls back to login shell mode (`-l` flag) so commands still get shell initialization (`bashProvider.ts:93-102`).

- **Output size watchdog**: Background tasks have a 5-second polling watchdog that kills the process with SIGKILL if output exceeds `MAX_TASK_OUTPUT_BYTES`. This was added after a 768GB disk-fill incident (`ShellCommand.ts:239-261`).

- **`git diff -S` parser differential**: The read-only validation correctly types `-S`, `-G`, and `-O` as `'string'` (requiring an argument). Previously typed as `'none'`, this created a parser differential with git that could be exploited for arbitrary file writes via `--output=` (`readOnlyCommandValidation.ts:160-171`).