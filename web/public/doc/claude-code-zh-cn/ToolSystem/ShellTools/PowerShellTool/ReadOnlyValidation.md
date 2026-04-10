# ReadOnlyValidation — PowerShell 只读命令判定引擎

## 概述与职责

ReadOnlyValidation 是 PowerShell 命令安全校验的核心模块，负责判定一条 PowerShell 命令是否为**只读操作**——即不会产生文件写入、网络请求、状态修改等副作用。它位于 `ToolSystem > ShellTools > PowerShellTool` 层级中，与 BashTool 的同名模块功能对等，但针对 PowerShell 的 cmdlet 语法、别名系统、管道语义做了专门适配。

本模块由两个文件组成：
- **`readOnlyValidation.ts`**（1823 行）：主逻辑文件，包含 cmdlet 白名单、外部命令校验、AST 语句分析、参数泄漏检测等
- **`commonParameters.ts`**（30 行）：定义 PowerShell 通用参数集（`-Verbose`、`-ErrorAction` 等），被 `pathValidation.ts` 和 `readOnlyValidation.ts` 共享，独立抽取以避免循环依赖

当 Claude Code 在 PowerShell 环境中执行命令时，该模块决定命令是否可以自动放行（无需用户确认）。判定为只读的命令直接执行，否则需要弹出权限确认。

## 关键流程

### 整体判定流程（`isReadOnlyCommand`）

这是模块的主入口函数（`readOnlyValidation.ts:1168-1305`），接收原始命令字符串和 AST 解析结果，返回布尔值：

1. **前置检查**：空命令、无 AST、解析失败 → 一律返回 `false`（保守策略）
2. **安全标志检测**：调用 `deriveSecurityFlags(parsed)` 检查 AST 中是否存在脚本块、子表达式、可展开字符串、splatting、成员调用、赋值、stop-parsing 符号 → 任一存在即拒绝
3. **管道分段**：调用 `getPipelineSegments(parsed)` 将命令拆分为多条管道语句
4. **复合命令 + cd 检测**：若命令包含多条语句且其中有 `Set-Location`/`Push-Location`/`Pop-Location`/`New-PSDrive` → 拒绝（防止通过改变工作目录绕过路径校验）
5. **逐语句校验**：对每条管道语句：
   - 检查文件重定向（`> file` 拒绝，`> $null` 放行）
   - 管道首命令必须通过 `isAllowlistedCommand` 校验
   - 管道后续命令必须是安全输出 cmdlet（如 `Out-Null`）或通过白名单校验
   - 检查嵌套命令（`nestedCommands`）→ 存在即拒绝
6. 所有语句通过 → 返回 `true`

### 单命令白名单校验（`isAllowlistedCommand`）

核心的单命令判定逻辑（`readOnlyValidation.ts:1310-1516`），执行以下步骤：

