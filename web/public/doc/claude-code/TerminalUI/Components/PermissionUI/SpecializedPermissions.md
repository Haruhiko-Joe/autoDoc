# Specialized Permission Requests

## Overview & Responsibilities

This module contains tool-specific permission request components for non-file, non-shell tools within the Claude Code terminal UI. These components live under `src/components/permissions/` and sit within the **PermissionUI** layer of the **Components** group in the **TerminalUI** architecture.

Each component is responsible for presenting a focused approval dialog when Claude attempts to use a specific tool, letting the user approve, reject, or configure persistent "always allow" rules. The six components are:

| Component | Tool | Complexity |
|-----------|------|-----------|
| `AskUserQuestionPermissionRequest` | AskUserQuestion (multi-choice questions) | High (~300 lines + 6 subcomponents) |
| `ExitPlanModePermissionRequest` | ExitPlanMode (plan approval) | High (plan review, auto-mode, session naming) |
| `SkillPermissionRequest` | Skill (MCP skill invocation) | Medium |
| `WebFetchPermissionRequest` | WebFetch (URL fetching) | Medium |
| `ComputerUseApproval` | Computer Use (macOS desktop control) | Medium |
| `EnterPlanModePermissionRequest` | EnterPlanMode (start planning) | Simple |

Sibling permission components handle file edits, bash commands, filesystem operations, and other tool types.

## Key Processes

### Common Permission Flow Pattern

All components follow a shared pattern:

1. Receive `PermissionRequestProps` (`toolUseConfirm`, `onDone`, `onReject`, `workerBadge`)
2. Parse tool input from `toolUseConfirm.input` using the tool's `inputSchema`
3. Render a `PermissionDialog` (or `Dialog`) wrapper with tool-specific content
4. Present options via a `Select` component
5. On approval: call `toolUseConfirm.onAllow(input, permissionUpdates)`
6. On rejection: call `toolUseConfirm.onReject()`, then `onReject()` and `onDone()`
7. Optionally emit analytics events via `logEvent()` or `logUnaryEvent()`

### AskUserQuestionPermissionRequest Flow

This is the most complex component, handling multi-question interactive surveys that Claude presents to the user.

1. **Input parsing**: Parses `toolUseConfirm.input` through `AskUserQuestionTool.inputSchema` to extract a `questions` array (`src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx:84-101`)
2. **State management**: Initializes `useMultipleChoiceState()` hook which provides a `useReducer`-based state machine tracking `currentQuestionIndex`, `answers`, `questionStates`, and `isInTextInput` (`src/components/permissions/AskUserQuestionPermissionRequest/use-multiple-choice-state.ts:34-96`)
3. **Layout calculation**: Computes `globalContentHeight` and `globalContentWidth` based on terminal size, preview content rendering, and option counts (`src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx:106-162`)
4. **Question rendering**: Delegates to either `QuestionView` (standard select list) or `PreviewQuestionView` (side-by-side with preview panel) based on whether options have `preview` content
5. **Navigation**: `QuestionNavigationBar` renders tab-style navigation across questions, with adaptive truncation based on terminal width (`src/components/permissions/AskUserQuestionPermissionRequest/QuestionNavigationBar.tsx:15-99`)
6. **Image support**: Handles pasted images via `onImagePaste`, storing them with `cacheImagePath`/`storeImage` and attaching as `ImageBlockParam` content blocks on submission (`src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx:174-228`)
7. **Submission**: For single-select single-question forms, auto-submits on selection. For multi-question or multi-select forms, navigates to `SubmitQuestionsView` which shows a review of all answers (`src/components/permissions/AskUserQuestionPermissionRequest/SubmitQuestionsView.tsx:21-31`)
8. **Alternative actions**: Users can "Respond to Claude" (reject with clarification feedback) or "Finish plan interview" (signal Claude to stop asking questions) — both pass structured feedback via `toolUseConfirm.onReject(feedback, imageBlocks)` (`src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx:293-368`)

### ExitPlanModePermissionRequest Flow

This is the plan approval dialog — the most feature-rich permission component.

1. **Plan display**: Renders the plan content using `Markdown` component with full syntax highlighting
2. **Mode selection**: Builds options dynamically based on available permission modes (default, auto-mode, bypass-permissions) (`src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:146-150`)
3. **Permission updates**: `buildPermissionUpdates()` constructs permission rules including classifier-based prompt rules for Ant-internal use (`src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:56-76`)
4. **Session auto-naming**: `autoNameSessionFromPlan()` generates a kebab-case session name from plan content using Haiku, updating the session title for transcript display (`src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:83-117`)
5. **Plan feedback**: Users can annotate the plan with feedback text and pasted images, which get threaded through `onAllow` as `acceptFeedback`
6. **Ultraplan**: Conditionally shows an "Ultraplan" option for launching multi-agent plan execution when the feature flag is enabled
7. **Clear context**: Optionally offers "Accept and clear context" to start fresh execution after planning

