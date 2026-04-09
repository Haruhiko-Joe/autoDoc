# Design System

## Overview & Responsibilities

The Design System module provides the reusable UI primitives and building blocks that compose the visual layer of Claude Code's terminal interface. It sits within the **TerminalUI → Components** hierarchy and is consumed by screens, dialogs, and interactive flows across the application.

The module spans four directories:

| Directory | Purpose |
|-----------|---------|
| `src/components/design-system/` | Core primitives — theming, layout, text, icons, dialogs, progress indicators |
| `src/components/CustomSelect/` | Single and multi-select dropdown components with keyboard navigation |
| `src/components/ui/` | Higher-level composed widgets — OrderedList, TreeSelect |
| `src/components/wizard/` | Multi-step wizard framework with navigation and dialog layout |

All components are built on the Ink rendering engine (React for CLI) and use the React Compiler runtime for automatic memoization.

---

## Theming Infrastructure

### ThemeProvider

`src/components/design-system/ThemeProvider.tsx`

The `ThemeProvider` is a React context provider that manages theme selection across the application. It wraps a `ThemeContext` that stores both the raw user setting (`ThemeSetting`, which may be `'auto'`) and the resolved theme name (`ThemeName`, which is never `'auto'`).

**Internal context shape:**

```ts
type ThemeContextValue = {
  /** The saved user preference. May be 'auto'. */
  themeSetting: ThemeSetting
  setThemeSetting: (setting: ThemeSetting) => void
  setPreviewTheme: (setting: ThemeSetting) => void
  savePreview: () => void
  cancelPreview: () => void
  /** The resolved theme to render with. Never 'auto'. */
  currentTheme: ThemeName
}
```

> Source: `src/components/design-system/ThemeProvider.tsx:8-17`

**Key behaviors:**

- **Auto-detection**: When `themeSetting` is `'auto'`, seeds from `$COLORFGBG` then starts an OSC 11 terminal background color watcher that updates `systemTheme` live (`src/components/design-system/ThemeProvider.tsx:53, 64-80`)
- **Preview mode**: `setPreviewTheme` temporarily overrides the active setting without persisting. `savePreview()` commits it; `cancelPreview()` reverts (`src/components/design-system/ThemeProvider.tsx:95-112`)
- **Persistence**: `setThemeSetting` saves to global config via `saveGlobalConfig` (`src/components/design-system/ThemeProvider.tsx:84-94`)
- **Resolution**: `currentTheme = activeSetting === 'auto' ? systemTheme : activeSetting` (`src/components/design-system/ThemeProvider.tsx:81`)

**Exported hooks:**

| Hook | Returns | Description |
|------|---------|-------------|
| `useTheme()` | `[ThemeName, setThemeSetting]` | The resolved theme name (never `'auto'`) and the setter that accepts any `ThemeSetting` including `'auto'` |
| `useThemeSetting()` | `ThemeSetting` | The raw saved preference — may be `'auto'`, `'dark'`, or `'light'` |
| `usePreviewTheme()` | `{ setPreviewTheme, savePreview, cancelPreview }` | Controls for the preview workflow |

> Source: `src/components/design-system/ThemeProvider.tsx:122-155`

The default theme is `'dark'`. The default context value is set so that `useTheme()` works without a provider in tests and tooling (`src/components/design-system/ThemeProvider.tsx:19-28`).

### color utility

`src/components/design-system/color.ts`

A curried function that resolves theme color keys to raw ANSI color values:

```ts
color(c: string | undefined, theme: Theme, type?: 'foreground' | 'background'): (text: string) => string
```

It supports raw color passthrough for values prefixed with `rgb(`, `#`, `ansi256(`, or `ansi:`, and delegates to Ink's `colorize` function for rendering.

---

## Themed Wrappers

### ThemedText

`src/components/design-system/ThemedText.tsx`

A theme-aware `Text` component that resolves theme color keys (e.g., `"suggestion"`, `"error"`) to actual ANSI colors. Uses `useTheme()` to get the resolved `ThemeName`, then calls `getTheme(themeName)` to obtain the full theme object for color lookup.

