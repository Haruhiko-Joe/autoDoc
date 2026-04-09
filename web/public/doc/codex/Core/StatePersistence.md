# 状态持久化（StatePersistence）

## 概述与职责

`codex-state` 是 Codex Core 引擎中负责**持久化会话元数据**的 crate。它以 SQLite 为后端存储，管理所有与会话（thread）相关的结构化状态，是会话引擎的数据基础设施层。

在整体架构中，`codex-state` 位于 **Core** 模块内部，由核心会话引擎通过 `state_db_bridge.rs` 桥接调用。它与 Core 的其他兄弟模块（ModelProviders、ToolSystem、Sandbox 等）平行，但为 Core 提供纯粹的数据持久化能力，不涉及任何业务逻辑。上层的 TUI、CLI、AppServer 均通过 Core 间接使用此模块的服务。

该模块的核心职责包括：

- **Rollout 元数据提取**：从 JSONL rollout 文件中解析会话元数据并写入 SQLite
- **线程元数据管理**：CRUD 操作 thread 的标题、时间戳、状态、Git 信息等
- **Agent Job 跟踪**：管理批量 agent 作业及其子项的完整生命周期
- **Backfill 编排**：通过租约机制协调历史会话的索引回填
- **日志数据库**：独立的 SQLite 数据库，接收结构化的 tracing 日志并提供查询接口
- **Memory Pipeline 支持**：stage-1 记忆提取和 phase-2 全局合并的持久化状态

## 关键流程

### 1. 运行时初始化流程

`StateRuntime::init()` 是整个模块的入口点（`codex-rs/state/src/runtime.rs:84-131`）：

1. 创建 `codex_home` 目录（如不存在）
2. 清理旧版本的 SQLite 数据库文件（命名格式 `{base}_{version}.sqlite`）
3. 打开 state 数据库（WAL 模式、增量自动 VACUUM）并执行迁移
4. 打开独立的 logs 数据库并执行迁移——**分库设计**减少了日志写入与状态读写之间的锁竞争
5. 对 logs 数据库执行启动维护（清理过期日志）
6. 返回 `Arc<StateRuntime>` 供全局共享

```rust
// codex-rs/state/src/runtime.rs:70-76
pub struct StateRuntime {
    codex_home: PathBuf,
    default_provider: String,
    pool: Arc<sqlx::SqlitePool>,       // state DB 连接池
    logs_pool: Arc<sqlx::SqlitePool>,  // logs DB 连接池（独立）
}
```

SQLite 连接配置值得注意（`codex-rs/state/src/runtime.rs:139-147`）：
- 日志模式：WAL（Write-Ahead Logging），支持并发读写
- 同步模式：Normal（平衡性能与安全）
- 忙等待超时：5 秒
- 最大连接数：5（每个池）

### 2. Rollout 元数据提取流程

`apply_rollout_item()` 是将 JSONL rollout 行解析为结构化元数据的核心函数（`codex-rs/state/src/extract.rs:15-30`）：

1. 根据 `RolloutItem` 的变体类型分发处理：
   - `SessionMeta` → 提取 thread ID、来源、CLI 版本、CWD、Git 信息、model provider
   - `TurnContext` → 提取模型名称、推理 effort、沙盒策略、审批模式
   - `EventMsg::TokenCount` → 更新 token 使用量
   - `EventMsg::UserMessage` → 提取首条用户消息和线程标题
   - `Compacted` / `ResponseItem` → 不影响元数据
2. 如果处理后 `model_provider` 仍为空，使用默认 provider 填充

`rollout_item_affects_thread_metadata()` 用于快速判断某行是否可能修改元数据——用于增量更新场景的过滤优化（`codex-rs/state/src/extract.rs:33-41`）。

### 3. Thread 管理流程

`StateRuntime` 提供完整的线程 CRUD 操作（`codex-rs/state/src/runtime/threads.rs`）：

