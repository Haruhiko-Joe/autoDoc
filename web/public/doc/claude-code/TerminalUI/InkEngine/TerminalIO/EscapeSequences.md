# Escape Sequences

## Overview & Responsibilities

The EscapeSequences module (`src/ink/termio/`) is a complete ANSI escape sequence library providing both **generation** (writing control sequences to the terminal) and **parsing** (reading terminal input into structured semantic actions). It sits within the TerminalIO layer of the InkEngine, which itself is part of the TerminalUI subsystem. Sibling modules in InkEngine — the RenderPipeline, EventSystem, and SelectionAndFocus — depend on this module for SGR style encoding, tokenization, and keypress parsing.

The module is organized into two halves:

- **Generation**: Constants and helper functions that produce raw ANSI escape strings for cursor movement, erase, scroll, styling, DEC private modes, OSC hyperlinks/clipboard, and more.
- **Parsing**: A streaming tokenizer that splits raw terminal bytes into text vs. escape-sequence boundaries, and a semantic parser that interprets those sequences into structured `Action` objects with persistent style tracking.

The barrel module `src/ink/termio.ts` re-exports the `Parser` class and all public types for external consumers.

## Key Processes

### Escape Sequence Generation Flow

Generation is stateless — each function returns a complete escape string ready for `stdout.write()`:

1. **Base layer** (`ansi.ts`): Defines C0 control character codes (`ESC`, `BEL`, etc.) and sequence type introducers (`CSI = ESC [`, `OSC = ESC ]`, etc.)
2. **CSI sequences** (`csi.ts`): The `csi()` builder composes `ESC [ params final` strings. Higher-level helpers like `cursorUp()`, `eraseScreen()`, `scrollUp()`, `setScrollRegion()` call `csi()` internally
3. **OSC sequences** (`osc.ts`): The `osc()` builder composes `ESC ] command ; data BEL/ST` strings. Provides hyperlink generation (`link()`), clipboard write (`setClipboard()`), multiplexer passthrough (`wrapForMultiplexer()`), and tab status emission (`tabStatus()`)
4. **DEC private modes** (`dec.ts`): `decset()`/`decreset()` generate `ESC [ ? N h/l` sequences. Pre-built constants cover alt screen, mouse tracking, bracketed paste, focus events, synchronized output, and cursor visibility
5. **SGR styles** (`sgr.ts`): Used on the parsing side — `applySGR()` interprets SGR parameter strings into `TextStyle` mutations
6. **ESC sequences** (`esc.ts`): Handles simple two-character escape sequences (cursor save/restore via `ESC 7`/`ESC 8`, full reset via `ESC c`)

### Parsing Flow (Input → Structured Actions)

```
Raw input string
    │
    ▼
┌──────────┐     Token[]     ┌────────┐     Action[]
│Tokenizer │ ──────────────▶ │ Parser │ ──────────────▶  Consumers
│(tokenize)│  text/sequence  │(parser)│  semantic actions
└──────────┘                 └────────┘
                                 │
                          maintains TextStyle
                          and link state across
                          successive feed() calls
```

1. **Tokenization** (`tokenize.ts:99-319`): The `tokenize()` state machine processes input byte-by-byte through states: `ground`, `escape`, `csi`, `osc`, `dcs`, `apc`, `ss3`, `escapeIntermediate`. It emits `Token` objects — either `{ type: 'text', value }` for plain text or `{ type: 'sequence', value }` for complete escape sequences. Incomplete sequences at the end of input are buffered for the next `feed()` call.

2. **Sequence identification** (`parser.ts:245-256`): `identifySequence()` examines the second byte after ESC to classify into `csi`, `osc`, `esc`, or `ss3`.

3. **Semantic interpretation** (`parser.ts:287-394`): The `Parser.feed()` method processes each token:
   - **Text tokens**: Segmented into `Grapheme` objects (via `Intl.Segmenter`) with display width (1 or 2 columns for CJK/emoji), then wrapped with the current `TextStyle` to produce `{ type: 'text' }` actions
   - **CSI sequences**: Parsed by `parseCSI()` (`parser.ts:87-240`) into cursor, erase, scroll, mode, or SGR actions. SGR actions silently update `this.style` and are not emitted
   - **OSC sequences**: Parsed by `parseOSC()` (`osc.ts:256-310`) into title, link, or tabStatus actions. Link start/end actions update the parser's `inLink`/`linkUrl` state
   - **ESC sequences**: Parsed by `parseEsc()` (`esc.ts:14-67`) into cursor save/restore, reset, or movement actions

