# ReadOnlyValidation

## Overview & Responsibilities

The `readOnlyValidation.ts` module (`src/tools/BashTool/readOnlyValidation.ts`, ~1990 lines) is the gatekeeper that decides whether a bash command can run without explicit user permission in read-only contexts — sandbox mode and plan mode. It sits within the **BashTool** subsystem of the **ShellExecutionTools** group in the **ToolSystem** hierarchy. When Claude wants to execute a shell command, this module determines if the command is purely read-only (and can be auto-approved) or requires further permission checks.

The module's single exported entry point, `checkReadOnlyConstraints()`, validates a command and returns one of three behaviors:
- **`allow`**: The command is confirmed read-only; execute without asking the user.
- **`passthrough`**: The command may not be read-only; delegate to further permission checks.
- **`ask`**: The command is actively dangerous (e.g., UNC path attacks); prompt the user.

## Key Processes

### Main Validation Flow (`checkReadOnlyConstraints`)

The top-level function (`src/tools/BashTool/readOnlyValidation.ts:1876-1990`) orchestrates multiple security checks in sequence:

1. **Parse the command** using `tryParseShellCommand()`. Unparseable commands pass through to other permission checks.
2. **Legacy safety check** via `bashCommandIsSafe_DEPRECATED()` — rejects commands flagged as unsafe before splitting.
3. **UNC path check** — blocks commands containing Windows UNC paths (`\\server\share`) that could trigger WebDAV credential exfiltration.
4. **Git compound command checks** — a series of security gates:
   - Block `cd && git` compounds (prevents navigating into a directory with malicious git hooks).
   - Block git commands if the current directory is a bare/exploited git repo (prevents hook execution via fake repo structure).
   - Block compound commands that write to git-internal paths (`HEAD`, `objects/`, `refs/`, `hooks/`) and then run git.
   - Block git commands outside the original working directory when sandbox is enabled (prevents race conditions with backgrounded commands).
5. **Per-subcommand validation** — splits the compound command (on `|`, `&&`, `;`, etc.) and verifies each subcommand individually via `isCommandReadOnly()`.

### Per-Command Validation (`isCommandReadOnly`)

Each subcommand goes through a layered validation pipeline (`src/tools/BashTool/readOnlyValidation.ts:1678-1752`):

1. Strip trailing `2>&1` stderr redirection.
2. Reject commands with vulnerable UNC paths.
3. Reject commands with **unquoted glob or variable expansion** (`containsUnquotedExpansion`) — these could expand at runtime to bypass regex checks.
4. Try **flag-based validation** via `isCommandSafeViaFlagParsing()` — the most precise method.
5. Fall back to **regex-based validation** against `READONLY_COMMAND_REGEXES` — used for simpler commands. If matched and the command involves git, additionally block `-c`, `--exec-path`, and `--config-env` flags.

### Flag-Based Validation (`isCommandSafeViaFlagParsing`)

The most sophisticated validation path (`src/tools/BashTool/readOnlyValidation.ts:1246-1408`):

1. **Shell-parse** the command into tokens (handling quoting, globs, operators).
2. **Match** the token sequence against `COMMAND_ALLOWLIST` entries, supporting multi-word commands (e.g., `git diff`, `git stash list`).
3. **Special git ls-remote handling** — rejects URLs/remote specs to prevent data exfiltration.
4. **Variable expansion rejection** — any token containing `$` after the command prefix is rejected (prevents parser differentials between the validator and bash).
5. **Brace expansion rejection** — tokens with `{` + `,` or `{` + `..` are blocked.
6. **Flag validation** via `validateFlags()` (from `readOnlyCommandValidation.ts`) — checks each flag/argument against the command's `safeFlags` allowlist.
7. **Regex gate** — if the `CommandConfig` has a `regex`, the raw command must also match it (used for commands like `hostname` that must block positional arguments).
8. **Backtick rejection** — commands without a custom regex are blocked if they contain backticks.
9. **Newline injection check** — `grep`/`rg` commands with `\n`/`\r` in patterns are rejected.
10. **Custom callback** — if `additionalCommandIsDangerousCallback` is defined, it runs as a final check.

## Command Classification System

### `CommandConfig` Type

The core configuration type (`src/tools/BashTool/readOnlyValidation.ts:35-50`) has four fields:

| Field | Type | Purpose |
|-------|------|---------|
| `safeFlags` | `Record<string, FlagArgType>` | Maps each allowed flag to its argument type: `'none'`, `'string'`, `'number'`, `'char'`, `'{}'`, `'EOF'` |
| `regex` | `RegExp` (optional) | Additional regex the raw command must match |
| `additionalCommandIsDangerousCallback` | `(rawCommand, args) => boolean` (optional) | Returns `true` if the command is dangerous |
| `respectsDoubleDash` | `boolean` (optional, default `true`) | Whether `--` ends option parsing |

