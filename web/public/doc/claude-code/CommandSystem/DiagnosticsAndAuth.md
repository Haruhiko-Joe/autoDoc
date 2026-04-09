# Diagnostics & Authentication Commands

## Overview & Responsibilities

The DiagnosticsAndAuth module is a collection of slash commands within the **CommandSystem** that provide system diagnostics, usage information, and authentication management for Claude Code. These commands sit alongside other command groups (session management, configuration, development workflows) in the command registry and are dispatched by the **TerminalUI** when a user types a `/command`.

The module divides into two functional areas:

- **Diagnostics**: Health checks, usage tracking, performance debugging, data export, and a large analytics engine (`/insights`)
- **Authentication**: OAuth login/logout flows, subscription management, and plan upgrades

Most commands follow a consistent pattern: a small `index.ts` that defines the command metadata (name, description, visibility, availability) and lazy-loads the implementation module. Several internal-only or deprecated commands are replaced by disabled stubs.

---

## Command Architecture

Every command exports a `Command` object (satisfying a shared `Command` type) with these key fields:

| Field | Purpose |
|-------|---------|
| `name` | Slash command name (e.g., `'doctor'`) |
| `description` | Help text shown in `/help` |
| `type` | `'local'` (returns text) or `'local-jsx'` (returns React component) |
| `isEnabled` | Predicate controlling whether the command is available |
| `isHidden` | Whether to hide from help listings |
| `availability` | Platform restriction (e.g., `['claude-ai']`) |
| `supportsNonInteractive` | Whether the command works in non-interactive/headless mode |
| `load` | Lazy import of the implementation module |

Commands that return React elements (`local-jsx`) render into the Ink-based terminal UI. Commands that return text (`local`) produce a plain text result object.

---

## Key Processes

### Command Registration and Dispatch Flow

1. Each command directory contains an `index.ts` (or `index.js` for stubs) exporting a `Command` object
2. The command registry collects all command definitions at startup — but **does not** load implementations
3. When a user types `/doctor`, the TerminalUI matches the name, calls `command.load()` to dynamically import the implementation, then invokes the `call` function
4. `local-jsx` commands return a React element rendered by Ink; `local` commands return a `{ type: 'text', text: string }` result

### Login → Cache Invalidation Flow

1. User invokes `/login`, rendering the `ConsoleOAuthFlow` component inside a `Dialog` (`src/commands/login/login.tsx`)
2. On successful OAuth completion, the `call` function triggers a cascade of side effects:
   - Resets cost state for the new session
   - Refreshes remotely managed settings and policy limits
   - Resets user cache and updates GrowthBook feature flags
   - Enrolls the device as trusted
   - Checks permission killswitches
   - Increments `authVersion` to signal state change
3. If the API key changed, strips signature blocks from existing messages

### Logout → Secure Cleanup Flow

1. User invokes `/logout`, calling `performLogout()` (`src/commands/logout/logout.tsx`)
2. Telemetry is flushed **before** credentials are cleared (prevents org data leakage into post-logout events)
3. API key is removed and all secure storage data is deleted
4. `clearAuthRelatedCaches()` invalidates: OAuth token cache, trusted device token cache, betas cache, tool schema cache, user cache, GrowthBook state, Grove config, remotely managed settings, and policy limits
5. Global config is saved with cleared onboarding state, subscription notice, and OAuth account

### Insights Analytics Pipeline

1. **Scan** (`scanAllSessions()`): Reads session logs from `~/.claude/projects/*/`; optionally collects from remote Coder workspaces via SSH (`--homespaces`)
2. **Extract metadata** (`logToSessionMeta()`): Per-session tool usage, message counts, timestamps, git stats, tokens — cached to `~/.claude/insights/session_meta/`
3. **Extract facets** (`extractFacetsFromAPI()`): Calls Claude API to classify each session by goal, outcome, satisfaction, friction — cached to `~/.claude/insights/facets/`
4. **Detect multi-clauding** (`detectMultiClauding()`): Identifies overlapping user message timestamps across sessions
5. **Aggregate** (`aggregateData()`): Combines all metadata/facets into per-language, per-tool, and category breakdowns
6. **Generate insights** (`generateParallelInsights()`): Parallel Claude API calls producing narrative insights across 5 sections
7. **Render report** (`generateHtmlReport()`): Self-contained HTML with charts, tables, and facet summaries

