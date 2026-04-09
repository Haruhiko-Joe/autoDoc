# Turn 生命周期管理（TurnLifecycle）

## 概述与职责

TurnLifecycle 是 SessionEngine 的内部支撑模块，负责在每个 agent turn（一次用户提交到模型完成响应的完整周期）中完成三类辅助工作：

1. **性能度量**（`turn_timing`）：记录 TTFT（Time-To-First-Token）和 TTFM（Time-To-First-Message）延迟
2. **元数据采集**（`turn_metadata`）：异步收集工作区 git 元数据并附加到遥测 header
3. **变更追踪**（`turn_diff_tracker`）：维护文件基线快照，在 turn 结束后生成聚合 unified diff
4. **上下文压缩**（`compact` / `compact_remote`）：当对话历史超出模型上下文窗口时，将旧消息摘要化以腾出空间

在整体架构中，TurnLifecycle 位于 **Core → SessionEngine** 下层。SessionEngine 在编排每个 turn 时调用这些子模块，它们的产出（指标数据、元数据 header、diff 文本、压缩后的历史）被 SessionEngine 消费并流向 Observability 层或返回给模型。

---

## 关键流程

### 1. Turn 计时流程（turn_timing）

每个 turn 开始时，SessionEngine 调用 `TurnTimingState::mark_turn_started()` 记录起始时刻并重置之前的计时状态。

**TTFT 记录路径：**
1. 模型流式响应产生 `ResponseEvent` 时，调用 `record_turn_ttft_metric()`
2. 内部通过 `response_event_records_turn_ttft()` 判断该事件是否算作"首个有意义的 token"——文本增量、推理增量、工具调用等算，而 `Created`、`RateLimits`、`Completed` 等控制事件不算
3. 对于 `OutputItemDone`/`OutputItemAdded`，进一步检查 Message 类型是否包含非空文本，Reasoning 类型是否包含非空摘要或内容（`turn_timing.rs:120-153`）
4. 首次匹配时计算 `Instant::now() - started_at` 得到 TTFT 持续时间，通过 `session_telemetry` 上报为 `TURN_TTFT_DURATION_METRIC`

**TTFM 记录路径：**
1. 当 `TurnItem` 被解析为 `AgentMessage` 时触发
2. 同样只记录首次，计算方式与 TTFT 相同，上报为 `TURN_TTFM_DURATION_METRIC`

两个指标均使用 `Mutex<TurnTimingStateInner>` 保证并发安全，且每个 turn 只记录一次（后续事件被 `first_token_at.is_some()` / `first_message_at.is_some()` 短路）。

### 2. Turn 元数据采集流程（turn_metadata）

Turn 开始时创建 `TurnMetadataState`，立即生成包含 `session_id`、`turn_id`、`sandbox` 标签的 **base header**（不含 git 信息，零延迟可用）。

**异步 git 信息富化：**
1. `spawn_git_enrichment_task()` 在后台 tokio task 中并发执行三个 git 查询（`turn_metadata.rs:235-246`）：
   - `get_head_commit_hash(cwd)` — 当前 HEAD commit SHA
   - `get_git_remote_urls_assume_git_repo(cwd)` — remote URL 映射
   - `get_has_changes(cwd)` — 工作区是否有未提交变更
2. 三个查询通过 `tokio::join!` 并行执行
3. 结果组装为 `WorkspaceGitMetadata` 后合并进完整的 `TurnMetadataBag`，序列化为 JSON 写入 `enriched_header`（`Arc<RwLock<Option<String>>>`）

**Header 消费：** 调用 `current_header_value()` 时优先返回富化后的 header，若异步任务尚未完成则返回 base header。该 header 附加到模型 API 请求中用于遥测关联。

Turn 结束时 `cancel_git_enrichment_task()` 可中止未完成的异步任务，避免泄漏。

### 3. 文件变更追踪流程（turn_diff_tracker）

`TurnDiffTracker` 在每个 turn 内跟踪所有 `apply_patch` 操作影响的文件，最终生成一份聚合的 git 风格 unified diff。

