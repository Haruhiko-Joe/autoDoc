# PolicyAndEnvironment — 沙箱策略解析与文件系统路径计算

## 概述与职责

PolicyAndEnvironment 模块是 **WindowsSandbox** 子系统的策略与环境准备层，负责在沙箱化的进程启动之前完成所有"决策性"和"环境性"的前置工作。具体职责包括：

1. **策略解析**：将用户传入的策略字符串（预设名或 JSON）解析为 `SandboxPolicy` 枚举
2. **允许/拒绝路径计算**：根据策略、工作目录和可写根目录，计算出沙箱进程可写的路径集合与需要拒绝写入的保护路径
3. **环境变量规范化**：为沙箱进程准备安全、可控的环境变量——包括网络阻断、NUL 设备映射、分页器配置等
4. **Windows 路径规范化**：统一反斜杠/正斜杠和大小写差异，生成可用于集合比较的规范路径键
5. **World-writable 目录审计**：主动扫描文件系统中对 Everyone 可写的目录，并为沙箱能力 SID 添加拒绝 ACE 来封堵写入

在 Sandbox 的整体层级中，WindowsSandbox 是 Windows 平台的沙箱实现，而本模块处于其核心的"策略决策"位置——它的输出驱动后续的 ACL 设置、受限 token 创建等执行层逻辑。

---

## 关键流程

### 1. 策略解析流程

策略解析由 `parse_policy()` 函数完成（`policy.rs:4-24`），接受一个字符串参数，支持三种输入形式：

1. **预设字符串** `"read-only"` → 返回 `SandboxPolicy::new_read_only_policy()`
2. **预设字符串** `"workspace-write"` → 返回 `SandboxPolicy::new_workspace_write_policy()`
3. **JSON 字符串** → 通过 `serde_json::from_str` 反序列化为 `SandboxPolicy`

无论哪种方式，`DangerFullAccess` 和 `ExternalSandbox` 两种策略变体都会被**显式拒绝**——这是一条安全硬约束，确保 Windows 沙箱永远不会以不受限模式运行。

### 2. 允许/拒绝路径计算流程

`compute_allow_paths()` 函数（`allow.rs:14-93`）根据策略计算沙箱进程的文件系统写权限边界：

1. 仅在 `WorkspaceWrite` 策略下生效；`ReadOnly` 策略不产生任何允许写入路径
2. 将 `command_cwd`（命令工作目录）加入允许集合
3. 遍历策略中额外配置的 `writable_roots`，将每个根目录加入允许集合
4. 对每个可写根目录，自动将 `.git`、`.codex`、`.agents` 三个子目录加入**拒绝集合**——这是为了保护版本控制和 Codex 配置不被沙箱内进程篡改
5. 如果 `exclude_tmpdir_env_var` 为 `false`，还会将 `TEMP`/`TMP` 环境变量指向的目录加入允许集合
6. 所有路径通过 `dunce::canonicalize` 规范化，路径不存在时静默跳过

```
WorkspaceWrite 策略
  ├── 允许: command_cwd（规范化）
  ├── 允许: writable_roots 中的每个路径（规范化）
  ├── 允许: TEMP/TMP 目录（仅当 exclude_tmpdir_env_var=false）
  ├── 拒绝: 每个允许路径下的 .git/
  ├── 拒绝: 每个允许路径下的 .codex/
  └── 拒绝: 每个允许路径下的 .agents/
```

### 3. 网络阻断环境变量注入

`apply_no_network_to_env()` 函数（`env.rs:123-174`）通过环境变量层面的多重封堵来阻止沙箱内进程进行网络访问：

1. 设置 `SBX_NONET_ACTIVE=1` 标记
2. 将 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 指向不可达地址 `http://127.0.0.1:9`（discard 端口）
3. 将 `NO_PROXY` 设为 `localhost,127.0.0.1,::1`
4. 针对特定包管理器设置离线模式：`PIP_NO_INDEX=1`、`NPM_CONFIG_OFFLINE=true`、`CARGO_NET_OFFLINE=true`
5. Git 层面：设置 HTTP/HTTPS 代理、将 SSH 命令替换为 `cmd /c exit 1`、清空允许协议列表
6. 调用 `ensure_denybin()` 在 `~/.sbx-denybin/` 下创建 `ssh.bat`/`ssh.cmd`/`scp.bat`/`scp.cmd` 桩文件（仅返回退出码 1），同时清除旧的 `curl`/`wget` 桩文件
7. 将 denybin 目录**前置**到 PATH，并重排 PATHEXT 使 `.BAT`/`.CMD` 优先于 `.EXE`——确保桩文件先于真实二进制被找到

### 4. World-writable 目录审计与修复

