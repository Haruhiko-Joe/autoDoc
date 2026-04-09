# RunEntryAndSelectLoop — `run()` 入口与核心事件循环

## 概述与职责

`run()` 是 TUI 应用的**顶层异步入口函数**，定义在 `codex-rs/tui/src/app.rs:3549-3943`。它承担两大职责：

1. **启动引导（Bootstrap）**：创建通道、引导 app-server 会话、处理模型迁移提示、根据会话类型（新建/恢复/分叉）初始化 `ChatWidget`、构建完整的 `App` 结构体。
2. **核心事件循环**：进入 `tokio::select!` 主循环，同时多路复用四个事件源，驱动整个 TUI 的运行直到退出。

在系统层级中，该模块位于 **TUI → AppOrchestrator → AppCore → MainEventLoop** 路径下。`run()` 由上层的 `run_main()`（在 `lib.rs` 中）调用，是 onboarding 完成后进入交互式会话的唯一入口。同级模块包括 ServerEventAdapter（处理 app-server 事件转换）、PendingRequests（跟踪待解决的审批请求）、AgentNavigation（多 agent 导航）等。

## 函数签名

```rust
// codex-rs/tui/src/app.rs:3549
pub async fn run(
    tui: &mut tui::Tui,
    mut app_server: AppServerSession,
    mut config: Config,
    cli_kv_overrides: Vec<(String, TomlValue)>,
    harness_overrides: ConfigOverrides,
    active_profile: Option<String>,
    initial_prompt: Option<String>,
    initial_images: Vec<PathBuf>,
    session_selection: SessionSelection,
    feedback: codex_feedback::CodexFeedback,
    is_first_run: bool,
    should_prompt_windows_sandbox_nux_at_startup: bool,
    remote_app_server_url: Option<String>,
    remote_app_server_auth_token: Option<String>,
) -> Result<AppExitInfo>
```

### 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `tui` | `&mut tui::Tui` | 终端运行时实例，提供事件流和帧渲染 |
| `app_server` | `AppServerSession` | app-server 会话包装器，用于与后端通信 |
| `config` | `Config` | 完整的用户/项目配置 |
| `cli_kv_overrides` | `Vec<(String, TomlValue)>` | CLI 传入的键值配置覆盖 |
| `harness_overrides` | `ConfigOverrides` | 来自 harness 的配置覆盖（如额外可写根目录） |
| `active_profile` | `Option<String>` | 当前激活的配置 profile 名称 |
| `initial_prompt` | `Option<String>` | CLI 传入的初始提示词 |
| `initial_images` | `Vec<PathBuf>` | CLI 传入的初始图片路径 |
| `session_selection` | `SessionSelection` | 会话模式：`StartFresh`、`Resume`、`Fork` 或 `Exit` |
| `feedback` | `CodexFeedback` | 反馈提交客户端 |
| `is_first_run` | `bool` | 是否首次运行 |
| `should_prompt_windows_sandbox_nux_at_startup` | `bool` | Windows 上是否提示沙箱启用 |
| `remote_app_server_url` / `remote_app_server_auth_token` | `Option<String>` | 远程 app-server 连接信息 |

### 返回值

`Result<AppExitInfo>` — 包含 token 用量统计、线程 ID/名称、待执行的更新操作和退出原因。

## 关键流程 Walkthrough

### 阶段一：通道与 app-server 引导（3566-3623）

1. **创建事件通道**：通过 `unbounded_channel()` 创建 `AppEvent` 通道（`app_event_tx` / `app_event_rx`），并包装为 `AppEventSender`（`app.rs:3566-3567`）
2. **发送启动警告**：调用 `emit_project_config_warnings()` 和 `emit_system_bwrap_warning()` 将配置问题以 `HistoryCell` 形式推入事件队列（`app.rs:3568-3569`）
3. **标准化 harness 覆盖**：`normalize_harness_overrides_for_cwd()` 将相对路径的可写根目录转换为基于 cwd 的绝对路径（`app.rs:3572-3573`）
4. **Bootstrap app-server**：`app_server.bootstrap(&config)` 获取默认模型、可用模型列表、认证信息、速率限制快照等（`app.rs:3574-3576`）
5. **初始化遥测**：创建 `SessionTelemetry` 实例，记录模型、认证模式、来源等元数据（`app.rs:3612-3623`）

### 阶段二：模型迁移提示（3577-3605）

调用 `handle_model_migration_prompt_if_needed()`（`app.rs:833-936`）检查当前模型是否有可用升级。如果有：
- 渲染一个交互式 TUI 迁移提示屏幕
- 用户可选择接受（更新模型和推理力度配置）、拒绝、或退出
- 若用户选择退出，`run()` 立即关闭 app-server 并返回 `AppExitInfo`

