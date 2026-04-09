# App 结构体与基础类型

## 概述与职责

本模块是 TUI 应用的**基础类型层**，定义了核心 `App` 结构体及其约 30 个状态字段，以及一系列支撑类型和辅助函数。它位于 `TUI > AppOrchestrator > AppCore > MainEventLoop` 层级中，是整个 TUI 事件循环的数据基座——所有上层关注点（事件处理、线程管理、审批流程等）都依赖于此处定义的类型。

在整体架构中，TUI 模块通过调用 Core 来驱动代理会话，而 `App` 正是 TUI 侧持有会话状态的中枢。同级模块 `ServerEventAdapter`、`PendingRequests`、`InteractiveReplayTracking`、`AgentNavigation`、`LoadedThreadDiscovery` 都围绕 `App` 的字段进行操作。

代码位于 `codex-rs/tui/src/app.rs:165–1072`。

---

## 核心类型定义

### `App` 结构体

`App`（`app.rs:938–1005`）是整个 TUI 的状态容器，采用 `pub(crate)` 可见性。其字段可分为以下几组：

#### 配置与模型

| 字段 | 类型 | 说明 |
|------|------|------|
| `model_catalog` | `Arc<ModelCatalog>` | 可用模型列表，多处共享 |
| `config` | `Config` | 当前运行配置，重建 ChatWidget 时复用 |
| `active_profile` | `Option<String>` | 当前激活的配置 profile |
| `cli_kv_overrides` | `Vec<(String, TomlValue)>` | CLI 传入的键值配置覆盖 |
| `harness_overrides` | `ConfigOverrides` | harness 级别的配置覆盖 |
| `runtime_approval_policy_override` | `Option<AskForApproval>` | 运行时审批策略覆盖 |
| `runtime_sandbox_policy_override` | `Option<SandboxPolicy>` | 运行时沙箱策略覆盖 |

#### UI 与渲染状态

| 字段 | 类型 | 说明 |
|------|------|------|
| `chat_widget` | `ChatWidget` | 主聊天视图组件 |
| `transcript_cells` | `Vec<Arc<dyn HistoryCell>>` | 聊天记录的单元格序列 |
| `overlay` | `Option<Overlay>` | 分页器覆盖层（transcript/diff 预览） |
| `deferred_history_lines` | `Vec<Line<'static>>` | 延迟渲染的历史行 |
| `has_emitted_history_lines` | `bool` | 是否已输出历史行 |
| `enhanced_keys_supported` | `bool` | 终端是否支持增强键盘协议 |
| `commit_anim_running` | `Arc<AtomicBool>` | 流式输出动画线程的开关 |
| `status_line_invalid_items_warned` | `Arc<AtomicBool>` | 状态行配置错误是否已警告（跨 ChatWidget 共享） |
| `terminal_title_invalid_items_warned` | `Arc<AtomicBool>` | 终端标题配置错误是否已警告 |
| `file_search` | `FileSearchManager` | 文件搜索管理器 |

#### 回退（Backtracking）与反馈

| 字段 | 类型 | 说明 |
|------|------|------|
| `backtrack` | `BacktrackState` | Esc 键驱动的回退状态机 |
| `backtrack_render_pending` | `bool` | 回退确认后需重渲染 scrollback |
| `feedback` | `CodexFeedback` | 反馈系统句柄 |
| `feedback_audience` | `FeedbackAudience` | 反馈目标受众 |

#### 线程与多代理管理

| 字段 | 类型 | 说明 |
|------|------|------|
| `thread_event_channels` | `HashMap<ThreadId, ThreadEventChannel>` | 每线程的事件通道 |
| `thread_event_listener_tasks` | `HashMap<ThreadId, JoinHandle<()>>` | 每线程的监听任务 |
| `agent_navigation` | `AgentNavigationState` | 多代理选择器的导航状态 |
| `active_thread_id` | `Option<ThreadId>` | 当前活跃线程 |
| `active_thread_rx` | `Option<mpsc::Receiver<...>>` | 活跃线程的事件接收端 |
| `primary_thread_id` | `Option<ThreadId>` | 主线程 ID |
| `primary_session_configured` | `Option<ThreadSessionState>` | 主线程的会话配置 |
| `pending_primary_events` | `VecDeque<ThreadBufferedEvent>` | 主线程待处理事件队列 |
| `pending_app_server_requests` | `PendingAppServerRequests` | 待解决的 app-server 请求跟踪 |
| `last_subagent_backfill_attempt` | `Option<ThreadId>` | 上次尝试回填子代理的线程 |
| `pending_shutdown_exit_thread_id` | `Option<ThreadId>` | 正在关闭的线程 ID，防止误判为子代理异常 |

