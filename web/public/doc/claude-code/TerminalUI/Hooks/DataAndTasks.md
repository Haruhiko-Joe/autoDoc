# Data and Tasks Hooks

## Overview & Responsibilities

This module is a collection of 15 React hooks within the **TerminalUI → Hooks** layer of Claude Code. These hooks handle data fetching, task orchestration, and miscellaneous operational side effects that keep the REPL session responsive, informed, and automated. They sit between the UI components (which consume their return values) and the backend services/utilities (which they call into).

The hooks fall into three broad categories:

1. **Diff & Code Change Tracking** — `useDiffData`, `useTurnDiffs`
2. **Task Management** — `useTasksV2`, `useTaskListWatcher`, `useScheduledTasks`
3. **Operational Concerns** — background task navigation, assistant history paging, away summaries, PR status polling, API key verification, issue flag banners, desktop notifications, update notifications, file history snapshots, and skill improvement surveys

## Key Processes

### Git Diff Fetching (`useDiffData`)

On mount, the hook fires two parallel async calls — `fetchGitDiff()` for aggregate stats and `fetchGitDiffHunks()` for per-file structured patch hunks — then merges the results into a single `DiffData` object.

1. Both fetches run concurrently via `Promise.all` (`src/hooks/useDiffData.ts:48-51`)
2. Per-file stats are iterated to classify each file as binary, large (>400 lines with no hunks), truncated, or untracked (`src/hooks/useDiffData.ts:83-104`)
3. Files are sorted alphabetically and returned alongside the raw hunks map
4. A `cancelled` flag prevents state updates if the component unmounts mid-fetch

The underlying git operations are implemented in `src/utils/gitDiff.ts`.

### Turn-Level Diff Computation (`useTurnDiffs`)

Incrementally processes the conversation's `Message[]` array to group file edits by user turn, avoiding reprocessing of already-seen messages.

1. A `useRef` cache tracks completed turns, the current in-progress turn, and the last processed message index (`src/hooks/useTurnDiffs.ts:101-106`)
2. On each render, only new messages (from `lastProcessedIndex` onward) are scanned (`src/hooks/useTurnDiffs.ts:120`)
3. User prompts (non-tool-result, non-meta) start a new turn; tool results with `FileEditOutput` or `FileWriteOutput` accumulate hunks into the current turn (`src/hooks/useTurnDiffs.ts:130-197`)
4. For newly created files (`type === 'create'` with empty `structuredPatch`), a synthetic hunk is generated from the file content (`src/hooks/useTurnDiffs.ts:166-181`)
5. If the message array shrinks (conversation rewind), the cache resets entirely
6. Results are returned in reverse chronological order (most recent turn first)

### TodoV2 Task List Management (`useTasksV2`)

A singleton `TasksV2Store` class implements the `useSyncExternalStore` contract, ensuring all consumers (REPL, Spinner, footer) share one file watcher instead of each creating their own.

1. On first subscriber, the store starts an `fs.watch` on the tasks directory and subscribes to in-process task update events (`src/hooks/useTasksV2.ts:64-69`)
2. File system events are debounced (50ms) before fetching the task list (`src/hooks/useTasksV2.ts:107-111`)
3. Internal tasks (`_internal` metadata) are filtered out (`src/hooks/useTasksV2.ts:118-119`)
4. When all tasks are completed, a 5-second hide timer starts; on expiry, the task list is reset and hidden (`src/hooks/useTasksV2.ts:129-136`, `src/hooks/useTasksV2.ts:154-172`)
5. A fallback poll (every 5s) runs only while incomplete tasks exist, covering cross-process updates that `fs.watch` might miss (`src/hooks/useTasksV2.ts:148-151`)
6. The `useTasksV2WithCollapseEffect` variant additionally collapses the expanded task view in app state when the list becomes hidden

The task reading, writing, and directory management utilities live in `src/utils/tasks.ts`.

### Task Directory Watching & Claiming (`useTaskListWatcher`)

Enables "tasks mode" where Claude watches for externally-created tasks and processes them sequentially.

1. Sets up `fs.watch` on the task list directory, debouncing events by 1 second (`src/hooks/useTaskListWatcher.ts:133-161`)
2. On each check: if the agent is idle and no current task is active, it finds the first `pending` task with no owner and no unresolved blockers (`src/hooks/useTaskListWatcher.ts:197-208`)
3. Claims the task atomically via `claimTask()`, then formats it as a prompt and submits via the `onSubmitTask` callback (`src/hooks/useTaskListWatcher.ts:98-124`)
4. If submission fails, the claim is released immediately
5. Uses refs for `isLoading` and `onSubmitTask` to avoid re-creating the watcher effect on every turn — this prevents a known Bun `PathWatcherManager` deadlock (`src/hooks/useTaskListWatcher.ts:44-49`)

