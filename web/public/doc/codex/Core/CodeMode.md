# CodeMode — 代码执行模式与协作模式模板

## 概述与职责

CodeMode 模块由两个独立的 Rust crate 组成，共同服务于 Codex 核心（Core）的代码执行和交互策略：

1. **`codex-code-mode`**（`codex-rs/code-mode/`）：提供基于 V8 引擎的 JavaScript 运行时，让 AI Agent 能够通过 `exec`/`wait` 工具语义执行长时间运行的代码会话。Agent 可以在隔离的 V8 沙箱中编写 JavaScript 来编排和组合其他工具调用，而不是逐个发起工具请求。

2. **`codex-collaboration-mode-templates`**（`codex-rs/collaboration-mode-templates/`）：包含四种协作模式的 Markdown 提示模板（default、execute、pair-programming、plan），决定 Agent 在不同场景下的交互风格。

在系统架构中，CodeMode 属于 **Core**（核心代理引擎）的组成部分。Core 通过 ToolSystem 暴露 `exec`/`wait` 工具，而这些工具的底层实现就是本模块的 `CodeModeService`。协作模式模板则被 Core 在构造系统提示词时引入，用于塑造 Agent 的行为模式。同级模块包括 TUI、CLI、ModelProviders、Sandbox 等。

---

## 关键流程

### exec/wait 执行流程

这是本模块最核心的工作流。Agent 通过 `exec` 工具提交 JavaScript 代码，通过 `wait` 工具轮询或终止正在运行的会话。

**1. 执行启动（exec 调用）**

```
Agent 发起 exec → CodeModeService::execute()
  → 分配 cell_id（递增计数器）
  → spawn_runtime() 在独立线程中创建 V8 Isolate
  → 启动 session control 协程（tokio::spawn）
  → 返回 RuntimeResponse 给调用方
```

`CodeModeService::execute()` 是入口（`codex-rs/code-mode/src/service.rs:78-113`）。每次调用会：
- 通过原子计数器 `next_cell_id` 分配唯一的 `cell_id`
- 调用 `spawn_runtime()` 在新的操作系统线程中创建 V8 Isolate
- 启动异步会话控制循环 `run_session_control`，管理运行时事件和超时逻辑
- 通过 `oneshot` channel 等待首次响应

**2. V8 运行时生命周期**

`spawn_runtime()`（`codex-rs/code-mode/src/runtime/mod.rs:101-127`）在新线程上执行 `run_runtime()`，流程如下：

1. 初始化 V8 平台（全局仅一次，通过 `OnceLock`）
2. 创建新的 V8 Isolate 和 Context
3. 将 `RuntimeState` 存入 Isolate 的 slot（包含事件发送器、待决工具调用、存储值等）
4. 调用 `globals::install_globals()` 注册全局函数和对象
5. 以 ES Module 形式编译和执行用户提交的 JavaScript 源码
6. 进入命令循环：等待 `RuntimeCommand`（工具响应或终止信号），解析工具调用的 Promise，检查完成状态

**3. Yield 与轮询机制**

当脚本执行时间超过 `yield_time_ms`（默认 10 秒）时，会话控制循环会自动 yield：

- 向调用方返回 `RuntimeResponse::Yielded`，包含已累积的输出项和 `cell_id`
- V8 线程继续运行，脚本不受影响
- Agent 可通过 `wait` 工具（`CodeModeService::wait()`，`service.rs:115-143`）重新连接到该 cell，获取新的输出
- 脚本也可以主动调用 `yield_control()` 提前让出控制权

**4. 工具调用桥接**

当脚本中调用 `await tools.some_tool(...)` 时：

1. `tool_callback`（`callbacks.rs:12-52`）将参数序列化为 JSON，创建 Promise，发送 `RuntimeEvent::ToolCall`
2. 事件通过 `TurnMessage::ToolCall` 传递到 `CodeModeTurnWorker`
3. `CodeModeTurnWorker`（由 `start_turn_worker()` 启动，`service.rs:145-209`）调用 `CodeModeTurnHost::invoke_tool()` 执行实际工具
4. 工具结果通过 `RuntimeCommand::ToolResponse/ToolError` 发回 V8 线程
5. V8 线程中 `resolve_tool_response()`（`module_loader.rs:66-101`）resolve/reject 对应的 Promise

### 协作模式加载流程

`codex-collaboration-mode-templates` crate 极其简洁——仅通过 `include_str!` 宏将四个 `.md` 模板文件编译嵌入为常量字符串（`codex-rs/collaboration-mode-templates/src/lib.rs:1-4`），供 Core 在构造系统提示词时直接引用。

---

## 函数签名与参数说明

### `CodeModeService`

核心服务结构体，管理所有活跃的代码执行会话。

```rust
impl CodeModeService {
    pub fn new() -> Self
    pub async fn execute(&self, request: ExecuteRequest) -> Result<RuntimeResponse, String>
    pub async fn wait(&self, request: WaitRequest) -> Result<RuntimeResponse, String>
    pub fn start_turn_worker(&self, host: Arc<dyn CodeModeTurnHost>) -> CodeModeTurnWorker
    pub async fn stored_values(&self) -> HashMap<String, JsonValue>
    pub async fn replace_stored_values(&self, values: HashMap<String, JsonValue>)
}
```

