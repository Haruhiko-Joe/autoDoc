# SessionSupport — 会话引擎支撑设施与工具集

## 概述与职责

SessionSupport 是 **Core > SessionEngine** 下的辅助模块集合，为会话引擎提供各类基础设施和工具函数。它不承担主循环编排，而是将一系列横切关注点——会话录制、启动优化、安全监控、文件监听、遥测、代码审查、调试工具等——以独立文件的形式组织，供 SessionEngine 及其他 Core 子系统按需调用。

在整体架构中，SessionSupport 与同级模块 Protocol、ToolsOrchestration、ContextManagement 等并列，属于 SessionEngine 的"后勤保障层"。它依赖 Config 层的配置信息、Auth 层的认证凭证、以及外部 crate（`codex_rollout`、`codex_otel`、`notify` 等）提供的底层能力。

本模块包含以下子组件：

| 文件 | 职责 |
|------|------|
| `rollout.rs` | 会话录制与索引的 re-export 层 |
| `session_startup_prewarm.rs` | 首轮提交前的 WebSocket 预连接 |
| `session_rollout_init_error.rs` | 会话初始化失败的友好错误映射 |
| `session_prefix.rs` | 子 Agent 通知消息格式化 |
| `commit_attribution.rs` | Git commit Co-authored-by trailer 生成 |
| `file_watcher.rs` | 基于订阅者的文件系统变更监听 |
| `otel_init.rs` | OpenTelemetry Provider 构建 |
| `prompt_debug.rs` | 调试用 prompt 输入构建 |
| `arc_monitor.rs` | ARC 安全合规监控 |
| `review_format.rs` | 代码审查结果格式化 |
| `review_prompts.rs` | 代码审查 prompt 模板构建 |
| `util.rs` + `utils/` | 退避策略、feedback 标签、路径工具等 |

---

## 关键流程

### 1. 会话录制桥接（rollout.rs）

`rollout.rs` 本身不包含业务逻辑，而是作为 `codex_rollout` crate 的 **re-export 层**，将会话录制所需的类型和函数暴露给 `codex_core` 内部。

核心 re-export 包括：
- `RolloutRecorder` / `RolloutRecorderParams`：会话录制器及其参数
- `SessionMeta`：会话元数据
- `find_thread_path_by_id_str` / `find_thread_path_by_name_str`：通过 ID 或名称查找会话文件
- `SESSIONS_SUBDIR` / `ARCHIVED_SESSIONS_SUBDIR`：会话存储目录常量
- 子模块 `list`、`policy`、`recorder`、`session_index`、`metadata`、`truncation`

此外，它为 `Config` 实现了 `codex_rollout::RolloutConfigView` trait，将配置中的 `codex_home`、`sqlite_home`、`cwd`、`model_provider_id`、`generate_memories` 等字段桥接给 rollout 子系统（`codex-rs/core/src/rollout.rs:17-37`）。

### 2. WebSocket 预热（session_startup_prewarm.rs）

为了减少用户首次提交时的延迟，系统在会话启动阶段就异步发起 WebSocket 连接并发送初始 prompt。

**预热调度流程**：
1. `Session::schedule_startup_prewarm()` 在会话创建后立即调用
2. 内部 spawn 一个异步任务 `schedule_startup_prewarm_inner()`，它：
   - 创建默认的 turn context
   - 构建工具路由和初始 prompt
   - 调用 `client_session.prewarm_websocket()` 建立预连接
3. 将 `SessionStartupPrewarmHandle`（包含 JoinHandle、启动时间、超时配置）存入 Session 状态

**消费流程**：
当用户首次提交时，`consume_startup_prewarm_for_regular_turn()` 被调用：
1. 从 Session 中取出预热 handle（一次性消费）
2. 调用 `resolve()` 等待任务完成（受 `timeout` 限制）
3. 根据结果返回 `SessionStartupPrewarmResolution`：
   - `Ready(ModelClientSession)` — 预热成功，直接复用连接
   - `Unavailable { status, ... }` — 超时 / 失败 / 未调度
   - `Cancelled` — 会话被取消

