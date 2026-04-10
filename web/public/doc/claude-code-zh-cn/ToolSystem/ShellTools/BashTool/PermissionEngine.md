# 权限规则匹配引擎（PermissionEngine）

## 概述与职责

权限规则匹配引擎是 BashTool 的核心安全组件，负责在 Shell 命令执行前完成多层权限判定。它位于 ToolSystem → ShellTools → BashTool 层级中，是 Claude Code 最大的单文件模块之一（`bashPermissions.ts` 约 2621 行）。

该引擎回答一个核心问题：**给定一条 Bash 命令和当前权限上下文，应该允许（allow）、拒绝（deny）还是询问用户（ask）？**

同级模块 `modeValidation.ts`（115 行）处理特定权限模式下的自动放行逻辑（如 `acceptEdits` 模式自动允许文件操作命令）。

兄弟模块包括 `bashSecurity`（命令注入防御）、`pathValidation`（路径安全校验）、`readOnlyValidation`（只读命令白名单）、`sedValidation`（sed 命令校验）等，PermissionEngine 在判定流程中会协调调用这些模块。

## 关键流程

### 主权限判定流程（`bashToolHasPermission`）

这是整个引擎的入口函数（`bashPermissions.ts:1663-2557`），执行一条多层级的权限判定管道：

1. **AST 安全解析**：调用 `parseCommandRaw()` 使用 tree-sitter 解析命令为 AST。解析结果分三种：
   - `simple`：干净的 `SimpleCommand[]`，无隐藏替换
   - `too-complex`：包含命令替换、扩展等无法静态分析的结构 → 直接走 ask
   - `parse-unavailable`：tree-sitter 不可用 → 回退到旧版 shell-quote 路径

2. **沙箱自动放行检查**：如果沙箱和 `autoAllowBashIfSandboxed` 均已启用，调用 `checkSandboxAutoAllow()` — 无显式 deny/ask 规则时自动 allow

3. **精确匹配检查**：调用 `bashToolCheckExactMatchPermission()` 检查完整命令是否有精确匹配的 deny/ask/allow 规则

4. **分类器检查**（Classifier）：如果启用了 `BASH_CLASSIFIER` 特性，并行调用 Haiku 模型对命令进行语义级 deny/ask 分类

5. **管道/操作符处理**：调用 `checkCommandOperatorPermissions()` 处理 `|`、`>`、`&&` 等操作符

6. **旧版注入检测**：tree-sitter 不可用时，调用 `bashCommandIsSafeAsync()` 进行正则级安全检查

7. **子命令拆分与逐一校验**：将复合命令拆分为子命令（优先使用 AST 结果，回退到 `splitCommand_DEPRECATED`），对每个子命令调用 `bashToolCheckPermission()` 进行规则匹配 + 路径校验

8. **聚合结果**：任一子命令被 deny → 整体 deny；任一需要 ask → 整体 ask（附带规则建议）；全部 allow → 整体 allow

### 单子命令权限检查（`bashToolCheckPermission`）

`bashPermissions.ts:1050-1178` 实现了单个子命令的完整权限判定链：

1. 精确匹配规则（deny > ask > allow）
2. 前缀/通配符规则匹配（deny > ask）
3. 路径约束检查（`checkPathConstraints`）
4. 精确匹配 allow 返回
5. 前缀匹配 allow 返回
6. sed 约束检查（`checkSedConstraints`）
7. 模式校验（`checkPermissionMode`）
8. 只读命令自动放行（`BashTool.isReadOnly`）
9. 兜底 passthrough → 触发用户确认提示

### 规则匹配流程（`filterRulesByContentsMatchingInput`）

`bashPermissions.ts:778-935` 是规则匹配的核心逻辑：

1. **剥离输出重定向**：`python script.py > output.txt` → `python script.py` 进行匹配
2. **剥离安全包装器**：`timeout 10 npm install foo` → `npm install foo`
3. **剥离安全环境变量**：`NODE_ENV=prod npm run build` → `npm run build`
4. **Deny/Ask 规则的增强剥离**：迭代剥离所有环境变量（不限于安全列表），防止 `FOO=bar denied_command` 绕过 deny 规则
5. **规则类型匹配**：
   - `exact`：完全字符串相等
   - `prefix`：命令以规则前缀开头（含词边界检查，防止 `ls:*` 匹配 `lsof`）
   - `wildcard`：正则通配符匹配
6. **复合命令安全门**：前缀/通配符规则不匹配复合命令（防止 `cd:*` 匹配 `cd /path && python3 evil.py`）

## 函数签名与参数说明

### `bashToolHasPermission(input, context, getCommandSubcommandPrefixFn?): Promise<PermissionResult>`

主入口函数。

