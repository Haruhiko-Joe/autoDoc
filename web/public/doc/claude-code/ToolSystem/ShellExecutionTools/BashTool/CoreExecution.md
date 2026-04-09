# CoreExecution — BashTool Definition & Command Execution Pipeline

## Overview & Responsibilities

CoreExecution is the entry point and orchestration layer for the BashTool — the primary tool that gives Claude the ability to run shell commands. It sits within the **ToolSystem → ShellExecutionTools → BashTool** hierarchy, alongside the PowerShellTool (Windows equivalent) and REPLMode modules.

This module defines:
- The **BashTool's input/output schemas** and tool metadata
- The **full command execution lifecycle**: spawning, timeout handling, progress streaming, background task management, and output processing
- The **system prompt** that teaches Claude how to use the Bash tool correctly
- **Command semantic interpretation** for tools like `grep` and `diff` that use non-zero exit codes for non-error conditions
- **Comment label extraction** for UI display
- The **BASH_TOOL_NAME** constant

The five files covered here are: `src/tools/BashTool/BashTool.tsx` (main tool definition), `src/tools/BashTool/prompt.ts` (system prompt generation), `src/tools/BashTool/commandSemantics.ts` (exit code interpretation), `src/tools/BashTool/commentLabel.ts` (UI label extraction), and `src/tools/BashTool/toolName.ts` (name constant).

---

## Key Processes

### 1. Command Execution Lifecycle (`BashTool.call` → `runShellCommand`)

The execution pipeline follows these steps:

1. **Simulated sed check**: If `_simulatedSedEdit` is present (set by the permission dialog after user previews a sed edit), the command is bypassed entirely — `applySedEdit()` writes the pre-approved content directly to the file (`src/tools/BashTool/BashTool.tsx:624-629`).

2. **Generator-based execution**: `runShellCommand()` is an `AsyncGenerator` that yields progress updates and returns the final `ExecResult` (`src/tools/BashTool/BashTool.tsx:826-853`).

3. **Shell spawning**: Calls `exec()` (from `src/utils/Shell.js`) with the command, timeout, sandbox flag, and an `onProgress` callback that feeds output into the generator's progress signal (`src/tools/BashTool/BashTool.tsx:881-898`).

4. **Background task handling** (three paths):
   - **Explicit**: When `run_in_background: true`, immediately spawns a `LocalShellTask` and returns a task ID (`src/tools/BashTool/BashTool.tsx:989-1001`).
   - **Timeout-triggered**: When a command exceeds its timeout, `shellCommand.onTimeout` fires, spawning a background task so the command keeps running (`src/tools/BashTool/BashTool.tsx:967-971`).
   - **Assistant auto-background**: In assistant/Kairos mode on the main thread, a 15-second timer auto-backgrounds blocking commands to keep the agent responsive (`src/tools/BashTool/BashTool.tsx:976-983`, constant `ASSISTANT_BLOCKING_BUDGET_MS = 15_000`).

5. **Progress streaming**: After a 2-second threshold (`PROGRESS_THRESHOLD_MS`), the generator enters a polling loop — yielding progress updates (output lines, elapsed time, total bytes) and rendering a `<BackgroundHint />` UI component that allows users to manually background via Ctrl+B (`src/tools/BashTool/BashTool.tsx:1003-1137`).

6. **Output processing** (in `call()`):
   - **Truncation**: `EndTruncatingAccumulator` handles output that exceeds inline limits, keeping the beginning and end.
   - **Exit code interpretation**: `interpretCommandResult()` determines if a non-zero exit code is actually an error (see Command Semantics below).
   - **Image detection and resizing**: `isImageOutput()` checks for base64 image data; `resizeShellImageOutput()` caps dimensions/size.
   - **Large result persistence**: Outputs exceeding 30K chars are persisted to disk (hard-linked or copied to a `tool-results` directory, capped at 64 MB). The model receives a `<persisted-output>` wrapper with a preview and file path (`src/tools/BashTool/BashTool.tsx:732-753`).
   - **Claude Code hints**: Strips `<claude-code-hint />` tags from output (a zero-token side channel for plugin recommendations) (`src/tools/BashTool/BashTool.tsx:780-784`).
   - **Sandbox violation annotation**: `SandboxManager.annotateStderrWithSandboxFailures()` adds context when sandbox restrictions cause failures (`src/tools/BashTool/BashTool.tsx:710`).

