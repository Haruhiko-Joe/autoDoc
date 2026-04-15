<p align="center">
  <h1 align="center">autoDoc</h1>
  <p align="center">
    <strong>粘一条 git URL，自动产出可交互、可增量更新、可被 Agent 直接读写的文档站</strong>
  </p>
  <p align="center">
    5 + 1 个 AI Agent 协作 · 迭代验证 · git diff 增量更新 · HTTP MCP 接口 · 交互式架构图 · 崩溃恢复 · 渐进式披露
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
  <img src="https://img.shields.io/badge/MCP-Streamable_HTTP-512BD4" alt="MCP">
  <a href="https://github.com/Haruhiko-Joe/autoDoc/stargazers"><img src="https://img.shields.io/github/stars/Haruhiko-Joe/autoDoc?style=social" alt="Stars"></a>
</p>

<p align="center">
  <a href="https://github.com/Haruhiko-Joe/skills/tree/main/doc-drill">📘 伴侣 Skill: doc-drill</a> · 通过同进程 <code>/mcp</code> 端点对接任意 Code Agent
</p>

---

## 为什么选择 autoDoc？

与 DeepWiki、Google Code Wiki 等竞品不同，autoDoc 不只是"单次生成一堆文档"——它是一个**带质量闭环的多 Agent 文档工厂 + 可被 Agent 直接读写的 MCP 知识底座**。它既是**人类阅读体验最舒适的文档站**，也是**天然适配 Code Agent 的知识源**，在可读性、交互性、Agent 可消费性、增量维护能力等各个维度均达到 SOTA。

| | autoDoc | DeepWiki | Google Code Wiki |
|---|:---:|:---:|:---:|
| 多 Agent 迭代验证 | **✅ 5 Agent + Checker 循环** | ❌ 单次生成 | ❌ 单次生成 |
| git URL 直接接入 | **✅ 后端自动 clone & 跟踪 commit** | ✅ | ✅ |
| 增量更新（git diff 驱动） | **✅ 专用 Updater Agent 局部改写** | ❌ 全量重生成 | ❌ 全量重生成 |
| 交互式架构图 | **✅ 6 种语义边 + 悬浮详情** | ❌ 静态 Mermaid | ❌ 静态图 |
| 递归自适应分解 | **✅ Agent 自主决定深度** | ❌ 固定层级 | ❌ 扁平结构 |
| 崩溃恢复 | **✅ Session ID + pending 暂存** | ❌ | ❌ |
| Agent 可写文档 | **✅ HTTP MCP（query + mutate + 历史版本）** | ❌ | ❌ |
| Code Agent 集成 | **✅ doc-drill skill ↔ /mcp** | ❌ | ❌ |
| 混合 AI 后端 | **✅ 每角色可选 Claude/Codex** | ❌ | ❌ |

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

## 快速开始

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc
pnpm install && cd web && pnpm install && cd ..
pnpm start
```

启动后在前端粘贴 git URL 即可生成文档。**详细的环境要求、首次生成 / 增量更新 / MCP 接入等完整上手步骤，请看 [USAGE.md](USAGE.md)。**

### Codex Profile 配置

Codex 后端按 Agent 角色使用 [profiles](https://developers.openai.com/codex/config-reference) 隔离模型参数。在 `~/.codex/config.toml` 中为以下六个角色各添加一段 profile，名字必须严格为 `scaffold`、`decomposer`、`writer`、`checker`、`flowanalyzer`、`updater`：

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

可以按需替换为其他模型或调整 `model_reasoning_effort`、`service_tier` 等字段。完整可选键参见官方 [Config Reference](https://developers.openai.com/codex/config-reference)。

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

更加推荐使用Claude code内置的api配置，不需要额外启动内网代理服务

## 工作原理

### 首次接入：全量管线

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

### 增量更新：git diff 驱动

```
gitUrl (已存在) ──► git fetch + pull
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
                          局部增删改 .md / .json + 更新 head
