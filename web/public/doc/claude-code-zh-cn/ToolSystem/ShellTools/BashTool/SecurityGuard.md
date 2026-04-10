# SecurityGuard — 命令安全校验层

## 概述与职责

SecurityGuard 是 BashTool 的核心安全防线，负责在 Shell 命令执行前检测和拦截各类命令注入攻击。它位于 **ToolSystem → ShellTools → BashTool** 层级中，是 BashTool 命令执行流程的前置安全网关——所有通过 BashTool 提交的命令都必须先通过 SecurityGuard 的校验。

模块由三个文件组成：
- **bashSecurity.ts**（2592 行）：核心安全校验引擎，包含 20+ 个独立校验器（validator），覆盖命令替换、引号混淆、Shell 元字符注入等攻击面
- **bashCommandHelpers.ts**（265 行）：AST 级命令解析辅助，处理管道分段、复合命令权限检查
- **destructiveCommandWarning.ts**（102 行）：破坏性命令模式检测，生成用户警告信息

在整体架构中，SecurityGuard 与同级的 `bashPermissions`（权限规则匹配）、`readOnlyValidation`（只读白名单）、`pathValidation`（路径安全）等模块协同工作，共同构成 BashTool 的多层防御体系。

## 关键流程

### 命令安全校验主流程

`bashCommandIsSafe_DEPRECATED` 和 `bashCommandIsSafeAsync_DEPRECATED` 是两个核心入口函数，分别提供同步和异步两种校验路径。异步版本优先使用 tree-sitter AST 解析，同步版本使用纯正则/shell-quote 解析。

校验流程分为四个阶段：

**阶段 1：前置安全检查**（`bashSecurity.ts:2260-2284`）
1. 检测非打印控制字符（`CONTROL_CHAR_RE`）——bash 会静默丢弃 null 字节，攻击者可利用此特性绕过后续校验
2. 检测 shell-quote 的单引号反斜杠 bug（`hasShellQuoteSingleQuoteBug`）——防止 `'\'` 模式导致引号追踪器失步

**阶段 2：预处理与上下文构建**（`bashSecurity.ts:2286-2306`）
1. 调用 `extractHeredocs` 剥离 heredoc 正文（仅处理带引号/转义的定界符，如 `<<'EOF'`）
2. 调用 `extractQuotedContent` 生成三种引号提取视图：`withDoubleQuotes`（保留双引号内容）、`fullyUnquoted`（完全去引号）、`unquotedKeepQuoteChars`（去内容保引号符号）
3. 调用 `stripSafeRedirections` 剥离安全重定向（`2>&1`、`>/dev/null`、`</dev/null`）
4. 构建 `ValidationContext` 上下文对象，供所有校验器共享

**阶段 3：早期校验器**（`bashSecurity.ts:2308-2332`）——命中即提前返回
1. `validateEmpty`：空命令直接放行
2. `validateIncompleteCommands`：检测以 tab、`-`、shell 操作符开头的不完整片段
3. `validateSafeCommandSubstitution`：识别安全的 heredoc 命令替换模式（`$(cat <<'EOF'...EOF)`）
4. `validateGitCommit`：`git commit -m` 的特化快速路径，检查 commit message 中的命令替换和 shell 元字符

**阶段 4：主校验器链**（`bashSecurity.ts:2348-2407`）——顺序执行 18 个校验器
校验器分为两类：
- **误解析校验器**（misparsing）：命中时返回带 `isBashSecurityCheckForMisparsing: true` 标记的结果，在 `bashPermissions.ts` 中触发早期阻断
- **非误解析校验器**（`validateNewlines`、`validateRedirections`）：命中时不设置该标记，走标准权限流程

关键设计：非误解析校验器的 `ask` 结果会被**延迟**（deferred），继续执行剩余校验器。如果后续有误解析校验器命中，返回误解析结果（优先级更高）。这防止了非误解析校验器短路导致遗漏关键误解析检测。

### 异步路径的 tree-sitter 增强

`bashCommandIsSafeAsync_DEPRECATED`（`bashSecurity.ts:2426-2592`）在异步路径中：
1. 使用 `ParsedCommand.parse` 获取 tree-sitter AST 分析结果
2. 优先使用 tree-sitter 的引号上下文（`tsAnalysis.quoteContext`），同时保留 regex 结果用于偏差检测
3. 将 `treeSitter` 字段注入 `ValidationContext`，部分校验器据此优化：
   - `validateBackslashEscapedOperators`：若 AST 确认无操作符节点，跳过检查
   - `validateCommentQuoteDesync`：tree-sitter 引号上下文权威，无需检测注释引号失步
