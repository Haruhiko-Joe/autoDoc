# 事件处理（EventProcessing）

## 概述与职责

EventProcessing 模块是 SessionEngine 子系统中负责**响应流事件处理和用户可见内容映射**的核心组件。它位于模型流式响应与上层 TUI/消费者之间，完成三项关键任务：

1. **流事件工具分发**（`stream_events_utils`）：接收模型输出的每个完成项，判断是工具调用还是普通消息，分别路由到工具执行管线或转换为 TurnItem 发射给消费者。
2. **事件映射**（`event_mapping`）：将底层 `ResponseItem`（模型原始输出）映射为用户可见的 `TurnItem`（消息、推理、Web 搜索、图片生成），并过滤掉系统注入的上下文消息。
3. **子代理委托**（`codex_delegate`）：启动交互式子 Codex 线程，在父子会话之间双向转发事件和操作，同时拦截审批请求路由到父会话或 Guardian 审查系统。

在整体架构中，EventProcessing 属于 **Core → SessionEngine** 层级。Core 是 Codex 的代理编排引擎，SessionEngine 是其核心会话循环，而 EventProcessing 处理该循环中模型响应到达后的"最后一公里"——将原始流事件转化为有意义的用户界面更新和工具执行。同级模块包括 Protocol（类型定义）、ToolsOrchestration（工具执行）、ContextManagement（上下文管理）等。

---

## 关键流程

### 1. 模型输出项完成处理（handle_output_item_done）

这是流事件处理的核心入口，处理模型流中每个完成的 `ResponseItem`：

1. 调用 `ToolRouter::build_tool_call()` 判断该项是否为工具调用（`stream_events_utils.rs:213`）
2. **如果是工具调用**：
   - 接受当前 turn 的邮箱投递（`accept_mailbox_delivery_for_current_turn`）
   - 记录工具调用日志
   - 持久化该 ResponseItem（`record_completed_response_item`）
   - 创建工具执行 Future 并返回，标记 `needs_follow_up = true`
3. **如果不是工具调用**：
   - 调用 `handle_non_tool_response_item()` 转换为 `TurnItem`
   - 发射 `turn_item_started` 和 `turn_item_completed` 事件给消费者
   - 持久化并提取最后的助手消息文本
4. **错误情况**：
   - `MissingLocalShellCallId`：记录错误，生成空的 FunctionCallOutput 反馈到历史
   - `RespondToModel`：工具被拒绝或需直接回复，将消息推入对话记录
   - `Fatal`：返回致命错误

```
ToolRouter::build_tool_call(item)
  ├─ Ok(Some(call))  → 持久化 + 排队工具执行
  ├─ Ok(None)        → 转换为 TurnItem + 发射事件
  ├─ Err(MissingId)  → 错误恢复 + needs_follow_up
  ├─ Err(Respond)    → 拒绝/直接回复 + needs_follow_up
  └─ Err(Fatal)      → 返回 CodexErr::Fatal
```

### 2. 非工具响应项处理（handle_non_tool_response_item）

处理不涉及工具调用的模型输出（`stream_events_utils.rs:333-422`）：

- **Message / Reasoning / WebSearchCall / ImageGenerationCall**：通过 `parse_turn_item()` 转换为对应的 `TurnItem`
- 对 **AgentMessage**：合并文本内容，调用 `strip_hidden_assistant_markup_and_parse_memory_citation()` 去除引用标记和计划模式标签，提取记忆引用
- 对 **ImageGeneration**：将 base64 图片数据解码保存为 PNG 文件到 `~/.codex/generated_images/<session_id>/<call_id>.png`，并注入开发者指令告知模型图片存储路径
- 工具输出类型（`FunctionCallOutput` 等）：记录警告日志并忽略（不应从流中出现）

### 3. ResponseItem → TurnItem 映射（parse_turn_item）

`event_mapping.rs:135-209` 中的核心映射逻辑：

