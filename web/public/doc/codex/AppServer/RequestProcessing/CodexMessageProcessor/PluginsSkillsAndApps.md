# 插件、技能与应用连接器管理

## 概述与职责

本模块是 `CodexMessageProcessor` 中负责**插件（Plugin）、技能（Skill）和应用连接器（App Connector）** 管理的 RPC 处理集合。它位于 AppServer → RequestProcessing → CodexMessageProcessor 层级之下，为 IDE 扩展和桌面客户端提供插件市场浏览、安装/卸载、技能发现与配置、应用授权状态查询等能力。

在整体架构中，本模块属于 **AppServer** 的 **RequestProcessing** 子系统。同级模块包括 MessageProcessor（顶层请求路由）、BespokeEventHandling（事件翻译层）和 ThreadStateManagement（线程状态追踪）。MessageProcessor 将插件/技能/应用相关的 JSON-RPC 请求委托给 CodexMessageProcessor，由本模块中的各个处理函数完成具体业务逻辑。

本模块包含三个辅助子模块：
- **`apps_list_helpers`**：应用列表的合并、分页、通知工具函数
- **`plugin_app_helpers`**：插件关联应用的摘要加载与授权状态解析
- **`plugin_mcp_oauth`**：插件 MCP 服务器的后台静默 OAuth 登录

## 关键流程

### apps_list：应用连接器列表加载（cache-then-refresh 模式）

这是本模块中最复杂的流程，采用**先返回缓存、后台刷新、渐进通知**的模式：

1. 加载最新配置，检查 `Feature::Apps` 是否启用；若关闭直接返回空列表（`codex_message_processor.rs:5590-5624`）
2. 将实际加载工作 spawn 到独立 tokio task（`apps_list_task`）
3. 在 task 内部，先通过 `tokio::join!` **并发**读取两份缓存：`list_cached_accessible_connectors` 和 `list_cached_all_connectors`（`codex_message_processor.rs:5661-5664`）
4. 如果缓存存在，立即通过 `merge_loaded_apps` 合并后发送 `AppListUpdated` 通知，让客户端快速渲染初始列表
5. 同时 spawn 两个后台 task 分别从远端拉取最新的 accessible 和 directory 连接器列表，结果通过 `mpsc::unbounded_channel` 回传（`codex_message_processor.rs:5667-5687`）
6. 在一个事件循环中等待两个 task 完成，设有 90 秒超时（`APP_LIST_LOAD_TIMEOUT`）。每当一个 task 返回，重新合并数据并判断是否需要发送新的 `AppListUpdated` 通知（避免重复通知）（`codex_message_processor.rs:5713-5810`）
7. 当两个 task 都完成后，对最终合并结果执行分页（`paginate_apps`），返回 `AppsListResponse`

```rust
// codex_message_processor.rs:5661-5664
let (mut accessible_connectors, mut all_connectors) = tokio::join!(
    connectors::list_cached_accessible_connectors_from_mcp_tools(&config),
    connectors::list_cached_all_connectors(&config)
);
```

### plugin_list：已安装插件列表

1. 如果 `force_remote_sync` 为 true，先调用 `plugins_manager.sync_plugins_from_remote()` 同步远程插件状态，同步失败不阻塞，错误信息记入 `remote_sync_error`（`codex_message_processor.rs:5955-5985`）
2. 通过 `spawn_blocking` 调用 `list_marketplaces_for_config` 列出所有 marketplace 及其插件（`codex_message_processor.rs:5989-6050`）
3. 如果包含 OpenAI 官方策展市场（`OPENAI_CURATED_MARKETPLACE_NAME`），额外请求 `featured_plugin_ids`（`codex_message_processor.rs:6052-6071`）
4. 组装 `PluginListResponse` 返回，包含 marketplace 列表、加载错误、远端同步错误和推荐插件 ID

### plugin_read：插件详情

1. 通过 `spawn_blocking` 调用 `read_plugin_for_config` 读取插件元数据（`codex_message_processor.rs:6107-6126`）
2. 调用 `plugin_app_helpers::load_plugin_app_summaries` 加载插件关联的应用摘要及授权状态（`codex_message_processor.rs:6127-6128`）
3. 按产品限制过滤可见技能，组装 `PluginDetail`（含 summary、description、skills、apps、mcp_servers）返回

### plugin_install：插件安装

1. 根据 `force_remote_sync` 决定调用 `install_plugin_with_remote_sync` 还是 `install_plugin`（`codex_message_processor.rs:6236-6250`）
2. 安装成功后清除插件和技能缓存（`clear_plugin_related_caches`）
3. 检测新安装插件是否包含 MCP 服务器。如有，触发 MCP 刷新并启动后台 OAuth 静默登录（`codex_message_processor.rs:6266-6277`）
4. 检测新安装插件是否包含应用连接器。如有且 Apps 功能启用，并发加载全量和可访问连接器列表，通过 `plugin_apps_needing_auth` 计算需要用户授权的应用（`codex_message_processor.rs:6279-6337`）
5. 返回 `PluginInstallResponse`（含 `auth_policy` 和 `apps_needing_auth`）

