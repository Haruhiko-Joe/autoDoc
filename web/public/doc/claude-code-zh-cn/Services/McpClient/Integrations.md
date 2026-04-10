# Integrations（外部服务集成）

## 概述与职责

本模块属于 **Services → McpClient** 层级，负责将 Claude Code 与多种外部 MCP 服务源集成。它包含四个独立子模块，各自处理一种集成场景：

| 子模块 | 职责 |
|--------|------|
| `claudeai.ts` | 从 claude.ai 组织配置拉取 MCP 服务器列表 |
| `officialRegistry.ts` | 预加载 Anthropic 官方 MCP 注册表，判断 URL 是否为官方认证 |
| `vscodeSdkMcp.ts` | 与 VS Code 扩展建立双向 MCP 通信 |
| `elicitationHandler.ts` | 处理 MCP 服务器发起的 elicitation（用户输入收集）请求 |

同级模块包括 ApiClient（API 通信）、OAuthService（认证）、Analytics（遥测）等，本模块与它们协作实现完整的 MCP 客户端能力。

---

## claudeai.ts — Claude.ai 组织 MCP 服务器获取

### 关键流程

`fetchClaudeAIMcpConfigsIfEligible` 是本文件的核心函数，使用 `lodash-es/memoize` 做会话级缓存（每个 CLI 会话只拉取一次）。完整流程：

1. **环境变量检查**：若 `ENABLE_CLAUDEAI_MCP_SERVERS` 被显式设为 falsy 值，直接返回空对象（`src/services/mcp/claudeai.ts:42-49`）
2. **OAuth 令牌获取**：调用 `getClaudeAIOAuthTokens()` 获取访问令牌。无令牌则退出（`src/services/mcp/claudeai.ts:51-59`）
3. **权限范围校验**：检查 token 是否包含 `user:mcp_servers` scope。这里有一个重要设计决策——直接检查 scope 而非调用 `isClaudeAISubscriber()`，因为在非交互模式下（同时设置了 `ANTHROPIC_API_KEY` 和 OAuth token），后者会错误返回 false（`src/services/mcp/claudeai.ts:61-75`）
4. **API 调用**：向 `{BASE_API_URL}/v1/mcp_servers?limit=1000` 发送 GET 请求，携带 Bearer Token 和 `anthropic-beta: mcp-servers-2025-12-04` 头（`src/services/mcp/claudeai.ts:77-90`）
5. **名称去重**：遍历返回的服务器列表，为每个服务器生成 `claude.ai {display_name}` 格式的名称。若规范化后的名称冲突，自动追加 `(2)`、`(3)` 等后缀（`src/services/mcp/claudeai.ts:92-118`）
6. **返回配置**：每个服务器被封装为 `ScopedMcpServerConfig`，type 为 `'claudeai-proxy'`，scope 为 `'claudeai'`

每一步都通过 `logEvent` 记录遥测事件（事件名 `tengu_claudeai_mcp_eligibility`），携带不同的 state 标记。

### 函数签名

#### `fetchClaudeAIMcpConfigsIfEligible(): Promise<Record<string, ScopedMcpServerConfig>>`

会话级 memoized 函数。返回以服务器名称为 key、`ScopedMcpServerConfig` 为 value 的字典。

#### `clearClaudeAIMcpConfigsCache(): void`

清除 memoize 缓存和 MCP 认证缓存。登录后应调用此函数，确保下次拉取使用新 token。

#### `markClaudeAiMcpConnected(name: string): void`

将一个 claude.ai MCP 连接器标记为"曾经成功连接过"。写入全局配置的 `claudeAiMcpEverConnected` 数组，幂等操作。用于启动通知的状态变化检测——只有之前连接成功过但现在失败的连接器才值得通知用户。

#### `hasClaudeAiMcpEverConnected(name: string): boolean`

检查某个连接器是否曾经成功连接过。

### 类型定义

#### `ClaudeAIMcpServer`

```typescript
type ClaudeAIMcpServer = {
  type: 'mcp_server'
  id: string
  display_name: string
  url: string
  created_at: string
}
```

API 返回的单个 MCP 服务器信息。

#### `ClaudeAIMcpServersResponse`

```typescript
type ClaudeAIMcpServersResponse = {
  data: ClaudeAIMcpServer[]
  has_more: boolean
  next_page: string | null
}
```

分页响应结构（当前实现通过 `limit=1000` 一次性拉取，未处理分页）。

### 配置项

