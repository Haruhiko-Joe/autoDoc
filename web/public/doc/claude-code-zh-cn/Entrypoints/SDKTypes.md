# SDKTypes — SDK 编程式接入的类型系统和协议 Schema

## 概述与职责

SDKTypes 模块是 Claude Code **编程式接入（SDK）** 的类型基础设施，位于 Entrypoints 层。它为三类消费者提供类型定义：

- **SDK 消费者**（使用 Claude Code SDK 构建应用的开发者）：通过 `agentSdkTypes.ts` 获取公共 API 类型
- **SDK 构建者**（实现 SDK 传输层的开发者，如 Python SDK）：通过 `controlSchemas.ts` 获取控制协议 Schema
- **内部模块**：通过 `coreSchemas.ts` 获取运行时验证用的 Zod Schema

整个模块采用 **Schema-first** 设计——所有类型都从 Zod Schema 生成，Schema 是唯一的 truth source。这保证了运行时验证和编译时类型检查的一致性。

在系统架构中，SDKTypes 是 Entrypoints 层的一部分，与 CLI 入口（`cli.tsx`）和 MCP Server 入口（`mcp.ts`）并列，共同构成应用的三种启动/接入模式。它被 Services 层（API 通信）、CoreEngine（消息处理）、BridgeAndRemote（远程会话）等模块广泛依赖。

## 模块结构

```
src/entrypoints/
├── agentSdkTypes.ts          # Agent SDK 公共 API 入口（类型 + 函数签名）
├── sandboxTypes.ts            # 沙盒配置 Zod Schema
└── sdk/
    ├── coreSchemas.ts         # 核心数据类型 Zod Schema（1889 行）
    ├── controlSchemas.ts      # SDK ↔ CLI 控制协议 Schema
    └── coreTypes.ts           # 从 Schema 生成的 TypeScript 类型重导出
```

## 关键流程 Walkthrough

### 类型生成流程

1. 开发者在 `coreSchemas.ts` 中编辑 Zod Schema
2. 运行 `bun scripts/generate-sdk-types.ts` 生成 `coreTypes.generated.js`
3. `coreTypes.ts` 重导出生成的类型 + 沙盒类型 + 工具类型
4. `agentSdkTypes.ts` 聚合所有类型，构成公共 API 表面

### SDK 消息流通路

SDK 通过 stdin/stdout 与 CLI 进程通信，消息格式由两个聚合 Schema 定义（`src/entrypoints/sdk/controlSchemas.ts:642-663`）：

- **StdinMessageSchema**（SDK → CLI）：`SDKUserMessage | SDKControlRequest | SDKControlResponse | SDKKeepAlive | SDKUpdateEnvironmentVariables`
- **StdoutMessageSchema**（CLI → SDK）：`SDKMessage | SDKStreamlinedText | SDKStreamlinedToolUseSummary | SDKPostTurnSummary | SDKControlResponse | SDKControlRequest | SDKControlCancelRequest | SDKKeepAlive`

### 控制协议请求/响应

SDK 与 CLI 之间的控制协议基于 request-response 模式（`src/entrypoints/sdk/controlSchemas.ts:578-619`）：

1. 发起方构造 `SDKControlRequest`，包含 `type: "control_request"`、`request_id`（用于匹配响应）和具体的 `request` 内容
2. 接收方返回 `SDKControlResponse`，内嵌 `ControlResponseSchema`（成功，可选返回 response 数据）或 `ControlErrorResponseSchema`（失败，包含 error 信息和可选的 pending 权限请求）
3. 发起方可通过 `SDKControlCancelRequest` 取消正在进行的请求

## 核心 Schema 分区详解

### coreSchemas.ts — 核心数据类型

这个 1889 行的文件是整个类型系统的基石，按领域划分为以下区块：

#### 使用量与模型类型

`ModelUsageSchema` 定义 API 调用的 Token 消耗统计（`src/entrypoints/sdk/coreSchemas.ts:17-28`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| inputTokens | number | 输入 Token 数 |
| outputTokens | number | 输出 Token 数 |
| cacheReadInputTokens | number | 缓存读取 Token 数 |
| cacheCreationInputTokens | number | 缓存创建 Token 数 |
| webSearchRequests | number | 网络搜索请求数 |
| costUSD | number | 美元费用 |
| contextWindow | number | 上下文窗口大小 |
| maxOutputTokens | number | 最大输出 Token 数 |

#### 配置与 API 密钥

- `ApiKeySourceSchema`：密钥来源——`'user' | 'project' | 'org' | 'temporary' | 'oauth'`
- `ThinkingConfigSchema`：思考模式配置，支持三种模式（`src/entrypoints/sdk/coreSchemas.ts:94-104`）：
  - `adaptive`——Claude 自动决定（Opus 4.6+）
  - `enabled`——固定预算（可选 `budgetTokens`）
  - `disabled`——关闭

