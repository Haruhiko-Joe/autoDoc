# SessionUrl

## Overview & Responsibilities

The `SessionUrl` module is a small, focused utility within the **Infrastructure > CoreUtilities > SessionManagement** layer. It parses session resume identifiers — strings that users or other modules provide when resuming a prior conversation session. These identifiers come in three forms: a plain UUID, a URL containing session ingress information, or a `.jsonl` file path. The module normalizes all three into a single `ParsedSessionUrl` structure that downstream session-resume logic can consume uniformly.

## Key Process: Identifier Parsing Flow

`parseSessionIdentifier()` applies a **priority-ordered detection chain** to classify the input string:

1. **JSONL file detection** (checked first): If the identifier ends with `.jsonl` (case-insensitive), it is treated as a file path. A fresh random UUID is generated as the session ID, and the original string is stored as `jsonlFile`. This check runs *before* URL parsing to handle a Windows edge case: absolute paths like `C:\logs\session.jsonl` are valid URLs to the `URL` constructor (with `C:` as the protocol scheme), so file detection must come first.

2. **Plain UUID detection**: If the identifier passes `validateUuid()`, it is returned directly as the session ID with no ingress URL or file association.

3. **URL detection**: The identifier is passed to the `URL` constructor. If parsing succeeds, the full `url.href` becomes the `ingressUrl`, and a new random UUID is generated as the session ID. This supports session ingress URLs like `https://api.example.com/v1/session_ingress/session/<uuid>`.

4. **Fallback**: If none of the above match, the function returns `null`.

## Function Signature

### `parseSessionIdentifier(resumeIdentifier: string): ParsedSessionUrl | null`

Parses a session resume identifier string into structured session information.

- **`resumeIdentifier`** — The string to parse. Can be a UUID, a URL, or a `.jsonl` file path.
- **Returns** — A `ParsedSessionUrl` object, or `null` if the input doesn't match any recognized format.

> Source: `src/utils/sessionUrl.ts:20-64`

## Type Definition

### `ParsedSessionUrl`

| Field        | Type             | Description                                                  |
|--------------|------------------|--------------------------------------------------------------|
| `sessionId`  | `UUID`           | The session ID — either extracted from a plain UUID input or randomly generated for URL/JSONL inputs |
| `ingressUrl` | `string \| null` | The full ingress URL when the input was a URL; `null` otherwise |
| `isUrl`      | `boolean`        | `true` when the input was parsed as a URL                    |
| `jsonlFile`  | `string \| null` | The original file path when the input was a `.jsonl` file; `null` otherwise |
| `isJsonlFile`| `boolean`        | `true` when the input was detected as a `.jsonl` file path   |

> Source: `src/utils/sessionUrl.ts:4-10`

## Edge Cases & Caveats

- **Windows absolute paths**: `C:\path\file.jsonl` is a valid URL (protocol `C:`). The `.jsonl` extension check is intentionally placed before URL parsing to prevent misclassification. Non-JSONL Windows paths (e.g., `C:\path\session`) would still be parsed as URLs — this is acceptable because such strings are not expected as session identifiers in practice.
- **URL inputs get fresh UUIDs**: When a URL is provided, the session ID embedded in the URL path (if any) is *not* extracted. Instead, a new `randomUUID()` is generated every time. Callers should use `ingressUrl` to communicate with the remote session endpoint.
- **JSONL inputs also get fresh UUIDs**: Similarly, file-based sessions receive a new random session ID on each parse call.
- **Null return**: If the input is not a valid UUID, not a valid URL, and does not end in `.jsonl`, the function returns `null`. Callers must handle this case.