# MCP 连接生命周期管理（ConnectionLifecycle）

## 概述与职责

本模块负责 MCP（Model Context Protocol）客户端连接的完整生命周期管理，是 Claude Code 与外部 MCP 工具服务器交互的控制中枢。它位于 **Services → McpClient** 层级下，与同级的传输协议、权限控制、认证等模块协作，为上层的工具编排系统（ToolOrchestration）提供已就绪的 MCP 连接。

模块由三个文件组成：

| 文件 | 职责 |
|------|------|
| `useManageMCPConnections.ts` | 核心 React Hook，管理所有 MCP 服务器的连接、重连、启用/禁用、变更通知 |
| `MCPConnectionManager.tsx` | React Context 包装层，将连接管理能力通过 Context 暴露给 UI 组件 |
| `mcpServerApproval.tsx` | 项目级 MCP 服务器的首次信任审批对话框逻辑 |

## 关键流程

### 1. 应用启动时的两阶段连接初始化

`useManageMCPConnections` 在挂载时执行两阶段加载策略，确保本地配置的服务器快速可用，同时异步加载 claude.ai 云端配置：

**Phase 1 — 加载本地配置并连接**（`src/services/mcp/useManageMCPConnections.ts:878-902`）

1. 调用 `getClaudeCodeMcpConfigs(dynamicMcpConfig, claudeaiPromise)` 收集所有配置源（enterprise、global、project、local、plugin）
2. 过滤掉已禁用的服务器（`isMcpServerDisabled`）
3. 调用 `getMcpToolsCommandsAndResources()` 并发连接所有启用的服务器（fire-and-forget，不阻塞 Phase 2）

**Phase 2 — 加载 claude.ai 配置并去重连接**（`src/services/mcp/useManageMCPConnections.ts:904-963`）

1. 等待预先发起的 `fetchClaudeAIMcpConfigsIfEligible()` 完成
2. 通过 `dedupClaudeAiMcpServers()` 对 claude.ai 服务器按 URL 签名去重，避免与手动配置的服务器重复连接
3. 将新服务器以 `pending` 状态加入 AppState，然后发起连接

此 effect 的依赖项包括 `_authVersion`、`sessionId`、`_pluginReconnectKey`，因此登录/登出、会话清除（`/clear`）、插件重载（`/reload-plugins`）都会触发重新连接。

### 2. 服务器状态初始化与过期清理

在连接 effect 之前，另一个独立的 effect（`initializeServersAsPending`，`src/services/mcp/useManageMCPConnections.ts:772-854`）负责：

1. 将所有新发现的配置以 `pending` 或 `disabled` 状态注册到 AppState
2. 通过 `excludeStalePluginClients()` 检测并移除过期的插件服务器（配置已删除或 hash 变化）
3. 对过期服务器执行清理：取消重连定时器、移除 `onclose` 回调、清除服务器缓存

### 3. 连接成功后的处理（`onConnectionAttempt`）

当服务器连接成功（`client.type === 'connected'`）时，`onConnectionAttempt` 回调执行以下关键设置（`src/services/mcp/useManageMCPConnections.ts:310-763`）：

1. **注册 Elicitation 处理器**：调用 `registerElicitationHandler()` 覆盖默认处理器，将交互式请求排入 AppState 供 UI 展示
2. **设置 `onclose` 回调**：监听连接断开事件，根据传输类型决定是否自动重连
3. **注册 Channel 通知处理器**（KAIROS 特性门控）：处理 `notifications/claude/channel` 消息推送和权限回复
4. **注册列表变更通知处理器**：
   - `tools/list_changed` → 刷新工具列表
   - `prompts/list_changed` → 刷新命令/技能列表
   - `resources/list_changed` → 刷新资源列表和关联技能

### 4. 自动重连与指数退避

对于远程传输协议（SSE、HTTP、WebSocket），连接断开后会自动重连（`src/services/mcp/useManageMCPConnections.ts:356-467`）：

- **最大重试次数**：`MAX_RECONNECT_ATTEMPTS = 5`
- **退避策略**：初始 1 秒（`INITIAL_BACKOFF_MS = 1000`），每次翻倍，上限 30 秒（`MAX_BACKOFF_MS = 30000`）
- **可取消**：重连定时器存储在 `reconnectTimersRef` 中，手动重连或禁用时会取消自动重连
- **状态感知**：每次重试前检查服务器是否已被禁用，避免无效重试
- `stdio` 和 `sdk` 类型不支持自动重连，断开后直接标记为 `failed`

### 5. 批量状态更新机制

为避免多个 MCP 服务器并发连接导致的频繁 AppState 更新，模块实现了批量更新机制（`src/services/mcp/useManageMCPConnections.ts:203-308`）：

- 更新通过 `updateServer()` 排入 `pendingUpdatesRef` 队列
- 使用 16ms 定时器（`MCP_BATCH_FLUSH_MS = 16`）窗口合并多个更新
- `flushPendingUpdates()` 在单次 `setAppState` 调用中应用所有待处理更新
- 更新逻辑按服务器名称前缀（`getMcpPrefix`）替换对应的 tools/commands/resources

### 6. 启用/禁用切换（`toggleMcpServer`）

`toggleMcpServer`（`src/services/mcp/useManageMCPConnections.ts:1074-1126`）提供运行时的服务器开关：

