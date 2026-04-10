# PowerShell 解析与安全支持

## 概述与职责

本模块为 Claude Code 提供完整的 **Windows PowerShell 命令解析和安全分析能力**，是权限系统判定 PowerShell 命令安全性的底层基础设施。它位于 `Infrastructure > ShellAndBash` 层级中，与 Bash 解析器（基于 tree-sitter）并列，共同支撑上层的权限分类器（`PermissionsAndAuth`）和工具执行系统（`ToolSystem`）。

模块由四个文件组成，各司其职：

| 文件 | 职责 |
|------|------|
| `parser.ts` | 核心解析器，通过调用 pwsh 进程获取 PowerShell AST 并转换为结构化 TypeScript 类型 |
| `dangerousCmdlets.ts` | 定义各类危险 cmdlet 集合，供权限引擎和前缀建议系统共同消费 |
| `staticPrefix.ts` | 从解析后的 AST 提取命令前缀，用于权限对话框的"不再询问"建议 |
| `powershellDetection.ts` | 探测系统中可用的 pwsh/powershell 可执行文件路径 |

## 关键流程

### 1. PowerShell 命令解析流程

这是模块的核心流程，将一段 PowerShell 命令文本转换为结构化的 AST 表示。

**入口**：`parsePowerShellCommand(command)` — 对外导出的 LRU 缓存版本（256 条目）。

1. **命令长度校验**：检查命令的 UTF-8 字节长度是否超过 `MAX_COMMAND_LENGTH`。Windows 上该值从 `CreateProcess` 的 32,767 字符限制动态推导而来（`src/utils/powershell/parser.ts:611-641`）；Unix 上固定为 4,500 字节
2. **获取 pwsh 路径**：调用 `getCachedPowerShellPath()` 获取缓存的 PowerShell 可执行文件路径
3. **构建解析脚本**：`buildParseScript()` 将用户命令 Base64 编码（UTF-8）后嵌入 `$EncodedCommand` 变量，拼接内联的 PS1 解析脚本（`PARSE_SCRIPT_BODY`，约 250 行），避免注入攻击（`src/utils/powershell/parser.ts:687-697`）
4. **启动 pwsh 进程**：通过 `execa` 以 `-NoProfile -NonInteractive -NoLogo -EncodedCommand` 参数启动 pwsh，超时默认 5 秒（可通过 `CLAUDE_CODE_PWSH_PARSE_TIMEOUT_MS` 环境变量覆盖），超时后自动重试一次（`src/utils/powershell/parser.ts:1193-1217`）
5. **解析 JSON 输出**：pwsh 进程调用 .NET 的 `[Parser]::ParseInput()` 解析命令，遍历 AST 提取语句、命令元素、变量、重定向、类型字面量等信息，通过 `ConvertTo-Json` 序列化后输出到 stdout
6. **转换为 TypeScript 类型**：`transformRawOutput()` → `transformStatement()` → `transformCommandAst()` 逐层将原始 JSON 映射为强类型的 `ParsedPowerShellCommand` 结构

**缓存失效策略**：瞬态错误（`PwshSpawnError`、`PwshTimeout`、`EmptyOutput`、`InvalidJson`、`PwshError`）会被自动从 LRU 缓存中驱逐，允许后续重试；确定性错误（`CommandTooLong`、语法错误）会保留缓存（`src/utils/powershell/parser.ts:1267-1293`）。

### 2. 危险 Cmdlet 分类体系

`dangerousCmdlets.ts` 将危险 cmdlet 按威胁类型分为多个集合，被权限引擎（`powershellSecurity.ts`）和前缀建议系统（`staticPrefix.ts`）共同引用：

- **`FILEPATH_EXECUTION_CMDLETS`**：通过 `-FilePath` 执行脚本的 cmdlet（`Invoke-Command`、`Start-Job` 等）
- **`DANGEROUS_SCRIPT_BLOCK_CMDLETS`**：接受任意代码的脚本块参数（`Invoke-Expression`、`Invoke-Command`、`New-PSSession` 等）
- **`MODULE_LOADING_CMDLETS`**：加载并执行模块代码（`Import-Module`、`Install-Module` 等，`.psm1` 文件在导入时会执行顶层代码）
- **`NETWORK_CMDLETS`**：网络请求 cmdlet（`Invoke-WebRequest`、`Invoke-RestMethod`），可用于数据渗出/下载
- **`ALIAS_HIJACK_CMDLETS`**：别名/变量篡改 cmdlet（`Set-Alias`、`Set-Variable` 等），可改变命令解析行为
- **`WMI_CIM_CMDLETS`**：WMI/CIM 进程创建（`Invoke-WmiMethod` 等），等效于 `Start-Process` 但绕过常规检查
- **`ARG_GATED_CMDLETS`**：允许列表中带有 `additionalCommandIsDangerousCallback` 的 cmdlet，通配符前缀会绕过回调检查

