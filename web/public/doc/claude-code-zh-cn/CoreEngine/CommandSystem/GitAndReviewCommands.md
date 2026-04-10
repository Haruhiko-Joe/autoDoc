# Git 操作与代码审查命令集

## 概述与职责

GitAndReviewCommands 是 Claude Code 命令系统（CommandSystem）中专注于 **Git 工作流** 和 **代码审查** 的命令集合。它为开发者提供从代码变更、分支管理、差异查看，到 PR 审查、安全审查、发布管理的完整工作流支持。

在系统架构中，这些命令属于 **CoreEngine → CommandSystem** 层级。它们通过斜杠命令（`/command`）触发，由 `commands.ts` 中央注册表统一管理，最终在 QueryEngine 的对话循环中执行。同级的其他命令组包括会话管理命令（/help、/compact）、配置命令（/config、/mcp）等。

该命令集包含以下命令：

| 命令 | 类型 | 功能 |
|------|------|------|
| `/commit` | prompt | 自动分析变更并创建 Git 提交 |
| `/commit-push-pr` | prompt | 一键完成提交、推送和创建 PR |
| `/branch` | local-jsx | 在当前对话节点创建分支（fork） |
| `/diff` | local-jsx | 查看未提交变更和逐轮差异 |
| `/review` | prompt | 本地 PR 代码审查 |
| `/ultrareview` | local-jsx | 远程云端深度 Bug 检测审查（10-20 分钟） |
| `/security-review` | prompt | 分支变更的安全漏洞审查 |
| `/pr-comments` | prompt | 获取 GitHub PR 评论 |
| `/release-notes` | local | 查看版本发布说明 |
| `/bughunter` | - | 已禁用的存根命令 |

## 关键流程

### /commit：智能提交流程

`/commit` 是一个 `prompt` 类型命令，通过构建包含上下文信息的提示词，引导模型完成提交操作。

1. **收集 Git 上下文**：通过 `!` 语法内嵌 shell 命令，获取 `git status`、`git diff HEAD`、当前分支、最近 10 条提交记录（`src/commands/commit.ts:20-26`）
2. **执行命令替换**：调用 `executeShellCommandsInPrompt()` 将 `!\`command\`` 模板替换为实际命令输出
3. **模型生成提交**：提示词要求模型分析变更、遵循仓库的提交消息风格、使用 HEREDOC 语法创建提交
4. **安全约束**：内置 Git 安全协议——禁止 `--amend`（除非用户明确要求）、禁止跳过 hooks、禁止提交含密钥的文件

允许的工具被严格限制为：`git add`、`git status`、`git commit`（`src/commands/commit.ts:6-10`）。

### /commit-push-pr：一键 PR 流程

这是最复杂的命令，串联了从提交到 PR 创建的完整流程。

1. **并行获取配置**：同时获取默认分支（`getDefaultBranch()`）和增强的 PR 归属信息（`getEnhancedPRAttribution()`）（`src/commands/commit-push-pr.ts:121-124`）
2. **收集扩展上下文**：除基本 Git 状态外，还收集 `SAFEUSER`、`whoami`、当前分支与默认分支的 diff、已有 PR 信息
3. **模型执行四步操作**：
   - 如果在默认分支上，创建新分支（格式：`username/feature-name`）
   - 创建带归属信息的提交
   - 推送分支到 origin
   - 创建新 PR 或更新已有 PR（通过 `gh pr view` 检测）
4. **可选 Slack 通知**：如果用户的 CLAUDE.md 提到 Slack 频道，检查是否有可用的 Slack 工具并询问用户是否发送通知
5. **用户指令追加**：如果命令附带参数（如 `/commit-push-pr fix the typo`），会作为额外指令追加到提示词

允许的工具范围更广，包括 `git checkout -b`、`git push`、`gh pr create/edit/view/merge`、`ToolSearch` 以及 Slack MCP 工具（`src/commands/commit-push-pr.ts:10-24`）。

### /branch：对话分支

`/branch` 是一个 `local-jsx` 类型命令，不与模型交互，而是直接在本地执行对话分支操作。

1. **读取当前会话转录**：从 JSONL 格式的 transcript 文件中解析所有消息条目（`src/commands/branch/branch.ts:77-91`）
2. **过滤主对话消息**：排除 sidechain 和非消息条目，只保留主对话流
3. **保留内容替换记录**：复制 `content-replacement` 条目并重写 sessionId，确保 fork 会话恢复时不会因缺少替换映射导致 prompt 缓存失效（`src/commands/branch/branch.ts:98-111`）
4. **生成唯一名称**：通过 `getUniqueForkName()` 检测重名并添加数字后缀（如 "Branch 2"、"Branch 3"）（`src/commands/branch/branch.ts:179-220`）
5. **写入并恢复**：将 fork 转录写入新文件，调用 `context.resume()` 切换到 fork 会话

### /review 与 /ultrareview：双轨审查

**`/review`**（本地审查）：简单的 prompt 命令，引导模型运行 `gh pr list`/`gh pr view`/`gh pr diff` 获取 PR 信息，然后生成包含代码正确性、项目规范、性能、测试覆盖和安全性分析的审查报告（`src/commands/review.ts:9-31`）。

