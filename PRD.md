# autoDoc PRD

## 目标

给定任意项目的代码仓库（规模上限百万行），自动生成一个独立部署的 Vue + TypeScript 文档站。文档采用渐进式披露，新人看完即可上手。

## 核心理念

**标准**：看完文档就能上手。

**渐进式披露**：用户从全局到局部，逐层深入理解项目。图层级为动态深度的递归结构（非固定层数），每个节点可继续展开为子图或终止为 Markdown 文档页。图为可交互的有向图，仅允许单向边，允许重边（A→B 和 B→A 视为两条独立边），节点间可同时存在多种类型的边。decomposer 根据代码复杂度自行决定拆分深度，避免过度拆解或粒度过粗。

## 文档站结构（动态深度）

### 根图 — 系统模块关系图

- **呈现形式**：全屏模块关系图，仅允许单向边，允许重边
- **节点数量**：若干个，动态调整。代表系统的核心模块，比如前端，后端的各个服务，以数据库进行通信的微服务架构为例，会有：前端，调度，worker，数据库等，不同的项目会有不同的顶层模块
- **节点内容**：模块名称 + 一段描述（约100字）
- **边**：模块间的关系与数据流（见边类型定义），仅单向边，A→B 与 B→A 为两条独立边
- **交互**：点击节点 → 进入子图或 Markdown 页（由节点的 child 类型决定）

### 根图 — 项目说明

- **相关的背景**： 介绍项目背景，用途的文档，帮助新人更好上手，用Apple新品宣传的风格介绍整个项目的背景和用途

### 子图（任意深度）

- **呈现形式**：有向图，仅允许单向边，允许重边
- **节点**：当前模块内部的子单元（组件、服务、中间件、数据模型、路由等）
- **节点内容**：子单元名称 + 职责描述
- **边**：子单元间关系，仅单向边，允许重边（如 A→B calls + A→B depends 为两条边，A→B + B→A 也为两条边）
- **交互**：点击节点 → 进入更深层子图或 Markdown 页（由节点的 child 类型决定）
- **深度**：decomposer 根据代码复杂度决定是否继续拆分，无固定层数限制

### 叶子节点 — 文档页

- **呈现形式**：Markdown 渲染页
- **粒度**：每个叶子节点对应一份 Markdown 文档，不必要拆到单个函数
- **内容**：
  - 子单元概述与职责
  - 关键流程 walkthrough（调用链、数据流向）
  - 函数签名与参数说明
  - 接口/类型定义
  - 配置项与默认值
  - 边界 case 与注意事项
  - 关键代码片段（带行号引用）

---

## 边类型定义

图中的边需要区分不同语义关系，采用不同的视觉样式（颜色/线型）：

| 边类型 | 语义 | 视觉样式 |
|--------|------|---------|
| `calls` | A 调用 B | 实线箭头 |
| `depends` | A 依赖 B（import / 配置依赖） | 虚线箭头 |
| `data-flow` | A 的输出是 B 的输入 | 粗实线箭头 |
| `event` | A 触发事件，B 监听 | 点线箭头 |
| `extends` | A 继承/实现 B | 空心三角箭头 |
| `composes` | A 包含/组合 B | 菱形箭头 |

所有层级均为有向图，仅允许单向边，允许重边（同一对节点间可有多条不同类型的边，A→B 与 B→A 为两条独立边）。所有边类型在任意深度均可使用，decomposer 根据实际语义选择合适的边类型。

---

## Agent 流程

四个 Agent：scaffold 负责顶层特化拆解，decomposer 负责递归展开，checker 负责每轮校验，writer 负责为叶子节点生成 Markdown 文档。前端为预先编写的 Vue + TS 应用，直接读取生成的 JSON/Markdown 渲染，无需构建步骤。

```
scaffold（顶层特化拆解，生成根图 top.json）
    ↓
┌──────────────────────────────────────┐
│  decomposer + writer + checker 循环   │
│                                      │
│  decomposer：                        │
│    对所有 child.type="graph"          │
│    的节点并行展开，生成子图 JSON        │
│           ↓                          │
│  writer：                            │
│    为叶子节点（child.type="page"）     │
│    生成 Markdown 文档                 │
│           ↓                          │
│  checker：                           │
│    校验子图 JSON 的路径合法性           │
│    + 校验 Markdown 文档的内容质量       │
│           ↓                          │
│    不通过 → 反馈给 decomposer          │
│    通过且仍有待展开节点 → 继续          │
│    通过且全部为叶子 → 结束              │
└──────────────────────────────────────┘
    ↓
完成（前端直接读取 doc/ 下的文件渲染）
```

