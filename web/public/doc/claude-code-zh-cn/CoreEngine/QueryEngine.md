# QueryEngine

## 概述与职责

`QueryEngine` 是 Claude Code 核心对话引擎中的**会话级查询管理类**，位于 `src/QueryEngine.ts`。它是 SDK/Headless 路径的核心入口，每个对话实例对应一个 `QueryEngine`，负责管理多轮对话的完整生命周期。

在系统架构中，`QueryEngine` 属于 **CoreEngine** 模块，位于 Entrypoints（入口层）和底层服务之间。入口层（CLI、SDK）初始化后创建 `QueryEngine` 实例，由它协调模型调用、工具执行、权限校验、会话持久化等核心流程。同级模块包括 `query.ts`（消息规范化与 Token 预算管理）和上下文构建模块。

核心职责包括：
- **系统提示词构建**：组装默认/自定义/追加提示词和记忆提示
- **工具权限跟踪**：封装 `canUseTool` 并记录所有权限拒绝
- **模型选择协调**：支持用户指定模型、fast mode、thinking config
- **SDK 消息流处理**：通过 `submitMessage` async generator 流式产出 SDK 消息
- **文件状态缓存管理**：维护 `readFileState` 跨 turn 持久化
- **会话持久化**：自动记录 transcript，支持 resume
- **预算与轮次控制**：支持 `maxBudgetUsd`、`maxTurns`、结构化输出重试限制

## 关键流程

### submitMessage 主流程

`submitMessage` 是 `QueryEngine` 的核心方法，以 async generator 形式实现，每次调用代表对话中的一个新 turn。完整流程如下：

1. **初始化阶段**（`src/QueryEngine.ts:209-240`）
   - 从 config 解构所有配置项，清空 turn 级状态（`discoveredSkillNames`）
   - 设置工作目录，判断是否需要持久化会话

2. **权限包装**（`src/QueryEngine.ts:244-271`）
   - 将外部传入的 `canUseTool` 包装为 `wrappedCanUseTool`
   - 包装层拦截所有非 `allow` 的结果，记录到 `permissionDenials` 数组
   - 这些拒绝记录最终随 result 消息返回给 SDK 调用方

3. **模型与 thinking 配置**（`src/QueryEngine.ts:274-282`）
   - 优先使用 `userSpecifiedModel`，否则调用 `getMainLoopModel()` 获取默认模型
   - thinking 配置：外部传入优先 → 检查 `shouldEnableThinkingByDefault()` → 默认 `adaptive` 或 `disabled`

4. **系统提示词组装**（`src/QueryEngine.ts:284-325`）
   - 调用 `fetchSystemPromptParts()` 获取默认提示词、用户上下文、系统上下文
   - 合并 coordinator 模式上下文
   - 当自定义提示词 + `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` 环境变量同时存在时，注入记忆机制提示
   - 最终通过 `asSystemPrompt()` 拼接所有部分

5. **用户输入处理**（`src/QueryEngine.ts:410-428`）
   - 调用 `processUserInput()` 解析用户输入（支持字符串和 `ContentBlockParam[]`）
   - 处理 slash 命令，返回是否需要查询模型（`shouldQuery`）、允许的工具列表、可能修改后的模型

6. **Transcript 持久化**（`src/QueryEngine.ts:450-463`）
   - 在进入查询循环前持久化用户消息，确保即使进程被杀也能 resume
   - bare 模式下 fire-and-forget，正常模式下 await

7. **技能与插件加载**（`src/QueryEngine.ts:529-538`）
   - 并行加载 slash command 技能和缓存中的插件

8. **系统初始化消息**（`src/QueryEngine.ts:540-551`）
   - 产出 `buildSystemInitMessage`，包含工具列表、MCP 客户端、模型、权限模式等元信息

9. **查询循环**（`src/QueryEngine.ts:675-1049`）
   - 调用 `query()` 进入核心消息循环，通过 `for await...of` 逐条处理产出的消息
   - 按消息类型分发处理（详见下方消息处理小节）

