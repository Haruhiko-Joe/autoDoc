# Ultraplan

## Overview & Responsibilities

The Ultraplan module provides two core utilities that power the `/ultraplan` directive in Claude Code. It sits within **Infrastructure > CoreUtilities > DomainHelpers** and is consumed by the command layer (`commands/ultraplan.tsx`), the prompt input UI (`PromptInput.tsx`), the user input processing pipeline (`processUserInput.ts`), and the remote agent task system (`RemoteAgentTask`).

The module has two distinct responsibilities:

1. **Keyword detection** — Identifies when the user types "ultraplan" (or "ultrareview") in their prompt, carefully filtering out false positives from code paths, quoted strings, and slash commands.
2. **CCR session polling** — Monitors a Claude Code Remote session for the completion of a plan, extracting the approved plan text from `ExitPlanMode` tool results.

## Key Processes

### Keyword Detection Flow (`keyword.ts`)

The keyword detector determines whether a user's input text contains a triggerable "ultraplan" or "ultrareview" keyword. It uses a multi-stage filter to avoid false positives:

1. **Early exits**: If the text doesn't contain the keyword at all (case-insensitive), or starts with `/` (slash command), return immediately with no matches (`keyword.ts:51-52`).

2. **Quoted range scanning**: Walk the entire input character-by-character, tracking paired delimiters — backticks, double quotes, angle brackets (tag-like only), curly braces, square brackets, parentheses, and smart single quotes (apostrophe-aware). Build an array of `{start, end}` ranges to exclude (`keyword.ts:53-76`).

3. **Word-boundary matching**: Run `\bultraplan\b` (case-insensitive, global) against the text. For each match, discard it if:
   - It falls inside a quoted range (`keyword.ts:85`)
   - It's preceded/followed by `/`, `\`, or `-` (path or CLI flag context) (`keyword.ts:87-89`)
   - It's followed by `?` (question about the feature) (`keyword.ts:89-90`)
   - It's followed by `.` + word character (file extension like `ultraplan.tsx`) (`keyword.ts:91`)

4. Surviving matches are returned as `TriggerPosition[]` with `{word, start, end}`, the same shape used by `findThinkingTriggerPositions` so the `PromptInput` component can treat both trigger types uniformly.

**`replaceUltraplanKeyword`** performs a secondary transformation: it replaces the first triggerable "ultraplan" with just "plan" (preserving casing), so the forwarded prompt stays grammatical — e.g., "please ultraplan this" becomes "please plan this" (`keyword.ts:120-127`).

### CCR Session Polling Flow (`ccrSession.ts`)

Once an ultraplan session is launched on CCR, the local CLI polls for completion. The flow is orchestrated by `pollForApprovedExitPlanMode`:

1. **Poll loop**: Every 3 seconds (`POLL_INTERVAL_MS`), call `pollRemoteSessionEvents(sessionId, cursor)` to fetch new `SDKMessage[]` events from the remote session (`ccrSession.ts:224`).

2. **Event ingestion**: Feed new events into the `ExitPlanModeScanner`, a pure stateful classifier. The scanner tracks:
   - `tool_use` blocks with name `ExitPlanMode` (the remote calls this when the plan is ready)
   - `tool_result` blocks matching those tool IDs (approval/rejection/teleport)
   - `result` events with non-success subtypes (session termination)

3. **Verdict resolution** (precedence: approved > teleport > terminated > rejected > pending > unchanged):
   - **approved**: The `tool_result` has `is_error !== true` — extract the plan from `## Approved Plan:` marker
   - **teleport**: The `tool_result` is an error containing the `__ULTRAPLAN_TELEPORT_LOCAL__` sentinel — user clicked "teleport back to terminal" in the browser; extract the plan after the sentinel
   - **rejected**: The `tool_result` is an error without the teleport sentinel — user rejected the plan in the browser; track the rejection and continue polling for a revised plan
   - **pending**: An `ExitPlanMode` `tool_use` exists with no `tool_result` yet — the approval dialog is showing
   - **terminated**: A non-success `result` event arrived — the remote session died

4. **Phase tracking**: The poll loop computes a `UltraplanPhase` (`running` | `needs_input` | `plan_ready`) from the scanner state and session status. Phase changes are reported via the `onPhaseChange` callback, which drives the UI pill/detail-view in the terminal (`ccrSession.ts:286-295`).

5. **Error handling**: Transient network errors are tolerated up to 5 consecutive failures (`MAX_CONSECUTIVE_FAILURES`). Beyond that, or on non-transient errors, the poll throws `UltraplanPollError` with a categorized `PollFailReason` (`ccrSession.ts:229-241`).

## Function Signatures

### `findUltraplanTriggerPositions(text: string): TriggerPosition[]`
Returns all triggerable positions of "ultraplan" in the input text, filtering out quoted/path/question contexts.
> `keyword.ts:97-99`

### `findUltrareviewTriggerPositions(text: string): TriggerPosition[]`
Same as above but for the "ultrareview" keyword.
> `keyword.ts:101-105`

### `hasUltraplanKeyword(text: string): boolean`
Convenience check — returns `true` if any trigger positions exist.
> `keyword.ts:107-109`

