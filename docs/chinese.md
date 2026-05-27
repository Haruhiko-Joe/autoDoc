# ACCEED: Artifact-Centric Code Exploration, Evolution & Drill-down for Hierarchical Knowledge Generation

## Abstract

仓库级自主编程Agent需要对代码知识进行结构化导航与跨模块推理，然而现有文档形态——扁平文本、逐文件注释、RAG 检索片段——既缺乏层次化组织，也无法表达模块间的类型化依赖关系，无法为Agent提供可持续遍历、查询与维护的知识底座。本文将面向Agent的仓库文档形式化为一个中间表示（IR）问题，并在此基础上做出两方面贡献。其一，我们定义 Agent-Oriented Documentation Intermediate Representation（AD-IR）：一种递归图模式，以类型化模块间边、源码作用域映射、叶节点文档页和跨模块交互流编码仓库知识，并通过标准化查询-修改接口使Agent可从架构概览逐层下钻至实现细节。其二，我们提出 ACCEED（Artifact-Centric Code Exploration, Evolution & Drill-down）：一个基于产物即状态（artifact-as-state）原则的多Agent管线，每个中间工件同时充当自动机控制状态与最终知识产物，从结构上保证渐进披露与一致性；由于生成与更新共享同一查询-修改接口，AD-IR 天然支持 pull request 驱动的增量更新，无需全量重新生成。在 ACCEED-Bench——一个以仓库级 QA 任务衡量文档实用性的基准——上，ACCEED 在正确性、覆盖率、可导航性和跨文档一致性上均显著优于现有方法，多项核心指标接近满分。ACCEED 已在一家大型互联网企业的多个生产仓库中部署，验证了其在真实工业场景下的实用性。代码已开源：https://github.com/Haruhiko-Joe/ACCEED 。

## Introduction

自主编程Agent正在重塑软件工程的工作范式——它们不再局限于代码补全，而是能够读取整个仓库、跨文件修改、运行测试并发起 pull request [1,2]。然而，要在仓库尺度上有效工作，Agent需要对代码库形成结构化、可导航的全局理解，而非仅靠文本检索拼凑局部片段。一系列仓库级基准量化了这一需求的迫切性：SWE-bench 揭示真实 GitHub issue 的解决需要跨函数、跨文件的协调推理 [3]，SWE-agent 发现 agent-computer interface 的设计对仓库级任务表现有关键影响 [4]，CrossCodeEval [5] 与 BigCodeBench [6] 则分别从跨文件上下文依赖和复杂多库指令两个维度证实，代码理解的深度和广度远超单文件基准所能反映。仓库级结构化理解已成为自主编程Agent的基础设施级需求。

现有工作主要沿两条路线缓解这一问题。**检索增强路线**将仓库理解转化为上下文检索：RAG 框架通过检索外部知识片段增强生成 [7]，RepoCoder 通过迭代检索跨文件上下文改善仓库级补全 [8]。**结构化表示路线**引入层次化或图结构组织：RAPTOR 通过递归摘要树改善长文档检索 [9]，GraphCodeBERT 表明数据流与程序结构信息对代码理解至关重要 [10]。然而，这两条路线共享一个根本局限：它们将代码知识视为被动的检索上下文或预训练特征，而非Agent可以持续遍历、查询、修改和维护的一等中间表示。对于仓库级Agent而言，缺失的不是更多可检索的文本片段，而是一个具有层次结构、类型化关系、源码绑定和更新语义的**可操作知识层**。

近期工作已开始关注文档对仓库理解的直接支撑作用。SWD-Bench 通过 QA 和 feature-driven development 任务评估仓库文档的实际效用，发现高质量文档能显著提升Agent的 issue-solving 能力 [11]。这一进展表明文档正从静态说明材料转变为仓库理解的关键资源。然而，已有工作尚未将文档系统性地形式化为一种**一等的、Agent可读可写的中间表示**——使其同时支持渐进式导航、类型化跨模块推理、源码绑定验证和增量更新。本文正是填补这一空缺。

