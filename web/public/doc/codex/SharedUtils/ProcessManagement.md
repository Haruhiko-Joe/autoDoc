# 进程管理（ProcessManagement）

## 概述与职责

进程管理模块是 **SharedUtils** 层的基础设施组件，为 Codex 的命令执行和沙箱子系统提供三项核心能力：

1. **PTY/Pipe 进程启动与生命周期管理**（`codex-utils-pty`）：跨平台的进程启动器，支持 Unix PTY / Windows ConPTY 和普通管道两种模式，提供输出捕获、stdin 写入、终端 resize 和进程组级别的强制终止。
2. **睡眠抑制**（`codex-utils-sleep-inhibitor`）：在 agent 活跃回合期间阻止系统进入空闲睡眠，通过 macOS IOKit、Linux systemd-inhibit / gnome-session-inhibit、Windows PowerRequest 三种平台原生 API 实现。
3. **Stdio-to-UDS 桥接**（`codex-stdio-to-uds`）：一个轻量级命令行工具和库，将进程的 stdin/stdout 双向中继到 Unix Domain Socket，用于 IPC 场景。

在架构上，本模块与 **Core**、**Sandbox**、**ToolSystem** 等上层模块紧密配合——上层通过调用 PTY crate 的 `spawn_pty_process` / `spawn_pipe_process` 来启动沙箱内的子进程，`SleepInhibitor` 则由 agent 会话在每个 turn 的开始/结束时驱动。同级的兄弟模块包括路径处理、图像处理、字符串工具、缓存等其他 SharedUtils 组件。

---

## 子模块一：PTY 进程管理（codex-utils-pty）

### 架构概览

该 crate 提供两条并行的进程启动路径，统一返回 `SpawnedProcess` 结构体：

- **PTY 模式**（`pty` 模块）：通过 `portable-pty` 库或直接 `openpty()` 系统调用创建伪终端，适用于需要交互式终端行为的场景。
- **Pipe 模式**（`pipe` 模块）：使用标准 stdin/stdout/stderr 管道，适用于非交互式命令执行，stdout 和 stderr 分流捕获。

两条路径共享 `ProcessHandle` 和 `SpawnedProcess` 类型（`process` 模块），以及进程组管理辅助函数（`process_group` 模块）。Windows 平台额外包含一套 vendored 的 ConPTY 实现（`win` 模块，源自 WezTerm）。

### 关键流程 Walkthrough

#### PTY 模式启动流程

1. **入口**：调用 `spawn_pty_process(program, args, cwd, env, arg0, size)`（`codex-rs/utils/pty/src/pty.rs:102-111`）
2. **FD 继承检查**：如果 `inherited_fds` 非空（Unix），走 `spawn_process_preserving_fds` 分支；否则走 `spawn_process_portable`
3. **Portable 路径**（`codex-rs/utils/pty/src/pty.rs:140-253`）：
   - 调用 `platform_native_pty_system()` 获取平台 PTY 系统（Unix 用 native PTY，Windows 用 ConPTY）
   - `pty_system.openpty(size)` 创建 master/slave 对
   - 通过 `pair.slave.spawn_command(command_builder)` 在 PTY 内启动子进程
   - 在 `spawn_blocking` 线程中从 master 的 reader 端循环读取输出，通过 `mpsc` channel 发送给调用方
   - 异步 writer 任务从 `mpsc` channel 接收数据，写入 master 的 writer 端
   - `spawn_blocking` 等待子进程退出，通过 `oneshot` channel 发送退出码
4. **FD 保留路径**（`codex-rs/utils/pty/src/pty.rs:256-406`，Unix 专用）：
   - 直接调用 `libc::openpty()` 创建原始 PTY（`codex-rs/utils/pty/src/pty.rs:409-437`）
   - 在 `pre_exec` 中设置新 session（`setsid`）、设置控制终端（`TIOCSCTTY`）、关闭多余 FD
   - 保留指定的文件描述符不被关闭，用于沙箱 exec-server 等需要跨 exec 传递 FD 的场景

#### Pipe 模式启动流程

1. **入口**：调用 `spawn_pipe_process(program, args, cwd, env, arg0)`（`codex-rs/utils/pty/src/pipe.rs:249-257`）
2. 内部调用 `spawn_process_with_stdin_mode`（`codex-rs/utils/pty/src/pipe.rs:94-246`）：
   - 创建 `tokio::process::Command`，配置 stdin（Piped 或 Null）、stdout、stderr 为 piped
   - Unix 下在 `pre_exec` 中调用 `detach_from_tty()` 和 `set_parent_death_signal()`
   - 分别启动 stdout 和 stderr 的异步读取任务（`read_output_stream`），数据流入各自的 `mpsc` channel
   - stdin writer 任务从 channel 接收字节并写入子进程 stdin
3. **关键区别**：Pipe 模式保留独立的 stdout/stderr 通道，而 PTY 模式将所有输出合并到 stdout 通道（PTY 的 master 端合并了子进程的 stdout 和 stderr）

#### 进程终止流程

`ProcessHandle` 提供两级终止（`codex-rs/utils/pty/src/process.rs:167-199`）：

