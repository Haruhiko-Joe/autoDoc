# ConfigEditingService — 配置读写 API

## 概述与职责

ConfigEditingService 是 Codex 配置系统的读写层，位于 **Core → CoreConfig** 模块层级下。它由两个紧密协作的子模块组成：

- **edit 模块**（`codex-rs/core/src/config/edit.rs`）：定义离散的配置变更操作（`ConfigEdit` 枚举），并通过 `toml_edit` 库将这些变更应用到 TOML 文件中，实现**无损往返编辑**——即保留注释、格式和键序。
- **service 模块**（`codex-rs/core/src/config/service.rs`）：为 app-server 提供高层 API——配置读取（含 override 追踪）、单次/批量写入、层级元数据查询，以及 JSON 与 TOML 之间的转换。

在整体架构中，Config 模块是几乎所有子系统（SessionEngine、ToolSystem、Sandbox、ModelProviders 等）的依赖项。ConfigEditingService 则是 Config 内部负责**持久化变更**的核心组件，被 TUI、AppServer 和 CLI 调用来修改用户配置。同级模块包括 Protocol（共享类型定义）、PluginsAndSkills（扩展层）、StatePersistence（SQLite 持久化）等。

---

## 关键流程

### 1. edit 模块：低层 TOML 变更引擎

#### 变更应用流程（apply_blocking）

1. 解析 `codex_home/config.toml` 的路径，调用 `resolve_symlink_write_paths()` 处理符号链接——支持链式符号链接穿透写入，循环链接时回退到直接覆盖（`codex-rs/core/src/config/edit.rs:774-826`）
2. 读取现有配置文件内容，解析为 `toml_edit::DocumentMut`（保留格式信息的 AST）
3. 检测当前活跃 profile：如果文档中存在 `profile = "xxx"`，后续 profile 作用域的写入会自动路由到 `profiles.<name>` 子表
4. 构造 `ConfigDocument` 包装器，逐个应用 `ConfigEdit` 列表
5. 如果有任何实际变更（`mutated == true`），通过 `write_atomically()` 原子写入文件

#### Profile 作用域路由

`ConfigDocument::scoped_segments()` 方法实现了关键的作用域路由逻辑（`codex-rs/core/src/config/edit.rs:628-646`）：

- 当 `scope == Scope::Profile` 且存在活跃 profile 时，路径段 `["model"]` 会被自动展开为 `["profiles", "<profile_name>", "model"]`
- 当 `scope == Scope::Global` 时，路径段保持不变，直接写入根层级

#### 格式保留机制

`ConfigDocument::preserve_decor()` 递归复制现有节点的装饰信息（空白、注释）到替换节点上（`codex-rs/core/src/config/edit.rs:703-732`），确保编辑操作不会破坏用户手写的注释和格式。对于 inline table 格式的 MCP server 配置，`merge_inline_table()` 在合并键值时同样保留 decor。

### 2. service 模块：高层配置服务

#### 配置读取流程（ConfigService::read）

1. 根据是否传入 `cwd` 决定加载策略：有 cwd 时加载完整层级（含项目级 `.codex/` 配置），无 cwd 时加载"线程无关"配置（`codex-rs/core/src/config/service.rs:143-195`）
2. 调用 `ConfigLayerStack::effective_config()` 计算合并后的有效配置
3. 反序列化为 `ConfigToml` 类型进行验证，再转换为 JSON 格式的 `ApiConfig`
4. 返回 `ConfigReadResponse`，包含有效配置、各字段来源（origins）映射、以及可选的完整层级列表

#### 配置写入流程（ConfigService::apply_edits）

这是最复杂的流程，包含完整的安全校验链（`codex-rs/core/src/config/service.rs:251-410`）：

1. **路径校验**：只允许写入用户配置文件（`codex_home/config.toml`），拒绝写入其他层级
2. **版本冲突检测**：如果传入 `expected_version`，与当前用户层版本比对，不一致则返回 `ConfigVersionConflict` 错误——实现乐观并发控制
3. **值解析与合并**：将 JSON 值转为 TOML 值，根据 `MergeStrategy`（Replace 或 Upsert）执行合并
4. **差异计算**：比较变更前后的值，只生成实际变化的 `ConfigEdit` 列表
5. **双重验证**：
   - 验证用户层配置本身的合法性（即使被上层覆盖，用户值本身也不能非法）
   - 验证 feature requirements 约束（如云端要求某 feature 必须启用）
   - 验证合并后的有效配置合法性
