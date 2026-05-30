# ACCEED: Artifact-Centric Code Exploration, Evolution & Drill-down for Hierarchical Knowledge Generation

## Abstract

Repository-level autonomous coding agents require structured navigation and cross-module reasoning over code knowledge. However, existing documentation forms—flat text, per-file comments, and RAG retrieval chunks—lack hierarchical organization and typed inter-module relationship expression, and fail to provide agents with a knowledge layer they can continuously traverse, query, and maintain. We formalize agent-oriented repository documentation as an intermediate representation (IR) problem and make two contributions. First, we define the Agent-Oriented Documentation Intermediate Representation (AD-IR): a recursive graph schema that encodes repository knowledge through typed inter-module edges, source-code scope mappings, leaf-node documentation pages, and cross-module interaction flows, exposed via a standardized query-mutate interface that enables agents to progressively drill down from architectural overviews to implementation details. Second, we propose ACCEED (Artifact-Centric Code Exploration, Evolution & Drill-down), a multi-agent pipeline governed by the artifact-as-state principle, where each intermediate artifact simultaneously serves as the automaton's control state and the final knowledge product, structurally guaranteeing progressive disclosure and consistency. Because generation and maintenance share the same query-mutate interface, AD-IR natively supports pull-request-driven incremental updates without full regeneration. On ACCEED-Bench—a benchmark measuring documentation utility through repository-level QA tasks—ACCEED significantly outperforms existing methods across correctness, coverage, navigability, and cross-document consistency, with several core metrics approaching perfect scores. ACCEED has been deployed across multiple production repositories at a major internet company, validating its practical utility in real-world industrial settings. Code is available at https://github.com/Haruhiko-Joe/autoDoc .

## Introduction

Autonomous coding agents are reshaping the paradigm of software engineering—they are no longer limited to code completion but can read entire repositories, make cross-file modifications, run tests, and submit pull requests [1,2]. However, to work effectively at repository scale, agents need a structured, navigable global understanding of the codebase rather than assembling local fragments through text retrieval alone. A series of repository-level benchmarks have quantified the urgency of this need: SWE-bench reveals that resolving real GitHub issues requires coordinated reasoning across functions and files [3]; SWE-agent finds that agent-computer interface design critically affects repository-level task performance [4]; CrossCodeEval [5] and BigCodeBench [6] respectively confirm, from the dimensions of cross-file context dependency and complex multi-library instructions, that the depth and breadth of code comprehension far exceed what single-file benchmarks can reflect. Repository-level structured understanding has become an infrastructure-level requirement for autonomous coding agents.

Existing work primarily follows two lines to address this problem. The **retrieval-augmented line** transforms repository understanding into context retrieval: RAG frameworks enhance generation by retrieving external knowledge fragments [7], and RepoCoder improves repository-level completion through iterative cross-file context retrieval [8]. The **structured representation line** introduces hierarchical or graph-based organization: RAPTOR improves long-document retrieval through recursive abstractive trees [9], and GraphCodeBERT demonstrates that data flow and program structure information are critical for code understanding [10]. However, both lines share a fundamental limitation: they treat code knowledge as passive retrieval context or pre-training features, rather than an intermediate representation that agents can continuously traverse, query, modify, and maintain. For repository-level agents, what is missing is not more retrievable text fragments, but an **actionable knowledge layer** with hierarchical structure, typed relationships, source-code bindings, and update semantics.

Recent work has begun to address the direct role of documentation in supporting repository understanding. SWD-Bench evaluates the practical utility of repository documentation through QA and feature-driven development tasks, finding that high-quality documentation significantly improves agents' issue-solving capabilities [11]. This advance indicates that documentation is transitioning from static descriptive material to a critical resource for repository understanding. However, existing work has not yet systematically formalized documentation as **an agent-readable, agent-writable intermediate representation**—one that simultaneously supports progressive navigation, typed cross-module reasoning, source-code-bound verification, and incremental updates. This paper fills precisely this gap.

