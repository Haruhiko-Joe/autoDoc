# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
# Backend (root)
pnpm dev              # Start backend server (port 3100) via tsx
pnpm start            # Start backend + frontend concurrently

No test suite exists yet (`pnpm test` is a stub).

## Architecture

pnpm monorepo with two packages: root (backend) and `web/` (frontend).

### Backend: 4-Agent Pipeline

The system generates interactive documentation for any code repository using a pipeline of 4 Codex agents orchestrated by the **Arranger** state machine:

```
Scaffold → Checker → [per-module loop: Decomposer → Checker → Writer] → done
```

- **Scaffold**: Analyzes entire repo, produces `top.json` with top-level modules
- **Decomposer**: Recursively splits modules into sub-graphs (`graph`) or leaf pages (`page`)
- **Writer**: Generates Markdown documentation for leaf `page` nodes
- **Checker**: Validates graph structures from Scaffold and Decomposer (not Writer output); failures trigger retry via `agent.continue()`

Each agent has both a Codex and Codex backend implementation, located in `src/agents/tsukai/` (e.g. `claudescaffold.ts` / `codexscaffold.ts`). All share identical interface: `run(prompt, workpath)`, `continue(prompt)`, `restore(sessionId, workpath)`, `getSessionId()`. A barrel file `src/agents/tsukai/index.ts` re-exports all classes.

### Arranger (`src/workflow/arranger.ts`)

State machine that orchestrates the pipeline. Key design:

- **State per node**: Each graph node's JSON file contains `status` (pending → decomposing → writing → checking → done/error) plus session IDs for crash recovery
- **Intermediate persistence**: After each phase completes, results + session IDs are written to disk immediately. Writer MD outputs are staged in `_pending/` directories
- **Crash recovery**: On restart, nodes in intermediate states (decomposing/writing/checking) are resumed from their saved session IDs rather than restarted. The `_pending/` directory preserves completed writer outputs so only interrupted writers need re-running
- **Retry loop**: Checker failure → `scaffold.continue()` / `decomposer.continue()` with fix prompt → re-check (up to `maxRetries`)

### Graph JSON schema (`src/agents/schemas/schema.ts`)

All data structures use Zod schemas. The `Graph` type includes `decomposerSessionId`, `checkerSessionId`, and `writerSessionIds` (optional) for resume support. Agent output schemas are converted to JSON Schema via `toOutputSchema()` for structured output.

### Incremental Update Pipeline (`src/workflow/updateOrchestrator.ts`)

After initial generation, per-PR documentation updates are handled by the **PrUpdater** agent (Codex or Codex backend, `src/agents/tsukai/claudeprupdater.ts` / `codexprupdater.ts`). The orchestrator:

1. Discovers new merged PRs via `gh pr list` (fallback: `git log --first-parent`), sorted oldest-first by `mergedAt`
2. Queues them as `TaskItem`s and processes sequentially under a per-project lock
3. Per task: snapshots `web/doc/{project}` → builds prompt from commit metadata + diff → invokes PrUpdater agent with MCP tools enabled → streams Markdown report via SSE

**Two modes:**
- **Auto**: idle → running → done → next (no gates)
- **Manual**: idle → `awaiting-confirm` (pre-run, user types optional prompt) → running → `awaiting-review` (post-run, user can Accept or send follow-up via `agent.restore` + `agent.continue`) → done

Key files: `src/git/prDiscovery.ts` (PR/commit discovery + diff helpers), `src/workflow/locks.ts` (per-project mutex), `src/souko/runLog.ts` (append-only scheduler trace at `log/{project}.txt`), `src/souko/updateLog.ts` (JSONL mutation log).

API endpoints: `POST /api/update/{start,continue,skip,cancel}`, `POST /api/update/task/{accept,chat}`, `GET /api/update/{status,stream}`.

### MCP Server (`src/mcp/`)

The `autodoc` MCP server exposes tools for agents to read/write doc artifacts:

- **Query tools** (`src/mcp/tools/query.ts`): `list_projects`, `get_top`, `get_graph`, `get_page`, `search_nodes`, `list_source_files`, `read_source_files`, `list_docs`, `read_docs`, `list_history`, `get_history`
- **Mutation tools** (`src/mcp/tools/mutate.ts`): `patch_page` (string match + replace), `update_page`, `update_node`, `update_graph_meta`, `create_node`, `delete_node` (preserves `.history` via `.tombstones/`), `update_top`, `revert`

All write tools enforce optimistic locking via `baseVersion` (must match current `version` from read tools). The doc-drill skill template at `src/skill-template/SKILL.md` documents these tools for agent consumption.

### Frontend: Vue 3 + TypeScript

- **GraphPage**: Interactive module graph visualization using AntV G6
- **DocPage**: Markdown renderer with chat panel (forks agent sessions via `forkSession()`)
- **HomePage**: Project selector, repo path input, real-time progress polling
- **UpdateQueuePanel**: Right-side panel with Auto/Manual mode switch, dynamic task list, status counts; delegates to `TaskConfirmDialog` (chatbox-style modal for pre-run prompt + streaming output + post-run review/follow-up)

API client in `web/src/services/doc.ts`. Frontend proxies `/api` to backend via Vite config. SSE subscription for update events handled by `web/src/composables/useUpdateQueue.ts`.

### Output structure

```
web/doc/{projectName}/
├── top.json                          # Root graph (from Scaffold)
├── {module}/
│   ├── {module}.json                 # Sub-graph (status + nodes + session IDs)
│   ├── _pending/                     # Staging dir for writer MD (pre-checker)
│   │   └── {ref}.md
│   ├── {ref}.md                      # Final leaf documentation
│   └── {submodule}/                  # Nested recursion
```

Project matching: `path.basename(repoPath)` maps to `web/doc/{name}/`. Re-running with the same basename resumes from existing state.

## Key Conventions

- Agent instructions are split by language: `src/agents/instructions/cn/` (Chinese) and `src/agents/instructions/en/` (English)
- Writer instruction file has a typo in its name: `wirter.ts` (not `writer.ts`)
- PrUpdater instructions: `src/agents/instructions/{cn,en}/prupdater.ts` — two-stage prompt (impact assessment → navigate → write → Markdown report)
- Imports use `.js` extensions (Node ESM with `nodenext` module resolution)
- The `codeScope` field on graph nodes tracks which source files/directories each module covers; child scopes must be subsets of parent scopes
- `CheckerIssueType` enum: `broken-target`, `empty-content`, `invalid-path`
- Task status lifecycle: `idle → running → done` (auto) or `idle → running → awaiting-review → done` (manual, with optional follow-up loops back to running)
- Runtime logs go to `log/{project}.txt` (gitignored); JSONL mutation history in `src/souko/updateLog.ts`