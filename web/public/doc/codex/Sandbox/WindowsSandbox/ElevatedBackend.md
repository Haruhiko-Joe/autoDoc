# ElevatedBackend — 提权沙箱执行路径

## 概述与职责

ElevatedBackend 是 Windows 沙箱子系统中的**提权执行路径**，负责在专用沙箱用户账户（`CodexSandboxOffline`/`CodexSandboxOnline`）下运行命令。它位于 `Sandbox > WindowsSandbox` 层级中，与同级的 restricted-token 路径不同，ElevatedBackend 通过一个独立的 `command_runner` 子进程来执行命令，而非直接在当前进程中创建受限子进程。

整个模块由两侧组成：

- **父进程侧**（`elevated_impl.rs`、`runner_pipe.rs`）：创建命名管道、启动 runner 二进制、发送 spawn 请求、收集输出
- **Runner 进程侧**（`command_runner_win.rs`、`cwd_junction.rs`）：接收请求、创建受限 token、通过 ConPTY 或管道 spawn 子进程、回传输出和退出码

两侧通过 `ipc_framed.rs` 定义的长度前缀 JSON 帧协议通信。

## 关键流程

### 完整执行链 Walkthrough

1. **入口：`run_windows_sandbox_capture()`** 
   父进程调用此函数（`elevated_impl.rs:225-480`），传入 `ElevatedSandboxCaptureRequest` 结构体，包含命令、工作目录、环境变量、策略、超时等参数。

2. **策略解析与环境准备**
   - 解析沙箱策略（`ReadOnly` 或 `WorkspaceWrite`，禁止 `DangerFullAccess`）
   - 规范化环境变量：NUL 设备路径、非交互 pager、继承 PATH
   - 注入 `GIT_CONFIG_KEY_N=safe.directory` 以允许沙箱用户访问主用户的 git 仓库（`elevated_impl.rs:117-136`）

3. **获取沙箱用户凭据与 Capability SID**
   - 调用 `require_logon_sandbox_creds()` 获取沙箱用户的登录凭据
   - 根据策略加载对应的 capability SID（只读用 `caps.readonly`，工作区写用 `caps.workspace` 加上 CWD 专属 SID）
   - 对 NUL 设备设置 ACL 允许访问（`elevated_impl.rs:265-299`）

4. **创建命名管道**
   - 生成随机管道名 `\\.\pipe\codex-runner-{random}-in/out`（`runner_pipe.rs:44-48`）
   - 创建两个命名管道，DACL 仅允许沙箱用户 SID 连接（`runner_pipe.rs:51-95`）：
     - `pipe-in`：父→Runner（`PIPE_ACCESS_OUTBOUND`），用于发送 SpawnRequest
     - `pipe-out`：Runner→父（`PIPE_ACCESS_INBOUND`），用于接收输出和退出帧

5. **启动 Runner 进程**
   - 定位 `codex-command-runner.exe`（优先使用 `CODEX_HOME/.sandbox/bin` 下的副本）
   - 通过 `CreateProcessWithLogonW()` 在沙箱用户的 logon session 下启动 runner，传入 `--pipe-in=` 和 `--pipe-out=` 参数（`elevated_impl.rs:306-374`）
   - 设置 `CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT` 创建标志
   - 抑制 WER/UI 弹窗（`SetErrorMode`）

6. **等待管道连接**
   - 父进程在两个管道上调用 `ConnectNamedPipe()` 等待 Runner 连接，容忍 `ERROR_PIPE_CONNECTED`（`runner_pipe.rs:101-111`）

7. **发送 SpawnRequest 帧**
   - 构建 `FramedMessage { version: 1, message: SpawnRequest { ... } }` 并写入 `pipe-in`
   - 等待 Runner 回复 `SpawnReady` 帧，确认子进程已启动（`elevated_impl.rs:407-427`）

8. **收集输出**
   - 循环读取 `pipe-out` 上的帧（`elevated_impl.rs:430-454`）：
     - `Output` 帧：base64 解码后追加到 `stdout` 或 `stderr` 缓冲区
     - `Exit` 帧：提取 `exit_code` 和 `timed_out`，结束循环
     - `Error` 帧：直接返回错误

9. **清理**：关闭进程句柄和线程句柄，返回 `CaptureResult`

### Runner 侧执行流程（command_runner_win.rs）

