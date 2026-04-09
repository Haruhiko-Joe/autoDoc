# MCP 工具与资源调用处理器（McpHandlers）

## 概述与职责

McpHandlers 模块包含两个核心处理器，负责将模型发起的 MCP（Model Context Protocol）相关调用桥接到外部 MCP 服务器：

- **`McpHandler`**：处理 MCP 工具调用，将请求委托给 `handle_mcp_tool_call` 完成实际的远程调用。
- **`McpResourceHandler`**：处理 MCP 资源操作，支持列出资源、列出资源模板、读取资源三种操作，提供 URI 路由、分页、多服务器聚合和结果序列化能力。

在系统层级中，该模块位于 **Core → ToolsOrchestration → Handlers** 下，是 Handlers 模块中专门负责 MCP 协议交互的部分。同级兄弟模块还包括 shell 执行、apply-patch、多 Agent 通信、JS REPL 等各类工具处理器。当 SessionEngine 收到模型请求的 MCP 工具调用时，ToolDispatch 会将调用路由到这两个 handler。

## 关键流程

### McpHandler：MCP 工具调用流程

`McpHandler` 实现了 `ToolHandler` trait，其 `handle` 方法执行以下步骤：

1. 从 `ToolInvocation` 中解构出 `session`、`turn`、`call_id` 和 `payload`
2. 校验 payload 类型必须为 `ToolPayload::Mcp`，提取 `server`（目标 MCP 服务器名）、`tool`（工具名）和 `raw_arguments`（原始参数字符串）
3. 调用 `handle_mcp_tool_call()` 将请求发送到外部 MCP 服务器并等待结果（`mcp.rs:44-52`）
4. 返回 `CallToolResult`

整个处理器是一个轻量的委托层，核心逻辑在 `crate::mcp_tool_call::handle_mcp_tool_call` 中。

### McpResourceHandler：资源操作路由

`McpResourceHandler` 同样实现了 `ToolHandler` trait，但以 `ToolKind::Function` 类型注册（而非 `ToolKind::Mcp`），接收 `ToolPayload::Function` 类型的参数。它根据 `tool_name` 路由到三个子操作（`mcp_resource.rs:208-239`）：

| tool_name | 处理函数 | 说明 |
|-----------|----------|------|
| `list_mcp_resources` | `handle_list_resources` | 列出可用资源 |
| `list_mcp_resource_templates` | `handle_list_resource_templates` | 列出资源模板 |
| `read_mcp_resource` | `handle_read_resource` | 读取指定资源内容 |

### 列出资源（list_mcp_resources）

1. 解析 `ListResourcesArgs`，提取可选的 `server` 和 `cursor` 参数
2. 发送 `McpToolCallBegin` 事件，开始计时
3. 根据是否指定了 server 分两条路径：
   - **指定了 server**：调用 `session.list_resources()` 查询单个服务器，支持通过 `cursor` 分页
   - **未指定 server**：通过 `mcp_connection_manager.list_all_resources()` 聚合所有服务器的资源（此时不允许使用 cursor，否则报错）
4. 将结果封装为 `ListResourcesPayload`，JSON 序列化后作为 `FunctionToolOutput` 返回
5. 无论成功还是失败，都发送 `McpToolCallEnd` 事件（包含耗时和结果）

### 列出资源模板（list_mcp_resource_templates）

流程与 `list_mcp_resources` 完全对称，使用 `ListResourceTemplatesArgs` 和 `ListResourceTemplatesPayload`，调用 `session.list_resource_templates()` 或 `mcp_connection_manager.list_all_resource_templates()`。

### 读取资源（read_mcp_resource）

1. 解析 `ReadResourceArgs`，要求 `server` 和 `uri` 两个字段都必须非空
2. 调用 `session.read_resource()` 并传入 `ReadResourceRequestParams`（`mcp_resource.rs:474-485`）
3. 将结果封装为 `ReadResourcePayload`（包含 server、uri 和 `ReadResourceResult`）
4. 序列化后返回

## 函数签名与参数说明

### `McpHandler::handle(invocation: ToolInvocation) -> Result<CallToolResult, FunctionCallError>`

- **输入**：`ToolInvocation`，payload 必须为 `ToolPayload::Mcp { server, tool, raw_arguments }`
- **输出**：`CallToolResult`（MCP 协议标准的工具调用结果）

### `McpResourceHandler::handle(invocation: ToolInvocation) -> Result<FunctionToolOutput, FunctionCallError>`

- **输入**：`ToolInvocation`，payload 必须为 `ToolPayload::Function { arguments }`，`tool_name` 决定路由
- **输出**：`FunctionToolOutput`（JSON 序列化的结果文本，`success` 字段标记为 `true`）

## 接口/类型定义

