# RealtimeClient

## 概述与职责

RealtimeClient 是 Codex 中用于与 Realtime API 建立 WebSocket 连接的客户端模块，位于 `codex-api` crate 的 `endpoint::realtime_websocket` 路径下。它在 **ModelProviders → ApiClient** 层级中，为上层的 Core 引擎提供实时双向通信能力，支持音频流和文本流的收发、会话配置、对话项管理以及响应生成触发。

该模块的核心设计特点是**版本化的线协议支持**：通过 `RealtimeEventParser` 枚举区分 V1（Quicksilver）和 V2（Realtime）两套协议，在连接建立、消息编码、事件解析等各环节实现版本分派，让上层调用者无需感知协议差异。

同级兄弟模块包括 HttpTransport（HTTP 传输层）、ModelsManager（模型发现与选择）、ProviderRegistry（提供商注册）等。

## 模块结构

模块采用公开接口 + 内部版本分派的组织方式，共 9 个文件：

| 文件 | 职责 |
|------|------|
| `mod.rs` | 模块入口，声明子模块并 re-export 公开类型 |
| `protocol.rs` | 协议层核心类型定义和版本分派入口 |
| `protocol_common.rs` | V1/V2 共享的事件解析辅助函数 |
| `protocol_v1.rs` | V1 协议的入站事件解析器 |
| `protocol_v2.rs` | V2 协议的入站事件解析器 |
| `methods.rs` | WebSocket 客户端、连接、读写器的实现 |
| `methods_common.rs` | V1/V2 共享的出站消息构建和版本分派 |
| `methods_v1.rs` | V1 协议的出站消息构建 |
| `methods_v2.rs` | V2 协议的出站消息构建 |

## 关键流程

### 连接建立流程

1. `RealtimeWebsocketClient::new(provider)` 创建客户端实例，持有 `Provider`（包含 base_url、headers、认证信息等）
2. 调用 `client.connect(config, extra_headers, default_headers)` 开始连接：
   - 调用 `websocket_url_from_api_url()` 将 HTTP/HTTPS URL 转换为 WS/WSS URL，自动补全 `/v1/realtime` 路径，并根据协议版本添加 `intent` 查询参数（V1 使用 `intent=quicksilver`，V2 不添加）（`methods.rs:547-597`）
   - 合并 provider headers、extra headers、default headers（优先级：extra > provider > default）（`methods.rs:512-525`）
   - 如果配置了 `session_id`，添加 `x-session-id` 请求头（`methods.rs:527-541`）
   - 支持自定义 CA 证书的 TLS 连接（`methods.rs:481-483`）
   - 通过 `tokio_tungstenite` 建立 WebSocket 连接
3. 连接成功后创建 `WsStream` 泵任务（pump task），分离读写通道
4. 自动发送 `session.update` 消息完成会话初始化（`methods.rs:504-507`）
5. 返回 `RealtimeWebsocketConnection`，可拆分为独立的 `RealtimeWebsocketWriter` 和 `RealtimeWebsocketEvents`

### WsStream 消息泵机制

`WsStream` 是内部的 WebSocket 连接包装器，通过一个后台 tokio 任务（pump task）统一管理读写，解决了 WebSocket 流的独占借用问题（`methods.rs:58-182`）：

- **写入端**：通过 `mpsc::channel<WsCommand>` 接收 `Send` 和 `Close` 命令，每个命令附带 `oneshot::Sender` 用于返回结果
- **读取端**：通过 `mpsc::unbounded_channel` 将收到的消息推送给 `RealtimeWebsocketEvents`
- 泵任务使用 `tokio::select!` 同时监听命令通道和 WebSocket 入站消息，确保发送和接收互不阻塞
- 自动处理 Ping/Pong 心跳，Close 帧触发退出，Binary 帧记录错误日志

### 入站事件解析流程

`RealtimeWebsocketEvents::next_event()` 循环等待入站消息（`methods.rs:350-398`）：

1. 从 `rx_message` 接收 WebSocket 帧
2. 对 Text 帧调用 `parse_realtime_event(payload, event_parser)` 进行版本分派解析（`protocol.rs:215-223`）
3. 解析成功后调用 `update_active_transcript()` 维护活跃转录状态（`methods.rs:400-422`）
4. Close 帧标记连接关闭并返回 `None`
5. Binary 帧返回 `Error` 事件
6. 不可识别的 Text 帧被静默跳过（继续循环）

### 活跃转录追踪

`RealtimeWebsocketEvents` 内部维护一个 `ActiveTranscriptState`，按角色（user/assistant）累积转录文本增量（`methods.rs:400-441`）：

- `InputTranscriptDelta` → 追加到 "user" 角色条目
- `OutputTranscriptDelta` → 追加到 "assistant" 角色条目
- 当 V1 协议的 `HandoffRequested` 事件到达时，将累积的转录历史附加到 handoff 事件中，然后清空状态

这使得 handoff 场景下 Codex agent 能获得完整的对话上下文。

## 协议版本差异

### V1（Quicksilver）

