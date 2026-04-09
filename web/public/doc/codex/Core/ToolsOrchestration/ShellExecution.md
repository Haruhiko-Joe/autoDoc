# Shell 执行基础设施

## 概述与职责

ShellExecution 模块是 Codex Core 中 **ToolsOrchestration** 层的底层执行原语，负责将 LLM 请求的 shell 命令安全地变为实际的子进程。它处于 Core → Sandbox 调用链路的关键位置，为上层的工具调度（ToolsOrchestration）提供进程生成、输出采集、超时管理等能力。

该模块由以下 8 个文件组成，各自承担不同的职责：

| 文件 | 核心职责 |
|------|---------|
| `exec.rs` | 核心执行函数，子进程生成、沙箱选择、超时/取消、输出流式采集 |
| `exec_env.rs` | 构建子进程环境变量映射，按策略继承/排除/覆盖变量 |
| `shell.rs` | Shell 类型定义、路径解析、执行参数生成、用户默认 Shell 检测 |
| `shell_detect.rs` | 从路径字符串推断 Shell 类型（bash/zsh/powershell/sh/cmd） |
| `shell_snapshot.rs` | 捕获用户 Shell 环境快照（函数、别名、导出变量、选项），用于恢复一致的执行上下文 |
| `command_canonicalization.rs` | 将命令 argv 规范化，用于审批缓存的稳定匹配 |
| `apply_patch.rs` | 评估 apply_patch 操作的安全性并路由到适当的执行路径 |
| `user_shell_command.rs` | 格式化用户 Shell 命令的执行记录，供会话历史使用 |

## 关键流程

### 1. 命令执行主流程（exec.rs）

整个命令执行链路如下：

1. **入口** `process_exec_tool_call()` 接收 `ExecParams`（命令、工作目录、环境变量、超时策略等）和沙箱策略参数（`codex-rs/core/src/exec.rs:206-228`）
2. **构建请求** `build_exec_request()` 将参数转化为 `ExecRequest`：
   - 通过 `SandboxManager::new().select_initial()` 根据文件系统/网络沙箱策略自动选择沙箱类型（Seatbelt、Landlock、WindowsRestrictedToken 等）
   - 调用 `SandboxManager::transform()` 将命令包装为沙箱化的 argv
   - 在 Windows 上还会计算额外的文件系统 deny-write 覆盖层（`codex-rs/core/src/exec.rs:232-314`）
3. **执行** `exec()` 是实际的进程生成函数（`codex-rs/core/src/exec.rs:762-821`）：
   - Windows 上检测到 `WindowsRestrictedToken` 沙箱时走专门的 `exec_windows_sandbox()` 路径
   - 其他平台使用 `spawn_child_async()` 生成子进程
   - 调用 `consume_output()` 处理输出和超时
4. **输出消费** `consume_output()` 是 I/O 和超时的核心协调逻辑（`codex-rs/core/src/exec.rs:997-1094`）：
   - 分别启动 stdout/stderr 读取任务（`read_output()`）
   - 使用 `tokio::select!` 并发等待：子进程退出、超时到期、或 Ctrl+C 信号
   - 超时时通过 `kill_child_process_group()` 清理整个进程组
   - 使用 `IO_DRAIN_TIMEOUT_MS`（2 秒）防止 I/O 收集任务因孙进程继承管道而永久挂起
5. **结果整理** `finalize_exec_result()` 将原始输出转为 `ExecToolCallOutput`，处理超时退出码（124）和沙箱拒绝检测（`codex-rs/core/src/exec.rs:576-634`）

### 2. 环境变量构建流程（exec_env.rs）

`create_env()` 按照 `ShellEnvironmentPolicy` 的 6 步算法构建环境变量映射（`codex-rs/core/src/exec_env.rs:20-132`）：

1. **继承策略**：根据 `inherit` 字段选择起始集——`All`（继承所有）、`None`（空白）、或 `Core`（仅核心变量如 PATH、HOME、SHELL 等）
2. **默认排除**：除非 `ignore_default_excludes` 为 true，否则自动过滤含 `KEY`、`SECRET`、`TOKEN` 的变量（防止泄露凭证）
3. **自定义排除**：按 `exclude` 模式列表过滤
4. **用户覆盖**：应用 `set` 中的键值对
5. **白名单过滤**：如果 `include_only` 非空，仅保留匹配的变量
6. **注入线程 ID**：将 `CODEX_THREAD_ID` 注入环境（如果有）

在 Windows 上还会确保 `PATHEXT` 存在以修复 CI 中的 Unicode 输出测试问题。

### 3. Shell 检测与解析流程（shell.rs + shell_detect.rs）

Shell 解析遵循多级回退策略（`codex-rs/core/src/shell.rs:165-198`）：

1. 如果提供了精确路径且文件存在 → 直接使用
2. 如果目标 Shell 类型恰好是用户默认 Shell（通过 `getpwuid_r` 查询）→ 使用默认路径
3. 通过 `which::which()` 在 PATH 中搜索
4. 尝试硬编码的回退路径（如 `/bin/zsh`、`/bin/bash`）
5. 终极回退：Unix 用 `/bin/sh`，Windows 用 `cmd.exe`

