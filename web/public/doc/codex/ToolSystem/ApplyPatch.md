# ApplyPatch — 补丁解析与应用工具

## 概述与职责

`codex-apply-patch`（crate 名 `codex_apply_patch`）是 Codex 工具系统（ToolSystem）中的核心文件编辑工具，负责将 LLM 生成的**自定义统一 diff 格式**补丁解析、校验并原子性地应用到文件系统上。它同时提供一个独立的 CLI 二进制 `apply_patch`，可直接通过命令行或管道调用。

在 Codex 架构中，当 Core 引擎收到模型返回的 `apply_patch` 工具调用时，ToolSystem 会将命令参数路由到本模块进行处理。本模块与同级的 shell 执行、file-search 等工具一起，构成了 Agent 修改代码的基础能力。

## 模块结构

本 crate 由 4 个源文件组成，各司其职：

| 文件 | 职责 |
|------|------|
| `parser.rs` | 补丁文本的词法/语法解析，生成 `Hunk` 列表 |
| `seek_sequence.rs` | 模糊行序列匹配——在源文件中定位 diff 上下文 |
| `invocation.rs` | 命令调用识别——从 `argv` 中提取补丁内容（支持直接调用、shell heredoc、cd 前缀等） |
| `standalone_executable.rs` + `main.rs` | 独立 CLI 入口点 |
| `lib.rs` | 公开 API，串联解析→计算替换→写入文件的完整流程 |

## 补丁格式

`apply_patch` 使用一种专有的、比标准 unified diff 更简洁的补丁格式。其 Lark 风格的形式化文法定义在 `src/parser.rs:6-21`：

```
Patch     := "*** Begin Patch" LF  { FileOp }  "*** End Patch" LF?
FileOp    := AddFile | DeleteFile | UpdateFile
AddFile   := "*** Add File: " path LF  { "+" line LF }
DeleteFile:= "*** Delete File: " path LF
UpdateFile:= "*** Update File: " path LF  [ "*** Move to: " newPath LF ]  { Hunk }
Hunk      := ("@@" [ " " header ]) LF  { HunkLine }  [ "*** End of File" LF ]
HunkLine  := (" " | "-" | "+") text LF
```

三种文件操作：
- **Add File**：创建新文件，后续每行以 `+` 前缀提供文件内容
- **Delete File**：删除已有文件，标记行后无需额外内容
- **Update File**：原地修改文件，可选 `Move to` 实现重命名；包含一个或多个 hunk，每个 hunk 以 `@@` 开头

每个 hunk 内的行前缀含义与标准 diff 一致：空格表示上下文行，`-` 表示删除，`+` 表示新增。

## 关键流程 Walkthrough

### 1. 命令识别与参数提取

入口点是 `maybe_parse_apply_patch_verified()`（`src/invocation.rs:132`），它接收 `argv` 和当前工作目录，返回一个 `MaybeApplyPatchVerified` 枚举。

支持的调用形式：
- **直接调用**：`["apply_patch", "<patch_body>"]` 或 `["applypatch", "<patch_body>"]`
- **Shell heredoc 调用**：`["bash", "-lc", "apply_patch <<'EOF'\n...\nEOF"]`
- **带 cd 前缀**：`["bash", "-lc", "cd some/dir && apply_patch <<'EOF'\n...\nEOF"]`
- **PowerShell / cmd.exe** 变体也被支持（`src/invocation.rs:58-67`）

Shell 脚本的解析使用 **tree-sitter Bash 语法**（`src/invocation.rs:263-308`）通过一个精心构造的查询来提取 heredoc 内容和可选的 `cd` 路径。查询使用锚点确保 heredoc 重定向的语句是脚本中唯一的顶层语句，防止误匹配。

安全检查：如果检测到原始补丁文本被直接作为单个参数传递（而非通过显式的 `apply_patch` 命令），会返回 `ImplicitInvocation` 错误（`src/invocation.rs:135-144`）。

### 2. 补丁解析

`parse_patch()`（`src/parser.rs:106`）将补丁文本转换为 `ApplyPatchArgs`，内含 `Vec<Hunk>`。

解析流程：
1. 检查首尾行是否为 `*** Begin Patch` / `*** End Patch` 标记
2. 在 **Lenient 模式**下（当前默认），额外支持 `<<EOF` / `<<'EOF'` heredoc 包装（`src/parser.rs:203-224`），这是因为 GPT-4.1 模型有时会将 heredoc 语法作为字面参数传递而非通过 shell 解析
3. 逐个解析 hunk：根据 `*** Add File:` / `*** Delete File:` / `*** Update File:` 前缀分发到不同逻辑
4. Update hunk 内部进一步解析为 `UpdateFileChunk` 列表，每个 chunk 包含可选的 `change_context`（`@@` 行）、`old_lines`、`new_lines` 和 `is_end_of_file` 标志

