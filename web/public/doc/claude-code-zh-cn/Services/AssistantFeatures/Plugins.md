# 插件生命周期管理服务（Plugins）

## 概述与职责

本模块是 Claude Code 插件系统的**生命周期管理核心**，位于 `Services > AssistantFeatures` 层级下，属于 `SkillsAndPlugins` 大类中负责插件运行时管理的服务层。它与 `src/utils/plugins/` 中的底层工具函数配合，为插件的安装、卸载、启用、禁用、更新以及后台 marketplace 对账提供完整实现。

模块由三个文件组成，职责分层清晰：

| 文件 | 角色 | 关键特征 |
|------|------|----------|
| `pluginOperations.ts` | 核心操作纯函数层 | 不调用 `process.exit()`，不写 console，返回结果对象 |
| `pluginCliCommands.ts` | CLI 命令包装层 | 处理 console 输出、遥测上报、`process.exit()` |
| `PluginInstallationManager.ts` | 后台安装管理器 | 启动时 marketplace 对账与自动安装，更新 AppState |

这种分层设计使得核心操作既可被 CLI 命令调用（`claude plugin install`），也可被交互式 UI（`ManagePlugins.tsx`）复用。

## 关键流程

### 1. 插件安装流程（Settings-First 策略）

`installPluginOp()` 采用"settings-first"设计——先声明意图（写 settings），再物化（缓存插件）。具体步骤：

1. **解析插件标识符**：通过 `parsePluginIdentifier()` 从 `plugin` 或 `plugin@marketplace` 格式中提取名称和 marketplace
2. **搜索已物化的 marketplace**：如果指定了 marketplace 则直接查找（`getPluginById`），否则遍历所有已知 marketplace 寻找匹配插件（`src/services/plugins/pluginOperations.ts:335-359`）
3. **调用 `installResolvedPlugin()`**：写入 settings 文件并缓存插件到版本化目录
4. **处理失败场景**：区分 `local-source-no-location`、`settings-write-failed`、`resolution-failed`、`blocked-by-policy`、`dependency-blocked-by-policy` 五种错误类型（`src/services/plugins/pluginOperations.ts:382-408`）

> **设计要点**：marketplace 对账不是安装函数的责任——启动时的 `performBackgroundPluginInstallations` 处理"已声明但未物化"的 marketplace。如果 marketplace 未找到，"not found" 就是正确的错误。

### 2. 插件卸载流程

`uninstallPluginOp()` 处理插件的完整清理（`src/services/plugins/pluginOperations.ts:427-558`）：

1. **查找插件**：先从已加载插件列表中查找，若未找到则回退到 `installed_plugins_v2.json`（处理已下架插件场景）
2. **校验作用域**：验证插件确实安装在指定 scope，若不匹配则给出有用的错误提示（如 project scope 建议使用 `--scope local` 覆盖）
3. **清理 settings**：从对应 scope 的 settings 文件中删除插件条目
4. **清理安装数据**：从 `installed_plugins_v2.json` 移除安装记录
5. **清理版本缓存**：若为最后一个 scope 安装，标记版本为 orphaned、删除插件选项和数据目录
6. **依赖警告**：检查并警告（非阻断）依赖此插件的其他插件

### 3. 启用/禁用流程（含作用域优先级）

`setPluginEnabledOp()` 是启用/禁用的统一实现（`src/services/plugins/pluginOperations.ts:573-747`），包含精细的作用域解析逻辑：

- **作用域优先级**：`local (2) > project (1) > user (0)`，搜索时最具体的作用域优先匹配
- **覆盖机制**：允许高优先级 scope 覆盖低优先级设置（如用 `--scope local` 禁用 project 级别启用的插件，无需修改共享的 `.claude/settings.json`）
- **内置插件特殊处理**：内置插件（`isBuiltinPluginId`）始终使用 user scope，跳过常规的 scope 解析和安装检查
- **策略守卫**：被组织策略阻止的插件不能被启用
- **幂等检查**：若插件已处于目标状态，返回 "already enabled/disabled" 提示
- **反向依赖追踪**：禁用时在写入 settings 前捕获依赖此插件的其他插件列表

