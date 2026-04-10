# AST 安全分析核心

## 概述与职责

`ast.ts` 是 Claude Code 权限系统的安全分析核心，位于 **Infrastructure → ShellAndBash → BashParsing** 层级中。它基于 tree-sitter 生成的 Bash AST，以**白名单（allowlist）+ fail-closed** 的设计理念，将用户输入的 Bash 命令解析为结构化的 `SimpleCommand[]`（包含 argv、环境变量赋值、重定向信息），供下游权限规则匹配使用。

**核心设计原则**：这不是沙箱，不阻止危险命令运行。它只回答一个问题——"能否为这条命令产出可信的 argv[]？"如果能，下游代码可以用 argv[0] 去匹配权限规则和白名单；如果不能（返回 `too-complex`），则强制走权限提示流程让用户确认。

同级模块 `bashParser.ts` 负责将 Bash 源码解析为 tree-sitter 兼容的 AST，`treeSitterAnalysis.ts` 提取引号上下文等安全元数据，`commands.ts` 处理命令拆分——而 `ast.ts` 在此流水线中扮演"从 AST 到结构化命令"的关键转换角色。

## 关键类型定义

### `SimpleCommand`

每条提取出的简单命令的结构化表示：

| 字段 | 类型 | 说明 |
|------|------|------|
| `argv` | `string[]` | argv[0] 为命令名，其余为参数，引号已解析 |
| `envVars` | `{ name: string; value: string }[]` | 前缀环境变量赋值（如 `VAR=val cmd`） |
| `redirects` | `Redirect[]` | 输入/输出重定向信息 |
| `text` | `string` | 原始源码文本（用于 UI 展示和规则匹配） |

### `ParseForSecurityResult`

解析结果的联合类型，三种可能：

- **`{ kind: 'simple'; commands: SimpleCommand[] }`**：解析成功，得到可信的命令列表
- **`{ kind: 'too-complex'; reason: string; nodeType?: string }`**：包含无法静态分析的结构，拒绝提取
- **`{ kind: 'parse-unavailable' }`**：tree-sitter WASM 未加载，调用方应回退到保守行为

### `Redirect`

```typescript
type Redirect = {
  op: '>' | '>>' | '<' | '<<' | '>&' | '>|' | '<&' | '&>' | '&>>' | '<<<'
  target: string
  fd?: number
}
```

> 源码位置：`src/utils/bash/ast.ts:25-45`

## 关键流程

### 主入口：`parseForSecurity` / `parseForSecurityFromAst`

整个解析流程分为三个阶段：**预检查 → AST 遍历 → 语义检查**。

#### 阶段一：预检查（Pre-checks）

在进入 AST 遍历之前，先对原始命令字符串进行正则检测，捕获 **tree-sitter 与 bash 之间的解析差异**（`src/utils/bash/ast.ts:404-457`）：

1. **控制字符**（`CONTROL_CHAR_RE`）：`\x00-\x08` 等，bash 静默丢弃但扰乱静态分析
2. **Unicode 空白**（`UNICODE_WHITESPACE_RE`）：NBSP、零宽空格等，终端不可见但 bash 视为字面字符
3. **反斜杠+空白**（`BACKSLASH_WHITESPACE_RE`）：`\ ` 在 bash 中是转义空格，但 tree-sitter 保留原始文本
4. **Zsh 特殊语法**：`~[name]` 动态目录扩展、`=cmd` 路径扩展——因为 BashTool 可能运行在 zsh 下
5. **大括号+引号混淆**（`BRACE_WITH_QUOTE_RE`）：`{a'}',b}` 等利用引号混淆大括号展开的构造
6. **解析中止**：如果 tree-sitter 因超时/资源限制而中止解析（`PARSE_ABORTED`），同样返回 `too-complex`

任何一项触发即返回 `too-complex`，不进入后续阶段。

#### 阶段二：AST 遍历（Tree Walking）

核心递归函数 `collectCommands` 遍历 AST 节点树，按白名单处理每种节点类型（`src/utils/bash/ast.ts:482-955`）：