**基线快照建立（`on_patch_begin`）：**
1. 对每个被 patch 涉及的文件路径，首次出现时分配一个 UUID 内部标识并建立双向映射（`external_to_temp_name` / `temp_name_to_current_path`）
2. 若文件已存在于磁盘，读取其内容和 mode（regular/executable/symlink），通过 `git hash-object` 或内存 SHA-1 计算 blob OID 作为基线
3. 若文件不存在（新增），使用零 OID 和空内容作为基线，使 diff 输出显示为 `/dev/null` 到新文件的 addition
4. 对于包含 `move_path` 的 `FileChange::Update`，更新内部路径映射以正确追踪重命名

**聚合 Diff 生成（`get_unified_diff`）：**
1. 按 git 仓库相对路径排序所有已跟踪的内部文件
2. 对每个文件，将内存中的基线内容与磁盘上的当前内容比较
3. 文本文件使用 `similar` crate 的 `TextDiff::from_lines` 生成带 3 行上下文的 unified diff
4. 二进制文件输出 "Binary files differ"
5. diff header 严格模拟 git 格式：`diff --git a/... b/...`、`index <oid>..<oid>`、mode 变更行等

### 4. 本地上下文压缩流程（compact）

当模型上下文窗口不足时，`run_compact_task` 将旧历史摘要化。

**核心流程：**
1. 构造压缩 prompt（从 `templates/compact/prompt.md` 加载），作为用户消息追加到历史副本中
2. 调用模型流式接口（`drain_to_completed`），让模型生成历史摘要
3. 若遇到 `ContextWindowExceeded` 错误，逐条移除最旧的历史项后重试（`compact.rs:154-163`）
4. 其他错误则以指数退避重试（最多 `stream_max_retries` 次）
5. 成功后提取模型输出的摘要文本，与 `SUMMARY_PREFIX` 拼接

**压缩后历史重建（`build_compacted_history`）：**
1. 从原历史中收集所有真实用户消息（排除摘要消息），按 token 预算（`COMPACT_USER_MESSAGE_MAX_TOKENS = 20,000`）从最新向最旧选取
2. 超出预算的消息被截断后放入
3. 摘要文本作为最终的用户消息追加
4. 保留 `GhostSnapshot` 项以支持 `/undo` 功能

**初始上下文注入策略（`InitialContextInjection`）：**
- `DoNotInject`：用于手动/pre-turn 压缩。压缩后清除 `reference_context_item`，下次常规 turn 时会自动重新注入完整初始上下文
- `BeforeLastUserMessage`：用于 mid-turn 压缩。将初始上下文插入到最后一条真实用户消息之前，因为模型训练时期望压缩摘要在历史末尾

### 5. 远程上下文压缩流程（compact_remote）

当模型提供者是 OpenAI 时（`should_use_remote_compact_task` 检查 `provider.is_openai()`），使用服务端压缩 API。

**与本地压缩的关键差异：**
1. 不发送单独的压缩 prompt，而是将完整的对话历史（包括工具定义）发送给 `model_client.compact_conversation_history()` 服务端 API
2. 发送前先通过 `trim_function_call_history_to_fit_context_window()` 从历史末尾删除 codex 生成的项（工具调用/输出），直到估计 token 数低于上下文窗口
3. 服务端返回压缩后的历史，本地通过 `should_keep_compacted_history_item()` 过滤：
   - **丢弃** `developer` 角色消息（可能包含过期指令）
   - **丢弃** 非用户内容的 `user` 消息（session 前缀/指令包装）
   - **保留** 真实用户消息、hook prompt、assistant 消息、Compaction 项
4. 同样支持 `InitialContextInjection` 策略和 GhostSnapshot 保留

失败时记录详细诊断信息（token 使用量、请求大小、上下文窗口等）到结构化日志。

---

## 函数签名与参数说明

### turn_timing

#### `record_turn_ttft_metric(turn_context: &TurnContext, event: &ResponseEvent)`

记录当前 turn 的 TTFT 指标。仅在首个有意义的流式事件到达时触发一次。

#### `record_turn_ttfm_metric(turn_context: &TurnContext, item: &TurnItem)`

