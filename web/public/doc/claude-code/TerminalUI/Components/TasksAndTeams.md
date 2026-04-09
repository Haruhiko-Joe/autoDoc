# Tasks and Teams

## Overview & Responsibilities

The TasksAndTeams module provides the complete UI layer for monitoring background tasks and managing multi-agent teams within Claude Code's terminal interface. It lives under the **TerminalUI > Components** subtree and renders two main concerns:

1. **Background Tasks** — A system for monitoring, inspecting, and controlling any work happening in parallel (shell commands, local/remote agents, in-process teammates, workflows, MCP monitors, and "dream" tasks).
2. **Teams** — Views for managing coordinator-mode teams where multiple Claude instances (teammates) work in separate tmux panes on a shared codebase.

These components appear in the status line footer, as modal dialogs opened via keyboard shortcuts, and as inline headers when the user is viewing a teammate's transcript.

### File Map

| File | Role |
|------|------|
| `src/components/tasks/BackgroundTasksDialog.tsx` | Master dialog listing all background tasks with navigation, drill-down, and kill controls |
| `src/components/tasks/BackgroundTask.tsx` | Single-line renderer for any background task type |
| `src/components/tasks/BackgroundTaskStatus.tsx` | Footer status bar showing task counts or agent pills |
| `src/components/tasks/taskStatusUtils.tsx` | Shared utilities: status icons, colors, activity descriptions |
| `src/components/tasks/renderToolActivity.tsx` | Renders a tool activity as a human-readable React node |
| `src/components/tasks/ShellProgress.tsx` | Status text for shell tasks + reusable `TaskStatusText` |
| `src/components/tasks/RemoteSessionProgress.tsx` | Progress display for remote agents, including ultrareview rainbow animation |
| `src/components/tasks/AsyncAgentDetailDialog.tsx` | Detail dialog for local async agents |
| `src/components/tasks/ShellDetailDialog.tsx` | Detail dialog for shell tasks (shows tail of output) |
| `src/components/tasks/InProcessTeammateDetailDialog.tsx` | Detail dialog for in-process teammates |
| `src/components/tasks/RemoteSessionDetailDialog.tsx` | Detail dialog for remote agent sessions (includes ultraplan views) |
| `src/components/tasks/DreamDetailDialog.tsx` | Detail dialog for dream tasks |
| `src/components/teams/TeamsDialog.tsx` | Dialog for viewing/managing coordinator-mode teammates |
| `src/components/teams/TeamStatus.tsx` | Footer status indicator showing teammate count |
| `src/components/TeammateViewHeader.tsx` | Header banner shown when viewing a teammate's transcript |
| `src/components/TaskListV2.tsx` | Todo-style task list showing task items with owner, status, and activity |

## Key Processes

### Background Tasks Dialog Flow

The `BackgroundTasksDialog` (`src/components/tasks/BackgroundTasksDialog.tsx:127`) is the central hub. It implements a list-detail navigation pattern:

1. **Task Collection** — On mount, it reads `tasks` from `useAppState()`, filters via `isBackgroundTask()`, and converts each to a typed `ListItem` discriminated union (lines 56–103 define 8 task types: `local_bash`, `remote_agent`, `local_agent`, `in_process_teammate`, `local_workflow`, `monitor_mcp`, `dream`, and a synthetic `leader` entry).

2. **Sorting and Categorization** — Tasks are sorted (running first, then by start time descending) and bucketed into category groups: teammates, bash, monitors, remote agents, local agents, workflows, and dreams. The `allSelectableItems` array merges them in render order so up/down navigation matches the visual layout (line 220).

3. **View State Machine** — A `ViewState` union (`list` | `detail`) controls what's rendered. If opened with `initialDetailTaskId` or exactly one task exists, the list is skipped and detail view is shown directly. A `skippedListOnMount` ref tracks this for back-button behavior (lines 139–163).

