# 诊断调试与用量追踪命令集（DiagnosticsCommands）

## 概述与职责

DiagnosticsCommands 是 Claude Code **命令系统（CommandSystem）** 下的一组斜杠命令，面向开发者和内部维护人员，提供会话费用查看、API 用量追踪、运行状态诊断、环境校验、性能分析、内存转储等能力。它位于 `CoreEngine → CommandSystem` 层级中，与同级的会话管理命令、Git 操作命令、配置修改命令等并列。

该命令集包含 **9 个活跃命令** 和 **9 个已禁用的桩命令**：

| 命令 | 类型 | 用途 | 可见性 |
|------|------|------|--------|
| `/cost` | local | 会话费用汇总 | 订阅用户隐藏 |
| `/usage` | local-jsx | 计划用量限额 | Claude AI 用户可见 |
| `/extra-usage` | local-jsx + local | 超额用量配置 | 按权限条件显示 |
| `/stats` | local-jsx | 使用统计与活动 | 所有用户 |
| `/insights` | prompt | 会话分析报告（~3200行） | 所有用户 |
| `/status` | local-jsx | 运行状态面板 | 所有用户 |
| `/doctor` | local-jsx | 环境诊断校验 | 可通过环境变量禁用 |
| `/heapdump` | local | 内存转储 | 隐藏命令 |
| `/version` | local | 版本信息 | 仅 ANT 用户 |
| `/mock-limits` 等 9 个 | stub | 已禁用 | 隐藏 |

## 关键流程

### 架构模式

所有命令遵循统一的懒加载注册模式：`index.ts` 导出元数据（名称、描述、可见性条件），通过 `load: () => import('./impl.js')` 延迟加载实现模块。命令分为三类执行方式：

- **`local`**：同步文本返回（cost、heapdump、version）
- **`local-jsx`**：渲染 React/Ink 组件的交互式 UI（usage、stats、status、doctor）
- **`prompt`**：收集数据后发送给 Claude 模型生成叙述性报告（insights）

### `/cost` — 会话费用查看

1. 调用 `isClaudeAISubscriber()` 判断用户类型
2. 若为订阅用户，检查 `currentLimits.isUsingOverage` 是否处于超额计费模式
3. 订阅用户且未超额：显示"费用已包含在订阅中"
4. ANT 用户或超额用户：调用 `formatTotalCost()` 输出按模型分类的 token 用量和美元费用

> 源码位置：`src/commands/cost/cost.ts:1-34`

### `/extra-usage` — 超额用量配置

这是最复杂的诊断命令，具有双重实现（交互式 JSX + 非交互式文本），核心逻辑在 `extra-usage-core.ts`：

1. 调用 `invalidateOverageCreditGrantCache()` 确保数据新鲜
2. 通过 `getSubscriptionType()` 判断订阅类型（个人 / 团队 / 企业）
3. **团队/企业用户（无账单权限）**：
   - 获取用量利用率 (`fetchUtilization`)
   - 检查管理员请求资格 (`checkAdminRequestEligibility`)
   - 查询已有请求状态 (`getMyAdminRequests`)
   - 如有资格则创建管理员请求，否则返回提示信息
4. **个人用户或有账单权限**：直接打开浏览器跳转 `claude.ai` 设置页

> 源码位置：`src/commands/extra-usage/extra-usage-core.ts:1-115`

### `/insights` — 会话分析报告（核心大命令）

这是整个命令集中最庞大的实现（约 3200 行），采用多阶段流水线架构：

**阶段 1 — Lite Scan**：仅扫描文件系统元数据（文件大小、修改时间），不解析 JSONL 内容

**阶段 2 — 加载 SessionMeta**：优先从缓存读取，否则解析会话文件。每个 `SessionMeta` 包含：
- 消息数、token 用量、工具调用统计
- Git 统计（提交数、推送数、行变更）
- 响应时间、会话时长
- 最多处理 200 个会话

**阶段 3 — Facet 提取**：对最多 50 个实质性会话调用 Claude Opus 模型提取结构化洞察：
- 会话目标、结果、满意度、摩擦点等

**阶段 4 — 聚合**：汇总所有会话的统计数据，包括工具使用排行、编程语言分布、目标分类、结果分布、满意度评级等

**阶段 5 — HTML 报告生成**：生成包含柱状图、直方图、饼图的可分享 HTML 报告

**阶段 6（仅 ANT）**：上传至 S3，失败时回退到本地文件

关键特性包括：
- **Multi-clauding 检测**：识别多个 Claude 实例的重叠时间窗口
- **会话去重**：同一 `session_id` 保留用户消息最多的分支
- **增量缓存**：`SessionMeta` 和 `SessionFacets` 本地缓存，避免重复处理
- **远程收集（ANT 专属）**：通过 `--homespaces` 参数从多个远程主机收集会话数据

> 源码位置：`src/commands/insights.ts`

### `/heapdump` — 内存转储

调用 `performHeapDump()` 服务，成功时返回堆转储文件路径和诊断文件路径（输出到 `~/Desktop`），失败时返回错误信息。这是一个隐藏命令，主要供内部调试使用。

