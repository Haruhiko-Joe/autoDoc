# Shell Escalation 协议

## 概述与职责

Shell Escalation 是 Codex 沙箱安全层（Sandbox）的子模块，实现了一套 **Unix 专用的 shell 命令拦截与策略执行协议**。它的核心目标是：在经过 patch 的 shell（如 zsh）执行 `exec()` 系统调用时，将该调用拦截并路由到一个中心化的策略服务器，由服务器决定该命令是直接放行（Run）、升级执行（Escalate）、还是拒绝（Deny）。

在 Codex 整体架构中，Shell Escalation 属于 **Sandbox** 节点的一部分。Sandbox 负责所有命令执行的安全隔离，而 Shell Escalation 则提供了 shell 层面的细粒度策略控制——即使命令已经在沙箱内启动了一个 shell，shell 内部执行的每一个子命令仍然受到策略管控。同级模块包括 Linux namespaces/landlock/seccomp、macOS seatbelt 等 OS 级沙箱机制。

### crate 信息

- **crate 名称**：`codex-shell-escalation`
- **二进制产物**：`codex-execve-wrapper`（exec 拦截器客户端）
- **平台限制**：仅 Unix（通过 `#[cfg(unix)]` 条件编译）

## 关键流程

### 整体架构

协议涉及三个角色：

1. **EscalateServer**：策略服务器，监听 Unix datagram socket，接收拦截请求并做出决策
2. **execve wrapper（客户端）**：被 patch 后的 shell 在每次 `exec()` 时调用的拦截器二进制
3. **Shell（zsh）**：经过 patch 的 shell，通过 `EXEC_WRAPPER` 环境变量将 `exec()` 调用重定向到 wrapper

### 会话建立流程

1. `EscalateServer::start_session()` 创建一对 Unix datagram socket（`src/unix/escalate_server.rs:191`）
2. 服务端 socket 交给后台 `escalate_task` 循环监听
3. 客户端 socket 的 fd 号通过环境变量 `CODEX_ESCALATE_SOCKET` 传递给 shell 子进程
4. `EXEC_WRAPPER` 环境变量指向 `codex-execve-wrapper` 二进制的路径
5. 客户端 socket 设置 `cloexec(false)` 以便跨 exec 继承（`src/unix/escalate_server.rs:195`）

### 命令拦截流程（非升级 / Run）

当 shell 内部执行命令时：

1. patch 后的 zsh 不直接调用 `execve()`，而是将 `EXEC_WRAPPER` 作为程序、原始命令作为参数来调用
2. wrapper 进程启动后，通过 `CODEX_ESCALATE_SOCKET` 找到 datagram socket（`src/unix/escalate_client.rs:19-28`）
3. wrapper 创建一对新的 stream socket，将服务端 fd 通过 `SCM_RIGHTS` 附在 datagram handshake 消息中发给服务器（`src/unix/escalate_client.rs:41-46`）
4. 通过 stream socket 发送 `EscalateRequest`（包含可执行文件路径、argv、工作目录、环境变量）
5. 服务器收到后，通过 `EscalationPolicy::determine_action()` 决策
6. 如果决策为 **Run**：服务器返回 `EscalateAction::Run`，wrapper 直接调用 `libc::execv()` 执行原始命令（`src/unix/escalate_client.rs:97-114`）

### 命令拦截流程（升级 / Escalate）

1. 服务器返回 `EscalateAction::Escalate`
2. wrapper 将自己的 stdin/stdout/stderr 通过 `SCM_RIGHTS` 发送给服务器（`src/unix/escalate_client.rs:64-89`）
3. 服务器调用 `ShellCommandExecutor::prepare_escalated_exec()` 准备执行参数（可能附加不同的沙箱配置）
4. 服务器在 `pre_exec` hook 中用 `dup2()` 将接收到的 fd 映射到子进程的 stdio（`src/unix/escalate_server.rs:340-347`）
5. 服务器 spawn 子进程，等待其结束，将 exit code 通过 `SuperExecResult` 返回给 wrapper
6. wrapper 以该 exit code 退出

### 命令拒绝流程（Deny）

服务器返回 `EscalateAction::Deny { reason }`，wrapper 输出拒绝信息到 stderr 并以 exit code 1 退出。

### 并发处理设计

每个拦截请求通过 datagram handshake 传递一个独立的 stream socket fd。这使得所有子进程共享同一个 `CODEX_ESCALATE_SOCKET` datagram socket 来**发送**请求，但每个请求有独立的 stream socket 用于**接收**响应，从而支持并发拦截（`src/unix/mod.rs:6-12`）。

