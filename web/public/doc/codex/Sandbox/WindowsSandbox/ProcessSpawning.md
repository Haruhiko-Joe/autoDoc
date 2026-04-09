# 进程创建与终端模拟（ProcessSpawning）

## 概述与职责

ProcessSpawning 模块是 Windows 沙箱（WindowsSandbox）的进程创建层，负责在受限 token 下安全地启动子进程。它位于 Sandbox → WindowsSandbox 层级中，与同级的 ACL 文件隔离、防火墙规则、受限 token 构造等模块协作，共同实现 Windows 平台的沙箱执行环境。

本模块提供三大核心能力：

1. **`CreateProcessAsUserW` 封装**：在受限用户 token 下创建进程，包含环境块构造、命令行引用、stdio 管道设置
2. **ConPTY 伪控制台支持**：通过 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 为子进程挂载伪终端，实现 TTY 模式执行
3. **桌面隔离**：创建随机命名的私有 Windows Desktop，通过 DACL 授权沙箱 SID 访问，防止沙箱进程与用户桌面交互

模块由四个源文件组成：`process.rs`（核心进程创建）、`conpty/mod.rs`（ConPTY 封装）、`conpty/proc_thread_attr.rs`（线程属性列表）、`desktop.rs`（桌面隔离）。

---

## 关键流程

### 流程一：管道模式进程创建

这是非 TTY 场景下的标准路径，通过匿名管道捕获子进程的 stdin/stdout/stderr。

1. `spawn_process_with_pipes()` 被调用，传入受限 token、命令行参数、工作目录、环境变量等（`process.rs:185-278`）
2. 使用 `CreatePipe()` 创建最多三对匿名管道（stdin、stdout、stderr），stderr 可选择合并到 stdout（`StderrMode::MergeStdout`）
3. 调用底层 `create_process_as_user()` 创建进程：
   - 通过 `make_env_block()` 将 `HashMap<String, String>` 转换为 Windows 要求的 `\0` 分隔、`\0\0` 结尾的 UTF-16 环境块，键名按大小写不敏感排序（`process.rs:36-53`）
   - 通过 `LaunchDesktop::prepare()` 决定使用交互式桌面（`Winsta0\Default`）还是创建私有桌面
   - 对 stdio 句柄调用 `SetHandleInformation` 设置 `HANDLE_FLAG_INHERIT` 以确保子进程可继承
   - 调用 `CreateProcessAsUserW` 在受限 token 下创建进程（`process.rs:126-138`）
4. 关闭子进程端的管道句柄（in_r、out_w、err_w），保留父进程端的读写句柄
5. 根据 `StdinMode` 决定是否关闭 stdin 写端，返回 `PipeSpawnHandles`

### 流程二：ConPTY 模式进程创建

用于 `tty=true` 的场景，为子进程提供伪终端。

1. `spawn_conpty_process_as_user()` 被调用（`conpty/mod.rs:89-148`）
2. 调用 `create_conpty(80, 24)` 创建 ConPTY：
   - 底层使用 `codex_utils_pty::RawConPty` 分配伪控制台和配套管道
   - 返回 `ConptyInstance`，持有 `hpc`（伪控制台句柄）、`input_write`、`output_read`
3. 创建 `ProcThreadAttributeList`（容量为 1），通过 `set_pseudoconsole()` 将 `hpc` 绑定到属性列表（`proc_thread_attr.rs:50-69`）
4. 构造 `STARTUPINFOEXW`，将 stdio 句柄设为 `INVALID_HANDLE_VALUE`（由 ConPTY 接管），设置 `lpAttributeList`
5. 调用 `CreateProcessAsUserW` 时额外传入 `EXTENDED_STARTUPINFO_PRESENT` 标志
6. 返回 `(PROCESS_INFORMATION, ConptyInstance)` 元组，调用方通过 `input_write` 写入、`output_read` 读取

### 流程三：私有桌面创建与授权

当 `use_private_desktop = true` 时触发，将沙箱进程隔离到独立桌面。

