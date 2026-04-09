# MessageProcessor

## 概述与职责

`MessageProcessor` 是 AppServer 中 **RequestProcessing** 层的顶级 JSON-RPC 请求分发器。它是所有客户端消息进入服务端后的第一个处理节点——接收来自 IDE 扩展（VS Code、Cursor、Windsurf）或桌面应用的 JSON-RPC 请求，根据请求类型路由到相应的处理模块。

在 AppServer 的兄弟模块中，它与以下组件协作：
- **Protocol**：使用其定义的 `ClientRequest`、`JSONRPCRequest` 等类型进行消息解析和分发
- **Transport**：从 Transport 层接收已解析的传输事件
- **ServerAPIs**：将配置读写、文件系统操作等请求委托给专用 API 模块
- **ServerCore**：由 ServerCore 创建并驱动其事件循环

`MessageProcessor` 的核心职责可归纳为三类：

1. **请求路由**：根据 `ClientRequest` 变体将请求分发到 config/filesystem/auth 等内部处理器，或委托给 `CodexMessageProcessor` 处理核心 Codex 操作
2. **会话状态管理**：维护每个连接的 `ConnectionSessionState`（初始化状态、实验性 API 启用、通知方法过滤等）
3. **生命周期协调**：管理连接打开/关闭、线程关闭、后台任务排空等

> 源码位置：`codex-rs/app-server/src/message_processor.rs`

## 关键流程

### 请求处理主流程

1. 客户端发送 JSON-RPC 请求，由 Transport 层转交至 `process_request()` 或 `process_client_request()`
2. 创建 `RequestContext`（包含 tracing span 和可选的 W3C trace context），并通过 `run_request_with_context()` 注册到 `OutgoingMessageSender`
3. 将原始 JSON 反序列化为 `ClientRequest` 枚举——反序列化失败时直接返回 `INVALID_REQUEST_ERROR_CODE` 错误
4. 调用 `handle_client_request()` 进入路由分发逻辑

```
process_request() / process_client_request()
  └─ run_request_with_context()     ← 注册 tracing context
       └─ handle_client_request()   ← 路由分发
            ├─ Initialize           ← 内部处理
            ├─ Config*              ← ConfigApi
            ├─ Fs*                  ← FsApi / FsWatchManager
            ├─ ExternalAgentConfig* ← ExternalAgentConfigApi
            └─ 其他                 ← CodexMessageProcessor
```

> 源码位置：`codex-rs/app-server/src/message_processor.rs:301-369`

### Initialize 握手流程

Initialize 是一个特殊的请求，`MessageProcessor` 不会将其委托给 `CodexMessageProcessor`，而是直接处理：

1. **防重复初始化**：如果 `session.initialized == true`，返回 "Already initialized" 错误（`message_processor.rs:547-555`）
2. **提取客户端能力**：从 `InitializeParams.capabilities` 读取 `experimental_api` 和通知方法过滤列表，写入 `ConnectionSessionState`
3. **设置 originator**：调用 `set_default_originator()` 将客户端名称注入 HTTP User-Agent，失败时（非法 header 值）返回错误
4. **Analytics 上报**：若 `GeneralAnalytics` feature 开启，记录 initialize 事件
5. **返回响应**：构建 `InitializeResponse`（包含 user_agent、codex_home、平台信息）
6. **标记就绪**：设置 `session.initialized = true`；对 in-process 客户端立即标记 outbound ready，WebSocket 客户端则由 `lib.rs` 在完成连接级通知后再标记

> 源码位置：`codex-rs/app-server/src/message_processor.rs:542-656`

### 实验性 API 守卫

在 Initialize 之后、路由分发之前，`handle_client_request()` 会检查请求是否需要实验性 API（通过 `codex_request.experimental_reason()`）。如果需要但当前连接未启用 `experimental_api`，则返回错误而不执行请求。

> 源码位置：`codex-rs/app-server/src/message_processor.rs:669-679`

### 配置写入后的副作用

当配置发生变更时（`ConfigValueWrite`、`ConfigBatchWrite`、`ExperimentalFeatureEnablementSet`），处理器在返回响应之前会触发统一的副作用链：

1. 调用 `codex_message_processor.clear_plugin_related_caches()` 清除插件缓存
2. 调用 `maybe_start_plugin_startup_tasks_for_latest_config()` 基于新配置重新预热插件

对 `ExperimentalFeatureEnablementSet`，如果启用了 `apps` 特性，还会异步（`tokio::spawn`）刷新应用列表并广播 `AppListUpdated` 通知。

> 源码位置：`codex-rs/app-server/src/message_processor.rs:868-997`

### 外部认证刷新桥接

`ExternalAuthRefreshBridge` 实现了 `ExternalAuth` trait，作为 `AuthManager` 与客户端之间的桥梁。当 Codex 内核检测到认证 token 过期（如 API 返回 401），会通过此桥接向客户端发起 `chatgpt/auth_tokens/refresh` 服务端请求：

