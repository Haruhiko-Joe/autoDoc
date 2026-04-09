# 线程状态管理（ThreadStateManagement）

## 概述与职责

线程状态管理模块是 AppServer 请求处理引擎（RequestProcessing）的核心基础设施，负责两个紧密关联但职责清晰分离的任务：

1. **`ThreadState` / `ThreadStateManager`**（`thread_state.rs`）：管理每个会话线程的运行时可变状态——中断队列、回滚追踪、turn 历史构建、事件监听器生命周期，以及连接（connection）到线程的订阅映射关系。
2. **`ThreadWatchManager`**（`thread_status.rs`）：追踪线程的宏观运行状态（NotLoaded / Idle / Active / SystemError），在状态转换时向客户端推送 `ThreadStatusChanged` 通知，并通过 RAII guard 管理待处理的权限/用户输入请求，同时暴露 running-turn-count watch channel 用于优雅关闭协调。

在整体架构中，该模块位于 **AppServer → RequestProcessing** 层级。AppServer 作为面向 IDE 扩展和桌面应用的本地服务，RequestProcessing 是其请求调度和事件处理引擎，而本模块为 RequestProcessing 提供每线程的状态存储和状态监控能力。同级模块包括消息处理器（MessageProcessor / CodexMessageProcessor）和事件处理层。

---

## 关键流程

### 1. 连接订阅与线程状态获取流程

当客户端连接建立后，`ThreadStateManager` 管理连接与线程之间的多对多订阅关系：

1. 连接初始化时调用 `connection_initialized()` 将 `ConnectionId` 注册到活跃连接集合
2. 客户端请求订阅某个线程时，`try_ensure_connection_subscribed()` 校验连接是否存活，然后建立双向映射：
   - `thread_ids_by_connection`：ConnectionId → Set\<ThreadId\>
   - `threads[thread_id].connection_ids`：ThreadId → Set\<ConnectionId\>
3. 如果客户端请求了 `experimental_raw_events`，同时在 `ThreadState` 上启用该标志
4. 返回对应线程的 `Arc<Mutex<ThreadState>>` 供后续操作使用

> 源码位置：`codex-rs/app-server/src/thread_state.rs:264-291`

### 2. 监听器生命周期管理（set / clear / cancel）

每个线程的事件监听器通过 `ThreadState` 的 `set_listener` / `clear_listener` 管理：

1. **`set_listener`**：设置新的监听器时，如果已有旧监听器，先通过 `cancel_tx` 发送取消信号；递增 `listener_generation` 计数器（用于区分不同代的监听器）；创建新的 `mpsc::unbounded_channel` 用于下发 `ThreadListenerCommand`；存储对 `CodexThread` 的 `Weak` 引用
2. **`clear_listener`**：发送取消信号、清除 command channel、重置 turn 历史、清除线程弱引用
3. **`listener_matches`**：通过 `Weak::upgrade` + `Arc::ptr_eq` 判断当前监听器是否关联到指定的 `CodexThread` 实例

> 源码位置：`codex-rs/app-server/src/thread_state.rs:66-95`

### 3. Turn 历史追踪

`ThreadState` 内嵌一个 `ThreadHistoryBuilder`（来自 protocol crate），通过 `track_current_turn_event()` 逐事件构建当前 turn 的历史记录：

1. 每次收到 `EventMsg` 时调用 `handle_event` 更新构建器
2. 如果构建器判定当前 turn 已结束（`has_active_turn()` 返回 false），自动 reset
3. 通过 `active_turn_snapshot()` 可随时获取进行中 turn 的快照

> 源码位置：`codex-rs/app-server/src/thread_state.rs:107-116`

### 4. 线程状态机转换与通知推送

`ThreadWatchManager` 内部通过 `RuntimeFacts` 结构追踪每个线程的运行时事实，并据此派生出 `ThreadStatus` 枚举值：

```
                    upsert_thread
    ┌─────────┐  ───────────────►  ┌──────┐
    │NotLoaded│                    │ Idle │
    └─────────┘  ◄───────────────  └──────┘
                  note_thread_shutdown    │
                  / remove_thread        │ note_turn_started
                                         ▼
                                   ┌──────────┐
                                   │  Active   │
                                   │(+flags)   │
                                   └──────────┘
                                    │        │
                     note_turn_completed   note_system_error
                                    │        │
                                    ▼        ▼
                                 ┌──────┐ ┌────────────┐
                                 │ Idle │ │SystemError  │
                                 └──────┘ └────────────┘
```

状态派生逻辑（`loaded_thread_status` 函数，`thread_status.rs:385-407`）：
- 未加载 → `NotLoaded`
- 有 pending permission 请求 → `Active` + `WaitingOnApproval` flag
- 有 pending user input 请求 → `Active` + `WaitingOnUserInput` flag
- `running` 为 true 或有任何 active flag → `Active`
- `has_system_error` 为 true → `SystemError`
- 其余 → `Idle`