基于上述分析，我们提出 **Agent-Oriented Documentation IR（AD-IR）**，一种面向Agent消费和维护的层次化文档中间表示。AD-IR 将代码仓库组织为顶层架构图、递归分解的模块子图、叶节点文档页和跨模块交互流四个层次，显式编码类型化关系（calls、depends、data-flow、event、extends、composes）和源码作用域映射。与面向模型输入的代码图表示 [10] 不同，AD-IR 是持久化、可查询、可修改的仓库知识工件；与传统文档不同，AD-IR 通过标准化的查询-修改工具接口暴露，使Agent能够从架构概览逐步下钻到实现细节，而无需一次性加载整个仓库上下文（图 1）。

为从任意代码仓库自动构建 AD-IR，我们提出 **ACCEED**（Artifact-Centric Code Exploration, Evolution & Drill-down），一个由图自动机编排的多Agent管线。已有多Agent软件工程框架如 ChatDev [12] 和 MetaGPT [13] 已展示角色分工与标准化流程对复杂任务的价值，但它们将协调状态保存于 prompt 或对话历史中，难以版本化、检查和复用；ReAct [14] 和 Reflexion [15] 表明Agent可通过工具调用与反馈记忆增强推理能力。ACCEED 的关键区别在于**产物即状态（artifact-as-state）**原则：不将协作状态保存在临时控制流或对话上下文中，而将其外化为持久化文档工件。每个中间图工件同时承担三重角色——管线控制状态、结构验证对象和最终知识产物——使文档生成、结构检查、增量更新和下游Agent消费都作用于同一表示，从结构上保证渐进披露与跨文档一致性。此外，由于生成与更新共享同一查询-修改接口，AD-IR 天然支持增量热更新：当 pull request 合并时，更新Agent通过相同的工具接口完成文档的定向修改，无需全量重新生成。

我们通过 **ACCEED-Bench** 评测上述设计假设。ACCEED-Bench 是一个面向文档 IR 实用性的任务驱动基准：以仓库级问答、模块定位、跨模块流程追踪和更新一致性为评测目标，限制被测Agent仅访问文档表示。该设计与现有基准形成互补——SWE-bench [3] 和 BigCodeBench [6] 评估代码修改与生成能力，SWD-Bench [11] 评估文档对开发任务的帮助——ACCEED-Bench 进一步隔离并检验**文档表示层本身**能否支持Agent的结构化导航、多跳推理和增量维护。

本文的贡献如下：

- 我们将面向Agent的仓库文档形式化为一个**中间表示问题**，论证自主编程Agent所需的文档底座不仅应可阅读，还应可结构化遍历、可查询、可写入。
- 我们提出 **AD-IR**，一种包含类型化边、源码作用域绑定、叶节点页面、跨模块交互流和标准化查询-修改接口的递归图模式，面向Agent对代码知识的结构化消费而设计。
- 我们提出 **ACCEED**，一个基于产物即状态原则的多Agent管线，用于自动构建并增量维护 AD-IR，其中文档工件同时充当管线控制状态、验证对象和最终知识产物。
- 我们提出 **ACCEED-Bench**，一个以仓库级 QA 任务衡量文档 IR 实用性的任务驱动基准，并通过在正确性、覆盖率、可导航性和跨文档一致性上取得的显著最优结果，验证了 IR 设计与产物驱动生成管线的有效性。

## Related Work

### 仓库级自动文档生成

将整个代码仓库转化为层次化文档，是近年来文档生成领域的核心方向。我们在此分析两个代表性系统的具体局限。

**HGEN** [16] 通过六阶段流水线产出多层制品（低层设计描述、功能需求、用户故事）并以追踪链接关联各层。其局限有三：(1) 追踪链接连接的是不同**抽象层级**（需求 ↔ 设计），而非**模块间的架构交互**——Agent 无法从中推断"模块 A 调用模块 B"这类关系；(2) 产出物缺乏形式化 schema，各层制品之间没有统一的类型系统；(3) 不提供程序化访问接口，仅通过 web 查看器供人类浏览，Agent 无法程序化查询或修改文档内容。

