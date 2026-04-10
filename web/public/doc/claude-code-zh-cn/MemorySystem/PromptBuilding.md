# 记忆系统提示词构建（PromptBuilding）

## 概述与职责

本模块是 **MemorySystem** 的提示词构建层，负责将记忆系统的行为规范和已有记忆内容组装为系统提示词文本，注入到 Claude 的对话上下文中。它解决的核心问题是：**告诉模型如何使用记忆系统**——包括记忆的分类体系、存取规则、保存流程、以及已有记忆索引的加载。

模块由三个文件组成：

- **`memdir.ts`**：核心入口，提供提示词构建函数和 `loadMemoryPrompt` 多模式分发
- **`memoryTypes.ts`**：定义四类记忆类型的分类体系和对应的提示词段落常量
- **`teamMemPrompts.ts`**：构建自动记忆 + 团队记忆双目录联合提示词

在整体架构中，本模块属于 MemorySystem 子系统，与 Infrastructure 层的文件系统工具函数和路径管理配合工作。其输出（提示词文本）被 CoreEngine 的系统提示词构建流程消费。

## 关键流程

### loadMemoryPrompt：多模式分发入口

`loadMemoryPrompt()` 是整个模块的顶层入口（`src/memdir/memdir.ts:419-507`），根据当前环境的特性开关和配置，选择不同的提示词构建策略。分发优先级如下：

