# Permission Rules

## Overview & Responsibilities

The Permission Rules module provides the complete UI for managing tool permission rules in Claude Code's terminal interface. It sits within the **TerminalUI → Components → PermissionUI** hierarchy, operating alongside the tool-specific permission prompt dialogs. While the sibling PermissionUI components handle real-time approval/denial of individual tool invocations, this module handles the persistent configuration of permission rules that govern future tool behavior.

The module is composed of 8 components that collectively enable users to:
- **View** existing allow, ask, and deny rules across tabbed navigation
- **Add** new permission rules with destination selection (local, project, or user settings)
- **Delete** existing rules with confirmation
- **Search/filter** rules within each tab
- **Review** recently denied auto-mode commands and approve/retry them
- **Manage** workspace directory trust (add/remove directories)

## Key Processes

### Main Rule List Navigation Flow

1. `PermissionRuleList` initializes by checking for recent auto-mode denials via `getAutoModeDenials()` (`PermissionRuleList.tsx:482`)
2. If denials exist, the "Recently denied" tab is shown by default; otherwise, the "Allow" tab is selected
3. The component renders a `Tabs` container with 5 tabs: Recently denied, Allow, Ask, Deny, and Workspace (`PermissionRuleList.tsx:1117`)
4. Rules for each tab are sourced from `getAllowRules()`, `getAskRules()`, and `getDenyRules()` applied to the current `toolPermissionContext` from app state (`PermissionRuleList.tsx:541-575`)
5. A footer bar displays context-sensitive keyboard shortcuts that change based on the current mode (header focused, search active, recent denials, etc.) (`PermissionRuleList.tsx:1131`)

### Adding a New Rule Flow

1. User selects "Add a new rule…" from any Allow/Ask/Deny tab
2. `PermissionRuleInput` renders with a text input and usage instructions. Rules follow the format `ToolName(specifier)` — e.g., `Bash(ls:*)` or `WebFetch` (`PermissionRuleInput.tsx:78-93`)
3. On submit, the raw string is parsed via `permissionRuleValueFromString()` into a `PermissionRuleValue` (`PermissionRuleInput.tsx:50`)
4. `AddPermissionRules` dialog appears, displaying the rule and asking where to save it (`AddPermissionRules.tsx:138-149`)
5. Save destinations are: **Project settings (local)** (`.claude/settings.local.json`), **Project settings** (checked into repo), or **User settings** (`~/.claude/settings.json`) (`AddPermissionRules.tsx:18-38`)
6. On selection, `applyPermissionUpdate()` updates in-memory state and `persistPermissionUpdate()` writes to disk (`AddPermissionRules.tsx:75-86`)
7. After saving, `detectUnreachableRules()` runs to warn if the new rule is shadowed or blocked by existing rules (`AddPermissionRules.tsx:94-98`)

### Deleting a Rule Flow

1. User selects a rule from any tab, opening the `RuleDetails` component (`PermissionRuleList.tsx:885-902`)
2. For policy-managed rules (`source === "policySettings"`), deletion is blocked with a message to contact the administrator (`PermissionRuleList.tsx:146-178`)
3. For user-editable rules, a Yes/No confirmation is shown (`PermissionRuleList.tsx:203-253`)
4. On confirmation, `deletePermissionRule()` removes the rule and the focus automatically shifts to the adjacent rule in the list (`PermissionRuleList.tsx:841-874`)

### Search/Filter Flow

1. Typing any character (except reserved keys `j`, `k`, `m`, `i`, `r`, space) or pressing `/` activates search mode (`PermissionRuleList.tsx:675-696`)
2. `useSearchInput` hook manages the search query and cursor position
3. `getRulesOptions()` filters rules by checking if the rule string (lowercased) contains the query (`PermissionRuleList.tsx:623-625`)
4. The "Add a new rule…" option is hidden during search (`PermissionRuleList.tsx:602-607`)
5. Pressing Esc clears the search and exits search mode

### Recent Denials Flow

