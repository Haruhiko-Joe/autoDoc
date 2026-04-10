# MemoryServices — 会话记忆与知识提取服务

## 概述与职责

MemoryServices 是 Claude Code **Services 层**的组成部分，负责两个相互配合的后台记忆能力：

1. **SessionMemory**（`src/services/SessionMemory/`）：在会话进行过程中，周期性地将对话内容提取为结构化的"会话笔记"文件，用于上下文压缩（compact）后恢复关键信息。
2. **extractMemories**（`src/services/extractMemories/`）：在每轮查询结束时，自动从对话中识别值得持久化的记忆（用户偏好、项目上下文、反馈等），写入 `~/.claude/projects/<path>/memory/` 目录，实现跨会话的上下文保持。

两者都采用 **forked agent 模式** —— 从主对话完美分叉，共享 prompt 缓存，在后台独立运行，不中断主对话流。它们与上层的 MemorySystem（`memdir/`）协作，共同构成 Claude Code 的完整记忆体系。

---

## 关键流程

### SessionMemory 提取流程

SessionMemory 通过 **post-sampling hook** 在每次模型采样后自动触发：

1. **初始化注册**：`initSessionMemory()` 在启动时调用，将 `extractSessionMemory` 注册为 post-sampling hook（`src/services/SessionMemory/sessionMemory.ts:357-375`）。前提条件：非远程模式且 auto-compact 已启用。

2. **门控检查**：hook 触发时，依次检查：
   - 仅在 `repl_main_thread`（主 REPL 线程）中运行，跳过子 Agent
   - 通过 GrowthBook 特性开关 `tengu_session_memory` 判断功能是否启用
   - 惰性加载远程配置（`tengu_sm_config`），仅执行一次

3. **阈值判断**（`shouldExtractMemory`，`src/services/SessionMemory/sessionMemory.ts:134-181`）：
   - **初始化阈值**：上下文窗口 token 数需达到 `minimumMessageTokensToInit`（默认 10,000）
   - **更新阈值**：自上次提取以来的 token 增长需达到 `minimumTokensBetweenUpdate`（默认 5,000）
   - **工具调用阈值**：自上次提取以来的工具调用数需达到 `toolCallsBetweenUpdates`（默认 3）
   - 触发条件：token 阈值满足 **且**（工具调用阈值满足 **或** 最后一个 assistant 轮次无工具调用）

4. **文件准备**：`setupSessionMemoryFile` 在 `~/.claude/session-memory/` 下创建笔记文件（权限 `0o600`），首次创建时写入模板内容。支持自定义模板（`~/.claude/session-memory/config/template.md`）。

5. **分叉执行**：调用 `runForkedAgent` 启动独立子 Agent，仅允许对指定笔记文件进行 Edit 操作，通过 `createMemoryFileCanUseTool` 严格限制工具权限（`src/services/SessionMemory/sessionMemory.ts:460-482`）。

6. **并发控制**：通过 `sequential()` 包装器确保同一时间只有一个提取任务运行。

### extractMemories 提取流程

extractMemories 在每轮查询循环结束时（stop hooks）触发：

1. **初始化**：`initExtractMemories()` 创建一个闭包，封装所有可变状态（游标位置、重叠保护、待处理上下文等）（`src/services/extractMemories/extractMemories.ts:296-587`）。

2. **前置检查**（`executeExtractMemoriesImpl`，第 527-567 行）：
   - 仅在主 Agent 中运行（`agentId` 为空）
   - 通过 GrowthBook 开关 `tengu_passport_quail` 判断功能启用
   - 确认 auto-memory 启用且非远程模式

3. **互斥机制**：如果主 Agent 已经在当前轮次直接写入了记忆文件（通过 `hasMemoryWritesSince` 检测），则跳过本次提取，仅推进游标（`src/services/extractMemories/extractMemories.ts:348-360`）。

4. **节流控制**：通过 `tengu_bramble_lintel` 配置项控制每 N 个合格轮次才触发一次提取（默认每轮都触发）。

5. **记忆扫描**：调用 `scanMemoryFiles` 预扫描现有记忆目录，将清单注入提取 prompt，避免子 Agent 浪费轮次查看目录。

