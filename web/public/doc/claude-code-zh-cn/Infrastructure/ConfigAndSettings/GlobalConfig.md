# GlobalConfig — 全局与项目级配置文件管理

## 概述与职责

GlobalConfig 模块是 Claude Code 的配置中枢，负责读写和管理两层配置数据：

- **全局配置**（`~/.claude/.config.json`）：存储用户身份、认证令牌、UI 偏好、特性开关缓存、各类 UI 状态追踪等
- **项目配置**：以 Git 仓库根路径（或工作目录）为 key，嵌套在全局配置的 `projects` 字段中，管理项目级的允许工具列表、MCP 服务器、会话指标等

在整体架构中，该模块位于 **Infrastructure → ConfigAndSettings** 层，是几乎所有上层模块（Services、ToolSystem、TerminalUI 等）的基础依赖。同层级的兄弟模块包括 settings/（多层级设置加载）、env 系列（环境变量管理）、constants/（全局常量）等。

`configConstants.ts` 是一个无依赖的常量定义文件，专门隔离出来以避免循环依赖问题。

## 关键流程

### 全局配置读取流程

1. 调用 `getGlobalConfig()` 时首先检查内存缓存 `globalConfigCache`（`src/utils/config.ts:1052`）
2. 缓存命中（热路径）：直接返回缓存对象，零磁盘 IO
3. 缓存未命中（仅启动时发生一次）：同步读取 `~/.claude/.config.json`，合并默认值，执行字段迁移（`migrateConfigFields`），写入缓存
4. 首次读取后启动 `fs.watchFile` 后台轮询（每 1 秒），检测其他 Claude 实例的写入并异步更新缓存

```
getGlobalConfig()
  ├─ 缓存命中 → 直接返回（热路径）
  └─ 缓存未命中（启动）
       ├─ statSync → readFileSync → JSON.parse
       ├─ migrateConfigFields（旧字段迁移）
       ├─ 写入 globalConfigCache
       └─ startGlobalConfigFreshnessWatcher（后台监听文件变更）
```

### 全局配置写入流程（saveGlobalConfig）

1. 调用方传入一个 `updater` 函数：`(currentConfig) => newConfig`
2. 尝试使用文件锁 (`saveConfigWithLock`)：
   - 获取 `${file}.lock` 锁（`src/utils/config.ts:1169`）
   - 锁内重新读取文件获取最新状态（防止覆盖其他进程的写入）
   - **认证状态保护**：如果重读的配置丢失了 `oauthAccount` 或 `hasCompletedOnboarding`（可能因文件损坏），拒绝写入（参见 GH #3117）
   - 应用 `updater`，过滤掉等于默认值的字段，创建时间戳备份，写入文件
   - 写入后通过 `writeThroughGlobalConfigCache` 更新缓存（`mtime` 设为 `Date.now()` 以超越文件实际 mtime，防止 watcher 重复读取）
3. 锁获取失败时降级为无锁写入，仍然执行认证状态保护检查
4. 清理旧备份，保留最近 5 个（`src/utils/config.ts:1284`）

### 项目配置读写流程

1. `getProjectPathForConfig()` 通过 `findCanonicalGitRoot` 确定当前项目的规范路径（memoized）
2. `getCurrentProjectConfig()` 从全局配置的 `projects[projectPath]` 中提取项目配置
3. `saveCurrentProjectConfig()` 与 `saveGlobalConfig` 共享同一套锁+备份+认证保护机制，只是操作的是 `projects` 子字段

### 信任对话框校验流程

`checkHasTrustDialogAccepted()` 判断当前目录是否已被用户信任：

1. 检查会话级信任（内存中，用于 home 目录场景）
2. 检查项目路径（Git root）的配置
3. 从当前工作目录逐级向上遍历父目录，任一祖先目录被信任即返回 `true`
4. 结果单向缓存：一旦为 `true` 则不再重新计算

## 函数签名与参数说明

### 核心读写 API

#### `getGlobalConfig(): GlobalConfig`

获取全局配置。启动后始终从内存缓存返回，零磁盘开销。

> 源码位置：`src/utils/config.ts:1044`

#### `saveGlobalConfig(updater: (currentConfig: GlobalConfig) => GlobalConfig): void`

