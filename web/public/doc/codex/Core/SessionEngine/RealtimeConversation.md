# RealtimeConversation

## 概述与职责

RealtimeConversation 模块为 Codex 提供实时语音/文本对话能力，基于 OpenAI Realtime API 构建。它是 SessionEngine 的子模块，位于 Core 层中，与 ModelProviders 层的 WebSocket 客户端配合，实现了完整的实时会话生命周期管理。

该模块由两个核心文件组成：

- **`realtime_conversation.rs`**：`RealtimeConversationManager` 及其关联的会话启动、音频/文本路由、handoff 处理和优雅关闭逻辑
- **`realtime_context.rs`**：`build_realtime_startup_context()` 函数，负责在实时会话启动时构建注入给模型的上下文信息

同层级的兄弟模块包括 Protocol（共享类型）、ToolsOrchestration（工具分发）、ContextManagement（上下文窗口管理）、AgentCoordination（多 Agent 协调）等。

---

## 关键流程

### 1. 会话启动流程

当外部调用 `handle_start()` 时，启动流程分为两个阶段：

**准备阶段** (`prepare_realtime_start`，`realtime_conversation.rs:452-513`)：

1. 从 Session 获取当前 provider 和认证信息
2. 通过 `realtime_api_key()` 解析 API 密钥（优先级：provider api_key → bearer token → auth manager → 环境变量）
3. 构建 `ApiProvider`，可选覆盖 base URL（`experimental_realtime_ws_base_url`）
4. 确定 prompt：优先使用配置中的 `experimental_realtime_ws_backend_prompt`，否则使用请求参数中的 prompt
5. 调用 `build_realtime_startup_context()` 构建启动上下文，拼接到 prompt 末尾
6. 根据配置中的 `realtime.version`（V1/V2）和 `realtime.session_type`（Conversational/Transcription）生成 `RealtimeSessionConfig`
7. 构建请求头（`Authorization` + `x-session-id`）

**连接阶段** (`handle_start_inner`，`realtime_conversation.rs:515-605`)：

1. 调用 `RealtimeConversationManager::start()` 建立 WebSocket 连接
2. 创建四个 bounded channel：音频输入（256）、文本输入（64）、handoff 输出（64）、事件输出（256）
3. 发送 `RealtimeConversationStarted` 事件通知消费者
4. 启动 fanout task 接收服务端事件并分发：
   - 音频输出帧直接转发
   - `HandoffRequested` 事件提取 transcript 并路由给 `route_realtime_text_input()`
   - 错误事件触发会话终止
   - transport 关闭时自动 cleanup 并发送 `RealtimeConversationClosed`

### 2. 输入任务事件循环

`spawn_realtime_input_task()`（`realtime_conversation.rs:702-963`）是整个模块的核心，它使用 `tokio::select!` 同时监听四个 channel：

| Channel | 处理逻辑 |
|---------|---------|
| `user_text_rx` | 调用 `writer.send_conversation_item_create(text)`；V2 模式下额外触发 `response.create` |
| `handoff_output_rx` | 处理 `ImmediateAppend`（V1）或 `FinalToolCall`（V2）两种 handoff 输出 |
| `events` (服务端) | 解析各种 Realtime 事件，管理 response 状态机 |
| `audio_rx` | 调用 `writer.send_audio_frame(frame)` 发送音频帧 |

**V2 response 状态机**：V2 协议需要显式的 `response.create` / `response.done` 管理。当已有 response 进行中时，新的请求被延迟（`pending_response_create = true`），待当前 response 完成或取消后再触发。若服务端返回 "active response conflict" 错误，该错误不会转发给消费者，而是静默设置 pending 标志。

**音频截断**：V2 模式下，当用户开始说话（`InputAudioSpeechStarted`）时，如果当前正在播放输出音频，会发送 `conversation.item.truncate` 截断输出，实现 barge-in 效果。

### 3. Handoff 机制

Handoff 是实时会话与文本 agent 之间的协作协议：

1. 服务端发送 `HandoffRequested` → 记录 `active_handoff` ID，重置 `last_output_text`
2. 外部通过 `handoff_out()` 提交文本输出：
   - **V1**：立即发送 `ImmediateAppend`
   - **V2**：仅缓存 `last_output_text`，等待 `handoff_complete()` 后以 `FinalToolCall` 形式发送
