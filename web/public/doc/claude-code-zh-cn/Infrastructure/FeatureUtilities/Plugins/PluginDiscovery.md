# 插件发现与加载核心管线（PluginDiscovery）

## 概述与职责

插件发现与加载管线是 Claude Code 插件系统的核心引擎，位于 `Infrastructure > FeatureUtilities > Plugins` 层级下。它负责从多种来源（市场、Git 仓库、NPM、本地目录等）发现并加载插件，将它们组装为统一的 `LoadedPlugin` 对象，并通过 memoized 缓存避免重复扫描。

该模块由五个文件组成，各自职责清晰：

| 文件 | 职责 | 规模 |
|------|------|------|
| `pluginLoader.ts` | 核心加载引擎——发现、缓存、组装、合并插件 | ~3300 行 |
| `pluginDirectories.ts` | 插件目录路径管理（含 cowork 模式和种子目录） | ~180 行 |
| `pluginIdentifier.ts` | `name@marketplace` 格式标识符解析与作用域映射 | ~124 行 |
| `dependencyResolver.ts` | 纯函数式依赖解析（DFS 遍历、循环检测、降级） | ~306 行 |
| `pluginVersioning.ts` | 插件版本计算（manifest/git SHA/时间戳） | ~158 行 |

同级兄弟模块包括 Hooks（Hook 注册与执行）、ModelManagement（模型管理）、Swarm（多 Agent 协调）等，本模块通过 `loadPluginHooks` 将插件声明的 Hook 注册到 Hook 框架中。

## 关键流程

### 1. 主加载流程 Walkthrough

`loadAllPlugins()` 是整个插件系统的入口，使用 lodash `memoize` 缓存结果。完整加载流程如下：

1. **并行发现**：同时启动市场插件加载 (`loadPluginsFromMarketplaces`) 和会话插件加载 (`loadSessionOnlyPlugins`)（`pluginLoader.ts:3165-3170`）
2. **加载内置插件**：调用 `getBuiltinPlugins()` 获取 CLI 自带插件
3. **三路合并**：通过 `mergePluginSources()` 按优先级合并——会话插件 > 市场插件 > 内置插件。会话插件（`--plugin-dir`）可覆盖同名市场插件，但企业 managed 策略锁定的插件不可被覆盖（`pluginLoader.ts:3009-3063`）
4. **依赖验证与降级**：调用 `verifyAndDemote()` 执行定点循环检查，自动禁用依赖不满足的插件（`pluginLoader.ts:3192-3195`）
5. **缓存设置**：将启用插件的 settings 合并后写入同步缓存，供 settings cascade 使用

此外还有 `loadAllPluginsCacheOnly()` 变体——相同的合并/依赖/设置逻辑，但市场加载器不触发网络请求，仅从磁盘缓存读取。用于启动时的非阻塞路径（命令注册、Agent 定义加载等）。当 `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` 时回退到完整加载器。

### 2. 市场插件加载流程

`loadPluginsFromMarketplaces()` 是市场插件的统一发现/策略/合并管线（`pluginLoader.ts:1888-2089`）：

1. **读取配置**：合并 `--add-dir` 插件和 `settings.enabledPlugins`
2. **过滤有效条目**：校验 `name@marketplace` 格式，排除内置市场
3. **企业策略检查**：加载 `knownMarketplaces` 配置，检查 allowlist/blocklist。采用 **fail-closed** 策略——策略存在但无法验证来源时，阻止加载而非静默放行
4. **预加载目录**：按市场维度批量加载 marketplace catalog，避免 N 个插件做 2N 次配置读取
5. **并行加载**：使用 `Promise.allSettled` 并行处理每个插件条目，单个失败不影响其他

### 3. 单个插件缓存与安装流程

对于外部来源（npm/github/url/git-subdir）的插件，`loadPluginFromMarketplaceEntry()` 执行如下流程：

1. **版本计算**：调用 `calculatePluginVersion()` 确定版本号
2. **缓存命中检查**：依次检查版本化缓存路径 → ZIP 缓存 → 种子缓存（seed cache）
3. **缓存未命中**：调用 `cachePlugin()` 从源下载到临时目录，再通过 `copyPluginToVersionedCache()` 复制到版本化缓存
4. **ZIP 模式**：如启用 ZIP 缓存，提取到会话临时目录后再加载
5. **组装插件**：调用 `finishLoadingPluginFromPath()` → `createPluginFromPath()` 生成 `LoadedPlugin`

### 4. 插件组件装配流程

`createPluginFromPath()` 是将目录结构转化为 `LoadedPlugin` 对象的核心函数（`pluginLoader.ts:1348-1770`）：

1. 加载 `.claude-plugin/plugin.json` manifest（缺失则创建默认 manifest）
2. **并行探测**可选目录：`commands/`、`agents/`、`skills/`、`output-styles/`
3. 处理 manifest 中声明的额外路径（支持路径数组和对象映射两种格式）
4. 加载 hooks 配置——先从 `hooks/hooks.json` 标准路径加载，再合并 `manifest.hooks` 声明的额外 hook 文件（检测并报告重复）
5. 加载插件 settings（`settings.json` 优先于 `manifest.settings`，仅保留白名单 key）

