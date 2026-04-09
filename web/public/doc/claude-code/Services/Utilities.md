# Utilities

## Overview & Responsibilities

The Utilities module is a collection of miscellaneous standalone services within the **Services** layer. These utilities share no direct dependency on each other — each addresses a distinct operational concern:

| Utility | File | Purpose |
|---------|------|---------|
| Token Estimation | `src/services/tokenEstimation.ts` | Fast approximate token counting without (or with) API calls |
| Diagnostic Tracking | `src/services/diagnosticTracking.ts` | Tracks IDE diagnostics (errors/warnings) across file edits |
| Notifier | `src/services/notifier.ts` | Sends desktop notifications via terminal-specific protocols |
| Prevent Sleep | `src/services/preventSleep.ts` | Keeps macOS awake during long operations using `caffeinate` |
| VCR | `src/services/vcr.ts` | Records and replays API responses for deterministic testing |
| Internal Logging | `src/services/internalLogging.ts` | Logs permission context and container metadata (Anthropic-internal) |

These services are consumed by the QueryEngine, ToolSystem, and TerminalUI modules to support token budgeting, debugging, user experience, testing, and internal observability.

---

## Key Processes

### Token Estimation: Counting Strategy Selection

The system uses a tiered approach for token counting, falling back from precise to approximate:

1. **API-based exact count** — `countMessagesTokensWithAPI()` calls the Anthropic `countTokens` endpoint (or Bedrock's `CountTokensCommand` for AWS users). Returns `null` on failure.
2. **Haiku fallback count** — `countTokensViaHaikuFallback()` sends a minimal `messages.create` request to a cheap model and reads `input_tokens` from usage.
3. **Heuristic estimate** — `roughTokenCountEstimation()` divides character length by a bytes-per-token ratio (4 for text, 2 for JSON).

### Diagnostic Tracking: Before/After Diffing

1. `handleQueryStart(clients)` initializes or resets the tracker at the start of each query (`src/services/diagnosticTracking.ts:330-343`)
2. `beforeFileEdited(filePath)` captures baseline diagnostics from the IDE via MCP RPC (`src/services/diagnosticTracking.ts:135-182`)
3. After edits, `getNewDiagnostics()` fetches current diagnostics and diffs against the baseline, returning only newly introduced issues (`src/services/diagnosticTracking.ts:188-283`)
4. `formatDiagnosticsSummary()` renders results as a human-readable string with severity symbols, line numbers, and source info (`src/services/diagnosticTracking.ts:352-380`)

### VCR: Record/Replay Cycle

1. `shouldUseVCR()` checks if VCR mode is active (`NODE_ENV=test` or `FORCE_VCR` for internal users) (`src/services/vcr.ts:23-33`)
2. Input messages are **dehydrated** — dynamic values (CWD, config paths, UUIDs, timestamps) are replaced with stable placeholders
3. A SHA-1 hash of the dehydrated input determines the fixture filename
4. On cache hit, the fixture is read and **hydrated** back; on miss, the real API is called and the result is recorded
5. In CI without `VCR_RECORD=1`, a missing fixture throws an error

### Notification Dispatch

1. `sendNotification()` executes configured notification hooks, then dispatches to the user's preferred channel (`src/services/notifier.ts:18-36`)
2. The `auto` channel auto-detects the terminal (iTerm2, Kitty, Ghostty, Apple Terminal) and picks the appropriate protocol (`src/services/notifier.ts:77-104`)
3. An analytics event records which notification method was actually used

### Prevent Sleep: Reference-Counted Caffeinate

1. `startPreventSleep()` increments a ref counter; at count 1, spawns `caffeinate -i -t 300` (`src/services/preventSleep.ts:36-43`)
2. A restart interval re-spawns `caffeinate` every 4 minutes before its 5-minute timeout expires (`src/services/preventSleep.ts:81-88`)
3. `stopPreventSleep()` decrements; at count 0, kills the process (`src/services/preventSleep.ts:49-58`)
4. `forceStopPreventSleep()` is registered as a cleanup handler for process exit (`src/services/preventSleep.ts:64-68`)

---

## Token Estimation

### Rough (Heuristic) Estimation

The simplest approach divides character count by a bytes-per-token ratio:

```ts
// src/services/tokenEstimation.ts:203-208
export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}
```

The default ratio of 4 bytes/token works for most text. JSON files use a ratio of 2 because of their high density of single-character tokens (`{`, `}`, `:`, `,`). This is handled by `bytesPerTokenForFileType()` (`src/services/tokenEstimation.ts:215-224`).

For structured messages, `roughTokenCountEstimationForMessages()` (`src/services/tokenEstimation.ts:327-339`) walks the message array and dispatches per-block:

- **Text blocks**: character-length heuristic
- **Image/document blocks**: fixed 2000 tokens (matches microCompact's constant)
- **Tool use blocks**: serializes the tool name + input JSON
- **Thinking/redacted thinking blocks**: character-length of thinking content
- **Other blocks** (server_tool_use, web_search_tool_result, etc.): serialized JSON length

### API-Based Counting

`countMessagesTokensWithAPI()` (`src/services/tokenEstimation.ts:140-201`) calls the Anthropic `countTokens` endpoint for an exact count. It:

1. Determines the current model and its betas via `getMainLoopModel()` and `getModelBetas()`
2. Routes Bedrock users to `countTokensWithBedrock()` (`src/services/tokenEstimation.ts:437-495`), which uses the AWS SDK `CountTokensCommand` directly since the Bedrock SDK wrapper doesn't support `countTokens`
3. For Anthropic/Vertex, calls `anthropic.beta.messages.countTokens()`
4. Enables thinking parameters if the messages contain thinking blocks (detected by `hasThinkingBlocks()` at `src/services/tokenEstimation.ts:38-56`)
5. Returns `null` on any failure, allowing callers to fall back to heuristics

The Bedrock path dynamically imports `@aws-sdk/client-bedrock-runtime` to defer ~279KB of AWS SDK code until actually needed.

### Haiku Fallback Counting

`countTokensViaHaikuFallback()` (`src/services/tokenEstimation.ts:251-325`) sends a minimal `messages.create` request to a smaller model and reads back `input_tokens` from usage. Model selection:

- **Vertex global region** or **Bedrock/Vertex with thinking blocks**: uses `getDefaultSonnetModel()` (Haiku unavailable or lacks thinking support)
- **Otherwise**: uses `getSmallFastModel()` (typically Haiku 4.5)

Before sending, `stripToolSearchFieldsFromMessages()` (`src/services/tokenEstimation.ts:66-122`) strips tool-search-specific fields (`caller` on tool_use blocks, `tool_reference` blocks in tool_result content) to avoid API errors when the tool-search beta isn't active.

### Function Signatures

| Function | Description |
|----------|-------------|
| `roughTokenCountEstimation(content, bytesPerToken?)` | Char-length / ratio heuristic |
| `bytesPerTokenForFileType(ext)` | Returns 2 for JSON variants, 4 otherwise |
| `roughTokenCountEstimationForFileType(content, ext)` | Combines the two above |
| `roughTokenCountEstimationForMessages(messages)` | Heuristic for an array of conversation messages |
| `countTokensWithAPI(content)` | Exact count via API for a single string |
| `countMessagesTokensWithAPI(messages, tools)` | Exact count via API for messages + tools |
| `countTokensViaHaikuFallback(messages, tools)` | Fallback: sends a Haiku/Sonnet request and reads usage |

---

## Diagnostic Tracking

### Architecture

`DiagnosticTrackingService` is a **singleton** (`src/services/diagnosticTracking.ts:30`) that communicates with the IDE via MCP RPC calls (`callIdeRpc` from `src/services/mcp/client.ts`). It must be initialized with a connected IDE MCP client before use.

### Type Definitions

```ts
// src/services/diagnosticTracking.ts:14-28
interface Diagnostic {
  message: string
  severity: 'Error' | 'Warning' | 'Info' | 'Hint'
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}
```

### Key Methods

- **`handleQueryStart(clients)`** (`src/services/diagnosticTracking.ts:330-343`): Initializes on first call by finding the IDE client via `getConnectedIdeClient()`; resets on subsequent calls
- **`beforeFileEdited(filePath)`** (`src/services/diagnosticTracking.ts:135-182`): Captures baseline diagnostics for a file before editing
- **`getNewDiagnostics()`** (`src/services/diagnosticTracking.ts:188-283`): Diffs current diagnostics against baselines, returns only new issues
- **`formatDiagnosticsSummary(files)`** (`src/services/diagnosticTracking.ts:352-380`): Static formatter — renders diagnostics with severity symbols, line numbers, and codes; truncates at 4000 chars
- **`ensureFileOpened(fileUri)`** (`src/services/diagnosticTracking.ts:103-129`): Opens a file in the IDE so language services activate

### Edge Cases

- Path normalization via `normalizePathForComparison()` (from `src/utils/file.ts`) handles Windows case-insensitivity and protocol prefixes (`file://`, `_claude_fs_right:`, `_claude_fs_left:`)
- If the IDE doesn't support diagnostics, failures are silently caught
- `_claude_fs_right:` diagnostics are preferred over `file://` when they change, to capture diagnostics from the IDE's diff view

---

## Notifier

### Supported Channels

| Channel | Behavior |
|---------|----------|
| `auto` | Auto-detects terminal and picks the best method |
| `iterm2` | Uses iTerm2's proprietary notification escape sequence |
| `iterm2_with_bell` | iTerm2 notification + terminal bell |
| `kitty` | Kitty terminal notification with a random numeric ID |
| `ghostty` | Ghostty terminal notification |
| `terminal_bell` | Simple BEL character |
| `notifications_disabled` | No-op |

### Configuration

The preferred channel is read from `getGlobalConfig().preferredNotifChannel` (via `src/utils/config.ts`). The `NotificationOptions` type (`src/services/notifier.ts:12-16`) requires a `message` and `notificationType`, with an optional `title` (defaults to `"Claude Code"`).

### Apple Terminal Bell Detection

For Apple Terminal in `auto` mode, the notifier checks whether the current terminal profile has bell enabled (`src/services/notifier.ts:110-156`). It uses `osascript` to get the current profile name, then reads the Terminal.app preferences via `defaults export` and parses the plist. The `plist` module (~280KB) is lazy-loaded since this code path is rare.

---

## Prevent Sleep

### Design: Reference Counting + Self-Healing

The module uses a **reference counter** (`src/services/preventSleep.ts:29`):

- `startPreventSleep()`: increments `refCount`; spawns `caffeinate` when going from 0 → 1
- `stopPreventSleep()`: decrements `refCount`; kills `caffeinate` when reaching 0
- `forceStopPreventSleep()`: resets count and kills immediately (used for cleanup on exit)

**Self-healing**: `caffeinate` is spawned with a 5-minute timeout (`-t 300`). A restart interval re-spawns it every 4 minutes (`src/services/preventSleep.ts:81-88`). If the Node process is killed with SIGKILL (no cleanup handlers run), the orphaned `caffeinate` process will automatically exit after the timeout.

```ts
// src/services/preventSleep.ts:125-131
caffeinateProcess = spawn(
  'caffeinate',
  ['-i', '-t', String(CAFFEINATE_TIMEOUT_SECONDS)],
  { stdio: 'ignore' },
)
```

The `-i` flag creates an idle-sleep assertion only — the display can still sleep. Both the `caffeinate` process and the restart interval are `unref()`'d so they don't prevent Node from exiting. A cleanup handler is registered via `registerCleanup()` (from `src/utils/cleanupRegistry.ts`) on first use.

### Platform

Only runs on macOS (`process.platform === 'darwin'`). All functions are no-ops on other platforms.

---

## VCR (Video Cassette Recorder)

### When Active

`shouldUseVCR()` (`src/services/vcr.ts:23-33`) returns true when:
- `NODE_ENV === 'test'`, OR
- `USER_TYPE === 'ant'` and `FORCE_VCR` is truthy

### Core Functions

#### `withVCR(messages, f)` — Full Message Recording

(`src/services/vcr.ts:88-161`)

1. Normalizes messages for the API via `normalizeMessagesForAPI()` and filters out meta user messages
2. **Dehydrates** content via `dehydrateValue()` (`src/services/vcr.ts:291-336`): replaces dynamic values with stable placeholders
3. Hashes the dehydrated input to generate a deterministic fixture filename under `fixtures/`
4. On **cache hit**: reads the fixture, **hydrates** values back via `hydrateValue()` (`src/services/vcr.ts:338-347`), adds cached costs to session tracker via `addCachedCostToTotalSessionCost()`
5. On **cache miss in CI** (without `VCR_RECORD=1`): throws an error prompting the developer to record fixtures
6. On **cache miss locally**: executes the real function, dehydrates output, writes the fixture

#### `withStreamingVCR(messages, f)` — Streaming Variant

(`src/services/vcr.ts:349-380`) Wraps an `AsyncGenerator`. In VCR mode, buffers all events through `withVCR`, then yields cached results.

#### `withTokenCountVCR(messages, tools, f)` — Token Count Recording

(`src/services/vcr.ts:382-406`) Uses the generic `withFixture()` helper. Additionally normalizes CWD slugs, UUIDs, and ISO timestamps before hashing to ensure fixture stability across environments and runs.

#### `withFixture<T>(input, fixtureName, f)` — Generic Fixture Helper

(`src/services/vcr.ts:39-86`) SHA-1 hashes the input, reads/writes `fixtures/{name}-{hash}.json` files. Fixture root is controlled by `CLAUDE_CODE_TEST_FIXTURES_ROOT` env var, falling back to the current working directory.

### Dehydration/Hydration

| Dynamic Value | Placeholder |
|--------------|-------------|
| Current working directory | `[CWD]` |
| Claude config home (`getClaudeConfigHomeDir()`) | `[CONFIG_HOME]` |
| File counts (`num_files="..."`) | `[NUM]` |
| Durations (`duration_ms="..."`) | `[DURATION]` |
| Costs (`cost_usd="..."`) | `[COST]` |
| Available commands list | `[COMMANDS]` |
| User-modified files block | `Files modified by user: [FILES]` |

Windows-specific normalization handles forward-slash, backslash, and JSON-escaped path variants (`src/services/vcr.ts:310-331`). Post-placeholder path separators are also normalized to forward slashes so fixture hashes match across platforms (`src/services/vcr.ts:325-331`).

---

## Internal Logging

### Functions

All functions are **no-ops for external users** (guarded by `process.env.USER_TYPE !== 'ant'`).

#### `getKubernetesNamespace()` (memoized)
(`src/services/internalLogging.ts:17-30`) Reads `/var/run/secrets/kubernetes.io/serviceaccount/namespace` to determine the Kubernetes namespace of the current devbox. Returns `null` on local development machines.

#### `getContainerId()` (memoized, exported)
(`src/services/internalLogging.ts:35-66`) Parses `/proc/self/mountinfo` to extract the OCI container ID. Matches both Docker (`/docker/containers/[64-hex]`) and containerd/CRI-O (`/sandboxes/[64-hex]`) patterns.

#### `logPermissionContextForAnts(toolPermissionContext, moment)`
(`src/services/internalLogging.ts:71-90`) Logs a `tengu_internal_record_permission_context` analytics event (via `logEvent` from `src/services/analytics/index.ts`) with:
- The `moment` (`"summary"` or `"initialization"`)
- The Kubernetes namespace
- The serialized tool permission context
- The container ID

---

## Edge Cases & Caveats

- **Token estimation fallibility**: `roughTokenCountEstimation` can significantly undercount JSON content (hence the file-type-aware variant) and overcount base64-encoded images/documents. The fixed 2000-token constant for images is a deliberate conservative choice matching microCompact.
- **Bedrock token counting**: The `@anthropic-sdk/bedrock-sdk` doesn't support `countTokens`, so the module dynamically imports `@aws-sdk/client-bedrock-runtime` to avoid loading ~279KB of AWS SDK code unless needed.
- **VCR fixture staleness**: Fixtures must be re-recorded (`VCR_RECORD=1`) when API response formats change. CI builds fail fast on missing fixtures rather than silently calling real APIs.
- **Prevent-sleep is macOS-only**: No equivalent is implemented for Linux or Windows. The `caffeinate` process uses SIGKILL for termination because SIGTERM could be delayed.
- **Diagnostic tracking requires IDE**: The entire diagnostic tracking flow silently degrades to no-ops if no IDE MCP client is connected.