### 4. 插件更新流程（非就地更新）

`updatePluginOp()` + `performPluginUpdate()` 实现非就地更新策略（`src/services/plugins/pluginOperations.ts:829-1088`）：

1. **获取 marketplace 信息**：通过 `getPluginById()` 查找插件最新状态
2. **区分远程/本地插件**：
   - **远程插件**：通过 `cachePlugin()` 下载到临时目录，捕获 git commit SHA
   - **本地插件**：直接从 marketplace 源路径读取，先验证路径存在性（避免下游静默误判）
3. **版本计算**：通过 `calculatePluginVersion()` 计算新版本号
4. **版本比较**：对比当前安装版本，若一致则返回 "already up to date"
5. **版本化缓存**：通过 `copyPluginToVersionedCache()` 复制到新版本目录
6. **更新磁盘记录**：更新 `installed_plugins_v2.json` 中的安装路径和版本
7. **清理旧版本**：若旧版本不再被任何安装引用，标记为 orphaned
8. **临时目录清理**：通过 `try/finally` 确保远程下载的临时目录被清理

### 5. 后台 Marketplace 对账流程

`performBackgroundPluginInstallations()` 在启动时后台运行（`src/services/plugins/PluginInstallationManager.ts:60-184`）：

1. **计算差异**：比较声明的 marketplace（`getDeclaredMarketplaces`）与已物化的 marketplace（`loadKnownMarketplacesConfig`），通过 `diffMarketplaces` 得到缺失和源变更列表
2. **初始化 UI 状态**：将 pending marketplace 列表写入 AppState，驱动 REPL UI 显示安装进度
3. **执行对账**：调用 `reconcileMarketplaces()`，通过 `onProgress` 回调实时更新 AppState（`installing` → `installed` / `failed`）
4. **后续处理**：
   - **新安装**：自动刷新插件（`refreshActivePlugins`），修复首次加载时的 "plugin not found" 错误
   - **自动刷新失败**：降级为 `needsRefresh` 通知，用户手动执行 `/reload-plugins`
   - **仅更新**：设置 `needsRefresh` 标志，由用户决定何时应用
5. **遥测上报**：记录 `tengu_marketplace_background_install` 事件，包含各状态计数

## 函数签名与参数说明

### pluginOperations.ts — 核心操作

#### `installPluginOp(plugin: string, scope?: InstallableScope): Promise<PluginOperationResult>`

安装插件。`plugin` 支持 `name` 或 `name@marketplace` 格式，`scope` 默认为 `'user'`。

#### `uninstallPluginOp(plugin: string, scope?: InstallableScope, deleteDataDir?: boolean): Promise<PluginOperationResult>`

卸载插件。`deleteDataDir` 默认 `true`，控制是否删除插件数据目录。

#### `enablePluginOp(plugin: string, scope?: InstallableScope): Promise<PluginOperationResult>`

启用插件。`scope` 可选，未提供时自动检测最具体的 scope。

#### `disablePluginOp(plugin: string, scope?: InstallableScope): Promise<PluginOperationResult>`

禁用插件。行为同 `enablePluginOp`。

#### `disableAllPluginsOp(): Promise<PluginOperationResult>`

禁用所有已启用插件，逐个调用 `setPluginEnabledOp`，汇总成功/失败计数。

#### `updatePluginOp(plugin: string, scope: PluginScope): Promise<PluginUpdateResult>`

更新插件到最新版本。注意 `scope` 参数类型为 `PluginScope`（包含 `'managed'`），因为托管插件也允许更新。

### pluginCliCommands.ts — CLI 命令

每个 CLI 函数都是对应 `*Op` 函数的薄包装，增加了 console 输出、遥测上报（`tengu_plugin_*_cli` 事件）和 `process.exit()`：

