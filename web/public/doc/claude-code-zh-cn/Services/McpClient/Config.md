# MCP 服务器配置管理

## 概述与职责

`config.ts` 是 MCP（Model Context Protocol）客户端子系统的配置中枢，负责从多个来源**加载、合并、验证、过滤和持久化** MCP 服务器配置。它位于 `Services > McpClient` 层级下，是连接管理器（ConnectionManager）启动连接之前的必经环节——所有 MCP 服务器在被实际连接之前，都要经过此模块的配置解析和策略过滤。

`envExpansion.ts` 是一个辅助模块，提供环境变量展开能力，支持 `${VAR}` 和 `${VAR:-default}` 语法。

### 在系统中的位置

- **上级模块**：McpClient（MCP 客户端实现）
- **同级兄弟模块**：连接管理器、权限控制（channelPermissions/Allowlist）、认证流程（OAuth/XAA）、claude.ai 集成、官方注册表查询等
- **被谁调用**：CLI 入口（`main.tsx` 的 `--mcp-config`）、SDK 控制消息（`print.ts`）、`/mcp` 命令 UI、插件系统

## 配置来源与作用域

模块定义了 6 种配置作用域（`ConfigScope`），按优先级从低到高排列：

| 作用域 | 来源 | 说明 |
|--------|------|------|
| `claudeai` | claude.ai 远程获取 | 用户在 claude.ai Web UI 中启用的 MCP 连接器，优先级最低 |
| `plugin` | 插件系统 | 通过插件机制注册的 MCP 服务器，键名以 `plugin:name:server` 命名 |
| `user` | 全局配置文件 | `getGlobalConfig().mcpServers`，用户级别 |
| `project` | `.mcp.json` 文件 | 从 CWD 向上遍历目录查找，靠近 CWD 的文件优先级更高 |
| `local` | 项目本地配置 | `getCurrentProjectConfig().mcpServers`，不提交到版本控制 |
| `enterprise` | 企业托管配置 | `managed-mcp.json`，一旦存在则**独占控制**所有 MCP 服务器 |

合并顺序体现在 `getClaudeCodeMcpConfigs()` 中（`src/services/mcp/config.ts:1232-1238`）：

```typescript
const configs = Object.assign(
  {},
  dedupedPluginServers,
  userServers,
  approvedProjectServers,
  localServers,
)
```

后面的 `Object.assign` 会覆盖前面的同名键，因此 `local > project > user > plugin`。

## 关键流程

### 1. 配置加载与合并流程（getClaudeCodeMcpConfigs）

这是最核心的函数，完整路径为 `src/services/mcp/config.ts:1071-1251`。

1. **检查企业模式**：如果 `doesEnterpriseMcpConfigExist()` 返回 true，直接只加载企业配置并应用策略过滤，**忽略所有其他来源**
2. **检查插件锁定**：如果 `isRestrictedToPluginOnly('mcp')` 为 true，user/project/local 三个作用域返回空，但保留插件服务器
3. **加载各作用域**：并行从 user、project、local 加载配置
4. **加载插件服务器**：调用 `loadAllPluginsCacheOnly()` 获取插件列表，再通过 `getPluginMcpServers()` 提取每个插件的 MCP 服务器
5. **过滤项目服务器**：project 作用域的服务器需要 `getProjectMcpServerStatus(name) === 'approved'` 才能通过
6. **去重插件服务器**：调用 `dedupPluginMcpServers()` 基于签名去重，手动配置优先于插件配置
7. **合并所有来源**：按优先级 `Object.assign` 合并
8. **策略过滤**：最终对合并结果调用 `isMcpServerAllowedByPolicy()` 逐一检查

### 2. 包含 claude.ai 的完整加载（getAllMcpConfigs）

`src/services/mcp/config.ts:1258-1290`

1. 并行发起 claude.ai 连接器的远程获取（`fetchClaudeAIMcpConfigsIfEligible()`）
2. 调用 `getClaudeCodeMcpConfigs()`，将 claude.ai Promise 作为 `extraDedupTargets` 传入以实现并行
3. 对 claude.ai 结果应用策略过滤
4. 调用 `dedupClaudeAiMcpServers()` 去除与手动配置重复的连接器
5. 合并：claude.ai 优先级最低

### 3. 环境变量展开流程

`expandEnvVars()`（`src/services/mcp/config.ts:556-616`）根据服务器类型展开不同字段：

- **stdio 类型**：展开 `command`、`args` 数组中每个元素、`env` 对象的每个值
- **sse/http/ws 类型**：展开 `url` 和 `headers` 的每个值
- **sse-ide/ws-ide/sdk/claudeai-proxy 类型**：不做展开

