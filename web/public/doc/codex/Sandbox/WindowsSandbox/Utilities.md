# Utilities — 共享 Win32 辅助函数与跨切面工具集

## 概述与职责

本模块是 `codex-windows-sandbox` crate 中的**共享工具层**，为 Windows 沙箱的各个子系统（受限令牌管理、ACL 设置、进程启动等）提供基础设施级别的辅助功能。它在整体架构中位于 **Sandbox → WindowsSandbox** 层级之下，被同级的沙箱核心模块广泛调用。

模块由以下 6 个源文件和 1 个构建脚本组成：

| 文件 | 职责 |
|------|------|
| `winutil.rs` | 宽字符串转换、SID 解析与格式化、Windows 参数引号化、Win32 错误格式化 |
| `dpapi.rs` | DPAPI 数据保护（加密/解密） |
| `logging.rs` | 结构化日志文件写入（带时间戳） |
| `read_acl_mutex.rs` | 基于文件系统的 ACL 互斥锁 |
| `sandbox_utils.rs` | Git safe.directory 注入、Codex 主目录创建等沙箱路径辅助 |
| `build.rs` | 构建脚本，嵌入 Windows 应用清单 |

## 关键流程

### SID 解析流程（`winutil.rs`）

SID（安全标识符）解析是 ACL 设置的前置步骤。`resolve_sid()` 采用**两阶段策略**：

1. 首先通过 `well_known_sid_str()` 查找内置映射表，将常见名称（如 `"Administrators"`, `"SYSTEM"`, `"Everyone"` 等 5 个）直接映射为 SID 字符串常量（`winutil.rs:156-165`）
2. 若命中，调用 `sid_bytes_from_string()` 通过 `ConvertStringSidToSidW` 将字符串形式的 SID 转换为字节数组
3. 若未命中，回退到 `LookupAccountNameW` 进行系统查询，支持自动扩充缓冲区（当返回 `ERROR_INSUFFICIENT_BUFFER` 时循环重试，`winutil.rs:130-153`）

### Windows 参数引号化（`winutil.rs`）

`quote_windows_arg()` 实现了与 `CommandLineToArgvW`/CRT 一致的引号规则（`winutil.rs:29-65`）：

- 仅在参数包含空格、制表符、换行或双引号时才添加引号
- 反斜杠在紧邻双引号时需要翻倍转义（`backslashes * 2 + 1`）
- 尾部反斜杠在闭合引号前同样翻倍（`backslashes * 2`）

### DPAPI 加密/解密流程（`dpapi.rs`）

DPAPI（Data Protection API）封装提供机器级别的数据保护：

1. `protect()` 调用 `CryptProtectData` 加密字节数组（`dpapi.rs:20-51`）
2. `unprotect()` 调用 `CryptUnprotectData` 解密（`dpapi.rs:54-85`）
3. 两者均使用 `CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN` 标志，确保：
   - **机器作用域**：提升权限和非提升权限的进程都可以解密同一份数据
   - **无 UI**：不弹出用户交互对话框
4. 输出缓冲区由 Windows 分配，使用后通过 `LocalFree` 释放

### 日志写入流程（`logging.rs`）

日志系统将结构化条目追加写入 `sandbox.log` 文件：

1. 每条日志格式为 `[2024-01-15 10:30:45.123 exe_name] MESSAGE`（`logging.rs:72-75`）
2. 可执行文件名通过 `OnceLock` 惰性初始化，整个进程生命周期只解析一次（`logging.rs:12-20`）
3. 命令预览会截断超过 200 字节的内容，使用 `take_bytes_at_char_boundary` 避免在 UTF-8 多字节字符中间截断（`logging.rs:22-29`）
4. `debug_log()` 仅在环境变量 `SBX_DEBUG=1` 时输出，同时写文件和 stderr（`logging.rs:64-69`）

### ACL 互斥锁（`read_acl_mutex.rs`）

使用 Windows 命名互斥量 `Local\CodexSandboxReadAcl` 序列化并发 ACL 修改：

1. `acquire_read_acl_mutex()` 尝试通过 `CreateMutexW` 创建互斥量并立即获取所有权（第二个参数为 `1`）（`read_acl_mutex.rs:46-62`）
2. 若互斥量已存在（`ERROR_ALREADY_EXISTS`），返回 `Ok(None)` 表示获取失败
3. 成功时返回 `ReadAclMutexGuard` RAII 守卫，`Drop` 实现中自动释放并关闭句柄（`read_acl_mutex.rs:21-28`）
4. `read_acl_mutex_exists()` 提供非获取性的存在性检查（`read_acl_mutex.rs:30-44`）

### Git safe.directory 注入（`sandbox_utils.rs`）

沙箱用户运行 git 时，仓库目录的所有者是主用户，git 默认会拒绝操作。`inject_git_safe_directory()` 解决这一问题：

1. 从工作目录向上遍历查找 `.git` 目录或 gitfile（支持 worktree 重定向）（`sandbox_utils.rs:14-41`）
2. 读取现有的 `GIT_CONFIG_COUNT` 环境变量值
3. 追加 `GIT_CONFIG_KEY_N=safe.directory` 和 `GIT_CONFIG_VALUE_N=<repo_path>` 到环境变量映射中（`sandbox_utils.rs:52-67`）

## 函数签名与参数说明

### `winutil.rs` — Win32 基础工具