- `installPlugin(plugin, scope?)` → `installPluginOp`
- `uninstallPlugin(plugin, scope?, keepData?)` → `uninstallPluginOp`
- `enablePlugin(plugin, scope?)` → `enablePluginOp`
- `disablePlugin(plugin, scope?)` → `disablePluginOp`
- `disableAllPlugins()` → `disableAllPluginsOp`
- `updatePluginCli(plugin, scope)` → `updatePluginOp`（使用 `gracefulShutdown` 而非直接 `process.exit`）

### PluginInstallationManager.ts — 后台管理

#### `performBackgroundPluginInstallations(setAppState: SetAppState): Promise<void>`

启动时调用的后台 marketplace 对账入口。`SetAppState` 类型为 `(f: (prevState: AppState) => AppState) => void`。

## 接口/类型定义

### `PluginOperationResult`

```typescript
type PluginOperationResult = {
  success: boolean
  message: string
  pluginId?: string
  pluginName?: string
  scope?: PluginScope
  reverseDependents?: string[]  // 依赖此插件的其他插件（卸载/禁用时的警告）
}
```

### `PluginUpdateResult`

```typescript
type PluginUpdateResult = {
  success: boolean
  message: string
  pluginId?: string
  newVersion?: string
  oldVersion?: string
  alreadyUpToDate?: boolean
  scope?: PluginScope
}
```

### `InstallableScope`

```typescript
type InstallableScope = 'user' | 'project' | 'local'
```

排除 `'managed'` scope——托管插件只能从 `managed-settings.json` 安装，不允许用户直接操作。唯一例外是 `updatePluginOp` 接受 `PluginScope`（含 `'managed'`）。

### 作用域常量

| 常量 | 值 | 用途 |
|------|------|------|
| `VALID_INSTALLABLE_SCOPES` | `['user', 'project', 'local']` | 安装/卸载/启用/禁用操作 |
| `VALID_UPDATE_SCOPES` | `['user', 'project', 'local', 'managed']` | 更新操作 |

## 边界 Case 与注意事项

- **已下架插件的卸载**：当插件从 marketplace 下架后，`uninstallPluginOp` 会回退到 `installed_plugins_v2.json` 查找安装记录（`resolveDelistedPluginId`），确保用户仍能卸载（`src/services/plugins/pluginOperations.ts:460-471`）

- **Project scope 的特殊提示**：project scope 的 `.claude/settings.json` 是团队共享文件。当用户尝试卸载 project scope 的插件时，错误消息建议使用 `--scope local` 禁用而非直接修改共享配置（`src/services/plugins/pluginOperations.ts:487-491`）

- **反向依赖处理**：卸载/禁用时仅**警告**而不阻断，避免在依赖图中存在已下架插件时产生"墓碑"无法清理的问题。加载时的 `verifyAndDemote` 负责捕获后续影响

- **后台安装的自动刷新降级**：`performBackgroundPluginInstallations` 在新 marketplace 安装后会自动刷新插件缓存；若自动刷新失败，降级为设置 `needsRefresh` 标志，避免阻塞启动流程（`src/services/plugins/PluginInstallationManager.ts:145-165`）

- **更新需重启生效**：`updatePluginOp` 更新磁盘文件后，内存中的插件状态不变——更新消息明确提示 "Restart to apply changes"

- **本地插件路径验证**：更新本地插件时会显式 `stat` 源路径，因为下游的 `calculatePluginVersion` 在路径缺失时会沿目录树向上查找 `.git`，可能静默返回错误的"已是最新"结果（`src/services/plugins/pluginOperations.ts:965-985`）

- **遥测中的 PII 处理**：所有 CLI 命令的遥测事件使用 `_PROTO_plugin_name` / `_PROTO_marketplace_name` 前缀路由到 PII 标记的 BigQuery 列，避免插件名称泄露到通用访问的元数据字段