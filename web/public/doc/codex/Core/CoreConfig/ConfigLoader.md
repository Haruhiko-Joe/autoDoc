# ConfigLoader

## 概述与职责

ConfigLoader 是 Codex 配置系统的核心加载模块，负责从文件系统中读取多层级的 TOML 配置文件，按优先级合并为统一的 `ConfigLayerStack`，供系统其他模块使用。它位于 **Core → CoreConfig** 层级下，是整个 Codex 应用获取运行时配置的基础设施。

在 Codex 架构中，几乎所有子系统（SessionEngine、ToolsOrchestration、Sandbox、ModelProviders 等）都依赖 CoreConfig 读取配置，而 ConfigLoader 正是 CoreConfig 的数据来源——它决定了"配置从哪里读、怎么合并、谁的优先级更高"。

该模块由三个源文件组成：
- `mod.rs`：主逻辑，层级加载、合并、信任判定
- `layer_io.rs`：底层文件 I/O 和 managed config 读取
- `macos.rs`：macOS MDM（移动设备管理）配置文件读取

## 关键流程

### 配置层级栈的构建

入口函数 `load_config_layers_state()` 是整个模块的核心（`codex-rs/core/src/config_loader/mod.rs:118-311`）。它按以下顺序构建配置层级栈，**后加入的层优先级更高**：

#### 第一阶段：加载 Requirements（管理员约束）

Requirements 是管理员强制的配置约束（如只允许特定的 `approval_policy` 或 `sandbox_mode`），**先设定的字段不可被后续层覆盖**：

1. **Cloud Requirements**：从云端获取的托管要求（最高优先级）
2. **MDM Managed Preferences**（仅 macOS）：通过 macOS 配置描述文件下发的约束
3. **System requirements.toml**：Unix 下为 `/etc/codex/requirements.toml`，Windows 下为 `%ProgramData%\OpenAI\Codex\requirements.toml`
4. **Legacy managed_config.toml 回退**：为向后兼容，从旧格式 `managed_config.toml` 中提取约束并映射为 requirements 格式

#### 第二阶段：构建配置层列表

按优先级从低到高依次加入：

1. **System 层**：`/etc/codex/config.toml`（Unix）或 `%ProgramData%\OpenAI\Codex\config.toml`（Windows）
2. **User 层**：`$CODEX_HOME/config.toml`
3. **Project 层**（需要 `cwd`）：从 `cwd` 向上遍历到项目根目录，收集每个 `.codex/config.toml`，按从项目根到 `cwd` 的顺序排列（越靠近 `cwd` 优先级越高）。未受信任的目录中的配置会被标记为 disabled
4. **Runtime 层**：CLI `--config` 标志或 UI 中的运行时选择
5. **Legacy Managed Config 层**：`managed_config.toml` 文件内容和 MDM 配置作为最高优先级覆盖层

最后调用 `ConfigLayerStack::new()` 将所有层和 requirements 组装为最终的配置栈。

### 项目信任判定流程

项目层的配置是否生效，取决于信任判定机制（`codex-rs/core/src/config_loader/mod.rs:536-612`）：

1. `project_trust_context()` 根据已合并的 system+user 配置，解析出用户定义的 `projects` 信任映射表
2. 通过 `find_project_root()` 从 `cwd` 向上查找项目根标记文件（如 `.git`、`package.json` 等）
3. 对每个项目目录调用 `decision_for_dir()` 查询信任级别，查找顺序为：
   - 该目录自身的 trust key
   - 项目根目录的 trust key
   - Git 仓库根目录的 trust key
4. 只有 `TrustLevel::Trusted` 的目录，其 `config.toml` 才会生效；其他情况下配置层被标记为 disabled 并附带原因说明

### 相对路径解析

`resolve_relative_paths_in_config_toml()`（`codex-rs/core/src/config_loader/mod.rs:688-711`）确保不同目录下加载的配置可以正确合并：

