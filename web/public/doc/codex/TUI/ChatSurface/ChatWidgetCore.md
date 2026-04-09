# ChatWidgetCore

## 概述与职责

`ChatWidget` 是 Codex TUI 的**核心聊天视口组件**，位于 `codex-rs/tui/src/chatwidget.rs`，约 11,000 行代码。它是 TUI 层级中 **ChatSurface** 的主要实现，由上层 **AppOrchestrator** 拥有并驱动，向下组合了 **BottomPane**（输入/弹窗区）和 **ContentRendering**（流式转录管线）。

在整体架构中，`ChatWidget` 充当**协议事件到 UI 状态的翻译层**：它从 agent 会话（通过 app-server 或直连 codex-core）接收协议事件，将它们转化为可渲染的转录单元（`HistoryCell`），同时将用户输入转化为协议操作（`Op` / `AppCommand`）发回给 agent。

它**不负责**运行 agent 本身——只是反映 agent 的进度，并在需要时发出请求。

同级模块包括 **BottomPane**（交互式底部区域）、**ContentRendering**（内容渲染管线）、**TerminalRuntime**（终端基础设施）等。父级为 **TUI**，TUI 被 **CLI** 调用以提供交互式体验。

## 关键流程

### 1. 构造与初始化

构造通过 `ChatWidgetInit` 参数结构完成，有两个入口：

- `new_with_app_event(common)` — 生产环境使用，通过 `AppEvent` 通道发送操作（`chatwidget.rs:4537-4538`）
- `new_with_op_sender(common, codex_op_tx)` — 测试环境使用，直接发送 `Op`（`chatwidget.rs:4542-4546`）

两者都调用内部 `new_with_op_target()`（`chatwidget.rs:4549-4753`），该方法：

1. 从 `ChatWidgetInit` 解构出 config、model_catalog、initial_user_message 等
2. 初始化 `BottomPane`（带从 `PLACEHOLDERS` 数组随机选取的 placeholder 文本）
3. 设置协作模式（collaboration mode）初始状态，默认为 `ModeKind::Default`
4. 创建一个占位 session header 作为初始 `active_cell`
5. 初始化流控制器、中断管理器、rate limit 追踪等数十个状态字段
6. 同步终端特性检测（realtime 对话、status line、快捷键绑定等）

### 2. 会话配置（SessionConfigured）

当 app-server 或 core 发送 `SessionConfigured` 事件时，`on_session_configured()`（`chatwidget.rs:1934-2031`）执行：

1. 将 thread_id、model、cwd、approval_policy、sandbox_policy 等同步到本地状态
2. 创建 session info 历史单元（包含欢迎横幅）并插入转录
3. 请求技能列表刷新（`list_skills`）
4. 如果有 `initial_user_message` 且未被抑制，立即提交给 agent
5. 如果是 fork 线程，异步查找并显示来源线程名称（`emit_forked_thread_event`）
6. 如果开启了 connectors，触发预取

### 3. 协议事件处理

ChatWidget 有三个主要的事件入口，分别处理不同来源的事件：

#### handle_server_notification

`handle_server_notification(notification, replay_kind)`（`chatwidget.rs:6278-6525`）处理 app-server 通知，核心分支包括：

- `TurnStarted` → 调用 `on_task_started()`，设置 spinner、重置推理缓冲区、清除退出快捷键
- `AgentMessageDelta` → 调用 `on_agent_message_delta(delta)`，驱动流式输出
- `PlanDelta` → 驱动 Plan 模式的流式输出
- `ReasoningSummaryTextDelta` → 更新推理 header 状态指示器（提取 `**bold**` 文本作为标题）
- `ItemStarted` / `ItemCompleted` → 分发到 exec/patch/MCP/web-search/collab-agent 等子处理器
- `TurnCompleted` → 根据 status（Completed/Interrupted/Failed）分别调用 `on_task_complete` / `on_interrupted_turn` / `handle_non_retry_error`
- `Error` → 区分 retry 错误（调用 `on_stream_error`）和 non-retry 错误（检查 rate limit、steer 拒绝等）
- `McpServerStatusUpdated` → 追踪 MCP 服务器启动进度
- `ThreadRealtimeStarted/Closed` → 管理 realtime 语音会话 UI

#### handle_server_request

