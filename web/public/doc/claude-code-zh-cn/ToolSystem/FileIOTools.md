# 文件系统操作工具集（FileIOTools）

## 概述与职责

FileIOTools 是 Claude Code **ToolSystem** 中负责文件系统交互的核心工具集合，包含六个独立工具：

| 工具名 | 注册名 | 职责 |
|--------|--------|------|
| FileReadTool | `Read` | 读取文件内容（文本、图片、PDF、Jupyter Notebook） |
| FileEditTool | `Edit` | 对已有文件执行精确字符串替换 |
| FileWriteTool | `Write` | 创建新文件或完整覆写已有文件 |
| GlobTool | `Glob` | 按 glob 模式匹配搜索文件路径 |
| GrepTool | `Grep` | 基于 ripgrep 搜索文件内容 |
| NotebookEditTool | `NotebookEdit` | 编辑 Jupyter Notebook 单元格 |

这些工具在 ToolSystem 中通过 `buildTool()` 统一注册，共享相同的工具接口模型（权限检查、输入校验、调用执行、结果映射）。它们是 Claude Code 与用户文件系统交互的唯一通道——所有文件的读写搜索操作均通过这些工具完成。

在整体架构中，ToolSystem 被 CoreEngine（查询引擎）调度执行。当模型的响应中包含工具调用请求时，CoreEngine 根据工具名分发到对应的工具实现。FileIOTools 作为 ToolSystem 中最基础的一批工具，几乎在每次对话中都会被使用。

## 关键流程

### 1. FileReadTool：多格式文件读取

FileReadTool 是使用频率最高的工具，支持四种输出类型：`text`、`image`、`notebook`、`pdf`/`parts`，以及一个去重优化类型 `file_unchanged`。

**文本文件读取流程：**

1. 路径扩展与校验：通过 `expandPath()` 规范化路径，检查拒绝规则、二进制扩展名和危险设备路径（如 `/dev/zero`）（`FileReadTool.ts:418-494`）
2. **去重检测**：检查 `readFileState` 中是否已有相同路径、相同 offset/limit 的记录，且文件未被修改。命中时返回 `file_unchanged` 存根，避免重复发送大量 token（`FileReadTool.ts:536-573`）
3. 文件大小检查：文件字节数不能超过 `maxSizeBytes`（默认 256KB），超出则抛错要求使用 offset/limit（`limits.ts:7-8`）
4. 按行读取：使用 `readFileInRange()` 读取指定范围，默认从第 1 行读取最多 2000 行（`prompt.ts:10`）
5. Token 数检查：通过 `validateContentTokens()` 估算 token 数，超过 `maxTokens`（默认 25000）则抛出 `MaxFileReadTokenExceededError`（`FileReadTool.ts:755-772`）
6. 记录读取状态：将内容和时间戳写入 `readFileState`，供后续 Edit/Write 工具做过期检测

**图片读取流程：**

支持 PNG、JPG、JPEG、GIF、WEBP 格式。通过 `imageProcessor.ts` 加载图片处理器（优先使用原生 `image-processor-napi`，回退到 `sharp`），对图片进行压缩/缩放后以 base64 编码返回（`imageProcessor.ts:37-67`）。

**PDF 读取流程：**

支持 `pages` 参数指定页码范围（如 `"1-5"`），每次最多 20 页。小 PDF 直接以 base64 内联发送，大 PDF 则提取页面为图片返回。

**Notebook 读取流程：**

`.ipynb` 文件解析为 JSON，提取所有 cell 及其输出，通过 `mapNotebookCellsToToolResult()` 组合为结构化结果。

### 2. FileEditTool：精确字符串替换

这是代码修改的主力工具，采用"读后写"（read-before-edit）安全模型。

1. **输入校验**（`FileEditTool.ts:137-361`）：
   - 检查 `old_string !== new_string`（避免空操作）
   - 检查文件是否被拒绝规则覆盖
   - 检查文件大小不超过 1GiB（`MAX_EDIT_FILE_SIZE`，防止 OOM）
   - 验证文件已被 Read 工具读取过（`readFileState` 中有记录且非 partial view）
   - 验证文件自上次读取后未被修改（时间戳比对 + Windows 下的内容比对回退）
   - 使用 `findActualString()` 查找匹配——先精确匹配，失败后尝试引号规范化匹配（`utils.ts:73-93`）
   - 检查匹配唯一性：多处匹配时需要 `replace_all=true`

2. **执行编辑**（`FileEditTool.ts:387-574`）：
   - 原子性关键段：同步读取文件 → 再次校验时间戳 → 生成 patch → 写入磁盘
   - 通过 `preserveQuoteStyle()` 保持文件中的弯引号风格（`utils.ts:104-136`）
   - 写入后通知 LSP 服务器（`didChange` + `didSave`）和 VSCode diff 视图
   - 更新 `readFileState` 时间戳，防止后续并发编辑

3. **引号规范化**：Claude 模型无法输出弯引号（curly quotes），因此 `findActualString()` 会将弯引号映射为直引号进行匹配，`preserveQuoteStyle()` 则在 `new_string` 中还原文件原有的引号风格。

