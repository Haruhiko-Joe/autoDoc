# DevWorkflowCommands

## Overview & Responsibilities

DevWorkflowCommands is a collection of slash commands within the **CommandSystem** module that support developer workflows by generating prompts for code review, issue management, git operations, and project initialization. These commands sit between the TerminalUI (which dispatches slash commands entered by users) and the QueryEngine (which processes the generated prompts). Most commands follow a common pattern: gather context from git/GitHub, assemble a detailed prompt, and inject it into the conversation for Claude to act upon.

Sibling modules in the CommandSystem handle session management, configuration, diagnostics, and authentication. DevWorkflowCommands focuses exclusively on development-lifecycle operations—reviewing code, committing changes, creating PRs, initializing projects, and more.

The commands come in three architectural flavors:
- **`prompt` type**: Generate a text prompt that the QueryEngine processes (e.g., `/commit`, `/review`)
- **`local` type**: Execute logic locally and return a result directly (e.g., `/release-notes`, `/advisor`)
- **`local-jsx` type**: Render a React (Ink) component for interactive UI (e.g., `/diff`, `/btw`, `/feedback`, `/ultrareview`)

Several commands are transitioning to a plugin architecture via `createMovedToPluginCommand()` (defined in `src/commands/createMovedToPluginCommand.ts`), which checks if a marketplace plugin is available before falling back to the built-in prompt implementation.

## Command Inventory

| Command | Type | File | Description |
|---------|------|------|-------------|
| `/review` | prompt | `src/commands/review.ts` | Local PR code review via `gh` CLI |
| `/ultrareview` | local-jsx | `src/commands/review.ts` | Remote cloud-based bug-finding review |
| `/security-review` | prompt | `src/commands/security-review.ts` | Security-focused review of branch changes |
| `/diff` | local-jsx | `src/commands/diff/index.ts` | View uncommitted and per-turn diffs |
| `/commit` | prompt | `src/commands/commit.ts` | Create a git commit from staged changes |
| `/commit-push-pr` | prompt | `src/commands/commit-push-pr.ts` | Commit, push, and open/update a PR |
| `/pr-comments` | prompt | `src/commands/pr_comments/index.ts` | Fetch and format GitHub PR comments |
| `/issue` | stub | `src/commands/issue/index.js` | Disabled stub |
| `/init` | prompt | `src/commands/init.ts` | Initialize CLAUDE.md and project setup |
| `/init-verifiers` | prompt | `src/commands/init-verifiers.ts` | Create verifier skills for automated verification |
| `/release-notes` | local | `src/commands/release-notes/index.ts` | Display version release notes |
| `/autofix-pr` | stub | `src/commands/autofix-pr/index.js` | Disabled stub |
| `/bughunter` | stub | `src/commands/bughunter/index.js` | Disabled stub |
| `/advisor` | local | `src/commands/advisor.ts` | Configure the advisor model |
| `/ultraplan` | local-jsx | `src/commands/ultraplan.tsx` | Multi-agent planning in Claude Code on the web |
| `/btw` | local-jsx | `src/commands/btw/index.ts` | Quick side question without interrupting main conversation |
| `/feedback` | local-jsx | `src/commands/feedback/index.ts` | Submit feedback/bug reports |
| `/good-claude` | stub | `src/commands/good-claude/index.js` | Disabled stub |

## Key Processes

### Code Review Flow (`/review`)

1. User invokes `/review` with an optional PR number
2. `LOCAL_REVIEW_PROMPT()` builds a prompt instructing Claude to use `gh pr list`, `gh pr view`, and `gh pr diff` (`src/commands/review.ts:9-31`)
3. The prompt is injected into the conversation as a `ContentBlockParam[]`
4. Claude executes the `gh` commands via tool calls and produces a structured review

### Ultrareview Flow (`/ultrareview`)

This is the remote, cloud-based review path—distinct from `/review`. It runs a multi-agent bug-hunting session on Claude Code on the web.

1. **Gate check**: `checkOverageGate()` determines billing status (`src/commands/review/reviewRemote.ts:52-113`):
   - Team/Enterprise subscribers proceed freely
   - Consumer plans check free quota via `fetchUltrareviewQuota()`
   - If free reviews exhausted, checks Extra Usage balance and shows `UltrareviewOverageDialog` if confirmation needed
