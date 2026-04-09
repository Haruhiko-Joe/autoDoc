# Arg0Dispatch — argv[0] 二进制多路复用机制

## 概述与职责

`codex-arg0` 是 Codex CLI 架构中的**进程启动分发层**，位于 CLI 模块内部。它实现了经典的"argv[0] 技巧"——通过检查进程启动时的可执行文件名（`argv[0]`），将单个 Codex 二进制文件多路复用为多个独立工具，从而**无需分发多个独立二进制文件**。

在系统架构中，`codex-arg0` 是所有 Codex Rust 二进制 crate 的 `main()` 函数入口点包装器。CLI、AppServer 等上层模块通过调用 `arg0_dispatch_or_else()` 来启动，该函数会在进入真正的业务逻辑之前完成分发检查、环境加载和运行时构建。

**它所属的层级**：CLI → Arg0Dispatch。与 CLI 模块的其他兄弟节点（如 TUI 启动、AppServer 启动等）并列，但它是最早执行的逻辑——决定当前进程到底该扮演哪个角色。

### 核心职责

1. **argv[0] 分发**：根据可执行文件名将进程分发到 `codex-linux-sandbox`、`apply_patch` 或 `codex-execve-wrapper`
2. **PATH 注入**：创建临时目录并放入指向自身的符号链接/脚本，将其前置到 `PATH`，使子进程能以正确的名称重新调用这些内嵌工具
3. **环境变量加载**：在创建任何线程之前从 `~/.codex/.env` 加载 `.env` 文件
4. **Tokio 运行时构建**：构建配置好的多线程 Tokio 运行时
5. **临时目录清理**：在启动时清理上一次遗留的过期临时目录

## 关键流程

### 主分发流程（`arg0_dispatch`）

这是整个模块的核心入口，执行流程如下：

1. **读取 `argv[0]`**：从 `std::env::args_os()` 获取第一个参数，提取文件名部分（`src/lib.rs:55-60`）

2. **匹配可执行文件名并分发**：
   - 若为 `codex-execve-wrapper`（仅 Unix）：创建单线程 Tokio 运行时，调用 `codex_shell_escalation::run_shell_escalation_execve_wrapper()` 执行 shell 权限提升包装，然后退出进程（`src/lib.rs:63-86`）
   - 若为 `codex-linux-sandbox`：直接调用 `codex_linux_sandbox::run_main()`，该函数永不返回（`src/lib.rs:88-90`）
   - 若为 `apply_patch` 或 `applypatch`（处理拼写错误的情况）：调用 `codex_apply_patch::main()`（`src/lib.rs:91-93`）

3. **检查 argv[1] 分发**：若 `argv[1]` 为 `--codex-run-as-apply-patch`，则以"内联模式"运行 apply_patch —— 读取第三个参数作为补丁内容，调用 `codex_apply_patch::apply_patch()` 执行并退出（`src/lib.rs:95-113`）。这是 Windows 上 `.bat` 脚本使用的路径。

4. **加载 `.env`**：调用 `load_dotenv()` 从 `~/.codex/.env` 加载环境变量（`src/lib.rs:117`）

5. **注入 PATH 条目**：调用 `prepend_path_entry_for_codex_aliases()` 创建临时目录并前置到 PATH（`src/lib.rs:119-127`）

### 高层入口（`arg0_dispatch_or_else`）

这是二进制 crate 应使用的高层包装函数（`src/lib.rs:153-182`）：

1. 调用 `arg0_dispatch()` 执行上述分发逻辑
2. 如果未被分发（即当前是正常的 `codex` 调用），则：
   - 构建 Tokio 多线程运行时（16 MB 线程栈）
   - 组装 `Arg0DispatchPaths`（含 `codex_self_exe`、`codex_linux_sandbox_exe`、`main_execve_wrapper_exe`）
   - 在运行时中执行调用者提供的异步 `main_fn`

### PATH 注入流程（`prepend_path_entry_for_codex_aliases`）

这个函数是使"单二进制多工具"方案对子进程生效的关键（`src/lib.rs:245-370`）：

1. **确定临时目录根路径**：使用 `~/.codex/tmp/arg0/` 作为临时目录的父目录，而非系统 tmp 目录
2. **安全校验**（release 构建）：拒绝在系统临时目录下创建 helper（`src/lib.rs:247-259`）
3. **权限设置**（Unix）：将 `tmp/arg0/` 目录权限设为 `0o700`，仅当前用户可访问（`src/lib.rs:266-271`）
4. **清理过期目录**：调用 `janitor_cleanup()` 清理无主的旧会话目录（`src/lib.rs:274-276`）
5. **创建新的临时目录**：以 `codex-arg0` 为前缀创建 `TempDir`（`src/lib.rs:278-280`）
6. **获取文件锁**：在目录中创建 `.lock` 文件并加排他锁，防止被清理程序误删（`src/lib.rs:283-290`）
7. **创建符号链接/脚本**：
   - **Unix**：为 `apply_patch`、`applypatch`、`codex-linux-sandbox`（仅 Linux）、`codex-execve-wrapper` 创建指向当前可执行文件的符号链接（`src/lib.rs:302-306`）
   - **Windows**：创建 `.bat` 批处理脚本，通过 `--codex-run-as-apply-patch` 标志间接调用当前可执行文件（`src/lib.rs:308-320`）
8. **修改 PATH**：将临时目录路径前置到 `PATH` 环境变量（`src/lib.rs:329-343`）
9. **返回 Guard**：返回 `Arg0PathEntryGuard`，其生命周期控制临时目录的存续

### 临时目录清理（`janitor_cleanup`）

