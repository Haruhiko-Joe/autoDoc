# Constants and Types

## Overview & Responsibilities

The `ConstantsAndTypes` module is the foundational data layer of Claude Code, sitting within the **Infrastructure** group. It provides three categories of shared definitions that every other module in the application depends on:

1. **Constants** (`src/constants/`) — Hardcoded values governing API limits, beta feature flags, OAuth endpoints, tool identifiers, system prompt templates, output styles, UI glyphs, and prompt text.
2. **Types** (`src/types/`) — TypeScript type definitions for the command interface hierarchy, hook system, permission model, plugin architecture, session logs, branded IDs, and terminal input.
3. **Schemas** (`src/schemas/`) — Zod-based runtime validation schemas for hook configurations.

These definitions are intentionally dependency-free (or nearly so) to prevent circular imports. Other Infrastructure modules, as well as Bootstrap, QueryEngine, ToolSystem, TerminalUI, and Services all import from here.

---

## Constants (`src/constants/`)

### API Limits (`apiLimits.ts`)

Defines server-side limits enforced by the Anthropic API, kept dependency-free to prevent circular imports.

| Constant | Value | Purpose |
|----------|-------|---------|
| `API_IMAGE_MAX_BASE64_SIZE` | 5 MB | Max base64-encoded image size (API hard limit) |
| `IMAGE_TARGET_RAW_SIZE` | 3.75 MB | Derived raw image size to stay under base64 limit |
| `IMAGE_MAX_WIDTH` / `IMAGE_MAX_HEIGHT` | 2000 px | Client-side max dimensions for image resizing |
| `PDF_TARGET_RAW_SIZE` | 20 MB | Max raw PDF size fitting within 32 MB API request limit |
| `API_PDF_MAX_PAGES` | 100 | Max PDF pages accepted by the API |
| `PDF_EXTRACT_SIZE_THRESHOLD` | 3 MB | Size above which PDFs are extracted into page images |
| `PDF_MAX_EXTRACT_SIZE` | 100 MB | Maximum PDF file size for the extraction path |
| `PDF_MAX_PAGES_PER_READ` | 20 | Max pages per single Read tool call |
| `PDF_AT_MENTION_INLINE_THRESHOLD` | 10 | Pages threshold for inline vs. reference treatment on @ mention |
| `API_MAX_MEDIA_PER_REQUEST` | 100 | Max images + PDFs per API request |

> Source: `src/constants/apiLimits.ts:1-95`

### Beta Flags (`betas.ts`)

Beta header strings sent to the Anthropic API to enable experimental features. Each constant is a dated string identifier (e.g., `interleaved-thinking-2025-05-14`). Some are conditionally enabled via `feature()` gates or `USER_TYPE` checks.

Key constants include:
- `INTERLEAVED_THINKING_BETA_HEADER` — Enables interleaved thinking
- `CONTEXT_1M_BETA_HEADER` — 1M context window
- `STRUCTURED_OUTPUTS_BETA_HEADER` — Structured output support
- `WEB_SEARCH_BETA_HEADER` — Web search capability
- `TOOL_SEARCH_BETA_HEADER_1P` / `TOOL_SEARCH_BETA_HEADER_3P` — Tool search (different headers for 1P vs 3P providers)
- `FAST_MODE_BETA_HEADER` — Fast output mode
- `TOKEN_EFFICIENT_TOOLS_BETA_HEADER` — Token-efficient tool serialization

Two provider-specific sets filter which betas go where:
- `BEDROCK_EXTRA_PARAMS_HEADERS` — Betas that must be in Bedrock's `extraBodyParams` (not headers)
- `VERTEX_COUNT_TOKENS_ALLOWED_BETAS` — Betas safe for Vertex's `countTokens` API

> Source: `src/constants/betas.ts:1-53`

### OAuth Configuration (`oauth.ts`)

Central OAuth configuration for authentication flows. Defines scopes, endpoints, and client IDs for three environments:

- **Production** (`PROD_OAUTH_CONFIG`) — Points to `api.anthropic.com` and `platform.claude.com`
- **Staging** — Only included in internal (`ant`) builds
- **Local** — Configurable via environment variables for development

The `getOauthConfig()` function (`src/constants/oauth.ts:186-234`) resolves the active configuration, supporting:
- Environment selection via `getOauthConfigType()`
- Custom OAuth URL override via `CLAUDE_CODE_CUSTOM_OAUTH_URL` (restricted to an allowlist of approved FedStart/PubSec endpoints)
- Client ID override via `CLAUDE_CODE_OAUTH_CLIENT_ID`

OAuth scopes are organized into:
- `CONSOLE_OAUTH_SCOPES` — For API key creation via Console
- `CLAUDE_AI_OAUTH_SCOPES` — For claude.ai subscribers (includes inference, sessions, MCP, file upload)
- `ALL_OAUTH_SCOPES` — Union of both, requested during login

### Tool Identifiers & Restrictions (`tools.ts`)

Defines which tools are available (or blocked) in different execution contexts:

- **`ALL_AGENT_DISALLOWED_TOOLS`** — Tools blocked for all subagents (e.g., `TaskOutput`, `ExitPlanMode`, `AskUserQuestion`). The `Agent` tool itself is only blocked for non-internal users.
- **`ASYNC_AGENT_ALLOWED_TOOLS`** — Whitelist of tools available to async agents (file ops, search, shell, skills, worktrees).
- **`IN_PROCESS_TEAMMATE_ALLOWED_TOOLS`** — Additional tools for in-process teammates in swarm mode (task management, messaging, cron scheduling).
- **`COORDINATOR_MODE_ALLOWED_TOOLS`** — Minimal set for coordinator mode (Agent, TaskStop, SendMessage, SyntheticOutput).

> Source: `src/constants/tools.ts:1-113`

### Tool Result Limits (`toolLimits.ts`)

Controls how large tool results can be before they're persisted to disk:

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_MAX_RESULT_SIZE_CHARS` | 50,000 | Per-tool result cap before disk persistence |
| `MAX_TOOL_RESULT_TOKENS` | 100,000 | Token-based upper bound (~400KB text) |
| `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | 200,000 | Aggregate cap per user message (prevents N parallel tools from blowing up context) |
| `TOOL_SUMMARY_MAX_LENGTH` | 50 | Truncation limit for compact summary views |

### System Prompt Architecture (`prompts.ts`, `systemPromptSections.ts`)

The system prompt is built from composable sections, each wrapped in a `SystemPromptSection` object. Two factory functions create sections with different caching behavior:

- **`systemPromptSection(name, compute)`** — Memoized; computed once and cached until `/clear` or `/compact`
- **`DANGEROUS_uncachedSystemPromptSection(name, compute, reason)`** — Recomputes every turn, breaking prompt cache

`resolveSystemPromptSections()` evaluates all sections in parallel, checking the cache for each non-volatile section (`src/constants/systemPromptSections.ts:43-58`).

The main `getSystemPrompt()` function in `prompts.ts` assembles sections including:
- Identity prefix (varies by interactive vs. non-interactive mode)
- Intro, system, and "doing tasks" guidance
- Actions section (reversibility/blast radius heuristics)
- Tool usage instructions (dynamically adjusted based on enabled tools)
- Output style configuration
- MCP server instructions
- Language preferences
- A **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** marker separating static (globally cacheable) content from session-specific content

### Output Styles (`outputStyles.ts`)

Configurable output personas that alter Claude's behavior:

- **`default`** — No custom prompt (null)
- **`Explanatory`** — Adds educational insights about implementation choices
- **`Learning`** — Pauses to have users write small code pieces for hands-on practice

The `OutputStyleConfig` type defines the shape:

```typescript
type OutputStyleConfig = {
  name: string
  description: string
  prompt: string
  source: SettingSource | 'built-in' | 'plugin'
  keepCodingInstructions?: boolean
  forceForPlugin?: boolean
}
```

Custom styles can be loaded from user settings, project settings, managed (policy) settings, and plugins. Priority order (lowest to highest): built-in → plugin → user → project → managed. The `getAllOutputStyles()` function merges all sources (`src/constants/outputStyles.ts:137-175`).

### Binary File Detection (`files.ts`)

`BINARY_EXTENSIONS` is a `Set` of ~90 extensions spanning images, videos, audio, archives, executables, documents, fonts, bytecode, databases, and design files. Two detection functions are exported:

- `hasBinaryExtension(filePath)` — Extension-based check
- `isBinaryContent(buffer)` — Content-based check using null byte detection and a 10% non-printable threshold over the first 8192 bytes

### UI Figures (`figures.ts`)

Unicode glyphs used throughout the terminal UI, with platform-aware selection (e.g., `BLACK_CIRCLE` uses `⏺` on macOS, `●` elsewhere). Categories include:
- Effort level indicators (`○`, `◐`, `●`, `◉`)
- Media/trigger status (`▶`, `⏸`)
- MCP subscription indicators (`↻`, `←`, `→`)
- Review status diamonds (`◇`, `◆`)
- Bridge spinner frames

### XML Tags (`xml.ts`)

String constants for XML tag names used in message parsing. These provide structure for:
- **Slash commands**: `command-name`, `command-message`, `command-args`
- **Terminal output**: `bash-input`, `bash-stdout`, `bash-stderr`, `local-command-stdout/stderr`
- **Task notifications**: `task-notification`, `task-id`, `tool-use-id`, `status`, `summary`
- **Inter-agent communication**: `teammate-message`, `channel-message`, `cross-session-message`
- **Fork directives**: `fork-boilerplate`, `fork-directive-prefix`

Also exports `COMMON_HELP_ARGS` and `COMMON_INFO_ARGS` arrays for slash command argument parsing.

### Other Constants

- **`common.ts`** — `getLocalISODate()` and `getSessionStartDate()` (memoized for prompt-cache stability)
- **`errorIds.ts`** — Numeric error IDs for production error tracing (currently at next ID 346)
- **`product.ts`** — Product URLs and remote session URL helpers (`getRemoteSessionUrl()`)
- **`system.ts`** — System prompt prefix variants, CLI attribution header generation
- **`cyberRiskInstruction.ts`** — Safety instruction for security-related requests (owned by Safeguards team)
- **`spinnerVerbs.ts`** / **`turnCompletionVerbs.ts`** — Whimsical loading/completion messages
- **`github-app.ts`** — GitHub Actions workflow templates for Claude Code integration
- **`keys.ts`** — GrowthBook client key selection
- **`messages.ts`** — Simple message constants (`NO_CONTENT_MESSAGE`)

---

## Types (`src/types/`)

### Command Interface Hierarchy (`command.ts`)

The command system uses a discriminated union with three variants:

```
Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

- **`PromptCommand`** (`type: 'prompt'`) — Commands that expand into LLM prompts (skills). Has `getPromptForCommand()`, supports `allowedTools`, `model` override, fork context, hooks, and path-based visibility.
- **`LocalCommand`** (`type: 'local'`) — Non-UI commands returning `LocalCommandResult` (text, compact, or skip).
- **`LocalJSXCommand`** (`type: 'local-jsx'`) — Commands rendering React components via `LocalJSXCommandCall`.

All three share `CommandBase` which defines:
- `name`, `description`, `aliases`
- `availability` — Auth/provider gating (`'claude-ai' | 'console'`)
- `isEnabled()` — Runtime conditional enablement
- `isHidden` — Hidden from typeahead/help
- `loadedFrom` — Source tracking (commands, skills, plugin, managed, bundled, mcp)
- `kind` — Distinguishes workflow-backed commands
- `immediate` — Bypasses command queue
- `userInvocable` — Whether users can invoke via `/skill-name`

> Source: `src/types/command.ts:1-217`

### Hook Types (`hooks.ts`)

Defines the hook system's type hierarchy for event-driven extensibility:

**Zod Schemas (runtime validation):**
- `syncHookResponseSchema` — Validates sync hook JSON output including `continue`, `decision`, `systemMessage`, and event-specific `hookSpecificOutput` (a discriminated union on `hookEventName` covering 15+ events: PreToolUse, PostToolUse, SessionStart, PermissionRequest, FileChanged, etc.)
- `hookJSONOutputSchema` — Union of async (`{async: true}`) and sync response schemas
- `promptRequestSchema` — Prompt elicitation protocol for interactive hooks

**TypeScript Types:**
- `HookCallback` — Function-based hook with timeout and internal flag
- `HookCallbackMatcher` — Associates hooks with an optional matcher pattern
- `HookResult` / `AggregatedHookResult` — Outcomes from hook execution including permission decisions, blocking errors, additional context, and retry flags
- `HookProgress` — Progress reporting during hook execution
- `PermissionRequestResult` — Allow/deny discriminated union for permission hooks

> Source: `src/types/hooks.ts:1-291`

### Permission Types (`permissions.ts`)

A comprehensive permission model with clearly separated concerns:

**Permission Modes:**
- External: `acceptEdits`, `bypassPermissions`, `default`, `dontAsk`, `plan`
- Internal additions: `auto` (feature-gated), `bubble`

**Permission Rules:** Each rule has a `source` (userSettings, projectSettings, localSettings, flagSettings, policySettings, cliArg, command, session), a `ruleBehavior` (allow/deny/ask), and a `ruleValue` (toolName + optional ruleContent).

**Permission Decisions:** A three-way discriminated union:
- `PermissionAllowDecision` — Granted, with optional `updatedInput` and `contentBlocks`
- `PermissionAskDecision` — Prompt user, with suggestions, pending classifier checks, and image content blocks
- `PermissionDenyDecision` — Denied with reason

**Decision Reasons** (`PermissionDecisionReason`): 11-variant discriminated union covering rule-based, mode-based, hook-based, classifier-based, sandbox override, safety check, and other sources.

**Classifier Types:** `YoloClassifierResult` supports a 2-stage XML classifier pipeline with per-stage token usage, duration, and request IDs for analytics.

> Source: `src/types/permissions.ts:1-442`

### Plugin Types (`plugin.ts`)

Defines the plugin ecosystem's data model:

- **`BuiltinPluginDefinition`** — Built-in plugins shipped with the CLI, with skills, hooks, MCP servers, and availability checks
- **`LoadedPlugin`** — Runtime representation of a loaded plugin with manifest, paths to components (commands, agents, skills, output styles), hooks, MCP/LSP server configs
- **`PluginError`** — 24-variant discriminated union of plugin error types (path-not-found, git-auth-failed, manifest-parse-error, marketplace-blocked-by-policy, etc.) with `getPluginErrorMessage()` for human-readable formatting
- **`PluginLoadResult`** — `{enabled, disabled, errors}` from the plugin loading pipeline

> Source: `src/types/plugin.ts:1-364`

### Log Types (`logs.ts`)

Defines the session transcript and persistence format:

- **`SerializedMessage`** — A `Message` augmented with session metadata (cwd, userType, timestamp, version, gitBranch, slug)
- **`LogOption`** — Session log entry with creation/modification dates, first prompt, message count, and optional metadata (teamName, agentName, summary, customTitle, PR link, worktree state, etc.)
- **`TranscriptMessage`** — Extended `SerializedMessage` with parent UUID chain, sidechain flag, and agent metadata
- **`Entry`** — 18-variant union of all transcript entry types including `SummaryMessage`, `CustomTitleMessage`, `AiTitleMessage`, `PRLinkMessage`, `WorktreeStateEntry`, `ContentReplacementEntry`, `ContextCollapseCommitEntry`, and more

> Source: `src/types/logs.ts:1-331`

### Branded IDs (`ids.ts`)

TypeScript branded types preventing accidental ID mixing at compile time:
- `SessionId` — Uniquely identifies a Claude Code session
- `AgentId` — Uniquely identifies a subagent within a session (format: `a` + optional label + 16 hex chars)

Helper functions: `asSessionId()`, `asAgentId()`, `toAgentId()` (with regex validation).

> Source: `src/types/ids.ts:1-45`

### Text Input Types (`textInputTypes.ts`)

Props and state types for the terminal text input system:
- `BaseTextInputProps` — 25+ props including value/onChange, cursor control, paste handling, image paste, vim mode, ghost text, and input filtering
- `VimTextInputProps` — Extends base with vim mode support (`INSERT` | `NORMAL`)
- `QueuedCommand` — Rich command object with priority levels (`now` | `next` | `later`), paste contents, bridge origin tracking, meta flags, workload tags, and agent routing

> Source: `src/types/textInputTypes.ts:1-388`

---

## Schemas (`src/schemas/`)

### Hook Schemas (`hooks.ts`)

Zod schemas for validating hook configurations in `settings.json`. Extracted to break import cycles between settings and plugin schema files.

Four hook types are defined as a discriminated union on `type`:

1. **`BashCommandHookSchema`** (`type: 'command'`) — Shell command execution with optional `shell` type (bash/powershell), `timeout`, `async`/`asyncRewake` flags, and `once` (single-fire)
2. **`PromptHookSchema`** (`type: 'prompt'`) — LLM prompt evaluation with optional `model` override and `$ARGUMENTS` placeholder
3. **`HttpHookSchema`** (`type: 'http'`) — HTTP POST to a URL with custom `headers` supporting environment variable interpolation via `allowedEnvVars`
4. **`AgentHookSchema`** (`type: 'agent'`) — Agentic verifier with a prompt describing what to verify, optional `model` override

All four share common fields: `if` (permission rule syntax for filtering), `timeout`, `statusMessage`, and `once`.

The composition hierarchy:
- `HookCommandSchema` = discriminated union of the four types
- `HookMatcherSchema` = `{matcher?: string, hooks: HookCommand[]}`
- `HooksSchema` = partial record from `HookEvent` → `HookMatcher[]`

Inferred TypeScript types (`BashCommandHook`, `PromptHook`, `AgentHook`, `HttpHook`, `HookMatcher`, `HooksSettings`) are exported alongside the schemas.

> Source: `src/schemas/hooks.ts:1-223`

---

## Key Design Decisions

1. **Dependency-free constants**: Files like `apiLimits.ts` and `permissions.ts` are explicitly designed with no (or minimal) runtime dependencies to prevent circular imports — a recurring challenge in a codebase of this size.

2. **Prompt cache stability**: The system prompt architecture uses memoized sections and a `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker to maximize prompt cache hit rates. Volatile sections that recompute every turn are explicitly marked with `DANGEROUS_uncachedSystemPromptSection`.

3. **Branded types for ID safety**: `SessionId` and `AgentId` use TypeScript's branded type pattern to catch accidental ID mixing at compile time rather than runtime.

4. **Discriminated unions everywhere**: Permission decisions, commands, hook types, plugin errors, and transcript entries all use discriminated unions for exhaustive type checking.

5. **Lazy schemas**: Hook schemas use `lazySchema()` wrappers to defer Zod schema construction, avoiding circular initialization issues between modules that depend on each other's types.

6. **Feature-gated dead code elimination**: Many constants use `feature()` gates from `bun:bundle` and `process.env.USER_TYPE` checks, enabling the build system to tree-shake internal-only code from external builds.