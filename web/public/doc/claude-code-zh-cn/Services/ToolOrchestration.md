# 工具执行编排服务（ToolOrchestration）

## 概述与职责

工具执行编排服务是 **Services 层**中连接 ToolSystem 与底层服务的桥梁层，负责管理模型产出的工具调用（tool_use blocks）从接收到执行完毕的完整生命周期。该模块解决的核心问题是：**如何安全、高效、有序地执行模型请求的多个工具调用，同时正确处理权限校验、前置/后置钩子、并发控制和错误传播。**

在整体架构中，CoreEngine（查询引擎）将模型返回的 `ToolUseBlock[]` 交给本模块，本模块编排执行后将结果（`MessageUpdate`）回传给引擎，引擎再将结果拼入对话消息流。

模块由 4 个文件组成：
- `toolOrchestration.ts` — 批次编排器：将工具调用分区为并发/串行批次
- `StreamingToolExecutor.ts` — 流式编排器：在工具调用流式到达时即时调度执行
- `toolExecution.ts` — 单次工具执行的完整流程（校验→权限→钩子→调用→结果处理）
- `toolHooks.ts` — 前置/后置钩子的执行逻辑与权限决策解析

## 关键流程

### 流程一：批次编排（toolOrchestration.ts）

这是非流式场景下的主入口，核心函数是 `runTools()`。

1. **分区（Partition）**：`partitionToolCalls()` 将一组 `ToolUseBlock[]` 分成多个批次（`Batch[]`）。分区规则是：连续的"并发安全"工具归为一批，单个"非并发安全"工具独占一批（`toolOrchestration.ts:91-116`）

2. **判断并发安全性**：对每个工具调用，先用 Zod schema 校验输入，再调用工具定义上的 `isConcurrencySafe(parsedInput)` 方法判断。如果校验失败或方法抛异常，保守地视为不可并发（`toolOrchestration.ts:96-108`）

3. **并发执行**：并发安全批次调用 `runToolsConcurrently()`，通过 `all()` 工具函数（来自 `utils/generators.js`）并发执行多个 async generator，并发上限由环境变量 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 控制，默认 10（`toolOrchestration.ts:8-12`）。并发执行时，上下文修改器（`contextModifier`）被暂存，在整批完成后按工具原始顺序依次应用

4. **串行执行**：非并发安全批次调用 `runToolsSerially()`，逐个执行并立即应用上下文修改器

5. 每个工具执行前后都会更新 `inProgressToolUseIDs` 状态集合，用于 UI 进度展示

### 流程二：流式编排（StreamingToolExecutor）

这是流式场景下的编排器。与批次编排不同，它不需要等所有工具调用到齐后再分区，而是在工具调用从 API 响应流中逐个到达时即时开始调度。

1. **接收工具**：`addTool(block, assistantMessage)` 被调用时，立即判断该工具的并发安全性，加入内部队列并尝试执行（`StreamingToolExecutor.ts:76-124`）

2. **并发控制**：`canExecuteTool()` 检查当前执行状态——仅当没有工具在执行、或者新工具和所有正在执行的工具都是并发安全的，才允许执行（`StreamingToolExecutor.ts:129-135`）

3. **结果缓冲与有序输出**：虽然工具可能并发完成，但结果通过 `getCompletedResults()` 按照工具**接收顺序**依次输出，保证消息流的确定性。进度消息（`progress` 类型）不受此限制，会立即输出（`StreamingToolExecutor.ts:412-440`）

4. **错误级联**：当一个 Bash 工具执行出错时，`siblingAbortController` 被 abort，所有并行运行的兄弟工具收到合成错误消息（`StreamingToolExecutor.ts:358-363`）。关键设计：**只有 Bash 错误会级联**，因为 Bash 命令之间常有隐式依赖链（如 `mkdir` 失败后续命令无意义），而 Read/WebFetch 等工具互相独立

5. **中断处理**：支持三种取消原因——`sibling_error`（兄弟工具出错）、`user_interrupted`（用户按 ESC）、`streaming_fallback`（流式回退时丢弃）。每种原因生成不同的合成错误消息（`StreamingToolExecutor.ts:153-205`）