#### 会话与连接

| 字段 | 类型 | 说明 |
|------|------|------|
| `session_telemetry` | `SessionTelemetry` | 遥测数据 |
| `app_event_tx` | `AppEventSender` | 应用事件发送通道 |
| `remote_app_server_url` | `Option<String>` | 远程 app-server URL |
| `remote_app_server_auth_token` | `Option<String>` | 远程 app-server 认证 token |
| `pending_update_action` | `Option<UpdateAction>` | 用户确认的更新动作，退出时执行 |
| `windows_sandbox` | `WindowsSandboxState` | Windows 沙箱相关状态 |

---

### 线程事件存储体系

这三个类型构成了多线程事件缓冲和快照回放机制，是线程切换功能的核心数据结构。

#### `ThreadEventStore`（`app.rs:516–674`）

每线程的事件缓冲区，维护以下状态：
- `session`: 线程的会话状态 (`ThreadSessionState`)
- `turns`: 该线程的轮次历史 (`Vec<Turn>`)
- `buffer`: 有界环形事件队列 (`VecDeque<ThreadBufferedEvent>`)，超容量时淘汰最旧事件
- `pending_interactive_replay`: 交互式回放过滤状态
- `active_turn_id`: 当前活跃轮次，根据 `TurnStarted`/`TurnCompleted` 自动维护
- `capacity`: 缓冲区上限（默认 `THREAD_EVENT_CHANNEL_CAPACITY = 32768`）
- `active`: 是否激活

关键方法：
- **`push_notification()`**（`app.rs:577–603`）：将通知压入 buffer，同步更新 `active_turn_id` 和 `pending_interactive_replay`。若 buffer 溢出则淘汰队首事件。
- **`push_request()`**（`app.rs:605–616`）：类似地处理 `ServerRequest`。
- **`snapshot()`**（`app.rs:625–646`）：生成 `ThreadEventSnapshot`，其中 **仅保留尚未解决的交互式请求**——这是线程切换回放时过滤已回答审批的关键。
- **`apply_thread_rollback()`**（`app.rs:618–623`）：回退操作后清空 buffer 并重置 replay 状态。
- **`event_survives_session_refresh()`**：仅 `Request`、`HookStarted`、`HookCompleted` 和 `FeedbackSubmission` 在会话刷新后保留。

#### `ThreadEventChannel`（`app.rs:676–704`）

将 `ThreadEventStore` 与 tokio mpsc 通道组合：
- `sender`: 事件发送端
- `receiver`: 事件接收端（使用 `Option` 以支持 `take()` 语义）
- `store`: `Arc<Mutex<ThreadEventStore>>` 共享存储

#### `ThreadEventSnapshot`（`app.rs:491–497`）

线程切换时的不可变快照：
- `session`: 克隆的 `ThreadSessionState`
- `turns`: 轮次历史副本
- `events`: 经过 replay 过滤后的缓冲事件
- `input_state`: 用户输入框状态

#### `ThreadBufferedEvent`（`app.rs:499–505`）

缓冲区中的事件枚举，四种变体：
- `Notification(ServerNotification)` — 服务端通知
- `Request(ServerRequest)` — 服务端请求（审批/输入）
- `HistoryEntryResponse(GetHistoryEntryResponseEvent)` — 历史条目响应
- `FeedbackSubmission(FeedbackThreadEvent)` — 反馈提交

---

### 退出与控制流类型

#### `AppExitInfo`（`app.rs:280–298`）

应用退出时返回的信息包：
- `token_usage`: 本次会话的 token 消耗
- `thread_id` / `thread_name`: 可用于生成 resume 命令
- `update_action`: 退出后需执行的更新操作
- `exit_reason`: 退出原因

提供 `fatal()` 构造函数创建致命错误退出信息。

