<p align="center">
  <h1 align="center">autoDoc</h1>
  <p align="center">
    <strong>Paste a git URL. Get an interactive, incrementally-updatable, Agent-readable/writable documentation site.</strong>
  </p>
  <p align="center">
    5 + 1 AI Agents · Iterative Validation · git-diff Incremental Updates · HTTP MCP · Interactive Architecture Graphs · Crash Recovery · Progressive Disclosure
  </p>
  <p align="center">
    <a href="README.md">中文</a> | <strong>English</strong> | <a href="README.ja.md">日本語</a>
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vue-3.x-4FC08D?logo=vuedotjs&logoColor=white" alt="Vue 3">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/pnpm-%3E%3D10-F69220?logo=pnpm&logoColor=white" alt="pnpm">
  <img src="https://img.shields.io/badge/MCP-Streamable_HTTP-512BD4" alt="MCP">
  <a href="https://github.com/Haruhiko-Joe/autoDoc/stargazers"><img src="https://img.shields.io/github/stars/Haruhiko-Joe/autoDoc?style=social" alt="Stars"></a>
</p>

<p align="center">
  <a href="https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill">📘 Companion Skill: doc-drill</a> · Talks to any Code Agent via the same-process <code>/mcp</code> endpoint
</p>

---

## Why autoDoc?

Unlike DeepWiki, Google Code Wiki, and similar tools, autoDoc is not just "one-shot doc generation" — it is a **multi-agent documentation factory with a quality feedback loop, plus an MCP-native knowledge base that Agents can read and write directly**. It is both **the most human-friendly doc site to read** and **a knowledge source natively tailored for Code Agents**, achieving SOTA across readability, interactivity, Agent-consumability, and incremental maintenance.

| | autoDoc | DeepWiki | Google Code Wiki |
|---|:---:|:---:|:---:|
| Multi-agent iterative validation | **✅ 5 Agents + Checker loop** | ❌ Single pass | ❌ Single pass |
| Direct git URL ingestion | **✅ Backend auto-clones & tracks commits** | ✅ | ✅ |
| Incremental update (git-diff driven) | **✅ Dedicated Updater Agent patches in-place** | ❌ Full regen | ❌ Full regen |
| Interactive architecture graphs | **✅ 6 semantic edge types + hover details** | ❌ Static Mermaid | ❌ Static |
| Recursive adaptive decomposition | **✅ Agent decides depth autonomously** | ❌ Fixed levels | ❌ Flat |
| Crash recovery | **✅ Session ID + pending staging** | ❌ | ❌ |
| Agent-writable docs | **✅ HTTP MCP (query + mutate + history)** | ❌ | ❌ |
| Code Agent integration | **✅ doc-drill skill ↔ /mcp** | ❌ | ❌ |
| Hybrid AI backends | **✅ Per-role Claude/Codex selection** | ❌ | ❌ |

## Demo

| Architecture Overview | Sub-module Graph |
|:---:|:---:|
| ![overview](fig/overview.png) | ![module](fig/module.png) |

| Markdown Doc Page | Chat with AI |
|:---:|:---:|
| ![finalpage](fig/finalpage.png) | ![continuechat](fig/continuechat.png) |

| Interaction Flows |
|:---:|
| ![interactiveflow](fig/interactiveflow.png) |

## Quick Start

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install && cd web && pnpm install && cd ..
pnpm start
```

Paste a git URL in the frontend and generation begins. **For the full onboarding walkthrough — prerequisites, first generation, incremental updates, MCP wiring — see [USAGE.md](USAGE.md).**

### Codex Profile Configuration

The Codex backend uses [profiles](https://developers.openai.com/codex/config-reference) per Agent role to isolate model parameters. Add one profile per role to `~/.codex/config.toml`. Names must be exactly `scaffold`, `decomposer`, `writer`, `checker`, `flowanalyzer`, `updater`:

```toml
[profiles.scaffold]
model = "gpt-5.4"
model_reasoning_effort = "high"

