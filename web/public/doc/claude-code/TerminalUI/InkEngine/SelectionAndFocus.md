# Selection and Focus

## Overview & Responsibilities

This module group handles four related concerns within the Ink rendering engine (part of the **TerminalUI → InkEngine** layer): mouse-driven text selection, DOM-like focus management, bidirectional text reordering for RTL scripts, and search-match highlighting. Together they bridge the gap between a React-reconciled terminal UI and native terminal behaviors users expect — selecting text, tabbing between elements, reading RTL languages, and finding text on screen.

The four files are independent of each other but share a common pattern: they operate on the Ink screen buffer or DOM tree as post-render passes, applying visual overlays or state mutations that the diff engine picks up as ordinary cell changes.

**Sibling modules** within InkEngine include the DOM model, Yoga-based layout engine, ANSI output generation, screen rendering pipeline, event system, and primitive components (Box, Text, ScrollBox, Button, Link).

---

## Key Processes

### Selection Lifecycle (selection.ts)

The selection system tracks a linear selection in screen-buffer coordinates using an **anchor + focus** model. The anchor is where the mouse-down occurred; the focus is where the cursor currently is. The rendered highlight normalizes these to start ≤ end in reading order.

1. **Mouse-down → `startSelection(s, col, row)`** — Initializes anchor at the click position, sets `isDragging = true`, clears all accumulators. Focus stays `null` until the first real drag motion, so a bare click never highlights a cell (`src/ink/selection.ts:79-98`).

2. **Mouse-move → `updateSelection(s, col, row)`** — Updates focus on drag. Ignores the first motion at the same cell as anchor to prevent sub-pixel tremor from creating a spurious 1-cell selection (`src/ink/selection.ts:100-114`).

3. **Mouse-up → `finishSelection(s)`** — Sets `isDragging = false` but preserves anchor/focus so the highlight remains visible and text can be copied (`src/ink/selection.ts:116-120`).

4. **Escape / after copy → `clearSelection(s)`** — Resets all state to initial values (`src/ink/selection.ts:122-134`).

### Word and Line Selection

