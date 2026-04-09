# Layout

## Overview & Responsibilities

The Layout module is the CSS flexbox layout engine for Claude Code's terminal UI. It sits within the **InkEngine** layer of the **TerminalUI** subsystem, providing the spatial computation that determines where every UI element is positioned and how large it is on screen.

The module wraps Facebook's [Yoga](https://yogalayout.dev/) layout library — a cross-platform flexbox implementation — behind a clean TypeScript abstraction layer. This decouples the rest of the rendering pipeline from Yoga's native API, making it possible to swap layout backends without changing consuming code.

The module is organized into four files with distinct roles:

| File | Role |
|------|------|
| `geometry.ts` | Primitive geometric types and utility functions |
| `node.ts` | Abstract `LayoutNode` interface and flexbox enum definitions |
| `yoga.ts` | Concrete Yoga-backed implementation of `LayoutNode` |
| `engine.ts` | Factory entry point that creates layout nodes |

## Key Processes

### Layout Calculation Flow

1. **Node creation**: Consumers call `createLayoutNode()` (`src/ink/layout/engine.ts:4-6`), which delegates to `createYogaLayoutNode()`, instantiating a `YogaLayoutNode` wrapping a native Yoga node.
2. **Tree construction**: Nodes are assembled into a tree via `insertChild(child, index)` and `removeChild(child)`. This mirrors the React component tree produced by Ink's reconciler.
3. **Style configuration**: Flex properties are set on each node — dimensions, flex direction, alignment, padding, border, margins, gaps, overflow, and position type — using the style setter methods.
4. **Measure functions**: Leaf nodes that contain text register a `LayoutMeasureFunc` via `setMeasureFunc()`. During layout, Yoga calls this function to determine the intrinsic size of the content given a width constraint and measure mode.
5. **Layout execution**: `calculateLayout(width, height)` is called on the root node (`src/ink/layout/yoga.ts:82-84`). Yoga runs its flexbox algorithm over the entire tree, always using LTR direction.
6. **Result reading**: After layout, computed positions and sizes are read via `getComputedLeft()`, `getComputedTop()`, `getComputedWidth()`, `getComputedHeight()`, `getComputedPadding(edge)`, and `getComputedBorder(edge)`. The rendering pipeline uses these values to position output on screen.
7. **Cleanup**: Nodes are freed via `free()` (single node) or `freeRecursive()` (entire subtree).

### Abstraction Layer Pattern

The module uses a clear interface/implementation split:

- `node.ts` defines the `LayoutNode` interface and all layout-related enums using string literal unions (e.g., `LayoutFlexDirection`, `LayoutAlign`). These are the **only** types the rest of the codebase interacts with.
- `yoga.ts` provides `YogaLayoutNode`, which maps every abstract enum value to Yoga's native enum via lookup tables (e.g., `EDGE_MAP`, `GUTTER_MAP`, and inline maps in methods like `setFlexDirection`).
- `engine.ts` is a one-line factory that hides the concrete class entirely.

This means consumers never import from `yoga.ts` directly — they work exclusively with the `LayoutNode` interface.

## Function Signatures

### `createLayoutNode(): LayoutNode`

Factory function — the sole entry point for creating layout nodes. Returns a `LayoutNode` backed by Yoga.

> Source: `src/ink/layout/engine.ts:4-6`

### `edges(...)`: Edges

Overloaded factory for creating `Edges` values (used for padding, margin, border). Supports three call signatures:

- `edges(all)` — uniform value on all four sides
- `edges(vertical, horizontal)` — vertical (top/bottom) and horizontal (left/right)
- `edges(top, right, bottom, left)` — explicit per-side values

> Source: `src/ink/layout/geometry.ts:22-38`

### `addEdges(a: Edges, b: Edges): Edges`

Component-wise addition of two `Edges` values.

> Source: `src/ink/layout/geometry.ts:41-48`

### `resolveEdges(partial?: Partial<Edges>): Edges`

Converts a partial edges object to a full `Edges`, defaulting missing sides to `0`.

> Source: `src/ink/layout/geometry.ts:54-61`

### `unionRect(a: Rectangle, b: Rectangle): Rectangle`

Computes the bounding rectangle that contains both input rectangles.

> Source: `src/ink/layout/geometry.ts:63-69`

### `clampRect(rect: Rectangle, size: Size): Rectangle`

Clamps a rectangle to fit within a given size boundary.

> Source: `src/ink/layout/geometry.ts:71-82`

### `withinBounds(size: Size, point: Point): boolean`

Checks whether a point falls within a size boundary (origin at 0,0).

> Source: `src/ink/layout/geometry.ts:84-91`

### `clamp(value: number, min?: number, max?: number): number`

Generic numeric clamping utility.

> Source: `src/ink/layout/geometry.ts:93-97`

## Interface & Type Definitions

### `LayoutNode`

The core interface for layout tree nodes (`src/ink/layout/node.ts:93-152`). Methods are grouped into four categories:

