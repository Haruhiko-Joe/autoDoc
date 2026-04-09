# LinuxSandbox — Linux 沙箱启动器

## 概述与职责

`codex-linux-sandbox` 是 Codex 安全层（Sandbox 模块）中 **Linux 平台专用的沙箱启动器**。它作为一个独立的二进制入口（`codex-linux-sandbox`），负责在执行用户命令之前叠加多层操作系统级保护机制：

1. **Bubblewrap (bwrap)**：通过 Linux namespace 实现文件系统隔离
2. **Landlock**：内核级文件系统访问控制（遗留/备用路径）
3. **seccomp**：系统调用过滤，主要用于网络限制
4. **Proxy Routing**：在网络隔离环境中通过桥接代理保持受控的网络连通性

在整体架构中，本模块是 **Sandbox** 子系统的 Linux 实现端。上层的 `codex-core` 和 `codex-sandboxing` 负责决定沙箱策略，而 `codex-linux-sandbox` 负责在进程级别实际执行这些策略。它与 macOS 的 Seatbelt 沙箱是对等的平台实现。

## 关键流程

### 主执行流程（两阶段模型）

沙箱采用**外层-内层两阶段**设计，核心原因是 bubblewrap 可能依赖 setuid 权限，而 seccomp 需要先设置 `PR_SET_NO_NEW_PRIVS`，两者不能同时应用。

**外层阶段**（`linux_run_main.rs:run_main()`，第 101-222 行）：

1. 解析 CLI 参数（`LandlockCommand`），获取沙箱策略、工作目录、命令等
2. 调用 `resolve_sandbox_policies()` 统一处理遗留策略与分离策略的兼容性
3. 若需网络代理，调用 `prepare_host_proxy_route_spec()` 在宿主侧启动桥接进程
4. 构建 bubblewrap 命令参数，设置文件系统视图（只读根 + 可写根）
5. 通过 `exec_bwrap()` 执行 bubblewrap，进入沙箱命名空间

**内层阶段**（`--apply-seccomp-then-exec` 模式）：

1. bubblewrap 在沙箱内重新执行 `codex-linux-sandbox` 自身
2. 若启用代理模式，调用 `activate_proxy_routes_in_netns()` 建立本地桥接
3. 应用 `PR_SET_NO_NEW_PRIVS` + seccomp 过滤器
4. 最终 `execvp` 到用户命令

```
宿主进程
  └─ codex-linux-sandbox (外层)
       ├─ 准备代理桥接（如需要）
       ├─ 构建 bwrap 参数
       └─ exec bwrap
            └─ codex-linux-sandbox --apply-seccomp-then-exec (内层)
                 ├─ 激活代理路由（如需要）
                 ├─ 设置 no_new_privs + seccomp
                 └─ execvp 用户命令
```

### Bubblewrap 文件系统挂载策略

`bwrap.rs` 中的 `create_filesystem_args()` 构建了文件系统视图，挂载顺序至关重要（`src/bwrap.rs:209-389`）：

1. **基础层**：全读策略用 `--ro-bind / /`，受限策略用 `--tmpfs /` + 逐路径 `--ro-bind`
2. **设备层**：`--dev /dev` 挂载最小化设备节点（null、zero、urandom 等）
3. **不可读祖先掩码**：对不可读但包含可写子路径的目录，先用 `--tmpfs` + `--perms 111` 掩码
4. **可写根绑定**：`--bind <root> <root>` 开放写权限
5. **只读子路径保护**：`--ro-bind` 重新保护 `.git`、`.codex` 等敏感子路径
6. **嵌套不可读掩码**：最后应用可写根下的不可读区域

此外还包含多项防御措施：跳过不存在的可写根（跨平台配置兼容）、符号链接攻击检测（`find_symlink_in_path()`，`src/bwrap.rs:533-565`）、以及首次不存在路径组件的抢占式掩码。

### seccomp 网络过滤

`landlock.rs` 中的 `install_network_seccomp_filter_on_current_thread()` 实现了两种 seccomp 模式（`src/landlock.rs:168-264`）：

**Restricted 模式**（完全禁止网络）：
- 阻止 `connect`、`accept`、`bind`、`listen`、`sendto`、`sendmmsg` 等系统调用
- `socket`/`socketpair` 仅允许 `AF_UNIX`（保留进程间通信能力）
- 阻止 `ptrace`、`io_uring_*` 等可能绕过过滤器的系统调用

