# Build Tooling

## Overview & Responsibilities

Build Tooling is the build infrastructure and vendored native module layer within the **Infrastructure** module of Claude Code. It serves two primary purposes:

1. **Build pipeline**: A set of scripts that transform the Bun-native source code into a Node.js-compatible esbuild bundle (`dist/cli.js`). This involves replacing Bun compile-time intrinsics (`feature()`, `MACRO.*`, `bun:bundle` imports) with runtime equivalents and auto-generating stubs for missing feature-gated modules.

2. **Native NAPI modules**: TypeScript wrappers around platform-specific `.node` binaries for audio capture, image processing, keyboard modifier detection, and macOS URL event handling.

Additionally, `stubs/` provides compile-time type declarations and runtime shims, `utils/` contains auto-generated JS helper stubs, and `types/` holds generated type stubs.

## Key Processes

### Build Pipeline (`scripts/build.mjs`)

The main build script executes in four phases:

1. **Phase 1 — Copy source**: Cleans `build-src/`, copies `src/` into it as a working directory so the original source remains untouched (`scripts/build.mjs:56-59`).

2. **Phase 2 — Transform source**: Walks all `.ts`/`.tsx`/`.js`/`.jsx` files and applies three transformations:
   - **Feature-gate elimination**: Replaces all `feature('X')` calls with the literal `false`, effectively dead-code-eliminating all feature-gated paths (`scripts/build.mjs:87-90`).
   - **MACRO resolution**: Replaces compile-time `MACRO.VERSION`, `MACRO.FEEDBACK_CHANNEL`, etc. with string literals (`scripts/build.mjs:93-98`).
   - **`bun:bundle` import removal**: Strips `import { feature } from 'bun:bundle'` since `feature()` has already been inlined (`scripts/build.mjs:101-104`).

3. **Phase 3 — Entry wrapper**: Creates `build-src/entry.ts` that imports the real entrypoint (`src/entrypoints/cli.tsx`) (`scripts/build.mjs:123-128`).

4. **Phase 4 — Iterative stub + bundle**: Runs esbuild up to 5 rounds. On each failure, it parses `Could not resolve "X"` errors from esbuild output, generates stub files for missing modules (empty files for `.txt`/`.md`/`.json`, export-bearing stubs for `.ts`/`.js`), and retries (`scripts/build.mjs:140-229`). The final bundle is written to `dist/cli.js` as an ESM Node.js 18+ target with sourcemaps.

### Alternative Build Path (`scripts/transform.mjs`)

A variant build script that takes a slightly different approach: instead of inlining `feature()` as `false`, it rewrites `bun:bundle` imports to point at `stubs/bun-bundle.ts` (preserving the function call) and injects MACRO values as a `globalThis.MACRO` object in the entry wrapper rather than doing text replacement (`scripts/transform.mjs:73-93`).

### Standalone Stub Generator (`scripts/stub-modules.mjs`)

A dedicated script that runs a single esbuild pass, collects all missing module errors, resolves each relative import back to its absolute path by `grep`-ing the build-src tree for importers, and creates stubs at the correct locations. It handles relative imports (e.g., `../foo.ts`) by searching from multiple likely prefixes (`src/commands`, `src/components`, `src/services`, etc.) (`scripts/stub-modules.mjs:48-121`).

### Source Preparation (`scripts/prepare-src.mjs`)

An in-place source patcher (modifies `src/` directly, unlike `build.mjs` which copies first). Rewrites `bun:bundle` imports to point at the stub with correct relative depth calculation (`scripts/prepare-src.mjs:41-51`), replaces MACRO references with careful regex that avoids matching inside strings (`scripts/prepare-src.mjs:54-69`), and creates the `bun:ffi` stub and global MACRO type declaration (`scripts/prepare-src.mjs:93-113`).

### Native Module Loading Pattern

All four vendor modules follow the same lazy-loading pattern:

1. Cache the loaded module in a file-scoped variable
2. Check platform compatibility (most are macOS-only)
3. Try environment variable path first (bundled/native-embed mode, e.g., `AUDIO_CAPTURE_NODE_PATH`)
4. Fall back to dev-mode paths resolving relative to the source file
5. Return `null` gracefully on failure — callers always guard

## Function Signatures & Parameters

### `stubs/bun-bundle.ts`

#### `feature(flag: string): boolean`
Stub replacement for Bun's compile-time `feature()` intrinsic. Always returns `false`, disabling all feature-gated code paths.

### `vendor/audio-capture-src/index.ts`

| Function | Signature | Description |
|----------|-----------|-------------|
| `isNativeAudioAvailable` | `(): boolean` | Whether the native audio module loaded successfully |
| `startNativeRecording` | `(onData: (data: Buffer) => void, onEnd: () => void): boolean` | Begin audio capture; streams PCM data via callback |
| `stopNativeRecording` | `(): void` | Stop an active recording |
| `isNativeRecordingActive` | `(): boolean` | Check if currently recording |
| `startNativePlayback` | `(sampleRate: number, channels: number): boolean` | Begin audio playback with given format |
| `writeNativePlaybackData` | `(data: Buffer): void` | Write PCM data to the playback stream |
| `stopNativePlayback` | `(): void` | Stop active playback |
| `isNativePlaying` | `(): boolean` | Check if currently playing |
| `microphoneAuthorizationStatus` | `(): number` | Returns TCC status: 0=notDetermined, 1=restricted, 2=denied, 3=authorized. Cross-platform. |

> Supported platforms: macOS, Linux, Windows (`vendor/audio-capture-src/index.ts:31-33`)

