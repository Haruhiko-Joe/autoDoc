# MultiAgentV2 — 第二代多智能体协作工具

## 概述与职责

MultiAgentV2 是 Codex 多智能体协作系统的第二代工具处理层，位于 **Core → ToolsOrchestration → Handlers → MultiAgent** 层级中。它实现了六个工具操作（`spawn_agent`、`wait_agent`、`close_agent`、`send_message`、`followup_task`、`list_agents`），为模型提供完整的智能体生命周期管理和结构化通信能力。

与 V1 相比，V2 的核心改进包括：
- **基于 `AgentPath` 的路由**：使用层级化的命名路径（如 `/root/subtask-a/worker-1`）代替原始 `ThreadId`，通过 `resolve_agent_target` 实现名称到线程的解析
- **统一消息模块**：`message_tool` 模块将 `send_message` 和 `followup_task` 统一为同一提交路径，仅通过 `MessageDeliveryMode` 区分行为
- **fork 模式控制**：`spawn_agent` 支持 `fork_turns` 参数精确控制历史继承策略
- **开发者指令注入**：spawned agent 自动注入 `SPAWN_AGENT_DEVELOPER_INSTRUCTIONS` 上下文提示

同级兄弟模块包括 ShellAndPatch（命令执行）、McpHandlers（MCP 工具调用）、FileAndMedia（文件浏览）、ScriptAndProcess（脚本执行）、ToolDiscovery（工具发现）、AuxiliaryHandlers（辅助工具）和 HandlerCommon（共享基础设施）。

## 模块结构

入口文件 `multi_agents_v2.rs` 是模块的组织中枢，它：
1. 通过 `use crate::tools::handlers::multi_agents_common::*` 引入所有共享工具函数
2. 声明并 re-export 六个子模块的 Handler 类型
3. 子模块 `message_tool` 不导出 Handler，而是作为 `send_message` 和 `followup_task` 的共享实现

```
multi_agents_v2.rs          ← 模块入口，re-export 所有 Handler
├── spawn.rs                ← SpawnAgentHandler
├── wait.rs                 ← WaitAgentHandler
├── close_agent.rs          ← CloseAgentHandler
├── send_message.rs         ← SendMessageHandler
├── followup_task.rs        ← FollowupTaskHandler
├── list_agents.rs          ← ListAgentsHandler
└── message_tool.rs         ← 共享消息投递逻辑（非独立 Handler）
```

> 源码位置：`codex-rs/core/src/tools/handlers/multi_agents_v2.rs:1-43`

## 关键流程

### 1. spawn_agent — 创建子智能体

这是最复杂的操作，完整流程如下：

1. **解析参数**：反序列化 `SpawnAgentArgs`，包含 `message`、`task_name`、`agent_type`（角色）、`model`、`reasoning_effort`、`fork_turns`（`codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:217-227`）

2. **确定 fork 模式**：`fork_mode()` 方法将 `fork_turns` 字符串解析为 `SpawnAgentForkMode` 枚举：
   - `"none"` 或空 → 不 fork（`None`）
   - `"all"` → `FullHistory`（继承完整对话历史）
   - 正整数 N → `LastNTurns(N)`（仅继承最近 N 轮）
   - 注意：V2 **不支持** V1 的 `fork_context` 参数，传入会直接报错（`spawn.rs:231-235`）

3. **深度限制检查**：计算子智能体深度 `child_depth`，与 `agent_max_depth` 比较，超限则返回错误提示模型自行解决任务（`spawn.rs:51-57`）

4. **构建配置**：
   - `build_agent_spawn_config()` 从父级 turn 复制基础配置（模型、审批策略、沙箱策略、cwd 等）
   - `apply_requested_spawn_agent_model_overrides()` 处理模型和推理强度的覆盖请求，验证请求的模型在可用模型列表中
   - `apply_role_to_config()` 应用角色特定的配置覆盖
   - 注入开发者指令：将 `SPAWN_AGENT_DEVELOPER_INSTRUCTIONS` 追加到现有指令之后，告知子智能体它处于协作环境中（`spawn.rs:86-96`）

5. **构造初始操作**：如果子智能体有 `AgentPath` 且初始消息全为文本，则将 `Op::UserInput` 转换为 `Op::InterAgentCommunication`，附带发送者和接收者的路径信息（`spawn.rs:110-129`）

