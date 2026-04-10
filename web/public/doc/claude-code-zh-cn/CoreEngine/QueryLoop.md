# QueryLoop — 单轮查询主循环

## 概述与职责

QueryLoop 是 Claude Code **CoreEngine** 的核心状态机，实现了一个完整的"模型调用 → 工具执行 → 再次调用"的 agentic 循环。它是入口层（CLI/SDK/MCP）与底层服务（API 通信、工具系统、压缩服务）之间的编排枢纽。

在整体架构中，QueryLoop 位于 **CoreEngine** 模块内，被 Entrypoints 层初始化后调用。它向下依赖 Services 层（API 调用、消息压缩）和 ToolSystem（工具执行），向上通过 AsyncGenerator 将流式事件推送给 TerminalUI 渲染。

模块由 5 个文件组成：
- `src/query.ts` — 主循环实现（`query()` 和 `queryLoop()` 函数）
- `src/query/config.ts` — 不可变查询配置快照 `QueryConfig`
- `src/query/deps.ts` — I/O 依赖注入 `QueryDeps`
- `src/query/stopHooks.ts` — 轮次结束时的 stop hooks 执行
- `src/query/tokenBudget.ts` — Token 预算管理与自动续写决策

---

## 关键流程

### 主循环概览

`query()` 是公开入口，内部委托给 `queryLoop()`。`queryLoop()` 是一个 `while(true)` 无限循环，每次迭代代表一个"模型调用 + 工具执行"轮次。循环通过修改 `State` 对象并 `continue` 来进入下一轮迭代，通过 `return { reason: ... }` 退出。

整个循环的核心数据流：

```
消息准备 → 预处理（snip/microcompact/collapse/autocompact）
         → 流式调用模型 → 解析响应
         → 执行工具（可流式并行）→ 收集结果
         → 附件注入 → 判断是否继续 → 下一轮迭代
```

### 1. 消息规范化与预处理

每轮迭代开始时，对消息历史进行多级预处理（`src/query.ts:365-447`）：

1. **工具结果预算裁剪**：`applyToolResultBudget()` 对超大 tool_result 内容进行裁剪
2. **Snip Compact**（特性门控 `HISTORY_SNIP`）：`snipCompactIfNeeded()` 对历史中的中间轮次做轻量压缩
3. **Microcompact**：`deps.microcompact()` 对工具结果进行细粒度压缩，支持缓存编辑模式
4. **Context Collapse**（特性门控 `CONTEXT_COLLAPSE`）：`applyCollapsesIfNeeded()` 对上下文做折叠投影
5. **AutoCompact**：`deps.autocompact()` 当 token 数接近上限时触发完整的上下文压缩

这些预处理按顺序执行，collapse 在 autocompact 之前运行——如果 collapse 已足够降低 token 数，autocompact 将成为 no-op，从而保留更细粒度的上下文。

### 2. 流式模型调用

通过 `deps.callModel()` 发起流式 API 调用（`src/query.ts:659-863`）。核心配置包括：

- 当前模型（支持运行时动态切换和 fallback）
- thinking 配置、工具列表、fast mode
- task_budget（跨 compact 边界追踪 remaining）
- 各种选项（effort、advisor model、MCP 工具等）

流式响应中的每条消息会被：
- **可观察输入回填**：对 tool_use 块调用 `backfillObservableInput()` 补充衍生字段
- **错误抑制**：prompt-too-long、max-output-tokens、media-size 等可恢复错误会被暂扣（withheld），待后续恢复逻辑处理
- **流式工具预执行**：当 `streamingToolExecution` 门控开启时，`StreamingToolExecutor` 在模型仍在流式输出时就开始执行已完成的工具块

**Fallback 机制**：如果模型调用抛出 `FallbackTriggeredError`，会切换到 `fallbackModel` 并清空当前轮次的所有累积状态重新调用。流式中途发生 fallback 时，已发出的 assistant 消息会被 tombstone 标记移除。

### 3. 工具执行编排