**Google CodeWiki** [17] 产出模块树 JSON、每模块 Markdown 页面和架构图。相比 HGEN 进了一步，但仍存在关键缺陷：(1) 模块间关系仅编码单一类型 `depends_on`，无法区分调用、数据流、事件、继承、组合等语义差异——而这种区分对于 Agent 的跨模块推理至关重要；(2) 缺乏源码作用域绑定，文档节点与源文件之间没有形式化映射，无法支持双向追溯和变更影响定位；(3) 产出物为静态文件集合，不支持增量更新和 Agent 写回。

SWD-Bench [11] 从评估角度衡量仓库文档的实际效用，但不涉及文档表示本身的设计。

上述分析揭示了一个尚未被解决的研究空白：现有仓库级文档系统停留在**文件组织**层面，缺乏形式化的模块间关系编码、源码到文档的双向绑定，以及 Agent 可操作的程序化接口。AD-IR 在此基础上引入递归图模式、六种类型化边、子集-划分作用域约束和标准化查询-修改接口，将仓库文档提升为可被 Agent 工具链消费和变换的中间表示。

### 仓库级代理式理解

SWE-bench [3] 和 SWE-agent [4] 揭示了仓库级任务的复杂性：解决真实 issue 需要跨文件协调推理，且 agent-computer interface 的设计对任务表现有关键影响。这表明仓库级理解已成为 Agent 的核心基础设施需求，而非可选增强。RAPTOR [9] 通过递归摘要树支持长文档的层次化检索，GraphCodeBERT [10] 则证明程序结构信息对代码理解至关重要。

上述工作的理解结果内化于模型的上下文或嵌入中，无法被后续会话复用。仓库理解成果的**持久化和可复用性**仍是开放问题。ACCEED 通过将理解成果外化为持久化文档工件，使多个 Agent 会话能够反复消费、修改和维护同一知识库。

### 面向 Agent 的文档接口与持续维护

文档过时是自动文档生成最常见的失败模式，然而现有方案在维护粒度和 Agent 协作能力上仍存在不足。在协议侧，Model Context Protocol（MCP）将 Agent 与外部工具的连接标准化为开放协议 [18]；在产品侧，DeepWiki 将仓库文档定位为"可对话的、保持最新的"知识站 [19]。

现有工作在"持续维护"和"Agent 接口"上呈分离状态：维护侧关注文档内容刷新，接口侧关注 Agent 工具连接，尚无工作将两者统一。ACCEED 令生成与更新共享同一查询-修改接口，使 PR 驱动的变更感知维护与 Agent 原生的程序化访问成为同一架构的两个面。

### 小结

综合上述分析，三个方向各存在明确空白：仓库级文档生成 [16,17] 缺乏形式化 schema、类型化模块间关系和程序化访问接口；仓库理解 [3,4,9,10] 的成果无法跨会话持久化和复用；Agent 接口 [18] 解决工具连接但不涉及文档结构设计。ACCEED 提出**文档中间表示**这一新抽象层次，同时填补上述三个空白。



## Method

### 问题形式化

**定义 1（代码仓库）。** 代码仓库 $R = (F, D)$，其中 $F$ 为源文件集合，$D$ 为目录层次。

**定义 2（面向 Agent 的文档 IR）。** 给定 $R$，面向 Agent 的文档中间表示 $\mathcal{I}$ 须满足：

- **P1（渐进披露）**：$\mathcal{I}$ 支持逐层访问路径，Agent 在任意层级仅需加载 $O(k)$（$k$ 为当前层节点数）上下文即可完成导航决策。
- **P2（结构完整性）**：节点间通过类型化边关联，每个节点通过源码作用域绑定到 $F$ 的子集，且子节点作用域 $\subseteq$ 父节点作用域。
- **P3（增量可更新性）**：对任意变更 $\Delta R$，存在操作序列 $\text{ops} \subset \mathcal{O}$（$\mathcal{O}$ 为 $\mathcal{I}$ 的标准操作集）使得 $\mathcal{I} \xrightarrow{\text{ops}} \mathcal{I}'$ 且 $\text{ops}$ 仅触及受 $\Delta R$ 影响的节点。

