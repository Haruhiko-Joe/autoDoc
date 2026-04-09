# Setup Orchestrator

## 概述与职责

`setup_orchestrator` 是 Windows 沙箱的 **CLI 侧编排模块**，运行在非提权的父进程中。它属于 `Sandbox > WindowsSandbox > SetupOrchestration` 层级，与同级的 `SecurityPrimitives`（安全原语）、`PolicyAndEnvironment`（策略解析）、`ElevatedBackend`（提权执行后端）等模块协作，共同完成 Windows 沙箱的初始化与运行时维护。

该模块的核心职责包括：

1. **检测当前进程的提权状态**（是否以管理员运行）
2. **收集读/写根路径**，并过滤敏感目录和用户配置文件中的凭据目录
3. **构造 `ElevationPayload`** 并进行 base64 编码，传递给 setup helper
4. **启动 setup helper**——需要 UAC 时通过 `ShellExecuteExW("runas")` 提权启动，否则直接 spawn
5. **执行 setup refresh**——在不重新提权的情况下更新 ACL
6. **从环境变量计算离线代理设置**
7. **管理 `SetupMarker` 的版本匹配与不匹配检测**

## 关键常量与路径约定

| 常量/函数 | 值/作用 |
|-----------|---------|
| `SETUP_VERSION` | `5`，setup marker 的当前版本号 |
| `OFFLINE_USERNAME` | `"CodexSandboxOffline"`，离线沙箱用户名 |
| `ONLINE_USERNAME` | `"CodexSandboxOnline"`，在线沙箱用户名 |
| `sandbox_dir()` | `{codex_home}/.sandbox`，沙箱状态目录 |
| `sandbox_bin_dir()` | `{codex_home}/.sandbox-bin`，helper 二进制目录 |
| `sandbox_secrets_dir()` | `{codex_home}/.sandbox-secrets`，凭据存储目录 |
| `setup_marker_path()` | `{codex_home}/.sandbox/setup_marker.json` |
| `sandbox_users_path()` | `{codex_home}/.sandbox-secrets/sandbox_users.json` |

> 源码位置：`setup_orchestrator.rs:37-80`

## 关键流程

### 1. 完整 Setup 流程 (`run_elevated_setup`)

这是首次设置或版本升级时调用的主入口。

1. 创建 `{codex_home}/.sandbox` 目录（`setup_orchestrator.rs:719-725`）
2. 调用 `build_payload_roots()` 收集读/写根路径
3. 根据策略和 `proxy_enforced` 标志确定 `SandboxNetworkIdentity`（Offline 或 Online）
4. 调用 `offline_proxy_settings_from_env()` 从环境变量解析代理端口
5. 组装 `ElevationPayload`（`refresh_only: false`）
6. 调用 `is_elevated()` 检测当前是否已提权
7. 调用 `run_setup_exe()` 启动 helper——
   - **已提权**：直接 `Command::new()` spawn，设置 `CREATE_NO_WINDOW` 标志
   - **未提权**：通过 `ShellExecuteExW` 以 `"runas"` verb 触发 UAC 提示，然后 `WaitForSingleObject` 等待完成

> 源码位置：`setup_orchestrator.rs:714-750`

### 2. Refresh 流程 (`run_setup_refresh` / `run_setup_refresh_inner`)

当沙箱已完成初始设置、只需更新 ACL（如工作目录变更）时使用此路径。

1. 跳过 `DangerFullAccess` 和 `ExternalSandbox` 策略（`setup_orchestrator.rs:150-155`）
2. 构建 `ElevationPayload`（`refresh_only: true`）
3. **不触发 UAC**——直接 `Command::new()` spawn setup helper
4. 检查退出状态，失败时记录日志

> 源码位置：`setup_orchestrator.rs:97-207`

`run_setup_refresh_with_extra_read_roots()` 变体允许追加额外的读根路径（`setup_orchestrator.rs:118-143`）。

### 3. 读根路径收集

根据策略的 `has_full_disk_read_access()` 返回值分为两条路径：

**完整读取模式** (`gather_legacy_full_read_roots`，`setup_orchestrator.rs:346-367`)：
- helper 二进制目录（当前 exe 所在目录 + `sandbox-bin`）
- Windows 平台默认路径：`C:\Windows`、`C:\Program Files`、`C:\Program Files (x86)`、`C:\ProgramData`
- 用户配置目录（USERPROFILE）的子目录——**排除敏感目录**
- 命令工作目录 + 可写根路径

**受限读取模式** (`gather_restricted_read_roots`，`setup_orchestrator.rs:369-389`)：
- helper 二进制目录
- 仅当策略 `include_platform_defaults()` 时才添加平台默认路径
- 策略声明的可读根路径

两种模式最终都通过 `canonical_existing()` 过滤掉不存在的路径并规范化。

**用户配置目录过滤** (`profile_read_roots`，`setup_orchestrator.rs:314-331`)：
遍历 `USERPROFILE` 目录，排除以下敏感子目录（大小写不敏感匹配）：

```
.ssh, .gnupg, .aws, .azure, .kube, .docker, .config, .npm, .pki, .terraform.d
```

> 源码位置：`setup_orchestrator.rs:43-54`

### 4. 写根路径收集与敏感目录过滤

`gather_write_roots()`（`setup_orchestrator.rs:403-425`）：
- `WorkspaceWrite` 策略自动包含 command CWD
- 通过 `compute_allow_paths()` 获取策略允许的路径
- 去重并规范化

`filter_sensitive_write_roots()`（`setup_orchestrator.rs:777-800`）防止对以下位置授予写权限：
- `CODEX_HOME` 本身
- `.sandbox`、`.sandbox-bin`、`.sandbox-secrets` 及其子目录