迁移完成后，还会构建 `ModelCatalog`（`app.rs:3598-3605`），这是模型选择器和协作模式的数据源。

### 阶段三：会话初始化（3636-3749）

根据 `session_selection` 的三种模式创建 `ChatWidget` 和初始线程：

- **`StartFresh` / `Exit`**：调用 `app_server.start_thread()` 创建新线程，准备 startup tooltip（`app.rs:3639-3668`）
- **`Resume(target)`**：调用 `app_server.resume_thread()` 恢复已有会话（`app.rs:3670-3702`）
- **`Fork(target)`**：调用 `app_server.fork_thread()` 从已有会话分叉，并记录遥测事件（`app.rs:3704-3742`）

三种路径都通过 `ChatWidgetInit` 结构体传入相同的配置项（config、model catalog、feedback、telemetry 等），然后调用 `ChatWidget::new_with_app_event()` 构建聊天组件。

初始化完成后，还会应用启动时的速率限制快照并处理 Windows 沙箱提示（`app.rs:3745-3749`）。

### 阶段四：构建 App 结构体（3755-3798）

将所有初始化完成的组件组装进 `App` 结构体（`app.rs:3755-3794`），包括：
- 事件通道、ChatWidget、Config、文件搜索管理器
- 空的 `transcript_cells`、`thread_event_channels`、`agent_navigation` 等运行时状态
- `PendingAppServerRequests::default()` 用于跟踪待解决的审批/选举请求

然后调用 `enqueue_primary_thread_session()` 将初始线程的会话状态注册为主线程（`app.rs:3795-3798`），这会设置 `primary_thread_id`、`primary_session_configured`，并将初始 turns 作为历史事件回放。

### 阶段五：事件循环前的准备（3800-3860）

- **Windows 安全扫描**：在 Windows 上，如果沙箱启用且策略为 `WorkspaceWrite` 或 `ReadOnly`，异步扫描世界可写目录（`app.rs:3800-3829`）
- **获取 TUI 事件流**：`tui.event_stream()` 并 pin 住（`app.rs:3831-3832`）
- **请求首帧渲染**（`app.rs:3834`）
- **版本升级检查**（仅 release 构建）：检查是否有新版本，如有则插入 `UpdateAvailableHistoryCell`（`app.rs:3839-3859`）

### 阶段六：核心 `tokio::select!` 事件循环（3864-3918）

这是整个 TUI 的心脏。循环通过 `tokio::select!` 同时监听四个事件源：

```rust
// codex-rs/tui/src/app.rs:3865-3907
loop {
    let control = select! {
        // 1. AppEvent 内部事件通道
        Some(event) = app_event_rx.recv() => { ... }
        // 2. 当前活跃线程的事件通道
        active = async { ... }, if should_handle_active_thread_events(...) => { ... }
        // 3. TUI 终端事件流（键盘/鼠标/resize）
        Some(event) = tui_events.next() => { ... }
        // 4. App-server 推送事件
        app_server_event = app_server.next_event(), if listen_for_app_server_events => { ... }
    };
    // 检查是否应停止等待初始会话配置
    // 根据 AppRunControl 决定继续或退出
}
```

**四个事件源详解：**

| 事件源 | 类型 | 处理方法 | 说明 |
|--------|------|----------|------|
| `app_event_rx` | `AppEvent`（~80 种变体） | `handle_event()` | 内部事件总线：会话控制、文件搜索、模型选择、审批策略变更等 |
| `active_thread_rx` | `ThreadBufferedEvent` | `handle_active_thread_event()` | 当前活跃线程的通知/请求/历史条目，有条件启用 |
| `tui_events` | `TuiEvent`（键盘/鼠标/resize） | `handle_tui_event()` | 终端输入事件 |
| `app_server.next_event()` | `AppServerEvent` | `handle_app_server_event()` | app-server 推送的通知、请求和断连事件 |

`ThreadBufferedEvent` 是一个枚举（`app.rs:500-505`），包含四种变体：
- `Notification(ServerNotification)` — 服务端通知
- `Request(ServerRequest)` — 服务端请求（如审批）
- `HistoryEntryResponse(GetHistoryEntryResponseEvent)` — 历史条目查询响应
- `FeedbackSubmission(FeedbackThreadEvent)` — 反馈提交事件

每个事件源的处理结果返回 `AppRunControl::Continue` 或 `AppRunControl::Exit(reason)`，后者触发循环退出。

### 阶段七：关闭与清理（3920-3943）