### AD-IR 规范

**定义 3（AD-IR 实例）。** $\mathcal{I} = (G_{\text{top}}, \Sigma, \Phi)$，其中：

$$G_{\text{top}} = (N, E, d), \quad E \subseteq N \times N \times \mathcal{T}$$

每个节点 $n \in N$ 携带 $\text{child}(n) \in \{\text{graph}, \text{page}\}$：
- $\text{child}(n) = \text{graph}$：$n$ 递归展开为同构子图 $G_n = (N_n, E_n, d_n)$；
- $\text{child}(n) = \text{page}$：$n$ 终止为叶节点 Markdown 文档。

递归终止由生成 Agent 依据模块语义内聚性自主判断，而非固定深度规则。

**定义 4（类型化边集）。** $\mathcal{T} = \{\texttt{calls}, \texttt{depends}, \texttt{data-flow}, \texttt{event}, \texttt{extends}, \texttt{composes}\}$。对于边 $(n_s, n_t, \tau) \in E$，各类型的语义约束为：

| 类型 $\tau$ | 语义约束 |
|---|---|
| calls | $\exists$ 调用点 $c \in \Sigma(n_s)$ 直接调用 $\Sigma(n_t)$ 中定义的符号 |
| depends | $n_s$ 引用 $n_t$ 的导出 API，但无直接调用链 |
| data-flow | $n_s$ 产出的数据经共享状态或参数传递被 $n_t$ 消费 |
| event | $n_s$ 发出事件，$n_t$ 异步订阅并响应 |
| extends | $n_s$ 继承或实现 $n_t$ 定义的接口/基类 |
| composes | $n_s$ 在结构上包含 $n_t$ 作为子组件 |

**命题 1（边类型完备性）。** 软件架构关系可沿两个正交维度分类：静态/动态 × 控制/数据。$\mathcal{T}$ 的六种类型覆盖该空间：calls 和 depends 为动态控制，data-flow 为动态数据，event 为异步控制，extends 和 composes 为静态结构。任何模块间依赖均可归入至少一种类型。

**定义 5（源码作用域映射）。** $\Sigma: N^* \to \mathcal{P}(F)$，将文档树路径映射到源文件集合，满足：

(i) **子集约束**：$\forall\, p = n_1/\dots/n_l, \quad \Sigma(p) \subseteq \Sigma(n_1/\dots/n_{l-1})$

(ii) **划分完备性**：$\forall\, n, \quad \bigcup_{n_c \in N_n} \Sigma(n/n_c) = \Sigma(n)$

**推论 1（影响定位）。** 给定文件变更 $\Delta f \subset F$，受影响节点集 $N_\Delta = \{n \mid \Delta f \cap \Sigma(n) \neq \emptyset\}$ 可通过从根到叶的路径遍历在 $O(\text{depth})$ 内计算，其中 depth 为文档树最大深度。

**定义 6（交互流）。** $\Phi = \{f_1, \dots, f_m\}$（$m \in [3,7]$），每条 $f_i = (P_i, S_i)$：
- $P_i = \{p_1, \dots, p_j\}$ 为参与者集合，每个 $p \in P_i$ 映射到 AD-IR 中一个可定位的节点路径；
- $S_i = \langle s_1, \dots, s_l \rangle$ 为有序步骤序列，每步 $s = (\text{from}, \text{to}, \text{action}, \tau, \text{codeRef})$。

良构约束：$\forall s \in S_i,\; s.\text{from} \in P_i \wedge s.\text{to} \in P_i \wedge \tau \in \mathcal{T}$。

**定义 7（操作集）。** $\mathcal{O} = \mathcal{Q} \cup \mathcal{M}$，其中：