记录当前 turn 的 TTFM 指标。仅在首个 `AgentMessage` 类型的 `TurnItem` 到达时触发一次。

#### `TurnTimingState::mark_turn_started(&self, started_at: Instant)`

标记 turn 开始时刻并重置 TTFT/TTFM 状态。每个新 turn 开始时调用。

### turn_metadata

#### `TurnMetadataState::new(session_id, turn_id, cwd, sandbox_policy, windows_sandbox_level) -> Self`

创建新的元数据状态。立即生成不含 git 信息的 base header。

#### `TurnMetadataState::spawn_git_enrichment_task(&self)`

启动后台 tokio task 异步收集 git 元数据。若无 git 仓库或任务已在运行则为 no-op。

#### `TurnMetadataState::current_header_value(&self) -> Option<String>`

返回当前可用的元数据 JSON header。优先返回富化版本，否则返回 base 版本。

#### `build_turn_metadata_header(cwd: &Path, sandbox: Option<&str>) -> Option<String>`

独立的公开辅助函数，一次性异步获取 git 元数据并构建 header JSON。当所有 git 信息和 sandbox 均为空时返回 `None`。

### turn_diff_tracker

#### `TurnDiffTracker::on_patch_begin(&mut self, changes: &HashMap<PathBuf, FileChange>)`

在 `apply_patch` 执行前调用，为首次见到的文件建立基线快照，并追踪重命名。

#### `TurnDiffTracker::get_unified_diff(&mut self) -> Result<Option<String>>`

生成所有被追踪文件的聚合 unified diff。若无变更返回 `None`。

### compact

#### `run_compact_task(sess, turn_context, input) -> CodexResult<()>`

用户/系统触发的显式压缩入口。发送 `TurnStarted` 事件后执行本地压缩，使用 `DoNotInject` 策略。

#### `run_inline_auto_compact_task(sess, turn_context, initial_context_injection) -> CodexResult<()>`

mid-turn 自动压缩入口。使用会话自身的 compact prompt 而非用户输入。

#### `should_use_remote_compact_task(provider: &ModelProviderInfo) -> bool`

判断是否应使用远程压缩。当前逻辑：OpenAI 提供者返回 `true`。

### compact_remote

#### `run_remote_compact_task(sess, turn_context) -> CodexResult<()>`

显式触发的远程压缩入口，使用 `DoNotInject` 策略。

#### `run_inline_remote_auto_compact_task(sess, turn_context, initial_context_injection) -> CodexResult<()>`

mid-turn 自动远程压缩入口。

---

## 接口/类型定义

### `TurnTimingState`

```rust
pub(crate) struct TurnTimingState {
    state: Mutex<TurnTimingStateInner>,  // 内部状态：started_at, first_token_at, first_message_at
}
```

> 源码位置：`codex-rs/core/src/turn_timing.rs:40-43`

通过 `tokio::sync::Mutex` 保护，支持跨 `.await` 的安全并发访问。

### `TurnMetadataState`

```rust
pub(crate) struct TurnMetadataState {
    cwd: PathBuf,                                       // 工作目录
    repo_root: Option<String>,                          // git 仓库根路径
    base_metadata: TurnMetadataBag,                     // 不含 git 的基础元数据
    base_header: String,                                // 基础 JSON header
    enriched_header: Arc<RwLock<Option<String>>>,       // 富化后的 JSON header
    enrichment_task: Arc<Mutex<Option<JoinHandle<()>>>>, // 后台 git 查询任务句柄
}
```

> 源码位置：`codex-rs/core/src/turn_metadata.rs:126-133`

### `TurnMetadataBag`（可序列化的元数据结构）

| 字段 | 类型 | 说明 |
|------|------|------|
| `session_id` | `Option<String>` | 会话标识 |
| `turn_id` | `Option<String>` | Turn 标识 |
| `workspaces` | `BTreeMap<String, TurnMetadataWorkspace>` | 按仓库根路径索引的 git 元数据 |
| `sandbox` | `Option<String>` | 沙箱策略标签 |

> 源码位置：`codex-rs/core/src/turn_metadata.rs:54-64`