#### MCP 服务器配置

支持四种传输协议（`src/entrypoints/sdk/coreSchemas.ts:110-149`）：

| Schema | type 字段 | 用途 |
|--------|----------|------|
| `McpStdioServerConfigSchema` | `"stdio"`（可选） | 本地子进程，指定 command + args |
| `McpSSEServerConfigSchema` | `"sse"` | Server-Sent Events 远程服务 |
| `McpHttpServerConfigSchema` | `"http"` | HTTP Streamable 远程服务 |
| `McpSdkServerConfigSchema` | `"sdk"` | SDK 进程内 MCP 服务器 |

`McpServerStatusSchema` 扩展了服务器状态信息，包括连接状态（`connected | failed | needs-auth | pending | disabled`）、已注册工具列表和服务器能力声明（`src/entrypoints/sdk/coreSchemas.ts:167-220`）。

#### 权限系统

权限模型定义了五种模式（`src/entrypoints/sdk/coreSchemas.ts:337-348`）：

- `default`——标准模式，危险操作需确认
- `acceptEdits`——自动接受文件编辑
- `bypassPermissions`——跳过所有权限检查（需开启 allowDangerouslySkipPermissions）
- `plan`——规划模式，不执行工具
- `dontAsk`——不弹出权限确认，未预批准则拒绝

`PermissionUpdateSchema` 是一个 discriminated union，支持六种操作：`addRules`、`replaceRules`、`removeRules`、`setMode`、`addDirectories`、`removeDirectories`（`src/entrypoints/sdk/coreSchemas.ts:263-298`）。

`PermissionResultSchema` 定义权限判定结果——`allow`（可附带修改后的输入和权限更新）或 `deny`（包含拒绝原因和可选的中断标志）（`src/entrypoints/sdk/coreSchemas.ts:315-335`）。

#### Hook 事件系统

定义了 27 种 Hook 事件（`src/entrypoints/sdk/coreSchemas.ts:355-383`），覆盖工具执行生命周期、会话管理和系统事件：

```typescript
const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'PermissionRequest', 'PermissionDenied',
  'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  'Elicitation', 'ElicitationResult',
  'ConfigChange', 'WorktreeCreate', 'WorktreeRemove',
  'InstructionsLoaded', 'CwdChanged', 'FileChanged',
] as const
```

每种事件有对应的 Input Schema（继承 `BaseHookInputSchema` 并添加事件特有字段），以及可选的 Output Schema（Hook 可以影响执行行为，如 `PreToolUse` 的 Hook 可以返回 `permissionDecision` 来批准/拒绝工具调用）。

所有 Hook Input 共享 `BaseHookInputSchema` 基础字段（`src/entrypoints/sdk/coreSchemas.ts:387-411`）：`session_id`、`transcript_path`、`cwd`、`permission_mode`（可选）、`agent_id`（可选，子 Agent 调用时存在）、`agent_type`（可选）。

#### SDK 消息类型

SDK 消息是一个大型 union 类型（`src/entrypoints/sdk/coreSchemas.ts:1854-1881`），包含 20+ 种消息变体：

**核心对话消息**：
- `SDKUserMessageSchema`——用户消息，包含 API 格式的 message 体、`parent_tool_use_id`、优先级（`now | next | later`）
- `SDKAssistantMessageSchema`——助手消息，包含 API 响应体和可选错误状态
- `SDKResultMessageSchema`——对话回合结果，分为 `success`（含费用、Token 使用量、结构化输出）和 `error`（含错误列表，子类型区分执行错误/超轮次/超预算/结构化输出重试耗尽）

**系统消息**（`type: "system"`，通过 `subtype` 区分）：
- `init`——会话初始化信息（工具列表、MCP 服务器、模型、权限模式等）
- `compact_boundary`——上下文压缩边界标记，含压缩元数据
- `status`——状态变更通知（如 `compacting`）
- `api_retry`——API 重试通知
- `hook_started/progress/response`——Hook 执行生命周期
- `task_started/progress/notification`——后台任务生命周期
- `session_state_changed`——会话状态变更（`idle | running | requires_action`）

**流式消息**：
- `SDKPartialAssistantMessageSchema`（`type: "stream_event"`）——流式助手响应事件

### controlSchemas.ts — 控制协议

定义 SDK 与 CLI 进程之间的双向控制通信，包含以下控制请求类型（`src/entrypoints/sdk/controlSchemas.ts:52-575`）：

**会话管理**：
- `initialize`——初始化 SDK 会话，配置 hooks、MCP 服务器、自定义 Agent、系统提示词等
- `interrupt`——中断当前对话回合
- `cancel_async_message`——取消异步消息队列中的待处理消息