| Category | Methods |
|----------|--------|
| **Tree** | `insertChild`, `removeChild`, `getChildCount`, `getParent` |
| **Layout computation** | `calculateLayout`, `setMeasureFunc`, `unsetMeasureFunc`, `markDirty` |
| **Computed results** | `getComputedLeft`, `getComputedTop`, `getComputedWidth`, `getComputedHeight`, `getComputedBorder`, `getComputedPadding` |
| **Style setters** | Dimensions (`setWidth`, `setHeight`, `setMin*`, `setMax*` — absolute, percent, and auto variants), flex (`setFlexDirection`, `setFlexGrow`, `setFlexShrink`, `setFlexBasis`, `setFlexWrap`), alignment (`setAlignItems`, `setAlignSelf`, `setJustifyContent`), box model (`setMargin`, `setPadding`, `setBorder`, `setGap`), positioning (`setPositionType`, `setPosition`, `setOverflow`), display (`setDisplay`, `getDisplay`) |
| **Lifecycle** | `free`, `freeRecursive` |

### `LayoutMeasureFunc`

```typescript
type LayoutMeasureFunc = (
  width: number,
  widthMode: LayoutMeasureMode,
) => { width: number; height: number }
```

Callback registered on leaf nodes to report intrinsic content size. The `widthMode` indicates whether the width constraint is `Exactly`, `AtMost`, or `Undefined`.

> Source: `src/ink/layout/node.ts:80-83`

### Geometry Types

| Type | Fields | Description |
|------|--------|-------------|
| `Point` | `x`, `y` | 2D coordinate |
| `Size` | `width`, `height` | 2D dimensions |
| `Rectangle` | `x`, `y`, `width`, `height` | `Point & Size` intersection |
| `Edges` | `top`, `right`, `bottom`, `left` | Edge insets for padding/margin/border |

### Layout Enums

All defined in `src/ink/layout/node.ts` as const-object + type-alias pairs:

| Enum | Values |
|------|--------|
| `LayoutEdge` | `all`, `horizontal`, `vertical`, `left`, `right`, `top`, `bottom`, `start`, `end` |
| `LayoutGutter` | `all`, `column`, `row` |
| `LayoutDisplay` | `flex`, `none` |
| `LayoutFlexDirection` | `row`, `row-reverse`, `column`, `column-reverse` |
| `LayoutAlign` | `auto`, `stretch`, `flex-start`, `center`, `flex-end` |
| `LayoutJustify` | `flex-start`, `center`, `flex-end`, `space-between`, `space-around`, `space-evenly` |
| `LayoutWrap` | `nowrap`, `wrap`, `wrap-reverse` |
| `LayoutPositionType` | `relative`, `absolute` |
| `LayoutOverflow` | `visible`, `hidden`, `scroll` |
| `LayoutMeasureMode` | `undefined`, `exactly`, `at-most` |

## Edge Cases & Caveats

- **Height is ignored during `calculateLayout`**: The Yoga adapter passes `undefined` for the height parameter (`src/ink/layout/yoga.ts:83`), regardless of what the caller provides. Layout is always constrained by width only, which is appropriate for a terminal where content flows vertically.
- **Direction is always LTR**: Layout is hardcoded to `Direction.LTR` — there is no RTL support.
- **`getParent()` creates a new wrapper**: Each call to `getParent()` wraps the Yoga parent in a fresh `YogaLayoutNode` instance (`src/ink/layout/yoga.ts:76-78`). This means identity comparison (`===`) on parent nodes won't work.
- **No WASM loading**: The TypeScript Yoga port is fully synchronous — there's no WASM binary to load or linear memory to manage. Nodes are plain JS objects available at import time (`src/ink/layout/yoga.ts:302-307`).
- **`ZERO_EDGES` is mutable**: The exported `ZERO_EDGES` constant (`src/ink/layout/geometry.ts:51`) is a plain object, not frozen. Callers should avoid mutating it.

## Key Code Snippets

### The Yoga-to-abstract enum mapping pattern

Every flexbox property uses the same translation strategy — a `Record` lookup from abstract string literal to Yoga native enum:

```typescript
// src/ink/layout/yoga.ts:177-185
setFlexDirection(dir: LayoutFlexDirection): void {
  const map: Record<LayoutFlexDirection, FlexDirection> = {
    row: FlexDirection.Row,
    'row-reverse': FlexDirection.RowReverse,
    column: FlexDirection.Column,
    'column-reverse': FlexDirection.ColumnReverse,
  }
  this.yoga.setFlexDirection(map[dir]!)
}
```

### Measure function adapter

The measure function bridges the abstract `LayoutMeasureMode` to Yoga's native `MeasureMode`:

```typescript
// src/ink/layout/yoga.ts:86-96
setMeasureFunc(fn: LayoutMeasureFunc): void {
  this.yoga.setMeasureFunc((w, wMode) => {
    const mode =
      wMode === MeasureMode.Exactly
        ? LayoutMeasureMode.Exactly
        : wMode === MeasureMode.AtMost
          ? LayoutMeasureMode.AtMost
          : LayoutMeasureMode.Undefined
    return fn(w, mode)
  })
}
```

### Edge factory overloads

The `edges()` function provides CSS-shorthand-style overloading:

```typescript
// src/ink/layout/geometry.ts:30-38
export function edges(a: number, b?: number, c?: number, d?: number): Edges {
  if (b === undefined) {
    return { top: a, right: a, bottom: a, left: a }
  }
  if (c === undefined) {
    return { top: a, right: b, bottom: a, left: b }
  }
  return { top: a, right: b, bottom: c, left: d! }
}