2. **Feature flag**: `isUltrareviewEnabled()` reads the GrowthBook `tengu_review_bughunter_config` flag (`src/commands/review/ultrareviewEnabled.ts:8-14`)
3. **Launch**: `launchRemoteReview()` operates in two modes (`src/commands/review/reviewRemote.ts:128-316`):
   - **PR mode**: Teleports with `refs/pull/N/head` for a specific PR number
   - **Branch mode**: Bundles the working tree and diffs against the merge-base SHA
4. A `RemoteAgentTask` is registered, and findings arrive via task-notification polling

### Security Review Flow (`/security-review`)

1. Assembles a comprehensive security review prompt with embedded shell commands (`src/commands/security-review.ts:6-196`)
2. Shell commands (`git status`, `git diff`, `git log`) are executed inline via `executeShellCommandsInPrompt()` to inject current diff context
3. The prompt instructs Claude to perform a 3-phase analysis: vulnerability identification via sub-task, parallel false-positive filtering, and confidence-based filtering (threshold: 0.8)
4. Includes extensive false-positive filtering rules (17 hard exclusions) and precedent guidance
5. Wrapped via `createMovedToPluginCommand()` for future plugin migration

### Commit Flow (`/commit`)

1. `getPromptContent()` builds a prompt with embedded git context commands (`src/commands/commit.ts:12-55`)
2. Shell commands (`git status`, `git diff HEAD`, `git branch`, `git log`) are pre-executed via `executeShellCommandsInPrompt()`
3. The prompt includes a Git Safety Protocol (never amend, never skip hooks, never commit secrets)
4. Allowed tools are restricted to `git add`, `git status`, and `git commit`
5. Attribution text is appended via `getAttributionTexts()` for co-authorship

### Commit-Push-PR Flow (`/commit-push-pr`)

1. Fetches the default branch and enhanced PR attribution in parallel (`src/commands/commit-push-pr.ts:121-124`)
2. Builds a comprehensive prompt covering: branch creation, commit, push, and PR create/edit
3. Allowed tools include git operations, `gh pr` commands, `ToolSearch`, and Slack MCP tools (`src/commands/commit-push-pr.ts:10-24`)
4. Detects if a PR already exists (via `gh pr view`) and uses `gh pr edit` instead of `gh pr create`
5. Optionally posts to Slack channels if configured in CLAUDE.md
6. Supports an "undercover" mode for Anthropic internal users that strips reviewer args and changelog sections

### Project Initialization Flow (`/init`)

Two prompt variants exist, selected by the `NEW_INIT` feature flag (`src/commands/init.ts:226-254`):

**Old Init**: Creates a CLAUDE.md file by analyzing the codebase—build commands, architecture, code style, and gotchas.

**New Init** (8-phase interactive flow):
1. **Phase 1**: Ask what to set up (project/personal CLAUDE.md, skills, hooks)
2. **Phase 2**: Explore codebase via subagent (manifest files, CI, existing configs)
3. **Phase 3**: Interactive Q&A to fill knowledge gaps, then propose skills/hooks/notes
4. **Phase 4**: Write CLAUDE.md with actionable, non-obvious instructions
5. **Phase 5**: Write CLAUDE.local.md (personal, gitignored) with role and preferences
6. **Phase 6**: Create skill files in `.claude/skills/`
7. **Phase 7**: Suggest optimizations (GitHub CLI, linting, hooks)
8. **Phase 8**: Summary and recommendations (plugins, test frameworks)

### Verifier Initialization Flow (`/init-verifiers`)

Creates verifier skills for automated verification of code changes (`src/commands/init-verifiers.ts`):

1. **Phase 1 — Auto-Detection**: Scans the project for distinct areas (web apps, CLI tools, APIs) and detects frameworks, dev servers, and existing verification tools
2. **Phase 2 — Tool Setup**: Helps install/configure Playwright, Chrome DevTools MCP, or other tools based on project type
3. **Phase 3 — Interactive Q&A**: Confirms verifier names, project-specific config (dev server URLs, auth requirements, test credentials)
4. **Phase 4 — Generate**: Writes `SKILL.md` files to `.claude/skills/<verifier-name>/` with appropriate allowed-tools per type (playwright, CLI/tmux, API/curl)
5. **Phase 5 — Confirm**: Reports what was created and how the Verify agent discovers skills by folder name

### Ultraplan Flow (`/ultraplan`)

A multi-agent planning mode that runs on Claude Code on the web using the Opus model.

