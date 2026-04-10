# Windows 路径安全校验与 Git 防护（PathAndGitSafety）

## 概述与职责

本模块是 PowerShellTool 的安全核心之一，负责两项关键防护职责：

1. **路径安全校验**（`pathValidation.ts`，2049 行）：从 PowerShell AST 中提取文件路径参数，校验这些路径是否在项目允许的目录范围内，阻止路径遍历攻击、UNC 凭证泄漏、危险设备路径访问等安全威胁。
2. **Git 沙箱逃逸防护**（`gitSafety.ts`，176 行）：防止两种特定的 Git 攻击向量——裸仓库攻击（bare-repo attack）和 Git 内部写入攻击。

在整体架构中，本模块属于 **ToolSystem → ShellTools → PowerShellTool** 层级。它与 BashTool 中的同名模块保持设计对等（parity），但针对 PowerShell 语法的特殊性做了大量适配——包括 Unicode 破折号参数前缀、反引号转义、冒号绑定参数语法、PowerShell Provider 路径等。同级的 `powershellSecurity.ts` 和 `powershellPermissions.ts` 分别处理命令注入检测和 cmdlet 级权限匹配，而本模块专注于**文件系统路径层面的安全校验**。

---

## 关键流程

### 一、路径校验主流程（checkPathConstraints）

入口函数 `checkPathConstraints()` 接收已解析的 PowerShell AST 和权限上下文，返回三种结果之一：`passthrough`（放行）、`ask`（需用户确认）、`deny`（拒绝）。

**核心执行步骤**（`pathValidation.ts:1528-1567`）：

1. **两遍扫描策略**：遍历所有 statement，先收集所有 deny 和 ask 结果。deny 优先级高于 ask——即使第一个 statement 需要 ask，也会继续检查后续 statement 是否有 deny 规则命中。
2. 对每个 statement 调用 `checkPathConstraintsForStatement()`。

**单语句校验流程**（`checkPathConstraintsForStatement`，`pathValidation.ts:1569-2049`）：

1. **复合命令 cd 检测**（`pathValidation.ts:1606-1617`）：如果整个复合命令包含 `Set-Location`/`Push-Location`/`Pop-Location`/`New-PSDrive`，则后续语句中的相对路径无法信任（Node.js 的 `getCwd()` 不会跟踪 PowerShell 的 cd），强制 ask。与 BashTool 不同的是，**读操作也被阻止**——因为 `Set-Location ~; Get-Content ./.ssh/id_rsa` 可以绕过 deny 规则。

2. **管道表达式源检测**（`pathValidation.ts:1628-1634`）：检测管道中的非 CommandAst 元素（字符串、变量、数组表达式），如 `'/etc/passwd' | Remove-Item`——路径来自管道输入，无法静态验证。

3. **路径提取与逐路径校验**：对每个 cmdlet 调用 `extractPathsFromCommand()` 提取路径，然后逐一调用 `validatePath()` 校验。

4. **嵌套命令处理**（`pathValidation.ts:1812-1935`）：控制流内部的命令（如 `if ($true) { Remove-Item / }`）通过 `nestedCommands` 递归校验。

5. **重定向目标校验**（`pathValidation.ts:1937-2041`）：检查输出重定向（`>`/`>>`）的目标路径是否在允许范围内。

### 二、路径提取流程（extractPathsFromCommand）

`extractPathsFromCommand()`（`pathValidation.ts:1304-1508`）从单个 cmdlet 的 AST 参数中提取文件路径：

1. 通过 `resolveToCanonical()` 将 cmdlet 名（含别名）解析为规范名，查找 `CMDLET_PATH_CONFIG` 配置。
2. 合并 cmdlet 特定参数与公共参数（`COMMON_SWITCHES`/`COMMON_VALUE_PARAMS`）。
3. 遍历参数列表，分四类处理：
   - **已知路径参数**（如 `-Path`、`-LiteralPath`）：提取值作为路径
   - **叶子路径参数**（`leafOnlyPathParams`，如 `New-Item -Name`）：仅提取不含路径分隔符的简单文件名
   - **已知开关/值参数**：跳过或消耗值（不作为路径）
   - **未知参数**：标记 `hasUnvalidatablePathArg = true`（强制 ask），但仍尝试从冒号语法中提取值以匹配 deny 规则
4. 处理 `positionalSkip`（如 `Invoke-WebRequest` 的位置参数 0 是 URL 而非路径）。

**安全模型核心原则**：任何不在三个已知参数集（pathParams、knownSwitches、knownValueParams）中的参数都会触发 `hasUnvalidatablePathArg`，终结了逐个添加 switch 的 whack-a-mole 问题（`pathValidation.ts:73-77`）。