### `vendor/image-processor-src/index.ts`

| Function | Signature | Description |
|----------|-----------|-------------|
| `getNativeModule` | `(): NativeModule \| null` | Returns the raw NAPI binding (includes optional clipboard functions) |
| `sharp` | `(input: Buffer): SharpInstance` | Factory function matching sharp's chainable API for image processing |

The `SharpInstance` interface supports: `metadata()`, `resize()`, `jpeg()`, `png()`, `webp()`, `toBuffer()` — all chainable except `metadata()` and `toBuffer()` which are async terminal operations (`vendor/image-processor-src/index.ts:111-158`).

### `vendor/modifiers-napi-src/index.ts`

| Function | Signature | Description |
|----------|-----------|-------------|
| `getModifiers` | `(): string[]` | Returns list of currently pressed modifier keys |
| `isModifierPressed` | `(modifier: string): boolean` | Checks if a specific modifier key is pressed |
| `prewarm` | `(): void` | Pre-loads the native module to avoid first-use latency |

> macOS only (`vendor/modifiers-napi-src/index.ts:18-19`)

### `vendor/url-handler-src/index.ts`

#### `waitForUrlEvent(timeoutMs: number): string | null`
Initializes NSApplication, registers for `kAEGetURL` Apple Events, and pumps the event loop for up to `timeoutMs` milliseconds. Returns the URL string if received, `null` otherwise. macOS only (`vendor/url-handler-src/index.ts:52-58`).

## Interface / Type Definitions

### `MACRO` (global)
Compile-time constants normally injected by Bun's bundler. Declared in `stubs/global.d.ts` and `stubs/macros.d.ts`:

| Field | Type | Purpose |
|-------|------|---------|
| `VERSION` | `string` | Application version (e.g., `'2.1.88'`) |
| `BUILD_TIME` | `string` | ISO timestamp of build |
| `FEEDBACK_CHANNEL` | `string` | URL for user feedback |
| `ISSUES_EXPLAINER` | `string` | URL for issue reporting |
| `NATIVE_PACKAGE_URL` | `string \| null` | npm package name |
| `PACKAGE_URL` | `string` | npm package name |
| `VERSION_CHANGELOG` | `string` | Changelog content |

### `ClipboardImageResult` (`vendor/image-processor-src/index.ts:1-7`)

```typescript
{
  png: Buffer
  originalWidth: number
  originalHeight: number
  width: number
  height: number
}
```

### `AudioCaptureNapi` (`vendor/audio-capture-src/index.ts:2-19`)
Internal type for the native audio module binding. Includes recording, playback, and microphone authorization methods.

## Configuration & Defaults

### Build Configuration
- **Target**: Node.js 18+ (`--target=node18`)
- **Format**: ESM (`--format=esm`)
- **Output**: `dist/cli.js` with sourcemaps
- **External**: All `node:*` and `bun:*` modules, plus all npm packages (`--packages=external`)
- **Max stub rounds**: 5 iterations before declaring build failure

### Native Module Environment Variables

| Variable | Module | Purpose |
|----------|--------|---------|
| `AUDIO_CAPTURE_NODE_PATH` | audio-capture | Path to bundled `.node` binary |
| `MODIFIERS_NODE_PATH` | modifiers-napi | Path to bundled `.node` binary |
| `URL_HANDLER_NODE_PATH` | url-handler | Path to bundled `.node` binary |

### Native Module Resolution Order
1. Environment variable path (bundled/native-embed mode)
2. `./vendor/<module>/<arch>-<platform>/<module>.node` (npm-install layout)
3. `../<module>/<arch>-<platform>/<module>.node` (dev/source layout)

## Edge Cases & Caveats

- **Incomplete build**: The build scripts explicitly acknowledge that a full rebuild requires the Bun runtime. The esbuild-based build is a "best-effort" alternative that may not produce a fully functional binary — feature-gated code paths are all disabled (`scripts/build.mjs:3-7`).

- **`prepare-src.mjs` modifies source in-place**: Unlike `build.mjs` which copies to `build-src/` first, `prepare-src.mjs` patches `src/` directly. Running it is destructive to the working tree.

- **MACRO regex in `prepare-src.mjs` vs `build.mjs`**: The two scripts use different replacement strategies. `prepare-src.mjs` uses a careful regex with negative lookbehind/ahead to avoid replacing inside strings (`scripts/prepare-src.mjs:67`), while `build.mjs` uses simple `replaceAll` (`scripts/build.mjs:95`).

- **Image processor lazy loading**: The `sharp()` wrapper defers `dlopen` until `toBuffer()` or `metadata()` is called. This is deliberate — resolving CoreGraphics/ImageIO at module-eval time would block startup (`vendor/image-processor-src/index.ts:23-25`).

- **Audio capture `loadAttempted` flag**: Unlike other vendor modules that use a simple null-check cache, audio-capture tracks a separate `loadAttempted` boolean to distinguish "never tried" from "tried and failed" (`vendor/audio-capture-src/index.ts:22`).

- **Platform restrictions**: `modifiers-napi` and `url-handler` are macOS-only. `audio-capture` supports macOS, Linux, and Windows. `image-processor` loads from a fixed relative path without platform checks.

- **Auto-generated stubs in `utils/` and `types/`**: Files like `utils/attributionHooks.js`, `utils/udsClient.js`, `utils/systemThemeWatcher.js`, and `types/connectorText.js` are auto-generated stubs with dual exports (default function + named const). These are placeholders for modules that exist in the full Bun build but are not available in the source distribution.