### Cron-Scheduled Task Management (`useScheduledTasks`)

Wraps the `createCronScheduler` utility (from `src/utils/cronScheduler.ts`) for the REPL, routing fired cron tasks to either the lead agent's command queue or to specific teammate agents.

1. On mount, creates a scheduler instance with fire callbacks and starts it (`src/hooks/useScheduledTasks.ts:84-122`)
2. When a task fires with an `agentId`, it looks up the corresponding teammate; if found and running, injects the prompt directly into the teammate (`src/hooks/useScheduledTasks.ts:93-98`)
3. If the target teammate is gone, the orphaned cron is removed to prevent infinite firing (`src/hooks/useScheduledTasks.ts:104-108`)
4. Tasks without an `agentId` are enqueued at `'later'` priority with `isMeta: true` (hidden from transcript) and a `WORKLOAD_CRON` billing attribution (`src/hooks/useScheduledTasks.ts:71-82`)
5. A runtime kill switch (`isKairosCronEnabled()`) is polled every tick to allow mid-session disabling

### Background Task Navigation (`useBackgroundTaskNavigation`)

Handles keyboard shortcuts for navigating between the leader and teammate agents in a swarm.

- **Shift+Up/Down**: Steps through the teammate selection list with wrapping. Index `-1` = leader, `0..n-1` = teammates, `n` = "hide" row. Falls back to opening the background tasks dialog when no teammates exist (`src/hooks/useBackgroundTaskNavigation.ts:181-189`)
- **Enter**: Confirms selection — enters teammate view, exits to leader, or collapses the spinner tree (`src/hooks/useBackgroundTaskNavigation.ts:206-225`)
- **f**: Opens the selected teammate's transcript (`src/hooks/useBackgroundTaskNavigation.ts:192-203`)
- **k**: Kills the selected running teammate (`src/hooks/useBackgroundTaskNavigation.ts:228-239`)
- **Escape**: In viewing mode, aborts the teammate's current work (if running) or exits the view; in selecting mode, exits selection (`src/hooks/useBackgroundTaskNavigation.ts:151-176`)

### Assistant History Paging (`useAssistantHistory`)

Lazy-loads `claude assistant` session history on scroll-up for viewer-only remote sessions.

1. On mount, fetches the latest events page and prepends them to the message list (`src/hooks/useAssistantHistory.ts:144-161`)
2. If content doesn't fill the viewport, chains additional page loads (up to 10) until scrollable (`src/hooks/useAssistantHistory.ts:218-239`)
3. On scroll-up near the top (within 40 rows), triggers `loadOlder()` which fetches the next page via cursor-based pagination (`src/hooks/useAssistantHistory.ts:242-247`)
4. Scroll anchoring: snapshots scroll height before prepending, then compensates via `useLayoutEffect` so the viewport stays in place (`src/hooks/useAssistantHistory.ts:199-208`)
5. A sentinel message at index 0 shows loading state ("loading older messages…", "start of session", or retry prompt)

### Away Summary Generation (`useAwaySummary`)

Appends a "while you were away" summary when the terminal has been blurred for 5 minutes. The summary generation logic is in `src/services/awaySummary.ts`.

1. Subscribes to terminal focus state changes (`src/hooks/useAwaySummary.ts:105`)
2. On blur, starts a 5-minute timer (`src/hooks/useAwaySummary.ts:96`)
3. When the timer fires: if no turn is in progress and no existing away summary exists since the last user message, calls `generateAwaySummary()` and appends the result (`src/hooks/useAwaySummary.ts:69-80`)
4. If a turn is in progress when the timer fires, defers generation until the turn ends (`src/hooks/useAwaySummary.ts:119-124`)
5. On re-focus, cancels the timer and aborts any in-flight summary generation (`src/hooks/useAwaySummary.ts:97-101`)
6. Gated by both a build-time feature flag (`AWAY_SUMMARY`) and a GrowthBook feature flag

### PR Review Status Polling (`usePrStatus`)

Polls `gh` CLI for PR review status every 60 seconds while the session is active. The underlying fetch logic lives in `src/utils/ghPrStatus.ts`.