```

| Agent | 职责 | 验证 |
|-------|------|------|
| **Scaffold** | 分析整个仓库，生成顶层模块关系图 | Checker 校验 |
| **Decomposer** | 递归拆分模块为子图或叶子页面 | Checker 校验（最多重试 5 次） |
| **Writer** | 为每个叶子节点生成详细 Markdown 文档 | — |
| **Checker** | 校验图结构完整性和内容质量 | — |
| **Flow Analyzer** | 提取 3–7 条典型业务交互流程 | — |
| **Updater** | 接收 git diff 后局部增删改文档树 | — |

全量 Agent 由 **Arranger** 状态机统一调度，采用**滑动窗口并发模型**——并发会话数可在前端配置（默认 8）。按节点管理状态，支持崩溃恢复。**Updater** 是独立增量通道，基于 fs Read/Edit/Write 完成最小修改。

### Agent 后端可选

每个 Agent 角色可独立选择 **Claude**（Claude Agent SDK）或 **Codex**（OpenAI Codex SDK）作为后端，在前端配置面板中逐个调整：

| 角色 | 默认后端 |
|------|---------|
| Scaffold | Claude |
| Decomposer | Claude |
| Writer | Claude |
| Checker | Codex |
| Flow Analyzer | Claude |
| Updater | Claude |

## 核心特性

- **🔗 git URL 一键接入** — 输入 SSH/HTTPS git URL，后端自动 clone、跟踪主分支 commit，统一存放在 `src/souko/`
- **🔁 增量更新** — 同一个 URL 二次提交时，后端 fetch + 算 diff，由专门的 Updater Agent 局部修改文档，不重跑全量管线
- **🛰️ HTTP MCP 服务** — 同进程 `/mcp` 端点（Streamable HTTP）暴露完整 query + mutate 工具集，Code Agent 直接读写文档
- **📜 文档版本控制** — 每次写入都带乐观锁 (`baseVersion`) + `.history/{file}.v{n}` 快照，支持 `revert` 工具回滚到任意历史版本
- **🔗 交互式有向图** — 基于 [AntV G6](https://g6.antv.antgroup.com/)，支持 6 种语义边类型（调用、依赖、数据流、事件、继承、组合），边悬浮弹窗展示关系详情
- **🔍 渐进式披露** — 从顶层架构总览出发，点击节点逐层深入至叶子 Markdown 文档
- **🔄 交互流程图** — 自动提取跨模块业务流程，以时序图形式展示参与者、步骤和代码引用
- **🔎 模块搜索** — 在侧边栏搜索框中快速检索任意模块
- **💬 AI 对话面板** — 悬浮式聊天窗口，对文档内容追问（需配置 `OPENAI_API_KEY`）
- **🌙 深色模式** — Tokyo Night 主题，一键切换
- **📊 实时进度** — 在首页实时查看文档生成进度（区分 initial / incremental / noop 三种 mode）
- **🌐 多语言** — 支持生成中文（默认）或英文文档站

## HTTP MCP 接口

后端在 `http://localhost:3100/mcp` 上以 stateless Streamable HTTP transport 暴露一个 MCP server，名为 `autodoc`。所有工具操作的对象都是 `src/souko/doc/{project}/` 下的真实文件。

### 在 Claude Code 里接入

在目标仓库根放一个 `.mcp.json`：

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

配套的 [doc-drill skill](src/skill-template/SKILL.md) 是一份**只讲怎么调 MCP 工具**的说明书，随 autoDoc 一起分发到目标仓库。

### 工具一览

#### Query（无副作用）

| 工具 | 用途 |
|---|---|
| `list_projects` | 列出所有已注册的项目（含 sourceUrl / head / lastUpdated） |
| `get_top` | 拿到一个项目的 top.json（含 `version`） |
| `get_graph` | 拿到子图（含 `version` 与 `pageVersions` map） |
| `get_page` | 读取叶子 Markdown 页（含其 `version`） |
| `search_nodes` | 跨所有层级按关键字搜索节点名/描述 |
| `list_history` | 列出某个文件的全部历史版本 |
| `get_history` | 读取指定历史版本的内容 |

#### Mutate（强制 baseVersion 乐观锁）

| 工具 | 用途 |
|---|---|
| `update_top` | 修改 top.json 的 description / nodes |
| `update_graph_meta` | 修改子图的 description / codeScope |
| `create_node` | 给父图追加新节点（page → 同时建空 md；graph → 同时建子图占位） |
| `update_node` | 修改父图中某节点的 name / description / codeScope / edges |
| `delete_node` | 从父图移除节点（page 删 md；graph 递归删子目录） |
| `update_page` | 覆盖叶子 md 内容，使用 `pageVersions[ref]` 作为 baseVersion |
| `revert` | 把某个历史版本作为新版本写回，不擦除中间版本 |

