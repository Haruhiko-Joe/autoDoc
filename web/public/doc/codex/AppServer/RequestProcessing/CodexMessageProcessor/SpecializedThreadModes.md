# 专用线程模式：实时音频与代码审查

## 概述与职责

本模块实现了 `CodexMessageProcessor` 中两种超越标准文本对话轮次的**专用线程交互模式**：

1. **实时音频会话（Realtime）**：通过 WebSocket 进行流式音频/文本交互，支持语音对话场景
2. **代码审查工作流（Review）**：在已有线程内或独立派生线程中发起代码审查

在整体架构中，本模块属于 **AppServer → RequestProcessing → CodexMessageProcessor** 层级。它是 `CodexMessageProcessor`（约 9600 行）的一部分，与 MessageProcessor 的请求路由、BespokeEventHandling 的事件转译、ThreadStateManagement 的线程状态追踪协同工作。同级模块包括 MessageProcessor（顶层路由）、BespokeEventHandling（事件翻译层）和 ThreadStateManagement（线程状态管理）。

## 关键流程

### 实时音频会话流程

所有实时操作共享一个统一的前置校验步骤 `prepare_realtime_conversation_thread`，随后各自提交不同的 `Op` 到 Codex 核心。

#### 1. 线程准备：`prepare_realtime_conversation_thread`

这是实时操作的公共入口守卫，完成三个关键检查（`codex_message_processor.rs:6695-6737`）：

1. **加载线程**：调用 `self.load_thread(thread_id)` 获取 `ThreadId` 和 `Arc<CodexThread>`
2. **绑定监听器**：调用 `ensure_conversation_listener` 将当前连接绑定到该线程的事件流（固定使用 V2 API，不启用 raw events）
3. **功能特性检查**：验证线程是否启用了 `Feature::RealtimeConversation`，未启用则返回 invalid request 错误

任一步骤失败都会通过 `outgoing.send_error` 向客户端回传错误并返回 `None`，调用方据此提前退出。

#### 2. 启动实时会话：`thread_realtime_start`

```rust
// codex_message_processor.rs:6739-6776
Op::RealtimeConversationStart(ConversationStartParams {
    prompt: params.prompt,
    session_id: params.session_id,
})
```

接收 `ThreadRealtimeStartParams`（包含 `prompt` 和 `session_id`），向核心提交 `Op::RealtimeConversationStart`。成功时返回默认的 `ThreadRealtimeStartResponse`。

#### 3. 追加音频数据：`thread_realtime_append_audio`

```rust
// codex_message_processor.rs:6778-6814
Op::RealtimeConversationAudio(ConversationAudioParams {
    frame: params.audio.into(),
})
```

将客户端发来的音频帧通过 `params.audio.into()` 转换后，以 `Op::RealtimeConversationAudio` 提交到核心。这是流式调用，客户端会持续发送音频块。

#### 4. 追加文本数据：`thread_realtime_append_text`

```rust
// codex_message_processor.rs:6816-6850
Op::RealtimeConversationText(ConversationTextParams { text: params.text })
```

与音频追加类似，但传输的是文本片段，用于在实时会话中混合文本输入。

#### 5. 停止实时会话：`thread_realtime_stop`

```rust
// codex_message_processor.rs:6852-6882
Op::RealtimeConversationClose
```

提交 `Op::RealtimeConversationClose` 结束当前实时会话，无需额外参数。

**统一错误处理模式**：四个实时操作（start/append_audio/append_text/stop）使用完全一致的结构——先 `prepare_realtime_conversation_thread`，再 `submit_core_op`，成功返回默认 response，失败返回 internal error。

---

### 代码审查工作流

审查流程支持两种交付模式，通过 `ReviewDelivery` 枚举控制分发路径。

#### 1. 入口：`review_start`

`review_start`（`codex_message_processor.rs:7071-7124`）是审查的统一入口：