`handle_server_request(request, replay_kind)`（`chatwidget.rs:6239-6276`）处理需要用户审批的请求：

- `CommandExecutionRequestApproval` → 转换参数后触发 exec 审批弹窗
- `FileChangeRequestApproval` → patch 审批弹窗
- `McpServerElicitationRequest` → MCP 表单/URL 弹窗
- `PermissionsRequestApproval` → 权限请求弹窗
- `ToolRequestUserInput` → 用户输入表单

#### handle_codex_event

`handle_codex_event(event)`（`chatwidget.rs:6769`，仅 `#[cfg(test)]`）—— 测试环境直接处理 core 事件，内部调用 `dispatch_event_msg()`（`chatwidget.rs:6789`）进行大规模 match 分发，覆盖约 50 种 `EventMsg` 变体。

### 4. 流式输出生命周期（StreamController）

流式 LLM 输出通过以下流程渲染：

1. **Delta 到达**：`handle_streaming_delta(delta)`（`chatwidget.rs:4133-4169`）
   - 刷新正在进行的 exec 等待分组（`flush_unified_exec_wait_streak`）
   - 刷新活跃单元（`flush_active_cell`）
   - 如果尚未创建，实例化 `StreamController`（宽度减 2 用于边距）
   - 将 delta 推入 controller；如果产生了新行，触发 `AppEvent::StartCommitAnimation` 并执行 `run_catch_up_commit_tick()`
   - 在首次 delta 到达时，检查是否需要插入"Worked for …"分隔符

2. **Commit Tick**：`run_commit_tick_with_scope(scope)`（`chatwidget.rs:4077-4099`）
   - 调用 `streaming::commit_tick::run_commit_tick()`，传入 `AdaptiveChunkingPolicy`
   - 产出的 cells 隐藏 status indicator 后插入历史
   - 当所有控制器空闲时，恢复 status indicator 并发送 `AppEvent::StopCommitAnimation`

3. **流结束**：`handle_stream_finished()`（`chatwidget.rs:4123-4130`）
   - 清除 `task_complete_pending` 标记
   - 刷新中断队列（`flush_interrupt_queue`）—— 之前因写入周期被延迟的审批等事件

`AdaptiveChunkingPolicy` 控制 commit 节奏——在内容密集时加速提交，在稀疏时减速。Plan 模式有独立的 `PlanStreamController`，通过 `on_plan_delta()` 驱动。

### 5. 键盘输入路由

`handle_key_event(key_event)`（`chatwidget.rs:4755-4925`）是键盘事件的主入口：

| 按键 | 行为 |
|------|------|
| Ctrl+C | `on_ctrl_c()`：中断 agent / 停止 realtime / 双击退出 |
| Ctrl+D | `on_ctrl_d()`：空 composer 时退出 |
| Ctrl+V / Alt+V | 粘贴图片到 composer |
| Esc（有 pending steers） | 中断当前 turn 并重新提交 steers |
| Shift+Tab（无任务） | 切换协作模式（`cycle_collaboration_mode`） |
| Alt+Up / Shift+Left | 弹出最近排队消息回 composer（终端相关） |
| 其他 | 委托给 `BottomPane.handle_key_event()` |

`BottomPane` 返回的 `InputResult` 决定后续动作：
- `Submitted { text, text_elements }` → 构造 `UserMessage`，判断是直接提交还是入队
- `Queued { text, text_elements }` → 消息入队等待
- `Command(cmd)` → 分发斜杠命令（`dispatch_command`）
- `CommandWithArgs(cmd, args, text_elements)` → 带参数的斜杠命令

### 6. 用户消息提交

`submit_user_message(user_message)`（`chatwidget.rs:5567-5846`）是消息发送的核心：

1. 检查会话是否已配置，未配置则入队
2. 特殊处理 `!cmd` 前缀——本地 shell 命令，通过 `AppCommand::run_user_shell_command` 执行
3. 构建 `UserInput` 列表：远程图片 → 本地图片 → 文本
4. 收集 `@mention` 绑定：调用 `collect_tool_mentions()` 解析 `$name` 语法，匹配 skills、plugins、connectors
5. 构造 `AppCommand::user_turn()`，附带当前协作模式、审批策略、sandbox 策略、model、reasoning effort 等
6. 通过 `submit_op()` 发送
7. 将消息文本编码 mention 后存入跨 session 历史（`Op::AddToHistory`）
8. 如果是新 turn（非 steer），渲染用户消息到历史

