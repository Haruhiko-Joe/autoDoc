# ExecServer — 子进程生命周期管理服务

## 概述与职责

ExecServer 是 Codex **Sandbox 安全层**的核心组件，负责在独立进程中托管所有子进程的生命周期管理和文件系统操作。它通过 **JSON-RPC over WebSocket** 协议对外提供服务，将"在哪里执行命令"这一关注点从业务逻辑中彻底解耦。

在 Codex 的整体架构中，ExecServer 位于 Sandbox 模块内部，是 Core（代理引擎）和 ToolSystem（工具框架）执行 shell 命令时的底层基础设施。同级模块包括 OS 级沙箱（Linux namespaces/seccomp、macOS seatbelt 等）和执行策略引擎。

该 crate 同时提供三样东西：

1. **`codex-exec-server` 二进制**：独立 WebSocket 服务器，接受客户端连接并在本地执行子进程
2. **`ExecServerClient` 客户端库**：通过 WebSocket 连接远程 exec-server 的异步客户端
3. **`ExecProcess` / `ExecBackend` trait 抽象**：统一的进程执行接口，让调用方无需区分本地执行还是远程执行

## 关键流程

### 1. 服务器启动流程

1. `codex-exec-server` 二进制解析 `--listen` 参数（默认 `ws://127.0.0.1:0`）（`src/bin/codex-exec-server.rs:1-18`）
2. 调用 `run_main_with_listen_url()` → `run_transport()` → `run_websocket_listener()`（`src/server/transport.rs:49-83`）
3. 绑定 TCP 端口，在 stdout 输出实际监听地址 `ws://<addr>`
4. 进入接受连接循环：每个新 WebSocket 连接 spawn 一个独立的 `run_connection()` 任务

### 2. 连接初始化握手

每个客户端连接必须先完成初始化握手，才能使用 `process/*` 和 `fs/*` 方法：

1. 客户端发送 `initialize` 请求，携带 `clientName`
2. 服务器返回 `InitializeResponse`
3. 客户端发送 `initialized` 通知
4. 服务器标记连接为已就绪，后续方法调用才会被接受

这个两步握手由 `LocalProcess` 中的 `initialize_requested` / `initialized` 原子布尔量控制（`src/local_process.rs:131-163`）。`initialize` 只能调用一次，否则返回错误。

### 3. 进程生命周期（Process Lifecycle）

这是 ExecServer 最核心的功能，完整的进程生命周期包含以下阶段：

**启动（`process/start`）**：
1. 客户端发送 `ExecParams`，包含 `processId`（客户端选择的逻辑标识符）、`argv`、`cwd`、`env`、`tty`
2. 服务器先将 `processId` 标记为 `Starting` 状态防止并发冲突
3. 根据 `tty` 标志，分别调用 `spawn_pty_process`（PTY 模式）或 `spawn_pipe_process_no_stdin`（管道模式）
4. spawn 三个后台任务：两个 `stream_output` 收集 stdout/stderr，一个 `watch_exit` 监听退出

> 源码位置：`src/local_process.rs:165-268`

**输出收集与通知**：
- 每个输出块被赋予递增的 `seq` 序列号，存入 `VecDeque<RetainedOutputChunk>` 环形缓冲区
- 缓冲区上限为 `RETAINED_OUTPUT_BYTES_PER_PROCESS`（1MB），超出时淘汰最早的块
- 每收到新输出，服务器通过 `process/output` 通知向客户端推送 `ExecOutputDeltaNotification`
- 同时通过 `watch::Sender` 和 `Notify` 唤醒正在 `process/read` 长轮询的消费者

> 源码位置：`src/local_process.rs:509-560`

**读取（`process/read`）**：
- 支持 `after_seq`（增量读取）、`max_bytes`（限制返回量）、`wait_ms`（长轮询等待）
- 如果当前无新数据且未到截止时间，阻塞在 `output_notify` 上等待新输出到达
- 返回 `ReadResponse`，包含新 chunk 列表、是否已退出、退出码、是否已关闭

**写入（`process/write`）**：
- 仅 TTY 模式下可写入 stdin（管道模式返回 `StdinClosed`）
- 通过 `session.writer_sender()` 异步发送数据到子进程的 stdin

**退出事件链**：
1. 子进程退出 → `watch_exit` 捕获退出码 → 发送 `process/exited` 通知
2. stdout 和 stderr 流关闭 → `finish_output_stream` 递减 `open_streams` 计数
3. 当退出码已记录且所有流都关闭时 → `maybe_emit_closed` 发送 `process/closed` 通知
4. 退出 30 秒后（测试中 25ms），从进程表中移除该条目