整个流程通过 `CancellationToken` 支持取消，并通过 `SessionTelemetry` 记录 `STARTUP_PREWARM_DURATION_METRIC` 和 `STARTUP_PREWARM_AGE_AT_FIRST_TURN_METRIC` 两个指标（`codex-rs/core/src/session_startup_prewarm.rs:54-130`）。

### 3. ARC 安全监控（arc_monitor.rs）

ARC（Automated Risk Check）监控器在工具调用前检查对话是否符合安全策略，防止恶意或危险操作被执行。

**调用流程**：
1. `monitor_action()` 接收当前 Session、TurnContext、要执行的 action（JSON）和 callsite 标识
2. 获取认证 token（优先使用 `CODEX_ARC_MONITOR_TOKEN` 环境变量，否则从 ChatGPT auth 获取）
3. 构建请求体 `ArcMonitorRequest`，包含：
   - `metadata`：thread ID、turn ID、conversation ID、callsite
   - `messages`：从对话历史提取的精简消息列表（仅保留用户输入、assistant 最终回答、最后一个 tool call 和最后一个加密推理）
   - `action`：待执行的操作
4. POST 到 ARC 端点（默认 `{chatgpt_base_url}/codex/safety/arc`，可通过 `CODEX_ARC_MONITOR_ENDPOINT_OVERRIDE` 覆盖）
5. 解析 `ArcMonitorResult`，根据 `outcome` 返回：
   - `ArcMonitorOutcome::Ok` — 放行
   - `ArcMonitorOutcome::SteerModel(rationale)` — 取消操作并引导模型
   - `ArcMonitorOutcome::AskUser(reason)` — 需要用户确认

**容错设计**：任何失败（网络错误、非 200 响应、解析失败、无 token）都默认返回 `Ok`（放行），避免安全监控本身阻塞正常操作（`codex-rs/core/src/arc_monitor.rs:99-216`）。

### 4. 文件监听系统（file_watcher.rs）

一个基于 `notify` crate 的多订阅者文件监听器，支持路径注册、引用计数、事件合并和节流。

**架构核心**：

```
FileWatcher (Arc)
 ├── FileWatcherInner { RecommendedWatcher, watched_paths }
 └── WatchState
      ├── subscribers: HashMap<SubscriberId, SubscriberState>
      └── path_ref_counts: HashMap<PathBuf, PathWatchCounts>
```

**工作流程**：
1. `FileWatcher::new()` 创建 `notify::recommended_watcher` 并启动后台事件循环
2. `add_subscriber()` 注册订阅者，返回 `(FileWatcherSubscriber, Receiver)` 对
3. 订阅者通过 `register_paths()` 注册关注的路径，返回 RAII guard `WatchRegistration`
4. 当文件系统事件到达时，事件循环过滤出变更事件（Create/Modify/Remove），然后匹配订阅者的注册路径，将变更路径推送到对应订阅者的 channel
5. `Receiver::recv()` 返回合并后的 `FileWatcherEvent`（路径去重且排序）

**路径引用计数**：多个订阅者可以监听同一路径。`PathWatchCounts` 跟踪 recursive 和 non-recursive 两种订阅数，当引用计数变化导致 effective mode 变更时，才调用 `reconfigure_watch()` 更新底层 watcher（`codex-rs/core/src/file_watcher.rs:141-177`）。

**节流**：`ThrottledWatchReceiver` 包装 `Receiver`，在两次事件发射之间强制最小间隔（`codex-rs/core/src/file_watcher.rs:184-214`）。

### 5. 代码审查 prompt 构建（review_prompts.rs）

将 `ReviewRequest` 解析为模型可用的 prompt 文本。支持四种审查目标：

| ReviewTarget | Prompt 策略 |
|---|---|
| `UncommittedChanges` | 固定 prompt，审查暂存/未暂存/未跟踪的变更 |
| `BaseBranch { branch }` | 调用 `merge_base_with_head()` 获取合并基点 SHA，渲染包含 `git diff` 指令的模板；获取失败时回退到让模型自行计算 merge-base 的备选模板 |
| `Commit { sha, title }` | 渲染包含 commit SHA（和可选 title）的模板 |
| `Custom { instructions }` | 直接使用用户自定义 prompt |

