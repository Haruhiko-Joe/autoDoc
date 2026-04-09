# Analytics

## Overview & Responsibilities

The Analytics module is the telemetry and observability backbone of Claude Code, living under `src/services/analytics/`. Within the **Services** layer of the application architecture, it sits alongside the API client, MCP protocol client, and other backend integrations. It is responsible for:

- **Event logging** with a two-phase initialization pattern (queue-then-drain) so events are never lost during startup
- **Dual-sink routing** to Datadog (operational metrics) and a first-party (1P) event logging endpoint (product analytics via BigQuery)
- **Feature flag management** via GrowthBook (replacing the former Statsig integration), with cached feature gates and dynamic configs
- **Per-sink killswitches** for disabling individual backends at runtime without a deploy
- **Event sampling** to control volume of high-frequency events
- **Metadata enrichment** that attaches environment, session, agent, and process metrics to every event
- **PII protection** through marker types, tool name sanitization, and `_PROTO_*` field stripping

The module is consumed by virtually every other part of the application — Bootstrap initializes it, QueryEngine logs API events through it, ToolSystem records tool usage, and the TerminalUI reads feature gates from it.

## Key Processes

### Event Lifecycle: From `logEvent()` to Backend

1. Any module calls `logEvent(eventName, metadata)` or `logEventAsync()` from `index.ts`. The metadata type intentionally excludes strings to prevent accidental logging of code or file paths (`src/services/analytics/index.ts:61`).

2. If no sink is attached yet (early startup), the event is pushed onto an in-memory `eventQueue` (`src/services/analytics/index.ts:81`). Once `attachAnalyticsSink()` is called, queued events are drained asynchronously via `queueMicrotask` to avoid blocking the startup path (`src/services/analytics/index.ts:113-121`).

3. The sink implementation in `sink.ts` receives the event and runs it through **sampling** first — `shouldSampleEvent()` checks the `tengu_event_sampling_config` GrowthBook dynamic config. Events not selected are dropped; sampled events get a `sample_rate` field added (`src/services/analytics/sink.ts:48-71`).

4. The event is then fanned out to two backends:
   - **Datadog**: only if the `tengu_log_datadog_events` feature gate is enabled and the `datadog` sink is not killed. `_PROTO_*` keys are stripped before sending (`src/services/analytics/sink.ts:63-67`).
   - **1P Event Logger**: receives the full payload including `_PROTO_*` keys, which are hoisted to proto fields by the exporter (`src/services/analytics/sink.ts:69-72`).

### Sink Initialization

During app startup, `initializeAnalyticsSink()` in `sink.ts` creates the `AnalyticsSink` object and passes it to `attachAnalyticsSink()`. This is idempotent — safe to call from both `preAction` hooks and `setup()` (`src/services/analytics/sink.ts:109-114`).

`initializeAnalyticsGates()` reads the Datadog feature gate from GrowthBook's cached value so early events don't miss the gate check (`src/services/analytics/sink.ts:96-99`).

### GrowthBook Feature Flag Flow

1. `getGrowthBookClient()` creates a `GrowthBook` SDK instance with `remoteEval: true`, sending user attributes (device ID, platform, org UUID, etc.) to the server for server-side evaluation (`src/services/analytics/growthbook.ts:526-545`).

2. On successful `init()`, `processRemoteEvalPayload()` works around an API format mismatch (the server returns `value` instead of `defaultValue`) and caches evaluated feature values in-memory in `remoteEvalFeatureValues` (`src/services/analytics/growthbook.ts:327-394`).

3. Values are synced to disk via `syncRemoteEvalToDisk()` into `~/.claude.json`'s `cachedGrowthBookFeatures`, so they survive process restarts (`src/services/analytics/growthbook.ts:407-417`).

4. Consumers read values through two primary APIs:
   - `getFeatureValue_CACHED_MAY_BE_STALE()` — synchronous, reads from in-memory cache first, falls back to disk. Preferred for hot paths (`src/services/analytics/growthbook.ts:734-775`).
   - `getDynamicConfig_BLOCKS_ON_INIT()` — async, waits for GrowthBook initialization. Used where freshness matters more than latency (`src/services/analytics/growthbook.ts:1136-1141`).

5. Long-running sessions get periodic refresh (6 hours for external users, 20 minutes for internal "ant" users) via `setupPeriodicGrowthBookRefresh()` (`src/services/analytics/growthbook.ts:1087-1110`).

