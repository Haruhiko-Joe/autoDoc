# Plugin — 插件身份与能力元数据

## 概述与职责

`codex-plugin` 是 Codex 配置与可扩展层（Config）中的一个基础 crate，负责定义**插件的身份标识、加载结果和能力摘要**。它不执行实际的插件加载逻辑，而是提供所有 crate 共享的类型定义和验证规则，使得上层模块（如 Core、ToolSystem）能以统一的方式引用插件、汇总插件能力、以及为遥测系统生成插件元数据。

在整体架构中，`codex-plugin` 位于 **Config** 子树下，与配置文件管理、feature flag、lifecycle hook 等模块并列。它被 Core、ToolSystem、Observability 等多个上层模块依赖，是插件系统的"共享词汇表"。

## 模块结构

该 crate 由以下源文件组成：

| 文件 | 职责 |
|------|------|
| `src/lib.rs` | 公开 API 入口，定义 `AppConnectorId`、`PluginCapabilitySummary`、`PluginTelemetryMetadata`，并从子模块和 `codex-utils-plugins` 统一 re-export |
| `src/plugin_id.rs` | `PluginId` 类型定义与解析/验证逻辑 |
| `src/load_outcome.rs` | `LoadedPlugin`、`PluginLoadOutcome`、`EffectiveSkillRoots` trait 及能力摘要生成 |

此外，crate 还从依赖项 `codex-utils-plugins` re-export 了以下内容：
- `PLUGIN_MANIFEST_PATH` — 插件清单文件的相对路径常量
- `plugin_namespace_for_skill_path` — 通过祖先目录查找插件命名空间
- `mention_syntax` 模块 — 包含 `TOOL_MENTION_SIGIL`（`$`）和 `PLUGIN_TEXT_MENTION_SIGIL`（`@`）两个纯文本提及符号常量

## 关键流程

### PluginId 解析与验证

插件的全局唯一标识格式为 `<plugin_name>@<marketplace_name>`，例如 `my-tool@official`。

1. 调用 `PluginId::parse(plugin_key)` 解析字符串标识（`src/plugin_id.rs:26-43`）
2. 使用 `rsplit_once('@')` 按最后一个 `@` 分割为 `plugin_name` 和 `marketplace_name`
3. 对每个片段调用 `validate_plugin_segment()` 校验合法性（`src/plugin_id.rs:51-64`）
4. 验证规则：非空，且仅允许 ASCII 字母、数字、`_`、`-`
5. 验证通过后构造 `PluginId { plugin_name, marketplace_name }`

也可通过 `PluginId::new(plugin_name, marketplace_name)` 直接构造（同样会执行验证）。`as_key()` 方法将其序列化回 `"name@marketplace"` 格式。

### 插件加载结果聚合

`PluginLoadOutcome<M>` 是一个泛型容器，汇总所有插件的加载结果。类型参数 `M` 代表 MCP 服务器配置类型，通过泛型抹除让下游 crate 无需了解具体的 MCP 配置结构。

1. 上层加载器构造 `Vec<LoadedPlugin<M>>` 后调用 `PluginLoadOutcome::from_plugins(plugins)`（`src/load_outcome.rs:94-103`）
2. 构造过程中自动遍历每个插件，通过 `plugin_capability_summary_from_loaded()` 生成能力摘要（`src/load_outcome.rs:34-60`）
3. 只有 **活跃插件**（`enabled == true` 且无加载错误）才会生成摘要
4. 摘要仅在插件确实提供了某种能力（有 skills、MCP 服务器或 app connector）时才保留

构造完成后，可通过以下方法查询聚合结果：
- `effective_skill_roots()` — 收集所有活跃插件的 skill 目录路径（去重排序）
- `effective_mcp_servers()` — 合并所有活跃插件的 MCP 服务器配置（先到先得）
- `effective_apps()` — 收集所有活跃插件的 App Connector（去重保序）

### 遥测元数据生成

`PluginCapabilitySummary` 可通过 `telemetry_metadata()` 方法转换为 `PluginTelemetryMetadata`（`src/lib.rs:47-54`）。此方法会尝试从 `config_name` 解析出 `PluginId`，解析失败则返回 `None`，确保遥测数据中只包含有效标识的插件。

也可通过 `PluginTelemetryMetadata::from_plugin_id()` 创建仅包含 ID、不含能力摘要的轻量元数据。

### 插件命名空间解析（re-export 自 codex-utils-plugins）

`plugin_namespace_for_skill_path(path)` 用于从 skill 文件路径反向查找其所属插件的名称：

1. 从给定路径开始，逐级遍历祖先目录
2. 在每个目录下检查 `.codex-plugin/plugin.json` 是否存在
3. 如果存在，解析 JSON 中的 `name` 字段；如果 `name` 为空，则回退到目录名
4. 返回第一个匹配的插件名称

## 函数签名与参数说明

### `PluginId::parse(plugin_key: &str) -> Result<Self, PluginIdError>`

从 `"name@marketplace"` 格式的字符串解析出 `PluginId`。

- **plugin_key**：格式为 `<plugin_name>@<marketplace_name>`
- **返回**：解析成功返回 `PluginId`，格式不合法或片段验证失败返回 `PluginIdError::Invalid`

> 源码位置：`codex-rs/plugin/src/plugin_id.rs:26-43`

