# autoDoc：用状态机驯服 AI Agent，为任意代码仓自动生成文档站

## 一、问题：文档这件事为什么总做不好

每个团队都有类似的经历：新人入职，clone 了仓库，打开一看——400 个文件，README 停留在项目启动那天，Wiki 上贴着一年前的截图。于是新人花三天读代码，从 `main` 函数一路追到数据库查询，才终于搞明白一个接口是怎么工作的。

这个问题不是没人想解决。DeepWiki 之类的方案把仓库塞进大模型，一口气生成一份文档站。看起来挺好，用起来有几个硬伤：

- **全量重跑**：改了一个文件，整站重新生成。一个中型仓库跑一次几十分钟，改一次就重来
- **没有崩溃恢复**：Agent 跑到一半挂了，所有中间结果全丢，从头再来
- **产物只读**：生成的文档不能编辑、不能追问、不能对着某个模块问"这个函数在哪里被调用"
- **结构扁平**：输出一堆平铺的 Markdown 页面，没有模块关系、没有调用链、没有层级

我做 autoDoc 的出发点很简单：**把文档生成当成一条编译流水线，而不是一次大模型调用**。每个阶段有明确的输入输出，中间结果可以落盘、可以恢复、可以并行。就像 webpack 不会因为你改了一个文件就重新编译所有文件一样，autoDoc 也不会因为一个 PR 就重写所有文档。

---

## 二、整体架构：5 个 Agent 的流水线

autoDoc 的核心是一条由 **Arranger 状态机**编排的 Agent 流水线：

```
Scaffold ──► Checker ──► [ Decomposer ──► Checker ──► Writer ] × N ──► FlowAnalyzer ──► done
                                    │
                                    ▼
                            （递归：子模块继续拆分）
```

五个 Agent 各司其职：

| Agent | 做什么 | 产出 |
|-------|--------|------|
| **Scaffold** | 通读整个仓库，划分顶层模块 | `top.json`（项目概览 + 模块列表） |
| **Decomposer** | 递归拆分模块为子图或叶子页面 | 子模块的 `graph.json` |
| **Writer** | 为叶子页面写详细的 Markdown 文档 | `*.md` 文件 |
| **Checker** | 校验图结构合法性（边的目标存在？路径合法？） | 通过 / 失败原因列表 |
| **FlowAnalyzer** | 分析跨模块的业务流程 | `flows.json` |

三条核心设计原则：

**1. 用状态机调度多个 Agent，而不是一个大 Agent 跑到底。** 单 Agent 意味着所有模块共享一个上下文窗口（很快就溢出），失败了只能全部重来，也没法并行。状态机让每个模块独立处理，互不干扰。

**2. 状态落盘到文件系统。** 每个模块的进度（正在分解 / 正在写 / 校验通过 / 出错）都记在它自己的 JSON 文件里。进程挂了重启，已完成的模块一个不丢。

**3. 用 MCP 工具层隔离 Agent 与文件系统。** Agent 不直接读写磁盘，而是通过 `get_page`、`patch_page`、`create_node` 等标准化工具操作文档。工具边界就是权限边界。

每个 Agent 都有 Claude 和 Codex 双后端实现，通过工厂模式按角色选择：

```typescript
// src/workflow/arranger/agentFactory.ts
export const DEFAULT_AGENT_BACKENDS: AgentBackends = {
  scaffold: "codex",
  decomposer: "codex",
  writer: "codex",
  checker: "claude",
  flowAnalyzer: "codex",
};
```

所有 Agent 共享同一个接口——`run`（启动）、`continue`（续跑）、`restore`（从保存的会话恢复）、`getSessionId`（获取当前会话 ID）：

```typescript
// src/agents/schemas/schema.ts — 以 IDecomposer 为例，其他 Agent 结构相同
export interface IDecomposer {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string): Promise<AgentResult<RawGraph>>
  continue(prompt: string): Promise<AgentResult<RawGraph>>
}
```

---

