# ConfigTypes — 核心配置数据模型

## 概述与职责

ConfigTypes 是 Codex 配置系统的**规范数据模型层**，定义了所有用户可配置选项的结构化表示。它位于 `Core > CoreConfig` 子系统中，是整个 Codex 应用在启动和运行时读取配置的核心依赖——从 SessionEngine、ToolsOrchestration 到 TUI、CLI 等几乎所有模块都直接或间接依赖此层。

在上层架构中，`CoreConfig` 与 `Protocol` 层协作：Protocol 提供底层的权限枚举（`SandboxPolicy`、`FileSystemSandboxPolicy` 等）和配置类型枚举（`SandboxMode`、`Personality` 等），而 ConfigTypes 负责将这些类型组织为 TOML 可序列化的分层配置结构，并提供加载、合并、校验、约束执行等完整的配置生命周期管理。

主要源码分布在以下文件中：

| 文件 | 职责 |
|------|------|
| `codex-rs/core/src/config/mod.rs` | 核心 `Config` 和 `ConfigToml` 结构定义、配置加载与合并逻辑 |
| `codex-rs/core/src/config/profile.rs` | `ConfigProfile` 配置配置文件定义 |
| `codex-rs/core/src/config/permissions.rs` | 权限配置文件（文件系统与网络授权） |
| `codex-rs/core/src/config/managed_features.rs` | 受约束的特性标志管理 |
| `codex-rs/core/src/config/agent_roles.rs` | Agent 角色定义的加载与解析 |
| `codex-rs/core/src/config/schema.rs` | JSON Schema 生成（供编辑器自动补全） |
| `codex-rs/core/src/personality_migration.rs` | Personality 字段的自动迁移 |
| `codex-rs/core/src/flags.rs` | 环境变量标志 |

## 关键流程

### 配置加载与合并流程

1. `ConfigBuilder` 收集各来源的输入：`codex_home` 路径、CLI 覆盖参数、harness 覆盖参数、loader 覆盖和云端需求（`codex-rs/core/src/config/mod.rs:596-692`）
2. 调用 `load_config_layers_state()` 从多层配置文件（全局/项目/本地）加载并合并为一个 `ConfigLayerStack`
3. 将合并后的 TOML 值反序列化为 `ConfigToml` 结构体
4. 调用 `Config::load_config_with_layer_stack()` 将 `ConfigToml` + `ConfigOverrides` 转化为最终运行时的 `Config` 实例

整个过程遵循**最低优先级优先合并**的策略：全局配置 → 项目配置 → 本地配置 → CLI 覆盖 → harness 覆盖，后者覆盖前者。

### Profile 解析流程

`ConfigToml` 支持命名配置 profile，存储在 `profiles` 字段中：

1. 用户在 `config.toml` 中设置 `profile = "fast"` 选择某个 profile
2. `get_config_profile()` 根据 profile 名称查找 `profiles` map（`codex-rs/core/src/config/mod.rs:1791-1811`）
3. Profile 中的字段（模型、审批策略、sandbox 模式等）覆盖顶层默认值
4. 如果 CLI 传入了 `config_profile` 覆盖，优先使用 CLI 指定的 profile

### 权限编译流程

权限系统支持两种语法：Legacy（`sandbox_mode` 字段）和 Profiles（`default_permissions` + `[permissions]` 表）。

**Profiles 语法流程**：

1. `resolve_permission_config_syntax()` 遍历配置层判断使用哪种语法（`codex-rs/core/src/config/mod.rs:1825-1861`）
2. `resolve_permission_profile()` 根据 `default_permissions` 名称在 `PermissionsToml` 中查找对应的 `PermissionProfileToml`（`codex-rs/core/src/config/permissions.rs:264-274`）
3. `compile_permission_profile()` 编译 profile 为运行时策略（`codex-rs/core/src/config/permissions.rs:276-308`）：
   - 遍历 `filesystem` 条目，将路径字符串编译为 `FileSystemSandboxEntry`
   - 支持特殊路径前缀（`:root`、`:minimal`、`:project_roots`、`:tmpdir`），不识别的 `:xxx` 走 `Unknown` 分支发出警告但不报错（前向兼容）
   - 编译 `network` 条目为 `NetworkSandboxPolicy`

### 特性标志约束流程

