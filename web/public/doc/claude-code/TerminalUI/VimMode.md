# VimMode

## Overview & Responsibilities

VimMode is the vim-style input editing engine within the **TerminalUI** module. It provides vim keybindings for the text prompt, allowing users to navigate and edit their input using familiar vim motions, operators, and text objects. The module is a pure state machine—it receives keystrokes, maintains mode and command state, and produces cursor/text mutations through a context interface.

The implementation is split across five files, each with a focused responsibility:

| File | Role |
|------|------|
| `src/vim/types.ts` | State machine types, key group constants, state factories |
| `src/vim/motions.ts` | Pure functions resolving vim motions to cursor positions |
| `src/vim/operators.ts` | Execution logic for operators (delete, change, yank) and standalone commands |
| `src/vim/textObjects.ts` | Text object boundary detection (word, quote, bracket objects) |
| `src/vim/transitions.ts` | The state transition table—dispatches keystrokes to the appropriate handler |

## Key Processes

### State Machine Architecture

VimMode models the entire vim command grammar as a TypeScript discriminated union (`CommandState`). The top-level `VimState` has two modes:

- **INSERT**: Tracks `insertedText` for dot-repeat of insert operations
- **NORMAL**: Contains a `CommandState` sub-machine that parses multi-key commands

The `CommandState` progresses through states as keys arrive (`src/vim/types.ts:59-75`):

```
idle ──┬─[d/c/y]──► operator ──┬─[motion]──► execute
       ├─[1-9]────► count      ├─[0-9]────► operatorCount
       ├─[fFtT]───► find       ├─[ia]─────► operatorTextObj ──[w/"/(]──► execute
       ├─[g]──────► g          └─[fFtT]───► operatorFind ──[char]──► execute
       ├─[r]──────► replace
       └─[><]─────► indent
```

Each state knows exactly what input it expects. Unrecognized input resets to `idle`, matching vim's "cancel on invalid key" behavior.

### Keystroke Processing Flow

1. A key arrives in NORMAL mode and is passed to `transition()` (`src/vim/transitions.ts:59-88`)
2. `transition()` dispatches to the appropriate `from*` function based on the current `CommandState.type`
3. The handler returns a `TransitionResult` containing either:
   - `next`: a new `CommandState` (command still being built)
   - `execute`: a closure that performs the action via the `OperatorContext`
   - Both empty `{}`: input is ignored
4. The caller (VimTextInput component) applies the state update and/or runs the execute closure

### Operator Execution Flow

When an operator like `d2w` completes:

1. `fromOperator` sees `d` → enters `operator` state with `op: 'delete'`
2. `fromOperator` sees `2` → enters `operatorCount` state with `digits: '2'`
3. `fromOperatorCount` sees `w` → calls `executeOperatorMotion('delete', 'w', 2, ctx)`
4. `executeOperatorMotion` resolves the motion to a target cursor, computes the range, and calls `applyOperator` (`src/vim/operators.ts:42-54`)
5. `applyOperator` yanks content to the register, deletes text, and repositions the cursor (`src/vim/operators.ts:493-522`)
6. The change is recorded for dot-repeat

### Motion Resolution

Motions are pure functions that take a cursor position and return a new one (`src/vim/motions.ts:13-25`). The `resolveMotion` function applies a motion `count` times, stopping early if the cursor stops moving (boundary reached):

```typescript
// src/vim/motions.ts:13-25
export function resolveMotion(key: string, cursor: Cursor, count: number): Cursor {
  let result = cursor
  for (let i = 0; i < count; i++) {
    const next = applySingleMotion(key, result)
    if (next.equals(result)) break
    result = next
  }
  return result
}
```

Motions are classified as:
- **Inclusive** (`e`, `E`, `$`): the character at the destination is included in operator ranges
- **Linewise** (`j`, `k`, `G`, `gg`): operators extend to cover full lines
- **Exclusive** (everything else): the destination character is not included

### Text Object Resolution

Text objects (`iw`, `aw`, `i"`, `a(`, etc.) are resolved by `findTextObject` (`src/vim/textObjects.ts:38-58`), which dispatches to specialized finders:

- **Word objects** (`w`, `W`): Uses grapheme segmentation to find word boundaries. `iw` selects the word itself; `aw` includes surrounding whitespace.
- **Quote objects** (`"`, `'`, `` ` ``): Scans the current line for paired quotes and selects between them.
- **Bracket objects** (`(`, `[`, `{`, `<` and aliases `b`, `B`): Performs depth-aware matching to find the enclosing pair.

The `inner` vs `around` scope determines whether delimiters/surrounding whitespace are included.

## Function Signatures

### State Machine

#### `transition(state, input, ctx): TransitionResult`
Main entry point. Takes the current `CommandState`, a single key input, and a `TransitionContext`. Returns either a new state, an execute closure, or both.
> `src/vim/transitions.ts:59-88`

#### `createInitialVimState(): VimState`
Returns the initial state: `{ mode: 'INSERT', insertedText: '' }`.
> `src/vim/types.ts:188-190`

#### `createInitialPersistentState(): PersistentState`
Returns empty persistent state (no last change, no register contents).
> `src/vim/types.ts:192-199`

### Motions

#### `resolveMotion(key, cursor, count): Cursor`
Applies a named motion `count` times from the given cursor position. Pure function.
> `src/vim/motions.ts:13-25`

#### `isInclusiveMotion(key): boolean` / `isLinewiseMotion(key): boolean`
Classify a motion for operator range computation.
> `src/vim/motions.ts:72-82`

### Operators

#### `executeOperatorMotion(op, motion, count, ctx): void`
Executes an operator combined with a simple motion (e.g., `d2w`, `cj`).
> `src/vim/operators.ts:42-54`

#### `executeOperatorFind(op, findType, char, count, ctx): void`
Executes an operator with a find motion (e.g., `df,`, `ct"`).
> `src/vim/operators.ts:59-75`

#### `executeOperatorTextObj(op, scope, objType, count, ctx): void`
Executes an operator with a text object (e.g., `diw`, `ca"`).
> `src/vim/operators.ts:80-97`

#### `executeLineOp(op, count, ctx): void`
Executes line-wise operations (`dd`, `cc`, `yy`) with optional count.
> `src/vim/operators.ts:102-166`

#### `executeX(count, ctx): void`
Deletes characters under cursor (`x` command). Grapheme-aware.
> `src/vim/operators.ts:171-194`

#### `executeReplace(char, count, ctx): void`
Replaces characters under cursor (`r` command). Grapheme-aware.
> `src/vim/operators.ts:199-217`

#### `executeToggleCase(count, ctx): void`
Toggles case of characters under cursor (`~` command).
> `src/vim/operators.ts:222-253`

#### `executeJoin(count, ctx): void`
Joins current line with next line(s) (`J` command), trimming leading whitespace.
> `src/vim/operators.ts:258-289`

#### `executePaste(after, count, ctx): void`
Pastes register contents (`p`/`P`). Handles both linewise and characterwise registers.
> `src/vim/operators.ts:294-343`

#### `executeIndent(dir, count, ctx): void`
Indents/dedents lines (`>>`, `<<`). Uses 2-space indentation.
> `src/vim/operators.ts:348-392`

#### `executeOpenLine(direction, ctx): void`
Opens a new line above or below (`o`/`O`) and enters insert mode.
> `src/vim/operators.ts:397-416`

#### `executeOperatorG(op, count, ctx): void`
Executes an operator to end-of-file or line N (`dG`, `cG`).
> `src/vim/operators.ts:524-539`

#### `executeOperatorGg(op, count, ctx): void`
Executes an operator to start-of-file or line N (`dgg`, `cgg`).
> `src/vim/operators.ts:541-556`

### Text Objects

#### `findTextObject(text, offset, objectType, isInner): TextObjectRange`
Returns `{ start, end }` range for the requested text object, or `null` if not found.
> `src/vim/textObjects.ts:38-58`

## Interface/Type Definitions

### `VimState`
Top-level mode state. Either `{ mode: 'INSERT'; insertedText: string }` or `{ mode: 'NORMAL'; command: CommandState }`.
> `src/vim/types.ts:49-51`

### `CommandState`
Discriminated union of 11 states representing every stage of command parsing in NORMAL mode.
> `src/vim/types.ts:59-75`

### `PersistentState`
Cross-command memory: `lastChange` (for dot-repeat), `lastFind` (for `;`/`,`), `register` (yank buffer), and `registerIsLinewise`.
> `src/vim/types.ts:81-86`

### `RecordedChange`
Union of all repeatable change types: `insert`, `operator`, `operatorTextObj`, `operatorFind`, `replace`, `x`, `toggleCase`, `indent`, `openLine`, `join`. Used by dot-repeat to replay the last editing command.
> `src/vim/types.ts:92-119`

### `OperatorContext`
The interface operators use to interact with the text buffer. Fields:

| Field | Type | Description |
|-------|------|-------------|
| `cursor` | `Cursor` | Current cursor position |
| `text` | `string` | Current text content |
| `setText` | `(text: string) => void` | Replace the entire text |
| `setOffset` | `(offset: number) => void` | Move cursor to offset |
| `enterInsert` | `(offset: number) => void` | Switch to INSERT mode at offset |
| `getRegister` | `() => string` | Read yank register |
| `setRegister` | `(content: string, linewise: boolean) => void` | Write yank register |
| `getLastFind` | `() => { type, char } \| null` | Get last find for `;`/`,` |
| `setLastFind` | `(type, char) => void` | Record a find for repeat |
| `recordChange` | `(change: RecordedChange) => void` | Record change for dot-repeat |

> `src/vim/operators.ts:26-37`

### `TransitionContext`
Extends `OperatorContext` with optional `onUndo` and `onDotRepeat` callbacks.
> `src/vim/transitions.ts:43-46`

### `TransitionResult`
Return type of `transition()`: optional `next` state and/or `execute` closure.
> `src/vim/transitions.ts:51-54`

### `TextObjectRange`
`{ start: number; end: number } | null` — the byte offsets of a matched text object.
> `src/vim/textObjects.ts:14`

## Configuration & Defaults

- **Maximum count**: `MAX_VIM_COUNT = 10000` — prevents runaway counts (`src/vim/types.ts:182`)
- **Indent size**: 2 spaces, hardcoded in `executeIndent` (`src/vim/operators.ts:357`)
- **Initial mode**: INSERT (not NORMAL), so users can type immediately (`src/vim/types.ts:189`)
- **Count multipliers**: When both a prefix count and an operator count exist (e.g., `2d3w`), they are multiplied together (`src/vim/transitions.ts:327`)

## Supported Commands Reference

| Category | Keys | Description |
|----------|------|-------------|
| **Movement** | `h` `l` `j` `k` | Left, right, down (logical), up (logical) |
| **Movement** | `gj` `gk` | Down/up by display line |
| **Word** | `w` `b` `e` `W` `B` `E` | Word/WORD forward, backward, end |
| **Line** | `0` `^` `$` | Start, first non-blank, end of line |
| **Document** | `gg` `G` | First/last line (or line N with count) |
| **Find** | `f` `F` `t` `T` | Find char forward/backward, to/till |
| **Find repeat** | `;` `,` | Repeat last find, repeat reversed |
| **Operators** | `d` `c` `y` | Delete, change, yank (+ motion/text obj) |
| **Line ops** | `dd` `cc` `yy` | Delete/change/yank entire line |
| **Shortcuts** | `D` `C` `Y` | Delete/change to EOL, yank line |
| **Editing** | `x` `r` `~` `J` | Delete char, replace char, toggle case, join lines |
| **Paste** | `p` `P` | Paste after/before cursor |
| **Indent** | `>>` `<<` | Indent/dedent current line |
| **Insert entry** | `i` `I` `a` `A` `o` `O` | Various ways to enter insert mode |
| **Text objects** | `iw` `aw` `iW` `aW` | Inner/around word/WORD |
| **Text objects** | `i"` `a"` `i'` `a'` `` i` `` `` a` `` | Inner/around quotes |
| **Text objects** | `i(` `a(` `i[` `a[` `i{` `a{` `i<` `a<` | Inner/around brackets |
| **Repeat** | `.` | Dot-repeat last change |
| **Undo** | `u` | Undo last change |

## Edge Cases & Caveats

- **`cw`/`cW` special case**: Unlike `dw`, the `cw` motion changes to the end of the current word (not the start of the next word), matching real vim behavior (`src/vim/operators.ts:441-450`).
- **Grapheme awareness**: All character operations (`x`, `r`, `~`, word motions) operate on grapheme clusters, correctly handling emoji and combining characters.
- **Linewise paste detection**: Linewise register content is identified by a trailing `\n`. When pasting, linewise content inserts whole lines; characterwise content inserts inline.
- **Image chip snapping**: Operator ranges snap to encompass complete `[Image #N]` placeholders, preventing partial deletion of image references (`src/vim/operators.ts:471-472`).
- **Empty replace cancellation**: `r` followed by backspace (empty input) cancels the replace rather than deleting the character (`src/vim/transitions.ts:444-446`).
- **Last-line delete edge case**: Deleting the last line includes the preceding newline to avoid leaving a trailing blank line (`src/vim/operators.ts:135-141`).
- **Count cap**: Counts are clamped to 10,000 to prevent accidental massive operations.
- **Quote pairing strategy**: Quote text objects pair quotes sequentially (0-1, 2-3, 4-5) on the current line, which means escaped quotes or odd numbers of quotes may not resolve correctly (`src/vim/textObjects.ts:136-143`).
- **Bracket matching is single-character**: Bracket text objects match single characters only—no support for multi-character delimiters or escaped brackets (`src/vim/textObjects.ts:149-186`).