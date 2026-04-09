# 线程生命周期管理（ThreadLifecycle）

## 概述与职责

ThreadLifecycle 是 TUI 应用中管理多线程（Thread）完整生命周期的核心模块，实现在 `App` 结构体的 `impl` 块内（`codex-rs/tui/src/app.rs:1540–3548`）。它负责线程通道的创建与销毁、线程激活与切换、事件缓冲与路由、快照回放、Agent 导航选择器、以及多 Agent 会话的子线程发现与回填。

在系统架构中，该模块位于 **TUI → AppOrchestrator → AppCore → MainEventLoop** 层级下。`App` 是 TUI 的中央状态机，而 ThreadLifecycle 是其中管理线程状态转换的关键子系统。它与 `AppServerSession`（服务端会话）、`ChatWidget`（聊天界面）、`AgentNavigationState`（Agent 导航缓存）以及 `PendingInteractiveReplayState`（交互回放跟踪）紧密协作。

同级模块包括：`ServerEventAdapter`（服务端事件适配）、`PendingRequests`（待处理请求跟踪）、`InteractiveReplayTracking`（交互回放过滤）、`AgentNavigation`（Agent 导航状态）、`LoadedThreadDiscovery`（子 Agent 线程发现）。

## 核心数据结构

### `ThreadEventChannel`

