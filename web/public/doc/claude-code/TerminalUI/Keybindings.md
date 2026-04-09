# Keybindings

## Overview & Responsibilities

The Keybindings module is the customizable keyboard shortcut system for Claude Code's terminal UI. It sits within the **TerminalUI** layer, translating raw keypress events from Ink (the React-for-CLI renderer) into named actions that UI components consume. The module owns the full lifecycle of a keyboard shortcut: defining defaults, loading user overrides, parsing key chord syntax, matching live keypress events, resolving conflicts, validating configurations, and providing React integration hooks.

Sibling modules within TerminalUI (components, hooks, screen layouts) depend on this module to determine which key combinations trigger which behaviors. The module is self-contained — it does not depend on the QueryEngine or ToolSystem, only on infrastructure utilities and analytics services.

## Architecture

The module is organized into these layers:

| Layer | Files | Role |
|-------|-------|------|
| **Schema & Types** | `schema.ts` | Zod schemas for `keybindings.json` validation; canonical lists of contexts and actions |
| **Defaults** | `defaultBindings.ts` | Platform-aware default bindings for all UI contexts |
| **Parser** | `parser.ts` | Converts keystroke strings (e.g., `"ctrl+shift+k"`) into structured `ParsedKeystroke` objects |
| **Matcher** | `match.ts` | Compares live Ink `Key` events against `ParsedKeystroke` targets |
| **Resolver** | `resolver.ts` | Determines which action fires given active contexts, bindings, and chord state |
| **Validator** | `validate.ts` | Checks user config for parse errors, duplicates, reserved shortcuts, and invalid actions |
| **Reserved Shortcuts** | `reservedShortcuts.ts` | Defines non-rebindable keys (`ctrl+c`, `ctrl+d`) and platform-specific reserved shortcuts |
| **Loader** | `loadUserBindings.ts` | Loads `~/.claude/keybindings.json`, merges with defaults, watches for hot-reload |
| **Template** | `template.ts` | Generates a starter `keybindings.json` file for users |
| **Display** | `shortcutFormat.ts`, `useShortcutDisplay.ts` | Formats shortcuts for display in non-React and React contexts |
| **React Integration** | `KeybindingContext.tsx`, `KeybindingProviderSetup.tsx`, `useKeybinding.ts` | Context provider, chord interceptor, and hooks for components |

## Key Processes

### 1. Binding Resolution Flow (keypress → action)

This is the core flow that runs on every keypress:

1. **Ink captures a keypress** and provides `input` (character) + `key` (modifier flags)
2. **`useKeybinding` hook** (or `useKeybindings` for batch) calls `keybindingContext.resolve()`
3. **`resolveKeyWithChordState()`** (`src/keybindings/resolver.ts:166-244`) is invoked with the current active contexts, all parsed bindings, and pending chord state
4. **Key name extraction**: `getKeyName()` (`src/keybindings/match.ts:29-47`) normalizes Ink's boolean flags (`key.escape`, `key.return`, etc.) into string names (`"escape"`, `"enter"`)
5. **Modifier matching**: `modifiersMatch()` (`src/keybindings/match.ts:60-79`) compares ctrl, shift, alt/meta, and super modifiers. Alt and meta are treated as equivalent (terminal limitation)
6. **Chord handling**: If the keystroke is a prefix of a longer chord binding, resolution returns `chord_started` with the pending keystrokes. Chords timeout after **1000ms** (`src/keybindings/KeybindingProviderSetup.tsx:30`)
7. **Last-wins resolution**: When multiple bindings match, the last one in the array wins — user bindings are appended after defaults, so they naturally override
8. **Result dispatch**: The hook receives one of: `match` (fire action), `chord_started` (wait for next key), `chord_cancelled`, `unbound` (explicitly disabled), or `none`

### 2. User Config Loading & Hot-Reload

1. **`loadKeybindingsSyncWithWarnings()`** (`src/keybindings/loadUserBindings.ts:259-345`) is called synchronously during React `useState` initialization
2. It reads `~/.claude/keybindings.json` (path from `getKeybindingsPath()`, line 116)
3. The file must use the object wrapper format: `{ "bindings": [ ... ] }`
4. User binding blocks are parsed via `parseBindings()` and **appended** after default bindings: `[...defaultBindings, ...userParsed]` (line 322)
5. Validation runs: duplicate key checks (raw JSON scan), structural validation, reserved shortcut warnings
6. **`initializeKeybindingWatcher()`** (`src/keybindings/loadUserBindings.ts:353-404`) sets up a `chokidar` file watcher with a 500ms stability threshold
7. On file change, `handleChange()` reloads asynchronously and emits via `keybindingsChanged` signal
8. `KeybindingSetup` subscribes to changes and updates React state, triggering re-render with new bindings
9. Feature-gated: customization is controlled by the `tengu_keybinding_customization_release` GrowthBook flag

### 3. Chord Sequence Handling

Chord bindings like `"ctrl+x ctrl+k"` (kill agents) require multi-keystroke tracking:

