# Helper Materialization

## 概述与职责

Helper Materialization 模块负责将辅助可执行文件（如 `codex-command-runner.exe`）从安装目录复制到沙箱专用的 `.sandbox-bin` 目录中。这样做的核心目的是让复制后的二进制文件**继承目标目录的 Windows ACL 权限**，而非保留源文件的 ACL——这对沙箱用户能否正确启动这些辅助进程至关重要。

在整体架构中，该模块属于 **Sandbox → WindowsSandbox → SetupOrchestration** 层级，是沙箱 setup 流程的一部分。同级模块包括用户账号创建、防火墙规则配置、凭据加密等 setup 阶段组件。SetupOrchestration 在准备沙箱环境时调用本模块，确保辅助二进制文件就绪。

## 关键流程

### 整体解析路径

模块提供两个主要入口函数，解析逻辑类似：

1. **`resolve_helper_for_launch`**——用于已知类型的辅助可执行文件（如 CommandRunner）
2. **`resolve_current_exe_for_launch`**——用于将当前运行的 exe 自身复制到 sandbox-bin

两者的核心逻辑均为：**尝试复制 → 成功则返回目标路径，失败则回退到旧版路径**。

### 复制流程详解（`copy_helper_if_needed`）

这是模块的核心调用链，以 `resolve_helper_for_launch` 为入口：

1. **查询内存缓存**：以 `"{文件名}|{codex_home路径}"` 为 key 查询 `HELPER_PATH_CACHE`（`OnceLock<Mutex<HashMap>>`）。命中则直接返回缓存路径，跳过文件系统操作（`helper_materialization.rs:124-135`）

2. **定位源文件**：调用 `sibling_source_path()`，在当前可执行文件的同级目录中查找目标辅助文件。找不到则报错（`helper_materialization.rs:180-194`）

3. **新鲜度检测**：调用 `destination_is_fresh()` 比较源文件和目标文件的**文件大小**和**修改时间**。若目标文件的 mtime ≥ 源文件 mtime 且大小相同，判定为"新鲜"，跳过复制（`helper_materialization.rs:267-291`）

4. **原子写入**：
   - 在目标目录（`.sandbox-bin`）内创建 `NamedTempFile`——临时文件创建在目标目录中，因此**自动继承该目录的 ACL**
   - 打开源文件，将内容通过 `std::io::copy` 写入临时文件
   - flush 并 drop 文件句柄
   - 如果目标文件已存在，先删除旧文件
   - 调用 `fs::rename` 将临时文件原子重命名为最终目标路径
   （`helper_materialization.rs:196-265`）

5. **rename 竞争处理**：如果 rename 失败（可能另一个进程抢先完成了复制），再次检查目标文件是否已"新鲜"。若是，视为成功（`helper_materialization.rs:249-264`）

6. **写入缓存**：复制成功后将路径存入内存缓存，后续同 session 内的调用直接命中缓存

### Legacy 回退路径

当复制流程失败时（如权限不足、磁盘满等），`resolve_helper_for_launch` 会调用 `legacy_lookup()` 回退到旧版逻辑：直接在当前 exe 的同级目录中查找辅助文件，找不到则返回裸文件名交由 PATH 解析（`helper_materialization.rs:47-57`）。

## 函数签名与参数说明

### `resolve_helper_for_launch(kind, codex_home, log_dir) -> PathBuf`

主入口，解析已知辅助可执行文件的启动路径。

| 参数 | 类型 | 说明 |
|------|------|------|
| `kind` | `HelperExecutable` | 辅助文件类型枚举 |
| `codex_home` | `&Path` | Codex 主目录路径（如 `~/.codex`） |
| `log_dir` | `Option<&Path>` | 日志输出目录，`None` 则不写日志 |

> 源码位置：`helper_materialization.rs:59-89`

### `resolve_current_exe_for_launch(codex_home, fallback_executable) -> PathBuf`

将当前运行的可执行文件本身复制到 sandbox-bin 目录。公开可见性（`pub`），供 crate 外部调用。

| 参数 | 类型 | 说明 |
|------|------|------|
| `codex_home` | `&Path` | Codex 主目录路径 |
| `fallback_executable` | `&str` | 获取当前 exe 路径失败时的回退名称 |

> 源码位置：`helper_materialization.rs:91-117`

### `copy_helper_if_needed(kind, codex_home, log_dir) -> Result<PathBuf>`

核心复制逻辑，包含缓存查询、新鲜度检测和原子写入。

> 源码位置：`helper_materialization.rs:119-165`

### `helper_bin_dir(codex_home) -> PathBuf`

返回 sandbox-bin 目录路径，委托给 `crate::sandbox_bin_dir()`。

> 源码位置：`helper_materialization.rs:43-45`

### `legacy_lookup(kind) -> PathBuf`

旧版路径查找：先查当前 exe 同级目录，找不到则返回裸文件名。

> 源码位置：`helper_materialization.rs:47-57`

## 接口/类型定义

### `HelperExecutable` 枚举

```rust
pub(crate) enum HelperExecutable {
    CommandRunner,
}
```

目前仅定义了一个变体 `CommandRunner`，对应文件名 `codex-command-runner.exe`。该枚举可扩展以支持更多辅助文件类型。

> 源码位置：`helper_materialization.rs:16-19`

### `CopyOutcome` 枚举（内部）

```rust
enum CopyOutcome {
    Reused,    // 目标文件已是最新，无需复制
    ReCopied,  // 执行了实际复制
}
```

> 源码位置：`helper_materialization.rs:35-39`

## 关键设计决策

### 为什么不直接 `fs::copy`？

Windows 的 `fs::copy` 会保留源文件的安全描述符（ACL）。而沙箱需要辅助二进制文件继承 `.sandbox-bin` 目录的 ACL（该目录已配置了沙箱用户的访问权限）。因此模块采用**先创建临时文件再写入内容**的方式——临时文件在目标目录中创建，自动继承目录 ACL（`helper_materialization.rs:229-230`）。

### 为什么用 OnceLock + Mutex 缓存？

在一个 session 中可能多次调用 `resolve_helper_for_launch`（例如每次执行沙箱命令时）。`OnceLock<Mutex<HashMap>>` 提供了线程安全的懒初始化缓存，避免重复的文件系统元数据查询。缓存 key 包含文件名和 `codex_home` 路径，支持不同 home 目录的隔离。

### rename 失败后的二次检查

多进程并发时，两个进程可能同时尝试复制同一辅助文件。rename 失败后重新检查 `destination_is_fresh()`，如果另一个进程已完成复制，则视为成功而非报错。这是一种简洁的无锁并发容错策略。

## 边界 Case 与注意事项

- **首次运行时目标目录不存在**：`copy_from_source_if_needed` 会调用 `fs::create_dir_all` 自动创建 `.sandbox-bin` 目录及其父目录
- **源文件不在同级目录**：`sibling_source_path` 会报错，触发 legacy 回退
- **缓存 mutex 中毒**：`cached_helper_path` 和 `store_helper_path` 在 `lock()` 失败时静默降级——前者返回 `None`（miss），后者跳过缓存写入。不会导致功能异常，仅失去缓存优化
- **`resolve_current_exe_for_launch` 不使用内存缓存**：与 `copy_helper_if_needed` 不同，该函数每次调用都会走文件系统新鲜度检测（但有 size+mtime 快速跳过）
- **新鲜度判定使用 `>=` 而非 `>`**：目标文件 mtime 等于源文件 mtime 时也判定为新鲜，避免时间戳精度问题导致不必要的重复复制