---

## Diagnostics Commands

### `/doctor` — Installation Health Check

Renders the `Doctor` screen component, which verifies the Claude Code installation and settings are correctly configured.

> Source: `src/commands/doctor/index.ts`, `src/commands/doctor/doctor.tsx`

- **Type**: `local-jsx` — renders the Doctor screen
- **Visibility**: Can be disabled via `DISABLE_DOCTOR_COMMAND` environment variable

### `/status` — System Status

Opens the Settings panel with the "Status" tab selected, showing version, model, account info, API connectivity, and tool statuses.

> Source: `src/commands/status/index.ts`, `src/commands/status/status.tsx`

- **Type**: `local-jsx` — renders `Settings` component with `defaultTab="Status"`

### `/cost` — Session Cost Tracking

Displays the total API cost and duration of the current session.

> Source: `src/commands/cost/index.ts`, `src/commands/cost/cost.ts`

**Key Logic** (`src/commands/cost/cost.ts:1-24`):
1. Checks if the user is a Claude AI subscriber via `isClaudeAISubscriber()`
2. For subscribers: returns a message about subscription or overage usage
3. For non-subscribers: returns formatted cost via `formatTotalCost()`
4. Internal users (`USER_TYPE='ant'`) always see the full cost breakdown

The command is hidden from Claude AI subscribers (unless `USER_TYPE='ant'`) since cost tracking is not meaningful under a subscription model.

### `/stats` — Usage Statistics

Renders the `Stats` component showing Claude Code usage statistics and activity.

> Source: `src/commands/stats/index.ts`, `src/commands/stats/stats.tsx`

### `/usage` — Plan Usage Limits

Opens the Settings panel with the "Usage" tab, showing plan usage limits.

> Source: `src/commands/usage/index.ts`, `src/commands/usage/usage.tsx`

- **Availability**: Claude AI platform only (`availability: ['claude-ai']`)

### `/help` — Help Display

Renders the `HelpV2` component with a list of all available commands.

> Source: `src/commands/help/index.ts`, `src/commands/help/help.tsx`

**Key Logic** (`src/commands/help/help.tsx:1-10`): Extracts the commands list from `context.options` and passes it to the `HelpV2` component.

### `/version` — Version Info (Internal)

Returns the current version and build timestamp.

> Source: `src/commands/version.ts`

- **Availability**: Internal only (`USER_TYPE='ant'`)
- **Supports non-interactive mode**: Yes
- Uses `MACRO` constants injected at build time for version and build timestamp

### `/insights` — Analytics & Usage Reporting

The largest command in the module at ~3,200 lines — a comprehensive analytics engine that scans session history, extracts structured facets via the Claude API, aggregates statistics, and generates an interactive HTML report.

> Source: `src/commands/insights.ts`

#### Key Types

| Type | Purpose |
|------|---------|
| `SessionMeta` | Per-session metadata: duration, message counts, tool stats, git commits, tokens |
| `SessionFacets` | AI-extracted facets: goal, outcome, satisfaction, friction, success indicators |
| `AggregatedData` | Cross-session aggregated statistics |
| `InsightSection` | Named insight categories (what's working, what's hindering, quick wins, etc.) |
| `InsightResults` | Generated narrative insights with backing data |
| `InsightsExport` | Shareable export data structure |

#### Key Exports

- `generateUsageReport(options?)` — Main entry point, orchestrates the full pipeline
- `deduplicateSessionBranches(sessions)` — Removes duplicate entries from multi-clauding sessions
- `detectMultiClauding(sessionMetas)` — Detects concurrent session usage
- `buildExportData(insights, options)` — Builds JSON export structure

#### Data Directories

| Path | Purpose |
|------|---------|
| `~/.claude/insights/` | Root data directory |
| `~/.claude/insights/facets/` | Cached per-session AI-extracted facets |
| `~/.claude/insights/session_meta/` | Cached per-session metadata |
| `~/.claude/insights/remote/` | Data collected from remote Coder workspaces |

### `/export` — Conversation Export

