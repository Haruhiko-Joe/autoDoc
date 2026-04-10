# InstallationLifecycle — 插件安装、更新与生命周期管理

## 概述与职责

InstallationLifecycle 模块是 Claude Code 插件系统的"安装引擎"，负责插件从安装到卸载的完整生命周期管理。它位于 **Infrastructure → FeatureUtilities → Plugins** 层级下，与同级的插件发现（pluginLoader）、市场管理（marketplaceManager）等模块协作，覆盖以下核心职责：

- **安装元数据管理**：通过 `installed_plugins.json` 文件追踪全局安装状态，支持 V1→V2 格式迁移
- **声明式对齐**：reconciler 将 settings 中的声明式意图与磁盘物化状态自动对齐
- **运行时热替换**：refresh 在活跃会话中热替换插件组件（命令、Agent、Hook、MCP、LSP）
- **后台自动更新**：pluginAutoupdate 在启动时静默更新已安装插件
- **安全下架**：pluginBlocklist 检测并自动卸载已从市场移除的插件
- **缓存清理**：cacheUtils 集中管理缓存清除和 7 天孤儿版本垃圾回收
- **无头安装**：headlessPluginInstall 为 CCR 等非交互式环境提供完整安装流程

### 三层刷新模型

该模块实现了清晰的三层刷新架构：

| 层级 | 关注点 | 实现 |
|------|--------|------|
| Layer 1 | 意图（Intent） | `settings.json` 中的 `enabledPlugins` |
| Layer 2 | 物化（Materialization） | `reconcileMarketplaces()` — 将声明式意图对齐到 `~/.claude/plugins/` |
| Layer 3 | 激活（Activation） | `refreshActivePlugins()` — 在运行时 `AppState` 中热替换组件 |

## 关键流程

### 1. 插件安装核心流程（installResolvedPlugin）

这是所有安装路径（CLI、UI、hint 触发）共享的核心逻辑：

1. **策略守卫**：检查插件是否被组织策略（managed-settings.json）阻止（`src/utils/plugins/pluginInstallationHelpers.ts:365`）
2. **依赖闭包解析**：调用 `resolveDependencyClosure()` 解析传递性依赖，支持跨市场依赖检测（`src/utils/plugins/pluginInstallationHelpers.ts:398-409`）
3. **传递性策略检查**：遍历闭包中每个依赖，确保无一被策略阻止（`src/utils/plugins/pluginInstallationHelpers.ts:418-427`）
4. **批量写入 settings**：将完整闭包一次性写入 `enabledPlugins`，保证原子性（`src/utils/plugins/pluginInstallationHelpers.ts:430-444`）
5. **物化缓存**：逐一缓存闭包成员，对本地插件执行路径校验防止路径穿越（`src/utils/plugins/pluginInstallationHelpers.ts:448-473`）
6. **缓存清理**：调用 `clearAllCaches()` 确保后续加载看到最新状态

```
installResolvedPlugin()
  ├─ isPluginBlockedByPolicy()        // 策略守卫
  ├─ resolveDependencyClosure()       // 依赖解析
  ├─ updateSettingsForSource()        // 写入 settings
  ├─ for each closure member:
  │   └─ cacheAndRegisterPlugin()     // 缓存 + 注册
  │       ├─ cachePlugin()            // 下载/复制到缓存
  │       ├─ calculatePluginVersion() // 计算版本号
  │       ├─ rename to versioned path // 移动到版本化路径
  │       └─ addInstalledPlugin()     // 写入 installed_plugins.json
  └─ clearAllCaches()
```

### 2. 市场对齐流程（reconcileMarketplaces）

reconciler 比较 settings 声明的市场（intent）与 `known_marketplaces.json`（materialized state），然后执行增量安装：

