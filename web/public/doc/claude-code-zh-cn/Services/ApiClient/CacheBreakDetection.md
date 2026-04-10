# Prompt 缓存中断检测与诊断

## 概述与职责

`promptCacheBreakDetection` 是 ApiClient 服务层中的缓存诊断模块，负责跟踪每次 API 请求的 prompt 状态（系统提示词、工具列表、模型、Beta 头等），在检测到缓存命中率突降时自动对比前后状态差异，生成详细的 diff 报告，帮助开发者定位缓存失效的根因。

**在架构中的位置**：该模块隶属于 `Services > ApiClient` 层，被 `claude.ts`（核心 API 调用入口）在每次请求前后分别调用。它依赖 Analytics 服务上报缓存中断事件（`tengu_prompt_cache_break`），并将 diff 文件写入临时目录供 `--debug` 模式查看。

**同级模块**：与 ApiClient 内的客户端实例化（`client.ts`）、核心调用逻辑（`claude.ts`）协作，作为 API 通信的可观测性增强。

## 关键流程

### 两阶段检测机制

整个检测分为 **Phase 1（请求前）** 和 **Phase 2（请求后）** 两个阶段，以此将"状态变化检测"与"缓存命中判定"解耦：

#### Phase 1：`recordPromptState()` — 记录状态快照

1. 通过 `getTrackingKey()` 确定当前请求的追踪键（`src/services/api/promptCacheBreakDetection.ts:149-158`）。`compact` 类查询共享 `repl_main_thread` 的追踪状态，因为它们共享服务端缓存
2. 对 system prompt 和 tool schemas 调用 `stripCacheControl()` 去除 `cache_control` 字段后计算哈希，同时单独计算包含 `cache_control` 的哈希以捕获作用域/TTL 翻转
3. 与上次状态逐维度对比（共 12 个维度），如有变化则构建 `PendingChanges` 对象，精确记录哪些工具被增删、哪个工具的 schema 发生了变化、哪些 Beta 头被增删等
4. 更新存储的状态快照，等待 Phase 2 使用

#### Phase 2：`checkResponseForCacheBreak()` — 判定缓存中断

1. 从 API 响应中获取 `cacheReadTokens` 和 `cacheCreationTokens`
2. 排除预期的缓存下降场景：首次调用（无基线）、`cacheDeletionsPending`（microcompact 删除导致的预期下降）、Haiku 模型
3. 判定缓存中断：cache read tokens 下降超过 5% **且**绝对下降超过 2000 tokens（`src/services/api/promptCacheBreakDetection.ts:486-492`）
4. 组合变化原因说明。若无客户端变化，根据时间间隔判断是否为 TTL 过期（5 分钟/1 小时）或服务端原因
5. 通过 `logEvent('tengu_prompt_cache_break', ...)` 上报事件，并在 `--debug` 模式下生成 unified diff 文件

### 追踪键管理与内存控制

- **追踪键策略**：只追踪 `TRACKED_SOURCE_PREFIXES` 列表中的 5 类来源（`repl_main_thread`、`sdk`、`agent:custom`、`agent:default`、`agent:builtin`），短命的 speculation/session_memory 等查询不追踪（`src/services/api/promptCacheBreakDetection.ts:109-115`）
- **内存上限**：`MAX_TRACKED_SOURCES = 10`，超限时使用 FIFO 策略淘汰最早的条目，防止大量子 Agent 导致内存无限增长（`src/services/api/promptCacheBreakDetection.ts:107,300-303`）
- **子 Agent 隔离**：同一 querySource 类型的不同 Agent 实例通过 `agentId` 隔离追踪状态，避免并发 Agent 之间的误报

## 函数签名与参数说明

### `recordPromptState(snapshot: PromptStateSnapshot): void`

Phase 1 入口。在每次 API 调用前记录 prompt 状态快照并检测与上次的差异。

- **snapshot.system**：`TextBlockParam[]`，系统提示词文本块数组
- **snapshot.toolSchemas**：`BetaToolUnion[]`，工具 schema 列表
- **snapshot.querySource**：`QuerySource`，请求来源标识
- **snapshot.model**：`string`，当前使用的模型名称
- **snapshot.agentId?**：`AgentId`，子 Agent 的唯一 ID
- **snapshot.fastMode?**：`boolean`，是否启用快速模式
- **snapshot.globalCacheStrategy?**：`string`，全局缓存策略（`'tool_based' | 'system_prompt' | 'none'`）
- **snapshot.betas?**：`readonly string[]`，Beta 功能头列表
- **snapshot.autoModeActive?**、**isUsingOverage?**、**cachedMCEnabled?**：`boolean`，特性开关状态
- **snapshot.effortValue?**：`string | number`，推理努力等级
- **snapshot.extraBodyParams?**：`unknown`，额外请求体参数

