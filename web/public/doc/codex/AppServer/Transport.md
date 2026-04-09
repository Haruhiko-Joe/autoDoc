# Transport 层

## 概述与职责

Transport 是 AppServer 的连接传输层，负责管理客户端与服务器之间的通信通道。它位于 AppServer 架构的最底层——在网络 I/O（或进程内通道）与 `MessageProcessor` 业务逻辑之间充当桥梁。所有来自 IDE 扩展（VS Code、Cursor、Windsurf）、桌面应用或 CLI/TUI 的连接请求，最终都通过 Transport 层进入系统。

Transport 层提供三种传输实现：

1. **Stdio**：单客户端管道传输，通过标准输入/输出通信，用于 `codex app` 的默认模式
2. **WebSocket**：多客户端 TCP 传输，基于 Axum 框架的 HTTP/WebSocket 服务器，支持并发连接
3. **In-Process**：进程内嵌入式传输，用于 TUI 和 exec 表面在同一进程中直接驱动 app-server，避免进程边界开销

在整体架构中，Transport 是 AppServer 模块的子组件，与 Core（代理引擎）、Auth（认证）等模块的交互全部通过 `MessageProcessor` 间接发生。同级模块包括会话管理、API 代理等 AppServer 内部组件。

## 关键流程

### 传输选择与启动

Transport 类型通过 `--listen` URL 参数决定（`transport/mod.rs:66-84`）：

- `stdio://`（默认）→ `AppServerTransport::Stdio`
- `ws://IP:PORT` → `AppServerTransport::WebSocket { bind_address }`

```rust
// codex-rs/app-server/src/transport/mod.rs:69-84
pub fn from_listen_url(listen_url: &str) -> Result<Self, AppServerTransportParseError> {
    if listen_url == Self::DEFAULT_LISTEN_URL {
        return Ok(Self::Stdio);
    }
    if let Some(socket_addr) = listen_url.strip_prefix("ws://") {
        let bind_address = socket_addr.parse::<SocketAddr>().map_err(|_| {
            AppServerTransportParseError::InvalidWebSocketListenUrl(listen_url.to_string())
        })?;
        return Ok(Self::WebSocket { bind_address });
    }
    Err(AppServerTransportParseError::UnsupportedListenUrl(listen_url.to_string()))
}
```

### Stdio 传输流程

Stdio 传输（`transport/stdio.rs`）是最简单的实现，固定使用 `ConnectionId(0)` 表示唯一连接：

1. 创建写入通道 `writer_tx`，发送 `TransportEvent::ConnectionOpened` 注册连接
2. 启动 **stdin reader 任务**：逐行读取 stdin，将每行 JSON 通过 `forward_incoming_message()` 解析为 `JSONRPCMessage` 并送入 transport 事件队列
3. 启动 **stdout writer 任务**：从 `writer_rx` 接收 `QueuedOutgoingMessage`，序列化为 JSON 后写入 stdout（每条消息以换行符分隔）
4. stdin EOF 时发送 `TransportEvent::ConnectionClosed` 通知连接关闭

### WebSocket 传输流程

WebSocket 传输（`transport/websocket.rs`）基于 Axum 框架，支持多客户端并发连接：

**服务器启动** (`start_websocket_acceptor`, `websocket.rs:125-165`)：
1. 绑定 TCP 监听器到指定地址
2. 注册路由：`/readyz` 和 `/healthz`（健康检查），其余路径均走 WebSocket 升级
3. 注册全局中间件 `reject_requests_with_origin_header`——拒绝包含 `Origin` 头的请求，防止浏览器跨域攻击
4. 使用 `CancellationToken` 支持优雅关闭

**连接处理** (`run_websocket_connection`, `websocket.rs:167-219`)：
1. 认证通过后，为新连接分配递增的 `ConnectionId`
2. 将 WebSocket 流拆分为读端和写端（`futures::StreamExt::split`）
3. 启动 **outbound 任务** 和 **inbound 任务** 并行运行
4. 任一任务退出时，通过 `CancellationToken` 通知对端，并发送 `ConnectionClosed` 事件

**入站循环** (`run_websocket_inbound_loop`, `websocket.rs:258-308`)：
- 接收文本消息 → 调用 `forward_incoming_message()` 转入处理管线
- Ping → 自动回复 Pong
- Close/None → 退出循环
- Binary → 丢弃并警告