1. **Diff 计算**：`diffMarketplaces()` 对比声明与物化状态，分出 `missing`、`sourceChanged`、`upToDate` 三类（`src/utils/plugins/reconciler.ts:50-83`）
2. **路径规范化**：对相对路径做 worktree 感知的规范化——通过 `findCanonicalGitRoot()` 解析到主 checkout 路径，避免 worktree 间路径冲突（`src/utils/plugins/reconciler.ts:249-264`）
3. **幂等安装**：对 `missing` 项执行 `addMarketplaceSource()`，对 `sourceChanged` 项以新源覆盖旧条目（`src/utils/plugins/reconciler.ts:211-231`）
4. **Fallback 语义**：标记 `sourceIsFallback` 的市场只需存在即可，不比较源——避免覆盖 seed/mirror 已物化的内容（`src/utils/plugins/reconciler.ts:66-69`）

### 3. 运行时热替换流程（refreshActivePlugins）

当用户执行 `/reload-plugins` 或系统触发刷新时：

1. **清除所有缓存**：`clearAllCaches()` + `clearPluginCacheExclusions()`（`src/utils/plugins/refresh.ts:76-79`）
2. **完整加载**：先 `loadAllPlugins()` 加载全量插件，再并行加载 commands 和 agent definitions（`src/utils/plugins/refresh.ts:88-92`）
3. **MCP/LSP 服务器加载**：并行加载所有已启用插件的 MCP 和 LSP 服务器配置（`src/utils/plugins/refresh.ts:102-119`）
4. **AppState 原子更新**：一次性更新 `enabled`、`disabled`、`commands`、`errors`，并递增 `pluginReconnectKey` 触发 MCP 重连（`src/utils/plugins/refresh.ts:123-138`）
5. **LSP 重初始化**：调用 `reinitializeLspServerManager()` 使新的 LSP 服务器配置生效（`src/utils/plugins/refresh.ts:145`）
6. **Hook 全量交换**：`loadPluginHooks()` 完成 Hook 的增删（`src/utils/plugins/refresh.ts:153-154`）

### 4. 后台自动更新流程（autoUpdateMarketplacesAndPluginsInBackground）

在 `main.tsx` 启动时作为后台任务执行：

1. 检查是否跳过自动更新（`shouldSkipPluginAutoupdate()`）
2. 获取开启 `autoUpdate` 的市场列表——settings 声明优先于 JSON 状态（`src/utils/plugins/pluginAutoupdate.ts:84-102`）
3. 并行 `refreshMarketplace()` 更新这些市场（git pull/re-download）（`src/utils/plugins/pluginAutoupdate.ts:244-257`）
4. 遍历 `installed_plugins.json`，筛选属于这些市场且与当前项目相关的安装，逐个调用 `updatePluginOp()` 更新（`src/utils/plugins/pluginAutoupdate.ts:161-200`）
5. 通过回调或 pending 通知机制将更新结果传递给 REPL UI（`src/utils/plugins/pluginAutoupdate.ts:272-278`）

### 5. 下架检测与自动卸载（detectAndUninstallDelistedPlugins）

1. 加载 flagged plugins 缓存，获取已安装插件和已知市场（`src/utils/plugins/pluginBlocklist.ts:65-72`）
2. 对每个启用了 `forceRemoveDeletedPlugins` 的市场，比对其插件列表与已安装插件（`src/utils/plugins/pluginBlocklist.ts:79-85`）
3. 对下架的插件，跳过 managed-only（由企业管理员处理），对 user/project/local scope 逐一调用 `uninstallPluginOp()` 卸载（`src/utils/plugins/pluginBlocklist.ts:92-112`）
4. 调用 `addFlaggedPlugin()` 记录下架状态，用于 UI 通知（`src/utils/plugins/pluginBlocklist.ts:114`）

## 函数签名与参数说明

### installedPluginsManager.ts 核心 API

#### `initializeVersionedPlugins(): Promise<void>`

启动时初始化入口。依次执行：V1→V2 文件迁移 → enabledPlugins 同步 → 内存状态初始化。

> 源码位置：`src/utils/plugins/installedPluginsManager.ts:714-734`

#### `addInstalledPlugin(pluginId, metadata, scope?, projectPath?): void`

写入或更新安装元数据到 `installed_plugins.json`。按 `scope + projectPath` 做 upsert。