1. **ChordInterceptor** (`src/keybindings/KeybindingProviderSetup.tsx:211+`) registers a `useInput` handler **before** all children, ensuring it sees keystrokes first
2. When a chord prefix is detected, `setPendingChord()` stores the pending keystrokes in both a ref (for synchronous access) and state (for re-renders)
3. The interceptor calls `event.stopImmediatePropagation()` to prevent PromptInput from capturing the intermediate keystroke as text input
4. A **1000ms timeout** auto-cancels incomplete chords
5. Escape explicitly cancels any in-progress chord
6. On completion, the interceptor invokes the registered handler via `invokeAction()` from the handler registry

### 4. Validation Pipeline

When user config is loaded, `validateBindings()` (`src/keybindings/validate.ts:425-451`) runs these checks:

1. **`checkDuplicateKeysInJson()`** — Scans raw JSON text for duplicate keys within the same bindings block (JSON.parse silently uses last value)
2. **`validateUserConfig()`** — Validates each block's structure: context must be a known `KeybindingContextName`, bindings must be an object, keystroke syntax must parse correctly, command bindings must match `command:[a-zA-Z0-9:\-_]+` and be in Chat context
3. **`checkDuplicates()`** — Detects conflicting bindings within same context using normalized key comparison
4. **`checkReservedShortcuts()`** — Warns about non-rebindable keys and terminal/OS-reserved shortcuts
5. Results are deduplicated by `type:key:context` and surfaced as notifications via `/doctor`

## Function Signatures

### Parsing

#### `parseKeystroke(input: string): ParsedKeystroke`
Parses a single keystroke string like `"ctrl+shift+k"` into a structured object with modifier flags. Supports aliases: `ctrl`/`control`, `alt`/`opt`/`option`/`meta`, `cmd`/`command`/`super`/`win`, plus special key names (`esc`→`escape`, `return`→`enter`, `space`→`" "`).

> `src/keybindings/parser.ts:13-75`

#### `parseChord(input: string): Chord`
Splits a space-separated chord string (e.g., `"ctrl+k ctrl+s"`) into an array of `ParsedKeystroke`. A lone space character is treated as the space key, not a separator.

> `src/keybindings/parser.ts:80-84`

#### `parseBindings(blocks: KeybindingBlock[]): ParsedBinding[]`
Converts keybinding blocks (from JSON config) into a flat list of `ParsedBinding` objects with parsed chords.

> `src/keybindings/parser.ts:191-203`

### Matching

#### `matchesKeystroke(input: string, key: Key, target: ParsedKeystroke): boolean`
Checks if an Ink keypress matches a target keystroke. Handles the Ink quirk where `key.meta=true` for escape presses.

> `src/keybindings/match.ts:86-105`

#### `getKeyName(input: string, key: Key): string | null`
Extracts a normalized key name from Ink's `Key` object. Maps boolean flags to string names.

> `src/keybindings/match.ts:29-47`

### Resolution

#### `resolveKey(input, key, activeContexts, bindings): ResolveResult`
Simple single-keystroke resolver. Returns `{ type: 'match', action }`, `{ type: 'unbound' }`, or `{ type: 'none' }`.

> `src/keybindings/resolver.ts:32-61`

#### `resolveKeyWithChordState(input, key, activeContexts, bindings, pending): ChordResolveResult`
Full resolver with chord support. Additionally returns `{ type: 'chord_started', pending }` or `{ type: 'chord_cancelled' }`. Uses a "last wins" strategy — later bindings in the array shadow earlier ones. Null-overrides on chords correctly prevent the prefix from entering chord-wait mode.

> `src/keybindings/resolver.ts:166-244`

#### `getBindingDisplayText(action, context, bindings): string | undefined`
Looks up the display string for an action (e.g., `"ctrl+t"` for `"app:toggleTodos"`). Searches in reverse so user overrides take precedence.

> `src/keybindings/resolver.ts:67-77`

### Display

#### `getShortcutDisplay(action, context, fallback): string`
Non-React utility for getting shortcut display text. Loads bindings synchronously and falls back to a hardcoded value if the action isn't found, logging a telemetry event.

> `src/keybindings/shortcutFormat.ts:38-63`

#### `useShortcutDisplay(action, context, fallback): string`
React hook equivalent. Uses `KeybindingContext` for reactive updates when bindings change.

> `src/keybindings/useShortcutDisplay.ts:29-59`

### React Hooks

#### `useKeybinding(action, handler, options?): void`
Registers a single action handler. Resolves keystrokes through the keybinding context, manages chord state, and calls `event.stopImmediatePropagation()` on match to prevent other handlers from firing.

> `src/keybindings/useKeybinding.ts:33-97`

#### `useKeybindings(handlers, options?): void`
Batch version — registers multiple action handlers in one `useInput` call. Handlers returning `false` allow event propagation (fall-through).

> `src/keybindings/useKeybinding.ts:113-196`

### Validation

#### `validateBindings(userBlocks, parsedBindings): KeybindingWarning[]`
Runs all validation checks and returns deduplicated warnings.

