# CommandRegistry — 命令中央注册表与聚合引擎

## 概述与职责

`commands.ts` 是整个斜杠命令系统的**入口和调度中枢**，位于 `CoreEngine > CommandSystem` 层级中。它从多个来源收集并聚合所有斜杠命令，对外提供统一的命令查询、过滤和缓存管理接口。

在架构中，它被 `QueryEngine` 依赖——QueryEngine 通过它加载可用的斜杠命令列表，并通过 `getSlashCommandToolSkills` 将命令暴露为 SkillTool 可调用的技能。同级模块包括 QueryLoop（查询主循环）、ContextBuilder（上下文构建）、CostTracking（费用追踪）和 InputHistory（输入历史）。

**命令来源**包括：
1. **内置命令（COMMANDS）**：80+ 个静态导入的斜杠命令（`/help`、`/compact`、`/config` 等）
2. **技能目录命令（skillDirCommands）**：从 `/skills/` 目录动态加载
3. **打包技能（bundledSkills）**：在启动时同步注册的内置技能
4. **插件命令（pluginCommands / pluginSkills）**：来自插件系统
5. **内置插件技能（builtinPluginSkills）**：来自启用的内置插件
6. **工作流命令（workflowCommands）**：通过 `WORKFLOW_SCRIPTS` 特性门控加载
7. **动态技能（dynamicSkills）**：在文件操作过程中发现的技能
8. **MCP 技能**：从 MCP 服务器加载的 prompt 类型命令（独立于 `getCommands`，通过 `getMcpSkillCommands` 提供）

## 关键流程

### 命令加载与聚合流程

整个加载链的核心入口是 `getCommands(cwd)`，它是一个两阶段流程：

1. **阶段一：加载所有命令源**（`loadAllCommands`，memoize 缓存）
   - 并行加载三类异步来源：技能（`getSkills`）、插件命令（`getPluginCommands`）、工作流命令（`getWorkflowCommands`）
   - `getSkills` 内部再并行加载 `skillDirCommands` 和 `pluginSkills`，同步获取 `bundledSkills` 和 `builtinPluginSkills`
   - 所有来源合并时有固定优先级顺序：`bundledSkills > builtinPluginSkills > skillDirCommands > workflowCommands > pluginCommands > pluginSkills > COMMANDS()`（`src/commands.ts:460-468`）

2. **阶段二：实时过滤**（每次调用都重新执行）
   - 对每个命令依次检查 `meetsAvailabilityRequirement`（认证/提供商过滤）和 `isCommandEnabled`（特性门控过滤）
   - 合并动态技能（去重后插入到内置命令之前的位置）（`src/commands.ts:476-517`）

**设计要点**：加载是昂贵操作（磁盘 I/O、动态 import），所以用 `memoize` 按 `cwd` 缓存；但可用性和启用状态检查每次都重新执行，确保认证状态变更（如执行 `/login`）能立即生效。

### 内置命令初始化

`COMMANDS` 函数本身也被 `memoize` 包装（`src/commands.ts:258`），惰性求值。这是因为底层某些命令的构造依赖配置读取，而配置在模块初始化时尚不可用。

在内置命令列表中，有两类条件加载策略：

- **特性门控（feature flag）**：通过 `bun:bundle` 的 `feature()` 函数在构建时进行死代码消除。例如 `PROACTIVE`、`KAIROS`、`BRIDGE_MODE`、`VOICE_MODE`、`WORKFLOW_SCRIPTS` 等（`src/commands.ts:62-123`）
- **环境门控**：`INTERNAL_ONLY_COMMANDS` 仅在 `USER_TYPE === 'ant'` 且非 Demo 模式下加入（`src/commands.ts:343-345`）；`login`/`logout` 仅在非第三方服务模式下可用（`src/commands.ts:337`）

### 惰性加载示例：insights 命令

`usageReport`（`/insights`）是一个惰性加载的典型案例——因为其实现模块有 113KB / 3200 行，所以用一个轻量 shim 包装，仅在用户实际调用时才 `await import('./commands/insights.js')`（`src/commands.ts:190-202`）。

### 可用性过滤流程（meetsAvailabilityRequirement）

该函数根据命令声明的 `availability` 字段判断当前用户是否有权看到该命令（`src/commands.ts:417-443`）：

- **无 `availability` 字段**：所有人可见
- **`'claude-ai'`**：仅 Claude AI 订阅者（Pro/Max/Team/Enterprise）
- **`'console'`**：仅 Console API Key 用户（直接使用 api.anthropic.com，排除第三方和自定义网关）

此函数**不做 memoize**，因为认证状态可能在会话中变化。

### SkillTool 命令筛选

两个面向 SkillTool 的过滤函数用于将命令暴露给模型：

