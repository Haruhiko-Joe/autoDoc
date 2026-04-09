# MCP 服务器管理、模型/协作模式发现与实验性功能列表

## 概述与职责

本模块是 `CodexMessageProcessor` 中负责 **MCP 服务器管理**、**模型与协作模式发现**、以及**实验性功能列表**的一组 RPC 方法处理器。它位于 AppServer → RequestProcessing → CodexMessageProcessor 层级中，属于 `CodexMessageProcessor` 这个大型处理器的一部分，专门处理与 MCP 连接状态、模型枚举和 feature flag 相关的客户端请求。

在整体架构中，AppServer 作为 IDE 插件和桌面应用与 Codex agent 之间的桥梁，本模块为客户端提供了以下能力：
- 刷新和管理 MCP 服务器连接
- 通过 OAuth 完成 MCP 服务器身份验证
- 查询可用模型和协作模式
- 列出实验性功能的状态

同级模块包括 MessageProcessor（顶层请求路由）、BespokeEventHandling（事件翻译层）和 ThreadStateManagement（线程状态追踪）。

---

## 关键流程

### MCP 服务器刷新流程

1. `mcp_server_refresh` 接收客户端的刷新请求，调用 `load_latest_config` 获取最新配置（`codex_message_processor.rs:4951-4967`）
2. 委托给 `queue_mcp_server_refresh_for_config`，该方法：
   - 从 `thread_manager.mcp_manager().configured_servers(config)` 获取配置中声明的所有 MCP 服务器
   - 将服务器列表和 OAuth 凭证存储模式序列化为 JSON，构建 `McpServerRefreshConfig`
   - 调用 `thread_manager.refresh_mcp_servers(refresh_config)` 提交刷新（`codex_message_processor.rs:4969-5009`）
3. 刷新请求以 **per-thread 队列** 的方式分发——每个线程在下次活跃 turn 时才重建 MCP 连接，避免对未恢复的线程做无用功

### MCP 服务器 OAuth 登录流程

`mcp_server_oauth_login`（`codex_message_processor.rs:5011-5118`）实现了完整的浏览器交互式 OAuth 流程：

1. 加载最新配置，从 `configured_servers` 中查找目标服务器（按 `name` 参数匹配）
2. **传输类型校验**：仅支持 `StreamableHttp` 类型的 MCP 服务器，其他类型返回错误
3. **Scope 发现与解析**：
   - 若客户端未指定 `scopes` 且服务器配置中也无 `scopes`，调用 `discover_supported_scopes` 自动发现
   - 使用 `resolve_oauth_scopes` 合并客户端指定、服务器配置和发现的 scope
4. 调用 `perform_oauth_login_return_url` 发起 OAuth 流程，传入服务器 URL、凭证存储模式、HTTP headers、scope 列表、`oauth_resource`、超时、回调端口/URL 等参数
5. 成功时立即返回 `authorization_url` 给客户端（供浏览器打开），同时 **spawn 一个后台 tokio 任务** 等待 OAuth 回调完成
6. 后台任务完成后通过 `McpServerOauthLoginCompleted` 通知客户端登录结果（成功或失败及错误信息）

### MCP 服务器状态收集流程

`list_mcp_server_status`（`codex_message_processor.rs:5120-5142`）将实际工作 spawn 到后台任务 `list_mcp_server_status_task`：

1. 加载最新配置，生成 `mcp_config` 和认证信息
2. 调用 `collect_mcp_snapshot` 从所有已加载线程中收集 MCP 快照（工具、资源、资源模板、认证状态）
3. **工具归属解析**：不直接使用 `group_tools_by_server()`，而是基于原始服务器名称的 sanitized prefix 匹配。原因是 qualified tool name 会经过 Responses API 的清理转换（如 `some-server` → `mcp__some_server__`），直接用原始服务器名生成 prefix 可以正确处理含连字符的名称（`codex_message_processor.rs:5159-5199`）
4. **名称空间冲突处理**：当多个服务器名称 normalize 到相同 prefix 时（如 `some-server` 和 `some_server`），跳过工具归属以避免歧义
5. 合并所有来源的服务器名称（用户配置、运行时有效服务器、认证状态、资源），排序去重后分页返回

### 模型列表流程

`list_models`（`codex_message_processor.rs:4750-4813`）是一个静态函数：

