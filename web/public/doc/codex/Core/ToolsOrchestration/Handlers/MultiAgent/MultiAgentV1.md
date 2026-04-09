# MultiAgentV1 — 第一代多智能体协作工具处理器

## 概述与职责

MultiAgentV1 是 Codex 核心引擎中第一代多智能体协作的工具处理器层，位于 `Core > ToolsOrchestration > Handlers > MultiAgent` 层级中。它将模型发出的工具调用（tool call）翻译为 `AgentControl` 的实际操作，实现了五个独立的工具操作：**spawn_agent**、**wait_agent**、**close_agent**、**resume_agent** 和 **send_input**。

每个处理器均实现 `ToolHandler` trait，遵循统一的模式：解析参数 → 发送 Collab 生命周期事件（Begin/End）→ 委托 `AgentControl` 执行 → 返回结构化结果。所有智能体通过原始 `ThreadId` 进行寻址。

同级模块中还存在 V2 协议（`multi_agents_v2.rs`）和批处理 Job 处理器，但本文档聚焦于 V1 的五个核心处理器及其共享基础设施。

## 模块结构

```
multi_agents.rs              # 模块入口：公共工具函数、Handler re-export
multi_agents/
  ├── spawn.rs               # SpawnAgentHandler
  ├── wait.rs                # WaitAgentHandler
  ├── close_agent.rs         # CloseAgentHandler
  ├── resume_agent.rs        # ResumeAgentHandler
  └── send_input.rs          # SendInputHandler
multi_agents_common.rs       # 五个 handler 共享的常量、配置构建、错误处理、输入解析
multi_agents_tests.rs        # 集成测试
```

## 关键流程

### 1. spawn_agent — 创建子智能体

**入口**：`multi_agents/spawn.rs` Handler

**参数**（`SpawnAgentArgs`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `message` | `Option<String>` | 发送给新智能体的文本消息（与 `items` 二选一） |
| `items` | `Option<Vec<UserInput>>` | 结构化输入项（与 `message` 二选一） |
| `agent_type` | `Option<String>` | 角色名称，映射到 AGENTS.md 中定义的角色配置 |
| `model` | `Option<String>` | 指定子智能体使用的模型 |
| `reasoning_effort` | `Option<ReasoningEffort>` | 推理力度设置 |
| `fork_context` | `bool` | 是否 fork 父级的完整对话历史（默认 false） |

**核心流程**：

1. 解析参数，通过 `parse_collab_input()` 将 `message` 或 `items` 转换为 `Op`
2. 计算子智能体深度 `child_depth = next_thread_spawn_depth(&session_source)`
3. **深度限制检查**：若 `exceeds_thread_spawn_depth_limit(child_depth, max_depth)` 为 true，直接返回错误要求模型自行解决（`multi_agents/spawn.rs:44-48`）
4. 发送 `CollabAgentSpawnBeginEvent` 通知上层
5. 构建子智能体配置：
   - `build_agent_spawn_config()` 从父级 turn 的有效配置出发（`multi_agents_common.rs:203-209`）
   - `apply_requested_spawn_agent_model_overrides()` 处理模型和推理力度选择，校验请求的模型是否在可用列表中（`multi_agents_common.rs:274-323`）
   - `apply_role_to_config()` 叠加角色特定配置
   - `apply_spawn_agent_runtime_overrides()` 同步运行时状态（审批策略、沙盒、cwd 等）
   - `apply_spawn_agent_overrides()` 在达到深度限制时禁用 `SpawnCsv` 和 `Collab` feature
6. 调用 `agent_control.spawn_agent_with_metadata()` 实际创建智能体，传入 fork 选项（`SpawnAgentForkMode::FullHistory`）
7. 获取新智能体的配置快照以提取有效模型、昵称、角色等元数据
8. 发送 `CollabAgentSpawnEndEvent`，记录遥测计数
9. 返回 `SpawnAgentResult { agent_id, nickname }`

### 2. wait_agent — 等待智能体完成

**入口**：`multi_agents/wait.rs` Handler

**参数**（`WaitArgs`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `targets` | `Vec<String>` | 要等待的智能体 ID 列表 |
| `timeout_ms` | `Option<i64>` | 超时毫秒数 |

**超时机制**（定义于 `multi_agents_common.rs:29-31`）：

- 最小值：`MIN_WAIT_TIMEOUT_MS = 10_000`（10 秒）
- 默认值：`DEFAULT_WAIT_TIMEOUT_MS = 30_000`（30 秒）
- 最大值：`MAX_WAIT_TIMEOUT_MS = 3_600_000`（1 小时）
- 非正值直接报错，其余通过 `clamp` 约束到合法范围

