# 沙箱用户配置（UserProvisioning）

## 概述与职责

UserProvisioning 模块负责 Windows 沙箱中**专用用户账户的完整生命周期管理**——从创建本地用户组和用户账户，到生成并加密存储凭据，再到将沙箱账户从 Windows 登录界面中隐藏。

在整体架构中，本模块隶属于 `Sandbox → WindowsSandbox → SetupOrchestration`，是多阶段 elevated 安装流程的核心步骤之一。SetupOrchestration 在系统首次准备沙箱环境时调用本模块，为后续的 ElevatedBackend（以沙箱用户身份执行命令）提供所需的账户和凭据基础设施。同级模块还包括防火墙规则配置、ACL 应用、helper 二进制文件部署等。

本模块由两个源文件组成：
- `sandbox_users.rs`：用户/组创建、SID 解析、密码生成、凭据持久化
- `hide_users.rs`：从登录界面和文件管理器中隐藏沙箱账户

## 关键流程

### 用户配置主流程

入口函数 `provision_sandbox_users()` 编排整个配置流程（`sandbox_users.rs:62-89`）：

1. **创建本地组** — 调用 `ensure_sandbox_users_group()` 创建名为 `CodexSandboxUsers` 的本地组（若已存在则跳过）
2. **生成随机密码** — 为 offline 和 online 两个用户分别调用 `random_password()` 生成 24 字符密码
3. **创建或更新用户** — 对每个用户调用 `ensure_sandbox_user()`：
   - 尝试 `NetUserAdd` 创建账户（设置 `UF_SCRIPT | UF_DONT_EXPIRE_PASSWD` 标志）
   - 如果用户已存在（创建失败），则通过 `NetUserSetInfo` level 1003 更新密码
   - 将用户加入本地 `Users` 组（通过 SID `S-1-5-32-545` 反查组名实现）
   - 将用户加入 `CodexSandboxUsers` 组
4. **加密并持久化凭据** — 调用 `write_secrets()` 完成凭据存储

### 凭据持久化流程

`write_secrets()` 函数（`sandbox_users.rs:401-496`）负责将凭据安全写入磁盘：

1. 创建 `sandbox_dir` 和 `secrets_dir` 目录
2. 使用 **DPAPI**（`dpapi_protect`）分别加密 offline 和 online 密码
3. 将加密后的密码 blob 进行 **Base64 编码**
4. 构造 `SandboxUsersFile` 结构并序列化为 `sandbox_users.json`，写入 secrets 目录
5. 构造 `SetupMarker` 结构（包含版本号、用户名、时间戳、代理端口等）并序列化为 `setup_marker.json`，写入 sandbox 目录

### SID 解析流程

`resolve_sid()` 函数（`sandbox_users.rs:213-249`）采用两级策略解析账户名到 SID：

1. **快速路径** — 检查 `well_known_sid_str()` 中的硬编码映射表，覆盖 5 个常见 SID（Administrators、Users、Authenticated Users、Everyone、SYSTEM）
2. **通用路径** — 调用 Win32 `LookupAccountNameW` API，以循环方式处理 `ERROR_INSUFFICIENT_BUFFER` 的缓冲区扩展

### 账户隐藏流程

`hide_newly_created_users()` 函数（`hide_users.rs:28-38`）在账户创建后隐藏沙箱用户：

