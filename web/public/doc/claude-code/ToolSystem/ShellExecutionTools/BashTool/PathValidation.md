# PathValidation

## Overview & Responsibilities

PathValidation is the file-path constraint enforcement layer for BashTool shell commands. It sits within the **ToolSystem → ShellExecutionTools → BashTool** hierarchy and acts as a security gate: before any shell command executes, this module parses the command, extracts file path arguments, and validates that every path falls within the user's allowed working directories.

Within the BashTool pipeline, `checkPathConstraints` is called during permission checking — after command parsing and security validation, but before actual shell execution. Sibling subsystems handle injection detection (`bashSecurity.ts`), permission pattern matching (`bashPermissions.ts`), and sed-specific validation (`sedValidation.ts`); this module focuses exclusively on *where* commands read from and write to.

## Key Processes

### Main Entry: `checkPathConstraints`

The primary entry point receives the raw command input, the current working directory, and the permission context. It orchestrates validation in this order:

1. **Process substitution check** — Rejects commands containing `>(...)` or `<(...)` patterns (regex-based), since these can execute arbitrary writes not visible as redirect targets. Skipped when AST commands are provided, as the AST parser already catches these via `DANGEROUS_TYPES`. (`src/tools/BashTool/pathValidation.ts:1028`)

2. **Output redirection extraction** — Extracts `>` and `>>` redirect targets either from AST-derived `Redirect[]` objects (preferred) or by falling back to `extractOutputRedirections` (legacy shell-quote path). The AST path avoids a known shell-quote single-quote backslash bug. (`src/tools/BashTool/pathValidation.ts:1046-1048`)

3. **Dangerous redirection detection** — If any redirect target contains shell expansion syntax (`$VAR`, `%VAR%`), the command is blocked because the actual target path can't be statically validated. (`src/tools/BashTool/pathValidation.ts:1052-1061`)

4. **Redirect path validation** — Each output redirect target (except `/dev/null`) is validated against allowed directories as a `create` operation via `validateOutputRedirections`. (`src/tools/BashTool/pathValidation.ts:1062-1070`)

5. **Command path validation** — Iterates over each simple command in the compound command. Uses AST-derived `SimpleCommand` objects with `validateSinglePathCommandArgv` when available, or falls back to `splitCommand_DEPRECATED` + `validateSinglePathCommand`. For each command, it strips safe wrapper programs, identifies whether the base command is a supported path command, extracts paths, and validates them. (`src/tools/BashTool/pathValidation.ts:1077-1102`)

6. **Result** — Returns `passthrough` if all paths are valid, `ask` if user approval is needed, or `deny` if an explicit deny rule blocks the path.

### Path Extraction via `PATH_EXTRACTORS`

The `PATH_EXTRACTORS` map defines how to extract file path arguments from 33 different commands. Each extractor receives the argument array (after wrapper stripping) and returns the list of paths to validate.

**Extraction strategies:**

| Strategy | Commands | Logic |
|----------|----------|-------|
| `filterOutFlags` | `rm`, `cp`, `mv`, `cat`, `head`, `tail`, `sort`, `mkdir`, `touch`, `stat`, `diff`, `wc`, `cut`, `paste`, `column`, `file`, `awk`, `strings`, `hexdump`, `od`, `base64`, `nl`, `sha256sum`, `sha1sum`, `md5sum`, `rmdir`, `uniq` | Collects all non-flag arguments, respecting the POSIX `--` end-of-options delimiter |
| Pattern-then-paths | `grep`, `rg` | First non-flag arg is the pattern, remaining args are paths. Uses `parsePatternCommand` with command-specific flag sets |
| Script-then-files | `sed`, `jq` | First non-flag arg is the script/filter, remaining are file paths. Each has custom flag parsing |
| Custom | `cd` (joins all args into one path), `ls` (defaults to `.`), `find` (collects paths before first predicate flag), `tr` (skips character set args), `git` (only validates `git diff --no-index` paths) |