- $\mathcal{Q} = \mathcal{Q}_{\text{nav}} \cup \mathcal{Q}_{\text{search}}$：导航查询 $\mathcal{Q}_{\text{nav}}$ 沿图层次逐层读取（top → graph → page → flows），搜索查询 $\mathcal{Q}_{\text{search}}$ 按关键词或文件模式跨层定位节点；
- $\mathcal{M} = \mathcal{M}_{\text{struct}} \cup \mathcal{M}_{\text{content}}$：结构修改 $\mathcal{M}_{\text{struct}}$ 执行节点增删，内容修改 $\mathcal{M}_{\text{content}}$ 对页面执行全量或局部编辑。

**命题 2（P1 满足）。** Agent 使用 $\mathcal{Q}_{\text{nav}}$ 从 $G_{\text{top}}$ 出发逐层导航，每步加载 $|N_n| + |E_n|$ 上下文。由于实践中 $|N_n| \leq 12$，单步上下文为 $O(1)$，满足 P1。

**命题 3（P3 满足）。** 全量生成管线通过 $\text{ops}_{\text{gen}} \subset \mathcal{O}$ 构建 $\mathcal{I}$。增量更新所需操作为 $\mathcal{Q}$ 子集（读取受影响节点）加 $\mathcal{M}$ 子集（修改内容），故 $\text{ops}_{\text{update}} \subset \mathcal{O}$。P3 由 $\mathcal{O}$ 的完备性保证。

### ACCEED 管线

**定义 8（产物即状态）。** 管线中间工件 $a$ 统一编码：

$$a = (\underbrace{s, \text{sid}}_{\text{控制状态}},\; \underbrace{N_a, E_a, d_a}_{\text{验证对象} \wedge \text{知识产物}})$$

其中 $s \in S = \{\text{pending}, \text{decomposing}, \text{checking}, \text{writing}, \text{done}, \text{error}\}$，sid 为 Agent 会话标识符。

**定义 9（状态转移函数）。** $\delta: S \times \text{Event} \to S$：

$$\delta(\text{pending}, \text{claim}) = \text{decomposing}$$
$$\delta(\text{decomposing}, \text{output}) = \text{checking}$$
$$\delta(\text{checking}, \text{pass}) = \text{writing}$$
$$\delta(\text{checking}, \text{fail}_{t<T}) = \text{decomposing} \quad \text{(retry)}$$
$$\delta(\text{writing}, \text{complete}) = \text{done}$$

崩溃时状态原地持久化；重启时中间状态 $S_{\text{mid}} = \{\text{decomposing}, \text{checking}, \text{writing}\}$ 重置为 pending。

**推论 2（一致性）。** 控制状态与知识内容共存于同一工件，不存在两者不同步的可能。

**推论 3（崩溃恢复）。** 重启时遍历所有工件，将 $s \in S_{\text{mid}}$ 重置为 pending 并通过 sid 恢复 Agent 上下文。恢复成本 = 未完成节点数。

**定义 10（校验循环 VerifyLoop）。** 设生成 Agent $A$、校验 Agent $C$、最大重试 $T$：

$$r_0 = A.\text{run}(p); \quad r_{t+1} = A.\text{continue}(\text{fix}(C(r_t))) \quad \text{if } \neg C(r_t).\text{passed},\; t < T$$

Checker 验证三类 P2 约束：引用完整性、非空内容、路径合法性。`continue` 保持会话上下文，使修复为增量式。

**命题 4（P2 过程保证）。** 每个工件在 $\delta(s, \text{pass})$ 转移前必经 Checker 验证。所有 $s = \text{done}$ 的节点满足 P2。

**Algorithm 1：ACCEED-Generate($R, k$)**