10. **结果产出**（`src/QueryEngine.ts:1058-1155`）
    - 查询循环结束后，查找最后一条 assistant/user 消息
    - 通过 `isResultSuccessful()` 判断是否成功
    - 产出最终的 `result` 消息（success 或 error_during_execution）

### 消息分发处理

查询循环中，`switch (message.type)` 对不同类型消息的处理（`src/QueryEngine.ts:757-968`）：

| 消息类型 | 处理逻辑 |
|---------|---------|
| `assistant` | 记录 stop_reason，推入 mutableMessages，yield 归一化消息 |
| `progress` | 推入 mutableMessages，内联持久化，yield 归一化消息 |
| `user` | 推入 mutableMessages，递增 turnCount，yield 归一化消息 |
| `stream_event` | 跟踪 usage（message_start/delta/stop），可选 yield 原始事件 |
| `attachment` | 提取结构化输出、处理 max_turns_reached、转发 queued_command |
| `system` | 处理 snip 边界（内存回收）、compact 边界、API 错误重试 |
| `tombstone` | 忽略（控制信号） |
| `tool_use_summary` | 直接转发给 SDK |

### 三级终止条件

查询循环中有三个提前退出的检查点：

1. **最大轮次**（`attachment.type === 'max_turns_reached'`）→ 产出 `error_max_turns`
2. **预算超限**（`getTotalCost() >= maxBudgetUsd`）→ 产出 `error_max_budget_usd`（`src/QueryEngine.ts:972-1002`）
3. **结构化输出重试超限**（默认 5 次）→ 产出 `error_max_structured_output_retries`（`src/QueryEngine.ts:1004-1048`）

## 函数签名与参数说明

### `class QueryEngine`

#### `constructor(config: QueryEngineConfig)`

创建一个新的会话引擎实例。

#### `submitMessage(prompt, options?): AsyncGenerator<SDKMessage>`

发起一轮对话。这是 `QueryEngine` 的核心 API。

- **prompt**: `string | ContentBlockParam[]` — 用户输入，支持纯文本或结构化内容块
- **options.uuid**: `string` — 可选的消息 UUID
- **options.isMeta**: `boolean` — 是否为元消息（如系统注入的 caveat）
- **返回值**: 异步生成器，逐条产出 `SDKMessage`（包含 assistant、user、system、result 等类型）

#### `interrupt(): void`

中止当前查询，调用内部 `abortController.abort()`（`src/QueryEngine.ts:1158-1160`）。

#### `getMessages(): readonly Message[]`

返回当前会话的完整消息列表（只读视图）。

#### `getReadFileState(): FileStateCache`

返回文件状态缓存，用于跨 turn 或跨引擎的状态传递。

#### `getSessionId(): string`

返回当前会话 ID。

#### `setModel(model: string): void`

动态修改模型，影响下一次 `submitMessage` 调用。

## 接口/类型定义

### `QueryEngineConfig`

`QueryEngine` 的构造参数类型（`src/QueryEngine.ts:130-173`），关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `cwd` | `string` | 工作目录 |
| `tools` | `Tools` | 可用工具列表 |
| `commands` | `Command[]` | 已注册的 slash 命令 |
| `mcpClients` | `MCPServerConnection[]` | MCP 服务器连接 |
| `agents` | `AgentDefinition[]` | Agent 定义列表 |
| `canUseTool` | `CanUseToolFn` | 工具权限判定函数 |
| `getAppState` / `setAppState` | 函数 | 应用状态读写器 |
| `initialMessages` | `Message[]` | 初始消息（resume 场景） |
| `readFileCache` | `FileStateCache` | 文件状态缓存 |
| `customSystemPrompt` | `string` | 替换默认系统提示词 |
| `appendSystemPrompt` | `string` | 追加到系统提示词末尾 |
| `userSpecifiedModel` | `string` | 用户指定模型 |
| `fallbackModel` | `string` | 后备模型 |
| `thinkingConfig` | `ThinkingConfig` | thinking 模式配置 |
| `maxTurns` | `number` | 最大轮次限制 |
| `maxBudgetUsd` | `number` | 最大花费限制（美元） |
| `taskBudget` | `{ total: number }` | 任务预算 |
| `jsonSchema` | `Record<string, unknown>` | 结构化输出 JSON Schema |
| `replayUserMessages` | `boolean` | 是否回放用户消息 |
| `includePartialMessages` | `boolean` | 是否产出流式事件 |
| `snipReplay` | 函数 | Snip 边界处理回调（feature-gated） |

