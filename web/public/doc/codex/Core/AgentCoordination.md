# 多 Agent 协调系统（AgentCoordination）

## 概述与职责

AgentCoordination 是 Codex Core 引擎中负责**多 Agent 生命周期管理和通信**的子系统。它使 Codex 能够从一个根对话线程中，按需派生出多个并发子 Agent（sub-agent），每个子 Agent 拥有独立的会话线程、角色配置和执行上下文。

在 Core 的整体架构中，AgentCoordination 位于 Core 内部，与 ToolSystem（工具框架）、ModelProviders（模型提供者）等平级子系统协作：当模型在对话中发出"派生 Agent"的工具调用时，ToolSystem 会调用 AgentCoordination 来创建新的 Agent 线程，并在 Agent 完成后将结果通知给父线程。

该子系统由以下核心组件构成：

| 组件 | 文件 | 职责 |
|------|------|------|
| **AgentControl** | `agent/control.rs` | 多 Agent 操作的控制平面：spawn、shutdown、消息发送、状态查询 |
| **Mailbox** | `agent/mailbox.rs` | Agent 间异步消息传递的信箱系统 |
| **AgentRegistry** | `agent/registry.rs` | Agent 注册表与并发数限制 |
| **Role** | `agent/role.rs` | Agent 角色定义、解析与配置层叠加 |
| **AgentResolver** | `agent/agent_resolver.rs` | 工具调用中 Agent 引用的解析 |
| **Status** | `agent/status.rs` | Agent 状态从事件流中的提取与终态判断 |
| **spawn.rs** | `spawn.rs` | 底层子进程 spawn 工具（用于 shell 工具调用，非 Agent 线程本身） |
| **external_agent_config.rs** | `external_agent_config.rs` | 外部 Agent 配置（如 Claude Code 的 `settings.json`）迁移到 Codex 格式 |

## 关键流程

### 1. Agent 派生（Spawn）流程

这是整个子系统最核心的流程。当模型请求派生一个新 Agent 时，调用链如下：

1. **预留 Spawn 槽位**：`AgentRegistry::reserve_spawn_slot()` 使用 CAS 原子操作检查当前活跃 Agent 数是否超出 `agent_max_threads` 上限。超限时返回 `AgentLimitReached` 错误（`agent/registry.rs:80-97`）

2. **继承上下文**：从父线程获取 shell 环境快照和执行策略，确保子 Agent 继承父 Agent 的运行时环境（`agent/control.rs:966-1004`）

3. **准备 ThreadSpawn 元数据**：`prepare_thread_spawn()` 负责：
   - 注册根线程（若 depth=1）
   - 预留 Agent 路径（`AgentPath`）以防重复
   - 从候选名列表中随机分配一个昵称（nickname），用于人类友好的标识
   - 构建 `SessionSource::SubAgent(SubAgentSource::ThreadSpawn { ... })` 元数据
   （`agent/control.rs:920-958`）

4. **创建线程**：调用 `ThreadManagerState` 的 `spawn_new_thread_with_source()` 或 `fork_thread_with_source()`（fork 模式下会复制父线程的 rollout 历史）

5. **注册并提交**：`reservation.commit(agent_metadata)` 将元数据写入 AgentRegistry，释放预留锁（`agent/registry.rs:323-328`）

6. **发送初始输入**：通过 `send_input()` 向新线程提交初始 prompt

7. **启动完成观察者**：`maybe_start_completion_watcher()` 在一个后台 tokio task 中通过 `watch::Receiver` 订阅子 Agent 的状态变化，当子 Agent 进入终态时自动向父线程注入完成通知（`agent/control.rs:845-918`）

### 2. Fork 模式派生

当 `SpawnAgentOptions::fork_mode` 被设置时，子 Agent 不从空白状态开始，而是继承父线程的对话历史：

