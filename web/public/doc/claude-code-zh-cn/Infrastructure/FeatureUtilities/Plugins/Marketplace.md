# 市场管理与官方市场集成（Marketplace）

## 概述与职责

Marketplace 模块是 Claude Code 插件系统的**市场源管理中枢**，负责管理插件市场的完整生命周期——从发现、安装、缓存到刷新和卸载。它位于 `Infrastructure > FeatureUtilities > Plugins` 层级下，是插件生态的基础设施层，为上层的插件加载器（pluginLoader）、安装助手（pluginInstallationHelpers）等模块提供市场数据。

同级模块包括插件版本管理（pluginVersioning）、自动更新（pluginAutoupdate）、启动检查（pluginStartupCheck）等，共同构成了完整的插件生命周期管理系统。

该模块由 7 个文件组成，核心职责包括：

- **市场源注册与配置**：管理 `known_marketplaces.json`，支持 URL / GitHub / Git / 本地目录 / 文件 / NPM / Settings 内联等多种来源
- **缓存与刷新**：将市场数据缓存到本地磁盘，支持增量更新（git pull）和全量重新获取
- **官方市场快速拉取**：通过 GCS 镜像实现秒级市场安装，免去 Git 克隆的开销
- **首次启动自动安装**：新用户自动安装 Anthropic 官方市场，含指数退避重试机制
- **企业策略执行**：支持允许名单（allowlist）和阻止名单（blocklist）控制市场来源
- **用户输入解析**：将多种格式的市场地址智能解析为标准化的 `MarketplaceSource` 对象
- **插件安装量统计**：从 GitHub 统计仓库获取并缓存插件安装量数据

### 文件系统结构

```
~/.claude/
  └── plugins/
      ├── known_marketplaces.json          # 已注册市场的配置（状态层）
      ├── install-counts-cache.json        # 插件安装量缓存（24h TTL）
      └── marketplaces/                    # 市场数据缓存目录
          ├── claude-plugins-official/     # 官方市场（Git 克隆 / GCS 下载）
          │   ├── .claude-plugin/
          │   │   └── marketplace.json
          │   └── .gcs-sha                 # GCS 版本哨兵文件
          └── my-marketplace.json          # URL 来源的市场缓存
```

## 关键流程

### 1. 市场源安装流程（`addMarketplaceSource`）

这是添加新市场的主入口，包含完整的校验、获取、缓存和注册流程：

1. **路径标准化**：将本地相对路径解析为绝对路径，确保状态与 cwd 无关
2. **策略校验**：调用 `isSourceAllowedByPolicy()` 检查阻止名单和允许名单，**在任何网络/文件操作之前**拦截被禁止的来源（`marketplaceManager.ts:1796-1831`）
3. **幂等检查**：遍历已有配置，若完全相同的 source 已存在则直接返回（`marketplaceManager.ts:1834-1842`）
4. **获取与缓存**：根据来源类型分发到不同的缓存策略：
   - **GitHub**：先检测 SSH 是否可用（`isGitHubSshLikelyConfigured()`），优先使用已配置的协议，失败后自动回退到另一种协议（`marketplaceManager.ts:1466-1598`）
   - **Git**：直接使用提供的 URL 进行 `git clone --depth 1`
   - **URL**：通过 axios 下载 JSON 并校验 schema
   - **File / Directory**：直接从本地读取
   - **Settings**：从 settings.json 中的内联定义合成 marketplace.json 到磁盘
5. **Schema 校验**：使用 `PluginMarketplaceSchema` (Zod) 校验市场清单格式
6. **缓存重命名**：将临时缓存路径重命名为市场的实际名称，含路径遍历防护（`marketplaceManager.ts:1709-1720`）
7. **配置持久化**：写入 `known_marketplaces.json`，记录 source、installLocation 和 lastUpdated

### 2. 官方市场 GCS 快速拉取流程（`fetchOfficialMarketplaceFromGcs`）

这是一个关键的性能优化路径，从 CDN 镜像拉取官方市场数据，避免 Git 克隆：

