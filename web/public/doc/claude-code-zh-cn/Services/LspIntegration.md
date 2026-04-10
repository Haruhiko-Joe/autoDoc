# LSP 集成服务

## 概述与职责

LSP 集成服务是 Claude Code **Services 层**的子模块，负责管理语言服务器协议（Language Server Protocol）服务器的完整生命周期。它的核心价值在于：让 Claude Code 的代码编辑工具获得**真实编译器级别的诊断反馈**——当 Claude 编辑文件后，LSP 服务器会自动报告类型错误、未定义引用等问题，这些信息以 attachment 形式注入对话上下文，帮助 Claude 自动修复问题。

在整体架构中，LSP 集成隶属于 **Services**（后端服务集成层），与 API 通信、MCP 客户端、OAuth 等服务并列。它通过插件系统加载 LSP 服务器配置（不支持用户/项目级直接配置），由 ToolSystem 中的 LSPTool 调用其能力。

模块由 7 个文件组成，按职责可分为四层：

| 层次 | 文件 | 职责 |
|------|------|------|
| 单例管理 | `manager.ts` | 全局单例生命周期（初始化、关闭、重初始化） |
| 多服务器编排 | `LSPServerManager.ts` | 管理多个 LSP 服务器实例，按文件扩展名路由请求 |
| 单服务器实例 | `LSPServerInstance.ts` | 单个 LSP 服务器的状态机、健康检查、请求重试 |
| JSON-RPC 通信 | `LSPClient.ts` | 底层 stdio 进程管理与 JSON-RPC 消息连接 |
| 配置加载 | `config.ts` | 从插件系统加载 LSP 服务器配置 |
| 诊断注册表 | `LSPDiagnosticRegistry.ts` | 诊断消息的去重、限流、跨 turn 追踪 |
| 被动反馈 | `passiveFeedback.ts` | 注册 `publishDiagnostics` 通知处理器，转换格式 |

## 关键流程

### 1. 启动与初始化流程

Claude Code 启动时调用 `initializeLspServerManager()`（`src/services/lsp/manager.ts:145`），流程如下：

1. **Bare 模式检查**：如果是 `--bare` 或脚本化 `-p` 调用，直接跳过（LSP 仅在 REPL 模式下有意义）
2. **创建单例**：调用 `createLSPServerManager()` 创建管理器实例，状态设为 `pending`
3. **异步初始化**：在后台执行 `manager.initialize()`，不阻塞启动流程
4. **加载插件配置**：`getAllLspServers()`（`config.ts:15`）从已启用的插件中并行加载 LSP 服务器配置
5. **构建扩展名映射**：`LSPServerManager.initialize()`（`LSPServerManager.ts:71`）为每个服务器的 `extensionToLanguage` 建立 `扩展名 → 服务器名` 的路由表
6. **创建实例（不启动）**：为每个配置创建 `LSPServerInstance`，但**不立即启动进程**——服务器是懒启动的
7. **注册诊断处理器**：初始化成功后调用 `registerLSPNotificationHandlers()`，为所有服务器注册 `textDocument/publishDiagnostics` 通知监听

**代数计数器防竞态**：`initializationGeneration` 变量确保当重新初始化发生时，旧的异步 promise 不会错误地更新状态（`manager.ts:173-184`）。

### 2. 请求路由与懒启动流程

当工具需要向 LSP 服务器发送请求时（如文件编辑后同步内容），调用路径为：

1. **路由匹配**：`getServerForFile(filePath)`（`LSPServerManager.ts:192`）根据文件扩展名在 `extensionMap` 中查找对应的服务器
2. **懒启动**：`ensureServerStarted(filePath)`（`LSPServerManager.ts:215`）检查服务器状态，若为 `stopped` 或 `error` 则调用 `start()`
3. **进程启动**：`LSPServerInstance.start()`（`LSPServerInstance.ts:135`）经由 `LSPClient.start()` spawn 子进程，建立 JSON-RPC 连接
4. **协议握手**：发送 `initialize` 请求，声明客户端能力（支持诊断、hover、定义跳转、引用查找、文档符号、调用层次），接收服务器能力
5. **发送请求**：通过 `sendRequest()` 转发实际 LSP 请求，带有自动重试逻辑

### 3. 文件同步流程

`LSPServerManager` 提供完整的文档同步 API，对应 LSP 协议的文本文档同步通知：

