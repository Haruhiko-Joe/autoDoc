# plan
- 调研已有 benchmark / metric
- 定义 autoDoc 专属评测协议
- 选择被测项目与 baseline
- 跑主实验
- 做消融实验 + 分析

# benchmark / metric

## 仓库级软件文档 SWD-Bench
通过功能驱动的 QA 任务来评估仓库级软件文档质量

这是目前我认为和 autodoc 最贴近的一类。

SWD-Bench 是 2026 年提出的 repository-level software documentation benchmark，目标不是单纯判断文档“写得像不像”，而是看生成的文档能否帮助模型理解并完成仓库功能。它设计了三类 QA 任务：Functionality Detection、Functionality Localization、Functionality Completion，并包含 4,170 条样本。

| 任务                             | 测什么             | 例子                 |
| ------------------------------ | --------------- | ------------------ |
| **Functionality Detection**    | 文档是否说明了某个功能是否存在 | “这个仓库是否支持 X 功能？”   |
| **Functionality Localization** | 文档能否帮助定位相关文件/模块 | “实现 X 功能的文件在哪里？”   |
| **Functionality Completion**   | 文档是否包含足够实现细节    | “如何调用/修改/扩展 X 功能？” |


## 文档 groundedness / factuality  eg. FACTS Grounding


用来评估 LLM 是否能基于给定 source material 生成事实准确、充分详细的回答,更偏长文档问答 factuality
在此，我认为不太适合autodoc，不详细展开

---

## CodeXGLUE

CodeXGLUE 是微软提出的代码智能 benchmark，包含 10 类任务、14 个数据集，覆盖 code-code、text-code、code-text 和 text-text 场景，其中 code-text 包含代码摘要，text-text 包含文档翻译等任务。

它和“文档站”不是完全同一层级，但可以用于评估 autoDoc 的底层能力，比如函数级、类级、文件级说明是否准确。

常用指标包括：

| 指标       | 作用                    |
| -------- | --------------------- |
| BLEU     | 生成文本和参考文档的 n-gram 重合度 |
| ROUGE    | 召回式摘要质量               |
| METEOR   | 词级匹配与同义变体             |
| CodeBLEU | 更偏代码语义的生成评估           |

---

## 信息检索 / 文档搜索指标

常见指标包括 Recall@K、Precision@K、MRR、MAP、NDCG@K。检索阶段通常关注 Recall、Accuracy；排序阶段更关注 MAP、MRR、NDCG，因为它们考虑结果位置。

| 指标          | 测什么               | 适合场景       |
| ----------- | ----------------- | ---------- |
| Recall@K    | 正确页面是否出现在前 K 个结果里 | 文档站搜索召回    |
| Precision@K | 前 K 个结果有多少是相关的    | 搜索结果质量     |
| MRR         | 第一个正确结果排得多靠前      | 用户能否快速找到答案 |
| NDCG@K      | 高相关结果是否排在前面       | 多相关页面排序    |
| MAP         | 多个查询下整体平均排序质量     | 搜索系统综合评估   |

---

## 文档站 Web 质量 benchmark / 工具

### Lighthouse

Lighthouse 可以对网页进行自动审计，覆盖性能、可访问性、渐进式 Web App、SEO 等方面。它可以通过 Chrome DevTools、命令行、Node 模块或 PageSpeed Insights 运行。([Chrome for Developers][5])

对文档站来说，Lighthouse 可以测：

| 维度             | 例子                          |
| -------------- | --------------------------- |
| Performance    | 页面加载速度、资源体积                 |
| Accessibility  | 标题层级、颜色对比、键盘可访问性            |
| SEO            | title、meta description、可索引性 |
| Best Practices | 安全、资源加载、浏览器兼容性              |