## 函数签名与核心类型

### `EscalateServer`

```rust
pub struct EscalateServer {
    shell_path: PathBuf,
    execve_wrapper: PathBuf,
    policy: Arc<dyn EscalationPolicy>,
}
```

> 源码位置：`src/unix/escalate_server.rs:127-131`

#### `EscalateServer::new()`

```rust
pub fn new<Policy>(shell_path: PathBuf, execve_wrapper: PathBuf, policy: Policy) -> Self
where Policy: EscalationPolicy + Send + Sync + 'static
```

创建服务器实例。`shell_path` 是要使用的 shell 路径（如 `/bin/zsh`），`execve_wrapper` 是拦截器二进制路径，`policy` 是决策策略。

#### `EscalateServer::exec()`

```rust
pub async fn exec(
    &self,
    params: ExecParams,
    cancel_rx: CancellationToken,
    command_executor: Arc<dyn ShellCommandExecutor>,
) -> anyhow::Result<ExecResult>
```

一次性执行：启动会话 → 通过 executor 运行 shell 命令 → 返回结果。这是最常用的入口。

> 源码位置：`src/unix/escalate_server.rs:145-178`

#### `EscalateServer::start_session()`

```rust
pub fn start_session(
    &self,
    parent_cancellation_token: CancellationToken,
    command_executor: Arc<dyn ShellCommandExecutor>,
) -> anyhow::Result<EscalationSession>
```

启动一个长生命周期的会话，返回 `EscalationSession`。调用者自行管理 shell 进程的创建，只需要将 `session.env()` 合并到子进程环境变量中即可。

> 源码位置：`src/unix/escalate_server.rs:185-219`

### `EscalationSession`

```rust
pub struct EscalationSession {
    env: HashMap<String, String>,
    task: JoinHandle<anyhow::Result<()>>,
    client_socket: Arc<Mutex<Option<Socket>>>,
    cancellation_token: CancellationToken,
}
```

会话生命周期守卫。`Drop` 时自动关闭客户端 socket、取消 cancellation token、abort 后台任务（`src/unix/escalate_server.rs:119-125`）。

- `env()` → 返回需要注入到 shell 子进程的环境变量覆盖（`CODEX_ESCALATE_SOCKET` 和 `EXEC_WRAPPER`）
- `close_client_socket()` → 关闭父进程持有的客户端 socket 副本（shell spawn 后应立即调用）

### `EscalationPolicy` trait

```rust
#[async_trait]
pub trait EscalationPolicy: Send + Sync {
    async fn determine_action(
        &self,
        file: &AbsolutePathBuf,
        argv: &[String],
        workdir: &AbsolutePathBuf,
    ) -> anyhow::Result<EscalationDecision>;
}
```

策略抽象接口。调用者实现此 trait 来定义命令的放行/升级/拒绝逻辑。

> 源码位置：`src/unix/escalation_policy.rs:6-14`

### `ShellCommandExecutor` trait

```rust
#[async_trait]
pub trait ShellCommandExecutor: Send + Sync {
    async fn run(
        &self,
        command: Vec<String>,
        cwd: PathBuf,
        env_overlay: HashMap<String, String>,
        cancel_rx: CancellationToken,
        after_spawn: Option<Box<dyn FnOnce() + Send>>,
    ) -> anyhow::Result<ExecResult>;

    async fn prepare_escalated_exec(
        &self,
        program: &AbsolutePathBuf,
        argv: &[String],
        workdir: &AbsolutePathBuf,
        env: HashMap<String, String>,
        execution: EscalationExecution,
    ) -> anyhow::Result<PreparedExec>;
}
```

命令执行的适配器 trait，将 shell 进程的创建、输出捕获、沙箱集成等逻辑与协议本身解耦。

> 源码位置：`src/unix/escalate_server.rs:35-62`

## 接口/类型定义

### 协议消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `EscalateRequest` | wrapper → server | 包含 `file`（可执行文件路径）、`argv`、`workdir`、`env` |
| `EscalateResponse` | server → wrapper | 包含 `EscalateAction`（Run / Escalate / Deny） |
| `SuperExecMessage` | wrapper → server | 升级时发送，附带 stdio fd 列表（通过 `SCM_RIGHTS`） |
| `SuperExecResult` | server → wrapper | 升级执行的 exit code |

> 源码位置：`src/unix/escalate_protocol.rs:17-88`

