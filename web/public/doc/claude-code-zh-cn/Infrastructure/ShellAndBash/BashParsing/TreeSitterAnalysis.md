# TreeSitterAnalysis — 基于 Tree-sitter AST 的安全元数据提取

## 概述与职责

`treeSitterAnalysis.ts` 是 Bash 安全解析管线中的关键组件，负责从 tree-sitter 生成的 AST（抽象语法树）中提取安全相关的结构化元数据。它位于 **Infrastructure → ShellAndBash → BashParsing** 层级中，与 `bashParser.ts`（纯 TS tokenizer/parser）和 `ast.ts`（argv 白名单提取）并列，共同构成 Bash 命令安全分析的基础设施。

该模块的核心设计理念是 **"用 AST 替代正则"**——相比逐字符或正则解析，tree-sitter AST 能精确区分语法结构与字面文本（例如 `find -exec \;` 中的 `\;` 是参数而非 `;` 操作符），从而大幅减少误报。

模块通过一次 `analyzeCommand()` 调用，提取三类安全信息：
1. **引号上下文（QuoteContext）**：区分单引号/双引号/完全去引号后的命令文本
2. **复合结构（CompoundStructure）**：检测管道、子 shell、命令组、逻辑操作符
3. **危险模式（DangerousPatterns）**：检测命令替换、进程替换、参数展开、heredoc、注释

## 关键流程

### analyzeCommand 主入口

`analyzeCommand()` 是对外的统一入口（`src/utils/bash/treeSitterAnalysis.ts:496-506`），接收 tree-sitter 根节点和原始命令字符串，返回完整的 `TreeSitterAnalysis` 结果：

```typescript
export function analyzeCommand(
  rootNode: unknown,
  command: string,
): TreeSitterAnalysis
```

内部依次调用四个提取函数：
1. `extractQuoteContext(rootNode, command)` → 引号上下文
2. `extractCompoundStructure(rootNode, command)` → 复合结构
3. `hasActualOperatorNodes(rootNode)` → 是否存在真实操作符节点
4. `extractDangerousPatterns(rootNode)` → 危险模式

### 引号上下文提取流程

这是模块中最复杂的部分，核心目标是生成三种"去引号"视图，供下游安全校验器使用。

**Step 1 — 收集引号跨度（`collectQuoteSpans`）**

单次递归遍历 AST，同时收集四类引号跨度（`src/utils/bash/treeSitterAnalysis.ts:88-137`）：
- `raw_string`：单引号 `'...'`，Bash 中无任何展开，遇到即停止递归
- `ansi_c_string`：ANSI-C 引号 `$'...'`，跨度包含前导 `$`，遇到即停
- `string`：双引号 `"..."`，只收集最外层（通过 `inDouble` 标志追踪），但会递归进入内部的 `$()` 等子节点以捕获嵌套的单引号
- `heredoc_redirect`：仅收集**带引号的** heredoc（`<<'EOF'`、`<<"EOF"`、`<<\EOF`），因为它们的 body 是字面量；不带引号的 heredoc 中 `$()`/`${}` 会展开，需要保留给校验器

这一步之前需要 5 次独立的树遍历，融合后减少约 5 倍遍历次数。

**Step 2 — 构建三种去引号视图（`extractQuoteContext`，`src/utils/bash/treeSitterAnalysis.ts:224-290`）**

| 视图 | 说明 | 用途 |
|------|------|------|
| `withDoubleQuotes` | 移除单引号/ANSI-C/heredoc 内容，保留双引号内容（但去掉 `"` 定界符本身） | 检测双引号内仍可展开的危险模式 |
| `fullyUnquoted` | 移除所有引号包裹的内容 | 检测完全裸露的危险模式 |
| `unquotedKeepQuoteChars` | 移除引号内容但保留引号字符本身（`'`、`"`） | 保持原始位置映射，用于需要知道"这里有引号"的场景 |

