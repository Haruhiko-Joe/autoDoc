# 输入历史管理（InputHistory）

## 概述与职责

`InputHistory` 模块负责 Claude Code 中用户输入历史的持久化管理。它属于 **CoreEngine** 的一部分，为终端 REPL 提供跨会话的输入历史记录能力——用户按上箭头可回溯之前的输入，按 Ctrl+R 可搜索历史命令。

该模块的核心职责包括：

- **持久化存储**：基于 JSONL 格式的 append-only 历史文件（`~/.claude/history.jsonl`）
- **粘贴内容管理**：将用户粘贴的大文本/图片替换为 `[Pasted text #N]` 引用，大内容通过 hash 引用外部 paste store
- **会话感知**：当前会话的历史条目优先于其他会话，避免并发会话间的上箭头历史交错
- **并发安全**：通过文件锁（lockfile）保证多进程写入的安全性

> 源码位置：`src/history.ts`

## 关键流程

### 1. 写入历史条目

当用户提交输入时，`addToHistory()` 被调用，触发以下流程：

1. **环境检查**：若环境变量 `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 为真值，则跳过（防止 Tungsten 工具产生的 tmux 子会话污染用户历史）（`src/history.ts:414`）
2. **注册清理回调**：首次调用时注册进程退出清理函数，确保未落盘的条目在退出前被刷写（`src/history.ts:419-431`）
3. **处理粘贴内容**：遍历 `pastedContents`，按大小分两路存储（`src/history.ts:363-395`）：
   - **小文本**（≤ 1024 字符）：内联存储在 LogEntry 中
   - **大文本**（> 1024 字符）：计算 hash，将 hash 引用写入 LogEntry，实际内容通过 `storePastedText()` fire-and-forget 写入外部 paste store
   - **图片**：直接跳过（图片单独存储在 image-cache 中）
4. **构建 LogEntry**：附加 `timestamp`、`project`（项目根路径）、`sessionId`（`src/history.ts:397-403`）
5. **入队 & 异步刷写**：条目先进入内存 `pendingEntries` 缓冲区，然后触发异步 `flushPromptHistory()`（`src/history.ts:405-408`）

### 2. 刷写到磁盘（Flush）

`flushPromptHistory()` 实现了带重试的异步刷写机制：

1. **互斥控制**：通过 `isWriting` 标志保证同一时刻只有一个 flush 在执行（`src/history.ts:330`）
2. **重试上限**：最多重试 5 次，避免热循环（`src/history.ts:335`）
3. **实际写入**（`immediateFlushHistory()`，`src/history.ts:292-327`）：
   - 以 append 模式确保文件存在（权限 `0o600`）
   - 获取文件锁（stale 超时 10 秒，最多重试 3 次，最小等待 50ms）
   - 将所有 pending 条目序列化为 JSONL 并 append 到文件
   - 释放文件锁
4. **尾递归重试**：如果 flush 完成后仍有新的 pending 条目，等待 500ms 后再次触发

### 3. 读取历史条目

读取采用 **逆序读取** 策略（最新的先返回），通过 `makeLogEntryReader()` 实现：

1. 先 yield 内存中尚未落盘的 `pendingEntries`（逆序）（`src/history.ts:110-112`）
2. 再通过 `readLinesReverse()` 从文件末尾逆序读取已落盘条目（`src/history.ts:118`）
3. 跳过已被 `removeLastFromHistory()` 标记的条目（通过 `skippedTimestamps` 集合过滤）（`src/history.ts:124-129`）

上层提供三种读取接口：

| 接口 | 用途 | 特点 |
|------|------|------|
| `getHistory()` | 上箭头历史 | 当前会话条目优先，按项目过滤，上限 100 条 |
| `getTimestampedHistory()` | Ctrl+R 搜索 | 按 display 去重，懒加载粘贴内容，上限 100 条 |
| `makeHistoryReader()` | 通用遍历 | 无过滤，返回所有历史条目 |

### 4. 撤销最近的历史条目

`removeLastFromHistory()` 用于 Esc 键中断恢复场景——当用户按 Esc 在模型响应前回退会话时，对应的历史条目也应被撤销（`src/history.ts:453-464`）：

- **快路径**：条目尚在 `pendingEntries` 缓冲区中，直接从数组中移除
- **慢路径**：条目已经被 flush 到磁盘，将其 `timestamp` 加入 `skippedTimestamps` 集合，后续读取时跳过

### 5. 粘贴内容引用与还原

粘贴内容在用户输入中以引用形式展示，还原时通过 `expandPastedTextRefs()` 进行：

1. `parseReferences()` 用正则提取输入中的所有引用标记（`src/history.ts:62-75`）：
   - 文本引用：`[Pasted text #1 +10 lines]`
   - 图片引用：`[Image #2]`
   - 截断文本引用：`[...Truncated text #3]`
2. `expandPastedTextRefs()` 将文本引用替换为实际内容（`src/history.ts:81-100`）：
   - **逆序替换**：从后往前替换，保证前面的 offset 不被破坏
   - 仅替换 `type === 'text'` 的引用，图片引用保持不变（图片以 content block 形式处理）

## 函数签名与参数说明

### 导出函数

#### `addToHistory(command: HistoryEntry | string): void`

添加一条历史记录。接受完整的 `HistoryEntry` 对象或简单字符串。异步写入但同步返回（fire-and-forget）。

#### `getHistory(): AsyncGenerator<HistoryEntry>`

获取当前项目的历史条目。当前会话的条目优先 yield，然后是其他会话的条目。上限 `MAX_HISTORY_ITEMS`（100）条。

#### `getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry>`

获取带时间戳的历史条目，用于 Ctrl+R 选择器。按 `display` 文本去重，粘贴内容通过 `resolve()` 懒加载。

#### `makeHistoryReader(): AsyncGenerator<HistoryEntry>`

通用历史遍历器，不按项目/会话过滤，逆序返回所有条目。

#### `removeLastFromHistory(): void`

撤销最近一次 `addToHistory` 调用。一次性操作——第二次调用为 no-op。

#### `clearPendingHistoryEntries(): void`

清空内存中所有未落盘的待写条目、最近添加记录和跳过时间戳集合。

#### `expandPastedTextRefs(input: string, pastedContents: Record<number, PastedContent>): string`

将输入中的 `[Pasted text #N]` 引用替换为实际文本内容。图片引用不处理。

#### `parseReferences(input: string): Array<{ id: number; match: string; index: number }>`

从输入字符串中解析所有粘贴内容引用标记，返回 id、匹配文本和位置偏移。

#### `formatPastedTextRef(id: number, numLines: number): string`

生成文本粘贴引用标记，如 `[Pasted text #1 +10 lines]`。

#### `formatImageRef(id: number): string`

生成图片引用标记，如 `[Image #1]`。

#### `getPastedTextRefNumLines(text: string): number`

计算粘贴文本的行数（统计换行符数量，非行数）。

## 类型定义

### `LogEntry`（内部类型）

磁盘上 JSONL 文件中每行的结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `display` | `string` | 用户输入的显示文本（含引用占位符） |
| `pastedContents` | `Record<number, StoredPastedContent>` | 粘贴内容（内联或 hash 引用） |
| `timestamp` | `number` | Unix 毫秒时间戳 |
| `project` | `string` | 项目根路径 |
| `sessionId` | `string?` | 会话 ID |

### `StoredPastedContent`（内部类型）

存储在 LogEntry 中的粘贴内容，支持两种模式：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `number` | 粘贴内容的自增 ID |
| `type` | `'text' \| 'image'` | 内容类型 |
| `content` | `string?` | 内联内容（小文本，≤ 1024 字符） |
| `contentHash` | `string?` | 外部 paste store 的 hash 引用（大文本） |
| `mediaType` | `string?` | 媒体类型 |
| `filename` | `string?` | 文件名 |

### `TimestampedHistoryEntry`（导出类型）

| 字段 | 类型 | 说明 |
|------|------|------|
| `display` | `string` | 显示文本 |
| `timestamp` | `number` | 时间戳 |
| `resolve` | `() => Promise<HistoryEntry>` | 懒加载完整条目（含还原后的粘贴内容） |

## 配置项与默认值

| 配置 | 值 | 说明 |
|------|------|------|
| `MAX_HISTORY_ITEMS` | 100 | 单次读取的最大历史条目数 |
| `MAX_PASTED_CONTENT_LENGTH` | 1024 | 内联存储粘贴内容的最大字符数，超过则用 hash 引用 |
| 历史文件路径 | `~/.claude/history.jsonl` | 全局共享，所有项目共用一个文件 |
| 文件权限 | `0o600` | 仅文件所有者可读写 |
| 文件锁 stale 超时 | 10000 ms | 锁超过此时间视为过期 |
| 文件锁重试 | 3 次，最小间隔 50ms | 获取锁失败时的重试策略 |
| Flush 重试上限 | 5 次 | 超过后停止重试，等待下一次用户输入 |
| Flush 重试间隔 | 500ms | 两次 flush 之间的等待时间 |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY` | 环境变量 | 为真值时跳过历史记录写入 |

## 边界 Case 与注意事项

- **并发会话写入安全**：多个 Claude Code 实例可同时写入同一个 `history.jsonl` 文件，通过文件锁保证不会产生损坏的 JSON 行。但读取时每个会话优先展示自己的条目，避免上箭头历史交错。

- **历史文件不存在**：首次使用时文件可能不存在，`makeLogEntryReader()` 对 `ENOENT` 错误静默处理，返回空结果（`src/history.ts:137-139`）。

- **损坏的 JSONL 行**：`deserializeLogEntry()` 解析失败时仅记录 debug 日志并跳过该行，不会中断整个历史读取（`src/history.ts:131-134`）。

- **进程退出时的数据安全**：通过 `registerCleanup()` 注册退出钩子，先等待进行中的 flush，再对剩余 pending 条目做最终 flush（`src/history.ts:421-429`）。

- **粘贴行数计算的历史兼容性**：`getPastedTextRefNumLines()` 统计的是换行符数量而非实际行数（如 3 行文本返回 2），这是为了兼容早期实现的行为（`src/history.ts:44-48`）。

- **removeLastFromHistory 的竞态处理**：如果条目在撤销前已被 flush 到磁盘（通常 TTFT >> 磁盘写入延迟），则通过 `skippedTimestamps` 在读取时过滤，而非修改磁盘文件。该集合是模块级状态，进程重启后重置。

- **图片不存入历史文件**：`addToPromptHistory()` 中显式跳过 `type === 'image'` 的粘贴内容（`src/history.ts:367-369`），图片通过独立的 image-cache 机制管理。