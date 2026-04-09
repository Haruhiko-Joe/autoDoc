# Security Validation

## Overview & Responsibilities

The Security Validation module (`src/tools/BashTool/bashSecurity.ts`, ~2593 lines) is the core command-injection defense layer for the BashTool. It sits within the **ToolSystem → ShellExecutionTools → BashTool** hierarchy and is invoked before any shell command is executed, determining whether a command is safe to run automatically or must be escalated to the user for approval.

The module implements a **multi-layered validator pipeline** that combines regex-based pattern matching with optional AST-based analysis (via tree-sitter). Its primary concern is detecting parser differentials — cases where the security validator's understanding of a command diverges from what bash/zsh would actually execute — since these differentials are the root cause of command injection bypasses.

Three public entry points are exported:
- **`bashCommandIsSafe_DEPRECATED`** — Synchronous regex-only validation (legacy path, used when tree-sitter is unavailable)
- **`bashCommandIsSafeAsync_DEPRECATED`** — Async validation that enriches the context with tree-sitter AST analysis when available
- **`stripSafeHeredocSubstitutions`** — Strips verified-safe `$(cat <<'DELIM'...DELIM)` patterns from commands for permission-safe heredoc handling

## Key Processes

### Command Validation Pipeline

Both entry points follow the same two-phase validation structure:

**Phase 1 — Pre-processing and early checks** (`src/tools/BashTool/bashSecurity.ts:2257–2306` for sync, `2426–2488` for async):
1. Block non-printable **control characters** (null bytes, etc.) that bash silently drops but confuse regex validators
2. Detect **shell-quote single-quote bug** patterns (`'\'`) that exploit a known shell-quote parsing issue
3. **Strip heredoc bodies** for quoted/escaped delimiters via `extractHeredocs` (bodies are literal text, safe to remove)
4. **Extract quoted content** using `extractQuotedContent` to produce three views of the command: single-quotes-stripped (`withDoubleQuotes`), fully-unquoted (`fullyUnquoted`), and unquoted-but-keep-quote-chars (`unquotedKeepQuoteChars`)
5. Build a `ValidationContext` object combining the original command, base command, all quote-extraction variants, and optional tree-sitter analysis data

**Phase 2 — Validator chain** (`src/tools/BashTool/bashSecurity.ts:2308–2412` for sync, `2518–2592` for async):
1. Run **early validators** that can short-circuit with `allow` (empty command, incomplete commands, safe heredoc substitution, git commit with simple message)
2. Run the **main validator chain** of 18 validators. Misparsing validators (those that detect shell-quote/bash differentials) set `isBashSecurityCheckForMisparsing: true`, which causes an early block in the permission flow. Non-misparsing validators (`validateNewlines`, `validateRedirections`) have their results deferred so that any later misparsing validator can take precedence.

### Quote Extraction

`extractQuotedContent` (`src/tools/BashTool/bashSecurity.ts:128–174`) is a character-by-character state machine that tracks single-quote and double-quote state to produce three output strings:
- **`withDoubleQuotes`**: Content with single-quoted regions removed (double-quoted content preserved)
- **`fullyUnquoted`**: Content with both single and double-quoted regions removed
- **`unquotedKeepQuoteChars`**: Like `fullyUnquoted` but preserves the quote delimiter characters themselves (used by `validateMidWordHash` to detect quote-adjacent `#`)

### Safe Heredoc Detection

`isSafeHeredoc` (`src/tools/BashTool/bashSecurity.ts:317–513`) is an **early-allow path** that identifies provably-safe `$(cat <<'DELIM'...DELIM)` patterns. This is critical because heredoc substitutions contain `$(` which would otherwise be flagged by `validateDangerousPatterns`. The check is intentionally strict:

1. Match `$(cat <<` with a single-quoted or backslash-escaped delimiter
2. Verify the opening line has no extra content after the delimiter
3. Use **line-based matching** (not regex `[\s\S]*?`) to find the closing delimiter, exactly replicating bash's behavior of closing at the FIRST matching line
4. Reject nested heredoc matches (which would corrupt string indices during stripping)
5. Verify the heredoc is in **argument position** (non-whitespace prefix before `$(`), not command-name position
6. Verify remaining text (with heredocs stripped) contains only safe ASCII characters
7. Recursively validate the remaining text through `bashCommandIsSafe_DEPRECATED`