- **查询**：`get_thread(id)` — 按 ID 获取单个线程元数据
- **列表**：`list_threads(...)` — 支持分页（keyset pagination）、排序（按 `created_at` 或 `updated_at`）、来源过滤、provider 过滤、归档筛选、搜索
- **写入**：`upsert_thread(metadata)` — 插入或更新线程元数据
- **插入**：`insert_thread_if_absent(metadata)` — 仅在不存在时插入
- **Spawn 关系**：维护父子线程间的 spawn edge（DAG），支持递归子树查询（CTE）

分页使用 **keyset pagination** 而非 offset，保证了大数据集下的稳定性能：

```rust
// codex-rs/state/src/model/thread_metadata.rs:26-31
pub struct Anchor {
    pub ts: DateTime<Utc>,
    pub id: Uuid,
}
```

### 4. Agent Job 生命周期

Agent Job 系统跟踪批量任务的完整生命周期（`codex-rs/state/src/runtime/agent_jobs.rs`）：

1. `create_agent_job(params, items)` — 在事务中创建 Job 及其所有子项（`agent_job_items`）
2. `mark_agent_job_running(job_id)` — 标记作业开始执行
3. 对每个子项：
   - `mark_agent_job_item_running_with_thread(job_id, item_id, thread_id)` — 分配给特定线程执行
   - `report_agent_job_item_result(job_id, item_id, thread_id, result_json)` — 原子性报告结果并完成子项
   - `mark_agent_job_item_failed(job_id, item_id, error)` — 标记失败
   - `mark_agent_job_item_pending(job_id, item_id, error)` — 退回待处理（可重试）
4. `mark_agent_job_completed(job_id)` / `mark_agent_job_failed(job_id, error)` — 标记整体完成
5. `mark_agent_job_cancelled(job_id, reason)` — 取消尚未完成的作业

`report_agent_job_item_result()` 的原子性保证值得注意：它在 WHERE 子句中同时匹配 `status = 'running'` 和 `assigned_thread_id`，确保迟到的结果报告不会覆盖已失败的子项（`codex-rs/state/src/runtime/agent_jobs.rs:425-463`）。

### 5. Backfill 编排流程

Backfill 系统使用**租约机制**协调多个进程的回填工作（`codex-rs/state/src/runtime/backfill.rs`）：

1. `try_claim_backfill(lease_seconds)` — 尝试获取回填 worker 槽位。基于 `updated_at` 时间戳实现租约过期，确保单例执行
2. `mark_backfill_running()` → `checkpoint_backfill(watermark)` → `mark_backfill_complete(last_watermark)` — 状态推进
3. 使用 `last_watermark` 记录断点，支持中断后继续

状态机：`Pending` → `Running` → `Complete`。已完成的回填不可再次 claim。

### 6. 日志数据库流程

日志系统采用**生产者-消费者模式**，由两个独立组件协作（`codex-rs/state/src/log_db.rs`）：

**生产者**：`LogDbLayer` 实现 `tracing_subscriber::Layer`
- 捕获 tracing 事件，构造 `LogEntry`
- 通过 `mpsc::channel(512)` 发送到后台任务
- 支持 `flush()` 强制刷盘

**消费者**：`run_inserter()` 后台 task
- 批量插入（每 128 条或每 2 秒刷新一次）
- 插入后立即执行分区裁剪（同一事务内）

**分区裁剪策略**（`codex-rs/state/src/runtime/logs.rs:49-60`）：
- 每个 `thread_id` 保留最多 10 MiB / 1000 行日志
- 无 thread 的日志按 `process_uuid` 分区保留
- 使用窗口函数计算累计字节，删除超出预算的旧行
- 额外清理超过 10 天的过期日志

## 函数签名与参数说明

### `StateRuntime::init(codex_home: PathBuf, default_provider: String) -> Result<Arc<Self>>`

初始化状态运行时。创建目录、打开数据库、执行迁移。

- **codex_home**：Codex 主目录路径，数据库文件存放于此
- **default_provider**：默认 model provider 标识符，当 rollout 中未指定时使用