6. **分叉执行**：通过 `runForkedAgent` 启动子 Agent，最多 5 个轮次。工具权限由 `createAutoMemCanUseTool` 控制，允许：
   - 读取类工具无限制（Read、Grep、Glob）
   - Bash 仅允许只读命令
   - Edit/Write 仅限 auto-memory 目录内的路径

7. **合并/拖尾机制**：如果提取进行中有新请求到来，会暂存最新上下文，待当前提取完成后执行一次拖尾提取（`src/services/extractMemories/extractMemories.ts:510-521`）。

8. **结果通知**：提取完成后，通过 `appendSystemMessage` 向主对话注入"记忆已保存"的系统消息。

---

## 函数签名与参数说明

### SessionMemory 核心 API

#### `initSessionMemory(): void`

初始化会话记忆系统，注册 post-sampling hook。同步执行，避免启动时竞争条件。

> 源码位置：`src/services/SessionMemory/sessionMemory.ts:357-375`

#### `shouldExtractMemory(messages: Message[]): boolean`

判断当前是否应触发记忆提取。综合考虑初始化阈值、token 增长阈值和工具调用阈值。

> 源码位置：`src/services/SessionMemory/sessionMemory.ts:134-181`

#### `manuallyExtractSessionMemory(messages: Message[], toolUseContext: ToolUseContext): Promise<ManualExtractionResult>`

手动触发会话记忆提取（绕过阈值检查），由 `/summary` 命令调用。返回 `{ success, memoryPath?, error? }`。

> 源码位置：`src/services/SessionMemory/sessionMemory.ts:387-453`

#### `createMemoryFileCanUseTool(memoryPath: string): CanUseToolFn`

创建权限函数，仅允许对指定记忆文件执行 FileEdit 操作。

> 源码位置：`src/services/SessionMemory/sessionMemory.ts:460-482`

### extractMemories 核心 API

#### `initExtractMemories(): void`

初始化记忆提取系统，创建封装所有可变状态的闭包。每次调用会重置状态——测试中在 `beforeEach` 调用以获得干净环境。

> 源码位置：`src/services/extractMemories/extractMemories.ts:296-587`

#### `executeExtractMemories(context: REPLHookContext, appendSystemMessage?: AppendSystemMessageFn): Promise<void>`

在查询循环结束时执行记忆提取。以 fire-and-forget 方式从 `handleStopHooks` 调用。需先调用 `initExtractMemories()`。

> 源码位置：`src/services/extractMemories/extractMemories.ts:598-603`

#### `drainPendingExtraction(timeoutMs?: number): Promise<void>`

等待所有进行中的提取完成（含拖尾运行），带软超时（默认 60 秒）。在 `print.ts` 的响应刷新后、graceful shutdown 前调用，确保分叉 Agent 完成。

> 源码位置：`src/services/extractMemories/extractMemories.ts:611-615`

#### `createAutoMemCanUseTool(memoryDir: string): CanUseToolFn`

创建记忆提取子 Agent 的工具权限函数。允许 Read/Grep/Glob（无限制）、只读 Bash、以及仅限记忆目录内的 Edit/Write。也支持 REPL 工具（当 REPL 模式启用时）。

> 源码位置：`src/services/extractMemories/extractMemories.ts:171-222`

---

## 接口/类型定义

### `SessionMemoryConfig`

会话记忆提取阈值的配置类型（`src/services/SessionMemory/sessionMemoryUtils.ts:18-29`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `minimumMessageTokensToInit` | `number` | 10000 | 初始化会话记忆的最低上下文窗口 token 数 |
| `minimumTokensBetweenUpdate` | `number` | 5000 | 两次提取之间最低上下文增长 token 数 |
| `toolCallsBetweenUpdates` | `number` | 3 | 两次提取之间最低工具调用次数 |

### `ManualExtractionResult`

手动提取的返回类型（`src/services/SessionMemory/sessionMemory.ts:377-381`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | `boolean` | 是否成功 |
| `memoryPath` | `string?` | 成功时的记忆文件路径 |
| `error` | `string?` | 失败时的错误信息 |

---

## 配置项与默认值

### SessionMemory 远程配置

通过 GrowthBook 动态配置（可覆盖默认值，零值会被忽略）：