4. **Keyboard Handling** — Standard navigation uses configurable keybindings (`confirm:previous`, `confirm:next`, `confirm:yes`). Task-specific shortcuts (`x` = kill, `f` = foreground teammate, left-arrow = back/close) are handled in a raw `onKeyDown` handler (lines 253–305).

5. **Detail Delegation** — When a task is selected, the dialog renders the appropriate detail component based on `task.type` (lines 375–399): `ShellDetailDialog`, `AsyncAgentDetailDialog`, `RemoteSessionDetailDialog`, `InProcessTeammateDetailDialog`, `WorkflowDetailDialog`, `MonitorMcpDetailDialog`, or `DreamDetailDialog`.

6. **Task Lifecycle Tracking** — A `useEffect` watches for tasks disappearing from state (killed or evicted) and auto-navigates back to list or closes the dialog (lines 325–348).

### Footer Status Bar Flow

`BackgroundTaskStatus` (`src/components/tasks/BackgroundTaskStatus.tsx:25`) renders the compact status shown in the prompt's footer area:

1. **Pill Mode** — When all background tasks are in-process teammates (or the user is viewing a teammate), the footer renders a horizontally-scrollable row of colored **agent pills**. Each pill shows the agent's name with its assigned color and an idle/active indicator. The `calculateHorizontalScrollWindow` utility handles overflow with left/right arrows.

2. **Count Mode** — Otherwise, it shows a pill label (e.g., "2 tasks") with a CTA hint when needed, generated by `getPillLabel()` and `pillNeedsCta()`.

3. **Visibility Logic** — The `shouldHideTasksFooter()` utility (from `taskStatusUtils.tsx:93`) determines whether to hide the footer entirely when the spinner tree is active and all visible tasks are teammates (since those are shown in the spinner tree instead).

### Task Status Utilities

`taskStatusUtils.tsx` provides the shared vocabulary for rendering task state:

- **`isTerminalStatus(status)`** — Returns `true` for `completed`, `failed`, or `killed` (line 16).
- **`getTaskStatusIcon(status, options)`** — Maps status + flags (idle, awaiting approval, error, shutdown requested) to a `figures` icon character (lines 23–45).
- **`getTaskStatusColor(status, options)`** — Same inputs, returns a semantic color name: `success`, `error`, `warning`, or `background` (lines 50–70).
- **`describeTeammateActivity(t)`** — Derives a human-readable string from an in-process teammate's state, with a priority chain: shutdown then approval then idle then recent activity summary then last activity description then `'working'` (lines 77–82).

### Remote Session Progress and Ultrareview

`RemoteSessionProgress` (`src/components/tasks/RemoteSessionProgress.tsx:172`) handles two display modes:

1. **Standard remote sessions** — Shows simple status text: "done" (green), "error" (red), or a `running`/`pending` spinner.
2. **Ultrareview sessions** — Renders a rainbow-animated "ultrareview" label with smooth-counted bug statistics. The `formatReviewStageCounts()` function (line 22) generates stage-appropriate counts strings shared between the pill and detail views to prevent drift. Uses `useSmoothCount()` (line 76) to animate count changes (incrementing +1 per frame instead of snapping).

### Tool Activity Rendering

`renderToolActivity()` (`src/components/tasks/renderToolActivity.tsx:7`) converts a `ToolActivity` record (tool name + input) into a displayable React node:

1. Looks up the tool by name in the tool registry via `findToolByName()`.
2. Parses the input against the tool's schema via `safeParse()`.
3. Gets the `userFacingName()` and renders it with `renderToolUseMessage()` arguments.
4. Falls back to the raw tool name on any failure.

### Teams Dialog

`TeamsDialog` (`src/components/teams/TeamsDialog.tsx:48`) manages coordinator-mode teammates running in separate tmux panes:

- Lists teammates with their permission mode, status (idle/working/stopped), and current activity.
- Supports drill-down to a teammate detail view showing pane info, permission mode, and assigned tasks.
- Keyboard actions: `k` to kill, `h` to hide pane, `m` to cycle permission modes, `Enter` to view output (switches to tmux pane).
- Auto-refreshes teammate statuses every 1 second via `useInterval`.
- Permission mode cycling works on individual teammates (detail view) or all teammates at once (list view) via the `confirm:cycleMode` keybinding.

### TaskListV2

`TaskListV2` (`src/components/TaskListV2.tsx:30`) renders a todo-style task list used in the spinner tree and standalone views:

1. **Prioritized Display** — When the list exceeds `maxDisplay` (computed from terminal rows), tasks are prioritized: recently completed (within 30s TTL) > in-progress > pending > older completed. Hidden tasks get a summary line (e.g., "+3 in progress, 2 pending").
2. **Teammate Integration** — Builds color and activity maps from in-process teammate background tasks, so each task item shows its owner's color and current activity.
3. **TaskItem Rendering** — Each task shows a status icon (tick for completed, filled square for in-progress, open square for pending), subject text (strikethrough when done), optional `@owner` tag with team color, blocker info, and current activity description.
4. **Completion TTL** — Recently completed tasks remain visible for 30 seconds before being eligible for truncation, with a `useEffect` timer that triggers re-render when the TTL expires.

## Function Signatures

### `BackgroundTasksDialog({ onDone, toolUseContext, initialDetailTaskId })`

Main dialog for browsing and managing all background tasks.

- **onDone**: `(result?: string, options?: { display?: CommandResultDisplay }) => void` — Callback to close the dialog.
- **toolUseContext**: `ToolUseContext` — Passed through to `RemoteSessionDetailDialog` for rendering messages.
- **initialDetailTaskId**: `string | undefined` — If provided, skips the list and opens detail for this task.

> Source: `src/components/tasks/BackgroundTasksDialog.tsx:127`

### `BackgroundTaskStatus({ tasksSelected, isViewingTeammate, teammateFooterIndex, isLeaderIdle, onOpenDialog })`

Footer status component shown below the prompt.

- **tasksSelected**: `boolean` — Whether the tasks footer item is currently highlighted.
- **isViewingTeammate**: `boolean | undefined` — Whether the user is viewing a teammate's transcript.
- **teammateFooterIndex**: `number` (default `0`) — Index of the selected pill in pill mode.
- **isLeaderIdle**: `boolean` (default `false`) — Whether the team leader is idle.
- **onOpenDialog**: `((taskId?: string) => void) | undefined` — Opens the background tasks dialog.

> Source: `src/components/tasks/BackgroundTaskStatus.tsx:25`

### `BackgroundTask({ task, maxActivityWidth })`

Single-line summary renderer for any background task type.

- **task**: `DeepImmutable<BackgroundTaskState>` — The task state object.
- **maxActivityWidth**: `number` (default `40`) — Maximum character width for the activity text.

> Source: `src/components/tasks/BackgroundTask.tsx:17`

### `TaskStatusText({ status, label, suffix })`

Colored parenthetical status text (e.g., "(done)", "(error)", "(running)").

- **status**: `TaskStatus` — Determines color (`success`, `error`, `warning`, or default).
- **label**: `string | undefined` — Display text; falls back to the raw status string.
- **suffix**: `string | undefined` — Appended inside the parentheses (e.g., ", unread").

> Source: `src/components/tasks/ShellProgress.tsx:13`

### `ShellProgress({ shell })`

Renders status for a shell task using `TaskStatusText`. Maps: completed to "done", failed to "error", killed to "stopped", running/pending to "running".

> Source: `src/components/tasks/ShellProgress.tsx:34`

### `RemoteSessionProgress({ session })`

Progress display for remote agent sessions. Delegates to `ReviewRainbowLine` for ultrareview sessions, otherwise shows plain status text.