- **会话类型**：`quicksilver`
- **WebSocket intent**：`intent=quicksilver` 查询参数
- **语音**：Fathom
- **不支持** 噪声抑制、VAD 转检测、工具注册
- **session mode**：始终强制为 `Conversational`，忽略 Transcription 模式
- **Handoff 消息**：使用专用的 `conversation.handoff.append` 事件类型
- **对话项内容类型**：`text`

**V1 解析的事件类型**（`protocol_v1.rs:11-84`）：

| 事件类型 | 解析为 |
|----------|--------|
| `session.updated` | `RealtimeEvent::SessionUpdated` |
| `conversation.output_audio.delta` | `RealtimeEvent::AudioOut` |
| `conversation.input_transcript.delta` | `RealtimeEvent::InputTranscriptDelta` |
| `conversation.output_transcript.delta` | `RealtimeEvent::OutputTranscriptDelta` |
| `conversation.item.added` | `RealtimeEvent::ConversationItemAdded` |
| `conversation.item.done` | `RealtimeEvent::ConversationItemDone` |
| `conversation.handoff.requested` | `RealtimeEvent::HandoffRequested` |
| `error` | `RealtimeEvent::Error` |

### V2（Realtime）

- **会话类型**：`realtime`（对话模式）或 `transcription`（转录模式）
- **WebSocket intent**：无（不发送 intent 参数）
- **语音**：Marin
- **支持** 近场噪声抑制（`near_field`）、Server VAD 转检测（自动中断和创建响应）
- **工具注册**：自动注册 `codex` function tool，tool_choice 设为 `auto`
- **Handoff 机制**：通过 `conversation.item.done` 或 `response.done` 中的 `function_call` 类型项检测，工具名为 `codex`
- **Handoff 响应**：使用 `conversation.item.create` 发送 `function_call_output` 类型项
- **对话项内容类型**：`input_text`
- **音频默认值**：采样率 24000Hz，单声道（当服务端未返回时使用默认值）

**V2 额外支持的事件类型**（`protocol_v2.rs:19-74`）：

| 事件类型 | 解析为 |
|----------|--------|
| `response.output_audio.delta` / `response.audio.delta` | `RealtimeEvent::AudioOut` |
| `conversation.item.input_audio_transcription.completed` | `RealtimeEvent::InputTranscriptDelta` |
| `response.output_text.delta` / `response.output_audio_transcript.delta` | `RealtimeEvent::OutputTranscriptDelta` |
| `input_audio_buffer.speech_started` | `RealtimeEvent::InputAudioSpeechStarted` |
| `response.created` | `RealtimeEvent::ConversationItemAdded` |
| `response.done` | `RealtimeEvent::HandoffRequested`（含 codex 工具调用时）或 `ConversationItemAdded` |
| `response.cancelled` | `RealtimeEvent::ResponseCancelled` |

## 公开 API

### `RealtimeWebsocketClient`

```rust
pub struct RealtimeWebsocketClient { /* provider: Provider */ }
```

| 方法 | 签名 | 说明 |
|------|------|------|
| `new` | `fn new(provider: Provider) -> Self` | 从 Provider 创建客户端 |
| `connect` | `async fn connect(&self, config: RealtimeSessionConfig, extra_headers: HeaderMap, default_headers: HeaderMap) -> Result<RealtimeWebsocketConnection, ApiError>` | 建立 WebSocket 连接并完成会话初始化 |

> 源码位置：`methods.rs:443-509`

### `RealtimeWebsocketConnection`

连接的统一入口，持有 writer 和 events 两个组件。支持拆分为独立的读写句柄：

| 方法 | 说明 |
|------|------|
| `writer()` | 返回可 Clone 的 `RealtimeWebsocketWriter` |
| `events()` | 返回可 Clone 的 `RealtimeWebsocketEvents` |
| `send_audio_frame(frame)` | 委托给 writer |
| `send_conversation_item_create(text)` | 委托给 writer |
| `send_conversation_handoff_append(handoff_id, output_text)` | 委托给 writer |
| `close()` | 委托给 writer |
| `next_event()` | 委托给 events |

> 源码位置：`methods.rs:190-271`

### `RealtimeWebsocketWriter`

可 Clone 的写入句柄，所有方法均为 `async`：

| 方法 | 签名 | 说明 |
|------|------|------|
| `send_audio_frame` | `async fn send_audio_frame(&self, frame: RealtimeAudioFrame) -> Result<(), ApiError>` | 发送音频帧（base64 编码的 PCM 数据） |
| `send_conversation_item_create` | `async fn send_conversation_item_create(&self, text: String) -> Result<(), ApiError>` | 发送文本对话项 |
| `send_conversation_handoff_append` | `async fn send_conversation_handoff_append(&self, handoff_id: String, output_text: String) -> Result<(), ApiError>` | 发送 handoff 响应（自动添加 `"Agent Final Message"` 前缀） |
| `send_response_create` | `async fn send_response_create(&self) -> Result<(), ApiError>` | 触发服务端生成响应 |
| `send_session_update` | `async fn send_session_update(&self, instructions: String, session_mode: RealtimeSessionMode) -> Result<(), ApiError>` | 更新会话配置 |
| `send_payload` | `async fn send_payload(&self, payload: String) -> Result<(), ApiError>` | 发送原始 JSON 字符串 |
| `close` | `async fn close(&self) -> Result<(), ApiError>` | 关闭连接（幂等） |