### 3. FileWriteTool：文件创建与覆写

与 FileEditTool 共享"读后写"安全模型，但操作是全量替换文件内容。

1. 校验阶段：检查文件是否已读取、是否被修改后未重新读取（`FileWriteTool.ts:153-222`）
2. 写入阶段：确保父目录存在 → 再次校验时间戳 → 调用 `writeTextContent()` 写入 → 通知 LSP → 更新 `readFileState`（`FileWriteTool.ts:223-417`）
3. 输出区分 `create`（新文件）和 `update`（已有文件覆写）两种类型

### 4. GlobTool：文件模式搜索

只读工具，支持并发安全。

1. 接收 `pattern`（glob 模式，如 `**/*.ts`）和可选的 `path`（搜索起点）
2. 调用 `glob()` 执行搜索，默认限制 100 个结果（`GlobTool.ts:157`）
3. 结果按修改时间降序排列，路径转为相对路径以节省 token（`GlobTool.ts:166`）

### 5. GrepTool：内容搜索

基于 ripgrep 的强大搜索工具，只读且并发安全。

**三种输出模式：**
- `files_with_matches`（默认）：仅返回匹配文件路径，按修改时间排序
- `content`：返回匹配行及上下文（支持 `-A`/`-B`/`-C` 上下文参数）
- `count`：返回每个文件的匹配计数

**核心执行逻辑**（`GrepTool.ts:310-576`）：

1. 构建 ripgrep 参数：自动排除 VCS 目录（`.git`、`.svn` 等），限制行长 500 字符，应用忽略规则
2. 调用 `ripGrep()` 执行搜索
3. 对结果应用 `head_limit`（默认 250 条）和 `offset` 实现分页，避免上下文膨胀
4. 转换绝对路径为相对路径以节省 token

### 6. NotebookEditTool：Notebook 单元格编辑

专门处理 `.ipynb` 文件，支持三种操作模式：

- `replace`：替换指定 cell 的源代码，重置执行计数和输出
- `insert`：在指定 cell 后插入新 cell（需指定 `cell_type`）
- `delete`：删除指定 cell

通过 `cell_id` 定位目标 cell（支持实际 ID 和 `cell-N` 数字索引格式），编辑后以 1 空格缩进重新序列化 JSON 并写回磁盘（`NotebookEditTool.ts:295-489`）。

## 函数签名与参数说明

### FileReadTool

```typescript
// 输入
{
  file_path: string       // 必填，绝对路径
  offset?: number         // 起始行号（1-indexed），默认 1
  limit?: number          // 读取行数，默认读取最多 2000 行
  pages?: string          // PDF 专用，页码范围如 "1-5"，最多 20 页
}

// 输出（discriminated union，通过 type 区分）
| { type: 'text', file: { filePath, content, numLines, startLine, totalLines } }
| { type: 'image', file: { base64, type, originalSize, dimensions? } }
| { type: 'notebook', file: { filePath, cells } }
| { type: 'pdf', file: { filePath, base64, originalSize } }
| { type: 'parts', file: { filePath, originalSize, count, outputDir } }
| { type: 'file_unchanged', file: { filePath } }
```

### FileEditTool

```typescript
// 输入
{
  file_path: string       // 必填，绝对路径
  old_string: string      // 必填，要替换的文本（空字符串 + 不存在的文件 = 创建文件）
  new_string: string      // 必填，替换后的文本（必须与 old_string 不同）
  replace_all?: boolean   // 是否替换所有匹配项，默认 false
}
```

### FileWriteTool

```typescript
// 输入
{
  file_path: string       // 必填，绝对路径
  content: string         // 必填，完整文件内容
}

// 输出
{ type: 'create' | 'update', filePath, content, structuredPatch, originalFile }
```

### GlobTool

```typescript
// 输入
{
  pattern: string         // 必填，glob 模式如 "**/*.ts"
  path?: string           // 搜索目录，默认 cwd
}

// 输出
{ filenames: string[], durationMs, numFiles, truncated }
```

### GrepTool

```typescript
// 输入
{
  pattern: string              // 必填，正则表达式
  path?: string                // 搜索路径，默认 cwd
  glob?: string                // 文件过滤 glob
  output_mode?: 'content' | 'files_with_matches' | 'count'  // 默认 files_with_matches
  '-B'?: number                // 匹配前上下文行数
  '-A'?: number                // 匹配后上下文行数
  '-C'?: number                // 双向上下文行数
  context?: number             // 等同 -C
  '-n'?: boolean               // 显示行号，默认 true
  '-i'?: boolean               // 大小写不敏感
  type?: string                // 文件类型如 "js", "py"
  head_limit?: number          // 结果上限，默认 250，传 0 无限制
  offset?: number              // 跳过前 N 条，默认 0
  multiline?: boolean          // 多行匹配模式
}
```

### NotebookEditTool

```typescript
// 输入
{
  notebook_path: string                      // 必填，绝对路径（.ipynb）
  cell_id?: string                           // cell ID 或 cell-N 索引
  new_source: string                         // 新源代码
  cell_type?: 'code' | 'markdown'            // insert 模式必填
  edit_mode?: 'replace' | 'insert' | 'delete' // 默认 replace
}
```