6. **Discard 机制**：`discard()` 方法用于流式回退场景，标记所有待执行/执行中的工具为废弃状态（`StreamingToolExecutor.ts:69-71`）

### 流程三：单次工具执行（toolExecution.ts 的 runToolUse → checkPermissionsAndCallTool）

每个工具调用的完整执行管线：

1. **工具查找**：先在当前可用工具集中查找，若找不到再查找已废弃的别名映射（如 `KillShell` → `TaskStop`）（`toolExecution.ts:344-356`）

2. **输入校验**：分两步——先用 Zod schema 做类型校验（`safeParse`），再调用工具自定义的 `validateInput()` 做业务校验（`toolExecution.ts:615-733`）。对于延迟加载的工具（deferred tool），如果 schema 未被发送给 API，会追加提示让模型先调用 `ToolSearch` 加载 schema（`toolExecution.ts:578-597`）

3. **前置钩子（PreToolUse）**：执行用户配置的前置钩子，钩子可以返回权限决策（allow/deny/ask）、修改输入、阻止继续执行、或注入额外上下文

4. **权限决策**：`resolveHookPermissionDecision()` 将钩子的权限结果与系统权限规则合并。核心不变量：**钩子的 `allow` 不会绕过 settings.json 中的 deny/ask 规则**（`toolHooks.ts:332-433`）

5. **工具执行**：调用 `tool.call()` 执行实际操作，通过 `Stream` 将进度事件和最终结果合并为统一的异步可迭代流

6. **后置钩子（PostToolUse/PostToolUseFailure）**：成功时执行 `runPostToolUseHooks()`，可阻止后续调用或修改 MCP 工具的输出；失败时执行 `runPostToolUseFailureHooks()`

7. **遥测**：全流程关键节点都有 analytics 事件和 OTel span 追踪

## 函数签名与参数说明

### `runTools(toolUseMessages, assistantMessages, canUseTool, toolUseContext)`

批次编排主入口。返回 `AsyncGenerator<MessageUpdate>`。

| 参数 | 类型 | 说明 |
|------|------|------|
| `toolUseMessages` | `ToolUseBlock[]` | 模型产出的工具调用块列表 |
| `assistantMessages` | `AssistantMessage[]` | 对应的助手消息（用于关联工具调用与其所属消息） |
| `canUseTool` | `CanUseToolFn` | 权限检查回调，决定是否允许执行 |
| `toolUseContext` | `ToolUseContext` | 执行上下文，包含消息历史、选项、abort 控制器等 |

> 源码位置：`src/services/tools/toolOrchestration.ts:19-82`

### `StreamingToolExecutor` 类

流式场景的编排器，主要方法：

- **`addTool(block, assistantMessage)`**：添加工具到执行队列并立即尝试调度
- **`getCompletedResults()`**：非阻塞地获取已完成的结果（同步 Generator）
- **`getRemainingResults()`**：等待所有未完成工具并输出结果（异步 Generator）
- **`discard()`**：丢弃所有待执行和执行中的工具
- **`getUpdatedContext()`**：获取可能被上下文修改器更新过的 `ToolUseContext`

> 源码位置：`src/services/tools/StreamingToolExecutor.ts:40-519`

### `runToolUse(toolUse, assistantMessage, canUseTool, toolUseContext)`

单次工具执行的完整流程。返回 `AsyncGenerator<MessageUpdateLazy>`。

> 源码位置：`src/services/tools/toolExecution.ts:337-490`

### `resolveHookPermissionDecision(hookPermissionResult, tool, input, toolUseContext, canUseTool, assistantMessage, toolUseID)`

将前置钩子的权限结果解析为最终权限决策。核心语义：钩子 `allow` 不绕过 deny/ask 规则。

> 源码位置：`src/services/tools/toolHooks.ts:332-433`

### `runPreToolUseHooks(...)` / `runPostToolUseHooks(...)` / `runPostToolUseFailureHooks(...)`