> 源码位置：`codex-rs/code-mode/src/service.rs:51-216`

- **`execute(request)`**：启动新的 V8 会话执行 JavaScript 代码。返回 `Yielded`（脚本仍在运行）或 `Result`（脚本已完成）。
- **`wait(request)`**：轮询或终止一个已 yield 的会话。通过 `cell_id` 定位目标会话。当 `terminate` 为 true 时，发送终止信号并等待 V8 Isolate 关闭。
- **`start_turn_worker(host)`**：启动后台工作协程，负责将脚本中的工具调用和通知转发给 `CodeModeTurnHost` 实现。返回的 `CodeModeTurnWorker` 在 drop 时自动关闭。

### `ExecuteRequest`

```rust
pub struct ExecuteRequest {
    pub tool_call_id: String,          // 当前 exec 工具调用的 ID
    pub enabled_tools: Vec<ToolDefinition>, // 脚本中可用的嵌套工具定义
    pub source: String,                // JavaScript 源码
    pub stored_values: HashMap<String, JsonValue>, // 跨 cell 持久化的键值存储
    pub yield_time_ms: Option<u64>,    // 自动 yield 超时（毫秒），默认 10000
    pub max_output_tokens: Option<usize>, // 输出 token 预算，默认 10000
}
```

> 源码位置：`codex-rs/code-mode/src/runtime/mod.rs:24-32`

### `WaitRequest`

```rust
pub struct WaitRequest {
    pub cell_id: String,      // 要轮询的 cell ID
    pub yield_time_ms: u64,   // 等待超时
    pub terminate: bool,      // 是否终止该 cell
}
```

> 源码位置：`codex-rs/code-mode/src/runtime/mod.rs:34-39`

### `RuntimeResponse`

```rust
pub enum RuntimeResponse {
    Yielded { cell_id: String, content_items: Vec<FunctionCallOutputContentItem> },
    Terminated { cell_id: String, content_items: Vec<FunctionCallOutputContentItem> },
    Result { cell_id: String, content_items: Vec<..>, stored_values: HashMap<..>, error_text: Option<String> },
}
```

> 源码位置：`codex-rs/code-mode/src/runtime/mod.rs:41-57`

- **Yielded**：脚本仍在运行，返回已累积的中间输出
- **Terminated**：脚本被外部终止
- **Result**：脚本正常完成或出错，包含最终输出和持久化存储值

### `CodeModeTurnHost` trait

```rust
#[async_trait]
pub trait CodeModeTurnHost: Send + Sync {
    async fn invoke_tool(&self, tool_name: String, input: Option<JsonValue>,
        cancellation_token: CancellationToken) -> Result<JsonValue, String>;
    async fn notify(&self, call_id: String, cell_id: String, text: String) -> Result<(), String>;
}
```

> 源码位置：`codex-rs/code-mode/src/service.rs:26-35`

由调用方实现，用于实际执行嵌套工具和发送通知。

### 描述构建函数

| 函数 | 说明 |
|------|------|
| `parse_exec_source(input)` | 解析 exec 输入，提取可选的 `// @exec:` pragma 和 JavaScript 代码 |
| `build_exec_tool_description(tools, code_mode_only)` | 生成 exec 工具的描述文本，code_mode_only 模式下内联嵌套工具文档 |
| `build_wait_tool_description()` | 返回 wait 工具的静态描述文本 |
| `normalize_code_mode_identifier(name)` | 将工具名转换为合法的 JavaScript 标识符（如 `hidden-dynamic-tool` → `hidden_dynamic_tool`） |
| `augment_tool_definition(def)` | 为非 exec 工具的描述追加 TypeScript 类型声明 |
| `render_json_schema_to_typescript(schema)` | 将 JSON Schema 转换为 TypeScript 类型字符串 |

> 源码位置：`codex-rs/code-mode/src/description.rs`

---

## 接口与类型定义

### `FunctionCallOutputContentItem`

V8 运行时产出的内容项，最终会作为工具调用结果返回给模型。

```rust
pub enum FunctionCallOutputContentItem {
    InputText { text: String },
    InputImage { image_url: String, detail: Option<ImageDetail> },
}
```

> 源码位置：`codex-rs/code-mode/src/response.rs:13-24`

### `ImageDetail`

```rust
pub enum ImageDetail { Auto, Low, High, Original }
```

### `CodeModeToolKind`

```rust
pub enum CodeModeToolKind { Function, Freeform }
```

- **Function**：结构化输入（JSON Schema），参数名为 `args`
- **Freeform**：自由文本输入，参数名为 `input`

### V8 全局 API

脚本在 V8 Isolate 中可使用的全局对象和函数（`codex-rs/code-mode/src/runtime/globals.rs:11-38`）：

