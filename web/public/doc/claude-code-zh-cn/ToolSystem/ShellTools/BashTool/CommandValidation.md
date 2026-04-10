# 命令约束校验集合（CommandValidation）

## 概述与职责

命令约束校验集合是 BashTool 安全体系的核心防线，位于 `ToolSystem → ShellTools → BashTool` 层级之下。它由三个互相协作的模块组成，共同确保用户通过 Bash 工具执行的命令不会越权操作：

- **readOnlyValidation.ts**：只读命令白名单校验——判断命令是否为纯只读操作，可自动放行
- **pathValidation.ts**：路径安全校验——确保命令访问的文件路径在允许的工作目录范围内
- **sedValidation.ts**：sed 命令细粒度校验——解析 sed 表达式语法，区分只读和修改操作

这三个模块在 BashTool 的权限检查流水线中被依次调用。只读校验决定命令能否免权限直接执行；路径校验确保文件操作不越界；sed 校验作为跨切面检查，拦截危险的 sed 写入/执行操作。

同级的兄弟模块 PowerShellTool 提供了类似的 Windows 端校验实现。

---

## 关键流程

### 1. 只读命令校验流程（readOnlyValidation.ts）

入口函数 `checkReadOnlyConstraints()` 是唯一的导出校验函数，流程如下：

1. **Shell 解析检查**：调用 `tryParseShellCommand()` 尝试解析命令，解析失败则 passthrough 给后续权限检查（`readOnlyValidation.ts:1883-1889`）
2. **基础安全检查**：调用 `bashCommandIsSafe_DEPRECATED()` 检测基本注入模式（`readOnlyValidation.ts:1894`）
3. **UNC 路径检测**：拦截 Windows UNC 路径以防 WebDAV 攻击（`readOnlyValidation.ts:1903`）
4. **Git 安全多重检查**：
   - 阻止 `cd + git` 复合命令（防止 cd 到恶意目录后触发 git hooks）
   - 检测当前目录是否为裸仓库结构（防止伪造 hooks 目录攻击）
   - 检测复合命令是否写入 git 内部路径（HEAD、hooks/ 等）后再运行 git
   - 沙箱启用时，阻止在非原始工作目录执行 git（`readOnlyValidation.ts:1912-1966`）
5. **逐子命令校验**：将复合命令拆分，逐一判断是否只读。判断路径有两层：
   - **标志解析路径**（`isCommandSafeViaFlagParsing`）：基于 `COMMAND_ALLOWLIST` 配置表，通过解析命令标志判断安全性
   - **正则匹配路径**（`READONLY_COMMAND_REGEXES`）：对简单命令使用正则匹配
6. 全部子命令均为只读时返回 `allow`，否则 `passthrough` 给后续权限检查

### 2. 标志解析校验流程（isCommandSafeViaFlagParsing）

这是只读校验中最核心的函数（`readOnlyValidation.ts:1246-1408`）：

1. 使用 `tryParseShellCommand()` 将命令解析为 token 数组
2. 拒绝包含管道、重定向等 Shell 操作符的命令
3. 在 `COMMAND_ALLOWLIST` 中查找匹配的命令配置（支持多词命令如 `git diff`）
4. **关键安全检查**：拒绝任何包含 `$`（变量展开）或 `{` + `,`/`..`（花括号展开）的 token——因为运行时展开值不可预知
5. 调用 `validateFlags()` 校验所有标志是否在安全白名单内
6. 执行可选的 `regex` 和 `additionalCommandIsDangerousCallback` 额外验证

### 3. 路径安全校验流程（pathValidation.ts）

入口函数 `checkPathConstraints()` 的流程（`pathValidation.ts:1013-1109`）：

1. **进程替换检测**：拦截 `>(...)` 和 `<(...)` 语法（可绕过重定向检测）
2. **输出重定向校验**：提取所有 `>` / `>>` 重定向目标，校验是否在允许目录内（`/dev/null` 始终安全）
3. **逐命令路径校验**：对每个子命令：
   - 剥离安全包装器（`timeout`、`nice`、`nohup`、`stdbuf`、`env`、`time`）
   - 识别是否为路径命令（34 种支持的命令）
   - 使用对应的 `PATH_EXTRACTORS` 提取文件路径参数
   - 调用 `validatePath()` 校验每个路径是否在允许的工作目录内
