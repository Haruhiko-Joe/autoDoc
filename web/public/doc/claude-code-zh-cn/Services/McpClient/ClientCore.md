# MCP 客户端核心实现（ClientCore）

## 概述与职责

ClientCore 是 MCP（Model Context Protocol）客户端的核心实现模块，位于 `Services > McpClient` 层级中。它负责管理 Claude Code 与外部 MCP 工具服务器之间的全部通信生命周期——从建立连接、获取工具/资源/命令列表，到执行工具调用、处理认证与重连。

本模块由三个文件组成：
- **`client.ts`**（约 3350 行）：中枢文件，包含连接管理、工具/资源获取、工具调用、认证缓存、结果处理等全部核心逻辑
- **`InProcessTransport.ts`**：同进程双向管道传输，用于不需要子进程的 MCP 服务器（如 Chrome MCP）
- **`SdkControlTransport.ts`**：SDK 控制消息桥接传输，用于 SDK 进程内 MCP 服务器与 CLI 进程的通信

在整体架构中，本模块被 `ToolOrchestration` 服务调用以执行外部工具，被 `SkillsAndPlugins` 依赖以构建技能，同时也被 `Analytics` 模块记录连接和调用事件。同级的 `ApiClient` 负责与 Claude API 通信，`OAuthService` 为本模块提供认证支持。

## 支持的传输协议

`connectToServer` 函数（`client.ts:595-1641`）根据服务器配置的 `type` 字段选择不同的传输协议：

| 协议类型 | 配置 type | 说明 |
|----------|-----------|------|
| stdio | `stdio` 或缺省 | 启动子进程，通过 stdin/stdout 通信，是默认协议 |
| SSE | `sse` | Server-Sent Events，支持 OAuth 认证 |
| Streamable HTTP | `http` | HTTP 长连接，支持 OAuth 和 session ingress token |
| WebSocket | `ws` | WebSocket 连接，支持 mTLS 和代理 |
| SSE-IDE | `sse-ide` | IDE 专用 SSE 连接，无需认证 |
| WS-IDE | `ws-ide` | IDE 专用 WebSocket 连接，支持 auth token header |
| claude.ai proxy | `claudeai-proxy` | 通过 claude.ai 代理 URL 连接，使用 OAuth bearer token |
| SDK | `sdk` | SDK 进程内服务器，通过 `SdkControlClientTransport` 桥接 |
| In-process | 自动检测 | Chrome MCP 和 Computer Use MCP 使用 `InProcessTransport` 同进程运行 |

## 关键流程

### 1. 服务器连接流程

入口函数 `getMcpToolsCommandsAndResources`（`client.ts:2226`）协调全部服务器的连接：

1. 从配置中读取所有 MCP 服务器，过滤禁用的服务器
2. 将服务器分为本地组（stdio/sdk）和远程组，分别使用不同的并发度（本地默认 3，远程默认 20）
3. 对需要认证的远程服务器，检查 `needs-auth` 缓存（15 分钟 TTL），命中则跳过连接
4. 调用 `connectToServer` 创建传输层和 MCP SDK `Client` 实例
5. 通过 `Promise.race` 实现连接超时（默认 30 秒，可通过 `MCP_TIMEOUT` 环境变量配置）
6. 连接成功后，并行获取工具列表、命令列表、技能和资源列表

```
connectToServer (memoized by server name + config)
  ├── 创建 Transport（根据 type 选择）
  ├── 创建 MCP SDK Client 实例
  ├── Client.connect(transport) + 超时竞争
  ├── 注册 ListRoots handler（返回当前工作目录）
  ├── 注册 Elicitation handler
  ├── 设置 onerror/onclose handler（连接恢复逻辑）
  └── 返回 MCPServerConnection
```

### 2. 工具调用流程

当模型请求调用某个 MCP 工具时，执行链路为：

1. `MCPTool.call()`（`client.ts:1833`）被调用，发出进度事件 `started`
2. `ensureConnectedClient()`（`client.ts:1688`）确保连接有效，必要时重连
3. `callMCPToolWithUrlElicitationRetry()`（`client.ts:2813`）处理 URL elicitation 重试
4. `callMCPTool()`（`client.ts:3029`）执行实际的 SDK `client.callTool()` 调用
5. `processMCPResult()`（`client.ts:2720`）处理结果——包含截断、持久化大结果到文件、图片压缩
6. 如遇 session 过期（HTTP 404 + JSON-RPC -32001），清除缓存并抛出 `McpSessionExpiredError`，上层最多重试 1 次

> 工具调用超时默认约 27.8 小时（`DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000`），可通过 `MCP_TOOL_TIMEOUT` 环境变量覆盖。

