# 命令前缀提取、规格系统与安全验证

## 概述与职责

本模块是 Claude Code **Shell 执行安全基础设施**的核心组成部分，位于 `Infrastructure > ShellAndBash` 层级下。它解决的核心问题是：**在 AI Agent 执行 Shell 命令之前，精确识别命令的"前缀"（如 `git status`、`npm run`），并验证该命令是否为只读安全操作**。

这套机制支撑了 Claude Code 的权限系统——用户可以授权"允许以 `git status` 开头的命令"，而不是笼统地允许所有 `git` 命令。同级模块 `PermissionsAndAuth` 中的权限分类器依赖本模块的输出做最终的允许/拒绝决策。

模块由四个功能子系统组成：

1. **命令规格系统**（`registry.ts` + `specs/`）：定义和加载命令的参数结构
2. **静态前缀提取**（`bash/prefix.ts` + `shell/specPrefix.ts`）：基于规格树确定性地提取命令前缀
3. **LLM 前缀提取**（`shell/prefix.ts`）：对复杂命令调用 Haiku 模型提取前缀
4. **只读命令验证**（`readOnlyCommandValidation.ts`）：定义 Git/gh/外部命令的安全标志白名单
5. **Shell 补全**（`shellCompletion.ts`）：通过 `compgen`/`zsh` 内置命令提供命令补全

## 关键流程

### 流程一：静态命令前缀提取

这是最常用的路径，用于从 `git -C /repo status --short` 这样的命令中提取出 `git status` 作为权限匹配的前缀。

1. **入口**：调用 `getCommandPrefixStatic(command)`（`src/utils/bash/prefix.ts:28`）
2. **解析命令**：通过 `parseCommand()` 获取命令的 AST 节点，提取环境变量和命令参数
3. **加载规格**：调用 `getCommandSpec(cmd)` 查找命令规格——先查自定义 specs，再查 Fig 包
4. **判断包装器**：检查命令是否为"包装器命令"（如 `timeout`、`nohup`、`sudo`），包装器的特征是其参数中有 `isCommand: true` 标记
5. **提取前缀**：
   - **普通命令**：调用 `buildPrefix()`（`src/utils/shell/specPrefix.ts:88`），遍历参数列表，跳过 flag 及其值，收集子命令，直到达到计算出的最大深度
   - **包装器命令**：调用 `handleWrapper()`（`src/utils/bash/prefix.ts:72`），递归解析被包装的内部命令
6. **复合命令处理**：`getCompoundCommandPrefixesStatic()` 处理 `&&`/`||`/`;` 连接的复合命令，为每个子命令分别提取前缀，然后按根命令分组并通过最长公共前缀（word-aligned LCP）合并

**关键细节**：`calculateDepth()` 函数（`src/utils/shell/specPrefix.ts:139`）决定前缀应包含多少个词。它使用 `DEPTH_RULES` 硬编码表处理特殊命令（如 `gcloud` 深度为 4），并根据子命令规格动态判断——有嵌套子命令的深度为 4，有 variadic 参数的深度为 2，叶子子命令深度为 3 等。

### 流程二：LLM 前缀提取

当静态分析无法处理复杂命令时（如 PowerShell 命令或复杂管道），使用 Haiku LLM 作为后备。

1. **创建提取器**：`createCommandPrefixExtractor(config)`（`src/utils/shell/prefix.ts:92`）返回一个带 LRU 缓存（200 条）的 memoized 函数
2. **预检查**：如果配置了 `preCheck` 回调，先尝试快速判断（如检测 `--help` 命令）
3. **调用 Haiku**：将命令和策略规格发送给 `queryHaiku()`，获取前缀字符串
4. **验证响应**：
   - 检测 `command_injection_detected` 响应——Haiku 发现可疑注入
   - 拒绝危险的 shell 前缀（`bash`、`sh`、`zsh` 等 14 种 shell 可执行文件）
   - 拒绝过于宽泛的 `git` 裸前缀
   - 验证返回的前缀确实是原命令的前缀子串