> Source: `src/components/tasks/RemoteSessionProgress.tsx:172`

### `formatReviewStageCounts(stage, found, verified, refuted): string`

Formats bug counts for ultrareview display. Shared between pill and detail views to prevent drift.

- **stage**: `ReviewStage | undefined` — Current review stage (`finding`, `verifying`, `synthesizing`).
- Returns stage-appropriate string like `"3 found · 2 verified"` or `"2 verified · deduping"`.

> Source: `src/components/tasks/RemoteSessionProgress.tsx:22`

### `renderToolActivity(activity, tools, theme): React.ReactNode`

Converts a `ToolActivity` to a display node using the tool registry.

> Source: `src/components/tasks/renderToolActivity.tsx:7`

### `formatToolUseSummary(name, input): string`

Compact one-line tool use summary for remote session logs. Special-cases `ExitPlanMode` and `AskUserQuestion` tools.

> Source: `src/components/tasks/RemoteSessionDetailDialog.tsx:44`

### `TeamsDialog({ initialTeams, onDone })`

Dialog for viewing and managing coordinator-mode teammates.

- **initialTeams**: `TeamSummary[] | undefined` — Pre-fetched team data from the caller.
- **onDone**: `() => void` — Callback to close the dialog.

> Source: `src/components/teams/TeamsDialog.tsx:48`

### `TeamStatus({ teamsSelected, showHint })`

Footer status indicator showing teammate count. Returns `null` when there are no teammates.

- **teamsSelected**: `boolean` — Whether this footer item is highlighted.
- **showHint**: `boolean` — Whether to show the "Enter to view" hint.

> Source: `src/components/teams/TeamStatus.tsx:14`

### `TeammateViewHeader()`

Header banner shown when viewing a teammate's transcript. Displays the teammate's colored name, prompt text, and an "esc to return" keyboard hint. Returns `null` when no teammate is being viewed.

> Source: `src/components/TeammateViewHeader.tsx:14`

### `TaskListV2({ tasks, isStandalone })`

Todo-style task list with truncation, owner colors, and activity tracking.

- **tasks**: `Task[]` — Array of task objects from the todo system.
- **isStandalone**: `boolean` (default `false`) — When `true`, renders with a header showing total/done/pending counts.

> Source: `src/components/TaskListV2.tsx:30`

### Status utility functions

- **`isTerminalStatus(status: TaskStatus): boolean`** — `true` for `completed`, `failed`, or `killed`. Source: `src/components/tasks/taskStatusUtils.tsx:16`
- **`getTaskStatusIcon(status, options?): string`** — Returns a `figures` icon character. Source: `src/components/tasks/taskStatusUtils.tsx:23`
- **`getTaskStatusColor(status, options?): 'success' | 'error' | 'warning' | 'background'`** — Returns semantic color. Source: `src/components/tasks/taskStatusUtils.tsx:50`
- **`describeTeammateActivity(t): string`** — Human-readable activity for a teammate. Source: `src/components/tasks/taskStatusUtils.tsx:77`
- **`shouldHideTasksFooter(tasks, showSpinnerTree): boolean`** — Whether the footer should be hidden. Source: `src/components/tasks/taskStatusUtils.tsx:93`

## Type Definitions

### `ListItem` (BackgroundTasksDialog)

A discriminated union with 8 variants representing the task types displayable in the dialog:

| Variant | Type Field | Description |
|---------|-----------|-------------|
| Shell | `local_bash` | Local shell commands or monitors |
| Remote Agent | `remote_agent` | Remote agent sessions (includes ultraplan/ultrareview) |
| Local Agent | `local_agent` | Locally-spawned async agents |
| Teammate | `in_process_teammate` | In-process teammate agents |
| Workflow | `local_workflow` | Ant-only workflow scripts |
| MCP Monitor | `monitor_mcp` | Ant-only MCP monitoring tasks |
| Dream | `dream` | Dream/speculative execution tasks |
| Leader | `leader` | Synthetic entry for the team leader (no task state) |

