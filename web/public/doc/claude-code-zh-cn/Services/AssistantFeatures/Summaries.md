# 摘要生成服务（Summaries）

## 概述与职责

摘要生成服务是 **Services → AssistantFeatures** 层下的辅助功能集合，包含三个独立的摘要生成器，分别面向不同场景：

| 服务 | 文件 | 面向场景 | 调用模型 |
|------|------|----------|----------|
| AgentSummary | `src/services/AgentSummary/agentSummary.ts` | 子 Agent 运行时的 UI 进度展示 | 复用父 Agent 的模型（通过 forked agent） |
| toolUseSummaryGenerator | `src/services/toolUseSummary/toolUseSummaryGenerator.ts` | SDK 客户端的工具批次摘要 | Haiku（通过 `queryHaiku`） |
| awaySummary | `src/services/awaySummary.ts` | 用户回归时的"你离开期间"回顾卡片 | 小型快速模型（通过 `getSmallFastModel`） |

三者均为**非关键功能**——生成失败时静默返回 `null`，不影响主流程。它们通过调用不同的 Claude 模型 API 生成简短的自然语言文本。

同级兄弟模块包括：语音输入（voice）、提示建议（PromptSuggestion）、自动梦境（autoDream）、魔法文档（MagicDocs）、使用提示（tips）等辅助功能。

---

## 关键流程

### 1. AgentSummary：子 Agent 周期性进度摘要

**核心机制**：通过定时器每 30 秒 fork 子 Agent 的对话上下文，让模型用 3-5 个词描述当前正在做什么。

#### 启动与生命周期

1. 调用 `startAgentSummarization()` 启动定时循环，返回 `{ stop }` 句柄
2. 每 30 秒（`SUMMARY_INTERVAL_MS`）触发一次 `runSummary()`
3. 调用 `stop()` 时清除定时器并中止正在进行的 API 请求

#### 单次摘要生成流程

1. 从 `getAgentTranscript(agentId)` 读取子 Agent 当前对话记录
2. 如果消息数不足 3 条，跳过本次生成（上下文不够）
3. 调用 `filterIncompleteToolCalls()` 清理不完整的工具调用消息
4. 构造 `CacheSafeParams`，将清理后的消息设为 `forkContextMessages`（`agentSummary.ts:80-84`）
5. 通过 `runForkedAgent()` 发起一次 forked agent 调用，附加摘要 prompt
6. 从返回结果中提取文本，调用 `updateAgentSummary()` 更新 UI 状态

#### 缓存共享设计

这是该服务最精妙的设计点。为了复用父 Agent 的 prompt 缓存：

- **保留工具列表**：不传空 `tools:[]`，而是通过 `canUseTool` 回调返回 `deny`，避免缓存键不匹配（`agentSummary.ts:93-98`）
- **不设 `maxOutputTokens`**：设置该参数会改变 thinking config 的 `budget_tokens`，导致缓存失效（`agentSummary.ts:100-108`）
- **每次从 transcript 重新读取消息**：启动时显式丢弃闭包中的 `forkContextMessages`（`agentSummary.ts:55`），防止旧消息被长期持有造成内存泄漏

#### 摘要 Prompt 设计

`buildSummaryPrompt()` 要求模型以现在进行时（-ing）产出 3-5 词描述，并给出正反例（`agentSummary.ts:28-44`）。如果存在上一轮摘要 `previousSummary`，会提示模型"说些新的"，避免重复。

### 2. toolUseSummaryGenerator：工具调用批次摘要

**核心机制**：在一批工具调用完成后，将工具名称、输入和输出发送给 Haiku 模型，生成一行类似 git commit 主题的简短标签。

#### 流程

1. 将每个工具的 `name`、`input`、`output` 序列化为文本，每个字段截断到 300 字符（`toolUseSummaryGenerator.ts:57-63`）
2. 如果有 `lastAssistantText`（上一轮助手消息），作为意图上下文前缀加入 prompt
3. 调用 `queryHaiku()` 发送请求，system prompt 要求生成约 30 字符的过去式标签（`toolUseSummaryGenerator.ts:15-24`）
4. 从响应中提取文本内容返回

#### 输入类型

```typescript
type GenerateToolUseSummaryParams = {
  tools: ToolInfo[]        // 本批工具调用的名称、输入、输出
  signal: AbortSignal      // 取消信号
  isNonInteractiveSession: boolean  // 是否非交互式（SDK）会话
  lastAssistantText?: string        // 上一轮助手文本，用作意图上下文
}
```

> 源码位置：`src/services/toolUseSummary/toolUseSummaryGenerator.ts:32-37`

### 3. awaySummary：离开回顾摘要

**核心机制**：当用户离开一段时间后回来，从最近对话中生成 1-3 句话的回顾，帮助用户快速回忆上下文。

#### 流程

