# ThreadLifecycle — 线程生命周期管理

## 概述与职责

`ThreadLifecycle` 是 `CodexMessageProcessor`（位于 `codex-rs/app-server/src/codex_message_processor.rs`）中负责 **线程（Thread）完整生命周期** 的核心逻辑集合。它实现了线程从创建到销毁的所有 JSON-RPC 操作，包括启动、恢复、分叉、归档/取消归档、读取、列表查询、退订/关闭，以及紧凑化、回滚、命名、元数据更新等辅助操作。

在整体架构中，该模块隶属于 **AppServer → RequestProcessing → CodexMessageProcessor**。`CodexMessageProcessor` 是所有 Codex 特有 RPC 方法的实现体（约 9600 行），`ThreadLifecycle` 覆盖其中与线程管理相关的大部分方法。同层的兄弟模块 `BespokeEventHandling` 处理事件翻译，`ThreadStateManagement` 跟踪每个线程的运行时状态。

## 核心数据结构

### `CodexMessageProcessor`

线程生命周期操作的宿主结构体，持有所有必要的协作者：

| 字段 | 类型 | 用途 |
|------|------|------|
| `thread_manager` | `Arc<ThreadManager>` | 核心层的线程管理器，负责实际的线程创建/恢复/销毁 |
| `thread_state_manager` | `ThreadStateManager` | 管理每个线程的订阅关系、中断队列、活跃 turn 等状态 |
| `thread_watch_manager` | `ThreadWatchManager` | 追踪线程运行状态（Idle/Active/Error），发出状态变更通知 |
| `outgoing` | `Arc<OutgoingMessageSender>` | 向已连接客户端发送 JSON-RPC 响应和通知 |
| `config` | `Arc<Config>` | 全局配置（codex_home、model_provider 等） |
| `pending_thread_unloads` | `Arc<Mutex<HashSet<ThreadId>>>` | 正在卸载中的线程集合，防止恢复正在关闭的线程 |
| `background_tasks` | `TaskTracker` | 追踪后台异步任务（如 `thread_start_task`） |

> 源码位置：`codex_message_processor.rs:407-427`

### `ListenerTaskContext`

传递给后台线程监听任务的上下文，包含 `thread_manager`、`outgoing`、`thread_watch_manager` 等的克隆引用。设计为 `Clone`，可在 `tokio::spawn` 的 `async move` 块中使用。

> 源码位置：`codex_message_processor.rs:438-447`

### `ThreadListFilters`

线程列表查询的过滤条件：

```rust
struct ThreadListFilters {
    model_providers: Option<Vec<String>>,
    source_kinds: Option<Vec<ThreadSourceKind>>,
    archived: bool,
    cwd: Option<PathBuf>,
    search_term: Option<String>,
}
```

> 源码位置：`codex_message_processor.rs:341-347`

## 关键流程

### 1. thread_start — 创建新线程

这是线程生命周期的起点，处理 `thread/start` RPC 请求。

**流程 Walkthrough**：

1. **解构请求参数**：从 `ThreadStartParams` 中提取 model、cwd、approval_policy、sandbox 等所有配置覆盖项（`codex_message_processor.rs:2062-2080`）
2. **构建 ConfigOverrides**：调用 `build_thread_config_overrides()` 将协议层参数转为核心层的 `ConfigOverrides`（`codex_message_processor.rs:2081-2093`）
3. **准备监听任务上下文**：创建 `ListenerTaskContext` 并采集 cloud_requirements、cli_overrides 等运行时配置（`codex_message_processor.rs:2096-2107`）
4. **派生异步任务**：将实际工作交给 `thread_start_task()`，通过 `background_tasks.spawn()` 在后台执行（`codex_message_processor.rs:2108-2127`）

`thread_start_task()` 内部步骤：