当 agent turn 正在进行时，提交变为 **steer**（`pending_steers` 队列），UI 显示为待发送预览。如果 steer 被拒绝（`ActiveTurnNotSteerable`），消息会进入 `rejected_steers_queue` 等待下一个 turn 自动重发。

### 7. 技能集成（Skills）

技能相关逻辑位于子模块 `chatwidget/skills.rs`，通过 `ChatWidget` 的 `impl` 扩展提供：

- `open_skills_list()`（`chatwidget/skills.rs:27-29`）：插入 `$` 字符触发 mention 补全
- `open_skills_menu()`（`chatwidget/skills.rs:31-60`）：打开技能管理弹窗，提供"List skills"和"Enable/Disable Skills"选项
- `open_manage_skills_popup()`（`chatwidget/skills.rs:62-95`）：显示 `SkillsToggleView`，允许用户启用/禁用技能
- `update_skill_enabled(path, enabled)`（`chatwidget/skills.rs:97-105`）：更新技能启用状态并刷新 mention 数据源
- `set_skills_from_response(response)`（`chatwidget/skills.rs:140-144`）：从 `ListSkillsResponseEvent` 更新技能列表，按 cwd 过滤

**Mention 解析流程**（`chatwidget/skills.rs:203-360`）：

1. `collect_tool_mentions(text, mention_paths)` 扫描用户输入文本
2. `extract_tool_mentions_from_text_with_sigil()` 识别 `$name` 和 `[$name](path)` 两种语法
3. 过滤常见环境变量名（`$PATH`、`$HOME` 等，见 `is_common_env_var`）
4. `find_skill_mentions_with_tool_mentions()` 将解析结果与已知 skills 匹配——先按路径匹配，再按名称匹配
5. `find_app_mentions()` 匹配 connectors/apps，使用 `connector_mention_slug` 生成 slug，处理重名冲突（仅在唯一时匹配）

### 8. 转录管理

- `add_to_history(cell)` → `add_boxed_history(cell)`（`chatwidget.rs:5537-5556`）：刷新活跃单元后通过 `AppEvent::InsertHistoryCell` 插入。会跳过空行单元以避免打断 exec 分组
- `replay_thread_turns(turns, replay_kind)`（`chatwidget.rs:5883-5916`）：恢复已有会话的转录，逐 turn 重放 items，支持 `ResumeInitialMessages` 和 `ThreadSnapshot` 两种重放模式
- `active_cell`：当前正在构建的单元（exec 分组或 session header 占位符）
- `active_cell_revision`：单调递增计数器，用于 transcript overlay 的缓存失效

### 9. 审批弹窗处理

审批事件通过 `defer_or_handle()` 机制（`chatwidget.rs:4108-4121`）实现中断安全：

- 如果有活跃的 `StreamController` 或中断队列非空 → 事件入队到 `InterruptManager`
- 否则立即处理

这保证了 FIFO 顺序——一旦有事件入队，后续事件也必须入队，直到队列完全刷新。

支持的审批类型：
- **Exec 审批**：命令执行确认，包含 `parsed_cmd`、`network_approval_context`、`proposed_execpolicy_amendment` 等丰富参数
- **Patch 审批**：文件变更确认，包含 `changes`（路径到 `FileChange` 映射）和 `grant_root`
- **MCP Elicitation**：支持 Form（JSON schema 驱动）和 URL（OAuth 风格）两种类型
- **权限请求**：扩展权限确认
- **Guardian 审查**：安全审查状态追踪，支持并行审查聚合（`PendingGuardianReviewStatus`）

### 10. 退出/中断行为

退出逻辑跨越 `ChatWidget` 和 `BottomPane` 两层：

- **双击退出**（`DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED`）：首次 Ctrl+C/D "armed"（`arm_quit_shortcut`，`chatwidget.rs:10283-10289`），需在 `QUIT_SHORTCUT_TIMEOUT` 内第二次按**同一键**才退出。Ctrl+C 后按 Ctrl+D 不会退出
- **Ctrl+C**（`on_ctrl_c`，`chatwidget.rs:10193-10237`）：
  1. 如果 realtime 对话活跃 → 停止对话
  2. 如果 BottomPane 消费了事件 → arm 退出快捷键（除非关闭了弹窗）
  3. 如果有可取消的工作 → 发送 `AppCommand::interrupt()`
  4. 否则 → 直接退出