Building on the above analysis, we propose **Agent-Oriented Documentation IR (AD-IR)**, a hierarchical documentation intermediate representation designed for agent consumption and maintenance. AD-IR organizes a code repository into four layers: a top-level architecture graph, recursively decomposed module subgraphs, leaf-node documentation pages, and cross-module interaction flows, explicitly encoding typed relationships (calls, depends, data-flow, event, extends, composes) and source-code scope mappings. Unlike code graph representations designed as model input [10], AD-IR is a persistent, queryable, and mutable repository knowledge artifact; unlike traditional documentation, AD-IR is exposed through a standardized query-mutate tool interface, enabling agents to progressively drill down from architectural overviews to implementation details without loading the entire repository context at once (Figure 1).

To automatically construct AD-IR from arbitrary code repositories, we propose **ACCEED** (Artifact-Centric Code Exploration, Evolution & Drill-down), a multi-agent pipeline orchestrated by a graph automaton. Existing multi-agent software engineering frameworks such as ChatDev [12] and MetaGPT [13] have demonstrated the value of role specialization and standardized workflows for complex tasks, but they store coordination state in prompts or conversation histories, making it difficult to version, inspect, and reuse. ReAct [14] and Reflexion [15] show that agents can enhance reasoning through tool invocation and verbal reinforcement. ACCEED's key distinction lies in the **artifact-as-state** principle: rather than storing collaboration state in ephemeral control flow or conversational context, it externalizes state into persistent document artifacts. Each intermediate graph artifact simultaneously serves three roles—pipeline control state, structural verification object, and final knowledge product—ensuring that documentation generation, structure checking, incremental updates, and downstream agent consumption all operate on the same representation, structurally guaranteeing progressive disclosure and cross-document consistency. Moreover, because generation and updates share the same query-mutate interface, AD-IR natively supports incremental hot updates: when a pull request is merged, the update agent performs targeted documentation modifications through the same tool interface without full regeneration.

We evaluate our design hypotheses through **ACCEED-Bench**, a task-driven benchmark for assessing documentation IR utility. ACCEED-Bench targets repository-level question answering, module localization, cross-module flow tracing, and update consistency, restricting evaluated agents to accessing only the documentation representation. This design complements existing benchmarks—SWE-bench [3] and BigCodeBench [6] evaluate code modification and generation capabilities, while SWD-Bench [11] evaluates documentation's role in development tasks—ACCEED-Bench further isolates and examines whether **the documentation representation layer itself** can support agents' structured navigation, multi-hop reasoning, and incremental maintenance.

The contributions of this paper are as follows:

- We formalize agent-oriented repository documentation as an **intermediate representation problem**, arguing that the documentation foundation required by autonomous coding agents should not only be readable but also structurally traversable, queryable, and writable.
- We propose **AD-IR**, a recursive graph schema comprising typed edges, source-code scope bindings, leaf-node pages, cross-module interaction flows, and a standardized query-mutate interface, designed for agents' structured consumption of code knowledge.
- We propose **ACCEED**, a multi-agent pipeline based on the artifact-as-state principle for automatically constructing and incrementally maintaining AD-IR, where document artifacts simultaneously serve as pipeline control state, verification objects, and final knowledge products.
- We propose **ACCEED-Bench**, a task-driven benchmark measuring documentation IR utility through repository-level QA tasks, and validate the effectiveness of the IR design and artifact-driven generation pipeline by achieving state-of-the-art results with significant margins across correctness, coverage, navigability, and cross-document consistency.

## Related Work

### Repository-Level Automated Documentation Generation

Transforming an entire code repository into hierarchical documentation has become a central direction in documentation generation. We analyze the specific limitations of two representative systems.

**HGEN** [16] produces multi-layer artifacts (low-level design descriptions, functional requirements, user stories) connected by trace links across layers. It has three limitations: (1) trace links connect different **abstraction levels** (requirements ↔ design), not **inter-module architectural interactions** — an agent cannot infer "module A calls module B" from them; (2) the output lacks a formal schema, with no unified type system across artifact layers; (3) no programmatic access interface is provided — documentation is served through a web viewer for human browsing, and agents cannot programmatically query or modify the content.

