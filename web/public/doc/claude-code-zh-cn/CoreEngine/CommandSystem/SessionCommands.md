# 会话生命周期管理命令集（SessionCommands）

## 概述与职责

SessionCommands 是 Claude Code **CommandSystem** 下的核心命令子集，负责管理用户与 Claude 对话的**完整生命周期**——从创建、导航、维护到结束。它包含 17 个斜杠命令，分布在 `src/commands/` 下的 17 个独立目录中，共计约 48 个源文件。

在系统架构中，SessionCommands 属于 **CoreEngine → CommandSystem** 层级。CoreEngine 是应用的"大脑"，而 CommandSystem 是其 80+ 内置命令的中央注册表。SessionCommands 是其中最大的功能域之一，与 QueryEngine（会话查询引擎）、CostTracking（费用追踪）、Services 层（API 通信、压缩服务、记忆系统）紧密协作。

同级模块还包括 QueryEngine（单轮查询主循环）、ContextBuilder（系统提示词构建）、CostTracking（Token 与费用追踪）、InputHistory（输入历史管理）等。

### 命令总览

| 命令 | 别名 | 类型 | 说明 |
|------|------|------|------|
| `/compact` | - | local | 上下文压缩，保留摘要 |
| `/clear` | `/reset`, `/new` | local | 清屏并重置会话 |
| `/context` | - | local-jsx | 可视化当前上下文使用情况 |
| `/resume` | `/continue` | local-jsx | 恢复历史会话 |
| `/session` | `/remote` | local-jsx | 显示远程会话信息（QR 码） |
| `/rename` | - | local | 重命名当前会话 |
| `/rewind` | `/checkpoint` | local | 撤销到历史消息点 |
| `/thinkback` | - | local-jsx | 年度回顾生成（特性门控） |
| `/thinkback-play` | - | local | 播放 thinkback 动画（隐藏） |
| `/copy` | - | local-jsx | 复制 Claude 响应到剪贴板 |
| `/summary` | - | - | 已禁用（存根） |
| `/files` | - | local | 列出上下文中的文件 |
| `/export` | - | local-jsx | 导出对话到文件 |
| `/add-dir` | - | local-jsx | 添加工作目录 |
| `/memory` | - | local-jsx | 编辑 Claude 记忆文件 |
| `/exit` | `/quit` | local-jsx | 退出会话 |
| `/tag` | - | local-jsx | 为会话添加/移除标签 |

## 关键流程

### 1. /compact — 上下文压缩流程

这是最复杂的命令之一，支持三种压缩路径，按优先级依次尝试：

1. **Session Memory Compaction**（无自定义指令时优先）：调用 `trySessionMemoryCompaction()` 进行轻量级会话记忆压缩（`src/commands/compact/compact.ts:57-83`）
2. **Reactive Compaction**（特性门控 `REACTIVE_COMPACT`）：当系统处于 reactive-only 模式时，通过 `reactiveCompactOnPromptTooLong()` 执行响应式压缩（`src/commands/compact/compact.ts:87-94`）
3. **Traditional Compaction**（兜底路径）：先运行 `microcompactMessages()` 预处理减少 Token，再调用 `compactConversation()` 进行完整的对话摘要压缩（`src/commands/compact/compact.ts:97-108`）

每种路径完成后都会执行统一的善后操作：清除用户上下文缓存、运行 `runPostCompactCleanup()`、抑制压缩警告、重置缓存检测基线。

```typescript
// src/commands/compact/compact.ts:40-137
export const call: LocalCommandCall = async (args, context) => {
  messages = getMessagesAfterCompactBoundary(messages)
  // 1. 尝试 session memory compaction
  // 2. 尝试 reactive compaction
  // 3. 兜底 traditional compaction（microcompact → compactConversation）
}
```

Reactive 压缩路径还包含**并发优化**——pre-compact hooks 和 `getCacheSharingParams` 同时执行（`src/commands/compact/compact.ts:159-165`）。

### 2. /clear — 会话重置流程

`/clear` 是一个重量级操作，涉及整个会话状态的完整重置：

1. **执行 SessionEnd hooks**：有超时限制（默认 1.5s），通知外部系统会话即将结束（`src/commands/clear/conversation.ts:68-74`）
2. **发送缓存淘汰提示**：通知推理层当前会话的缓存可以被回收（`src/commands/clear/conversation.ts:77-85`）
3. **保护后台任务**：计算需要保留的 Agent（`isBackgrounded !== false` 的任务继续存活），记录其 Agent ID（`src/commands/clear/conversation.ts:93-107`）
4. **清空消息**：`setMessages(() => [])` 
5. **清除 20+ 类缓存**：通过 `clearSessionCaches()` 清除上下文缓存、文件建议、命令缓存、LSP 诊断、MCP 工具、WebFetch 缓存等（`src/commands/clear/caches.ts:47-144`）
6. **重置 AppState**：清空任务（终止前台任务的 shell 命令和 abort controller）、重置归因状态、清空文件历史、重置 MCP 状态（`src/commands/clear/conversation.ts:135-192`）
7. **生成新 Session ID**：`regenerateSessionId({ setCurrentAsParent: true })`，旧 session 作为父级用于分析追踪（`src/commands/clear/conversation.ts:203`）
8. **修复后台任务符号链接**：将存活的本地 Agent 任务的 TaskOutput 符号链接重新指向新 session 目录（`src/commands/clear/conversation.ts:218-224`）
9. **执行 SessionStart hooks**：在新会话环境下执行（`src/commands/clear/conversation.ts:245`）

