# SandboxCommands — `codex sandbox` 子命令组

## 概述与职责

SandboxCommands 是 Codex CLI 中的 `codex sandbox` 子命令组，允许用户在 Codex 的 OS 级沙箱内直接运行任意命令。它属于 **CLI** 模块，与同级的 TUI 入口、headless exec 模式、app-server 启动等子命令并列。上游依赖 **Sandbox** 模块提供的沙箱策略构建能力（`codex_sandboxing` crate），以及 **Config** 模块的配置加载能力（`codex_core::config`）。

该模块的核心价值是**调试与验证**：开发者可以在不启动完整 agent 会话的前提下，单独测试沙箱策略是否按预期工作。支持三种沙箱后端：

- **macOS Seatbelt**（`sandbox-exec`）
- **Linux Landlock/seccomp**（通过 `codex-linux-sandbox` 二进制）
- **Windows Restricted Token**（通过 `codex_windows_sandbox` crate）

## 关键流程

### 统一入口：`run_command_under_sandbox`

三种沙箱后端各有一个公开入口函数——`run_command_under_seatbelt`、`run_command_under_landlock`、`run_command_under_windows`——但它们都是薄包装，最终汇入同一个私有核心函数 `run_command_under_sandbox`（`debug_sandbox.rs:112-335`）。流程如下：

1. **加载配置**：调用 `load_debug_sandbox_config()` 从配置文件构建 `Config`。如果配置使用了新的 permission profiles（`default_permissions` 字段），则直接采用；否则根据 `--full-auto` 标志选择 `WorkspaceWrite` 或 `ReadOnly` 沙箱模式，并重新构建配置。
2. **构造环境变量**：通过 `create_env()` 根据 shell 环境策略生成子进程环境变量映射。
3. **Windows 特殊路径**：Windows 沙箱走完全独立的分支——在 `spawn_blocking` 中调用 `run_windows_sandbox_capture` 或 `run_windows_sandbox_capture_elevated`（取决于 `WindowsSandboxLevel`），收集 stdout/stderr 后直接 `process::exit`。
4. **启动网络代理**：如果配置中存在网络规格（`config.permissions.network`），启动 managed network proxy。该代理的生命周期与子进程绑定。
5. **构造沙箱命令参数**：
   - Seatbelt：调用 `create_seatbelt_command_args_for_policies()` 构建 `sandbox-exec` 参数
   - Landlock：调用 `create_linux_sandbox_command_args_for_policies()` 构建 `codex-linux-sandbox` 参数
6. **Spawn 子进程**：通过 `spawn_debug_sandbox_child()` 启动沙箱化的子进程，继承 stdin/stdout/stderr。
7. **（macOS）Denial 日志收集**：如果启用了 `--log-denials`，在子进程退出后收集并打印沙箱拒绝事件。
8. **处理退出状态**：调用 `handle_exit_status()` 将子进程退出码传播为当前进程退出码。

### 配置加载流程

```
load_debug_sandbox_config
  └─ load_debug_sandbox_config_with_codex_home
       ├─ build_debug_sandbox_config (首次，不带 sandbox_mode)
       ├─ config_uses_permission_profiles? → 如果是，直接返回
       └─ build_debug_sandbox_config (二次，带 sandbox_mode override)
```

`config_uses_permission_profiles()`（`debug_sandbox.rs:444-450`）检查配置栈中是否存在 `default_permissions` 字段。如果存在，说明用户使用了新的 permission profiles 语法，此时 `--full-auto` 不被允许（会报错提示用户改用可写的 `[permissions]` profile）。

### macOS Denial 日志系统

当 `--log-denials` 开启时，`DenialLogger`（`seatbelt.rs:13-84`）协调两个并行任务：

1. **日志流**：通过 `log stream --style ndjson` 命令监听 macOS 系统日志中的沙箱拒绝事件（`seatbelt.rs:87-100`）。过滤条件为 Sandbox 相关的 processID 或 subsystem。
2. **PID 追踪**：`PidTracker`（`pid_tracker.rs:7-28`）使用 macOS `kqueue` 的 `EVFILT_PROC` 监听 fork/exec/exit 事件，递归追踪所有子孙进程 PID。这确保只报告属于被沙箱命令进程树的拒绝事件，而非系统中其他进程的噪音。

子进程退出后，`DenialLogger::finish()` 停止 PID 追踪、杀掉日志流进程，然后解析 NDJSON 日志，通过正则 `^Sandbox:\s*(.+?)\((\d+)\)\s+deny\(.*?\)\s*(.+)$` 提取进程名和被拒绝的 capability，按 PID 集合过滤后去重输出。

## 函数签名与参数说明

### `run_command_under_seatbelt(command: SeatbeltCommand, codex_linux_sandbox_exe: Option<PathBuf>) -> Result<()>`

macOS Seatbelt 沙箱入口。非 macOS 平台上直接返回错误。

> 源码位置：`codex-rs/cli/src/debug_sandbox.rs:36-63`

### `run_command_under_landlock(command: LandlockCommand, codex_linux_sandbox_exe: Option<PathBuf>) -> Result<()>`

Linux Landlock/seccomp 沙箱入口。