- **`ENABLE_CLAUDEAI_MCP_SERVERS`**：环境变量，设为 falsy 值可禁用此功能
- **`FETCH_TIMEOUT_MS`**：请求超时 5000ms
- **`MCP_SERVERS_BETA_HEADER`**：Beta 功能头 `mcp-servers-2025-12-04`

---

## officialRegistry.ts — 官方 MCP 注册表

### 关键流程

采用 fire-and-forget 模式预加载注册表数据，供后续同步查询。

1. **预加载**（`prefetchOfficialMcpUrls`）：向 `https://api.anthropic.com/mcp-registry/v0/servers?version=latest&visibility=commercial` 发送 GET 请求（`src/services/mcp/officialRegistry.ts:39-41`）
2. **URL 规范化**：遍历所有服务器条目的 `remotes[].url`，移除查询字符串和尾部斜杠，存入模块级 `Set<string>`（`src/services/mcp/officialRegistry.ts:44-53`）
3. **查询**（`isOfficialMcpUrl`）：直接对 Set 做 `has()` 查找。如果注册表尚未加载（undefined），返回 false（fail-closed 策略）

### 函数签名

#### `prefetchOfficialMcpUrls(): Promise<void>`

预加载官方注册表。若环境变量 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 已设置则跳过。超时 5000ms。

#### `isOfficialMcpUrl(normalizedUrl: string): boolean`

判断给定 URL 是否在官方注册表中。入参需已通过 `getLoggingSafeMcpBaseUrl` 规范化。注册表未加载时返回 false。

#### `resetOfficialMcpUrlsForTesting(): void`

测试辅助函数，重置内部 URL 集合。

### 边界 Case 与注意事项

- 注册表加载失败时不会抛出异常，只记录错误日志；后续 `isOfficialMcpUrl` 一律返回 false
- URL 规范化逻辑：`new URL(url)` → 清除 `search` → 移除尾部 `/`，与 `getLoggingSafeMcpBaseUrl` 的规范化方式保持一致

---

## vscodeSdkMcp.ts — VS Code IDE 集成

### 关键流程

`setupVscodeSdkMcp` 在 SDK 客户端列表中查找名为 `claude-vscode` 的已连接 MCP 客户端，建立双向通知通道：

1. **查找客户端**：从 `sdkClients` 中找到 `name === 'claude-vscode'` 且 `type === 'connected'` 的连接（`src/services/mcp/vscodeSdkMcp.ts:65-67`）
2. **注册日志通知处理器**：监听 VS Code 发来的 `log_event` 通知，转发为 `tengu_vscode_{eventName}` 遥测事件（`src/services/mcp/vscodeSdkMcp.ts:71-80`）
3. **推送实验开关**：将当前的 feature gate 状态（`tengu_vscode_review_upsell`、`tengu_vscode_onboarding`、`tengu_quiet_fern`、`tengu_vscode_cc_auth`）以及 auto mode 三态值通过 `experiment_gates` 通知发送给 VS Code（`src/services/mcp/vscodeSdkMcp.ts:83-110`）

### 函数签名

#### `setupVscodeSdkMcp(sdkClients: MCPServerConnection[]): void`

初始化 VS Code MCP 集成。设置通知处理器并推送实验配置。

#### `notifyVscodeFileUpdated(filePath: string, oldContent: string | null, newContent: string | null): void`

当 Claude 编辑或写入文件时，向 VS Code 发送 `file_updated` 通知。仅在 `USER_TYPE === 'ant'` 且 VS Code 客户端已连接时生效。通知失败静默处理。

### 类型定义

#### `LogEventNotificationSchema`

```typescript
z.object({
  method: z.literal('log_event'),
  params: z.object({
    eventName: z.string(),
    eventData: z.object({}).passthrough(),
  }),
})
```

VS Code 发来的日志事件通知格式。使用 `lazySchema` 延迟初始化。

#### `AutoModeEnabledState`

三态类型 `'enabled' | 'disabled' | 'opt-in'`，从 `tengu_auto_mode_config` feature flag 读取，未知时不发送给 VS Code（fail-closed）。

### 边界 Case 与注意事项

- `notifyVscodeFileUpdated` 受 `USER_TYPE === 'ant'` 门控，仅 Anthropic 内部用户可用
- 通知发送使用 `void ... .catch()` 模式，不阻塞主流程，失败仅记录调试日志
- `AutoModeEnabledState` 独立定义而非从 `permissionSetup.ts` 导入，原因是后者依赖链过重

---

## elicitationHandler.ts — Elicitation 请求处理

### 概述

