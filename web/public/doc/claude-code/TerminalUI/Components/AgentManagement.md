# Agent Management

## Overview & Responsibilities

The Agent Management module provides the complete UI layer for defining, browsing, creating, editing, and deleting custom agents within Claude Code. It lives under `src/components/agents/` (with an additional `src/components/skills/SkillsMenu.tsx`) and belongs to the **Components** layer of the **TerminalUI** subsystem.

Agents are reusable, prompt-driven sub-processes that Claude can launch via the `Agent` tool. Each agent is a Markdown file with YAML frontmatter (name, description, tools, model, color, memory scope) and a system prompt body. This module gives users a terminal-based UI to manage those agent definitions — from a top-level menu that lists agents grouped by source, to a multi-step wizard that can auto-generate an entire agent definition using Claude itself.

**Sibling modules** in the Components layer include message display, prompt input, dialog system, design-system primitives, and other specialized UI components. This module is reached via the `/agents` slash command, which renders `AgentsMenu` as the entry point.

## Key Processes

### Navigation State Machine

The module is driven by a `ModeState` discriminated union (`src/components/agents/types.ts:14-21`) that controls which view is displayed:

```
main-menu → list-agents → agent-menu → view-agent
                                     → edit-agent
                                     → delete-confirm
                       → create-agent (wizard)
```

`AgentsMenu` (`src/components/agents/AgentsMenu.tsx`) is the root component that owns this state and switches between views. It starts in `list-agents` mode with source `"all"`, showing every agent across all sources.

### Browsing Agents

1. `AgentsMenu` reads `agentDefinitions` from global app state and groups agents by source: built-in, user settings, project settings, policy settings, local settings, flag settings, and plugin (`AgentsMenu.tsx:67-146`).
2. `AgentsList` (`src/components/agents/AgentsList.tsx`) renders the agent list within a `Dialog`, sorted by name. Agents are organized by source group using `AGENT_SOURCE_GROUPS` (from `src/tools/AgentTool/agentDisplay.ts:24`). Built-in agents are displayed as non-selectable (dimmed) items. Override/shadow relationships are detected and displayed with a warning icon.
3. Selecting an agent navigates to the `agent-menu` mode, which presents options: View details, Edit, or Delete.

### Viewing Agent Details

`AgentDetail` (`src/components/agents/AgentDetail.tsx`) renders a read-only view of an agent showing:
- File path (via `getActualRelativeAgentFilePath`)
- Description (the `whenToUse` field)
- System prompt (rendered as Markdown via the `Markdown` component)
- Resolved tools list (with invalid tools flagged with a warning icon)
- Model configuration (via `getAgentModelDisplay` from `src/utils/model/agent.ts`)
- Memory scope (via `getMemoryScopeDisplay`)
- Agent color (as a colored badge via `getAgentColor`)

### Editing Agents

`AgentEditor` (`src/components/agents/AgentEditor.tsx`) provides an edit menu with four options:
- **Open in editor** — launches the agent's `.md` file in the user's `$EDITOR` via `editFileInEditor()`
- **Edit tools** — opens the `ToolSelector` to modify the agent's tool set
- **Edit color** — opens the `ColorPicker` to change the agent's badge color
- **Edit model** — opens the `ModelSelector` to change the agent's model

On save, it calls `updateAgentFile()` to rewrite the Markdown file, updates the color manager via `setAgentColor()`, and patches global app state (both `allAgents` and `activeAgents`) so the change is immediately reflected without restart.

### Creating Agents (Wizard)

The `CreateAgentWizard` (`src/components/agents/new-agent-creation/CreateAgentWizard.tsx`) orchestrates a multi-step wizard using a generic `WizardProvider`. The steps execute in this order:

| Index | Step | Purpose |
|-------|------|---------|
| 0 | `LocationStep` | Choose storage location: project (`.claude/agents/`) or personal (`~/.claude/agents/`) |
| 1 | `MethodStep` | Choose creation method: "Generate with Claude" or "Manual configuration" |
| 2 | `GenerateStep` | (Generate path) Enter a natural-language description, call Claude to produce identifier + description + system prompt |
| 3 | `TypeStep` | Enter a unique agent identifier (alphanumeric + hyphens, 3–50 chars) |
| 4 | `PromptStep` | Enter or edit the system prompt (supports external editor via keybinding) |
| 5 | `DescriptionStep` | Enter the `whenToUse` description that tells Claude when to invoke this agent |
| 6 | `ToolsStep` | Select which tools the agent can use via `ToolSelector` |
| 7 | `ModelStep` | Choose the model (sonnet, opus, haiku, or custom ID) via `ModelSelector` |
| 8 | `ColorStep` | Pick a badge color via `ColorPicker`; also assembles the `finalAgent` object |
| 9 | `MemoryStep` | (Conditional — only if `isAutoMemoryEnabled()` returns true) Choose memory scope: user, project, local, or none |
| 10 | `ConfirmStepWrapper` → `ConfirmStep` | Review all settings, validate, then save |

**Dynamic navigation**: The `MethodStep` uses `goToStep(3)` to skip the generate step when manual mode is chosen. The `GenerateStep` uses `goToStep(6)` to skip type/prompt/description steps when generation succeeds (since those fields are auto-populated).

**ConfirmStep keyboard shortcuts**: Press `s` or `Enter` to save, or `e` to save and immediately open the file in an external editor (`src/components/agents/new-agent-creation/wizard-steps/ConfirmStep.tsx:52-61`).

### AI-Powered Agent Generation

`generateAgent()` (`src/components/agents/generateAgent.ts:122-197`) sends a request to Claude using a carefully crafted system prompt (`AGENT_CREATION_SYSTEM_PROMPT`, line 26–97) that instructs the model to produce a JSON object with three fields: `identifier`, `whenToUse`, and `systemPrompt`. Key details:

- Uses `queryModelWithoutStreaming` with thinking disabled for faster response
- Includes user context (from `getUserContext`) and project instructions (from CLAUDE.md files) via `prependUserContext`
- When auto-memory is enabled, appends `AGENT_MEMORY_INSTRUCTIONS` (line 99–120) so the generated system prompt includes memory update guidance tailored to the agent's domain
- Falls back to regex JSON extraction (`responseText.match(/\{[\s\S]*\}/)`) if the response isn't pure JSON
- Validates that all three required fields are present before returning
- Logs a `tengu_agent_definition_generated` analytics event

### Agent File Persistence

`agentFileUtils.ts` (`src/components/agents/agentFileUtils.ts`) handles all filesystem operations:

- **`formatAgentAsMarkdown()`** (line 20–55): Serializes agent data into a Markdown file with YAML frontmatter. Handles YAML escaping for the description field (backslashes → `\\`, double quotes → `\"`, newlines → `\\n`). Optional fields (tools, model, effort, color, memory) are only included when set. Tools of `['*']` or `undefined` cause the `tools` line to be omitted entirely (meaning "all tools").
- **`saveAgentToFile()`** (line 166–203): Creates a new agent file. Uses `open()` with the `'wx'` flag by default to prevent overwriting existing files. Calls `datasync()` to ensure data is flushed to disk.
- **`updateAgentFile()`** (line 208–236): Overwrites an existing agent file with updated content using `getActualAgentFilePath()` to resolve the real filename.
- **`deleteAgentFromFile()`** (line 241–258): Removes an agent file via `unlink()`, silently ignoring `ENOENT` errors.
- **Path resolution**: Agents are stored in `<project>/.claude/agents/` (project/local), `~/.claude/agents/` (user), or a managed path (policy). `getActualAgentFilePath()` (line 104–115) handles the case where the on-disk filename differs from `agentType`. `getActualRelativeAgentFilePath()` (line 135–149) returns display-friendly paths, including special labels for built-in (`"Built-in"`) and plugin (`"Plugin: <name>"`) agents.

