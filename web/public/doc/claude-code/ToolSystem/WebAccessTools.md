# WebAccessTools

## Overview & Responsibilities

WebAccessTools comprises two tools within the **ToolSystem** module that give Claude the ability to retrieve information from the web: **WebFetchTool** and **WebSearchTool**. Together they form the web access layer — WebFetchTool retrieves and processes content from specific URLs, while WebSearchTool performs web searches and returns structured results.

Both tools are read-only, concurrency-safe, and deferred (their schemas are loaded on demand via `ToolSearch`). They sit alongside ~40 other built-in tools in the ToolSystem, which the QueryEngine dispatches during conversation turns.

---

## WebFetchTool

### Purpose

Fetches content from a URL, converts HTML to Markdown, and uses a secondary Haiku model to summarize/extract information based on a user-provided prompt. It enforces security constraints including domain blocklisting, URL validation, redirect safety checks, and content size limits.

### Input & Output Schemas

**Input** (`src/tools/WebFetchTool/WebFetchTool.ts:24-29`):

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | `string` (URL) | The URL to fetch content from |
| `prompt` | `string` | What information to extract from the fetched content |

**Output** (`src/tools/WebFetchTool/WebFetchTool.ts:32-45`):

| Field | Type | Description |
|-------|------|-------------|
| `bytes` | `number` | Size of the fetched content |
| `code` | `number` | HTTP response status code |
| `codeText` | `string` | HTTP status text |
| `result` | `string` | Processed/summarized content |
| `durationMs` | `number` | Total fetch + processing time |
| `url` | `string` | The URL that was fetched |

### Key Process: Fetch Flow

1. **URL Validation** (`src/tools/WebFetchTool/utils.ts:139-169`): Checks URL length (max 2,000 chars), parses it, rejects URLs with embedded credentials, and requires at least a two-part hostname.

2. **Cache Check** (`src/tools/WebFetchTool/utils.ts:356-367`): An LRU cache (50 MB max, 15-minute TTL) stores previous fetches. Cache hits return immediately without a network request.

3. **HTTP-to-HTTPS Upgrade** (`src/tools/WebFetchTool/utils.ts:376-378`): All `http://` URLs are silently upgraded to `https://`.

4. **Domain Blocklist Preflight** (`src/tools/WebFetchTool/utils.ts:176-203`): Unless `skipWebFetchPreflight` is set in settings (for enterprise environments), the tool calls `api.anthropic.com/api/web/domain_info` to check whether the domain is allowed. Allowed results are cached for 5 minutes in a separate hostname-keyed LRU cache (128 entries). Blocked domains throw `DomainBlockedError`; check failures throw `DomainCheckFailedError`.

5. **HTTP Fetch with Redirect Handling** (`src/tools/WebFetchTool/utils.ts:262-329`): Uses axios with `maxRedirects: 0` to manually control redirects. The `isPermittedRedirect()` function (`src/tools/WebFetchTool/utils.ts:212-243`) allows same-host redirects (including www prefix changes) but returns a `RedirectInfo` object for cross-host redirects, which the caller surfaces to Claude so it can make a new explicit fetch. Max 10 redirect hops; 60-second timeout; 10 MB max content length. Egress proxy blocks (403 with `X-Proxy-Error: blocked-by-allowlist`) are detected and surfaced as `EgressBlockedError`.