4. 记录 tree-sitter 与 regex 引号提取的偏差（`tengu_tree_sitter_security_divergence`），用于持续改进

### 命令操作符权限检查流程

`checkCommandOperatorPermissions`（`bashCommandHelpers.ts:181-202`）处理包含管道和复合操作符的命令：

1. 解析命令为 `IParsedCommand`（优先从 AST root 构建，否则使用 `ParsedCommand.parse`）
2. 检测不安全的复合命令（子 shell、命令组）——发现时委托给 `bashCommandIsSafeAsync_DEPRECATED` 获取更具体的错误信息
3. 提取管道分段（`getPipeSegments`），单分段命令直接 passthrough
4. 多分段命令进入 `segmentedCommandPermissionResult`：
   - 检测多个 `cd` 命令（需要用户确认）
   - **安全关键**：检测跨管道分段的 `cd+git` 组合（`bashCommandHelpers.ts:49-82`），防止裸仓库 fsmonitor 绕过攻击
   - 逐分段调用 `bashToolHasPermissionFn` 检查权限，汇总结果

### 破坏性命令警告流程

`getDestructiveCommandWarning`（`destructiveCommandWarning.ts:95-102`）是纯信息展示层：
1. 遍历 14 个预定义的破坏性模式进行正则匹配
2. 命中时返回人类可读的警告字符串，显示在权限确认对话框中
3. **不影响权限逻辑或自动审批**——仅提供视觉提示

## 函数签名

### `bashCommandIsSafe_DEPRECATED(command: string): PermissionResult`

同步安全校验入口。遗留的 regex/shell-quote 路径，当 tree-sitter 不可用时使用。

- **command**：待校验的完整 bash 命令字符串
- **返回值**：`PermissionResult`，可能的 `behavior` 值：
  - `'passthrough'`：命令通过所有校验，继续后续权限流程
  - `'allow'`：命令被早期校验器直接放行
  - `'ask'`：检测到可疑模式，需要用户确认。可能附带 `isBashSecurityCheckForMisparsing: true`

> 源码位置：`bashSecurity.ts:2257-2413`

### `bashCommandIsSafeAsync_DEPRECATED(command: string, onDivergence?: () => void): Promise<PermissionResult>`

异步安全校验入口。优先使用 tree-sitter 进行更准确的解析。

- **command**：待校验的完整 bash 命令字符串
- **onDivergence**：可选回调，在 tree-sitter 与 regex 引号提取结果不一致时调用。用于批量日志聚合（避免 N 次独立 `logEvent` 导致事件循环饥饿，参见 CC-643）
- **返回值**：同 `bashCommandIsSafe_DEPRECATED`

> 源码位置：`bashSecurity.ts:2426-2592`

### `stripSafeHeredocSubstitutions(command: string): string | null`

检测并剥离安全的 `$(cat <<'DELIM'...DELIM)` heredoc 替换模式。

- **返回值**：剥离后的命令字符串，如果未找到匹配模式则返回 `null`

> 源码位置：`bashSecurity.ts:521-578`

### `hasSafeHeredocSubstitution(command: string): boolean`

检测命令是否包含安全的 heredoc 替换（`stripSafeHeredocSubstitutions` 的 boolean 包装）。

> 源码位置：`bashSecurity.ts:581-583`

### `checkCommandOperatorPermissions(input, bashToolHasPermissionFn, checkers, astRoot): Promise<PermissionResult>`

管道和复合命令的权限检查入口。

- **input**：BashTool 输入（含 `command` 字段）
- **bashToolHasPermissionFn**：单命令权限检查回调
- **checkers**：`CommandIdentityCheckers`，包含 `isNormalizedCdCommand` 和 `isNormalizedGitCommand` 两个判定函数
- **astRoot**：tree-sitter AST 根节点（可为 `null` 或 `PARSE_ABORTED`）

> 源码位置：`bashCommandHelpers.ts:181-202`

### `getDestructiveCommandWarning(command: string): string | null`

检测破坏性命令模式并返回警告消息。

- **返回值**：警告字符串（如 `'Note: may discard uncommitted changes'`），无匹配时返回 `null`

> 源码位置：`destructiveCommandWarning.ts:95-102`

## 核心校验器详解

