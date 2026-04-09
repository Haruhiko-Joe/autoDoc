# AppEventDispatch — 事件分发主入口

## 概述与职责

`handle_event()` 是 TUI 应用状态机 `App` 的**核心事件分发方法**，位于 `codex-rs/tui/src/app.rs:4007–5526`，约 1520 行。它接收来自内部消息总线的 `AppEvent` 枚举（定义在 `app_event.rs`），通过一个巨型 `match` 表达式将约 80 个事件变体路由到相应的处理逻辑。

在整体架构中，该方法位于 **TUI → AppOrchestrator → AppCore → MainEventLoop** 层级的最底层。`App::run()` 的 `select!` 循环从事件通道接收 `AppEvent`，然后调用 `handle_event()` 完成实际的状态变更、UI 更新和异步 RPC 调用。

### 方法签名

```rust
async fn handle_event(
    &mut self,
    tui: &mut tui::Tui,
    app_server: &mut AppServerSession,
    event: AppEvent,
) -> Result<AppRunControl>
```

- `tui`：终端渲染层，用于屏幕切换、帧刷新、历史行插入
- `app_server`：对 app-server 的会话句柄，用于线程管理和 RPC 调用
- 返回 `AppRunControl::Continue` 表示继续事件循环，`AppRunControl::Exit(reason)` 表示终止应用

> 源码位置：`codex-rs/tui/src/app.rs:4007–4012`

## 关键流程 Walkthrough

`handle_event()` 的 `match` 分支可以按职责归为以下几组。每个分支处理完毕后，默认返回 `Ok(AppRunControl::Continue)`（方法末尾第 5525 行），只有 `Exit` 和 `FatalExitRequest` 两个变体会提前返回退出信号。

### 1. 会话控制（Session Control）

| 事件 | 行为 |
|------|------|
| `NewSession` | 调用 `start_fresh_session_with_summary_hint()` 创建新会话 |
| `ClearUi` | 先清屏 (`clear_terminal_ui` + `reset_app_ui_state_after_clear`)，再启动新会话 |
| `Exit(mode)` | 委托给 `handle_exit_mode()`，返回 `AppRunControl::Exit`。`ShutdownFirst` 模式会先通知 core 做清理 |
| `FatalExitRequest(msg)` | 直接返回 `AppRunControl::Exit(ExitReason::Fatal(msg))`，用于不可恢复的错误 |

> 源码位置：`codex-rs/tui/src/app.rs:4014–4024, 4261–4266`

### 2. 会话恢复与分叉（Resume / Fork）

**`OpenResumePicker`**（`app.rs:4025–4148`）：
1. 启动一个独立的 picker app-server 连接
2. 运行 `run_resume_picker_with_app_server()` 全屏 picker UI
3. 用户选择后：解析目标会话的工作目录（支持 cwd 提示确认）
4. 调用 `rebuild_config_for_resume_or_fallback()` 重建配置
5. 通过 `app_server.resume_thread()` 恢复线程
6. 调用 `replace_chat_widget_with_app_server_thread()` 替换当前聊天视图
7. 显示先前会话的 token 用量摘要和恢复命令提示

**`ForkCurrentSession`**（`app.rs:4149–4207`）：
1. 记录 telemetry（`codex.thread.fork`）
2. 在聊天中显示 `/fork` 标记
3. 要求当前线程至少有一个 turn（否则报错）
4. 从磁盘刷新配置后调用 `app_server.fork_thread()` 创建分支
5. 关闭当前线程，替换为分叉后的新线程

### 3. Op 提交（Op Submission）

| 事件 | 行为 |
|------|------|
| `CodexOp(op)` | 将 Op 提交到当前活跃线程：`submit_active_thread_op()` |
| `SubmitThreadOp { thread_id, op }` | 将 Op 提交到指定线程：`submit_thread_op()` |
| `ThreadHistoryEntryResponse { thread_id, event }` | 将合成的历史条目响应入队到指定线程通道 |

> 源码位置：`codex-rs/tui/src/app.rs:4267–4277`

### 4. 历史记录与 Transcript