关键辅助函数：
- `buildPositionSet()`：将跨度列表转为字符位置 Set，用于逐字符过滤
- `removeSpans()`：从字符串中移除指定跨度区间
- `dropContainedSpans()`：去除完全被包含的嵌套跨度，避免内外层跨度偏移导致索引错乱
- `replaceSpansKeepQuotes()`：替换跨度内容为引号定界符

### 复合结构提取流程

`extractCompoundStructure()`（`src/utils/bash/treeSitterAnalysis.ts:296-411`）通过 `walkTopLevel()` 递归遍历 AST 顶层结构，识别：

- **`list` 节点**：包含 `&&` / `||` 操作符的复合命令
- **`;` 节点**：分号分隔的多命令
- **`pipeline` 节点**：管道命令
- **`subshell` 节点**：子 shell `(...)`
- **`compound_statement` 节点**：命令组 `{...}`
- **`redirected_statement`**：包装了重定向的语句，需递归进入内部以检测被包裹的复合结构（如 `cd ~/src && find path 2>/dev/null`，整体被包在 `redirected_statement` 内）
- **`negated_command`**：`! cmd`，递归检测内部结构
- **控制流语句**（`if`/`while`/`for`/`case`/`function_definition`）：作为一个段落记录，同时递归检测内部的管道/子 shell

每识别到一个命令段就加入 `segments` 数组，每识别到一个操作符就加入 `operators` 数组。如果遍历完没有任何 segment，整条命令作为唯一 segment。

### 操作符节点检测

`hasActualOperatorNodes()`（`src/utils/bash/treeSitterAnalysis.ts:421-443`）是消除 **`find -exec \;` 误报**的关键函数。

tree-sitter 会把 `\;` 解析为 `word` 节点（find 的参数），而非 `;` 操作符节点。因此只需检查 AST 中是否存在类型为 `;`、`&&`、`||` 的节点或 `list` 节点。如果不存在，说明命令中没有真实的复合操作符，后续可跳过转义操作符检测（`hasBackslashEscapedOperator()`）。

### 危险模式提取

`extractDangerousPatterns()`（`src/utils/bash/treeSitterAnalysis.ts:448-489`）通过全树递归遍历，检测五种 AST 节点类型：

| AST 节点类型 | 对应标志 | 安全含义 |
|---|---|---|
| `command_substitution` | `hasCommandSubstitution` | `$(...)` 或反引号命令替换，可执行任意命令 |
| `process_substitution` | `hasProcessSubstitution` | `<(...)` / `>(...)` 进程替换 |
| `expansion` | `hasParameterExpansion` | `${...}` 参数展开，可能通过 `${!var}` 间接展开 |
| `heredoc_redirect` | `hasHeredoc` | Here Document |
| `comment` | `hasComment` | 注释可能隐藏危险命令 |

## 类型定义

### `TreeSitterNode`（内部类型）

tree-sitter 解析树节点的结构定义（`src/utils/bash/treeSitterAnalysis.ts:12-19`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `string` | 节点类型（如 `command`、`raw_string`、`pipeline`） |
| `text` | `string` | 节点对应的源码文本 |
| `startIndex` | `number` | 在原始命令中的起始字符位置 |
| `endIndex` | `number` | 在原始命令中的结束字符位置 |
| `children` | `TreeSitterNode[]` | 子节点数组 |
| `childCount` | `number` | 子节点数量 |

### `QuoteContext`（导出类型）

引号上下文分析结果（`src/utils/bash/treeSitterAnalysis.ts:21-28`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `withDoubleQuotes` | `string` | 移除单引号内容后的命令（双引号内容保留） |
| `fullyUnquoted` | `string` | 移除所有引号内容后的命令 |
| `unquotedKeepQuoteChars` | `string` | 移除引号内容但保留引号字符本身 |

### `CompoundStructure`（导出类型）

复合命令结构分析结果（`src/utils/bash/treeSitterAnalysis.ts:30-43`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `hasCompoundOperators` | `boolean` | 是否有顶层复合操作符 |
| `hasPipeline` | `boolean` | 是否有管道 |
| `hasSubshell` | `boolean` | 是否有子 shell |
| `hasCommandGroup` | `boolean` | 是否有命令组 `{...}` |
| `operators` | `string[]` | 找到的操作符列表（`&&`、`||`、`;`） |
| `segments` | `string[]` | 按操作符拆分的命令段 |

