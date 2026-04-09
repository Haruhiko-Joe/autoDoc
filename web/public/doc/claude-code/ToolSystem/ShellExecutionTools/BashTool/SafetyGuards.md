# SafetyGuards

## Overview & Responsibilities

SafetyGuards is a pair of modules within the BashTool subsystem (under ToolSystem → ShellExecutionTools → BashTool) that enforce two layers of command safety:

1. **Sandbox enforcement** (`shouldUseSandbox.ts`) — decides whether a given Bash command should execute inside the macOS sandbox.
2. **Destructive command warnings** (`destructiveCommandWarning.ts`) — detects dangerous commands and returns human-readable warnings shown in the permission dialog.

These modules are consumed by BashTool (and reused by PowerShellTool) during the command lifecycle. Sandbox enforcement is a **security control**; destructive command warnings are **purely informational** and do not affect permission logic or auto-approval.

---

## Key Processes

### Sandbox Decision Flow (`shouldUseSandbox`)

The exported `shouldUseSandbox(input)` function (`src/tools/BashTool/shouldUseSandbox.ts:130-153`) runs through four sequential checks, returning `false` (skip sandbox) at the first match:

1. **Global sandbox check** — If `SandboxManager.isSandboxingEnabled()` returns `false`, sandboxing is off entirely. Return `false`.
2. **Explicit disable flag** — If the caller sets `dangerouslyDisableSandbox: true` **and** `SandboxManager.areUnsandboxedCommandsAllowed()` confirms policy permits it, skip the sandbox. Both conditions must hold.
3. **Empty command guard** — If no command string is provided, return `false`.
4. **Excluded command check** — If the command matches a user-configured or dynamically-configured exclusion pattern, skip the sandbox. Otherwise, return `true` (sandbox the command).

### Excluded Command Matching (`containsExcludedCommand`)

The private `containsExcludedCommand(command)` function (`src/tools/BashTool/shouldUseSandbox.ts:21-128`) is a convenience feature for users who want certain commands to always bypass the sandbox. **It is explicitly not a security boundary** — the comment at lines 18-20 makes this clear.

It has two sources of exclusion rules:

#### 1. Dynamic config for internal users (lines 23-50)

When `USER_TYPE === 'ant'`, a feature flag (`tengu_sandbox_disabled_commands`) provides:
- **`substrings`**: If the command string contains any of these substrings, it's excluded.
- **`commands`**: The command is split into subcommands via `splitCommand_DEPRECATED`, and the base command (first token) of each part is checked against this list.

#### 2. User-configured `sandbox.excludedCommands` (lines 52-128)

From `settings.sandbox.excludedCommands`, compound commands (joined by `&&`, `;`, `|` etc.) are split into individual subcommands. For **each subcommand**, the function:

1. **Generates candidate strings** via a fixed-point stripping loop (lines 82-101):
   - `stripAllLeadingEnvVars()` removes environment variable prefixes (e.g., `FOO=bar cmd` → `cmd`), restricted to `BINARY_HIJACK_VARS`
   - `stripSafeWrappers()` removes wrapper commands (e.g., `timeout 30 cmd` → `cmd`)
   - These are applied iteratively until no new candidates are produced, handling interleaved patterns like `timeout 300 FOO=bar bazel run`

2. **Matches each candidate** against each exclusion pattern, parsed via `bashPermissionRule()` into one of three rule types (lines 103-124):
   - **`prefix`**: Matches if the candidate equals the prefix or starts with `prefix + ' '`
   - **`exact`**: Matches if the candidate exactly equals the command string
   - **`wildcard`**: Matches via `matchWildcardPattern()`

If **any** subcommand in a compound command fails to match, the entire command stays sandboxed — this prevents sandbox escape via `docker ps && curl evil.com`.

### Destructive Command Warning Flow

`getDestructiveCommandWarning(command)` (`src/tools/BashTool/destructiveCommandWarning.ts:95-102`) iterates through a list of regex patterns and returns the warning string of the first match, or `null` if none match. It is a simple linear scan — first match wins.

---

## Function Signatures

### `shouldUseSandbox(input: Partial<SandboxInput>): boolean`

Determines whether a command should run inside the macOS sandbox.

| Parameter | Type | Description |
|---|---|---|
| `input.command` | `string \| undefined` | The Bash command to evaluate |
| `input.dangerouslyDisableSandbox` | `boolean \| undefined` | Caller-provided flag to request sandbox bypass |

