# Voice

## Overview & Responsibilities

The Voice module is a service within the **Services** layer that provides speech-to-text capabilities for Claude Code's push-to-talk voice input. It spans three files that together handle the full pipeline: capturing audio from the microphone, streaming it to Anthropic's STT service, and improving transcription accuracy with domain-specific vocabulary hints.

The module is composed of three parts:

- **`voice.ts`** — Audio recording orchestrator. Manages microphone capture across macOS, Linux, and Windows using a native NAPI module (cpal) with fallbacks to SoX (`rec`) and ALSA (`arecord`).
- **`voiceKeyterms.ts`** — Key-term dictionary builder. Assembles a list of coding-related terms and session-contextual words (project name, git branch, recent files) to boost STT accuracy.
- **`voiceStreamSTT.ts`** — Streaming STT WebSocket client. Connects to Anthropic's `voice_stream` endpoint, sends binary audio frames, and receives real-time transcript updates.

## Key Processes

### Recording Backend Selection

The module uses a tiered fallback strategy to find a working audio capture backend (`src/services/voice.ts:335-396`):

1. **Native audio (cpal via NAPI)** — Preferred on all platforms. The `audio-capture-napi` module is lazy-loaded on first voice keypress to avoid a startup freeze (dlopen can take 1–8 seconds). On Linux, native recording is skipped if `/proc/asound/cards` reports no ALSA sound cards.
2. **arecord (ALSA utils)** — Linux-only fallback. Before using it, the module runs a probe (`probeArecord()`) that spawns `arecord` for 150ms to verify it can actually open a capture device. This catches WSL1/headless environments where the binary exists but no audio device is available.
3. **SoX (`rec`)** — Final fallback on Linux and macOS. Supports built-in silence detection via SoX's `silence` filter.

```
Native (cpal) → arecord (Linux only, probe-verified) → SoX rec
```

The `checkRecordingAvailability()` function walks the same chain and returns a human-readable `reason` when no backend works, including platform-specific guidance for WSL environments.

### Audio Capture Flow

1. `startRecording(onData, onEnd, options)` is called with a data callback and an end callback
2. The selected backend streams raw PCM audio (16 kHz, 16-bit signed, mono) via the `onData` callback
3. Recording ends either by silence detection (if enabled) calling `onEnd`, or by the caller invoking `stopRecording()`
4. All backends output the same PCM format, so the downstream STT client is backend-agnostic

### Key-Term Assembly

`getVoiceKeyterms()` (`src/services/voiceKeyterms.ts:63-106`) builds a list of up to 50 terms from three sources:

1. **Global terms** — A hardcoded list of coding vocabulary that Deepgram commonly mis-transcribes (e.g., `MCP`, `gRPC`, `symlink`, `OAuth`)
2. **Session context** — The project root's basename and words extracted from the current git branch name (e.g., `feat/voice-keyterms` yields `feat`, `voice`, `keyterms`)
3. **Recent files** — Words extracted from filenames of recently accessed files, filling remaining slots up to the cap

Identifiers are split on camelCase, kebab-case, snake_case, and path separators via `splitIdentifier()`, discarding fragments of 2 characters or fewer.

### STT WebSocket Protocol

`connectVoiceStream()` (`src/services/voiceStreamSTT.ts:111-544`) establishes a WebSocket connection to Anthropic's `voice_stream` endpoint:

1. **Authentication** — Refreshes the OAuth token, then connects using `Bearer` auth with the same credentials as Claude Code
2. **Connection setup** — Sends query parameters for audio format (`linear16`, 16 kHz, mono), endpointing thresholds, language, and keyterms. An initial `KeepAlive` message is sent immediately upon connection
3. **Audio streaming** — Binary audio chunks are sent as WebSocket frames. Buffers are copied before sending to avoid stale NAPI memory references
4. **Transcript reception** — The server sends `TranscriptText` (interim results) and `TranscriptEndpoint` (utterance boundary) messages. The client detects when the server moves to a new speech segment by checking if new text is a prefix of old text; if not, it auto-finalizes the previous segment
5. **Finalization** — When recording stops, `finalize()` sends a `CloseStream` message (deferred by one event-loop tick to flush queued audio callbacks) and waits for the server's final transcript via one of four resolution paths:
   - `post_closestream_endpoint` — `TranscriptEndpoint` arrives after `CloseStream` (~300ms, ideal)
   - `no_data_timeout` — No transcript data received within 1.5s (silent recording)
   - `ws_close` — WebSocket closes (~3-5s server teardown)
   - `safety_timeout` — Hard cap at 5s if WebSocket hangs
