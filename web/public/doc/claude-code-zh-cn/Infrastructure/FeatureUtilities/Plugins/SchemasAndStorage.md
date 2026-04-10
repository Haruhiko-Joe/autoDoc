# Schema 定义、验证与存储基础设施

## 概述与职责

SchemasAndStorage 模块是 Claude Code 插件系统的**数据层基石**，负责三个核心职责：

1. **Schema 定义**：通过 Zod 校验库定义插件和市场的完整类型体系（`PluginManifest`、`PluginMarketplace`、`MarketplaceSource`、`InstalledPlugin` 等），包含市场命名安全策略（反仿冒检测、同形字攻击防御）
2. **Manifest 验证**：实现 `plugin.json` 和 `marketplace.json` 的完整校验流水线，供 `claude plugin validate` CLI 命令使用
3. **ZIP 存储与缓存**：管理 ZIP 归档格式的插件持久化存储（Filestore 挂载目录）和会话级临时提取，以及 DXT/MCPB 格式的安全解压

在整体架构中，本模块位于 **Infrastructure → FeatureUtilities → Plugins** 层级下。它被上层的插件加载器（`pluginLoader`）、市场管理器（`marketplaceManager`）、安装助手（`pluginInstallationHelpers`）等模块广泛依赖，是整个插件生命周期管理的数据契约和存储基础。同级模块包括 Hooks 框架、模型管理、Swarm 协调等。

## 关键文件总览

| 文件 | 行数 | 职责 |
|------|------|------|
| `schemas.ts` | 1682 | 核心 Zod Schema 定义与类型导出 |
| `validatePlugin.ts` | 903 | Manifest 文件校验引擎 |
| `zipCache.ts` | 407 | ZIP 归档创建/提取/会话缓存管理 |
| `zipCacheAdapters.ts` | 165 | ZIP 缓存元数据 I/O 与跨容器同步 |
| `orphanedPluginFilter.ts` | 115 | 孤儿插件版本的 ripgrep 排除模式生成 |
| `dxt/helpers.ts` | 89 | DXT/MCPB Manifest 解析与验证 |
| `dxt/zip.ts` | 227 | ZIP 安全解压（路径遍历防护、大小限制、zip bomb 检测） |

---

## 关键流程

### 1. Schema 定义与市场命名安全

`schemas.ts` 使用 `lazySchema()` 包装所有 Zod schema，实现延迟实例化以避免启动时创建大量闭包（约 700KB 堆内存节省）。

**市场命名安全策略** 是一个三层防御体系：

1. **保留名称白名单**：`ALLOWED_OFFICIAL_MARKETPLACE_NAMES` 定义了 8 个 Anthropic 官方保留名称（如 `claude-code-marketplace`、`anthropic-plugins`），仅允许来自 `anthropics` GitHub 组织的源使用这些名称（`src/utils/plugins/schemas.ts:19-28`）

2. **仿冒名称正则拦截**：`BLOCKED_OFFICIAL_NAME_PATTERN` 匹配包含 `official` + `anthropic/claude` 组合、或以 `anthropic/claude` 开头后接 `marketplace/plugins` 的名称（`src/utils/plugins/schemas.ts:71-72`）

3. **同形字攻击检测**：`NON_ASCII_PATTERN` 拦截所有非 ASCII 字符，防止用西里尔字母 'а' 冒充拉丁字母 'a' 等 Unicode 同形字攻击（`src/utils/plugins/schemas.ts:79`）

```typescript
// src/utils/plugins/schemas.ts:87-101
export function isBlockedOfficialName(name: string): boolean {
  if (ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(name.toLowerCase())) {
    return false
  }
  if (NON_ASCII_PATTERN.test(name)) {
    return true
  }
  return BLOCKED_OFFICIAL_NAME_PATTERN.test(name)
}
```

