# ToolDispatch — 工具路由、注册与并行执行编排

## 概述与职责

ToolDispatch 是 Codex Core 中 **ToolsOrchestration** 子系统的核心调度层，负责将模型（LLM）请求的工具调用路由到正确的处理器并管理其执行。它在整个系统中的位置是：**SessionEngine** 接收到模型响应中的工具调用请求后，将其交给 ToolDispatch 完成分发和执行。

该模块由四个紧密协作的子模块组成：

| 子模块 | 职责 |
|--------|------|
| **router** | 入口层：解析模型响应为 `ToolCall`，配置路由器，分发调用到 registry |
| **registry** | 处理器注册表：存储 name→handler 映射，执行调度生命周期（hook、telemetry、gate） |
| **spec** | 规格构建：根据 `ToolsConfig` 组装完整的工具规格列表并注册所有 handler |
| **parallel** | 并行执行运行时：使用读写锁实现工具调用的并发控制和取消 |

辅助模块 **context** 定义了贯穿整个流程的核心数据类型（`ToolPayload`、`ToolInvocation`、`ToolOutput` trait 及其多种实现），**function_tool** 定义了错误类型 `FunctionCallError`。

## 关键流程

### 1. 工具路由器初始化

初始化从 `ToolRouter::from_config()` 开始（`codex-rs/core/src/tools/router.rs:50-88`）：

1. 接收 `ToolsConfig` 和 `ToolRouterParams`（包含 MCP 工具、app 工具、discoverable 工具、dynamic 工具）
2. 调用 `build_specs_with_discoverable_tools()` 构建 `ToolRegistryBuilder`
3. Builder 的 `build()` 方法返回 `(Vec<ConfiguredToolSpec>, ToolRegistry)`
4. 如果开启了 `code_mode_only`，过滤掉 code-mode 内部工具，生成 `model_visible_specs`

### 2. 工具规格与处理器组装（spec 模块）

`build_specs_with_discoverable_tools()`（`codex-rs/core/src/tools/spec.rs:32-236`）是整个工具注册的核心，它：

1. 调用 `codex_tools::build_tool_registry_plan()` 生成一个包含所有 spec 和 handler 声明的 plan
2. 遍历 plan 中的 specs，根据是否支持并行调用注册到 builder
3. 遍历 plan 中的 handler 声明，按 `ToolHandlerKind` 枚举实例化对应的 handler 并注册

支持的 handler 种类超过 30 种，涵盖：

- **Shell 执行**：`ShellHandler`、`UnifiedExecHandler`、`ShellCommandHandler`
- **文件操作**：`ApplyPatchHandler`、`ListDirHandler`、`ViewImageHandler`
- **Code Mode**：`CodeModeExecuteHandler`、`CodeModeWaitHandler`
- **JS REPL**：`JsReplHandler`、`JsReplResetHandler`
- **Multi-Agent V1**：`SpawnAgentHandler`、`WaitAgentHandler`、`SendInputHandler`、`ResumeAgentHandler`、`CloseAgentHandler`
- **Multi-Agent V2**：`SpawnAgentHandlerV2`、`WaitAgentHandlerV2`、`SendMessageHandlerV2`、`ListAgentsHandlerV2`、`CloseAgentHandlerV2`、`FollowupTaskHandlerV2`
- **MCP**：`McpHandler`、`McpResourceHandler`
- **工具发现**：`ToolSearchHandler`、`ToolSuggestHandler`
- **权限与交互**：`RequestPermissionsHandler`、`RequestUserInputHandler`
- **其他**：`PlanHandler`、`DynamicToolHandler`、`BatchJobHandler`、`TestSyncHandler`

### 3. 模型响应 → ToolCall 解析

`ToolRouter::build_tool_call()`（`codex-rs/core/src/tools/router.rs:116-211`）将模型返回的 `ResponseItem` 解析为统一的 `ToolCall` 结构。支持五种来源：

- **FunctionCall**：先尝试 `parse_mcp_tool_name()` 识别 MCP 工具（生成 `ToolPayload::Mcp`），否则作为普通函数调用（`ToolPayload::Function`）
- **ToolSearchCall**：仅处理 `execution == "client"` 的客户端搜索，生成 `ToolPayload::ToolSearch`
- **CustomToolCall**：生成 `ToolPayload::Custom`
- **LocalShellCall**：将 `Exec` action 转换为 `ToolPayload::LocalShell`
- 其他类型返回 `None`（不产生工具调用）

### 4. 工具调用分发（registry 核心流程）

`ToolRegistry::dispatch_any()`（`codex-rs/core/src/tools/registry.rs:218-442`）是整个调度的核心，执行完整的生命周期：

