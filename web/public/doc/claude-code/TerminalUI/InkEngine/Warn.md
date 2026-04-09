# Warn

## Overview & Responsibilities

The `warn` module is a minimal validation utility within the Ink rendering engine (part of **TerminalUI → InkEngine**). Its sole purpose is to catch non-integer values being passed to layout properties that expect integers — such as margins, paddings, gaps, and screen dimensions — and log a warning via the debug logging system rather than crashing.

This is a defensive layer: the Yoga layout engine (which Ink uses for flexbox-style terminal layout) expects integer values for spacing properties. Fractional values can cause subtle rendering bugs, so this module provides early, non-fatal detection.

## Key Processes

### Integer Validation Flow

1. A caller (e.g., the `Box` component or `createScreen`) passes a numeric value and the property name to `ifNotInteger()`
2. If the value is `undefined`, the check is skipped (the property was not set)
3. If the value is an integer, the check passes silently
4. If the value is a non-integer number (e.g., `3.5`), a warning is logged via `logForDebugging()` at the `warn` level

The warning is written to the debug log file (or stderr if configured), not to the user-facing terminal output, so it does not disrupt the UI.

## Function Signature

### `ifNotInteger(value: number | undefined, name: string): void`

Validates that a numeric property is an integer and logs a warning if not.

- **value**: The numeric value to check. If `undefined`, the function returns immediately (no-op).
- **name**: A human-readable label for the property, included in the warning message (e.g., `"margin"`, `"createScreen width"`).
- **Returns**: Nothing. Side effect is a debug log entry on validation failure.

> Source: `src/ink/warn.ts:3-9`

## Usage

The module is imported as a namespace (`import * as warn from './warn.js'`) and called with dot notation:

**In `Box` component** (`src/ink/components/Box.tsx:110-126`): Validates all spacing-related style properties — `margin`, `marginX/Y/Top/Bottom/Left/Right`, `padding` (and variants), `gap`, `columnGap`, and `rowGap`.

**In screen management** (`src/ink/screen.ts:459-460, 507-508`): Validates `width` and `height` parameters in `createScreen` and `resetScreen`.

## Edge Cases & Caveats

- **`undefined` is silently accepted** — this is intentional since layout properties are optional. Only actual non-integer numbers trigger warnings.
- **Warnings are non-blocking** — a fractional value will still be passed through to the layout engine; this module only logs, it does not correct or reject the value.
- **Debug log level gating** — the warning is emitted at `warn` level via `logForDebugging()`, so it will only appear if the configured minimum debug log level is at or below `warn`.