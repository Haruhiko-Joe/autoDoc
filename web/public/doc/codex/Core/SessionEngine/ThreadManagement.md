# 线程管理（ThreadManagement）

## 概述与职责

线程管理模块是 Codex 会话引擎（SessionEngine）的核心子系统，负责**多线程对话的全生命周期管理**。它由两个文件组成：

- **`ThreadManager`**（`thread_manager.rs`）：线程编排器，负责创建、分叉（fork）、恢复（resume）对话线程，管理所有活跃线程的注册表，并提供线程创建事件的广播通道。
- **`CodexThread`**（`codex_thread.rs`）：单个线程的公开双向通信管道，封装底层 `Codex` 实例，对外暴露 Op（操作）提交和 Event（事件）接收接口。

在整体架构中，该模块属于 **Core > SessionEngine** 层级。`ThreadManager` 被上层消费者（TUI、AppServer、CLI）用来创建和管理对话线程，每个线程内部持有独立的 `Codex` 会话实例。同级模块包括 ContextManagement（上下文窗口管理）、AgentCoordination（多 Agent 协调）等。

## 关键流程

### 1. 创建新线程（start_thread）

新线程的创建流程经过以下步骤：

1. 调用方通过 `ThreadManager::start_thread(config)` 发起请求
2. 内部层层委托，最终到达核心方法 `ThreadManagerState::spawn_thread_with_source()`（`thread_manager.rs:829-874`）
3. 通过 `SkillsWatcher::register_config()` 注册技能文件监听
4. 构造 `CodexSpawnArgs` 并调用 `Codex::spawn()` 创建底层会话实例
5. 在 `finalize_thread_spawn()`（`thread_manager.rs:876-906`）中：
   - 等待首个事件，必须是 `SessionConfigured`，否则报错
   - 用返回的 `Codex` 实例包装为 `CodexThread`
   - 将线程注册到 `threads` HashMap 中
   - 返回 `NewThread`（包含 thread_id、线程引用、session_configured 事件）

```rust
// thread_manager.rs:849-871 — spawn_thread_with_source 核心路径
let CodexSpawnOk { codex, thread_id, .. } = Codex::spawn(CodexSpawnArgs {
    config,
    auth_manager,
    models_manager: Arc::clone(&self.models_manager),
    // ... 其他共享管理器
    conversation_history: initial_history,
    session_source,
    agent_control,
    // ...
}).await?;
self.finalize_thread_spawn(codex, thread_id, watch_registration).await
```

### 2. 分叉线程（fork_thread）

分叉允许从已有线程的 rollout 历史中派生新线程，支持两种快照模式（`ForkSnapshot` 枚举，`thread_manager.rs:148-167`）：

**TruncateBeforeNthUserMessage(n)**：截断第 n 条用户消息之前的历史。如果 n 超出范围且源线程正在执行中（mid-turn），则回退到截断活跃 turn 的起始位置。

**Interrupted**：保留完整持久化历史，若源线程正在 mid-turn，则追加中断边界标记（`<turn_aborted>` 事件）。

分叉流程（`thread_manager.rs:596-639`）：

1. 从 rollout 文件读取历史：`RolloutRecorder::get_rollout_history()`
2. 分析 turn 状态：`snapshot_turn_state()` 判断历史是否以 mid-turn 结尾
3. 根据 `ForkSnapshot` 模式裁剪历史
4. 以裁剪后的历史调用 `spawn_thread()` 创建新线程

### 3. 恢复线程（resume_thread）

恢复线程从已有的 rollout 文件重建对话状态（`thread_manager.rs:453-469`）：

1. 调用 `RolloutRecorder::get_rollout_history()` 读取 rollout 文件中的完整历史
2. 将历史作为 `InitialHistory::Resumed` 传入 `spawn_thread()`
3. 后续流程与新建线程一致

### 4. CodexThread 双向通信

`CodexThread` 作为线程的公开 API 接口，提供以下核心操作：

