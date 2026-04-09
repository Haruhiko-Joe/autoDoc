# PatchTool — apply-patch 工具定义工厂

## 概述与职责

`apply_patch_tool` 模块是 **ToolSystem → ToolDefinitions → BuiltinToolDefs** 层级下的一个叶子模块，负责为 Codex 的文件编辑能力提供工具定义。它是一个**纯工厂模块**——不执行补丁逻辑本身（那是 `codex-apply-patch` crate 的工作），而是构造两种不同格式的 `ToolSpec`，供 `RegistryPlan` 根据会话配置（模型能力）选择使用。

在整体架构中，该模块与同级的 `local_tool`（Shell 执行）、`code_mode`、`js_repl_tool` 等工厂模块并列，统一被 `RegistryPlan` 的 `build_tool_registry_plan()` 调用以组装会话工具集。

## 两种工具变体

模块提供两个公开工厂函数，分别对应两种不同的 LLM 调用协议：

| 工厂函数 | 返回类型 | 适用场景 | 工具名称 |
|----------|----------|----------|----------|
| `create_apply_patch_freeform_tool()` | `ToolSpec::Freeform` | GPT-5 等支持 freeform tool 的模型 | `apply_patch` |
| `create_apply_patch_json_tool()` | `ToolSpec::Function` | GPT-OSS 等仅支持 JSON 参数的模型 | `apply_patch` |

两者工具名称相同（均为 `"apply_patch"`），在同一会话中只会使用其中一种——由 `ToolConfig` 根据模型能力决定。

## 关键流程

### Freeform 变体构造流程

`create_apply_patch_freeform_tool()` 返回一个 `ToolSpec::Freeform`（`codex-rs/tools/src/apply_patch_tool.rs:89-99`）：

1. 通过 `include_str!("tool_apply_patch.lark")` 在编译时嵌入 Lark 语法文件
2. 构造 `FreeformTool`，其 `format` 字段声明语法类型为 `"grammar"`、语法格式为 `"lark"`
3. 描述信息明确告知模型"这是一个 FREEFORM 工具，不要用 JSON 包裹补丁内容"

这种方式让模型直接输出符合 Lark 语法的补丁文本，无需 JSON 编解码开销。

### JSON 变体构造流程

`create_apply_patch_json_tool()` 返回一个 `ToolSpec::Function`（`codex-rs/tools/src/apply_patch_tool.rs:102-122`）：

1. 构造一个 `JsonSchema::Object`，包含单一必填字段 `input`（类型为 `JsonSchema::String`）
2. 用 `ResponsesApiTool` 包装，携带详尽的补丁格式描述作为 tool description
3. `strict: false`——不启用严格模式，因为补丁内容本身是自由文本

模型通过 JSON function call 传入 `{ "input": "*** Begin Patch\n..." }` 格式的参数。

## 函数签名

### `create_apply_patch_freeform_tool() -> ToolSpec`

构造 freeform 格式的 apply-patch 工具定义。无参数。

> 源码位置：`codex-rs/tools/src/apply_patch_tool.rs:89-99`

### `create_apply_patch_json_tool() -> ToolSpec`

构造 JSON 参数格式的 apply-patch 工具定义。无参数。

> 源码位置：`codex-rs/tools/src/apply_patch_tool.rs:102-122`

## 类型定义

### `ApplyPatchToolArgs`

JSON 变体的参数反序列化结构体（`codex-rs/tools/src/apply_patch_tool.rs:82-85`）：

```rust
pub struct ApplyPatchToolArgs {
    pub input: String,
}
```

代码中标记了 `TODO(dylan): deprecate once we get rid of json tool`，说明长期计划是统一使用 freeform 变体。

## Lark 语法定义

freeform 变体通过 `tool_apply_patch.lark` 文件定义补丁的形式文法（`codex-rs/tools/src/tool_apply_patch.lark:1-19`）。语法支持三种文件操作：

| 操作 | 语法头 | 内容 |
|------|--------|------|
| 新建文件 | `*** Add File: <path>` | 后跟 `+` 前缀的内容行 |
| 删除文件 | `*** Delete File: <path>` | 无后续内容 |
| 更新文件 | `*** Update File: <path>` | 可选 `*** Move to:` 重命名，后跟 hunk |

### 语法结构概要

```
start       → begin_patch  hunk+  end_patch
begin_patch → "*** Begin Patch" LF
end_patch   → "*** End Patch" LF?

hunk        → add_hunk | delete_hunk | update_hunk
update_hunk → "*** Update File: " filename LF  change_move?  change?
change      → (change_context | change_line)+  eof_line?
change_context → ("@@" | "@@ " header) LF
change_line    → ("+" | "-" | " ") text LF
```

`@@` 行用于 hunk 上下文定位——当 3 行上下文不足以唯一标识代码片段时，可以用类/函数名缩窄范围（如 `@@ class BaseClass`），甚至嵌套多个 `@@`（如 `@@ class BaseClass` + `@@ def method()`）。

## JSON 变体的 Description 设计

JSON 变体的 tool description（`APPLY_PATCH_JSON_TOOL_DESCRIPTION`，`codex-rs/tools/src/apply_patch_tool.rs:12-79`）兼具两个功能：

1. **教模型写补丁**：详细说明补丁格式的语法规则、上下文行数约定（默认 3 行）、`@@` 嵌套用法
2. **作为 API 的 description 字段**：发送给 OpenAI Responses API，让模型理解该工具的能力

这段描述中包含完整的语法 BNF 和一个多操作示例补丁，确保模型能正确输出格式化的补丁内容。

## 边界 Case 与注意事项

- **两个工厂函数返回的工具同名**（都是 `"apply_patch"`），在 `RegistryPlan` 组装时由 `ToolConfig` 确保同一会话只注册其中之一
- **freeform 变体无 description 中的格式教学**——格式约束完全由 Lark 语法文件承担，description 仅简述用途
- **`strict: false`**——JSON 变体不使用严格参数校验，因为 `input` 字段的内容是自由格式的补丁文本
- **文件路径约束**：补丁中的文件引用只能是相对路径，禁止绝对路径（在 description 中明确声明）
- **`ApplyPatchToolArgs` 计划废弃**——随着 freeform 变体成为默认选择，JSON 变体及其参数结构体将被移除