1. Each poll calls `fetchPrStatus()` and updates state only if the PR number or review state changed (`src/hooks/usePrStatus.ts:49-77`)
2. Tracks interaction time; stops polling after 60 minutes of inactivity (`src/hooks/usePrStatus.ts:52-58`)
3. Permanently disables polling if a single fetch takes >4 seconds (slow `gh` CLI) (`src/hooks/usePrStatus.ts:79-82`)
4. Effect re-runs on `isLoading` changes, restarting the loop; schedule is aligned to the last fetch time to avoid redundant polls at turn boundaries

### API Key Verification (`useApiKeyVerification`)

Manages API key validation state with a lazy verification pattern. The actual key verification call is in `src/services/api/claude.ts`.

1. On initial render, determines status synchronously: skips verification entirely for Claude AI subscribers; checks for an existing key without executing `apiKeyHelper` (security measure); returns `'loading'` if a key source exists but hasn't been verified yet (`src/hooks/useApiKeyVerification.ts:25-40`)
2. `reverify()` warms the `apiKeyHelper` cache, reads the key from all sources, then calls `verifyApiKey()` against the API (`src/hooks/useApiKeyVerification.ts:43-77`)

### File History Snapshot Initialization (`useFileHistorySnapshotInit`)

A one-shot initializer that restores file history state from transcript snapshots when resuming a session.

1. Checks that file history is enabled and hasn't already been initialized (`src/hooks/useFileHistorySnapshotInit.ts:17`)
2. If initial snapshots are provided, calls `fileHistoryRestoreStateFromLog()` from `src/utils/fileHistory.ts` to rebuild state (`src/hooks/useFileHistorySnapshotInit.ts:21-23`)

### Issue Flag Banner Detection (`useIssueFlagBanner`)

Internal-only hook (compile-time gated to `USER_TYPE === 'ant'`) that detects user friction and suggests filing an issue.

1. Scans messages for "friction signals" — patterns like "that's wrong", "try again", "why did you" (`src/hooks/useIssueFlagBanner.ts:27-43`)
2. Checks session container compatibility by verifying no MCP tools or external network commands (curl, ssh, docker, etc.) were used (`src/hooks/useIssueFlagBanner.ts:45-72`)
3. Triggers when: ≥3 submissions, friction detected, container-compatible, and outside a 30-minute cooldown (`src/hooks/useIssueFlagBanner.ts:116-132`)
4. Banner stays visible until the user submits another message

### Desktop Notification After Timeout (`useNotifyAfterTimeout`)

Sends a desktop notification via `src/services/notifier.ts` if the user hasn't interacted within 6 seconds.

1. Resets interaction timestamp immediately on mount to avoid stale timestamps from long-running requests (`src/hooks/useNotifyAfterTimeout.ts:49-51`)
2. Polls every 6 seconds; fires `sendNotification()` once and clears the interval (`src/hooks/useNotifyAfterTimeout.ts:53-63`)

### Update Notification Tracking (`useUpdateNotification`)

Tracks whether a new CLI version is available by comparing semver (major.minor.patch).

1. Initializes `lastNotifiedSemver` from the current `MACRO.VERSION` (`src/hooks/useUpdateNotification.ts:20-22`)
2. When `updatedVersion` differs from the last notified version, returns the new semver string and updates the tracked version (`src/hooks/useUpdateNotification.ts:28-33`)

### Skill Improvement Survey (`useSkillImprovementSurvey`)

Manages the UI state for prompting users to apply AI-suggested skill improvements. The apply logic is in `src/utils/hooks/skillImprovement.ts`.

1. Watches `appState.skillImprovement.suggestion` — opens the survey when a new suggestion arrives (`src/hooks/useSkillImprovementSurvey.ts:37-51`)
2. On apply: writes improvements to the skill file and appends a system message confirming the update (`src/hooks/useSkillImprovementSurvey.ts:72-84`)
3. On dismiss: closes the survey without changes
4. Both paths log analytics events with the skill name routed to a privileged BQ column (`src/hooks/useSkillImprovementSurvey.ts:60-70`)

## Function Signatures & Parameters

### `useDiffData(): DiffData`

Returns the current git diff data. No parameters. Returns `{ stats, files, hunks, loading }`.

### `useTurnDiffs(messages: Message[]): TurnDiff[]`

Extracts per-turn file diffs from the conversation message array. Returns turns in reverse chronological order.

### `useTasksV2(): Task[] | undefined`

Returns the current task list when TodoV2 is enabled and the session is a team lead (or solo). Returns `undefined` when hidden or disabled.

### `useTasksV2WithCollapseEffect(): Task[] | undefined`

Same as `useTasksV2`, plus collapses the expanded task view in app state when the list becomes hidden. Should be called from exactly one always-mounted component.

