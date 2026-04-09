# 配置重建与运行时策略管理

## 概述与职责

本模块是 TUI 应用中 `App` 结构体的一组方法，负责**配置的重建、磁盘刷新、运行时策略覆盖，以及 feature flag 更新**。它确保在线程切换（resume/fork/start）、工作目录变更、以及用户交互式修改策略时，内存中的 `Config` 始终与磁盘状态和运行时覆盖保持一致。

在整体架构中，本模块位于 `TUI → AppOrchestrator → AppCore → MainEventLoop` 层级内，是 `App` 事件循环的一部分。它被上层的线程生命周期管理（start/resume/fork/switch）和 AppEvent 派发逻辑调用，用于在关键时刻刷新或重建配置。

同级模块包括 ServerEventAdapter（处理来自 app-server 的事件）、PendingRequests（跟踪待解决的审批请求）、InteractiveReplayTracking（过滤交互式提示的重放）、AgentNavigation（多 agent 选择器）和 LoadedThreadDiscovery（子 agent 线程发现）。

## 关键数据结构

### App 上的配置相关字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `config` | `Config` | 当前生效的配置副本 |
| `active_profile` | `Option<String>` | 当前激活的配置 profile 名称 |
| `cli_kv_overrides` | `Vec<(String, TomlValue)>` | 命令行传入的键值覆盖 |
| `harness_overrides` | `ConfigOverrides` | Harness 级别的结构化覆盖（含 cwd、额外可写目录等） |
| `runtime_approval_policy_override` | `Option<AskForApproval>` | 运行时用户手动设置的审批策略覆盖 |
| `runtime_sandbox_policy_override` | `Option<SandboxPolicy>` | 运行时用户手动设置的沙箱策略覆盖 |

> 源码位置：`codex-rs/tui/src/app.rs:944-949`

### `GuardianApprovalsMode`

```rust
struct GuardianApprovalsMode {
    approval_policy: AskForApproval,
    approvals_reviewer: ApprovalsReviewer,
    sandbox_policy: SandboxPolicy,
}
```

Guardian Approvals 实验功能启用时的预设策略组合，通过 `guardian_approvals_mode()` 工厂函数返回固定值：`approval_policy = OnRequest`、`approvals_reviewer = GuardianSubagent`、`sandbox_policy = workspace-write`。

> 源码位置：`codex-rs/tui/src/app.rs:255-272`

## 关键流程

### 配置重建流程

当需要为新的工作目录构建配置时，调用链如下：

1. **`rebuild_config_for_cwd(cwd)`**（`app.rs:1101-1112`）：克隆当前 `harness_overrides`，替换其中的 `cwd`，然后通过 `ConfigBuilder` 重新构建完整配置。构建过程会重新读取磁盘上的分层配置文件（全局/项目/本地），并叠加 CLI 覆盖和 harness 覆盖。

2. **`refresh_in_memory_config_from_disk()`**（`app.rs:1114-1122`）：以当前 ChatWidget 的 cwd 为基准调用 `rebuild_config_for_cwd`，然后调用 `apply_runtime_policy_overrides` 将运行时策略覆盖重新应用到新配置上，最后更新 `self.config` 并同步插件 mentions 配置。

3. **`refresh_in_memory_config_from_disk_best_effort(action)`**（`app.rs:1124-1132`）：对 `refresh_in_memory_config_from_disk` 的容错包装——如果刷新失败，仅记录警告并继续使用当前内存配置，不中断调用方流程。适用于线程过渡等不能因配置刷新失败而中断的场景。

4. **`rebuild_config_for_resume_or_fallback(current_cwd, resume_cwd)`**（`app.rs:1134-1155`）：为恢复线程构建配置。先尝试用 `resume_cwd` 重建；如果失败，检查 `resume_cwd` 是否与 `current_cwd` 相同——相同则回退使用当前内存配置，不同则传播错误（因为不同目录的配置不能互相替代）。

### 运行时策略覆盖流程

**`apply_runtime_policy_overrides(config)`**（`app.rs:1157-1174`）：将用户在当前会话中通过交互操作设置的审批策略（`runtime_approval_policy_override`）和沙箱策略（`runtime_sandbox_policy_override`）重新应用到给定的 `config` 上。这确保每次从磁盘重建配置后，用户的运行时选择不会丢失。如果 `set()` 调用失败（比如策略级别不被允许），会记录警告并在 UI 显示错误。

### ChatWidget 初始化

**`chatwidget_init_for_forked_or_resumed_thread(tui, cfg)`**（`app.rs:1075-1099`）：为 fork 或 resume 的线程创建 `ChatWidgetInit` 结构。从当前 `App` 状态复制 UI 相关信息（enhanced keys 支持、模型目录、反馈状态、telemetry 等），但 `initial_user_message` 设为 `None`（fork/resume 不携带预填消息），`is_first_run` 设为 `false`。

### 策略设置辅助方法

- **`set_approvals_reviewer_in_app_and_widget(reviewer)`**（`app.rs:1176-1179`）：同时更新 `self.config.approvals_reviewer` 和 ChatWidget 的审批审查者设置，确保两者一致。