### 命令替换与 Shell 扩展检测

| 校验器 | 检测目标 | Check ID |
|--------|----------|----------|
| `validateDangerousPatterns` | `$()` 命令替换、`` ` `` 反引号、`<()` `>()` `=()` 进程替换、`${}` 参数替换、`$[]` 算术扩展、Zsh glob qualifiers、PowerShell 注释 `<#` | 8 |
| `validateSafeCommandSubstitution` | 安全的 `$(cat <<'EOF'...EOF)` 模式（提前放行） | - |
| `validateBraceExpansion` | `{a,b}` 和 `{1..5}` 花括号扩展——检测不匹配花括号数、引号包裹的花括号 | 16 |

### 引号混淆与解析偏差检测

| 校验器 | 检测目标 | Check ID |
|--------|----------|----------|
| `validateObfuscatedFlags` | ANSI-C 引号 `$'...'`、locale 引号 `$"..."`、空引号拼接 `""-flag`、引号内 flag 名等 12+ 种 flag 混淆模式 | 4 |
| `validateMalformedTokenInjection` | shell-quote 解析产生不平衡定界符的 token + 命令分隔符组合（源自 HackerOne 漏洞报告） | 14 |
| `validateMidWordHash` | 词中 `#` 号（shell-quote 视为注释开始，bash 视为字面字符） | 19 |
| `validateCommentQuoteDesync` | `#` 注释中的引号字符导致引号追踪器失步 | 22 |
| `validateBackslashEscapedWhitespace` | `echo\ test` 模式（shell-quote 分词 vs bash 连词差异导致路径遍历） | 15 |
| `validateBackslashEscapedOperators` | `\;` `\|` `\&` 等（splitCommand 标准化后产生裸操作符，导致二次解析 bug） | 21 |

### 注入与绕过检测

| 校验器 | 检测目标 | Check ID |
|--------|----------|----------|
| `validateIFSInjection` | `$IFS` 或 `${...IFS...}` 变量——可用于绕过正则校验 | 11 |
| `validateProcEnvironAccess` | `/proc/*/environ` 路径——可泄露 API 密钥等敏感环境变量 | 13 |
| `validateDangerousVariables` | 变量与重定向/管道操作符的危险组合（如 `> $VAR`） | 6 |
| `validateShellMetacharacters` | 参数中的 Shell 元字符（`;`, `|`, `&`） | 5 |
| `validateZshDangerousCommands` | `zmodload`、`emulate`、`sysopen`、`ztcp` 等 24 个 Zsh 危险命令和 `fc -e` | 20 |

### 编码与特殊字符检测

| 校验器 | 检测目标 | Check ID |
|--------|----------|----------|
| `validateNewlines` | 未引用换行符后跟非空白内容（可能分隔多条命令），但允许行续符 `\<newline>` | 7 |
| `validateCarriageReturn` | `\r`——shell-quote 视为分词边界而 bash IFS 不含 CR，造成解析偏差 | 7 (subId: 2) |
| `validateQuotedNewline` | 引号内换行后跟 `#` 开头行——利用 `stripCommentLines` 的逐行处理隐藏敏感路径 | 23 |
| `validateUnicodeWhitespace` | `\u00A0` 等 Unicode 空白——可能导致解析不一致 | 18 |
| `validateRedirections` | 未引用的 `<` `>` 重定向操作符 | 9, 10 |

## 接口/类型定义

### `ValidationContext`

校验器共享的上下文对象，包含命令的多种预处理视图：

| 字段 | 类型 | 说明 |
|------|------|------|
| `originalCommand` | `string` | 原始命令字符串 |
| `baseCommand` | `string` | 首个空格分隔的 token（命令名） |
| `unquotedContent` | `string` | 去除单引号内容后的字符串（保留双引号内容） |
| `fullyUnquotedContent` | `string` | 完全去引号 + 剥离安全重定向后的字符串 |
| `fullyUnquotedPreStrip` | `string` | 完全去引号、剥离安全重定向**之前**的字符串 |
| `unquotedKeepQuoteChars` | `string` | 去引号内容但保留引号符号本身（用于检测引号-`#` 邻接） |
| `treeSitter` | `TreeSitterAnalysis \| null` | tree-sitter 分析数据（异步路径可用） |

> 源码位置：`bashSecurity.ts:103-117`

### `CommandIdentityCheckers`

命令身份判定函数集合，用于管道分段权限检查：

