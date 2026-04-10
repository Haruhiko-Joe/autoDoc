<p align="center">
  <h1 align="center">autoDoc</h1>
  <p align="center">
    <strong>将任意代码仓库，自动转化为可交互的文档站</strong>
  </p>
  <p align="center">
    5 个 AI Agent 协作 · 迭代验证 · 交互式架构图 · 崩溃恢复 · 渐进式披露
  </p>
  <p align="center">
    <strong>中文</strong> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a>
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
  <a href="https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill">📘 伴侣 Skill: doc-drill</a>
</p>

---

## 为什么选择 autoDoc？

与 DeepWiki、Google Code Wiki 等竞品不同，autoDoc 不只是"单次生成一堆文档"——它是一个**带质量闭环的多 Agent 文档工厂**。

| | autoDoc | DeepWiki | Google Code Wiki |
|---|:---:|:---:|:---:|
| 多 Agent 迭代验证 | **✅ 5 Agent + Checker 循环** | ❌ 单次生成 | ❌ 单次生成 |
| 交互式架构图 | **✅ 6 种语义边 + 悬浮详情** | ❌ 静态 Mermaid | ❌ 静态图 |
| 递归自适应分解 | **✅ Agent 自主决定深度** | ❌ 固定层级 | ❌ 扁平结构 |
| 崩溃恢复 | **✅ Session ID + pending 暂存** | ❌ | ❌ |
| Code Agent 集成 | **✅ doc-drill Skill** | ❌ | ❌ |
| 混合 AI 后端 | **✅ 每角色可选 Claude/Codex** | ❌ | ❌ |
| 开源自托管 | **✅** | ❌ | ❌ |

## Demo

| 顶层架构总览 | 子模块关系图 |
|:---:|:---:|
| ![overview](fig/overview.png) | ![module](fig/module.png) |

| Markdown 文档页 | 向 AI 追问 |
|:---:|:---:|
| ![finalpage](fig/finalpage.png) | ![continuechat](fig/continuechat.png) |

| 交互流程图 |
|:---:|
| ![interactiveflow](fig/interactiveflow.png) |

## 工作原理

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
 Assemble Skill ─────► Flow Analyzer ──► 完成
```

| Agent | 职责 | 验证 |
|-------|------|------|
| **Scaffold** | 分析整个仓库，生成顶层模块关系图 | Checker 校验 |
| **Decomposer** | 递归拆分模块为子图或叶子页面 | Checker 校验（最多重试 5 次） |
| **Writer** | 为每个叶子节点生成详细 Markdown 文档 | — |
| **Checker** | 校验图结构完整性和内容质量 | — |
| **Flow Analyzer** | 提取 3–7 条典型业务交互流程 | — |

所有 Agent 由 **Arranger** 状态机统一调度，采用**滑动窗口并发模型**——并发会话数可在前端配置（默认 8）。按节点管理状态，支持崩溃恢复。

### Agent 后端可选

每个 Agent 角色可独立选择 **Claude**（Claude Agent SDK）或 **Codex**（OpenAI Codex SDK）作为后端，在前端配置面板中逐个调整：

| 角色 | 默认后端 |
|------|---------|
| Scaffold | Claude |
| Decomposer | Claude |
| Writer | Claude |
| Checker | Codex |
| Flow Analyzer | Claude |

## 核心特性

- **🔗 交互式有向图** — 基于 [AntV G6](https://g6.antv.antgroup.com/)，支持 6 种语义边类型（调用、依赖、数据流、事件、继承、组合），边悬浮弹窗展示关系详情
- **🔍 渐进式披露** — 从顶层架构总览出发，点击节点逐层深入至叶子 Markdown 文档
- **🔄 交互流程图** — 自动提取跨模块业务流程，以时序图形式展示参与者、步骤和代码引用
- **🔎 模块搜索** — 在侧边栏搜索框中快速检索任意模块
- **💬 AI 对话面板** — 悬浮式聊天窗口，对文档内容追问（需配置 `OPENAI_API_KEY`）
- **🌙 深色模式** — Tokyo Night 主题，一键切换
- **📊 实时进度** — 在首页实时查看文档生成进度
- **🌐 多语言** — 支持生成中文（默认）或英文文档站

## 文档可插拔

每个模块的文档是自包含的独立单元。你可以自由增删替换任意模块，无需重新生成整个文档站。

- **拔** — 删除模块目录并移除父级 Graph JSON 中的引用
- **插** — 创建新模块目录，或将节点 status 改为 `pending` 后重新运行
- **换** — 直接编辑任意 Markdown 文件，`done` 状态的节点不会被覆盖
- **增量生成** — 重新运行时仅处理未完成的节点

## doc-drill: Code Agent 原生集成

autoDoc 生成完成后，自动将 [doc-drill](https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill) Skill 安装到目标仓库的 `.claude/skills/` 目录。任何 Code Agent 都能通过它：

- **渐进式浏览** — 从顶层模块逐步深入到实现细节（lazy-load，节省上下文）
- **关系追踪** — 沿 6 种语义边追踪模块间调用链和数据流
- **关键词搜索** — 跨所有文档层级搜索
- **业务流程导航** — 通过 `flows.json` 理解端到端交互场景

> 这是 DeepWiki（仅网页 Chat）和 Google Code Wiki（仅网页浏览）不具备的 Agent-native 集成能力。

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 10
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 已安装且可正常运行（官方订阅、Claude Code API 或第三方 API 接入均可）
- （可选）`OPENAI_API_KEY` — 启用 AI 对话面板和 Codex 后端

### 安装与运行

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..

# 同时启动后端（端口 3100）和前端开发服务器
pnpm start
```

