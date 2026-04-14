# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Backend (root)
pnpm dev                         # Start backend server (port 3100) via tsx
pnpm start                       # Start backend + frontend concurrently
npx tsc --noEmit                 # Type-check backend
pnpm test                        # Run retrieval test suite (node:test + tsx)

# Frontend (web/)
cd web && pnpm dev               # Start Vite dev server (proxies /api to :3100)
cd web && pnpm build             # Type-check + build frontend
cd web && npx vue-tsc --noEmit   # Type-check frontend only
```

## Architecture

pnpm monorepo with two packages: root (backend) and `web/` (frontend).

### Backend: 5+1 Agent Pipeline

The system generates interactive documentation for any code repository using a pipeline of agents orchestrated by the **Arranger** state machine:

```
Scaffold → [processing loop: Decomposer ⇄ Checker → Writer] → FlowAnalyzer
                                                                    ↑
                      git-diff → Updater (incremental mode) ────────┘
```

| Role | Claude wrapper | Codex wrapper | Purpose |
|------|----------------|---------------|---------|
| **Scaffold** | `claudescaffold.ts` | `codexscaffold.ts` | Top-level module graph (`top.json`) |
| **Decomposer** | `claudedecomposer.ts` | `codexdecomposer.ts` | Recursive subgraphs |
| **Writer** | `claudewriter.ts` | `codexwriter.ts` | Leaf markdown pages |
| **Checker** | `claudechecker.ts` | `codexchecker.ts` | Structural / content validation with retry loop |
| **FlowAnalyzer** | `claudeflowanalyzer.ts` | `codexflowanalyzer.ts` | Cross-module business-flow extraction (`flows.json`) |
| **Updater** | `claudeupdater.ts` | `codexupdater.ts` | git-diff driven incremental doc patch |

Every agent class exposes an identical interface (`IScaffold`, `IDecomposer`, etc. in `src/agents/schemas/schema.ts`):

- `run(prompt, workpath)` — fresh session
- `continue(prompt)` — resume the same session with new input
- `restore(sessionId, workpath)` — reconstitute from a persisted session ID
- `getSessionId()` — expose the session ID

Per-role backend is configurable via `AgentBackends` (`{scaffold, decomposer, writer, checker, flowAnalyzer, updater}`); the defaults are Claude for generators and Codex for the Checker.

### Arranger (`src/workflow/arranger.ts`)

State machine orchestrating the pipeline.

- **State per node**: every graph JSON file carries `status` (`pending → decomposing → writing → checking → done | error`) plus session IDs for crash recovery.
- **Intermediate persistence**: results + session IDs are flushed to disk after each phase. Writer outputs stage in `_pending/` until Checker passes.
- **Crash recovery**: on restart, nodes in intermediate states resume from their saved session IDs. `resetRecoverableNodes()` reverts half-done work on boot.
- **Retry loop**: Checker failure → `decomposer.continue()` with a structured fix prompt built from `CheckerIssue`s (up to 5 retries).
- **Concurrency**: `maxConcurrency` semaphore (default 8) guards the pipeline. Pause/resume is supported via `arranger.pause()` / `resume()`.

### HTTP / MCP server (`src/server.ts`)

- Single Node HTTP server hosting both the REST API and the MCP endpoint.
- `POST /api/run`, `/pause`, `/resume`; `GET /api/status`, `/status/stream` (SSE), `/projects`, `/search`, `/doc/...`.
- `POST /api/chat` — **RAG-aware** streaming chat. When the client supplies `{project, currentPath?, messages}`, the server pulls top/graph/page context via `DocRetriever` and injects it as a system prompt. Falls back to legacy passthrough when no project is supplied.
- `POST /mcp` — Streamable HTTP MCP transport. A fresh `McpServer` is built per request (stateless).

### Retrieval (`src/retrieval/`)

Graph-native retriever over the existing DocStore artifacts. **No embeddings, no vector DB, no extra runtime deps.**

- `tokenize.ts` — hybrid tokenizer. English: camelCase / snake_case / kebab-case split + stopword filter. CJK: overlapping bigrams.
- `bm25lite.ts` — token-overlap scorer with IDF weighting and a snippet builder.
- `docRetriever.ts` — `class DocRetriever` with two entry points:
  - `rank(project, query, { topK, currentPath })` — ranked `RetrievalHit[]` across top / graph / page docs.
  - `buildChatContext(project, query, currentPath?)` — bounded `ChatContext` (top description + graph hits + page bodies + optional current page), used by `/api/chat` and the MCP `semantic_search` tool.
- `__tests__/` — `node:test` suite (16 cases). Run with `pnpm test`.

### MCP tools (`src/mcp/`)

`docStore.ts` exposes versioned reads/writes with `.history/` snapshots. `tools/query.ts` registers read-only tools (`list_projects`, `get_top`, `get_graph`, `get_page`, `search_nodes`, **`semantic_search`**, `list_history`, `get_history`). `tools/mutate.ts` registers optimistically-locked write tools (`update_top`, `update_graph_meta`, `create_node`, `update_node`, `delete_node`, `update_page`, `revert`).

Use `search_nodes` for fast keyword lookup, `semantic_search` for natural-language questions, and the `get_*` tools for progressive drill-down.

### Graph JSON schema (`src/agents/schemas/schema.ts` + `src/mcp/schema.ts`)

All data structures use Zod schemas. The arranger-internal `Graph` carries workflow fields (`status`, `retryCount`, `sessionId`, `decomposerSessionId`, `checkerSessionId`, `writerSessionIds`, `pageTasks`). The MCP-facing `Graph` uses `.passthrough()` so workflow fields round-trip without being dropped.

Output schemas are converted to JSON Schema via `toOutputSchema()` for the Agent SDK's structured-output mode.

### Frontend: Vue 3 + TypeScript

- **HomePage** — project selector, git-URL input, real-time progress polling.
- **GraphPage** — interactive module graph (AntV G6) and doc page rendering.
- **FlowsPage** — business-flow sequence diagrams.
- **ChatPanel** — floating chat with **inline citation chips** (`[ref:PATH]` tokens rendered as buttons) and a "Sources" row under every assistant message. Clicking a citation deep-links into the corresponding doc page.

API client in `web/src/services/doc.ts`. Vite dev server proxies `/api` to backend.

### Output structure

```
web/doc/{projectName}/                (also available under src/souko/doc)
├── top.json                          # Root graph (from Scaffold)
├── flows.json                        # Cross-module flows (from FlowAnalyzer)
├── {module}/
│   ├── {module}.json                 # Sub-graph (status + nodes + session IDs)
│   ├── _pending/                     # Staging dir for writer MD (pre-checker)
│   │   └── {ref}.md
│   ├── .history/                     # Versioned snapshots per file
│   ├── {ref}.md                      # Final leaf documentation
│   └── {submodule}/                  # Nested recursion
```

Project matching: `git.projectNameFromUrl(gitUrl)` derives the project name. The `souko` registry (`src/souko/registry.ts`) maps project name to source URL, branch, and HEAD commit so incremental updates via the Updater agent stay consistent.

## Key Conventions

- Agent instruction files are in Chinese (`src/agents/instructions/*.ts`) with English siblings (`*.en.ts`) for the `language: "en"` path.
- Writer instruction files are at `src/agents/instructions/wirter.ts` / `wirter.en.ts` (historical typo — preserved for back-compat).
- Imports use `.js` extensions (Node ESM with `nodenext` module resolution).
- `codeScope` on graph nodes tracks which source files/directories each module covers; child scopes should be subsets of parent scopes.
- No embeddings, no vector DB. Retrieval is graph-native: the structured docs that autoDoc produces are also the retrieval index.
