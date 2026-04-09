# DeepLink

## Overview & Responsibilities

The DeepLink module implements the `claude-cli://` custom URL protocol, enabling Claude Code to be launched from browsers, web pages, or other applications via clickable links. It sits within **Infrastructure → CoreUtilities → DomainHelpers** and operates as a self-contained subsystem with no inbound dependencies from other domain helpers.

The module handles four concerns:

1. **Protocol registration** — Installing OS-level URL scheme handlers (macOS, Linux, Windows)
2. **URL parsing** — Validating and extracting parameters from `claude-cli://open?...` URIs
3. **Terminal detection and launch** — Finding the user's terminal emulator and spawning Claude inside it
4. **Security banner** — Warning users that a session was initiated externally with a pre-filled prompt

The key challenge this module solves: when the OS opens a `claude-cli://` link, it launches the `claude` binary *headlessly* (no TTY). The module must detect an appropriate terminal emulator, open a new window, and run Claude inside it — bridging from a GUI-initiated event to a terminal-based application.

## Key Processes

### End-to-End Deep Link Flow

1. User clicks a `claude-cli://open?q=fix+tests&repo=owner/repo` link in a browser
2. The OS invokes `claude --handle-uri <url>` (registered during a prior session)
3. `handleDeepLinkUri()` parses the URI via `parseDeepLink()` (`src/utils/deepLink/protocolHandler.ts:36-75`)
4. `resolveCwd()` determines the working directory: explicit `cwd` param → repo MRU lookup → `$HOME` (`src/utils/deepLink/protocolHandler.ts:117-136`)
5. If a repo was resolved, `readLastFetchTime()` checks `FETCH_HEAD` mtime for staleness (`src/utils/deepLink/banner.ts:88-102`)
6. `launchInTerminal()` detects the terminal emulator and spawns a new window running `claude --deep-link-origin --prefill <query>` (`src/utils/deepLink/terminalLauncher.ts:214-253`)
7. The launched Claude instance displays the security banner and pre-fills the prompt for user review

### macOS URL Scheme Launch (Apple Events)

On macOS, LaunchServices can invoke the registered `.app` bundle directly rather than passing `--handle-uri`. This path is detected by checking `__CFBundleIdentifier` against the registered bundle ID (`src/utils/deepLink/protocolHandler.ts:84-105`). The native `url-handler-napi` module reads the URL from the Apple Event, then the normal handling flow proceeds.

### Protocol Registration Flow

Registration runs automatically every session via `ensureDeepLinkProtocolRegistered()` as fire-and-forget housekeeping (`src/utils/deepLink/registerProtocol.ts:298-348`):

1. Check if disabled via settings (`disableDeepLinkRegistration`) or feature gate (`tengu_lodestone_enabled`)
2. Resolve the stable `claude` binary path (prefers `~/.local/bin/claude` symlink over `process.execPath`)
3. Read the existing OS artifact to check if it already points to the current binary (`isProtocolHandlerCurrent`)
4. If stale or missing, register per-platform; if registration fails with EACCES/ENOSPC, write a failure marker to back off for 24 hours

### Terminal Detection and Launch

Terminal detection is platform-specific (`src/utils/deepLink/terminalLauncher.ts:64-194`):

- **macOS**: Checks stored preference (from prior interactive session) → `TERM_PROGRAM` env → Spotlight `mdfind` → `/Applications` directory scan → falls back to Terminal.app
- **Linux**: `$TERMINAL` env → `x-terminal-emulator` → walks priority list (ghostty, kitty, alacritty, wezterm, gnome-terminal, konsole, etc.)
- **Windows**: `wt.exe` → `pwsh.exe` → `powershell.exe` → `cmd.exe`

Launch uses two strategies depending on the terminal's capabilities:

- **Pure argv paths** (Ghostty, Kitty, Alacritty, WezTerm on macOS; all Linux terminals; Windows Terminal): Arguments are passed as discrete `argv` elements via `open -na --args` or direct `spawn`. No shell interpretation occurs — spaces, quotes, and metacharacters in user input are preserved by argv boundaries.
- **Shell-string paths** (iTerm2, Terminal.app via AppleScript; PowerShell, cmd.exe): The terminal API requires a shell command string. User input is escaped via `shellQuote()` (POSIX single-quoting), `psQuote()` (PowerShell single-quoting), or `cmdQuote()` (cmd.exe double-quoting with `"` stripping and `%` escaping).