**Returns**: `true` if the command should be sandboxed, `false` otherwise.

> Source: `src/tools/BashTool/shouldUseSandbox.ts:130-153`

### `getDestructiveCommandWarning(command: string): string | null`

Checks if a command matches known destructive patterns.

| Parameter | Type | Description |
|---|---|---|
| `command` | `string` | The full Bash command string |

**Returns**: A human-readable warning string (e.g., `"Note: may discard uncommitted changes"`), or `null` if no destructive pattern is detected.

> Source: `src/tools/BashTool/destructiveCommandWarning.ts:95-102`

---

## Type Definitions

### `SandboxInput`

```typescript
type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}
```

> Source: `src/tools/BashTool/shouldUseSandbox.ts:13-16`

### `DestructivePattern`

```typescript
type DestructivePattern = {
  pattern: RegExp
  warning: string
}
```

> Source: `src/tools/BashTool/destructiveCommandWarning.ts:7-10`

---

## Destructive Command Patterns

The `DESTRUCTIVE_PATTERNS` array (`src/tools/BashTool/destructiveCommandWarning.ts:12-89`) covers these categories:

| Category | Commands Detected | Warning |
|---|---|---|
| **Git — data loss** | `git reset --hard` | May discard uncommitted changes |
| | `git push --force` / `-f` / `--force-with-lease` | May overwrite remote history |
| | `git clean -f` (without `-n`/`--dry-run`) | May permanently delete untracked files |
| | `git checkout .` / `git restore .` | May discard all working tree changes |
| | `git stash drop` / `git stash clear` | May permanently remove stashed changes |
| | `git branch -D` / `--delete --force` | May force-delete a branch |
| **Git — safety bypass** | `git commit/push/merge --no-verify` | May skip safety hooks |
| | `git commit --amend` | May rewrite the last commit |
| **File deletion** | `rm -rf` / `rm -r` / `rm -f` | Force/recursive file removal warnings |
| **Database** | `DROP/TRUNCATE TABLE/DATABASE/SCHEMA` | May drop or truncate database objects |
| | `DELETE FROM table;` (without WHERE) | May delete all rows |
| **Infrastructure** | `kubectl delete` | May delete Kubernetes resources |
| | `terraform destroy` | May destroy Terraform infrastructure |

Notable regex design choices:
- `git clean` explicitly excludes dry-run flags (`-n`, `--dry-run`) to avoid false positives
- `git push --force` matches within the same subcommand boundary (uses `[^;&|\n]*` to avoid crossing into chained commands)
- `rm` patterns anchor to command boundaries (`^` or `[;&|\n]`) to avoid matching `rm` inside other words

---

## Configuration

- **`settings.sandbox.excludedCommands`** — Array of command patterns that should bypass the sandbox. Supports prefix rules (e.g., `docker`), exact rules, and wildcard rules (e.g., `bazel:*`). Configured via the user's settings file.
- **`tengu_sandbox_disabled_commands`** feature flag — Dynamic config (GrowthBook) providing `commands` and `substrings` arrays. Only active when `USER_TYPE=ant` (internal users).
- **`SandboxManager.isSandboxingEnabled()`** — Global toggle for the entire sandbox system.
- **`SandboxManager.areUnsandboxedCommandsAllowed()`** — Policy gate controlling whether `dangerouslyDisableSandbox` is honored.

---

## Edge Cases & Caveats

- **`excludedCommands` is not a security boundary** — The comment at lines 18-20 of `shouldUseSandbox.ts` explicitly states this. It's a convenience feature; the sandbox permission system (which prompts users) is the actual security control.
- **Compound command splitting** — `containsExcludedCommand` splits on `&&`, `;`, `|` etc. via `splitCommand_DEPRECATED`. If parsing fails (malformed syntax), the raw command is used as a single subcommand (line 67-68) or parsing errors are silently caught (line 45-49).
- **First-match-wins for destructive warnings** — `getDestructiveCommandWarning` returns only the first matching warning. A command like `git reset --hard && rm -rf /` would only surface the `git reset --hard` warning.
- **`dangerouslyDisableSandbox` requires policy approval** — Setting the flag alone is insufficient; `areUnsandboxedCommandsAllowed()` must also return `true`. This is a dual-key design preventing unauthorized sandbox bypass.
- **Iterative stripping is a fixed-point algorithm** — The env-var and wrapper stripping loop (lines 82-101) runs until no new candidates are generated, correctly handling arbitrary interleaving of wrappers and env vars.