1. `LaunchDesktop::prepare(true, ...)` 调用 `PrivateDesktop::create()`（`desktop.rs:90-125`）
2. 使用 `SmallRng` 生成随机名称 `CodexSandboxDesktop-{128位十六进制}`
3. 调用 `CreateDesktopW` 在当前窗口站（Winsta0）下创建新桌面
4. 调用 `grant_desktop_access()` 为当前用户的 Logon SID 授权：
   - 获取当前进程 token 的 Logon SID（`get_current_token_for_restriction` + `get_logon_sid_bytes`）
   - 构造 `EXPLICIT_ACCESS_W` 条目，授予 `DESKTOP_ALL_ACCESS` 权限
   - 通过 `SetEntriesInAclW` 创建新 DACL，再用 `SetSecurityInfo` 应用到桌面对象
5. 将桌面名称格式化为 `Winsta0\CodexSandboxDesktop-xxx` 设置到 `STARTUPINFOW.lpDesktop`

---

## 函数签名与参数说明

### `create_process_as_user`（`process.rs:75-159`）

```rust
pub unsafe fn create_process_as_user(
    h_token: HANDLE,           // 受限用户 token
    argv: &[String],           // 命令行参数数组
    cwd: &Path,                // 工作目录
    env_map: &HashMap<String, String>, // 环境变量
    logs_base_dir: Option<&Path>,      // 调试日志目录（可选）
    stdio: Option<(HANDLE, HANDLE, HANDLE)>, // 自定义 stdin/stdout/stderr 句柄
    use_private_desktop: bool, // 是否使用私有桌面隔离
) -> Result<CreatedProcess>
```

- 当 `stdio` 为 `None` 时，继承当前进程的标准句柄（通过 `ensure_inheritable_stdio`）
- 当 `stdio` 为 `Some` 时，使用调用方提供的管道句柄
- 返回 `CreatedProcess`，包含 `PROCESS_INFORMATION`、`STARTUPINFOW` 和所有权守卫 `LaunchDesktop`

### `spawn_process_with_pipes`（`process.rs:185-278`）

```rust
pub fn spawn_process_with_pipes(
    h_token: HANDLE,
    argv: &[String],
    cwd: &Path,
    env_map: &HashMap<String, String>,
    stdin_mode: StdinMode,     // Closed | Open
    stderr_mode: StderrMode,   // MergeStdout | Separate
    use_private_desktop: bool,
) -> Result<PipeSpawnHandles>
```

- `StdinMode::Closed`：创建后立即关闭 stdin 写端，子进程读到 EOF
- `StderrMode::MergeStdout`：stderr 与 stdout 共享同一管道写端

### `spawn_conpty_process_as_user`（`conpty/mod.rs:89-148`）

```rust
pub fn spawn_conpty_process_as_user(
    h_token: HANDLE,
    argv: &[String],
    cwd: &Path,
    env_map: &HashMap<String, String>,
    use_private_desktop: bool,
    logs_base_dir: Option<&Path>,
) -> Result<(PROCESS_INFORMATION, ConptyInstance)>
```

- 固定创建 80×24 的伪终端
- 返回的 `ConptyInstance` 可通过 `into_raw()` 转移句柄所有权，避免 `Drop` 关闭

### `make_env_block`（`process.rs:36-53`）

```rust
pub fn make_env_block(env: &HashMap<String, String>) -> Vec<u16>
```

将环境变量映射转换为 Windows `CreateProcess` 所需的 Unicode 环境块格式：`KEY=VALUE\0KEY=VALUE\0\0`。键名按大小写不敏感排序以满足 Windows 约定。

### `read_handle_loop`（`process.rs:281-307`）

```rust
pub fn read_handle_loop<F>(handle: HANDLE, on_chunk: F) -> JoinHandle<()>
```

在独立线程中以 8KB 缓冲区循环读取句柄直到 EOF，每次读取调用 `on_chunk` 回调。读完后自动关闭句柄。

---

## 接口/类型定义

### `CreatedProcess`（`process.rs:30-34`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `process_info` | `PROCESS_INFORMATION` | 包含进程句柄、线程句柄、PID、TID |
| `startup_info` | `STARTUPINFOW` | 进程启动配置信息 |
| `_desktop` | `LaunchDesktop` | 桌面生命周期守卫（RAII，Drop 时关闭私有桌面） |

