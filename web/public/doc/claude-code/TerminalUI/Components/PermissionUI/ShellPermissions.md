# Shell Permissions

## Overview & Responsibilities

The Shell Permissions module provides the interactive permission-request UI for shell command execution tools (Bash and PowerShell). When Claude wants to run a shell command, these components render a dialog that displays the command, warns about destructive operations, offers auto-approval via classifier checks, and lets the user accept, reject, or provide feedback.

Within the TerminalUI > Components > PermissionUI hierarchy, this module is a specialized subset of the permission system. It sits alongside sibling permission handlers for file edits, web fetch, notebooks, and other tools. The PermissionPrompt orchestrator routes shell tool confirmations here based on tool name.

### File Map

| File | Purpose |
|------|---------|
| `BashPermissionRequest/BashPermissionRequest.tsx` | Main Bash permission dialog (~481 lines), with sed-edit detection, classifier auto-approval shimmer, sandbox awareness |
| `BashPermissionRequest/bashToolUseOptions.tsx` | Generates the option list for Bash dialogs (Yes, Yes + prefix rule, Yes + classifier rule, No) |
| `PowerShellPermissionRequest/PowerShellPermissionRequest.tsx` | PowerShell permission dialog (~234 lines), mirrors Bash pattern minus classifier and sandbox features |
| `PowerShellPermissionRequest/powershellToolUseOptions.tsx` | Generates the option list for PowerShell dialogs |
| `shellPermissionHelpers.tsx` | Shared label generator for "always allow" suggestions (commands, directories, Read rules) |
| `useShellPermissionFeedback.ts` | Shared hook for feedback input state, Tab-key mode toggling, focus tracking, and analytics |

## Key Processes

### Bash Permission Request Flow

1. **Input parsing & sed detection**: `BashPermissionRequest` parses the tool input via `BashTool.inputSchema.parse()`, then checks if the command is a `sed` edit via `parseSedEditCommand()`. If it is, the component delegates entirely to `SedEditPermissionRequest` — a specialized diff-based dialog (`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:100-116`).

2. **Classifier auto-approval check**: When the `BASH_CLASSIFIER` feature is enabled, the component checks `toolUseConfirm.classifierCheckInProgress`. While the classifier runs, a `ClassifierCheckingSubtitle` renders an animated shimmer ("Attempting to auto-approve...") using `useShimmerAnimation` at 20fps. This subtitle is extracted into its own component to isolate the shimmer clock from re-rendering the entire dialog (`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:42-70`). If the classifier approves, a green checkmark and matched rule are shown; all options become disabled.

3. **Editable prefix computation**: The component computes an editable command prefix for the "don't ask again" option. For simple commands, `getSimpleCommandPrefix()` or `getFirstWordPrefix()` extracts a prefix synchronously (e.g., `npm run:*`). For compound commands (e.g., `cd src && npm test`), it checks `decisionReason.type === 'subcommandResults'` — if the backend already computed per-subcommand suggestions, those are used instead of the heuristic. An async refinement via `getCompoundCommandPrefixesStatic()` with tree-sitter can refine the prefix unless the user has already edited it (`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:209-254`).

4. **Destructive command warning**: When the `tengu_destructive_command_warning` feature flag is enabled, `getDestructiveCommandWarning(command)` checks for dangerous commands. The warning text renders in the `warning` color above the option selector (`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:458-462`).

5. **Option selection handling**: The `onSelect` callback processes the user's choice:
   - `yes`: Allows the command, optionally passing feedback text
   - `yes-prefix-edited`: Saves an `addRules` permission update to `localSettings` with the user-edited prefix
   - `yes-classifier-reviewed`: (Ant-only) Saves a prompt-based rule to the `session` scope using `createPromptRuleContent()`
   - `yes-apply-suggestions`: Applies all backend-computed permission suggestions atomically
   - `no`: Rejects with optional feedback text