**自动更新默认值**：官方市场默认启用自动更新，但 `knowledge-work-plugins` 通过 `NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES` 集合排除在外。`isMarketplaceAutoUpdate()` 函数先检查显式设置，再根据是否为官方市场决定默认值（`src/utils/plugins/schemas.ts:48-58`）。

### 2. PluginManifest Schema 组装

`PluginManifestSchema` 是整个类型体系的核心，通过合并多个子 Schema 的 `.partial().shape` 组装而成（`src/utils/plugins/schemas.ts:884-898`）：

- **PluginManifestMetadataSchema**：name、version、description、author、dependencies 等基本元数据
- **PluginManifestHooksSchema**：Hook 配置（支持路径引用或内联定义）
- **PluginManifestCommandsSchema**：命令定义（单路径、路径数组、对象映射三种格式）
- **PluginManifestAgentsSchema / PluginManifestSkillsSchema**：Agent 和 Skill 文件路径
- **PluginManifestMcpServerSchema**：MCP 服务器配置（JSON 路径、MCPB 路径/URL、内联 Record）
- **PluginManifestLspServerSchema**：LSP 服务器配置
- **PluginManifestUserConfigSchema**：用户可配置选项（支持 sensitive 标记以使用 Keychain 安全存储）
- **PluginManifestChannelsSchema**：消息通道声明（Telegram/Slack/Discord 等）
- **PluginManifestSettingsSchema**：插件注入的 settings（仅允许白名单 key）

设计要点：**顶层字段宽松、嵌套字段严格**。运行时加载路径静默剥离未知顶层字段（保证兼容性），但 `userConfig`、`channels`、`lspServers` 等嵌套对象使用 `.strict()` 或 `.strictObject()` 拒绝未知字段（捕捉笔误）。

### 3. MarketplaceSource 多源支持

`MarketplaceSourceSchema` 使用 `z.discriminatedUnion('source', [...])` 定义 8 种市场来源（`src/utils/plugins/schemas.ts:906-1043`）：

| source 类型 | 用途 | 关键字段 |
|------------|------|---------|
| `url` | 直接 URL 指向 marketplace.json | `url`, `headers` |
| `github` | GitHub 仓库简写 | `repo`, `ref`, `path`, `sparsePaths` |
| `git` | 任意 Git URL（含 Azure DevOps、CodeCommit） | `url`, `ref`, `path`, `sparsePaths` |
| `npm` | NPM 包 | `package` |
| `file` | 本地文件路径 | `path` |
| `directory` | 本地目录 | `path` |
| `hostPattern` | 主机名正则匹配（用于 strictKnownMarketplaces） | `hostPattern` |
| `pathPattern` | 路径正则匹配 | `pathPattern` |
| `settings` | 内联于 settings.json | `name`, `plugins`, `owner` |

`settings` 源的插件使用精简的 `SettingsMarketplacePluginSchema`（仅 name/source/description/version/strict），禁止相对路径源，防止生成的 settingsTypes 文件膨胀（完整 PluginManifest partial 展开约 870 行/出现）。

### 4. Manifest 验证流水线

`validatePlugin.ts` 实现了供 `claude plugin validate` CLI 使用的完整校验引擎。

**入口函数 `validateManifest()`** 的分发逻辑（`src/utils/plugins/validatePlugin.ts:814-903`）：
1. 如果是目录 → 在 `.claude-plugin/` 下查找 `marketplace.json`（优先）或 `plugin.json`
2. 如果是文件 → 按文件名检测类型（`plugin.json` / `marketplace.json`）
3. 无法判断 → 解析 JSON 内容启发式判断（有 `plugins` 数组则为市场），默认作为插件验证