- **`request_terminate()`**：仅 kill 子进程，保持 reader/writer 任务存活以便调用方 drain 剩余输出
- **`terminate()`**：kill 子进程 + abort 所有后台任务（reader、writer、wait）
- Unix 下终止操作基于 **进程组** 级别的 `SIGKILL`（`killpg`），确保子进程的所有后代都被清理
- `Drop` trait 自动调用 `terminate()`

### 函数签名

#### `spawn_pty_process`

```rust
pub async fn spawn_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
    size: TerminalSize,
) -> Result<SpawnedProcess>
```

在 PTY 中启动子进程。`size` 指定初始终端尺寸。

#### `spawn_pipe_process`

```rust
pub async fn spawn_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
) -> Result<SpawnedProcess>
```

使用标准管道启动子进程，stdin 保持打开。

#### `spawn_pipe_process_no_stdin`

与 `spawn_pipe_process` 签名相同，但 stdin 立即设为 `/dev/null`（Null）。

#### `combine_output_receivers`

```rust
pub fn combine_output_receivers(
    stdout_rx: mpsc::Receiver<Vec<u8>>,
    stderr_rx: mpsc::Receiver<Vec<u8>>,
) -> broadcast::Receiver<Vec<u8>>
```

将分离的 stdout/stderr `mpsc` receiver 合并为单个 `broadcast` receiver（`codex-rs/utils/pty/src/process.rs:224-256`）。

### 核心类型

#### `SpawnedProcess`

```rust
pub struct SpawnedProcess {
    pub session: ProcessHandle,    // 进程控制句柄
    pub stdout_rx: mpsc::Receiver<Vec<u8>>,  // stdout 数据流
    pub stderr_rx: mpsc::Receiver<Vec<u8>>,  // stderr 数据流（PTY 模式下为空通道）
    pub exit_rx: oneshot::Receiver<i32>,      // 退出码通知
}
```

> 源码位置：`codex-rs/utils/pty/src/process.rs:259-265`

#### `ProcessHandle`

进程交互句柄，提供以下方法：

| 方法 | 说明 |
|------|------|
| `writer_sender()` | 获取 `mpsc::Sender<Vec<u8>>` 用于向子进程 stdin 写入数据 |
| `has_exited()` | 原子查询子进程是否已退出 |
| `exit_code()` | 获取退出码（如已退出） |
| `resize(size)` | 调整 PTY 终端尺寸（仅 PTY 模式有效） |
| `close_stdin()` | 关闭子进程的 stdin 通道 |
| `request_terminate()` | kill 子进程但保留 I/O 任务 |
| `terminate()` | kill 子进程并 abort 所有后台任务 |

> 源码位置：`codex-rs/utils/pty/src/process.rs:73-200`

#### `TerminalSize`

```rust
pub struct TerminalSize {
    pub rows: u16,  // 默认 24
    pub cols: u16,  // 默认 80
}
```

### 进程组管理（process_group 模块）

集中处理进程组的 OS 级操作（`codex-rs/utils/pty/src/process_group.rs`），非 Unix 平台为 no-op：

| 函数 | 说明 |
|------|------|
| `detach_from_tty()` | 调用 `setsid()` 脱离控制终端 |
| `set_process_group()` | 调用 `setpgid(0,0)` 创建新进程组 |
| `kill_process_group(pgid)` | 向指定进程组发送 `SIGKILL` |
| `terminate_process_group(pgid)` | 向指定进程组发送 `SIGTERM`，返回 `Ok(bool)` 表示组是否存在 |
| `kill_process_group_by_pid(pid)` | 先查询 PID 对应的 PGID，再 `killpg` |
| `set_parent_death_signal(parent_pid)` | Linux 专用，通过 `prctl(PR_SET_PDEATHSIG)` 确保父进程退出时子进程收到 `SIGTERM` |

### Windows ConPTY 支持（win 模块）

vendored 自 WezTerm 项目（MIT 协议），包含三个子模块：

- **`psuedocon.rs`**：封装 `CreatePseudoConsole` / `ResizePseudoConsole` / `ClosePseudoConsole` API，通过 `shared_library!` 宏动态加载 `kernel32.dll`（或 sideloaded `conpty.dll`）。最低要求 Windows 10 build 17763。
- **`conpty.rs`**：实现 `portable_pty::PtySystem` trait 的 `ConPtySystem`，以及供外部直接使用的 `RawConPty`。
- **`procthreadattr.rs`**：封装 `ProcThreadAttributeList`，用于将 ConPTY 句柄关联到子进程。

> **本地修改**（Codex bug #13945）：修复了 WezTerm 源码中 `TerminateProcess` 返回值判断反转的 bug——Win32 API 返回非零表示成功，但上游代码将非零视为失败（`codex-rs/utils/pty/src/win/mod.rs:75-84`）。

### 边界 Case 与注意事项

