# EventBus —— 内部消息总线

## 概述与职责

EventBus 是 TUI 层 **AppOrchestrator** 的内部消息总线，定义了 UI 组件与顶层 `App` 事件循环之间的全部通信协议。它由三个文件组成：

- **`AppEvent`**（入站事件枚举）：UI 组件通过它向 App 层发送请求——打开弹窗、持久化配置、提交操作、关闭应用等。
- **`AppCommand`**（出站命令包装）：将核心协议 `Op` 封装为带类型化 `view()` 判别器的 TUI 专用命令。
- **`AppEventSender`**（事件发射器）：基于 `tokio::sync::mpsc::UnboundedSender` 的便利封装，让深层 widget 无需直接访问 `App` 就能发送事件。

在整体架构中，EventBus 位于 **TUI > AppOrchestrator** 子系统内。TUI 驱动 Core 引擎运行 agent 会话，而 EventBus 是 TUI 内部各组件（ChatSurface、BottomPane、PickersAndStatus 等）与 AppOrchestrator 主循环之间的唯一通信管道。

## 关键流程

### 事件发射与消费流程

1. UI widget（如审批弹窗、模型选择器）通过持有的 `AppEventSender` 调用 `.send(event)` 发射 `AppEvent`
2. `AppEventSender::send()` 先调用 `session_log::log_inbound_app_event()` 记录事件（`CodexOp` 除外，避免重复日志），然后通过 `UnboundedSender` 将事件推入 channel（`app_event_sender.rs:29-37`）
3. App 主循环从 channel 的接收端取出 `AppEvent`，根据变体分发处理

### Op 命令提交流程

当 widget 需要向 Core 引擎发送协议操作时：

1. 调用 `AppCommand` 的工厂方法（如 `AppCommand::interrupt()`）构造命令
2. 通过 `.into_core()` 将 `AppCommand` 转为底层 `Op`
3. 包装为 `AppEvent::CodexOp(op)` 或 `AppEvent::SubmitThreadOp { thread_id, op }` 发送

`AppEventSender` 提供了快捷方法组合这两步，例如：

```rust
// app_event_sender.rs:40-42
pub(crate) fn interrupt(&self) {
    self.send(AppEvent::CodexOp(AppCommand::interrupt().into_core()));
}
```

### 多线程操作路由

部分操作需要发送到指定 thread 而非当前活跃 thread。这类操作使用 `AppEvent::SubmitThreadOp { thread_id, op }`：

```rust
// app_event_sender.rs:79-84
pub(crate) fn exec_approval(&self, thread_id: ThreadId, id: String, decision: ReviewDecision) {
    self.send(AppEvent::SubmitThreadOp {
        thread_id,
        op: AppCommand::exec_approval(id, None, decision).into_core(),
    });
}
```

这确保了审批、权限响应、MCP elicitation 等决策能准确投递到发起请求的 thread。

## 核心类型

### `AppEvent`（~70+ 变体）

`app_event.rs:80-570`

入站事件枚举，覆盖以下功能域：

| 功能域 | 典型变体 | 说明 |
|--------|----------|------|
| 会话控制 | `NewSession`, `ClearUi`, `ForkCurrentSession`, `OpenResumePicker` | 新建、清屏、分叉、恢复会话 |
| 退出 | `Exit(ExitMode)`, `FatalExitRequest(String)` | 正常退出（先 shutdown）或立即退出 |
| Agent 线程 | `OpenAgentPicker`, `SelectAgentThread(ThreadId)`, `SubmitThreadOp{..}` | 多 agent 线程切换和定向投递 |
| 协议操作 | `CodexOp(Op)` | 透传任意 `Op` 到 Core 引擎 |
| 文件搜索 | `StartFileSearch(String)`, `FileSearchResult{..}` | 异步文件搜索的请求/响应对 |
| 插件管理 | `FetchPluginsList`, `PluginsLoaded`, `FetchPluginInstall`, `PluginInstallLoaded` 等 | 插件列表、详情、安装、卸载的完整生命周期 |
| MCP | `FetchMcpInventory`, `McpInventoryLoaded{..}` | MCP 服务发现 |
| 模型选择 | `UpdateModel(String)`, `UpdateReasoningEffort(..)`, `PersistModelSelection{..}`, `OpenAllModelsPopup{..}` | 运行时切换模型和推理力度 |
| 审批策略 | `UpdateAskForApprovalPolicy(..)`, `UpdateSandboxPolicy(..)`, `OpenFullAccessConfirmation{..}` | 动态变更审批和沙箱策略 |
| Windows 沙箱 | `OpenWindowsSandboxEnablePrompt{..}`, `EnableWindowsSandboxForAgentMode{..}` 等 | Windows 专属沙箱启用/提权流程 |
| 反馈 | `OpenFeedbackNote{..}`, `SubmitFeedback{..}`, `FeedbackSubmitted{..}` | 用户反馈的采集和提交 |
| UI 状态 | `StatusLineSetup{..}`, `TerminalTitleSetup{..}`, `SyntaxThemeSelected{..}`, `LaunchExternalEditor` | 状态栏、终端标题、主题等 UI 配置 |
| 动画 | `StartCommitAnimation`, `StopCommitAnimation`, `CommitTick` | 提交动画的帧控制 |
| 技能管理 | `OpenSkillsList`, `SetSkillEnabled{..}`, `SetAppEnabled{..}` | 技能和应用的启用/禁用 |

