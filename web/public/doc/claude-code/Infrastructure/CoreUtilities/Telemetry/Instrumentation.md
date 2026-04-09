# Instrumentation

## Overview & Responsibilities

The Instrumentation module is the telemetry bootstrap layer for Claude Code. It lives within the **Infrastructure → CoreUtilities → Telemetry** hierarchy and is responsible for initializing the full OpenTelemetry (OTel) observability pipeline — metrics, logs, and traces — before any other application code emits telemetry data.

Its core duties are:

- **Environment variable bootstrapping**: Copies build-time `ANT_OTEL_*` variables into standard `OTEL_*` variables for internal (Anthropic) users, and sets sane defaults (e.g., delta temporality for metrics).
- **Exporter configuration**: Dynamically creates metric, log, and trace exporters based on env-var–driven protocol selection (`grpc`, `http/json`, `http/protobuf`, `console`, `prometheus`).
- **Resource detection**: Assembles OTel resource attributes from OS, host architecture, environment detectors, and service metadata.
- **BigQuery integration**: Adds a BigQuery metrics exporter for API customers, Claude for Enterprise, and Claude for Teams users.
- **Beta tracing**: Provides a separate tracing code path (`BETA_TRACING_ENDPOINT`) for detailed debugging, independent of the standard OTLP pipeline.
- **Proxy & mTLS**: Configures HTTP agent options for exporter connections, including HTTPS proxy agents, mutual TLS certificates, and custom CA bundles.
- **Shutdown orchestration**: Registers cleanup handlers that flush and shut down all providers within a configurable timeout, preventing data loss on exit.
- **Diagnostic logging**: Supplies a custom OTel `DiagLogger` that routes errors and warnings into the application's debug log while silencing verbose/info/debug output from the OTel SDK itself.

The module exposes two files:

| File | Purpose |
|------|---------|
| `src/utils/telemetry/instrumentation.ts` | All bootstrap, exporter setup, resource detection, and shutdown logic |
| `src/utils/telemetry/logger.ts` | The `ClaudeCodeDiagLogger` class used by OTel's internal diagnostics |

## Key Processes

### 1. Bootstrap: Environment Variable Setup

`bootstrapTelemetry()` (`instrumentation.ts:87-117`) runs first. For internal users (`USER_TYPE === 'ant'`), it copies six `ANT_OTEL_*` build-time variables into their standard `OTEL_*` counterparts (exporter type, protocol, endpoint, headers). It then sets a global default of `delta` for metrics temporality if not already specified.

### 2. Full Initialization Flow

`initializeTelemetry()` (`instrumentation.ts:421-701`) is the main entry point called during application startup. The sequence is:

1. **Call `bootstrapTelemetry()`** to set env vars.
2. **Strip console exporters** when running in structured/JSON output mode (`getHasFormattedOutput()`), because `console.dir` output would corrupt the SDK's line-delimited JSON protocol (`instrumentation.ts:432-447`).
3. **Set the OTel diagnostic logger** to `ClaudeCodeDiagLogger` at `ERROR` level (`instrumentation.ts:449`).
4. **Initialize Perfetto tracing** (independent of OTel, gated by `CLAUDE_CODE_PERFETTO_TRACE`).
5. **Build metric readers**: If `CLAUDE_CODE_ENABLE_TELEMETRY` is truthy, create OTLP metric readers. If the user qualifies (API customer, C4E, or Teams), add a BigQuery metric reader.
6. **Detect resources**: Merge service attributes (`claude-code`, version, WSL info) with OS, host architecture, and environment-detected attributes.
7. **Branch on beta tracing**: If `isBetaTracingEnabled()`, take a separate path that initializes traces and logs against `BETA_TRACING_ENDPOINT`, sets up only a `MeterProvider` for metrics, registers shutdown, and returns early.
8. **Create `MeterProvider`** with the merged resource and all readers.
9. **Initialize log exporters** (if telemetry enabled): create a `LoggerProvider` with `BatchLogRecordProcessor` per exporter, register it globally, and create the event logger (`com.anthropic.claude_code.events`).
10. **Initialize trace exporters** (if telemetry enabled AND enhanced telemetry enabled): create a `BasicTracerProvider` with `BatchSpanProcessor` per exporter.
11. **Register shutdown** via `registerCleanup()`.
12. **Return** the application's `Meter` instance.

