# 外部服务集成工具集（ExternalIntegrationTools）

## 概述与职责

外部服务集成工具集是 ToolSystem 中负责与外部服务通信的一组工具。它们将 MCP 服务器、语言服务器（LSP）、网页内容获取、网络搜索等外部能力桥接为统一的内部 Tool 接口，使 Claude Code 的核心引擎能够透明地调用这些外部资源。

在系统层级中，这些工具属于 **ToolSystem** 模块，由 `tools.ts` 中央注册表管理。ToolSystem 的上级是 **CoreEngine**（根据模型响应调度工具执行），同级兄弟包括文件操作工具（Read、Edit、Write）、Bash 工具、Agent 工具等内置工具。

本模块包含 8 个工具：

| 工具 | 核心职责 | 延迟加载 |
|------|----------|----------|
| **MCPTool** | 将 MCP 服务器工具包装为内部 Tool 接口 | 是（始终） |
| **McpAuthTool** | 为未认证的 MCP 服务器提供 OAuth 流程 | 是（伪工具） |
| **ToolSearchTool** | 延迟加载工具的关键词搜索与按名选择 | 否（模型必需） |
| **ListMcpResourcesTool** | 列出 MCP 服务器资源 | 是 |
| **ReadMcpResourceTool** | 读取指定 MCP 资源内容 | 是 |
| **LSPTool** | 调用语言服务器协议获取代码智能信息 | 是 |
| **WebFetchTool** | 获取网页内容并用 AI 摘要 | 是 |
| **WebSearchTool** | 执行网络搜索 | 是 |

## 关键流程

### 1. MCP 工具调用流程（MCPTool）

MCPTool 本身是一个**骨架工具**——它在 `MCPTool.ts` 中定义的 `name`、`description`、`prompt`、`call` 等属性全部标记为"Overridden in mcpClient.ts"。实际逻辑由 MCP 客户端在运行时注入：

1. MCP 客户端连接外部 MCP 服务器，获取工具列表
2. 对每个远程工具，克隆 MCPTool 骨架并覆写 `name`（格式为 `mcp__<server>__<tool>`）、`call`、`description` 等
3. 克隆后的工具注入 `appState.mcp.tools`，通过 ToolSearch 延迟加载

**UI 折叠分类**（`classifyForCollapse.ts`）：为优化终端输出，系统维护了一份超过 500 个已知 MCP 工具名称的白名单，将工具分为 `isSearch` 和 `isRead` 两类。匹配逻辑将工具名标准化（camelCase/kebab-case → snake_case）后查 Set。覆盖了 Slack、GitHub、Linear、Datadog、Sentry、Notion 等 40+ 主流 MCP 服务器。

> 源码位置：`src/tools/MCPTool/MCPTool.ts:27-77`，`src/tools/MCPTool/classifyForCollapse.ts:595-604`

### 2. MCP 认证流程（McpAuthTool）

当 MCP 服务器需要 OAuth 认证但尚未完成时，系统会创建一个**伪工具**替代该服务器的所有真实工具：

1. `createMcpAuthTool()` 生成一个名为 `mcp__<server>__authenticate` 的工具
2. 模型调用此工具后，触发 `performMCPOAuthFlow()`（skipBrowserOpen 模式）
3. 返回 OAuth 授权 URL 给用户，或在静默认证（如 XAA）时直接完成
4. **后台续接**：OAuth 完成后自动调用 `reconnectMcpServerImpl()`，通过前缀匹配 `mcp__<server>__*` 移除伪工具，注入真实工具

特殊处理：
- `claudeai-proxy` 类型服务器不支持此流程，提示用户通过 `/mcp` 命令手动认证
- 仅 `sse` 和 `http` 传输类型支持 OAuth

> 源码位置：`src/tools/McpAuthTool/McpAuthTool.ts:49-215`

### 3. 延迟加载与工具搜索流程（ToolSearchTool）

ToolSearchTool 是延迟加载机制的核心——它本身永不被延迟，模型需要它来加载其他工具的完整 schema。