1. **`command`** → 调用 `walkCommand` 提取 argv、envVars、redirects
2. **结构类型**（`program`/`list`/`pipeline`/`redirected_statement`）→ 递归遍历子节点
3. **`declaration_command`**（`export`/`local`/`readonly`/`declare`/`typeset`）→ 单独处理，验证标志安全性
4. **`variable_assignment`**（裸赋值 `VAR=val`）→ 验证值并加入变量作用域，不生成命令
5. **`for_statement`** → 循环变量始终标记为未知值（`VAR_PLACEHOLDER`），循环体用作用域副本
6. **`if_statement` / `while_statement`** → 条件用真实作用域，分支体用作用域副本
7. **`subshell`**（`(cmd)`）→ 用作用域副本递归
8. **`test_command`**（`[[ ]]` / `[ ]`）→ 递归验证测试表达式
9. **`negated_command`**（`! cmd`）→ 穿透到内部命令
10. **`unset_command`** → 从变量作用域中删除被 unset 的变量
11. **其他所有未列出的类型** → 调用 `tooComplex()` 拒绝

> 源码位置：`src/utils/bash/ast.ts:482-955`

#### 阶段三：语义检查（`checkSemantics`）

对已成功提取的 `SimpleCommand[]` 进行 argv 级别的安全检查（`src/utils/bash/ast.ts:2213-2679`）：

1. **剥离安全包装命令**：递归剥离 `time`、`nohup`、`timeout N`、`nice -n N`、`env`、`stdbuf` 等包装器，暴露被包装的真实命令
2. **空命令名 / 占位符命令名**：拒绝 argv[0] 为空或包含占位符的命令
3. **数组下标注入**：检测 `test -v 'arr[$(cmd)]'`、`read 'arr[$(cmd)]'`、`printf -v 'arr[$(cmd)]'` 等利用 bash 算术求值执行代码的模式
4. **Shell 关键字作命令名**：检测 tree-sitter 误解析导致 `for`/`do`/`done` 等成为 argv[0]
5. **换行+# 注入**：参数中的 `\n#` 可被下游 strip 逻辑误认为注释
6. **jq `system()` 和危险标志**：检测 jq 的 `system()` 函数调用和 `--from-file` 等标志
7. **Zsh 危险内建**：`zmodload`、`ztcp`、`zf_rm` 等 18 个 zsh 内建命令
8. **eval 类内建**：`eval`、`source`、`exec`、`trap`、`enable`、`hash` 等 16 个会将参数作为代码执行的内建命令（`command -v` 和 `fc -l` 等安全变体例外）
9. **`/proc/*/environ` 访问**：阻止读取其他进程的环境变量

### 变量作用域追踪

模块维护一个 `varScope: Map<string, string>`，追踪命令序列中变量的赋值值（`src/utils/bash/ast.ts:472`）。这使得 `VAR=x && cmd $VAR` 这类常见模式能够通过分析——`$VAR` 被解析为已知值 `x`。

关键的作用域隔离规则：

- **`&&` / `;`**：顺序执行，作用域**共享**（变量赋值传递到后续命令）
- **`||` / `|` / `|&` / `&`**：条件/管道/后台执行，作用域在分隔符后**重置为快照**——防止条件分支中的赋值泄漏
- **`pipeline`**：所有阶段在子 shell 中运行，使用入口时的**作用域副本**
- **`subshell` / `for` 循环体 / `if`/`while` 分支体**：使用作用域**副本**，内部赋值不泄漏
- **环境前缀赋值**（`VAR=x cmd`）：仅对当前命令可见，**不**加入全局作用域

> 源码位置：`src/utils/bash/ast.ts:505-565`（作用域快照逻辑）

### 变量展开解析：`resolveSimpleExpansion`

`$VAR` 的解析策略取决于**位置**和**值类型**（`src/utils/bash/ast.ts:1937-2008`）：