- **`openFile(filePath, content)`**：发送 `textDocument/didOpen`，通过 `extensionToLanguage` 映射确定 `languageId`，并用 `openedFiles` Map 追踪已打开文件避免重复通知
- **`changeFile(filePath, content)`**：发送 `textDocument/didChange`（全量内容替换）。如果文件尚未 open，自动降级为 `openFile`
- **`saveFile(filePath)`**：发送 `textDocument/didSave`，触发服务器重新诊断
- **`closeFile(filePath)`**：发送 `textDocument/didClose`，清理追踪状态

### 4. 诊断收集与投递流程

这是 LSP 集成最核心的数据流，将编译器诊断自动注入 Claude 对话：

1. **LSP 服务器推送**：服务器异步发送 `textDocument/publishDiagnostics` 通知
2. **格式转换**：`passiveFeedback.ts` 中的处理器将 LSP 诊断格式转换为 Claude 的 `DiagnosticFile[]` 格式（`formatDiagnosticsForAttachment`，`passiveFeedback.ts:43`）
3. **注册待投递**：调用 `registerPendingLSPDiagnostic()` 存入全局 `pendingDiagnostics` Map
4. **消费端拉取**：`checkForLSPDiagnostics()`（`LSPDiagnosticRegistry.ts:193`）被 attachment 系统调用，执行以下处理：
   - **去重**：基于 `message + severity + range + source + code` 的 JSON 序列化 key，同批次内去重 + 跨 turn 去重（LRU 缓存追踪已投递诊断）
   - **按严重度排序**：Error > Warning > Info > Hint
   - **限流**：每文件最多 10 条，全局最多 30 条
   - **标记已投递**：从 pending Map 中删除已消费的条目
5. **以 Attachment 投递**：最终诊断数据作为对话 attachment 被注入下一轮查询

**跨 turn 去重机制**：`deliveredDiagnostics` 使用 LRU 缓存（最多 500 个文件），防止长会话中重复投递相同诊断。当文件被编辑时，应调用 `clearDeliveredDiagnosticsForFile(fileUri)` 重置该文件的追踪，使新诊断能够被投递。

## 函数签名与参数说明

### 单例管理（`manager.ts`）

#### `initializeLspServerManager(): void`

应用启动时调用。幂等，但如果前次初始化失败会自动重试。Bare 模式下为 no-op。

#### `reinitializeLspServerManager(): void`

插件刷新后调用，强制重新初始化。会先 fire-and-forget 关闭旧实例，再重置状态并调用 `initializeLspServerManager()`。

> 源码位置：`src/services/lsp/manager.ts:226`

#### `getLspServerManager(): LSPServerManager | undefined`

获取单例实例。初始化失败或未完成时返回 `undefined`。

#### `isLspConnected(): boolean`

检查是否至少有一个 LSP 服务器处于非 error 状态。用于 `LSPTool.isEnabled()` 判断。

#### `shutdownLspServerManager(): Promise<void>`

应用退出时调用。错误被吞掉（记录日志但不抛出），状态始终被清理。

### LSPServerManager

#### `sendRequest<T>(filePath, method, params): Promise<T | undefined>`

路由请求到匹配的 LSP 服务器。自动懒启动。无匹配服务器时返回 `undefined`。

#### `openFile(filePath, content): Promise<void>`

同步文件打开状态到 LSP 服务器。自动去重（已打开的文件不会重复通知）。

### LSPServerInstance

#### `sendRequest<T>(method, params): Promise<T>`

发送 LSP 请求，内置 **"content modified" 错误自动重试**（最多 3 次，指数退避 500ms/1s/2s）。这解决了 rust-analyzer 等服务器在索引期间的瞬态错误。

> 源码位置：`src/services/lsp/LSPServerInstance.ts:355`

### LSPClient

#### `createLSPClient(serverName, onCrash?): LSPClient`

创建 LSP 客户端。通过 `onCrash` 回调通知调用方进程意外退出，触发状态转移到 `error`。

支持**连接前注册处理器**：`onNotification` 和 `onRequest` 在连接建立前调用时会排队，连接就绪后自动应用（`LSPClient.ts:64-71`）。

## 接口/类型定义

### `LSPServerInstance`

```typescript
type LSPServerInstance = {
  readonly name: string
  readonly config: ScopedLspServerConfig
  readonly state: LspServerState  // 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  readonly startTime: Date | undefined
  readonly lastError: Error | undefined
  readonly restartCount: number
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  isHealthy(): boolean
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams, TResult>(method: string, handler: (params: TParams) => TResult | Promise<TResult>): void
}
```

