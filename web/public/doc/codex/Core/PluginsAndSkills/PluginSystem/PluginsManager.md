# PluginsManager

## 概述与职责

`PluginsManager` 是 Codex 插件子系统的核心编排器，位于 `Core > PluginsAndSkills > PluginSystem` 层级中。它管理插件的完整生命周期——从安装、加载、启用/禁用，到与远端 ChatGPT 后端同步状态。

在系统架构中，`PluginsManager` 是 `PluginSystem` 的中枢组件。上游的 `SessionEngine` 通过它加载插件和 skill；同级模块 `Skills` 消费它计算出的 `effective_skill_roots`；`McpToolIntegration` 通过它获取 MCP 服务器配置。它向下依赖 `PluginStore`（本地缓存）、`marketplace`（市场目录解析）、`remote`（ChatGPT 后端 API）和 `startup_sync`（curated 仓库同步）等子模块。

定义于 `codex-rs/core/src/plugins/manager.rs:311-319`。

## 关键数据结构

### `PluginsManager`

```rust
pub struct PluginsManager {
    codex_home: PathBuf,
    store: PluginStore,
    featured_plugin_ids_cache: RwLock<Option<CachedFeaturedPluginIds>>,
    cached_enabled_outcome: RwLock<Option<PluginLoadOutcome>>,
    remote_sync_lock: Mutex<()>,
    restriction_product: Option<Product>,
    analytics_events_client: RwLock<Option<AnalyticsEventsClient>>,
}
```

| 字段 | 说明 |
|------|------|
| `codex_home` | Codex 主目录路径，所有缓存和配置相对于此路径定位 |
| `store` | `PluginStore` 实例，管理本地插件缓存（安装、卸载、版本查询） |
| `featured_plugin_ids_cache` | 精选插件 ID 列表的内存缓存，TTL 为 3 小时 |
| `cached_enabled_outcome` | 已加载插件结果的缓存，避免重复解析配置 |
| `remote_sync_lock` | 异步互斥锁，确保远端同步操作的串行化 |
| `restriction_product` | 产品限制标识（如 `Product::Codex`），用于在市场准入阶段过滤不属于当前产品的插件 |
| `analytics_events_client` | 可选的分析事件客户端，用于追踪插件安装/卸载遥测 |

### 请求/响应类型

- **`PluginInstallRequest`** — 包含 `plugin_name` 和 `marketplace_path`，标识要安装的插件
- **`PluginInstallOutcome`** — 安装结果：`plugin_id`、`plugin_version`、`installed_path`、`auth_policy`
- **`PluginReadRequest`** / **`PluginReadOutcome`** — 读取单个插件详情
- **`PluginDetail`** — 插件完整信息：ID、名称、描述、来源、策略、接口定义、技能列表、已禁用的技能路径、App connector 列表、MCP 服务器名称列表、安装/启用状态
- **`ConfiguredMarketplace`** / **`ConfiguredMarketplacePlugin`** — 市场列表及其中每个插件的安装/启用状态
- **`RemotePluginSyncResult`** — 远端同步结果：新安装/启用/禁用/卸载的插件 ID 列表

## 关键流程

### 1. 构造与初始化

通过 `PluginsManager::new(codex_home)` 创建实例，默认 `restriction_product` 为 `Product::Codex`。也可使用 `new_with_restriction_product()` 指定自定义产品限制。产品限制在市场准入时执行——listing、install 和 curated refresh 均会检查，但运行时加载已安装插件时不再重复过滤（`manager.rs:330-334`）。

### 2. 从配置加载插件

`plugins_for_config(config)` 是最常用的入口：

1. 检查 `Feature::Plugins` 是否启用，未启用则返回空结果
2. 如果缓存命中且非强制刷新，直接返回缓存的 `PluginLoadOutcome`
3. 调用 `load_plugins_from_layer_stack()` 遍历配置层栈中的 `[plugins]` 表（仅从用户层读取），按 config key 排序后逐一调用 `load_plugin()`
4. 每个插件加载时：解析 `PluginId` → 查找 `PluginStore` 中的活跃安装路径 → 读取 `.codex-plugin/plugin.json` manifest → 扫描 skill 目录 → 加载 `.mcp.json` 中的 MCP 服务器 → 加载 `.app.json` 中的 App connector
5. 构建 `PluginLoadOutcome` 并写入缓存

> 源码位置：`manager.rs:366-395`（`plugins_for_config`），`manager.rs:1213-1250`（`load_plugins_from_layer_stack`），`manager.rs:1390-1487`（`load_plugin`）

### 3. 插件安装

`install_plugin(request)` 流程：

1. 调用 `resolve_marketplace_plugin()` 从市场目录中解析目标插件，检查产品限制
2. 对 curated 市场插件，读取本地 curated 仓库的 SHA 作为版本号
3. 通过 `tokio::task::spawn_blocking` 在阻塞线程中执行 `store.install()`（或 `install_with_version()`）
4. 通过 `ConfigService` 将 `plugins.<plugin_key>.enabled = true` 写入用户配置
5. 发送安装遥测事件

