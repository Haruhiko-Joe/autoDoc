# 插件策略执行、启动检查与辅助工具

## 概述与职责

本模块是插件子系统（Plugins）中的**策略执行、启动编排和辅助工具**集合，位于 `Infrastructure > FeatureUtilities > Plugins` 层级下。它不涉及插件的加载、解析或 UI 渲染，而是为插件系统提供以下横切关注点：

- **策略强制**：检查组织级策略是否禁用特定插件（`pluginPolicy`）、提取策略锁定的插件列表（`managedPlugins`）
- **启动编排**：在应用启动时检测缺失插件并触发后台安装（`pluginStartupCheck` + `performStartupChecks`）
- **外部目录支持**：从 `--add-dir` 指定的额外目录读取插件设置（`addDirPluginSettings`）
- **插件推荐**：通过 CLI 工具的 `<claude-code-hint/>` 标签（`hintRecommendation`）和 LSP 诊断（`lspRecommendation`）推荐用户安装插件
- **网络遥测**：记录插件/市场的网络请求遥测数据（`fetchTelemetry`）
- **Git 可用性**：提供 memoized 的 Git 命令检测（`gitAvailability`）

同级兄弟模块包括插件加载器、市场管理器、安装版本控制、黑名单管理等——它们共同构成了约 44 文件、2 万行的插件生命周期管理系统。

---

## 关键流程

### 1. 启动时插件安装编排

启动流程由 REPL 界面触发，经过信任检查后执行后台安装：

1. `performStartupChecks(setAppState)` 被 REPL.tsx 调用（`src/utils/plugins/performStartupChecks.tsx:24`）
2. 首先调用 `checkHasTrustDialogAccepted()` 确认当前目录已被用户信任——**安全守卫**，防止恶意仓库自动安装插件
3. 调用 `registerSeedMarketplaces()` 注册种子市场（来自 `CLAUDE_CODE_PLUGIN_SEED_DIR` 环境变量），若状态变化则清除市场和插件缓存，并设置 `plugins.needsRefresh` 标志通知 UI 刷新
4. 调用 `performBackgroundPluginInstallations(setAppState)` 启动后台安装流程

`pluginStartupCheck.ts` 提供了安装编排的核心逻辑：

1. `checkEnabledPlugins()` 合并所有来源的启用插件列表（`src/utils/plugins/pluginStartupCheck.ts:39-72`），优先级从低到高：`--add-dir` → 合并设置（policy > local > project > user）
2. `findMissingPlugins()` 对比已启用但未安装的插件，并行查询市场确认插件存在性（`src/utils/plugins/pluginStartupCheck.ts:216-250`）
3. `installSelectedPlugins()` 执行实际安装：获取插件信息 → 缓存或注册 → 更新 enabledPlugins 设置（`src/utils/plugins/pluginStartupCheck.ts:272-341`）

### 2. 插件策略检查

策略检查是一条极简的调用链，刻意设计为叶子模块以避免循环依赖：

```typescript
// src/utils/plugins/pluginPolicy.ts:17-20
export function isPluginBlockedByPolicy(pluginId: string): boolean {
  const policyEnabled = getSettingsForSource('policySettings')?.enabledPlugins
  return policyEnabled?.[pluginId] === false
}
```

当 `policySettings`（即 `managed-settings.json`）中将某个 pluginId 显式设为 `false` 时，该插件在安装、启用、UI 过滤等所有环节被阻止。

### 3. Hint 插件推荐流程

当 CLI/SDK 工具在 stderr 中输出 `<claude-code-hint type="plugin" />` 标签时：

1. **同步门控** `maybeRecordPluginHint(hint)`（`src/utils/plugins/hintRecommendation.ts:65-89`）依次检查：
   - Feature flag `tengu_lapis_finch` 是否启用
   - 本会话是否已展示过 hint
   - 用户是否已禁用 hint
   - 已展示插件列表是否达到上限（100 个）
   - pluginId 格式是否合法（`name@marketplace`）
   - 市场是否为官方市场
   - 插件是否已安装或被策略阻止
   - 本会话是否已尝试过该 pluginId
2. 通过所有门控后，调用 `setPendingHint(hint)` 暂存
3. **异步解析** `resolvePluginHint(hint)` 执行市场查找，返回 `PluginHintRecommendation` 或 `null`
4. 用户响应后，`markHintPluginShown()` 记录"已展示"状态（show-once 语义），`disableHintRecommendations()` 允许永久禁用

