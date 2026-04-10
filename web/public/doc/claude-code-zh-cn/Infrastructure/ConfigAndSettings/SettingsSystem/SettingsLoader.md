# SettingsLoader — 核心设置加载与合并管道

## 概述与职责

SettingsLoader 是 Claude Code 设置系统的核心管道，负责从多个来源加载、校验、合并设置，并通过三级缓存避免重复 I/O。它位于 **Infrastructure → ConfigAndSettings → SettingsSystem** 层级中，是整个应用获取配置数据的统一入口。

在 SettingsSystem 子系统中，SettingsLoader 与以下兄弟模块协作：
- **types.ts**：定义 `SettingsJson` 的完整 Zod Schema（~1150 行）
- **validation.ts / permissionValidation.ts**：校验设置合法性
- **changeDetector.ts**：通过 chokidar 监听设置文件变更
- **mdm/**：封装 MDM/企业策略读取（macOS plist、Windows HKLM/HKCU）

本模块由 6 个文件组成，各自职责清晰：

| 文件 | 职责 |
|------|------|
| `settings.ts` | 主管道：加载、合并、读写设置 |
| `settingsCache.ts` | 三级缓存管理 |
| `constants.ts` | 来源枚举、优先级定义、显示名称 |
| `managedPath.ts` | 按平台解析企业托管设置路径 |
| `pluginOnlyPolicy.ts` | `strictPluginOnlyCustomization` 策略门控 |
| `allErrors.ts` | 聚合设置校验错误与 MCP 配置错误 |

---

## 关键流程

### 1. 设置来源与优先级

设置从 5 个来源加载，按优先级从低到高排列（后者覆盖前者）：

```
pluginSettings (最低) → userSettings → projectSettings → localSettings → flagSettings → policySettings (最高)
```

来源定义在 `constants.ts:7-22`，由 `SETTING_SOURCES` 常量数组规定顺序：

| 来源 | 文件路径 | 说明 |
|------|----------|------|
| `userSettings` | `~/.claude/settings.json`（或 `cowork_settings.json`） | 用户全局设置 |
| `projectSettings` | `$CWD/.claude/settings.json` | 项目级共享设置（可提交到 Git） |
| `localSettings` | `$CWD/.claude/settings.local.json` | 项目级本地设置（自动加入 .gitignore） |
| `flagSettings` | `--settings` CLI 参数指定的路径 + SDK inline 设置 | CLI/SDK 注入的设置 |
| `policySettings` | 企业托管路径（见下文） | 企业管理员策略，优先级最高 |

`policySettings` 本身有内部优先级链（`settings.ts:322-345`），采用 **first-source-wins** 策略：
1. **Remote**（远程 API 下发）→ 2. **HKLM/plist**（MDM 管理） → 3. **managed-settings.json + drop-ins**（文件） → 4. **HKCU**（Windows 用户注册表）

此外，`policySettings` 和 `flagSettings` **始终启用**，不受 `--setting-sources` CLI 参数限制（`constants.ts:159-167`）。

### 2. 合并设置主流程（`loadSettingsFromDisk`）

入口函数 `getSettingsWithErrors()` → `loadSettingsFromDisk()`（`settings.ts:645-796`）：

1. **插件设置兜底**：从 `pluginSettingsBase`（缓存中）读取插件提供的设置作为最低优先级基底
2. **遍历启用的来源**：按 `getEnabledSettingSources()` 返回的顺序逐一加载
3. **Policy 来源特殊处理**：走 first-source-wins 内部优先级链，只取最高优先级的非空来源
4. **其他来源**：通过 `parseSettingsFile()` 读取文件 → Zod Schema 校验 → `mergeWith` 合并
5. **去重**：通过 `seenFiles` Set 避免同一文件被多个来源重复加载；通过 `seenErrors` Set 去重校验错误
6. **递归保护**：`isLoadingSettings` 标志位防止加载过程中触发递归加载

合并使用 `lodash mergeWith` 配合自定义 `settingsMergeCustomizer`（`settings.ts:538-547`）：
- **数组字段**：拼接并去重（`uniq([...target, ...source])`）
- **对象字段**：递归深合并（lodash 默认行为）
- **标量字段**：后者覆盖前者

### 3. 文件解析流程（`parseSettingsFile`）

`settings.ts:178-231`

1. 检查 per-file 缓存（`getCachedParsedFile`），命中则克隆返回
2. 未命中：通过 `safeResolvePath` 解析符号链接 → `readFileSync` 读取内容
3. 空文件返回空对象 `{}`
4. JSON 解析 → `filterInvalidPermissionRules` 过滤无效权限规则（避免单条坏规则否决整个文件）
5. `SettingsSchema().safeParse(data)` 进行 Zod 校验
6. 结果写入 per-file 缓存，返回时 **clone** 防止调用方污染缓存

### 4. Drop-in 目录分片策略

`loadManagedFileSettings()`（`settings.ts:74-121`）实现 systemd 风格的 drop-in 分片：

1. 先加载 `managed-settings.json` 作为基底（最低优先级）
2. 读取 `managed-settings.d/` 目录下的 `.json` 文件（排除 `.` 开头的隐藏文件）
3. 按文件名 **字母序排序**，逐个 `mergeWith` 合并（后者覆盖前者）

这允许不同团队独立管理策略片段（如 `10-otel.json`、`20-security.json`），无需协调编辑同一文件。

### 5. 设置写入流程（`updateSettingsForSource`）

`settings.ts:416-524`

1. 拒绝写入 `policySettings` 和 `flagSettings`（只读来源）
2. 创建目录（如不存在）
3. 读取现有设置（**绕过 per-source 缓存**，避免 mergeWith 变异污染缓存）
4. 若校验失败，降级读取原始 JSON（处理 schema 不兼容的旧设置）
5. 自定义 merge：`undefined` 值表示删除键，数组直接替换（不拼接）
6. `markInternalWrite` 标记后写入文件
7. `resetSettingsCache()` 清空所有缓存
8. 若为 `localSettings`，异步将路径加入 `.gitignore`

---

## 三级缓存架构（settingsCache.ts）

`settingsCache.ts` 管理三层缓存，均通过 `resetSettingsCache()` 一次性清空：

| 层级 | 存储 | 键 | 用途 |
|------|------|-----|------|
| **会话级合并缓存** | `sessionSettingsCache` | 单例 | 缓存最终合并结果（`SettingsWithErrors`），`getSettingsWithErrors()` 直接命中 |
| **Per-source 缓存** | `perSourceCache` (Map) | `SettingSource` | 缓存每个来源的单独设置，`getSettingsForSource()` 使用 |
| **Per-file 解析缓存** | `parseFileCache` (Map) | 文件路径 | 缓存文件的解析+校验结果，`parseSettingsFile()` 使用 |

缓存失效触发点：设置写入、`--add-dir`、插件初始化、Hook 刷新等操作会调用 `resetSettingsCache()`（`settingsCache.ts:55-59`）。

此外，`pluginSettingsBase`（`settingsCache.ts:66-80`）作为独立的全局变量存储插件提供的设置基底，由 pluginLoader 写入。

---

## 企业托管路径解析（managedPath.ts）

`getManagedFilePath()`（`managedPath.ts:8-25`）根据操作系统返回企业托管设置目录：

| 平台 | 路径 |
|------|------|
| macOS | `/Library/Application Support/ClaudeCode` |
| Windows | `C:\Program Files\ClaudeCode` |
| Linux | `/etc/claude-code` |

- 使用 `lodash memoize` 缓存结果，整个进程只计算一次
- Drop-in 目录为 `<托管路径>/managed-settings.d/`（`managedPath.ts:32-34`）

---

## strictPluginOnlyCustomization 策略门控（pluginOnlyPolicy.ts）

该模块实现企业管理员对定制化来源的限制。

### `isRestrictedToPluginOnly(surface)`

`pluginOnlyPolicy.ts:19-27`

检查某个定制化面（`CustomizationSurface`）是否被锁定为仅允许插件来源：
- 从 `policySettings` 读取 `strictPluginOnlyCustomization` 字段
- `true` → 锁定所有面
- 数组 → 仅锁定列出的面
- 未设置 → 不锁定（默认行为）

锁定后，用户级（`~/.claude/*`）和项目级（`.claude/*`）来源被跳过。

### `isSourceAdminTrusted(source)`

`pluginOnlyPolicy.ts:58-60`

判断某个来源是否为管理员信任来源，可绕过 pluginOnly 限制。信任来源包括：`plugin`、`policySettings`、`built-in`、`builtin`、`bundled`。

---

## 错误聚合（allErrors.ts）

`allErrors.ts` 存在的核心原因是**打破循环依赖**：

```
settings.ts → mcp/config.ts → settings.ts  (循环!)
```

通过将 MCP 错误聚合移到独立的叶子模块，两个模块都不依赖 `allErrors.ts`，循环被打破。

### `getSettingsWithAllErrors()`

`allErrors.ts:23-32`

1. 调用 `getSettingsWithErrors()` 获取设置校验错误
2. 从 `getMcpConfigsByScope()` 收集 `user`/`project`/`local` 三个作用域的 MCP 配置错误
3. 合并返回完整错误列表

当需要展示所有配置问题时（如 `/status` 命令），应使用此函数而非 `getSettingsWithErrors()`。

---

## 函数签名与参数说明

### 核心加载函数

#### `getInitialSettings(): SettingsJson`
返回所有来源合并后的设置快照。使用会话级缓存，适用于非响应式场景。React 组件应使用 `useSettings()` Hook。

#### `getSettingsWithErrors(): SettingsWithErrors`
返回合并设置及所有校验错误。结果被会话级缓存。

> 源码位置：`settings.ts:856-868`

#### `getSettingsForSource(source: SettingSource): SettingsJson | null`
获取单个来源的设置（带 per-source 缓存）。返回 `null` 表示该来源无设置。

> 源码位置：`settings.ts:309-317`

#### `getSettingsWithSources(): SettingsWithSources`
返回合并后的有效设置 + 按优先级排列的各来源原始设置。**始终重新从磁盘读取**（先重置缓存），确保数据一致性。

> 源码位置：`settings.ts:836-848`

### 写入函数

#### `updateSettingsForSource(source: EditableSettingSource, settings: SettingsJson): { error: Error | null }`
合并写入指定来源的设置文件。`source` 只能是 `userSettings`、`projectSettings` 或 `localSettings`。要删除某个键，将其设为 `undefined`。

> 源码位置：`settings.ts:416-524`

### 路径查询函数

#### `getSettingsFilePathForSource(source: SettingSource): string | undefined`
返回指定来源对应的设置文件绝对路径。

#### `getSettingsRootPathForSource(source: SettingSource): string`
返回设置文件所属的根目录（如项目根目录或 `~/.claude`）。

### 策略查询函数

#### `getPolicySettingsOrigin(): 'remote' | 'plist' | 'hklm' | 'file' | 'hkcu' | null`
返回当前生效的策略设置来源类型，用于 `/status` 显示。

#### `hasSkipDangerousModePermissionPrompt(): boolean`
检查是否已跳过危险模式权限提示。**排除 `projectSettings`** 防止恶意项目绕过（RCE 风险）。

#### `hasAutoModeOptIn(): boolean`
检查是否已确认自动模式。同样排除 `projectSettings`。需要 `TRANSCRIPT_CLASSIFIER` 特性门控。

---

## 类型定义

### `SettingSource`（constants.ts:24）

```typescript
type SettingSource = 'userSettings' | 'projectSettings' | 'localSettings' | 'flagSettings' | 'policySettings'
```

### `EditableSettingSource`（constants.ts:182-185）

```typescript
type EditableSettingSource = Exclude<SettingSource, 'policySettings' | 'flagSettings'>
```

### `SettingsWithSources`（settings.ts:822-826）

```typescript
type SettingsWithSources = {
  effective: SettingsJson
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}
```

### `CustomizationSurface`（pluginOnlyPolicy.ts:4）

来自 `types.ts` 的 `CUSTOMIZATION_SURFACES` 元组类型，表示可被策略锁定的定制化面。

---

## 配置项与默认值

| 配置/环境变量 | 说明 | 默认值 |
|--------------|------|--------|
| `--settings <path>` | CLI 参数，指定额外设置文件路径 | 无 |
| `--setting-sources <list>` | CLI 参数，逗号分隔，限制启用的来源（`user,project,local`） | 全部启用 |
| `CLAUDE_CODE_USE_COWORK_PLUGINS` | 启用 cowork 模式时，用户设置从 `cowork_settings.json` 加载 | `false` |
| `CLAUDE_CODE_MANAGED_SETTINGS_PATH` | 覆盖企业托管路径（仅内部使用） | 按平台默认 |

---

## 边界 Case 与注意事项

1. **递归保护**：`loadSettingsFromDisk` 通过 `isLoadingSettings` 标志位防止递归调用。如果在加载过程中被重入，直接返回空设置（`settings.ts:647-649`）。

2. **缓存克隆**：`parseSettingsFile` 返回的结果总是 clone 的副本，防止调用方（特别是 `mergeWith`）污染缓存（`settings.ts:186-188`）。

3. **RCE 防护**：`hasSkipDangerousModePermissionPrompt`、`hasAutoModeOptIn` 等函数**故意排除 `projectSettings`**，防止恶意项目通过 `.claude/settings.json` 自动绕过安全对话框。

4. **校验容错**：`parseSettingsFile` 中，无效权限规则被过滤但不阻断整个文件的加载（`settings.ts:217`）。`updateSettingsForSource` 遇到校验失败时会降级使用原始 JSON 数据。

5. **写入时 merge 行为差异**：`updateSettingsForSource` 的 merge 策略与读取时不同——数组是**替换**而非拼接，`undefined` 值表示**删除键**（`settings.ts:476-494`）。

6. **同一文件去重**：如果不同来源指向同一个物理文件（如 `--settings` 指向项目设置文件），`seenFiles` Set 确保只加载一次（`settings.ts:746`）。

7. **Policy 来源互斥**：policySettings 的 4 种子来源（remote/MDM/file/HKCU）只取第一个非空来源，不合并多个策略来源。