### `TurnDiffTracker`

```rust
pub struct TurnDiffTracker {
    external_to_temp_name: HashMap<PathBuf, String>,      // 外部路径 → UUID
    baseline_file_info: HashMap<String, BaselineFileInfo>, // UUID → 基线快照
    temp_name_to_current_path: HashMap<String, PathBuf>,   // UUID → 当前路径（追踪重命名）
    git_root_cache: Vec<PathBuf>,                          // git 仓库根缓存
}
```

> 源码位置：`codex-rs/core/src/turn_diff_tracker.rs:33-43`

### `InitialContextInjection`

```rust
pub(crate) enum InitialContextInjection {
    BeforeLastUserMessage,  // mid-turn 压缩：在最后一条用户消息前注入初始上下文
    DoNotInject,            // pre-turn/手动压缩：不注入，由下次 turn 自动处理
}
```

> 源码位置：`codex-rs/core/src/compact.rs:44-48`

### `FileMode`（diff 追踪内部类型）

| 变体 | 值 | 说明 |
|------|------|------|
| `Regular` | `100644` | 普通文件 |
| `Executable` | `100755` | 可执行文件（仅 Unix） |
| `Symlink` | `120000` | 符号链接 |

> 源码位置：`codex-rs/core/src/turn_diff_tracker.rs:382-398`

---

## 配置项与默认值

| 配置项 | 位置 | 默认值 | 说明 |
|--------|------|--------|------|
| `COMPACT_USER_MESSAGE_MAX_TOKENS` | `compact.rs:33` | `20,000` | 压缩后历史中保留的用户消息最大 token 数 |
| `SUMMARIZATION_PROMPT` | `templates/compact/prompt.md` | 外部模板 | 发送给模型的压缩指令 prompt |
| `SUMMARY_PREFIX` | `templates/compact/summary_prefix.md` | 外部模板 | 摘要文本的前缀标识，用于区分摘要消息和用户消息 |
| `stream_max_retries` | 由 provider 决定 | - | 本地压缩流式调用的最大重试次数 |

---

## 边界 Case 与注意事项

- **TTFT/TTFM 仅记录一次**：`TurnTimingStateInner` 中 `first_token_at` / `first_message_at` 一旦被设置，后续事件直接返回 `None`，避免重复度量。

- **空文本过滤**：TTFT 判定中 Message 类型要求文本非空（`turn_timing.rs:123`），空推理摘要也被排除，确保指标反映真正的首个有内容的输出。

- **git 信息降级**：若工作目录不在 git 仓库中（`repo_root` 为 `None`），`spawn_git_enrichment_task` 是 no-op，header 中将不包含 workspace 信息但仍包含 session/turn/sandbox 字段。

- **RwLock 毒化恢复**：`TurnMetadataState` 使用 `PoisonError::into_inner` 在锁毒化时自动恢复，保证即使 panic 也不会导致后续读取死锁。

- **Diff 中的符号链接处理**：符号链接的 "内容" 是链接目标路径（以字节形式），blob OID 通过内存 SHA-1 计算而非 `git hash-object`（`turn_diff_tracker.rs:69-74`）。

- **二进制文件回退**：当基线或当前内容无法解码为 UTF-8 时，输出 "Binary files differ" 而非尝试文本 diff。

- **压缩时的上下文窗口溢出**：本地压缩在遇到 `ContextWindowExceeded` 时逐条从最旧项开始移除重试，并在成功后向用户发送通知。远程压缩则预先裁剪末尾的 codex 生成项。

- **压缩后的警告**：每次成功压缩后都会发送警告消息，提醒用户长线程和多次压缩可能降低模型准确性，建议开启新线程。

- **远程压缩的历史过滤**：远程 API 返回的压缩历史中 `developer` 消息被无条件丢弃，因为它们可能包含过期的重复指令内容（`compact_remote.rs:207`）。

- **Windows 兼容性**：diff 追踪器在 Windows 上将路径分隔符统一为 `/`（`turn_diff_tracker.rs:198`），且 `is_windows_drive_or_unc_root` 防止 git root 搜索越过驱动器根。