## Function Signatures

### `parseDeepLink(uri: string): DeepLinkAction`

Parses a `claude-cli://open` URI into structured parameters. Throws on malformed URIs or dangerous input.

- **uri**: Raw URI string (e.g., `claude-cli://open?q=hello+world&cwd=/path`)
- **Returns**: `{ query?: string, cwd?: string, repo?: string }`
- Validates: protocol scheme, `open` hostname, absolute `cwd` path, repo slug format (`owner/repo`), control character rejection, length limits (query: 5000 chars, cwd: 4096 chars)
- Sanitizes Unicode via `partiallySanitizeUnicode()` to strip hidden characters

> Source: `src/utils/deepLink/parseDeepLink.ts:84-153`

### `buildDeepLink(action: DeepLinkAction): string`

Constructs a `claude-cli://open` URL from structured parameters.

> Source: `src/utils/deepLink/parseDeepLink.ts:158-170`

### `handleDeepLinkUri(uri: string): Promise<number>`

Entry point for `claude --handle-uri <url>`. Parses the URI, resolves the working directory, and launches Claude in a terminal.

- **Returns**: Exit code (0 = success, 1 = error)

> Source: `src/utils/deepLink/protocolHandler.ts:36-75`

### `handleUrlSchemeLaunch(): Promise<number | null>`

Handles macOS LaunchServices URL scheme invocation. Detects the launch context via `__CFBundleIdentifier`, reads the URL from Apple Events via the `url-handler-napi` NAPI module.

- **Returns**: Exit code, or `null` if this wasn't a URL scheme launch

> Source: `src/utils/deepLink/protocolHandler.ts:84-105`

### `registerProtocolHandler(claudePath?: string): Promise<void>`

Registers the `claude-cli://` scheme with the OS. Platform-dispatched to macOS/Linux/Windows implementations.

> Source: `src/utils/deepLink/registerProtocol.ts:215-233`

### `ensureDeepLinkProtocolRegistered(): Promise<void>`

Auto-registration entry point called from background housekeeping. No-ops if already current, feature-gated off, or within 24h failure backoff.

> Source: `src/utils/deepLink/registerProtocol.ts:298-348`

### `launchInTerminal(claudePath, action): Promise<boolean>`

Detects the terminal and spawns Claude inside it. Returns `false` if no terminal was found or spawn failed.

> Source: `src/utils/deepLink/terminalLauncher.ts:214-253`

### `detectTerminal(): Promise<TerminalInfo | null>`

Returns `{ name, command }` for the detected terminal emulator, or `null` on unsupported platforms.

> Source: `src/utils/deepLink/terminalLauncher.ts:183-194`

### `buildDeepLinkBanner(info: DeepLinkBannerInfo): string`

Constructs the multi-line warning banner shown to the user when a session was opened via deep link.

> Source: `src/utils/deepLink/banner.ts:54-75`

### `updateDeepLinkTerminalPreference(): void`

Captures `TERM_PROGRAM` during interactive sessions and persists the terminal app name to global config. macOS only.

> Source: `src/utils/deepLink/terminalPreference.ts:38-54`

## Type Definitions

### `DeepLinkAction`

| Field | Type | Description |
|-------|------|-------------|
| query | `string?` | Pre-fill prompt text (not auto-submitted) |
| cwd | `string?` | Absolute working directory path |
| repo | `string?` | GitHub `owner/repo` slug, resolved against known local clones |

### `DeepLinkBannerInfo`

| Field | Type | Description |
|-------|------|-------------|
| cwd | `string` | Resolved working directory |
| prefillLength | `number?` | Character count of the pre-filled prompt |
| repo | `string?` | The `?repo=` slug if resolved from MRU |
| lastFetch | `Date?` | `FETCH_HEAD` mtime — `undefined` if never fetched |

### `TerminalInfo`