6. **持久化**：通过 `ConfigEditsBuilder` 写入文件
7. **Override 检测**：检查写入的值是否被更高优先级层（如 managed config、MDM）覆盖，如果是则返回 `WriteStatus::OkOverridden` 并附带覆盖元数据

---

## 函数签名与参数说明

### edit 模块公开 API

#### apply_blocking

```rust
pub fn apply_blocking(
    codex_home: &Path,
    profile: Option<&str>,
    edits: &[ConfigEdit],
) -> anyhow::Result<()>
```

同步应用配置变更。读取现有 TOML 文件，应用 edits 列表，原子写回。

- **codex_home**：Codex 主目录路径，`config.toml` 位于该目录下
- **profile**：显式指定 profile 名称；若为 `None` 则从文件中读取 `profile` 字段
- **edits**：要应用的配置变更列表；空列表时直接返回，不创建文件

> 源码位置：`codex-rs/core/src/config/edit.rs:774-826`

#### apply（异步版本）

```rust
pub async fn apply(
    codex_home: &Path,
    profile: Option<&str>,
    edits: Vec<ConfigEdit>,
) -> anyhow::Result<()>
```

异步版本，通过 `tokio::task::spawn_blocking` 将阻塞写操作卸载到线程池。

> 源码位置：`codex-rs/core/src/config/edit.rs:829-839`

#### syntax_theme_edit

```rust
pub fn syntax_theme_edit(name: &str) -> ConfigEdit
```

构造一个设置 `[tui].theme` 的编辑操作。

> 源码位置：`codex-rs/core/src/config/edit.rs:73-78`

#### status_line_items_edit

```rust
pub fn status_line_items_edit(items: &[String]) -> ConfigEdit
```

构造设置 `[tui].status_line` 数组的编辑操作。空数组也会写入（区分"隐藏状态栏"和"使用默认值"）。

> 源码位置：`codex-rs/core/src/config/edit.rs:84-91`

#### model_availability_nux_count_edits

```rust
pub fn model_availability_nux_count_edits(shown_count: &HashMap<String, u32>) -> Vec<ConfigEdit>
```

生成一组编辑操作：先清除 `tui.model_availability_nux` 再按模型写入展示计数。

> 源码位置：`codex-rs/core/src/config/edit.rs:106-125`

### service 模块公开 API

#### ConfigService::new

```rust
pub fn new(
    codex_home: PathBuf,
    cli_overrides: Vec<(String, TomlValue)>,
    loader_overrides: LoaderOverrides,
    cloud_requirements: CloudRequirementsLoader,
) -> Self
```

完整构造函数。

- **codex_home**：Codex 主目录
- **cli_overrides**：命令行传入的配置覆盖
- **loader_overrides**：managed config 路径和 MDM 偏好设置
- **cloud_requirements**：云端配置要求的加载器

> 源码位置：`codex-rs/core/src/config/service.rs:120-132`

#### ConfigService::new_with_defaults

```rust
pub fn new_with_defaults(codex_home: PathBuf) -> Self
```

简化构造函数，CLI overrides 为空，使用默认 loader 和 requirements。

> 源码位置：`codex-rs/core/src/config/service.rs:134-141`

#### ConfigService::read

```rust
pub async fn read(
    &self,
    params: ConfigReadParams,
) -> Result<ConfigReadResponse, ConfigServiceError>
```

读取有效配置。`params.cwd` 控制是否加载项目级配置，`params.include_layers` 控制是否返回层级详情。

> 源码位置：`codex-rs/core/src/config/service.rs:143-195`

#### ConfigService::write_value

```rust
pub async fn write_value(
    &self,
    params: ConfigValueWriteParams,
) -> Result<ConfigWriteResponse, ConfigServiceError>
```

写入单个配置值。内部委托给 `apply_edits`。

> 源码位置：`codex-rs/core/src/config/service.rs:213-220`

#### ConfigService::batch_write

```rust
pub async fn batch_write(
    &self,
    params: ConfigBatchWriteParams,
) -> Result<ConfigWriteResponse, ConfigServiceError>
```

批量写入多个配置值，所有变更原子应用。

> 源码位置：`codex-rs/core/src/config/service.rs:222-234`

#### ConfigService::read_requirements

```rust
pub async fn read_requirements(
    &self,
) -> Result<Option<ConfigRequirementsToml>, ConfigServiceError>
```

读取云端下发的配置要求。返回 `None` 表示无要求。

