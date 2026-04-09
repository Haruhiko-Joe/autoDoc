# EventSystem

## Overview & Responsibilities

The EventSystem is the event model and dispatch infrastructure for the Ink rendering engine — the customized React-for-CLI framework powering the TerminalUI. It sits within the **InkEngine** layer of the **TerminalUI** module and provides three core capabilities:

1. **Event type hierarchy** — A family of event classes (`Event`, `TerminalEvent`, `KeyboardEvent`, `ClickEvent`, `FocusEvent`, `TerminalFocusEvent`, `InputEvent`) that model user interactions in the terminal
2. **Event dispatch** — A DOM-style capture/bubble dispatcher that propagates events through the component tree, integrated with React's scheduling priorities
3. **Input parsing** — A keypress parser that converts raw terminal byte sequences into structured key objects, handling escape sequences, mouse reports, paste brackets, and terminal response queries
4. **Hit testing** — A coordinate-to-element mapping system that resolves screen positions to DOM nodes for click and hover dispatch

### Position in the Architecture

The EventSystem is consumed by sibling modules in the InkEngine (focus management, input hooks, the keybinding system) and by the Components layer. The Screens module's REPL reads raw stdin, feeds it through the keypress parser, and dispatches the resulting events through the dispatcher. The VimMode and Keybindings modules consume `KeyboardEvent` and `InputEvent` to implement their input handling.

## Key Processes

### Keypress Parsing Flow

Raw terminal bytes arrive on stdin and flow through the parser pipeline:

1. **Tokenization** — `parseMultipleKeypresses()` feeds raw input to the termio tokenizer (`src/ink/parse-keypress.ts:221-224`), which detects escape sequence boundaries and emits `sequence` and `text` tokens
2. **Paste detection** — The parser tracks bracketed paste state. Content between `PASTE_START` and `PASTE_END` accumulates in a buffer and is emitted as a single `ParsedKey` with `isPasted: true` (`src/ink/parse-keypress.ts:233-241`)
3. **Token classification** — Each token outside paste mode is tried against three parsers in order (`src/ink/parse-keypress.ts:247-256`):
   - `parseTerminalResponse()` → emits `ParsedResponse` (DECRPM, DA1, DA2, Kitty flags, cursor position, OSC, XTVERSION)
   - `parseMouseEvent()` → emits `ParsedMouse` for clicks/drags/releases (wheel events are excluded and handled as `ParsedKey`)
   - `parseKeypress()` → emits `ParsedKey` for everything else
4. **Orphan recovery** — Orphaned SGR/X10 mouse tails (lost their ESC prefix due to event loop blocking) are detected and re-synthesized (`src/ink/parse-keypress.ts:263-279`)
5. **State carry** — Returns updated `KeyParseState` with the tokenizer, paste buffer, and mode for the next stdin chunk

### Event Dispatch Flow (Capture/Bubble)

When a `TerminalEvent` is dispatched through the DOM tree:

1. **`Dispatcher.dispatch(target, event)`** (`src/ink/events/dispatcher.ts:185-201`) sets `event.target` and begins dispatch
2. **`collectListeners()`** (`src/ink/events/dispatcher.ts:46-79`) walks from target up to root:
   - Capture handlers are **prepended** (unshift) → root fires first
   - Bubble handlers are **appended** (push) → target fires first
   - Result order: `[root-cap, …, parent-cap, target-cap, target-bub, parent-bub, …, root-bub]`
   - Non-bubbling events only get bubble handlers at the target itself
3. **`processDispatchQueue()`** (`src/ink/events/dispatcher.ts:87-114`) iterates listeners:
   - Checks `stopImmediatePropagation()` (breaks immediately) and `stopPropagation()` (breaks when node changes)
   - Sets `eventPhase` and `currentTarget` before each handler
   - Calls `_prepareForTarget()` for per-node setup
   - Catches and logs handler exceptions without breaking dispatch
4. Returns `true` if `preventDefault()` was NOT called

### Click Dispatch Flow

Click dispatch uses its own bubble loop (predates the DOM-style event system):