## 类型定义

### FileReadingLimits（`limits.ts:35-40`）

```typescript
type FileReadingLimits = {
  maxTokens: number              // 输出最大 token 数，默认 25000
  maxSizeBytes: number           // 文件最大字节数，默认 256KB
  includeMaxSizeInPrompt?: boolean  // 是否在提示词中显示大小限制
  targetedRangeNudge?: boolean      // 是否使用精确范围提示语
}
```

限制优先级：环境变量 `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` > GrowthBook 特性开关 > 硬编码默认值。

### FileEditInput / FileEditOutput（`types.ts`）

输出包含完整的 diff 信息：`structuredPatch`（hunk 数组）、`originalFile`、`oldString`/`newString`、`userModified`（用户是否在确认前修改了提案），以及可选的 `gitDiff`。

## 配置项与默认值

| 配置项 | 来源 | 默认值 | 说明 |
|--------|------|--------|------|
| `maxTokens` | 环境变量 / GrowthBook / 硬编码 | 25000 | Read 输出的最大 token 数 |
| `maxSizeBytes` | GrowthBook / 硬编码 | 256KB (`MAX_OUTPUT_SIZE`) | 可读取的最大文件字节数 |
| `MAX_LINES_TO_READ` | 硬编码 | 2000 | 默认读取的最大行数 |
| `MAX_EDIT_FILE_SIZE` | 硬编码 | 1GiB | 可编辑的最大文件字节数 |
| `DEFAULT_HEAD_LIMIT` | 硬编码 | 250 | Grep 默认结果上限 |
| Glob 结果上限 | `globLimits?.maxResults` | 100 | Glob 默认返回文件数 |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | 环境变量 | 无 | 覆盖 maxTokens |

## 共享安全机制

### 读后写（Read-before-Edit/Write）

FileEditTool、FileWriteTool、NotebookEditTool 都要求目标文件在编辑前已被 FileReadTool 读取过。通过 `readFileState` Map 追踪每个文件的读取状态（内容、时间戳、是否 partial view）。如果文件自上次读取后被外部修改（通过 mtime 比对检测），工具会拒绝操作并要求重新读取。

### UNC 路径防护

所有工具在执行文件系统操作前检查路径是否为 UNC 路径（`\\` 或 `//` 开头）。对于 UNC 路径，跳过 `fs.stat()` 等操作，以防止 Windows 上的 NTLM 凭据泄露。

### 权限系统集成

每个工具实现 `checkPermissions()` 方法，通过 `checkReadPermissionForTool()`（只读工具）或 `checkWritePermissionForTool()`（写入工具）检查操作是否被用户权限设置允许。还支持通过 `matchingRuleForInput()` 检查 deny 规则。

### LSP 通知

FileEditTool 和 FileWriteTool 在写入磁盘后，会异步通知 LSP 服务器（`didChange` + `didSave`），触发 TypeScript 等语言服务器的诊断更新。同时通知 VSCode 扩展更新 diff 视图。

## 边界 Case 与注意事项

- **引号规范化**：FileEditTool 的 `findActualString()` 会自动处理弯引号（`''""`）到直引号的映射，模型无法输出弯引号但文件中可能存在。`preserveQuoteStyle()` 确保编辑后文件中的弯引号风格不被破坏。

- **反消毒（Desanitization）**：`normalizeFileEditInput()` 中的 `DESANITIZATIONS` 表处理 Claude API 对特定 XML 标签的消毒（如 `<fnr>` → `<function_results>`、`\n\nH:` → `\n\nHuman:`），确保编辑操作能匹配到实际文件内容（`utils.ts:531-574`）。

- **macOS 截图路径**：FileReadTool 处理 macOS 不同版本截图文件名中 AM/PM 前空格字符不一致的问题（普通空格 vs 窄不换行空格 U+202F），文件找不到时自动尝试替代路径（`FileReadTool.ts:147-159`）。

- **设备文件阻断**：FileReadTool 拒绝读取会导致进程挂起的设备文件（如 `/dev/zero`、`/dev/stdin`），但允许安全的设备文件如 `/dev/null`（`FileReadTool.ts:98-128`）。

- **文件读取去重**：FileReadTool 检测到同一文件、同一范围、未被修改时，返回 `file_unchanged` 存根而非重新发送全部内容，显著减少 cache_creation token 消耗（约 18% 的 Read 调用为重复读取）。

- **Windows 编码**：FileEditTool 通过检测 BOM（`0xFF 0xFE`）自动识别 UTF-16LE 编码，CRLF 行尾统一规范为 LF 处理。

- **NotebookEditTool 使用 `shouldDefer: true`**，意味着这个工具的 schema 默认不会被加载，只有在用户实际需要时才通过 ToolSearch 拉取，以减少初始加载开销。

- **Markdown 文件特殊处理**：`normalizeFileEditInput()` 在处理 `.md`/`.mdx` 文件时跳过尾部空白裁剪，因为 Markdown 中两个尾部空格是硬换行语法。