Elicitation 是 MCP 协议中服务器向客户端发起的交互式请求，用于收集用户输入。本模块处理两种模式：**form**（表单收集）和 **url**（引导用户打开浏览器完成操作）。

### 关键流程

#### 请求注册与分发

`registerElicitationHandler` 为 MCP 客户端注册两个处理器：

**1. Elicitation 请求处理器**（`ElicitRequestSchema`，`src/services/mcp/elicitationHandler.ts:77-171`）：

1. 收到请求后先运行 **elicitation hooks**（`runElicitationHooks`），hook 可以程序化地直接提供响应，跳过用户交互
2. 若 hook 未处理，创建一个 `ElicitationRequestEvent` 并追加到 `AppState.elicitation.queue` 中
3. 通过 `setAppState` 更新 UI 状态，UI 层渲染对应的交互对话框
4. 等待用户响应（Promise resolve）或请求中断（AbortSignal → 返回 `{ action: 'cancel' }`)
5. 用户响应后运行 **elicitation result hooks**（`runElicitationResultHooks`），hook 可以修改或阻止响应
6. 返回最终结果给 MCP 服务器

**2. 完成通知处理器**（`ElicitationCompleteNotificationSchema`，`src/services/mcp/elicitationHandler.ts:175-207`）：

用于 URL 模式——当用户在浏览器完成操作后，服务器发送完成通知，处理器在队列中找到对应事件并设置 `completed: true`，触发 UI 更新。

#### Hook 机制

**`runElicitationHooks`**（`src/services/mcp/elicitationHandler.ts:214-257`）：
- 调用 `executeElicitationHooks` 执行注册的前置 hook
- hook 可返回 `blockingError`（转为 `decline`）或 `elicitationResponse`（直接返回给服务器）
- 异常时返回 undefined（不阻止流程）

**`runElicitationResultHooks`**（`src/services/mcp/elicitationHandler.ts:264-313`）：
- 在用户响应之后、返回服务器之前执行
- hook 可覆盖 action/content 或阻止响应（`blockingError` → `decline`）
- 无论成功或失败，都会触发 `elicitation_response` 类型的通知 hook

### 函数签名

#### `registerElicitationHandler(client: Client, serverName: string, setAppState: (f: (prevState: AppState) => AppState) => void): void`

为指定 MCP 客户端注册 elicitation 请求和完成通知处理器。若客户端未声明 elicitation capability 则静默跳过。

#### `runElicitationHooks(serverName: string, params: ElicitRequestParams, signal: AbortSignal): Promise<ElicitResult | undefined>`

执行前置 hook。返回 `ElicitResult` 表示 hook 已处理请求；返回 `undefined` 表示需要用户交互。

#### `runElicitationResultHooks(serverName: string, result: ElicitResult, signal: AbortSignal, mode?: 'form' | 'url', elicitationId?: string): Promise<ElicitResult>`

执行后置 hook，可修改用户的响应结果。

### 类型定义

#### `ElicitationRequestEvent`

| 字段 | 类型 | 说明 |
|------|------|------|
| `serverName` | `string` | 发起请求的 MCP 服务器名称 |
| `requestId` | `string \| number` | JSON-RPC 请求 ID |
| `params` | `ElicitRequestParams` | 请求参数（消息、schema、URL 等） |
| `signal` | `AbortSignal` | 中断信号 |
| `respond` | `(response: ElicitResult) => void` | 解决 elicitation 的回调 |
| `waitingState` | `ElicitationWaitingState` | URL 模式下浏览器打开后的等待状态配置 |
| `onWaitingDismiss` | `(action) => void` | 等待阶段被用户操作关闭时的回调 |
| `completed` | `boolean` | 服务器确认完成时设为 true |

#### `ElicitationWaitingState`

```typescript
type ElicitationWaitingState = {
  actionLabel: string      // 按钮标签，如 "Retry now"
  showCancel?: boolean     // 是否显示取消按钮
}
```

### 边界 Case 与注意事项

- **Abort 处理**：如果请求的 `AbortSignal` 已经处于 aborted 状态，立即返回 `{ action: 'cancel' }`，不会将事件推入队列
- **客户端能力检查**：`setRequestHandler` 在客户端未声明 elicitation capability 时会抛异常，外层 try/catch 静默处理
- **完成通知匹配**：通过 `serverName` + `elicitationId` 在队列中查找，找不到则忽略并记录调试日志
- **Hook 失败安全**：前置 hook 异常返回 undefined（继续正常流程），后置 hook 异常返回原始用户响应并触发通知