1. `RecentDenialsTab` loads denials from `getAutoModeDenials()` (`RecentDenialsTab.tsx:45`)
2. Each denial is shown with a status icon — checkmark for approved, X for not yet approved (`RecentDenialsTab.tsx:158`)
3. Users toggle approval with Enter and mark for retry with `r` (`RecentDenialsTab.tsx:73-121`)
4. Retry also auto-approves the denial (`RecentDenialsTab.tsx:113-120`)
5. On exit, retry denials trigger `onRetryDenials` callback and the session re-queries with the granted permissions (`PermissionRuleList.tsx:796-808`)

### Workspace Directory Management Flow

1. `WorkspaceTab` lists the current working directory and any additional trusted directories from `toolPermissionContext.additionalWorkingDirectories` (`WorkspaceTab.tsx:55-62`)
2. "Add directory…" opens `AddWorkspaceDirectory` with a text input, debounced directory completions, and path validation (`AddWorkspaceDirectory.tsx:137-200`)
3. Users choose between session-only or persisted (local settings) trust (`AddWorkspaceDirectory.tsx:26-38`)
4. "Remove directory" opens `RemoveWorkspaceDirectory`, a confirmation dialog that calls `applyPermissionUpdate` with `type: "removeDirectories"` (`RemoveWorkspaceDirectory.tsx:27-33`)

## Component Signatures

### `PermissionRuleList`

The main entry point and orchestrator component.

| Prop | Type | Description |
|------|------|-------------|
| `onExit` | `(result?: string, options?: { display?, shouldQuery?, metaMessages? }) => void` | Called when the dialog closes, with optional result message and query instructions |
| `initialTab` | `TabType` (optional) | Which tab to show initially (`'recent' \| 'allow' \| 'ask' \| 'deny' \| 'workspace'`) |
| `onRetryDenials` | `(commands: string[]) => void` (optional) | Called when user retries denied commands |

> Source: `PermissionRuleList.tsx:464-472`

### `AddPermissionRules`

Dialog for selecting where to persist a new rule.

| Prop | Type | Description |
|------|------|-------------|
| `onAddRules` | `(rules: PermissionRule[], unreachable?: UnreachableRule[]) => void` | Called after rules are saved, includes any detected shadowed rules |
| `onCancel` | `() => void` | Cancel callback |
| `ruleValues` | `PermissionRuleValue[]` | The rule values to add |
| `ruleBehavior` | `PermissionBehavior` | `'allow' \| 'ask' \| 'deny'` |
| `initialContext` | `ToolPermissionContext` | Current permission state |
| `setToolPermissionContext` | `(newContext: ToolPermissionContext) => void` | State setter |

> Source: `AddPermissionRules.tsx:40-47`

### `PermissionRuleInput`

Text input for entering a new permission rule string.

| Prop | Type | Description |
|------|------|-------------|
| `onCancel` | `() => void` | Cancel callback |
| `onSubmit` | `(ruleValue: PermissionRuleValue, ruleBehavior: PermissionBehavior) => void` | Called with parsed rule on Enter |
| `ruleBehavior` | `PermissionBehavior` | Which behavior tab initiated the add |

> Source: `PermissionRuleInput.tsx:14-18`

### `PermissionRuleDescription`

Renders a human-readable description of a permission rule.

| Prop | Type | Description |
|------|------|-------------|
| `ruleValue` | `PermissionRuleValue` | The rule to describe |

**Output examples:**
- Bash tool with wildcard `ls:*` → "Any Bash command starting with **ls**"
- Bash tool with exact match `ls` → "The Bash command **ls**"
- Bash tool with no specifier → "Any Bash command"
- Other tools with no specifier → "Any use of the **ToolName** tool"

> Source: `PermissionRuleDescription.tsx:9-75`

### `RecentDenialsTab`

Shows recently denied auto-mode commands.

| Prop | Type | Description |
|------|------|-------------|
| `onHeaderFocusChange` | `(focused: boolean) => void` (optional) | Reports tab header focus state |
| `onStateChange` | `(state: { approved: Set<number>, retry: Set<number>, denials: AutoModeDenial[] }) => void` | Reports current approval/retry state |

> Source: `RecentDenialsTab.tsx:10-17`

### `WorkspaceTab`

Displays and manages trusted workspace directories.