- `conpty_supported()` 在非 Windows 平台始终返回 `true`，Windows 上通过 `RtlGetVersion` 检测 build 号
- PTY 模式下 stderr 通道容量为 1 且不写入数据——所有输出都通过 master 端合并到 stdout 通道
- `resize()` 在非 PTY 模式（pipe）下调用会返回错误（"process is not attached to a PTY"）
- `close_inherited_fds_except` 遍历 `/dev/fd` 关闭非标准、非保留、非 CLOEXEC 的文件描述符，确保不泄露 FD 给子进程
- 默认输出缓冲区上限：`DEFAULT_OUTPUT_BYTES_CAP = 1MB`（`codex-rs/utils/pty/src/lib.rs:10`）

---

## 子模块二：睡眠抑制器（codex-utils-sleep-inhibitor）

### 架构概览

`SleepInhibitor` 是一个状态机式的外壳，内部委托给平台特定的后端实现。当 agent 的某个 turn 处于活跃状态时，调用 `set_turn_running(true)` 获取系统级的"防止空闲睡眠"断言；turn 结束时调用 `set_turn_running(false)` 释放。

### 公开接口

```rust
pub struct SleepInhibitor { /* ... */ }

impl SleepInhibitor {
    pub fn new(enabled: bool) -> Self;
    pub fn set_turn_running(&mut self, turn_running: bool);
    pub fn is_turn_running(&self) -> bool;
}
```

> 源码位置：`codex-rs/utils/sleep-inhibitor/src/lib.rs:30-72`

- `enabled = false` 时，`set_turn_running(true)` 不会获取任何系统资源
- 多次调用 `set_turn_running(true)` 是幂等的——不会创建重复断言

### 平台实现

#### macOS（IOKit）

使用 `IOPMAssertionCreateWithName` 创建 `PreventUserIdleSystemSleep` 类型的断言（`codex-rs/utils/sleep-inhibitor/src/macos.rs:67-91`）。

- **acquire**：创建 `MacSleepAssertion`，保存 assertion ID
- **release**：drop `MacSleepAssertion`，触发 `IOPMAssertionRelease`
- FFI 绑定由 bindgen 生成（`iokit_bindings.rs`），链接 IOKit framework

#### Linux（systemd-inhibit / gnome-session-inhibit）

通过 spawning 外部命令实现（`codex-rs/utils/sleep-inhibitor/src/linux_inhibitor.rs`）：

1. 优先尝试 `systemd-inhibit --what=idle --mode=block ... -- sleep 2147483647`
2. 失败则回退到 `gnome-session-inhibit --inhibit idle ... sleep 2147483647`
3. 记住上次成功的后端，下次优先使用

关键设计：
- blocker 进程通过 `sleep i32::MAX` 保持存活
- 通过 `pre_exec` 设置 `PR_SET_PDEATHSIG(SIGTERM)` 确保父进程退出时 blocker 被清理
- `release()` 时 kill + wait blocker 进程
- `acquire()` 时检查现有 blocker 是否仍存活，避免不必要的重启

#### Windows（PowerRequest）

使用 `PowerCreateRequest` + `PowerSetRequest(PowerRequestSystemRequired)` API（`codex-rs/utils/sleep-inhibitor/src/windows_inhibitor.rs:60-95`）。

- **acquire**：创建 `REASON_CONTEXT`（包含 wide string reason），创建 power request 并设置为 SystemRequired
- **release**：drop `PowerRequest`，触发 `PowerClearRequest` + `CloseHandle`
- 匹配 macOS 的行为：阻止系统空闲睡眠但不强制显示器常亮

#### 其他平台

no-op 实现（`codex-rs/utils/sleep-inhibitor/src/dummy.rs`），`acquire` / `release` 为空函数。

---

## 子模块三：Stdio-to-UDS 桥接（codex-stdio-to-uds）

### 概述

一个独立的命令行工具和库，将当前进程的 stdin/stdout 双向桥接到指定的 Unix Domain Socket。用途是在需要通过 UDS 进行 IPC 的场景中，充当一个轻量级的 stdio 代理。

### 关键流程

`run(socket_path)` 的执行流程（`codex-rs/stdio-to-uds/src/lib.rs:20-56`）：

1. `UnixStream::connect(socket_path)` 连接到目标 UDS
2. `stream.try_clone()` 获得一个独立的 reader 句柄
3. 启动一个后台线程：从 socket reader → stdout（`io::copy`）
4. 在主线程中：从 stdin → socket writer（`io::copy`）
5. stdin EOF 后，`stream.shutdown(Write)` 半关闭写端
6. 等待 stdout 线程完成，确保所有 socket 数据都已写入 stdout

### 命令行用法

```
codex-stdio-to-uds <socket-path>
```

接受且仅接受一个参数：UDS 的文件系统路径。

> 源码位置：`codex-rs/stdio-to-uds/src/main.rs:5-19`

### 边界 Case 与注意事项

- socket 半关闭时对端可能已断开——`shutdown(Write)` 返回 `NotConnected` 时被静默忽略（`codex-rs/stdio-to-uds/src/lib.rs:44-47`）
- Windows 支持通过 `uds_windows` crate 实现 Unix Domain Socket
- 该 crate 同时提供 `lib`（`codex_stdio_to_uds::run`）和 `bin`（`codex-stdio-to-uds`）两种形态