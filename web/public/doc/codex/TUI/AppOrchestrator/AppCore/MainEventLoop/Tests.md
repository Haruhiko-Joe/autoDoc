# Tests（MainEventLoop 测试套件）

## 概述与职责

本模块是 `App` 结构体（TUI 主事件循环状态机）的综合测试套件，位于 `codex-rs/tui/src/app.rs:6200-10929`，约 4730 行。它验证了 `App` 的核心行为——从线程生命周期管理、事件路由、快照回放，到配置管理、权限切换、回退（backtrack）操作，以及会话摘要和 UI 清理等方方面面。

**在系统层级中的位置**：本测试套件属于 TUI → AppOrchestrator → AppCore → MainEventLoop 路径下，专门覆盖 `App` 状态机在各种场景下的行为正确性。

## 测试基础设施

### 工厂函数与辅助工具

测试套件依赖一组精心设计的工厂函数来构建轻量级、可控的 `App` 实例：

**`make_test_app()`**（`app.rs:9057-9104`）
构建一个最小化的 `App` 实例，所有字段使用默认值或 `test_dummy` 占位，不依赖真实的 app-server 或终端。内部调用 `make_chatwidget_manual_with_sender()` 创建 ChatWidget，但丢弃 channel 接收端——适用于不需要检查发出事件的测试。

**`make_test_app_with_channels()`**（`app.rs:9106-9161`）
与 `make_test_app` 类似，但保留并返回 `AppEvent` 和 `Op` 的 `UnboundedReceiver`——允许测试断言 App 发出的事件和提交的操作。返回 `(App, app_event_rx, op_rx)` 三元组。

**`test_thread_session()`**（`app.rs:9163-9181`）
构造一个 `ThreadSessionState`，使用 `gpt-test` 模型、`test-provider`、只读沙箱策略、从不审批等默认配置。

**`test_turn()`**（`app.rs:9183-9190`）
构造一个 `Turn`，包含指定的 turn_id、状态和消息项列表。

**通知工厂函数**（`app.rs:9192-9335`）
提供一系列生成 `ServerNotification` 和 `ServerRequest` 的工具函数：
- `turn_started_notification` / `turn_completed_notification` / `thread_closed_notification`
- `token_usage_notification` — 包含可配置的 model_context_window
- `hook_started_notification` / `hook_completed_notification` — 模拟生命周期钩子事件
- `agent_message_delta_notification` — 模拟流式消息增量
- `exec_approval_request` — 生成命令执行审批请求

**`next_user_turn_op()`**（`app.rs:9571-9580`）
从 Op channel 中提取下一个 `Op::UserTurn`，跳过其他 Op 类型。若未找到则 panic。

**`lines_to_single_string()`**（`app.rs:9582-9593`）
将 ratatui `Line` 切片转换为单一字符串，用于快照和断言。

## 关键测试场景 Walkthrough

### 1. 配置与初始化

**`normalize_harness_overrides_resolves_relative_add_dirs`**（`app.rs:6301-6318`）
验证 `normalize_harness_overrides_for_cwd()` 将相对路径的 `additional_writable_roots` 解析为基于 cwd 的绝对路径。

**`mcp_inventory_maps_prefix_tool_names_by_server`**（`app.rs:6321-6368`）
验证 `mcp_inventory_maps_from_statuses()` 将 MCP 工具名转换为 `mcp__{server}__{tool}` 格式的全限定名，同时正确分组 resources、templates 和 auth 状态。

**`handle_mcp_inventory_result_clears_committed_loading_cell`**（`app.rs:6370-6387`）
确认 MCP 清单加载完成后，移除 transcript 中的加载动画 cell。

### 2. 启动等待门控（Startup Waiting Gate）

这组测试（`app.rs:6389-6484`）验证新会话的启动同步机制：

- **`StartFresh` 和 `Exit` 需要等待**：直到 primary thread 配置完成（收到 ThreadId）才开始处理 active thread 事件
- **`Resume` 和 `Fork` 不需要等待**：立即可以处理事件，因为会话已经有历史数据

核心逻辑通过三个静态方法协调：`should_wait_for_initial_session()`、`should_handle_active_thread_events()` 和 `should_stop_waiting_for_initial_session()`。

### 3. 线程事件路由（Thread Event Routing）

**入队与缓冲**

- `enqueue_primary_thread_session_replays_buffered_approval_after_attach`（`app.rs:6486-6533`）：验证在 primary thread session 就绪之前缓冲的审批请求，在 session 建立后被正确回放到 thread channel 中，且用户可以批准并产生线程级 Op。

- `enqueue_thread_event_does_not_block_when_channel_full`（`app.rs:6691-6728`）：当 channel 已满时，`enqueue_thread_notification` 不会阻塞——它会增长内部缓冲区以确保无丢失。

**快照回放（Snapshot Replay）**

这是测试套件中最密集的部分（`app.rs:6730-7164`），覆盖了线程切换时的状态恢复：