All variants share `id: string`, `label: string`, `status: string`. Non-leader variants also carry a `task` field with the typed immutable task state.

> Source: `src/components/tasks/BackgroundTasksDialog.tsx:56–103`

### `ViewState`

```typescript
type ViewState = { mode: 'list' } | { mode: 'detail'; itemId: string }
```

> Source: `src/components/tasks/BackgroundTasksDialog.tsx:43–48`

### `DialogLevel` (TeamsDialog)

```typescript
type DialogLevel =
  | { type: 'teammateList'; teamName: string }
  | { type: 'teammateDetail'; teamName: string; memberName: string }
```

> Source: `src/components/teams/TeamsDialog.tsx:36–43`

### Task status icon and color mapping

| Status | Icon | Color |
|--------|------|-------|
| running (active) | play | `background` |
| running (idle) | ellipsis | `background` |
| completed | tick | `success` |
| failed | cross | `error` |
| killed | cross | `warning` |
| awaiting approval | questionMarkPrefix | `warning` |
| has error | cross | `error` |
| shutdown requested | warning | `warning` |

> Source: `src/components/tasks/taskStatusUtils.tsx:23–70`

### `TaskItem` status icons (TaskListV2)

| Status | Icon | Color |
|--------|------|-------|
| completed | `figures.tick` | `success` |
| in_progress | `figures.squareSmallFilled` | `claude` |
| pending | `figures.squareSmall` | `undefined` (default) |

> Source: `src/components/TaskListV2.tsx:220–241`

## Configuration & Defaults

| Constant | Value | Location | Description |
|----------|-------|----------|-------------|
| `SHELL_DETAIL_TAIL_BYTES` | `8192` | `src/components/tasks/ShellDetailDialog.tsx:24` | Shell detail dialog reads only the last 8KB of task output |
| `VISIBLE_TURNS` | `6` | `src/components/tasks/DreamDetailDialog.tsx:21` | Dream detail dialog shows the last 6 conversation turns |
| `RECENT_COMPLETED_TTL_MS` | `30_000` | `src/components/TaskListV2.tsx:21` | Recently-completed tasks remain visible for 30s before truncation |
| `TICK_MS` | `80` | `src/components/tasks/RemoteSessionProgress.tsx:10` | Animation frame interval for rainbow effect |
| Team refresh interval | `1000` ms | `src/components/teams/TeamsDialog.tsx:77–79` | TeamsDialog refreshes teammate statuses every second |
| `maxActivityWidth` default | `40` | `src/components/tasks/BackgroundTask.tsx:23` | Default truncation width for activity text |

## Edge Cases & Caveats

- **Feature-gated components** — `WorkflowDetailDialog` and `MonitorMcpDetailDialog` are conditionally loaded using `feature()` + `require()` to support dead-code elimination in non-ant builds. The same applies to their kill/skip/retry functions (`src/components/tasks/BackgroundTasksDialog.tsx:105–119`).

- **Spinner tree vs. footer** — When the spinner tree (`expandedView === 'teammates'`) is active, in-process teammates are excluded from `BackgroundTasksDialog` and `BackgroundTaskStatus` to avoid duplication. The `shouldHideTasksFooter()` utility governs this logic.

- **Foregrounded task exclusion** — The currently-foregrounded `local_agent` task is excluded from the background tasks dialog since it's already visible in the main UI (`src/components/tasks/BackgroundTasksDialog.tsx:123–126`).

- **`skippedListOnMount` stale-state prevention** — When the dialog opens with a single task (auto-skipping to detail), pressing "back" checks the *current* task count. If more tasks have since appeared, it navigates to the list rather than closing the dialog (`src/components/tasks/BackgroundTasksDialog.tsx:354–365`).

