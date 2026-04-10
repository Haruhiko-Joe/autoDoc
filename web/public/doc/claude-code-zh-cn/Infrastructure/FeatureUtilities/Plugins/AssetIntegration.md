# 插件资产加载与集成层（AssetIntegration）

## 概述与职责

AssetIntegration 是插件系统的**资产注册层**，负责将插件声明的各类资产（Hook、斜杠命令、技能、Agent、输出样式、LSP 服务器、MCP 服务器）加载并注册到应用运行时。它位于 Infrastructure → FeatureUtilities → Plugins 层级中，是插件生命周期管理系统的下游消费者——pluginLoader 发现并加载插件后，本模块将插件内容转化为应用可用的运行时资源。

同级兄弟模块包括：插件发现与加载（pluginLoader）、市场管理（marketplaceManager）、安装与版本控制、启动检查与策略等。本模块与 Hooks 框架（AsyncHookRegistry）直接交互，将插件 Hook 注册到全局 Hook 系统中。

本模块由 9 个文件组成，核心职责按资产类型分为：

| 文件 | 职责 | 行数 |
|------|------|------|
| `loadPluginHooks.ts` | Hook 注册与热重载 | 288 |
| `loadPluginCommands.ts` | 斜杠命令与技能加载 | 947 |
| `loadPluginAgents.ts` | Agent 定义加载 | 349 |
| `loadPluginOutputStyles.ts` | 自定义输出样式加载 | 179 |
| `lspPluginIntegration.ts` | LSP 服务器配置集成 | 388 |
| `mcpPluginIntegration.ts` | MCP 服务器集成 | 635 |
| `mcpbHandler.ts` | MCPB/DXT 文件处理 | 968 |
| `pluginOptionsStorage.ts` | 插件用户配置管理 | 401 |
| `walkPluginMarkdown.ts` | Markdown 文件遍历 | 70 |

## 关键流程

### 1. Hook 注册流程（loadPluginHooks）

核心入口是 `loadPluginHooks()`（memoized），流程如下：

1. 调用 `loadAllPluginsCacheOnly()` 获取所有已启用插件列表
2. 遍历每个插件的 `hooksConfig`，通过 `convertPluginHooksToMatchers()` 将插件 Hook 配置转换为 `PluginHookMatcher`，附加 `pluginRoot`、`pluginName`、`pluginId` 上下文（`loadPluginHooks.ts:28-86`）
3. 将所有插件 Hook 合并到一个按事件类型索引的 Record 中
4. **原子交换**：先 `clearRegisteredPluginHooks()` 再 `registerHookCallbacks()`——这两步必须作为一对执行，避免清除后到重新注册之间的窗口期导致 Hook 丢失（修复 gh-29767）

支持的 Hook 事件多达 27 种，包括 `PreToolUse`、`PostToolUse`、`SessionStart`、`Stop`、`FileChanged` 等（`loadPluginHooks.ts:31-59`）。

**热重载机制**：`setupPluginHookHotReload()` 订阅 `settingsChangeDetector`，当 `policySettings` 变更时，对比插件相关设置快照（包含 `enabledPlugins`、`extraKnownMarketplaces`、`strictKnownMarketplaces`、`blockedMarketplaces` 四个字段），仅在实际变更时触发重新加载（`loadPluginHooks.ts:233-287`）。

**剪枝机制**：`pruneRemovedPluginHooks()` 在 `clearAllCaches()` 时调用，只移除已禁用插件的 Hook，不添加新插件的 Hook——与命令/Agent/MCP 的行为一致（`loadPluginHooks.ts:179-207`）。

### 2. 命令与技能加载流程（loadPluginCommands）

`getPluginCommands()` 和 `getPluginSkills()` 是两个独立的 memoized 入口，分别从插件的 `commandsPath`/`commandsPaths` 和 `skillsPath`/`skillsPaths` 加载。

**命令加载核心链路**：

1. 调用 `collectMarkdownFiles()` 递归收集目录中的 `.md` 文件
2. `transformPluginSkillFiles()` 处理技能目录——如果目录包含 `SKILL.md`，只保留该文件
3. `getCommandNameFromFile()` 根据文件路径生成命名空间化的命令名（格式：`pluginName:namespace:commandName`）
4. `createPluginCommand()` 将 Markdown 文件转换为 `Command` 对象