审计流程分两步（`audit.rs`）：

**第一步：扫描**（`audit_everyone_writable()`，`audit.rs:87-210`）

扫描顺序经过精心设计，优先覆盖最可能存在问题的位置：

1. **快速通道**：先扫描 CWD 的直接子目录（工作区问题尽早发现）
2. **候选收集**（`gather_candidates()`，`audit.rs:43-78`）：按优先级收集 CWD → TEMP/TMP → USERPROFILE/PUBLIC → PATH 条目 → C:/ 和 C:/Windows
3. 对每个候选目录及其一级子目录，调用 `path_has_world_write_allow()` 检查 ACL 中是否存在 Everyone 的写权限
4. 跳过符号链接/联结点、以及 `Windows/Installer`/`Windows/Registration`/`ProgramData` 等无关系统目录

扫描受三个常量保护以避免耗时过长：
- `MAX_ITEMS_PER_DIR = 1000`：每个目录最多检查 1000 个条目
- `AUDIT_TIME_LIMIT_SECS = 2`：总耗时不超过 2 秒
- `MAX_CHECKED_LIMIT = 50000`：总检查数量不超过 50000

**第二步：修复**（`apply_capability_denies_for_world_writable()`，`audit.rs:238-296`）

1. 加载或创建沙箱能力 SID（通过 `load_or_create_cap_sids()`）
2. 根据策略类型选择对应的能力 SID（`workspace` 或 `readonly`）
3. 对每个被标记的 world-writable 目录，如果**不在**工作区可写根目录中，则通过 `add_deny_write_ace()` 添加拒绝写入的 ACE
4. `DangerFullAccess`/`ExternalSandbox` 策略直接跳过（不做修复）

---

## 函数签名与参数说明

### `parse_policy(value: &str) -> Result<SandboxPolicy>`

解析策略字符串为 `SandboxPolicy` 枚举。

- **value**：`"read-only"`、`"workspace-write"` 或合法 JSON
- **返回**：解析后的 `SandboxPolicy`，`DangerFullAccess`/`ExternalSandbox` 时返回错误

> 源码位置：`codex-rs/windows-sandbox-rs/src/policy.rs:4-24`

### `compute_allow_paths(policy, policy_cwd, command_cwd, env_map) -> AllowDenyPaths`

计算沙箱进程的允许/拒绝写路径集合。

- **policy**: `&SandboxPolicy` — 当前策略
- **policy_cwd**: `&Path` — 策略定义时的工作目录（用于解析相对路径的 writable_roots）
- **command_cwd**: `&Path` — 实际命令的工作目录
- **env_map**: `&HashMap<String, String>` — 环境变量映射（用于读取 TEMP/TMP）
- **返回**：`AllowDenyPaths { allow: HashSet<PathBuf>, deny: HashSet<PathBuf> }`

> 源码位置：`codex-rs/windows-sandbox-rs/src/allow.rs:14-93`

### `normalize_null_device_env(env_map: &mut HashMap<String, String>)`

将环境变量值中指向 `/dev/null` 或 `\\dev\\null` 的引用替换为 Windows 的 `NUL` 设备。

> 源码位置：`codex-rs/windows-sandbox-rs/src/env.rs:9-19`

### `ensure_non_interactive_pager(env_map: &mut HashMap<String, String>)`

确保 `GIT_PAGER`、`PAGER` 设为 `more.com`，`LESS` 设为空串，避免沙箱内进程阻塞在交互式分页器上。

> 源码位置：`codex-rs/windows-sandbox-rs/src/env.rs:21-29`

### `inherit_path_env(env_map: &mut HashMap<String, String>)`

如果 env_map 中缺少 `PATH` 或 `PATHEXT`，从父进程环境继承。

> 源码位置：`codex-rs/windows-sandbox-rs/src/env.rs:32-43`

### `apply_no_network_to_env(env_map: &mut HashMap<String, String>) -> Result<()>`

注入全套网络阻断环境变量，创建 SSH/SCP 桩文件，调整 PATH 和 PATHEXT。

> 源码位置：`codex-rs/windows-sandbox-rs/src/env.rs:123-174`

### `canonicalize_path(path: &Path) -> PathBuf`

使用 `dunce::canonicalize` 规范化路径，失败时返回原始路径。

> 源码位置：`codex-rs/windows-sandbox-rs/src/path_normalization.rs:4-6`

### `canonical_path_key(path: &Path) -> String`

生成路径的规范键：规范化 → 反斜杠转正斜杠 → 全部小写。用于路径的去重比较。

> 源码位置：`codex-rs/windows-sandbox-rs/src/path_normalization.rs:8-13`