### 三、单路径校验流程（validatePath）

`validatePath()`（`pathValidation.ts:1013-1264`）对单个路径执行多层安全检查，**按顺序**：

1. **反引号转义检测**（`pathValidation.ts:1032-1061`）：PowerShell 的反引号是转义字符，在 Node.js 的 `path.isAbsolute()` 中不被识别。包含反引号的路径无法静态验证，先尝试 deny 规则匹配（strip 反引号后猜测），未命中则 ask。

2. **Provider 路径检测**（`pathValidation.ts:1067-1096`）：阻止 `Microsoft.PowerShell.Core\FileSystem::/etc/passwd` 等模块限定的 Provider 路径。`::` 分隔符后的部分被提取并尝试 deny 匹配。

3. **UNC 路径阻止**（`pathValidation.ts:1098-1114`）：以 `//` 开头或包含 `DavWWWRoot`/`@SSL@` 的路径被无条件阻止——它们会触发网络请求并泄漏 NTLM/Kerberos 凭证。

4. **变量扩展语法阻止**（`pathValidation.ts:1117-1126`）：包含 `$` 或 `%` 的路径需手动审批。

5. **非文件系统 Provider 路径阻止**（`pathValidation.ts:1128-1159`）：
   - Windows 上，2+ 字母开头加冒号的被阻止（排除单字母驱动器号如 `C:`）
   - POSIX 上，任何 `字母:` 前缀都被阻止（因为 PSDrive 可映射到任意文件系统根）

6. **通配符路径处理**（`pathValidation.ts:1161-1242`）：
   - 写操作中的通配符路径直接阻止
   - 读操作中包含路径遍历（`../`）的通配符路径：解析完整路径后校验
   - 纯读通配符路径：无法静态验证（符号链接可能指向任意位置），仅检查基目录的 deny 规则

7. **路径解析与权限检查**（`pathValidation.ts:1244-1264`）：`safeResolvePath()` 解析符号链接，然后调用 `isPathAllowed()` 进行最终权限判定。

### 四、权限判定流程（isPathAllowed）

`isPathAllowed()`（`pathValidation.ts:863-977`）按优先级检查：

1. **Deny 规则**（最高优先级）→ 命中则直接 deny
2. **内部可编辑路径**（如 `.claude/` 下的计划文件、暂存区、Agent 记忆）→ 写操作放行
3. **安全性检查**（`checkPathSafetyForAutoEdit`）→ 危险目录检测
4. **工作目录检查** → 路径在允许的工作目录内且操作合规则放行
5. **内部可读路径** → 读操作放行
6. **沙箱写白名单** → 写操作且路径在沙箱配置的可写目录中
7. **Allow 规则** → 命中则放行
8. **兜底** → 不允许

### 五、Git 安全防护流程（gitSafety.ts）

`gitSafety.ts` 防护两种沙箱逃逸攻击（`gitSafety.ts:1-8`）：

**攻击向量 1——裸仓库攻击**：如果 cwd 包含 `HEAD` + `objects/` + `refs/` 但没有有效的 `.git/HEAD`，Git 会将 cwd 当作裸仓库并执行其中的 hooks。

**攻击向量 2——Git 内部写入攻击**：复合命令先创建 `HEAD`/`objects`/`refs`/`hooks/` 目录结构，然后执行 `git`——git 子命令会执行刚创建的恶意 hooks。

**核心函数**：

- `isGitInternalPathPS(arg)`（`gitSafety.ts:139-151`）：判断参数是否指向 cwd 中的 Git 内部路径。覆盖裸仓库路径（`hooks/`、`refs/`）和标准仓库路径（`.git/hooks/`、`.git/config`）。
- `isDotGitPathPS(arg)`（`gitSafety.ts:158-168`）：仅匹配 `.git/` 内部路径，不匹配裸仓库样式的根级 `hooks/`、`refs/`（因为这些是常见的项目目录名）。

**路径规范化**（`normalizeGitPathArg`，`gitSafety.ts:48-87`）依次执行：
1. Unicode 破折号/正斜杠参数前缀处理（提取冒号绑定值）
2. 引号剥离、反引号移除
3. PowerShell Provider 前缀剥离（`FileSystem::`）
4. 驱动器相对路径处理（`C:foo` → `foo`，保留 `C:\foo`）
5. 反斜杠标准化为正斜杠
6. **NTFS 逐组件尾部空格/点号剥离**（`gitSafety.ts:70-83`）：Windows CreateFileW API 会自动剥离路径组件尾部的空格和点号，攻击者可利用 `hooks .` 或 `HEAD...` 绕过字符串匹配
7. `posix.normalize()` 规范化
8. 小写化

