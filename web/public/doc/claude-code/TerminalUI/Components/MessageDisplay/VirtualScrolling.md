# VirtualScrolling

## Overview & Responsibilities

The VirtualScrolling module provides the efficient scrolling infrastructure for Claude Code's fullscreen message list. It sits within the **TerminalUI → Components → MessageDisplay** hierarchy, responsible for rendering potentially thousands of conversation messages without materializing them all in the DOM.

The module consists of two components:

- **`VirtualMessageList`** (`src/components/VirtualMessageList.tsx`) — A windowed rendering container that only mounts messages within (and slightly beyond) the visible viewport. It also implements transcript search with match highlighting, keyboard-driven navigation (cursor and jump), and a sticky user-prompt header that tracks the last prompt scrolled above the viewport.

- **`OffscreenFreeze`** (`src/components/OffscreenFreeze.tsx`) — A lightweight wrapper that freezes React subtrees once they scroll into terminal scrollback, preventing timer-driven content (spinners, elapsed counters) from triggering expensive full-terminal resets.

## Key Processes

### Windowed Rendering Flow

1. `VirtualMessageList` receives the full `messages` array and delegates viewport calculation to the `useVirtualScroll` hook (`src/hooks/useVirtualScroll.ts`), which returns a `[start, end]` range, spacer heights, and measurement utilities (`src/components/VirtualMessageList.tsx:325-336`)
2. Only messages in the `[start, end)` window are rendered via `.slice(start, end).map(...)`. A top spacer `<Box height={topSpacer}>` and optional bottom spacer fill the space occupied by unmounted items (`src/components/VirtualMessageList.tsx:857-868`)
3. Each item is wrapped in a `VirtualItem` component that attaches a `measureRef` callback for height measurement, hover/click handlers, and the expanded background style (`src/components/VirtualMessageList.tsx:197-288`)
4. An incremental key array avoids O(n) rebuilds on every streaming append — new keys are pushed only for newly appended messages; a full rebuild triggers only on compaction, `/clear`, or key-function change (`src/components/VirtualMessageList.tsx:308-324`)

### Transcript Search Flow (JumpHandle)

The `JumpHandle` imperative handle exposes search operations consumed by the REPL's search bar:

1. **`warmSearchIndex()`** — Pre-extracts and caches lowered search text for every message in chunked batches of 500, yielding between chunks to keep the UI responsive. Returns elapsed ms for "indexed in Xms" display (`src/components/VirtualMessageList.tsx:797-816`)
2. **`setSearchQuery(q)`** — Scans all messages with `indexOf` on pre-lowered text, building a deduplicated `matches[]` array (message indices) and a `prefixSum[]` for global occurrence counting. Finds the nearest match to the current scroll anchor, then calls `jump()` to navigate there (`src/components/VirtualMessageList.tsx:702-779`)
3. **`nextMatch()` / `prevMatch()`** — Calls `step(±1)` which advances `screenOrd` within the current message's positions. When positions are exhausted, it advances `ptr` to the next matched message and calls `jump()` to scroll + re-scan. Wraparound detection prevents infinite loops when all messages are "phantoms" (engine matched but render didn't) (`src/components/VirtualMessageList.tsx:650-694`)
4. **Two-phase seek** — `jump()` scrolls to the target message (precise `scrollTo` if mounted, `scrollToIndex` if not), arms a `scanRequestRef`, and bumps `seekGen`. A `useEffect` keyed on `seekGen` fires post-paint, finds the mounted element, calls `scanElement()` to get `MatchPosition[]`, then calls `highlight()` to position the yellow current-match indicator (`src/components/VirtualMessageList.tsx:538-605`)
5. **`setAnchor()` / `disarmSearch()`** — `setAnchor` captures the current `scrollTop` so that zero-match queries snap back (vim/less-style incremental search). `disarmSearch` clears highlight positions when the user manually scrolls away

### Sticky Prompt Tracking

The `StickyTracker` component subscribes to scroll events at fine granularity (every tick, not quantized) and determines the last user prompt that scrolled above the viewport:

1. Uses `useSyncExternalStore` to subscribe to the ScrollBox's scroll position, encoding sticky state in the sign bit for change detection (`src/components/VirtualMessageList.tsx:916-922`)
2. Walks backward through the mounted range to find `firstVisible` — the first item at or below the viewport top (`src/components/VirtualMessageList.tsx:934-943`)
3. Scans backward from `firstVisible` for the nearest user prompt via `stickyPromptText()`, which extracts text from `NormalizedUserMessage` or `queued_command` attachments, stripping `<system-reminder>` blocks (`src/components/VirtualMessageList.tsx:133-160`)
4. Writes a `StickyPrompt` (collapsed first paragraph, capped at 500 chars) to `ScrollChromeContext` for `FullscreenLayout` to render as a header. The `scrollTo` callback handles click-to-jump with a two-phase correction for unmounted items (`src/components/VirtualMessageList.tsx:1027-1053`)

### OffscreenFreeze Mechanism

1. `OffscreenFreeze` wraps children in a `<Box ref>` and uses `useTerminalViewport()` to detect whether the box is within the visible terminal viewport (`src/components/OffscreenFreeze.tsx:31-33`)
2. A `useRef` caches the last-rendered children. When the box is visible (or inside a virtual list), the cache updates to the current children. When offscreen, the stale cached reference is returned (`src/components/OffscreenFreeze.tsx:34-41`)
3. React's reconciler bails on identical element references, so the frozen subtree produces zero diff — no re-renders, no layout work, no terminal resets from timer-tick content
4. The `'use no memo'` directive opts out of React Compiler memoization, which would defeat the freeze by stabilizing the children reference (`src/components/OffscreenFreeze.tsx:28`)
5. When inside a `VirtualMessageList` (detected via `InVirtualListContext`), freezing is disabled — the ScrollBox clips within the viewport so there's no scrollback to freeze, and freezing would break click-to-expand interactions (`src/components/OffscreenFreeze.tsx:39`)

