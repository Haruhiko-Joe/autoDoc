# SandboxSetup — 平台沙箱配置与命令生成

## 概述与职责

SandboxSetup 是 Codex Core 安全执行层的核心配置模块，负责将抽象的沙箱策略（`SandboxPolicy`）转化为各平台可执行的沙箱化命令。它位于 **Core → CoreConfig** 层级下，被 SessionEngine 和 ToolsOrchestration 依赖，用于在命令实际执行前完成安全隔离的配置和启动。

该模块包含六个关键子组件：

| 子组件 | 文件 | 职责 |
|--------|------|------|
| ExecRequest 适配器 | `sandboxing/mod.rs` | 将沙箱转换后的命令适配为统一的 `ExecRequest` 执行 |
| macOS Seatbelt 沙箱 | `seatbelt.rs` | 通过 macOS sandbox-exec 启动沙箱化子进程 |
| Linux Landlock/Bubblewrap 沙箱 | `landlock.rs` | 通过 codex-linux-sandbox 辅助程序启动沙箱化子进程 |
| Windows 沙箱 | `windows_sandbox.rs` | Windows 受限令牌沙箱的级别解析、setup 流程与指标上报 |
| Windows 读权限管理 | `windows_sandbox_read_grants.rs` | 动态授予额外读取目录权限 |
| 沙箱指标标签 | `sandbox_tags.rs` | 为遥测指标生成沙箱类型标签 |
| apply-patch 安全评估 | `safety.rs` | 评估补丁操作是否可自动批准 |

## 关键流程

### 1. ExecRequest 适配流程

`ExecRequest` 是执行层的统一命令描述结构，包含命令、工作目录、环境变量、沙箱类型、过期策略等全部执行参数。核心转换入口是 `ExecRequest::from_sandbox_exec_request()`（`codex-rs/core/src/sandboxing/mod.rs:90-137`）：

1. 解构上游 `codex_sandboxing::SandboxExecRequest`，提取命令、环境变量、沙箱类型等字段
2. 当网络策略禁用时，注入环境变量 `CODEX_SANDBOX_NETWORK_DISABLED=1`
3. 在 macOS 平台上，若沙箱类型为 `MacosSeatbelt`，注入 `CODEX_SANDBOX=seatbelt` 环境变量
4. 组装为 `ExecRequest` 并传递给 `execute_exec_request` 执行

执行入口有两个：
- `execute_env()`：标准执行路径
- `execute_exec_request_with_after_spawn()`：支持 `after_spawn` 回调，在子进程启动后立即执行

### 2. macOS Seatbelt 沙箱启动

`spawn_command_under_seatbelt()`（`codex-rs/core/src/seatbelt.rs:18-48`）将用户命令包装为 `sandbox-exec` 调用：

1. 从 `SandboxPolicy` 转换为 `FileSystemSandboxPolicy` 和 `NetworkSandboxPolicy`
2. 调用 `create_seatbelt_command_args_for_policies()` 生成 seatbelt 配置参数（实际策略文本由 `codex-sandboxing` crate 生成）
3. 注入 `CODEX_SANDBOX=seatbelt` 环境变量
4. 以 `/usr/bin/sandbox-exec`（`MACOS_PATH_TO_SEATBELT_EXECUTABLE`）为程序入口，通过 `spawn_child_async` 启动子进程

### 3. Linux Landlock/Bubblewrap 沙箱启动

`spawn_command_under_linux_sandbox()`（`codex-rs/core/src/landlock.rs:25-77`）将命令委托给外部辅助程序 `codex-linux-sandbox`：

1. 与 macOS 类似，将策略转换为 `FileSystemSandboxPolicy` 和 `NetworkSandboxPolicy`
2. 调用 `create_linux_sandbox_command_args_for_policies()` 生成参数，支持 `use_legacy_landlock` 选项控制是否使用旧版 landlock
3. **argv0 处理**（`codex-rs/core/src/landlock.rs:55-65`）：如果可执行文件名已经是 `CODEX_LINUX_SANDBOX_ARG0`，保持原始路径作为 argv0；否则强制设置 argv0 为 `CODEX_LINUX_SANDBOX_ARG0`，确保 arg0 分发逻辑正确到达 Linux 沙箱入口
4. 通过 `spawn_child_async` 启动子进程

