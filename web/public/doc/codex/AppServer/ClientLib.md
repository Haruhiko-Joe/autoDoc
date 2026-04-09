# ClientLib — App-Server 客户端库

## 概述与职责

`codex-app-server-client`（crate 名 `codex_app_server_client`）是 Codex App-Server 的**共享客户端门面库**，为 TUI、exec 等上层消费者提供统一的异步 API。它在 **AppServer** 模块体系中承担"最后一公里"角色——无论底层走进程内嵌入还是远程 WebSocket，上层调用方都通过同一组类型化接口与 App-Server 交互。

在整体架构中，AppServer 是面向 IDE 扩展和桌面应用的本地服务。ClientLib 则是 AppServer 的**进程内 / 远程双模客户端**，同级兄弟模块包括 AppServer 本身的 HTTP/WebSocket 服务端和会话管理逻辑。

该库集中处理以下职责：

- **双传输路径**：进程内（`InProcessAppServerClient`）和远程 WebSocket（`RemoteAppServerClient`）两条路径，共享相同的事件模型
- **Initialize 握手**：在连接建立后执行 `initialize` / `initialized` 协议交换
- **类型化请求/通知分发**：`request()` 和 `request_typed<T>()` 支持原始与强类型两种请求方式
- **Server Request 解析**：`resolve_server_request()` / `reject_server_request()` 处理服务端主动发起的请求
- **背压信号与事件分级**：通过有界 channel 和 `Lagged` 事件实现过载保护，关键事件（转录文本、完成通知）保证无损投递
- **优雅关闭**：带 5 秒超时的 shutdown 流程，超时后 abort worker 任务

## 关键流程

### 双模客户端统一抽象

库通过枚举 `AppServerClient` 和 `AppServerRequestHandle` 将两条传输路径统一到同一接口：

```rust
// codex-rs/app-server-client/src/lib.rs:385-388
pub enum AppServerClient {
    InProcess(InProcessAppServerClient),
    Remote(RemoteAppServerClient),
}
```

`AppServerClient` 对外暴露 `request()`、`request_typed<T>()`、`notify()`、`resolve_server_request()`、`reject_server_request()`、`next_event()`、`shutdown()` 等方法，内部根据变体委派到对应实现。消费者（TUI、exec）无需感知底层传输差异。

### 进程内路径启动流程

1. 调用 `InProcessAppServerClient::start(args)` 传入 `InProcessClientStartArgs`（`lib.rs:396`）
2. 将启动参数转换为 `InProcessStartArgs`，调用 `codex_app_server::in_process::start()` 获取 `InProcessClientHandle`
3. 创建两对有界 `mpsc` channel：`command_tx/rx`（调用方 → worker）和 `event_tx/rx`（worker → 调用方），容量由 `channel_capacity` 控制（最低 1）
4. 启动 worker 异步任务（`tokio::spawn`），进入 `tokio::select!` 主循环，同时监听：
   - **命令通道**：处理 `Request`、`Notify`、`ResolveServerRequest`、`RejectServerRequest`、`Shutdown` 五种命令
   - **事件流**：从 `handle.next_event()` 读取服务端事件并转发给消费者

> 源码位置：`codex-rs/app-server-client/src/lib.rs:396-513`

**关键细节**：Request 的等待被分离到独立 `tokio::spawn` 任务（`lib.rs:416-419`），这样 worker 主循环可以继续排空事件流，避免因请求阻塞（如等待用户审批输入）而堆积事件。

### 远程路径连接流程

1. 调用 `RemoteAppServerClient::connect(args)` 传入 `RemoteAppServerConnectArgs`（`remote.rs:139`）
2. 校验 WebSocket URL 格式；若携带 `auth_token`，验证 URL 必须是 `wss://` 或本地回环 `ws://`（安全策略，`remote.rs:92-100`）
3. 在 10 秒超时内建立 WebSocket 连接（`CONNECT_TIMEOUT`）
4. 执行 `initialize_remote_connection()`：发送 `initialize` 请求 → 等待响应（10 秒超时）→ 发送 `initialized` 通知。握手期间收到的通知/请求被缓存到 `pending_events`
5. 启动 worker 任务，进入与进程内路径类似的 `tokio::select!` 主循环，不同之处在于消息通过 WebSocket JSON-RPC 编解码

> 源码位置：`codex-rs/app-server-client/src/remote.rs:139-466`

### 事件分级与背压机制

