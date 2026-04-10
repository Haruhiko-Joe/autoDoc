<p align="center">
  <h1 align="center">autoDoc</h1>
  <p align="center">
    <strong>Turn any code repository into an interactive documentation site — automatically.</strong>
  </p>
  <p align="center">
    5 AI Agents · Iterative Validation · Interactive Architecture Graphs · Crash Recovery · Progressive Disclosure
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
  <a href="https://github.com/Haruhiko-Joe/autoDoc/stargazers"><img src="https://img.shields.io/github/stars/Haruhiko-Joe/autoDoc?style=social" alt="Stars"></a>
</p>

<p align="center">
  <a href="https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill">📘 Companion Skill: doc-drill</a>
</p>

---

## Why autoDoc?

Unlike DeepWiki, Google Code Wiki, and similar tools that generate docs in a single pass, autoDoc is a **multi-agent documentation factory with a quality feedback loop**.

| | autoDoc | DeepWiki | Google Code Wiki |
|---|:---:|:---:|:---:|
| Multi-agent iterative validation | **5 Agents + Checker loop** | Single pass | Single pass |
| Interactive architecture graphs | **6 semantic edge types + hover details** | Static Mermaid | Static diagrams |
| Recursive adaptive decomposition | **Agent decides depth autonomously** | Fixed levels | Flat structure |
| Crash recovery | **Session ID + pending staging** | No | No |
| Code Agent integration | **doc-drill Skill** | No | No |
| Hybrid AI backends | **Per-role Claude/Codex selection** | No | No |
| Open source & self-hosted | **Yes** | No | No |

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

## How It Works

```
Scaffold ──► Checker
                │
    ┌───────────┴───────────┐
    ▼                       ▼
Decomposer ──► Checker   Decomposer ──► Checker   ...
    │                       │
    ▼                       ▼
 Writer                  Writer
    │                       │
    ▼                       ▼
 Assemble Skill ─────► Flow Analyzer ──► Done
```

| Agent | Role | Validation |
|-------|------|------------|
| **Scaffold** | Analyzes the entire repo, produces a top-level module graph | Validated by Checker |
| **Decomposer** | Recursively splits modules into sub-graphs or leaf pages | Validated by Checker (up to 5 retries) |
| **Writer** | Generates detailed Markdown docs for each leaf node | — |
| **Checker** | Validates graph structure integrity and content quality | — |
| **Flow Analyzer** | Extracts 3–7 typical cross-module interaction flows | — |

All agents are orchestrated by the **Arranger** state machine with a **sliding-window concurrency model** — the number of concurrent sessions is configurable from the frontend (default 8). State is managed per node with full crash recovery support.

### Hybrid AI Backends

Each agent role can independently use **Claude** (Claude Agent SDK) or **Codex** (OpenAI Codex SDK) as its backend, configurable from the frontend panel:

| Role | Default Backend |
|------|----------------|
| Scaffold | Claude |
| Decomposer | Claude |
| Writer | Claude |
| Checker | Codex |
| Flow Analyzer | Claude |

## Key Features

- **Interactive Directed Graphs** — Powered by [AntV G6](https://g6.antv.antgroup.com/) with 6 semantic edge types (calls, depends, data-flow, event, extends, composes) and hover popovers showing relationship details
- **Progressive Disclosure** — Start from the top-level architecture overview, click nodes to drill down layer by layer to leaf Markdown docs
- **Interaction Flow Diagrams** — Automatically extracted cross-module business flows, rendered as sequence diagrams with participants, steps, and code references
- **Module Search** — Quick search across all modules in the sidebar
- **AI Chat Panel** — Floating chat window for follow-up questions on doc content (requires `OPENAI_API_KEY`)
- **Dark Mode** — Tokyo Night theme, one-click toggle
- **Real-time Progress** — Watch documentation generation progress live from the home page
- **Multi-language** — Generate docs in Chinese (default) or English

## Pluggable Documentation

Each module's documentation is a self-contained unit. Freely add, remove, or replace any module without regenerating the entire site.

- **Remove** — Delete a module directory and its reference in the parent Graph JSON
- **Add** — Create a new module directory, or set a node's status to `pending` and re-run
- **Replace** — Directly edit any Markdown file; nodes with `done` status won't be overwritten
- **Incremental** — On re-run, only incomplete nodes are processed

## doc-drill: Native Code Agent Integration

After generation, autoDoc automatically installs the [doc-drill](https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill) Skill into the target repo's `.claude/skills/` directory. Any Code Agent can then:

- **Browse progressively** — Drill from top-level modules down to implementation details (lazy-load, context-efficient)
- **Trace relationships** — Follow 6 semantic edge types to trace call chains and data flows
- **Search by keyword** — Search across all documentation layers
- **Navigate business flows** — Understand end-to-end interaction scenarios via `flows.json`

> This Agent-native integration is something DeepWiki (web chat only) and Google Code Wiki (web browsing only) cannot offer.

## Getting Started

### Prerequisites

- Node.js >= 18
- pnpm >= 10
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and working (official subscription, Claude Code API, or third-party API — any will do)
- (Optional) `OPENAI_API_KEY` — enables the AI chat panel and Codex backend

### Install & Run

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..

# Start both backend (port 3100) and frontend dev server
pnpm start
```

Open the frontend, enter a repository path, select language and agent backend configuration, and generation begins.

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | OpenAI API key for chat panel and Codex backend | For chat/Codex |
| `OPENAI_BASE_URL` | Custom OpenAI API endpoint | No |
| `OPENAI_MODEL` | Model for chat panel (default `gpt-4o`) | No |

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

## Tech Stack

| Layer | Stack |
|-------|-------|
| Backend | TypeScript, [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code), [OpenAI Codex SDK](https://github.com/openai/codex-sdk), Zod |
| Frontend | Vue 3, TypeScript, AntV G6, Vite |
| AI Chat | OpenAI API (gpt-4o or custom model) |
| Monorepo | pnpm workspaces |

## Project Structure

```
autoDoc/
├── src/
│   ├── agents/              # 5 Agents (Claude + Codex dual implementations)
│   │   ├── scaffold.ts      # Top-level repo analysis (Claude)
│   │   ├── decomposer.ts    # Recursive module splitting (Claude)
│   │   ├── writer.ts        # Markdown doc generation (Claude)
│   │   ├── checker.ts       # Graph structure validation (Claude)
│   │   ├── claudeflowanalyzer.ts  # Interaction flow analysis (Claude)
│   │   ├── codex*.ts        # Codex implementations for each Agent
│   │   ├── instructions/    # Agent prompts (Chinese + English)
│   │   └── schemas/         # Zod structured output schemas
│   ├── workflow/
│   │   └── arranger.ts      # Pipeline orchestration state machine
│   ├── skill-template/      # Generated Claude Code skill template
│   ├── claude-proxy.ts      # Claude API internal proxy
│   └── server.ts            # API server
├── scripts/
│   ├── setup-claude-proxy.sh    # Proxy daemon startup script
│   └── unwrap-md-json.mjs       # Markdown JSON fix utility
├── web/                     # Vue 3 frontend
│   ├── src/
│   │   ├── views/           # GraphPage, DocPage, HomePage, FlowsPage
│   │   ├── components/      # ChatPanel, etc.
│   │   ├── composables/     # useTheme, etc.
│   │   └── services/        # API client
│   └── doc/                 # Generated documentation output
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

Issues and Pull Requests are welcome! If autoDoc helps you, please consider giving it a Star.