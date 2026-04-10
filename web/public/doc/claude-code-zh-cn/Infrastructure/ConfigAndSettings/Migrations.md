# 配置迁移脚本集合（Migrations）

## 概述与职责

Migrations 模块位于 `src/migrations/` 目录下，包含 11 个独立的配置迁移脚本（约 600 行代码）。它属于 **Infrastructure → ConfigAndSettings** 层级，是配置与设置系统的重要组成部分。

该模块的核心职责是：**在应用启动时，将用户的旧版配置数据自动迁移到新的格式或位置**。这包括三类迁移：

1. **模型名称升级**：当 Claude 模型发布新版本时，将用户保存的旧模型别名/ID 更新为新版本
2. **设置结构迁移**：将散落在 `globalConfig`（`~/.claude.json`）中的配置字段搬迁到 `settings.json` 体系中
3. **默认值重置**：在产品策略调整时，重置特定用户群体的默认选项

所有迁移脚本都设计为**幂等执行**——重复运行不会产生副作用。

### 调用入口

所有迁移通过 `src/main.tsx:326-352` 中的 `runMigrations()` 函数在应用启动时同步执行。该函数使用版本号机制（`CURRENT_MIGRATION_VERSION = 11`）控制执行：只有当 `globalConfig.migrationVersion` 与当前版本不匹配时才运行全部迁移，执行完毕后更新版本号。

```typescript
// src/main.tsx:325-346
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    // ... 其余迁移 ...
    saveGlobalConfig(prev => prev.migrationVersion === CURRENT_MIGRATION_VERSION ? prev : {
      ...prev,
      migrationVersion: CURRENT_MIGRATION_VERSION
    });
  }
}
```

添加新迁移时需要递增 `CURRENT_MIGRATION_VERSION`，以触发已有用户重新执行迁移集合。

## 关键流程

### 迁移脚本的通用模式

每个迁移脚本遵循相同的三步模式：

1. **前置检查**：判断迁移是否需要执行（旧字段是否存在、用户是否符合条件等），不满足则直接 return
2. **写入新配置**：通过 `updateSettingsForSource()` 或 `saveGlobalConfig()` 将数据写入新位置
3. **清理旧配置**：从 `globalConfig` 或 `projectConfig` 中删除已迁移的旧字段

所有脚本在写入失败时 catch 错误并通过 `logError` 记录，不会中断启动流程。成功/失败均通过 `logEvent()` 上报 analytics 事件（事件名前缀为 `tengu_migrate_*`）。

### 幂等性保障策略

各脚本采用不同的幂等性策略：

| 策略 | 使用脚本 | 原理 |
|------|---------|------|
| 值比对 | `migrateFennecToOpus`、`migrateOpusToOpus1m`、`migrateLegacyOpusToCurrent`、`migrateSonnet45ToSonnet46` | 只在 `userSettings.model` 精确匹配旧值时写入，写入后值已变，不会重复触发 |
| 旧字段存在性 | `migrateBypassPermissionsAcceptedToSettings`、`migrateAutoUpdatesToSettings`、`migrateEnableAllProjectMcpServersToSettings`、`migrateReplBridgeEnabledToRemoteControlAtStartup` | 检查旧字段是否存在，迁移后删除旧字段 |
| 完成标志位 | `resetProToOpusDefault`、`migrateSonnet1mToSonnet45`、`resetAutoModeOptInForDefaultOffer` | 在 `globalConfig` 中写入布尔标志位（如 `opusProMigrationComplete`），下次直接跳过 |

## 各迁移脚本详解

### 模型名称迁移（6 个）

#### `migrateFennecToOpus`

> `src/migrations/migrateFennecToOpus.ts`

将内部代号 "Fennec" 系列模型别名迁移到 Opus 4.6 别名。**仅对 `USER_TYPE=ant`（Anthropic 内部用户）生效**。

映射关系：
- `fennec-latest` → `opus`
- `fennec-latest[1m]` → `opus[1m]`
- `fennec-fast-latest` / `opus-4-5-fast` → `opus[1m]` + `fastMode: true`

只读写 `userSettings`，不触碰 project/local/policy settings，避免将项目级别的配置意外提升为全局默认。

#### `migrateOpusToOpus1m`