6. **Dialog rendering**: Wraps everything in `PermissionDialog` with title "Bash command" (or "Bash command (unsandboxed)" when sandbox is enabled but the command is excluded). Shows the command text, an optional explainer (toggled via Ctrl+E), permission rule explanation, destructive warning, and the `Select` menu.

### PowerShell Permission Request Flow

`PowerShellPermissionRequest` follows the same pattern as Bash with these differences:
- No sed-edit detection (no delegation to `SedEditPermissionRequest`)
- No classifier auto-approval (no shimmer animation, no `yes-classifier-reviewed` option)
- No sandbox support (Windows limitation)
- Uses `PowerShellTool` for input parsing and `isAllowlistedCommand()` from `src/tools/PowerShellTool/readOnlyValidation.ts` for read-only filtering
- Multiline commands (`command.includes('\n')`) get `undefined` prefix, hiding the "don't ask again" option — multiline PowerShell rules rarely match twice
- Prefix extraction uses `getCompoundCommandPrefixesStatic` from `src/utils/powershell/staticPrefix.ts` (`src/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx:11`)

### Feedback Input Mode (useShellPermissionFeedback)

Both shell dialogs share the `useShellPermissionFeedback` hook for managing user feedback:

1. **Tab-key toggling**: When the user presses Tab on "Yes" or "No", the option transforms into a text input. The user can type instructions (e.g., "and tell Claude what to do next") that are sent along with the accept/reject action (`src/components/permissions/useShellPermissionFeedback.ts:51-80`).

2. **Focus tracking**: `handleFocus` collapses empty input fields when the user navigates away (e.g., arrow keys from "Yes" to "No") but preserves typed text. It also triggers `onUserInteraction()` to notify the system that the user is engaging with the dialog (`src/components/permissions/useShellPermissionFeedback.ts:118-132`).

3. **Rejection handling**: `handleReject` logs analytics events including whether the explainer was visible, increments the `escapeCount` for attribution tracking (when no feedback is provided, i.e., user pressed Esc), and calls `toolUseConfirm.onReject()` with optional feedback (`src/components/permissions/useShellPermissionFeedback.ts:82-116`).

### Permission Suggestion Label Generation (shellPermissionHelpers)

`generateShellSuggestionsLabel()` produces the descriptive label for the "always allow" option. It processes `PermissionUpdate[]` suggestions and generates context-appropriate labels:

- **Read rules only**: "Yes, allow reading from **dirname**/ from this project"
- **Directories only**: "Yes, and always allow access to **dirname**/ from this project"
- **Commands only**: "Yes, and don't ask again for **cmd** commands in **cwd**"
- **Mixed**: Combines path access and command descriptions
- **Truncation**: When command list text exceeds 50 characters, collapses to "similar" (`src/components/permissions/shellPermissionHelpers.tsx:24-31`)

The function accepts an optional `commandTransform` parameter — Bash uses `stripBashRedirections` to remove output redirection syntax so filenames don't appear as commands in the label.

## Function Signatures

### `BashPermissionRequest(props: PermissionRequestProps): React.ReactNode`

Top-level Bash permission component. Parses input, detects sed edits, delegates to either `SedEditPermissionRequest` or `BashPermissionRequestInner`.

> Source: `src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:71-133`

### `PowerShellPermissionRequest(props: PermissionRequestProps): React.ReactNode`

PowerShell permission dialog. Single component (no inner/outer split).

> Source: `src/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx:22-233`

### `bashToolUseOptions({...}): OptionWithDescription<BashToolUseOption>[]`

Builds the selectable option array for the Bash dialog. Options include `yes`, `yes-prefix-edited`, `yes-apply-suggestions`, `yes-classifier-reviewed` (Ant-only), and `no`.

**Key parameters:**
- `suggestions` — backend-computed `PermissionUpdate[]` for "always allow" rules
- `editablePrefix` / `onEditablePrefixChange` — user-editable command prefix (e.g., `npm run:*`)
- `classifierDescription` / `onClassifierDescriptionChange` — LLM-generated description for classifier-based rules
- `existingAllowDescriptions` — already-allowed descriptions to avoid duplicates
- `yesInputMode` / `noInputMode` — whether to render text inputs instead of simple labels

