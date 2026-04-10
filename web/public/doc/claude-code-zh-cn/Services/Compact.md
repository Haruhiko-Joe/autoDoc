# 上下文窗口压缩服务（Compact）

## 概述与职责

Compact 模块是 Claude Code 的**上下文窗口管理核心**，负责在对话历史的 Token 用量接近模型上下文窗口上限时，自动或手动地压缩对话内容，以释放空间供后续交互使用。它位于 Services 层（`src/services/compact/`），被 CoreEngine 的查询引擎在每次对话循环中调用，与 API 服务、SessionMemory、Analytics 等模块紧密协作。

该模块提供三个层次的压缩策略，从轻量到重量依次为：

1. **微压缩（MicroCompact）**：在 API 调用前清理旧的工具调用结果，减少发送给模型的 Token 量
2. **会话记忆压缩（Session Memory Compact）**：利用已提取的会话记忆替代完整对话摘要
3. **完整压缩（Full Compact）**：通过 fork 一个子 Agent 调用模型生成对话摘要，替换全部历史消息

## 文件结构

| 文件 | 职责 |
|------|------|
| `compact.ts` | 完整压缩和部分压缩的核心实现 |
| `autoCompact.ts` | 自动压缩的触发判断与执行入口 |
| `microCompact.ts` | 微压缩：清理旧工具结果以释放 Token |
| `apiMicrocompact.ts` | 基于 API 原生 context management 的微压缩策略 |
| `grouping.ts` | 按 API 轮次分组消息 |
| `prompt.ts` | 压缩提示词模板和摘要格式化 |
| `postCompactCleanup.ts` | 压缩后的缓存/状态清理 |
| `sessionMemoryCompact.ts` | 基于会话记忆的轻量压缩 |
| `timeBasedMCConfig.ts` | 基于时间间隔的微压缩配置 |
| `compactWarningState.ts` | 压缩预警抑制状态管理 |
| `compactWarningHook.ts` | React Hook：订阅压缩预警状态 |

## 关键流程

### 1. 自动压缩触发流程

自动压缩由查询引擎在每个对话循环中检测：

1. `shouldAutoCompact()` 计算当前消息的 Token 总量，与阈值比较（`autoCompact.ts:160-239`）
2. 阈值 = 有效上下文窗口 − 13,000 缓冲 Token（`AUTOCOMPACT_BUFFER_TOKENS`）
3. 如果超过阈值，`autoCompactIfNeeded()` 被调用（`autoCompact.ts:241-351`）
4. 先尝试**会话记忆压缩**（`trySessionMemoryCompaction`），成功则直接返回
5. 若会话记忆不可用，退回到**完整压缩**（`compactConversation`）
6. 内置**熔断器**：连续 3 次失败后停止重试，避免浪费 API 调用

```
shouldAutoCompact → tokenCount >= threshold?
    ↓ YES
autoCompactIfNeeded
    ├─→ trySessionMemoryCompaction (优先)
    │     └─ 成功 → 返回 CompactionResult
    └─→ compactConversation (兜底)
          └─ 成功/失败 → 熔断计数
```

关键守卫条件：`shouldAutoCompact` 会跳过 `session_memory`、`compact`、`marble_origami` 等 querySource 防止递归死锁；当 Context Collapse 或 Reactive Compact 启用时也会让出控制权（`autoCompact.ts:170-223`）。

### 2. 完整压缩流程（compactConversation）

这是最重的压缩路径，调用模型生成对话摘要（`compact.ts:387-763`）：

1. **执行 PreCompact Hook**：允许用户自定义压缩前行为
2. **构造压缩提示词**：通过 `getCompactPrompt()` 生成详尽的摘要指令，要求模型输出 `<analysis>` + `<summary>` 格式
3. **流式调用模型**：通过 `streamCompactSummary()` 发起 API 请求，优先使用 forked agent 共享主对话的 prompt cache
4. **处理 prompt-too-long**：如果压缩请求本身超长，`truncateHeadForPTLRetry()` 会丢弃最老的 API 轮次组后重试（最多 3 次）
5. **格式化摘要**：`formatCompactSummary()` 剥离 `<analysis>` 草稿块，保留 `<summary>` 内容
6. **重建上下文**：生成边界标记（`boundaryMarker`）、摘要消息、文件附件（最近读取的文件内容恢复）、计划/技能附件
7. **执行 SessionStart Hook + PostCompact Hook**
8. **通知 prompt cache 检测器**避免误报缓存中断

### 3. 微压缩流程（microcompactMessages）

在每次 API 调用前执行的轻量清理（`microCompact.ts:253-293`）：

```
microcompactMessages
    ├─→ maybeTimeBasedMicrocompact (时间触发)
    │     └─ 距上次 assistant 消息 > N 分钟 → 清理旧工具结果
    ├─→ cachedMicrocompactPath (缓存编辑)
    │     └─ 通过 cache_edits API 删除旧工具结果（不修改本地消息）
    └─→ 返回原始消息（无操作）
```

**可压缩工具**（`COMPACTABLE_TOOLS`）：FileRead、Bash/Shell、Grep、Glob、WebSearch、WebFetch、FileEdit、FileWrite（`microCompact.ts:41-50`）。

