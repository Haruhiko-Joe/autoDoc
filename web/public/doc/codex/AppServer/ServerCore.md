# ServerCore — 服务器入口与主事件循环

## 概述与职责

ServerCore 是 `codex-app-server` crate 的核心启动与运行模块，负责将整个 AppServer 从进程启动到优雅关闭的全生命周期串联起来。它是 AppServer 子系统的"主函数"——接收 CLI 参数，加载配置，初始化可观测性基础设施，启动传输层（stdio 或 WebSocket），然后以三个并发 tokio task 的形式运行主事件循环：**传输接受器**、**消息处理器**、**出站路由器**。

在整体架构中，ServerCore 属于 **AppServer** 模块，与 Core（代理引擎）、Auth（认证）、Config（配置）、Observability（可观测性）等模块协作。AppServer 的兄弟模块包括 TUI（终端界面）和 CLI（命令行入口），CLI 通过 `codex app` 子命令启动 AppServer。

涉及的源文件：

| 文件 | 职责 |
|------|------|
| `src/lib.rs` | 库入口，包含 `run_main`/`run_main_with_transport`、事件循环、关闭状态机、配置加载 |
| `src/main.rs` | 二进制入口，CLI 参数解析，调用 `run_main_with_transport` |
| `src/error_code.rs` | JSON-RPC 错误码常量 |
| `src/server_request_error.rs` | turn transition 错误检测辅助 |
| `src/app_server_tracing.rs` | 请求级 tracing span 构建 |

## 关键流程

### 1. 二进制启动流程（main.rs）

`main()` 通过 `arg0_dispatch_or_else` 进行 argv[0] 分发，若不匹配特殊分发路径则进入正常的 app-server 启动：

1. 使用 clap 解析 `AppServerArgs`：`--listen`（传输地址，默认 `stdio://`）、`--session-source`（会话来源，默认 `vscode`）、认证参数
2. 从环境变量 `CODEX_APP_SERVER_MANAGED_CONFIG_PATH`（仅 debug 构建）读取可选的托管配置路径
3. 调用 `run_main_with_transport()` 进入主循环

> 源码位置：`codex-rs/app-server/src/main.rs:40-64`

### 2. 配置加载与容错（lib.rs）

`run_main_with_transport` 的前半段执行两轮配置构建：

**第一轮**：预加载配置以获取 cloud requirements（云端需求）。构建 `ConfigBuilder` → 尝试人格迁移（`maybe_migrate_personality`）→ 创建 `AuthManager` → 加载 `cloud_requirements_loader`。如果此轮失败，降级为默认的 `CloudRequirementsLoader`。

**第二轮**：带 cloud requirements 正式构建配置。如果失败，生成配置警告并回退到 `Config::load_default_with_cli_overrides`。

之后收集多种配置警告：
- exec policy 解析错误
- 被禁用的项目 `config.toml` 文件
- 启动警告（`config.startup_warnings`）
- 系统 bwrap 沙箱警告

> 源码位置：`codex-rs/app-server/src/lib.rs:369-469`

### 3. 可观测性初始化

配置加载完成后，依次初始化：

1. **OpenTelemetry provider**：`codex_core::otel_init::build_provider()`，传入包版本和 `"codex-app-server"` 服务名
2. **tracing subscriber**：根据环境变量 `LOG_FORMAT`（支持 `json` 或默认文本格式）构建 stderr 日志层，叠加：
   - 反馈日志层（`feedback.logger_layer()`）
   - 反馈元数据层（`feedback.metadata_layer()`）
   - SQLite 日志数据库层（`log_db`）
   - OTel logger 和 tracing 层
3. 将收集到的配置警告以 `error!` 级别输出到日志

> 源码位置：`codex-rs/app-server/src/lib.rs:473-530`

### 4. 传输层启动

根据 `AppServerTransport` 枚举选择传输方式：

- **`Stdio`**：调用 `start_stdio_connection()`，单客户端模式，连接断开即退出
- **`WebSocket { bind_address }`**：调用 `start_websocket_acceptor()`，多客户端模式，支持优雅重启信号

模式差异由两个布尔值控制：
- `shutdown_when_no_connections`：stdio 模式为 true（最后一个连接关闭时退出）
- `graceful_signal_restart_enabled`：WebSocket 模式为 true（响应 SIGTERM/Ctrl+C 进入 drain）

> 源码位置：`codex-rs/app-server/src/lib.rs:532-554`

### 5. 三路并发任务架构

主事件循环由三个并发 tokio task 组成，通过 mpsc channel 通信：