1. 调用 `supported_models(thread_manager, include_hidden)` 获取完整模型列表
2. 实现基于数字 cursor 的分页逻辑：
   - `limit` 默认为总数，最小值 clamp 到 1
   - `cursor` 是字符串形式的起始索引，无效 cursor 返回错误
   - cursor 超出范围时返回错误而非空结果
3. 返回 `ModelListResponse { data, next_cursor }`

### 协作模式列表

`list_collaboration_modes`（`codex_message_processor.rs:4815-4829`）直接委托给 `thread_manager.list_collaboration_modes()`，将结果通过 `Into::into` 转为协议类型后一次性返回，**无分页**。

### 实验性功能列表

`experimental_feature_list`（`codex_message_processor.rs:4831-4939`）：

1. 加载最新配置
2. 遍历全局 `FEATURES` 常量（来自 `codex_features` crate），为每个 feature spec 构建 `ApiExperimentalFeature`：
   - 根据 `Stage` 枚举映射到 API 层的 stage（`Experimental` → `Beta`，`UnderDevelopment`，`Stable`，`Deprecated`，`Removed`）
   - `Experimental` 阶段额外提取 `display_name`、`description`、`announcement`
   - `enabled` 字段从当前配置的 `config.features.enabled(spec.id)` 动态获取
   - 包含 `default_enabled` 标记
3. 使用与模型列表相同的 cursor-based 分页模式

---

## 函数签名与参数说明

### `async fn mcp_server_refresh(&self, request_id: ConnectionRequestId, _params: Option<()>)`

触发 MCP 服务器连接的全量刷新。无需参数，返回空的 `McpServerRefreshResponse`。

> 源码位置：`codex_message_processor.rs:4951-4967`

### `async fn queue_mcp_server_refresh_for_config(&self, config: &Config) -> Result<(), JSONRPCErrorError>`

内部方法，构建有效 MCP 服务器列表并提交刷新到 `ThreadManager`。

- **config**：最新加载的配置对象
- 返回 `Ok(())` 或序列化失败时的 JSON-RPC 错误

> 源码位置：`codex_message_processor.rs:4969-5009`

### `async fn mcp_server_oauth_login(&self, request_id: ConnectionRequestId, params: McpServerOauthLoginParams)`

发起 MCP 服务器的 OAuth 浏览器登录流程。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 目标 MCP 服务器名称（必须匹配配置中的 key） |
| `scopes` | `Option<Vec<String>>` | 客户端指定的 OAuth scope，可选 |
| `timeout_secs` | `Option<u64>` | OAuth 回调等待超时（秒），可选 |

- 同步返回 `McpServerOauthLoginResponse { authorization_url }`
- 异步通过 `McpServerOauthLoginCompleted` 通知最终结果

> 源码位置：`codex_message_processor.rs:5011-5118`

### `async fn list_mcp_server_status(&self, request_id: ConnectionRequestId, params: ListMcpServerStatusParams)`

收集所有 MCP 服务器的连接状态快照，在后台任务中执行。

| 参数 | 类型 | 说明 |
|------|------|------|
| `cursor` | `Option<String>` | 分页游标（数字索引的字符串形式） |
| `limit` | `Option<u32>` | 每页返回数量 |

返回 `ListMcpServerStatusResponse`，每个 `McpServerStatus` 包含：`name`、`tools`、`resources`、`resource_templates`、`auth_status`。

> 源码位置：`codex_message_processor.rs:5120-5276`

### `async fn list_models(outgoing, thread_manager, request_id, params: ModelListParams)`

静态方法，列出可用模型。

| 参数 | 类型 | 说明 |
|------|------|------|
| `limit` | `Option<u32>` | 每页返回数量，默认全部 |
| `cursor` | `Option<String>` | 分页游标 |
| `include_hidden` | `Option<bool>` | 是否包含隐藏模型，默认 `false` |

> 源码位置：`codex_message_processor.rs:4750-4813`

### `async fn list_collaboration_modes(outgoing, thread_manager, request_id, params: CollaborationModeListParams)`

静态方法，列出所有可用的协作模式预设。参数为空结构体，无分页，一次返回全部。

> 源码位置：`codex_message_processor.rs:4815-4829`

### `async fn experimental_feature_list(&self, request_id, params: ExperimentalFeatureListParams)`

列出所有实验性功能标记及其状态。支持 `cursor`/`limit` 分页。

> 源码位置：`codex_message_processor.rs:4831-4939`

### `async fn mock_experimental_method(&self, request_id, params: MockExperimentalMethodParams)`

