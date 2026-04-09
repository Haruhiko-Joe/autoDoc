# Path and Read-Only Validation for PowerShell

## Overview & Responsibilities

This module provides two critical security subsystems for the PowerShellTool: **path validation** and **read-only command validation**. Together they form the security boundary that determines whether a PowerShell command can execute automatically, must prompt the user, or is outright denied.

Within the broader architecture, this module sits inside `ShellExecutionTools > PowerShellTool`, mirroring the same validation patterns used by BashTool for Unix shells. The PowerShellTool's permission pipeline (`powershellPermissions.ts`) calls into these subsystems to make allow/deny/ask decisions before any command reaches the shell.

The module is split into three files:

| File | Lines | Purpose |
|------|-------|---------|
| `pathValidation.ts` | ~2050 | Extracts file paths from parsed commands and validates they stay within allowed directories |
| `readOnlyValidation.ts` | ~1824 | Determines if a command is read-only via a cmdlet allowlist and flag validation |
| `commonParameters.ts` | ~31 | Shared PowerShell common parameter definitions (breaks the import cycle between the other two) |

## Key Processes

### Path Validation Flow

The entry point is `checkPathConstraints()`, called by the permission pipeline with a parsed AST and the tool permission context.

1. **Two-pass deny-first scan** — Iterates ALL statements/paths to ensure deny rules always take precedence over ask results. An ask on statement 1 cannot short-circuit before checking statement 2 for deny rules (`pathValidation.ts:1541-1566`).

2. **Compound command cwd guard** — If the compound command contains a cwd-changing cmdlet (`Set-Location`, `Push-Location`, `Pop-Location`, `New-PSDrive`), all relative paths are treated as unvalidatable because the runtime cwd differs from the validator's static cwd snapshot (`pathValidation.ts:1606-1617`).

3. **Expression pipeline source detection** — Non-CommandAst pipeline elements (string literals, variables) that pipe values to downstream cmdlets are flagged. For example, `'/etc/passwd' | Remove-Item` passes a path via pipeline that extractPathsFromCommand cannot see (`pathValidation.ts:1619-1681`).

4. **Per-command path extraction** via `extractPathsFromCommand()`:
   - Resolves the command name to its canonical cmdlet via `resolveToCanonical()` (from readOnlyValidation.ts)
   - Looks up the cmdlet in `CMDLET_PATH_CONFIG` — a registry of ~30 cmdlets with their path parameters, switches, value parameters, and operation types
   - Walks the args array, classifying each as a path parameter, known switch, known value parameter, or unknown parameter
   - **Unknown parameters force `hasUnvalidatablePathArg`** — this is the structural fix for the "switch whack-a-mole" problem where missing switches caused the heuristic to swallow positional paths (`pathValidation.ts:1463-1486`)

5. **Individual path validation** via `validatePath()`, which applies a layered security check:
   - **Backtick escapes** (`\``) — PowerShell's escape character defeats Node.js path checks; treated as unvalidatable with best-effort deny-rule guessing (`pathValidation.ts:1032-1061`)
   - **Module-qualified provider paths** (`::`) — e.g., `FileSystem::/etc/passwd`; blocked with deny-rule guessing (`pathValidation.ts:1063-1096`)
   - **UNC paths** (`//server/share`, `DavWWWRoot`, `@SSL@`) — blocked to prevent NTLM/Kerberos credential leaks (`pathValidation.ts:1098-1114`)
   - **Variable expansion** (`$`, `%`) — unresolvable at static analysis time (`pathValidation.ts:1117-1126`)
   - **Non-filesystem providers** (`env:`, `HKLM:`, etc.) — platform-aware regex (Windows allows single-letter drive letters; POSIX blocks all drive-prefixed paths) (`pathValidation.ts:1128-1159`)
   - **Glob patterns** — blocked for writes; for reads, the base directory is checked against deny rules but globs themselves force an ask because symlinks inside glob expansion cannot be examined (`pathValidation.ts:1161-1242`)
   - **Path resolution and allowlist check** via `isPathAllowed()` (`pathValidation.ts:863-977`)

6. **isPathAllowed decision chain** (mirrors BashTool):
   1. Deny rules (highest priority)
   2. Internal editable paths (plan files, scratchpad, agent memory)
   3. Safety checks for write operations (dangerous directories)
   4. Working directory containment
   5. Internal readable paths (for reads)
   6. Sandbox write allowlist (for writes outside working directory)
   7. Allow rules
   8. Default: not allowed

7. **Redirection validation** — File redirections (`>`, `>>`) on both top-level and nested commands are validated as `'create'` operations (`pathValidation.ts:1937-2041`).

8. **Dangerous removal hard-deny** — `Remove-Item` on system-critical paths (`/`, `~`, `/etc`, `/usr`, etc.) is unconditionally denied, checked against both the raw path (pre-realpath) and the resolved path (`pathValidation.ts:1723-1749`).