与 macOS 的关键区别：macOS 直接嵌入策略文本到命令参数，而 Linux 使用独立的辅助可执行程序，通过 JSON 参数传递策略。

### 4. Windows 沙箱级别解析与 Setup

Windows 沙箱是最复杂的部分，涉及三个级别和两种 setup 模式。

#### 级别解析

`WindowsSandboxLevel` 有三个取值：`Elevated`、`RestrictedToken`、`Disabled`。解析优先级（`codex-rs/core/src/windows_sandbox.rs:31-48`）：

1. **显式配置优先**：若 `config.permissions.windows_sandbox_mode` 有值，直接映射（`Elevated` → `Elevated`，`Unelevated` → `RestrictedToken`）
2. **Feature Flag 回退**：检查 `WindowsSandboxElevated` 和 `WindowsSandbox` 两个 feature flag
3. **默认禁用**：都未启用时返回 `Disabled`

`resolve_windows_sandbox_mode()`（`codex-rs/core/src/windows_sandbox.rs:59-76`）处理更复杂的配置合并逻辑：先检查 legacy feature flag 格式，再按 profile → 全局配置 → legacy feature 的优先级依次回退。

#### Setup 流程

`run_windows_sandbox_setup()`（`codex-rs/core/src/windows_sandbox.rs:283-308`）是 Windows 沙箱初始化的主入口：

1. 记录开始时间和 originator 标签
2. 调用 `run_windows_sandbox_setup_and_persist()` 执行实际 setup
3. 根据成功/失败发射对应的遥测指标

`run_windows_sandbox_setup_and_persist()`（`codex-rs/core/src/windows_sandbox.rs:310-359`）的核心逻辑：

1. 通过 `tokio::task::spawn_blocking` 在阻塞线程中执行 setup（因为底层涉及系统调用）
2. **Elevated 模式**：先检查 `sandbox_setup_is_complete()`，未完成时才调用 `run_elevated_setup()`，避免重复 setup
3. **Unelevated 模式**：每次都运行 `run_legacy_setup_preflight()`
4. Setup 成功后，通过 `ConfigEditsBuilder` 持久化沙箱模式到配置文件，并清理 legacy feature flag 键

#### Legacy 兼容

模块维护了对旧版 feature flag 格式的兼容（`codex-rs/core/src/windows_sandbox.rs:91-130`）：
- 检查 `WindowsSandboxElevated`、`WindowsSandbox` 和历史键名 `enable_experimental_windows_sandbox`
- 将旧格式映射到新的 `WindowsSandboxModeToml` 枚举

### 5. Windows 读权限动态授予

`grant_read_root_non_elevated()`（`codex-rs/core/src/windows_sandbox_read_grants.rs:8-36`）允许在运行时向沙箱添加额外的只读目录：

1. **验证**：路径必须是绝对路径、存在且为目录
2. **规范化**：通过 `dunce::canonicalize()` 获取规范路径（避免 Windows 上 `\\?\` 前缀问题）
3. **刷新**：调用 `run_setup_refresh_with_extra_read_roots()` 重新配置沙箱以包含新的读取根
4. 返回规范化后的路径

### 6. 沙箱指标标签生成

`sandbox_tag()`（`codex-rs/core/src/sandbox_tags.rs:6-24`）为遥测系统生成沙箱类型标签字符串：

| 条件 | 返回标签 |
|------|----------|
| `SandboxPolicy::DangerFullAccess` | `"none"` |
| `SandboxPolicy::ExternalSandbox` | `"external"` |
| Windows Elevated 模式 | `"windows_elevated"` |
| 有平台沙箱可用 | 平台沙箱的 `as_metric_tag()` 值 |
| 无可用沙箱 | `"none"` |

### 7. apply-patch 安全评估

`assess_patch_safety()`（`codex-rs/core/src/safety.rs:27-106`）是补丁操作（文件写入、删除、移动）的安全网关，决定操作应被自动批准、交由用户确认还是直接拒绝：

```
assess_patch_safety()
  |-- 空补丁 → Reject
  |-- policy = UnlessTrusted → AskUser
  |-- 补丁路径全在可写范围内 OR policy = OnFailure
  |   |-- DangerFullAccess/ExternalSandbox → AutoApprove (无沙箱)
  |   |-- 有平台沙箱可用 → AutoApprove (使用沙箱)
  |   +-- 无沙箱且 rejects_sandbox_approval → Reject, 否则 → AskUser
  +-- 路径超出可写范围
      |-- rejects_sandbox_approval → Reject
      +-- 否则 → AskUser
