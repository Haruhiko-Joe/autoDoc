# SharedUtilities — 多代理共享工具函数

## 概述与职责

`multi_agents_common.rs` 是多代理（Multi-Agent）子系统的**公共工具库**，为 V1 和 V2 两代多代理 handler 提供共享的基础设施。它位于 `Core > ToolsOrchestration > Handlers > MultiAgent` 层级中，与具体的 V1/V2 handler 实现并列，被两者共同依赖。

该模块不包含任何 handler trait 实现，而是提供以下几类纯函数和常量：

- **等待超时常量**：约束 wait 操作的轮询间隔
- **参数提取与序列化**：从 tool payload 中提取参数、将结果序列化为不同格式
- **Agent 状态格式化**：将内部 agent 状态映射为协议层的状态条目
- **错误映射**：将底层 `CodexErr` 转为面向模型的 `FunctionCallError`
- **输入解析与验证**：校验 message/items 互斥约束
- **配置构建**：为子 agent 的 spawn 和 resume 组装 Config 快照，传播运行时策略
- **特性门控与模型验证**：根据 spawn 深度禁用特性、校验模型和 reasoning effort 的合法性

> 源码位置：`codex-rs/core/src/tools/handlers/multi_agents_common.rs`

---

## 关键流程 Walkthrough

### 子 Agent 配置构建流程（spawn）

这是本模块最核心的流程，确保子 agent 继承父 agent 的运行时状态而非过时的持久化配置：

1. 调用 `build_agent_spawn_config()`，传入 `BaseInstructions` 和当前 `TurnContext`
2. 内部调用 `build_agent_shared_config()`：
   - 克隆父 agent 的 `turn.config` 作为基线（`multi_agents_common.rs:224-225`）
   - 覆盖模型选择（slug、provider、reasoning effort/summary）
   - 覆盖 developer instructions 和 compact prompt
   - 调用 `apply_spawn_agent_runtime_overrides()` 传播运行时策略
3. `apply_spawn_agent_runtime_overrides()` 将以下 turn 级别的运行时状态写入 config（`multi_agents_common.rs:241-265`）：
   - `approval_policy`（审批策略）
   - `shell_environment_policy`（Shell 环境策略）
   - `sandbox_policy` / `file_system_sandbox_policy` / `network_sandbox_policy`（沙箱策略）
   - `codex_linux_sandbox_exe`（Linux 沙箱可执行文件路径）
   - `cwd`（工作目录）
4. 最后设置 `base_instructions`

### 子 Agent 配置构建流程（resume）

与 spawn 类似，但有两个关键差异：
1. 调用 `build_agent_resume_config()` 时额外传入 `child_depth`
2. 调用 `apply_spawn_agent_overrides()` 根据深度禁用特性
3. 将 `base_instructions` 设为 `None`，因为 resume 时指令来源于 rollout/session 元数据

### 模型选择验证流程

`apply_requested_spawn_agent_model_overrides()` 处理 spawn 时的自定义模型请求（`multi_agents_common.rs:274-323`）：

1. 若未请求自定义模型和 reasoning effort，直接返回
2. 若指定了模型名：
   - 从 `models_manager` 获取离线模型列表
   - 调用 `find_spawn_agent_model_name()` 做精确匹配校验（失败时返回可用模型列表）
   - 获取该模型的 `model_info`
   - 若同时指定了 reasoning effort，校验其是否在该模型支持的级别中
   - 否则使用该模型的默认 reasoning level
3. 若仅指定了 reasoning effort（未指定模型）：
   - 针对父 agent 的当前模型校验 reasoning effort 的合法性

---

## 函数签名与参数说明

### 常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MIN_WAIT_TIMEOUT_MS` | 10,000 (10s) | 最小等待超时，防止紧密轮询消耗 CPU |
| `DEFAULT_WAIT_TIMEOUT_MS` | 30,000 (30s) | 默认等待超时 |
| `MAX_WAIT_TIMEOUT_MS` | 3,600,000 (1h) | 最大等待超时 |

### 参数提取

#### `function_arguments(payload: ToolPayload) -> Result<String, FunctionCallError>`

从 `ToolPayload::Function` 变体中提取 `arguments` 字符串。非 Function 变体返回错误。

### 序列化辅助

#### `tool_output_json_text<T: Serialize>(value: &T, tool_name: &str) -> String`

将任意可序列化值转为 JSON 字符串。序列化失败时返回包含错误信息的 JSON 字符串（而非 panic）。

#### `tool_output_response_item<T: Serialize>(call_id, payload, value, success, tool_name) -> ResponseInputItem`

在 `tool_output_json_text` 基础上包装为 `ResponseInputItem`，用于标准的 tool-call 响应流。

#### `tool_output_code_mode_result<T: Serialize>(value: &T, tool_name: &str) -> JsonValue`

类似 `tool_output_json_text`，但返回 `serde_json::Value` 而非字符串，供 code-mode 场景使用。

### Agent 状态格式化

#### `build_wait_agent_statuses(statuses, receiver_agents) -> Vec<CollabAgentStatusEntry>`

将内部 `HashMap<ThreadId, AgentStatus>` 映射为协议层的 `CollabAgentStatusEntry` 列表。

- 优先处理 `receiver_agents` 中已知的 agent（保留 nickname 和 role 信息）
- 额外的未知 agent 按 `thread_id` 字典序追加，不携带 nickname/role
- 空 statuses 时返回空 Vec

### 错误映射

#### `collab_spawn_error(err: CodexErr) -> FunctionCallError`