5. **派生 Config**：调用 `derive_config_from_params()` 合并 CLI 覆盖、请求覆盖和 cloud requirements，生成完整的 `Config`（`codex_message_processor.rs:2197-2216`）
6. **信任检查与自动信任**：如果请求的 cwd 尚未被信任但 sandbox 模式允许写入，自动将项目标记为 `Trusted` 并重新派生 Config（`codex_message_processor.rs:2218-2280`）
7. **验证动态工具**：对传入的 `dynamic_tools` 调用 `validate_dynamic_tools()` 检查 input_schema 合法性（`codex_message_processor.rs:2282-2307`）
8. **调用核心层创建线程**：通过 `thread_manager.start_thread_with_tools_and_service_name()` 创建底层 `CodexThread`，获得 `NewThread { thread_id, thread, session_configured }`（`codex_message_processor.rs:2310-2333`）
9. **构建 Thread 协议对象**：从 `config_snapshot` 调用 `build_thread_from_snapshot()` 构建面向客户端的 `Thread` 结构体（`codex_message_processor.rs:2341-2345`）
10. **自动附加监听器**：调用 `ensure_conversation_listener_task()` 为发起请求的连接订阅该线程的事件流（`codex_message_processor.rs:2348-2365`）
11. **注册到状态监控**：通过 `thread_watch_manager.upsert_thread_silently()` 注册线程，并解析初始 `ThreadStatus`（`codex_message_processor.rs:2367-2386`）
12. **发送响应和通知**：先发送 `ThreadStartResponse` 给请求者，再广播 `ThreadStartedNotification` 给所有连接（`codex_message_processor.rs:2388-2428`）

### 2. thread_resume — 恢复已有线程

处理 `thread/resume` RPC 请求，支持三种恢复来源：已运行线程、rollout 文件、或传入的 history。

**流程 Walkthrough**：

1. **防并发检查**：如果目标线程在 `pending_thread_unloads` 中（正在关闭），立即报错（`codex_message_processor.rs:3710-3725`）
2. **尝试恢复运行中线程**：调用 `resume_running_thread()` 检查线程是否已在内存中运行（`codex_message_processor.rs:3727-3732`）
   - 如果已运行，**不会创建新线程**，而是通过 `ThreadListenerCommand::SendThreadResumeResponse` 将恢复请求排入监听器任务队列，在事件循环中构建最新的 turn 历史后响应（`codex_message_processor.rs:4085-4103`）
   - 会检测参数不匹配（model、cwd、sandbox 等），记录 warning 但仍成功恢复（`codex_message_processor.rs:4045-4051`）
3. **从 history 或 rollout 加载**：
   - `resume_thread_from_history()`：将传入的 `ResponseItem[]` 包装为 `InitialHistory::Forked`（`codex_message_processor.rs:4108-4125`）
   - `resume_thread_from_rollout()`：通过 `find_thread_path_by_id_str()` 定位 rollout 文件，调用 `RolloutRecorder::get_rollout_history()` 加载（`codex_message_processor.rs:4127-4186`）
4. **应用持久化元数据**：调用 `load_and_apply_persisted_resume_metadata()` 从 state DB 加载之前保存的 model/reasoning_effort，通过 `merge_persisted_resume_metadata()` 合并到覆盖项中（`codex_message_processor.rs:3783-3789`）
5. **派生 Config 并创建核心线程**：通过 `derive_config_for_cwd()` 生成 Config，调用 `thread_manager.resume_thread_with_history()` 恢复线程（`codex_message_processor.rs:3795-3827`）
6. **构建响应**：通过 `load_thread_from_resume_source_or_send_internal()` 根据恢复来源（Resumed/Forked）构建包含完整 turns 的 `Thread` 对象（`codex_message_processor.rs:4188-4234`）

### 3. thread_fork — 分叉线程

基于快照创建新的分支线程，支持持久化和临时（ephemeral）两种模式。

**流程 Walkthrough**：