- **`getSkillToolCommands`**（`src/commands.ts:563-581`）：返回所有模型可调用的 prompt 命令。过滤条件为 `type === 'prompt'`、非 `disableModelInvocation`、非 `builtin` source，且必须来自 `bundled`/`skills`/`commands_DEPRECATED` 来源或拥有用户指定的描述/whenToUse
- **`getSlashCommandToolSkills`**（`src/commands.ts:586-608`）：更严格的过滤，返回纯技能子集——必须来自 `skills`/`plugin`/`bundled` 来源或设置了 `disableModelInvocation`，且需要有描述或 whenToUse

两者均使用 `memoize` 缓存。

## 函数签名与参数说明

### `getCommands(cwd: string): Promise<Command[]>`

主入口函数。返回当前用户可用的所有命令列表。

- **cwd**：当前工作目录，用于定位技能目录和工作流脚本
- **返回值**：经过可用性过滤和启用状态检查的命令数组

> 源码位置：`src/commands.ts:476-517`

### `meetsAvailabilityRequirement(cmd: Command): boolean`

检查命令是否满足当前用户的认证/提供商要求。

- 无 `availability` 声明的命令始终返回 `true`
- 不做缓存，每次调用实时评估

> 源码位置：`src/commands.ts:417-443`

### `findCommand(commandName: string, commands: Command[]): Command | undefined`

在命令列表中按 `name`、`userFacingName` 或 `aliases` 查找命令。

> 源码位置：`src/commands.ts:688-698`

### `getCommand(commandName: string, commands: Command[]): Command`

同 `findCommand`，但未找到时抛出 `ReferenceError`，错误信息中列出所有可用命令名及别名。

> 源码位置：`src/commands.ts:704-719`

### `hasCommand(commandName: string, commands: Command[]): boolean`

判断命令是否存在，内部委托给 `findCommand`。

> 源码位置：`src/commands.ts:700-702`

### `clearCommandsCache(): void`

完整缓存清理——清除命令 memoize 缓存、插件命令缓存、插件技能缓存和技能目录缓存。

> 源码位置：`src/commands.ts:534-539`

### `clearCommandMemoizationCaches(): void`

仅清除 memoize 层缓存（`loadAllCommands`、`getSkillToolCommands`、`getSlashCommandToolSkills`），不清除底层技能/插件缓存。用于动态技能添加后刷新命令列表。同时清除 `clearSkillIndexCache`（如果 `EXPERIMENTAL_SKILL_SEARCH` 特性开启）。

> 源码位置：`src/commands.ts:523-532`

### `getMcpSkillCommands(mcpCommands: readonly Command[]): readonly Command[]`

从 AppState 的 MCP 命令列表中过滤出可作为技能使用的 MCP 命令（`type === 'prompt'`、`loadedFrom === 'mcp'`、非 `disableModelInvocation`）。受 `MCP_SKILLS` 特性门控。

> 源码位置：`src/commands.ts:547-559`

### `getSkillToolCommands(cwd: string): Promise<Command[]>`

返回 SkillTool 可展示的所有 prompt 命令。memoize 缓存。

> 源码位置：`src/commands.ts:563-581`

### `getSlashCommandToolSkills(cwd: string): Promise<Command[]>`

返回纯技能子集，用于 Skill 系统的 slash command 列表。memoize 缓存。有容错处理——加载失败时返回空数组而非抛出异常。

> 源码位置：`src/commands.ts:586-608`

### `isBridgeSafeCommand(cmd: Command): boolean`

判断命令是否可安全通过 Remote Control 桥接执行。`local-jsx` 类型始终阻止；`prompt` 类型始终允许；`local` 类型需在 `BRIDGE_SAFE_COMMANDS` 白名单中。

> 源码位置：`src/commands.ts:672-676`

### `filterCommandsForRemoteMode(commands: Command[]): Command[]`

过滤出仅在远程模式（`--remote`）下安全的命令子集。

> 源码位置：`src/commands.ts:684-686`

### `formatDescriptionWithSource(cmd: Command): string`

为用户界面格式化命令描述，附加来源标注（如 `(workflow)`、`(plugin名称)`、`(bundled)` 等）。仅用于 typeahead/help 等用户界面，模型 prompt 中应直接使用 `cmd.description`。

> 源码位置：`src/commands.ts:728-754`

## 接口/类型定义

核心类型定义在 `src/types/command.ts` 中：

### `Command`

联合类型，由 `CommandBase` 与三种命令实现类型之一组合：

```typescript
type Command = CommandBase & (PromptCommand | LocalCommand | LocalJSXCommand)
```

- **`PromptCommand`**（`type: 'prompt'`）：生成提示文本发送给模型的命令（技能）。包含 `getPromptForCommand` 方法、`source` 来源标识、可选的 hooks/skillRoot/context/agent 等字段
- **`LocalCommand`**（`type: 'local'`）：本地执行、返回文本结果的命令
- **`LocalJSXCommand`**（`type: 'local-jsx'`）：本地执行、渲染 Ink JSX UI 的命令

