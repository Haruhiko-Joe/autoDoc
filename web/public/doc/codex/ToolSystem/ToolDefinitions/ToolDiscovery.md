# ToolDiscovery — 动态工具发现与建议管线

## 概述与职责

ToolDiscovery 模块是 Codex ToolSystem 中的**动态工具发现与建议管线**，由两个源文件组成：`tool_discovery.rs`（工具搜索）和 `tool_suggest.rs`（工具建议）。它在运行时为 Agent 提供两个核心能力：

1. **`tool_search`**：让 Agent 在运行时搜索已连接 MCP 服务器上的可用工具/连接器/插件，按 BM25 相关性排序返回结果
2. **`tool_suggest`**：让 Agent 向用户推荐启用或安装某个可发现的工具，并通过 elicitation 请求获得用户确认

在整体架构中，本模块隶属于 **ToolSystem → ToolDefinitions**（`codex-tools` crate），与 Skills、ApplyPatch、FileSearch 等同级模块并列。ToolDefinitions 是工具注册中心，而 ToolDiscovery 专注于工具的运行时动态发现，区别于编译期静态注册的内建工具。

## 关键流程

### tool_search 工具的创建与执行

1. 系统启动时调用 `collect_tool_search_app_infos()` 从所有 MCP 工具源中筛选属于指定 `codex_apps_server_name` 的工具，提取连接器名称和描述，生成 `ToolSearchAppInfo` 列表（`tool_discovery.rs:250-271`）
2. 使用该列表调用 `create_tool_search_tool()` 构建 `tool_search` 工具定义（`tool_discovery.rs:146-202`）。该函数：
   - 构造包含 `query`（字符串）和 `limit`（数字，默认 8）两个参数的 JSON Schema
   - 去重聚合所有 app 的描述信息，嵌入到工具的 description 中，告知 Agent 当前可搜索的连接器列表
   - 返回 `ToolSpec::ToolSearch`，执行方式为 `"client"` 侧
3. Agent 调用 `tool_search` 后，搜索结果经 `collect_tool_search_output_tools()` 处理（`tool_discovery.rs:204-248`）：
   - 按 `tool_namespace` 分组聚合工具
   - 每个命名空间取首个工具的连接器描述作为 namespace 描述（无描述时用连接器名称生成 fallback）
   - 将每个 MCP 工具通过 `mcp_tool_to_deferred_responses_api_tool()` 转换为 Responses API 格式
   - 返回 `ToolSearchOutputTool::Namespace` 列表，供 Agent 在下一轮调用中使用新发现的工具

### tool_suggest 工具的创建与建议流程

1. 系统从可发现工具列表（`DiscoverableTool`）提取 `ToolSuggestEntry`，调用 `collect_tool_suggest_entries()`（`tool_discovery.rs:340-366`）
2. 对于 TUI 客户端，调用 `filter_tool_suggest_discoverable_tools_for_client()` 过滤掉 Plugin 类型的工具——TUI 仅支持 Connector 建议（`tool_discovery.rs:111-123`）
3. 调用 `create_tool_suggest_tool()` 构建 `tool_suggest` 工具定义（`tool_discovery.rs:273-338`）。该函数：
   - 定义四个必填参数：`tool_type`、`action_type`、`tool_id`、`suggest_reason`
   - 在 description 中嵌入完整的可发现工具列表（按名称排序），包含 id、类型和描述
   - 详细描述使用策略：优先搜索现有工具，仅在确实找不到匹配时才建议安装/启用
4. Agent 调用 `tool_suggest` 后，系统使用 `build_tool_suggestion_elicitation_request()`（`tool_suggest.rs:49-83`）构建 MCP elicitation 请求：
   - 将建议元信息（工具类型、动作类型、原因、安装 URL 等）打包为 `ToolSuggestMeta`，序列化到 `meta` 字段
   - 构建 `McpServerElicitationRequestParams`，通过 MCP 协议向客户端发起用户确认弹窗
5. 用户确认后，通过 `verified_connector_suggestion_completed()` 和 `all_suggested_connectors_picked_up()` 验证连接器是否已成功激活（`tool_suggest.rs:85-102`）

## 核心类型定义

### `DiscoverableTool`（`tool_discovery.rs:63-97`）

可发现工具的枚举类型，是整个建议管线的核心数据模型：

```rust
pub enum DiscoverableTool {
    Connector(Box<AppInfo>),       // 来自 app-server 的连接器
    Plugin(Box<DiscoverablePluginInfo>), // 可安装的插件
}
```

提供统一的访问接口：`tool_type()`、`id()`、`name()`、`install_url()`（仅 Connector 有安装 URL）。

### `DiscoverableToolType`（`tool_discovery.rs:40-54`）

```rust
pub enum DiscoverableToolType {
    Connector, // 连接器（如 Slack、GitHub 等外部服务集成）
    Plugin,    // 插件（包含 skills、MCP 服务器、app 连接器的复合包）
}
```

序列化为 `"connector"` / `"plugin"`。

### `DiscoverableToolAction`（`tool_discovery.rs:56-61`）

```rust
pub enum DiscoverableToolAction {
    Install, // 安装未安装的工具
    Enable,  // 启用已安装但未激活的工具
}
```

### `DiscoverablePluginInfo`（`tool_discovery.rs:125-133`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `String` | 插件唯一标识 |
| `name` | `String` | 插件显示名称 |
| `description` | `Option<String>` | 插件描述 |
| `has_skills` | `bool` | 是否包含 skills |
| `mcp_server_names` | `Vec<String>` | 关联的 MCP 服务器名称列表 |
| `app_connector_ids` | `Vec<String>` | 关联的 app 连接器 ID 列表 |

