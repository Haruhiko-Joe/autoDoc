# DomainHelpers — 领域辅助工具散件集合

## 概述与职责

DomainHelpers 是 Infrastructure → FeatureUtilities 层中的一组**领域特定工具模块**，为上层功能系统提供文件持久化、消息映射、补全建议、任务输出管理、关键词检测等基础能力。这些模块虽然散布在 `src/utils/` 的多个子目录中，但各自服务于明确的领域场景，与 CommonUtilities（纯通用工具函数）形成互补。

在整体架构中，DomainHelpers 的同级模块包括 ShellAndBash（Shell 执行）、GitOperations（Git 操作）、ConfigAndSettings（配置管理）、PermissionsAndAuth（权限认证）等。DomainHelpers 被 FeatureUtilities（插件、Hook、模型管理等）和 CommonUtilities 等模块依赖，同时自身依赖 ConfigAndSettings 和 CommonUtilities 提供的基础设施。

本模块包含 **10 个子系统**，按职责分为以下几组：

| 子系统 | 目录 | 核心职责 |
|--------|------|----------|
| filePersistence | `src/utils/filePersistence/` | BYOC 环境下的文件输出持久化上传 |
| messages | `src/utils/messages/` | SDK ↔ 内部消息格式双向映射 |
| suggestions | `src/utils/suggestions/` | 命令/目录/Shell 历史/Slack 频道补全 |
| task | `src/utils/task/` | 任务输出缓冲、磁盘溢写、格式化、进度上报 |
| todo | `src/utils/todo/` | TodoItem 类型定义与校验 Schema |
| ultraplan | `src/utils/ultraplan/` | ultraplan/ultrareview 关键词检测与 CCR 会话轮询 |
| background | `src/utils/background/remote/` | 远程后台会话前置检查与资格校验 |
| memory | `src/utils/memory/` | 记忆类型枚举定义 |
| skills | `src/utils/skills/` | 技能/命令目录变更检测与热重载 |
| mcp | `src/utils/mcp/` | 自然语言日期解析与 MCP elicitation 输入校验 |

---

## 关键流程

### 1. 文件持久化流程（filePersistence）

文件持久化在 BYOC（Bring Your Own Container）远程会话中，将 Agent 每轮产生的输出文件上传到 Files API。

1. `runFilePersistence()` 检查环境类型（`CLAUDE_CODE_ENVIRONMENT_KIND === 'byoc'`）、Session Access Token 和 Session ID（`src/utils/filePersistence/filePersistence.ts:51-73`）
2. 调用 `findModifiedFiles()` 扫描 `{cwd}/{sessionId}/outputs` 目录，通过比较文件 mtime 与 turn 起始时间戳筛选本轮修改的文件（`src/utils/filePersistence/outputsScanner.ts:62-126`）
3. 安全过滤：跳过符号链接（防遍历攻击）、跳过路径穿越文件（`relativePath.startsWith('..')`）、强制文件数量限制 `FILE_COUNT_LIMIT`
4. 调用 `uploadSessionFiles()` 并行上传，收集成功/失败结果
5. `executeFilePersistence()` 包装上述流程，通过回调将结果传递给调用方

`isFilePersistenceEnabled()` 是快速判断函数，结合 Feature Flag `FILE_PERSISTENCE`、环境类型、Token 和 Session ID 四重条件判定。

### 2. SDK ↔ 内部消息映射流程（messages）

**mappers.ts** 实现内部 `Message` 类型与 SDK 协议 `SDKMessage` 类型之间的双向转换：

- `toInternalMessages()`：将 SDK 消息（assistant/user/system）映射为内部格式，处理 compact boundary 消息的元数据转换
- `toSDKMessages()`：反向映射，包含多个特殊处理：
  - 对 `local_command` 类型的系统消息，仅转换包含 stdout/stderr XML 标签的输出消息（过滤命令输入元数据），并将其转化为 `SDKAssistantMessage` 以兼容 Android 客户端和 session-ingress（`src/utils/messages/mappers.ts:164-175`）
  - 对 ExitPlanModeV2 工具调用，注入从文件读取的 plan 内容到 `tool_input.plan`，因为 V2 工具从文件读取 plan 但 SDK 消费者期望该字段存在（`src/utils/messages/mappers.ts:260-290`）
