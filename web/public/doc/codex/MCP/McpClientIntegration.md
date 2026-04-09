# MCP 客户端集成层（codex-mcp）

## 概述与职责

`codex-mcp` 是 Codex 系统中 **MCP（Model Context Protocol）客户端** 的高层集成 crate。它位于 MCP 子系统内，是 Core 与外部 MCP 服务器之间的桥梁。在整体架构中，MCP 节点同时包含客户端（本模块）和服务端两部分；本模块专注于客户端侧——发现、连接、聚合来自多个外部 MCP 服务器的工具、资源和资源模板，并将其统一为一份快照（`McpListToolsResponseEvent`）供 Codex 代理核心消费。

同级兄弟模块（MCP 服务端）负责将 Codex 自身暴露为 MCP 工具提供者，两者共同构成完整的 MCP 集成。

本 crate 的核心职责包括：

- **连接管理**：通过 `McpConnectionManager` 维护多个 MCP 服务器的客户端连接（Stdio 和 StreamableHttp 两种传输方式）
- **工具/资源聚合**：从所有已连接服务器收集工具、资源、资源模板，并以全限定名统一索引
- **认证状态计算**：为每个服务器计算 OAuth 认证状态
- **ChatGPT Apps 集成**：内置对 ChatGPT Apps MCP 服务器的特殊处理，包括工具缓存和 connector 过滤
- **Skill 依赖解析**：分析 Skill 声明的 MCP 依赖，识别尚未安装的服务器
- **快照生成**：生产统一的 MCP 快照供代理核心使用

## 关键流程

### 1. MCP 快照收集流程（`collect_mcp_snapshot`）

这是本模块最核心的入口函数，完整流程如下：

1. 调用 `effective_mcp_servers()` 合并用户配置的 MCP 服务器和内置 ChatGPT Apps 服务器（`src/mcp/mod.rs:282-332`）
2. 若无服务器配置，直接返回空快照
3. 并行计算所有服务器的认证状态（`compute_auth_statuses`）
4. 构造 `SandboxState`（默认只读策略），创建 `McpConnectionManager`
5. 通过 `collect_mcp_snapshot_from_manager()` 并发调用 `list_all_tools()`、`list_all_resources()`、`list_all_resource_templates()`（`src/mcp/mod.rs:367-371`）
6. 将 rmcp 原生类型转换为 Codex 协议类型（`Tool`、`Resource`、`ResourceTemplate`），过滤转换失败的条目
7. 组装为 `McpListToolsResponseEvent` 返回
8. 取消连接管理器的 cancel token，清理资源

### 2. 服务器连接与启动流程（`McpConnectionManager::new`）

`McpConnectionManager::new()` 是有状态的构造器，负责并行启动所有 MCP 服务器连接（`src/mcp_connection_manager.rs:627-753`）：

1. 遍历所有已启用的服务器配置，为每个服务器创建 `AsyncManagedClient`
2. 每个 `AsyncManagedClient` 内部：
   - 校验服务器名称合法性（`^[a-zA-Z0-9_-]+$`）
   - 根据传输类型（Stdio/StreamableHttp）创建 `RmcpClient`
   - 发送 MCP `initialize` 请求，协商协议版本（`V_2025_06_18`）和能力
   - 列出服务器提供的所有工具，写入 ChatGPT Apps 工具缓存（如适用）
   - 应用工具过滤器
3. 启动完成后立即向服务器推送沙箱状态通知
4. 通过事件通道发送启动状态更新（Starting → Ready/Failed）
5. 后台 task 等待所有启动完成，发送 `McpStartupComplete` 汇总事件

**关键设计**：对于 ChatGPT Apps 服务器，若存在磁盘缓存，会在启动前加载缓存作为 `startup_snapshot`，使工具列表立即可用而不必等待网络请求完成。

### 3. 工具名称限定与去重流程（`qualify_tools`）

MCP 工具需要暴露给 OpenAI Responses API，该 API 要求工具名匹配 `^[a-zA-Z0-9_-]+$`（`src/mcp_connection_manager.rs:138-182`）：