- **`try_set_approval_policy_on_config(config, policy, ...)`**（`app.rs:1181-1196`）：尝试在配置上设置审批策略。成功返回 `true`，失败时记录警告、在 UI 显示错误并返回 `false`。调用方据此决定是否继续后续操作。

- **`try_set_sandbox_policy_on_config(config, policy, ...)`**（`app.rs:1198-1213`）：与上面类似，针对沙箱策略。

## Feature Flag 更新：`update_feature_flags()`

这是本模块中最复杂的函数（约 240 行，`app.rs:1215-1458`），负责批量更新 feature flag 并处理 Guardian Approvals 实验的完整策略联动逻辑。

### 执行步骤

1. **初始化**：获取 Guardian Approvals 预设，克隆当前配置为 `next_config` 作为工作副本。

2. **Profile 作用域检测**（`app.rs:1243-1259`）：检查两个关键条件——
   - `root_approvals_reviewer_blocks_profile_disable`：根作用域是否配置了非 `"user"` 的 `approvals_reviewer`。如果是，则 profile 内不允许禁用 Guardian Approvals（防止 profile 静默覆盖更高级别的设置）。
   - `profile_approvals_reviewer_configured`：当前 profile 是否单独配置了 `approvals_reviewer`。

3. **逐项处理 feature 更新**（`app.rs:1264-1360`）：对每个 `(feature, enabled)` 对：
   - **Guardian Approvals 禁用保护**：如果尝试在 profile 内禁用 Guardian Approvals，但根作用域配置了非 user 的 `approvals_reviewer`，则拒绝操作并报错。
   - **约束验证**：调用 `features.set_enabled()` 验证 feature flag 的约束关系（某些 flag 之间有互斥或依赖）。
   - **Guardian Approvals 启用时**：设置 `approvals_reviewer` 为 `GuardianSubagent`，并通过 `ConfigEdit::SetPath` 持久化。
   - **Guardian Approvals 禁用时**：清除 profile 的 `approvals_reviewer`（如果有配置），恢复为 `User`。
   - **Guardian Approvals 策略对齐**：启用时还会同步设置 `approval_policy = on-request` 和 `sandbox_mode = workspace-write`，确保三者一致。

4. **持久化到磁盘**（`app.rs:1365-1370`）：通过 `ConfigEditsBuilder` 构建编辑集并调用 `apply()` 写入配置文件。如果持久化失败，中止整个操作——不更新内存状态，避免磁盘和内存不一致。

5. **更新内存状态**（`app.rs:1372-1395`）：持久化成功后，依次更新 `self.config`、ChatWidget 的 feature flag 状态、审批审查者、审批策略和沙箱策略。

6. **发送 OverrideTurnContext 命令**（`app.rs:1397-1426`）：如果审批策略、审批审查者或沙箱策略发生了变化，构建 `AppCommand::override_turn_context` 并提交给当前活跃线程，使策略变更**立即**在当前会话中生效，而不是等到下次线程创建。

7. **Windows 沙箱处理**（`app.rs:1428-1450`）：如果 `WindowsSandbox` 或 `WindowsSandboxElevated` flag 变化，在 Windows 平台上发送对应的 turn context 覆盖。

8. **权限变更通知**（`app.rs:1452-1457`）：如果权限设置实际发生了变化，在 UI 中显示 "Permissions updated to ..." 的提示消息。

## 辅助函数

### `normalize_harness_overrides_for_cwd(overrides, base_cwd)`

独立函数（非 `App` 方法），将 `harness_overrides` 中的 `additional_writable_roots` 路径相对于给定的 `base_cwd` 解析为绝对路径。

> 源码位置：`codex-rs/tui/src/app.rs:1014-1029`

## 边界 Case 与注意事项

- **磁盘优先策略**：`update_feature_flags` 严格遵循"先持久化，后更新内存"的顺序。如果磁盘写入失败，内存状态不会被修改，避免活跃会话与持久化配置不一致。

- **Profile 作用域约束**：Guardian Approvals 的 `approvals_reviewer` 受作用域保护——如果根配置设置了非 `user` 的值，profile 内无法通过禁用 feature flag 来静默清除它。这防止了低优先级作用域意外覆盖高优先级安全设置。

- **运行时覆盖的持久性**：`runtime_approval_policy_override` 和 `runtime_sandbox_policy_override` 仅存在于内存中，不会持久化到磁盘。它们在每次 `refresh_in_memory_config_from_disk` 时被重新应用，确保用户的运行时选择跨配置刷新存活。

- **resume 的容错降级**：`rebuild_config_for_resume_or_fallback` 仅在 resume 目录与当前目录相同时才允许回退到内存配置。不同目录意味着可能需要不同的项目级配置，此时不安全回退。

- **OverrideTurnContext 的即时性**：Guardian Approvals 策略变更通过 `OverrideTurnContext` 命令立即推送到活跃线程，而不仅仅修改配置。这确保用户开启实验后，当前对话立刻开始使用 Guardian 审查，无需开启新线程。