**核心流程**：

1. 解析并验证多个目标 `ThreadId`（不允许空列表）
2. 为每个目标获取元数据，构建 `CollabAgentRef` 列表
3. 发送 `CollabWaitingBeginEvent`
4. 通过 `agent_control.subscribe_status()` 为每个智能体订阅状态变更通道
5. **快速路径**：如果有智能体已经处于终态（`is_final(&status)` 为 true），直接收集这些结果
6. **等待路径**：使用 `FuturesUnordered` 并发轮询所有智能体的 `watch::Receiver`（`wait.rs:125-151`）
   - 通过 `timeout_at(deadline, futures.next())` 设置超时截止时间
   - 一旦有任意一个智能体完成，立即用 `now_or_never()` 非阻塞收割其余已完成的结果
   - 超时后 `statuses.is_empty()` 则标记 `timed_out = true`
7. 发送 `CollabWaitingEndEvent`
8. 返回 `WaitAgentResult { status: HashMap<target_path, AgentStatus>, timed_out }`

`wait_for_final_status()` 辅助函数（`wait.rs:218-238`）循环等待单个智能体的状态通道，直到出现终态或通道关闭。

### 3. close_agent — 终止智能体

**入口**：`multi_agents/close_agent.rs` Handler

**参数**：`CloseAgentArgs { target: String }`

**核心流程**：

1. 解析目标 `ThreadId`，获取智能体元数据
2. 发送 `CollabCloseBeginEvent`
3. 通过 `subscribe_status()` 获取当前状态快照（作为 `previous_status` 返回）
4. 调用 `agent_control.close_agent(agent_id)` 执行关闭
5. 发送 `CollabCloseEndEvent`（包含关闭前的状态）
6. 返回 `CloseAgentResult { previous_status }`

### 4. resume_agent — 恢复已关闭的智能体

**入口**：`multi_agents/resume_agent.rs` Handler

**参数**：`ResumeAgentArgs { id: String }`

**核心流程**：

1. 解析目标 `ThreadId`，执行深度限制检查
2. 发送 `CollabResumeBeginEvent`
3. 获取当前状态——如果是 `AgentStatus::NotFound`，调用 `try_resume_closed_agent()` 尝试从 rollout 恢复：
   - 构建恢复配置 `build_agent_resume_config()`（与 spawn 不同，`base_instructions` 设为 None，从 rollout/session 元数据中获取）
   - 调用 `agent_control.resume_agent_from_rollout()`（`resume_agent.rs:145-169`）
4. 发送 `CollabResumeEndEvent`
5. 记录遥测 `codex.multi_agent.resume`
6. 返回 `ResumeAgentResult { status }`

### 5. send_input — 向运行中的智能体发送输入

**入口**：`multi_agents/send_input.rs` Handler

**参数**（`SendInputArgs`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `target` | `String` | 目标智能体 ID |
| `message` | `Option<String>` | 文本消息（与 `items` 二选一） |
| `items` | `Option<Vec<UserInput>>` | 结构化输入项 |
| `interrupt` | `bool` | 是否先中断智能体当前执行（默认 false） |

**核心流程**：

1. 解析目标 `ThreadId`，通过 `parse_collab_input()` 构建输入
2. 如果 `interrupt = true`，先调用 `agent_control.interrupt_agent()` 中断当前执行（`send_input.rs:35-42`）
3. 发送 `CollabAgentInteractionBeginEvent`
4. 调用 `agent_control.send_input()` 投递输入
5. 发送 `CollabAgentInteractionEndEvent`（包含当前状态）
6. 返回 `SendInputResult { submission_id }`

## 共享基础设施（multi_agents_common.rs）

### 输入解析

`parse_collab_input(message, items)` 强制 `message` 和 `items` **二选一**，且不允许空值（`multi_agents_common.rs:162-194`）：
- 两者都提供 → 报错
- 两者都为 None → 报错
- 空字符串 message → 报错
- 空 items 列表 → 报错

### 配置构建

配置构建分为三层：

1. **`build_agent_shared_config(turn)`**：从父级 turn 的 config 克隆，覆盖模型、推理力度、开发者指令等运行时字段（`multi_agents_common.rs:223-235`）
2. **`apply_spawn_agent_runtime_overrides(config, turn)`**：同步审批策略、Shell 环境策略、沙盒策略、文件系统沙盒、网络沙盒、cwd 等运行时状态（`multi_agents_common.rs:241-265`）
3. **`apply_spawn_agent_overrides(config, child_depth)`**：当子智能体达到深度上限且不在 V2 模式下时，禁用 `SpawnCsv` 和 `Collab` feature 以阻止进一步 spawn（`multi_agents_common.rs:267-272`）

