# NativeInstaller

## Overview & Responsibilities

The NativeInstaller module manages the complete lifecycle of Claude Code's native binary — downloading, installing, versioning, and cleaning up compiled executables. It sits within the **Infrastructure → CoreUtilities → DomainHelpers** layer and is the mechanism by which Claude Code self-updates from a JavaScript/npm-based installation to a platform-specific native binary.

The module replaces the legacy npm-based auto-updater with a system that downloads pre-compiled binaries (or npm packages for internal users), stores them in XDG-compliant directories, and manages a symlink at `~/.local/bin/claude` pointing to the active version. It handles multi-process safety so that concurrent Claude sessions don't corrupt each other's installations.

The module comprises 5 files:
- **`index.ts`** — Public API barrel file
- **`installer.ts`** — Core installation logic (~1100 lines)
- **`download.ts`** — Binary/package download from GCS or Artifactory
- **`pidLock.ts`** — PID-based version locking for multi-process safety
- **`packageManagers.ts`** — Detection of how Claude was installed (Homebrew, winget, pacman, etc.)

## Key Processes

### Installation Flow (`installLatest`)

This is the primary entry point, called by the `NativeAutoUpdater` component.

1. **Singleflight guard** — A module-level `inFlightInstall` promise prevents duplicate concurrent downloads. Remounts of the UI component that triggers updates join the existing in-flight call instead of spawning a new download (`installer.ts:954-974`).

2. **Version resolution** — `getLatestVersion()` determines the target version. It accepts a release channel (`stable`, `latest`) or a direct semver string. Internal users (`USER_TYPE=ant`) query Artifactory via `npm view`; external users hit a GCS bucket (`download.ts:112-149`).

3. **Skip checks** — The system skips the update if:
   - A server-side `maxVersion` cap is set and the current version already meets it (`installer.ts:511-533`)
   - The current version matches the latest AND both the version binary and executable symlink are valid (`installer.ts:538-552`)
   - The version is below a configured `minimumVersion` threshold (`installer.ts:555-562`)

4. **Lock acquisition** — Unless lockless mode is enabled (`ENABLE_LOCKLESS_UPDATES`), the installer acquires a lock on the version file using either PID-based or mtime-based locking with up to 3 retries and exponential backoff (`installer.ts:568-610`).

5. **Download** — `downloadVersion()` routes to the appropriate source:
   - **Internal users**: Creates an isolated npm project in a staging directory, generates `package.json` and `package-lock.json` with integrity hashes, runs `npm ci` against Artifactory (`download.ts:151-269`)
   - **External users**: Fetches a manifest from GCS (`{version}/manifest.json`), downloads the platform-specific binary, verifies its SHA-256 checksum (`download.ts:382-485`)

6. **Install** — The staged binary is atomically moved to `~/.local/share/claude/versions/{version}` via copy-to-temp then rename, avoiding cross-filesystem `EXDEV` errors (`installer.ts:300-326`).

7. **Symlink update** — `~/.local/bin/claude` is atomically updated to point to the new version binary. On Unix, this uses a temp symlink + rename pattern. On Windows, the existing executable is renamed to `.old.{timestamp}` before copying the new one, with rollback on failure (`installer.ts:639-798`).

8. **Post-install** — The global config is updated to set `installMethod: 'native'` and disable the legacy npm auto-updater. Old versions are cleaned up asynchronously.

### Download with Stall Detection

Binary downloads include stall detection: if no data is received for 60 seconds, the download is aborted and retried up to 3 times. Each chunk of data resets the stall timer. Only stall timeouts trigger retries — HTTP errors and checksum mismatches fail immediately (`download.ts:293-380`).

### Version Locking (Multi-Process Safety)

Two locking strategies coexist, controlled by a GrowthBook feature gate (`tengu_pid_based_version_locking`):

**PID-based locking** (new):
- Lock files contain JSON: `{ pid, version, execPath, acquiredAt }` (`pidLock.ts:54-59`)
- Staleness is detected by checking if the PID is still running via `process.kill(pid, 0)` (`pidLock.ts:82-95`)
- PID reuse is mitigated by verifying the process command contains "claude" (`pidLock.ts:101-132`)
- Fallback: locks older than 2 hours are treated as potentially stale (`pidLock.ts:76`)
- Write is atomic: write to `.tmp.{pid}.{timestamp}`, then rename (`pidLock.ts:210-232`)