每次状态变更通过 `mutate_and_publish` 模式：先在锁内修改状态并计算新旧状态差异，释放锁后通过 `OutgoingMessageSender` 广播 `ThreadStatusChanged` 通知，同时更新 `running_turn_count` watch channel。

> 源码位置：`codex-rs/app-server/src/thread_status.rs:222-245`

### 5. RAII Active Guard 机制

当线程需要等待权限审批或用户输入时，`ThreadWatchManager` 返回一个 `ThreadWatchActiveGuard`：

1. 调用 `note_permission_requested()` 或 `note_user_input_requested()` 时，递增对应的 pending 计数器，返回 guard
2. Guard 持有期间，线程状态包含对应的 `ThreadActiveFlag`
3. Guard 被 drop 时（通过 `Drop` trait），在 tokio runtime 中 spawn 一个异步任务递减计数器，自动触发状态重新计算和通知推送

这种 RAII 模式确保即使在错误路径上，pending 计数器也能被正确清理，不会出现"永远卡在等待审批"的状态泄漏。

> 源码位置：`codex-rs/app-server/src/thread_status.rs:27-66`

### 6. 连接断开的清理流程

当客户端连接断开时：

1. `remove_connection()` 从 `live_connections` 移除该连接
2. 遍历该连接订阅的所有线程，从每个线程的 `connection_ids` 中移除
3. 如果某个线程的订阅者变为零，**不会立即清理监听器**——仅记录日志，保留线程状态以便后续重连
4. 完整的线程清理需要显式调用 `remove_thread_state()`，此时才会清除监听器并从反向映射中移除

> 源码位置：`codex-rs/app-server/src/thread_state.rs:316-362`

---

## 函数签名与参数说明

### ThreadStateManager

| 方法 | 签名 | 说明 |
|------|------|------|
| `connection_initialized` | `async fn(&self, connection_id: ConnectionId)` | 注册新的活跃连接 |
| `try_ensure_connection_subscribed` | `async fn(&self, thread_id, connection_id, experimental_raw_events) -> Option<Arc<Mutex<ThreadState>>>` | 将连接订阅到线程，连接不存活时返回 None |
| `try_add_connection_to_thread` | `async fn(&self, thread_id, connection_id) -> bool` | 轻量版订阅，不涉及 raw events 设置 |
| `unsubscribe_connection_from_thread` | `async fn(&self, thread_id, connection_id) -> bool` | 取消订阅，返回是否成功 |
| `subscribed_connection_ids` | `async fn(&self, thread_id) -> Vec<ConnectionId>` | 获取线程的所有订阅连接 |
| `thread_state` | `async fn(&self, thread_id) -> Arc<Mutex<ThreadState>>` | 获取或创建线程状态（懒初始化） |
| `remove_thread_state` | `async fn(&self, thread_id)` | 彻底移除线程状态并清理监听器 |
| `remove_connection` | `async fn(&self, connection_id)` | 移除连接及其所有订阅关系 |
| `clear_all_listeners` | `async fn(&self)` | 关闭时清理所有线程的监听器 |
| `has_subscribers` | `async fn(&self, thread_id) -> bool` | 检查线程是否有活跃订阅者 |

### ThreadWatchManager

| 方法 | 签名 | 说明 |
|------|------|------|
| `new_with_outgoing` | `fn(outgoing: Arc<OutgoingMessageSender>) -> Self` | 创建带通知推送能力的实例 |
| `upsert_thread` | `async fn(&self, thread: Thread)` | 注册/更新线程并推送状态通知 |
| `upsert_thread_silently` | `async fn(&self, thread: Thread)` | 注册/更新线程但不推送通知（用于恢复场景） |
| `remove_thread` | `async fn(&self, thread_id: &str)` | 移除线程追踪 |
| `note_turn_started` | `async fn(&self, thread_id: &str)` | 标记 turn 开始，状态转为 Active |
| `note_turn_completed` | `async fn(&self, thread_id: &str, _failed: bool)` | 标记 turn 结束，清除 active 状态 |
| `note_turn_interrupted` | `async fn(&self, thread_id: &str)` | 标记 turn 中断 |
| `note_system_error` | `async fn(&self, thread_id: &str)` | 标记系统错误 |
| `note_thread_shutdown` | `async fn(&self, thread_id: &str)` | 标记线程关闭，状态回到 NotLoaded |
| `note_permission_requested` | `async fn(&self, thread_id: &str) -> ThreadWatchActiveGuard` | 记录待审批请求，返回 RAII guard |
| `note_user_input_requested` | `async fn(&self, thread_id: &str) -> ThreadWatchActiveGuard` | 记录待用户输入请求，返回 RAII guard |
| `subscribe_running_turn_count` | `fn(&self) -> watch::Receiver<usize>` | 订阅活跃 turn 计数变更（用于优雅关闭） |
| `loaded_status_for_thread` | `async fn(&self, thread_id: &str) -> ThreadStatus` | 查询单个线程当前状态 |
| `loaded_statuses_for_threads` | `async fn(&self, thread_ids: Vec<String>) -> HashMap<String, ThreadStatus>` | 批量查询线程状态 |