**状态机转换**：
```
stopped → starting → running
running → stopping → stopped
any → error（失败时）
error → starting（重试时，受 maxRestarts 限制）
```

### `PendingLSPDiagnostic`

```typescript
type PendingLSPDiagnostic = {
  serverName: string
  files: DiagnosticFile[]
  timestamp: number
  attachmentSent: boolean
}
```

### `HandlerRegistrationResult`

```typescript
type HandlerRegistrationResult = {
  totalServers: number
  successCount: number
  registrationErrors: Array<{ serverName: string; error: string }>
  diagnosticFailures: Map<string, { count: number; lastError: string }>
}
```

## 配置项与默认值

LSP 服务器配置**仅通过插件提供**，不支持用户/项目级直接配置。关键配置字段（来自 `ScopedLspServerConfig`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `command` | `string` | 必填 | LSP 服务器可执行文件路径 |
| `args` | `string[]` | `[]` | 命令行参数 |
| `env` | `Record<string, string>` | - | 环境变量（叠加在 `subprocessEnv()` 之上） |
| `workspaceFolder` | `string` | `getCwd()` | 工作区根目录 |
| `extensionToLanguage` | `Record<string, string>` | 必填 | 文件扩展名到语言 ID 的映射（如 `{".ts": "typescript"}`） |
| `initializationOptions` | `object` | `{}` | 传递给服务器的初始化选项 |
| `maxRestarts` | `number` | `3` | 最大重启次数（含手动重启和崩溃恢复） |
| `startupTimeout` | `number` | 无限制 | 初始化超时时间（毫秒） |
| `restartOnCrash` | - | **未实现** | 设置时会抛出错误 |
| `shutdownTimeout` | - | **未实现** | 设置时会抛出错误 |

诊断相关常量（硬编码于 `LSPDiagnosticRegistry.ts`）：

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_DIAGNOSTICS_PER_FILE` | 10 | 每个文件最多投递的诊断数 |
| `MAX_TOTAL_DIAGNOSTICS` | 30 | 单次查询最多投递的诊断总数 |
| `MAX_DELIVERED_FILES` | 500 | LRU 缓存跟踪的最大文件数 |
| `MAX_RETRIES_FOR_TRANSIENT_ERRORS` | 3 | content modified 错误最大重试次数 |
| `RETRY_BASE_DELAY_MS` | 500 | 重试指数退避基础延迟 |

## 边界 Case 与注意事项

- **Bare 模式自动跳过**：`initializeLspServerManager()` 在 `isBareMode()` 为 true 时直接返回，避免脚本化调用启动不必要的 LSP 进程
- **插件缓存竞态**（Issue #15521）：`loadAllPlugins()` 是 memoized 的，可能在插件列表就绪前被调用，导致初始化时拿到空列表。`reinitializeLspServerManager()` 在插件刷新时被调用以修复此问题
- **崩溃恢复有上限**：`crashRecoveryCount` 超过 `maxRestarts`（默认 3）后，服务器不再自动重启，避免持续崩溃的服务器无限 spawn 子进程（`LSPServerInstance.ts:143-150`）
- **通知是 fire-and-forget**：`LSPClient.sendNotification()` 失败时记录日志但不抛出异常（`LSPClient.ts:333`）
- **vscode-jsonrpc 懒加载**：`LSPServerInstance` 通过 `require()` 懒加载 `LSPClient`，避免 ~129KB 的 `vscode-jsonrpc` 在无 LSP 服务器时被加载（`LSPServerInstance.ts:109-112`）
- **`workspace/configuration` 请求处理**：部分 LSP 服务器（如 TypeScript）即使客户端声明不支持 `configuration` 能力，仍会发送 `workspace/configuration` 请求。Manager 注册了默认处理器返回 `null` 来满足协议要求（`LSPServerManager.ts:125-135`）
- **spawn 竞态防护**：`LSPClient.start()` 在使用 stdio 流之前等待 `spawn` 事件确认，防止 `ENOENT` 等异步错误导致未处理的 promise rejection（`LSPClient.ts:116-131`）
- **关闭顺序**：`LSPClient.stop()` 先标记 `isStopping = true` 防止错误处理器记录虚假错误，然后依次发送 `shutdown` 请求、`exit` 通知、dispose 连接、kill 进程、清除事件监听器