```

路径约束检查由内部函数 `is_write_patch_constrained_to_writable_paths()`（`codex-rs/core/src/safety.rs:108-163`）执行：
- 对补丁中每个文件变更（Add、Delete、Update）逐一检查
- 将相对路径解析为绝对路径并归一化（处理 `.` 和 `..`）
- 通过 `FileSystemSandboxPolicy::can_write_path_with_cwd()` 判断是否在可写根内
- 注意：即使路径检查通过，文档注释警告硬链接可能绕过路径限制，因此仍建议在沙箱中执行

## 函数签名

### `ExecRequest::from_sandbox_exec_request(request: SandboxExecRequest, options: ExecOptions) -> Self`

将 `codex-sandboxing` crate 输出的 `SandboxExecRequest` 转换为 Core 层的 `ExecRequest`，注入网络和沙箱环境变量。

> 源码位置：`codex-rs/core/src/sandboxing/mod.rs:90-137`

### `execute_env(exec_request: ExecRequest, stdout_stream: Option<StdoutStream>) -> Result<ExecToolCallOutput>`

标准执行入口，将 `ExecRequest` 交给底层 `execute_exec_request` 执行。

> 源码位置：`codex-rs/core/src/sandboxing/mod.rs:140-145`

### `spawn_command_under_seatbelt(...) -> std::io::Result<Child>`

在 macOS seatbelt 沙箱中启动命令。仅在 `target_os = "macos"` 时可用。

> 源码位置：`codex-rs/core/src/seatbelt.rs:18-48`

### `spawn_command_under_linux_sandbox(codex_linux_sandbox_exe, command, ...) -> std::io::Result<Child>`

在 Linux landlock/bubblewrap 沙箱中启动命令，通过外部辅助程序 `codex-linux-sandbox` 执行。

> 源码位置：`codex-rs/core/src/landlock.rs:25-77`

### `WindowsSandboxLevel::from_config(config: &Config) -> WindowsSandboxLevel`

从 Config 解析 Windows 沙箱级别，按显式配置 → feature flag → 默认禁用的优先级。

> 源码位置：`codex-rs/core/src/windows_sandbox.rs:31-48`

### `run_windows_sandbox_setup(request: WindowsSandboxSetupRequest) -> anyhow::Result<()>`

异步执行 Windows 沙箱初始化（Elevated 或 Unelevated 模式），完成后持久化配置并上报指标。

> 源码位置：`codex-rs/core/src/windows_sandbox.rs:283-308`

### `grant_read_root_non_elevated(policy, ..., read_root) -> Result<PathBuf>`

在非提权模式下动态添加只读目录到 Windows 沙箱，返回规范化后的路径。

> 源码位置：`codex-rs/core/src/windows_sandbox_read_grants.rs:8-36`

### `sandbox_tag(policy: &SandboxPolicy, windows_sandbox_level: WindowsSandboxLevel) -> &'static str`

返回当前沙箱配置对应的遥测指标标签字符串。

> 源码位置：`codex-rs/core/src/sandbox_tags.rs:6-24`

### `assess_patch_safety(action, policy, sandbox_policy, ...) -> SafetyCheck`

评估 apply-patch 操作的安全性，返回 `AutoApprove`、`AskUser` 或 `Reject`。

> 源码位置：`codex-rs/core/src/safety.rs:27-106`

## 类型定义

### `ExecRequest`