事件被分为两个层级（`lib.rs:111-121`，`remote.rs:893-901`）：

| 层级 | 事件类型 | 投递策略 |
|------|---------|---------|
| **无损（lossless）** | `AgentMessageDelta`、`PlanDelta`、`ReasoningSummaryTextDelta`、`ReasoningTextDelta`、`ItemCompleted`、`TurnCompleted`、`Disconnected` | 阻塞等待消费者排空，保证不丢失 |
| **尽力（best-effort）** | `CommandExecutionOutputDelta`、进度通知等其他事件 | 使用 `try_send`，channel 满时丢弃并累计 `skipped_events` 计数 |

当队列恢复空间时，worker 先发送 `Lagged { skipped }` 标记告知消费者发生了事件丢失。若被丢弃的事件是 `ServerRequest`，则自动向服务端发送 JSON-RPC 错误响应（code `-32001`），避免服务端永远等待。

> 核心函数：`forward_in_process_event()`（`lib.rs:142-208`）和 `deliver_event()`（`remote.rs:807-869`）

### 优雅关闭流程

`shutdown()` 方法的执行步骤（进程内路径为例，`lib.rs:668-700`）：

1. 先 `drop(event_rx)` 释放消费侧 channel，解除 worker 中可能阻塞在 `event_tx.send()` 的无损投递
2. 通过 command channel 发送 `Shutdown` 命令，附带 oneshot 回调
3. 等待 worker 完成内部 `handle.shutdown()`，超时 5 秒（`SHUTDOWN_TIMEOUT`）
4. 若 worker 在超时内未退出，`abort()` 终止任务并等待 join

远程路径流程类似，额外包含 WebSocket close frame 的发送。

## 函数签名与参数说明

### `InProcessAppServerClient`

| 方法 | 签名 | 说明 |
|------|------|------|
| `start` | `async fn start(args: InProcessClientStartArgs) -> IoResult<Self>` | 启动进程内运行时和 worker |
| `request` | `async fn request(&self, request: ClientRequest) -> IoResult<RequestResult>` | 发送原始请求，返回 JSON-RPC result |
| `request_typed<T>` | `async fn request_typed<T: DeserializeOwned>(&self, request: ClientRequest) -> Result<T, TypedRequestError>` | 发送请求并反序列化为具体类型 |
| `notify` | `async fn notify(&self, notification: ClientNotification) -> IoResult<()>` | 发送单向通知 |
| `resolve_server_request` | `async fn resolve_server_request(&self, request_id: RequestId, result: JsonRpcResult) -> IoResult<()>` | 解析服务端请求（成功） |
| `reject_server_request` | `async fn reject_server_request(&self, request_id: RequestId, error: JSONRPCErrorError) -> IoResult<()>` | 拒绝服务端请求 |
| `next_event` | `async fn next_event(&mut self) -> Option<InProcessServerEvent>` | 获取下一个事件 |
| `request_handle` | `fn request_handle(&self) -> InProcessAppServerRequestHandle` | 获取可克隆的请求句柄 |
| `shutdown` | `async fn shutdown(self) -> IoResult<()>` | 优雅关闭 |

### `RemoteAppServerClient`

接口与 `InProcessAppServerClient` 基本一致，区别在于：
- `connect(args: RemoteAppServerConnectArgs) -> IoResult<Self>` 代替 `start`
- `next_event()` 返回 `Option<AppServerEvent>` 而非 `Option<InProcessServerEvent>`
- 内部维护 `pending_events: VecDeque<AppServerEvent>` 缓存握手期间的事件

### `AppServerRequestHandle`

可克隆的请求句柄，仅暴露 `request()` 和 `request_typed<T>()`，适合在多个异步任务间共享：

```rust
// codex-rs/app-server-client/src/lib.rs:379-383
pub enum AppServerRequestHandle {
    InProcess(InProcessAppServerRequestHandle),
    Remote(RemoteAppServerRequestHandle),
}
```

## 接口/类型定义

### `AppServerEvent`

统一的事件枚举，同时服务于进程内和远程路径（`lib.rs:68-73`）：

```rust
pub enum AppServerEvent {
    Lagged { skipped: usize },              // 背压导致事件丢失
    ServerNotification(ServerNotification), // 服务端推送的通知
    ServerRequest(ServerRequest),           // 服务端主动发起的请求
    Disconnected { message: String },       // 远程连接断开
}
```