### 3. Exporter Resolution (Metrics, Logs, Traces)

Each signal type follows the same pattern — implemented in `getOtlpReaders()` (`instrumentation.ts:130-215`), `getOtlpLogExporters()` (`instrumentation.ts:217-271`), and `getOtlpTraceExporters()` (`instrumentation.ts:273-322`):

1. Parse the comma-separated exporter list from the relevant `OTEL_*_EXPORTER` env var using `parseExporterTypes()`.
2. For each type:
   - `"console"` → use the SDK's built-in console exporter (with resource attribute logging for metrics).
   - `"otlp"` → resolve the protocol from the signal-specific or global `OTEL_EXPORTER_OTLP_*_PROTOCOL` env var, then **dynamically import** the matching exporter package. This lazy-import strategy keeps unused packages (especially `@grpc/grpc-js` at ~700KB) out of the bundle.
   - `"prometheus"` → dynamically import and create `PrometheusExporter` (metrics only).
3. Wrap push-based exporters in `PeriodicExportingMetricReader` (metrics) or `BatchLogRecordProcessor` / `BatchSpanProcessor` (logs/traces).

### 4. Proxy & mTLS Configuration

`getOTLPExporterConfig()` (`instrumentation.ts:768-825`) builds the HTTP agent configuration for all OTLP exporters:

- Parses static headers from `OTEL_EXPORTER_OTLP_HEADERS`.
- If `settings.otelHeadersHelper` is configured, wraps headers in an async function that merges static headers with dynamically fetched ones.
- If no proxy is configured or the OTLP endpoint matches the proxy bypass list, applies mTLS and CA certs directly as `httpAgentOptions`.
- Otherwise, creates an `HttpsProxyAgent` factory that forwards mTLS certs and CA bundles through the proxy.

### 5. Shutdown & Flush

Two shutdown mechanisms exist:

- **`shutdownTelemetry`** (registered via `registerCleanup`): Ends active interaction spans, then races `Promise.all([...provider.shutdown()])` against a configurable timeout (`CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS`, default 2000ms). In beta tracing mode, providers are flushed-then-shut-down independently to avoid waterfall delays (`instrumentation.ts:527-561`).
- **`flushTelemetry()`** (`instrumentation.ts:707-747`): An explicit flush API meant for sensitive transitions like logout or org switching. Uses a separate timeout (`CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS`, default 5000ms) and swallows errors to avoid blocking the caller.

Both use `TelemetryTimeoutError` and the `telemetryTimeout()` helper (`instrumentation.ts:73-85`) which creates a `setTimeout` with `.unref()` so the timer doesn't keep the process alive.

### 6. Diagnostic Logger

`ClaudeCodeDiagLogger` (`logger.ts:4-26`) implements OTel's `DiagLogger` interface:

| Method | Behavior |
|--------|----------|
| `error` | Logs via `logError()` + `logForDebugging()` at error level |
| `warn` | Logs via `logError()` + `logForDebugging()` at warn level |
| `info` | No-op (suppressed) |
| `debug` | No-op (suppressed) |
| `verbose` | No-op (suppressed) |

This prevents the OTel SDK's verbose internal diagnostics from flooding application logs while still surfacing actionable errors and warnings.

## Function Signatures

### `bootstrapTelemetry(): void`
Copies `ANT_OTEL_*` env vars to `OTEL_*` for internal users and sets default metrics temporality.

> `instrumentation.ts:87-117`

### `initializeTelemetry(): Promise<Meter>`
Main entry point. Initializes all OTel providers (metrics, logs, traces), registers shutdown handlers, and returns the application `Meter`.

> `instrumentation.ts:421-701`

### `flushTelemetry(): Promise<void>`
Force-flushes all active providers within a timeout. Designed for pre-logout or org-switch scenarios. Never throws.

