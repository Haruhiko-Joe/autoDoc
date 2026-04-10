# 命令处理（CommandProcessing）

## 概述与职责

命令处理模块是 Bash 解析管线（BashParsing）中的核心组件，负责三项关键任务：

1. **命令拆分**：将复杂的 Shell 命令字符串按操作符（`&&`、`||`、`;`、`|`）拆分为独立的子命令
2. **输出重定向提取**：从命令中识别并提取 `>`、`>>` 等重定向操作，供下游路径校验使用
3. **统一解析接口**：通过 `IParsedCommand` 接口提供 tree-sitter（AST）和正则（遗留）两种解析路径的统一访问方式

在整体架构中，本模块属于 **Infrastructure → ShellAndBash → BashParsing** 层级。它被权限系统（PermissionsAndAuth）调用以判断命令安全性，被 Shell 执行层（ShellExecution）调用以理解命令结构。同级模块包括 bashParser.ts（AST 解析器）、ast.ts（安全分类白名单）和 treeSitterAnalysis.ts（安全元数据提取）。

本模块由两个文件组成：
- **`commands.ts`**（1339 行）：基于 shell-quote 库的命令拆分和重定向提取实现
- **`ParsedCommand.ts`**（318 行）：统一解析命令接口定义和双实现

## 关键流程

### 1. 命令拆分流程（`splitCommandWithOperators`）

这是 commands.ts 的核心函数，将一个 Shell 命令字符串拆分为 token 数组（命令片段 + 操作符交替排列）。

**执行步骤**：

1. **生成随机盐占位符**：调用 `generatePlaceholders()` 生成带 16 字符随机 hex 盐的占位符字符串（如 `__SINGLE_QUOTE_a1b2c3d4e5f6g7h8__`），防止恶意命令包含字面量占位符字符串实施注入攻击（`src/utils/bash/commands.ts:20-36`）

2. **Heredoc 预提取**：调用 `extractHeredocs()` 将 heredoc 体替换为占位符，因为 shell-quote 无法正确处理 `<<` 语法（`src/utils/bash/commands.ts:94`）

3. **行续接处理**：用正则替换 `\+\n` 模式，奇数个反斜杠表示行续接（合并），偶数个反斜杠表示转义（保留换行为命令分隔符）。安全关键：不在合并处添加空格，否则 `tr\<newline>aceroute` 会被错误拆分为两个 token（`src/utils/bash/commands.ts:98-120`）

4. **shell-quote 解析**：将引号、换行、转义括号替换为带盐占位符后，调用 `tryParseShellCommand()` 解析。解析失败时返回续接合并后的原始命令作为单元素数组（fail-closed 设计）（`src/utils/bash/commands.ts:142-159`）

5. **Token 合并**：将相邻字符串和 glob token 合并为单个字符串（`src/utils/bash/commands.ts:172-191`）

6. **占位符还原**：将盐占位符还原为原始字符（引号、换行、括号），并恢复之前提取的 heredoc 内容（`src/utils/bash/commands.ts:232-242`）

### 2. 输出重定向提取流程（`extractOutputRedirections`）

从命令字符串中提取所有输出重定向目标，返回清理后的命令和重定向列表。

```typescript
// src/utils/bash/commands.ts:634-637
export function extractOutputRedirections(cmd: string): {
  commandWithoutRedirections: string
  redirections: Array<{ target: string; operator: '>' | '>>' }>
  hasDangerousRedirection: boolean
}
```

**执行步骤**：

1. **Heredoc 先于续接提取**：必须先提取 heredoc 再处理行续接。顺序错误会导致安全漏洞——引用型 heredoc 体中的 `\<newline>` 是字面值，先合并会改变定界符位置，使 `> /etc/passwd` 被吞入 heredoc 体内（`src/utils/bash/commands.ts:642-668`）

2. **行续接合并**：同 `splitCommandWithOperators` 的奇偶反斜杠逻辑（`src/utils/bash/commands.ts:677-683`）

3. **Fail-closed 解析**：shell-quote 解析失败时，设置 `hasDangerousRedirection: true`，强制下游向用户确认（`src/utils/bash/commands.ts:688-699`）

4. **子 shell 重定向识别**：检测 `(cmd) > file` 模式的重定向子 shell（`src/utils/bash/commands.ts:704-727`）

5. **逐 token 遍历**：跟踪命令替换深度（`$(...)`），仅在顶层提取重定向。每个重定向通过 `handleRedirection()` 处理（`src/utils/bash/commands.ts:733-780`）

6. **命令重构**：用 `reconstructCommand()` 从保留的 token 列表重建命令字符串，再通过 `restoreHeredocs()` 恢复 heredoc 内容（`src/utils/bash/commands.ts:782-789`）