**mtime-based locking** (legacy, via `proper-lockfile`):
- Uses directory-based locks with a 7-day stale timeout (`installer.ts:79`)
- Chosen to survive laptop sleep (process suspended, heartbeat stops) while still allowing eventual cleanup

The running version is locked for the entire process lifetime via `lockCurrentVersion()`, which registers cleanup handlers on `exit`, `SIGINT`, and `SIGTERM` (`pidLock.ts:299-324`).

### Version Cleanup (`cleanupOldVersions`)

Runs asynchronously after each successful install (`installer.ts:1184-1439`):

1. **Windows old executables** — Deletes `claude.exe.old.{timestamp}` files left from previous updates
2. **Orphaned staging directories** — Removes staging dirs older than 1 hour
3. **Stale PID locks** — Cleans up locks whose processes are no longer running
4. **Orphaned temp files** — Removes `{version}.tmp.{pid}.{timestamp}` files older than 1 hour
5. **Old version binaries** — Keeps the 2 most recent versions (`VERSION_RETENTION_COUNT = 2`) plus any versions that are:
   - Currently being executed (`process.execPath`)
   - Pointed to by the active symlink
   - Locked by another running process

Deletion of old versions itself acquires a lock to prevent deleting a version another process just started using.

### Package Manager Detection

`getPackageManager()` determines how Claude was originally installed, checked in priority order (`packageManagers.ts:302-336`):

| Manager | Detection Method |
|---------|-----------------|
| Homebrew | `execPath` contains `/Caskroom/` |
| winget | `execPath` matches WinGet path patterns |
| mise | `execPath` contains `/mise/installs/` |
| asdf | `execPath` contains `/asdf/installs/` |
| pacman | `pacman -Qo <execPath>` succeeds (Arch family only) |
| apk | `apk info --who-owns <execPath>` succeeds (Alpine only) |
| deb | `dpkg -S <execPath>` succeeds (Debian family only) |
| rpm | `rpm -qf <execPath>` succeeds (Fedora/RHEL/SUSE only) |

Linux package manager detection reads `/etc/os-release` to gate on distro family before invoking commands, avoiding false positives (e.g., the `pacman` game on Ubuntu) (`packageManagers.ts:28-53`).

## Function Signatures

### `installLatest(channelOrVersion: string, forceReinstall?: boolean): Promise<InstallLatestResult>`

Main entry point for installing/updating to the latest version.

- **channelOrVersion**: `'stable'`, `'latest'`, or a semver string like `'1.2.3'`
- **forceReinstall**: When `true`, bypasses singleflight guard and removes existing locks
- Returns `{ latestVersion, wasUpdated, lockFailed?, lockHolderPid? }`

> `installer.ts:956-974`

### `checkInstall(force?: boolean): Promise<SetupMessage[]>`

Validates the native installation health: checks bin directory, executable validity, symlink target, and PATH configuration.

- Returns an array of `SetupMessage` objects with diagnostics and user-action-required flags
- Skips checks for development builds and non-native installations (unless `force` is true)

> `installer.ts:800-940`

### `lockCurrentVersion(): Promise<void>`

Acquires a process-lifetime lock on the currently running version binary to prevent it from being deleted by another process's cleanup.

> `installer.ts:1048-1156`

### `cleanupOldVersions(): Promise<void>`

Removes old version binaries, staging artifacts, temp files, and stale locks. Retains the 2 most recent unprotected versions.

> `installer.ts:1184-1439`

### `cleanupNpmInstallations(): Promise<{ removed, errors, warnings }>`

Removes global npm installations of `@anthropic-ai/claude-code` and the local installation at `~/.claude/local`. Handles `ENOTEMPTY` errors with manual removal fallback.

> `installer.ts:1656-1708`

### `removeInstalledSymlink(): Promise<void>`

Removes the native binary symlink at `~/.local/bin/claude`, but only if it's not an npm-managed symlink (guards against removing npm's global bin link).

> `installer.ts:1465-1486`

### `cleanupShellAliases(): Promise<SetupMessage[]>`

Removes legacy `claude` shell aliases from shell config files (`.bashrc`, `.zshrc`, etc.).

