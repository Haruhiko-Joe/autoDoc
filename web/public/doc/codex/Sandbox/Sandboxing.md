# Sandboxing（沙箱编排库）

## 概述与职责

`codex-sandboxing` 是 Codex 安全层的核心编排库，位于 **Sandbox** 模块内部。它的职责是将高层级的沙箱策略（"允许读写哪些目录"、"是否允许网络访问"）翻译成各平台原生的安全隔离命令。在整个系统架构中，Core 和 ToolSystem 通过此库执行所有需要安全隔离的 shell 命令。

该库抽象了三种平台特定的沙箱机制：

| 平台 | `SandboxType` 枚举值 | 底层机制 |
|------|----------------------|----------|
| macOS | `MacosSeatbelt` | Apple 的 `sandbox-exec` (Seatbelt) |
| Linux | `LinuxSeccomp` | `codex-linux-sandbox` (bubblewrap + seccomp + landlock) |
| Windows | `WindowsRestrictedToken` | 受限令牌 (restricted tokens) |

同级兄弟模块包括 exec-server（进程生成中介）、网络代理和执行策略引擎。它依赖 `codex-protocol` 提供的策略类型定义和 `codex-network-proxy` 提供的代理配置。

## 关键流程

### 1. 沙箱类型选择流程

`SandboxManager::select_initial()` 根据用户偏好和当前策略自动决定是否启用平台沙箱：

1. 若偏好为 `Forbid`，直接返回 `SandboxType::None`
2. 若偏好为 `Require`，调用 `get_platform_sandbox()` 返回当前平台对应的沙箱类型
3. 若偏好为 `Auto`（默认），调用 `should_require_platform_sandbox()` 评估是否需要沙箱：
   - 存在托管网络要求时 → 需要沙箱
   - 网络未启用且文件系统非 `ExternalSandbox` 模式时 → 需要沙箱
   - 文件系统为 `Restricted` 且没有全盘写权限时 → 需要沙箱
   - 其他情况 → 无需沙箱

> 源码位置：`codex-rs/sandboxing/src/manager.rs:138-165`

### 2. 命令转换流程（transform）

`SandboxManager::transform()` 是核心方法，将一个 `SandboxTransformRequest` 转换为可直接执行的 `SandboxExecRequest`：

1. **计算有效权限**：将基础策略与 `additional_permissions`（工具级附加权限）合并，生成 `EffectiveSandboxPermissions`
2. **合并文件系统策略**：通过 `effective_file_system_sandbox_policy()` 将附加的读/写路径注入基础策略
3. **合并网络策略**：通过 `effective_network_sandbox_policy()` 合并网络权限
4. **构建 argv**：将 `SandboxCommand` 的 program + args 拼接为完整参数向量
5. **按平台分发**：
   - `MacosSeatbelt` → 调用 `create_seatbelt_command_args_for_policies()` 生成 `sandbox-exec` 命令行
   - `LinuxSeccomp` → 调用 `create_linux_sandbox_command_args_for_policies()` 生成 `codex-linux-sandbox` 命令行
   - `None` / `WindowsRestrictedToken` → 透传原始 argv
6. **返回 `SandboxExecRequest`**：包含最终命令、环境变量、工作目录和所有生效的策略

> 源码位置：`codex-rs/sandboxing/src/manager.rs:167-260`

### 3. macOS Seatbelt 策略生成

`create_seatbelt_command_args_for_policies()` 将策略翻译为 `sandbox-exec -p <policy> -D<params> -- <command>` 格式：

1. **文件写入策略**：根据是否有全盘写权限，生成全局写规则或基于 `WRITABLE_ROOT` 参数化的子路径规则。支持通过 `require-not` 排除受保护子路径
2. **文件读取策略**：类似写入，生成 `READABLE_ROOT` 参数化的读规则，带有 `unreadable_roots` 排除
3. **网络策略**：
   - 有代理配置时 → 仅允许 localhost 上的代理端口 + 可选的 Unix 域套接字
   - 无代理、网络已启用时 → 允许全部入站和出站
   - 网络未启用时 → 无网络规则（deny default 生效）
4. **拼装最终策略**：base policy + 读规则 + 写规则 + 网络规则 + 可选的平台默认路径

基础策略 (`seatbelt_base_policy.sbpl`) 采用 **deny default** 起手，参考了 Chromium 沙箱策略，仅允许进程 fork/exec、PTY 操作、用户偏好读取等最小权限集。

> 源码位置：`codex-rs/sandboxing/src/seatbelt.rs:373-499`

### 4. Linux 沙箱命令生成