`ManagedFeatures` 是对 `Features` 的受约束包装，确保外部需求（如 `requirements.toml`）定义的 pinned 特性不会被用户配置覆盖：

1. `from_configured()` 解析需求中的 pinned 特性，将其应用到用户配置的特性上（`codex-rs/core/src/config/managed_features.rs:31-52`）
2. 每次 `set()` 调用都会先归一化（强制 pinned 值 + 规范化依赖关系），再校验约束（`codex-rs/core/src/config/managed_features.rs:58-76`）
3. 如果用户 config.toml 中的显式特性设置与需求冲突，`validate_explicit_feature_settings_in_config_toml()` 会在加载时报错（`codex-rs/core/src/config/managed_features.rs:263-299`）

### Agent 角色加载流程

1. `load_agent_roles()` 遍历配置层栈，从低优先级到高优先级逐层加载（`codex-rs/core/src/config/agent_roles.rs:17-108`）
2. 每层中同时处理两个来源：
   - `[agents]` TOML 表中声明的角色
   - `agents/` 目录下自动发现的 `.toml` 文件
3. 声明式角色可引用 `config_file` 指向独立的角色文件，该文件含 `name`、`description`、`nickname_candidates` 及嵌入的 `ConfigToml` 配置
4. 跨层合并采用**高优先级覆盖 + 低优先级填充**策略：`merge_missing_role_fields()` 用低层值填充高层缺失的字段（`codex-rs/core/src/config/agent_roles.rs:153-160`）
5. 最终要求每个角色必须有 `description`，否则发出警告并跳过

## 核心类型定义

### `ConfigToml` — TOML 配置文件的直接映射

定义在 `codex-rs/core/src/config/mod.rs:1132-1458`，是 `~/.codex/config.toml` 的 1:1 反序列化目标。所有字段均为 `Option<T>`，表示用户可选配置。关键字段分组：

| 分组 | 字段示例 | 说明 |
|------|----------|------|
| 模型 | `model`, `model_provider`, `model_reasoning_effort`, `model_verbosity` | 模型选择与推理参数 |
| 审批与沙箱 | `approval_policy`, `sandbox_mode`, `default_permissions`, `permissions` | 执行安全策略 |
| MCP | `mcp_servers`, `mcp_oauth_credentials_store` | MCP 服务器定义 |
| Profile | `profile`, `profiles` | 命名配置切换 |
| 特性 | `features`, `experimental_use_unified_exec_tool` 等 | 特性标志 |
| Agent | `agents` (含 `AgentsToml`) | Agent 线程限制与角色 |
| TUI | `tui`, `hide_agent_reasoning`, `personality` | 界面行为 |
| 项目 | `projects` | 项目信任级别 |

### `Config` — 运行时配置

定义在 `codex-rs/core/src/config/mod.rs:217-594`，是从 `ConfigToml` + `ConfigOverrides` 合并并编译后的**最终运行时配置**。与 `ConfigToml` 的关键区别：

- 所有 `Option` 已解析为具体值（含默认值）
- 权限已编译为运行时策略（`Permissions` 结构）
- 特性标志已包装为受约束的 `ManagedFeatures`
- MCP 服务器已过滤为 `Constrained<HashMap<String, McpServerConfig>>`
- 包含运行时才确定的路径（`cwd`、`codex_home`、`codex_self_exe` 等）

### `ConfigProfile` — 命名配置集合

定义在 `codex-rs/core/src/config/profile.rs:23-69`，收集了用户常在不同场景间切换的配置项，包括 `model`、`approval_policy`、`sandbox_mode`、`model_reasoning_effort`、`personality`、`features` 等。Profile 中的值覆盖 `ConfigToml` 顶层同名字段。

### `Permissions` — 运行时权限配置

定义在 `codex-rs/core/src/config/mod.rs:184-213`，包含：

- `approval_policy`: 受约束的审批策略
- `sandbox_policy`: 传统 `SandboxPolicy`（ReadOnly / WorkspaceWrite / DangerFullAccess）
- `file_system_sandbox_policy`: 基于 profile 编译的文件系统细粒度策略
- `network_sandbox_policy`: 网络沙箱策略
- `network`: 可选的网络代理配置
- `shell_environment_policy`: shell 进程环境构建策略
- `windows_sandbox_mode` / `windows_sandbox_private_desktop`: Windows 特定沙箱配置