3. `handoff_complete()` 结束后，V2 模式会触发 `response.create` 让模型继续对话

### 4. 启动上下文构建

`build_realtime_startup_context()`（`realtime_context.rs:51-117`）组装一份结构化的背景信息，注入给实时会话模型。整体预算为 5000 token，各 section 有独立预算：

| Section | 预算 (tokens) | 内容 |
|---------|--------------|------|
| Current Thread | 1,200 | 当前对话的最近 2 轮 user/assistant 交互 |
| Recent Work | 2,200 | 从 state DB 加载最近 40 个线程，按 git 项目分组展示 |
| Machine / Workspace Map | 1,600 | CWD、git root、user home 的目录树（深度 2，每层最多 20 项） |
| Notes | 300 | 说明上下文的构建来源和局限性 |

**Current Thread 构建**（`realtime_context.rs:189-271`）：遍历当前对话的 `ResponseItem`，提取非 contextual 的 user/assistant 消息，保留最后 `MAX_CURRENT_THREAD_TURNS`（2）轮。

**Recent Work 构建**（`realtime_context.rs:144-187`）：从 state DB 加载线程元数据，按 `resolve_root_git_project_for_trust()` 分组，当前项目优先排列。每个分组展示最近活动时间、最新分支、以及去重后的 user asks（当前项目最多 8 条，其他最多 5 条，每条截断到 240 字符）。

**Workspace Map 构建**（`realtime_context.rs:273-329`）：扫描三个目录（CWD、git root、user home），生成浅层目录树。过滤掉 `.git`、`node_modules`、`target` 等噪声目录（`NOISY_DIR_NAMES` 列表）。目录优先于文件排列。

最终所有 section 拼接后，使用 `truncate_text()` 按 token 预算截断。

---

## 函数签名与参数说明

### `RealtimeConversationManager`

```rust
pub(crate) fn new() -> Self
```
创建空的 manager 实例，内部 state 初始为 `None`。

```rust
pub(crate) async fn start(
    &self,
    api_provider: ApiProvider,
    extra_headers: Option<HeaderMap>,
    session_config: RealtimeSessionConfig,
) -> CodexResult<(Receiver<RealtimeEvent>, Arc<AtomicBool>)>
```
建立 WebSocket 连接并启动输入处理任务。返回事件接收 channel 和一个 `AtomicBool` 标记（`true` = 会话存活）。如果已有会话在运行，会先 abort 旧会话。

```rust
pub(crate) async fn audio_in(&self, frame: RealtimeAudioFrame) -> CodexResult<()>
```
向实时会话发送一帧音频。队列满时静默丢弃并 warn。

```rust
pub(crate) async fn text_in(&self, text: String) -> CodexResult<()>
```
向实时会话发送一条文本消息。

```rust
pub(crate) async fn handoff_out(&self, output_text: String) -> CodexResult<()>
```
提交 handoff 输出文本。V1 立即追加；V2 仅缓存。

```rust
pub(crate) async fn handoff_complete(&self) -> CodexResult<()>
```
标记 handoff 完成（仅 V2 生效），发送 `FinalToolCall`。

```rust
pub(crate) async fn shutdown(&self) -> CodexResult<()>
```
关闭当前会话，abort 所有后台任务。

### 顶层 handler 函数

```rust
pub(crate) async fn handle_start(sess: &Arc<Session>, sub_id: String, params: ConversationStartParams) -> CodexResult<()>
pub(crate) async fn handle_audio(sess: &Arc<Session>, sub_id: String, params: ConversationAudioParams)
pub(crate) async fn handle_text(sess: &Arc<Session>, sub_id: String, params: ConversationTextParams)
pub(crate) async fn handle_close(sess: &Arc<Session>, sub_id: String)
```
这四个函数是 Session 层对外的入口点，分别处理启动、音频输入、文本输入和关闭请求。错误时通过 event 通知消费者而非返回 error。

### 启动上下文

```rust
pub(crate) async fn build_realtime_startup_context(
    sess: &Session,
    budget_tokens: usize,
) -> Option<String>
```
构建注入给实时会话的启动上下文。返回 `None` 表示无有效上下文可用。

---

## 接口/类型定义

### `RealtimeConversationEnd`（枚举）