> `instrumentation.ts:707-747`

### `isTelemetryEnabled(): boolean`
Returns `true` if `CLAUDE_CODE_ENABLE_TELEMETRY` is a truthy value.

> `instrumentation.ts:324-326`

### `parseExporterTypes(value: string | undefined): string[]`
Parses a comma-separated exporter list, filtering out empty strings and `"none"`.

> `instrumentation.ts:121-128`

## Configuration & Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | Enables 3P OTLP exporters for metrics, logs, and traces | — |
| `OTEL_METRICS_EXPORTER` | Comma-separated metric exporter types (`otlp`, `console`, `prometheus`, `none`) | — |
| `OTEL_LOGS_EXPORTER` | Comma-separated log exporter types (`otlp`, `console`, `none`) | — |
| `OTEL_TRACES_EXPORTER` | Comma-separated trace exporter types (`otlp`, `console`, `none`) | — |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Global OTLP protocol: `grpc`, `http/json`, `http/protobuf` | — |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint URL | — |
| `OTEL_EXPORTER_OTLP_HEADERS` | Static headers as `key=value` pairs, comma-separated | — |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | Metrics temporality | `delta` |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metrics export interval (ms) | `60000` |
| `OTEL_LOGS_EXPORT_INTERVAL` | Log export interval (ms) | `5000` |
| `OTEL_TRACES_EXPORT_INTERVAL` | Trace export interval (ms) | `5000` |
| `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS` | Shutdown flush timeout (ms) | `2000` |
| `CLAUDE_CODE_OTEL_FLUSH_TIMEOUT_MS` | Explicit flush timeout (ms) | `5000` |
| `ENABLE_BETA_TRACING_DETAILED` | Enables the beta tracing code path | — |
| `BETA_TRACING_ENDPOINT` | Endpoint URL for beta tracing (separate from standard OTLP) | — |
| `CLAUDE_CODE_PERFETTO_TRACE` | Enables Perfetto tracing (`1` or a file path) | — |
| `USER_TYPE` | When set to `ant`, activates `ANT_OTEL_*` → `OTEL_*` variable copying | — |

Signal-specific protocol overrides (`OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`) take precedence over the global `OTEL_EXPORTER_OTLP_PROTOCOL`.

## Edge Cases & Caveats

- **Console exporters are stripped in structured-output mode** (`instrumentation.ts:432-447`). Because console exporters write pretty-printed objects to stdout, they would corrupt the line-delimited JSON protocol used by the SDK message channel. The stripping happens inside `initializeTelemetry()` — not earlier — because `bootstrapTelemetry()` and remote-managed-settings re-application can re-introduce them.

- **Dynamic imports for exporters** (`instrumentation.ts:169-172, 238-240, 289-291`). Exporter packages are imported lazily inside `switch` statements. This avoids loading all six OTLP packages (~1.2MB) on every startup when only one protocol is actually used.

- **Beta tracing returns early** (`instrumentation.ts:514-564`). When beta tracing is enabled, `initializeTelemetry()` creates a `MeterProvider` for metrics but initializes logs and traces against the `BETA_TRACING_ENDPOINT` via HTTP/JSON — then returns early, skipping the standard OTLP log/trace setup entirely.

- **Shutdown timeout uses `.unref()`** (`instrumentation.ts:83`). The timeout timer is unref'd so it does not keep the Node.js event loop alive if all other work has completed.

- **BigQuery metrics export at 5-minute intervals** (`instrumentation.ts:330-333`). The BigQuery exporter uses a much longer interval than standard OTLP exporters to reduce load on the BigQuery backend.

- **`flushTelemetry()` swallows errors** (`instrumentation.ts:745-746`). It never throws, allowing logout or org-switch flows to proceed even when telemetry backends are unreachable.

- **Beta tracing shutdown flushes before shutdown per-provider** (`instrumentation.ts:543-551`). Each provider's `forceFlush().then(() => shutdown())` chain runs independently inside the timeout race, avoiding a waterfall where a slow logger flush blocks tracer shutdown.