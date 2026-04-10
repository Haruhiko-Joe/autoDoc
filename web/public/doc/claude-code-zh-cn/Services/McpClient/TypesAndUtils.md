# 共享类型定义与工具函数（TypesAndUtils）

## 概述与职责

本模块是 MCP（Model Context Protocol）客户端子系统的**类型基础与通用工具层**，位于 `Services > McpClient` 架构层级之下。它为 MCP 客户端的连接管理、工具调度、权限校验等上层模块提供：

- **核心类型体系**：配置作用域、传输协议、各协议配置 Schema、服务器连接状态等（`types.ts`）
- **通用工具函数**：按服务器过滤/排除工具与命令、配置变更检测、安全 URL 提取、Agent MCP 信息构建等（`utils.ts`）
- **名称解析与构建**：MCP 工具名称的解析（`mcp__server__tool` 格式）、前缀生成、显示名称提取等（`mcpStringUtils.ts`）
- **名称规范化**：将任意服务器/工具名称转换为 API 兼容格式（`normalization.ts`）
- **动态请求头获取**：通过外部脚本获取 MCP 服务器的认证头（`headersHelper.ts`）

同级兄弟模块包括 MCP 连接管理器、权限控制（channelPermissions/Allowlist）、OAuth/XAA 认证流程、环境变量展开等，它们均依赖本模块提供的类型和工具函数。

---

## 关键类型定义（types.ts）

### ConfigScope — 配置作用域枚举

定义 MCP 服务器配置的来源/作用域，共 7 种（`src/services/mcp/types.ts:10-20`）：

| 值 | 含义 |
|---|---|
| `local` | 本地配置（仅当前用户在当前项目可见） |
| `user` | 用户全局配置（所有项目共享） |
| `project` | 项目配置（通过 `.mcp.json` 共享） |
| `dynamic` | 动态配置（命令行传入） |
| `enterprise` | 企业配置（组织统一管理） |
| `claudeai` | claude.ai 代理服务器 |
| `managed` | 远程托管配置 |

### Transport — 传输协议枚举

支持的 MCP 传输协议（`src/services/mcp/types.ts:23-25`）：`stdio`、`sse`、`sse-ide`、`http`、`ws`、`sdk`。

### 各传输协议配置 Schema

每种传输协议对应一个 Zod Schema，用于配置验证：

| Schema | type 字段 | 关键配置项 | 说明 |
|--------|----------|-----------|------|
| `McpStdioServerConfigSchema` | `stdio`（可选，向后兼容） | `command`, `args`, `env` | 本地进程通信 |
| `McpSSEServerConfigSchema` | `sse` | `url`, `headers`, `headersHelper`, `oauth` | Server-Sent Events |
| `McpSSEIDEServerConfigSchema` | `sse-ide` | `url`, `ideName` | IDE 扩展内部使用 |
| `McpWebSocketIDEServerConfigSchema` | `ws-ide` | `url`, `ideName`, `authToken` | IDE WebSocket 内部使用 |
| `McpHTTPServerConfigSchema` | `http` | `url`, `headers`, `headersHelper`, `oauth` | Streamable HTTP |
| `McpWebSocketServerConfigSchema` | `ws` | `url`, `headers`, `headersHelper` | WebSocket |
| `McpSdkServerConfigSchema` | `sdk` | `name` | SDK 内嵌服务器 |
| `McpClaudeAIProxyServerConfigSchema` | `claudeai-proxy` | `url`, `id` | claude.ai 代理 |

`McpServerConfigSchema` 是所有协议 Schema 的联合类型（`src/services/mcp/types.ts:124-135`）。

其中 SSE、HTTP 和 WebSocket 配置支持 **OAuth 认证**（`McpOAuthConfigSchema`），包含 `clientId`、`callbackPort`、`authServerMetadataUrl` 和 **XAA（Cross-App Access）** 标志。XAA 的 IdP 连接细节由全局 `settings.xaaIdp` 提供，此处仅为布尔开关。

### ScopedMcpServerConfig

在 `McpServerConfig` 基础上附加 `scope`（配置来源）和可选的 `pluginSource`（插件来源标识，用于 channel gate 权限判断）：

```typescript
export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  pluginSource?: string
}
```

### MCPServerConnection — 服务器连接状态

一个判别联合类型（discriminated union），表示 MCP 服务器的五种连接状态（`src/services/mcp/types.ts:221-226`）：

| 类型 | type 字段 | 特有字段 |
|------|----------|---------|
| `ConnectedMCPServer` | `connected` | `client`, `capabilities`, `serverInfo`, `instructions`, `cleanup` |
| `FailedMCPServer` | `failed` | `error` |
| `NeedsAuthMCPServer` | `needs-auth` | — |
| `PendingMCPServer` | `pending` | `reconnectAttempt`, `maxReconnectAttempts` |
| `DisabledMCPServer` | `disabled` | — |

