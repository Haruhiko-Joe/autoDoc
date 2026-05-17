# scripts/ — QA Benchmark 流水线

评估 autoDoc 生成文档质量的两阶段流水线：先基于源码生成问答对，再测试仅用文档工具能否回答这些问题。

## 流水线概览

```
generate-qa.ts          run-qa-benchmark.ts
┌─────────────┐         ┌──────────────────┐
│ 阅读源码+文档 │         │ 仅用 doc-drill   │
│ → 生成 QA 对 │  ───►   │ 回答问题（禁止   │
│              │  .json  │ 访问源码）        │
└─────────────┘         └──────────────────┘
```

**第一步** 让 Claude/Codex 阅读源码仓库和 autoDoc 文档树，生成有源码依据的问答对。
**第二步** 让 Claude/Codex 在沙箱环境中仅使用文档浏览工具 (`browse.mjs`) 回答这些问题，以此衡量文档的信息覆盖度。

## 第一步：生成 QA 对

```bash
pnpm exec tsx scripts/generate-qa.ts [options]
```

每个 QA 对包含：问题、标准答案、源码证据（文件 + 行号提示）、文档导航提示。

| 选项 | 默认值 | 说明 |
|---|---|---|
| `--project <name>` | `git` | 文档根目录下的项目名 |
| `--repo <path>` | `src/souko/repo/git` | 目标源码仓库路径 |
| `--doc-root <path>` | `src/souko/doc` | autoDoc 文档根目录 |
| `--out-dir <path>` | `benchmarks/qa` | 输出根目录 |
| `--language <zh\|en>` | `zh` | QA 语言 |
| `--count <number>` | `20` | 每个 provider 生成的 QA 数量 |
| `--batch-size <number>` | `2` | 每轮结构化输出的 QA 数量 |
| `--providers <list>` | `codex,claude` | 逗号分隔的 provider 列表 |
| `--run-id <id>` | 自动生成（时间戳） | 覆盖输出的 run id |
| `--codex-model <model>` | SDK 默认值 | Codex 模型覆盖 |
| `--claude-model <model>` | `claude-opus-4-7[1m]` | Claude 模型 |

输出路径：`benchmarks/qa/{project}/{runId}/qa.generated.json`

每个 batch 完成后会立即写入部分结果，中断后不会丢失已生成的内容。

## 第二步：运行 Benchmark

```bash
pnpm exec tsx scripts/run-qa-benchmark.ts [options]
```

读取生成的 QA JSON，在隔离的 workspace 中让每个 provider 仅通过 doc-drill 回答问题。脚本会验证回答过程是否合规（足够的浏览次数、未访问源码）。

| 选项 | 默认值 | 说明 |
|---|---|---|
| `--input <path>` | 自动查找最新的 | `qa.generated.json` 路径 |
| `--project <name>` | `git` | 项目名 |
| `--doc-root <path>` | `src/souko/doc` | autoDoc 文档根目录 |
| `--out-dir <path>` | `benchmarks/qa` | 输出根目录 |
| `--answer-providers <list>` | `codex,claude` | 回答问题的 provider |
| `--limit <number>` | 全部 | 限制问题数量（用于冒烟测试） |
| `--question-id <id>` | 全部 | 只运行指定的问题 |
| `--repo <path>` | `src/souko/repo/git` | 源码仓库路径（仅用于违规检测） |
| `--min-doc-drill-calls <number>` | `2` | 每个回答最少的浏览调用次数 |
| `--codex-model <model>` | SDK 默认值 | Codex 模型覆盖 |
| `--claude-model <model>` | `claude-opus-4-7[1m]` | Claude 模型 |

输出路径：`benchmarks/qa/{project}/{runId}/qa.benchmark.json`（与输入文件同目录）

### 合规验证规则

Benchmark 强制执行"仅文档访问"约束：

- **Claude**：只允许 `Bash`（用于执行 `node browse.mjs`）和 `Read` 工具；写工具（`Edit`、`Write`）直接拒绝
- **Codex**：只允许 `command_execution`、`agent_message`、`reasoning`、`todo_list` 类型的 item
- 所有 bash 命令必须是 doc-drill 调用，不允许任意 shell 命令
- 引用源码仓库路径的命令会被拒绝
- 每个回答至少需要调用 `--min-doc-drill-calls` 次浏览工具

## 目录结构

```
scripts/
├── README.md                              # 本文件
├── generate-qa.ts                         # 第一步：QA 生成
├── run-qa-benchmark.ts                    # 第二步：仅文档回答
├── lib/
│   └── cli-utils.ts                       # 共享 CLI 工具函数
└── templates/
    └── qa-benchmark-skill/
        ├── SKILL.md                       # doc-drill skill 定义
        └── scripts/
            └── browse.mjs                 # 文档浏览工具
```

## 环境要求

两个脚本都需要：
- 已完成的 autoDoc 文档树，即 `{doc-root}/{project}/top.json` 必须存在

## 使用示例

```bash
# 用 Claude 生成 10 个 QA 对
pnpm exec tsx scripts/generate-qa.ts --count 10 --providers claude

# 对最新生成的 QA 文件运行 benchmark
pnpm exec tsx scripts/run-qa-benchmark.ts --answer-providers claude

# 冒烟测试：只跑一个问题
pnpm exec tsx scripts/run-qa-benchmark.ts --question-id claude-01
```