### 3. 连接恢复与错误处理

`client.ts:1216-1401` 中的 `onerror`/`onclose` handler 实现了多层错误恢复：

1. **Session 过期检测**：HTTP 404 + JSON-RPC `-32001`，立即关闭传输触发重连
2. **SSE 重连耗尽**：SDK 内部 SSE 重连失败后触发 `Maximum reconnection attempts`，关闭传输
3. **终端错误累计**：`ECONNRESET`/`ETIMEDOUT`/`EPIPE` 等错误连续出现 3 次后触发重连
4. **`onclose` 清理**：清除 `connectToServer` memoize 缓存和所有 fetch 缓存，下次操作自动重连

### 4. 认证状态管理

认证相关的状态通过以下机制管理：

- **`needs-auth` 缓存**（`client.ts:257-316`）：基于文件的缓存（`~/.claude/mcp-needs-auth-cache.json`），15 分钟 TTL，避免反复对需要认证的服务器发起连接
- **`ClaudeAuthProvider`**：SSE 和 HTTP 传输的 OAuth 认证提供者
- **`createClaudeAiProxyFetch`**（`client.ts:372-422`）：为 claude.ai 代理连接封装 fetch，自动附加 OAuth bearer token 并在 401 时重试一次
- **`McpAuthError`**（`client.ts:152`）：工具调用遇到 401 时抛出，上层据此将服务器状态标记为 `needs-auth`
- **`wrapFetchWithStepUpDetection`**：检测 403 响应中的 step-up auth 要求

## 函数签名与关键导出

### `connectToServer(name, serverRef, serverStats?): Promise<MCPServerConnection>`

核心连接函数，使用 `lodash.memoize` 缓存（key 为 `name + JSON.stringify(config)`）。返回 `connected`、`failed` 或 `needs-auth` 三种状态。

> 源码位置：`client.ts:595-1641`

### `ensureConnectedClient(client): Promise<ConnectedMCPServer>`

确保连接有效。如果 memoize 缓存被 `onclose` 清除，会自动触发重连。SDK 类型服务器直接返回。

> 源码位置：`client.ts:1688-1704`

### `fetchToolsForClient(client): Promise<Tool[]>`

获取服务器工具列表，LRU 缓存（容量 20）。将 MCP 工具转换为内部 `Tool` 格式，包括权限检查、并发安全标记、只读标记等。工具描述超过 2048 字符时截断。

> 源码位置：`client.ts:1743-1998`

### `fetchResourcesForClient(client): Promise<ServerResource[]>`

获取服务器资源列表，LRU 缓存。为每个资源附加 `server` 字段标识来源。

> 源码位置：`client.ts:2000-2031`

### `fetchCommandsForClient(client): Promise<Command[]>`

获取服务器 prompts 并转换为 `Command` 格式（斜杠命令），支持参数解析。

> 源码位置：`client.ts:2033-2107`

### `callMCPTool({client, tool, args, meta, signal, onProgress}): Promise<MCPToolCallResult>`

执行实际的工具调用。实现了超时控制、进度日志（每 30 秒）、错误分类（401/session 过期/abort）。

> 源码位置：`client.ts:3029-3245`

### `callMCPToolWithUrlElicitationRetry(opts): Promise<MCPToolCallResult>`

包装 `callMCPTool`，处理 `-32042 UrlElicitationRequired` 错误。最多重试 3 次。支持 hook 自动处理、print/SDK 模式委托、REPL 模式 UI 队列三种 elicitation 响应方式。

> 源码位置：`client.ts:2813-3027`

### `getMcpToolsCommandsAndResources(onConnectionAttempt, mcpConfigs?): Promise<void>`

批量连接所有配置的 MCP 服务器，通过回调逐个报告连接结果。本地和远程服务器并行处理，各自有独立的并发上限。

> 源码位置：`client.ts:2226-2403`

### `setupSdkMcpClients(sdkMcpConfigs, sendMcpMessage): Promise<{clients, tools}>`

为 SDK 进程内的 MCP 服务器创建 `SdkControlClientTransport` 并连接，并行处理所有配置。

> 源码位置：`client.ts:3262-3348`

### `wrapFetchWithTimeout(baseFetch): FetchLike`

为每个 POST 请求添加 60 秒超时（GET 请求豁免，因为 SSE 流需要长时间保持）。同时确保 Streamable HTTP 规范要求的 `Accept` header。

> 源码位置：`client.ts:492-550`

### `createClaudeAiProxyFetch(innerFetch): FetchLike`

