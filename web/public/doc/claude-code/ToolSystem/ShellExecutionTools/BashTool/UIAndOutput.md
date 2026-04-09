# UI and Output Processing

## Overview & Responsibilities

This module provides the **React (Ink) UI components** and **shared utility functions** for rendering BashTool interactions in the terminal interface. It sits within the `ToolSystem > ShellExecutionTools > BashTool` hierarchy and is responsible for two concerns:

1. **UI rendering** (`UI.tsx`, `BashToolResultMessage.tsx`): A set of exported render functions that the tool framework calls at each stage of a shell command's lifecycle — from displaying the command being run, through streaming progress, to showing the final result (stdout/stderr, images, errors, background task hints).
2. **Shared utilities** (`utils.ts`): Output processing helpers (truncation, image detection/resizing, working-directory safety) that are consumed by both BashTool and PowerShellTool.

The module spans ~597 lines across 3 files.

---

## Key Processes

### Command Display Flow (`renderToolUseMessage`)

When Claude invokes BashTool, the UI needs to display the command concisely:

1. Check if the command is a `sed` in-place edit via `parseSedEditCommand()` — if so, render only the file path (like a file edit tool) (`src/tools/BashTool/UI.tsx:99-103`)
2. In non-verbose mode, attempt to extract a bash comment label (e.g., `# Building project`) for fullscreen environments, displaying just the label (`UI.tsx:107-109`)
3. Otherwise, truncate the command to at most **2 lines** and **160 characters**, appending an ellipsis if needed (`UI.tsx:112-127`)
4. In verbose mode, render the full command string as-is

### Progress & Queued States

- `renderToolUseProgressMessage` reads the last progress message and delegates to `ShellProgressMessage`, passing streaming output, elapsed time, total lines/bytes, and timeout info (`UI.tsx:131-153`)
- `renderToolUseQueuedMessage` renders a simple "Waiting…" placeholder (`UI.tsx:154-158`)

### Result Rendering Flow (`BashToolResultMessage`)

Once the command completes, `renderToolResultMessage` delegates to the `BashToolResultMessage` component, which handles the full output display:

1. **Sandbox violation extraction**: Strip `<sandbox_violations>` tags from stderr (`BashToolResultMessage.tsx:24-39`)
2. **CWD reset warning extraction**: Pull out any "Shell cwd was reset to …" message from stderr and display it separately as a dimmed notice (`BashToolResultMessage.tsx:45-65`)
3. **Image output**: If `isImage` is true, render `[Image data detected and sent to Claude]` and return early (`BashToolResultMessage.tsx:100-109`)
4. **Normal output**: Render stdout via `OutputLine`, then stderr (marked as error), then any cwd-reset warning, and finally a timeout display via `ShellTimeDisplay` if applicable
5. **Empty output**: When both stdout and stderr are empty, display contextual fallback text — "Running in the background" (with keybinding hint), the return code interpretation, "Done" (if no output was expected), or "(No output)" (`BashToolResultMessage.tsx:155-156`)

### Background Task Handling (`BackgroundHint`)

The `BackgroundHint` component is shared with PowerShellTool. It:

1. Registers the `task:background` keybinding (default `ctrl+b`) via `useKeybinding` (`UI.tsx:69`)
2. When triggered, calls `backgroundAll()` to move all running foreground commands to background
3. Handles tmux edge case: if the terminal is tmux and the shortcut is `ctrl+b`, displays "ctrl+b ctrl+b (twice)" since `ctrl+b` is tmux's prefix key (`UI.tsx:71`)
4. Renders nothing if `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is set (`UI.tsx:72-74`)

### Output Truncation (`formatOutput`)

The `formatOutput` utility processes raw shell output before it's sent back to the model:

1. If the content is a base64 image data URI, return it as-is with `totalLines: 1` (`utils.ts:138-145`)
2. If content length is within `getMaxOutputLength()`, return unchanged with an accurate line count (`utils.ts:148-154`)
3. Otherwise, slice to the max length, count remaining truncated lines, and append a `... [N lines truncated] ...` indicator (`utils.ts:156-164`)

### Image Processing Pipeline

Three functions form the image handling chain:

1. **`isImageOutput(content)`**: Regex test for `data:image/...;base64,...` pattern (`utils.ts:49-51`)
2. **`buildImageToolResult(stdout, toolUseID)`**: Parses the data URI and wraps it in an Anthropic API `ToolResultBlockParam` with `type: 'image'` (`utils.ts:71-91`)
3. **`resizeShellImageOutput(stdout, outputFilePath, outputFileSize)`**: Re-reads the full image from disk if it was truncated in memory (avoiding corrupt base64), caps file reads at 20 MB, then delegates to `maybeResizeAndDownsampleImageBuffer` for dimension/size normalization (`utils.ts:110-131`)

### Working Directory Safety (`resetCwdIfOutsideProject`)

After each command, this function checks whether the shell's cwd has moved outside the allowed working paths:

1. If `shouldMaintainProjectWorkingDir()` is true, unconditionally reset to the original cwd (`utils.ts:176-177`)
2. Otherwise, if the cwd has changed AND is not in the allowed working path, reset to original cwd and log a `tengu_bash_tool_reset_to_original_dir` analytics event (`utils.ts:181-189`)
3. Returns `true` if the cwd was reset due to being outside the allowed path (not for the maintain-project case)

---

## Function Signatures

### UI.tsx — Render Functions

| Function | Parameters | Returns | Description |
|---|---|---|---|
| `BackgroundHint({ onBackground? })` | Optional callback | `ReactNode \| null` | Keybinding-aware hint for backgrounding tasks |
| `renderToolUseMessage(input, { verbose, theme })` | `Partial<BashToolInput>`, display options | `ReactNode` | Displays the command being executed |
| `renderToolUseProgressMessage(progressMessages, { verbose, tools, terminalSize, inProgressToolCallCount })` | Progress array, context | `ReactNode` | Shows streaming output during execution |
| `renderToolUseQueuedMessage()` | — | `ReactNode` | Static "Waiting…" message |
| `renderToolResultMessage(content, progressMessages, { verbose, theme, tools, style? })` | `Out`, progress array, display options | `ReactNode` | Delegates to `BashToolResultMessage` |
| `renderToolUseErrorMessage(result, { verbose, progressMessages, tools })` | Error content, context | `ReactNode` | Delegates to `FallbackToolUseErrorMessage` |

### utils.ts — Utility Functions

| Function | Signature | Description |
|---|---|---|
| `stripEmptyLines` | `(content: string) => string` | Trims leading/trailing empty lines, preserving inner whitespace |
| `isImageOutput` | `(content: string) => boolean` | Tests if content is a base64 image data URI |
| `parseDataUri` | `(s: string) => { mediaType, data } \| null` | Extracts media type and base64 payload from a data URI |
| `buildImageToolResult` | `(stdout: string, toolUseID: string) => ToolResultBlockParam \| null` | Wraps image data as an API-compatible tool result |
| `resizeShellImageOutput` | `(stdout, outputFilePath?, outputFileSize?) => Promise<string \| null>` | Re-reads and resizes image output for API submission |
| `formatOutput` | `(content: string) => { totalLines, truncatedContent, isImage? }` | Truncates output with line-count indicators |
| `resetCwdIfOutsideProject` | `(toolPermissionContext) => boolean` | Resets cwd if it has moved outside allowed paths |
| `stdErrAppendShellResetMessage` | `(stderr: string) => string` | Appends "Shell cwd was reset to …" to stderr |
| `createContentSummary` | `(content: ContentBlockParam[]) => string` | Summarizes MCP results with image/text block counts |

---

## Configuration & Defaults

| Constant / Config | Value | Location |
|---|---|---|
| `MAX_COMMAND_DISPLAY_LINES` | 2 | `UI.tsx:26` |
| `MAX_COMMAND_DISPLAY_CHARS` | 160 | `UI.tsx:27` |
| `MAX_IMAGE_FILE_SIZE` | 20 MB | `utils.ts:96` |
| `getMaxOutputLength()` | Dynamic (from `outputLimits`) | `utils.ts:147` |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Env var, truthy disables `BackgroundHint` | `UI.tsx:72` |

---

## Edge Cases & Caveats

- **Truncated base64 images**: If shell output was truncated in memory, `resizeShellImageOutput` re-reads the full file from disk to avoid sending corrupt base64 to the API. Files over 20 MB are rejected (`utils.ts:116-119`).
- **tmux prefix conflict**: When running inside tmux, `ctrl+b` is the default tmux prefix, so the UI shows "ctrl+b ctrl+b (twice)" to indicate users need to press it twice (`UI.tsx:71`).
- **React Compiler memoization**: Both `UI.tsx` and `BashToolResultMessage.tsx` are compiled with the React Compiler, producing `_c()` memoization arrays instead of manual `useMemo`/`useCallback`. The generated code is dense but follows standard React Compiler patterns.
- **Sandbox violations are silently cleaned**: `extractSandboxViolations` strips `<sandbox_violations>` tags from stderr before display, so users never see raw sandbox enforcement details (`BashToolResultMessage.tsx:24-39`).
- **CWD reset fast-path**: `resetCwdIfOutsideProject` skips the `pathInAllowedWorkingPath` syscalls when cwd hasn't changed from the original, since the original cwd is always in the allowed set (`utils.ts:179-182`).
- **Comment label display**: In fullscreen mode, `renderToolUseMessage` extracts a bash comment label (e.g., `# Checking dependencies`) and shows it instead of the raw command, improving readability for labelled tool calls (`UI.tsx:107-109`).