### Read-Only Validation Flow

The entry point is `isReadOnlyCommand()`, which determines if a command can auto-execute without permission prompting.

1. **Parse validation** — Requires a valid AST; returns `false` (not read-only) if parsing failed (`readOnlyValidation.ts:1177-1185`).

2. **Security flag rejection** — Commands with script blocks, subexpressions, expandable strings, splatting, member invocations, assignments, or stop-parsing symbols are immediately rejected (`readOnlyValidation.ts:1191-1201`).

3. **Compound cwd guard** — If multiple commands exist and any is a cwd-changing cmdlet, the whole compound is rejected from read-only classification (`readOnlyValidation.ts:1209-1234`).

4. **Per-pipeline validation**:
   - File redirections (except `> $null`) disqualify the pipeline
   - The **first command** must pass `isAllowlistedCommand()`
   - **Subsequent pipeline commands** must be either safe output cmdlets (currently only `Out-Null`) with zero args, or pass `isAllowlistedCommand()` with arg validation
   - Nested commands in script blocks/parens reject the pipeline (`readOnlyValidation.ts:1293-1301`)

5. **isAllowlistedCommand** performs multi-layered validation (`readOnlyValidation.ts:1310-1516`):
   - **nameType gate** — `'application'` names (containing path chars) are rejected to prevent module-prefix spoofing, with a bypass for `SAFE_EXTERNAL_EXES` (`where.exe`)
   - **elementTypes whitelist** — Only `StringConstant` and `Parameter` are safe; `Variable`, `Other` (hashtables, casts, binary expressions), `SubExpression`, and `ScriptBlock` are rejected. For `'Other'` types, a metachar check (`$`, `@`, `(`, `{`, `[`) allows benign comma-lists like `Select-Object Name, Id`
   - **Colon-bound parameter children** — `-Flag:$env:SECRET` is a single `Parameter` element hiding a variable child; the children tree is inspected to catch this
   - **External command dispatch** — `git`, `gh`, `docker`, `dotnet` delegate to specialized validators with their own subcommand/flag configs
   - **Regex constraints and callbacks** — per-config `regex` and `additionalCommandIsDangerousCallback` (e.g., `argLeaksValue` for `Write-Output`, `Format-Table`, etc.)
   - **Flag validation** — Each flag is checked against `safeFlags` (with `COMMON_PARAMETERS` auto-accepted for cmdlets). `allowAllFlags` skips this check; empty `safeFlags` without `allowAllFlags` rejects all flags

### Sync Security Concerns Pre-Filter

`hasSyncSecurityConcerns()` is a fast regex-based pre-filter checking for: subexpressions `$(`, splatting `@var`, member invocations `.Method(`, assignments `$var =`, stop-parsing `--%`, UNC paths `\\`, and static method calls `::` (`readOnlyValidation.ts:1112-1159`).

## Function Signatures

### Path Validation (`pathValidation.ts`)

#### `checkPathConstraints(input, parsed, toolPermissionContext, compoundCommandHasCd?): PermissionResult`
Main entry point. Returns `'deny'`, `'ask'`, or `'passthrough'`.
- **input.command** — The raw PowerShell command string
- **parsed** — AST from the PowerShell parser
- **toolPermissionContext** — Session permission rules and mode
- **compoundCommandHasCd** — Whether a cwd-changing cmdlet exists in the compound (default `false`)

> Source: `pathValidation.ts:1528-1567`

#### `isDangerousRemovalRawPath(filePath): boolean`
Checks the raw (pre-realpath) path for dangerous removal targets like `/`, `~`, `/etc`.

> Source: `pathValidation.ts:840-846`

#### `dangerousRemovalDeny(path): PermissionResult`
Returns a deny result for protected system paths.

> Source: `pathValidation.ts:848-857`

### Read-Only Validation (`readOnlyValidation.ts`)

#### `isReadOnlyCommand(command, parsed?): boolean`
Determines if the full command is read-only. Requires a valid parsed AST.

> Source: `readOnlyValidation.ts:1168-1305`

#### `isAllowlistedCommand(cmd, originalCommand): boolean`
Checks a single command element against the allowlist with full arg validation.

> Source: `readOnlyValidation.ts:1310-1516`

#### `resolveToCanonical(name): string`
Resolves aliases and strips Windows PATHEXT extensions to canonical lowercase cmdlet names. Only strips extensions on bare names (no path separators) to prevent `scripts\git.exe` spoofing.

> Source: `readOnlyValidation.ts:984-996`

#### `isCwdChangingCmdlet(name): boolean`
Returns true for `Set-Location`, `Push-Location`, `Pop-Location`, `New-PSDrive` (and Windows-only aliases `ndr`/`mount`).