5. **缓存策略**：成功结果被 LRU 缓存；失败的 Promise 通过 `.catch()` 自动驱逐，防止缓存污染

### 流程三：只读命令验证

`validateFlags()` 函数（`src/utils/shell/readOnlyCommandValidation.ts:1684`）是只读安全校验的核心引擎。

1. **命令匹配**：权限系统将命令前缀（如 `git diff`）与 `GIT_READ_ONLY_COMMANDS` 映射表匹配
2. **标志遍历**：逐 token 解析命令参数：
   - 检查每个 flag 是否在 `safeFlags` 白名单中
   - 验证 flag 参数类型（`none`/`number`/`string`/`char`/`{}`/`EOF`）
   - 处理 `--flag=value` 和 `--flag value` 两种形式
   - 处理短标志合并（如 `-nr`），要求所有合并标志必须是 `none` 类型
3. **特殊处理**：
   - Git 数字简写：`-5` 等同于 `-n 5`
   - grep/rg 附着数字：`-A20` 等同于 `-A 20`
   - `--` 分隔符：根据 `respectsDoubleDash` 配置决定是否停止标志解析
   - xargs 目标命令检测
4. **回调验证**：部分命令有 `additionalCommandIsDangerousCallback`，用于检测位置参数的危险用法（如 `git branch newbranch` 创建分支、`git tag mytag` 创建标签）

## 函数签名

### `getCommandPrefixStatic(command, recursionDepth?, wrapperCount?): Promise<{ commandPrefix: string | null } | null>`

静态提取命令前缀。返回 `null` 表示递归超限（深度 >10 或包装层 >2），返回 `{ commandPrefix: null }` 表示无法提取有效前缀。

> 源码位置：`src/utils/bash/prefix.ts:28-70`

### `getCompoundCommandPrefixesStatic(command, excludeSubcommand?): Promise<string[]>`

处理复合命令（`&&`/`||`/`;` 分隔），返回合并后的前缀数组。`excludeSubcommand` 可过滤已自动允许的只读命令。

> 源码位置：`src/utils/bash/prefix.ts:135-175`

### `getCommandSpec(command): Promise<CommandSpec | null>`

LRU 缓存的命令规格查找，优先自定义 specs，回退 `@withfig/autocomplete`。

> 源码位置：`src/utils/bash/registry.ts:44-53`

### `buildPrefix(command, args, spec): Promise<string>`

基于 Fig 规格遍历参数列表构建命令前缀。跳过 flag 和 flag 值，收集子命令名，受 `calculateDepth()` 控制最大词数。

> 源码位置：`src/utils/shell/specPrefix.ts:88-137`

### `createCommandPrefixExtractor(config): MemoizedFunction`

工厂函数，创建基于 Haiku LLM 的前缀提取器。返回的函数签名为 `(command, abortSignal, isNonInteractiveSession) => Promise<CommandPrefixResult | null>`。

> 源码位置：`src/utils/shell/prefix.ts:92-126`

### `validateFlags(tokens, startIndex, config, options?): boolean`

标志验证引擎，遍历 token 列表验证所有 flag 是否在白名单内且参数类型正确。

> 源码位置：`src/utils/shell/readOnlyCommandValidation.ts:1684-1893`

### `containsVulnerableUncPath(pathOrCommand): boolean`

Windows UNC 路径检测，防止 NTLM/Kerberos 凭证泄露。仅在 Windows 平台生效。

> 源码位置：`src/utils/shell/readOnlyCommandValidation.ts:1562-1638`

### `getShellCompletions(input, cursorOffset, abortSignal): Promise<SuggestionItem[]>`

Shell 命令补全入口。解析光标位置上下文，调用 bash `compgen` 或 zsh 内置命令获取候选项。

> 源码位置：`src/utils/bash/shellCompletion.ts:221-259`

## 接口/类型定义

### `CommandSpec`