- **pluginId**：`"name@marketplace"` 格式
- **metadata**：`InstalledPlugin` — 包含 `version`、`installedAt`、`lastUpdated`、`installPath`、`gitCommitSha`
- **scope**：`'user' | 'project' | 'local' | 'managed'`，默认 `'user'`
- **projectPath**：project/local scope 必填，指向项目根路径

> 源码位置：`src/utils/plugins/installedPluginsManager.ts:874-912`

#### `loadInstalledPluginsV2(): InstalledPluginsFileV2`

加载安装数据（带内存缓存）。若磁盘文件为 V1 格式，在内存中转换为 V2 返回。

> 源码位置：`src/utils/plugins/installedPluginsManager.ts:315-364`

#### `updateInstallationPathOnDisk(pluginId, scope, projectPath, newPath, newVersion, gitCommitSha?): void`

仅更新磁盘文件，**不修改内存状态**。后台更新器用此方法写入新版本路径，会话继续使用旧版本，直到用户执行 `/reload-plugins`。

> 源码位置：`src/utils/plugins/installedPluginsManager.ts:537-587`

#### `hasPendingUpdates(): boolean` / `getPendingUpdatesDetails()`

比较内存状态与磁盘状态，检测后台更新器是否已下载新版本。

> 源码位置：`src/utils/plugins/installedPluginsManager.ts:595-696`

#### `isInstallationRelevantToCurrentProject(inst): boolean`

判断安装条目是否与当前项目相关。user/managed scope 全局生效；project/local scope 仅在 `projectPath` 匹配 `getOriginalCwd()` 时生效。

> 源码位置：`src/utils/plugins/installedPluginsManager.ts:800-808`

### pluginInstallationHelpers.ts

#### `installResolvedPlugin({ pluginId, entry, scope, marketplaceInstallLocation? }): Promise<InstallCoreResult>`

核心安装逻辑。返回结构化结果（`ok: true` 或具体错误原因）。

- 错误原因：`local-source-no-location`、`settings-write-failed`、`resolution-failed`、`blocked-by-policy`、`dependency-blocked-by-policy`

> 源码位置：`src/utils/plugins/pluginInstallationHelpers.ts:348-481`

#### `cacheAndRegisterPlugin(pluginId, entry, scope?, projectPath?, localSourcePath?): Promise<string>`

缓存插件到 `~/.claude/plugins/cache/` 版本化路径，并写入注册表。处理同名市场/插件的子目录冲突和 ZIP 缓存模式。返回最终安装路径。

> 源码位置：`src/utils/plugins/pluginInstallationHelpers.ts:128-226`

#### `validatePathWithinBase(basePath, relativePath): string`

路径穿越防护——确保解析后的路径不会逃出基目录。安装本地插件时用于校验相对路径。

> 源码位置：`src/utils/plugins/pluginInstallationHelpers.ts:87-107`

### reconciler.ts

#### `diffMarketplaces(declared, materialized, opts?): MarketplaceDiff`

纯计算函数，比较声明意图与物化状态。返回 `{ missing, sourceChanged, upToDate }` 三个数组。

> 源码位置：`src/utils/plugins/reconciler.ts:50-83`

#### `reconcileMarketplaces(opts?): Promise<ReconcileResult>`

端到端对齐。幂等、仅新增（never deletes）。支持 `skip` 回调（ZIP 缓存模式跳过不支持的源类型）和 `onProgress` 进度事件。

> 源码位置：`src/utils/plugins/reconciler.ts:114-233`

### refresh.ts

#### `refreshActivePlugins(setAppState): Promise<RefreshActivePluginsResult>`

Layer-3 全量刷新。返回包含 `enabled_count`、`command_count`、`agent_count`、`hook_count`、`mcp_count`、`lsp_count`、`error_count` 等统计信息的结果对象。

> 源码位置：`src/utils/plugins/refresh.ts:72-191`

### pluginAutoupdate.ts

#### `autoUpdateMarketplacesAndPluginsInBackground(): void`

