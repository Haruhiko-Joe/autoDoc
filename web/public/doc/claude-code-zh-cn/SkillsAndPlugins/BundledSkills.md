# 内置技能集合（BundledSkills）

## 概述与职责

BundledSkills 是 Claude Code CLI 的**内置技能注册与管理模块**，位于 `src/skills/bundled/` 目录。它属于 **SkillsAndPlugins** 子系统，被 ToolSystem 中的 SkillTool 调用以执行特定领域操作。

该模块包含 17+ 个编译进 CLI 的技能实现，每个技能通过导出 `register*Skill()` 函数并调用 `registerBundledSkill()` 完成注册。技能在启动时由 `initBundledSkills()` 统一初始化，部分技能受 feature flag 条件控制。

同级模块包括 Entrypoints（应用入口）、CoreEngine（核心引擎）、ToolSystem（工具系统）等，BundledSkills 依赖 ToolSystem 完成具体操作，同时依赖 Services 层的 MCP、OAuth 等服务。

## 关键流程

### 启动初始化流程

`index.ts` 的 `initBundledSkills()` 是整个模块的入口，在 CLI 启动时被调用（`src/skills/bundled/index.ts:24-79`）：

1. **无条件注册**：直接调用 10 个技能的注册函数——`updateConfig`、`keybindings`、`verify`、`debug`、`loremIpsum`、`skillify`、`remember`、`simplify`、`batch`、`stuck`
2. **Feature flag 条件加载**：通过 `feature()` 宏（Bun 编译时常量）检查开关，使用 `require()` 动态加载：
   - `KAIROS` / `KAIROS_DREAM` → `dream` 技能
   - `REVIEW_ARTIFACT` → `hunter` 技能
   - `AGENT_TRIGGERS` → `loop` 技能
   - `AGENT_TRIGGERS_REMOTE` → `scheduleRemoteAgents` 技能
   - `BUILDING_CLAUDE_APPS` → `claudeApi` 技能
   - `RUN_SKILL_GENERATOR` → `runSkillGenerator` 技能
3. **运行时条件加载**：`claudeInChrome` 通过 `shouldAutoEnableClaudeInChrome()` 在运行时判断是否注册
4. **Ant-only 技能**：`verify`、`stuck`、`skillify`、`loremIpsum`、`remember` 在注册函数内部检查 `process.env.USER_TYPE !== 'ant'`，非 Anthropic 内部用户时直接 return 不注册

### 技能注册机制

所有技能通过 `registerBundledSkill()` 注册到内部数组（`src/skills/bundledSkills.ts:53-100`）：

1. 接收 `BundledSkillDefinition` 对象，包含 name、description、allowedTools、getPromptForCommand 等字段
2. 如果技能定义了 `files` 字段（附带参考文件），会包装 `getPromptForCommand`，在首次调用时将文件解压到磁盘（`getBundledSkillExtractDir()`），并在 prompt 前插入基础目录路径
3. 将定义转换为 `Command` 对象（`type: 'prompt'`, `source: 'bundled'`），推入 `bundledSkills` 数组
4. 通过 `getBundledSkills()` 返回注册列表的副本供外部使用

### 技能调用流程

当用户通过斜杠命令（如 `/simplify`）或模型自动触发技能时：

1. SkillTool 根据技能名在注册表中查找对应 `Command`
2. 检查 `isEnabled` 回调（如有）判断技能是否可用
3. 调用 `getPromptForCommand(args, context)` 生成 prompt 内容（`ContentBlockParam[]`）
4. 返回的 prompt 被注入到模型上下文中，指导模型执行具体操作

## 技能一览

### 配置管理类

#### `update-config`

管理 `settings.json` 配置文件，包括权限规则、Hooks、环境变量、MCP 服务器等。是内容最丰富的技能——prompt 中嵌入了完整的 Settings Schema（动态从 Zod schema 生成）、Hooks 文档和验证流程。支持 `[hooks-only]` 前缀参数仅返回 Hooks 相关文档。

- `allowedTools`: `['Read']`
- `userInvocable`: `true`

> 源码位置：`src/skills/bundled/updateConfig.ts:445-475`

#### `keybindings-help`

自定义键盘快捷键，修改 `~/.claude/keybindings.json`。prompt 动态生成可用上下文表、动作表和保留快捷键列表（从源码中的常量数组生成，保持同步）。

- `allowedTools`: `['Read']`
- `userInvocable`: `false`（由模型自动触发）
- `isEnabled`: 依赖 `isKeybindingCustomizationEnabled()` 运行时判断

> 源码位置：`src/skills/bundled/keybindings.ts:292-327`

### 代码质量类

#### `simplify`

代码审查与清理。分三个阶段：识别 git diff 变更 → 并行启动 3 个 Agent（代码复用审查、代码质量审查、效率审查）→ 聚合发现并修复问题。

- `userInvocable`: `true`
- 无 `allowedTools` 限制

> 源码位置：`src/skills/bundled/simplify.ts:55-69`

#### `verify`（Ant-only）

