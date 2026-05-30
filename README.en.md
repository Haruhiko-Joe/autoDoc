<p align="center">
  <h1 align="center">ACCEED</h1>
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

## Why ACCEED?

> The three great standards of a documentation site are readability, interactivity, and maintainability. Among these, readability serves as the most fundamental requirement for humans and agents alike to comprehend code, and in the realm of software engineering, it is regarded as the prerequisite that takes priority above all other development activities. Through reading documentation, developers can obtain a holistic understanding of a codebase; and if that documentation further provides structured hierarchical navigation and typed module relationships, this understanding undergoes a qualitative transcendence. In today's world, there indeed exist developers and Agents that devote their entire passion to the pursuit of this ultimate documentation experience — and the documentation system capable of bearing such devotion, we call a **knowledge foundation**. ACCEED exists specifically for those developers and Agents that have grown weary of the commonplace flat text, per-file comments, and shallow RAG retrieval fragments found throughout the world — providing them with a knowledge foundation befitting their caliber.

| | ACCEED | DeepWiki | Google Code Wiki |
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

Paste a git URL in the frontend and generation begins. **For the full onboarding walkthrough — prerequisites, first generation, incremental updates, MCP wiring — see [USAGE.md](docs/USAGE.md).**

### Codex Profile Configuration

