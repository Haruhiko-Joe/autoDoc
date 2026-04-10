# TypesAndSchema — SettingsJson 完整 Zod Schema 定义

## 概述与职责

本模块是 Claude Code **设置系统的类型核心**，位于 `Infrastructure > ConfigAndSettings > SettingsSystem` 层级之下。它通过 Zod v4 定义了 `settings.json` 配置文件的完整校验 Schema（约 1150 行），涵盖权限、Hooks、环境变量、MCP 服务器、模型偏好、沙箱、插件市场等所有设置字段。

**同层兄弟模块**包括：SettingsSystem（多层级设置加载与合并）、GlobalConfig（全局/项目配置读写）、EnvironmentAndCLI（环境检测）、Constants（全局常量）、BootstrapState（启动状态）、Migrations（配置迁移）。本模块被 SettingsSystem 依赖，为其提供类型定义和运行时校验能力。

文件组成：
- **`types.ts`**（~1150 行）：所有 Zod Schema 定义、TypeScript 类型导出、类型守卫函数
- **`schemaOutput.ts`**（8 行）：将 Zod Schema 转换为 JSON Schema 字符串的导出工具

## 关键设计决策

### lazySchema 延迟求值

所有 Schema 均通过 `lazySchema()` 包裹（`src/utils/lazySchema.ts:5-8`）。这是一个 memoized 工厂函数，首次调用时才构造 Zod Schema 对象，后续调用返回缓存值。

```typescript
// src/utils/lazySchema.ts:5-8
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined
  return () => (cached ??= factory())
}
```

**目的**：避免模块初始化时的循环依赖问题。由于 `types.ts` 引用了来自 `permissionValidation.ts`、`../../schemas/hooks.js`、`../plugins/schemas.js` 等多个模块的 Schema，直接在模块顶层构造可能触发循环引用。延迟求值将构造推迟到首次使用时，此时所有依赖模块已完成加载。

**使用方式**：所有导出的 Schema 都是**函数**而非值，调用方需要 `SettingsSchema()` 而非 `SettingsSchema`。

### 向后兼容策略

`SettingsSchema` 的注释（`types.ts:209-241`）明确规定了兼容性规则：

- **允许**：添加可选字段、新增枚举值、放宽验证
- **禁止**：移除字段（应标记为 deprecated）、移除枚举值、将可选改为必填
- 外层对象使用 `.passthrough()` 保留未知字段，确保旧版本写入的字段不会在新版本解析时丢失
- `strictPluginOnlyCustomization` 字段使用 `.preprocess()` + `.catch(undefined)` 实现前向兼容——未知枚举值被静默过滤，不会导致整个配置文件解析失败

### 特性门控（Feature Gating）

部分字段通过 `feature('FLAG')` 或 `process.env.USER_TYPE` 条件展开，仅在特定构建/环境下存在于 Schema 中：

| 门控条件 | 字段 | 说明 |
|---------|------|------|
| `feature('TRANSCRIPT_CLASSIFIER')` | `disableAutoMode`、`autoMode`、`skipAutoPermissionPrompt`、`useAutoModeDuringPlan` | 自动模式相关 |
| `feature('LODESTONE')` | `disableDeepLinkRegistration` | 深度链接注册 |
| `feature('PROACTIVE')` / `feature('KAIROS')` | `minSleepDurationMs`、`maxSleepDurationMs` | Sleep 工具限制 |
| `feature('VOICE_MODE')` | `voiceEnabled` | 语音模式 |
| `feature('KAIROS')` | `assistant`、`assistantName` | 助手模式 |
| `feature('KAIROS')` / `feature('KAIROS_BRIEF')` | `defaultView` | 默认视图 |
| `process.env.USER_TYPE === 'ant'` | `classifierPermissionsEnabled`、`effortLevel` 含 `max` | 内部用户专属 |
| `isEnvTruthy('CLAUDE_CODE_ENABLE_XAA')` | `xaaIdp` | XAA IdP 认证 |

这种设计确保 SDK 生成器和外部发布不会暴露内部特性字段。

