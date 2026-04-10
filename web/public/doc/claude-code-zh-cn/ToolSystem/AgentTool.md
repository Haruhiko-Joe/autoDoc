# AgentTool — 子 Agent 生成与管理工具

## 概述与职责

AgentTool 是 ToolSystem 中最复杂的单一工具，由 20 个文件、2200+ 行代码组成。它负责**启动、管理和协调子 Agent 对话循环**——当主 Agent 需要将复杂任务委派给专业子进程时，AgentTool 就是这个委派的入口。

在整体架构中，AgentTool 属于 **ToolSystem** 模块，与 TaskSystem 紧密协作：AgentTool 创建子 Agent 任务（通过 `registerAsyncAgent`），TaskSystem 管理这些任务的生命周期。同级工具包括 BashTool、FileReadTool、GrepTool 等 40+ 内置工具。

核心能力包括：
- **runAgent**：启动子 Agent 对话循环，驱动 `query()` 主循环执行多轮工具调用
- **forkSubagent**：实验性的"分叉子 Agent"机制，共享父 Agent 的 prompt cache
- **loadAgentsDir**：从 `.claude/agents/` 目录和 settings 加载自定义 Agent 定义
- **内置 6 种 Agent 类型**：general-purpose、Explore、Plan、statusline-setup、verification、claude-code-guide
- **worktree 隔离**、**后台运行**、**记忆快照传递**等高级特性

## 文件结构

| 文件 | 职责 |
|------|------|
| `AgentTool.tsx` | 工具主入口，定义 schema、`call()` 方法、同步/异步分发逻辑 |
| `runAgent.ts` | 子 Agent 对话循环核心，驱动 `query()` 并 yield 消息流 |
| `forkSubagent.ts` | Fork 子 Agent 机制——继承父对话上下文，共享 prompt cache |
| `loadAgentsDir.ts` | Agent 定义的加载、解析、合并（Markdown/JSON 格式） |
| `prompt.ts` | 动态生成 AgentTool 的工具描述 prompt |
| `resumeAgent.ts` | 恢复已暂停的后台 Agent（从磁盘 transcript 重建） |
| `agentToolUtils.ts` | 工具过滤、结果序列化、异步生命周期管理 |
| `agentMemory.ts` | Agent 持久化记忆的加载与路径管理 |
| `agentMemorySnapshot.ts` | 记忆快照的同步与初始化 |
| `agentColorManager.ts` | Agent UI 颜色分配 |
| `agentDisplay.ts` | Agent 列表的展示辅助函数 |
| `UI.tsx` | React/Ink 渲染组件 |
| `constants.ts` | 工具名称常量 |
| `built-in/*.ts` | 6 个内置 Agent 定义 |

## 关键流程

### 1. Agent 调用主流程（`AgentTool.call()`）

这是 AgentTool 最核心的入口，处理从用户请求到子 Agent 执行的完整链路：

1. **解析输入参数**：从 `prompt`、`subagent_type`、`description`、`model`、`run_in_background`、`isolation` 等参数构建调用意图
2. **路由选择**：
   - 若 `team_name` + `name` 存在 → 走 **spawnTeammate** 多 Agent 协作路径
   - 若 `subagent_type` 未设置且 fork 实验开启 → 走 **fork 路径**（继承父上下文）
   - 否则 → 走标准 Agent 路径（`subagent_type` 默认为 `general-purpose`）
3. **Agent 定义查找**：从 `agentDefinitions.activeAgents` 中匹配，校验权限规则（`filterDeniedAgents`）
4. **MCP 服务器校验**：检查 `requiredMcpServers` 是否满足，必要时等待 pending 连接
5. **隔离模式处理**：
   - `worktree`：调用 `createAgentWorktree()` 创建临时 git worktree
   - `remote`：委派到 CCR 远程环境（仅内部构建）
6. **System Prompt 构建**：fork 路径继承父 prompt；标准路径调用 `enhanceSystemPromptWithEnvDetails()`
7. **同步 vs 异步分发**：
   - 异步（`shouldRunAsync`）：`registerAsyncAgent()` → `runAsyncAgentLifecycle()` 在后台运行
   - 同步：直接迭代 `runAgent()` 的 AsyncGenerator，实时转发消息

> 源码位置：`src/tools/AgentTool/AgentTool.tsx:239-700`（`call()` 方法）

### 2. 子 Agent 对话循环（`runAgent()`）

`runAgent()` 是一个 `AsyncGenerator<Message, void>`，驱动子 Agent 的完整对话：

1. **初始化上下文**：
   - 解析模型（`getAgentModel()`）
   - 创建唯一 `agentId`
   - 构建 `userContext`（可选省略 CLAUDE.md 以节省 token）和 `systemContext`（Explore/Plan 省略 gitStatus）
   - 计算权限模式覆盖（`agentPermissionMode`）