所有状态都包含 `name` 和 `config: ScopedMcpServerConfig`。

### MCPCliState — CLI 序列化状态

用于 CLI 层序列化 MCP 状态（`src/services/mcp/types.ts:252-258`），包含 `clients`、`configs`、`tools`、`resources` 和可选的 `normalizedNames`（规范化名到原始名的映射）。

---

## 关键流程

### 工具/命令按服务器过滤与排除

`utils.ts` 提供了一组对称的过滤函数，用于在 MCP 服务器连接/断开时维护工具和命令列表：

1. **过滤（保留指定服务器的）**：`filterToolsByServer`、`filterCommandsByServer`、`filterResourcesByServer` — 通过 `mcp__<normalized_name>__` 前缀匹配
2. **排除（移除指定服务器的）**：`excludeToolsByServer`、`excludeCommandsByServer`、`excludeResourcesByServer`
3. **命令归属判断** `commandBelongsToServer`（`src/services/mcp/utils.ts:52-62`）同时匹配两种命名格式：
   - MCP prompts：`mcp__<server>__<prompt>`
   - MCP skills：`<server>:<skill>`

`filterMcpPromptsByServer` 进一步区分了 prompts 和 skills，排除 `loadedFrom === 'mcp'` 的 skill 条目，确保 `/mcp` 菜单中 prompts 计数准确。

### 过期插件客户端清理

`excludeStalePluginClients`（`src/services/mcp/utils.ts:185-224`）是 `/reload-plugins` 时调用的核心函数：

1. 遍历所有已连接客户端，判断是否过期：
   - **配置消失**：仅对 `scope === 'dynamic'` 的客户端标记过期（避免误断非动态服务器）
   - **配置变更**：通过 `hashMcpConfig` 比较配置哈希，任何 scope 均适用
2. 对过期客户端，移除其关联的 tools、commands、resources
3. 返回清理后的状态和过期客户端列表（供调用方执行 `clearServerCache` 断开连接）

`hashMcpConfig`（`src/services/mcp/utils.ts:157-169`）使用 SHA-256 对配置做稳定哈希，排除 `scope` 字段（配置来源不影响实际连接），且对 key 排序确保 `{a:1,b:2}` 和 `{b:2,a:1}` 哈希一致。

### 项目 MCP 服务器审批流程

`getProjectMcpServerStatus`（`src/services/mcp/utils.ts:351-406`）决定项目级 MCP 服务器的审批状态：

1. 检查 `disabledMcpjsonServers` → 若匹配返回 `'rejected'`
2. 检查 `enabledMcpjsonServers` 或 `enableAllProjectMcpServers` → 若匹配返回 `'approved'`
3. 在 `--dangerously-skip-permissions` 模式下且 `projectSettings` 启用 → 自动 `'approved'`
   - **安全设计**：仅通过 `hasSkipDangerousModePermissionPrompt()` 检查，不读取 projectSettings 中的 bypass 标志（防止恶意仓库通过项目设置自动批准 RCE）
4. 非交互模式（SDK/`-p`/管道输入）且 `projectSettings` 启用 → 自动 `'approved'`
5. 否则返回 `'pending'`（等待用户确认）

### MCP 工具名称解析与构建

`mcpStringUtils.ts` 实现工具名称的双向转换：

- **解析** `mcpInfoFromString("mcp__server__tool")` → `{ serverName: "server", toolName: "tool" }`（`src/services/mcp/mcpStringUtils.ts:19-32`）
- **构建** `buildMcpToolName("my-server", "my-tool")` → `"mcp__my_server__my_tool"`（规范化后拼接）
- **已知限制**：服务器名包含 `__` 时解析不正确（实际罕见）

`getToolNameForPermissionCheck`（`src/services/mcp/mcpStringUtils.ts:60-67`）为权限检查返回完全限定名，防止 deny 规则（如禁止内置 "Write"）误匹配同名的 MCP 工具。

### 动态请求头获取

`headersHelper.ts` 的 `getMcpServerHeaders` 合并静态 `headers` 和动态 `headersHelper` 脚本返回的 headers（动态覆盖静态）。

`getMcpHeadersFromHelper`（`src/services/mcp/headersHelper.ts:32-117`）的执行流程：

1. **安全检查**：对 project/local 作用域的配置，非交互模式下跳过，否则要求 workspace trust 已确认
2. 通过 `execFileNoThrow` 执行 `headersHelper` 指定的 shell 脚本，超时 10 秒
3. 注入环境变量 `CLAUDE_CODE_MCP_SERVER_NAME` 和 `CLAUDE_CODE_MCP_SERVER_URL`，使一个脚本可服务多个 MCP 服务器
4. 解析脚本 stdout 为 JSON 对象，验证所有值为 string 类型
5. 失败时返回 `null`（不阻塞连接），同时记录错误日志

