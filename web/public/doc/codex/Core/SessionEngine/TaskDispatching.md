# 任务调度（TaskDispatching）

## 概述与职责

任务调度模块是 SessionEngine 的核心执行层，负责在会话循环中启动、运行和管理不同类型的 turn（回合）。它位于 **Core > SessionEngine** 层级下，为整个 agent 会话提供统一的任务生命周期管理——从任务的创建、spawn 到 Tokio 后台任务、取消中断，直到完成后的指标上报和事件通知。

在 Codex 架构中，每当用户发送消息、请求代码审查、触发上下文压缩或执行 undo 操作时，SessionEngine 都会通过本模块将具体的工作分派给对应的 Task 实现来执行。同级兄弟模块包括 Protocol（协议类型）、ContextManagement（上下文管理）、ToolsOrchestration（工具编排）等。

### 模块内的六种任务类型

| 任务类型 | 结构体 | 用途 |
|----------|--------|------|
| **RegularTask** | `RegularTask` | 标准模型对话回合，包含工具调用循环 |
| **CompactTask** | `CompactTask` | 上下文压缩回合，缩减历史以适应 token 窗口 |
| **ReviewTask** | `ReviewTask` | 代码审查，产出结构化审查结果 |
| **UndoTask** | `UndoTask` | 回退到上一个 ghost snapshot |
| **UserShellCommandTask** | `UserShellCommandTask` | 执行用户发起的 shell 命令 |
| **GhostSnapshotTask** | `GhostSnapshotTask` | 在中断的 turn 之后创建仓库快照分叉 |

## 关键流程

### 1. SessionTask trait 与任务抽象

所有任务类型统一实现 `SessionTask` trait，定义在 `mod.rs:129-167`：

```rust
pub(crate) trait SessionTask: Send + Sync + 'static {
    fn kind(&self) -> TaskKind;
    fn span_name(&self) -> &'static str;
    fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        input: Vec<UserInput>,
        cancellation_token: CancellationToken,
    ) -> impl std::future::Future<Output = Option<String>> + Send;
    fn abort(&self, session: Arc<SessionTaskContext>, ctx: Arc<TurnContext>)
        -> impl std::future::Future<Output = ()> + Send;
}
```

- `kind()`: 返回 `TaskKind` 枚举值，用于遥测和 UI 展示
- `span_name()`: 返回 tracing span 名称（如 `"session_task.turn"`、`"session_task.review"`）
- `run()`: 核心执行方法，返回 `Option<String>` 作为最终 agent 消息
- `abort()`: 取消时的清理钩子，默认 no-op

由于 `SessionTask::run` 使用了 `impl Future`（RPITIT），无法直接用作 trait object。因此引入了 `AnySessionTask` trait（`mod.rs:169-224`）通过 `BoxFuture` 进行类型擦除，并为所有 `T: SessionTask` 提供 blanket implementation。

### 2. 任务生命周期：spawn → run → finish/abort

**spawn_task 流程**（`mod.rs:227-236`）：

1. 调用 `abort_all_tasks(TurnAbortReason::Replaced)` 终止当前活跃的所有任务
2. 清除 connector 选择状态
3. 委托给 `start_task` 启动新任务

**start_task 流程**（`mod.rs:238-329`）：

1. 记录 turn 开始时间和 token 使用基线（`token_usage_at_turn_start`）
2. 创建 `CancellationToken` 和 `Notify` 用于取消协调
3. 收集 queued response items 和 mailbox items 作为 pending input
4. 在 Tokio runtime 上 spawn 一个后台任务，带有 tracing instrument span
5. 任务完成后自动调用 `on_task_finished`
6. 将 `RunningTask` 注册到 `ActiveTurn` 中

**on_task_finished 流程**（`mod.rs:387-528`）：

