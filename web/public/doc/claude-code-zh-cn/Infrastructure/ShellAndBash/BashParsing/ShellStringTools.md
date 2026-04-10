# Shell 字符串处理工具集合（ShellStringTools）

## 概述与职责

ShellStringTools 是 Claude Code 基础设施层中 **Shell 与 Bash 解析管线** 的底层字符串处理工具集。它位于 `Infrastructure > ShellAndBash > BashParsing` 层级中，为上层的 Shell 提供者（`bashProvider`）、命令前缀提取和安全分类器提供安全可靠的 shell 引用、heredoc 处理和管道命令重排能力。

该模块由 5 个文件组成，核心职责是解决一个根本性挑战：**第三方 `shell-quote` 库与真实 bash 行为之间的语义差异**。这些差异如果不加处理，可能导致命令注入漏洞。模块通过多层防御（错误处理、bug 检测、安全引用策略、heredoc 提取/恢复）确保命令字符串在解析和重构过程中保持语义完整性。

同级模块包括 `ShellExecution`（子进程管理）、`ShellProviders`（Shell 提供者抽象）、`CommandPrefixAndValidation`（命令前缀与安全验证）和 `PowerShell`（Windows 支持）。

---

## 模块组成

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `shellQuote.ts` | 304 | `shell-quote` 库的安全包装器 |
| `shellQuoting.ts` | 128 | 高层命令引用策略（heredoc/多行/stdin） |
| `heredoc.ts` | 733 | Heredoc 提取与恢复引擎 |
| `bashPipeCommand.ts` | 294 | 管道命令 stdin 重定向重排 |
| `shellPrefix.ts` | 28 | Shell 前缀路径格式化 |

---

## 关键流程

### 1. 命令安全引用流程（shellQuote.ts → shellQuoting.ts）

当系统需要将用户命令安全地传递给 `eval` 执行时，引用流程如下：

1. **`quoteShellCommand(command, addStdinRedirect)`**（`shellQuoting.ts:46-74`）首先检测命令是否包含 heredoc 或多行字符串
2. 如果包含 heredoc/多行字符串，绕过 `shell-quote` 库，直接使用**单引号包裹 + 单引号转义**策略（`'` → `'"'"'`），避免 `shell-quote` 对 `!` 的错误转义
3. 对于普通命令，调用 `quote()` 函数（`shellQuote.ts:267-304`），该函数：
   - 先通过 `tryQuoteShellArgs()` 做严格类型验证（拒绝 object/symbol/function）
   - 严格验证失败时，使用宽松回退（JSON 序列化非字符串参数）
   - 最终调用 `shell-quote` 库的 `quote()` 完成实际引用
   - **绝不使用 `JSON.stringify` 作为最终回退**——JSON 使用双引号，无法阻止 `$(whoami)` 等 shell 扩展

### 2. 管道命令 stdin 重定向重排流程（bashPipeCommand.ts）

当命令包含管道时，`< /dev/null` 必须插入到第一个管道命令之后（而非整条命令末尾），否则会影响管道中最后一个命令的 stdin。流程如下：

1. **`rearrangePipeCommand(command)`**（`bashPipeCommand.ts:14-100`）首先进行一系列**快速跳过检查**：
   - 包含反引号 → 跳过（`shell-quote` 不能正确处理）
   - 包含 `$(` → 跳过（`shell-quote` 将 `()` 解析为独立操作符）
   - 包含 `$VAR` / `${VAR}` → 跳过（`shell-quote` 会展开为空字符串）
   - 包含控制结构（`for`/`while`/`if` 等）→ 跳过
2. 执行 `joinContinuationLines()` 合并 `\<newline>` 续行
3. 检测 `hasShellQuoteSingleQuoteBug()` 单引号反斜杠 bug
4. 调用 `tryParseShellCommand()` 解析，并用 `hasMalformedTokens()` 检测畸形 token
5. 通过 `findFirstPipeOperator()` 找到第一个 `|`，在其前面插入 `< /dev/null`
6. 用 `buildCommandParts()` 重建命令，正确处理环境变量赋值、文件描述符重定向（`2>&1`、`2>/dev/null`）和 glob 模式
7. 所有跳过情况统一使用 `quoteWithEvalStdinRedirect()` 回退：将整条命令用单引号包裹后追加 `< /dev/null`，使 stdin 重定向作用于 `eval` 本身而非管道内的命令

### 3. Heredoc 提取与恢复流程（heredoc.ts）

由于 `shell-quote` 库将 `<<` 解析为两个独立的 `<` 重定向操作符，heredoc 必须在解析前提取、解析后恢复。

**提取阶段 `extractHeredocs(command, options?)`**（`heredoc.ts:113-687`）：

