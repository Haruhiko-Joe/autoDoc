# Async Patterns

## Overview & Responsibilities

The Async Patterns module is a collection of concurrency primitives and async utilities that form part of the **CoreUtilities** layer within **Infrastructure**. These are foundational building blocks used throughout the codebase to manage timing, caching, serialization, cancellation, file locking, queue processing, and async message passing. Sibling modules in CoreUtilities cover areas like telemetry, file/path utilities, and data format handling — this module focuses specifically on async control flow and concurrency.

The module comprises nine files, each exporting a focused primitive:

| File | Primary Export | Purpose |
|------|---------------|---------|
| `sleep.ts` | `sleep`, `withTimeout` | Abort-aware delays and timeout racing |
| `memoize.ts` | `memoizeWithTTL`, `memoizeWithTTLAsync`, `memoizeWithLRU` | Caching with TTL and LRU eviction |
| `sequential.ts` | `sequential` | Serialize concurrent async calls |
| `lockfile.ts` | `lock`, `unlock`, `check`, `lockSync` | Lazy-loaded file locking |
| `queueProcessor.ts` | `processQueueIfReady`, `hasQueuedCommands` | REPL command queue draining |
| `combinedAbortSignal.ts` | `createCombinedAbortSignal` | Compose multiple abort signals + timeout |
| `abortController.ts` | `createAbortController`, `createChildAbortController` | Enhanced AbortController with listener limits and parent-child hierarchy |
| `withResolvers.ts` | `withResolvers` | `Promise.withResolvers()` polyfill for Node < 22 |
| `mailbox.ts` | `Mailbox` | Actor-style async message passing |

## Key Processes

### Sleep with Abort Support

`sleep()` creates a promise that resolves after a delay, but can be interrupted by an `AbortSignal`. This is critical for retry/backoff loops that must not block process shutdown.

The flow:
1. If the signal is already aborted, resolve or reject immediately (avoids setting up a timer at all)
2. Start a `setTimeout` for `ms` milliseconds
3. Attach a one-shot `abort` listener to the signal
4. Whichever fires first (timer or abort) cleans up the other

By default, abort **resolves** silently — the caller checks `signal.aborted` after the await. Pass `throwOnAbort: true` or a custom `abortError` factory to make abort reject instead, which is useful when the sleep is deep inside a retry loop and the rejection should bubble up.

`withTimeout()` races an arbitrary promise against a deadline. The timeout timer is `unref`'d so it doesn't prevent process exit.

> Source: `src/utils/sleep.ts:14-54` (sleep), `src/utils/sleep.ts:70-84` (withTimeout)

### Memoization (Sync, Async, LRU)

Three memoization strategies are provided, all keyed by JSON-serialized arguments:

**`memoizeWithTTL` (sync)** — Write-through cache with stale-while-revalidate semantics:
1. Cache miss → compute synchronously, store, and return
2. Cache hit within TTL → return immediately
3. Cache hit past TTL → return stale value, schedule a background refresh via microtask
4. The `refreshing` flag prevents multiple concurrent refreshes for the same key
5. Identity guards protect against race conditions where `cache.clear()` is called during a refresh

**`memoizeWithTTLAsync` (async)** — Same write-through pattern for async functions, with an additional **in-flight deduplication** map. Without it, N concurrent cold-miss callers would each invoke `f()` independently (e.g., spawning N `aws sso login` processes). The `inFlight` map ensures only one invocation per key while the first call is pending.

**`memoizeWithLRU`** — Bounded-size cache using `lru-cache`. Designed to prevent unbounded memory growth (the codebase notes 300MB+ memory with unbounded lodash memoize). Exposes richer cache management: `size()`, `delete()`, `get()` (via `peek()` to avoid promoting recency), and `has()`.

> Source: `src/utils/memoize.ts:40-107` (TTL sync), `src/utils/memoize.ts:120-220` (TTL async), `src/utils/memoize.ts:234-269` (LRU)

### Sequential Execution Guard

`sequential()` wraps an async function so concurrent calls execute one at a time in FIFO order:

1. Each call pushes `{ args, resolve, reject }` onto an internal queue
2. If no processing loop is running, `processQueue()` starts draining
3. The loop pops items one by one, awaits the original function, and resolves/rejects the caller's promise
4. After the loop completes, it checks if new items arrived during processing

This preserves `this` context and return values. Useful for file writes or database updates that would conflict if overlapped.

> Source: `src/utils/sequential.ts:19-56`

### Abort Controller Hierarchy