### 2. Command Classification for UI Collapse

`isSearchOrReadBashCommand()` (`src/tools/BashTool/BashTool.tsx:95-172`) classifies commands for the UI's collapsible display:

| Category | Commands | UI Behavior |
|----------|----------|-------------|
| **Search** | `find`, `grep`, `rg`, `ag`, `ack`, `locate`, `which`, `whereis` | Collapsed with search label |
| **Read** | `cat`, `head`, `tail`, `less`, `more`, `wc`, `stat`, `file`, `strings`, `jq`, `awk`, `cut`, `sort`, `uniq`, `tr` | Collapsed with read label |
| **List** | `ls`, `tree`, `du` | Collapsed with list label |
| **Silent** | `mv`, `cp`, `rm`, `mkdir`, `chmod`, `touch`, `ln`, `cd`, `export` | Shows "Done" instead of "(No output)" |
| **Neutral** | `echo`, `printf`, `true`, `false`, `:` | Ignored in classification; don't affect pipeline type |

For pipelines and compound commands, **all** non-neutral parts must be search/read/list for the whole command to be classified as collapsible.

### 3. System Prompt Generation (`prompt.ts`)

`getSimplePrompt()` (`src/tools/BashTool/prompt.ts:275-369`) assembles the model-facing prompt with:

- **Tool preference directives**: Steer Claude toward dedicated tools (Glob, Grep, Read, Edit, Write) instead of shell equivalents. When embedded search tools are enabled (ant-native builds), `find`/`grep` steering is removed.
- **Instruction items**: Working directory advice, timeout limits, background usage notes, multiple-command guidance (`&&` vs `;` vs parallel calls), git safety rules, and sleep avoidance rules.
- **Sandbox section** (`getSimpleSandboxSection()`, `src/tools/BashTool/prompt.ts:172-273`): When sandboxing is enabled, documents filesystem read/write restrictions, network host rules, and `$TMPDIR` usage. Includes guidance on when `dangerouslyDisableSandbox` is appropriate (or if it's policy-disabled entirely).
- **Git commit and PR instructions** (`getCommitAndPRInstructions()`, `src/tools/BashTool/prompt.ts:42-161`): Full inline instructions for external users (git safety protocol, step-by-step commit/PR workflow, attribution text). Ant-internal users get a shorter version pointing to `/commit` and `/commit-push-pr` skills.

Timeout defaults are delegated to `getDefaultBashTimeoutMs()` and `getMaxBashTimeoutMs()` from `src/utils/timeouts.js`.

### 4. Exit Code Interpretation (`commandSemantics.ts`)

`interpretCommandResult()` (`src/tools/BashTool/commandSemantics.ts:124-140`) applies command-specific semantics to avoid false error reporting:

| Command | Exit 0 | Exit 1 | Exit 2+ |
|---------|--------|--------|---------|
| `grep` / `rg` | Matches found | No matches (not error) | Real error |
| `find` | Success | Partial success (some dirs inaccessible) | Real error |
| `diff` | No differences | Differences found (not error) | Real error |
| `test` / `[` | Condition true | Condition false (not error) | Real error |
| Everything else | Success | Error | Error |

The function uses `heuristicallyExtractBaseCommand()` (`src/tools/BashTool/commandSemantics.ts:112-119`) to extract the **last** command in a pipeline (since the last command determines the overall exit code). It splits using `splitCommand_DEPRECATED()` and takes the final segment.

### 5. Comment Label Extraction (`commentLabel.ts`)

`extractBashCommentLabel()` (`src/tools/BashTool/commentLabel.ts:8-13`) extracts leading `# comment` lines from bash commands (excluding `#!` shebangs) to use as UI labels. In fullscreen mode, this becomes both the non-verbose tool-use label and the collapse-group hint — the human-readable description Claude wrote for the command.

```typescript
// Input:  "# Install dependencies\nnpm install"
// Output: "Install dependencies"

// Input:  "#!/bin/bash\necho hello"
// Output: undefined (shebang lines are excluded)
```

---

## Function Signatures & Parameters

### `BashTool` (tool definition, `src/tools/BashTool/BashTool.tsx:420-825`)

Built via `buildTool()`, implementing the `ToolDef` interface.

**Input Schema** (`src/tools/BashTool/BashTool.tsx:227-259`):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | Yes | The shell command to execute |
| `timeout` | `number` | No | Timeout in milliseconds (max from `getMaxBashTimeoutMs()`) |
| `description` | `string` | No | Human-readable description of what the command does |
| `run_in_background` | `boolean` | No | Run in background; omitted when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is set |
| `dangerouslyDisableSandbox` | `boolean` | No | Bypass sandbox restrictions |

The `_simulatedSedEdit` field is **internal only** — always omitted from the model-facing schema to prevent permission bypass.

**Output Schema** (`src/tools/BashTool/BashTool.tsx:279-294`):

| Field | Type | Description |
|-------|------|-------------|
| `stdout` | `string` | Standard output (stderr is merged in) |
| `stderr` | `string` | Shell reset message if cwd was reset |
| `interrupted` | `boolean` | Whether the command was aborted |
| `isImage` | `boolean?` | Whether stdout contains base64 image data |
| `backgroundTaskId` | `string?` | ID if running in background |
| `backgroundedByUser` | `boolean?` | True if user pressed Ctrl+B |
| `assistantAutoBackgrounded` | `boolean?` | True if auto-backgrounded in assistant mode |
| `returnCodeInterpretation` | `string?` | Semantic message for non-error exit codes |
| `noOutputExpected` | `boolean?` | Whether command is expected to be silent |
| `persistedOutputPath` | `string?` | Path to full output on disk (large results) |
| `persistedOutputSize` | `number?` | Total output size in bytes |

### `interpretCommandResult(command, exitCode, stdout, stderr)`

> Source: `src/tools/BashTool/commandSemantics.ts:124-140`

Returns `{ isError: boolean, message?: string }`. Determines if a non-zero exit code represents a genuine error or an expected informational result by looking up command-specific semantics from the `COMMAND_SEMANTICS` map.

### `extractBashCommentLabel(command: string): string | undefined`

> Source: `src/tools/BashTool/commentLabel.ts:8-13`

Returns the text of a leading `# comment` line (without the `#` prefix), or `undefined` if none exists or it is a shebang.

### `getSimplePrompt(): string`

> Source: `src/tools/BashTool/prompt.ts:275-369`

Returns the complete system prompt for the Bash tool, including tool preferences, instructions, sandbox configuration, and git/PR workflows.

### `isSearchOrReadBashCommand(command: string): { isSearch: boolean, isRead: boolean, isList: boolean }`

> Source: `src/tools/BashTool/BashTool.tsx:95-172`

Classifies a command (including pipelines and compound commands) for UI collapse behavior. All non-neutral parts must belong to the same category for classification to apply.

### `detectBlockedSleepPattern(command: string): string | null`

> Source: `src/tools/BashTool/BashTool.tsx:322-337`

Detects standalone or leading `sleep N` (N >= 2) patterns that should use `run_in_background` or the Monitor tool instead. Returns a descriptive string if blocked, `null` otherwise.

---

## Interface/Type Definitions

### `CommandSemantic` (`src/tools/BashTool/commandSemantics.ts:10-17`)

```typescript
type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}
```

A function type that interprets a command's exit code along with its stdout/stderr to decide whether the result is an error and optionally provides a human-readable message.

### `BashToolInput` (`src/tools/BashTool/BashTool.tsx:264`)

The inferred Zod type from `fullInputSchema` — includes all input parameters including the internal `_simulatedSedEdit`.

### `Out` (`src/tools/BashTool/BashTool.tsx:296`)

The inferred Zod type from `outputSchema` — the complete output structure returned by `BashTool.call()`.

### `BashProgress` (re-exported from `src/types/tools.js`)

The progress event type yielded by `runShellCommand()`, containing `output`, `fullOutput`, `elapsedTimeSeconds`, `totalLines`, `totalBytes`, `taskId`, and `timeoutMs`.

---

## Configuration & Defaults

| Constant / Env Var | Value / Source | Purpose |
|--------------------|---------------|---------|
| `PROGRESS_THRESHOLD_MS` | `2000` | Delay before progress streaming begins |
| `ASSISTANT_BLOCKING_BUDGET_MS` | `15000` | Auto-background threshold in assistant mode |
| `maxResultSizeChars` | `30000` | Threshold for persisting output to disk |
| `MAX_PERSISTED_SIZE` | `64 MB` | Maximum size for persisted output files |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | env var | Disables background task support entirely |
| `CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR` | env var | Shows "SandboxedBash" in UI instead of "Bash" |
| Default timeout | `getDefaultBashTimeoutMs()` | 2 minutes (120000ms) by default |
| Max timeout | `getMaxBashTimeoutMs()` | 10 minutes (600000ms) by default |
| `BASH_TOOL_NAME` | `'Bash'` | Tool name constant (`src/tools/BashTool/toolName.ts:2`) |

---

## Edge Cases & Caveats

- **Sed edits are simulated**: When the user approves a sed edit in the permission dialog, the actual sed command is never run. Instead, the pre-computed result (`_simulatedSedEdit`) is written directly via `applySedEdit()`, guaranteeing WYSIWYG behavior. This field is hidden from the model's schema to prevent bypass.

- **stderr is merged into stdout**: The shell uses merged file descriptors, so `result.stdout` contains both stdout and stderr. The output `stderr` field in the result is only used for shell-reset messages (when cwd drifts outside the project).

- **Race between completion and backgrounding**: If a command completes at the same moment it is being backgrounded (timeout, Ctrl+B, or assistant auto-background), the result is cleaned up — `backgroundTaskId` is stripped, the foreground task is unregistered, and the redundant `<task_notification>` is suppressed via `markTaskNotified()` (`src/tools/BashTool/BashTool.tsx:1047-1065`).

- **Sleep blocking**: When the `MONITOR_TOOL` feature is enabled, standalone `sleep N` commands with N >= 2 are blocked at validation with an error, steering toward `run_in_background` or the Monitor tool instead (`src/tools/BashTool/BashTool.tsx:525-534`).

- **`toolName.ts` exists to break circular dependencies**: `BASH_TOOL_NAME` is in its own file because `prompt.ts` imports it, and importing from `BashTool.tsx` would create a circular dependency.

- **Pipeline exit code semantics**: `heuristicallyExtractBaseCommand()` takes the **last** command in a pipeline for semantic interpretation, since that determines the overall exit code. This is explicitly noted as heuristic — not suitable for security decisions (`src/tools/BashTool/commandSemantics.ts:109-119`).

- **Prompt cache optimization**: The sandbox section deduplicates paths and normalizes per-UID temp directories to `$TMPDIR` so the prompt is identical across users, enabling cross-user prompt caching (`src/tools/BashTool/prompt.ts:186-190`).

- **Auto-backgrounding exclusions**: `sleep` commands are excluded from auto-backgrounding (`DISALLOWED_AUTO_BACKGROUND_COMMANDS`) but can still be explicitly backgrounded via `run_in_background: true` (`src/tools/BashTool/BashTool.tsx:219-221`).