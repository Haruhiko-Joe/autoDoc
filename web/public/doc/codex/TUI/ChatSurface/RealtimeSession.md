# RealtimeSession — 实时语音会话管理

## 概述与职责

`realtime.rs` 是 TUI 层 **ChatSurface** 模块的一部分，负责管理 Codex TUI 中的**实时语音对话**功能。它定义了语音会话的生命周期状态机，管理麦克风采集与音频播放的平台相关资源，并将来自 Realtime API 的协议事件路由到对应的处理逻辑。

在整体架构中，本模块位于 `TUI → ChatSurface` 层级下。ChatSurface 是主聊天视口组件（ChatWidget），而 RealtimeSession 作为 ChatWidget 的扩展方法集和状态结构，为其提供语音对话能力。同级模块还包括 BottomPane（输入区）、ContentRendering（内容渲染管线）等。

> 源码位置：`codex-rs/tui/src/chatwidget/realtime.rs`（共 480 行）

## 关键类型定义

### `RealtimeConversationPhase`

四态枚举，描述语音会话的完整生命周期：

| 阶段 | 含义 |
|------|------|
| `Inactive`（默认） | 无活跃语音会话 |
| `Starting` | 已发起开始请求，等待服务端确认 |
| `Active` | 会话已建立，正在进行语音交互 |
| `Stopping` | 已发起关闭请求，等待服务端确认关闭 |

> 源码位置：`codex-rs/tui/src/chatwidget/realtime.rs:13-20`

### `RealtimeConversationUiState`

语音会话的完整 UI 状态，作为 ChatWidget 的字段存在：

| 字段 | 类型 | 平台 | 说明 |
|------|------|------|------|
| `phase` | `RealtimeConversationPhase` | 全平台 | 当前生命周期阶段 |
| `requested_close` | `bool` | 全平台 | 用户是否主动请求了关闭（用于区分主动 vs 被动关闭） |
| `session_id` | `Option<String>` | 全平台 | 服务端分配的会话 ID |
| `warned_audio_only_submission` | `bool` | 全平台 | 是否已提示过"语音模式下不可发文字"的警告 |
| `meter_placeholder_id` | `Option<String>` | 非 Linux | 录音电平指示器在 BottomPane 中的占位符 ID |
| `capture_stop_flag` | `Option<Arc<AtomicBool>>` | 非 Linux | 麦克风采集线程的停止信号 |
| `capture` | `Option<VoiceCapture>` | 非 Linux | 麦克风采集句柄 |
| `audio_player` | `Option<RealtimeAudioPlayer>` | 非 Linux | 音频播放句柄 |

> 源码位置：`codex-rs/tui/src/chatwidget/realtime.rs:22-36`

**关键方法**：
- `is_live()` — 当阶段为 `Starting`、`Active` 或 `Stopping` 时返回 `true`，表示会话"正在进行"（`realtime.rs:39-46`）
- `is_active()` — 仅在 `Active` 阶段返回 `true`，用于判断是否可以实际收发音频（仅非 Linux，`realtime.rs:49-51`）

### `RenderedUserMessageEvent` 与 `PendingSteerCompareKey`

这两个结构体用于实时模式下用户消息的渲染去重：

- `RenderedUserMessageEvent`：包含消息文本、远程图片 URL、本地图片路径和文本元素，完整描述一条用户消息的渲染数据（`realtime.rs:54-60`）
- `PendingSteerCompareKey`：用于匹配 pending steer 与已提交消息的轻量比较键，仅包含消息文本和图片数量（`realtime.rs:62-66`）

## 关键流程

### 1. 启动语音会话

调用 `start_realtime_conversation()`（`realtime.rs:222-235`）时：

1. 将 `phase` 设置为 `Starting`，重置所有临时状态
2. 设置底栏提示为 `/realtime → stop live voice`
3. 通过 `submit_op()` 向核心层发送 `AppCommand::realtime_conversation_start`，携带内置的语音提示词：`"You are in a realtime voice conversation in the Codex TUI. Respond conversationally and concisely."`
4. 请求 UI 重绘

### 2. 会话建立确认

当服务端响应 `RealtimeConversationStartedEvent` 时，`on_realtime_conversation_started()`（`realtime.rs:277-291`）执行：

1. 检查 `realtime_conversation_enabled()` 开关——若已禁用则立即请求关闭
2. 将 `phase` 推进到 `Active`，记录 `session_id`
3. 调用 `start_realtime_local_audio()` 启动本地音频采集与播放

### 3. 本地音频生命周期（非 Linux）

`start_realtime_local_audio()`（`realtime.rs:361-414`）是音频采集的核心：

1. 在 BottomPane 中插入录音电平指示器占位符（初始显示 `⠤⠤⠤⠤`）
2. 调用 `VoiceCapture::start_realtime()` 启动麦克风采集，失败时走 `fail_realtime_conversation` 路径
3. 获取停止标志（`Arc<AtomicBool>`）和峰值信号量
4. 若尚未创建，初始化 `RealtimeAudioPlayer`
5. 启动一个**独立线程**，每 60ms 轮询峰值并通过 `AppEvent::UpdateRecordingMeter` 更新电平指示器，直到停止标志被设置