6. When feature values refresh, registered `onGrowthBookRefresh` listeners are notified so systems that bake config into long-lived objects (like the 1P event logger pipeline) can rebuild (`src/services/analytics/growthbook.ts:139-157`).

### Datadog Event Pipeline

1. `trackDatadogEvent()` checks several guards: production environment only, first-party API provider only, event must be in `DATADOG_ALLOWED_EVENTS` allowlist (~40 events) (`src/services/analytics/datadog.ts:19-64, 160-179`).

2. Events are enriched with `getEventMetadata()` and environment context, then normalized for cardinality reduction:
   - MCP tool names collapsed to `"mcp"` (`src/services/analytics/datadog.ts:197-203`)
   - Model names mapped to canonical short names for external users (`src/services/analytics/datadog.ts:205-208`)
   - Dev versions truncated to `major.minor.patch-dev.YYYYMMDD` (`src/services/analytics/datadog.ts:211-217`)
   - HTTP `status` remapped to `http_status` + `http_status_range` to avoid Datadog reserved field conflicts (`src/services/analytics/datadog.ts:220-232`)

3. Events are batched (max 100) with a 15-second flush interval. The batch is sent via HTTP POST to the Datadog Logs API (`src/services/analytics/datadog.ts:98-128`).

4. A `userBucket` (0-29) is derived from a SHA-256 hash of the user ID. This allows approximate unique-user counting in alerts without logging actual user IDs (`src/services/analytics/datadog.ts:281-299`).

### 1P Event Logging Pipeline

1. `initialize1PEventLogging()` creates an OpenTelemetry `LoggerProvider` with a `BatchLogRecordProcessor` and the custom `FirstPartyEventLoggingExporter` (`src/services/analytics/firstPartyEventLogger.ts:312-389`).

2. `logEventTo1P()` enriches each event with `getEventMetadata()` core metadata, user data, and a unique `event_id`, then emits it as an OTel log record (`src/services/analytics/firstPartyEventLogger.ts:156-207`).

3. The `FirstPartyEventLoggingExporter` implements resilient export:
   - **Batched chunking**: events are split into chunks of `maxBatchSize` (default 200) and sent sequentially with delays between batches (`src/services/analytics/firstPartyEventLoggingExporter.ts:379-428`).
   - **Disk-backed retry**: failed events are appended to JSONL files under `~/.claude/telemetry/` keyed by session + batch UUID (`src/services/analytics/firstPartyEventLoggingExporter.ts:148-153, 430-443`).
   - **Quadratic backoff**: `baseBackoffDelayMs * attempts²`, capped at `maxBackoffDelayMs` (default 30s), max 8 attempts (`src/services/analytics/firstPartyEventLoggingExporter.ts:445-467`).
   - **Auth fallback**: on 401, retries without auth headers (`src/services/analytics/firstPartyEventLoggingExporter.ts:593-614`).
   - **Cross-session recovery**: on startup, retries failed events from previous runs of the same session (`src/services/analytics/firstPartyEventLoggingExporter.ts:220-275`).

4. Log records are transformed into proto-compatible `ClaudeCodeInternalEvent` or `GrowthbookExperimentEvent` payloads before export (`src/services/analytics/firstPartyEventLoggingExporter.ts:635-762`).

5. `reinitialize1PEventLoggingIfConfigChanged()` is registered as a GrowthBook refresh listener. When the `tengu_1p_event_batch_config` changes, it drains the old pipeline and rebuilds with new settings, with safe fallback on failure (`src/services/analytics/firstPartyEventLogger.ts:407-449`).

## Function Signatures

### Public API (`index.ts`)

#### `logEvent(eventName: string, metadata: { [key: string]: boolean | number | undefined }): void`
Fire-and-forget event logging. Queues if no sink attached. Metadata intentionally excludes strings to prevent PII leaks.

#### `logEventAsync(eventName: string, metadata: { ... }): Promise<void>`
Async variant. Currently wraps the sync implementation since both remaining sinks are fire-and-forget.

#### `attachAnalyticsSink(newSink: AnalyticsSink): void`
Attaches the backend sink. Idempotent — no-op if already attached. Drains queued events via `queueMicrotask`.