**`validatePluginManifest()` 流程**（`src/utils/plugins/validatePlugin.ts:129-305`）：
1. 读取文件并解析 JSON
2. **路径遍历安全检查**：扫描 `commands`、`agents`、`skills` 字段中的 `..` 路径
3. **市场专属字段警告**：检测 `category`、`source`、`tags`、`strict`、`id` 等只属于 `marketplace.json` 的字段，生成 warning 而非 error（运行时会被静默剥离）
4. **严格模式校验**：调用 `PluginManifestSchema().strict().safeParse()` 捕捉笔误
5. **最佳实践警告**：检查 kebab-case 命名（Claude.ai 市场同步要求）、缺少版本/描述/作者

**`validateMarketplaceManifest()` 额外检查**（`src/utils/plugins/validatePlugin.ts:310-507`）：
- 插件源路径 `..` 检测，附带定制化提示（路径相对于市场根目录而非 marketplace.json）
- 重复插件名检测
- **版本不一致检测**：对比 marketplace.json 中声明的版本与实际 plugin.json 中的版本，因为 `calculatePluginVersion` 优先使用 manifest 版本

**组件文件验证 `validatePluginContents()`**（`src/utils/plugins/validatePlugin.ts:763-809`）：
- 递归扫描 `skills/`、`agents/`、`commands/` 目录的 Markdown 文件
- 校验 YAML frontmatter（description 类型、allowed-tools 格式、shell 值）
- 校验 `hooks/hooks.json`（运行时使用 `.parse()` 而非 `.safeParse()`，错误会导致整个插件加载失败）

### 5. ZIP 缓存存储架构

`zipCache.ts` 管理插件的 ZIP 归档存储，适用于短暂容器（ephemeral container）场景。

**双层目录结构**：

```
/mnt/plugins-cache/                    ← Filestore 持久挂载目录
  ├── known_marketplaces.json          ← 已知市场注册表
  ├── installed_plugins.json           ← 已安装插件记录
  ├── marketplaces/                    ← 市场 JSON 缓存
  │   └── official-marketplace.json
  └── plugins/                         ← 插件 ZIP 归档
      └── official-marketplace/
          └── plugin-a/
              └── 1.0.0.zip

/tmp/claude-plugin-session-<hex>/      ← 会话本地临时目录
  └── (从 ZIP 解压的插件文件)
```

**启用条件**：需要同时设置 `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE=true` 和 `CLAUDE_CODE_PLUGIN_CACHE_DIR` 环境变量。仅支持 headless 模式。

**关键操作**：

- **原子写入**：`atomicWriteToZipCache()` 先写临时文件再 `rename`，防止并发读取到半写状态（`src/utils/plugins/zipCache.ts:175-201`）
- **ZIP 创建**：`createZipFromDirectory()` 递归收集文件，跳过 `.git` 和符号链接目录，通过 `dev:ino` 检测符号链接循环（使用 `bigint: true` 避免 Windows NTFS 大 inode 精度丢失），保存 Unix 权限位到 `external_attr`（`src/utils/plugins/zipCache.ts:216-323`）
- **ZIP 提取**：`extractZipToDirectory()` 使用 `parseZipModes()` 恢复可执行权限位（hooks/scripts 需要 +x），容忍 `EPERM/ENOTSUP`（NFS root_squash 场景）（`src/utils/plugins/zipCache.ts:331-364`）
- **会话缓存生命周期**：`getSessionPluginCachePath()` 延迟创建、单例保证；`cleanupSessionPluginCache()` 在会话结束时清理

**支持的市场源类型**：`github`、`git`、`url`、`settings`。排除 `file`/`directory`（短暂容器内无意义）和 `npm`（node_modules 在挂载卷上过于臃肿）（`src/utils/plugins/zipCache.ts:402-406`）。

### 6. ZIP 缓存适配器与跨容器同步

`zipCacheAdapters.ts` 处理 ZIP 缓存的元数据 I/O 和跨容器数据合并。