更新全局配置。传入 updater 函数，若返回相同引用则跳过写入。

> 源码位置：`src/utils/config.ts:797`

#### `getCurrentProjectConfig(): ProjectConfig`

获取当前项目的配置（基于 Git root 或 cwd）。

> 源码位置：`src/utils/config.ts:1602`

#### `saveCurrentProjectConfig(updater: (currentConfig: ProjectConfig) => ProjectConfig): void`

更新当前项目配置。与 `saveGlobalConfig` 共享锁和安全机制。

> 源码位置：`src/utils/config.ts:1625`

### 信任与安全

#### `checkHasTrustDialogAccepted(): boolean`

检查当前工作目录是否已通过信任对话框。结果为 `true` 时被缓存（单向锁存）。

> 源码位置：`src/utils/config.ts:697`

#### `isPathTrusted(dir: string): boolean`

检查任意目录是否被信任。向上遍历祖先目录。不使用会话级信任或 memoized 项目路径。

> 源码位置：`src/utils/config.ts:752`

### 实用函数

#### `enableConfigs(): void`

启用配置读取。在此之前访问配置会抛出异常，用于防止模块初始化阶段过早读取配置。

> 源码位置：`src/utils/config.ts:1334`

#### `getOrCreateUserID(): string`

获取或创建用户唯一标识（32 字节随机 hex）。

> 源码位置：`src/utils/config.ts:1757`

#### `getRemoteControlAtStartup(): boolean`

返回是否在启动时运行 Remote Control，按优先级：用户显式配置 > CCR 自动连接默认值 > `false`。

> 源码位置：`src/utils/config.ts:1094`

#### `getMemoryPath(memoryType: MemoryType): string`

根据记忆类型返回对应的 CLAUDE.md 文件路径。

> 源码位置：`src/utils/config.ts:1779`

#### `isAutoUpdaterDisabled(): boolean` / `getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null`

检查自动更新是否被禁用，以及禁用原因（开发模式、环境变量、用户配置）。

> 源码位置：`src/utils/config.ts:1700-1755`

## 接口/类型定义

### `GlobalConfig`

全局配置的完整类型定义，约 200+ 个字段，核心分组如下：

| 分组 | 代表字段 | 说明 |
|------|---------|------|
| 身份与认证 | `userID`, `primaryApiKey`, `oauthAccount` | 用户身份和 API 认证 |
| UI 偏好 | `theme`, `editorMode`, `preferredNotifChannel`, `verbose` | 界面和交互设置 |
| 自动更新 | `installMethod`, `autoUpdates`, `autoUpdatesProtectedForNative` | 安装方式与更新策略 |
| MCP | `mcpServers`, `claudeAiMcpEverConnected` | MCP 服务器管理 |
| 会话追踪 | `numStartups`, `tipsHistory`, `hasSeenTasksHint` 等 | 各种一次性提示和计数器 |
| 特性缓存 | `cachedStatsigGates`, `cachedGrowthBookFeatures`, `cachedDynamicConfigs` | 本地缓存的远程特性开关 |
| 项目映射 | `projects: Record<string, ProjectConfig>` | 按路径索引的项目配置集合 |

> 源码位置：`src/utils/config.ts:183-578`

### `ProjectConfig`

项目级配置类型，关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `allowedTools` | `string[]` | 项目允许的工具列表 |
| `mcpServers` | `Record<string, McpServerConfig>` | 项目级 MCP 服务器 |
| `hasTrustDialogAccepted` | `boolean` | 信任对话框是否已接受 |
| `lastCost`, `lastDuration` 等 | `number` | 上次会话的性能指标 |
| `lastModelUsage` | `Record<string, {...}>` | 上次会话按模型分的 token 使用统计 |
| `activeWorktreeSession` | `object` | 当前活跃的 worktree 会话信息 |

> 源码位置：`src/utils/config.ts:76-136`

### `AccountInfo`

OAuth 账户信息，包含 `accountUuid`、`emailAddress`、组织信息、计费类型等。

> 源码位置：`src/utils/config.ts:161-174`

### `AutoUpdaterDisabledReason`

自动更新被禁用的原因：`'development'` | `'env'`（附带环境变量名）| `'config'`。

> 源码位置：`src/utils/config.ts:1717-1720`