**`/ultrareview`**（远程深度审查）：一个完全不同的路径，将审查任务"传送"到云端的 CCR（Claude Code on the web）环境执行。

核心流程：

1. **计费门控**（`checkOverageGate()`，`src/commands/review/reviewRemote.ts:52-113`）：
   - Team/Enterprise 用户直接放行
   - 消费者用户检查免费配额（`fetchUltrareviewQuota()`）
   - 免费用完后检查 Extra Usage 是否启用及余额（最低 $10）
   - 首次超额使用弹出确认对话框（`UltrareviewOverageDialog`），确认后同会话不再重复弹出

2. **远程启动**（`launchRemoteReview()`，`src/commands/review/reviewRemote.ts:128-316`）支持两种模式：
   - **PR 模式**（传入 PR 编号）：通过 `refs/pull/N/head` 引用在 GitHub 上克隆
   - **分支模式**（无参数）：打包本地工作树（bundle）上传，与 merge-base 对比

3. **Bughunter 配置**：通过 GrowthBook 特性开关获取运行参数——fleet 大小（默认 5，上限 20）、最大时长（默认 10 分钟，上限 25 分钟）、agent 超时（默认 600 秒）、总墙钟时间（默认 22 分钟，上限 27 分钟）

4. **结果回传**：通过 `registerRemoteAgentTask()` 注册远程任务，结果通过 task-notification 机制回传到本地会话

`/ultrareview` 的可用性由 GrowthBook 的 `tengu_review_bughunter_config.enabled` 字段控制（`src/commands/review/ultrareviewEnabled.ts:8-14`）。

### /security-review：安全审查

一个内容丰富的 prompt 命令，模拟资深安全工程师的审查流程（`src/commands/security-review.ts:6-196`）：

1. **上下文收集**：自动获取 `git status`、修改文件列表、提交日志、与 `origin/HEAD` 的完整 diff
2. **三阶段分析**：
   - 阶段一：使用子任务（sub-task）结合文件搜索工具分析漏洞
   - 阶段二：为每个发现并行创建子任务过滤误报
   - 阶段三：过滤置信度低于 8 的发现
3. **审查范围**：覆盖输入验证（SQL/命令/XXE/模板注入等）、认证授权、加密与密钥管理、注入与代码执行、数据暴露五大类
4. **严格的误报过滤**：内置 17 条硬排除规则和 12 条先例判定，大幅降低噪声（如：React/Angular 组件默认不报 XSS、环境变量被视为可信值、DoS 漏洞被排除等）

该命令使用 `createMovedToPluginCommand` 包装——对内部用户（`USER_TYPE=ant`），提示安装独立插件；对外部用户，直接执行内嵌的审查提示词。

### /pr-comments：PR 评论获取

同样使用 `createMovedToPluginCommand` 包装的 prompt 命令（`src/commands/pr_comments/index.ts`）。引导模型：

1. 通过 `gh pr view` 获取 PR 信息
2. 分别调用 GitHub API 获取 PR 级别评论和代码审查评论
3. 对引用代码的评论，还会获取对应文件内容
4. 格式化输出包含作者、文件位置、diff 上下文和评论内容的结构化结果

### /release-notes：发布说明

唯一的纯本地（`local` 类型、非 prompt）命令，支持非交互模式（`src/commands/release-notes/index.ts:7`）。

1. 尝试在 500ms 超时内从远端获取最新 changelog（`src/commands/release-notes/release-notes.ts:24-28`）
2. 超时或失败时回退到本地缓存
3. 两者都无数据时返回 changelog URL 链接

## 函数签名与参数说明

### `getPromptForCommand(args: string, context: ToolUseContext): Promise<ContentBlockParam[]>`

所有 `prompt` 类型命令的核心方法。接收用户在斜杠命令后输入的参数字符串和工具使用上下文，返回注入对话的内容块数组。

### `createMovedToPluginCommand(options: Options): Command`

> 源码位置：`src/commands/createMovedToPluginCommand.ts:22-65`

创建"已迁移到插件"的命令包装器。对内部用户返回插件安装指引，对外部用户执行 `getPromptWhileMarketplaceIsPrivate` 回退逻辑。

| 参数 | 类型 | 说明 |
|------|------|------|
| name | string | 命令名称 |
| description | string | 命令描述 |
| progressMessage | string | 执行时的进度提示 |
| pluginName | string | 目标插件名称 |
| pluginCommand | string | 插件中的子命令名 |
| getPromptWhileMarketplaceIsPrivate | function | 市场未公开时的回退提示词生成函数 |

### `checkOverageGate(): Promise<OverageGate>`

> 源码位置：`src/commands/review/reviewRemote.ts:52-113`

判断用户是否可以启动 ultrareview 以及计费条件。返回值为联合类型：

| kind | 含义 |
|------|------|
| `proceed` | 可以启动，附带 `billingNote` |
| `not-enabled` | Extra Usage 未启用 |
| `low-balance` | 余额不足（低于 $10） |
| `needs-confirm` | 需要用户确认超额计费 |