1. **Entry**: `launchUltraplan()` serves as shared entry point for slash command, keyword trigger, and plan-approval dialog (`src/commands/ultraplan.tsx:234-293`)
2. **Dedup**: Checks `ultraplanSessionUrl` and `ultraplanLaunching` to prevent concurrent sessions
3. **Eligibility**: Calls `checkRemoteAgentEligibility()` for remote session access
4. **Teleport**: Creates a remote session via `teleportToRemote()` with the assembled prompt
5. **Poll**: `startDetachedPoll()` runs a 30-minute polling loop via `pollForApprovedExitPlanMode()` (`src/commands/ultraplan.tsx:74-181`)
6. **Resolution**: Two outcomes:
   - **Remote execution**: User approved execution in the web—plan runs there and produces a PR
   - **Teleport back**: Plan is sent back to the local session via `ultraplanPendingChoice` state

### Side Question Flow (`/btw`)

1. User invokes `/btw <question>` to ask a quick question without disrupting the main conversation
2. The `BtwSideQuestion` component renders a scrollable dialog (`src/commands/btw/btw.tsx:36`)
3. Under the hood, `runSideQuestion()` sends the question to Claude with system context but outside the main conversation turn
4. User can dismiss with Escape/Enter and scroll with arrow keys
5. Marked as `immediate: true`, meaning it executes without a progress spinner

### PR Comments Flow (`/pr-comments`)

1. Uses the GitHub API via `gh` to fetch both PR-level comments and code review comments (`src/commands/pr_comments/index.ts:9-49`)
2. For review comments with code references, fetches the actual file content via `gh api /repos/{owner}/{repo}/contents/{path}`
3. Formats output with author, file path, line numbers, diff hunks, and threaded replies
4. Wrapped via `createMovedToPluginCommand()` for future plugin migration

### Advisor Configuration (`/advisor`)

A local command that configures which model serves as an "advisor" during sessions (`src/commands/advisor.ts:16-94`):

1. With no arguments: displays current advisor status
2. With `unset`/`off`: disables the advisor and clears the setting
3. With a model name: validates the model via `validateModel()`, checks `isValidAdvisorModel()`, and persists to user settings via `updateSettingsForSource()`
4. Only visible when `canUserConfigureAdvisor()` returns true

### Release Notes (`/release-notes`)

A local command that fetches and displays changelog entries (`src/commands/release-notes/release-notes.ts:19-50`):

1. Races a fresh fetch (`fetchAndStoreChangelog()`) against a 500ms timeout
2. Falls back to cached changelog if the fetch times out or fails
3. Formats each version's notes as bullet points
4. If nothing is available, shows a link to the full changelog URL

### Feedback (`/feedback`)

An interactive JSX command for submitting bug reports and feedback (`src/commands/feedback/index.ts`):

1. Gated by multiple conditions: not available on Bedrock/Vertex/Foundry, not for Anthropic internal users, requires `allow_product_feedback` policy
2. Renders the `Feedback` component with current conversation messages and optional initial description from args
3. Also aliased as `/bug`

## Function Signatures

### `launchUltraplan(opts): Promise<string>`

Shared entry point for ultraplan sessions.

- **opts.blurb** (`string`): User's planning prompt
- **opts.seedPlan** (`string`, optional): Draft plan from the plan-approval dialog
- **opts.getAppState / setAppState**: State accessors for dedup and URL tracking
- **opts.signal** (`AbortSignal`): Cancellation signal
- **opts.onSessionReady** (`(msg: string) => void`, optional): Callback when the remote session URL is available
- Returns the user-facing launch message immediately; actual work is detached

> Source: `src/commands/ultraplan.tsx:234-293`

### `stopUltraplan(taskId, sessionId, setAppState): Promise<void>`

Stops a running ultraplan session, archives the remote session, and clears all related app state.

> Source: `src/commands/ultraplan.tsx:203-223`

### `checkOverageGate(): Promise<OverageGate>`

Determines billing eligibility for ultrareview. Returns one of: `proceed`, `not-enabled`, `low-balance`, or `needs-confirm`.

> Source: `src/commands/review/reviewRemote.ts:52-113`

### `launchRemoteReview(args, context, billingNote?): Promise<ContentBlockParam[] | null>`

Launches a teleported review session. Operates in PR mode (specific PR number) or branch mode (bundle working tree). Returns content blocks for the conversation or `null` on failure.

> Source: `src/commands/review/reviewRemote.ts:128-316`

### `buildUltraplanPrompt(blurb, seedPlan?): string`

Assembles the initial CCR user message by combining instructions, optional seed plan, and user blurb.

> Source: `src/commands/ultraplan.tsx:63-73`

### `isUltrareviewEnabled(): boolean`

Runtime gate for `/ultrareview`. Reads the GrowthBook `tengu_review_bughunter_config` feature flag's `enabled` field.