1. **启动**：`main()` 解析 `--pipe-in` 和 `--pipe-out` 参数，通过 `CreateFileW` 打开父进程创建的命名管道（`command_runner_win.rs:410-433`）

2. **读取 SpawnRequest**：从 pipe 读取第一帧，校验协议版本为 1（`command_runner_win.rs:147-160`）

3. **创建受限 Token**：
   - 获取当前 token（即沙箱用户的 token）
   - 根据策略创建受限 token：`create_readonly_token_with_caps_from()` 或 `create_workspace_write_token_with_caps_from()`（`command_runner_win.rs:214-230`）
   - 对 NUL 设备设置 ACL，释放 capability SID 内存

4. **确定有效 CWD**：
   - 检测是否存在 read ACL mutex（表明 ACL 辅助进程正在运行）
   - 若是，通过 `cwd_junction` 创建 NTFS junction 来绕过跨用户目录访问限制（`command_runner_win.rs:163-185`）

5. **Spawn 子进程**：
   - **TTY 模式**（`req.tty=true`）：通过 `spawn_conpty_process_as_user()` 使用 ConPTY 虚拟终端
   - **管道模式**（`req.tty=false`）：通过 `spawn_process_with_pipes()` 使用标准管道（`command_runner_win.rs:255-303`）

6. **Job Object**：创建 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` job 并关联子进程，确保 runner 退出时子进程也被终止（`command_runner_win.rs:89-106`）

7. **发送 SpawnReady**：回传子进程 PID 给父进程

8. **I/O 转发**：
   - 启动 stdout/stderr reader 线程，将数据 base64 编码后包装为 `Output` 帧写入管道（`command_runner_win.rs:320-345`）
   - 启动 stdin/terminate 读取线程，处理父进程发来的 `Stdin`（写入子进程 stdin）和 `Terminate`（调用 `TerminateProcess`）帧（`command_runner_win.rs:348-407`）

9. **等待退出**：`WaitForSingleObject` 等待子进程退出（支持超时），超时则 `TerminateProcess` 并设置退出码 `128+64`。关闭所有句柄后发送 `Exit` 帧（`command_runner_win.rs:508-554`）

## 函数签名与参数说明

### `run_windows_sandbox_capture(request: ElevatedSandboxCaptureRequest) -> Result<CaptureResult>`

父进程侧入口。在沙箱用户下启动 runner 并捕获命令输出。

> 源码位置：`elevated_impl.rs:225-480`

### `ElevatedSandboxCaptureRequest`

| 字段 | 类型 | 说明 |
|------|------|------|
| `policy_json_or_preset` | `&str` | 沙箱策略（JSON 或预设名） |
| `sandbox_policy_cwd` | `&Path` | 策略计算基准目录 |
| `codex_home` | `&Path` | Codex 主目录 |
| `command` | `Vec<String>` | 要执行的命令及参数 |
| `cwd` | `&Path` | 工作目录 |
| `env_map` | `HashMap<String, String>` | 环境变量 |
| `timeout_ms` | `Option<u64>` | 超时时间（毫秒） |
| `use_private_desktop` | `bool` | 是否使用独立桌面 |
| `proxy_enforced` | `bool` | 是否强制代理 |

> 源码位置：`elevated_impl.rs:4-14`

### `CaptureResult`

| 字段 | 类型 | 说明 |
|------|------|------|
| `exit_code` | `i32` | 进程退出码 |
| `stdout` | `Vec<u8>` | 标准输出 |
| `stderr` | `Vec<u8>` | 标准错误输出 |
| `timed_out` | `bool` | 是否超时 |

## 接口/类型定义

### IPC 协议消息（`ipc_framed.rs`）

`Message` 枚举定义了 7 种帧类型，使用 `#[serde(tag = "type")]` 进行 JSON 标记区分：

| 帧类型 | 方向 | 用途 |
|--------|------|------|
| `SpawnRequest` | 父→Runner | 携带完整的 spawn 参数 |
| `SpawnReady` | Runner→父 | 确认子进程已启动，携带 PID |
| `Output` | Runner→父 | 子进程 stdout/stderr 数据（base64） |
| `Stdin` | 父→Runner | 向子进程 stdin 写入数据（base64） |
| `Exit` | Runner→父 | 子进程退出码和超时标记 |
| `Error` | Runner→父 | 错误信息（含 code 和 message） |
| `Terminate` | 父→Runner | 请求终止子进程 |