```
查找 handler → 校验 payload 类型 → PreToolUse hook → 判断是否 mutating → 等待 tool_call_gate → 执行 handler → 记录 telemetry → PostToolUse hook → AfterToolUse hook（legacy）→ 返回结果
```

关键步骤详解：

1. **Handler 查找**：通过 `tool_handler_key()` 组合 `namespace:name` 或纯 `name` 作为 key 查找（`codex-rs/core/src/tools/registry.rs:182-188`）。未找到则返回 `RespondToModel` 错误
2. **类型校验**：`handler.matches_kind()` 确保 payload 类型与 handler 兼容（Function handler 处理 Function/ToolSearch payload，Mcp handler 处理 Mcp payload）
3. **PreToolUse hook**：若 handler 提供 `pre_tool_use_payload()`，执行 pre-hook，hook 可以阻止执行
4. **Mutating 判断**：`handler.is_mutating()` 评估该调用是否可能修改环境
5. **Tool gate**：如果是 mutating 操作，等待 `tool_call_gate`（基于 `Readiness`）就绪
6. **Telemetry**：通过 `otel.log_tool_result_with_tags()` 包裹执行过程，自动记录工具名、call_id、MCP server、sandbox 策略等
7. **PostToolUse hook**：成功后执行 post-hook，hook 可以替换输出文本或停止后续执行
8. **AfterToolUse hook（legacy）**：保留的旧版 hook 接口，可以触发 `FailedAbort` 中止操作

### 5. 并行执行编排（parallel 模块）

`ToolCallRuntime`（`codex-rs/core/src/tools/parallel.rs:27-33`）封装了并行执行的核心机制：

```rust
struct ToolCallRuntime {
    router: Arc<ToolRouter>,
    session: Arc<Session>,
    turn_context: Arc<TurnContext>,
    tracker: SharedTurnDiffTracker,
    parallel_execution: Arc<RwLock<()>>,  // 关键：读写锁
}
```

**互斥策略**（`codex-rs/core/src/tools/parallel.rs:97-124`）：

- **支持并行的工具**（`supports_parallel == true`）：获取**读锁** `lock.read()`，可与其他并行工具同时执行
- **不支持并行的工具**（mutating 工具等）：获取**写锁** `lock.write()`，独占执行，阻塞所有其他工具

这是一个经典的 readers-writer lock 模式：多个只读工具可以并发，但写入（mutating）工具必须独占。

**取消支持**：每个工具调用通过 `tokio::select!` 监听 `CancellationToken`，被取消时返回 `AbortedToolOutput`，包含已经过的时间信息。

**错误处理**（`codex-rs/core/src/tools/parallel.rs:136-161`）：`failure_response()` 根据 payload 类型（ToolSearch、Custom、其他）生成对应格式的失败响应。

## 函数签名与参数说明

### `ToolRouter::from_config(config, params) -> Self`

构建路由器实例。

- `config: &ToolsConfig` — 工具配置（shell 类型、code_mode 开关等）
- `params: ToolRouterParams` — 包含 `mcp_tools`、`app_tools`、`discoverable_tools`、`dynamic_tools`

### `ToolRouter::build_tool_call(session, item) -> Result<Option<ToolCall>, FunctionCallError>`

将模型响应的 `ResponseItem` 解析为 `ToolCall`。返回 `None` 表示该 item 不产生工具调用。

### `ToolRouter::dispatch_tool_call_with_code_mode_result(session, turn, tracker, call, source) -> Result<AnyToolResult, FunctionCallError>`

分发工具调用到 registry。当 `js_repl_tools_only` 启用时，仅允许 `js_repl`/`js_repl_reset` 的 Direct 调用。

### `ToolCallRuntime::handle_tool_call(self, call, cancellation_token) -> Future<Result<ResponseInputItem, CodexErr>>`

并行运行时的入口。处理锁获取、取消检测、错误格式化，返回可直接送回模型的 `ResponseInputItem`。

### `ToolRegistryBuilder::register_handler<H>(name, handler)`

注册一个 `ToolHandler` 实现。重复注册同名 handler 会覆盖并打印警告。

## 接口/类型定义

### `ToolPayload` 枚举

```rust
pub enum ToolPayload {
    Function { arguments: String },        // 标准函数调用
    ToolSearch { arguments: SearchToolCallParams },  // 工具搜索
    Custom { input: String },              // 自定义工具
    LocalShell { params: ShellToolCallParams },      // 本地 shell
    Mcp { server: String, tool: String, raw_arguments: String },  // MCP 工具
}
```

> 源码位置：`codex-rs/core/src/tools/context.rs:48-66`