- **提交操作**：`submit(op)` / `submit_with_trace(op, trace)` — 将 `Op` 发送给底层 `Codex` 会话
- **接收事件**：`next_event()` — 异步等待下一个 `Event`
- **关闭线程**：`shutdown_and_wait()` — 请求关闭并等待完成
- **状态查询**：`agent_status()` — 获取当前 Agent 状态；`config_snapshot()` — 获取线程配置快照

## 函数签名与参数说明

### ThreadManager 主要公开方法

#### `start_thread(config: Config) -> CodexResult<NewThread>`
创建全新线程。最简单的入口，内部委托到 `start_thread_with_tools()`。

#### `start_thread_with_tools(config, dynamic_tools, persist_extended_history) -> CodexResult<NewThread>`
创建线程并注册动态工具。`dynamic_tools` 为额外注入的工具定义列表。

#### `start_thread_with_tools_and_service_name(config, dynamic_tools, persist_extended_history, metrics_service_name, parent_trace) -> CodexResult<NewThread>`
最完整的线程创建入口，支持指定 metrics 服务名和 W3C 分布式追踪上下文。

#### `fork_thread<S: Into<ForkSnapshot>>(snapshot, config, path, persist_extended_history, parent_trace) -> CodexResult<NewThread>`
从 rollout 文件分叉线程。`path` 为源线程的 rollout 文件路径。

#### `resume_thread_from_rollout(config, rollout_path, auth_manager, parent_trace) -> CodexResult<NewThread>`
从 rollout 文件恢复线程。

#### `shutdown_all_threads_bounded(timeout: Duration) -> ThreadShutdownReport`
并发关闭所有线程，超时后返回关闭报告。报告中区分三类线程：`completed`（成功关闭）、`submit_failed`（提交关闭请求失败）、`timed_out`（超时未完成）。

#### `subscribe_thread_created() -> broadcast::Receiver<ThreadId>`
订阅线程创建事件的广播通道。

#### `remove_thread(thread_id) -> Option<Arc<CodexThread>>`
从内部注册表移除指定线程。

### CodexThread 主要公开方法

#### `submit(op: Op) -> CodexResult<String>`
提交操作到底层会话，返回提交 ID。

#### `next_event() -> CodexResult<Event>`
异步等待并返回下一个事件。

#### `shutdown_and_wait() -> CodexResult<()>`
发起关闭请求并等待会话完全停止。

#### `steer_input(input: Vec<UserInput>, expected_turn_id: Option<&str>) -> Result<String, SteerInputError>`
在当前 turn 中注入用户输入（"转向"操作）。

#### `config_snapshot() -> ThreadConfigSnapshot`
获取当前线程配置的快照。

#### `increment_out_of_band_elicitation_count() / decrement_out_of_band_elicitation_count() -> CodexResult<u64>`
管理带外引导（out-of-band elicitation）的引用计数。计数从 0 变为正数时暂停会话处理，回到 0 时恢复。

## 接口/类型定义

### `ThreadConfigSnapshot`（`codex_thread.rs:32-44`）

线程配置的不可变快照，包含创建线程时的关键配置项：

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | `String` | 使用的模型名称 |
| `model_provider_id` | `String` | 模型提供者 ID |
| `service_tier` | `Option<ServiceTier>` | 服务层级 |
| `approval_policy` | `AskForApproval` | 工具调用审批策略 |
| `approvals_reviewer` | `ApprovalsReviewer` | 审批审查者配置 |
| `sandbox_policy` | `SandboxPolicy` | 沙箱策略 |
| `cwd` | `PathBuf` | 工作目录 |
| `ephemeral` | `bool` | 是否为临时会话 |
| `reasoning_effort` | `Option<ReasoningEffort>` | 推理力度 |
| `personality` | `Option<Personality>` | 人格设置 |
| `session_source` | `SessionSource` | 会话来源 |

### `NewThread`（`thread_manager.rs:132-136`）

新创建线程的返回值：

