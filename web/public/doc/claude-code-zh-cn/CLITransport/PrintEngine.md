# PrintEngine — CLI 主输出引擎

## 概述与职责

PrintEngine 是 Claude Code CLI 模式的**核心控制器**，位于 `CLITransport` 层内，负责在非交互式（headless）模式下驱动整个 CLI 的 REPL 循环。当用户通过 `--print`（`-p`）参数运行 Claude Code 时，所有消息的接收、处理、编排和输出都由此模块完成。

在整体架构中，PrintEngine 处于 **CLITransport → CoreEngine** 的数据通道上：它从 `StructuredIO` 接收用户输入和控制消息，将解析后的命令传递给 `QueryEngine`（`ask()`），并将模型响应和工具执行结果格式化后输出到 stdout。它同时管理 MCP 服务器连接、权限决策、会话恢复、后台任务协调等大量运行时状态。

该模块的兄弟节点包括 `handlers/`（命令处理器）和其他传输协议适配代码。

本文档涉及三个文件：
- `src/cli/print.ts`（5600+ 行）—— 主体逻辑
- `src/cli/ndjsonSafeStringify.ts` —— 安全 JSON 序列化
- `src/cli/exit.ts` —— CLI 退出工具函数

---

## 关键流程

### 1. Headless 启动流程（`runHeadless`）

`runHeadless` 是整个 headless 模式的入口，它完成从初始化到输出最终结果的全部流程：

1. **前置初始化**：下载用户/远程设置、订阅设置变更、激活 Proactive 模式、初始化 GrowthBook 特性开关（`src/cli/print.ts:455-566`）
2. **构建 StructuredIO**：根据输入类型（字符串或 `AsyncIterable`）和是否提供 `sdkUrl`，创建 `StructuredIO` 或 `RemoteIO` 实例（`src/cli/print.ts:5199-5233`）
3. **沙箱初始化**：检查沙箱可用性，若 `sandbox.failIfUnavailable` 配置为 true 但沙箱不可用则退出（`src/cli/print.ts:598-626`）
4. **加载初始消息**：通过 `loadInitialMessages` 处理 `--continue`、`--resume`、`--teleport` 等会话恢复场景（`src/cli/print.ts:4893-5197`）
5. **工具装配**：合并内置工具、MCP 工具、SDK 工具，过滤拒绝列表中的工具（`src/cli/print.ts:796-832`）
6. **启动流式循环**：调用 `runHeadlessStreaming` 开始消息处理主循环（`src/cli/print.ts:864-915`）
7. **输出最终结果**：根据 `outputFormat`（`json`/`stream-json`/默认文本）格式化并输出结果（`src/cli/print.ts:917-957`）
8. **退出**：通过 `gracefulShutdownSync` 以正确的退出码结束进程（`src/cli/print.ts:971-973`）

### 2. 消息处理主循环（`runHeadlessStreaming` + `run`）

`runHeadlessStreaming` 返回一个 `AsyncIterable<StdoutMessage>`，内部包含两个并行运行的异步任务：

**输入读取循环**（stdin IIFE，`src/cli/print.ts:2813-4140`）：
- 从 `structuredIO.structuredInput` 逐行读取消息
- 根据 `message.type` 分发处理：
  - `control_request` → 处理 20+ 种控制命令（initialize、set_model、mcp_status 等）
  - `user` → 去重检查后 `enqueue` 到命令队列，触发 `run()`
  - `control_response` / `keep_alive` / `assistant` / `system` → 相应处理或忽略

**命令执行循环**（`run` 函数，`src/cli/print.ts:1865-2681`）：
1. 通过互斥锁 `running` 防止并发执行
2. 从命令队列 `dequeue` 取出命令，支持**命令批处理**——连续的 prompt 命令合并为一次 `ask()` 调用
3. 调用 `ask()`（QueryEngine）执行模型对话，逐条 yield 消息到输出流
4. 通过 do-while 循环等待后台 Agent 完成，持续 drain 命令队列
5. 处理 Proactive tick、团队成员消息轮询、Swarm 关闭协议
6. 最终调用 `output.done()` 关闭输出流

```
stdin → structuredIO → [控制消息分发 / 用户消息入队]
                              ↓
                      commandQueue.enqueue()
                              ↓
                    run() → dequeue → ask() → output.enqueue()
                              ↓
                      structuredIO.write → stdout
```

### 3. 控制协议处理

stdin 循环处理 20+ 种 `control_request` 子类型，覆盖会话的全生命周期管理：