## 三、技术深潜：3 个关键设计

### 3.1 状态机：用节点状态驱动任务调度

autoDoc 没有用任务队列（Redis / BullMQ），也没有用 Agent 编排框架（LangGraph / CrewAI）。它的调度完全靠**节点自身的 status 字段**驱动。

每个模块对应一个 JSON 文件，文件里有一个 `status` 字段：

```
pending → decomposing → writing → checking → done
                                              ↘ error
```

Arranger 的核心循环做的事情很简单：扫描所有节点，找到处于"可行动"状态的节点，认领它、推进它的状态、执行对应的 Agent：

```typescript
// src/workflow/arranger/graphStore.ts — 任务认领
const ACTIONABLE: ReadonlySet<GraphStatusType> = new Set([
  "pending", "writing", "checking",
]);

async claimNextTask(): Promise<ArrangerTask | null> {
  const allNodeIds = await this.scanGraphNodes(this.docDir, "");
  for (const nodeId of allNodeIds) {
    const graph = await this.readGraph(nodeId);
    if (!ACTIONABLE.has(graph.status)) continue;

    if (graph.status === "writing" && graph.pageTasks) {
      // 找到下一个待写的页面
      const nextPage = Object.entries(graph.pageTasks)
        .find(([, task]) => task.status === "pending");
      if (nextPage) {
        await this.markPageWriting(nodeId, nextPage[0]);
        return { kind: "page", nodeId, ref: nextPage[0], graph };
      }
      continue;
    }

    // 认领为"正在分解"
    await this.updateGraph(nodeId, { status: "decomposing" });
    return { kind: "graph", nodeId, graph };
  }
  return null;
}
```

这个设计有几个好处：

**不需要外部队列**：文件系统就是任务队列。`pending` 状态的节点就是待处理任务，`done` 的就是已完成。`cat` 一下 JSON 就能看到整条流水线的进度。

**天然支持崩溃恢复**：每个节点的 JSON 文件里还保存着 Agent 的 session ID。进程崩溃后重启，只需要把 `decomposing` / `writing` / `checking` 状态的节点重置回 `pending`，它们会自动重新进入调度循环。Agent SDK 支持通过 session ID 恢复之前的对话上下文，所以续跑时不需要从头开始。

```typescript
// 重启恢复：处于中间态的节点回退到 pending
const RECOVERABLE: ReadonlySet<GraphStatusType> = new Set([
  "decomposing", "writing", "checking",
]);
```

**天然支持并发**：Arranger 同时运行多个 worker（默认 8 个），每个 worker 独立调用 `claimNextTask()` 认领不同的节点。不同模块可以同时分解、同时写文档，互不干扰。

**天然支持递归**：Decomposer 把一个模块拆成子节点后，子节点的状态是 `pending`——它们立刻出现在下一轮扫描中，被其他 worker 认领处理。不需要额外的递归调度逻辑，状态机自然驱动递归展开。

### 3.2 自索引的文档结构：递归图 + Zod Schema

autoDoc 的产物不是一堆平铺的 Markdown 文件。它是一棵**自索引的递归树**，每一层都是一个 JSON 图 + 若干 Markdown 叶子页面：

```
src/souko/doc/{projectName}/
├── top.json                          # 根图：项目概览 + 顶层模块列表
├── {Module}/
│   ├── {Module}.json                 # 子图：描述 + codeScope + 子节点列表
│   ├── {Leaf}.md                     # 叶子页面：一个组件的详细文档
│   └── {SubModule}/                  # 递归嵌套
│       ├── {SubModule}.json
│       └── ...
├── flows.json                        # 跨模块业务流程
└── update-log.jsonl                  # 增量更新日志
```

每个图节点（JSON 里的一项）描述一个模块，包含以下关键信息：

