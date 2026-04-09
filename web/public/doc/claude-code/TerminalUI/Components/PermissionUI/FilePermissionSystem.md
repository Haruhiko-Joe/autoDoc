# FilePermissionSystem

## Overview & Responsibilities

The FilePermissionSystem is the shared permission dialog infrastructure for all file-related tool operations in Claude Code's terminal UI. It sits within the **TerminalUI > Components > PermissionUI** layer and provides a unified, consistent user experience whenever Claude needs approval to read, write, edit, or modify files on disk.

The system follows a layered architecture:
- A **generic core** (`FilePermissionDialog/`) handles dialog rendering, state management, permission option generation, and accept/reject logic
- **Tool-specific wrappers** adapt the generic core for each file operation tool (Edit, Write, Read/Glob/Grep, NotebookEdit, Sed)

Sibling modules in the PermissionUI group include `PermissionPrompt` (the orchestrator that routes to the correct permission request component), `PermissionDialog` (the visual wrapper), and tool-specific components for non-file tools (Bash, PowerShell, WebFetch, etc.).

## Key Processes

### Permission Dialog Rendering Flow

1. A tool-specific wrapper (e.g., `FileEditPermissionRequest`) receives `PermissionRequestProps` including `toolUseConfirm`, `onDone`, and `onReject`
2. The wrapper parses the tool input via Zod schema validation, extracting file path and operation-specific data
3. It passes these to `FilePermissionDialog`, along with a `parseInput` function, `operationType`, optional `ideDiffSupport`, and display metadata (title, question, content)
4. `FilePermissionDialog` (`src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx:48-203`):
   - Derives language name from the file path via `getLanguageName()` for analytics
   - Detects symlinks using `safeResolvePath()` and warns the user, especially when the target is outside the working directory
   - Calls `useFilePermissionDialog()` to set up dialog state and option generation
   - If IDE diff support is configured and active, renders `ShowInIDEPrompt` instead of the inline dialog
   - Otherwise renders the standard `PermissionDialog` with a `Select` component for user choice

### Permission Option Generation

`getFilePermissionOptions()` (`src/components/permissions/FilePermissionDialog/permissionOptions.tsx:53-176`) generates context-aware options based on the file location:

1. **"Yes" (accept-once)**: Always present. When in feedback input mode, includes a text input field with placeholder "and tell Claude what to do next"
2. **Session-level accept**: Varies by file location:
   - Files in project `.claude/` folder → "Yes, and allow Claude to edit its own settings for this session" (scope: `claude-folder`)
   - Files in global `~/.claude/` folder → same label but scope: `global-claude-folder`
   - Files inside the allowed working directory → "Yes, during this session" (for reads) or "Yes, allow all edits during this session (Shift+Tab)" (for writes)
   - Files outside working directory → includes the directory name, e.g., "Yes, allow all edits in **dirname/** during this session"
3. **"No" (reject)**: Always present. When in feedback input mode, includes a text input with placeholder "and tell Claude what to do differently"

The `.claude/` folder detection uses `isInClaudeFolder()` and `isInGlobalClaudeFolder()` (`src/components/permissions/FilePermissionDialog/permissionOptions.tsx:15-40`), which expand paths and perform case-normalized prefix matching.

### Accept/Reject Handler Flow

`usePermissionHandler.ts` defines three handler functions dispatched via the `PERMISSION_HANDLERS` map (`src/components/permissions/FilePermissionDialog/usePermissionHandler.ts:178-185`):

1. **`handleAcceptOnce`** (`src/components/permissions/FilePermissionDialog/usePermissionHandler.ts:63-85`): Logs the accept event with analytics, calls `onDone()`, then invokes `toolUseConfirm.onAllow()` with no permission updates, optionally passing user feedback
2. **`handleAcceptSession`** (`src/components/permissions/FilePermissionDialog/usePermissionHandler.ts:87-139`): For `claude-folder` or `global-claude-folder` scope, creates `PermissionUpdate` rules granting session-level access to all files matching `CLAUDE_FOLDER_PERMISSION_PATTERN` or `GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN`. For regular files, calls `generateSuggestions()` to produce path-based permission rules
3. **`handleReject`** (`src/components/permissions/FilePermissionDialog/usePermissionHandler.ts:141-176`): Logs the reject event, calls both `onDone()` and `onReject()`, then invokes `toolUseConfirm.onReject()` with optional feedback

### Dialog State Management