- **Ctrl+D**（`on_ctrl_d`，`chatwidget.rs:10243-10268`）：仅在 composer 为空且无弹窗时参与退出流程

### 11. 渲染（Renderable trait）

`ChatWidget` 实现 `Renderable` trait（`chatwidget.rs:10833-10846`），通过 `as_renderable()`（`chatwidget.rs:10781-10798`）组合布局：

```
┌──────────────────────────────────┐
│  active_cell（flex: 1, 顶部 1 行间距） │  ← 当前转录/session header
├──────────────────────────────────┤
│  bottom_pane（flex: 0, 顶部 1 行间距） │  ← 输入框/弹窗/状态
└──────────────────────────────────┘
```

使用 `FlexRenderable`：active_cell 占据剩余空间（flex=1），bottom_pane 固定高度（flex=0）。渲染后记录 `last_rendered_width` 用于流控制器初始化时的宽度计算。

`impl Drop`（`chatwidget.rs:10826-10831`）在 widget 销毁时重置 realtime 对话状态并停止 rate limit 轮询器。

## 函数签名与参数说明

### 构造

#### `new_with_app_event(common: ChatWidgetInit) -> Self`

生产环境构造函数。操作通过 `AppEvent` 通道发送。

#### `new_with_op_sender(common: ChatWidgetInit, codex_op_tx: UnboundedSender<Op>) -> Self`

测试环境构造函数。操作直接发送到 `codex_op_tx`。

### 事件处理

#### `handle_key_event(&mut self, key_event: KeyEvent)`

键盘事件主入口。处理 Ctrl+C/D/V、Esc、Shift+Tab 等全局快捷键，其余委托给 BottomPane。

#### `handle_server_notification(&mut self, notification: ServerNotification, replay_kind: Option<ReplayKind>)`

处理 app-server 通知。`replay_kind` 为 `Some` 时表示重放事件，部分副作用被抑制。

#### `handle_server_request(&mut self, request: ServerRequest, replay_kind: Option<ReplayKind>)`

处理需要用户审批的 app-server 请求。

#### `submit_user_message(&mut self, user_message: UserMessage)`

构建并提交用户消息到 agent。处理 `!cmd` shell 命令、图片附件、mention 绑定、协作模式等。

### 转录管理

#### `add_to_history(&mut self, cell: impl HistoryCell + 'static)`

插入一个历史单元到转录。会先刷新活跃单元。

#### `replay_thread_turns(&mut self, turns: Vec<Turn>, replay_kind: ReplayKind)`

重放已有会话的 turn 列表以恢复转录。支持 `ResumeInitialMessages`（恢复初始消息）和 `ThreadSnapshot`（线程快照）两种模式。

### 状态管理

#### `set_token_info(&mut self, info: Option<TokenUsageInfo>)`

更新 token 使用量信息并刷新 context window 显示。

#### `on_rate_limit_snapshot(&mut self, snapshot: Option<RateLimitSnapshot>)`

处理 rate limit 快照更新。触发阈值警告、模型切换建议等。

## 接口/类型定义

### `ChatWidgetInit`

> `chatwidget.rs:548-568`

| 字段 | 类型 | 说明 |
|------|------|------|
| `config` | `Config` | 用户/项目配置 |
| `frame_requester` | `FrameRequester` | 请求 UI 重绘 |
| `app_event_tx` | `AppEventSender` | 应用事件发送器 |
| `initial_user_message` | `Option<UserMessage>` | CLI 传入的初始消息 |
| `model_catalog` | `Arc<ModelCatalog>` | 可用模型目录 |
| `model` | `Option<String>` | 模型覆盖 |
| `has_chatgpt_account` | `bool` | 是否有 ChatGPT 账号 |
| `is_first_run` | `bool` | 是否首次运行（控制欢迎横幅） |
| `session_telemetry` | `SessionTelemetry` | 遥测会话句柄 |

### `UserMessage`

> `chatwidget.rs:1002-1014`