**出站循环** (`run_websocket_outbound_loop`, `websocket.rs:221-256`)：
- 监听 `writer_rx`（应用消息）和 `writer_control_rx`（控制帧如 Pong）
- 序列化 `OutgoingMessage` 为 JSON 文本帧发送
- 支持 `write_complete_tx` 回调，通知发送方消息已写入

### WebSocket 认证流程

认证逻辑在 `transport/auth.rs` 中实现，在 WebSocket 升级前执行（`authorize_upgrade`, `auth.rs:238-269`）：

**两种认证模式**：

| 模式 | CLI 参数 | 验证方式 |
|------|----------|----------|
| CapabilityToken | `--ws-auth capability-token` | 对 Bearer token 做 SHA-256 哈希后与预存哈希做常量时间比较 |
| SignedBearerToken | `--ws-auth signed-bearer-token` | 使用 HMAC-SHA256 共享密钥验证 JWT 签名，校验 `exp`/`nbf`/`iss`/`aud` claims |

**Capability Token** 流程：
1. 从 `Authorization: Bearer <token>` 头提取 token
2. 计算 `SHA-256(token)` 与启动时从 `--ws-token-file` 读取并预计算的哈希做 `constant_time_eq_32` 比较

**Signed Bearer Token** 流程：
1. 提取 Bearer token（同上）
2. 使用共享密钥解码 JWT（`decode_jwt_claims`, `auth.rs:282-292`），仅接受 HS256 算法
3. 校验 `exp`（考虑 `max_clock_skew_seconds` 容差，默认 30 秒）
4. 可选校验 `nbf`、`iss`、`aud`（audience 支持单值和数组两种格式）
5. 共享密钥最少 32 字节（`MIN_SIGNED_BEARER_SECRET_BYTES`, `auth.rs:24`）

非 loopback 地址且未配置认证时，系统会输出警告（`auth.rs:231-236`）。

### In-Process 嵌入式传输

In-Process 传输（`in_process.rs`）为 TUI 和 exec 表面提供零进程边界的 app-server 运行时：

**启动流程** (`start`, `in_process.rs:328-348`)：
1. 调用 `start_uninitialized()` 创建运行时，启动三个核心 Tokio 任务
2. 自动发送 `Initialize` 请求（`RequestId::Integer(0)`）和 `Initialized` 通知
3. 返回就绪的 `InProcessClientHandle`

**运行时架构** (`start_uninitialized`, `in_process.rs:350-685`)——三个并行任务：

1. **Processor 任务**：持有 `MessageProcessor`，处理 `ProcessorCommand::Request` 和 `ProcessorCommand::Notification`，监听 `thread_created` 广播实现线程自动附加
2. **Outbound 路由任务**：从 `outgoing_rx` 接收 `OutgoingEnvelope`，调用 `route_outgoing_envelope()` 分发到 `writer_tx`
3. **主协调循环**：在 `client_rx`（来自客户端的消息）和 `writer_rx`（来自 processor 的响应）之间 `select`，完成请求/响应匹配

**请求/响应匹配**：
- 每个 `Request` 附带 `oneshot::Sender`，存入 `pending_request_responses` HashMap
- 收到 `OutgoingMessage::Response` 或 `Error` 时，通过 `RequestId` 查找并回传
- 重复的 `RequestId` 直接返回 `INVALID_REQUEST` 错误

**背压策略**（`in_process.rs:26-32`）：
- 客户端提交使用 `try_send`，队列满时返回 `WouldBlock`（`ErrorKind::WouldBlock`）
- 事件扇出在饱和时可能丢弃通知（非关键通知用 `try_send`）
- 关键通知如 `TurnCompleted` 使用阻塞 `send`，保证必达（`server_notification_requires_delivery`, `in_process.rs:97-99`）
- 服务端请求（需要客户端应答）发送失败时，立即回传错误给 `MessageProcessor`，防止审批流程挂起

**关闭流程** (`shutdown`, `in_process.rs:297-316`)：
1. 发送 `Shutdown` 消息
2. 等待确认（超时 5 秒）
3. 等待运行时任务完成（超时 5 秒后 abort）
4. 内部按顺序清理：取消所有待处理请求 → 关闭 processor → 关闭 outbound 路由