### `launchRemoteReview(args: string, context: ToolUseContext, billingNote?: string): Promise<ContentBlockParam[] | null>`

> 源码位置：`src/commands/review/reviewRemote.ts:128-316`

启动远程审查会话。返回描述启动结果的内容块（成功/各类失败原因），或 `null` 表示不可恢复的错误。

### `createFork(customTitle?: string): Promise<{sessionId, title, forkPath, serializedMessages, contentReplacementRecords}>`

> 源码位置：`src/commands/branch/branch.ts:61-173`

创建当前对话的分支副本。读取当前 transcript JSONL 文件，为每条消息分配新的 sessionId 和 forkedFrom 溯源信息。

### `deriveFirstPrompt(firstUserMessage): string`

> 源码位置：`src/commands/branch/branch.ts:38-54`

从第一条用户消息提取单行标题（最长 100 字符），用于分支会话的默认命名。

## 接口/类型定义

### `OverageGate`

> 源码位置：`src/commands/review/reviewRemote.ts:42-46`

```typescript
type OverageGate =
  | { kind: 'proceed'; billingNote: string }
  | { kind: 'not-enabled' }
  | { kind: 'low-balance'; available: number }
  | { kind: 'needs-confirm' }
```

### `Command` 类型字段

命令通过 `satisfies Command` 声明，关键字段包括：

| 字段 | 说明 |
|------|------|
| `type` | `'prompt'`（模型交互）、`'local-jsx'`（本地 JSX 渲染）、`'local'`（纯本地逻辑） |
| `name` | 命令名称，即 `/name` |
| `allowedTools` | prompt 命令可使用的工具白名单 |
| `isEnabled` | 可选的动态启用检查函数 |
| `source` | 命令来源，内置命令为 `'builtin'` |

## 配置项与默认值

### Bughunter 远程审查参数

通过 GrowthBook 特性开关 `tengu_review_bughunter_config` 配置（`src/commands/review/reviewRemote.ts:177-199`）：

| 参数 | 环境变量 | 默认值 | 上限 | 说明 |
|------|----------|--------|------|------|
| fleet_size | BUGHUNTER_FLEET_SIZE | 5 | 20 | 并行 Agent 数量 |
| max_duration_minutes | BUGHUNTER_MAX_DURATION | 10 | 25 | 单次审查最大时长 |
| agent_timeout_seconds | BUGHUNTER_AGENT_TIMEOUT | 600 | 1800 | 单个 Agent 超时 |
| total_wallclock_minutes | BUGHUNTER_TOTAL_WALLCLOCK | 22 | 27 | 总墙钟时间（需低于 RemoteAgentTask 的 30 分钟轮询超时） |

### 环境变量

| 变量 | 用途 |
|------|------|
| `USER_TYPE` | 值为 `'ant'` 时启用内部用户特殊逻辑（Undercover 模式、插件迁移提示） |
| `SAFEUSER` | 用于 `/commit-push-pr` 生成分支名前缀 |
| `BUGHUNTER_DEV_BUNDLE_B64` | 开发调试用，覆盖 bughunter 打包内容 |

## 边界 Case 与注意事项

- **`/commit` 的安全协议**：严格禁止 `--amend`、`--no-verify`、`-i`（交互式）等选项，仅在用户明确要求时放行。这是为了防止意外覆盖历史提交或绕过 pre-commit hooks。

- **`/commit-push-pr` 的 PR 检测**：通过 `gh pr view --json number` 检测当前分支是否已有 PR。如果有，使用 `gh pr edit` 更新而非创建新 PR（`src/commands/commit-push-pr.ts:90`）。

- **`/branch` 的内容替换保留**：fork 必须复制 `content-replacement` 条目到新 JSONL，否则恢复 fork 会话时，之前被替换的 `tool_result` 会以完整内容发送，导致 prompt 缓存失效和持续的 token 超额（`src/commands/branch/branch.ts:98-104`）。

- **`/ultrareview` 的分支模式大文件限制**：当本地仓库过大无法打包时，`teleportToRemote` 返回 `null`，命令提示用户改用 PR 模式（`/ultrareview <PR#>`）。

- **`/ultrareview` 的超额计费确认**：会话级标志 `sessionOverageConfirmed` 确保同一会话只弹一次确认框。但如果用户在启动过程中按 Escape 取消，确认标志不会被设置，下次仍会弹出（`src/commands/review/ultrareviewCommand.tsx:47-48`）。

- **`/security-review` 的误报控制**：内置极其详细的排除规则（17 条硬排除 + 12 条先例），置信度阈值 0.7 以下不报告，最终过滤低于 8 分的发现。设计目标是"宁可漏报，不要误报"。

- **`/bughunter` 已禁用**：当前为存根实现，`isEnabled: () => false` 且 `isHidden: true`（`src/commands/bughunter/index.js:1`）。

- **Undercover 模式**：当 `USER_TYPE=ant` 且 `isUndercover()` 为真时，`/commit` 和 `/commit-push-pr` 会注入额外的 undercover 指令，并移除 changelog、reviewer 和 Slack 相关的步骤。