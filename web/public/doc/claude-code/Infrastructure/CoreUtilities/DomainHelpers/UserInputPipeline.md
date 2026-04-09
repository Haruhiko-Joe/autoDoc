# UserInputPipeline

## Overview & Responsibilities

The UserInputPipeline is the central dispatch layer for all user-submitted input in the Claude Code CLI. Located within `Infrastructure > CoreUtilities > DomainHelpers`, it sits between the terminal UI's input layer and the query engine, determining what kind of input the user submitted and routing it to the appropriate handler. Every keystroke that constitutes a "submit" — whether it's a text prompt, a `/slash-command`, or a `!bash` command — flows through this pipeline before reaching the AI conversation loop or producing local side effects.

The pipeline's responsibilities are:

- **Input classification and routing**: Distinguishing between plain text prompts, slash commands, and bash-mode commands, then dispatching to the correct handler
- **Image and attachment processing**: Resizing pasted images (base64) to fit API limits, storing images to disk, extracting IDE selections and `@`-mention attachments
- **Slash command execution**: Resolving command names against the command registry, handling three command types (`local-jsx`, `local`, `prompt`), registering skill hooks, and supporting forked sub-agent execution
- **Bash command execution**: Routing shell commands through BashTool or PowerShellTool with progress UI and structured stdout/stderr capture
- **Ultraplan keyword detection**: Intercepting a special keyword in user prompts to activate plan-mode via the `/ultraplan` command
- **Hook execution**: Running `UserPromptSubmit` hooks after input processing, handling blocking errors, stop signals, and additional context injection
- **Bridge safety**: Filtering which slash commands are safe to execute from remote/bridge clients (mobile, web)

## Key Processes

### Main Dispatch Flow (`processUserInput`)

The top-level entry point, `processUserInput()`, orchestrates the full pipeline:

1. **Show input immediately**: For interactive prompts, calls `setUserInputOnProcessing()` to display the user's text in the UI while processing continues in the background (`processUserInput.ts:145-147`)
2. **Delegate to `processUserInputBase()`**: The core routing logic (described below)
3. **Execute hooks**: If `shouldQuery` is true (i.e., the result will be sent to the AI), iterates through `UserPromptSubmit` hooks. Hooks can:
   - **Block** the prompt entirely with a `blockingError`, replacing it with a system warning (`processUserInput.ts:194-209`)
   - **Prevent continuation** while keeping the prompt in context (`processUserInput.ts:213-224`)
   - **Inject additional context** as attachment messages (`processUserInput.ts:227-240`)
   - **Append hook output** as success messages (`processUserInput.ts:243-262`)
4. **Return result**: A `ProcessUserInputBaseResult` containing messages, a `shouldQuery` flag, and optional overrides for `allowedTools`, `model`, and `effort`

### Input Classification (`processUserInputBase`)

This internal function handles the actual routing decision:

1. **Normalize input**: If input is an array of content blocks (from SDK/VS Code), process image blocks through `maybeResizeAndDownsampleImageBlock()`, extract the text portion from the last block, and track preceding content blocks (`processUserInput.ts:314-345`)
2. **Process pasted images**: Resize all pasted images in parallel via `Promise.all()`, store them to disk, and collect image metadata texts (`processUserInput.ts:366-420`)
3. **Bridge-safe command check**: For bridge-origin messages, resolve the command and check `isBridgeSafeCommand()`. Unsafe commands return a short-circuit message; safe commands clear the `skipSlashCommands` flag (`processUserInput.ts:428-453`)
4. **Ultraplan keyword detection**: If the `ULTRAPLAN` feature flag is on, the input is interactive, doesn't start with `/`, and contains the ultraplan keyword (checked against the *pre-expansion* input to prevent pasted content triggers), rewrite the input and route through `/ultraplan` (`processUserInput.ts:467-493`)
5. **Extract attachments**: For non-slash-command inputs, call `getAttachmentMessages()` to resolve `@`-mentions, IDE selections, and other attachments (`processUserInput.ts:496-514`)
6. **Route by mode**:
   - `mode === 'bash'` → `processBashCommand()` (`processUserInput.ts:517-529`)
   - Starts with `/` and slash commands not skipped → `processSlashCommand()` (`processUserInput.ts:533-551`)
   - Otherwise → `processTextPrompt()` for regular AI prompt (`processUserInput.ts:577-588`)

### Text Prompt Processing (`processTextPrompt`)

The simplest path — prepares a regular user message for the query engine:

1. Generates a `promptId` (UUID) and sets it globally via `setPromptId()` (`processTextPrompt.ts:31-32`)
2. Starts an interaction span for telemetry (`processTextPrompt.ts:38`)
3. Emits `user_prompt` OTEL events for observability (`processTextPrompt.ts:51-57`)
4. Classifies the prompt as negative or "keep going" via keyword matching for analytics (`processTextPrompt.ts:59-64`)
5. Constructs the `UserMessage` — if pasted images exist, combines text + image content blocks; otherwise uses plain input (`processTextPrompt.ts:67-99`)
6. Returns `{ messages: [userMessage, ...attachmentMessages], shouldQuery: true }`

### Slash Command Processing (`processSlashCommand`)

The most complex path, handling the full command lifecycle:

1. **Parse**: Uses `parseSlashCommand()` to extract `commandName`, `args`, and `isMcp` flag (`processSlashCommand.tsx:310`)
2. **Validate**: If the command doesn't exist in the registry:
   - If it looks like a command name (not a file path), returns "Unknown skill" (`processSlashCommand.tsx:343-361`)
   - Otherwise treats it as a regular text prompt sent to the AI (`processSlashCommand.tsx:371-381`)
3. **Dispatch by command type** (via `getMessagesForSlashCommand`):
   - **`local-jsx`**: Commands that render React UI in the terminal (e.g., `/config`, `/permissions`). Returns a Promise that resolves when `onDone` is called from the command's JSX component. Supports `display: 'skip'`, `display: 'system'`, and default modes (`processSlashCommand.tsx:551-656`)
   - **`local`**: Simple synchronous commands returning text or compact results. Handles the special `compact` result type for conversation compaction (`processSlashCommand.tsx:657-722`)
   - **`prompt`**: AI-facing skill commands that produce messages for the query engine. Two sub-paths:
     - **Forked**: If `command.context === 'fork'`, executes in a sub-agent via `executeForkedSlashCommand()` with progress UI. In assistant/kairos mode, runs fire-and-forget in the background (`processSlashCommand.tsx:62-295`)
     - **Inline**: Calls `getMessagesForPromptSlashCommand()` which loads the skill content, registers skill hooks, records the invocation, resolves attachments from the skill content, and constructs messages with metadata (`processSlashCommand.tsx:827-920`)
4. **Analytics**: Logs `tengu_input_command` events with plugin metadata for all valid commands

### Bash Command Execution (`processBashCommand`)

Handles `!`-prefixed shell commands entered in bash mode:

1. **Shell selection**: Checks `isPowerShellToolEnabled()` and `resolveDefaultShell()` to decide between BashTool and PowerShellTool. PowerShellTool is lazy-loaded (~300KB) only when needed (`processBashCommand.tsx:26-81`)
2. **Progress UI**: Sets up `BashModeProgress` React component with an `onProgress` callback that updates the display as `ShellProgress` events arrive (`processBashCommand.tsx:41-66`)
3. **Execution**: Calls the shell tool's `.call()` with `dangerouslyDisableSandbox: true` (user-initiated commands run outside sandbox) (`processBashCommand.tsx:82-88`)
4. **Output formatting**: Passes the result through `processToolResultBlock()` to handle large output persistence, then wraps in `<bash-stdout>` and `<bash-stderr>` XML tags (`processBashCommand.tsx:98-112`)
5. **Error handling**: Three error paths:
   - `ShellError` with `interrupted`: Returns an interruption message (`processBashCommand.tsx:115-122`)
   - `ShellError` (non-interrupted): Returns escaped stdout/stderr (`processBashCommand.tsx:123-129`)
   - Generic error: Returns escaped error message in `<bash-stderr>` (`processBashCommand.tsx:130-135`)
6. **Cleanup**: Always clears the tool JSX in `finally` block

## Function Signatures

### `processUserInput(options): Promise<ProcessUserInputBaseResult>`

The main entry point. Accepts a destructured options object:

| Parameter | Type | Description |
|-----------|------|-------------|
| `input` | `string \| Array<ContentBlockParam>` | User text or multimodal content blocks |
| `preExpansionInput` | `string?` | Input before `[Pasted text #N]` expansion, used for ultraplan keyword detection |
| `mode` | `PromptInputMode` | `'prompt'`, `'bash'`, etc. |
| `setToolJSX` | `SetToolJSXFn` | Callback to render React components in the tool area |
| `context` | `ProcessUserInputContext` | Full tool use context + local JSX command context |
| `pastedContents` | `Record<number, PastedContent>?` | Pasted images keyed by ID |
| `ideSelection` | `IDESelection?` | Current IDE selection for VS Code integration |
| `messages` | `Message[]?` | Existing conversation messages |
| `skipSlashCommands` | `boolean?` | Treat `/` input as plain text (for remote/bridge messages) |
| `bridgeOrigin` | `boolean?` | Allow bridge-safe commands even when `skipSlashCommands` is set |
| `isMeta` | `boolean?` | Mark the resulting message as model-visible but user-hidden |