### Tree-Sitter Integration (async path)

The async entry point (`src/tools/BashTool/bashSecurity.ts:2426–2592`) attempts to parse the command via tree-sitter for more accurate analysis:
- Uses tree-sitter's quote context instead of regex-based `extractQuotedContent`
- Logs divergences between tree-sitter and regex outputs for monitoring
- Passes `treeSitter` data in the `ValidationContext`, allowing individual validators to use AST information (e.g., `validateBackslashEscapedOperators` skips its regex check when tree-sitter confirms no operator nodes exist; `validateCommentQuoteDesync` skips entirely when tree-sitter provides authoritative quote context)

## Function Signatures

### `bashCommandIsSafe_DEPRECATED(command: string): PermissionResult`

Synchronous security validation using regex and shell-quote parsing. Returns a `PermissionResult` with:
- `behavior: 'passthrough'` — command passed all checks, continue to permission evaluation
- `behavior: 'ask'` — security concern detected, prompt the user
- `behavior: 'allow'` — (from early validators only, converted to `passthrough` in the pipeline)

May include `isBashSecurityCheckForMisparsing: true` to signal that the concern is a parser differential requiring an early block.

> Source: `src/tools/BashTool/bashSecurity.ts:2257`

### `bashCommandIsSafeAsync_DEPRECATED(command: string, onDivergence?: () => void): Promise<PermissionResult>`

Async version that uses tree-sitter when available. The optional `onDivergence` callback batches divergence logging when called in a fanout loop (avoids event-loop starvation from per-subcommand `logEvent` calls).

> Source: `src/tools/BashTool/bashSecurity.ts:2426`

### `stripSafeHeredocSubstitutions(command: string): string | null`

Detects well-formed `$(cat <<'DELIM'...DELIM)` heredoc substitution patterns and returns the command with matched heredocs stripped, or `null` if none found. Used by the pre-split gate to strip safe heredocs and re-check the remainder.

> Source: `src/tools/BashTool/bashSecurity.ts:521`

### `hasSafeHeredocSubstitution(command: string): boolean`

Detection-only wrapper around `stripSafeHeredocSubstitutions`.

> Source: `src/tools/BashTool/bashSecurity.ts:581`

## Interface/Type Definitions

### `ValidationContext`

The shared state passed to every validator function (`src/tools/BashTool/bashSecurity.ts:103–117`):

| Field | Type | Description |
|-------|------|-------------|
| `originalCommand` | `string` | The raw command as submitted |
| `baseCommand` | `string` | First word of the command (e.g., `git`, `jq`) |
| `unquotedContent` | `string` | Single-quotes stripped (double-quote content preserved) |
| `fullyUnquotedContent` | `string` | Both quote types stripped, safe redirections removed |
| `fullyUnquotedPreStrip` | `string` | Both quotes stripped, BEFORE `stripSafeRedirections` |
| `unquotedKeepQuoteChars` | `string` | Quotes stripped but delimiter chars preserved |
| `treeSitter` | `TreeSitterAnalysis \| null` | Optional AST data from tree-sitter |

### `QuoteExtraction`

Return type of `extractQuotedContent` (`src/tools/BashTool/bashSecurity.ts:119–126`):

| Field | Type | Description |
|-------|------|-------------|
| `withDoubleQuotes` | `string` | Content with single-quoted regions removed |
| `fullyUnquoted` | `string` | Content with both quote types removed |
| `unquotedKeepQuoteChars` | `string` | Quoted content removed but quote delimiters preserved |

### `BASH_SECURITY_CHECK_IDS`

Numeric constants (1–23) identifying each security check for analytics logging (`src/tools/BashTool/bashSecurity.ts:77–101`). Used in `logEvent('tengu_bash_security_check_triggered', { checkId, subId })` calls throughout the validators.

