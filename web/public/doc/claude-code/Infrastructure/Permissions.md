# Permissions

## Overview & Responsibilities

The Permissions module is the central access control system that gates **every tool execution** in Claude Code. It sits within the Infrastructure layer and is consumed by the ToolSystem (which checks permissions before running any tool), the TerminalUI (which renders permission prompts), and the Bootstrap system (which initializes permission state at startup).

The module answers one question for every tool invocation: **should this action be allowed, denied, or should the user be asked?** It does this through a layered evaluation pipeline that considers permission modes, rule-based policies loaded from multiple configuration sources, filesystem path safety checks, bash command classification, and an AI-powered auto-mode classifier.

**Sibling modules** in the Infrastructure layer include configuration management, authentication, git operations, and model selection. The Permissions module depends on the settings subsystem for rule storage and on the analytics service for feature gating.

## Key Concepts

### Permission Modes

The system supports several modes that fundamentally change how tool use is gated (`src/types/permissions.ts:16-38`):

| Mode | Behavior |
|------|----------|
| `default` | Standard mode — checks rules, prompts user for unmatched tools |
| `acceptEdits` | Auto-allows file edits within the working directory |
| `plan` | Read-only plan mode — restricts write operations |
| `bypassPermissions` | Skips all permission checks (requires explicit opt-in) |
| `dontAsk` | Converts all "ask" decisions to "deny" — never prompts |
| `auto` | Uses an AI classifier to decide instead of prompting (ant-only) |

Users cycle through modes with Shift+Tab. The cycling logic lives in `getNextPermissionMode()` (`src/utils/permissions/getNextPermissionMode.ts:34-79`).

### Permission Rules

Rules are the core building block. Each rule has three parts (`src/types/permissions.ts:67-79`):

- **`toolName`**: Which tool this rule applies to (e.g., `"Bash"`, `"Read"`, `"mcp__server1"`)
- **`ruleContent`** (optional): Narrows the rule to specific inputs (e.g., `"npm install"` for Bash)
- **`ruleBehavior`**: One of `allow`, `deny`, or `ask`

Rules are evaluated in strict priority: **deny > ask > allow**. A tool-wide deny rule (`Bash` in deny list) blocks all Bash commands regardless of any specific allow rules.

### Rule Sources

Rules are loaded from multiple sources, each with different scope and persistence (`src/types/permissions.ts:54-62`):

| Source | Scope | Persistence |
|--------|-------|-------------|
| `policySettings` | Enterprise-managed | Persistent, admin-controlled |
| `userSettings` | Global `~/.claude` | Persistent |
| `projectSettings` | Per-project, committed to git | Persistent, shared |
| `localSettings` | Per-project, gitignored | Persistent, local |
| `flagSettings` | From `--settings` CLI flag | Runtime |
| `cliArg` | From CLI arguments | Runtime |
| `command` | From slash command frontmatter | Runtime |
| `session` | In-memory | Current session only |

When `allowManagedPermissionRulesOnly` is enabled in policy settings, only managed (policy) rules are loaded — all other sources are ignored (`src/utils/permissions/permissionsLoader.ts:31-36`).

## Key Process Walkthrough

### Tool Permission Evaluation Flow

The main entry point is `hasPermissionsToUseTool()` (`src/utils/permissions/permissions.ts:473`). Here's the evaluation sequence:

1. **Inner permission check** — calls `hasPermissionsToUseToolInner()` which delegates to each tool's `checkPermissions()` method
2. **On allow** — resets consecutive denial tracking if in auto mode, returns immediately
3. **On ask in `dontAsk` mode** — converts to deny with a rejection message
4. **On ask in `auto` mode** — runs the AI classifier pipeline:
   - Safety checks that aren't classifier-approvable stay as "ask" (user must approve)
   - Checks if `acceptEdits` mode would allow this (fast path to skip classifier API call)
   - Falls back to the YOLO classifier for a final allow/deny decision
5. **On ask in headless/async context** — runs `PermissionRequest` hooks; if no hook decides, auto-denies

### Rule Matching for Shell Commands

Shell tools (Bash, PowerShell) use a three-tier rule matching system (`src/utils/permissions/shellRuleMatching.ts`):

1. **Exact match**: Rule `npm install` matches only `npm install`
2. **Prefix match** (legacy `:*` syntax): Rule `npm:*` matches any command starting with `npm `
3. **Wildcard match**: Rule `git * --force` uses `*` as a glob — matched via regex conversion (`matchWildcardPattern()` at line 90)