**`InsertHistoryCell(cell)`**（`app.rs:4208–4233`）：
1. 将 cell 插入 transcript overlay（如果打开）和 `transcript_cells` 列表
2. 生成显示行，根据是否为流式续接决定是否插入空行分隔
3. 若有 overlay 打开，暂存到 `deferred_history_lines`；否则直接写入终端

**`ApplyThreadRollback { num_turns }`**（`app.rs:4234–4238`）：
处理非交互式的回滚请求，调用 `apply_non_pending_thread_rollback()` 裁剪本地 transcript cells。

### 5. Commit 动画

三个事件协作实现提交进度动画：

| 事件 | 行为 |
|------|------|
| `StartCommitAnimation` | 通过 `compare_exchange` 原子操作确保只启动一次，在独立线程中按 `COMMIT_ANIMATION_TICK` 间隔发送 `CommitTick` |
| `StopCommitAnimation` | 将原子标志设为 false，后台线程随之退出循环 |
| `CommitTick` | 驱动 `chat_widget.on_commit_tick()` 更新动画帧 |

> 源码位置：`codex-rs/tui/src/app.rs:4239–4260`

### 6. Diff 查看与全屏审批（Overlays）

**`DiffResult(text)`**（`app.rs:4278–4293`）：
清除底部面板的进行中状态，进入 alt-screen，将 diff 文本解析为 ANSI 着色行并渲染到 Pager overlay。

**`FullScreenApprovalRequest(request)`**（`app.rs:5371–5430`）：
根据请求类型进入 alt-screen 并创建对应的 overlay：
- `ApplyPatch` → 构建 `DiffSummary`，标题 "P A T C H"
- `Exec` → 对命令做 bash 语法高亮，标题 "E X E C"
- `Permissions` → 显示权限原因和规则，标题 "P E R M I S S I O N S"
- `McpElicitation` → 显示 MCP 服务器名和消息，标题 "E L I C I T A T I O N"

### 7. 插件系统（Plugin Management）

插件相关事件形成一个完整的异步状态机：

```
FetchPluginsList → PluginsLoaded
FetchPluginDetail → PluginDetailLoaded
FetchPluginInstall → PluginInstallLoaded
FetchPluginUninstall → PluginUninstallLoaded
```

关键行为：
- `PluginInstallLoaded`（`app.rs:4383–4418`）：安装成功后刷新内存配置、插件 mention 绑定、重新加载用户配置，并可选地刷新插件列表和详情
- `PluginUninstallLoaded`（`app.rs:4886–4913`）：卸载成功后同样刷新配置和 mention 绑定
- `PluginInstallAuthAdvance` / `PluginInstallAuthAbandon`：管理安装后的 OAuth 认证流程
- `OpenPluginDetailLoading` / `OpenPluginInstallLoading` / `OpenPluginUninstallLoading`：在操作期间显示 loading 状态

### 8. MCP 与 Connectors

| 事件 | 行为 |
|------|------|
| `FetchMcpInventory` | 发起 MCP 服务器清单 RPC |
| `McpInventoryLoaded` | 将结果渲染到历史记录 |
| `RefreshConnectors` | 刷新 app connector 状态和 mention 绑定 |
| `ConnectorsLoaded` | 将 connector 预取结果传递给 chat widget |
| `OpenAppLink` | 打开应用链接详情视图（底部面板） |
| `OpenUrlInBrowser` | 调用系统浏览器打开 URL |

### 9. 文件搜索

| 事件 | 行为 |
|------|------|
| `StartFileSearch(query)` | 启动异步文件搜索（`@` 触发） |
| `FileSearchResult { query, matches }` | 将搜索结果应用到 chat widget（会检查结果是否仍相关） |

### 10. 配置持久化（Config Persistence）

这组事件将用户在 UI 中做的选择写入磁盘配置文件（通过 `ConfigEditsBuilder`）。模式统一：构建编辑 → `apply().await` → 成功时更新内存状态并提示用户 → 失败时记录错误并显示错误消息。所有持久化操作都支持 profile 感知（写入特定 profile 的配置段）。