所有集合最终汇聚到 **`NEVER_SUGGEST`**（`src/utils/powershell/dangerousCmdlets.ts:158-185`），并通过 `aliasesOf()` 自动扩展别名覆盖范围。该集合用于前缀建议系统，阻止为危险命令生成"不再询问"建议。

### 3. 命令前缀提取流程

`staticPrefix.ts` 为权限对话框的"Yes, and don't ask again for: ___"可编辑输入框提供最佳猜测前缀。

**单命令前缀**：`getCommandPrefixStatic(command)` 解析命令后对第一个 `CommandAst` 调用 `extractPrefixFromElement()`：

1. **过滤不安全命令**：`nameType === 'application'`（路径式调用如 `./script.ps1`）直接拒绝；`NEVER_SUGGEST` 集合中的命令拒绝
2. **Cmdlet 处理**：`nameType === 'cmdlet'` 时直接返回命令名（如 `Get-Process`），因为 cmdlet 没有子命令概念
3. **外部命令处理**：验证命令名和参数都是静态值（`StringConstant` / `Parameter`），然后调用 bash 侧的 `buildPrefix()` + fig spec 来识别子命令结构（`src/utils/powershell/staticPrefix.ts:85-87`）
4. **前缀完整性校验**：按位置逐个验证前缀中的每个单词与原始参数对应（防止引号内含空格的参数被 buildPrefix 拆分后产生过宽前缀）（`src/utils/powershell/staticPrefix.ts:106-140`）
5. **裸根拒绝**：单词结果且命令有子命令结构时拒绝（防止 `git` 自动允许 `git push --force`）（`src/utils/powershell/staticPrefix.ts:149-154`）

**复合命令前缀**：`getCompoundCommandPrefixesStatic()` 处理如 `Get-Process; git status && npm test` 的多命令场景，按根命令分组后通过大小写不敏感的**单词对齐最长公共前缀（word-aligned LCP）**合并（如 `npm run test` + `npm run lint` → `npm run`），并拒绝合并到过宽的裸根（`src/utils/powershell/staticPrefix.ts:255-283`）。

### 4. PowerShell 路径探测流程

`findPowerShell()` 按优先级探测系统中的 PowerShell 可执行文件：

1. 优先查找 `pwsh`（PowerShell Core 7+）
2. **Linux Snap 规避**：如果 PATH 解析到 `/snap/` 路径（直接或通过符号链接），改为探测 `/opt/microsoft/powershell/7/pwsh` 或 `/usr/bin/pwsh`——因为 Snap 启动器在子进程中可能因 snapd 初始化而挂起（`src/utils/shell/powershellDetection.ts:31-47`）
3. 回退到 `powershell`（Windows PowerShell 5.1）
4. 结果通过 `getCachedPowerShellPath()` 缓存为单例 Promise

## 函数签名与参数说明

### `parsePowerShellCommand(command: string): Promise<ParsedPowerShellCommand>`

核心解析函数（LRU 缓存，256 条目）。调用 pwsh 进程获取 AST 并返回结构化结果。

- **command**：待解析的 PowerShell 命令文本
- **返回**：`ParsedPowerShellCommand`，解析失败时 `valid = false` 并附带错误信息

> 源码位置：`src/utils/powershell/parser.ts:1275-1294`

### `getCommandPrefixStatic(command: string): Promise<{ commandPrefix: string | null } | null>`

为单条命令提取前缀建议。解析失败返回 `null`，无法提取安全前缀时返回 `{ commandPrefix: null }`。

> 源码位置：`src/utils/powershell/staticPrefix.ts:166-186`

### `getCompoundCommandPrefixesStatic(command: string, excludeSubcommand?): Promise<string[]>`

为复合命令（分号/`&&`/`||` 连接）提取并合并前缀建议列表。

- **excludeSubcommand**：可选过滤器，跳过已被自动允许的子命令（接收 `ParsedCommandElement` 而非文本，避免重新解析）

> 源码位置：`src/utils/powershell/staticPrefix.ts:204-284`

### `findPowerShell(): Promise<string | null>`

探测系统中的 PowerShell 可执行文件路径。优先 pwsh，回退 powershell，未找到返回 `null`。

> 源码位置：`src/utils/shell/powershellDetection.ts:24-57`

### `getPowerShellEdition(): Promise<PowerShellEdition | null>`

从可执行文件名推断 PowerShell 版本：`pwsh` → `'core'`（7+），`powershell` → `'desktop'`（5.1）。用于为模型提供版本相关的语法指导。

> 源码位置：`src/utils/shell/powershellDetection.ts:87-100`

### `deriveSecurityFlags(parsed: ParsedPowerShellCommand): SecurityFlags`

从解析结果中提取安全相关标志，包含子表达式、脚本块、splatting、可扩展字符串、成员调用、赋值、停止解析标记（`--%`）。结合 `elementTypes` 和 `securityPatterns`（belt-and-suspenders 策略）双重检测。