### `PipeSpawnHandles`（`process.rs:177-182`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `process` | `PROCESS_INFORMATION` | 子进程信息 |
| `stdin_write` | `Option<HANDLE>` | 父进程向子进程写入的管道（`StdinMode::Closed` 时为 `None`） |
| `stdout_read` | `HANDLE` | 父进程从子进程读取 stdout 的管道 |
| `stderr_read` | `Option<HANDLE>` | stderr 独立管道（`StderrMode::MergeStdout` 时为 `None`） |

### `ConptyInstance`（`conpty/mod.rs:36-41`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `hpc` | `HANDLE` | ConPTY 伪控制台句柄 |
| `input_write` | `HANDLE` | 向 PTY 写入的管道 |
| `output_read` | `HANDLE` | 从 PTY 读取的管道 |
| `_desktop` | `LaunchDesktop` | 桌面生命周期守卫 |

实现了 `Drop` trait：按顺序关闭 `input_write`、`output_read`，最后调用 `ClosePseudoConsole(hpc)`。可通过 `into_raw()` 方法转移所有权跳过 `Drop`。

### `ProcThreadAttributeList`（`proc_thread_attr.rs:17-79`）

Windows `PROC_THREAD_ATTRIBUTE_LIST` 的 RAII 封装。核心方法：

- `new(attr_count)` — 两次调用 `InitializeProcThreadAttributeList`（第一次获取所需缓冲区大小，第二次初始化）
- `set_pseudoconsole(hpc)` — 通过 `UpdateProcThreadAttribute` 设置 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`（常量值 `0x00020016`）
- `Drop` 时调用 `DeleteProcThreadAttributeList`

### `LaunchDesktop`（`desktop.rs:57-82`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `_private_desktop` | `Option<PrivateDesktop>` | 私有桌面守卫（`Drop` 时调用 `CloseDesktop`） |
| `startup_name` | `Vec<u16>` | UTF-16 桌面名称（如 `Winsta0\Default` 或 `Winsta0\CodexSandboxDesktop-xxx`） |

### 枚举

- **`StdinMode`**：`Closed` | `Open` — 控制子进程 stdin 写端是否保留
- **`StderrMode`**：`MergeStdout` | `Separate` — 控制 stderr 是否合并到 stdout

---

## 边界 Case 与注意事项

- **PowerShell 的 STATUS_DLL_INIT_FAILED 问题**：某些进程（如 PowerShell）在受限 token 下启动时，如果 `STARTUPINFOW.lpDesktop` 未设置会失败。代码始终显式设置 `lpDesktop`，即使不使用私有桌面也指向 `Winsta0\Default`（`process.rs:93-97`）。

- **ConPTY 的 stdio 处理**：ConPTY 模式下 `STARTUPINFOEXW` 的 `hStdInput/hStdOutput/hStdError` 被设为 `INVALID_HANDLE_VALUE`，因为 I/O 完全由伪控制台接管。`bInheritHandles` 参数为 `0`（false），这与管道模式不同（`conpty/mod.rs:107-109, 125`）。

- **句柄泄漏防护**：`spawn_process_with_pipes` 在 `CreateProcessAsUserW` 失败时会清理所有已创建的管道句柄（`process.rs:239-251`）。`ConptyInstance` 和 `PrivateDesktop` 都实现了 `Drop`，确保资源最终释放。

- **环境块排序**：`make_env_block` 按大小写不敏感排序环境变量键名。这不仅是约定——某些 Windows 子系统依赖此排序顺序才能正确查找环境变量。

- **私有桌面权限**：`grant_desktop_access` 使用当前进程的 Logon SID（而非用户 SID）构造 DACL。这意味着只有同一登录会话的进程能访问该桌面，提供了会话级隔离。

- **ConPTY 尺寸固定为 80×24**：`create_conpty` 硬编码了终端尺寸（`conpty/mod.rs:113`），目前不支持运行时调整。