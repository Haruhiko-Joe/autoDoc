# autoDoc 技术分享：面向代码仓库的多 Agent 文档生成流水线

## 一、分享摘要

autoDoc 的目标不是再做一个“把仓库丢给大模型，然后生成一批 Markdown”的工具，而是把代码文档生成拆成一条可恢复、可校验、可增量维护的工程流水线。

它的核心思路可以概括为三点：

1. **用状态机编排 Agent**：Scaffold、Decomposer、Writer、Checker、Flow Analyzer 分工协作，避免单个 Agent 承担全流程。
2. **把中间产物持久化为结构化文档树**：每一层都是 JSON 图结构，叶子节点才是 Markdown 页面，支持按需读取和图谱导航。
3. **用 MCP 工具维护文档生命周期**：生成后的文档可以被 Code Agent 查询、编辑，并通过 PR 增量更新持续保持新鲜。

如果我们希望 AI 文档系统真的适用于中大型仓库，不能只关注“能不能生成”，还必须解决失败恢复、结构校验、增量更新、可导航性和人机协作这些工程问题。

---

## 二、背景：为什么代码文档长期难以维护

团队里常见的文档问题通常不是“没有文档”，而是文档和代码生命周期脱节：

- 新人入职后需要从入口文件一路追到业务逻辑，才能理解一个接口的真实调用链。
- README、Wiki 或设计文档停留在项目早期状态，代码演进后无人同步。
- 静态文档生成器擅长从注释提取 API，但很难解释跨模块流程和业务上下文。
- 一次性 AI 生成方案可以快速产出文档站，但后续维护成本仍然很高。

DeepWiki 这类工具证明了“仓库级 AI 文档”是有价值的，但在工程化落地时仍会遇到几个限制：

| 问题 | 具体影响 |
|------|----------|
| 全量重跑 | 一个小改动可能触发整站重新生成，中型仓库一次运行就需要较长时间 |
| 缺少恢复点 | Agent 运行中断后，中间结果容易丢失，只能重新开始 |
| 结构不可验证 | Markdown 页面可以生成，但模块引用、路径、边关系是否正确缺少系统化校验 |
| 产物不可操作 | 文档站往往只能阅读，难以被 Agent 精准查询、局部修改或增量维护 |
| 缺少运行时视角 | 静态模块文档不能直接回答“这个业务流程经过哪些模块” |

autoDoc 的切入点是：**把文档生成当作编译流水线，而不是一次模型调用。**

每个阶段有明确输入输出，中间结果落盘，失败可以恢复，局部变更可以局部更新。

---

## 三、总体架构：Arranger 编排的五类 Agent

autoDoc 的主流程由 Arranger 状态机驱动，整体管线如下：

```text
Scaffold → Checker → [Decomposer → Checker → Writer] × N → Assemble MCP/Skill → Flow Analyzer → done
                         │
                         └─ 子模块继续递归拆分
```

五类 Agent 的职责边界如下：

| Agent | 角色 | 主要产物 |
|-------|------|----------|
| Scaffold | 通读仓库，生成顶层模块划分 | `top.json` |
| Decomposer | 递归拆分模块，决定继续分解还是生成叶子页 | 子图 JSON |
| Writer | 为叶子节点生成详细 Markdown 文档 | `*.md` |
| Checker | 校验 Scaffold 和 Decomposer 的图结构 | 通过结果或问题列表 |
| Flow Analyzer | 从完整文档和源码中提取典型跨模块流程 | `flows.json` |

这里最重要的设计不是“用了多个 Agent”，而是每个 Agent 都只负责一个清晰的工程职责：

- Scaffold 只决定顶层结构。
- Decomposer 只负责局部模块拆分。
- Writer 只写叶子文档，不决定全局结构。
- Checker 只校验图结构，不参与内容创作。
- Flow Analyzer 在基础文档完成后，补充运行时流程视角。

这样的拆分让系统具备三个工程优势：