> 源码位置：`codex-rs/state/src/runtime.rs:84-131`

### `apply_rollout_item(metadata: &mut ThreadMetadata, item: &RolloutItem, default_provider: &str)`

将单行 rollout 数据应用到 `ThreadMetadata` 上，就地修改。

- **metadata**：待更新的线程元数据（可变引用）
- **item**：来自 JSONL rollout 文件的单行解析结果
- **default_provider**：当 rollout 中没有 provider 信息时的回退值

> 源码位置：`codex-rs/state/src/extract.rs:15-30`

### `StateRuntime::list_threads(...) -> Result<ThreadsPage>`

分页查询线程列表，支持丰富的过滤条件。

- **page_size**：每页条数
- **anchor**：分页锚点（keyset pagination）
- **sort_key**：`CreatedAt` 或 `UpdatedAt`
- **allowed_sources**：允许的会话来源列表
- **model_providers**：可选 provider 过滤
- **archived_only**：是否只查归档线程
- **search_term**：可选的搜索关键词

> 源码位置：`codex-rs/state/src/runtime/threads.rs:330-401`

### `StateRuntime::create_agent_job(params: &AgentJobCreateParams, items: &[AgentJobItemCreateParams]) -> Result<AgentJob>`

在单个事务中创建 agent job 及其所有子项。

> 源码位置：`codex-rs/state/src/runtime/agent_jobs.rs:5-99`

### `log_db::start(state_db: Arc<StateRuntime>) -> LogDbLayer`

启动日志收集层，返回一个可注册到 tracing subscriber 的 Layer。

> 源码位置：`codex-rs/state/src/log_db.rs:53-62`

## 接口/类型定义

### `ThreadMetadata`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `ThreadId` | 线程唯一标识符 |
| `rollout_path` | `PathBuf` | 磁盘上 rollout 文件的绝对路径 |
| `created_at` / `updated_at` | `DateTime<Utc>` | 创建/最后更新时间戳 |
| `source` | `String` | 会话来源（cli / app_server 等） |
| `agent_nickname` / `agent_role` / `agent_path` | `Option<String>` | 子 agent 相关信息 |
| `model_provider` / `model` | `String` / `Option<String>` | 模型 provider 和具体模型名 |
| `reasoning_effort` | `Option<ReasoningEffort>` | 推理强度（Low/Medium/High） |
| `cwd` | `PathBuf` | 工作目录 |
| `title` | `String` | 线程标题（从首条用户消息派生） |
| `tokens_used` | `i64` | 累计 token 使用量 |
| `archived_at` | `Option<DateTime<Utc>>` | 归档时间 |
| `git_sha` / `git_branch` / `git_origin_url` | `Option<String>` | Git 上下文 |

> 源码位置：`codex-rs/state/src/model/thread_metadata.rs:57-102`

### `AgentJobStatus` / `AgentJobItemStatus`

```
AgentJobStatus:     Pending → Running → Completed | Failed | Cancelled
AgentJobItemStatus: Pending → Running → Completed | Failed
```

`AgentJobStatus::is_final()` 在 `Completed`、`Failed`、`Cancelled` 时返回 `true`。

> 源码位置：`codex-rs/state/src/model/agent_job.rs:6-72`

### `BackfillState`

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `BackfillStatus` | `Pending` / `Running` / `Complete` |
| `last_watermark` | `Option<String>` | 最后处理到的 rollout 路径 |
| `last_success_at` | `Option<DateTime<Utc>>` | 最后成功完成时间 |

> 源码位置：`codex-rs/state/src/model/backfill_state.rs:8-16`

### `LogEntry` / `LogQuery`

`LogEntry` 用于写入日志，`LogQuery` 用于构建查询条件（支持时间范围、级别、模块、线程、全文搜索等）。

> 源码位置：`codex-rs/state/src/model/log.rs:1-46`

### `DirectionalThreadSpawnEdgeStatus`

线程 spawn 关系的状态枚举：`Open`（活跃）或 `Closed`（已结束）。