| Prop | Type | Description |
|------|------|-------------|
| `onExit` | `(result?: string, options?) => void` | Exit callback |
| `toolPermissionContext` | `ToolPermissionContext` | Current permission context |
| `onRequestAddDirectory` | `() => void` | Opens add directory dialog |
| `onRequestRemoveDirectory` | `(path: string) => void` | Opens remove directory dialog |
| `onHeaderFocusChange` | `(focused: boolean) => void` (optional) | Reports tab header focus state |

> Source: `WorkspaceTab.tsx:11-19`

### `AddWorkspaceDirectory`

Dialog for adding a new trusted directory with path input and autocomplete.

| Prop | Type | Description |
|------|------|-------------|
| `onAddDirectory` | `(path: string, remember?: boolean) => void` | Called with directory path and persistence flag |
| `onCancel` | `() => void` | Cancel callback |
| `permissionContext` | `ToolPermissionContext` | Current permission context |
| `directoryPath` | `string` (optional) | Pre-filled path, skips input and shows confirmation |

> Source: `AddWorkspaceDirectory.tsx:19-24`

### `RemoveWorkspaceDirectory`

Confirmation dialog for removing a trusted directory.

| Prop | Type | Description |
|------|------|-------------|
| `directoryPath` | `string` | Path being removed |
| `onRemove` | `() => void` | Confirm callback |
| `onCancel` | `() => void` | Cancel callback |
| `permissionContext` | `ToolPermissionContext` | Current permission context |
| `setPermissionContext` | `(context: ToolPermissionContext) => void` | State setter |

> Source: `RemoveWorkspaceDirectory.tsx:9-15`

## Type Definitions

### `TabType`

```typescript
type TabType = 'recent' | 'allow' | 'ask' | 'deny' | 'workspace'
```

Controls which tab is currently active in the permissions dialog.

### `PermissionRuleValue` (external)

Core type representing a parsed rule, with `toolName: string` and optional `ruleContent: string`.

### `PermissionBehavior` (external)

Union type: `'allow' | 'ask' | 'deny'` — determines what happens when a matching tool invocation occurs.

### `RememberDirectoryOption` (in AddWorkspaceDirectory)

```typescript
type RememberDirectoryOption = 'yes-session' | 'yes-remember' | 'no'
```

Controls whether an added workspace directory persists beyond the current session.

## Configuration & Defaults

- **Save destinations** for rules are sourced from the `SOURCES` constant (imported from `utils/settings/constants.js`), mapped to `localSettings`, `projectSettings`, and `userSettings`
- **Default tab** is `"recent"` if there are auto-mode denials, otherwise `"allow"` (`PermissionRuleList.tsx:488`)
- **Search** is case-insensitive and matches against the full rule string representation
- **Directory completions** are debounced at 100ms (`AddWorkspaceDirectory.tsx:173`)
- **Max visible options** in Select lists is capped at 10 (`RulesTabContent` line 335, `RecentDenialsTab` line 184)

## Edge Cases & Caveats

- **Policy-managed rules** (source `"policySettings"`) cannot be deleted — the UI shows a read-only detail view with a message to contact the system administrator (`PermissionRuleList.tsx:146-178`)
- **Unreachable rule detection** runs after adding rules and warns users if their new rule is shadowed (overridden by a broader allow) or blocked (overridden by a broader deny). Warnings include the reason and a suggested fix (`PermissionRuleList.tsx:751-761`)
- **Sandbox auto-allow** is factored into unreachable rule detection — if sandbox mode is enabled with auto-allow Bash, some rules may be considered shadowed (`AddPermissionRules.tsx:93-94`)
- **Reserved search keys**: `j`, `k`, `m`, `i`, `r`, and space are excluded from triggering search mode because they serve other navigation/interaction purposes (`PermissionRuleList.tsx:690`)
- **Workspace directory removal** only applies to the session — the `applyPermissionUpdate` uses `destination: "session"` even if the directory was previously persisted (`RemoveWorkspaceDirectory.tsx:31`)
- When the user exits with approved denials or retry commands, the component constructs meta-messages for the query engine so it can act on the newly granted permissions (`PermissionRuleList.tsx:796-817`)