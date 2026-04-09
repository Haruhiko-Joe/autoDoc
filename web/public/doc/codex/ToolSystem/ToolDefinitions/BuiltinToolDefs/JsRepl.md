# JsRepl — JavaScript REPL 工具定义

## 概述与职责

`js_repl_tool` 模块是 Codex 内置工具定义（BuiltinToolDefs）的一部分，负责提供 **JavaScript REPL** 相关的两个工具定义工厂函数。在整体架构中，它属于 **ToolSystem → ToolDefinitions → BuiltinToolDefs** 层级，与 `local_tool`（Shell 执行）、`apply_patch_tool`（补丁应用）、`code_mode`（代码模式）等模块并列，由 RegistryPlan 在构建会话工具集时统一调用。

该模块包含两个公开函数：

- **`create_js_repl_tool()`** — 创建一个 freeform 类型的工具，允许 Agent 直接发送原始 JavaScript 源码在持久 Node 内核中执行
- **`create_js_repl_reset_tool()`** — 创建一个普通 function 类型的工具，用于重启 Node 内核并清除所有顶层绑定

源码位置：`codex-rs/tools/src/js_repl_tool.rs`

## 关键流程

### `create_js_repl_tool()` 工厂流程

1. **定义 Lark 文法**：在函数内部通过 `const JS_REPL_FREEFORM_GRAMMAR` 定义了一个 Lark 语法，用于约束 Agent 发送的 payload 格式（`js_repl_tool.rs:14-26`）
2. **构造 `ToolSpec::Freeform`**：将工具名、描述和文法封装为 `FreeformTool` 结构体，返回 `ToolSpec::Freeform` 变体（`js_repl_tool.rs:28-37`）

### `create_js_repl_reset_tool()` 工厂流程

1. **构造 `ToolSpec::Function`**：创建一个无参数的 `ResponsesApiTool`，参数 schema 为空对象且禁止额外属性（`js_repl_tool.rs:41-54`）

## 核心设计：Lark 文法输入校验

这是本模块最核心的设计决策。`js_repl` 工具不同于普通 function 工具——它是 **freeform 工具**，Agent 不发送 JSON 参数，而是直接发送原始 JavaScript 源码文本。

为了防止 LLM 发送格式错误的 payload（JSON 包装、引号包裹、Markdown 代码块），模块定义了一套 Lark 文法在 API 层面进行预校验：

```lark
start: pragma_source | plain_source

pragma_source: PRAGMA_LINE NEWLINE js_source
plain_source: PLAIN_JS_SOURCE

js_source: JS_SOURCE

PRAGMA_LINE: /[ \t]*\/\/ codex-js-repl:[^\r\n]*/
NEWLINE: /\r?\n/
PLAIN_JS_SOURCE: /(?:\s*)(?:[^\s{\"`]|`[^`]|``[^`])[\s\S]*/
JS_SOURCE: /(?:\s*)(?:[^\s{\"`]|`[^`]|``[^`])[\s\S]*/
```

> 源码位置：`codex-rs/tools/src/js_repl_tool.rs:14-26`

文法接受两种合法输入形式：

1. **`pragma_source`**：第一行是 pragma 注释（如 `// codex-js-repl: timeout_ms=15000`），后接换行和 JS 源码。Pragma 行允许配置超时等参数。
2. **`plain_source`**：直接是 JS 源码，不带 pragma。

### 拒绝策略："首个有效 token" 模式

关键的拒绝逻辑体现在 `PLAIN_JS_SOURCE` 和 `JS_SOURCE` 的正则中：

```regex
/(?:\s*)(?:[^\s{\"`]|`[^`]|``[^`])[\s\S]*/
```

这个正则的含义是：跳过前导空白后，**第一个有效字符不能是** `{`、`"`、`` ` ``（单独的反引号）。这样就能拒绝以下常见的 LLM 错误格式：

| 被拒绝的格式 | 匹配到的首字符 |
|---|---|
| `{"code": "console.log(1)"}` | `{`（JSON 包装） |
| `"console.log(1)"` | `"`（引号包裹字符串） |
| `` ```javascript\nconsole.log(1)\n``` `` | `` ` ``（Markdown 代码块，三连反引号） |

注意文法允许反引号出现在模板字面量中（如 `` `hello ${name}` ``），因为此时反引号后紧跟非反引号字符，匹配 `` `[^`] `` 分支。

文件注释中特别说明了为什么使用这种"首个有效 token"模式而非负向前瞻：**API 的正则引擎不支持 look-around**（`js_repl_tool.rs:12-13`）。测试中也验证了文法不包含 `(?!` 模式（`js_repl_tool_tests.rs:18`）。

## 函数签名

### `create_js_repl_tool() -> ToolSpec`

返回一个 `ToolSpec::Freeform` 变体，包含：

| 字段 | 值 |
|---|---|
| `name` | `"js_repl"` |
| `description` | 描述为在持久 Node 内核中运行 JavaScript，支持 top-level await，说明不要发送 JSON/引号/Markdown 代码块 |
| `format.type` | `"grammar"` |
| `format.syntax` | `"lark"` |
| `format.definition` | 上述 Lark 文法字符串 |

### `create_js_repl_reset_tool() -> ToolSpec`

返回一个 `ToolSpec::Function` 变体，包含：

| 字段 | 值 |
|---|---|
| `name` | `"js_repl_reset"` |
| `description` | `"Restarts the js_repl kernel for this run and clears persisted top-level bindings."` |
| `strict` | `false` |
| `parameters` | 空对象 schema（`properties: {}`，`additional_properties: false`） |
| `output_schema` | `None` |

## 接口/类型定义

本模块依赖以下来自 `codex-tools` 的核心类型：

- **`ToolSpec`**（`tool_spec.rs:20`）— 工具定义的tagged enum，本模块使用其中的 `Freeform` 和 `Function` 两个变体
- **`FreeformTool`**（`responses_api.rs:11`）— freeform 工具结构体，包含 `name`、`description`、`format` 字段
- **`FreeformToolFormat`**（`responses_api.rs:18`）— 描述 freeform 工具的格式约束，包含 `type`（如 `"grammar"`）、`syntax`（如 `"lark"`）、`definition`（文法定义字符串）
- **`ResponsesApiTool`**（`responses_api.rs:25`）— 标准 function 工具结构体，包含 `name`、`description`、`parameters`（JsonSchema）等字段
- **`JsonSchema`** — 参数 schema 枚举，`js_repl_reset` 使用 `JsonSchema::Object` 变体表示空参数

## 边界 Case 与注意事项

- **Pragma 行格式**：pragma 必须以 `// codex-js-repl:` 开头，后面跟配置内容（如 `timeout_ms=15000`）。pragma 行的具体解析不在本模块中，本模块只负责文法层面的格式约束。
- **模板字面量兼容**：文法允许以反引号开头的 JS 模板字面量（如 `` `text` ``），前提是反引号后紧跟的不是另一个反引号。三连反引号（Markdown 代码块）会被拒绝。
- **`js_repl_reset` 无参数**：reset 工具设置了 `additional_properties: false`，Agent 不能传递任何参数。`strict: false` 表示 API 层面不强制严格模式校验。
- **持久内核语义**：工具描述中提到 "persistent Node kernel"，意味着 `js_repl` 执行的代码会保留变量绑定和状态，直到 `js_repl_reset` 被调用。内核管理的实际实现不在本模块中。
- **测试覆盖**：`js_repl_tool_tests.rs` 验证了两个工厂函数的输出结构，包括文法关键 token 的存在性和 reset 工具的完整 spec 匹配。