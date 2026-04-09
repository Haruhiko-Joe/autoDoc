# CodeMode — Code-mode 工具增强与创建

## 概述与职责

`code_mode` 模块是 BuiltinToolDefs 层中负责 **code-mode 工具定义与增强** 的工厂模块，位于 `codex-rs/tools/src/code_mode.rs`。它在 ToolSystem → ToolDefinitions → BuiltinToolDefs 层级中，与 `local_tool`（shell 执行）、`apply_patch_tool`、`js_repl_tool` 等兄弟模块并列，各自负责一类内置工具的定义生成。

Code-mode 是 Codex 的一种执行策略：模型不再逐个调用独立工具，而是通过一个 freeform `exec` 工具提交 JavaScript 源码，在 V8 隔离环境中运行，并通过全局 `tools` 对象调用嵌套工具。本模块的职责是：

1. **增强已有工具描述**：为任意 `ToolSpec` 的 description 追加 TypeScript 声明片段，告诉模型如何在 exec 代码中调用该工具
2. **收集嵌套工具定义**：从一组 `ToolSpec` 中筛选出可作为 code-mode 嵌套工具的定义
3. **创建 exec 工具**：生成 freeform 格式的 `exec` 工具（带 Lark 语法定义）
4. **创建 wait 工具**：生成用于轮询 yielded exec cell 的 `wait` 工具

本模块本身不包含运行时逻辑，而是桥接到 `codex_code_mode` crate（`codex-rs/code-mode`）获取描述文本生成和工具分类能力。

## 关键流程

### 工具描述增强流程（augment）

当 code-mode 激活时，RegistryPlan 会对每个工具调用 `augment_tool_spec_for_code_mode` 以追加 TypeScript exec 声明：

1. 调用内部函数 `code_mode_tool_definition_for_spec` 将 `ToolSpec` 转换为 `codex_code_mode::ToolDefinition`（`code_mode.rs:131-152`）
2. 将转换结果传入 `codex_code_mode::augment_tool_definition`，该函数在 description 末尾追加形如 `` ```ts declare const tools: { ... }; ``` `` 的 TypeScript 声明
3. 用增强后的 description 替换原 `ToolSpec` 中的 description 并返回

对于 `exec` 工具自身（name = `"exec"`），`augment_tool_definition` 会跳过增强，避免递归引用。`LocalShell`、`ImageGeneration`、`ToolSearch`、`WebSearch` 等非函数/非 freeform 变体直接返回 `None`，不参与增强。

### 嵌套工具收集流程（collect）

`collect_code_mode_tool_definitions` 接收一组 `ToolSpec`，筛选出可在 exec 运行时中使用的嵌套工具：

1. 对每个 spec 调用 `tool_spec_to_code_mode_tool_definition`
2. 该函数先将 spec 转为 `CodeModeToolDefinition`，然后用 `is_code_mode_nested_tool` 判断：名称既不是 `"exec"` 也不是 `"wait"` 的工具才是嵌套工具
3. 通过筛选的工具再经 `augment_tool_definition` 增强
4. 最终结果按 name 排序并去重（`code_mode.rs:43-49`）

### exec 工具创建

`create_code_mode_tool` 生成 code-mode 的核心 freeform 工具：

- 名称：`"exec"`（来自 `codex_code_mode::PUBLIC_TOOL_NAME`）
- 描述：由 `codex_code_mode::build_exec_tool_description` 根据当前启用的工具列表和 `code_mode_only_enabled` 标志动态生成
- 格式：Lark 语法，支持两种输入形式——带 pragma 前缀的源码和纯源码（详见下文语法定义）

### wait 工具创建

`create_wait_tool` 生成用于轮询长时间运行 exec cell 的 function 工具：

- 名称：`"wait"`（来自 `codex_code_mode::WAIT_TOOL_NAME`）
- 描述：由 `codex_code_mode::build_wait_tool_description` 提供
- 参数：`cell_id`（必填）、`yield_time_ms`、`max_tokens`、`terminate`（均可选）

## 函数签名与参数说明

### `augment_tool_spec_for_code_mode(spec: ToolSpec) -> ToolSpec`

增强工具的 description，追加 code-mode TypeScript 声明。对于不支持的 ToolSpec 变体（`LocalShell`、`ImageGeneration` 等）原样返回。

> 源码位置：`codex-rs/tools/src/code_mode.rs:11-30`

### `tool_spec_to_code_mode_tool_definition(spec: &ToolSpec) -> Option<CodeModeToolDefinition>`

