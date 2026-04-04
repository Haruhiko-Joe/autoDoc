# autoDoc

**[English](README.md)** | [中文](README.zh-CN.md) | [日本語](README.ja.md)

Point autoDoc at any code repository and get an interactive documentation site — automatically.

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
| Backend | TypeScript, [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk), Zod |
| Frontend | Vue 3, TypeScript, AntV G6, Vite |
| Monorepo | pnpm workspaces |

## Getting Started

### Prerequisites

- Node.js >= 18
- pnpm >= 10
- An Anthropic API key (`ANTHROPIC_API_KEY` environment variable)

### Install

```bash
git clone https://github.com/YanboQiao/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..
```

### Run

```bash
# Start both backend (port 3100) and frontend dev server
pnpm start

# Or run them separately:
pnpm dev              # Backend only
cd web && pnpm dev    # Frontend only (proxies /api to :3100)
```

Open the frontend, enter a repository path, and autoDoc will begin generating documentation.

### Build

```bash
cd web && pnpm build
```

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