1. 从 `ReviewStartParams` 解构出 `thread_id`、`target`、`delivery`
2. 调用 `load_thread` 加载父线程
3. 调用 `review_request_from_target` 验证并转换审查目标
4. 根据 `delivery` 字段分发到 `start_inline_review` 或 `start_detached_review`
   - `delivery` 默认值为 `ApiReviewDelivery::Inline`

#### 2. 目标转换：`review_request_from_target`

`review_request_from_target`（`codex_message_processor.rs:630-687`）完成 API 层类型到核心层类型的映射：

| API 目标类型 (`ApiReviewTarget`) | 核心目标类型 (`CoreReviewTarget`) | 验证规则 |
|---|---|---|
| `UncommittedChanges` | `UncommittedChanges` | 无需验证 |
| `BaseBranch { branch }` | `BaseBranch { branch }` | branch 不能为空（trim 后） |
| `Commit { sha, title }` | `Commit { sha, title }` | sha 不能为空；title 可选，空串视为 None |
| `Custom { instructions }` | `Custom { instructions }` | instructions 不能为空 |

转换完成后，调用 `codex_core::review_prompts::user_facing_hint` 生成用户可见的提示文本，与 `ReviewRequest` 一起返回。

#### 3. 内联审查：`start_inline_review`

`start_inline_review`（`codex_message_processor.rs:6921-6950`）在**已有的父线程**中直接发起审查轮次：

1. 调用 `submit_core_op` 向父线程提交 `Op::Review { review_request }`
2. 使用返回的 `turn_id` 和 display_text 构建合成 Turn
3. 通过 `emit_review_started` 将 `ReviewStartResponse` 发送给客户端
4. response 中的 `review_thread_id` 就是父线程 ID（因为审查就在原线程进行）

#### 4. 分离审查：`start_detached_review`

`start_detached_review`（`codex_message_processor.rs:6952-7069`）派生一个**独立的新线程**来执行审查，流程更为复杂：

1. **定位 rollout 路径**：优先从父线程获取 `rollout_path()`，否则通过 `find_thread_path_by_id_str` 在 codex_home 中查找
2. **模型覆盖**：如果配置中指定了 `review_model`，将其覆盖为新线程的模型配置
3. **派生线程**：调用 `thread_manager.fork_thread` 以 `ForkSnapshot::Interrupted` 快照模式创建新线程（不持久化扩展历史）
4. **绑定监听器**：为新线程绑定当前连接的事件监听器
5. **加载并广播摘要**：从 rollout 读取线程摘要，通过 `ThreadStartedNotification` 通知客户端新线程已创建
6. **提交审查操作**：向新线程提交 `Op::Review { review_request }`
7. **发送响应**：构建 Turn 并通过 `emit_review_started` 返回，此时 `review_thread_id` 是新线程的 ID

#### 5. 辅助函数

**`build_review_turn`**（`codex_message_processor.rs:6884-6904`）：构建一个合成的 `Turn` 对象用于审查响应。如果 `display_text` 非空，创建一个包含 `ThreadItem::UserMessage` 的 Turn（使用 `V2UserInput::Text`，`text_elements` 为空因为是合成文本）；否则 items 为空。Turn 状态固定为 `TurnStatus::InProgress`。

**`emit_review_started`**（`codex_message_processor.rs:6906-6919`）：将构建好的 Turn 和 `review_thread_id` 封装为 `ReviewStartResponse`，通过 `outgoing.send_response` 发送给发起审查请求的连接。

## 函数签名与参数说明

### 实时音频 API