`InProcessServerEvent` 可通过 `From` trait 自动转换为 `AppServerEvent`。

### `TypedRequestError`

分层错误类型，区分三种失败场景（`lib.rs:216-255`）：

| 变体 | 含义 | 典型场景 |
|------|------|---------|
| `Transport { method, source: IoError }` | 传输层失败 | channel 断开、WebSocket 写入失败 |
| `Server { method, source: JSONRPCErrorError }` | 服务端返回错误 | 请求被服务端拒绝 |
| `Deserialize { method, source: serde_json::Error }` | 响应解码失败 | 请求/响应类型不匹配 |

### `RequestResult`

原始请求结果类型别名（`lib.rs:65`）：

```rust
pub type RequestResult = Result<JsonRpcResult, JSONRPCErrorError>;
```

### `InProcessClientStartArgs`

进程内客户端的启动配置（`lib.rs:258-287`），包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `arg0_paths` | `Arg0DispatchPaths` | argv0 命令分发路径 |
| `config` | `Arc<Config>` | 共享配置 |
| `cli_overrides` | `Vec<(String, TomlValue)>` | CLI 配置覆盖 |
| `loader_overrides` | `LoaderOverrides` | 配置加载器覆盖 |
| `cloud_requirements` | `CloudRequirementsLoader` | 云端需求加载器 |
| `feedback` | `CodexFeedback` | 遥测/反馈接收器 |
| `config_warnings` | `Vec<ConfigWarningNotification>` | 启动配置警告 |
| `session_source` | `SessionSource` | 会话来源标识 |
| `enable_codex_api_key_env` | `bool` | 是否读取 `CODEX_API_KEY` 环境变量 |
| `client_name` / `client_version` | `String` | 客户端标识信息 |
| `experimental_api` | `bool` | 是否启用实验性 API |
| `opt_out_notification_methods` | `Vec<String>` | 不接收的通知方法列表 |
| `channel_capacity` | `usize` | channel 容量（最低 clamp 为 1） |

### `RemoteAppServerConnectArgs`

远程客户端的连接配置（`remote.rs:60-68`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `websocket_url` | `String` | WebSocket 服务端地址 |
| `auth_token` | `Option<String>` | 可选的 Bearer 认证令牌 |
| `client_name` / `client_version` | `String` | 客户端标识 |
| `experimental_api` | `bool` | 是否启用实验性 API |
| `opt_out_notification_methods` | `Vec<String>` | 不接收的通知方法列表 |
| `channel_capacity` | `usize` | 内部 channel 容量 |

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `SHUTDOWN_TIMEOUT` | 5 秒 | shutdown 等待超时（进程内 + 远程共用） |
| `CONNECT_TIMEOUT` | 10 秒 | 远程 WebSocket 连接超时 |
| `INITIALIZE_TIMEOUT` | 10 秒 | 远程 initialize 握手超时 |
| `DEFAULT_IN_PROCESS_CHANNEL_CAPACITY` | 从 `codex_app_server` 导出 | 进程内默认 channel 容量 |

## 边界 Case 与注意事项

- **Auth Token 安全策略**：`websocket_url_supports_auth_token()` 仅允许 `wss://` 或回环地址的 `ws://` 携带认证令牌（`remote.rs:92-100`），防止在非加密的公网连接上泄露凭据
- **ChatGPT Auth Token Refresh 不支持**：进程内路径收到 `ChatgptAuthTokensRefresh` server request 时自动拒绝（error code `-32000`），因为进程内客户端不持有浏览器 OAuth 能力（`lib.rs:460-478`）
- **重复 Request ID**：远程路径对重复的 `request_id` 直接返回 `InvalidInput` 错误，不发送到服务端（`remote.rs:211-217`）
- **握手期间的事件缓存**：远程路径在 `initialize` 握手完成前收到的通知和 server request 会被收集到 `pending_events`，在 `next_event()` 中优先返回
- **未知 Server Request**：远程路径收到无法解析的 server request 时，自动回复 JSON-RPC Method Not Found（code `-32601`）
- **Worker 退出清理**：远程 worker 退出时，对所有未完成的 `pending_requests` 发送 `BrokenPipe` 错误，确保调用方不会永久阻塞
- **`drop(event_rx)` 优先于 shutdown 命令**：shutdown 时先释放事件接收端，避免 worker 因无损事件的阻塞 `send()` 而无法到达 shutdown 逻辑