> 源码位置：`codex-rs/core/src/config/service.rs:197-211`

#### ConfigService::load_user_saved_config

```rust
pub async fn load_user_saved_config(
    &self,
) -> Result<codex_app_server_protocol::UserSavedConfig, ConfigServiceError>
```

加载用户持久化的配置，转换为 `UserSavedConfig` 协议类型。

> 源码位置：`codex-rs/core/src/config/service.rs:236-249`

---

## 接口/类型定义

### ConfigEdit 枚举

定义了所有支持的离散配置变更类型（`codex-rs/core/src/config/edit.rs:26-64`）：

| 变体 | 说明 |
|------|------|
| `SetModel { model, effort }` | 设置模型和推理强度 |
| `SetServiceTier { service_tier }` | 设置服务等级 |
| `SetModelPersonality { personality }` | 设置模型人格 |
| `SetNoticeHideFullAccessWarning(bool)` | 切换全权限警告确认标志 |
| `SetNoticeHideWorldWritableWarning(bool)` | 切换 Windows 目录可写警告标志 |
| `SetNoticeHideRateLimitModelNudge(bool)` | 切换限速模型提示标志 |
| `SetNoticeHideModelMigrationPrompt(String, bool)` | 切换模型迁移提示标志 |
| `RecordModelMigrationSeen { from, to }` | 记录已展示的模型迁移映射 |
| `SetWindowsWslSetupAcknowledged(bool)` | 切换 Windows WSL 设置确认 |
| `ReplaceMcpServers(BTreeMap)` | 替换整个 MCP servers 表 |
| `SetSkillConfig { path, enabled }` | 按路径设置 skill 配置 |
| `SetSkillConfigByName { name, enabled }` | 按名称设置 skill 配置 |
| `SetProjectTrustLevel { path, level }` | 设置项目信任级别 |
| `SetPath { segments, value }` | 按点分路径设置任意值 |
| `ClearPath { segments }` | 按点分路径删除值 |

### ConfigEditsBuilder

流式构建器，用于批量组装和原子应用配置变更（`codex-rs/core/src/config/edit.rs:842-1063`）。支持链式调用：

```rust
ConfigEditsBuilder::new(codex_home)
    .with_profile(Some("team"))
    .set_model(Some("o4-mini"), Some(ReasoningEffort::Low))
    .set_hide_full_access_warning(true)
    .replace_mcp_servers(&servers)
    .set_feature_enabled("personality", true)
    .apply_blocking()?;
```

主要方法：

| 方法 | 说明 |
|------|------|
| `new(codex_home)` | 创建构建器 |
| `with_profile(profile)` | 设置目标 profile |
| `set_model(model, effort)` | 追加模型变更 |
| `set_service_tier(tier)` | 追加服务等级变更 |
| `set_personality(personality)` | 追加人格变更 |
| `set_hide_full_access_warning(bool)` | 追加警告确认变更 |
| `replace_mcp_servers(servers)` | 追加 MCP servers 替换 |
| `set_feature_enabled(key, enabled)` | 追加 feature flag 变更 |
| `set_project_trust_level(path, level)` | 追加项目信任级别变更 |
| `set_windows_sandbox_mode(mode)` | 追加 Windows 沙箱模式变更 |
| `set_realtime_microphone(mic)` | 追加麦克风设备变更 |
| `set_realtime_speaker(speaker)` | 追加扬声器设备变更 |
| `with_edits(edits)` | 追加自定义编辑列表 |
| `apply_blocking()` | 同步应用所有变更 |
| `apply()` | 异步应用所有变更 |

### ConfigServiceError

Service 层的错误类型（`codex-rs/core/src/config/service.rs:42-109`），包含以下变体：

| 变体 | 说明 |
|------|------|
| `Write { code, message }` | 业务写入错误，附带 `ConfigWriteErrorCode` |
| `Io { context, source }` | I/O 错误 |
| `Json { context, source }` | JSON 序列化/反序列化错误 |
| `Toml { context, source }` | TOML 解析错误 |
| `Anyhow { context, source }` | 通用错误（如持久化 task panic） |

`ConfigWriteErrorCode` 枚举值包括：`ConfigLayerReadonly`（尝试写非用户层）、`ConfigVersionConflict`（乐观锁冲突）、`ConfigValidationError`（值验证失败）、`ConfigPathNotFound`（路径不存在）、`UserLayerNotFound`。

### ConfigService 结构体