**`syncMarketplacesToZipCache()` 同步流程**（`src/utils/plugins/zipCacheAdapters.ts:141-164`）：
1. 从全局配置加载已知市场列表（使用 Safe 变体，损坏配置不抛异常）
2. 遍历所有有 `installLocation` 的市场，将 marketplace.json 保存到 ZIP 缓存
3. 读取 ZIP 缓存中的已有市场数据
4. **合并**：`{ ...zipCacheKnownMarketplaces, ...knownMarketplaces }` — 本地配置覆盖缓存（短暂容器重启后可恢复全局配置丢失的市场数据）

**marketplace.json 查找策略**（`src/utils/plugins/zipCacheAdapters.ts:120-134`）：
按优先级尝试三个位置：`.claude-plugin/marketplace.json` → `marketplace.json` → 目录本身（URL 源场景下 installLocation 即 JSON 文件）。

### 7. 孤儿插件版本过滤

`orphanedPluginFilter.ts` 解决插件版本更新后旧版本被 Grep/Glob 搜索到的问题。

**工作原理**：
1. 插件更新时，旧版本目录保留 7 天（供并发会话使用），但被标记 `.orphaned_at` 文件
2. 启动时通过 `ripgrep --files --hidden --max-depth 4` 搜索所有 `.orphaned_at` 标记
3. 对每个标记生成 `!**/<relative-path>/**` 排除模式
4. 缓存为会话级单例，一旦计算不再更新（除非 `/reload-plugins`）

**智能路径判断**：`getGlobExclusionsForPluginCache()` 接受可选 `searchPath` 参数，仅当搜索路径与插件缓存目录有交集时才返回排除模式，避免无关搜索附加多余 `--glob` 参数（`src/utils/plugins/orphanedPluginFilter.ts:38-46`）。

### 8. DXT/MCPB 安全解压

`dxt/zip.ts` 提供带安全防护的 ZIP 解压，专为 DXT（Desktop Extension）和 MCPB（MCP Bundle）格式设计。

**安全限制常量**（`src/utils/dxt/zip.ts:7-13`）：

| 限制 | 值 | 说明 |
|------|-----|------|
| MAX_FILE_SIZE | 512 MB | 单文件上限 |
| MAX_TOTAL_SIZE | 1024 MB | 总解压大小上限 |
| MAX_FILE_COUNT | 100,000 | 最大文件数 |
| MAX_COMPRESSION_RATIO | 50:1 | zip bomb 检测阈值 |

**`unzipFile()` 校验流程**（`src/utils/dxt/zip.ts:113-141`）：
使用 fflate 的 `filter` 回调在解压每个文件前执行 `validateZipFile()`，逐项检查：
1. 路径安全性：拒绝 `..` 路径遍历和绝对路径（`isPathSafe()`）
2. 单文件大小
3. 累计解压大小
4. 压缩比（超过 50:1 视为 zip bomb）

fflate 库采用延迟导入，避免其 ~196KB 查找表在启动时分配（`src/utils/dxt/zip.ts:109-111`）。

**`parseZipModes()` 权限位恢复**（`src/utils/dxt/zip.ts:160-203`）：
fflate 的 `unzipSync` 不暴露 `external_attr`，导致可执行权限丢失。此函数直接解析 ZIP 中央目录二进制结构（PKZIP APPNOTE.TXT §4.3.12），提取 Unix 主机创建的文件的 `st_mode`。不支持 ZIP64（对市场 ZIP ~3.5MB 和 MCPB 包不需要）。

**`dxt/helpers.ts` Manifest 验证**（`src/utils/dxt/helpers.ts:13-34`）：
延迟导入 `@anthropic-ai/mcpb` 包（使用 zod v3，会创建约 24 个 `.bind(this)` 闭包/schema 实例），使用 `McpbManifestSchema.safeParse()` 验证。支持从 JSON 对象、文本字符串和二进制 `Uint8Array` 三种输入验证。

`generateExtensionId()` 从 manifest 的 author.name 和 name 生成扩展 ID（`src/utils/dxt/helpers.ts:67-88`），支持 `local.unpacked` 和 `local.dxt` 前缀。

