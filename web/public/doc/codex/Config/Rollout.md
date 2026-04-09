# Rollout — 会话持久化与发现系统

## 概述与职责

`codex-rollout` 是 Codex 的**会话持久化与发现层**，位于 Config 模块体系下。它负责将每次 Codex 会话（thread）的完整交互记录以 JSONL 格式写入磁盘，并通过 SQLite 状态数据库提供高效的会话元数据查询、列表、搜索和归档功能。

在整体架构中，Rollout 是 Config 的子模块，与 Core（会话引擎）、AppServer（HTTP 服务）、TUI（终端界面）等多个模块协作：Core 在会话执行过程中调用 `RolloutRecorder` 持久化事件，TUI/AppServer 通过列表接口展示历史会话供用户浏览和恢复。

### 核心能力

- **会话记录**：将 `RolloutItem`（响应、事件、元数据）以 JSONL 格式追加写入磁盘文件
- **SQLite 状态数据库**：管理会话元数据索引，支持快速列表、过滤、分页查询
- **会话发现与搜索**：按创建时间/更新时间排序、基于 cursor 的分页、源过滤、全文搜索
- **会话名称索引**：通过 `session_index.jsonl` 为会话分配人类可读名称
- **事件持久化策略**：两级过滤机制（Limited/Extended）控制哪些事件写入磁盘
- **元数据提取与回填**：从 rollout 文件反向提取会话元数据，支持 SQLite 迁移期间的数据回填

## 关键流程

### 1. 会话创建与记录流程

1. 调用方构造 `RolloutRecorderParams::Create`，传入会话 ID、来源、指令等信息
2. `RolloutRecorder::new()` 预计算文件路径（格式：`~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`），但**延迟创建文件**直到首次 `persist()` 调用（`codex-rs/rollout/src/recorder.rs:370-374`）
3. 内部启动一个 Tokio 后台任务 `rollout_writer`，通过 mpsc channel 接收写入命令（`codex-rs/rollout/src/recorder.rs:452-467`）
4. 首次 `persist()` 时创建目录和文件、写入 `SessionMeta` 头记录（含 git 信息、cwd、CLI 版本等）
5. `record_items()` 将事件经过持久化策略过滤后发送到写入通道（`codex-rs/rollout/src/recorder.rs:485-505`）
6. 写入任务收到事件后序列化为 JSONL 行并追加到文件，同时增量更新 SQLite 状态数据库

### 2. 会话列表查询流程（双路径策略）

`list_threads_with_db_fallback` 实现了**文件系统 + SQLite 双路径**的查询策略（`codex-rs/rollout/src/recorder.rs:216-296`）：

1. **先扫描文件系统**：以 2x page_size 过度获取（overfetch），遍历 `~/.codex/sessions/` 下的日期目录结构或平铺目录
2. **修复 SQLite**：对每个文件系统结果调用 `read_repair_rollout_path` 确保 SQLite 索引与磁盘一致
3. **查询 SQLite**：使用 `list_threads_db` 从 SQLite 获取最终结果页（支持搜索、过滤、cursor 分页）
4. **降级回退**：如果 SQLite 不可用或查询失败，直接返回文件系统结果

### 3. 文件系统目录遍历

会话文件存储在嵌套的日期目录中（`YYYY/MM/DD/`），遍历策略取决于排序键：

- **按创建时间排序** (`ThreadSortKey::CreatedAt`)：利用目录和文件名的字典序反向遍历（年→月→日），直接从文件名解析时间戳，支持 anchor 游标跳过（`codex-rs/rollout/src/list.rs:441-478`）
- **按更新时间排序** (`ThreadSortKey::UpdatedAt`)：需要先收集所有文件的 mtime，再排序后分页（`codex-rs/rollout/src/list.rs:488-546`）

两种策略都有 `MAX_SCAN_FILES = 10000` 的硬上限防止扫描过多文件。

### 4. SQLite 回填流程

当首次启用 SQLite 时，`backfill_sessions` 异步扫描所有现存 rollout 文件并导入元数据（`codex-rs/rollout/src/metadata.rs:136-355`）：