为 claude.ai 代理连接包装 fetch 函数，自动附加 OAuth bearer token。401 时尝试刷新 token 后重试一次。

> 源码位置：`client.ts:372-422`

## 自定义传输实现

### InProcessTransport

`InProcessTransport.ts` 实现了一个同进程内的双向管道传输，无需启动子进程。

- `createLinkedTransportPair()` 创建一对互联的传输实例，一端的 `send()` 通过 `queueMicrotask()` 异步投递到另一端的 `onmessage`
- `close()` 会同时关闭对端
- 用于 Chrome MCP 服务器和 Computer Use MCP 服务器的进程内运行，避免 ~325 MB 的子进程开销

> 源码位置：`InProcessTransport.ts:1-63`

### SdkControlTransport

`SdkControlTransport.ts` 实现 CLI 进程与 SDK 进程之间的 MCP 消息桥接，分为两个类：

**`SdkControlClientTransport`**（CLI 侧）：
- `send()` 将 JSON-RPC 消息通过 `sendMcpMessage` 回调发送到 SDK 进程
- 收到响应后调用 `onmessage` 回传给 MCP Client
- 消息通过 stdout 控制请求传递，包含 `server_name` 路由信息

**`SdkControlServerTransport`**（SDK 侧）：
- 接收来自 CLI 的控制请求，通过 `onmessage` 传递给 MCP Server
- Server 的响应通过 `send()` → `sendMcpMessage` 回调返回
- 支持多个 SDK MCP 服务器同时运行

> 源码位置：`SdkControlTransport.ts:1-137`

## 错误类型

| 错误类 | 用途 |
|--------|------|
| `McpAuthError` | 工具调用遇 401，触发服务器状态切换为 `needs-auth` |
| `McpSessionExpiredError` | Session 过期（404 + `-32001`），触发缓存清除和重试 |
| `McpToolCallError` | 工具返回 `isError: true`，携带 `_meta` 信息 |

## 配置项与默认值

| 配置 | 来源 | 默认值 | 说明 |
|------|------|--------|------|
| `MCP_TIMEOUT` | 环境变量 | 30000ms | 连接超时时间 |
| `MCP_TOOL_TIMEOUT` | 环境变量 | ~27.8 小时 | 工具调用超时时间 |
| `MCP_SERVER_CONNECTION_BATCH_SIZE` | 环境变量 | 3 | 本地服务器并发连接数 |
| `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` | 环境变量 | 20 | 远程服务器并发连接数 |
| `ENABLE_MCP_LARGE_OUTPUT_FILES` | 环境变量 | truthy | 大结果是否持久化到文件 |
| `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` | 环境变量 | falsy | SDK MCP 工具是否跳过 `mcp__` 前缀 |
| `CLAUDE_CODE_SHELL_PREFIX` | 环境变量 | - | stdio 服务器命令前缀覆盖 |
| `MAX_MCP_DESCRIPTION_LENGTH` | 常量 | 2048 | 工具描述和服务器指令的最大字符数 |
| `MCP_AUTH_CACHE_TTL_MS` | 常量 | 15 分钟 | needs-auth 缓存有效期 |
| `MCP_REQUEST_TIMEOUT_MS` | 常量 | 60000ms | 单次 HTTP 请求超时（`wrapFetchWithTimeout`） |

## 边界 Case 与注意事项

- **SSE EventSource 不受超时限制**：`wrapFetchWithTimeout` 仅对 POST 请求生效，GET 请求（SSE 长连接）豁免，否则 60 秒后会断开 SSE 流
- **IDE 工具白名单**：IDE 服务器的工具只暴露 `mcp__ide__executeCode` 和 `mcp__ide__getDiagnostics`，其余被过滤（`client.ts:568-573`）
- **工具描述截断**：MCP 服务器（尤其是 OpenAPI 生成的）可能返回 15-60KB 的描述，会被截断到 2048 字符
- **Memoize 缓存一致性**：`connectToServer` 的 memoize 使用 `name + JSON(config)` 作为 key。`onclose` 触发时会同时清除连接缓存和所有 fetch 缓存，确保重连后获取最新的工具列表
- **进程清理信号升级**：stdio 服务器关闭时按 SIGINT → SIGTERM → SIGKILL 逐步升级，总时间不超过 600ms（`client.ts:1429-1558`）
- **并发写入序列化**：needs-auth 缓存写入通过 promise chain 序列化（`client.ts:291`），防止多服务器同时 401 时的读写竞争
- **Token 竞态处理**：`createClaudeAiProxyFetch` 捕获请求时的 token 而非事后重读，避免并发 401 下另一个连接器刷新 token 导致重试被跳过的问题