1. **`hitTest(root, col, row)`** (`src/ink/hit-test.ts:18-41`) recursively finds the deepest node at screen coordinates. Traverses children in reverse order so later siblings (painted on top) win. Uses `nodeCache` for screen-coordinate rectangles.
2. **Click-to-focus** (`src/ink/hit-test.ts:58-69`) — walks up from hit node to find the nearest focusable ancestor (`tabIndex` attribute) and focuses it via `FocusManager`
3. **Bubble** (`src/ink/hit-test.ts:72-87`) — creates a `ClickEvent` and walks up through `parentNode`. Before each handler, recomputes `localCol`/`localRow` relative to that handler's box. Stops on `stopImmediatePropagation()`.

### Hover Dispatch Flow

`dispatchHover()` (`src/ink/hit-test.ts:102-130`) implements `mouseenter`/`mouseleave` semantics:

1. Hit-tests and collects all ancestors with hover handlers into a `next` set
2. Diffs against the previous `hovered` set
3. Fires `onMouseLeave` on exited nodes, `onMouseEnter` on entered nodes
4. Skips handlers on detached nodes; mutates `hovered` in place for the caller

## Event Type Hierarchy

The event classes form a two-branch hierarchy:

```
Event (base)                           src/ink/events/event.ts
├── InputEvent                         src/ink/events/input-event.ts
├── TerminalFocusEvent                 src/ink/events/terminal-focus-event.ts
└── TerminalEvent                      src/ink/events/terminal-event.ts
    ├── KeyboardEvent                  src/ink/events/keyboard-event.ts
    └── FocusEvent                     src/ink/events/focus-event.ts

ClickEvent extends Event directly      src/ink/events/click-event.ts
```

### `Event` (base class)

> `src/ink/events/event.ts:1-11`

Minimal base providing `stopImmediatePropagation()`. All event types inherit from this. The `EventEmitter` checks this flag to short-circuit listener iteration.

### `TerminalEvent`

> `src/ink/events/terminal-event.ts:19-102`

The DOM-style event base class, mirroring the browser `Event` API. Provides:

- **`type`**, **`timeStamp`**, **`bubbles`**, **`cancelable`** — standard event metadata
- **`target`** / **`currentTarget`** / **`eventPhase`** — set by the Dispatcher during propagation
- **`stopPropagation()`** — stops traversal to the next node (remaining handlers on the current node still fire)
- **`preventDefault()`** — marks the event as cancelled (only if `cancelable` is true)
- **`_prepareForTarget()`** — hook for subclasses to do per-node setup before each handler

### `KeyboardEvent`

> `src/ink/events/keyboard-event.ts:12-51`

Dispatched through capture/bubble phases for key presses. Follows browser `KeyboardEvent` semantics:

- **`key`**: literal character for printable keys (`'a'`, `'3'`, `' '`), multi-char name for special keys (`'down'`, `'return'`, `'escape'`, `'f1'`). The idiomatic printable-char check is `e.key.length === 1`.
- **`ctrl`**, **`shift`**, **`meta`** (Alt/Option), **`superKey`** (Cmd/Win), **`fn`**: modifier flags

The `keyFromParsed()` helper translates from raw `ParsedKey`: Ctrl combos use the letter name, single printable chars use the literal sequence, and special keys use the parsed name.

### `InputEvent`

> `src/ink/events/input-event.ts:192-205`

The legacy Ink-style event that pairs a `Key` flags object with a processed `input` string. The `parseKey()` function (`src/ink/events/input-event.ts:27-190`) performs extensive normalization:

- Maps `ParsedKey.name` values to boolean flags on the `Key` type (arrows, modifiers, function keys)
- Handles CSI u (Kitty keyboard protocol) and modifyOtherKeys sequences
- Handles application keypad mode (numpad digits/operators via `ESC O` sequences)
- Suppresses unrecognized escape sequences and orphaned mouse fragments
- Strips meta escape prefixes for backward compatibility

### `ClickEvent`