1. **定位源 rollout**：通过 `path` 参数直接指定，或通过 `thread_id` 查找 rollout 文件（`codex_message_processor.rs:4265-4304`）
2. **派生 Config**：与 `thread_start` 类似，合并 CLI 和请求覆盖项（`codex_message_processor.rs:4332-4367`）
3. **调用核心层 fork**：通过 `thread_manager.fork_thread()` 并传入 `ForkSnapshot::Interrupted` 创建分叉（`codex_message_processor.rs:4371-4410`）
4. **区分持久化与临时分叉**：
   - **持久化分叉**：从新 rollout 文件读取 summary，设置 `forked_from_id`（`codex_message_processor.rs:4428-4452`）
   - **临时分叉**：从源 rollout 读取 history items 重建可视历史，不产生新的 rollout 文件（`codex_message_processor.rs:4453-4493`）
5. **自动附加监听器**、注册到 watch manager、发送 `ThreadStartedNotification`（`codex_message_processor.rs:4412-4544`）

### 4. thread_archive / thread_unarchive — 归档与取消归档

**归档流程**（`archive_thread_common()`，`codex_message_processor.rs:5476-5588`）：

1. 验证 rollout 路径位于 sessions 目录下，文件名包含线程 ID
2. 如果线程活跃，先 `remove_thread()` 并 `wait_for_thread_shutdown()`（10 秒超时）
3. 调用 `finalize_thread_teardown()` 清理所有订阅和状态
4. 将 rollout 文件从 `sessions/` 移动到 `archived_sessions/`
5. 更新 state DB 的归档标记

**取消归档流程**（`thread_unarchive()`，`codex_message_processor.rs:2985-3172`）：

1. 从 `archived_sessions/` 目录定位归档文件
2. 根据文件名中的日期戳重建 `sessions/YYYY/MM/DD/` 目录结构并移回
3. 更新文件修改时间为当前时间（便于按时间排序）
4. 更新 state DB 的归档标记

### 5. thread_read — 读取线程详情

支持按 `thread_id` 读取线程元数据，可选包含完整的 turns 历史。

**流程 Walkthrough**（`codex_message_processor.rs:3503-3655`）：

1. **优先从 state DB 读取摘要**：检查已加载线程和全局 state DB（`codex_message_processor.rs:3518-3524`）
2. **定位 rollout 路径**：按需从文件系统查找（`codex_message_processor.rs:3526-3548`）
3. **构建 Thread 对象**：
   - 有 DB 摘要：调用 `summary_to_thread()`
   - 有 rollout：调用 `read_summary_from_rollout()`
   - 仅有内存线程：调用 `build_thread_from_snapshot()`
4. **加载 turns**（当 `include_turns=true`）：调用 `read_rollout_items_from_rollout()` 再通过 `build_turns_from_rollout_items()` 转为协议层的 `Turn` 列表（`codex_message_processor.rs:3608-3635`）
5. **修正状态**：调用 `set_thread_status_and_interrupt_stale_turns()` 将无活跃 turn 的 InProgress turn 标记为 Interrupted（`codex_message_processor.rs:3648-3652`）

### 6. thread_list / thread_loaded_list — 列表查询

**thread_list**（`codex_message_processor.rs:3356-3442`）：

- 支持 cursor 分页（默认 25 条，最大 100 条）
- 支持按 `createdAt` 或 `updatedAt` 排序
- 支持按 model_provider、source_kind、archived、cwd、search_term 过滤
- 内部调用 `list_threads_common()` 循环分页直到收集足够数据（`codex_message_processor.rs:4613-4748`）
- 批量查询线程名称和运行状态后合并到响应中

**thread_loaded_list**（`codex_message_processor.rs:3444-3501`）：

- 仅列出当前内存中已加载的线程 ID
- 排序后按 cursor + limit 做简单的 binary search 分页

### 7. thread_unsubscribe — 退订与优雅关闭

`codex_message_processor.rs:5365-5474`