### 4 个 Agent

#### 1. Scaffold — 顶层拆解

**职责**：分析目标仓库的全局结构，生成根图 `doc/top.json`。这是一个特化的 Agent，专门处理顶层分解——需要从全局视角理解整个项目的架构，决定顶层模块的划分。

**工作方式**：
- 输入目标仓库根路径
- 读取目录结构、入口文件、package.json、路由配置、CI 配置等高层信息
- 输出根图 `doc/top.json`，每个节点附带 codeScope 供后续 decomposer 使用

**与 decomposer 的区别**：
- scaffold 面向整个仓库，需要全局视角决定模块边界
- decomposer 面向单个 codeScope，在已确定的边界内做子单元拆解

**结构化输出**：

```typescript
interface edge {
  type: "calls" | "depends" | "data-flow" | "event" | "extends" | "composes"
  target: string
  discription: string
}

interface node {
  name: string
  discription: string
  scope: string[]
  edges: edge[]
}

// 与 Graph 结构一致，但顶层节点的 child 全部为 { type: "graph" }
interface rawTopGraph {
  discription: string
  nodes: node[] // 子模块名称 需要一一对应
}
```

最终和储存为

```typescript
interface topGraph {
  status: "done"    // scaffold 产出后直接为 done
  retryCount: 0
  sessionId: string // 用户点击前端的按钮，触发弹窗，可以查看这个任务的完整日志并进行追问，该字段由AGENT SDK返回的sessionid进行填充
  discription: string
  nodes: node[] // 子模块名称 需要一一对应
}
```

#### 2. Decomposer — 递归展开

**职责**：接收 scaffold 或上一轮 decomposer 产出的待展开节点，递归生成子图（JSON）。每次调用分析一个 codeScope，输出该 scope 的图，并为每个节点决定是继续展开（child.type = "graph"）还是终止为文档页（child.type = "page"）。叶子节点的 Markdown 文档由 Writer 单独生成。

**工作方式**：
- 输入某节点的 codeScope，输出子图 `doc/{nodeId}/{nodeName}.json`
- 叶子节点标记为 child.type = "page"，Checker 通过后由 Writer 生成对应的 `doc/{nodeId}/{ref}.md`
- **终止条件**：当 decomposer 判断某节点的代码复杂度足够低（可用一份 Markdown 文档描述清楚），标记为叶子节点（child.type = "page"），不再继续展开

**harness策略**：
- 每次调用只读取 codeScope 指定范围内的代码，不需要全量读取
- 每次 decomposer 调用的 scope 控制在合理范围内

**结构化输出**：

```typescript
interface GraphEdge {
  target: string
  type: "calls" | "depends" | "data-flow" | "event" | "extends" | "composes"
  description: string
}

interface GraphNode {
  name: string
  description: string
  edges: GraphEdge[]
  codeScope: string[]
  child:
    | { type: "graph"; ref: string }   // 非叶子：ref 指向 doc/{nodeId}/{ref}/{ref}.json
    | { type: "page"; ref: string }    // 叶子：ref 指向 doc/{nodeId}/{ref}.md
}

interface rawGraph { // AGENT 返回的数据结构
  nodes: GraphNode[]
}

interface Graph {
  status: "pending" | "decomposing" | "checking" | "done" | "error"
  retryCount: number
  sessionId: string // 用户点击前端的按钮，触发弹窗，可以查看这个任务的完整日志并进行追问，该字段由AGENT SDK返回的sessionid进行填充
  discription: string // 继承自上一级的图
  nodes: GraphNode[] // 子模块名称 需要一一对应
}
```

#### 3. Checker — 产物校验

**职责**：校验每轮 decomposer 产出的子图 JSON 是否合法且质量达标。

**校验维度**：

**路径合法性**：
- 所有 `child.ref` 命名合法（不含空格和特殊字符），格式正确
- 所有 `edges[].target` 引用的节点名必须存在于同一张图中
- 节点名称无冲突
- 所有 `codeScope` 中的路径在目标仓库中实际存在

**内容质量**：
- 图节点的 description 非空且有意义
- 边的 description 非空
- 不存在只有 1 个子节点的子图（无意义的拆分层）