模型响应完成后，执行所有待处理的工具调用（`src/query.ts:1360-1408`）：

```typescript
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()    // 流式执行：获取剩余结果
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)  // 批量执行
```

- **流式模式**（`StreamingToolExecutor`）：工具在模型流式输出期间并行启动，循环结束后仅需获取剩余结果
- **批量模式**（`runTools`）：所有工具在模型响应完成后统一执行

工具结果通过 `normalizeMessagesForAPI()` 转换为 API 兼容格式。如果任何工具的 hook 返回 `hook_stopped_continuation`，会设置 `shouldPreventContinuation` 阻止继续循环。

### 4. 错误恢复与自动续写

#### Prompt-too-long 恢复（`src/query.ts:1062-1183`）

三级恢复策略，按优先级执行：
1. **Context Collapse drain**：先尝试提交所有已暂存的折叠操作
2. **Reactive Compact**：如果 collapse 不够，触发一次完整的反应式压缩
3. **放弃**：如果仍然无法恢复，向用户展示错误并退出

#### max_output_tokens 恢复（`src/query.ts:1188-1256`）

两级恢复策略：
1. **升级重试**：如果使用了默认的 8k 上限，先提升到 64k（`ESCALATED_MAX_TOKENS`）重试同一请求，无需多轮对话
2. **多轮恢复**：注入一条 meta 消息要求模型从断点继续，最多重试 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`（3）次

> 源码位置：`src/query.ts:164`

#### Token Budget 自动续写（`src/query.ts:1308-1355`）

当 `TOKEN_BUDGET` 特性开启时，`checkTokenBudget()` 在每轮无工具调用的正常结束点检查是否应继续输出：
- 如果已用 token < 预算的 90%，注入续写消息继续
- 如果检测到收益递减（连续 3 次增量 < 500 tokens），提前停止
- 子 Agent 不参与此机制

### 5. Stop Hooks 执行

当模型产出无 tool_use 的最终响应时，触发 stop hooks（`src/query/stopHooks.ts:65-473`）。

`handleStopHooks()` 是一个 AsyncGenerator，依次执行：

1. **缓存安全参数快照**：`saveCacheSafeParams()` 为 prompt suggestion 和 `/btw` 命令保存上下文
2. **Job 分类**（特性门控 `TEMPLATES`）：对模板任务进行状态分类
3. **后台任务触发**（非 bare 模式）：
   - `executePromptSuggestion()` — 生成下一步建议
   - `executeExtractMemories()` — 自动记忆提取（fire-and-forget）
   - `executeAutoDream()` — 自动 dream 分析
4. **Computer Use 清理**（特性门控 `CHICAGO_MCP`）
5. **Stop hooks 执行**：调用 `executeStopHooks()` 运行用户配置的停止钩子
6. **Teammate 钩子**（如果是 teammate 模式）：
   - `executeTaskCompletedHooks()` — 对当前 teammate 的 in_progress 任务
   - `executeTeammateIdleHooks()` — 通知协调器 teammate 空闲

Stop hooks 可以产生三种结果：
- **正常通过**：循环正常退出
- **阻塞错误**（`blockingErrors`）：注入错误消息，循环继续让模型修复
- **阻止继续**（`preventContinuation`）：直接终止循环

### 6. 附件注入与消息队列消费

工具执行完成后、下一轮迭代前（`src/query.ts:1566-1643`）：

1. **消息队列快照**：从全局队列获取待处理命令（区分主线程/子 Agent 的作用域）
2. **附件消息注入**：`getAttachmentMessages()` 注入文件变更通知、系统提醒等
3. **记忆预取消费**：如果 `pendingMemoryPrefetch` 已就绪，注入相关记忆附件
4. **技能发现注入**：如果 `pendingSkillPrefetch` 已就绪，注入技能搜索结果
5. **命令生命周期通知**：标记已消费命令为 started/completed

---

## 函数签名

### `query(params: QueryParams): AsyncGenerator<StreamEvent | ..., Terminal>`

公开入口。委托给 `queryLoop()`，并在正常返回后通知已消费命令的 lifecycle。

> 源码位置：`src/query.ts:219-239`

### `queryLoop(params, consumedCommandUuids): AsyncGenerator<..., Terminal>`

核心循环实现。每次 yield 一个流式事件，最终 return 一个 `Terminal` 对象说明退出原因。

> 源码位置：`src/query.ts:241-1729`

### `handleStopHooks(messagesForQuery, assistantMessages, systemPrompt, ...): AsyncGenerator<..., StopHookResult>`

轮次结束时的 hook 编排器。yield 进度事件和消息，return `{ blockingErrors, preventContinuation }`。

> 源码位置：`src/query/stopHooks.ts:65-473`

### `checkTokenBudget(tracker, agentId, budget, globalTurnTokens): TokenBudgetDecision`

纯函数。根据当前 token 使用量决定 `'continue'` 或 `'stop'`，并检测收益递减。

> 源码位置：`src/query/tokenBudget.ts:45-93`

### `buildQueryConfig(): QueryConfig`

快照一次性的环境/statsig/session 状态，返回不可变配置对象。

> 源码位置：`src/query/config.ts:29-46`

### `productionDeps(): QueryDeps`

生产环境的 I/O 依赖工厂。

> 源码位置：`src/query/deps.ts:33-40`

---

## 接口/类型定义

### `QueryParams`

查询入口的完整参数：

| 字段 | 类型 | 说明 |
|------|------|------|
| `messages` | `Message[]` | 完整对话历史 |
| `systemPrompt` | `SystemPrompt` | 系统提示词 |
| `userContext` / `systemContext` | `Record<string, string>` | 上下文键值对，分别前置/追加到 prompt |
| `canUseTool` | `CanUseToolFn` | 工具权限检查函数 |
| `toolUseContext` | `ToolUseContext` | 工具执行上下文（包含 abort、options、agentId 等） |
| `fallbackModel` | `string?` | 备用模型名称 |
| `querySource` | `QuerySource` | 调用来源标识（`repl_main_thread`/`agent:xxx`/`sdk` 等） |
| `maxOutputTokensOverride` | `number?` | 覆盖默认 max_output_tokens |
| `maxTurns` | `number?` | 最大轮次限制 |
| `taskBudget` | `{ total: number }?` | API task_budget 配置 |
| `deps` | `QueryDeps?` | I/O 依赖注入（测试用） |

> 源码位置：`src/query.ts:181-199`

### `QueryConfig`

每次 `query()` 调用入口快照一次的不可变配置：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `SessionId` | 当前会话 ID |
| `gates.streamingToolExecution` | `boolean` | 是否启用流式工具执行 |
| `gates.emitToolUseSummaries` | `boolean` | 是否生成工具使用摘要 |
| `gates.isAnt` | `boolean` | 是否为 Anthropic 内部用户 |
| `gates.fastModeEnabled` | `boolean` | 是否启用快速模式 |

> 源码位置：`src/query/config.ts:15-27`

### `QueryDeps`

可注入的 I/O 依赖，用于测试时替换真实实现：

| 字段 | 类型 | 说明 |
|------|------|------|
| `callModel` | `typeof queryModelWithStreaming` | 模型流式调用 |
| `microcompact` | `typeof microcompactMessages` | 微压缩 |
| `autocompact` | `typeof autoCompactIfNeeded` | 自动压缩 |
| `uuid` | `() => string` | UUID 生成器 |

> 源码位置：`src/query/deps.ts:21-31`

### `BudgetTracker`

Token 预算追踪状态：

| 字段 | 类型 | 说明 |
|------|------|------|
| `continuationCount` | `number` | 已续写次数 |
| `lastDeltaTokens` | `number` | 上次检查的增量 token 数 |
| `lastGlobalTurnTokens` | `number` | 上次检查时的全局轮次 token 数 |
| `startedAt` | `number` | 追踪开始时间戳 |

> 源码位置：`src/query/tokenBudget.ts:6-11`

### `State`（内部类型）

循环迭代间传递的可变状态：

| 字段 | 说明 |
|------|------|
| `messages` | 当前消息历史 |
| `toolUseContext` | 工具上下文（可跨迭代更新） |
| `autoCompactTracking` | 压缩追踪状态 |
| `maxOutputTokensRecoveryCount` | 当前 max_output_tokens 恢复次数 |
| `hasAttemptedReactiveCompact` | 是否已尝试反应式压缩 |
| `turnCount` | 当前轮次计数 |
| `transition` | 上一次迭代的续写原因 |

> 源码位置：`src/query.ts:204-217`

---

## 循环退出原因（Terminal.reason）

| reason | 触发条件 |
|--------|----------|
| `completed` | 模型正常完成，无 tool_use |
| `aborted_streaming` | 流式输出期间用户中断 |
| `aborted_tools` | 工具执行期间用户中断 |
| `blocking_limit` | Token 数达到硬阻塞限制 |
| `model_error` | 模型调用异常 |
| `image_error` | 图片尺寸/缩放错误 |
| `prompt_too_long` | Prompt 过长且恢复失败 |
| `max_turns` | 达到 maxTurns 限制 |
| `hook_stopped` | 工具 hook 阻止继续 |
| `stop_hook_prevented` | Stop hook 阻止继续 |

---

## 循环续写原因（Continue.reason / transition）

| reason | 触发条件 |
|--------|----------|
| `next_turn` | 正常工具执行后进入下一轮 |
| `stop_hook_blocking` | Stop hook 返回阻塞错误，需要模型修复 |
| `max_output_tokens_recovery` | max_output_tokens 多轮恢复 |
| `max_output_tokens_escalate` | max_output_tokens 升级重试（8k→64k） |
| `reactive_compact_retry` | 反应式压缩后重试 |
| `collapse_drain_retry` | Context collapse 提交后重试 |
| `token_budget_continuation` | Token 预算未耗尽，自动续写 |

---

## 配置项与默认值

| 常量/配置 | 值 | 说明 |
|-----------|-----|------|
| `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` | 3 | max_output_tokens 恢复最大重试次数 |
| `COMPLETION_THRESHOLD` | 0.9 | Token 预算使用率 < 90% 时触发续写 |
| `DIMINISHING_THRESHOLD` | 500 | 连续增量低于此值判定为收益递减 |
| `ESCALATED_MAX_TOKENS` | （来自 `utils/context.ts`） | 升级后的 max_output_tokens 上限 |

---

## 边界 Case 与注意事项

- **流式 fallback 中的 tombstone**：当流式输出中途触发模型 fallback 时，已发出的 assistant 消息会被标记为 tombstone 并通知 UI 移除。这避免了 thinking 签名不匹配导致的 API 400 错误。

- **反应式压缩不重置**：`hasAttemptedReactiveCompact` 在 stop hook blocking 续写时保持不变。重置会导致无限循环：compact → 仍然太长 → 错误 → stop hook blocking → compact → ...

- **子 Agent 的作用域隔离**：消息队列消费、token budget、tool use summary 生成、记忆提取、task summary 等功能都通过 `agentId` 判断进行作用域隔离，子 Agent 不会影响主线程的状态。

- **task_budget 跨压缩追踪**：`taskBudgetRemaining` 在每次 compact 时根据压缩前的 final context tokens 更新。压缩前服务端能看到完整历史并自行计算，压缩后由客户端提供 remaining 值。

- **抑制提交中断消息**：当 abort 原因为 `'interrupt'`（用户提交新消息导致的中断）时，不发送中断消息——后续的用户消息已提供足够上下文。

- **工具结果预算与 microcompact 的组合**：`applyToolResultBudget()` 在 microcompact 之前运行。由于 cached microcompact 通过 `tool_use_id` 操作而非检查内容，两者可以干净地组合。