`useFilePermissionDialog` (`src/components/permissions/FilePermissionDialog/useFilePermissionDialog.ts:53-212`) manages:

- **Feedback text**: Separate `acceptFeedback` and `rejectFeedback` strings for user instructions
- **Input mode**: `yesInputMode` and `noInputMode` toggles, activated by Tab key. Once entered, `yesFeedbackModeEntered`/`noFeedbackModeEntered` flags persist across collapses for analytics
- **Focused option tracking**: Navigation resets input mode when moving away from an option with no text entered
- **Keyboard shortcut**: Registers `confirm:cycleMode` keybinding (typically Shift+Tab) to quickly select the session-level accept option
- **Analytics**: Logs feedback mode enter/collapse events via `logEvent()`

### IDE Diff Integration

When an IDE is connected, `FilePermissionDialog` integrates with the `useDiffInIDE` hook:

1. `IDEDiffSupport<TInput>` (`src/components/permissions/FilePermissionDialog/ideDiffConfig.ts:20-23`) defines `getConfig()` to extract diff configuration and `applyChanges()` to transform tool input based on user edits in the IDE
2. If the IDE is showing the diff, the dialog renders `ShowInIDEPrompt` instead of the inline diff view
3. When the user accepts, `closeTabInIDE()` is called before processing the permission choice

## Function Signatures

### `FilePermissionDialog<T>(props: FilePermissionDialogProps<T>): React.ReactNode`

The generic permission dialog component. Key props:

| Prop | Type | Description |
|------|------|-------------|
| `toolUseConfirm` | `ToolUseConfirm` | The pending tool use confirmation object |
| `toolUseContext` | `ToolUseContext` | Context for the tool use (used for IDE diff) |
| `onDone` / `onReject` | `() => void` | Callbacks for dialog completion |
| `title` | `string` | Dialog title (e.g., "Edit file", "Create file") |
| `path` | `string \| null` | File path for the operation |
| `parseInput` | `(input: unknown) => T` | Zod-based input parser |
| `operationType` | `FileOperationType` | `'read'`, `'write'`, or `'create'` (default: `'write'`) |
| `ideDiffSupport` | `IDEDiffSupport<T>` | Optional IDE diff integration |
| `content` | `React.ReactNode` | Diff or content to display in the dialog body |

> Source: `src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx:20-47`

### `useFilePermissionDialog<T>(props): UseFilePermissionDialogResult<T>`

Hook returning dialog state and handlers. Returns `options`, `onChange`, `acceptFeedback`, `rejectFeedback`, `focusedOption`, `setFocusedOption`, `handleInputModeToggle`, `yesInputMode`, `noInputMode`.

> Source: `src/components/permissions/FilePermissionDialog/useFilePermissionDialog.ts:53-212`

### `getFilePermissionOptions(params): PermissionOptionWithLabel[]`

Generates the list of permission options based on file location, operation type, and input mode state.

> Source: `src/components/permissions/FilePermissionDialog/permissionOptions.tsx:53-176`

## Interface/Type Definitions

### `PermissionOption`

```typescript
type PermissionOption =
  | { type: 'accept-once' }
  | { type: 'accept-session'; scope?: 'claude-folder' | 'global-claude-folder' }
  | { type: 'reject' }
```

> Source: `src/components/permissions/FilePermissionDialog/permissionOptions.tsx:41-48`

### `FileOperationType`

```typescript
type FileOperationType = 'read' | 'write' | 'create'
```

Controls label text and permission rule generation. `'read'` operations skip symlink detection and show read-specific labels.

> Source: `src/components/permissions/FilePermissionDialog/permissionOptions.tsx:52`

### `IDEDiffSupport<TInput>`

```typescript
interface IDEDiffSupport<TInput extends ToolInput> {
  getConfig(input: TInput): IDEDiffConfig
  applyChanges(input: TInput, modifiedEdits: FileEdit[]): TInput
}
```

Allows each tool wrapper to define how its input maps to an IDE-editable diff and how user edits in the IDE flow back into the tool input.

> Source: `src/components/permissions/FilePermissionDialog/ideDiffConfig.ts:20-23`

### `IDEDiffConfig`

```typescript
interface IDEDiffConfig {
  filePath: string
  edits?: FileEdit[]
  editMode?: 'single' | 'multiple'
}
```

> Source: `src/components/permissions/FilePermissionDialog/ideDiffConfig.ts:9-13`

### `PermissionHandlerParams` / `PermissionHandlerOptions`