#### `AppRunControl`（`app.rs:300–304`）

事件循环的控制信号：`Continue` 继续或 `Exit(ExitReason)` 退出。

#### `ExitReason`（`app.rs:306–310`）

两种退出原因：`UserRequested`（用户主动退出）和 `Fatal(String)`（致命错误）。

#### `SessionSummary`（`app.rs:485–489`）

会话结束时的摘要，包含 `usage_line`（token 消耗文本）和 `resume_command`（恢复会话的命令）。

---

### Guardian 审批模式

#### `GuardianApprovalsMode`（`app.rs:255–260`）

Guardian 审批实验的配置三元组：
- `approval_policy`: `AskForApproval` — 审批策略
- `approvals_reviewer`: `ApprovalsReviewer` — 审批审核者
- `sandbox_policy`: `SandboxPolicy` — 沙箱策略

#### `guardian_approvals_mode()`（`app.rs:266–272`）

返回 Guardian 实验的默认配置：`OnRequest` 策略 + `GuardianSubagent` 审核者 + workspace-write 沙箱策略。

---

### `ActiveTurnSteerRace`（`app.rs:1043–1047`）

处理 `turn/steer` 请求竞态条件的枚举：
- `Missing` — 服务端无活跃轮次
- `ExpectedTurnMismatch { actual_turn_id }` — 客户端缓存的轮次 ID 与服务端不一致

---

### `WindowsSandboxState`（`app.rs:1007–1012`）

Windows 平台的沙箱设置状态：
- `setup_started_at`: 沙箱初始化开始时间
- `skip_world_writable_scan_once`: 用户确认后跳过一次全局可写扫描

---

## 辅助函数

### 协议转换函数

#### `app_server_request_id_to_mcp_request_id()`（`app.rs:173–184`）

将 `codex_app_server_protocol::RequestId`（String/Integer 变体）转换为 `codex_protocol::mcp::RequestId`。

#### `command_execution_decision_to_review_decision()`（`app.rs:186–213`）

将 app-server 协议的 `CommandExecutionApprovalDecision` 映射为核心协议的 `ReviewDecision`：

| App-Server 决策 | Core 决策 |
|---|---|
| `Accept` | `Approved` |
| `AcceptForSession` | `ApprovedForSession` |
| `AcceptWithExecpolicyAmendment` | `ApprovedExecpolicyAmendment` |
| `ApplyNetworkPolicyAmendment` | `NetworkPolicyAmendment` |
| `Decline` | `Denied` |
| `Cancel` | `Abort` |

#### `list_skills_response_to_core()`（`app.rs:338–407`）

将 `SkillsListResponse`（app-server 协议）深度转换为 `ListSkillsResponseEvent`（core 协议），逐层映射 skills、interface、dependencies、scope 和 errors。

### 线程与事件辅助

#### `collab_receiver_thread_ids()`（`app.rs:219–237`）

从 `ServerNotification` 中提取协作代理工具调用的接收者线程 ID 列表。仅 `ItemStarted` 和 `ItemCompleted` 且 item 类型为 `CollabAgentToolCall` 时返回 `Some`。

#### `default_exec_approval_decisions()`（`app.rs:239–253`）

委托给 `ExecApprovalRequestEvent::default_available_decisions()` 生成默认审批决策选项列表，入参包括网络审批上下文、execpolicy 修正提案、网络策略修正提案和附加权限。

### 会话管理辅助

#### `session_summary()`（`app.rs:312–327`）

若 token 用量非零，生成 `SessionSummary`（含用量文本和 resume 命令）；否则返回 `None`。

#### `errors_for_cwd()`（`app.rs:329–336`）

在 skills 列表响应中查找当前工作目录对应的错误信息。

#### `emit_skill_load_warnings()`（`app.rs:409–428`）

将 skill 加载错误插入为历史告警单元格。

#### `emit_project_config_warnings()`（`app.rs:430–471`）

扫描配置层级栈，将被禁用的 project config.toml 文件夹和原因输出为告警。

#### `emit_system_bwrap_warning()`（`app.rs:473–483`）

如果当前沙箱策略存在 bwrap 系统警告，插入告警单元格。

### 模型迁移辅助