**Color resolution logic** (`src/components/design-system/ThemedText.tsx:104`):

```ts
const resolvedColor =
  !color && hoverColor ? resolveColor(hoverColor, theme)   // (1) hover fills in when no explicit color
  : dimColor            ? theme.inactive as Color           // (2) dimColor overrides explicit color
  :                       resolveColor(color, theme)        // (3) explicit color resolved normally
```

The precedence is:

1. **Hover color** (from `TextHoverColorContext`) — applies only when no explicit `color` prop is set. This lets a parent set a hover color that propagates to uncolored children without overriding intentionally colored ones.
2. **`dimColor`** — when `true`, forces the theme's `inactive` color, even overriding an explicit `color` prop. This is intentional: dim is used as a hard override for disabled/inactive states, and is compatible with `bold` (unlike ANSI dim).
3. **Explicit `color` prop** — resolved via `resolveColor()`, which checks for raw color prefixes (`rgb(`, `#`, `ansi256(`, `ansi:`) and passes them through, or looks up theme keys.

**`TextHoverColorContext`** (`src/components/design-system/ThemedText.tsx:11`):

A React context that colors uncolored `ThemedText` instances in the subtree. Crosses `Box` boundaries (unlike Ink's native style cascade). Used by hover/highlight UI to tint child text without requiring each child to accept a color prop.

**Props:**

```ts
type Props = {
  color?: keyof Theme | Color
  backgroundColor?: keyof Theme
  dimColor?: boolean          // default: false
  bold?: boolean              // default: false
  italic?: boolean            // default: false
  underline?: boolean         // default: false
  strikethrough?: boolean     // default: false
  inverse?: boolean           // default: false
  wrap?: 'wrap' | 'truncate-start' | 'truncate-middle' | 'truncate-end'  // default: 'wrap'
  children?: ReactNode
}
```

> Source: `src/components/design-system/ThemedText.tsx:12-61`

### ThemedBox

`src/components/design-system/ThemedBox.tsx`

A theme-aware `Box` component that resolves theme color keys for all border and background colors:

- `borderColor`, `borderTopColor`, `borderBottomColor`, `borderLeftColor`, `borderRightColor`
- `backgroundColor`

Wraps the base Ink `Box` with theme resolution applied to each color property.

---

## Layout & Structure Components

### Dialog

`src/components/design-system/Dialog.tsx`

A confirmation dialog wrapper with:

- Configurable `title` and `subtitle`
- `onCancel` handler triggered by Esc/n keybindings
- Ctrl+C/D exit support via `useExitOnCtrlCDWithKeybindings`
- Optional custom `inputGuide` content that receives exit state
- Themed border via `Pane`

```ts
type DialogProps = {
  title: string
  subtitle?: string
  children: ReactNode
  onCancel?: () => void
  color?: keyof Theme
  borders?: boolean
  inputGuide?: ReactNode | ((exitState) => ReactNode)
  hideInputGuide?: boolean
  isCancelActive?: boolean
}
```

### Pane

`src/components/design-system/Pane.tsx`

A framed content region with a colored top border and padding. Detects whether it's inside a modal context and adjusts rendering accordingly. Used for slash-command screens like `/config`, `/help`, `/plugins`, `/sandbox`, `/stats`, `/permissions`.

### Divider

`src/components/design-system/Divider.tsx`

A horizontal rule with optional centered title. Configurable character (default: `─`), color, width, and padding. Titles are rendered with ANSI formatting surrounded by the divider line.

### Ratchet

`src/components/design-system/Ratchet.tsx`

A height-locking component that prevents layout jitter during viewport visibility changes. Two modes:

- `"always"` — locks height permanently after first measurement
- `"when-offscreen"` — only locks when the element is off-screen

Uses refs and `useLayoutEffect` to measure and constrain element height.

---

## Display Components

### StatusIcon

`src/components/design-system/StatusIcon.tsx`

Renders status indicator icons with theme-appropriate colors:

| Status | Icon | Color |
|--------|------|-------|
| `success` | ✓ | `success` |
| `error` | ✗ | `error` |
| `warning` | ⚠ | `warning` |
| `info` | ℹ | `info` |
| `pending` | ○ | `secondaryText` |
| `loading` | … | `secondaryText` |

Accepts an optional `trailingSpace` prop (default: `true`).

### ProgressBar

`src/components/design-system/ProgressBar.tsx`

A text-based progress bar using Unicode block characters (`▏▎▍▌▋▊▉█`) for sub-character precision:

```ts
type Props = {
  ratio: number       // 0 to 1
  width?: number      // character width (default: 20)
  fillColor?: string  // theme key for filled portion
  emptyColor?: string // theme key for empty portion
}
```

Each character position is divided into 8ths using the block elements, providing smooth visual progress.

### LoadingState

`src/components/design-system/LoadingState.tsx`

Spinner with a loading message. Supports bold and dimmed text styling with an optional subtitle.

### ListItem

`src/components/design-system/ListItem.tsx`

A list item for selection UIs with:

- Pointer indicator (`▶` when focused)
- Checkmark indicator (when selected)
- Scroll hint arrows (↑/↓) when more items exist above/below
- Optional description text
- Numeric index display
- Cursor position declaration for accessibility

### Byline

`src/components/design-system/Byline.tsx`

Joins React children with a middot separator (` · `) for inline metadata display. Automatically filters out `null`, `undefined`, and `false` children.

### KeyboardShortcutHint

`src/components/design-system/KeyboardShortcutHint.tsx`

Renders keyboard shortcut hints like `ctrl+o to expand` or `(tab to toggle)`:

```ts
type Props = {
  shortcut: string  // e.g., "ctrl+o", "↑↓"
  action: string    // e.g., "expand", "navigate"
  parens?: boolean  // wrap in parentheses
  bold?: boolean    // bold the shortcut key
}
```

---

## Tabs

`src/components/design-system/Tabs.tsx`

A full-featured tabbed interface using a compound component pattern. Tabs are declared as `<Tab>` children rather than a data array, giving consumers full control over tab content via JSX composition.

### TabsProps

```ts
type TabsProps = {
  children: Array<React.ReactElement<TabProps>>
  title?: string
  color?: keyof Theme
  defaultTab?: string
  hidden?: boolean
  useFullWidth?: boolean
  /** Controlled mode: current selected tab id/title */
  selectedTab?: string
  /** Controlled mode: callback when tab changes */
  onTabChange?: (tabId: string) => void
  /** Optional banner to display below tabs header */
  banner?: React.ReactNode
  /** Disable keyboard navigation */
  disableNavigation?: boolean
  /** Whether the tab header row starts focused (default: true) */
  initialHeaderFocused?: boolean
  /** Fixed height for the content area — prevents layout shifts on tab switch */
  contentHeight?: number
  /** Let Tab/←/→ switch tabs from focused content (opt-in) */
  navFromContent?: boolean
}
```

> Source: `src/components/design-system/Tabs.tsx:11-47`

### TabProps & Tab Component

Each tab is a `<Tab>` element rendered as a child of `<Tabs>`:

```ts
type TabProps = {
  title: string
  id?: string           // defaults to title if omitted
  children: React.ReactNode
}
```

> Source: `src/components/design-system/Tabs.tsx:256-260`

The `Tab` component reads `TabsContext` to determine whether it is the currently selected tab. If not selected, it returns `null` — only the active tab's children render.

### Key Behaviors

- **Controlled and uncontrolled modes**: pass `selectedTab`/`onTabChange` for controlled mode, or let `defaultTab` + internal state manage selection
- **Keyboard navigation**: configurable keybindings (`tabs:next`, `tabs:previous`) for cycling tabs when the header row is focused (`src/components/design-system/Tabs.tsx:147-150`)
- **Header focus model**: The header row can be focused/blurred independently of content. When `initialHeaderFocused` is `true` (default), arrow keys immediately switch tabs. Press ↓ to blur the header and interact with content; components call `focusHeader()` (via `useTabHeaderFocus`) to return focus
- **navFromContent**: When enabled, Tab/←/→ keys switch tabs even when content is focused, then refocus the header (`src/components/design-system/Tabs.tsx:170-191`)
- **Modal-aware**: Detects modal context and uses `ScrollBox` with a scroll ref inside modals, plain `Box` otherwise (`src/components/design-system/Tabs.tsx:209-210`)

### useTabHeaderFocus Hook

```ts
export function useTabHeaderFocus(): {
  headerFocused: boolean
  focusHeader: () => void
  blurHeader: () => void
}
```

> Source: `src/components/design-system/Tabs.tsx:307-335`

Registers an opt-in for header-focus gating on mount. Typical usage: pass `isDisabled={headerFocused}` to a `Select` inside a tab, and `onUpFromFirstItem={focusHeader}` so pressing ↑ from the first item returns focus to the tab row.

### useTabsWidth Hook

Returns the `width` from `TabsContext`, allowing tab content to know its available width (`src/components/design-system/Tabs.tsx:289-294`).

### Usage Example

```tsx
<Tabs title="Settings" color="suggestion" defaultTab="general">
  <Tab title="General" id="general">
    <GeneralSettings />
  </Tab>
  <Tab title="Advanced" id="advanced">
    <AdvancedSettings />
  </Tab>
</Tabs>
```

---

## FuzzyPicker

`src/components/design-system/FuzzyPicker.tsx`

A comprehensive fuzzy-search selection component. The **caller owns filtering** — `FuzzyPicker` calls `onQueryChange` on each keystroke, and the caller re-filters and passes updated `items`.

### Props

```ts
type Props<T> = {
  title: string
  placeholder?: string                          // default: 'Type to search…'
  initialQuery?: string
  items: readonly T[]
  getKey: (item: T) => string
  renderItem: (item: T, isFocused: boolean) => React.ReactNode
  renderPreview?: (item: T) => React.ReactNode
  previewPosition?: 'bottom' | 'right'          // default: 'bottom'
  visibleCount?: number                          // default: DEFAULT_VISIBLE (8)
  direction?: 'down' | 'up'                      // default: 'down'
  onQueryChange: (query: string) => void
  onSelect: (item: T) => void
  onTab?: PickerAction<T>
  onShiftTab?: PickerAction<T>
  onFocus?: (item: T | undefined) => void
  onCancel: () => void
  emptyMessage?: string | ((query: string) => string)  // default: 'No results'
  matchLabel?: string
  selectAction?: string                          // default: 'select'
  extraHints?: React.ReactNode
}

type PickerAction<T> = {
  action: string          // hint label, e.g. "mention"
  handler: (item: T) => void
}
```

> Source: `src/components/design-system/FuzzyPicker.tsx:14-62`

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_VISIBLE` | `8` | Default number of visible items in the list |
| `CHROME_ROWS` | `10` | Rows consumed by Pane, title, gaps, SearchBox, hints |
| `MIN_VISIBLE` | `2` | Minimum visible items (caps terminal overflow) |

> Source: `src/components/design-system/FuzzyPicker.tsx:63-67`

### Key Process

1. **Search input**: Uses `useSearchInput` hook for text entry with cursor tracking. `backspaceExitsOnEmpty` is disabled so held backspace doesn't dismiss the picker (`src/components/design-system/FuzzyPicker.tsx:113-122`)
2. **Query change → re-filter**: Each query change fires `onQueryChange(query)` and resets `focusedIndex` to 0 (`src/components/design-system/FuzzyPicker.tsx:156-160`)
3. **Keyboard navigation**: ↑/↓ and Ctrl+P/N step through items. Direction is respected — in `'up'` mode, ↑ moves forward and ↓ moves backward, matching visual screen direction (`src/components/design-system/FuzzyPicker.tsx:123-154`)
4. **Selection**: Enter selects the focused item via `onSelect`. Tab invokes `onTab.handler`, Shift+Tab invokes `onShiftTab.handler` (falls back to `onTab` if `onShiftTab` is not set) (`src/components/design-system/FuzzyPicker.tsx:143-154`)
5. **Viewport windowing**: Only `visibleCount` items render. The window start is clamped so the focused item stays in view (`src/components/design-system/FuzzyPicker.tsx:169-170`)
6. **Terminal overflow protection**: `visibleCount` is capped to `rows - CHROME_ROWS` to prevent cursor mis-positioning when the picker exceeds terminal height (`src/components/design-system/FuzzyPicker.tsx:100`)
7. **Compact mode**: When terminal width < 120 columns, Shift+Tab hint is hidden and action labels are shortened via `firstWord()` (`src/components/design-system/FuzzyPicker.tsx:104, 208`)

### Preview Panel

When `renderPreview` is provided:
- **`'right'` position**: List and preview sit side-by-side in a row with a fixed height of `visibleCount + (matchLabel ? 1 : 0)` rows
- **`'bottom'` position** (default): Preview renders below the list in a single column

The layout structure is always a `Box` (never a fragment) regardless of whether preview content exists, avoiding layout bouncing when the focused item changes (`src/components/design-system/FuzzyPicker.tsx:178-195`).

### Internal List Component

`List` renders the visible window of items using `ListItem` components, handling scroll indicators (↑/↓ arrows), empty state, and direction-dependent ordering (`src/components/design-system/FuzzyPicker.tsx:225-311`).

### firstWord Utility

```ts
function firstWord(s: string): string
```

Returns the first word of a string (up to the first space). Used in compact mode to shorten action labels in the byline (`src/components/design-system/FuzzyPicker.tsx:308-311`).

---

## CustomSelect System

The `src/components/CustomSelect/` directory implements a full select dropdown system with keyboard navigation, input options, and multi-select capabilities.

### Architecture

The select system is composed of layered hooks and components:

```
Select / SelectMulti (UI components)
  ├── useSelectState / useMultiSelectState (selection logic)
  │     └── useSelectNavigation (viewport & focus management)
  │           └── OptionMap (doubly-linked list of options)
  └── SelectOption / SelectInputOption (individual option renderers)
```

### OptionMap

`src/components/CustomSelect/option-map.ts`

A doubly-linked list data structure extending `Map` that provides O(1) access to option items by value, plus efficient next/previous traversal. Each item stores `label`, `value`, `description`, `previous`, `next`, and `index`. Exposes `first` and `last` for boundary access.

### useSelectNavigation

`src/components/CustomSelect/use-select-navigation.ts`

The foundational hook managing viewport windowing and focus state via a `useReducer`. Actions include:

- `focus-next-option` / `focus-previous-option` — single-item movement
- `focus-next-page` / `focus-previous-page` — page-size jumps
- `set-focus` — jump to a specific value
- `reset` — reinitialize state

State tracks `focusedValue`, `visibleFromIndex`, and `visibleToIndex` for the visible window.

### useSelectState

`src/components/CustomSelect/use-select-state.ts`

Composes `useSelectNavigation` with selection logic. Returns:

```ts
type SelectState<T> = {
  focusedValue: T | undefined
  focusedIndex: number          // 1-based, 0 if no focus
  visibleFromIndex: number
  visibleToIndex: number
  value: T | undefined
  options: OptionWithDescription<T>[]
  visibleOptions: Array<OptionWithDescription<T> & { index: number }>
  // ... navigation methods
}
```

> Source: `src/components/CustomSelect/use-select-state.ts:44-79`

### useSelectInput

`src/components/CustomSelect/use-select-input.ts`

Handles keyboard input translation into state actions — arrow keys for navigation, Enter for selection, Escape for cancel, number keys for direct index selection.

### Select

`src/components/CustomSelect/select.tsx`

The main single-select component. Key features:

- **Two option types**: `'text'` (standard) and `'input'` (inline text input with placeholder, editor support, image paste)
- **Three layouts**: `'compact'` (one line per option, default), `'expanded'` (multi-line with spacing), `'compact-vertical'` (compact indexes with descriptions below)
- **Inline descriptions** mode for short hints
- **Highlight text** support for search result emphasis
- **Edge navigation callbacks**: `onUpFromFirstItem` / `onDownFromLastItem` for composing with external navigation

```ts
type OptionWithDescription<T> = {
  label: ReactNode
  value: T
  description?: string
  dimDescription?: boolean
  disabled?: boolean
  type?: 'text' | 'input'
  // input-specific props:
  onChange?: (value: string) => void
  placeholder?: string
  initialValue?: string
  allowEmptySubmitToCancel?: boolean
  showLabelWithValue?: boolean
  labelValueSeparator?: string
  resetCursorOnUpdate?: boolean
}
```

> Source: `src/components/CustomSelect/select.tsx:28-69`

```ts
type SelectProps<T> = {
  isDisabled?: boolean            // default: false
  disableSelection?: boolean      // default: false
  hideIndexes?: boolean           // default: false
  visibleOptionCount?: number     // default: 5
  highlightText?: string
  options: OptionWithDescription<T>[]
  defaultValue?: T
  defaultFocusValue?: T
  onCancel?: () => void
  onChange?: (value: T) => void
  onFocus?: (value: T) => void
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  inlineDescriptions?: boolean
  onUpFromFirstItem?: () => void
  onDownFromLastItem?: () => void
  onInputModeToggle?: (value: T) => void
  onOpenEditor?: (currentValue: string, setValue: (value: string) => void) => void
  onImagePaste?: (...)  => void
  pastedContents?: Record<number, PastedContent>
  onRemoveImage?: (id: number) => void
}
```

> Source: `src/components/CustomSelect/select.tsx:70-191`

### SelectMulti

`src/components/CustomSelect/SelectMulti.tsx`

Multi-select variant that allows toggling multiple options. Additional features beyond `Select`:

- **Checkmark indicators** for selected items
- **Submit button** — optional explicit submit button via `submitButtonText`; when present, Enter toggles and submit requires focusing the button
- **Space/Enter toggling** — configurable based on `submitButtonText` presence
- **Batch onChange** — fires with the full array of selected values
- **Edge callbacks**: `onDownFromLastItem`, `onUpFromFirstItem` for external navigation composition

> Source: `src/components/CustomSelect/SelectMulti.tsx:11-57`

### SelectInputOption

`src/components/CustomSelect/select-input-option.tsx`

Renders an individual input-type option with:

- Inline `TextInput` for free-form text entry
- External editor support via Ctrl+G (`onOpenEditor` callback)
- Image paste support with clipboard integration and inline image display
- Byline showing keyboard shortcut hints

---

## TreeSelect

`src/components/ui/TreeSelect.tsx`

A hierarchical tree selection component built on top of `Select`. It flattens a tree structure into a scrollable list with expand/collapse behavior.

```ts
type TreeNode<T> = {
  id: string | number
  value: T
  label: string
  description?: string
  dimDescription?: boolean
  children?: TreeNode<T>[]
  metadata?: Record<string, unknown>
}

type TreeSelectProps<T> = {
  nodes: TreeNode<T>[]
  onSelect: (node: TreeNode<T>) => void
  onCancel?: () => void
  onFocus?: (node: TreeNode<T>) => void
  focusNodeId?: string | number
  visibleOptionCount?: number
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  isDisabled?: boolean
  hideIndexes?: boolean
  isNodeExpanded?: (nodeId: string | number) => boolean
  onExpand?: (nodeId: string | number) => void
  onCollapse?: (nodeId: string | number) => void
  getParentPrefix?: (isExpanded: boolean) => string   // default: ▼/▶
  getChildPrefix?: (depth: number) => string           // default: "  ▸ "
  onUpFromFirstItem?: () => void
}
```

> Source: `src/components/ui/TreeSelect.tsx:6-103`

Keyboard interaction: Enter on a parent node toggles expand/collapse; Enter on a leaf node triggers selection. The tree is flattened into `OptionWithDescription` items fed to the underlying `Select` component. Expansion state is managed internally via `useState<Set>` or externally via the `isNodeExpanded` callback.

---

## OrderedList

`src/components/ui/OrderedList.tsx` and `src/components/ui/OrderedListItem.tsx`

A context-based ordered list that provides automatic numbering to its children:

- `OrderedList` wraps children and provides numbering context
- `OrderedListItem` reads the context to display its index marker

---

## Wizard Framework

The `src/components/wizard/` directory provides a multi-step wizard flow framework.

### WizardProvider

`src/components/wizard/WizardProvider.tsx`

A React context provider managing wizard state:

- **Step navigation**: `goNext()`, `goBack()`, `goToStep(index)`, `cancel()`
- **Navigation history**: maintains a stack so `goBack()` returns to the correct previous step, even with non-linear navigation via `goToStep()`
- **Shared data**: `wizardData` object shared across all steps, updated via `updateWizardData(updates)` (shallow merge)
- **Completion**: triggers `onComplete(wizardData)` when advancing past the last step
- **Ctrl+C/D exit** support via `useExitOnCtrlCDWithKeybindings`

Context value (accessed via `useWizard()` hook):

```ts
type WizardContextValue<T> = {
  currentStepIndex: number
  totalSteps: number
  title?: string
  showStepCounter: boolean
  goNext: () => void
  goBack: () => void
  goToStep: (index: number) => void
  cancel: () => void
  wizardData: T
  updateWizardData: (updates: Partial<T>) => void
}
```

### useWizard

`src/components/wizard/useWizard.ts`

Hook to access the wizard context. Throws if used outside of a `WizardProvider`. Supports generic typing for the wizard data shape:

```ts
const { goNext, wizardData, updateWizardData } = useWizard<MyWizardData>()
```

### WizardDialogLayout

`src/components/wizard/WizardDialogLayout.tsx`

Wraps a wizard step in the standard `Dialog` component with:

- Title from provider (overridable via `title` prop) with step counter suffix (e.g., `"Setup (2/4)"`) when `showStepCounter` is enabled
- `goBack` wired to the dialog's cancel action
- `WizardNavigationFooter` rendered below the dialog
- Default color: `"suggestion"`

```ts
type Props = {
  title?: string
  color?: keyof Theme    // default: 'suggestion'
  children: ReactNode
  subtitle?: string
  footerText?: ReactNode
}
```

> Source: `src/components/wizard/WizardDialogLayout.tsx:7-13`

### WizardNavigationFooter

`src/components/wizard/WizardNavigationFooter.tsx`

Renders navigation hints below the dialog content. Default instructions: `↑↓ navigate · Enter select · Esc go back`. When a Ctrl+C/D exit is pending, shows a "Press again to exit" confirmation message.

### Typical Wizard Usage

```tsx
<WizardProvider
  steps={[StepOne, StepTwo, StepThree]}
  initialData={{ name: '', config: {} }}
  onComplete={(data) => handleComplete(data)}
  onCancel={() => closeDialog()}
  title="Setup"
>
  {children}
</WizardProvider>
```

Each step component uses `useWizard()` to read shared data, update it, and call `goNext()` when the step is complete.

---

## Key Design Patterns

1. **Theme resolution everywhere**: All visual components resolve theme color keys rather than using raw ANSI codes, ensuring consistent theming across light/dark modes. `useTheme()` returns a `ThemeName` string; components call `getTheme(name)` to get the full color map.

2. **React Compiler optimization**: Every component uses `import { c as _c } from "react/compiler-runtime"` — the codebase is processed through the React Compiler for automatic memoization, eliminating the need for manual `useMemo`/`useCallback` in most cases.

3. **Compound component pattern**: `Tabs` uses `<Tab>` children rather than a data prop, giving consumers full JSX control over content. `OrderedList` uses context to number its `OrderedListItem` children.

4. **Composable hooks architecture**: The CustomSelect system layers hooks (`useSelectNavigation` → `useSelectState` → `useSelectInput`) so that each concern (viewport management, selection state, keyboard handling) is isolated and testable.

5. **Keyboard-first interaction**: Every interactive component supports full keyboard navigation — arrow keys, Enter, Escape, Tab, number keys for direct selection, and Ctrl+C/D for exit.

6. **Viewport windowing**: Both `Select` and `FuzzyPicker` implement virtual windowing — only `visibleOptionCount`/`visibleCount` items render at once, with scroll indicators showing when more items exist above or below. `FuzzyPicker` also caps visible items to prevent terminal overflow.