> 源码位置：`ipc_framed.rs:38-48`

### `SpawnRequest` 结构体

完整 spawn 参数，关键字段包括 `command`、`cwd`、`env`、`policy_json_or_preset`、`cap_sids`（capability SID 列表）、`tty`（是否使用 ConPTY）、`stdin_open`、`use_private_desktop`。

> 源码位置：`ipc_framed.rs:52-67`

### 帧编码格式

采用**长度前缀 + JSON** 编码：

```
[4 bytes: little-endian u32 payload length][N bytes: JSON payload]
```

单帧最大 8 MiB（`MAX_FRAME_LEN`），二进制数据使用 base64 标准编码。

> 源码位置：`ipc_framed.rs:125-153`

### Runner 管道辅助（`runner_pipe.rs`）

- `pipe_pair() -> (String, String)`：生成随机管道名对（`runner_pipe.rs:44-48`）
- `create_named_pipe(name, access, sandbox_username) -> io::Result<HANDLE>`：创建带 DACL 限制的命名管道（`runner_pipe.rs:51-95`）
- `connect_pipe(h: HANDLE) -> io::Result<()>`：等待 Runner 连接（`runner_pipe.rs:101-111`）
- `find_runner_exe(codex_home, log_dir) -> PathBuf`：定位 runner 可执行文件（`runner_pipe.rs:39-41`）

## CWD Junction 机制

由于沙箱用户和主用户是不同 Windows 账户，沙箱用户可能无法直接访问主用户的工作目录。`cwd_junction.rs` 通过 NTFS junction（目录符号链接）解决这个问题：

1. 根据请求的 CWD 路径计算哈希值作为 junction 名称（`cwd_junction.rs:13-17`）
2. junction 存放在 `%USERPROFILE%\.codex\.sandbox\cwd\{hash}` 下（`cwd_junction.rs:19-24`）
3. 若 junction 已存在且是 reparse point，直接复用（热路径优化）（`cwd_junction.rs:44-50`）
4. 否则通过 `cmd /c mklink /J` 创建新 junction（`cwd_junction.rs:105-118`）
5. Runner 在 `effective_cwd()` 中检测 read ACL mutex 是否存在，若是则使用 junction 路径作为实际 CWD（`command_runner_win.rs:163-185`）

> 源码位置：`cwd_junction.rs:26-142`

## 配置项与默认值

- **管道缓冲区**：读写各 65536 字节（`runner_pipe.rs:83-84`，`elevated_impl.rs:182-183`）
- **帧大小上限**：`MAX_FRAME_LEN = 8 * 1024 * 1024`（8 MiB）（`ipc_framed.rs:24`）
- **超时处理**：无超时时使用 `INFINITE`，超时后退出码为 `128 + 64 = 192`（`command_runner_win.rs:508-516`）
- **错误模式**：父进程设置 `SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX` 抑制 WER 弹窗（`elevated_impl.rs:331`）
- **Job Object**：设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 确保 runner 退出时子进程被终止

## 边界 Case 与注意事项

- **不支持的策略**：`DangerFullAccess` 和 `ExternalSandbox` 在 `run_windows_sandbox_capture` 入口处被显式拒绝并 bail（`elevated_impl.rs:266-269`）
- **非 Windows 平台**：提供 stub 实现直接返回错误，不会编译 Windows 特定代码（`elevated_impl.rs:517-540`）
- **Git safe.directory 注入**：沙箱用户无法操作主用户拥有的 git 仓库，需通过 `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_N`/`GIT_CONFIG_VALUE_N` 环境变量注入 `safe.directory` 配置（`elevated_impl.rs:117-136`）。支持 gitfile 重定向（worktree 场景）
- **管道 ACL**：使用 SDDL 格式 `D:(A;;GA;;;{sid})` 设置仅允许沙箱用户 SID 连接，防止其他用户窃取管道通信
- **ConPTY vs 管道**：TTY 模式下 stderr 不可用（设为 `INVALID_HANDLE_VALUE`），所有输出合并到 ConPTY 的 stdout
- **Junction 路径冲突**：若 junction 路径已存在但不是 reparse point，会尝试删除后重建；删除失败则回退到原始路径