启动时的垃圾回收机制（`src/lib.rs:372-399`）：

1. 遍历 `~/.codex/tmp/arg0/` 下的所有子目录
2. 对每个目录，尝试获取其 `.lock` 文件的排他锁
3. 如果能获取锁（说明持有者已退出），则删除整个目录
4. 如果锁被占用（`WouldBlock`），说明仍有进程在使用，跳过
5. 如果没有 `.lock` 文件，也跳过（不是由 arg0 系统创建的目录）

## 函数签名与参数说明

### `arg0_dispatch() -> Option<Arg0PathEntryGuard>`

低层分发入口。检查 `argv[0]` 并可能直接接管进程（永不返回），或者返回 PATH 注入的 guard。

- **返回值**：`Some(guard)` 表示 PATH 已成功注入；`None` 表示注入失败但进程可继续

### `arg0_dispatch_or_else<F, Fut>(main_fn: F) -> anyhow::Result<()>`

高层入口，二进制 crate 的推荐使用方式。

- **main_fn**：`FnOnce(Arg0DispatchPaths) -> Fut`，接收分发路径信息的异步主函数
- **行为**：先执行 `arg0_dispatch()`，未被分发时构建 Tokio 运行时并执行 `main_fn`

> 源码位置：`src/lib.rs:153-182`

### `prepend_path_entry_for_codex_aliases() -> std::io::Result<Arg0PathEntryGuard>`

创建临时目录、写入符号链接/脚本、修改 PATH。

- **返回值**：包含临时目录和锁文件的 guard，guard 被 drop 时临时目录自动删除
- **前提条件**：必须在多线程生成之前调用（因为修改环境变量非线程安全）

> 源码位置：`src/lib.rs:245-370`

## 接口/类型定义

### `Arg0DispatchPaths`

```rust
pub struct Arg0DispatchPaths {
    pub codex_self_exe: Option<PathBuf>,
    pub codex_linux_sandbox_exe: Option<PathBuf>,
    pub main_execve_wrapper_exe: Option<PathBuf>,
}
```

> 源码位置：`src/lib.rs:21-30`

| 字段 | 类型 | 说明 |
|------|------|------|
| `codex_self_exe` | `Option<PathBuf>` | 当前 Codex 可执行文件的稳定路径，优先于 `std::env::current_exe()`（后者在测试环境下可能指向测试 harness） |
| `codex_linux_sandbox_exe` | `Option<PathBuf>` | `codex-linux-sandbox` 别名路径，仅 Linux 上为 `Some`。子进程通过此路径重新调用沙箱 |
| `main_execve_wrapper_exe` | `Option<PathBuf>` | `codex-execve-wrapper` 别名路径，仅 Unix 上为 `Some` |

### `Arg0PathEntryGuard`

```rust
pub struct Arg0PathEntryGuard {
    _temp_dir: TempDir,
    _lock_file: File,
    paths: Arg0DispatchPaths,
}
```

> 源码位置：`src/lib.rs:33-37`

RAII guard，通过其生命周期维持临时目录和文件锁的存在。当 guard 被 drop 时：
- `TempDir` 自动删除临时目录及其中的符号链接
- `File` 的 drop 释放文件锁，使清理程序可以回收

## 配置项与默认值

| 配置 | 值 | 说明 |
|------|------|------|
| `.env` 路径 | `~/.codex/.env` | 环境变量加载路径 |
| 临时目录根 | `~/.codex/tmp/arg0/` | 符号链接临时目录的父目录 |
| 临时目录前缀 | `codex-arg0` | `tempfile::Builder` 使用的前缀 |
| Tokio 线程栈大小 | 16 MB（`TOKIO_WORKER_STACK_SIZE_BYTES`） | 多线程运行时的工作线程栈大小 |
| 锁文件名 | `.lock` | 每个临时目录中的锁文件名 |
| Unix 目录权限 | `0o700` | `tmp/arg0/` 目录的权限，仅所有者可访问 |

## 边界 Case 与注意事项

- **安全过滤**：`.env` 文件中以 `CODEX_` 为前缀的变量会被**静默忽略**，防止 `.env` 文件覆盖 Codex 内部配置变量（`src/lib.rs:203-229`）

- **线程安全约束**：`load_dotenv()` 和 `prepend_path_entry_for_codex_aliases()` 都会修改进程环境变量（`set_var`），因此**必须在 Tokio 运行时和任何线程创建之前调用**。代码通过 `unsafe` 块显式标注了这一点。

- **Windows 差异**：Windows 不支持符号链接的 argv[0] 技巧，因此使用 `.bat` 批处理脚本配合 `--codex-run-as-apply-patch` 参数来模拟。这意味着 Windows 上的 `codex-linux-sandbox` 和 `codex-execve-wrapper` 不可用（也不需要）。

- **拼写容错**：同时处理 `apply_patch` 和 `applypatch` 两种名称（`src/lib.rs:13-14`），确保子进程使用任一名称都能正确分发。

- **Release 构建保护**：在非 debug 构建中，如果 `~/.codex` 位于系统临时目录下会拒绝创建 helper，防止安全风险（`src/lib.rs:247-259`）。Debug 构建跳过此检查以方便本地测试。

- **TOCTOU 竞态处理**：`janitor_cleanup` 在删除目录时会处理 `NotFound` 错误，因为在检查锁和实际删除之间目录可能已被其他进程清理（`src/lib.rs:393`）。

- **PATH 注入失败不致命**：如果 `prepend_path_entry_for_codex_aliases()` 失败，`arg0_dispatch()` 会打印警告但继续执行，Codex 可能仍能正常工作（`src/lib.rs:121-126`）。