```typescript
type PermissionHandlerParams = {
  messageId: string; path: string | null; toolUseConfirm: ToolUseConfirm;
  toolPermissionContext: ToolPermissionContext; onDone: () => void;
  onReject: () => void; completionType: CompletionType;
  languageName: string | Promise<string>; operationType: FileOperationType;
}
type PermissionHandlerOptions = {
  hasFeedback?: boolean; feedback?: string;
  enteredFeedbackMode?: boolean;
  scope?: 'claude-folder' | 'global-claude-folder';
}
```

> Source: `src/components/permissions/FilePermissionDialog/usePermissionHandler.ts:44-61`

## Tool-Specific Wrappers

### `FileEditPermissionRequest`

Handles the `Edit` tool. Parses input via `FileEditTool.inputSchema`, renders a `FileEditToolDiff` showing old→new string replacement, and provides `IDEDiffSupport` via `createSingleEditDiffConfig()`. Dialog title: "Edit file".

> Source: `src/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx`

### `FileWritePermissionRequest`

Handles the `Write` tool. Reads the existing file content via `readFileSync()` (catching ENOENT for new files), shows a `FileWriteToolDiff` with structured diff (existing file) or syntax-highlighted preview (new file). Dialog title dynamically set to "Overwrite file" or "Create file" based on file existence. Provides `IDEDiffSupport` that treats the entire file content as a single edit.

> Source: `src/components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.tsx`

### `FileWriteToolDiff`

Renders the diff view for file writes. For existing files, uses `getPatchForDisplay()` to generate hunks and renders `StructuredDiff` components. For new files, renders the content via `HighlightedCode`.

> Source: `src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.tsx`

### `FilesystemPermissionRequest`

Handles Glob, Grep, and FileRead tools. Extracts the path via `tool.getPath()`, determines read-only status via `tool.isReadOnly()`, and renders the tool's own `renderToolUseMessage()` as content. Falls back to `FallbackPermissionRequest` if no path can be extracted. Does not provide IDE diff support.

> Source: `src/components/permissions/FilesystemPermissionRequest/FilesystemPermissionRequest.tsx`

### `NotebookEditPermissionRequest`

Handles Jupyter notebook edits. Parses `NotebookEditTool.inputSchema` extracting `notebook_path`, `edit_mode`, and `cell_type`. Sets language name based on cell type (`'python'` or `'markdown'`). Renders `NotebookEditToolDiff` which asynchronously reads the notebook JSON, locates the target cell by index or ID, and shows a structured diff of the cell source. Dialog title: "Edit notebook".

> Source: `src/components/permissions/NotebookEditPermissionRequest/NotebookEditPermissionRequest.tsx`

### `SedEditPermissionRequest`

Handles sed-based file edits from the Bash tool. Receives `SedEditInfo` alongside standard props. Asynchronously reads the target file (detecting encoding), applies `applySedSubstitution()` to compute the new content, and renders a `FileEditToolDiff`. If the sed command produces no changes, displays a "no matches found" warning. Wraps file reading in `Suspense`.

> Source: `src/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx`

## Edge Cases & Caveats

- **Symlink detection**: Write operations resolve symlinks via `safeResolvePath()`. If the resolved target is outside the working directory, a warning is shown in the dialog. Read operations skip symlink detection entirely (`src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx:76-89`)
- **Session permissions for `.claude/` folders**: These use special permission patterns (`CLAUDE_FOLDER_PERMISSION_PATTERN` / `GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN`) rather than path-based suggestions, granting blanket session-level access to the entire `.claude/` directory
- **Feedback mode persistence**: Once a user enters feedback mode (via Tab), the `enteredFeedbackMode` flag is sent with analytics even if the user collapses the input without typing anything
- **File existence in writes**: `FileWritePermissionRequest` synchronously reads the file to determine existence. If the file doesn't exist (ENOENT), it shows "Create file" instead of "Overwrite file" and renders highlighted code instead of a diff
- **Async notebook/sed reads**: Both `NotebookEditToolDiff` and `SedEditPermissionRequest` use React `Suspense` with `use()` to handle async file reads, rendering `null` as fallback during loading
- **IDE diff override**: When `useDiffInIDE` reports the diff is showing in an IDE, the entire inline dialog is replaced with `ShowInIDEPrompt`, and IDE tab cleanup happens before permission processing
- **Input passthrough transformation**: The `onChange` callback in `useFilePermissionDialog` overrides `toolUseConfirm.onAllow` to pass the parsed (and potentially IDE-modified) input rather than the raw input