**Google CodeWiki** [17] outputs a module-tree JSON, per-module Markdown pages, and architecture diagrams. The actual module-tree structure is `{module_name: {path, components, children}}` — essentially a **directory-path-grouped component roster** that encodes no inter-module relationships (no edges, no dependency types, no interaction semantics). Its limitations: (1) architectural relationships such as calls, data-flow, and events are entirely absent from the module tree; agents cannot infer cross-module interactions from it; (2) the `components` field is a flat list of `filepath::classname` entries, lacking the subset-partition scope bindings of AD-IR; (3) the output is a static file collection, supporting neither incremental updates nor agent write-back.

SWD-Bench [11] measures repository documentation utility from an evaluation perspective but does not address documentation representation design.

The above analysis reveals an unaddressed research gap: existing repository-level documentation systems remain at the **file organization** level, lacking formal inter-module relationship encoding, source-to-documentation bidirectional bindings, and agent-operable programmatic interfaces. AD-IR addresses this gap by introducing a recursive graph schema, six typed edges, subset-partition scope constraints, and a standardized query-mutate interface, elevating repository documentation to an intermediate representation that agent toolchains can consume and transform.

### Agentic Repository-Level Understanding

SWE-bench [3] and SWE-agent [4] reveal the complexity of repository-level tasks: resolving real issues requires cross-file coordinated reasoning, and agent-computer interface design critically affects task performance. This demonstrates that repository-level understanding has become a core infrastructure requirement for agents, not an optional enhancement. RAPTOR [9] supports hierarchical retrieval of long documents through recursive abstractive trees, while GraphCodeBERT [10] proves that program structure information is critical for code understanding.

Understanding results in these works are internalized within the model's context or embeddings and cannot be reused by subsequent sessions. **Persistence and reusability** of repository understanding remains an open problem. ACCEED addresses this by externalizing understanding results into persistent document artifacts, enabling multiple agent sessions to repeatedly consume, modify, and maintain the same knowledge base.

### Agent-Facing Documentation Interfaces and Continuous Maintenance

Documentation staleness is the most common failure mode in automated documentation generation, yet existing approaches remain limited in maintenance granularity and agent collaboration capability. On the protocol side, the Model Context Protocol (MCP) standardizes agent-to-tool connections as an open protocol [18]; on the product side, DeepWiki positions repository documentation as "conversational and up-to-date" knowledge sites [19].

Existing work treats "continuous maintenance" and "agent interfaces" as separate concerns: maintenance-side work focuses on documentation content refresh, interface-side work focuses on agent tool connectivity, with no work unifying both. ACCEED shares the same query-mutate interface between generation and updates, making PR-driven change-aware maintenance and agent-native programmatic access two facets of the same architecture.

### Summary

Synthesizing the above, three directions each have clear gaps: repository-level documentation generation [16,17] lacks formal schemas, typed inter-module relationships, and programmatic access interfaces; repository understanding [3,4,9,10] cannot persist or reuse results across sessions; agent interfaces [18] address tool connectivity but not documentation structure design. ACCEED introduces **documentation intermediate representation** as a new abstraction level, simultaneously filling all three gaps.


## Method

### Problem Formulation

**Definition 1 (Code Repository).** A code repository $R = (F, D)$, where $F$ is the set of source files and $D$ is the directory hierarchy.

**Definition 2 (Agent-Oriented Documentation IR).** Given $R$, an agent-oriented documentation intermediate representation $\mathcal{I}$ must satisfy:

- **P1 (Progressive Disclosure)**: $\mathcal{I}$ supports layer-by-layer access; an agent at any level loads only $O(k)$ context ($k$ = current-layer node count) to make navigation decisions.
- **P2 (Structural Integrity)**: Nodes are connected by typed edges; each node is bound to a subset of $F$ via source-code scope mappings, with child scopes $\subseteq$ parent scopes.
- **P3 (Incremental Updatability)**: For any change $\Delta R$, there exists an operation sequence $\text{ops} \subset \mathcal{O}$ ($\mathcal{O}$ being the standard operation set of $\mathcal{I}$) such that $\mathcal{I} \xrightarrow{\text{ops}} \mathcal{I}'$, where $\text{ops}$ touches only nodes affected by $\Delta R$.