- **`tengu_session_memory`**（特性开关）：启用/禁用会话记忆功能
- **`tengu_sm_config`**（动态配置）：`SessionMemoryConfig` 的部分覆盖

### extractMemories 远程配置

- **`tengu_passport_quail`**（特性开关）：启用/禁用自动记忆提取
- **`tengu_bramble_lintel`**（特性开关，数值型）：每 N 个合格轮次触发一次提取，默认 1
- **`tengu_moth_copse`**（特性开关）：为 `true` 时跳过 MEMORY.md 索引文件的更新

### 自定义文件路径

- **模板文件**：`~/.claude/session-memory/config/template.md` — 自定义会话笔记模板
- **提示词文件**：`~/.claude/session-memory/config/prompt.md` — 自定义提取提示词，支持 `{{currentNotes}}`、`{{notesPath}}` 变量替换

### 硬编码常量

| 常量 | 值 | 位置 | 说明 |
|------|------|------|------|
| `MAX_SECTION_LENGTH` | 2000 tokens | `prompts.ts:8` | 笔记单节最大 token 数 |
| `MAX_TOTAL_SESSION_MEMORY_TOKENS` | 12000 tokens | `prompts.ts:9` | 笔记总最大 token 数 |
| `EXTRACTION_WAIT_TIMEOUT_MS` | 15000 ms | `sessionMemoryUtils.ts:12` | 等待提取完成的超时 |
| `EXTRACTION_STALE_THRESHOLD_MS` | 60000 ms | `sessionMemoryUtils.ts:13` | 提取被视为陈旧的阈值 |
| `maxTurns`（extractMemories） | 5 | `extractMemories.ts:426` | 分叉 Agent 最大轮次 |

---

## SessionMemory 笔记模板结构

默认模板包含以下固定章节（`src/services/SessionMemory/prompts.ts:11-41`）：

- **Session Title** — 会话标题
- **Current State** — 当前工作状态和待办事项
- **Task specification** — 用户需求和设计决策
- **Files and Functions** — 重要文件及其作用
- **Workflow** — 常用命令和工作流
- **Errors & Corrections** — 遇到的错误和修复方法
- **Codebase and System Documentation** — 系统组件文档
- **Learnings** — 经验教训
- **Key results** — 用户请求的具体输出结果
- **Worklog** — 工作日志

提取 Agent 被严格限制只能编辑章节内容，不能修改章节标题和斜体描述行。当章节超长时，`buildSessionMemoryUpdatePrompt` 会附加警告提示要求压缩。

---

## 边界 Case 与注意事项

- **SessionMemory 的 token 阈值始终是必要条件**：即使工具调用阈值已满足，也必须同时满足 token 增长阈值才会触发提取，防止过度提取（`src/services/SessionMemory/sessionMemory.ts:165-167`）。

- **extractMemories 与主 Agent 的互斥**：当主 Agent 在对话中已经直接写入了记忆文件时，extractMemories 会跳过该轮提取并推进游标，避免重复写入。

- **合并语义**：extractMemories 进行中有新请求时，只保留最新的上下文（覆盖之前暂存的），因为最新上下文包含最多消息。拖尾运行的 `newMessageCount` 从推进后的游标开始计算，只处理增量消息。

- **`waitForSessionMemoryExtraction` 的陈旧检测**：如果提取已启动超过 1 分钟，视为陈旧直接返回，不再等待（`src/services/SessionMemory/sessionMemoryUtils.ts:89-105`）。

- **compact 截断保护**：`truncateSessionMemoryForCompact` 在将笔记插入 compact 消息时，按行边界截断超长章节（每节最多 `MAX_SECTION_LENGTH * 4` 字符），防止笔记占据整个压缩后的 token 预算（`src/services/SessionMemory/prompts.ts:256-296`）。

- **远程模式排除**：两个服务在远程模式下均不运行。

- **变量替换的安全性**：`substituteVariables` 采用单遍替换，避免 `$` 反向引用和双重替换问题（`src/services/SessionMemory/prompts.ts:201-213`）。

- **`sinceUuid` 丢失的容错**：如果 `lastMemoryMessageUuid` 因上下文压缩被移除而找不到，`countModelVisibleMessagesSince` 回退为统计所有可见消息，而非返回 0 导致提取永久失效（`src/services/extractMemories/extractMemories.ts:103-108`）。