# AgentLifecycle — 多智能体编排工具定义

## 概述与职责

AgentLifecycle 模块是 Codex 多智能体（Multi-Agent）编排系统的**工具定义层**，位于 `ToolSystem > ToolDefinitions > BuiltinToolDefs` 层级下。它不负责执行智能体调度逻辑，而是为 LLM 提供一组结构化的工具规格（`ToolSpec`），使模型能够通过工具调用来创建、通信、等待、关闭子智能体，以及批量处理 CSV 数据。

模块由两个文件组成：
- **`agent_tool.rs`**：核心智能体生命周期工具——生成、发送消息、等待、列举、关闭、恢复
- **`agent_job_tool.rs`**：批量作业工具——CSV 行级并发处理与结果上报

所有工厂函数均返回 `ToolSpec::Function(ResponsesApiTool {...})`，即符合 OpenAI Responses API 格式的函数工具定义。

## 配置类型

### `SpawnAgentToolOptions<'a>`

生成 `spawn_agent` 工具定义时所需的配置。

| 字段 | 类型 | 说明 |
|------|------|------|
| `available_models` | `&'a [ModelPreset]` | 可供子智能体选择的模型列表，会被渲染进工具描述文本中 |
| `agent_type_description` | `String` | 对智能体类型的描述，嵌入到 `agent_type` 参数的 schema 中 |

> 源码位置：`codex-rs/tools/src/agent_tool.rs:10-13`

### `WaitAgentTimeoutOptions`

等待工具的超时配置。

| 字段 | 类型 | 说明 |
|------|------|------|
| `default_timeout_ms` | `i64` | 默认超时时间（毫秒） |
| `min_timeout_ms` | `i64` | 最小允许超时 |
| `max_timeout_ms` | `i64` | 最大允许超时 |

这三个值会被格式化到 `timeout_ms` 参数的描述文本中，引导模型选择合理的等待时长。

> 源码位置：`codex-rs/tools/src/agent_tool.rs:16-20`

## 关键流程

### 工具定义的生成流程

每个 `create_*` 工厂函数遵循统一模式：

1. 构造参数 `properties`（`BTreeMap<String, JsonSchema>`），定义工具入参的名称、类型和描述
2. 组装 `ResponsesApiTool` 结构体，包含工具名称（`name`）、描述（`description`）、参数 schema（`parameters`）和可选的输出 schema（`output_schema`）
3. 包装为 `ToolSpec::Function(...)` 返回

所有工具均设置 `strict: false`，允许模型灵活调用而非严格参数匹配。

### v1 与 v2 协议的差异

模块为 `spawn_agent`、`send_input`、`wait_agent`、`close_agent` 提供了 v1/v2 两个版本，对应 MultiAgent v1 和 MultiAgentV2 两代编排协议：

**spawn_agent**：
- **v1**（`create_spawn_agent_tool_v1`）：使用 `fork_context: bool` 来决定是否分叉完整线程历史；参数均为可选；返回 `{ agent_id, nickname }`
- **v2**（`create_spawn_agent_tool_v2`）：引入 `task_name` 作为必填参数（规范化任务名，小写字母+数字+下划线）；使用 `fork_turns` 替代 `fork_context`，支持 `none`、`all` 或数字（仅分叉最近 N 轮）；`task_name` 和 `message` 均为必填；返回 `{ agent_id, task_name, nickname }`

**wait_agent**：
- **v1**（`create_wait_agent_tool_v1`）：需传入 `targets` 数组指定要等待的 agent id；返回 `{ status: { [agent_id]: AgentStatus }, timed_out: bool }`，即按 agent id 映射的状态字典
- **v2**（`create_wait_agent_tool_v2`）：无需指定 target，等待任意活跃智能体的邮箱更新；返回 `{ message: string, timed_out: bool }`，即简要摘要而非完整内容

**close_agent**：
- **v1**（`create_close_agent_tool_v1`）：`target` 参数描述为 "Agent id"
- **v2**（`create_close_agent_tool_v2`）：`target` 参数描述为 "Agent id or canonical task name"，兼容两种寻址方式

## 函数签名与参数说明

### 智能体生成

#### `create_spawn_agent_tool_v1(options: SpawnAgentToolOptions) -> ToolSpec`

生成 v1 版本的 `spawn_agent` 工具定义。

