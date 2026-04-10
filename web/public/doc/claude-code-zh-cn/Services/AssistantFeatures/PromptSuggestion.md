# 提示建议与推测执行系统（PromptSuggestion）

## 概述与职责

PromptSuggestion 模块是 Claude Code 的智能交互加速子系统，位于 `Services > AssistantFeatures` 层级下，与语音输入、魔法文档、使用提示等辅助功能并列。该模块包含两个紧密协作的核心文件：

- **promptSuggestion.ts**（~520 行）：在用户空闲时，通过 `forkedAgent` 机制预测用户下一步可能输入的指令，并在 UI 中展示建议
- **speculation.ts**（~990 行）：在建议生成后，进一步启动推测执行引擎——在后台预先执行工具调用，用户确认建议后直接采纳已完成的结果，大幅减少等待时间

两者构成一条完整的流水线：**建议生成 → 推测执行 → 用户确认 → 结果注入**，并支持流水线式递归（完成一轮推测后自动生成下一轮建议并继续推测）。

## 关键流程

### 1. 建议生成流程（promptSuggestion.ts）

整个建议生成由 `executePromptSuggestion()` 驱动，作为 REPL 主循环的 post-sampling hook 执行：

1. **准入检查**：`shouldEnablePromptSuggestion()` 按优先级依次检查：
   - 环境变量 `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` 强制覆盖（`src/services/PromptSuggestion/promptSuggestion.ts:39-55`）
   - Growthbook 特性门控 `tengu_chomp_inflection`（`promptSuggestion.ts:58`）
   - 非交互模式（print mode、SDK、管道输入）禁用
   - Swarm 协作模式下仅 leader 启用
   - 用户设置 `promptSuggestionEnabled`

2. **抑制检查**：`tryGenerateSuggestion()` 执行多层前置过滤（`promptSuggestion.ts:125-182`）：
   - 对话轮次 < 2 时跳过（避免对话初期无意义建议）
   - 最后一条助手消息是 API 错误时跳过
   - **缓存冷启动保护**：`getParentCacheSuppressReason()` 检查父请求的 token 使用量——如果 `inputTokens + cacheWriteTokens + outputTokens > 10,000`，说明缓存尚未预热，fork 请求将承担高额重复计算成本，因此跳过（`promptSuggestion.ts:239-256`）
   - 运行时状态检查：权限弹窗待确认、elicitation 队列非空、计划模式、速率限制

3. **调用 forkedAgent 生成建议**：`generateSuggestion()` 使用 `runForkedAgent` 发起一次轻量级 API 调用（`promptSuggestion.ts:294-352`）：
   - 复用父请求的缓存参数（`cacheSafeParams`），确保 prompt cache 命中
   - 通过 `canUseTool` 回调拒绝所有工具调用（不需要工具，只需文本输出）
   - 跳过 transcript 记录和缓存写入
   - **关键约束**：不覆盖任何 API 参数（如 effort、maxOutputTokens），因为改变这些会破坏缓存命中率——PR #18143 的教训显示 effort:'low' 导致缓存写入量暴增 45 倍

4. **建议过滤**：`shouldFilterSuggestion()` 对模型输出执行 12 条过滤规则（`promptSuggestion.ts:354-456`）：
   - 过滤 "done"、元文本（"nothing to suggest"、"silence"）、括号包裹的元推理
   - 过滤错误消息、带标签前缀的输出
   - 字数限制：1 词（有白名单例外：yes/no/push/commit 等）到 12 词
   - 长度限制：< 100 字符，不允许多句、不允许格式化标记
   - 过滤评价性语言（"thanks"、"looks good"）和 Claude 口吻（"Let me..."、"I'll..."）

5. **更新 UI 状态**：通过 `setAppState` 将建议写入 `promptSuggestion` 状态，UI 层据此展示建议文本

### 2. 推测执行流程（speculation.ts）

当建议生成成功且推测功能已启用时，`startSpeculation()` 启动后台推测执行（`speculation.ts:402-715`）：