| 变量来源 | 裸参数（`cmd $VAR`） | 字符串内（`cmd "...$VAR..."`） |
|---------|---------------------|------------------------------|
| 已追踪的纯字面值（如 `VAR=/tmp`） | 返回实际值 `/tmp`（可能被 `BARE_VAR_UNSAFE_RE` 拒绝） | 返回实际值 |
| 已追踪但包含占位符（如 `VAR=$(cmd)`） | **拒绝**（too-complex） | 返回 `VAR_PLACEHOLDER` |
| `SAFE_ENV_VARS`（`$HOME`/`$PWD` 等） | **拒绝** | 返回 `VAR_PLACEHOLDER` |
| 特殊变量（`$?`/`$$` 等） | **拒绝** | 返回 `VAR_PLACEHOLDER` |
| 未追踪的变量 | **拒绝** | **拒绝** |

关键安全考量：裸参数位置的 `$VAR` 在 bash 中会经历**词拆分和路径名展开**。`VAR="-rf /" && rm $VAR` 在 bash 中会变成 `rm -rf /`（两个参数），但静态分析只能看到一个字符串。因此含空格/glob 字符的值在裸参数位置被拒绝。

### 命令替换处理：`collectCommandSubstitution`

`$()` 的处理（`src/utils/bash/ast.ts:1374-1393`）：

- **字符串内**（`"text $(cmd) text"`）：递归提取内部命令加入 `innerCommands`，外层 argv 中用 `__CMDSUB_OUTPUT__` 占位
- **裸参数位置**（`cmd $(subcmd)`）：**不处理**，返回 `too-complex`——因为 `$()` 输出可能是路径或标志，占位符会绕过路径验证
- **变量赋值 RHS**（`VAR=$(cmd)`）：递归提取内部命令，变量值标记为 `__CMDSUB_OUTPUT__`

特殊优化：`$(cat <<'EOF'...EOF)` 模式（带引号定界符的 heredoc）被识别为安全的静态字符串，通过 `extractSafeCatHeredoc` 直接提取 heredoc 体内容（`src/utils/bash/ast.ts:1721-1775`）。

### `.text` 重建

当命令的 `node.text` 中包含 `$VAR` 引用或换行时，`walkCommand` 会从 argv 重建 `.text`（`src/utils/bash/ast.ts:1349-1358`）。这解决了一个关键的安全问题：原始 `.text` 中的 `$VAR` 不会被下游的拒绝规则匹配到。例如 `SUB=push && git $SUB --force` 的原始 `.text` 是 `git $SUB --force`，`Bash(git push:*)` 的拒绝规则无法匹配，但重建后变为 `git push --force`。

## 函数签名

### `parseForSecurity(cmd: string): Promise<ParseForSecurityResult>`

主入口。接收原始 Bash 命令字符串，返回解析结果。内部调用 `parseCommandRaw` 获取 AST 后委托给 `parseForSecurityFromAst`。

> 源码位置：`src/utils/bash/ast.ts:381-392`

### `parseForSecurityFromAst(cmd: string, root: Node | typeof PARSE_ABORTED): ParseForSecurityResult`

接受预解析的 AST 根节点，执行预检查和 AST 遍历。适用于调用方已经解析过 AST 需要复用的场景。

> 源码位置：`src/utils/bash/ast.ts:400-460`

### `checkSemantics(commands: SimpleCommand[]): SemanticCheckResult`

对已提取的命令列表执行 argv 级别的语义安全检查。返回 `{ ok: true }` 或 `{ ok: false; reason: string }`。

> 源码位置：`src/utils/bash/ast.ts:2213-2679`

### `nodeTypeId(nodeType: string | undefined): number`

将 AST 节点类型转换为数字 ID，用于分析事件上报。`-2` = 预检查拒绝，`-1` = 解析错误，`0` = 未知，`1+` = `DANGEROUS_TYPES` 索引。

> 源码位置：`src/utils/bash/ast.ts:213-218`

## 配置常量

### 白名单集合

| 常量 | 用途 |
|------|------|
| `STRUCTURAL_TYPES` | 结构节点白名单：`program`/`list`/`pipeline`/`redirected_statement` |
| `SEPARATOR_TYPES` | 分隔符令牌：`&&`/`\|\|`/`\|`/`;`/`&`/`\|&`/`\n` |
| `SAFE_ENV_VARS` | 安全环境变量（20 个）：`HOME`/`PWD`/`USER`/`PATH`/`SHELL` 等 |
| `SPECIAL_VAR_NAMES` | 安全特殊变量：`$?`/`$$`/`$!`/`$#`/`$0`/`$-`（不含 `$@`/`$*`） |