## configConstants.ts — 枚举常量

该文件刻意保持无 import 依赖，以避免循环依赖。定义了三组常量：

| 常量 | 值 | 说明 |
|------|-----|------|
| `NOTIFICATION_CHANNELS` | `'auto'`, `'iterm2'`, `'iterm2_with_bell'`, `'terminal_bell'`, `'kitty'`, `'ghostty'`, `'notifications_disabled'` | 支持的通知渠道 |
| `EDITOR_MODES` | `'normal'`, `'vim'` | 编辑器模式（`'emacs'` 已废弃，自动迁移为 `'normal'`） |
| `TEAMMATE_MODES` | `'auto'`, `'tmux'`, `'in-process'` | Teammate 生成模式 |

> 源码位置：`src/utils/configConstants.ts:1-21`

## 配置项与默认值

全局配置的关键默认值（`createDefaultGlobalConfig`，`src/utils/config.ts:585-623`）：

| 字段 | 默认值 |
|------|--------|
| `theme` | `'dark'` |
| `editorMode` | `'normal'` |
| `preferredNotifChannel` | `'auto'` |
| `autoCompactEnabled` | `true` |
| `showTurnDuration` | `true` |
| `fileCheckpointingEnabled` | `true` |
| `terminalProgressBarEnabled` | `true` |
| `todoFeatureEnabled` | `true` |
| `messageIdleNotifThresholdMs` | `60000`（1 分钟） |
| `respectGitignore` | `true` |
| `verbose` | `false` |
| `copyFullResponse` | `false` |
| `diffTool` | `'auto'` |

`GLOBAL_CONFIG_KEYS`（`src/utils/config.ts:627-666`）定义了可通过 `/config` UI 暴露给用户的配置键白名单，共约 40 个字段。

`PROJECT_CONFIG_KEYS`（`src/utils/config.ts:674-678`）限定为 `allowedTools`、`hasTrustDialogAccepted`、`hasCompletedProjectOnboarding`。

## 边界 Case 与注意事项

### 防重入保护

`getConfig` 内部使用 `insideGetConfig` 标志防止 `getConfig → logEvent → shouldSampleEvent → getGlobalConfig → getConfig` 的无限递归。这发生在配置文件损坏时，因为 `logEvent` 的采样检查需要从全局配置中读取 GrowthBook 特性值（`src/utils/config.ts:48-51`, `1481-1500`）。

### 认证状态丢失保护（GH #3117）

`wouldLoseAuthState()` 检测是否即将写入丢失了 `oauthAccount` 或 `hasCompletedOnboarding` 的配置。这防止了以下场景：另一个进程正在写入时读到截断的文件，解析为默认值，再写回去覆盖掉正常配置（`src/utils/config.ts:783-795`）。

### 文件锁与降级

- 使用 `lockfile.lockSync` 获取 `${file}.lock` 文件锁
- 锁获取超过 100ms 时记录遥测事件
- 锁被 compromise（如事件循环停顿超过 10 秒）时仅记录日志而非抛出异常
- 锁失败时降级为无锁读写，但仍执行认证保护

### 配置文件损坏处理

- JSON 解析失败时，备份损坏文件到 `~/.claude/backups/` 并返回默认配置
- 去重机制：如果当前损坏内容已有相同备份则跳过
- BOM 处理：PowerShell 5.x 可能向 UTF-8 文件添加 BOM，读取前自动剥离（`src/utils/config.ts:1439`）

### 写入优化

- 写入前过滤掉等于默认值的字段，减小文件体积
- 备份节流：同一分钟内的多次写入不重复创建备份（`MIN_BACKUP_INTERVAL_MS = 60_000`）
- 配置文件权限设为 `0o600`（仅所有者可读写）

### 启动前读取保护

`configReadingAllowed` 标志确保配置在 `enableConfigs()` 调用前不被访问，防止模块初始化阶段的意外读取（`src/utils/config.ts:1332-1356`）。

### 缓存一致性

`writeThroughGlobalConfigCache` 写入后将缓存 `mtime` 设为 `Date.now()`（必然大于文件实际 mtime），使 `fs.watchFile` 的下一次回调跳过自身写入的重读。其他进程的写入则因 `file.mtimeMs > cache.mtime` 被正确捕获并更新缓存。