### 4. LSP 插件推荐流程

当用户编辑文件时，LSP 推荐系统基于文件扩展名匹配插件：

1. `getMatchingLspPlugins(filePath)` 是入口（`src/utils/plugins/lspRecommendation.ts:222-309`）
2. 检查推荐功能是否禁用（显式禁用或忽略次数 ≥ 5）
3. 从所有已注册市场加载 LSP 插件元数据，提取内联 `lspServers` 配置中的文件扩展名和 LSP 命令
4. 按以下条件过滤：扩展名匹配 → 不在 "never suggest" 列表 → 未安装 → LSP binary 已安装（通过 `isBinaryInstalled` 检查 PATH）
5. 结果按官方市场优先排序

---

## 函数签名与参数说明

### pluginPolicy.ts

#### `isPluginBlockedByPolicy(pluginId: string): boolean`

检查插件是否被组织策略强制禁用。读取 `policySettings.enabledPlugins`，当值为 `false` 时返回 `true`。

> 源码位置：`src/utils/plugins/pluginPolicy.ts:17-20`

### pluginStartupCheck.ts

#### `checkEnabledPlugins(): Promise<string[]>`

合并所有设置来源，返回当前启用的插件 ID 列表（`plugin@marketplace` 格式）。`--add-dir` 优先级最低，合并设置中的显式 `false` 可覆盖禁用。

> 源码位置：`src/utils/plugins/pluginStartupCheck.ts:39-72`

#### `getPluginEditableScopes(): Map<string, ExtendedPluginScope>`

返回每个启用插件对应的用户可编辑 scope。用于确定"回写到哪个设置文件"。注意这**不是**权威的"是否启用"检查——那是 `checkEnabledPlugins` 的职责。

- 优先级（低→高）：`addDir` → `managed` → `user` → `project` → `local` → `flag`
- 返回 `Map<pluginId, ExtendedPluginScope>`

> 源码位置：`src/utils/plugins/pluginStartupCheck.ts:96-163`

#### `findMissingPlugins(enabledPlugins: string[]): Promise<string[]>`

找出已启用但未安装的插件。对每个未安装的 pluginId 并行查询市场，仅返回市场中确实存在的插件。

> 源码位置：`src/utils/plugins/pluginStartupCheck.ts:216-250`

#### `installSelectedPlugins(pluginsToInstall, onProgress?, scope?): Promise<PluginInstallResult>`

批量安装插件。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| pluginsToInstall | `string[]` | - | 要安装的插件 ID 列表 |
| onProgress | `(name, index, total) => void` | undefined | 安装进度回调 |
| scope | `InstallableScope` | `'user'` | 安装 scope（排除只读的 `managed`） |

- 返回 `{ installed: string[], failed: Array<{ name, error }> }`

> 源码位置：`src/utils/plugins/pluginStartupCheck.ts:272-341`

### performStartupChecks.tsx

#### `performStartupChecks(setAppState: SetAppState): Promise<void>`

启动入口。检查目录信任 → 注册种子市场 → 启动后台安装。任何异常都被捕获并记录日志，不会阻塞应用启动。

> 源码位置：`src/utils/plugins/performStartupChecks.tsx:24-69`

### managedPlugins.ts

#### `getManagedPluginNames(): Set<string> | null`

从 `policySettings.enabledPlugins` 中提取被策略锁定的插件**名称**集合（去除 `@marketplace` 后缀）。仅收录 boolean 类型的 `plugin@marketplace` 条目。无策略条目时返回 `null`。

> 源码位置：`src/utils/plugins/managedPlugins.ts:9-27`

### addDirPluginSettings.ts

#### `getAddDirEnabledPlugins(): NonNullable<SettingsJson['enabledPlugins']>`

合并所有 `--add-dir` 目录下 `.claude/settings.json` 和 `.claude/settings.local.json` 中的 `enabledPlugins`。同目录内 `settings.local.json` 覆盖 `settings.json`，跨目录按 CLI 顺序后者覆盖前者。

> 源码位置：`src/utils/plugins/addDirPluginSettings.ts:34-48`

#### `getAddDirExtraMarketplaces(): Record<string, ExtraKnownMarketplace>`

合并所有 `--add-dir` 目录下的 `extraKnownMarketplaces` 配置，优先级规则同上。

> 源码位置：`src/utils/plugins/addDirPluginSettings.ts:56-71`

### hintRecommendation.ts

#### `maybeRecordPluginHint(hint: ClaudeCodeHint): void`