```typescript
// src/agents/schemas/schema.ts — 图节点结构
export const GraphNode = z.object({
  name: z.string(),                           // 模块名
  description: z.string(),                    // 一句话描述
  edges: z.array(GraphEdge),                  // 和兄弟节点的关系
  codeScope: z.array(z.string()),             // 覆盖哪些源文件/目录
  child: z.object({
    type: z.enum(["graph", "page"]),          // 子节点是子图还是叶子页面
    ref: z.string(),                          // 引用名（子目录名或 .md 文件名）
  }),
})

// 边有 6 种语义类型
export const EdgeType = z.enum([
  "calls", "depends", "data-flow", "event", "extends", "composes",
])
```

**为什么是"图"而不是"树"？** 因为模块之间有依赖关系。`edges` 数组记录了兄弟节点之间的关系——A 调用 B、C 依赖 D、E 通过事件驱动 F。这些边在前端渲染成交互式的关系图（AntV G6），让你直观看到模块间的依赖。

**`codeScope` 的约束**：每个节点声明自己覆盖哪些源文件。子节点的 codeScope 必须是父节点的子集。这保证了文档和代码之间的映射是严格的——你可以从任意一个源文件反查它被哪个文档模块覆盖。

**`child.type` 决定递归深度**：Decomposer 对每个模块做判断——如果模块复杂（覆盖 10+ 个文件），`type` 设为 `"graph"`，继续递归拆分；如果模块简单（2-3 个文件），`type` 设为 `"page"`，直接写叶子文档。这让文档的层级深度自适应代码的复杂度。

这种自索引结构最大的价值是：**不需要全量加载就能导航**。拿到 `top.json` 就知道项目有哪些顶层模块；点开某个模块的 JSON 就看到它的子模块列表和关系图；只有你真正关心某个叶子组件时才去读它的 `.md`。对 Agent 来说也一样——它不需要把所有文档塞进上下文窗口，按需逐层加载就够了。

### 3.3 MCP 工具生态 + doc-drill Skill

文档生成完之后，怎么让它真正被用起来？autoDoc 的答案是**两层工具抽象**：底层是 MCP Server 提供的标准化读写工具，上层是 doc-drill Skill 封装的渐进式查询协议。

#### MCP Server：Agent 操作文档的标准接口

autoDoc 的 MCP Server（`src/mcp/`）把所有文档操作封装成工具，分为查询和写入两类：

**查询工具**（`src/mcp/tools/query.ts`）：

| 工具 | 用途 |
|------|------|
| `list_projects` | 发现有哪些项目 |
| `get_top(project)` | 获取项目概览和顶层模块列表 |
| `get_graph(project, nodeId)` | 获取某个模块的子图（子节点 + 边 + codeScope） |
| `get_page(project, nodeId, ref)` | 读取叶子页面的 Markdown 内容 |
| `search_nodes(project, query)` | 跨层级关键词搜索，返回完整路径 |
| `list_docs` / `read_docs` | 批量列出/读取文档原文 |
| `list_source_files` / `read_source_files` | 定位并读取源代码文件 |

**写入工具**（`src/mcp/tools/mutate.ts`）：

| 工具 | 用途 |
|------|------|
| `patch_page` | 精确替换页面中的一段文本（要求唯一匹配） |
| `update_page` | 全量重写一个叶子页面 |
| `create_node` / `delete_node` | 新增或删除模块节点 |
| `update_node` / `update_graph_meta` | 修改节点属性或图元数据 |

所有写入工具只会修改 `src/souko/doc/{project}` 的文档工作区。前端 Git 面板负责查看 dirty 状态、手动 commit，并在 Markdown 预览/编辑中展示 blame。并发写入通过 project-level lock 串行化，不再使用工具层乐观锁。

**为什么要用 MCP 而不是让 Agent 直接读写文件？** 两个原因：

1. **权限边界**：Agent 只能通过这些工具操作文档，不能碰其他文件。工具边界 = 权限边界。
2. **一致性保证**：比如 `patch_page` 强制精确匹配（0 匹配报 `TextNotFound`、多匹配报 `AmbiguousMatch`），`delete_node` 会自动清理子节点和物理文件。这些约束在文件系统层面是做不到的。

