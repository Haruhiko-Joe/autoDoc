# PowerShell Tool — Definition & Execution

## Overview & Responsibilities

The PowerShellTool is the Windows PowerShell command execution entry point within the Claude Code CLI's ToolSystem. It sits inside the **ShellExecutionTools** group alongside its sibling **BashTool**, which handles Unix/macOS shells. While BashTool is the primary shell tool, PowerShellTool mirrors its architecture for PowerShell environments — defining the tool schema, spawning PowerShell processes, managing timeouts and background tasks, streaming progress, processing output, and interpreting exit codes.

In the broader system hierarchy: **ToolSystem → ShellExecutionTools → PowerShellTool**. The tool is registered into the tool pool by the ToolInterfaceAndRegistry and invoked by the QueryEngine when Claude decides to run a PowerShell command. It reuses several utilities from BashTool (`shouldUseSandbox`, `BackgroundHint`, `buildImageToolResult`, `resetCwdIfOutsideProject`, `stripEmptyLines`) rather than duplicating them.

The module is spread across five files:

| File | Purpose |
|------|---------|
| `PowerShellTool.tsx` | Tool definition (`buildTool`), input/output schemas, validation, `call()` entry point, and the `runPowerShellCommand` async generator |
| `UI.tsx` | React (Ink) components for rendering tool use messages, progress, results, and errors in the terminal |
| `prompt.ts` | Dynamic system prompt generation with edition-specific syntax guidance |
| `toolName.ts` | Constant export (`POWERSHELL_TOOL_NAME = 'PowerShell'`) to break circular dependencies |
| `commandSemantics.ts` | Exit code interpretation for external executables (grep, robocopy, findstr) |

## Key Processes

### 1. Tool Construction via `buildTool`

The tool is defined at `PowerShellTool.tsx:272-662` using the `buildTool` factory with these key properties:

- **Input schema** (`PowerShellTool.tsx:228-239`): A Zod `strictObject` with `command` (required), `timeout`, `description`, `run_in_background`, and `dangerouslyDisableSandbox`. When `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is set, the `run_in_background` field is omitted from the schema entirely.
- **Output schema** (`PowerShellTool.tsx:245-256`): Returns `stdout`, `stderr`, `interrupted`, plus optional fields for `returnCodeInterpretation`, `isImage`, `persistedOutputPath`, `persistedOutputSize`, `backgroundTaskId`, `backgroundedByUser`, and `assistantAutoBackgrounded`.
- **`isReadOnly`** (`PowerShellTool.tsx:300-316`): Synchronously checks if a command is read-only by first screening for security concerns (subexpressions, splatting, member invocations), then consulting the cmdlet allowlist. The full async AST-based check happens later in `powershellToolHasPermission`.
- **`isSearchOrReadCommand`** (`PowerShellTool.tsx:101-156`): Classifies commands against two sets — `PS_SEARCH_COMMANDS` (Select-String, Get-ChildItem, findstr, where.exe) and `PS_READ_COMMANDS` (Get-Content, Get-Item, Test-Path, etc.) — to determine if the UI should use collapsible display. Commands piped through `Write-Output` or `Write-Host` preserve their search/read classification.

### 2. Input Validation

`validateInput` (`PowerShellTool.tsx:352-374`) performs two checks before execution:

1. **Windows sandbox policy violation**: If enterprise policy requires sandboxing but the platform is native Windows (where bwrap/sandbox-exec are unavailable), execution is refused with error code 11.
2. **Blocked sleep pattern detection** (`PowerShellTool.tsx:189-205`): When the `MONITOR_TOOL` feature flag is active, catches `Start-Sleep N` or `sleep N` (where N ≥ 2 seconds) as the first statement. Sub-second sleeps and `-Milliseconds` variants are allowed. This prevents the model from using sleep loops when `run_in_background` or the Monitor tool would be more appropriate.

### 3. Command Execution Lifecycle (`call()` → `runPowerShellCommand`)

The `call()` method (`PowerShellTool.tsx:437-658`) is the main entry point. It:

1. Guards against Windows sandbox policy violations (defense-in-depth, since `promptShellExecution.ts` can call `call()` directly, bypassing `validateInput`)
2. Creates an async generator via `runPowerShellCommand` and iterates it, forwarding progress events to `onProgress`
3. Post-processes the result: git operation tracking, CWD reset, Claude Code hints extraction, exit code interpretation, large output persistence, and image resizing

**`runPowerShellCommand`** (`PowerShellTool.tsx:663-999`) is the core async generator that manages the full process lifecycle:

```
getCachedPowerShellPath() → exec(command, signal, 'powershell', opts) → progress loop → result
```

Key steps:

1. **PowerShell detection** (`PowerShellTool.tsx:717-728`): Checks if `pwsh` or `powershell.exe` is available via `getCachedPowerShellPath()`. If not, returns a graceful error (code 0 + stderr message) rather than throwing.

2. **Process spawning** (`PowerShellTool.tsx:730-761`): Calls `Shell.exec()` with:
   - Timeout clamped to `min(input.timeout, getMaxTimeoutMs())`
   - An `onProgress` callback that accumulates output
   - `shouldUseSandbox` for Linux/macOS (disabled on native Windows)
   - `shouldAutoBackground` based on command type

3. **Background task management** — three paths to backgrounding:
   - **Explicit** (`PowerShellTool.tsx:845-857`): When `run_in_background: true`, immediately spawns a background task via `spawnShellTask` and returns.
   - **Timeout auto-background** (`PowerShellTool.tsx:824-828`): When the command times out, `shellCommand.onTimeout` fires `startBackgrounding()`.
   - **Assistant-mode auto-background** (`PowerShellTool.tsx:833-840`): In Kairos (assistant) mode, blocking commands on the main thread auto-background after `ASSISTANT_BLOCKING_BUDGET_MS` (15 seconds) to keep the conversation responsive.
   - **User interrupt backgrounding** (`PowerShellTool.tsx:926-937`): When the user submits a new message (abort reason = `'interrupt'`), the running command is backgrounded instead of killed.
   - **Ctrl+B backgrounding** (`PowerShellTool.tsx:939-951`): Detects when a foreground task was backgrounded via `backgroundAll()`.

4. **Progress streaming** (`PowerShellTool.tsx:862-986`): A `while(true)` loop uses `Promise.race` between the result promise, a setTimeout, and a progress signal. After `PROGRESS_THRESHOLD_MS` (2s), it registers a foreground task and shows a `<BackgroundHint />` UI component. Progress updates yield every `PROGRESS_INTERVAL_MS` (1s) with output, elapsed time, line/byte counts, and task ID.

5. **Cleanup** (`PowerShellTool.tsx:988-999`): In a `finally` block, stops output polling, unregisters foreground tasks, and calls `shellCommand.cleanup()` — unless the command was backgrounded (LocalShellTask owns cleanup in that case).

### 4. Output Processing

After the command completes, `call()` performs several post-processing steps:

- **Git operation tracking** (`PowerShellTool.tsx:502-505`): Feeds command, exit code, and stdout to `trackGitOperations` for usage metrics. Skips "pre-flight sentinel" results (code 0 + empty stdout + stderr) that indicate the command never actually ran.

- **Claude Code hints extraction** (`PowerShellTool.tsx:570-574`): Scans stdout for `<claude-code-hint />` tags emitted by CLIs gated on `CLAUDECODE=1`. Records hints for plugin recommendation, then strips the tags so the model never sees them.

- **Large output persistence** (`PowerShellTool.tsx:596-617`): When output exceeds `getMaxOutputLength()` bytes and was written to a file, copies/hard-links it to the tool-results directory. Files over 64 MB are truncated. The persisted path is returned so Claude can reference it via FileRead.

- **Image detection and resizing** (`PowerShellTool.tsx:622-635`): Checks if stdout contains image data (e.g., base64 data URLs). If so, resizes the image via `resizeShellImageOutput`. The `isImage` flag controls how `mapToolResultToToolResultBlockParam` formats the result (as an image content block vs. text).

- **`mapToolResultToToolResultBlockParam`** (`PowerShellTool.tsx:383-436`): Converts the tool output into the Anthropic API's `ToolResultBlockParam` format. For image data, builds an image content block. For large persisted output, generates a preview with a pointer to the file. For background tasks, includes the task ID and output path. Adds interrupt markers when applicable.

### 5. Exit Code Interpretation via Command Semantics

`commandSemantics.ts` provides `interpretCommandResult()` which maps exit codes to semantic meaning for specific external executables:

| Command | Exit 0 | Exit 1 | Exit 2+ | Notes |
|---------|--------|--------|---------|-------|
| Default | Success | Error | Error | Standard interpretation |
| `grep`, `rg`, `findstr` | Matches found | No matches (not error) | Error | Prevents false "command failed" on no-match |
| `robocopy` | In sync | Files copied (success) | 0-7: success, 8+: error | Bitfield exit codes — the most common Windows CI gotcha |

The command name is extracted heuristically from the last pipeline segment (`commandSemantics.ts:121-125`), stripped of path prefixes, `.exe` suffix, surrounding quotes, and call operators (`&`, `.`).

Deliberately omitted from the semantics map: `diff` (ambiguous — aliased to `Compare-Object` in PS 5.1), `fc` (aliased to `Format-Custom`), `find` (ambiguous between Windows and Unix versions), and native PS cmdlets (which always exit 0).

### 6. Dynamic Prompt Generation

`prompt.ts` builds the system prompt that instructs the model how to use PowerShell. Key features:

- **Edition-specific syntax guidance** (`prompt.ts:51-71`): Detects whether the system has PowerShell Desktop (5.1) or Core (7+) via `getPowerShellEdition()` and provides tailored advice:
  - **Desktop 5.1**: No `&&`/`||`, no ternary/null-coalescing, warns about `2>&1` ErrorRecord wrapping, UTF-16 LE default encoding
  - **Core 7+**: `&&`/`||` available, ternary/null operators available, UTF-8 default
  - **Unknown**: Conservative 5.1-safe guidance

- **Background task notes** (`prompt.ts:26-31`): Conditionally included when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is not set.

- **Sleep guidance** (`prompt.ts:33-44`): Advises against `Start-Sleep` loops, recommending `run_in_background` or check commands instead.

- **Tool redirection** (`prompt.ts:127-133`): Instructs the model to use dedicated tools (Glob, Grep, FileRead, etc.) instead of PowerShell equivalents (Get-ChildItem, Select-String, Get-Content).

## Function Signatures

### `PowerShellTool` (exported tool object)

Built via `buildTool()`. Key methods:

- **`call(input, toolUseContext, canUseTool?, parentMessage?, onProgress?)`** → `Promise<{ data: Out }>` — Main execution entry point
- **`validateInput(input)`** → `Promise<ValidationResult>` — Pre-execution validation (sandbox policy, sleep detection)
- **`checkPermissions(input, context)`** → `Promise<PermissionResult>` — Delegates to `powershellToolHasPermission`
- **`isReadOnly(input)`** → `boolean` — Sync read-only check via security heuristics + cmdlet allowlist
- **`isSearchOrReadCommand(input)`** → `{ isSearch: boolean; isRead: boolean }` — Classifies for UI collapsibility
- **`mapToolResultToToolResultBlockParam(output, toolUseID)`** → `ToolResultBlockParam` — Formats output for the API

### `interpretCommandResult(command, exitCode, stdout, stderr)` → `{ isError: boolean; message?: string }`

> Source: `commandSemantics.ts:130-142`

Looks up the base command name in the semantics map and applies the corresponding interpretation rule.

### `detectBlockedSleepPattern(command)` → `string | null`

> Source: `PowerShellTool.tsx:189-205`

Returns a description string if the first statement is `Start-Sleep N` (N ≥ 2), otherwise `null`.

### `getPrompt()` → `Promise<string>`

> Source: `prompt.ts:73-145`

Generates the full system prompt with edition-specific guidance, timeout limits, and usage instructions.

## Type Definitions

### `PowerShellToolInput`

```typescript
{
  command: string              // The PowerShell command to execute
  timeout?: number             // Optional timeout in milliseconds
  description?: string         // Human-readable description of the command
  run_in_background?: boolean  // Run as a background task
  dangerouslyDisableSandbox?: boolean  // Bypass sandbox
}
```

### `Out` (Output type)

```typescript
{
  stdout: string
  stderr: string
  interrupted: boolean
  returnCodeInterpretation?: string  // Semantic message for non-error exit codes
  isImage?: boolean                  // stdout contains image data
  persistedOutputPath?: string       // Path to large output file
  persistedOutputSize?: number       // Total output size in bytes
  backgroundTaskId?: string          // ID if running in background
  backgroundedByUser?: boolean       // True if Ctrl+B backgrounded
  assistantAutoBackgrounded?: boolean // True if auto-backgrounded in assistant mode
}
```

### `CommandSemantic`

```typescript
type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => { isError: boolean; message?: string }
```

## UI Components

`UI.tsx` exports five React (Ink) rendering functions used by the tool framework:

| Function | Purpose |
|----------|---------|
| `renderToolUseMessage` | Displays the command being executed, truncated to 2 lines / 160 chars in non-verbose mode |
| `renderToolUseProgressMessage` | Shows live progress via `ShellProgressMessage` with output, elapsed time, line/byte counts |
| `renderToolUseQueuedMessage` | Shows "Waiting…" when the tool call is queued |
| `renderToolResultMessage` | Renders stdout/stderr via `OutputLine`, or status messages for images, background tasks, interrupts, no-output |
| `renderToolUseErrorMessage` | Delegates to `FallbackToolUseErrorMessage` |

## Configuration & Defaults

| Parameter | Default | Max | Source |
|-----------|---------|-----|--------|
| Command timeout | `getDefaultBashTimeoutMs()` | `getMaxBashTimeoutMs()` | Shared with BashTool via `timeouts.ts` |
| Max output length | `getMaxOutputLength()` | — | `outputLimits.ts` |
| Max persisted file size | 64 MB | — | Hardcoded in `PowerShellTool.tsx:596` |
| Progress threshold | 2000ms | — | `PROGRESS_THRESHOLD_MS` constant |
| Progress interval | 1000ms | — | `PROGRESS_INTERVAL_MS` constant |
| Assistant blocking budget | 15000ms | — | `ASSISTANT_BLOCKING_BUDGET_MS` constant |
| Max command display | 2 lines / 160 chars | — | `UI.tsx:17-18` |

**Environment variables**:
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`: Disables all background task functionality and removes `run_in_background` from the schema