1. **安全校验**：验证 `installLocation` 必须在 `marketplacesCacheDir` 内部，防止目录遍历攻击（`officialMarketplaceGcs.ts:57-65`）
2. **等待 UI 空闲**：调用 `waitForScrollIdle()` 等待终端滚动稳定，避免竞争事件循环
3. **获取最新版本指针**：从 `https://downloads.claude.ai/.../latest` 获取最新 SHA（~40 字节，Cache-Control: max-age=300）
4. **哨兵检查**：对比 `.gcs-sha` 文件中的本地 SHA，相同则跳过（no-op）
5. **下载并解压 ZIP**：下载 `{sha}.zip`（约 3.5MB），使用 fflate 解压，手动恢复文件执行权限位
6. **原子替换**：先写入 `.staging` 目录，然后 `rm` 旧目录 + `rename` staging 目录，确保崩溃安全
7. **遥测上报**：记录 `tengu_plugin_remote_fetch` 事件，包含 outcome、耗时、SHA 等

```
GCS_BASE = 'https://downloads.claude.ai/claude-code-releases/plugins/claude-plugins-official'
```

> 源码位置：`officialMarketplaceGcs.ts:47-170`

### 3. 首次启动自动安装流程（`checkAndInstallOfficialMarketplace`）

处理新用户的官方市场自动安装，含完整的重试和降级逻辑：

1. **重试判定**：检查 GlobalConfig 中的安装状态、失败原因、重试次数和下次重试时间（`officialMarketplaceStartupCheck.ts:76-117`）
2. **前置检查**：
   - 环境变量 `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` 可禁用
   - 检查是否已安装（`known_marketplaces.json` 中已有条目）
   - 检查企业策略是否允许
3. **GCS 优先**：先尝试 GCS 镜像（不需要 Git），成功则直接注册
4. **Git 回退**：GCS 失败时，检查 `tengu_plugin_official_mkt_git_fallback` 特性开关决定是否回退到 Git
5. **Git 可用性检查**：`checkGitAvailable()` 验证 Git 是否存在
6. **macOS xcrun 兼容**：检测 macOS 上 `/usr/bin/git` 的 xcrun shim（未安装 Xcode CLT 时会失败），特殊处理不进入退避逻辑

**指数退避配置**（`officialMarketplaceStartupCheck.ts:56-61`）：

| 参数 | 值 |
|------|-----|
| 最大重试次数 | 10 |
| 初始延迟 | 1 小时 |
| 退避乘数 | 2 |
| 最大延迟 | 1 周 |

### 4. 市场刷新流程（`refreshMarketplace`）

更新已安装市场的缓存数据：

1. 清除该市场的内存 memoization 缓存
2. settings 来源的市场直接跳过（无上游可拉取）
3. 种子目录（seed）管理的市场报错拒绝（admin 控制）
4. **installLocation 安全校验**：验证路径必须在缓存目录内部，防止 corrupted config 导致操作用户项目目录（`marketplaceManager.ts:2408-2426`）
5. 官方市场优先走 GCS，受特性开关控制
6. GitHub 来源执行 SSH/HTTPS 双向回退的 `cacheMarketplaceFromGit`
7. 更新后重新校验 marketplace.json 是否存在（仓库可能已重构）

### 5. 策略执行流程

企业策略通过 `policySettings` 控制市场来源的访问权限，优先级为 **阻止名单 > 允许名单**：

```
isSourceAllowedByPolicy(source):
  1. isSourceInBlocklist(source) → 若匹配则直接拒绝
  2. getStrictKnownMarketplaces() → 若为 null 则无限制，放行
  3. 遍历允许名单：
     - hostPattern: 正则匹配来源的主机名
     - pathPattern: 正则匹配 file/directory 来源的路径
     - 其他: 精确匹配
```

阻止名单支持**跨协议等价检测**：例如 `github:owner/repo` 的阻止条目同样会拦截 `git@github.com:owner/repo.git`（`marketplaceHelpers.ts:391-452`）。

> 源码位置：`marketplaceHelpers.ts:480-505`

## 函数签名与参数说明

### marketplaceManager.ts 主要导出

#### `addMarketplaceSource(source, onProgress?)`

注册新市场来源，获取、校验并缓存市场数据。

- **source**: `MarketplaceSource` — 市场来源配置
- **onProgress**: `(message: string) => void` — 可选进度回调
- **返回**: `Promise<{ name: string, alreadyMaterialized: boolean, resolvedSource: MarketplaceSource }>`
- **异常**: 策略拦截、网络失败、schema 校验失败

#### `removeMarketplaceSource(name)`

移除市场及其关联的所有插件、缓存和配置。

- **name**: `string` — 市场名称
- 同时清理 settings.json 中的 `extraKnownMarketplaces` 和 `enabledPlugins`

#### `refreshMarketplace(name, onProgress?, options?)`

刷新单个市场缓存。

- **options**: `{ disableCredentialHelper?: boolean }` — 可选，是否禁用 Git credential helper