Exports the current conversation to a Markdown file or the clipboard.

> Source: `src/commands/export/index.ts`, `src/commands/export/export.tsx`

**Key Logic** (`src/commands/export/export.tsx:1-90`):
1. Renders the conversation using `exportRenderer` to produce plain text
2. Generates a default filename from the first user message (truncated to 50 chars, sanitized) or a timestamp
3. If called with an argument, writes directly to that file; otherwise shows an `ExportDialog`

**Helper Functions**:
- `extractFirstPrompt(messages)` — Extracts first user text block, limited to 50 characters
- `sanitizeFilename(text)` — Removes special characters, replaces spaces with hyphens
- `formatTimestamp(date)` — Formats as `YYYY-MM-DD-HHmmss`
- `exportWithReactRenderer(context)` — Renders messages to plain text via React renderer

### `/heapdump` — Heap Dump (Hidden)

Creates a V8 heap snapshot and writes it to `~/Desktop`.

> Source: `src/commands/heapdump/index.ts`, `src/commands/heapdump/heapdump.ts`

- **Hidden**: Yes — developer debugging tool
- Returns the `heapPath` and `diagPath` on success, or an error message on failure
- Delegates to `performHeapDump()` from the heap dump service

### `/stickers` — Sticker Rewards

Opens the browser to the Claude Code sticker ordering page.

> Source: `src/commands/stickers/index.ts`, `src/commands/stickers/stickers.ts`

- Opens the sticker ordering page in the default browser
- Falls back to displaying the URL if the browser fails to open

### Stub Commands (Disabled)

Several commands exist as disabled stubs — they export `{ isEnabled: () => false, isHidden: true, name: 'stub' }`. These are either internal-only features stripped from the public build, deprecated, or not yet implemented:

| Command | Directory |
|---------|-----------|
| `/ctx_viz` | `src/commands/ctx_viz/index.js` |
| `/perf-issue` | `src/commands/perf-issue/index.js` |
| `/ant-trace` | `src/commands/ant-trace/index.js` |
| `/debug-tool-call` | `src/commands/debug-tool-call/index.js` |
| `/mock-limits` | `src/commands/mock-limits/index.js` |
| `/backfill-sessions` | `src/commands/backfill-sessions/index.js` |
| `/break-cache` | `src/commands/break-cache/index.js` |

---

## Authentication Commands

### `/login` — OAuth Login

Renders the `Login` component, which wraps `ConsoleOAuthFlow` inside a `Dialog`.

> Source: `src/commands/login/index.ts`, `src/commands/login/login.tsx`

- **Visibility**: Can be disabled via `DISABLE_LOGIN_COMMAND` environment variable
- **Description**: Dynamic — changes based on whether an Anthropic API key is already configured (`hasAnthropicApiKeyAuth()`)

**Post-login side effects** (performed by the `call` function after successful authentication):
1. Resets cost state
2. Refreshes remotely managed settings
3. Refreshes policy limits
4. Resets user cache
5. Updates GrowthBook (feature flags)
6. Enrolls trusted device
7. Checks permission killswitches
8. Increments `authVersion`
9. Strips signature blocks from messages

### `/logout` — Sign Out

Performs a complete sign-out, wiping all authentication state.

> Source: `src/commands/logout/index.ts`, `src/commands/logout/logout.tsx`

- **Visibility**: Can be disabled via `DISABLE_LOGOUT_COMMAND` environment variable

**Key Functions**:

- **`performLogout(options)`**: Orchestrates the full logout — flushes telemetry before clearing credentials, removes the API key, deletes secure storage, clears caches, and saves updated global config.

- **`clearAuthRelatedCaches()`**: Invalidates all memoized auth-dependent data — OAuth token cache, trusted device token cache, betas cache, tool schema cache, user cache, GrowthBook state, Grove config cache, remotely managed settings cache, and policy limits cache.

### `/oauth-refresh` — Token Refresh (Stub)

Disabled stub. OAuth token refresh is handled internally by the auth infrastructure, not as a user-facing command.

> Source: `src/commands/oauth-refresh/index.js`

### `/passes` — Referral Passes

Displays referral/guest pass information for eligible users.