## Function Signatures

### `VirtualMessageList(props: Props): React.ReactNode`

The main virtualized list component.

| Prop | Type | Description |
|------|------|-------------|
| `messages` | `RenderableMessage[]` | Full ordered message array |
| `scrollRef` | `RefObject<ScrollBoxHandle>` | Reference to the parent ScrollBox |
| `columns` | `number` | Terminal width — invalidates height cache on change |
| `itemKey` | `(msg) => string` | Stable key extractor per message |
| `renderItem` | `(msg, index) => ReactNode` | Render function for each message |
| `onItemClick` | `(msg) => void` | Click handler (toggle verbose) |
| `isItemClickable` | `(msg) => boolean` | Filter for which messages respond to hover/click |
| `isItemExpanded` | `(msg) => boolean` | Controls persistent grey background |
| `extractSearchText` | `(msg) => string` | Pre-lowered search text extractor (defaults to `renderableSearchText`) |
| `trackStickyPrompt` | `boolean` | Enable sticky prompt header tracking |
| `selectedIndex` | `number` | Currently cursor-selected message index |
| `cursorNavRef` | `React.Ref<MessageActionsNav>` | Imperative handle for cursor navigation (↑/↓/shift+↑) |
| `setCursor` | `(state) => void` | Callback to update cursor selection state |
| `jumpRef` | `RefObject<JumpHandle>` | Imperative handle for search/jump operations |
| `onSearchMatchesChange` | `(count, current) => void` | Badge update callback ("3/47" display) |
| `scanElement` | `(el) => MatchPosition[]` | Render-accurate position scanner for highlight |
| `setPositions` | `(state) => void` | Position-based highlight state setter |

### `OffscreenFreeze({ children }: Props): React.ReactNode`

Wraps children and freezes their React subtree when scrolled into terminal scrollback.

### `JumpHandle` (imperative interface)

| Method | Description |
|--------|-------------|
| `jumpToIndex(i)` | Scroll to message index (no search context) |
| `setSearchQuery(q)` | Set search query, compute matches, jump to nearest |
| `nextMatch()` | Advance to next occurrence |
| `prevMatch()` | Go to previous occurrence |
| `setAnchor()` | Capture scroll position for zero-match snap-back |
| `warmSearchIndex()` | Pre-cache search text for all messages; returns elapsed ms |
| `disarmSearch()` | Clear highlight positions on manual scroll |

## Interface/Type Definitions

### `StickyPrompt`

```typescript
type StickyPrompt = {
  text: string;       // Collapsed first paragraph of the user prompt
  scrollTo: () => void; // Click handler to jump back to the prompt
} | 'clicked';         // Sentinel: header hides, padding collapses
```

> Source: `src/components/VirtualMessageList.tsx:32-39`

### `MessageActionsNav` (exposed via `cursorNavRef`)

Provides cursor navigation within the message list:
- `enterCursor()` — Enter cursor mode from the last user message
- `navigatePrev/Next()` — Move cursor up/down through navigable messages
- `navigatePrevUser/NextUser()` — Jump between user prompts only
- `navigateTop/Bottom()` — Jump to first/last navigable message
- `getSelected()` — Return the currently selected message

> Source: `src/components/VirtualMessageList.tsx:345-381`

## Configuration & Defaults

| Constant | Value | Purpose |
|----------|-------|---------|
| `HEADROOM` | `3` | Rows of breathing room above the target on `scrollTo` |
| `STICKY_TEXT_CAP` | `500` | Max characters for sticky prompt header text |
| Warm chunk size | `500` | Messages processed per yield in `warmSearchIndex()` |
| Phantom burst cap | `20` | Max consecutive phantom messages before auto-advance stops |

## Edge Cases & Caveats

- **Incremental key array**: The key computation uses append-only delta pushes during streaming. A full rebuild is only triggered when messages shrink (compaction/clear) or the first message changes, avoiding O(n) allocation per streamed token.

- **System reminder stripping**: `stickyPromptText()` strips leading `<system-reminder>` blocks from user messages before checking content. Without this, memory-update reminders injected by the system would cause the `startsWith('<')` guard to reject valid user prompts — especially visible on `cc -c` session resumes.

- **Phantom messages**: The search engine (indexOf on extracted text) can match messages where the renderer produces no visible match positions (scanElement returns empty). The system auto-advances past these "phantoms" with a burst cap of 20 to prevent infinite loops.

- **GC optimization**: Per-item click/hover closures were profiled as 16% of GC time during fast scrolling (1800 short-lived closures/sec). Stable `useCallback` handlers with ref-forwarding (`onClickK`, `onEnterK`, `onLeaveK`) reduce this to near-zero by keeping VirtualItem props stable across renders.

- **OffscreenFreeze + VirtualList interaction**: OffscreenFreeze is intentionally disabled inside VirtualMessageList (via `InVirtualListContext`). The virtual list's ScrollBox clips within the viewport — there's no terminal scrollback to freeze — and the viewport visibility calculation would conflict with the ScrollBox's virtual scroll position, breaking click-to-expand.

- **React Compiler opt-out**: OffscreenFreeze uses `'use no memo'` because its freeze mechanism relies on returning the *same* `cached.current` ref when offscreen. React Compiler memoization would stabilize children references and defeat the freeze.

- **StickyTracker fine-grained subscription**: StickyTracker subscribes at per-wheel-tick granularity (not the coarser `SCROLL_QUANTUM=40` used by the list itself) because it's just a walk + comparison with no Yoga relayout cost. This prevents the sticky header from lagging behind by ~40 rows.