```rust
// realtime.rs:397-413 — 电平指示器更新线程
std::thread::spawn(move || {
    let mut meter = crate::voice::RecordingMeterState::new();
    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        let meter_text = meter.next_text(peak.load(Ordering::Relaxed));
        app_event_tx.send(AppEvent::UpdateRecordingMeter {
            id: meter_placeholder_id.clone(),
            text: meter_text,
        });
        std::thread::sleep(Duration::from_millis(60));
    }
});
```

### 4. 处理实时事件流

`on_realtime_conversation_realtime()`（`realtime.rs:293-313`）是事件路由的中枢，按 `RealtimeEvent` 变体分派：

| 事件变体 | 处理逻辑 |
|----------|----------|
| `SessionUpdated` | 更新 `session_id` |
| `InputAudioSpeechStarted` | 打断当前音频播放（用户开口说话时停止 AI 语音） |
| `InputTranscriptDelta` | 忽略（无 UI 处理） |
| `OutputTranscriptDelta` | 忽略（无 UI 处理） |
| `AudioOut(frame)` | 将音频帧入队到 `RealtimeAudioPlayer` 播放 |
| `ResponseCancelled` | 打断音频播放 |
| `ConversationItemAdded` | 忽略 |
| `ConversationItemDone` | 忽略 |
| `HandoffRequested` | 忽略 |
| `Error(message)` | 调用 `fail_realtime_conversation` 显示错误并关闭 |

### 5. 停止语音会话

停止流程有两个入口：

- **用户主动停止**：`stop_realtime_conversation_from_ui()`（`realtime.rs:205-207`），通常由 `/realtime` 命令触发
- **电平指示器被删除**：`stop_realtime_conversation_for_deleted_meter()`（`realtime.rs:210-220`），当 meter 占位符被外部移除时触发

两者都调用 `request_realtime_conversation_close()`（`realtime.rs:237-256`），该方法：

1. 设置 `requested_close = true`，将 `phase` 推进到 `Stopping`
2. 发送 `AppCommand::realtime_conversation_close()` 到核心层
3. 调用 `stop_realtime_local_audio()` 停止麦克风和播放器
4. 清除底栏提示

### 6. 会话关闭确认

`on_realtime_conversation_closed()`（`realtime.rs:315-329`）处理服务端的关闭事件：

1. 调用 `reset_realtime_conversation_state()` 完全重置所有状态
2. 若关闭**非用户主动请求**且有非 `"error"` 的原因，显示信息消息告知用户

### 7. 实时模式下的文字输入拦截

`maybe_defer_user_message_for_realtime()`（`realtime.rs:179-199`）在语音会话活跃期间拦截文字消息提交：

1. 若会话未激活，直接放行消息
2. 否则将消息内容恢复到编辑器中（不发送）
3. 首次拦截时显示提示："Realtime voice mode is audio-only. Use /realtime to stop."
4. 后续拦截仅触发重绘，不重复警告

## 音频设备热重启

`restart_realtime_audio_device()`（`realtime.rs:420-445`，仅非 Linux）支持在会话活跃期间重启单个音频设备：

- `RealtimeAudioDeviceKind::Microphone`：停止麦克风后重新调用 `start_realtime_local_audio()`
- `RealtimeAudioDeviceKind::Speaker`：停止播放器后重新创建 `RealtimeAudioPlayer`

失败时走 `fail_realtime_conversation` 错误路径。

## 平台差异

本模块通过 `#[cfg(not(target_os = "linux"))]` / `#[cfg(target_os = "linux")]` 条件编译实现平台差异处理：

- **macOS / Windows**：完整的音频采集和播放功能，包括 `VoiceCapture`、`RealtimeAudioPlayer`、电平指示器线程
- **Linux**：所有音频相关方法为空实现（no-op），`RealtimeConversationUiState` 中不包含音频相关字段。协议层的启动/停止/事件路由仍然正常工作，但无本地音频 I/O

## 边界 Case 与注意事项

- **启动后立即禁用**：`on_realtime_conversation_started` 中检查 `realtime_conversation_enabled()`，若在 `Starting` 期间功能被禁用，会立即请求关闭而非进入 `Active` 状态
- **重复关闭保护**：`request_realtime_conversation_close()` 在 `is_live()` 为 `false` 时直接返回，避免重复操作
- **音频播放的懒初始化**：`RealtimeAudioPlayer` 在首次收到 `AudioOut` 帧时才创建（`enqueue_realtime_audio_out`，`realtime.rs:334-336`），也会在 `start_realtime_local_audio` 中预创建
- **语音打断机制**：当检测到用户开始说话（`InputAudioSpeechStarted`）或响应被取消（`ResponseCancelled`）时，调用 `player.clear()` 清空播放队列实现即时打断
- **非主动关闭的原因展示**：仅当关闭非用户请求且原因不是 `"error"` 时才显示关闭原因，避免错误消息重复（错误已由 `RealtimeEvent::Error` 处理）
- **电平指示器生命周期绑定**：meter 占位符被外部删除时会触发整个语音会话的关闭，确保 UI 状态一致性