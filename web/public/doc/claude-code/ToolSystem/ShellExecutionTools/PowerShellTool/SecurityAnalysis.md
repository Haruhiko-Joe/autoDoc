# SecurityAnalysis — PowerShell Security Validation

## Overview & Responsibilities

SecurityAnalysis is the security gate for the PowerShellTool, responsible for determining whether a given PowerShell command is safe to execute without user confirmation. It sits within the **ToolSystem → ShellExecutionTools → PowerShellTool** hierarchy, alongside its sibling BashTool which performs analogous checks for Unix shells.

The module comprises four files that together implement a defense-in-depth strategy:

| File | Role |
|------|------|
| `powershellSecurity.ts` | Core AST-based security checks (23 validators) orchestrated by `powershellCommandIsSafe()` |
| `clmTypes.ts` | CLM (Constrained Language Mode) allowlist — the .NET type boundary |
| `gitSafety.ts` | Git-specific attack vector detection (bare-repo attacks, `.git/` writes) |
| `destructiveCommandWarning.ts` | Human-readable warnings for the permission dialog (informational only) |

The design philosophy is **fail-closed**: if the PowerShell AST cannot be parsed (`valid === false`), the system returns `'ask'` and prompts the user. Every validator either returns `'passthrough'` (no concern found) or `'ask'` (user must approve).

## Key Processes

### Security Validation Flow (`powershellCommandIsSafe`)

The main entry point is `powershellCommandIsSafe(_command, parsed)` at `powershellSecurity.ts:1042-1090`. It receives a pre-parsed PowerShell AST (`ParsedPowerShellCommand`) and runs it through an ordered chain of 23 validators:

1. **Parse validation** — if `parsed.valid === false`, immediately return `'ask'`
2. **Iterate validators** — each check receives the parsed AST and returns `{ behavior, message? }`
3. **Short-circuit** — the first validator returning `'ask'` wins; its message explains the risk
4. **Fallthrough** — if all validators pass, return `'passthrough'`

The validator execution order matters: broader checks (like `checkInvokeExpression`) run before narrower ones (like `checkTypeLiterals`), ensuring the most descriptive warning surfaces first.

### CLM Type Allowlist Check

`clmTypes.ts` implements Microsoft's Constrained Language Mode boundary. The approach inverts CLM's purpose:

1. Microsoft defines ~90 .NET types safe for untrusted code under AppLocker/WDAC lockdown
2. The `CLM_ALLOWED_TYPES` set contains these types in normalized lowercase form (`clmTypes.ts:18-188`)
3. `normalizeTypeName()` strips array suffixes (`String[]` → `string`) and generic brackets (`List[int]` → `list`) (`clmTypes.ts:194-203`)
4. `isClmAllowedType()` checks membership after normalization (`clmTypes.ts:209-211`)
5. Types **not** in the set trigger `'ask'` — they can access system APIs (Reflection, IO.Pipes, Diagnostics.Process, etc.)

Notably, several types that Microsoft's CLM allows are **removed** from this allowlist for additional safety:
- `adsi` / `adsisearcher` — perform network LDAP binds when cast
- `wmi` / `wmiclass` / `wmisearcher` / `cimsession` — perform remote WMI queries

### Git Safety Checks

`gitSafety.ts` detects two git weaponization vectors:

**Bare-repo attack**: If a directory contains `HEAD` + `objects/` + `refs/` but no valid `.git/HEAD`, Git treats it as a bare repository and executes hooks from the working directory.

**Git-internal write + git**: A compound command creates `HEAD`/`objects`/`refs`/`hooks/` then runs `git`, which executes the freshly-created malicious hooks.

The detection flow in `isGitInternalPathPS(arg)` (`gitSafety.ts:139-151`):
1. Normalize the argument via `normalizeGitPathArg()` — strips quotes, backtick escapes, PS provider prefixes, NTFS trailing-dot/space tricks, drive-relative paths
2. Apply `resolveCwdReentry()` — handles `../<cwd-basename>/hooks` re-entry attacks
3. Check against `GIT_INTERNAL_PREFIXES` (`head`, `objects`, `refs`, `hooks`) and `.git` prefix
4. For paths that escape cwd (`../` or absolute), resolve against actual cwd via `resolveEscapingPathToCwdRelative()` — the **sole guard** against the bare-repo HEAD attack

### Destructive Command Warning Generation

`destructiveCommandWarning.ts` is purely informational — it generates warnings displayed in the permission dialog but does **not** affect permission logic or auto-approval. `getDestructiveCommandWarning(command)` (`destructiveCommandWarning.ts:102-109`) regex-matches against patterns covering:

- `Remove-Item` with `-Recurse`/`-Force` (and aliases `rm`, `del`, `rd`, `rmdir`, `ri`)
- `Format-Volume`, `Clear-Disk`
- Git destructive operations (`reset --hard`, `push --force`, `clean -f`, `stash drop/clear`)
- Database DDL (`DROP TABLE`, `TRUNCATE`)
- System operations (`Stop-Computer`, `Restart-Computer`, `Clear-RecycleBin`)

## Function Signatures

### `powershellCommandIsSafe(_command: string, parsed: ParsedPowerShellCommand): PowerShellSecurityResult`

Main security entry point. Runs all 23 validators against the parsed AST.

- **_command**: Raw command string (unused, kept for API compatibility)
- **parsed**: AST output from PowerShell's native parser
- **Returns**: `{ behavior: 'passthrough' | 'ask' | 'allow', message?: string }`

> Source: `src/tools/PowerShellTool/powershellSecurity.ts:1042-1090`

### `isClmAllowedType(typeName: string): boolean`

Checks if a .NET type name is in the Constrained Language Mode allowlist.

- **typeName**: Type name as it appears in the AST (e.g., `"System.Net.WebClient"`, `"string"`)
- **Returns**: `true` if the type is safe per CLM standards

> Source: `src/tools/PowerShellTool/clmTypes.ts:209-211`

### `normalizeTypeName(name: string): string`

Normalizes a type name by lowercasing, stripping array suffixes and generic brackets.

> Source: `src/tools/PowerShellTool/clmTypes.ts:194-203`

### `isGitInternalPathPS(arg: string): boolean`

Detects if an argument resolves to a git-internal path (bare-repo style: `hooks/`, `refs/`, `HEAD`, or standard `.git/` paths).

> Source: `src/tools/PowerShellTool/gitSafety.ts:139-151`

### `isDotGitPathPS(arg: string): boolean`

Narrower variant — only matches paths inside `.git/` (not bare-repo-style root-level `hooks/`, `refs/`).

> Source: `src/tools/PowerShellTool/gitSafety.ts:158-168`

### `getDestructiveCommandWarning(command: string): string | null`

Returns a human-readable warning if the command matches a destructive pattern, or `null` otherwise.

> Source: `src/tools/PowerShellTool/destructiveCommandWarning.ts:102-109`

## Type Definitions

### `PowerShellSecurityResult`

```typescript
type PowerShellSecurityResult = {
  behavior: 'passthrough' | 'ask' | 'allow'
  message?: string
}
```

- `'passthrough'` — no security concern detected by this check; continue to next validator
- `'ask'` — prompt the user before executing; `message` explains the risk
- `'allow'` — explicitly safe (not currently returned by any validator)

> Source: `src/tools/PowerShellTool/powershellSecurity.ts:30-33`

### `DestructivePattern`

```typescript
type DestructivePattern = {
  pattern: RegExp
  warning: string
}
```

> Source: `src/tools/PowerShellTool/destructiveCommandWarning.ts:7-10`

## Complete Validator Catalog

The 23 validators in `powershellCommandIsSafe` execute in this order:

| # | Validator | Threat | Detection Method |
|---|-----------|--------|-----------------|
| 1 | `checkInvokeExpression` | Arbitrary code execution (`iex`, `Invoke-Expression`) | Command name match |
| 2 | `checkDynamicCommandName` | Dynamic command names (`& $expr`) | AST element type ≠ `StringConstant` |
| 3 | `checkEncodedCommand` | Obfuscated payloads (`pwsh -e <base64>`) | PS executable + `-encodedcommand` param |
| 4 | `checkPwshCommandOrFile` | Nested PS process (stdin/positional script) | Any PS executable in command position |
| 5 | `checkDownloadCradles` | Download + execute (`IWR | IEX`) | Downloader + IEX in same/cross statement |
| 6 | `checkDownloadUtilities` | LOLBAS downloads (`certutil -urlcache`, `bitsadmin /transfer`, `Start-BitsTransfer`) | Command name + specific args |
| 7 | `checkAddType` | Runtime .NET compilation | `Add-Type` command name |
| 8 | `checkComObject` | COM object execution (`New-Object -ComObject`) | `-ComObject` param + CLM type check on `-TypeName` |
| 9 | `checkDangerousFilePathExecution` | Script file execution (`Invoke-Command -FilePath`) | FILEPATH_EXECUTION_CMDLETS + `-FilePath`/`-LiteralPath` |
| 10 | `checkInvokeItem` | ShellExecute RCE (`Invoke-Item`, `ii`) | Command name match |
| 11 | `checkScheduledTask` | Persistence (`Register-ScheduledTask`, `schtasks /create`) | Cmdlet set + `/create`/`/change` args |
| 12 | `checkForEachMemberName` | Method invocation by string name (`ForEach-Object -MemberName Kill`) | `-MemberName` param or positional string |
| 13 | `checkStartProcess` | Privilege escalation (`-Verb RunAs`) + nested PS process | `-Verb RunAs` detection, PS executable in args |
| 14 | `checkScriptBlockInjection` | Arbitrary code in script blocks | `hasScriptBlocks` flag + dangerous cmdlet set |
| 15 | `checkSubExpressions` | Hidden command execution via `$()` | `hasSubExpressions` AST flag |
| 16 | `checkExpandableStrings` | Expression injection in double-quoted strings | `hasExpandableStrings` AST flag |
| 17 | `checkSplatting` | Argument obfuscation via `@variable` | `hasSplatting` AST flag |
| 18 | `checkStopParsing` | Parse evasion via `--% ` | `hasStopParsing` AST flag |
| 19 | `checkMemberInvocations` | .NET method access (`.Method()`, `::StaticMethod`) | `hasMemberInvocations` AST flag |
| 20 | `checkTypeLiterals` | Unsafe .NET types (`[Reflection.Assembly]`) | CLM allowlist membership |
| 21 | `checkEnvVarManipulation` | Environment variable poisoning | `env:` scoped variables + write cmdlets/assignments |
| 22 | `checkModuleLoading` | Malicious module execution (`Import-Module`, `Install-Module`) | MODULE_LOADING_CMDLETS set |
| 23 | `checkRuntimeStateManipulation` | Alias/variable hijacking (`Set-Alias`, `Set-Variable`) | RUNTIME_STATE_CMDLETS set |
| — | `checkWmiProcessSpawn` | Process spawning via WMI (`Invoke-WmiMethod`, `Invoke-CimMethod`) | WMI_SPAWN_CMDLETS set |

## Edge Cases & Caveats

- **Alternative parameter prefixes**: PowerShell accepts en-dash (`–`), em-dash (`—`), horizontal bar (`―`), and `/` as parameter delimiters. `psExeHasParamAbbreviation()` normalizes all of these to `-` before matching, preventing bypass via `Start-Process foo –Verb RunAs` (`powershellSecurity.ts:83-100`).

- **NTFS trailing-dot/space stripping**: `normalizeGitPathArg()` simulates Win32 `CreateFileW` behavior where trailing dots and spaces are stripped per path component. This prevents git safety bypass via paths like `hooks .` or `HEAD...` (`gitSafety.ts:68-83`).

- **NTFS 8.3 short names**: `.git` may appear as `GIT~1` (or `GIT~2`, etc.) in short-name form. `matchesDotGitPrefix()` handles this with a `git~\d+` regex (`gitSafety.ts:170-176`).

- **Provider-qualified paths**: PowerShell paths like `FileSystem::hooks/pre-commit` or `Microsoft.PowerShell.Core\FileSystem::path` are stripped before git-internal matching (`gitSafety.ts:59-60`).

- **CLM type removals**: Several types allowed by Microsoft's CLM are intentionally excluded — `adsi`, `adsisearcher`, `wmi`, `wmiclass`, `wmisearcher`, `cimsession` — because they perform network binds when cast, and the target isn't validated in this context (`clmTypes.ts:21-26, 112-118`).

- **New-Object -TypeName via string argument**: `checkComObject` extracts the type name from `New-Object`'s `-TypeName` parameter (named, colon-bound, or positional) and runs it through the CLM allowlist, catching types passed as string arguments that `checkTypeLiterals` would miss (it only sees `[bracket]` syntax) (`powershellSecurity.ts:363-427`).

- **`resolveEscapingPathToCwdRelative` is load-bearing**: This function is the sole guard against the bare-repo HEAD attack. Path validation's `DANGEROUS_FILES` deliberately excludes bare `HEAD` (false-positive risk on legitimate files), so this cwd-resolution check cannot be removed without an alternative guard (`gitSafety.ts:92-104`).

- **Destructive warnings are informational only**: `getDestructiveCommandWarning()` output is displayed in the permission dialog but does not affect auto-approval or permission logic (`destructiveCommandWarning.ts:1-5`).

- **Regex anchoring in destructive patterns**: Patterns are anchored to statement boundaries (`^`, `|`, `;`, `&`, `{`, `(`) so that commands like `git rm --force` don't false-positive on the `rm` pattern (`destructiveCommandWarning.ts:14-16`).