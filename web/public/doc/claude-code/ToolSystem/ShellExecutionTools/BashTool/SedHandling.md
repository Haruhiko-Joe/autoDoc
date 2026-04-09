# Sed Handling

## Overview & Responsibilities

The Sed Handling module provides two complementary capabilities for the BashTool's processing of `sed` commands:

1. **Sed Validation** (`sedValidation.ts`, 685 lines) — determines whether a `sed` command is safe to execute without explicit user approval, using an allowlist of known-safe patterns plus a defense-in-depth denylist of dangerous operations.
2. **Sed Edit Parser** (`sedEditParser.ts`, 323 lines) — parses `sed -i` (in-place edit) commands into structured `SedEditInfo` objects so the UI can render them as file-edit-style diffs instead of opaque shell commands.

Within the architecture, this module sits inside **ToolSystem → ShellExecutionTools → BashTool**. It is consumed by the BashTool's permission checking, path validation, and read-only enforcement subsystems. The validation gate (`sedCommandIsAllowedByAllowlist`) decides whether a sed command can run silently or must prompt the user; the edit parser (`parseSedEditCommand`) enables richer UI rendering of approved in-place edits.

---

## Key Processes

### Sed Command Validation Flow

The main entry point is `sedCommandIsAllowedByAllowlist(command, options?)`:

1. **Extract expressions** — `extractSedExpressions()` parses the command using `tryParseShellCommand()`, handling `-e`/`--expression` flags, `--expression=value` syntax, and bare positional expressions. Rejects dangerous flag combinations like `-ew`, `-eW` early (`sedValidation.ts:396-399`).

2. **Detect file arguments** — `hasFileArgs()` determines whether the command targets files (vs. stdin). It tracks whether `-e` flags are present; if so, all non-flag arguments are file arguments. Without `-e`, the first non-flag argument is the expression and subsequent ones are files (`sedValidation.ts:307-379`).

3. **Pattern matching (allowlist)** — the command is checked against two allowlist patterns:
   - **Pattern 1 — Line printing**: requires `-n` flag; all expressions must be print commands matching `^(?:\d+|\d+,\d+)?p$` (e.g., `1p`, `1,5p`). Semicolon-separated print commands are allowed. File arguments are permitted (`sedValidation.ts:44-117`).
   - **Pattern 2 — Substitution**: exactly one expression starting with `s/`, using `/` as delimiter. Validates substitution flags against `[gpimIM1-9]`. In `allowFileWrites` mode, permits `-i`/`--in-place`; otherwise rejects file arguments (`sedValidation.ts:142-238`).

4. **Denylist check (defense-in-depth)** — even if the allowlist matches, `containsDangerousOperations()` scans each expression for: non-ASCII characters, curly braces, newlines, `w`/`W` (write) commands, `e`/`E` (execute) commands, negation operators, tilde step addresses, backslash delimiter tricks, and malformed substitution patterns (`sedValidation.ts:473-628`).

5. **Return result** — `true` if the command passes both allowlist and denylist; `false` otherwise.

### Cross-Cutting Constraint Check

`checkSedConstraints(input, toolPermissionContext)` wraps the validation for use in the permission pipeline:

1. Splits the input into individual commands via `splitCommand_DEPRECATED()`
2. For each `sed` command, calls `sedCommandIsAllowedByAllowlist()` with `allowFileWrites` set based on whether the mode is `acceptEdits`
3. Returns `{ behavior: 'passthrough' }` if safe, or `{ behavior: 'ask', message: '...' }` if approval is needed

> Source: `sedValidation.ts:644-684`

### Sed Edit Parsing Flow

`parseSedEditCommand(command)` extracts structured edit info:

1. **Tokenize** — strips `sed` prefix, parses remaining arguments via `tryParseShellCommand()`, rejects glob patterns
2. **Extract flags and arguments** — iterates tokens to identify `-i` (with optional backup suffix like `-i.bak` or `-i ''`), `-E`/`-r` (extended regex), `-e` expressions, and the file path. Returns `null` for multiple files or unknown flags (`sedEditParser.ts:49-158`)
3. **Parse substitution expression** — walks the `s/pattern/replacement/flags` string character-by-character, tracking escape sequences and delimiter transitions through a state machine (`pattern` → `replacement` → `flags`) (`sedEditParser.ts:165-228`)
4. **Validate flags** — only allows `[gpimIM1-9]`
5. **Return `SedEditInfo`** — `{ filePath, pattern, replacement, flags, extendedRegex }`