### 3. ParsedCommand 统一解析流程

`ParsedCommand.parse()` 是外部调用者的唯一入口，自动选择 tree-sitter 或正则路径：

1. **单条目缓存检查**：比较与上次解析的命令是否相同，命中则直接返回缓存结果（`src/utils/bash/ParsedCommand.ts:310-313`）

2. **Tree-sitter 可用性探测**：通过 `getTreeSitterAvailable()`（memoized）尝试导入并调用 `parseCommand('echo test')`（`src/utils/bash/ParsedCommand.ts:240-248`）

3. **AST 路径**：可用时，调用原生解析器获取 AST root，然后通过 `buildParsedCommandFromRoot()` 构建 `TreeSitterParsedCommand` 实例（`src/utils/bash/ParsedCommand.ts:270-285`）

4. **正则回退**：tree-sitter 不可用或解析抛异常时，回退到 `RegexParsedCommand_DEPRECATED`，底层依赖 commands.ts 的 `splitCommandWithOperators` 和 `extractOutputRedirections`（`src/utils/bash/ParsedCommand.ts:288-289`）

## 函数签名与参数说明

### `splitCommandWithOperators(command: string): string[]`

将 Shell 命令拆分为 token 数组，保留操作符（`&&`、`||`、`;`、`|`、`>`、`>>`、`>&`）作为独立元素。

- **command**：原始 Shell 命令字符串
- **返回**：token 数组，命令片段和操作符交替排列。解析失败时返回 `[command]`（单元素）

> 源码位置：`src/utils/bash/commands.ts:85-249`

### `extractOutputRedirections(cmd: string): { commandWithoutRedirections, redirections, hasDangerousRedirection }`

提取命令中的所有输出重定向。

- **cmd**：原始命令字符串
- **返回**：
  - `commandWithoutRedirections`：去除重定向后的命令
  - `redirections`：`Array<{ target: string, operator: '>' | '>>' }>`
  - `hasDangerousRedirection`：包含动态展开（`$`、`` ` ``、glob 等）的重定向目标时为 `true`

> 源码位置：`src/utils/bash/commands.ts:634-790`

### `splitCommand_DEPRECATED(command: string): string[]`

**已废弃**。遗留的命令拆分函数，在 `splitCommandWithOperators` 基础上剥离重定向和控制操作符，返回纯命令列表。

> 源码位置：`src/utils/bash/commands.ts:265-369`

### `isHelpCommand(command: string): boolean`

判断是否为简单 help 命令（如 `git --help`）。满足条件：以 `--help` 结尾、无其他 flag、所有非 flag token 仅含字母数字。用于跳过 Haiku 前缀提取以节省 API 调用。

> 源码位置：`src/utils/bash/commands.ts:388-436`

### `isUnsafeCompoundCommand_DEPRECATED(command: string): boolean`

**已废弃**。判断命令是否为不安全的复合命令（含多个子命令且不是纯命令列表）。解析失败时返回 `true`（fail-closed）。

> 源码位置：`src/utils/bash/commands.ts:609-624`

### `ParsedCommand.parse(command: string): Promise<IParsedCommand | null>`

统一解析入口。优先使用 tree-sitter，不可用时回退到正则。内置单条目缓存。

> 源码位置：`src/utils/bash/ParsedCommand.ts:305-318`

### `buildParsedCommandFromRoot(command: string, root: Node): IParsedCommand`

从已有的 AST root 构建 `TreeSitterParsedCommand`，避免调用者已有 AST 时重复解析。

> 源码位置：`src/utils/bash/ParsedCommand.ts:255-268`

## 接口/类型定义

### `IParsedCommand`

统一的解析命令接口，两种实现都遵循此接口：

| 方法 | 返回类型 | 说明 |
|------|----------|------|
| `originalCommand` | `string`（只读属性） | 原始命令字符串 |
| `toString()` | `string` | 返回原始命令 |
| `getPipeSegments()` | `string[]` | 按管道符 `\|` 拆分的命令段 |
| `withoutOutputRedirections()` | `string` | 去除输出重定向后的命令 |
| `getOutputRedirections()` | `OutputRedirection[]` | 输出重定向列表 |
| `getTreeSitterAnalysis()` | `TreeSitterAnalysis \| null` | tree-sitter 安全分析数据（正则路径返回 null） |

> 源码位置：`src/utils/bash/ParsedCommand.ts:21-32`

### `OutputRedirection`

```typescript
type OutputRedirection = {
  target: string       // 重定向目标路径
  operator: '>' | '>>' // 覆盖或追加
}
```

> 源码位置：`src/utils/bash/ParsedCommand.ts:12-15`

### `TreeSitterParsedCommand`（内部类）

基于 AST 的实现。使用 UTF-8 Buffer 进行字节偏移切片（tree-sitter 返回 UTF-8 字节偏移，而非 JS 的 UTF-16 代码单元索引），确保多字节字符正确处理。

> 源码位置：`src/utils/bash/ParsedCommand.ts:151-238`

### `RegexParsedCommand_DEPRECATED`（导出类）

基于 shell-quote 的遗留实现，仅在 tree-sitter 不可用时使用。所有方法委托给 commands.ts 中的函数。

> 源码位置：`src/utils/bash/ParsedCommand.ts:42-99`

## 安全设计要点

### 随机盐防注入

`generatePlaceholders()` 使用 `crypto.randomBytes(8)` 为每次解析生成唯一盐值。如果占位符是固定字符串（如 `__SINGLE_QUOTE__`），攻击者可以构造包含该字面值的命令（如 `sort __SINGLE_QUOTE__ hello --help __SINGLE_QUOTE__`），在占位符还原阶段注入参数。

> 源码位置：`src/utils/bash/commands.ts:12-36`

### Fail-closed 设计

所有解析失败场景都采用安全保守策略：
- `splitCommandWithOperators`：解析失败返回原始命令作为单元素（交由权限系统整体校验）
- `extractOutputRedirections`：解析失败设置 `hasDangerousRedirection: true`（强制用户确认）
- `isUnsafeCompoundCommand_DEPRECATED`：解析失败返回 `true`（视为不安全）

### 静态重定向目标校验

`isStaticRedirectTarget()` 和 `isSimpleTarget()` 是一对互补的守门函数：
- 只有不包含 `$`、`` ` ``、`*`、`?`、`[`、`{`、`~`、`!`、`=` 等 shell 展开语法的目标才被视为"静态"
- 非静态目标通过 `hasDangerousExpansion()` 标记为危险，确保**每个**重定向目标要么被捕获（路径校验），要么被标记危险（用户确认），不存在遗漏路径