### plugin_uninstall：插件卸载

1. 根据 `force_remote_sync` 选择远程同步卸载或本地卸载（`codex_message_processor.rs:6405-6418`）
2. 成功后清除缓存，返回空的 `PluginUninstallResponse`
3. 错误分类处理：`Config`、`Remote`、`Join`、`Store` 各有对应错误消息

### skills_list：技能列表聚合

1. 解析 `cwds` 参数（默认使用当前工作目录）和 `per_cwd_extra_user_roots`（每个 cwd 可附加额外用户根目录）（`codex_message_processor.rs:5814-5856`）
2. 对每个 cwd，加载配置层栈（`load_config_layers_state`），获取生效的技能根目录（含内置和插件提供的）（`codex_message_processor.rs:5888-5914`）
3. 调用 `skills_manager.skills_for_cwd_with_extra_user_roots` 加载技能，结合 `disabled_paths` 标注启用/禁用状态（`codex_message_processor.rs:5921-5930`）
4. 返回 `SkillsListResponse`，每个 cwd 一个 entry，包含 skills 和 errors

### skills_config_write：技能启用/禁用持久化

1. 接收 `path` 或 `name`（二选一），构建 `ConfigEdit::SetSkillConfig` 或 `ConfigEdit::SetSkillConfigByName`（`codex_message_processor.rs:6174-6191`）
2. 通过 `ConfigEditsBuilder` 写入 TOML 配置文件（`codex_message_processor.rs:6193-6196`）
3. 成功后清除插件和技能缓存

## 子模块详解

### apps_list_helpers

提供应用列表处理的四个纯工具函数（`apps_list_helpers.rs`）：

| 函数 | 职责 |
|------|------|
| `merge_loaded_apps` | 将 all_connectors 和 accessible_connectors 合并为统一列表，委托 `connectors::merge_connectors_with_accessible` |
| `should_send_app_list_updated_notification` | 判断是否需要发送渐进通知——当存在可访问连接器或两个列表均已加载时返回 true |
| `paginate_apps` | 基于 cursor + limit 的分页逻辑，cursor 超出范围返回错误 |
| `send_app_list_updated_notification` | 包装 `ServerNotification::AppListUpdated` 发送 |

### plugin_app_helpers

处理插件关联应用的授权状态解析（`plugin_app_helpers.rs`）：

**`load_plugin_app_summaries`**（`plugin_app_helpers.rs:10-71`）：用于 `plugin_read` 场景。
1. 加载全量连接器列表（优先网络，失败回退缓存）
2. 通过 `connectors_for_plugin_apps` 过滤出属于该插件的连接器
3. 加载可访问连接器列表，如果 `codex_apps_ready` 为 false 或加载失败，直接返回不带授权状态的摘要
4. 通过比对可访问 ID 集合，为每个连接器设置 `needs_auth` 标志

**`plugin_apps_needing_auth`**（`plugin_app_helpers.rs:73-107`）：用于 `plugin_install` 场景。
- 当 `codex_apps_ready` 为 false 时返回空列表（因为无法判断授权状态）
- 过滤出属于插件且不在可访问列表中的连接器，标记为 `needs_auth: true`

### plugin_mcp_oauth

为插件的 MCP 服务器执行后台静默 OAuth 登录（`plugin_mcp_oauth.rs`）：

**`start_plugin_mcp_oauth_logins`**（`plugin_mcp_oauth.rs:18-94`）在插件安装后被调用：

1. 遍历插件声明的每个 MCP 服务器
2. 通过 `oauth_login_support` 检测该服务器是否支持 OAuth。不支持或未知状态则跳过
3. 解析 OAuth scopes（合并显式配置、服务器配置和发现的 scopes）
4. 为每个需要登录的服务器 spawn 独立的 tokio task 执行 `perform_oauth_login_silent`
5. 首次尝试失败时，如果 `should_retry_without_scopes` 返回 true，则不带 scopes 重试一次
6. 完成后发送 `McpServerOauthLoginCompleted` 通知（含 success/error 状态），客户端据此更新 UI

```rust
// plugin_mcp_oauth.rs:47-59 — 后台静默 OAuth 首次尝试
tokio::spawn(async move {
    let first_attempt = perform_oauth_login_silent(
        &name,
        &oauth_config.url,
        store_mode,
        oauth_config.http_headers.clone(),
        oauth_config.env_http_headers.clone(),
        &resolved_scopes.scopes,
        server.oauth_resource.as_deref(),
        callback_port,
        callback_url.as_deref(),
    )
    .await;
    // ...
});
```

## 函数签名与参数说明

### 主要 RPC 处理函数