工具参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 否 | 初始纯文本任务指令（与 `items` 二选一） |
| `items` | array | 否 | 结构化输入项（支持 text/image/local_image/skill/mention） |
| `agent_type` | string | 否 | 智能体类型 |
| `fork_context` | boolean | 否 | 为 true 时将当前线程历史分叉到新智能体 |
| `model` | string | 否 | 模型覆盖 |
| `reasoning_effort` | string | 否 | 推理强度覆盖 |

> 源码位置：`codex-rs/tools/src/agent_tool.rs:22-43`

#### `create_spawn_agent_tool_v2(options: SpawnAgentToolOptions) -> ToolSpec`

生成 v2 版本的 `spawn_agent` 工具定义。

工具参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_name` | string | **是** | 任务名称，小写字母+数字+下划线 |
| `message` | string | **是** | 初始纯文本任务指令 |
| `agent_type` | string | 否 | 智能体类型 |
| `fork_turns` | string | 否 | 分叉模式：`none`、`all` 或正整数字符串 |
| `model` | string | 否 | 模型覆盖 |
| `reasoning_effort` | string | 否 | 推理强度覆盖 |

> 源码位置：`codex-rs/tools/src/agent_tool.rs:45-74`

### 消息发送

#### `create_send_input_tool_v1() -> ToolSpec`

生成 v1 版本的 `send_input` 工具。向已存在的智能体发送消息，支持中断模式。

工具参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | string | **是** | 目标 agent id |
| `message` | string | 否 | 纯文本消息（与 `items` 二选一） |
| `items` | array | 否 | 结构化输入项 |
| `interrupt` | boolean | 否 | 为 true 时立即中断当前任务处理此消息 |

> 源码位置：`codex-rs/tools/src/agent_tool.rs:76-118`

#### `create_send_message_tool() -> ToolSpec`

生成 `send_message` 工具。向智能体添加消息但**不触发新的处理轮次**，仅入队。MultiAgentV2 专用，目前仅支持文本。

工具参数：`target`（必填）、`message`（必填）

> 源码位置：`codex-rs/tools/src/agent_tool.rs:120-151`

#### `create_followup_task_tool() -> ToolSpec`

生成 `followup_task` 工具。向非根智能体发送消息**并触发新的处理轮次**。支持 `interrupt` 标志。MultiAgentV2 专用。

工具参数：`target`（必填）、`message`（必填）、`interrupt`（可选）

> 源码位置：`codex-rs/tools/src/agent_tool.rs:153-193`

### 等待与状态

#### `create_wait_agent_tool_v1(options: WaitAgentTimeoutOptions) -> ToolSpec`

等待指定智能体达到最终状态。返回各智能体的最终状态字典和超时标志。

工具参数：`targets`（string 数组，必填）、`timeout_ms`（可选）

> 源码位置：`codex-rs/tools/src/agent_tool.rs:219-229`

#### `create_wait_agent_tool_v2(options: WaitAgentTimeoutOptions) -> ToolSpec`

等待任意活跃智能体的邮箱更新。返回简要摘要而非完整内容。无需指定目标。

工具参数：`timeout_ms`（可选）

> 源码位置：`codex-rs/tools/src/agent_tool.rs:231-241`

### 列举、恢复与关闭

#### `create_list_agents_tool() -> ToolSpec`

列出当前根线程树中的活跃智能体，可选按任务路径前缀过滤。

工具参数：`path_prefix`（可选）

输出包含 `agents` 数组，每个元素含 `agent_name`、`agent_status`、`last_task_message`。

> 源码位置：`codex-rs/tools/src/agent_tool.rs:243-268`

#### `create_resume_agent_tool() -> ToolSpec`

恢复已关闭的智能体，使其可重新接收 `send_input` 和 `wait_agent` 调用。

工具参数：`id`（必填）

> 源码位置：`codex-rs/tools/src/agent_tool.rs:195-217`

#### `create_close_agent_tool_v1() / create_close_agent_tool_v2() -> ToolSpec`

关闭智能体及其所有后代，返回关闭前的状态。v2 版本支持按 task name 或 agent id 寻址。

工具参数：`target`（必填）

> 源码位置：`codex-rs/tools/src/agent_tool.rs:270-314`

### CSV 批量作业

#### `create_spawn_agents_on_csv_tool() -> ToolSpec`

生成 `spawn_agents_on_csv` 工具。读取 CSV 文件，为每一行生成一个 worker 子智能体，使用模板化指令（`{column_name}` 占位符替换行值）。调用后阻塞直到所有行处理完毕，自动将结果导出到 CSV。

工具参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `csv_path` | string | **是** | 输入 CSV 文件路径 |
| `instruction` | string | **是** | 指令模板，`{column}` 占位符会被替换为行值 |
| `id_column` | string | 否 | 用作稳定项目 id 的列名 |
| `output_csv_path` | string | 否 | 结果导出路径 |
| `max_concurrency` | number | 否 | 最大并发 worker 数，默认 16 |
| `max_workers` | number | 否 | `max_concurrency` 的别名，设为 1 可串行执行 |
| `max_runtime_seconds` | number | 否 | 单个 worker 最大运行时间，默认 1800 秒 |
| `output_schema` | object | 否 | 约束 worker 上报结果的 JSON schema |

> 源码位置：`codex-rs/tools/src/agent_job_tool.rs:6-84`

#### `create_report_agent_job_result_tool() -> ToolSpec`

生成 `report_agent_job_result` 工具。仅供 worker 子智能体调用，用于上报单行处理结果。主智能体不应调用此工具。

工具参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `job_id` | string | **是** | 作业标识符 |
| `item_id` | string | **是** | 作业项标识符 |
| `result` | object | **是** | 结果 JSON 对象 |
| `stop` | boolean | 否 | 为 true 时在记录此结果后取消剩余项目 |

> 源码位置：`codex-rs/tools/src/agent_job_tool.rs:86-137`

## 接口/类型定义

### AgentStatus 输出 Schema

智能体状态是一个 `oneOf` 联合类型，贯穿多个工具的输出 schema（`codex-rs/tools/src/agent_tool.rs:316-345`）：

| 变体 | 类型 | 说明 |
|------|------|------|
| `"pending_init"` | string enum | 初始化中 |
| `"running"` | string enum | 运行中 |
| `"interrupted"` | string enum | 已中断 |
| `"shutdown"` | string enum | 已关闭 |
| `"not_found"` | string enum | 未找到 |
| `{ "completed": string \| null }` | object | 已完成，可携带最终消息 |
| `{ "errored": string }` | object | 出错，携带错误信息 |

### 协作输入项 Schema（Collab Input Items）

`items` 参数使用的结构化输入数组，支持多种内容类型（`codex-rs/tools/src/agent_tool.rs:496-546`）：

| 字段 | 说明 |
|------|------|
| `type` | 内容类型：`text`、`image`、`local_image`、`skill`、`mention` |
| `text` | type 为 text 时的文本内容 |
| `image_url` | type 为 image 时的图片 URL |
| `path` | type 为 local_image/skill 时的路径，或 type 为 mention 时的目标（如 `app://<connector-id>`） |
| `name` | type 为 skill/mention 时的显示名称 |