1. **快速退出**：命令不含 `<<` 则直接返回
2. **安全预校验**：包含 `$'...'`/`$"..."` ANSI-C 引用、或 `<<` 之前有反引号、或未闭合的算术 `((`，均放弃提取（`heredoc.ts:139-168`）
3. **增量引号/注释状态扫描器**（`advanceScan`，`heredoc.ts:231-275`）：维护单/双引号、注释、转义状态，避免对每个 `<<` 匹配从头重新扫描（将 O(n²) 优化为 O(n)）
4. 对每个 `<<` 匹配：
   - 跳过引号/注释/转义内的 `<<`
   - 跳过已跳过的 unquoted heredoc body 内嵌的 `<<`
   - 验证分隔符完整性（引号闭合检查、下一字符为 bash 元字符）
   - 使用引号感知的换行扫描找到 heredoc body 起始位置（防止引号内换行被误判）
   - 检测行尾续行 `\<newline>` 并放弃提取
   - 严格匹配闭合分隔符（`<<-` 仅剥离前导 tab）
   - 检测 PST_EOFTOKEN 类早期闭合风险
5. 过滤嵌套 heredoc 和共享同一起始行的 heredoc
6. 从后往前替换为带**随机盐**的占位符（`__HEREDOC_N_<16字符hex>__`），保留 `<<` 操作符与 body 之间的同行内容

**恢复阶段 `restoreHeredocs(parts, heredocs)`**（`heredoc.ts:711-720`）：简单地将占位符替换回原始 heredoc 全文。

---

## 函数签名与参数说明

### shellQuote.ts

#### `tryParseShellCommand(cmd, env?): ShellParseResult`
安全地解析 shell 命令字符串为 token 数组。

- **cmd**: `string` — 要解析的 shell 命令
- **env**: `Record<string, string | undefined> | ((key: string) => string | undefined)` — 可选的环境变量映射
- **返回**: `{ success: true, tokens: ParseEntry[] } | { success: false, error: string }`

> 源码位置：`src/utils/bash/shellQuote.ts:24-45`

#### `tryQuoteShellArgs(args): ShellQuoteResult`
严格验证并引用参数数组。拒绝 object/symbol/function 类型。

- **args**: `unknown[]` — 要引用的参数
- **返回**: `{ success: true, quoted: string } | { success: false, error: string }`

> 源码位置：`src/utils/bash/shellQuote.ts:47-95`

#### `hasMalformedTokens(command, parsed): boolean`
检测 `shell-quote` 解析产生的畸形 token（括号/引号不平衡），以及原始命令中的未闭合引号。

- 安全背景：防御 HackerOne #3482049 报告的命令注入

> 源码位置：`src/utils/bash/shellQuote.ts:117-176`

#### `hasShellQuoteSingleQuoteBug(command): boolean`
检测利用 `shell-quote` 单引号内反斜杠处理 bug 的命令模式。

- 在 bash 中，单引号内反斜杠是字面量（`'\' = \`）
- 在 `shell-quote` 中，`\'` 被错误地视为转义，导致引号未闭合
- 奇数尾随反斜杠始终触发；偶数尾随反斜杠在后续存在 `'` 时触发

> 源码位置：`src/utils/bash/shellQuote.ts:190-265`

#### `quote(args): string`
公开的引用函数。先尝试严格验证，失败则宽松回退（JSON 序列化），绝不使用 `JSON.stringify` 作为 shell 引用。

> 源码位置：`src/utils/bash/shellQuote.ts:267-304`

### shellQuoting.ts

#### `quoteShellCommand(command, addStdinRedirect?): string`
高层命令引用入口。自动检测 heredoc/多行字符串并选择合适的引用策略。

- **command**: `string` — 要引用的命令
- **addStdinRedirect**: `boolean`（默认 `true`）— 是否追加 `< /dev/null`
- heredoc 命令不追加 stdin 重定向（heredoc 自身提供输入）

> 源码位置：`src/utils/bash/shellQuoting.ts:46-74`

#### `hasStdinRedirect(command): boolean`
检测命令是否已有 stdin 重定向，排除 `<<`（heredoc）和 `<(`（进程替换）。

> 源码位置：`src/utils/bash/shellQuoting.ts:81-86`

#### `shouldAddStdinRedirect(command): boolean`
判断是否应安全地添加 stdin 重定向。排除 heredoc 和已有重定向的命令。

> 源码位置：`src/utils/bash/shellQuoting.ts:93-106`

#### `rewriteWindowsNullRedirect(command): string`
将 Windows CMD 风格的 `>nul` 重定向重写为 POSIX `/dev/null`。防止 Git Bash 创建名为 `nul` 的文件（Windows 保留设备名，极难删除）。

> 源码位置：`src/utils/bash/shellQuoting.ts:126-128`

### heredoc.ts

#### `extractHeredocs(command, options?): HeredocExtractionResult`
从命令中提取所有 heredoc，替换为随机盐占位符。

- **options.quotedOnly**: `boolean` — 仅提取带引号/转义分隔符的 heredoc（unquoted heredoc 的 body 含可执行的 `$()` 扩展，需留给安全校验器检查）

> 源码位置：`src/utils/bash/heredoc.ts:113-687`

#### `restoreHeredocs(parts, heredocs): string[]`
将字符串数组中的占位符恢复为原始 heredoc 内容。

> 源码位置：`src/utils/bash/heredoc.ts:711-720`

#### `containsHeredoc(command): boolean`
快速检查命令是否包含 heredoc 语法（不验证完整性）。

> 源码位置：`src/utils/bash/heredoc.ts:731-733`

