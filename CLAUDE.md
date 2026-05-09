# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Backend (root)
pnpm dev              # Start backend server (port 3100) via tsx
pnpm start            # Start backend + frontend concurrently

No test suite exists yet (`pnpm test` is a stub).

## Architecture

pnpm monorepo with two packages: root (backend) and `web/` (frontend).

### Backend: 5-Agent Full Pipeline

The system generates interactive documentation for any code repository using a pipeline of 5 full-generation agent roles orchestrated by the **Arranger** state machine:

```
Scaffold → Checker → [per-module loop: Decomposer → Checker → Writer] → Assemble MCP/Skill → Flow Analyzer → done
```

- **Scaffold**: Analyzes entire repo, produces `top.json` with top-level modules
- **Decomposer**: Recursively splits modules into sub-graphs (`graph`) or leaf pages (`page`)
- **Writer**: Generates Markdown documentation for leaf `page` nodes
- **Checker**: Validates graph structures from Scaffold and Decomposer (not Writer output); failures trigger retry via `agent.continue()`
- **Flow Analyzer**: Extracts 3-7 cross-module interaction flows into `flows.json`

After all graph JSON and leaf Markdown pages are complete, the Arranger assembles the target repo's `.mcp.json`, `.codex/config.toml`, and Codex `doc-drill` skill. `get_flows` is enabled at this point, but returns a clear "not generated yet" error until Flow Analyzer creates `flows.json`. Flow Analyzer then runs against the completed documentation content and source repo; `flows.json` is not an input, because Flow Analyzer is responsible for creating it.

Each agent has both a Claude and Codex backend implementation, located in `src/agents/tsukai/` (e.g. `claudescaffold.ts` / `codexscaffold.ts`). All share identical interface: `run(prompt, workpath)`, `continue(prompt)`, `restore(sessionId, workpath)`, `getSessionId()`. A barrel file `src/agents/tsukai/index.ts` re-exports all classes.

### Arranger (`src/workflow/arranger.ts`)

State machine that orchestrates the pipeline. Key design:

- **State per node**: Each graph node's JSON file contains `status` (pending → decomposing → writing → checking → done/error) plus session IDs for crash recovery
- **Intermediate persistence**: After each phase completes, results + session IDs are written to disk immediately. Writer MD outputs are staged in `_pending/` directories
- **Crash recovery**: On restart, nodes in intermediate states (decomposing/writing/checking) are resumed from their saved session IDs rather than restarted. The `_pending/` directory preserves completed writer outputs so only interrupted writers need re-running
- **Retry loop**: Checker failure → `scaffold.continue()` / `decomposer.continue()` with fix prompt → re-check (up to `maxRetries`)

### Graph JSON schema (`src/agents/schemas/schema.ts`)

All data structures use Zod schemas. The `Graph` type includes `decomposerSessionId`, `checkerSessionId`, and `writerSessionIds` (optional) for resume support. Agent output schemas are converted to JSON Schema via `toOutputSchema()` for structured output.

### Incremental Update Pipeline (`src/workflow/updateOrchestrator.ts`)

After initial generation, per-PR documentation updates are handled by the **PrUpdater** agent (Claude or Codex backend, `src/agents/tsukai/claudeprupdater.ts` / `codexprupdater.ts`). The orchestrator:

1. Discovers new merged PRs via `gh pr list` (fallback: `git log --first-parent`), sorted oldest-first by `mergedAt`
2. Queues them as `TaskItem`s and processes sequentially under a per-project lock
3. Per task: checks out the merge commit, builds a prompt from commit metadata + diff → invokes PrUpdater agent with MCP tools enabled → streams Markdown report via SSE
4. Successful tasks append `src/souko/doc/{project}/update-log.jsonl` and advance `lastProcessedSha` in `src/souko/projects.json`

**Two modes:**
- **Auto**: idle → running → done → next (no gates)
- **Manual**: idle → `awaiting-confirm` (pre-run, user types optional prompt) → running → `awaiting-review` (post-run, user can Accept or send follow-up via `agent.restore` + `agent.continue`) → done