## 边界 Case 与注意事项

- **v1/v2 的选择由上层 `RegistryPlan` 决定**：本模块只提供两套定义，具体使用哪个版本取决于 `ToolsConfig` 中的智能体协议版本配置。
- **`spawn_agent` 工具描述内嵌详细的使用策略**：`spawn_agent_tool_description()` 函数（`codex-rs/tools/src/agent_tool.rs:640-681`）生成了一段长达数十行的指导文本，教导模型何时委派任务、如何设计子任务、委派后如何行动，以及并行委派模式。这段文本是工具描述的一部分，会被发送给 LLM。
- **模型列表动态渲染**：`spawn_agent_models_description()`（`codex-rs/tools/src/agent_tool.rs:683-710`）仅展示 `show_in_picker == true` 的模型，包含其名称、描述、默认推理强度和所有支持的推理强度级别。
- **CSV 工具是阻塞式的**：`spawn_agents_on_csv` 调用后会阻塞直到所有行处理完毕。如果 worker 未调用 `report_agent_job_result`，对应行被视为失败。
- **`send_message` vs `followup_task`**：前者仅入队不触发新轮次，后者会触发处理——选择取决于是否需要目标智能体立即响应。
- **`stop` 字段的早停机制**：`report_agent_job_result` 的 `stop` 参数允许 worker 在发现关键问题时取消整个批量作业的剩余项目。