- **input**：`{ command: string }` — 待检查的 Bash 命令
- **context**：`ToolUseContext` — 包含 `getAppState()`、`abortController`、`options` 等执行上下文
- **getCommandSubcommandPrefixFn**：可选的前缀提取函数（测试注入用），默认使用 `getCommandSubcommandPrefix`
- **返回值**：`PermissionResult`，`behavior` 为 `'allow' | 'deny' | 'ask' | 'passthrough'`

> 源码位置：`bashPermissions.ts:1663-2557`

### `bashToolCheckPermission(input, toolPermissionContext, compoundCommandHasCd?, astCommand?): PermissionResult`

单子命令权限检查。

- **compoundCommandHasCd**：是否属于包含 `cd` 的复合命令（影响路径校验策略）
- **astCommand**：AST 解析出的 `SimpleCommand`（可用于精确路径校验）

> 源码位置：`bashPermissions.ts:1050-1178`

### `bashToolCheckExactMatchPermission(input, toolPermissionContext): PermissionResult`

精确匹配权限检查，按 deny > ask > allow > passthrough 优先级返回。

> 源码位置：`bashPermissions.ts:991-1048`

### `checkCommandAndSuggestRules(input, toolPermissionContext, commandPrefixResult, compoundCommandHasCd?, astParseSucceeded?): Promise<PermissionResult>`

在权限检查的基础上生成规则建议（供 UI 展示"允许此类命令"选项）。

> 源码位置：`bashPermissions.ts:1183-1255`

### `stripSafeWrappers(command: string): string`

从命令中剥离安全包装器（`timeout`、`time`、`nice`、`nohup`、`stdbuf`）和安全环境变量前缀。分两阶段执行：先剥离环境变量，再剥离包装器命令。

> 源码位置：`bashPermissions.ts:524-615`

### `stripAllLeadingEnvVars(command: string, blocklist?: RegExp): string`

激进地剥离所有前导环境变量（不限于安全列表），用于 deny/ask 规则匹配，防止通过任意环境变量前缀绕过拒绝规则。

> 源码位置：`bashPermissions.ts:733-776`

### `checkPermissionMode(input, toolPermissionContext): PermissionResult`

`modeValidation.ts:72-109` 的主入口。检查当前权限模式是否需要特殊处理：
- `bypassPermissions` / `dontAsk` 模式：返回 `passthrough`（由主流程处理）
- `acceptEdits` 模式：自动允许 `mkdir`、`touch`、`rm`、`rmdir`、`mv`、`cp`、`sed` 命令
- 将复合命令拆分后逐一检查，任一子命令触发模式特殊行为即返回

### `getAutoAllowedCommands(mode): readonly string[]`

返回指定模式下自动允许的命令列表。`acceptEdits` 模式返回 7 个文件操作命令，其他模式返回空数组。

> 源码位置：`modeValidation.ts:111-115`

## 接口/类型定义

### `PermissionResult`

权限判定结果（来自 `../../utils/permissions/PermissionResult.js`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| behavior | `'allow' \| 'deny' \| 'ask' \| 'passthrough'` | 权限决策 |
| message | `string?` | 展示给用户的消息 |
| updatedInput | `object?` | allow 时返回（可能修改过的）输入 |
| decisionReason | `PermissionDecisionReason?` | 决策原因（rule / classifier / mode / other） |
| suggestions | `PermissionUpdate[]?` | 规则建议（UI 显示"允许此类命令"） |
| pendingClassifierCheck | `PendingClassifierCheck?` | 待执行的分类器检查元数据 |

### `ShellPermissionRule`

解析后的权限规则结构体，三种类型：
- `{ type: 'exact', command: string }` — 精确匹配
- `{ type: 'prefix', prefix: string }` — 前缀匹配（如 `npm run:*`）
- `{ type: 'wildcard', pattern: string }` — 通配符匹配（如 `git * --dry-run`）

## 配置项与默认值

### 安全环境变量白名单（`SAFE_ENV_VARS`）

定义了约 30 个可安全剥离的环境变量（`bashPermissions.ts:378-430`），分类包括：
- **Go**：`GOOS`、`GOARCH`、`CGO_ENABLED` 等
- **Rust**：`RUST_BACKTRACE`、`RUST_LOG`
- **Node**：`NODE_ENV`（注意 **不含** `NODE_OPTIONS`）
- **Python**：`PYTHONUNBUFFERED`、`PYTHONDONTWRITEBYTECODE`
- **Locale/Terminal**：`LANG`、`TERM`、`NO_COLOR` 等

**安全约束**：`PATH`、`LD_PRELOAD`、`PYTHONPATH`、`NODE_OPTIONS`、`HOME` 等影响执行或库加载的变量**绝不**可加入此白名单。