1. **KAIROS 日志模式**（最高优先级）：当 `feature('KAIROS')` 启用且自动记忆开启且 KAIROS 活跃时，调用 `buildAssistantDailyLogPrompt()`。这是为长生命周期的 Assistant 会话设计的，记忆以 append-only 的每日日志文件形式写入，而非维护 `MEMORY.md` 索引。
2. **团队记忆模式**：当 `feature('TEAMMEM')` 启用且团队记忆已开启时，调用 `teamMemPrompts.buildCombinedMemoryPrompt()`，生成包含私有目录和团队目录双目录的联合提示词。
3. **自动记忆模式**（默认）：调用 `buildMemoryLines()` 生成单目录的记忆指令提示词。
4. **禁用状态**：记忆功能被环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY` 或设置项 `autoMemoryEnabled` 关闭时，记录遥测事件并返回 `null`。

每个分支都会调用 `ensureMemoryDirExists()` 确保目录存在，并通过 `logMemoryDirCounts()` 异步上报目录统计信息。

### buildMemoryLines：核心提示词组装

`buildMemoryLines()` 函数（`src/memdir/memdir.ts:199-266`）是提示词的核心组装器。它将多个提示词段落拼接成完整的记忆系统使用指南：

1. 标题和目录路径说明（包含 `DIR_EXISTS_GUIDANCE` 防止模型浪费回合检查目录）
2. 记忆系统的总体目标描述
3. 四类记忆类型定义（从 `memoryTypes.ts` 导入 `TYPES_SECTION_INDIVIDUAL`）
4. 不应保存的内容清单（`WHAT_NOT_TO_SAVE_SECTION`）
5. 记忆保存流程（受 `skipIndex` 参数控制是否包含 MEMORY.md 索引步骤）
6. 记忆访问时机（`WHEN_TO_ACCESS_SECTION`）
7. 记忆可信度校验（`TRUSTING_RECALL_SECTION`）
8. 与 Plan/Task 等其他持久化机制的关系说明
9. 可选的搜索历史上下文段落（`buildSearchingPastContextSection`）

参数 `skipIndex` 控制保存流程的简繁：当为 `true` 时跳过 MEMORY.md 索引的两步保存流程，简化为直接写入文件。这由特性开关 `tengu_moth_copse` 控制。

### buildMemoryPrompt：带 MEMORY.md 内容的完整提示词

`buildMemoryPrompt()` 函数（`src/memdir/memdir.ts:272-316`）在 `buildMemoryLines()` 的基础上，同步读取 `MEMORY.md` 文件内容并附加到提示词末尾。主要用于 Agent 记忆场景（Agent 没有 `getClaudeMds()` 等替代注入机制）。如果 `MEMORY.md` 有内容，会经过截断处理后附加；若为空，则附加空状态提示。

### MEMORY.md 截断逻辑

`truncateEntrypointContent()` 函数（`src/memdir/memdir.ts:57-103`）实现双重截断保护：

1. **行数截断**：超过 `MAX_ENTRYPOINT_LINES`（200 行）时，截取前 200 行
2. **字节截断**：超过 `MAX_ENTRYPOINT_BYTES`（25,000 字节）时，在字节上限前最近的换行处截断（避免切断行中间）

行截断优先执行（自然边界），然后再检查字节上限。截断后追加 WARNING 信息，说明截断原因（行数超限、字节超限、或两者皆超）。

### buildCombinedMemoryPrompt：双目录联合提示词

`buildCombinedMemoryPrompt()` 函数（`src/memdir/teamMemPrompts.ts:22-100`）为同时启用自动记忆和团队记忆的场景构建提示词。与单目录模式的关键差异：

- 声明两个目录路径（私有 `autoDir` 和团队 `teamDir`）
- 增加 **Memory scope** 章节，解释 private 和 team 两种作用域
- 使用 `TYPES_SECTION_COMBINED`（带 `<scope>` 标签的类型定义）替代 `TYPES_SECTION_INDIVIDUAL`
- 保存流程中指导模型根据类型的 scope 选择写入哪个目录
- 额外禁止在团队记忆中保存敏感数据（API 密钥、凭证等）

## 函数签名与参数说明

### `loadMemoryPrompt(): Promise<string | null>`

顶层入口，多模式分发。返回完整的记忆系统提示词文本，或在记忆功能禁用时返回 `null`。

> 源码位置：`src/memdir/memdir.ts:419-507`

### `buildMemoryLines(displayName, memoryDir, extraGuidelines?, skipIndex?): string[]`

核心提示词组装，返回行数组（不含 MEMORY.md 内容）。

| 参数 | 类型 | 说明 |
|------|------|------|
| displayName | `string` | 提示词标题（如 `"auto memory"`） |
| memoryDir | `string` | 记忆目录的文件系统路径 |
| extraGuidelines | `string[]` | 可选，附加指导文本（如 Cowork 模式的额外规则） |
| skipIndex | `boolean` | 默认 `false`；为 `true` 时省略 MEMORY.md 索引步骤 |

> 源码位置：`src/memdir/memdir.ts:199-266`

### `buildMemoryPrompt(params): string`

在 `buildMemoryLines` 基础上同步读取 MEMORY.md 并附加内容。

| 参数字段 | 类型 | 说明 |
|----------|------|------|
| displayName | `string` | 提示词标题 |
| memoryDir | `string` | 记忆目录路径 |
| extraGuidelines | `string[]` | 可选附加指导 |

> 源码位置：`src/memdir/memdir.ts:272-316`

### `truncateEntrypointContent(raw: string): EntrypointTruncation`

截断 MEMORY.md 内容，返回截断结果和元信息。

> 源码位置：`src/memdir/memdir.ts:57-103`

### `ensureMemoryDirExists(memoryDir: string): Promise<void>`

确保记忆目录存在。幂等操作，递归创建目录链，静默处理 `EEXIST`。

> 源码位置：`src/memdir/memdir.ts:129-147`

### `buildCombinedMemoryPrompt(extraGuidelines?, skipIndex?): string`

双目录联合提示词构建。

> 源码位置：`src/memdir/teamMemPrompts.ts:22-100`

### `buildSearchingPastContextSection(autoMemDir: string): string[]`

构建"搜索历史上下文"段落，受特性开关 `tengu_coral_fern` 门控。根据是否使用嵌入式搜索工具，生成不同的搜索命令示例（Grep 工具 vs shell grep）。

> 源码位置：`src/memdir/memdir.ts:375-407`

## 接口/类型定义

### `EntrypointTruncation`

MEMORY.md 截断结果的返回类型（`src/memdir/memdir.ts:41-47`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| content | `string` | 截断后的内容（可能含 WARNING 后缀） |
| lineCount | `number` | 原始行数 |
| byteCount | `number` | 原始字节数 |
| wasLineTruncated | `boolean` | 是否触发行数截断 |
| wasByteTruncated | `boolean` | 是否触发字节截断 |

### `MemoryType`

四类记忆类型的联合类型（`src/memdir/memoryTypes.ts:21`）：

```typescript
type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
```

### `parseMemoryType(raw: unknown): MemoryType | undefined`

将原始 frontmatter 值解析为 `MemoryType`，无效值返回 `undefined`，兼容无 `type` 字段的旧文件。

> 源码位置：`src/memdir/memoryTypes.ts:28-31`

## 四类记忆类型分类体系

`memoryTypes.ts` 定义了记忆的封闭四类分类（`src/memdir/memoryTypes.ts:14-19`）：

| 类型 | 用途 | 典型场景 |
|------|------|----------|
| **user** | 用户角色、目标、知识水平 | "我是数据科学家"、"Go 写了十年但不熟悉 React" |
| **feedback** | 用户对工作方式的指导（纠正和确认） | "别 mock 数据库"、"不要在末尾总结" |
| **project** | 项目进行中的工作、目标、事件 | "周四后冻结合并"、"auth 重写是合规驱动的" |
| **reference** | 外部系统中的信息指针 | "Linear 项目 INGEST 追踪管道 bug" |

该分类有两个版本的提示词段落：
- `TYPES_SECTION_INDIVIDUAL`：单目录模式，无 `<scope>` 标签
- `TYPES_SECTION_COMBINED`：双目录模式，每个类型包含 `<scope>` 标签指导 private/team 选择

两者故意保持独立维护（非从共享定义生成），便于按模式独立调整。

## 配置项与默认值

| 常量/配置 | 值 | 说明 |
|-----------|-----|------|
| `ENTRYPOINT_NAME` | `"MEMORY.md"` | 记忆索引文件名 |
| `MAX_ENTRYPOINT_LINES` | `200` | MEMORY.md 最大行数 |
| `MAX_ENTRYPOINT_BYTES` | `25,000` | MEMORY.md 最大字节数（~125 字符/行 × 200 行） |
| `DIR_EXISTS_GUIDANCE` | 提示文本 | 单目录模式下的"目录已存在"提示 |
| `DIRS_EXIST_GUIDANCE` | 提示文本 | 双目录模式下的"目录已存在"提示 |

**特性开关**：

| 开关名 | 作用 |
|--------|------|
| `feature('KAIROS')` | 启用 Assistant 日志模式 |
| `feature('TEAMMEM')` | 启用团队记忆功能 |
| `tengu_moth_copse` | 控制 `skipIndex` 参数（简化保存流程） |
| `tengu_coral_fern` | 控制"搜索历史上下文"段落的显示 |
| `tengu_herring_clock` | 团队记忆 cohort 标记（用于遥测） |

**环境变量**：

| 变量 | 说明 |
|------|------|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 禁用自动记忆 |
| `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` | Cowork 模式注入的额外记忆策略文本 |

## 边界 Case 与注意事项

- **MEMORY.md 字节截断的切割策略**：字节截断时在上限前最近的换行处切割（`lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)`），避免切断行中间。但如果找不到换行（`cutAt <= 0`），会直接在字节上限处硬切（`src/memdir/memdir.ts:83-84`）。

- **KAIROS 模式与 TEAMMEM 互斥**：KAIROS 的 append-only 日志范式与团队记忆的共享 MEMORY.md 同步机制不兼容。KAIROS 分支在 TEAMMEM 检查之前，因此 KAIROS 活跃时团队记忆被跳过（`src/memdir/memdir.ts:429-431`）。

- **团队目录创建的隐式依赖**：`getTeamMemPath()` 返回的路径是 `getAutoMemPath()` 下的 `team` 子目录。因此 `ensureMemoryDirExists(teamDir)` 的递归 mkdir 会自动创建父级 auto 目录。代码注释明确指出，如果团队目录路径将来移到 auto 目录外，需要额外添加 auto 目录的创建调用（`src/memdir/memdir.ts:454-457`）。

- **buildAssistantDailyLogPrompt 的日期缓存问题**：该函数生成的提示词通过 `systemPromptSection` 缓存，跨午夜不会重新生成。日志路径使用模式 `YYYY/MM/YYYY-MM-DD.md` 而非具体日期，模型从 `currentDate` 上下文中获取当前日期（`src/memdir/memdir.ts:329-334`）。

- **搜索指令的工具差异**：`buildSearchingPastContextSection` 会根据是否使用嵌入式搜索工具（或 REPL 模式）生成不同的搜索命令——shell `grep` 或 Grep 工具调用语法（`src/memdir/memdir.ts:385-391`）。

- **TYPES_SECTION 的双版本维护**：Individual 和 Combined 两个版本的类型定义段落是故意复制而非从共享结构生成的。注释说明这样做是为了让按模式编辑更直观，避免通过条件渲染辅助函数间接推理（`src/memdir/memoryTypes.ts:9-11`）。