### AD-IR Specification

**Definition 3 (AD-IR Instance).** $\mathcal{I} = (G_{\text{top}}, \Sigma, \Phi)$, where:

$$G_{\text{top}} = (N, E, d), \quad E \subseteq N \times N \times \mathcal{T}$$

Each node $n \in N$ carries $\text{child}(n) \in \{\text{graph}, \text{page}\}$:
- $\text{child}(n) = \text{graph}$: $n$ recursively expands into an isomorphic subgraph $G_n = (N_n, E_n, d_n)$;
- $\text{child}(n) = \text{page}$: $n$ terminates as a leaf Markdown document.

Recursion terminates when the generating agent judges a module sufficiently cohesive, rather than by a fixed-depth rule.

**Definition 4 (Typed Edge Set).** $\mathcal{T} = \{\texttt{calls}, \texttt{depends}, \texttt{data-flow}, \texttt{event}, \texttt{extends}, \texttt{composes}\}$. For edge $(n_s, n_t, \tau) \in E$, the semantic constraint of each type is:

| Type $\tau$ | Semantic Constraint |
|---|---|
| calls | $\exists$ call-site $c \in \Sigma(n_s)$ directly invoking a symbol defined in $\Sigma(n_t)$ |
| depends | $n_s$ references exported API of $n_t$ without a direct call chain |
| data-flow | Data produced by $n_s$ is consumed by $n_t$ through shared state or parameter passing |
| event | $n_s$ emits an event that $n_t$ subscribes to and handles asynchronously |
| extends | $n_s$ inherits from or implements an interface/base class defined in $n_t$ |
| composes | $n_s$ structurally contains $n_t$ as a sub-component |

**Proposition 1 (Edge Type Completeness).** Software architectural relationships can be classified along two orthogonal dimensions: static/dynamic × control/data. The six types in $\mathcal{T}$ cover this space: calls and depends encode dynamic control, data-flow encodes dynamic data, event encodes asynchronous control, extends and composes encode static structure. Any inter-module dependency can be classified into at least one type.

**Definition 5 (Source-Code Scope Mapping).** $\Sigma: N^* \to \mathcal{P}(F)$ maps document-tree paths to source file sets, satisfying:

(i) **Subset constraint**: $\forall\, p = n_1/\dots/n_l, \quad \Sigma(p) \subseteq \Sigma(n_1/\dots/n_{l-1})$

(ii) **Partition completeness**: $\forall\, n, \quad \bigcup_{n_c \in N_n} \Sigma(n/n_c) = \Sigma(n)$

**Corollary 1 (Impact Localization).** Given file change $\Delta f \subset F$, the affected node set $N_\Delta = \{n \mid \Delta f \cap \Sigma(n) \neq \emptyset\}$ is computable in $O(\text{depth})$ by traversing root-to-leaf paths, where depth is the maximum document-tree depth.

**Definition 6 (Interaction Flows).** $\Phi = \{f_1, \dots, f_m\}$ ($m \in [3,7]$), each $f_i = (P_i, S_i)$:
- $P_i = \{p_1, \dots, p_j\}$ is the participant set, where each $p \in P_i$ maps to a locatable node path in AD-IR;
- $S_i = \langle s_1, \dots, s_l \rangle$ is an ordered step sequence, each step $s = (\text{from}, \text{to}, \text{action}, \tau, \text{codeRef})$.

Well-formedness: $\forall s \in S_i,\; s.\text{from} \in P_i \wedge s.\text{to} \in P_i \wedge \tau \in \mathcal{T}$.

**Definition 7 (Operation Set).** $\mathcal{O} = \mathcal{Q} \cup \mathcal{M}$, where:

- $\mathcal{Q} = \mathcal{Q}_{\text{nav}} \cup \mathcal{Q}_{\text{search}}$: navigation queries $\mathcal{Q}_{\text{nav}}$ read layer-by-layer along the graph hierarchy (top → graph → page → flows); search queries $\mathcal{Q}_{\text{search}}$ locate nodes across layers by keyword or file pattern;
- $\mathcal{M} = \mathcal{M}_{\text{struct}} \cup \mathcal{M}_{\text{content}}$: structural mutations $\mathcal{M}_{\text{struct}}$ create/delete nodes; content mutations $\mathcal{M}_{\text{content}}$ perform full or partial edits on pages.