- `toSDKRateLimitInfo()`：将内部 `ClaudeAILimits` 映射为 SDK 面向的 `SDKRateLimitInfo`，剔除内部专用字段

**systemInit.ts** 构建 `system/init` SDKMessage——SDK 流的第一条消息，携带会话元数据（cwd、工具列表、模型、命令、技能、插件、MCP 服务器等）。供 QueryEngine 和 REPL Bridge 两条路径调用（`src/utils/messages/systemInit.ts:53-96`）。注意 `sdkCompatToolName()` 将内部的 `Agent` 工具名翻译回旧的 `Task` 名称，保持向后兼容。

### 3. 补全建议系统（suggestions）

**commandSuggestions.ts** — 斜杠命令模糊搜索与补全：
1. 使用 Fuse.js 构建模糊搜索索引，按 `commands` 数组身份缓存，避免每次键入重建
2. 搜索权重：命令名(3) > 命令分段/别名(2) > 描述(0.5)
3. 结果排序：精确名称匹配 > 精确别名匹配 > 前缀名称匹配 > 前缀别名匹配 > 模糊匹配，相似分数时用 `getSkillUsageScore()` 做 tiebreaker
4. 空查询（只输入 `/`）时，按 "最近使用技能(Top 5) → 内置命令 → 用户/项目/策略命令" 排列
5. `findMidInputSlashCommand()` 支持输入中间位置的斜杠命令识别
6. `findSlashCommandPositions()` 在文本中定位所有 `/command` 模式的位置，用于高亮渲染

**directoryCompletion.ts** — 目录和文件路径补全：
- 基于 LRU 缓存（500 条，TTL 5 分钟）的目录扫描结果
- `getDirectoryCompletions()` 仅返回子目录，`getPathCompletions()` 同时返回文件和目录
- `isPathLikeToken()` 识别 `~/`、`/`、`./`、`../` 等路径前缀

**shellHistoryCompletion.ts** — Shell 命令历史补全：
- 从会话历史中提取以 `!` 前缀标记的 Shell 命令（最多 50 条），TTL 60 秒缓存
- `getShellHistoryCompletion()` 精确前缀匹配，至少需要 2 字符输入
- `prependToShellHistoryCache()` 在用户执行新命令后立即更新缓存头部

**skillUsageTracking.ts** — 技能使用频率追踪：
- `recordSkillUsage()` 记录到全局配置文件，带 60 秒防抖避免频繁写盘
- `getSkillUsageScore()` 使用指数衰减算法（半衰期 7 天）计算排名分数：`usageCount × max(0.5^(daysSinceUse/7), 0.1)`（`src/utils/suggestions/skillUsageTracking.ts:44-55`）

**slackChannelSuggestions.ts** — Slack 频道补全：
- 通过 MCP Slack 服务器的 `slack_search_channels` 工具获取频道列表
- `mcpQueryFor()` 剥离最后一个 `-`/`_` 分隔的片段，避免 Slack 搜索的分词限制
- 多层缓存：Map 缓存 + 前缀复用 + inflight 去重，最大化减少 MCP 调用
- `findSlackChannelPositions()` 在文本中定位 `#channel` 模式，仅高亮已确认存在的频道

### 4. 任务输出管理（task）

**TaskOutput 类**（`src/utils/task/TaskOutput.ts`）是 Shell 命令输出的单一数据源，支持两种模式：

- **File 模式**（Bash 命令）：stdout/stderr 通过文件描述符直接写入文件，不经过 JS。进度通过共享轮询器 `#tick()` 每秒读取文件尾部 4KB 获取
- **Pipe 模式**（Hooks）：数据通过 `writeStdout()`/`writeStderr()` 进入内存缓冲，超过 8MB 限制后溢写到磁盘（`DiskTaskOutput`）

轮询器是**类级别的共享单例**：`TaskOutput.#registry` 注册所有需要进度回调的实例，`#activePolling` 是 React 可见性驱动的活跃子集，单个 `setInterval` 服务所有活跃任务（`src/utils/task/TaskOutput.ts:81-103`）。

