# Display and UI

## Overview & Responsibilities

The Display and UI module is the visual rendering layer for the Agent tool within Claude Code's terminal interface. It sits inside the **ToolSystem → AgentAndOrchestration → AgentTool** hierarchy, alongside the core agent spawning engine, task tools, and team/messaging tools. While those siblings handle agent lifecycle and coordination, this module is solely responsible for **how agents look in the terminal** — their names, colors, progress indicators, completion summaries, and error states.

The module comprises three files:

| File | Lines | Role |
|------|-------|------|
| `UI.tsx` | ~871 | React (Ink) components for rendering agent tool use in the terminal |
| `agentDisplay.ts` | ~104 | Agent metadata display: source grouping, override resolution, model labels |
| `agentColorManager.ts` | ~66 | Assigns and retrieves unique colors per agent type from a fixed palette |

## Key Processes

### Agent Color Assignment Flow

Each non-general-purpose agent type gets a unique color from a fixed 8-color palette so users can visually distinguish concurrent agents.

1. When a new agent is spawned, the system calls `setAgentColor(agentType, color)` to register a color in the global `agentColorMap` (stored in bootstrap state).
2. When any UI component needs an agent's color, it calls `getAgentColor(agentType)`, which looks up the stored `AgentColorName` and maps it to a theme key via `AGENT_COLOR_TO_THEME_COLOR`.
3. The `general-purpose` agent type is explicitly excluded from coloring — `getAgentColor` returns `undefined` for it.

> Source: `src/tools/AgentTool/agentColorManager.ts:36-50`

The palette consists of 8 named colors:

```typescript
export const AGENT_COLORS: readonly AgentColorName[] = [
  'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan',
] as const
```

Each maps to a theme key suffixed with `_FOR_SUBAGENTS_ONLY` (e.g., `red_FOR_SUBAGENTS_ONLY`) to isolate agent colors from the rest of the theme system.

> Source: `src/tools/AgentTool/agentColorManager.ts:14-34`

### Agent Name and Badge Resolution

The `userFacingName()` helper determines what label to show for an agent:

1. If the agent has a custom `subagent_type` (not `general-purpose` or `worker`), that type name is displayed directly.
2. `worker` agents are displayed as `"Agent"` for cleaner UI.
3. All other agents (including general-purpose) fall back to `"Agent"`.

The `userFacingNameBackgroundColor()` helper pairs with this: it calls `getAgentColor()` on the agent's `subagent_type` to return the corresponding theme color key for the name badge background, or `undefined` for uncolored agents.

> Source: `src/tools/AgentTool/UI.tsx:760-787`

### Progress Message Rendering Flow

When an agent is running, its intermediate progress is rendered via `renderToolUseProgressMessage()`:

1. **Empty state**: If no progress messages exist yet, shows `"Initializing…"`.
2. **Condensed mode check**: Estimates how many terminal lines the full render would take (`inProgressToolCallCount × 9 + 7`). If the terminal is too small, renders a single-line summary with tool use count and token count.
3. **Message processing**: Calls `processProgressMessages()` to group consecutive search/read/REPL operations into `SummaryMessage` entries (this grouping is currently gated to "ant" builds only).
4. **Display slicing**: In normal mode, only the last `MAX_PROGRESS_MESSAGES_TO_SHOW` (3) processed messages are shown. Hidden messages are counted and displayed as `"+N more tool uses"`.
5. **Rendering**: Each displayed message is rendered via `MessageComponent` with subagent lookups for nested agent context, or as a dimmed summary text for grouped operations.

> Source: `src/tools/AgentTool/UI.tsx:445-570`

### Grouped Agent Display Flow

When multiple agents run concurrently, `renderGroupedAgentToolUse()` provides a consolidated view:

1. For each agent tool use, it parses the input, calculates stats (tool use count, token count), extracts the last tool info for status display, and resolves the agent type/color.
2. Determines if all agents are the same type (for a common label like "3 Explore agents") vs heterogeneous ("3 agents").
3. Renders a header line showing running/finished/backgrounded state with count.
4. Each individual agent gets an `AgentProgressLine` row showing its type badge (with color), description, current status (last tool), and stats.

> Source: `src/tools/AgentTool/UI.tsx:649-759`

### Completion Result Rendering

`renderToolResultMessage()` handles the output after an agent finishes:

1. **Remote-launched**: Shows the task ID and session URL.
2. **Async-launched** (backgrounded): Shows "Backgrounded agent" with keyboard hints for managing it.
3. **Completed**: Builds a summary line like `"Done (5 tool uses · 12,345 tokens · 3.2s)"`, renders the final assistant message, and in transcript mode also shows the full prompt, verbose transcript, and response content.

> Source: `src/tools/AgentTool/UI.tsx:315-410`

### Agent Override Resolution (agentDisplay.ts)

`resolveAgentOverrides()` annotates a list of all loaded agents with override information:

1. Builds a map of active (winning) agents keyed by `agentType`.
2. Iterates all agents, deduplicating by `(agentType, source)` to handle git worktree duplicates.
3. If an agent's type exists in the active map but with a different source, marks it as `overriddenBy` that source.

This enables the UI to show which agents are active and which are shadowed by higher-priority sources.

> Source: `src/tools/AgentTool/agentDisplay.ts:46-72`

## Function Signatures

### UI.tsx — Exported Components and Renderers

#### `AgentPromptDisplay({ prompt, dim? }): ReactNode`
Renders the agent's prompt with a bold green "Prompt:" header and indented Markdown content.

#### `AgentResponseDisplay({ content }): ReactNode`
Renders the agent's response blocks as indented Markdown under a bold green "Response:" header.

#### `renderToolResultMessage(data, progressMessages, options): ReactNode`
Renders the final result of an agent tool use. Handles `remote_launched`, `async_launched`, and `completed` statuses.
- **options**: `{ tools, verbose, theme, isTranscriptMode? }`

#### `renderToolUseMessage({ description, prompt }): ReactNode`
Returns the description string as the tool use message, or `null` if either field is missing.

#### `renderToolUseTag(input): ReactNode`
Renders optional tags next to the tool use header. Currently shows the model name if it differs from the main loop model.

#### `renderToolUseProgressMessage(progressMessages, options): ReactNode`
Renders live progress while an agent runs. Supports condensed mode for small terminals, grouped search/read summaries, and hidden message counts.
- **options**: `{ tools, verbose, terminalSize?, inProgressToolCallCount?, isTranscriptMode? }`

#### `renderToolUseRejectedMessage(input, options): ReactNode`
Renders progress so far followed by a `FallbackToolUseRejectedMessage`.

#### `renderToolUseErrorMessage(result, options): ReactNode`
Renders progress so far followed by a `FallbackToolUseErrorMessage`.

#### `renderGroupedAgentToolUse(toolUses, options): ReactNode | null`
Renders a consolidated view of multiple concurrent agent tool uses with per-agent progress lines.
- **toolUses**: Array of `{ param, isResolved, isError, isInProgress, progressMessages, result? }`
- **options**: `{ shouldAnimate, tools }`

#### `userFacingName(input): string`
Returns the display name for an agent. Custom subagent types show their type name; `worker` and `general-purpose` show `"Agent"`.

#### `userFacingNameBackgroundColor(input): keyof Theme | undefined`
Returns the theme color key for the agent's name badge background, or `undefined`.

#### `extractLastToolInfo(progressMessages, tools): string | null`
Extracts a status string from the last tool operation. Groups trailing consecutive search/read operations into a summary, or shows the last tool's user-facing name and summary.

### agentDisplay.ts — Display Utilities

#### `resolveAgentOverrides(allAgents, activeAgents): ResolvedAgent[]`
Annotates agents with `overriddenBy` source information, deduplicating worktree duplicates.