1. **nameType 门控**：若 `nameType === 'application'`（含路径字符如 `.`、`\`、`/`），拒绝。防止 `scripts\Get-Process` 伪装为 cmdlet。例外：`SAFE_EXTERNAL_EXES` 中的 `where.exe` 可通过
2. **白名单查找**：通过 `lookupAllowlist` 在 `CMDLET_ALLOWLIST` 中查找配置（先直接匹配，再解析别名后匹配）
3. **正则约束**：若配置有 `regex`，检查原始命令
4. **危险回调**：若配置有 `additionalCommandIsDangerousCallback`，执行回调
5. **参数元素类型白名单**：遍历 `elementTypes`，仅允许 `StringConstant` 和 `Parameter`。拒绝 `Variable`（`$env:SECRET`）、`Other`（哈希表/类型转换/二元表达式）、`SubExpression` 等。对 `Parameter` 类型还检查冒号绑定值（`-Flag:$env:SECRET`）
6. **外部命令分发**：`git`/`gh`/`docker`/`dotnet` 走专用校验路径
7. **标志校验**：若 `allowAllFlags` 为 true 则跳过；否则逐个检查参数是否在 `safeFlags` 白名单中，同时自动放行 `COMMON_PARAMETERS`

### 参数泄漏检测（`argLeaksValue`）

防止通过命令参数泄漏敏感信息的回调函数（`readOnlyValidation.ts:76-115`），被 `Write-Output`、`Write-Host`、`Start-Sleep`、所有 `Format-*` cmdlet 等使用。检测两类泄漏：

1. **elementTypes 白名单**：仅允许 `StringConstant`（字面量）和 `Parameter`（标志名）。`Variable`（`$env:SECRET`）、`Other`（`@{}`/类型转换）、`ScriptBlock`、`SubExpression`、`ExpandableString` 均拒绝
2. **冒号绑定参数值**：`-InputObject:$env:SECRET` 在 AST 中是单个 `CommandParameterAst`，变量表达式是其子节点。通过 `children[]` 树查询子节点类型；无 children 时回退到文本考古（检查冒号后是否含 `$`、`(`、`@`、`{`、`[`）

### 外部命令校验

#### Git 安全性检查（`isGitSafe`，`readOnlyValidation.ts:1584-1701`）

1. **全局 `$` 拒绝**：任何参数含 `$` 即拒绝（防止 PowerShell 变量展开绕过）
2. **全局标志跳过**：逐个消耗 `--namespace`、`--git-dir` 等全局标志及其值，遇到 `DANGEROUS_GIT_GLOBAL_FLAGS`（`-c`、`-C`、`--exec-path`、`--attr-source` 等）即拒绝
3. **附着短标志**：检测 `-ccore.pager=sh`（`-c` 无空格后接值）等攻击形式
4. **子命令查找**：先尝试双词（`git stash list`），再尝试单词（`git diff`），从 `GIT_READ_ONLY_COMMANDS` 中查找配置
5. **ls-remote URL 拒绝**：防止通过 URL 编码秘密进行数据泄漏
6. **标志校验**：调用共享的 `validateFlags` 校验剩余参数

#### GitHub CLI（`isGhSafe`，`readOnlyValidation.ts:1703-1757`）

- 仅对 `USER_TYPE === 'ant'` 的用户放行（gh 命令涉及网络）
- 双词/单词子命令查找，`$` 拒绝，标志校验

#### Docker（`isDockerSafe`，`readOnlyValidation.ts:1759-1807`）

- 全局 `$` 拒绝
- `EXTERNAL_READONLY_COMMANDS`（如 `docker ps`、`docker images`）无标志约束直接放行
- `DOCKER_READ_ONLY_COMMANDS`（如 `docker logs`、`docker inspect`）走标志校验

#### dotnet（`isDotnetSafe`，`readOnlyValidation.ts:1809-1823`）

- 仅允许 `--version`、`--info`、`--list-runtimes`、`--list-sdks` 四个标志

## 函数签名与参数说明

### `isReadOnlyCommand(command: string, parsed?: ParsedPowerShellCommand): boolean`

主入口。判定整条 PowerShell 命令是否只读。

- **command**：原始命令字符串
- **parsed**：PowerShell AST 解析结果（来自 `utils/powershell/parser.js`）。无 AST 时保守返回 `false`

> 源码位置：`readOnlyValidation.ts:1168-1305`

### `isAllowlistedCommand(cmd: ParsedCommandElement, originalCommand: string): boolean`

判定单个命令元素是否在白名单中且参数安全。

- **cmd**：AST 解析出的命令元素，包含 `name`、`nameType`、`args`、`elementTypes`、`children`、`text` 等字段
- **originalCommand**：原始完整命令字符串（用于 regex 匹配）

> 源码位置：`readOnlyValidation.ts:1310-1516`

### `argLeaksValue(_cmd: string, element?: ParsedCommandElement): boolean`

检测命令参数是否可能泄漏敏感值。返回 `true` 表示危险。

> 源码位置：`readOnlyValidation.ts:76-115`

### `hasSyncSecurityConcerns(command: string): boolean`

基于正则的快速安全预检。检测 `$(`、splatting `@var`、`.Method()`、赋值 `$var=`、`--%`、UNC 路径 `\\`、静态方法 `::` 等危险模式。

> 源码位置：`readOnlyValidation.ts:1112-1159`

### `resolveToCanonical(name: string): string`

将命令名解析为规范小写 cmdlet 名。处理 `COMMON_ALIASES` 别名解析和 Windows `PATHEXT` 扩展名剥离（`.exe`/`.cmd`/`.bat`/`.com`）。仅对无路径分隔符的裸名称剥离扩展名。

> 源码位置：`readOnlyValidation.ts:984-996`

### `isCwdChangingCmdlet(name: string): boolean`

检测命令是否会改变路径解析命名空间（`Set-Location`/`Push-Location`/`Pop-Location`/`New-PSDrive`）。

> 源码位置：`readOnlyValidation.ts:1017-1033`

### `isProvablySafeStatement(stmt: ParsedStatement): boolean`

验证语句是否为可完全校验的 `PipelineAst`（每个元素都是 `CommandAst`）。其他语句类型（赋值、控制流、表达式源）一律返回 `false`。

> 源码位置：`readOnlyValidation.ts:1072-1082`

### `isSafeOutputCommand(name: string): boolean` / `isAllowlistedPipelineTail(cmd, originalCommand): boolean`

前者检查是否为安全输出 cmdlet（当前仅 `Out-Null`）。后者检查是否为从 `SAFE_OUTPUT_CMDLETS` 迁移到 `CMDLET_ALLOWLIST` 的管道尾部转换器（`Format-Table`、`Select-Object` 等），需同时通过 `isAllowlistedCommand` 的参数校验。

> 源码位置：`readOnlyValidation.ts:1038-1061`

## 接口/类型定义

### `CommandConfig`

白名单中每个命令的配置结构（`readOnlyValidation.ts:39-56`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `safeFlags` | `string[]` | 允许的标志列表。缺省且无 `allowAllFlags` 时仅允许位置参数 |
| `allowAllFlags` | `boolean` | 为 `true` 时跳过标志校验（整个标志表面都是只读的） |
| `regex` | `RegExp` | 对原始命令的正则约束 |
| `additionalCommandIsDangerousCallback` | `(command, element?) => boolean` | 额外的危险判定回调，返回 `true` 表示危险 |

## CMDLET_ALLOWLIST 白名单分类

白名单（`readOnlyValidation.ts:129-882`）使用 `Object.create(null)` 构建以防原型链污染，按功能分为以下类别：

| 分类 | 代表 cmdlet | 说明 |
|------|-------------|------|
| 文件系统（只读） | `Get-ChildItem`、`Get-Content`、`Get-Item`、`Test-Path`、`Resolve-Path`、`Get-FileHash`、`Get-Acl` | 路径/内容读取 |
| 导航 | `Set-Location`、`Push-Location`、`Pop-Location` | 仅改变工作目录 |
| 文本搜索 | `Select-String` | 文件内容搜索 |
| 数据转换 | `ConvertTo-Json`、`ConvertFrom-Json`、`ConvertTo-Csv` 等 | 纯转换，无副作用 |
| 对象检查 | `Get-Member`、`Compare-Object`、`Join-String`、`Get-Random` | 对象元数据和操作 |
| 路径工具 | `Convert-Path`、`Join-Path`、`Split-Path` | 路径字符串操作 |
| 系统信息 | `Get-Process`、`Get-Service`、`Get-ComputerInfo`、`Get-Date`、`Get-Module` 等 | 系统状态查询 |
| 输出/格式化 | `Write-Output`、`Write-Host`、`Format-Table`、`Select-Object`、`Sort-Object` 等 | 均配有 `argLeaksValue` 回调 |
| 网络信息 | `Get-NetAdapter`、`Get-NetIPAddress`、`Get-NetRoute` 等 | 网络配置查询 |
| 事件日志 | `Get-EventLog`、`Get-WinEvent` | 日志读取 |
| WMI/CIM | `Get-CimClass` | 仅类元数据（`Get-WmiObject`/`Get-CimInstance` 已移除） |
| 外部命令 | `git`、`gh`、`docker`、`dotnet` | 走专用子命令校验 |
| Windows 系统命令 | `ipconfig`、`netstat`、`systeminfo`、`tasklist`、`hostname`、`whoami` 等 | 各有针对性的标志/位置参数限制 |
| 跨平台 CLI | `file`、`tree`、`findstr` | 文件检查和搜索 |

## commonParameters.ts — 通用参数集

定义 PowerShell `[CmdletBinding()]` 自动注入的通用参数（`commonParameters.ts:1-31`）：

- **`COMMON_SWITCHES`**：`-Verbose`、`-Debug`
- **`COMMON_VALUE_PARAMS`**：`-ErrorAction`、`-WarningAction`、`-InformationAction`、`-ProgressAction`、`-ErrorVariable`、`-WarningVariable`、`-InformationVariable`、`-OutVariable`、`-OutBuffer`、`-PipelineVariable`
- **`COMMON_PARAMETERS`**：`ReadonlySet<string>`，合并以上两组

这些参数仅控制错误/警告/进度流的路由，不会让只读 cmdlet 产生写操作。在标志校验中自动放行（`readOnlyValidation.ts:1502-1505`），避免 `Get-Content file.txt -ErrorAction SilentlyContinue` 这类命令误触提示。

## 边界 Case 与注意事项

### 已移除的 cmdlet（安全审计结论）

以下 cmdlet 经安全审计后被显式移除，代码中有详细注释说明原因：

- **`Select-Xml`**（XXE 攻击：XML 外部实体可触发网络请求）
- **`Test-Json`**（JSON Schema `$ref` 可指向外部 URL）
- **`Get-Command`/`Get-Help`**（`-Name` 参数触发模块自动加载，执行 `.psm1` 初始化代码；管道输入绕过参数回调）
- **`Get-WmiObject`/`Get-CimInstance`**（`Win32_PingStatus` 类发送 ICMP，`-ComputerName` 连接远程主机）
- **`Get-Clipboard`**（可暴露剪贴板中的密码/API 密钥）
- **`netsh`**（语法过于复杂，三轮 denylist 扩展仍有漏洞）
- **`man`/`help`**（别名解析到已移除的 `Get-Help`）

### 管道安全性

管道尾部的 cmdlet 也必须通过校验。`SAFE_OUTPUT_CMDLETS` 当前仅含 `Out-Null`。`Format-Table`、`Select-Object` 等已迁移到 `CMDLET_ALLOWLIST` 并配有 `argLeaksValue` 回调——因为它们都接受 calculated-property 哈希表（`@{N='x';E={...}}`）可执行任意表达式。

### 变量展开攻击面

PowerShell 的 `$env:SECRET` 等变量在运行时展开，但校验时作为字面文本处理。本模块通过三层防御：
1. `deriveSecurityFlags` 检测 AST 级的子表达式/可展开字符串/splatting
2. `elementTypes` 白名单拒绝 `Variable` 类型的参数
3. 外部命令（git/gh/docker）额外做全局 `$` 字符串检查

### 冒号绑定参数

PowerShell 的 `-Flag:$value` 语法将值绑定为参数的子节点而非独立命令元素。AST 中只产生一个 `CommandParameterAst`，`elementTypes` 显示为 `Parameter`。本模块通过查询 `children[]` 树检查子节点类型来捕获此类泄漏。

### Windows 路径扩展名（PATHEXT）

`git.exe`、`git.cmd`、`git.bat`、`git.com` 在 Windows 上都解析为 git。`resolveToCanonical` 对无路径分隔符的裸名称自动剥离这些扩展名。但 `.ps1` 被排除——`git.ps1` 不是 git 二进制文件。

### 原型链污染防护

`CMDLET_ALLOWLIST` 使用 `Object.create(null)` 创建，防止攻击者构造的命令名（如 `constructor`、`__proto__`）匹配到 `Object.prototype` 的继承属性。