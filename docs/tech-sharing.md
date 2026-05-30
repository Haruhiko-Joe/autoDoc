# ACCEED：断档SOTA的面向代码仓库的多 Agent 文档生成流水线

## 一、TL;DR

ACCEED 通过一个 Agent Pipeline 把一个仓库变成一个对于 human 和 Agent 都可消费的文档知识库——Web 前端供人消费，MCP 工具和配套 skill 让 Code Agent 可以持续查询和维护文档。

两个直接收益：

- **O(log N) 的上下文定位**：文档树递归分层，Agent 从顶层图出发，每下钻一层范围缩小一个量级。代码规模翻倍时查询深度只增加一层，token 消耗几乎不变。配套的 doc-drill skill 让 Agent 精确获取目标上下文，不必在无关代码中筛选杂讯，同时每个节点的 edges 自带全局位置感知——Agent 在读取任意模块时自动获得它在系统中的角色和上下游交互。
- **零额外成本的代码洞察**：文档生成过程中 Agent 已完整阅读所有代码，ACCEED 在主任务完成后释放 Agent 被 prompt 抑制的认知，输出代码问题和改进方案，相当于附赠一份轻量级 code review。

实测数据显示，以 ACCEED 产出的文档站为知识源的 Code Agent 对于复杂的跨模块业务细节有了更深刻精确的理解，在代码复杂 QA 对测试中实现了 100% 的正确率。

项目已开源并得到作者的商业授权，支持 Claude 和 Codex 双后端混合调度。如果你的团队正在面对"文档写了没人更新""新人入职只能读代码"这类问题，ACCEED 提供从初次生成到 PR 级增量维护的完整自动化链路。对于跨 repo 开发场景，ACCEED 彻底消除了"必须把多个仓库放进同一个 workspace"的限制——Code Agent 只需连上 MCP 即可按需查询任意已生成文档的仓库，跨库上下文获取和本地仓库一样轻量。

**GitHub**: https://github.com/Haruhiko-Joe/autoDoc

## 二、背景：代码文档长期难以维护的工程根因

团队里常见的文档问题通常发生在文档和代码生命周期脱节的地方：

- 新人入职后需要从入口文件一路追到业务逻辑，才能理解一个接口的真实调用链。
- README、Wiki 或设计文档停留在项目早期状态，代码演进后无人同步。
- 静态文档生成器擅长从注释提取 API，但很难解释跨模块流程和业务上下文。
- 一次性 AI 生成方案可以快速产出文档站，但后续维护成本仍然很高。

DeepWiki 这类工具证明了"仓库级 AI 文档"有明确的需求场景，但工程化落地时仍存在几个瓶颈：

| 问题 | 具体影响 |
|------|----------|
| 全量重跑 | 一个小改动可能触发整站重新生成，中型仓库一次运行就需要较长时间 |
| 缺少恢复点 | Agent 运行中断后中间结果丢失，只能从头开始 |
| 结构不可验证 | 模块引用、路径、边关系是否正确缺少系统化校验 |
| 产物不可操作 | 文档站只能阅读，无法被 Agent 精准查询、局部修改或增量维护 |
| 缺少运行时视角 | 静态模块文档无法直接回答"这个业务流程经过哪些模块" |

ACCEED 的切入点：**把文档生成当作编译流水线来做。** 每个阶段有明确输入输出，中间结果落盘，失败可以恢复，局部变更可以局部更新。

---

## 三、总体架构：Arranger 编排的五类 Agent

ACCEED 的主流程由 Arranger 状态机驱动：

```text
Scaffold → Checker → [Decomposer → Checker → Writer] × N → Assemble MCP/Skill → Flow Analyzer → done
                         │
                         └─ 子模块继续递归拆分
```

| Agent | 角色 | 主要产物 |
|-------|------|----------|
| Scaffold | 通读仓库，生成顶层模块划分 | `top.json` |
| Decomposer | 递归拆分模块，决定继续分解还是生成叶子页 | 子图 JSON |
| Writer | 为叶子节点生成详细 Markdown 文档 | `*.md` |
| Checker | 校验 Scaffold 和 Decomposer 的图结构 | 通过结果或问题列表 |
| Flow Analyzer | 从完整文档和源码中提取典型跨模块流程 | `flows.json` |

每个 Agent 只承担一个清晰的工程职责，这种拆分带来三个工程优势：