### 黑名单与检测

| 常量 | 用途 |
|------|------|
| `DANGEROUS_TYPES` | 已知危险节点类型（16 个），含命令替换、进程替换、控制流、函数定义等 |
| `EVAL_LIKE_BUILTINS` | 将参数作为代码执行的内建命令（16 个） |
| `ZSH_DANGEROUS_BUILTINS` | zsh 危险内建命令（18 个） |
| `SUBSCRIPT_EVAL_FLAGS` | 会算术求值数组下标的内建命令及其触发标志 |
| `BARE_SUBSCRIPT_NAME_BUILTINS` | 所有裸位置参数都会算术求值的内建命令：`read`/`unset` |

### 安全正则

| 常量 | 检测目标 |
|------|---------|
| `CONTROL_CHAR_RE` | 控制字符（含 CR `\x0D`，导致 tree-sitter/bash 词边界不一致） |
| `UNICODE_WHITESPACE_RE` | Unicode 不可见空白（NBSP、零宽空格等） |
| `BACKSLASH_WHITESPACE_RE` | 反斜杠+空白/换行（tree-sitter 和 bash 对此词处理不同） |
| `BRACE_EXPANSION_RE` | 大括号展开语法 `{a,b}` / `{a..b}` |
| `ZSH_TILDE_BRACKET_RE` | zsh `~[name]` 动态目录 |
| `ZSH_EQUALS_EXPANSION_RE` | zsh `=cmd` 路径展开 |
| `PROC_ENVIRON_RE` | `/proc/*/environ` 访问 |
| `NEWLINE_HASH_RE` | 换行+`#` 注释注入 |
| `BARE_VAR_UNSAFE_RE` | 裸变量展开中不安全的 IFS/glob 字符 |

## 边界 Case 与注意事项

### `$@` 和 `$*` 不在安全特殊变量集合中

在 BashTool 的 shell 中，positional parameters 始终为空。返回 `VAR_PLACEHOLDER` 会导致 `git "push$*"` 的 argv 变为 `['git', 'push__TRACKED_VAR__']`，而实际 bash 运行的是 `['git', 'push']`——拒绝规则 `Bash(git push:*)` 对两者都无法匹配。因此将 `$@`/`$*` 排除在外，触发 `too-complex`。

### Heredoc 必须使用引号定界符

未引用定界符的 heredoc（`<<EOF`）会经历完整的参数/命令/算术展开。tree-sitter 对 heredoc 体内的反引号（`` ` ``）不会解析为 `command_substitution` 节点，但 bash 会执行。因此只允许 `<<'EOF'`（单引号）、`<<"EOF"`（双引号）或 `<<\EOF`（反斜杠转义）形式。

### `PS4` 赋值采用允许列表而非拒绝列表

经过 5 轮绕过修补，`PS4` 的值检查从黑名单改为白名单：只允许 `${VAR}` 引用加 `[A-Za-z0-9 _+:.=/[]-]` 字符集。`PS4+=` 直接拒绝，包含占位符的值也拒绝。这是因为 bash 的 `decode_prompt_string` 在 `promptvars` 之前运行，`\044(id)` 这类八进制编码能绕过字面字符检查。

### 安全包装命令剥离的 fail-closed 设计

`checkSemantics` 中对 `timeout`、`nice`、`env`、`stdbuf` 等包装命令的标志解析，对任何无法识别的标志都**拒绝**（而非跳过）。例如 `timeout .5 eval "id"` 中 `.5` 不匹配持续时间正则，会返回 `too-complex`——GNU timeout 通过 `strtod()` 能接受 `.5`、`+5`、`5e-1`、`inf` 等格式，但静态分析无法完全枚举。

### tree-sitter 双引号字符串的空白 quirk

`" "` 或 `"\t"` 这类仅包含空白的双引号字符串，tree-sitter 不会生成 `string_content` 子节点——空白被归入闭合引号 `"` 的文本中。`walkString` 通过检测"无内容子节点但源码长度超过 2"来识别并拒绝此情况（`src/utils/bash/ast.ts:1648-1650`）。