## 函数签名与参数说明

### schemas.ts 导出函数

#### `isBlockedOfficialName(name: string): boolean`
检测市场名称是否仿冒官方名称。对白名单中的名称返回 false，对含非 ASCII 字符或匹配仿冒模式的名称返回 true。

#### `validateOfficialNameSource(name, source): string | null`
验证保留名称是否来自 `anthropics` 官方 GitHub 组织。返回 null 表示合法，返回字符串为错误信息。

#### `isMarketplaceAutoUpdate(marketplaceName, entry): boolean`
判断市场是否启用自动更新。优先使用 `entry.autoUpdate`，其次根据是否为官方市场决定默认值。

#### `isLocalPluginSource(source: PluginSource): source is string`
判断插件源是否为本地路径（以 `./` 开头的字符串）。

#### `isLocalMarketplaceSource(source: MarketplaceSource): boolean`
判断市场源是否为本地文件系统路径（`file` 或 `directory` 类型）。

### validatePlugin.ts 导出函数

#### `validateManifest(filePath: string): Promise<ValidationResult>`
自动检测文件类型并调度到对应的验证函数。支持文件路径和目录路径。

#### `validatePluginManifest(filePath: string): Promise<ValidationResult>`
验证 plugin.json 文件。返回包含 `success`、`errors`、`warnings`、`filePath`、`fileType` 的结果对象。

#### `validateMarketplaceManifest(filePath: string): Promise<ValidationResult>`
验证 marketplace.json 文件。额外检查重复名称和版本不一致。

#### `validatePluginContents(pluginDir: string): Promise<ValidationResult[]>`
验证插件目录中的所有组件文件（skills、agents、commands 的 Markdown 文件和 hooks.json）。

### zipCache.ts 导出函数

#### `isPluginZipCacheEnabled(): boolean`
检查 `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` 环境变量是否为 truthy。

#### `getPluginZipCachePath(): string | undefined`
获取 ZIP 缓存目录路径（从 `CLAUDE_CODE_PLUGIN_CACHE_DIR` 读取，支持 `~` 展开）。

#### `atomicWriteToZipCache(targetPath: string, data: string | Uint8Array): Promise<void>`
原子写入文件到 ZIP 缓存。写临时文件后 rename，失败时清理临时文件。

#### `createZipFromDirectory(sourceDir: string): Promise<Uint8Array>`
从目录创建 ZIP 归档。压缩级别 6，保留 Unix 权限位，跳过 `.git` 和符号链接目录。

#### `extractZipToDirectory(zipPath: string, targetDir: string): Promise<void>`
提取 ZIP 到目标目录，恢复可执行权限位。

#### `convertDirectoryToZipInPlace(dirPath: string, zipPath: string): Promise<void>`
将目录转换为 ZIP（压缩 → 原子写入 → 删除原目录）。

#### `isMarketplaceSourceSupportedByZipCache(source: MarketplaceSource): boolean`
检查市场源类型是否被 ZIP 缓存支持（`github`/`git`/`url`/`settings`）。

### dxt/zip.ts 导出函数

#### `unzipFile(zipData: Buffer): Promise<Record<string, Uint8Array>>`
带安全校验的 ZIP 解压。在解压每个文件前检查路径安全、大小限制和压缩比。

#### `parseZipModes(data: Uint8Array): Record<string, number>`
解析 ZIP 中央目录获取 Unix 文件权限位。返回 `{ 文件名: mode }` 映射。

#### `isPathSafe(filePath: string): boolean`
检查文件路径是否安全（无路径遍历、非绝对路径）。

## 接口/类型定义

### 核心类型（schemas.ts 导出）