## 关键流程 Walkthrough

### 设置校验流程

1. 用户编辑 `settings.json`（或管理员配置 `managed-settings.json`）
2. SettingsSystem 加载 JSON 文件后调用 `SettingsSchema()` 获取 Zod Schema 实例
3. 使用 `safeParse()` 校验 JSON 内容——校验失败的字段被忽略但保留在文件中
4. 校验通过的字段被合并到运行时配置对象中，类型为 `SettingsJson`

### JSON Schema 导出流程

`schemaOutput.ts` 提供 `generateSettingsJSONSchema()` 函数：

```typescript
// src/utils/settings/schemaOutput.ts:5-8
export function generateSettingsJSONSchema(): string {
  const jsonSchema = toJSONSchema(SettingsSchema(), { unrepresentable: 'any' })
  return jsonStringify(jsonSchema, null, 2)
}
```

将 Zod Schema 通过 `zod/v4` 的 `toJSONSchema()` 转换为标准 JSON Schema 格式字符串，用于编辑器智能提示（`$schema` 字段引用）。`unrepresentable: 'any'` 参数确保无法精确转换的类型回退为 `any` 而非报错。

## Schema 组件结构

### `EnvironmentVariablesSchema`

```typescript
// types.ts:35-37
z.record(z.string(), z.coerce.string())
```

键值对形式的环境变量，值通过 `z.coerce.string()` 自动将数字等类型转为字符串。

### `PermissionsSchema`

定义权限配置（`types.ts:42-85`），包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `allow` | `PermissionRule[]` | 允许的操作规则列表 |
| `deny` | `PermissionRule[]` | 拒绝的操作规则列表 |
| `ask` | `PermissionRule[]` | 需要确认的操作规则列表 |
| `defaultMode` | 枚举 | 默认权限模式（受特性门控影响可选值不同） |
| `disableBypassPermissionsMode` | `'disable'` | 禁用绕过权限模式 |
| `disableAutoMode` | `'disable'` | 禁用自动模式（仅 TRANSCRIPT_CLASSIFIER） |
| `additionalDirectories` | `string[]` | 额外权限范围目录 |

使用 `.passthrough()` 保留未定义的扩展字段。

### `AllowedMcpServerEntrySchema` / `DeniedMcpServerEntrySchema`

MCP 服务器允许/拒绝列表条目（`types.ts:115-207`），支持三种互斥的匹配方式：

- `serverName`：按名称匹配（正则限制为 `[a-zA-Z0-9_-]+`）
- `serverCommand`：按命令数组精确匹配（至少一个元素）
- `serverUrl`：按 URL 模式匹配（支持通配符）

通过 `.refine()` 校验确保三个字段有且仅有一个被定义（`types.ts:141-157`），使用 `count()` 工具函数计数。

### `ExtraKnownMarketplaceSchema`

额外市场源定义（`types.ts:91-109`），包含 `source`（来源）、`installLocation`（缓存路径）、`autoUpdate`（自动更新）。

### `SettingsSchema`（主 Schema）

核心 Schema，定义 `settings.json` 的完整结构（`types.ts:255-1072`）。按功能分组的主要字段：

**认证与凭证**：
- `apiKeyHelper`：认证脚本路径
- `awsCredentialExport` / `awsAuthRefresh`：AWS 凭证管理
- `gcpAuthRefresh`：GCP 认证刷新命令
- `xaaIdp`（门控）：XAA IdP OIDC 配置（issuer、clientId、callbackPort）
- `forceLoginMethod`：强制登录方式（`'claudeai'` | `'console'`）
- `forceLoginOrgUUID`：OAuth 登录组织 UUID

**模型与推理**：
- `model`：覆盖默认模型
- `availableModels`：企业模型白名单（支持别名、版本前缀、完整 ID）
- `modelOverrides`：模型 ID 映射（如 Bedrock ARN）
- `advisorModel`：顾问模型
- `effortLevel`：推理努力级别（`'low'` | `'medium'` | `'high'`，内部用户额外含 `'max'`）
- `fastMode` / `fastModePerSessionOptIn`：快速模式控制
- `alwaysThinkingEnabled`：思考模式开关