所有模板通过 `codex_utils_template::Template` 的 `{{variable}}` 语法渲染（`codex-rs/core/src/review_prompts.rs:39-96`）。

### 6. 审查结果格式化（review_format.rs）

将 `ReviewOutputEvent` 中的 `ReviewFinding` 列表格式化为人类可读的纯文本。

- `format_review_findings_block()` 支持两种模式：
  - 带 `selection` 参数时渲染 `[x]` / `[ ]` 复选框标记（用于交互式选择）
  - 无 `selection` 时渲染简单的 `- Title — path:start-end` 列表
- `render_review_output_text()` 组合整体说明和 findings 块，缺失时输出 fallback 消息 `"Reviewer failed to output a response."`

---

## 函数签名与参数说明

### commit_attribution.rs

#### `commit_message_trailer_instruction(config_attribution: Option<&str>) -> Option<String>`

根据配置生成 commit message trailer 指令。返回的字符串包含完整的 "Co-authored-by: ..." 规则说明，供模型在生成 commit message 时遵循。

- `config_attribution = None` → 使用默认值 `"Codex <noreply@openai.com>"`
- `config_attribution = Some("")` → 返回 `None`（禁用）
- `config_attribution = Some("Custom Name <email>")` → 使用自定义值

### session_prefix.rs

#### `format_subagent_notification_message(agent_reference: &str, status: &AgentStatus) -> String`

生成子 Agent 状态变更通知，嵌入到 user-role 消息中。payload 为 JSON 格式，包含 `agent_path` 和 `status`，外层被 `SUBAGENT_NOTIFICATION_FRAGMENT` 包裹。

#### `format_subagent_context_line(agent_reference: &str, agent_nickname: Option<&str>) -> String`

格式化子 Agent 上下文行。有 nickname 时输出 `"- ref: nickname"`，否则仅输出 `"- ref"`。

### otel_init.rs

#### `build_provider(config: &Config, service_version: &str, service_name_override: Option<&str>, default_analytics_enabled: bool) -> Result<Option<OtelProvider>, Box<dyn Error>>`

从 `Config` 构建 OpenTelemetry provider。将配置中的 exporter 类型（None / Statsig / OtlpHttp / OtlpGrpc）映射为 `codex_otel` 的 `OtelExporter`，并分别处理 trace exporter 和 metrics exporter（metrics 受 `analytics_enabled` 控制）。返回 `None` 表示 OTEL 导出已禁用。

#### `codex_export_filter(meta: &tracing::Metadata<'_>) -> bool`

过滤谓词，仅导出以 `"codex_otel"` 开头的 tracing 事件。

### prompt_debug.rs

#### `build_prompt_input(config: Config, input: Vec<UserInput>) -> CodexResult<Vec<ResponseItem>>`

调试工具函数。创建一个临时的 ephemeral session，构建模型可见的完整 prompt input 列表，然后立即关闭 session。用于开发者检查实际发送给模型的内容。

### arc_monitor.rs

#### `monitor_action(sess: &Session, turn_context: &TurnContext, action: serde_json::Value, protection_client_callsite: &'static str) -> ArcMonitorOutcome`

ARC 安全监控入口。发送对话摘要和待执行操作到安全端点，返回三种结果之一：`Ok`（放行）、`SteerModel`（引导模型）、`AskUser`（需用户确认）。超时时间 30 秒。

### util.rs

#### `backoff(attempt: u64) -> Duration`

指数退避计算。初始延迟 200ms，倍率 2.0，附加 ±10% 随机抖动。`attempt=0` 时约 200ms，`attempt=1` 时约 200ms，`attempt=2` 时约 400ms，以此类推。

#### `resolve_path(base: &Path, path: &PathBuf) -> PathBuf`

路径解析：绝对路径直接返回，相对路径基于 `base` 拼接。

#### `normalize_thread_name(name: &str) -> Option<String>`

清理线程名称：trim 后为空则返回 `None`。

#### `resume_command(thread_name: Option<&str>, thread_id: Option<ThreadId>) -> Option<String>`