> `installer.ts:1492-1523`

### `getPackageManager(): Promise<PackageManager>`

Detects and returns the package manager that installed Claude. Result is memoized.

> `packageManagers.ts:302-336`

## Type Definitions

### `SetupMessage`

```typescript
type SetupMessage = {
  message: string
  userActionRequired: boolean
  type: 'path' | 'alias' | 'info' | 'error'
}
```

Returned by `checkInstall()` and `cleanupShellAliases()` to communicate installation issues to the UI.

### `PackageManager`

```typescript
type PackageManager =
  | 'homebrew' | 'winget' | 'pacman' | 'deb'
  | 'rpm' | 'apk' | 'mise' | 'asdf' | 'unknown'
```

### `VersionLockContent`

```typescript
type VersionLockContent = {
  pid: number
  version: string
  execPath: string
  acquiredAt: number  // timestamp
}
```

JSON content stored in PID-based lock files (`pidLock.ts:54-59`).

## Configuration & Defaults

| Setting | Source | Default | Description |
|---------|--------|---------|-------------|
| `ENABLE_PID_BASED_VERSION_LOCKING` | env var | GrowthBook gate | Force-enable/disable PID-based locking |
| `ENABLE_LOCKLESS_UPDATES` | env var | `false` | Skip locking during updates, rely on atomic ops |
| `DISABLE_INSTALLATION_CHECKS` | env var | `false` | Skip all `checkInstall` diagnostics |
| `USER_TYPE` | env var | - | When `'ant'`, routes downloads through Artifactory |
| `VERSION_RETENTION_COUNT` | constant | `2` | Number of old versions to keep after cleanup |
| Lock stale timeout (mtime) | constant | 7 days | How long before mtime-based locks are considered stale |
| Lock stale timeout (PID fallback) | constant | 2 hours | Fallback timeout when PID check is inconclusive |
| Download stall timeout | constant | 60 seconds | Abort download if no data received for this duration |
| Max download retries | constant | 3 | Number of retry attempts on stall timeouts |

### Directory Layout (XDG-compliant)

```
~/.local/share/claude/versions/   # Installed version binaries (e.g., "1.2.3")
~/.cache/claude/staging/          # Temporary download staging areas
~/.local/state/claude/locks/      # Lock files ("{version}.lock")
~/.local/bin/claude               # Symlink to active version
```

## Edge Cases & Caveats

- **Windows uses file copy instead of symlinks** — The executable is copied rather than symlinked. Updates rename the old `.exe` to `.old.{timestamp}` before copying, with rollback on failure. Old renamed executables are cleaned up at next startup (`installer.ts:647-722`).

- **Cross-filesystem installs** — `atomicMoveToInstallPath` uses copy+rename instead of direct rename to avoid `EXDEV` errors when staging and install directories are on different filesystems (`installer.ts:300-326`).

- **Singleflight prevents download storms** — UI remounts can trigger multiple `installLatest` calls. A module-level promise guard ensures only one download runs at a time; subsequent calls join the in-flight promise. This was added after a session accumulated 91GB of arraybuffers from concurrent downloads (`installer.ts:949-974`).

- **PID reuse mitigation** — After confirming a PID is alive, the locking system checks if the process command contains "claude" to guard against PID reuse by unrelated processes. If the command can't be read, it conservatively assumes the lock is valid (`pidLock.ts:101-132`).

- **npm-managed symlink protection** — `removeInstalledSymlink` checks if the symlink target ends with `.js` or contains `node_modules` before removing, to avoid breaking npm global installations (`installer.ts:1446-1458`).

- **Distro-gated package manager detection** — Linux package manager probes are gated on the distro family via `/etc/os-release` to avoid false positives (e.g., the `pacman` arcade game binary on Debian) (`packageManagers.ts:167-192`).

- **Lock compromise handling** — When using mtime-based locks, `onCompromised` callbacks log but don't crash, handling cases where another process deletes the lock directory mid-operation (`installer.ts:265-270`).

- **Test versions are DCE'd** — Version strings matching `99.99.x` are blocked in shipped builds. The `feature('ALLOW_TEST_VERSIONS')` guard is eliminated by dead-code elimination so the test-only GCS bucket URL never appears in production binaries (`download.ts:122-129`).