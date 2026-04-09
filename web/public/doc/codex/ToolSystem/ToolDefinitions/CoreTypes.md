# CoreTypes — 工具类型系统基础

## 概述与职责

CoreTypes 是 `codex-tools` crate 的类型系统基础层，定义了 Codex 代理所使用的**所有工具种类的数据模型**。它位于 ToolSystem → ToolDefinitions 层级下，为上层的工具注册、发现和执行流程提供统一的类型抽象。

在整体架构中，ToolDefinitions 是工具框架的核心定义和注册 crate，而 CoreTypes 则是 ToolDefinitions 内最底层的模块——它不关心工具如何被发现或执行，只负责回答"一个工具的数据长什么样"。同级的兄弟模块（Skills、ApplyPatch、FileSearch、ShellCommand 等）会依赖这些类型来描述自身。

该模块由五个源文件组成，分别定义了：

| 文件 | 核心职责 |
|------|----------|
| `tool_spec.rs` | `ToolSpec` 标签枚举——所有工具种类的统一表示 |
| `responses_api.rs` | `ResponsesApiTool` 及 MCP/动态工具到 API 格式的转换 |
| `tool_definition.rs` | `ToolDefinition`——工具名称、描述和 schema 的中间表示 |
| `json_schema.rs` | `JsonSchema` 枚举——工具参数 schema 的内部模型 |
| `image_detail.rs` | 图片细节级别的标准化处理 |

## 关键流程

### 工具定义到 API 请求的序列化流程

这是本模块最核心的数据流向：将内部工具定义转换为 OpenAI Responses API 兼容的 JSON。

1. 各子系统（MCP 客户端、动态工具注册器等）持有原始工具描述
2. 通过 `parse_mcp_tool()` 或 `parse_dynamic_tool()` 解析为中间表示 `ToolDefinition`（`tool_definition.rs:7-13`）
3. 调用 `tool_definition_to_responses_api_tool()` 将 `ToolDefinition` 转换为 `ResponsesApiTool`（`responses_api.rs:89-98`）
4. `ResponsesApiTool` 被包装进 `ToolSpec::Function` 变体
5. 调用 `create_tools_json_for_responses_api()` 将 `ToolSpec` 数组序列化为 JSON（`tool_spec.rs:139-150`）

```
MCP Tool / DynamicToolSpec
    ↓  parse_mcp_tool() / parse_dynamic_tool()
ToolDefinition
    ↓  tool_definition_to_responses_api_tool()
ResponsesApiTool
    ↓  包装为 ToolSpec::Function
ToolSpec
    ↓  serde_json::to_value() via create_tools_json_for_responses_api()
JSON Value (发送给 OpenAI API)
```

### JSON Schema 解析与清洗流程

外部工具（特别是 MCP 工具）的 `input_schema` 格式不一定严格规范。`parse_tool_input_schema()` 通过 `sanitize_json_schema()` 进行清洗后再反序列化：

1. 克隆原始 `JsonValue` 并调用 `sanitize_json_schema()` 递归清洗（`json_schema.rs:64-68`）
2. 若 schema 是布尔值形式（`true`/`false`），强制转为 `{"type": "string"}`
3. 若缺少 `type` 字段，根据已有关键字推断：
   - 含 `properties`/`required`/`additionalProperties` → 推断为 `object`
   - 含 `items`/`prefixItems` → 推断为 `array`
   - 含 `enum`/`const`/`format` → 推断为 `string`
   - 含 `minimum`/`maximum` 等数值约束 → 推断为 `number`
   - 以上都不匹配 → 默认 `string`
4. 补全缺失的必要子字段（`object` 缺少 `properties` 则补空 map，`array` 缺少 `items` 则补 `{"type": "string"}`）
5. 递归处理 `oneOf`/`anyOf`/`allOf`/`prefixItems` 等组合关键字中的子 schema
6. 最终反序列化为 `JsonSchema` 枚举

### Web 搜索工具创建流程

`create_web_search_tool()` 根据配置生成 `ToolSpec::WebSearch`（`tool_spec.rs:85-115`）：

1. 检查 `WebSearchMode`：`Disabled` 或 `None` 时直接返回 `None`（跳过工具注册）
2. `Cached` 映射为 `external_web_access = false`，`Live` 映射为 `true`
3. 根据 `WebSearchToolType` 决定 `search_content_types`：纯文本搜索为 `None`，图文搜索为 `["text", "image"]`
4. 从 `WebSearchConfig` 提取 `filters`、`user_location`、`search_context_size` 等可选配置

## 类型定义

### `ToolSpec`（`tool_spec.rs:20-54`）

核心标签枚举，每个变体对应一种工具类型。通过 `#[serde(tag = "type")]` 实现内部标签序列化，序列化后的 JSON 直接兼容 OpenAI Responses API 的 Tool 格式。