`detect_shell_type()` 通过路径的文件名部分递归匹配 Shell 类型（`codex-rs/core/src/shell_detect.rs:5-24`），先尝试完整路径匹配已知名称，失败时提取 file_stem 重试。

### 4. Shell 环境快照（shell_snapshot.rs）

快照系统在会话开始时异步捕获用户 Shell 的完整环境状态：

1. `start_snapshotting()` 创建 `watch::channel` 并启动异步任务（`codex-rs/core/src/shell_snapshot.rs:38-58`）
2. `try_new()` 执行完整的快照生命周期（`codex-rs/core/src/shell_snapshot.rs:112-181`）：
   - 为每种 Shell 类型生成对应的快照脚本（zsh/bash/sh/powershell 各有专用脚本）
   - 脚本以 login shell 模式运行以加载用户配置（.zshrc/.bashrc）
   - 快照内容包含：**函数定义、shell 选项、别名、导出变量**
   - 排除 `PWD` 和 `OLDPWD`（`EXCLUDED_EXPORT_VARS`）
   - 输出以 `# Snapshot file` 标记开头，脚本前的 preamble 被裁剪掉
3. 写入临时文件后通过 `validate_snapshot()` 验证（source 该文件确认可执行）
4. 验证通过后 rename 为最终文件
5. `Drop` 实现自动清理快照文件
6. `cleanup_stale_snapshots()` 清理 3 天以上的旧快照（`codex-rs/core/src/shell_snapshot.rs:492-548`）

快照脚本中，10 秒超时（`SNAPSHOT_TIMEOUT`）防止 Shell 初始化脚本挂起，且子进程会通过 `detach_from_tty()` 分离终端以避免干扰。

## 函数签名与参数说明

### `process_exec_tool_call()`

```rust
pub async fn process_exec_tool_call(
    params: ExecParams,
    sandbox_policy: &SandboxPolicy,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_sandbox_policy: NetworkSandboxPolicy,
    sandbox_cwd: &Path,
    codex_linux_sandbox_exe: &Option<PathBuf>,
    use_legacy_landlock: bool,
    stdout_stream: Option<StdoutStream>,
) -> Result<ExecToolCallOutput>
```

这是工具调度层调用命令执行的主入口。构建沙箱请求后委托给 `crate::sandboxing::execute_env()` 执行。

> 源码位置：`codex-rs/core/src/exec.rs:206-228`

### `create_env()`

```rust
pub fn create_env(
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<ThreadId>,
) -> HashMap<String, String>
```

根据环境变量策略和当前进程环境构建子进程环境变量映射。返回的 map 应配合 `Command::env_clear()` + `Command::envs()` 使用以避免变量泄露。

> 源码位置：`codex-rs/core/src/exec_env.rs:20-25`

### `Shell::derive_exec_args()`

```rust
pub fn derive_exec_args(&self, command: &str, use_login_shell: bool) -> Vec<String>
```

将命令字符串转化为 `exec()` 所需的完整参数列表。不同 Shell 类型的行为：
- **bash/zsh/sh**：`[shell_path, "-lc"|"-c", command]`
- **PowerShell**：`[shell_path, "-NoProfile"（非 login）, "-Command", command]`
- **cmd**：`[shell_path, "/c", command]`

> 源码位置：`codex-rs/core/src/shell.rs:43-70`

### `canonicalize_command_for_approval()`

```rust
pub(crate) fn canonicalize_command_for_approval(command: &[String]) -> Vec<String>
```

将命令 argv 规范化以实现审批缓存的稳定匹配——无论使用 `/bin/bash -lc` 还是 `bash -lc`，同一条命令都会产生相同的规范化结果。对简单命令提取实际命令序列，对复杂脚本保留完整文本并加 `__codex_shell_script__` 前缀。

> 源码位置：`codex-rs/core/src/command_canonicalization.rs:14-38`

### `apply_patch()`

```rust
pub(crate) async fn apply_patch(
    turn_context: &TurnContext,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    action: ApplyPatchAction,
) -> InternalApplyPatchInvocation
```

评估 patch 操作的安全性并返回三种路由之一：
- `Output`：用户已显式批准，直接以程序化方式执行
- `DelegateToExec`：委托给 exec 系统在沙箱中执行
- 被拒绝时返回错误信息给模型

> 源码位置：`codex-rs/core/src/apply_patch.rs:36-77`

## 核心类型定义

### `ExecParams`

```rust
pub struct ExecParams {
    pub command: Vec<String>,       // 完整命令 argv
    pub cwd: PathBuf,               // 工作目录
    pub expiration: ExecExpiration,  // 超时/取消策略
    pub capture_policy: ExecCapturePolicy,  // 输出捕获模式
    pub env: HashMap<String, String>,       // 环境变量
    pub network: Option<NetworkProxy>,      // 网络代理
    pub sandbox_permissions: SandboxPermissions,
    pub windows_sandbox_level: WindowsSandboxLevel,
    pub windows_sandbox_private_desktop: bool,
    pub justification: Option<String>,
    pub arg0: Option<String>,
}
```