### POSIX `--` Delimiter Handling (Security)

A critical security feature across extractors is correct handling of the `--` end-of-options delimiter. After `--`, all subsequent arguments are treated as positional (paths), even if they start with `-`. Without this, an attacker could bypass validation:

```bash
rm -- -/../.claude/settings.local.json
```

The `-/...` path starts with `-`, so a naive flag filter would drop it, causing validation to see zero paths and return `passthrough`. The `filterOutFlags` function (`src/tools/BashTool/pathValidation.ts:126-139`) and `parsePatternCommand` (`src/tools/BashTool/pathValidation.ts:142-184`) both track `afterDoubleDash` state to prevent this.

### Dangerous Removal Path Detection

`checkDangerousRemovalPaths` (`src/tools/BashTool/pathValidation.ts:70-108`) runs for `rm` and `rmdir` commands after explicit deny rules but before other results. It expands tildes, resolves relative paths, then calls `isDangerousRemovalPath` (from shared path validation utilities) to catch catastrophic commands like `rm -rf /`. Notably, it checks the path *without* resolving symlinks — on macOS, `/tmp` is a symlink to `/private/tmp`, but `rm -rf /tmp` should still be flagged.

### Compound Command + `cd` Safety

Write operations and output redirections in compound commands containing `cd` are blocked with an `ask` result (`src/tools/BashTool/pathValidation.ts:645-655`, `930-945`). This prevents attacks like:

```bash
cd .claude/ && mv test.txt settings.json
```

Paths are resolved relative to the *original* CWD, but after `cd` the actual operation happens in the new directory. Rather than tracking effective CWD through command chains (which has many edge cases), the module takes the conservative approach of requiring manual approval.

### Safe Wrapper Stripping

`stripWrappersFromArgv` (`src/tools/BashTool/pathValidation.ts:1263-1303`) recursively strips wrapper commands (`time`, `nohup`, `timeout`, `nice`, `stdbuf`, `env`) from the front of an argv array to expose the actual command for path validation. Without this, `timeout 10 rm -rf /` would see `timeout` as the base command and skip path validation entirely.

Each wrapper has its own flag parser:
- **`timeout`**: `skipTimeoutFlags` handles GNU long/short flags, validates flag values against `TIMEOUT_FLAG_VALUE_RE` to reject injection attempts like `timeout -k$(id) 10 ls`
- **`nice`**: Handles `nice cmd`, `nice -N cmd`, and `nice -n N cmd` forms
- **`stdbuf`**: `skipStdbufFlags` parses `-i`/`-o`/`-e` flags in fused/space-separated/long forms
- **`env`**: `skipEnvFlags` handles `VAR=val` assignments and safe flags; rejects `-S` (argv splitter), `-C`, `-P`

## Function Signatures

### `checkPathConstraints(input, cwd, toolPermissionContext, compoundCommandHasCd?, astRedirects?, astCommands?): PermissionResult`

Main entry point. Validates all file paths in a shell command against allowed directories.

- **input**: Bash tool input containing the `command` string
- **cwd**: Current working directory for resolving relative paths
- **toolPermissionContext**: Contains allowed directories and permission rules
- **compoundCommandHasCd**: Whether the full compound command includes a `cd`
- **astRedirects**: Pre-parsed AST redirect nodes (preferred over regex extraction)
- **astCommands**: Pre-parsed AST simple commands (preferred over shell-quote parsing)
- **Returns**: `{ behavior: 'passthrough' | 'ask' | 'deny', message, suggestions?, blockedPath? }`

> Source: `src/tools/BashTool/pathValidation.ts:1013-1109`

### `createPathChecker(command, operationTypeOverride?): (args, cwd, context, compoundCommandHasCd?) => PermissionResult`

Factory that creates a path-checking closure for a specific command. The returned function validates paths, checks for dangerous removals (for `rm`/`rmdir`), and attaches permission suggestions to `ask` results.

> Source: `src/tools/BashTool/pathValidation.ts:703-784`