| 方法 | 参数类型 | 核心 Op | 响应类型 |
|---|---|---|---|
| `prepare_realtime_conversation_thread` | `request_id`, `thread_id: &str` | — | `Option<(ThreadId, Arc<CodexThread>)>` |
| `thread_realtime_start` | `ThreadRealtimeStartParams { thread_id, prompt, session_id }` | `Op::RealtimeConversationStart` | `ThreadRealtimeStartResponse` |
| `thread_realtime_append_audio` | `ThreadRealtimeAppendAudioParams { thread_id, audio }` | `Op::RealtimeConversationAudio` | `ThreadRealtimeAppendAudioResponse` |
| `thread_realtime_append_text` | `ThreadRealtimeAppendTextParams { thread_id, text }` | `Op::RealtimeConversationText` | `ThreadRealtimeAppendTextResponse` |
| `thread_realtime_stop` | `ThreadRealtimeStopParams { thread_id }` | `Op::RealtimeConversationClose` | `ThreadRealtimeStopResponse` |

### 审查 API

| 方法 | 关键参数 | 返回值 |
|---|---|---|
| `review_start` | `ReviewStartParams { thread_id, target, delivery }` | void（通过 outgoing 发送） |
| `review_request_from_target` | `ApiReviewTarget` | `Result<(ReviewRequest, String), JSONRPCErrorError>` |
| `start_inline_review` | `parent_thread`, `review_request`, `display_text`, `parent_thread_id` | `Result<(), JSONRPCErrorError>` |
| `start_detached_review` | `parent_thread_id`, `parent_thread`, `review_request`, `display_text` | `Result<(), JSONRPCErrorError>` |
| `build_review_turn` | `turn_id: String`, `display_text: &str` | `Turn` |
| `emit_review_started` | `request_id`, `turn`, `review_thread_id` | void |

## 接口/类型定义

### `ApiReviewTarget`（来自 `codex_app_server_protocol`）

审查目标的四种变体：

- **`UncommittedChanges`**：审查工作区中未提交的变更
- **`BaseBranch { branch: String }`**：审查相对于指定基准分支的差异
- **`Commit { sha: String, title: Option<String> }`**：审查特定提交
- **`Custom { instructions: String }`**：自定义审查指令

### `ApiReviewDelivery`（来自 `codex_app_server_protocol`）

审查交付模式：

- **`Inline`**：在父线程内创建审查轮次（默认值）
- **`Detached`**：派生独立线程执行审查

### `ReviewStartResponse`

```rust
ReviewStartResponse {
    turn: Turn,              // 审查轮次（包含合成的用户消息）
    review_thread_id: String // 审查所在的线程 ID（inline 为父线程，detached 为新线程）
}
```

## 配置项与默认值

- **`review_model`**：可选配置项。分离审查模式下，如果设置了此字段，会覆盖新线程的 `model` 配置，允许审查使用不同于主对话的模型
- **`Feature::RealtimeConversation`**：线程级特性开关。实时音频操作要求线程启用此特性，否则返回 invalid request 错误
- **`delivery` 默认值**：`ReviewStartParams.delivery` 为 `None` 时默认使用 `ApiReviewDelivery::Inline`

## 边界 Case 与注意事项

- **实时会话的特性守卫**：每次实时操作（包括 append）都会重新调用 `prepare_realtime_conversation_thread` 进行完整校验，而非仅在 start 时校验一次。这意味着如果特性在会话中途被禁用，后续操作会立即失败
- **分离审查的快照模式**：`fork_thread` 使用 `ForkSnapshot::Interrupted` 模式，表示从父线程的中断点快照，且 `persist_extended_history` 设为 `false`，新线程不保留完整历史
- **rollout 路径回退**：分离审查中，如果 `parent_thread.rollout_path()` 为 `None`，会通过文件系统查找 `find_thread_path_by_id_str`，两者都失败才报错
- **摘要加载失败的容错**：分离审查加载线程摘要失败时仅打 warn 日志，不阻塞审查流程
- **输入清洗**：`review_request_from_target` 对所有字符串字段执行 trim 并检查空值，防止空白字符串通过验证
- **合成 Turn 的 text_elements 为空**：`build_review_turn` 中 `V2UserInput::Text` 的 `text_elements` 始终为空 `Vec`，因为审查提示文本是合成的，没有对应的 UI 元素范围