| ResponseItem 类型 | TurnItem 类型 | 说明 |
|---|---|---|
| `Message { role: "user" }` | `UserMessage` 或 `HookPrompt` | 先尝试解析为 hook prompt，否则作为用户消息（过滤上下文注入消息） |
| `Message { role: "assistant" }` | `AgentMessage` | 提取文本内容，保留 phase 和 id |
| `Message { role: "system" }` | `None` | 系统消息不展示 |
| `Reasoning` | `Reasoning` | 提取摘要文本和原始推理内容 |
| `WebSearchCall` | `WebSearch` | 提取搜索动作和查询文本 |
| `ImageGenerationCall` | `ImageGeneration` | 映射状态、修订 prompt、结果 |

### 4. 上下文消息过滤

`event_mapping.rs` 提供了一套用于识别和过滤系统上下文消息的工具函数：

- `is_contextual_user_message_content()`：识别系统注入的用户消息（`event_mapping.rs:35-37`）
- `is_contextual_dev_message_content()`：识别包含 `<permissions instructions>`、`<model_switch>`、`<collaboration_mode>` 等前缀的开发者消息（`event_mapping.rs:44-46`）
- `has_non_contextual_dev_message_content()`：判断开发者消息中是否有非上下文片段（`event_mapping.rs:50-54`）

这些函数确保注入到对话中的系统指令不会被展示给用户。

### 5. 子代理委托流程（codex_delegate）

`run_codex_thread_interactive()` 启动一个完整的子 Codex 会话（`codex_delegate.rs:63-139`）：

1. **创建子 Codex 实例**：复用父会话的 skills、plugins、MCP manager 和 exec policy
2. **启动事件转发任务**（`forward_events`）：
   - 过滤掉 delta 事件、token 计数、session 配置、线程名更新等内部事件
   - **拦截审批请求**（`ExecApprovalRequest`、`ApplyPatchApprovalRequest`、`RequestPermissions`、`RequestUserInput`），路由到父会话处理
   - 缓存 `McpToolCallBegin` 事件中的调用上下文，供后续 MCP 审批使用
   - 其余事件透传给消费者
3. **启动操作转发任务**（`forward_ops`）：将调用方的 Op 转发到子代理
4. **返回桥接的 Codex 实例**：交换 tx/rx 通道，使调用方通过统一接口与子代理交互

```
父会话 ──Op──→ forward_ops ──→ 子 Codex
父会话 ←─Event─ forward_events ←── 子 Codex
                    │
                    ├─ 审批事件 → 父会话/Guardian 处理
                    └─ 其他事件 → 透传给消费者
```

### 6. 审批路由与 Guardian 集成

子代理的审批请求通过以下路径处理：

- **Shell 执行审批**（`handle_exec_approval`，`codex_delegate.rs:421-499`）：
  - 若 `routes_approval_to_guardian()` 返回 true，异步启动 Guardian 审查（在独立线程的 tokio runtime 中运行）
  - 否则通过父会话的 `request_command_approval()` 上报用户
  - 审批结果通过 `Op::ExecApproval` 回传子代理

- **Patch 审批**（`handle_patch_approval`，`codex_delegate.rs:502-601`）：
  - Guardian 模式下，重建 patch 文本供审查
  - 非 Guardian 模式或路径解析失败时，回退到父会话的 `request_patch_approval()`

- **MCP 工具审批**（`maybe_auto_review_mcp_request_user_input`，`codex_delegate.rs:648-716`）：
  - 拦截 `RequestUserInput` 中的 MCP 工具审批问题
  - 从缓存的 `pending_mcp_invocations` 中还原完整调用上下文
  - 由 Guardian 自动审查并生成对应的批准/拒绝响应

所有审批等待均通过 `await_approval_with_cancel()` 包装，支持 CancellationToken 取消（`codex_delegate.rs:825-850`），取消时发送 `ReviewDecision::Abort` 通知父会话。

### 7. One-Shot 子代理模式

`run_codex_thread_one_shot()`（`codex_delegate.rs:145-220`）在交互模式基础上提供单次执行语义：