同步门控函数，由 Shell 工具在检测到 `type="plugin"` hint 时调用。通过 7 层过滤后将 hint 暂存。详见"Hint 插件推荐流程"。

> 源码位置：`src/utils/plugins/hintRecommendation.ts:65-89`

#### `resolvePluginHint(hint: ClaudeCodeHint): Promise<PluginHintRecommendation | null>`

异步解析暂存的 hint，执行市场查找并记录遥测事件 `tengu_plugin_hint_detected`。

> 源码位置：`src/utils/plugins/hintRecommendation.ts:103-135`

#### `markHintPluginShown(pluginId: string): void`

将 pluginId 添加到 `GlobalConfig.claudeCodeHints.plugin[]`，实现 show-once 语义。

#### `disableHintRecommendations(): void`

设置 `claudeCodeHints.disabled = true`，永久禁用 hint 推荐。

### lspRecommendation.ts

#### `getMatchingLspPlugins(filePath: string): Promise<LspPluginRecommendation[]>`

根据文件扩展名匹配 LSP 插件并返回推荐列表。详见"LSP 插件推荐流程"。

> 源码位置：`src/utils/plugins/lspRecommendation.ts:222-309`

#### `addToNeverSuggest(pluginId: string): void`

将插件加入"永不推荐"列表（持久化到 `GlobalConfig.lspRecommendationNeverPlugins`）。

#### `incrementIgnoredCount(): void` / `isLspRecommendationsDisabled(): boolean`

忽略计数管理。连续忽略 5 次后自动禁用 LSP 推荐。

### fetchTelemetry.ts

#### `logPluginFetch(source, urlOrSpec, outcome, durationMs, errorKind?): void`

记录插件/市场网络请求遥测事件 `tengu_plugin_remote_fetch`。

| 参数 | 类型 | 说明 |
|------|------|------|
| source | `PluginFetchSource` | 请求来源（如 `install_counts`、`marketplace_clone`、`plugin_clone`、`mcpb`） |
| urlOrSpec | `string \| undefined` | URL 或 git spec，用于提取主机名 |
| outcome | `PluginFetchOutcome` | `'success'` / `'failure'` / `'cache_hit'` |
| durationMs | `number` | 请求耗时（毫秒） |
| errorKind | `string` | 可选的错误分类 |

> 源码位置：`src/utils/plugins/fetchTelemetry.ts:79-96`

#### `classifyFetchError(error: unknown): string`

将错误分类为有界枚举值，避免原始错误消息进入遥测数据：

| 返回值 | 匹配模式 |
|--------|----------|
| `dns_or_refused` | ENOTFOUND、ECONNREFUSED、Could not resolve host 等 |
| `timeout` | ETIMEDOUT、timed out |
| `conn_reset` | ECONNRESET、socket hang up |
| `auth` | 401、403、permission denied |
| `not_found` | 404、repository not found |
| `tls` | certificate、SSL、TLS 错误 |
| `invalid_schema` | Invalid response format |
| `other` | 其余情况 |

**注意**：DNS 检查**优先于** timeout 检查，因为 `marketplaceManager.ts` 的 gitClone 错误增强会将 DNS 失败重写为包含 "timeout" 关键词的消息。

> 源码位置：`src/utils/plugins/fetchTelemetry.ts:108-135`

### gitAvailability.ts

#### `checkGitAvailable: () => Promise<boolean>`

Memoized 的 Git 可用性检查。使用 `which` 命令查找可执行文件（不实际执行 git），结果在会话内缓存。

> 源码位置：`src/utils/plugins/gitAvailability.ts:42-44`

#### `markGitUnavailable(): void`

强制将缓存结果设为 `false`。用于处理 macOS `xcrun` shim 场景——PATH 中存在 `/usr/bin/git` 但未安装 Xcode CLT，实际执行会失败。

> 源码位置：`src/utils/plugins/gitAvailability.ts:59-61`

---

## 接口/类型定义

### `PluginHintRecommendation`

```typescript
type PluginHintRecommendation = {
  pluginId: string          // "plugin-name@marketplace-name"
  pluginName: string        // 人类可读的插件名
  marketplaceName: string   // 市场名称
  pluginDescription?: string // 插件描述
  sourceCommand: string     // 触发 hint 的命令
}
```

> 源码位置：`src/utils/plugins/hintRecommendation.ts:41-47`

### `LspPluginRecommendation`