- `replay_thread_snapshot_restores_draft_and_queued_input`：恢复编辑器中的草稿文本和排队的后续输入
- `replayed_turn_complete_submits_restored_queued_follow_up`：当回放中 turn 完成时，自动提交排队的后续消息
- `replay_only_thread_keeps_restored_queue_visible`：`resume_restored_queue=false` 时保留队列可见但不自动提交
- `replay_thread_snapshot_does_not_submit_queue_before_replay_catches_up`：确保排队消息在所有回放 turn 完成前不会提前提交
- `replayed_interrupted_turn_restores_queued_input_to_composer`：被中断的 turn 将排队输入恢复为编辑器草稿而非自动提交
- `replay_thread_snapshot_restores_pending_pastes_for_submit`：恢复大段粘贴内容并可正常提交
- `replay_thread_snapshot_restores_collaboration_mode_for_draft_submit` / `...without_input`：验证协作模式（model、reasoning effort、mode kind）在快照恢复后正确保持

**线程事件存储（ThreadEventStore）**

- `thread_event_store_tracks_active_turn_lifecycle`（`app.rs:9337-9359`）：验证 turn 生命周期跟踪——started 设置 active turn、completed 清除
- `thread_event_store_rebase_preserves_resolved_request_state`：会话刷新后，已解决的请求不再出现在快照中
- `thread_event_store_rebase_preserves_hook_notifications`：生命周期钩子通知在 rebase 后保留

### 4. Agent Picker（多 Agent 导航）

这组测试（`app.rs:7379-7713`）覆盖多 agent 拣选器的状态管理：

- **Missing threads 保留**：`open_agent_picker_keeps_missing_threads_for_replay` — 对于有 channel 但服务端已不认识的线程，标记为 `is_closed=true` 但保留用于回放
- **元数据缓存**：`open_agent_picker_preserves_cached_metadata_for_replay_threads` — 已缓存的 nickname/role 在刷新后不丢失
- **Ghost 清理**：`open_agent_picker_prunes_terminal_metadata_only_threads` — 没有 channel 且不再活跃的线程被彻底移除
- **终端错误检测**：`terminal_thread_read_error_detection_matches_not_loaded_errors` vs `ignores_transient_failures` — 区分"线程不存在"和暂时性网络错误
- **存活线程标记**：`open_agent_picker_marks_loaded_threads_open` — 服务端仍加载的线程标记 `is_closed=false`
- **空线程拒绝**：`attach_live_thread_for_selection_rejects_empty_non_ephemeral_fallback_threads` — 防止附加到空的未实体化线程

### 5. Guardian Approvals 功能标志切换

这是测试套件中最详尽的一组（`app.rs:7715-8242`），验证 Guardian Approvals 功能的启用/禁用在多层配置中的正确行为：

**启用 Guardian**：
- 设置 `approvals_reviewer = "guardian_subagent"`、`approval_policy = "on-request"`、`sandbox_mode = "workspace-write"`
- 发出 `Op::OverrideTurnContext` 将配置同步到核心
- 写入 config.toml 持久化
- 显示"Permissions updated to Guardian Approvals"提示

**禁用 Guardian**：
- 清除 guardian 相关配置，恢复到 `ApprovalsReviewer::User`
- 保留用户之前设置的 approval_policy 和 sandbox_mode
- 正确处理从 config.toml 中移除 guardian 标记

**Profile 场景**（`app.rs:8016-8242`）：
- `enabling_guardian_in_profile_sets_profile_auto_review_policy`：在活跃 profile 下启用时，配置写入 `[profiles.guardian]` 而非顶层
- `disabling_guardian_in_profile_allows_inherited_user_reviewer`：profile 继承顶层 `approvals_reviewer = "user"` 时正确回退
- `disabling_guardian_in_profile_keeps_inherited_non_user_reviewer_enabled`：当顶层已设置 `guardian_subagent` 时，拒绝在 profile 级别禁用（因为效果不变）

### 6. 非活跃线程审批冒泡

- `inactive_thread_approval_bubbles_into_active_view`（`app.rs:8310-8360`）：当非活跃 agent 线程有待审批请求时，在当前活跃视图的底部栏显示 "Robie [explorer]" 徽章
- `inactive_thread_approval_badge_clears_after_turn_completion`（`app.rs:8522-8582`）：turn 完成后自动清除审批徽章
- `inactive_thread_exec_approval_preserves_context`（`app.rs:8362-8438`）：审批请求正确保留网络上下文、附加权限和网络策略修订
- `inactive_thread_exec_approval_splits_shell_wrapped_command`（`app.rs:8440-8473`）：正确拆分 shell 包装的命令行

### 7. 模型迁移提示