1. **上下文更可控**：每个 Agent 只处理当前阶段需要的信息，不需要一次塞入全仓库和全量文档。
2. **失败范围更小**：某个模块失败时，只影响该节点，不影响已经完成的模块。
3. **后端可替换**：同一个角色可以选择 Claude 或 Codex 后端，Arranger 只依赖统一接口。

当前默认后端配置在 `src/workflow/arranger/agentFactory.ts`：

```typescript
export const DEFAULT_AGENT_BACKENDS: AgentBackends = {
  scaffold: "codex",
  decomposer: "codex",
  writer: "codex",
  checker: "claude",
  flowAnalyzer: "codex",
};
```

所有 Agent 暴露同一组生命周期方法：

```typescript
export interface IDecomposer {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string): Promise<AgentResult<RawGraph>>
  continue(prompt: string): Promise<AgentResult<RawGraph>>
}
```

这组接口是系统可恢复和可替换的基础：Arranger 不关心具体模型实现，只关心能否启动、续跑、恢复会话并取得结构化结果。

---

## 四、关键设计一：用节点状态驱动调度和恢复

autoDoc 没有引入 Redis、BullMQ 或专用 Agent 编排框架。它把文档树中的每个模块节点直接视为一个任务，任务状态就写在对应的 JSON 文件中。

子图节点的状态包括：

```text
pending → decomposing → writing → done
                         │
                         └─ pageTasks 逐页完成

可选人工审核：
decomposing → awaiting-review → writing / done

异常：
decomposing / writing / checking → error
```

核心调度逻辑在 `src/workflow/arranger/graphStore.ts`。Arranger 会扫描文档树，找到可执行节点并认领：

```typescript
const ACTIONABLE: ReadonlySet<GraphStatusType> = new Set([
  "pending",
  "writing",
  "checking",
]);

async claimNextTask(): Promise<ArrangerTask | null> {
  const allNodeIds = await this.scanGraphNodes(this.docDir, "");

  for (const nodeId of allNodeIds) {
    const graph = await this.readGraph(nodeId);
    if (!ACTIONABLE.has(graph.status)) continue;

    if (graph.status === "writing" && graph.pageTasks) {
      const nextPage = Object.entries(graph.pageTasks)
        .find(([, task]) => task.status === "pending");

      if (nextPage) {
        await this.markPageWriting(nodeId, nextPage[0]);
        return { kind: "page", nodeId, ref: nextPage[0], graph };
      }

      continue;
    }

    await this.updateGraph(nodeId, { status: "decomposing", pageTasks: undefined });
    return { kind: "graph", nodeId, graph };
  }

  return null;
}
```

这个设计带来几个直接收益。

### 4.1 文件系统就是可观测的任务队列

`pending` 节点就是待处理任务，`writing` 节点说明子图已经拆完，正在为叶子页面生成内容，`done` 节点表示该模块已完成。

调试时不需要额外查询队列系统，直接查看 `src/souko/doc/{projectName}/` 下的 JSON 文件即可知道当前进度。

### 4.2 崩溃后可以从中间态恢复

Arranger 启动时会把可恢复状态重新放回可调度队列：

```typescript
const RECOVERABLE: ReadonlySet<GraphStatusType> = new Set([
  "decomposing",
  "writing",
  "checking",
]);
```

恢复时并不是简单删除所有中间产物。系统会保留已经完成的页面任务，并根据 `pageTasks` 决定节点回到 `writing` 还是 `pending`。对于已保存的 Agent `sessionId`，后续流程可以通过 `restore()` 回到同一会话上下文，减少重复推理。

### 4.3 并发来自状态认领，而不是全局递归

Arranger 默认允许最多 8 个并发任务。每个 worker 通过 `claimNextTask()` 领取不同节点，领取后节点状态立即变更，其他 worker 会跳过它。

递归拆分也不需要额外调度逻辑：Decomposer 产出子节点后，子节点初始状态为 `pending`，自然会在下一轮扫描中被领取。

---

## 五、关键设计二：自索引的递归文档树

autoDoc 的输出不是平铺 Markdown，而是一棵可导航、可验证、可被 Agent 按需读取的文档树。