1. 确保父线程的 rollout 已物化并 flush 到磁盘
2. 读取父线程的 rollout 历史
3. 根据 `SpawnAgentForkMode::LastNTurns(n)` 可选择只保留最近 N 轮
4. 通过 `keep_forked_rollout_item()` 过滤掉工具调用等中间项，只保留系统/用户/开发者消息和 assistant 的最终回答（`agent/control.rs:95-123`）
5. 以 `InitialHistory::Forked(...)` 方式创建新线程

### 3. Agent 间消息传递（Mailbox）

`Mailbox` 实现了一个基于 tokio `mpsc::UnboundedChannel` 的异步消息队列：

- **发送端（`Mailbox`）**：每次 `send()` 分配单调递增的序列号，并通过 `watch::Sender` 广播序列号变化，允许多个订阅者感知新消息到来（`agent/mailbox.rs:43-48`）
- **接收端（`MailboxReceiver`）**：维护一个 `VecDeque<InterAgentCommunication>` 作为 pending 缓冲区。`has_pending_trigger_turn()` 可检查是否有需要立即触发新回合的消息（`agent/mailbox.rs:63-66`）
- **消息结构**：`InterAgentCommunication` 包含 `author`（发送方 AgentPath）、`recipient`（接收方 AgentPath）、`content`（文本内容）和 `trigger_turn`（是否触发新回合）

### 4. Agent 关闭与树形清理

`close_agent()` 不仅关闭目标 Agent，还会递归关闭其所有活跃后代：

1. 在持久化存储中将 spawn edge 标记为 `Closed`
2. 调用 `shutdown_agent_tree()` 通过 DFS 遍历收集所有后代 thread ID
3. 逐一调用 `shutdown_live_agent()`：flush rollout → 发送 `Op::Shutdown` → 从 `ThreadManagerState` 移除 → 从 `AgentRegistry` 释放
（`agent/control.rs:636-662`）

### 5. Agent 恢复（Resume）

`resume_agent_from_rollout()` 支持从持久化的 rollout 文件恢复整棵 Agent 树：

1. 恢复根 Agent 线程
2. 通过 `state_db` 查询该线程的所有 `Open` 状态的子 spawn edge
3. BFS 遍历，对每个子线程递归调用 `resume_single_agent_from_rollout()`
4. 超出深度限制的 Agent 会被禁用 `SpawnCsv` 和 `Collab` 功能
（`agent/control.rs:361-432`）

## 函数签名与参数说明

### `AgentControl`

#### `spawn_agent(config, initial_operation, session_source) -> CodexResult<ThreadId>`

创建新 Agent 线程并发送初始 prompt。返回新线程的 ID。

#### `spawn_agent_with_metadata(config, initial_operation, session_source, options) -> CodexResult<LiveAgent>`

同上，但返回包含元数据和初始状态的 `LiveAgent` 结构。`options` 支持 fork 模式。

#### `send_input(agent_id, initial_operation) -> CodexResult<String>`

向已有 Agent 线程发送用户输入操作。

#### `send_inter_agent_communication(agent_id, communication) -> CodexResult<String>`

向目标 Agent 发送 Agent 间通信消息。

#### `interrupt_agent(agent_id) -> CodexResult<String>`

中断指定 Agent 当前正在执行的任务。

#### `close_agent(agent_id) -> CodexResult<String>`

关闭 Agent 及其所有后代，同时持久化关闭状态。

#### `shutdown_live_agent(agent_id) -> CodexResult<String>`

关闭单个 Agent，不修改持久化的 spawn-edge 状态。

#### `get_status(agent_id) -> AgentStatus`

查询 Agent 的最新状态，不可用时返回 `AgentStatus::NotFound`。

#### `subscribe_status(agent_id) -> CodexResult<watch::Receiver<AgentStatus>>`

订阅 Agent 状态变化的响应式流。

#### `list_agents(current_session_source, path_prefix) -> CodexResult<Vec<ListedAgent>>`

列出所有活跃 Agent，可按路径前缀过滤。