验证代码变更是否按预期工作。prompt 内容从 `verify/SKILL.md` 文件加载（通过 Bun 的 text loader 编译时内联），附带 `examples/cli.md` 和 `examples/server.md` 参考文件。

- `files`: 包含 `examples/cli.md`、`examples/server.md`
- `userInvocable`: `true`

> 源码位置：`src/skills/bundled/verify.ts:12-30`

### 调试辅助类

#### `debug`

诊断当前 Claude Code 会话问题。调用时自动启用 debug 日志（如未开启），读取 debug 日志文件的末尾 64KB（避免大文件内存开销），展示最后 20 行日志，指导模型搜索 `[ERROR]` 和 `[WARN]` 条目。

- `allowedTools`: `['Read', 'Grep', 'Glob']`
- `disableModelInvocation`: `true`（需用户显式调用 `/debug`）
- `userInvocable`: `true`

> 源码位置：`src/skills/bundled/debug.ts:12-103`

#### `stuck`（Ant-only）

诊断冻结/缓慢的 Claude Code 会话。通过 `ps` 命令扫描进程，检查高 CPU、D/T/Z 状态、高内存等异常，找到问题后自动通过 Slack MCP 发送诊断报告到 `#claude-code-feedback`。

- `userInvocable`: `true`
- 仅诊断，不终止任何进程

> 源码位置：`src/skills/bundled/stuck.ts:61-79`

### API 集成类

#### `claude-api`

帮助用户使用 Claude API / Anthropic SDK 构建应用。支持 8 种语言自动检测（Python、TypeScript、Java、Go、Ruby、C#、PHP、curl），根据当前项目语言加载对应的参考文档（共约 247KB Markdown，懒加载）。

- `allowedTools`: `['Read', 'Grep', 'Glob', 'WebFetch']`
- `userInvocable`: `true`
- **Feature flag**: `BUILDING_CLAUDE_APPS`

> 源码位置：`src/skills/bundled/claudeApi.ts:180-196`

### 任务调度类

#### `loop`

在定时间隔上重复执行 prompt 或斜杠命令。解析 `[interval] <prompt>` 格式输入，支持前导间隔（`5m /foo`）、尾部 "every" 子句（`check deploy every 20m`）、默认 10 分钟。将间隔转换为 cron 表达式后调用 `CronCreate` 工具注册。

- `userInvocable`: `true`
- `isEnabled`: 委托给 `isKairosCronEnabled()`
- **Feature flag**: `AGENT_TRIGGERS`

> 源码位置：`src/skills/bundled/loop.ts:74-92`

#### `schedule`（scheduleRemoteAgents）

管理远程定时 Agent（triggers）——在 Anthropic 云端的 CCR 环境中按 cron 调度执行。支持创建、列表、更新、立即运行四种操作。自动检测 Git 仓库、MCP 连接器、云环境，处理时区转换（用户本地时间 → UTC cron）。

- `allowedTools`: `['RemoteTrigger', 'AskUserQuestion']`
- `isEnabled`: 依赖 Growthbook feature flag `tengu_surreal_dali` 和策略 `allow_remote_sessions`
- 需要 claude.ai OAuth 认证
- **Feature flag**: `AGENT_TRIGGERS_REMOTE`

> 源码位置：`src/skills/bundled/scheduleRemoteAgents.ts:324-447`

#### `batch`

并行工作编排。分三个阶段：研究和计划（Plan Mode，将工作分解为 5-30 个独立单元）→ 生成 Worker Agent（每个在独立 git worktree 中运行）→ 跟踪进度（状态表和 PR 链接）。每个 Worker 完成后自动运行 `/simplify`、测试、提交并创建 PR。

- `disableModelInvocation`: `true`（需用户显式调用 `/batch`）
- `userInvocable`: `true`
- 要求在 git 仓库中执行

> 源码位置：`src/skills/bundled/batch.ts:100-124`

### 技能创建类

#### `skillify`（Ant-only）

将当前会话的可重复流程捕获为可复用技能。通过 4 轮 AskUserQuestion 交互式访谈（确认高层信息 → 细化步骤和参数 → 逐步分解 → 最终确认），生成 `SKILL.md` 文件。读取会话记忆和用户消息历史作为分析上下文。

- `allowedTools`: `['Read', 'Write', 'Edit', 'Glob', 'Grep', 'AskUserQuestion', 'Bash(mkdir:*)']`
- `disableModelInvocation`: `true`
- `argumentHint`: `[description of the process you want to capture]`

> 源码位置：`src/skills/bundled/skillify.ts:158-197`

### 记忆管理类

#### `remember`（Ant-only）

审查自动记忆条目，提出将记忆提升到 `CLAUDE.md`、`CLAUDE.local.md` 或共享记忆的建议。分四步：收集所有记忆层 → 分类每个条目的最佳去处 → 识别重复/过时/冲突 → 呈现结构化报告。只提建议不做修改，需用户确认。

- `isEnabled`: 依赖 `isAutoMemoryEnabled()`
- `userInvocable`: `true`

> 源码位置：`src/skills/bundled/remember.ts:4-82`

### 浏览器自动化类

#### `claude-in-chrome`