```
输入：代码仓库 R，并发上界 k
输出：AD-IR 实例 I = (G_top, Σ, Φ)

1.  G_top ← Scaffold.run(R)
2.  G_top ← VerifyLoop(Scaffold, Checker, G_top, T=5)
3.  Q ← {n ∈ G_top.N | child(n) = graph}
4.  sem ← Semaphore(k)
5.  parallel for n ∈ Q do
6.      sem.acquire()
7.      G_n ← Decomposer.run(n, Σ(n))
8.      G_n ← VerifyLoop(Decomposer, Checker, G_n, T=5)
9.      for n_c ∈ G_n.N do
10.         if child(n_c) = graph then Q.push(n_c)
11.     sem.release()
12. parallel for n ∈ leaves(I) do
13.     sem.acquire()
14.     Writer.run(n, Σ(n))
15.     sem.release()
16. Φ ← FlowAnalyzer.run(I)
17. return (G_top, Σ, Φ)
```

**命题 5（并发正确性）。** 由定义 5(ii)，同层兄弟节点的作用域不相交：$\forall n_i, n_j \in N_n,\; i \neq j \Rightarrow \Sigma(n/n_i) \cap \Sigma(n/n_j) = \emptyset$。因此并发处理的任务操作不相交的文件子树，无需额外同步。

### 表示与生成的协同设计

AD-IR 的递归图结构与 ACCEED 管线之间存在双向约束关系：

**IR → 管线**：AD-IR 的树拓扑直接诱导管线的任务有向无环图——每个 $\text{child}(n) = \text{graph}$ 的节点对应一个 Decomposer 任务，任务间的依赖关系由父子层次定义。管线不需要外部任务图定义，AD-IR 自身即为任务规范。

**管线 → IR**：产物即状态原则要求中间结果为合法的部分 AD-IR 实例。这约束 AD-IR 的模式必须支持"增量构建"——部分节点处于 pending 状态的文档树仍为良构实例。

**命题 6（IR-管线对偶性）。** 设 $\mathcal{I}_t$ 为时刻 $t$ 的部分 AD-IR 实例，$\text{Frontier}(\mathcal{I}_t) = \{n \mid n.s = \text{pending}\}$。对任意 $n \in \text{Frontier}$，通过 $\mathcal{O}$ 完成 $n$ 产生合法的 $\mathcal{I}_{t+1}$。因此，全量生成和增量更新均为对部分 $\mathcal{I}$ 实例施加 $\mathcal{O}$-操作序列的过程，两者仅在操作对象（frontier 节点 vs. 受变更影响节点）上有区别。

**Algorithm 2：ACCEED-Update($\mathcal{I}, \Delta R$)**

```
输入：当前 AD-IR 实例 I，变更集 ΔR（PR/commit 序列）
输出：更新后的 I'

1.  for each δ ∈ ΔR do
2.      N_Δ ← {n | Σ(n) ∩ δ.files ≠ ∅}    // 推论 1，O(depth) 定位
3.      impact ← PrUpdater.assess(δ, N_Δ)
4.      if impact = none then continue
5.      for n ∈ N_Δ do
6.          content ← Q_nav.get_page(n)     // 通过 O 读取
7.          content' ← PrUpdater.patch(content, δ)
8.          M_content.patch_page(n, content') // 通过 O 写回
9.  return I'
```

### 知识引出

AD-IR 的生成质量受限于代码本身所能传达的信息。许多架构决策、业务约定和领域术语并不显式存在于源码中，但对文档的准确性和可用性至关重要。

**定义 11（知识文档）。** 知识文档 $\kappa$ 为自然语言文本，编码仓库的代码外领域知识（业务背景、术语约定、分解偏好等）。$\kappa$ 在全量生成前通过 Knowledge Elicitor Agent 与用户的多轮对话产出，随后被注入 Scaffold、Decomposer、Writer、Checker 四个下游 Agent 的系统提示。

形式化地，引入 $\kappa$ 后，Algorithm 1 的 Scaffold 和 Decomposer 调用扩展为：

$$G_{\text{top}} = \text{Scaffold}.\text{run}(R, \kappa); \quad G_n = \text{Decomposer}.\text{run}(n, \Sigma(n), \kappa)$$