- **Double-click → `selectWordAt(s, screen, col, row)`** — Scans the screen buffer for the bounds of the same-class character run under the cursor. Character classification (`charClass` at `src/ink/selection.ts:151-155`) groups letters/digits/path-chars as "word" (matching iTerm2's default set `/-+\~_.`), operators as "punctuation", and spaces as "whitespace". Sets `anchorSpan` with `kind: 'word'` so subsequent drag extends word-by-word (`src/ink/selection.ts:240-254`).

- **Triple-click → `selectLineAt(s, screen, row)`** — Selects the full row from col 0 to width-1. Sets `anchorSpan` with `kind: 'line'` (`src/ink/selection.ts:368-380`).

- **Drag after multi-click → `extendSelection(s, screen, col, row)`** — Grows the selection from the anchor span to the word/line at the current mouse position. The original word/line always stays selected even when dragging backward past it (`src/ink/selection.ts:389-421`).

### Scroll-Aware Anchor Tracking

When the user drags beyond the viewport edge, the ScrollBox scrolls and content leaves the screen buffer. The screen buffer only holds the current viewport, so without special handling the top (or bottom) of the selection would be lost. Three functions coordinate:

1. **`captureScrolledRows(s, screen, firstRow, lastRow, side)`** — Called *before* the scroll overwrites rows. Captures text from rows intersecting the selection into `scrolledOffAbove` or `scrolledOffBelow` accumulators, along with parallel `softWrap` flags. After capturing the anchor row, resets anchor col to full-width so subsequent frames don't re-apply a stale column constraint (`src/ink/selection.ts:813-875`).

2. **`shiftAnchor(s, dRow, minRow, maxRow)`** — Moves the anchor to follow content during drag-to-scroll while focus stays at the mouse position. Uses virtual row tracking to handle clamp/restore round-trips (`src/ink/selection.ts:573-602`).

3. **`shiftSelection(s, dRow, minRow, maxRow, width)`** — Moves *both* anchor and focus for keyboard scroll (PgUp/PgDn/Ctrl+U/D). Pops entries from accumulators when reverse scrolling brings rows back on-screen. Clears the selection entirely if both endpoints overshoot the same viewport edge (`src/ink/selection.ts:470-565`).

4. **`shiftSelectionForFollow(s, dRow, minRow, maxRow)`** — Shifts both endpoints during auto-follow (streaming content push). Returns `true` if the selection was cleared (both endpoints scrolled off the top), so the caller can notify React-land subscribers (`src/ink/selection.ts:625-674`).

### Clipboard Text Extraction

**`getSelectedText(s, screen)`** (`src/ink/selection.ts:773-795`) assembles the final copied text:

1. Joins `scrolledOffAbove` accumulator rows
2. Extracts on-screen rows via `extractRowText()` — skips `noSelect` cells (gutters, line numbers), spacer tails (wide chars), and trims trailing whitespace
3. Joins `scrolledOffBelow` accumulator rows
4. Merges soft-wrapped rows back into logical lines using the `softWrap` bitmap via `joinRows()`, so copied text matches the logical source, not the visual wrapped layout

### Focus Navigation (focus.ts)

The `FocusManager` class (`src/ink/focus.ts:15-132`) provides browser-like focus semantics:

1. **`focus(node)`** — Deduplicates and pushes the previous element onto a bounded stack (max 32), dispatches `blur` on the old element and `focus` on the new one. No-op if already focused or disabled.
2. **`focusNext(root)` / `focusPrevious(root)`** — Tab / Shift+Tab navigation. Collects all tabbable elements via depth-first walk (`tabIndex >= 0`) and moves circularly.
3. **`handleNodeRemoved(node, root)`** — Called by the reconciler. Cleans dangling references from the stack, blurs if the active element was in the removed subtree, then restores focus from the stack to the most recent still-mounted element.
4. **`handleClickFocus(node)`** — Focuses on click only if the node has a numeric `tabIndex`.

Helper functions `getRootNode(node)` and `getFocusManager(node)` (`src/ink/focus.ts:166-181`) walk up `parentNode` to find the root that holds the `FocusManager`, analogous to the browser's `node.ownerDocument`.

### Bidirectional Text Reordering (bidi.ts)

**`reorderBidi(characters)`** (`src/ink/bidi.ts:53-105`) applies the Unicode Bidi Algorithm to reorder `ClusteredChar` arrays from logical to visual order:

1. **Detection** — `needsBidi()` checks if the terminal lacks native bidi: `process.platform === 'win32'`, `WT_SESSION` env var (Windows Terminal / WSL), or `TERM_PROGRAM === 'vscode'` (xterm.js). Cached after first call (`src/ink/bidi.ts:29-37`).
2. **RTL check** — `hasRTLCharacters()` uses a regex covering Hebrew, Arabic, Thaana, and Syriac Unicode ranges. Pure LTR text skips the full algorithm (`src/ink/bidi.ts:131-139`).
3. **Embedding levels** — Joins char values, calls `bidi-js`'s `getEmbeddingLevels()` with `'auto'` paragraph direction.
4. **Level mapping** — Maps levels back to `ClusteredChar` indices, accounting for multi-codeunit characters.
5. **Reordering** — Standard bidi L2 rule: for each level from max down to 1, reverses all contiguous runs at or above that level.

On macOS terminals with native bidi, the function is a no-op (returns the input array unchanged).

### Search Highlighting (searchHighlight.ts)

**`applySearchHighlight(screen, query, stylePool)`** (`src/ink/searchHighlight.ts:27-93`) highlights all visible occurrences of a query by inverting cell styles (SGR 7):

1. **Per-row text extraction** — Builds a lowercased text string from visible cells, skipping `SpacerTail`, `SpacerHead`, and `noSelect` cells. Maintains two maps: `colOf[]` (char index → screen column) and `codeUnitToCell[]` (code-unit position → char index).
2. **Case-insensitive matching** — `indexOf` on the extracted text. Each match is mapped back to screen columns via the two maps.
3. **Style inversion** — Calls `setCellStyleId` with `stylePool.withInverse(cell.styleId)` for each matched cell.
4. **Non-overlapping advance** — Advances by query length after each match to prevent double-inverting overlapping cells.
5. **Returns `true`** if any match was highlighted — caller uses this as a damage gate to force a full-frame redraw.

This handles only the "all matches" background highlight. The yellow "current match" overlay is handled separately by `applyPositionedHighlight` in `render-to-screen.ts`.

---

## Function Signatures & Parameters

### Selection API

| Function | Signature | Description |
|----------|-----------|-------------|
| `createSelectionState` | `(): SelectionState` | Returns a fresh zero-state selection |
| `startSelection` | `(s, col, row): void` | Begin a new selection at the given screen position |
| `updateSelection` | `(s, col, row): void` | Update focus position during drag |
| `finishSelection` | `(s): void` | End dragging, keep highlight |
| `clearSelection` | `(s): void` | Remove selection entirely |
| `selectWordAt` | `(s, screen, col, row): void` | Double-click: select the word under cursor |
| `selectLineAt` | `(s, screen, row): void` | Triple-click: select entire row |
| `extendSelection` | `(s, screen, col, row): void` | Extend word/line selection during drag |
| `moveFocus` | `(s, col, row): void` | Keyboard shift+arrow: move focus, keep anchor |
| `shiftSelection` | `(s, dRow, minRow, maxRow, width): void` | Keyboard scroll: shift both endpoints |
| `shiftAnchor` | `(s, dRow, minRow, maxRow): void` | Drag-to-scroll: shift anchor only |
| `shiftSelectionForFollow` | `(s, dRow, minRow, maxRow): boolean` | Auto-follow scroll: shift both, returns true if cleared |
| `captureScrolledRows` | `(s, screen, firstRow, lastRow, side): void` | Save rows before they scroll out |
| `hasSelection` | `(s): boolean` | True if both anchor and focus are set |
| `selectionBounds` | `(s): {start, end} \| null` | Normalized bounds (start ≤ end) |
| `isCellSelected` | `(s, col, row): boolean` | Point-in-selection test |
| `getSelectedText` | `(s, screen): string` | Extract text from selection |
| `findPlainTextUrlAt` | `(screen, col, row): string \| undefined` | Detect URL at screen position |
| `applySelectionOverlay` | `(screen, selection, stylePool): void` | Apply selection highlight to screen buffer |

### Focus API

| Function / Method | Description |
|-------------------|-------------|
| `FocusManager.focus(node)` | Move focus to node, dispatch blur/focus events |
| `FocusManager.blur()` | Clear focus |
| `FocusManager.focusNext(root)` | Tab: move to next tabbable element |
| `FocusManager.focusPrevious(root)` | Shift+Tab: move to previous tabbable element |
| `FocusManager.handleNodeRemoved(node, root)` | Clean up on DOM removal |
| `FocusManager.handleAutoFocus(node)` | Focus on mount |
| `FocusManager.handleClickFocus(node)` | Focus on click (if tabbable) |
| `FocusManager.enable()` / `disable()` | Gate focus operations |
| `getRootNode(node)` | Walk to root DOMElement holding the FocusManager |
| `getFocusManager(node)` | Walk to root and return its FocusManager |

### Bidi API

| Function | Signature | Description |
|----------|-----------|-------------|
| `reorderBidi` | `(characters: ClusteredChar[]): ClusteredChar[]` | Reorder logical → visual order. No-op on bidi-capable terminals. |

### Search Highlight API

| Function | Signature | Description |
|----------|-----------|-------------|
| `applySearchHighlight` | `(screen, query, stylePool): boolean` | Invert-highlight all matches. Returns true if any matched. |

---

## Interface / Type Definitions

### `SelectionState` (`src/ink/selection.ts:19-63`)

Core mutable state object for the selection system. Fields documented in the State Shape table above. Created via `createSelectionState()`.

### `Point` (`src/ink/selection.ts:17`)

```typescript
type Point = { col: number; row: number }
```

Screen-buffer coordinate (0-indexed column and row).

### `FocusMove` (`src/ink/selection.ts:425-431`)

```typescript
type FocusMove = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd'
```

Semantic keyboard focus movement directions. Used by `moveSelectionFocus` in `ink.tsx` to compute screen-clamped coordinates before calling `moveFocus`.

### `ClusteredChar` (`src/ink/bidi.ts:19-24`)

```typescript
type ClusteredChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}
```

A single visual character cluster as produced by the text measurement pipeline. The bidi module reorders arrays of these.

---

## Configuration & Defaults

- **Bidi detection** is automatic based on platform and environment variables. No user configuration required.
- **Word character set** (`WORD_CHAR` at `src/ink/selection.ts:142`) matches iTerm2's default: Unicode letters, digits, and `/-+\~_.`. Not currently configurable.
- **Focus stack size** is hardcoded to `MAX_FOCUS_STACK = 32` (`src/ink/focus.ts:4`).
- **Search highlighting** is always case-insensitive with non-overlapping matches.
- **URL detection** recognizes `http://`, `https://`, and `file://` schemes. Strips trailing punctuation (`.,:;!?`) and handles balanced brackets in URLs like `/wiki/Foo_(bar)`.

---

## Edge Cases & Caveats

### Selection
- A click with no drag (focus stays `null`) never highlights — prevents accidental clipboard clobbering via copy-on-select.
- Wide characters (CJK, emoji) occupy two screen cells (head + SpacerTail). All scanning functions step over spacer tails to the head cell for character classification and text extraction.
- The `noSelect` bitmap marks gutter cells (line numbers, `⎿` sigils, diff markers) that are excluded from both selection highlight and text extraction.
- Virtual row tracking (`virtualAnchorRow` / `virtualFocusRow`) prevents accumulator drift during clamp → reverse-scroll sequences that would otherwise cause highlight ≠ copied-text mismatches.
- `lastPressHadAlt` tracks whether Alt was held during mouse-down — on macOS in VS Code this indicates `macOptionClickForcesSelection` is OFF, used by the footer to show the correct hint text.

### Focus
- Tab cycling deduplicates the focus stack on each push to prevent the same element from filling the stack.
- `handleNodeRemoved` filters the *entire* stack with `isInTree`, not just the removed node, to catch orphaned descendants.

### Bidi
- The `bidi-js` library is lazily instantiated — zero cost on macOS terminals that don't need it.
- Multi-codeunit characters are handled correctly: each `ClusteredChar`'s level is taken from its first code unit's offset in the joined string.

### Search Highlighting
- Per-character lowercasing (not post-join) keeps the `codeUnitToCell` map correct for characters like Turkish İ (U+0130) that expand to 2 code units when lowercased.
- Gutter cells are excluded from search targets, matching the selection system's exclusion.
- Only inverts styles — no "current match" logic. The yellow current-match overlay is a separate system in `render-to-screen.ts`.

---

## Key Code References

| Item | Location |
|------|----------|
| `SelectionState` type | `src/ink/selection.ts:19-63` |
| `createSelectionState` | `src/ink/selection.ts:65-77` |
| `startSelection` / `updateSelection` / `finishSelection` | `src/ink/selection.ts:79-120` |
| `selectWordAt` | `src/ink/selection.ts:240-254` |
| `selectLineAt` | `src/ink/selection.ts:368-380` |
| `extendSelection` | `src/ink/selection.ts:389-421` |
| `shiftSelection` | `src/ink/selection.ts:470-565` |
| `shiftSelectionForFollow` | `src/ink/selection.ts:625-674` |
| `getSelectedText` | `src/ink/selection.ts:773-795` |
| `captureScrolledRows` | `src/ink/selection.ts:813-875` |
| `applySelectionOverlay` | `src/ink/selection.ts:893-917` |
| `findPlainTextUrlAt` | `src/ink/selection.ts:272-359` |
| `FocusManager` class | `src/ink/focus.ts:15-132` |
| `getRootNode` / `getFocusManager` | `src/ink/focus.ts:166-181` |
| `reorderBidi` | `src/ink/bidi.ts:53-105` |
| `needsBidi` | `src/ink/bidi.ts:29-37` |
| `hasRTLCharacters` | `src/ink/bidi.ts:131-139` |
| `applySearchHighlight` | `src/ink/searchHighlight.ts:27-93` |