**DiskTaskOutput 类**（`src/utils/task/diskOutput.ts`）封装异步磁盘写入：
- 使用 `O_NOFOLLOW` 防止符号链接攻击（沙箱安全）
- 写入队列 + drain 循环设计，每个 chunk 写完后立即释放，避免 `.then()` 闭包链导致的内存滞留（`src/utils/task/diskOutput.ts:178-205`）
- 磁盘上限 5GB（`MAX_TASK_OUTPUT_BYTES`），超限后截断
- `track()` 函数追踪所有 fire-and-forget 的异步操作，避免测试 teardown 后的 ENOENT 报错

**framework.ts** 提供任务生命周期管理：
- `registerTask()` / `evictTerminalTask()` 管理 AppState 中的任务注册和回收
- `generateTaskAttachments()` + `pollTasks()` 构成任务轮询主循环，每秒检查运行中任务的输出增量
- `applyTaskOffsetsAndEvictions()` 将偏移量补丁和驱逐操作应用到**最新的** AppState（非异步前的旧快照），避免竞态覆盖

**outputFormatting.ts** 提供输出截断格式化，默认上限 32000 字符（环境变量 `TASK_MAX_OUTPUT_LENGTH` 可调，上限 160000）。

**sdkProgress.ts** 发射 `task_progress` SDK 事件，携带 token 使用量、工具调用次数、持续时间等指标。

### 5. Ultraplan 关键词检测与 CCR 轮询（ultraplan）

**keyword.ts** 实现 "ultraplan"/"ultrareview" 关键词的智能检测：
- 跳过引号/反引号/括号等配对定界符内的出现
- 跳过路径上下文（`/ultraplan/`、`ultraplan.tsx`、`--ultraplan-mode`）
- 跳过以 `?` 结尾的疑问句（关于该功能的提问不应触发）
- 跳过斜杠命令输入（`/rename ultraplan foo`）
- `replaceUltraplanKeyword()` 将第一个触发位的 "ultraplan" 替换为 "plan"

**ccrSession.ts** 实现 CCR（Claude Code Remote）会话轮询，等待用户在浏览器中审批 ExitPlanMode：

`ExitPlanModeScanner` 是纯状态分类器（无 I/O），逐批摄入 SDKMessage 事件流：
1. 收集 `ExitPlanModeV2` tool_use 和对应 tool_result
2. 区分 approved（提取 `## Approved Plan:` 标记后的文本）、rejected（`is_error=true`，无 teleport 标记）、teleport（`is_error=true` 但包含 `__ULTRAPLAN_TELEPORT_LOCAL__` 标记）
3. 维护 `hasPendingPlan` 状态（有 tool_use 但无 tool_result）

`pollForApprovedExitPlanMode()` 是阻塞式轮询循环（3 秒间隔），带超时、网络错误重试（最多 5 次连续失败）、phase 变化通知（running → needs_input → plan_ready）。

### 6. 远程后台会话前置检查（background）

**preconditions.ts** 提供远程会话创建前的一系列检查函数：
- `checkNeedsClaudeAiLogin()` — OAuth 登录状态
- `checkIsGitClean()` — Git 工作目录是否干净
- `checkHasRemoteEnvironment()` — 是否有可用远程环境
- `checkIsInGitRepo()` / `checkHasGitRemote()` — Git 仓库和远程配置
- `checkGithubAppInstalled()` — GitHub App 安装状态（通过 API 调用）
- `checkGithubTokenSynced()` — GitHub Token 同步状态
- `checkRepoForRemoteAccess()` — 分层检查（GitHub App → Token Sync → None）

**remoteSession.ts** 定义 `BackgroundRemoteSession` 类型和 `checkBackgroundRemoteSessionEligibility()` 函数，后者并行执行多项前置检查并返回失败原因列表。支持 bundle seed 模式（本地 bundle 代替 GitHub 远程）（`src/utils/background/remote/remoteSession.ts:45-98`）。

### 7. 技能变更检测（skills）

**skillChangeDetector.ts** 使用 chokidar 监控技能/命令目录的文件变更：

