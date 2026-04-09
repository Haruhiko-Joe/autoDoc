# UIState — Low-Level Hooks for Terminal UI

## Overview & Responsibilities

The UIState module is a collection of low-level React hooks that power the terminal UI's rendering and state management. Sitting within **TerminalUI → Hooks**, these hooks provide foundational capabilities consumed by higher-level components and screens: animation timing, layout measurement, scroll virtualization, throttled display, transcript recording, and resource monitoring.

Each hook is a self-contained unit focused on a single concern. Together they form the infrastructure layer that lets the rest of the terminal UI remain declarative while handling the imperative realities of terminal rendering — blink cursors, elapsed timers, virtual scrolling through thousands of messages, and memory pressure detection.

---

## Key Processes

### Animation & Timing

Three hooks manage time-based UI behavior:

1. **`useBlink`** drives synchronized cursor/indicator blinking. All instances share one animation clock, so multiple blinking elements stay in phase. The clock pauses when the terminal loses focus (`useTerminalFocus()`) or when no subscribers are visible, saving CPU.

2. **`useElapsedTime`** provides a live-updating formatted duration string. It uses `useSyncExternalStore` with a `setInterval`-based subscription — when `isRunning` is false the interval is never created, so completed tasks have zero overhead. The `endTime` parameter freezes the displayed duration so a 2-minute task still reads "2m" hours later.

3. **`useTimeout`** is a minimal boolean timer: `false` until `delay` ms elapse, then `true`. The `resetTrigger` parameter allows callers to restart the timer without changing the delay.

### Virtual Scrolling Pipeline

`useVirtualScroll` is the most complex hook. It keeps memory bounded in long sessions by mounting only items near the viewport:

1. **Subscribe** — `useSyncExternalStore` watches the ScrollBox. The snapshot is quantized to 40-row bins so most wheel ticks skip React entirely.
2. **Compute offsets** — A `Float64Array` of cumulative item heights is rebuilt lazily from the height cache (real Yoga heights) and `DEFAULT_ESTIMATE` (3 rows) for unmeasured items.
3. **Determine range** — Three paths: cold-start (tail 30), sticky-scroll (walk back from end), or free-scroll (binary search + pessimistic coverage).
4. **Cap mounts** — A slide-step limit (25 items/commit) prevents multi-hundred-ms React blocks during fast scrolling. `useDeferredValue` time-slices expensive fresh mounts.
5. **Measure** — A `useLayoutEffect` reads Yoga `computedHeight` from mounted items after each commit, populating the cache without extra renders.
6. **Resize** — When columns change, cached heights are scaled by `oldCols/newCols` (not cleared) and the range is frozen for 2 renders to avoid mount churn.

### Transcript Recording

`useLogMessages` incrementally records messages to disk:

1. Detects whether the new `messages` array is an incremental append, a compaction (first UUID changed), or a same-head shrink.
2. Slices only new messages and passes them to `recordTranscript()` fire-and-forget, avoiding O(n) rescans on every render (~20 per turn).
3. Chains parent UUIDs for transcript linking, using a `callSeqRef` guard to prevent stale async `.then()` callbacks from overwriting fresher sync updates.

---

## Hooks Reference

### `useBlink` — Synchronized Blink Animation

**File:** `src/hooks/useBlink.ts`

```ts
function useBlink(
  enabled: boolean,
  intervalMs?: number  // default: 600
): [ref: (element: DOMElement | null) => void, isVisible: boolean]
```

**How it works:**

1. Reads terminal focus state via `useTerminalFocus()` (`src/hooks/useBlink.ts:26`)
2. Subscribes to a shared animation clock via `useAnimationFrame()` — the clock only ticks when at least one subscriber is visible
3. Derives blink state from the clock: `Math.floor(time / intervalMs) % 2 === 0` (`src/hooks/useBlink.ts:32`)

All `useBlink` instances synchronize because they read from the same animation clock. When `enabled` is false or the terminal is blurred, the hook short-circuits and returns `isVisible: true` (always visible, no blinking).

**Usage:** Attach the returned `ref` to the animated element's root `Box`. The `isVisible` boolean toggles between `true`/`false` at the blink interval.

---

### `useElapsedTime` — Formatted Duration Timer

**File:** `src/hooks/useElapsedTime.ts`

```ts
function useElapsedTime(
  startTime: number,      // Unix timestamp in ms
  isRunning: boolean,
  ms?: number,            // update interval, default: 1000
  pausedMs?: number,      // paused duration to subtract, default: 0
  endTime?: number        // freezes duration at this timestamp
): string
```