### `EscalationDecision`

```rust
pub enum EscalationDecision {
    Run,                              // 在 wrapper 中直接 execv
    Escalate(EscalationExecution),    // 服务端执行
    Deny { reason: Option<String> },  // 拒绝执行
}
```

### `EscalationExecution`

```rust
pub enum EscalationExecution {
    Unsandboxed,                          // 不使用任何沙箱
    TurnDefault,                          // 使用当前 turn 的沙箱配置
    Permissions(EscalationPermissions),   // 使用显式指定的权限配置
}
```

### `ExecParams`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `command` | `String` | - | 传给 shell `-c` / `-lc` 的命令字符串 |
| `workdir` | `String` | - | 工作目录（绝对路径） |
| `timeout_ms` | `Option<u64>` | `None` | 超时时间（毫秒） |
| `login` | `Option<bool>` | `Some(true)` | 是否使用 `-lc`（login shell） |

### `ExecResult`

| 字段 | 类型 | 说明 |
|------|------|------|
| `exit_code` | `i32` | 进程退出码 |
| `stdout` | `String` | 标准输出 |
| `stderr` | `String` | 标准错误 |
| `output` | `String` | stdout+stderr 合并输出 |
| `duration` | `Duration` | 执行耗时 |
| `timed_out` | `bool` | 是否超时 |

## Socket 通信层

`socket` 模块（`src/unix/socket.rs`）封装了两种异步 Unix socket 抽象：

- **`AsyncSocket`**：基于 `SOCK_STREAM` 的帧协议 socket，使用 4 字节小端长度前缀 + JSON payload 编码，支持通过 `SCM_RIGHTS` 控制消息传递 fd
- **`AsyncDatagramSocket`**：基于 `SOCK_DGRAM` 的数据报 socket，用于初始握手（传递 stream socket 的 fd）

两者均基于 `tokio::io::AsyncFd` 包装 `socket2::Socket`，支持非阻塞 IO。关键限制：每条消息最多携带 16 个 fd（`MAX_FDS_PER_MESSAGE`），数据报最大 8192 字节（`MAX_DATAGRAM_SIZE`）。

## zsh Patch

`patches/zsh-exec-wrapper.patch` 修改了 zsh 的 `Src/exec.c` 中的 `zexecve()` 函数（`patches/zsh-exec-wrapper.patch:1-35`）：

- 检查 `EXEC_WRAPPER` 环境变量是否存在
- 如果存在，将 argv 前移 2 位，插入 wrapper 路径和原始可执行文件路径作为前两个参数
- 用 wrapper 替代原始可执行文件调用 `execve()`

这意味着 zsh 内的每个外部命令执行都会经过 wrapper → 策略服务器的审批流程。

## Stopwatch 工具

`Stopwatch`（`src/unix/stopwatch.rs`）提供可暂停的计时器，用于命令执行超时管理：

- `Stopwatch::new(limit)` → 有限时间计时器
- `Stopwatch::unlimited()` → 无超时计时器
- `cancellation_token()` → 返回到期时自动取消的 `CancellationToken`
- `pause_for(future)` → 在 future 执行期间暂停计时（支持嵌套，引用计数语义）

## 边界 Case 与注意事项

- **环境变量清理**：wrapper 在发送 `EscalateRequest` 时会过滤掉 `CODEX_ESCALATE_SOCKET` 和 `EXEC_WRAPPER` 两个变量，避免升级执行时产生无限递归（`src/unix/escalate_client.rs:47-49`）
- **fd 重叠处理**：当 `SCM_RIGHTS` 接收到的 fd 恰好与目标 fd 号重叠（例如接收到的 fd 被分配为 0，而目标也是 stdin=0）时，`dup2()` 的 src_fd == dst_fd 行为是 no-op，协议正确处理了这种情况
- **Run 模式直接 execv**：wrapper 在 Run 模式下直接调用 `libc::execv()` 而非 `std::process::Command`，以避免 Rust 标准库对信号掩码和 fd dup2 的干预（`src/unix/escalate_client.rs:94-114`）
- **会话 Drop 语义**：`EscalationSession` drop 时会关闭客户端 socket、取消 token 并 abort 后台任务，同时通过 `kill_on_drop(true)` 确保升级执行的子进程也被终止
- **客户端 socket 关闭时机**：shell spawn 后应立即调用 `close_client_socket()` 或通过 `after_spawn` 回调关闭父进程持有的客户端 socket 副本，否则 shell 退出时服务端无法检测 EOF