> `src/keybindings/validate.ts:425-451`

#### `formatWarnings(warnings): string`
Formats warnings into a human-readable string for display.

> `src/keybindings/validate.ts:470-498`

### Template

#### `generateKeybindingsTemplate(): string`
Generates a complete `keybindings.json` template with all default bindings (excluding non-rebindable shortcuts). Includes `$schema` and `$docs` metadata fields.

> `src/keybindings/template.ts:40-52`

## Contexts and Actions

### Keybinding Contexts

Contexts control **where** a binding is active. The active context is determined by which UI component currently has focus:

| Context | Description |
|---------|-------------|
| `Global` | Active everywhere |
| `Chat` | When the chat input is focused |
| `Autocomplete` | When autocomplete menu is visible |
| `Confirmation` | When a confirmation/permission dialog is shown |
| `Transcript` | When viewing the transcript |
| `HistorySearch` | During `ctrl+r` history search |
| `Task` | When a task/agent is running |
| `Settings` | When the settings menu is open |
| `Select` | When a select/list component is focused |
| `DiffDialog` | When the diff dialog is open |
| `Footer` | When footer indicators are focused |
| `MessageSelector` | When the message selector (rewind) is open |
| `ModelPicker` | When the model picker is open |
| `Plugin` | When the plugin dialog is open |
| `Help` | When the help overlay is open |
| `ThemePicker` | When the theme picker is open |
| `Tabs` | When tab navigation is active |
| `Attachments` | When navigating image attachments |

Contexts are defined in `src/keybindings/schema.ts:12-32`.

### Action Naming Convention

Actions follow a `namespace:verb` pattern (e.g., `app:interrupt`, `chat:submit`, `confirm:yes`). The full list of ~70 actions is defined in `src/keybindings/schema.ts:64-172`. User configs can also use `command:<name>` bindings (e.g., `command:help`) to invoke slash commands.

## Configuration

### User Config File

Location: `~/.claude/keybindings.json`

Format:
```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+k": "chat:submit",
        "escape": null
      }
    }
  ]
}
```

- Set a binding to `null` to explicitly unbind a default shortcut
- User bindings are appended after defaults — last definition wins
- Command bindings (`command:<name>`) must be in the `Chat` context

### Platform-Specific Defaults

- **Image paste**: `ctrl+v` on Linux/macOS, `alt+v` on Windows (to avoid conflicting with system paste)
- **Mode cycle**: `shift+tab` on terminals with VT mode support, `meta+m` on older Windows Terminal
- VT mode detection checks Node.js >=22.17.0/>=24.2.0 or Bun >=1.2.23 (`src/keybindings/defaultBindings.ts:21-25`)

## Reserved Shortcuts

Some shortcuts cannot be rebound (`src/keybindings/reservedShortcuts.ts:16-33`):

| Key | Reason |
|-----|--------|
| `ctrl+c` | Hardcoded interrupt/exit |
| `ctrl+d` | Hardcoded exit |
| `ctrl+m` | Identical to Enter in terminals (both send CR) |

Additional platform warnings:
- **All platforms**: `ctrl+z` (SIGTSTP), `ctrl+\` (SIGQUIT)
- **macOS**: `cmd+c/v/x/q/w/tab/space` (intercepted by OS)

## Edge Cases & Caveats

- **Alt/Meta equivalence**: Terminals cannot distinguish Alt from Meta. Both `alt+k` and `meta+k` match when `key.meta` is true. The `super` modifier (Cmd/Win) is distinct but only arrives via the kitty keyboard protocol on supporting terminals (`src/keybindings/match.ts:53-58`)
- **Escape quirk**: Ink sets `key.meta=true` when Escape is pressed (legacy terminal behavior). The matcher explicitly ignores meta when matching the escape key (`src/keybindings/match.ts:96-102`)
- **Chord null-override**: When a user null-unbinds a chord like `ctrl+x ctrl+k`, the resolver correctly avoids entering chord-wait mode for the `ctrl+x` prefix (`src/keybindings/resolver.ts:196-215`)
- **JSON duplicate keys**: `JSON.parse` silently uses the last value for duplicate keys. The validator scans the raw JSON string to warn users about this (`src/keybindings/validate.ts:258-307`)
- **Feature gates**: Several default bindings are conditionally included based on feature flags (`KAIROS`, `QUICK_SEARCH`, `TERMINAL_PANEL`, `MESSAGE_ACTIONS`, `VOICE_MODE`)
- **Voice push-to-talk**: Binding a bare letter key to `voice:pushToTalk` generates a warning because the key will print into the input during warmup (`src/keybindings/validate.ts:220-243`)
- **Hot-reload stability**: The file watcher uses a 500ms stability threshold and 200ms poll interval to handle editors that write files in multiple steps (`src/keybindings/loadUserBindings.ts:51-56`)
- **Customization gate**: User keybinding customization is currently controlled by the `tengu_keybinding_customization_release` GrowthBook feature flag. When disabled, the system uses only default bindings