Uses `useSyncExternalStore` with an interval-based subscription (`src/hooks/useElapsedTime.ts:27-34`). When `isRunning` is false, no interval is created — zero overhead for completed tasks. The `endTime` parameter prevents stale display: without it, viewing a 2-minute task 30 minutes after completion would show "32m".

The actual formatting is delegated to `formatDuration()` from `src/utils/format.ts`.

---

### `useTerminalSize` — Terminal Dimensions

**File:** `src/hooks/useTerminalSize.ts`

```ts
function useTerminalSize(): TerminalSize
```

A thin wrapper around `useContext(TerminalSizeContext)`. Throws if called outside of an Ink `App` component tree. The `TerminalSize` type and context are defined in `src/ink/components/TerminalSizeContext.tsx`.

---

### `useVirtualScroll` — Virtual Scrolling Engine

**File:** `src/hooks/useVirtualScroll.ts`

Implements React-level virtualization for items inside a `ScrollBox`, mounting only items within the viewport plus overscan. At ~250 KB RSS per `MessageRow`, a 1000-message session without virtualization costs ~250 MB of grow-only memory.

```ts
function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  columns: number
): VirtualScrollResult
```

#### Return type (`VirtualScrollResult`)

| Field | Type | Description |
|-------|------|-------------|
| `range` | `[number, number]` | Half-open `[start, end)` slice of items to render |
| `topSpacer` | `number` | Height (rows) of spacer before first rendered item |
| `bottomSpacer` | `number` | Height (rows) of spacer after last rendered item |
| `measureRef` | `(key) => ref` | Callback ref factory — attach to each item's root `Box` to cache its Yoga height |
| `spacerRef` | `RefObject` | Attach to the topSpacer `Box` to track list origin |
| `offsets` | `ArrayLike<number>` | Cumulative y-offset of each item; `offsets[n]` = total height |
| `getItemTop` | `(index) => number` | Read Yoga `computedTop` for an item; returns -1 if unmounted |
| `getItemElement` | `(index) => DOMElement \| null` | Get the mounted DOM element for an item |
| `getItemHeight` | `(index) => number \| undefined` | Read cached Yoga height; undefined if unmeasured |
| `scrollToIndex` | `(i) => void` | Scroll so item `i` enters the mounted range |

#### Key constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_ESTIMATE` | 3 | Estimated row height for unmeasured items (intentionally low) |
| `OVERSCAN_ROWS` | 80 | Extra rows rendered above/below viewport |
| `COLD_START_COUNT` | 30 | Items rendered before ScrollBox first layout |
| `SCROLL_QUANTUM` | 40 | `scrollTop` quantization bin size for re-render gating |
| `PESSIMISTIC_HEIGHT` | 1 | Worst-case height for coverage calculations |
| `MAX_MOUNTED_ITEMS` | 300 | Hard cap on mounted items |
| `SLIDE_STEP` | 25 | Max new items to mount per commit during fast scroll |

#### Edge Cases & Caveats

- **Mounted-but-unmeasured guard**: Items in the one-render window between mount and `useLayoutEffect` measurement are not unmounted, preventing spacer flicker (`src/hooks/useVirtualScroll.ts:417-428`).
- **Clamp bounds**: `setClampBounds` on the ScrollBox prevents burst scroll calls from racing past mounted content into blank spacer (`src/hooks/useVirtualScroll.ts:591-597`).
- **Unmount capture**: The callback ref captures Yoga height at unmount time (before WASM release) so the height cache stays accurate (`src/hooks/useVirtualScroll.ts:660-668`).
- **Sticky-scroll**: `render-node-to-output` may set `scrollTop=maxScroll` during Ink's render phase without firing `ScrollBox.subscribe`. The `isSticky` flag handles this — when pinned to the bottom, the tail items are always rendered regardless of `scrollTop` (`src/hooks/useVirtualScroll.ts:331-340`).

---

### `useMinDisplayTime` — Minimum Display Time Throttle

**File:** `src/hooks/useMinDisplayTime.ts`

Ensures each distinct value is displayed for at least `minMs` milliseconds before being replaced. Prevents fast-cycling progress text from flickering.

```ts
function useMinDisplayTime<T>(value: T, minMs: number): T
```

Tracks when the last value was shown. If `minMs` has elapsed, the new value is applied immediately. Otherwise, a `setTimeout` delays the update by the remaining time (`src/hooks/useMinDisplayTime.ts:14-31`). Unlike debounce (waits for quiet) or throttle (limits rate), this guarantees each value gets its minimum screen time.

