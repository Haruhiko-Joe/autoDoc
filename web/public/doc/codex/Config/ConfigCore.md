# ConfigCore — 核心分层配置系统

## 概述与职责

`codex-config` crate 是 Codex 的**核心配置层**，负责从多个来源加载、合并和约束验证 TOML 格式的配置。它位于整个系统架构的 **Config** 节点下，几乎所有上层模块（Core、TUI、CLI、Sandbox、ModelProviders、MCP 等）都依赖它来读取用户配置、执行策略、feature flags 和 MCP 服务器设置。

该 crate 的核心能力包括：

- **TOML 配置 Schema 定义**：通过丰富的 Rust 类型体系描述所有可配置项
- **多层配置栈管理**：按优先级从低到高排列为 MDM/System → User → Project → SessionFlags（CLI 覆盖），高优先级层覆盖低优先级层
- **TOML 值递归合并**：Table 级别深度合并，非 Table 值直接覆盖
- **配置约束（Requirements）系统**：由系统管理员 / 云端 / MDM 下发的强制性策略约束
- **MCP 服务器配置**：支持 Stdio 和 StreamableHttp 两种传输方式的 MCP 服务器声明
- **Skills 配置**：内置和自定义技能的启用/禁用控制
- **执行策略规则**：基于前缀匹配的命令执行决策规则
- **项目根目录检测**：通过 marker 文件（默认 `.git`）定位项目根
- **配置诊断与错误格式化**：精确定位 TOML 解析错误的文件位置并生成可读的错误信息
- **配置指纹**：基于 SHA-256 的变更检测机制

## 关键流程

### 配置加载与合并流程

1. 系统从多个来源收集配置层，每层表示为一个 `ConfigLayerEntry`，包含层名称（`ConfigLayerSource`）、TOML 值和版本指纹
2. 所有层按优先级从低到高插入 `ConfigLayerStack`，构造时通过 `verify_layer_ordering()` 校验排序正确性（`src/state.rs:278-331`）
3. 调用 `effective_config()` 时，按从低到高的顺序逐层调用 `merge_toml_values()` 进行递归合并（`src/state.rs:218-227`）
4. 合并规则：如果 base 和 overlay 都是 Table 则递归合并子键；否则 overlay 直接替换 base（`src/merge.rs:4-18`）

### CLI 覆盖层构建

`build_cli_overrides_layer()` 接收 `(dotted_path, value)` 对列表，将其转化为嵌套的 TOML Table 结构。例如 `"tui.animations"` → `{ tui: { animations: <value> } }`。该层作为 `SessionFlags` 插入配置栈的最高优先级位置（`src/overrides.rs:7-55`）。

### 约束（Requirements）应用流程

1. 从多个来源（MDM、云端、系统 `requirements.toml`）加载 `ConfigRequirementsToml`
2. 通过 `ConfigRequirementsWithSources::merge_unset_fields()` 按优先级合并——高优先级来源的字段不会被低优先级覆盖（`src/config_requirements.rs:540-601`）
3. 将合并后的 `ConfigRequirementsWithSources` 转换为 `ConfigRequirements`（`src/config_requirements.rs:690-889`），此过程：
   - 为 `approval_policy`、`sandbox_policy`、`web_search_mode` 等创建带验证闭包的 `Constrained<T>` 包装
   - 解析执行策略规则为内部 `Policy` 对象
   - 验证约束的自洽性（如 `allowed_sandbox_modes` 必须包含 `read-only`）

### 配置变更检测

`version_for_toml()` 将 TOML 值序列化为规范化的 JSON（键排序），然后计算 SHA-256 哈希，生成 `"sha256:<hex>"` 格式的版本字符串（`src/fingerprint.rs:37-49`）。每个 `ConfigLayerEntry` 在创建时自动计算版本指纹，用于判断配置是否发生变化。

## 核心类型定义

### `ConfigLayerStack`

配置层栈，是整个配置系统的中枢数据结构。

```rust
pub struct ConfigLayerStack {
    layers: Vec<ConfigLayerEntry>,           // 从低优先级到高优先级排列
    user_layer_index: Option<usize>,         // 用户配置层的索引
    requirements: ConfigRequirements,        // 约束条件
    requirements_toml: ConfigRequirementsToml, // 原始约束数据
}
```

> 源码位置：`src/state.rs:117-134`

关键方法：

| 方法 | 说明 |
|------|------|
| `effective_config()` | 合并所有启用的层，返回最终 TOML 值 |
| `origins()` | 返回每个字段的来源层元数据 |
| `with_user_config()` | 创建替换了用户层的新栈（不可变更新） |
| `get_layers(ordering, include_disabled)` | 按指定顺序返回层列表 |