- `model_migration_prompt_only_shows_for_deprecated_models`（`app.rs:9658-9691`）：只为已弃用模型（如 `gpt-5`、`gpt-5-codex`）显示升级提示
- `model_migration_prompt_respects_hide_flag_and_self_target`（`app.rs:9869-9885`）：已确认的迁移和自身目标不再显示
- `model_migration_prompt_skips_when_target_missing_or_hidden`（`app.rs:9887-9929`）：目标模型不存在或隐藏时跳过
- `model_migration_prompt_shows_for_hidden_model`（`app.rs:9931-9990`）：当前模型已隐藏（如 `gpt-5.1-codex`）但仍显示迁移提示

### 8. 模型可用性 NUX（新用户体验）

- `select_model_availability_nux_picks_only_eligible_model`（`app.rs:9693-9716`）：选择唯一有 NUX 的模型
- `select_model_availability_nux_skips_missing_and_exhausted_models`（`app.rs:9718-9751`）：已达显示上限的模型被跳过
- `select_model_availability_nux_uses_existing_model_order_as_priority`（`app.rs:9815-9845`）：按模型预设列表顺序（后者优先）选择
- `select_model_availability_nux_returns_none_when_all_models_are_exhausted`（`app.rs:9847-9867`）：全部耗尽时返回 None

### 9. Backtrack（回退）

- `backtrack_selection_with_duplicate_history_targets_unique_turn`（`app.rs:10166-10303`）：在含重复历史（多次回退产生的重复 cells）的 transcript 中，正确定位唯一 turn 并保留 text_elements、local_image_paths、remote_image_urls
- `backtrack_remote_image_only_selection_clears_existing_composer_draft`（`app.rs:10305-10337`）：回退到仅含远程图片的 turn 时清空编辑器草稿
- `backtrack_resubmit_preserves_data_image_urls_in_user_turn`（`app.rs:10339-10403`）：回退重新提交时保留 data: URI 图片
- `queued_rollback_syncs_overlay_and_clears_deferred_history`（`app.rs:10610-10661`）：非待处理回退正确截断 transcript、同步 overlay 并清空缓冲区

### 10. 配置刷新

- `refresh_in_memory_config_from_disk_loads_latest_apps_state`（`app.rs:10010-10047`）：从磁盘重新加载后能看到新写入的 apps 配置
- `refresh_in_memory_config_from_disk_best_effort_keeps_current_config_on_error`（`app.rs:10049-10063`）：配置文件损坏时保持当前配置不变
- `refresh_in_memory_config_from_disk_uses_active_chat_widget_cwd`（`app.rs:10065-10101`）：使用 ChatWidget 的当前 cwd（可能已通过 SessionConfigured 事件变更）而非 App 的初始 cwd
- `rebuild_config_for_resume_or_fallback_uses_current_config_on_same_cwd_error`：cwd 未变时使用当前配置降级
- `rebuild_config_for_resume_or_fallback_errors_when_cwd_changes`：cwd 变更且配置加载失败时报错

### 11. 其他功能

**主题同步**：`sync_tui_theme_selection_updates_chat_widget_config_copy`（`app.rs:10139-10150`）验证主题切换同时更新 App.config 和 ChatWidget 的配置副本。

**推理强度与协作模式**：`update_reasoning_effort_updates_collaboration_mode`（`app.rs:9992-10008`）确认修改 reasoning effort 同步到 config 和 ChatWidget。

**会话摘要格式化**（`app.rs:10878-10928`）：
- 零 token 使用时返回 None
- 正常使用时包含 usage 行和 `codex resume <id>` 命令
- 有 thread_name 时优先使用名称而非 UUID

**Clear-UI Header**（`app.rs:8895-9055`）：`clear_ui_after_long_transcript_snapshots_fresh_header_only` 验证 Ctrl+L 清屏后只保留新的 session header，不重放旧的对话轮次和启动提示。使用 insta 快照断言精确输出。

**关闭意图路由**（`app.rs:8814-8893`）：`active_non_primary_shutdown_target` 系列测试验证关闭事件的路由逻辑——主线程关闭不触发切换，非主线程关闭触发回到 primary，已有 pending shutdown 时不重复切换。

**反馈提交**（`app.rs:9446-9569`）：验证反馈参数构建、错误历史 cell 生成、以及跨线程反馈回放。

## 测试模式与设计特点

1. **Channel 驱动断言**：大多数异步测试通过 `app_event_rx` / `op_rx` channel 收集 App 发出的事件和操作，然后进行断言，避免了直接检查 App 内部状态的脆弱性。

2. **Insta 快照测试**：UI 渲染相关测试使用 `assert_snapshot!` 进行精确的视觉回归检测，如 `agent_picker_item_name`、`clear_ui_after_long_transcript_fresh_header_only` 等。

3. **平台条件跳过**：涉及路径渲染的快照测试通过 `#[cfg_attr(target_os = "windows", ignore)]` 跳过 Windows 平台。

4. **嵌入式 App Server**：部分测试（如 Agent Picker 相关）启动真实的嵌入式 app-server（`start_embedded_app_server_for_picker`），确保端到端行为正确。

5. **超时保护**：异步操作使用 `tokio::time::timeout(Duration::from_millis(50), ...)` 防止测试挂起。