1. **Winlogon 注册表隐藏** — 在 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList` 下为每个用户创建值为 `0` 的 `REG_DWORD` 条目（`hide_users.rs:78-107`），使账户不在登录界面显示
2. **用户配置文件目录隐藏** — `hide_current_user_profile_dir()`（`hide_users.rs:45-76`）在沙箱用户首次登录后，对其 `%USERPROFILE%` 目录设置 `FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM` 属性，使其在文件资源管理器中不可见

## 函数签名与参数说明

### 公开 API

#### `provision_sandbox_users(codex_home, offline_username, online_username, proxy_ports, allow_local_binding, log) -> Result<()>`

主入口函数，编排完整的用户配置流程。

| 参数 | 类型 | 说明 |
|------|------|------|
| `codex_home` | `&Path` | Codex 主目录，用于确定凭据文件的存储位置 |
| `offline_username` | `&str` | 离线（无网络）沙箱用户的账户名 |
| `online_username` | `&str` | 在线（有网络）沙箱用户的账户名 |
| `proxy_ports` | `&[u16]` | 需要记录到 setup marker 的代理端口列表 |
| `allow_local_binding` | `bool` | 是否允许本地绑定，记录到 setup marker |
| `log` | `&mut File` | 日志文件句柄 |

> 源码位置：`sandbox_users.rs:62-89`

#### `ensure_sandbox_user(username, password, log) -> Result<()>`

确保单个沙箱用户存在并加入 `CodexSandboxUsers` 组。

> 源码位置：`sandbox_users.rs:91-95`

#### `resolve_sid(name: &str) -> Result<Vec<u8>>`

将账户名解析为 SID 字节数组。对已知 SID 走快速路径，其余调用 `LookupAccountNameW`。

> 源码位置：`sandbox_users.rs:213-249`

#### `resolve_sandbox_users_group_sid() -> Result<Vec<u8>>`

解析 `CodexSandboxUsers` 组的 SID。

> 源码位置：`sandbox_users.rs:58-60`

#### `sid_bytes_to_psid(sid: &[u8]) -> Result<*mut c_void>`

将 SID 字节数组转换为 Win32 API 可用的 PSID 指针。

> 源码位置：`sandbox_users.rs:349-360`

#### `hide_newly_created_users(usernames: &[String], log_base: &Path)`

通过 Winlogon 注册表键将指定用户名列表从登录界面隐藏。

> 源码位置：`hide_users.rs:28-38`

#### `hide_current_user_profile_dir(log_base: &Path)`

隐藏当前沙箱用户的 `%USERPROFILE%` 目录（设置 HIDDEN|SYSTEM 属性）。设计为在 command-runner 中以沙箱用户身份运行，因为 Windows 在用户首次登录时才创建其配置文件目录。

> 源码位置：`hide_users.rs:45-76`

## 接口/类型定义

### `SandboxUsersFile`（序列化结构）

写入 `sandbox_users.json` 的顶层结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `u32` | 对应 `SETUP_VERSION` 常量，用于版本兼容性检查 |
| `offline` | `SandboxUserRecord` | 离线用户的凭据 |
| `online` | `SandboxUserRecord` | 在线用户的凭据 |

> 源码位置：`sandbox_users.rs:382-387`

### `SandboxUserRecord`（序列化结构）

| 字段 | 类型 | 说明 |
|------|------|------|
| `username` | `String` | 用户名 |
| `password` | `String` | DPAPI 加密后 Base64 编码的密码 |

> 源码位置：`sandbox_users.rs:376-380`

### `SetupMarker`（序列化结构）

写入 `setup_marker.json`，记录安装状态：

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `u32` | 安装版本号 |
| `offline_username` / `online_username` | `String` | 用户名 |
| `created_at` | `String` | RFC 3339 格式的 UTC 时间戳 |
| `proxy_ports` | `Vec<u16>` | 代理端口列表 |
| `allow_local_binding` | `bool` | 本地绑定许可标志 |
| `read_roots` / `write_roots` | `Vec<PathBuf>` | 初始化为空，后续由 SetupOrchestration 填充 |

> 源码位置：`sandbox_users.rs:389-398`

## 配置项与常量

| 常量 | 值 | 说明 |
|------|------|------|
| `SANDBOX_USERS_GROUP` | `"CodexSandboxUsers"` | 沙箱用户组名 |
| `SID_ADMINISTRATORS` | `S-1-5-32-544` | 内置管理员组 SID |
| `SID_USERS` | `S-1-5-32-545` | 内置 Users 组 SID |
| `SID_AUTHENTICATED_USERS` | `S-1-5-11` | 已认证用户 SID |
| `SID_EVERYONE` | `S-1-1-0` | Everyone SID |
| `SID_SYSTEM` | `S-1-5-18` | SYSTEM 账户 SID |
| `USERLIST_KEY_PATH` | `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList` | 控制登录界面用户可见性的注册表路径 |

密码字符集包含大小写字母、数字和特殊字符 `!@#$%^&*()-_=+`，共 76 个字符（`sandbox_users.rs:363-364`）。

## 边界 Case 与注意事项

- **幂等设计**：`ensure_local_user` 在 `NetUserAdd` 失败（用户已存在）时自动回退到 `NetUserSetInfo` 更新密码；`ensure_local_group` 对 `ERROR_ALIAS_EXISTS` 和 `NERR_GROUP_EXISTS` 静默成功；`ensure_local_group_member` 忽略重复添加的错误
- **密码不持久明文**：明文密码仅在内存中短暂存在，写入磁盘前必经 DPAPI 加密 + Base64 编码
- **Users 组反查**：将用户加入本地 Users 组时，通过 `LookupAccountSidW` 反查 `S-1-5-32-545` 的本地化组名（非英文系统组名不同），而非硬编码 "Users" 字符串
- **best-effort 隐藏**：`hide_newly_created_users` 和 `hide_current_user_profile_dir` 均为 best-effort 操作——失败时记录日志但不阻断流程
- **配置文件目录延迟隐藏**：Windows 在用户首次登录时才创建 `%USERPROFILE%` 目录，因此 `hide_current_user_profile_dir` 设计在 command-runner 中运行（此时沙箱用户已登录），而非在 setup 阶段
- **SID 解析缓冲区扩展**：`resolve_sid` 初始分配 68 字节的 SID 缓冲区，如果 `LookupAccountNameW` 返回 `ERROR_INSUFFICIENT_BUFFER`，则按系统要求的大小重新分配并重试
- **仅 Windows 平台**：两个文件均以 `#![cfg(target_os = "windows")]` 编译门控，非 Windows 平台不编译