`create_linux_sandbox_command_args_for_policies()` 将策略序列化为 JSON 并传递给外部 `codex-linux-sandbox` 辅助程序：

```
codex-linux-sandbox \
  --sandbox-policy-cwd <cwd> \
  --command-cwd <command_cwd> \
  --sandbox-policy '<json>' \
  --file-system-sandbox-policy '<json>' \
  --network-sandbox-policy '<json>' \
  [--use-legacy-landlock] \
  [--allow-network-for-proxy] \
  -- <original_command>
```

辅助程序在接收这些参数后执行实际的 bubblewrap + seccomp 隔离。`arg0` 会被覆盖为 `codex-linux-sandbox` 以支持自调用模式。

> 源码位置：`codex-rs/sandboxing/src/landlock.rs:25-71`

## 核心类型定义

### `SandboxType`

```rust
pub enum SandboxType {
    None,              // 不使用沙箱
    MacosSeatbelt,     // macOS sandbox-exec
    LinuxSeccomp,      // codex-linux-sandbox (bwrap + seccomp)
    WindowsRestrictedToken, // Windows 受限令牌
}
```

提供 `as_metric_tag()` 用于遥测指标标签。

> 源码位置：`codex-rs/sandboxing/src/manager.rs:23-40`

### `SandboxablePreference`

```rust
pub enum SandboxablePreference {
    Auto,    // 根据策略自动决定
    Require, // 强制启用
    Forbid,  // 强制禁用
}
```

> 源码位置：`codex-rs/sandboxing/src/manager.rs:42-47`

### `SandboxCommand`

发送给 `SandboxManager::transform()` 的原始命令描述：

| 字段 | 类型 | 说明 |
|------|------|------|
| `program` | `OsString` | 可执行程序路径 |
| `args` | `Vec<String>` | 命令参数 |
| `cwd` | `PathBuf` | 工作目录 |
| `env` | `HashMap<String, String>` | 环境变量 |
| `additional_permissions` | `Option<PermissionProfile>` | 工具级附加权限 |

> 源码位置：`codex-rs/sandboxing/src/manager.rs:65-72`

### `SandboxExecRequest`

`transform()` 的输出，包含可直接执行的命令和所有生效策略：

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | `Vec<String>` | 最终命令（含沙箱前缀） |
| `cwd` | `PathBuf` | 工作目录 |
| `env` | `HashMap<String, String>` | 环境变量 |
| `network` | `Option<NetworkProxy>` | 网络代理配置 |
| `sandbox` | `SandboxType` | 生效的沙箱类型 |
| `sandbox_policy` | `SandboxPolicy` | 生效的沙箱策略 |
| `file_system_sandbox_policy` | `FileSystemSandboxPolicy` | 生效的文件系统策略 |
| `network_sandbox_policy` | `NetworkSandboxPolicy` | 生效的网络策略 |
| `arg0` | `Option<String>` | Linux 下的 argv[0] 覆盖 |

> 源码位置：`codex-rs/sandboxing/src/manager.rs:74-87`

### `SandboxTransformRequest`

`transform()` 的输入参数包，将多个可选配置收拢为一个自文档化的结构体：

| 字段 | 类型 | 说明 |
|------|------|------|
| `command` | `SandboxCommand` | 原始命令 |
| `policy` | `&SandboxPolicy` | 基础沙箱策略 |
| `file_system_policy` | `&FileSystemSandboxPolicy` | 文件系统策略 |
| `network_policy` | `NetworkSandboxPolicy` | 网络策略 |
| `sandbox` | `SandboxType` | 目标沙箱类型 |
| `enforce_managed_network` | `bool` | 是否强制托管网络 |
| `network` | `Option<&NetworkProxy>` | 代理实例 |
| `sandbox_policy_cwd` | `&Path` | 策略计算的基准目录 |
| `codex_linux_sandbox_exe` | `Option<&PathBuf>` | Linux 沙箱辅助程序路径 |
| `use_legacy_landlock` | `bool` | 是否使用旧版 landlock |
| `windows_sandbox_level` | `WindowsSandboxLevel` | Windows 沙箱等级 |
| `windows_sandbox_private_desktop` | `bool` | Windows 私有桌面隔离 |

> 源码位置：`codex-rs/sandboxing/src/manager.rs:89-107`

## policy_transforms 模块

此模块负责权限策略的计算和合并，是沙箱策略系统的"数学层"。

### 核心函数

#### `EffectiveSandboxPermissions::new(sandbox_policy, additional_permissions)`