- **Smooth count animation** — `useSmoothCount` in `RemoteSessionProgress` increments displayed counts +1 per animation frame rather than snapping to the target value. It bypasses this when reduced motion is preferred or the clock is frozen (`src/components/tasks/RemoteSessionProgress.tsx:76–86`).

- **Dead `"external" === 'ant'` check** — In `shouldHideTasksFooter()`, the expression `"external" === 'ant'` (line 99 of `taskStatusUtils.tsx`) is a build-time constant that evaluates to `false` in external builds, effectively dead-code-eliminating the panel agent task exclusion logic.

- **`useEffectEvent` for stable `onDone`** — The dialog wraps `onDone` in `useEffectEvent` to get a stable reference that avoids re-triggering the lifecycle effect when the callback identity changes (`src/components/tasks/BackgroundTasksDialog.tsx:324`).

- **Overlay registration** — Both `BackgroundTasksDialog` and `TeamsDialog` register themselves as modal overlays via `useRegisterOverlay()` so parent keybindings (e.g., up/down for history navigation) are deactivated while the dialog is open.

## Key Code Snippets

### Task status icon resolution priority chain

```typescript
if (hasError) return figures.cross;
if (awaitingApproval) return figures.questionMarkPrefix;
if (shutdownRequested) return figures.warning;
if (status === 'running') {
  if (isIdle) return figures.ellipsis;
  return figures.play;
}
if (status === 'completed') return figures.tick;
if (status === 'failed' || status === 'killed') return figures.cross;
return figures.bullet;
```

> Source: `src/components/tasks/taskStatusUtils.tsx:29–44`

### Teammate activity description fallback chain

```typescript
if (t.shutdownRequested) return 'stopping';
if (t.awaitingPlanApproval) return 'awaiting approval';
if (t.isIdle) return 'idle';
return (
  (t.progress?.recentActivities &&
    summarizeRecentActivities(t.progress.recentActivities)) ??
  t.progress?.lastActivity?.activityDescription ??
  'working'
);
```

> Source: `src/components/tasks/taskStatusUtils.tsx:78–82`

### Background tasks dialog detail dispatch

```typescript
switch (task_0.type) {
  case 'local_bash':
    return <ShellDetailDialog shell={task_0} onDone={onDone}
             onKillShell={...} onBack={goBackToList} />;
  case 'local_agent':
    return <AsyncAgentDetailDialog agent={task_0} onDone={onDone}
             onKillAgent={...} onBack={goBackToList} />;
  case 'remote_agent':
    return <RemoteSessionDetailDialog session={task_0} onDone={onDone}
             toolUseContext={...} onBack={goBackToList} onKill={...} />;
  case 'in_process_teammate':
    return <InProcessTeammateDetailDialog teammate={task_0} onDone={onDone}
             onKill={...} onBack={goBackToList} onForeground={...} />;
  // ... workflow, monitor_mcp, dream cases
}
```

> Source: `src/components/tasks/BackgroundTasksDialog.tsx:375–399`

### TaskListV2 prioritized truncation

```typescript
const prioritized = [
  ...recentCompleted, ...inProgress, ...pending, ...olderCompleted
];
visibleTasks = prioritized.slice(0, maxDisplay);
hiddenTasks = prioritized.slice(maxDisplay);
```

> Source: `src/components/TaskListV2.tsx:162–164`

### Review stage counts formatting

```typescript
if (stage === 'synthesizing') {
  const parts = [`${verified} verified`];
  if (refuted > 0) parts.push(`${refuted} refuted`);
  parts.push('deduping');
  return parts.join(' · ');
}
if (stage === 'verifying') {
  const parts = [`${found} found`, `${verified} verified`];
  if (refuted > 0) parts.push(`${refuted} refuted`);
  return parts.join(' · ');
}
return found > 0 ? `${found} found` : 'finding';
```

> Source: `src/components/tasks/RemoteSessionProgress.tsx:25–37`