### `stripWrappersFromArgv(argv: string[]): string[]`

Recursively strips safe wrapper commands (`time`, `nohup`, `timeout`, `nice`, `stdbuf`, `env`) from argv to expose the real command. Returns the original argv if it encounters unrecognized flags (fail-closed).

> Source: `src/tools/BashTool/pathValidation.ts:1263-1303`

## Type Definitions

### `PathCommand`

Union type of 33 command names whose file path arguments are validated: `cd`, `ls`, `find`, `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `cat`, `head`, `tail`, `sort`, `uniq`, `wc`, `cut`, `paste`, `column`, `tr`, `file`, `stat`, `diff`, `awk`, `strings`, `hexdump`, `od`, `base64`, `nl`, `grep`, `rg`, `sed`, `git`, `jq`, `sha256sum`, `sha1sum`, `md5sum`.

> Source: `src/tools/BashTool/pathValidation.ts:27-63`

### `COMMAND_OPERATION_TYPE`

Maps each `PathCommand` to its `FileOperationType` (`read`, `write`, or `create`). This determines how strictly paths are validated — write/create operations require the path to be within an allowed working directory, while read operations can be permitted via read rules.

Notable classifications:
- **write**: `rm`, `rmdir`, `mv`, `cp`, `sed`
- **create**: `mkdir`, `touch`
- **read**: everything else (including `git`, which only validates `diff --no-index`)

> Source: `src/tools/BashTool/pathValidation.ts:552-589`

## Configuration & Defaults

This module has no direct configuration. Its behavior is governed by:

- **Allowed working directories** — sourced from `allWorkingDirectories(toolPermissionContext)`, which aggregates the project root and any additional directories the user has approved for the session
- **Permission rules** — deny/allow rules from the permission system that can explicitly block or permit specific paths
- **`sedCommandIsAllowedByAllowlist`** — When a `sed` command is read-only (e.g., `sed -n '1,10p'`), the operation type is overridden from `write` to `read`, enabling more permissive path validation

## Edge Cases & Caveats

- **`mv`/`cp` with flags are always blocked** — The `COMMAND_VALIDATOR` rejects any `mv` or `cp` command that contains flags (arguments starting with `-`). This is because flags like `--target-directory=PATH` can specify a destination path that bypasses the normal path extraction logic. (`src/tools/BashTool/pathValidation.ts:596-601`)

- **`git` only validates `diff --no-index`** — Most git subcommands operate within the repository and are constrained by git's own security model. Only `git diff --no-index` (which explicitly compares arbitrary filesystem paths) gets path validation. (`src/tools/BashTool/pathValidation.ts:491-508`)

- **Shell-quote backslash bug** — The module has two code paths: an AST-based path (preferred) and a legacy shell-quote path. The AST path exists because shell-quote has a known bug where single-quote backslash sequences silently produce garbled tokens on a *successful* parse, causing path validation to be skipped. When AST data is available, it's always used instead.

- **Bun DCE cliff** — The comment at `src/tools/BashTool/pathValidation.ts:1152-1171` explains that `bashPermissions.ts` contains dead-code copies of wrapper-stripping logic that *cannot be removed* due to a Bun bundler bug where deleting ~80 lines from that file breaks `feature()` dead-code elimination, causing 22/30 classifier tests to fail.

- **Permission suggestions** — When a path is blocked with `ask` behavior, the module attaches actionable suggestions: read operations suggest adding a Read rule for the directory; write/create operations suggest adding the directory to allowed directories and enabling accept-edits mode. (`src/tools/BashTool/pathValidation.ts:744-779`)

- **`/dev/null` is always allowed** — Output redirections to `/dev/null` skip validation entirely. (`src/tools/BashTool/pathValidation.ts:948-950`)

- **Process substitution** — `>(...)` and `<(...)` patterns are blocked in the legacy (non-AST) path because they can execute commands that write to files without appearing as redirect targets. (`src/tools/BashTool/pathValidation.ts:1021-1038`)