**时间触发微压缩**（`maybeTimeBasedMicrocompact`，`microCompact.ts:446-530`）：当距离上一次 assistant 消息的时间间隔超过阈值（默认 60 分钟，配置来自 GrowthBook），说明服务端 prompt cache 已过期，此时将旧工具结果的内容替换为 `[Old tool result content cleared]`，仅保留最近 N 个。

**缓存编辑微压缩**（`cachedMicrocompactPath`，`microCompact.ts:305-399`）：面向内部用户（ant），通过 API 的 `cache_edits` 机制在服务端删除旧工具结果，**不修改本地消息内容**，从而保持 prompt cache 命中。使用计数触发/保留阈值，由 GrowthBook 远程配置。

### 4. 会话记忆压缩流程

利用已有的 SessionMemory 内容替代模型调用，避免额外 API 开销（`sessionMemoryCompact.ts:514-630`）：

1. 检查功能开关（`tengu_session_memory` + `tengu_sm_compact`）
2. 从远程加载压缩配置（最小保留 Token 数、最小文本消息数、最大保留 Token 数）
3. 等待进行中的会话记忆提取完成
4. 使用 `calculateMessagesToKeepIndex()` 计算保留消息的起始索引：
   - 从 `lastSummarizedMessageId` 开始
   - 向前扩展直到满足最小 Token（10K）和最小文本消息（5 条）要求
   - 不超过最大 Token 上限（40K）
5. `adjustIndexToPreserveAPIInvariants()` 确保不拆分 `tool_use/tool_result` 配对和共享 `message.id` 的 thinking 块
6. 构建包含会话记忆摘要 + 保留消息的 `CompactionResult`

### 5. 部分压缩（partialCompactConversation）

支持用户手动选择压缩范围，两个方向（`compact.ts:772-1106`）：

- **`from`**：从选中消息开始，摘要后面的消息，保留前面的（保持 prompt cache）
- **`up_to`**：摘要选中消息之前的内容，保留后面的（会失效 prompt cache）

## 函数签名

### `shouldAutoCompact(messages, model, querySource?, snipTokensFreed?): Promise<boolean>`

判断是否应触发自动压缩。考虑多种守卫条件（递归防护、功能开关、Context Collapse 互斥）。

> 源码位置：`autoCompact.ts:160-239`

### `autoCompactIfNeeded(messages, toolUseContext, cacheSafeParams, querySource?, tracking?, snipTokensFreed?): Promise<{wasCompacted, compactionResult?, consecutiveFailures?}>`

自动压缩入口，包含熔断器逻辑。先尝试会话记忆压缩，再回退到完整压缩。

> 源码位置：`autoCompact.ts:241-351`

### `compactConversation(messages, context, cacheSafeParams, suppressFollowUpQuestions, customInstructions?, isAutoCompact?, recompactionInfo?): Promise<CompactionResult>`

完整压缩入口，通过模型调用生成对话摘要。

> 源码位置：`compact.ts:387-763`

### `partialCompactConversation(allMessages, pivotIndex, context, cacheSafeParams, userFeedback?, direction?): Promise<CompactionResult>`

部分压缩入口，支持 `from` 和 `up_to` 两个方向。

> 源码位置：`compact.ts:772-1106`

### `microcompactMessages(messages, toolUseContext?, querySource?): Promise<MicrocompactResult>`

微压缩入口，按优先级依次尝试时间触发、缓存编辑、无操作。

> 源码位置：`microCompact.ts:253-293`

### `getAutoCompactThreshold(model): number`

计算自动压缩的 Token 阈值 = 有效上下文窗口 − 13,000。支持通过 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 环境变量按百分比覆盖。

> 源码位置：`autoCompact.ts:72-91`

### `calculateTokenWarningState(tokenUsage, model): {...}`

计算当前 Token 使用的预警状态，返回剩余百分比和各级阈值标志。

> 源码位置：`autoCompact.ts:93-145`

### `getAPIContextManagement(options?): ContextManagementConfig | undefined`

生成 API 原生上下文管理策略配置（`clear_tool_uses_20250919`、`clear_thinking_20251015`），仅部分功能面向内部用户。

> 源码位置：`apiMicrocompact.ts:64-153`

## 接口/类型定义

### `CompactionResult`

压缩操作的统一返回结构（`compact.ts:299-310`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| boundaryMarker | SystemMessage | 压缩边界标记，包含元数据 |
| summaryMessages | UserMessage[] | 摘要内容消息 |
| attachments | AttachmentMessage[] | 附件（文件恢复、计划、技能等） |
| hookResults | HookResultMessage[] | Hook 执行结果 |
| messagesToKeep? | Message[] | 保留的原始消息（部分压缩/SM压缩） |
| preCompactTokenCount? | number | 压缩前 Token 数 |
| postCompactTokenCount? | number | 压缩 API 调用的总 Token 用量 |
| truePostCompactTokenCount? | number | 压缩后实际上下文 Token 估算 |

### `AutoCompactTrackingState`

