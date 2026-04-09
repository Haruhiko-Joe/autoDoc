# DOM and Styles

## Overview & Responsibilities

This module defines the virtual DOM that the Ink rendering engine's React reconciler operates on. It sits within the **InkEngine** layer of the **TerminalUI** subsystem — the foundational data model that components like `Box`, `Text`, and `ScrollBox` compile down to, and that the Yoga-based layout engine and ANSI output pipeline consume.

The module spans four files with distinct responsibilities:

- **`dom.ts`** — Node types (`DOMElement`, `TextNode`), tree mutation functions (append, insert, remove), dirty tracking, attribute/style setters, and text measurement integration
- **`styles.ts`** — The `Styles` and `TextStyles` type definitions mapping CSS-like properties to Yoga layout calls, plus the `applyStyles` function that translates them onto `LayoutNode`
- **`squash-text-nodes.ts`** — Flattening nested inline text nodes into a single string (for measurement) or into styled segments (for rendering)
- **`node-cache.ts`** — A `WeakMap` cache of rendered layout bounds used by the blit/incremental rendering optimization

## Key Processes

### Node Creation and Tree Assembly

When the React reconciler creates a component instance, it calls `createNode(nodeName)` (`src/ink/dom.ts:110-132`). This:

1. Allocates a `DOMElement` with empty `style`, `attributes`, `childNodes`, and `dirty: false`
2. Creates a backing Yoga `LayoutNode` for nodes that participate in layout (`ink-root`, `ink-box`, `ink-text`, `ink-raw-ansi`). Nodes like `ink-virtual-text`, `ink-link`, and `ink-progress` are layout-invisible — they have no `yogaNode`
3. Attaches a measure function for `ink-text` (calls `measureTextNode`) and `ink-raw-ansi` (reads pre-computed dimensions from attributes)

Tree mutations go through three functions that keep the DOM child list and Yoga tree in sync:

- **`appendChildNode`** — Appends a child, auto-removing it from any prior parent first. Inserts the child's `yogaNode` at the end of the parent's Yoga children (`src/ink/dom.ts:134-153`)
- **`insertBeforeNode`** — Inserts before a reference node. Carefully computes the correct Yoga index by counting only children that have `yogaNode`s, since DOM and Yoga indices can diverge (`src/ink/dom.ts:155-202`)
- **`removeChildNode`** — Detaches from both DOM and Yoga trees, then collects cached layout rects from the removed subtree via `collectRemovedRects` so the renderer can clear their screen area (`src/ink/dom.ts:204-223`)

### Dirty Tracking and Render Scheduling

Every mutation (child add/remove, attribute change, style change, text value change) calls `markDirty(node)` (`src/ink/dom.ts:393-413`), which:

1. Walks from the mutated node up to the root, setting `dirty = true` on every `DOMElement` ancestor
2. If the originating node is an `ink-text` or `ink-raw-ansi` leaf, also calls `yogaNode.markDirty()` to trigger Yoga re-measurement on the next layout pass

For DOM-level mutations that bypass React (e.g., imperative scroll changes), `scheduleRenderFrom(node)` walks to the root and invokes its `onRender` callback — the throttled render scheduler (`src/ink/dom.ts:419-423`).

The setters include change-detection to avoid unnecessary dirty marking:
- `setAttribute` skips if the value is unchanged and ignores `'children'` entirely (`src/ink/dom.ts:247-264`)
- `setStyle` and `setTextStyles` perform shallow equality checks since React allocates new style objects on every render even when values haven't changed (`src/ink/dom.ts:266-293`)

### Style Application to Yoga Layout

The default export of `styles.ts` is the `styles()` function (`src/ink/styles.ts:755-771`), which translates a `Styles` object into Yoga layout node calls. It delegates to nine category-specific appliers:

1. **Position** — `absolute`/`relative` positioning and edge offsets (supports both pixel and percent values)
2. **Overflow** — Maps `visible`/`hidden`/`scroll` to Yoga overflow modes. `scroll` additionally signals the renderer to apply scrollTop translation
3. **Margin** — All/X/Y/individual edge margins
4. **Padding** — All/X/Y/individual edge padding
5. **Flex** — `flexGrow`, `flexShrink`, `flexDirection`, `flexBasis`, `flexWrap`, `alignItems`, `alignSelf`, `justifyContent`
6. **Dimensions** — `width`/`height`/`min*`/`max*` with number or percent string support
7. **Display** — `flex` or `none`
8. **Border** — Computes 0 or 1 pixel border widths per edge, respecting individual `borderTop`/`borderBottom`/etc. overrides
9. **Gap** — `gap`, `columnGap`, `rowGap` via Yoga gutter API

### Text Node Squashing

`ink-text` nodes can contain nested `ink-virtual-text`, `ink-link`, and raw `#text` children forming an inline text subtree. Before measurement or rendering, this tree must be flattened:

- **`squashTextNodes(node)`** (`src/ink/squash-text-nodes.ts:69-90`) — Returns a plain string concatenation of all `#text` `nodeValue`s in the subtree. Used by `measureTextNode` for layout measurement
- **`squashTextNodesToSegments(node, inheritedStyles)`** (`src/ink/squash-text-nodes.ts:18-63`) — Returns an array of `StyledSegment` objects, each carrying the text content, merged `TextStyles`, and optional hyperlink URL. Styles are inherited: each `ink-text`/`ink-virtual-text` node's `textStyles` are merged over the parent's styles, and `ink-link` nodes contribute their `href` attribute

### Text Measurement

`measureTextNode` (`src/ink/dom.ts:332-374`) is the Yoga measure function bound to `ink-text` nodes. It:

1. Squashes the text subtree into a plain string
2. Expands tabs (worst-case 8 spaces for measurement)
3. Measures the natural dimensions
4. If text fits within the container width, returns as-is
5. For pre-wrapped content (embedded newlines) with `Undefined` width mode, avoids re-wrapping to prevent height inflation
6. Otherwise wraps according to the node's `textWrap` style property and re-measures

`measureRawAnsiNode` (`src/ink/dom.ts:379-387`) is simpler — it reads pre-computed `rawWidth`/`rawHeight` from the node's attributes, since `ink-raw-ansi` content is already formatted by its producer.

### Node Cache and Pending Clears

The `nodeCache` (`src/ink/node-cache.ts:18`) is a `WeakMap<DOMElement, CachedLayout>` that stores the screen-space bounding rectangle of each rendered node. This powers the blit optimization: if a node's cached rect hasn't changed, the renderer can skip re-painting it.

When nodes are removed from the tree, `collectRemovedRects` (`src/ink/dom.ts:225-245`) walks the removed subtree and moves each node's cached rect into `pendingClears` so the renderer can erase those screen areas. For absolute-positioned nodes, the `absoluteNodeRemoved` flag is set (`src/ink/node-cache.ts:50-54`), which disables blit for the next frame — because absolute nodes can paint over non-siblings, a simple parent-scoped clear isn't sufficient.

## Function Signatures & Parameters

### `createNode(nodeName: ElementNames): DOMElement`

Creates a new DOM element with optional Yoga backing node. Attaches measure functions for `ink-text` and `ink-raw-ansi` nodes.

> Source: `src/ink/dom.ts:110-132`

### `appendChildNode(node: DOMElement, childNode: DOMElement): void`

Appends `childNode` to `node`. Auto-removes from prior parent. Syncs Yoga tree.

> Source: `src/ink/dom.ts:134-153`

### `insertBeforeNode(node: DOMElement, newChildNode: DOMNode, beforeChildNode: DOMNode): void`

Inserts `newChildNode` before `beforeChildNode` in the parent's child list. Falls back to append if the reference node is not found.

> Source: `src/ink/dom.ts:155-202`