> 关键设计不变量（`src/utils/bash/commands.ts:823-828`）：对于每个字符串重定向目标，`isSimpleTarget` 为 true（→ 捕获 → 路径校验）或 `hasDangerousExpansion` 为 true（→ 标记危险 → 询问用户）。

### Heredoc 提取顺序

Heredoc 必须在行续接处理**之前**提取。错误顺序下，引用型 heredoc（`<< 'EOF'`）体内的 `\<newline>` 会被错误合并，导致定界符偏移，可能使危险的重定向（如 `> /etc/passwd`）被吞入 heredoc 体内，绕过路径校验。

### Zsh 特殊语法处理

`handleRedirection()` 覆盖了多种 Zsh 特有的重定向变体：
- `>!` / `>>!`：强制覆盖（noclobber 模式下）
- `>|` / `>>|`：POSIX 强制覆盖
- `>&!` / `>&|`：合并 stdout/stderr 的强制重定向
- `>>&!` / `>>&|`：合并 stdout/stderr 的强制追加

对于 `>!filename`（无空格）形式，剥离 `!` 后校验实际目标路径，因为 Zsh 将 `!` 视为强制覆盖前缀而非文件名的一部分。

## 命令前缀提取

模块还导出了 `getCommandSubcommandPrefix`，基于 `createSubcommandPrefixExtractor` 和 `createCommandPrefixExtractor` 构建，用于权限系统判断命令前缀（如 `git commit`、`npm test`）。内置的 `BASH_POLICY_SPEC` 定义了 LLM 辅助的前缀提取策略，包含注入检测规则。`isHelpCommand` 作为预检查跳过 LLM 调用。

> 源码位置：`src/utils/bash/commands.ts:438-513`

## 边界 Case 与注意事项

- **UTF-8 vs UTF-16**：`TreeSitterParsedCommand` 内部使用 `Buffer` 按 UTF-8 字节偏移切片，而非 JS `String.slice()`。对于 ASCII 两者一致，但多字节字符（如 `—` U+2014：UTF-8 占 3 字节，UTF-16 占 1 代码单元）会导致偏移不同
- **单条目缓存**：`ParsedCommand.parse` 仅缓存最近一次调用，避免泄漏 `TreeSitterParsedCommand` 实例。适用于连续多次对同一命令调用的场景
- **注释 token 处理**：shell-quote 将 `#foo` 解析为注释对象。`splitCommandWithOperators` 中需特殊处理注释内的占位符前缀（避免引号加倍导致 ReDoS），`isStaticRedirectTarget` 也拒绝 `#` 开头的目标以封闭解析器差异
- **`reconstructCommand` 中的引号安全**：包含 `\s`（任意空白字符）的字符串都会被引用，防止下游消费者（如 `ENV_VAR_PATTERN`）跨换行匹配导致的命令注入