#### `resolve_agent_reference(current_thread_id, current_session_source, agent_reference) -> CodexResult<ThreadId>`

将相对 Agent 引用（如 `"worker"` 或 `"../explorer"`）解析为线程 ID。基于当前 Agent 的路径进行相对路径解析。

## 接口/类型定义

### `AgentStatus`（re-exported from `codex_protocol`）

Agent 的生命周期状态枚举：
- `PendingInit` — 已创建，未开始
- `Running` — 正在执行
- `Completed(String)` — 已完成，附带最后的 agent 消息
- `Interrupted` — 被用户中断
- `Errored(String)` — 发生错误
- `Shutdown` — 已关闭
- `NotFound` — 不存在

> `agent_status_from_event()` 从事件流中派生状态（`agent/status.rs:6-19`），`is_final()` 判断是否为终态——`PendingInit`、`Running`、`Interrupted` 不是终态（`agent/status.rs:22-27`）。

### `AgentMetadata`

```rust
pub(crate) struct AgentMetadata {
    pub agent_id: Option<ThreadId>,
    pub agent_path: Option<AgentPath>,
    pub agent_nickname: Option<String>,
    pub agent_role: Option<String>,
    pub last_task_message: Option<String>,
}
```

存储每个 Agent 的标识、路径、昵称、角色和最近一条任务消息。

### `LiveAgent`

```rust
pub(crate) struct LiveAgent {
    pub thread_id: ThreadId,
    pub metadata: AgentMetadata,
    pub status: AgentStatus,
}
```

Spawn 返回的活跃 Agent 快照。

### `SpawnAgentForkMode`

```rust
pub(crate) enum SpawnAgentForkMode {
    FullHistory,
    LastNTurns(usize),
}
```

控制 fork 时继承多少对话历史。

### `SpawnReservation`

Agent 派生的 RAII 预留令牌（`agent/registry.rs:294-340`）。在 `commit()` 之前如果被 drop，会自动：
- 释放预留的 `AgentPath`
- 递减 `total_count` 计数器

这确保了即使 spawn 过程中出错，也不会泄漏计数器资源。

## 角色系统（Role System）

角色系统允许不同的 Agent 拥有不同的行为配置。核心入口是 `apply_role_to_config()`（`agent/role.rs:38-54`）。

### 内置角色

| 角色名 | 描述 | 配置文件 |
|--------|------|----------|
| `default` | 默认 Agent，无额外配置层 | 无 |
| `explorer` | 快速只读代码探索，适用于具体的代码库问题 | `builtins/explorer.toml` |
| `worker` | 执行型 Agent，用于实现功能、修复 bug、拆分重构 | 无（使用默认配置） |

> `awaiter` 角色（等待长时间命令完成）目前已被临时移除。

### 角色配置叠加

`apply_role_to_config_inner()` 的工作原理：

1. 解析角色的 `config_file`（内置角色从 `include_str!` 加载，用户定义角色从文件系统读取）
2. 将角色配置作为高优先级层（`SessionFlags` 级别）插入配置栈
3. **保留调用方的 profile 和 model_provider** 选择——除非角色自身显式设置了这些值（`agent/role.rs:122-141`）

这避免了一个微妙的 bug：不做此保留的话，子 Agent 会静默回退到默认 provider。

### 昵称系统

每个 Agent 被分配一个人类可读的昵称（从 `agent_names.txt` 文件中随机选取）。当所有名字用完时，`nickname_reset_count` 递增，后续昵称会带上序号后缀（如 `"Atlas the 2nd"`）。昵称分配逻辑见 `AgentRegistry::reserve_agent_nickname()`（`agent/registry.rs:202-240`）。

## 深度限制（Spawn Depth Limiting）

为防止 Agent 无限递归派生，系统实施了深度限制：

- `next_thread_spawn_depth()` 计算下一级 spawn 的深度值（`agent/registry.rs:71-73`）
- `exceeds_thread_spawn_depth_limit(depth, max_depth)` 检查是否超限（`agent/registry.rs:75-77`）
- 超限时，`resume_single_agent_from_rollout()` 会禁用 `SpawnCsv` 和 `Collab` 功能，从而阻止进一步派生（`agent/control.rs:440-445`）

