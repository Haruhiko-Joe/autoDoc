# autoDoc

[中文](README.md) | **English** | [日本語](README.ja.md)

Point autoDoc at any code repository and get an interactive documentation site — automatically.

[Companion skill](https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill)

autoDoc uses a pipeline of 4 Claude AI agents to analyze your codebase, decompose it into modules, and generate a navigable, graph-based documentation site with progressive disclosure: start from a high-level architecture overview and drill down into any module until you reach detailed Markdown docs.

## How It Works

```
Scaffold ──► Checker
                │
    ┌───────────┴───────────┐
    ▼                       ▼
Decomposer ──► Checker   Decomposer ──► Checker   ...
                │                       │
                ▼                       ▼
  Writer ──► Checker       Writer ──► Checker
                │                       │
                ▼                       ▼
              Done                    Done
```

1. **Scaffold** — Analyzes the entire repo, produces a top-level module graph, validated by Checker
2. **Decomposer** — Recursively splits each module into sub-graphs or leaf pages, validated by Checker
3. **Writer** — Generates detailed Markdown documentation for each leaf node, validated by Checker
4. **Checker** — Runs after every agent; validates graph structure or content quality (max 3 retries)

All agents are orchestrated by the **Arranger** state machine with a **sliding-window concurrency model** — the number of concurrent Claude sessions is configurable from the frontend (default 8). The Arranger manages state per node and supports crash recovery.

## Output

The generated documentation site features:

- **Interactive directed graphs** (powered by [AntV G6](https://g6.antv.antgroup.com/)) showing module relationships with typed edges (calls, depends, data-flow, event, extends, composes)
- **Progressive disclosure** — click any graph node to drill into sub-graphs or reach leaf Markdown docs
- **Chat panel** — ask follow-up questions about any doc page by forking the agent session
- **Real-time progress** — watch documentation generation progress from the home page

### Demo

| Architecture Overview | Sub-module Graph |
|:---:|:---:|
| ![overview](fig/overview.png) | ![module](fig/module.png) |

| Markdown Doc Page | Chat with Agent |
|:---:|:---:|
| ![finalpage](fig/finalpage.png) | ![continuechat](fig/continuechat.png) |

## Pluggable Documentation

Each module's documentation is a self-contained unit — a directory with its own Graph JSON and Markdown files. You can freely add, remove, or replace any module without regenerating the entire site.

- **Remove** — delete a module directory and its reference in the parent Graph JSON; the rest of the site remains intact
- **Add** — create a new module directory with Graph JSON + Markdown, or set a node's status to `pending` and re-run the Arranger to generate it
- **Replace** — directly edit or overwrite any Markdown file; as long as the node status is `done`, the Arranger will not touch it
- **Incremental re-generation** — on re-run, only nodes that are not `done` are processed; completed modules are skipped entirely

> **Note:** Agent session history is stored locally only. If you share the generated `doc/` files with others, the interactive chat feature (which forks from agent sessions) will not be available to them. Graph navigation and Markdown rendering work normally.

## Tech Stack

| Layer | Stack |
|-------|-------|
| Backend | TypeScript, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (via Claude Agent SDK), Zod |
| Frontend | Vue 3, TypeScript, AntV G6, Vite |
| Monorepo | pnpm workspaces |

## Getting Started

### Prerequisites

- Node.js >= 18
- pnpm >= 10
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and working (official subscription, Claude Code API, or third-party API integration — any will do)

### Install

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..
```

### Run

```bash
# Start both backend (port 3100) and frontend dev server
pnpm start
```

Open the frontend, enter a repository path, and autoDoc will begin generating documentation.


## Project Structure

```
autoDoc/
├── src/
│   ├── agents/              # 4 Claude agents
│   │   ├── scaffold.ts      # Top-level repo analysis
│   │   ├── decomposer.ts    # Recursive module splitting
│   │   ├── writer.ts        # Markdown doc generation
│   │   ├── checker.ts       # Quality validation
│   │   ├── instructions/    # Agent prompts (Chinese)
│   │   └── schemas/         # Zod schemas for structured output
│   ├── workflow/
│   │   └── arranger.ts      # Pipeline orchestration state machine
│   └── server.ts            # API server
├── web/                     # Vue 3 frontend
│   ├── src/
│   │   ├── views/           # GraphPage, DocPage, HomePage
│   │   └── services/        # API client
│   └── doc/                 # Generated documentation output
├── package.json
└── pnpm-workspace.yaml
```

## License

Apache-2.0