#### doc-drill Skill：渐进式文档查询

MCP 工具解决了"Agent 怎么操作文档"，doc-drill Skill 解决了"用户怎么对文档提问"。

autoDoc 生成文档时，会同时在目标仓库的 `.claude/skills/doc-drill/` 目录下部署一个 Skill 模板（`src/skill-template/SKILL.md`）。这个 Skill 定义了一套**渐进式查询协议**：

```
1. Orient  — 调 get_top，看项目有哪些顶层模块，了解整体架构
2. Locate  — 调 get_graph，钻入 1-2 个最相关的模块，看子节点和边
3. Focus   — 调 get_page，读取具体组件的详细文档
4. Search  — 调 search_nodes，如果不确定该钻哪个模块，先按关键词搜
```

核心原则是**懒加载**：不到需要时不读叶子页面（每个页面 5-15KB），不到需要时不读源代码。Agent 先用图结构定位，确认相关性后再深入。这让 token 消耗保持在最低限度。

用户通过 Claude Code 或 Codex 提问时，Agent 自动加载这个 Skill，按协议逐层导航文档树，找到相关模块后回答问题。比如问"登录流程涉及哪些模块"，Agent 会：

1. `get_top` → 扫描顶层模块描述，定位到 Auth 和 Session 模块
2. `get_graph("Auth")` → 看到子节点有 OAuth、PasswordLogin、TokenManager
3. `get_page("Auth", "OAuth")` → 读取详细文档，获取数据流描述
4. 结合 `edges` 信息，追踪到 Session 模块的关联

这比把所有文档一股脑塞进上下文窗口要精准得多——只加载了真正相关的 3-4 个页面，而不是全部 50+ 个页面。

---

## 四、增量更新：PR 驱动的文档维护

初次生成只是开始。代码在变，文档也必须跟着变。autoDoc 的增量更新通过 **PrUpdater Agent** 实现：

1. **发现变更**：通过 `gh pr list` 或 `git log --first-parent` 发现新合并的 PR / commit
2. **评估影响**：PrUpdater 读取 diff，判定影响级别：
   - `none`：不涉及语义变化（纯格式化、注释修改）→ 跳过，不做任何写操作
   - `minor`：影响已有模块 → 用 `patch_page` 精准修改
   - `structural`：新增/删除模块 → 用 `create_node` / `delete_node` 调整图结构
3. **精准修改**：通过 MCP 工具操作文档，而不是重写整个页面

其中 `patch_page` 的设计特别值得一提——它**强制 Agent 精确**：

```typescript
// src/mcp/docStore.ts
async patchPage(project, nodeId, ref, edits) {
  let content = await readFile(pageFile, "utf-8");

  for (const edit of edits) {
    const count = content.split(edit.old_text).length - 1;
    if (count === 0) {
      throw new Error(`TextNotFound: "${edit.old_text.slice(0, 80)}"`);
    }
    if (count > 1) {
      throw new Error(`AmbiguousMatch: "${edit.old_text.slice(0, 80)}" matches ${count} times`);
    }
    content = content.replace(edit.old_text, edit.new_text);
  }
}
```

`old_text` 在文档中必须恰好匹配一次。零次说明 Agent 对当前内容的理解是错的，多次说明 Agent 给的上下文不够精确。两种情况都直接报错，逼 Agent 重新审视再试。

增量更新支持两种模式：

- **Auto 模式**：`idle → running → done`，全自动跑完
- **Manual 模式**：`idle → awaiting-confirm → running → awaiting-review → done`，跑之前人可以追加指令，跑之后人可以审核或追问

全自动是效率，手动闸门是信任。

---

## 五、怎么用

### 5.1 环境准备

```bash
# 克隆仓库
git clone <autoDoc 仓库地址>
cd autoDoc
pnpm install

# 配置 API Key（.env 文件）
cp .env.example .env
# 填入需要的 Agent 后端凭证；OPENAI_API_KEY 也用于前端 AI Chat
```