**cwd 重入解析**（`resolveCwdReentry`，`gitSafety.ts:23-38`）：处理 `../project/hooks` 形式的路径——当 cwd 为 `/x/project` 时，`../project/hooks` 实际指向 `hooks`（在 cwd 内），但 `posix.normalize` 无法解析这种情况。

**逃逸路径解析**（`resolveEscapingPathToCwdRelative`，`gitSafety.ts:106-122`）：对 `../` 开头或绝对路径，通过 `path.resolve(cwd, n)` 解析后检查是否落回 cwd 内部。这是裸仓库 HEAD 攻击的**唯一防护点**（`gitSafety.ts:99-104`注释明确说明）。

**NTFS 8.3 短名称防护**（`gitSafety.ts:170-176`）：`.git` 在 NTFS 上的 8.3 短名称是 `GIT~1`（或 `GIT~2` 等），`matchesDotGitPrefix` 通过正则 `/^git~\d+($|\/)/.test(n)` 匹配。

---

## 函数签名与参数说明

### pathValidation.ts 导出函数

#### `checkPathConstraints(input, parsed, toolPermissionContext, compoundCommandHasCd?): PermissionResult`

路径校验主入口。

| 参数 | 类型 | 说明 |
|------|------|------|
| `input` | `{ command: string }` | 原始命令文本 |
| `parsed` | `ParsedPowerShellCommand` | PowerShell AST 解析结果 |
| `toolPermissionContext` | `ToolPermissionContext` | 当前会话的权限上下文 |
| `compoundCommandHasCd` | `boolean`（默认 `false`） | 复合命令是否包含 cd 操作 |

返回 `PermissionResult`，`behavior` 为 `'passthrough'` | `'ask'` | `'deny'`。

> 源码位置：`pathValidation.ts:1528-1567`

#### `isDangerousRemovalRawPath(filePath: string): boolean`

检查原始路径（未经 realpath）是否为危险的删除目标（`/`、`~`、`/etc` 等）。

> 源码位置：`pathValidation.ts:840-846`

#### `dangerousRemovalDeny(path: string): PermissionResult`

为危险路径删除生成 deny 类型的 `PermissionResult`。

> 源码位置：`pathValidation.ts:848-857`

### gitSafety.ts 导出函数

#### `isGitInternalPathPS(arg: string): boolean`

判断 PowerShell 参数是否指向 Git 内部路径（含裸仓库路径和 `.git/` 子路径）。

> 源码位置：`gitSafety.ts:139-151`

#### `isDotGitPathPS(arg: string): boolean`

判断 PowerShell 参数是否指向 `.git/` 内部路径（不含裸仓库根级路径）。

> 源码位置：`gitSafety.ts:158-168`

---

## 接口与类型定义

### `CmdletPathConfig`

每个 cmdlet 的参数-路径映射配置（`pathValidation.ts:88-122`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `operationType` | `'read' \| 'write' \| 'create'` | cmdlet 的文件系统操作类型 |
| `pathParams` | `string[]` | 接受文件路径的参数名 |
| `knownSwitches` | `string[]` | 开关参数（不消耗下一个参数） |
| `knownValueParams` | `string[]` | 接受值但非路径的参数 |
| `leafOnlyPathParams?` | `string[]` | 仅接受叶子文件名的路径参数 |
| `positionalSkip?` | `number` | 跳过的前导位置参数数量 |
| `optionalWrite?` | `boolean` | 是否仅在 pathParam 存在时才写入磁盘 |

### `PathCheckResult` / `ResolvedPathCheckResult`

路径检查结果类型（`pathValidation.ts:54-61`）：

```typescript
type PathCheckResult = {
  allowed: boolean
  decisionReason?: PermissionDecisionReason
}

type ResolvedPathCheckResult = PathCheckResult & {
  resolvedPath: string
}
```

### `FileOperationType`

```typescript
type FileOperationType = 'read' | 'write' | 'create'
```

---

## 配置项：CMDLET_PATH_CONFIG

`CMDLET_PATH_CONFIG`（`pathValidation.ts:124-765`）是一个 `Record<string, CmdletPathConfig>`，为 30+ 个 cmdlet 定义了参数-路径映射。按操作类型分为两组：

**写/创建操作 cmdlet**（13 个）：`set-content`、`add-content`、`remove-item`、`clear-content`、`out-file`、`tee-object`、`export-csv`、`export-clixml`、`new-item`、`copy-item`、`move-item`、`rename-item`、`set-item`、`invoke-webrequest`、`invoke-restmethod`、`expand-archive`、`compress-archive`、`set-itemproperty`、`new-itemproperty`、`remove-itemproperty`、`clear-item`、`export-alias`