#### `stripProtoFields<V>(metadata: Record<string, V>): Record<string, V>`
Removes `_PROTO_*` keys from metadata destined for general-access storage. Returns the same reference if no `_PROTO_` keys are present.

### Sink (`sink.ts`)

#### `initializeAnalyticsSink(): void`
Creates and attaches the analytics sink. Idempotent. Call during app startup.

#### `initializeAnalyticsGates(): void`
Pre-loads the Datadog feature gate from GrowthBook cache for early events.

### GrowthBook (`growthbook.ts`)

#### `getFeatureValue_CACHED_MAY_BE_STALE<T>(feature: string, defaultValue: T): T`
Synchronous, non-blocking feature value read. Checks in-memory cache, then disk cache, then default. Preferred for hot paths.

#### `getDynamicConfig_CACHED_MAY_BE_STALE<T>(configName: string, defaultValue: T): T`
Semantic alias for `getFeatureValue_CACHED_MAY_BE_STALE`. GrowthBook dynamic configs are just features with object values.

#### `checkStatsigFeatureGate_CACHED_MAY_BE_STALE(gate: string): boolean`
Migration shim: checks GrowthBook cache, falls back to legacy Statsig cache.

#### `checkSecurityRestrictionGate(gate: string): Promise<boolean>`
For security-critical gates. Waits for in-progress re-initialization before returning.

#### `checkGate_CACHED_OR_BLOCKING(gate: string): Promise<boolean>`
Fast path if disk cache is `true`; blocks on init if `false`/missing. For user-invoked features where stale `false` is worse than stale `true`.

#### `onGrowthBookRefresh(listener: () => void | Promise<void>): () => void`
Registers a callback for feature value refresh events. Returns an unsubscribe function. Fires catch-up if features are already loaded.

#### `refreshGrowthBookAfterAuthChange(): void`
Destroys and recreates the GrowthBook client with fresh auth headers. Used after login/logout.

### Metadata (`metadata.ts`)

#### `getEventMetadata(options?: EnrichMetadataOptions): Promise<EventMetadata>`
Collects model, session, environment, process metrics, agent identification, and subscription info into a unified metadata object.

#### `sanitizeToolNameForAnalytics(toolName: string): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
Returns `'mcp_tool'` for MCP tools (PII risk), original name for built-in tools.

#### `to1PEventFormat(metadata: EventMetadata, userMetadata: CoreUserData, additionalMetadata?: Record<string, unknown>): FirstPartyEventLoggingMetadata`
Converts camelCase metadata to snake_case proto-compatible format for the 1P event logging API.

### Config (`config.ts`)

#### `isAnalyticsDisabled(): boolean`
Returns `true` in test environments, on third-party providers (Bedrock/Vertex/Foundry), or when telemetry is disabled via privacy settings.

#### `isFeedbackSurveyDisabled(): boolean`
Like `isAnalyticsDisabled()` but does NOT block on 3P providers — the feedback survey is a local UI prompt with no transcript data.

## Interface/Type Definitions

### `AnalyticsSink` (`index.ts:72-78`)
```typescript
type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (eventName: string, metadata: LogEventMetadata) => Promise<void>
}
```

### `EventMetadata` (`metadata.ts:472-496`)
Core metadata attached to all analytics events. Includes `model`, `sessionId`, `userType`, `envContext`, `processMetrics`, swarm agent identification (`agentId`, `agentType`, `teamName`), `subscriptionType`, and `rh` (hashed repo remote URL).

### `GrowthBookUserAttributes` (`growthbook.ts:32-47`)
User attributes sent to GrowthBook for targeting: `id`, `sessionId`, `deviceID`, `platform`, `organizationUUID`, `accountUUID`, `subscriptionType`, `email`, etc.

### `SinkName` (`sinkKillswitch.ts:6`)
```typescript
type SinkName = 'datadog' | 'firstParty'
```

### `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` (`index.ts:19`)
Marker type (`never`) used as a cast annotation to document that a string value has been verified not to contain sensitive data. Forces developer intent documentation at call sites.

### `AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED` (`index.ts:33`)
Marker type for values routed to PII-tagged proto columns via `_PROTO_*` payload keys.

## Configuration & Defaults