**权限与安全**：
- `permissions`：`PermissionsSchema` 嵌套
- `allowManagedPermissionRulesOnly`：仅使用托管权限规则
- `allowManagedHooksOnly`：仅使用托管 Hooks
- `allowManagedMcpServersOnly`：仅使用托管 MCP 白名单
- `disableAllHooks`：禁用所有 Hooks
- `skipDangerousModePermissionPrompt`：跳过危险模式确认
- `sandbox`：沙箱配置（引用 `SandboxSettingsSchema`）

**MCP 服务器管理**：
- `enableAllProjectMcpServers`：自动批准项目 MCP 服务器
- `enabledMcpjsonServers` / `disabledMcpjsonServers`：已批准/已拒绝的 MCP 服务器列表
- `allowedMcpServers` / `deniedMcpServers`：企业级 MCP 白名单/黑名单

**Hooks 与自定义**：
- `hooks`：引用 `HooksSchema`
- `allowedHttpHookUrls`：HTTP Hook URL 白名单
- `httpHookAllowedEnvVars`：HTTP Hook 允许的环境变量
- `statusLine`：自定义状态栏（command 类型）
- `strictPluginOnlyCustomization`：强制仅通过插件自定义（支持 `boolean` 或 surface 数组 `['skills', 'agents', 'hooks', 'mcp']`）

**插件与市场**：
- `enabledPlugins`：已启用插件（`plugin-id@marketplace-id` 格式）
- `extraKnownMarketplaces`：额外市场源（含 `.check()` 校验 key 与 source.name 一致性）
- `strictKnownMarketplaces`：企业市场白名单
- `blockedMarketplaces`：企业市场黑名单
- `pluginConfigs`：插件配置（MCP 服务器用户配置 + 选项值）
- `pluginTrustMessage`：自定义插件信任提示

**UI 与体验**：
- `outputStyle`：输出样式
- `language`：首选语言
- `spinnerTipsEnabled` / `spinnerVerbs` / `spinnerTipsOverride`：加载动画自定义
- `syntaxHighlightingDisabled`：禁用语法高亮
- `prefersReducedMotion`：减少动画
- `promptSuggestionEnabled`：提示建议开关
- `showClearContextOnPlanAccept`：计划审批时显示清除上下文选项
- `showThinkingSummaries`：显示思考摘要
- `terminalTitleFromRename`：`/rename` 是否更新终端标题

**环境与会话**：
- `env`：`EnvironmentVariablesSchema` 嵌套
- `cleanupPeriodDays`：聊天记录保留天数（0 = 禁用持久化）
- `defaultShell`：默认 Shell（`'bash'` | `'powershell'`）
- `remote`：远程会话配置（`defaultEnvironmentId`）
- `worktree`：Git worktree 配置（`symlinkDirectories`、`sparsePaths`）
- `sshConfigs`：SSH 连接预配置（id、name、sshHost、sshPort 等）
- `plansDirectory`：自定义计划文件目录

**归因与 Git**：
- `attribution`：提交和 PR 归因文本自定义
- `includeCoAuthoredBy`（deprecated）：是否包含 co-authored-by
- `includeGitInstructions`：系否包含 Git 工作流指令

**记忆系统**：
- `autoMemoryEnabled`：自动记忆开关
- `autoMemoryDirectory`：自定义记忆目录
- `autoDreamEnabled`：后台记忆整合

**其他**：
- `$schema`：JSON Schema 引用 URL
- `fileSuggestion`：自定义文件建议（@ 提及）
- `respectGitignore`：文件选择器是否遵循 .gitignore
- `otelHeadersHelper`：OpenTelemetry Headers 脚本
- `skipWebFetchPreflight`：跳过 WebFetch 预检
- `feedbackSurveyRate`：反馈调查概率
- `autoUpdatesChannel`：自动更新渠道
- `minimumVersion`：最低版本限制
- `companyAnnouncements`：企业公告
- `channelsEnabled` / `allowedChannelPlugins`：频道通知
- `claudeMdExcludes`：CLAUDE.md 排除模式
- `agent`：主线程 Agent 名称
- `disableAutoMode`：禁用自动模式