1. 取最近 30 条消息（`RECENT_MESSAGE_WINDOW`），避免大型会话导致 prompt 过长（`awaySummary.ts:16`）
2. 获取 `SessionMemory` 内容作为更广泛的上下文注入 prompt（`awaySummary.ts:38`）
3. 将摘要请求 prompt 追加到消息列表末尾
4. 调用 `queryModelWithoutStreaming()` 以非流式方式请求模型生成，使用小型快速模型、禁用 thinking、不传工具
5. 设置 `skipCacheWrite: true` 避免污染缓存（`awaySummary.ts:56`）

#### Prompt 设计

`buildAwaySummaryPrompt()` 要求模型：
- 先说明高层任务（在做什么），不是实现细节
- 然后给出具体的下一步
- 跳过状态报告和 commit 回顾

如果存在 session memory，会作为"更广泛上下文"前置注入。

---

## 函数签名

### `startAgentSummarization(taskId, agentId, cacheSafeParams, setAppState): { stop: () => void }`

启动子 Agent 的周期性摘要生成。

| 参数 | 类型 | 说明 |
|------|------|------|
| `taskId` | `string` | 任务 ID，用于更新对应的 UI 状态 |
| `agentId` | `AgentId` | 子 Agent ID，用于读取其对话记录 |
| `cacheSafeParams` | `CacheSafeParams` | 父 Agent 的缓存安全参数，用于 fork 时共享缓存 |
| `setAppState` | `TaskContext['setAppState']` | UI 状态更新函数 |

返回 `{ stop }` 对象，调用 `stop()` 终止定时器并中止进行中的请求。

> 源码位置：`src/services/AgentSummary/agentSummary.ts:46-179`

### `generateToolUseSummary(params): Promise<string | null>`

为一批已完成的工具调用生成一行摘要标签。

| 参数字段 | 类型 | 说明 |
|----------|------|------|
| `tools` | `ToolInfo[]` | 工具调用信息（名称、输入、输出） |
| `signal` | `AbortSignal` | 取消信号 |
| `isNonInteractiveSession` | `boolean` | 是否非交互式会话 |
| `lastAssistantText` | `string?` | 可选，上轮助手文本作为意图参考 |

失败时返回 `null`。

> 源码位置：`src/services/toolUseSummary/toolUseSummaryGenerator.ts:45-97`

### `generateAwaySummary(messages, signal): Promise<string | null>`

为用户回归场景生成 1-3 句会话回顾。

| 参数 | 类型 | 说明 |
|------|------|------|
| `messages` | `readonly Message[]` | 当前会话的完整消息列表 |
| `signal` | `AbortSignal` | 取消信号 |

失败或中止时返回 `null`。

> 源码位置：`src/services/awaySummary.ts:29-74`

---

## 类型定义

### `ToolInfo`

工具调用信息结构，用于 `generateToolUseSummary` 的输入：

```typescript
type ToolInfo = {
  name: string      // 工具名称（如 "Bash", "Read"）
  input: unknown    // 工具输入参数
  output: unknown   // 工具执行结果
}
```

> 源码位置：`src/services/toolUseSummary/toolUseSummaryGenerator.ts:26-30`

---

## 配置项与默认值

| 常量 | 值 | 文件 | 说明 |
|------|----|------|------|
| `SUMMARY_INTERVAL_MS` | `30_000`（30秒） | `agentSummary.ts:26` | Agent 摘要生成间隔 |
| `RECENT_MESSAGE_WINDOW` | `30` | `awaySummary.ts:16` | 离开摘要取最近消息条数上限 |
| JSON 截断长度 | `300` 字符 | `toolUseSummaryGenerator.ts:59-60` | 工具输入/输出序列化时的截断阈值 |

---

## 边界 Case 与注意事项

- **AgentSummary 不会并发运行**：下一次定时器在当前摘要完成后（`finally` 块中）才调度，避免重叠请求（`agentSummary.ts:148-153`）
- **消息数不足时跳过**：Agent 对话少于 3 条消息时不生成摘要，等下一个周期再尝试（`agentSummary.ts:69-75`）
- **工具列表为空时短路返回**：`generateToolUseSummary` 在 `tools.length === 0` 时直接返回 `null`（`toolUseSummaryGenerator.ts:51-53`）
- **awaySummary 禁用 thinking**：显式设置 `thinkingConfig: { type: 'disabled' }`，减少开销和延迟（`awaySummary.ts:44`）
- **awaySummary 跳过缓存写入**：设置 `skipCacheWrite: true`，因为回顾摘要是一次性的，不值得缓存（`awaySummary.ts:56`）
- **所有服务都静默处理错误**：三个服务在 API 失败、中止或异常时均返回 `null` 并记录日志，不会向上抛出异常影响主流程
- **内存泄漏防护**：`startAgentSummarization` 启动时主动丢弃闭包中的 `forkContextMessages`（`agentSummary.ts:55`），每次 tick 从 transcript 重新读取，避免大量消息对象被长期引用