1. 对普通 MCP 服务器，生成全限定名：`mcp__<server_name>__<tool_name>`
2. 对 ChatGPT Apps 服务器，使用 `<namespace><tool_name>` 格式
3. 对名称中的非法字符替换为 `_`（`sanitize_responses_api_tool_name`）
4. 若名称超过 64 字符，截断并附加原始名称的 SHA1 哈希，确保唯一性
5. 检测并跳过名称冲突的重复工具

### 4. 认证状态计算流程

`compute_auth_statuses` 并行为所有服务器判定认证状态（`src/mcp/auth.rs:126-153`）：

- **Stdio 传输**：固定返回 `Unsupported`（本地进程无需 OAuth）
- **StreamableHttp 传输**：调用 `determine_streamable_http_auth_status` 检查 bearer token 或 OAuth 凭据状态

OAuth scope 解析遵循优先级链（`src/mcp/auth.rs:81-113`）：
1. 显式传入的 scopes → 2. 配置中的 scopes → 3. 服务器发现的 scopes → 4. 空 scopes

若使用了自动发现的 scopes 导致 `OAuthProviderError`，可以通过 `should_retry_without_scopes` 判断是否应回退重试。

### 5. Skill MCP 依赖解析流程

`collect_missing_mcp_dependencies` 分析 Skill 元数据中声明的 MCP 工具依赖（`src/mcp/skill_dependencies.rs:10-65`）：

1. 提取已安装服务器的规范键集合（`canonical_mcp_server_key`）
2. 遍历 skill 的 `dependencies.tools`，筛选 `type == "mcp"` 的条目
3. 计算依赖的规范键，与已安装集合比对
4. 同一规范键的重复依赖只保留第一个
5. 将缺失的依赖转换为 `McpServerConfig`，支持 `streamable_http` 和 `stdio` 两种传输类型

规范键的计算方式是 `mcp__<transport>__<identifier>`，其中 identifier 是 URL（HTTP）或 command（Stdio）。

## 函数签名与参数说明

### `collect_mcp_snapshot(config, auth, submit_id) -> McpListToolsResponseEvent`

一次性快照收集的顶层入口。创建临时 `McpConnectionManager`，收集快照后销毁。

- **config**: `&McpConfig` — MCP 运行时配置
- **auth**: `Option<&CodexAuth>` — ChatGPT 认证凭据，用于 Apps 集成
- **submit_id**: `String` — 事件关联 ID

> 源码位置：`src/mcp/mod.rs:282-332`

### `McpConnectionManager::new(mcp_servers, store_mode, auth_entries, ...) -> (Self, CancellationToken)`

创建并启动连接管理器，返回管理器实例和取消令牌。

- **mcp_servers**: 服务器名称到配置的映射
- **store_mode**: OAuth 凭据存储模式
- **auth_entries**: 预计算的认证状态
- **approval_policy**: 工具审批策略
- **submit_id**: 事件 ID
- **tx_event**: 事件发送通道
- **initial_sandbox_state**: 初始沙箱状态
- **codex_home**: Codex 主目录路径
- **codex_apps_tools_cache_key**: Apps 工具缓存用户键
- **tool_plugin_provenance**: 插件来源信息

> 源码位置：`src/mcp_connection_manager.rs:627-753`

### `McpConnectionManager::call_tool(server, tool, arguments, meta) -> Result<CallToolResult>`

调用指定服务器上的指定工具。会先检查工具过滤器是否允许该工具。

> 源码位置：`src/mcp_connection_manager.rs:1009-1044`

### `effective_mcp_servers(config, auth) -> HashMap<String, McpServerConfig>`

合并用户配置的服务器和 ChatGPT Apps 服务器，返回最终生效的服务器列表。

> 源码位置：`src/mcp/mod.rs:270-276`

### `collect_missing_mcp_dependencies(mentioned_skills, installed) -> HashMap<String, McpServerConfig>`

根据 Skill 元数据识别缺失的 MCP 服务器依赖。

> 源码位置：`src/mcp/skill_dependencies.rs:10-65`

### `split_qualified_tool_name(qualified_name) -> Option<(String, String)>`