> 源码位置：`codex-rs/state/src/model/graph.rs:1-11`

## 配置项与默认值

| 配置 | 说明 | 默认值 |
|------|------|--------|
| `CODEX_SQLITE_HOME` 环境变量 | 覆盖 SQLite 数据库存放目录 | 无（使用 codex_home） |
| `STATE_DB_VERSION` | state 数据库版本号 | `5` |
| `LOGS_DB_VERSION` | logs 数据库版本号 | `2` |
| `LOG_PARTITION_SIZE_LIMIT_BYTES` | 每分区日志保留上限 | 10 MiB |
| `LOG_PARTITION_ROW_LIMIT` | 每分区日志行数上限 | 1,000 |
| `LOG_RETENTION_DAYS` | 日志保留天数 | 10 |
| `LOG_QUEUE_CAPACITY` | 日志写入 channel 容量 | 512 |
| `LOG_BATCH_SIZE` | 日志批量插入大小 | 128 |
| `LOG_FLUSH_INTERVAL` | 日志自动刷新间隔 | 2 秒 |

## 数据库迁移

State 数据库包含 23 个迁移脚本（`codex-rs/state/migrations/`），涵盖：
- `0001_threads.sql` — 基础线程表
- `0002_logs.sql` → `0023_drop_logs.sql` — 日志从 state DB 迁移到独立 logs DB
- `0004_thread_dynamic_tools.sql` — 线程关联的动态工具
- `0006_memories.sql` — 记忆系统表
- `0008_backfill_state.sql` — 回填状态表
- `0014_agent_jobs.sql` — Agent Job 系统
- `0021_thread_spawn_edges.sql` — 父子线程关系图

Logs 数据库有独立的迁移目录（`codex-rs/state/logs_migrations/`），包含 2 个迁移。

迁移通过 `sqlx::migrate!` 宏在编译时嵌入（`codex-rs/state/src/migrations.rs:1-4`）。

## 辅助工具

`codex-state-logs` 是一个独立的 CLI 二进制（`codex-rs/state/src/bin/logs_client.rs`），用于从日志数据库中尾部跟踪（tail）日志。支持按级别、时间范围、模块路径、线程 ID、全文搜索等条件过滤，并以着色格式输出（包含 apply_patch 的 diff 高亮）。

## Core 桥接层

`codex-rs/core/src/state_db_bridge.rs` 是 `codex-core` 调用 `codex-state` 的薄桥接层。它重导出 `StateRuntime` 的关键方法（如 `apply_rollout_items`、`list_threads_db`、`get_dynamic_tools` 等），并提供 `get_state_db(config)` 作为 Core 内部获取数据库句柄的统一入口。

## 边界 Case 与注意事项

- **CWD 优先级**：`SessionMeta` 设置的 `cwd` 优先于 `TurnContext` 中的 `cwd`。只有当 `SessionMeta` 未设置时，`TurnContext` 才会填充 `cwd`（`codex-rs/state/src/extract.rs:70-78`）
- **标题来源限制**：线程标题仅从 `EventMsg::UserMessage` 派生，`ResponseItem` 中的 user role 消息不会设置标题（`codex-rs/state/src/extract.rs:102-104`）
- **遗留数据库清理**：`init()` 时自动删除旧版本的 `.sqlite` / `-wal` / `-shm` / `-journal` 文件，但不会删除不符合命名模式的无关文件
- **日志裁剪同事务**：日志插入和裁剪在同一事务内完成，调用者不会看到"已插入但未裁剪"的中间状态
- **Backfill 租约**：基于 `updated_at` 时间戳的简单租约，不使用分布式锁。过期租约可被新 worker 接管
- **Agent Job 子项报告的原子性**：`report_agent_job_item_result()` 在 WHERE 中同时检查 `status` 和 `assigned_thread_id`，迟到的报告会被静默拒绝
- **数据库版本升级**：通过文件名中的版本号区分不同 schema 版本，不兼容时创建新文件而非迁移旧文件