### `DangerousPatterns`（导出类型）

危险模式检测结果（`src/utils/bash/treeSitterAnalysis.ts:45-56`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `hasCommandSubstitution` | `boolean` | 存在 `$()` 或反引号命令替换 |
| `hasProcessSubstitution` | `boolean` | 存在 `<()` 或 `>()` 进程替换 |
| `hasParameterExpansion` | `boolean` | 存在 `${...}` 参数展开 |
| `hasHeredoc` | `boolean` | 存在 heredoc |
| `hasComment` | `boolean` | 存在注释 |

### `TreeSitterAnalysis`（导出类型）

`analyzeCommand()` 的完整返回类型（`src/utils/bash/treeSitterAnalysis.ts:58-64`），聚合上述三类分析结果加一个布尔标志。

### `QuoteSpans`（内部类型）

`collectQuoteSpans` 的中间结果（`src/utils/bash/treeSitterAnalysis.ts:66-71`），按引号类型分组存储 `[startIndex, endIndex]` 跨度对。

## 函数签名

### `analyzeCommand(rootNode: unknown, command: string): TreeSitterAnalysis`

主入口。对 tree-sitter AST 执行完整的安全分析，返回聚合结果。

### `extractQuoteContext(rootNode: unknown, command: string): QuoteContext`

提取引号上下文，生成三种去引号视图。

### `extractCompoundStructure(rootNode: unknown, command: string): CompoundStructure`

提取复合命令结构——操作符、管道、子 shell、命令组、段落。

### `hasActualOperatorNodes(rootNode: unknown): boolean`

检测 AST 中是否存在真实的操作符节点（`;`、`&&`、`||`、`list`），用于排除 `\;` 等转义字符的误报。

### `extractDangerousPatterns(rootNode: unknown): DangerousPatterns`

提取五种危险 shell 模式的存在性。

## 边界 Case 与注意事项

- **`find -exec \;` 误报消除**：这是 `hasActualOperatorNodes()` 存在的核心原因。tree-sitter 把 `\;` 解析为 `word`（参数），不会匹配为 `;` 操作符。旧的正则/字符解析方式无法做此区分。

- **嵌套引号处理**：`"$(echo 'hi')"` 场景中，外层 `"..."` 和内层 `'...'` 都会被 `collectQuoteSpans` 收集。`dropContainedSpans()` 负责在后续处理时去除完全被包含的跨度，防止移除外层跨度后内层跨度的索引失效。

- **带引号与不带引号的 heredoc 区别**：带引号的 heredoc（`<<'EOF'`）body 是字面量，安全地移除；不带引号的 heredoc（`<<EOF`）中 `$()`/`${}` 会被 Bash 展开，必须保留给安全校验器检查。判断逻辑在 `collectQuoteSpans` 中通过检查 `heredoc_start` 节点文本的首字符（`'`、`"`、`\`）实现。

- **`redirected_statement` 递归穿透**：tree-sitter 可能将整个复合命令（如 `cmd1 && cmd2 2>/dev/null`）包装在 `redirected_statement` 中。`walkTopLevel` 会递归进入其内部以检测被包裹的复合结构，同时跳过 `file_redirect` 子节点。

- **`rootNode` 类型为 `unknown`**：所有公开函数接收 `unknown` 类型的根节点，内部转为 `TreeSitterNode`。这是因为 native NAPI parser 返回的是普通 JS 对象，不需要特殊清理（注释中注明"no cleanup needed"）。

- **性能优化**：`collectQuoteSpans` 将原先 5 次独立的树遍历（分别收集 raw_string、ansi_c_string、string、allQuoteTypes、heredoc）融合为单次遍历，减少约 5 倍遍历开销。通过 `inDouble` 布尔标志追踪是否已进入双引号节点，确保只收集最外层双引号跨度。