1. 通过 `try_claim_backfill` 获取分布式租约（防止多进程并发回填）
2. 收集 `sessions/` 和 `archived_sessions/` 下的所有 rollout 文件
3. 按 watermark 排序，从上次 checkpoint 断点继续
4. 分批处理（每批 200 个），为每个文件提取元数据并 upsert 到 SQLite
5. 每批完成后调用 `checkpoint_backfill` 记录进度
6. 完成后标记 `BackfillStatus::Complete`

### 5. 会话恢复流程

`RolloutRecorder::load_rollout_items()` 读取整个 JSONL 文件，逐行解析为 `RolloutItem`，提取 thread ID，返回完整的事件历史供会话恢复（`codex-rs/rollout/src/recorder.rs:531-594`）。`get_rollout_history()` 在此基础上封装为 `InitialHistory::Resumed` 供 Core 使用。

## 函数签名与参数说明

### `RolloutRecorder`

核心会话记录器，通过内部 mpsc channel 异步写入 JSONL 文件。

```rust
pub async fn new(
    config: &impl RolloutConfigView,
    params: RolloutRecorderParams,
    state_db_ctx: Option<StateDbHandle>,
    state_builder: Option<ThreadMetadataBuilder>,
) -> std::io::Result<Self>
```

- **config**：提供 `codex_home`、`cwd`、`model_provider_id` 等路径和配置
- **params**：`Create`（新建会话）或 `Resume`（恢复已有会话）
- **state_db_ctx**：可选的 SQLite 运行时句柄
- **state_builder**：可选的元数据构建器，用于增量更新 SQLite

> 源码位置：`codex-rs/rollout/src/recorder.rs:370-475`

```rust
pub async fn record_items(&self, items: &[RolloutItem]) -> std::io::Result<()>
```

经过持久化策略过滤后发送事件到写入通道。

```rust
pub async fn persist(&self) -> std::io::Result<()>
```

首次调用时物化 rollout 文件（创建目录、文件、写入 session meta），后续调用为 no-op。

```rust
pub async fn load_rollout_items(path: &Path) -> std::io::Result<(Vec<RolloutItem>, Option<ThreadId>, usize)>
```

从磁盘加载完整 rollout 内容。返回 `(事件列表, 会话ID, 解析错误数)`。

### `RolloutRecorderParams`

```rust
pub enum RolloutRecorderParams {
    Create {
        conversation_id: ThreadId,
        forked_from_id: Option<ThreadId>,
        source: SessionSource,
        base_instructions: BaseInstructions,
        dynamic_tools: Vec<DynamicToolSpec>,
        event_persistence_mode: EventPersistenceMode,
    },
    Resume {
        path: PathBuf,
        event_persistence_mode: EventPersistenceMode,
    },
}
```

> 源码位置：`codex-rs/rollout/src/recorder.rs:79-92`

### 状态数据库初始化

```rust
pub async fn init(config: &impl RolloutConfigView) -> Option<StateDbHandle>
```

初始化 SQLite 运行时。如果回填未完成，会在后台 spawn 回填任务。

> 源码位置：`codex-rs/rollout/src/state_db.rs:28-63`

```rust
pub async fn get_state_db(config: &impl RolloutConfigView) -> Option<StateDbHandle>
```

仅在 SQLite 文件已存在且回填完成时返回句柄，否则返回 `None`。

> 源码位置：`codex-rs/rollout/src/state_db.rs:66-78`

### 会话列表

```rust
pub async fn list_threads(
    config: &impl RolloutConfigView,
    page_size: usize,
    cursor: Option<&Cursor>,
    sort_key: ThreadSortKey,
    allowed_sources: &[SessionSource],
    model_providers: Option<&[String]>,
    default_provider: &str,
    search_term: Option<&str>,
) -> std::io::Result<ThreadsPage>
```

列出活跃会话，支持分页、排序、来源过滤、搜索词过滤。

```rust
pub async fn list_archived_threads(/* 同上参数 */) -> std::io::Result<ThreadsPage>
```

列出已归档会话。

### 会话名称索引

```rust
pub async fn append_thread_name(codex_home: &Path, thread_id: ThreadId, name: &str) -> std::io::Result<()>
```

向 `session_index.jsonl` 追加名称映射条目。

> 源码位置：`codex-rs/rollout/src/session_index.rs:28-45`