| 全局名 | 类型 | 说明 |
|--------|------|------|
| `tools` | Object | 嵌套工具对象，如 `await tools.exec_command(...)` |
| `ALL_TOOLS` | Array<{name, description}> | 可用工具元数据列表 |
| `text(value)` | Function → undefined | 追加文本输出项 |
| `image(urlOrItem)` | Function → undefined | 追加图片输出项 |
| `store(key, value)` | Function → void | 持久化键值对（跨 cell） |
| `load(key)` | Function → any | 读取持久化值 |
| `notify(value)` | Function → undefined | 立即注入额外输出通知 |
| `yield_control()` | Function → void | 主动 yield 控制权 |
| `exit()` | Function → never | 立即结束脚本（通过抛出哨兵异常 `__codex_code_mode_exit__` 实现） |

注意：V8 原生的 `console` 对象会被主动删除（`globals.rs:13-17`），脚本中不可用。

---

## 协作模式模板

四种模板定义了 Agent 在不同场景下的行为策略，作为编译时常量嵌入 `codex-collaboration-mode-templates` crate：

### Default（默认模式）

最简模板（`templates/default.md`）。声明当前为默认模式，模式仅在开发者指令明确切换时变更。包含 `{{REQUEST_USER_INPUT_AVAILABILITY}}` 和 `{{ASKING_QUESTIONS_GUIDANCE}}` 两个运行时插值变量。

### Execute（执行模式）

独立执行模式（`templates/execute.md`）。核心原则：
- **假设优先**：缺少信息时做合理假设并声明，不问用户
- **长任务管理**：分解为里程碑，逐步验证，维护进度清单
- **时间意识**：最小化用户等待，通常几秒内完成一轮交互
- **主动进度汇报**：使用 plan 工具更新进度

### Pair Programming（结对编程模式）

协作式交互（`templates/pair_programming.md`）。核心特点：
- 避免步骤过大或耗时操作，保持与用户同步
- 遇到多条可行路径时提供清晰选项并邀请用户决策
- 调试时将用户视为队友，可请求用户协助提供信息

### Plan（计划模式）

三阶段计划流程（`templates/plan.md`）：
1. **环境探索**：通过非修改性操作了解环境，避免直接提问
2. **意图澄清**：通过提问确定目标、范围、约束
3. **实现规划**：细化到"决策完备"的实施计划

严格禁止在计划模式中执行修改操作。最终输出包裹在 `<proposed_plan>` 标签中。

模板中使用了模板变量（如 `{{KNOWN_MODE_NAMES}}`、`{{REQUEST_USER_INPUT_AVAILABILITY}}`），在运行时由 Core 填充。

---

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_EXEC_YIELD_TIME_MS` | 10,000 | exec 默认自动 yield 超时（毫秒） |
| `DEFAULT_WAIT_YIELD_TIME_MS` | 10,000 | wait 默认超时（毫秒） |
| `DEFAULT_MAX_OUTPUT_TOKENS_PER_EXEC_CALL` | 10,000 | 单次 exec 调用的输出 token 预算 |
| `PUBLIC_TOOL_NAME` | `"exec"` | exec 工具的公开名称 |
| `WAIT_TOOL_NAME` | `"wait"` | wait 工具的公开名称 |
| `CODE_MODE_PRAGMA_PREFIX` | `"// @exec:"` | exec 源码中可选的首行 pragma 前缀 |

> 源码位置：`codex-rs/code-mode/src/runtime/mod.rs:19-21`，`codex-rs/code-mode/src/lib.rs:29-30`

用户可通过 `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}` pragma 在每次调用时覆盖 yield 超时和输出 token 限制。

---

## 边界 Case 与注意事项

- **模块导入被禁止**：V8 中所有 `import` 语句（静态和动态）都会抛出 `"Unsupported import in exec"` 错误（`module_loader.rs:223-235`）。脚本是纯计算环境，无文件系统、无网络、无 Node.js API。

- **exit() 的实现方式**：`exit()` 通过设置 `exit_requested` 标志后抛出哨兵字符串 `"__codex_code_mode_exit__"` 实现。运行时检测到这个特殊异常时会将其视为正常退出，不报告错误（`module_loader.rs:54-64`）。

- **cell 丢失处理**：如果 `wait` 引用的 `cell_id` 不存在（已完成或从未存在），返回包含错误信息 `"exec cell {cell_id} not found"` 的 `Result` 响应，而非报错（`service.rs:252-259`）。

- **终止等待运行时关闭**：`Terminate` 命令不会立即返回响应——它等待 V8 线程实际关闭后才发送 `Terminated` 响应，确保资源清理完成（`service.rs:419-440`，测试验证于 `service.rs:608-672`）。

- **全局辅助函数返回 undefined**：`text()`、`image()`、`notify()` 均返回 `undefined`（非 Promise），这是有意为之的设计，使其行为类似于纯副作用操作（测试验证于 `service.rs:564-605`）。

- **V8 平台全局初始化**：V8 平台通过 `OnceLock` 保证在进程生命周期内仅初始化一次（`runtime/mod.rs:155-164`），即使多个 Isolate 被创建和销毁。

- **工具名归一化**：所有非法 JavaScript 标识符字符都会被替换为下划线（`description.rs:197-219`），如 `mcp::ologs::get_profile` 变为 `mcp__ologs__get_profile`。