# 会话费用与 Token 用量追踪（CostTracking）

## 概述与职责

CostTracking 模块是 Claude Code 的**费用与资源用量追踪系统**，属于 CoreEngine 的一部分。它负责三个核心职责：

1. **实时累计**：每次 API 调用后，按模型维度累计输入/输出/缓存 token 数量和 USD 费用
2. **格式化展示**：在会话结束时，输出终端友好的费用摘要（总费用、耗时、代码变更量、各模型用量明细）
3. **持久化与恢复**：将费用状态写入项目配置文件，支持恢复中断的会话时继续累计

模块由两个文件组成：
- **`src/cost-tracker.ts`**：核心追踪逻辑和持久化，是费用系统的主体
- **`src/costHook.ts`**：React hook，在进程退出时自动输出费用摘要并持久化

在系统架构中，CostTracking 被 CoreEngine 的查询引擎在每次 API 响应后调用以累计费用，同时被 TerminalUI 通过 `useCostSummary` hook 在会话结束时触发输出。

## 关键流程

### 1. API 调用费用累计流程

每次收到 Claude API 的响应后，系统调用 `addToTotalSessionCost()` 进行费用累计：

1. 调用 `addToTotalModelUsage()` 将本次 usage（input/output/cache read/cache write/web search tokens）累加到对应模型的 `ModelUsage` 记录中（`src/cost-tracker.ts:250-276`）
2. 同时更新模型的 `contextWindow` 和 `maxOutputTokens` 元信息
3. 调用 `addToTotalCostState()` 将费用写入全局 STATE（`src/bootstrap/state.ts:557-564`）
4. 通过 OpenTelemetry counter（`getCostCounter()`、`getTokenCounter()`）上报可观测性指标，按模型和 token 类型分别计数
5. **递归处理 Advisor 用量**：如果本次响应包含 advisor tool 的嵌套 usage，递归调用自身累计 advisor 的费用，并通过 `logEvent` 记录分析事件（`src/cost-tracker.ts:304-321`）

```
addToTotalSessionCost(cost, usage, model)
  ├── addToTotalModelUsage(cost, usage, model)  // 按模型累计 token
  ├── addToTotalCostState(cost, modelUsage, model)  // 写入全局 STATE
  ├── getCostCounter()?.add(cost, attrs)  // OTel 费用指标
  ├── getTokenCounter()?.add(...)  // OTel token 指标（4 种类型）
  └── for each advisorUsage:  // 递归处理嵌套的 advisor 调用
        ├── calculateUSDCost(advisorModel, advisorUsage)
        ├── logEvent('tengu_advisor_tool_token_usage', ...)
        └── addToTotalSessionCost(advisorCost, advisorUsage, advisorModel)  // 递归
```

Fast Mode 支持：当启用 fast mode 且响应的 `usage.speed === 'fast'` 时，OTel 指标会额外携带 `speed: 'fast'` 属性（`src/cost-tracker.ts:287-289`）。

### 2. 费用持久化与恢复流程

**保存**（`saveCurrentSessionCosts`，`src/cost-tracker.ts:143-175`）：
1. 将当前所有费用状态（费用、耗时、代码变更、各模型 token 用量）写入项目配置
2. 同时保存当前 `sessionId` 作为恢复校验依据
3. 可选接收 `FpsMetrics` 参数，一并保存 FPS 性能指标

**恢复**（`restoreCostStateForSession`，`src/cost-tracker.ts:130-137`）：
1. 从项目配置读取上次保存的费用数据
2. **校验 sessionId 是否匹配**——只有同一会话的费用才会被恢复，防止跨会话费用混淆
3. 恢复时会重新计算每个模型的 `contextWindow` 和 `maxOutputTokens`（因为这些值可能随配置变化）
4. 调用 `setCostStateForRestore()` 将数据写回全局 STATE

### 3. 进程退出时的费用输出流程

`useCostSummary` hook（`src/costHook.ts:6-22`）在 React 组件挂载时注册 `process.on('exit')` 监听器：

1. 检查 `hasConsoleBillingAccess()`——只有具有控制台账单访问权限的用户才会看到费用摘要
2. 调用 `formatTotalCost()` 格式化并输出到 stdout
3. 调用 `saveCurrentSessionCosts()` 持久化当前费用状态
4. 组件卸载时自动清理监听器（`process.off('exit', f)`）

## 函数签名与参数说明

### `addToTotalSessionCost(cost: number, usage: Usage, model: string): number`

核心累计函数。每次 API 调用后调用，累计费用和 token 用量。

- **cost**：本次调用的 USD 费用
- **usage**：Anthropic SDK 的 `BetaUsage` 对象，包含 `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`、`server_tool_use.web_search_requests` 等字段
- **model**：模型标识符（如 `claude-opus-4-6`）
- **返回值**：本次调用的**总费用**（包含递归累计的 advisor 费用）

> 源码位置：`src/cost-tracker.ts:278-323`

