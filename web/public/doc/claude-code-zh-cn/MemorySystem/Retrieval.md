# 记忆检索与相关性筛选（Retrieval）

## 概述与职责

Retrieval 模块是 **MemorySystem** 的检索层，负责从用户的记忆目录中找出与当前对话查询最相关的记忆文件，并提供记忆新鲜度的计算与过期提醒。它由三个文件组成：

- **`findRelevantMemories.ts`** — 核心检索入口，通过 Sonnet 模型侧查询从记忆中筛选最相关的条目（最多 5 条）
- **`memoryScan.ts`** — 记忆目录扫描器，读取 `.md` 文件的 frontmatter 元数据并生成记忆清单
- **`memoryAge.ts`** — 记忆新鲜度工具，计算记忆年龄并生成过期警告文本

在整体架构中，Retrieval 位于 Services 层（SessionMemory / extractMemories）与底层文件系统之间：Services 调用 `findRelevantMemories()` 获取相关记忆，后者依赖 `scanMemoryFiles()` 扫描磁盘，最终检索结果配合 `memoryAge` 的新鲜度标注一起注入到模型的上下文中。

## 关键流程

### 记忆检索主流程（findRelevantMemories）

1. 调用 `scanMemoryFiles(memoryDir)` 扫描记忆目录，获取所有记忆文件的 header 信息
2. 使用 `alreadySurfaced` 集合过滤掉已在先前对话轮次中展示过的记忆，避免重复选取（`src/memdir/findRelevantMemories.ts:46-48`）
3. 调用内部函数 `selectRelevantMemories()` 发起 **Sonnet 模型侧查询**：
   - 将记忆清单（通过 `formatMemoryManifest()` 格式化）和用户查询组装为 prompt
   - 如果提供了 `recentTools`，附加到 prompt 中以避免选取当前正在使用的工具的参考文档
   - 使用 JSON Schema 约束输出格式为 `{ selected_memories: string[] }`
   - 最多选取 5 条记忆
4. 对模型返回的文件名做**合法性校验**：只保留确实存在于扫描结果中的文件名（`src/memdir/findRelevantMemories.ts:130`）
5. 如果启用了 `MEMORY_SHAPE_TELEMETRY` 特性门控，记录检索形态遥测数据
6. 返回 `RelevantMemory[]`，每条包含 `path`（绝对路径）和 `mtimeMs`（修改时间）

### 记忆目录扫描流程（scanMemoryFiles）

1. 递归读取 `memoryDir` 下所有文件条目（`readdir({ recursive: true })`）
2. 过滤出 `.md` 文件，排除索引文件 `MEMORY.md`（`src/memdir/memoryScan.ts:42-43`）
3. 对每个文件**并发读取前 30 行**（`FRONTMATTER_MAX_LINES = 30`），解析 frontmatter 中的 `description` 和 `type` 字段
4. 采用 **single-pass** 策略：`readFileInRange` 内部同时返回 `mtimeMs`，避免额外的 stat 系统调用
5. 使用 `Promise.allSettled` 容忍单个文件读取失败，不影响整体扫描
6. 按修改时间**降序排序**（最新优先），截取前 **200 条**（`MAX_MEMORY_FILES`）

## 函数签名与参数说明

### `findRelevantMemories(query, memoryDir, signal, recentTools?, alreadySurfaced?)`

> 源码位置：`src/memdir/findRelevantMemories.ts:39-75`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `query` | `string` | — | 用户的当前查询文本 |
| `memoryDir` | `string` | — | 记忆文件目录的绝对路径 |
| `signal` | `AbortSignal` | — | 中断信号，支持取消检索 |
| `recentTools` | `readonly string[]` | `[]` | 最近使用的工具列表，用于过滤工具文档类记忆 |
| `alreadySurfaced` | `ReadonlySet<string>` | `new Set()` | 已展示记忆的路径集合，避免重复选取 |

**返回值**：`Promise<RelevantMemory[]>` — 最多 5 条相关记忆，每条包含 `path`（绝对路径）和 `mtimeMs`

### `scanMemoryFiles(memoryDir, signal)`

> 源码位置：`src/memdir/memoryScan.ts:35-77`

扫描记忆目录，返回按修改时间降序排列的 `MemoryHeader[]`（最多 200 条）。

