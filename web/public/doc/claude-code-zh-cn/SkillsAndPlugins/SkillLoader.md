# SkillLoader — 目录级技能加载器

## 概述与职责

SkillLoader（`src/skills/loadSkillsDir.ts`）是 **SkillsAndPlugins** 子系统的核心加载模块，负责从多层级目录中扫描、解析和注册 Markdown 格式的技能文件，将其转化为可执行的 `Command` 对象。它是 Claude Code 技能扩展机制的基础设施——所有目录级技能（项目级、用户级、托管级）的发现和加载都经由此模块完成。

在整体架构中，SkillLoader 属于 **SkillsAndPlugins** 模块，被 **ToolSystem** 中的 SkillTool 调用以获取可用技能列表，同时依赖 **Services** 层的 MCP 模块进行技能构建函数的桥接注册。

## 关键流程

### 1. 主加载流程：`getSkillDirCommands(cwd)`

这是整个模块的入口函数（`src/skills/loadSkillsDir.ts:638-804`），使用 `memoize` 缓存结果，确保同一 `cwd` 只加载一次。

**执行步骤：**

1. **确定搜索目录**：计算三个层级的 skills 目录路径——托管级（`managedSkillsDir`）、用户级（`userSkillsDir`）、项目级（从 cwd 向上遍历至 home 目录）
2. **Bare 模式短路**：如果运行在 `--bare` 模式下，跳过自动发现，仅加载 `--add-dir` 指定的显式路径
3. **并行加载**：通过 `Promise.all` 同时从 5 个来源加载技能：
   - 托管级 `/skills/`（可通过 `CLAUDE_CODE_DISABLE_POLICY_SKILLS` 环境变量禁用）
   - 用户级 `/skills/`（受 `userSettings` 开关控制）
   - 项目级 `/skills/`（受 `projectSettings` 开关和 `pluginOnly` 策略控制）
   - `--add-dir` 附加目录
   - 旧版 `/commands/` 目录（兼容性支持）
4. **去重**：通过 `realpath` 解析符号链接，获取文件的真实路径作为唯一标识，按"先到先得"策略去除重复技能
5. **条件技能分离**：将带有 `paths` frontmatter 的技能存入 `conditionalSkills` Map，仅在匹配文件被操作时才激活；无条件技能直接返回

### 2. 单目录加载：`loadSkillsFromSkillsDir(basePath, source)`

扫描指定 `/skills/` 目录（`src/skills/loadSkillsDir.ts:407-480`）：

1. 读取目录下所有条目
2. 只处理**目录格式**的技能：`skill-name/SKILL.md`（单独的 `.md` 文件不被识别）
3. 读取 `SKILL.md` 文件内容，调用 `parseFrontmatter()` 解析 YAML frontmatter
4. 调用 `parseSkillFrontmatterFields()` 提取所有元数据字段
5. 调用 `createSkillCommand()` 构建 `Command` 对象

### 3. Frontmatter 解析：`parseSkillFrontmatterFields()`

从 YAML frontmatter 中提取并验证所有技能配置字段（`src/skills/loadSkillsDir.ts:185-265`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | 目录名 | 技能的显示名称 |
| `description` | string | 从 Markdown 内容提取 | 技能描述 |
| `allowed-tools` | string[] | `[]` | 技能执行时允许使用的工具列表 |
| `argument-hint` | string | undefined | 参数提示文本 |
| `arguments` | string/string[] | `[]` | 命名参数列表 |
| `when_to_use` | string | undefined | 指导模型何时自动调用此技能 |
| `model` | string | undefined | 指定执行模型（`'inherit'` 表示继承父级） |
| `disable-model-invocation` | boolean | false | 禁止模型自动调用 |
| `user-invocable` | boolean | true | 用户是否可通过 `/` 命令手动调用 |
| `hooks` | HooksSettings | undefined | 技能关联的钩子配置（经 `HooksSchema` 校验） |
| `context` | `'fork'` | undefined | 执行上下文模式 |
| `agent` | string | undefined | 指定 agent 类型 |
| `effort` | EffortValue | undefined | 推理努力级别 |
| `shell` | FrontmatterShell | undefined | shell 命令配置 |
| `paths` | string[] | undefined | gitignore 风格的路径模式，用于条件激活 |
| `version` | string | undefined | 技能版本号 |