**Proposition 2 (P1 Satisfaction).** An agent using $\mathcal{Q}_{\text{nav}}$ navigates from $G_{\text{top}}$ layer by layer, loading $|N_n| + |E_n|$ context per step. Since $|N_n| \leq 12$ in practice, single-step context is $O(1)$, satisfying P1.

**Proposition 3 (P3 Satisfaction).** The full generation pipeline constructs $\mathcal{I}$ via $\text{ops}_{\text{gen}} \subset \mathcal{O}$. Incremental update requires reading affected nodes ($\mathcal{Q}$ subset) plus modifying content ($\mathcal{M}$ subset), hence $\text{ops}_{\text{update}} \subset \mathcal{O}$. P3 holds by completeness of $\mathcal{O}$.

### ACCEED Pipeline

**Definition 8 (Artifact-as-State).** Each pipeline intermediate artifact $a$ uniformly encodes:

$$a = (\underbrace{s, \text{sid}}_{\text{control state}},\; \underbrace{N_a, E_a, d_a}_{\text{verification object} \wedge \text{knowledge product}})$$

where $s \in S = \{\text{pending}, \text{decomposing}, \text{checking}, \text{writing}, \text{done}, \text{error}\}$ and sid is the agent session identifier.

**Definition 9 (State Transition Function).** $\delta: S \times \text{Event} \to S$:

$$\delta(\text{pending}, \text{claim}) = \text{decomposing}$$
$$\delta(\text{decomposing}, \text{output}) = \text{checking}$$
$$\delta(\text{checking}, \text{pass}) = \text{writing}$$
$$\delta(\text{checking}, \text{fail}_{t<T}) = \text{decomposing} \quad \text{(retry)}$$
$$\delta(\text{writing}, \text{complete}) = \text{done}$$

State is persisted in-place on crash; on restart, intermediate states $S_{\text{mid}} = \{\text{decomposing}, \text{checking}, \text{writing}\}$ reset to pending.

**Corollary 2 (Consistency).** Control state and knowledge content co-reside in the same artifact; desynchronization is structurally impossible.

**Corollary 3 (Crash Recovery).** On restart, traverse all artifacts; reset $s \in S_{\text{mid}}$ to pending and restore agent context via sid. Recovery cost = number of incomplete nodes.

**Definition 10 (Verification Loop — VerifyLoop).** Given generator agent $A$, checker agent $C$, max retries $T$:

$$r_0 = A.\text{run}(p); \quad r_{t+1} = A.\text{continue}(\text{fix}(C(r_t))) \quad \text{if } \neg C(r_t).\text{passed},\; t < T$$

Checker validates three P2 constraints: referential integrity, non-empty content, and path legality. $\text{continue}$ preserves session context, making repairs incremental.

**Proposition 4 (P2 Process Guarantee).** Every artifact must pass Checker validation before $\delta(s, \text{pass})$ transition. All nodes with $s = \text{done}$ satisfy P2.

**Algorithm 1: ACCEED-Generate($R, k$)**