1. 调用 `run_codex_thread_interactive()` 创建子代理
2. 立即发送 `Op::UserInput` 启动 turn
3. 启动桥接任务监听事件，收到 `TurnComplete` 或 `TurnAborted` 后自动发送 `Op::Shutdown` 并取消子 token
4. 返回的 Codex 实例的 `tx_sub` 是已关闭的通道，防止调用方追加操作

---

## 函数签名与参数说明

### stream_events_utils

#### `handle_output_item_done(ctx: &mut HandleOutputCtx, item: ResponseItem, previously_active_item: Option<TurnItem>) -> Result<OutputItemResult>`

模型流输出项的主处理函数。

- **ctx**：包含 session、turn context、工具运行时和取消 token 的上下文
- **item**：模型完成的响应项
- **previously_active_item**：当前正在流式输出的活跃 TurnItem（非首次则跳过 `turn_item_started` 事件）
- **返回**：`OutputItemResult`，包含最后的助手消息、是否需要后续 turn、以及可选的工具执行 Future

> 源码位置：`codex-rs/core/src/stream_events_utils.rs:205-331`

#### `handle_non_tool_response_item(sess: &Session, turn_context: &TurnContext, item: &ResponseItem, plan_mode: bool) -> Option<TurnItem>`

将非工具调用的 ResponseItem 转换为 TurnItem，处理文本清理和图片保存。

> 源码位置：`codex-rs/core/src/stream_events_utils.rs:333-422`

#### `record_completed_response_item(sess: &Session, turn_context: &TurnContext, item: &ResponseItem)`

持久化完成的模型响应项，同时处理邮箱投递延迟、Web 搜索的记忆污染标记、以及 stage1 输出使用记录。

> 源码位置：`codex-rs/core/src/stream_events_utils.rs:126-142`

#### `raw_assistant_output_text_from_item(item: &ResponseItem) -> Option<String>`

从助手消息 ResponseItem 中提取原始文本（未经清理），合并所有 `OutputText` content item。

> 源码位置：`codex-rs/core/src/stream_events_utils.rs:90-104`

#### `response_input_to_response_item(input: &ResponseInputItem) -> Option<ResponseItem>`

将 `ResponseInputItem`（工具输出等）转换回 `ResponseItem`，用于记录到对话历史。支持 `FunctionCallOutput`、`CustomToolCallOutput`、`McpToolCallOutput`、`ToolSearchOutput`。

> 源码位置：`codex-rs/core/src/stream_events_utils.rs:459-496`

### event_mapping

#### `parse_turn_item(item: &ResponseItem) -> Option<TurnItem>`

核心映射函数，将 `ResponseItem` 转换为用户可见的 `TurnItem`。这是一个 `pub` 函数，供模块外部使用。

> 源码位置：`codex-rs/core/src/event_mapping.rs:135-209`

#### `is_contextual_user_message_content(message: &[ContentItem]) -> bool`

判断用户消息内容是否为系统注入的上下文消息。

> 源码位置：`codex-rs/core/src/event_mapping.rs:35-37`

#### `is_contextual_dev_message_content(message: &[ContentItem]) -> bool`

判断开发者消息是否包含可回滚的上下文片段（权限指令、模型切换、协作模式等）。

> 源码位置：`codex-rs/core/src/event_mapping.rs:44-46`

### codex_delegate

#### `run_codex_thread_interactive(config, auth_manager, models_manager, parent_session, parent_ctx, cancel_token, subagent_source, initial_history) -> Result<Codex, CodexErr>`

启动交互式子 Codex 线程，返回可双向通信的 `Codex` 实例。审批请求自动路由到父会话。

> 源码位置：`codex-rs/core/src/codex_delegate.rs:63-139`

#### `run_codex_thread_one_shot(config, auth_manager, models_manager, input, parent_session, parent_ctx, cancel_token, subagent_source, final_output_json_schema, initial_history) -> Result<Codex, CodexErr>`

One-shot 模式：启动子代理，发送初始输入，turn 完成后自动关闭。返回的 Codex 的提交通道已关闭。

> 源码位置：`codex-rs/core/src/codex_delegate.rs:145-220`

