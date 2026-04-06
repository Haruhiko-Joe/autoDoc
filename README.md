# autoDoc

**中文** | [English](README.en.md) | [日本語](README.ja.md)

将 autoDoc 指向任意代码仓库，自动生成一个可交互的文档站。

[伴侣skill](https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill)


autoDoc 使用 4 个 Claude AI Agent 组成的流水线，分析代码库、分解模块结构，生成基于图的可导航文档站。文档采用渐进式披露设计：从顶层架构总览出发，逐层深入至任意模块的详细 Markdown 文档。

## 工作原理

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
              完成                     完成
```

1. **Scaffold** — 分析整个仓库，生成顶层模块关系图，经 Checker 校验
2. **Decomposer** — 递归拆分每个模块为子图或叶子页面，经 Checker 校验
3. **Writer** — 为每个叶子节点生成详细的 Markdown 文档，经 Checker 校验
4. **Checker** — 在每个 Agent 完成后运行，校验图结构或文档质量（最多重试 3 次）

所有 Agent 由 **Arranger** 状态机统一调度，采用**滑动窗口并发模型**——并发 Claude 会话数可在前端配置（默认 8）。按节点管理状态，支持崩溃恢复。

## 生成的文档站

- **可交互有向图**（基于 [AntV G6](https://g6.antv.antgroup.com/)），展示模块间关系，支持多种边类型（调用、依赖、数据流、事件、继承、组合）
- **渐进式披露** — 点击任意图节点，进入子图或到达叶子 Markdown 文档
- **对话面板** — 在文档页对任意内容追问，通过 fork Agent 会话实现
- **实时进度** — 在首页实时查看文档生成进度

### Demo

| 顶层架构总览 | 子模块关系图 |
|:---:|:---:|
| ![overview](fig/overview.png) | ![module](fig/module.png) |

| Markdown 文档页 | 向 Agent 追问 |
|:---:|:---:|
| ![finalpage](fig/finalpage.png) | ![continuechat](fig/continuechat.png) |

## 文档可插拔

每个模块的文档都是自包含的独立单元——一个包含 Graph JSON 和 Markdown 文件的目录。你可以自由地增删替换任意模块，无需重新生成整个文档站。

- **拔** — 删除某个模块目录并移除父级 Graph JSON 中的引用，其余文档不受影响
- **插** — 创建新的模块目录（Graph JSON + Markdown），或将某个节点的 status 改为 `pending` 后重新运行 Arranger 自动生成
- **换** — 直接编辑或覆盖任意 Markdown 文件，只要节点 status 为 `done`，Arranger 不会覆盖它
- **增量生成** — 重新运行时，仅处理未完成的节点，已完成的模块全部跳过

> **注意：** Agent 会话历史仅保存在本地。如果你将生成的 `doc/` 文件分享给他人，对话追问功能（基于 Agent session fork）将不可用。图浏览和 Markdown 渲染不受影响。

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | TypeScript, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (via Claude Agent SDK), Zod |
| 前端 | Vue 3, TypeScript, AntV G6, Vite |
| 工程 | pnpm workspaces |

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 10
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 已安装且可正常运行（官方订阅、Claude Code API 或第三方 API 接入均可）

### 安装

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install
cd web && pnpm install && cd ..
```

### 运行

```bash
# 同时启动后端（端口 3100）和前端开发服务器
pnpm start
```

打开前端页面，输入仓库路径，autoDoc 即开始生成文档。

## 项目结构

```
autoDoc/
├── src/
│   ├── agents/              # 4 个 Claude Agent
│   │   ├── scaffold.ts      # 顶层仓库分析
│   │   ├── decomposer.ts    # 递归模块拆分
│   │   ├── writer.ts        # Markdown 文档生成
│   │   ├── checker.ts       # 质量校验
│   │   ├── instructions/    # Agent 提示词（中文）
│   │   └── schemas/         # Zod 结构化输出 schema
│   ├── workflow/
│   │   └── arranger.ts      # 流水线调度状态机
│   └── server.ts            # API 服务器
├── web/                     # Vue 3 前端
│   ├── src/
│   │   ├── views/           # GraphPage, DocPage, HomePage
│   │   └── services/        # API 客户端
│   └── doc/                 # 生成的文档输出目录
├── package.json
└── pnpm-workspace.yaml
```

## 许可证

Apache-2.0