### `useTaskListWatcher({ taskListId?, isLoading, onSubmitTask }): void`

Watches a task directory for pending tasks and auto-claims/submits them. `onSubmitTask` returns `true` if submission succeeded.

### `useScheduledTasks({ isLoading, assistantMode?, setMessages }): void`

Mounts the cron scheduler for the REPL session. `assistantMode` bypasses the `isLoading` gate for enqueuing.

### `useBackgroundTaskNavigation(options?): { handleKeyDown }`

Returns a `handleKeyDown` handler for keyboard navigation. Optional `onOpenBackgroundTasks` callback fires when Shift+Up/Down is pressed with no teammates but non-teammate background tasks exist.

### `useAssistantHistory({ config, setMessages, scrollRef, onPrepend? }): { maybeLoadOlder }`

Lazy-loads remote session history. Only active when `config.viewerOnly === true`. Returns `maybeLoadOlder(handle)` to compose with scroll handlers.

### `useAwaySummary(messages, setMessages, isLoading): void`

Generates an away summary after 5 minutes of terminal blur. No return value.

### `usePrStatus(isLoading, enabled?): PrStatusState`

Returns `{ number, url, reviewState, lastUpdated }`. Pass `enabled: false` to skip polling.

### `useApiKeyVerification(): ApiKeyVerificationResult`

Returns `{ status, reverify, error }`. Status is one of `'loading' | 'valid' | 'invalid' | 'missing' | 'error'`. Call `reverify()` to re-check the API key.

### `useFileHistorySnapshotInit(initialSnapshots, fileHistoryState, onUpdateState): void`

One-shot initialization: restores file history state from transcript snapshots on first mount. No-op if file history is disabled.

### `useIssueFlagBanner(messages, submitCount): boolean`

Returns `true` when the issue flag banner should display. Only active for internal users (`USER_TYPE === 'ant'`).

### `useNotifyAfterTimeout(message, notificationType): void`

Sends a desktop notification if the user hasn't interacted within 6 seconds.

### `useUpdateNotification(updatedVersion, initialVersion?): string | null`

Returns the new semver string when a version update is detected, or `null` otherwise.

### `useSkillImprovementSurvey(setMessages): { isOpen, suggestion, handleSelect }`

Manages the skill improvement survey UI. `handleSelect` receives a `FeedbackSurveyResponse` — either applies the improvement or dismisses it.

## Interface/Type Definitions

### `DiffFile`

| Field | Type | Description |
|-------|------|-------------|
| path | `string` | File path relative to repo root |
| linesAdded | `number` | Lines added |
| linesRemoved | `number` | Lines removed |
| isBinary | `boolean` | Binary file detected |
| isLargeFile | `boolean` | Too large for hunk display |
| isTruncated | `boolean` | Exceeds 400-line display limit |
| isNewFile? | `boolean` | Newly created file |
| isUntracked? | `boolean` | Not tracked by git |

### `TurnDiff`

| Field | Type | Description |
|-------|------|-------------|
| turnIndex | `number` | Sequential turn number |
| userPromptPreview | `string` | First ~30 chars of user prompt |
| timestamp | `string` | ISO timestamp of the user message |
| files | `Map<string, TurnFileDiff>` | Per-file diff data |
| stats | `{ filesChanged, linesAdded, linesRemoved }` | Aggregate stats for this turn |

### `TurnFileDiff`

| Field | Type | Description |
|-------|------|-------------|
| filePath | `string` | Absolute path to the file |
| hunks | `StructuredPatchHunk[]` | Diff hunks from the `diff` library |
| isNewFile | `boolean` | Whether the file was created in this turn |
| linesAdded | `number` | Total lines added across all edits |
| linesRemoved | `number` | Total lines removed across all edits |

### `PrStatusState`

| Field | Type | Description |
|-------|------|-------------|
| number | `number \| null` | PR number |
| url | `string \| null` | PR URL |
| reviewState | `PrReviewState \| null` | Current review state |
| lastUpdated | `number` | Timestamp of last state change |

### `VerificationStatus`

`'loading' | 'valid' | 'invalid' | 'missing' | 'error'`

### `ApiKeyVerificationResult`

| Field | Type | Description |
|-------|------|-------------|
| status | `VerificationStatus` | Current verification state |
| reverify | `() => Promise<void>` | Trigger re-verification |
| error | `Error \| null` | Error details for `'error'` status |

## Configuration & Defaults