## Configuration & Defaults

### Blocklists

- **`COMMAND_SUBSTITUTION_PATTERNS`** (lines 16–41): 11 regex patterns for command/parameter substitution detection including `$()`, `${}`, process substitution (`<()`, `>()`), and Zsh-specific expansions (`=cmd`, `~[`, `(e:`, `(+`, `} always {`)
- **`ZSH_DANGEROUS_COMMANDS`** (lines 45–74): Set of 17 Zsh-specific commands/builtins blocked as defense-in-depth (`zmodload`, `sysopen`, `sysread`, `syswrite`, `sysseek`, `zpty`, `ztcp`, `zsocket`, `mapfile`, `zf_rm`, `zf_mv`, `zf_ln`, `zf_chmod`, `zf_chown`, `zf_mkdir`, `zf_rmdir`, `zf_chgrp`, `emulate`)
- **`SHELL_OPERATORS`** (line 1629): Set of characters treated as shell operators for backslash-escape detection: `;`, `|`, `&`, `<`, `>`
- **`CONTROL_CHAR_RE`** (line 2251): Regex matching non-printable control characters (0x00–0x08, 0x0B–0x0C, 0x0E–0x1F, 0x7F)
- **`UNICODE_WS_RE`** (lines 1899–1900): Regex matching Unicode whitespace characters that cause shell-quote/bash parsing differentials

### Safe Redirection Stripping

`stripSafeRedirections` (`src/tools/BashTool/bashSecurity.ts:176–188`) removes patterns that are safe for security analysis purposes:
- `2>&1` (stderr to stdout)
- `[012]? > /dev/null` (output to null device)
- `< /dev/null` (input from null device)

All patterns require a trailing boundary (`(?=\s|$)`) to prevent prefix-match attacks (e.g., `> /dev/nullo` must not match as `> /dev/null`).

## Validator Reference

The module contains 22 validator functions, each returning a `PermissionResult`. They are organized into early validators (can short-circuit with `allow`) and main validators (return `ask` or `passthrough`):

### Early Validators
| Validator | What it detects |
|-----------|----------------|
| `validateEmpty` | Empty/whitespace-only commands → auto-allow |
| `validateIncompleteCommands` | Commands starting with tab, flags, or operators (continuation fragments) |
| `validateSafeCommandSubstitution` | Safe `$(cat <<'EOF'...)` heredoc patterns → auto-allow |
| `validateGitCommit` | `git commit -m "..."` with simple messages → auto-allow; blocks substitution in messages and shell operators in remainder |

### Main Validators (in execution order)
| Validator | Check ID | Misparsing? | What it detects |
|-----------|----------|-------------|----------------|
| `validateJqCommand` | 2, 3 | Yes | `jq system()` calls; dangerous flags (`-f`, `--rawfile`, etc.) |
| `validateObfuscatedFlags` | 4 | Yes | ANSI-C quoting (`$'...'`), locale quoting (`$"..."`), empty-quote-before-dash, quote-chained flags |
| `validateShellMetacharacters` | 5 | Yes | `;`, `\|`, `&` in quoted arguments (find `-name`, `-path`, `-regex` patterns) |
| `validateDangerousVariables` | 6 | Yes | Variables in redirection/pipe contexts (`$VAR > file`) |
| `validateCommentQuoteDesync` | 22 | Yes | Quote characters inside `#` comments that desync quote tracking |
| `validateQuotedNewline` | 23 | Yes | Newlines inside quotes followed by `#`-prefixed lines (stripCommentLines bypass) |
| `validateCarriageReturn` | 7 | Yes | `\r` outside double quotes (shell-quote/bash tokenization differential) |
| `validateNewlines` | 7 | **No** | Newlines that could separate multiple commands |
| `validateIFSInjection` | 11 | Yes | `$IFS` / `${...IFS...}` usage |
| `validateProcEnvironAccess` | 13 | Yes | `/proc/*/environ` paths |
| `validateDangerousPatterns` | 8 | Yes | Unescaped backticks, `$()`, `${}`, `$[]`, process substitution, Zsh expansions (`=cmd`, `~[`, `(e:`, etc.), PowerShell `<#` |
| `validateRedirections` | 9, 10 | **No** | Input (`<`) and output (`>`) redirection after safe-redirection stripping |
| `validateBackslashEscapedWhitespace` | 15 | Yes | `\<space>` / `\<tab>` outside quotes (path traversal via token-boundary differential) |
| `validateBackslashEscapedOperators` | 21 | Yes | `\;`, `\|`, `\&`, etc. (splitCommand double-parse normalization bug) |
| `validateUnicodeWhitespace` | 18 | Yes | Non-ASCII whitespace characters (`\u00A0`, `\u2000`–`\u200A`, etc.) |
| `validateMidWordHash` | 19 | Yes | `#` preceded by non-whitespace (shell-quote vs bash parser differential) |
| `validateBraceExpansion` | 16 | Yes | Unquoted `{a,b}` or `{1..5}` patterns; mismatched brace counts; quoted braces inside brace contexts |
| `validateZshDangerousCommands` | 20 | Yes | `zmodload`, `sysopen`, `ztcp`, `zpty`, `zf_*` builtins, `emulate`, `fc -e` |
| `validateMalformedTokenInjection` | 14 | Yes | Unbalanced delimiters + command separators (HackerOne eval bypass) |

