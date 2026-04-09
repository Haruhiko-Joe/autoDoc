# ElevatedSetupHelper

## 概述与职责

ElevatedSetupHelper 是 Windows 沙箱系统中以提升权限（elevated）运行的设置辅助二进制程序入口点。它位于 `Sandbox → WindowsSandbox → SetupOrchestration` 层级下，负责在沙箱执行前完成文件系统 ACL（访问控制列表）的配置，确保沙箱用户拥有恰当的读写权限，同时保护敏感目录不被篡改。

同级模块包括 SandboxCapture（沙箱主入口）、SecurityPrimitives（安全原语）、PolicyAndEnvironment（策略解析）、ProcessSpawning（进程创建）、ElevatedBackend（提升权限后端）、Utilities（工具函数）等。本模块是 SetupOrchestration 的核心执行体——由父进程以 elevated 权限启动，接收 base64 编码的 JSON payload，完成用户创建、防火墙配置、ACL 应用等一系列操作。

## 关键流程

### 1. 二进制入口与 Payload 解码

程序入口定义在 `codex-rs/windows-sandbox-rs/src/bin/setup_main.rs`，是一个极简的 `main()` 分发器——Windows 上调用 `win::main()`，非 Windows 平台直接 panic。

`win::main()`（`setup_main_win.rs:345-364`）包裹了 `real_main()`，在顶层捕获所有错误并尝试写入日志文件。

`real_main()`（`setup_main_win.rs:366-439`）执行以下步骤：

1. 从命令行参数获取单个 base64 字符串
2. 用 `BASE64.decode()` 解码为 JSON 字节
3. 反序列化为 `Payload` 结构体
4. 校验 `payload.version` 与 `SETUP_VERSION` 常量一致
5. 创建沙箱目录并打开追加模式的日志文件
6. 调用 `run_setup()` 分发到具体模式
7. 失败时提取 `SetupFailure` 结构化错误，写入错误报告文件

### 2. 模式分发

`run_setup()`（`setup_main_win.rs:441-446`）根据 `payload.mode` 字段分发：

- **`SetupMode::Full`** → `run_setup_full()`：完整初始化流程
- **`SetupMode::ReadAclsOnly`** → `run_read_acl_only()`：仅刷新读 ACL

### 3. 完整设置流程（Full Mode）

`run_setup_full()`（`setup_main_win.rs:507-902`）是核心逻辑，按顺序执行：

**阶段一：用户预配置**（非 refresh 模式）
- 调用 `provision_sandbox_users()` 创建 offline/online 沙箱用户账户
- 调用 `hide_newly_created_users()` 隐藏新创建的用户（不在登录屏幕显示）

**阶段二：SID 解析**
- 解析 offline 用户的 SID
- 解析沙箱用户组 SID（`resolve_sandbox_users_group_sid()`）
- 加载或创建 capability SID（`load_or_create_cap_sids()`）——用于细粒度的写权限控制
- 解析工作区专属 capability SID（`workspace_cap_sid_for_cwd()`）

**阶段三：防火墙配置**（非 refresh 模式）
- `firewall::ensure_offline_proxy_allowlist()`：允许离线用户访问指定代理端口
- `firewall::ensure_offline_outbound_block()`：阻止离线用户的其他出站流量

**阶段四：读 ACL 应用**
- 检查读 ACL mutex 是否已被占用，避免重复执行
- 通过 `spawn_read_acl_helper()` 派生独立的后台进程，以 `ReadAclsOnly` 模式异步处理读 ACL

**阶段五：写 ACL 应用（多线程）**
- 遍历 `write_roots`，去重后检查每个路径是否已具备所需写权限
- 对于需要授权的路径，收集到 `grant_tasks` 列表
- 使用 `std::thread::scope()` 创建作用域线程池（`setup_main_win.rs:712-760`），每个线程独立：
  - 将 SID 字符串转换为 PSID
  - 调用 `ensure_allow_write_aces()` 设置写 ACE
  - 通过 `mpsc::channel` 回传结果
- 写权限掩码为 `FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD`
- 区分命令 CWD 目录（使用 workspace capability SID）和其他目录（使用通用 capability SID）