底层由 `envExpansion.ts` 的 `expandEnvVarsInString()` 实现（`src/services/mcp/envExpansion.ts:10-38`），使用正则 `/\$\{([^}]+)\}/g` 匹配，支持：
- `${VAR}`：从 `process.env` 读取，未找到则记录为 missing
- `${VAR:-default}`：未找到时使用默认值

### 4. 策略过滤流程（allowlist + denylist）

策略检查分两层（`src/services/mcp/config.ts:364-508`）：

**Denylist 优先**：`isMcpServerDenied()` 先检查 `deniedMcpServers`，支持三种匹配方式：
- 按 `serverName` 名称匹配
- 按 `serverCommand` 命令数组精确匹配（stdio 类型）
- 按 `serverUrl` URL 通配符匹配（远程类型）

**Allowlist 次之**：`isMcpServerAllowedByPolicy()` 检查 `allowedMcpServers`：
- 未定义 → 全部允许
- 空数组 → 全部拒绝
- stdio 服务器：如果存在 command 类型条目则必须匹配其一；否则回退到名称匹配
- 远程服务器：如果存在 URL 类型条目则必须匹配其一；否则回退到名称匹配

**策略来源隔离**（`src/services/mcp/config.ts:341-355`）：
- Allowlist：当 `allowManagedMcpServersOnly` 为 true 时，只从 `policySettings` 读取；否则从合并设置读取
- Denylist：始终从所有来源合并——用户可以自行拒绝服务器

### 5. 去重机制

模块通过"签名"（signature）进行内容级去重，`getMcpServerSignature()`（`src/services/mcp/config.ts:202-212`）：

- stdio 类型：`stdio:${JSON.stringify([command, ...args])}`
- 远程类型：`url:${unwrapCcrProxyUrl(url)}`（CCR 代理 URL 会被解包为原始 URL）
- sdk 类型：返回 null（不参与去重）

两个去重函数：
- **`dedupPluginMcpServers()`**：手动配置优先于插件；插件之间先加载的优先
- **`dedupClaudeAiMcpServers()`**：只有**已启用**的手动配置才能抑制 claude.ai 连接器

## 函数签名

### 公开 API

#### `addMcpConfig(name: string, config: unknown, scope: ConfigScope): Promise<void>`

添加 MCP 服务器配置。执行以下校验：
- 名称只允许 `[a-zA-Z0-9_-]`
- 保留名称检查（`claude-in-chrome`、computer-use）
- 企业配置存在时禁止添加
- Zod schema 验证（`McpServerConfigSchema`）
- denylist/allowlist 策略检查
- 目标作用域中不能已存在同名服务器

> 源码位置：`src/services/mcp/config.ts:625-761`

#### `removeMcpConfig(name: string, scope: ConfigScope): Promise<void>`

删除指定作用域中的 MCP 服务器配置。仅支持 `project`、`user`、`local` 三个作用域。

> 源码位置：`src/services/mcp/config.ts:769-834`

#### `getClaudeCodeMcpConfigs(dynamicServers?, extraDedupTargets?): Promise<{servers, errors}>`

获取所有 Claude Code 管理的 MCP 配置（不含 claude.ai）。这是**快速路径**——只做本地文件读取，无网络调用。

> 源码位置：`src/services/mcp/config.ts:1071-1251`

#### `getAllMcpConfigs(): Promise<{servers, errors}>`

获取所有 MCP 配置，包含 claude.ai 远程连接器。可能较慢（涉及网络请求）。

> 源码位置：`src/services/mcp/config.ts:1258-1290`

#### `getMcpConfigByName(name: string): ScopedMcpServerConfig | null`

按名称查找服务器配置，优先级：enterprise > local > project > user。

> 源码位置：`src/services/mcp/config.ts:1033-1060`

#### `getMcpConfigsByScope(scope): {servers, errors}`

获取特定作用域的所有 MCP 配置。`project` 作用域会从 CWD 向上遍历所有父目录查找 `.mcp.json`。

> 源码位置：`src/services/mcp/config.ts:888-1026`

#### `parseMcpConfig(params): {config, errors}`

解析并验证 MCP 配置对象。使用 Zod schema 校验，可选地展开环境变量。

> 源码位置：`src/services/mcp/config.ts:1297-1377`

#### `parseMcpConfigFromFilePath(params): {config, errors}`

从文件路径读取并解析 MCP 配置。处理文件不存在、JSON 解析失败等错误。

> 源码位置：`src/services/mcp/config.ts:1384-1468`

#### `filterMcpServersByPolicy<T>(configs): {allowed, blocked}`

对一组配置应用策略过滤。SDK 类型服务器豁免检查。

> 源码位置：`src/services/mcp/config.ts:536-551`

#### `isMcpServerDisabled(name: string): boolean`

