# 路径与文件系统工具

## 概述与职责

PathAndFilesystem 模块是 Codex 项目 **SharedUtils** 层的基础设施组件，为整个工作空间提供统一的路径处理能力。它由三个独立的 Rust crate 组成：

- **`codex-utils-absolute-path`**：定义 `AbsolutePathBuf` 类型——一个保证绝对且规范化的路径包装器，支持 serde 序列化/反序列化和 `~` 家目录展开
- **`codex-utils-path`**：路径规范化、符号链接解析、原子写入，以及 WSL 环境下大小写不敏感路径的特殊处理
- **`codex-utils-home-dir`**：Codex 配置目录（`~/.codex`）的定位逻辑，支持通过 `CODEX_HOME` 环境变量覆盖

这些 crate 被 Codex 的核心引擎、沙箱、配置系统等上层模块广泛依赖，确保所有路径操作的行为一致。

---

## 关键流程

### AbsolutePathBuf 的构造与解析流程

`AbsolutePathBuf` 的核心目标是：拿到任意路径输入，产出一个**保证绝对、已规范化**的路径（但不保证路径在文件系统上真实存在）。

1. **家目录展开**：调用 `maybe_expand_home_directory()` 检查路径是否以 `~` 开头。如果是 `~` 或 `~/...`，将其替换为用户实际的家目录路径。Windows 上还额外支持 `~\...` 的反斜杠形式（`codex-rs/utils/absolute-path/src/lib.rs:25-41`）
2. **路径绝对化**：根据构造方式不同：
   - `from_absolute_path()`：对已经是绝对路径的输入调用 `absolutize()` 进行规范化
   - `resolve_path_against_base()`：对相对路径调用 `absolutize_from(base)` 基于指定基准目录解析
3. **包装返回**：将规范化后的 `PathBuf` 包装进 `AbsolutePathBuf(PathBuf)` 新类型

### 反序列化中的基准路径注入

`AbsolutePathBuf` 实现了自定义的 `Deserialize`，但反序列化相对路径时需要一个基准目录。这通过线程局部存储（thread-local）和 RAII guard 模式实现：

1. 调用方创建 `AbsolutePathBufGuard::new(base_path)`，将基准路径写入 thread-local 变量 `ABSOLUTE_PATH_BASE`（`codex-rs/utils/absolute-path/src/lib.rs:156-181`）
2. 执行反序列化——`Deserialize` 实现从 thread-local 读取基准路径，调用 `resolve_path_against_base` 解析相对路径
3. guard 被 drop 时自动清除 thread-local 中的基准路径
4. 如果未设置 guard 且路径是相对路径，反序列化直接报错

> **注意**：由于依赖 thread-local，反序列化必须与 guard 创建在同一线程上完成。

### 符号链接解析流程

`resolve_symlink_write_paths()` 负责将可能是符号链接的路径解析到最终的真实文件系统目标（`codex-rs/utils/path-utils/src/lib.rs:32-105`）：

1. 将输入路径先通过 `AbsolutePathBuf::from_absolute_path()` 规范化
2. 进入循环，对当前路径调用 `symlink_metadata()` 检查是否为符号链接
3. 如果不是符号链接（或路径不存在），返回当前路径作为 `read_path` 和 `write_path`
4. 如果是符号链接，调用 `read_link()` 读取目标，处理绝对/相对目标路径
5. 使用 `HashSet<PathBuf>` 追踪已访问路径，检测循环链接
6. 发生循环或任何错误时，返回 `read_path: None`，`write_path` 回退为原始输入路径

### 原子写入流程

`write_atomically()` 确保文件写入的原子性（`codex-rs/utils/path-utils/src/lib.rs:107-119`）：

1. 提取目标路径的父目录，确保其存在（`create_dir_all`）
2. 在同一父目录下创建 `NamedTempFile`（这确保临时文件与目标文件在同一文件系统）
3. 将内容写入临时文件
4. 调用 `persist()` 原子地将临时文件重命名为目标路径

### Codex Home 解析流程

`find_codex_home()` 按以下优先级确定配置目录（`codex-rs/utils/home-dir/src/lib.rs:12-61`）：

1. 检查 `CODEX_HOME` 环境变量——如果设置了且非空：
   - 验证路径存在且为目录（否则报错）
   - 调用 `canonicalize()` 返回规范化后的绝对路径
2. 如果 `CODEX_HOME` 未设置，返回 `~/.codex`（不验证是否存在）

---

## 函数签名与参数说明

### `AbsolutePathBuf`（crate: `codex-utils-absolute-path`）

#### `AbsolutePathBuf::resolve_path_against_base(path, base_path) -> io::Result<Self>`

将路径相对于给定基准目录解析为绝对路径。自动展开 `~` 前缀。

- **path**：任意路径（绝对或相对）
- **base_path**：相对路径的解析基准目录

#### `AbsolutePathBuf::from_absolute_path(path) -> io::Result<Self>`

将已知为绝对的路径规范化为 `AbsolutePathBuf`。仍会展开 `~` 前缀。

#### `AbsolutePathBuf::current_dir() -> io::Result<Self>`

返回当前工作目录的 `AbsolutePathBuf`。

#### `AbsolutePathBuf::relative_to_current_dir(path) -> io::Result<Self>`

将路径相对于进程当前工作目录解析。等价于 `resolve_path_against_base(path, env::current_dir())`。