执行层的统一命令描述结构体，包含命令执行的所有参数：

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | `Vec<String>` | 要执行的命令及参数 |
| `cwd` | `PathBuf` | 工作目录 |
| `env` | `HashMap<String, String>` | 环境变量 |
| `network` | `Option<NetworkProxy>` | 网络代理（用于受管网络） |
| `sandbox` | `SandboxType` | 沙箱类型标识 |
| `sandbox_policy` | `SandboxPolicy` | 原始沙箱策略 |
| `file_system_sandbox_policy` | `FileSystemSandboxPolicy` | 文件系统沙箱策略 |
| `network_sandbox_policy` | `NetworkSandboxPolicy` | 网络沙箱策略 |
| `windows_sandbox_level` | `WindowsSandboxLevel` | Windows 沙箱级别 |
| `expiration` | `ExecExpiration` | 执行超时策略 |
| `capture_policy` | `ExecCapturePolicy` | 输出捕获策略 |
| `arg0` | `Option<String>` | 可选的 argv[0] 覆盖 |

> 源码位置：`codex-rs/core/src/sandboxing/mod.rs:37-53`

### `SafetyCheck`

补丁安全评估结果枚举：

- `AutoApprove { sandbox_type, user_explicitly_approved }` — 可自动批准，附带使用的沙箱类型
- `AskUser` — 需要用户确认
- `Reject { reason }` — 直接拒绝，附带原因

> 源码位置：`codex-rs/core/src/safety.rs:16-25`

### `WindowsSandboxSetupMode`

Windows 沙箱 setup 模式：`Elevated`（提权安装）或 `Unelevated`（非提权/legacy）。

> 源码位置：`codex-rs/core/src/windows_sandbox.rs:266-270`

### `WindowsSandboxSetupRequest`

Windows 沙箱 setup 请求参数，包含 mode、policy、cwd、env_map、codex_home 和 active_profile。

> 源码位置：`codex-rs/core/src/windows_sandbox.rs:272-281`

## 配置项与默认值

- **`windows_sandbox_mode`**（配置文件 `permissions` 段或 `[windows]` 段）：`Elevated` | `Unelevated`，未设置时回退到 feature flag
- **`windows.sandbox_private_desktop`**（配置文件）：是否使用 private desktop 隔离，默认 `true`（`codex-rs/core/src/windows_sandbox.rs:78-89`）
- **Feature Flag `WindowsSandboxElevated`**：启用提权沙箱
- **Feature Flag `WindowsSandbox`**：启用受限令牌沙箱
- **Legacy Key `enable_experimental_windows_sandbox`**：历史兼容键，等同于 `WindowsSandbox`
- **`ELEVATED_SANDBOX_NUX_ENABLED`**：编译时常量，控制提权沙箱新用户引导是否启用，当前为 `true`（`codex-rs/core/src/windows_sandbox.rs:23`）

## 边界 Case 与注意事项

- **硬链接绕过风险**：`assess_patch_safety` 的路径检查无法防御硬链接——即使补丁目标路径在可写根内，实际文件可能是指向根外文件的硬链接。因此即使路径检查通过，仍需在沙箱中执行 `apply_patch`（`codex-rs/core/src/safety.rs:61-63`）

- **空补丁直接拒绝**：`assess_patch_safety` 对空的 `ApplyPatchAction` 返回 `Reject`，不会进入任何审批流程

- **Linux argv0 分发**：Linux 沙箱依赖 argv0 来路由到正确的入口点，如果辅助程序的文件名不匹配 `CODEX_LINUX_SANDBOX_ARG0`，会强制覆盖 argv0

- **Windows setup 幂等性**：Elevated 模式下 `sandbox_setup_is_complete()` 提供幂等保护，已完成则跳过；Unelevated 模式每次都执行 preflight

- **非 Windows 平台 stub**：所有 Windows 特定函数在非 Windows 平台都有 stub 实现（返回 `false`、`None` 或 `bail!`），确保跨平台编译不报错

- **`dunce::canonicalize`**：Windows 读权限管理中使用 `dunce` 库而非标准库的 `canonicalize`，避免生成 `\\?\` 前缀的 UNC 路径

- **遥测指标**：Windows sandbox setup 上报以下指标：
  - `codex.windows_sandbox.setup_duration_ms`（带 result/originator/mode 标签）
  - `codex.windows_sandbox.setup_success` / `setup_failure`
  - Elevated 失败时额外上报 `elevated_setup_failure` 或 `elevated_setup_canceled`（带错误码和消息）