The Codex backend uses [profiles](https://developers.openai.com/codex/config-reference) per Agent role to isolate model parameters. Add one profile per role to `~/.codex/config.toml`. Names must be exactly `scaffold`, `decomposer`, `writer`, `checker`, `flowanalyzer`, `prupdater`, `knowledge`:

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

[profiles.prupdater]
model = "gpt-5.4"
model_reasoning_effort = "high"

[profiles.knowledge]
model = "gpt-5.4"
model_reasoning_effort = "medium"
```

Replace models or tweak `model_reasoning_effort` / `service_tier` as needed. See the official [Config Reference](https://developers.openai.com/codex/config-reference) for all keys.

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
                └───────► Assemble MCP / Skill ◄────┘
                                       │
                                       ▼
                                Flow Analyzer
                                       │
                                       ▼
                       projects.json + src/souko/doc/{name}
```

### Incremental update: PR-driven

```
Manual trigger POST /api/update/start
         │
         ▼
  UpdateOrchestrator (per-project lock)
         │
  git fetch origin main → read lastProcessedSha (cursor)
         │
  ┌──────┴───────┐
  │ GitHub repo  │ Non-GitHub
  │ gh pr list   │ git log
  │ --state merged│ --first-parent
  └──────┬───────┘
         │
    PR/Commit queue (oldest first)
         │
    for each task (serial):
      PrUpdater Agent + MCP tools
         │
  ┌──────┴───────┐
  │ Auto mode    │ Manual mode
  │ → done       │ → awaiting-review
  │ → next       │ → Accept / follow-up
  └──────────────┘
         │
    advance cursor → next task
```

| Agent | Role | Validation |
|-------|------|------------|
| **Scaffold** | Analyzes the whole repo, emits the top-level module graph | Validated by Checker |
| **Decomposer** | Recursively splits modules into sub-graphs or leaf pages | Validated by Checker (up to 5 retries) |
| **Writer** | Generates detailed Markdown for each leaf node | — |
| **Checker** | Validates graph structure integrity from Scaffold and Decomposer | — |
| **Flow Analyzer** | Extracts 3–7 typical cross-module interaction flows | — |
| **PrUpdater** | Per-PR agent: navigates docs via MCP tools, applies targeted edits (impact assessment → locate → patch_page / update_page) | Manual review gate |

Full-pipeline Agents are orchestrated by the **Arranger** state machine with a **sliding-window concurrency model** — the concurrency level is configurable from the frontend (default 8). State is tracked per node with full crash recovery. **PrUpdater** is a separate incremental channel that works at PR granularity: the agent receives commit metadata + diff, navigates the doc tree via MCP tools (`get_top` → `search_nodes` → `get_page` → `patch_page`), and makes targeted edits. In Manual mode every PR passes through a user review gate with session continuation for iterative refinement.

### Hybrid AI Backends

Each Agent role independently uses **Claude** (Claude Agent SDK) or **Codex** (OpenAI Codex SDK), configurable from the frontend panel:

| Role | Default Backend |
|------|----------------|
| Scaffold | Codex |
| Decomposer | Codex |
| Writer | Codex |
| Checker | Claude |
| Flow Analyzer | Codex |
| Updater | Codex |

## Key Features

- **🔗 One-step git URL ingestion** — paste an SSH/HTTPS git URL; backend auto-clones, tracks the main branch head, keeps everything under `src/souko/`
- **🔁 Per-PR incremental updates** — discovers all newly merged PRs via `gh pr list` (or `git log` fallback) and PrUpdater Agent navigates docs via MCP tools for targeted edits. Auto mode runs hands-free; Manual mode adds a review gate with session continuation for iterative refinement
- **🧭 Human decomposition review** — optionally pause after Scaffold / Decomposer outputs, edit the graph directly, approve it, or rerun decomposition with feedback
- **🧠 Knowledge Elicitor** — before first generation, chat with an Agent to create `knowledge.md` and inject domain context / decomposition preferences into downstream Agents
- **🛰️ HTTP MCP server** — same-process `/mcp` endpoint (Streamable HTTP) exposes the full query + mutate toolset for direct Code Agent access
- **📜 Manual Git commits and blame** — doc writes only create uncommitted changes; the Git panel shows dirty status, commits manually, and surfaces Git blame in preview/editing views
- **🔗 Interactive directed graphs** — [AntV G6](https://g6.antv.antgroup.com/) with 6 semantic edge types (calls, depends, data-flow, event, extends, composes), hover popovers, node filtering, and focus mode
- **🔍 Progressive disclosure** — start at the top-level overview, drill into nodes down to leaf Markdown
- **🔄 Interaction flow diagrams** — cross-module business flows auto-extracted and rendered as sequence diagrams with participants, steps, and code references
- **🔎 Module search** — sidebar search over all modules
- **💬 AI chat panel** — floating chat window for doc follow-ups (requires `OPENAI_API_KEY`)
- **🌙 Dark mode** — low-distraction dark interface
- **📊 Real-time progress** — live generation progress on the home page (distinguishes initial / incremental / noop modes)
- **🌐 Multi-language** — generate Chinese (default) or English doc sites

## HTTP MCP Interface

The backend exposes an MCP server named `acceed` at `http://localhost:3100/mcp` as a stateless Streamable HTTP transport. All tools operate on real files under `src/souko/doc/{project}/`.

### Wire it up in Claude Code / Codex

Drop an `.mcp.json` into the target repo root:

```json
{
  "mcpServers": {
    "acceed": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Codex uses project-scoped `.codex/config.toml`; ACCEED writes the equivalent config when assembling the skill:

```toml
[mcp_servers.acceed]
url = "http://localhost:3100/mcp"
enabled_tools = ["list_projects", "get_top", "get_flows", "get_graph", "get_page", "search_nodes", "list_source_files", "read_source_files", "list_docs", "read_docs", "patch_page", "update_page", "update_node", "update_graph_meta", "create_node", "delete_node", "update_top"]
```

The matching [doc-drill skill](src/skill-template/SKILL.md) is a thin instruction set that only describes **how to call the MCP tools**, and ships with ACCEED.

### Tool list

#### Query (no side effects)

| Tool | Purpose |
|---|---|
| `list_projects` | List available doc projects (name / description) |
| `get_top` | Read a project's top.json |
| `get_flows` | Read typical cross-module flows to understand classic module collaboration cases |
| `get_graph` | Read a sub-graph with `codeScope`, `nodes`, and `description` |
| `get_page` | Read a leaf Markdown page |
| `search_nodes` | Search node names/descriptions across all levels |
| `list_source_files` / `read_source_files` | Locate and read source files by regex |
| `list_docs` / `read_docs` | Batch-list/read raw docs by nodeId |

#### Mutate (serialized by project lock)

| Tool | Purpose |
|---|---|
| `update_top` | Update top.json's description / nodes |
| `update_graph_meta` | Update a sub-graph's description / codeScope |
| `create_node` | Append a node to a parent graph (page → creates an empty md; graph → creates a sub-graph placeholder) |
| `update_node` | Update a node's name / description / codeScope / edges in its parent graph |
| `delete_node` | Remove a node from its parent graph (page deletes the md; graph recursively deletes its subtree) |
| `patch_page` | Targeted string-match-and-replace edits to a leaf md, more efficient and safer than update_page |
| `update_page` | Overwrite a leaf md |

Write flow: **read → mutate tools dirty the working tree → review dirty status in the frontend Git panel → user commits manually**. Mutate tools only leave documentation working-tree changes; concurrent writes are serialized by the project-level lock.

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
    │   │   ├── {Leaf}.md
    │   │   └── {SubModule}/...
    │   └── ...
    └── ...
```

## Pluggable Documentation

Each module's documentation is a self-contained unit. Three ways to edit it:

- **Via MCP tools** (recommended): `update_node` / `update_page` / `create_node` / `delete_node` — writes dirty the doc working tree and wait for a manual commit in the frontend Git panel
- **Direct file edits**: edit `.md` / `.json` under `src/souko/doc/{project}/`; refresh to pick it up and show it as uncommitted
- **Trigger an incremental update**: click the Update button on the home page; PrUpdater Agent automatically discovers all newly merged PRs and processes them one by one. Manual mode gates each PR behind a review confirmation

## doc-drill: Native Code Agent Integration

After the initial documentation content is complete, ACCEED installs the thin [doc-drill](src/skill-template/SKILL.md) skill into the target repo's `.codex/skills/doc-drill/SKILL.md`, then writes Claude Code's `.mcp.json` and Codex's `.codex/config.toml` to point at the local HTTP MCP server. `get_flows` is registered at this point; before Flow Analyzer writes `flows.json`, it reports that flows have not been generated yet, and after that the same tool serves the end-to-end flows. Any Code Agent can then:

- **Browse progressively** — `list_projects` → `get_top` → `get_graph` → `get_page`, lazy-loaded, context-efficient
- **Trace relationships** — follow the 6 semantic edge types to trace call chains and data flows
- **Keyword search** — `search_nodes` across all doc layers
- **Navigate business flows** — understand end-to-end interactions via `get_flows` / `flows.json`
- **Maintain directly** — edit docs in place via mutate tools, then let the user commit from ACCEED's frontend Git panel

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
ACCEED/
├── src/
│   ├── server.ts                 # HTTP API + /mcp (same port, stateless transport)
│   ├── git/
│   │   ├── repoManager.ts        # git CLI wrapper (clone / fetch / diff / projectNameFromUrl)
│   │   └── prDiscovery.ts         # Discover merged PRs (gh pr list) or commits (git log fallback)
│   ├── souko/                    # Project store (repo + doc + shared registry)
│   │   ├── registry.ts           # projects.json read/write
│   │   ├── repo/                 # gitignored: cloned sources
│   │   ├── doc/                  # gitignored: generated doc sites
│   │   └── projects.json         # gitignored: shared registry
│   ├── mcp/                      # HTTP MCP server (same process as HTTP API)
│   │   ├── server.ts             # buildMcpServer(store)
│   │   ├── docStore.ts           # doc read/write + project-level lock
│   │   ├── docGit.ts             # doc Git status / commit / blame
│   │   ├── schema.ts             # Zod schemas
│   │   └── tools/{query,mutate}.ts
│   ├── agents/                   # Agent implementations (Claude + Codex)
│   │   ├── tsukai/               # All Agent classes (barrel: index.ts)
│   │   │   ├── claude{scaffold,decomposer,writer,checker,flowanalyzer,prupdater}.ts
│   │   │   └── codex{scaffold,decomposer,writer,checker,flowanalyzer,prupdater}.ts
│   │   ├── instructions/         # Agent prompts
│   │   │   ├── cn/               # Chinese prompts
│   │   │   └── en/               # English prompts
│   │   └── schemas/schema.ts     # Zod output schemas (incl. UpdaterOutput)
│   ├── workflow/
│   │   ├── arranger.ts           # Full-pipeline state machine
│   │   └── updateOrchestrator.ts  # PR-driven incremental update orchestrator
│   └── skill-template/
│       └── SKILL.md              # Thin doc-drill skill (points at /mcp)
├── web/                          # Vue 3 frontend
│   └── src/
│       ├── views/                # HomePage, GraphPage (graph + doc preview/edit), FlowsPage, KnowledgePage
│       ├── components/           # ChatPanel, etc.
│       └── services/doc.ts       # API client (run/status/doc/search/chat/update/knowledge/doc-git)
├── package.json
└── pnpm-workspace.yaml
```

## Contributing

ACCEED is currently in a rapid prototyping phase and may ship breaking changes frequently. If you'd like to propose a new feature, please open an Issue first so we can align on the roadmap. Individual developers are welcome to fork and build on this project, subject to the terms of the [LICENSE](LICENSE) (AGPL-3.0).

Because this project uses a dual-licensing model ("AGPL-3.0 open source + commercial license"), every external contribution must be covered by the [Contributor License Agreement](docs/CLA.md) before it can be merged. CLA Assistant will walk you through signing on your first PR; a single signature covers all of your future contributions.

**All Issues must be submitted in Chinese (中文).** Issues in any other language will be closed without a response.

Issues and Pull Requests welcome! If ACCEED helps you, please consider giving it a Star.

## License & Commercial Licensing

ACCEED is offered under a dual-licensing model:

- **Open-source license**: [GNU AGPL-3.0-only](LICENSE). Free to use, modify, and redistribute — but **any modified version or derivative work, including deployments that expose functionality over a network, must release its complete corresponding source code to every user of that service under AGPL-3.0** (AGPL-3.0 §13).
- **Commercial license**: if you cannot or do not wish to comply with AGPL-3.0's copyleft obligations (for example, integrating ACCEED into a closed-source product, or operating it as a SaaS without disclosing your modifications), you must obtain a written commercial license from the author in advance. See [COMMERCIAL-LICENSE.md](docs/COMMERCIAL-LICENSE.md).

### How to obtain a commercial license

Commercial licenses are granted in two tiers, based on the size of the using entity:

**Tier 1 — Companies with market capitalization or latest valuation below RMB 1 billion**

Have employees of the company Star this repository as a public acknowledgement of the project. **Every 5 GitHub Stars from identifiable employees of the company grants that company one (1) year of commercial license.** Stars must come from GitHub accounts that can be identified as employees of the company (through public profile information naming the employer, or through verification via a company email). The license term runs from the date of the most recent qualifying Star; it must be re-accumulated after expiration.

**Tier 2 — Companies with market capitalization or latest valuation at or above RMB 1 billion**

Extend a formal employment offer to the author. Internship offers (including part-time / 日常实习) are equally valid. The rules:

1. **If the author accepts employment with the company in any form, the company automatically receives a perpetual commercial license** covering all past and future use, modification, distribution, and derivative works.
2. **The author not accepting the offer does not mean the license is denied.** The author will evaluate factors such as position, base compensation, and location before deciding whether to join; even if the author ultimately does not join, a perpetual commercial license will still be granted as long as the offer is **sincere, commercially reasonable, and explicitly acknowledges the value of this project**.
3. The author reserves the right of final interpretation. Offers that are substantially below market rates or attached to unreasonable conditions do not constitute valid consideration.

### Contact

- **Commercial licensing & offers**: `joeyanbo608@gmail.com`
- **Suggested subject line**: `[ACCEED Commercial License] <your company>` or `[ACCEED Offer] <your company>`

In your first message, please include the company name, size, intended use case, and expected deployment scope so the applicable tier and next steps can be determined.