合并基础策略与附加权限，生成最终生效的 `SandboxPolicy`。当无附加权限时直接克隆原策略。

> 源码位置：`codex-rs/sandboxing/src/policy_transforms.rs:22-37`

#### `should_require_platform_sandbox(file_system_policy, network_policy, has_managed_network_requirements)`

决策函数：判断当前策略组合是否需要启用平台级沙箱。核心逻辑：
- 有托管网络要求 → `true`
- 网络受限时：`ExternalSandbox` 模式 → `false`，否则 → `true`
- 网络启用时：`Restricted` 模式且无全盘写权限 → `true`

> 源码位置：`codex-rs/sandboxing/src/policy_transforms.rs:422-442`

#### `merge_permission_profiles(base, permissions)`

联合两个 `PermissionProfile`：网络权限取"或"（任一启用则启用），文件路径取并集（去重）。

> 源码位置：`codex-rs/sandboxing/src/policy_transforms.rs:63-109`

#### `intersect_permission_profiles(requested, granted)`

交集运算：仅保留同时出现在请求和授权中的路径，网络权限两者都启用时才启用。用于工具权限的安全收窄。

> 源码位置：`codex-rs/sandboxing/src/policy_transforms.rs:111-144`

#### `normalize_additional_permissions(additional_permissions)`

规范化附加权限中的文件路径——通过 `canonicalize()` 解析符号链接并去重。

> 源码位置：`codex-rs/sandboxing/src/policy_transforms.rs:39-61`

### 策略合并矩阵

`sandbox_policy_with_additional_permissions()` 根据基础策略类型进行不同的合并：

| 基础策略 | 合并行为 |
|----------|----------|
| `DangerFullAccess` | 直接透传，无需合并 |
| `ExternalSandbox` | 仅合并网络权限 |
| `WorkspaceWrite` | 合并可写根、可读根、网络权限 |
| `ReadOnly` | 无额外写路径时合并读路径；有写路径时升级为 `WorkspaceWrite` |

> 源码位置：`codex-rs/sandboxing/src/policy_transforms.rs:342-410`

## bubblewrap (bwrap) 检测

`bwrap` 模块提供 Linux 上系统级 bubblewrap 的检测和告警：

- `find_system_bwrap_in_path()`：在 `$PATH` 中查找 `bwrap` 可执行文件，**排除**当前工作目录下的结果（防止攻击者注入恶意版本）
- `system_bwrap_warning()`：当策略非 `DangerFullAccess` / `ExternalSandbox` 且找不到系统 bwrap 时，返回警告信息提示用户安装

> 源码位置：`codex-rs/sandboxing/src/bwrap.rs:1-58`

## 边界 Case 与注意事项

- **macOS `sandbox-exec` 路径硬编码为 `/usr/bin/sandbox-exec`**：这是一个有意的安全决策——防止攻击者通过 PATH 注入恶意版本。如果该路径被篡改，意味着攻击者已有 root 权限（`codex-rs/sandboxing/src/seatbelt.rs:23-27`）

- **Linux 沙箱要求外部可执行文件**：`codex_linux_sandbox_exe` 必须提供，否则 `transform()` 返回 `MissingLinuxSandboxExecutable` 错误。沙箱通过 `arg0` 覆盖支持自调用模式（binary 名为 `codex-linux-sandbox` 时使用原始路径）

- **ReadOnly → WorkspaceWrite 自动升级**：当 `ReadOnly` 策略的附加权限包含写路径时，会自动升级为 `WorkspaceWrite`。代码注释标注这是一个临时近似方案（`codex-rs/sandboxing/src/policy_transforms.rs:393-407`）

- **网络代理的 fail-closed 行为**：存在代理配置但无法推断有效回环端口时，网络策略生成空字符串，由 `deny default` 兜底阻断所有网络访问（`codex-rs/sandboxing/src/seatbelt.rs:270-280`）

- **Unix 域套接字支持两种模式**：`AllowAll`（允许所有 Unix 套接字绑定和连接）和 `Restricted`（基于路径白名单，使用 `subpath` 匹配覆盖目录下的所有套接字）

- **Windows 沙箱当前为透传模式**：`WindowsRestrictedToken` 变体在 `transform()` 中直接透传原始命令，实际限制由 `SandboxExecRequest` 中的 `windows_sandbox_level` 和 `windows_sandbox_private_desktop` 标志在下游 exec-server 中执行

- **`SandboxManager` 是无状态的**：它是一个空结构体（`#[derive(Default)] pub struct SandboxManager;`），所有方法均为纯函数式转换，不持有任何运行时状态