### 独立函数

**`resolve_thread_status(status: ThreadStatus, has_in_progress_turn: bool) -> ThreadStatus`**

补偿 watch 状态与事件监听器之间的竞态：如果当前有正在进行的 turn 但 watch 状态还未更新（仍为 `Idle` 或 `NotLoaded`），强制返回 `Active`。

> 源码位置：`codex-rs/app-server/src/thread_status.rs:279-293`

---

## 接口/类型定义

### `ThreadState`

```rust
pub(crate) struct ThreadState {
    pub(crate) pending_interrupts: PendingInterruptQueue,  // 待处理的中断请求队列
    pub(crate) pending_rollbacks: Option<ConnectionRequestId>,  // 待处理的回滚请求
    pub(crate) turn_summary: TurnSummary,  // 当前 turn 的累积摘要
    pub(crate) cancel_tx: Option<oneshot::Sender<()>>,  // 取消当前监听器的信号
    pub(crate) experimental_raw_events: bool,  // 是否启用原始事件透传
    pub(crate) listener_generation: u64,  // 监听器代数，用于区分不同监听器实例
    // 私有字段: listener_command_tx, current_turn_history, listener_thread
}
```

> 源码位置：`codex-rs/app-server/src/thread_state.rs:52-63`

### `TurnSummary`

每个 turn 执行期间累积的状态摘要：

| 字段 | 类型 | 说明 |
|------|------|------|
| `file_change_started` | `HashSet<String>` | 本 turn 中发起的文件变更路径集合 |
| `command_execution_started` | `HashSet<String>` | 本 turn 中发起的命令执行集合 |
| `last_error` | `Option<TurnError>` | 最近的错误信息 |

> 源码位置：`codex-rs/app-server/src/thread_state.rs:45-50`

### `PendingInterruptQueue`

```rust
type PendingInterruptQueue = Vec<(ConnectionRequestId, ApiVersion)>;
```

存储等待处理的中断请求，每个条目包含发起请求的连接标识和 API 版本。

### `ThreadListenerCommand`

线程监听器的命令枚举，用于在监听器上下文中序列化执行操作：

- `SendThreadResumeResponse(Box<PendingThreadResumeRequest>)`：恢复已运行线程，发送历史记录并原子订阅新更新
- `ResolveServerRequest { request_id, completion_tx }`：通知客户端请求已解决，确保通知与请求本身有序

> 源码位置：`codex-rs/app-server/src/thread_state.rs:33-42`

### `ThreadStatus`（来自 protocol crate）

线程状态枚举，由 `RuntimeFacts` 派生：

- `NotLoaded`：线程未加载或已关闭
- `Idle`：线程已加载但无活跃 turn
- `Active { active_flags: Vec<ThreadActiveFlag> }`：线程正在执行，可能附带等待标志
- `SystemError`：发生系统错误

### `ThreadActiveFlag`（来自 protocol crate）

- `WaitingOnApproval`：等待权限审批
- `WaitingOnUserInput`：等待用户输入

---

## 边界 Case 与注意事项

- **连接断开不清理监听器**：当连接断开导致线程零订阅者时，`remove_connection()` 有意保留线程监听器和状态，仅记录 debug 日志。这允许客户端重连后继续接收事件，避免不必要的线程重建。完整清理需显式调用 `remove_thread_state()`。

- **listener_generation 的 wrapping 行为**：`listener_generation` 使用 `wrapping_add(1)`，理论上在 u64 溢出时会回绕到 0。实际场景中不太可能到达，但设计上已考虑。

- **Guard 的 Drop 是异步的**：`ThreadWatchActiveGuard` 的 `Drop` 实现通过 `tokio::runtime::Handle::spawn` 启动异步任务来递减计数器。这意味着 guard drop 后状态更新不是立即生效的——测试中使用 `wait_for_status` 轮询来处理这个时间窗口。

- **竞态补偿**：`resolve_thread_status()` 函数专门处理事件监听器已看到 turn 开始事件但 `ThreadWatchManager` 的 watch 状态尚未更新的竞态窗口，将 `Idle`/`NotLoaded` 升级为 `Active`。

- **silent upsert**：`upsert_thread_silently()` 在恢复场景中注册线程但不推送通知，避免客户端收到虚假的状态变更事件。后续的实际状态变更（如 turn 开始）仍会正常推送。

- **锁的获取顺序**：`ThreadStateManager` 使用两层锁——外层 `ThreadStateManagerInner` 的 `Mutex` 和内层每个 `ThreadState` 的 `Mutex`。在 `remove_thread_state()` 等方法中，先获取外层锁完成映射操作，释放后再获取内层锁执行清理，避免死锁。