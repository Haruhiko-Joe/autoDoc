# BashParser — 纯 TypeScript Bash 解析器

## 概述与职责

BashParser 是 Claude Code 的 **Bash 命令解析核心**，位于 `Infrastructure > ShellAndBash > BashParsing` 层级中。它由两个文件组成：

- **`bashParser.ts`**（4436 行）：纯 TypeScript 实现的完整 Bash tokenizer + parser，产出 tree-sitter-bash 兼容的 AST（`TsNode`）
- **`parser.ts`**（231 行）：桥接层，添加特性门控（feature flag）、长度限制、解析中止信号，并提供对外 API

整个解析管线的最终目标是为下游安全分析模块（`ast.ts`）提供结构化的 AST，使得权限系统能够判断用户输入的 Bash 命令是否安全。同级模块 `ast.ts` 基于 AST 进行白名单 argv 提取，`treeSitterAnalysis.ts` 提取安全元数据，`commands.ts` 处理命令拆分。

## 关键流程

### 1. 解析入口：从用户命令到 AST

外部调用通过 `parser.ts` 暴露的两个入口进入：

1. **`parseCommand(command)`**：完整解析，返回 `ParsedCommandData`（含 rootNode、envVars、commandNode）
2. **`parseCommandRaw(command)`**：轻量解析，仅返回根 AST 节点，供安全分析模块 `ast.ts` 使用

两个入口都经过相同的前置检查：
- 命令非空且长度 ≤ 10000 字符（`MAX_COMMAND_LENGTH`）
- Feature flag `TREE_SITTER_BASH` 或 `TREE_SITTER_BASH_SHADOW` 启用
- 调用 `bashParser.ts` 的 `getParserModule().parse(command)`

> 源码位置：`src/utils/bash/parser.ts:56-136`

### 2. Tokenizer 词法分析

Tokenizer 将源字符串拆分为 16 种 token 类型：