```rust
pub async fn find_thread_name_by_id(codex_home: &Path, thread_id: &ThreadId) -> std::io::Result<Option<String>>
```

通过**从尾部向前扫描**找到某会话的最新名称（利用 append-only 特性，最后一条同 ID 记录即为最新）。

> 源码位置：`codex-rs/rollout/src/session_index.rs:67-80`

```rust
pub async fn find_thread_path_by_name_str(codex_home: &Path, name: &str) -> std::io::Result<Option<PathBuf>>
```

按名称查找会话，先通过名称索引查 ID，再查找 rollout 文件路径。

## 接口/类型定义

### `RolloutConfigView` trait

```rust
pub trait RolloutConfigView {
    fn codex_home(&self) -> &Path;
    fn sqlite_home(&self) -> &Path;
    fn cwd(&self) -> &Path;
    fn model_provider_id(&self) -> &str;
    fn generate_memories(&self) -> bool;
}
```

定义了 Rollout 模块所需的配置接口。为 `&T`、`Arc<T>` 提供了 blanket impl，使用灵活。

> 源码位置：`codex-rs/rollout/src/config.rs:5-11`

### `RolloutConfig`

| 字段 | 类型 | 说明 |
|------|------|------|
| `codex_home` | `PathBuf` | Codex 主目录（如 `~/.codex`） |
| `sqlite_home` | `PathBuf` | SQLite 数据库存储目录 |
| `cwd` | `PathBuf` | 当前工作目录 |
| `model_provider_id` | `String` | 模型提供者标识 |
| `generate_memories` | `bool` | 是否生成记忆 |

> 源码位置：`codex-rs/rollout/src/config.rs:13-20`

### `EventPersistenceMode`

```rust
pub enum EventPersistenceMode {
    Limited,   // 默认，仅持久化核心事件
    Extended,  // 额外持久化执行结果、Guardian 评估等详细事件
}
```

> 源码位置：`codex-rs/rollout/src/policy.rs:6-10`

### `ThreadsPage`

```rust
pub struct ThreadsPage {
    pub items: Vec<ThreadItem>,          // 会话摘要，按时间倒序
    pub next_cursor: Option<Cursor>,     // 下一页游标
    pub num_scanned_files: usize,        // 本次扫描的文件总数
    pub reached_scan_cap: bool,          // 是否触及扫描上限
}
```

> 源码位置：`codex-rs/rollout/src/list.rs:31-41`

### `ThreadItem`

会话摘要信息，包含路径、ID、首条用户消息、cwd、git 信息、来源、模型提供者、时间戳等字段。

> 源码位置：`codex-rs/rollout/src/list.rs:44-76`

### `Cursor`

分页游标，由 `OffsetDateTime` + `Uuid` 组成，序列化为 `"<rfc3339_ts>|<uuid>"` 格式。游标机制确保即使有新会话写入，分页也保持稳定。

> 源码位置：`codex-rs/rollout/src/list.rs:129-133`

### `SessionIndexEntry`

```rust
pub struct SessionIndexEntry {
    pub id: ThreadId,
    pub thread_name: String,
    pub updated_at: String,
}
```

> 源码位置：`codex-rs/rollout/src/session_index.rs:19-24`

### `StateDbHandle`

```rust
pub type StateDbHandle = Arc<codex_state::StateRuntime>;
```

SQLite 状态运行时的共享引用句柄。

> 源码位置：`codex-rs/rollout/src/state_db.rs:25`

## 配置项与默认值

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `SESSIONS_SUBDIR` | 活跃会话存储子目录 | `"sessions"` |
| `ARCHIVED_SESSIONS_SUBDIR` | 归档会话存储子目录 | `"archived_sessions"` |
| `MAX_SCAN_FILES` | 单次列表请求的最大文件扫描数 | `10000` |
| `HEAD_RECORD_LIMIT` | 读取 rollout 头部的最大记录数（用于摘要提取） | `10` |
| `USER_EVENT_SCAN_LIMIT` | 在找到 session meta 后继续扫描用户消息的额外行数上限 | `200` |
| `PERSISTED_EXEC_AGGREGATED_OUTPUT_MAX_BYTES` | Extended 模式下命令输出的持久化字节上限 | `10000` |
| `BACKFILL_BATCH_SIZE` | 回填每批处理的 rollout 文件数 | `200` |
| `BACKFILL_LEASE_SECONDS` | 回填分布式租约时长（秒） | `900`（测试下为 `1`） |
| `INTERACTIVE_SESSION_SOURCES` | 交互式会话的来源列表 | `[Cli, VSCode, Custom("atlas"), Custom("chatgpt")]` |