```text
src/souko/doc/{projectName}/
├── top.json
├── flows.json
├── update-log.jsonl
├── {Module}/
│   ├── {Module}.json
│   ├── {Leaf}.md
│   └── {SubModule}/
│       ├── {SubModule}.json
│       └── ...
```

每一层 JSON 都是一张局部图，节点结构由 Zod Schema 定义：

```typescript
export const GraphNode = z.object({
  name: z.string(),
  description: z.string(),
  edges: z.array(GraphEdge),
  codeScope: z.array(z.string()),
  child: z.object({
    type: z.enum(["graph", "page"]),
    ref: z.string(),
  }),
});
```

这个结构里有三个关键字段。

### 5.1 `child.type` 控制文档深度

Decomposer 会判断当前模块是否需要继续拆分：

- `child.type = "graph"`：该节点仍然复杂，继续生成下一层子图。
- `child.type = "page"`：该节点已经足够聚焦，交给 Writer 生成 Markdown 页面。

因此文档深度不是固定的二级或三级目录，而是根据代码复杂度自适应展开。

### 5.2 `edges` 表达兄弟模块关系

模块关系不是靠段落描述隐式表达，而是显式建模为边：

```typescript
export const EdgeType = z.enum([
  "calls",
  "depends",
  "data-flow",
  "event",
  "extends",
  "composes",
]);
```

前端可以用这些边渲染交互式模块图，Agent 也可以沿着边追踪调用关系、数据流或事件流。

### 5.3 `codeScope` 建立文档和源码的映射

每个节点声明自己覆盖的源文件或目录。这个字段有两个作用：

1. 帮助用户从文档反查对应代码。
2. 帮助 PR 增量更新时定位受影响文档节点。

Checker 会校验 `codeScope` 是否指向真实路径，避免文档树和仓库结构脱节。领域知识允许例外时，也可以通过 `knowledge.md` 显式授权。

---

## 六、关键设计三：Checker 作为结构质量闸门

AI 生成文档时，最常见的问题不是文字不够流畅，而是结构性错误，例如：

- `edges[].target` 指向不存在的节点。
- `codeScope` 指向不存在的文件或目录。
- 节点名称重复，导致前端或 MCP 查询路径冲突。
- description 为空或仍是占位文本。

autoDoc 把这些问题交给 Checker 独立校验。Checker 只检查 Scaffold 和 Decomposer 的图结构，不检查 Writer 生成的 Markdown 正文。

当前 Checker 问题类型包括：

| 类型 | 含义 |
|------|------|
| `broken-target` | 边引用了当前图中不存在的节点 |
| `invalid-path` | `codeScope` 中的源码路径不存在 |
| `empty-content` | 必填描述为空或无意义 |

失败时，Arranger 不会直接接受产物，而是把结构化问题反馈给原 Agent：

```text
Checker failed
  → Scaffold / Decomposer continue(fix prompt)
  → Checker re-check
  → passed or retry exhausted
```

这里的关键是 `continue()`：修复发生在同一 Agent 会话中，模型能够保留上一轮方案和错误上下文，而不是重新从零生成。

---

## 七、关键设计四：MCP Server 与 doc-drill Skill

文档生成完成后，真正的价值在于能否被持续使用。autoDoc 通过 MCP Server 暴露文档读写工具，再通过 `doc-drill` Skill 给 Code Agent 一套稳定的导航协议。

### 7.1 MCP 查询工具

查询工具位于 `src/mcp/tools/query.ts`，覆盖项目发现、结构导航、页面读取和源码读取：

| 工具 | 用途 |
|------|------|
| `list_projects` | 列出已生成文档的项目 |
| `get_top(project)` | 获取项目概览和顶层模块 |
| `get_flows(project)` | 获取典型跨模块交互流程 |
| `get_graph(project, nodeId)` | 获取某个模块的子图 |
| `get_page(project, nodeId, ref)` | 读取叶子页面 Markdown |
| `search_nodes(project, query)` | 按关键词搜索各层级节点 |
| `list_source_files` / `read_source_files` | 定位并读取目标仓库源码 |
| `list_docs` / `read_docs` | 批量列出或读取文档原文 |