解析器对标记行周围的空白比较宽容（`src/parser.rs:250`：`first_line.trim()`），对于 Update hunk 的第一个 chunk，允许省略 `@@` 上下文标记行（`src/parser.rs:361-370`）。

### 3. 计算行级替换

`compute_replacements()`（`src/lib.rs:386-474`）是核心算法，将每个 `UpdateFileChunk` 转换为 `(start_index, old_len, new_lines)` 替换元组：

1. **上下文定位**：如果 chunk 有 `change_context`，用 `seek_sequence()` 在源文件中找到该上下文行的位置，将搜索起点推进到上下文之后
2. **纯插入处理**：如果 `old_lines` 为空，则在文件末尾（或末尾空行之前）插入新行
3. **模式匹配**：用 `seek_sequence()` 在源文件中搜索 `old_lines` 序列。如果首次搜索失败且模式以空行结尾（代表文件末尾换行符），则去除该空行后重试
4. 最终将所有替换按位置排序

### 4. 模糊行匹配（seek_sequence）

`seek_sequence()`（`src/seek_sequence.rs:12`）是定位补丁上下文的关键函数，采用**逐级降低严格度**的四轮匹配策略：

1. **精确匹配**：逐字比较
2. **右侧空白忽略**：`trim_end()` 后比较
3. **两侧空白忽略**：`trim()` 后比较
4. **Unicode 标准化**：将 typographic 标点（各种 dash `\u{2010}-\u{2015}`、`\u{2212}`，花式引号 `\u{2018}-\u{201F}`，特殊空格 `\u{00A0}` 等）规范化为 ASCII 等价字符后比较

当 `eof` 标志为 `true` 时，搜索从文件末尾开始，确保末尾修改能正确定位。

防御性处理：当 pattern 长于 lines 时提前返回 `None`，避免越界 panic（`src/seek_sequence.rs:26-28`）。

### 5. 应用替换并写入文件

`apply_replacements()`（`src/lib.rs:478-502`）按**降序**遍历替换列表，依次移除旧行、插入新行，避免索引偏移问题。

`apply_hunks_to_files()`（`src/lib.rs:279-339`）将每个 hunk 应用到文件系统：
- **AddFile**：必要时创建父目录（`create_dir_all`），然后写入内容
- **DeleteFile**：删除文件
- **UpdateFile**：计算新内容后写入；若有 `move_path`，则写入新路径并删除原文件

操作完成后通过 `print_summary()` 输出 git 风格的变更摘要（`A`/`M`/`D` 前缀）。

### 6. 验证模式（Verified）

`maybe_parse_apply_patch_verified()` 不仅解析补丁，还会：
- 解析 `cd` 指定的工作目录，将相对路径解析为绝对路径（`src/invocation.rs:152-162`）
- 读取待修改文件的当前内容
- 调用 `unified_diff_from_chunks()` 生成标准 unified diff（使用 `similar` crate），用于在 TUI 中展示变更预览
- 将所有变更收集到 `ApplyPatchAction` 的 `HashMap<PathBuf, ApplyPatchFileChange>` 中

这使得调用方（Core 引擎）可以先审批变更再实际执行。

## 函数签名与公开 API

### `apply_patch(patch: &str, stdout: &mut impl Write, stderr: &mut impl Write) -> Result<(), ApplyPatchError>`

主入口：解析补丁文本，应用所有 hunk 到文件系统，并将结果摘要/错误写入 stdout/stderr。

> 源码位置：`src/lib.rs:183-213`

### `maybe_parse_apply_patch_verified(argv: &[String], cwd: &Path) -> MaybeApplyPatchVerified`

从命令行参数中检测并解析 apply_patch 调用，返回经验证的变更集或分类后的错误/非匹配结果。`cwd` 必须是绝对路径。

> 源码位置：`src/invocation.rs:132-217`

### `parse_patch(patch: &str) -> Result<ApplyPatchArgs, ParseError>`

将补丁文本解析为结构化的 `ApplyPatchArgs`（包含 `hunks: Vec<Hunk>`）。

> 源码位置：`src/parser.rs:106-113`

### `unified_diff_from_chunks(path: &Path, chunks: &[UpdateFileChunk]) -> Result<ApplyPatchFileUpdate, ApplyPatchError>`

