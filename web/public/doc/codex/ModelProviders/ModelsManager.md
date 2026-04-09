# ModelsManager

## 概述与职责

`codex-models-manager` crate 是 Codex 的**模型发现与元数据管理中枢**，属于 **ModelProviders** 模块层级。它负责回答系统中最基础的问题：当前有哪些模型可用、该用哪个模型、这个模型的能力和配置是什么。

在整体架构中，ModelProviders 层是 Core 调用 LLM 的桥梁，而 ModelsManager 是该层中专门处理"模型目录"的组件。它与 Auth 模块协作完成认证路由，与 Config 模块协作读取覆盖配置，并通过 Observability 层发射遥测事件。同层级的兄弟模块（如 API 客户端、Responses API 代理、本地模型提供者等）则负责实际的请求发送和响应解析。

核心职责包括：

- 从远端 `/models` 接口发现可用模型，带 TTL 的磁盘缓存避免频繁请求
- 内置 `models.json` 静态目录作为启动时的基线
- 将远端元数据与配置覆盖合并，输出完整的 `ModelInfo`
- 根据认证模式（ChatGPT 登录 vs API Key vs 命令式认证）过滤和路由模型列表
- 提供协作模式（Collaboration Mode）预设：Default 和 Plan
- 为 `/models` 请求集成遥测，记录认证状态、请求耗时、错误详情

## 关键流程

### 模型列表刷新流程

这是 ModelsManager 最核心的流程，由 `list_models()` 或 `get_default_model()` 触发。

1. 调用 `refresh_available_models(strategy)` 根据策略决定数据来源（`src/manager.rs:392-430`）：
   - 若 `CatalogMode::Custom`（调用方提供了自定义目录），直接跳过刷新
   - 若认证模式不是 ChatGPT 且 provider 没有命令式认证，仅在 `Offline`/`OnlineIfUncached` 时尝试加载缓存，不发起网络请求
   - `Offline`：只尝试从磁盘缓存加载
   - `OnlineIfUncached`：先查缓存（`try_load_cache`），命中则返回；未命中则发起网络请求
   - `Online`：总是发起网络请求

2. 网络获取阶段（`fetch_and_update_models`，`src/manager.rs:432-468`）：
   - 通过 `AuthManager` 获取当前认证凭证
   - 根据 provider 信息构造 API 认证和传输层
   - 构造 `ModelsClient`，附加遥测回调
   - 调用 `/models` 端点（5 秒超时），获取模型列表和 ETag
   - 调用 `apply_remote_models` 将远端模型合并到内置目录中
   - 将结果持久化到磁盘缓存

3. 合并逻辑（`apply_remote_models`，`src/manager.rs:475-488`）：
   - 以内置 `models.json` 为基底
   - 远端返回的模型按 slug 匹配，存在则覆盖，不存在则追加

4. 构建最终列表（`build_available_models`，`src/manager.rs:519-529`）：
   - 按 `priority` 字段升序排序
   - 转换为 `ModelPreset` 格式
   - 根据认证模式过滤（ChatGPT 模式 vs API 模式）
   - 标记默认模型（第一个 `show_in_picker` 为 true 的模型）

### 模型元数据查询流程

当系统需要某个具体模型的详细信息时，调用 `get_model_info(slug, config)`：

1. 获取当前远端模型列表快照
2. 执行**最长前缀匹配**（`find_model_by_longest_prefix`，`src/manager.rs:318-334`）：在候选列表中找到 slug 最长匹配的模型。例如 `gpt-5.1-codex-experiment` 会匹配到 `gpt-5.1-codex`
3. 若前缀匹配失败，尝试**命名空间后缀匹配**（`find_model_by_namespaced_suffix`，`src/manager.rs:340-352`）：对 `namespace/model-name` 格式的 slug，去掉单层命名空间前缀后重试。仅支持单层、ASCII 字母数字加下划线的命名空间
4. 若仍无匹配，生成**回退元数据**（`model_info_from_slug`，`src/model_info.rs:60-93`），并标记 `used_fallback_model_metadata = true`
5. 最后应用配置覆盖（`with_config_overrides`），将用户配置中的 context window、truncation policy 等叠加上去

### 缓存管理流程

`ModelsCacheManager`（`src/cache.rs`）负责磁盘缓存的读写：

1. 缓存文件路径：`{codex_home}/models_cache.json`
2. 缓存格式（`ModelsCache` 结构体）：包含 `fetched_at` 时间戳、可选 `etag`、`client_version`、以及完整的 `models` 列表
3. 加载时的新鲜度检查（`load_fresh`，`src/cache.rs:31-74`）：
   - 缓存文件必须存在且可解析
   - `client_version` 必须与当前版本一致（版本升级后缓存自动失效）
   - 缓存年龄不超过 TTL（默认 300 秒）
4. ETag 续约（`renew_cache_ttl`）：当远端返回相同 ETag 时，只更新 `fetched_at` 延长缓存有效期，避免重新拉取

## 函数签名与参数说明

### `ModelsManager::new`

```rust
pub fn new(
    codex_home: PathBuf,
    auth_manager: Arc<AuthManager>,
    model_catalog: Option<ModelsResponse>,
    collaboration_modes_config: CollaborationModesConfig,
) -> Self
```

构造默认 OpenAI provider 的管理器。`model_catalog` 为 `Some` 时进入 Custom 模式，禁用网络刷新。

### `ModelsManager::new_with_provider`

```rust
pub fn new_with_provider(
    codex_home: PathBuf,
    auth_manager: Arc<AuthManager>,
    model_catalog: Option<ModelsResponse>,
    collaboration_modes_config: CollaborationModesConfig,
    provider: ModelProviderInfo,
) -> Self
```