#### `resolveAgentModelDisplay(agent): string | undefined`
Returns the agent's model alias or `"inherit"` for display.

#### `getOverrideSourceLabel(source): string`
Returns a lowercase human-readable label for an agent source (e.g., `"user"`, `"project"`).

#### `compareAgentsByName(a, b): number`
Case-insensitive alphabetical comparator for agent definitions.

### agentColorManager.ts — Color Assignment

#### `getAgentColor(agentType): keyof Theme | undefined`
Looks up the assigned theme color key for an agent type. Returns `undefined` for `general-purpose` or unassigned types.

#### `setAgentColor(agentType, color): void`
Assigns or removes a color for an agent type in the global color map.

## Interface & Type Definitions

### `AgentColorName` (agentColorManager.ts:4-12)
Union type of the 8 supported agent color names: `'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan'`.

### `AgentSourceGroup` (agentDisplay.ts:15-18)
```typescript
{ label: string; source: AgentSource }
```
Pairs a display label with an agent source for consistent ordering in both CLI and interactive UI.

### `AgentSource` (agentDisplay.ts:13)
`SettingSource | 'built-in' | 'plugin'` — all possible origins for an agent definition.

### `ResolvedAgent` (agentDisplay.ts:34-36)
Extends `AgentDefinition` with an optional `overriddenBy?: AgentSource` field.

### `SummaryMessage` (UI.tsx:82-89)
Internal type for grouped search/read progress:
```typescript
{ type: 'summary'; searchCount: number; readCount: number; replCount: number; uuid: string; isActive: boolean }
```

### `ProcessedMessage` (UI.tsx:90-93)
Discriminated union: either `{ type: 'original'; message: ProgressMessage<AgentToolProgress> }` or a `SummaryMessage`.

## Configuration & Defaults

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `MAX_PROGRESS_MESSAGES_TO_SHOW` | 3 | `UI.tsx:33` | Max progress messages visible in normal (non-transcript) mode |
| `ESTIMATED_LINES_PER_TOOL` | 9 | `UI.tsx:181` | Line estimate per tool for condensed mode threshold |
| `TERMINAL_BUFFER_LINES` | 7 | `UI.tsx:182` | Buffer lines added to condensed mode threshold calculation |
| `AGENT_COLORS` | 8-element array | `agentColorManager.ts:14-23` | The fixed color palette for agent identification |
| `AGENT_SOURCE_GROUPS` | 7-element array | `agentDisplay.ts:24-32` | Ordered list of agent source groups for display consistency |

The global agent color map is stored externally in bootstrap state (accessed via `getAgentColorMap()`), making color assignments persist across the session.

## Edge Cases & Caveats

- **General-purpose agents get no color**: `getAgentColor()` explicitly returns `undefined` for `'general-purpose'`, so these agents render without a colored badge.
- **Worker agents aliased to "Agent"**: The `userFacingName()` function maps `'worker'` subagent type to the generic `"Agent"` label to avoid exposing internal naming.
- **Condensed mode for small terminals**: When the terminal has fewer rows than `(inProgressToolCallCount × 9) + 7`, progress rendering switches to a single-line summary to prevent flickering.
- **Search/read grouping is ant-only**: The `processProgressMessages()` function contains a build-time gate (`"external" !== 'ant'`), so search/read grouping into summaries is only active in internal ant builds. External builds show individual messages (minus user tool_result messages, which are filtered out).
- **User tool_result messages are skipped in progress**: Subagent progress messages lack `toolUseResult`, so rendering them via `UserToolSuccessMessage` would produce blank lines. The code explicitly filters these out.
- **Worktree deduplication**: `resolveAgentOverrides()` deduplicates by `(agentType, source)` because the same agent file can be loaded from both a git worktree and the main repo.
- **Color palette is finite**: With only 8 colors, agent types beyond the 8th won't receive a color assignment unless a previous one is freed via `setAgentColor(type, undefined)`.