[profiles.decomposer]
model = "gpt-5.4"
model_reasoning_effort = "high"

[profiles.writer]
model = "gpt-5.4"
model_reasoning_effort = "medium"

[profiles.checker]
model = "gpt-5.4"
model_reasoning_effort = "high"

[profiles.flowanalyzer]
model = "gpt-5.4"
model_reasoning_effort = "medium"

[profiles.updater]
model = "gpt-5.4"
model_reasoning_effort = "high"
```

Replace models or tweak `model_reasoning_effort` / `service_tier` as needed. See the official [Config Reference](https://developers.openai.com/codex/config-reference) for all keys.

### Claude Code Internal Proxy

If your gateway requires an internal endpoint model (e.g. `ep-...`), launch a local forwarding proxy:

```bash
pnpm proxy:claude:setup -- \
  --model ep-xxxxx \
  --base-url https://your-gateway.example.com/api/v1 \
  --api-key <your_token>
```

Then in another terminal:

```bash
unset ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/v1
export ANTHROPIC_API_KEY=<your_token>
claude --model "claude-opus-4-6"
```

## How It Works

### First submission: full pipeline

```
gitUrl ──► git clone ──► src/souko/repo/{name}
                                  │
                                  ▼
              Scaffold ──► Checker
                                  │
                ┌─────────────────┴─────────────────┐
                ▼                                   ▼
          Decomposer ──► Checker            Decomposer ──► Checker  ...
                │                                   │
                ▼                                   ▼
             Writer                              Writer
                │                                   │
                └────────────► Flow Analyzer ◄──────┘
                                       │
                                       ▼
                       projects.json + src/souko/doc/{name}
```

### Incremental update: git-diff driven

```
gitUrl (existing) ──► git fetch + pull
                          │
                          ▼
                  newHead == prevHead?
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
            yes                       no
              │                       │
              ▼                       ▼
       mode: "noop"           git diff prev..new
                                       │
                                       ▼
                             Updater Agent (Read/Edit/Write)
                                       │
                                       ▼
                          patches .md / .json locally + updates head
```

| Agent | Role | Validation |
|-------|------|------------|
| **Scaffold** | Analyzes the whole repo, emits the top-level module graph | Validated by Checker |
| **Decomposer** | Recursively splits modules into sub-graphs or leaf pages | Validated by Checker (up to 5 retries) |
| **Writer** | Generates detailed Markdown for each leaf node | — |
| **Checker** | Validates graph integrity and content quality | — |
| **Flow Analyzer** | Extracts 3–7 typical cross-module interaction flows | — |
| **Updater** | Receives a git diff and patches the doc tree in place | — |

Full-pipeline Agents are orchestrated by the **Arranger** state machine with a **sliding-window concurrency model** — the concurrency level is configurable from the frontend (default 8). State is tracked per node with full crash recovery. **Updater** is a separate incremental channel that uses fs Read/Edit/Write directly for minimal edits.

### Hybrid AI Backends

Each Agent role independently uses **Claude** (Claude Agent SDK) or **Codex** (OpenAI Codex SDK), configurable from the frontend panel:

| Role | Default Backend |
|------|----------------|
| Scaffold | Claude |
| Decomposer | Claude |
| Writer | Claude |
| Checker | Codex |
| Flow Analyzer | Claude |
| Updater | Claude |

## Key Features

- **🔗 One-step git URL ingestion** — paste an SSH/HTTPS git URL; backend auto-clones, tracks the main branch head, keeps everything under `src/souko/`
- **🔁 Incremental updates** — re-submitting the same URL triggers fetch + diff, and a dedicated Updater Agent patches docs in place instead of rerunning the full pipeline
- **🛰️ HTTP MCP server** — same-process `/mcp` endpoint (Streamable HTTP) exposes the full query + mutate toolset for direct Code Agent access
- **📜 Document version control** — every write carries optimistic locking (`baseVersion`) and snapshots to `.history/{file}.v{n}`; `revert` restores any historical version
- **🔗 Interactive directed graphs** — [AntV G6](https://g6.antv.antgroup.com/) with 6 semantic edge types (calls, depends, data-flow, event, extends, composes) and hover popovers
- **🔍 Progressive disclosure** — start at the top-level overview, drill into nodes down to leaf Markdown
- **🔄 Interaction flow diagrams** — cross-module business flows auto-extracted and rendered as sequence diagrams with participants, steps, and code references
- **🔎 Module search** — sidebar search over all modules
- **💬 AI chat panel** — floating chat window for doc follow-ups (requires `OPENAI_API_KEY`)
- **🌙 Dark mode** — Tokyo Night theme
- **📊 Real-time progress** — live generation progress on the home page (distinguishes initial / incremental / noop modes)
- **🌐 Multi-language** — generate Chinese (default) or English doc sites

## HTTP MCP Interface

The backend exposes an MCP server named `autodoc` at `http://localhost:3100/mcp` as a stateless Streamable HTTP transport. All tools operate on real files under `src/souko/doc/{project}/`.