1. 从 `thread_state_manager` 中移除连接对线程的订阅
2. 如果该连接是最后一个订阅者：
   - 记录 `pending_thread_unloads` 防止并发恢复
   - 取消该线程上所有待处理的服务端请求
   - 清理 thread state
   - 在后台任务中执行 `wait_for_thread_shutdown()`（10 秒超时）
   - 成功后从 `thread_manager` 移除线程并发送 `ThreadClosedNotification`

### 8. 辅助操作

#### thread_set_name（`codex_message_processor.rs:2611-2685`）
- 如果线程已加载，通过 `Op::SetThreadName` 提交到核心
- 如果未加载，调用 `codex_core::append_thread_name()` 直接写入文件系统
- 成功后广播 `ThreadNameUpdatedNotification`

#### thread_metadata_update（`codex_message_processor.rs:2687-2851`）
- 更新线程的 git 信息（sha、branch、origin_url），支持 nullable 字段
- 通过 `ensure_thread_metadata_row_exists()` 确保 state DB 中存在元数据行（不存在时触发 `reconcile_rollout()` 或手动创建）
- 最终通过 `state_db_ctx.update_thread_git_info()` 持久化

#### thread_compact_start（`codex_message_processor.rs:3239-3268`）
- 提交 `Op::Compact` 到核心层，触发上下文压缩

#### thread_rollback（`codex_message_processor.rs:3174-3237`）
- 防并发：在 thread state 中记录 `pending_rollbacks`
- 提交 `Op::ThreadRollback { num_turns }` 到核心层

#### thread_shell_command（`codex_message_processor.rs:3304-3354`）
- 验证命令非空后提交 `Op::RunUserShellCommand`

#### thread_background_terminals_clean（`codex_message_processor.rs:3270-3302`）
- 提交 `Op::CleanBackgroundTerminals` 清理后台终端

#### thread_increment/decrement_elicitation（`codex_message_processor.rs:2538-2609`）
- 调用核心线程的 `increment_out_of_band_elicitation_count()` / `decrement_out_of_band_elicitation_count()` 管理暂停计数器

## 函数签名

### 主要线程操作

#### `thread_start(&self, request_id, params, request_context)`
创建新线程。将实际工作委托给 `thread_start_task()` 后台任务。

#### `thread_resume(&mut self, request_id, params)`
恢复已有线程。自动识别三种来源：运行中线程、rollout 文件、传入 history。

#### `thread_fork(&mut self, request_id, params)`
基于快照分叉线程，支持 ephemeral 模式。

#### `thread_archive(&mut self, request_id, params)` / `thread_unarchive(&mut self, request_id, params)`
归档/取消归档线程，涉及文件移动和 state DB 更新。

#### `thread_read(&mut self, request_id, params)`
读取线程详情，可选包含完整 turns。

#### `thread_list(&self, request_id, params)` / `thread_loaded_list(&self, request_id, params)`
分页列出所有线程或仅已加载线程。

#### `thread_unsubscribe(&mut self, request_id, params)`
退订线程事件，最后一个订阅者退出时触发线程关闭。

### 关键辅助函数

#### `build_thread_config_overrides(&self, model, model_provider, ...) -> ConfigOverrides`
将协议层参数映射为核心层的 `ConfigOverrides` 结构。
> `codex_message_processor.rs:2445-2475`

#### `build_thread_from_snapshot(thread_id, config_snapshot, path) -> Thread`
从 `ThreadConfigSnapshot` 构建面向客户端的 `Thread` 协议对象，填充 id、model_provider、cwd、source 等字段。
> `codex_message_processor.rs:8849-8874`

#### `derive_config_from_params(cli_overrides, request_overrides, typesafe_overrides, ...) -> io::Result<Config>`
合并 CLI 覆盖、请求覆盖和 cloud requirements，通过 `ConfigBuilder` 生成完整的 `Config`。
> `codex_message_processor.rs:8363-8391`

#### `collect_resume_override_mismatches(request, config_snapshot) -> Vec<String>`
比较恢复请求中的覆盖参数与运行中线程的实际配置，返回所有不匹配项的描述。用于恢复运行中线程时记录 warning。
> `codex_message_processor.rs:7999-8109`