三类生命周期钩子的执行器，均为异步 Generator。

> 源码位置：`src/services/tools/toolHooks.ts:435-650`（Pre）、`39-191`（Post）、`193-319`（PostFailure）

## 接口/类型定义

### `MessageUpdate`（toolOrchestration.ts）

```typescript
type MessageUpdate = {
  message?: Message
  newContext: ToolUseContext  // 始终携带最新上下文
}
```

### `MessageUpdateLazy`（toolExecution.ts）

```typescript
type MessageUpdateLazy<M extends Message = Message> = {
  message: M
  contextModifier?: {
    toolUseID: string
    modifyContext: (context: ToolUseContext) => ToolUseContext
  }
}
```

`MessageUpdate` 与 `MessageUpdateLazy` 的区别：前者立即应用上下文变更，后者延迟到调用方决定何时应用（用于并发场景中保证顺序）。

### `TrackedTool`（StreamingToolExecutor 内部）

追踪每个工具的执行状态，状态机为：`queued` → `executing` → `completed` → `yielded`。

### `McpServerType`

```typescript
type McpServerType = 'stdio' | 'sse' | 'http' | 'ws' | 'sdk' | 'sse-ide' | 'ws-ide' | 'claudeai-proxy' | undefined
```

MCP 服务器的传输类型，用于遥测区分。

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | 环境变量 | `10` | 并发执行工具的最大数量 |
| `HOOK_TIMING_DISPLAY_THRESHOLD_MS` | 常量 | `500` | 钩子执行时间超过此值时显示耗时摘要 |
| `SLOW_PHASE_LOG_THRESHOLD_MS` | 常量 | `2000` | 钩子/权限决策超过此值时记录调试警告 |

## 边界 Case 与注意事项

- **并发安全判断可能抛异常**：`isConcurrencySafe()` 可能因为 shell-quote 解析失败而抛异常（例如 Bash 命令包含特殊字符），此时保守地视为不可并发（`toolOrchestration.ts:100-107`）

- **上下文修改器在并发场景下的限制**：`StreamingToolExecutor` 中并发工具的上下文修改器当前不被支持（有注释说明），仅非并发工具会应用上下文修改（`StreamingToolExecutor.ts:389-395`）

- **Bash 错误级联只针对 Bash 工具**：只有 `BASH_TOOL_NAME` 类型的工具错误会触发 `siblingAbortController.abort()`，其他工具的错误不会取消兄弟工具（`StreamingToolExecutor.ts:358-363`）

- **权限 abort 需要冒泡**：per-tool 的 abort controller 是 `siblingAbortController` 的子控制器，当权限对话框被取消时，abort 必须冒泡到父级查询控制器，否则会导致 ExitPlanMode 等场景的回归（#21056）（`StreamingToolExecutor.ts:297-318`）

- **钩子 allow 不绕过 deny 规则**：这是一个关键安全不变量。即使 PreToolUse 钩子返回 `allow`，`checkRuleBasedPermissions` 仍然会检查 settings.json 中的 deny/ask 规则（`toolHooks.ts:372-405`）

- **MCP 工具的特殊处理**：MCP 工具的后置钩子可以通过 `updatedMCPToolOutput` 修改工具输出，且 MCP 工具的结果添加顺序与内置工具不同——MCP 工具在后置钩子执行完毕后才调用 `addToolResult`（`toolExecution.ts:1477-1542`）

- **废弃工具的别名兼容**：当模型使用已废弃的工具名（如 `KillShell`）时，会通过 `aliases` 查找映射到新工具名（`toolExecution.ts:349-356`）

- **延迟加载工具的 schema 缺失处理**：如果工具是延迟加载的但 schema 未被发送给 API，Zod 校验会失败。此时会追加提示让模型先调用 `ToolSearch` 加载 schema（`toolExecution.ts:578-597`）

- **`_simulatedSedEdit` 字段的防御性剥离**：该字段仅允许由权限系统注入，如果模型在输入中提供了此字段，会在执行前被强制移除（`toolExecution.ts:756-773`）