### Wire it up in Claude Code

Drop an `.mcp.json` into the target repo root:

```json
{
  "mcpServers": {
    "autodoc": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

The matching [doc-drill skill](src/skill-template/SKILL.md) is a thin instruction set that only describes **how to call the MCP tools**, and ships with autoDoc.

### Tool list

#### Query (no side effects)

| Tool | Purpose |
|---|---|
| `list_projects` | List all registered projects (with sourceUrl / head / lastUpdated) |
| `get_top` | Read a project's top.json (with `version`) |
| `get_graph` | Read a sub-graph (with `version` and the `pageVersions` map) |
| `get_page` | Read a leaf Markdown page (with its `version`) |
| `search_nodes` | Search node names/descriptions across all levels |
| `list_history` | List all historical versions of a file |
| `get_history` | Read a specific historical version |

#### Mutate (optimistic lock via `baseVersion`)

| Tool | Purpose |
|---|---|
| `update_top` | Update top.json's description / nodes |
| `update_graph_meta` | Update a sub-graph's description / codeScope |
| `create_node` | Append a node to a parent graph (page → creates an empty md; graph → creates a sub-graph placeholder) |
| `update_node` | Update a node's name / description / codeScope / edges in its parent graph |
| `delete_node` | Remove a node from its parent graph (page deletes the md; graph recursively deletes its subtree) |
| `update_page` | Overwrite a leaf md; uses `pageVersions[ref]` as baseVersion |
| `revert` | Write a historical version back as a new version, keeping intermediate versions intact |

Write flow: **read → obtain version → write with baseVersion → server snapshots the old version to `.history/` → version+1 → persist**. A version mismatch returns `VersionMismatch` so the client re-reads and retries.

> ⚠️ `/mcp` is unauthenticated and CORS-open by default. Add access control or bind to loopback before production use.

## Project Store

All project sources and docs live under `src/souko/`:

```
src/souko/
├── projects.json        # Shared registry: { name → { sourceUrl, branch, head, lastUpdated } }
├── repo/                # git-cloned sources (one subdir per project, gitignored)
│   ├── openclaw/
│   └── ...
└── doc/                 # Generated doc sites (one subdir per project, gitignored)
    ├── openclaw/
    │   ├── top.json
    │   ├── flows.json
    │   ├── {Module}/
    │   │   ├── {Module}.json
    │   │   ├── .history/        # Historical snapshots
    │   │   ├── {Leaf}.md
    │   │   └── {SubModule}/...
    │   └── ...
    └── ...