读取指定文件，应用 chunks 计算新内容，生成标准 unified diff 字符串。默认 context radius 为 1 行。

> 源码位置：`src/lib.rs:511-516`

### `main() -> !`

CLI 入口点。接受一个参数（补丁文本）或从 stdin 读取，调用 `apply_patch()` 执行。

> 源码位置：`src/standalone_executable.rs:4-59`

## 核心类型定义

### `Hunk`（`src/parser.rs:58-76`）

```rust
pub enum Hunk {
    AddFile { path: PathBuf, contents: String },
    DeleteFile { path: PathBuf },
    UpdateFile { path: PathBuf, move_path: Option<PathBuf>, chunks: Vec<UpdateFileChunk> },
}
```

### `UpdateFileChunk`（`src/parser.rs:90-104`）

```rust
pub struct UpdateFileChunk {
    pub change_context: Option<String>,  // @@ 后的上下文行（通常是函数/类定义）
    pub old_lines: Vec<String>,          // 需要被替换的原始行
    pub new_lines: Vec<String>,          // 替换后的新行
    pub is_end_of_file: bool,            // 是否锚定到文件末尾
}
```

### `ApplyPatchAction`（`src/lib.rs:127-138`）

验证模式的输出，包含 `changes: HashMap<PathBuf, ApplyPatchFileChange>`、原始 `patch` 文本和解析后的 `cwd`。所有路径均为绝对路径。

### `ApplyPatchFileChange`（`src/lib.rs:94-108`）

```rust
pub enum ApplyPatchFileChange {
    Add { content: String },
    Delete { content: String },
    Update { unified_diff: String, move_path: Option<PathBuf>, new_content: String },
}
```

### `MaybeApplyPatchVerified`（`src/lib.rs:110-123`）

```rust
pub enum MaybeApplyPatchVerified {
    Body(ApplyPatchAction),        // 成功解析并验证
    ShellParseError(...),          // shell 脚本解析失败
    CorrectnessError(ApplyPatchError),  // 补丁语义错误
    NotApplyPatch,                 // 非 apply_patch 命令
}
```

## 配置项与常量

- `PARSE_IN_STRICT_MODE`（`src/parser.rs:47`）：当前硬编码为 `false`，启用 Lenient 解析模式以兼容 GPT-4.1 的 heredoc 输出格式
- `APPLY_PATCH_COMMANDS`（`src/invocation.rs:25`）：识别的命令名 `["apply_patch", "applypatch"]`
- `CODEX_CORE_APPLY_PATCH_ARG1`（`src/lib.rs:35`）：`"--codex-run-as-apply-patch"`，Codex 主进程自调用 apply_patch 子进程时使用的标志
- `APPLY_PATCH_TOOL_INSTRUCTIONS`（`src/lib.rs:26`）：嵌入的工具使用说明（`apply_patch_tool_instructions.md`），作为 prompt 的一部分发送给模型

## 边界 Case 与注意事项

- **Lenient 解析**：默认开启，会自动剥离 `<<EOF` / `<<'EOF'` / `<<"EOF"` 包装，但不接受引号不匹配的形式（如 `<<"EOF'`）
- **尾部换行处理**：读取文件后会移除 `split('\n')` 产生的末尾空元素（`src/lib.rs:366-368`）；写入前会确保文件以换行符结尾（`src/lib.rs:373-375`）
- **纯插入 chunk**（`old_lines` 为空）：插入位置在文件末尾，如果存在末尾空行则在其前面插入（`src/lib.rs:417-423`）
- **Unicode 标点模糊匹配**：EN DASH、EM DASH、花式引号、不间断空格等会被规范化为 ASCII 等价字符，这使得 ASCII 编写的补丁能应用到包含 typographic 字符的源文件（`src/seek_sequence.rs:76-94`）
- **隐式调用检测**：如果补丁文本被直接作为单参数或 shell 脚本体传入（而不是通过 `apply_patch` 命令），会返回 `ImplicitInvocation` 错误而非静默应用
- **文件路径只能是相对路径**（在补丁文本中），由调用方提供的 `cwd` 进行解析
- **替换按降序应用**：`apply_replacements()` 从后向前处理替换，避免前面的替换导致后面的索引失效
- **空补丁被拒绝**：不含任何 hunk 的补丁会触发 "No files were modified." 错误（`src/lib.rs:280-282`）
- **tree-sitter 查询的保守性**：heredoc 提取查询要求 apply_patch 是脚本中唯一的顶层语句，带 `cd` 时只允许 `&&` 连接符，不接受 `;`、`||`、`|` 等形式