| 类型 | 说明 |
|------|------|
| `PluginManifest` | plugin.json 完整结构，含 name/version/commands/agents/skills/hooks/mcpServers/lspServers/userConfig/channels 等 |
| `PluginMarketplace` | marketplace.json 完整结构，含 name/owner/plugins 数组/metadata |
| `PluginMarketplaceEntry` | 市场中单个插件条目，继承 PluginManifest partial 并扩展 source/category/tags/strict |
| `MarketplaceSource` | 市场来源联合类型（url/github/git/npm/file/directory/hostPattern/pathPattern/settings） |
| `PluginSource` | 插件来源联合类型（相对路径/npm/pip/url/github/git-subdir） |
| `PluginId` | 字符串类型，格式为 `plugin-name@marketplace-name` |
| `PluginScope` | 安装作用域枚举：`managed`/`user`/`project`/`local` |
| `InstalledPlugin` | V1 安装记录（version/installedAt/installPath/gitCommitSha） |
| `PluginInstallationEntry` | V2 安装记录（增加 scope/projectPath，支持多作用域安装） |
| `KnownMarketplace` | 已注册市场元数据（source/installLocation/lastUpdated/autoUpdate） |
| `KnownMarketplacesFile` | `Record<string, KnownMarketplace>` |
| `CommandMetadata` | 命令元数据（source 或 content、description、argumentHint、model、allowedTools） |

### ValidationResult 类型（validatePlugin.ts）

```typescript
type ValidationResult = {
  success: boolean
  errors: ValidationError[]    // { path, message, code? }
  warnings: ValidationWarning[] // { path, message }
  filePath: string
  fileType: 'plugin' | 'marketplace' | 'skill' | 'agent' | 'command' | 'hooks'
}
```

## 配置项与默认值

| 环境变量 | 用途 | 默认值 |
|---------|------|--------|
| `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE` | 启用 ZIP 缓存模式 | 未设置（禁用） |
| `CLAUDE_CODE_PLUGIN_CACHE_DIR` | ZIP 缓存挂载目录路径 | 未设置 |

**InstalledPlugins 文件版本**：
- V1：每个插件 ID 映射到单个安装记录
- V2（当前）：每个插件 ID 映射到安装记录**数组**，支持同一插件在不同作用域安装不同版本

**PluginMarketplaceEntry.strict 默认值**：`true`（要求插件目录必须包含 plugin.json）

## 边界 Case 与注意事项

- **fflate 延迟导入**：`dxt/zip.ts` 和 `zipCache.ts` 都延迟导入 fflate 库，避免其 ~196KB 查找表和 `@anthropic-ai/mcpb` 的 ~700KB 闭包在启动时分配
- **Windows inode 精度**：`collectFilesForZip()` 使用 `stat({ bigint: true })` 避免 NTFS 大序列号超过 `Number.MAX_SAFE_INTEGER` 导致目录被误判为循环跳过
- **ReFS/NFS dev:ino = 0**：当文件系统报告 `dev=0 && ino=0` 时跳过循环检测而非跳过目录
- **chmod 容错**：`extractZipToDirectory()` 中 `chmod` 失败（EPERM/ENOTSUP）被静默吞掉，因为丢失 +x 优于中断提取
- **市场专属字段处理**：`validatePluginManifest()` 在 `.strict()` 校验前先剥离 marketplace-only 字段，避免同一问题被 warning + error 双重报告
- **版本优先级**：marketplace.json 中声明的 version 在安装时被忽略，`calculatePluginVersion` 优先使用 plugin.json 中的版本
- **孤儿排除缓存冻结**：一旦计算，排除列表在整个会话内不再更新（自动更新、并发会话的磁盘变更不影响），仅 `/reload-plugins` 可清除
- **ZIP64 不支持**：`parseZipModes()` 不处理 >4GB 或 >65535 条目的归档（市场 ZIP 通常 ~3.5MB）
- **`settings` 源不允许保留名称**：`SettingsMarketplacePluginSchema` 明确拒绝保留名称用于 settings 源，因为 `validateOfficialNameSource` 仅接受 github/git 源，而磁盘写入在验证之前发生