## 函数签名与参数说明

### pluginLoader.ts 核心导出

#### `loadAllPlugins(): Promise<PluginLoadResult>`

主入口，memoized。返回 `{ enabled, disabled, errors }` 三分类结果。

#### `loadAllPluginsCacheOnly(): Promise<PluginLoadResult>`

仅缓存变体，不触发网络请求。启动时使用，避免阻塞。

#### `clearPluginCache(reason?: string): void`

清除 memoized 缓存。安装/卸载/设置变更后调用。同时清理插件 settings 缓存和 session settings 缓存（`pluginLoader.ts:3225-3243`）。

#### `createPluginFromPath(pluginPath, source, enabled, fallbackName, strict?): Promise<{ plugin: LoadedPlugin; errors: PluginError[] }>`

从目录路径组装 `LoadedPlugin`。`strict` 参数控制是否对重复 hook 文件报错（默认 `true`）。

#### `cachePlugin(source, options?): Promise<{ path, manifest, gitCommitSha? }>`

从外部源下载并缓存插件。支持 local/npm/github/url/git-subdir 五种源类型（`pluginLoader.ts:911-1098`）。

#### `mergePluginSources(sources): { plugins, errors }`

三路合并：session > marketplace > builtin。Managed 策略优先级最高。

#### `resolvePluginPath(pluginId, version?): Promise<string>`

解析插件磁盘路径，先尝试版本化路径，再回退到 legacy 路径。

#### `getVersionedCachePath(pluginId, version): string`

计算版本化缓存路径：`~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/`

### pluginDirectories.ts

#### `getPluginsDirectory(): string`

返回插件目录完整路径。优先级：`CLAUDE_CODE_PLUGIN_CACHE_DIR` 环境变量 > `~/.claude/plugins`（或 `cowork_plugins`）。

#### `getPluginSeedDirs(): string[]`

返回只读种子目录列表。通过 `CLAUDE_CODE_PLUGIN_SEED_DIR` 配置，支持 PATH 风格的多目录分隔（`:`/`;`）。种子目录结构镜像主插件目录，用于容器镜像预置插件（`pluginDirectories.ts:66-90`）。

#### `getPluginDataDir(pluginId): string`

返回插件持久数据目录路径并创建目录。暴露为 `${CLAUDE_PLUGIN_DATA}` 环境变量。与版本化安装缓存不同，此目录在插件更新时保留，仅在卸载时删除。

### pluginIdentifier.ts

#### `parsePluginIdentifier(plugin: string): ParsedPluginIdentifier`

解析 `name@marketplace` 格式字符串，返回 `{ name, marketplace? }`。仅使用第一个 `@` 作为分隔符。

#### `buildPluginId(name, marketplace?): string`

构建插件 ID：有 marketplace 则返回 `name@marketplace`，否则返回 `name`。

#### `scopeToSettingSource(scope: PluginScope): EditableSettingSource`

将 plugin scope（`user`/`project`/`local`）映射到 settings source。`managed` scope 会抛出错误。

#### `isOfficialMarketplaceName(marketplace): boolean`

检查是否为官方市场名称，用于遥测数据脱敏——官方插件标识符可安全记录到通用 metadata，第三方标识符仅写入 PII 列。

### dependencyResolver.ts

#### `resolveDependencyClosure(rootId, lookup, alreadyEnabled, allowedCrossMarketplaces?): Promise<ResolutionResult>`

安装时 DFS 遍历依赖闭包。返回需要安装的插件列表，或者错误（循环/未找到/跨市场）。关键语义：

- 已启用的依赖被跳过（不递归），避免意外 settings 写入
- **跨市场依赖默认阻止**——市场 A 的插件不能自动从市场 B 拉取。两种逃逸方式：手动预装跨市场依赖，或 root 市场的 `allowCrossMarketplaceDependenciesOn` 白名单
- root 插件自身即使已启用也不跳过，确保重装时正确缓存

#### `verifyAndDemote(plugins): { demoted, errors }`

加载时安全网。**定点循环**检查所有启用插件的依赖是否满足，不满足则降级（禁用）。降级 A 可能导致依赖 A 的 B 也不满足，因此反复迭代直到稳定（`dependencyResolver.ts:197-228`）。

#### `findReverseDependents(pluginId, plugins): string[]`

查找所有依赖指定插件的已启用插件。用于卸载/禁用时的 "required by: X, Y" 警告。

#### `qualifyDependency(dep, declaringPluginId): string`

将裸依赖名标准化为 `name@marketplace` 格式——裸名继承声明者的 marketplace。例外：`@inline` 插件（`--plugin-dir` 加载）的裸依赖保持原样（`dependencyResolver.ts:38-46`）。

### pluginVersioning.ts

#### `calculatePluginVersion(pluginId, source, manifest?, installPath?, providedVersion?, gitCommitSha?): Promise<string>`