### bashPipeCommand.ts

#### `rearrangePipeCommand(command): string`
重排管道命令的 stdin 重定向位置，将 `< /dev/null` 插入到第一个管道命令之后。

> 源码位置：`src/utils/bash/bashPipeCommand.ts:14-100`

### shellPrefix.ts

#### `formatShellPrefixCommand(prefix, command): string`
将 shell 前缀（可执行路径 + 参数）和命令组合为正确引用的命令字符串。

- 按 `' -'` 分割可执行路径与参数（如 `/usr/bin/bash -c` → `'/usr/bin/bash' -c 'command'`）
- 正确处理带空格的路径（如 `C:\Program Files\Git\bin\bash.exe`）

> 源码位置：`src/utils/bash/shellPrefix.ts:15-28`

---

## 接口/类型定义

### `ShellParseResult`（`shellQuote.ts:16-18`）
```typescript
type ShellParseResult =
  | { success: true; tokens: ParseEntry[] }
  | { success: false; error: string }
```
Result 类型，用于安全解析——避免抛出异常，通过 `success` 标志区分成功/失败。

### `ShellQuoteResult`（`shellQuote.ts:20-22`）
```typescript
type ShellQuoteResult =
  | { success: true; quoted: string }
  | { success: false; error: string }
```

### `HeredocInfo`（`heredoc.ts:73-86`）
```typescript
type HeredocInfo = {
  fullText: string           // 完整 heredoc 文本（包括 << 操作符、分隔符、内容、闭合分隔符）
  delimiter: string          // 分隔符词（不含引号）
  operatorStartIndex: number // << 操作符在原始命令中的起始位置
  operatorEndIndex: number   // << 操作符结束位置（不含）
  contentStartIndex: number  // heredoc 内容起始位置（body 前的换行符）
  contentEndIndex: number    // heredoc 内容结束位置（含闭合分隔符，不含）
}
```

### `HeredocExtractionResult`（`heredoc.ts:88-93`）
```typescript
type HeredocExtractionResult = {
  processedCommand: string              // heredoc 被替换为占位符后的命令
  heredocs: Map<string, HeredocInfo>    // 占位符 → heredoc 信息映射
}
```

---

## 边界 Case 与注意事项

### shell-quote 库的已知差异

本模块的核心设计目标是弥合 `shell-quote` 与 bash 的语义差异：

1. **单引号内反斜杠**：bash 中单引号内一切为字面量（`'\' = \`），但 `shell-quote` 将 `\'` 视为转义。`hasShellQuoteSingleQuoteBug()` 专门检测此问题。
2. **`$(...)` 和反引号**：`shell-quote` 将 `()` 解析为独立操作符，无法识别命令替换。`rearrangePipeCommand` 对此直接跳过。
3. **环境变量 `$VAR`**：`shell-quote.parse()` 在无 env 参数时将变量展开为空字符串，`quote()` 又会转义 `$`，阻止运行时展开。
4. **换行符**：`shell-quote` 将裸换行视为空白而非命令分隔符，可能合并独立管道。
5. **`<<` 操作符**：`shell-quote` 将 `<<` 解析为两个 `<` 重定向，这是 heredoc 模块存在的根本原因。
6. **`!` 转义**：`shell-quote` 在双引号模式中将 `!` 转义为 `\!`，破坏 `jq`/`awk` 中的 `!=` 表达式。`singleQuoteForEval()` 通过始终使用单引号规避此问题。

### Heredoc 安全防御

heredoc 提取包含大量安全防御，防止通过解析差异实现命令注入：

- **`quotedOnly` 模式**：unquoted heredoc（`<<EOF`）的 body 内 `$()` 会被 bash 执行，不能被提取隐藏
- **嵌套 heredoc 过滤**：body 内的 `<<` 不是真正的 heredoc 操作符
- **引号内 `<<` 跳过**：引号内的 `<<` 是字面文本
- **注释内 `<<` 跳过**：`# <<EOF` 是注释，不是 heredoc
- **转义 `<<` 跳过**：`\<<EOF` 中 `\<` 是字面 `<`
- **续行检测**：行尾 `\<newline>` 在 heredoc 解析之前被 bash 处理
- **引号感知换行扫描**：引号内的换行不是 heredoc body 起始位置
- **PST_EOFTOKEN 检测**：`$()` 内部 heredoc 可能被 `)` 提前关闭
- **随机盐占位符**：防止命令文本中字面包含 `__HEREDOC_N__` 导致的占位符碰撞

### Windows 兼容性

`rewriteWindowsNullRedirect()` 处理模型偶尔生成的 Windows CMD 语法（`>nul`），避免在 Git Bash 中创建名为 `nul` 的文件（Windows 保留名，会破坏 `git add .` 和 `git clone`）。

### 失败安全设计

所有模块遵循 **fail-safe / fail-closed** 原则：
- `tryParseShellCommand` / `tryQuoteShellArgs` 返回 Result 类型，不抛异常
- heredoc 提取失败时原样返回命令（交给手动审批或 shell-quote 的回退路径）
- 管道重排在无法安全解析时回退到整命令单引号包裹