# SkillRegistry — 技能注册基础设施

## 概述与职责

SkillRegistry 是 **SkillsAndPlugins** 模块中的底层注册基础设施，由两个文件组成：

- **`bundledSkills.ts`**：内置技能的注册中心，维护一个模块级 `Command[]` 注册表，提供 `registerBundledSkill()` 注册函数，同时负责将技能附带的参考文件安全地解压到磁盘供模型读取。
- **`mcpSkillBuilders.ts`**：一个零依赖的桥接模块，通过 write-once 注册模式将 `loadSkillsDir` 的解析函数暴露给 MCP 技能发现系统，解决循环依赖问题。

在整体架构中，SkillRegistry 处于 SkillsAndPlugins 子系统的底层——上游的 ToolSystem 通过 SkillTool 调用技能时，最终会查询这里维护的注册表。目前有 15 个内置技能（如 `verify`、`simplify`、`loop`、`claudeApi` 等）通过 `registerBundledSkill()` 注册。

---

## 关键流程

### 1. 内置技能注册流程

1. 各技能模块（位于 `src/skills/bundled/` 目录下）在模块初始化时调用 `registerBundledSkill(definition)`
2. `registerBundledSkill()` 将 `BundledSkillDefinition` 转换为标准的 `Command` 对象，设置 `source: 'bundled'`、`loadedFrom: 'bundled'` 等元数据
3. 如果定义中包含 `files` 字段（参考文件），会包装原始的 `getPromptForCommand`，在首次调用时触发文件解压
4. 生成的 `Command` 被推入模块级数组 `bundledSkills`
5. 外部通过 `getBundledSkills()` 获取注册表的**浅拷贝**（防止外部直接修改）

### 2. 参考文件安全解压流程（核心安全逻辑）

当技能定义包含 `files` 时，首次调用该技能会触发解压：

1. **确定解压目录**：调用 `getBundledSkillExtractDir(skillName)` → 路径为 `<claudeTempDir>/bundled-skills/<VERSION>/<16字节随机nonce>/<skillName>`（`src/utils/permissions/filesystem.ts:365-369`）
2. **Promise 去重**：通过闭包变量 `extractionPromise` 实现 memoization——多个并发调用共享同一个 Promise，避免重复写入竞争（`src/skills/bundledSkills.ts:64-67`）
3. **路径校验**：`resolveSkillFilePath()` 对每个相对路径执行 `normalize()` + 路径遍历检查，拒绝绝对路径和包含 `..` 的路径（`src/skills/bundledSkills.ts:196-206`）
4. **按目录分组写入**：`writeSkillFiles()` 将文件按父目录分组，先 `mkdir(parent, { recursive: true, mode: 0o700 })` 创建目录，再并行写入文件（`src/skills/bundledSkills.ts:147-167`）
5. **安全写入**：`safeWriteFile()` 使用 `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` 标志打开文件，权限 `0o600`（`src/skills/bundledSkills.ts:186-193`）
6. **Prompt 注入**：解压成功后，在技能 prompt 前插入 `Base directory for this skill: <dir>` 前缀，让模型知道可以 Read/Grep 这些文件

**安全防护层次**：
- **per-process 随机 nonce**（主要防线）：使解压路径不可预测，防止攻击者预先创建符号链接
- **`O_EXCL`**：文件已存在则报错，不覆盖——故意不 unlink+retry，因为 unlink 会跟随中间符号链接
- **`O_NOFOLLOW`**：禁止跟随最终路径组件的符号链接
- **`0o700`/`0o600` 权限**：即使攻击者通过 inotify 获知 nonce，也无法写入 owner-only 的目录
- Windows 平台使用字符串标志 `'wx'` 代替数值标志，避免 libuv 的 `EINVAL` 问题

### 3. MCP 技能构建器桥接流程

1. `loadSkillsDir.ts` 在模块初始化时（顶层代码）调用 `registerMCPSkillBuilders()`，注册 `createSkillCommand` 和 `parseSkillFrontmatterFields` 两个函数（`src/skills/loadSkillsDir.ts:1083`）
2. `loadSkillsDir.ts` 通过 `commands.ts` 的静态 import 链在启动时被 eagerly evaluated，确保在任何 MCP 服务器连接前完成注册
3. MCP 技能发现模块调用 `getMCPSkillBuilders()` 获取这两个函数；若未注册则抛出明确错误

**为什么需要这个桥接**：`loadSkillsDir.ts` 的传递依赖几乎覆盖整个代码库，如果 MCP 技能发现模块直接 import 它，会在依赖图中引入大量循环。`mcpSkillBuilders.ts` 作为"依赖图叶节点"（只 import 类型），使两端都能依赖它而不形成环。Bun 打包器的 `/$bunfs/root/` 虚拟路径也使动态 import 方案不可行。

---

## 函数签名与参数说明