### 4. Command 对象构建：`createSkillCommand()`

将解析后的元数据组装为 `Command` 对象（`src/skills/loadSkillsDir.ts:270-401`）。关键在于 `getPromptForCommand(args, toolUseContext)` 方法——技能被调用时的实际执行逻辑：

1. **注入基础目录**：如果技能有 `baseDir`，在内容前添加 `Base directory for this skill: ...`
2. **参数替换**：调用 `substituteArguments()` 替换 `$ARGUMENTS` 和命名参数占位符
3. **变量替换**：
   - `${CLAUDE_SKILL_DIR}` → 技能所在目录路径（Windows 下自动转换反斜杠）
   - `${CLAUDE_SESSION_ID}` → 当前会话 ID
4. **Shell 命令执行**：对非 MCP 来源的技能，调用 `executeShellCommandsInPrompt()` 执行内嵌的 shell 命令（`` !`...` `` 或 `` ```! ... ``` `` 语法）。MCP 技能因安全原因被**显式跳过**
5. 返回最终的 `[{ type: 'text', text: finalContent }]`

### 5. 动态技能发现：`discoverSkillDirsForPaths()` + `addSkillDirectories()`

运行时根据文件操作路径动态发现新的技能目录（`src/skills/loadSkillsDir.ts:861-975`）：

1. `discoverSkillDirsForPaths(filePaths, cwd)`：从文件路径的父目录开始向上遍历至 cwd，查找 `.claude/skills/` 目录
   - 使用 `dynamicSkillDirs` Set 记录已检查过的路径，避免重复 stat 调用
   - 检查目录是否被 `.gitignore` 排除
   - 返回结果按路径深度排序（最深优先）
2. `addSkillDirectories(dirs)`：加载发现的目录中的技能并合并到 `dynamicSkills` Map
   - 加载顺序为先浅后深，深层目录的同名技能覆盖浅层的
   - 加载完成后通过 `skillsLoaded.emit()` 发送信号，通知其他模块刷新缓存

### 6. 条件技能激活：`activateConditionalSkillsForPaths()`

当用户操作的文件路径匹配某个条件技能的 `paths` 模式时，将其激活（`src/skills/loadSkillsDir.ts:997-1058`）：

1. 使用 `ignore` 库（与 `.gitignore` 相同的匹配规则）检查文件相对路径
2. 匹配成功后将技能从 `conditionalSkills` 移至 `dynamicSkills`，记入 `activatedConditionalSkillNames`（跨缓存清理持久化）
3. 触发 `skillsLoaded` 信号和分析事件

## 函数签名

### `getSkillDirCommands(cwd: string): Promise<Command[]>`

主入口，加载所有目录级技能。结果通过 `memoize` 缓存。

### `getSkillsPath(source: SettingSource | 'plugin', dir: 'skills' | 'commands'): string`

根据来源类型返回对应的技能目录路径（`src/skills/loadSkillsDir.ts:78-94`）：
- `policySettings` → `<managedPath>/.claude/<dir>`
- `userSettings` → `<claudeConfigHome>/<dir>`
- `projectSettings` → `.claude/<dir>`（相对路径）

### `estimateSkillFrontmatterTokens(skill: Command): number`

基于技能的 name、description、whenToUse 字段估算 token 占用（`src/skills/loadSkillsDir.ts:100-105`）。仅计算 frontmatter 信息，因为技能的完整内容只在调用时才加载。

### `discoverSkillDirsForPaths(filePaths: string[], cwd: string): Promise<string[]>`

从文件路径向上遍历发现新的技能目录。返回按深度降序排列的目录列表。