### 参数类型

**`ListResourcesArgs`**（`mcp_resource.rs:36-42`）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `server` | `Option<String>` | `None` | 指定 MCP 服务器名；为 None 时聚合所有服务器 |
| `cursor` | `Option<String>` | `None` | 分页游标，仅在指定 server 时可用 |

**`ListResourceTemplatesArgs`**（`mcp_resource.rs:44-51`）——字段与 `ListResourcesArgs` 相同。

**`ReadResourceArgs`**（`mcp_resource.rs:53-57`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `server` | `String` | 必填，目标 MCP 服务器名 |
| `uri` | `String` | 必填，资源 URI |

### 响应 Payload 类型

**`ResourceWithServer`**（`mcp_resource.rs:59-70`）：在 `Resource` 基础上附加 `server` 字段，使用 `#[serde(flatten)]` 将 Resource 的字段平铺到 JSON 输出中。

**`ResourceTemplateWithServer`**（`mcp_resource.rs:72-83`）：与上类似，附加 `server` 字段到 `ResourceTemplate`。

**`ListResourcesPayload`**（`mcp_resource.rs:85-126`）：
- `server`: 查询指定服务器时为 `Some`，聚合所有服务器时为 `None`
- `resources`: `Vec<ResourceWithServer>`
- `next_cursor`: 分页游标（仅单服务器查询时可能存在）
- 提供 `from_single_server()` 和 `from_all_servers()` 两个构造方法；后者按服务器名排序

**`ListResourceTemplatesPayload`**（`mcp_resource.rs:128-170`）：结构与 `ListResourcesPayload` 对称。

**`ReadResourcePayload`**（`mcp_resource.rs:172-178`）：包含 `server`、`uri` 和 `ReadResourceResult`（flatten 展开）。

## 事件生命周期

每个资源操作都会发射一对 begin/end 事件，用于 UI 展示和性能追踪：

- **`McpToolCallBegin`**：在实际操作前发送，包含 `call_id` 和 `McpInvocation`（server + tool + arguments）
- **`McpToolCallEnd`**：在操作完成后发送，包含 `call_id`、`McpInvocation`、耗时 `Duration` 和 `Result<CallToolResult, String>`

辅助函数 `emit_tool_call_begin` 和 `emit_tool_call_end`（`mcp_resource.rs:553-589`）封装了事件发送逻辑。

## 辅助工具函数

| 函数 | 位置 | 说明 |
|------|------|------|
| `parse_arguments(raw_args)` | `mcp_resource.rs:624-637` | 将原始 JSON 字符串解析为 `Option<Value>`；空白和 `null` 都返回 `None` |
| `parse_args<T>(arguments)` | `mcp_resource.rs:639-651` | 将 `Option<Value>` 反序列化为具体类型 `T`；`None` 输入视为错误 |
| `parse_args_with_default<T>(arguments)` | `mcp_resource.rs:653-661` | 类似 `parse_args`，但 `None` 输入返回 `T::default()` |
| `normalize_optional_string(input)` | `mcp_resource.rs:591-600` | trim 后若为空则返回 `None` |
| `normalize_required_string(field, value)` | `mcp_resource.rs:602-609` | trim 后若为空则返回错误 |
| `serialize_function_output<T>(payload)` | `mcp_resource.rs:611-622` | 将任意可序列化类型转为 `FunctionToolOutput`（文本形式，success=true） |
| `call_tool_result_from_content(content, success)` | `mcp_resource.rs:544-551` | 将文本内容包装为 `CallToolResult`，将 `success` 反转为 `is_error` |

## 边界 Case 与注意事项

- **McpHandler 与 McpResourceHandler 的 ToolKind 不同**：`McpHandler` 注册为 `ToolKind::Mcp`，接收 `ToolPayload::Mcp`；`McpResourceHandler` 注册为 `ToolKind::Function`，接收 `ToolPayload::Function`。这意味着资源操作在工具系统中被视为普通函数调用而非 MCP 调用。

- **cursor 限制**：在不指定 server 的聚合查询中使用 `cursor` 会直接返回错误——分页游标只在单服务器查询时有意义。

- **字符串规范化**：所有字符串参数都会被 trim，空白字符串等同于未提供。`ReadResourceArgs` 的 `server` 和 `uri` 字段即使声明为 `String`，也会通过 `normalize_required_string` 校验非空。

- **聚合结果排序**：`from_all_servers()` 方法对结果按服务器名字母序排序（`mcp_resource.rs:111`、`155`），确保输出稳定可预测。

- **错误处理一致性**：无论操作成功还是失败，都会发送 `McpToolCallEnd` 事件。错误通过 `FunctionCallError::RespondToModel` 包装，直接反馈给模型而非终止会话。