## 类型导出

### 推断类型

```typescript
// types.ts:1098-1104
export type AllowedMcpServerEntry = z.infer<ReturnType<typeof AllowedMcpServerEntrySchema>>
export type DeniedMcpServerEntry = z.infer<ReturnType<typeof DeniedMcpServerEntrySchema>>
export type SettingsJson = z.infer<ReturnType<typeof SettingsSchema>>
```

由于使用 `lazySchema`，类型推断需要 `ReturnType<typeof Schema>` 来获取 Zod 类型实例。

### 类型守卫函数

三个类型守卫用于区分 MCP 服务器条目的匹配类型（`types.ts:1109-1131`）：

- `isMcpServerNameEntry(entry)` → `{ serverName: string }`
- `isMcpServerCommandEntry(entry)` → `{ serverCommand: string[] }`
- `isMcpServerUrlEntry(entry)` → `{ serverUrl: string }`

### 内部类型（非 Schema）

- **`PluginHookMatcher`**（`types.ts:1079-1085`）：插件 Hook 上下文，包含 `pluginRoot`、`pluginName`、`pluginId`
- **`SkillHookMatcher`**（`types.ts:1091-1096`）：技能 Hook 上下文，包含 `skillRoot`、`skillName`
- **`UserConfigValues`**（`types.ts:1136-1139`）：MCP 服务器用户配置值类型
- **`PluginConfig`**（`types.ts:1144-1148`）：插件配置存储类型

### Re-export（向后兼容）

从 `../../schemas/hooks.js` 重新导出以下类型和 Schema（`types.ts:14-26`），保持旧有导入路径可用：

- 类型：`AgentHook`、`BashCommandHook`、`HookCommand`、`HookMatcher`、`HooksSettings`、`HttpHook`、`PromptHook`
- Schema：`HookCommandSchema`、`HookMatcherSchema`、`HooksSchema`

### `CUSTOMIZATION_SURFACES` 常量

```typescript
// types.ts:248-253
export const CUSTOMIZATION_SURFACES = ['skills', 'agents', 'hooks', 'mcp'] as const
```

可被 `strictPluginOnlyCustomization` 锁定的自定义表面列表。同时被 `pluginOnlyPolicy.ts` 运行时使用，确保单一数据源。

## 边界 Case 与注意事项

1. **`.passthrough()` 的作用**：`PermissionsSchema` 和顶层 `SettingsSchema` 都使用了 `.passthrough()`，这意味着未在 Schema 中声明的字段在解析时不会被丢弃。这对向后兼容至关重要——新版本添加的字段不会在旧版本客户端中被删除。

2. **`strictPluginOnlyCustomization` 的防御性设计**：`.preprocess()` 过滤未知枚举值 + `.catch(undefined)` 捕获非法类型，确保单个字段的解析失败不会导致整个 managed-settings 文件失效（`types.ts:519-548`）。

3. **`extraKnownMarketplaces` 的 key 一致性校验**：通过 `.check()` 验证 `settings` 类型市场源的 key 必须等于 `source.name`，否则会导致市场对账循环无法收敛（`types.ts:571-596`）。

4. **`autoMemoryDirectory` 的安全限制**：注释说明该字段在 `projectSettings`（即项目级 `.claude/settings.json`）中设置时会被忽略，防止项目配置将记忆写入任意路径。

5. **环境变量的 `z.coerce.string()`**：`EnvironmentVariablesSchema` 使用 coerce 而非 strict string，允许数值类型的环境变量自动转为字符串（如 `PORT: 3000` → `"3000"`）。

6. **MCP 服务器的 deny 优先**：当同一服务器同时出现在 `allowedMcpServers` 和 `deniedMcpServers` 中时，deny 列表优先。