2. **工具池解析**：`resolveAgentTools()` 根据 Agent 定义的 `tools`/`disallowedTools` 过滤可用工具
3. **Agent 特定 MCP 服务器**：`initializeAgentMcpServers()` 连接 Agent 定义中声明的额外 MCP 服务器
4. **Hook 注册**：注册 frontmatter 定义的 hooks，预加载 skills
5. **创建子 Agent 上下文**：`createSubagentContext()` 构建独立的对话上下文（独立的 abort controller、file state cache、content replacement state）
6. **调用 `query()` 主循环**：驱动 Claude API 交互，每轮 yield 消息，直到模型停止或达到 `maxTurns`
7. **清理**：移除 MCP 连接、清理 hooks、清理 Perfetto trace 注册

> 源码位置：`src/tools/AgentTool/runAgent.ts:248-600+`

### 3. Fork 子 Agent 机制（`forkSubagent.ts`）

Fork 是一种实验性的子 Agent 模式，核心目标是**最大化 prompt cache 命中率**：

1. **触发条件**：`isForkSubagentEnabled()` 为 true 且调用时未指定 `subagent_type`
2. **消息构建**（`buildForkedMessages()`）：
   - 保留父 Agent 的完整 assistant message（所有 `tool_use` blocks）
   - 为每个 `tool_use` 生成相同占位符的 `tool_result`
   - 在末尾追加 per-child 的 directive 文本
   - 结果：所有 fork 子 Agent 共享 byte-identical 的 API 请求前缀
3. **递归保护**：`isInForkChild()` 检测 `<fork-boilerplate>` 标签防止嵌套 fork
4. **Worktree 通知**：`buildWorktreeNotice()` 告知 fork 子 Agent 路径转换规则
5. **子 Agent 行为约束**：通过 `buildChildMessage()` 注入严格的行为规则（不生成子 Agent、不对话、直接执行）

> 源码位置：`src/tools/AgentTool/forkSubagent.ts:1-211`

### 4. Agent 定义加载（`loadAgentsDir.ts`）

Agent 定义的加载是一个多来源合并过程：

1. **来源优先级**（从低到高）：built-in → plugin → userSettings → projectSettings → flagSettings → policySettings
2. **Markdown 格式**（`parseAgentFromMarkdown()`）：从 `.claude/agents/*.md` 文件解析 frontmatter（name、description、tools、model、permissionMode 等）+ 正文作为 system prompt
3. **JSON 格式**（`parseAgentFromJson()`）：从 settings JSON 中解析 Agent 定义
4. **合并逻辑**（`getActiveAgentsFromList()`）：同名 Agent 按优先级覆盖，高优先级 source 胜出
5. **记忆快照初始化**：`initializeAgentMemorySnapshots()` 检查并同步项目快照到本地

> 源码位置：`src/tools/AgentTool/loadAgentsDir.ts:296-393`（`getAgentDefinitionsWithOverrides()`）

## 类型定义

### `BaseAgentDefinition`