### `ConfigLayerEntry`

单个配置层的表示。

```rust
pub struct ConfigLayerEntry {
    pub name: ConfigLayerSource,      // 层来源标识
    pub config: TomlValue,            // 该层的 TOML 值
    pub raw_toml: Option<String>,     // 原始 TOML 文本（用于诊断）
    pub version: String,              // SHA-256 指纹
    pub disabled_reason: Option<String>, // 禁用原因
}
```

> 源码位置：`src/state.rs:26-33`

### `ConfigLayerSource` 优先级

层来源按以下优先级从低到高排列（由外部 `codex-app-server-protocol` crate 定义）：

1. `Mdm` — MDM 托管配置
2. `System` — 系统级配置文件
3. `LegacyManagedConfigTomlFromFile` / `LegacyManagedConfigTomlFromMdm` — 旧版托管配置
4. `User` — 用户个人配置（`~/.codex/config.toml`）
5. `Project` — 项目级配置（`.codex/config.toml`，从根到 cwd 可以有多层）
6. `SessionFlags` — CLI 会话覆盖

### `Constrained<T>`

带约束验证的值包装器。核心设计：每次 `set()` 调用都会先通过验证器闭包检查，不满足约束则拒绝修改。

```rust
pub struct Constrained<T> {
    value: T,
    validator: Arc<dyn Fn(&T) -> ConstraintResult<()>>,
    normalizer: Option<Arc<dyn Fn(T) -> T>>,
}
```

> 源码位置：`src/constraint.rs:50-55`

工厂方法：

| 方法 | 说明 |
|------|------|
| `allow_any(initial)` | 不限制取值 |
| `allow_only(value)` | 只允许指定值 |
| `normalized(initial, fn)` | 每次 set 前通过 normalizer 转换值 |
| `new(initial, validator)` | 自定义验证逻辑 |

### `ConfigRequirements`

约束条件的运行时表示，控制哪些配置值是允许的。

| 字段 | 类型 | 说明 |
|------|------|------|
| `approval_policy` | `ConstrainedWithSource<AskForApproval>` | 允许的审批策略 |
| `sandbox_policy` | `ConstrainedWithSource<SandboxPolicy>` | 允许的沙箱模式 |
| `web_search_mode` | `ConstrainedWithSource<WebSearchMode>` | 允许的 Web 搜索模式 |
| `feature_requirements` | `Option<Sourced<FeatureRequirementsToml>>` | Feature flag 强制值 |
| `mcp_servers` | `Option<Sourced<BTreeMap<...>>>` | MCP 服务器身份白名单 |
| `exec_policy` | `Option<Sourced<RequirementsExecPolicy>>` | 执行策略规则 |
| `enforce_residency` | `ConstrainedWithSource<Option<ResidencyRequirement>>` | 数据驻留要求 |
| `network` | `Option<Sourced<NetworkConstraints>>` | 网络访问约束 |

> 源码位置：`src/config_requirements.rs:78-89`

## MCP 服务器配置

MCP 服务器支持两种传输方式，通过 `McpServerTransportConfig` 枚举区分（`src/mcp_types.rs:271-301`）：

**Stdio 模式**：指定 `command`、`args`、`env`、`cwd`，启动子进程通过标准输入输出通信。

**StreamableHttp 模式**：指定 `url`，可选 `bearer_token_env_var`（从环境变量读取认证令牌，**禁止内联明文 token**）、`http_headers`、`env_http_headers`。

`McpServerConfig` 还包含 `startup_timeout_sec`、`tool_timeout_sec`、`enabled_tools` / `disabled_tools` 白名单/黑名单、`scopes`（OAuth）、以及每工具的 `approval_mode` 设置。

`ConfigEditsBuilder`（`src/mcp_edit.rs:61-96`）提供对全局 `config.toml` 中 MCP 服务器配置的读写能力，使用 `toml_edit` 保持格式化，通过 `spawn_blocking` 在异步上下文中执行文件 I/O。

## Skills 配置

```rust
pub struct SkillsConfig {
    pub bundled: Option<BundledSkillsConfig>,  // 内置技能总开关
    pub config: Vec<SkillConfig>,              // 自定义技能配置列表
}
```

每个 `SkillConfig` 可通过 `path`（绝对路径）或 `name`（名称）选择目标技能，并设置 `enabled` 开关。

> 源码位置：`src/skills_config.rs:12-45`

## 执行策略规则

`RequirementsExecPolicyToml` 定义了基于前缀匹配的命令执行决策规则（`src/requirements_exec_policy.rs:48-52`）。每条规则包含：