**`createPluginCommand()` 的关键处理**（`loadPluginCommands.ts:218-412`）：
- 从 frontmatter 解析：`description`、`allowed-tools`、`argument-hint`、`arguments`、`when_to_use`、`model`、`effort`、`disable-model-invocation`、`user-invocable`、`shell` 等
- `allowed-tools` 中的 `${CLAUDE_PLUGIN_ROOT}` 会被替换为实际路径
- `getPromptForCommand()` 在运行时执行多层变量替换：
  - `substituteArguments()` 替换命令参数
  - `substitutePluginVariables()` 替换 `${CLAUDE_PLUGIN_ROOT}` 和 `${CLAUDE_PLUGIN_DATA}`
  - `substituteUserConfigInContent()` 替换 `${user_config.X}`（敏感键替换为占位符）
  - `${CLAUDE_SKILL_DIR}` 替换为技能子目录路径
  - `${CLAUDE_SESSION_ID}` 替换为当前会话 ID
  - `executeShellCommandsInPrompt()` 执行内嵌的 shell 命令

**命令来源的三种方式**：
- 默认 `commandsPath` 目录下的 `.md` 文件
- `commandsPaths` 指定的额外路径（支持目录和单文件）
- `commandsMetadata` 中指定的内联内容（无源文件，`content` 字段直接提供 Markdown）

**技能加载**：`getPluginSkills()` → `loadSkillsFromDirectory()` 扫描目录中包含 `SKILL.md` 的子目录，每个技能命令带有 `isSkillMode: true` 标记和基目录前缀。

### 3. Agent 加载流程（loadPluginAgents）

`loadPluginAgents()` 的结构与命令加载类似，但产出 `AgentDefinition` 而非 `Command`：

1. 遍历 `agentsPath` 和 `agentsPaths`，使用 `walkPluginMarkdown()` 收集 `.md` 文件
2. `loadAgentFromFile()` 解析 frontmatter 中的 Agent 配置（`loadPluginAgents.ts:65-229`）：
   - `whenToUse`：Agent 使用场景描述
   - `tools`：可用工具列表；若启用了自动记忆（`memory` 字段），自动注入 Write/Edit/Read 工具
   - `skills`：可用技能列表
   - `model`：支持 `inherit` 继承父级模型
   - `background`/`isolation`/`effort`/`maxTurns` 等执行参数
   - `memory`：记忆范围（`user`/`project`/`local`）

**安全限制**：`permissionMode`、`hooks`、`mcpServers` 三个字段在插件 Agent 中被**故意忽略**（`loadPluginAgents.ts:153-168`）。这些字段会突破用户在安装时批准的权限边界——如果需要这些能力，应在 `.claude/agents/` 中定义 Agent。

### 4. 输出样式加载流程（loadPluginOutputStyles）

`loadPluginOutputStyles()` 从 `outputStylesPath` 和 `outputStylesPaths` 加载 `.md` 文件，转换为 `OutputStyleConfig`。每个样式包含：`name`（命名空间化）、`description`、`prompt`（Markdown 内容作为提示词）、`source: 'plugin'`，以及可选的 `forceForPlugin` 标志（强制该插件使用此输出样式）。

### 5. LSP 服务器集成流程（lspPluginIntegration）

`loadPluginLspServers()` 从两个来源加载 LSP 配置（`lspPluginIntegration.ts:57-122`）：

1. **`.lsp.json` 文件**：插件根目录下的独立 JSON 配置（优先级较低）
2. **`manifest.lspServers` 字段**：支持三种格式——字符串（文件路径）、内联对象、或两者混合的数组

所有配置通过 `LspServerConfigSchema` 进行 Zod 校验。

**环境变量解析**（`resolvePluginLspEnvironment()`，`lspPluginIntegration.ts:229-292`）：
- `${CLAUDE_PLUGIN_ROOT}` 和 `${CLAUDE_PLUGIN_DATA}` 替换
- `${user_config.X}` 替换（需要 `manifest.userConfig`）
- 一般环境变量 `${VAR}` 展开
- 自动注入 `CLAUDE_PLUGIN_ROOT` 和 `CLAUDE_PLUGIN_DATA` 到 `env` 中