## 函数签名与核心类型

### `AppServerTransport::from_listen_url(listen_url: &str) -> Result<Self, AppServerTransportParseError>`

解析 `--listen` URL 参数，返回传输类型枚举。

> 源码位置：`codex-rs/app-server/src/transport/mod.rs:69-84`

### `start_stdio_connection(transport_event_tx, stdio_handles) -> IoResult<()>`

启动 stdio 传输，创建 stdin reader 和 stdout writer 两个后台任务。

> 源码位置：`codex-rs/app-server/src/transport/stdio.rs:19-88`

### `start_websocket_acceptor(bind_address, transport_event_tx, shutdown_token, auth_policy) -> IoResult<JoinHandle<()>>`

启动 WebSocket 服务器，返回 acceptor 任务句柄。

> 源码位置：`codex-rs/app-server/src/transport/websocket.rs:125-165`

### `authorize_upgrade(headers: &HeaderMap, policy: &WebsocketAuthPolicy) -> Result<(), WebsocketAuthError>`

在 WebSocket 升级前校验认证头。无策略时直接放行。

> 源码位置：`codex-rs/app-server/src/transport/auth.rs:238-269`

### `start(args: InProcessStartArgs) -> IoResult<InProcessClientHandle>`

启动 in-process 运行时并完成 initialize 握手，返回可直接使用的客户端句柄。

> 源码位置：`codex-rs/app-server/src/in_process.rs:328-348`

### `InProcessClientHandle`

嵌入式传输的客户端句柄，提供以下方法：
- `request(ClientRequest) -> IoResult<Result<Result, JSONRPCErrorError>>` — 发送请求并等待响应
- `notify(ClientNotification) -> IoResult<()>` — 发送通知（无响应）
- `respond_to_server_request(RequestId, Result) -> IoResult<()>` — 回应服务端请求
- `fail_server_request(RequestId, JSONRPCErrorError) -> IoResult<()>` — 拒绝服务端请求
- `next_event() -> Option<InProcessServerEvent>` — 接收下一个服务端事件
- `shutdown() -> IoResult<()>` — 关闭运行时（有超时保护）

> 源码位置：`codex-rs/app-server/src/in_process.rs:238-321`

### `OutgoingMessageSender`

出站消息发送器，是所有传输共享的消息路由核心：
- `send_request(ServerRequestPayload) -> (RequestId, Receiver<ClientRequestResult>)` — 发送服务端请求并返回响应接收器
- `send_response(ConnectionRequestId, T: Serialize)` — 发送 JSON-RPC 响应到指定连接
- `send_error(ConnectionRequestId, JSONRPCErrorError)` — 发送 JSON-RPC 错误到指定连接
- `send_server_notification(ServerNotification)` — 广播通知到所有已初始化连接
- `notify_client_response(RequestId, Result)` / `notify_client_error(RequestId, JSONRPCErrorError)` — 处理客户端对服务端请求的响应/错误

> 源码位置：`codex-rs/app-server/src/outgoing_message.rs:112-622`

### `route_outgoing_envelope(connections, envelope)`

出站消息路由核心函数。根据信封类型（`ToConnection` / `Broadcast`）将消息分发到目标连接：

- **定向发送**：发给指定 `ConnectionId` 的连接
- **广播**：发给所有已初始化且未过滤该通知类型的连接

> 源码位置：`codex-rs/app-server/src/transport/mod.rs:337-376`

## 接口与类型定义

### `TransportEvent`

传输层产生的事件，流向 `MessageProcessor`：

| 变体 | 含义 |
|------|------|
| `ConnectionOpened { connection_id, writer, disconnect_sender }` | 新连接建立 |
| `ConnectionClosed { connection_id }` | 连接关闭 |
| `IncomingMessage { connection_id, message: JSONRPCMessage }` | 收到客户端消息 |

> 源码位置：`codex-rs/app-server/src/transport/mod.rs:96-109`

### `OutgoingEnvelope`

出站消息信封，决定消息路由方式：

| 变体 | 含义 |
|------|------|
| `ToConnection { connection_id, message, write_complete_tx }` | 发送到指定连接（可选写入完成回调） |
| `Broadcast { message }` | 广播到所有已初始化连接 |