### `COMMAND_ALLOWLIST`

The primary allowlist (`src/tools/BashTool/readOnlyValidation.ts:128-1137`) defines safe flag sets for 40+ commands across these categories:

- **File search**: `fd`, `fdfind`, `find`, `grep`, `tree`
- **Git operations**: All read-only git subcommands (imported from `GIT_READ_ONLY_COMMANDS`)
- **File inspection**: `file`, `base64`, `sha256sum`, `sha1sum`, `md5sum`
- **Text processing**: `sed` (with `sedCommandIsAllowedByAllowlist` callback), `sort`, `jq`, `uniq`
- **Process inspection**: `ps` (with BSD `e` modifier blocking), `pgrep`, `lsof`
- **Network diagnostics**: `netstat`, `ss`
- **System info**: `date` (blocks time-setting positional args), `hostname` (blocks positional args via regex)
- **Terminal**: `tput` (blocks dangerous capabilities like `init`, `reset`, `clear`, `mc5`)
- **Pipeline**: `xargs` (with safe target command list: `echo`, `printf`, `wc`, `grep`, `head`, `tail`)
- **Documentation**: `man`, `help`, `info`
- **External tool sets**: `RIPGREP_READ_ONLY_COMMANDS`, `PYRIGHT_READ_ONLY_COMMANDS`, `DOCKER_READ_ONLY_COMMANDS`

### `ANT_ONLY_COMMAND_ALLOWLIST`

Anthropic-internal commands that make network requests (`src/tools/BashTool/readOnlyValidation.ts:1141-1199`), only merged when `USER_TYPE === 'ant'`:
- `gh` subcommands (from `GH_READ_ONLY_COMMANDS`)
- `aki` — internal knowledge-base search CLI

### `READONLY_COMMANDS` and `READONLY_COMMAND_REGEXES`

Simpler commands validated by regex pattern matching (`src/tools/BashTool/readOnlyValidation.ts:1432-1570`):

- **Simple commands** (converted via `makeRegexForSafeCommand`): `cat`, `head`, `tail`, `wc`, `stat`, `diff`, `du`, `df`, `cut`, `tr`, `sleep`, `which`, etc. (~50 commands)
- **Custom regexes** for commands needing special patterns: `echo` (no variable expansion), `pwd`, `whoami`, `jq` (blocks `-f`, `--rawfile`, `env`/`$ENV`), `cd`, `ls`, `find` (blocks `-exec`, `-delete`, `-fprint`), `history`, `ip addr`, `ifconfig`
- **Exact-match anchored patterns**: `node -v`, `node --version`, `python --version`, `python3 --version` (prevent `node -v --run <task>` attacks)

## Security Model

### Unquoted Expansion Detection (`containsUnquotedExpansion`)

A character-by-character parser (`src/tools/BashTool/readOnlyValidation.ts:1600-1669`) that tracks single-quote, double-quote, and escape state to detect:

- **Glob characters** (`?`, `*`, `[`, `]`) outside all quotes — could expand to dangerous flags
- **Variable references** (`$VAR`, `$_`, `$@`, `$*`, etc.) outside single quotes — expand at runtime, bypassing static regex checks

Key subtlety: backslash is only an escape character outside single quotes (`src/tools/BashTool/readOnlyValidation.ts:1626`), matching bash's actual behavior where `'\' *` contains a literal backslash and an unquoted glob.

### Git Security Checks

Multiple layers prevent git hook exploitation:

1. **Bare repo detection** (`isCurrentDirectoryBareGitRepo()`) — if the cwd has bare repo structure, git commands are blocked because git might execute hooks from the cwd (`src/tools/BashTool/readOnlyValidation.ts:1930-1936`).
2. **Git-internal path writes** (`commandWritesToGitInternalPaths`) — parses compound commands for writes to `HEAD`, `objects/`, `refs/`, `hooks/` and blocks them if git also runs in the same compound (`src/tools/BashTool/readOnlyValidation.ts:1840-1864`).
3. **cd + git compounds** — blocks navigation to a different directory followed by git (`src/tools/BashTool/readOnlyValidation.ts:1917-1923`).
4. **Sandbox CWD check** — when sandboxing is enabled, git commands outside the original CWD are blocked to prevent race conditions (`src/tools/BashTool/readOnlyValidation.ts:1956-1966`).

### Platform-Specific Handling