```
传输接受器 ──TransportEvent──▶ 处理器循环 ──OutgoingEnvelope──▶ 出站路由器
                                    │                              ▲
                                    └──OutboundControlEvent────────┘
```

**出站路由器 task**（`outbound_handle`）：
- 维护 `HashMap<ConnectionId, OutboundConnectionState>` 连接映射
- 通过 `OutboundControlEvent` 接收连接打开/关闭/全部断开指令
- 通过 `OutgoingEnvelope` 接收待发送消息，调用 `route_outgoing_envelope()` 分发

**处理器 task**（`processor_handle`）：
- 创建 `MessageProcessor` 并维护连接状态 `HashMap<ConnectionId, ConnectionState>`
- 在 `tokio::select!` 中同时监听四个事件源：
  1. `shutdown_signal()`：接收 SIGTERM 或 Ctrl+C（仅 WebSocket 模式）
  2. `running_turn_count_rx.changed()`：关闭状态下监控活跃 turn 数
  3. `transport_event_rx.recv()`：处理连接打开/关闭/入站消息
  4. `thread_created_rx.recv()`：新线程创建时附加监听器

入站消息按 JSON-RPC 类型分发：`Request` → `process_request()`、`Response` → `process_response()`、`Notification` → `process_notification()`、`Error` → `process_error()`。

> 源码位置：`codex-rs/app-server/src/lib.rs:556-834`

### 6. 优雅关闭与信号处理

关闭由 `ShutdownState` 状态机管理，实现两阶段关闭协议：

**第一次信号**（`on_signal`）：设置 `requested = true`，进入 drain 模式。此时继续接受新请求，但持续检查活跃的 assistant turn 数：
- 如果 `running_turn_count == 0`：立即关闭
- 否则：等待所有 turn 完成，日志记录剩余 turn 数

**第二次信号**：设置 `forced = true`，强制关闭，不再等待正在运行的 turn。

关闭执行顺序：
1. 取消传输层接受器（`transport_shutdown_token.cancel()`）
2. 发送 `DisconnectAll` 断开所有 WebSocket 客户端
3. 非强制关闭时：`processor.drain_background_tasks()` + `processor.shutdown_threads()`
4. 等待处理器和出站路由器 task 结束
5. 等待传输接受器 handle 结束
6. 关闭 OpenTelemetry provider

`shutdown_signal()` 函数在 Unix 系统上同时监听 `SIGTERM` 和 `Ctrl+C`，非 Unix 系统仅监听 `Ctrl+C`。

> 源码位置：`codex-rs/app-server/src/lib.rs:138-155`（信号监听）、`codex-rs/app-server/src/lib.rs:157-207`（状态机）、`codex-rs/app-server/src/lib.rs:836-851`（清理）

## 函数签名与参数说明

### `run_main(arg0_paths, cli_config_overrides, loader_overrides, default_analytics_enabled) -> IoResult<()>`

便捷入口，固定使用 Stdio 传输和 VSCode 会话来源，委托给 `run_main_with_transport`。

> 源码位置：`codex-rs/app-server/src/lib.rs:333-349`

### `run_main_with_transport(...) -> IoResult<()>`

完整的服务器入口函数，参数说明：

| 参数 | 类型 | 说明 |
|------|------|------|
| `arg0_paths` | `Arg0DispatchPaths` | argv[0] 分发路径信息 |
| `cli_config_overrides` | `CliConfigOverrides` | CLI `-c key=value` 配置覆盖 |
| `loader_overrides` | `LoaderOverrides` | 配置加载器覆盖（如托管配置路径） |
| `default_analytics_enabled` | `bool` | 是否默认启用分析 |
| `transport` | `AppServerTransport` | 传输方式（Stdio 或 WebSocket） |
| `session_source` | `SessionSource` | 会话来源标识（vscode、cursor 等） |
| `auth` | `AppServerWebsocketAuthSettings` | WebSocket 认证配置 |

> 源码位置：`codex-rs/app-server/src/lib.rs:351-851`

## 接口/类型定义

### `OutboundControlEvent`（内部枚举）

处理器与出站路由器之间的控制面消息：

| 变体 | 说明 |
|------|------|
| `Opened { connection_id, writer, disconnect_sender, initialized, experimental_api_enabled, opted_out_notification_methods }` | 注册新连接的写入端 |
| `Closed { connection_id }` | 移除已关闭连接的状态 |
| `DisconnectAll` | 优雅重启时断开所有连接 |

> 源码位置：`codex-rs/app-server/src/lib.rs:110-124`

### `ShutdownState` / `ShutdownAction`（内部类型）