```rust
enum RealtimeConversationEnd {
    Requested,        // 用户主动关闭
    TransportClosed,  // WebSocket 连接断开
    Error,            // 收到错误事件
}
```
决定 `RealtimeConversationClosed` 事件中的 `reason` 字段值。

### `RealtimeSessionKind`（枚举）

```rust
enum RealtimeSessionKind { V1, V2 }
```
从 `RealtimeEventParser` 映射而来，影响 response 状态机和 handoff 策略。

### `HandoffOutput`（枚举）

```rust
enum HandoffOutput {
    ImmediateAppend { handoff_id: String, output_text: String },  // V1: 即时追加
    FinalToolCall { handoff_id: String, output_text: String },     // V2: 完成时一次性提交
}
```

### `ConversationState`（结构体）

保持单个活跃会话的全部运行时状态：音频/文本发送 channel、WebSocket writer、handoff 状态、后台任务 handle、活跃标志。

### `OutputAudioState`（结构体，`realtime_conversation.rs:103-107`）

跟踪当前输出音频帧的 `item_id` 和累计播放时长 `audio_end_ms`，用于 barge-in 截断计算。

---

## 配置项与默认值

| 配置项 | 来源 | 说明 |
|--------|------|------|
| `realtime.version` | config | V1 或 V2，决定协议版本和事件解析器 |
| `realtime.session_type` | config | Conversational 或 Transcription |
| `experimental_realtime_ws_base_url` | config | 可选覆盖 WebSocket 连接 URL |
| `experimental_realtime_ws_model` | config | 可选覆盖模型名称 |
| `experimental_realtime_ws_backend_prompt` | config | 可选覆盖系统 prompt |
| `experimental_realtime_ws_startup_context` | config | 可选覆盖启动上下文（跳过自动构建） |

### 内部常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `AUDIO_IN_QUEUE_CAPACITY` | 256 | 音频输入 channel 容量 |
| `USER_TEXT_IN_QUEUE_CAPACITY` | 64 | 文本输入 channel 容量 |
| `OUTPUT_EVENTS_QUEUE_CAPACITY` | 256 | 事件输出 channel 容量 |
| `REALTIME_STARTUP_CONTEXT_TOKEN_BUDGET` | 5,000 | 启动上下文总 token 预算 |
| `MAX_CURRENT_THREAD_TURNS` | 2 | 当前线程保留的最近轮次数 |
| `MAX_RECENT_THREADS` | 40 | 从 state DB 加载的最大线程数 |
| `TREE_MAX_DEPTH` | 2 | 目录树最大扫描深度 |
| `DIR_ENTRY_LIMIT` | 20 | 每层目录最多展示的条目数 |
| `APPROX_BYTES_PER_TOKEN` | 4 | token 估算比率 |

---

## 边界 Case 与注意事项

- **队列满时的音频丢帧**：`audio_in()` 使用 `try_send`，队列满时丢弃帧并 warn，不会阻塞调用方。文本输入则使用阻塞式 `send`。
- **V2 response 冲突**：当服务端返回 "Conversation already has an active response in progress" 错误时，不转发给消费者，而是设置 `pending_response_create` 延迟重试（`realtime_conversation.rs:902-912`）。
- **会话替换**：`start()` 会自动 abort 已存在的会话，然后建立新连接。
- **Fanout task 生命周期**：`register_fanout_task()` 通过 `Arc::ptr_eq` 校验 `realtime_active` 指针，防止注册到已被替换的会话上。不匹配时立即 abort 新任务。
- **API 密钥降级链**：`realtime_api_key()` 有四级降级（provider key → bearer token → auth manager → 环境变量），最后一级仅对 OpenAI provider 生效且标记为临时方案（`realtime_conversation.rs:649-654`）。
- **启动上下文可为空**：如果当前线程为空、无历史线程、且目录树均不可用，`build_realtime_startup_context()` 返回 `None`，prompt 不会拼接额外上下文。
- **噪声目录过滤**：目录树扫描跳过以 `.` 开头的隐藏文件和预定义的构建产物目录（`node_modules`、`target`、`dist` 等）。
- **音频时长计算**：`audio_duration_ms()` 优先使用帧的 `samples_per_channel` 字段，若缺失则通过 base64 解码数据长度推算（假定 16-bit PCM 编码）。