4. **Style tracking**: The `Parser` instance carries a mutable `TextStyle` across calls. SGR sequences update this style via `applySGR()` (`sgr.ts:127-308`), and all subsequent text actions inherit the current style snapshot.

### Clipboard Write Flow

`setClipboard()` (`osc.ts:138-158`) implements a multi-strategy clipboard write:

1. Fire `copyNative()` immediately (fire-and-forget) for local environments — uses `pbcopy` (macOS), `wl-copy`/`xclip`/`xsel` (Linux), or `clip` (Windows)
2. Attempt `tmuxLoadBuffer()` to load into tmux's paste buffer via `tmux load-buffer -w -`
3. If tmux succeeded, return a DCS-passthrough-wrapped OSC 52 sequence; otherwise return raw OSC 52
4. The caller writes the returned string to stdout

## Function Signatures

### Parser Class (`parser.ts`)

```typescript
class Parser {
  style: TextStyle       // Current text style state (readable)
  inLink: boolean        // Whether inside a hyperlink
  linkUrl: string | undefined

  feed(input: string): Action[]   // Process input, return semantic actions
  reset(): void                    // Reset all state
}
```

> Source: `src/ink/termio/parser.ts:272-394`

### Generation Functions

| Function | File | Description |
|----------|------|-------------|
| `csi(...args)` | `csi.ts:45` | Build a CSI sequence from params + final byte |
| `cursorUp(n)`, `cursorDown(n)`, `cursorForward(n)`, `cursorBack(n)` | `csi.ts:129-146` | Relative cursor movement |
| `cursorPosition(row, col)` | `csi.ts:157` | Absolute cursor positioning (1-indexed) |
| `cursorMove(x, y)` | `csi.ts:169` | Relative 2D cursor move |
| `eraseScreen()`, `eraseLine()`, `eraseLines(n)` | `csi.ts:225-250` | Display/line erase |
| `scrollUp(n)`, `scrollDown(n)` | `csi.ts:255-262` | Scroll buffer |
| `setScrollRegion(top, bottom)` | `csi.ts:265` | Set DECSTBM scroll region |
| `decset(mode)`, `decreset(mode)` | `dec.ts:27-33` | Set/reset DEC private modes |
| `osc(...parts)` | `osc.ts:18` | Build an OSC sequence |
| `link(url, params?)` | `osc.ts:403` | Start/end OSC 8 hyperlink |
| `setClipboard(text)` | `osc.ts:138` | Write to clipboard (async, multi-strategy) |
| `wrapForMultiplexer(sequence)` | `osc.ts:35` | DCS passthrough for tmux/screen |
| `tabStatus(fields)` | `osc.ts:476` | Emit OSC 21337 tab-status sequence |
| `applySGR(paramStr, style)` | `sgr.ts:127` | Apply SGR params to a TextStyle (returns new style) |

### Tokenizer Factory

```typescript
function createTokenizer(options?: { x10Mouse?: boolean }): Tokenizer

type Tokenizer = {
  feed(input: string): Token[]
  flush(): Token[]
  reset(): void
  buffer(): string
}
```

> Source: `src/ink/termio/tokenize.ts:57-92`

## Interface / Type Definitions

### Color (`types.ts:32-36`)

Discriminated union with four variants:

| Variant | Fields | Description |
|---------|--------|-------------|
| `named` | `name: NamedColor` | One of 16 standard terminal colors |
| `indexed` | `index: number` | 256-color palette (0-255) |
| `rgb` | `r, g, b: number` | 24-bit true color |
| `default` | — | Terminal default color |

### TextStyle (`types.ts:52-65`)

