# Permission Framework

## Overview & Responsibilities

The Permission Framework is the UI orchestration layer for Claude Code's tool permission system, living within **TerminalUI > Components > PermissionUI**. When Claude wants to use a tool (run a bash command, edit a file, fetch a URL, etc.), the permission engine evaluates whether approval is needed. If it is, the Permission Framework renders the interactive confirmation dialog that lets the user approve, reject, or customize the permission grant.

The framework sits between the backend permission evaluation system (`src/utils/permissions/`) and the user-facing terminal. Its job is to:

1. **Dispatch** the right UI for each tool type (`PermissionRequest`)
2. **Render** the interactive prompt with selectable options and optional feedback (`PermissionPrompt`)
3. **Wrap** everything in a styled dialog container (`PermissionDialog`)
4. **Display** contextual information: risk explanations, rule match reasons, debug info, and worker attribution badges

Sibling modules in the Components layer include `DesignSystem` (primitives like Dialog, ThemedText), `DiffAndCodeRendering` (used by file-edit permission views to show diffs), and `StatusAndProgress` (spinners shown during pending states).

## Key Processes

### Tool-to-Component Dispatch Flow

The central routing mechanism is the `permissionComponentForTool()` function in `src/components/permissions/PermissionRequest.tsx:47-82`. It takes a `Tool` reference and returns the appropriate React permission component:

1. `PermissionRequest` receives a `ToolUseConfirm` object containing the tool, input, permission result, and callbacks
2. It calls `permissionComponentForTool(toolUseConfirm.tool)` which performs a switch/case match against known tools:
   - `FileEditTool` → `FileEditPermissionRequest`
   - `BashTool` → `BashPermissionRequest`
   - `PowerShellTool` → `PowerShellPermissionRequest` (which imports shell prefix helpers from `src/utils/powershell/staticPrefix.ts`)
   - `WebFetchTool` → `WebFetchPermissionRequest`
   - `GlobTool` / `GrepTool` / `FileReadTool` → `FilesystemPermissionRequest`
   - Feature-flagged tools (`ReviewArtifactTool`, `WorkflowTool`, `MonitorTool`) are conditionally loaded via `require()` behind `feature()` flags
   - Any unrecognized tool falls through to `FallbackPermissionRequest`
3. The resolved component is rendered with the standard `PermissionRequestProps`
4. An `app:interrupt` keybinding is registered to allow the user to dismiss the prompt via Ctrl+C (`src/components/permissions/PermissionRequest.tsx:180`)
5. A system notification is triggered after a timeout if the user hasn't responded (`useNotifyAfterTimeout`)

### User Interaction Flow (PermissionPrompt)

`PermissionPrompt` (`src/components/permissions/PermissionPrompt.tsx`) is the shared input handler used by all permission request components:

1. It receives a list of `PermissionPromptOption<T>` — each with a value, label, optional keybinding, and optional `feedbackConfig`
2. Options are transformed into `Select`-compatible format. If an option has `feedbackConfig`, pressing Tab toggles it into an input mode where the user can type instructions (e.g., "tell Claude what to do differently")
3. The `Select` component (from `CustomSelect`) handles keyboard navigation and selection
4. On selection, the component resolves any attached feedback text (accept feedback or reject feedback), logs analytics events, and calls the `onSelect` callback with the value and optional feedback string
5. Analytics events track feedback mode entry/exit (`tengu_accept_feedback_mode_entered`, `tengu_reject_feedback_mode_collapsed`, etc.)
6. `setAppState` is used to propagate the active confirmation state to the global app state, enabling things like showing "(press ↑ to scroll)" hints

### Permission Dialog Layout

`PermissionDialog` (`src/components/permissions/PermissionDialog.tsx:17-71`) provides the visual container:

- Renders a `Box` with `borderStyle="round"` and top border only (left, right, bottom borders disabled)
- Default border color uses the `"permission"` theme key
- Title bar uses `PermissionRequestTitle` which shows a bold colored title with an optional `WorkerBadge` (for swarm workers) and an optional subtitle (dimmed, truncated from start)
- Supports a `titleRight` slot for additional content alongside the title
- Content (`children`) is rendered with configurable horizontal padding (default 1)

### Analytics & Logging