### Applying Sed Substitutions

`applySedSubstitution(content, sedInfo)` converts a `SedEditInfo` into an actual text transformation:

1. **Map sed flags to JS regex flags** — `g` → global, `i`/`I` → case-insensitive, `m`/`M` → multiline
2. **BRE-to-ERE conversion** (when `extendedRegex` is `false`) — uses null-byte placeholder sentinels to swap BRE and ERE metacharacter escaping. In BRE, `\+` means "one or more" while `+` is literal; this is the opposite of JS/ERE. The conversion uses a 4-step placeholder approach to avoid double-escaping (`sedEditParser.ts:275-298`)
3. **Replacement string conversion** — converts `&` (sed's full-match reference) to `$&` (JS equivalent), with escaped `\&` handled via a random-salt placeholder to prevent injection (`sedEditParser.ts:303-313`)
4. **Apply regex** — constructs a `RegExp` and calls `content.replace()`. Returns original content if the regex is invalid

---

## Function Signatures

### `sedValidation.ts`

#### `sedCommandIsAllowedByAllowlist(command: string, options?: { allowFileWrites?: boolean }): boolean`

Main entry point. Returns `true` if the sed command matches the safe allowlist and passes the denylist.

- **command**: Full sed command string
- **options.allowFileWrites**: When `true`, allows `-i` and file arguments for substitution commands (used in `acceptEdits` mode). Default: `false`

#### `checkSedConstraints(input: { command: string }, toolPermissionContext: ToolPermissionContext): PermissionResult`

Cross-cutting validation for the permission pipeline. Returns `{ behavior: 'passthrough' }` or `{ behavior: 'ask', message }`.

#### `extractSedExpressions(command: string): string[]`

Parses the command to extract sed expression strings (the content of `-e` args or the first positional argument). Throws on malformed syntax or dangerous flag combinations.

#### `hasFileArgs(command: string): boolean`

Returns `true` if the sed command has file arguments (targets files rather than stdin).

#### `isLinePrintingCommand(command: string, expressions: string[]): boolean`

Pattern 1 checker. Validates line-printing commands (`sed -n '1p'`, `sed -n '1,5p'`).

#### `isPrintCommand(cmd: string): boolean`

Checks if a single expression is a valid print command (`p`, `1p`, `1,5p`).

### `sedEditParser.ts`

#### `parseSedEditCommand(command: string): SedEditInfo | null`

Parses a sed in-place edit command. Returns `null` if the command cannot be safely parsed (multiple files, unknown flags, non-substitution expression, glob patterns).

#### `isSedInPlaceEdit(command: string): boolean`

Convenience wrapper — returns `true` if `parseSedEditCommand()` returns non-null.

#### `applySedSubstitution(content: string, sedInfo: SedEditInfo): string`

Applies a parsed sed substitution to file content using JavaScript regex, with BRE-to-ERE conversion when needed.

---

## Type Definitions

### `SedEditInfo`

```typescript
// sedEditParser.ts:23-34
type SedEditInfo = {
  filePath: string       // The file being edited
  pattern: string        // The search pattern (regex)
  replacement: string    // The replacement string
  flags: string          // Substitution flags (g, i, etc.)
  extendedRegex: boolean // Whether -E or -r flag was used
}
```

---

## Edge Cases & Caveats

- **Only `/` as delimiter**: Both the validator (Pattern 2) and the edit parser only accept `/` as the substitution delimiter. Commands using alternate delimiters like `s|pattern|replacement|` are rejected by the allowlist and unparseable by the edit parser.

- **Single-file limitation**: `parseSedEditCommand()` returns `null` for commands targeting multiple files. This is intentional — multi-file edits cannot be rendered as a single file diff.

- **macOS `-i` suffix handling**: The parser accounts for macOS sed's requirement that `-i` takes a suffix argument. It consumes the next argument as a backup suffix if it's empty or starts with `.` (`sedEditParser.ts:94-104`).

- **BRE vs ERE regex semantics**: Without `-E`/`-r`, sed uses Basic Regular Expressions where `+`, `?`, `|`, `(`, `)` are literals and their backslash-escaped forms are metacharacters. The `applySedSubstitution` function converts BRE patterns to JS (ERE) using null-byte placeholders to avoid double-escaping collisions (`sedEditParser.ts:275-298`).

- **Defense-in-depth denylist**: Even if a command matches the allowlist patterns, `containsDangerousOperations()` rejects: non-ASCII characters (Unicode homoglyphs), curly braces, newlines, `w`/`W` write commands, `e`/`E` execute commands, negation operators, tilde step addresses, and various backslash tricks. This provides layered security against bypass attempts.

- **Fail-closed behavior**: Parse failures at any stage (malformed shell syntax, unparseable expressions, invalid regex) result in the command being treated as unsafe (validation returns `false`, parser returns `null`, substitution returns original content).

- **Random salt in replacement**: `applySedSubstitution` generates a random hex salt for the `\&` placeholder to prevent injection attacks where the replacement string contains the placeholder text itself (`sedEditParser.ts:303`).

- **Semicolons in expressions**: Pattern 1 (line printing) allows semicolon-separated commands like `1p;2p;3p`. Pattern 2 (substitution) explicitly rejects semicolons to prevent command chaining after a substitution (`sedValidation.ts:286-291`).

---

## Key Code Snippets

### Allowlist validation entry point

```typescript
// sedValidation.ts:247-301
export function sedCommandIsAllowedByAllowlist(
  command: string,
  options?: { allowFileWrites?: boolean },
): boolean {
  // ...extract expressions, detect file args...
  
  if (allowFileWrites) {
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments, {
      allowFileWrites: true,
    })
  } else {
    isPattern1 = isLinePrintingCommand(command, expressions)
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments)
  }

  // Defense-in-depth denylist
  for (const expr of expressions) {
    if (containsDangerousOperations(expr)) {
      return false
    }
  }
  return true
}
```

### BRE-to-ERE conversion with placeholder escaping

```typescript
// sedEditParser.ts:275-298
if (!sedInfo.extendedRegex) {
  jsPattern = jsPattern
    .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)       // Protect literal backslashes
    .replace(/\\\+/g, PLUS_PLACEHOLDER)             // \+ (BRE meta) → placeholder
    .replace(/\\\?/g, QUESTION_PLACEHOLDER)         // \? (BRE meta) → placeholder
    .replace(/\\\|/g, PIPE_PLACEHOLDER)
    .replace(/\\\(/g, LPAREN_PLACEHOLDER)
    .replace(/\\\)/g, RPAREN_PLACEHOLDER)
    .replace(/\+/g, '\\+')                          // + (BRE literal) → escaped
    .replace(/\?/g, '\\?')
    .replace(/\|/g, '\\|')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(BACKSLASH_PLACEHOLDER_RE, '\\\\')      // Restore from placeholders
    .replace(PLUS_PLACEHOLDER_RE, '+')               // → unescaped (ERE meta)
    .replace(QUESTION_PLACEHOLDER_RE, '?')
    .replace(PIPE_PLACEHOLDER_RE, '|')
    .replace(LPAREN_PLACEHOLDER_RE, '(')
    .replace(RPAREN_PLACEHOLDER_RE, ')')
}
```

### Dangerous operation detection (excerpt)

```typescript
// sedValidation.ts:569-595
// Write commands: w/W after various address forms
if (
  /^[wW]\s*\S+/.test(cmd) ||
  /^\d+\s*[wW]\s*\S+/.test(cmd) ||
  /^\$\s*[wW]\s*\S+/.test(cmd) ||
  /^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) ||
  // ...
) { return true }

// Execute commands: e after various address forms
if (
  /^e/.test(cmd) ||
  /^\d+\s*e/.test(cmd) ||
  // ...
) { return true }
```