Spawn 与 Resume 的区别在于：spawn 会设置 `base_instructions`，而 resume 将其置为 None（从 rollout 中恢复）。

### 模型选择与校验

`apply_requested_spawn_agent_model_overrides()` 在模型被指定时：
- 从 `models_manager` 离线列表中精确匹配模型名
- 不存在则返回详细错误（列出所有可用模型）
- 校验 `reasoning_effort` 是否在目标模型支持的 preset 列表中（`multi_agents_common.rs:345-365`）

### 错误处理

两个错误转换函数将 `CodexErr` 映射为 `FunctionCallError::RespondToModel`：

- `collab_spawn_error`：处理 spawn 特有的错误（如 thread manager 已销毁）
- `collab_agent_error`：处理通用的智能体操作错误（ThreadNotFound、InternalAgentDied、UnsupportedOperation）

### ThreadId 解析

`parse_agent_id_target()` 和 `parse_agent_id_targets()` 提供单个/批量 ThreadId 字符串解析，批量版本不允许空列表。

### 状态汇总

`build_wait_agent_statuses()` 将状态 HashMap 与 `CollabAgentRef` 列表合并为带有昵称和角色信息的 `CollabAgentStatusEntry` 列表，确保已知智能体优先排列，未知的按 ID 字典序排序（`multi_agents_common.rs:74-109`）。

## 接口/类型定义

### Handler 结果类型

| 类型 | 字段 | 说明 |
|------|------|------|
| `SpawnAgentResult` | `agent_id: String`, `nickname: Option<String>` | 新智能体的 ID 和昵称 |
| `WaitAgentResult` | `status: HashMap<String, AgentStatus>`, `timed_out: bool` | 各目标的终态，以及是否超时 |
| `CloseAgentResult` | `previous_status: AgentStatus` | 关闭前的状态 |
| `ResumeAgentResult` | `status: AgentStatus` | 恢复后的当前状态 |
| `SendInputResult` | `submission_id: String` | 投递的提交 ID |

所有结果类型均实现 `ToolOutput` trait，提供三种输出格式：
- `log_preview()` → 用于日志的 JSON 文本
- `to_response_item()` → 转换为 `ResponseInputItem` 回传给模型
- `code_mode_result()` → Code Mode 下的 JSON Value

### Collab 生命周期事件

每个操作都有对应的 Begin/End 事件对：

| 操作 | Begin 事件 | End 事件 |
|------|-----------|---------|
| spawn | `CollabAgentSpawnBeginEvent` | `CollabAgentSpawnEndEvent` |
| wait | `CollabWaitingBeginEvent` | `CollabWaitingEndEvent` |
| close | `CollabCloseBeginEvent` | `CollabCloseEndEvent` |
| resume | `CollabResumeBeginEvent` | `CollabResumeEndEvent` |
| send_input | `CollabAgentInteractionBeginEvent` | `CollabAgentInteractionEndEvent` |

## 边界 Case 与注意事项

- **深度限制**：`spawn_agent` 和 `resume_agent` 均检查 `exceeds_thread_spawn_depth_limit`。达到限制时返回 `"Agent depth limit reached. Solve the task yourself."` 错误消息，迫使模型自行处理任务
- **V1 深度溢出行为**：当 `child_depth >= agent_max_depth` 且未启用 `MultiAgentV2` feature 时，`apply_spawn_agent_overrides` 会禁用 `SpawnCsv` 和 `Collab` feature，从根本上阻止子智能体再次 spawn
- **wait 超时语义**：wait 是 **any-of** 语义——只要有一个智能体达到终态就返回，同时非阻塞地收割其余已完成的结果。不是 all-of
- **wait 超时后的 timed_out 标记**：超时后 `statuses` 为空，此时 `timed_out = true`；但即使部分智能体完成、部分超时，只要有至少一个完成，`timed_out` 就为 false
- **close 返回的是关闭前的状态**：调用 `close_agent` 后返回的 `previous_status` 是执行关闭操作**之前**的快照，而非关闭后的状态
- **resume 的 base_instructions 处理**：resume 不从父级继承 base_instructions，而是保留 rollout/session 中记录的原始指令，确保恢复的智能体行为与之前一致
- **send_input 的 interrupt 语义**：interrupt 在发送新输入**之前**执行，先中断当前执行再投递新消息