- `pattern`：命令前缀模式，每个 token 可以是单个字符串或 `any_of` 多选
- `decision`：`prompt`（需用户确认）或 `forbidden`（禁止执行）。注意 **`allow` 决策在 requirements 中被明确禁止**，因为 Codex 采用最严格结果合并策略
- `justification`：可选的理由说明

`to_policy()` 方法将 TOML 规则转换为 `codex-execpolicy` crate 的内部 `Policy` 对象，按首个 token 索引规则以加速匹配（`src/requirements_exec_policy.rs:125-183`）。

## 配置诊断与错误格式化

当 TOML 解析失败时，诊断模块（`src/diagnostics.rs`）将错误精确定位到文件中的具体位置：

1. `config_error_from_toml()` 从 `toml::de::Error` 提取 span 并转换为行列号
2. `config_error_from_typed_toml()` 结合 `serde_path_to_error` 追踪嵌套路径，在 `toml_edit` Document 中查找对应节点的 span
3. `format_config_error()` 生成类似编译器的错误输出，包含文件路径、行号、源代码行和 `^^^` 指示符
4. `first_layer_config_error()` 遍历配置栈，找到**第一个**有解析错误的具体文件层，避免在合并结果上报告模糊错误

输出示例：
```
~/.codex/config.toml:3:5: unknown field `typo_field`
  |
3 | typo_field = true
  | ^^^^^^^^^^
```

## 项目根目录检测

`project_root_markers_from_config()` 从合并后的配置中读取 `project_root_markers` 字段（`src/project_root_markers.rs:16-43`）：

- 未设置 → 返回 `None`，使用默认值 `[".git"]`
- 设置为空数组 → 返回 `Some([])`，**禁用**根目录检测
- 设置为非空数组 → 使用自定义 marker 列表

## 云端约束加载

`CloudRequirementsLoader` 是一个 `Shared<BoxFuture>` 包装器（`src/cloud_requirements.rs:48-53`），确保异步获取云端约束的 future 只执行一次，多次 `.get()` 调用共享同一结果。错误通过 `CloudRequirementsLoadError` 分类为 Auth / Timeout / Parse / RequestFailed / Internal。

## TOML Schema 主要配置项

`types.rs` 定义了以下主要可配置区域（均可出现在 `config.toml` 中）：

| 区域 | 类型 | 说明 |
|------|------|------|
| TUI | `Tui` | 通知、动画、alternate screen、状态栏、主题等 |
| History | `History` | 历史记录持久化策略和大小限制 |
| Analytics | `AnalyticsConfigToml` | 分析数据开关 |
| OTEL | `OtelConfigToml` | 可观测性导出器配置 |
| Memories | `MemoriesToml` / `MemoriesConfig` | 记忆系统参数（生成、使用、滚动策略） |
| Shell Env | `ShellEnvironmentPolicyToml` | 子进程环境变量过滤策略 |
| Apps | `AppsConfigToml` | 应用/连接器的启用、工具审批模式 |
| Sandbox | `SandboxWorkspaceWrite` | 沙箱可写根目录和网络访问 |
| Windows | `WindowsToml` | Windows 平台沙箱和桌面隔离 |
| Notice | `Notice` | 用户已确认的警告/提示追踪 |
| Plugins | `PluginConfig` | 插件启用开关 |

## 边界 Case 与注意事项

- **Project 层排序**：多个 Project 层必须从仓库根到 cwd 方向排列，`verify_layer_ordering()` 会校验祖先关系，违反时返回 `InvalidData` 错误
- **User 层唯一性**：配置栈中最多只允许一个 `User` 类型的层
- **MCP bearer_token 安全**：`load_global_mcp_servers()` 会主动拒绝包含内联 `bearer_token` 的配置，强制用户使用 `bearer_token_env_var` 从环境变量读取
- **Requirements 的 `allow` 决策禁令**：在 requirements 执行策略规则中，`allow` 决策被显式禁止，因为 Codex 将 requirements 规则与其他配置合并时取最严格结果
- **`MemoriesConfig` 值域约束**：从 TOML 转换为有效配置时，会自动 clamp 各字段到合理范围（如 `max_rollout_age_days` 限制在 0-90）
- **Shell 环境变量默认排除**：默认过滤环境变量名中包含 `KEY`、`SECRET`、`TOKEN` 的条目，需显式设置 `ignore_default_excludes = true` 才能跳过
- **配置指纹的确定性**：通过键排序的规范化 JSON 确保相同内容总是生成相同的 SHA-256 哈希