生成 `codex resume <target>` 命令字符串。优先使用 thread name，其次使用 thread ID。以 `-` 开头的 target 会添加 `--` 防护。

#### `feedback_tags!` 宏

```rust
feedback_tags!(model = "gpt-5", cached = true);
```

发射 `target: "feedback_tags"` 的 tracing info 事件。当 `codex_feedback::CodexFeedback::metadata_layer()` 已安装时，这些字段会被捕获并在上传反馈时作为 tag 附加。

---

## 接口/类型定义

### SessionStartupPrewarmResolution

```rust
pub(crate) enum SessionStartupPrewarmResolution {
    Cancelled,
    Ready(Box<ModelClientSession>),
    Unavailable { status: &'static str, prewarm_duration: Option<Duration> },
}
```

预热结果枚举。`status` 可能的值有：`"not_scheduled"`、`"timed_out"`、`"failed"`、`"join_failed"`。

### ArcMonitorOutcome

```rust
pub(crate) enum ArcMonitorOutcome {
    Ok,
    SteerModel(String),
    AskUser(String),
}
```

### FileWatcherEvent / WatchPath

```rust
pub struct FileWatcherEvent {
    pub paths: Vec<PathBuf>,  // 变更路径，去重排序
}

pub struct WatchPath {
    pub path: PathBuf,
    pub recursive: bool,
}
```

### ResolvedReviewRequest

```rust
pub struct ResolvedReviewRequest {
    pub target: ReviewTarget,
    pub prompt: String,
    pub user_facing_hint: String,
}
```

将 `ReviewRequest` 解析后的完整审查请求，包含渲染好的 prompt 和面向用户的提示文本。

---

## 配置项与默认值

| 配置/环境变量 | 用途 | 默认值 |
|---|---|---|
| `config.commit_attribution` | Co-authored-by trailer 的署名 | `"Codex <noreply@openai.com>"` |
| `CODEX_ARC_MONITOR_ENDPOINT_OVERRIDE` | 覆盖 ARC 安全端点 URL | `{chatgpt_base_url}/codex/safety/arc` |
| `CODEX_ARC_MONITOR_TOKEN` | 覆盖 ARC 认证 token | 从 ChatGPT auth 获取 |
| `ARC_MONITOR_TIMEOUT` | ARC 请求超时 | 30 秒 |
| `config.otel.exporter` | OTEL 默认 exporter | — |
| `config.otel.trace_exporter` | OTEL trace exporter | — |
| `config.otel.metrics_exporter` | OTEL metrics exporter（受 `analytics_enabled` 控制） | — |
| `config.analytics_enabled` | 是否启用 metrics 导出 | 由 `default_analytics_enabled` 参数决定 |
| `INITIAL_DELAY_MS` / `BACKOFF_FACTOR` | 退避策略参数 | 200ms / 2.0x |

---

## 边界 Case 与注意事项

- **ARC 监控的容错哲学**：所有失败路径（网络、认证、解析）都静默返回 `Ok`（放行）。这是有意为之——安全监控不应阻塞用户的正常工作流。但这意味着在网络故障期间，安全检查事实上被跳过。

- **预热的一次性消费**：`consume_startup_prewarm_for_regular_turn()` 通过 `take_session_startup_prewarm()` 从 Session 中移除 handle，确保预热连接只被首次 turn 消费。

- **文件监听的 noop 模式**：`FileWatcher::noop()` 创建不含底层 watcher 的实例，仅用于测试场景下的合成事件注入。

- **commit attribution 的禁用机制**：传入空字符串 `Some("")` 会禁用 trailer 生成（返回 `None`），而传入 `None` 会使用默认值，这两种行为需要区分。

- **路径匹配语义**：`watch_path_matches_event()` 不仅匹配精确路径，还支持"事件路径是监听路径的祖先"的情况（例如目录被重命名时）。非递归模式下只匹配直接子项。

- **`utils/path_utils.rs`** 仅 re-export `codex_utils_path` crate 的全部内容，不含额外逻辑。

- **`rollout.rs` 中 `find_conversation_path_by_id_str`** 已被标记为 `#[deprecated]`，应使用 `find_thread_path_by_id_str` 替代。