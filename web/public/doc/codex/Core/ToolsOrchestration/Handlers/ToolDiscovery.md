# ToolDiscovery — 工具发现、推荐与计划管理

## 概述与职责

ToolDiscovery 模块位于 **Core → ToolsOrchestration → Handlers** 层级中，包含三个独立的工具处理器（handler），它们都实现了 `ToolHandler` trait：

| 处理器 | 文件 | 职责 |
|--------|------|------|
| `ToolSearchHandler` | `tool_search.rs` | 基于 BM25 文本检索从注册表中按关键词搜索工具 |
| `ToolSuggestHandler` | `tool_suggest.rs` | 根据上下文向用户推荐可发现的工具（Connector / Plugin），并通过 MCP elicitation 获取用户确认 |
| `PlanHandler` | `plan.rs` | 管理模型的结构化任务计划（TODO/checklist），将计划更新以事件形式发送给客户端渲染 |

这三个处理器服务于不同场景：ToolSearch 帮助模型在大量可用工具中快速定位相关工具；ToolSuggest 允许模型主动建议安装尚未启用的工具；PlanHandler 则为模型提供一种结构化方式来记录和更新执行计划。

## 关键流程

### ToolSearchHandler — BM25 工具检索

1. 从 `ToolPayload::ToolSearch` 中提取 `query`（必填）和 `limit`（默认 8，即 `TOOL_SEARCH_DEFAULT_LIMIT`，定义于 `codex-rs/tools/src/tool_discovery.rs:15`）
2. 校验 `query` 非空、`limit > 0`
3. 将所有注册工具按名称排序后，为每个工具构建搜索文本（`build_search_text`），拼接以下字段：工具全限定名、`tool_name`、`server_name`、`title`、`description`、`connector_name`、`connector_description`、以及 `input_schema.properties` 中的所有属性名（`tool_search.rs:101-142`）
4. 使用 `bm25` crate 构建英文搜索引擎（`SearchEngineBuilder::<usize>::with_documents`），执行 `search(query, limit)`
5. 将 BM25 返回的结果映射为 `ToolSearchResultSource`，通过 `collect_tool_search_output_tools` 序列化后返回 `ToolSearchOutput`

BM25 是一种经典的文本相关性排序算法。通过将工具元数据（名称、描述、参数名等）组合为文档文本，模型可以用自然语言关键词搜索到语义相关的工具。

### ToolSuggestHandler — 工具推荐与安装

这是三者中最复杂的处理器，涉及 MCP elicitation（用户交互确认）和 connector/plugin 生命周期管理。

**主流程**（`tool_suggest.rs:37-154`）：

1. **参数解析与校验**：从 `ToolPayload::Function` 中解析 `ToolSuggestArgs`，校验 `suggest_reason` 非空、`action_type` 必须为 `Install`、在 `codex-tui` 客户端中不支持 Plugin 类型建议
2. **获取可发现工具列表**：
   - 通过 `auth_manager` 获取当前认证信息
   - 通过 `mcp_connection_manager` 获取已连接的 MCP 工具列表
   - 调用 `connectors::accessible_connectors_from_mcp_tools` 和 `connectors::list_tool_suggest_discoverable_tools_with_auth` 获取可发现但尚未安装的工具
   - 按客户端类型过滤（`filter_tool_suggest_discoverable_tools_for_client`）
3. **匹配目标工具**：在可发现工具列表中查找 `tool_type` 和 `tool_id` 匹配的工具
4. **发起 elicitation 请求**：通过 `session.request_mcp_server_elicitation` 向用户展示安装建议，等待用户接受或拒绝
5. **验证安装完成**：若用户确认，调用 `verify_tool_suggestion_completed` 验证工具是否实际安装成功
6. **合并 connector 选择**：若安装成功且为 Connector 类型，调用 `session.merge_connector_selection` 将其加入会话
7. **返回结果**：序列化 `ToolSuggestResult`，包含 `completed`、`user_confirmed`、工具元信息等

**验证安装完成**（`verify_tool_suggestion_completed`，`tool_suggest.rs:157-194`）：

- **Connector 类型**：调用 `refresh_missing_suggested_connectors` 刷新 MCP 工具缓存，检查 connector 是否已出现在可访问列表中
- **Plugin 类型**：重新加载用户配置层，通过 `PluginsManager.list_marketplaces_for_config` 检查插件是否标记为 `installed`，同时刷新关联的 connector

**刷新缺失的 connector**（`refresh_missing_suggested_connectors`，`tool_suggest.rs:196-237`）：

1. 先检查当前 MCP 工具列表中是否已包含期望的 connector
2. 若不包含，调用 `hard_refresh_codex_apps_tools_cache` 强制刷新缓存后再次检查
3. 刷新失败时记录警告日志并返回 `None`

### PlanHandler — 计划管理

PlanHandler 的设计理念值得注意——如代码注释所述（`plan.rs:77-79`）：**它本身不做有意义的计算，而是为模型提供一种结构化方式来记录计划，以便客户端读取和渲染**。真正有价值的是输入参数（计划内容），而不是输出。

**执行流程**（`plan.rs:53-74`）：

1. 从 `ToolPayload::Function` 中提取 JSON 参数
2. 调用 `handle_update_plan`：
   - 检查当前不在 Plan 模式下（`ModeKind::Plan`），否则拒绝——因为 `update_plan` 是 TODO/checklist 工具，与 Plan mode 是不同的概念
   - 解析参数为 `UpdatePlanArgs`（包含 `explanation` 和 `plan: Vec<PlanItemArg>`）
   - 通过 `session.send_event` 发出 `EventMsg::PlanUpdate(args)` 事件
3. 返回固定的 `PlanToolOutput`，日志和响应内容均为 `"Plan updated"`