1. 取消 git enrichment 任务
2. 从 `TurnState` 中取出 pending input，通过 hook runtime 处理
3. 计算本次 turn 的 token 增量消耗并上报多维 histogram 指标（input/output/cached/reasoning/total）
4. 上报工具调用次数和网络代理状态指标
5. 发送 `TurnComplete` 事件
6. 如果还有 pending work，自动触发下一个 turn

### 3. 中断与优雅取消

中断处理在 `handle_task_abort`（`mod.rs:550-596`）中实现：

1. 调用 `cancellation_token.cancel()` 通知任务取消
2. 使用 `tokio::select!` 等待任务完成或超时（**100ms** 优雅中断窗口，`GRACEFULL_INTERRUPTION_TIMEOUT_MS`）
3. 超时后强制 `handle.abort()`
4. 调用任务的 `abort()` 钩子进行清理
5. 如果是用户主动中断（`TurnAbortReason::Interrupted`）：
   - 调用 `cleanup_after_interrupt` 中断 JS REPL 内核
   - 在历史中插入 `interrupted_turn_history_marker()`，告知模型上一个 turn 被用户中断
   - 持久化中断标记到 rollout 并 flush
6. 发送 `TurnAborted` 事件

中断标记的内容格式为（`mod.rs:62-78`）：

```
<turn_aborted>
The user interrupted the previous turn on purpose. Any running unified exec
processes may still be running in the background...
</turn_aborted>
```

### 4. RegularTask — 标准对话回合

`RegularTask`（`regular.rs`）是最核心的任务类型，驱动模型的对话-工具调用循环：

1. 发送 `TurnStarted` 事件（包含 model context window 大小和协作模式）
2. 尝试消费 startup prewarm 预热的 client session
   - 如果取消则直接返回
   - 如果预热不可用则正常创建新 session
3. 进入主循环：调用 `run_turn()` 执行一轮模型交互（含工具调用）
4. 如果执行后还有 pending input（如工具产出的后续输入），继续循环
5. 循环退出时返回最后的 agent message

> 源码位置：`codex-rs/core/src/tasks/regular.rs:36-82`

### 5. CompactTask — 上下文压缩

`CompactTask`（`compact.rs`）在上下文接近 token 限制时执行压缩：

1. 根据 provider 类型决定使用 **remote** 还是 **local** compact 策略
   - `should_use_remote_compact_task(&ctx.provider)` 进行判断
2. 通过遥测 counter 记录 compact 类型（`"remote"` 或 `"local"`）
3. 委托给 `run_remote_compact_task` 或 `run_compact_task` 执行
4. 始终返回 `None`（compact 不产出 agent message）

> 源码位置：`codex-rs/core/src/tasks/compact.rs:22-47`

### 6. ReviewTask — 代码审查

`ReviewTask`（`review.rs`）通过启动一个独立的 sub-agent 会话来执行代码审查：

**启动审查子会话**（`review.rs:95-138`）：

1. 克隆当前 config 并应用审查限制：
   - 禁用 web search
   - 禁用 SpawnCsv 和 Collab feature
   - 设置审查专用 prompt（`REVIEW_PROMPT`）
   - 设置审批策略为 `Never`（审查不需要用户审批工具调用）
2. 使用 `review_model`（如配置）或当前模型
3. 调用 `run_codex_thread_one_shot` 创建一次性子 agent 会话

**处理审查事件**（`review.rs:140-188`）：

- 监听子会话事件流，过滤掉 agent message delta（不展示中间流式输出）
- 在 `TurnComplete` 时解析最终 agent message 为 `ReviewOutputEvent`
- 其他事件（如工具调用）原样转发给父会话

**解析审查结果**（`review.rs:195-210`）：

`parse_review_output_event` 尝试三种策略解析模型输出：
1. 直接 JSON 反序列化
2. 提取首尾 `{}`  之间的 JSON 子串
3. 兜底：将原始文本放入 `overall_explanation` 字段

**退出审查模式**（`review.rs:214-283`）：