**权限控制**：
- `can_use_tool`——请求工具使用权限（从 CLI 发向 SDK），含工具名、输入参数、权限建议
- `set_permission_mode`——设置权限模式

**模型与推理配置**：
- `set_model`——切换模型
- `set_max_thinking_tokens`——设置思考 Token 上限

**MCP 服务器管理**：
- `mcp_status`——查询所有 MCP 服务器状态
- `mcp_message`——向指定 MCP 服务器发送 JSON-RPC 消息
- `mcp_set_servers`——批量替换动态管理的 MCP 服务器集合
- `mcp_reconnect`——重连断开的 MCP 服务器
- `mcp_toggle`——启用/禁用 MCP 服务器

**上下文与状态查询**：
- `get_context_usage`——获取上下文窗口使用量明细（按类别拆分 Token 消耗，含网格可视化数据）
- `get_settings`——获取生效设置和各来源原始设置
- `apply_flag_settings`——合并特性标志设置

**文件与会话操作**：
- `rewind_files`——回滚到指定消息之前的文件状态
- `seed_read_state`——植入文件读取缓存（用于上下文压缩后恢复编辑验证）
- `reload_plugins`——重新加载插件

**Hook 回调**：
- `hook_callback`——将 Hook 回调数据传递给 CLI

**MCP Elicitation**：
- `elicitation`——MCP 服务器请求用户输入，SDK 消费者需处理并返回 `accept | decline | cancel`

### coreTypes.ts — 类型重导出

这个轻量文件（`src/entrypoints/sdk/coreTypes.ts`）的职责是组装公共类型表面：

1. 重导出沙盒类型（`SandboxSettings`、`SandboxNetworkConfig` 等）
2. 重导出 `coreTypes.generated.js` 中从 Schema 生成的所有类型
3. 重导出工具类型 `NonNullableUsage`
4. 导出运行时常量 `HOOK_EVENTS` 和 `EXIT_REASONS`

### sandboxTypes.ts — 沙盒配置

定义沙盒安全隔离的三层配置 Schema（`src/entrypoints/sandboxTypes.ts`）：

**`SandboxNetworkConfigSchema`**——网络隔离：

| 字段 | 类型 | 说明 |
|------|------|------|
| allowedDomains | string[] | 允许的域名白名单 |
| allowManagedDomainsOnly | boolean | 仅使用管理设置的域名 |
| allowUnixSockets | string[] | 允许的 Unix Socket 路径（仅 macOS） |
| allowAllUnixSockets | boolean | 允许所有 Unix Socket |
| allowLocalBinding | boolean | 允许本地端口绑定 |
| httpProxyPort | number | HTTP 代理端口 |
| socksProxyPort | number | SOCKS 代理端口 |

**`SandboxFilesystemConfigSchema`**——文件系统隔离：

| 字段 | 类型 | 说明 |
|------|------|------|
| allowWrite | string[] | 额外允许写入的路径 |
| denyWrite | string[] | 额外禁止写入的路径 |
| denyRead | string[] | 额外禁止读取的路径 |
| allowRead | string[] | 在 denyRead 中重新允许的路径 |
| allowManagedReadPathsOnly | boolean | 仅使用管理设置的读取路径 |

**`SandboxSettingsSchema`**——沙盒主配置：

| 字段 | 类型 | 说明 |
|------|------|------|
| enabled | boolean | 是否启用沙盒 |
| failIfUnavailable | boolean | 沙盒不可用时是否退出（用于强制沙盒的企业部署） |
| autoAllowBashIfSandboxed | boolean | 沙盒启用时自动允许 Bash 命令 |
| allowUnsandboxedCommands | boolean | 是否允许通过 `dangerouslyDisableSandbox` 逃逸沙盒（默认 true） |
| network | SandboxNetworkConfig | 网络隔离配置 |
| filesystem | SandboxFilesystemConfig | 文件系统隔离配置 |
| ignoreViolations | Record<string, string[]> | 忽略特定违规 |
| enableWeakerNestedSandbox | boolean | 启用弱化嵌套沙盒 |
| enableWeakerNetworkIsolation | boolean | 启用弱化网络隔离（macOS，用于 Go CLI 工具的 TLS 验证） |
| excludedCommands | string[] | 排除的命令 |
| ripgrep | {command, args?} | 自定义 ripgrep 配置 |

Schema 使用 `.passthrough()` 允许未声明字段（如 `enabledPlatforms`），以支持渐进式特性上线。

### agentSdkTypes.ts — 公共 API 入口

这是 Agent SDK 的**主入口文件**（`src/entrypoints/agentSdkTypes.ts`），聚合四类导出：