4. **特殊处理**：
   - `cd + 写操作` 的复合命令直接要求审批（防止路径解析绕过）
   - `cd + 输出重定向` 同样要求审批
   - `rm`/`rmdir` 额外检查是否为危险删除路径（`/`、`$HOME` 等）
   - `sed` 只读命令的文件参数按 read 操作校验而非 write

### 4. sed 命令校验流程（sedValidation.ts）

入口函数 `checkSedConstraints()` 的流程（`sedValidation.ts:644-684`）：

1. 将复合命令拆分，筛选出 sed 子命令
2. 对每个 sed 命令调用 `sedCommandIsAllowedByAllowlist()`
3. 在 `acceptEdits` 模式下允许 `-i`（in-place 编辑），但仍阻止危险操作
4. 不在白名单内的 sed 命令返回 `ask`（需要用户审批）

`sedCommandIsAllowedByAllowlist()` 的白名单逻辑（`sedValidation.ts:247-300`）：

- **Pattern 1（行打印）**：`sed -n 'Np'` 形式，必须有 `-n` 标志，表达式只允许 `p`（打印）命令
- **Pattern 2（替换）**：`sed 's/pattern/replacement/flags'` 形式，只允许 `/` 作为分隔符，标志限制为 `g`、`p`、`i`、`I`、`m`、`M` 和数字
- **双重防御**：即使通过白名单，还要经过 `containsDangerousOperations()` 黑名单检查

---

## 函数签名与参数说明

### readOnlyValidation.ts

#### `checkReadOnlyConstraints(input, compoundCommandHasCd): PermissionResult`

唯一导出的校验入口。判断命令是否为只读操作。

| 参数 | 类型 | 说明 |
|------|------|------|
| `input` | `z.infer<typeof BashTool.inputSchema>` | 包含 `command` 字段的输入对象 |
| `compoundCommandHasCd` | `boolean` | 复合命令中是否包含 cd，由上游预计算传入 |

返回值：
- `{ behavior: 'allow' }` — 命令是只读的，可自动放行
- `{ behavior: 'passthrough' }` — 无法确定，交给后续权限检查
- `{ behavior: 'ask' }` — 检测到危险模式（如 UNC 路径），需用户审批

> 源码位置：`readOnlyValidation.ts:1876-1990`

#### `isCommandSafeViaFlagParsing(command: string): boolean`

基于 `COMMAND_ALLOWLIST` 的声明式标志校验。解析命令 token，逐一检查标志是否在安全白名单内。

> 源码位置：`readOnlyValidation.ts:1246-1408`

### pathValidation.ts

#### `checkPathConstraints(input, cwd, toolPermissionContext, compoundCommandHasCd?, astRedirects?, astCommands?): PermissionResult`

路径安全校验的主入口。校验命令中所有文件路径是否在允许的工作目录范围内。

| 参数 | 类型 | 说明 |
|------|------|------|
| `input` | `z.infer<typeof BashTool.inputSchema>` | 包含 `command` 字段的输入 |
| `cwd` | `string` | 当前工作目录 |
| `toolPermissionContext` | `ToolPermissionContext` | 权限上下文（包含允许的目录和模式） |
| `compoundCommandHasCd` | `boolean` | 复合命令中是否有 cd |
| `astRedirects` | `Redirect[]` | 可选，AST 解析得到的重定向列表 |
| `astCommands` | `SimpleCommand[]` | 可选，AST 解析得到的命令列表 |

> 源码位置：`pathValidation.ts:1013-1109`

#### `createPathChecker(command, operationTypeOverride?)`

工厂函数，为指定命令创建路径校验器。返回一个接受 `(args, cwd, context, compoundCommandHasCd?)` 的函数。

> 源码位置：`pathValidation.ts:703-784`

#### `stripWrappersFromArgv(argv: string[]): string[]`

从 argv 数组中剥离安全包装器命令（`timeout`、`nice`、`nohup`、`stdbuf`、`env`、`time`），暴露真实的被包装命令用于校验。

> 源码位置：`pathValidation.ts:1263-1303`

### sedValidation.ts

#### `checkSedConstraints(input, toolPermissionContext): PermissionResult`

