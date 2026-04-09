# Bundled Skills

## Overview & Responsibilities

Bundled skills are the set of prompt-driven capabilities that ship compiled into the Claude Code CLI binary. They live under `src/skills/bundled/` and are registered at startup via `initBundledSkills()` (`src/skills/bundled/index.ts:24-79`). Each skill follows a uniform pattern: export a `register*Skill()` function that calls `registerBundledSkill()` from `src/skills/bundledSkills.ts` with a `BundledSkillDefinition` object.

Within the **SkillsAndPlugins** module of the overall architecture, bundled skills are the first-party skill implementations—as opposed to user-defined skills loaded from disk or MCP-based skill builders. The ToolSystem's `SkillTool` invokes these skills when the model or user triggers them via `/skill-name` slash commands or automatic model invocation.

## Key Processes

### Skill Registration Flow

1. At startup, `initBundledSkills()` is called (`src/skills/bundled/index.ts:24`)
2. Each always-on skill's `register*Skill()` function is called directly (lines 25–34)
3. Feature-gated skills are conditionally registered using `feature()` from `bun:bundle` (lines 35–78)—their modules are loaded via `require()` (dynamic import) so they're only pulled into memory when the feature flag is enabled
4. Each `register*Skill()` function calls `registerBundledSkill()` (`src/skills/bundledSkills.ts:53`), which wraps the definition into a `Command` object and pushes it to an internal `bundledSkills` array
5. `getBundledSkills()` returns a copy of this array for consumption by the skill resolution system

### Skill Invocation Flow

1. When a skill is triggered (via `/name` or model invocation), the system calls `getPromptForCommand(args, context)` on the matching `Command`
2. The handler builds a detailed prompt string—often dynamically, incorporating runtime context (debug logs, settings schemas, session memory, detected languages, etc.)
3. If the skill definition includes `files`, `registerBundledSkill` wraps `getPromptForCommand` to lazily extract those files to a temporary directory on first invocation and prepend a "Base directory" line to the prompt (`src/skills/bundledSkills.ts:59-73`)
4. The returned `ContentBlockParam[]` is injected into the conversation as the skill's prompt

### Feature-Gated Registration

Feature-gated skills use `feature()` checks and dynamic `require()` to avoid loading their modules unless the flag is active:

```typescript
// src/skills/bundled/index.ts:47-55
if (feature('AGENT_TRIGGERS')) {
  const { registerLoopSkill } = require('./loop.js')
  registerLoopSkill()
}
```

Some skills also have runtime `isEnabled` callbacks that control visibility on a per-invocation basis (e.g., `loop.ts` delegates to `isKairosCronEnabled()`, `remember.ts` checks `isAutoMemoryEnabled()`).

### Ant-Only Gating

Several skills check `process.env.USER_TYPE !== 'ant'` and return early from their register functions, making them available only to Anthropic employees: `verify`, `loremIpsum`, `skillify`, `stuck`, and `remember`.

## Skill Catalog

### Always-On Skills

| Skill Name | File | User-Invocable | Description |
|---|---|---|---|
| `update-config` | `updateConfig.ts` | Yes | Modifies `settings.json` files—hooks, permissions, env vars, MCP config |
| `keybindings-help` | `keybindings.ts` | No (model-only) | Guides keybinding customization in `~/.claude/keybindings.json` |
| `verify` | `verify.ts` | Yes | Verifies code changes work by running the app (ant-only) |
| `debug` | `debug.ts` | Yes | Enables debug logging, reads session logs, helps diagnose issues |
| `lorem-ipsum` | `loremIpsum.ts` | Yes | Generates filler text for long-context testing (ant-only) |
| `skillify` | `skillify.ts` | Yes | Captures a session's repeatable process into a reusable SKILL.md (ant-only) |
| `remember` | `remember.ts` | Yes | Reviews auto-memory entries and proposes promotions/cleanup (ant-only) |
| `simplify` | `simplify.ts` | Yes | Reviews changed code for reuse, quality, and efficiency via 3 parallel agents |
| `batch` | `batch.ts` | Yes | Orchestrates large parallel changes across 5–30 isolated worktree agents |
| `stuck` | `stuck.ts` | Yes | Diagnoses frozen/slow sessions and reports to Slack (ant-only) |