按优先级计算版本：

1. `manifest.version`（plugin.json 中的显式版本）
2. `providedVersion`（市场条目版本或调用方提供）
3. `gitCommitSha`（预解析的 git SHA，取前 12 位；`git-subdir` 源额外附加路径的 sha256 前 8 位以区分同 commit 不同子目录的插件）
4. install path 的 git HEAD SHA
5. `'unknown'` 兜底

> 源码位置：`pluginVersioning.ts:36-106`

#### `getVersionFromPath(installPath): string | null`

从版本化缓存路径 `.../plugins/cache/marketplace/plugin/version` 中提取版本号。

## 接口/类型定义

### `ExtendedPluginScope`

```typescript
type ExtendedPluginScope = PluginScope | 'flag'
```
扩展作用域，`flag` 表示仅当前会话有效（`--plugin-dir`），不持久化到 `installed_plugins.json`。

### `ParsedPluginIdentifier`

```typescript
type ParsedPluginIdentifier = { name: string; marketplace?: string }
```

### `ResolutionResult`

依赖解析结果的联合类型（`dependencyResolver.ts:58-67`）：
- `{ ok: true, closure: PluginId[] }` — 成功，返回安装闭包
- `{ ok: false, reason: 'cycle', chain: PluginId[] }` — 循环依赖
- `{ ok: false, reason: 'not-found', missing, requiredBy }` — 依赖缺失
- `{ ok: false, reason: 'cross-marketplace', dependency, requiredBy }` — 跨市场依赖被阻止

### `SETTING_SOURCE_TO_SCOPE`

Settings source 与 plugin scope 的映射常量（`pluginIdentifier.ts:26-32`）：

| SettingSource | PluginScope |
|---------------|-------------|
| policySettings | managed |
| userSettings | user |
| projectSettings | project |
| localSettings | local |
| flagSettings | flag |

## 配置项与默认值

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `CLAUDE_CODE_PLUGIN_CACHE_DIR` | 环境变量 | `~/.claude/plugins` | 插件缓存根目录覆盖，支持 `~` 展开 |
| `CLAUDE_CODE_USE_COWORK_PLUGINS` | 环境变量/CLI flag `--cowork` | `false` | 切换到 `cowork_plugins` 目录 |
| `CLAUDE_CODE_PLUGIN_SEED_DIR` | 环境变量 | 未设置 | 只读种子目录，PATH 风格多值分隔 |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | 环境变量 | `false` | 设为 `1` 时 cache-only 加载器回退到完整加载器 |
| `CLAUDE_CODE_REMOTE` | 环境变量 | `false` | CCR 模式下 GitHub 使用 HTTPS 而非 SSH |

**插件目录结构**（缓存）：

```
~/.claude/plugins/
├── cache/                          # 版本化缓存
│   └── {marketplace}/{plugin}/{version}/
├── data/{plugin-id}/               # 持久数据目录（跨版本保留）
├── npm-cache/                      # NPM 全局缓存
├── marketplaces/                   # 市场仓库
└── known_marketplaces.json         # 已知市场配置
```

## 边界 Case 与注意事项

- **Fail-closed 策略检查**：当企业策略已配置但市场源无法验证时（配置损坏或条目缺失），插件加载会被阻止而非静默放行。这避免了 `loadKnownMarketplacesConfigSafe` 返回 `{}` 时的 fail-open 风险（`pluginLoader.ts:1922-1936`）

- **版本缓存键不匹配问题**：如果预克隆版本是确定性的（`source.sha`/`entry.version`/`installedVersion`），安装后不重新计算版本，直接复用。否则 `manifest.version`（优先级 1）可能覆盖 `gitCommitSha`（优先级 3），导致缓存键永远不匹配，每次启动都重新克隆（`pluginLoader.ts:2333-2349`）

- **git-subdir 的路径哈希**：同一 commit 的不同子目录插件通过 sha256 路径哈希区分版本，避免缓存碰撞。路径标准化规则必须与服务端 squashfs 构建脚本完全一致（`pluginVersioning.ts:66-88`）

- **依赖解析的 `@inline` 特殊处理**：`--plugin-dir` 加载的插件源为 `name@inline`，`inline` 是合成哨兵值非真实市场。裸依赖不继承 `inline`，而是通过 `verifyAndDemote` 的 name-only 匹配（`dependencyResolver.ts:25-46`）

- **`getPluginDataDir` 是同步的**：使用 `mkdirSync` 而非异步版本，因为它在 `String.replace` 回调中被调用。改为异步需要级联修改 6 个调用点

- **会话插件的 managed 保护**：`--plugin-dir` 无法覆盖企业 managed settings 锁定的插件——无论是 force-enabled 还是 force-disabled 的。管理员意图始终优先于本地开发便利

- **依赖验证的定点收敛**：`verifyAndDemote` 使用 while 循环反复检查，因为禁用 A 可能导致 B 的依赖不再满足。enabledByName 使用多重集合（multiset）计数，避免同名不同市场的插件互相干扰