sed 命令的跨切面约束检查。在 `acceptEdits` 模式下允许 `-i` 标志，但始终阻止 `w`/`W`/`e`/`E` 等危险操作。

> 源码位置：`sedValidation.ts:644-684`

#### `sedCommandIsAllowedByAllowlist(command, options?): boolean`

判断 sed 命令是否在允许的白名单模式内。

| 参数 | 类型 | 说明 |
|------|------|------|
| `command` | `string` | 完整的 sed 命令 |
| `options.allowFileWrites` | `boolean` | 是否允许 `-i` 等文件写入操作（默认 `false`） |

> 源码位置：`sedValidation.ts:247-300`

---

## 接口/类型定义

### `CommandConfig`（readOnlyValidation.ts）

命令白名单配置结构，驱动 `isCommandSafeViaFlagParsing` 的核心数据类型：

```typescript
type CommandConfig = {
  safeFlags: Record<string, FlagArgType>        // 安全标志及其参数类型映射
  regex?: RegExp                                  // 可选的额外正则校验
  additionalCommandIsDangerousCallback?: (        // 可选的自定义危险检测回调
    rawCommand: string, args: string[]
  ) => boolean
  respectsDoubleDash?: boolean                    // 是否遵循 POSIX `--` 分隔符
}
```

> 源码位置：`readOnlyValidation.ts:35-50`

`FlagArgType` 取值：`'none'`（无参数）、`'string'`（字符串参数）、`'number'`（数字参数）、`'char'`（单字符）、`'EOF'`（特殊值）、`'{}'`（xargs 占位符）。

### `PathCommand`（pathValidation.ts）

支持路径校验的 34 种命令的联合类型：

```typescript
type PathCommand = 'cd' | 'ls' | 'find' | 'mkdir' | 'touch' | 'rm' | 'rmdir'
  | 'mv' | 'cp' | 'cat' | 'head' | 'tail' | 'sort' | 'uniq' | 'wc' | 'cut'
  | 'paste' | 'column' | 'tr' | 'file' | 'stat' | 'diff' | 'awk' | 'strings'
  | 'hexdump' | 'od' | 'base64' | 'nl' | 'grep' | 'rg' | 'sed' | 'git'
  | 'jq' | 'sha256sum' | 'sha1sum' | 'md5sum'
```

> 源码位置：`pathValidation.ts:27-63`

### `COMMAND_OPERATION_TYPE`（pathValidation.ts）

每个 `PathCommand` 对应的文件操作类型（`'read'` | `'write'` | `'create'`），决定路径校验时的权限要求。例如 `cat` 是 `read`，`rm` 是 `write`，`mkdir` 是 `create`。

> 源码位置：`pathValidation.ts:552-589`

---

## 配置项与关键数据结构

### COMMAND_ALLOWLIST（readOnlyValidation.ts）

这是整个只读校验系统的核心配置表（`readOnlyValidation.ts:128-1137`），以声明式方式定义了数十种命令的安全标志白名单。涵盖的命令包括：

| 类别 | 命令 |
|------|------|
| 版本控制 | `git diff`, `git log`, `git show`, `git status`, `git blame`, `git branch` 等（通过 `GIT_READ_ONLY_COMMANDS`） |
| 搜索工具 | `grep`, `rg`（ripgrep）, `fd`/`fdfind` |
| 文件检查 | `file`, `sort`, `sed`, `base64`, `tree` |
| 系统信息 | `ps`, `netstat`, `ss`, `lsof`, `pgrep`, `hostname`, `date` |
| 容器/云 | Docker 只读命令（通过 `DOCKER_READ_ONLY_COMMANDS`）、`pyright` |
| 管道工具 | `xargs`（Windows 上禁用，防止 UNC 路径攻击） |
| 终端工具 | `tput`, `man`, `help`, `info` |

### ANT_ONLY_COMMAND_ALLOWLIST

仅在 `USER_TYPE=ant` 时启用的额外白名单，包含 `gh`（GitHub CLI）只读命令和 `aki`（Anthropic 内部知识库搜索工具）。这些命令涉及网络请求，默认不在只读白名单中。

> 源码位置：`readOnlyValidation.ts:1141-1199`

### PATH_EXTRACTORS（pathValidation.ts）

一个 `Record<PathCommand, (args: string[]) => string[]>` 映射表，为每种命令定义了从参数中提取文件路径的逻辑。不同命令有不同的路径提取策略：