显式指定 provider 的构造函数，用于非 OpenAI 的模型提供者。

### `ModelsManager::list_models`

```rust
pub async fn list_models(&self, refresh_strategy: RefreshStrategy) -> Vec<ModelPreset>
```

列出所有可用模型，返回按 priority 排序、按认证模式过滤后的 `ModelPreset` 列表。

### `ModelsManager::get_default_model`

```rust
pub async fn get_default_model(
    &self,
    model: &Option<String>,
    refresh_strategy: RefreshStrategy,
) -> String
```

获取默认模型 ID。若 `model` 已提供则直接返回，否则从可用列表中选取第一个默认模型。

### `ModelsManager::get_model_info`

```rust
pub async fn get_model_info(&self, model: &str, config: &ModelsManagerConfig) -> ModelInfo
```

查询指定模型的完整元数据，包含远端信息和配置覆盖。

### `ModelsManager::try_list_models`

```rust
pub fn try_list_models(&self) -> Result<Vec<ModelPreset>, TryLockError>
```

非阻塞版本的 `list_models`，使用当前缓存状态。无法获取锁时返回错误。

### `ModelsManager::refresh_if_new_etag`

```rust
pub async fn refresh_if_new_etag(&self, etag: String)
```

当 ETag 变化时触发 Online 刷新；ETag 不变时仅续约缓存 TTL。

### `ModelsManager::list_collaboration_modes`

```rust
pub fn list_collaboration_modes(&self) -> Vec<CollaborationModeMask>
```

返回内置的协作模式预设列表（Plan 和 Default）。

## 接口/类型定义

### `RefreshStrategy`

```rust
pub enum RefreshStrategy {
    Online,          // 总是从网络获取
    Offline,         // 仅使用缓存
    OnlineIfUncached,// 缓存可用则用缓存，否则网络获取
}
```

控制模型列表的刷新行为，是调用方与 ModelsManager 交互的核心参数。

### `ModelsManagerConfig`

```rust
pub struct ModelsManagerConfig {
    pub model_context_window: Option<i64>,
    pub model_auto_compact_token_limit: Option<i64>,
    pub tool_output_token_limit: Option<usize>,
    pub base_instructions: Option<String>,
    pub personality_enabled: bool,
    pub model_supports_reasoning_summaries: Option<bool>,
    pub model_catalog: Option<ModelsResponse>,
}
```

用户侧的模型配置覆盖，通过 `with_config_overrides` 叠加到 `ModelInfo` 上。

### `CollaborationModesConfig`

```rust
pub struct CollaborationModesConfig {
    pub default_mode_request_user_input: bool,
}
```

协作模式的特性开关。`default_mode_request_user_input` 控制 Default 模式下是否启用 `request_user_input` 工具。

### `CatalogMode`（内部）

```rust
enum CatalogMode {
    Default, // 基于内置目录，允许缓存/网络刷新
    Custom,  // 调用方提供的目录，不可变
}
```

决定管理器的生命周期内是否允许通过网络更新模型目录。

## 配置项与默认值

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 缓存文件名 | `models_cache.json` | 存储在 `codex_home` 目录下 |
| 缓存 TTL | 300 秒（5 分钟） | 超过此时间的缓存视为过期 |
| 网络请求超时 | 5 秒 | `/models` 端点的请求超时 |
| 回退 context window | 272,000 | 未知模型的默认上下文窗口 |
| 回退 truncation policy | bytes / 10,000 | 未知模型的默认截断策略 |
| 回退 priority | 99 | 未知模型的默认排序优先级 |

## 边界 Case 与注意事项

- **认证路由**：只有 ChatGPT 认证模式或 provider 配置了命令式认证时，才会发起 `/models` 网络请求。纯 API Key 模式下依赖内置目录和缓存，不会主动拉取远端列表（`src/manager.rs:398-408`）

- **版本绑定的缓存失效**：缓存中记录了 `client_version`，客户端版本升级后旧缓存自动失效，确保新版本不会使用过时的模型元数据

- **模型合并而非替换**：`apply_remote_models` 以内置 `models.json` 为基底，远端模型按 slug 覆盖或追加。这意味着内置目录中有但远端没有的模型仍然保留

- **命名空间匹配的限制**：`find_model_by_namespaced_suffix` 仅支持单层命名空间（`custom/model-name`），不支持多层（`ns1/ns2/model-name`）。命名空间必须是 ASCII 字母数字加下划线

- **回退模型标记**：当模型 slug 在目录中找不到时，生成的 `ModelInfo` 会设置 `used_fallback_model_metadata = true`，下游可据此判断元数据是否可靠

- **遥测覆盖面**：每次 `/models` 请求都会发射两类遥测事件（`codex_otel.log_only` 和 `codex_otel.trace_safe`），并通过 feedback tags 上报认证环境信息，用于诊断认证失败等问题

- **协作模式的个性化模板**：Default 模式的 instructions 使用模板引擎渲染，包含 `KNOWN_MODE_NAMES`、`REQUEST_USER_INPUT_AVAILABILITY`、`ASKING_QUESTIONS_GUIDANCE` 三个动态占位符。Plan 模式使用静态指令且默认 reasoning effort 为 Medium

- **`model_presets.rs` 的遗留常量**：`HIDE_GPT5_1_MIGRATION_PROMPT_CONFIG` 等常量是旧版迁移提示的配置键，保留用于配置兼容性，硬编码的模型预设已被动态目录取代