**阶段六：沙箱目录锁定**
- `lock_sandbox_dir()` 锁定 sandbox-bin 目录：沙箱组获得读/执行权限，真实用户获得完整权限
- 锁定 sandbox 主目录：沙箱组获得完整读写权限，真实用户获得读写执行权限
- 锁定 secrets 目录：沙箱组被**显式拒绝**（`DENY_ACCESS`）所有权限——这是唯一使用拒绝 ACE 的地方
- 清理遗留的 `sandbox_users.json` 文件

**阶段七：工作区目录保护**
- `protect_workspace_codex_dir()`：对 `.codex` 目录应用 deny ACE，防止沙箱进程篡改
- `protect_workspace_agents_dir()`：对 `.agents` 目录应用 deny ACE
- 使用工作区专属 capability SID，确保拒绝精确匹配到当前工作区

### 4. 读 ACL 专用模式（ReadAclsOnly）

`run_read_acl_only()`（`setup_main_win.rs:448-505`）：

1. 通过 `acquire_read_acl_mutex()` 获取系统级互斥锁，若已有实例运行则直接退出
2. 解析三个内置组的 SID：`Users`、`Authenticated Users`、`Everyone`
3. 对每个读根路径调用 `apply_read_acls()`：
   - 先检查内置组是否已有读权限（避免重复授权）
   - 再检查沙箱用户组是否已有读权限
   - 都没有时，通过 `ensure_allow_mask_aces_with_inheritance()` 为沙箱组添加读+执行 ACE（带继承标志）

### 5. 后台读 ACL Helper 进程

`spawn_read_acl_helper()`（`setup_main_win.rs:117-133`）：

- 克隆当前 payload，将 `mode` 改为 `ReadAclsOnly`，`refresh_only` 设为 `true`
- 重新序列化为 base64
- 以当前可执行文件路径启动新进程，使用 `CREATE_NO_WINDOW` (0x08000000) 标志在后台运行
- stdin/stdout/stderr 均重定向到 null

## 函数签名与参数说明

### `main() -> Result<()>`

公开入口，包裹 `real_main()` 并在失败时做最后的日志记录。

> 源码位置：`setup_main_win.rs:345-364`

### `real_main() -> Result<()>`

解码 payload、校验版本、分发到具体设置模式。所有错误都被包装为 `SetupFailure` 并写入错误报告。

> 源码位置：`setup_main_win.rs:366-439`

### `run_setup(payload, log, sbx_dir) -> Result<()>`

根据 `payload.mode` 分发到 `run_setup_full()` 或 `run_read_acl_only()`。

> 源码位置：`setup_main_win.rs:441-446`

### `apply_read_acls(read_roots, subjects, log, refresh_errors, access_mask, access_label, inheritance) -> Result<()>`

对一组路径应用读 ACL。先检查 `Users`/`Authenticated Users`/`Everyone` 是否已有足够权限（跳过），再检查沙箱组，最后才实际添加 ACE。

- **read_roots**：需要授予读权限的路径列表
- **subjects**：`ReadAclSubjects` 结构，包含沙箱组 PSID 和内置组 PSID 列表
- **access_mask**：要授予的权限掩码（通常为 `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE`）
- **inheritance**：ACE 继承标志

> 源码位置：`setup_main_win.rs:140-211`

### `lock_sandbox_dir(dir, real_user, sandbox_group_sid, sandbox_group_access_mode, sandbox_group_mask, real_user_mask, log) -> Result<()>`

用显式 DACL 锁定指定目录。创建全新的 ACL（不基于已有 ACL），包含四个条目：沙箱组、SYSTEM、Administrators、真实用户。

- **sandbox_group_access_mode**：`GRANT_ACCESS` 或 `DENY_ACCESS`（secrets 目录用拒绝）
- **sandbox_group_mask / real_user_mask**：各主体的权限掩码

> 源码位置：`setup_main_win.rs:248-343`

### `spawn_read_acl_helper(payload, log) -> Result<()>`

派生后台读 ACL Helper 进程。

> 源码位置：`setup_main_win.rs:117-133`