**作用域隔离**：`addPluginScopeToLspServers()` 为服务器名添加 `plugin:${pluginName}:` 前缀，避免不同插件间的命名冲突。

**路径安全**：`validatePathWithinPlugin()` 防止路径遍历攻击——通过 `resolve()` + `relative()` 确保引用路径不超出插件目录。

### 6. MCP 服务器集成流程（mcpPluginIntegration）

`loadPluginMcpServers()` 支持更多来源（`mcpPluginIntegration.ts:131-212`）：

1. `.mcp.json` 文件（最低优先级）
2. `manifest.mcpServers`：支持字符串（文件路径或 MCPB 引用）、内联对象、数组

**MCPB 文件处理**：当 `mcpServers` 指向 `.mcpb` 或 `.dxt` 文件时，委托给 `mcpbHandler.ts` 处理（见下一节）。

**环境变量解析**（`resolvePluginMcpEnvironment()`）与 LSP 类似，但根据服务器类型分别处理：
- `stdio` 类型：解析 `command`、`args`、`env`
- `sse`/`http`/`ws` 类型：解析 `url`、`headers`
- `sse-ide`/`ws-ide`/`sdk`/`claudeai-proxy`：直接透传

**用户配置合并**（`buildMcpUserConfig()`，`mcpPluginIntegration.ts:440-458`）：
- 顶层 `manifest.userConfig` 值 + 频道级 `channels[].userConfig` 值
- 频道级优先，同名键覆盖顶层

**未配置频道检测**：`getUnconfiguredChannels()` 检查哪些频道的必填配置尚未填写，供 ManagePlugins UI 显示配置对话框。

### 7. MCPB/DXT 文件处理流程（mcpbHandler）

`loadMcpbFile()` 是完整的 MCPB/DXT 处理流程（`mcpbHandler.ts:698-968`）：

```
检查缓存 → [命中且未变] → 读取缓存 manifest → 检查 user_config → 生成 MCP 配置
    ↓ [未命中/已变]
下载/读取 MCPB 文件 → 计算 SHA256 哈希 → 解压 ZIP → 解析 manifest.json
    → 提取文件到缓存目录 → 检查 user_config → 保存缓存元数据 → 生成 MCP 配置
```

**缓存策略**：
- 缓存位于 `${pluginPath}/.mcpb-cache/` 目录
- 元数据文件以源的 MD5 哈希前 8 位命名（`${hash}.metadata.json`）
- 本地文件通过 `mtime` 比较判断是否过期；URL 类型在显式更新时重新检查
- 提取目录以内容 SHA256 哈希前 16 位命名

**用户配置处理**：
- 如果 DXT manifest 声明了 `user_config`，检查已保存配置是否满足所有必填字段
- 未满足时返回 `McpbNeedsConfigResult`（`status: 'needs-config'`），由 UI 层提示用户配置
- 配置保存通过 `saveMcpServerUserConfig()` 拆分为敏感/非敏感存储

**下载与提取**：
- `downloadMcpb()` 使用 axios 下载，支持进度回调、重定向、2 分钟超时
- `extractMcpbContents()` 解压并写入文件，通过 `parseZipModes()` 保留可执行位（native MCP server binary 场景）
- 文本文件（`.json`/`.js`/`.ts`/`.md` 等）以 UTF-8 写入，其他以二进制写入

### 8. 插件用户配置管理（pluginOptionsStorage）

**存储拆分**（`pluginOptionsStorage.ts:1-13` 注释说明）：
- `sensitive: true` 的字段 → secureStorage（macOS keychain / `.credentials.json` 0600 权限）
- 其他字段 → `settings.json` 的 `pluginConfigs[pluginId].options`

**`loadPluginOptions()`**（memoized per pluginId）：
- 读取 settings.json 非敏感值 + secureStorage 敏感值
- secureStorage 在键冲突时优先
- memoize 减少 macOS keychain spawn（约 50-100ms/次）

**`savePluginOptions()`**（`pluginOptionsStorage.ts:90-194`）：
- 按 `schema[key].sensitive` 拆分为敏感和非敏感
- 先写 secureStorage（失败则不动 settings.json，保留旧值为 fallback）
- 再写 settings.json，同时通过 `undefined` 值触发 `mergeWith` 删除已迁移到 secureStorage 的键