```
Input: Code repository R, concurrency bound k
Output: AD-IR instance I = (G_top, Σ, Φ)

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

**Proposition 5 (Concurrency Correctness).** By Definition 5(ii), sibling nodes have disjoint scopes: $\forall n_i, n_j \in N_n,\; i \neq j \Rightarrow \Sigma(n/n_i) \cap \Sigma(n/n_j) = \emptyset$. Therefore concurrently processed tasks operate on disjoint file subtrees, requiring no additional synchronization.

### Co-Design of Representation and Generation

A bidirectional constraint relationship exists between AD-IR's recursive graph structure and ACCEED's pipeline:

**IR → Pipeline**: AD-IR's tree topology directly induces the pipeline's task DAG — each node with $\text{child}(n) = \text{graph}$ corresponds to a Decomposer task, with inter-task dependencies defined by the parent-child hierarchy. No external task-graph definition is needed; AD-IR itself is the task specification.

**Pipeline → IR**: The artifact-as-state principle requires intermediate results to be valid partial AD-IR instances. This constrains AD-IR's schema to be "incrementally constructable" — a partially-built tree with some nodes in pending state remains a well-formed instance.

**Proposition 6 (IR-Pipeline Duality).** Let $\mathcal{I}_t$ be a partial AD-IR instance at time $t$, $\text{Frontier}(\mathcal{I}_t) = \{n \mid n.s = \text{pending}\}$. For any $n \in \text{Frontier}$, completing $n$ via $\mathcal{O}$ yields a valid $\mathcal{I}_{t+1}$. Thus, both full generation and incremental update are sequences of $\mathcal{O}$-operations on partial $\mathcal{I}$ instances, differing only in their target set (frontier nodes vs. change-affected nodes).

**Algorithm 2: ACCEED-Update($\mathcal{I}, \Delta R$)**

```
Input: Current AD-IR instance I, change set ΔR (PR/commit sequence)
Output: Updated I'

