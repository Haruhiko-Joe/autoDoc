# Utilities (CLI I/O Layer)

## Overview & Responsibilities

This module contains two small, focused utility files that serve the CLI I/O layer (`CLIIOLayer`) within the `Bootstrap` subsystem. They address two recurring low-level concerns across the CLI codebase:

- **`ndjsonSafeStringify`** — Safe JSON serialization for NDJSON (newline-delimited JSON) transports, preventing line-splitting bugs caused by Unicode line separators.
- **`exit.ts`** — Standardized print-and-exit helpers for CLI subcommand handlers, eliminating boilerplate and improving TypeScript control-flow analysis.

Both utilities are consumed by the headless execution path (`print.ts` / `runHeadless`) and CLI subcommand handlers (`auth.ts`, `mcp.tsx`, `plugins.ts`, etc.) that need reliable output framing and clean process termination.

---

## `ndjsonSafeStringify`

### Problem

`JSON.stringify` can emit raw U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) characters inside string values. While valid JSON per ECMA-404, these characters are treated as line terminators by JavaScript's line-splitting semantics (ECMA-262 §11.3). Any NDJSON receiver that splits on line boundaries — including `ProcessTransport` — will cut the JSON mid-string, silently dropping the message.

### Solution

The function post-processes the JSON output, replacing raw U+2028/U+2029 with their `\uXXXX` escape sequences. The escaped form is semantically identical JSON (parses to the same value) but can never be mistaken for a line break.

### Key Code Walkthrough

1. A single regex with alternation matches both problematic characters in one pass (`src/cli/ndjsonSafeStringify.ts:16`):
   ```ts
   const JS_LINE_TERMINATORS = /\u2028|\u2029/g
   ```

2. The `escapeJsLineTerminators` helper replaces each match with its escape form (`src/cli/ndjsonSafeStringify.ts:18-22`):
   ```ts
   function escapeJsLineTerminators(json: string): string {
     return json.replace(JS_LINE_TERMINATORS, c =>
       c === '\u2028' ? '\\u2028' : '\\u2029',
     )
   }
   ```

3. The exported function composes `jsonStringify` (a monitored wrapper around `JSON.stringify` from `utils/slowOperations`) with the escaping step (`src/cli/ndjsonSafeStringify.ts:30-32`):
   ```ts
   export function ndjsonSafeStringify(value: unknown): string {
     return escapeJsLineTerminators(jsonStringify(value))
   }
   ```

### Function Signature

#### `ndjsonSafeStringify(value: unknown): string`

Serializes `value` to a JSON string safe for NDJSON line-delimited transport.

- **value** — Any JSON-serializable value.
- **Returns** — A JSON string with U+2028 and U+2029 escaped to `\u2028` / `\u2029`.

### Edge Cases & Caveats

- The function uses `jsonStringify` from `utils/slowOperations` rather than calling `JSON.stringify` directly. This wrapper provides the same interface but is instrumented for performance monitoring.
- Only U+2028 and U+2029 are escaped — `\n` and `\r` are already escaped by `JSON.stringify` itself and do not need additional handling.
- The design note references gh-28405: `ProcessTransport` now skips non-JSON lines rather than crashing, but the truncated fragment is still lost, making this escaping necessary to avoid silent message loss.

---

## `exit.ts`

### Problem

CLI subcommand handlers (e.g., `claude mcp add`, `claude plugin install`) repeated a 4–5 line pattern roughly 60 times: print a message, suppress the lint rule for `process.exit`, and exit with a status code. This duplication created maintenance burden and inconsistent error output.

### Solution

Two helpers — `cliError()` and `cliOk()` — centralize the print-and-exit pattern. Their `never` return type enables TypeScript control-flow narrowing at call sites: callers can write `return cliError("...")` and the compiler knows subsequent code is unreachable.

### Function Signatures

#### `cliError(msg?: string): never`

Writes an error message to **stderr** via `console.error` and exits with code **1**.

- **msg** — Optional error message. If omitted, exits silently.
- **Returns** — `never` (process exits; see testability note below).

> Source: `src/cli/exit.ts:19-24`

#### `cliOk(msg?: string): never`

Writes a success message to **stdout** via `process.stdout.write` and exits with code **0**.

- **msg** — Optional success message. If omitted, exits silently.
- **Returns** — `never` (process exits; see testability note below).

> Source: `src/cli/exit.ts:27-31`

### Design Decisions

**`console.error` vs `process.stdout.write`**: `cliError` uses `console.error` for stderr output, while `cliOk` uses `process.stdout.write` instead of `console.log`. The comment at `src/cli/exit.ts:14-16` explains this asymmetry: tests spy on `process.stdout.write`, and Bun's `console.log` does not route through a spied `process.stdout.write`, so using `process.stdout.write` directly ensures testability under Bun.

**`return undefined as never`**: After `process.exit()`, the function includes `return undefined as never` (`src/cli/exit.ts:23, 30`). This is not dead code — tests spy on `process.exit` and let it return normally. Without this line, call sites that write `return cliError(...)` would dereference values that TypeScript has narrowed away, causing runtime errors under the mock.

### Edge Cases & Caveats

- Both functions accept an optional message. When `msg` is `undefined` or empty, the function exits without printing anything.
- The `eslint-disable` directive at the top of the file (`src/cli/exit.ts:9`) suppresses `custom-rules/no-process-exit` for the entire module, centralizing the lint exception to a single location rather than scattering it across dozens of subcommand files.