6. **调用 `agent_control.spawn_agent_with_metadata()`**：传入配置、初始操作、spawn source 和 fork 选项

7. **返回结果**：`SpawnAgentResult` 包含 `task_name`（即 `AgentPath` 字符串）和可选的 `nickname`

> 关键代码：`codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:30-214`

### 2. wait_agent — 等待邮箱变更

wait_agent 实现了一种基于超时的邮箱轮询机制：

1. **解析超时参数**：`timeout_ms` 被 clamp 到 `[10_000, 3_600_000]` 毫秒范围内，默认 30 秒（`wait.rs:30-38`）

2. **订阅邮箱序列号**：通过 `session.subscribe_mailbox_seq()` 获取 `watch::Receiver<u64>`

3. **等待变更**：`wait_for_mailbox_change()` 使用 `tokio::time::timeout_at` 监听邮箱序列号变化。任何子智能体的消息投递都会触发序列号更新，从而唤醒等待（`wait.rs:120-128`）

4. **返回结果**：`WaitAgentResult` 包含 `timed_out` 布尔值和描述性 `message`

> 关键代码：`codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs:20-73`

### 3. close_agent — 关闭子智能体

1. **名称解析**：通过 `resolve_agent_target()` 将 `target` 字符串解析为 `ThreadId`
2. **根节点保护**：如果目标是 root agent，拒绝操作（`close_agent.rs:32-40`）
3. **获取状态**并调用 `agent_control.close_agent()`
4. **返回** `CloseAgentResult`，包含关闭前的 `previous_status`

> 关键代码：`codex-rs/core/src/tools/handlers/multi_agents_v2/close_agent.rs:16-104`

### 4. send_message 与 followup_task — 统一消息投递

这两个工具共享 `message_tool.rs` 中的 `handle_message_string_tool()` 实现，仅在投递模式上不同：

| 工具 | `MessageDeliveryMode` | `trigger_turn` | `interrupt` |
|------|----------------------|----------------|-------------|
| `send_message` | `QueueOnly` | `false` | 固定 `false` |
| `followup_task` | `TriggerTurn` | `true` | 由参数控制 |

**统一投递流程**（`message_tool.rs:100-192`）：

1. **空消息校验**：空或纯空白消息直接报错
2. **名称解析**：`resolve_agent_target()` 将 target 解析为 `ThreadId`
3. **根节点保护**：`TriggerTurn` 模式下不允许向 root agent 发送任务
4. **可选中断**：如果 `interrupt` 为 true，先调用 `agent_control.interrupt_agent()` 中断目标智能体当前工作
5. **构造 `InterAgentCommunication`**：包含发送者路径、接收者路径、消息文本
6. **应用投递模式**：`MessageDeliveryMode::apply()` 设置 `trigger_turn` 字段（`message_tool.rs:16-29`）
7. **调用 `agent_control.send_inter_agent_communication()`**
8. **返回** `MessageToolResult`，包含 `submission_id`

### 5. list_agents — 枚举智能体

1. 先调用 `agent_control.register_session_root()` 确保当前会话的根已注册
2. 调用 `agent_control.list_agents()` 按 `path_prefix` 过滤，返回匹配的智能体列表（`ListedAgent` 类型）

> 关键代码：`codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs:17-38`

## 函数签名与参数说明

### `SpawnAgentArgs`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | `String` | 是 | 分配给子智能体的初始任务描述 |
| `task_name` | `String` | 是 | 任务名称，用于构建 `AgentPath` 路径段 |
| `agent_type` | `Option<String>` | 否 | 角色名称，用于 `apply_role_to_config` 选择角色配置 |
| `model` | `Option<String>` | 否 | 覆盖子智能体使用的模型 |
| `reasoning_effort` | `Option<ReasoningEffort>` | 否 | 覆盖推理强度 |
| `fork_turns` | `Option<String>` | 否 | fork 模式：`"none"` / `"all"` / 正整数 |
| `fork_context` | `Option<bool>` | 否 | **V2 已弃用**，传入即报错 |

### `WaitArgs`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `timeout_ms` | `Option<i64>` | 否 | 等待超时，默认 30000ms，范围 [10000, 3600000] |

