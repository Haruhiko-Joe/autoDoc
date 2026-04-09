# ProcessHardening（进程加固）

## 概述与职责

`codex-process-hardening` 是 Sandbox 安全层中的一个轻量级 Rust crate，提供**进程启动前的安全加固**能力。它的设计意图是在 `main()` 函数执行之前（通过 `#[ctor::ctor]` 属性）完成一系列防御性措施，防止进程被调试器附加、产生核心转储文件、或通过环境变量注入被劫持。

在 Codex 系统架构中，该模块属于 **Sandbox**（安全层）的一部分，与 Linux namespaces/landlock/seccomp、macOS seatbelt 等 OS 级沙箱机制协同工作，构成多层防御体系。目前它被 `responses-api-proxy` 二进制使用——在 `main()` 之前通过 `#[ctor::ctor]` 调用 `pre_main_hardening()`（`codex-rs/responses-api-proxy/src/main.rs:4-7`）。

### 防护目标

| 威胁 | 防护手段 | 适用平台 |
|------|---------|---------|
| 调试器附加 / 内存读取 | `prctl(PR_SET_DUMPABLE, 0)` | Linux/Android |
| 调试器附加 | `ptrace(PT_DENY_ATTACH)` | macOS |
| 核心转储泄露敏感数据 | `setrlimit(RLIMIT_CORE, 0)` | 所有 Unix |
| 动态链接器注入 | 清除 `LD_*` 环境变量 | Linux/Android/FreeBSD/OpenBSD |
| dylib 注入 | 清除 `DYLD_*` 环境变量 | macOS |
| 分配器诊断日志干扰 TUI | 清除 `MallocStackLogging*`、`MallocLogFile*` | macOS |

## 关键流程

### 主入口：`pre_main_hardening()`

这是该 crate 唯一的公开函数。它通过条件编译（`#[cfg]`）分派到各平台的专用实现：

```
pre_main_hardening()
  ├─ Linux/Android → pre_main_hardening_linux()
  ├─ macOS        → pre_main_hardening_macos()
  ├─ FreeBSD/OpenBSD → pre_main_hardening_bsd()
  └─ Windows      → pre_main_hardening_windows()  (当前为空，TODO)
```

> 源码位置：`codex-rs/process-hardening/src/lib.rs:13-26`

### Linux/Android 加固流程

1. **禁用 ptrace 附加**：调用 `prctl(PR_SET_DUMPABLE, 0)`，将进程标记为不可转储。这同时阻止了非 root 用户通过 `ptrace` 附加到进程（`lib.rs:47`）
2. **禁用核心转储**：调用 `set_core_file_size_limit_to_zero()` 作为纵深防御
3. **清除危险环境变量**：移除所有以 `LD_` 为前缀的环境变量（如 `LD_PRELOAD`、`LD_LIBRARY_PATH`），防止动态链接器注入。注释中提到 Codex 官方发布版使用 MUSL 静态链接，`LD_PRELOAD` 本身会被忽略，但此处作为额外保险

> 源码位置：`codex-rs/process-hardening/src/lib.rs:45-62`

### macOS 加固流程

1. **禁止调试器附加**：调用 `ptrace(PT_DENY_ATTACH)`，这是 macOS 特有的 ptrace 请求，阻止任何调试器附加到当前进程（`lib.rs:75`）
2. **禁用核心转储**：同 Linux
3. **清除 DYLD_ 环境变量**：移除所有 `DYLD_*` 变量，防止 macOS 动态链接器被劫持
4. **清除 malloc 诊断变量**：移除 `MallocStackLogging*` 和 `MallocLogFile*`，避免 macOS 分配器诊断输出污染 TUI 界面（修复 issue #11555）

> 源码位置：`codex-rs/process-hardening/src/lib.rs:73-96`

### BSD 加固流程

FreeBSD 和 OpenBSD 采用精简方案：禁用核心转储 + 清除 `LD_*` 环境变量（无特定的反调试系统调用）。

> 源码位置：`codex-rs/process-hardening/src/lib.rs:65-70`

### Windows 加固流程

当前为空实现，标记为 TODO。

> 源码位置：`codex-rs/process-hardening/src/lib.rs:116-118`

## 函数签名

### `pub fn pre_main_hardening()`

主入口函数，设计为在 `main()` 之前通过 `#[ctor::ctor]` 调用。无参数，无返回值。任何加固步骤失败时**直接终止进程**（调用 `std::process::exit`）。

**使用方式**：

```rust
#[ctor::ctor]
fn pre_main() {
    codex_process_hardening::pre_main_hardening();
}
```

## 内部工具函数

### `set_core_file_size_limit_to_zero()`（Unix）

通过 `setrlimit(RLIMIT_CORE, {0, 0})` 将核心转储文件大小的软限制和硬限制均设为 0。失败时以退出码 7 终止进程。

> 源码位置：`codex-rs/process-hardening/src/lib.rs:99-113`

### `remove_env_vars_with_prefix(prefix: &[u8])`（Unix）

遍历当前进程的所有环境变量，移除键名以指定字节前缀开头的变量。底层调用 `env_keys_with_prefix()` 收集匹配的键，然后逐一调用 `std::env::remove_var()`。

> 源码位置：`codex-rs/process-hardening/src/lib.rs:121-127`

### `env_keys_with_prefix<I>(vars: I, prefix: &[u8]) -> Vec<OsString>`（Unix）

纯函数，从环境变量迭代器中筛选出键名以指定前缀开头的条目。使用 `OsStr::as_bytes()` 进行字节级前缀匹配，**正确处理非 UTF-8 的环境变量键名**。

> 源码位置：`codex-rs/process-hardening/src/lib.rs:130-142`

## 错误退出码

所有加固操作失败时会打印错误信息到 stderr 并以特定退出码终止进程：

| 退出码 | 含义 | 平台 |
|--------|------|------|
| 5 | `prctl(PR_SET_DUMPABLE, 0)` 失败 | Linux/Android |
| 6 | `ptrace(PT_DENY_ATTACH)` 失败 | macOS |
| 7 | `setrlimit(RLIMIT_CORE, 0)` 失败 | 所有 Unix |

这些退出码是硬编码常量（`lib.rs:29-42`），方便通过进程退出码快速定位加固失败的具体环节。

## 边界 Case 与注意事项

- **非 UTF-8 环境变量**：`env_keys_with_prefix` 在字节层面进行前缀匹配，能正确处理键名包含非 UTF-8 字节的环境变量。这通过单元测试 `env_keys_with_prefix_handles_non_utf8_entries` 验证（`lib.rs:153-174`）
- **失败即终止**：所有系统调用失败都会导致进程立即退出，而非静默忽略。这是有意为之——如果安全加固无法完成，进程不应继续运行
- **MUSL 静态链接**：官方 Codex 发布版使用 MUSL 链接，`LD_PRELOAD` 等变量本身不生效，清除它们是纵深防御措施
- **`unsafe` 使用**：`remove_var` 在多线程环境中是 unsafe 的（Rust 标准库文档有说明），但由于该函数设计为在 `main()` 之前通过 `ctor` 调用，此时通常只有单线程运行
- **Windows 未实现**：`pre_main_hardening_windows()` 当前为空函数体，Windows 平台暂无实际加固逻辑
- **依赖**：仅依赖 `libc` crate，无其他外部依赖，保持最小攻击面