**ProxyRouted 模式**（仅允许代理流量）：
- 允许 `AF_INET`/`AF_INET6` socket（用于连接本地 TCP 桥接）
- 阻止 `AF_UNIX` 新建（防止绕过路由桥接）
- 同样阻止 `ptrace` 和 `io_uring_*`

### 代理路由机制

当需要在网络隔离的沙箱中保持代理连通性时，`proxy_routing.rs` 实现了一个**双层桥接**架构：

**宿主侧**（`prepare_host_proxy_route_spec()`，`src/proxy_routing.rs:70-119`）：
1. 扫描环境变量中的代理配置（`HTTP_PROXY`、`HTTPS_PROXY` 等共 14 种）
2. 仅接受指向 loopback 的代理端点（安全限制）
3. 为每个端点 fork 一个 **Host Bridge** 子进程：监听 Unix Domain Socket，将连接转发到原始代理 TCP 端口

**沙箱侧**（`activate_proxy_routes_in_netns()`，`src/proxy_routing.rs:121-167`）：
1. 为每个 UDS 路径 fork 一个 **Local Bridge** 子进程：监听 loopback TCP 端口，将连接转发到宿主侧的 UDS
2. 重写代理环境变量，将端口指向本地桥接端口

```
沙箱进程 → 127.0.0.1:LOCAL_PORT → Local Bridge → UDS → Host Bridge → 127.0.0.1:ORIGINAL_PORT → 原始代理
```

## 函数签名与参数说明

### `run_main() -> !`

模块入口函数（`src/lib.rs:20-22`）。解析 CLI 参数并执行沙箱化命令，永不返回（通过 `execvp` 或 `panic!` 终止）。

### `apply_sandbox_policy_to_current_thread()`

```rust
pub(crate) fn apply_sandbox_policy_to_current_thread(
    sandbox_policy: &SandboxPolicy,
    network_sandbox_policy: NetworkSandboxPolicy,
    cwd: &Path,
    apply_landlock_fs: bool,
    allow_network_for_proxy: bool,
    proxy_routed_network: bool,
) -> Result<()>
```

在当前线程上应用进程内沙箱限制（`src/landlock.rs:42-87`）。负责：
- 按需设置 `PR_SET_NO_NEW_PRIVS`
- 安装网络 seccomp 过滤器
- 可选：应用 Landlock 文件系统规则（遗留路径）

### `create_bwrap_command_args()`

```rust
pub(crate) fn create_bwrap_command_args(
    command: Vec<String>,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    sandbox_policy_cwd: &Path,
    command_cwd: &Path,
    options: BwrapOptions,
) -> Result<BwrapArgs>
```

根据文件系统策略构建 bubblewrap 命令行参数（`src/bwrap.rs:94-119`）。当策略允许完全磁盘写入且网络不受限时，直接返回原始命令（无需包装）。

### `exec_bwrap()`

```rust
pub(crate) fn exec_bwrap(argv: Vec<String>, preserved_files: Vec<File>) -> !
```

执行 bubblewrap（`src/launcher.rs:26-33`）。自动选择系统安装的 bwrap 或编译时内建的 vendored bwrap。对于系统 bwrap，需清除保留文件描述符的 `FD_CLOEXEC` 标志以便跨 `exec` 边界传递。

## 类型定义

### `LandlockCommand`（CLI 参数结构）

| 字段 | 类型 | 说明 |
|------|------|------|
| `sandbox_policy_cwd` | `PathBuf` | 沙箱策略解析的工作目录 |
| `command_cwd` | `Option<PathBuf>` | 命令实际运行的工作目录（可能是符号链接别名） |
| `sandbox_policy` | `Option<SandboxPolicy>` | 遗留格式的统一策略 |
| `file_system_sandbox_policy` | `Option<FileSystemSandboxPolicy>` | 分离的文件系统策略 |
| `network_sandbox_policy` | `Option<NetworkSandboxPolicy>` | 分离的网络策略 |
| `use_legacy_landlock` | `bool` | 使用遗留 Landlock 路径（默认 false） |
| `apply_seccomp_then_exec` | `bool` | 内层阶段标志：应用 seccomp 后执行命令 |
| `allow_network_for_proxy` | `bool` | 启用代理路由模式 |
| `proxy_route_spec` | `Option<String>` | 代理路由规格（JSON 序列化） |
| `no_proc` | `bool` | 跳过挂载 `/proc`（用于受限容器环境） |
| `command` | `Vec<String>` | 要执行的命令及参数 |