### Validation

`validateAgent()` (`src/components/agents/validateAgent.ts:35-109`) performs comprehensive validation returning `{ isValid, errors, warnings }`:

- **Type** (`validateAgentType`, line 15–33): Must match `/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/`, be 3–50 characters. Duplicates across different sources are errors.
- **Description**: Required; warns if <10 chars ("should be more descriptive") or >5000 chars.
- **Tools**: Must be an array if provided. Validates each tool name against available tools via `resolveAgentTools()`. Invalid tool names are errors; an empty array generates a warning about limited capabilities.
- **System prompt**: Required, minimum 20 characters. Warns if >10,000 characters.

Errors block saving; warnings are informational only.

## Shared UI Components

### ToolSelector

`ToolSelector` (`src/components/agents/ToolSelector.tsx`) provides a multi-select interface for choosing agent tools. Tools are organized into five buckets:

| Bucket | Contents |
|--------|----------|
| Read-only tools | `Glob`, `Grep`, `FileRead`, `WebFetch`, `WebSearch`, `TodoWrite`, `TaskStop`, `TaskOutput`, `ExitPlanModeV2`, `ListMcpResources`, `ReadMcpResource` |
| Edit tools | `FileEdit`, `FileWrite`, `NotebookEdit` |
| Execution tools | `Bash` (and `Tungsten` in ant builds) |
| MCP tools | Dynamically discovered MCP tools, grouped by server name via `getMcpServerBuckets()` |
| Other tools | Catch-all for any tools not in the above categories |

Each bucket can be toggled as a group, and individual tools within can be toggled independently. The `Agent` tool itself is excluded from selection (via `filterToolsForAgent`). When `initialTools` is `undefined`, the selector starts with all tools selected.

### ModelSelector

`ModelSelector` (`src/components/agents/ModelSelector.tsx`) wraps a `Select` component with model options from `getAgentModelOptions()` (defined in `src/utils/model/agent.ts`). If the agent's current model is a full ID not in the alias list (e.g., `claude-opus-4-5`), it is injected as a custom option at the top to ensure round-trip fidelity. Defaults to `"sonnet"`.

### ColorPicker

`ColorPicker` (`src/components/agents/ColorPicker.tsx`) presents a vertical list of color options (`'automatic'` plus all named colors from `AGENT_COLORS`). Each named color shows a swatch via `backgroundColor` using `AGENT_COLOR_TO_THEME_COLOR` mapping. A live preview displays the agent name badge (`@agent-name`) with the selected color at the bottom. Selecting "automatic" returns `undefined`, which lets the system assign a color based on the agent name.

### AgentNavigationFooter

`AgentNavigationFooter` (`src/components/agents/AgentNavigationFooter.tsx`) renders a standard navigation hint bar ("Press ↑↓ to navigate · Enter to select · Esc to go back") and integrates with `useExitOnCtrlCDWithKeybindings` to show a "Press again to exit" confirmation prompt.

## SkillsMenu

`SkillsMenu` (`src/components/skills/SkillsMenu.tsx`) is a read-only browser for available skills (prompt-driven slash commands). It:

1. Filters the full commands list to only `PromptCommand` entries that have a `source` property
2. Groups skills by source in display order: project, user, policy, plugin, MCP
3. For MCP skills, extracts server names from the `<server>:<skill>` naming convention
4. For file-based skills, shows the filesystem path (e.g., `.claude/skills/`) via `getSkillsPath()`; also shows the deprecated `commands/` path if any skills loaded from there
5. Displays each skill with its name, description, estimated frontmatter token count (via `estimateSkillFrontmatterTokens`), and invocation syntax
6. Renders inside a `Dialog` with a subtitle showing total skill count (e.g., "5 skills")
7. Shows an empty state with guidance ("Create skills in .claude/skills/ or ~/.claude/skills/") when no skills are found