**禁用流程**：
1. 先持久化禁用状态到磁盘（`setMcpServerEnabled(name, false)`）——这必须在清除缓存之前，因为 `onclose` 回调会检查磁盘状态来决定是否自动重连
2. 取消正在进行的自动重连
3. 断开连接并清除缓存
4. 更新 AppState 为 `disabled`（自动清空 tools/commands/resources）

**启用流程**：
1. 持久化启用状态到磁盘
2. 标记为 `pending`，发起重新连接

## 函数签名

### `useManageMCPConnections(dynamicMcpConfig, isStrictMcpConfig)`

核心 Hook，管理全部 MCP 连接生命周期。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `dynamicMcpConfig` | `Record<string, ScopedMcpServerConfig> \| undefined` | - | 通过 `--mcp-config` CLI 参数传入的动态配置 |
| `isStrictMcpConfig` | `boolean` | `false` | 严格模式下忽略所有本地/项目配置，仅使用 dynamicMcpConfig |

**返回值**：`{ reconnectMcpServer, toggleMcpServer }`

### `reconnectMcpServer(serverName: string)`

手动重连指定服务器。取消该服务器的自动重连定时器后发起新连接。

**返回值**：`Promise<{ client: MCPServerConnection; tools: Tool[]; commands: Command[]; resources?: ServerResource[] }>`

### `toggleMcpServer(serverName: string)`

切换服务器启用/禁用状态，状态持久化到磁盘。

**返回值**：`Promise<void>`

### `handleMcpjsonServerApprovals(root: Root)`

处理项目级 MCP 服务器的首次信任审批（`src/services/mcpServerApproval.tsx:15-40`）。

1. 读取 `project` 作用域的 MCP 配置
2. 过滤出状态为 `pending` 的服务器
3. 单个待审批时渲染 `MCPServerApprovalDialog`，多个时渲染 `MCPServerMultiselectDialog`
4. 复用已有的 Ink root 实例渲染，而非创建新实例

**返回值**：`Promise<void>`（对话框完成后 resolve）

## React Context 层

`MCPConnectionManager`（`src/services/mcp/MCPConnectionManager.tsx:38-72`）是一个 Context Provider 组件：

- 接收 `dynamicMcpConfig` 和 `isStrictMcpConfig` 属性
- 内部调用 `useManageMCPConnections` 获取连接管理函数
- 通过 `MCPConnectionContext` 向子组件暴露 `reconnectMcpServer` 和 `toggleMcpServer`

消费端通过两个便捷 Hook 获取能力：

- **`useMcpReconnect()`**：获取 `reconnectMcpServer` 函数
- **`useMcpToggleEnabled()`**：获取 `toggleMcpServer` 函数

两者均要求在 `MCPConnectionManager` 内使用，否则抛出异常。

## 接口/类型定义

### `MCPConnectionContextValue`

```typescript
interface MCPConnectionContextValue {
  reconnectMcpServer: (serverName: string) => Promise<{
    client: MCPServerConnection
    tools: Tool[]
    commands: Command[]
    resources?: ServerResource[]
  }>
  toggleMcpServer: (serverName: string) => Promise<void>
}
```

### `MCPConnectionManagerProps`

```typescript
interface MCPConnectionManagerProps {
  children: ReactNode
  dynamicMcpConfig: Record<string, ScopedMcpServerConfig> | undefined
  isStrictMcpConfig: boolean
}
```

### `PendingUpdate`（Hook 内部类型）

`MCPServerConnection` 的扩展，附加可选的 `tools`、`commands`、`resources` 字段。当 `type` 为 `disabled` 或 `failed` 时，这三个字段自动填充为空数组。

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_RECONNECT_ATTEMPTS` | 5 | 最大自动重连次数 |
| `INITIAL_BACKOFF_MS` | 1000 | 首次重连等待时间（毫秒） |
| `MAX_BACKOFF_MS` | 30000 | 重连等待时间上限（毫秒） |
| `MCP_BATCH_FLUSH_MS` | 16 | 状态更新批量合并窗口（毫秒） |

服务器配置来源（按优先级）：enterprise > project > global > local > plugin > claudeai。`isStrictMcpConfig = true` 时仅使用 `dynamicMcpConfig`。

## 边界 Case 与注意事项

- **stdio/sdk 不自动重连**：本地进程（stdio）和内部 SDK 连接断开后直接标记 `failed`，仅远程传输（SSE/HTTP/WebSocket）支持自动重连
- **禁用后的 onclose 竞态**：`toggleMcpServer` 必须先写磁盘再清缓存，因为 `onclose` 回调通过 `isMcpServerDisabled()` 读取磁盘状态判断是否应重连。AppState 在此时可能是过期的（代码注释中标记为已知技术债务）
- **过期服务器清理的三个风险**：当检测到配置变更导致服务器过期时（`excludeStalePluginClients`），需要依次处理：(1) 取消重连定时器避免使用旧配置 (2) 移除 `onclose` 以阻止旧闭包中的 `reconnectWithBackoff` 启动 (3) 仅对 `connected` 状态的服务器调用 `clearServerCache`，避免对未连接服务器触发真实连接
- **企业配置阻止 claude.ai 加载**：`doesEnterpriseMcpConfigExist()` 为 true 时跳过 claude.ai 配置获取
- **Channel 通知的特性门控**：Channel 推送功能受 `KAIROS` / `KAIROS_CHANNELS` feature flag 控制，Channel 权限中继额外受 `isChannelPermissionRelayEnabled()` GrowthBook 远程开关控制
- **React Compiler 优化**：`MCPConnectionManager.tsx` 已经过 React Compiler 编译，使用 `_c` 运行时进行细粒度 memoization