> 源码位置：`src/utils/powershell/parser.ts:1728-1802`

## 接口/类型定义

### `ParsedPowerShellCommand`

解析器的核心输出类型（`src/utils/powershell/parser.ts:164-197`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `valid` | `boolean` | 是否无语法错误 |
| `errors` | `ParseError[]` | 解析错误列表 |
| `statements` | `ParsedStatement[]` | 顶层语句（以 `;` 或换行分隔） |
| `variables` | `ParsedVariable[]` | 所有变量引用 |
| `hasStopParsing` | `boolean` | 是否包含 `--%` 停止解析标记 |
| `originalCommand` | `string` | 原始命令文本 |
| `typeLiterals?` | `string[]` | .NET 类型字面量（供 CLM 允许列表检查） |
| `hasUsingStatements?` | `boolean` | 是否包含 `using module/assembly` |
| `hasScriptRequirements?` | `boolean` | 是否包含 `#Requires` 指令 |

### `ParsedCommandElement`

单个命令调用的结构化表示（`src/utils/powershell/parser.ts:72-95`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 命令名（如 `Get-ChildItem`、`git`） |
| `nameType` | `'cmdlet' \| 'application' \| 'unknown'` | 命令名分类 |
| `elementType` | `PipelineElementType` | AST 节点类型 |
| `args` | `string[]` | 所有参数（含 flags） |
| `elementTypes?` | `CommandElementType[]` | 每个元素的 AST 类型标记 |
| `children?` | `(CommandElementChild[] \| undefined)[]` | 冒号绑定参数的子节点 |

### `COMMON_ALIASES`

PowerShell 常用别名到标准 cmdlet 名的映射表（约 70 条目）。使用 `Object.create(null)` 防止原型链污染。安全注释说明了故意省略的别名（如 `sort`、`curl`），因为 PS Core 6+ 移除了它们以避免与原生可执行文件冲突。

> 源码位置：`src/utils/powershell/parser.ts:1326-1452`

## 配置项与默认值

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `CLAUDE_CODE_PWSH_PARSE_TIMEOUT_MS` | `5000` | 环境变量，pwsh 解析超时（毫秒） |
| `MAX_COMMAND_LENGTH` | Windows: 动态计算（~1K 字节）<br>Unix: `4500` 字节 | 可解析的最大命令 UTF-8 字节长度 |
| LRU 缓存大小 | `256` | `parsePowerShellCommand` 的缓存条目数 |

## 边界 Case 与注意事项

- **Unicode 安全**：命令名含非 ASCII 字符（U+0080 以上）时强制归类为 `application`，防止 .NET `OrdinalIgnoreCase` 折叠（如 `ſtart-proceſſ` → `Start-Process`）而 JS `toLowerCase()` 不折叠导致的绕过（`src/utils/powershell/parser.ts:872-886`）

- **模块前缀剥离时机**：`nameType` 在 `stripModulePrefix` **之前**从原始名称计算——`scripts\Get-Process` 含 `\` 应归类为 `application`，剥离后变成 `Get-Process` 会被误判为 `cmdlet`（`src/utils/powershell/parser.ts:840-848`）

- **PowerShell 5.1 兼容**：`ConvertTo-Json` 可能将单元素数组展开为普通对象，`ensureArray()` 统一处理；token stream 中 `MinusMinus`（PS7）和 `Generic` 类型（PS5.1）都可能表示 `--%`

- **Windows 命令行长度限制**：`CreateProcess` 的 32,767 字符限制经过双层 Base64 编码（UTF-8 → Base64 → UTF-16LE → Base64）放大，实际可解析命令在 Windows 上约 1K UTF-8 字节。超出此限制的命令返回 `valid: false`，导致安全规则降级。该限制**不**应用于 Unix，因为 Unix ARG_MAX 远大于此（`src/utils/powershell/parser.ts:571-641`）

- **Snap 启动器挂起**：Linux 上通过 `realpath` 追踪符号链接，即使 `/usr/bin/pwsh` 本身不在 `/snap/` 下，其最终目标可能是 Snap 二进制，需要完整解析链

- **参数缩写**：PowerShell 允许参数缩写（如 `-en` 匹配 `-EncodedCommand`），`commandHasArgAbbreviation()` 通过最短无歧义前缀检测实现，并处理冒号绑定值和反引号转义（`src/utils/powershell/parser.ts:1663-1684`）

- **ParamBlock 安全漏洞修复**：脚本级 `param()` 块是 `ScriptBlockAst` 的兄弟节点而非子节点，标准的 `Process-BlockStatements` 不会遍历到它。内联 PS1 脚本特别对 `$ast.ParamBlock` 执行 `FindAll` 以发现隐藏在参数默认值或 `[ValidateScript({...})]` 属性中的命令（`src/utils/powershell/parser.ts:282-294`）