The `usePermissionRequestLogging` hook (`src/components/permissions/hooks.ts:101-209`) fires on mount for each permission dialog:

1. Increments the global `permissionPromptCount` in app state (used for attribution tracking)
2. Logs a `tengu_tool_use_show_permission_request` analytics event with tool name, MCP flag, decision reason type, and sandbox status
3. For internal (Anthropic) users: logs additional detailed events for bash tool calls without "always allow" suggestions, including parsed command parts
4. Fires a unary event for the response completion type

The `logUnaryPermissionEvent` utility (`src/components/permissions/utils.ts`) provides a simple wrapper for logging accept/reject unary events with platform metadata.

## Function Signatures & Parameters

### `PermissionRequest`

```typescript
function PermissionRequest(props: {
  toolUseConfirm: ToolUseConfirm;
  toolUseContext: ToolUseContext;
  onDone(): void;
  onReject(): void;
  verbose: boolean;
  workerBadge: WorkerBadgeProps | undefined;
  setStickyFooter?: (jsx: React.ReactNode | null) => void;
}): React.ReactNode
```

Top-level dispatcher. Resolves the correct tool-specific component and renders it. Registers the `app:interrupt` keybinding for Ctrl+C dismissal.

> Source: `src/components/permissions/PermissionRequest.tsx:146`

### `ToolUseConfirm<Input>`

The data object passed to every permission request component (`src/components/permissions/PermissionRequest.tsx:103-127`):

| Field | Type | Description |
|-------|------|-------------|
| `assistantMessage` | `AssistantMessage` | The message that triggered the tool use |
| `tool` | `Tool<Input>` | The tool definition |
| `input` | `z.infer<Input>` | Parsed tool input |
| `permissionResult` | `PermissionDecision` | The engine's decision (ask/deny) with reason |
| `onAllow` | `(input, updates, feedback?, contentBlocks?) => void` | Called when user approves |
| `onReject` | `(feedback?, contentBlocks?) => void` | Called when user rejects |
| `onUserInteraction` | `() => void` | Prevents auto-approval from dismissing dialog while user is interacting |
| `recheckPermission` | `() => Promise<void>` | Re-evaluates permission (e.g., after rule change) |
| `classifierCheckInProgress` | `boolean?` | Whether an async classifier is still evaluating |
| `classifierAutoApproved` | `boolean?` | Whether a classifier auto-approved this request |

### `PermissionPrompt<T>`

```typescript
function PermissionPrompt<T extends string>(props: {
  options: PermissionPromptOption<T>[];
  onSelect: (value: T, feedback?: string) => void;
  onCancel?: () => void;
  question?: string | ReactNode;         // Default: "Do you want to proceed?"
  toolAnalyticsContext?: ToolAnalyticsContext;
}): React.ReactNode
```

Shared selection+feedback component. Supports Tab-to-expand feedback input, keybinding-driven option selection, and analytics logging.

> Source: `src/components/permissions/PermissionPrompt.tsx:45`

### `PermissionDialog`

```typescript
function PermissionDialog(props: {
  title: string;
  subtitle?: React.ReactNode;
  color?: keyof Theme;          // Default: "permission"
  titleColor?: keyof Theme;
  innerPaddingX?: number;       // Default: 1
  workerBadge?: WorkerBadgeProps;
  titleRight?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactNode
```

Styled border-box wrapper with title bar for all permission dialogs.

> Source: `src/components/permissions/PermissionDialog.tsx:17`

### `usePermissionExplainerUI`

```typescript
function usePermissionExplainerUI(props: PermissionExplanationProps): ExplainerState
```

Hook managing the AI-generated permission explanation feature. Creates the explanation fetch lazily (only on Ctrl+E toggle) to avoid unnecessary token consumption. Returns `{ visible, enabled, promise }`.

> Source: `src/components/permissions/PermissionExplanation.tsx:92`

### `usePermissionRequestLogging`

```typescript
function usePermissionRequestLogging(
  toolUseConfirm: ToolUseConfirm,
  unaryEvent: UnaryEvent
): void
```

Logs analytics and unary events when a permission prompt is shown. Guards against re-firing via a `useRef` to prevent infinite update loops from parent re-renders.

> Source: `src/components/permissions/hooks.ts:101`

## Interface/Type Definitions

### `PermissionRequestProps<Input>`