> Source: `processUserInput.ts:85-170`

### `processSlashCommand(inputString, ...): Promise<ProcessUserInputBaseResult>`

Parses and dispatches a slash command string.

> Source: `processSlashCommand.tsx:309-524`

### `processBashCommand(inputString, precedingInputBlocks, attachmentMessages, context, setToolJSX): Promise<...>`

Executes a shell command and returns structured stdout/stderr messages.

> Source: `processBashCommand.tsx:17-139`

### `processTextPrompt(input, imageContentBlocks, imagePasteIds, attachmentMessages, uuid?, permissionMode?, isMeta?): { messages, shouldQuery }`

Constructs a user message for the query engine. Synchronous (no async).

> Source: `processTextPrompt.ts:19-100`

## Type Definitions

### `ProcessUserInputBaseResult`

The standard return type from all pipeline paths:

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `(UserMessage \| AssistantMessage \| AttachmentMessage \| SystemMessage \| ProgressMessage)[]` | Messages to add to the conversation |
| `shouldQuery` | `boolean` | Whether to send messages to the AI query engine |
| `allowedTools` | `string[]?` | Optional tool whitelist override (from skill definitions) |
| `model` | `string?` | Optional model override |
| `effort` | `EffortValue?` | Optional effort/reasoning level override |
| `resultText` | `string?` | Output text for non-interactive mode (`-p` flag) |
| `nextInput` | `string?` | Prefill or auto-submit text for the next input |
| `submitNextInput` | `boolean?` | Whether to auto-submit `nextInput` |

> Source: `processUserInput.ts:64-83`

### `ProcessUserInputContext`

Intersection of `ToolUseContext` and `LocalJSXCommandContext`, providing the full execution environment for all handlers.

> Source: `processUserInput.ts:62`

## Configuration & Defaults

- **`MAX_HOOK_OUTPUT_LENGTH`**: Hook output is truncated at 10,000 characters to prevent oversized context (`processUserInput.ts:272`)
- **`MCP_SETTLE_POLL_MS` / `MCP_SETTLE_TIMEOUT_MS`**: Background forked commands poll every 200ms for up to 10s waiting for MCP servers to connect (`processSlashCommand.tsx:56-57`)
- **Feature flag `ULTRAPLAN`**: Gates the ultraplan keyword detection path
- **Feature flag `KAIROS`**: Gates the fire-and-forget background execution path for forked commands in assistant mode
- **Feature flag `COORDINATOR_MODE`**: In coordinator mode, prompt commands return a delegation summary instead of loading full skill content

## Edge Cases & Caveats

- **Pasted content cannot trigger ultraplan**: The keyword check runs against `preExpansionInput` (before `[Pasted text #N]` placeholders are expanded), so text within pasted content cannot accidentally activate plan mode (`processUserInput.ts:456-476`)
- **Bridge-origin command filtering**: Remote clients (mobile/web) set `skipSlashCommands: true` but can still execute bridge-safe commands. Unsafe commands return a user-facing error message rather than silently failing (`processUserInput.ts:428-453`)
- **Non-interactive sessions skip `local-jsx` commands**: When `isNonInteractiveSession` is true, JSX-rendering commands return empty messages since there's no terminal to render to (`processSlashCommand.tsx:614-621`)
- **Bash commands run outside sandbox**: User-initiated `!` commands set `dangerouslyDisableSandbox: true` since they're explicitly user-invoked. This differs from model-initiated bash calls which respect sandbox rules (`processBashCommand.tsx:82-88`)
- **PowerShell lazy loading**: The PowerShellTool (~300KB) is only `require()`'d when the user has actually selected PowerShell as their default shell, keeping startup fast for the majority of users (`processBashCommand.tsx:76-80`)
- **`shouldQuery: false` for bash commands**: Bash execution results are recorded in context but do not trigger an AI query turn — the user sees the raw output directly
- **File path vs. command name ambiguity**: When a `/`-prefixed input doesn't match a known command, the pipeline checks if it's a valid filesystem path (e.g., `/var/log/...`) and, if so, treats it as a regular prompt rather than showing "Unknown skill" (`processSlashCommand.tsx:336-381`)
- **Hook `preventContinuation`**: A hook can stop the query without blocking the prompt — the prompt stays in conversation context but no AI turn is triggered (`processUserInput.ts:213-224`)