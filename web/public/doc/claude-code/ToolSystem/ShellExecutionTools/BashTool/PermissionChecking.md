# Permission Checking

## Overview & Responsibilities

The Permission Checking module is the security gatekeeper for all Bash command execution in Claude Code. It sits within the **BashTool** subsystem (under ToolSystem > ShellExecutionTools) and determines whether a given shell command should be **allowed**, **denied**, or **requires user approval** before execution.

The module spans three files:

- **`src/tools/BashTool/bashPermissions.ts`** (~2600 lines) — The core permission engine. Implements `bashToolHasPermission`, the main entry point that orchestrates AST parsing, rule matching, classifier checks, compound command handling, and suggestion generation.
- **`src/tools/BashTool/bashCommandHelpers.ts`** (~266 lines) — Operator-level permission checking for piped and compound commands using AST-parsed nodes.
- **`src/tools/BashTool/modeValidation.ts`** (~116 lines) — Mode-based auto-approval logic (e.g., `acceptEdits` mode auto-allows filesystem commands).

Sibling modules handle complementary concerns: `bashSecurity.ts` detects command injection patterns, `pathValidation.ts` enforces directory boundaries, `sedValidation.ts` validates sed operations, and `shouldUseSandbox.ts` decides sandboxing.

## Key Processes

### Main Permission Flow (`bashToolHasPermission`)

This is the central orchestrator, called for every Bash command Claude wants to execute. The flow proceeds through a multi-layered decision pipeline:

1. **AST-based security parse** — Parses the command with tree-sitter to produce `SimpleCommand[]` or a `'too-complex'` signal. If tree-sitter is unavailable, falls back to the legacy `shell-quote` parser (`src/tools/BashTool/bashPermissions.ts:1663-1806`).

2. **Too-complex / semantic check** — If the AST finds structures it can't statically analyze (command substitution, expansion, control flow), it checks for explicit deny rules via `checkEarlyExitDeny`, then returns `'ask'` (`src/tools/BashTool/bashPermissions.ts:1741-1769`). For clean parses, `checkSemantics` catches dangerous builtins like `eval` or `zsh`-specific commands (`src/tools/BashTool/bashPermissions.ts:1771-1806`).

3. **Sandbox auto-allow** — If sandboxing is enabled and `autoAllowBashIfSandboxed` is on, commands are auto-allowed unless explicit deny/ask rules exist (`src/tools/BashTool/bashPermissions.ts:1831-1843`).

4. **Exact match check** — Tests whether the full command string exactly matches any deny, ask, or allow rule (`src/tools/BashTool/bashPermissions.ts:1846-1854`).

5. **Bash classifier (deny/ask)** — When classifier permissions are enabled, runs the command through an LLM classifier against user-configured deny and ask description rules in parallel (`src/tools/BashTool/bashPermissions.ts:1859-1971`).

6. **Pipe/operator handling** — Delegates to `checkCommandOperatorPermissions` (in `bashCommandHelpers.ts`) to handle piped commands. Each pipe segment is checked independently, then results are merged (`src/tools/BashTool/bashPermissions.ts:1976-2076`).

7. **Legacy misparsing gate** — On the legacy path (no tree-sitter), runs `bashCommandIsSafeAsync` to detect commands that `splitCommand` might misparse (`src/tools/BashTool/bashPermissions.ts:2085-2142`).

8. **Subcommand splitting and per-subcommand checks** — Splits compound commands (via `&&`, `||`, `;`) into subcommands, filters out `cd ${cwd}` prefixes, and checks each subcommand through `bashToolCheckPermission` (`src/tools/BashTool/bashPermissions.ts:2144-2246`).

9. **cd+git security block** — Blocks compound commands containing both `cd` and `git` to prevent bare repository `core.fsmonitor` attacks (`src/tools/BashTool/bashPermissions.ts:2202-2225`).

10. **Result aggregation** — If all subcommands are allowed and no injection is detected, allows. Otherwise, collects rule suggestions from non-allowed subcommands and returns `'ask'` with suggestions capped at `MAX_SUGGESTED_RULES_FOR_COMPOUND` (5) (`src/tools/BashTool/bashPermissions.ts:2453-2557`).

### Rule Matching Flow (`bashToolCheckPermission`)

Each individual subcommand goes through this ordered evaluation (`src/tools/BashTool/bashPermissions.ts:1050-1178`):