所有 Agent 定义的基础类型（`src/tools/AgentTool/loadAgentsDir.ts:106-133`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentType` | `string` | Agent 类型标识（如 `"Explore"`） |
| `whenToUse` | `string` | 何时使用的描述，展示给主 Agent |
| `tools` | `string[]` | 允许的工具列表，`['*']` 表示全部 |
| `disallowedTools` | `string[]` | 禁用的工具列表 |
| `model` | `string` | 模型标识，`'inherit'` 继承父 Agent |
| `permissionMode` | `PermissionMode` | 权限模式（`acceptEdits`、`bubble`、`plan` 等） |
| `maxTurns` | `number` | 最大对话轮次 |
| `background` | `boolean` | 是否始终后台运行 |
| `memory` | `AgentMemoryScope` | 持久化记忆范围（`user`/`project`/`local`） |
| `isolation` | `'worktree' \| 'remote'` | 隔离模式 |
| `omitClaudeMd` | `boolean` | 是否省略 CLAUDE.md（节省 token） |
| `mcpServers` | `AgentMcpServerSpec[]` | Agent 专属 MCP 服务器 |
| `hooks` | `HooksSettings` | Agent 作用域内的 hooks |
| `skills` | `string[]` | 预加载的 skill 名称列表 |

三个具体类型通过联合类型组成 `AgentDefinition`：
- **`BuiltInAgentDefinition`**：内置 Agent，`source: 'built-in'`，有 `getSystemPrompt()` 方法
- **`CustomAgentDefinition`**：自定义 Agent，来自 Markdown/JSON settings
- **`PluginAgentDefinition`**：插件 Agent，`source: 'plugin'`

### 输入 Schema

AgentTool 的输入参数（`src/tools/AgentTool/AgentTool.tsx:82-138`）：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | `string` | 是 | 子 Agent 的任务描述 |
| `description` | `string` | 是 | 3-5 词简短描述 |
| `subagent_type` | `string` | 否 | Agent 类型，省略则用 general-purpose 或 fork |
| `model` | `'sonnet' \| 'opus' \| 'haiku'` | 否 | 模型覆盖 |
| `run_in_background` | `boolean` | 否 | 后台运行 |
| `name` | `string` | 否 | Agent 名称（多 Agent 协作时使用） |
| `isolation` | `'worktree'` | 否 | 隔离模式 |

### 输出 Schema

两种输出模式（`src/tools/AgentTool/AgentTool.tsx:141-155`）：
- **同步完成**：`{ status: 'completed', agentId, content, totalToolUseCount, totalDurationMs, ... }`
- **异步启动**：`{ status: 'async_launched', agentId, description, outputFile, ... }`

## 内置 Agent 类型

### general-purpose（通用 Agent）

全能型 Agent，工具池为 `['*']`（所有工具）。默认 Agent 类型——当未指定 `subagent_type` 且 fork 未启用时使用。适用于代码搜索、多步任务执行等通用场景。

> 源码位置：`src/tools/AgentTool/built-in/generalPurposeAgent.ts`

### Explore（代码探索 Agent）

只读快速搜索 Agent，禁用所有写入工具（`Agent`、`Edit`、`Write`、`NotebookEdit`）。外部用户使用 Haiku 模型以提高速度，省略 CLAUDE.md 和 gitStatus 以节省 token。被标记为 `ONE_SHOT_BUILTIN_AGENT_TYPES`，不支持 SendMessage 恢复。

> 源码位置：`src/tools/AgentTool/built-in/exploreAgent.ts`

### Plan（架构规划 Agent）

只读规划 Agent，与 Explore 共享相同的工具限制。使用 `'inherit'` 模型（继承父 Agent）。输出结构化的实现计划，包含关键文件列表和架构权衡。

> 源码位置：`src/tools/AgentTool/built-in/planAgent.ts`

### statusline-setup（状态栏配置 Agent）

专门用于配置 Claude Code 状态栏的 Agent。工具仅限 `['Read', 'Edit']`，使用 Sonnet 模型，预设颜色为 orange。负责读取用户 shell 配置、转换 PS1 并写入 `~/.claude/settings.json`。

> 源码位置：`src/tools/AgentTool/built-in/statuslineSetup.ts`

### verification（验证 Agent）

实现验证专家，始终后台运行（`background: true`）。禁用所有写入工具，只能在 `/tmp` 写临时测试脚本。System prompt 包含对抗性验证策略、常见逃避模式识别和严格的 PASS/FAIL/PARTIAL 输出格式。预设颜色为 red。需要 feature gate `VERIFICATION_AGENT` 开启。

> 源码位置：`src/tools/AgentTool/built-in/verificationAgent.ts`

### claude-code-guide（Claude Code 指南 Agent）

帮助用户了解 Claude Code、Agent SDK 和 Claude API 的文档查询 Agent。工具限于 `Glob`、`Grep`、`Read`、`WebFetch`、`WebSearch`。使用 Haiku 模型，`permissionMode: 'dontAsk'`。动态注入当前项目的自定义 skills、agents、MCP 服务器和 settings 作为上下文。仅在非 SDK 入口下启用。

> 源码位置：`src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`

## 工具过滤机制

`filterToolsForAgent()` 和 `resolveAgentTools()` 实现了多层工具过滤（`src/tools/AgentTool/agentToolUtils.ts:70-225`）：

1. **全局禁止列表**（`ALL_AGENT_DISALLOWED_TOOLS`）：所有子 Agent 都不能使用的工具
2. **自定义 Agent 禁止列表**（`CUSTOM_AGENT_DISALLOWED_TOOLS`）：非内置 Agent 额外禁止的工具
3. **异步 Agent 白名单**（`ASYNC_AGENT_ALLOWED_TOOLS`）：后台 Agent 只能使用的工具子集
4. **Agent 定义级别**：`tools` 字段指定允许列表，`disallowedTools` 指定禁止列表，两者可组合
5. **通配符**：`tools` 为 `undefined` 或 `['*']` 表示允许所有（经过前述过滤后的）工具

## Agent 记忆系统

### 记忆范围（`AgentMemoryScope`）

三种持久化范围（`src/tools/AgentTool/agentMemory.ts:13`）：

| 范围 | 路径 | 用途 |
|------|------|------|
| `user` | `~/.claude/agent-memory/<agentType>/` | 跨项目通用学习 |
| `project` | `<cwd>/.claude/agent-memory/<agentType>/` | 项目级记忆，可提交到 VCS |
| `local` | `<cwd>/.claude/agent-memory-local/<agentType>/` | 本地项目记忆，不入 VCS |

`loadAgentMemoryPrompt()` 在 Agent 启动时加载记忆内容并追加到 system prompt 中。当 Agent 启用 `memory` 时，自动注入 `Write`、`Edit`、`Read` 工具确保 Agent 可以读写记忆文件。

### 记忆快照（`agentMemorySnapshot.ts`）

支持通过项目级快照分发初始记忆（`src/tools/AgentTool/agentMemorySnapshot.ts`）：
- `checkAgentMemorySnapshot()`：检查项目快照是否存在及是否有更新
- `initializeFromSnapshot()`：首次从快照初始化本地记忆
- `replaceFromSnapshot()`：用快照替换本地记忆
- 通过 `.snapshot-synced.json` 追踪同步状态

## 异步 Agent 生命周期

`runAsyncAgentLifecycle()`（`src/tools/AgentTool/agentToolUtils.ts:508-686`）管理后台 Agent 的完整生命周期：

1. **启动**：创建 progress tracker，可选启动 summarization
2. **消息流处理**：迭代 `runAgent()` 的 AsyncGenerator，逐条更新进度
3. **正常完成**：`finalizeAgentTool()` 提取结果 → `completeAsyncAgent()` 标记完成 → 发送完成通知
4. **终止处理**：
   - `AbortError`（用户终止）：`killAsyncAgent()` + 提取部分结果
   - 其他错误：`failAsyncAgent()` + 错误通知
5. **安全审查**（可选）：`classifyHandoffIfNeeded()` 在 auto 权限模式下对子 Agent 输出进行安全分类
6. **Worktree 清理**：检查是否有变更，无变更则自动删除 worktree

## Prompt 生成

`getPrompt()`（`src/tools/AgentTool/prompt.ts:66-287`）动态生成 AgentTool 的工具描述，包含：

- Agent 列表（可内联或通过 attachment 注入以避免 cache bust）
- "何时使用/不使用" 的指导
- Fork 模式的额外说明（`whenToForkSection`）
- Prompt 编写指南（`writingThePromptSection`）
- 使用示例
- 并发启动说明
- Worktree 隔离说明

`shouldInjectAgentListInMessages()` 控制 Agent 列表是嵌入在工具描述中还是通过 attachment 消息注入——后者可避免 MCP/插件变更导致的 prompt cache 失效。

## 配置项

### 环境变量

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | 禁用所有后台 Agent |
| `CLAUDE_AUTO_BACKGROUND_TASKS` | 超时后自动将 Agent 转为后台 |
| `CLAUDE_CODE_SIMPLE` | 简单模式，仅加载内置 Agent |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | SDK 模式下禁用所有内置 Agent |
| `CLAUDE_CODE_AGENT_LIST_IN_MESSAGES` | 强制 Agent 列表通过 attachment 注入 |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | 远程记忆目录（CCR 场景） |

### Feature Gates

| Gate | 说明 |
|------|------|
| `FORK_SUBAGENT` | 启用 fork 子 Agent 机制 |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | 启用 Explore/Plan Agent |
| `VERIFICATION_AGENT` | 启用 verification Agent |
| `COORDINATOR_MODE` | 启用协调器模式（替换内置 Agent 为 worker Agent） |
| `AGENT_MEMORY_SNAPSHOT` | 启用记忆快照同步 |
| `TRANSCRIPT_CLASSIFIER` | 启用安全分类器审查子 Agent 输出 |

## 边界 Case 与注意事项

- **递归 fork 保护**：fork 子 Agent 不能再 fork。通过 `querySource` 和消息内容双重检测（`isInForkChild()`），后者作为 fallback 防止 autocompact 擦除 querySource
- **ONE_SHOT_BUILTIN_AGENT_TYPES**（Explore、Plan）：跳过 agentId/SendMessage 提示以节省 token（约 135 chars × 3400 万次/周）
- **omitClaudeMd 优化**：Explore/Plan 省略 CLAUDE.md 注入，节省约 5-15 Gtok/周。有 kill-switch `tengu_slim_subagent_claudemd`
- **prompt cache 共享**：fork 路径要求所有子 Agent 生成 byte-identical 的 API 请求前缀，因此使用 `useExactTools: true` 继承父工具池而非重新组装
- **权限模式继承**：父 Agent 为 `bypassPermissions`/`acceptEdits`/`auto` 时不会被子 Agent 的 `permissionMode` 覆盖
- **worktree 清理**：无变更时自动删除；有变更时保留并在结果中返回 `worktreePath` 和 `worktreeBranch`
- **恢复 Agent**（`resumeAgent.ts`）：从磁盘 transcript 重建消息历史（`reconstructForSubagentResume`），校验 worktree 路径是否仍存在，更新 mtime 防止被 stale-worktree 清理误删