| 字段 | 类型 | 说明 |
|------|------|------|
| `text` | `String` | 消息文本 |
| `local_images` | `Vec<LocalImageAttachment>` | 本地图片附件（带 placeholder） |
| `remote_image_urls` | `Vec<String>` | 远程图片 URL（如 data URL） |
| `text_elements` | `Vec<TextElement>` | 富文本元素（带 byte range） |
| `mention_bindings` | `Vec<MentionBinding>` | 已解析的 @mention 绑定 |

### `CodexOpTarget`

> `chatwidget.rs:973-976`

```rust
enum CodexOpTarget {
    Direct(UnboundedSender<Op>),  // 直接发送 core 操作（测试用）
    AppEvent,                      // 通过 AppEvent 通道发送（生产用）
}
```

### `ActiveCellTranscriptKey`

> `chatwidget.rs:982-1000`

用于 transcript overlay 缓存失效的复合键，包含 `revision`（修订号）、`is_stream_continuation`（是否续流）、`animation_tick`（动画帧号，用于 shimmer/spinner）。

### `ToolMentions`

> `chatwidget/skills.rs:294-297`

```rust
pub(crate) struct ToolMentions {
    names: HashSet<String>,           // 解析出的 mention 名称
    linked_paths: HashMap<String, String>,  // 名称到路径的映射
}
```

## 配置项与默认值

| 常量/配置 | 值 | 说明 |
|-----------|-----|------|
| `RATE_LIMIT_WARNING_THRESHOLDS` | `[75.0, 90.0, 95.0]` | rate limit 告警百分比阈值 |
| `RATE_LIMIT_SWITCH_PROMPT_THRESHOLD` | `90.0` | 触发模型切换建议的阈值 |
| `NUDGE_MODEL_SLUG` | `"gpt-5.1-codex-mini"` | 切换建议的目标模型 |
| `DEFAULT_STATUS_LINE_ITEMS` | `["model-with-reasoning", "context-remaining", "current-dir"]` | 默认 status line 项 |
| `DEFAULT_MODEL_DISPLAY_NAME` | `"loading"` | session 配置前显示的模型名 |
| `PLACEHOLDERS` | 8 个提示语 | 随机选取的 composer placeholder |
| `AGENT_NOTIFICATION_PREVIEW_GRAPHEMES` | `200` | 通知预览最大字素数 |

## 边界 Case 与注意事项

- **中断安全**：流式写入期间到达的审批事件被 `InterruptManager` 缓冲，在流结束后 FIFO 刷新，防止事件乱序（如 ExecEnd 先于 ExecBegin 到达用户）
- **Steer 拒绝恢复**：当 agent 拒绝 steer（`ActiveTurnNotSteerable`），消息进入 `rejected_steers_queue`。下个 turn 开始时，rejected steers 会被合并为一条消息自动重发
- **MCP 启动轮次管理**：完成一轮启动后进入"忽略模式"（`mcp_startup_ignore_updates_until_next_start`），缓冲后续更新直到确认为新一轮（所有预期服务器都报告了更新），防止过时事件重新激活启动状态
- **Terminal 兼容性**：队列消息编辑快捷键根据终端类型自适应——Apple Terminal、Warp、VSCode 集成终端和 tmux 使用 `Shift+Left`（这些终端会拦截 Alt+Up），其他使用 `Alt+Up`（`queued_message_edit_binding_for_terminal`，`chatwidget.rs:267-291`）
- **`#[cfg(test)]` 条件编译**：`handle_codex_event` 和 `dispatch_event_msg` 仅在测试中可用；生产环境通过 `handle_server_notification` / `handle_server_request` 接收事件
- **Mention 解析防误触**：`is_common_env_var()` 过滤 `$PATH`、`$HOME` 等常见环境变量名，避免误识别为 skill mention（`chatwidget/skills.rs:419-435`）
- **Plan 模式自动提示**：当 Plan 模式下 agent 产出了 plan item 且无排队消息、无活跃弹窗时，turn 完成后自动弹出"Implement this plan?"选择框（`maybe_prompt_plan_implementation`，`chatwidget.rs:2376-2401`）
- **图片支持检查**：提交带图片的消息前会检查当前模型是否支持 image input，不支持时保留 composer 内容并显示警告，方便用户切换模型后重试（`restore_blocked_image_submission`，`chatwidget.rs:5855-5876`）