> Source: `src/commands/review/ultrareviewEnabled.ts:8-14`

## Type Definitions

### `OverageGate`

Discriminated union controlling ultrareview billing flow:

```typescript
type OverageGate =
  | { kind: 'proceed'; billingNote: string }
  | { kind: 'not-enabled' }
  | { kind: 'low-balance'; available: number }
  | { kind: 'needs-confirm' }
```

> Source: `src/commands/review/reviewRemote.ts:42-46`

## Configuration & Defaults

### Ultrareview

- **Feature flag**: `tengu_review_bughunter_config` (GrowthBook) — controls both visibility and fleet configuration
- **Fleet defaults**: 5 agents, 10min max duration, 600s agent timeout, 22min total wallclock
- **Upper bounds**: 20 fleet size, 25min max duration, 1800s agent timeout, 27min wallclock
- **Minimum balance**: $10 for Extra Usage billing
- **Environment ID**: `env_011111111111111111111113` (synthetic code review environment)

### Ultraplan

- **Timeout**: 30 minutes (`ULTRAPLAN_TIMEOUT_MS`) defined in `src/commands/ultraplan.tsx:24`
- **Model**: Determined at runtime via `tengu_ultraplan_model` GrowthBook flag, defaults to Opus 4.6
- **Prompt override**: `ULTRAPLAN_PROMPT_FILE` env var (Anthropic-internal builds only)

### Commit Commands

- `/commit` allowed tools: `git add`, `git status`, `git commit` (`src/commands/commit.ts:6-10`)
- `/commit-push-pr` allowed tools: additionally includes `git push`, `gh pr create/edit/view/merge`, `ToolSearch`, and Slack MCP tools (`src/commands/commit-push-pr.ts:10-24`)

### Feedback Command

Disabled when: using Bedrock/Vertex/Foundry backends, `DISABLE_FEEDBACK_COMMAND` is set, essential-traffic-only privacy mode, Anthropic internal users, or policy disallows `allow_product_feedback` (`src/commands/feedback/index.ts:12-22`).

### Advisor Command

Only visible when `canUserConfigureAdvisor()` returns true. Supports `unset`/`off` to disable and any valid model string to set. Persists to user settings via `updateSettingsForSource('userSettings', ...)` (`src/commands/advisor.ts:81`).

## Edge Cases & Caveats

- **Stub commands**: `/issue`, `/autofix-pr`, `/bughunter`, and `/good-claude` are disabled stubs (`isEnabled: () => false, isHidden: true`). They exist as placeholders in `src/commands/issue/index.js`, `src/commands/autofix-pr/index.js`, `src/commands/bughunter/index.js`, and `src/commands/good-claude/index.js`.
- **Undercover mode**: `/commit` and `/commit-push-pr` detect Anthropic internal users in "undercover" mode and strip reviewer arguments, changelog sections, and Slack integration from the generated prompts.
- **Ultrareview branch mode bundle size**: If the repo is too large to bundle, the teleport fails and returns a message suggesting the user push a PR and use `/ultrareview <PR#>` instead (`src/commands/review/reviewRemote.ts:281-288`).
- **Merge-base resolution**: The ultrareview branch mode passes the merge-base SHA (not branch name) to the remote container because `git remote remove origin` in the container's env-manager deletes named refs (`src/commands/review/reviewRemote.ts:235-240`).
- **Session dedup**: Ultraplan prevents concurrent sessions via `ultraplanSessionUrl` and `ultraplanLaunching` state flags. The launching flag is set synchronously before the async detach to close the race window (`src/commands/ultraplan.tsx:280-283`).
- **Overage confirmation persistence**: The ultrareview overage dialog confirmation is session-scoped (`sessionOverageConfirmed` module variable in `src/commands/review/reviewRemote.ts:36`). Only set after a non-aborted launch to prevent Escape-during-launch from skipping future confirmations.
- **Release notes timeout**: `/release-notes` races a 500ms fetch against the stored changelog cache, falling back to cached data on timeout (`src/commands/release-notes/release-notes.ts:24-28`).
- **New Init feature gate**: The enhanced 8-phase `/init` flow is behind the `NEW_INIT` bundler feature flag, available to Anthropic internal users or when `CLAUDE_CODE_NEW_INIT` env var is set (`src/commands/init.ts:230-232`).
- **Empty diff guard**: Ultrareview branch mode bails early on empty diffs (no changes against the fork point) instead of launching a container that would just echo "no changes" (`src/commands/review/reviewRemote.ts:255-268`).