启动后台自动更新。fire-and-forget 模式，不阻塞用户交互。

> 源码位置：`src/utils/plugins/pluginAutoupdate.ts:227-284`

#### `onPluginsAutoUpdated(callback): () => void`

注册更新通知回调。若注册时已有 pending 更新，立即回调。返回注销函数。

> 源码位置：`src/utils/plugins/pluginAutoupdate.ts:51-65`

### cacheUtils.ts

#### `clearAllCaches(): void`

清除所有插件相关缓存（plugin cache、commands、agents、hooks、options、output styles、prompt cache、skill names）。

> 源码位置：`src/utils/plugins/cacheUtils.ts:44-50`

#### `cleanupOrphanedPluginVersionsInBackground(): Promise<void>`

7 天孤儿版本 GC。两遍扫描：
- Pass 1：移除已安装版本的 `.orphaned_at` 标记（处理重新安装场景）
- Pass 2：为未安装版本创建标记或删除超过 7 天的版本

> 源码位置：`src/utils/plugins/cacheUtils.ts:74-116`

### pluginBlocklist.ts

#### `detectAndUninstallDelistedPlugins(): Promise<string[]>`

跨所有市场检测下架插件，自动卸载并记录 flagged 状态。返回新增 flagged 的插件 ID 列表。

> 源码位置：`src/utils/plugins/pluginBlocklist.ts:64-127`

### pluginFlagging.ts

#### `addFlaggedPlugin(pluginId): Promise<void>` / `markFlaggedPluginsSeen(pluginIds): Promise<void>`

flagged 插件追踪。`addFlaggedPlugin` 记录下架时间戳；`markFlaggedPluginsSeen` 设置 `seenAt`，48 小时后 `loadFlaggedPlugins()` 自动清除过期条目。

> 源码位置：`src/utils/plugins/pluginFlagging.ts:151-208`

### headlessPluginInstall.ts

#### `installPluginsForHeadless(): Promise<boolean>`

CCR/无头模式完整安装流程：seed 注册 → 市场对齐 → ZIP 缓存同步 → 下架检测 → 返回是否有变更。

> 源码位置：`src/utils/plugins/headlessPluginInstall.ts:43-174`

## 接口/类型定义

### `InstalledPluginsFileV2`

```typescript
// installed_plugins.json 的 V2 格式
{
  version: 2,
  plugins: Record<string, PluginInstallationEntry[]>  // pluginId → 多 scope 安装数组
}
```

### `PluginInstallationEntry`

| 字段 | 类型 | 说明 |
|------|------|------|
| scope | `'user' \| 'project' \| 'local' \| 'managed'` | 安装作用域 |
| installPath | `string` | 版本化缓存路径 |
| version | `string?` | 版本号（semver 或 git SHA 前 12 位） |
| installedAt | `string?` | ISO 时间戳 |
| lastUpdated | `string?` | 最后更新时间 |
| gitCommitSha | `string?` | Git commit SHA |
| projectPath | `string?` | project/local scope 的项目路径 |

### `InstallCoreResult`

安装核心的结构化返回，discriminated union：

- `{ ok: true, closure: string[], depNote: string }` — 成功，含依赖闭包和依赖数说明
- `{ ok: false, reason: 'blocked-by-policy', pluginName }` — 被组织策略阻止
- `{ ok: false, reason: 'resolution-failed', resolution }` — 依赖解析失败（循环依赖/跨市场/未找到）
- `{ ok: false, reason: 'dependency-blocked-by-policy', pluginName, blockedDependency }` — 传递性依赖被策略阻止
- `{ ok: false, reason: 'local-source-no-location', pluginName }` — 本地源缺少安装位置
- `{ ok: false, reason: 'settings-write-failed', message }` — settings 写入失败

### `MarketplaceDiff`

| 字段 | 类型 | 说明 |
|------|------|------|
| missing | `string[]` | 声明但未物化的市场 |
| sourceChanged | `Array<{name, declaredSource, materializedSource}>` | 源已变更的市场 |
| upToDate | `string[]` | 已对齐的市场 |