1. **上下文可控**：每个 Agent 只处理当前阶段需要的信息，无需一次塞入全仓库和全量文档。
2. **失败隔离**：某个模块失败时只影响该节点，已完成的模块不受波及。
3. **后端可替换**：同一角色可以选择 Claude 或 Codex 后端，Arranger 只依赖统一接口。

所有 Agent 暴露同一组生命周期方法：

```typescript
export interface IDecomposer {
  getSessionId(): string | undefined
  restore(sessionId: string, workpath: string): void
  run(prompt: string, workpath: string): Promise<AgentResult<RawGraph>>
  continue(prompt: string): Promise<AgentResult<RawGraph>>
}
```

`run` / `continue` / `restore` / `getSessionId` 四件套是整个系统可恢复、可替换、可追问的基础。

---

## 四、关键设计一：用节点状态驱动调度和恢复

ACCEED 没有引入 Redis、BullMQ 或专用编排框架。它将文档树中每个模块节点直接视为一个任务，任务状态写在对应的 JSON 文件中。

```text
pending → decomposing → writing → done
                         │
                         └─ pageTasks 逐页完成

可选人工审核：decomposing → awaiting-review → writing / done
异常：decomposing / writing / checking → error
```

Arranger 扫描文档树，按状态认领可执行节点。这个设计带来三个直接收益：

**文件系统即任务队列。** 调试时 `ls` 一下 JSON 文件即可知道进度——`pending` / `writing` / `done` 一目了然。

**崩溃恢复只需重启。** 中间态（`decomposing` / `writing` / `checking`）在启动时被重新放回可调度集合，已完成的 page task 被保留，已保存的 `sessionId` 允许通过 `restore()` 回到同一会话上下文。

**并发由认领驱动。** 默认 8 个并发 worker，每个通过 `claimNextTask()` 领取节点后立即变更状态，其他 worker 自动跳过。Decomposer 产出的子节点初始状态为 `pending`，自然进入下一轮调度——递归展开无需额外编排逻辑。

---

## 五、关键设计二：自索引的递归文档树

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

三个关键字段：

- **`child.type`**：Decomposer 的终止条件。`"graph"` 继续展开子图，`"page"` 交给 Writer 输出文档。深度根据代码复杂度自适应展开。
- **`edges`**：六种语义边（`calls` / `depends` / `data-flow` / `event` / `extends` / `composes`），驱动前端交互式模块图渲染，也让 Agent 可沿边追踪调用链。
- **`codeScope`**：每个节点声明覆盖的源文件/目录，帮助文档反查代码、帮助增量更新定位受影响节点。Checker 会校验路径真实性。

---

## 六、关键设计三：Checker 作为结构质量闸门

AI 生成文档时，最容易出问题的是结构层面：边指向不存在的节点、`codeScope` 指向不存在的文件、节点名称重复、description 为空。

ACCEED 用独立的 Checker Agent 做结构校验（`broken-target` / `invalid-path` / `empty-content`）。失败时 Arranger 将问题反馈给原 Agent，通过 `continue()` 在同一会话中修复——模型保留上一轮方案和错误上下文，修复质量远优于从零重试。

---

## 七、关键设计四：Insight——文档生成的认知副产物

Decomposer 和 Writer 在执行主任务时，已经对所覆盖的代码做了完整的阅读和语义理解。如果代码存在设计缺陷、潜在 bug 或可改进之处，Agent 在认知层面已经形成了判断——只是主任务的 system prompt 约束了输出边界，这些认知被抑制了。

ACCEED 的做法：保持主任务 prompt 不变，在每个 worker Agent 完成主任务之后，通过 `continue()` 传入一个专门的 insight prompt，让 Agent 将阅读代码过程中形成的判断释放出来——输出它发现的问题、可改进项及配套方案。

```text
Worker 完成主任务（Decompose / Write）
  → continue(insight prompt)
  → Agent 输出 issues / improvements / plan
  → 落盘 insight log
  → 改进与否由人审决定
```

设计意图：**零额外扫描成本**。Agent 已经把代码完整读过了，insight 只是将被主任务 prompt 压制的认知通道打开。产出的 insight 带有明确的模块归属和代码定位，团队可以当作一份附赠的轻量级 code review 来使用。

是否采纳、何时行动，完全交由人决定。ACCEED 只负责收集和呈现。

---