Key files: `src/git/prDiscovery.ts` (PR/commit discovery + diff helpers), `src/workflow/locks.ts` (per-project mutex), `src/souko/runLog.ts` (append-only scheduler trace at `log/{project}.txt`), `src/souko/updateLog.ts` (JSONL mutation log).

API endpoints: `POST /api/update/{start,continue,skip,cancel}`, `POST /api/update/task/{accept,chat}`, `GET /api/update/{status,stream}`.

### MCP Server (`src/mcp/`)

The `autodoc` MCP server exposes tools for agents to read/write doc artifacts:

- **Query tools** (`src/mcp/tools/query.ts`): `list_projects`, `get_top`, `get_flows`, `get_graph`, `get_page`, `search_nodes`, `list_source_files`, `read_source_files`, `list_docs`, `read_docs`
- **Mutation tools** (`src/mcp/tools/mutate.ts`): `patch_page` (string match + replace), `update_page`, `update_node`, `update_graph_meta`, `create_node`, `delete_node`, `update_top`

All write tools share the project-level document lock and only dirty the documentation working tree. Users commit accumulated doc changes manually through `/api/doc-git/commit`; blame data comes from `/api/doc-git/blame`. The doc-drill skill template at `src/skill-template/SKILL.md` is installed to `.codex/skills/doc-drill/SKILL.md` in generated target repos.

### Frontend: Vue 3 + TypeScript

- **GraphPage**: Interactive module graph visualization and Markdown page preview/edit/split views using AntV G6
- **HomePage**: Project selector, git URL input, run configuration, real-time progress polling, decomposition review entry
- **KnowledgePage**: Pre-generation Knowledge Elicitor conversation and `knowledge.md` preview/finalization
- **UpdateQueuePanel**: Right-side panel with Auto/Manual mode switch, dynamic task list, status counts; delegates to `TaskConfirmDialog` (chatbox-style modal for pre-run prompt + streaming output + post-run review/follow-up)

API client in `web/src/services/doc.ts`. Frontend proxies `/api` to backend via Vite config. SSE subscription for update events handled by `web/src/composables/useUpdateQueue.ts`.

### Output structure

```
src/souko/doc/{projectName}/
├── top.json                          # Root graph (from Scaffold)
├── flows.json                        # Flow Analyzer output
├── update-log.jsonl                  # Incremental update reports
├── {module}/
│   ├── {module}.json                 # Sub-graph (status + nodes + session IDs)
│   ├── _pending/                     # Staging dir for writer MD (pre-checker)
│   │   └── {ref}.md
│   ├── {ref}.md                      # Final leaf documentation
│   └── {submodule}/                  # Nested recursion
```

Project matching: `git.projectNameFromUrl(gitUrl)` maps to `src/souko/repo/{name}` and `src/souko/doc/{name}`. Re-running with the same generated name resumes from existing partial state only when `top.json` exists and the project is not already registered as complete.

## Key Conventions

- Agent instructions are split by language: `src/agents/instructions/cn/` (Chinese) and `src/agents/instructions/en/` (English)
- Writer instruction file has a typo in its name: `wirter.ts` (not `writer.ts`)
- PrUpdater instructions: `src/agents/instructions/{cn,en}/prupdater.ts` — two-stage prompt (impact assessment → navigate → write → Markdown report)
- Imports use `.js` extensions (Node ESM with `nodenext` module resolution)
- The `codeScope` field on graph nodes tracks which source files/directories each module covers; child scopes must be subsets of parent scopes
- `CheckerIssueType` enum: `broken-target`, `empty-content`, `invalid-path`
- Task status lifecycle: `idle → running → done` (auto) or `idle → running → awaiting-review → done` (manual, with optional follow-up loops back to running)
- Runtime logs go to `log/{project}.txt` (gitignored); PR update reports are appended through `src/souko/updateLog.ts`