| 变体 | 序列化标签 | 说明 |
|------|-----------|------|
| `Function(ResponsesApiTool)` | `"function"` | 通用函数工具，携带完整的名称、描述和参数 schema |
| `ToolSearch { execution, description, parameters }` | `"tool_search"` | 工具搜索/发现机制 |
| `LocalShell {}` | `"local_shell"` | 本地 Shell 命令执行 |
| `ImageGeneration { output_format }` | `"image_generation"` | 图片生成工具 |
| `WebSearch { ... }` | `"web_search"` | Web 搜索工具，含缓存/实时模式、域名过滤、地理位置等配置 |
| `Freeform(FreeformTool)` | `"custom"` | 自定义格式工具 |

`name()` 方法返回每个变体的标识名称：`Function` 和 `Freeform` 返回各自的 `name` 字段，其余返回固定字符串。

### `ConfiguredToolSpec`（`tool_spec.rs:117-134`）

将 `ToolSpec` 与 `supports_parallel_tool_calls` 布尔值配对，标记该工具是否支持并行调用。

### `ResponsesApiTool`（`responses_api.rs:24-37`）

OpenAI Responses API 格式的函数工具 schema：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 工具名称 |
| `description` | `String` | 工具功能描述 |
| `strict` | `bool` | 是否启用严格模式（要求 `required` 和 `additionalProperties` 完整） |
| `defer_loading` | `Option<bool>` | 是否延迟加载（序列化时 `None` 会被跳过） |
| `parameters` | `JsonSchema` | 参数 schema |
| `output_schema` | `Option<Value>` | 输出 schema（`#[serde(skip)]`，不会被序列化） |

注意 `output_schema` 标记了 `#[serde(skip)]`，在序列化到 API 时不会包含在 JSON 中，仅供内部使用。

### `FreeformTool` 和 `FreeformToolFormat`（`responses_api.rs:11-22`）

自定义格式工具，序列化为 `"custom"` 类型。`FreeformToolFormat` 包含 `type`、`syntax`、`definition` 三个字符串字段，用于描述非标准工具的输入格式。

### `ToolSearchOutputTool` 和相关类型（`responses_api.rs:39-61`）

工具搜索结果的输出格式，支持两种变体：
- `Function(ResponsesApiTool)`：标准函数工具
- `Namespace(ResponsesApiNamespace)`：命名空间，包含名称、描述和一组子工具

### `ToolDefinition`（`tool_definition.rs:7-13`）

工具的**中间表示**，是 MCP 工具 / 动态工具解析后、转换为 `ResponsesApiTool` 之前的过渡类型：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `String` | 工具名称 |
| `description` | `String` | 功能描述 |
| `input_schema` | `JsonSchema` | 输入参数 schema |
| `output_schema` | `Option<JsonValue>` | 输出 schema |
| `defer_loading` | `bool` | 是否延迟加载 |

提供两个链式变换方法：
- `renamed(name)` — 替换工具名称，返回 `self`
- `into_deferred()` — 将工具标记为延迟加载（清除 `output_schema`，设 `defer_loading = true`）

### `JsonSchema`（`json_schema.rs:8-41`）

JSON Schema 的内部子集表示，通过 `#[serde(tag = "type")]` 按类型标签区分：

| 变体 | 说明 |
|------|------|
| `Boolean { description }` | 布尔类型 |
| `String { description }` | 字符串类型 |
| `Number { description }` | 数值类型（同时接受 `"integer"` 别名，通过 `#[serde(alias = "integer")]`） |
| `Array { items, description }` | 数组类型，`items` 为元素 schema（`Box<JsonSchema>`） |
| `Object { properties, required, additional_properties }` | 对象类型 |

`Object` 变体的 `properties` 使用 `BTreeMap<String, JsonSchema>` 保证键有序。`additional_properties` 字段序列化名为 `additionalProperties`，值为 `AdditionalProperties` 枚举——可以是布尔值（`true`/`false`）或者嵌套的 `JsonSchema`。

### `AdditionalProperties`（`json_schema.rs:44-49`）

使用 `#[serde(untagged)]` 反序列化，支持两种形式：
- `Boolean(bool)` — 简单的允许/禁止
- `Schema(Box<JsonSchema>)` — 约束额外属性的类型

提供了 `From<bool>` 和 `From<JsonSchema>` 两个便捷转换。

## 函数签名

### `create_tools_json_for_responses_api(tools: &[ToolSpec]) -> Result<Vec<Value>, serde_json::Error>`

将一组 `ToolSpec` 批量序列化为 JSON 值数组，用于构造 OpenAI Responses API 请求体。

> 源码位置：`codex-rs/tools/src/tool_spec.rs:139-150`

### `create_local_shell_tool() -> ToolSpec`

创建 `ToolSpec::LocalShell {}` 实例。

> 源码位置：`codex-rs/tools/src/tool_spec.rs:69-71`

### `create_image_generation_tool(output_format: &str) -> ToolSpec`

创建 `ToolSpec::ImageGeneration`，指定输出格式。

> 源码位置：`codex-rs/tools/src/tool_spec.rs:73-77`

### `create_web_search_tool(options: WebSearchToolOptions) -> Option<ToolSpec>`

根据配置创建 Web 搜索工具。当 `web_search_mode` 为 `Disabled` 或 `None` 时返回 `None`。