### `removeChildNode(node: DOMElement, removeNode: DOMNode): void`

Removes a child from both the DOM and Yoga trees. Collects removed rects for screen clearing.

> Source: `src/ink/dom.ts:204-223`

### `markDirty(node?: DOMNode): void`

Marks a node and all ancestors as dirty. Triggers Yoga re-measurement for text/raw-ansi leaf nodes.

> Source: `src/ink/dom.ts:393-413`

### `scheduleRenderFrom(node?: DOMNode): void`

Walks to the root and calls its `onRender` callback to schedule an Ink frame without going through React.

> Source: `src/ink/dom.ts:419-423`

### `setAttribute(node: DOMElement, key: string, value: DOMNodeAttribute): void`

Sets an attribute, skipping if unchanged. Ignores `'children'` key.

> Source: `src/ink/dom.ts:247-264`

### `setStyle(node: DOMNode, style: Styles): void`

Sets layout styles with shallow equality guard to prevent spurious dirty marking.

> Source: `src/ink/dom.ts:266-274`

### `setTextStyles(node: DOMElement, textStyles: TextStyles): void`

Sets text rendering styles with shallow equality guard.

> Source: `src/ink/dom.ts:276-289`

### `squashTextNodesToSegments(node, inheritedStyles?, inheritedHyperlink?, out?): StyledSegment[]`

Recursively flattens an inline text subtree into styled segments with inherited styles and hyperlinks.

> Source: `src/ink/squash-text-nodes.ts:18-63`

### `styles(node: LayoutNode, style?: Styles, resolvedStyle?: Styles): void`

Applies all CSS-like style properties to a Yoga layout node. The `resolvedStyle` parameter provides the full current style for border resolution when `style` is a diff.

> Source: `src/ink/styles.ts:755-771`

## Type Definitions

### `DOMElement` (`src/ink/dom.ts:31-91`)

The primary element node type. Key fields:

| Field | Type | Purpose |
|-------|------|---------|
| `nodeName` | `ElementNames` | One of `ink-root`, `ink-box`, `ink-text`, `ink-virtual-text`, `ink-link`, `ink-progress`, `ink-raw-ansi` |
| `attributes` | `Record<string, DOMNodeAttribute>` | Arbitrary key-value attributes |
| `childNodes` | `DOMNode[]` | Ordered list of children |
| `style` | `Styles` | Layout style properties |
| `textStyles` | `TextStyles` | Text rendering properties (color, bold, etc.) |
| `yogaNode` | `LayoutNode \| undefined` | Backing Yoga layout node (absent for virtual-text, link, progress) |
| `parentNode` | `DOMElement \| undefined` | Parent reference |
| `dirty` | `boolean` | Whether this node needs re-rendering |
| `isHidden` | `boolean` | Set by reconciler's `hideInstance`/`unhideInstance` |
| `_eventHandlers` | `Record<string, unknown>` | Event handlers stored separately from attributes to avoid dirtying on handler identity changes |
| `scrollTop`, `pendingScrollDelta`, `scrollHeight`, etc. | `number` | Scroll state for `overflow: 'scroll'` boxes |
| `scrollAnchor` | `{ el, offset }` | One-shot scroll-to-element target, read at paint time |
| `focusManager` | `FocusManager` | Only on `ink-root`; document-level focus management |

### `TextNode` (`src/ink/dom.ts:93-96`)

A text leaf node with `nodeName: '#text'` and a `nodeValue: string`.

### `Styles` (`src/ink/styles.ts:55-404`)

