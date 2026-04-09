# Secret Scanning

## Overview & Responsibilities

The Secret Scanning module is a **client-side credential detection layer** within the TeamMemorySync subsystem of the MemorySystem. Its purpose is to prevent secrets — API keys, tokens, private keys — from ever leaving the user's machine when team memory files are synchronized to the server.

The module consists of two files:
- **`secretScanner.ts`** — the detection engine: ~30 curated regex rules that identify credentials across major cloud, AI, VCS, and SaaS providers
- **`teamMemSecretGuard.ts`** — the integration guard: a thin validation hook called by `FileWriteTool` and `FileEditTool` to block secret-containing writes to team memory paths

Within the broader architecture, this module sits between the tool-level write operations and the team memory sync protocol. It acts as a **local firewall**: content is scanned before it touches shared storage, so compromised credentials are caught at the earliest possible point.

## Key Processes

### Secret Detection Flow (`scanForSecrets`)

1. On first invocation, the `SECRET_RULES` array (static rule definitions with regex source strings) is lazily compiled into `RegExp` objects and cached in the module-level `compiledRules` variable (`secretScanner.ts:229-237`)
2. Each compiled rule is tested against the input string via `RegExp.test()`
3. Matches are deduplicated by rule ID using a `Set<string>` — only one match per rule is reported regardless of how many occurrences exist
4. The matched text is **intentionally not returned** — only the `ruleId` and a human-readable `label` are exposed, preventing accidental logging of secret values

### Redaction Flow (`redactSecrets`)

1. A separate lazily-compiled regex cache (`redactRules`) is built with the global (`g`) flag added to every rule (`secretScanner.ts:313-315`)
2. Each rule is applied via `String.replace()` with a callback that replaces **only the captured group** (group 1), not the full match — this preserves boundary characters (quotes, whitespace, semicolons) that many patterns include outside the capture group (`secretScanner.ts:319-321`)
3. If no capture group exists, the entire match is replaced with `[REDACTED]`

### Tool-Level Guard Flow (`checkTeamMemSecrets`)

1. `FileWriteTool` or `FileEditTool` calls `checkTeamMemSecrets(filePath, content)` during input validation
2. The function first checks the `feature('TEAMMEM')` build flag — when the flag is off, the guard is inert and returns `null` immediately (`teamMemSecretGuard.ts:19`)
3. Dependencies (`isTeamMemPath`, `scanForSecrets`) are loaded via **dynamic `require()`** behind the feature gate to avoid bundling team memory code in non-team builds (`teamMemSecretGuard.ts:21-24`)
4. If `filePath` is not a team memory path (checked via `isTeamMemPath`), returns `null` — secrets in non-team files are not blocked
5. If `scanForSecrets` returns matches, a descriptive error message listing the detected credential types is returned, blocking the write

## Function Signatures

### `scanForSecrets(content: string): SecretMatch[]`

Scans a string for potential secrets. Returns one match per triggered rule, deduplicated by rule ID.

- **content**: The text to scan
- **Returns**: Array of `SecretMatch` objects (may be empty)

> Source: `secretScanner.ts:277-295`

### `redactSecrets(content: string): string`

Replaces all detected secret spans in the input with `[REDACTED]`, preserving surrounding text.

- **content**: The text to redact
- **Returns**: The input string with secret spans replaced

> Source: `secretScanner.ts:312-324`

### `getSecretLabel(ruleId: string): string`

Converts a gitleaks rule ID to a human-readable label (e.g., `"github-pat"` → `"GitHub PAT"`).

- **ruleId**: A kebab-case gitleaks rule ID
- **Returns**: A properly capitalized label string

> Source: `secretScanner.ts:301-303`

### `checkTeamMemSecrets(filePath: string, content: string): string | null`

Validates that content being written to a team memory path contains no secrets.

- **filePath**: The absolute path being written to
- **content**: The content to be written
- **Returns**: An error message string if secrets are detected; `null` if safe to proceed

> Source: `teamMemSecretGuard.ts:15-44`

## Type Definitions

### `SecretRule` (internal)

