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

### Backend: 4-Agent Pipeline

The system generates interactive documentation for any code repository using a pipeline of 4 Claude agents orchestrated by the **Arranger** state machine:

```
Scaffold → Checker → [per-module loop: Decomposer → Checker → Writer] → done
```

- **Scaffold**: Analyzes entire repo, produces `top.json` with top-level modules
- **Decomposer**: Recursively splits modules into sub-graphs (`graph`) or leaf pages (`page`)
- **Writer**: Generates Markdown documentation for leaf `page` nodes
- **Checker**: Validates graph structures from Scaffold and Decomposer (not Writer output); failures trigger retry via `agent.continue()`

Each agent has both a Claude and Codex backend implementation, located in `src/agents/tsukai/` (e.g. `claudescaffold.ts` / `codexscaffold.ts`). All share identical interface: `run(prompt, workpath)`, `continue(prompt)`, `restore(sessionId, workpath)`, `getSessionId()`. A barrel file `src/agents/tsukai/index.ts` re-exports all classes.

### Arranger (`src/workflow/arranger.ts`)

State machine that orchestrates the pipeline. Key design:

- **State per node**: Each graph node's JSON file contains `status` (pending → decomposing → writing → checking → done/error) plus session IDs for crash recovery
- **Intermediate persistence**: After each phase completes, results + session IDs are written to disk immediately. Writer MD outputs are staged in `_pending/` directories
- **Crash recovery**: On restart, nodes in intermediate states (decomposing/writing/checking) are resumed from their saved session IDs rather than restarted. The `_pending/` directory preserves completed writer outputs so only interrupted writers need re-running
- **Retry loop**: Checker failure → `scaffold.continue()` / `decomposer.continue()` with fix prompt → re-check (up to `maxRetries`)

### Graph JSON schema (`src/agents/schemas/schema.ts`)

All data structures use Zod schemas. The `Graph` type includes `decomposerSessionId`, `checkerSessionId`, and `writerSessionIds` (optional) for resume support. Agent output schemas are converted to JSON Schema via `toOutputSchema()` for structured output.

### Frontend: Vue 3 + TypeScript

- **GraphPage**: Interactive module graph visualization using AntV G6
- **DocPage**: Markdown renderer with chat panel (forks agent sessions via `forkSession()`)
- **HomePage**: Project selector, repo path input, real-time progress polling

API client in `web/src/services/doc.ts`. Frontend proxies `/api` to backend via Vite config.

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
- Imports use `.js` extensions (Node ESM with `nodenext` module resolution)
- The `codeScope` field on graph nodes tracks which source files/directories each module covers; child scopes must be subsets of parent scopes
- `CheckerIssueType` enum: `broken-target`, `empty-content`, `invalid-path`