- **cd**：所有参数拼接为一个路径
- **find**：收集第一个非全局标志之前的路径参数 + `-newer`/`-path` 等标志的参数
- **grep/rg**：跳过 pattern 参数，提取后续的文件路径
- **sed**：跳过 `-e` 表达式和脚本参数，提取文件参数
- **git**：仅 `git diff --no-index` 需要路径校验
- **大部分简单命令**（cat、head、rm 等）：使用 `filterOutFlags` 过滤掉标志后的参数即为路径

> 源码位置：`pathValidation.ts:190-509`

### READONLY_COMMANDS 与 READONLY_COMMAND_REGEXES

作为 `COMMAND_ALLOWLIST` 的补充，`READONLY_COMMANDS` 列表定义了一批简单的只读命令（`cal`、`uptime`、`cat`、`id`、`uname` 等），通过 `makeRegexForSafeCommand` 转为正则表达式。`READONLY_COMMAND_REGEXES` 还包含一些手写的复杂正则模式（如 `echo`、`jq`、`cd`、`ls`、`find`）。

> 源码位置：`readOnlyValidation.ts:1432-1570`

---

## 边界 Case 与注意事项

### 安全设计原则

1. **Fail-closed**：所有解析失败、未知标志、不可预知的运行时展开，均默认视为不安全
2. **双重防御**：白名单匹配通过后，仍需经过黑名单检查（如 sed 的 `containsDangerousOperations`）
3. **POSIX `--` 处理**：所有路径提取器正确处理 `--` 分隔符，防止 `rm -- -/../.claude/settings.json` 类攻击绕过路径校验（`pathValidation.ts:126-138`）

### 变量展开攻击防护

`isCommandSafeViaFlagParsing` 在标志校验之前会拒绝所有包含 `$` 的 token（`readOnlyValidation.ts:1328-1369`）。这是因为 `shell-quote` 将 `$VAR` 保留为字面文本，但 bash 运行时会展开它，导致解析器和实际行为不一致。三种具体攻击向量在注释中有详细说明。

### xargs 特殊处理

xargs 的 `-i` 和 `-e` 小写标志被故意排除（`readOnlyValidation.ts:132-151`），因为 GNU getopt 对这两个标志使用可选参数语义（`i::`/`e::`），导致空格分隔时参数消费方式与校验器的假设不一致，可引发命令注入。仅保留大写 `-I {}` 和 `-E EOF`。

### sed 的 `w`/`e` 命令检测

sed 的 `w` 命令将匹配行写入文件，`e` 命令执行外部命令——这两个操作极其危险。`containsDangerousOperations()` 通过一系列保守的正则检查来检测这些模式（`sedValidation.ts:473-629`），包括：
- 拒绝非 ASCII 字符（Unicode 同形字攻击）
- 拒绝花括号（块命令太复杂无法安全解析）
- 拒绝以 `s\` 开头的替换（反斜杠分隔符绕过）
- 拒绝替换标志中包含 `w`/`W`/`e`/`E` 的命令

### cd + 写操作的复合命令

当复合命令中同时存在 `cd` 和写操作时，路径校验无法准确确定最终工作目录，因此直接要求用户审批（`pathValidation.ts:630-655`）。例如 `cd .claude/ && mv test.txt settings.json` 可能绕过对 `.claude/settings.json` 的保护。

### 安全包装器剥离

`timeout`、`nice`、`nohup`、`stdbuf`、`env`、`time` 这些包装器命令会在路径校验前被剥离（`pathValidation.ts:1152-1303`），以确保被包装的实际命令也能得到正确校验。例如 `timeout 10 rm -rf /` 不会因为基础命令是 `timeout` 而跳过路径校验。

### tree -R 的安全隐患

`tree` 命令的 `-R` 标志被排除在安全白名单之外，因为它在深度边界处会自动写入 `00Tree.html` 文件——这是一个文件写入操作，零权限要求（`readOnlyValidation.ts:657-663`）。

### mv/cp 的标志限制

`mv` 和 `cp` 命令的 `COMMAND_VALIDATOR` 会拒绝任何带有标志的调用（`pathValidation.ts:596-601`），因为 `--target-directory=PATH` 等标志可以绕过路径提取逻辑。