- **Windows**: `xargs` is removed from the allowlist because UNC paths in file contents can trigger SMB resolution when piped through xargs (`src/tools/BashTool/readOnlyValidation.ts:1203-1210`).
- **UNC paths**: `containsVulnerableUncPath()` (imported) blocks `\\server\share` patterns that could leak credentials via WebDAV.

### Variable Expansion Token Check

Inside `isCommandSafeViaFlagParsing` (`src/tools/BashTool/readOnlyValidation.ts:1328-1369`), all tokens after the command prefix are scanned for:
- `$` — variable expansion that creates parser differentials (the validator sees a literal `$VAR`, bash expands it to something else)
- `{` with `,` or `..` — brace expansion that could inject flags

The extensive comments document specific attack vectors: `git diff "$Z--output=/tmp/pwned"`, `rg . "$Z--pre=bash" FILE`, and `ps ax"$Z"e`.

## Edge Cases & Caveats

- **`sed` requires dual validation**: flag parsing via `safeFlags` plus a callback to `sedCommandIsAllowedByAllowlist()` that checks the sed expression itself (`src/tools/BashTool/readOnlyValidation.ts:242-246`).
- **`xargs` safe target commands**: After encountering a recognized safe target (e.g., `echo`, `grep`), flag validation stops. Only commands with zero dangerous flags qualify as safe targets (`src/tools/BashTool/readOnlyValidation.ts:1232-1239`).
- **`tput` dangerous capabilities**: Beyond flag checks, specific terminfo capabilities (`init`, `reset`, `clear`, `mc5`, `pfloc`, etc.) are blocked because they can execute programs, reset terminals, or activate media copy (`src/tools/BashTool/readOnlyValidation.ts:990-1045`).
- **`ps` BSD-style options**: The callback blocks BSD-format tokens containing `e` (which shows environment variables), checking for letter-only tokens without a leading dash (`src/tools/BashTool/readOnlyValidation.ts:420-429`).
- **`date` positional arguments**: Non-`+`-prefixed positional arguments could set system time (`MMDDhhmm` format), so the callback rejects them (`src/tools/BashTool/readOnlyValidation.ts:756-794`).
- **`base64` does not respect `--`**: `respectsDoubleDash: false` ensures flag validation continues past `--` for macOS base64 (`src/tools/BashTool/readOnlyValidation.ts:432`).
- **`tree -R` removed**: Despite appearing harmless ("rerun at max depth"), it writes `00Tree.html` files to subdirectories when combined with `-H` (`src/tools/BashTool/readOnlyValidation.ts:657-663`).
- **`fd -l/--list-details` excluded**: Internally executes `ls` as a subprocess, creating PATH hijacking risk (`src/tools/BashTool/readOnlyValidation.ts:77-78`).
- **`lsof +m` blocked via callback**: The `+` prefix is treated as a positional arg by `validateFlags`, so the callback catches it (`src/tools/BashTool/readOnlyValidation.ts:904-909`).
- **Return value semantics**: `passthrough` does not mean "blocked" — it means the command needs further permission evaluation by other subsystems. Only `allow` means auto-approved; `ask` means the command is flagged as actively suspicious.

## Key Code Snippets

### CommandConfig type definition

```typescript
// src/tools/BashTool/readOnlyValidation.ts:35-50
type CommandConfig = {
  safeFlags: Record<string, FlagArgType>
  regex?: RegExp
  additionalCommandIsDangerousCallback?: (
    rawCommand: string,
    args: string[],
  ) => boolean
  respectsDoubleDash?: boolean
}
```

### Token-level variable expansion rejection

```typescript
// src/tools/BashTool/readOnlyValidation.ts:1351-1369
for (let i = commandTokens; i < tokens.length; i++) {
  const token = tokens[i]
  if (!token) continue
  if (token.includes('$')) {
    return false
  }
  if (token.includes('{') && (token.includes(',') || token.includes('..'))) {
    return false
  }
}
```

### Git bare repo compound attack detection

```typescript
// src/tools/BashTool/readOnlyValidation.ts:1840-1864
function commandWritesToGitInternalPaths(command: string): boolean {
  const subcommands = splitCommand_DEPRECATED(command)
  for (const subcmd of subcommands) {
    const trimmed = subcmd.trim()
    const writePaths = extractWritePathsFromSubcommand(trimmed)
    for (const path of writePaths) {
      if (isGitInternalPath(path)) {
        return true
      }
    }
    const { redirections } = extractOutputRedirections(trimmed)
    for (const { target } of redirections) {
      if (isGitInternalPath(target)) {
        return true
      }
    }
  }
  return false
}