6. **Keepalive** — Periodic `KeepAlive` JSON messages every 8 seconds prevent idle disconnection

## Function Signatures

### voice.ts — Recording

#### `startRecording(onData, onEnd, options?): Promise<boolean>`

Starts audio capture using the best available backend.

| Parameter | Type | Description |
|-----------|------|-------------|
| `onData` | `(chunk: Buffer) => void` | Called with raw PCM audio chunks |
| `onEnd` | `() => void` | Called when recording ends (silence detection or backend exit) |
| `options.silenceDetection` | `boolean` | Enable auto-stop on silence (default: `true`). Set `false` for push-to-talk. |

Returns `true` if recording started successfully, `false` if no backend is available.

> Source: `src/services/voice.ts:335-396`

#### `stopRecording(): void`

Stops the active recording. Calls `stopNativeRecording()` for the native backend, or sends `SIGTERM` to the subprocess backend.

> Source: `src/services/voice.ts:515-525`

#### `checkRecordingAvailability(): Promise<RecordingAvailability>`

Probes for a working audio backend. Returns `{ available: boolean, reason: string | null }`. Blocks in remote/headless environments with a descriptive message.

> Source: `src/services/voice.ts:259-328`

#### `requestMicrophonePermission(): Promise<boolean>`

Triggers the macOS TCC permission dialog by performing a brief probe recording. Returns `true` if the microphone is accessible.

> Source: `src/services/voice.ts:241-257`

#### `checkVoiceDependencies(): Promise<{ available, missing, installCommand }>`

Checks whether the required audio capture tools are installed. Returns an install command string for the detected package manager (brew, apt-get, dnf, pacman) if SoX is missing.

> Source: `src/services/voice.ts:190-227`

### voiceKeyterms.ts

#### `getVoiceKeyterms(recentFiles?): Promise<string[]>`

Returns up to 50 key terms for the STT endpoint. Combines global coding terms, project/branch context, and recent file names.

| Parameter | Type | Description |
|-----------|------|-------------|
| `recentFiles` | `ReadonlySet<string>` | Optional set of recently accessed file paths |

> Source: `src/services/voiceKeyterms.ts:63-106`

#### `splitIdentifier(name: string): string[]`

Splits a camelCase/kebab-case/snake_case/path identifier into individual words, filtering out fragments <= 2 chars or > 20 chars.

> Source: `src/services/voiceKeyterms.ts:40-46`

### voiceStreamSTT.ts

#### `connectVoiceStream(callbacks, options?): Promise<VoiceStreamConnection | null>`

Opens a WebSocket connection to the voice_stream STT endpoint. Returns a `VoiceStreamConnection` handle, or `null` if OAuth tokens are unavailable.

| Parameter | Type | Description |
|-----------|------|-------------|
| `callbacks.onTranscript` | `(text: string, isFinal: boolean) => void` | Receives interim and final transcript text |
| `callbacks.onError` | `(error: string, opts?) => void` | Error handler. `opts.fatal` indicates non-retryable errors (4xx) |
| `callbacks.onClose` | `() => void` | Called when the WebSocket closes |
| `callbacks.onReady` | `(connection) => void` | Called when the connection is open and ready for audio |
| `options.language` | `string` | Language code (default: `"en"`) |
| `options.keyterms` | `string[]` | Vocabulary hints forwarded to the STT service |

> Source: `src/services/voiceStreamSTT.ts:111-544`

#### `isVoiceStreamAvailable(): boolean`

Returns `true` if the user has valid Anthropic OAuth tokens (required for the voice_stream endpoint).

> Source: `src/services/voiceStreamSTT.ts:98-107`

## Type Definitions

### `VoiceStreamConnection`

The handle returned by `connectVoiceStream()`:

| Method | Signature | Description |
|--------|-----------|-------------|
| `send` | `(audioChunk: Buffer) => void` | Send a binary audio frame |
| `finalize` | `() => Promise<FinalizeSource>` | Signal end of audio, wait for final transcript |
| `close` | `() => void` | Immediately close the WebSocket |
| `isConnected` | `() => boolean` | Whether the WebSocket is open |

### `FinalizeSource`