> 源码位置：`codex-rs/core/src/exec.rs:83-95`

### `ExecExpiration`

```rust
pub enum ExecExpiration {
    Timeout(Duration),              // 指定超时时长
    DefaultTimeout,                 // 使用默认 10 秒
    Cancellation(CancellationToken), // 通过 CancellationToken 取消
}
```

> 源码位置：`codex-rs/core/src/exec.rs:135-139`

### `ExecCapturePolicy`

```rust
pub enum ExecCapturePolicy {
    ShellTool,   // 默认：受输出上限约束（与 PTY 共享同一上限），遵守超时
    FullBuffer,  // 可信内部工具：无输出上限，不使用 exec 超时
}
```

> 源码位置：`codex-rs/core/src/exec.rs:108-116`

### `ShellType` 与 `Shell`

```rust
pub enum ShellType { Zsh, Bash, PowerShell, Sh, Cmd }

pub struct Shell {
    pub shell_type: ShellType,
    pub shell_path: PathBuf,
    pub shell_snapshot: watch::Receiver<Option<Arc<ShellSnapshot>>>,
}
```

`Shell` 通过 `watch::Receiver` 持有异步更新的快照引用，序列化时跳过快照字段。

> 源码位置：`codex-rs/core/src/shell.rs:9-28`

### `ShellSnapshot`

```rust
pub struct ShellSnapshot {
    pub path: PathBuf,  // 快照文件路径
    pub cwd: PathBuf,   // 创建快照时的工作目录
}
```

实现了 `Drop` trait，析构时自动删除快照文件。

> 源码位置：`codex-rs/core/src/shell_snapshot.rs:27-30`

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|----|------|
| `DEFAULT_EXEC_COMMAND_TIMEOUT_MS` | 10,000 ms | Shell 命令默认超时 |
| `IO_DRAIN_TIMEOUT_MS` | 2,000 ms | 子进程退出后等待 I/O 管道排空的超时 |
| `EXEC_OUTPUT_MAX_BYTES` | 与 `DEFAULT_OUTPUT_BYTES_CAP` 相同 | 单次 exec 的 stdout/stderr 保留上限 |
| `MAX_EXEC_OUTPUT_DELTAS_PER_CALL` | 10,000 | 每次 exec 发出的流式输出事件上限 |
| `EXEC_TIMEOUT_EXIT_CODE` | 124 | 超时退出码（遵循 coreutils timeout 约定） |
| `SNAPSHOT_TIMEOUT` | 10 秒 | 快照脚本执行超时 |
| `SNAPSHOT_RETENTION` | 3 天 | 旧快照文件的保留时长 |
| `CODEX_THREAD_ID_ENV_VAR` | `"CODEX_THREAD_ID"` | 注入到子进程的线程 ID 环境变量名 |

环境变量策略中的核心变量列表：
- **通用**：`PATH`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`
- **Unix 特有**：`HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LOGNAME`, `USER`
- **Windows 特有**：`PATHEXT`, `USERNAME`, `USERPROFILE`

## 边界 Case 与注意事项

- **沙箱拒绝检测是启发式的**：`is_likely_sandbox_denied()` 通过退出码和输出关键词（如 "operation not permitted"、"landlock"）推断是否为沙箱拒绝，可能存在误判。退出码 2、126、127 被视为非沙箱错误快速跳过（`codex-rs/core/src/exec.rs:641-696`）
- **孙进程可能导致 I/O 挂起**：如果子进程 fork 出的孙进程继承了 stdout/stderr 管道，`read_output` 任务会在子进程退出后继续阻塞。通过 2 秒的 `IO_DRAIN_TIMEOUT_MS` 保护，超时后 abort 读取任务
- **输出聚合的不对称分配**：当 stdout+stderr 超出上限时，默认分配 1/3 给 stdout、2/3 给 stderr，未使用的 stderr 配额可回流给 stdout（`codex-rs/core/src/exec.rs:745-758`）
- **快照不支持 PowerShell 和 cmd**：`write_shell_snapshot()` 对 PowerShell 和 Cmd 直接返回错误（`codex-rs/core/src/shell_snapshot.rs:199-201`），虽然 PowerShell 快照脚本已编写但未启用
- **Shell 检测不支持 fish**：`detect_shell_type()` 对 fish 等非标准 Shell 返回 `None`，最终会回退到 `/bin/sh` 或 `cmd.exe`
- **安全过滤**：环境变量构建默认排除名称中含 `KEY`/`SECRET`/`TOKEN` 的变量，防止 API 密钥泄露到子进程。这一行为可通过 `ignore_default_excludes` 关闭
- **Unix 上的用户 Shell 查询使用 `getpwuid_r`**（线程安全版本）而非 `getpwuid`，以避免 musl 静态链接构建中的竞态条件（`codex-rs/core/src/shell.rs:92-150`）
- **命令规范化**区分简单命令和复杂脚本：简单的 `bash -c "ls -la"` 会被提取为 `["ls", "-la"]`，而复杂脚本保留完整文本以确保审批缓存的精确匹配