### `addSkillDirectories(dirs: string[]): Promise<void>`

将发现的目录中的技能加载到动态技能 Map 中，并发出变更信号。

### `activateConditionalSkillsForPaths(filePaths: string[], cwd: string): string[]`

检查文件路径是否匹配条件技能的 paths 模式，激活匹配的技能。返回新激活的技能名称列表。

### `onDynamicSkillsLoaded(callback: () => void): () => void`

注册技能变更监听器，返回取消订阅函数（`src/skills/loadSkillsDir.ts:839-851`）。回调在 try/catch 中执行，单个监听器异常不会中断其他监听器。

### `clearSkillCaches(): void`

清除所有缓存状态——`getSkillDirCommands` 的 memoize 缓存、`loadMarkdownFilesForSubdir` 缓存、条件技能和已激活记录。

## 接口/类型定义

### `LoadedFrom`

```typescript
type LoadedFrom =
  | 'commands_DEPRECATED'  // 旧版 /commands/ 目录
  | 'skills'               // /skills/ 目录
  | 'plugin'               // 插件来源
  | 'managed'              // 托管策略来源
  | 'bundled'              // 内置技能
  | 'mcp'                  // MCP 服务器来源
```

标识技能的加载来源，用于去重日志、安全策略（MCP 技能禁止执行 shell 命令）等场景。

### `SkillWithPath`（内部类型）

```typescript
type SkillWithPath = {
  skill: Command
  filePath: string
}
```

加载过程中用于跟踪技能与其源文件路径的配对，支持基于 `realpath` 的去重。

## 配置项与默认值

- **`CLAUDE_CODE_DISABLE_POLICY_SKILLS`**：环境变量，设为 truthy 值时跳过托管级技能加载
- **`--bare` 模式**：跳过所有自动目录发现，仅加载 `--add-dir` 显式指定的路径
- **`pluginOnly` 策略**：当 skills 被限制为仅插件来源时，跳过项目级/用户级/旧版目录加载
- **技能文件格式**：必须为 `<skill-name>/SKILL.md` 目录结构（`/skills/` 目录中不支持独立 `.md` 文件）

## 边界 Case 与注意事项

- **符号链接去重**：通过 `realpath()` 解析符号链接后比对，避免同一文件通过不同路径被重复加载。这修复了在虚拟/容器/NFS 文件系统上 inode 值不可靠（如 inode 0）的问题（参见 issue #13893）
- **MCP 技能安全限制**：来自 MCP 的技能被视为不可信的远程内容，其 Markdown 中的内嵌 shell 命令（`` !`...` ``）**永远不会被执行**（`src/skills/loadSkillsDir.ts:374`）
- **gitignore 过滤**：动态发现的技能目录会检查是否被 `.gitignore` 排除，防止 `node_modules` 等目录下的技能被意外加载
- **条件技能持久性**：`activatedConditionalSkillNames` 在 `clearSkillCaches()` 时会被清除，但在单次会话的常规缓存刷新中保持。一旦激活，技能在当前会话内持续可用
- **旧版 `/commands/` 兼容**：仍支持 `commands_DEPRECATED` 格式，同时支持目录格式（`SKILL.md`）和单文件格式（`name.md`）。多个 `SKILL.md` 存在同一目录时只取第一个
- **命名空间**：嵌套目录结构通过冒号分隔的命名空间表示（如 `parent:child:skill-name`），由 `buildNamespace()` 生成（`src/skills/loadSkillsDir.ts:523-534`）
- **MCP 桥接注册**：文件末尾通过 `registerMCPSkillBuilders()` 将 `createSkillCommand` 和 `parseSkillFrontmatterFields` 注册到 MCP 桥接模块，避免循环依赖（`src/skills/loadSkillsDir.ts:1083-1086`）
- **Windows 兼容**：`${CLAUDE_SKILL_DIR}` 替换时，Windows 平台自动将反斜杠转换为正斜杠，确保 shell 命令正常执行