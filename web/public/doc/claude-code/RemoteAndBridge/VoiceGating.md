# VoiceGating

## Overview & Responsibilities

The VoiceGating module (`src/voice/voiceModeEnabled.ts`) controls whether voice mode is available to a given user at runtime. It sits within the **RemoteAndBridge** group — voice mode streams audio through the `voice_stream` endpoint on claude.ai, making it inherently tied to the remote/bridge infrastructure.

The module exports three progressively stricter gate functions:

| Function | What it checks | Typical callers |
|---|---|---|
| `isVoiceGrowthBookEnabled()` | GrowthBook kill-switch only | Command registration, config UI visibility |
| `hasVoiceAuth()` | Anthropic OAuth token exists | React hook (`useVoiceEnabled`), internal composition |
| `isVoiceModeEnabled()` | Both auth **and** kill-switch | `/voice` command handler, `ConfigTool` runtime guard |

A companion React hook, `useVoiceEnabled()` (`src/hooks/useVoiceEnabled.ts`), wraps these checks for render-safe usage in UI components.

## Key Processes

### Kill-Switch Check — `isVoiceGrowthBookEnabled()`

1. The build-time `feature('VOICE_MODE')` guard is evaluated first. In external builds where the `VOICE_MODE` feature flag is stripped, the function short-circuits to `false` — voice mode is completely absent from the build.
2. If the feature flag is present, the function reads the `tengu_amber_quartz_disabled` flag from GrowthBook's **cached** feature map via `getFeatureValue_CACHED_MAY_BE_STALE()`.
3. The flag uses an inverted polarity: `true` means voice is **disabled** (emergency kill). The function returns `!flagValue`.
4. The default value is `false` (not killed), so fresh installs or stale caches default to voice being **enabled** — no GrowthBook network round-trip required on first launch.

> Source: `src/voice/voiceModeEnabled.ts:16-23`

### Auth Check — `hasVoiceAuth()`

1. Calls `isAnthropicAuthEnabled()` to verify the auth **provider** is Anthropic OAuth (not API keys, Bedrock, Vertex, or Foundry). Returns `false` immediately for non-OAuth providers or bare mode.
2. Calls `getClaudeAIOAuthTokens()` to retrieve the actual OAuth tokens from the system keychain. On macOS, the first call spawns the `security` CLI (~20–50 ms); subsequent calls hit a memoized cache.
3. Returns `true` only if `tokens.accessToken` is truthy. This prevents the voice UI from rendering when the user has the right provider configured but has not logged in yet.

> Source: `src/voice/voiceModeEnabled.ts:32-44`

### Combined Runtime Check — `isVoiceModeEnabled()`

A simple conjunction: `hasVoiceAuth() && isVoiceGrowthBookEnabled()`. This is the "full gate" used at command-execution time.

> Source: `src/voice/voiceModeEnabled.ts:52-54`

### React Hook — `useVoiceEnabled()`

The hook adds a third dimension: **user intent** (`settings.voiceEnabled`).

1. Reads `settings.voiceEnabled` from app state — the user must have opted in.
2. Memoizes `hasVoiceAuth()` keyed on `authVersion` (bumps only on `/login`, not on background token refresh). This avoids repeated synchronous `security` CLI spawns during re-renders.
3. Calls `isVoiceGrowthBookEnabled()` **outside** the memo so a mid-session kill-switch flip takes effect on the next render (it's a cheap cached-map lookup).
4. Returns `userIntent && authed && isVoiceGrowthBookEnabled()`.

> Source: `src/hooks/useVoiceEnabled.ts:19-25`

## Function Signatures

### `isVoiceGrowthBookEnabled(): boolean`

Returns `true` unless the emergency kill-switch (`tengu_amber_quartz_disabled`) is active. Safe for hot paths — reads from a cached in-memory map, no I/O.

### `hasVoiceAuth(): boolean`

Returns `true` when the user has a valid Anthropic OAuth access token. First call may incur ~20–50 ms keychain read on macOS; subsequent calls are cache hits until the memoize clears on token refresh (~once/hour).

### `isVoiceModeEnabled(): boolean`

Returns `hasVoiceAuth() && isVoiceGrowthBookEnabled()`. Use this at command-execution time where a fresh keychain read is acceptable.

### `useVoiceEnabled(): boolean` (React hook)

Render-safe version that also checks `settings.voiceEnabled` (user opt-in). Memoizes the auth check on `authVersion` to avoid keychain reads on every render.

## How Callers Use the Gates

**`/voice` command registration** (`src/commands/voice/index.ts:12-14`):
- `isEnabled` uses `isVoiceGrowthBookEnabled()` — the command is registered but disabled when the kill-switch is on.
- `isHidden` uses `!isVoiceModeEnabled()` — the command is invisible when either auth or kill-switch fails.

**`/voice` command handler** (`src/commands/voice/voice.ts:18`): Calls `isVoiceModeEnabled()` before toggling voice mode. If it fails, it differentiates between missing OAuth (shows auth hint) and kill-switch (command shouldn't be reachable).

**ConfigTool** (`src/tools/ConfigTool/ConfigTool.ts:117-120, 237-240`): Gates the `voiceEnabled` setting twice — once at the prompt level (hides the setting from the settings list) and once at write time (rejects `voiceEnabled = true` if auth is missing).

**UI components** (`VoiceModeNotice`, `PromptInputFooterLeftSide`, `Notifications`): Use `useVoiceEnabled()` to conditionally render voice-related UI elements.

## Configuration & Defaults

| Item | Type | Default | Description |
|---|---|---|---|
| `tengu_amber_quartz_disabled` | GrowthBook flag | `false` | Emergency kill-switch. `true` disables voice globally. |
| `VOICE_MODE` | Build-time feature flag | present in internal builds | Gates all voice code at the bundle level. |
| `settings.voiceEnabled` | User setting (boolean) | `undefined` / `false` | User opt-in for voice mode, checked by the React hook only. |

## Edge Cases & Caveats

- **Stale cache is permissive**: `getFeatureValue_CACHED_MAY_BE_STALE` with default `false` means a stale or missing GrowthBook cache reads as "not killed." This is intentional — fresh installs get voice immediately without waiting for GrowthBook initialization.
- **External builds strip voice entirely**: The `feature('VOICE_MODE')` guard causes the bundler to eliminate voice code from external builds. The "positive ternary" pattern (line 20-22) is deliberate — a negative pattern (`if (!feature(...))`) would leave inline string literals in the output.
- **OAuth-only**: Voice mode requires Anthropic OAuth tokens specifically. API keys, Bedrock, Vertex, and Foundry credentials are not sufficient because voice streams through the `voice_stream` endpoint on claude.ai.
- **Keychain cost**: `hasVoiceAuth()` triggers a synchronous `security` CLI spawn on macOS (~20–50 ms) on the first call after token refresh. The React hook memoizes this to avoid repeated spawns during renders.
- **`authVersion` vs token refresh**: The `useVoiceEnabled` hook's memo key (`authVersion`) bumps only on explicit `/login`, not on background token refresh. This is correct because a background refresh means the user is still authenticated — the auth result doesn't change.