The parser (`parsePermissionRule()` at line 159) determines which type a rule string represents.

### Filesystem Path Validation

For file operations, `validatePath()` (`src/utils/permissions/pathValidation.ts:373-485`) runs a security-focused pipeline:

1. **Expand tilde** and strip surrounding quotes
2. **Block UNC paths** — prevents credential leakage via network paths
3. **Reject tilde variants** (`~root`, `~+`, `~-`) — prevents TOCTOU shell expansion attacks
4. **Reject shell expansion** (`$VAR`, `%VAR%`, `=cmd`) — blocks TOCTOU via env variables
5. **Block globs in write operations** — writes must use exact paths
6. **Resolve symlinks** via `safeResolvePath()`
7. **Check `isPathAllowed()`** which evaluates deny rules → internal editable paths → safety checks → working directory → sandbox allowlist → allow rules

### Dangerous Pattern Detection

The system maintains lists of dangerous command patterns (`src/utils/permissions/dangerousPatterns.ts`). When entering auto mode, `isDangerousBashPermission()` (`src/utils/permissions/permissionSetup.ts:94-147`) strips allow rules that would bypass the classifier:

- Tool-level allows (bare `Bash`) — allows everything
- Interpreter prefixes (`python:*`, `node:*`, `ssh:*`) — arbitrary code execution
- Wildcard variants (`python*`, `python -*`)

Cross-platform code execution entry points include interpreters (python, node, ruby, perl), package runners (npx, bunx), and shells (bash, sh, ssh) (`dangerousPatterns.ts:18-42`).

### Auto Mode (YOLO) Classifier

When in auto mode, unresolved "ask" decisions go to the YOLO classifier (`src/utils/permissions/yoloClassifier.ts`). This is an AI side-query that:

1. Builds a system prompt from a base template plus user-customizable allow/deny/environment rules
2. Sends the conversation transcript plus the pending tool use to a classifier model
3. Receives an allow/deny decision with a reason
4. Tracks denial state — after 3 consecutive denials or 20 total, falls back to prompting

Certain tools skip the classifier entirely via `SAFE_YOLO_ALLOWLISTED_TOOLS` (`src/utils/permissions/classifierDecision.ts:56-94`) — these are read-only or metadata-only tools like `Read`, `Grep`, `Glob`, `TodoWrite`, and plan mode tools.

## Function Signatures & Key APIs

### Core Permission Check

```typescript
hasPermissionsToUseTool(tool, input, context, assistantMessage, toolUseID): Promise<PermissionDecision>
```
> `src/utils/permissions/permissions.ts:473`

Main entry point. Returns `{behavior: 'allow', updatedInput}`, `{behavior: 'deny', message}`, or `{behavior: 'ask', ...}`.

### Rule Querying

- `getAllowRules(context)` / `getDenyRules(context)` / `getAskRules(context)` — Flatten rules from all sources into arrays (`permissions.ts:122-231`)
- `toolAlwaysAllowedRule(context, tool)` — Check if tool has a tool-wide allow rule (`permissions.ts:275`)
- `getDenyRuleForTool(context, tool)` — Check for tool-wide deny (`permissions.ts:287`)
- `getRuleByContentsForTool(context, tool, behavior)` — Get content-specific rules as a Map (`permissions.ts:349`)

### Rule Persistence

- `loadAllPermissionRulesFromDisk()` — Load rules from all enabled setting sources (`permissionsLoader.ts:120`)
- `addPermissionRulesToSettings({ruleValues, ruleBehavior}, source)` — Add rules to settings file (`permissionsLoader.ts:229`)
- `deletePermissionRuleFromSettings(rule)` — Remove a rule from settings (`permissionsLoader.ts:163`)

### Permission Updates

`PermissionUpdate` is a discriminated union (`src/utils/permissions/PermissionUpdateSchema.ts:42-78`) supporting:
- `addRules` / `removeRules` / `replaceRules` — Rule CRUD
- `setMode` — Change permission mode
- `addDirectories` / `removeDirectories` — Manage additional working directories

Updates are applied in-memory via `applyPermissionUpdate()` and persisted via `persistPermissionUpdate()` (`src/utils/permissions/PermissionUpdate.ts:55-342`).

### Path Validation

- `validatePath(path, cwd, context, operationType)` — Full path validation pipeline (`pathValidation.ts:373`)
- `isPathAllowed(resolvedPath, context, operationType)` — Core path permission check (`pathValidation.ts:141`)
- `isDangerousRemovalPath(resolvedPath)` — Blocks `rm` on root, home, drive roots (`pathValidation.ts:331`)

