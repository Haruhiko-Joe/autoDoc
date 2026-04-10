# PermissionSystem — cmdlet 级权限匹配与模式校验

## 概述与职责

PermissionSystem 是 PowerShellTool 的**权限判定核心**，负责对每一条 PowerShell 命令做出 `allow`、`deny` 或 `ask`（需用户确认）的最终决策。它位于 ToolSystem → ShellTools → PowerShellTool 层级下，与兄弟模块 BashTool 并列，为 Windows PowerShell 命令提供与 BashTool 等价的安全防护。

该模块由两个文件组成：

- **`powershellPermissions.ts`**（1648 行）：权限判定的主协调器，编排所有安全检查并输出最终决策
- **`modeValidation.ts`**（404 行）：处理 `acceptEdits` 模式下文件修改 cmdlet 的自动放行逻辑

两者协同工作：`powershellPermissions.ts` 在决策流程的适当阶段调用 `modeValidation.ts` 的 `checkPermissionMode`，将其结果纳入 collect-then-reduce 决策框架。

## 关键流程

### 主权限判定流程（`powershellToolHasPermission`）

这是整个模块的入口函数（`powershellPermissions.ts:639-1648`），接收 PowerShell 命令和工具上下文，返回 `PermissionResult`。完整流程如下：

**阶段 1：预解析规则匹配**（解析前，确保即使 pwsh 不可用也能生效）

1. **空命令短路**：空命令直接 `allow`
2. **解析命令**：调用 `parsePowerShellCommand` 获取 AST
3. **精确匹配 deny 规则**：命令全文匹配用户配置的 deny 规则，命中则立即拒绝
4. **前缀/通配符 deny 规则**：按前缀和通配符模式匹配 deny 规则
5. **延迟 ask 收集**：前缀 ask 规则和 UNC 路径检测产生的 ask 决策**不再立即返回**，而是暂存到 `preParseAskDecision`，等待后续 deny 检查完成

**阶段 2：解析失败的降级处理**（`powershellPermissions.ts:764-874`）

当 AST 解析失败（pwsh 不可用、命令过长、语法错误）时：
- 对原始命令文本按 PowerShell 分隔符（`;`、`|`、`\n`、`{}`、`()`、`&`）拆分为片段
- 每个片段规范化后（剥离赋值前缀 `$x = `、调用操作符 `& `、反引号转义）重新匹配 deny 规则
- 对 `Remove-Item` 片段额外做危险路径检测（`/`、`~`、系统目录）
- 最终返回暂存的 ask 或通用解析错误 ask

**阶段 3：Collect-Then-Reduce 决策收集**（`powershellPermissions.ts:877-1368`）

这是核心架构创新——所有后续检查的结果推入同一个 `decisions[]` 数组，最终由优先级规约（deny > ask > allow > passthrough）产生唯一决策。这从结构上消除了"早期 ask 遮蔽后续 deny"的 bug 类别。

收集的决策来源包括：

| 步骤 | 检查内容 | 可能决策 |
|------|----------|----------|
| 延迟 pre-parse ask | 前缀 ask 规则、UNC 路径 | ask |
| 安全检查 | `powershellCommandIsSafe()`：子表达式、脚本块、编码命令、下载摇篮等 | ask |
| using/Requires | `using module`、`#Requires -Modules` 加载外部代码 | ask |
| Provider/UNC 扫描 | `env:`、`HKLM:`、`function:` 等非文件系统 Provider 路径；解析后 UNC 路径 | ask |
| 子命令 deny/ask | 对每个子命令独立匹配规则（原始文本 + AST 规范化文本双重匹配） | deny / ask |
| cd+git 复合守卫 | `Set-Location` + `git` 组合防止裸仓库攻击 | ask |
| 裸 Git 仓库检测 | cwd 包含 HEAD/objects/refs/ 但无 .git/HEAD | ask |
| Git 内部路径写入 | 写入 hooks/、refs/、.git/ 等 Git 内部路径 | ask |
| 归档+git TOCTOU | tar/7z 解压 + git：归档内容不透明，可能植入 hooks | ask |
| .git/ 写入 | 任何写入 .git/ 的操作（即使无 git 子命令） | ask |
| 路径约束检查 | `checkPathConstraints()`：工作目录限制、危险删除 | deny / ask |
| 精确 allow 规则 | 用户精确 allow 规则（带 nameType 和 argLeaksValue 守卫） | allow |
| 只读白名单 | `isReadOnlyCommand()`：Get-Process、Get-ChildItem 等 | allow |
| 文件重定向 | `>`、`>>`、`2>` 写入任意路径 | ask |
| acceptEdits 模式 | `checkPermissionMode()`：文件修改 cmdlet 自动放行 | allow |