每个线程对应一个事件通道，包含三部分（`app.rs:677–704`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sender` | `mpsc::Sender<ThreadBufferedEvent>` | 向通道发送事件 |
| `receiver` | `Option<mpsc::Receiver<ThreadBufferedEvent>>` | 接收端，激活时被取走 |
| `store` | `Arc<Mutex<ThreadEventStore>>` | 持久化的事件缓冲存储 |

通道容量为常量 `THREAD_EVENT_CHANNEL_CAPACITY = 32768`（`app.rs:166`）。

### `ThreadEventStore`

线程事件的持久存储（`app.rs:516–674`），维护：

- `session`：线程会话状态（模型、审批策略、工作目录等）
- `turns`：已完成的对话轮次
- `buffer`：`VecDeque<ThreadBufferedEvent>` 事件缓冲队列
- `pending_interactive_replay`：跟踪未决交互提示（审批、权限请求等）
- `active_turn_id`：当前进行中的轮次 ID
- `active`：标记线程是否为当前活跃线程

当缓冲区超出容量时，最旧事件被弹出，并通过 `note_evicted_server_request()` 通知回放跟踪器。

### `ThreadEventSnapshot`

线程状态快照（`app.rs:491–497`），用于线程切换时的回放：

```rust
struct ThreadEventSnapshot {
    session: Option<ThreadSessionState>,
    turns: Vec<Turn>,
    events: Vec<ThreadBufferedEvent>,  // 仅保留未决交互请求
    input_state: Option<ThreadInputState>,
}
```

`snapshot()` 方法（`app.rs:625–645`）生成快照时，通过 `PendingInteractiveReplayState::should_replay_snapshot_request()` 过滤掉已解决的请求，防止切换线程后重复显示已回答的审批对话框。

### `ThreadBufferedEvent`

线程事件的四种变体（`app.rs:500–505`）：`Notification`（服务端通知）、`Request`（服务端请求）、`HistoryEntryResponse`（历史记录响应）、`FeedbackSubmission`（反馈提交）。

## 关键流程

### 1. 线程通道管理

**创建通道**：`ensure_thread_channel(thread_id)` （`app.rs:1567–1571`）在 `thread_event_channels` HashMap 中按需创建通道。首次访问某 `ThreadId` 时自动初始化，后续调用直接返回已有通道的可变引用。

**销毁监听器**：
- `abort_thread_event_listener(thread_id)`（`app.rs:1551–1555`）：从 `thread_event_listener_tasks` 移除并中止指定线程的后台监听任务。
- `abort_all_thread_event_listeners()`（`app.rs:1557–1565`）：中止所有监听任务，用于完全重置线程状态。

### 2. 线程激活与去激活

线程激活的核心思想是**同一时刻只有一个线程处于活跃状态**，活跃线程的事件接收器（receiver）被从通道取走，直接绑定到 `App` 的 `active_thread_rx` 字段，由主事件循环的 `select!` 消费。

**激活流程** `activate_thread_channel(thread_id)`（`app.rs:1580–1593`）：
1. 如果已有活跃线程，直接返回（防止重复激活）
2. 设置 store 的 `active` 标志为 `true`
3. 将 `receiver` 从通道取出，赋给 `self.active_thread_rx`
4. 记录 `self.active_thread_id`
5. 刷新待处理审批状态

**存储并去激活** `store_active_thread_receiver()`（`app.rs:1595–1609`）：
1. 捕获当前 ChatWidget 的输入状态（如草稿内容）
2. 将 `active_thread_rx` 归还给通道
3. 设置 `active = false`
4. 保存输入状态到 store 以便下次切换回来时恢复

**为回放激活** `activate_thread_for_replay(thread_id)`（`app.rs:1611–1621`）：
返回 `(receiver, snapshot)` 元组。取走 receiver 并标记为 active，同时生成快照。线程切换流程使用此方法获取目标线程的完整状态。

**清除活跃线程** `clear_active_thread()`（`app.rs:1623–1629`）：
释放活跃线程标记和接收器，用于断连恢复等场景。

### 3. 出站操作跟踪

当用户对某线程执行操作（如批准命令执行、回答权限请求）时，需要通知 `PendingInteractiveReplayState`，以便后续快照回放时不再重复展示已处理的提示。

- `note_thread_outbound_op(thread_id, op)`（`app.rs:1631–1637`）：锁定 store 并记录出站操作
- `note_active_thread_outbound_op(op)`（`app.rs:1639–1647`）：快捷方法，仅在操作可能改变回放状态时才执行
- `active_turn_id_for_thread(thread_id)`（`app.rs:1649–1653`）：查询指定线程当前进行中的轮次 ID，用于中断和转向操作

### 4. 线程事件路由

事件路由是将来自 app-server 的通知和请求分发到正确线程通道的过程。

**`enqueue_thread_notification(thread_id, notification)`**（`app.rs:2467–2508`）：
1. 调用 `infer_session_for_thread_notification()` 尝试从 `ThreadStarted` 通知推断会话状态
2. 获取通道的 sender 和 store
3. 锁定 store：如果会话为空则填充推断结果，将通知推入缓冲区
4. 若线程活跃，通过 sender 发送事件；优先使用 `try_send`，满时异步 spawn 发送
5. 刷新待处理审批

**`enqueue_thread_request(thread_id, request)`**（`app.rs:2603–2652`）：
与通知路由类似，但额外处理非活跃线程的交互请求：如果目标线程不是当前活跃线程，将审批/MCP 请求直接推送到 ChatWidget 供用户处理。

**`hydrate_collab_agent_metadata_for_notification(app_server, notification)`**（`app.rs:2521–2568`）：
对协作通知中引用的 receiver 线程 ID，通过 `thread/read` RPC 获取 agent 的 nickname 和 role，注册到导航缓存。每个线程最多一次 RPC，失败时静默降级为显示线程 ID。

**`infer_session_for_thread_notification(thread_id, notification)`**（`app.rs:2570–2601`）：
仅处理 `ThreadStarted` 通知。从主会话配置克隆基础信息，覆盖线程特定字段（thread_id、name、model_provider、cwd、rollout_path），并通过 `read_session_model()` 异步获取模型名称。同时注册 agent picker 条目。

**主线程事件快捷路由**：
- `enqueue_primary_thread_notification(notification)`（`app.rs:2746–2758`）：若主线程 ID 已确定则路由到它，否则暂存到 `pending_primary_events`
- `enqueue_primary_thread_request(request)`（`app.rs:2760–2767`）：同上逻辑

**`enqueue_primary_thread_session(session, turns)`**（`app.rs:2698–2743`）：
初始化主线程的完整流程：
1. 记录 `primary_thread_id` 和 `primary_session_configured`
2. 注册 agent picker 条目
3. 在 store 中设置会话和轮次
4. 激活线程通道
5. 抑制初始用户消息提交（防止竞态）
6. 让 ChatWidget 处理会话并回放轮次
7. 排空 `pending_primary_events` 中积压的事件
8. 解除抑制并提交待处理的初始用户消息

**快照会话刷新**：
- `refresh_snapshot_session_if_needed()`（`app.rs:2769–2800`）：在非纯回放场景下，如果快照的会话信息不完整（模型为空或无 rollout_path），通过 `resume_thread` RPC 重新获取
- `apply_refreshed_snapshot_thread()`（`app.rs:2802–2819`）：将刷新后的会话和轮次写回 store，并过滤缓冲区中不应在刷新后保留的事件

### 5. Agent 选择器

**`open_agent_picker(app_server)`**（`app.rs:2821–2898`）：
1. 收集所有已知线程 ID（导航缓存 + 事件通道）
2. 逐一刷新活跃状态（`refresh_agent_picker_thread_liveness`）
3. 若未启用协作模式且无非主线程 agent，显示启用提示
4. 构建 `SelectionItem` 列表，标记当前活跃线程，绑定选择回调
5. 通过 ChatWidget 展示选择视图

**`upsert_agent_picker_thread(thread_id, nickname, role, is_closed)`**（`app.rs:2924–2939`）：
同时更新 ChatWidget 的协作 agent 元数据和 `AgentNavigationState`，然后同步 footer 标签。

**`mark_agent_picker_thread_closed(thread_id)`**（`app.rs:2945–2948`）：
将线程标记为已关闭但不移除，保持键盘导航顺序的稳定性。

**`refresh_agent_picker_thread_liveness(app_server, thread_id)`**（`app.rs:2950–3006`）：
通过 `thread/read` RPC 检查线程是否仍然加载。失败时根据错误类型决定标记为 closed 还是移除。

**`session_state_for_thread_read(thread_id, thread)`**（`app.rs:3008–3048`）：
从 `thread/read` 响应构建 `ThreadSessionState`，以主会话为基底覆盖线程特定字段。

**`attach_live_thread_for_selection(app_server, thread_id)`**（`app.rs:3056–3110`）：
当 picker 知道某线程但 TUI 没有本地通道时，按需创建：
1. 优先尝试 `resume_thread` 建立实时连接
2. 失败则降级为 `thread/read`（含 turns）获取只读快照
3. 若 `include_turns` 也失败，再降级为不含 turns 的 read
4. 没有 turns 的空通道会阻塞后续真正的重新连接，因此报错

返回 `bool` 表示是否建立了实时连接（`false` 表示仅回放模式）。

**`select_agent_thread(tui, app_server, thread_id)`**（`app.rs:3138–3229`）——**线程切换的主流程**：
1. 如果目标已是活跃线程，直接返回
2. 刷新目标线程活跃状态
3. 必要时调用 `attach_live_thread_for_selection` 建立连接
4. `store_active_thread_receiver()` 暂存当前线程状态
5. `activate_thread_for_replay()` 获取目标线程的 receiver 和快照
6. `refresh_snapshot_session_if_needed()` 确保会话信息完整
7. 创建新的 ChatWidget 并替换（`replace_chat_widget`）
8. `reset_for_thread_switch()` 清除 UI 状态
9. `replay_thread_snapshot()` 回放快照重建界面
10. `drain_active_thread_events()` 消费切换期间积压的事件
11. 刷新待处理审批

**`adjacent_thread_id_with_backfill(app_server, direction)`**（`app.rs:3411–3434`）：
键盘导航的快捷方式。先查本地缓存，无结果时触发 `backfill_loaded_subagent_threads` 发现远程子 agent，然后重试。每个主线程最多回填一次。

**`backfill_loaded_subagent_threads(app_server)`**（`app.rs:3345–3401`）：
从 app-server 获取所有已加载线程列表，用 `find_loaded_subagent_threads_for_primary()` 做广度优先遍历找出属于主线程的子 agent，逐一注册到导航缓存。

### 6. 线程切换与 UI 重建

**`reset_for_thread_switch(tui)`**（`app.rs:3239–3249`）：
清除 overlay、转录单元、延迟历史行、回溯状态，并清空终端滚动缓冲和屏幕。

**`reset_thread_event_state()`**（`app.rs:3251–3264`）：
全面重置所有线程相关状态——中止监听器、清空通道和导航、重置主线程和会话、清除积压事件和待处理请求。

**`replace_chat_widget(chat_widget)`**（`app.rs:3118–3136`）：
替换 ChatWidget 时：
1. 转移终端标题避免闪烁
2. 将导航缓存中所有 agent 的 nickname/role 复制到新 widget（线程切换会重建 widget 导致元数据丢失）
3. 同步 footer 标签

**`replace_chat_widget_with_app_server_thread(tui, app_server, started)`**（`app.rs:3319–3332`）：
完整的 widget 替换流程：重置线程状态 → 创建新 widget → 注入主线程会话 → 回填子 agent。

### 7. 新会话启动

**`start_fresh_session_with_summary_hint(tui, app_server)`**（`app.rs:3266–3317`）：
1. 从磁盘刷新配置
2. 生成会话摘要（token 用量、恢复命令）
3. 关闭当前线程并取消订阅所有追踪的线程
4. 通过 app-server 启动新线程
5. 替换 ChatWidget 并显示摘要信息

**`fresh_session_config()`**（`app.rs:3436–3440`）：
克隆当前配置并应用 ChatWidget 中的 service_tier 设置。

### 8. 快照回放

**`replay_thread_snapshot(snapshot, resume_restored_queue)`**（`app.rs:3497–3525`）：
1. 设置会话状态
2. 抑制队列自动发送（防止回放过程中触发新操作）
3. 恢复输入状态（草稿等）
4. 回放历史轮次
5. 逐条回放缓冲事件（`handle_thread_event_replay`）
6. 解除抑制，提交待处理消息
7. 若需要恢复队列，触发下一条排队输入

**`drain_active_thread_events(tui)`**（`app.rs:3442–3469`）：
非阻塞地消费活跃线程接收器中积压的事件。使用 `try_recv` 循环，遇到 `Empty` 停止，遇到 `Disconnected` 则清除活跃线程。

### 9. 线程关闭与故障转移

**`shutdown_current_thread(app_server)`**（`app.rs:1540–1549`）：
取消订阅当前线程并中止其事件监听器，同时清除进行中的回溯操作。

**`active_non_primary_shutdown_target(notification)`**（`app.rs:3482–3495`）：
判断是否应触发故障转移。仅当：
1. 事件为 `ThreadClosed`
2. 活跃线程不是主线程
3. 活跃线程不是用户主动请求退出的线程

**`handle_active_thread_event(tui, app_server, event)`**（`app.rs:5644–5704`）：
活跃线程事件的总入口。执行顺序：
1. 检查是否匹配待处理的关闭退出（用于 Ctrl+C 等场景）
2. 若为非主线程意外关闭，触发故障转移：标记关闭 → 切换到主线程 → 显示提示
3. 清除匹配的退出标记
4. 对协作通知填充 agent 元数据
5. 通过 `handle_thread_event_now()` 正常处理事件

### 10. 事件处理

**`handle_thread_event_now(event)`**（`app.rs:5595–5620`）：
根据事件类型分发到 ChatWidget 的对应处理方法，`replay_kind` 为 `None`（实时事件）。对 `TurnStarted` 和 `TokenUsageUpdated` 额外刷新状态栏。

**`handle_thread_event_replay(event)`**（`app.rs:5622–5637`）：
与 `handle_thread_event_now` 类似，但 `replay_kind` 为 `Some(ReplayKind::ThreadSnapshot)`，让 ChatWidget 知道这是快照回放而非实时事件（影响动画、自动发送等行为）。

## 操作提交

**`submit_thread_op(app_server, thread_id, op)`**（`app.rs:1839–1872`）：
操作提交的三层过滤管线：
1. `try_handle_local_history_op()`——本地处理历史记录操作，绕过 app-server
2. `try_resolve_app_server_request()`——匹配并解决待处理的 app-server 请求（审批、权限等）
3. `try_submit_active_thread_op_via_app_server()`——通过 app-server 提交操作（用户消息、中断、回滚、技能列表等）

`try_submit_active_thread_op_via_app_server()`（`app.rs:2207–2402`）处理的操作类型包括：
- `Interrupt`：中断当前轮次
- `UserTurn`：提交用户消息，优先尝试 `turn_steer`（向进行中的轮次追加内容），失败后回退到 `turn_start`
- `ListSkills`、`Compact`、`SetThreadName`、`ThreadRollback`、`Review`
- 实时会话操作（`RealtimeConversationStart/Audio/Text/Close`）
- `RunUserShellCommand`、`ReloadUserConfig` 等

## 边界 Case 与注意事项

- **同时只能有一个活跃线程**：`activate_thread_channel()` 在已有活跃线程时直接返回，确保不会出现双重活跃
- **通道溢出处理**：当 `try_send` 返回 `Full` 时，异步 spawn 一个任务完成发送，避免阻塞主事件循环
- **切换期间的事件丢失**：线程切换涉及暂存 receiver → 创建快照 → 重建 UI → 排空积压事件的多步流程，缓冲机制确保切换期间到达的事件不会丢失
- **回放过滤**：快照回放时通过 `PendingInteractiveReplayState` 过滤已解决的交互请求，避免用户看到重复的审批对话框
- **故障转移仅限非主线程**：子 agent 线程意外关闭时自动切回主线程，但用户主动退出（`pending_shutdown_exit_thread_id`）不触发转移
- **`attach_live_thread_for_selection` 的三级降级**：resume → thread/read(含 turns) → thread/read(不含 turns)，最后一级若无 turns 则报错而非创建空通道
- **回填去重**：`last_subagent_backfill_attempt` 确保每个主线程最多触发一次完整的子 agent 回填
- **终端标题闪烁**：`replace_chat_widget()` 转移 `last_terminal_title` 防止新 widget 重复写入同一标题导致闪烁
- **Turn steer 竞态**：`try_submit_active_thread_op_via_app_server` 在 `UserTurn` 处理中对 turn ID 不匹配允许最多一次重试，处理 review 流程中 turn 切换的时间窗口