6. **Content Processing** (`src/tools/WebFetchTool/utils.ts:428-466`):
   - Binary content (PDFs, images, etc.) is saved to disk via `persistBinaryContent()` from `src/utils/mcpOutputStorage.ts` and noted in the result.
   - HTML is converted to Markdown using a lazy-loaded [Turndown](https://github.com/mixmark-io/turndown) singleton (`src/tools/WebFetchTool/utils.ts:92-97`), deferred to avoid loading ~1.4 MB of retained heap until first use.
   - Non-HTML content is used as-is.

7. **Prompt Application** (`src/tools/WebFetchTool/utils.ts:484-530`): Content is truncated to 100,000 characters (`MAX_MARKDOWN_LENGTH`), then sent to a Haiku model via `queryHaiku()` (from `src/services/api/claude.ts`) with the user's prompt. For preapproved domains serving `text/markdown` under the size limit, the raw content is returned without Haiku processing. The secondary model prompt (`src/tools/WebFetchTool/prompt.ts:23-46`) includes copyright-protection guidelines for non-preapproved domains (125-char quote limit, quotation marks for exact language).

8. **Result Caching** (`src/tools/WebFetchTool/utils.ts:470-481`): The processed content (before Haiku summarization) is stored in the URL cache, keyed by the original (not upgraded) URL.

### Permission Model

Permissions are checked per-hostname (`src/tools/WebFetchTool/WebFetchTool.ts:50-64`, `104-180`):

- **Preapproved hosts**: ~130 developer documentation domains (see below) are auto-allowed without user interaction.
- **Rule-based**: The permission system checks deny/ask/allow rules keyed by `domain:<hostname>`.
- **Suggestions**: When permission is needed, the tool suggests adding a local allow rule for the domain.

### Preapproved Hosts

The preapproved list (`src/tools/WebFetchTool/preapproved.ts:14-131`) contains ~130 domains covering:
- Anthropic properties (`platform.claude.com`, `modelcontextprotocol.io`, `agentskills.io`)
- Language documentation (Python, Rust, Go, TypeScript, Java, C++, etc.)
- Framework docs (React, Django, Spring, Flutter, etc.)
- Cloud providers (AWS, GCP, Azure)
- Databases, DevOps tools, testing frameworks

Some entries are path-scoped (e.g., `github.com/anthropics`) — the lookup splits entries at module load into hostname-only and path-prefix maps for O(1) checking (`src/tools/WebFetchTool/preapproved.ts:136-166`). Path matching enforces segment boundaries to prevent prefix attacks (e.g., `/anthropics` won't match `/anthropics-evil/malware`).

**Security note**: These preapproved domains are for GET-only WebFetch. The sandbox network restriction system deliberately does not inherit this list, since unrestricted POST/upload access could enable data exfiltration.

### Constants & Limits

| Constant | Value | Location |
|----------|-------|----------|
| `MAX_URL_LENGTH` | 2,000 chars | `src/tools/WebFetchTool/utils.ts:106` |
| `MAX_HTTP_CONTENT_LENGTH` | 10 MB | `src/tools/WebFetchTool/utils.ts:112` |
| `FETCH_TIMEOUT_MS` | 60 seconds | `src/tools/WebFetchTool/utils.ts:116` |
| `DOMAIN_CHECK_TIMEOUT_MS` | 10 seconds | `src/tools/WebFetchTool/utils.ts:119` |
| `MAX_REDIRECTS` | 10 hops | `src/tools/WebFetchTool/utils.ts:124` |
| `MAX_MARKDOWN_LENGTH` | 100,000 chars | `src/tools/WebFetchTool/utils.ts:128` |
| `maxResultSizeChars` | 100,000 chars | `src/tools/WebFetchTool/WebFetchTool.ts:70` |
| URL cache TTL | 15 minutes | `src/tools/WebFetchTool/utils.ts:63` |
| URL cache max size | 50 MB | `src/tools/WebFetchTool/utils.ts:64` |
| Domain check cache TTL | 5 minutes | `src/tools/WebFetchTool/utils.ts:77` |

---

## WebSearchTool

### Purpose

Performs web searches using Anthropic's built-in `web_search_20250305` server tool. It sends the query to a Claude model with the web search tool enabled, streams back results with real-time progress updates, and returns structured search hits with text commentary.

### Input & Output Schemas

**Input** (`src/tools/WebSearchTool/WebSearchTool.ts:25-37`):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` (min 2 chars) | Yes | The search query |
| `allowed_domains` | `string[]` | No | Only include results from these domains |
| `blocked_domains` | `string[]` | No | Exclude results from these domains |

`allowed_domains` and `blocked_domains` are mutually exclusive — specifying both fails validation (`src/tools/WebSearchTool/WebSearchTool.ts:244-251`).

**Output** (`src/tools/WebSearchTool/WebSearchTool.ts:56-66`):

| Field | Type | Description |
|-------|------|-------------|
| `query` | `string` | The executed search query |
| `results` | `(SearchResult \| string)[]` | Mix of structured search hits and text commentary |
| `durationSeconds` | `number` | Total operation time |

Each `SearchResult` contains a `tool_use_id` and a `content` array of `{ title, url }` hits.

### Provider Availability

Web search is only enabled for specific API providers (`src/tools/WebSearchTool/WebSearchTool.ts:168-193`):
- **firstParty**: Always enabled
- **vertex**: Enabled for Claude 4.0+ models only
- **foundry**: Always enabled (ships only supported models)
- All other providers: Disabled

### Key Process: Search Flow

1. **Input Validation** (`src/tools/WebSearchTool/WebSearchTool.ts:235-253`): Ensures query is non-empty and that `allowed_domains`/`blocked_domains` aren't both specified.

2. **Model Selection** (`src/tools/WebSearchTool/WebSearchTool.ts:262-265`): A feature flag (`tengu_plum_vx3`) controls whether to use Haiku (small fast model, via `getSmallFastModel()` from `src/utils/model/model.ts`) or the main loop model. When using Haiku, thinking is disabled and the tool is forced with `toolChoice: { type: 'tool', name: 'web_search' }`.

3. **Streaming Query** (`src/tools/WebSearchTool/WebSearchTool.ts:268-291`): Sends a user message to `queryModelWithStreaming()` (from `src/services/api/claude.ts`) with the `web_search_20250305` tool schema (hardcoded `max_uses: 8`). The system prompt is minimal: "You are an assistant for performing a web search tool use."

4. **Progress Tracking** (`src/tools/WebSearchTool/WebSearchTool.ts:299-388`): The stream is consumed event-by-event:
   - `content_block_start` with `server_tool_use` type: Tracks the tool use ID and begins accumulating JSON input.
   - `content_block_delta` with `input_json_delta`: Accumulates partial JSON and uses regex to extract the `query` field for real-time `query_update` progress events.
   - `content_block_start` with `web_search_tool_result` type: Emits `search_results_received` progress with the result count and query.

5. **Response Parsing** (`src/tools/WebSearchTool/WebSearchTool.ts:86-150`): The `makeOutputFromSearchResponse()` function processes the content block sequence (text blocks, `server_tool_use` blocks, `web_search_tool_result` blocks) into a flat array of search results and text commentary. Error results (non-array content) are logged and included as error messages.

6. **Result Formatting** (`src/tools/WebSearchTool/WebSearchTool.ts:401-434`): `mapToolResultToToolResultBlockParam()` formats results as a string with search hit links serialized as JSON, appending a reminder to include sources in the response.

### Prompt Design

The prompt (`src/tools/WebSearchTool/prompt.ts:5-34`) includes:
- A mandatory instruction to include a "Sources:" section with markdown hyperlinks in every response
- The current month/year (via `getLocalMonthYear()` from `src/constants/common.ts`) to ensure searches use the correct year
- Notes about domain filtering support and US-only availability

### Type Definitions

The `WebSearchProgress` type used for progress tracking is defined centrally and re-exported through `src/Tool.ts:57,72`. It powers the two progress event shapes:
- `{ type: 'query_update', query: string }` — emitted when a search sub-query is detected in the stream
- `{ type: 'search_results_received', resultCount: number, query: string }` — emitted when results arrive

---

## UI Components

Both tools provide React (Ink) components for terminal rendering:

### WebFetchTool UI (`src/tools/WebFetchTool/UI.tsx`)
- **Tool use message**: Shows the URL (and prompt in verbose mode)
- **Progress**: Displays "Fetching…" during the request
- **Result**: Shows received size and HTTP status code; verbose mode includes the full result text

### WebSearchTool UI (`src/tools/WebSearchTool/UI.tsx`)
- **Tool use message**: Shows the query in quotes, with domain filters in verbose mode
- **Progress**: Shows "Searching: {query}" during `query_update` events and "Found N results for {query}" when results arrive
- **Result**: Displays "Did N searches in Xs/ms"

---

## Edge Cases & Caveats

- **Cross-host redirects are not followed automatically**. The tool returns a redirect message instructing Claude to make a new fetch with the redirect URL. This is a deliberate security measure per PSR guidelines to prevent open-redirect exploitation.
- **Binary content (PDFs, etc.)** is both saved to disk (with a mime-derived extension) and decoded as UTF-8 for Haiku summarization. The saved file path is appended to the result so Claude can inspect the raw file.
- **The Turndown HTML-to-Markdown converter is lazy-loaded** to avoid a ~1.4 MB heap cost until the first HTML fetch. The instance is then reused across all subsequent calls.
- **The `skipWebFetchPreflight` setting** exists for enterprise customers whose network policies block outbound connections to `api.anthropic.com` for the domain check.
- **Web search is US-only** per the prompt documentation.
- **`maxResultSizeChars` (100K)** is the tool result persistence threshold — results larger than this may be handled differently by the conversation system.
- **Axios response buffer is explicitly nulled** after copying to a Node.js `Buffer` (`src/tools/WebFetchTool/utils.ts:432`) to allow GC to reclaim up to 10 MB before Turndown builds its DOM tree (which can be 3-5x the HTML size).
- **WebFetchTool prompt always includes the auth warning** about authenticated/private URLs failing, regardless of whether `ToolSearch` is in the tool list. This avoids prompt cache invalidation caused by flickering the tool description when MCP tool count thresholds change (`src/tools/WebFetchTool/WebFetchTool.ts:182-189`).