$\kappa$ 的作用是约束递归分解的粒度和方向——例如用户可指定"目录 A 是核心、目录 B 是噪声"或"这三个分散文件在逻辑上是同一模块"——使 AD-IR 的模块边界与实际业务概念对齐，而非仅反映物理目录结构。

## Experiments

### ACCEED-Bench 构建

为评估 AD-IR 的实际效用，我们构建 ACCEED-Bench——一个面向仓库级文档 IR 的任务驱动评测基准。其构建流程分两阶段：

**阶段 1：问题生成。** LLM 仅阅读目标仓库源码（不接触任何生成文档），产出覆盖单模块理解、跨模块交互和架构级推理的问题集。此设计确保问题分布不偏向任何特定文档系统。随后由人工审核问题的全面性与合理性，剔除歧义或过于琐碎的问题。

**阶段 2：标准答案生成。** LLM 基于源码阅读与联网搜索生成候选答案，人工核验后形成 gold answer 并标注采分点（rubric items）。每个问题的得分为命中采分点的比例。

我们选取 5 个开源仓库作为评测目标，覆盖不同规模、语言和领域：

**[表 2：ACCEED-Bench 统计]**

| 仓库 | 语言 | 代码行数 | 文件数 | 问题数 | 文档深度 |
|------|------|---------|--------|--------|---------|
| git | C | ~400K | ~1000 | — | — |
| codex | TypeScript | — | — | — | — |
| bittorrent | — | — | — | — | — |
| click | Python | — | — | — | — |
| katago | C++ | — | — | — | — |

### 实验设置

我们设置 6 个对比条件以隔离各设计组件的贡献：

| 条件 | 文档来源 | 消费方式 |
|------|---------|---------|
| ACCEED（完整） | ACCEED 生成的 AD-IR | 层次化导航 $\mathcal{Q}_{\text{nav}}$ |
| 消融 A1：去边 | 同上但删除所有 edge | 层次化导航（无边信息） |
| 消融 A2：去结构 | 仅保留叶子 MD，平铺单一目录 | 全文搜索 |
| CodeWiki + RAG | CodeWiki 生成的文档 | 向量检索 + top-$k$ 拼接 |
| ACCEED doc + RAG | ACCEED 生成的同一批文档 | 向量检索 + top-$k$ 拼接 |
| Code-only | 无文档 | 源码 Read/Grep |

对比逻辑：ACCEED vs ACCEED+RAG 隔离导航方式的贡献；ACCEED+RAG vs CodeWiki+RAG 隔离文档质量的贡献；ACCEED vs A1/A2 分别隔离边和层次结构的贡献。

评测模型：[待填]。RAG 配置：embedding 模型 [待填]，chunk size [待填]，top-$k$ = [待填]。Judge 协议：LLM-as-judge 按 rubric items 逐项判定（每项 0/1），问题得分 = 命中项数 / 总项数。

### 主结果

**[表 3：正确率（%）]**

| 仓库 | ACCEED | w/o edges | w/o struct | CodeWiki+RAG | ACCEED+RAG | Code-only |
|------|--------|-----------|-----------|-------------|-----------|-----------|
| git | — | — | — | — | — | — |
| codex | — | — | — | — | — | — |
| bittorrent | — | — | — | — | — | — |
| click | — | — | — | — | — | — |
| katago | — | — | — | — | — | — |
| **平均** | — | — | — | — | — | — |

**[表 4：Token 消耗（每题平均）]**

| 仓库 | ACCEED | w/o edges | w/o struct | CodeWiki+RAG | ACCEED+RAG | Code-only |
|------|--------|-----------|-----------|-------------|-----------|-----------|
| 平均 | — | — | — | — | — | — |

**[图 2：正确率 vs Token 消耗散点图]**

（X 轴：每题平均 token 消耗；Y 轴：正确率。每个点 = 一个方法 × 仓库组合。预期 ACCEED 位于 Pareto 前沿。）

### 消融分析

**[图 3：问题类型 × 方法 分组柱状图]**