检查服务器是否被禁用。普通服务器通过 `disabledMcpServers` 列表判断；内置默认禁用的服务器（如 computer-use）通过 `enabledMcpServers` 判断。

> 源码位置：`src/services/mcp/config.ts:1528-1536`

#### `setMcpServerEnabled(name: string, enabled: boolean): void`

启用或禁用服务器，写入项目本地配置。

> 源码位置：`src/services/mcp/config.ts:1553-1578`

#### `getMcpServerSignature(config: McpServerConfig): string | null`

计算服务器配置的去重签名。

> 源码位置：`src/services/mcp/config.ts:202-212`

#### `unwrapCcrProxyUrl(url: string): string`

将 CCR 代理 URL 还原为原始 vendor URL。用于去重时匹配同一 MCP 服务器的不同 URL 形式。

> 源码位置：`src/services/mcp/config.ts:182-193`

#### `dedupPluginMcpServers(pluginServers, manualServers): {servers, suppressed}`

去重插件 MCP 服务器。返回过滤后的服务器和被抑制的条目列表。

> 源码位置：`src/services/mcp/config.ts:223-266`

#### `dedupClaudeAiMcpServers(claudeAiServers, manualServers): {servers, suppressed}`

去重 claude.ai 连接器。只有已启用的手动配置才算有效去重目标。

> 源码位置：`src/services/mcp/config.ts:281-310`

### envExpansion.ts

#### `expandEnvVarsInString(value: string): {expanded: string, missingVars: string[]}`

展开字符串中的环境变量引用。支持 `${VAR}` 和 `${VAR:-default}` 语法。未找到且无默认值的变量会保留原始 `${VAR}` 文本并记入 `missingVars`。

> 源码位置：`src/services/mcp/envExpansion.ts:10-38`

## 文件写入机制

`writeMcpjsonFile()`（`src/services/mcp/config.ts:88-131`）实现了安全的原子写入：

1. 读取现有文件的权限模式（`stat`）
2. 写入临时文件 `${mcpJsonPath}.tmp.${pid}.${timestamp}`
3. 调用 `handle.datasync()` 确保数据刷盘
4. 恢复原文件权限到临时文件
5. 原子重命名 `rename(tempPath, mcpJsonPath)`
6. 失败时清理临时文件

这确保了在写入过程中断电或崩溃时不会损坏原配置文件。

## 配置项与默认值

### 内置默认禁用服务器

当 `CHICAGO_MCP` feature flag 启用时，computer-use MCP 服务器默认禁用，需要用户通过 `enabledMcpServers` 显式启用（`src/services/mcp/config.ts:1512-1521`）。

### 企业策略选项

| 设置项 | 类型 | 说明 |
|--------|------|------|
| `allowedMcpServers` | 数组 | 白名单，支持按名称/命令/URL 匹配 |
| `deniedMcpServers` | 数组 | 黑名单，优先级高于白名单 |
| `allowManagedMcpServersOnly` | boolean | 为 true 时白名单只从 policySettings 读取 |

### URL 通配符匹配

`urlPatternToRegex()`（`src/services/mcp/config.ts:320-326`）支持 `*` 通配符：
- `https://example.com/*` 匹配 `https://example.com/api/v1`
- `https://*.example.com/*` 匹配 `https://api.example.com/path`

## 边界 Case 与注意事项

- **企业配置独占**：一旦 `managed-mcp.json` 存在且解析成功，所有其他来源（user/project/local/plugin/claudeai）的配置均被忽略。`addMcpConfig()` 也会直接报错拒绝
- **project 作用域的目录遍历**：`getMcpConfigsByScope('project')` 会从 CWD 向上逐级查找 `.mcp.json`，从根目录向 CWD 方向处理，靠近 CWD 的同名服务器覆盖远处的
- **project 服务器需要审批**：project 作用域的服务器必须通过 `getProjectMcpServerStatus()` 返回 `'approved'` 才会被纳入（安全机制，防止恶意 `.mcp.json`）
- **SDK 类型豁免策略检查**：`filterMcpServersByPolicy()` 对 `type: 'sdk'` 的服务器直接放行，因为 SDK 管理的传输不由 CLI 发起连接
- **禁用的服务器不参与去重**：只有已启用且通过策略的服务器才是有效的去重目标，防止"两者都不运行"的死锁
- **Windows npx 警告**：在 Windows 平台上，如果 stdio 服务器的 command 是 `npx`，会产生警告建议使用 `cmd /c npx` 包装
- **`doesEnterpriseMcpConfigExist` 被 memoize**：结果在进程生命周期内缓存，不会重复读取文件
- **CCR 代理 URL 解包**：远程会话中 claude.ai 连接器的 URL 会被重写为 CCR 代理路径，去重时通过 `unwrapCcrProxyUrl()` 提取 `mcp_url` 查询参数还原原始 URL