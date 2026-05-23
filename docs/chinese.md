# GraphMaton: Artifact-Driven Multi-Agent Automaton for Hierarchical Knowledge Generation

## Abstract

仓库级自主编程Agent需要对代码知识进行结构化导航与跨模块推理，然而现有文档形态——扁平文本、逐文件注释、RAG 检索片段——既缺乏层次化组织，也无法表达模块间的类型化依赖关系，无法为Agent提供可持续遍历、查询与维护的知识底座。本文将面向Agent的仓库文档形式化为一个中间表示（IR）问题，并在此基础上做出两方面贡献。其一，我们定义 Agent-Oriented Documentation Intermediate Representation（AD-IR）：一种递归图模式，以类型化模块间边、源码作用域映射、叶节点文档页和跨模块交互流编码仓库知识，并通过标准化查询-修改接口使Agent可从架构概览逐层下钻至实现细节。其二，我们提出 GraphMaton：一个基于产物即状态（artifact-as-state）原则的多Agent管线，每个中间工件同时充当自动机控制状态与最终知识产物，从结构上保证渐进披露与一致性；由于生成与更新共享同一查询-修改接口，AD-IR 天然支持 pull request 驱动的增量更新，无需全量重新生成。在 AutoDoc-Bench——一个以仓库级 QA 任务衡量文档实用性的基准——上，GraphMaton 在正确性、覆盖率、可导航性和跨文档一致性上均显著优于现有方法，多项核心指标接近满分。该系统已在一家大型互联网企业的多个生产仓库中部署，验证了其在真实工业场景下的实用性。

## Introduction

自主编程Agent正在重塑软件工程的工作范式——它们不再局限于代码补全，而是能够读取整个仓库、跨文件修改、运行测试并发起 pull request [1,2]。然而，要在仓库尺度上有效工作，Agent需要对代码库形成结构化、可导航的全局理解，而非仅靠文本检索拼凑局部片段。一系列仓库级基准量化了这一需求的迫切性：SWE-bench 揭示真实 GitHub issue 的解决需要跨函数、跨文件的协调推理 [3]，SWE-agent 发现 agent-computer interface 的设计对仓库级任务表现有关键影响 [4]，CrossCodeEval [5] 与 BigCodeBench [6] 则分别从跨文件上下文依赖和复杂多库指令两个维度证实，代码理解的深度和广度远超单文件基准所能反映。仓库级结构化理解已成为自主编程Agent的基础设施级需求。

现有工作主要沿两条路线缓解这一问题。**检索增强路线**将仓库理解转化为上下文检索：RAG 框架通过检索外部知识片段增强生成 [7]，RepoCoder 通过迭代检索跨文件上下文改善仓库级补全 [8]。**结构化表示路线**引入层次化或图结构组织：RAPTOR 通过递归摘要树改善长文档检索 [9]，GraphCodeBERT 表明数据流与程序结构信息对代码理解至关重要 [10]。然而，这两条路线共享一个根本局限：它们将代码知识视为被动的检索上下文或预训练特征，而非Agent可以持续遍历、查询、修改和维护的一等中间表示。对于仓库级Agent而言，缺失的不是更多可检索的文本片段，而是一个具有层次结构、类型化关系、源码绑定和更新语义的**可操作知识层**。

近期工作已开始关注文档对仓库理解的直接支撑作用。SWD-Bench 通过 QA 和 feature-driven development 任务评估仓库文档的实际效用，发现高质量文档能显著提升Agent的 issue-solving 能力 [11]；RepoDoc 利用知识图谱生成并增量维护仓库文档 [12]。这些进展表明文档正从静态说明材料转变为仓库理解的关键资源。然而，已有工作尚未将文档系统性地形式化为一种**一等的、Agent可读可写的中间表示**——使其同时支持渐进式导航、类型化跨模块推理、源码绑定验证和增量更新。本文正是填补这一空缺。