### WebFetchPermissionRequest Flow

1. Parses the URL from input and extracts the hostname (`src/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx:12-28`)
2. Renders the URL and description using `WebFetchTool.renderToolUseMessage()` (`src/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx:164-178`)
3. Offers "Yes", "Yes, and don't ask again for {hostname}", and "No" options
4. The "always allow" option creates a domain-based permission rule: `domain:{hostname}` stored in `localSettings` (`src/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx:129-144`)

### SkillPermissionRequest Flow

1. Parses the skill name from `toolUseConfirm.input` (`src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx:26-35`)
2. Extracts command metadata from `permissionResult` if available (`src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx:36`)
3. Builds options: "Yes", "Yes, and don't ask again for {skill}", optionally "Yes, and don't ask again for {prefix}:*" (for commands with subcommands), and "No" (`src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx:66-163`)
4. Uses `PermissionPrompt` wrapper (not `PermissionDialog` directly) which adds feedback collection support (`src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx:14`)
5. Permission rules use `SKILL_TOOL_NAME` as `toolName` and exact skill name or prefix glob as `ruleContent` (`src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx:216-246`)

### ComputerUseApproval Flow

1. **Two-panel dispatcher**: Routes between `ComputerUseTccPanel` (macOS permission setup) and `ComputerUseAppListPanel` (app allowlist) based on `request.tccState` (`src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx:30-46`)
2. **TCC panel**: When macOS Accessibility or Screen Recording permissions are missing, shows their grant status and options to open System Settings directly via `open x-apple.systempreferences:` URLs (`src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx:106-128`)
3. **App allowlist panel**: Presents checkboxes for individual apps Claude wants to control, with sentinel category warnings (shell, filesystem, system_settings) for dangerous apps (`src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx:200-207`)
4. Uses `Dialog` instead of `PermissionDialog` since it operates outside the standard tool permission flow

### EnterPlanModePermissionRequest Flow

The simplest component. Wraps a `PermissionDialog` with "planMode" color theme, showing a description of what plan mode does and offering "Yes, enter plan mode" / "No, start implementing now" via `Select` (`src/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx:11-118`). On approval:
- Logs `tengu_plan_enter` analytics event
- Calls `handlePlanModeTransition()` to update app state
- Emits a `setMode` permission update to transition to `"plan"` mode

## Function Signatures

### `useMultipleChoiceState(): MultipleChoiceState`

Custom hook managing multi-question form state via `useReducer`. Returns:

- `currentQuestionIndex: number` — active question tab
- `answers: Record<string, AnswerValue>` — finalized answers keyed by question text
- `questionStates: Record<string, QuestionState>` — per-question UI state (selected value, text input value)
- `isInTextInput: boolean` — whether the text input "Other" field is focused
- `nextQuestion()` / `prevQuestion()` — navigation
- `updateQuestionState(questionText, updates, isMultiSelect)` — partial state update
- `setAnswer(questionText, answer, shouldAdvance?)` — record answer, optionally advance to next question
- `setTextInputMode(isInInput)` — toggle text input focus tracking

> Source: `src/components/permissions/AskUserQuestionPermissionRequest/use-multiple-choice-state.ts:125-179`

### `buildPermissionUpdates(mode: PermissionMode, allowedPrompts?: AllowedPrompt[]): PermissionUpdate[]`

Constructs the permission update array for plan approval. Creates a `setMode` update and optionally adds classifier-based prompt rules (Ant-internal feature).

> Source: `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:56-76`

### `autoNameSessionFromPlan(plan: string, setAppState, isClearContext: boolean): void`

Fire-and-forget function that generates a session name from plan content using `generateSessionName()` (Haiku model), then saves it as the session title. Skips if session persistence is disabled or a custom title already exists.

> Source: `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:83-117`

### `inputToPermissionRuleContent(input): string`

Parses WebFetch tool input to extract the URL hostname, returning `domain:{hostname}` for use as a permission rule. Falls back to `input:{toString}` on parse failure.

> Source: `src/components/permissions/WebFetchPermissionRequest/WebFetchPermissionRequest.tsx:12-28`

## Interface / Type Definitions

### `PermissionRequestProps` (shared)

All permission components receive this interface:

| Field | Type | Description |
|-------|------|-------------|
| `toolUseConfirm` | `ToolUseConfirm` | Contains `input`, `onAllow()`, `onReject()`, tool metadata, and `permissionResult` |
| `onDone` | `() => void` | Callback to dismiss the permission dialog |
| `onReject` | `() => void` | Callback for rejection side-effects |
| `workerBadge` | `ReactNode` | Optional badge for agent/worker context display |
| `verbose` | `boolean` | Whether to show detailed tool information |
| `setStickyFooter` | `(node) => void` | Set persistent footer content (used by ExitPlanMode) |

### `QuestionState`

```typescript
type QuestionState = {
  selectedValue?: string | string[]  // Current selection(s)
  textInputValue: string             // Free-text "Other" input
}
```

> Source: `src/components/permissions/AskUserQuestionPermissionRequest/use-multiple-choice-state.ts:5-8`

### `MultipleChoiceState`

Extends the reducer state with action dispatchers. See `useMultipleChoiceState()` above.

> Source: `src/components/permissions/AskUserQuestionPermissionRequest/use-multiple-choice-state.ts:105-123`

### `ComputerUseApprovalProps`

```typescript
type ComputerUseApprovalProps = {
  request: CuPermissionRequest  // From @ant/computer-use-mcp
  onDone: (response: CuPermissionResponse) => void
}
```

> Source: `src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx:14-17`

### `ResponseValue` (ExitPlanMode)

```typescript
type ResponseValue =
  | 'yes-bypass-permissions'
  | 'yes-accept-edits'
  | 'yes-accept-edits-keep-context'
  | 'yes-default-keep-context'
  | 'yes-resume-auto-mode'
  | 'yes-auto-clear-context'
  | 'ultraplan'
  | 'no'
```

> Source: `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:50`

## Subcomponent Architecture (AskUserQuestion)

The `AskUserQuestionPermissionRequest` directory contains 7 files forming a mini feature module:

```
src/components/permissions/AskUserQuestionPermissionRequest/
├── AskUserQuestionPermissionRequest.tsx  — Entry point, orchestrates questions
├── QuestionView.tsx                      — Standard question with Select/SelectMulti
├── PreviewQuestionView.tsx               — Side-by-side question with preview panel
├── PreviewBox.tsx                        — Bordered box for rendering Markdown previews
├── QuestionNavigationBar.tsx             — Tab bar for multi-question navigation
├── SubmitQuestionsView.tsx               — Final review/submit screen
└── use-multiple-choice-state.ts          — useReducer-based state management hook
```

**Syntax highlighting**: Both `AskUserQuestionPermissionRequest` and `PreviewBox` use a lazy-loading pattern with `Suspense` and `React.use()` to load `getCliHighlightPromise()` for syntax highlighting. When highlighting is disabled in settings or still loading, they fall back to rendering without highlights.

**Preview rendering**: `PreviewBox` draws a Unicode box-drawing border (`┌─┐│└─┘`) around Markdown-rendered content with line truncation, padding, and a scissors indicator (`✂`) for hidden lines (`src/components/permissions/AskUserQuestionPermissionRequest/PreviewBox.tsx:23-32`).

## Edge Cases & Caveats

- **Single-question auto-submit**: When there is exactly one question with single-select (no `multiSelect`), selecting an option immediately submits the form without showing the submit view. This is controlled by `hideSubmitTab` and the auto-submit logic in `handleAnswer` (`src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx:264`).

- **"Other" option handling**: `QuestionView` appends a synthetic `__other__` option for free-text input. When selected, the text input captures focus and `isInTextInput` state prevents navigation key conflicts. Image paste is also routed through this option.

- **Plan mode awareness**: Several components check `useAppState(s => s.toolPermissionContext.mode)` to conditionally show plan-mode-specific options like "Finish plan interview" in question views or auto-mode transitions in `ExitPlanModePermissionRequest`.

- **Always-allow options visibility**: `SkillPermissionRequest` and `WebFetchPermissionRequest` conditionally show "don't ask again" options based on `shouldShowAlwaysAllowOptions()`, which respects the current permission configuration.

- **ComputerUseApproval TCC panel**: The TCC panel opens macOS System Settings via deep links (`x-apple.systempreferences:`) but does not auto-detect when permissions are granted — the user must manually select "Try again" after granting.

- **React Compiler optimization**: All files use the React compiler runtime (`_c()` memoization cache), so the code reads as compiled output with manual cache-slot management rather than idiomatic React. The original source is available via inline source maps.

- **ExitPlanMode session naming**: `autoNameSessionFromPlan` is fire-and-forget — failures are silently caught. On "clear context" acceptance, it names the *new* session (after `regenerateSessionId()`), not the abandoned planning session.

- **Prefix-based skill rules**: `SkillPermissionRequest` supports wildcard permission rules like `commit:*` by extracting the command prefix before the first space, enabling broad allow rules for skill families.