1. **Exact match** — Check deny > ask > allow rules for the exact command string
2. **Prefix/wildcard match** — Check deny > ask rules with prefix and wildcard patterns
3. **Path constraints** — Validate file paths in the command are within allowed directories
4. **Allow rules** — Check prefix/wildcard allow rules
5. **Sed constraints** — Block dangerous sed operations
6. **Mode check** — Apply mode-based auto-approval (via `modeValidation.ts`)
7. **Read-only check** — Auto-allow read-only commands
8. **Passthrough** — No rules match; will trigger a user permission prompt

### Pipe Segment Handling (`bashCommandHelpers.ts`)

The `checkCommandOperatorPermissions` function handles commands with pipes (`|`) and compound operators:

1. **Unsafe compound detection** — Checks for subshells `(...)` and command groups `{...}` via tree-sitter analysis, falling back to regex. These always require approval (`src/tools/BashTool/bashCommandHelpers.ts:216-239`).

2. **Pipe segmentation** — Splits piped commands using `ParsedCommand.getPipeSegments()`, strips output redirections from each segment (`src/tools/BashTool/bashCommandHelpers.ts:242-256`).

3. **Per-segment permission** — Each segment is checked through `bashToolHasPermission` independently via `segmentedCommandPermissionResult` (`src/tools/BashTool/bashCommandHelpers.ts:23-156`).

4. **Cross-segment cd+git detection** — Detects `cd` in one pipe segment and `git` in another to prevent fsmonitor bypass (`src/tools/BashTool/bashCommandHelpers.ts:49-82`).

### Safe Wrapper Stripping

Before matching commands against rules, `stripSafeWrappers` removes safe prefixes in two phases (`src/tools/BashTool/bashPermissions.ts:524-615`):

**Phase 1 — Environment variables**: Strips safe env var assignments like `NODE_ENV=prod`, `RUST_LOG=debug` from the front of the command. Only variables in the `SAFE_ENV_VARS` whitelist are stripped (plus `ANT_ONLY_SAFE_ENV_VARS` for internal users).

**Phase 2 — Wrapper commands**: Strips `timeout`, `time`, `nice`, `stdbuf`, `nohup` with their arguments. For example, `timeout 10 npm install foo` becomes `npm install foo` for rule matching purposes.

This allows a rule like `Bash(npm install:*)` to match `timeout 10 NODE_ENV=prod npm install foo`.

### Mode-Based Auto-Approval (`modeValidation.ts`)

The `checkPermissionMode` function provides mode-specific permission overrides (`src/tools/BashTool/modeValidation.ts:72-109`):

- **`acceptEdits` mode** — Auto-allows filesystem commands: `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed`
- **`bypassPermissions`** and **`dontAsk`** modes — Passed through (handled elsewhere in the pipeline)

For compound commands, each subcommand is validated individually; the first non-passthrough result is returned.

## Function Signatures

### `bashToolHasPermission(input, context, getCommandSubcommandPrefixFn?): Promise<PermissionResult>`

The main entry point. Evaluates a bash command against all permission layers.

- **input.command** — The raw command string to check
- **context** — `ToolUseContext` with app state, abort signal, and session options
- **getCommandSubcommandPrefixFn** — Optional override for prefix extraction (used in tests)
- **Returns** — `PermissionResult` with `behavior: 'allow' | 'deny' | 'ask' | 'passthrough'`

> Source: `src/tools/BashTool/bashPermissions.ts:1663-2557`

### `bashToolCheckPermission(input, toolPermissionContext, compoundCommandHasCd?, astCommand?): PermissionResult`

Per-subcommand permission check. Runs the full rule-matching pipeline synchronously.

- **compoundCommandHasCd** — Whether the parent compound command contains a `cd`; affects path validation
- **astCommand** — Optional AST-parsed `SimpleCommand` for this subcommand; enables precise path validation

> Source: `src/tools/BashTool/bashPermissions.ts:1050-1178`

### `bashToolCheckExactMatchPermission(input, toolPermissionContext): PermissionResult`

Checks only exact-match rules (deny > ask > allow) against the full command string.

> Source: `src/tools/BashTool/bashPermissions.ts:991-1048`

### `checkCommandOperatorPermissions(input, bashToolHasPermissionFn, checkers, astRoot): Promise<PermissionResult>`

Handles pipes, subshells, and command groups. Returns `'passthrough'` for simple commands.