测试端点，直接回显输入的 `value` 字段。用于验证实验性 API 的标注和路由机制。

> 源码位置：`codex_message_processor.rs:4941-4949`

---

## 接口/类型定义

本模块主要使用来自 `codex_app_server_protocol` 的协议类型：

| 类型 | 用途 |
|------|------|
| `ModelListParams` / `ModelListResponse` | 模型列表请求/响应 |
| `CollaborationModeListParams` / `CollaborationModeListResponse` | 协作模式列表请求/响应 |
| `ExperimentalFeatureListParams` / `ExperimentalFeatureListResponse` | 功能标记列表请求/响应 |
| `ApiExperimentalFeature` | 单个功能标记的完整描述（name, stage, display_name, description, announcement, enabled, default_enabled） |
| `ApiExperimentalFeatureStage` | 功能阶段枚举：`Beta`, `UnderDevelopment`, `Stable`, `Deprecated`, `Removed` |
| `McpServerOauthLoginParams` / `McpServerOauthLoginResponse` | OAuth 登录请求/响应 |
| `McpServerOauthLoginCompletedNotification` | OAuth 完成的异步通知（name, success, error） |
| `McpServerRefreshResponse` | 刷新响应（空结构体） |
| `ListMcpServerStatusParams` / `ListMcpServerStatusResponse` | MCP 状态请求/响应 |
| `McpServerStatus` | 单个服务器状态（name, tools, resources, resource_templates, auth_status） |
| `MockExperimentalMethodParams` / `MockExperimentalMethodResponse` | 测试端点的 echo 请求/响应 |

来自 `codex_features` 的核心类型：
- `FEATURES`：全局功能定义数组
- `Stage`：功能阶段枚举（`Experimental { name, menu_description, announcement }`, `UnderDevelopment`, `Stable`, `Deprecated`, `Removed`）

---

## 关键外部依赖

| 来源 crate | 使用的函数/类型 | 用途 |
|-------------|-----------------|------|
| `codex_mcp::mcp` | `collect_mcp_snapshot`, `effective_mcp_servers`, `qualified_mcp_tool_name_prefix` | MCP 状态收集与工具名称解析 |
| `codex_mcp::mcp::auth` | `discover_supported_scopes`, `resolve_oauth_scopes` | OAuth scope 自动发现与合并 |
| `codex_rmcp_client` | `perform_oauth_login_return_url` | 执行实际的 OAuth 浏览器登录流程 |
| `codex_features` | `FEATURES`, `Stage` | 实验性功能定义与阶段分类 |
| `crate::models` | `supported_models` | 查询可用模型列表 |
| `codex_core` | `ThreadManager` | MCP 刷新提交、协作模式查询 |

---

## 边界 Case 与注意事项

- **分页 cursor 一致性**：`list_models`、`experimental_feature_list` 和 `list_mcp_server_status` 都使用相同的 cursor-based 分页模式。cursor 是数字索引的字符串表示，`limit` 最小 clamp 到 1 防止零步长的无限分页。cursor 超出 `total` 时返回错误而非空页。

- **OAuth 仅限 StreamableHttp**：`mcp_server_oauth_login` 明确要求服务器传输类型为 `StreamableHttp`，`Stdio` 或其他类型会直接返回 `INVALID_REQUEST_ERROR_CODE`。

- **工具名称 sanitization 冲突**：MCP 状态收集中，如果两个服务器名称（如 `some-server` 和 `some_server`）normalize 到相同的 `mcp__some_server__` prefix，则这两个服务器的 `tools` 字段都会返回空 map，避免错误归属。

- **MCP 刷新是惰性的**：调用 `mcp_server_refresh` 不会立即重连所有 MCP 服务器，而是将刷新配置排入队列，各线程在下次活跃 turn 时才执行实际重连。

- **OAuth 登录是异步两阶段的**：同步阶段返回 `authorization_url`，异步阶段通过 `ServerNotification` 通知结果。客户端需要监听 `McpServerOauthLoginCompleted` 通知来获取最终状态。

- **`list_mcp_server_status` 在后台任务中运行**：该方法 spawn 一个独立的 tokio 任务来执行快照收集，避免阻塞主处理循环。

- **`list_collaboration_modes` 无分页**：与其他列表方法不同，协作模式一次返回全部结果。

- **Stage 映射**：`codex_features::Stage::Experimental` 在 API 层映射为 `Beta`（而非 `Experimental`），这是一个值得注意的命名差异。