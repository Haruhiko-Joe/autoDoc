---
name: memory
description: Project memory tree shared by coding agents, stored as plain files under .agent-memory/ and maintained by the memory-curator agent. Use when you learn something durable worth keeping across sessions — user preferences, corrections and feedback, project decisions, environment quirks, hard-won debugging lessons — or when you need to recall project knowledge beyond the index injected at session start. Read pages from .agent-memory/tree/, record by writing a proposal to .agent-memory/staging/.
---

# Project memory

The memory library lives at `.agent-memory/` (project root; `AGENT_MEMORY_DIR` overrides). It is plain Markdown + JSON, so any agent — Claude Code, Codex, Copilot — consumes it with ordinary file tools. It is an agent system, not a passive store: you file proposals, and the **memory-curator** agent owns the tree.

```
.agent-memory/
├── top.json                  tree index { nodes: [{ path, description }] } (curator-managed)
├── tree/<path>/<name>.md     memory pages in a recursive topic tree (curator-managed)
├── staging/                  ← the ONLY place you write (proposals)
└── update-log.jsonl          consolidation provenance (engine-managed)
```

Write authority is layered and enforced by hooks: you → `staging/` only; the curator → `tree/` + `top.json`; a deterministic engine → provenance stamps, `update-log.jsonl`, and git commits of the library's own repo.

## Recall

1. A compact tree index (node paths + page descriptions) is injected at session start. If absent, the project has no memory library yet — that is normal.
2. Before relying on a memory, `Read .agent-memory/tree/<path>/<name>.md`. Frontmatter carries provenance: `sourceSha` is the project commit it was learned at — treat visibly stale pages with suspicion and file an updating proposal.
3. To search across memories, Grep `.agent-memory/tree/`.

## Record

Write one proposal per fact to `.agent-memory/staging/<kebab-name>.md`:

```markdown
---
name: prefer-pnpm
description: This repo uses pnpm only; npm/yarn lockfiles must never be introduced
type: feedback
path: conventions
scope:
  - package.json
---
The user corrected an `npm install` suggestion on 2026-06-13: this monorepo is
pnpm-managed (`pnpm-workspace.yaml`).

**Why:** mixed lockfiles break CI and teammate installs.
**How to apply:** use `pnpm add/install` in all commands and docs; if a stray
`package-lock.json` appears, flag it instead of committing it.
```

Field rules — a hook validates on write and tells you exactly what to fix if rejected:

- `name`: kebab-case, must equal the filename stem. Reusing an existing page's name means "update that memory".
- `description`: one line, ≤200 chars — what future sessions see in the index; write it for recall.
- `type`: `user` (who the user is) | `feedback` (corrections, confirmed approaches — include the why) | `project` (decisions, constraints, state) | `reference` (pointers to external resources).
- `path` (optional): suggested tree node, slash-joined kebab (`conventions/frontend`). Reuse nodes from the injected index; the curator decides final placement.
- `scope` (optional): dash-list of file globs / tools / task tags the memory is anchored to — this enables mechanical staleness detection.
- Body: the fact, **why** it matters, **how to apply** it. ≤6000 chars; split unrelated facts into separate proposals.

Do not stamp `createdAt`/`updatedAt`/`sourceSession`/`sourceSha` — the engine does.

## Discipline: what (not) to record

Record: durable preferences and corrections, decisions with rationale, non-obvious environment facts, lessons that changed your approach. Convert relative dates to absolute.

Do not record: anything derivable from the repo itself (code structure, git history, README/CLAUDE.md/AGENTS.md content), session-local state, secrets or credentials (ever), or speculation.

## Lifecycle, and when to call the curator

Your staging write is schema-validated immediately (valid proposals auto-approved; invalid ones come back with precise errors). When your turn ends, a gate hook runs the **memory-curator** agent headlessly: it consolidates proposals into the tree, merges duplicates, registers new nodes, and rejects unfit proposals (left in `staging/` with a `rejected:` reason and surfaced next session). The engine then stamps provenance and commits the library's git repo — every memory has history, blame, and rollback.

So for plain recording, just write the proposal — consolidation is automatic. Delegate to the **memory-curator agent directly** when the user asks to organize, audit, merge, or prune project memory, or when you notice the tree itself is unhealthy (stale, contradictory, or bloated nodes).