自动压缩追踪状态（`autoCompact.ts:51-60`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| compacted | boolean | 本会话是否已压缩过 |
| turnCounter | number | 对话轮次计数 |
| turnId | string | 当前轮次唯一 ID |
| consecutiveFailures? | number | 连续失败次数（用于熔断） |

### `SessionMemoryCompactConfig`

会话记忆压缩配置（`sessionMemoryCompact.ts:47-54`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| minTokens | number | 10,000 | 压缩后最少保留 Token 数 |
| minTextBlockMessages | number | 5 | 最少保留的文本消息数 |
| maxTokens | number | 40,000 | 压缩后最多保留 Token 数 |

### `TimeBasedMCConfig`

时间触发微压缩配置（`timeBasedMCConfig.ts:18-28`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| enabled | boolean | false | 是否启用 |
| gapThresholdMinutes | number | 60 | 触发阈值（分钟） |
| keepRecent | number | 5 | 保留最近的工具结果数 |

### `MicrocompactResult`

微压缩返回结构（`microCompact.ts:215-220`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| messages | Message[] | 处理后的消息（可能未修改） |
| compactionInfo? | object | 缓存编辑元数据 |

## 配置项与环境变量

| 环境变量 | 说明 |
|----------|------|
| `DISABLE_COMPACT` | 完全禁用所有压缩 |
| `DISABLE_AUTO_COMPACT` | 仅禁用自动压缩，保留手动 `/compact` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 覆盖上下文窗口大小上限 |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 按百分比覆盖自动压缩阈值（用于测试） |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | 覆盖阻塞限制阈值（用于测试） |
| `ENABLE_CLAUDE_CODE_SM_COMPACT` | 强制启用会话记忆压缩 |
| `DISABLE_CLAUDE_CODE_SM_COMPACT` | 强制禁用会话记忆压缩 |
| `USE_API_CLEAR_TOOL_RESULTS` | 启用 API 原生工具结果清理策略（内部） |
| `USE_API_CLEAR_TOOL_USES` | 启用 API 原生工具使用清理策略（内部） |

用户配置：`autoCompactEnabled`（全局配置项，`getGlobalConfig().autoCompactEnabled`）。

## 常量

| 常量 | 值 | 说明 |
|------|----|------|
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | 自动压缩触发缓冲 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | 预警阈值缓冲 |
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | 摘要输出 Token 预留 |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | 熔断器阈值 |
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | 压缩后恢复的最大文件数 |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | 压缩后附件 Token 预算 |

## 消息分组策略

`groupMessagesByApiRound()`（`grouping.ts:22-63`）按 **API 轮次边界**分组消息，而非按用户消息分组。每当出现新的 `assistant.message.id` 时产生一个新分组。这对 SDK/CCR/eval 等单 prompt 长任务场景尤为重要——整个工作负载可能只有一条用户消息，按用户消息分组会导致无法进行细粒度的压缩操作。

## 压缩后清理

`runPostCompactCleanup()`（`postCompactCleanup.ts:31-77`）在所有压缩路径完成后执行：

- 重置微压缩状态（`resetMicrocompactState`）
- 清理 Context Collapse 状态（仅主线程）
- 清理 `getUserContext` 和 `getMemoryFiles` 缓存
- 清理系统提示词分段、分类器审批、推测检查
- 清理 beta tracing 状态和会话消息缓存
- **不清理**已调用的技能内容（需跨压缩保持）

区分主线程与子 Agent：子 Agent 共享进程级模块状态，只有主线程压缩才会重置全局缓存，避免子 Agent 压缩时破坏主线程状态。

## 压缩预警状态

`compactWarningState.ts` 通过 `createStore` 管理一个布尔状态：压缩成功后抑制预警显示（因为此时没有准确的 Token 计数），直到下一次压缩尝试开始时清除。`compactWarningHook.ts` 提供 React Hook `useCompactWarningSuppression()` 供 UI 组件订阅。

## 边界 Case 与注意事项

- **熔断器**：连续 3 次自动压缩失败后本会话不再重试，防止陷入无限循环浪费 API 调用（历史上每日约 250K 无效调用）
- **递归防护**：`shouldAutoCompact` 对 `session_memory`、`compact`、`marble_origami` 等 querySource 返回 false，避免压缩子 Agent 自身触发压缩
- **tool_use/tool_result 配对保护**：`adjustIndexToPreserveAPIInvariants()` 确保保留的消息不会出现孤立的 tool_result（缺少对应 tool_use），避免 API 报错
- **thinking 块合并**：同一 `message.id` 的多个 assistant 消息（流式输出产生）必须一起保留，否则 `normalizeMessagesForAPI` 无法正确合并
- **prompt-too-long 重试**：当压缩请求本身超出模型限制时，`truncateHeadForPTLRetry()` 按 API 轮次组丢弃最老内容后重试，最多 3 次
- **prompt cache 协调**：每次压缩后通过 `notifyCompaction()` 通知缓存中断检测器，避免误报 cache break 事件
- **时间触发与缓存 MC 互斥**：时间触发微压缩运行后会重置缓存 MC 状态，因为内容变更已使服务端缓存失效