| Token 类型 | 说明 | 示例 |
|-----------|------|------|
| `WORD` | 裸字/标识符 | `echo`, `file.txt` |
| `NUMBER` | 纯数字 | `42`, `-1` |
| `OP` | 操作符 | `\|`, `&&`, `>>`, `((` |
| `NEWLINE` | 换行符 | `\n` |
| `COMMENT` | 注释 | `# comment` |
| `DQUOTE` | 双引号开始 | `"` |
| `SQUOTE` | 单引号字符串 | `'text'` |
| `ANSI_C` | ANSI-C 字符串 | `$'text'` |
| `DOLLAR` | 裸 `$` | `$` |
| `DOLLAR_PAREN` | 命令替换开始 | `$(` |
| `DOLLAR_BRACE` | 参数展开开始 | `${` |
| `DOLLAR_DPAREN` | 算术展开开始 | `$((` |
| `BACKTICK` | 反引号 | `` ` `` |
| `LT_PAREN` | 进程替换（输入） | `<(` |
| `GT_PAREN` | 进程替换（输出） | `>(` |
| `EOF` | 输入结束 | - |

Lexer 核心是 `nextToken(L, ctx)` 函数，其中 `ctx` 参数区分命令位置（`'cmd'`）和参数位置（`'arg'`）——在命令位置 `[` 被视为操作符（test 命令），在参数位置 `[` 被视为普通字符（glob/下标）。

Lexer 同时维护 **JS 字符串索引**（`i`）和 **UTF-8 字节偏移**（`b`），因为 `TsNode` 的 `startIndex`/`endIndex` 使用 UTF-8 字节偏移以兼容 tree-sitter 的约定。对于纯 ASCII 输入（快速路径），两者相等；对于非 ASCII 输入，通过延迟构建的 `byteTable`（`Uint32Array`）进行映射。

> 源码位置：`src/utils/bash/bashParser.ts:48-591`

### 3. Parser 语法分析

Parser 采用**递归下降**架构，按以下层级解析 Bash 语法：

```
parseProgram
  └── parseStatements        # 分号/&/换行 分隔的语句序列
        └── parseAndOr       # && || 链（产出 list 节点）
              └── parsePipeline   # | |& 管道
                    └── parseCommand  # 单条命令
```

`parseCommand` 是语法分析的核心分发函数，根据首 token 类型分发到不同的解析路径：

| 首 token | 解析函数 | 产出 AST 节点 |
|----------|---------|-------------|
| `!` | 内联处理 | `negated_command` |
| `(` | 内联处理 | `subshell` |
| `((` | 内联处理 | `compound_statement` |
| `{` | 内联处理 | `compound_statement` |
| `[` / `[[` | 内联处理 | `test_command` |
| `if` | `parseIf` | `if_statement` |
| `while`/`until` | `parseWhile` | `while_statement` |
| `for` | `parseFor` | `for_statement` / `c_style_for_statement` |
| `case` | `parseCase` | `case_statement` |
| `function` | `parseFunction` | `function_definition` |
| 声明关键字 | `parseDeclaration` | `declaration_command` |
| 其他 | `parseSimpleCommand` | `command` / `variable_assignment` |

> 源码位置：`src/utils/bash/bashParser.ts:994-1135`

### 4. 简单命令解析（parseSimpleCommand）

这是最常用的路径。解析流程：

1. 先贪婪地解析前置赋值语句（`VAR=value`）和前置重定向
2. 检查是否为函数定义（`name() { ... }`）
3. 解析 `command_name` + 参数列表 + 后置重定向
4. 如果有重定向，包裹为 `redirected_statement`

关键设计：前置重定向（如 `2>&1 cat`）放入 `command` 节点内部（command_name 之前），后置重定向包裹在外层的 `redirected_statement` 中。这与 tree-sitter-bash 的 AST 结构保持一致。

> 源码位置：`src/utils/bash/bashParser.ts:1141-1404`

### 5. 超时与节点预算保护

每创建一个 AST 节点都会调用 `checkBudget(P)`：

- **节点上限**：50,000 个节点（`MAX_NODES`），超过直接 `throw`
- **时间上限**：50ms（`PARSE_TIMEOUT_MS`），每 128 个节点检查一次 `performance.now()`
- 两者触发时都设置 `P.aborted = true`，`parseSource` 返回 `null`

> 源码位置：`src/utils/bash/bashParser.ts:29-32, 647-657`

### 6. 桥接层的中止信号（PARSE_ABORTED）

`parser.ts` 中定义了 `PARSE_ABORTED` Symbol，用于区分"解析器不可用"和"解析器可用但解析失败"：

- **`null`**：模块未加载 / feature 关闭 / 输入为空或过长
- **`PARSE_ABORTED`**：模块已加载但解析失败（超时/节点预算/异常）

这个区分对安全性至关重要：收到 `PARSE_ABORTED` 时，调用方**必须按 fail-closed 处理**（视为过于复杂的危险命令），而不是回退到旧的正则解析路径。此设计防止了攻击者通过构造复杂输入（如 `(( a[0][0]... ))` 约 2800 个下标）绕过安全检查。

> 源码位置：`src/utils/bash/parser.ts:87-136`

## 函数签名与参数说明

### bashParser.ts 导出

#### `ensureParserInitialized(): Promise<void>`
空操作——纯 TS 实现无需异步初始化，仅保留以兼容原 WASM parser 接口。

#### `getParserModule(): ParserModule | null`
返回 `{ parse }` 模块对象。始终成功，不返回 `null`。

#### `SHELL_KEYWORDS: Set<string>`
Bash shell 关键字集合（`if`、`then`、`elif`、`fi`、`while`、`for`、`do`、`done`、`case`、`esac`、`function`、`select` 等），下游用于命令前缀提取。

### parser.ts 导出

#### `parseCommand(command: string): Promise<ParsedCommandData | null>`
完整解析入口。返回 `ParsedCommandData` 包含：
- `rootNode`：AST 根节点
- `commandNode`：第一个 command/declaration_command 节点
- `envVars`：前置环境变量赋值列表（如 `["FOO=bar"]`）
- `originalCommand`：原始命令字符串

#### `parseCommandRaw(command: string): Promise<Node | null | typeof PARSE_ABORTED>`
轻量解析入口，跳过 `findCommandNode`/`extractEnvVars` 的树遍历。三态返回值见上文。

#### `extractCommandArguments(commandNode: Node): string[]`
从 command 节点中提取命令名和参数列表。对 `declaration_command` 返回首关键字（如 `["export"]`）。遇到命令替换/进程替换时停止提取。

#### `PARSE_ABORTED: Symbol`
解析中止哨兵值。调用方必须将此视为 fail-closed。

#### `ensureInitialized(): Promise<void>`
按 feature flag 条件调用 `ensureParserInitialized()`。

## 接口/类型定义

### `TsNode`（核心 AST 节点）

```typescript
type TsNode = {
  type: string        // 节点类型（如 "command", "pipeline", "word"）
  text: string        // 该节点对应的源码文本
  startIndex: number  // UTF-8 字节偏移（起始）
  endIndex: number    // UTF-8 字节偏移（结束，不含）
  children: TsNode[]  // 子节点列表
}
```

> 源码位置：`src/utils/bash/bashParser.ts:12-18`

### `ParsedCommandData`

```typescript
interface ParsedCommandData {
  rootNode: Node           // AST 根节点（type="program"）
  envVars: string[]        // 前置环境变量（如 ["A=1", "B=2"]）
  commandNode: Node | null // 第一个 command 节点
  originalCommand: string  // 原始输入
}
```

> 源码位置：`src/utils/bash/parser.ts:12-17`

### `ParseState`（内部状态）

```typescript
type ParseState = {
  L: Lexer            // 词法分析器状态
  src: string         // 源字符串
  srcBytes: number    // 源字符串 UTF-8 字节长度
  isAscii: boolean    // 快速路径标志
  nodeCount: number   // 已创建节点计数
  deadline: number    // 超时截止时间戳
  aborted: boolean    // 是否已中止
  inBacktick: number  // 反引号嵌套深度
  stopToken: string | null // 可选的终止 token
}
```

> 源码位置：`src/utils/bash/bashParser.ts:595-608`

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `PARSE_TIMEOUT_MS` | 50 | 解析超时（毫秒），可通过 `parse(src, Infinity)` 禁用 |
| `MAX_NODES` | 50,000 | 最大 AST 节点数，防止 OOM |
| `MAX_COMMAND_LENGTH` | 10,000 | 命令最大字符数（parser.ts） |

Feature flags（`bun:bundle`）：
- `TREE_SITTER_BASH`：启用 Bash 解析主路径
- `TREE_SITTER_BASH_SHADOW`：启用影子模式（仅 `parseCommandRaw` 可用）

## 支持的 Bash 语法特性

Parser 支持几乎完整的 Bash 语法，包括：

- **管道与列表**：`|`、`|&`、`&&`、`||`、`;`、`&`
- **重定向**：`>`、`>>`、`<`、`>&`、`<&`、`&>`、`&>>`、`>|`、`<&-`、`>&-`
- **Heredoc**：`<<`、`<<-`（strip tabs）、`<<<`（herestring）
- **命令替换**：`$(...)` 和 `` `...` ``
- **算术展开**：`$((...))` 和 `$[...]`（旧语法）
- **参数展开**：`${var}`、`${var:-default}`、`${var:offset:length}`、`${var/pat/repl}`、`${#var}`、`${!prefix*}` 等全部操作符
- **控制结构**：`if/elif/else/fi`、`while/until`、`for/in/do/done`、C 风格 `for((;;))`、`case/esac`、`select`
- **函数定义**：`function name { }` 和 `name() { }`
- **声明命令**：`export`、`declare`、`local`、`readonly`、`typeset`
- **Test 命令**：`[ ]`、`[[ ]]`（含 `=~` 正则匹配）
- **进程替换**：`<(...)` 和 `>(...)`
- **子 shell**：`( ... )`
- **花括号展开**：`{1..5}`
- **算术表达式**：完整的优先级爬升解析器，支持 `+ - * / % ** << >> & | ^ ~ ! ++ -- ?: ,` 及赋值操作符

## 边界 Case 与注意事项

### 安全相关

- **Fail-closed 设计**：解析超时或节点超限时返回 `null`/`PARSE_ABORTED`，调用方必须拒绝而非放行。此设计堵住了通过构造深度嵌套输入绕过安全分析的攻击路径
- **Heredoc 安全**：`ls <<'EOF' | rm -rf /tmp/evil` 中管道后的命令会被正确嵌套到 `heredoc_redirect` 节点内，`ast.ts` 的 `walkHeredocRedirect` 对未识别子节点执行 fail-closed
- **花括号注入防护**：`echo {;touch /tmp/evil` 中 `{` 后跟命令终止符时，不会吞掉后续内容，确保 `touch` 被安全分析器看到（`src/utils/bash/bashParser.ts:2089-2108`）
- **unset 安全**：使用 `parseWord` 而非原始 `nextToken` 解析 `unset` 参数，确保 `unset 'a[$(id)]'` 中的引号字符串被正确解析，不会隐藏算术下标代码执行向量（`src/utils/bash/bashParser.ts:3668-3671`）

### Lexer 回溯机制

Parser 大量使用 `saveLex`/`restoreLex` 进行回溯。为避免堆分配，lexer 状态打包为单个 number：`(b << 16) | i`——这限制了支持的源码长度（char index ≤ 65535），但对于 `MAX_COMMAND_LENGTH = 10000` 完全足够。

> 源码位置：`src/utils/bash/bashParser.ts:754-762`

### tree-sitter 兼容性

Parser 经过 3449 个 golden corpus 测试用例验证，刻意复现了 tree-sitter-bash 的多个 quirk：

- 管道中间命令的重定向会提升到包裹整个前序管道的 `redirected_statement` 中
- `&&`/`||` 链尾部的重定向会包裹整个 `list` 节点
- 双引号内的纯空白 `string_content` 被省略
- case pattern 中 extglob 操作符前缀（`-o`）在空 body 时降级为 `word`
- 空反引号（仅含空白/换行）被完全省略

### 算术表达式

算术 parser 使用**优先级爬升**（precedence climbing）算法，支持 18 级优先级和右结合性（赋值操作符和 `**`）。三种模式（`var`/`word`/`assign`）对应不同上下文中标识符的解析方式：

- `var` 模式（`$(())`、`(())`）：裸标识符 → `variable_name`
- `word` 模式（c-style for 的条件/更新）：裸标识符 → `word`
- `assign` 模式（c-style for 的初始化）：`ident = expr` → `variable_assignment`

> 源码位置：`src/utils/bash/bashParser.ts:4071-4424`