**结构化输出**：

```typescript
interface CheckerOutput {
  passed: boolean
  issues: CheckerIssue[]
}

interface CheckerIssue {
  files: string[]                      // 与问题相关的目标仓库源码文件路径（相对于仓库根目录）
  type: "missing-ref" | "broken-target" | "empty-content" | "missing-section" | "invalid-path"
  description: string
  severity: "error" | "warning"
}
```

**反馈循环**：
- checker 不通过 → 将 issues 反馈给 decomposer → decomposer 修复 → 再次 checker
- 最大重试次数可配置（默认 3 次）

#### 4. Writer — 叶子文档生成

**职责**：为 Decomposer 标记为 child.type = "page" 的叶子节点生成详细的 Markdown 文档。在 Checker 校验通过后由 Arranger 调度调用。

**工作方式**：
- 输入叶子节点的 name、description、codeScope 和仓库根路径
- 深入阅读 codeScope 范围内的代码
- 输出结构完整的 Markdown 文档，写入 `doc/{parentNodeId}/{ref}.md`

**结构化输出**：

```typescript
interface WriterOutput {
  content: string  // 完整的 Markdown 文档内容
}
```

**文档必要章节**：
- 概述与职责
- 关键流程 walkthrough（调用链、数据流向）
- 函数签名与参数说明
- 接口/类型定义
- 配置项与默认值
- 边界 case 与注意事项
- 关键代码片段（带行号引用）

---

## 技术架构

### 核心依赖
- **TypeScript** — 项目语言
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — Agent 运行时
- **Zod** — 结构化输出的 schema 定义与验证

### Arranger 调度流程

```
                    ┌──────────────────┐
                    │    scaffold      │  ← 顶层特化拆解，生成 top.json
                    └────────┬─────────┘
                             │
                ┌────────────┼────────────┐
                ▼            ▼            ▼
          ┌──────────┐ ┌──────────┐ ┌──────────┐
          │decomp(A) │ │decomp(B) │ │decomp(C) │  ← 并行展开
          └────┬─────┘ └────┬─────┘ └────┬─────┘
               │            │            │
               ▼            ▼            ▼
          ┌──────────┐                ┌──────────┐
          │checker(A)│   (B 为叶子)   │checker(C)│  ← 校验本轮产物
          └────┬─────┘  │             └────┬─────┘
            pass        │writer(B)      pass
               │        │                 │
               ▼        ▼                 ▼
          ┌──────────┐                ┌──────────┐
          │decomp    │  B.md          │writer(C) │  ← writer 生成叶子 md
          │(A.1,A.2) │                └──────────┘
          └────┬─────┘
               │
               ▼
          ┌──────────┐
          │ checker  │  ← 校验
          └────┬─────┘
            pass，全部为叶子
               │
               ▼
              完成
```

### 状态管理（任务自带状态）

不维护全局 WorkflowState。每个图文件（JSON）自带状态字段，arranger 通过扫描 `doc/` 目录下所有文件的状态来决定下一步动作。

**图文件的状态字段**：

```typescript
interface Graph {
  status: "pending" | "decomposing" | "checking" | "done" | "error"
  retryCount: number                // checker 失败重试次数
  sessionId: string                 // agent session ID
  description: string
  nodes: GraphNode[]
}
```

- `top.json` 初始由 scaffold 生成，状态直接为 `"done"`
- scaffold 生成的每个子节点（child.type = "graph"）对应的 `doc/{nodeId}/{nodeName}.json` 初始状态为 `"pending"`
- decomposer 领取 `"pending"` 的文件，标记为 `"decomposing"`，完成后标记为 `"checking"`
- checker 领取 `"checking"` 的文件，通过则标记为 `"done"`，不通过则回退为 `"pending"`（retryCount++）
- retryCount 达到上限时标记为 `"error"`

**叶子节点无需状态**：`doc/{parentNodeId}/{ref}.md` 是纯 Markdown，由 Writer 在 Checker 通过后生成，不参与状态流转。

arranger 逻辑简化为：当一个AGENT跑完任务的时候进行调度，比如decomposer第一次跑完之后应该调用checker，checker跑完之后根据结果看要不要接着调decomposer或者开启下一层

无需中央状态文件，任务状态随产物本身持久化，天然支持断点续跑（进程重启后扫描目录即可恢复）。