> 源码位置：`src/linux_run_main.rs:23-92`

### `BwrapNetworkMode`

| 变体 | 说明 |
|------|------|
| `FullAccess` | 保留宿主网络命名空间 |
| `Isolated` | 完全隔离网络命名空间 |
| `ProxyOnly` | 隔离网络但通过桥接保留代理连通性 |

> 源码位置：`src/bwrap.rs:62-73`

### `NetworkSeccompMode`

| 变体 | 说明 |
|------|------|
| `Restricted` | 阻止所有网络系统调用，仅保留 AF_UNIX |
| `ProxyRouted` | 允许 AF_INET/AF_INET6，阻止 AF_UNIX 新建 |

> 源码位置：`src/landlock.rs:89-93`

## 配置项与默认值

- **`CODEX_BWRAP_SOURCE_DIR`**：环境变量，指定 bubblewrap 源码目录（构建时），默认使用 `codex-rs/vendor/bubblewrap`
- **`CODEX_HOME`**：环境变量，代理 socket 目录的备选父目录（`$CODEX_HOME/tmp`），默认回退到系统临时目录
- **`PROXY_ENV_KEYS`**：支持的代理环境变量名（共 14 个），包括 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NPM_CONFIG_PROXY`、`PIP_PROXY` 等
- **`LINUX_PLATFORM_DEFAULT_READ_ROOTS`**：受限读策略下默认可读的系统路径：`/bin`、`/sbin`、`/usr`、`/etc`、`/lib`、`/lib64`、`/nix/store`、`/run/current-system/sw`

### Bubblewrap 启动器选择策略

`launcher.rs` 中的 `preferred_bwrap_launcher()` 函数（第 35-43 行）决定使用哪个 bwrap：
1. 优先使用系统路径中找到的 bwrap 二进制（通过 `find_system_bwrap_in_path()`）
2. 检测系统 bwrap 是否支持 `--argv0`（v0.9.0+ 新增，Ubuntu 20.04/22.04 可能不支持）
3. 若系统无 bwrap 或不可用，回退到构建时编译的 vendored bwrap

## 构建系统

`build.rs` 在 Linux 目标上编译 vendored bubblewrap C 源码（`bubblewrap.c`、`bind-mount.c`、`network.c`、`utils.c`），将 `main` 重命名为 `bwrap_main` 以便通过 FFI 调用。需要 `libcap` 头文件（通过 `pkg-config` 检测）。编译成功后设置 `vendored_bwrap_available` cfg 标志。

> 源码位置：`build.rs:43-81`

## 边界 Case 与注意事项

- **`/proc` 挂载失败回退**：在受限容器环境中（如某些 Docker 配置），`--proc /proc` 可能失败。`run_main()` 会先用 `/bin/true` 做预检测（`preflight_proc_mount_support()`），失败时自动以 `--no-proc` 重试（`src/linux_run_main.rs:519-533`）

- **`--apply-seccomp-then-exec` 与 `--use-legacy-landlock` 互斥**：两者不能同时使用，因为内层阶段假定 bubblewrap 已建立文件系统视图

- **符号链接防护**：`find_symlink_in_path()` 检测可写根下的符号链接，防止通过替换符号链接绕过只读保护（例如 `.codex -> ./decoy`）

- **代理路由仅支持 loopback 端点**：`parse_loopback_proxy_endpoint()` 仅接受 `127.0.0.1`、`::1` 或 `localhost` 作为代理地址，非本地代理不会被桥接

- **`recvfrom` 系统调用被有意保留**：在 Restricted seccomp 模式中，`recvfrom` 未被阻止，因为 `cargo clippy` 等工具依赖 socketpair + 子进程通信（`src/landlock.rs:196-198`）

- **loopback 接口自动启用**：在网络隔离命名空间中，`bind_local_loopback_listener()` 会在绑定失败时自动尝试启用 `lo` 接口（`src/proxy_routing.rs:526-542`）

- **代理 socket 目录清理**：fork 出的清理 worker 进程会在所有桥接进程退出后自动删除 socket 目录。启动时也会清理属于已退出进程的残留目录（`src/proxy_routing.rs:324-351`）

- **非 Linux 平台直接 panic**：`lib.rs` 中非 Linux 的 `run_main()` 实现直接 panic，本模块仅在 Linux 上可用