### `formatTotalCost(): string`

格式化当前会话的完整费用摘要，返回 chalk dim 样式的字符串。包含总费用、API 耗时、墙钟耗时、代码变更行数、各模型的详细 token 用量。

> 源码位置：`src/cost-tracker.ts:228-244`

### `saveCurrentSessionCosts(fpsMetrics?: FpsMetrics): void`

将当前会话费用状态持久化到项目配置文件。

- **fpsMetrics**（可选）：FPS 性能指标，一并保存

> 源码位置：`src/cost-tracker.ts:143-175`

### `restoreCostStateForSession(sessionId: string): boolean`

从项目配置恢复指定会话的费用状态。

- **sessionId**：要恢复的会话 ID
- **返回值**：`true` 表示成功恢复，`false` 表示 sessionId 不匹配或无数据

> 源码位置：`src/cost-tracker.ts:130-137`

### `getStoredSessionCosts(sessionId: string): StoredCostState | undefined`

读取项目配置中存储的费用数据（不写入全局 STATE）。仅当 sessionId 匹配时返回数据。

> 源码位置：`src/cost-tracker.ts:87-123`

### `useCostSummary(getFpsMetrics?: () => FpsMetrics | undefined): void`

React hook。在进程退出时输出费用摘要并持久化。

- **getFpsMetrics**（可选）：获取 FPS 指标的回调函数

> 源码位置：`src/costHook.ts:6-22`

## 类型定义

### `StoredCostState`

持久化费用状态的内部类型（`src/cost-tracker.ts:71-80`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| totalCostUSD | `number` | 累计 USD 费用 |
| totalAPIDuration | `number` | API 调用总耗时 |
| totalAPIDurationWithoutRetries | `number` | 不含重试的 API 耗时 |
| totalToolDuration | `number` | 工具执行总耗时 |
| totalLinesAdded | `number` | 新增代码行数 |
| totalLinesRemoved | `number` | 删除代码行数 |
| lastDuration | `number \| undefined` | 上次会话总时长 |
| modelUsage | `{ [modelName: string]: ModelUsage } \| undefined` | 各模型的详细用量 |

### `ModelUsage`（来自 `agentSdkTypes`）

按模型维度的用量记录，包含 `inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheCreationInputTokens`、`webSearchRequests`、`costUSD`、`contextWindow`、`maxOutputTokens` 字段。

## 格式化逻辑

### 费用格式化（`formatCost`）

- 费用 > $0.50 时，四舍五入到**分**（2 位小数），如 `$1.23`
- 费用 ≤ $0.50 时，保留**4 位小数**，如 `$0.0042`

> 源码位置：`src/cost-tracker.ts:177-179`

### 模型用量格式化（`formatModelUsage`）

将不同模型 ID 通过 `getCanonicalName()` 映射为短名称后合并统计，输出格式如：

```
Usage by model:
       opus-4-6:  1.2K input, 800 output, 5K cache read, 200 cache write ($0.15)
     sonnet-4-6:  500 input, 300 output, 2K cache read, 100 cache write ($0.03)
```

模型名称右对齐到 21 字符宽度。仅当 web search 请求数 > 0 时才显示该项。

> 源码位置：`src/cost-tracker.ts:181-226`

## 导出的状态访问器

`cost-tracker.ts` 从 `bootstrap/state.ts` 重新导出了一系列全局状态读取函数：

- `getTotalCost`（即 `getTotalCostUSD`）、`getTotalDuration`、`getTotalAPIDuration`
- `getTotalInputTokens`、`getTotalOutputTokens`、`getTotalCacheReadInputTokens`、`getTotalCacheCreationInputTokens`
- `getTotalWebSearchRequests`、`getTotalLinesAdded`、`getTotalLinesRemoved`
- `getModelUsage`、`getUsageForModel`、`hasUnknownModelCost`
- `resetCostState`、`resetStateForTests`、`setHasUnknownModelCost`

这使得其他模块只需从 `cost-tracker` 导入即可获取所有费用相关的状态。

## 边界 Case 与注意事项

- **未知模型费用**：当使用未在价格表中注册的模型时，`hasUnknownModelCost()` 返回 `true`，`formatTotalCost()` 会在费用后追加警告文字 `"(costs may be inaccurate due to usage of unknown models)"`
- **跨会话恢复保护**：`restoreCostStateForSession` 严格校验 sessionId，避免将其他会话的费用误计入当前会话
- **Advisor 递归累计**：`addToTotalSessionCost` 会递归处理嵌套的 advisor tool usage，确保 advisor 模型的费用也被正确追踪和上报
- **权限门控输出**：费用摘要仅在 `hasConsoleBillingAccess()` 返回 `true` 时才输出到终端，非付费用户不会看到
- **持久化始终执行**：即使不输出费用摘要，`saveCurrentSessionCosts()` 仍然会在进程退出时执行，确保费用数据不丢失