> Source: `readOnlyValidation.ts:1017-1033`

#### `isSafeOutputCommand(name): boolean`
Returns true for safe pipeline-tail cmdlets (currently only `Out-Null`).

> Source: `readOnlyValidation.ts:1038-1041`

#### `isAllowlistedPipelineTail(cmd, originalCommand): boolean`
Checks if a command is a pipeline-tail transformer (`Format-Table`, `Select-Object`, etc.) AND passes `isAllowlistedCommand` with `argLeaksValue` validation.

> Source: `readOnlyValidation.ts:1052-1061`

#### `isProvablySafeStatement(stmt): boolean`
Fail-closed gate: returns true ONLY for `PipelineAst` with all `CommandAst` elements.

> Source: `readOnlyValidation.ts:1072-1082`

#### `hasSyncSecurityConcerns(command): boolean`
Fast regex pre-filter for dangerous patterns (`$(`, `@var`, `.Method(`, `$var=`, `--%`, `\\`, `::`).

> Source: `readOnlyValidation.ts:1112-1159`

#### `argLeaksValue(_cmd, element?): boolean`
Callback for cmdlets that could leak values via display or type-coerce errors. Rejects `Variable`, `Other`, `SubExpression`, `ScriptBlock`, `ExpandableString` element types in arguments.

> Source: `readOnlyValidation.ts:76-115`

### Common Parameters (`commonParameters.ts`)

#### `COMMON_SWITCHES: string[]`
`['-verbose', '-debug']` — switches available on all cmdlets.

#### `COMMON_VALUE_PARAMS: string[]`
`['-erroraction', '-warningaction', '-informationaction', ...]` — value-taking common parameters.

#### `COMMON_PARAMETERS: ReadonlySet<string>`
Union of both sets. Used by readOnlyValidation to auto-accept common params in flag validation, and by pathValidation to merge into per-cmdlet known-param sets.

> Source: `commonParameters.ts:1-31`

## Key Type Definitions

### `CmdletPathConfig` (pathValidation.ts:88-122)
Per-cmdlet configuration for path extraction:

| Field | Type | Description |
|-------|------|-------------|
| `operationType` | `'read' \| 'write' \| 'create'` | Whether the cmdlet reads or writes |
| `pathParams` | `string[]` | Parameters accepting file paths |
| `knownSwitches` | `string[]` | Switch parameters (no value) |
| `knownValueParams` | `string[]` | Value params that are NOT paths |
| `leafOnlyPathParams?` | `string[]` | Params with leaf-only filenames (e.g., `New-Item -Name`) |
| `positionalSkip?` | `number` | Leading positionals to skip (e.g., `Invoke-WebRequest`'s URI) |
| `optionalWrite?` | `boolean` | True if writes only occur when a path param is present |

### `CommandConfig` (readOnlyValidation.ts:39-56)
Per-command read-only allowlist entry:

| Field | Type | Description |
|-------|------|-------------|
| `safeFlags?` | `string[]` | Allowed flags for this command |
| `allowAllFlags?` | `boolean` | Skip flag validation entirely |
| `regex?` | `RegExp` | Constraint on the original command string |
| `additionalCommandIsDangerousCallback?` | `(cmd, element?) => boolean` | Custom danger check |

## Configuration & Registries

### CMDLET_PATH_CONFIG (~30 entries, pathValidation.ts:124-765)
Covers all filesystem-touching cmdlets:
- **Write**: `Set-Content`, `Add-Content`, `Remove-Item`, `Clear-Content`, `Out-File`, `Tee-Object`, `Export-Csv`, `Export-Clixml`, `New-Item`, `Copy-Item`, `Move-Item`, `Rename-Item`, `Set-Item`, `Invoke-WebRequest`, `Invoke-RestMethod`, `Expand-Archive`, `Compress-Archive`, `Set-ItemProperty`, `New-ItemProperty`, `Remove-ItemProperty`, `Clear-Item`, `Export-Alias`
- **Read**: `Get-Content`, `Get-ChildItem`, `Get-Item`, `Get-ItemProperty`, `Get-ItemPropertyValue`, `Get-FileHash`, `Get-Acl`, `Format-Hex`, `Test-Path`, `Resolve-Path`, `Convert-Path`, `Select-String`, `Set-Location`, `Push-Location`, `Pop-Location`, `Select-Xml`, `Get-WinEvent`

### CMDLET_ALLOWLIST (~80 entries, readOnlyValidation.ts:129-882)
Categories include:
- **Filesystem read-only**: `Get-ChildItem`, `Get-Content`, `Get-Item`, `Test-Path`, `Resolve-Path`, `Get-FileHash`, `Get-Acl`
- **Navigation**: `Set-Location`, `Push-Location`, `Pop-Location`
- **Text/filtering**: `Select-String`
- **Data conversion**: `ConvertTo-Json`, `ConvertFrom-Json`, `ConvertTo-Csv`, `ConvertFrom-Csv`, `ConvertTo-Xml`, `ConvertTo-Html`, `Format-Hex`
- **Object inspection**: `Get-Member`, `Get-Unique`, `Compare-Object`, `Join-String`, `Get-Random`
- **Path utilities**: `Convert-Path`, `Join-Path`, `Split-Path`
- **System info**: `Get-Process`, `Get-Service`, `Get-ComputerInfo`, `Get-Host`, `Get-Date`, `Get-Location`, `Get-PSDrive`, `Get-Module`, `Get-Alias`, `Get-History`, `Get-Culture`, etc.
- **Output/display**: `Write-Output`, `Write-Host`, `Start-Sleep`, `Format-Table/List/Wide/Custom`, `Measure-Object`, `Select-Object`, `Sort-Object`, `Group-Object`, `Where-Object`, `Out-String`, `Out-Host` (all with `argLeaksValue` guard)
- **Network info** (Windows): `Get-NetAdapter`, `Get-NetIPAddress`, `Get-NetIPConfiguration`, `Get-NetRoute`, `Get-DnsClientCache`, `Get-DnsClient`
- **Event log**: `Get-EventLog`, `Get-WinEvent`
- **External commands**: `git`, `gh`, `docker`, `dotnet` (delegated to shared validation)
- **Windows native**: `ipconfig`, `netstat`, `systeminfo`, `tasklist`, `where.exe`, `hostname`, `whoami`, `ver`, `arp`, `route`, `getmac`, `file`, `tree`, `findstr`

### Notable Security Removals
Several cmdlets were explicitly removed from the allowlist with documented rationale:
- **Get-Command/Get-Help** — Module autoload runs arbitrary `.psm1` init code
- **Select-Xml/Test-Json** — XXE/external entity resolution triggers network requests
- **Get-WmiObject/Get-CimInstance** — Win32_PingStatus sends ICMP; remote query capability
- **Get-Clipboard** — Exposes sensitive clipboard data
- **netsh** — Grammar too complex to allowlist safely

## Edge Cases & Caveats

- **PowerShell prefix matching**: `-Lit` matches `-LiteralPath`. The `matchesParam()` function handles this (`pathValidation.ts:772-782`).

- **Colon syntax**: PowerShell allows `-Path:value` as a single token. Path extraction must split on the colon and check for complex values (arrays, subexpressions, variables) that hide multiple paths (`pathValidation.ts:793-803`).

- **Unicode dashes**: PowerShell accepts en-dash (U+2013), em-dash (U+2014), and horizontal-bar (U+2015) as parameter prefixes. The validator uses `isPowerShellParameter()` with AST element types rather than `startsWith('-')` to catch these.

- **Windows PATHEXT**: `git.exe`, `git.cmd`, `git.bat`, `git.com` are stripped to `git` for canonical resolution, but only for bare names — `scripts\git.exe` is NOT canonicalized to prevent spoofing (`readOnlyValidation.ts:966-996`).

- **Provider-path platform split**: On Windows, single-letter drive prefixes (C:, D:) are allowed through; on POSIX, ALL `<name>:` prefixes are blocked since they could be PSDrive mappings to arbitrary filesystem roots (`pathValidation.ts:1132-1159`).

- **Prototype-chain pollution defense**: `CMDLET_ALLOWLIST` uses `Object.create(null)` so attacker-controlled names like `'constructor'` or `'__proto__'` return `undefined` (`readOnlyValidation.ts:129-130`).

- **Git global flag parser differential**: Attached-form short flags like `-ccore.pager=sh` and dangerous flags like `--attr-source` are explicitly handled to prevent parser differentials where the validator and git disagree on what the subcommand is (`readOnlyValidation.ts:1537-1642`).

- **Pipeline-tail transformer migration**: `Format-Table`, `Select-Object`, `Sort-Object`, etc. were moved from the name-only `SAFE_OUTPUT_CMDLETS` set to `CMDLET_ALLOWLIST` with `argLeaksValue` guards, because all accept calculated-property hashtables that can execute arbitrary expressions (`readOnlyValidation.ts:507-565`).

- **Two-pass deny precedence**: `checkPathConstraints` uses a two-pass approach where deny results are returned immediately but ask results are deferred via `firstAsk ??=`, ensuring deny always wins over ask even when encountered later in the statement list (`pathValidation.ts:1541-1566`).

- **Glob symlink limitation**: Glob patterns in read operations cannot be fully validated because symlinks inside the glob expansion are not examined. The base directory is checked against deny rules, but the overall result is an ask (`pathValidation.ts:1199-1242`).