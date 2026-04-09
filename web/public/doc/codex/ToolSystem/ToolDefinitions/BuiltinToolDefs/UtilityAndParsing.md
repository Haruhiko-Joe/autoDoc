# 工具工厂与动态工具解析

## 概述与职责

本模块包含三个文件，属于 **ToolSystem → ToolDefinitions → BuiltinToolDefs** 层级，提供若干"小型"内置工具的工厂函数以及动态工具的解析能力。具体包括：

- **`utility_tool.rs`**：目录列表工具 `list_dir` 和测试同步工具 `test_sync_tool` 的工厂函数
- **`view_image.rs`**：图片查看工具 `view_image` 的工厂函数，支持原始分辨率选项
- **`dynamic_tool.rs`**：将外部协议传入的 `DynamicToolSpec` 转换为内部 `ToolDefinition`

这些工厂函数的产出（`ToolSpec`）由上层的 `RegistryPlan` 模块调用，最终注册到会话的工具集中供 Agent 使用。

---

## 关键流程

### 1. `create_list_dir_tool` — 目录列表工具构建

该函数构造一个名为 `"list_dir"` 的 `ToolSpec::Function`，用于分页列出本地目录内容。

**参数 schema**（`codex-rs/tools/src/utility_tool.rs:7-36`）：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `dir_path` | String | 是 | 要列出的目录的绝对路径 |
| `offset` | Number | 否 | 起始条目编号（从 1 开始） |
| `limit` | Number | 否 | 返回的最大条目数 |
| `depth` | Number | 否 | 最大遍历深度（≥1） |

工具设置 `strict: false`，`additional_properties: false`，不定义 `output_schema`。

### 2. `create_view_image_tool` — 图片查看工具构建

该函数根据 `ViewImageToolOptions` 构造 `view_image` 工具的 `ToolSpec`。

**条件化参数注入**（`codex-rs/tools/src/view_image.rs:14-45`）：

1. 始终包含必填参数 `path`（图片文件本地路径）
2. 当 `options.can_request_original_image_detail == true` 时，额外注入可选参数 `detail`，唯一支持的值为 `"original"`，用于保留原始分辨率而非默认缩放行为——这对 CUA（Computer Use Agent）等需要精确定位的场景尤为重要

**输出 schema**（`codex-rs/tools/src/view_image.rs:47-63`）：

与其他工具不同，`view_image` 定义了 `output_schema`，包含：
- `image_url`（string）：加载后的 Data URL
- `detail`（string | null）：若保留原始分辨率则返回 `"original"`，否则为 `null`

工具名称引用自协议常量 `VIEW_IMAGE_TOOL_NAME`，其值为 `"view_image"`（`codex-rs/protocol/src/models.rs:802`）。

### 3. `create_test_sync_tool` — 测试同步工具构建

该函数构造 `test_sync_tool`，专用于集成测试中的并发同步（`codex-rs/tools/src/utility_tool.rs:54-121`）。

**参数 schema** 为嵌套结构：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sleep_before_ms` | Number | 否 | 执行前的延迟（毫秒） |
| `sleep_after_ms` | Number | 否 | 完成后的延迟（毫秒） |
| `barrier` | Object | 否 | 屏障同步配置 |

`barrier` 子对象的结构：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | String | 是 | 共享标识符，并发调用通过相同 id 汇合 |
| `participants` | Number | 是 | 屏障开放前需到达的调用数 |
| `timeout_ms` | Number | 否 | 等待屏障的最大时间（毫秒） |

所有顶层参数均为可选（`required: None`），这使测试可灵活组合使用延迟和/或屏障功能。

### 4. `parse_dynamic_tool` — 动态工具解析

该函数将来自 `codex_protocol` 的 `DynamicToolSpec` 转换为内部 `ToolDefinition`（`codex-rs/tools/src/dynamic_tool.rs:5-19`）。

**转换流程**：

1. 解构 `DynamicToolSpec` 的四个字段：`name`、`description`、`input_schema`、`defer_loading`
2. 调用 `parse_tool_input_schema()`（定义于 `codex-rs/tools/src/json_schema.rs:64`）将原始 JSON schema（`serde_json::Value`）解析为内部 `JsonSchema` 枚举
3. 组装 `ToolDefinition`，其中 `output_schema` 固定为 `None`

若 `input_schema` 的 JSON 不合法，返回 `serde_json::Error`。

---

## 类型定义

### `ViewImageToolOptions`

```rust
// codex-rs/tools/src/view_image.rs:9-12
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViewImageToolOptions {
    pub can_request_original_image_detail: bool,
}
```

控制 `view_image` 工具是否暴露 `detail` 参数。该布尔值由上层 `RegistryPlan` 根据模型能力决定——并非所有模型都支持原始分辨率图片。

### `DynamicToolSpec`（外部类型）

```rust
// codex-rs/protocol/src/dynamic_tools.rs:10-16
pub struct DynamicToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: JsonValue,
    pub defer_loading: bool,  // 默认 false
}
```

来自 `codex_protocol` crate，表示外部注册的动态工具规格。`defer_loading` 使用 `#[serde(default)]` 默认为 `false`。

### `ToolDefinition`（内部类型）

```rust
// codex-rs/tools/src/tool_definition.rs:7-13
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: JsonSchema,
    pub output_schema: Option<JsonValue>,
    pub defer_loading: bool,
}
```

内部工具定义，`input_schema` 使用强类型 `JsonSchema` 枚举而非原始 JSON。

---

## 边界 Case 与注意事项

- **`list_dir` 的分页起始**：`offset` 描述为"1 or greater"，即 1-indexed，而非常见的 0-indexed。
- **`view_image` 的 `detail` 参数**：仅支持 `"original"` 一个值，省略时使用默认缩放行为。不支持指定自定义分辨率。
- **`parse_dynamic_tool` 不设置 `output_schema`**：动态工具解析时固定为 `None`，即使外部 `DynamicToolSpec` 概念上可能有输出 schema，当前实现不支持。
- **`test_sync_tool` 仅限测试使用**：该工具的描述明确标注为"Internal synchronization helper used by Codex integration tests"，不应出现在生产工具集中。
- **所有工具均设置 `strict: false`**：参数校验为宽松模式，但同时设置 `additional_properties: false` 阻止传入未声明的参数。