**类型导出**：
- 核心类型（`sdk/coreTypes.js`）——消息、配置、使用量等
- 运行时类型（`sdk/runtimeTypes.js`）——回调、接口、会话选项等
- 控制协议类型（`sdk/controlTypes.js`，标记 `@alpha`）——`SDKControlRequest`、`SDKControlResponse`
- 设置类型（`sdk/settingsTypes.generated.js`）——`Settings`
- 工具类型（`sdk/toolTypes.js`，标记 `@internal`）

**核心函数**：

#### `query(params): Query`

SDK 的主查询入口（`src/entrypoints/agentSdkTypes.ts:112-122`）。接受 `prompt`（字符串或异步 `SDKUserMessage` 流）和 `options`，返回一个可异步迭代的 `Query` 对象。有一个 `@internal` 重载接受 `InternalOptions`。

#### `unstable_v2_createSession(options): SDKSession`

V2 API（`@alpha`），创建持久化的多轮会话（`src/entrypoints/agentSdkTypes.ts:129-133`）。

#### `unstable_v2_resumeSession(sessionId, options): SDKSession`

V2 API（`@alpha`），通过 ID 恢复已有会话（`src/entrypoints/agentSdkTypes.ts:140-145`）。

#### `unstable_v2_prompt(message, options): Promise<SDKResultMessage>`

V2 API（`@alpha`），单次 prompt 便捷函数（`src/entrypoints/agentSdkTypes.ts:160-165`）。

#### 会话管理函数

- `getSessionMessages(sessionId, options)`——读取会话消息历史
- `listSessions(options)`——列出会话（支持按目录过滤和分页）
- `getSessionInfo(sessionId, options)`——获取单个会话元数据
- `renameSession(sessionId, title, options)`——重命名会话
- `tagSession(sessionId, tag, options)`——为会话打标签
- `forkSession(sessionId, options)`——从指定消息点分叉会话

#### `tool(name, description, inputSchema, handler, extras): SdkMcpToolDefinition`

注册自定义 MCP 工具（`src/entrypoints/agentSdkTypes.ts:73-88`），用于 `createSdkMcpServer`。

#### `createSdkMcpServer(options): McpSdkServerConfigWithInstance`

创建进程内 MCP 服务器实例（`src/entrypoints/agentSdkTypes.ts:103-107`），允许 SDK 用户定义在同进程运行的自定义工具。

**Daemon 内部原语**（均标记 `@internal`）：

- `watchScheduledTasks(opts)`——监听定时任务文件变更并触发执行
- `buildMissedTaskNotification(missed)`——格式化错过的一次性任务通知
- `connectRemoteControl(opts)`——建立 claude.ai remote-control 桥接连接
- 相关类型：`CronTask`、`CronJitterConfig`、`ScheduledTaskEvent`、`RemoteControlHandle` 等

## 设计模式与技术细节

### lazySchema 模式

所有 Schema 都通过 `lazySchema(() => z.object({...}))` 包装。这是一个延迟初始化模式，避免循环依赖问题，并允许 Schema 之间在定义时相互引用。调用方通过 `SomeSchema()` 获取实际的 Zod Schema 实例。

### Stub 函数模式

`agentSdkTypes.ts` 中的所有函数实现都是 `throw new Error('not implemented')`。这是因为该文件作为 SDK 包的**类型入口**被发布，实际实现在 CLI 运行时通过模块替换注入。SDK 消费者导入的是类型签名，运行时由 CLI 进程提供真正的实现。

### 外部类型占位符

`coreSchemas.ts` 使用 `z.unknown()` 占位外部类型（如 Anthropic SDK 的 `APIUserMessage`、`APIAssistantMessage`），通过 `TypeOverrideMap` 在类型生成时替换为正确的 TypeScript 类型引用（`src/entrypoints/sdk/coreSchemas.ts:1232-1251`）。

## 边界 Case 与注意事项

- `McpStdioServerConfigSchema` 的 `type` 字段是可选的（`z.literal('stdio').optional()`），这是为了向后兼容老版本配置
- `SDKUserMessage` 的 `uuid` 和 `session_id` 是可选的（发送时可省略），而 `SDKUserMessageReplay`（重放消息）中它们是必填的
- 沙盒配置中的 `enabledPlatforms` 是未文档化的字段，通过 `.passthrough()` 传递，用于企业客户按平台启用沙盒
- `enableWeakerNetworkIsolation` 仅在 macOS 上有效，开启后会降低安全性（开放 trustd 服务访问），但这是 Go 系 CLI 工具（gh、gcloud、terraform）进行 TLS 证书验证所必需的
- 控制协议中 `SDKControlCancelRequest` 取消的是"正在进行的控制请求"（如等待权限确认），不是取消对话
- `seed_read_state` 是一个特殊的控制请求，用于上下文压缩（snip）后恢复文件编辑验证——当之前的 Read 结果被从上下文中移除时，植入缓存以避免 Edit 校验失败