### `FlaggedPlugin`

| 字段 | 类型 | 说明 |
|------|------|------|
| flaggedAt | `string` | 标记下架的 ISO 时间戳 |
| seenAt | `string?` | 用户在 UI 中看到通知的时间戳，设置后 48h 自动清除 |

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `enabledPlugins` | settings.json（user/project/local 三层） | `{}` | 声明式启用/禁用状态，是安装的"意图源" |
| `autoUpdate` | marketplace 声明 / known_marketplaces.json | 官方市场 `true`，第三方 `false` | 控制是否后台自动更新 |
| `forceRemoveDeletedPlugins` | marketplace.json | - | 控制是否强制卸载已下架插件 |
| `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` | 环境变量 | `false` | 启用 ZIP 缓存模式（CCR 场景） |
| `CLAUDE_CODE_PLUGIN_SEED_DIR` | 环境变量 | - | Seed 市场目录，避免首次启动克隆 |
| 孤儿版本 GC 周期 | 硬编码 | 7 天 | `CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000`（`cacheUtils.ts:24`） |
| Flagged 自动过期 | 硬编码 | 48 小时 | `SEEN_EXPIRY_MS = 48 * 60 * 60 * 1000`（`pluginFlagging.ts:31`） |

## 边界 Case 与注意事项

### 内存 vs 磁盘状态分离

`installedPluginsManager` 维护两套状态：`inMemoryInstalledPlugins`（会话快照，启动时冻结）和磁盘状态。后台更新只修改磁盘，通过 `hasPendingUpdates()` 检测差异。用户需 `/reload-plugins` 才能激活新版本。这种设计避免了后台更新导致运行中会话出现不一致。

### V1→V2 迁移

V1 格式为扁平 `Record<pluginId, InstalledPlugin>`，V2 改为 `Record<pluginId, PluginInstallationEntry[]>` 支持多 scope 安装。迁移在启动时执行一次（`migrationCompleted` 标志防重入），V1 所有插件默认迁移为 `user` scope。迁移还会清理遗留的非版本化缓存目录。

### Worktree 路径规范化

reconciler 的 `normalizeSource()` 对相对路径做 worktree 感知规范化——解析到主 checkout 的 canonical root 而非 worktree cwd。这防止了不同 worktree 会话反复覆盖 `known_marketplaces.json` 中的绝对路径，避免删除 worktree 后留下死路径（`src/utils/plugins/reconciler.ts:236-264`）。

### 同名市场/插件冲突

当市场名与插件名相同时（如 `"exa-mcp-server@exa-mcp-server"`），版本化路径会成为缓存路径的子目录。`cacheAndRegisterPlugin` 通过先移到临时位置再移到最终路径来解决这个自嵌套问题（`src/utils/plugins/pluginInstallationHelpers.ts:185-196`）。

### ZIP 缓存模式

CCR 环境中启用 `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` 时，插件以 ZIP 存储在挂载卷上。此模式下孤儿版本 GC 被跳过（`readSubdirs` 只看目录，会误删 ZIP 文件），reconciler 可跳过不支持的源类型，session 退出时清理解压的临时目录。

### 路径穿越防护

`validatePathWithinBase()` 确保本地插件的相对路径解析后不会逃出市场安装目录，防止恶意路径如 `../../etc/passwd` 的攻击（`src/utils/plugins/pluginInstallationHelpers.ts:87-107`）。

### Flagged 插件生命周期

下架插件被标记后进入 "flagged" 状态 → UI 展示通知 → `markFlaggedPluginsSeen()` 设置 `seenAt` → 48 小时后 `loadFlaggedPlugins()` 自动清除。managed-only 插件（企业管理员安装）不会被自动卸载。

### 回调竞态处理

`pluginAutoupdate` 的通知机制处理了 REPL 尚未挂载时更新完成的竞态：更新结果暂存在 `pendingNotification`，回调注册时立即投递（`src/utils/plugins/pluginAutoupdate.ts:42-65`）。