#### `merge_persisted_resume_metadata(request_overrides, typesafe_overrides, persisted_metadata)`
将 state DB 中持久化的 model 和 reasoning_effort 合并到恢复请求的覆盖项中，但如果用户已显式指定了 model/provider 则跳过。
> `codex_message_processor.rs:8111-8128`

#### `summary_to_thread(summary) -> Thread`
将 `ConversationSummary`（从 rollout 或 state DB 读取）转为协议层的 `Thread` 对象。
> `codex_message_processor.rs:8876-8917`

#### `read_summary_from_rollout(path, fallback_provider) -> io::Result<ConversationSummary>`
从 rollout JSONL 文件的头部读取 session metadata，提取 preview（第一条用户消息）、时间戳、git 信息等。
> `codex_message_processor.rs:8599-8671`

#### `set_thread_status_and_interrupt_stale_turns(thread, loaded_status, has_live_in_progress_turn)`
根据 `ThreadWatchManager` 的状态和是否有活跃 turn，设置线程的最终 `ThreadStatus`。如果线程不是 Active 状态，将所有 InProgress 的 turn 标记为 Interrupted。
> `codex_message_processor.rs:7983-7997`

## 监听器机制

线程的事件流通过 **listener task** 传递给客户端。每个线程最多有一个 listener 任务（一个 tokio::spawn 的循环），它：

1. 通过 `conversation.next_event()` 接收核心层事件
2. 调用 `apply_bespoke_event_handling()` 翻译为协议通知
3. 监听 `listener_command_rx` 处理恢复请求和服务端请求解析
4. 被取消（`cancel_rx`）时清理自身

> 源码位置：`codex_message_processor.rs:7276-7376`

创建、恢复、分叉线程时会自动调用 `ensure_conversation_listener_task()` 为发起请求的连接附加监听器。

## 配置派生

线程创建和恢复都需要派生 `Config`。涉及两个关键函数：

- `derive_config_from_params()`：用于 `thread_start`，基于请求参数直接派生（`codex_message_processor.rs:8363-8391`）
- `derive_config_for_cwd()`：用于 `thread_resume` 和 `thread_fork`，额外支持 `fallback_cwd`（从历史会话的 cwd 回退）（`codex_message_processor.rs:8393-8423`）

两者都通过 `ConfigBuilder` 合并 codex_home、CLI 覆盖、请求覆盖（JSON→TOML 转换）、和 cloud requirements。

## 边界 Case 与注意事项

- **恢复正在关闭的线程**：如果 `thread_id` 在 `pending_thread_unloads` 中，`thread_resume` 会立即返回错误，提示客户端等待 `ThreadClosed` 通知后重试
- **恢复运行中线程的参数不匹配**：不会创建新线程，仅记录 warning 并返回当前状态。覆盖参数（model、cwd、sandbox 等）会被静默忽略
- **临时（ephemeral）线程的限制**：不支持 `thread_metadata_update`（无 rollout 路径），`thread_read` 的 `includeTurns` 也不可用
- **归档的安全验证**：归档/取消归档时会验证 rollout 文件路径必须在 `sessions/` 或 `archived_sessions/` 目录下，且文件名必须包含对应的线程 ID，防止路径遍历攻击
- **并发回滚保护**：`thread_rollback` 通过 `pending_rollbacks` 确保同一线程不会并发执行多个回滚
- **listener 代际管理**：每次设置新 listener 会生成递增的 `listener_generation`，确保旧 listener 任务退出时不会误清理新 listener 的状态
- **关闭超时**：`wait_for_thread_shutdown()` 和 `shutdown_threads()` 都使用 10 秒超时，超时后记录 warning 但仍继续执行后续操作
- **State DB 元数据延迟创建**：`ensure_thread_metadata_row_exists()` 在需要时通过 `reconcile_rollout()` 或手动构建来补齐 state DB 中缺失的行