1. 设置 `AbsolutePathBufGuard` 将当前上下文切换到配置文件所在目录
2. 通过序列化/反序列化 round-trip 将 `toml::Value` 转为 `ConfigToml` 结构体（期间 `AbsolutePathBuf` 字段自动解析相对路径）
3. 用 `copy_shape_from_original()` 将解析后的值与原始值合并，保留原始 TOML 中 `ConfigToml` 不识别的额外字段

## 函数签名与参数说明

### `load_config_layers_state()`

```rust
pub async fn load_config_layers_state(
    codex_home: &Path,
    cwd: Option<AbsolutePathBuf>,
    cli_overrides: &[(String, TomlValue)],
    overrides: LoaderOverrides,
    cloud_requirements: CloudRequirementsLoader,
) -> io::Result<ConfigLayerStack>
```

模块的主入口，构建完整的配置层级栈。

| 参数 | 说明 |
|------|------|
| `codex_home` | Codex 主目录路径，用户级配置存放于此 |
| `cwd` | 当前工作目录，`Some` 时加载项目级配置，`None` 用于非线程绑定的场景（如 app-server 的 `/config` 端点） |
| `cli_overrides` | CLI `--config` 标志传入的键值对覆盖 |
| `overrides` | 测试和平台特定的路径覆盖（如自定义 managed config 路径、macOS MDM base64 数据） |
| `cloud_requirements` | 云端 requirements 的加载器 |

> 源码位置：`codex-rs/core/src/config_loader/mod.rs:118-311`

### `read_config_from_path()`

```rust
pub(super) async fn read_config_from_path(
    path: impl AsRef<Path>,
    log_missing_as_info: bool,
) -> io::Result<Option<TomlValue>>
```

从文件系统读取并解析 TOML 文件。文件不存在返回 `Ok(None)`，解析错误返回带有详细位置信息的 `ConfigError`。

> 源码位置：`codex-rs/core/src/config_loader/layer_io.rs:91-121`

### `project_trust_key()`

```rust
pub fn project_trust_key(project_path: &Path) -> String
```

将路径规范化为信任映射的 key。使用 `dunce::canonicalize` 去除 Windows UNC 前缀，确保指向同一位置的不同路径产生相同的 key。

> 源码位置：`codex-rs/core/src/config_loader/mod.rs:675-680`

### `first_layer_config_error()`

```rust
pub(crate) async fn first_layer_config_error(
    layers: &ConfigLayerStack,
) -> Option<ConfigError>
```

扫描配置层栈，返回第一个包含 TOML 解析错误的层的 `ConfigError`（带文件路径、行列号等信息），用于向用户呈现友好的错误提示。

> 源码位置：`codex-rs/core/src/config_loader/mod.rs:76-78`

## 接口/类型定义

### `LoadedConfigLayers`

```rust
struct LoadedConfigLayers {
    managed_config: Option<MangedConfigFromFile>,
    managed_config_from_mdm: Option<ManagedConfigFromMdm>,
}
```

底层 I/O 层的返回值，分别承载文件系统读取的 managed config 和 macOS MDM 读取的配置。

> 源码位置：`codex-rs/core/src/config_loader/layer_io.rs:30-36`

### `ProjectTrustContext`

```rust
struct ProjectTrustContext {
    project_root: AbsolutePathBuf,
    project_root_key: String,
    repo_root_key: Option<String>,
    projects_trust: HashMap<String, TrustLevel>,
    user_config_file: AbsolutePathBuf,
}
```

项目信任判定的上下文对象，缓存了项目根路径、Git 仓库根路径、以及用户定义的信任映射表。

> 源码位置：`codex-rs/core/src/config_loader/mod.rs:536-542`

### `LegacyManagedConfigToml`

```rust
struct LegacyManagedConfigToml {
    approval_policy: Option<AskForApproval>,
    sandbox_mode: Option<SandboxMode>,
}
```