### `ToolSuggestResult`（`tool_suggest.rs:26-35`）

工具建议的最终结果，包含 `completed`（流程是否完成）、`user_confirmed`（用户是否确认）等字段，供 Agent 判断后续行为。

### `ToolSuggestArgs`（`tool_suggest.rs:18-24`）

Agent 调用 `tool_suggest` 时传入的参数结构，包含 `tool_type`、`action_type`、`tool_id`、`suggest_reason` 四个必填字段。

### `ToolSearchAppInfo`（`tool_discovery.rs:18-22`）

搜索工具展示给 Agent 的 app 信息摘要，包含 `name` 和可选的 `description`。

### `ToolSearchResultSource`（`tool_discovery.rs:31-38`）

搜索结果的来源信息，包含 `tool_namespace`、`tool_name`、底层 `rmcp::model::Tool` 引用、以及连接器名称和描述。用于 `collect_tool_search_output_tools()` 的分组聚合。

## 函数签名与参数说明

### `create_tool_search_tool(app_tools: &[ToolSearchAppInfo], default_limit: usize) -> ToolSpec`

构建 `tool_search` 工具定义。`app_tools` 为当前已启用的 app 列表，`default_limit` 为默认返回数量上限（常量 `TOOL_SEARCH_DEFAULT_LIMIT = 8`）。

### `collect_tool_search_output_tools(tool_sources: impl IntoIterator<Item = ToolSearchResultSource>) -> Result<Vec<ToolSearchOutputTool>, serde_json::Error>`

将搜索命中的工具按 namespace 分组，转换为 Responses API 格式的输出。

### `collect_tool_search_app_infos(app_tools: impl IntoIterator<Item = ToolSearchAppSource>, codex_apps_server_name: &str) -> Vec<ToolSearchAppInfo>`

从所有 MCP 工具源中筛选属于指定 apps 服务器的工具，提取名称和描述。过滤掉空名称的条目。

### `create_tool_suggest_tool(discoverable_tools: &[ToolSuggestEntry]) -> ToolSpec`

构建 `tool_suggest` 工具定义，将可发现工具列表嵌入 description 中。

### `collect_tool_suggest_entries(discoverable_tools: &[DiscoverableTool]) -> Vec<ToolSuggestEntry>`

将 `DiscoverableTool` 列表转换为 `ToolSuggestEntry` 列表，用于工具定义构建。

### `filter_tool_suggest_discoverable_tools_for_client(discoverable_tools: Vec<DiscoverableTool>, app_server_client_name: Option<&str>) -> Vec<DiscoverableTool>`

按客户端类型过滤可建议的工具。当客户端为 `"codex-tui"` 时，移除所有 Plugin 类型（TUI 不支持插件安装流程），其他客户端保留全部工具。

### `build_tool_suggestion_elicitation_request(server_name: &str, thread_id: String, turn_id: String, args: &ToolSuggestArgs, suggest_reason: &str, tool: &DiscoverableTool) -> McpServerElicitationRequestParams`

构建 MCP elicitation 请求参数，用于向客户端发起工具建议的用户确认弹窗。将建议元信息序列化为 JSON 放入 `meta` 字段。

### `verified_connector_suggestion_completed(tool_id: &str, accessible_connectors: &[AppInfo]) -> bool`

验证指定连接器是否已被用户激活（存在于 accessible_connectors 中且 `is_accessible` 为 true）。

### `all_suggested_connectors_picked_up(expected_connector_ids: &[String], accessible_connectors: &[AppInfo]) -> bool`

批量验证所有期望的连接器是否都已激活。

## 配置项与常量

| 常量 | 值 | 说明 |
|------|------|------|
| `TOOL_SEARCH_TOOL_NAME` | `"tool_search"` | 搜索工具的注册名称 |
| `TOOL_SUGGEST_TOOL_NAME` | `"tool_suggest"` | 建议工具的注册名称 |
| `TOOL_SEARCH_DEFAULT_LIMIT` | `8` | 搜索默认返回上限 |
| `TUI_CLIENT_NAME` | `"codex-tui"` | TUI 客户端标识，用于过滤逻辑 |
| `TOOL_SUGGEST_APPROVAL_KIND_VALUE` | `"tool_suggestion"` | elicitation 请求中的审批类型标识 |

## 边界 Case 与注意事项

- **TUI 客户端的 Plugin 过滤**：TUI 客户端（`codex-tui`）不支持插件安装流程，因此 `filter_tool_suggest_discoverable_tools_for_client()` 会移除所有 Plugin 类型的工具建议。其他客户端（如 IDE 扩展）则保留全部类型。
- **空名称/描述处理**：`collect_tool_search_app_infos()` 会过滤掉连接器名称为空或仅包含空白字符的条目。描述为空时同样被过滤。`tool_description_or_fallback()` 在描述为空时为 Plugin 生成包含 skills/MCP servers/connectors 信息的 fallback 摘要，为 Connector 返回 "No description provided."。
- **无可用 app 时的 tool_search 描述**：当 `app_descriptions` 为空时，描述中会显示 "None currently enabled." 而非空列表。
- **Connector 的 install_url**：仅 `Connector` 变体具有 `install_url`，`Plugin` 始终返回 `None`。elicitation 请求的 meta 中会在有 URL 时包含该字段（`skip_serializing_if`）。
- **tool_suggest 的严格使用策略**：工具描述中明确要求 Agent 先穷尽 `tool_search` 等手段，确认没有匹配工具后才使用 `tool_suggest`。对于未安装的 Plugin，要求用户意图"非常明确且无歧义"地匹配该插件本身，标准比 Connector 更严格。