```typescript
type LspPluginRecommendation = {
  pluginId: string       // "plugin-name@marketplace-name"
  pluginName: string     // 人类可读名称
  marketplaceName: string
  description?: string
  isOfficial: boolean    // 是否来自官方市场
  extensions: string[]   // 支持的文件扩展名
  command: string        // LSP 服务器命令（如 "typescript-language-server"）
}
```

> 源码位置：`src/utils/plugins/lspRecommendation.ts:30-38`

### `PluginInstallResult`

```typescript
type PluginInstallResult = {
  installed: string[]
  failed: Array<{ name: string; error: string }>
}
```

> 源码位置：`src/utils/plugins/pluginStartupCheck.ts:255-258`

### `PluginFetchSource` / `PluginFetchOutcome`

```typescript
type PluginFetchSource =
  | 'install_counts' | 'marketplace_clone' | 'marketplace_pull'
  | 'marketplace_url' | 'plugin_clone' | 'mcpb'

type PluginFetchOutcome = 'success' | 'failure' | 'cache_hit'
```

> 源码位置：`src/utils/plugins/fetchTelemetry.ts:21-29`

---

## 配置项与默认值

| 配置项 | 来源 | 说明 |
|--------|------|------|
| `policySettings.enabledPlugins` | managed-settings.json | 组织级策略，`false` 表示强制禁用 |
| `enabledPlugins` | 各级 settings.json | 用户/项目/本地级别的插件启用状态 |
| `claudeCodeHints.disabled` | GlobalConfig | 是否禁用 hint 推荐 |
| `claudeCodeHints.plugin[]` | GlobalConfig | 已展示过的插件列表（上限 100） |
| `lspRecommendationDisabled` | GlobalConfig | 是否禁用 LSP 推荐 |
| `lspRecommendationIgnoredCount` | GlobalConfig | 用户忽略 LSP 推荐的次数（≥5 时自动禁用） |
| `lspRecommendationNeverPlugins` | GlobalConfig | "永不推荐"的插件列表 |
| `CLAUDE_CODE_PLUGIN_SEED_DIR` | 环境变量 | 种子市场目录路径 |
| Feature flag `tengu_lapis_finch` | Growthbook | 控制 hint 推荐功能的开关 |

---

## 边界 Case 与注意事项

- **循环依赖规避**：`pluginPolicy.ts` 被刻意设计为叶子模块，仅依赖 settings，不引用 `marketplaceManager` 或其他插件模块，以打破循环依赖链。

- **`--add-dir` 优先级最低**：`addDirPluginSettings` 返回的配置会被所有标准设置来源覆盖。合并设置中的显式 `false` 可以禁用 `--add-dir` 启用的插件。

- **macOS xcrun shim 问题**：`checkGitAvailable()` 仅检查 PATH 中是否存在 `git`，不实际执行。在 macOS 上 `/usr/bin/git` 是 xcrun shim，未安装 Xcode CLT 时执行会失败。调用者遇到 `xcrun: error:` 时应调用 `markGitUnavailable()` 将缓存标记为不可用。

- **主机名隐私保护**：`fetchTelemetry` 的 `extractHost()` 使用允许列表（10 个公共主机），非公共主机一律归入 `'other'`，防止企业内网主机名泄露到遥测数据中。

- **错误分类顺序**：`classifyFetchError` 中 DNS 检查**必须**先于 timeout 检查，因为 `marketplaceManager.ts` 的 `gitClone` 错误增强会将 DNS 失败重写为包含 "timeout" 关键词的消息（`src/utils/plugins/fetchTelemetry.ts:105-106`）。

- **Hint 推荐的同步/异步分离**：`maybeRecordPluginHint` 是同步的（Shell 工具不应阻塞等待市场查找），实际的异步市场查询延迟到 `resolvePluginHint` 中执行。

- **启动安全守卫**：`performStartupChecks` 仅在用户通过"trust this folder"对话框后才执行，防止恶意仓库自动触发插件安装。所有错误被捕获记录，不阻塞启动。

- **LSP 推荐限制**：只能检测在市场条目中**内联声明** `lspServers` 的插件。使用外部 `.lsp.json` 文件的插件在安装前不可检测（`src/utils/plugins/lspRecommendation.ts:8-10`）。

- **V1→V2 迁移**：`getInstalledPlugins()` 在后台触发 `migrateFromEnabledPlugins()`，将旧格式 (`enabledPlugins` in settings.json) 迁移到新格式 (`installed_plugins.json`)，不阻塞调用者。