基于上述分析，我们提出 **Agent-Oriented Documentation IR（AD-IR）**，一种面向Agent消费和维护的层次化文档中间表示。AD-IR 将代码仓库组织为顶层架构图、递归分解的模块子图、叶节点文档页和跨模块交互流四个层次，显式编码类型化关系（calls、depends、data-flow、event、extends、composes）和源码作用域映射。与面向模型输入的代码图表示 [10] 不同，AD-IR 是持久化、可查询、可修改的仓库知识工件；与传统文档不同，AD-IR 通过标准化的查询-修改工具接口暴露，使Agent能够从架构概览逐步下钻到实现细节，而无需一次性加载整个仓库上下文（图 1）。

为从任意代码仓库自动构建 AD-IR，我们提出 **GraphMaton**，一个由图自动机编排的多Agent管线。已有多Agent软件工程框架如 ChatDev [13] 和 MetaGPT [14] 已展示角色分工与标准化流程对复杂任务的价值，但它们将协调状态保存于 prompt 或对话历史中，难以版本化、检查和复用；ReAct [15] 和 Reflexion [16] 表明Agent可通过工具调用与反馈记忆增强推理能力。GraphMaton 的关键区别在于**产物即状态（artifact-as-state）**原则：不将协作状态保存在临时控制流或对话上下文中，而将其外化为持久化文档工件。每个中间图工件同时承担三重角色——管线控制状态、结构验证对象和最终知识产物——使文档生成、结构检查、增量更新和下游Agent消费都作用于同一表示，从结构上保证渐进披露与跨文档一致性。此外，由于生成与更新共享同一查询-修改接口，AD-IR 天然支持增量热更新：当 pull request 合并时，更新Agent通过相同的工具接口完成文档的定向修改，无需全量重新生成。

我们通过 **AutoDoc-Bench** 评测上述设计假设。AutoDoc-Bench 是一个面向文档 IR 实用性的任务驱动基准：以仓库级问答、模块定位、跨模块流程追踪和更新一致性为评测目标，限制被测Agent仅访问文档表示。该设计与现有基准形成互补——SWE-bench [3] 和 BigCodeBench [6] 评估代码修改与生成能力，SWD-Bench [11] 评估文档对开发任务的帮助——AutoDoc-Bench 进一步隔离并检验**文档表示层本身**能否支持Agent的结构化导航、多跳推理和增量维护。

本文的贡献如下：

- 我们将面向Agent的仓库文档形式化为一个**中间表示问题**，论证自主编程Agent所需的文档底座不仅应可阅读，还应可结构化遍历、可查询、可写入。
- 我们提出 **AD-IR**，一种包含类型化边、源码作用域绑定、叶节点页面、跨模块交互流和标准化查询-修改接口的递归图模式，面向Agent对代码知识的结构化消费而设计。
- 我们提出 **GraphMaton**，一个基于产物即状态原则的多Agent管线，用于自动构建并增量维护 AD-IR，其中文档工件同时充当管线控制状态、验证对象和最终知识产物。
- 我们提出 **AutoDoc-Bench**，一个以仓库级 QA 任务衡量文档 IR 实用性的任务驱动基准，并通过在正确性、覆盖率、可导航性和跨文档一致性上取得的显著最优结果，验证了 IR 设计与产物驱动生成管线的有效性。

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
| [12] | Xu et al. *RepoDoc: Knowledge Graph-Based Framework to Automatic Documentation Generation and Incremental Updates.* arXiv, 2026. |
| [13] | Qian et al. *ChatDev: Communicative Agents for Software Development.* ACL, 2024. |
| [14] | Hong et al. *MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework.* ICLR, 2024. |
| [15] | Yao et al. *ReAct: Synergizing Reasoning and Acting in Language Models.* ICLR, 2023. |
| [16] | Shinn et al. *Reflexion: Language Agents with Verbal Reinforcement Learning.* NeurIPS, 2023. |