### `ask()` 便捷函数

`ask()` 是 `QueryEngine` 的单次调用便捷包装器（`src/QueryEngine.ts:1186-1295`），适用于一次性（one-shot）场景。它：

1. 创建 `QueryEngine` 实例
2. 调用 `submitMessage()` 并透传所有产出
3. 在 `finally` 块中将文件缓存状态写回调用方

当启用了 `HISTORY_SNIP` feature flag 时，`ask()` 会注入 `snipReplay` 回调，将 feature-gated 的字符串和逻辑隔离在 gated 模块中。

## 内部状态管理

`QueryEngine` 维护以下跨 turn 持久化的状态：

- **`mutableMessages`**: 完整消息历史，是 query 循环的数据源
- **`totalUsage`**: 累积的 API 用量（input/output tokens）
- **`permissionDenials`**: 所有被拒绝的工具使用记录
- **`readFileState`**: 文件读取缓存，避免重复读取
- **`discoveredSkillNames`**: turn 级技能发现追踪（每个 turn 开始时清空）
- **`loadedNestedMemoryPaths`**: 已加载的嵌套记忆路径（跨 turn 持久）
- **`hasHandledOrphanedPermission`**: 确保 orphaned permission 只处理一次

## 配置项与默认值

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `verbose` | `false` | 是否开启详细输出 |
| `replayUserMessages` | `false` | 是否回放用户消息给 SDK |
| `includePartialMessages` | `false` | 是否产出 `stream_event` |
| `thinkingConfig` | `{ type: 'adaptive' }` 或 `{ type: 'disabled' }` | 取决于 `shouldEnableThinkingByDefault()` |
| `MAX_STRUCTURED_OUTPUT_RETRIES` | `5` | 通过环境变量 `MAX_STRUCTURED_OUTPUT_RETRIES` 控制 |
| 会话持久化 | 启用 | 除非 `isSessionPersistenceDisabled()` 返回 true |
| bare 模式 transcript | fire-and-forget | `isBareMode()` 为 true 时不阻塞 |

## 边界 Case 与注意事项

- **Compact 边界内存回收**：当收到 compact_boundary 消息时，`mutableMessages` 和 `messages` 都会执行 `splice(0, boundaryIdx)` 释放旧消息，防止长会话内存泄漏（`src/QueryEngine.ts:926-933`）
- **Snip 边界处理**：通过注入的 `snipReplay` 回调处理，确保 feature-gated 字符串不出现在 QueryEngine 源码中。如果不处理 snip 标记，它们会在每个 turn 重复触发并导致 `mutableMessages` 无限增长（`src/QueryEngine.ts:905-914`）
- **Transcript 时序问题**：用户消息在进入查询循环前就持久化，确保进程被杀时也能 resume。assistant 消息采用 fire-and-forget 写入避免阻塞生成器（`src/QueryEngine.ts:727-728`）
- **stop_reason 捕获**：assistant 消息在 `content_block_stop` 时 `stop_reason` 为 null，真正的值通过 `message_delta` 事件到达（`src/QueryEngine.ts:797-808`）
- **错误日志水印**：error_during_execution 的 `errors[]` 通过引用水印（而非索引）实现 turn 级作用域，避免环形缓冲区 shift 导致索引偏移（`src/QueryEngine.ts:666-669`）
- **processUserInputContext 重建**：在 slash 命令处理后会重建 `processUserInputContext`（`src/QueryEngine.ts:492-527`），以反映可能被 slash 命令修改的消息和模型
- **Orphaned permission 仅处理一次**：通过 `hasHandledOrphanedPermission` 标志确保多 turn 场景不重复处理（`src/QueryEngine.ts:398-408`）