| 事件 | 持久化内容 |
|------|-----------|
| `PersistModelSelection` | 模型和 reasoning effort |
| `PersistPersonalitySelection` | 人格设置 |
| `PersistServiceTierSelection` | Fast mode 开关 |
| `PersistRealtimeAudioDeviceSelection` | 实时音频设备（麦克风/扬声器） |
| `PersistFullAccessWarningAcknowledged` | 全权限警告确认标志 |
| `PersistWorldWritableWarningAcknowledged` | 目录可写警告确认标志 |
| `PersistRateLimitSwitchPromptHidden` | 速率限制切换提示隐藏标志 |
| `PersistPlanModeReasoningEffort` | Plan 模式推理力度 |
| `PersistModelMigrationPromptAcknowledged` | 模型迁移提示已确认标志 |
| `StatusLineSetup` | 状态栏项排序和选择 |
| `TerminalTitleSetup` | 终端标题项配置 |
| `SyntaxThemeSelected` | 语法高亮主题 |

> 示例源码（PersistModelSelection）：`codex-rs/tui/src/app.rs:4845–4885`

### 11. 策略与运行时更新（Policy / Runtime Updates）

**策略更新**：

| 事件 | 行为 |
|------|------|
| `UpdateAskForApprovalPolicy(policy)` | 通过 `try_set_approval_policy_on_config()` 验证并设置审批策略，更新 `runtime_approval_policy_override` |
| `UpdateSandboxPolicy(policy)` | 设置沙箱策略，在 Windows 上可能触发 world-writable 目录扫描（`spawn_world_writable_scan`） |
| `UpdateApprovalsReviewer(policy)` | 更新审批审核者设置并持久化到配置文件 |
| `UpdateFeatureFlags { updates }` | 批量更新 feature flags 并持久化 |

**运行时更新**（仅修改内存状态，不持久化）：

| 事件 | 行为 |
|------|------|
| `UpdateReasoningEffort(effort)` | 更新推理力度 |
| `UpdateModel(model)` | 更新当前模型 |
| `UpdateCollaborationMode(mask)` | 更新协作模式掩码 |
| `UpdatePersonality(personality)` | 更新人格设置 |
| `UpdateFullAccessWarningAcknowledged(ack)` | 更新全权限警告确认状态 |
| `UpdateWorldWritableWarningAcknowledged(ack)` | 更新可写目录警告确认状态 |
| `UpdateRateLimitSwitchPromptHidden(hidden)` | 更新速率限制提示隐藏状态 |
| `UpdatePlanModeReasoningEffort(effort)` | 更新 Plan 模式推理力度 |

### 12. Windows 沙箱设置流程

这是一个多步骤的异步状态机，专为 Windows 平台设计（非 Windows 平台编译为空操作）：

```
OpenWindowsSandboxEnablePrompt
    → BeginWindowsSandboxElevatedSetup  (提权路径)
        → EnableWindowsSandboxForAgentMode { mode: Elevated }
        → OpenWindowsSandboxFallbackPrompt (失败时回退)
    → BeginWindowsSandboxLegacySetup    (非提权路径)
        → EnableWindowsSandboxForAgentMode { mode: Legacy }
```

**`BeginWindowsSandboxElevatedSetup`**（`app.rs:4547–4631`）：
1. 若 `sandbox_setup_is_complete()` 已完成，直接跳到启用步骤
2. 否则显示设置状态，在 `spawn_blocking` 中运行 `run_elevated_setup()`
3. 成功发送 `EnableWindowsSandboxForAgentMode`，失败发送 `OpenWindowsSandboxFallbackPrompt`
4. 记录 telemetry 指标和耗时

**`EnableWindowsSandboxForAgentMode`**（`app.rs:4731–4844`）：
1. 通过 `ConfigEditsBuilder` 写入 `windows_sandbox_mode`（"elevated" 或 "unelevated"）
2. 更新内存中的 sandbox 配置标志
3. 检查是否需要显示 world-writable 目录警告
4. 若不需要，直接应用审批和沙箱策略，并向用户显示 "Sandbox ready" 确认

**`BeginWindowsSandboxGrantReadRoot`**（`app.rs:4674–4717`）：
在 `spawn_blocking` 中为额外目录授予非提权读权限。

### 13. UI 弹窗与选择器