### `CommandBase` 关键字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 命令名称 |
| `description` | `string` | 命令描述 |
| `aliases` | `string[]` | 命令别名 |
| `availability` | `CommandAvailability[]` | 认证/提供商可用性声明 |
| `isEnabled` | `() => boolean` | 特性门控启用函数 |
| `isHidden` | `boolean` | 是否在 typeahead/help 中隐藏 |
| `loadedFrom` | `'commands_DEPRECATED' \| 'skills' \| 'plugin' \| 'managed' \| 'bundled' \| 'mcp'` | 命令加载来源 |
| `disableModelInvocation` | `boolean` | 禁止模型调用此命令 |
| `userInvocable` | `boolean` | 用户是否可通过 /name 调用 |
| `whenToUse` | `string` | 模型判断何时使用此命令的提示 |
| `kind` | `'workflow'` | 区分工作流命令 |
| `immediate` | `boolean` | 是否绕过队列立即执行 |

### `CommandAvailability`

```typescript
type CommandAvailability = 'claude-ai' | 'console'
```

## 远程/桥接安全白名单

### `REMOTE_SAFE_COMMANDS`

在 `--remote` 模式下可用的命令白名单（`src/commands.ts:619-637`）。这些命令仅影响本地 TUI 状态，不依赖本地文件系统、Git、Shell 等执行环境。包括：`session`、`exit`、`clear`、`help`、`theme`、`color`、`vim`、`cost`、`usage`、`copy`、`btw`、`feedback`、`plan`、`keybindings`、`statusline`、`stickers`、`mobile`。

用于两处：
1. `main.tsx` 中在 REPL 渲染前预过滤命令（防止 CCR 初始化前短暂暴露不安全命令）
2. REPL 的 `handleRemoteInit` 中保留仅本地命令

### `BRIDGE_SAFE_COMMANDS`

通过 Remote Control 桥接（手机/Web 客户端）可安全执行的 `local` 类型命令白名单（`src/commands.ts:651-660`）。包括：`compact`、`clear`、`cost`、`summary`、`releaseNotes`、`files`。

背景：PR #19134 出于安全考虑全面阻止了桥接输入的斜杠命令（因为 `/model` 从 iOS 触发了本地 Ink picker）。`isBridgeSafeCommand` 对此做了细化放宽——`prompt` 类型天然安全（只生成文本），`local-jsx` 类型始终阻止（会渲染 UI），`local` 类型需在白名单中。

## 缓存策略

模块使用多层 `lodash-es/memoize` 缓存：

| 缓存点 | 键 | 说明 |
|--------|-----|------|
| `COMMANDS()` | 无参（单例） | 内置命令数组，首次调用后永久缓存 |
| `builtInCommandNames()` | 无参（单例） | 内置命令名称集合 |
| `loadAllCommands(cwd)` | `cwd` | 所有来源的命令合并结果 |
| `getSkillToolCommands(cwd)` | `cwd` | SkillTool 可用命令 |
| `getSlashCommandToolSkills(cwd)` | `cwd` | Slash command 技能子集 |

清理策略分两级：
- **`clearCommandMemoizationCaches`**：仅清除 memoize 缓存和 skillSearch 索引缓存，用于动态技能添加场景
- **`clearCommandsCache`**：完整清理，额外清除插件命令缓存、插件技能缓存和技能目录缓存

## 边界 Case 与注意事项

- **`meetsAvailabilityRequirement` 不缓存**：认证状态可在会话中变化（如用户执行 `/login`），所以必须每次实时评估，不能 memoize
- **`getSkills` 的容错设计**：每个异步来源（skillDirCommands、pluginSkills）都有独立的 `.catch` 处理，单个来源加载失败不会影响其他来源。外层还有兜底 try-catch 返回全空结果
- **`getSlashCommandToolSkills` 的容错**：加载失败时返回空数组而非抛出异常，因为技能是非关键功能，不应阻塞整个系统
- **`INTERNAL_ONLY_COMMANDS`**：仅在内部构建（`USER_TYPE === 'ant'`）中包含，外部构建通过死代码消除移除
- **动态技能去重**：`getCommands` 在合并动态技能时，会按名称去重，已存在的命令不会被动态技能覆盖（`src/commands.ts:492-498`）
- **动态技能插入位置**：去重后的动态技能被插入到内置命令之前、外部来源命令之后，保持优先级语义（`src/commands.ts:505-516`）
- **`clearSkillIndexCache` 的必要性**：lodash memoize 的特性决定了仅清除内层缓存（`loadAllCommands` 等）对外层缓存（`getSkillIndex`）无效，因为外层在 cache hit 时根本不会调用内层函数，所以必须显式清除（`src/commands.ts:527-531`）