将全限定工具名 `mcp__<server>__<tool>` 拆分为 `(server_name, tool_name)` 元组。

> 源码位置：`src/mcp/mod.rs:334-346`

### `group_tools_by_server(tools) -> HashMap<String, HashMap<String, Tool>>`

将全限定工具名映射按服务器名分组。

> 源码位置：`src/mcp/mod.rs:348-361`

## 接口/类型定义

### `McpConfig`

MCP 运行时配置，从 `codex_core::config::Config` 派生。只应包含长期配置值，不含请求作用域的状态。

| 字段 | 类型 | 说明 |
|------|------|------|
| `chatgpt_base_url` | `String` | ChatGPT 后端 API 基础 URL |
| `codex_home` | `PathBuf` | Codex 主目录（OAuth 状态和缓存文件） |
| `mcp_oauth_credentials_store_mode` | `OAuthCredentialsStoreMode` | OAuth 凭据存储偏好 |
| `mcp_oauth_callback_port` | `Option<u16>` | OAuth 回调固定端口 |
| `mcp_oauth_callback_url` | `Option<String>` | OAuth 重定向 URI 覆盖 |
| `skill_mcp_dependency_install_enabled` | `bool` | 是否启用 Skill MCP 依赖安装提示 |
| `approval_policy` | `Constrained<AskForApproval>` | MCP 工具调用和 elicitation 的审批策略 |
| `codex_linux_sandbox_exe` | `Option<PathBuf>` | Linux 沙箱可执行文件路径 |
| `apps_enabled` | `bool` | 是否启用 ChatGPT Apps MCP 集成 |
| `configured_mcp_servers` | `HashMap<String, McpServerConfig>` | 用户/插件配置的 MCP 服务器 |
| `plugin_capability_summaries` | `Vec<PluginCapabilitySummary>` | 插件元数据 |

> 源码位置：`src/mcp/mod.rs:73-101`

### `ToolPluginProvenance`

跟踪 MCP 工具与插件的关联关系，支持通过 connector ID 或 MCP 服务器名称查询工具所属的插件显示名。

> 源码位置：`src/mcp/mod.rs:103-158`

### `ToolInfo`

单个 MCP 工具的完整元数据，包括所属服务器名、工具名、命名空间、工具定义、connector 信息和插件来源。

| 字段 | 类型 | 说明 |
|------|------|------|
| `server_name` | `String` | 所属 MCP 服务器名 |
| `tool_name` | `String` | 工具名（可能经 normalize 处理） |
| `tool_namespace` | `String` | 工具命名空间前缀 |
| `tool` | `Tool` | rmcp 工具定义 |
| `connector_id` | `Option<String>` | ChatGPT Apps connector ID |
| `connector_name` | `Option<String>` | connector 显示名 |
| `plugin_display_names` | `Vec<String>` | 关联的插件名称 |
| `connector_description` | `Option<String>` | connector 描述 |

> 源码位置：`src/mcp_connection_manager.rs:184-195`

### `SandboxState`

推送给 MCP 服务器的沙箱状态信息，用于 `codex/sandbox-state/update` 自定义 MCP 请求。

> 源码位置：`src/mcp_connection_manager.rs:570-578`

### `McpAuthStatusEntry`

单个服务器的认证状态条目，包含服务器配置和计算出的 `McpAuthStatus`。

> 源码位置：`src/mcp/auth.rs:120-124`

### `McpOAuthLoginSupport`

OAuth 登录支持探测结果枚举：`Supported(config)`、`Unsupported`、`Unknown(error)`。

> 源码位置：`src/mcp/auth.rs:24-28`

## 配置项与默认值