- 监控路径：`~/.claude/skills`、`~/.claude/commands`、`.claude/skills`、`.claude/commands`、`--add-dir` 附加目录的 `.claude/skills`
- 300ms 防抖合并批量变更，避免 Git 操作导致的级联重载
- 变更触发时执行 ConfigChange Hook，被 Hook 阻止则不重载
- Bun 环境下使用 stat() 轮询（2 秒间隔）替代 fs.watch()，规避 Bun PathWatcherManager 死锁问题（`src/utils/skills/skillChangeDetector.ts:56-62`）
- 通过信号（Signal）模式通知订阅者

### 8. MCP 日期解析与 Elicitation 校验（mcp）

**dateTimeParser.ts** — 自然语言日期/时间解析：
- 通过 Haiku 模型将 "tomorrow at 3pm"、"next Monday" 等自然语言转为 ISO 8601 格式
- 构建包含当前时间、时区、星期等上下文的 prompt
- `looksLikeISO8601()` 快速判断输入是否已是标准格式

**elicitationValidation.ts** — MCP elicitation 输入校验：
- 基于 Zod 动态构建校验 Schema，支持 string（含 email/uri/date/date-time format）、number/integer（含 min/max 范围）、boolean、enum（单选/多选）
- `validateElicitationInputAsync()` 在同步校验失败且 schema 为 date/date-time 时，回退到 Haiku 自然语言解析

---

## 函数签名与参数说明

### filePersistence

#### `runFilePersistence(turnStartTime: TurnStartTime, signal?: AbortSignal): Promise<FilesPersistedEventData | null>`

执行文件持久化主流程。返回 `null` 表示未启用或无文件需要处理。

#### `isFilePersistenceEnabled(): boolean`

快速判断文件持久化是否可用（Feature Flag + 环境类型 + Token + Session ID）。

### messages

#### `toInternalMessages(messages: readonly SDKMessage[]): Message[]`

SDK 消息列表转内部消息格式。

#### `toSDKMessages(messages: Message[]): SDKMessage[]`

内部消息列表转 SDK 格式，包含 ExitPlanMode plan 注入和 local_command 输出转换。

#### `buildSystemInitMessage(inputs: SystemInitInputs): SDKMessage`

构建会话初始化元数据消息。`SystemInitInputs` 包含 tools、mcpClients、model、permissionMode、commands、agents、skills、plugins、fastMode 字段。

### suggestions

#### `generateCommandSuggestions(input: string, commands: Command[]): SuggestionItem[]`

根据用户输入生成排序后的命令建议列表。

#### `getDirectoryCompletions(partialPath: string, options?: CompletionOptions): Promise<SuggestionItem[]>`

获取目录补全建议。`options.basePath` 默认为 cwd，`maxResults` 默认 10。

#### `getShellHistoryCompletion(input: string): Promise<ShellHistoryMatch | null>`

从历史中查找最佳匹配的 Shell 命令。

#### `getSkillUsageScore(skillName: string): number`

计算技能使用频率排名分数（指数衰减，7 天半衰期）。

### task

#### `new TaskOutput(taskId: string, onProgress: ProgressCallback | null, stdoutToFile?: boolean, maxMemory?: number)`

创建任务输出实例。`stdoutToFile=true` 为 file 模式（Bash），`false` 为 pipe 模式（Hooks）。

#### `formatTaskOutput(output: string, taskId: string): { content: string; wasTruncated: boolean }`

格式化任务输出，超长时截断并添加文件路径头部。

#### `emitTaskProgress(params: {...}): void`

发射 `task_progress` SDK 事件。

### ultraplan

#### `hasUltraplanKeyword(text: string): boolean` / `hasUltrareviewKeyword(text: string): boolean`

检测文本中是否包含可触发的关键词。

#### `pollForApprovedExitPlanMode(sessionId: string, timeoutMs: number, onPhaseChange?, shouldStop?): Promise<PollResult>`

阻塞轮询 CCR 会话直到 plan 被批准或超时。返回 plan 文本和执行目标（local/remote）。

---

## 接口/类型定义