> 源码位置：`codex-rs/app-server/src/outgoing_message.rs:85-94`

### `OutgoingMessage`

出站消息的四种类型：

| 变体 | 含义 |
|------|------|
| `Request(ServerRequest)` | 服务端向客户端发起的请求（如审批请求） |
| `Response(OutgoingResponse)` | JSON-RPC 成功响应 |
| `Error(OutgoingError)` | JSON-RPC 错误响应 |
| `AppServerNotification(ServerNotification)` | 服务端通知（如 TurnCompleted、ConfigWarning） |

> 源码位置：`codex-rs/app-server/src/outgoing_message.rs:624-646`

### `ConnectionId(u64)`

连接标识符。Stdio 固定为 `ConnectionId(0)`，WebSocket 从 1 开始递增，In-Process 固定为 `ConnectionId(0)`。

> 源码位置：`codex-rs/app-server/src/outgoing_message.rs:33-40`

### `InProcessServerEvent`

In-Process 传输的事件类型：

| 变体 | 含义 |
|------|------|
| `ServerRequest(ServerRequest)` | 需要客户端应答的服务端请求 |
| `ServerNotification(ServerNotification)` | 服务端通知 |
| `Lagged { skipped: usize }` | 消费者落后，部分事件被丢弃 |

> 源码位置：`codex-rs/app-server/src/in_process.rs:136-143`

## 配置项与默认值

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `CHANNEL_CAPACITY` | 128 | 所有传输共享的有界通道容量 |
| `SHUTDOWN_TIMEOUT` | 5 秒 | In-Process 关闭超时 |
| `DEFAULT_MAX_CLOCK_SKEW_SECONDS` | 30 | JWT 时钟偏差容差（秒） |
| `MIN_SIGNED_BEARER_SECRET_BYTES` | 32 | JWT 共享密钥最小长度（字节） |
| `DEFAULT_LISTEN_URL` | `"stdio://"` | 默认传输 URL |

### WebSocket 认证 CLI 参数

| 参数 | 说明 |
|------|------|
| `--ws-auth <MODE>` | 认证模式：`capability-token` 或 `signed-bearer-token` |
| `--ws-token-file <PATH>` | Capability token 文件路径（绝对路径） |
| `--ws-shared-secret-file <PATH>` | JWT 共享密钥文件路径（绝对路径） |
| `--ws-issuer <ISSUER>` | JWT 期望的 issuer |
| `--ws-audience <AUDIENCE>` | JWT 期望的 audience |
| `--ws-max-clock-skew-seconds <SECONDS>` | JWT 时钟偏差容差 |

## 边界 Case 与注意事项

- **慢连接断开**：WebSocket 连接如果出站队列满，会被主动断开（`disconnect_connection`），防止广播阻塞其他连接。而 Stdio 连接没有 `disconnect_sender`，出站队列满时会**等待**而非断开——因为 stdio 是唯一连接，断开等于终止整个服务
- **过载保护**：入站请求队列满时，对 JSON-RPC Request 立即返回 `OVERLOADED_ERROR_CODE` 错误（`mod.rs:196-224`）；对 Response/Notification 则异步等待队列空间，不会丢弃
- **Origin 头拒绝**：WebSocket 服务器拒绝所有带 `Origin` 头的请求（`websocket.rs:86-100`），这是防止浏览器网页通过 JS 连接本地 app-server 的 CSRF 保护措施
- **通知过滤**：每个连接可以 opt-out 特定通知方法（如 `configWarning`），这些通知在路由阶段被静默丢弃（`should_skip_notification_for_connection`, `mod.rs:244-260`）
- **实验性 API 过滤**：如果连接未启用 `experimental_api`，`CommandExecutionRequestApproval` 中的实验性字段（如 `additional_permissions`）会在发送前被剥离（`filter_outgoing_message_for_connection`, `mod.rs:313-335`）
- **JWT `alg: none` 攻击防护**：JWT 解码强制使用 HS256 算法，`alg: none` 的 token 会被拒绝
- **In-Process 重复 RequestId**：如果客户端提交了与正在进行中的请求相同的 `RequestId`，会立即返回 `INVALID_REQUEST` 错误，不会进入 processor