1. 将内部的 `ExternalAuthRefreshReason` 映射为协议层的 `ChatgptAuthTokensRefreshReason`
2. 通过 `OutgoingMessageSender.send_request()` 向客户端发送请求，获取 oneshot receiver
3. 在 **10 秒超时**（`EXTERNAL_AUTH_REFRESH_TIMEOUT`）内等待客户端响应
4. 超时则取消请求并返回 IO 错误；成功则解析为 `ExternalAuthTokens`

> 源码位置：`codex-rs/app-server/src/message_processor.rs:93-159`

## 函数签名与参数说明

### `MessageProcessor::new(args: MessageProcessorArgs) -> Self`

构造函数。初始化所有子模块（`CodexMessageProcessor`、`ConfigApi`、`FsApi` 等），设置 `AuthManager`（带外部认证桥接），创建 `ThreadManager` 和 `AnalyticsEventsClient`，并预热插件启动任务。

> 源码位置：`codex-rs/app-server/src/message_processor.rs:203-295`

### `process_request(&mut self, connection_id, request, transport, session)`

处理来自 JSON-RPC 传输层的原始请求。将 `JSONRPCRequest` 反序列化为 `ClientRequest` 后路由分发。WebSocket 客户端使用此路径。

> 源码位置：`codex-rs/app-server/src/message_processor.rs:301-369`

### `process_client_request(&mut self, connection_id, request, session, outbound_initialized)`

处理来自 in-process 嵌入器（如 TUI/exec）的已类型化请求。跳过 JSON 反序列化，直接进入路由分发。in-process 客户端在此路径中完成 outbound ready 标记。

> 源码位置：`codex-rs/app-server/src/message_processor.rs:375-413`

### `process_notification(&self, notification: JSONRPCNotification)` / `process_client_notification(&self, notification: ClientNotification)`

处理客户端通知。当前实现仅记录日志，不执行任何操作。

### `process_response(&mut self, response: JSONRPCResponse)`

处理客户端返回的 JSON-RPC 响应（用于服务端发起的请求，如认证刷新）。将结果通过 `notify_client_response` 分发给等待中的 oneshot receiver。

### `process_error(&mut self, err: JSONRPCError)`

处理客户端返回的 JSON-RPC 错误。通过 `notify_client_error` 传递给对应的请求等待方。

### 生命周期方法

| 方法 | 说明 |
|------|------|
| `shutdown_threads()` | 关闭所有活跃的 Codex 线程 |
| `drain_background_tasks()` | 排空后台任务（优雅关闭时使用） |
| `cancel_active_login()` | 取消进行中的登录流程 |
| `connection_closed(connection_id)` | 清理连接相关资源（outgoing sender、文件监视器、codex processor） |
| `clear_all_thread_listeners()` | 移除所有线程监听器 |
| `clear_runtime_references()` | 清除运行时引用（如外部认证） |

## 接口/类型定义

### `ConnectionSessionState`

每个连接的会话状态，在连接生命周期内由 `MessageProcessor` 读写。

| 字段 | 类型 | 说明 |
|------|------|------|
| `initialized` | `bool` | 是否已完成 Initialize 握手 |
| `experimental_api_enabled` | `bool` | 客户端是否启用了实验性 API |
| `opted_out_notification_methods` | `HashSet<String>` | 客户端选择不接收的通知方法集合 |
| `app_server_client_name` | `Option<String>` | 客户端标识名（如 "vscode-codex"） |
| `client_version` | `Option<String>` | 客户端版本号 |

> 源码位置：`codex-rs/app-server/src/message_processor.rs:175-182`

### `MessageProcessorArgs`

构造 `MessageProcessor` 所需的参数包。

| 字段 | 类型 | 说明 |
|------|------|------|
| `outgoing` | `Arc<OutgoingMessageSender>` | 出站消息发送器 |
| `arg0_paths` | `Arg0DispatchPaths` | 可执行文件路径信息 |
| `config` | `Arc<Config>` | 全局配置 |
| `environment_manager` | `Arc<EnvironmentManager>` | 执行环境管理器 |
| `cli_overrides` | `Vec<(String, TomlValue)>` | CLI 配置覆盖项 |
| `loader_overrides` | `LoaderOverrides` | 配置加载覆盖 |
| `cloud_requirements` | `CloudRequirementsLoader` | 云端需求加载器 |
| `feedback` | `CodexFeedback` | 用户反馈管理 |
| `log_db` | `Option<LogDbLayer>` | 可选的日志数据库层 |
| `config_warnings` | `Vec<ConfigWarningNotification>` | 配置警告列表（初始化时推送给客户端） |
| `session_source` | `SessionSource` | 会话来源（VSCode 等） |
| `enable_codex_api_key_env` | `bool` | 是否启用 Codex API key 环境变量 |
| `rpc_transport` | `AppServerRpcTransport` | RPC 传输类型（Stdio/WebSocket） |

> 源码位置：`codex-rs/app-server/src/message_processor.rs:184-198`

### `MessageProcessor` 结构体