```rust
pub struct ConfigService {
    codex_home: PathBuf,
    cli_overrides: Vec<(String, TomlValue)>,
    loader_overrides: LoaderOverrides,
    cloud_requirements: CloudRequirementsLoader,
}
```

> 源码位置：`codex-rs/core/src/config/service.rs:111-117`

---

## 配置项与默认值

ConfigService 本身不直接定义配置项，而是读写 `config.toml` 中的各种键。以下是 edit 模块支持的主要配置路径：

| 路径 | 类型 | 说明 |
|------|------|------|
| `model` | string | 活跃模型标识 |
| `model_reasoning_effort` | string | 推理强度（high/low/minimal 等） |
| `service_tier` | string | 服务等级 |
| `personality` | string | 模型人格 |
| `profile` | string | 活跃 profile 名称 |
| `profiles.<name>.*` | table | Profile 作用域配置 |
| `notice.hide_full_access_warning` | bool | 全权限警告确认 |
| `notice.hide_world_writable_warning` | bool | Windows 可写目录警告确认 |
| `notice.hide_rate_limit_model_nudge` | bool | 限速提示确认 |
| `notice.model_migrations.<from>` | string | 模型迁移记录 |
| `mcp_servers.<name>` | table | MCP 服务器配置 |
| `skills.config` | array of tables | Skill 配置覆盖 |
| `projects.<path>.trust_level` | string | 项目信任级别 |
| `features.<key>` | bool | Feature flag |
| `tui.theme` | string | 语法高亮主题 |
| `tui.status_line` | array | 状态栏项目列表 |
| `tui.terminal_title` | array | 终端标题项目列表 |
| `tui.notifications` | bool | 通知开关 |
| `tui.model_availability_nux.<slug>` | integer | 模型可用性引导展示计数 |
| `audio.microphone` | string | 实时音频麦克风设备 |
| `audio.speaker` | string | 实时音频扬声器设备 |
| `windows.sandbox` | string | Windows 沙箱模式 |
| `windows_wsl_setup_acknowledged` | bool | Windows WSL 设置确认 |

---

## MergeStrategy 行为

Service 的 `apply_edits` 支持两种合并策略（通过 `apply_merge` 函数实现，`codex-rs/core/src/config/service.rs:498-553`）：

- **Replace**：直接替换目标路径的值，无论原值类型
- **Upsert**：当目标值和新值都是 table 时，执行深度合并（`merge_toml_values`）——保留新值中未出现的旧键。当任一方不是 table 时，行为退化为 Replace

测试用例 `upsert_merges_tables_replace_overwrites`（`codex-rs/core/src/config/service_tests.rs:674-758`）清晰展示了二者区别：Upsert 保留了 `env_http_headers.existing` 键，而 Replace 将其丢弃。

---

## 边界 Case 与注意事项

- **只允许写用户层**：`apply_edits` 通过路径比对（`paths_match`，`codex-rs/core/src/config/service.rs:622-631`）强制只允许写入 `codex_home/config.toml`，尝试写入 managed 或 project 配置会返回 `ConfigLayerReadonly` 错误
- **乐观并发控制**：传入 `expected_version` 时，如果配置文件在上次读取后被修改，会返回 `ConfigVersionConflict`，客户端需重新获取最新版本（测试 `version_conflict_rejected`，`codex-rs/core/src/config/service_tests.rs:349-371`）
- **用户值独立验证**：即使用户写入的值会被 managed config 覆盖，该值本身也必须合法（测试 `invalid_user_value_rejected_even_if_overridden_by_managed`，`codex-rs/core/src/config/service_tests.rs:397-435`）
- **Feature requirements 约束**：云端可以下发 feature requirements（如强制启用某 feature），用户尝试写入违反约束的值会被拒绝（测试 `write_value_rejects_feature_requirement_conflict`，`codex-rs/core/src/config/service_tests.rs:465-514`）
- **保留内置 provider ID**：尝试覆盖保留的内置 provider ID（如 `openai`）会被拒绝（测试 `reserved_builtin_provider_override_rejected`，`codex-rs/core/src/config/service_tests.rs:437-463`）
- **符号链接处理**：写入时解析符号链接链找到最终目标文件进行写入，保持链接结构不变；循环链接时回退到覆盖原始路径（测试 `blocking_set_model_writes_through_symlink_chain` 和 `blocking_set_model_replaces_symlink_on_cycle`，`codex-rs/core/src/config/edit_tests.rs:183-246`）
- **空编辑幂等**：`apply_blocking` 在 edits 为空或无实际变更时不会创建/修改文件（测试 `blocking_clear_path_noop_when_missing`，`codex-rs/core/src/config/edit_tests.rs:906-924`）
- **Inline table 迁移**：当用户配置中使用 inline table（如 `profiles = { fast = {...} }`）时，写入会自动将其转换为 explicit table 格式，同时保留所有已有键值（测试 `blocking_set_model_preserves_inline_table_contents`，`codex-rs/core/src/config/edit_tests.rs:136-181`）
- **Skill 配置语义**：禁用 skill 时写入 `enabled = false` 条目；重新启用时**删除**该条目（而非写入 `enabled = true`），因为默认即为启用（测试 `set_skill_config_removes_entry_when_enabled`，`codex-rs/core/src/config/edit_tests.rs:90-113`）
- **Feature flag 清除语义**：对于默认关闭的 feature，禁用操作会清除该键而不是写入 `false`，避免在 feature 全局毕业后仍被 pin 住（`codex-rs/core/src/config/edit.rs:953-978`）
- **注释保留**：MCP server 表的编辑保留 inline 注释前缀和后缀（测试 `blocking_replace_mcp_servers_preserves_inline_comments` 系列，`codex-rs/core/src/config/edit_tests.rs:702-904`）
- **Override 通知**：写入成功但被高优先级层覆盖时，响应状态为 `OkOverridden` 并携带覆盖层信息（测试 `write_value_reports_managed_override`，`codex-rs/core/src/config/service_tests.rs:632-671`）