### `formatMemoryManifest(memories)`

> 源码位置：`src/memdir/memoryScan.ts:84-94`

将 `MemoryHeader[]` 格式化为文本清单，格式为：`- [type] filename (ISO时间戳): description`。供检索 prompt 和记忆提取 Agent 共用。

### `memoryAgeDays(mtimeMs)`

> 源码位置：`src/memdir/memoryAge.ts:6-8`

返回记忆距今天数（向下取整，今天为 0，昨天为 1）。负值（未来时间或时钟偏移）钳位到 0。

### `memoryAge(mtimeMs)`

> 源码位置：`src/memdir/memoryAge.ts:15-20`

返回人类可读的年龄字符串：`"today"` / `"yesterday"` / `"N days ago"`。

### `memoryFreshnessText(mtimeMs)`

> 源码位置：`src/memdir/memoryAge.ts:33-42`

生成纯文本过期警告。超过 1 天的记忆返回提醒文本（提示模型验证代码引用），当天/昨天的记忆返回空字符串。

### `memoryFreshnessNote(mtimeMs)`

> 源码位置：`src/memdir/memoryAge.ts:49-53`

在 `memoryFreshnessText` 外层包裹 `<system-reminder>` 标签，适用于不自带 wrapper 的调用方（如 FileReadTool 输出）。

## 接口/类型定义

### `RelevantMemory`

```typescript
type RelevantMemory = {
  path: string      // 记忆文件的绝对路径
  mtimeMs: number   // 文件修改时间（毫秒时间戳）
}
```

### `MemoryHeader`

```typescript
type MemoryHeader = {
  filename: string           // 相对于 memoryDir 的路径
  filePath: string           // 绝对路径
  mtimeMs: number            // 文件修改时间
  description: string | null // frontmatter 中的 description 字段
  type: MemoryType | undefined // frontmatter 中的 type 字段（user/feedback/project/reference）
}
```

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_MEMORY_FILES` | 200 | 扫描结果的最大条目数，超出按时间截断 |
| `FRONTMATTER_MAX_LINES` | 30 | 每个记忆文件只读取前 30 行用于解析 frontmatter |
| `max_tokens`（侧查询） | 256 | Sonnet 侧查询的最大输出 token 数 |
| 最大选取数 | 5 | 系统 prompt 约束每次最多选取 5 条记忆 |

特性门控 `MEMORY_SHAPE_TELEMETRY`：启用时记录检索形态遥测（候选数、选中数、类型分布等）。

## 边界 Case 与注意事项

- **空目录/无记忆**：`scanMemoryFiles` 返回空数组，`findRelevantMemories` 直接返回空结果，不会发起模型调用（`src/memdir/findRelevantMemories.ts:49-51`）
- **扫描失败容错**：`scanMemoryFiles` 外层 catch 吞掉目录读取异常返回空数组；内层使用 `Promise.allSettled` 容忍单文件读取失败（`src/memdir/memoryScan.ts:45, 74`）
- **侧查询失败容错**：`selectRelevantMemories` 捕获所有异常（含 abort），记录日志后返回空数组，不会阻断主对话流程（`src/memdir/findRelevantMemories.ts:131-140`）
- **工具文档去重**：当 `recentTools` 非空时，系统 prompt 指示模型不要选取这些工具的用法文档，但**仍然选取**关于这些工具的警告和已知问题——因为正在使用时恰恰是这些信息最重要的时候（`src/memdir/findRelevantMemories.ts:23`）
- **已展示去重**：`alreadySurfaced` 在 Sonnet 调用**之前**过滤，节省 5 个选取名额给新候选，而非选完再去重
- **新鲜度警告设计**：仅对超过 1 天的记忆添加过期提醒，避免对当天记忆产生不必要的噪声。提醒文本明确指出"file:line 引用可能过时"——这来自用户反馈：过时的代码行号引用反而让模型的错误断言显得更权威（`src/memdir/memoryAge.ts:29-31`）
- **MEMORY.md 排除**：扫描时总是排除 `MEMORY.md` 索引文件，因为它已经在系统 prompt 中加载
- **时钟偏移处理**：`memoryAgeDays` 对负值输入（未来时间戳）钳位到 0，防止异常显示