| 子类型 | 功能 | 源码位置 |
|--------|------|----------|
| `initialize` | SDK 初始化握手，返回命令/Agent/模型列表 | `src/cli/print.ts:2863-2917` |
| `interrupt` | 中止当前查询 | `src/cli/print.ts:2831-2849` |
| `end_session` | 结束会话 | `src/cli/print.ts:2850-2862` |
| `set_permission_mode` | 切换权限模式 | `src/cli/print.ts:2918-2932` |
| `set_model` | 运行时切换模型 | `src/cli/print.ts:2933-2944` |
| `mcp_set_servers` | 动态添加/移除 MCP 服务器 | `src/cli/print.ts:3055-3064` |
| `mcp_reconnect` | 重连 MCP 服务器 | `src/cli/print.ts:3133-3205` |
| `mcp_authenticate` | 触发 MCP OAuth 流程 | `src/cli/print.ts:3310-3462` |
| `remote_control` | 启用/禁用 Bridge 远程控制 | `src/cli/print.ts:3892-4020` |
| `side_question` | 在独立上下文中执行旁路查询 | `src/cli/print.ts:3815-3874` |
| `rewind_files` | 回退文件到某个消息节点的状态 | `src/cli/print.ts:2995-3010` |

### 4. NDJSON 安全序列化

`ndjsonSafeStringify` 解决 NDJSON（Newline Delimited JSON）传输中的一个边界问题：JSON 标准允许字符串中包含 U+2028（LINE SEPARATOR）和 U+2029（PARAGRAPH SEPARATOR），但接收方可能按 JavaScript 的行终止符语义（ECMA-262 §11.3）拆分流，导致 JSON 被截断（`src/cli/ndjsonSafeStringify.ts:1-32`）。

解决方案是将这两个字符转义为 `\u2028` / `\u2029`，输出仍为合法 JSON，但不会被误判为行终止符。

### 5. CLI 退出工具

`exit.ts` 提供两个简洁的退出函数，消除了原先散布在 ~60 个 handler 中的 "print + lint-suppress + exit" 样板代码（`src/cli/exit.ts:1-31`）：

- `cliError(msg?)` → stderr 输出 + `process.exit(1)`
- `cliOk(msg?)` → stdout 输出 + `process.exit(0)`

返回类型为 `never`，让 TypeScript 在调用点自动收窄控制流。`return undefined as never` 的写法是为了兼容测试中 spy `process.exit` 让其返回的场景。

---

## 函数签名与参数说明

### `runHeadless(inputPrompt, getAppState, setAppState, commands, tools, sdkMcpConfigs, agents, options): Promise<void>`

headless 模式的顶层入口。

- **inputPrompt**: `string | AsyncIterable<string>` —— 用户提示词，或 SDK 的 NDJSON 消息流
- **getAppState / setAppState**: 全局应用状态的读写器
- **commands**: 已注册的命令列表
- **tools**: 内置工具列表
- **sdkMcpConfigs**: SDK 传入的 MCP 服务器配置
- **agents**: Agent 定义列表
- **options**: 包含 `outputFormat`、`maxTurns`、`maxBudgetUsd`、`resume`、`systemPrompt` 等 30+ 配置项

> 源码位置：`src/cli/print.ts:455-974`

### `runHeadlessStreaming(...): AsyncIterable<StdoutMessage>`

内部函数。创建两个并行异步任务（stdin 读取 + 命令执行），返回消息的 `AsyncIterable` 流。

> 源码位置：`src/cli/print.ts:976-4143`

### `joinPromptValues(values: PromptValue[]): PromptValue`

将多个排队命令的 prompt 合并为一个。纯字符串用 `\n` 连接；若任一值为 `ContentBlockParam[]`，则全部规范化为 block 数组拼接。

> 源码位置：`src/cli/print.ts:428-434`

### `canBatchWith(head: QueuedCommand, next: QueuedCommand | undefined): boolean`

判断下一个命令是否可以与当前命令合并到同一次 `ask()` 调用中。只有 prompt 模式、相同 workload 标签、相同 `isMeta` 标志的命令才能合并。

> 源码位置：`src/cli/print.ts:443-453`

### `getCanUseToolFn(permissionPromptToolName, structuredIO, getMcpTools, onPermissionPrompt): CanUseToolFn`

根据权限提示工具的配置，构建工具权限校验函数。支持三种模式：
- `'stdio'` → 委托给 `structuredIO.createCanUseTool()`（SDK 消费者决策）
- `undefined` → 直接调用 `hasPermissionsToUseTool()`
- 自定义 MCP 工具名 → 懒查找 MCP 工具，通过 `createCanUseToolWithPermissionPrompt` 构建

> 源码位置：`src/cli/print.ts:4267-4334`

### `handleMcpSetServers(servers, sdkState, dynamicState, setAppState): Promise<McpSetServersResult>`