写入流程：**read → 拿 version → 带 baseVersion 写入 → 服务器 snapshot 旧版到 `.history/` → version+1 → 持久化**。版本不匹配会返回 `VersionMismatch` 让客户端重读重试。

> ⚠️ 当前 `/mcp` 默认无鉴权且开启了 CORS。生产部署前请加访问控制或绑定 loopback。

## 项目仓与文档仓

所有项目的源码和文档都集中在 `src/souko/` 下：

```
src/souko/
├── projects.json        # 共享 registry：{ name → { sourceUrl, branch, head, lastUpdated } }
├── repo/                # git clone 进来的源码（每个项目一个子目录，gitignore）
│   ├── openclaw/
│   └── ...
└── doc/                 # 生成的文档站（每个项目一个子目录，gitignore）
    ├── openclaw/
    │   ├── top.json
    │   ├── flows.json
    │   ├── {Module}/
    │   │   ├── {Module}.json
    │   │   ├── .history/        # 历史版本快照
    │   │   ├── {Leaf}.md
    │   │   └── {SubModule}/...
    │   └── ...
    └── ...
```

## 文档可插拔

每个模块的文档是自包含的独立单元。三种修改方式：

- **走 MCP 工具**（推荐）：通过 `update_node` / `update_page` / `create_node` / `delete_node` 修改，自动带 version + 历史快照，适合让 Code Agent 自动维护
- **直接编辑文件**：直接改 `src/souko/doc/{project}/` 下的 .md / .json，重启服务即可生效（绕过版本机制）
- **触发增量更新**：在源码仓推一个新 commit 后再次提交同一个 git URL，Updater Agent 会自动检测 diff 并局部更新

## doc-drill: Code Agent 原生集成

autoDoc 自动把瘦版 [doc-drill](src/skill-template/SKILL.md) skill 安装到目标仓库的 `.claude/skills/doc-drill/`，同时往该仓库的 `.mcp.json` 写入指向本地 MCP server 的配置。任何 Code Agent 都能通过它：

- **渐进式浏览** — `list_projects` → `get_top` → `get_graph` → `get_page`，lazy load，节省上下文
- **关系追踪** — 沿 6 种语义边追踪模块间调用链和数据流
- **关键词搜索** — `search_nodes` 跨所有文档层级搜索
- **业务流程导航** — 通过 `flows.json` 理解端到端交互场景
- **直接维护** — 用 mutate 工具就地增删改文档，并通过 `list_history` / `revert` 回看与回滚