1. **初始化**：
   - 终止任何已有推测（`abortSpeculation()`）
   - 创建唯一 ID、子 AbortController、overlay 目录
   - 设置 AppState 中的推测状态为 `active`

2. **启动 forkedAgent**：以用户建议文本作为输入消息，调用 `runForkedAgent` 开始执行：

3. **工具权限网关**（`canUseTool` 回调，`speculation.ts:461-632`）——推测执行的核心安全层：

   | 工具类型 | 处理策略 |
   |---------|---------|
   | **写入工具**（Edit/Write/NotebookEdit） | 检查权限模式，仅 `acceptEdits`/`bypassPermissions` 模式下允许；写入操作重定向到 overlay 目录 |
   | **安全只读工具**（Read/Glob/Grep/ToolSearch/LSP/TaskGet/TaskList） | 允许执行；若文件已在 overlay 中修改过则重定向读取路径 |
   | **Bash** | 仅允许只读命令（通过 `checkReadOnlyConstraints` 验证） |
   | **其他工具** | 一律拒绝并设置 boundary |

4. **Overlay 文件系统隔离**（Copy-on-Write 策略）：
   - overlay 目录位于 `$CLAUDE_TEMP_DIR/speculation/<pid>/<id>/`
   - 首次写入某文件时，先将原始文件复制到 overlay，再将写入重定向到 overlay 中的副本
   - 后续读取该文件时自动重定向到 overlay 版本
   - cwd 之外的写入一律拒绝

5. **Boundary 机制**：当推测执行遇到无法安全预执行的操作时，设置 boundary 并中止：
   - `bash`：遇到非只读 bash 命令
   - `edit`：权限模式不允许自动接受编辑
   - `denied_tool`：遇到不在白名单中的工具
   - `complete`：所有操作正常完成

6. **消息追踪**：通过 `onMessage` 回调实时收集推测过程中的所有消息，限制最大 20 轮 / 100 条消息

### 3. 用户确认与结果注入流程

当用户接受建议（输入与建议完全匹配）时，`handleSpeculationAccept()` 执行结果注入（`speculation.ts:835-991`）：

1. 清除 promptSuggestion UI 状态
2. 立即注入用户消息到对话中（提供即时视觉反馈）
3. 调用 `acceptSpeculation()` 完成核心采纳逻辑：
   - 将 overlay 中的文件写回主目录（`copyOverlayToMain()`）
   - 清理 overlay 目录
   - 计算节省时间（从推测开始到 boundary 完成的耗时）
   - 累加到 session 级别的时间节省统计
4. `prepareMessagesForInjection()` 清洗推测消息（`speculation.ts:203-271`）：
   - 移除 thinking/redacted_thinking 块
   - 移除没有成功结果的 tool_use 块及其对应的 tool_result
   - 移除中断消息
   - 过滤空白内容
5. 注入清洗后的消息到对话历史
6. 合并推测过程中读取的文件状态缓存
7. 生成反馈消息（仅对内部用户 `USER_TYPE=ant` 显示）

### 4. 流水线式递归推测

推测完成后自动触发下一轮（`speculation.ts:672-679`）：

1. 推测执行正常完成（boundary.type === 'complete'）时，`generatePipelinedSuggestion()` 以推测后的扩展对话上下文生成下一条建议
2. 生成的建议存储在 `pipelinedSuggestion` 状态字段中
3. 用户确认当前建议时，如果推测已完成且存在 pipelined suggestion，则立即提升为当前建议并启动新一轮推测（`speculation.ts:929-956`）

这样实现了"推测→建议→推测→建议"的连锁执行，理论上可以在用户不输入的情况下预执行多步操作。

## 函数签名与参数说明

### promptSuggestion.ts

#### `shouldEnablePromptSuggestion(): boolean`
判断是否启用提示建议功能，综合环境变量、特性门控、交互模式和用户设置。

#### `executePromptSuggestion(context: REPLHookContext): Promise<void>`
主入口函数，作为 REPL 的 post-sampling hook 被调用。仅处理 `repl_main_thread` 来源的请求。