> Source: `src/tools/BashTool/bashCommandHelpers.ts:181-265`

### `stripSafeWrappers(command): string`

Removes safe env vars and wrapper commands from a command string for rule matching.

> Source: `src/tools/BashTool/bashPermissions.ts:524-615`

### `stripAllLeadingEnvVars(command, blocklist?): string`

Aggressively strips ALL leading env vars (not just safe ones). Used for deny/ask rule matching to prevent bypass via `FOO=bar denied_command`.

> Source: `src/tools/BashTool/bashPermissions.ts:733-776`

### `checkPermissionMode(input, toolPermissionContext): PermissionResult`

Mode-based auto-approval entry point. Returns `'allow'` for filesystem commands in `acceptEdits` mode.

> Source: `src/tools/BashTool/modeValidation.ts:72-109`

### `isNormalizedGitCommand(command): boolean` / `isNormalizedCdCommand(command): boolean`

Detect git/cd commands after normalizing away wrappers and shell quotes.

> Source: `src/tools/BashTool/bashPermissions.ts:2567-2611`

## Interface & Type Definitions

### `PermissionResult`

The core return type throughout the module:

| Field | Type | Description |
|-------|------|-------------|
| behavior | `'allow' \| 'deny' \| 'ask' \| 'passthrough'` | The permission decision |
| message | `string?` | Human-readable explanation |
| updatedInput | `object?` | The (possibly modified) input for allowed commands |
| decisionReason | `PermissionDecisionReason?` | Why this decision was made (rule, classifier, mode, etc.) |
| suggestions | `PermissionUpdate[]?` | Suggested permission rules for the user |
| pendingClassifierCheck | `PendingClassifierCheck?` | Metadata for async classifier auto-approval |

### `ShellPermissionRule` (from shared `shellRuleMatching.ts`)

Parsed permission rule structure:

| Variant | Example | Description |
|---------|---------|-------------|
| `exact` | `npm install express` | Matches only this exact command |
| `prefix` | `npm install:*` | Matches any command starting with `npm install ` |
| `wildcard` | `git * --dry-run` | Glob-style pattern matching |

### `CommandIdentityCheckers`

```typescript
type CommandIdentityCheckers = {
  isNormalizedCdCommand: (command: string) => boolean
  isNormalizedGitCommand: (command: string) => boolean
}
```

> Source: `src/tools/BashTool/bashCommandHelpers.ts:18-21`