#### `getMarketplace(name)` (memoized)

获取市场数据，优先读缓存，缓存无效时从源获取。结果被 `lodash/memoize` 缓存在内存中。

#### `getMarketplaceCacheOnly(name)`

纯缓存读取，**绝不触发网络请求**，用于启动路径。

#### `getPluginById(pluginId)` / `getPluginByIdCacheOnly(pluginId)`

按 `"name@marketplace"` 格式的 ID 查找单个插件条目。

#### `loadKnownMarketplacesConfig()` / `saveKnownMarketplacesConfig(config)`

读写 `known_marketplaces.json`，含 Zod schema 校验。`loadKnownMarketplacesConfigSafe()` 是不抛异常的变体，适用于只读路径。

#### `getDeclaredMarketplaces()`

从 settings（含 `--add-dir`）获取**声明意图**，返回"应该存在的"市场映射。官方市场在有启用的插件引用它时隐式声明。

#### `registerSeedMarketplaces()`

从 seed 目录注册市场到主配置。Seed 条目优先（admin 管理），`autoUpdate` 强制为 false。支持多 seed 目录（first-wins）。

#### `gitClone(gitUrl, targetPath, ref?, sparsePaths?)`

执行 `git clone --depth 1`，支持 sparse checkout、子模块递归、SSH StrictHostKeyChecking=yes、凭据脱敏，超时可通过 `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS` 配置（默认 120s）。

### parseMarketplaceInput.ts

#### `parseMarketplaceInput(input)`

解析用户输入的市场地址字符串为标准化的 `MarketplaceSource`：

| 输入格式 | 解析结果 |
|----------|----------|
| `git@github.com:owner/repo.git` | `{ source: 'git', url: '...' }` |
| `https://github.com/owner/repo` | `{ source: 'git', url: '.../.git' }` |
| `https://example.com/m.json` | `{ source: 'url', url: '...' }` |
| `owner/repo` | `{ source: 'github', repo: '...' }` |
| `owner/repo#ref` 或 `owner/repo@ref` | `{ source: 'github', repo: '...', ref: '...' }` |
| `./path/to/dir` | `{ source: 'directory', path: '...' }` |
| `./path/to/file.json` | `{ source: 'file', path: '...' }` |
| `~/.../path` | 展开 `~` 为 `homedir()` |

特殊处理：含 `/_git/` 的 URL（Azure DevOps）识别为 git 来源而非 URL 来源（`parseMarketplaceInput.ts:50-63`）。

> 源码位置：`parseMarketplaceInput.ts:23-162`

### installCounts.ts

#### `getInstallCounts()`

获取插件安装量映射。

- **返回**: `Promise<Map<string, number> | null>` — key 为 `"pluginName@marketplace"` 格式
- 优先使用本地缓存（`install-counts-cache.json`，24h TTL）
- 缓存失效时从 GitHub 统计仓库拉取

#### `formatInstallCount(count)`

格式化安装量：`42` → `"42"`，`1200` → `"1.2K"`，`1500000` → `"1.5M"`

## 接口/类型定义

### `MarketplaceSource`（联合类型）

市场来源的 7 种变体，定义在 `schemas.ts` 中：

| source 类型 | 关键字段 | 说明 |
|------------|----------|------|
| `url` | `url`, `headers?` | HTTP(S) 直接下载 marketplace.json |
| `github` | `repo`, `ref?`, `path?`, `sparsePaths?` | GitHub 简写（自动选 SSH/HTTPS） |
| `git` | `url`, `ref?`, `path?`, `sparsePaths?` | 任意 Git URL |
| `npm` | `package` | NPM 包（未实现） |
| `file` | `path` | 本地 JSON 文件 |
| `directory` | `path` | 本地目录 |
| `settings` | `name`, `plugins`, `owner?` | Settings 内联定义 |

### `KnownMarketplace`

已注册市场在 `known_marketplaces.json` 中的条目：

```typescript
type KnownMarketplace = {
  source: MarketplaceSource    // 来源配置
  installLocation: string       // 本地缓存路径
  lastUpdated?: string          // ISO 时间戳
  autoUpdate?: boolean          // 是否启动时自动更新
}
```

### `DeclaredMarketplace`

设置层的市场声明意图（`marketplaceManager.ts:138-152`）：

```typescript
type DeclaredMarketplace = {
  source: MarketplaceSource
  installLocation?: string
  autoUpdate?: boolean
  sourceIsFallback?: boolean  // 隐式声明标记，防止覆盖已有的非官方源
}
```