映射 spawn 阶段的错误。特殊处理 `"thread manager dropped"` 为 `"collab manager unavailable"`，其余 `UnsupportedOperation` 直接透传消息。

#### `collab_agent_error(agent_id: ThreadId, err: CodexErr) -> FunctionCallError`

映射 agent 操作阶段的错误。区分处理：
- `ThreadNotFound` → `"agent with id {id} not found"`
- `InternalAgentDied` → `"agent with id {agent_id} is closed"`
- `UnsupportedOperation` → `"collab manager unavailable"`

### Session Source 构建

#### `thread_spawn_source(parent_thread_id, parent_session_source, depth, agent_role, task_name) -> Result<SessionSource, FunctionCallError>`

构建子 agent 线程的 `SessionSource::SubAgent(ThreadSpawn {...})`。若提供了 `task_name`，会从父级的 `agent_path` 派生出子路径（通过 `AgentPath::join`）。

### 输入解析与验证

#### `parse_collab_input(message: Option<String>, items: Option<Vec<UserInput>>) -> Result<Op, FunctionCallError>`

校验 message 和 items 的互斥约束：

| message | items | 结果 |
|---------|-------|------|
| Some | Some | 错误："不能同时提供两者" |
| None | None | 错误："必须提供其一" |
| Some(空白) | None | 错误："空消息不能发送" |
| Some(非空) | None | 包装为 `UserInput::Text` 的 Op |
| None | Some(非空) | 直接转为 Op |
| None | Some(空) | 错误："items 不能为空" |

### 配置构建

#### `build_agent_spawn_config(base_instructions, turn) -> Result<Config, FunctionCallError>`

为新 spawn 的子 agent 构建完整 Config 快照，设置 `base_instructions`。

#### `build_agent_resume_config(turn, child_depth) -> Result<Config, FunctionCallError>`

为 resume 的子 agent 构建 Config，应用深度相关的特性门控，`base_instructions` 设为 `None`。

#### `apply_spawn_agent_runtime_overrides(config, turn) -> Result<(), FunctionCallError>`

将 turn 级别的运行时策略（approval、sandbox、cwd 等）传播到子 agent config。这是确保父子 agent 策略一致性的关键步骤。

### 特性门控

#### `apply_spawn_agent_overrides(config: &mut Config, child_depth: i32)`

当 `child_depth >= agent_max_depth` 且未启用 `MultiAgentV2` 特性时，禁用 `SpawnCsv` 和 `Collab` 特性，阻止子 agent 继续 spawn 新 agent（`multi_agents_common.rs:267-272`）。

注意：V2 协议不受此深度限制。

### 模型验证

#### `apply_requested_spawn_agent_model_overrides(session, turn, config, requested_model, requested_reasoning_effort) -> Result<(), FunctionCallError>`

异步函数。校验并应用 spawn 时请求的自定义模型和 reasoning effort。详见上方"模型选择验证流程"。

内部辅助函数：
- `find_spawn_agent_model_name()`：在可用模型列表中精确匹配，失败时列出所有可用模型
- `validate_spawn_agent_reasoning_effort()`：校验 reasoning effort 是否在目标模型支持的级别中

---

## 类型定义

本模块不定义新类型，但密切依赖以下外部类型：

| 类型 | 来源 | 用途 |
|------|------|------|
| `ToolPayload` | `crate::tools::context` | 工具调用的载荷，本模块从中提取 Function 参数 |
| `FunctionCallError` | `crate::function_tool` | 统一的工具调用错误类型，`RespondToModel` 变体向模型返回错误信息 |
| `AgentStatus` | `crate::agent` | 内部 agent 状态 |
| `TurnContext` | `crate::codex` | 当前 turn 的运行时上下文，携带模型信息、策略、配置等 |
| `Config` | `crate::config` | agent 配置快照 |
| `CollabAgentStatusEntry` | `codex_protocol` | 协议层的 agent 状态条目 |
| `SessionSource` / `SubAgentSource` | `codex_protocol` | 标识 agent 线程来源的枚举 |
| `ReasoningEffort` / `ReasoningEffortPreset` | `codex_protocol::openai_models` | reasoning effort 级别及其预设 |

---

## 边界 Case 与注意事项

- **序列化容错**：`tool_output_json_text` 和 `tool_output_code_mode_result` 在序列化失败时不会 panic，而是返回包含错误描述的 JSON 字符串。这保证了即使序列化异常，工具调用链也不会中断。

- **运行时策略传播的必要性**：`build_agent_shared_config` 的注释明确警告——跳过 `apply_spawn_agent_runtime_overrides` 直接克隆旧 config 会导致子 agent 使用错误的 provider 或运行时策略。这是因为 approval policy、sandbox policy 等值由当前 turn 动态决定，而非静态配置。

- **V1 vs V2 深度限制差异**：`apply_spawn_agent_overrides` 中，V2 协议（`Feature::MultiAgentV2`）不受 `agent_max_depth` 限制，而 V1 在达到最大深度时会被禁用 spawn 能力。

- **模型验证使用离线列表**：`apply_requested_spawn_agent_model_overrides` 使用 `RefreshStrategy::Offline` 获取模型列表，避免在 spawn 路径上引入网络延迟，但这意味着如果模型列表未预加载，可能无法找到某些模型。

- **approval_policy 和 sandbox_policy 的 set 可能失败**：`apply_spawn_agent_runtime_overrides` 中对这两个策略的 `set()` 调用会进行校验，不合法的值会被映射为 `FunctionCallError` 返回给模型。