---

## 关键代码片段

### ConfigEdit 枚举定义

```rust
pub enum ConfigEdit {
    SetModel { model: Option<String>, effort: Option<ReasoningEffort> },
    SetServiceTier { service_tier: Option<ServiceTier> },
    ReplaceMcpServers(BTreeMap<String, McpServerConfig>),
    SetPath { segments: Vec<String>, value: TomlItem },
    ClearPath { segments: Vec<String> },
    // ... 更多变体
}
```

> 源码位置：`codex-rs/core/src/config/edit.rs:26-64`

### Profile 作用域路由

```rust
fn scoped_segments(&self, scope: Scope, segments: &[&str]) -> Vec<String> {
    let resolved: Vec<String> = segments.iter().map(|s| (*s).to_string()).collect();
    if matches!(scope, Scope::Profile)
        && resolved.first().is_none_or(|s| s != "profiles")
        && let Some(profile) = self.profile.as_deref()
    {
        let mut scoped = Vec::with_capacity(resolved.len() + 2);
        scoped.push("profiles".to_string());
        scoped.push(profile.to_string());
        scoped.extend(resolved);
        return scoped;
    }
    resolved
}
```

> 源码位置：`codex-rs/core/src/config/edit.rs:628-646`

### Service 写入路径校验与版本冲突检测

```rust
if !paths_match(&allowed_path, &provided_path) {
    return Err(ConfigServiceError::write(
        ConfigWriteErrorCode::ConfigLayerReadonly,
        "Only writes to the user config are allowed",
    ));
}
// ...
if let Some(expected) = expected_version.as_deref()
    && expected != user_layer.version
{
    return Err(ConfigServiceError::write(
        ConfigWriteErrorCode::ConfigVersionConflict,
        "Configuration was modified since last read. Fetch latest version and retry.",
    ));
}
```

> 源码位置：`codex-rs/core/src/config/service.rs:266-289`

### ConfigEditsBuilder 流式构建与应用

```rust
pub struct ConfigEditsBuilder {
    codex_home: PathBuf,
    profile: Option<String>,
    edits: Vec<ConfigEdit>,
}

impl ConfigEditsBuilder {
    pub fn new(codex_home: &Path) -> Self { /* ... */ }
    pub fn set_model(mut self, model: Option<&str>, effort: Option<ReasoningEffort>) -> Self { /* ... */ }
    pub fn apply_blocking(self) -> anyhow::Result<()> {
        apply_blocking(&self.codex_home, self.profile.as_deref(), &self.edits)
    }
    pub async fn apply(self) -> anyhow::Result<()> {
        task::spawn_blocking(move || {
            apply_blocking(&self.codex_home, self.profile.as_deref(), &self.edits)
        }).await.context("config persistence task panicked")?
    }
}
```

> 源码位置：`codex-rs/core/src/config/edit.rs:842-1063`