CSS-like layout properties including:
- **Positioning**: `position`, `top`/`bottom`/`left`/`right` (number or percent)
- **Flex layout**: `flexGrow`, `flexShrink`, `flexDirection`, `flexBasis`, `flexWrap`, `alignItems`, `alignSelf`, `justifyContent`
- **Box model**: `margin*`, `padding*`, `width`, `height`, `min*`, `max*`
- **Display**: `display` (`flex` | `none`)
- **Overflow**: `overflow`, `overflowX`, `overflowY` (`visible` | `hidden` | `scroll`)
- **Border**: `borderStyle`, per-edge visibility/color/dim, `borderText`
- **Visual**: `backgroundColor`, `opaque`, `noSelect`
- **Text**: `textWrap` (8 wrapping modes including `wrap`, `truncate-end`, `truncate-middle`, etc.)
- **Gap**: `gap`, `columnGap`, `rowGap`

### `TextStyles` (`src/ink/styles.ts:44-53`)

Structured text styling without ANSI transforms:

| Property | Type | Description |
|----------|------|-------------|
| `color` | `Color` | Foreground color (rgb, hex, ansi256, or named ansi) |
| `backgroundColor` | `Color` | Background color |
| `dim` | `boolean` | Dimmed text |
| `bold` | `boolean` | Bold weight |
| `italic` | `boolean` | Italic style |
| `underline` | `boolean` | Underlined text |
| `strikethrough` | `boolean` | Strikethrough decoration |
| `inverse` | `boolean` | Inverted fg/bg colors |

### `Color` (`src/ink/styles.ts:37`)

Union type supporting four color formats: `` `rgb(${number},${number},${number})` ``, `` `#${string}` ``, `` `ansi256(${number})` ``, and 16 named ANSI colors (e.g., `'ansi:red'`, `'ansi:cyanBright'`).

### `StyledSegment` (`src/ink/squash-text-nodes.ts:8-12`)

A text fragment with its resolved styles and optional hyperlink URL, produced by `squashTextNodesToSegments`.

### `CachedLayout` (`src/ink/node-cache.ts:10-16`)

Screen-space bounding box (`x`, `y`, `width`, `height`) plus an optional `top` field storing the Yoga-local `getComputedTop()` for scroll viewport culling optimization.

## Edge Cases & Caveats

- **Yoga/DOM index mismatch**: Not all DOM children have Yoga nodes (`ink-virtual-text`, `ink-link`, `ink-progress` are layout-invisible). `insertBeforeNode` manually counts Yoga-backed siblings to compute the correct insertion index (`src/ink/dom.ts:173-180`)

- **React style object identity**: React creates new style objects on every render even when values are unchanged. The DOM layer performs shallow equality checks in `setStyle` and `setTextStyles` to avoid spurious dirty marking and Yoga re-measurement

- **`children` attribute skipped**: `setAttribute` ignores the `'children'` key because React always passes a new `children` reference, which would mark every node dirty every render (`src/ink/dom.ts:255-257`)

- **Event handlers stored separately**: `_eventHandlers` is deliberately kept outside `attributes` so that handler identity changes (common with inline arrow functions) don't trigger dirty marking and defeat the blit optimization (`src/ink/dom.ts:49-51`)

- **Absolute-positioned removal**: When an absolute-positioned node is removed, the blit optimization is disabled for the entire next frame via `absoluteNodeRemoved`. This is because absolute nodes can paint over arbitrary non-siblings, so a parent-scoped clear is insufficient (`src/ink/node-cache.ts:24-31`)

- **Scroll delta throttling**: `pendingScrollDelta` accumulates scroll input that is drained at `SCROLL_MAX_PER_FRAME` rows per frame, providing smooth scroll animation instead of jumpy teleportation (`src/ink/dom.ts:59-62`)

- **Text measurement with embedded newlines**: In `Undefined` width mode (intrinsic sizing), pre-wrapped text is not re-wrapped to avoid height inflation. But in `Exactly`/`AtMost` modes, the constraint is respected to prevent truncation (`src/ink/dom.ts:357-368`)

- **`scrollAnchor` is one-shot**: Set by `ScrollBox.scrollToElement`, consumed and cleared at paint time. This defers the position read to when Yoga layout data is fresh, avoiding stale scrollTop values from throttled renders (`src/ink/dom.ts:76-82`)