### `CloseAgentArgs`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | `String` | 是 | 目标智能体的名称或路径，通过 `resolve_agent_target` 解析 |

### `SendMessageArgs`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | `String` | 是 | 目标智能体标识 |
| `message` | `String` | 是 | 发送的消息内容（不可为空） |

### `FollowupTaskArgs`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target` | `String` | 是 | 目标智能体标识 |
| `message` | `String` | 是 | 任务消息内容 |
| `interrupt` | `bool` | 否 | 是否中断目标当前工作，默认 `false` |

## 接口/类型定义

### `MessageDeliveryMode`

```rust
// codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs:9-13
enum MessageDeliveryMode {
    QueueOnly,   // 仅入队，不唤醒目标（send_message 使用）
    TriggerTurn, // 入队并触发新 turn（followup_task 使用）
}
```

`apply()` 方法将模式作用于 `InterAgentCommunication`，设置其 `trigger_turn` 字段。

### `SpawnAgentResult`

```rust
// codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:268-273
struct SpawnAgentResult {
    agent_id: Option<String>,  // 当前始终为 None
    task_name: String,          // AgentPath 字符串形式
    nickname: Option<String>,   // 可选的可读昵称
}
```

### `WaitAgentResult`

```rust
// codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs:82-86
struct WaitAgentResult {
    message: String,  // "Wait completed." 或 "Wait timed out."
    timed_out: bool,
}
```

### `CloseAgentResult`

```rust
// codex-rs/core/src/tools/handlers/multi_agents_v2/close_agent.rs:113-116
struct CloseAgentResult {
    previous_status: AgentStatus,  // 关闭前的智能体状态
}
```

### `MessageToolResult`

```rust
// codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs:49-53
struct MessageToolResult {
    submission_id: String,  // 消息投递的唯一标识
}
```

### `ListAgentsResult`

```rust
// codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs:47-49
struct ListAgentsResult {
    agents: Vec<ListedAgent>,  // 匹配的智能体列表
}
```

## 配置项与默认值

以下常量定义在 `multi_agents_common.rs:28-31`：

| 常量 | 值 | 说明 |
|------|-----|------|
| `MIN_WAIT_TIMEOUT_MS` | 10,000 (10s) | 最小等待超时，防止紧密轮询 |
| `DEFAULT_WAIT_TIMEOUT_MS` | 30,000 (30s) | 默认等待超时 |
| `MAX_WAIT_TIMEOUT_MS` | 3,600,000 (1h) | 最大等待超时 |

子智能体配置继承自父级 turn，包括：
- `model` / `model_provider` — 模型选择
- `approval_policy` / `sandbox_policy` — 审批和沙箱策略
- `cwd` — 工作目录
- `agent_max_depth` — 最大嵌套深度

## 边界 Case 与注意事项

- **`fork_context` 已弃用**：V2 中传入 `fork_context` 参数会立即返回错误，提示使用 `fork_turns` 替代（`spawn.rs:231-235`）
- **深度限制**：子智能体深度达到 `agent_max_depth` 时，spawn 直接被拒绝，模型收到"Agent depth limit reached. Solve the task yourself."消息
- **根节点不可操作**：`close_agent` 和 `followup_task` 均会检测并拒绝对 root agent 的操作
- **空消息保护**：`send_message` 和 `followup_task` 均拒绝空消息
- **V2 的 `wait_agent` 无 agent 列表**：与 V1 不同，V2 的 wait 不指定等待哪些 agent，而是监听整个邮箱序列号变化，任何子智能体的消息都会唤醒等待
- **`SpawnAgentResult.agent_id` 始终为 `None`**：V2 使用 `task_name`（AgentPath）作为智能体标识，`agent_id` 字段保留但未使用
- **开发者指令拼接**：新指令追加在已有指令之后，而非替换，确保角色配置的指令不丢失（`spawn.rs:86-96`）
- **模型验证**：spawn 时请求的模型必须在 `models_manager` 的离线列表中存在，否则报错并列出可用模型
- **事件对称性**：所有六个工具都遵循 Begin/End 事件对模式，即使操作失败也会发送 End 事件以确保 TUI 状态一致