---

### `useTimeout` — Simple Timeout State

**File:** `src/hooks/useTimeout.ts`

Returns a boolean that becomes `true` after `delay` milliseconds.

```ts
function useTimeout(delay: number, resetTrigger?: number): boolean
```

The timer resets whenever `delay` or `resetTrigger` changes (`src/hooks/useTimeout.ts:6-11`). Useful for showing delayed UI elements (e.g., "still loading" indicators after a threshold).

---

### `useAfterFirstRender` — Startup Time Measurement

**File:** `src/hooks/useAfterFirstRender.ts`

A diagnostic hook that measures startup time. On first render (via `useEffect(…, [])`), if `USER_TYPE=ant` and `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` is truthy, it writes the process uptime to stderr and exits (`src/hooks/useAfterFirstRender.ts:6-15`).

This is an internal-only benchmarking tool — it has no effect for external users.

---

### `useLogMessages` — Transcript Recording

**File:** `src/hooks/useLogMessages.ts`

Records conversation messages to a persistent transcript file, handling incremental appends, compaction events, and agent swarm participants.

```ts
function useLogMessages(messages: Message[], ignore?: boolean): void
```

#### Key design decisions

1. **Incremental tracking** — Maintains `lastRecordedLengthRef` and `firstMessageUuidRef` to detect whether messages were appended (incremental), compacted (first UUID changed), or shrunk (same head, shorter array) (`src/hooks/useLogMessages.ts:42-57`).

2. **Slicing** — Only passes new messages to `recordTranscript()`, avoiding O(n) rescans on every `setMessages` call (~20 per turn). For compaction/full-array cases, passes the entire array since `recordTranscript`'s dedup loop handles interleaving (`src/hooks/useLogMessages.ts:64-65`).

3. **Swarm support** — When agent swarms are enabled, passes `teamName` and `agentName` from `teamContext` to the transcript recorder (`src/hooks/useLogMessages.ts:70-76`).

4. **Parent UUID chaining** — Tracks the UUID of the last recorded message for parent-hint linking. Uses sync-walk for incremental/first-render/same-head-shrink cases, and async `.then()` for compaction cases. A `callSeqRef` guards against stale async callbacks overwriting fresher sync updates (`src/hooks/useLogMessages.ts:68-113`).

5. **Fire-and-forget** — `recordTranscript` is called without awaiting to avoid blocking the UI.

#### Edge Cases

- Uses `cleanMessagesForLogging()` (which applies the `isLoggableMessage` filter and REPL-strip transforms) to find the correct last UUID, matching exactly what reaches disk (`src/hooks/useLogMessages.ts:110`).
- The `ignore` flag suppresses recording entirely (used for secondary/background sessions).

---

### `useMemoryUsage` — Heap Memory Monitoring

**File:** `src/hooks/useMemoryUsage.ts`

Polls Node.js heap memory every 10 seconds and returns a status when usage exceeds thresholds.

```ts
function useMemoryUsage(): MemoryUsageInfo | null
```

**Types:**
```ts
type MemoryUsageStatus = 'normal' | 'high' | 'critical'
type MemoryUsageInfo = { heapUsed: number; status: MemoryUsageStatus }
```

**Thresholds:**
| Status | Threshold |
|--------|-----------|
| `high` | ≥ 1.5 GB |
| `critical` | ≥ 2.5 GB |

Returns `null` when status is `'normal'` — this avoids re-rendering the Notifications subtree every 10 seconds for the vast majority of users who never approach 1.5 GB (`src/hooks/useMemoryUsage.ts:29-33`).

---

### `useMoreRight` — Overflow Indicator (Stub)

**File:** `src/moreright/useMoreRight.tsx`

An external-build stub for an internal-only hook. The real implementation provides an overflow indicator for content that extends beyond the visible area. The stub is a no-op: `onBeforeQuery` returns `true`, `onTurnComplete` is empty, and `render` returns `null`.

```ts
function useMoreRight(args: {
  enabled: boolean
  setMessages: (action: M[] | ((prev: M[]) => M[])) => void
  inputValue: string
  setInputValue: (s: string) => void
  setToolJSX: (args: M) => void
}): {
  onBeforeQuery: (input: string, all: M[], n: number) => Promise<boolean>
  onTurnComplete: (all: M[], aborted: boolean) => Promise<void>
  render: () => null
}
```

The hook integrates into the query lifecycle via `onBeforeQuery` and `onTurnComplete` callbacks. In external builds, these are pass-through stubs.