Skills are distinct from agents: skills are slash-command extensions that inject prompts into the main conversation, while agents are sub-processes launched with their own system prompts, tool sets, and isolated execution context.

## Type Definitions

### `ModeState`

Discriminated union controlling the navigation state (`src/components/agents/types.ts:14-21`):

```typescript
type ModeState =
  | { mode: 'main-menu' }
  | { mode: 'list-agents'; source: SettingSource | 'all' | 'built-in' }
  | { mode: 'agent-menu'; agent: AgentDefinition; previousMode: ModeState }
  | { mode: 'view-agent'; agent: AgentDefinition; previousMode: ModeState }
  | { mode: 'create-agent' }
  | { mode: 'edit-agent'; agent: AgentDefinition; previousMode: ModeState }
  | { mode: 'delete-confirm'; agent: AgentDefinition; previousMode: ModeState }
```

### `AgentValidationResult`

Returned by `validateAgent()` (`src/components/agents/validateAgent.ts:9-13`):

```typescript
type AgentValidationResult = {
  isValid: boolean
  errors: string[]
  warnings: string[]
}
```

### `AGENT_PATHS`

Constants for agent file locations (`src/components/agents/types.ts:4-7`):

```typescript
const AGENT_PATHS = {
  FOLDER_NAME: '.claude',
  AGENTS_DIR: 'agents',
}
```

## Configuration & Defaults

| Setting | Default | Description |
|---------|---------|-------------|
| Agent storage folder | `.claude/agents/` | Relative to project root (project) or `~/.claude/` (user) |
| Default model | `"sonnet"` | Used when no model is explicitly configured |
| Default color | `"automatic"` | System chooses a color based on agent name hash |
| Memory scope | None | Disabled unless `isAutoMemoryEnabled()` returns true (feature-gated) |
| Tool access | All tools (`*`) | When `tools` is undefined or `['*']`, the agent has unrestricted tool access |

## Edge Cases & Caveats

- **Built-in and plugin agents are read-only**: The UI prevents editing, deleting, or saving over them. `saveAgentToFile()`, `updateAgentFile()`, and `deleteAgentFromFile()` all throw errors if called with `source === 'built-in'`.
- **Agent shadowing**: When agents with the same `agentType` exist at multiple sources, the higher-priority source shadows the lower one. `AgentsList` renders a "⚠ shadowed by [source]" warning on the overridden agent.
- **File write safety**: `writeFileAndFlush()` (`src/components/agents/agentFileUtils.ts:260-272`) uses `open()` → `writeFile()` → `datasync()` → `close()` to minimize the chance of partial writes. The `'wx'` flag prevents accidental overwrites during creation.
- **YAML escaping**: The `whenToUse` field in `formatAgentAsMarkdown()` requires careful escaping of backslashes, double quotes, and newlines for safe round-tripping through YAML double-quoted strings.
- **Wizard step skipping**: The generate flow skips steps 3–5 (type, prompt, description) and jumps directly to step 6 (tools). Going back from the tools step after generation navigates to the generate step rather than the skipped manual steps.
- **MemoryStep is conditional**: Only included in the wizard step array when `isAutoMemoryEnabled()` returns true. This means the total step count varies (10 or 11), and the confirm step is always the last.
- **ConfirmStepWrapper vs ConfirmStep separation**: `ConfirmStepWrapper` (`src/components/agents/new-agent-creation/wizard-steps/ConfirmStepWrapper.tsx`) handles the save side-effects (filesystem write via `saveAgentToFile`, app state update via `setAppState`, analytics logging via `logEvent('tengu_agent_created', ...)`, optional editor launch). `ConfirmStep` (`src/components/agents/new-agent-creation/wizard-steps/ConfirmStep.tsx`) handles the presentation (summary display, validation via `validateAgent`, keyboard shortcuts).
- **Generation cancellation**: The `GenerateStep` creates an `AbortController` and aborts it when Escape is pressed during generation. `APIUserAbortError` is caught silently; other errors are displayed to the user.