| 配置/常量 | 默认值 | 说明 |
|-----------|--------|------|
| `DEFAULT_STARTUP_TIMEOUT` | 30 秒 | MCP 服务器初始化超时 |
| `DEFAULT_TOOL_TIMEOUT` | 120 秒 | 单次工具调用超时 |
| `MAX_TOOL_NAME_LENGTH` | 64 字符 | 全限定工具名最大长度 |
| `MCP_TOOL_NAME_DELIMITER` | `__` | 服务器名与工具名的分隔符 |
| `CODEX_CONNECTORS_TOKEN_ENV_VAR` | `CODEX_CONNECTORS_TOKEN` | Apps 认证 token 环境变量 |
| `CODEX_APPS_MCP_SERVER_NAME` | `codex_apps` | 内置 Apps 服务器名称 |
| `MCP_SANDBOX_STATE_CAPABILITY` | `codex/sandbox-state` | 沙箱状态能力标识 |
| `CODEX_APPS_TOOLS_CACHE_SCHEMA_VERSION` | 1 | 工具缓存 schema 版本 |

服务器可通过 `startup_timeout_sec` 和 `tool_timeout_sec` 在配置中覆盖默认超时。

## 边界 Case 与注意事项

- **工具名称冲突处理**：当不同服务器/工具的 sanitize 后名称相同时（如 `foo.bar` 和 `foo_bar`），系统通过 SHA1 哈希原始名称来消歧义；完全重复的名称会被静默跳过并记录警告日志。

- **ChatGPT Apps 服务器的特殊性**：该服务器（`codex_apps`）有专属逻辑——工具缓存机制（磁盘持久化、按用户隔离、schema 版本校验）、connector 过滤（`is_connector_id_allowed`）、工具名/namespace 归一化（去除 connector 前缀），以及 elicitation 能力仅对它启用。

- **启动快照机制**：若 ChatGPT Apps 有磁盘缓存，`list_all_tools()` 在服务器尚未连接完成时即可返回缓存工具列表，避免阻塞；对于无缓存的服务器，`list_all_tools()` 会阻塞直到连接完成。

- **Elicitation 策略**：MCP elicitation 请求受 `approval_policy` 控制——`Never` 策略和 `Granular` 中 `mcp_elicitations: false` 会自动拒绝 elicitation，返回 `Decline`。

- **URL 归一化**：ChatGPT Apps 的 base URL 会自动补全 `/backend-api` 路径（针对 `chatgpt.com` 和 `chat.openai.com` 域名），并根据路径模式附加不同的 apps 端点。

- **GitHub MCP 特殊错误提示**：当 `api.githubcopilot.com/mcp/` 的连接失败时，系统会识别出 GitHub MCP 不支持 OAuth，并给出配置 PAT 的具体指引。

- **Skill 依赖去重**：使用规范键（基于传输方式和标识符）进行去重，因此即使用不同别名引用同一个服务器 URL，也不会重复安装。

- **服务器名称校验**：服务器名必须匹配 `^[a-zA-Z0-9_-]+$`，否则会在启动阶段报错。

## 关键代码片段

### 工具名称 sanitize 与长度控制

```rust
// src/mcp_connection_manager.rs:162-169
if qualified_name.len() > MAX_TOOL_NAME_LENGTH {
    let sha1_str = sha1_hex(&qualified_name_raw);
    let prefix_len = MAX_TOOL_NAME_LENGTH - sha1_str.len();
    qualified_name = format!("{}{}", &qualified_name[..prefix_len], sha1_str);
}
```

超过 64 字符的工具名会被截断，并用原始名称的 SHA1 哈希后缀保证唯一性。

### 启动快照的非阻塞读取

```rust
// src/mcp_connection_manager.rs:491-496
fn startup_snapshot_while_initializing(&self) -> Option<Vec<ToolInfo>> {
    if !self.startup_complete.load(Ordering::Acquire) {
        return self.startup_snapshot.clone();
    }
    None
}
```

通过原子标志判断启动是否完成，未完成时返回缓存快照，避免阻塞等待网络连接。

### OAuth scope 优先级解析

```rust
// src/mcp/auth.rs:81-113
pub fn resolve_oauth_scopes(
    explicit_scopes: Option<Vec<String>>,
    configured_scopes: Option<Vec<String>>,
    discovered_scopes: Option<Vec<String>>,
) -> ResolvedMcpOAuthScopes {
    // explicit → configured → discovered → empty
}
```

三级回退确保 scope 来源可追溯，便于在 `OAuthProviderError` 时决定是否应回退重试。