#### `AbsolutePathBuf::join(path) -> io::Result<Self>`

将子路径拼接到当前路径上，类似 `PathBuf::join`，但保持绝对路径不变式。

#### `AbsolutePathBuf::parent() -> Option<Self>`

返回父路径。包含 `debug_assert!` 确保结果仍为绝对路径。

### `AbsolutePathBufGuard`（crate: `codex-utils-absolute-path`）

#### `AbsolutePathBufGuard::new(base_path: &Path) -> Self`

设置反序列化所需的基准路径。返回的 guard 在 drop 时自动清除。

### 路径工具函数（crate: `codex-utils-path`）

#### `normalize_for_path_comparison(path) -> io::Result<PathBuf>`

先 `canonicalize()` 再进行 WSL 规范化，产出适合路径比较的标准形式。

#### `normalize_for_native_workdir(path) -> PathBuf`

在 Windows 上使用 `dunce::simplified()` 移除 `\\?\` 前缀，其他平台原样返回。

#### `resolve_symlink_write_paths(path: &Path) -> io::Result<SymlinkWritePaths>`

解析符号链接链，返回最终的读写路径。详见上文"符号链接解析流程"。

#### `write_atomically(write_path: &Path, contents: &str) -> io::Result<()>`

通过临时文件+重命名实现原子写入。

### 环境检测函数（crate: `codex-utils-path`，模块 `env`）

#### `env::is_wsl() -> bool`

检测当前是否运行在 WSL 环境中。Linux 上检查 `WSL_DISTRO_NAME` 环境变量或 `/proc/version` 中是否包含 "microsoft"。非 Linux 平台始终返回 `false`。

#### `env::is_headless_environment() -> bool`

判断是否在无 GUI 环境中运行（CI、SSH 会话、缺少 DISPLAY/WAYLAND_DISPLAY），用于前端决定是否尝试打开浏览器等操作。

### Home 目录函数（crate: `codex-utils-home-dir`）

#### `find_codex_home() -> io::Result<PathBuf>`

返回 Codex 配置目录路径。优先使用 `CODEX_HOME` 环境变量，否则默认 `~/.codex`。

---

## 接口/类型定义

### `AbsolutePathBuf`

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, JsonSchema, TS)]
pub struct AbsolutePathBuf(PathBuf);
```

一个新类型包装器，保证内部 `PathBuf` 始终是绝对且规范化的。实现了以下 trait：

| Trait | 说明 |
|-------|------|
| `Deref<Target = Path>` | 可直接当 `&Path` 使用 |
| `AsRef<Path>` | 兼容所有接受 `AsRef<Path>` 的 API |
| `From<AbsolutePathBuf> for PathBuf` | 解包为 `PathBuf` |
| `TryFrom<&Path / PathBuf / &str / String>` | 通过 `from_absolute_path` 构造 |
| `Serialize` / `Deserialize` | serde 支持，反序列化需要 `AbsolutePathBufGuard` |
| `JsonSchema` / `TS` | 自动生成 JSON Schema 和 TypeScript 类型 |

### `SymlinkWritePaths`

```rust
pub struct SymlinkWritePaths {
    pub read_path: Option<PathBuf>,  // 解析后的最终读取路径；None 表示解析失败
    pub write_path: PathBuf,         // 应写入的路径（解析失败时回退到原始路径）
}
```

> 源码位置：`codex-rs/utils/path-utils/src/lib.rs:21-24`

---

## 配置项与默认值

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `CODEX_HOME` | 环境变量 | 未设置 | 自定义 Codex 配置目录。必须指向已存在的目录 |
| 默认配置目录 | — | `~/.codex` | `CODEX_HOME` 未设置时使用 |
| `WSL_DISTRO_NAME` | 环境变量 | — | 用于检测 WSL 环境 |
| `CI` / `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` | 环境变量 | — | 用于检测无头环境 |
| `DISPLAY` / `WAYLAND_DISPLAY` | 环境变量 | — | Linux 上用于判断是否有 GUI |

---

## 边界 Case 与注意事项

- **`AbsolutePathBuf` 不保证路径存在**：它只保证路径是绝对且规范化的（移除了 `.`、`..` 等），但不做文件系统存在性检查。
- **反序列化的线程安全限制**：`AbsolutePathBufGuard` 基于 thread-local 实现，反序列化必须与 guard 在同一线程上发生。跨线程使用将导致缺少基准路径而失败。
- **`CODEX_HOME` 必须指向已存在的目录**：设置了但路径不存在或不是目录会直接返回错误。而默认路径 `~/.codex` 不做存在性检查——这允许在首次运行时延迟创建。
- **WSL 大小写处理**：在 WSL 环境中，`/mnt/<drive>/...` 路径（即 Windows 驱动器挂载）会被全部转为小写，因为 Windows 文件系统不区分大小写。非驱动器路径（如 `/home/...`）不受影响。
- **符号链接循环检测**：`resolve_symlink_write_paths` 使用 `HashSet` 检测循环而非固定深度限制，能正确处理任意长度的合法链。循环或错误时安全回退，不会 panic。
- **原子写入要求同一文件系统**：`write_atomically` 在目标路径的父目录创建临时文件，确保 `rename` 操作可以原子完成（跨文件系统 rename 会失败）。
- **Windows 路径简化**：`normalize_for_native_workdir` 在 Windows 上使用 `dunce` 移除 `\\?\` 前缀，使路径更易读且兼容更多工具。