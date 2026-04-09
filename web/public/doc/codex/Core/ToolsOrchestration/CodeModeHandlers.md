# Code-Mode 工具处理器（CodeModeHandlers）

## 概述与职责

CodeModeHandlers 是 Core 引擎中 ToolsOrchestration 层的子模块，负责将 LLM 发出的 `exec` / `wait` 工具调用桥接到底层的 code-mode 运行时服务。它由三部分组成：

- **Execute Handler**：接收模型发来的 JavaScript 源码，启动一个长时运行的 Deno 执行会话
- **Wait Handler**：按 cell ID 轮询正在执行的脚本，获取中间输出或最终结果
- **Response Adapter**：将 code-mode 运行时返回的内容项转换为 `codex_protocol` 定义的模型可消费格式

在系统层级中，本模块位于 **Core → ToolsOrchestration** 下，与同级的 **CodeMode**（运行时服务本体）配合工作。ToolsOrchestration 中的 shell、apply-patch、MCP 等工具处理器是它的兄弟模块。

## 关键流程

### Execute 流程（代码执行）

1. 模型发出 `exec` 工具调用，payload 为原始 JavaScript 源码文本（`ToolPayload::Custom`）
2. `CodeModeExecuteHandler::handle()` 匹配到 tool name 为 `"exec"` 的调用（`execute_handler.rs:76`）
3. 调用 `codex_code_mode::parse_exec_source()` 解析源码——支持首行 `// @exec: {...}` pragma 指令来设置 `yield_time_ms` 和 `max_output_tokens`
4. 通过 `build_enabled_tools()` 构建嵌套工具列表（脚本内可调用的工具），方法是创建一个 nested `ToolRouter` 并收集其 specs（`mod.rs:243-248`）
5. 从 `CodeModeService` 获取上一次执行留存的 `stored_values`
6. 构造 `ExecuteRequest` 并调用 `CodeModeService::execute()` 提交到运行时
7. 运行时返回 `RuntimeResponse`，由 `handle_runtime_response()` 统一处理

### Wait 流程（轮询等待）

1. 模型发出 `wait` 工具调用，payload 为 JSON 参数（`ToolPayload::Function`）
2. `CodeModeWaitHandler::handle()` 反序列化出 `ExecWaitArgs`（`wait_handler.rs:59`），包含：
   - `cell_id`：要等待的执行单元标识
   - `yield_time_ms`：超时后 yield 返回（默认 10 秒）
   - `max_tokens`：输出 token 上限
   - `terminate`：是否强制终止该 cell
3. 构造 `WaitRequest` 并调用 `CodeModeService::wait()`
4. 返回的 `RuntimeResponse` 同样经 `handle_runtime_response()` 处理

### RuntimeResponse 处理（统一后处理）

`handle_runtime_response()`（`mod.rs:150-197`）是 execute 和 wait 共享的输出处理管道：

1. **格式化状态头**：根据 response 变体生成状态文本（"Script running with cell ID ..."、"Script completed"、"Script failed"等）
2. **类型转换**：调用 `response_adapter::into_function_call_output_content_items()` 将 code-mode 的 content items 转为 protocol 层类型
3. **截断处理**：通过 `truncate_code_mode_result()` 按 token 上限截断输出，优先使用文本格式化截断，混合内容时回退到通用截断策略
4. **添加头部信息**：在输出前插入脚本状态 + 墙钟耗时（精确到 0.1 秒）
5. **存储值回写**（仅 `Result` 变体）：将脚本运行后的 `stored_values` 持久化回 `CodeModeService`，供后续执行使用
6. **错误追加**（仅 `Result` 变体）：如有 `error_text`，追加 "Script error:" 内容项并标记 `success = false`

三种 `RuntimeResponse` 变体的语义：

| 变体 | 含义 | 特殊处理 |
|------|------|----------|
| `Yielded` | 脚本仍在运行，超时返回中间输出 | 无 |
| `Terminated` | 脚本被强制终止 | 无 |
| `Result` | 脚本执行完毕 | 回写 stored_values，检查 error_text |

### 嵌套工具调用（脚本内调用其他工具）

code-mode 脚本可以在 Deno 运行时内调用 Codex 的其他工具（如 shell、apply-patch、MCP 工具等），这通过 `CoreTurnHost` 实现（`mod.rs:108-148`）：

1. `CoreTurnHost` 实现 `CodeModeTurnHost` trait，提供 `invoke_tool()` 和 `notify()` 两个异步方法
2. `invoke_tool()` 委托给 `call_nested_tool()`（`mod.rs:276-316`）：
   - 禁止 `exec` 工具递归调用自身
   - 优先检查是否为 MCP 工具（通过 `parse_mcp_tool_name()`），是则构造 `ToolPayload::Mcp`
   - 否则根据 tool spec 的类型（Function / Freeform）构造对应的 `ToolPayload`
   - 生成唯一 call_id（格式 `exec-<uuid>`），通过 `ToolCallRuntime` 执行
3. `notify()` 用于脚本发送中间通知——将文本注入到当前 session 的 response items 中