循环退出后：
1. 调用 `app_server.shutdown()` 关闭 app-server 会话（`app.rs:3920-3922`）
2. 清空终端 `tui.terminal.clear()`（`app.rs:3923`）
3. 构建并返回 `AppExitInfo`，包含 token 用量、线程 ID/名称、待执行更新和退出原因（`app.rs:3936-3942`）

## 启动门控逻辑

三个纯函数控制事件循环在初始会话配置完成前的行为：

### `should_wait_for_initial_session(session_selection) -> bool`

```rust
// codex-rs/tui/src/app.rs:3527-3532
fn should_wait_for_initial_session(session_selection: &SessionSelection) -> bool {
    matches!(session_selection, SessionSelection::StartFresh | SessionSelection::Exit)
}
```

仅在全新会话启动时返回 `true`。Resume/Fork 场景下，线程已在调用 `start_thread` / `resume_thread` 时完成配置，无需等待。

### `should_handle_active_thread_events(waiting, has_rx) -> bool`

```rust
// codex-rs/tui/src/app.rs:3534-3539
fn should_handle_active_thread_events(
    waiting_for_initial_session_configured: bool,
    has_active_thread_receiver: bool,
) -> bool {
    has_active_thread_receiver && !waiting_for_initial_session_configured
}
```

作为 `select!` 的条件守卫：只有当存在活跃线程接收器 **且** 不再等待初始会话配置时，才处理线程事件。这避免了在会话尚未就绪时消费线程事件导致状态不一致。

### `should_stop_waiting_for_initial_session(waiting, primary_thread_id) -> bool`

```rust
// codex-rs/tui/src/app.rs:3541-3546
fn should_stop_waiting_for_initial_session(
    waiting_for_initial_session_configured: bool,
    primary_thread_id: Option<ThreadId>,
) -> bool {
    waiting_for_initial_session_configured && primary_thread_id.is_some()
}
```

在每次 `select!` 迭代末尾检查（`app.rs:3908-3913`）：一旦 `primary_thread_id` 被设置（通常在 `enqueue_primary_thread_session` 中），就将 `waiting_for_initial_session_configured` 置为 `false`，允许后续迭代处理线程事件。

## 关键类型定义

### `AppExitInfo`

```rust
// codex-rs/tui/src/app.rs:280-286
pub struct AppExitInfo {
    pub token_usage: TokenUsage,
    pub thread_id: Option<ThreadId>,
    pub thread_name: Option<String>,
    pub update_action: Option<UpdateAction>,
    pub exit_reason: ExitReason,
}
```

`run()` 的返回值结构。`update_action` 用于在退出后执行版本升级（如 `npm update`、`brew upgrade`）。

### `AppRunControl`

```rust
// codex-rs/tui/src/app.rs:300-304
pub(crate) enum AppRunControl {
    Continue,
    Exit(ExitReason),
}
```

事件处理方法的返回类型，控制主循环的继续或退出。

### `ExitReason`

```rust
// codex-rs/tui/src/app.rs:306-310
pub enum ExitReason {
    UserRequested,
    Fatal(String),
}
```

## 配置项与默认值

| 配置项 | 来源 | 说明 |
|--------|------|------|
| `config.tui_notification_method` | Config | 桌面通知方式，在启动时设置到 Tui |
| `config.model` | Config / 迁移 | 使用的模型标识符，可被迁移提示更新 |
| `config.show_tooltips` | Config | 是否显示启动 tooltip |
| `config.model_availability_nux` | Config | 模型可用性新手引导配置 |
| `THREAD_EVENT_CHANNEL_CAPACITY` | 常量 (32768) | 每个线程事件通道的容量上限 |

## 边界 Case 与注意事项

- **模型迁移可导致提前退出**：如果用户在迁移提示中选择退出，`run()` 会在进入事件循环之前就返回，此时会正确关闭 app-server（`app.rs:3586-3594`）
- **app-server 事件流关闭**：当 `app_server.next_event()` 返回 `None` 时，`listen_for_app_server_events` 被置为 `false`，该分支永久禁用，而非导致循环退出（`app.rs:3900-3903`）
- **活跃线程通道关闭**：当 `active_thread_rx.recv()` 返回 `None` 时，调用 `clear_active_thread()` 清理状态（`app.rs:3886-3888`）
- **Windows 特有逻辑**：世界可写目录扫描仅在 Windows 上、沙箱启用且策略合适时执行（`app.rs:3800-3829`）
- **Release 与 Debug 差异**：版本升级检查（`upgrade_version`）仅在 `#[cfg(not(debug_assertions))]` 下启用（`app.rs:3839-3859`）
- **错误处理与终端清理**：即使事件循环以错误退出，也会尝试清理终端（`app.rs:3924-3935`），终端清理失败仅记录警告不会覆盖原始错误