**延迟判定逻辑**（`isDeferredTool`，`src/tools/ToolSearchTool/prompt.ts:62-108`）：
- MCP 工具始终延迟（除非设置了 `_meta['anthropic/alwaysLoad']`）
- ToolSearch 自身永不延迟
- 设有 `shouldDefer: true` 的工具被延迟
- 特殊豁免：Agent 工具（FORK_SUBAGENT 模式下）、Brief 工具、SendUserFile 工具

**搜索模式**：

1. **精确选择**（`select:Read,Edit,Grep`）：逗号分隔，在延迟工具集和全量工具集中查找
2. **关键词搜索**：解析查询词，对每个延迟工具进行评分
   - 工具名精确部分匹配：MCP 工具 12 分，常规工具 10 分
   - 工具名部分包含：MCP 工具 6 分，常规工具 5 分
   - `searchHint` 匹配：4 分
   - 描述词边界匹配：2 分
3. **必须词**（`+slack send`）：`+` 前缀的词必须出现，其余用于排名

**性能优化**：
- 工具描述通过 `memoize` 缓存，当延迟工具集变化时失效
- 预编译词边界正则，避免重复创建
- 精确匹配和 MCP 前缀匹配走快速路径

**输出格式**：返回 `tool_reference` 类型的 content block，系统自动将匹配工具的完整 schema 注入上下文。

> 源码位置：`src/tools/ToolSearchTool/ToolSearchTool.ts:186-302`（搜索算法），`src/tools/ToolSearchTool/ToolSearchTool.ts:328-434`（call 方法）

### 4. MCP 资源访问流程（ListMcpResourcesTool + ReadMcpResourceTool）

**列出资源**：
1. 可选按 `server` 名过滤 MCP 客户端
2. 对每个已连接客户端调用 `ensureConnectedClient()`（健康时为 memoize 命中，断连后重连）
3. 调用 `fetchResourcesForClient()`（LRU 缓存，启动预热，`resources/list_changed` 通知失效）

**读取资源**：
1. 验证服务器存在且已连接，且支持 resources 能力
2. 发送 `resources/read` 请求
3. 文本内容直接返回；**二进制内容**解码 base64 后持久化到磁盘（通过 `persistBinaryContent`），避免 base64 串直接进入上下文

> 源码位置：`src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts:106-139`（二进制处理）

### 5. 语言服务器调用流程（LSPTool）

LSPTool 封装了 9 种 LSP 操作，统一通过 `operation` + `filePath` + `line` + `character` 四参数调用。

**调用链**：
1. 等待 LSP 初始化完成（`waitForInitialization()`）
2. 若文件未打开，读取文件内容（限制 10MB）并执行 `textDocument/didOpen`
3. 通过 `manager.sendRequest()` 发送 LSP 请求
4. 对 `incomingCalls`/`outgoingCalls`：先执行 `textDocument/prepareCallHierarchy` 获取 `CallHierarchyItem`，再请求实际调用
5. 对定位类结果（findReferences、goToDefinition 等）：批量过滤 gitignored 文件（`git check-ignore`，每批 50 路径）
6. 通过 `formatters.ts` 中的格式化函数转换为人类可读文本

**支持的操作**：

| 操作 | LSP 方法 | 说明 |
|------|----------|------|
| `goToDefinition` | `textDocument/definition` | 跳转定义 |
| `findReferences` | `textDocument/references` | 查找引用 |
| `hover` | `textDocument/hover` | 悬浮信息 |
| `documentSymbol` | `textDocument/documentSymbol` | 文档符号 |
| `workspaceSymbol` | `workspace/symbol` | 工作区符号 |
| `goToImplementation` | `textDocument/implementation` | 跳转实现 |
| `prepareCallHierarchy` | `textDocument/prepareCallHierarchy` | 准备调用层次 |
| `incomingCalls` | `callHierarchy/incomingCalls` | 入调用 |
| `outgoingCalls` | `callHierarchy/outgoingCalls` | 出调用 |

**坐标转换**：用户使用 1-based 行列号（编辑器风格），工具内部转换为 LSP 协议的 0-based。

> 源码位置：`src/tools/LSPTool/LSPTool.ts:127-422`

### 6. 网页获取流程（WebFetchTool）