需要 Node.js 18+ 和 pnpm。

### 5.2 启动服务

```bash
# 只启动后端（端口 3100）
pnpm dev

# 启动后端 + 前端（推荐）
pnpm start
```

### 5.3 生成文档

打开浏览器访问前端页面。在首页输入你项目的 git URL，点击开始。autoDoc 会自动：

1. Clone 仓库到本地
2. 可选进入 Knowledge Elicitor 补充领域知识
3. 运行 Scaffold → Checker → Decomposer → Checker → Writer → FlowAnalyzer 流水线
4. 实时展示进度（哪些模块在处理、哪些已完成）

生成完成后，你会看到一个交互式的模块图（AntV G6 渲染）。点击任意节点可以查看该模块的详细文档，支持在线编辑。

如果启用 **Review all decompositions**，Scaffold / Decomposer 输出会进入人工审核队列。你可以在审核面板里编辑节点和边、直接批准，或输入反馈让对应 Agent 续写重跑。

### 5.4 增量更新

项目有新的 PR 合并后，在右侧的 UpdateQueuePanel 中点击"开始更新"。系统会自动发现新的 PR，逐个生成更新报告并修改相关文档。

Manual 模式下，每个 PR 处理前后都有人工确认环节，你可以在确认框中追加指令（比如"重点关注 API 变更"）或审核后决定接受/拒绝。

### 5.5 对文档提问

autoDoc 生成文档时会同时产出一个 `doc-drill` skill，并写入目标仓库的 Claude Code / Codex MCP 配置。之后在目标仓里向 Code Agent 提问时，它会通过 `/mcp` 逐层读取文档。

### 5.6 Knowledge 前置知识

对于代码里看不出来的业务背景（比如"这个模块是为了满足某个合规要求才加的"），可以在生成前通过 Knowledge Elicitor 功能和仓库对话，产出一份 `knowledge.md`。Arranger 启动时会自动加载它，注入到所有 Agent 的 prompt 中，让生成的文档更贴近业务语境。

---

## 六、怎么二开和适配

autoDoc 的架构设计了明确的扩展点。以下是最常见的定制场景：

### 6.1 替换或新增 Agent 后端

所有 Agent 共享统一接口（四个方法），新增一个后端只需要：

1. 在 `src/agents/tsukai/` 下新建一个类，实现对应接口（如 `IDecomposer`）
2. 在 `src/agents/tsukai/index.ts` 中导出
3. 在 `src/workflow/arranger/agentFactory.ts` 的工厂方法中注册

```typescript
// 示例：新增一个自定义 Decomposer
import type { IDecomposer, AgentResult, RawGraph } from "../../agents/schemas/schema.js";

export class myCustomDecomposer implements IDecomposer {
  private sessionId: string | undefined;

  getSessionId() { return this.sessionId; }
  restore(sessionId: string, workpath: string) { this.sessionId = sessionId; /* ... */ }

  async run(prompt: string, workpath: string): Promise<AgentResult<RawGraph>> {
    // 你的实现：调用你自己的模型 API
  }

  async continue(prompt: string): Promise<AgentResult<RawGraph>> {
    // 在已有会话上继续
  }
}
```

然后修改 `agentFactory.ts` 中 `makeDecomposer()` 的分支即可。

### 6.2 定制 Agent 指令（Prompt）

每个 Agent 的 prompt 模板在 `src/agents/instructions/` 下，按语言分目录：

```
src/agents/instructions/
├── cn/           # 中文指令
│   ├── scaffold.ts
│   ├── decomposer.ts
│   ├── wirter.ts    # （注意：writer 的文件名有个历史拼写错误）
│   ├── checker.ts
│   └── prupdater.ts
└── en/           # 英文指令
    └── ...
```

直接修改这些文件即可调整 Agent 的行为。`src/workflow/arranger/promptBuilder.ts` 负责把指令模板、仓库信息、祖先上下文等拼装成最终 prompt。