| Field    | Type     | Description                                              |
|----------|----------|----------------------------------------------------------|
| `id`     | `string` | Gitleaks rule ID in kebab-case (e.g., `"aws-access-token"`) |
| `source` | `string` | Regex source string, lazily compiled on first scan       |
| `flags`  | `string?`| Optional JS regex flags (default: none / case-sensitive) |

### `SecretMatch` (exported)

| Field    | Type     | Description                                                |
|----------|----------|------------------------------------------------------------|
| `ruleId` | `string` | The gitleaks rule ID that matched                          |
| `label`  | `string` | Human-readable name derived from the rule ID               |

## Rule Coverage

The scanner includes ~30 rules organized by category:

| Category              | Rule IDs                                                                 |
|-----------------------|--------------------------------------------------------------------------|
| **Cloud Providers**   | `aws-access-token`, `gcp-api-key`, `azure-ad-client-secret`, `digitalocean-pat`, `digitalocean-access-token` |
| **AI APIs**           | `anthropic-api-key`, `anthropic-admin-api-key`, `openai-api-key`, `huggingface-access-token` |
| **Version Control**   | `github-pat`, `github-fine-grained-pat`, `github-app-token`, `github-oauth`, `github-refresh-token`, `gitlab-pat`, `gitlab-deploy-token` |
| **Communication**     | `slack-bot-token`, `slack-user-token`, `slack-app-token`, `twilio-api-key`, `sendgrid-api-token` |
| **Dev Tooling**       | `npm-access-token`, `pypi-upload-token`, `databricks-api-token`, `hashicorp-tf-api-token`, `pulumi-api-token`, `postman-api-token` |
| **Observability**     | `grafana-api-key`, `grafana-cloud-api-token`, `grafana-service-account-token`, `sentry-user-token`, `sentry-org-token` |
| **Payment / Commerce**| `stripe-access-token`, `shopify-access-token`, `shopify-shared-secret`   |
| **Crypto**            | `private-key` (PEM-encoded private key blocks)                          |

All rules are sourced from the [gitleaks](https://github.com/gitleaks/gitleaks) open-source project (MIT license). Only high-confidence rules with distinctive prefixes are included — generic keyword-context patterns are deliberately omitted to minimize false positives.

## Edge Cases & Caveats

- **No secret values in output**: `scanForSecrets` intentionally omits the matched text from its return value. Only the rule ID and label are exposed. This is a deliberate security design to prevent accidental logging or display of credentials.

- **Anthropic key prefix obfuscation**: The Anthropic API key prefix (`sk-ant-api`) is assembled at runtime via `['sk', 'ant', 'api'].join('-')` (`secretScanner.ts:46`) so the literal byte sequence doesn't appear in the bundled output, passing excluded-strings checks.

- **Go-to-JS regex portability**: Gitleaks rules use Go regex syntax. Inline mode flags like `(?i)` and mode groups `(?-i:...)` are not supported in JS and have been rewritten with explicit character classes (e.g., `[a-zA-Z0-9]` instead of `(?i)[a-z0-9]`). Some rules use the `i` flag on the entire pattern instead (`secretScanner.ts:13-18`).

- **Boundary-preserving redaction**: `redactSecrets` replaces only the captured group (group 1), not the full regex match. Many patterns include boundary characters (quotes, whitespace, semicolons) outside the capture group that must be preserved for the surrounding text to remain valid (`secretScanner.ts:317-321`).

- **Feature-gated dynamic imports**: `teamMemSecretGuard.ts` uses `require()` behind the `feature('TEAMMEM')` check rather than top-level imports. This ensures the scanner and team memory path code are not bundled when the team memory feature is disabled (`teamMemSecretGuard.ts:21-24`).

- **Guard scope is team memory only**: `checkTeamMemSecrets` only blocks secrets written to team memory paths. Secrets in private memory or other files are not intercepted — the guard is specifically designed to prevent credential leakage through the shared sync mechanism.

- **Lazy compilation**: Both `scanForSecrets` and `redactSecrets` maintain separate lazily-compiled regex caches. The scan cache omits the global flag (uses `RegExp.test()`), while the redact cache adds the `g` flag for `String.replace()` to catch all occurrences.