WebFetchTool 是一个两阶段处理管道：**获取 → AI 摘要**。

**获取阶段**（`utils.ts`）：
1. URL 校验（最长 2000 字符，禁止用户名密码，要求公网域名）
2. HTTP → HTTPS 自动升级
3. **域名黑名单检查**：调用 `api.anthropic.com/api/web/domain_info` 检查域名（可通过 `skipWebFetchPreflight` 跳过）
4. **安全重定向**：同域名（含 www 变体）重定向自动跟随，跨域重定向返回给模型让其重新发起
5. HTML 通过 Turndown 转为 Markdown，二进制内容持久化到磁盘
6. LRU 缓存（15 分钟 TTL，50MB 大小限制），域名检查结果独立缓存（5 分钟）

**AI 摘要阶段**：
- 对非预批准域名的内容，截断至 100K 字符后交给 Haiku 模型处理
- 预批准域名的纯 Markdown 内容可直接返回（无需 AI 处理）
- 非预批准域名的摘要有严格的引用限制（125 字符）

**权限模型**：
- 130+ 预批准技术文档域名（`preapproved.ts`），包括语言文档、框架官网、云服务文档等
- 非预批准域名需用户逐域名授权
- 预批准列表**仅**用于 WebFetch（GET 请求），不适用于沙箱网络限制

> 源码位置：`src/tools/WebFetchTool/WebFetchTool.ts:208-299`（call 方法），`src/tools/WebFetchTool/utils.ts:347-482`（获取逻辑）

### 7. 网络搜索流程（WebSearchTool）

WebSearchTool 利用 Anthropic API 的 `web_search_20250305` 内置工具执行搜索。

**调用链**：
1. 构造 `BetaWebSearchTool20250305` schema（固定 `max_uses: 8`）
2. 通过 `queryModelWithStreaming()` 发起带 web_search 工具的 API 调用
3. 流式处理：追踪 `server_tool_use` → `web_search_tool_result` 事件，实时报告搜索进度
4. 最终将 `BetaContentBlock[]` 解析为搜索结果 + 文本评论的混合输出

**可用性**：仅在 firstParty、Vertex（Claude 4.0+）和 Foundry 平台启用。

**输入参数**：
- `query`：搜索查询（必填，≥2 字符）
- `allowed_domains`：白名单域名（可选，与 blocked_domains 互斥）
- `blocked_domains`：黑名单域名（可选）

> 源码位置：`src/tools/WebSearchTool/WebSearchTool.ts:152-435`

## 函数签名与参数说明

### MCPTool

```typescript
// 骨架定义，实际由 mcpClient.ts 在运行时覆写
MCPTool: ToolDef<z.object({}).passthrough(), string>
```

- `isMcp: true` — 标识为 MCP 工具
- `maxResultSizeChars: 100_000` — 结果最大 100K 字符

### ToolSearchTool

```typescript
call(input: { query: string; max_results?: number }, context): Promise<{
  data: {
    matches: string[];
    query: string;
    total_deferred_tools: number;
    pending_mcp_servers?: string[];
  }
}>
```

- `query`：搜索查询。支持 `select:Tool1,Tool2` 精确选择和 `+keyword other` 必须词语法
- `max_results`：最多返回结果数，默认 5

### LSPTool

```typescript
call(input: {
  operation: 'goToDefinition' | 'findReferences' | 'hover' | 'documentSymbol' |
             'workspaceSymbol' | 'goToImplementation' | 'prepareCallHierarchy' |
             'incomingCalls' | 'outgoingCalls';
  filePath: string;
  line: number;      // 1-based
  character: number; // 1-based
}): Promise<{ data: Output }>
```

### WebFetchTool

```typescript
call(input: { url: string; prompt: string }): Promise<{
  data: { bytes: number; code: number; codeText: string; result: string; durationMs: number; url: string }
}>
```

### WebSearchTool

```typescript
call(input: {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}): Promise<{
  data: { query: string; results: (SearchResult | string)[]; durationSeconds: number }
}>
```

### `createMcpAuthTool(serverName, config): Tool`