| 字段 | 类型 | 说明 |
|------|------|------|
| `outgoing` | `Arc<OutgoingMessageSender>` | 出站消息通道 |
| `codex_message_processor` | `CodexMessageProcessor` | 核心 Codex 操作处理器 |
| `config_api` | `ConfigApi` | 配置读写 API |
| `external_agent_config_api` | `ExternalAgentConfigApi` | 外部 Agent 配置检测/导入 API |
| `fs_api` | `FsApi` | 文件系统操作 API |
| `auth_manager` | `Arc<AuthManager>` | 认证管理器 |
| `analytics_events_client` | `AnalyticsEventsClient` | 分析事件客户端 |
| `fs_watch_manager` | `FsWatchManager` | 文件监视管理器 |
| `config` | `Arc<Config>` | 全局配置引用 |
| `config_warnings` | `Arc<Vec<ConfigWarningNotification>>` | 初始化时的配置警告 |
| `rpc_transport` | `AppServerRpcTransport` | RPC 传输类型 |

> 源码位置：`codex-rs/app-server/src/message_processor.rs:161-173`

## 请求路由映射表

`handle_client_request()` 中的路由分发完整映射如下：

| ClientRequest 变体 | 处理方式 | 委托模块 |
|---|---|---|
| `Initialize` | 内部处理 | MessageProcessor 自身 |
| `ConfigRead` | `config_api.read()` | ConfigApi |
| `ConfigValueWrite` | `config_api.write_value()` + 插件缓存刷新 | ConfigApi |
| `ConfigBatchWrite` | `config_api.batch_write()` + 插件缓存刷新 | ConfigApi |
| `ConfigRequirementsRead` | `config_api.config_requirements_read()` | ConfigApi |
| `ExperimentalFeatureEnablementSet` | `config_api.set_experimental_feature_enablement()` + 可选应用列表刷新 | ConfigApi |
| `ExternalAgentConfigDetect` | `external_agent_config_api.detect()` | ExternalAgentConfigApi |
| `ExternalAgentConfigImport` | `external_agent_config_api.import()` | ExternalAgentConfigApi |
| `FsReadFile` | `fs_api.read_file()` | FsApi |
| `FsWriteFile` | `fs_api.write_file()` | FsApi |
| `FsCreateDirectory` | `fs_api.create_directory()` | FsApi |
| `FsGetMetadata` | `fs_api.get_metadata()` | FsApi |
| `FsReadDirectory` | `fs_api.read_directory()` | FsApi |
| `FsRemove` | `fs_api.remove()` | FsApi |
| `FsCopy` | `fs_api.copy()` | FsApi |
| `FsWatch` | `fs_watch_manager.watch()` | FsWatchManager |
| `FsUnwatch` | `fs_watch_manager.unwatch()` | FsWatchManager |
| 其他所有（Thread/Turn/Approval/Plugin 等） | `codex_message_processor.process_request()` | CodexMessageProcessor |

> 源码位置：`codex-rs/app-server/src/message_processor.rs:681-858`

## 边界 Case 与注意事项

- **Initialize 幂等性**：重复发送 Initialize 会返回 "Already initialized" 错误，不会重置会话状态
- **未初始化拦截**：除 Initialize 外的所有请求，在连接未初始化时都会返回 "Not initialized" 错误（`message_processor.rs:657-668`）
- **实验性 API 守卫**：请求如果带有 `experimental_reason()` 但连接未启用 `experimental_api`，会被拦截并返回错误
- **WebSocket vs In-process 路径差异**：WebSocket 路径通过 `process_request()` 进入，`outbound_initialized` 传 `None`，由 `lib.rs` 在连接级通知发送完毕后标记就绪。In-process 路径通过 `process_client_request()` 进入，在 Initialize 处理内直接标记就绪
- **认证刷新超时**：`ExternalAuthRefreshBridge` 有 10 秒硬超时，超时后取消请求并返回 IO 错误
- **Originator 设置冲突**：`set_default_originator()` 如果已被环境变量预设（`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`），会静默忽略 `AlreadyInitialized` 错误
- **CodexMessageProcessor 委托使用 `.boxed()`**：为避免异步状态机过大导致栈溢出，委托给 `CodexMessageProcessor` 的 future 被 box 化（`message_processor.rs:847-856`）
- **通知处理**：当前客户端通知（`process_notification` / `process_client_notification`）仅记录日志，未实际处理

## 测试

`tracing_tests.rs` 包含针对分布式追踪的集成测试，验证：

1. **`thread/start` span 导出**：确认无 trace context 时生成独立 trace，有远程 trace context 时正确关联 parent span，且 server span 下有 internal 子 span（`tracing_tests.rs:502-579`）
2. **`turn/start` span 父子关系**：验证 turn/start 的 server span 正确携带 `turn.id` 属性，且核心层的 `codex.op=user_input` span 是 server span 的后代（`tracing_tests.rs:581-651`）

测试使用 `TracingHarness` 封装了 mock model server、`InMemorySpanExporter`、和完整的 `MessageProcessor` 实例，通过 `wait_for_exported_spans()` 轮询等待 span 就绪后进行断言。