命令规格的核心类型，描述一个命令的完整参数结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| name | `string` | 命令名称 |
| description | `string?` | 描述文字 |
| subcommands | `CommandSpec[]?` | 子命令列表（递归） |
| args | `Argument \| Argument[]?` | 位置参数定义 |
| options | `Option[]?` | 命令选项列表 |

> 源码位置：`src/utils/bash/registry.ts:4-10`

### `Argument`

位置参数描述，关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| isCommand | `boolean?` | 标记参数是另一个命令（包装器模式，如 `timeout 5 git status`） |
| isVariadic | `boolean?` | 可重复参数（如 `echo hello world`） |
| isModule | `string \| boolean?` | 模块参数（如 `python -m pytest`） |
| isScript | `boolean?` | 脚本文件参数 |
| isDangerous | `boolean?` | 危险参数标记，影响前缀深度计算 |

> 源码位置：`src/utils/bash/registry.ts:12-20`

### `ExternalCommandConfig`

只读命令验证的配置结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| safeFlags | `Record<string, FlagArgType>` | 安全标志白名单及其参数类型 |
| additionalCommandIsDangerousCallback | `(rawCommand, args) => boolean?` | 额外的危险检测回调 |
| respectsDoubleDash | `boolean?` | 是否遵守 POSIX `--` 语义（默认 true） |

> 源码位置：`src/utils/shell/readOnlyCommandValidation.ts:26-38`

### `FlagArgType`

标志参数类型枚举：`'none'` | `'number'` | `'string'` | `'char'` | `'{}'` | `'EOF'`

> 源码位置：`src/utils/shell/readOnlyCommandValidation.ts:18-24`

## 配置项与默认值

### DEPTH_RULES（前缀深度覆盖表）

硬编码的命令前缀深度映射（`src/utils/shell/specPrefix.ts:21-34`），用于覆盖自动计算的结果：

| 命令 | 深度 | 说明 |
|------|------|------|
| `rg` | 2 | pattern 参数必需 |
| `gcloud` | 4 | 深层子命令树 |
| `gcloud compute` | 6 | 更深的子命令 |
| `aws`、`az` | 4 | 云 CLI 子命令 |
| `kubectl` | 3 | K8s CLI |
| `docker`、`dotnet` | 3 | 容器/框架 CLI |
| `git push` | 2 | 避免把 remote 名纳入前缀 |

### 自定义命令规格（`specs/` 目录）

7 个内置命令规格，覆盖 Fig 包中缺失或不精确的命令定义：

- **`timeout`**：包装器命令，第二个参数 `isCommand: true`
- **`nohup`**、**`time`**：包装器命令，首个参数 `isCommand: true`
- **`srun`**：SLURM 集群命令，支持 `-n`/`-N` 选项，参数 `isCommand: true`
- **`alias`**：参数 `isVariadic: true`（深度降为 1）
- **`sleep`**：单参数命令
- **`pyright`**：完整选项列表定义

### LLM 前缀提取器配置

- LRU 缓存大小：200 条（`src/utils/shell/prefix.ts:123`）
- 慢查询告警阈值：10 秒（`src/utils/shell/prefix.ts:210`）
- 危险 Shell 前缀黑名单：14 个 shell 可执行文件名（`src/utils/shell/prefix.ts:28-44`）

### Shell 补全配置

- 最大补全数：15 条（`src/utils/bash/shellCompletion.ts:12`）
- 补全超时：1000ms（`src/utils/bash/shellCompletion.ts:13`）
- 支持的 Shell：bash 和 zsh

## 只读命令验证映射表

`readOnlyCommandValidation.ts`（约 1900 行）定义了完整的只读安全命令白名单，分为以下几组：

### GIT_READ_ONLY_COMMANDS（21 条）

覆盖 `git diff`、`git log`、`git show`、`git status`、`git blame`、`git branch`、`git tag`、`git ls-files`、`git ls-remote`、`git remote`、`git rev-parse`、`git rev-list`、`git describe`、`git cat-file`、`git for-each-ref`、`git grep`、`git stash list`、`git stash show`、`git worktree list`、`git shortlog`、`git reflog` 等。