带远端同步的版本 `install_plugin_with_remote_sync()` 在本地安装前先调用 `enable_remote_plugin()` 通知 ChatGPT 后端。

> 源码位置：`manager.rs:497-589`

### 4. 插件卸载

`uninstall_plugin(plugin_id)` 流程：

1. 解析 `PluginId`
2. 在阻塞线程中执行 `store.uninstall()`
3. 通过 `ConfigEditsBuilder` 清除配置中的插件条目
4. 发送卸载遥测事件

> 源码位置：`manager.rs:591-642`

### 5. 远端同步（Remote Sync）

`sync_plugins_from_remote(config, auth, additive_only)` 是最复杂的流程，负责将本地状态与 ChatGPT 后端对齐：

1. 获取 `remote_sync_lock`，确保同一时刻只有一个同步操作
2. 调用 `fetch_remote_plugin_status()` 获取远端插件状态列表
3. 从本地 curated 市场加载插件目录，构建 `local_plugins` 列表（含当前启用状态和已安装版本）
4. 对比远端与本地状态：
   - 远端已安装但本地未安装 → 执行本地安装 + 启用配置写入
   - 远端未安装且 `additive_only = false` → 执行本地卸载 + 清除配置
5. 批量执行 store 操作和配置编辑
6. 完成后清除缓存

> 源码位置：`manager.rs:644-845`

### 6. 市场列表

`list_marketplaces_for_config(config, additional_roots)` 列出所有可用市场及插件：

1. 合并传入的 `additional_roots` 与本地 curated 仓库路径
2. 调用 `list_marketplaces()` 扫描市场目录
3. 对每个插件附加产品限制过滤、安装状态和启用状态
4. 为 curated 市场注入显示名称 "OpenAI Curated"
5. 去重（相同 `<plugin>@<marketplace>` 键只保留首次出现的）

> 源码位置：`manager.rs:847-910`

### 7. 读取单个插件详情

`read_plugin_for_config(config, request)` 读取市场中指定插件的完整信息——manifest、skill 列表、MCP 服务器、App connector、安装/启用状态。

> 源码位置：`manager.rs:912-1004`

### 8. 启动任务

`maybe_start_plugin_startup_tasks_for_config(config, auth_manager)` 在 Codex 启动时触发三个后台任务：

1. **Curated 仓库同步**：在独立线程中执行 `sync_openai_plugins_repo()`，完成后刷新本地缓存（`start_curated_repo_sync`，`manager.rs:1037-1077`）。通过 `AtomicBool` `CURATED_REPO_SYNC_STARTED` 保证全局只执行一次
2. **远端插件同步**：调用 `start_startup_remote_plugin_sync_once()`
3. **精选 ID 预热**：`tokio::spawn` 异步预热 `featured_plugin_ids` 缓存

> 源码位置：`manager.rs:1006-1035`

### 9. Effective Skill Roots 计算

`effective_skill_roots_for_layer_stack(config_layer_stack, plugins_feature_enabled)` 从配置层栈重新加载插件并提取所有有效的 skill 目录路径，不使用缓存。供 `SkillsWatcher` 等外部模块调用以确定需要监控的目录。

> 源码位置：`manager.rs:411-421`

## 函数签名与参数说明

### 核心方法（`impl PluginsManager`）

| 方法 | 签名 | 说明 |
|------|------|------|
| `new` | `(codex_home: PathBuf) -> Self` | 创建实例，默认限制 `Product::Codex` |
| `new_with_restriction_product` | `(codex_home: PathBuf, restriction_product: Option<Product>) -> Self` | 创建实例，指定产品限制 |
| `plugins_for_config` | `(&self, config: &Config) -> PluginLoadOutcome` | 根据配置加载已启用的插件（带缓存） |
| `clear_cache` | `(&self)` | 清除插件加载缓存和精选 ID 缓存 |
| `effective_skill_roots_for_layer_stack` | `(&self, stack: &ConfigLayerStack, enabled: bool) -> Vec<PathBuf>` | 计算 skill 根目录路径列表 |
| `featured_plugin_ids_for_config` | `async (&self, config: &Config, auth: Option<&CodexAuth>) -> Result<Vec<String>, RemotePluginFetchError>` | 获取精选插件 ID 列表（带 3 小时缓存） |
| `install_plugin` | `async (&self, request: PluginInstallRequest) -> Result<PluginInstallOutcome, PluginInstallError>` | 本地安装插件 |
| `install_plugin_with_remote_sync` | `async (&self, config, auth, request) -> Result<PluginInstallOutcome, PluginInstallError>` | 安装插件并通知远端 |
| `uninstall_plugin` | `async (&self, plugin_id: String) -> Result<(), PluginUninstallError>` | 本地卸载插件 |
| `uninstall_plugin_with_remote_sync` | `async (&self, config, auth, plugin_id) -> Result<(), PluginUninstallError>` | 卸载插件并通知远端 |
| `sync_plugins_from_remote` | `async (&self, config, auth, additive_only: bool) -> Result<RemotePluginSyncResult, PluginRemoteSyncError>` | 从远端同步插件状态 |
| `list_marketplaces_for_config` | `(&self, config, additional_roots) -> Result<ConfiguredMarketplaceListOutcome, MarketplaceError>` | 列出所有市场及插件 |
| `read_plugin_for_config` | `(&self, config, request: &PluginReadRequest) -> Result<PluginReadOutcome, MarketplaceError>` | 读取单个插件详情 |
| `maybe_start_plugin_startup_tasks_for_config` | `(self: &Arc<Self>, config, auth_manager)` | 启动后台同步任务 |