打开前端页面，输入仓库路径，选择语言和 Agent 后端配置，即可开始生成。

### 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥，用于对话面板和 Codex 后端 | 对话面板/Codex 后端需要 |
| `OPENAI_BASE_URL` | 自定义 OpenAI API 端点 | 否 |
| `OPENAI_MODEL` | 对话面板使用的模型（默认 `gpt-4o`） | 否 |

### Claude Code 内网代理

如果你的网关要求使用内部 endpoint model（例如 `ep-...`），可以一键启动本地转发代理：

```bash
pnpm proxy:claude:setup -- \
  --model ep-xxxxx \
  --base-url https://your-gateway.example.com/api/v1 \
  --api-key <your_token>
```

然后在另一个终端执行：

```bash
unset ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/v1
export ANTHROPIC_API_KEY=<your_token>
claude --model "claude-opus-4-6"
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | TypeScript, [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code), [OpenAI Codex SDK](https://github.com/openai/codex-sdk), Zod |
| 前端 | Vue 3, TypeScript, AntV G6, Vite |
| AI 对话 | OpenAI API（gpt-4o 或自定义模型） |
| 工程 | pnpm workspaces |

## 项目结构

```
autoDoc/
├── src/
│   ├── agents/              # 5 个 Agent（Claude + Codex 双实现）
│   │   ├── scaffold.ts      # 顶层仓库分析（Claude）
│   │   ├── decomposer.ts    # 递归模块拆分（Claude）
│   │   ├── writer.ts        # Markdown 文档生成（Claude）
│   │   ├── checker.ts       # 图结构校验（Claude）
│   │   ├── claudeflowanalyzer.ts  # 交互流程分析（Claude）
│   │   ├── codex*.ts        # 各 Agent 的 Codex 实现
│   │   ├── instructions/    # Agent 提示词（中文 + 英文）
│   │   └── schemas/         # Zod 结构化输出 schema
│   ├── workflow/
│   │   └── arranger.ts      # 流水线调度状态机
│   ├── skill-template/      # 生成的 Claude Code skill 模板
│   ├── claude-proxy.ts      # Claude API 内网转发代理
│   └── server.ts            # API 服务器
├── scripts/
│   ├── setup-claude-proxy.sh    # 代理守护进程启动脚本
│   └── unwrap-md-json.mjs       # Markdown JSON 修复工具
├── web/                     # Vue 3 前端
│   ├── src/
│   │   ├── views/           # GraphPage, DocPage, HomePage, FlowsPage
│   │   ├── components/      # ChatPanel 等组件
│   │   ├── composables/     # useTheme 等组合式函数
│   │   └── services/        # API 客户端
│   └── doc/                 # 生成的文档输出目录
├── package.json
└── pnpm-workspace.yaml
```

## 实用脚本

```bash
# 扫描生成的 Markdown 中嵌套 JSON 问题（仅检查）
pnpm docs:scan-md-json

# 自动修复嵌套 JSON 问题
pnpm docs:fix-md-json
```

## Contributing

欢迎提交 Issue 和 Pull Request！如果 autoDoc 对你有帮助，请给一个 Star 支持。