---

## 接口/类型定义

### `HandleOutputCtx`

模型输出处理的上下文容器（`stream_events_utils.rs:197-202`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sess` | `Arc<Session>` | 当前会话引用 |
| `turn_context` | `Arc<TurnContext>` | 当前 turn 的上下文（配置、环境、协作模式等） |
| `tool_runtime` | `ToolCallRuntime` | 工具调用执行运行时（可 clone） |
| `cancellation_token` | `CancellationToken` | 取消信号，用于中止工具执行 |

### `OutputItemResult`

单个输出项的处理结果（`stream_events_utils.rs:191-195`）：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `last_agent_message` | `Option<String>` | `None` | 最后一条清理后的助手消息文本 |
| `needs_follow_up` | `bool` | `false` | 是否需要后续 turn（工具调用或错误恢复） |
| `tool_future` | `Option<InFlightFuture<'static>>` | `None` | 正在执行的工具调用 Future |

### `InFlightFuture<'f>`

工具执行的异步 Future 类型别名：

```rust
pub(crate) type InFlightFuture<'f> =
    Pin<Box<dyn Future<Output = Result<ResponseInputItem>> + Send + 'f>>;
```

### 上下文开发者消息前缀（CONTEXTUAL_DEVELOPER_PREFIXES）

用于识别系统注入消息的前缀列表（`event_mapping.rs:27-33`）：

- `<permissions instructions>`
- `<model_switch>`
- `<collaboration_mode>` （COLLABORATION_MODE_OPEN_TAG）
- `<realtime_conversation>` （REALTIME_CONVERSATION_OPEN_TAG）
- `<personality_spec>`

---

## 配置项与默认值

- **图片生成保存路径**：`~/.codex/generated_images/<session_id>/<call_id>.png`，由常量 `GENERATED_IMAGE_ARTIFACTS_DIR = "generated_images"` 定义（`stream_events_utils.rs:35`）
- **记忆污染检查**：受 `config.memories.no_memories_if_mcp_or_web_search` 控制，若为 true 且出现 WebSearchCall，标记线程记忆模式为 polluted（`stream_events_utils.rs:149-153`）
- **子代理通道容量**：使用 `SUBMISSION_CHANNEL_CAPACITY` 常量（从 `crate::codex` 导入）
- **委托关闭超时**：`shutdown_delegate` 等待 500ms 排空事件（`codex_delegate.rs:377`）

---

## 边界 Case 与注意事项

- **Plan 模式特殊处理**：当 `collaboration_mode.mode == ModeKind::Plan` 时，助手文本额外调用 `strip_proposed_plan_blocks()` 去除计划标签块，并且邮箱投递延迟逻辑中 Commentary phase 的消息不触发延迟（`stream_events_utils.rs:441-457`）
- **图片保存失败不中断流程**：`save_image_generation_result` 失败时仅记录 warn 日志，不影响 TurnItem 的发射（`stream_events_utils.rs:395-409`）
- **路径消毒**：`image_generation_artifact_path` 对 session_id 和 call_id 进行字符消毒，非字母数字和 `-_` 的字符替换为 `_`（`stream_events_utils.rs:42-57`）
- **Guardian 审查在独立线程运行**：`spawn_guardian_review` 使用 `std::thread::spawn` 创建新线程和独立 tokio runtime（`codex_delegate.rs:726-743`），避免阻塞父会话的 async 执行器
- **MCP 审批上下文重建**：由于 `RequestUserInput` 事件只携带 `call_id`，需从之前缓存的 `McpToolCallBegin` 事件中还原完整的调用信息才能进行 Guardian 审查（`codex_delegate.rs:641-647`）
- **取消语义**：所有审批等待使用 biased `tokio::select!` 优先检查取消，确保父 token 取消时子代理及时收到 Abort 决定并关闭
- **One-Shot 通道关闭**：one-shot 模式返回的 Codex 的 `tx_sub` 是立即关闭的通道，任何后续 submit 都会失败，这是刻意设计防止误用（`codex_delegate.rs:210-211`）