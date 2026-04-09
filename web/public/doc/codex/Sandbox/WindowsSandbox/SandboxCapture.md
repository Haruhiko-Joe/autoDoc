# SandboxCapture — 沙箱捕获入口与编排逻辑

## 概述与职责

SandboxCapture 是 `windows-sandbox-rs` crate 的主入口模块（`lib.rs`），负责协调 Windows 沙箱中命令执行的完整生命周期。它是 **WindowsSandbox** 子系统的主要公开 API 表面，位于更大的 **Sandbox** 安全层之下——该安全层为所有命令执行提供 OS 级隔离。

该模块的核心职责包括：

1. **策略解析**：将 JSON 或预设字符串解析为 `SandboxPolicy`
2. **受限令牌创建**：根据策略类型生成只读或工作区写入权限的 Windows 令牌
3. **ACL 应用与清理**：对文件路径设置允许/拒绝写入的 ACE（访问控制条目）
4. **进程生成**：通过受限令牌以沙箱用户身份创建子进程
5. **I/O 捕获**：通过管道捕获子进程的 stdout 和 stderr
6. **超时与退出处理**：支持可选超时，超时后终止进程

同级兄弟模块包括 LinuxSandbox（Linux 沙箱实现）、NetworkProxy（网络策略代理）、ExecServer（进程生命周期管理）等。

## 模块结构

文件在顶层分为三大区域：

- **`windows_modules!` 宏与条件模块声明**（`lib.rs:5-48`）：通过宏批量声明 16 个 Windows 专用子模块（acl、token、policy、process 等），并用 `#[cfg(target_os = "windows")]` 条件编译
- **公开 API 导出**（`lib.rs:50-173`）：Windows 平台导出真实实现，非 Windows 平台导出 stub
- **`windows_impl` 模块**（`lib.rs:185-647`）：核心实现逻辑
- **`stub` 模块**（`lib.rs:649-698`）：非 Windows 平台的占位实现，所有函数均返回 `bail!("Windows sandbox is only available on Windows")`

## 关键流程

### `run_windows_sandbox_capture` 主执行流程

这是外部调用者使用的主入口函数（`lib.rs:273-294`），它直接委托给 `run_windows_sandbox_capture_with_extra_deny_write_paths`，传入空的 `additional_deny_write_paths`。

### `run_windows_sandbox_capture_with_extra_deny_write_paths` 完整流程

这是核心编排函数（`lib.rs:297-562`），按以下步骤执行：

**第一阶段：策略与环境准备**（`lib.rs:308-320`）

1. 调用 `parse_policy()` 将策略字符串解析为 `SandboxPolicy` 枚举
2. 根据策略判断是否需要阻断网络（`should_apply_network_block`）
3. 规范化环境变量：`normalize_null_device_env` 处理 NUL 设备路径，`ensure_non_interactive_pager` 确保分页器非交互
4. 如需阻断网络，调用 `apply_no_network_to_env` 修改环境变量
5. 确保 codex home 目录和 `.sandbox` 子目录存在
6. 记录执行开始日志

**第二阶段：策略校验**（`lib.rs:323-333`）

- 拒绝 `DangerFullAccess` 和 `ExternalSandbox` 策略（直接 bail）
- 拒绝没有完整磁盘读取权限的策略（需要 elevated 后端处理）

**第三阶段：令牌创建**（`lib.rs:334-365`）

根据策略类型分支处理：

- **`ReadOnly`**：加载只读 capability SID，调用 `create_readonly_token_with_cap` 创建受限令牌
- **`WorkspaceWrite`**：加载通用 workspace SID 和当前工作目录专用 SID，从当前进程令牌创建带双 SID 的工作区写入令牌（`create_workspace_write_token_with_caps_from`）

**第四阶段：ACL 设置**（`lib.rs:380-423`）

1. 调用 `compute_allow_paths` 计算允许和拒绝的路径集合
2. 合并 `additional_deny_write_paths` 到拒绝列表
3. 遍历允许路径，调用 `add_allow_ace` 添加允许 ACE；对于工作区写入模式下的 CWD 根目录使用专用 workspace SID
4. 遍历拒绝路径，调用 `add_deny_write_ace` 添加拒绝写入 ACE
5. 为 NUL 设备添加访问权限
6. 保护工作区下的 `.codex` 和 `.agents` 目录
7. 非持久化模式下记录 ACE guard 用于后续清理

**第五阶段：管道创建与进程生成**（`lib.rs:425-462`）

1. `setup_stdio_pipes()` 创建三对 Windows 管道（stdin/stdout/stderr），并设置子进程端句柄为可继承
2. 调用 `create_process_as_user` 使用受限令牌在沙箱中生成子进程
3. 关闭父进程不需要的管道端：子进程端的 stdin 读取端、stdout/stderr 写入端，以及 stdin 写入端（让子进程立即收到 EOF）

**第六阶段：I/O 捕获**（`lib.rs:464-507`）

启动两个独立线程分别读取 stdout 和 stderr 管道，每次读取 8KB 块，通过 `mpsc::channel` 将结果传回主线程。

**第七阶段：等待与退出处理**（`lib.rs:509-540`）

1. 调用 `WaitForSingleObject` 等待进程退出，支持可选超时
2. 超时时（返回 `WAIT_TIMEOUT = 0x102`）调用 `TerminateProcess` 终止子进程，退出码设为 `128 + 64 = 192`
3. 正常退出时通过 `GetExitCodeProcess` 获取退出码
4. 关闭进程和线程句柄，等待 I/O 线程完成

**第八阶段：清理**（`lib.rs:542-561`）