这些工具让 Agent 可以按层级逐步获取上下文，而不是一次性读取整个文档站。

### 7.2 MCP 写入工具

写入工具位于 `src/mcp/tools/mutate.ts`：

| 工具 | 用途 |
|------|------|
| `patch_page` | 对叶子页面做精确字符串替换 |
| `update_page` | 全量重写叶子页面 |
| `update_node` | 修改图中的单个子节点 |
| `update_graph_meta` | 修改子图描述或 `codeScope` |
| `create_node` / `delete_node` | 新增或删除文档节点 |
| `update_top` | 修改顶层图描述或节点列表 |

写入工具只修改文档工作区。最终是否提交由用户在前端 Git 面板通过 `/api/doc-git/commit` 手动完成，这样可以把 Agent 修改、人工审核和 Git 历史分开。

其中 `patch_page` 是增量维护的核心工具：

```typescript
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

`old_text` 必须在当前页面中恰好出现一次。零次匹配说明上下文过期，多次匹配说明定位不够精确，两种情况都应该让 Agent 重新读取文档后再尝试。

### 7.3 doc-drill：面向 Agent 的渐进式查询协议

autoDoc 会在目标仓库安装 Codex 项目级 `.codex/skills/doc-drill/SKILL.md`，并写入 Codex / Claude Code 对应的 MCP 配置。

这里有一个重要顺序：

1. 基础文档生成完成后，Arranger 安装 `doc-drill` Skill，并写入 Codex / Claude Code MCP 配置。
2. 此时 `get_flows` 已存在，但在 `flows.json` 生成前只会提示 flow 尚未生成。
3. Flow Analyzer 读取完整文档树和源码，生成 `flows.json`；写入后同一个 MCP 工具即可返回典型流程。

`doc-drill` 定义的查询方式是渐进式披露：

```text
1. Orient  → get_top      先看项目顶层结构
2. Flows   → get_flows    对端到端问题先看典型流程
3. Locate  → get_graph    钻入 1-2 个最相关模块
4. Focus   → get_page     读取具体叶子页面
5. Search  → search_nodes 不确定位置时再搜索
```

这样做的价值是控制上下文规模。Agent 先通过图结构判断相关性，只在必要时读取叶子页面和源码文件。

---

## 八、增量更新：让文档跟随 PR 演进

初次生成只解决“从无到有”，文档真正的成本在后续维护。autoDoc 的增量更新由 PrUpdater Agent 和 `UpdateQueuePanel` 共同完成。

整体流程如下：

1. 发现新变更：优先通过 `gh pr list` 查找新合并 PR，失败时回退到 `git log --first-parent`。
2. 按合并时间排序：从旧到新处理，保证文档状态逐步前进。
3. checkout 到目标 merge commit。
4. 构造包含 PR 元信息、变更文件和 diff 的 prompt。
5. PrUpdater 先判断影响范围，再通过 MCP 工具做最小修改。
6. 处理结果通过 SSE 流式推送到前端，并写入 `update-log.jsonl`。

PrUpdater 的影响评估分三类：

| Impact | 处理策略 |
|--------|----------|
| `none` | 不影响文档语义，直接短路，不调用写工具 |
| `minor` | 影响已有说明，用 `patch_page` 做定点修改 |
| `structural` | 模块结构变化，使用 `create_node`、`delete_node`、`update_node` 或 `update_graph_meta` |

更新队列支持两种运行模式：

| 模式 | 状态流转 | 适用场景 |
|------|----------|----------|
| Auto | `idle → running → done` | 对文档维护自动化程度要求更高的项目 |
| Manual | `idle → awaiting-confirm → running → awaiting-review → done` | 需要人工在执行前补充要求、执行后审核结果的项目 |

Manual 模式下，用户可以在执行前追加指令，例如“重点关注 API 参数变化”。执行后也可以对 PrUpdater 的报告继续追问，系统会通过保存的 `sessionId` 恢复会话并调用 `agent.continue()`。

---

## 九、前端体验：从生成进度到文档维护

autoDoc 的前端基于 Vue 3 和 TypeScript，核心页面包括：

| 页面 / 组件 | 职责 |
|-------------|------|
| `HomePage` | 项目选择、Git URL 输入、运行配置、生成进度展示 |
| `KnowledgePage` | 生成前收集业务背景，产出 `knowledge.md` |
| `GraphPage` | 展示模块图、文档预览、编辑、拆分视图 |
| `UpdateQueuePanel` | 展示增量更新队列、Auto / Manual 模式和任务状态 |
| `TaskConfirmDialog` | 执行前确认、执行中流式报告、执行后审核和追问 |

其中 `GraphPage` 使用 AntV G6 渲染模块关系图。用户可以从顶层模块逐级进入子图，也可以点击叶子节点查看 Markdown 文档。生成过程中的状态变化通过后端进度接口持续刷新。

如果开启 `Review all decompositions`，Scaffold 和 Decomposer 的结构产物会进入人工审核流程。用户可以在前端编辑节点和边，直接批准，也可以输入反馈让对应 Agent 基于原会话重新生成。

---

## 十、使用路径

### 10.1 环境准备

```bash
git clone <autoDoc 仓库地址>
cd autoDoc
pnpm install