多个命令配置了 `additionalCommandIsDangerousCallback` 来阻止位置参数导致的写操作：
- `git branch`：阻止 `git branch newname`（创建分支）
- `git tag`：阻止 `git tag v1.0`（创建标签）
- `git reflog`：阻止 `expire`/`delete` 子命令
- `git remote show`：仅允许单个字母数字 remote 名

### GH_READ_ONLY_COMMANDS（20 条）

覆盖 `gh pr view/list/diff/checks/status`、`gh issue view/list/status`、`gh run list/view`、`gh release list/view`、`gh workflow list/view`、`gh label list`、`gh search repos/issues/prs/commits/code`、`gh repo view`、`gh auth status` 等。

所有 `gh` 命令共享 `ghIsDangerousCallback`（`src/utils/shell/readOnlyCommandValidation.ts:944`），阻止网络数据外泄——检测 `HOST/OWNER/REPO` 格式（3 段斜杠）、URL 和 SSH 格式的仓库参数。

### 其他只读命令

- **DOCKER_READ_ONLY_COMMANDS**：`docker logs`、`docker inspect`
- **RIPGREP_READ_ONLY_COMMANDS**：`rg`（ripgrep）完整标志集
- **PYRIGHT_READ_ONLY_COMMANDS**：`pyright`（`respectsDoubleDash: false`，阻止 `--watch`）
- **EXTERNAL_READONLY_COMMANDS**：`docker ps`、`docker images`（跨平台命令，无需标志验证）

## 边界 Case 与注意事项

### 安全关键：标志解析器差异攻击

代码中有大量详细的安全注释，记录了多种**解析器差异**（parser differential）攻击的防御：

- **`-S` 参数类型修复**（`git diff`）：`-S` 必须声明为 `'string'` 而非 `'none'`，否则 `git diff -S -- --output=/tmp/pwned` 会绕过验证导致任意文件写入（`src/utils/shell/readOnlyCommandValidation.ts:160-168`）
- **短标志合并安全**：`-rI` 形式的合并标志中，如果任何标志需要参数（非 `'none'`），则拒绝整个合并，防止 `xargs -rI echo sh -c id` 这样的 RCE（`src/utils/shell/readOnlyCommandValidation.ts:1796-1811`）
- **`--flag=` 空值处理**：`-E=` 必须视为"已提供空值"而非"无值"，否则会消费下一个 token 造成解析偏移（`src/utils/shell/readOnlyCommandValidation.ts:1735-1751`）
- **`git branch --abbrev N`**：git 对 `--abbrev` 使用 `PARSE_OPT_OPTARG`（仅接受附着值 `--abbrev=N`），分离形式的 `N` 变成位置参数（创建分支），通过双层防御解决（`src/utils/shell/readOnlyCommandValidation.ts:824-832`）

### LLM 前缀提取的降级机制

- 测试环境直接返回 `null`（`src/utils/shell/prefix.ts:182-184`）
- API 错误、超时或中止的 Promise 会从 LRU 缓存中自动驱逐
- 使用身份保护（identity guard）防止过期的 rejection 删除新入缓存的条目

### 包装器命令递归限制

`getCommandPrefixStatic` 有两层保护（`src/utils/bash/prefix.ts:33`）：
- 递归深度上限：10 层
- 包装器嵌套上限：2 层（如 `sudo timeout 5 git status` 有 2 层包装）

### `respectsDoubleDash` 配置

大多数工具遵守 POSIX `--` 约定（之后的 token 均为位置参数），但 pyright 不遵守——它将 `--` 视为文件路径。`validateFlags` 对此做了专门处理，避免 `pyright -- --createstub os` 绕过验证。

### Shell 补全的安全性

`shellCompletion.ts` 使用 `quote()` 函数对用户输入进行转义后传给 `compgen`/zsh 命令，防止命令注入。文件补全结果通过 `while read` 管道读取，避免文件名中的换行符造成注入。