#### `to_wide<S: AsRef<OsStr>>(s: S) -> Vec<u16>`
将 Rust 字符串转为以 null 结尾的 UTF-16 宽字符数组，供 Win32 API 使用。

#### `quote_windows_arg(arg: &str) -> String`
按照 `CommandLineToArgvW` 规则引号化单个命令行参数。仅在 `cfg(target_os = "windows")` 下可用。

#### `format_last_error(err: i32) -> String`
将 Win32 错误码转为可读文本描述。调用 `FormatMessageW` 获取系统错误消息，失败时回退为 `"Win32 error {code}"`。

#### `resolve_sid(name: &str) -> Result<Vec<u8>>`
将账户名或知名组名解析为 SID 字节数组。内置 5 个常见 SID 的快速路径。

#### `string_from_sid_bytes(sid: &[u8]) -> Result<String, String>`
将 SID 字节数组转为 `S-1-5-...` 格式的字符串表示。

### `dpapi.rs` — 数据保护

#### `protect(data: &[u8]) -> Result<Vec<u8>>`
使用 DPAPI 加密字节数据，作用域为本机。

#### `unprotect(blob: &[u8]) -> Result<Vec<u8>>`
解密由 `protect()` 加密的数据。

### `logging.rs` — 日志

#### `log_start(command: &[String], base_dir: Option<&Path>)`
记录命令启动事件。

#### `log_success(command: &[String], base_dir: Option<&Path>)`
记录命令成功完成事件。

#### `log_failure(command: &[String], detail: &str, base_dir: Option<&Path>)`
记录命令失败事件，附带错误详情。

#### `log_note(msg: &str, base_dir: Option<&Path>)`
无条件写入一条带时间戳的日志。

#### `debug_log(msg: &str, base_dir: Option<&Path>)`
仅在 `SBX_DEBUG=1` 时输出调试日志（同时写文件和 stderr）。

### `read_acl_mutex.rs` — ACL 互斥锁

#### `acquire_read_acl_mutex() -> Result<Option<ReadAclMutexGuard>>`
尝试获取命名互斥量。返回 `Some(guard)` 表示成功获取，`None` 表示已被其他进程持有。

#### `read_acl_mutex_exists() -> Result<bool>`
检查互斥量是否已存在（不获取所有权）。

### `sandbox_utils.rs` — 沙箱路径辅助

#### `ensure_codex_home_exists(p: &Path) -> Result<()>`
递归创建 Codex 主目录。

#### `inject_git_safe_directory(env_map: &mut HashMap<String, String>, cwd: &Path)`
向环境变量映射中注入 `safe.directory` 配置，使沙箱用户可以在主用户拥有的仓库中运行 git。

## 类型定义

### `ReadAclMutexGuard`（`read_acl_mutex.rs:17-19`）

```rust
pub struct ReadAclMutexGuard {
    handle: HANDLE,
}
```

RAII 守卫类型，持有 Windows 互斥量句柄。`Drop` 时自动调用 `ReleaseMutex` + `CloseHandle`。

## 配置项与默认值

| 配置 | 位置 | 默认值 | 说明 |
|------|------|--------|------|
| `SBX_DEBUG` | 环境变量 | 未设置（关闭） | 设为 `"1"` 启用调试日志 |
| `LOG_FILE_NAME` | `logging.rs:10` | `"sandbox.log"` | 日志文件名 |
| `LOG_COMMAND_PREVIEW_LIMIT` | `logging.rs:9` | `200` 字节 | 命令预览截断长度 |
| `READ_ACL_MUTEX_NAME` | `read_acl_mutex.rs:15` | `"Local\\CodexSandboxReadAcl"` | 命名互斥量名称 |

## 构建脚本（`build.rs`）

构建脚本使用 `winres` crate 将 `codex-windows-sandbox-setup.manifest` 应用清单嵌入到最终二进制文件中（`build.rs:12-14`）。该清单通常声明 UAC 提升需求和兼容性信息。

有一个特殊处理：在 Bazel 构建环境中使用 `windows-gnullvm` 目标时，由于 `winres` 的 `resource` 链接指令不可用，构建脚本会跳过清单嵌入（`build.rs:2-9`）。

## 边界 Case 与注意事项

- **DPAPI 作用域**：`protect`/`unprotect` 使用 `CRYPTPROTECT_LOCAL_MACHINE` 标志，意味着同一台机器上的**任何用户**都可以解密数据。这是有意设计——沙箱用户（受限令牌）和主用户需要共享加密数据
- **互斥锁语义**：`acquire_read_acl_mutex()` 采用"尝试-失败即放弃"策略（不阻塞等待），调用方需要自行处理 `None` 返回值
- **SID 缓冲区增长**：`resolve_sid` 初始分配 68 字节缓冲区，对于非标准长度的 SID 会自动扩充
- **Git worktree 支持**：`find_git_root()` 支持 `.git` 为 gitfile（worktree 场景）的情况，会解析 `gitdir:` 指向并回溯到 worktree 根目录
- **日志 UTF-8 安全**：命令预览截断使用 `take_bytes_at_char_boundary` 确保不会在多字节字符中间切断，有单元测试覆盖此场景（`logging.rs:82-90`）
- **Bazel 兼容**：构建脚本在 `gnullvm` 环境下静默跳过清单嵌入，不会导致构建失败