| 函数 | 参数类型 | 响应类型 |
|------|----------|----------|
| `apps_list` | `AppsListParams { cursor, limit, thread_id, force_refetch }` | `AppsListResponse { data, next_cursor }` |
| `skills_list` | `SkillsListParams { cwds, force_reload, per_cwd_extra_user_roots }` | `SkillsListResponse { data: Vec<SkillsListEntry> }` |
| `skills_config_write` | `SkillsConfigWriteParams { path, name, enabled }` | `SkillsConfigWriteResponse { effective_enabled }` |
| `plugin_list` | `PluginListParams { cwds, force_remote_sync }` | `PluginListResponse { marketplaces, marketplace_load_errors, remote_sync_error, featured_plugin_ids }` |
| `plugin_read` | `PluginReadParams { marketplace_path, plugin_name }` | `PluginReadResponse { plugin: PluginDetail }` |
| `plugin_install` | `PluginInstallParams { marketplace_path, plugin_name, force_remote_sync }` | `PluginInstallResponse { auth_policy, apps_needing_auth }` |
| `plugin_uninstall` | `PluginUninstallParams { plugin_id, force_remote_sync }` | `PluginUninstallResponse {}` |

### 辅助转换函数

- **`skills_to_info`**（`codex_message_processor.rs:8141-8185`）：将内部 `SkillMetadata` 转换为协议层 `SkillMetadata`，包含 name、description、interface、dependencies、path、scope、enabled
- **`plugin_skills_to_info`**（`codex_message_processor.rs:8187-8211`）：类似但输出 `SkillSummary`（较精简，用于 plugin_read 响应）
- **`plugin_interface_to_info`**（`codex_message_processor.rs:8213-8232`）：将内部 `PluginManifestInterface` 转换为协议层 `PluginInterface`，含 UI 展示信息（logo、品牌色、截图等）

## 关键类型定义

### `AppListLoadResult`

```rust
// codex_message_processor.rs:389-392
enum AppListLoadResult {
    Accessible(Result<Vec<AppInfo>, String>),
    Directory(Result<Vec<AppInfo>, String>),
}
```

`apps_list_task` 内部用于区分两个并发加载任务的完成通知。通过 mpsc channel 传递。

### `CodexMessageProcessor` 关键字段

| 字段 | 类型 | 用途 |
|------|------|------|
| `thread_manager` | `Arc<ThreadManager>` | 提供 `plugins_manager()` 和 `skills_manager()` 访问入口 |
| `auth_manager` | `Arc<AuthManager>` | 插件远程同步和应用功能判断所需的认证信息 |
| `outgoing` | `Arc<OutgoingMessageSender>` | 发送 JSON-RPC 响应和通知 |
| `config` | `Arc<Config>` | 基础配置，部分场景下通过 `load_latest_config` 重新加载 |

## 配置项与默认值

- **`APP_LIST_LOAD_TIMEOUT`**：应用列表加载超时，硬编码为 **90 秒**（`codex_message_processor.rs:352`）
- **`Feature::Apps`**：功能开关，控制 apps_list 是否返回数据
- **`Feature::Plugins`**：功能开关，影响 skills_list 中插件提供的技能根目录是否生效
- **`config.mcp_oauth_credentials_store_mode`**：MCP OAuth 凭证存储模式
- **`config.mcp_oauth_callback_port` / `config.mcp_oauth_callback_url`**：OAuth 回调配置

## 边界 Case 与注意事项

- **apps_list 的渐进通知去重**：通过 `last_notified_apps` 跟踪上次通知的数据，相同数据不重复通知（`codex_message_processor.rs:5792`）
- **force_refetch 期间的中间状态**：当 `force_refetch` 为 true 且只有一个 task 完成时，使用缓存的 all_connectors 而非部分加载结果，避免向客户端展示不完整数据（`codex_message_processor.rs:5768-5780`）
- **plugin_list 远程同步失败不阻塞**：`force_remote_sync` 失败时回退到本地 marketplace 状态，错误通过 `remote_sync_error` 字段透传给客户端
- **plugin_apps_needing_auth 在 codex_apps 未就绪时返回空**：避免在 MCP 工具链未完全启动时给出错误的授权判断（`plugin_app_helpers.rs:79-81`）
- **MCP OAuth 静默登录的 scope 重试机制**：首次带 scopes 登录失败后，如果 `should_retry_without_scopes` 判定可重试，会去掉 scopes 再试一次（`plugin_mcp_oauth.rs:62-76`）
- **skills_list 的 extra_user_roots 校验**：所有路径必须是绝对路径，且对应的 cwd 必须在请求的 cwds 列表中（`codex_message_processor.rs:5829-5856`）
- **skills_config_write 的互斥参数**：`path` 和 `name` 必须恰好提供一个，否则返回 `INVALID_PARAMS_ERROR_CODE`（`codex_message_processor.rs:6174-6191`）
- **缓存清除时机**：`plugin_install`、`plugin_uninstall`、`skills_config_write` 成功后都会调用 `clear_plugin_related_caches`，同时清除 plugins_manager 和 skills_manager 的缓存