工厂函数，为未认证的 MCP 服务器创建 OAuth 伪工具。

### `classifyMcpToolForCollapse(serverName, toolName): { isSearch: boolean; isRead: boolean }`

根据工具名白名单判断 MCP 工具是否应在 UI 中折叠显示。

### `isDeferredTool(tool: Tool): boolean`

判断工具是否应被延迟加载（需通过 ToolSearch 获取 schema）。

## 配置项与默认值

| 配置/常量 | 值 | 说明 |
|-----------|-----|------|
| `MAX_URL_LENGTH` | 2000 | WebFetch URL 最大长度 |
| `MAX_HTTP_CONTENT_LENGTH` | 10 MB | WebFetch 响应体上限 |
| `FETCH_TIMEOUT_MS` | 60s | WebFetch 请求超时 |
| `DOMAIN_CHECK_TIMEOUT_MS` | 10s | 域名黑名单检查超时 |
| `MAX_REDIRECTS` | 10 | WebFetch 最大重定向次数 |
| `MAX_MARKDOWN_LENGTH` | 100,000 | WebFetch 内容截断长度 |
| `CACHE_TTL_MS` | 15 分钟 | WebFetch URL 缓存 TTL |
| `MAX_CACHE_SIZE_BYTES` | 50 MB | WebFetch URL 缓存大小 |
| `MAX_LSP_FILE_SIZE_BYTES` | 10 MB | LSP 文件大小上限 |
| `skipWebFetchPreflight` | false | 用户设置：跳过域名黑名单检查 |

## 接口/类型定义

### `McpAuthOutput`

```typescript
type McpAuthOutput = {
  status: 'auth_url' | 'unsupported' | 'error';
  message: string;
  authUrl?: string;
}
```

### `FetchedContent`（WebFetch）

```typescript
type FetchedContent = {
  content: string;
  bytes: number;
  code: number;
  codeText: string;
  contentType: string;
  persistedPath?: string;  // 二进制内容持久化路径
  persistedSize?: number;
}
```

### `LSPToolInput`（判别联合类型）

9 种操作共享 `filePath`、`line`、`character` 字段，通过 `operation` 字段区分，使用 Zod discriminated union 验证。

> 源码位置：`src/tools/LSPTool/schemas.ts:8-191`

## 边界 Case 与注意事项

- **MCPTool 的骨架模式**：`MCPTool.ts` 中的 `call()` 返回空字符串，所有有意义的逻辑在 `mcpClient.ts` 中通过运行时覆写实现。直接导入 MCPTool 并调用 `call()` 不会执行任何 MCP 操作。

- **ToolSearch 的缓存失效**：当 MCP 服务器连接/断开导致延迟工具集变化时，描述缓存会自动失效。通过 `clearToolSearchDescriptionCache()` 可手动清除。

- **WebFetch 安全限制**：
  - 预批准域名列表仅用于 WebFetch GET 请求，沙箱网络限制不继承此列表（防止数据泄露）
  - 跨域重定向不自动跟随，而是返回给模型重新发起（安全合规）
  - URL 中禁止包含 username/password（防止内网凭证泄露）
  - 认证/私有 URL 会失败——prompt 中提醒模型优先使用 MCP 工具

- **LSP 的 gitignore 过滤**：`findReferences`、`goToDefinition`、`goToImplementation`、`workspaceSymbol` 的结果会通过 `git check-ignore` 过滤 gitignored 文件，每批 50 路径，超时 5 秒。

- **LSP 的 UNC 路径安全**：对 `\\` 或 `//` 开头的 UNC 路径跳过文件系统操作，防止 NTLM 凭证泄露。

- **WebSearch 平台限制**：仅在 firstParty、Vertex（Claude 4.0+）和 Foundry 平台可用，且仅限美国地区。

- **MCP 认证的 claudeai-proxy**：claude.ai 连接器使用独立的认证流程，McpAuthTool 无法处理，需引导用户通过 `/mcp` 命令手动认证。

- **ToolSearch 输出格式兼容性**：`tool_reference` content block 在 1P/Foundry 上可用，Bedrock/Vertex 可能尚未支持客户端 tool_reference 展开。