```

## Pluggable Documentation

Each module's documentation is a self-contained unit. Three ways to edit it:

- **Via MCP tools** (recommended): `update_node` / `update_page` / `create_node` / `delete_node` — automatic version tracking and history snapshots; ideal for Code Agents
- **Direct file edits**: edit `.md` / `.json` under `src/souko/doc/{project}/`; restart the server to pick it up (bypasses version control)
- **Trigger an incremental update**: push a new commit upstream and resubmit the same git URL; the Updater Agent will detect the diff and patch the docs

## doc-drill: Native Code Agent Integration

autoDoc installs the thin [doc-drill](src/skill-template/SKILL.md) skill into the target repo's `.claude/skills/doc-drill/` and writes an `.mcp.json` pointing at the local MCP server. Any Code Agent can then:

- **Browse progressively** — `list_projects` → `get_top` → `get_graph` → `get_page`, lazy-loaded, context-efficient
- **Trace relationships** — follow the 6 semantic edge types to trace call chains and data flows
- **Keyword search** — `search_nodes` across all doc layers
- **Navigate business flows** — understand end-to-end interactions via `flows.json`
- **Maintain directly** — edit docs in place via mutate tools, and use `list_history` / `revert` to inspect or roll back

> This Agent-native integration is something DeepWiki (web chat only) and Google Code Wiki (web browsing only) do not offer.

## Tech Stack

| Layer | Stack |
|-------|-------|
| Backend | TypeScript, [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code), [OpenAI Codex SDK](https://github.com/openai/codex-sdk), [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk), Zod |
| Git subsystem | Direct `git` CLI calls via child_process — no third-party git dependency |
| Frontend | Vue 3, TypeScript, AntV G6, Vite |
| AI Chat | OpenAI API (gpt-4o or custom model) |
| Monorepo | pnpm workspaces |

## Project Structure

```
autoDoc/
├── src/
│   ├── server.ts                 # HTTP API + /mcp (same port, stateless transport)
│   ├── claude-proxy.ts           # Claude API internal forwarding proxy
│   ├── git/
│   │   └── repoManager.ts        # git CLI wrapper (clone / fetch / diff / projectNameFromUrl)
│   ├── souko/                    # Project store (repo + doc + shared registry)
│   │   ├── registry.ts           # projects.json read/write
│   │   ├── repo/                 # gitignored: cloned sources
│   │   ├── doc/                  # gitignored: generated doc sites
│   │   └── projects.json         # gitignored: shared registry
│   ├── mcp/                      # HTTP MCP server (same process as HTTP API)
│   │   ├── server.ts             # buildMcpServer(store)
│   │   ├── docStore.ts           # doc read/write + version + .history snapshots
│   │   ├── schema.ts             # Zod schemas (with version / pageVersions)
│   │   └── tools/{query,mutate}.ts
│   ├── agents/                   # Agent implementations (Claude + Codex)
│   │   ├── claude{scaffold,decomposer,writer,checker,flowanalyzer,updater}.ts
│   │   ├── codex{scaffold,decomposer,writer,checker,flowanalyzer,updater}.ts
│   │   ├── instructions/         # Agent prompts (Chinese + English)
│   │   │   ├── flowanalyzer.{ts,en.ts}
│   │   │   ├── updater.{ts,en.ts}
│   │   │   └── ...
│   │   └── schemas/schema.ts     # Zod output schemas (incl. UpdaterOutput)
│   ├── workflow/
│   │   └── arranger.ts           # Full-pipeline state machine
│   └── skill-template/
│       └── SKILL.md              # Thin doc-drill skill (points at /mcp)
├── scripts/
│   ├── setup-claude-proxy.sh
│   └── unwrap-md-json.mjs
├── web/                          # Vue 3 frontend
│   └── src/
│       ├── views/                # GraphPage, DocPage, HomePage (git URL input), FlowsPage
│       ├── components/           # ChatPanel, etc.
│       └── services/doc.ts       # API client (startRun → { ok, mode })
├── package.json
└── pnpm-workspace.yaml
```

## Utility Scripts

```bash
# Scan generated Markdown for nested JSON issues (check only)
pnpm docs:scan-md-json

# Auto-fix nested JSON issues
pnpm docs:fix-md-json
```

## Contributing

Issues and Pull Requests welcome! If autoDoc helps you, please consider giving it a Star.