- 如果有审查结果：渲染结构化 findings 并记录到会话历史
- 如果中断：记录中断提示信息
- 发送 `ExitedReviewMode` 事件
- `abort()` 钩子也会调用 `exit_review_mode` 确保审查模式被正确退出

### 7. UndoTask — 回退操作

`UndoTask`（`undo.rs`）恢复到之前的 ghost snapshot 状态：

1. 发送 `UndoStarted` 事件
2. 检查取消状态，如已取消则立即返回
3. 从会话历史中**倒序查找**最后一个 `ResponseItem::GhostSnapshot`
4. 如果未找到，报告 "No ghost snapshot available to undo"
5. 在 blocking 线程池中调用 `restore_ghost_commit_with_options` 恢复 git 状态
6. 成功后从历史中移除该 snapshot 项，并更新会话历史
7. 发送 `UndoCompleted` 事件（包含成功/失败状态和消息）

> 源码位置：`codex-rs/core/src/tasks/undo.rs:36-129`

### 8. UserShellCommandTask — 用户 Shell 命令

`UserShellCommandTask`（`user_shell.rs`）执行用户直接输入的 shell 命令。支持两种模式：

- **`StandaloneTurn`**：作为独立的 turn 生命周期（发送 TurnStarted/TurnComplete）
- **`ActiveTurnAuxiliary`**：在已有活跃 turn 内执行，不发送重复的生命周期事件

**执行流程**（`user_shell.rs:92-312`）：

1. 使用用户的 login shell 构造执行参数（支持管道、重定向等 shell 特性）
2. 可选地包装 snapshot 逻辑（`maybe_wrap_shell_lc_with_snapshot`）
3. 发送 `ExecCommandBegin` 事件（包含解析后的命令信息）
4. 构造 `ExecRequest`，使用 `DangerFullAccess` 沙箱策略（用户命令不受限制），超时 **1 小时**
5. 通过 `execute_exec_request` 执行，支持 stdout 实时流式输出
6. 处理三种结果：
   - **取消**：记录 "command aborted by user"
   - **成功/失败**：发送 `ExecCommandEnd` 事件，包含完整的 stdout/stderr/exit_code
   - **执行错误**：记录错误信息

**输出持久化**（`user_shell.rs:314-350`）：

- `StandaloneTurn` 模式：直接记录到会话历史
- `ActiveTurnAuxiliary` 模式：尝试注入到当前活跃 turn 的响应流中；如果注入失败则回退到直接记录

### 9. GhostSnapshotTask — 仓库快照

`GhostSnapshotTask`（`ghost_snapshot.rs`）在 turn 执行前捕获仓库状态，为 undo 功能提供恢复点：

1. 持有一个 `Token`（readiness gate），完成后标记 gate ready 以解除工具调用阻塞
2. 启动一个**超时警告子任务**：如果快照操作超过 **240 秒**，向用户发出警告（可能是大文件导致的性能问题）
3. 在 blocking 线程池中调用 `create_ghost_commit_with_report` 创建 ghost commit
4. 成功后：
   - 格式化并发送 snapshot 警告（大型未跟踪目录/文件）
   - 将 `ResponseItem::GhostSnapshot` 记录到会话历史
5. 失败处理：
   - 非 git 仓库：静默跳过
   - 其他错误：记录 warning
   - 任务 panic：通知用户 snapshot 已禁用
6. 支持取消：通过 `tokio::select!` 监听 cancellation token

**Snapshot 警告格式化**（`ghost_snapshot.rs:167-248`）：

- 大型未跟踪目录警告：显示目录路径和文件数量（最多展示 3 个）
- 大型未跟踪文件警告：显示文件路径和大小（带 KiB/MiB 格式化）
- 阈值可通过 `ghost_snapshot.ignore_large_untracked_dirs` 和 `ghost_snapshot.ignore_large_untracked_files` 配置

## 接口/类型定义

### `SessionTaskContext`