### 独立公开函数

| 函数 | 说明 |
|------|------|
| `load_plugin_mcp_servers(plugin_root: &Path) -> HashMap<String, McpServerConfig>` | 从插件根目录加载 MCP 服务器配置 |
| `load_plugin_apps(plugin_root: &Path) -> Vec<AppConnectorId>` | 从插件根目录加载 App connector 列表 |
| `plugin_telemetry_metadata_from_root(plugin_id, plugin_root) -> PluginTelemetryMetadata` | 从插件根目录构建遥测元数据 |
| `installed_plugin_telemetry_metadata(codex_home, plugin_id) -> PluginTelemetryMetadata` | 从已安装插件构建遥测元数据 |

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|------|------|
| `DEFAULT_SKILLS_DIR_NAME` | `"skills"` | 插件内 skill 目录的默认名称 |
| `DEFAULT_MCP_CONFIG_FILE` | `".mcp.json"` | MCP 服务器配置的默认文件名 |
| `DEFAULT_APP_CONFIG_FILE` | `".app.json"` | App connector 配置的默认文件名 |
| `OPENAI_CURATED_MARKETPLACE_NAME` | `"openai-curated"` | curated 市场内部名称 |
| `OPENAI_CURATED_MARKETPLACE_DISPLAY_NAME` | `"OpenAI Curated"` | curated 市场显示名称 |
| `FEATURED_PLUGIN_IDS_CACHE_TTL` | 3 小时 | 精选插件 ID 缓存过期时间 |

插件在用户配置文件（`config.toml`）中以 `[plugins."<name>@<marketplace>"]` 格式声明，包含 `enabled` 布尔字段。整个插件功能受 Feature Flag `plugins` 控制。

## 错误类型

- **`PluginInstallError`** — 安装失败：市场解析错误、远端通信错误、Store 存储错误、配置写入错误、线程 join 错误
- **`PluginUninstallError`** — 卸载失败：无效 plugin ID、远端通信错误、Store 错误、配置错误、线程 join 错误
- **`PluginRemoteSyncError`** — 远端同步失败：认证缺失/不支持、请求失败、响应解析错误、本地市场不可用、远端市场未知、重复远端插件、远端插件本地不存在等

所有错误类型均实现了 `thiserror::Error`，提供了 `is_invalid_request()` 辅助方法用于判断是否为客户端请求错误。

## 边界 Case 与注意事项

- **产品限制只在准入时检查**：`restriction_product` 在 listing、install 和 curated refresh 时过滤插件，但已准入的插件在运行时加载时不会被重新过滤。这意味着同一个 `CODEX_HOME` 应只被一个产品使用（`manager.rs:330-334`）
- **Curated 仓库同步全局只执行一次**：通过 `AtomicBool` `CURATED_REPO_SYNC_STARTED` 和 `swap(true, SeqCst)` 保证，失败时会重置为 `false` 以允许重试
- **远端同步串行化**：`remote_sync_lock`（`tokio::sync::Mutex`）确保同一时刻只有一个远端同步任务执行
- **缓存 poisoning 容忍**：所有 `RwLock` 的 `read()`/`write()` 调用均通过 `Err(err) => err.into_inner()` 处理 poisoned 锁，保证即使某个线程 panic 也不会导致后续操作永久阻塞
- **MCP 服务器去重**：在 `load_plugins_from_layer_stack` 中跨插件检测重名 MCP 服务器并警告；在单个插件内的多个配置文件中，后定义的会覆盖先前的同名服务器
- **远端 `enabled = false` 视同卸载**：当前同步实现中，远端返回 `enabled = false` 的插件不会进入 `remote_installed_plugin_names` 集合，效果等同于本地卸载（`manager.rs:737-742`）
- **精选 ID 缓存按用户维度区分**：缓存键包含 `chatgpt_base_url`、`account_id`、`chatgpt_user_id` 和 `is_workspace_account`，切换账户后缓存自动失效
- **`additive_only` 模式**：`sync_plugins_from_remote` 的此参数为 `true` 时，只执行安装和启用操作，不执行卸载，适用于启动时的非破坏性同步