#### `tryGenerateSuggestion(abortController, messages, getAppState, cacheSafeParams, source?): Promise<{suggestion, promptId, generationRequestId} | null>`
共享的建议生成逻辑，被 CLI TUI 和 SDK push 两条路径复用。返回 null 表示被抑制或过滤。

#### `generateSuggestion(abortController, promptId, cacheSafeParams): Promise<{suggestion: string | null, generationRequestId: string | null}>`
调用 forkedAgent 实际生成建议文本。从结果消息中提取第一个非空文本块作为建议。

#### `shouldFilterSuggestion(suggestion, promptId, source?): boolean`
对生成的建议执行 12 条质量过滤规则，返回 true 表示应过滤掉。

#### `getSuggestionSuppressReason(appState: AppState): string | null`
运行时状态检查，返回抑制原因或 null（允许生成）。

#### `logSuggestionOutcome(suggestion, userInput, emittedAt, promptId, generationRequestId): void`
记录建议的接受/忽略结果，用于 SDK push 路径的 outcome 追踪。

### speculation.ts

#### `isSpeculationEnabled(): boolean`
检查推测功能是否启用：需要 `USER_TYPE=ant` 且全局配置 `speculationEnabled` 为 true（默认 true）。

#### `startSpeculation(suggestionText, context, setAppState, isPipelined?, cacheSafeParams?): Promise<void>`
启动推测执行。创建 overlay 目录，运行 forkedAgent，通过 `canUseTool` 回调控制工具权限和文件隔离。

- **suggestionText**：预测的用户输入文本
- **isPipelined**：是否为流水线递归推测（默认 false）

#### `acceptSpeculation(state, setAppState, cleanMessageCount): Promise<SpeculationResult | null>`
采纳推测结果。将 overlay 文件复制回主目录，计算节省时间，返回推测消息和 boundary 信息。

#### `handleSpeculationAccept(speculationState, speculationSessionTimeSavedMs, setAppState, input, deps): Promise<{queryRequired: boolean}>`
完整的建议接受处理流程，包含消息清洗、注入、文件状态合并和流水线推测提升。返回 `queryRequired: true` 表示推测未完成，需要继续发起正常查询。

#### `abortSpeculation(setAppState): void`
中止当前活跃的推测执行，清理 overlay 目录，重置状态。

#### `prepareMessagesForInjection(messages: Message[]): Message[]`
清洗推测消息用于注入到主对话——移除 thinking 块、失败的工具调用、中断消息等。

## 类型定义

### `PromptVariant`
```typescript
type PromptVariant = 'user_intent' | 'stated_intent'
```
建议 prompt 的变体标识。当前 `getPromptVariant()` 固定返回 `'user_intent'`。

### `ActiveSpeculationState`
从 `SpeculationState` 联合类型中提取 `status: 'active'` 的分支，包含：
- `id`: 8 字符的 UUID 前缀
- `abort()`: 中止回调
- `startTime`: 开始时间戳
- `messagesRef`: 推测消息的可变引用
- `writtenPathsRef`: overlay 中已写入文件路径的可变引用
- `boundary`: 完成边界信息（null 表示仍在执行）
- `toolUseCount`: 已执行的工具调用数
- `isPipelined`: 是否流水线推测
- `contextRef`: REPLHookContext 的可变引用
- `pipelinedSuggestion?`: 下一轮流水线建议

### `CompletionBoundary`
推测执行的终止边界，四种类型：
- `{ type: 'bash', command, completedAt }` — 遇到非只读 bash 命令
- `{ type: 'edit', toolName, filePath, completedAt }` — 遇到需要权限的文件编辑
- `{ type: 'denied_tool', toolName, detail, completedAt }` — 遇到不允许的工具
- `{ type: 'complete', completedAt, outputTokens }` — 正常完成

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | 环境变量 | — | 强制启用/禁用建议功能，覆盖所有其他条件 |
| `tengu_chomp_inflection` | Growthbook 特性门控 | `false` | 控制建议功能的灰度发布 |
| `promptSuggestionEnabled` | 用户设置 | `true`（`!== false`） | 用户级开关 |
| `USER_TYPE` | 环境变量 | — | 值为 `'ant'` 时启用推测执行和详细日志 |
| `speculationEnabled` | 全局配置 | `true` | 推测执行开关 |
| `MAX_PARENT_UNCACHED_TOKENS` | 硬编码常量 | `10,000` | 父请求 token 超过此值时跳过建议生成（缓存保护） |
| `MAX_SPECULATION_TURNS` | 硬编码常量 | `20` | 推测执行最大轮次 |
| `MAX_SPECULATION_MESSAGES` | 硬编码常量 | `100` | 推测执行最大消息数 |