> `src/ink/events/click-event.ts:10-38`

Fired on left-button mouse release (without drag), only when mouse tracking is enabled.

| Property | Type | Description |
|----------|------|-------------|
| `col` / `row` | `number` | 0-indexed screen coordinates |
| `localCol` / `localRow` | `number` | Coordinates relative to the current handler's Box; recomputed per handler during bubble |
| `cellIsBlank` | `boolean` | True if the clicked cell has no visible content |

### `FocusEvent`

> `src/ink/events/focus-event.ts:11-21`

Dispatched when focus moves between components. Type is `'focus'` or `'blur'`, both bubble (matching react-dom's `focusin`/`focusout` semantics). The `relatedTarget` points to the other element in the focus transition.

### `TerminalFocusEvent`

> `src/ink/events/terminal-focus-event.ts:12-19`

Fires when the terminal *window* gains or loses OS-level focus via DECSET 1004 focus reporting (`CSI I` / `CSI O`). Type is `'terminalfocus'` or `'terminalblur'`.

## Function Signatures & Parameters

### `parseMultipleKeypresses(prevState, input)`

> `src/ink/parse-keypress.ts:213-302`

```typescript
function parseMultipleKeypresses(
  prevState: KeyParseState,
  input: Buffer | string | null = '',
): [ParsedInput[], KeyParseState]
```

Stateful parser. Pass `null` as input to flush incomplete sequences. Returns an array of parsed events and the new state to pass on the next call.

### `hitTest(node, col, row)`

> `src/ink/hit-test.ts:18-41`

```typescript
function hitTest(node: DOMElement, col: number, row: number): DOMElement | null
```

Finds the deepest DOM element whose rendered rect contains `(col, row)`. Returns `null` if no node contains the point.

### `dispatchClick(root, col, row, cellIsBlank?)`

> `src/ink/hit-test.ts:49-89`

```typescript
function dispatchClick(root: DOMElement, col: number, row: number, cellIsBlank?: boolean): boolean
```

Hit-tests and bubbles a `ClickEvent`. Also handles click-to-focus. Returns `true` if at least one handler fired.

### `dispatchHover(root, col, row, hovered)`

> `src/ink/hit-test.ts:102-130`

```typescript
function dispatchHover(root: DOMElement, col: number, row: number, hovered: Set<DOMElement>): void
```

Diffs current vs previous hover set, firing `onMouseEnter`/`onMouseLeave`. Mutates `hovered` in place.

### `Dispatcher.dispatch(target, event)`

> `src/ink/events/dispatcher.ts:185-201`

Core capture/bubble dispatch. Returns `true` if `preventDefault()` was NOT called.

### `Dispatcher.dispatchDiscrete(target, event)`

> `src/ink/events/dispatcher.ts:207-218`

Wraps dispatch in React's `discreteUpdates` for synchronous flush. Used for keyboard, click, focus, paste.

### `Dispatcher.dispatchContinuous(target, event)`

> `src/ink/events/dispatcher.ts:224-232`

Dispatches with continuous priority. Used for resize, scroll, mouse move.

## Interface/Type Definitions

### `ParsedKey`

> `src/ink/parse-keypress.ts:543-556`

```typescript
type ParsedKey = {
  kind: 'key'
  name: string | undefined
  fn: boolean; ctrl: boolean; meta: boolean
  shift: boolean; option: boolean; super: boolean
  sequence: string | undefined
  raw: string | undefined
  code?: string
  isPasted: boolean
}
```

### `ParsedMouse`

> `src/ink/parse-keypress.ts:571-583`

```typescript
type ParsedMouse = {
  kind: 'mouse'
  button: number    // SGR button code (low 2 bits = button, bit 5 = drag, bit 6 = wheel)
  action: 'press' | 'release'
  col: number       // 1-indexed from terminal
  row: number       // 1-indexed from terminal
  sequence: string
}
```

### `TerminalResponse`

> `src/ink/parse-keypress.ts:96-111`

Discriminated union of terminal query responses: `decrpm`, `da1`, `da2`, `kittyKeyboard`, `cursorPosition`, `osc`, `xtversion`.

### `EventHandlerProps`

> `src/ink/events/event-handlers.ts:21-38`

All event handler props available on host components:

| Prop | Phase | Event Type |
|------|-------|------------|
| `onKeyDown` / `onKeyDownCapture` | bubble / capture | `KeyboardEvent` |
| `onFocus` / `onFocusCapture` | bubble / capture | `FocusEvent` |
| `onBlur` / `onBlurCapture` | bubble / capture | `FocusEvent` |
| `onPaste` / `onPasteCapture` | bubble / capture | `PasteEvent` |
| `onResize` | bubble only | `ResizeEvent` |
| `onClick` | bubble only | `ClickEvent` |
| `onMouseEnter` / `onMouseLeave` | no propagation | `() => void` |

### `HANDLER_FOR_EVENT`

> `src/ink/events/event-handlers.ts:44-54`

Reverse lookup map from event type string to handler prop names, enabling O(1) handler resolution per node during dispatch.

### `EVENT_HANDLER_PROPS`

> `src/ink/events/event-handlers.ts:60-73`

Set of all event handler prop names. The reconciler uses this to detect event props and store them in `_eventHandlers` instead of regular attributes.

## Configuration & Defaults

### Modifier Encoding

XTerm-style modifier values use the encoding: `value = 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0) + (super?8:0)`. Decoded by `decodeModifier()` at `src/ink/parse-keypress.ts:465-478`.

### DECRPM Status Values

> `src/ink/parse-keypress.ts:84-90`

```typescript
const DECRPM_STATUS = {
  NOT_RECOGNIZED: 0, SET: 1, RESET: 2,
  PERMANENTLY_SET: 3, PERMANENTLY_RESET: 4,
}
```

### Event Priority Mapping

> `src/ink/events/dispatcher.ts:122-138`

| Event Types | React Priority |
|-------------|---------------|
| `keydown`, `click`, `focus`, `blur`, `paste` | Discrete (sync flush) |
| `resize`, `scroll`, `mousemove` | Continuous |
| Everything else | Default |

## Edge Cases & Caveats

- **Wheel events stay as `ParsedKey`**, not `ParsedMouse` — intentional so the keybinding system can route them to scroll handlers. The `parseMouseEvent()` function returns `null` for button codes with bit 0x40 set (`src/ink/parse-keypress.ts:599-600`).

- **Orphaned mouse fragments**: When a heavy render blocks the event loop past the 50ms flush timer, the ESC prefix of a mouse sequence gets flushed as a lone Escape key. The parser detects and re-synthesizes these fragments (`src/ink/parse-keypress.ts:263-279`), but the spurious Escape is lost.

- **X10 mouse click/drag events are swallowed** (`src/ink/parse-keypress.ts:694-699`) — only wheel events are processed from the legacy encoding, since mouse tracking is only enabled in alt-screen for ScrollBox.

- **Meta vs Option ambiguity**: `parseKeypress` sometimes reports `option: true` instead of `meta: true` for `ESC ESC [A` style sequences. `InputEvent.parseKey()` normalizes this by OR-ing both flags (`src/ink/events/input-event.ts:51`).

- **`TerminalFocusEvent` does NOT extend `TerminalEvent`** — it extends `Event` directly, so it doesn't participate in capture/bubble dispatch. It's emitted via the `EventEmitter` pub/sub channel instead.

- **`ClickEvent` also extends `Event` directly** — click dispatch uses its own bubble loop in `dispatchClick()` rather than the `Dispatcher` class, because it predates the DOM-style event system.

- **`discreteUpdates` is injected after construction** (`src/ink/events/dispatcher.ts:158-159`) to break an import cycle between the Dispatcher and the reconciler. Without injection, `dispatchDiscrete()` falls back to plain `dispatch()`.

- **Empty pastes are emitted** (`src/ink/parse-keypress.ts:237-240`) — downstream handlers use this to detect clipboard image handling on macOS where the paste content is empty but an image is on the clipboard.