## 函数签名与参数说明

### `CodeModeExecuteHandler::handle(invocation: ToolInvocation) -> Result<FunctionToolOutput, FunctionCallError>`

执行工具的入口。期望 `ToolPayload::Custom { input }` 类型的 payload，其中 `input` 为原始 JavaScript 源码。

> 源码位置：`execute_handler.rs:65-83`

### `CodeModeWaitHandler::handle(invocation: ToolInvocation) -> Result<FunctionToolOutput, FunctionCallError>`

等待工具的入口。期望 `ToolPayload::Function { arguments }` 类型的 JSON payload。

> 源码位置：`wait_handler.rs:48-82`

### `handle_runtime_response(exec, response, max_output_tokens, started_at) -> Result<FunctionToolOutput, String>`

统一处理 `RuntimeResponse`，执行类型转换、截断、状态头插入等后处理流程。execute 和 wait handler 共用此函数。

> 源码位置：`mod.rs:150-197`

### `build_enabled_tools(exec: &ExecContext) -> Vec<ToolDefinition>`

为 code-mode 脚本构建可用工具列表。内部创建一个 nested `ToolRouter`（包含当前 turn 的工具配置和 MCP 工具），然后转换为 code-mode 可理解的 `ToolDefinition`。

> 源码位置：`mod.rs:243-249`

### `call_nested_tool(exec, tool_runtime, tool_name, input, cancellation_token) -> Result<JsonValue, FunctionCallError>`

从 code-mode 脚本内部调用其他 Codex 工具的核心函数。处理 MCP / Function / Freeform 三种工具类型的参数构造和派发。

> 源码位置：`mod.rs:276-316`

## 接口/类型定义

### `ExecContext`

```rust
#[derive(Clone)]
pub(crate) struct ExecContext {
    pub(super) session: Arc<Session>,
    pub(super) turn: Arc<TurnContext>,
}
```

封装当前执行上下文，在 handler 和辅助函数之间传递 session 与 turn 引用。

> 源码位置：`mod.rs:44-48`

### `CodeModeService`

对 `codex_code_mode::CodeModeService` 的薄封装，提供 `execute()`、`wait()`、`stored_values()`、`replace_stored_values()`、`start_turn_worker()` 方法。`start_turn_worker()` 在 `Feature::CodeMode` 开启时创建 turn worker，注入 `CoreTurnHost` 作为工具调用回调。

> 源码位置：`mod.rs:50-106`

### `ExecWaitArgs`（wait handler 内部）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cell_id` | `String` | — | 要等待的执行单元 ID |
| `yield_time_ms` | `u64` | `10_000` | 超时后 yield 返回的毫秒数 |
| `max_tokens` | `Option<usize>` | `None` | 输出 token 上限 |
| `terminate` | `bool` | `false` | 是否强制终止 |

> 源码位置：`wait_handler.rs:17-26`

## 配置项与默认值

- **`PUBLIC_TOOL_NAME`**：工具名称常量 `"exec"`，即模型调用时使用的工具名
- **`WAIT_TOOL_NAME`**：工具名称常量 `"wait"`
- **`DEFAULT_WAIT_YIELD_TIME_MS`**：等待超时默认值 `10_000`（10 秒）
- **Feature Gate**：`start_turn_worker()` 检查 `Feature::CodeMode` 是否启用，未启用时返回 `None`，不会创建 worker

## Response Adapter 类型转换

`response_adapter.rs` 通过内部 `IntoProtocol` trait 实现 code-mode 类型到 protocol 类型的映射：

- `codex_code_mode::FunctionCallOutputContentItem::InputText` → `codex_protocol::FunctionCallOutputContentItem::InputText`
- `codex_code_mode::FunctionCallOutputContentItem::InputImage` → `codex_protocol::FunctionCallOutputContentItem::InputImage`
- `CodeModeImageDetail::{Auto, Low, High, Original}` → `ImageDetail::{Auto, Low, High, Original}`

> 源码位置：`response_adapter.rs:1-44`

## 边界 Case 与注意事项

- **递归调用保护**：`call_nested_tool()` 显式禁止 `exec` 工具调用自身（`mod.rs:283-286`），避免无限递归
- **空通知过滤**：`CoreTurnHost::notify()` 在文本为空/纯空白时直接返回 `Ok(())`，不注入空消息（`mod.rs:133-135`）
- **payload 类型不匹配**：execute handler 期望 `Custom` payload，wait handler 期望 `Function` payload，类型不匹配时返回描述性错误而非 panic
- **工具参数类型校验**：Function 类工具期望 JSON Object，Freeform 类工具期望纯 String，非预期类型均返回明确错误
- **Pragma 解析**：execute 的输入支持首行 `// @exec: {"yield_time_ms": 15000, "max_output_tokens": 2000}` 格式的 pragma 指令，但仅允许 `yield_time_ms` 和 `max_output_tokens` 两个键，未知键会报错
- **截断策略**：纯文本输出使用 `formatted_truncate_text_content_items_with_policy`（保留格式化信息），混合内容（含图片等）使用 `truncate_function_output_items_with_policy`