Indicates how `finalize()` resolved: `"post_closestream_endpoint"` | `"no_data_timeout"` | `"safety_timeout"` | `"ws_close"` | `"ws_already_closed"`

### `RecordingAvailability`

`{ available: boolean, reason: string | null }` — result of `checkRecordingAvailability()`.

### `VoiceStreamCallbacks`

Callback interface for `connectVoiceStream()`:

| Field | Type | Description |
|-------|------|-------------|
| `onTranscript` | `(text: string, isFinal: boolean) => void` | Interim and final transcript delivery |
| `onError` | `(error: string, opts?: { fatal?: boolean }) => void` | Error notifications |
| `onClose` | `() => void` | Connection closed |
| `onReady` | `(connection: VoiceStreamConnection) => void` | Connection ready for audio |

### Wire Protocol Messages

| Type | Direction | Fields | Description |
|------|-----------|--------|-------------|
| `KeepAlive` | Client → Server | — | Prevents idle timeout |
| `CloseStream` | Client → Server | — | Signals end of audio input |
| `TranscriptText` | Server → Client | `data: string` | Interim or progressive transcript text |
| `TranscriptEndpoint` | Server → Client | — | Marks the end of an utterance |
| `TranscriptError` | Server → Client | `error_code?`, `description?` | Transcription error |

## Configuration & Defaults

| Constant / Env Var | Value | Description |
|--------------------|-------|-------------|
| `RECORDING_SAMPLE_RATE` | `16000` | Audio sample rate (Hz) |
| `RECORDING_CHANNELS` | `1` | Mono audio |
| `SILENCE_DURATION_SECS` | `"2.0"` | SoX silence detection: stop after 2s of silence |
| `SILENCE_THRESHOLD` | `"3%"` | SoX silence threshold |
| `KEEPALIVE_INTERVAL_MS` | `8000` | WebSocket keepalive interval |
| `FINALIZE_TIMEOUTS_MS.safety` | `5000` | Hard timeout for finalize resolution |
| `FINALIZE_TIMEOUTS_MS.noData` | `1500` | Timeout when no transcript data arrives post-CloseStream |
| `MAX_KEYTERMS` | `50` | Maximum number of key terms sent to STT |
| `VOICE_STREAM_BASE_URL` | env override | Override the WebSocket endpoint URL |
| `CLAUDE_CODE_REMOTE` | env flag | When truthy, voice mode is disabled (no local mic) |

## Edge Cases & Caveats

- **Lazy native module loading**: The `audio-capture-napi` module is loaded on first use, not at startup. The initial `dlopen` can block for up to 8 seconds on macOS after wake/boot. This is intentional — a startup freeze is worse than a first-press delay.
- **WSL complexity**: WSL1 and Win10 WSL2 have no audio devices. WSL2 with WSLg (Win11) works via PulseAudio RDP pipes, but cpal fails because `/proc/asound/cards` is empty — `arecord` (which uses PulseAudio) works. The probe-based detection handles all these cases.
- **Buffer copying**: Audio buffers from the NAPI module must be copied with `Buffer.from()` before sending over the WebSocket. The NAPI pooled `ArrayBuffer` can be reused, leading to stale data if sent by reference (`src/services/voiceStreamSTT.ts:237`).
- **Deferred CloseStream**: `finalize()` defers the `CloseStream` message by one event-loop tick (`setTimeout(0)`) to let queued native audio callbacks flush first (`src/services/voiceStreamSTT.ts:297-303`).
- **Nova 3 vs legacy Deepgram**: Nova 3's interims are cumulative and can revise earlier text, so the auto-finalize heuristic (prefix check) is disabled for Nova 3 to avoid transcript duplication (`src/services/voiceStreamSTT.ts:396`).
- **Upgrade rejection handling**: The `unexpected-response` event surfaces HTTP status codes for failed WebSocket upgrades. 4xx errors are flagged as `fatal` (non-retryable). Under Bun, this event may fire spuriously for successful 101 responses (`src/services/voiceStreamSTT.ts:516-520`).
- **Silence detection availability**: Only the native backend and SoX support silence detection. `arecord` does not, making it suited only for push-to-talk mode.
- **Feature gating**: The streaming STT client is only reachable in Anthropic builds, gated by `feature('VOICE_MODE')` in the UI layer. `isVoiceStreamAvailable()` additionally requires valid OAuth tokens.