cp .env.example .env
# 填入需要的 Agent 后端凭证
```

运行环境需要 Node.js 18+ 和 pnpm。

### 10.2 启动服务

```bash
# 只启动后端，默认端口 3100
pnpm dev

# 同时启动后端和前端
pnpm start
```

### 10.3 首次生成文档

在前端输入目标仓库 Git URL 后，autoDoc 会执行：

1. Clone 目标仓库到本地。
2. 可选进入 Knowledge Elicitor，补充代码中无法直接看出的业务背景。
3. 运行 Scaffold、Checker、Decomposer、Writer 完成初步文档内容，并装配 MCP / `doc-drill`。
4. 实时展示模块处理进度。
5. 再运行 Flow Analyzer，生成可交互的文档树、模块图、叶子 Markdown 页面和典型流程。

### 10.4 后续增量更新

项目有新 PR 合并后，在 `UpdateQueuePanel` 中启动更新。系统会自动发现尚未处理的 PR 或 commit，按顺序执行 PrUpdater，并把更新报告追加到：

```text
src/souko/doc/{projectName}/update-log.jsonl
```

处理完成后，`src/souko/projects.json` 中的 `lastProcessedSha` 会前进到最新完成的提交。

### 10.5 对文档提问

初步文档生成后，目标仓库会具备 `doc-drill` Skill 和 MCP 配置。之后在该仓库中向 Code Agent 提问时，Agent 可以通过 `/mcp` 渐进式读取文档；`flows.json` 生成前端到端流程查询会明确提示尚未生成：

- 架构问题先读 `get_top`。
- 端到端流程问题先读 `get_flows`。
- 具体模块问题再钻入 `get_graph` 和 `get_page`。

---

## 十一、二次开发与扩展点

autoDoc 的实现刻意保留了几个明确的扩展边界，方便接入不同模型、修改 prompt 或扩展文档工具。

### 11.1 替换或新增 Agent 后端

新增后端只需要实现对应接口，并在 `src/agents/tsukai/index.ts` 与 `src/workflow/arranger/agentFactory.ts` 注册。

示例：

```typescript
import type { AgentResult, IDecomposer, RawGraph } from "../../agents/schemas/schema.js";

export class MyCustomDecomposer implements IDecomposer {
  private sessionId: string | undefined;

  getSessionId() {
    return this.sessionId;
  }

  restore(sessionId: string, workpath: string) {
    this.sessionId = sessionId;
  }

  async run(prompt: string, workpath: string): Promise<AgentResult<RawGraph>> {
    // 调用自定义模型或内部 Agent 服务
  }