### Feature-Gated Skills

| Skill Name | File | Feature Flag | Description |
|---|---|---|---|
| `dream` | `dream.js` | `KAIROS` / `KAIROS_DREAM` | (Gated, module not in standard source) |
| `hunter` | `hunter.js` | `REVIEW_ARTIFACT` | (Gated, module not in standard source) |
| `loop` | `loop.ts` | `AGENT_TRIGGERS` | Schedules a recurring prompt on a cron interval |
| `schedule` | `scheduleRemoteAgents.ts` | `AGENT_TRIGGERS_REMOTE` | Creates/manages scheduled remote agents (triggers) |
| `claude-api` | `claudeApi.ts` | `BUILDING_CLAUDE_APPS` | Provides Claude API/SDK guidance with language-specific docs |
| `claude-in-chrome` | `claudeInChrome.ts` | Runtime check | Chrome browser automation via MCP tools |
| `runSkillGenerator` | `runSkillGenerator.js` | `RUN_SKILL_GENERATOR` | (Gated, module not in standard source) |

## BundledSkillDefinition Interface

Defined in `src/skills/bundledSkills.ts:15-41`:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Skill name, used as the slash command (e.g., `debug` → `/debug`) |
| `description` | `string` | Yes | Shown in skill listings; also used by the model to decide when to invoke |
| `aliases` | `string[]` | No | Alternative names for the skill |
| `whenToUse` | `string` | No | Detailed trigger conditions for automatic model invocation |
| `argumentHint` | `string` | No | Displayed as usage hint (e.g., `[issue description]`) |
| `allowedTools` | `string[]` | No | Tools the skill is allowed to use (defaults to `[]`) |
| `model` | `string` | No | Override model for this skill |
| `disableModelInvocation` | `boolean` | No | If `true`, model cannot auto-invoke; user must explicitly call it |
| `userInvocable` | `boolean` | No | Whether users can invoke via slash command (default `true`) |
| `isEnabled` | `() => boolean` | No | Runtime check for skill availability |
| `hooks` | `HooksSettings` | No | Lifecycle hooks for the skill |
| `context` | `'inline' \| 'fork'` | No | Whether skill runs in current conversation or as a sub-agent |
| `files` | `Record<string, string>` | No | Reference files extracted to disk on first invocation |
| `getPromptForCommand` | `(args, context) => Promise<ContentBlockParam[]>` | Yes | Builds the prompt injected into the conversation |

## Notable Skill Implementations

### update-config (`updateConfig.ts`)

The most content-heavy skill. Dynamically generates the full JSON Schema from the Zod `SettingsSchema` at invocation time (`updateConfig.ts:10-13`), ensuring the skill prompt always stays in sync with the actual settings types. The prompt includes comprehensive documentation for hooks (events, matchers, types, patterns) and a detailed hook verification flow. Supports a `[hooks-only]` prefix in args to narrow the prompt to just hooks documentation.

**Allowed tools**: `Read` only—it guides the model to use Edit/Write for the actual file changes.

### claude-api (`claudeApi.ts`)