| 事件 | 打开的 UI |
|------|----------|
| `OpenApprovalsPopup` | 审批预设选择器 |
| `OpenPermissionsPopup` | 权限配置弹窗 |
| `OpenReasoningPopup` | 推理力度选择弹窗 |
| `OpenPlanReasoningScopePrompt` | Plan 模式推理范围确认 |
| `OpenAllModelsPopup` | 全模型列表选择器 |
| `OpenFullAccessConfirmation` | 全权限模式确认弹窗 |
| `OpenFeedbackNote` / `OpenFeedbackConsent` | 反馈输入和上传同意弹窗 |
| `OpenRealtimeAudioDeviceSelection` | 实时音频设备选择器 |
| `OpenReviewBranchPicker` / `OpenReviewCommitPicker` / `OpenReviewCustomPrompt` | 代码审查相关选择器 |
| `OpenSkillsList` / `OpenManageSkillsPopup` / `ManageSkillsClosed` | 技能管理界面 |
| `OpenAgentPicker` / `SelectAgentThread` | 多 Agent 选择器和线程切换 |
| `TerminalTitleSetupPreview` / `TerminalTitleSetupCancelled` / `StatusLineSetupCancelled` | 设置预览和取消 |

### 14. 反馈提交

| 事件 | 行为 |
|------|------|
| `SubmitFeedback` | 通过 app-server RPC 提交反馈 |
| `FeedbackSubmitted` | 处理提交结果（成功/失败） |

### 15. 其他事件

| 事件 | 行为 |
|------|------|
| `LaunchExternalEditor` | 仅在 `ExternalEditorState::Active` 时启动外部编辑器 |
| `RefreshRateLimits` / `RateLimitsLoaded` | 后台刷新和展示账户速率限制快照 |
| `SetSkillEnabled` | 切换技能启用状态并持久化 |
| `SetAppEnabled` | 切换 App/Connector 启用状态并持久化 |
| `SubmitUserMessageWithMode` | 以指定协作模式提交用户消息 |
| `UpdateRecordingMeter`（非 Linux） | 就地更新语音录制指示器，检测已删除的 meter 以停止实时对话 |
| `StatusLineBranchUpdated` | 更新状态栏的 git 分支显示 |
| `SkipNextWorldWritableScan` | 一次性抑制下一次 world-writable 扫描 |
| `RestartRealtimeAudioDevice` | 重启实时音频设备 |

## 接口/类型定义

### `AppEvent`（`app_event.rs:80–570`）

约 80 个变体的枚举，是 TUI 内部的统一消息类型。所有 Widget 通过 `AppEventSender` channel 发射事件，由 `handle_event()` 统一消费。标注了 `#[allow(clippy::large_enum_variant)]`，部分 Windows 专用变体标注了 `#[cfg_attr(not(target_os = "windows"), allow(dead_code))]`。

### `AppRunControl`（`app.rs:301–304`）

```rust
pub(crate) enum AppRunControl {
    Continue,
    Exit(ExitReason),
}
```

`handle_event()` 的返回类型。绝大多数分支返回 `Continue`，仅 `Exit` 和 `FatalExitRequest` 返回 `Exit`。

### `ExitMode`（`app_event.rs:577–586`）

```rust
pub(crate) enum ExitMode {
    ShutdownFirst,  // 等 core 清理完再退出
    Immediate,      // 立即退出，跳过清理
}
```

### `FeedbackCategory`（`app_event.rs:588–595`）

```rust
pub(crate) enum FeedbackCategory {
    BadResult, GoodResult, Bug, SafetyCheck, Other,
}
```

### `WindowsSandboxEnableMode`（`app_event.rs:65–70`）

```rust
pub(crate) enum WindowsSandboxEnableMode {
    Elevated,   // 提权安装
    Legacy,     // 非提权安装
}
```

### `RealtimeAudioDeviceKind`（`app_event.rs:43–63`）

```rust
pub(crate) enum RealtimeAudioDeviceKind {
    Microphone,
    Speaker,
}
```

## 配置项与默认值

`handle_event()` 本身不引入新配置项，但大量分支读写以下配置：