**终止（`process/terminate`）**：
- 调用 `session.terminate()` 向子进程发送终止信号
- 返回 `TerminateResponse { running }` 标识进程是否仍在运行

### 4. 本地 vs 远程执行的透明切换

`Environment` 是统一入口（`src/environment.rs:56-141`）：

1. 检查是否配置了 `CODEX_EXEC_SERVER_URL` 环境变量
2. **有远程 URL**：通过 `ExecServerClient::connect_websocket()` 连接远程服务器，返回 `RemoteProcess` 作为 `ExecBackend`、`RemoteFileSystem` 作为 `ExecutorFileSystem`
3. **无远程 URL**：创建 `LocalProcess` 直接在本地执行，`LocalFileSystem` 直接访问本地文件系统

`EnvironmentManager` 提供 `OnceCell` 缓存，确保同一环境只创建一次（`src/environment.rs:22-53`）。

### 5. 文件系统操作

服务器通过 `fs/*` 系列 JSON-RPC 方法暴露完整的文件系统操作：

| 方法 | 功能 | 关键参数 |
|------|------|----------|
| `fs/readFile` | 读取文件内容（base64 编码） | `path` |
| `fs/writeFile` | 写入文件内容 | `path`, `dataBase64` |
| `fs/createDirectory` | 创建目录 | `path`, `recursive?` |
| `fs/getMetadata` | 获取文件元信息 | `path` |
| `fs/readDirectory` | 列出目录内容 | `path` |
| `fs/remove` | 删除文件/目录 | `path`, `recursive?`, `force?` |
| `fs/copy` | 复制文件/目录 | `sourcePath`, `destinationPath`, `recursive` |

本地实现有以下保护措施：
- 读取文件限制最大 512MB（`src/local_file_system.rs:18`）
- 复制目录时检测目标是否为源的子路径，防止无限递归（`src/local_file_system.rs:171-178`）
- 跨平台 symlink 复制支持（Unix/Windows）

## 核心 Trait 定义

### `ExecBackend`

```rust
#[async_trait]
pub trait ExecBackend: Send + Sync {
    async fn start(&self, params: ExecParams) -> Result<StartedExecProcess, ExecServerError>;
}
```

进程执行后端的统一抽象。有两个实现：
- `LocalProcess`：直接在本地通过 PTY/管道 spawn 子进程
- `RemoteProcess`：将 `start` 请求转发给远程 exec-server 的 `process/start` RPC

> 源码位置：`src/process.rs:34-37`

### `ExecProcess`

```rust
#[async_trait]
pub trait ExecProcess: Send + Sync {
    fn process_id(&self) -> &ProcessId;
    fn subscribe_wake(&self) -> watch::Receiver<u64>;
    async fn read(...) -> Result<ReadResponse, ExecServerError>;
    async fn write(&self, chunk: Vec<u8>) -> Result<WriteResponse, ExecServerError>;
    async fn terminate(&self) -> Result<(), ExecServerError>;
}
```

已启动进程的操作接口。`subscribe_wake()` 返回一个 `watch::Receiver`，调用者可用来监听输出变化而无需轮询。

> 源码位置：`src/process.rs:17-32`

### `ExecutorFileSystem`

```rust
#[async_trait]
pub trait ExecutorFileSystem: Send + Sync {
    async fn read_file(&self, path: &AbsolutePathBuf) -> FileSystemResult<Vec<u8>>;
    async fn write_file(&self, path: &AbsolutePathBuf, contents: Vec<u8>) -> FileSystemResult<()>;
    async fn create_directory(&self, path: &AbsolutePathBuf, options: CreateDirectoryOptions) -> FileSystemResult<()>;
    async fn get_metadata(&self, path: &AbsolutePathBuf) -> FileSystemResult<FileMetadata>;
    async fn read_directory(&self, path: &AbsolutePathBuf) -> FileSystemResult<Vec<ReadDirectoryEntry>>;
    async fn remove(&self, path: &AbsolutePathBuf, options: RemoveOptions) -> FileSystemResult<()>;
    async fn copy(&self, source: &AbsolutePathBuf, dest: &AbsolutePathBuf, options: CopyOptions) -> FileSystemResult<()>;
}
```

有 `LocalFileSystem`（直接 tokio::fs 调用）和 `RemoteFileSystem`（通过 RPC 转发）两个实现。

> 源码位置：`src/file_system.rs:39-65`

## JSON-RPC 协议方法一览

### 进程管理