| Field | Type | Description |
|-------|------|-------------|
| `bold`, `dim`, `italic` | `boolean` | Text weight/style |
| `underline` | `UnderlineStyle` | `'none'` \| `'single'` \| `'double'` \| `'curly'` \| `'dotted'` \| `'dashed'` |
| `blink`, `inverse`, `hidden` | `boolean` | Display modifiers |
| `strikethrough`, `overline` | `boolean` | Line decorations |
| `fg`, `bg`, `underlineColor` | `Color` | Foreground, background, underline colors |

### Action (`types.ts:224-236`)

The top-level discriminated union output by the parser:

| Type | Payload | Produced by |
|------|---------|-------------|
| `text` | `graphemes: Grapheme[], style: TextStyle` | Text content with styling |
| `cursor` | `action: CursorAction` | Movement, position, save/restore, show/hide, style |
| `erase` | `action: EraseAction` | Display, line, or character erase |
| `scroll` | `action: ScrollAction` | Scroll up/down or set scroll region |
| `mode` | `action: ModeAction` | Alt screen, bracketed paste, mouse tracking, focus events |
| `link` | `action: LinkAction` | Hyperlink start (with URL) or end |
| `title` | `action: TitleAction` | Window title or icon name |
| `tabStatus` | `action: TabStatusAction` | Tab indicator/status metadata |
| `sgr` | `params: string` | Raw SGR (internal — consumed by parser, not emitted) |
| `bell` | — | Terminal bell |
| `reset` | — | Full terminal reset (ESC c) |
| `unknown` | `sequence: string` | Unrecognized sequence |

### Grapheme (`types.ts:218-221`)

```typescript
type Grapheme = {
  value: string    // The grapheme cluster string
  width: 1 | 2    // Display width in terminal columns
}
```

## Configuration & Defaults

- **OSC terminator**: `osc()` uses `ST` (ESC \\) for Kitty terminal (avoids beeps), `BEL` for all others. Determined by `env.terminal` at call time (`osc.ts:19`)
- **Clipboard strategy**: `getClipboardPath()` returns `'native'` on macOS without SSH, `'tmux-buffer'` inside tmux, or `'osc52'` as fallback (`osc.ts:64-70`)
- **Tab status gate**: `supportsTabStatus()` limits emission to `USER_TYPE === 'ant'` while the spec is unstable (`osc.ts:467-469`)
- **X10 mouse**: The tokenizer's `x10Mouse` option (default `false`) controls whether `CSI M` is treated as an X10 mouse prefix consuming 3 payload bytes. Only enabled for stdin — in output streams, `CSI M` means Delete Lines (`tokenize.ts:42-44`)

## Edge Cases & Caveats

- **SGR colon vs semicolon subparams**: The SGR parser (`sgr.ts:41-77`) handles both `;` (legacy) and `:` (modern ISO 8613-6) separated parameters for extended colors and underline styles. Colon-separated subparams are consumed in a single parameter slot; semicolon-separated extended colors consume 3 or 5 parameter slots
- **Streaming incomplete sequences**: The tokenizer buffers incomplete escape sequences between `feed()` calls. Call `flush()` to force-emit buffered data as a sequence token (`tokenize.ts:76-81`)
- **X10 mouse UTF-8 collision**: At terminal columns 162-191, X10 mouse coordinate bytes form valid UTF-8 multi-byte sequences. Since Node.js stdin uses UTF-8 encoding, the two bytes collapse to one character and the length check fails, causing the event to buffer until the next keypress (`tokenize.ts:221-227`)
- **tmux clipboard and iTerm2**: The `-w` flag on `tmux load-buffer` is dropped for iTerm2 because tmux's own OSC 52 emission crashes iTerm2 over SSH (`osc.ts:86-101`)
- **Linux clipboard probing**: On first clipboard copy on Linux, `copyNative()` probes `wl-copy` → `xclip` → `xsel` sequentially and caches the winner. Subsequent calls use the cached tool (`osc.ts:163-219`)
- **DEC mode constants**: Pre-built constants (`BSU`/`ESU`, `EBP`/`DBP`, etc.) are computed once at module load. The naming is terse — `BSU` = Begin Synchronized Update, `EBP` = Enable Bracketed Paste, etc. (`dec.ts:37-60`)
- **Hyperlink id generation**: `link()` auto-generates an `id=` parameter by hashing the URL, ensuring terminals group wrapped lines of the same link together per the OSC 8 spec (`osc.ts:412-417`)