### 6.3 扩展 MCP 工具

MCP 工具分两类文件：

- **查询工具**：`src/mcp/tools/query.ts`（`get_top`、`get_graph`、`search_nodes` 等）
- **写入工具**：`src/mcp/tools/mutate.ts`（`patch_page`、`create_node`、`delete_node` 等）

新增工具只需要在对应文件中添加一个 handler 函数，它会自动注册到 MCP server。所有写入工具在操作完成后会自动 `await store.docGit.commit()` 创建 git 提交。

### 6.4 定制文档 Schema

文档的数据结构由两层 schema 定义：

- **内部 schema**：`src/agents/schemas/schema.ts`（Zod）——包含 Arranger 专用字段（`status`、`sessionId`、`pageTasks` 等）
- **MCP 层 schema**：`src/mcp/schema.ts`——用 `.loose()` 修饰，允许透传未知字段

如果需要给节点新增属性（比如 `owner`、`priority`），两个文件都需要改。MCP 层用 `.loose()` 的好处是，即使你在内部 schema 加了新字段，MCP 工具读写时不会丢失这些字段。

### 6.5 产物结构

生成的文档存储在 `src/souko/doc/{projectName}/` 下，结构是自索引的：

```
src/souko/doc/{projectName}/
├── top.json                          # 根图：项目概览 + 顶层模块列表
├── {Module}/
│   ├── {Module}.json                 # 子图：描述 + codeScope + 子节点
│   ├── {Leaf}.md                     # 叶子页面：详细文档
│   └── {SubModule}/                  # 递归嵌套
│       ├── {SubModule}.json
│       └── ...
├── flows.json                        # 业务流程分析
└── update-log.jsonl                  # 增量更新日志
```

通过 MCP 工具即可遍历整棵树，不需要知道物理路径。`search_nodes` 支持关键词全文搜索。

---

## 七、关键目录速查

| 目录 / 文件 | 用途 |
|-------------|------|
| `src/workflow/arranger.ts` | 状态机主入口，编排整条流水线 |
| `src/workflow/arranger/pipeline.ts` | Pipeline 执行器，处理 scaffold / decompose / write 各阶段 |
| `src/workflow/arranger/graphStore.ts` | 图节点状态管理，任务认领，崩溃恢复 |
| `src/workflow/arranger/runtime.ts` | Semaphore 信号量 + withRetry 指数退避重试 |
| `src/workflow/arranger/agentFactory.ts` | Agent 工厂，按角色选择 Claude / Codex 后端 |
| `src/workflow/arranger/promptBuilder.ts` | Prompt 模板拼装 |
| `src/agents/schemas/schema.ts` | 所有 Agent 的接口定义 + Zod 数据结构 |
| `src/agents/tsukai/` | Agent 实现（`claude*.ts` 和 `codex*.ts`） |
| `src/agents/instructions/{cn,en}/` | Agent 指令模板（按语言） |
| `src/mcp/tools/query.ts` | MCP 查询工具 |
| `src/mcp/tools/mutate.ts` | MCP 写入工具 |
| `src/mcp/docStore.ts` | 文档存储层（读写 JSON / Markdown） |
| `src/mcp/docGit.ts` | 文档 Git status / 手动 commit / blame |
| `src/workflow/updateOrchestrator.ts` | PR 增量更新编排（Auto / Manual 模式） |
| `src/git/prDiscovery.ts` | PR / commit 发现（gh CLI 或 git log） |
| `src/skill-template/SKILL.md` | doc-drill skill 模板（对文档提问的能力） |
| `src/server.ts` | 后端 HTTP API（含 SSE 推送） |
| `web/` | Vue 3 前端（图谱可视化 + 文档编辑 + 更新面板） |

---

如果您的团队需要一个代码文档站，欢迎来试。有问题直接开个issue，二开经验可以找社科线的同学，他们魔改得很多经验也最足。