> `src/migrations/migrateOpusToOpus1m.ts`

当用户有资格使用合并后的 Opus 1M 体验时（Max/Team Premium 订阅者），将 `userSettings.model = 'opus'` 升级为 `opus[1m]`。

关键逻辑：如果迁移后的 `opus[1m]` 恰好等于默认模型设置，则将 `model` 设为 `undefined`（即回到默认），避免冗余的显式设置（`src/migrations/migrateOpusToOpus1m.ts:35-39`）。

Pro 订阅者和第三方 API 用户被排除在外（通过 `isOpus1mMergeEnabled()` 守卫）。

#### `migrateLegacyOpusToCurrent`

> `src/migrations/migrateLegacyOpusToCurrent.ts`

将第一方用户保存的旧版 Opus 显式模型字符串迁移到 `opus` 别名。目标字符串包括：

- `claude-opus-4-20250514`
- `claude-opus-4-1-20250805`
- `claude-opus-4-0`
- `claude-opus-4-1`

迁移后在 `globalConfig` 中写入 `legacyOpusMigrationTimestamp`，供 REPL 显示一次性通知。受 `isLegacyModelRemapEnabled()` 特性门控保护。

#### `migrateSonnet1mToSonnet45`

> `src/migrations/migrateSonnet1mToSonnet45.ts`

当 `sonnet` 别名指向 Sonnet 4.6 后，将原先的 `sonnet[1m]` 钉定到 `sonnet-4-5-20250929[1m]`，保留用户选择 Sonnet 4.5 1M 的意图。

特殊之处：除了迁移 `userSettings`，还会检查并迁移运行时的内存模型覆盖（`getMainLoopModelOverride()`），确保当前会话也生效（`src/migrations/migrateSonnet1mToSonnet45.ts:39-42`）。使用 `globalConfig.sonnet1m45MigrationComplete` 标志位保证只运行一次。

#### `migrateSonnet45ToSonnet46`

> `src/migrations/migrateSonnet45ToSonnet46.ts`

将 Pro/Max/Team Premium 第一方用户的 Sonnet 4.5 显式字符串迁移回 `sonnet`（现指向 4.6）或 `sonnet[1m]` 别名。目标字符串：

- `claude-sonnet-4-5-20250929` / `sonnet-4-5-20250929` → `sonnet`
- `claude-sonnet-4-5-20250929[1m]` / `sonnet-4-5-20250929[1m]` → `sonnet[1m]`

对于非首次启动的用户（`numStartups > 1`），写入 `sonnet45To46MigrationTimestamp` 用于显示升级通知；新用户跳过通知（`src/migrations/migrateSonnet45ToSonnet46.ts:54-60`）。

#### `resetProToOpusDefault`

> `src/migrations/resetProToOpusDefault.ts`

将 Pro 订阅的第一方用户默认模型切换到 Opus。

- 非第一方或非 Pro 用户：仅标记完成，跳过
- 使用默认模型（`settings.model === undefined`）的用户：写入 `opusProMigrationTimestamp` 触发通知
- 已自定义模型的用户：仅标记完成，不触发通知

使用 `opusProMigrationComplete` 标志位保证一次性执行。

### 设置结构迁移（4 个）

#### `migrateAutoUpdatesToSettings`

> `src/migrations/migrateAutoUpdatesToSettings.ts`

将 `globalConfig.autoUpdates` 迁移到 `userSettings.env.DISABLE_AUTOUPDATER`。

仅在用户**主动**将 `autoUpdates` 设为 `false` 时迁移（排除 `autoUpdatesProtectedForNative === true` 的情况，那是系统自动设置的）。迁移后同时设置 `process.env.DISABLE_AUTOUPDATER = '1'` 使其立即生效（`src/migrations/migrateAutoUpdatesToSettings.ts:44`）。

#### `migrateBypassPermissionsAcceptedToSettings`

> `src/migrations/migrateBypassPermissionsAcceptedToSettings.ts`

将 `globalConfig.bypassPermissionsModeAccepted` 迁移到 `userSettings.skipDangerousModePermissionPrompt`。在写入前通过 `hasSkipDangerousModePermissionPrompt()` 检查新位置是否已有值，避免覆盖。

