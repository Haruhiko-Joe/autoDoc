# Initialization

## Overview & Responsibilities

The Initialization module (`src/entrypoints/init.ts`) is the **first code that runs** after process launch. It bootstraps the entire application environment — configuring TLS, proxies, telemetry, cleanup handlers, and more — so that all downstream modules (UI, query engine, tools) operate in a fully-prepared environment.

Within the **Bootstrap** layer of the architecture, this module sits alongside the CLI argument parser and the main entrypoint. Its sibling modules handle argument parsing and REPL launch; this module's sole job is ensuring the runtime environment is ready before any user-facing logic executes.

The module exports two key functions:

- **`init()`** — Memoized (runs exactly once). Performs all synchronous and async setup steps in a carefully ordered sequence.
- **`initializeTelemetryAfterTrust()`** — Called separately, after the user accepts the trust dialog, to set up OpenTelemetry/Datadog metrics.

## Key Processes

### `init()` — Full Bootstrap Sequence

The `init()` function is wrapped with `lodash-es/memoize`, guaranteeing it runs at most once regardless of how many callers `await` it. It records timing via `profileCheckpoint()` and `logForDiagnosticsNoPII()` at each stage.

The steps execute in this order:

1. **Enable configs** — `enableConfigs()` validates and activates the configuration system (`src/entrypoints/init.ts:65`).

2. **Apply safe environment variables** — `applySafeConfigEnvironmentVariables()` sets only non-sensitive env vars before the trust dialog. Full env var application is deferred until after trust is established (`src/entrypoints/init.ts:74`).

3. **Apply extra CA certificates** — `applyExtraCACertsFromConfig()` injects `NODE_EXTRA_CA_CERTS` from `settings.json` into `process.env` early, before any TLS connections occur. This is critical because Bun caches the TLS cert store at boot (`src/entrypoints/init.ts:79`).

4. **Set up graceful shutdown** — `setupGracefulShutdown()` installs signal handlers to ensure buffers are flushed on exit (`src/entrypoints/init.ts:87`).

5. **Initialize 1P event logging** — Dynamically imports `firstPartyEventLogger` and `growthbook` in parallel, then calls `initialize1PEventLogging()`. Also registers a GrowthBook refresh callback to reinitialize logging if the `tengu_1p_event_batch_config` feature flag changes mid-session. This is fire-and-forget (`void`) (`src/entrypoints/init.ts:94-105`).

6. **Populate OAuth account info** — `populateOAuthAccountInfoIfNeeded()` fills in OAuth account info that may be missing when login happened through the VSCode extension. Fire-and-forget (`src/entrypoints/init.ts:110`).

7. **JetBrains IDE detection** — `initJetBrainsDetection()` asynchronously populates a cache for later synchronous access (`src/entrypoints/init.ts:114`).

8. **Repository detection** — `detectCurrentRepository()` identifies the current GitHub repository for PR linking features (`src/entrypoints/init.ts:118`).

9. **Remote managed settings & policy limits** — If eligible, initializes loading promises for remote managed settings and policy limits. These promises include timeouts to prevent deadlocks in Agent SDK tests (`src/entrypoints/init.ts:123-128`).

10. **Record first start time** — `recordFirstStartTime()` persists when the CLI was first launched (`src/entrypoints/init.ts:132`).

11. **Configure mTLS** — `configureGlobalMTLS()` sets up mutual TLS for corporate environments (`src/entrypoints/init.ts:137`).

12. **Configure proxy agents** — `configureGlobalAgents()` sets up global HTTP agents for proxy and/or mTLS transport (`src/entrypoints/init.ts:146`).

13. **Preconnect to Anthropic API** — `preconnectAnthropicApi()` overlaps TCP+TLS handshake (~100-200ms) with subsequent setup work. Skipped when proxy/mTLS/unix/cloud-provider configurations prevent connection reuse from the global pool (`src/entrypoints/init.ts:159`).

14. **CCR upstream proxy** (conditional) — When `CLAUDE_CODE_REMOTE` is truthy, lazily imports and starts a local CONNECT relay so agent subprocesses can reach org-configured upstreams with credential injection. Registers `getUpstreamProxyEnv` with `subprocessEnv.ts` for automatic proxy var injection. Fails open on any error (`src/entrypoints/init.ts:167-183`).

15. **Windows shell setup** — `setShellIfWindows()` configures git-bash paths on Windows (`src/entrypoints/init.ts:186`).

16. **Register cleanup handlers** — Two handlers are registered:
    - `shutdownLspServerManager` — shuts down the LSP server manager (`src/entrypoints/init.ts:189`)
    - Session team cleanup — lazily imports swarm team helpers to clean up teams created by subagents (`src/entrypoints/init.ts:195-200`)

17. **Create scratchpad directory** — If `isScratchpadEnabled()`, calls `ensureScratchpadDir()` to create the temporary working directory (`src/entrypoints/init.ts:203-209`).

### Error Handling

The entire body is wrapped in a try/catch that specifically handles `ConfigParseError`:

- **Non-interactive sessions**: Writes the error to stderr and calls `gracefulShutdownSync(1)` — avoids rendering an Ink dialog that would break JSON consumers (`src/entrypoints/init.ts:220-226`).
- **Interactive sessions**: Dynamically imports and shows `InvalidConfigDialog`, which handles `process.exit` internally (`src/entrypoints/init.ts:229-231`).
- All other errors are rethrown.

### `initializeTelemetryAfterTrust()` — Post-Trust Telemetry Setup

This function is called once the user has accepted the trust dialog. Its behavior branches based on remote managed settings eligibility:

**Remote-settings-eligible users:**
1. If in SDK/headless mode with beta tracing enabled, eagerly initializes telemetry first so the tracer is ready before the first query (`src/entrypoints/init.ts:252-259`).
2. Waits for remote managed settings to load (non-blocking).
3. Re-applies full environment variables via `applyConfigEnvironmentVariables()` to include remote settings.
4. Calls `doInitializeTelemetry()`.

**Non-eligible users:**
- Calls `doInitializeTelemetry()` immediately.

All errors are caught and logged rather than thrown, ensuring telemetry failures never block the application.

### `doInitializeTelemetry()` — Guarded Telemetry Init

A private async function that prevents double initialization via a module-level `telemetryInitialized` boolean flag (`src/entrypoints/init.ts:288-303`):

- Sets the flag **before** calling `setMeterState()`.
- Resets the flag on failure so subsequent calls can retry.

### `setMeterState()` — OpenTelemetry Meter Creation

Lazily imports `initializeTelemetry` from `../utils/telemetry/instrumentation.js` to defer ~400KB of OpenTelemetry + protobuf modules until actually needed. gRPC exporters (~700KB) are further lazy-loaded within instrumentation (`src/entrypoints/init.ts:305-340`).

If a meter is returned:
1. Creates an `AttributedCounter` factory that merges fresh `getTelemetryAttributes()` with per-call attributes on every `.add()` invocation.
2. Registers the meter and factory with global state via `setMeter()`.
3. Increments the session counter (`getSessionCounter()?.add(1)`) — done here because startup telemetry runs before this async initialization completes.

## Function Signatures

### `init(): Promise<void>`

Memoized bootstrap function. Safe to call multiple times; only the first invocation executes.

- **Returns**: `Promise<void>` — resolves when all setup steps complete.
- **Throws**: Re-throws non-`ConfigParseError` exceptions.

> Source: `src/entrypoints/init.ts:57-238`

### `initializeTelemetryAfterTrust(): void`

Kicks off telemetry initialization after the trust dialog. Synchronous entry point that spawns async work internally (fire-and-forget).

- **No parameters, no return value.**
- **Side effects**: Initializes OpenTelemetry meter, registers counters in global state.

> Source: `src/entrypoints/init.ts:247-286`

## Configuration & Defaults

| Aspect | Detail |
|--------|--------|
| `CLAUDE_CODE_REMOTE` | Environment variable. When truthy, enables upstream proxy initialization for CCR environments. |
| `NODE_EXTRA_CA_CERTS` | Read from `settings.json` via `applyExtraCACertsFromConfig()`. Must be applied before first TLS handshake. |
| Scratchpad | Gated by `isScratchpadEnabled()`. Directory is created with `ensureScratchpadDir()`. |
| Remote managed settings | Gated by `isEligibleForRemoteManagedSettings()`. Loading promise includes a timeout to prevent deadlocks. |
| Policy limits | Gated by `isPolicyLimitsEligible()`. |

## Edge Cases & Caveats

- **Memoization**: `init()` uses `lodash-es/memoize`, so concurrent callers all receive the same promise. However, errors from `ConfigParseError` are handled internally — subsequent callers will get the cached resolved/rejected promise.

- **Safe vs full env vars**: Environment variables are applied in two phases. `applySafeConfigEnvironmentVariables()` runs before trust; `applyConfigEnvironmentVariables()` only runs after trust is granted (inside `initializeTelemetryAfterTrust`). This prevents leaking sensitive configuration before the user consents.

- **Lazy imports throughout**: Several modules are dynamically imported to keep startup fast:
  - `firstPartyEventLogger` and `growthbook` (OpenTelemetry sdk-logs)
  - `instrumentation.js` (~400KB of OpenTelemetry + protobuf)
  - `upstreamproxy.js` (only in CCR environments)
  - `InvalidConfigDialog` (only on config errors, avoids loading React at init)
  - `teamHelpers.js` (swarm code behind feature gate)

- **CCR upstream proxy fails open**: If the upstream proxy initialization throws, the error is logged and execution continues without proxy support (`src/entrypoints/init.ts:177-182`).

- **Telemetry double-init guard**: The `telemetryInitialized` flag is set before the async work begins and reset on failure. This means concurrent calls during initialization will be no-ops (not queued), but a failed init can be retried.

- **Non-interactive config errors**: In headless/SDK mode, config parse errors write to stderr and call `gracefulShutdownSync(1)` instead of showing an interactive dialog, which would break JSON output consumers.

- **Ordering constraint for network setup**: CA certs → mTLS → proxy agents → preconnect. This order ensures the preconnected socket uses the correct transport configuration.