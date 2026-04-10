# 权限框架与认证安全层（PermissionsAndAuth）

## 概述与职责

本模块是 Claude Code 的安全基石，隶属于 **Infrastructure** 层，为上层所有工具执行、文件操作和 Shell 命令提供统一的权限判定与认证管理。它由四个子系统组成：

1. **permissions/**：完整的权限模型——定义权限模式（PermissionMode）、规则解析与匹配、Bash 命令安全分类、文件系统路径校验、Auto Mode（YOLO）分类器、拒绝追踪和阴影规则检测
2. **auth\*.ts**：用户认证令牌管理，处理 OAuth、API Key、文件描述符凭证等多种认证来源
3. **secureStorage/**：跨平台安全存储抽象——macOS Keychain、纯文本文件、Fallback 策略
4. **sandbox/**：沙箱隔离适配器，将 Claude Code 设置转换为 `@anthropic-ai/sandbox-runtime` 的运行时配置

在整体架构中，CoreEngine 和 ToolSystem 在每次工具调用前都会经过本模块的权限判定流程。Services 层的 OAuth 和 API 通信依赖本模块的认证令牌管理。

---

## 关键流程

### 1. 权限判定主流程

当任何工具（Bash、文件编辑、Grep 等）被调用时，核心入口 `hasPermissionsToUseTool`（`src/utils/permissions/permissions.ts:473`）驱动以下决策链：

1. **Tool 级别检查**：通过 `getDenyRuleForTool` / `toolAlwaysAllowedRule` / `getAskRuleForTool` 检查是否存在工具级别的 deny/allow/ask 规则
2. **内容级别检查**：对于有 `ruleContent` 的规则（如 `Bash(npm install)`），使用 `getRuleByContentsForToolName` 匹配具体命令或路径
3. **模式判定**：根据当前 `PermissionMode` 决定行为：
   - `default`：需要用户确认
   - `acceptEdits`：自动允许工作目录内的文件编辑
   - `bypassPermissions`：跳过所有权限检查
   - `dontAsk`：将所有 `ask` 转为 `deny`
   - `auto`：使用 AI 分类器自动判定（见 YOLO 分类器）
   - `plan`：计划模式，只读不执行
4. **后处理**：记录拒绝追踪状态，执行 PermissionRequest hooks

### 2. 文件路径校验流程

入口函数 `validatePath`（`src/utils/permissions/pathValidation.ts:373`）对每个文件操作路径执行多层安全检查：

1. **Shell 扩展语法拦截**：拒绝包含 `$`、`%`、`=` 的路径，防止 TOCTOU 漏洞（校验时是字面量，执行时被 shell 展开为不同路径）
2. **波浪号变体拦截**：只允许 `~` 和 `~/`，拒绝 `~user`、`~+`、`~-` 等
3. **UNC 路径拦截**：阻止可能泄露凭证的 Windows 网络路径
4. **Glob 模式处理**：写操作禁止 glob，读操作验证基目录
5. **核心路径判定** `isPathAllowed`（`pathValidation.ts:141`）：
   - deny 规则优先
   - 检查内部可编辑路径（plan 文件、scratchpad、agent memory）
   - 安全性检查（危险文件/目录、Windows 特殊模式）
   - 工作目录检查（需要 acceptEdits 模式才能自动允许写入）
   - 沙箱写允许列表检查
   - allow 规则检查

### 3. Auto Mode（YOLO）分类器流程

当权限模式为 `auto` 时，`classifyYoloAction`（`src/utils/permissions/yoloClassifier.ts`）通过 AI 侧查询判定工具调用是否安全：

1. **安全工具白名单**：`classifierDecision.ts` 中 `SAFE_YOLO_ALLOWLISTED_TOOLS` 定义了无需分类器检查的只读/安全工具（Read、Grep、Glob、TodoWrite 等）
2. **构建分类器上下文**：`buildTranscriptEntries` 从对话历史提取紧凑的 transcript，`buildYoloSystemPrompt` 组装系统提示词（含用户自定义 allow/deny 规则）
3. **两阶段 XML 分类**：Stage 1 快速判断 `<block>yes/no</block>`，Stage 2 深入推理
4. **拒绝追踪与回退**：`denialTracking.ts` 跟踪连续拒绝次数（阈值 3 次）和总拒绝次数（阈值 20 次），超限后回退到用户提示

### 4. 认证令牌解析流程

`auth.ts` 中的 `getAuthTokenSource`（`src/utils/auth.ts:153`）按优先级查找认证来源：

1. `ANTHROPIC_AUTH_TOKEN` 环境变量
2. `CLAUDE_CODE_OAUTH_TOKEN` 环境变量
3. 文件描述符（`authFileDescriptor.ts`）→ FD 读取 → 磁盘回退（CCR 容器场景）
4. `apiKeyHelper`（用户配置的外部密钥获取脚本）
5. Claude AI OAuth 令牌（Keychain/纯文本存储）
6. `ANTHROPIC_API_KEY` 环境变量
7. macOS Keychain 中的 legacy API key

---

## 核心类型与接口

### PermissionMode

```typescript
// src/utils/permissions/PermissionMode.ts:42-91
type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto'
```

每种模式对应不同的安全级别和 UI 展示配置（标题、符号、颜色）。模式切换通过 `getNextPermissionMode`（`getNextPermissionMode.ts:34`）实现 Shift+Tab 循环。

### PermissionRule

```typescript
// src/types/permissions.ts（通过 PermissionRule.ts 重导出）
type PermissionRule = {
  source: PermissionRuleSource    // 规则来源：userSettings | projectSettings | localSettings | policySettings | ...
  ruleBehavior: PermissionBehavior // 'allow' | 'deny' | 'ask'
  ruleValue: PermissionRuleValue  // { toolName: string; ruleContent?: string }
}
```

### PermissionDecision

权限判定的结果是一个 discriminated union：
- `allow`：允许执行，可能附带 `updatedInput`
- `deny`：拒绝执行，附带 `message`
- `ask`：需要用户确认，附带 `suggestions`（建议的权限更新）

### PermissionUpdate

```typescript
// src/utils/permissions/PermissionUpdateSchema.ts:42-78
type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
  | { type: 'replaceRules'; ... }
  | { type: 'removeRules'; ... }
  | { type: 'setMode'; mode: ExternalPermissionMode; destination: ... }
  | { type: 'addDirectories'; directories: string[]; destination: ... }
  | { type: 'removeDirectories'; ... }
```

`destination` 决定规则持久化位置：`userSettings`（全局）、`projectSettings`（共享）、`localSettings`（gitignored）、`session`（内存）、`cliArg`。

### SecureStorage

```typescript
// src/utils/secureStorage/types.ts（推断自实现）
interface SecureStorage {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): { success: boolean; warning?: string }
  delete(): boolean
}
```

---

## 函数签名与参数说明

### `validatePath(path, cwd, toolPermissionContext, operationType)`

> `src/utils/permissions/pathValidation.ts:373-485`

文件系统路径校验入口。处理波浪号展开、Shell 扩展拦截、UNC 路径拦截、glob 模式验证，最终通过 `isPathAllowed` 判定。

- **path**：原始路径字符串
- **cwd**：当前工作目录
- **toolPermissionContext**：包含当前模式、规则集、工作目录列表
- **operationType**：`'read'` | `'write'` | `'create'`
- **返回**：`{ allowed: boolean; resolvedPath: string; decisionReason?: PermissionDecisionReason }`

### `permissionRuleValueFromString(ruleString)`

> `src/utils/permissions/permissionRuleParser.ts:93-133`

将规则字符串解析为结构化对象。格式为 `"ToolName"` 或 `"ToolName(content)"`，支持转义括号（`\(` / `\)`）。自动将旧工具名映射到新名称（如 `Task` → `Agent`）。

### `matchWildcardPattern(pattern, command, caseInsensitive?)`

> `src/utils/permissions/shellRuleMatching.ts:90-154`

Shell 规则通配符匹配。`*` 匹配任意字符序列，`\*` 匹配字面星号。特殊处理：`git *` 同时匹配 `git add` 和裸 `git`。

### `getSecureStorage()`

> `src/utils/secureStorage/index.ts:9-17`

返回当前平台的安全存储实现。macOS 使用 Keychain（带纯文本回退），其他平台使用纯文本（`~/.claude/.credentials.json`，权限 0o600）。

### `getOAuthTokenFromFileDescriptor()` / `getApiKeyFromFileDescriptor()`

> `src/utils/authFileDescriptor.ts:173-196`

CCR（Cloud Container Runtime）场景下的凭证读取。优先级：FD 管道 → 磁盘回退文件（`/home/claude/.claude/remote/.oauth_token`）。首次 FD 读取成功后会将令牌持久化到磁盘，供子进程使用。

---

## 配置项与默认值

### 权限规则来源层级

规则从多个设置源加载（`permissionsLoader.ts:120-133`），通过 `loadAllPermissionRulesFromDisk` 合并：

| 来源 | 说明 | 是否可编辑 |
|------|------|-----------|
| `policySettings` | 企业托管策略 | 否 |
| `projectSettings` | 项目 `.claude/settings.json`，提交到 git | 是 |
| `localSettings` | 项目 `.claude/settings.local.json`，gitignored | 是 |
| `userSettings` | 全局 `~/.claude/settings.json` | 是 |
| `flagSettings` | `--settings` CLI 参数 | 否 |

当 `policySettings.allowManagedPermissionRulesOnly === true` 时，仅使用托管规则。

### 拒绝追踪阈值

```typescript
// src/utils/permissions/denialTracking.ts:12-15
const DENIAL_LIMITS = {
  maxConsecutive: 3,   // 连续拒绝 3 次后回退到用户提示
  maxTotal: 20,        // 总拒绝 20 次后回退到用户提示
}
```

### 危险文件与目录

```typescript
// src/utils/permissions/filesystem.ts:57-79
const DANGEROUS_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile',
  '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.claude.json']
const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea', '.claude']
```

这些路径在 `acceptEdits` 和 `auto` 模式下不会被自动允许编辑，需要显式用户确认。

### Keychain 缓存 TTL

```typescript
// src/utils/secureStorage/macOsKeychainHelpers.ts:69
const KEYCHAIN_CACHE_TTL_MS = 30_000  // 30 秒
```

避免重复的 `security` CLI 调用（每次约 500ms），同时保持跨进程场景的数据新鲜度。

---

## 边界 Case 与注意事项

### 安全防护要点

- **TOCTOU 防护**：路径中的 Shell 扩展语法（`$HOME`、`%TEMP%`、`~user`）在校验时是字面量但在 shell 执行时会展开为不同路径，因此一律拦截（`pathValidation.ts:393-436`）
- **大小写不敏感绕过防护**：`normalizeCaseForComparison` 将路径统一转小写，防止 macOS/Windows 上通过 `.cLauDe/Settings.json` 绕过检查（`filesystem.ts:90-92`）
- **Windows 特殊模式防护**：检测 NTFS 交替数据流、8.3 短名称、DOS 设备名等可能绕过安全检查的路径模式（`filesystem.ts:490+`）
- **危险删除路径防护**：`isDangerousRemovalPath` 阻止删除根目录、home 目录、根目录直接子目录和 Windows 驱动器根目录（`pathValidation.ts:331-367`）

### Keychain 存储注意事项

- macOS Keychain `security -i` 的 stdin 有 4096 字节限制，超长凭证会静默截断导致损坏。当 payload 超限时回退到命令行参数传递（`macOsKeychainStorage.ts:24, 121-146`）
- Stale-while-error 策略：Keychain 读取失败时如果有旧缓存值则继续使用，避免单次 `security` spawn 失败导致全局"未登录"状态（`macOsKeychainStorage.ts:52-63`）
- Keychain prefetch（`keychainPrefetch.ts`）在 `main.tsx` 顶层并行启动两个 `security` 子进程，利用模块加载的 ~65ms 完成预取

### 沙箱适配

- `sandbox-adapter.ts` 将 Claude Code 的设置格式转换为 `@anthropic-ai/sandbox-runtime` 配置，包括网络域名白名单、文件系统读写限制
- 路径模式有两套约定：权限规则中 `/path` 表示相对于设置文件目录，`//path` 表示绝对路径；而 `sandbox.filesystem.*` 中 `/path` 直接表示绝对路径（`sandbox-adapter.ts:99-146`）

### 阴影规则检测

`shadowedRuleDetection.ts` 检测不可达的权限规则：当存在工具级别的 deny/ask 规则（如 `Bash` in deny list）时，更具体的 allow 规则（如 `Bash(ls:*)` in allow list）永远不会被触发。特殊例外：Bash 工具在启用沙箱自动允许时，来自个人设置的 ask 规则不会阴影 allow 规则。

### Auto Mode 危险权限剥离

进入 Auto Mode 时，`permissionSetup.ts` 中的 `isDangerousBashPermission` 会剥离允许执行任意代码的权限规则（如 `Bash(python:*)`、`Bash(node:*)`），防止绕过分类器的安全评估。被剥离的模式列表定义在 `dangerousPatterns.ts` 的 `DANGEROUS_BASH_PATTERNS` 中。