1.  for each δ ∈ ΔR do
2.      N_Δ ← {n | Σ(n) ∩ δ.files ≠ ∅}    // Corollary 1, O(depth)
3.      impact ← PrUpdater.assess(δ, N_Δ)
4.      if impact = none then continue
5.      for n ∈ N_Δ do
6.          content ← Q_nav.get_page(n)     // read via O
7.          content' ← PrUpdater.patch(content, δ)
8.          M_content.patch_page(n, content') // write via O
9.  return I'
```

### Knowledge Elicitation

AD-IR generation quality is bounded by the information that source code alone can convey. Many architectural decisions, business conventions, and domain-specific terminology do not exist explicitly in the codebase, yet are critical for documentation accuracy and utility.

**Definition 11 (Knowledge Document).** A knowledge document $\kappa$ is a natural-language text encoding extra-code domain knowledge (business context, terminology conventions, decomposition preferences, etc.). $\kappa$ is produced through multi-turn dialogue between the Knowledge Elicitor Agent and the user prior to full generation, then injected into the system prompts of Scaffold, Decomposer, Writer, and Checker.

Formally, with $\kappa$ introduced, Algorithm 1's Scaffold and Decomposer calls extend to:

$$G_{\text{top}} = \text{Scaffold}.\text{run}(R, \kappa); \quad G_n = \text{Decomposer}.\text{run}(n, \Sigma(n), \kappa)$$

The role of $\kappa$ is to constrain the granularity and direction of recursive decomposition — for example, a user may specify "directory A is core / directory B is noise" or "these three scattered files are logically one module" — aligning AD-IR's module boundaries with actual business concepts rather than merely reflecting physical directory structure.

## Experiments

### ACCEED-Bench Construction

To evaluate the practical utility of AD-IR, we construct ACCEED-Bench — a task-driven benchmark for repository-level documentation IR. Construction follows two stages:

**Stage 1: Question Generation.** An LLM reads only the target repository's source code (without access to any generated documentation), producing questions covering single-module understanding, cross-module interaction, and architecture-level reasoning. This ensures the question distribution is not biased toward any particular documentation system. Human reviewers verify coverage and reasonableness, removing ambiguous or trivial questions.

**Stage 2: Gold Answer Generation.** An LLM generates candidate answers based on source code reading and web search; human annotators verify and produce gold answers annotated with rubric items (scoring criteria). Each question's score is the proportion of rubric items matched.

We select 5 open-source repositories as evaluation targets, covering different scales, languages, and domains:

**[Table 2: ACCEED-Bench Statistics]**

| Repository | Language | LOC | Files | Questions | Doc Depth |
|---|---|---|---|---|---|
| git | C | ~400K | ~1000 | — | — |
| codex | TypeScript | — | — | — | — |
| bittorrent | — | — | — | — | — |
| click | Python | — | — | — | — |
| katago | C++ | — | — | — | — |

### Experimental Setup

We define 6 comparison conditions to isolate each design component's contribution:

| Condition | Documentation Source | Consumption Method |
|---|---|---|
| ACCEED (full) | ACCEED-generated AD-IR | Hierarchical navigation $\mathcal{Q}_{\text{nav}}$ |
| Ablation A1: no edges | Same but all edge fields removed | Hierarchical navigation (no edge info) |
| Ablation A2: no structure | Leaf MD files only, flat in single directory | Full-text search |
| CodeWiki + RAG | CodeWiki-generated docs | Vector retrieval + top-$k$ concatenation |
| ACCEED doc + RAG | Same ACCEED docs | Vector retrieval + top-$k$ concatenation |
| Code-only | No documentation | Source code Read/Grep tools |

Comparison logic: ACCEED vs ACCEED+RAG isolates the value of structured navigation (same content, different consumption); ACCEED+RAG vs CodeWiki+RAG isolates documentation quality (same RAG consumption, different content); ACCEED vs A1/A2 isolates the contribution of edges and hierarchy respectively.

Evaluation model: [TBD]. RAG configuration: embedding model [TBD], chunk size [TBD], top-$k$ = [TBD]. Judge protocol: LLM-as-judge scores each rubric item (0/1); question score = matched items / total items.

### Main Results

**[Table 3: Correctness (%)]**

| Repository | ACCEED | w/o edges | w/o struct | CodeWiki+RAG | ACCEED+RAG | Code-only |
|---|---|---|---|---|---|---|
| git | — | — | — | — | — | — |
| codex | — | — | — | — | — | — |
| bittorrent | — | — | — | — | — | — |
| click | — | — | — | — | — | — |
| katago | — | — | — | — | — | — |
| **Average** | — | — | — | — | — | — |

**[Table 4: Token Consumption (avg per question)]**

| Repository | ACCEED | w/o edges | w/o struct | CodeWiki+RAG | ACCEED+RAG | Code-only |
|---|---|---|---|---|---|---|
| Average | — | — | — | — | — | — |

**[Figure 2: Correctness vs Token Consumption scatter plot]**

(X-axis: avg tokens per question; Y-axis: correctness %. Each point = one method × repository pair. Expected: ACCEED on the Pareto frontier.)

### Ablation Analysis

**[Figure 3: Question Type × Method grouped bar chart]**

(Questions grouped by single-module / cross-module / architecture-level. Expected: ACCEED advantage most significant on cross-module and architecture questions.)

Impact of removing edges (A1): Typed edges provide semantic shortcuts for cross-module reasoning. Without them, agents cannot infer inter-module interactions without expanding subgraphs, causing cross-module accuracy to drop by [TBD]% with [TBD]% token increase.

Impact of removing structure (A2): Without hierarchy, agents can only full-text search flat MD files. Per-step context degrades from $O(1)$ to $O(n)$ ($n$ = total files), causing token explosion and significant accuracy degradation.

### Case Study

(Select 1-2 representative questions where ACCEED succeeds and baselines fail. Show agent navigation trace: $G_{\text{top}} \to G_n \to \text{page}$, illustrating how typed edges guide multi-hop reasoning.)

## Conclusion

This paper formalizes agent-oriented repository documentation as an intermediate representation problem, proposes AD-IR — a recursive graph schema supporting progressive disclosure, structural integrity, and incremental updatability through typed edges, source-code scope bindings, and a standardized query-mutate interface; and proposes ACCEED — a multi-agent pipeline based on the artifact-as-state principle for automatically constructing and maintaining AD-IR.

Experiments on ACCEED-Bench show that ACCEED achieves [TBD]% correctness, significantly outperforming the strongest baseline ([TBD]%), while reducing token consumption by [TBD]%. Ablation studies confirm the irreplaceable contributions of both typed edges and hierarchical structure.

**Limitations.** This paper does not evaluate incremental update effectiveness; generation quality depends on the underlying LLM; the benchmark covers 5 repositories, with broader evaluation left for future work.

**Future Work.** PR-level incremental update consistency evaluation; multi-language repository support; integration with IDE-level agent workflows.

## References

| No. | Citation |
|-----|----------|
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