| Constant | Value | Location | Description |
|----------|-------|----------|-------------|
| `MAX_LINES_PER_FILE` | 400 | `src/hooks/useDiffData.ts:10` | Truncation threshold for diff display |
| `HIDE_DELAY_MS` | 5000 | `src/hooks/useTasksV2.ts:16` | Delay before hiding completed task list |
| `DEBOUNCE_MS` (tasks store) | 50 | `src/hooks/useTasksV2.ts:17` | FS event debounce for task list |
| `FALLBACK_POLL_MS` | 5000 | `src/hooks/useTasksV2.ts:18` | Fallback poll interval for incomplete tasks |
| `DEBOUNCE_MS` (watcher) | 1000 | `src/hooks/useTaskListWatcher.ts:14` | FS event debounce for task watcher |
| `BLUR_DELAY_MS` | 300000 | `src/hooks/useAwaySummary.ts:12` | 5 minutes before away summary triggers |
| `POLL_INTERVAL_MS` | 60000 | `src/hooks/usePrStatus.ts:5` | PR status polling interval |
| `SLOW_GH_THRESHOLD_MS` | 4000 | `src/hooks/usePrStatus.ts:6` | Disables PR polling if `gh` is slow |
| `IDLE_STOP_MS` | 3600000 | `src/hooks/usePrStatus.ts:7` | Stops PR polling after 60 min idle |
| `PREFETCH_THRESHOLD_ROWS` | 40 | `src/hooks/useAssistantHistory.ts:38` | Scroll-up distance to trigger history load |
| `MAX_FILL_PAGES` | 10 | `src/hooks/useAssistantHistory.ts:42` | Max chained page loads to fill viewport |
| `DEFAULT_INTERACTION_THRESHOLD_MS` | 6000 | `src/hooks/useNotifyAfterTimeout.ts:9` | Idle threshold for desktop notification |
| `MIN_SUBMIT_COUNT` | 3 | `src/hooks/useIssueFlagBanner.ts:89` | Minimum submissions before banner can appear |
| `COOLDOWN_MS` | 1800000 | `src/hooks/useIssueFlagBanner.ts:90` | 30-minute cooldown between banner triggers |

## Edge Cases & Caveats

- **`useTurnDiffs` cache reset**: If `messages.length` shrinks (e.g., conversation rewind), the entire incremental cache is discarded and rebuilt from scratch (`src/hooks/useTurnDiffs.ts:112-117`).

- **`useTaskListWatcher` Bun deadlock avoidance**: `isLoading` and `onSubmitTask` are accessed via refs rather than as effect dependencies. This prevents the watcher effect from re-running every turn, which would cause `watcher.close()` + `watch()` churn that triggers a known Bun `PathWatcherManager` deadlock (oven-sh/bun#27469).

- **`useTasksV2` task list ID changes**: The store detects when the task list ID changes mid-session (e.g., when a team is created) and re-points the file watcher at the new directory. The hide timer also verifies the task list ID hasn't changed before resetting.

- **`usePrStatus` auto-disable**: If a single `gh` CLI call takes over 4 seconds, polling is permanently disabled for the session to avoid UI stalls.

- **`useAssistantHistory` is no-op for non-viewer sessions**: The hook checks `config?.viewerOnly === true` and short-circuits entirely otherwise. It's additionally gated by a feature flag at the call site.

- **`useAwaySummary` terminal focus detection**: If the terminal doesn't support DECSET 1004 focus reporting, the focus state is `'unknown'` and the hook does nothing.

- **`useIssueFlagBanner` internal-only**: Guarded by compile-time `process.env.USER_TYPE !== 'ant'` check; returns `false` immediately for external users.

- **`useApiKeyVerification` security**: On initial render, the hook skips executing `apiKeyHelper` to prevent potential RCE via malicious `settings.json` before the trust dialog is shown. The helper is only executed when `reverify()` is explicitly called.

- **`useNotifyAfterTimeout` interaction reset**: Resets the interaction timestamp immediately on mount (not deferred to `useEffect` callback) to prevent stale timestamps from triggering premature notifications after long-running requests.

- **`useScheduledTasks` orphan cleanup**: When a cron task fires for a teammate agent that no longer exists, the cron is automatically removed to prevent infinite firing on every tick.

- **`useBackgroundTaskNavigation` backward-compat bridge**: The hook currently subscribes via `useInput` and adapts `InputEvent` → `KeyboardEvent` because the REPL doesn't yet wire `handleKeyDown` to `<Box onKeyDown>`. This bridge is marked for removal in a future PR (`src/hooks/useBackgroundTaskNavigation.ts:245-248`).