关闭状态机：`ShutdownState` 跟踪是否已请求关闭（`requested`）和是否强制关闭（`forced`）。`ShutdownAction` 枚举为 `Noop`（继续等待）或 `Finish`（执行关闭）。

> 源码位置：`codex-rs/app-server/src/lib.rs:126-136`

### `LogFormat`（内部枚举）

日志输出格式：`Default`（文本）或 `Json`，由环境变量 `LOG_FORMAT` 控制。

### JSON-RPC 错误码（error_code.rs）

| 常量 | 值 | 说明 |
|------|------|------|
| `INVALID_REQUEST_ERROR_CODE` | -32600 | 无效请求 |
| `INVALID_PARAMS_ERROR_CODE` | -32602 | 无效参数（公开导出） |
| `INTERNAL_ERROR_CODE` | -32603 | 内部错误 |
| `OVERLOADED_ERROR_CODE` | -32001 | 服务过载 |
| `INPUT_TOO_LARGE_ERROR_CODE` | `"input_too_large"` | 输入过大（字符串类型，公开导出） |

> 源码位置：`codex-rs/app-server/src/error_code.rs:1-5`

## 请求级 Tracing（app_server_tracing.rs）

为每个 JSON-RPC 请求构建结构化的 tracing span，包含以下字段：

- `otel.kind = "server"`、`rpc.system = "jsonrpc"`
- `rpc.method`：请求方法名
- `rpc.transport`：`"stdio"` / `"websocket"` / `"in-process"`
- `app_server.connection_id`、`app_server.client_name`、`app_server.client_version`

提供两个入口函数：
- **`request_span()`**：用于 stdio/WebSocket 传输的 JSON-RPC 请求，从 `JSONRPCRequest` 中提取 `initialize` 参数获取客户端信息，支持 W3C trace context 传播
- **`typed_request_span()`**：用于 in-process 传输的类型化请求，transport 标记为 `"in-process"`

父上下文设置优先级：请求中携带的 `traceparent` > 环境变量中的 `traceparent`。

> 源码位置：`codex-rs/app-server/src/app_server_tracing.rs:24-55`（request_span）、`codex-rs/app-server/src/app_server_tracing.rs:62-83`（typed_request_span）

## Turn Transition 错误检测（server_request_error.rs）

`is_turn_transition_server_request_error()` 函数检查 JSON-RPC 错误的 `data.reason` 字段是否为 `"turnTransition"`，用于识别因 turn 状态变更而被中断的待处理请求。

> 源码位置：`codex-rs/app-server/src/server_request_error.rs:5-12`

## 配置项与环境变量

| 环境变量 | 说明 | 默认值 |
|----------|------|--------|
| `LOG_FORMAT` | 日志格式，`json` 为 JSON 格式，其他值为默认文本格式 | 文本格式 |
| `RUST_LOG` | 标准 tracing 日志过滤器 | 由 `EnvFilter` 默认行为决定 |
| `CODEX_APP_SERVER_MANAGED_CONFIG_PATH` | 托管配置文件路径（仅 debug 构建生效） | 无 |

CLI 参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--listen <URL>` | 传输端点，`stdio://` 或 `ws://IP:PORT` | `stdio://`（`AppServerTransport::DEFAULT_LISTEN_URL`） |
| `--session-source <SOURCE>` | 会话来源标识 | `vscode` |
| 认证相关参数 | 由 `AppServerWebsocketAuthArgs` 定义 | — |

## 边界 Case 与注意事项

- **配置加载双重容错**：第一轮配置加载失败不阻塞启动（cloud requirements 降级为默认）；第二轮失败回退到默认配置并生成警告通知客户端。这确保了即使配置文件损坏，服务器仍能启动。

- **Stdio vs WebSocket 行为差异**：Stdio 模式是单客户端模式——连接断开即退出进程，不支持优雅重启信号。WebSocket 模式支持多客户端和 SIGTERM 优雅 drain。

- **强制关闭不等待 drain**：第二次收到关闭信号时跳过 `drain_background_tasks()` 和 `shutdown_threads()`，直接退出。这可能导致正在运行的 assistant turn 被中断。

- **出站路由器与处理器解耦**：写入操作（可能阻塞）在独立的出站路由器 task 中执行，避免阻塞消息处理器的事件循环。两者通过 `OutboundControlEvent` 保持连接状态同步。

- **`thread_created_rx` lag 处理**：如果 broadcast channel 出现 lag（线程创建事件积压），当前实现仅打印警告并跳过重新同步，假设线程创建频率不会高到触发 lag。