The standard props interface for all tool-specific permission components (`src/components/permissions/PermissionRequest.tsx:83-102`):

| Field | Type | Description |
|-------|------|-------------|
| `toolUseConfirm` | `ToolUseConfirm<Input>` | Tool and permission context |
| `toolUseContext` | `ToolUseContext` | Execution context |
| `onDone` | `() => void` | Signal dialog completion |
| `onReject` | `() => void` | Signal rejection |
| `verbose` | `boolean` | Show extra debug info |
| `workerBadge` | `WorkerBadgeProps \| undefined` | Swarm worker indicator |
| `setStickyFooter` | `((jsx) => void)?` | Register sticky footer JSX (fullscreen only) |

### `PermissionPromptOption<T>`

```typescript
type PermissionPromptOption<T extends string> = {
  value: T;
  label: ReactNode;
  feedbackConfig?: {
    type: FeedbackType;           // 'accept' | 'reject'
    placeholder?: string;
  };
  keybinding?: KeybindingAction;
}
```

> Source: `src/components/permissions/PermissionPrompt.tsx:10-18`

### `WorkerBadgeProps`

```typescript
type WorkerBadgeProps = {
  name: string;   // Worker/agent name
  color: string;  // CSS-style color string
}
```

> Source: `src/components/permissions/WorkerBadge.tsx:6-9`

### `SandboxPermissionRequestProps`

```typescript
type SandboxPermissionRequestProps = {
  hostPattern: NetworkHostPattern;
  onUserResponse: (response: {
    allow: boolean;
    persistToSettings: boolean;
  }) => void;
}
```

> Source: `src/components/permissions/SandboxPermissionRequest.tsx:8-14`

## Component Catalog

### Supporting Display Components

| Component | File | Purpose |
|-----------|------|---------|
| `PermissionRequestTitle` | `src/components/permissions/PermissionRequestTitle.tsx` | Title bar with bold colored title, optional worker badge (`· @name`), and subtitle |
| `PermissionExplainerContent` | `src/components/permissions/PermissionExplanation.tsx` | Shows AI-generated risk explanation with Suspense loading. Uses `ShimmerLoadingText` for animated "Loading explanation…" state |
| `PermissionRuleExplanation` | `src/components/permissions/PermissionRuleExplanation.tsx` | Color-coded display of why a permission prompt appeared (rule match, hook, classifier, safety check). Shows config hints like "/permissions to update rules" |
| `PermissionDecisionDebugInfo` | `src/components/permissions/PermissionDecisionDebugInfo.tsx` | Verbose debug panel showing behavior, decision reason, suggestions (rules/directories/mode), and unreachable rule warnings |
| `WorkerBadge` | `src/components/permissions/WorkerBadge.tsx` | Colored circle + bold `@name` badge identifying which swarm worker is requesting permission |
| `WorkerPendingPermission` | `src/components/permissions/WorkerPendingPermission.tsx` | Spinner-based "Waiting for team lead approval" indicator shown on worker nodes while the leader reviews |
| `FallbackPermissionRequest` | `src/components/permissions/FallbackPermissionRequest.tsx` | Generic handler for tools without specific UIs. Shows tool name, description, Yes/No/Always-allow options |
| `SandboxPermissionRequest` | `src/components/permissions/SandboxPermissionRequest.tsx` | Network domain access prompt for sandboxed execution. Options: allow once, allow always for host, or deny |

### Risk Level Visualization (PermissionExplanation)

The `getRiskColor` and `getRiskLabel` helpers (`src/components/permissions/PermissionExplanation.tsx:41-59`) map risk levels to visual indicators:

| Risk Level | Color | Label |
|------------|-------|-------|
| `LOW` | `success` (green) | "Low risk" |
| `MEDIUM` | `warning` (yellow) | "Med risk" |
| `HIGH` | `error` (red) | "High risk" |

### Decision Reason Display (PermissionRuleExplanation)

The `stringsForDecisionReason` function (`src/components/permissions/PermissionRuleExplanation.tsx:21-67`) formats different decision reason types:

- **`rule`**: Shows the permission rule value and its source file (with "/permissions to update rules" config hint)
- **`hook`**: Shows hook name and reason, with source label. In auto mode, renders with `warning` color
- **`classifier`**: Shows classifier name and reason (feature-flagged behind `BASH_CLASSIFIER`/`TRANSCRIPT_CLASSIFIER`)
- **`safetyCheck` / `other`**: Shows the raw reason string
- **`workingDir`**: Shows reason with config hint

### Tool-Specific Permission Components

Each tool type has a dedicated permission request component in its own subdirectory under `src/components/permissions/`:

| Tool | Component Directory |
|------|-------------------|
| Bash | `src/components/permissions/BashPermissionRequest/` |
| FileEdit | `src/components/permissions/FileEditPermissionRequest/` |
| FileWrite | `src/components/permissions/FileWritePermissionRequest/` |
| PowerShell | `src/components/permissions/PowerShellPermissionRequest/` (imports `getCompoundCommandPrefixesStatic` from `src/utils/powershell/staticPrefix.ts`) |
| WebFetch | `src/components/permissions/WebFetchPermissionRequest/` |
| NotebookEdit | `src/components/permissions/NotebookEditPermissionRequest/` |
| Filesystem (Glob/Grep/Read) | `src/components/permissions/FilesystemPermissionRequest/` |
| Skill | `src/components/permissions/SkillPermissionRequest/` |
| AskUserQuestion | `src/components/permissions/AskUserQuestionPermissionRequest/` |
| EnterPlanMode | `src/components/permissions/EnterPlanModePermissionRequest/` |
| ExitPlanMode | `src/components/permissions/ExitPlanModePermissionRequest/` |

## Configuration & Defaults

- `PermissionDialog` border color defaults to the `"permission"` theme key
- `PermissionDialog` inner horizontal padding defaults to `1`
- `PermissionPrompt` question defaults to `"Do you want to proceed?"`
- Feedback input placeholders: accept → "tell Claude what to do next", reject → "tell Claude what to do differently"
- The permission explainer is toggled via `Ctrl+E` (keybinding: `confirm:toggleExplanation`), only enabled when `isPermissionExplainerEnabled()` returns true
- `FallbackPermissionRequest` conditionally shows "always allow" options based on `shouldShowAlwaysAllowOptions()`
- `SandboxPermissionRequest` hides the "don't ask again" option when `shouldAllowManagedSandboxDomainsOnly()` returns true

## Edge Cases & Caveats

- **Infinite loop guard**: `usePermissionRequestLogging` uses a `useRef` to track the last logged `toolUseID`, preventing re-fire if the parent re-renders with a fresh `toolUseConfirm` object reference. Without this, `setAppState` can cascade into an infinite microtask loop with ~500MB/min memory leak (`src/components/permissions/hooks.ts:106-119`)
- **Lazy explanation loading**: The permission explainer creates its fetch promise only when the user actually presses Ctrl+E, avoiding wasted API tokens for explanations that are never viewed (`src/components/permissions/PermissionExplanation.tsx:87-91`)
- **Classifier auto-approval interaction**: `toolUseConfirm.onUserInteraction()` must be called when the user interacts with the dialog (arrow keys, typing) to prevent async auto-approval mechanisms from dismissing the dialog while the user is engaging (`src/components/permissions/PermissionRequest.tsx:113-117`)
- **Feature-flagged tools**: `ReviewArtifactTool`, `WorkflowTool`, and `MonitorTool` are conditionally required behind feature flags (`REVIEW_ARTIFACT`, `WORKFLOW_SCRIPTS`, `MONITOR_TOOL`). Their permission components fall back to `FallbackPermissionRequest` if unavailable (`src/components/permissions/PermissionRequest.tsx:36-41`)
- **Sticky footer**: Only works in fullscreen mode. Used by `ExitPlanModePermissionRequest` to keep response options visible during long plan scrolling. Callbacks in the JSX should use refs to avoid stale closures (`src/components/permissions/PermissionRequest.tsx:91-101`)
- **Worker pending permission**: `WorkerPendingPermission` reads team/agent identity via static functions (`getTeamName()`, `getAgentName()`, `getTeammateColor()` from `src/utils/teammate.ts`) at initial render time — these are computed once and memoized
- **Ant-only logging**: Several analytics events in `src/components/permissions/hooks.ts` only fire for Anthropic internal users (`process.env.USER_TYPE === 'ant'`), including detailed bash command parsing and "no always allow" diagnostics