> 这是 DeepWiki（仅网页 Chat）和 Google Code Wiki（仅网页浏览）不具备的 Agent-native 集成能力。

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | TypeScript, [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code), [OpenAI Codex SDK](https://github.com/openai/codex-sdk), [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk), Zod |
| Git 子系统 | 直接调用本地 `git` CLI（child_process），无第三方 git 依赖 |
| 前端 | Vue 3, TypeScript, AntV G6, Vite |
| AI 对话 | OpenAI API（gpt-4o 或自定义模型） |
| 工程 | pnpm workspaces |

## 项目结构

```
autoDoc/
├── src/
│   ├── server.ts                 # HTTP API + /mcp（同端口，stateless transport）
│   ├── claude-proxy.ts           # Claude API 内网转发代理
│   ├── git/
│   │   └── repoManager.ts        # git CLI 封装（clone / fetch / diff / projectNameFromUrl）
│   ├── souko/                    # 项目仓（repo + doc + 共享 registry）
│   │   ├── registry.ts           # projects.json 读写
│   │   ├── repo/                 # gitignore：clone 来的源码
│   │   ├── doc/                  # gitignore：生成的文档站
│   │   └── projects.json         # gitignore：共享 registry
│   ├── mcp/                      # HTTP MCP server（与 HTTP API 同进程）
│   │   ├── server.ts             # buildMcpServer(store)
│   │   ├── docStore.ts           # 文档读写 + version + .history 快照
│   │   ├── schema.ts             # Zod schemas（含 version / pageVersions）
│   │   └── tools/{query,mutate}.ts
│   ├── agents/                   # Agent 实现（Claude + Codex 双后端）
│   │   ├── claude{scaffold,decomposer,writer,checker,flowanalyzer,updater}.ts
│   │   ├── codex{scaffold,decomposer,writer,checker,flowanalyzer,updater}.ts
│   │   ├── instructions/         # 各 Agent 提示词（中文 + 英文）
│   │   │   ├── flowanalyzer.{ts,en.ts}
│   │   │   ├── updater.{ts,en.ts}        # Updater 提示词
│   │   │   └── ...
│   │   └── schemas/schema.ts     # Zod 输出 schema（含 UpdaterOutput）
│   ├── workflow/
│   │   └── arranger.ts           # 全量管线状态机
│   └── skill-template/
│       └── SKILL.md              # 瘦版 doc-drill skill（指向 /mcp）
├── scripts/
│   ├── setup-claude-proxy.sh
│   └── unwrap-md-json.mjs
├── web/                          # Vue 3 前端
│   └── src/
│       ├── views/                # GraphPage, DocPage, HomePage（git URL 输入）, FlowsPage
│       ├── components/           # ChatPanel 等
│       └── services/doc.ts       # API 客户端（startRun → { ok, mode }）
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

本项目目前处于原型阶段的快速迭代期，版本可能频繁出现不兼容更新。如果你希望引入新的功能，烦请先通过 Issue 进行沟通，以便与项目 Roadmap 对齐。欢迎个人开发者基于本项目进行二次开发，请遵守 [LICENSE](LICENSE)（AGPL-3.0）的约束。

由于本项目采用"AGPL-3.0 开源 + 商业许可"双轨模式，所有外部贡献在合并前需签署 [CLA.md](CLA.md)。CLA Assistant 会在你首次提交 PR 时自动引导你完成签署，单次签署覆盖后续全部贡献。

欢迎提交 Issue 和 Pull Request！如果 autoDoc 对你有帮助，请给一个 Star 支持。

## License & 商业许可

autoDoc 在法律层面采用双许可模式：

- **开源许可**：[GNU AGPL-3.0-only](LICENSE)。免费使用、修改、再分发，但**任何修改版本或衍生作品——包括以网络服务形式对外提供的部署——都必须以 AGPL-3.0 向其用户完整公开对应的源代码**（AGPL-3.0 §13）。
- **商业许可**：若你无法或不愿履行 AGPL-3.0 的开源义务（例如将 autoDoc 集成进闭源产品、或作为 SaaS 对外提供而不公开衍生源码），则必须事先获得作者的书面商业许可。详见 [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)。

### 商业许可的获取方式

本项目的商业许可依据使用方的规模，按以下两档授予：

**一、市值或最新估值低于人民币 10 亿元的公司**

需要组织员工为本仓库点 Star，作为对项目的公开认可。**每 5 个来自该公司员工的 GitHub Star 授予该公司 1 年期商业许可**。Star 必须来自可识别为该公司雇员的 GitHub 账号（公开资料中注明雇主，或通过公司邮箱验证）。许可期限自最后一个 Star 产生之日起算，期满后需重新累计。

**二、市值或最新估值达到或超过人民币 10 亿元的公司**

需要向作者发出正式的录用通知（offer），日常实习 offer 同样有效。授权规则如下：

1. **作者以任何形式入职该公司后，该公司自动获得永久商业许可**，覆盖入职之前和之后的所有使用、修改、分发及衍生作品。
2. **作者未入职不等于拒绝授权**。作者会综合评估职位、base、地点等因素后决定是否入职；即使最终未入职，只要 offer 本身**真诚、具备市场合理性、并明确表达了对本项目的认可**，作者同样会向该公司授予永久商业许可。
3. 作者保留最终解释权。明显低于市场水平、附带不合理条件的 offer 不构成有效对价。

### 联系方式

- **商业许可**：`joeyanbo608@gmail.com`
- **主题行建议**：`[autoDoc Commercial License] <贵司名称>` 或 `[autoDoc Offer] <贵司名称>`

请在首次联系时提供公司名称、规模、使用场景和预期部署范围，以便评估所属档位并安排后续流程。