### Environment Variables
| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `'test'` disables all analytics; `'production'` required for Datadog |
| `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` | Disables analytics for third-party providers |
| `USER_TYPE` | `'ant'` enables debug logging and shorter GrowthBook refresh intervals (20 min vs 6 hours) |
| `CLAUDE_INTERNAL_FC_OVERRIDES` | JSON object overriding GrowthBook features (ant-only, for eval harnesses) |
| `OTEL_LOG_TOOL_DETAILS` | `'1'` enables detailed MCP tool name logging in OTLP events |
| `ANTHROPIC_BASE_URL` | Overrides API endpoint; affects GrowthBook and 1P exporter base URL |
| `CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS` | Override Datadog flush interval (testing) |

### GrowthBook Dynamic Configs
| Config Name | Purpose | Default |
|-------------|---------|---------|
| `tengu_log_datadog_events` | Feature gate enabling Datadog event tracking | `false` |
| `tengu_event_sampling_config` | Per-event sampling rates `{ eventName: { sample_rate: 0-1 } }` | `{}` (log all) |
| `tengu_1p_event_batch_config` | Batch processor tuning: `scheduledDelayMillis`, `maxExportBatchSize`, `maxQueueSize`, `skipAuth`, `maxAttempts`, `path`, `baseUrl` | Sensible defaults |
| `tengu_frond_boric` | Per-sink killswitch `{ datadog?: boolean, firstParty?: boolean }` | `{}` (all sinks on) |

### Datadog Defaults
- Flush interval: 15 seconds
- Max batch size: 100 events
- Network timeout: 5 seconds
- User buckets: 30

### 1P Event Logger Defaults
- Export interval: 10 seconds
- Max export batch size: 200
- Max queue size: 8192
- Backoff: 500ms base, 30s max, 8 max attempts (quadratic)
- Endpoint: `https://api.anthropic.com/api/event_logging/batch`

## Edge Cases & Caveats

- **`_PROTO_*` field handling**: Keys prefixed with `_PROTO_` carry PII-tagged values meant only for privileged BigQuery columns. `stripProtoFields()` removes them before Datadog dispatch. The 1P exporter hoists known keys (`_PROTO_skill_name`, `_PROTO_plugin_name`, `_PROTO_marketplace_name`) to proto fields and defensively strips any remaining `_PROTO_*` from `additional_metadata` to prevent unrecognized keys from leaking.

- **Circular dependency avoidance**: `index.ts` has **zero imports** by design. The event queue pattern allows any module to import `logEvent` without risking circular dependencies. The actual routing logic lives in `sink.ts`, which imports from all other analytics modules.

- **GrowthBook SDK workaround**: The remote eval API returns `{ "value": ... }` but the SDK expects `{ "defaultValue": ... }`. `processRemoteEvalPayload()` transforms the format and caches evaluated values directly, bypassing the SDK's `evalFeature()` which doesn't work correctly with `remoteEval: true` (`src/services/analytics/growthbook.ts:327-394`).

- **Killswitch must not be called from `is1PEventLoggingEnabled()`**: `growthbook.ts:isGrowthBookEnabled()` calls `is1PEventLoggingEnabled()`, so looking up the killswitch config there would create infinite recursion. Killswitches are checked at per-event dispatch sites instead (`src/services/analytics/sinkKillswitch.ts:16-17`).

- **GrowthBook reinit event-loss window**: When `reinitialize1PEventLoggingIfConfigChanged()` swaps the pipeline, the logger is nulled first. Concurrent `logEventTo1P()` calls during the swap window hit the null guard and are silently dropped — a small acceptable loss to prevent emitting to a draining provider (`src/services/analytics/firstPartyEventLogger.ts:396-406`).

- **Auth lifecycle**: GrowthBook client auth headers cannot be updated after creation. Login/logout triggers a full client destroy-and-recreate cycle via `refreshGrowthBookAfterAuthChange()`. The 1P exporter handles 401s by retrying without auth, and skips auth entirely when OAuth tokens are expired or lack `user:profile` scope.

- **Datadog's `status` field**: Datadog reserves `status` as a log level field. HTTP status codes are remapped to `http_status` and `http_status_range` to avoid conflicts (`src/services/analytics/datadog.ts:220-232`).

- **Empty GrowthBook payload guard**: If the server returns `{features: {}}` (transient bug or truncated response), `processRemoteEvalPayload` returns `false` and does **not** sync to disk — preventing a complete flag blackout for all processes sharing `~/.claude.json` (`src/services/analytics/growthbook.ts:338-339`).