## Edge Cases & Caveats

### Misparsing vs Non-Misparsing Distinction
The module classifies validator results into two categories. **Misparsing** results (where the validator and bash interpret the command differently) set `isBashSecurityCheckForMisparsing: true` and trigger an early block in the permission flow. **Non-misparsing** results (`validateNewlines`, `validateRedirections`) go through the standard permission flow. The main loop defers non-misparsing results to ensure misparsing validators always take precedence (`src/tools/BashTool/bashSecurity.ts:2380–2407`).

### Early-Allow Security Implications
`validateSafeCommandSubstitution` and `validateGitCommit` are early-allow paths that short-circuit the entire validator chain. Both have extensive security hardening:
- `validateGitCommit` bails on backslashes (line 622), shell metacharacters before `-m` (line 644), substitution patterns in double-quoted messages (line 651), and unquoted redirects in the remainder (line 708)
- `isSafeHeredoc` recursively validates the stripped remainder through the full validator chain (line 510)

### `extractQuotedContent` Limitations
The regex-based quote extraction does not understand shell comments — a `#` followed by quote characters can desync the tracker. This is why `validateCommentQuoteDesync` runs before newline validation, and why the tree-sitter path bypasses this check entirely (tree-sitter's AST is authoritative).

### Brace Expansion Detection
The brace expansion validator (`src/tools/BashTool/bashSecurity.ts:1751–1892`) addresses a particularly subtle attack where shell-quote treats `{a,b}` as a literal string but bash expands it into multiple words. The validator counts unescaped braces and flags excess closing braces (attack signature for quoted-brace obfuscation), checks for quoted single-brace characters inside brace contexts, and uses depth-tracking to find expansion triggers (`,` or `..`) at the outermost nesting level.

### Key Code Snippet: Validator Deferred-Result Logic

The main validator loop prioritizes misparsing detections over non-misparsing ones to prevent a weaker `ask` from masking a stronger `ask`:

```typescript
// src/tools/BashTool/bashSecurity.ts:2392-2407
let deferredNonMisparsingResult: PermissionResult | null = null
for (const validator of validators) {
  const result = validator(context)
  if (result.behavior === 'ask') {
    if (nonMisparsingValidators.has(validator)) {
      if (deferredNonMisparsingResult === null) {
        deferredNonMisparsingResult = result
      }
      continue
    }
    return { ...result, isBashSecurityCheckForMisparsing: true as const }
  }
}
if (deferredNonMisparsingResult !== null) {
  return deferredNonMisparsingResult
}
```

### Deprecation Note
Both main entry points are marked `@deprecated` — the primary security gate is now `parseForSecurity` in `ast.ts` (tree-sitter AST-based). These regex/shell-quote paths remain as fallbacks when tree-sitter is unavailable.