## Configuration & Defaults

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK` | 50 | Cap on subcommands before falling back to `'ask'` (prevents event loop starvation) |
| `MAX_SUGGESTED_RULES_FOR_COMPOUND` | 5 | Maximum permission rules suggested for a compound command |

> Source: `src/tools/BashTool/bashPermissions.ts:103-110`

### Environment Variables

| Variable | Effect |
|----------|--------|
| `CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK` | When truthy, skips both AST and legacy injection detection |
| `USER_TYPE=ant` | Enables `ANT_ONLY_SAFE_ENV_VARS` stripping and internal analytics logging |

### Safe Environment Variables

The `SAFE_ENV_VARS` whitelist (~50 variables) defines env vars that are stripped before rule matching. Categories include Go build settings (`GOOS`, `GOARCH`), Rust logging (`RUST_LOG`), Node env (`NODE_ENV`), locale/terminal settings, and color configuration. Security-critical variables like `PATH`, `LD_PRELOAD`, `PYTHONPATH`, `NODE_OPTIONS`, and `HOME` are explicitly excluded (`src/tools/BashTool/bashPermissions.ts:378-430`).

### Accept Edits Allowed Commands

```typescript
const ACCEPT_EDITS_ALLOWED_COMMANDS = ['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed']
```

> Source: `src/tools/BashTool/modeValidation.ts:7-15`

## Edge Cases & Caveats

### Security-Critical Behaviors

- **Deny rules use aggressive env var stripping** — `stripAllLeadingEnvVars` strips ALL leading env vars (not just safe ones) for deny/ask rule matching. This prevents bypass via `FOO=bar denied_command` (`src/tools/BashTool/bashPermissions.ts:811-853`).

- **Allow rules use conservative stripping** — Only `SAFE_ENV_VARS` are stripped for allow rules. This prevents `DOCKER_HOST=evil docker ps` from matching a `Bash(docker ps:*)` allow rule (HackerOne #3543050).

- **Compound command guard on prefix/wildcard rules** — Prefix rules like `Bash(cd:*)` do NOT match compound commands like `cd /path && python3 evil.py`. The command is re-split to catch escaping bypasses like `cd src\&\& python3 hello.py` (`src/tools/BashTool/bashPermissions.ts:884-912`).

- **cd+git blocking** — Any compound command containing both `cd` and `git` (even across pipe segments) requires approval to prevent bare repository `core.fsmonitor` RCE attacks (`src/tools/BashTool/bashPermissions.ts:2202-2225`, `src/tools/BashTool/bashCommandHelpers.ts:49-82`).

- **Bare shell prefix rejection** — Prefix suggestions for `sh`, `bash`, `env`, `sudo`, `nice`, etc. are blocked to prevent overly broad rules like `Bash(bash:*)` which would allow arbitrary execution (`src/tools/BashTool/bashPermissions.ts:196-226`).

- **Wrapper stripping has two phases** — Phase 1 strips env vars, Phase 2 strips wrapper commands. Env vars AFTER a wrapper are NOT stripped because wrappers use `execvp`, making `VAR=val` the command to execute, not an env var assignment (HackerOne #3543050) (`src/tools/BashTool/bashPermissions.ts:598-612`).

### Behavioral Notes

- **Shadow mode for tree-sitter** — When `TREE_SITTER_BASH_SHADOW` feature flag is on, tree-sitter parses are run observationally and results are logged, but the legacy path remains authoritative (`src/tools/BashTool/bashPermissions.ts:1707-1739`).

- **Multiple `cd` commands** — Compound commands with more than one `cd` always require approval to prevent confusion about the working directory (`src/tools/BashTool/bashPermissions.ts:2182-2196`).

- **Heredoc and multiline commands** — Exact-match rules are unsuitable for heredoc commands (content changes each invocation). The module extracts a stable prefix before the `<<` operator and suggests a prefix rule instead (`src/tools/BashTool/bashPermissions.ts:307-337`).

- **Speculative classifier checks** — The module supports starting classifier checks speculatively before the permission dialog is shown, so approval can happen instantly if the classifier matches with high confidence (`src/tools/BashTool/bashPermissions.ts:1491-1541`).

- **Subcommand fanout cap** — Legacy `splitCommand` can produce exponentially many subcommands on complex input. Above 50 subcommands, the module short-circuits to `'ask'` to prevent event loop starvation (`src/tools/BashTool/bashPermissions.ts:2162-2179`).

## Key Code Snippets

### Rule matching priority (deny > ask > allow > path > mode > read-only)

```typescript
// 1. Check exact match first
const exactMatchResult = bashToolCheckExactMatchPermission(input, toolPermissionContext)
if (exactMatchResult.behavior === 'deny' || exactMatchResult.behavior === 'ask') {
  return exactMatchResult
}

// 2. Find all matching rules (prefix or exact)
const { matchingDenyRules, matchingAskRules, matchingAllowRules } =
  matchingRulesForInput(input, toolPermissionContext, 'prefix', { skipCompoundCheck })

// 2a. Deny if command has a deny rule
if (matchingDenyRules[0] !== undefined) { return { behavior: 'deny', ... } }

// 2b. Ask if command has an ask rule
if (matchingAskRules[0] !== undefined) { return { behavior: 'ask', ... } }

// 3. Check path constraints
const pathResult = checkPathConstraints(input, getCwd(), toolPermissionContext, ...)
if (pathResult.behavior !== 'passthrough') { return pathResult }

// 5. Allow if command has an allow rule
if (matchingAllowRules[0] !== undefined) { return { behavior: 'allow', ... } }

// 6. Check for mode-specific permission handling
const modeResult = checkPermissionMode(input, toolPermissionContext)
```

> Source: `src/tools/BashTool/bashPermissions.ts:1050-1178`

### Asymmetric env var stripping for deny vs. allow rules

```typescript
// Deny rules: strip ALL env vars to prevent bypass
const matchingDenyRules = filterRulesByContentsMatchingInput(
  input, denyRuleByContents, matchMode,
  { stripAllEnvVars: true, skipCompoundCheck: true },
)

// Allow rules: only strip safe env vars
const matchingAllowRules = filterRulesByContentsMatchingInput(
  input, allowRuleByContents, matchMode,
  { skipCompoundCheck },
)
```

> Source: `src/tools/BashTool/bashPermissions.ts:950-979`