# Input Handling Hooks

## Overview & Responsibilities

The Input Handling module is a collection of React hooks within the **Hooks** layer of the **TerminalUI** subsystem. Together, these hooks manage all aspects of text input, keyboard interaction, and clipboard integration in Claude Code's interactive terminal interface.

This module sits between the low-level Ink rendering engine (which provides raw keypress events) and the higher-level components like `PromptInput` and screen layouts. It covers:

- **Core text editing** — a full readline-like input state machine with cursor movement, kill-ring, and yank support
- **Vim mode** — optional vim-style editing wrapping the core text input
- **Paste handling** — bracketed paste detection, chunked paste assembly, and image detection from clipboard or file paths
- **History navigation** — both arrow-key sequential browsing and interactive search with async disk reads
- **Clipboard integration** — copy-on-select behavior and clipboard image hint notifications
- **Input buffering** — debounced undo buffer for text changes
- **Keybinding registration** — global app keybindings and dynamic slash-command keybindings
- **Utility hooks** — double-press detection and search-mode input

Sibling modules in the Hooks layer handle session lifecycle, IDE integrations, and UI state concerns.

---

## Key Processes

### Text Input Keystroke Flow

The central flow through `useTextInput` processes every keystroke from raw input to state update:

1. `onInput(input, key)` is called by the Ink input system (`src/hooks/useTextInput.ts:431-501`)
2. The optional `inputFilter` transforms the input; filtered-out input is discarded
3. SSH/tmux DEL characters (`\x7f`) are detected and processed as backspace operations
4. Kill-ring accumulation is managed — consecutive kill commands accumulate, non-kill keys reset
5. `mapKey(key)` dispatches to the appropriate handler based on key type (`src/hooks/useTextInput.ts:318-413`):
   - Ctrl+key → Emacs bindings (movement, kill, yank, history)
   - Meta+key → word-level movement and yank-pop
   - Arrow keys → cursor movement or history navigation at boundaries
   - Return → submit or insert newline (with modifier)
   - Escape → double-press to clear input
   - Default → insert text with ANSI stripping and `\r` normalization
6. The resulting `Cursor` is compared to the current one; if changed, `onChange` and `setOffset` fire
7. SSH-coalesced Enter (trailing `\r` after text) triggers `onSubmit` after insertion

### Paste Detection & Image Handling Flow

`usePasteHandler` wraps `onInput` to intercept paste events (`src/hooks/usePasteHandler.ts:214-278`):

1. Checks `event.keypress.isPasted` (bracketed paste mode) for reliable detection
2. Also triggers on input exceeding `PASTE_THRESHOLD` or containing image file paths
3. Chunks are accumulated in state; a 100ms timeout assembles the final paste
4. On timeout: joins chunks, splits on path boundaries to find image files
5. Image paths are read via `tryReadImageFromPath`; empty pastes on macOS check the clipboard via osascript
6. A synchronous `pastePendingRef` prevents race conditions when paste and keystroke arrive in the same stdin chunk

### History Search Flow

`useHistorySearch` implements reverse incremental search (`src/hooks/useHistorySearch.ts:73-148`):

1. `Ctrl+R` saves current input as draft and opens an async history reader
2. On each query keystroke, the previous search is aborted via `AbortController` and a new async generator walk begins
3. Entries are matched by `display.lastIndexOf(historyQuery)`; duplicates tracked via `seenPrompts` Set
4. "Next match" resumes the generator; "Accept" parses mode and exits; "Cancel" restores the draft
5. File handle cleanup is ensured by calling `.return()` on the async generator

### Arrow-Key History Navigation Flow

`useArrowKeyHistory` handles sequential Up/Down browsing (`src/hooks/useArrowKeyHistory.tsx:124-182`):

1. Uses a synchronous `historyIndexRef` to handle rapid keypresses without stale closures
2. On first Up press: saves draft, locks mode filter (bash stays in bash history)
3. Loads history in chunks of 10 via `loadHistoryEntries` — concurrent requests batched into a single disk read
4. After 2+ entries, shows a "Ctrl+R to search" hint
5. Down navigates back; at index 1, restores the saved draft

---

## Hook Signatures & Parameters

### `useTextInput`

**File**: `src/hooks/useTextInput.ts:73-529`

```ts
function useTextInput(props: UseTextInputProps): TextInputState
```

**Key props**:

| Prop | Type | Purpose |
|------|------|---------|
| `value` / `onChange` | `string` / `(string) => void` | Controlled text state |
| `onSubmit` | `(string) => void` | Called on Enter |
| `onHistoryUp` / `onHistoryDown` | `() => void` | Arrow-key history hooks |
| `multiline` | `boolean` | Enables `\`+Enter for newlines |
| `columns` | `number` | Terminal width for cursor wrapping |
| `onImagePaste` | callback | Image paste handler |
| `inputFilter` | `(input, key) => string` | Pre-processing filter |
| `inlineGhostText` | `InlineGhostText` | Ghost text for inline completions |
| `maxVisibleLines` | `number` | Viewport height limit |
| `externalOffset` / `onOffsetChange` | `number` / `(number) => void` | Externally-controlled cursor offset |

**Returns** `TextInputState`: `onInput`, `renderedValue`, `offset`, `setOffset`, `cursorLine`, `cursorColumn`, `viewportCharOffset`, `viewportCharEnd`.

### `useVimInput`

**File**: `src/hooks/useVimInput.ts:34-316`

```ts
function useVimInput(props: UseVimInputProps): VimInputState
```

Wraps `useTextInput` with vim state machine. Adds `mode: VimMode` and `setMode` to the return type. Accepts optional `onModeChange` and `onUndo` callbacks.

### `usePasteHandler`

**File**: `src/hooks/usePasteHandler.ts:30-285`

```ts
function usePasteHandler(props: PasteHandlerProps): {
  wrappedOnInput: (input: string, key: Key, event: InputEvent) => void
  pasteState: { chunks: string[], timeoutId: ReturnType<typeof setTimeout> | null }
  isPasting: boolean
}
```

### `useSearchInput`

**File**: `src/hooks/useSearchInput.ts:84-364`

```ts
function useSearchInput(options: UseSearchInputOptions): {
  query: string
  setQuery: (q: string) => void
  cursorOffset: number
  handleKeyDown: (e: KeyboardEvent) => void
}
```

Self-contained text input for search/filter contexts. Full Emacs keybindings, kill-ring/yank support, configurable exit behavior. Options include `isActive`, `onExit`, `onCancel`, `onExitUp`, `passthroughCtrlKeys`, `initialQuery`, and `backspaceExitsOnEmpty`.

### `useArrowKeyHistory`

**File**: `src/hooks/useArrowKeyHistory.tsx:63-228`

```ts
function useArrowKeyHistory(
  onSetInput, currentInput, pastedContents, setCursorOffset?, currentMode?
): { historyIndex, setHistoryIndex, onHistoryUp, onHistoryDown, resetHistory, dismissSearchHint }
```

### `useHistorySearch`

**File**: `src/hooks/useHistorySearch.ts:15-303`

```ts
function useHistorySearch(
  onAcceptHistory, currentInput, onInputChange, onCursorChange,
  currentCursorOffset, onModeChange, currentMode,
  isSearching, setIsSearching, setPastedContents, currentPastedContents
): { historyQuery, setHistoryQuery, historyMatch, historyFailedMatch, handleKeyDown }
```

Registers keybindings: `history:search` (Global context), `historySearch:next/accept/cancel/execute` (HistorySearch context).

### `useInputBuffer`

**File**: `src/hooks/useInputBuffer.ts:27-132`

```ts
function useInputBuffer({ maxBufferSize, debounceMs }): {
  pushToBuffer, undo, canUndo, clearBuffer
}
```

### `useCopyOnSelect`

**File**: `src/hooks/useCopyOnSelect.ts:26-83`

```ts
function useCopyOnSelect(selection: Selection, isActive: boolean, onCopied?: (text: string) => void): void
```

### `useClipboardImageHint`

**File**: `src/hooks/useClipboardImageHint.ts:19-77`

```ts
function useClipboardImageHint(isFocused: boolean, enabled: boolean): void
```

### `useDoublePress`

**File**: `src/hooks/useDoublePress.ts:8-62`

```ts
function useDoublePress(
  setPending: (pending: boolean) => void,
  onDoublePress: () => void,
  onFirstPress?: () => void
): () => void
```

Timeout: 800ms (`DOUBLE_PRESS_TIMEOUT_MS`). Used by `useTextInput` for Escape, Ctrl+C, and Ctrl+D.

### `CommandKeybindingHandlers`

**File**: `src/hooks/useCommandKeybindings.tsx:37-107`

```ts
function CommandKeybindingHandlers({ onSubmit, isActive }): null
```

React component that dynamically registers handlers for all `command:*` keybinding actions, submitting the corresponding slash command (e.g., `command:commit` → `onSubmit("/commit", ...)`). Deactivated when a modal overlay is active.

### `GlobalKeybindingHandlers`

**File**: `src/hooks/useGlobalKeybindings.tsx:36-248`

```ts
function GlobalKeybindingHandlers({ screen, setScreen, ... }): null
```

Registers app-level keybindings:

| Action | Description |
|--------|-------------|
| `app:toggleTodos` | Cycles expanded view: none → tasks → teammates → none |
| `app:toggleTranscript` | Toggles between prompt and transcript screens |
| `app:toggleBrief` | Toggles brief-only view (feature-gated) |
| `app:toggleTeammatePreview` | Toggles teammate message preview |
| `app:toggleTerminal` | Toggles built-in terminal panel (feature-gated) |
| `app:redraw` | Forces full screen redraw |
| `transcript:toggleShowAll` | Toggles showing all messages in transcript |
| `transcript:exit` | Exits transcript mode (only when search bar is closed) |

---

## Interface & Type Definitions

### `UseTextInputProps` (`src/hooks/useTextInput.ts:38-71`)

Core configuration for the text input state machine. Key fields include `value`/`onChange` for controlled state, `multiline` for multi-line editing, `onImagePaste` for image handling, `inputFilter` for keystroke pre-processing, and `inlineGhostText` for completion suggestions.

### `BufferEntry` (`src/hooks/useInputBuffer.ts:4-9`)

```ts
type BufferEntry = {
  text: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
  timestamp: number
}
```

### `UseSearchInputOptions` (`src/hooks/useSearchInput.ts:17-33`)

```ts
type UseSearchInputOptions = {
  isActive: boolean
  onExit: () => void
  onCancel?: () => void
  onExitUp?: () => void
  columns?: number
  passthroughCtrlKeys?: string[]
  initialQuery?: string
  backspaceExitsOnEmpty?: boolean  // default: true
}
```

---

## Configuration & Defaults

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `DOUBLE_PRESS_TIMEOUT_MS` | 800ms | `src/hooks/useDoublePress.ts:6` | Window for double-press detection |
| `PASTE_THRESHOLD` | (from `imagePaste.js`) | `src/hooks/usePasteHandler.ts:9` | Character count triggering paste mode |
| `PASTE_COMPLETION_TIMEOUT_MS` | 100ms | `src/hooks/usePasteHandler.ts:16` | Delay to assemble chunked pastes |
| `CLIPBOARD_CHECK_DEBOUNCE_MS` | 50ms | `src/hooks/usePasteHandler.ts:15` | Debounce for clipboard image checks |
| `HISTORY_CHUNK_SIZE` | 10 | `src/hooks/useArrowKeyHistory.tsx:13` | Entries loaded per disk read |
| `FOCUS_CHECK_DEBOUNCE_MS` | 1000ms | `src/hooks/useClipboardImageHint.ts:8` | Debounce for focus-regain clipboard check |
| `HINT_COOLDOWN_MS` | 30000ms | `src/hooks/useClipboardImageHint.ts:10` | Minimum interval between image hints |
| `copyOnSelect` | `true` (default) | `src/hooks/useCopyOnSelect.ts:68` | Global config controlling copy-on-select |

---

## Edge Cases & Caveats

- **SSH/tmux DEL handling** (`src/hooks/useTextInput.ts:443-464`): In SSH/tmux environments, backspace generates both key events and raw DEL (`\x7f`) characters. The hook detects and processes orphaned DEL chars as backspace operations to prevent double-deletion.

- **SSH-coalesced Enter** (`src/hooks/useTextInput.ts:485-499`): On slow SSH links, a character and Enter can arrive as a single chunk (e.g., `"o\r"`). The hook detects trailing `\r` after text and triggers `onSubmit` after inserting the text.

- **Apple Terminal shift detection** (`src/hooks/useTextInput.ts:263-265`): Apple Terminal doesn't support custom Shift+Enter keybindings, so the hook uses native macOS modifier detection (`isModifierPressed('shift')`) as a fallback for newline insertion.

- **Paste race condition** (`src/hooks/usePasteHandler.ts:49-53`): A `pastePendingRef` is maintained alongside React state to handle the case where paste and a regular keystroke arrive in the same `discreteUpdates` batch before React commits.

- **Vim Escape is not configurable**: The Escape key in vim mode (INSERT→NORMAL switch) intentionally bypasses the keybinding system — vim users expect Escape to always exit insert mode (`src/hooks/useVimInput.ts:189-195`).

- **Text input Escape is not configurable**: The double-press Escape handler in `useTextInput` is intentionally kept outside the keybinding system — it's text-editing behavior (clear input), not dialog dismissal (`src/hooks/useTextInput.ts:122-125`).

- **History search abort** (`src/hooks/useHistorySearch.ts:286-294`): Each new query keystroke aborts the previous async search via `AbortController`, preventing stale results from overwriting fresher matches.

- **History file handle leak prevention** (`src/hooks/useHistorySearch.ts:51-58`): The async generator's `.return()` must be called explicitly to trigger the `finally` block in `readLinesReverse`, which closes the file handle.

- **Backslash+Return in VS Code** (`src/hooks/useTextInput.ts:396-399`): Stale VS Code Shift+Enter bindings that emit `\\\r\n` are handled by preserving the `\r` so it converts to `\n` in the text normalization step.

- **useSearchInput backward-compat bridge** (`src/hooks/useSearchInput.ts:352-361`): Currently subscribes via the legacy `useInput` API and adapts events to `KeyboardEvent`, pending migration of all 11 consumer call sites to `onKeyDown`.