## 函数签名与参数说明

### ToolSearchHandler

```rust
pub struct ToolSearchHandler {
    tools: HashMap<String, ToolInfo>,  // 工具全限定名 → 工具元信息
}

impl ToolSearchHandler {
    pub fn new(tools: HashMap<String, ToolInfo>) -> Self;
}
```

**搜索参数**：
- `query: String` — 搜索关键词，必填，不能为空
- `limit: Option<usize>` — 返回结果数上限，默认 `8`

**返回值**：`ToolSearchOutput { tools: Vec<...> }` — 按 BM25 相关性排序的工具列表

### ToolSuggestHandler

```rust
pub struct ToolSuggestHandler;  // 无状态，所有状态来自 ToolInvocation
```

**输入参数**（`ToolSuggestArgs`，定义于 `codex-rs/tools/src/tool_suggest.rs:19-24`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `tool_type` | `DiscoverableToolType` | `Connector` 或 `Plugin` |
| `action_type` | `DiscoverableToolAction` | 当前仅支持 `Install` |
| `tool_id` | `String` | 目标工具的唯一标识 |
| `suggest_reason` | `String` | 推荐理由，必填 |

**返回值**（`ToolSuggestResult`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `completed` | `bool` | 工具是否安装成功 |
| `user_confirmed` | `bool` | 用户是否接受了建议 |
| `tool_type` | `DiscoverableToolType` | 工具类型 |
| `action_type` | `DiscoverableToolAction` | 操作类型 |
| `tool_id` | `String` | 工具标识 |
| `tool_name` | `String` | 工具名称 |
| `suggest_reason` | `String` | 推荐理由 |

### PlanHandler

```rust
pub struct PlanHandler;
```

**`handle_update_plan` 函数**（`plan.rs:80-96`）：

```rust
pub(crate) async fn handle_update_plan(
    session: &Session,
    turn_context: &TurnContext,
    arguments: String,   // JSON 格式的 UpdatePlanArgs
    _call_id: String,
) -> Result<String, FunctionCallError>;
```

**`UpdatePlanArgs`**（定义于 `codex-rs/protocol/src/plan_tool.rs:24-28`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `explanation` | `Option<String>` | 计划的整体说明 |
| `plan` | `Vec<PlanItemArg>` | 计划步骤列表 |

**`PlanItemArg`**（`codex-rs/protocol/src/plan_tool.rs:17-20`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `step` | `String` | 步骤描述 |
| `status` | `StepStatus` | 步骤状态 |

## 接口/类型定义

### ToolInfo（来自 MCP 层）

`ToolInfo`（`codex-rs/codex-mcp/src/mcp_connection_manager.rs:185-195`）是工具搜索的核心数据结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `server_name` | `String` | MCP 服务器名称 |
| `tool_name` | `String` | 工具原始名称 |
| `tool_namespace` | `String` | 工具命名空间 |
| `tool` | `Tool` | MCP 工具定义（含 title、description、input_schema） |
| `connector_id` | `Option<String>` | 关联的 connector ID |
| `connector_name` | `Option<String>` | connector 名称 |
| `connector_description` | `Option<String>` | connector 描述 |
| `plugin_display_names` | `Vec<String>` | 关联的插件显示名 |

### PlanToolOutput

自定义的 `ToolOutput` 实现，所有方法返回固定值：
- `log_preview()` → `"Plan updated"`
- `success_for_logging()` → `true`
- `to_response_item()` → `ResponseInputItem::FunctionCallOutput` 包含 `"Plan updated"` 文本

### FunctionCallError

所有处理器共用的错误类型（`codex-rs/core/src/function_tool.rs:4-11`）：
- `RespondToModel(String)` — 非致命错误，将错误信息返回给模型
- `Fatal(String)` — 致命错误，中断处理

## 配置项与默认值

- `TOOL_SEARCH_DEFAULT_LIMIT = 8` — 工具搜索默认返回数量上限（`codex-rs/tools/src/tool_discovery.rs:15`）
- `TOOL_SEARCH_TOOL_NAME` / `TOOL_SUGGEST_TOOL_NAME` — 工具名常量，用于注册和错误消息

## 边界 Case 与注意事项

1. **ToolSearch 空注册表**：当 `tools` 为空时直接返回空列表，不会构建搜索引擎（`tool_search.rs:66-68`）

2. **ToolSuggest 客户端限制**：在 `codex-tui` 客户端中，Plugin 类型的工具建议被明确禁止（`tool_suggest.rs:67-73`），因为 TUI 尚未实现插件安装流程

3. **ToolSuggest 仅支持 Install**：`action_type` 字段虽定义了 `Install` 和 `Enable` 两种操作，但当前实现仅允许 `Install`（`tool_suggest.rs:62-66`）

4. **PlanHandler 与 Plan Mode 互斥**：`update_plan` 工具在 `ModeKind::Plan` 模式下被禁止调用（`plan.rs:86-89`），因为两者是不同的概念——`update_plan` 是 TODO/checklist 工具，而 Plan Mode 是协作模式模板

5. **PlanHandler 的设计哲学**：该 handler 本身不执行有意义的计算。它的价值在于强制模型以结构化方式记录计划，使客户端能够渲染展示。模型收到的响应始终是固定的 `"Plan updated"`

6. **BM25 搜索文本构建**：`build_search_text` 将工具的多个元数据字段拼接为空格分隔的文本，包括 `input_schema` 中的属性名——这使得用户可以按参数名搜索工具（`tool_search.rs:132-139`）

7. **ToolSuggest 缓存刷新策略**：验证安装完成时采用两级检查——先查当前缓存，未命中则 `hard_refresh_codex_apps_tools_cache` 强制刷新后再查（`tool_suggest.rs:207-236`）