# bench/ — QA Benchmark

评估 ACCEED 生成文档质量的测试工具。纯源码生成高难度 QA 对（含采分点），再用仅文档工具回答，对比 gold answer 判分。

## 快速开始

```bash
# 1. 启动后端（项目根目录）
pnpm dev

# 2. 启动 benchmark 前端（端口 8009）
cd bench && pnpm dev
```

打开 http://localhost:8009 即可通过 UI 操作。

## Phase 1：生成 QA 对

### 通过 UI

访问 http://localhost:8009/generate，选择项目、配置参数，点击 Start Generation。

### 通过 CLI

```bash
# 从项目根目录执行
pnpm exec tsx bench/scripts/generate-qa.ts --project git --count 10 --providers claude
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--project` | `git` | 项目名（对应 `src/souko/repo/{project}`） |
| `--repo` | `src/souko/repo/git` | 源码仓库路径 |
| `--out-dir` | `bench/data` | 输出目录 |
| `--language` | `zh` | 问答语言（zh / en） |
| `--count` | `20` | 生成 QA 对数量 |
| `--batch-size` | `1` | 每轮结构化输出的 QA 数量 |
| `--providers` | `codex,claude` | 生成用的 provider |
| `--claude-model` | `claude-opus-4-6[1m]` | Claude 模型 |
| `--codex-model` | SDK 默认 | Codex 模型 |

输出路径：`bench/data/{project}/{runId}/qa.generated.json`

### 生成机制

- 单 session 内通过 `continue` 保持上下文连续性，避免重复问题
- Claude 使用 `resume` 续接 session，Codex 复用同一 thread
- 每个 batch 完成后立即写入部分结果，中断不丢失已生成内容

### QA 对结构

每个 QA 对包含：

- **question**：跨模块、真实场景的复杂问题
- **goldAnswer**：基于架构理解的标准答案（不含行号和代码片段）
- **scoringPoints**：采分点列表，每个包含 `point`（可验证的原子事实）和 `weight`（权重）
- **category**：问题分类（architecture / data-flow / lifecycle 等）
- **requiredConcepts**：涉及的关键概念
- **sourceEvidence**：源码证据（验证元数据，不参与评分）

### 采分点设计原则

采分点必须是**从文档可验证的事实**，而非源码实现细节：
- 模块职责和架构关系
- 数据流步骤和转换逻辑
- 行为后果和边界情况
- 错误处理策略和状态转换

## Phase 2：Validation（TODO）

基于生成的 QA 对，让模型仅通过文档工具（doc-drill）回答问题，再用 judge 对比 gold answer 和采分点打分。

## 生成消融文档

为结构消融实验生成文档变体（完整、去边、扁平 MD）：

```bash
# 从项目根目录执行
pnpm exec tsx bench/scripts/generate-ablation-docs.ts [options]
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--project` | `git` | 项目名（对应 `src/souko/doc/{project}`） |
| `--doc-root` | `src/souko/doc` | ACCEED 文档根目录 |
| `--out-root` | `bench/data/ablation-docs` | 输出目录 |
| `--variants` | `full,no-edges,flat-md` | 逗号分隔的变体列表 |
| `--overwrite` | 关闭 | 覆盖已有输出 |

输出结构示例：

```
bench/data/ablation-docs/
├── full/{project}/ ...
├── no-edges/{project}/ ...
└── flat-md/{project}/ ...
```

## 目录结构

```
bench/
├── README.md
├── package.json
├── vite.config.ts
├── index.html
├── scripts/
│   ├── generate-qa.ts          # QA 生成脚本
│   └── generate-ablation-docs.ts  # 生成消融文档变体
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── router.ts
│   ├── style.css
│   ├── services/
│   │   └── api.ts              # 后端 API 客户端
│   └── views/
│       ├── RunListPage.vue     # 历史 run 列表
│       ├── RunDetailPage.vue   # QA 对详情
│       └── GeneratePage.vue    # 生成配置
└── data/                       # 生成输出（gitignored）
    └── {project}/{runId}/
        └── qa.generated.json
```

## 后端 API

benchmark 相关的 API 挂载在主后端服务器（`:3100`）上：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/bench/runs` | GET | 列出所有 run（可 `?project=` 过滤） |
| `/api/bench/runs/:project/:runId` | GET | 获取单个 run 的完整数据 |
| `/api/bench/generate` | POST | 触发 QA 生成 |
| `/api/bench/generate/status` | GET | 查询生成进度和日志 |