> Source: `src/commands/passes/index.ts`, `src/commands/passes/passes.tsx`

- **Visibility**: Hidden if user is not eligible (`getCachedPassesEligibility()`) or no cached referrer reward data exists
- **Description**: Dynamic, based on `getCachedReferrerReward()`
- Tracks first visit via `hasVisitedPasses` config flag
- Logs `'tengu_guest_passes_visited'` analytics event
- Renders the `Passes` component

### `/extra-usage` — Extra Usage Management

Allows users to request or enable additional API usage beyond their plan limits.

> Source: `src/commands/extra-usage/index.ts`, `src/commands/extra-usage/extra-usage-core.ts`, `src/commands/extra-usage/extra-usage.tsx`, `src/commands/extra-usage/extra-usage-noninteractive.ts`

This command has **two variants**: interactive (renders JSX) and non-interactive (returns text), both sharing core logic in `extra-usage-core.ts`.

**Core Logic** (`src/commands/extra-usage/extra-usage-core.ts:1-119`):

The `runExtraUsage()` function returns an `ExtraUsageResult` union:
- `{ type: 'message', value: string }` — plain text response
- `{ type: 'browser-opened', url: string, opened: boolean }` — URL opened in browser

Flow:
1. Tracks first visit via global config
2. Invalidates overage credit grant cache
3. **For team/enterprise users without billing access**: checks overage status, looks for existing admin requests, creates a new one if needed
4. **For personal accounts or users with billing access**: opens the browser to the usage settings page

**Availability**: Only shown when overage provisioning is allowed and the `DISABLE_EXTRA_USAGE_COMMAND` env var is not set.

### `/reset-limits` — Limit Resets (Stub)

Disabled stub. Exports both `resetLimits` and `resetLimitsNonInteractive` variants, all as disabled stubs.

> Source: `src/commands/reset-limits/index.js`

### `/upgrade` — Plan Upgrade

Helps users upgrade to the Max subscription plan for higher rate limits.

> Source: `src/commands/upgrade/index.ts`, `src/commands/upgrade/upgrade.tsx`

- **Availability**: Claude AI platform only, not available for enterprise subscribers

**Key Logic** (`src/commands/upgrade/upgrade.tsx:1-37`):
1. Checks if the user is already on the highest Max plan (20x tier) by inspecting tokens and subscription metadata
2. If already at max tier: suggests running `/login` to switch to an API usage-billed account
3. Otherwise: opens the browser to the upgrade page
4. Renders the `Login` component for post-upgrade re-authentication
5. On error: falls back to displaying the upgrade URL

---

## Edge Cases & Caveats

- **Lazy loading**: All command implementations are lazy-loaded via dynamic `import()` in the `load` field. This keeps startup fast — the 3,200-line insights module is only loaded when `/insights` is actually invoked.
- **Stub commands**: Seven commands are disabled stubs (single-line JS files). These placeholders exist so the command registry doesn't break when referencing them, but they contribute no functionality in the public build.
- **Platform-specific visibility**: `/usage` and `/upgrade` are restricted to the `claude-ai` platform. `/cost` is hidden for Claude AI subscribers. `/version` is internal-only (`USER_TYPE='ant'`).
- **Environment variable gates**: Several commands can be disabled via environment variables (`DISABLE_DOCTOR_COMMAND`, `DISABLE_LOGIN_COMMAND`, `DISABLE_LOGOUT_COMMAND`, `DISABLE_EXTRA_USAGE_COMMAND`), providing operational control without code changes.
- **Logout ordering**: `performLogout()` deliberately flushes telemetry *before* clearing credentials to prevent organization data from leaking into post-logout telemetry events.
- **Post-login cache invalidation**: The login flow invalidates a wide range of cached state (feature flags, policy limits, user data, managed settings) to ensure the session reflects the newly authenticated user's permissions and configuration.
- **Insights API dependency**: The `/insights` command makes multiple calls to the Claude API (for facet extraction and insight generation). It caches results aggressively to avoid re-processing, but the initial run for a large session history can be slow and token-intensive.
- **Dual-mode commands**: `/extra-usage` ships two command registrations (interactive and non-interactive) sharing the same core logic, ensuring the command works both in the REPL and in headless/CI contexts.