### `audit_everyone_writable(cwd, env, logs_base_dir) -> Result<Vec<PathBuf>>`

扫描文件系统，返回所有对 Everyone SID 具有写权限的目录列表。

> 源码位置：`codex-rs/windows-sandbox-rs/src/audit.rs:87-210`

### `apply_world_writable_scan_and_denies(codex_home, cwd, env_map, sandbox_policy, logs_base_dir) -> Result<()>`

组合入口：先执行 world-writable 扫描，然后对标记目录应用能力拒绝 ACE。

> 源码位置：`codex-rs/windows-sandbox-rs/src/audit.rs:212-236`

---

## 接口/类型定义

### `AllowDenyPaths`

```rust
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AllowDenyPaths {
    pub allow: HashSet<PathBuf>,  // 允许写入的路径集合
    pub deny: HashSet<PathBuf>,   // 拒绝写入的路径集合（优先于 allow）
}
```

> 源码位置：`codex-rs/windows-sandbox-rs/src/allow.rs:8-12`

### `SandboxPolicy`（re-export）

从 `codex_protocol::protocol::SandboxPolicy` 重导出，主要使用的变体：

- `ReadOnly { .. }` — 只读策略，沙箱内无写权限
- `WorkspaceWrite { writable_roots, exclude_tmpdir_env_var, .. }` — 工作区写策略，允许对指定目录写入
- `DangerFullAccess` — 全权限（本模块中被禁止使用）
- `ExternalSandbox { .. }` — 外部沙箱（本模块中被禁止使用）

---

## 配置项与默认值

### 审计扫描常量（`audit.rs:25-33`）

| 常量 | 值 | 说明 |
|------|----|------|
| `MAX_ITEMS_PER_DIR` | 1000 | 每个目录最多扫描的条目数 |
| `AUDIT_TIME_LIMIT_SECS` | 2 | 审计扫描的最大耗时（秒） |
| `MAX_CHECKED_LIMIT` | 50000 | 审计扫描检查的最大路径总数 |
| `SKIP_DIR_SUFFIXES` | `["/windows/installer", "/windows/registration", "/programdata"]` | 扫描时跳过的系统目录后缀 |

### 网络阻断默认值

| 环境变量 | 默认值 | 用途 |
|----------|--------|------|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | `http://127.0.0.1:9` | 指向 discard 端口阻断网络 |
| `NO_PROXY` | `localhost,127.0.0.1,::1` | 本地地址白名单 |
| `GIT_SSH_COMMAND` | `cmd /c exit 1` | 阻止 Git SSH 操作 |
| `GIT_ALLOW_PROTOCOLS` | `""` （空） | 禁止所有 Git 协议 |
| `GIT_PAGER` / `PAGER` | `more.com` | 非交互式分页器 |
| Denybin 目录 | `~/.sbx-denybin/` | SSH/SCP 桩文件存放位置 |

---

## 边界 Case 与注意事项

- **路径不存在时静默跳过**：`compute_allow_paths()` 中的 `add_allow_path` 和 `add_deny_path` 闭包会检查 `p.exists()`，不存在的路径不会进入集合。这意味着如果 writable_roots 中配置了尚未创建的目录，它不会被允许。

- **相对路径解析**：`writable_roots` 中的相对路径会基于 `policy_cwd` 解析，而非 `command_cwd`。这两个目录可能不同。

- **保护目录是硬编码的**：`.git`、`.codex`、`.agents` 三个被保护子目录是硬编码的，无法通过配置跳过。这是一个有意的安全设计。

- **NUL 设备映射的匹配规则**：`normalize_null_device_env()` 使用 trim + 小写比较，能匹配带前后空白的 `/dev/null`，但对路径中包含额外字符（如 `/dev/null2`）不会误匹配。

- **Denybin 桩文件是累积的**：`ensure_denybin()` 不会清理已存在的桩文件，但 `apply_no_network_to_env()` 会**主动删除** `curl` 和 `wget` 的桩文件——这意味着网络阻断策略故意不阻止 curl/wget（可能是因为它们通过代理环境变量已经被阻断了）。

- **审计扫描的安全超时**：2 秒时间限制意味着在大型文件系统上可能无法完成完整扫描。扫描结果是尽力而为的，不保证覆盖所有 world-writable 目录。

- **符号链接被跳过**：审计扫描中 `is_symlink()` 的目录会被跳过，避免通过链接绕过扫描或审计到链接本身的 ACL 而非目标的 ACL。

- **工作区目录豁免**：`apply_capability_denies_for_world_writable()` 中，如果某个 world-writable 目录位于工作区可写根目录之下，不会对其添加拒绝 ACE——这是合理的，因为沙箱进程本来就需要对这些目录有写权限。