Chrome 浏览器自动化，支持点击、填表、截图、读取控制台日志、导航等操作。使用 `@ant/claude-for-chrome-mcp` 包提供的工具集。

- `allowedTools`: 动态生成，映射为 `mcp__claude-in-chrome__*` 工具列表
- `isEnabled`: `shouldAutoEnableClaudeInChrome()`
- `userInvocable`: `true`

> 源码位置：`src/skills/bundled/claudeInChrome.ts:16-34`

### 测试工具类

#### `lorem-ipsum`（Ant-only）

生成填充文本用于长上下文测试。使用预定义的 200 个单 token 英文词汇随机组合，最大支持 500,000 token。

- `argumentHint`: `[token_count]`
- `userInvocable`: `true`

> 源码位置：`src/skills/bundled/loremIpsum.ts:234-282`

## 接口/类型定义

### `BundledSkillDefinition`

定义在 `src/skills/bundledSkills.ts:15-41`，是技能注册的核心接口：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | 技能标识名，对应斜杠命令 |
| `description` | `string` | 是 | 技能描述，用于模型匹配和 UI 展示 |
| `aliases` | `string[]` | 否 | 名称别名 |
| `whenToUse` | `string` | 否 | 指导模型何时自动触发此技能 |
| `argumentHint` | `string` | 否 | 参数格式提示（如 `[interval] <prompt>`） |
| `allowedTools` | `string[]` | 否 | 技能执行期间允许使用的工具列表 |
| `model` | `string` | 否 | 指定模型覆盖 |
| `disableModelInvocation` | `boolean` | 否 | `true` 时模型不能自动触发，需用户显式调用 |
| `userInvocable` | `boolean` | 否 | 是否可通过斜杠命令调用（默认 `true`） |
| `isEnabled` | `() => boolean` | 否 | 运行时启用条件回调 |
| `hooks` | `HooksSettings` | 否 | 技能专属 Hooks 配置 |
| `context` | `'inline' \| 'fork'` | 否 | 执行模式：内联或分叉子 Agent |
| `agent` | `string` | 否 | 指定 Agent 类型 |
| `files` | `Record<string, string>` | 否 | 附带的参考文件，首次调用时解压到磁盘 |
| `getPromptForCommand` | `(args, context) => Promise<ContentBlockParam[]>` | 是 | 生成技能 prompt 的核心函数 |

## 配置项与加载条件

### Feature Flags（编译时）

通过 Bun 的 `feature()` 宏在编译时决定是否包含代码：

| Flag | 控制的技能 |
|------|-----------|
| `KAIROS` / `KAIROS_DREAM` | `dream` |
| `REVIEW_ARTIFACT` | `hunter` |
| `AGENT_TRIGGERS` | `loop` |
| `AGENT_TRIGGERS_REMOTE` | `scheduleRemoteAgents` |
| `BUILDING_CLAUDE_APPS` | `claudeApi` |
| `RUN_SKILL_GENERATOR` | `runSkillGenerator` |

### 运行时条件

| 条件 | 控制的技能 |
|------|-----------|
| `process.env.USER_TYPE === 'ant'` | `verify`, `stuck`, `skillify`, `remember`, `loremIpsum` |
| `shouldAutoEnableClaudeInChrome()` | `claudeInChrome` |
| `isKeybindingCustomizationEnabled()` | `keybindings-help` |
| `isAutoMemoryEnabled()` | `remember` |
| `isKairosCronEnabled()` | `loop` |
| Growthbook `tengu_surreal_dali` + 策略 `allow_remote_sessions` | `schedule` |

## 文件解压安全机制

`bundledSkills.ts` 中包含精心设计的文件解压安全措施（`src/skills/bundledSkills.ts:131-206`）：

- **路径遍历防护**：`resolveSkillFilePath()` 规范化路径后检查 `..` 和绝对路径，防止逃逸
- **防符号链接攻击**：使用 `O_NOFOLLOW | O_EXCL` 标志打开文件，不跟随符号链接
- **权限控制**：目录 `0o700`、文件 `0o600`，仅所有者可读写
- **去重调用**：通过 Promise 记忆化确保每个技能的文件解压只执行一次，并发调用等待同一 Promise

## 边界 Case 与注意事项

- **懒加载大文件**：`claudeApi` 的 247KB 参考文档通过动态 `import()` 懒加载，仅在 `/claude-api` 实际调用时才进入内存
- **Feature flag 技能使用 `require()` 而非静态 `import`**：这是因为 Bun 的 `feature()` 宏在编译时决定代码是否包含，`require()` 配合 `if` 分支可实现 dead code elimination
- **`updateConfig` 的 Settings Schema 动态生成**：通过 `toJSONSchema(SettingsSchema())` 从 Zod schema 生成 JSON Schema，确保 prompt 中的类型信息始终与代码同步
- **`debug` 技能的日志读取优化**：仅读取文件末尾 64KB（`TAIL_READ_BYTES`），避免长会话 debug 日志导致内存飙升
- **`schedule` 技能的软启动检查**：Git 仓库和 GitHub App 权限检查不会阻塞注册，仅作为提示信息嵌入 AskUserQuestion 对话中