## 事件持久化策略详解

`policy.rs` 定义了两级过滤策略，决定哪些事件会写入 rollout 文件：

**Limited 模式**（默认）——持久化核心对话事件：
- `UserMessage`、`AgentMessage`、`AgentReasoning` 等对话类事件
- `TokenCount`、`ContextCompacted` 等状态变更事件
- `TurnStarted`、`TurnComplete`、`TurnAborted` 等生命周期事件
- `ImageGenerationEnd`

**Extended 模式**——在 Limited 基础上额外持久化：
- `ExecCommandEnd`（命令执行输出，截断到 10KB）
- `PatchApplyEnd`、`McpToolCallEnd` 等工具执行结果
- `GuardianAssessment`、`Error` 等诊断事件
- 协作 agent 相关事件

**永不持久化的事件**：流式 delta 事件（`AgentMessageDelta`）、Begin 类事件、UI 交互事件、临时警告等。

> 源码位置：`codex-rs/rollout/src/policy.rs:93-183`

特别值得注意的是，`ResponseItem` 有独立的过滤规则（`should_persist_response_item`），大部分都会被持久化，仅 `ResponseItem::Other` 被排除。同时还有一个 `should_persist_response_item_for_memories` 变体用于记忆系统，会排除 developer 角色消息和推理内容。

## 会话名称索引机制

`session_index.rs` 实现了一个轻量的 append-only JSONL 文件（`session_index.jsonl`），用于建立 `ThreadId ↔ 人类可读名称` 的双向映射。

关键设计：
- **Append-only**：每次更新名称只追加新行，最新一条同 ID 的记录胜出
- **反向扫描**：`find_thread_name_by_id` 和 `find_thread_id_by_name` 都从文件尾部开始扫描（`scan_index_from_end`），以 8KB 块读取并反向解析行，确保快速找到最新匹配（`codex-rs/rollout/src/session_index.rs:163-198`）
- **批量查询**：`find_thread_names_by_ids` 正向扫描全文件，为一批 ID 查找名称

## 边界 Case 与注意事项

- **延迟文件创建**：`RolloutRecorder` 新建会话时不会立即创建文件，直到 `persist()` 被调用。这意味着只预计算路径但未开始用户交互的会话不会留下空文件。
- **SQLite 回填保护**：`get_state_db` 和 `list_threads_db` 都会检查回填是否完成（`BackfillStatus::Complete`），未完成时返回 `None` 从而回退到文件系统查询。回填使用分布式租约防止并发。
- **Stale 路径自清理**：`list_threads_db` 返回结果时会验证每个 `rollout_path` 是否仍然存在于磁盘。如果发现 stale 路径，会从 SQLite 删除该记录并跳过（`codex-rs/rollout/src/state_db.rs:246-260`）。
- **Read-repair 机制**：当通过文件系统找到了 SQLite 中缺失或不一致的记录时，会自动修复 SQLite 索引（`read_repair_rollout_path`），分为快速路径（更新现有行）和慢速路径（从 rollout 内容重建元数据）。
- **时间戳精度**：所有时间戳截断到秒精度（`with_nanosecond(0)`），确保文件名时间戳、游标比较和 SQLite 时间戳对齐。
- **命令输出截断**：Extended 模式下 `ExecCommandEnd` 事件的 `aggregated_output` 被截断到 10KB（`truncate_middle_chars`），同时清空 `stdout`/`stderr`/`formatted_output` 避免 rollout 文件膨胀。
- **cwd 标准化**：所有写入 SQLite 的 `cwd` 路径都经过 `normalize_cwd_for_state_db` 处理（调用 `normalize_for_path_comparison`），确保路径比较的一致性。
- **Git 信息保留**：回填和 reconcile 时调用 `prefer_existing_git_info`，优先保留已有的 git 信息（如 branch、sha），因为 rollout 文件中的 git 信息可能不如首次记录时准确。