### Rule Parsing

- `permissionRuleValueFromString(str)` — Parse `"Bash(npm install)"` → `{toolName: "Bash", ruleContent: "npm install"}` (`permissionRuleParser.ts:93`)
- `permissionRuleValueToString(value)` — Serialize back, escaping parentheses (`permissionRuleParser.ts:144`)
- `normalizeLegacyToolName(name)` — Maps old names like `"Task"` → `"Agent"`, `"KillShell"` → `"TaskStop"` (`permissionRuleParser.ts:31`)

## Interface/Type Definitions

### PermissionDecision

The result of a permission check — a discriminated union on `behavior`:

| Variant | Key Fields | Meaning |
|---------|-----------|---------|
| `allow` | `updatedInput`, `decisionReason` | Tool may execute (input may be modified) |
| `deny` | `message`, `decisionReason` | Tool is blocked |
| `ask` | `message`, `suggestions`, `decisionReason` | User must decide |

### PermissionDecisionReason

Explains *why* a decision was made (`src/types/permissions.ts`):

- `type: 'rule'` — A specific allow/deny/ask rule matched
- `type: 'mode'` — The current permission mode dictated the outcome
- `type: 'hook'` — A PermissionRequest hook made the decision
- `type: 'classifier'` — The bash or auto-mode classifier decided
- `type: 'safetyCheck'` — A filesystem safety check blocked the action
- `type: 'permissionPromptTool'` — An SDK permission prompt tool responded
- `type: 'asyncAgent'` — Auto-denied because no interactive prompt is available

### DenialTrackingState

Tracks classifier denial patterns (`src/utils/permissions/denialTracking.ts:7-10`):

```typescript
type DenialTrackingState = {
  consecutiveDenials: number  // resets on any success
  totalDenials: number        // never resets
}
```

Limits: 3 consecutive or 20 total denials trigger fallback to user prompting (`DENIAL_LIMITS`, line 12).

## Configuration & Defaults

### Settings JSON Structure

Permission rules are stored in settings files under a `permissions` key:

```json
{
  "permissions": {
    "allow": ["Read", "Bash(npm test:*)"],
    "deny": ["Bash(rm -rf:*)"],
    "ask": ["Bash"],
    "defaultMode": "default",
    "additionalDirectories": ["/path/to/extra/dir"]
  }
}
```

### Environment Variables

- `CLAUDE_CODE_TMPDIR` — Override temp directory base path
- `CLAUDE_CODE_DUMP_AUTO_MODE` — Dump classifier request/response for debugging (ant-only)
- `USER_TYPE=ant` — Enables ant-only features (auto mode, additional dangerous patterns)

### Dangerous Files and Directories

Files always requiring explicit approval for edits (`src/utils/permissions/filesystem.ts:57-79`):
- Files: `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`, `.claude.json`
- Directories: `.git`, `.vscode`, `.idea`, `.claude`

## Edge Cases & Caveats

- **Case-insensitive path matching**: All path comparisons are lowercased via `normalizeCaseForComparison()` to prevent bypass on macOS/Windows (e.g., `.cLauDe/Settings.json`)
- **Symlink resolution**: Paths are resolved through symlinks before permission checks. On macOS, `/tmp` → `/private/tmp` — the system resolves this to avoid false denials
- **Legacy tool name aliases**: Old rule names like `"Task"` and `"KillShell"` are transparently normalized to current names (`"Agent"`, `"TaskStop"`)
- **Sandbox write allowlist**: When sandbox mode is active, its write allowlist is treated as additional allowed directories — but the working directory is excluded from this to preserve the `acceptEdits` gate
- **Managed-only mode**: Enterprise deployments can set `allowManagedPermissionRulesOnly` to ignore all user/project rules
- **Shadowed rule detection**: `detectUnreachableRules()` (`shadowedRuleDetection.ts:193`) warns users when specific allow rules are shadowed by tool-wide deny or ask rules — for example, `Bash(ls:*)` in allow is unreachable if `Bash` is in deny
- **Classifier approval tracking**: `classifierApprovals.ts` maintains a Map of tool-use IDs to classifier decisions, enabling the UI to show whether a tool was auto-approved by the bash classifier or auto-mode classifier
- **Auto-mode denial tracking**: `autoModeDenials.ts` keeps a bounded list (max 20) of recently denied commands for display in the `/permissions` UI tab