### 3. /resume — 恢复历史会话

`/resume` 提供了一个交互式会话选择器 UI（`src/commands/resume/resume.tsx`）：

- 支持通过 **UUID** 精确匹配、**搜索词** 模糊匹配（标题搜索 `searchSessionsByCustomTitle`）和 **Agent 语义搜索**（`agenticSessionSearch`）查找历史会话
- 使用 `LogSelector` 组件呈现会话列表，支持键盘导航
- 加载时同时获取同仓库的会话日志（`loadSameRepoMessageLogs`）和 worktree 路径
- 非交互模式下可直接传入 session ID 参数

### 4. /rename — 会话重命名

重命名流程分两个路径（`src/commands/rename/rename.ts:21-87`）：

- **无参数**：调用 `generateSessionName()` 自动生成名称——通过 Haiku 模型分析对话内容，生成 2-4 个单词的 kebab-case 名称（如 `fix-login-bug`）（`src/commands/rename/generateSessionName.ts:10-67`）
- **有参数**：直接使用用户提供的名称

命名后执行三个持久化操作：
1. 保存到会话存储（`saveCustomTitle`）
2. 同步到 bridge 会话（`updateBridgeSessionTitle`，非阻塞）
3. 保存为 agent name 并更新 AppState 的 `standaloneAgentContext`

Swarm teammate 不允许执行此命令，名称由 team leader 设定。

### 5. /exit — 退出会话

退出逻辑根据运行环境有三种行为（`src/commands/exit/exit.tsx:14-32`）：

1. **后台 tmux 会话**（`claude --bg`）：仅执行 `tmux detach-client`，REPL 继续运行，可通过 `claude attach` 重连
2. **Worktree 会话**：显示 `ExitFlow` 组件，让用户确认是否清理 worktree
3. **普通会话**：显示随机告别消息（"Goodbye!"、"See ya!" 等），调用 `gracefulShutdown`

## 函数签名与参数说明

### compact — `call(args: string, context: ToolUseContext)`

- **args**：可选的自定义压缩指令（如 "只保留 API 相关的讨论"），传递给压缩模型作为额外 prompt
- **context.messages**：当前对话消息列表
- **context.abortController**：用于取消压缩操作
- **返回值**：`{ type: 'compact', compactionResult: CompactionResult, displayText: string }`

> 源码位置：`src/commands/compact/compact.ts:40-137`

### clearConversation — 异步函数

```typescript
async function clearConversation({
  setMessages, readFileState, discoveredSkillNames,
  loadedNestedMemoryPaths, getAppState, setAppState, setConversationId
}): Promise<void>
```

- **setMessages**：消息更新器函数
- **readFileState**：文件状态缓存，清除时调用 `.clear()`
- **setConversationId**：用于触发 logo 重新渲染

> 源码位置：`src/commands/clear/conversation.ts:49-251`

### clearSessionCaches — 同步函数

```typescript
function clearSessionCaches(preservedAgentIds?: ReadonlySet<string>): void
```

- **preservedAgentIds**：需要保留状态的后台 Agent ID 集合。非空时，部分全局状态（prompt cache break detection、pending callbacks、dump state）不会被清除，以保证这些 Agent 正常运行

> 源码位置：`src/commands/clear/caches.ts:47-144`

### generateSessionName — 会话名称生成

```typescript
async function generateSessionName(
  messages: Message[], signal: AbortSignal
): Promise<string | null>
```

调用 Haiku 模型生成 kebab-case 会话名。使用 JSON schema 约束输出格式。失败时静默返回 `null`（不抛出异常），因为此函数也被 bridge 自动调用。

> 源码位置：`src/commands/rename/generateSessionName.ts:10-67`

### validateDirectoryForWorkspace — 目录校验

```typescript
async function validateDirectoryForWorkspace(
  directoryPath: string, permissionContext: ToolPermissionContext
): Promise<AddDirectoryResult>
```

返回联合类型结果：`success` | `emptyPath` | `pathNotFound` | `notADirectory` | `alreadyInWorkingDirectory`

> 源码位置：`src/commands/add-dir/validation.ts:31-93`

## 接口/类型定义

### AddDirectoryResult

`/add-dir` 命令的校验结果联合类型（`src/commands/add-dir/validation.ts:12-30`）：

| 变体 | 字段 | 说明 |
|------|------|------|
| `success` | `absolutePath` | 校验通过，返回绝对路径 |
| `emptyPath` | - | 未提供路径 |
| `pathNotFound` | `directoryPath`, `absolutePath` | 路径不存在 |
| `notADirectory` | `directoryPath`, `absolutePath` | 路径不是目录 |
| `alreadyInWorkingDirectory` | `directoryPath`, `workingDir` | 已在现有工作目录范围内 |