将单个 `ToolSpec` 转为增强后的 `CodeModeToolDefinition`。仅对嵌套工具（非 exec/wait）返回 `Some`。

> 源码位置：`codex-rs/tools/src/code_mode.rs:34-38`

### `collect_code_mode_tool_definitions(specs: impl IntoIterator<Item = &ToolSpec>) -> Vec<CodeModeToolDefinition>`

批量收集并去重所有可在 code-mode 运行时中使用的嵌套工具定义。返回按名称排序的列表。

> 源码位置：`codex-rs/tools/src/code_mode.rs:40-50`

### `create_code_mode_tool(enabled_tools: &[(String, String)], code_mode_only_enabled: bool) -> ToolSpec`

创建 `exec` freeform 工具。

- **enabled_tools**：`(name, description)` 对的列表，表示当前会话中启用的工具
- **code_mode_only_enabled**：若为 `true`，exec 描述中会加入提示，告知模型只能通过 exec/wait 调用工具（不能直接调用独立工具）

> 源码位置：`codex-rs/tools/src/code_mode.rs:103-129`

### `create_wait_tool() -> ToolSpec`

创建 `wait` function 工具，用于轮询 yielded exec cell 的输出。

> 源码位置：`codex-rs/tools/src/code_mode.rs:52-101`

### `code_mode_tool_definition_for_spec(spec: &ToolSpec) -> Option<CodeModeToolDefinition>`（私有）

将 `ToolSpec` 映射为 `CodeModeToolDefinition`。`Function` 变体会序列化其 parameters 为 JSON 作为 `input_schema`，`Freeform` 变体的 schema 为 `None`。`LocalShell`、`ImageGeneration`、`ToolSearch`、`WebSearch` 返回 `None`。

> 源码位置：`codex-rs/tools/src/code_mode.rs:131-152`

## 接口/类型定义

本模块主要使用以下来自 `codex_code_mode` crate 的类型：

### `CodeModeToolKind`（枚举）

```rust
pub enum CodeModeToolKind {
    Function,  // 接受结构化 JSON 输入的工具
    Freeform,  // 接受自由文本输入的工具
}
```

用于区分嵌套工具的调用方式，影响生成的 TypeScript 声明签名：`Function` 工具生成带类型参数的签名，`Freeform` 工具生成 `(input: string)` 签名。

### `ToolDefinition`（结构体，来自 `codex_code_mode`）

```rust
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub kind: CodeModeToolKind,
    pub input_schema: Option<JsonValue>,
    pub output_schema: Option<JsonValue>,
}
```

code-mode 运行时的工具定义，`input_schema` 和 `output_schema` 用于生成 TypeScript 类型声明。

## 配置项与默认值

### Lark 语法定义（exec 工具输入格式）

exec 工具使用 Lark 语法约束输入（`code_mode.rs:107-115`）：

```
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
```

支持两种输入形式：
- **pragma_source**：以 `// @exec:...` 行开头，后跟换行和源码。pragma 行可携带执行元信息
- **plain_source**：直接的 JavaScript/TypeScript 源码

### wait 工具参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `cell_id` | string | 是 | 正在运行的 exec cell 标识符 |
| `yield_time_ms` | number | 否 | 等待新输出的最长时间（毫秒），超时后再次 yield |
| `max_tokens` | number | 否 | 本次 wait 返回的最大输出 token 数 |
| `terminate` | boolean | 否 | 是否终止正在运行的 exec cell |

## 边界 Case 与注意事项

- **exec/wait 自身不被增强**：`augment_tool_spec_for_code_mode` 对 name 为 `"exec"` 的工具不追加 TypeScript 声明（由 `codex_code_mode::augment_tool_definition` 内部跳过），避免自引用
- **不支持的 ToolSpec 变体静默跳过**：`LocalShell`、`ImageGeneration`、`ToolSearch`、`WebSearch` 在转换和增强时均返回 `None`，不会报错
- **去重策略**：`collect_code_mode_tool_definitions` 通过排序后相邻去重（`dedup_by`）处理同名工具，因此依赖排序的正确性
- **schema 序列化可能失败**：`code_mode_tool_definition_for_spec` 中 `serde_json::to_value(&tool.parameters).ok()` 静默吞掉序列化错误，此时 `input_schema` 为 `None`，生成的 TypeScript 声明中参数类型会退化
- **`strict: false`**：wait 工具的 `strict` 设为 `false`，即 LLM 可以省略可选参数或添加额外字段