`SessionTaskContext`（`mod.rs:98-119`）是 `Session` 的轻量级封装，限制任务只能访问必要的会话能力：

```rust
pub(crate) struct SessionTaskContext {
    session: Arc<Session>,
}
```

提供三个方法：
- `clone_session()` → `Arc<Session>`：获取完整会话引用
- `auth_manager()` → `Arc<AuthManager>`：获取认证管理器
- `models_manager()` → `Arc<ModelsManager>`：获取模型管理器

### `UserShellCommandMode`

```rust
pub(crate) enum UserShellCommandMode {
    StandaloneTurn,        // 独立 turn 生命周期
    ActiveTurnAuxiliary,   // 在已有 turn 内执行
}
```

## 配置项与默认值

| 配置项 | 值 | 说明 |
|--------|------|------|
| `GRACEFULL_INTERRUPTION_TIMEOUT_MS` | 100ms | 优雅中断等待窗口 |
| `USER_SHELL_TIMEOUT_MS` | 3,600,000ms (1h) | 用户 shell 命令超时 |
| `SNAPSHOT_WARNING_THRESHOLD` | 240s | Ghost snapshot 超时警告阈值 |
| `ghost_snapshot.disable_warnings` | 布尔 | 是否禁用 snapshot 警告 |
| `ghost_snapshot.ignore_large_untracked_dirs` | 可选整数 | 大型未跟踪目录文件数阈值 |
| `ghost_snapshot.ignore_large_untracked_files` | 可选整数 | 大型未跟踪文件字节数阈值 |

## 遥测指标

本模块在 turn 完成时上报以下指标：

- **`TURN_E2E_DURATION_METRIC`**：turn 端到端耗时（timer，在 spawn 时启动）
- **`TURN_TOKEN_USAGE_METRIC`**：token 使用量 histogram，按 `token_type` 维度拆分（`total`、`input`、`cached_input`、`output`、`reasoning_output`）
- **`TURN_TOOL_CALL_METRIC`**：turn 内工具调用次数 histogram
- **`TURN_NETWORK_PROXY_METRIC`**：网络代理是否激活（counter，`active=true/false`）
- **`codex.task.compact`**：compact 任务计数（按 `type=remote/local`）
- **`codex.task.review`**：review 任务计数
- **`codex.task.undo`**：undo 任务计数
- **`codex.task.user_shell`**：user shell 命令计数

## 边界 Case 与注意事项

- **Pending work 自动唤醒**：turn 完成后，如果存在 queued response items 或 mailbox 中标记了 `trigger_turn` 的消息，会自动启动新的 `RegularTask`（`maybe_start_turn_for_pending_work`，`mod.rs:338-371`）。这个调度使用 `spawn_blocking` + `block_on` 来避免 async 递归。

- **RegularTask 的内部循环**：`RegularTask::run` 中的 `loop` 确保一次 turn 内如果产生了新的 pending input，会继续调用 `run_turn` 而不是退出。只有当 `has_pending_input()` 返回 false 时才结束。

- **UndoTask 报告 `TaskKind::Regular`**：`UndoTask` 和 `UserShellCommandTask` 的 `kind()` 都返回 `TaskKind::Regular` 而非专用枚举值，这意味着它们在遥测维度上与普通 turn 不可区分。

- **ReviewTask 的事件过滤**：审查子会话的 `AgentMessage`/`AgentMessageDelta`/`AgentMessageContentDelta` 事件被静默丢弃，不会转发到父会话——避免审查过程中间输出干扰用户。

- **GhostSnapshotTask 的 readiness gate**：snapshot 完成后通过 `tool_call_gate.mark_ready(token)` 解锁，这意味着 turn 中的工具调用会等待 snapshot 完成后才能开始执行。

- **UserShellCommand 不受沙箱限制**：使用 `SandboxPolicy::DangerFullAccess` 和 `SandboxType::None`，因为这是用户主动发起的命令，不需要安全沙箱限制。