| 方法名 | 类型 | 请求参数 | 响应 |
|--------|------|----------|------|
| `initialize` | Request | `InitializeParams { clientName }` | `InitializeResponse {}` |
| `initialized` | Notification | `{}` | — |
| `process/start` | Request | `ExecParams { processId, argv, cwd, env, tty, arg0? }` | `ExecResponse { processId }` |
| `process/read` | Request | `ReadParams { processId, afterSeq?, maxBytes?, waitMs? }` | `ReadResponse { chunks, nextSeq, exited, exitCode?, closed, failure? }` |
| `process/write` | Request | `WriteParams { processId, chunk }` | `WriteResponse { status }` |
| `process/terminate` | Request | `TerminateParams { processId }` | `TerminateResponse { running }` |

### 服务器推送通知

| 方法名 | 方向 | 载荷 |
|--------|------|------|
| `process/output` | Server→Client | `ExecOutputDeltaNotification { processId, seq, stream, chunk }` |
| `process/exited` | Server→Client | `ExecExitedNotification { processId, seq, exitCode }` |
| `process/closed` | Server→Client | `ExecClosedNotification { processId, seq }` |

### 关键类型

- **`ProcessId`**：客户端选择的逻辑进程标识符（字符串），不是 OS PID（`src/process_id.rs`）
- **`ByteChunk`**：base64 编码的字节块，用于在 JSON 中传输二进制数据（`src/protocol.rs:27-41`）
- **`ExecOutputStream`**：输出流类型枚举——`Stdout`、`Stderr`、`Pty`
- **`WriteStatus`**：写入状态枚举——`Accepted`、`UnknownProcess`、`StdinClosed`、`Starting`

## RPC 基础设施

### `RpcClient`（客户端侧）

管理出站请求和入站响应的匹配。使用原子递增的 `RequestId` 和 `HashMap<RequestId, oneshot::Sender>` 来关联异步请求-响应对。支持并发请求——即使响应乱序到达也能正确分发。

> 源码位置：`src/rpc.rs:172-304`

### `RpcRouter`（服务器侧）

类型安全的方法路由器。通过泛型 `request()` 和 `notification()` 方法注册处理函数，自动处理参数反序列化和响应序列化。路由表在 `src/server/registry.rs` 中一次性构建。

### `JsonRpcConnection`

传输层抽象（`src/connection.rs`），封装了 WebSocket 读写的异步任务。将底层 WebSocket 帧解析为 `JSONRPCMessage`，支持 Text 和 Binary 帧。测试中另提供基于 stdio 的 line-delimited JSON 传输。

## 客户端会话管理

`ExecServerClient` 内部维护一个 `ArcSwap<HashMap<ProcessId, SessionState>>` 会话注册表（`src/client.rs:110-121`）。这个设计的关键考量：

- **读路径使用 `ArcSwap`**：服务器推送通知会触发高频的 session 查找，`ArcSwap::load()` 是无锁的
- **写路径使用 `Mutex`**：`register_session` / `unregister_session` 需要原子的 copy-on-write 更新

当连接断开或通知处理出错时，`fail_all_sessions()` 会将错误信息广播到所有活跃 session 的 `failure` 字段，让下次 `read()` 调用返回合成的失败响应而非挂起（`src/client.rs:585-591`）。

## 配置项

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_EXEC_SERVER_URL` 环境变量 | 未设置（本地执行） | 设置后 `EnvironmentManager` 会连接远程 exec-server |
| `--listen` CLI 参数 | `ws://127.0.0.1:0` | 服务器监听地址，端口 0 表示系统自动分配 |
| 连接超时 | 10 秒 | WebSocket 连接和 initialize 握手的超时 |
| 输出缓冲区 | 1MB/进程 | `RETAINED_OUTPUT_BYTES_PER_PROCESS`，超出后淘汰旧数据 |
| 退出进程保留时间 | 30 秒 | 进程退出后在注册表中保留的时间，便于客户端读取剩余输出 |

## 边界 Case 与注意事项

- **`processId` 是协议层标识，不是 OS PID**。由客户端分配，在单个连接内必须唯一。相同的 `processId` 在不同连接之间互不干扰
- **管道模式不支持 stdin 写入**：当 `tty: false` 时，`process/write` 返回 `StdinClosed`。只有 PTY 模式才能向子进程写入
- **输出通知和 read 是互补的两种消费方式**：通知是实时推送但不保证客户端一定收到；`process/read` 通过 `afterSeq` 提供可靠的增量读取
- **连接断开的优雅降级**：远程客户端在 RPC 调用失败（`Closed` 错误）时会合成一个 `failure` 响应而非抛出异常，确保调用者能看到进程的"终止"事件
- **`RemoteExecProcess` 在 `Drop` 时异步注销 session**：通过 `tokio::spawn` 在后台清理注册表条目（`src/remote_process.rs:79-85`）