**`createAbortController()`** wraps the standard `AbortController` constructor and calls `setMaxListeners(50)` on the signal, preventing `MaxListenersExceededWarning` when many consumers attach abort handlers.

**`createChildAbortController(parent)`** creates a parent→child abort propagation chain:
1. If the parent is already aborted, the child is immediately aborted (fast path)
2. Otherwise, a `WeakRef`-based handler is attached to the parent's signal
3. When the parent aborts, the handler dereferences the child and aborts it
4. When the child aborts (from any source), a cleanup handler removes the parent listener

The `WeakRef` design is critical for memory safety: abandoned children (dropped without aborting) can be garbage collected even while the parent is still alive. Without this, long-lived parent controllers (like a session-scoped one) would retain every child ever created.

> Source: `src/utils/abortController.ts:16-99`

### Combined Abort Signal

`createCombinedAbortSignal()` composes up to two abort signals and an optional timeout into a single derived signal:

1. If either input signal is already aborted, abort immediately
2. Otherwise, attach `abort` listeners to both signals and optionally start a `setTimeout`
3. Any trigger aborts the combined controller and clears the timer
4. Returns a `cleanup()` function that removes all listeners and clears the timer

The timeout is implemented via `setTimeout`/`clearTimeout` rather than `AbortSignal.timeout()` because under Bun, `AbortSignal.timeout` timers accumulate in native memory (~2.4KB/call) until they fire.

> Source: `src/utils/combinedAbortSignal.ts:15-47`

### File Locking

The lockfile module is a lazy-loading wrapper around `proper-lockfile`. The underlying package depends on `graceful-fs`, which monkey-patches `fs` methods on first import (~8ms). By deferring the `require()` to the first actual lock/unlock call, this cost is avoided on startup paths like `--help`.

Exports: `lock()`, `lockSync()`, `unlock()`, `check()` — all delegate directly to `proper-lockfile` after the lazy load.

> Source: `src/utils/lockfile.ts:18-43`

### Queue Processor

`processQueueIfReady()` drains the REPL command queue between query turns. It implements differentiated batching:

1. **Slash commands** (`/...`) — processed individually so each goes through the full `executeInput` path
2. **Bash-mode commands** — processed individually for per-command error isolation, exit codes, and progress UI
3. **Other commands** — batched: all items with the same `mode` as the next item are drained at once

A `peek(isMainThread)` filter ensures subagent-addressed messages are skipped, preventing a stall where the main thread sees a subagent notification but can't dequeue it.

> Source: `src/utils/queueProcessor.ts:52-87`

### Promise.withResolvers Polyfill

A one-function polyfill for `Promise.withResolvers()` (ES2024, native in Node 22+). Returns `{ promise, resolve, reject }` so callers can resolve/reject from outside the executor. Necessary because `package.json` declares `"engines": { "node": ">=18.0.0" }`.

> Source: `src/utils/withResolvers.ts:5-13`

### Mailbox (Actor-Style Message Passing)

The `Mailbox` class implements a typed message queue with selective receive, following the actor/mailbox pattern:

- **`send(msg)`** — If a registered waiter matches the message, deliver it directly (bypassing the queue). Otherwise, enqueue it. Increments a `revision` counter and notifies subscribers.
- **`poll(fn)`** — Synchronously scan the queue for the first message matching `fn`. Returns and removes it, or returns `undefined`.
- **`receive(fn)`** — Like `poll`, but if no matching message exists, registers a waiter that will be resolved when a matching message arrives via `send()`.
- **`subscribe`** — Delegates to an internal signal for reactive change notifications.

Messages are typed with `id`, `source` (user/teammate/system/tick/task), `content`, and optional `from`/`color`/`timestamp` fields.

> Source: `src/utils/mailbox.ts:19-73`

## Function Signatures

### `sleep(ms, signal?, opts?): Promise<void>`

| Parameter | Type | Description |
|-----------|------|-------------|
| `ms` | `number` | Delay in milliseconds |
| `signal` | `AbortSignal?` | Optional signal to interrupt the sleep |
| `opts.throwOnAbort` | `boolean?` | Reject on abort instead of resolving |
| `opts.abortError` | `() => Error` | Custom error factory for abort rejection (implies `throwOnAbort`) |
| `opts.unref` | `boolean?` | Call `timer.unref()` so the timer doesn't block process exit |

### `withTimeout<T>(promise, ms, message): Promise<T>`

Races `promise` against a timeout. Rejects with `Error(message)` if the promise doesn't settle within `ms`. Does **not** cancel the underlying work.

### `memoizeWithTTL(f, cacheLifetimeMs?)`