### `hasUltrareviewKeyword(text: string): boolean`
Convenience check for "ultrareview".
> `keyword.ts:111-113`

### `replaceUltraplanKeyword(text: string): string`
Replaces the first triggerable "ultraplan" with "plan" (preserving the user's casing of the "plan" suffix). Returns empty string if the text is only the keyword.
> `keyword.ts:120-127`

### `pollForApprovedExitPlanMode(sessionId, timeoutMs, onPhaseChange?, shouldStop?): Promise<PollResult>`
Main polling function. Resolves when the remote plan is approved or teleported; throws `UltraplanPollError` on timeout, termination, or network failure.

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | `string` | CCR session ID to poll |
| `timeoutMs` | `number` | Maximum time to wait before throwing timeout error |
| `onPhaseChange` | `(phase: UltraplanPhase) => void` | Optional callback for UI phase updates |
| `shouldStop` | `() => boolean` | Optional early-termination predicate (checked each tick) |

**Returns** `PollResult`:
- `plan: string` — the extracted plan text
- `rejectCount: number` — how many times the user rejected before approving
- `executionTarget: 'local' | 'remote'` — `'remote'` for in-browser approval, `'local'` for teleport-back

> `ccrSession.ts:198-306`

## Type Definitions

### `TriggerPosition`
```ts
type TriggerPosition = { word: string; start: number; end: number }
```
Position of a keyword match in the input text. `word` preserves the user's original casing.

### `PollFailReason`
Union of failure categories for `UltraplanPollError`:

| Value | Meaning |
|-------|---------|
| `'terminated'` | Remote session ended before plan approval |
| `'timeout_pending'` | Timeout reached; an ExitPlanMode was seen but never approved |
| `'timeout_no_plan'` | Timeout reached; ExitPlanMode was never called at all |
| `'extract_marker_missing'` | Approved tool_result lacked the expected plan marker |
| `'network_or_unknown'` | Persistent network errors or unknown failure |
| `'stopped'` | The `shouldStop` predicate returned true |

### `ScanResult`
Discriminated union returned by `ExitPlanModeScanner.ingest()`:

| Kind | Fields | Meaning |
|------|--------|---------|
| `'approved'` | `plan: string` | Plan was approved by the user |
| `'teleport'` | `plan: string` | User clicked "teleport back to terminal" |
| `'rejected'` | `id: string` | User rejected this plan iteration |
| `'pending'` | — | ExitPlanMode called but no user response yet |
| `'terminated'` | `subtype: string` | Remote session died (error subtype attached) |
| `'unchanged'` | — | No new state change |

### `UltraplanPhase`
UI phase for the terminal pill display: `'running' | 'needs_input' | 'plan_ready'`

## Configuration & Defaults

| Constant | Value | Purpose |
|----------|-------|---------|
| `POLL_INTERVAL_MS` | `3000` (3s) | Interval between remote session polls |
| `MAX_CONSECUTIVE_FAILURES` | `5` | Transient network errors tolerated before aborting |
| `ULTRAPLAN_TELEPORT_SENTINEL` | `'__ULTRAPLAN_TELEPORT_LOCAL__'` | Marker string in browser rejection feedback indicating a teleport-back request |

## Edge Cases & Caveats

- **Apostrophe handling in keyword detection**: Single quotes are only treated as delimiters when preceded by a non-word character and followed by a non-word character. This means `"let's ultraplan it's"` correctly triggers, while `'ultraplan'` (quoted) does not (`keyword.ts:22-23, 65, 70`).

- **Angle bracket filtering**: Only `<` followed by a letter or `/` starts a quoted range — this prevents math expressions like `n < 5 ultraplan n > 10` from being treated as a "quoted" region (`keyword.ts:69`).

- **Slash command bypass**: Text starting with `/` returns zero triggers immediately. This prevents the keyword detector from highlighting "ultraplan" in prompts like `/rename ultraplan foo`, which are slash commands routed to a different handler (`keyword.ts:52`).

- **replaceUltraplanKeyword on keyword-only input**: If removing "ultraplan" leaves only whitespace, it returns an empty string rather than whitespace (`keyword.ts:125`).

- **Batch ordering in scanner**: A single `ingest()` call may contain both an approval and a subsequent session termination (e.g., user approved, then the remote crashed). The scanner gives precedence to approval — the plan is real and already in threadstore (`ccrSession.ts:74-78`).

- **`result(success)` is not termination**: CCR fires `result(success)` after every turn. The scanner only treats non-success subtypes (`error_during_execution`, `error_max_turns`, etc.) as termination, allowing multi-turn plan refinement where the remote asks clarifying questions (`ccrSession.ts:119-127`).

- **Quiet idle detection**: The poll only reports `needs_input` phase when the session is idle/requires_action AND no new events arrived in that poll cycle. This prevents false `needs_input` flickers during CCR's brief idle gaps between tool turns (`ccrSession.ts:283-285`).

- **Teleport vs. rejection distinction**: Both arrive as `is_error === true` tool results. The scanner checks for the `__ULTRAPLAN_TELEPORT_LOCAL__` sentinel to distinguish a teleport-back request from a normal plan rejection (`ccrSession.ts:148-153`).