---

## 函数签名与参数说明

### 名称规范化

#### `normalizeNameForMCP(name: string): string`

将名称转换为 API 兼容格式 `^[a-zA-Z0-9_-]{1,64}$`（`src/services/mcp/normalization.ts:17-23`）。

- 将所有非法字符替换为 `_`
- 对 `claude.ai ` 前缀的服务器名额外折叠连续下划线并去除首尾下划线，防止干扰 `__` 分隔符

### 工具/命令过滤

| 函数 | 参数 | 返回值 |
|------|------|--------|
| `filterToolsByServer(tools, serverName)` | Tool 数组, 服务器名 | 属于该服务器的 Tool 数组 |
| `excludeToolsByServer(tools, serverName)` | Tool 数组, 服务器名 | 不属于该服务器的 Tool 数组 |
| `filterCommandsByServer(commands, serverName)` | Command 数组, 服务器名 | 属于该服务器的 Command 数组 |
| `excludeCommandsByServer(commands, serverName)` | Command 数组, 服务器名 | 不属于该服务器的 Command 数组 |
| `filterResourcesByServer(resources, serverName)` | ServerResource 数组, 服务器名 | 属于该服务器的资源 |
| `excludeResourcesByServer(resources, serverName)` | 资源 Record, 服务器名 | 移除该服务器后的资源 Record |

### 状态与配置查询

| 函数 | 说明 |
|------|------|
| `isMcpTool(tool)` | 判断工具是否来自 MCP 服务器（前缀 `mcp__` 或 `isMcp === true`） |
| `isMcpCommand(command)` | 判断命令是否来自 MCP 服务器 |
| `isToolFromMcpServer(toolName, serverName)` | 判断工具名是否属于特定服务器 |
| `getMcpServerScopeFromToolName(toolName)` | 从工具名提取 ConfigScope，`claude_ai_` 前缀自动识别为 `'claudeai'` |
| `getProjectMcpServerStatus(serverName)` | 返回 `'approved' \| 'rejected' \| 'pending'` |
| `describeMcpConfigFilePath(scope)` | 返回配置文件路径的描述字符串 |
| `getScopeLabel(scope)` | 返回作用域的用户友好标签 |
| `ensureConfigScope(scope?)` | 验证并返回 ConfigScope，默认 `'local'` |
| `ensureTransport(type?)` | 验证并返回传输类型，默认 `'stdio'` |

### Agent MCP 信息提取

#### `extractAgentMcpServers(agents: AgentDefinition[]): AgentMcpServerInfo[]`

从 Agent frontmatter 中提取 MCP 服务器定义并按服务器名分组（`src/services/mcp/utils.ts:466-553`）。跳过字符串引用（已在全局配置中）和不支持的内部传输类型（`sdk`、`claudeai-proxy`、`sse-ide`、`ws-ide`）。结果按名称排序。

### 安全 URL 提取

#### `getLoggingSafeMcpBaseUrl(config: McpServerConfig): string | undefined`

提取 URL 的 base 部分用于分析日志（`src/services/mcp/utils.ts:561-575`）。剥除 query string（可能含 access token）和尾部斜杠。对 stdio/sdk 类型返回 `undefined`。

### 请求头工具

| 函数 | 说明 |
|------|------|
| `getMcpServerHeaders(serverName, config)` | 合并静态 headers 与 headersHelper 动态 headers（动态优先） |
| `getMcpHeadersFromHelper(serverName, config)` | 执行外部脚本获取动态 headers |
| `parseHeaders(headerArray: string[])` | 解析 `"Key: Value"` 格式的字符串数组为 Record |

---

## 边界 Case 与注意事项

- **`McpStdioServerConfig` 的 `type` 字段可选**：为了向后兼容，`type` 字段未设置时默认视为 `stdio`。类型守卫 `isStdioConfig` 同时检查 `type === 'stdio'` 和 `type === undefined`
- **服务器名含 `__` 时的解析歧义**：`mcpInfoFromString` 以第一个 `__` 分隔，`"mcp__my__server__tool"` 会解析为 `server="my"`、`tool="server__tool"`
- **headersHelper 安全限制**：项目/本地作用域的 headersHelper 在交互模式下需要 workspace trust 已确认才会执行，防止未经信任的仓库执行任意脚本
- **hashMcpConfig 排除 scope**：配置从 `.mcp.json` 移到 `settings.json`（scope 变化）不会触发重连
- **getProjectMcpServerStatus 的安全模型**：刻意不通过 `getSessionBypassPermissionsMode()` 检查，因为该值可被 project settings 设置，存在恶意仓库 RCE 风险
- **headersHelper 环境变量**：注入 `CLAUDE_CODE_MCP_SERVER_NAME` 和 `CLAUDE_CODE_MCP_SERVER_URL`，允许一个脚本为多个服务器提供不同 headers