**读操作 cmdlet**（14 个）：`get-content`、`get-childitem`、`get-item`、`get-itemproperty`、`get-itempropertyvalue`、`get-filehash`、`get-acl`、`format-hex`、`test-path`、`resolve-path`、`convert-path`、`select-string`、`set-location`、`push-location`、`pop-location`、`select-xml`、`get-winevent`

**通配符正则**（`pathValidation.ts:50`）：
```typescript
const GLOB_PATTERN_REGEX = /[*?[\]]/
```
仅匹配 PowerShell 通配符 `*`、`?`、`[`、`]`——花括号 `{}` 在 PowerShell 中是字面字符（无 brace expansion），不包含在内。

---

## 边界 Case 与注意事项

### 安全设计哲学

- **Deny > Ask > Passthrough**：两遍扫描确保 deny 规则始终优先，不会被前面的 ask 短路。
- **未知即危险**：不在已知参数集中的参数一律触发 ask（`hasUnvalidatablePathArg`），而非猜测其是否为 switch。
- **Defense-in-depth**：多层校验相互备份。即使外层漏过，内层仍有机会拦截。

### PowerShell 特有攻击面

- **Unicode 破折号**（`pathValidation.ts:1349-1353`）：PowerShell 接受 en-dash（U+2013）、em-dash（U+2014）、horizontal-bar（U+2015）作为参数前缀。使用 AST 的 `elementType === 'Parameter'` 而非 `startsWith('-')` 判断。
- **冒号绑定语法**（如 `-Path:C:\secret`）：参数名和值在同一个 token 中，需从冒号位置分割提取。
- **NTFS 尾部空格/点号**（`gitSafety.ts:67-83`）：Windows CreateFileW 自动剥离组件尾部空格和点号，`hooks .` 等同于 `hooks`。
- **PSDrive 任意映射**（`pathValidation.ts:1135-1141`）：POSIX 上 `New-PSDrive -Name Z -Root /etc` 后 `Get-Content Z:/secrets` 会绕过路径解析。
- **Provider 限定路径**：`Microsoft.PowerShell.Core\FileSystem::/etc/passwd` 绕过简单的驱动器号检测。

### 已知限制

- **`New-Item -Name` 的跨参数解析**（`pathValidation.ts:271-283`）：`-Name` 由 PowerShell 相对于 `-Path` 解析，但本模块相对于 cwd 解析。带路径分隔符的 `-Name` 值标记为 `hasUnvalidatablePathArg`（deny→ask 降级）。
- **`Copy-Item`/`Move-Item` 的双路径**（`pathValidation.ts:263-267`）：源路径语义上是 read，但两个路径都按 write 类型校验——更严格但不完全精确。
- **通配符内符号链接**（`pathValidation.ts:1199-1207`）：`/project/*/passwd` 中如果 `link → /etc`，glob 展开后会读取 `/etc/passwd`，但静态分析无法检测这种情况。

### Git 安全的关键防护点

- `resolveEscapingPathToCwdRelative()` 是裸仓库 HEAD 攻击的**唯一防护**（`gitSafety.ts:99-104`），`path-validation` 层故意不拦截裸 `HEAD` 文件名以避免误报。
- NTFS 8.3 短名称：`.git` → `GIT~1`，已在 `matchesDotGitPrefix` 中覆盖。

### 关键代码片段

**参数分类安全模型**——未知参数触发 ask（`pathValidation.ts:1463-1486`）：
```typescript
} else {
  // Unknown parameter — we do not understand this invocation.
  hasUnvalidatablePathArg = true
  // Still extract colon-syntax value for deny-rule matching
  if (colonIdx > 0) {
    const rawValue = arg.substring(colonIdx + 1)
    if (!hasComplexColonValue(rawValue)) {
      paths.push(rawValue)
    }
  }
}
```

**NTFS 逐组件尾部剥离**（`gitSafety.ts:70-83`）：
```typescript
s = s.split('/').map(c => {
  if (c === '') return c
  let prev
  do {
    prev = c
    c = c.replace(/ +$/, '')
    if (c === '.' || c === '..') return c
    c = c.replace(/\.+$/, '')
  } while (c !== prev)
  return c || '.'
}).join('/')
```

**Git 内部路径前缀匹配**（`gitSafety.ts:89-132`）：
```typescript
const GIT_INTERNAL_PREFIXES = ['head', 'objects', 'refs', 'hooks'] as const

function matchesGitInternalPrefix(n: string): boolean {
  if (n === 'head' || n === '.git') return true
  if (n.startsWith('.git/') || /^git~\d+($|\/)/.test(n)) return true
  for (const p of GIT_INTERNAL_PREFIXES) {
    if (p === 'head') continue
    if (n === p || n.startsWith(p + '/')) return true
  }
  return false
}
```