这确保沙箱控制状态和 helper 二进制不会被沙箱进程篡改。

### 5. 提权检测 (`is_elevated`)

通过 Win32 API 检查当前进程是否以管理员身份运行（`setup_orchestrator.rs:270-300`）：

1. `AllocateAndInitializeSid` 创建 `BUILTIN\Administrators` 组的 SID
2. `CheckTokenMembership` 检查当前进程 token 是否包含该 SID
3. `FreeSid` 释放资源

### 6. 离线代理设置计算

`offline_proxy_settings_from_env()`（`setup_orchestrator.rs:485-501`）检查环境变量中的代理配置：

- 扫描的环境变量：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`WS_PROXY`、`WSS_PROXY`（及小写变体）
- 仅提取**本地回环地址**（`localhost`、`127.0.0.1`、`[::1]`）上的端口号
- `CODEX_NETWORK_ALLOW_LOCAL_BINDING` 环境变量控制是否允许本地绑定（值为 `"1"` 时启用）
- 仅在 `SandboxNetworkIdentity::Offline` 时生效

`loopback_proxy_port_from_url()`（`setup_orchestrator.rs:515-534`）负责解析 URL，支持：
- 标准格式：`http://localhost:3128`
- 带认证：`socks5h://user:pass@[::1]:1080`
- IPv6 方括号：`https://[::1]:8080`
- 拒绝非本地地址和端口 0

## 类型定义

### `SandboxSetupRequest<'a>`

完整 setup 请求的参数聚合结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `policy` | `&SandboxPolicy` | 沙箱策略 |
| `policy_cwd` | `&Path` | 策略计算时的工作目录 |
| `command_cwd` | `&Path` | 实际命令执行的工作目录 |
| `env_map` | `&HashMap<String, String>` | 环境变量映射 |
| `codex_home` | `&Path` | Codex 主目录 |
| `proxy_enforced` | `bool` | 是否强制使用代理 |

> 源码位置：`setup_orchestrator.rs:82-89`

### `SetupMarker`

写入 `setup_marker.json` 的版本标记，用于检测 setup 是否需要重新执行：

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `u32` | Setup 版本号 |
| `offline_username` | `String` | 离线沙箱用户名 |
| `online_username` | `String` | 在线沙箱用户名 |
| `created_at` | `Option<String>` | 创建时间（可选） |
| `proxy_ports` | `Vec<u16>` | 代理端口列表 |
| `allow_local_binding` | `bool` | 是否允许本地绑定 |

关键方法：
- `version_matches()` — 检查 marker 版本是否等于 `SETUP_VERSION`
- `request_mismatch_reason()` — 比较当前请求的离线防火墙设置与 marker 记录的设置，返回不匹配原因（仅对 Offline 身份检查）

> 源码位置：`setup_orchestrator.rs:209-248`

### `SandboxUsersFile`

存储在 `sandbox_users.json` 中的沙箱用户凭据记录：

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `u32` | 版本号 |
| `offline` | `SandboxUserRecord` | 离线用户记录 |
| `online` | `SandboxUserRecord` | 在线用户记录 |

`SandboxUserRecord` 包含 `username` 和 `password`（DPAPI 加密后 base64 编码的密码）。

> 源码位置：`setup_orchestrator.rs:250-268`

### `ElevationPayload`

序列化后 base64 编码传递给 setup helper 的载荷：

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `u32` | Setup 版本 |
| `offline_username` / `online_username` | `String` | 用户名 |
| `codex_home` | `PathBuf` | Codex 主目录 |
| `command_cwd` | `PathBuf` | 命令工作目录 |
| `read_roots` / `write_roots` | `Vec<PathBuf>` | 读/写根路径 |
| `proxy_ports` | `Vec<u16>` | 代理端口 |
| `allow_local_binding` | `bool` | 本地绑定开关 |
| `real_user` | `String` | 当前 Windows 用户名 |
| `refresh_only` | `bool` | 是否为仅刷新模式 |

> 源码位置：`setup_orchestrator.rs:427-443`

### `SandboxNetworkIdentity`

枚举，决定使用哪个沙箱用户身份：

- `Offline` — 当 `proxy_enforced` 为 true 或策略不允许完整网络访问时
- `Online` — 其他情况

> 源码位置：`setup_orchestrator.rs:451-469`

## 边界 Case 与注意事项

- **UAC 取消处理**：当用户在 UAC 对话框中点击"否"时，`ShellExecuteExW` 返回错误码 `1223`（`ERROR_CANCELLED`），模块会返回 `OrchestratorHelperLaunchCanceled` 错误（`setup_orchestrator.rs:682-684`）
- **错误报告机制**：helper 进程通过 `setup_error.json` 文件回传结构化错误。orchestrator 在启动前清除该文件，在 helper 失败后读取并解析（`setup_orchestrator.rs:584-601`）
- **`DangerFullAccess` 和 `ExternalSandbox` 策略跳过 refresh**：这两种策略不需要 ACL 管理
- **路径规范化**：所有路径通过 `dunce::canonicalize` 处理，避免 Windows 的 `\\?\` 前缀问题
- **`build_payload_roots` 去重**：写根路径集合中已包含的路径会从读根路径中移除，避免冲突的 ACL 设置（`setup_orchestrator.rs:772-773`）
- **`find_setup_exe` 回退**：优先在当前 exe 同目录查找 `codex-windows-sandbox-setup.exe`，找不到时回退到 PATH 查找（`setup_orchestrator.rs:572-582`）