### `OfficialMarketplaceCheckResult`

首次安装检查结果（`officialMarketplaceStartupCheck.ts:122-131`）：

```typescript
type OfficialMarketplaceCheckResult = {
  installed: boolean
  skipped: boolean
  reason?: OfficialMarketplaceSkipReason
  configSaveFailed?: boolean
}
```

跳过原因枚举：`'already_attempted' | 'already_installed' | 'policy_blocked' | 'git_unavailable' | 'gcs_unavailable' | 'unknown'`

## 配置项与默认值

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS` | 环境变量 | `120000` (120s) | Git 操作超时时间 |
| `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` | 环境变量 | `false` | 禁用官方市场自动安装 |
| `CLAUDE_CODE_REMOTE` | 环境变量 | — | CCR 环境下始终使用 HTTPS（无 SSH） |
| `policySettings.strictKnownMarketplaces` | 策略设置 | `null` | 允许名单（支持 hostPattern/pathPattern） |
| `policySettings.blockedMarketplaces` | 策略设置 | `null` | 阻止名单 |
| `policySettings.pluginTrustMessage` | 策略设置 | — | 自定义插件信任提示消息 |
| `tengu_plugin_official_mkt_git_fallback` | GrowthBook 特性开关 | `true` | GCS 失败后是否回退到 Git |

### 官方市场常量

```typescript
OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official'
OFFICIAL_MARKETPLACE_SOURCE = { source: 'github', repo: 'anthropics/claude-plugins-official' }
GCS_BASE = 'https://downloads.claude.ai/claude-code-releases/plugins/claude-plugins-official'
```

> 源码位置：`officialMarketplace.ts:15-25`

### 安装量缓存

- **缓存路径**：`~/.claude/plugins/install-counts-cache.json`
- **TTL**：24 小时
- **数据源**：`https://raw.githubusercontent.com/anthropics/claude-plugins-official/refs/heads/stats/stats/plugin-installs.json`
- **写入方式**：原子写入（临时文件 + rename），权限 `0o600`

## 边界 Case 与注意事项

### 安全防护

- **路径遍历防护**：`addMarketplaceSource`、`refreshMarketplace`、`fetchOfficialMarketplaceFromGcs` 三处均校验 `installLocation` 必须位于缓存目录内部，防止 corrupted config 导致操作任意目录（gh-32793, gh-32661）
- **凭据脱敏**：所有日志和错误消息中的 URL 经过 `redactUrlCredentials()` 处理，替换 userinfo 为 `***`
- **SSH StrictHostKeyChecking=yes**：首次连接不信任的主机会失败，而非静默接受（防 MITM）
- **Git 无交互模式**：`GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS=''` + `stdin: 'ignore'` 确保 Git 操作不会挂起等待用户输入

### 容错与降级

- **SSH/HTTPS 双向回退**：GitHub 来源先检测 SSH 配置，失败后自动回退；反之亦然（`marketplaceManager.ts:1466-1587`）
- **GCS → Git 降级**：官方市场 GCS 拉取失败时，根据特性开关决定是否回退到 Git 克隆
- **macOS xcrun shim 检测**：clone 失败时如果 stderr 包含 `xcrun: error:`，标记 Git 不可用而非进入退避循环（`officialMarketplaceStartupCheck.ts:370-386`）
- **`loadKnownMarketplacesConfigSafe`**：只读路径使用不抛异常的变体，corrupted config 降级为空对象而非崩溃；但加载→修改→保存路径使用抛异常变体，避免覆盖损坏数据
- **子模块更新非致命**：`gitSubmoduleUpdate` 失败只记录警告，不阻塞主流程

### Seed 目录管理

- Seed 市场由管理员控制（容器镜像中烘焙），`autoUpdate` 强制为 false
- 用户无法 remove / refresh / modify seed 市场，操作会收到明确的错误引导
- 支持多 seed 目录（`CLAUDE_CODE_PLUGIN_SEED_DIRS`），采用 first-wins 策略
- `registerSeedMarketplaces()` 是幂等的，未变更时不写盘

### 缓存机制

- `getMarketplace()` 使用 `lodash/memoize` 在内存中缓存，`clearMarketplacesCache()` 可清除
- 磁盘缓存通过 `known_marketplaces.json` 的 `installLocation` 指向
- 安装量缓存使用独立的 JSON 文件，24 小时 TTL，原子写入防损坏
- GCS 镜像使用 `.gcs-sha` 哨兵文件判断是否需要更新