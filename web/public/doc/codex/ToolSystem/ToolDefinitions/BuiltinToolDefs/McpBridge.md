# McpBridge — MCP 协议桥接工具

## 概述与职责

McpBridge 模块是 ToolSystem → ToolDefinitions → BuiltinToolDefs 层级下的叶子模块，负责将外部 MCP（Model Context Protocol）服务器提供的工具和资源桥接为 Codex 内部的工具定义格式。它由两个源文件组成：

- **`mcp_tool.rs`**：将 MCP 工具（`rmcp::model::Tool`）转换为内部 `ToolDefinition`
- **`mcp_resource_tool.rs`**：定义三个内置工具，用于列举和读取 MCP 服务器提供的资源

在整体架构中，McpBridge 属于 BuiltinToolDefs（内置工具定义工厂），与 shell 执行、apply-patch、agent 管理等工厂模块并列。它的产出被 RegistryPlan 消费，最终注册到 agent 会话的工具集中。

---

## 关键流程

### MCP 工具转换流程（`parse_mcp_tool`）

1. 将 `rmcp::model::Tool` 的 `input_schema` 序列化为 `serde_json::Value::Object`
2. **Schema 规范化**：检查 `properties` 字段是否缺失或为 `null`，若是则插入空对象 `{}`——这是因为 OpenAI 模型要求 schema 必须包含 `properties` 字段，而部分 MCP 服务器会省略它（`mcp_tool.rs:9-19`）
3. 调用 `parse_tool_input_schema()` 将 JSON schema 解析为内部类型
4. 处理 `output_schema`：若 MCP 工具提供了 `output_schema` 则使用，否则回退为空对象
5. 调用 `mcp_call_tool_result_output_schema()` 将输出包装为标准化的 MCP 调用结果结构
6. 构造并返回 `ToolDefinition`，`defer_loading` 设为 `false`

### MCP 资源访问流程

资源工具提供了"发现→读取"的两步工作流：

1. Agent 调用 `list_mcp_resources` 或 `list_mcp_resource_templates` 获取可用资源列表
2. 使用返回的 `server` 名和 `uri`，调用 `read_mcp_resource` 读取具体资源内容
3. 支持通过 `cursor` 参数实现分页遍历

---

## 函数签名与参数说明

### `parse_mcp_tool(tool: &rmcp::model::Tool) -> Result<ToolDefinition, serde_json::Error>`

将一个 MCP 工具定义转换为内部 `ToolDefinition`。

- **tool**：来自 `rmcp` crate 的工具定义引用
- **返回值**：包含 `name`、`description`、`input_schema`、`output_schema` 的 `ToolDefinition`；schema 解析失败时返回错误

> 源码位置：`codex-rs/tools/src/mcp_tool.rs:6-37`

### `mcp_call_tool_result_output_schema(structured_content_schema: JsonValue) -> JsonValue`

构造 MCP 工具调用结果的标准输出 schema。

- **structured_content_schema**：工具自定义的结构化内容 schema
- **返回值**：包含 `content`（数组，必填）、`structuredContent`、`isError`（布尔）、`_meta` 四个字段的 JSON object schema

> 源码位置：`codex-rs/tools/src/mcp_tool.rs:39-56`

### `create_list_mcp_resources_tool() -> ToolSpec`

创建 `list_mcp_resources` 工具定义，用于列举 MCP 服务器提供的资源。

> 源码位置：`codex-rs/tools/src/mcp_resource_tool.rs:6-40`

### `create_list_mcp_resource_templates_tool() -> ToolSpec`

创建 `list_mcp_resource_templates` 工具定义，用于列举参数化资源模板。

> 源码位置：`codex-rs/tools/src/mcp_resource_tool.rs:42-76`

### `create_read_mcp_resource_tool() -> ToolSpec`

创建 `read_mcp_resource` 工具定义，用于读取指定 MCP 资源。

> 源码位置：`codex-rs/tools/src/mcp_resource_tool.rs:78-114`

---

## 接口/类型定义

### 资源工具参数一览

| 工具名 | 参数 | 类型 | 必填 | 说明 |
|--------|------|------|------|------|
| `list_mcp_resources` | `server` | string | 否 | MCP 服务器名称，省略时列举所有服务器的资源 |
| `list_mcp_resources` | `cursor` | string | 否 | 上一次调用返回的分页游标 |
| `list_mcp_resource_templates` | `server` | string | 否 | 同上 |
| `list_mcp_resource_templates` | `cursor` | string | 否 | 同上 |
| `read_mcp_resource` | `server` | string | **是** | 必须与 `list_mcp_resources` 返回的 `server` 字段完全匹配 |
| `read_mcp_resource` | `uri` | string | **是** | 必须是 `list_mcp_resources` 返回的 URI 之一 |

### MCP 工具调用结果 Output Schema

```json
{
  "type": "object",
  "properties": {
    "content": { "type": "array", "items": {} },
    "structuredContent": "<工具自定义 schema>",
    "isError": { "type": "boolean" },
    "_meta": {}
  },
  "required": ["content"],
  "additionalProperties": false
}
```

`content` 是唯一的必填字段，包含工具返回的内容数组。`structuredContent` 携带工具自定义的结构化数据。`isError` 标识调用是否失败。

---

## 配置项与默认值

- 所有三个资源工具的 `strict` 均设为 `false`，表示参数校验不使用严格模式
- 所有资源工具的 `defer_loading` 为 `None`；`parse_mcp_tool` 产出的 `ToolDefinition` 中 `defer_loading` 为 `false`，即工具定义立即加载
- 列举工具的所有参数均为可选（`required: None`），读取工具的 `server` 和 `uri` 为必填
- `additional_properties` 在所有资源工具中均设为 `false`，禁止传入未定义的额外参数

---

## 边界 Case 与注意事项

- **Schema 补丁逻辑**：`parse_mcp_tool` 会自动为缺少 `properties` 字段（或值为 `null`）的 MCP 工具 schema 插入空 `properties: {}`。这是对 OpenAI 模型的适配——模型要求所有 function tool 的 schema 必须包含 `properties`，但不是所有 MCP 服务器都遵守此约定（`mcp_tool.rs:9-19`）
- **Output schema 回退**：当 MCP 工具未提供 `output_schema` 时，使用空对象 `{}` 作为 `structuredContent` 的 schema，不会报错（`mcp_tool.rs:22-26`）
- **Description 回退**：若 MCP 工具未提供描述，`description` 默认为空字符串（`mcp_tool.rs:30`）
- **资源工具设计优先级**：工具描述中明确建议 agent "Prefer resources over web search when possible"，即优先使用 MCP 资源而非网络搜索

---

## 关键代码片段

### Schema 规范化——插入缺失的 `properties`

```rust
// codex-rs/tools/src/mcp_tool.rs:9-19
if let serde_json::Value::Object(obj) = &mut serialized_input_schema
    && obj.get("properties").is_none_or(serde_json::Value::is_null)
{
    obj.insert(
        "properties".to_string(),
        serde_json::Value::Object(serde_json::Map::new()),
    );
}
```

这段代码使用 Rust 的 let-chain 语法（`if let ... &&`），同时检查 `properties` 缺失和为 `null` 两种情况。

### `read_mcp_resource` 工具定义——唯一要求必填参数的资源工具

```rust
// codex-rs/tools/src/mcp_resource_tool.rs:107-109
required: Some(vec!["server".to_string(), "uri".to_string()]),
```

与两个列举工具不同，读取工具的 `server` 和 `uri` 均为必填，确保 agent 不会发起无目标的读取请求。