### ANT-ONLY 环境变量（`ANT_ONLY_SAFE_ENV_VARS`）

仅在 `USER_TYPE === 'ant'` 时生效的约 25 个内部变量（`bashPermissions.ts:447-497`），包括 `KUBECONFIG`、`DOCKER_HOST`、`AWS_PROFILE` 等。

### 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK` | 50 | 子命令数量上限，超过则直接 ask（防止 CPU 耗尽） |
| `MAX_SUGGESTED_RULES_FOR_COMPOUND` | 5 | 复合命令最大规则建议数 |
| `BARE_SHELL_PREFIXES` | 含 sh/bash/env/sudo 等 | 禁止生成前缀规则的命令（防止 `bash:*` 等于 `*`） |

### acceptEdits 模式自动允许命令

`modeValidation.ts:7-15` 定义了 7 个命令：`mkdir`、`touch`、`rm`、`rmdir`、`mv`、`cp`、`sed`。

## 边界 Case 与注意事项

### 安全包装器剥离的两阶段设计

`stripSafeWrappers` 分两阶段执行（`bashPermissions.ts:580-612`）：
- **Phase 1**：仅剥离环境变量（`VAR=val cmd` 中 VAR 是 shell 级赋值）
- **Phase 2**：仅剥离包装器命令（`timeout`/`nice` 等使用 `execvp` 执行参数，其后的 `VAR=val` 是命令名而非赋值）

这种分离源于 HackerOne #3543050 报告：包装器后的环境变量不应被剥离。

### Deny 规则的增强匹配

Allow 规则只剥离安全白名单内的环境变量（防止 `DOCKER_HOST=evil docker ps` 匹配 `docker ps:*`），但 Deny/Ask 规则会剥离**所有**环境变量（`bashPermissions.ts:810-853`），通过迭代定点算法处理交错的包装器和变量（如 `nohup FOO=bar timeout 5 claude`）。

### 复合命令与 cd+git 安全门

- 前缀/通配符规则**不匹配**复合命令（防止 `cd:*` 匹配 `cd /path && python3 evil.py`）
- 包含 `cd` + `git` 的复合命令强制 ask（防止通过 `cd /malicious/dir && git status` 触发恶意裸仓库的 `core.fsmonitor`）（`bashPermissions.ts:2202-2225`）

### Tree-sitter 影子模式

当 `TREE_SITTER_BASH_SHADOW` 特性开启时（`bashPermissions.ts:1707-1739`），tree-sitter 的解析结果仅用于遥测对比，实际权限判定仍走旧版路径。这是渐进迁移策略。

### 分类器投机执行

`startSpeculativeClassifierCheck`（`bashPermissions.ts:1497-1527`）允许在权限对话框显示之前就开始分类器调用，与 pre-tool hooks 和 deny/ask 分类器并行执行。如果分类器以 high confidence 匹配 allow 描述，可在用户交互前自动批准。

### Bun DCE 复杂度限制

代码中多处注释提到 Bun 的 `feature()` 求值器有每函数复杂度预算（`bashPermissions.ts:81-89`）。`bashToolHasPermission` 接近该限制，因此将多个辅助逻辑（`filterCdCwdSubcommands`、`checkEarlyExitDeny`、`checkSemanticsDeny`、`skipTimeoutFlags`）提取为独立函数以保持在阈值内。

## 关键代码片段

### 规则匹配优先级链

```typescript
// bashPermissions.ts:999-1047
// 1. Deny if exact command was denied
if (matchingDenyRules[0] !== undefined) {
  return { behavior: 'deny', ... }
}
// 2. Ask if exact command was in ask rules
if (matchingAskRules[0] !== undefined) {
  return { behavior: 'ask', ... }
}
// 3. Allow if exact command was allowed
if (matchingAllowRules[0] !== undefined) {
  return { behavior: 'allow', ... }
}
// 4. Otherwise, passthrough
```

### 安全包装器剥离模式

```typescript
// bashPermissions.ts:532-560
const SAFE_WRAPPER_PATTERNS = [
  /^timeout[ \t]+(?:...)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
  /^time[ \t]+(?:--[ \t]+)?/,
  /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
  /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
  /^nohup[ \t]+(?:--[ \t]+)?/,
]
```

注意所有模式使用 `[ \t]+` 而非 `\s+`——`\s` 匹配换行符，而换行在 bash 中是命令分隔符，跨行匹配会导致安全漏洞。

### acceptEdits 模式判定

```typescript
// modeValidation.ts:38-49
if (
  toolPermissionContext.mode === 'acceptEdits' &&
  isFilesystemCommand(baseCmd)
) {
  return {
    behavior: 'allow',
    updatedInput: { command: cmd },
    decisionReason: { type: 'mode', mode: 'acceptEdits' },
  }
}
```