> 源码位置：`src/services/api/promptCacheBreakDetection.ts:247-430`

### `checkResponseForCacheBreak(querySource, cacheReadTokens, cacheCreationTokens, messages, agentId?, requestId?): Promise<void>`

Phase 2 入口。在 API 响应返回后检查缓存命中情况，发现中断时上报事件并生成 diff。

- **cacheReadTokens**：`number`，本次响应的缓存读取 token 数
- **cacheCreationTokens**：`number`，本次响应的缓存创建 token 数
- **messages**：`Message[]`，当前对话消息列表，用于计算距上次调用的时间间隔
- **requestId?**：`string | null`，服务端请求 ID，用于关联日志

> 源码位置：`src/services/api/promptCacheBreakDetection.ts:437-666`

### `notifyCacheDeletion(querySource, agentId?): void`

通知模块即将发生 cached microcompact 的 `cache_edits` 删除操作。下一次 API 响应的缓存 token 下降属于预期行为，不应触发告警。

> 源码位置：`src/services/api/promptCacheBreakDetection.ts:673-682`

### `notifyCompaction(querySource, agentId?): void`

通知模块刚完成上下文压缩。压缩会减少消息数量导致缓存 token 自然下降，重置基线以避免误报。

> 源码位置：`src/services/api/promptCacheBreakDetection.ts:689-698`

### `cleanupAgentTracking(agentId): void`

清除指定 Agent 的追踪状态，在 Agent 生命周期结束时调用。

### `resetPromptCacheBreakDetection(): void`

清空所有追踪状态，用于测试或重置场景。

## 接口/类型定义

### `PromptStateSnapshot`（导出）

Phase 1 的输入类型，包含影响服务端缓存键的所有可观测维度。所有可选字段默认视为"未变化"。

### `PreviousState`（内部）

存储每个追踪键的完整状态快照，包括：

| 字段 | 类型 | 说明 |
|------|------|------|
| systemHash | number | 去除 cache_control 后的系统提示词哈希 |
| toolsHash | number | 去除 cache_control 后的工具列表哈希 |
| cacheControlHash | number | 包含 cache_control 的哈希（捕获作用域/TTL 翻转） |
| perToolHashes | Record<string, number> | 每个工具的独立 schema 哈希 |
| pendingChanges | PendingChanges \| null | Phase 1 检测到的变化，等待 Phase 2 消费 |
| prevCacheReadTokens | number \| null | 上次 API 响应的缓存读取 token 数 |
| cacheDeletionsPending | boolean | 是否有待生效的 cache 删除操作 |
| buildDiffableContent | () => string | 延迟构建的可 diff 内容生成器 |

### `PendingChanges`（内部）

12 个布尔变化标记 + 精确的变化详情（增删的工具名、schema 变化的工具名、增删的 Beta 头、模型/策略/Effort 的前后值等）。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_TRACKED_SOURCES` | 10 | 追踪状态 Map 的最大条目数 |
| `MIN_CACHE_MISS_TOKENS` | 2,000 | 触发告警的最小绝对 token 下降量 |
| `CACHE_TTL_5MIN_MS` | 300,000 (5min) | 服务端 5 分钟 TTL 阈值 |
| `CACHE_TTL_1HOUR_MS` | 3,600,000 (1h) | 服务端 1 小时 TTL 阈值（导出） |
| `TRACKED_SOURCE_PREFIXES` | 5 个前缀 | 仅追踪这些来源类型的请求 |

## 边界 Case 与注意事项

- **Haiku 模型被排除**：`isExcludedModel()` 跳过包含 `haiku` 的模型，因其缓存行为不同（`src/services/api/promptCacheBreakDetection.ts:129-131`）
- **误报抑制机制**：三种场景不会触发告警——`cacheDeletionsPending`（microcompact 删除）、`notifyCompaction`（上下文压缩重置基线）、token 下降小于 5% 或 2000
- **哈希计算双轨**：优先使用 `Bun.hash()`，非 Bun 运行时回退到 `djb2Hash()`（`src/services/api/promptCacheBreakDetection.ts:170-179`）
- **工具名脱敏**：MCP 工具名可能包含用户文件路径，上报事件时统一替换为 `'mcp'`（`src/services/api/promptCacheBreakDetection.ts:183-185`）
- **延迟计算优化**：`perToolHashes` 只在 `toolsHash` 变化时才逐个计算；`buildDiffableContent` 使用惰性闭包，未发生缓存中断时不会执行序列化
- **服务端原因识别**：当所有客户端变化标志均为 false 且时间间隔小于 5 分钟，标记为 `'likely server-side'`，避免误导开发者在客户端排查
- **diff 文件输出**：缓存中断时在临时目录生成 unified diff 文件（随机后缀避免冲突），路径包含在日志摘要中，通过 `--debug` 模式可查看