## 并发数限制

`AgentRegistry` 使用 `AtomicUsize` 维护全局 Agent 计数器。`try_increment_spawned()` 通过 CAS 循环实现无锁的并发数检查：

```rust
// agent/registry.rs:275-291
fn try_increment_spawned(&self, max_threads: usize) -> bool {
    let mut current = self.total_count.load(Ordering::Acquire);
    loop {
        if current >= max_threads {
            return false;
        }
        match self.total_count.compare_exchange_weak(...) {
            Ok(_) => return true,
            Err(updated) => current = updated,
        }
    }
}
```

根线程不计入 `total_count`（释放时会检查 `!is_root`），这确保了限制仅作用于子 Agent。

## Agent 引用解析

`agent_resolver.rs` 提供了从工具调用参数解析 Agent 目标的能力：

1. 首先尝试将 `target` 解析为 `ThreadId`（直接 ID 引用）
2. 否则调用 `AgentControl::resolve_agent_reference()`，基于当前 Agent 的 `AgentPath` 进行相对路径解析
3. 在 AgentRegistry 中查找该路径对应的线程 ID

> 源码位置：`agent/agent_resolver.rs:8-29`

## 外部配置迁移（ExternalAgentConfig）

`ExternalAgentConfigService` 负责从 Claude Code 的配置格式迁移到 Codex 格式，包括：

- **配置迁移**：`.claude/settings.json` → `.codex/config.toml`（环境变量、sandbox 设置）
- **Skills 迁移**：`.claude/skills/` → `.agents/skills/`（递归复制目录，重写文本中的 "claude" 引用为 "Codex"）
- **AGENTS.md 迁移**：`CLAUDE.md` → `AGENTS.md`

迁移采用增量合并策略——`merge_missing_toml_values()` 只添加目标中不存在的配置项，不覆盖已有值（`external_agent_config.rs:606-633`）。

## 子进程 Spawn（spawn.rs）

`spawn.rs` 提供底层的子进程创建能力，用于 shell 工具调用（而非 Agent 线程本身）：

- `SpawnChildRequest` 封装了 program、args、cwd、网络沙盒策略、环境变量等
- `spawn_child_async()` 创建 tokio `Child` 进程，关键行为包括：
  - 清空继承环境变量（`cmd.env_clear()`），只设置显式指定的环境
  - 网络沙盒禁用时设置 `CODEX_SANDBOX_NETWORK_DISABLED=1`
  - Linux 上通过 `prctl` 设置父进程死亡信号，确保 Codex 进程被 kill 后子进程也会收到 SIGTERM
  - `kill_on_drop(true)` 确保 `Child` 句柄被 drop 时终止子进程
  - `StdioPolicy::RedirectForShellTool` 将 stdin 设为 null（避免命令阻塞等待输入），stdout/stderr 设为 piped

> 源码位置：`spawn.rs:50-125`

## 边界 Case 与注意事项

- **AgentControl 使用 `Weak` 引用**指向 `ThreadManagerState`，避免引用循环导致内存泄漏。每次操作前需 `upgrade()`，失败时返回错误（`agent/control.rs:960-964`）
- **SpawnReservation 的 RAII 设计**确保 spawn 失败时自动清理计数器和预留路径，无需手动 rollback
- **完成通知的双模式**：支持 MultiAgentV2 协议时通过 `InterAgentCommunication` 发送完成通知；否则通过 `inject_user_message_without_turn()` 向父线程静默注入
- **昵称池耗尽**时会 reset 并增加后缀序号，同时通过 metrics 上报 `codex.multi_agent.nickname_pool_reset` 计数器
- **fork 时的 rollout flush**：fork 前必须等待父线程的 rollout 物化完成，否则可能读到不完整的历史