**规约逻辑**（`powershellPermissions.ts:1357-1368`）：
```
deny（任何一个 deny 即拒绝）> ask（任何一个 ask 即需确认）> allow > passthrough
```

**阶段 4：子命令逐一审批**（`powershellPermissions.ts:1370-1647`）

如果 collect-then-reduce 无决策产出，进入精细的子命令审批：
1. 过滤安全输出 cmdlet（`Out-Null`、`Format-Table` 等）和 cd-to-CWD
2. 对每个子命令调用 `powershellToolCheckPermission()` 递归检查
3. 通过白名单的命令跳过（需满足 `isProvablySafeStatement` + `isAllowlistedCommand` + 无 cd/symlink 复合）
4. 未通过的命令尝试 `checkPermissionMode` 单语句 acceptEdits 放行
5. 剩余命令加入待审批列表
6. **fail-closed 守卫**：未被循环处理的 statement 自动加入待审批（防止空 CommandAst 的 statement 静默通过）

### 规则匹配流程（`filterRulesByContentsMatchingInput`）

规则匹配是权限系统的基础能力（`powershellPermissions.ts:170-333`），支持三种规则类型和大小写不敏感匹配：

1. **精确规则（exact）**：命令全文匹配
2. **前缀规则（prefix）**：命令以规则前缀开头（`Get-Process:*` 匹配 `Get-Process | Stop-Process`）
3. **通配符规则（wildcard）**：通过 `matchWildcardPattern` 执行通配符匹配

**规范化匹配**：每条输入命令会生成一个 canonical 版本（别名 → 标准 cmdlet 名），然后同时对原始命令和规范化命令匹配规则。例如：
- deny 规则 `Remove-Item:*` 也会阻止 `rm`、`del`、`ri`（通过 `resolveToCanonical`）
- deny 规则 `rm:*` 也会阻止 `Remove-Item`（反向规范化）

**安全不对称处理**（`powershellPermissions.ts:189-194`）：
- deny/ask 规则的 `stripModulePrefix` 是宽松的（`Module\Remove-Item` → `Remove-Item`），因为过度匹配是安全的
- allow 规则**不做** `stripModulePrefix`，防止 `ModuleA\Get-Thing` 的 allow 规则意外放行 `ModuleB\Get-Thing`

### acceptEdits 模式校验流程（`checkPermissionMode`）

`modeValidation.ts:132-404` 中的 `checkPermissionMode` 在 `acceptEdits` 模式下自动放行简单的文件修改 cmdlet：

1. **模式过滤**：仅处理 `acceptEdits` 模式，`bypassPermissions` 和 `dontAsk` 由主流程处理
2. **解析有效性**：未成功解析的命令不自动放行
3. **安全标志检查**（`deriveSecurityFlags`）：包含以下任一模式的命令不自动放行：
   - 子表达式 `$()` / 脚本块 `{}` / 成员调用 `.Method()` / Splatting `@var` / 赋值 `$x = ` / `---%` 停止解析 / 可展开字符串 `"$var"`
4. **复合命令守卫**：
   - **cd 去同步守卫**：`Set-Location` + 写操作组合拒绝自动放行（路径验证使用旧 cwd）
   - **符号链接守卫**：`New-Item -ItemType SymbolicLink` + 任何后续命令拒绝自动放行