| Field | Type | Description |
|-------|------|-------------|
| name | `string` | Display name (e.g., "iTerm2", "Windows Terminal") |
| command | `string` | Executable path or macOS app name |

## Configuration

- **`disableDeepLinkRegistration`** (settings): Set to `"disable"` to prevent auto-registration of the protocol handler
- **`tengu_lodestone_enabled`** (feature gate): Server-side gate controlling whether registration runs
- **`deepLinkTerminal`** (global config `~/.claude.json`): Persisted terminal preference from the last interactive macOS session; read by the headless handler where `TERM_PROGRAM` is unavailable
- **`githubRepoPaths`** (global config): MRU mapping of `owner/repo` slugs to local filesystem paths, used to resolve `?repo=` parameters

## Platform-Specific Registration Details

| Platform | Artifact | Mechanism |
|----------|----------|-----------|
| **macOS** | `~/Applications/Claude Code URL Handler.app` | `.app` bundle with `CFBundleURLTypes` in `Info.plist`; executable is a **symlink** to the signed `claude` binary (avoids separate signing). Registered via `lsregister`. |
| **Linux** | `$XDG_DATA_HOME/applications/claude-code-url-handler.desktop` | `.desktop` file with `MimeType=x-scheme-handler/claude-cli;`. Registered via `xdg-mime` (gracefully skipped if absent, e.g. WSL/Docker). |
| **Windows** | `HKCU\Software\Classes\claude-cli` | Registry keys: default value `URL:<name>`, `URL Protocol` empty string, `shell\open\command` pointing to `claude.exe --handle-uri "%1"`. |

The `isProtocolHandlerCurrent()` function reads each artifact directly (symlink target, `.desktop` file content, registry value) to verify it points to the current `claude` binary, enabling self-healing when the install path changes.

## Security Model

Deep links are an external input vector — a malicious page could craft a link with a dangerous prompt. The module implements defense-in-depth:

1. **Input validation** (`parseDeepLink.ts`): ASCII control character rejection, Unicode sanitization (strips homoglyphs/invisible chars), length caps (5000 chars query, 4096 chars cwd), repo slug format enforcement via `REPO_SLUG_PATTERN`
2. **No auto-submission**: The `?q=` parameter only **pre-fills** the prompt input; the user must press Enter to submit
3. **Shell injection prevention** (`terminalLauncher.ts`): Pure argv paths (most terminals) avoid shell interpretation entirely. Shell-string paths use per-shell quoting functions: `shellQuote()` for POSIX, `psQuote()` for PowerShell, `cmdQuote()` for cmd.exe
4. **Security banner** (`banner.ts`): Always displayed for deep-link sessions. Shows the working directory (so the user knows which `CLAUDE.md` loaded). For long prompts (>1000 chars), explicitly warns to "scroll to review the entire prompt"
5. **Git freshness warning**: When `?repo=` resolved a local clone, shows `FETCH_HEAD` age and warns if stale (>7 days), since `CLAUDE.md` may not match upstream

## Edge Cases & Caveats

- **cmd.exe command length limit**: Windows `cmd.exe` has an 8191-character command string limit. With quoting overhead, queries near the 5000-char cap may fail on cmd.exe — but `wt.exe` and PowerShell are tried first, and the failure mode is a launch error, not a security issue
- **macOS fallback chain**: If the preferred terminal fails to launch (e.g., `mdfind` reports it installed but the app was deleted), `launchMacosTerminal` recursively falls back to Terminal.app (`src/utils/deepLink/terminalLauncher.ts:348-357`)
- **Headless context**: The protocol handler runs without a TTY. `TERM_PROGRAM` is unavailable, which is why `updateDeepLinkTerminalPreference()` captures it during interactive sessions for later use
- **Worktree-aware fetch time**: `readLastFetchTime()` checks both the worktree's and the main repo's `FETCH_HEAD`, returning whichever is newer (`src/utils/deepLink/banner.ts:88-102`)
- **Registration failure backoff**: Deterministic failures (EACCES, ENOSPC) are throttled via a marker file in `~/.claude/` to avoid generating failure events every startup
- **Protocol normalization**: `parseDeepLink` accepts both `claude-cli://open` and `claude-cli:open` (missing `//`) for robustness