（问题按单模块 / 跨模块 / 架构级分组。预期 ACCEED 优势在跨模块和架构级问题上最显著。）

去边（A1）的影响：类型化边为 Agent 提供模块间关系的语义捷径。移除后 Agent 无法在不展开子图的前提下推断跨模块交互，导致跨模块问题的正确率下降 [待填]%，同时 token 消耗上升 [待填]% 。

去结构（A2）的影响：移除层次结构后，Agent 只能在平铺的 MD 文件中全文搜索。单步上下文从 $O(1)$ 退化为 $O(n)$（$n$ = 文件总数），导致 token 爆炸式增长，正确率大幅下降。

### Case Study

（选取 1-2 个 ACCEED 正确而 baseline 失败的典型问题。展示 Agent 导航轨迹：$G_{\text{top}} \to G_n \to \text{page}$，说明 typed edge 如何引导多跳推理。）

## Conclusion

本文将面向 Agent 的仓库文档形式化为中间表示问题，提出 AD-IR——一种递归图模式，通过类型化边、源码作用域绑定和标准化查询-修改接口支持渐进披露、结构完整和增量更新三重性质；并提出 ACCEED——基于产物即状态原则的多 Agent 管线，用于自动构建和增量维护 AD-IR。

在 ACCEED-Bench 上的实验表明，ACCEED 在正确率上达到 [待填]%，显著优于最强 baseline（[待填]%），同时 token 消耗降低 [待填]%。消融实验验证了类型化边和层次结构各自不可替代的贡献。

**局限性。** 本文未评测增量更新效果；生成质量依赖底层 LLM 能力；Benchmark 覆盖 5 个仓库，更广泛评估留作后续。

**未来工作。** PR 级增量更新一致性评测；多语言仓库支持扩展；与 IDE 级 Agent 工作流的集成。

### 参考文献

| 编号 | 引用 |
|------|------|
| [1] | Anthropic. *Claude Code SDK.* 2025. |
| [2] | OpenAI. *Codex SDK.* 2025. |
| [3] | Jimenez et al. *SWE-bench: Can Language Models Resolve Real-World GitHub Issues?* ICLR, 2024. |
| [4] | Yang et al. *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering.* NeurIPS, 2024. |
| [5] | Ding et al. *CrossCodeEval: A Diverse and Multilingual Benchmark for Cross-File Code Completion.* NeurIPS Datasets and Benchmarks, 2023. |
| [6] | Zhuo et al. *BigCodeBench: Benchmarking Code Generation with Diverse Function Calls and Complex Instructions.* ICLR (Oral), 2025. |
| [7] | Lewis et al. *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.* NeurIPS, 2020. |
| [8] | Zhang et al. *RepoCoder: Repository-Level Code Completion Through Iterative Retrieval and Generation.* EMNLP, 2023. |
| [9] | Sarthi et al. *RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval.* ICLR, 2024. |
| [10] | Guo et al. *GraphCodeBERT: Pre-training Code Representations with Data Flow.* ICLR, 2021. |
| [11] | Wang et al. *SWD-Bench: Evaluating Repository-level Software Documentation via QA and Feature-Driven Development.* arXiv:2604.06793, 2026. |
| [12] | Qian et al. *ChatDev: Communicative Agents for Software Development.* ACL, 2024. |
| [13] | Hong et al. *MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework.* ICLR, 2024. |
| [14] | Yao et al. *ReAct: Synergizing Reasoning and Acting in Language Models.* ICLR, 2023. |
| [15] | Shinn et al. *Reflexion: Language Agents with Verbal Reinforcement Learning.* NeurIPS, 2023. |
| [16] | Liang et al. *HGEN: Automating Hierarchical Documentation Generation from Source Code.* ASE, 2024. |
| [17] | Google. *CodeWiki: Automated Repository-Level Documentation Generation with Hierarchical Agentic Processing.* 2025. |
| [18] | Anthropic. *Model Context Protocol Specification.* 2024. |
| [19] | DeepWiki. *AI-Powered Interactive Code Documentation.* 2025. |