5. **逐命令验证**：
   - 非 `CommandAst` 元素（表达式管道源）→ 不放行
   - `nameType === 'application'`（路径名，实际执行脚本）→ 不放行
   - 非 `StringConstant`/`Parameter` 的参数类型（变量、哈希表等）→ 不放行
   - 冒号绑定参数含表达式元字符（`-Path:$(...)` ）→ 不放行
   - 安全输出 cmdlet（`Out-Null` 等）和白名单管道尾部 → 跳过
   - 不在 `ACCEPT_EDITS_ALLOWED_CMDLETS` 中 → 不放行
   - `argLeaksValue` 检测到不可验证的参数 → 不放行
6. 所有检查通过 → 返回 `allow`

## 函数签名与参数说明

### `powershellToolHasPermission(input, context): Promise<PermissionResult>`

主入口。编排完整的权限判定流程。

- **input.command** (`string`)：PowerShell 命令文本
- **input.timeout** (`number`, 可选)：命令超时
- **context** (`ToolUseContext`)：包含 `getAppState().toolPermissionContext`（权限模式和规则）
- **返回**：`PermissionResult`，`behavior` 为 `'allow'` | `'deny'` | `'ask'` | `'passthrough'`

> 源码位置：`src/tools/PowerShellTool/powershellPermissions.ts:639-1648`

### `powershellToolCheckPermission(input, toolPermissionContext): PermissionResult`

纯规则匹配（精确 + 前缀 + 通配符），不含安全检查。被主流程和子命令递归调用。

> 源码位置：`src/tools/PowerShellTool/powershellPermissions.ts:435-514`

### `powershellToolCheckExactMatchPermission(input, toolPermissionContext): PermissionResult`

仅精确匹配规则。优先级：deny > ask > allow > passthrough。

> 源码位置：`src/tools/PowerShellTool/powershellPermissions.ts:385-430`

### `checkPermissionMode(input, parsed, toolPermissionContext): PermissionResult`

acceptEdits 模式的自动放行判定。仅返回 `'allow'` 或 `'passthrough'`。

> 源码位置：`src/tools/PowerShellTool/modeValidation.ts:132-404`

### `isSymlinkCreatingCommand(cmd): boolean`

检测 `New-Item -ItemType SymbolicLink/Junction/HardLink` 命令。处理参数缩写（`-it`、`-ty`）、Unicode 破折号前缀、冒号绑定值、反引号转义。

> 源码位置：`src/tools/PowerShellTool/modeValidation.ts:82-117`

### `powershellPermissionRule(permissionRule): ShellPermissionRule`

解析权限规则字符串为结构化对象（委托给共享的 `parsePermissionRule`）。

> 源码位置：`src/tools/PowerShellTool/powershellPermissions.ts:132-136`

## 类型定义

### `PowerShellInput`

```typescript
type PowerShellInput = {
  command: string
  timeout?: number
}
```

### `SubCommandInfo`

```typescript
type SubCommandInfo = {
  text: string                    // 子命令原始文本
  element: ParsedCommandElement   // AST 解析元素（name, args, elementType, nameType）
  statement: ParsedPowerShellCommand['statements'][number] | null
  isSafeOutput: boolean           // 是否为安全输出 cmdlet（Out-Null 等）
}
```

### `PermissionResult`（外部定义，此模块产出）

```typescript
{
  behavior: 'allow' | 'deny' | 'ask' | 'passthrough'
  message?: string
  updatedInput?: PowerShellInput
  decisionReason?: PermissionDecisionReason
  suggestions?: PermissionUpdate[]
}
```

## 配置项与默认值

### `GIT_SAFETY_WRITE_CMDLETS`

可向指定路径写入文件的 cmdlet 集合，用于 Git 内部路径守卫检查：
`new-item`、`set-content`、`add-content`、`out-file`、`copy-item`、`move-item`、`rename-item`、`expand-archive`、`invoke-webrequest`、`invoke-restmethod`、`tee-object`、`export-csv`、`export-clixml`

> 源码位置：`src/tools/PowerShellTool/powershellPermissions.ts:70-84`

### `GIT_SAFETY_ARCHIVE_EXTRACTORS`