1. 记录成功/失败日志
2. 非持久化 ACE 模式下，遍历 guards 调用 `revoke_ace` 撤销之前添加的 ACE
3. 返回 `CaptureResult`

### `run_windows_sandbox_legacy_preflight` 预检流程

该函数（`lib.rs:564-609`）仅在 `WorkspaceWrite` 模式下执行，用于在进程生成前预先设置 ACL。与主流程不同，它**只设置 ACE 而不启动进程**，且所有 ACE 均为持久化的（不会自动清理）。适用于需要提前准备沙箱环境的场景。

## 函数签名与参数说明

### `run_windows_sandbox_capture`

```rust
pub fn run_windows_sandbox_capture(
    policy_json_or_preset: &str,     // 策略 JSON 字符串或预设名称
    sandbox_policy_cwd: &Path,       // 策略路径解析的基准目录
    codex_home: &Path,               // Codex 主目录（存放 .sandbox 等）
    command: Vec<String>,            // 要执行的命令及参数
    cwd: &Path,                      // 子进程的工作目录
    env_map: HashMap<String, String>,// 子进程的环境变量
    timeout_ms: Option<u64>,         // 可选超时（毫秒），None 表示无限等待
    use_private_desktop: bool,       // 是否使用独立的 Windows 桌面
) -> Result<CaptureResult>
```

> 源码位置：`lib.rs:273-294`

### `run_windows_sandbox_capture_with_extra_deny_write_paths`

在 `run_windows_sandbox_capture` 基础上增加 `additional_deny_write_paths: &[PathBuf]` 参数，允许调用方指定额外的拒绝写入路径。

> 源码位置：`lib.rs:297-562`

### `run_windows_sandbox_legacy_preflight`

```rust
pub fn run_windows_sandbox_legacy_preflight(
    sandbox_policy: &SandboxPolicy,
    sandbox_policy_cwd: &Path,
    codex_home: &Path,
    cwd: &Path,
    env_map: &HashMap<String, String>,
) -> Result<()>
```

仅对 `WorkspaceWrite` 策略生效，预先设置持久化 ACL。对其他策略类型直接返回 `Ok(())`。

> 源码位置：`lib.rs:564-609`

## 类型定义

### `CaptureResult`

命令执行的结果容器（`lib.rs:265-270`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `exit_code` | `i32` | 进程退出码，超时时为 192（128 + 64） |
| `stdout` | `Vec<u8>` | 标准输出的原始字节 |
| `stderr` | `Vec<u8>` | 标准错误的原始字节 |
| `timed_out` | `bool` | 是否因超时被终止 |

非 Windows 平台的 `CaptureResult`（`lib.rs:657-663`）结构相同，额外实现了 `Default` trait。

### `SandboxPolicy`（引用）

策略枚举来自 `policy` 子模块，核心变体包括：

- **`ReadOnly`**：只读沙箱，文件系统完全不可写
- **`WorkspaceWrite`**：可写工作区模式，允许对 CWD 及指定路径写入
- **`DangerFullAccess`** / **`ExternalSandbox`**：不支持，直接拒绝

## 公开 API 导出

该模块通过条件编译导出大量子模块 API（`lib.rs:50-173`），按功能分类：

- **ACL 操作**：`add_deny_write_ace`、`allow_null_device`、`ensure_allow_mask_aces`、`fetch_dacl_handle`、`path_mask_allows` 等
- **审计**：`apply_world_writable_scan_and_denies`
- **Capability SID**：`load_or_create_cap_sids`、`workspace_cap_sid_for_cwd`
- **令牌管理**：`create_readonly_token_with_cap_from`、`create_workspace_write_token_with_caps_from`、`get_current_token_for_restriction`、`convert_string_sid_to_sid`
- **进程操作**：`create_process_as_user`、`spawn_process_with_pipes`、`read_handle_loop`、`spawn_conpty_process_as_user`
- **策略**：`SandboxPolicy`、`parse_policy`
- **Setup 编排**：`run_elevated_setup`、`run_setup_refresh`、`sandbox_dir`、`sandbox_bin_dir`
- **身份管理**：`require_logon_sandbox_creds`、`sandbox_setup_is_complete`
- **工具函数**：`quote_windows_arg`、`to_wide`、`canonicalize_path`

## 边界 Case 与注意事项

- **平台限制**：非 Windows 平台上所有核心函数均为 stub，调用时直接 `bail!`。跨平台代码应在调用前检查目标平台
- **不支持的策略**：`DangerFullAccess` 和 `ExternalSandbox` 会立即报错；受限只读（无完整磁盘读取）需要使用 elevated 后端（`run_windows_sandbox_capture_elevated`）
- **超时退出码**：超时时退出码固定为 192（`128 + 64`），而非标准的 Unix 信号退出码
- **ACE 持久化差异**：`WorkspaceWrite` 模式下 ACE 是持久化的（不在执行后清理），`ReadOnly` 模式下 ACE 在执行完成后通过 guard 机制自动撤销
- **stdin 立即关闭**：父进程会立即关闭 stdin 写入端（`lib.rs:459`），子进程会收到 EOF——不支持向子进程写入数据
- **NUL 设备访问**：无论何种策略，都会确保 NUL 设备（Windows 的 `/dev/null` 等价物）可被沙箱进程访问（`lib.rs:417-419`）
- **unsafe 代码**：模块大量使用 `unsafe` 块进行 Windows API 调用和原始句柄操作，文件顶部通过 `#![allow(unsafe_op_in_unsafe_fn)]` 抑制了 Rust 2024 edition 的相关 lint