> 源码位置：`codex-rs/cli/src/debug_sandbox.rs:65-83`

### `run_command_under_windows(command: WindowsCommand, codex_linux_sandbox_exe: Option<PathBuf>) -> Result<()>`

Windows Restricted Token 沙箱入口。非 Windows 平台上返回错误。

> 源码位置：`codex-rs/cli/src/debug_sandbox.rs:85-103`

### `create_sandbox_mode(full_auto: bool) -> SandboxMode`

根据 `--full-auto` 标志返回对应沙箱模式：`true` → `WorkspaceWrite`（可写 cwd 和 TMPDIR），`false` → `ReadOnly`。

> 源码位置：`codex-rs/cli/src/debug_sandbox.rs:337-343`

### `spawn_debug_sandbox_child(...) -> io::Result<Child>`

构建并 spawn 子进程。清空环境变量后重新设置（`env_clear` + `envs`），设置网络禁用环境变量（当网络策略未启用时），继承 stdio，并设置 `kill_on_drop(true)` 确保父进程退出时子进程被清理。

> 源码位置：`codex-rs/cli/src/debug_sandbox.rs:345-374`

## 接口/类型定义

### CLI 命令结构体（`codex-rs/cli/src/lib.rs:9-52`）

| 结构体 | 特有字段 | 说明 |
|--------|---------|------|
| `SeatbeltCommand` | `log_denials: bool` | macOS 沙箱，支持 `--log-denials` 捕获拒绝事件 |
| `LandlockCommand` | — | Linux Landlock/seccomp 沙箱 |
| `WindowsCommand` | — | Windows Restricted Token 沙箱 |

三者共有字段：
- `full_auto: bool`（`--full-auto`）：便捷模式，禁用网络、允许写入 cwd 和 TMPDIR
- `config_overrides: CliConfigOverrides`：CLI 配置覆盖（通过 `#[clap(skip)]` 跳过 CLI 解析，由上层注入）
- `command: Vec<String>`：trailing var arg，被沙箱包裹执行的完整命令

### `SandboxType`（`debug_sandbox.rs:105-110`）

内部枚举，区分三种沙箱后端。`Seatbelt` 变体仅在 macOS 编译时存在。

### `SandboxDenial`（`seatbelt.rs:8-11`）

```rust
pub struct SandboxDenial {
    pub name: String,       // 被拒绝进程的名称
    pub capability: String, // 被拒绝的 capability（如文件访问路径）
}
```

### `PidTracker`（`pid_tracker.rs:7-28`）

macOS 专用的进程树追踪器。通过 `kqueue` + `EVFILT_PROC` 监听 fork/exec/exit 事件，使用 `proc_listchildpids` FFI 列举子进程。持有一个 `JoinHandle<HashSet<i32>>` 在后台阻塞线程中运行事件循环。

## 配置项与默认值

- **`--full-auto`**：默认 `false`。开启后沙箱模式为 `WorkspaceWrite`（可写），否则为 `ReadOnly`。与 permission profiles 配置互斥——如果配置中存在 `default_permissions`，使用 `--full-auto` 会报错。
- **`--log-denials`**：仅 `SeatbeltCommand` 支持，默认 `false`。开启后在命令退出时打印沙箱拒绝日志。
- **配置文件**：通过 `ConfigBuilder` 加载标准 Codex 配置层（global/project/local `config.toml`），支持 `CliConfigOverrides` 叠加。
- **`codex_linux_sandbox_exe`**：Landlock 后端所需的 `codex-linux-sandbox` 二进制路径，由上层传入。

## 边界 Case 与注意事项

- **平台条件编译**：Seatbelt 相关代码（`DenialLogger`、`PidTracker`、`pid_tracker` 模块）全部使用 `#[cfg(target_os = "macos")]` 守护。Windows 沙箱逻辑使用 `#[cfg(target_os = "windows")]`。在非目标平台调用对应函数会得到明确的 `bail!` 错误而非编译错误。
- **Permission Profiles 与 `--full-auto` 互斥**：当配置中使用了 `default_permissions`（新 permission profiles 语法）时，`--full-auto` 会被拒绝（`debug_sandbox.rs:407-411`），要求用户直接在 profile 中配置可写权限。
- **网络代理生命周期**：网络代理在子进程 spawn 前启动，其生命周期由 `network_proxy` 变量的 scope 控制。代理通过 `apply_to_env()` 将代理地址注入子进程环境变量。
- **PID 追踪的局限**：`PidTracker` 依赖 macOS 专有的 `kqueue EVFILT_PROC` 和 `proc_listchildpids` FFI。如果 `kqueue()` 创建失败，回退为仅包含根 PID 的集合。
- **Windows 沙箱的特殊处理**：Windows 后端不走 `spawn_debug_sandbox_child`，而是在 `spawn_blocking` 中同步执行 capture API，收集输出后直接 `process::exit`——这是为了正确模拟 stdio 继承行为。
- **环境变量清洗**：`spawn_debug_sandbox_child` 先 `env_clear()` 清空所有环境变量，再注入经过策略过滤的变量集。当网络沙箱策略禁用时，额外设置 `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR=1`。