Returns a memoized function with `.cache.clear()`. Default TTL: 5 minutes.

### `memoizeWithTTLAsync(f, cacheLifetimeMs?)`

Async variant with in-flight deduplication. Returns a memoized async function with `.cache.clear()`.

### `memoizeWithLRU(f, cacheFn, maxCacheSize?)`

Returns a memoized function with `.cache` exposing `clear()`, `size()`, `delete(key)`, `get(key)`, `has(key)`. Default max size: 100.

### `sequential(fn): (...args) => Promise<R>`

Wraps `fn` so concurrent calls execute one at a time in order. Preserves `this` context and return values.

### `createAbortController(maxListeners?): AbortController`

Creates an `AbortController` with `setMaxListeners` configured (default: 50).

### `createChildAbortController(parent, maxListeners?): AbortController`

Creates a child controller that aborts when the parent aborts. Uses `WeakRef` for memory safety.

### `createCombinedAbortSignal(signal, opts?): { signal, cleanup }`

| Parameter | Type | Description |
|-----------|------|-------------|
| `signal` | `AbortSignal?` | Primary signal |
| `opts.signalB` | `AbortSignal?` | Secondary signal |
| `opts.timeoutMs` | `number?` | Timeout in ms (clears on cleanup) |

Returns the combined signal and a `cleanup()` function.

### `withResolvers<T>(): { promise, resolve, reject }`

Polyfill for `Promise.withResolvers()`.

### `Mailbox` class

| Method | Signature | Description |
|--------|-----------|-------------|
| `send` | `(msg: Message) => void` | Enqueue or deliver to a waiting receiver |
| `poll` | `(fn?) => Message \| undefined` | Synchronous, non-blocking receive |
| `receive` | `(fn?) => Promise<Message>` | Async receive, waits if no match |
| `subscribe` | signal subscription | Reactive change notifications |
| `length` | getter | Number of queued messages |
| `revision` | getter | Monotonic counter incremented on each `send` |

## Type Definitions

### `Message`

```typescript
type MessageSource = 'user' | 'teammate' | 'system' | 'tick' | 'task'

type Message = {
  id: string
  source: MessageSource
  content: string
  from?: string
  color?: string
  timestamp: string
}
```

### `MemoizedFunction<Args, Result>`

Callable with `.cache.clear()`.

### `LRUMemoizedFunction<Args, Result>`

Callable with `.cache` exposing `clear()`, `size()`, `delete(key)`, `get(key)`, `has(key)`.

## Edge Cases & Caveats

- **sleep TDZ avoidance**: The `sleep` function checks `signal.aborted` before creating the timer. If it checked inside `onAbort` and called it synchronously, `timer` would be in the temporal dead zone. (`src/utils/sleep.ts:20-22`)

- **Memoize identity guards**: Both TTL memoizers use identity guards (`cache.get(key) === cached`) before overwriting on refresh completion. This prevents a stale refresh from overwriting a fresher entry that was stored after a `cache.clear()` + cold miss during the refresh window.

- **Async memoize in-flight dedup**: `memoizeWithTTLAsync` maintains a separate `inFlight` map to prevent N concurrent cold-miss callers from each invoking `f()`. This was specifically designed for cases like `aws sso login` where multiple concurrent invocations would be destructive. `cache.clear()` also clears `inFlight` to ensure invalidation is complete.

- **LRU `.get()` uses `peek()`**: The `get` method on `memoizeWithLRU`'s cache uses `peek()` instead of `get()` on the underlying LRU, intentionally avoiding promoting the entry's recency when observing the cache.

- **Bun memory leak with `AbortSignal.timeout`**: `createCombinedAbortSignal` avoids `AbortSignal.timeout()` because under Bun, those timers accumulate ~2.4KB/call in native memory until they fire. Manual `setTimeout`/`clearTimeout` allows immediate cleanup.

- **WeakRef in child abort controllers**: The parent→child abort propagation uses `WeakRef` so abandoned children don't leak. Both the `propagateAbort` and `removeAbortHandler` functions are module-scoped (not closures) to avoid per-call allocation.

- **Queue processor subagent filtering**: `processQueueIfReady` filters with `isMainThread` on `peek()` to prevent a deadlock where a subagent-addressed notification would cause the main thread to stall permanently.

- **Lockfile lazy loading**: `proper-lockfile` is loaded via `require()` on first use, not at import time, to avoid the ~8ms `graceful-fs` monkey-patching cost on startup paths that don't need locking.

- **`withTimeout` doesn't cancel**: The timeout utility rejects the race but does not abort or cancel the underlying promise. The original async operation continues running.