### `registerBundledSkill(definition: BundledSkillDefinition): void`

注册一个内置技能到全局注册表。

- **definition**：技能定义对象（见下方类型定义）
- 无返回值，副作用是向模块级 `bundledSkills` 数组追加一个 `Command`

> 源码位置：`src/skills/bundledSkills.ts:53-100`

### `getBundledSkills(): Command[]`

获取所有已注册的内置技能。返回数组浅拷贝以防止外部修改。

> 源码位置：`src/skills/bundledSkills.ts:106-108`

### `clearBundledSkills(): void`

清空注册表，仅供测试使用。

> 源码位置：`src/skills/bundledSkills.ts:113-115`

### `getBundledSkillExtractDir(skillName: string): string`

返回指定技能的参考文件解压目录路径。

> 源码位置：`src/skills/bundledSkills.ts:120-122`

### `registerMCPSkillBuilders(b: MCPSkillBuilders): void`

注册 MCP 技能构建函数。Write-once 语义——只应在 `loadSkillsDir.ts` 模块初始化时调用一次。

> 源码位置：`src/skills/mcpSkillBuilders.ts:33-35`

### `getMCPSkillBuilders(): MCPSkillBuilders`

获取已注册的 MCP 技能构建函数。未注册时抛出 `Error`。

> 源码位置：`src/skills/mcpSkillBuilders.ts:37-44`

---

## 接口/类型定义

### `BundledSkillDefinition`

内置技能的定义类型，是 `registerBundledSkill()` 的入参：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 是 | 技能名称，作为 `/name` 形式的调用标识 |
| `description` | `string` | 是 | 技能描述 |
| `aliases` | `string[]` | 否 | 备用名称 |
| `whenToUse` | `string` | 否 | 告诉模型何时应调用此技能的提示 |
| `argumentHint` | `string` | 否 | 参数提示 |
| `allowedTools` | `string[]` | 否 | 技能执行时可用的工具列表（默认 `[]`） |
| `model` | `string` | 否 | 指定使用的模型 |
| `disableModelInvocation` | `boolean` | 否 | 禁止模型主动调用（默认 `false`） |
| `userInvocable` | `boolean` | 否 | 用户是否可通过 `/name` 手动调用（默认 `true`） |
| `isEnabled` | `() => boolean` | 否 | 动态启用/禁用判断函数 |
| `hooks` | `HooksSettings` | 否 | 技能关联的 hooks 配置 |
| `context` | `'inline' \| 'fork'` | 否 | 执行上下文模式 |
| `agent` | `string` | 否 | 关联的 agent 类型 |
| `files` | `Record<string, string>` | 否 | 参考文件（key=相对路径，value=内容），首次调用时解压到磁盘 |
| `getPromptForCommand` | `(args, context) => Promise<ContentBlockParam[]>` | 是 | 生成技能 prompt 的异步函数 |

> 源码位置：`src/skills/bundledSkills.ts:15-41`

### `MCPSkillBuilders`

MCP 技能构建器的类型定义，包含两个从 `loadSkillsDir.ts` 导出的函数引用：

| 字段 | 类型 | 说明 |
|------|------|------|
| `createSkillCommand` | `typeof createSkillCommand` | 创建技能命令对象 |
| `parseSkillFrontmatterFields` | `typeof parseSkillFrontmatterFields` | 解析技能 frontmatter 元数据 |

> 源码位置：`src/skills/mcpSkillBuilders.ts:26-29`

---

## 边界 Case 与注意事项

- **解压失败的优雅降级**：如果文件解压失败（权限问题、磁盘满等），`extractBundledSkillFiles()` 返回 `null`，技能仍然正常工作，只是不会在 prompt 前注入 base directory 前缀。失败信息通过 `logForDebugging` 记录（`src/skills/bundledSkills.ts:139-144`）。

- **路径遍历防护**：`resolveSkillFilePath()` 会拒绝绝对路径和包含 `..` 的路径，同时在 Unix 和 Windows 路径分隔符下都做检查（`src/skills/bundledSkills.ts:198-203`）。

- **`EEXIST` 不重试**：如果目标文件已存在（`O_EXCL` 触发 `EEXIST`），不会 unlink 后重试。这是故意的安全决策——`unlink()` 会跟随中间符号链接，重试可能被利用。

- **并发安全**：对同一技能的并发首次调用通过 Promise memoization 处理——所有调用者等待同一个解压 Promise，不会出现写入竞争。

- **`getMCPSkillBuilders()` 的时序要求**：调用前必须确保 `loadSkillsDir.ts` 已被 evaluated。在正常启动流程中，静态 import 链保证了这一点；但如果在测试或非标准启动路径中直接调用，会得到明确的错误提示。

- **`getBundledSkills()` 返回浅拷贝**：防止调用方通过引用修改注册表，但注意 `Command` 对象内部的属性（如 `allowedTools` 数组）仍是共享引用。