Lazy-loads 247KB of bundled Markdown documentation from `claudeApiContent.ts` only when invoked. Auto-detects the project language by scanning the working directory for file extensions and config files (`claudeApi.ts:30-53`), then filters the included docs to the relevant language (Python, TypeScript, Java, Go, Ruby, C#, PHP, or curl). Injects all docs inline as `<doc>` tags with path attributes.

### batch (`batch.ts`)

Orchestrates large-scale parallel refactors. Guides the model through three phases: (1) research and plan in plan mode, decomposing work into 5–30 independent units; (2) spawn isolated worktree agents in parallel; (3) track progress via a status table. Requires a git repository and validates this before proceeding (`batch.ts:116-119`).

### simplify (`simplify.ts`)

Launches three parallel review agents (code reuse, code quality, efficiency) that each analyze the same git diff independently, then aggregates and fixes the findings. References the `Agent` tool by its constant name for prompt construction.

### scheduleRemoteAgents (`scheduleRemoteAgents.ts`)

The most complex skill in terms of pre-invocation setup. Before building its prompt, it: authenticates via OAuth, fetches remote environments (auto-creating one if none exist), detects connected MCP connectors from the context, checks GitHub repo access, and resolves the user's timezone. Includes a Base58 decoder for converting tagged MCP server IDs to UUIDs (`scheduleRemoteAgents.ts:35-57`).

### skillify (`skillify.ts`)

Extracts session memory and all user messages from the conversation history, then guides a multi-round interview process to capture the session's repeatable workflow as a `SKILL.md` file. Uses template variable substitution (`{{sessionMemory}}`, `{{userMessages}}`, etc.) to build its prompt.

## Configuration & Defaults

- **Registration**: All skills are registered during `initBundledSkills()`, called once at startup
- **Feature flags**: Checked via `feature()` from `bun:bundle` (compile-time flags) and `getFeatureValue_CACHED_MAY_BE_STALE()` (runtime flags)
- **File extraction**: Skills with `files` get their reference docs extracted to `getBundledSkillsRoot()/<skill-name>/` on first invocation, with secure file writing (O_EXCL | O_NOFOLLOW, mode 0o600)
- **Default tool permissions**: Most skills restrict `allowedTools` to read-only tools; `skillify` is the most permissive with Read, Write, Edit, Glob, Grep, AskUserQuestion, and `Bash(mkdir:*)`

## Edge Cases & Caveats

- **Ant-only skills** silently skip registration when `USER_TYPE !== 'ant'`—they don't error, they simply don't appear in the skill list
- **Feature-gated skills use `require()`** instead of static imports to avoid bundling their code when the feature is off; this means TypeScript type checking is weaker for these modules
- **`disableModelInvocation: true`** prevents automatic invocation by the model (used by `debug`, `skillify`, `batch`)—the user must explicitly type the slash command. This keeps expensive or context-heavy skills from being triggered accidentally
- **`isEnabled` is checked at invocation time**, not registration time—so a skill like `loop` can be registered unconditionally but only become visible when `isKairosCronEnabled()` returns true
- **`claudeApiContent.ts` is lazy-loaded** via dynamic `import()` inside `getPromptForCommand` to avoid pulling 247KB of documentation strings into memory at startup
- **`loremIpsum` caps output at 500,000 tokens** for safety (`loremIpsum.ts:260`), using a pre-verified list of single-token English words
- **`scheduleRemoteAgents` cannot delete triggers**—it explicitly directs users to the web UI at `https://claude.ai/code/scheduled` for deletion

## Key Code Snippets

### The registration pattern (every skill follows this):

```typescript
// src/skills/bundled/simplify.ts:55-69
export function registerSimplifySkill(): void {
  registerBundledSkill({
    name: 'simplify',
    description:
      'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = SIMPLIFY_PROMPT
      if (args) {
        prompt += `\n\n## Additional Focus\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
```

### Feature-gated conditional registration:

```typescript
// src/skills/bundled/index.ts:56-63
if (feature('AGENT_TRIGGERS_REMOTE')) {
  const {
    registerScheduleRemoteAgentsSkill,
  } = require('./scheduleRemoteAgents.js')
  registerScheduleRemoteAgentsSkill()
}
```

### Dynamic schema generation in update-config:

```typescript
// src/skills/bundled/updateConfig.ts:10-13
function generateSettingsSchema(): string {
  const jsonSchema = toJSONSchema(SettingsSchema(), { io: 'input' })
  return jsonStringify(jsonSchema, null, 2)
}
```