**`deletePluginOptions()`**：删除插件的所有配置——settings.json 中的 `pluginConfigs[pluginId]` 和 secureStorage 中的 `pluginSecrets[pluginId]` 及其 per-server 复合键。

**变量替换函数**：
- `substitutePluginVariables()`：替换 `${CLAUDE_PLUGIN_ROOT}` 和 `${CLAUDE_PLUGIN_DATA}`，Windows 上自动规范化反斜杠
- `substituteUserConfigVariables()`：替换 `${user_config.X}`，缺失键时**抛出异常**（用于 MCP/LSP 环境变量）
- `substituteUserConfigInContent()`：替换 `${user_config.X}` 的内容安全版本——敏感键替换为 `[sensitive option 'X' not available in skill content]`，缺失键保留原样（用于技能/Agent 提示词）

### 9. Markdown 遍历工具（walkPluginMarkdown）

`walkPluginMarkdown()` 是一个简洁的递归目录遍历器（`walkPluginMarkdown.ts:21-69`）：

- 对每个 `.md` 文件调用 `onFile(fullPath, namespace)` 回调
- `namespace` 数组跟踪相对于根目录的路径层级
- `stopAtSkillDir: true` 时，包含 `SKILL.md` 的目录作为叶子容器，不再递归
- 目录并行扫描（`Promise.all`），readdir 错误被吞掉并记录

## 函数签名与参数说明

### Hook 相关

#### `loadPluginHooks(): Promise<void>`
加载并注册所有已启用插件的 Hook。memoized——只执行一次，通过 `clearPluginHookCache()` 重置。

#### `setupPluginHookHotReload(): void`
设置插件 Hook 热重载监听。幂等，只订阅一次 `settingsChangeDetector`。

#### `pruneRemovedPluginHooks(): Promise<void>`
移除已禁用插件的 Hook，保留仍启用插件的 Hook。不添加新插件的 Hook。

### 命令相关

#### `getPluginCommands(): Promise<Command[]>`
加载所有已启用插件的斜杠命令。memoized。`--bare` 模式下跳过（除非有显式 `--plugin-dir`）。

#### `getPluginSkills(): Promise<Command[]>`
加载所有已启用插件的技能（`SKILL.md`）。memoized。

### Agent 相关

#### `loadPluginAgents(): Promise<AgentDefinition[]>`
加载所有已启用插件的 Agent 定义。memoized。

### LSP 相关

#### `loadPluginLspServers(plugin, errors?): Promise<Record<string, LspServerConfig> | undefined>`
从单个插件加载 LSP 服务器配置。

#### `getPluginLspServers(plugin, errors?): Promise<Record<string, ScopedLspServerConfig> | undefined>`
获取单个插件的 LSP 服务器配置（带环境变量解析和作用域前缀）。

#### `extractLspServersFromPlugins(plugins, errors?): Promise<Record<string, ScopedLspServerConfig>>`
从所有已启用插件批量提取 LSP 服务器配置。

### MCP 相关

#### `loadPluginMcpServers(plugin, errors?): Promise<Record<string, McpServerConfig> | undefined>`
从单个插件加载 MCP 服务器配置（支持 `.mcp.json`、manifest 声明、MCPB 文件）。

#### `getPluginMcpServers(plugin, errors?): Promise<Record<string, ScopedMcpServerConfig> | undefined>`
获取单个插件的 MCP 服务器配置（带环境变量解析和作用域前缀）。

#### `extractMcpServersFromPlugins(plugins, errors?): Promise<Record<string, ScopedMcpServerConfig>>`
从所有已启用插件批量提取 MCP 服务器配置。并行加载，per-server try/catch 防止一个坏配置导致整体加载失败。

### MCPB 相关

#### `loadMcpbFile(source, pluginPath, pluginId, onProgress?, providedUserConfig?, forceConfigDialog?): Promise<McpbLoadResult | McpbNeedsConfigResult>`
加载并提取 MCPB/DXT 文件，带缓存和用户配置支持。返回成功结果或 `needs-config` 状态。

#### `saveMcpServerUserConfig(pluginId, serverName, config, schema): void`
保存 MCP 服务器用户配置，按敏感性拆分存储。

### 配置相关