## 权限配置文件详解

### `PermissionsToml`

顶层容器，`entries` 是命名权限 profile 的 map（`codex-rs/core/src/config/permissions.rs:24-28`）。

### `PermissionProfileToml`

每个 profile 包含 `filesystem` 和 `network` 两个可选部分（`codex-rs/core/src/config/permissions.rs:36-41`）。

### 文件系统权限

`FilesystemPermissionToml` 支持两种形式（`codex-rs/core/src/config/permissions.rs:55-60`）：

```toml
# 简单模式：直接指定路径和访问级别
[permissions.default.filesystem]
"/usr/local" = "read_only"

# 作用域模式：基于基路径的子路径授权
[permissions.default.filesystem.":project_roots"]
"src" = "read_write"
"." = "read_only"
```

特殊路径前缀（`codex-rs/core/src/config/permissions.rs:428-439`）：

| 前缀 | 含义 |
|------|------|
| `:root` | 文件系统根目录 |
| `:minimal` | 运行所需最小路径集 |
| `:project_roots` | 当前项目根目录（支持子路径） |
| `:tmpdir` | 系统临时目录 |
| `:xxx`（未知） | 前向兼容占位，发出警告并忽略 |

### 网络权限

`NetworkToml` 提供细粒度网络控制（`codex-rs/core/src/config/permissions.rs:154-170`）：

- `enabled`: 是否启用网络
- `mode`: `limited` 或 `full`
- `domains`: 域名级别的 allow/deny 规则
- `unix_sockets`: Unix socket 的 allow/none 规则
- `proxy_url` / `socks_url` / `enable_socks5` 等代理配置

`apply_to_network_proxy_config()` 将 TOML 配置映射为 `NetworkProxyConfig`（`codex-rs/core/src/config/permissions.rs:179-231`）。

## ManagedFeatures — 受约束特性标志

`ManagedFeatures`（`codex-rs/core/src/config/managed_features.rs:25-28`）包装了 `Features` 并增加了两层保护：

1. **pinned 特性**：从 `FeatureRequirementsToml`（通常来自 `requirements.toml`）解析而来，这些特性值不可被用户配置覆盖
2. **依赖规范化**：每次设置特性时自动调用 `normalize_dependencies()` 确保特性间依赖关系一致

核心 API：

```rust
pub fn get(&self) -> &Features           // 获取当前值
pub fn set(&mut self, candidate: Features)  // 设置新值（自动归一化+校验）
pub fn enable(&mut self, feature: Feature)  // 启用单个特性
pub fn disable(&mut self, feature: Feature) // 禁用单个特性
pub fn can_set(&self, candidate: &Features) // 检查是否允许设置
```

> 源码位置：`codex-rs/core/src/config/managed_features.rs:30-91`

## Agent 角色配置

### 数据结构

```rust
pub struct AgentsToml {
    pub max_threads: Option<usize>,     // 并发线程上限
    pub max_depth: Option<i32>,          // 嵌套深度上限
    pub job_max_runtime_seconds: Option<u64>,
    pub roles: BTreeMap<String, AgentRoleToml>,  // 角色定义（flatten）
}

pub struct AgentRoleConfig {
    pub description: Option<String>,
    pub config_file: Option<PathBuf>,
    pub nickname_candidates: Option<Vec<String>>,
}
```

> 源码位置：`codex-rs/core/src/config/mod.rs:1601-1653`

### 角色文件格式

独立的角色 `.toml` 文件（通常位于 `~/.codex/agents/` 或 `.codex/agents/`）可包含：

- `name`: 角色名称（文件发现模式下必填）
- `description`: 角色描述
- `nickname_candidates`: 备选昵称列表
- 其余字段作为嵌入的 `ConfigToml` 被解析为角色特定配置层

> 源码位置：`codex-rs/core/src/config/agent_roles.rs:196-294`

### 昵称验证规则

`nickname_candidates` 有严格约束（`codex-rs/core/src/config/agent_roles.rs:392-442`）：
- 列表非空
- 不含空白项
- 不含重复项
- 仅允许 ASCII 字母/数字、空格、连字符、下划线

## JSON Schema 生成