### `PluginId::new(plugin_name: String, marketplace_name: String) -> Result<Self, PluginIdError>`

直接构造 `PluginId`，两个片段均需通过验证。

> 源码位置：`codex-rs/plugin/src/plugin_id.rs:16-24`

### `validate_plugin_segment(segment: &str, kind: &str) -> Result<(), String>`

验证单个名称片段的合法性。规则：非空，仅允许 ASCII 字母、数字、`_`、`-`。

> 源码位置：`codex-rs/plugin/src/plugin_id.rs:51-64`

### `PluginLoadOutcome::from_plugins(plugins: Vec<LoadedPlugin<M>>) -> Self`

从已加载的插件列表构造聚合结果，自动计算能力摘要。

> 源码位置：`codex-rs/plugin/src/load_outcome.rs:94-103`

### `prompt_safe_plugin_description(description: Option<&str>) -> Option<String>`

对插件描述进行净化：合并空白字符，截断至 1024 字符，空字符串返回 `None`。用于生成可安全嵌入模型 prompt 的描述文本。

> 源码位置：`codex-rs/plugin/src/load_outcome.rs:63-78`

## 接口/类型定义

### `PluginId`

```rust
pub struct PluginId {
    pub plugin_name: String,
    pub marketplace_name: String,
}
```

插件的全局唯一标识。`as_key()` 返回 `"plugin_name@marketplace_name"` 格式字符串。

### `LoadedPlugin<M>`

```rust
pub struct LoadedPlugin<M> {
    pub config_name: String,           // 配置文件中的插件 key
    pub manifest_name: Option<String>,  // plugin.json 中的 name
    pub manifest_description: Option<String>,
    pub root: AbsolutePathBuf,          // 插件根目录
    pub enabled: bool,
    pub skill_roots: Vec<PathBuf>,      // skill 搜索路径
    pub disabled_skill_paths: HashSet<PathBuf>,
    pub has_enabled_skills: bool,
    pub mcp_servers: HashMap<String, M>, // MCP 服务器配置映射
    pub apps: Vec<AppConnectorId>,
    pub error: Option<String>,          // 加载错误信息
}
```

`is_active()` 方法当 `enabled == true` **且** `error.is_none()` 时返回 `true`。

### `PluginCapabilitySummary`

```rust
pub struct PluginCapabilitySummary {
    pub config_name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub has_skills: bool,
    pub mcp_server_names: Vec<String>,
    pub app_connector_ids: Vec<AppConnectorId>,
}
```

对单个插件能力的精简摘要，用于遥测和 prompt 构建。`display_name` 优先取 manifest 中的 `name`，回退到 `config_name`。

### `PluginTelemetryMetadata`

```rust
pub struct PluginTelemetryMetadata {
    pub plugin_id: PluginId,
    pub capability_summary: Option<PluginCapabilitySummary>,
}
```

遥测系统使用的插件元数据，关联 ID 和可选的能力摘要。

### `AppConnectorId`

```rust
pub struct AppConnectorId(pub String);
```

App Connector 的不透明标识符（newtype wrapper）。

### `EffectiveSkillRoots` trait

```rust
pub trait EffectiveSkillRoots {
    fn effective_skill_roots(&self) -> Vec<PathBuf>;
}
```

抽象出 skill 目录查询接口，使下游模块（如 skills 系统）可以依赖 `codex-plugin` 而无需知道 `PluginLoadOutcome` 的泛型参数 `M`。

## 配置项与默认值

- **插件清单路径**：`PLUGIN_MANIFEST_PATH = ".codex-plugin/plugin.json"`（re-export 自 `codex-utils-plugins`）
- **描述最大长度**：`MAX_CAPABILITY_SUMMARY_DESCRIPTION_LEN = 1024`（内部常量，用于 `prompt_safe_plugin_description` 截断）
- **提及符号**：`TOOL_MENTION_SIGIL = '$'`、`PLUGIN_TEXT_MENTION_SIGIL = '@'`（re-export 自 `codex_utils_plugins::mention_syntax`）

## 边界 Case 与注意事项

- **MCP 服务器名称冲突**：`effective_mcp_servers()` 在多个插件定义同名 MCP 服务器时采用**先到先得**策略（`src/load_outcome.rs:117-127`），后续插件的同名配置会被忽略。
- **泛型参数 `M` 的设计意图**：`LoadedPlugin` 和 `PluginLoadOutcome` 对 MCP 服务器配置类型做了泛型抽象，这使得 `codex-plugin` crate 不需要依赖具体的 MCP 配置定义，降低了耦合。`EffectiveSkillRoots` trait 进一步允许下游代码完全绕过泛型参数。
- **`PluginId::parse` 的分割策略**：使用 `rsplit_once('@')` 而非 `split_once`，意味着如果 plugin name 中包含 `@`（虽然验证规则不允许），会取最后一个 `@` 作为分隔符。
- **插件命名空间回退逻辑**：当 `plugin.json` 中的 `name` 为空白字符串时，`plugin_namespace_for_skill_path` 会回退到使用插件根目录的目录名作为命名空间。
- **非活跃插件的处理**：`is_active()` 为 `false` 的插件不会出现在 `effective_*` 聚合结果中，也不会生成能力摘要，但仍然保留在 `plugins()` 列表中供诊断使用。