### CompactionResult

压缩操作的返回结果（由 `src/services/compact/compact.js` 定义），包含 `userDisplayMessage` 等字段，用于向用户展示压缩后的提示信息。

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `DISABLE_COMPACT` | 环境变量 | `false` | 设为 truthy 值禁用 `/compact` 命令 |
| `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` | 环境变量 | 1500ms | `/clear` 时 SessionEnd hooks 的超时时间 |
| `$EDITOR` / `$VISUAL` | 环境变量 | 系统默认 | `/memory` 命令使用的外部编辑器 |
| `REACTIVE_COMPACT` | Feature flag | - | 启用响应式压缩路径 |
| `BG_SESSIONS` | Feature flag | - | 启用后台 tmux 会话支持 |
| `CONTEXT_COLLAPSE` | Feature flag | - | `/context` 命令是否应用上下文折叠 |
| `MAX_LOOKBACK` | 常量 | 20 | `/copy` 最多回溯的 assistant 消息数 |

## 边界 Case 与注意事项

- **`/compact` 消息边界**：压缩前会调用 `getMessagesAfterCompactBoundary()` 过滤掉已被剪裁的消息，避免摘要包含已被 REPL 从 UI 滚动区域中移除的内容（`src/commands/compact/compact.ts:46`）

- **`/clear` 的后台任务保护**：带 `isBackgrounded !== false` 的任务在 clear 时不会被终止。其 per-agent 状态（已调用的技能、权限回调等）会被选择性保留（`src/commands/clear/conversation.ts:93-107`，`src/commands/clear/caches.ts:50`）

- **`/clear` 后的符号链接修复**：由于 session ID 已更新，存活的后台 Agent 任务的 TaskOutput 符号链接会被重新指向新 session 的日志目录，否则 `TaskOutput` 读取会指向冻结的旧数据（`src/commands/clear/conversation.ts:218-224`）

- **`/rename` 的 Teammate 限制**：Swarm teammate 不能重命名自己，因为其名称由 team leader 通过 coordinator 设定（`src/commands/rename/rename.ts:27-33`）

- **`/session` 仅远程模式**：该命令通过 index.ts 中的 `isEnabled` 检查 `remoteMode`，非远程模式下只显示警告（`src/commands/session/session.tsx:57-65`）

- **`/copy` 的剪贴板降级**：当 OSC 52 剪贴板协议不可用时，会将内容写入临时文件 `/tmp/claude/response.md`，避免操作完全失败（`src/commands/copy/copy.tsx:73-80`）

- **`/copy` 的路径遍历防护**：提取代码块时，语言标识符会被清洗（`lang.replace(/[^a-zA-Z0-9]/g, '')`），防止恶意 Markdown 代码块标记（如 ` ```../../etc/passwd `）导致路径遍历（`src/commands/copy/copy.tsx:66`）

- **`/export` 的文件名安全**：通过 `sanitizeFilename()` 移除特殊字符，仅保留小写字母、数字和连字符（`src/commands/export/export.tsx:42-48`）

- **`/add-dir` 的 EACCES 容错**：目录校验时将 `EACCES` 和 `EPERM` 也视为"路径不存在"而非抛出异常，这样 settings 中配置的不可访问目录不会导致启动崩溃（`src/commands/add-dir/validation.ts:60-71`）

- **`/summary` 已禁用**：该命令目前仅有一个 2 行的 stub 文件（`src/commands/summary/index.js`），标记为 hidden 和 disabled

## 关键代码片段

### 缓存清除的选择性保留逻辑

```typescript
// src/commands/clear/caches.ts:47-50
export function clearSessionCaches(
  preservedAgentIds: ReadonlySet<string> = new Set(),
): void {
  const hasPreserved = preservedAgentIds.size > 0
  // 当有需要保留的 Agent 时，跳过全局级别的状态清除
  if (!hasPreserved) resetPromptCacheBreakDetection()
  // ...
  clearInvokedSkills(preservedAgentIds) // 按 Agent ID 选择性清除
}
```

### 自动会话名称生成的 Haiku 调用

```typescript
// src/commands/rename/generateSessionName.ts:20-44
const result = await queryHaiku({
  systemPrompt: asSystemPrompt([
    'Generate a short kebab-case name (2-4 words) that captures the main topic...'
  ]),
  userPrompt: conversationText,
  outputFormat: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  signal,
})
```

### /exit 的多环境分支处理

```typescript
// src/commands/exit/exit.tsx:14-32
export async function call(onDone) {
  // tmux 后台会话：detach 而非退出
  if (feature('BG_SESSIONS') && isBgSession()) {
    spawnSync('tmux', ['detach-client'], { stdio: 'ignore' })
    return null
  }
  // worktree 会话：显示退出确认流程
  if (getCurrentWorktreeSession() !== null) {
    return <ExitFlow showWorktree onDone={onDone} onCancel={() => onDone()} />
  }
  // 普通会话：告别消息 + 优雅退出
  onDone(getRandomGoodbyeMessage())
  await gracefulShutdown(0, 'prompt_input_exit')
}
```