#### `should_show_model_migration_prompt()`（`app.rs:706–744`）

判断是否需要展示模型迁移提示，条件包括：目标模型不等于当前模型、用户未曾确认过该迁移、目标模型在 picker 中可见、且当前模型存在 upgrade 配置。

#### `migration_prompt_hidden()`（`app.rs:746–757`）

检查特定迁移提示是否已被用户在配置中隐藏。

#### `target_preset_for_upgrade()`（`app.rs:759–766`）

从可用模型列表中查找目标升级模型的 `ModelPreset`。

#### `select_model_availability_nux()`（`app.rs:776–792`）

遍历模型列表，找到首个未超过展示上限（`MODEL_AVAILABILITY_NUX_MAX_SHOW_COUNT = 4`）的可用性 NUX 提示。

#### `handle_model_migration_prompt_if_needed()`（`app.rs:833–936`）

异步函数。检查当前模型是否有升级路径，若有则渲染交互式迁移提示。根据用户选择更新配置和模型，或返回 `AppExitInfo` 表示退出。支持推理强度（reasoning effort）映射。

### 配置覆盖规范化

#### `normalize_harness_overrides_for_cwd()`（`app.rs:1014–1029`）

将 `ConfigOverrides.additional_writable_roots` 中的相对路径解析为基于给定 `base_cwd` 的绝对路径。

### Steer 竞态检测

#### `active_turn_not_steerable_turn_error()`（`app.rs:1031–1041`）

从 `TypedRequestError` 中解析 `ActiveTurnNotSteerable` 错误。

#### `active_turn_steer_race()`（`app.rs:1049–1072`）

检测 `turn/steer` 请求的竞态：解析 "no active turn" 和 "expected active turn id ... but found ..." 两种错误消息，返回对应的 `ActiveTurnSteerRace` 变体。服务端返回实际 turn ID 后，客户端可据此重试。

---

## 关键流程 Walkthrough

### 线程事件缓冲与切换回放

1. app-server 发送 `ServerNotification` 或 `ServerRequest` 到对应线程的 `ThreadEventChannel`
2. `ThreadEventStore::push_notification()` / `push_request()` 将事件压入 `buffer`，同步更新 `active_turn_id` 和 `pending_interactive_replay` 状态
3. 缓冲区溢出时自动淘汰队首事件，并通知 replay 状态清理已淘汰的交互式请求
4. 线程切换时调用 `ThreadEventStore::snapshot()` 生成快照——**已回答的审批/输入请求被过滤掉**，避免切换后重复展示
5. 快照中的事件被回放到新的 `ChatWidget` 中，用户看到该线程的完整上下文

### 模型迁移决策链

1. `handle_model_migration_prompt_if_needed()` 查找当前模型的 `ModelUpgrade`
2. 检查 `migration_prompt_hidden()` 是否已隐藏
3. 调用 `should_show_model_migration_prompt()` 验证迁移条件
4. 查找 `target_preset_for_upgrade()` 获取目标模型信息
5. 调用 `migration_copy_for_models()` 生成提示文案
6. 渲染交互式迁移提示，根据用户选择（接受/拒绝/退出）更新配置

---

## 边界 Case 与注意事项

- **`ThreadEventStore` 容量上限**为 `THREAD_EVENT_CHANNEL_CAPACITY = 32768`，超出时**静默丢弃最旧事件**。被丢弃的交互式请求会从 `pending_interactive_replay` 中清除，但不会通知用户。
- **`pending_shutdown_exit_thread_id`** 是 `Option<ThreadId>` 而非 `bool`——这确保只有用户主动关闭的特定线程的 `ShutdownComplete` 触发退出，其他线程的关闭仍走正常的故障转移路径。
- **`WindowsSandboxState`** 仅在 Windows 平台有意义，但结构体本身跨平台定义（使用 `#[derive(Default)]`），条件编译仅在相关事件处理代码中。
- **`event_survives_session_refresh()`** 故意保留 `Request` 和 hook 事件——会话刷新不应丢失用户待处理的审批请求。
- **`active_turn_steer_race()`** 通过解析错误消息字符串来提取实际 turn ID，这种耦合方式意味着服务端错误格式变更可能导致 silent fallback（返回 `None`）。