## 边界 Case 与注意事项

- **缓存命中率至关重要**：建议生成通过 forkedAgent 寄生于主请求的 prompt cache。任何偏离主请求缓存键的参数变更都会导致缓存失效。代码中有明确注释引用了 PR #18143 的教训（缓存命中率从 92.7% 跌至 61%）

- **推测执行仅限内部用户**：`isSpeculationEnabled()` 要求 `USER_TYPE === 'ant'`，说明推测执行目前仍处于内测阶段

- **Fail-open 设计**：`handleSpeculationAccept()` 的 catch 块返回 `{ queryRequired: true }`，即任何推测错误都回退到正常查询流程，不会阻塞用户操作

- **Overlay 清理**：overlay 目录使用 `rm -rf` 异步清理（`safeRemoveOverlay`），失败时静默忽略。进程 PID 作为路径组成部分防止跨进程冲突

- **cwd 外写入保护**：推测执行严格禁止写入工作目录之外的路径，读取则允许（如系统库文件）

- **流水线建议的提升条件**：仅当推测完全完成（`boundary.type === 'complete'`）且存在 pipelined suggestion 时才会提升，避免在推测中途就推进下一轮

- **消息注入兼容性**：当推测未完成时，`handleSpeculationAccept` 会截断尾部的 assistant 消息，因为部分模型不支持 prefill（对话以 assistant 消息结尾）

- **建议 Prompt 的 "user_intent" 策略**：Prompt 要求模型预测用户自然会输入的内容（"Would they think 'I was just about to type that'?"），而非模型认为用户应该做的事。这是一个重要的设计区分——建议应该像读心术而非指导建议

- **遥测事件命名空间**：所有事件以 `tengu_` 为前缀（`tengu_prompt_suggestion`、`tengu_speculation`），其中 tengu 是该特性的内部代号

## 关键代码片段

### 建议生成的缓存保护策略

```typescript
// src/services/PromptSuggestion/promptSuggestion.ts:308-330
// DO NOT override any API parameter that differs from the parent request.
// The fork piggybacks on the main thread's prompt cache by sending identical
// cache-key params. PR #18143 tried effort:'low' and caused a 45x spike in cache
// writes (92.7% → 61% hit rate). The only safe overrides are:
//   - abortController (not sent to API)
//   - skipTranscript (client-side only)
//   - skipCacheWrite (controls cache_control markers, not the cache key)
//   - canUseTool (client-side permission check)
const result = await runForkedAgent({
  promptMessages: [createUserMessage({ content: prompt })],
  cacheSafeParams,
  canUseTool,
  querySource: 'prompt_suggestion',
  forkLabel: 'prompt_suggestion',
  overrides: { abortController },
  skipTranscript: true,
  skipCacheWrite: true,
})
```

### 推测执行的 Copy-on-Write 文件隔离

```typescript
// src/services/PromptSuggestion/speculation.ts:528-547
if (isWriteTool) {
  // Copy-on-write: copy original to overlay if not yet there
  if (!writtenPathsRef.current.has(rel)) {
    const overlayFile = join(overlayPath, rel)
    await mkdir(dirname(overlayFile), { recursive: true })
    try {
      await copyFile(join(cwd, rel), overlayFile)
    } catch {
      // Original may not exist (new file creation) - that's fine
    }
    writtenPathsRef.current.add(rel)
  }
  input = { ...input, [pathKey]: join(overlayPath, rel) }
} else {
  // Read: redirect to overlay if file was previously written
  if (writtenPathsRef.current.has(rel)) {
    input = { ...input, [pathKey]: join(overlayPath, rel) }
  }
}
```