> 源码位置：`methods.rs:273-347`

### `RealtimeWebsocketEvents`

可 Clone 的事件读取句柄：

| 方法 | 签名 | 说明 |
|------|------|------|
| `next_event` | `async fn next_event(&self) -> Result<Option<RealtimeEvent>, ApiError>` | 等待下一个解析后的事件，连接关闭时返回 `Ok(None)` |

> 源码位置：`methods.rs:349-398`

## 类型定义

### `RealtimeSessionConfig`

```rust
pub struct RealtimeSessionConfig {
    pub instructions: String,          // 会话指令/系统提示
    pub model: Option<String>,         // 模型名称，添加为 URL 查询参数
    pub session_id: Option<String>,    // 会话 ID，添加为 x-session-id 请求头
    pub event_parser: RealtimeEventParser,  // 协议版本
    pub session_mode: RealtimeSessionMode,  // 会话模式
}
```

> 源码位置：`protocol.rs:23-30`

### `RealtimeEventParser`

```rust
pub enum RealtimeEventParser {
    V1,          // Quicksilver 协议
    RealtimeV2,  // Realtime V2 协议
}
```

> 源码位置：`protocol.rs:11-15`

### `RealtimeSessionMode`

```rust
pub enum RealtimeSessionMode {
    Conversational,  // 对话模式（音频输入+输出，工具调用）
    Transcription,   // 转录模式（仅音频输入，无输出/工具）
}
```

> 源码位置：`protocol.rs:17-21`

### `RealtimeOutboundMessage`

内部使用的出站消息枚举，通过 serde 的 `tag = "type"` 序列化为 JSON（`protocol.rs:32-48`）：

- `InputAudioBufferAppend` → `input_audio_buffer.append`
- `ConversationHandoffAppend` → `conversation.handoff.append`（仅 V1）
- `ResponseCreate` → `response.create`
- `SessionUpdate` → `session.update`
- `ConversationItemCreate` → `conversation.item.create`

## 配置项与默认值

| 常量 | 值 | 说明 |
|------|-----|------|
| `REALTIME_AUDIO_SAMPLE_RATE` | 24000 | 音频采样率（Hz） |
| `DEFAULT_AUDIO_SAMPLE_RATE`（V2） | 24000 | V2 音频帧缺省采样率 |
| `DEFAULT_AUDIO_CHANNELS`（V2） | 1 | V2 音频帧缺省声道数 |
| `AGENT_FINAL_MESSAGE_PREFIX` | `"Agent Final Message":\n\n` | Handoff 响应前缀 |
| `REALTIME_V2_CODEX_TOOL_NAME` | `codex` | V2 注册的工具名 |
| `REALTIME_V2_TOOL_CHOICE` | `auto` | V2 工具选择策略 |

音频格式固定为 `audio/pcm`。V1 使用 Fathom 语音，V2 使用 Marin 语音。

## 边界 Case 与注意事项

- **V1 不支持 Transcription 模式**：`normalized_session_mode()` 将 V1 的任何 session_mode 强制为 `Conversational`（`methods_common.rs:17-25`）
- **连接关闭幂等**：`RealtimeWebsocketWriter::close()` 使用 `AtomicBool` 确保多次调用不会重复发送 Close 帧，`ConnectionClosed` 和 `AlreadyClosed` 错误被静默忽略（`methods.rs:313-325`）
- **Handoff 工具调用识别**：V2 通过检测 `function_call` 类型且 `name == "codex"` 的 item 来识别 handoff 请求。参数提取尝试多个 key（`input_transcript`、`input`、`text`、`prompt`、`query`），增强了对不同调用方式的兼容性（`protocol_v2.rs:169-188`）
- **V2 Handoff 的双路径检测**：handoff 事件可能出现在 `conversation.item.done` 或 `response.done` 两种事件中，后者需要遍历 `response.output` 数组查找 codex 工具调用（`protocol_v2.rs:107-141`）
- **读写分离不阻塞**：`WsStream` 的泵设计确保 `send_audio_frame()` 不会因为 `next_event()` 正在等待入站数据而阻塞（端到端测试 `send_does_not_block_while_next_event_waits_for_inbound_data` 验证了此行为）
- **URL 路径自动补全**：`normalize_realtime_path()` 处理多种 base URL 格式（空路径、以 `/v1` 结尾、以 `/realtime/` 结尾等），确保最终路径始终为 `.../v1/realtime`（`methods.rs:599-623`）
- **TLS 支持自定义 CA**：通过 `maybe_build_rustls_client_config_with_custom_ca()` 支持自定义 CA 证书，与 Codex 其他 HTTPS 流量共享相同的证书配置