旧版 `managed_config.toml` 的结构体。通过 `impl From<LegacyManagedConfigToml> for ConfigRequirementsToml` 映射为新版 requirements 格式。转换时自动补充 `ReadOnly` sandbox mode 以确保基本功能可用（`codex-rs/core/src/config_loader/mod.rs:886-909`）。

## 配置项与默认值

### 系统配置文件路径

| 平台 | config.toml | requirements.toml | managed_config.toml |
|------|-------------|-------------------|---------------------|
| Unix | `/etc/codex/config.toml` | `/etc/codex/requirements.toml` | `/etc/codex/managed_config.toml` |
| Windows | `%ProgramData%\OpenAI\Codex\config.toml` | `%ProgramData%\OpenAI\Codex\requirements.toml` | `$CODEX_HOME\managed_config.toml` |
| macOS MDM | — | 通过 `com.openai.codex` domain 的 `requirements_toml_base64` key | 通过 `config_toml_base64` key |

### macOS MDM 配置

- **Application ID**：`com.openai.codex`
- **Config Key**：`config_toml_base64`（base64 编码的 TOML 配置）
- **Requirements Key**：`requirements_toml_base64`（base64 编码的 requirements TOML）

通过 macOS `CFPreferencesCopyAppValue` API 读取，支持通过 MDM 配置描述文件（如 Jamf、Kandji 等）统一部署企业策略。

> 源码位置：`codex-rs/core/src/config_loader/macos.rs:14-16`

### Windows ProgramData 解析

在 Windows 上，通过 `SHGetKnownFolderPath(FOLDERID_ProgramData)` 获取 ProgramData 目录。若调用失败，回退到硬编码的 `C:\ProgramData`。

> 源码位置：`codex-rs/core/src/config_loader/mod.rs:446-492`

## 边界 Case 与注意事项

- **配置文件缺失不是错误**：任何层级的配置文件不存在时，对应层使用空 table，不会中断加载流程。但文件存在而 TOML 格式错误则会返回带行号、列号的详细错误。

- **信任未设定时配置被禁用**：项目级 `.codex/config.toml` 默认处于 disabled 状态，只有在用户的 `$CODEX_HOME/config.toml` 中将项目标记为 `trusted` 后才会生效。disabled 的层仍被加载（用于 UI 展示），但不参与合并。

- **跳过 CODEX_HOME 下的 .codex 目录**：在遍历项目层时，如果 `.codex` 目录恰好就是 `$CODEX_HOME`，会被跳过以避免将 user 层配置重复计入项目层（`codex-rs/core/src/config_loader/mod.rs:807-809`）。

- **相对路径解析保留未知字段**：`resolve_relative_paths_in_config_toml()` 使用 round-trip 序列化来解析路径，但 `ConfigToml` 不识别的字段会在 round-trip 中丢失。`copy_shape_from_original()` 通过逐字段对比原始值和解析值来恢复这些丢失字段（`codex-rs/core/src/config_loader/mod.rs:717-740`）。

- **Legacy 兼容的 sandbox_mode 处理**：从旧版 `managed_config.toml` 转换 `sandbox_mode` 到 requirements 时，始终追加 `ReadOnly` 到允许列表中，因为只读模式是 Codex 正常运行的基本要求（`codex-rs/core/src/config_loader/mod.rs:899-905`）。

- **macOS MDM 读取在阻塞线程执行**：`CFPreferencesCopyAppValue` 是同步的 CoreFoundation 调用，通过 `tokio::task::spawn_blocking` 在专用线程中执行以避免阻塞 async 运行时（`codex-rs/core/src/config_loader/macos.rs:43`）。

- **MDM 配置中的路径解析**：MDM 配置一般不应包含以 `./` 开头的相对路径，但支持 `~/` 形式的路径。路径解析以 `codex_home` 为 base_dir（`codex-rs/core/src/config_loader/mod.rs:294-298`）。