| 字段 | 类型 | 说明 |
|------|------|------|
| `thread_id` | `ThreadId` | 线程唯一标识 |
| `thread` | `Arc<CodexThread>` | 线程引用 |
| `session_configured` | `SessionConfiguredEvent` | 首个会话配置事件 |

### `ForkSnapshot`（`thread_manager.rs:148-167`）

分叉快照模式枚举：

- `TruncateBeforeNthUserMessage(usize)` — 截断到第 n 条用户消息之前
- `Interrupted` — 以中断方式截取当前持久化历史

实现了 `From<usize>` 以兼容旧版 `fork_thread(usize, ...)` 调用。

### `ThreadShutdownReport`（`thread_manager.rs:177-182`）

批量关闭线程的结果报告，包含三个 `Vec<ThreadId>` 字段：`completed`、`submit_failed`、`timed_out`。

## 配置项与默认值

- **`THREAD_CREATED_CHANNEL_CAPACITY`**（`thread_manager.rs:60`）：线程创建广播通道容量，固定为 `1024`
- **`FORCE_TEST_THREAD_MANAGER_BEHAVIOR`**：全局原子布尔值，仅测试时启用，生产环境始终为 `false`。启用后会使用 noop SkillsWatcher（避免后台任务耗尽单线程测试运行时）并开启 ops 日志捕获

## 内部架构

### ThreadManagerState

`ThreadManager` 的实际状态封装在 `ThreadManagerState` 中，通过 `Arc` 共享（`thread_manager.rs:200-213`）。这使得 `AgentControl` 可以持有 `Weak` 引用而不造成循环引用。

状态包含：
- `threads: Arc<RwLock<HashMap<ThreadId, Arc<CodexThread>>>>` — 活跃线程注册表
- `thread_created_tx: broadcast::Sender<ThreadId>` — 线程创建事件广播发送端
- 多个共享管理器引用：`auth_manager`、`models_manager`、`environment_manager`、`skills_manager`、`plugins_manager`、`mcp_manager`、`skills_watcher`

### SkillsWatcher 集成

`build_skills_watcher()`（`thread_manager.rs:89-128`）构建技能文件监听器：

1. 创建 `FileWatcher` 和 `SkillsWatcher`
2. 订阅 `SkillsChanged` 事件
3. 在后台 Tokio 任务中监听变更，触发 `skills_manager.clear_cache()`

测试模式下使用 `SkillsWatcher::noop()` 避免后台任务干扰。

### Out-of-Band Elicitation 机制

`CodexThread` 维护一个 `Mutex<u64>` 计数器（`codex_thread.rs:49`），用于管理带外引导请求。当计数从 0 递增时，调用 `set_out_of_band_elicitation_pause_state(true)` 暂停会话处理；计数归零时恢复。这确保外部引导请求（如用户审批对话框）期间会话不会继续推进。

## 边界 Case 与注意事项

- **首个事件必须是 `SessionConfigured`**：`finalize_thread_spawn()` 会校验 `Codex::spawn()` 后的首个事件，若不是 `SessionConfigured` 则返回 `CodexErr::SessionConfiguredNotFirstEvent` 错误
- **分叉的 mid-turn 处理**：当源线程处于执行中（mid-turn）时，`TruncateBeforeNthUserMessage` 模式下如果 n 超出范围，会自动回退到截断活跃 turn 起始位置，而非保留不完整的 turn 数据
- **`Interrupted` 分叉边界注入**：mid-turn 的中断分叉会追加 `TurnAborted(Interrupted)` 事件和 `interrupted_turn_history_marker()`，与真实中断产生的 rollout 记录保持一致
- **线程移除不保证销毁**：`remove_thread()` 仅从内部 HashMap 移除，由于使用 `Arc<CodexThread>`，其他持有引用的地方仍可继续访问线程
- **shutdown 报告分类**：`shutdown_all_threads_bounded()` 只移除成功关闭的线程，超时和失败的线程保留在注册表中供后续处理
- **`Box::pin` 包装**：所有公开的 thread spawn 方法都通过 `Box::pin()` 包装委托调用，避免异步状态机因内联展开导致过大的 Future 体积