### `ExitMode`

`app_event.rs:577-586`

```rust
pub(crate) enum ExitMode {
    ShutdownFirst,  // 先通知 Core 执行清理，再退出
    Immediate,      // 跳过 shutdown 立即退出（可能丢弃在途工作）
}
```

用户发起的退出应使用 `ShutdownFirst`；`Immediate` 仅作为 shutdown 已完成或需要强制退出时的后备手段。

### `FeedbackCategory`

`app_event.rs:588-595`

```rust
pub(crate) enum FeedbackCategory {
    BadResult, GoodResult, Bug, SafetyCheck, Other,
}
```

### `AppCommand`

`app_command.rs:27`

```rust
pub(crate) struct AppCommand(Op);
```

`AppCommand` 是 `Op` 的 newtype 包装。它的核心价值在于提供 **类型安全的工厂方法** 和 **`view()` 判别器**：

- **工厂方法**：如 `AppCommand::interrupt()`、`AppCommand::user_turn(..)`、`AppCommand::exec_approval(..)` 等，提供具名构造函数代替直接构造 `Op` 变体
- **`view()`**（`app_command.rs:286-396`）：返回 `AppCommandView` 借用枚举，使消费方可以通过 `match` 按命令类型分发处理，无需关心 `Op` 的内部结构
- **`into_core()`**：零成本转回底层 `Op`，用于提交给 Core 引擎

### `AppCommandView`

`app_command.rs:31-109`

`Op` 的借用视图枚举，字段全部为引用。主要变体包括：

- `Interrupt` / `Shutdown` / `Compact` —— 会话生命周期控制
- `UserTurn { items, cwd, approval_policy, model, effort, ... }` —— 用户消息提交（字段最多的变体）
- `OverrideTurnContext { .. }` —— 运行时覆盖 turn 级别的策略和配置
- `ExecApproval` / `PatchApproval` —— 工具调用审批决策
- `ResolveElicitation` —— MCP elicitation 响应
- `RealtimeConversation*` —— 实时语音会话系列
- `Review { review_request }` —— 代码审查
- `Other(&Op)` —— 兜底，匹配所有未显式列出的 `Op` 变体

### `AppEventSender`

`app_event_sender.rs:18-120`

```rust
pub(crate) struct AppEventSender {
    pub app_event_tx: UnboundedSender<AppEvent>,
}
```

轻量级 channel sender 封装，具有以下特点：

- **`Clone`**：可在 widget 树中自由传播
- **错误吞咽**：`send()` 在 channel 关闭时记录 `tracing::error!` 而非 panic，避免 shutdown 期间级联崩溃
- **会话日志**：自动调用 `session_log::log_inbound_app_event` 记录事件用于回放
- **快捷方法**：提供 `interrupt()`、`compact()`、`set_thread_name()`、`exec_approval()`、`patch_approval()`、`resolve_elicitation()` 等高频操作的便捷封装

## 类型转换

`AppCommand` 实现了与 `Op` 之间的双向 `From` 转换（`app_command.rs:399-421`）：

| 转换 | 方式 |
|------|------|
| `Op` → `AppCommand` | `From<Op>`, `From<&Op>`（clone） |
| `AppCommand` → `Op` | `From<AppCommand>`, `into_core()` |
| `&AppCommand` → `AppCommand` | `From<&AppCommand>`（clone） |

## 设计要点与注意事项

- **单一 channel 架构**：所有 UI 事件经由同一个 `UnboundedSender<AppEvent>` 汇聚到 App 主循环，简化了并发模型，但也意味着事件处理是串行的。
- **请求/响应配对**：异步操作（文件搜索、插件安装、限流刷新等）采用 "发起请求变体 + 结果回调变体" 的模式（如 `StartFileSearch` ↔ `FileSearchResult`），结果通过同一个 event channel 回送。
- **平台条件编译**：多个 Windows 沙箱相关变体标注了 `#[cfg_attr(not(target_os = "windows"), allow(dead_code))]`，录音相关变体标注了 `#[cfg(not(target_os = "linux"))]`，在非目标平台上编译但允许未使用。
- **`CodexOp` 与 `SubmitThreadOp` 的区别**：`CodexOp(Op)` 将操作提交到当前活跃 thread；`SubmitThreadOp { thread_id, op }` 显式指定目标 thread，用于审批等需要路由到特定 thread 的场景。
- **`AppCommandView` 的 `Other` 兜底**：`view()` 中未显式匹配的 `Op` 变体统一映射到 `Other(&Op)`，保证新增 `Op` 变体时不需要同步修改 `view()` 也能编译通过。