```typescript
type CommandIdentityCheckers = {
  isNormalizedCdCommand: (command: string) => boolean
  isNormalizedGitCommand: (command: string) => boolean
}
```

> 源码位置：`bashCommandHelpers.ts:18-21`

### `DestructivePattern`

破坏性命令模式定义：

```typescript
type DestructivePattern = {
  pattern: RegExp    // 正则匹配模式
  warning: string    // 人类可读警告信息
}
```

> 源码位置：`destructiveCommandWarning.ts:7-10`

## 配置项与常量

### `COMMAND_SUBSTITUTION_PATTERNS`

定义 12 种命令替换/危险扩展模式，每项包含 `pattern`（正则）和 `message`（描述）。覆盖 `$()`, `${}`, `<()`, `>()`, `=()`, `$[]`, Zsh glob qualifiers, `} always {` 等。

> 源码位置：`bashSecurity.ts:16-41`

### `ZSH_DANGEROUS_COMMANDS`

24 个 Zsh 特有危险命令的 Set 集合，包括 `zmodload`（模块加载网关）、`emulate`（eval 等价）、`sysopen/sysread/syswrite`（原始文件 I/O）、`ztcp/zsocket`（网络操作）、`zf_*`（绕过二进制检查的内建文件操作）等。

> 源码位置：`bashSecurity.ts:45-74`

### `BASH_SECURITY_CHECK_IDS`

23 个数值标识符常量，用于分析日志中标识哪个安全检查被触发（避免记录字符串）。

> 源码位置：`bashSecurity.ts:77-101`

### `DESTRUCTIVE_PATTERNS`

14 个破坏性命令模式，分为四类：
- **Git 数据丢失**：`git reset --hard`、`git push --force`、`git clean -f`、`git checkout .`、`git restore .`、`git stash drop/clear`、`git branch -D`
- **Git 安全绕过**：`--no-verify`、`--amend`
- **文件删除**：`rm -rf`、`rm -r`、`rm -f`
- **基础设施**：`DROP/TRUNCATE TABLE`、`DELETE FROM`（无 WHERE）、`kubectl delete`、`terraform destroy`

> 源码位置：`destructiveCommandWarning.ts:12-89`

## 边界 Case 与注意事项

### 误解析 vs 非误解析校验器的优先级

校验器链不会在首个 `ask` 结果处短路。非误解析校验器（`validateNewlines`、`validateRedirections`）的 `ask` 结果被延迟，继续执行直到所有误解析校验器完成。这是因为 `bashPermissions.ts` 中的门控逻辑仅在 `isBashSecurityCheckForMisparsing: true` 时提前阻断——如果非误解析结果先返回，后续的误解析检测会被跳过，导致安全漏洞。

### 安全 heredoc 的提前放行是全局旁路

`isSafeHeredoc` 返回 `true` 会导致 `bashCommandIsSafe` 直接返回 `passthrough`，**跳过所有后续校验器**。因此该函数的安全证明极其严格——要求定界符必须被引号/转义包裹、闭合定界符必须独占一行、不允许嵌套匹配、剥离后的剩余文本必须通过完整校验器链。

### `stripSafeRedirections` 的尾边界要求

该函数的三个正则**必须**包含尾随边界 `(?=\s|$)`。没有它，`> /dev/nullo` 会匹配 `/dev/null` 前缀并被错误剥离，导致文件写入被放行（`bashSecurity.ts:177-188`）。

### 跨管道分段的 cd+git 安全检查

当 `cd` 和 `git` 位于不同的管道分段时（如 `cd sub && echo | git status`），每个分段被独立检查，都不会触发 `bashPermissions.ts` 中的 cd+git 检查。`bashCommandHelpers.ts:49-82` 的跨分段检测填补了这一安全缝隙，防止裸仓库 `fsmonitor` 绕过攻击。

### 遗留标记 `_DEPRECATED`

核心函数标记为 `_DEPRECATED` 是因为它们属于遗留的 regex/shell-quote 路径。主要安全网关已迁移至 `parseForSecurity`（ast.ts）使用 tree-sitter。但这些函数在 tree-sitter 不可用时仍作为回退路径，且被 `bashCommandHelpers.ts` 等模块主动调用。

### 破坏性命令警告是纯展示层

`getDestructiveCommandWarning` **不影响**权限判定或自动审批逻辑。它只在权限确认对话框中附加视觉警告，帮助用户在审批前注意到高风险操作。