归档解压工具集合（tar、unzip、7z 等），与 git 组合时触发 TOCTOU 防护。

> 源码位置：`src/tools/PowerShellTool/powershellPermissions.ts:96-112`

### `ACCEPT_EDITS_ALLOWED_CMDLETS`

acceptEdits 模式下可自动放行的文件修改 cmdlet（仅 Tier 1/2 简单写入）：
`set-content`、`add-content`、`remove-item`、`clear-content`

Tier 3 cmdlet（`new-item`、`copy-item`、`move-item` 等）因参数绑定复杂而排除，降级为 ask。

> 源码位置：`src/tools/PowerShellTool/modeValidation.ts:33-38`

### `LINK_ITEM_TYPES`

触发符号链接守卫的 New-Item -ItemType 值：`symboliclink`、`junction`、`hardlink`

> 源码位置：`src/tools/PowerShellTool/modeValidation.ts:56`

## 边界 Case 与注意事项

### Collect-Then-Reduce 架构

该模块从 BashTool 移植了 collect-then-reduce 模式（`powershellPermissions.ts:877-896`）。之前的顺序 early-return 架构存在"ask 遮蔽 deny"的 bug 类别——例如 `Get-Process; Invoke-Expression evil` 在 `Get-Process` 匹配 ask 规则后立即返回，`Invoke-Expression` 的 deny 规则永远不会触发。新架构将所有决策收集后统一规约，从结构上杜绝此问题。

### 大小写不敏感匹配

所有 cmdlet 匹配全程使用 `.toLowerCase()` 比较（`powershellPermissions.ts:178-183`），与 PowerShell 的大小写不敏感行为一致。

### 别名与模块前缀规范化

- `rm` → `remove-item`、`ac` → `add-content`、`iex` → `invoke-expression` 等通过 `resolveToCanonical` 双向解析
- 模块前缀 `Microsoft.PowerShell.Management\Remove-Item` 通过 `stripModulePrefix` 处理
- **allow 规则不做模块前缀剥离**，避免跨模块意外放行

### nameType 守卫（六处部署）

当命令名包含路径字符（`.`、`\`、`/`）时，`nameType` 被分类为 `'application'`，表示实际执行的是脚本/可执行文件而非 cmdlet。该守卫在六个位置部署（精确 allow 短路、acceptEdits 检查、子命令 allow 规则、安全输出过滤、白名单入口、fail-closed 门），防止 `scripts\Get-Content` 绕过 `Get-Content:*` 的 allow 规则执行本地脚本。

### argLeaksValue 守卫

阻止通过变量展开泄露敏感数据。即使用户配置了 `Write-Output:*` 的 allow 规则，`Write-Output $env:ANTHROPIC_API_KEY` 仍会触发 ask，因为 `argLeaksValue` 检测到 Variable 类型的参数元素。此守卫同时应用于用户 allow 规则路径和内置白名单路径。

### 解析失败的降级策略

当 PowerShell 解析器不可用（pwsh 未安装）或命令超长时，系统降级为文本拆分 + 正则匹配。降级模式下：
- deny 规则仍然生效（通过片段扫描）
- 精确 allow 规则在无 ask 待定且非 application 类型时仍可短路
- 其他情况一律 ask——宁可多问不可放过

### TOCTOU 防护

多处防护时间检查-时间使用（TOCTOU）攻击：
- **cd 去同步**：`Set-Location + 写操作` 组合中路径验证用旧 cwd，运行时用新 cwd
- **符号链接去同步**：`New-Item -ItemType SymbolicLink + 读/写操作` 通过刚创建的链接绕过路径验证
- **归档 + git**：`tar -xf + git status` 中归档可能植入裸仓库标记，但检查在解压前执行

### 权限建议（Suggestions）

当命令需要审批时，系统生成 `PermissionUpdate[]` 建议供用户快速添加规则。但以下命令不生成精确建议（`powershellPermissions.ts:150-155`）：
- 多行命令（换行符无法在规则字符串中保留）
- 含 `*` 的命令（字面 `*` 会被重新解析为通配符规则，创建死规则）