> 源码位置：`src/commands/heapdump/heapdump.ts:1-20`

### `/version` — 版本信息

读取编译时宏 `MACRO.VERSION` 和 `MACRO.BUILD_TIME`，返回格式化的版本字符串。仅 ANT 用户可见。

> 源码位置：`src/commands/version.ts:1-25`

## 函数签名与参数说明

### `cost.call(onDone, context)`

- **context.abortController**：中止信号
- **返回**：`{ type: 'text', value: string }` — 费用摘要文本

### `runExtraUsage()`

- **返回**：`Promise<{ type: 'message', message: string } | { type: 'browser-opened' }>` — 消息结果或浏览器已打开标记

### `generateUsageReport(options?)`

- **options.homespaces**：`string[]`（可选）远程主机列表
- **返回**：`Promise<{ insights: InsightResults, htmlPath: string, aggregatedData: AggregatedData }>`

### `buildExportData(data, insights, facets)`

构建可导出的 JSON 结构，包含聚合数据、洞察和分面信息。

### `deduplicateSessionBranches(logs)`

去重同一会话 ID 的多个分支，保留用户消息数最多的版本。

### `detectMultiClauding(timestamps)`

检测并发会话使用模式，返回重叠时间窗口信息。

## 接口/类型定义

### `SessionMeta`（insights.ts 核心类型）

会话级元数据，包含：消息计数、token 统计、工具调用计数与错误分类、Git 统计（提交/推送/行变更）、响应时间、会话时长等。

### `SessionFacets`（insights.ts）

由 Claude Opus 模型提取的会话洞察：目标分类（`goal`）、结果评估（`outcome`）、满意度（`satisfaction`）、摩擦点（`friction`）等。

### `AggregatedData`（insights.ts）

跨会话聚合统计，涵盖：工具使用排行、编程语言分布、项目分布、目标分类、结果分布、满意度评级、摩擦类型频率、成功因素等。

### `InsightResults`（insights.ts）

叙述性洞察报告结构：`at_a_glance`（概览）、`whats_working`（有效做法）、`whats_hindering`（阻碍因素）、`quick_wins`（快速改善建议）、`ambitious_workflows`（高级工作流建议）。

## 配置项与默认值

| 配置/环境变量 | 作用 | 默认值 |
|---------------|------|--------|
| `USER_TYPE` | 用户类型标识 | — |
| `DISABLE_DOCTOR_COMMAND` | 禁用 `/doctor` 命令 | 未设置（启用） |
| `DISABLE_EXTRA_USAGE_COMMAND` | 禁用 `/extra-usage` 命令 | 未设置（启用） |
| insights 最大会话数 | SessionMeta 处理上限 | 200 |
| insights 实质性会话上限 | Facet 提取上限 | 50 |

## 边界 Case 与注意事项

1. **订阅用户的费用隐藏**：`/cost` 对 Claude AI 订阅用户（非超额状态）隐藏，因为费用已包含在订阅中。但 ANT 用户始终可见。

2. **`/extra-usage` 的双重实现**：交互式会话使用 JSX 版本（可渲染 Login 组件刷新 API Key），非交互式会话使用纯文本版本。两者共享同一核心逻辑。

3. **`/insights` 的性能考量**：作为 ~3200 行的懒加载模块，`insights` 仅在用户调用时加载。它会对最多 200 个会话进行文件扫描，对最多 50 个会话调用 Claude Opus 进行 facet 提取——这是一个耗时较长的操作。

4. **9 个桩命令**：`/mock-limits`、`/reset-limits`、`/ant-trace`、`/perf-issue`、`/debug-tool-call`、`/ctx_viz`、`/backfill-sessions`、`/break-cache`、`/oauth-refresh` 均导出 `{ isEnabled: () => false, isHidden: true, name: 'stub' }`，当前处于禁用状态，代码在 `.js` 文件中（非 TypeScript）。

5. **`/heapdump` 的安全性**：作为隐藏命令，它会将堆转储写入 `~/Desktop`，包含进程内存快照，可能含敏感数据。

6. **`/status` 的 immediate 标志**：设置了 `immediate: true`，意味着该命令无需等待消息上下文即可立即执行，适合快速状态检查。

## 关键代码片段

### 命令懒加载注册模式

所有命令的 `index.ts` 遵循统一模式：

```typescript
// src/commands/cost/index.ts 示例
export default {
  type: "local",
  name: "cost",
  description: "Show the total cost and duration of the current session",
  isHidden: () => isClaudeAISubscriber() && USER_TYPE !== "ant",
  supportsNonInteractive: true,
  load: () => import("./cost.js"),
} satisfies Command;
```

### insights 的多阶段流水线入口

```typescript
// src/commands/insights.ts — generateUsageReport 主函数骨架
export async function generateUsageReport(options?) {
  // Phase 1: Lite scan (filesystem metadata only)
  // Phase 2: Load SessionMeta (from cache or parse)
  // Phase 3: Extract facets (Claude Opus, max 50 sessions)
  // Phase 4: Aggregate statistics
  // Phase 5: Generate HTML report
  // Phase 6 (ANT only): Upload to S3
}
```