### `ToolHandler` trait

```rust
pub trait ToolHandler: Send + Sync {
    type Output: ToolOutput + 'static;
    fn kind(&self) -> ToolKind;
    fn matches_kind(&self, payload: &ToolPayload) -> bool;
    fn is_mutating(&self, invocation: &ToolInvocation) -> Future<Output = bool>;
    fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>;
    fn post_tool_use_payload(&self, call_id, payload, result) -> Option<PostToolUsePayload>;
    fn handle(&self, invocation: ToolInvocation) -> Future<Output = Result<Self::Output, FunctionCallError>>;
}
```

> 源码位置：`codex-rs/core/src/tools/registry.rs:38-82`

通过 blanket impl `AnyToolHandler for T where T: ToolHandler`，所有具体 handler 被类型擦除为 `Arc<dyn AnyToolHandler>` 存入 `HashMap`。

### `ToolOutput` trait

```rust
pub trait ToolOutput: Send {
    fn log_preview(&self) -> String;           // telemetry 日志预览
    fn success_for_logging(&self) -> bool;     // 是否成功
    fn to_response_item(&self, call_id, payload) -> ResponseInputItem;  // 转换为模型可消费的响应
    fn code_mode_result(&self, payload) -> JsonValue;  // code-mode 专用序列化
}
```

> 源码位置：`codex-rs/core/src/tools/context.rs:80-94`

实现了该 trait 的类型包括：`FunctionToolOutput`、`ApplyPatchToolOutput`、`AbortedToolOutput`、`ExecCommandToolOutput`、`ToolSearchOutput`、`CallToolResult`（MCP）。

### `FunctionCallError` 枚举

```rust
pub enum FunctionCallError {
    RespondToModel(String),    // 非致命，错误信息送回模型
    MissingLocalShellCallId,   // LocalShellCall 缺少 id
    Fatal(String),             // 致命错误，中止 turn
}
```

> 源码位置：`codex-rs/core/src/function_tool.rs:1-11`

### `ToolCallSource` 枚举

```rust
pub enum ToolCallSource {
    Direct,    // 模型直接调用
    JsRepl,    // 通过 JS REPL 间接调用
    CodeMode,  // 通过 Code Mode 间接调用
}
```

> 源码位置：`codex-rs/core/src/tools/context.rs:29-34`

在 `js_repl_tools_only` 模式下，只有 `Direct` 来源会被拦截检查。

## 配置项与默认值

- **`ToolsConfig.code_mode_only_enabled`**：当为 `true` 时，`model_visible_specs` 会过滤掉 code-mode 内部嵌套工具，模型只能看到顶层工具
- **`ToolsConfig.js_repl_tools_only`**：当为 `true` 时，Direct 来源只允许调用 `js_repl` 和 `js_repl_reset`，其他工具需通过 `codex.tool(...)` 在 JS REPL 中间接调用
- **`ToolsConfig.shell_command_backend`**：决定 `ShellCommandHandler` 的后端实现
- **`ConfiguredToolSpec.supports_parallel_tool_calls`**：每个工具的并行支持标志，决定是获取读锁还是写锁
- **Telemetry 常量**：`TELEMETRY_PREVIEW_MAX_BYTES = 2048`，`TELEMETRY_PREVIEW_MAX_LINES = 64`

## 边界 Case 与注意事项

- **Namespace 隔离**：handler 查找使用 `namespace:name` 组合键（`codex-rs/core/src/tools/registry.rs:182-188`）。同名工具在不同 namespace 下可以注册不同的 handler（如同名的 MCP 工具来自不同 server）
- **Handler 覆盖**：`register_handler()` 允许覆盖已注册的 handler，但会打印 warning。这在同一 `ToolHandlerKind` 被多次注册时可能发生
- **Payload 不匹配**：如果 handler 的 `kind()` 与 payload 类型不匹配（如 Function handler 收到 Mcp payload），会触发 `Fatal` 错误而非 `RespondToModel`，表示这是系统内部错误
- **取消的 shell 命令**：abort 消息格式因工具类型不同——shell 类工具显示 `"Wall time: X seconds\naborted by user"`，其他工具显示 `"aborted by user after Xs"`（`codex-rs/core/src/tools/parallel.rs:173-180`）
- **Hook 中止**：PostToolUse hook 可以替换工具的输出文本；AfterToolUse hook（legacy）的 `FailedAbort` 会导致整个调用返回 `Fatal` 错误
- **Tool gate**：mutating 工具在实际执行前会等待 `tool_call_gate.wait_ready()`，这是一个 readiness 信号机制，用于与外部审批流程（如用户确认）协调