### `log_line(log, msg) -> Result<()>`

写入带 RFC3339 时间戳的日志行。

> 源码位置：`setup_main_win.rs:106-115`

## 接口/类型定义

### `Payload`

setup helper 的输入数据结构，由父进程序列化为 JSON 后 base64 编码传入：

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | `u32` | 协议版本号，必须匹配 `SETUP_VERSION` |
| `offline_username` | `String` | 离线沙箱用户名 |
| `online_username` | `String` | 在线沙箱用户名 |
| `codex_home` | `PathBuf` | Codex 主目录路径 |
| `command_cwd` | `PathBuf` | 命令执行的工作目录 |
| `read_roots` | `Vec<PathBuf>` | 需要授予读权限的文件系统根路径 |
| `write_roots` | `Vec<PathBuf>` | 需要授予写权限的文件系统根路径 |
| `proxy_ports` | `Vec<u16>` | 代理端口列表（默认为空） |
| `allow_local_binding` | `bool` | 是否允许本地端口绑定（默认 false） |
| `real_user` | `String` | 发起设置的真实用户名 |
| `mode` | `SetupMode` | 执行模式（默认 Full） |
| `refresh_only` | `bool` | 是否仅刷新（跳过用户创建等，默认 false） |

> 源码位置：`setup_main_win.rs:78-96`

### `SetupMode`

```rust
enum SetupMode {
    Full,         // 完整设置
    ReadAclsOnly, // 仅读 ACL
}
```

> 源码位置：`setup_main_win.rs:98-104`

### `ReadAclSubjects`

读 ACL 操作的主体集合，包含沙箱组 PSID 和一组内置 SID（Users、Authenticated Users、Everyone）的 PSID。

> 源码位置：`setup_main_win.rs:135-138`

## 配置项与默认值

- **`SETUP_VERSION`**：从 `codex_windows_sandbox` crate 导入的版本常量，payload 版本必须精确匹配
- **`LOG_FILE_NAME`**：日志文件名常量，日志写入 `{codex_home}/sandbox/{LOG_FILE_NAME}`
- **`CODEX_HOME` 环境变量**：仅在顶层错误处理中作为后备路径使用
- **`DENY_ACCESS`**（值 3）：本地定义的常量，对应 Windows ACE 的拒绝访问模式
- **`CREATE_NO_WINDOW`**（0x08000000）：后台进程创建标志，避免弹出控制台窗口

## 边界 Case 与注意事项

- **版本不匹配即刻失败**：`payload.version != SETUP_VERSION` 会立即返回错误，不会执行任何设置操作
- **读根缺失时静默跳过**：`read_roots` 和 `write_roots` 中不存在的路径会被记录日志后跳过，不会导致失败
- **读 ACL 互斥**：通过系统级 mutex 保证同一时刻只有一个读 ACL helper 在运行。Full 模式中在派生之前先检查 mutex 是否存在；ReadAclsOnly 模式中直接尝试获取
- **内置组优先级检查**：在授予沙箱组读权限前，先检查 Users/Authenticated Users/Everyone 是否已有足够权限——如果是，则跳过避免冗余 ACE
- **写 ACL 去重**：使用 `HashSet<PathBuf>` 确保相同的写根路径不会被重复处理
- **CWD 与非 CWD 路径使用不同 capability SID**：命令工作目录使用工作区专属 SID，其他写根使用通用 capability SID
- **secrets 目录使用 DENY ACE**：`sandbox_secrets_dir` 是唯一对沙箱组使用显式拒绝 ACE 的目录，确保沙箱进程无法读取凭据
- **lock_sandbox_dir 创建全新 DACL**：不基于已有 ACL 构建（`SetEntriesInAclW` 的旧 ACL 参数为 null），意味着替换而非追加
- **错误收集不中断**：大部分 ACL 操作错误被收集到 `refresh_errors` 中而非立即失败，但在 `refresh_only` 模式下，如果存在任何错误，最终会返回失败
- **PSID 内存管理**：所有通过 `ConvertStringSidToSidW` 分配的 PSID 都需要手动 `LocalFree` 释放，代码在各函数末尾统一释放