## 八、关键设计五：MCP Server 与 doc-drill Skill

文档生成完成后，真正的价值在于能否被持续消费。ACCEED 通过 MCP Server 暴露文档读写工具，通过 `doc-drill` Skill 给 Code Agent 一套稳定的渐进式导航协议。

**查询工具**：`get_top` → `get_flows` → `get_graph` → `get_page` → `search_nodes`，按层级逐步获取上下文，避免一次性读取整个文档站的 context 浪费。

**写入工具**：`patch_page`（精确字符串替换，匹配次数必须恰好为 1）、`update_page`、`update_node`、`create_node` / `delete_node` 等。写入只修改文档工作区，最终提交由用户手动完成。

**doc-drill 渐进式查询协议**：

```text
1. Orient  → get_top      顶层结构总览
2. Flows   → get_flows    端到端流程
3. Locate  → get_graph    钻入相关模块
4. Focus   → get_page     读取叶子文档
5. Search  → search_nodes 模糊定位
```

这套协议解决了 Code Agent 消费大型代码库时的两个核心问题：

**精确上下文获取，消除杂讯。** 传统做法是让 Agent 直接 grep 或遍历源码——对于中大型仓库，返回的结果充满不相关的噪声，Agent 需要大量 token 去筛选和消歧。doc-drill 的图结构提供了预先计算好的语义索引：每个节点的 `description` 和 `edges` 已经标注了模块职责和协作关系，Agent 只需沿图定位，直达目标上下文，不必在无关代码中跋涉。

**O(log N) 的上下文定位复杂度。** 文档树是递归分层的——顶层图覆盖全仓库，每下钻一层就将范围缩小到一个子模块。对于一个包含 N 个模块的仓库，Agent 从 `get_top` 出发，经过 log N 次 `get_graph` 调用即可抵达目标叶子页面。代码规模翻倍时，查询深度只增加一层，token 消耗和延迟几乎不变。

**模块在全局中的位置感知。** 每一层图的 `edges` 字段显式标注了当前模块与兄弟模块的交互关系（calls / depends / data-flow / event 等）。Agent 在读取某个模块文档的同时，自然获得了它在整个系统中的角色和上下游依赖，无需额外拼凑全局视图。

---

## 九、增量更新：让文档跟随 PR 演进

初次生成解决 day 0，增量更新解决 day 1 到 day N。

PrUpdater Agent 的工作流程：发现新合并 PR → 按合并时间从旧到新处理 → checkout 到 merge commit → 评估影响级别 → 通过 MCP 工具做最小修改 → 结果 SSE 流式推送 + 写入 `update-log.jsonl`。

影响评估：

| 级别 | 处理 |
|------|------|
| `none` | 跳过 |
| `minor` | `patch_page` 定点修改 |
| `structural` | `create_node` / `delete_node` / `update_node` 等结构变更 |

两种模式：**Auto**（全自动）和 **Manual**（加入 `awaiting-confirm` / `awaiting-review` 两个人工闸门，支持执行前追加指令、执行后审核追问）。

---

## 十、与现有方案对比

| 维度 | ACCEED | DeepWiki | 静态文档生成器 |
|------|--------|----------|---------------|
| 生成模式 | 5 Agent 迭代 + Checker 循环 | 单次生成 | 注释提取 |
| 增量更新 | PR 级局部改写 | 全量重建 | 依赖人工 |
| 结构表示 | 6 种语义边的递归图 | 静态 Mermaid | 扁平目录 |
| 深度控制 | Agent 自主决定 | 固定层级 | 固定层级 |
| 崩溃恢复 | Session ID + pending 暂存 | 无 | N/A |
| Agent 消费 | HTTP MCP（query + mutate） | 只读 | 只读 |
| Code Agent 集成 | doc-drill skill | 无 | 无 |
| 代码洞察副产物 | Insight（零额外扫描成本） | 无 | 无 |

---

## 十一、快速上手

```bash
git clone https://github.com/Haruhiko-Joe/autoDoc.git
cd autoDoc && pnpm install
cp .env.example .env   # 填入 Claude API Key / Codex 配置
pnpm start             # 启动后端 + 前端
```

在前端输入目标仓库 Git URL → 可选补充业务背景 → 自动运行全流程 → 产出可交互文档站 + MCP 接口 + doc-drill Skill。后续有 PR 合并时在 UpdateQueuePanel 启动增量更新即可。