> 源码位置：`codex-rs/tools/src/tool_spec.rs:85-115`

### `dynamic_tool_to_responses_api_tool(tool: &DynamicToolSpec) -> Result<ResponsesApiTool, serde_json::Error>`

将动态工具规格转换为 `ResponsesApiTool`，内部先调用 `parse_dynamic_tool()` 解析为 `ToolDefinition`，再转换。

> 源码位置：`codex-rs/tools/src/responses_api.rs:63-69`

### `mcp_tool_to_responses_api_tool(name: String, tool: &rmcp::model::Tool) -> Result<ResponsesApiTool, serde_json::Error>`

将 MCP 工具转换为 `ResponsesApiTool`，使用指定的 `name` 重命名。

> 源码位置：`codex-rs/tools/src/responses_api.rs:71-78`

### `mcp_tool_to_deferred_responses_api_tool(name: String, tool: &rmcp::model::Tool) -> Result<ResponsesApiTool, serde_json::Error>`

类似上一个函数，但额外调用 `into_deferred()` 将工具标记为延迟加载。

> 源码位置：`codex-rs/tools/src/responses_api.rs:80-87`

### `tool_definition_to_responses_api_tool(tool_definition: ToolDefinition) -> ResponsesApiTool`

将 `ToolDefinition` 转换为 `ResponsesApiTool`。`strict` 固定为 `false`，`defer_loading` 仅在 `tool_definition.defer_loading` 为 `true` 时设为 `Some(true)`。

> 源码位置：`codex-rs/tools/src/responses_api.rs:89-98`

### `parse_tool_input_schema(input_schema: &JsonValue) -> Result<JsonSchema, serde_json::Error>`

解析工具的输入 schema JSON，先清洗再反序列化为 `JsonSchema`。

> 源码位置：`codex-rs/tools/src/json_schema.rs:64-68`

### `normalize_output_image_detail(features: &Features, model_info: &ModelInfo, detail: Option<ImageDetail>) -> Option<ImageDetail>`

标准化输出图片的细节级别。只有当请求了 `ImageDetail::Original` **且**模型支持且特性开关已启用时才保留 `Original`，否则一律返回 `None`。

> 源码位置：`codex-rs/tools/src/image_detail.rs:10-21`

### `can_request_original_image_detail(features: &Features, model_info: &ModelInfo) -> bool`

检查是否允许请求原始细节级别的图片：需要模型 `supports_image_detail_original` 为 `true` 且 `Feature::ImageDetailOriginal` 特性已启用。

> 源码位置：`codex-rs/tools/src/image_detail.rs:6-8`

## 配置项与 Web 搜索相关类型

### `WebSearchToolOptions`（`tool_spec.rs:79-83`）

创建 Web 搜索工具的配置参数：
- `web_search_mode: Option<WebSearchMode>` — 搜索模式：`Cached`（缓存内容）、`Live`（实时访问）、`Disabled`
- `web_search_config: Option<&WebSearchConfig>` — 搜索配置（过滤器、用户位置、上下文大小）
- `web_search_tool_type: WebSearchToolType` — 内容类型：`Text` 或 `TextAndImage`

### `ResponsesApiWebSearchFilters`（`tool_spec.rs:152-156`）

搜索域名过滤，仅包含 `allowed_domains: Option<Vec<String>>`。

### `ResponsesApiWebSearchUserLocation`（`tool_spec.rs:166-178`）

用户地理位置信息，包含 `type`、`country`、`region`、`city`、`timezone` 字段，所有字段（除 `type`）均为可选。

## 边界 Case 与注意事项

- **`output_schema` 不参与序列化**：`ResponsesApiTool.output_schema` 标记了 `#[serde(skip)]`，在发送给 API 时不会出现在 JSON 中。如果未来 API 支持输出 schema，需要移除此注解。

- **`strict` 模式的 TODO**：代码中注释标注了一个未完成的验证逻辑——当 `strict = true` 时，`required` 和 `additionalProperties` 必须存在，且 `properties` 中的所有字段都要出现在 `required` 中。当前 `tool_definition_to_responses_api_tool()` 硬编码 `strict: false`。

- **`Number` 兼容 `integer`**：`JsonSchema::Number` 通过 `#[serde(alias = "integer")]` 同时接受 JSON Schema 中的 `"number"` 和 `"integer"` 类型，二者在内部不作区分。

- **Schema 清洗的容错策略**：`sanitize_json_schema()` 对格式不规范的 schema 采取宽松策略——缺少 `type` 时推断，缺少子结构时补默认值，布尔形式的 schema 强制转为字符串类型。这确保了来自 MCP 等外部工具的不规范 schema 不会导致解析失败。

- **Web 搜索的 API 兼容性**：代码中有 TODO 注释提到 `web_search` 类型可能会遇到 API 错误（尽管文档显示支持），说明此功能可能处于试验阶段。

- **`into_deferred()` 会清除 `output_schema`**：将工具标记为延迟加载时会同时移除输出 schema，这是有意为之——延迟工具只注册名称和描述，完整 schema 在实际使用时才加载。