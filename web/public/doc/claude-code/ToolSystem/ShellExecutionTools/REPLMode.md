# REPLMode

## Overview & Responsibilities

REPLMode is a configuration and tool-registry module within the **ToolSystem → ShellExecutionTools** area of the architecture. It governs whether REPL mode is active and, when it is, controls which primitive tools are hidden from Claude's direct use (forcing them to be accessed only through the REPL VM context instead).

The module consists of two small files (~85 lines total):

| File | Purpose |
|------|---------|
| `src/tools/REPLTool/constants.ts` | Feature toggle, tool name constant, and the set of hidden tools |
| `src/tools/REPLTool/primitiveTools.ts` | Lazy-initialized list of Tool objects available inside the REPL VM |

## Key Processes

### REPL Mode Activation Flow

The `isReplModeEnabled()` function (`constants.ts:23-30`) evaluates three conditions in order:

1. **Explicit opt-out**: If `CLAUDE_CODE_REPL` is set to a falsy value (e.g. `0`, `false`), REPL mode is **disabled** regardless of anything else.
2. **Legacy opt-in**: If the legacy env var `CLAUDE_REPL_MODE` is truthy (e.g. `1`), REPL mode is **enabled**.
3. **Default for Anthropic CLI users**: If neither override is set, REPL mode activates only when `USER_TYPE === 'ant'` **and** `CLAUDE_CODE_ENTRYPOINT === 'cli'`.

This last condition is significant: SDK entrypoints (`sdk-ts`, `sdk-py`, `sdk-cli`) are intentionally excluded because SDK consumers script direct tool calls (`Bash`, `Read`, etc.) and REPL mode would hide those tools.

### Tool Filtering in the Registry

When REPL mode is enabled, the main tool registry (`src/tools.ts:314-321`) filters out all tools listed in `REPL_ONLY_TOOLS` from the tools exposed to Claude — but only if the REPL tool itself is present in the allowed tools list. This forces Claude to perform file and shell operations through the REPL VM rather than calling primitive tools directly.

### Lazy Primitive Tool Assembly

`getReplPrimitiveTools()` (`primitiveTools.ts:28-39`) uses a module-level cache (`_primitiveTools`) with nullish coalescing assignment (`??=`) to build the tool list exactly once. The lazy pattern exists to avoid a circular import problem: the import chain `collapseReadSearch.ts → primitiveTools.ts → FileReadTool.ts → ...` loops back through the tool registry, so a top-level `const` would hit a Temporal Dead Zone (TDZ) error. Deferring to call-time avoids this.

The function is referenced directly rather than delegating to `getAllBaseTools()` because that function conditionally excludes `Glob`/`Grep` when `hasEmbeddedSearchTools()` is true — REPL mode always needs them available.

## Function Signatures

### `isReplModeEnabled(): boolean`

Returns whether REPL mode is currently active based on environment variables and build-time user type.

- **No parameters**
- **Returns**: `true` if REPL mode should be on

> Source: `src/tools/REPLTool/constants.ts:23-30`

### `getReplPrimitiveTools(): readonly Tool[]`

Returns the list of primitive tool objects accessible inside the REPL VM context. The result is lazily initialized and cached in a module-level variable via `??=` on first call; subsequent calls return the same cached array.

- **No parameters**
- **Returns**: A cached `readonly` array of 8 `Tool` objects

> Source: `src/tools/REPLTool/primitiveTools.ts:28-39`

## Constants and Type Definitions

### `REPL_TOOL_NAME`

```typescript
export const REPL_TOOL_NAME = 'REPL'
```

String constant used to identify the REPL tool throughout the codebase.

> Source: `src/tools/REPLTool/constants.ts:11`

### `REPL_ONLY_TOOLS`

A `Set<string>` containing the runtime tool-name strings that are hidden from Claude's direct invocation when REPL mode is active. These are the values that `allowedTools.filter(tool => !REPL_ONLY_TOOLS.has(tool.name))` matches against:

| Runtime Tool Name | Imported From |
|-------------------|---------------|
| `Read` | `FILE_READ_TOOL_NAME` (`src/tools/FileReadTool/prompt.ts:5`) |
| `Write` | `FILE_WRITE_TOOL_NAME` (`src/tools/FileWriteTool/prompt.ts:3`) |
| `Edit` | `FILE_EDIT_TOOL_NAME` (`src/tools/FileEditTool/constants.ts:2`) |
| `Glob` | `GLOB_TOOL_NAME` (`src/tools/GlobTool/prompt.ts:1`) |
| `Grep` | `GREP_TOOL_NAME` (`src/tools/GrepTool/prompt.ts:4`) |
| `Bash` | `BASH_TOOL_NAME` (`src/tools/BashTool/toolName.ts:2`) |
| `NotebookEdit` | `NOTEBOOK_EDIT_TOOL_NAME` (`src/tools/NotebookEditTool/constants.ts:2`) |
| `Agent` | `AGENT_TOOL_NAME` (`src/tools/AgentTool/constants.ts:1`) |

> Source: `src/tools/REPLTool/constants.ts:37-46`

## Configuration

| Environment Variable | Effect |
|---------------------|--------|
| `CLAUDE_CODE_REPL=0` | Explicitly disables REPL mode (highest priority) |
| `CLAUDE_REPL_MODE=1` | Legacy flag to force-enable REPL mode |
| `USER_TYPE` | Build-time define; REPL defaults on when `ant` |
| `CLAUDE_CODE_ENTRYPOINT` | Must be `cli` for the default-on behavior to activate |

## Edge Cases & Caveats

- **SDK entrypoints are excluded by design**: The default-on logic (`USER_TYPE === 'ant'` + `CLAUDE_CODE_ENTRYPOINT === 'cli'`) deliberately excludes SDK consumers. Since `USER_TYPE` is a build-time `--define`, without this guard the ant-native binary would force REPL mode on every SDK subprocess.
- **Circular import avoidance**: `getReplPrimitiveTools()` must be lazy (not a top-level constant) to break a circular dependency chain through `src/tools/FileReadTool/FileReadTool.ts` and back into the tool registry, which would cause a TDZ runtime error.
- **Divergence from `getAllBaseTools()`**: The primitive tools list is maintained independently because `getAllBaseTools()` conditionally drops `Glob`/`Grep` under embedded search — REPL mode needs them unconditionally.
- **REPL tool presence check**: The tool registry only filters `REPL_ONLY_TOOLS` when the REPL tool itself is in the allowed tools list (`src/tools.ts:315-316`). If the REPL tool is denied or unavailable, primitive tools remain directly accessible.
- **Display-side usage**: `getReplPrimitiveTools()` is also consumed by rendering code (`collapseReadSearch.ts`, `CollapsedReadSearchContent.tsx`) to classify and render virtual messages for these tools even when they are absent from the filtered execution tools list.