#### `loadPluginOptions(pluginId: string): PluginOptionValues`
加载插件选项值，合并 settings.json 和 secureStorage。memoized per pluginId。

#### `savePluginOptions(pluginId, values, schema): void`
保存插件选项值，按敏感性拆分存储，成功后清除缓存。

#### `deletePluginOptions(pluginId: string): void`
删除插件的所有存储选项（settings.json + secureStorage）。

## 类型定义

### `McpbLoadResult`
```typescript
type McpbLoadResult = {
  manifest: McpbManifest     // DXT manifest 解析结果
  mcpConfig: McpServerConfig // 生成的 MCP 配置
  extractedPath: string      // 提取目录路径
  contentHash: string        // 内容 SHA256 哈希前 16 位
}
```

### `McpbNeedsConfigResult`
```typescript
type McpbNeedsConfigResult = {
  status: 'needs-config'
  manifest: McpbManifest
  extractedPath: string
  contentHash: string
  configSchema: UserConfigSchema    // 需要用户填写的配置 schema
  existingConfig: UserConfigValues  // 已保存的配置值
  validationErrors: string[]        // 校验失败原因
}
```

### `UnconfiguredChannel`
```typescript
type UnconfiguredChannel = {
  server: string            // MCP 服务器名
  displayName: string       // UI 显示名称
  configSchema: UserConfigSchema // 需要配置的字段
}
```

### `McpbCacheMetadata`
```typescript
type McpbCacheMetadata = {
  source: string         // 原始来源（URL 或路径）
  contentHash: string    // SHA256 哈希
  extractedPath: string  // 提取目录路径
  cachedAt: string       // 缓存时间 ISO 字符串
  lastChecked: string    // 最后检查时间
}
```

## 配置项与默认值

| 配置项 | 来源 | 说明 |
|--------|------|------|
| `enabledPlugins` | settings.json | 插件启用状态 |
| `extraKnownMarketplaces` | settings.json | 额外的已知市场 |
| `strictKnownMarketplaces` | policySettings | 严格的已知市场列表 |
| `blockedMarketplaces` | policySettings | 被屏蔽的市场列表 |
| `pluginConfigs[pluginId].options` | settings.json | 非敏感插件配置值 |
| `pluginConfigs[pluginId].mcpServers[serverName]` | settings.json | MCP 服务器非敏感配置 |
| `pluginSecrets[pluginId]` | secureStorage | 敏感插件配置值 |
| `pluginSecrets[pluginId/serverName]` | secureStorage | MCP 服务器敏感配置 |

## 边界 Case 与注意事项

- **Hook 原子交换**：`clearRegisteredPluginHooks()` 和 `registerHookCallbacks()` 必须成对执行。之前 clear 放在 `clearPluginHookCache()` 中导致 Stop Hook 在插件管理操作后丢失（gh-29767）
- **`--bare` 模式**：`getPluginCommands()` 和 `getPluginSkills()` 在 bare 模式下返回空数组，除非有显式 `--plugin-dir`
- **热重载快照比较**：快照包含 4 个字段（不只是 `enabledPlugins`），因为远程管理设置可能只修改市场列表而不修改启用插件（#23085 / #23152）
- **敏感配置安全**：`substituteUserConfigInContent()` 对敏感键返回占位符而非实际值，因为技能/Agent 内容会作为模型提示词发送
- **secureStorage 优先写入**：保存配置时先写 secureStorage，失败则不动 settings.json——旧的明文值可作为 fallback
- **跨存储清理**：保存配置时会清理对方存储中的陈旧键（`sensitive` 标记在 schema 版本间可能翻转）
- **插件 Agent 安全边界**：`permissionMode`、`hooks`、`mcpServers` 在插件 Agent 中被忽略（PR #22558），防止第三方插件通过 Agent 文件静默提权
- **MCPB 可执行位保留**：`extractMcpbContents()` 通过 `parseZipModes()` 解析 ZIP 中的文件权限，`chmod` 失败（如 NFS）不会中断提取
- **并行加载容错**：`extractMcpServersFromPlugins()` per-server try/catch，一个 MCP 配置错误不会导致整个插件加载失败
- **Memoize 缓存管理**：每个加载函数都有对应的 `clear*Cache()` 方法，由 `/reload-plugins` 和 `clearAllCaches()` 统一调用