> Source: `src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx:31-145`

### `powershellToolUseOptions({...}): OptionWithDescription<PowerShellToolUseOption>[]`

Builds the selectable option array for PowerShell. Same structure as Bash but without the classifier-reviewed option.

> Source: `src/components/permissions/PowerShellPermissionRequest/powershellToolUseOptions.tsx:7-90`

### `generateShellSuggestionsLabel(suggestions, shellToolName, commandTransform?): ReactNode | null`

Generates a formatted React label describing what permissions will be granted by the "always allow" option.

> Source: `src/components/permissions/shellPermissionHelpers.tsx:65-162`

### `useShellPermissionFeedback({toolUseConfirm, onDone, onReject, explainerVisible})`

React hook returning feedback state and handlers. Used by both Bash and PowerShell permission dialogs.

**Returns:** `{ yesInputMode, noInputMode, yesFeedbackModeEntered, noFeedbackModeEntered, acceptFeedback, rejectFeedback, setAcceptFeedback, setRejectFeedback, focusedOption, handleInputModeToggle, handleReject, handleFocus }`

> Source: `src/components/permissions/useShellPermissionFeedback.ts:16-148`

## Type Definitions

### `BashToolUseOption`

```typescript
type BashToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-prefix-edited' | 'yes-classifier-reviewed' | 'no'
```

### `PowerShellToolUseOption`

```typescript
type PowerShellToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-prefix-edited' | 'no'
```

Note the absence of `'yes-classifier-reviewed'` — classifier-based approval is a Bash-only, Anthropic-internal feature.

## Edge Cases & Caveats

- **Compound command prefix pitfall**: For compound commands like `cd src && git status && npm test`, the sync prefix heuristics (`getSimpleCommandPrefix`/`getFirstWordPrefix`) operate on the full string and produce dead rules like `Bash(cd src:*)`. The code detects `decisionReason.type === 'subcommandResults'` to use backend-computed per-subcommand suggestions instead (`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:195-208`).

- **Tree-sitter gating**: `getCompoundCommandPrefixesStatic` (from `src/utils/bash/prefix.ts` for Bash, `src/utils/powershell/staticPrefix.ts` for PowerShell) relies on tree-sitter parsing which is gated to Anthropic-internal builds (`TREE_SITTER_BASH`). In external builds, the async refinement resolves to `[]` and the synchronous initial value is what the user sees.

- **Shimmer isolation**: The `ClassifierCheckingSubtitle` component is deliberately extracted from `BashPermissionRequestInner` to prevent the 20fps shimmer animation from triggering full re-renders of the dialog tree. The React Compiler cannot auto-memoize the inner component (it has a bailout), so without extraction, every 50ms tick would reconstruct the entire JSX tree (`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:36-41`).

- **Multiline PowerShell**: Commands containing newlines get `undefined` as their editable prefix, which hides the "don't ask again" option entirely. Analysis of the settings corpus showed 14 multiline rules with zero matching twice, so one-time approval is appropriate.

- **Classifier description deduplication**: `bashToolUseOptions` checks `descriptionAlreadyExists()` against the current allow list to avoid offering a "don't ask again" option with a description the user has already approved (`src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx:15-18`).

- **Sandbox awareness**: Bash permission dialog title changes to "Bash command (unsandboxed)" when `SandboxManager.isSandboxingEnabled()` returns true but `shouldUseSandbox()` returns false for the specific command, alerting the user that this command will run outside the sandbox.

- **Empty submit behavior**: All text input options use `allowEmptySubmitToCancel: true`, meaning pressing Enter with empty input collapses the input back to a regular option rather than submitting empty feedback.

- **Escape tracking**: When the user presses Esc without providing feedback, `handleReject` increments `attribution.escapeCount` in global app state for tracking user behavior patterns (`src/components/permissions/useShellPermissionFeedback.ts:87-98`).