  async continue(prompt: string): Promise<AgentResult<RawGraph>> {
    // 在已有会话上继续
  }
}
```

### 11.2 定制 Agent 指令

Agent 指令按语言拆分在：

```text
src/agents/instructions/
├── cn/
│   ├── scaffold.ts
│   ├── decomposer.ts
│   ├── wirter.ts
│   ├── checker.ts
│   ├── flowanalyzer.ts
│   └── prupdater.ts
└── en/
    └── ...
```

其中 `wirter.ts` 是历史拼写，当前代码仍沿用这个文件名。`PromptBuilder` 负责把指令模板、仓库路径、祖先上下文和 `knowledge.md` 拼装成最终 prompt。

### 11.3 扩展 MCP 工具

MCP 工具主要分布在两个文件：

- `src/mcp/tools/query.ts`：查询工具。
- `src/mcp/tools/mutate.ts`：写入工具。

如果新增工具，通常需要：

1. 在对应工具文件中注册 MCP tool。
2. 在 `DocStore` 中补充必要的读写逻辑。
3. 如需暴露给 doc-drill，同步更新 `src/skill-template/SKILL.md`。
4. 如需生成后自动配置，更新 `src/workflow/arranger/pipeline.ts` 中的工具白名单。

写入工具应继续遵守当前边界：只修改文档工作区，不直接提交 Git。

### 11.4 定制文档 Schema

文档结构有两层 schema：

| 文件 | 作用 |
|------|------|
| `src/agents/schemas/schema.ts` | 内部 schema，包含状态、sessionId、pageTasks 等 Arranger 字段 |
| `src/mcp/schema.ts` | MCP 层 schema，使用 `.loose()` 保留未知字段，避免读写时丢失内部元数据 |

如果要给节点增加 `owner`、`priority` 等字段，需要同时考虑生成端、MCP 读写端、前端展示端和 Checker 校验逻辑。

---

## 十二、关键目录速查

| 路径 | 用途 |
|------|------|
| `src/workflow/arranger.ts` | Arranger 主入口，管理阶段、暂停、恢复和审核等待 |
| `src/workflow/arranger/pipeline.ts` | Pipeline 执行器，封装 scaffold、decompose、write、flow 等阶段 |
| `src/workflow/arranger/graphStore.ts` | 图节点状态管理、任务认领、恢复和审核操作 |
| `src/workflow/arranger/runtime.ts` | Semaphore 和重试工具 |
| `src/workflow/arranger/agentFactory.ts` | Agent 工厂，按角色选择 Claude / Codex 后端 |
| `src/workflow/arranger/promptBuilder.ts` | Prompt 组装逻辑 |
| `src/agents/schemas/schema.ts` | Agent 接口、Zod schema 和结构化输出类型 |
| `src/agents/tsukai/` | Claude / Codex Agent 后端实现 |
| `src/agents/instructions/{cn,en}/` | 各 Agent 的系统指令模板 |
| `src/mcp/tools/query.ts` | MCP 查询工具 |
| `src/mcp/tools/mutate.ts` | MCP 写入工具 |
| `src/mcp/docStore.ts` | 文档存储、路径解析、读写与锁 |
| `src/mcp/docGit.ts` | 文档工作区 Git status、commit、blame |
| `src/workflow/updateOrchestrator.ts` | PR 增量更新队列和 Manual / Auto 模式 |
| `src/git/prDiscovery.ts` | PR / commit 发现和 diff 读取 |
| `src/skill-template/SKILL.md` | doc-drill Skill 模板 |
| `src/server.ts` | 后端 HTTP API 和 SSE 推送 |
| `web/` | Vue 3 前端 |

---

## 十三、总结

autoDoc 解决的问题不是“用 AI 写一篇文档”，而是“让代码文档具备工程系统应有的生命周期能力”。

它把仓库级文档生成拆成可观测、可恢复、可校验的状态机流程；把产物组织成可导航的递归图结构；再通过 MCP 和 doc-drill 把文档变成 Code Agent 可以持续查询和维护的知识层。对于中大型仓库而言，这比一次性生成 Markdown 更接近真实团队需要的文档基础设施。