`codex-rs/core/src/config/schema.rs` 提供将 `ConfigToml` 导出为 JSON Schema (Draft-07) 的能力：

- `config_schema()` → 生成 `RootSchema`（`codex-rs/core/src/config/schema.rs:60-67`）
- `features_schema()` → 为 `[features]` 表注入已知特性键并禁止未知键（`codex-rs/core/src/config/schema.rs:17-41`）
- `mcp_servers_schema()` → 为 `[mcp_servers]` 表使用原始输入结构生成 schema（`codex-rs/core/src/config/schema.rs:44-57`）
- `config_schema_json()` → 输出经键排序规范化的 pretty-print JSON（`codex-rs/core/src/config/schema.rs:87-93`）

## Personality 迁移

`codex-rs/core/src/personality_migration.rs` 实现了一次性的 personality 字段自动迁移逻辑。当 Codex 首次引入 personality 特性时，需要为已有用户设置默认值：

1. 检查 `$CODEX_HOME/.personality_migration` 标记文件是否存在，已存在则跳过
2. 检查用户是否已显式设置 `personality`，已设置则跳过并写入标记
3. 检查是否有历史会话记录（SQLite DB + 会话目录 + 归档目录），无记录则跳过
4. 有历史记录的老用户：自动写入 `personality = "pragmatic"` 到 config.toml，然后写入标记

> 源码位置：`codex-rs/core/src/personality_migration.rs:27-64`

## 环境标志

`codex-rs/core/src/flags.rs` 通过 `env_flags!` 宏定义环境变量标志（`codex-rs/core/src/flags.rs:1-6`）：

```rust
pub CODEX_RS_SSE_FIXTURE: Option<&str> = None;
```

当前仅定义了 `CODEX_RS_SSE_FIXTURE`，用于离线测试时指定 SSE fixture 文件路径。

## ConfigOverrides — CLI/Harness 覆盖

`ConfigOverrides`（`codex-rs/core/src/config/mod.rs:1864-1891`）用于从 CLI 参数或 harness 层注入运行时覆盖，包含 `ConfigToml` 无法表达的选项：

- `cwd`: 工作目录覆盖
- `codex_self_exe` / `codex_linux_sandbox_exe` / `main_execve_wrapper_exe`: 可执行文件路径
- `additional_writable_roots`: 会话级别的额外可写目录
- 以及 `model`、`approval_policy`、`sandbox_mode` 等覆盖标准配置的字段

## ConfigBuilder — 配置构建器

`ConfigBuilder`（`codex-rs/core/src/config/mod.rs:596-692`）提供流式 API 组装配置加载所需的所有输入：

```rust
ConfigBuilder::default()
    .codex_home(home)
    .cli_overrides(overrides)
    .harness_overrides(harness)
    .loader_overrides(loader)
    .cloud_requirements(cloud)
    .build()
    .await?;
```

`build()` 是异步方法，因为需要从磁盘加载配置层和云端需求。

## 边界 Case 与注意事项

- **前向兼容的特殊路径**：未识别的 `:xxx` 文件系统路径不会导致配置加载失败，仅发出警告。这使得新版本定义的路径不会破坏旧版本（`codex-rs/core/src/config/permissions.rs:423-438`）
- **Windows sandbox 降级**：在 Windows 上如果沙箱级别为 Disabled，`WorkspaceWrite` 会自动降级为 `ReadOnly`（`codex-rs/core/src/config/mod.rs:1733-1745`）
- **保留的 model provider ID**：`openai`、`ollama`、`lmstudio` 是保留 ID，用户自定义 provider 不能使用这些名称（`codex-rs/core/src/config/mod.rs:151-155`）
- **MCP bearer_token 已弃用**：配置中使用 `bearer_token` 字段会直接报错，必须改用 `bearer_token_env_var`（`codex-rs/core/src/config/mod.rs:994-1011`）
- **Profile 解析优先级**：CLI override > `ConfigToml.profile` > 默认空 profile
- **Agent 角色去重**：同一层中出现重复角色名会发出警告并跳过后者；跨层时高优先级层完全覆盖低优先级层的同名角色
- **Personality 迁移是幂等的**：标记文件机制确保迁移逻辑只执行一次，即使并发调用也通过 `create_new` 原子性保证正确性（`codex-rs/core/src/personality_migration.rs:120-131`）