- **`self.config`**（`AppConfig`）：主配置对象，持有 cwd、权限策略、codex_home、realtime_audio 等
- **`self.active_profile`**：当前 profile 名称，影响所有 `ConfigEditsBuilder` 操作的写入路径
- **`self.runtime_approval_policy_override` / `self.runtime_sandbox_policy_override`**：运行时策略覆盖，防止配置重建时丢失用户的临时调整
- **`ConfigEditsBuilder`**：所有持久化操作的统一入口，支持 `.with_profile()` 写入特定 profile 配置段

## 边界 Case 与注意事项

1. **提前返回**：只有 `Exit` 和 `FatalExitRequest` 会导致方法提前 return（跳出事件循环）。策略更新中 `try_set_approval_policy_on_config()` / `try_set_sandbox_policy_on_config()` 验证失败时返回 `Continue` 并静默中止该事件的处理。

2. **Windows 条件编译**：所有 Windows 沙箱相关分支使用 `#[cfg(target_os = "windows")]` 包裹，非 Windows 平台为空操作（`let _ = ...`）。`UpdateRecordingMeter` 使用 `#[cfg(not(target_os = "linux"))]`。

3. **异步阻塞操作**：Windows 沙箱设置和目录权限授予通过 `tokio::task::spawn_blocking` 在独立线程执行，避免阻塞事件循环。完成后通过 `app_event_tx` channel 发回结果事件。

4. **Commit 动画的原子同步**：`StartCommitAnimation` 使用 `compare_exchange` 原子操作确保不重复启动后台动画线程，`StopCommitAnimation` 通过原子标志通知线程退出。

5. **Resume picker 的 alt-screen**：resume/fork picker 会进入全屏模式，返回后需要调用 `schedule_frame()` 强制重绘，因为离开 alt-screen 可能清空 inline viewport。

6. **Deferred history lines**：当 overlay 打开时，新的 history lines 被暂存到 `deferred_history_lines`，避免在覆盖层下方插入内容导致渲染异常。

7. **插件操作后的连锁刷新**：安装/卸载插件成功后会触发一系列连锁操作——刷新内存配置、刷新 mention 绑定、发送 `reload_user_config` Op、刷新插件列表，确保所有 UI 和核心状态保持一致。

## 关键代码片段

### 事件分发入口

```rust
async fn handle_event(
    &mut self,
    tui: &mut tui::Tui,
    app_server: &mut AppServerSession,
    event: AppEvent,
) -> Result<AppRunControl> {
    match event {
        AppEvent::NewSession => { ... }
        AppEvent::ClearUi => { ... }
        // ... ~80 个分支
    }
    Ok(AppRunControl::Continue)
}
```
> `codex-rs/tui/src/app.rs:4007–5526`

### 配置持久化的典型模式

```rust
AppEvent::PersistModelSelection { model, effort } => {
    let profile = self.active_profile.as_deref();
    match ConfigEditsBuilder::new(&self.config.codex_home)
        .with_profile(profile)
        .set_model(Some(model.as_str()), effort)
        .apply()
        .await
    {
        Ok(()) => { /* 更新 UI 状态，显示成功消息 */ }
        Err(err) => { /* 记录错误日志，显示错误消息 */ }
    }
}
```
> `codex-rs/tui/src/app.rs:4845–4885`

### Windows 沙箱提权设置

```rust
AppEvent::BeginWindowsSandboxElevatedSetup { preset } => {
    if codex_core::windows_sandbox::sandbox_setup_is_complete(codex_home.as_path()) {
        tx.send(AppEvent::EnableWindowsSandboxForAgentMode { preset, mode: Elevated });
        return Ok(AppRunControl::Continue);
    }
    self.chat_widget.show_windows_sandbox_setup_status();
    tokio::task::spawn_blocking(move || {
        match codex_core::windows_sandbox::run_elevated_setup(...) {
            Ok(()) => tx.send(AppEvent::EnableWindowsSandboxForAgentMode { ... }),
            Err(err) => tx.send(AppEvent::OpenWindowsSandboxFallbackPrompt { preset }),
        }
    });
}
```
> `codex-rs/tui/src/app.rs:4547–4631`