## Edge Cases & Caveats

- **Windows sandbox unavailability**: Native Windows cannot use bwrap/sandbox-exec. If enterprise policy requires sandboxing AND forbids unsandboxed commands, all PowerShell execution is blocked. This is checked in both `validateInput` (for the normal path) and `call()` (for direct callers like `promptShellExecution.ts`).

- **Pre-flight sentinel pattern**: When PowerShell is not found or `exec()` throws during spawn, the tool returns `code: 0` with empty stdout and stderr containing the error message. This prevents `ShellError` from being thrown for commands that never ran. Git operation tracking skips these sentinels to avoid mis-counting.

- **Race between backgrounding and completion**: If a command completes in the same tick that backgrounding fires (e.g., the 15s timer resolves but the command finishes simultaneously), the progress loop detects `result.backgroundTaskId` on the completed result, strips it, suppresses the redundant `<task_notification>`, and reconstructs `outputFilePath` for large outputs (`PowerShellTool.tsx:876-908`).

- **`Start-Sleep` auto-backgrounding exclusion**: `Start-Sleep` and its alias `sleep` are excluded from automatic backgrounding (`DISALLOWED_AUTO_BACKGROUND_COMMANDS`) but can still be explicitly backgrounded via `run_in_background: true`.

- **EOL handling**: The module forces `\n` (never `\r\n`) for terminal output to avoid breaking Ink rendering on Windows (`PowerShellTool.tsx:48`).

- **PS 5.1 `2>&1` gotcha**: The prompt warns against redirecting stderr on native executables in Windows PowerShell 5.1, as it wraps each line in an `ErrorRecord` and sets `$?` to `$false` even on exit code 0.