处理 `mcp_set_servers` 控制请求。分离 SDK 服务器和 process 服务器，对后者执行策略过滤（`filterMcpServersByPolicy`），然后调用 `reconcileMcpServers` 执行连接/断连操作。

> 源码位置：`src/cli/print.ts:5353-5444`

### `reconcileMcpServers(desiredConfigs, currentState, setAppState): Promise<{response, newState}>`

MCP 服务器状态协调器。对比期望配置与当前状态，执行增量更新：移除不再需要的服务器、连接新服务器、替换配置变更的服务器。

> 源码位置：`src/cli/print.ts:5450-5594`

### `ndjsonSafeStringify(value: unknown): string`

安全的 JSON 序列化，转义 U+2028/U+2029 以防止 NDJSON 行分割。

> 源码位置：`src/cli/ndjsonSafeStringify.ts:30-32`

### `cliError(msg?: string): never` / `cliOk(msg?: string): never`

CLI 子命令的标准退出函数。

> 源码位置：`src/cli/exit.ts:19-31`

---

## 接口/类型定义

### `DynamicMcpState`

动态添加的 MCP 服务器运行时状态（区别于启动时配置的服务器）。

```typescript
type DynamicMcpState = {
  clients: MCPServerConnection[]
  tools: Tools
  configs: Record<string, ScopedMcpServerConfig>
}
```

> 源码位置：`src/cli/print.ts:5306-5310`

### `SdkMcpState`

SDK 进程内运行的 MCP 服务器状态。

```typescript
type SdkMcpState = {
  configs: Record<string, McpSdkServerConfig>
  clients: MCPServerConnection[]
  tools: Tools
}
```

> 源码位置：`src/cli/print.ts:5328-5332`

### `McpSetServersResult`

`handleMcpSetServers` 的返回类型，包含响应数据和新的 SDK/动态 MCP 状态。

> 源码位置：`src/cli/print.ts:5337-5342`

---

## 配置项与默认值

| 配置项 | 类型 | 说明 |
|--------|------|------|
| `--output-format` | `json` / `stream-json` / 默认 | 输出格式；`stream-json` 需搭配 `--verbose` |
| `--max-turns` | number | 最大对话轮数限制 |
| `--max-budget-usd` | number | USD 预算上限 |
| `--resume` | string/boolean | 恢复指定会话（UUID 或 JSONL 文件） |
| `--continue` | boolean | 继续最近的会话 |
| `--rewind-files` | string | 将文件回退到指定消息节点的状态 |
| `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` | env | 自动恢复中断的对话轮次 |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` | env | 同步等待插件安装完成后再处理第一个请求 |
| `CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS` | env | 同步插件安装超时毫秒数 |
| `CLAUDE_CODE_STREAMLINED_OUTPUT` | env | 启用精简输出变换（仅 `stream-json`） |
| `MAX_RECEIVED_UUIDS` | 常量 `10_000` | 用户消息 UUID 去重集合的上限 |

---

## 边界 Case 与注意事项

- **命令批处理与合并**：连续到达的 prompt 命令会被贪婪合并为一次 `ask()` 调用，但只有 workload 标签和 `isMeta` 标志完全匹配的命令才会合并。这避免了 proactive tick 消息被合并进用户消息导致标记丢失的问题。

- **UUID 去重**：用户消息通过双层去重机制防止重复执行——历史去重（session 文件检查）+ 运行时去重（内存 Set，上限 10,000 条，LRU 淘汰）。

- **后台 Agent 结果挂起**：当后台 Agent 仍在运行时，`result` 消息会被暂缓（hold-back），直到所有后台任务完成后再释放到输出流。这确保了 SDK 消费者收到的 result 包含所有 Agent 产出。

- **互斥执行**：`run()` 函数通过 `running` 布尔标志实现互斥。当 `run()` 正在执行时，新到达的消息只入队不触发执行。`run()` 结束后会重新检查队列，防止消息滞留。

- **SIGINT 处理**：headless 模式下 Ctrl+C 会中止当前查询并触发 graceful shutdown，而不是直接杀进程。关闭流程包括持久化会话状态和 flush 分析数据。

- **MCP OAuth 流程**：OAuth 认证支持自动（localhost 回调）和手动（用户粘贴回调 URL）两种模式。每个服务器同时只允许一个活跃的 OAuth 流，新请求会中止旧流。

- **插件热加载**：`skillChangeDetector` 和 `settingsChangeDetector` 的订阅确保了命令、Agent、Hook 在运行时可以热更新，无需重启进程。

- **团队协作关闭协议**：当输入关闭（stdin EOF）且有活跃的团队成员时，PrintEngine 会注入 `SHUTDOWN_TEAM_PROMPT` 让模型执行团队关闭协议，确保所有团队成员被正确清理后才关闭输出流。