### `BackgroundRemoteSession`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 会话 ID |
| status | 'starting' \| 'running' \| 'completed' \| 'failed' \| 'killed' | 会话状态 |
| todoList | TodoList | 关联的待办列表 |
| log | SDKMessage[] | 事件日志 |

### `TodoItem`（Zod Schema 定义）

| 字段 | 类型 | 说明 |
|------|------|------|
| content | string（非空） | 待办内容 |
| status | 'pending' \| 'in\_progress' \| 'completed' | 状态 |
| activeForm | string（非空） | 活跃表单标识 |

### `MemoryType`

枚举：`'User' | 'Project' | 'Local' | 'Managed' | 'AutoMem'`，Feature Flag `TEAMMEM` 开启时增加 `'TeamMem'`。

### `UltraplanPhase`

枚举：`'running' | 'needs_input' | 'plan_ready'`——CCR 会话的三态生命周期。

### `TaskAttachment`

任务状态推送附件，包含 taskId、taskType、status、description 和 deltaSummary（增量输出）。

---

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `CLAUDE_CODE_ENVIRONMENT_KIND` | 环境变量 | — | `'byoc'` 或 `'anthropic_cloud'` |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | 环境变量 | — | 远程会话 ID |
| `TASK_MAX_OUTPUT_LENGTH` | 环境变量 | 32000 | 任务输出最大字符数（上限 160000） |
| `FILE_PERSISTENCE` | Feature Flag | — | 文件持久化开关 |
| `TEAMMEM` | Feature Flag | — | 团队记忆类型开关 |
| `UDS_INBOX` | Feature Flag | — | UDS 消息套接字路径注入 |
| TaskOutput `maxMemory` | 构造参数 | 8MB | 内存缓冲上限，溢出后写磁盘 |
| `MAX_TASK_OUTPUT_BYTES` | 常量 | 5GB | 磁盘输出上限 |
| 目录缓存 TTL | 常量 | 5 分钟 | `directoryCompletion` 的 LRU 缓存过期时间 |
| Shell 历史缓存 TTL | 常量 | 60 秒 | `shellHistoryCompletion` 的缓存刷新间隔 |
| 技能使用记录防抖 | 常量 | 60 秒 | `skillUsageTracking` 同一技能的最小写入间隔 |
| 技能变更防抖 | 常量 | 300ms | `skillChangeDetector` 合并多个文件变更事件的窗口 |

---

## 边界 Case 与注意事项

- **文件持久化安全**：`findModifiedFiles()` 跳过符号链接（防目录遍历），`DiskTaskOutput` 使用 `O_NOFOLLOW | O_EXCL` 打开文件（防沙箱内符号链接攻击）。Windows 平台回退为字符串 flag
- **TaskOutput 会话隔离**：输出目录包含 session ID，首次调用时缓存（`src/utils/task/diskOutput.ts:49-55`）。`/clear` 重新生成 session ID 不会影响已创建的 TaskOutput 实例
- **SDK 工具名兼容**：`sdkCompatToolName()` 将 `'Agent'` 映射回 `'Task'`，待下一个 minor 版本移除
- **local_command 消息过滤**：`toSDKMessages()` 仅转换包含 stdout/stderr 标签的系统消息，过滤命令输入元数据，避免泄漏到远程 UI（`src/utils/messages/mappers.ts:164-175`）
- **Fuse 索引缓存时效**：命令的 `isHidden` 状态变化（如 OAuth 过期）可能导致 Fuse 索引与当前状态不一致。精确名称匹配的隐藏命令会被前置到结果中，但会检查去重避免重复 React key
- **Bun 文件监控死锁**：Bun 的 `fs.watch()` 存在 PathWatcherManager 死锁问题，skillChangeDetector 在 Bun 环境下强制使用 stat() 轮询
- **Ultraplan 关键词误触发防护**：代码路径、引号内、路径标识符上下文、疑问句中的 "ultraplan" 均不触发，避免误启动 ultraplan 流程
- **CCR 轮询容错**：`pollForApprovedExitPlanMode()` 允许最多 5 次连续网络失败，区分瞬态错误和永久错误。scanner 的 `ingest()` 方法中 approved 优先级高于 terminated，确保 "批准后远程崩溃" 场景不丢失已批准的 plan