#### `migrateEnableAllProjectMcpServersToSettings`

> `src/migrations/migrateEnableAllProjectMcpServersToSettings.ts`

最复杂的结构迁移脚本。将三个 MCP 服务器审批相关字段从 `projectConfig` 迁移到 `localSettings`：

- `enableAllProjectMcpServers`（布尔值）
- `enabledMcpjsonServers`（字符串数组）
- `disabledMcpjsonServers`（字符串数组）

数组字段采用**合并去重**策略——如果 `localSettings` 中已有部分服务器列表，迁移时会合并而非覆盖（`src/migrations/migrateEnableAllProjectMcpServersToSettings.ts:64-69`）。所有字段迁移完毕后，从 `projectConfig` 中批量删除旧字段。

#### `migrateReplBridgeEnabledToRemoteControlAtStartup`

> `src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts`

最简洁的迁移脚本。将 `globalConfig.replBridgeEnabled`（已从类型定义中移除的内部实现细节）重命名为 `remoteControlAtStartup`。由于旧字段已不在 `GlobalConfig` 类型中，通过 `Record<string, unknown>` 类型断言访问（`src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts:15`）。

### 默认值重置（1 个）

#### `resetAutoModeOptInForDefaultOffer`

> `src/migrations/resetAutoModeOptInForDefaultOffer.ts`

针对特定场景的一次性重置：当自动模式的 opt-in 对话框增加了"设为默认模式"选项后，清除已接受旧版对话框用户的 `skipAutoPermissionPrompt` 标志，使其重新看到新版对话框。

受双重守卫保护：
1. `feature('TRANSCRIPT_CLASSIFIER')` 编译时特性开关
2. `getAutoModeEnabledState() === 'enabled'`——对于 `opt-in` 状态的用户，清除此标志会导致自动模式从选项轮播中消失，反而适得其反

使用 `hasResetAutoModeOptInForDefaultOffer` 标志位确保只执行一次。

## 接口/类型定义

所有迁移脚本导出单一的无参数、无返回值函数：

```typescript
export function migrate*(): void
```

脚本间没有互相调用关系，彼此完全独立。

### 依赖的核心 API

| API | 来源 | 用途 |
|-----|------|------|
| `getGlobalConfig()` / `saveGlobalConfig()` | `src/utils/config.js` | 读写 `~/.claude.json` 全局配置 |
| `getCurrentProjectConfig()` / `saveCurrentProjectConfig()` | `src/utils/config.js` | 读写项目级配置 |
| `getSettingsForSource(source)` | `src/utils/settings/settings.js` | 读取指定来源的 settings（`userSettings` / `localSettings`） |
| `updateSettingsForSource(source, updates)` | `src/utils/settings/settings.js` | 写入指定来源的 settings |
| `logEvent(name, metadata)` | `src/services/analytics/index.js` | 上报迁移 analytics 事件 |

## 边界 Case 与注意事项

1. **只迁移 `userSettings`，不动 project/local/policy**：模型名称迁移脚本一律只读写 `userSettings`（用户全局设置）。这是有意为之——如果读取合并后的 settings 来判断是否迁移，会导致项目级别的 `sonnet[1m]` 被提升为全局 `sonnet-4-5-20250929[1m]`，造成"静默全局提升"问题。

2. **特性门控与用户类型过滤**：部分迁移有条件限制——`migrateFennecToOpus` 仅限内部用户（`USER_TYPE=ant`）、`migrateSonnet45ToSonnet46` 仅限 Pro/Max/Team Premium、`migrateLegacyOpusToCurrent` 仅限第一方 API 用户。

3. **通知时间戳模式**：多个迁移在 `globalConfig` 中写入时间戳字段（如 `opusProMigrationTimestamp`、`sonnet45To46MigrationTimestamp`），供 REPL 层在下次交互时显示一次性升级通知。

4. **错误不阻塞启动**：所有迁移的异常都被 catch 并记录，不会中断应用启动流程。

5. **`CURRENT_MIGRATION_VERSION` 机制**：版本号匹配后直接跳过所有迁移。添加新迁移时**必须递增**此常量（`src/main.tsx:325`），否则已有用户不会执行新迁移。但每个脚本内部仍有自己的幂等保护，确保重复执行安全。